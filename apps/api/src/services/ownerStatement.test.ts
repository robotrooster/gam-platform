/**
 * S644 — the owner statement, against a real database.
 *
 * These numbers go to somebody who is not a GAM customer, does not log into
 * anything most months, and will compare the total to what hit their bank. So
 * the tests are about agreement with the money record, not about arithmetic:
 * that voided bills stay off, that another owner's park never appears, that
 * money still in flight is not reported as paid, and that a manager's cut is
 * shown rather than quietly absorbed.
 */
import { randomUUID } from 'crypto'
import { describe, it, expect, beforeEach } from 'vitest'
import { getClient } from '../db'
import { ownerStatement, monthStart } from './ownerStatement'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedUserBankAccount,
  seedPmCompany, seedPmFeePlan,
} from '../test/dbHelpers'

beforeEach(cleanupAllSchema)

const M = '2026-08-01'

interface Owner { landlordId: string; userId: string; propertyId: string; unitId: string }

async function seedOwnerWithProperty(client: any, pmCompanyId?: string): Promise<Owner> {
  const { userId, landlordId } = await seedLandlord(client)
  const propertyId = await seedProperty(client, {
    landlordId, ownerUserId: userId, managedByUserId: userId })
  if (pmCompanyId) {
    await client.query(`UPDATE properties SET pm_company_id=$2 WHERE id=$1`,
      [propertyId, pmCompanyId])
  }
  const unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: 1000 })
  return { landlordId, userId, propertyId, unitId }
}

/** The record of money that actually moved, which is what a statement reads. */
async function allocate(client: any, o: Owner, type: string, amount: number) {
  await client.query(
    `INSERT INTO user_balance_ledger (user_id, type, amount, balance_after, property_id, created_at)
     VALUES ($1,$2,$3,0,$4,$5::date + INTERVAL '9 days')`,
    [o.userId, type, amount.toFixed(2), o.propertyId, M])
}

async function settledRent(
  client: any, o: Owner, amount: number, status = 'settled', unitId?: string,
) {
  await client.query(
    `INSERT INTO payments (unit_id, landlord_id, type, amount, status, due_date, entry_description, settled_at)
     VALUES ($1,$2,'rent',$3,$4,$5::date,'RENT',
             CASE WHEN $4 = 'settled' THEN $5::date + INTERVAL '9 days' ELSE NULL END)`,
    [unitId ?? o.unitId, o.landlordId, amount.toFixed(2), status, M])
}

async function expense(client: any, o: Owner, amount: number, opts: {
  voided?: boolean; category?: string; date?: string
} = {}) {
  await client.query(
    `INSERT INTO landlord_expenses
       (landlord_id, property_id, category, amount, description, expense_date, status, voided_at)
     VALUES ($1,$2,$3,$4,'a bill',$5::date,$6,$7)`,
    [o.landlordId, o.propertyId, opts.category ?? 'repairs', amount.toFixed(2),
     opts.date ?? M, opts.voided ? 'voided' : 'active',
     opts.voided ? new Date().toISOString() : null])
}

describe('what the owner is shown', () => {
  it('reports the share that actually moved, not the rent that was due', async () => {
    const client = await getClient()
    try {
      const o = await seedOwnerWithProperty(client)
      await settledRent(client, o, 1000)
      // The resident paid $1,000; management took $100; the owner got $880 after
      // GAM's spread. The statement must say $880 — that is what their bank saw.
      await allocate(client, o, 'allocation_owner_share', 880)
      await allocate(client, o, 'allocation_pm_company_fee', 100)

      const s = await ownerStatement({ landlordId: o.landlordId, periodMonth: M })
      expect(s.totals.grossCollected).toBe(1000)
      expect(s.totals.ownerShare).toBe(880)
      expect(s.totals.managementFee).toBe(100)
      expect(s.totals.net).toBe(880)
    } finally { client.release() }
  })

  it('subtracts bills paid on their behalf and lists them', async () => {
    const client = await getClient()
    try {
      const o = await seedOwnerWithProperty(client)
      await allocate(client, o, 'allocation_owner_share', 880)
      await expense(client, o, 150, { category: 'repairs' })
      await expense(client, o, 60, { category: 'landscaping' })

      const s = await ownerStatement({ landlordId: o.landlordId, periodMonth: M })
      expect(s.totals.expenses).toBe(210)
      expect(s.totals.net).toBe(670)
      // A disputed statement is disputed one LINE at a time.
      expect(s.properties[0].expenseLines).toHaveLength(2)
      expect(s.properties[0].expenseLines.map(l => l.category).sort())
        .toEqual(['landscaping', 'repairs'])
    } finally { client.release() }
  })

  it('leaves a voided bill off entirely rather than netting it', async () => {
    const client = await getClient()
    try {
      const o = await seedOwnerWithProperty(client)
      await allocate(client, o, 'allocation_owner_share', 880)
      await expense(client, o, 150)
      await expense(client, o, 999, { voided: true })

      const s = await ownerStatement({ landlordId: o.landlordId, periodMonth: M })
      expect(s.totals.expenses).toBe(150)
      expect(s.properties[0].expenseLines).toHaveLength(1)
    } finally { client.release() }
  })

  it('never shows one owner another owner\'s property', async () => {
    const client = await getClient()
    try {
      const mine = await seedOwnerWithProperty(client)
      const theirs = await seedOwnerWithProperty(client)
      await allocate(client, mine, 'allocation_owner_share', 880)
      await allocate(client, theirs, 'allocation_owner_share', 5000)
      await expense(client, theirs, 400)

      const s = await ownerStatement({ landlordId: mine.landlordId, periodMonth: M })
      expect(s.properties).toHaveLength(1)
      expect(s.totals.ownerShare).toBe(880)
      expect(s.totals.expenses).toBe(0)
    } finally { client.release() }
  })

  it('scopes to one manager when an owner uses two', async () => {
    const client = await getClient()
    try {
      const { userId, landlordId } = await seedLandlord(client)
      const bankId = await seedUserBankAccount(client, { userId })
      const pmA = await seedPmCompany(client, { bankAccountId: bankId, name: 'Manager A' })
      const pmB = await seedPmCompany(client, { bankAccountId: bankId, name: 'Manager B' })

      const mk = async (pmId: string, share: number) => {
        const propertyId = await seedProperty(client, {
          landlordId, ownerUserId: userId, managedByUserId: userId })
        await client.query(`UPDATE properties SET pm_company_id=$2 WHERE id=$1`,
          [propertyId, pmId])
        const unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: 1000 })
        await allocate(client, { landlordId, userId, propertyId, unitId },
          'allocation_owner_share', share)
      }
      await mk(pmA, 880)
      await mk(pmB, 1500)

      const a = await ownerStatement({
        landlordId, periodMonth: M, pmCompanyId: pmA })
      expect(a.totals.ownerShare).toBe(880)
      const all = await ownerStatement({ landlordId, periodMonth: M })
      expect(all.totals.ownerShare).toBe(2380)
    } finally { client.release() }
  })

  it('keeps money still in flight off the statement entirely', async () => {
    const client = await getClient()
    try {
      const o = await seedOwnerWithProperty(client)
      await settledRent(client, o, 1000, 'processing')
      // A processing payment has not been split, so there is no owner share for
      // it. Showing the gross anyway would print "collected $1,000, your share
      // $0" and read as though management took everything. It lands on the
      // statement for the month it settles — the month their bank sees it too.
      const s = await ownerStatement({ landlordId: o.landlordId, periodMonth: M })
      expect(s.totals.grossCollected).toBe(0)
      expect(s.totals.ownerShare).toBe(0)
    } finally { client.release() }
  })

  it('shows gross and share describing the same money', async () => {
    const client = await getClient()
    try {
      const o = await seedOwnerWithProperty(client)
      await settledRent(client, o, 1000)              // settled in August
      // A second space on the same park — one active rent row per unit per due
      // date is enforced by the database, and rightly so.
      const other = await seedUnit(client, {
        propertyId: o.propertyId, landlordId: o.landlordId, rentAmount: 700 })
      await settledRent(client, o, 700, 'processing', other) // still moving
      await allocate(client, o, 'allocation_owner_share', 880)
      await allocate(client, o, 'allocation_pm_company_fee', 100)

      const s = await ownerStatement({ landlordId: o.landlordId, periodMonth: M })
      expect(s.totals.grossCollected).toBe(1000)
      // 880 + 100 = 980 of the 1,000; the remaining $20 is GAM's spread, which
      // is not the owner's business and is not printed. What matters is that
      // the gross never describes money the shares do not account for.
      expect(s.totals.ownerShare + s.totals.managementFee)
        .toBeLessThanOrEqual(s.totals.grossCollected)
    } finally { client.release() }
  })

  it('keeps last month out of this month', async () => {
    const client = await getClient()
    try {
      const o = await seedOwnerWithProperty(client)
      await allocate(client, o, 'allocation_owner_share', 880)
      await expense(client, o, 150, { date: '2026-07-15' })

      const s = await ownerStatement({ landlordId: o.landlordId, periodMonth: M })
      expect(s.totals.expenses).toBe(0)
      expect(s.totals.net).toBe(880)
    } finally { client.release() }
  })

  it('returns a property with nothing on it rather than omitting it', async () => {
    // An owner whose park collected nothing still gets a statement saying so.
    // Silence reads as a lost report.
    const client = await getClient()
    try {
      const o = await seedOwnerWithProperty(client)
      const s = await ownerStatement({ landlordId: o.landlordId, periodMonth: M })
      expect(s.properties).toHaveLength(1)
      expect(s.totals.ownerShare).toBe(0)
      expect(s.totals.net).toBe(0)
    } finally { client.release() }
  })
})

// S646 (Nic, DIRECTIVE): "Take off the pass-through thing on that. The
// pass-through should only be for the regular self-hosted landlords passing it
// through to the tenants." A manager who wants to recover their software cost
// raises their OWN fee — "the property manager sets the percentage or flat rate
// or per-unit count, that price. So the owner sees what the property manager
// sets on the owner's statement."
//
// Which means the statement has to add up a fee plan in every shape it comes in.
// Percent-of-rent is taken per payment and lands on the balance ledger; flat and
// per-unit are taken once a month and land on the accrual. Reading only the
// first reported a manager on a per-unit plan as charging the owner nothing.
// S655 (money plan E6): gross in two lines. "Collected through GAM" is the
// money GAM held and paid out — exactly what the owner share and a percentage
// fee are taken from. "Collected by the manager directly" is cash, check or
// money order the manager took, and money paid ahead to the manager on the day
// it arrived. A deposit, a GAM fee and a credit the owner gave are never gross.
describe('gross, split by who held the money (E6)', () => {
  it('gross splits into through-GAM and collected directly; a deposit, a GAM fee and issued credit never enter gross', async () => {
    const client = await getClient()
    try {
      const o = await seedOwnerWithProperty(client)
      const t = await client.query(
        `INSERT INTO users (email, password_hash, role, first_name, last_name) VALUES ($1,'x','tenant','T','T') RETURNING id`,
        [`os-${randomUUID()}@t.dev`])
      const tenantId = (await client.query(`INSERT INTO tenants (user_id) VALUES ($1) RETURNING id`, [t.rows[0].id])).rows[0].id
      const leaseId = (await client.query(
        `INSERT INTO leases (unit_id, landlord_id, rent_amount, lease_type, status, start_date)
         VALUES ($1,$2,1000,'month_to_month','active','2026-01-01') RETURNING id`, [o.unitId, o.landlordId])).rows[0].id
      const pay = async (sql: string, params: any[]) => (await client.query(sql, params)).rows[0]?.id
      // A card payment GAM held: $1,000.
      await pay(`INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description,
                                       settled_at, stripe_charge_id, platform_held)
                 VALUES ($1,$2,$3,$4,'rent',1000,'settled','2026-08-01','RENT','2026-08-05T10:00:00-07:00','ch_card',TRUE) RETURNING id`,
        [o.unitId, leaseId, tenantId, o.landlordId])
      // Cash at the desk: a $500 utility bill, $100 of it paid by a credit the owner gave.
      const cash = await pay(`INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
                              VALUES ($1,$2,$3,$4,'utility',500,'pending','2026-08-01','UTILITY') RETURNING id`,
        [o.unitId, leaseId, tenantId, o.landlordId])
      const credit = (await client.query(
        `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category)
         VALUES ($1,$2,$3,100,100,'goodwill') RETURNING id`, [o.landlordId, tenantId, leaseId])).rows[0].id
      await client.query(
        `INSERT INTO credit_uses (tenant_credit_id, payment_id, lease_id, amount, billing_month, source, status, applied_at)
         VALUES ($1,$2,$3,100,'2026-08-01','desk','applied','2026-08-06T10:00:00-07:00')`, [credit, cash, leaseId])
      await client.query(`UPDATE payments SET status='settled', settled_at='2026-08-06T10:00:00-07:00', manual_method='cash' WHERE id=$1`, [cash])
      // Never gross: a security deposit and a GAM fee.
      await pay(`INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, settled_at, revenue_owner, platform_held)
                 VALUES ($1,$2,$3,$4,'deposit',700,'settled','2026-08-01','DEPOSIT','2026-08-02T10:00:00-07:00','held',TRUE) RETURNING id`,
        [o.unitId, leaseId, tenantId, o.landlordId])
      await pay(`INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, settled_at, revenue_owner)
                 VALUES ($1,$2,$3,$4,'fee',6,'settled','2026-08-03','DECLINEFEE','2026-08-03T10:00:00-07:00','gam') RETURNING id`,
        [o.unitId, leaseId, tenantId, o.landlordId])
      // Paid ahead: $200 handed to the manager (direct, the day it arrived);
      // $300 paid ahead by card (GAM holds it until it pays a bill).
      await client.query(
        `INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining, funded_by, received_at, created_at)
         VALUES ($1,$2,200,200,'landlord','2026-08-10T10:00:00-07:00','2026-08-10T10:00:00-07:00'),
                ($1,$2,300,300,'gam','2026-08-11T10:00:00-07:00','2026-08-11T10:00:00-07:00')`, [leaseId, tenantId])
      await allocate(client, o, 'allocation_owner_share', 960)

      const s = await ownerStatement({ landlordId: o.landlordId, periodMonth: M })
      expect(s.totals.collectedThroughGam).toBe(1000)
      expect(s.totals.collectedDirectly).toBe(600)      // $400 cash + $200 paid ahead to the manager
      expect(s.totals.grossCollected).toBe(1600)
      expect(s.properties[0].collectedThroughGam + s.properties[0].collectedDirectly).toBe(s.properties[0].grossCollected)
      // Information only: August's bills and what became of them.
      expect(s.totals.billed.billed).toBe(1400)           // 1,000 + 500 − 100 credit given
      expect(s.totals.billed.collectedSoFar).toBe(1400)
      expect(s.totals.billed.stillOwed).toBe(0)
      expect(s.totals.ownerShare).toBe(960)
    } finally { client.release() }
  })

  it('a bill paid from the deposit at move-out went through GAM when GAM held the deposit in escrow, else to the manager directly', async () => {
    const client = await getClient()
    try {
      const o = await seedOwnerWithProperty(client)
      const t = await client.query(
        `INSERT INTO users (email, password_hash, role, first_name, last_name) VALUES ($1,'x','tenant','T','T') RETURNING id`,
        [`os-${randomUUID()}@t.dev`])
      const tenantId = (await client.query(`INSERT INTO tenants (user_id) VALUES ($1) RETURNING id`, [t.rows[0].id])).rows[0].id
      const unit2 = (await client.query(
        `INSERT INTO units (property_id, landlord_id, unit_number, rent_amount, status) VALUES ($1,$2,'B',800,'active') RETURNING id`,
        [o.propertyId, o.landlordId])).rows[0].id
      for (const [unitId, heldBy, amount] of [[o.unitId, 'gam_escrow', 250], [unit2, 'landlord', 150]] as const) {
        const leaseId = (await client.query(
          `INSERT INTO leases (unit_id, landlord_id, rent_amount, lease_type, status, start_date)
           VALUES ($1,$2,1000,'month_to_month','active','2026-01-01') RETURNING id`, [unitId, o.landlordId])).rows[0].id
        await client.query(
          `INSERT INTO security_deposits (unit_id, lease_id, tenant_id, total_amount, collected_amount, status, held_by)
           VALUES ($1,$2,$3,500,500,'funded',$4)`, [unitId, leaseId, tenantId, heldBy])
        await client.query(
          `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, settled_at)
           VALUES ($1,$2,$3,$4,'rent',$5,'paid_via_deposit','2026-08-01','RENT','2026-08-20T10:00:00-07:00')`,
          [unitId, leaseId, tenantId, o.landlordId, amount])
      }
      const s = await ownerStatement({ landlordId: o.landlordId, periodMonth: M })
      expect(s.totals.collectedThroughGam).toBe(250)   // GAM held that deposit and pays the share out at move-out
      expect(s.totals.collectedDirectly).toBe(150)     // the manager already held this one
      expect(s.totals.grossCollected).toBe(400)
    } finally { client.release() }
  })

  it('a renewal-chain move-out short of the bills it swept: gross is what the pool kept, through whoever held the deposit on the new lease', async () => {
    const client = await getClient()
    try {
      const o = await seedOwnerWithProperty(client)
      const t = await client.query(
        `INSERT INTO users (email, password_hash, role, first_name, last_name) VALUES ($1,'x','tenant','T','T') RETURNING id`,
        [`os-${randomUUID()}@t.dev`])
      const tenantId = (await client.query(`INSERT INTO tenants (user_id) VALUES ($1) RETURNING id`, [t.rows[0].id])).rows[0].id
      const unit2 = (await client.query(
        `INSERT INTO units (property_id, landlord_id, unit_number, rent_amount, status) VALUES ($1,$2,'B',800,'active') RETURNING id`,
        [o.propertyId, o.landlordId])).rows[0].id
      // Each household renewed; $700 of rent went unpaid on the PREVIOUS lease and
      // is swept to the $400 deposit on the new one, with $100 of cleaning: the gap is $400.
      const fins = { gam_escrow: '2026-08-20T10:00:00-07:00', landlord: '2026-08-21T10:00:00-07:00' }
      for (const [unitId, heldBy] of [[o.unitId, 'gam_escrow'], [unit2, 'landlord']] as const) {
        const lease = async (status: string) => (await client.query(
          `INSERT INTO leases (unit_id, landlord_id, rent_amount, lease_type, status, start_date)
           VALUES ($1,$2,700,'month_to_month',$3,'2026-01-01') RETURNING id`, [unitId, o.landlordId, status])).rows[0].id
        const previous = await lease('expired')
        const current = await lease('active')
        await client.query(`UPDATE leases SET supersedes_lease_id = $2 WHERE id = $1`, [current, previous])
        await client.query(
          `INSERT INTO security_deposits (unit_id, lease_id, tenant_id, total_amount, collected_amount, status, held_by)
           VALUES ($1,$2,$3,400,400,'funded',$4)`, [unitId, current, tenantId, heldBy])
        await client.query(
          `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, settled_at)
           VALUES ($1,$2,$3,$4,'rent',700,'paid_via_deposit','2026-08-01','RENT',$5)`,
          [unitId, previous, tenantId, o.landlordId, fins[heldBy]])
        const gap = (await client.query(
          `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
           VALUES ($1,$2,$3,$4,'fee',400,'pending','2026-08-20','DEPOSIT') RETURNING id`,
          [unitId, current, tenantId, o.landlordId])).rows[0].id
        await client.query(
          `INSERT INTO deposit_returns (lease_id, tenant_id, landlord_id, total_deposit, cleaning_fee_amount, damage_lines,
                                        other_deductions, unpaid_balance_amount, total_deductions, gap_amount, gap_payment_id,
                                        status, finalized_at)
           VALUES ($1,$2,$3,400,100,'[]','[]',700,800,400,$4,'sent_gap',$5)`,
          [current, tenantId, o.landlordId, gap, fins[heldBy]])
      }
      const s = await ownerStatement({ landlordId: o.landlordId, periodMonth: M })
      // Was 0 / 1,400: the escrow was looked up on the previous lease, and each
      // swept bill counted its whole $700 though the pool only held $400.
      expect(s.totals.collectedThroughGam).toBe(400)   // GAM held that deposit (on the new lease)
      expect(s.totals.collectedDirectly).toBe(400)     // the manager held this one
      expect(s.totals.grossCollected).toBe(800)
    } finally { client.release() }
  })
})

describe('a move-out on the statement: what the pool kept, and the shortfall paid later', () => {
  /** One household moving out of the owner's unit, with its deposit held by `heldBy`. */
  async function moveOutWorld(client: any, heldBy: 'gam_escrow' | 'landlord') {
    const o = await seedOwnerWithProperty(client)
    const t = await client.query(
      `INSERT INTO users (email, password_hash, role, first_name, last_name) VALUES ($1,'x','tenant','T','T') RETURNING id`,
      [`os-${randomUUID()}@t.dev`])
    const tenantId = (await client.query(`INSERT INTO tenants (user_id) VALUES ($1) RETURNING id`, [t.rows[0].id])).rows[0].id
    const leaseId = (await client.query(
      `INSERT INTO leases (unit_id, landlord_id, rent_amount, lease_type, status, start_date)
       VALUES ($1,$2,700,'month_to_month','active','2026-01-01') RETURNING id`, [o.unitId, o.landlordId])).rows[0].id
    await client.query(
      `INSERT INTO security_deposits (unit_id, lease_id, tenant_id, total_amount, collected_amount, status, held_by)
       VALUES ($1,$2,$3,400,400,'funded',$4)`, [o.unitId, leaseId, tenantId, heldBy])
    const fin = '2026-08-20T10:00:00-07:00'
    const swept = async (amount: number) => client.query(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, settled_at)
       VALUES ($1,$2,$3,$4,'rent',$5,'paid_via_deposit','2026-08-01','RENT',$6)`,
      [o.unitId, leaseId, tenantId, o.landlordId, amount, fin])
    const finalize = async (m: { cleaning: number; swept: number; gap: number }) => {
      const gap = m.gap > 0 ? (await client.query(
        `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
         VALUES ($1,$2,$3,$4,'fee',$5,'pending','2026-08-20','DEPOSIT') RETURNING id`,
        [o.unitId, leaseId, tenantId, o.landlordId, m.gap])).rows[0].id : null
      const dr = (await client.query(
        `INSERT INTO deposit_returns (lease_id, tenant_id, landlord_id, total_deposit, cleaning_fee_amount, damage_lines,
                                      other_deductions, unpaid_balance_amount, total_deductions, gap_amount, gap_payment_id,
                                      status, finalized_at)
         VALUES ($1,$2,$3,400,$4,'[]','[]',$5,$6,$7,$8,$9,$10) RETURNING id`,
        [leaseId, tenantId, o.landlordId, m.cleaning, m.swept, m.cleaning + m.swept, m.gap, gap,
         m.gap > 0 ? 'sent_gap' : 'sent_refund', fin])).rows[0].id
      return { gap, dr }
    }
    return { o, tenantId, leaseId, fin, swept, finalize }
  }

  it('deductions the pool kept count on the finalize day, through whoever held the deposit', async () => {
    const client = await getClient()
    try {
      // GAM escrow: $400 deposit, $250 of cleaning, nothing swept — $150 refunded, $250 kept.
      const a = await moveOutWorld(client, 'gam_escrow')
      await a.finalize({ cleaning: 250, swept: 0, gap: 0 })
      const sa = await ownerStatement({ landlordId: a.o.landlordId, periodMonth: M })
      expect(sa.totals.collectedThroughGam).toBe(250)    // was 0: deductions kept never entered gross
      expect(sa.totals.collectedDirectly).toBe(0)
      // The manager held this one: $300 cleaning + $200 of rent swept against $400 — the gap is $100,
      // all of it the cleaning's, so the pool kept $200 of cleaning and the whole $200 of rent.
      const b = await moveOutWorld(client, 'landlord')
      await b.swept(200)
      await b.finalize({ cleaning: 300, swept: 200, gap: 100 })
      const sb = await ownerStatement({ landlordId: b.o.landlordId, periodMonth: M })
      expect(sb.totals.collectedDirectly).toBe(400)      // the pool: $200 rent + $200 cleaning
      expect(sb.totals.collectedThroughGam).toBe(0)
      expect(sb.totals.grossCollected).toBe(400)
    } finally { client.release() }
  })

  it('the shortfall the tenant pays after move-out counts in the month it is paid — through GAM by card, directly in cash', async () => {
    const client = await getClient()
    try {
      // $700 of rent swept to a $400 deposit the manager held; $100 of cleaning; the gap is $400.
      const w = await moveOutWorld(client, 'landlord')
      await w.swept(700)
      const { gap } = await w.finalize({ cleaning: 100, swept: 700, gap: 400 })
      const aug = await ownerStatement({ landlordId: w.o.landlordId, periodMonth: M })
      expect(aug.totals.grossCollected).toBe(400)        // what the pool kept; $400 still owed
      expect(aug.totals.billed.stillOwed).toBe(400)
      // September 9: the tenant pays the $400 by card.
      await client.query(
        `UPDATE payments SET status = 'settled', settled_at = '2026-09-09T10:00:00-07:00', stripe_charge_id = 'ch_gap',
                             platform_held = TRUE WHERE id = $1`, [gap])
      const sep = await ownerStatement({ landlordId: w.o.landlordId, periodMonth: '2026-09' })
      expect(sep.totals.collectedThroughGam).toBe(400)   // was 0: the paid shortfall appeared in no month
      expect(sep.totals.collectedDirectly).toBe(0)
      expect(sep.totals.grossCollected).toBe(400)
      // August is unchanged, and August's bills now read collected.
      const aug2 = await ownerStatement({ landlordId: w.o.landlordId, periodMonth: M })
      expect(aug2.totals.grossCollected).toBe(400)
      expect(aug2.totals.billed.stillOwed).toBe(0)
      expect(aug2.totals.billed.collectedSoFar).toBe(800)

      // A second household pays its shortfall in cash: directly.
      const c = await moveOutWorld(client, 'gam_escrow')
      await c.swept(700)
      const c2 = await c.finalize({ cleaning: 100, swept: 700, gap: 400 })
      await client.query(
        `UPDATE payments SET status = 'settled', settled_at = '2026-09-10T10:00:00-07:00', manual_method = 'cash'
          WHERE id = $1`, [c2.gap])
      const csep = await ownerStatement({ landlordId: c.o.landlordId, periodMonth: '2026-09' })
      expect(csep.totals.collectedDirectly).toBe(400)
      expect(csep.totals.collectedThroughGam).toBe(0)
    } finally { client.release() }
  })

  it('a paid shortfall disputed the next month stays in its month; the dispute shows beside gross when it happens', async () => {
    const client = await getClient()
    try {
      const w = await moveOutWorld(client, 'landlord')
      await w.swept(700)
      const { gap } = await w.finalize({ cleaning: 100, swept: 700, gap: 400 })
      await client.query(
        `UPDATE payments SET status = 'settled', settled_at = '2026-09-09T10:00:00-07:00', stripe_charge_id = 'ch_gap',
                             platform_held = TRUE WHERE id = $1`, [gap])
      const before = await ownerStatement({ landlordId: w.o.landlordId, periodMonth: '2026-09' })
      const rev = (await client.query(
        `INSERT INTO payment_reversals (payment_id, landlord_id, tenant_id, lease_id, reversal_type, reversed_amount,
                                        stripe_event_id, raw_event, created_at)
         VALUES ($1,$2,$3,$4,'card_dispute',400,'evt_gap','{}','2026-10-02T10:00:00-07:00') RETURNING id`,
        [gap, w.o.landlordId, w.tenantId, w.leaseId])).rows[0].id
      await client.query(`UPDATE payments SET status = 'returned' WHERE id = $1`, [gap])
      await client.query(
        `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, reversal_id)
         VALUES ($1,$2,$3,$4,'fee',400,'pending','2026-08-20','DEPOSIT',$5)`,
        [w.o.unitId, w.leaseId, w.tenantId, w.o.landlordId, rev])
      const after = await ownerStatement({ landlordId: w.o.landlordId, periodMonth: '2026-09' })
      expect(after.totals.grossCollected).toBe(before.totals.grossCollected)
      expect(after.totals.collectedThroughGam).toBe(400)
      const oct = await ownerStatement({ landlordId: w.o.landlordId, periodMonth: '2026-10' })
      expect(oct.totals.returnedOrDisputed).toBe(-400)
      expect(oct.totals.grossCollected).toBe(0)
    } finally { client.release() }
  })

  it('paid-ahead money the pool took comes back off: the manager’s counted when it arrived; GAM’s moves to GAM’s line', async () => {
    const client = await getClient()
    try {
      // The manager held the $400 deposit. The tenant had paid $200 ahead in cash (July)
      // and $300 ahead by card (GAM holds it). $100 of cleaning: the pool of $900 keeps
      // $100 and refunds $800.
      const w = await moveOutWorld(client, 'landlord')
      const credit = async (amount: number, fundedBy: 'landlord' | 'gam') => (await client.query(
        `INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining, funded_by, received_at, created_at)
         VALUES ($1,$2,$3,$3,$4,'2026-07-10T10:00:00-07:00','2026-07-10T10:00:00-07:00') RETURNING id`,
        [w.leaseId, w.tenantId, amount, fundedBy])).rows[0].id
      const cash = await credit(200, 'landlord')
      const card = await credit(300, 'gam')
      const jul = await ownerStatement({ landlordId: w.o.landlordId, periodMonth: '2026-07' })
      expect(jul.totals.collectedDirectly).toBe(200)     // paid ahead to the manager, the day it arrived
      const { dr } = await w.finalize({ cleaning: 100, swept: 0, gap: 0 })
      for (const [id, amount] of [[cash, 200], [card, 300]] as const) {
        await client.query(
          `INSERT INTO credit_uses (prepaid_credit_id, deposit_return_id, lease_id, amount, billing_month, source, status, held_at, applied_at)
           VALUES ($1,$2,$3,$4,'2026-08-01','move_out','applied',$5::timestamptz,$5::timestamptz)`,
          [id, dr, w.leaseId, amount, w.fin])
      }
      const aug = await ownerStatement({ landlordId: w.o.landlordId, periodMonth: M })
      // $100 kept − the $200 that already counted in July; GAM pays out the $300 it held.
      expect(aug.totals.collectedThroughGam).toBe(300)
      expect(aug.totals.collectedDirectly).toBe(-400)    // 100 − 200 − 300
      expect(aug.totals.grossCollected).toBe(-100)
      // Over the two months the owner's gross is what the tenant left behind: $100.
      expect(jul.totals.grossCollected + aug.totals.grossCollected).toBe(100)
    } finally { client.release() }
  })
})

describe('a dispute never rewrites a past statement', () => {
  it('a statement for a month whose payment was disputed the following month is unchanged; the reversal shows in the month it happened', async () => {
    const client = await getClient()
    try {
      const o = await seedOwnerWithProperty(client)
      const t = await client.query(
        `INSERT INTO users (email, password_hash, role, first_name, last_name) VALUES ($1,'x','tenant','T','T') RETURNING id`,
        [`os-${randomUUID()}@t.dev`])
      const tenantId = (await client.query(`INSERT INTO tenants (user_id) VALUES ($1) RETURNING id`, [t.rows[0].id])).rows[0].id
      const leaseId = (await client.query(
        `INSERT INTO leases (unit_id, landlord_id, rent_amount, lease_type, status, start_date)
         VALUES ($1,$2,1000,'month_to_month','active','2026-01-01') RETURNING id`, [o.unitId, o.landlordId])).rows[0].id
      // August: $1,000 of rent by card, through GAM; the owner's $880 share is booked.
      const aug = (await client.query(
        `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description,
                               settled_at, stripe_charge_id, platform_held)
         VALUES ($1,$2,$3,$4,'rent',1000,'settled','2026-08-01','RENT','2026-08-05T10:00:00-07:00','ch_card',TRUE) RETURNING id`,
        [o.unitId, leaseId, tenantId, o.landlordId])).rows[0].id
      await allocate(client, o, 'allocation_owner_share', 880)
      const before = await ownerStatement({ landlordId: o.landlordId, periodMonth: M })
      expect(before.totals.grossCollected).toBe(1000)
      expect(before.totals.collectedThroughGam).toBe(1000)
      expect(before.totals.returnedOrDisputed).toBe(0)

      // September 12: the charge is disputed (what Step 10 writes): a reversal
      // record, the row returned, and a fresh row reopened for what it lost.
      const rev = (await client.query(
        `INSERT INTO payment_reversals (payment_id, landlord_id, tenant_id, lease_id, reversal_type, reversed_amount,
                                        stripe_event_id, raw_event, created_at)
         VALUES ($1,$2,$3,$4,'card_dispute',1000,'evt_dispute_aug','{}','2026-09-12T10:00:00-07:00') RETURNING id`,
        [aug, o.landlordId, tenantId, leaseId])).rows[0].id
      await client.query(`UPDATE payments SET status = 'returned' WHERE id = $1`, [aug])
      await client.query(
        `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, reversal_id)
         VALUES ($1,$2,$3,$4,'rent',1000,'pending','2026-08-01','RENT',$5)`,
        [o.unitId, leaseId, tenantId, o.landlordId, rev])

      // August's money reads exactly as it did: gross and share still describe
      // the same money. (The billed block is "as of today" by design: August's
      // rent is owed again on the reopened row.)
      const after = await ownerStatement({ landlordId: o.landlordId, periodMonth: M })
      const { billed: billedBefore, ...moneyBefore } = before.totals
      const { billed: billedAfter, ...moneyAfter } = after.totals
      expect(moneyAfter).toEqual(moneyBefore)
      expect(billedBefore.collectedSoFar).toBe(1000)
      expect(billedAfter.billed).toBe(1000)
      expect(billedAfter.stillOwed).toBe(1000)
      expect(after.properties[0].collectedThroughGam).toBe(1000)
      expect(after.properties[0].ownerShare).toBe(880)
      // September shows what the dispute took back, beside gross — never inside it.
      const sep = await ownerStatement({ landlordId: o.landlordId, periodMonth: '2026-09' })
      expect(sep.totals.returnedOrDisputed).toBe(-1000)
      expect(sep.properties[0].returnedOrDisputed).toBe(-1000)
      expect(sep.totals.grossCollected).toBe(0)
    } finally { client.release() }
  })
})

describe('what the manager charged, whatever shape their plan is', () => {
  async function managed(client: any) {
    const { userId, landlordId } = await seedLandlord(client)
    const bankId = await seedUserBankAccount(client, { userId })
    const pmId = await seedPmCompany(client, { bankAccountId: bankId })
    const propertyId = await seedProperty(client, {
      landlordId, ownerUserId: userId, managedByUserId: userId })
    const planId = await seedPmFeePlan(client, {
      pmCompanyId: pmId, feeType: 'per_unit', flatAmount: 45 })
    await client.query(
      `UPDATE properties SET pm_company_id=$2, pm_fee_plan_id=$3 WHERE id=$1`,
      [propertyId, pmId, planId])
    const unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: 1000 })
    const o = { landlordId, userId, propertyId, unitId, pmCompanyId: pmId, planId }
    await allocate(client, o, 'allocation_owner_share', 880)
    return o
  }

  const monthlyFee = (client: any, o: any, amount: number, feeType = 'per_unit') =>
    client.query(
      `INSERT INTO pm_monthly_fee_accruals
         (property_id, pm_company_id, pm_fee_plan_id, accrual_month, fee_type,
          per_unit_amount, occupied_unit_count, total_amount, pm_payout_user_id)
       VALUES ($1,$2,$3,$4::date,$5,$6,$7,$8,$9)`,
      [o.propertyId, o.pmCompanyId, o.planId, M, feeType,
       amount.toFixed(2), 1, amount.toFixed(2), o.userId])

  it('counts a per-unit plan the owner would otherwise never see', async () => {
    const client = await getClient()
    try {
      const o = await managed(client)
      await monthlyFee(client, o, 45)
      const s = await ownerStatement({ landlordId: o.landlordId, periodMonth: M })
      expect(s.totals.managementFee).toBe(45)
    } finally { client.release() }
  })

  it('adds a percent-of-rent cut and a monthly fee into one number', async () => {
    const client = await getClient()
    try {
      const o = await managed(client)
      await allocate(client, o, 'allocation_pm_company_fee', 100)  // per payment
      await monthlyFee(client, o, 45, 'flat_monthly')              // once a month
      const s = await ownerStatement({ landlordId: o.landlordId, periodMonth: M })
      expect(s.totals.managementFee).toBe(145)
    } finally { client.release() }
  })

  it('does not bill the owner for GAM\'s contract with their manager', async () => {
    // Nic: "the owner's statement would not see our contract between the
    // property manager and the platform." The manager's GAM bill is theirs.
    const client = await getClient()
    try {
      const o = await managed(client)
      await monthlyFee(client, o, 45)
      const s = await ownerStatement({ landlordId: o.landlordId, periodMonth: M })
      expect(s.totals.net).toBe(880)               // untouched by GAM's fee
      expect(JSON.stringify(s)).not.toContain('platformPassthrough')
    } finally { client.release() }
  })

  it('scopes the monthly fee to the manager being reported on', async () => {
    const client = await getClient()
    try {
      const o = await managed(client)
      await monthlyFee(client, o, 45)
      const mine = await ownerStatement({
        landlordId: o.landlordId, periodMonth: M, pmCompanyId: o.pmCompanyId })
      expect(mine.totals.managementFee).toBe(45)
    } finally { client.release() }
  })
})

describe('the relationship opens itself', () => {
  it('a property joining a manager creates the owner relationship', async () => {
    const client = await getClient()
    try {
      const { userId, landlordId } = await seedLandlord(client)
      const bankId = await seedUserBankAccount(client, { userId })
      const pmId = await seedPmCompany(client, { bankAccountId: bankId })
      const propertyId = await seedProperty(client, {
        landlordId, ownerUserId: userId, managedByUserId: userId })

      const before = await client.query(
        `SELECT 1 FROM pm_owner_relationships WHERE pm_company_id=$1`, [pmId])
      expect(before.rows).toHaveLength(0)

      await client.query(`UPDATE properties SET pm_company_id=$2 WHERE id=$1`,
        [propertyId, pmId])

      const after = await client.query(
        `SELECT portal_access FROM pm_owner_relationships
          WHERE pm_company_id=$1 AND landlord_id=$2`, [pmId, landlordId])
      expect(after.rows).toHaveLength(1)
      // The default is exactly today's behavior: no portal until someone asks.
      expect(after.rows[0].portal_access).toBe('none')
    } finally { client.release() }
  })

  it('a second property under the same manager does not duplicate it', async () => {
    const client = await getClient()
    try {
      const { userId, landlordId } = await seedLandlord(client)
      const bankId = await seedUserBankAccount(client, { userId })
      const pmId = await seedPmCompany(client, { bankAccountId: bankId })
      for (let i = 0; i < 2; i++) {
        const propertyId = await seedProperty(client, {
          landlordId, ownerUserId: userId, managedByUserId: userId })
        await client.query(`UPDATE properties SET pm_company_id=$2 WHERE id=$1`,
          [propertyId, pmId])
      }
      const rel = await client.query(
        `SELECT count(*)::int AS n FROM pm_owner_relationships
          WHERE pm_company_id=$1 AND landlord_id=$2`, [pmId, landlordId])
      expect(rel.rows[0].n).toBe(1)
    } finally { client.release() }
  })

  it('there is no way to record a manager refusing an owner the portal', async () => {
    // Nic (S644, DIRECTIVE): "Request portal access through PM, but PM can't
    // deny an owner." Held at the database, not in a screen that can be
    // rewritten: 'denied' is not a value this column accepts.
    const client = await getClient()
    try {
      const { userId, landlordId } = await seedLandlord(client)
      const bankId = await seedUserBankAccount(client, { userId })
      const pmId = await seedPmCompany(client, { bankAccountId: bankId })
      await client.query(
        `INSERT INTO pm_owner_relationships (pm_company_id, landlord_id)
         VALUES ($1,$2)`, [pmId, landlordId])
      await expect(client.query(
        `UPDATE pm_owner_relationships SET portal_access='denied'
          WHERE pm_company_id=$1`, [pmId])).rejects.toThrow()
    } finally { client.release() }
  })
})

describe('monthStart', () => {
  it('accepts a bare month and a full date alike', () => {
    expect(monthStart('2026-08')).toBe('2026-08-01')
    expect(monthStart('2026-08-19')).toBe('2026-08-01')
  })
  it('refuses something that is not a month', () => {
    expect(() => monthStart('August')).toThrow()
  })
})

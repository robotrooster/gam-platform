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
      // The default is exactly today's behaviour: no portal until someone asks.
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

/**
 * S609 — paying ahead, and the guard that still blocks paying short.
 *
 * Two rules that look symmetrical and are not:
 *
 *   UNDER-payment stays blocked (Nic, standing directive) — a partial payment
 *   can reset a landlord's eviction clock.
 *
 *   OVER-payment is now allowed. The old code rejected it too, but the comment
 *   beside that guard said "no pay-ahead — the UI has no amount field", which
 *   recorded a MISSING INPUT BOX, not a policy decision.
 *
 * And NO CEILING (Nic, DIRECTIVE): a lease-term cap was written and then
 * reversed the same session — utilities aren't known until a meter is read, so
 * any cap lands wrong at the end of every lease and forces the refund churn it
 * was meant to prevent.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant,
  seedLease, seedLeaseTenant, seedAllocationRule,
} from '../test/dbHelpers'

const { paymentIntentsCancelMock } = vi.hoisted(() => ({
  paymentIntentsCancelMock: vi.fn(async (id: string) => ({ id, status: 'canceled' })),
}))
let piSeq = 0
vi.mock('./stripeConnect', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    createRentPlatformCharge: vi.fn(async () => ({ id: `pi_s609_test_${++piSeq}`, status: 'processing' })),
  }
})
vi.mock('../lib/stripe', () => ({
  getStripe: () => ({
    paymentMethods: { retrieve: vi.fn(async () => ({ card: { country: 'US' } })) },
    paymentIntents: { cancel: paymentIntentsCancelMock },
  }),
}))

import { chargeLeaseBalance, suggestedPayAheadFor, quoteLeaseCharge, CreditChangedError, creditWaitingSentence, creditRestSentence, CARD_CONFIRM_HOLD_MINUTES, type CreditChoiceInput } from './rentCharge'
import { createPaidAhead } from './creditUse'
import * as stripeConnect from './stripeConnect'

interface Fixture {
  landlordId: string; userId: string; propertyId: string
  unitId: string; tenantId: string; leaseId: string
}

/** `monthsLeft` sets the lease end — used only by the screen's suggestion. */
async function fixture(monthsLeft = 6): Promise<Fixture> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const ll = await seedLandlord(client)
    const propertyId = await seedProperty(client, {
      landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
    await seedAllocationRule(client, { propertyId, achFeePayer: 'tenant', cardFeePayer: 'tenant' })
    const unitId = await seedUnit(client, { propertyId, landlordId: ll.landlordId, withLateFeeDecision: true })
    const tenantId = await seedTenant(client)
    await client.query(`UPDATE tenants SET stripe_customer_id='cus_s609' WHERE id=$1`, [tenantId])
    const leaseId = await seedLease(client, { unitId, landlordId: ll.landlordId, rentAmount: 1000 })
    await client.query(
      `UPDATE leases SET end_date = (CURRENT_DATE + ($2 || ' months')::interval)::date WHERE id = $1`,
      [leaseId, String(monthsLeft)])
    await seedLeaseTenant(client, { leaseId, tenantId })
    await client.query('COMMIT')
    return { ...ll, propertyId, unitId, tenantId, leaseId }
  } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
}

async function seedCharge(f: Fixture, amount: number, dueDate: string) {
  const r = await db.query<{ id: string }>(
    `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
     VALUES ($1,$2,$3,$4,'rent',$5,'pending',$6,'RENT') RETURNING id`,
    [f.unitId, f.leaseId, f.tenantId, f.landlordId, amount.toFixed(2), dueDate])
  return r.rows[0].id
}

async function seedCarried(f: Fixture, amount: number, dueDate: string) {
  const r = await db.query<{ id: string }>(
    `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
     VALUES ($1,$2,$3,$4,'carried_balance',$5,'pending',$6,'BALANCE') RETURNING id`,
    [f.unitId, f.leaseId, f.tenantId, f.landlordId, amount.toFixed(2), dueDate])
  return r.rows[0].id
}

const charge = (f: Fixture, amount: number, credit: CreditChoiceInput | null = null, method: 'ach' | 'card' = 'ach') => chargeLeaseBalance({
  tenantId: f.tenantId, leaseId: f.leaseId, amount,
  paymentMethodId: 'pm_test', paymentMethodType: method, source: 'portal', credit,
})

async function seedCredit(f: Fixture, amount: number, opts: { leaseId?: string | null; category?: string } = {}) {
  const r = await db.query<{ id: string }>(
    `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category)
     VALUES ($1,$2,$3,$4,$4,$5) RETURNING id`,
    [f.landlordId, f.tenantId, opts.leaseId === undefined ? f.leaseId : opts.leaseId, amount.toFixed(2), opts.category ?? 'other'])
  return r.rows[0].id
}
const creditLeft = async (id: string) =>
  Number((await db.query<{ r: string }>(`SELECT amount_remaining::text AS r FROM tenant_credits WHERE id = $1`, [id])).rows[0].r)
const chargedAmounts = () => (stripeConnect.createRentPlatformCharge as any).mock.calls.map((c: any[]) => c[0].amount)

describe('S609 pay-ahead', () => {
  let f: Fixture

  beforeAll(async () => {
    await db.query(
      `INSERT INTO platform_processing_rates
         (payment_method, customer_facing_flat, customer_facing_percent,
          stripe_cost_flat, stripe_cost_percent)
       SELECT 'ach', 6, 0, 0, 0.5
        WHERE NOT EXISTS (SELECT 1 FROM platform_processing_rates WHERE payment_method = 'ach')`)
  })

  beforeEach(async () => {
    await cleanupAllSchema()
    ;(stripeConnect.createRentPlatformCharge as any).mockClear()
    f = await fixture()
  })

  it('paying MORE than the balance banks the surplus as pay-ahead', async () => {
    await seedCharge(f, 1000, '2026-08-01')
    const r = await charge(f, 3000)              // this month plus two ahead

    expect(r.appliedTotal).toBeCloseTo(1000, 2)
    expect(r.payAhead).toBeCloseTo(2000, 2)

    // The surplus is recorded on the remittance; the webhook banks it as
    // prepaid credit when the charge settles.
    const rem = await db.query<{ unapplied_amount: string }>(
      `SELECT unapplied_amount::text FROM tenant_remittances WHERE id = $1`, [r.remittanceId])
    expect(Number(rem.rows[0].unapplied_amount)).toBeCloseTo(2000, 2)
  })

  it('Stripe is charged the WHOLE amount including the surplus', async () => {
    await seedCharge(f, 1000, '2026-08-01')
    await charge(f, 3000)
    // 3000 + the flat $6 tenant-borne bank fee.
    const sent = (stripeConnect.createRentPlatformCharge as any).mock.calls[0][0].amount
    expect(sent).toBeCloseTo(3006, 2)
  })

  it('paying LESS than the balance is still refused', async () => {
    await seedCharge(f, 1000, '2026-08-01')
    await expect(charge(f, 600)).rejects.toMatchObject({ statusCode: 422 })
  })

  it('paying exactly the balance still works, unchanged', async () => {
    await seedCharge(f, 1000, '2026-08-01')
    const r = await charge(f, 1000)
    expect(r.appliedTotal).toBeCloseTo(1000, 2)
    expect(r.payAhead).toBeCloseTo(0, 2)
  })

  // S609 (Nic, DIRECTIVE — reversed the lease-term ceiling the same session it
  // was written): "It shouldn't be the rest of their lease term specifically
  // because a tenant that's getting billed utilities... they never know what
  // it's gonna be until the meters are read. So let's just not put any cap on
  // it, to eliminate those pinch points."
  it('takes far more than the lease term is worth — there is NO cap', async () => {
    await seedCharge(f, 1000, '2026-08-01')
    const r = await charge(f, 20000)          // six months left; pays twenty
    expect(r.appliedTotal).toBeCloseTo(1000, 2)
    expect(r.payAhead).toBeCloseTo(19000, 2)
  })

  it('a lease at its very end can still pay ahead', async () => {
    const g = await fixture(0)
    await seedCharge(g, 1000, '2026-08-01')
    const r = await charge(g, 5000)
    expect(r.payAhead).toBeCloseTo(4000, 2)
  })

  it('the screen SUGGESTION is the rest of the lease term — advisory only', async () => {
    expect(await suggestedPayAheadFor(f.leaseId)).toBeCloseTo(6000, 2)
  })

  it('a month-to-month lease suggests a year', async () => {
    await db.query(`UPDATE leases SET end_date = NULL WHERE id = $1`, [f.leaseId])
    expect(await suggestedPayAheadFor(f.leaseId)).toBeCloseTo(12000, 2)
  })
})

// ── S622: arrears are payable in part; the lease's own charges are not ──
//
// Nic: "if they are behind a thousand dollars and we're carrying forward, they
// need to be paying on the new lease and making payments towards the outstanding
// balance... that balance should allow partial payments. The invoiced portion of
// the lease shouldn't allow partial payments."
//
// Before this, the two rules collided and trapped the tenant: arrears are the
// oldest charge, so pay-in-full demanded rent PLUS the whole old debt before it
// would accept anything. Someone $1,000 behind could not pay their rent at all,
// and took a late fee every month for it.
describe('S622 carried-forward balance', () => {
  let f: Fixture
  beforeEach(async () => {
    await cleanupAllSchema()
    ;(stripeConnect.createRentPlatformCharge as any).mockClear()
    f = await fixture()
  })

  it('rent alone is payable while $1,000 of arrears sits on the ledger', async () => {
    await seedCarried(f, 1000, '2026-01-01')   // older than the rent
    await seedCharge(f, 800, '2026-09-01')

    const r = await charge(f, 800)
    expect(r.appliedTotal).toBeCloseTo(800, 2)
    // Every cent went to RENT — the arrears did not crowd it out despite being
    // eight months older. Applications are recorded on the remittance.
    const applied = await db.query<{ type: string; amount_applied: string }>(
      `SELECT p.type, ra.amount_applied::text
         FROM remittance_applications ra JOIN payments p ON p.id = ra.payment_id
        WHERE ra.remittance_id = $1`, [r.remittanceId])
    expect(applied.rows.length).toBe(1)
    expect(applied.rows[0].type).toBe('rent')
    expect(Number(applied.rows[0].amount_applied)).toBeCloseTo(800, 2)
  })

  it('paying above the rent chips away at the arrears — a PARTIAL payment on them', async () => {
    await seedCarried(f, 1000, '2026-01-01')
    await seedCharge(f, 800, '2026-09-01')

    const r = await charge(f, 950)
    expect(r.appliedTotal).toBeCloseTo(950, 2)

    // $150 of the arrears was applied...
    const applied = await db.query<{ amount_applied: string }>(
      `SELECT ra.amount_applied::text
         FROM remittance_applications ra JOIN payments p ON p.id = ra.payment_id
        WHERE ra.remittance_id = $1 AND p.type = 'carried_balance'`, [r.remittanceId])
    expect(applied.rows.length).toBe(1)
    expect(Number(applied.rows[0].amount_applied)).toBeCloseTo(150, 2)

    // ...and the rest stays open as a remainder row. A partial payment on
    // arrears is allowed and expected — this is the whole carve-out.
    const stillOwed = await db.query<{ total: string }>(
      `SELECT COALESCE(SUM(amount),0)::text AS total FROM payments
        WHERE lease_id=$1 AND type='carried_balance' AND status='pending'`, [f.leaseId])
    expect(Number(stillOwed.rows[0].total)).toBeCloseTo(850, 2)
  })

  it('still refuses an underpayment of the RENT itself', async () => {
    await seedCarried(f, 1000, '2026-01-01')
    await seedCharge(f, 800, '2026-09-01')
    // The carve-out is only for arrears; the lease's own charges stay all-or-nothing.
    await expect(charge(f, 600)).rejects.toMatchObject({ statusCode: 422 })
  })

  it('with no rent outstanding, the arrears can be paid down in any amount', async () => {
    await seedCarried(f, 1000, '2026-01-01')
    const r = await charge(f, 250)
    expect(r.appliedTotal).toBeCloseTo(250, 2)
    expect(r.payAhead).toBeCloseTo(0, 2)
  })

  // Nic, double-checking S622: "they definitely cannot in any way, shape, or
  // form pay a partial amount on a current new charge. All new charges are paid
  // in full, and that's that."
  //
  // The carve-out must not have opened a side door. Sweep a range of amounts and
  // assert the invariant directly: whatever the tenant pays, every NON-carried
  // charge is either untouched or paid to the cent — never split.
  it('NO current charge is ever partially applied, at any payable amount', async () => {
    await seedCarried(f, 1000, '2026-01-01')
    await seedCharge(f, 800, '2026-09-01')
    await db.query(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
       VALUES ($1,$2,$3,$4,'utility',120,'pending','2026-08-20','PROPANE')`,
      [f.unitId, f.leaseId, f.tenantId, f.landlordId])

    // requiredInFull = 800 rent + 120 propane = 920. Anything at or above it is
    // payable; walk across the arrears too.
    for (const amt of [920, 921, 1000, 1500, 1920, 2500]) {
      await cleanupAllSchema()
      f = await fixture()
      await seedCarried(f, 1000, '2026-01-01')
      await seedCharge(f, 800, '2026-09-01')
      await db.query(
        `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
         VALUES ($1,$2,$3,$4,'utility',120,'pending','2026-08-20','PROPANE')`,
        [f.unitId, f.leaseId, f.tenantId, f.landlordId])

      const r = await charge(f, amt)
      const partials = await db.query<{ type: string; n: string }>(
        `SELECT p.type, COUNT(*)::text AS n
           FROM payments p
          WHERE p.lease_id = $1 AND p.is_remainder = TRUE
          GROUP BY p.type`, [f.leaseId])
      const nonCarriedSplits = partials.rows.filter(x => x.type !== 'carried_balance')
      expect(nonCarriedSplits, `paying $${amt} split a current charge`).toEqual([])
      expect(r.appliedTotal).toBeGreaterThanOrEqual(920)
    }
  })

  // ── S637: A CREDIT REDUCES WHAT THE TENANT IS ASKED FOR ──────────────────
  //
  // Nic (DIRECTIVE): "It's a credit against the overall ledger." Credits stopped
  // pre-settling charges, so the charge row stays whole and the credit sits on
  // the account. If the pay-in-full gate did not net it, a tenant holding a
  // credit would be told to pay the gross, refused when they paid what they
  // actually owe, and take a late fee for a debt the LANDLORD owed THEM.
  // S655 (Nic, 10/2): the credit is the PAYER's to use or save. Using it,
  // they pay the bill less the credit; the credit is set aside on the charge
  // (held) until the money clears, and the row is never split.
  it('S655: "Use all" — paying the bill less the credit is accepted, the row stays whole', async () => {
    await seedCharge(f, 800, '2026-09-01')
    const creditId = await seedCredit(f, 300)

    const r = await charge(f, 500, { use: true, expected: 300 })
    expect(r.creditUsed).toBe(300)
    const rows = await db.query<{ status: string; amount: string; is_remainder: boolean }>(
      `SELECT status, amount::text, is_remainder FROM payments WHERE lease_id=$1`, [f.leaseId])
    expect(rows.rows).toHaveLength(1)
    expect(rows.rows[0]).toMatchObject({ status: 'processing', is_remainder: false })
    expect(Number(rows.rows[0].amount)).toBe(800)
    const uses = await db.query<{ status: string; amount: string; remittance_id: string }>(
      `SELECT status, amount::text, remittance_id FROM credit_uses`)
    expect(uses.rows).toHaveLength(1)
    expect(uses.rows[0]).toMatchObject({ status: 'held', remittance_id: r.remittanceId })
    expect(Number(uses.rows[0].amount)).toBe(300)
    expect(await creditLeft(creditId)).toBe(0)
  })

  it('S637: still refuses below the CREDITED figure — the rule holds, the number moved', async () => {
    await seedCharge(f, 800, '2026-09-01')
    await seedCredit(f, 300)
    // 499.99 is still short of the 500 they owe. Pay-in-full is not softened by
    // a credit — it is measured against the right number.
    await expect(charge(f, 499.99, { use: true, expected: 300 })).rejects.toMatchObject({ statusCode: 422 })
  })

  it('refuses every amount below the current charges, however close', async () => {
    await seedCarried(f, 1000, '2026-01-01')
    await seedCharge(f, 800, '2026-09-01')
    for (const amt of [0.01, 100, 799, 799.99]) {
      await expect(charge(f, amt), `$${amt} should be refused`).rejects.toMatchObject({ statusCode: 422 })
    }
  })
})

// ── S622: current charges come first, across the landlord's leases ──
//
// Nic: "they couldn't just pay eight hundred dollars on space b while leaving
// the five hundred dollar lease open." Three Oak Park tenants rent two spaces
// each; paying old arrears on one while current rent sits open on the other
// earns a late fee and starts an eviction clock on the unpaid space.
describe('S622 arrears wait for every space to be current', () => {
  let f: Fixture
  beforeEach(async () => {
    await cleanupAllSchema()
    ;(stripeConnect.createRentPlatformCharge as any).mockClear()
    f = await fixture()
  })

  async function secondSpace(landlordId: string, tenantId: string) {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const propertyId = await seedProperty(c, {
        landlordId, ownerUserId: f.userId, managedByUserId: f.userId })
      const unitId = await seedUnit(c, { propertyId, landlordId, withLateFeeDecision: true })
      const leaseId = await seedLease(c, { unitId, landlordId })
      await seedLeaseTenant(c, { leaseId, tenantId })
      await c.query('COMMIT')
      return { unitId, leaseId }
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
  }

  const openRent = (unitId: string, leaseId: string, amt: number) => db.query(
    `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
     VALUES ($1,$2,$3,$4,'rent',$5,'pending','2026-09-01','RENT')`,
    [unitId, leaseId, f.tenantId, f.landlordId, amt.toFixed(2)])

  it('refuses to touch arrears while the OTHER space still owes rent', async () => {
    const b = await secondSpace(f.landlordId, f.tenantId)
    await seedCharge(f, 300, '2026-09-01')        // space A rent (this lease)
    await seedCarried(f, 1000, '2026-01-01')      // space A arrears
    await openRent(b.unitId, b.leaseId, 500)      // space B rent, unpaid

    // $800 = A's rent plus $500 into arrears, leaving B open. Refused.
    await expect(charge(f, 800)).rejects.toMatchObject({ statusCode: 422 })
    // Paying exactly what this lease owes is still fine.
    const r = await charge(f, 300)
    expect(r.appliedTotal).toBeCloseTo(300, 2)
  })

  it('allows the arrears once every space is current', async () => {
    const b = await secondSpace(f.landlordId, f.tenantId)
    await seedCharge(f, 300, '2026-09-01')
    await seedCarried(f, 1000, '2026-01-01')
    // Space B has nothing open.
    const r = await charge(f, 800)
    expect(r.appliedTotal).toBeCloseTo(800, 2)
  })

  // The trap that makes a portfolio-wide version wrong: a unit in eviction mode
  // cannot be paid at all, so requiring it to be current would permanently bar
  // the tenant from paying arrears anywhere. A floor must always be clearable.
  it('SKIPS a space in eviction hold — an unpayable lease cannot block arrears', async () => {
    const b = await secondSpace(f.landlordId, f.tenantId)
    await seedCharge(f, 300, '2026-09-01')
    await seedCarried(f, 1000, '2026-01-01')
    await openRent(b.unitId, b.leaseId, 500)
    await db.query(`UPDATE units SET payment_block = TRUE WHERE id = $1`, [b.unitId])

    const r = await charge(f, 800)
    expect(r.appliedTotal).toBeCloseTo(800, 2)
  })

  it('does not reach across LANDLORDS — GAM never withholds one landlord’s money for another', async () => {
    const other = await seedOtherLandlordSpace(f)
    await seedCharge(f, 300, '2026-09-01')
    await seedCarried(f, 1000, '2026-01-01')
    await db.query(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
       VALUES ($1,$2,$3,$4,'rent',500,'pending','2026-09-01','RENT')`,
      [other.unitId, other.leaseId, f.tenantId, other.landlordId])

    const r = await charge(f, 800)
    expect(r.appliedTotal).toBeCloseTo(800, 2)
  })

  async function seedOtherLandlordSpace(f: Fixture) {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const ll = await seedLandlord(c)
      const propertyId = await seedProperty(c, {
        landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
      const unitId = await seedUnit(c, { propertyId, landlordId: ll.landlordId, withLateFeeDecision: true })
      const leaseId = await seedLease(c, { unitId, landlordId: ll.landlordId })
      await seedLeaseTenant(c, { leaseId, tenantId: f.tenantId })
      await c.query('COMMIT')
      return { unitId, leaseId, landlordId: ll.landlordId }
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
  }
})


// ── S655 (money plan Step 8): the credit prompt, one lock, nothing split ─────
describe('S655 the portal charge', () => {
  let f: Fixture
  beforeEach(async () => {
    await cleanupAllSchema()
    ;(stripeConnect.createRentPlatformCharge as any).mockClear()
    paymentIntentsCancelMock.mockClear()
    f = await fixture()
  })

  it('Use all $X charges exactly due minus credit; Save it charges the full bill and keeps the credit', async () => {
    await seedCharge(f, 1000, '2026-10-01')
    const creditId = await seedCredit(f, 300)
    const q = await quoteLeaseCharge({ tenantId: f.tenantId, leaseId: f.leaseId, paymentMethodType: 'ach' })
    expect(q.usableCredit).toBe(300)

    // "Use all" must be exactly the bill less the credit — never more beside it.
    await expect(charge(f, 1000, { use: true, expected: 300 })).rejects.toMatchObject({ statusCode: 422 })
    // No choice made: refused, nothing charged.
    await expect(charge(f, 1000)).rejects.toMatchObject({ statusCode: 422 })
    expect(chargedAmounts()).toEqual([])

    const saved = await charge(f, 1000, { use: false, expected: 300 })
    expect(saved.creditUsed).toBe(0)
    expect(chargedAmounts()).toEqual([1006])               // the whole bill + the $6 bank fee
    expect(await creditLeft(creditId)).toBe(300)            // kept for later
    expect((await db.query(`SELECT 1 FROM credit_uses`)).rowCount).toBe(0)
  })

  it('Use all $X: the card is charged the bill less the credit', async () => {
    await seedCharge(f, 1000, '2026-10-01')
    await seedCredit(f, 300)
    await charge(f, 700, { use: true, expected: 300 })
    expect(chargedAmounts()).toEqual([706])
  })

  it('shelved 8: a credit that moved since the screen loaded returns 409 and charges nothing', async () => {
    await seedCharge(f, 1000, '2026-10-01')
    await seedCredit(f, 250)                                // the screen said $300
    await expect(charge(f, 700, { use: true, expected: 300 })).rejects.toMatchObject({ statusCode: 409 })
    expect(chargedAmounts()).toEqual([])
    const rows = await db.query(`SELECT status, stripe_payment_intent_id FROM payments WHERE lease_id=$1`, [f.leaseId])
    expect(rows.rows).toEqual([{ status: 'pending', stripe_payment_intent_id: null }])
    expect((await db.query(`SELECT 1 FROM tenant_remittances`)).rowCount).toBe(0)
  })

  it('a credit covering the whole bill settles with nothing charged', async () => {
    const rent = await seedCharge(f, 500, '2026-10-01')
    const creditId = await seedCredit(f, 600)
    const r = await charge(f, 0, { use: true, expected: 500 })
    expect(r.paidWithCredit).toBe(true)
    expect(r.chargeAmount).toBe(0)
    expect(chargedAmounts()).toEqual([])
    const row = (await db.query<any>(`SELECT status, stripe_payment_intent_id FROM payments WHERE id=$1`, [rent])).rows[0]
    expect(row).toEqual({ status: 'settled', stripe_payment_intent_id: null })
    expect(await creditLeft(creditId)).toBe(100)
    const uses = await db.query<any>(`SELECT status, source FROM credit_uses`)
    expect(uses.rows).toEqual([{ status: 'applied', source: 'portal' }])
  })

  it('shelved 6: rows whose retry is in flight are not payable', async () => {
    const inFlight = await seedCharge(f, 1000, '2026-09-01')
    await db.query(`UPDATE payments SET status='processing', stripe_payment_intent_id='pi_retry_live' WHERE id=$1`, [inFlight])
    const water = (await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
       VALUES ($1,$2,$3,$4,'utility',40,'pending','2026-09-15','UTILITY') RETURNING id`,
      [f.unitId, f.leaseId, f.tenantId, f.landlordId])).rows[0].id
    const q = await quoteLeaseCharge({ tenantId: f.tenantId, leaseId: f.leaseId, paymentMethodType: 'ach' })
    expect(q.required.map(r => r.id)).toEqual([water])
    expect(q.inFlightTotal).toBe(1000)
    await charge(f, 40)
    const r = (await db.query<any>(`SELECT stripe_payment_intent_id FROM payments WHERE id=$1`, [inFlight])).rows[0]
    expect(r.stripe_payment_intent_id).toBe('pi_retry_live')    // never claimed twice
  })

  it('paying over a scheduled retry cancels it and gives back its held credit first', async () => {
    const rent = await seedCharge(f, 1000, '2026-09-01')
    const creditId = await seedCredit(f, 100)
    // A bank pull that bounced and is scheduled to retry, with $100 of credit set aside on it.
    const rem = (await db.query<{ id: string }>(
      `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, unapplied_amount,
                                       payment_method, stripe_payment_intent_id, status)
       VALUES ($1,$2,$3,900,900,0,'ach','pi_old_retry','processing') RETURNING id`,
      [f.tenantId, f.leaseId, f.landlordId])).rows[0].id
    await db.query(
      `UPDATE payments SET status='failed', stripe_payment_intent_id='pi_old_retry',
              next_retry_at = NOW() + INTERVAL '2 days' WHERE id=$1`, [rent])
    await db.query(
      `INSERT INTO credit_uses (tenant_credit_id, payment_id, remittance_id, lease_id, amount, billing_month, source, status)
       VALUES ($1,$2,$3,$4,100,'2026-09-01','portal','held')`, [creditId, rent, rem, f.leaseId])
    expect(await creditLeft(creditId)).toBe(0)

    // The screen counts the held credit as theirs to use: paying now releases it.
    const q = await quoteLeaseCharge({ tenantId: f.tenantId, leaseId: f.leaseId, paymentMethodType: 'ach' })
    expect(q.usableCredit).toBe(100)
    const r = await charge(f, 900, { use: true, expected: 100 })

    const uses = await db.query<any>(
      `SELECT remittance_id, status, release_reason FROM credit_uses ORDER BY held_at`)
    expect(uses.rows).toEqual([
      { remittance_id: rem, status: 'released', release_reason: 'superseded' },
      { remittance_id: r.remittanceId, status: 'held', release_reason: null },
    ])
    const row = (await db.query<any>(`SELECT status, next_retry_at, stripe_payment_intent_id FROM payments WHERE id=$1`, [rent])).rows[0]
    expect(row.status).toBe('processing')
    expect(row.next_retry_at).toBeNull()
    expect(row.stripe_payment_intent_id).toBe(r.paymentIntentId)
    expect(paymentIntentsCancelMock).toHaveBeenCalledWith('pi_old_retry')
  })

  it('bug 5: two charges at once on one lease — the second is refused and no row is stamped twice', async () => {
    await seedCharge(f, 1000, '2026-10-01')
    const results = await Promise.allSettled([charge(f, 1000), charge(f, 1000)])
    const ok = results.filter(r => r.status === 'fulfilled')
    const refused = results.filter(r => r.status === 'rejected') as PromiseRejectedResult[]
    expect(ok).toHaveLength(1)
    expect(refused).toHaveLength(1)
    expect(refused[0].reason).toMatchObject({ statusCode: 409 })
    expect(chargedAmounts()).toHaveLength(1)
    expect((await db.query(`SELECT 1 FROM tenant_remittances`)).rowCount).toBe(1)
    expect((await db.query(`SELECT 1 FROM remittance_applications`)).rowCount).toBe(1)
  })

  it('co-tenants paying one lease at once are serialized', async () => {
    await seedCharge(f, 1000, '2026-10-01')
    const c = await db.connect()
    let roommate = ''
    try {
      await c.query('BEGIN')
      roommate = await seedTenant(c)
      await c.query(`UPDATE tenants SET stripe_customer_id='cus_roommate' WHERE id=$1`, [roommate])
      await seedLeaseTenant(c, { leaseId: f.leaseId, tenantId: roommate, role: 'co_tenant' })
      await c.query('COMMIT')
    } finally { c.release() }
    const pay = (tenantId: string) => chargeLeaseBalance({
      tenantId, leaseId: f.leaseId, amount: 1000, paymentMethodId: 'pm_test', paymentMethodType: 'ach', source: 'portal',
    })
    const results = await Promise.allSettled([pay(f.tenantId), pay(roommate)])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(chargedAmounts()).toHaveLength(1)
  })

  it('rows never split; only a carried balance takes a partial', async () => {
    await seedCharge(f, 800, '2026-09-01')
    await seedCarried(f, 1000, '2026-01-01')
    await seedCredit(f, 300)
    // Credit pays part of the rent row: the row stays one row.
    await charge(f, 500, { use: true, expected: 300 })
    const splits = await db.query(`SELECT type FROM payments WHERE lease_id=$1 AND is_remainder`, [f.leaseId])
    expect(splits.rows).toEqual([])
    // Money over the bill (no credit used) reaches the old balance — the one
    // charge that may be paid in part.
    await cleanupAllSchema()
    f = await fixture()
    await seedCharge(f, 800, '2026-09-01')
    await seedCarried(f, 1000, '2026-01-01')
    await charge(f, 950)
    const parts = await db.query<any>(`SELECT type, status, amount::text AS amount FROM payments WHERE lease_id=$1 AND is_remainder`, [f.leaseId])
    expect(parts.rows).toEqual([{ type: 'carried_balance', status: 'pending', amount: '850.00' }])
  })

  it('the fee is on the money part only', async () => {
    await seedCharge(f, 1000, '2026-10-01')
    await seedCredit(f, 400)
    const r = await charge(f, 600, { use: true, expected: 400 }, 'card')
    const fee = stripeConnect.computePlatformCut({ amount: 600, paymentMethod: 'card', cardCountry: 'US' })
    expect(r.processingFee).toBeCloseTo(fee, 2)
    expect(chargedAmounts()[0]).toBeCloseTo(600 + fee, 2)
    const rem = (await db.query<any>(`SELECT amount::float AS amount, processing_fee_amount::float AS fee FROM tenant_remittances`)).rows[0]
    expect(rem.amount).toBe(600)
    expect(rem.fee).toBeCloseTo(fee, 2)
  })

  it('Pay all splits general credit oldest bill first and each charge carries its share', async () => {
    // A second space with the same landlord, its bill a month OLDER.
    const c = await db.connect()
    let leaseB = '', unitB = ''
    try {
      await c.query('BEGIN')
      unitB = await seedUnit(c, { propertyId: f.propertyId, landlordId: f.landlordId, withLateFeeDecision: true })
      leaseB = await seedLease(c, { unitId: unitB, landlordId: f.landlordId, rentAmount: 300 })
      await seedLeaseTenant(c, { leaseId: leaseB, tenantId: f.tenantId })
      await c.query('COMMIT')
    } finally { c.release() }
    await seedCharge(f, 400, '2026-10-01')
    await db.query(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
       VALUES ($1,$2,$3,$4,'rent',300,'pending','2026-09-01','RENT')`, [unitB, leaseB, f.tenantId, f.landlordId])
    const general = await seedCredit(f, 500, { leaseId: null })

    const qa = await quoteLeaseCharge({ tenantId: f.tenantId, leaseId: f.leaseId, paymentMethodType: 'ach' })
    const qb = await quoteLeaseCharge({ tenantId: f.tenantId, leaseId: leaseB, paymentMethodType: 'ach' })
    expect(qb.usableCredit).toBe(300)                      // the older bill first, whole
    expect(qa.usableCredit).toBe(200)                      // the rest — never counted twice
    await charge(f, 200, { use: true, expected: 200 })
    await chargeLeaseBalance({ tenantId: f.tenantId, leaseId: leaseB, amount: 0, paymentMethodType: 'ach',
      paymentMethodId: 'pm_test', source: 'portal', credit: { use: true, expected: 300 } })
    const uses = await db.query<any>(`SELECT lease_id, amount::text AS amount, status FROM credit_uses ORDER BY amount`)
    expect(uses.rows).toEqual([
      { lease_id: f.leaseId, amount: '200.00', status: 'held' },
      { lease_id: leaseB, amount: '300.00', status: 'applied' },  // covered whole: nothing charged
    ])
    expect(await creditLeft(general)).toBe(0)
  })

  // Fix round 2: a saved credit does not change the charge, so the figure it
  // was shown with is not compared. Pay all charges one lease at a time; once
  // the first lease's rows are claimed, a general credit's share of the next
  // lease grows — Save must still charge both.
  it('Pay all with Save on both leases charges both', async () => {
    const c = await db.connect()
    let leaseB = '', unitB = ''
    try {
      await c.query('BEGIN')
      unitB = await seedUnit(c, { propertyId: f.propertyId, landlordId: f.landlordId, withLateFeeDecision: true })
      leaseB = await seedLease(c, { unitId: unitB, landlordId: f.landlordId, rentAmount: 300 })
      await seedLeaseTenant(c, { leaseId: leaseB, tenantId: f.tenantId })
      await c.query('COMMIT')
    } finally { c.release() }
    await seedCharge(f, 400, '2026-10-01')
    await db.query(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
       VALUES ($1,$2,$3,$4,'rent',300,'pending','2026-09-01','RENT')`, [unitB, leaseB, f.tenantId, f.landlordId])
    const general = await seedCredit(f, 500, { leaseId: null })
    // What the screen showed: B (older) $300, A $200.
    const qa = await quoteLeaseCharge({ tenantId: f.tenantId, leaseId: f.leaseId, paymentMethodType: 'ach' })
    const qb = await quoteLeaseCharge({ tenantId: f.tenantId, leaseId: leaseB, paymentMethodType: 'ach' })
    expect([qa.usableCredit, qb.usableCredit]).toEqual([200, 300])
    await chargeLeaseBalance({ tenantId: f.tenantId, leaseId: leaseB, amount: 300, paymentMethodType: 'ach',
      paymentMethodId: 'pm_test', source: 'portal', credit: { use: false, expected: 300 } })
    // A's share is $400 now; the payer saved it, so the $200 shown changes nothing.
    const a = await charge(f, 400, { use: false, expected: 200 })
    expect(a.creditUsed).toBe(0)
    expect(chargedAmounts()).toEqual([306, 406])
    expect(await creditLeft(general)).toBe(500)
    expect((await db.query(`SELECT 1 FROM credit_uses`)).rowCount).toBe(0)
  })

  it('autopay with use-my-credit off is not refused when the credit figure moves', async () => {
    await seedCharge(f, 1000, '2026-10-01')
    const creditId = await seedCredit(f, 250)              // autopay's quote a moment ago said $300
    const r = await chargeLeaseBalance({
      tenantId: f.tenantId, leaseId: f.leaseId, amount: 1000, paymentMethodId: 'pm_test',
      paymentMethodType: 'ach', source: 'autopay', credit: { use: false, expected: 300 },
    })
    expect(r.status).toBe('processing')
    expect(chargedAmounts()).toEqual([1006])
    expect(await creditLeft(creditId)).toBe(250)
    // Using it still depends on the figure: a moved credit is asked again.
    await cleanupAllSchema()
    f = await fixture()
    await seedCharge(f, 1000, '2026-10-01')
    await seedCredit(f, 250)
    await expect(chargeLeaseBalance({
      tenantId: f.tenantId, leaseId: f.leaseId, amount: 700, paymentMethodId: 'pm_test',
      paymentMethodType: 'ach', source: 'autopay', credit: { use: true, expected: 300 },
    })).rejects.toBeInstanceOf(CreditChangedError)
    expect(chargedAmounts()).toEqual([1006])
  })

  it('reopened rows are never paid by credit', async () => {
    const original = await seedCharge(f, 1000, '2026-09-01')
    await db.query(`UPDATE payments SET status='returned' WHERE id=$1`, [original])
    const rev = (await db.query<{ id: string }>(
      `INSERT INTO payment_reversals (payment_id, landlord_id, tenant_id, lease_id, reversal_type, reversed_amount,
                                      stripe_event_id, raw_event)
       VALUES ($1,$2,$3,$4,'card_dispute',1000,'evt_reopen','{}'::jsonb) RETURNING id`,
      [original, f.landlordId, f.tenantId, f.leaseId])).rows[0].id
    await db.query(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, reversal_id, is_remainder)
       VALUES ($1,$2,$3,$4,'rent',1000,'pending','2026-09-01','RENT',$5,TRUE)`,
      [f.unitId, f.leaseId, f.tenantId, f.landlordId, rev])
    const creditId = await seedCredit(f, 500)
    const q = await quoteLeaseCharge({ tenantId: f.tenantId, leaseId: f.leaseId, paymentMethodType: 'ach' })
    expect(q.requiredTotal).toBe(1000)
    expect(q.usableCredit).toBe(0)
    await charge(f, 1000)                                  // no choice asked: no credit can pay it
    expect((await db.query(`SELECT 1 FROM credit_uses`)).rowCount).toBe(0)
    expect(await creditLeft(creditId)).toBe(500)
  })

  it('ACH is refused while the tenant is suspended', async () => {
    await seedCharge(f, 1000, '2026-10-01')
    await db.query(`UPDATE tenants SET ach_suspended_at = NOW() WHERE id = $1`, [f.tenantId])
    await expect(charge(f, 1000)).rejects.toMatchObject({ statusCode: 409 })
    expect(chargedAmounts()).toEqual([])
    const r = await charge(f, 1000, null, 'card')
    expect(r.status).toBe('processing')
  })

  // Fix round 1: nothing is charged, so no card or bank is needed.
  it('a bill the credit pays in full settles with no card or bank on file and bank payments paused', async () => {
    const rent = await seedCharge(f, 500, '2026-10-01')
    await seedCredit(f, 600)
    await db.query(`UPDATE tenants SET stripe_customer_id = NULL, ach_suspended_at = NOW() WHERE id = $1`, [f.tenantId])
    const r = await chargeLeaseBalance({
      tenantId: f.tenantId, leaseId: f.leaseId, amount: 0,
      paymentMethodType: 'ach', source: 'autopay', credit: { use: true, expected: 500 },
    })
    expect(r).toMatchObject({ status: 'settled', paidWithCredit: true, chargeAmount: 0 })
    expect(chargedAmounts()).toEqual([])
    expect((await db.query<any>(`SELECT status FROM payments WHERE id=$1`, [rent])).rows[0].status).toBe('settled')
  })

  it('a payment answer sent without the credit figure it answered is refused and charges nothing', async () => {
    await seedCharge(f, 1000, '2026-10-01')
    const creditId = await seedCredit(f, 300)
    await expect(charge(f, 700, { use: true })).rejects.toMatchObject({ statusCode: 422 })
    await expect(charge(f, 1000, { use: false })).rejects.toMatchObject({ statusCode: 422 })
    expect(chargedAmounts()).toEqual([])
    expect(await creditLeft(creditId)).toBe(300)
    expect((await db.query(`SELECT 1 FROM tenant_remittances`)).rowCount).toBe(0)
  })

  // Fix round 1 (probe B): the counter reader holds an authorization; if the
  // bill moved so the credit now covers all of it, settling from credit would
  // leave the card held and tell the desk it was captured.
  it('with a reader authorization, a bill the credit now covers is refused — nothing settled, no credit spent', async () => {
    const rent = await seedCharge(f, 500, '2026-10-01')
    const creditId = await seedCredit(f, 600)
    await expect(chargeLeaseBalance({
      tenantId: f.tenantId, leaseId: f.leaseId, chargeEverything: true,
      paymentMethodType: 'card_present', source: 'front_desk_reader', credit: { use: true, expected: 500 },
      existingIntent: { id: 'pi_reader_hold', amountCents: 2643, capture: true },
    })).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/credit now covers this whole bill/) })
    expect((await db.query<any>(`SELECT status FROM payments WHERE id=$1`, [rent])).rows[0].status).toBe('pending')
    expect(await creditLeft(creditId)).toBe(600)
    expect((await db.query(`SELECT 1 FROM credit_uses`)).rowCount).toBe(0)
  })

  it('a reader authorization already booked is never booked a second time', async () => {
    await seedCharge(f, 500, '2026-10-01')
    await db.query(
      `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, unapplied_amount,
                                       payment_method, stripe_payment_intent_id, status)
       VALUES ($1,$2,$3,500,500,0,'card','pi_reader_done','processing')`, [f.tenantId, f.leaseId, f.landlordId])
    await expect(chargeLeaseBalance({
      tenantId: f.tenantId, leaseId: f.leaseId, chargeEverything: true,
      paymentMethodType: 'card_present', source: 'front_desk_reader',
      existingIntent: { id: 'pi_reader_done', amountCents: 52305, capture: true },
    })).rejects.toMatchObject({ statusCode: 409, message: 'This card payment is already recorded.' })
    expect((await db.query(`SELECT 1 FROM tenant_remittances`)).rowCount).toBe(1)
  })

  // Wave A hand-off (HIGH): the ledger takes a held use on a row in flight only
  // when the use's receipt carries that row's own intent, so the charge sets
  // the credit aside while the rows are still open — before they are claimed.
  it('a portal charge with Use all writes held uses on its receipt, and clearing turns them applied once', async () => {
    const rent = await seedCharge(f, 1000, '2026-10-01')
    const creditId = await seedCredit(f, 300)
    const r = await charge(f, 700, { use: true, expected: 300 }, 'card')
    const held = await db.query<any>(`SELECT status, remittance_id, payment_id, amount::float AS amount FROM credit_uses`)
    expect(held.rows).toEqual([{ status: 'held', remittance_id: r.remittanceId, payment_id: rent, amount: 300 }])
    const rem = (await db.query<any>(`SELECT stripe_payment_intent_id FROM tenant_remittances WHERE id=$1`, [r.remittanceId])).rows[0]
    expect(rem.stripe_payment_intent_id).toBe(r.paymentIntentId)
    expect(await creditLeft(creditId)).toBe(0)                 // set aside: nobody else can spend it

    // payment_intent.succeeded (Step 10 wires it): the rows settle and the
    // receipt's held credit becomes spent — in one transaction, once.
    const { applyHeldForRemittance } = await import('./creditUse')
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      await c.query(`UPDATE payments SET status='settled', settled_at=NOW() WHERE stripe_payment_intent_id=$1`, [r.paymentIntentId])
      expect(await applyHeldForRemittance(c, r.remittanceId)).toBe(300)
      expect(await applyHeldForRemittance(c, r.remittanceId)).toBe(0)   // a replay applies nothing
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
    const applied = await db.query<any>(`SELECT status FROM credit_uses`)
    expect(applied.rows).toEqual([{ status: 'applied' }])
    expect(await creditLeft(creditId)).toBe(0)                 // spent once, not twice
    const row = (await db.query<any>(`SELECT issued_credit_amount::float AS issued FROM payments WHERE id=$1`, [rent])).rows[0]
    expect(row.issued).toBe(300)                               // the landlord's credit: never their income
  })

  it('the intent carries the remittance, the lease and the tenant', async () => {
    await seedCharge(f, 1000, '2026-10-01')
    await charge(f, 1000)
    const md = (stripeConnect.createRentPlatformCharge as any).mock.calls[0][0].metadata
    expect(md).toMatchObject({ tenant_id: f.tenantId, gam_lease_id: f.leaseId, gam_charge_source: 'portal' })
    expect(md.gam_remittance_id).toBeTruthy()
  })
})

// ─── Fix pass (Step 8): a card the bank wants confirmed, and one key per press ─
// A charge Stripe did not take or start ('requires_action': 3-D Secure, or a
// bank still verifying) used to leave every row of the bill 'processing' with
// nothing able to finish or release it. Now it is canceled and nothing is
// written. And the tenant's Pay press may carry a key, so the same press sent
// again is never a second charge.
describe('Step 8 fix pass: charges Stripe did not take, and the Pay key', () => {
  let f: Fixture
  const createMock = () => stripeConnect.createRentPlatformCharge as any
  beforeEach(async () => {
    await cleanupAllSchema()
    createMock().mockClear()
    paymentIntentsCancelMock.mockClear()
    f = await fixture()
  })

  const remittanceCount = async () =>
    Number((await db.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM tenant_remittances`)).rows[0].n)

  // decisions.md #48.4: renamed — this is now only a payer who cannot see the
  // bank's window (no confirmOnScreen: the tenant assistant). The pay screen
  // keeps the charge and confirms it on the spot (the 3-D Secure block below).
  it('a card its bank wants confirmed, where nobody can confirm it, is canceled, nothing is written, the payer is pointed to the Payments page, and the bill stays payable', async () => {
    const rent = await seedCharge(f, 1000, '2026-10-01')
    createMock().mockImplementationOnce(async () => ({ id: 'pi_needs_3ds', status: 'requires_action' }))
    const err: any = await charge(f, 1000, null, 'card').catch(e => e)
    expect(err.statusCode).toBe(402)
    expect(err.message).toMatch(/confirm this payment/)
    expect(err.message).toMatch(/Nothing was charged/)
    expect(err.message).toMatch(/Payments page, where you can confirm it/)
    expect(err.intentStatus).toBe('requires_action')
    expect(paymentIntentsCancelMock).toHaveBeenCalledWith('pi_needs_3ds')
    const row = (await db.query<any>(`SELECT status, stripe_payment_intent_id FROM payments WHERE id=$1`, [rent])).rows[0]
    expect(row).toEqual({ status: 'pending', stripe_payment_intent_id: null })
    expect(await remittanceCount()).toBe(0)
    // Paying again another way works at once — the bill was never held.
    const r = await charge(f, 1000)
    expect(r.status).toBe('processing')
    expect((await db.query<any>(`SELECT status FROM payments WHERE id=$1`, [rent])).rows[0].status).toBe('processing')
  })

  it('credit the payer chose to use is not set aside by a card that was not taken', async () => {
    await seedCharge(f, 1000, '2026-10-01')
    const creditId = await seedCredit(f, 300)
    createMock().mockImplementationOnce(async () => ({ id: 'pi_needs_3ds_c', status: 'requires_action' }))
    await expect(charge(f, 700, { use: true, expected: 300 }, 'card')).rejects.toMatchObject({ statusCode: 402 })
    expect(await creditLeft(creditId)).toBe(300)
    expect(Number((await db.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM credit_uses`)).rows[0].n)).toBe(0)
  })

  it('a bank that still needs verifying is told so, and nothing is written', async () => {
    const rent = await seedCharge(f, 1000, '2026-10-01')
    createMock().mockImplementationOnce(async () => ({ id: 'pi_bank_verify', status: 'requires_action' }))
    const err: any = await charge(f, 1000).catch(e => e)
    expect(err.statusCode).toBe(402)
    expect(err.message).toMatch(/still needs to be verified/)
    expect(paymentIntentsCancelMock).toHaveBeenCalledWith('pi_bank_verify')
    expect((await db.query<any>(`SELECT status FROM payments WHERE id=$1`, [rent])).rows[0].status).toBe('pending')
  })

  it('autopay reads a card its bank wants confirmed as the card side, never GAM\'s', async () => {
    await seedCharge(f, 1000, '2026-10-01')
    createMock().mockImplementationOnce(async () => ({ id: 'pi_autopay_3ds', status: 'requires_action' }))
    const err: any = await chargeLeaseBalance({
      tenantId: f.tenantId, leaseId: f.leaseId, paymentMethodId: 'pm_test', paymentMethodType: 'card',
      source: 'autopay', chargeEverything: true,
    }).catch(e => e)
    expect(err.statusCode).toBe(402)
    expect(err.message).toMatch(/autopay cannot do/)
    expect(err.message).toMatch(/pay it on the Payments page/)
    const { classifyAutopayFailure } = await import('../jobs/autopayRunner')
    expect(await classifyAutopayFailure(err, f.leaseId)).toBe('payment_method')
  })

  it('paying over a scheduled retry with a card that is not taken leaves the retry and its credit as they were', async () => {
    const rent = await seedCharge(f, 1000, '2026-09-01')
    const creditId = await seedCredit(f, 100)
    const rem = (await db.query<{ id: string }>(
      `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, unapplied_amount,
                                       payment_method, stripe_payment_intent_id, status)
       VALUES ($1,$2,$3,900,900,0,'ach','pi_retry_kept','processing') RETURNING id`,
      [f.tenantId, f.leaseId, f.landlordId])).rows[0].id
    await db.query(
      `UPDATE payments SET status='failed', stripe_payment_intent_id='pi_retry_kept',
              next_retry_at = NOW() + INTERVAL '2 days' WHERE id=$1`, [rent])
    await db.query(
      `INSERT INTO credit_uses (tenant_credit_id, payment_id, remittance_id, lease_id, amount, billing_month, source, status)
       VALUES ($1,$2,$3,$4,100,'2026-09-01','portal','held')`, [creditId, rent, rem, f.leaseId])
    createMock().mockImplementationOnce(async () => ({ id: 'pi_card_3ds', status: 'requires_action' }))
    await expect(charge(f, 900, { use: true, expected: 100 }, 'card')).rejects.toMatchObject({ statusCode: 402 })
    // Only the new charge is canceled — never the retry it would have replaced.
    expect(paymentIntentsCancelMock.mock.calls.map(c => c[0])).toEqual(['pi_card_3ds'])
    const row = (await db.query<any>(`SELECT status, stripe_payment_intent_id, next_retry_at FROM payments WHERE id=$1`, [rent])).rows[0]
    expect(row.status).toBe('failed')
    expect(row.stripe_payment_intent_id).toBe('pi_retry_kept')
    expect(row.next_retry_at).not.toBeNull()
    const uses = (await db.query<any>(`SELECT status FROM credit_uses`)).rows
    expect(uses).toEqual([{ status: 'held' }])
  })

  it('a charge that cannot be canceled still writes nothing, and an admin is told to cancel it', async () => {
    const rent = await seedCharge(f, 1000, '2026-10-01')
    createMock().mockImplementationOnce(async () => ({ id: 'pi_stuck_3ds', status: 'requires_action' }))
    paymentIntentsCancelMock.mockImplementationOnce(async () => { throw new Error('stripe down') })
    await expect(charge(f, 1000, null, 'card')).rejects.toMatchObject({ statusCode: 402 })
    expect((await db.query<any>(`SELECT status FROM payments WHERE id=$1`, [rent])).rows[0].status).toBe('pending')
    expect(await remittanceCount()).toBe(0)
    const alerts = (await db.query<any>(
      `SELECT context->>'stripe_payment_intent_id' AS pi FROM admin_notifications WHERE category = 'rent_charge_not_canceled'`)).rows
    expect(alerts).toEqual([{ pi: 'pi_stuck_3ds' }])
  })

  it('one key per press goes to Stripe, scoped to this tenant and this lease', async () => {
    await seedCharge(f, 1000, '2026-10-01')
    await chargeLeaseBalance({
      tenantId: f.tenantId, leaseId: f.leaseId, amount: 1000,
      paymentMethodId: 'pm_test', paymentMethodType: 'ach', source: 'portal', idempotencyKey: 'press_abc12345',
    })
    expect(createMock().mock.calls[0][0].idempotencyKey)
      .toBe(`gam_balance_${f.tenantId}_${f.leaseId}_press_abc12345`)
  })

  it('a charge sent with no key sends none to Stripe', async () => {
    await seedCharge(f, 1000, '2026-10-01')
    await charge(f, 1000)
    expect(createMock().mock.calls[0][0].idempotencyKey).toBeUndefined()
  })

  it('the same press sent again is refused by its key, and nothing is written', async () => {
    const rent = await seedCharge(f, 1000, '2026-10-01')
    createMock().mockImplementationOnce(async () => {
      throw Object.assign(new Error('Keys for idempotent requests can only be used with the same parameters'),
        { type: 'StripeIdempotencyError', rawType: 'idempotency_error' })
    })
    const err: any = await chargeLeaseBalance({
      tenantId: f.tenantId, leaseId: f.leaseId, amount: 1000,
      paymentMethodId: 'pm_test', paymentMethodType: 'ach', source: 'portal', idempotencyKey: 'press_sent_twice',
    }).catch(e => e)
    expect(err.statusCode).toBe(409)
    expect(err.message).toMatch(/already sent once/)
    expect((await db.query<any>(`SELECT status, stripe_payment_intent_id FROM payments WHERE id=$1`, [rent])).rows[0])
      .toEqual({ status: 'pending', stripe_payment_intent_id: null })
    expect(await remittanceCount()).toBe(0)
  })
})

// 10/4: credit another bank payment still holds is left alone and the rest of
// the bill is charged (the renewal cases are in jobs/renewalCreditHandoff.test.ts
// and jobs/autopayRunner.test.ts). The payer is told in one sentence.
describe('credit another payment still holds', () => {
  it('the waiting sentence names the held part in plain words, and says nothing when none is held', () => {
    expect(creditWaitingSentence(5000)).toBe('$50.00 of your credit is set aside for an earlier bank payment that has not cleared yet. If that payment clears, the credit goes toward that earlier bill. If it does not, the credit comes back to your account.')
    expect(creditWaitingSentence(0)).toBeNull()
  })

  it('a bill with no held credit quotes nothing waiting', async () => {
    await cleanupAllSchema()
    const f = await fixture()
    await seedCharge(f, 1000, '2026-10-01')
    await seedCredit(f, 300)
    const q = await quoteLeaseCharge({ tenantId: f.tenantId, leaseId: f.leaseId, useCredit: true, paymentMethodType: 'ach' })
    expect(q.usableCredit).toBe(300)
    expect(q.creditStillHeldElsewhere).toBe(0)
    expect(q.creditWaitingNote).toBeNull()
  })
})

// Fix pass 3: the figures the server writes read like the pay screen around
// them (formatCurrency), above $999.99 too.
describe('money in the server\'s sentences', () => {
  it('the waiting sentence writes $1,234.00 with a thousands comma, as the pay screen does', () => {
    expect(creditWaitingSentence(123400)).toBe('$1,234.00 of your credit is set aside for an earlier bank payment that has not cleared yet. If that payment clears, the credit goes toward that earlier bill. If it does not, the credit comes back to your account.')
  })

  it('"Your credit changed" writes $1,500.00 with a thousands comma', () => {
    expect(new CreditChangedError(150000).message).toBe("Your credit changed — it's now $1,500.00. Look at the bill again and choose how to pay.")
  })
})

// Fix pass 3: on one bill every dollar of "You have $X credit" is explained —
// what pays this bill, what another bank payment holds, and the rest: kept for
// a bill on another lease, or left on the account for a later bill.
describe('where the rest of the credit goes (one bill)', () => {
  beforeAll(async () => {
    await db.query(
      `INSERT INTO platform_processing_rates
         (payment_method, customer_facing_flat, customer_facing_percent, stripe_cost_flat, stripe_cost_percent)
       SELECT 'ach', 6, 0, 0, 0.5
        WHERE NOT EXISTS (SELECT 1 FROM platform_processing_rates WHERE payment_method = 'ach')`)
  })

  /** A second lease for the same tenant with the same landlord, on its own unit. */
  async function secondLease(f: Fixture): Promise<{ unitId: string; leaseId: string }> {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const unitId = await seedUnit(c, { propertyId: f.propertyId, landlordId: f.landlordId, withLateFeeDecision: true })
      const leaseId = await seedLease(c, { unitId, landlordId: f.landlordId, rentAmount: 300 })
      await seedLeaseTenant(c, { leaseId, tenantId: f.tenantId })
      await c.query('COMMIT')
      return { unitId, leaseId }
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
  }
  const quote = (f: Fixture, leaseId = f.leaseId) =>
    quoteLeaseCharge({ tenantId: f.tenantId, leaseId, useCredit: true, paymentMethodType: 'ach' })

  it('the rest sentence names each part in plain words, and says nothing when nothing is left over', () => {
    expect(creditRestSentence({ laterCents: 30000 })).toBe('$300.00 of your credit stays on your account for a later bill.')
    expect(creditRestSentence({ elsewhereCents: 2000 })).toBe('$20.00 of your credit is kept for a bill on another lease.')
    expect(creditRestSentence({ elsewhereCents: 2000, laterCents: 1000 })).toBe('$20.00 of your credit is kept for a bill on another lease, and $10.00 stays on your account for a later bill.')
    expect(creditRestSentence({ heldMoreCents: 5000, waitingCents: 3000 })).toBe('Another $50.00 is set aside for an earlier bank payment the same way.')
    expect(creditRestSentence({ heldMoreCents: 5000 })).toBe(creditWaitingSentence(5000))
    expect(creditRestSentence({ laterCents: 123400 })).toBe('$1,234.00 of your credit stays on your account for a later bill.')
    expect(creditRestSentence({})).toBeNull()
  })

  it('credit more than the bill: the rest stays on the account for a later bill', async () => {
    await cleanupAllSchema()
    const f = await fixture()
    await seedCharge(f, 1000, '2026-10-01')
    await seedCredit(f, 1300)
    const q = await quote(f)
    expect(q.creditOnFile).toBe(1300)
    expect(q.usableCredit).toBe(1000)
    expect(q.creditStillHeldElsewhere).toBe(0)
    expect(q.creditKeptForLater).toBe(300)
    expect(q.creditKeptElsewhere).toBe(0)
    expect(q.creditRestNote).toBe('$300.00 of your credit stays on your account for a later bill.')
  })

  it('a credit tied to another lease is kept for that lease\'s bill', async () => {
    await cleanupAllSchema()
    const f = await fixture()
    const b = await secondLease(f)
    await seedCharge(f, 1000, '2026-10-01')
    await seedCredit(f, 300)
    await seedCredit(f, 200, { leaseId: b.leaseId })
    const q = await quote(f)
    expect(q.creditOnFile).toBe(500)
    expect(q.usableCredit).toBe(300)
    expect(q.creditKeptElsewhere).toBe(200)
    expect(q.creditKeptForLater).toBe(0)
    expect(q.creditRestNote).toBe('$200.00 of your credit is kept for a bill on another lease.')
  })

  it('a general credit goes first to an older bill on another lease: that part is kept for it', async () => {
    await cleanupAllSchema()
    const f = await fixture()
    const b = await secondLease(f)
    await seedCharge(f, 1000, '2026-10-01')
    await db.query(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
       VALUES ($1,$2,$3,$4,'rent',100,'pending','2026-09-01','RENT')`, [b.unitId, b.leaseId, f.tenantId, f.landlordId])
    await seedCredit(f, 150, { leaseId: null })
    const q = await quote(f)
    expect(q.creditOnFile).toBe(150)
    expect(q.usableCredit).toBe(50)
    expect(q.creditKeptElsewhere).toBe(100)
    expect(q.creditRestNote).toBe('$100.00 of your credit is kept for a bill on another lease.')
    // The parts add up to the credit on file.
    expect(q.usableCredit + q.creditStillHeldElsewhere + q.creditAlsoHeld + q.creditKeptElsewhere + q.creditKeptForLater).toBe(q.creditOnFile)
  })

  it('the month\'s paid-ahead draw limit: the rest stays on the account for a later bill', async () => {
    await cleanupAllSchema()
    const f = await fixture()
    await db.query(`UPDATE leases SET prepaid_monthly_draw = 400 WHERE id = $1`, [f.leaseId])
    await seedCharge(f, 1000, '2026-10-01')
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      await createPaidAhead(c, { leaseId: f.leaseId, tenantId: f.tenantId, amount: 1000, fundedBy: 'landlord', receivedAt: '2026-09-20T12:00:00Z' })
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
    const q = await quote(f)
    expect(q.creditOnFile).toBe(1000)
    expect(q.usableCredit).toBe(400)
    expect(q.creditKeptForLater).toBe(600)
    expect(q.creditRestNote).toBe('$600.00 of your credit stays on your account for a later bill.')
  })

  it('a "Pay all" run figure carries no rest sentence (the run\'s credit sentence names only what the bills use)', async () => {
    await cleanupAllSchema()
    const f = await fixture()
    const b = await secondLease(f)
    await seedCharge(f, 1000, '2026-10-01')
    await db.query(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
       VALUES ($1,$2,$3,$4,'rent',100,'pending','2026-09-01','RENT')`, [b.unitId, b.leaseId, f.tenantId, f.landlordId])
    await seedCredit(f, 150, { leaseId: null })
    const q = await quoteLeaseCharge({ tenantId: f.tenantId, leaseId: f.leaseId, useCredit: true, paymentMethodType: 'ach', afterLeaseIds: [b.leaseId] })
    expect(q.usableCredit).toBe(50)
    expect(q.creditRestNote).toBeNull()
  })
})

// ─── decisions.md #48.4: cards whose bank asks the cardholder to confirm ─────
describe('3-D Secure: confirmed on the pay screen, off-session on autopay', () => {
  let f: Fixture
  const createMock = () => stripeConnect.createRentPlatformCharge as any
  beforeEach(async () => {
    await cleanupAllSchema()
    createMock().mockClear()
    paymentIntentsCancelMock.mockClear()
    f = await fixture()
  })
  const onScreen = (amount: number, credit: CreditChoiceInput | null = null) => chargeLeaseBalance({
    tenantId: f.tenantId, leaseId: f.leaseId, amount, paymentMethodId: 'pm_test', paymentMethodType: 'card',
    source: 'portal', credit, confirmOnScreen: true,
  })
  const autopay = (method: 'card' | 'ach') => chargeLeaseBalance({
    tenantId: f.tenantId, leaseId: f.leaseId, paymentMethodId: 'pm_test', paymentMethodType: method,
    source: 'autopay', chargeEverything: true,
  })

  it('on the pay screen the charge is kept: rows held on it, credit set aside, the client secret and the release time handed back', async () => {
    const rent = await seedCharge(f, 1000, '2026-10-01')
    const creditId = await seedCredit(f, 300)
    createMock().mockImplementationOnce(async () => ({ id: 'pi_screen', status: 'requires_action', client_secret: 'pi_screen_secret_9' }))
    const before = Date.now()
    const r = await onScreen(700, { use: true, expected: 300 })
    expect(r.status).toBe('requires_action')
    expect(r.clientSecret).toBe('pi_screen_secret_9')
    const by = new Date(r.confirmBy!).getTime() - before
    expect(by).toBeGreaterThanOrEqual(CARD_CONFIRM_HOLD_MINUTES * 60_000 - 5_000)
    expect(by).toBeLessThanOrEqual(CARD_CONFIRM_HOLD_MINUTES * 60_000 + 5_000)
    expect(paymentIntentsCancelMock).not.toHaveBeenCalled()
    expect((await db.query<any>(`SELECT status, stripe_payment_intent_id FROM payments WHERE id=$1`, [rent])).rows[0])
      .toEqual({ status: 'processing', stripe_payment_intent_id: 'pi_screen' })
    expect((await db.query<any>(`SELECT status FROM tenant_remittances WHERE stripe_payment_intent_id='pi_screen'`)).rows)
      .toEqual([{ status: 'processing' }])
    expect((await db.query<any>(`SELECT status, amount::text AS amount FROM credit_uses WHERE tenant_credit_id=$1`, [creditId])).rows)
      .toEqual([{ status: 'held', amount: '300.00' }])
  })

  // Review (pay7 money-3), reported to Nic and NOT decided: paying by card on
  // the pay screen over a scheduled bank retry replaces the retry when the
  // charge is made — before the cardholder answers their bank. If they then
  // abandon the bank's window, the release opens the bill again with no retry
  // scheduled (the bank pull is not re-presented automatically). No money is
  // counted twice: the retry's set-aside credit came back when it was
  // replaced, and the card's when it was released. This pins today's outcome
  // until Nic says whether the retry should come back.
  it('an abandoned pay-screen card over a scheduled bank retry: the bill opens again with no retry scheduled, and all the credit is back (pending Nic)', async () => {
    const rent = await seedCharge(f, 1000, '2026-09-01')
    const creditId = await seedCredit(f, 100)
    const rem = (await db.query<{ id: string }>(
      `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, unapplied_amount,
                                       payment_method, stripe_payment_intent_id, status)
       VALUES ($1,$2,$3,900,900,0,'ach','pi_retry_over','processing') RETURNING id`,
      [f.tenantId, f.leaseId, f.landlordId])).rows[0].id
    await db.query(
      `UPDATE payments SET status='failed', stripe_payment_intent_id='pi_retry_over',
              next_retry_at = NOW() + INTERVAL '2 days' WHERE id=$1`, [rent])
    await db.query(
      `INSERT INTO credit_uses (tenant_credit_id, payment_id, remittance_id, lease_id, amount, billing_month, source, status)
       VALUES ($1,$2,$3,$4,100,'2026-09-01','portal','held')`, [creditId, rent, rem, f.leaseId])
    createMock().mockImplementationOnce(async () => ({ id: 'pi_screen_over', status: 'requires_action', client_secret: 'pi_screen_over_secret' }))
    const r = await onScreen(900, { use: true, expected: 100 })
    expect(r.status).toBe('requires_action')
    // The retry is replaced as soon as the card charge is made.
    expect(paymentIntentsCancelMock).toHaveBeenCalledWith('pi_retry_over')
    // The cardholder closes the bank's window; the charge is released.
    const { releaseUnconfirmedChargeDetailed } = await import('../jobs/paymentReconcile')
    let now = 'requires_action'
    const stripe = { paymentIntents: {
      retrieve: vi.fn(async (id: string) => ({ id, status: now, metadata: { gam_confirm_on_screen: 'true' } })),
      cancel: vi.fn(async (id: string) => { now = 'canceled'; return { id, status: 'canceled' } }),
    } } as any
    expect(await releaseUnconfirmedChargeDetailed(stripe, 'pi_screen_over')).toEqual({ outcome: 'released', declined: false })
    expect((await db.query<any>(`SELECT status, next_retry_at, stripe_payment_intent_id FROM payments WHERE id=$1`, [rent])).rows[0])
      .toEqual({ status: 'pending', next_retry_at: null, stripe_payment_intent_id: null })
    expect(await creditLeft(creditId)).toBe(100)
    expect((await db.query<any>(`SELECT status, release_reason FROM credit_uses ORDER BY held_at`)).rows).toEqual([
      { status: 'released', release_reason: 'superseded' },
      { status: 'released', release_reason: 'payment_canceled' },
    ])
  })

  it('the hold is 30 minutes', () => {
    expect(CARD_CONFIRM_HOLD_MINUTES).toBe(30)
  })

  it('the release time handed to the screen is counted from the receipt, the same clock the release sweep uses', async () => {
    await seedCharge(f, 1000, '2026-10-01')
    createMock().mockImplementationOnce(async () => {
      // The bank's answer takes a while; the receipt was written before it.
      await new Promise((r) => setTimeout(r, 1200))
      return { id: 'pi_slow_bank', status: 'requires_action', client_secret: 'pi_slow_bank_secret' }
    })
    const r = await onScreen(1000)
    const { rows: [rem] } = await db.query<{ created_at: Date }>(
      `SELECT created_at FROM tenant_remittances WHERE stripe_payment_intent_id = 'pi_slow_bank'`)
    expect(new Date(r.confirmBy!).getTime())
      .toBe(new Date(rem.created_at).getTime() + CARD_CONFIRM_HOLD_MINUTES * 60_000)
  })

  it('a card that goes straight through hands back no client secret', async () => {
    await seedCharge(f, 1000, '2026-10-01')
    createMock().mockImplementationOnce(async () => ({ id: 'pi_ok', status: 'succeeded', client_secret: 'secret_not_needed' }))
    const r = await onScreen(1000)
    expect(r.status).toBe('succeeded')
    expect(r.clientSecret).toBeUndefined()
    expect(r.confirmBy).toBeUndefined()
  })

  it('a bank still verifying is canceled even from the pay screen (only a card can be confirmed there)', async () => {
    const rent = await seedCharge(f, 1000, '2026-10-01')
    createMock().mockImplementationOnce(async () => ({ id: 'pi_bank_wait', status: 'requires_action', client_secret: 's' }))
    const err: any = await chargeLeaseBalance({
      tenantId: f.tenantId, leaseId: f.leaseId, amount: 1000, paymentMethodId: 'pm_test', paymentMethodType: 'ach',
      source: 'portal', confirmOnScreen: true,
    }).catch(e => e)
    expect(err.statusCode).toBe(402)
    expect(paymentIntentsCancelMock).toHaveBeenCalledWith('pi_bank_wait')
    expect((await db.query<any>(`SELECT status FROM payments WHERE id=$1`, [rent])).rows[0].status).toBe('pending')
  })

  it('autopay card pulls are sent off-session; bank pulls and pay-screen cards are not', async () => {
    await seedCharge(f, 1000, '2026-10-01')
    await autopay('card')
    expect(createMock().mock.calls[0][0].offSession).toBe(true)
    await cleanupAllSchema(); createMock().mockClear(); f = await fixture()
    await seedCharge(f, 1000, '2026-10-01')
    await autopay('ach')
    expect(createMock().mock.calls[0][0].offSession).toBe(false)
    await cleanupAllSchema(); createMock().mockClear(); f = await fixture()
    await seedCharge(f, 1000, '2026-10-01')
    await onScreen(1000)
    expect(createMock().mock.calls[0][0].offSession).toBe(false)
  })

  it('an off-session pull the bank still wants confirmed fails through the normal path: nothing written, the intent canceled, the tenant told to pay on the Payments page', async () => {
    const rent = await seedCharge(f, 1000, '2026-10-01')
    createMock().mockImplementationOnce(async () => {
      throw Object.assign(new Error('This payment requires authentication.'), {
        type: 'StripeCardError', rawType: 'card_error', code: 'authentication_required',
        raw: { type: 'card_error', code: 'authentication_required', payment_intent: { id: 'pi_offsession_3ds', status: 'requires_payment_method' } },
      })
    })
    const err: any = await chargeLeaseBalance({
      tenantId: f.tenantId, leaseId: f.leaseId, paymentMethodId: 'pm_test', paymentMethodType: 'card',
      source: 'autopay', chargeEverything: true,
    }).catch(e => e)
    expect(err.statusCode).toBe(402)
    expect(err.message).toMatch(/autopay cannot do/)
    expect(err.message).toMatch(/pay it on the Payments page/)
    expect(paymentIntentsCancelMock).toHaveBeenCalledWith('pi_offsession_3ds')
    expect((await db.query<any>(`SELECT status, stripe_payment_intent_id FROM payments WHERE id=$1`, [rent])).rows[0])
      .toEqual({ status: 'pending', stripe_payment_intent_id: null })
    expect(Number((await db.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM tenant_remittances`)).rows[0].n)).toBe(0)
    const { classifyAutopayFailure } = await import('../jobs/autopayRunner')
    expect(await classifyAutopayFailure(err, f.leaseId)).toBe('payment_method')
  })

  it('any other card refusal on create is passed on as it is (not called a confirmation)', async () => {
    await seedCharge(f, 1000, '2026-10-01')
    createMock().mockImplementationOnce(async () => {
      throw Object.assign(new Error('Your card was declined.'), { type: 'StripeCardError', code: 'card_declined' })
    })
    const err: any = await autopay('card').catch(e => e)
    expect(err.message).toBe('Your card was declined.')
    expect(paymentIntentsCancelMock).not.toHaveBeenCalled()
  })
})

// autopaycredit2 review problem 2: every amount in a sentence reads like the
// page around it ("$1,234.00"), never "$1234.00".
describe('amounts in refusals read $1,234.00', () => {
  let f: Fixture
  beforeEach(async () => {
    await cleanupAllSchema()
    ;(stripeConnect.createRentPlatformCharge as any).mockClear()
    f = await fixture()
  })

  it('the pay-in-full refusal names a carried balance of $1,234.00 with its comma', async () => {
    await seedCarried(f, 1234, '2026-01-01')
    await seedCharge(f, 800, '2026-09-01')
    const err: any = await charge(f, 500).catch(e => e)
    expect(err.statusCode).toBe(422)
    expect(err.message).toContain('Your carried balance of $1,234.00 can be paid down separately')
    expect(err.message).not.toMatch(/\$1234/)
  })

  it('"Bring your other rent current first" lists the other space as $1,234.00', async () => {
    const c = await db.connect()
    let other: { unitId: string; leaseId: string }
    try {
      const unitId = await seedUnit(c, { propertyId: f.propertyId, landlordId: f.landlordId, withLateFeeDecision: true })
      const leaseId = await seedLease(c, { unitId, landlordId: f.landlordId, rentAmount: 1234 })
      await seedLeaseTenant(c, { leaseId, tenantId: f.tenantId })
      other = { unitId, leaseId }
    } finally { c.release() }
    await db.query(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
       VALUES ($1,$2,$3,$4,'rent',1234,'pending','2026-09-01','RENT')`, [other.unitId, other.leaseId, f.tenantId, f.landlordId])
    await seedCarried(f, 500, '2026-01-01')
    await seedCharge(f, 800, '2026-09-01')
    const err: any = await charge(f, 1000).catch(e => e)
    expect(err.statusCode).toBe(422)
    expect(err.message).toMatch(/\(\$1,234\.00\)/)
    expect(err.message).toContain('You can pay $800.00 here now')
  })

  it('the reader\'s "balance changed" refusal says both figures as $1,234.00', async () => {
    await seedCharge(f, 1000, '2026-10-01')
    const err: any = await chargeLeaseBalance({
      tenantId: f.tenantId, leaseId: f.leaseId, chargeEverything: true,
      paymentMethodType: 'card_present', source: 'front_desk_reader',
      existingIntent: { id: 'pi_reader_moved', amountCents: 123400, capture: true },
    }).catch(e => e)
    expect(err.statusCode).toBe(409)
    expect(err.message).toContain('since the reader was sent $1,234.00')
    expect(err.message).toMatch(/it is now \$1,0\d\d\.\d\d\./)
  })
})

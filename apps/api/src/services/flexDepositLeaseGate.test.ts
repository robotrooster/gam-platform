// 10/27 (Nic) — THE LEASE DECIDES HOW MANY SPLITS ARE ON OFFER.
//
//   "month to month possibly being gated to 2 payments only and fixed term
//    being 2 or 4 payments ... we don't want the landlord to block people
//    from using our product."
//
// These tests exist because the rule was NOT exercised by the existing
// FlexDeposit suite: seedLease defaults to 'fixed_term' with a NULL end_date,
// which passes both new checks trivially. A rule nothing drives is a rule that
// is not really there, so this file drives it through the real eligibility,
// preview and enrollment paths. The pure arithmetic is covered separately in
// packages/shared/src/flexDepositLeaseTerms.test.ts.
//
// SEEDS COMMIT HERE. The services read through the singleton pool rather than
// a caller's client, so anything seeded inside an open transaction is invisible
// to them — flexDeposit.test.ts makes the same point at its `void withRollback`
// line. Isolation comes from wiping between tests instead.

// It also covers the fee reaching GAM's revenue book (the last describe),
// because this file owns the only fixture that produces a real enrolled plan
// and duplicating it would give two fixtures free to drift apart.

import { describe, it, expect, beforeEach } from 'vitest'
import { db, getClient } from '../db'
import {
  getFlexDepositEligibility, enrollFlexDeposit, previewFlexDepositSchedule,
  linkFlexDepositMoveInPayment, reconcileSettledFlexDepositPayment,
} from './flexDeposit'
import {
  cleanupAllSchema, seedDepositCustodyRule,
  seedLandlord, seedTenant, seedProperty, seedUnit, seedLease, seedLeaseTenant,
} from '../test/dbHelpers'
import type { PoolClient } from 'pg'

interface LeaseTerms {
  leaseType: 'month_to_month' | 'fixed_term' | 'nnn_commercial'
  startDate: string
  endDate:   string | null
}

/**
 * The minimum stack of an otherwise fully eligible resident, with the lease's
 * own terms as the only variables. Everything else is seeded the way a real
 * passing case looks, so a failure here is about the lease and nothing else.
 *
 * `signed_at` is deliberately left NULL: the signing-window and
 * bank-link-on-signing-day checks only run once a lease is signed, and they
 * are another file's subject.
 */
async function buildResident(
  client: PoolClient,
  lease: LeaseTerms,
): Promise<{ tenantId: string; userId: string }> {
  const { userId: ownerUserId, landlordId } = await seedLandlord(client)
  await client.query(
    `UPDATE landlords SET created_at = NOW() - INTERVAL '60 days',
            connect_payouts_enabled = TRUE WHERE id = $1`, [landlordId])

  const tenantId = await seedTenant(client)
  const tu = await client.query<{ user_id: string }>(
    `SELECT user_id FROM tenants WHERE id = $1`, [tenantId])
  const tenantUserId = tu.rows[0].user_id

  const bg = await client.query<{ id: string }>(
    `INSERT INTO background_checks (landlord_id, user_id, tenant_id, status, risk_level)
     VALUES ($1, $2, $3, 'approved', 'low') RETURNING id`,
    [landlordId, tenantUserId, tenantId])
  await client.query(
    `UPDATE tenants SET ssi_ssdi = TRUE, ach_verified = TRUE,
            background_check_status = 'approved', background_check_id = $2
      WHERE id = $1`, [tenantId, bg.rows[0].id])

  const propertyId = await seedProperty(client, {
    landlordId, ownerUserId, managedByUserId: ownerUserId })
  const unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: 1000 })

  const leaseId = await seedLease(client, {
    unitId, landlordId, rentAmount: 1000, status: 'pending',
    leaseType: lease.leaseType, startDate: lease.startDate })
  await client.query(
    `UPDATE leases SET end_date = $2::date, rent_due_day = 1 WHERE id = $1`,
    [leaseId, lease.endDate])
  await seedLeaseTenant(client, { leaseId, tenantId, role: 'primary' })

  // A $500 deposit — the grid's lowest bracket: $48 on two splits, $67 on four.
  await client.query(
    `INSERT INTO security_deposits
       (unit_id, lease_id, tenant_id, total_amount, status, held_by)
     VALUES ($1, $2, $3, 500.00, 'pending', 'gam_escrow')`,
    [unitId, leaseId, tenantId])

  // Money settling through GAM for this company, inside the landlord window.
  await client.query(
    `INSERT INTO payments
       (landlord_id, tenant_id, unit_id, lease_id, type, amount, status,
        entry_description, due_date, settled_at)
     VALUES ($1, $2, $3, $4, 'rent', 1000, 'settled', 'RENT',
             CURRENT_DATE - 10, NOW() - INTERVAL '10 days')`,
    [landlordId, tenantId, unitId, leaseId])

  return { tenantId, userId: tenantUserId }
}

/** Seed the stack and COMMIT it, so the services under test can see it. */
async function resident(lease: LeaseTerms): Promise<{ tenantId: string; userId: string }> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const r = await buildResident(client, lease)
    await client.query('COMMIT')
    return r
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally { client.release() }
}

/** Far enough ahead that no installment has already come due. */
const START = '2027-03-01'

beforeEach(async () => {
  await cleanupAllSchema()
  // enroll and preview both refuse while the product is switched off, so the
  // tests switch it on the way production has it.
  await db.query(
    `INSERT INTO system_features (key, enabled, description)
     VALUES ('flexdeposit_rollout_visible', TRUE, '10/27 lease-gate test')
     ON CONFLICT (key) DO UPDATE SET enabled = TRUE`)
  // 10/29: and a state whose rules permit GAM to hold the deposit — the
  // custody gate fails closed on a missing row.
  await seedDepositCustodyRule(db)
})

describe('a month-to-month lease splits a deposit two ways', () => {
  const MTM: LeaseTerms = { leaseType: 'month_to_month', startDate: START, endDate: null }

  it('offers only the 2-payment split', async () => {
    const { tenantId } = await resident(MTM)
    const e = await getFlexDepositEligibility(tenantId)
    expect(e.blockers).toEqual([])
    expect(e.choices.map((c) => c.payments)).toEqual([2])
    // Still the table's price for that split — the lease changes how many
    // choices there are, never what one costs.
    expect(e.choices[0].fee).toBe(48)
  })

  it('refuses an enrollment at 4 payments even though the offer hid it', async () => {
    const { tenantId, userId } = await resident(MTM)
    const r = await enrollFlexDeposit({
      tenantId, userId, installmentCount: 4, acceptedTerms: true, ip: null, userAgent: null })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/month-to-month/i)
  })

  it('refuses the 4-payment agreement preview too, so nobody accepts a plan they cannot have', async () => {
    const { tenantId } = await resident(MTM)
    const p = await previewFlexDepositSchedule({ tenantId, installmentCount: 4 })
    expect(p.ok).toBe(false)
  })

  it('still enrolls at 2 payments — the PRODUCT is not gated on lease type', async () => {
    const { tenantId, userId } = await resident(MTM)
    const r = await enrollFlexDeposit({
      tenantId, userId, installmentCount: 2, acceptedTerms: true, ip: null, userAgent: null })
    expect(r.ok).toBe(true)
  })
})

describe('a fixed term carries both splits when it is long enough', () => {
  it('offers 2 and 4 on a year lease', async () => {
    const { tenantId } = await resident({
      leaseType: 'fixed_term', startDate: START, endDate: '2028-02-29' })
    const e = await getFlexDepositEligibility(tenantId)
    expect(e.blockers).toEqual([])
    expect(e.choices.map((c) => c.payments)).toEqual([2, 4])
    expect(e.choices.map((c) => c.fee)).toEqual([48, 67])
  })

  it('drops the 4-payment split when the term ends before that schedule finishes', async () => {
    // Four payments from March 1 land on June 1; this term ends May 31.
    const { tenantId } = await resident({
      leaseType: 'fixed_term', startDate: START, endDate: '2027-05-31' })
    const e = await getFlexDepositEligibility(tenantId)
    expect(e.blockers).toEqual([])
    expect(e.choices.map((c) => c.payments)).toEqual([2])
  })

  it('refuses the 4-payment enrollment on that same short term', async () => {
    const { tenantId, userId } = await resident({
      leaseType: 'fixed_term', startDate: START, endDate: '2027-05-31' })
    const r = await enrollFlexDeposit({
      tenantId, userId, installmentCount: 4, acceptedTerms: true, ip: null, userAgent: null })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/ends before/i)
  })

  it('treats a commercial lease as the dated lease it is', async () => {
    const { tenantId } = await resident({
      leaseType: 'nnn_commercial', startDate: START, endDate: '2029-03-01' })
    const e = await getFlexDepositEligibility(tenantId)
    expect(e.choices.map((c) => c.payments)).toEqual([2, 4])
  })
})

describe('a tenancy too short for any schedule', () => {
  // Two payments from March 1 land on April 1; this term ends March 20.
  const TOO_SHORT: LeaseTerms = { leaseType: 'fixed_term', startDate: START, endDate: '2027-03-20' }

  it('reports lease_too_short_for_any_plan rather than an empty offer', async () => {
    const { tenantId } = await resident(TOO_SHORT)
    const e = await getFlexDepositEligibility(tenantId)
    expect(e.eligible).toBe(false)
    expect(e.blockers).toContain('lease_too_short_for_any_plan')
    expect(e.choices).toEqual([])
  })

  it('refuses the enrollment outright', async () => {
    const { tenantId, userId } = await resident(TOO_SHORT)
    const r = await enrollFlexDeposit({
      tenantId, userId, installmentCount: 2, acceptedTerms: true, ip: null, userAgent: null })
    expect(r.ok).toBe(false)
  })
})

// ── 10/27: THE FEE HAS TO LAND ON GAM'S BOOK ────────────────────────────────
//
// It never did. FlexDeposit's service fee was written as a payments row and
// nothing posted it to platform_revenue_ledger — GAM's one revenue book —
// while FlexPay's cycle fee always was. So every admin revenue figure would
// have under-read GAM's income by every FlexDeposit fee ever collected, from
// the first plan onward. These tests are what stops that happening again.
describe('the service fee reaches GAM\'s revenue book', () => {
  const MTM: LeaseTerms = { leaseType: 'month_to_month', startDate: START, endDate: null }

  /** Enroll, then settle installment 1 the way the move-in bundle does. */
  const enrollAndSettle = async () => {
    const { tenantId, userId } = await resident(MTM)
    const e = await enrollFlexDeposit({
      tenantId, userId, installmentCount: 2, acceptedTerms: true, ip: null, userAgent: null })
    expect(e.ok).toBe(true)
    const sd = await db.query<{ id: string; fee: string }>(
      `SELECT id, flex_deposit_service_fee::text AS fee
         FROM security_deposits WHERE tenant_id = $1`, [tenantId])
    // The installment-1 payment the move-in bundle writes: type 'deposit',
    // entry_description 'DEPOSIT', pending, no PaymentIntent. The reconcile
    // keys off exactly that shape, so the test has to use it rather than
    // whichever payment happens to be oldest.
    const lease = await db.query<{ unit_id: string; lease_id: string; landlord_id: string }>(
      `SELECT l.unit_id, l.id AS lease_id, l.landlord_id FROM leases l
         JOIN lease_tenants lt ON lt.lease_id = l.id WHERE lt.tenant_id = $1 LIMIT 1`, [tenantId])
    const pay = await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status,
                             due_date, entry_description, notes)
       VALUES ($1, $2, $3, $4, 'deposit', 250, 'pending', CURRENT_DATE, 'DEPOSIT', 'FlexDeposit installment 1')
       RETURNING id`,
      [lease.rows[0].unit_id, lease.rows[0].lease_id, tenantId, lease.rows[0].landlord_id])
    // 10/28: the move-in LINKS the payment; the fee books when that payment
    // actually settles, the same way installments 2..N have always worked.
    await linkFlexDepositMoveInPayment({
      tenantId, securityDepositId: sd.rows[0].id, movInPaymentId: pay.rows[0].id })
    await db.query(
      `UPDATE payments SET status = 'settled', settled_at = NOW() WHERE id = $1`, [pay.rows[0].id])
    await reconcileSettledFlexDepositPayment(pay.rows[0].id)
    return { tenantId, depositId: sd.rows[0].id, fee: Number(sd.rows[0].fee) }
  }

  it('books the fee at the price the plan was sold at', async () => {
    const { depositId, fee } = await enrollAndSettle()
    // A $500 deposit on two payments is $48 from the live grid.
    expect(fee).toBe(48)
    const book = await db.query<{ type: string; amount: string; reference_id: string }>(
      `SELECT type, amount::text, reference_id FROM platform_revenue_ledger
        WHERE type = 'flexdeposit_fee'`)
    expect(book.rows).toHaveLength(1)
    expect(Number(book.rows[0].amount)).toBe(48)
    // Referenced to the deposit, so the row can be traced back to its plan.
    expect(book.rows[0].reference_id).toBe(depositId)
  })

  it('books it once, however many times settlement is replayed', async () => {
    // The per-reference unique index is the backstop; a redelivered webhook or
    // a retried move-in must not book the same fee twice.
    const { tenantId, depositId } = await enrollAndSettle()
    const pay = await db.query<{ id: string }>(
      `SELECT id FROM payments WHERE tenant_id = $1 AND entry_description = 'DEPOSIT'
        ORDER BY created_at LIMIT 1`, [tenantId])
    // A redelivered webhook replays the SETTLE, which is where the fee books
    // now — and the per-reference unique index is what keeps it to one.
    await reconcileSettledFlexDepositPayment(pay.rows[0].id)
    const n = await db.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM platform_revenue_ledger WHERE type = 'flexdeposit_fee'`)
    expect(Number(n.rows[0].c)).toBe(1)
  })

  it('shows up as the FlexDeposit reserve, which was $0 before', async () => {
    const { flexDepositReserve } = await import('./flexDepositExposure')
    expect(await flexDepositReserve()).toBe(0)
    await enrollAndSettle()
    // Fees banked less shortfalls paid — the first fee IS the reserve.
    expect(await flexDepositReserve()).toBe(48)
  })
})

describe('the rule reads the lease, not the resident', () => {
  it('gives the same single choice at every risk level on a month-to-month', async () => {
    for (const risk of ['low', 'medium', 'high', 'very_high'] as const) {
      await cleanupAllSchema()
      await db.query(
        `INSERT INTO system_features (key, enabled, description)
         VALUES ('flexdeposit_rollout_visible', TRUE, '10/27 lease-gate test')
         ON CONFLICT (key) DO UPDATE SET enabled = TRUE`)
      const { tenantId } = await resident({
        leaseType: 'month_to_month', startDate: START, endDate: null })
      await db.query(
        `UPDATE background_checks bc SET risk_level = $2
           FROM tenants t WHERE t.background_check_id = bc.id AND t.id = $1`,
        [tenantId, risk])
      const e = await getFlexDepositEligibility(tenantId)
      // The month-to-month answer, identical for everybody: one choice, $48.
      expect(e.choices.map((c) => c.payments)).toEqual([2])
      expect(e.choices[0].fee).toBe(48)
    }
  })
})

/**
 * 10/28 (Nic): the counter charges the WHOLE deposit — "if they go into the
 * front desk to pay, it's going to try to charge them the whole thing" — because
 * the plan only exists against a verified bank: "they cannot pay their
 * installment in cash."
 *
 * Without this, money that covered the deposit settled ONE installment row and
 * the rest became a surplus credit while the plan carried on owing: the resident
 * had paid in full and the landlord's custody figure was still short.
 */
describe('a deposit the counter is asked to take', () => {
  const planFor = async () => {
    const { tenantId, userId } = await resident({ leaseType: 'month_to_month', startDate: START, endDate: null })
    const e = await enrollFlexDeposit({
      tenantId, userId, installmentCount: 2, acceptedTerms: true, ip: null, userAgent: null })
    expect(e.ok).toBe(true)
    const sd = await db.query<{ id: string; total: string; collected: string }>(
      `SELECT id, total_amount::text AS total, collected_amount::text AS collected
         FROM security_deposits WHERE tenant_id = $1`, [tenantId])
    const lease = await db.query<{ unit_id: string; lease_id: string; landlord_id: string }>(
      `SELECT l.unit_id, l.id AS lease_id, l.landlord_id FROM leases l
         JOIN lease_tenants lt ON lt.lease_id = l.id WHERE lt.tenant_id = $1 LIMIT 1`, [tenantId])
    return { tenantId, depositId: sd.rows[0].id, total: Number(sd.rows[0].total), lease: lease.rows[0] }
  }

  const chargeOf = async (p: any, amount: number, depositId: string) => {
    const pay = await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status,
                             due_date, entry_description, notes)
       VALUES ($1, $2, $3, $4, 'deposit', $5, 'pending', CURRENT_DATE, 'DEPOSIT', 'counter')
       RETURNING id`,
      [p.lease.unit_id, p.lease.lease_id, p.tenantId, p.lease.landlord_id, amount.toFixed(2)])
    await db.query(
      `UPDATE flex_deposit_installments SET payment_id = $1
        WHERE security_deposit_id = $2 AND installment_number = 1`, [pay.rows[0].id, depositId])
    return pay.rows[0].id
  }

  /**
   * ── 10/29 (Nic): NOT AT THE COUNTER, AT ANY AMOUNT ────────────────────────
   *
   *   "I was pretty sure we already decided that the counter cannot take the
   *    flex deposit payments. I thought we opted out of that for a variety of
   *    reasons."
   *
   * The guard that stood here only refused a payment SHORT of what was left of
   * the deposit, and on the LAST installment those two figures are equal — so
   * the final installment of a plan was collectable in cash, the plan ended,
   * the landlord kept the money, and the clawback that would have moved it into
   * GAM's custody was never built. Driven through settleManualRentPayment, the
   * service all three doors settle through (the desk, a posted payment and the
   * agent's cash tool), rather than the helper, so the test fails if any of
   * them ever stops going past this rule.
   */
  async function takeAtTheCounter(p: any, payId: string, amount: number): Promise<void> {
    const { settleManualRentPayment } = await import('./manualPaymentSettle')
    const client = await getClient()
    try {
      await client.query('BEGIN')
      await settleManualRentPayment(client, {
        payment: { id: payId, landlord_id: p.lease.landlord_id, tenant_id: p.tenantId,
          unit_id: p.lease.unit_id, lease_id: p.lease.lease_id, due_date: null as any },
        method: 'cash', settledAt: null, reference: null, settleHousehold: false,
        amountTendered: amount, sendReceipt: false,
      } as any)
      await client.query('COMMIT')
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e }
    finally { client.release() }
  }

  const planStatusOf = async (depositId: string): Promise<string> => (await db.query<any>(
    `SELECT flex_deposit_plan_status FROM security_deposits WHERE id = $1`, [depositId])).rows[0].flex_deposit_plan_status

  it('refuses the WHOLE deposit in cash — the case the old guard let through', async () => {
    const p = await planFor()
    const payId = await chargeOf(p, p.total, p.depositId)
    await expect(takeAtTheCounter(p, payId, p.total))
      .rejects.toThrow(/paid from the resident.s verified bank account/i)
    // Refused means nothing moved: the plan is untouched and the charge is open.
    expect(await planStatusOf(p.depositId)).toBe('active')
    expect((await db.query<any>(`SELECT status FROM payments WHERE id = $1`, [payId])).rows[0].status)
      .toBe('pending')
  })

  it('refuses part of it too, so there is no amount that works', async () => {
    const p = await planFor()
    const payId = await chargeOf(p, Math.round((p.total / 2) * 100) / 100, p.depositId)
    await expect(takeAtTheCounter(p, payId, Math.round((p.total / 2) * 100) / 100))
      .rejects.toThrow(/paid from the resident.s verified bank account/i)
    expect(await planStatusOf(p.depositId)).toBe('active')
  })

  /** A check or a money order is the same money by another name. */
  it('refuses a check and a money order as well as cash', async () => {
    for (const method of ['check', 'money_order', 'bank_deposit'] as const) {
      const p = await planFor()
      const payId = await chargeOf(p, p.total, p.depositId)
      const { settleManualRentPayment } = await import('./manualPaymentSettle')
      const client = await getClient()
      await client.query('BEGIN')
      await expect(settleManualRentPayment(client, {
        payment: { id: payId, landlord_id: p.lease.landlord_id, tenant_id: p.tenantId,
          unit_id: p.lease.unit_id, lease_id: p.lease.lease_id, due_date: null as any },
        method, settledAt: null, reference: 'REF-1', settleHousehold: false,
        amountTendered: p.total, sendReceipt: false,
      } as any)).rejects.toThrow(/cannot be taken as cash, a check, a money order or a bank deposit/i)
      await client.query('ROLLBACK').catch(() => {})
      client.release()
      expect(await planStatusOf(p.depositId)).toBe('active')
    }
  })
})

// ── 10/30 (Nic): ENROLLING AFTER THE BILL ALREADY WENT OUT ──────────────────
//
// The move-in path converts the deposit line into installment 1 only when the
// plan exists as the invoice is written. Heather Miller was invoiced 10/28 and
// enrolled 10/29, so her bill kept the FULL $450 deposit and installment 1 was
// linked to nothing. She was asked for $450 against a $112.50 installment, and
// because the plan looked entirely unfunded, the tenant pay-ahead banner then
// opened a live $450 ACH debit against her bank that nobody had authorised.
//
// Enrollment now adopts a deposit line that is already billed.
describe('enrolling after the deposit was already billed', () => {
  const FIXED: LeaseTerms = { leaseType: 'fixed_term', startDate: START, endDate: null }

  /** The move-in bill as it looks when it was written BEFORE enrollment: the
   *  full deposit, on an invoice, owned by no plan. */
  async function billedAtFullPrice(tenantId: string) {
    const l = (await db.query<{
      lease_id: string; unit_id: string; landlord_id: string; total: string
    }>(
      `SELECT sd.lease_id, sd.unit_id, l.landlord_id, sd.total_amount::text AS total
         FROM security_deposits sd JOIN leases l ON l.id = sd.lease_id
        WHERE sd.tenant_id = $1`, [tenantId])).rows[0]

    const inv = (await db.query<{ id: string }>(
      `INSERT INTO invoices (lease_id, unit_id, tenant_id, landlord_id, invoice_number,
                             due_date, total_amount, status)
       VALUES ($1, $2, $3, $4, $5, $6::date, $7, 'pending') RETURNING id`,
      [l.lease_id, l.unit_id, tenantId, l.landlord_id,
       'INV-AFTER-' + l.lease_id.slice(0, 8), START,
       (Number(l.total) + 1000).toFixed(2)])).rows[0]

    await db.query(
      `INSERT INTO payments (invoice_id, landlord_id, tenant_id, unit_id, lease_id,
                             type, amount, status, entry_description, due_date)
       VALUES ($1,$2,$3,$4,$5,'rent',1000,'pending','RENT',$6::date)`,
      [inv.id, l.landlord_id, tenantId, l.unit_id, l.lease_id, START])
    const dep = (await db.query<{ id: string }>(
      `INSERT INTO payments (invoice_id, landlord_id, tenant_id, unit_id, lease_id,
                             type, amount, status, entry_description, due_date)
       VALUES ($1,$2,$3,$4,$5,'deposit',$6,'pending','DEPOSIT',$7::date)
       RETURNING id`,
      [inv.id, l.landlord_id, tenantId, l.unit_id, l.lease_id,
       Number(l.total).toFixed(2), START])).rows[0]

    return { invoiceId: inv.id, depositPaymentId: dep.id, fullDeposit: Number(l.total) }
  }

  it('rewrites the billed deposit line down to installment 1 alone, and links it', async () => {
    const { tenantId, userId } = await resident(FIXED)
    const bill = await billedAtFullPrice(tenantId)
    expect(bill.fullDeposit).toBe(500)

    const e = await enrollFlexDeposit({
      tenantId, userId, installmentCount: 4, acceptedTerms: true,
      ip: '1.2.3.4', userAgent: 'test',
    })
    expect(e.ok).toBe(true)

    // 11/1: installment 1 ONLY — $125. This asserted $192 (the installment with
    // the $67 fee folded in), which is the shape the move-in path has never
    // written: a single landlord-owned 'deposit' row carrying GAM's revenue
    // means the fee rides into the custody balance, so the trust liability
    // over-counts it at settlement and the deposit return could hand it back.
    const line = (await db.query<{ amount: string; linked: string | null }>(
      `SELECT p.amount::text,
              (SELECT i.installment_number::text FROM flex_deposit_installments i
                WHERE i.payment_id = p.id) AS linked
         FROM payments p WHERE p.id = $1`, [bill.depositPaymentId])).rows[0]
    expect(Number(line.amount)).toBe(125)
    expect(line.linked).toBe('1')

    // and it belongs to the plan now, so the settle path can find it
    const owned = (await db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM payments
        WHERE id = $1 AND flex_deposit_security_deposit_id IS NOT NULL`,
      [bill.depositPaymentId])).rows[0]
    expect(owned.n).toBe('1')
  })

  it('the invoice total follows its own lines — no stale $500 left on the bill', async () => {
    const { tenantId, userId } = await resident(FIXED)
    const bill = await billedAtFullPrice(tenantId)

    await enrollFlexDeposit({
      tenantId, userId, installmentCount: 4, acceptedTerms: true,
      ip: '1.2.3.4', userAgent: 'test',
    })

    const inv = (await db.query<{ total: string; parts: string }>(
      `SELECT total_amount::text AS total,
              (subtotal_rent + subtotal_fees + subtotal_utilities
               + subtotal_deposits + subtotal_home_payments)::text AS parts
         FROM invoices WHERE id = $1`, [bill.invoiceId])).rows[0]
    // $1000 rent + $125 installment 1. GAM's $67 fee is NOT a line of the
    // landlord's invoice (invoice_id stays NULL), so it is not in this total.
    expect(Number(inv.total)).toBe(1125)
    // 11/1: and the bill's own line figures add up to it. This path re-totalled
    // total_amount alone and left subtotal_deposits at the full deposit price,
    // so MH 28's breakdown summed to $1,000 against a stated $729.50.
    expect(Number(inv.parts)).toBe(1125)
  })

  it("GAM's fee is its own row, owned by GAM and off the landlord's bill", async () => {
    const { tenantId, userId } = await resident(FIXED)
    await billedAtFullPrice(tenantId)
    await enrollFlexDeposit({
      tenantId, userId, installmentCount: 4, acceptedTerms: true,
      ip: '1.2.3.4', userAgent: 'test',
    })
    const fee = (await db.query<any>(
      `SELECT amount::float AS amount, type, revenue_owner, entry_description, invoice_id
         FROM payments
        WHERE tenant_id = $1 AND entry_description = 'FLEXDEP'`, [tenantId])).rows
    expect(fee).toHaveLength(1)
    expect(fee[0].amount).toBe(67)
    expect(fee[0].type).toBe('fee')
    expect(fee[0].revenue_owner).toBe('gam')
    expect(fee[0].invoice_id).toBeNull()
  })

  it('enrolling twice writes one fee, never two', async () => {
    const { tenantId, userId } = await resident(FIXED)
    await billedAtFullPrice(tenantId)
    for (let i = 0; i < 2; i++) {
      await enrollFlexDeposit({
        tenantId, userId, installmentCount: 4, acceptedTerms: true,
        ip: '1.2.3.4', userAgent: 'test',
      })
    }
    const n = (await db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM payments
        WHERE tenant_id = $1 AND entry_description = 'FLEXDEP' AND status <> 'voided'`,
      [tenantId])).rows[0]
    expect(n.n).toBe('1')
  })

  it('writes no pull dates, so nothing debits her bank on a schedule of its own', async () => {
    const { tenantId, userId } = await resident(FIXED)
    await billedAtFullPrice(tenantId)
    await enrollFlexDeposit({
      tenantId, userId, installmentCount: 4, acceptedTerms: true,
      ip: '1.2.3.4', userAgent: 'test',
    })
    const pulls = await db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM flex_deposit_installments i
         JOIN security_deposits sd ON sd.id = i.security_deposit_id
        WHERE sd.tenant_id = $1
          AND (i.primary_pull_date IS NOT NULL OR i.retry_pull_date IS NOT NULL)`,
      [tenantId])
    expect(pulls.rows[0].n).toBe('0')
  })

  it('leaves a deposit that already SETTLED alone', async () => {
    const { tenantId, userId } = await resident(FIXED)
    const bill = await billedAtFullPrice(tenantId)
    await db.query(`UPDATE payments SET status='settled', settled_at=NOW() WHERE id=$1`,
      [bill.depositPaymentId])

    await enrollFlexDeposit({
      tenantId, userId, installmentCount: 4, acceptedTerms: true,
      ip: '1.2.3.4', userAgent: 'test',
    })

    const line = (await db.query<{ amount: string }>(
      `SELECT amount::text FROM payments WHERE id = $1`, [bill.depositPaymentId])).rows[0]
    expect(Number(line.amount)).toBe(500)   // untouched
  })
})

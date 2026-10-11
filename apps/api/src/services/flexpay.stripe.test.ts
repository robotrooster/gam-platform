/**
 * S655 money plan Step 4 — FlexPay covers the whole monthly bill.
 *
 * Nic (10/2): "FlexPay covers the whole monthly bill; no pull days on the
 * 1st-5th; a month the tenant already paid still takes the $25; FlexPay terms
 * updated to match the code (fronting, retry schedule); landlord paid on the
 * normal Tuesday batch."
 *
 * The Stripe SDK (customer, payment-method, search and update calls) and the
 * stripeConnect create helper are mocked; everything else — the cover's
 * settle, the owner share, the household lock, the pull row, the advance state
 * machine — runs against the test database.
 *
 * Covers:
 *   coverFlexPayCycle — the last grace day; the whole bill (rent, utilities, a
 *     neighbor's utility, fees, a line waiting on its own retry — whose retry is
 *     called off) and never late fees, carried balances, GAM rows, money in
 *     flight, a security deposit, a home payment allocation cannot split yet,
 *     or a line reopened after a dispute; owner share with no fee;
 *     platform_held; $25-only months; the single-lease rule and its successor
 *     carve-out; OTP dedup; idempotent re-runs; notices with no FlexPay wording;
 *     a missed day caught up (worded as late, admin told), for three days, only
 *     for a tenant enrolled before that day; a failed cover alerts the same day.
 *   processFlexPayPullDay — row written before the Stripe call; search before
 *     create; same-run retry on one idempotency key; missed-day catch-up; runs
 *     with FlexPay hidden (money already fronted is always collected); a
 *     verified bank (the default when it is one), never a card or a bank still
 *     verifying; written off only on a run that knows nothing was created; an
 *     adopted intent that already succeeded (merchant payouts after commit).
 *   repriceFlexPayRetryPayment — the covered amount + $25 + $4 per bounce.
 *   reconcileSettledFlexPayPayment — reconciled once, $25 booked once.
 *   handleFlexPayPaymentNsf — any terminal failure defaults; a scheduled retry
 *     changes nothing; a second counted write-off bans for good (recovered ones
 *     count, GAM-side ones never do, nor make a returner).
 *   enrollFlexPay / flexPayPullDateFor — never the 1st-5th.
 *   handleFlexPayPullReversed — a settled pull taken back is written off once,
 *     even after recovery and even when another writer overwrites its stamp.
 *   Inside a caller's transaction both write-off handlers tell nobody until
 *     the caller runs afterCommit after its COMMIT.
 *   Lock order: every path that changes an advance takes the tenant row before
 *     the advance, as the cover does, so none can deadlock against a cover; the
 *     settle of an adopted pull takes the household lock first, as the cover
 *     and the success webhook do.
 *   adoptFlexPayPullIntent — an intent whose id never reached its row is
 *     recorded on the row its metadata names, never made tenant credit.
 *   Notices — what the cover leaves open is named at what is still open on
 *     each line and emailed; a second bill FlexPay could not pay is named to
 *     the tenant (app and email) once; a retry notice states the repriced
 *     amount (every bounce's returned-pull fee).
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.mock('stripe', () => {
  const customersRetrieve = vi.fn(async () => ({
    id: 'cus_default',
    invoice_settings: { default_payment_method: 'pm_default' },
    default_source: null,
  }))
  const paymentIntentsUpdate = vi.fn(async () => ({ id: 'pi_flexpay_mock' }))
  const paymentIntentsSearch = vi.fn(async () => ({ data: [] as any[] }))
  const paymentMethodsList = vi.fn(async () => ({ data: [] as any[] }))
  const setupIntentsList = vi.fn(async () => ({ data: [] as any[] }))
  const paymentIntentsCancel = vi.fn(async (id: string) => ({ id, status: 'canceled' }))
  const transfersCreate = vi.fn(async () => ({ id: 'tr_mock' }))
  function FakeStripe(this: any) {
    this.transfers = { create: transfersCreate }
    this.customers = { retrieve: customersRetrieve, create: vi.fn() }
    this.paymentMethods = { list: paymentMethodsList }
    this.accounts = { create: vi.fn(), retrieve: vi.fn() }
    this.accountSessions = { create: vi.fn() }
    this.setupIntents = { create: vi.fn(), list: setupIntentsList }
    this.paymentIntents = { create: vi.fn(), retrieve: vi.fn(), update: paymentIntentsUpdate, search: paymentIntentsSearch,
                            cancel: paymentIntentsCancel }
    this.payouts = { list: vi.fn(), retrieve: vi.fn(), create: vi.fn() }
  }
  ;(FakeStripe as any).__mocks = { customersRetrieve, paymentIntentsUpdate, paymentIntentsSearch, paymentMethodsList,
                                   setupIntentsList, paymentIntentsCancel, transfersCreate }
  return { default: FakeStripe }
})

vi.mock('./stripeConnect', async () => {
  const createRentPlatformCharge = vi.fn(async () => ({ id: 'pi_flexpay_mock', status: 'processing' }))
  return {
    createRentPlatformCharge,
    createRentDestinationCharge: vi.fn(),
    computePlatformCut:       vi.fn(() => 0),
  }
})

import Stripe from 'stripe'
import * as stripeConnect from './stripeConnect'
import { db } from '../db'
import { ALLOCATABLE_PAYMENT_TYPES } from './allocation'
import { lockHousehold } from './moneyPredicates'
import { handlePaymentReversal } from './paymentReversal'
import {
  coverFlexPayCycle,
  processFlexPayPullDay,
  reconcileSettledFlexPayPayment,
  handleFlexPayPaymentNsf,
  handleFlexPayPullReversed,
  bookFlexPayFee,
  repriceFlexPayRetryPayment,
  enrollFlexPay,
  getFlexPayEligibility,
  flexPayPullDateFor,
  isAllowedFlexPayPullDay,
  applyFlexPayRehabProgress,
  FLEXPAY_MONTHLY_FEE,
  FLEXPAY_NSF_COOLDOWN_DAYS,
  FLEXPAY_ACH_RETURN_FEE,
  FLEXPAY_DEFAULT_REASONS,
  FLEXPAY_PULL_TAKEN_BACK_REASON,
  notifyTenantPullRetry,
  adoptFlexPayPullIntent,
  FLEXPAY_PULL_REQUEUED_REASON,
  FLEXPAY_MAX_GAM_SIDE_REQUEUES,
} from './flexpay'
import {
  cleanupAllSchema,
  seedLandlord, seedTenant, seedProperty, seedUnit,
  seedLease, seedLeaseTenant, seedAllocationRule,
  seedUtilityMeter, seedUtilityBill,
} from '../test/dbHelpers'

const stripeMocks: {
  customersRetrieve:    ReturnType<typeof vi.fn>
  paymentIntentsUpdate: ReturnType<typeof vi.fn>
  paymentIntentsSearch: ReturnType<typeof vi.fn>
  paymentMethodsList:   ReturnType<typeof vi.fn>
  setupIntentsList:     ReturnType<typeof vi.fn>
  paymentIntentsCancel: ReturnType<typeof vi.fn>
  transfersCreate:      ReturnType<typeof vi.fn>
} = (Stripe as any).__mocks

/**
 * The customer's saved methods as Stripe lists them: verified banks (attached,
 * no microdeposits waiting) and cards, by type.
 */
function savedMethods(o: { banks?: string[]; cards?: string[] }) {
  stripeMocks.paymentMethodsList.mockImplementation(async (args: any) => ({
    data: args.type === 'us_bank_account'
      ? (o.banks ?? []).map(id => ({ id, type: 'us_bank_account', us_bank_account: { bank_name: 'Test Bank', last4: '6789', routing_number: '110000000' } }))
      : (o.cards ?? []).map(id => ({ id, type: 'card', card: { brand: 'visa', last4: '4242', exp_month: 1, exp_year: 2030, country: 'US' } })),
  }))
}

const createRentPlatformChargeMock =
  stripeConnect.createRentPlatformCharge as unknown as ReturnType<typeof vi.fn>

// 3 am Phoenix (UTC-7) on Oct 5, 2026: the last grace day of a bill due Oct 1
// with the default five days of grace (Oct 1 + 5 − 1).
const COVER_NOW = new Date('2026-10-05T10:00:00Z')
const DUE = '2026-10-01'
const at = (ymd: string) => new Date(`${ymd}T12:00:00Z`)   // 5 am Phoenix that day

beforeEach(async () => {
  await cleanupAllSchema()
  await db.query(`DELETE FROM platform_revenue_ledger`)
  await db.query(
    `INSERT INTO platform_processing_rates
       (payment_method, customer_facing_flat, customer_facing_percent, stripe_cost_flat, stripe_cost_percent)
     SELECT 'ach', 0, 1.0, 0, 0.5
      WHERE NOT EXISTS (SELECT 1 FROM platform_processing_rates WHERE payment_method='ach' AND effective_until IS NULL)`)
  stripeMocks.customersRetrieve.mockReset()
  stripeMocks.customersRetrieve.mockResolvedValue({
    id: 'cus_default', invoice_settings: { default_payment_method: 'pm_default' }, default_source: null,
  } as any)
  stripeMocks.paymentIntentsUpdate.mockReset()
  stripeMocks.paymentIntentsUpdate.mockResolvedValue({ id: 'pi_flexpay_mock' } as any)
  stripeMocks.paymentIntentsSearch.mockReset()
  stripeMocks.paymentIntentsSearch.mockResolvedValue({ data: [] } as any)
  stripeMocks.paymentMethodsList.mockReset()
  savedMethods({ banks: ['pm_default'] })   // the default is a verified bank
  stripeMocks.setupIntentsList.mockReset()
  stripeMocks.setupIntentsList.mockResolvedValue({ data: [] } as any)
  stripeMocks.paymentIntentsCancel.mockClear()
  stripeMocks.transfersCreate.mockClear()
  createRentPlatformChargeMock.mockReset()
  createRentPlatformChargeMock.mockResolvedValue({ id: 'pi_flexpay_mock', status: 'processing' })
  process.env.STRIPE_SECRET_KEY = 'sk_test_mocked'
})

async function enablePlatform(): Promise<void> {
  await db.query(
    `INSERT INTO system_features (key, enabled, description)
     VALUES ('flexpay_rollout_visible', TRUE, 'S655 test')
     ON CONFLICT (key) DO UPDATE SET enabled = TRUE`)
}

// ─── fixtures ──────────────────────────────────────────────────

interface Household {
  tenantId:       string
  tenantUserId:   string
  landlordId:     string
  landlordUserId: string
  propertyId:     string
  unitId:         string
  leaseId:        string
  invoiceId:      string
  rentId:         string
  waterId:        string
}

/**
 * An enrolled FlexPay tenant with October's bill: rent $1000 + water $60, due
 * Oct 1, five days of grace, pull day 20.
 */
async function seedHousehold(opts: {
  enrolled?: boolean
  pullDay?: number
  graceDays?: number | null
  dueDate?: string
  allocationRule?: boolean
  stripeCustomerId?: string | null
} = {}): Promise<Household> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId: landlordUserId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: landlordUserId, managedByUserId: landlordUserId })
    if (opts.allocationRule !== false) await seedAllocationRule(c, { propertyId })
    const unitId = await seedUnit(c, { propertyId, landlordId })
    const tenantId = await seedTenant(c)
    const leaseId = await seedLease(c, { unitId, landlordId, rentAmount: 1000 })
    await c.query(`UPDATE leases SET late_fee_grace_days = $2 WHERE id = $1`,
      [leaseId, opts.graceDays === undefined ? 5 : opts.graceDays])
    await seedLeaseTenant(c, { leaseId, tenantId, role: 'primary' })
    if (opts.enrolled !== false) {
      // Step 10: an enrolled tenant has a verified bank (enrollment requires
      // it; with none, FlexPay ends instead of paying — terms §4.3).
      await c.query(
        `UPDATE tenants SET flexpay_enrolled = TRUE, flexpay_pull_day = $2, flexpay_monthly_fee = $3, ach_verified = TRUE WHERE id = $1`,
        [tenantId, opts.pullDay ?? 20, FLEXPAY_MONTHLY_FEE])
    }
    if (opts.stripeCustomerId !== null) {
      await c.query(`UPDATE tenants SET stripe_customer_id = $2 WHERE id = $1`,
        [tenantId, opts.stripeCustomerId ?? 'cus_flexpay_test'])
    }
    const due = opts.dueDate ?? DUE
    const { rows: [inv] } = await c.query<{ id: string }>(
      `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date,
                             subtotal_rent, subtotal_utilities, total_amount, status)
       VALUES ($1, $2, $3, $4, $5, $6, 1000, 60, 1060, 'pending') RETURNING id`,
      [landlordId, tenantId, leaseId, unitId, `INV-${Math.random().toString(36).slice(2, 8)}`, due])
    const line = async (type: string, entry: string, amount: number) => (await c.query<{ id: string }>(
      `INSERT INTO payments (landlord_id, tenant_id, lease_id, unit_id, invoice_id, type, amount, status,
                             entry_description, due_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8, $9) RETURNING id`,
      [landlordId, tenantId, leaseId, unitId, inv.id, type, amount, entry, due])).rows[0].id
    const rentId = await line('rent', 'RENT', 1000)
    const waterId = await line('utility', 'UTILITY', 60)
    const meterId = await seedUtilityMeter(c, { propertyId, utilityType: 'water' })
    await seedUtilityBill(c, { meterId, unitId, tenantId, leaseId, landlordId, chargeAmount: 60,
                               paymentId: waterId, billingCycleMonth: '2026-10-01', utilityType: 'water' })
    const { rows: [u] } = await c.query<{ user_id: string }>(`SELECT user_id FROM tenants WHERE id = $1`, [tenantId])
    await c.query('COMMIT')
    return { tenantId, tenantUserId: u.user_id, landlordId, landlordUserId, propertyId, unitId, leaseId,
             invoiceId: inv.id, rentId, waterId }
  } catch (e) { await c.query('ROLLBACK'); throw e }
  finally { c.release() }
}

async function addLine(h: Household, o: {
  type: string; entry: string; amount: number; revenueOwner?: string; status?: string
  nextRetryAt?: string | null; intent?: string | null; landlordId?: string; unitId?: string; leaseId?: string | null
}): Promise<string> {
  const { rows: [r] } = await db.query<{ id: string }>(
    `INSERT INTO payments (landlord_id, tenant_id, lease_id, unit_id, invoice_id, type, amount, status,
                           entry_description, due_date, revenue_owner, next_retry_at, stripe_payment_intent_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
    [o.landlordId ?? h.landlordId, h.tenantId, o.leaseId === undefined ? h.leaseId : o.leaseId,
     o.unitId ?? h.unitId, h.invoiceId, o.type, o.amount, o.status ?? 'pending', o.entry, DUE,
     o.revenueOwner ?? 'landlord', o.nextRetryAt ?? null, o.intent ?? null])
  return r.id
}

const payment = async (id: string) => (await db.query<any>(`SELECT * FROM payments WHERE id = $1`, [id])).rows[0]
const advanceOf = async (tenantId: string) =>
  (await db.query<any>(`SELECT *, pull_date::text AS pull_date_s FROM flexpay_advances WHERE tenant_id = $1`, [tenantId])).rows
const pullRowOf = async (advanceId: string) =>
  (await db.query<any>(`SELECT * FROM payments WHERE flexpay_advance_id = $1 AND entry_description = 'FLEXPAY'`, [advanceId])).rows
const ownerShares = async (paymentId: string) =>
  (await db.query<any>(`SELECT * FROM user_balance_ledger WHERE reference_id = $1 AND type = 'allocation_owner_share'`, [paymentId])).rows

// ─── the cover ─────────────────────────────────────────────────

describe('coverFlexPayCycle — FlexPay pays the whole monthly bill', () => {
  it('the cover pays the whole monthly bill on the last grace day: one pull row, no second rent row, row written before the Stripe call', async () => {
    await enablePlatform()
    const h = await seedHousehold()

    const r = await coverFlexPayCycle(COVER_NOW)
    expect(r).toMatchObject({ candidates_scanned: 1, bills_covered: 1, paid_already: 0, amount_covered: 1060, errors: 0 })

    // Every line of the bill settled from GAM's float, held for the Tuesday batch.
    const [adv] = await advanceOf(h.tenantId)
    for (const id of [h.rentId, h.waterId]) {
      const p = await payment(id)
      expect(p.status).toBe('settled')
      expect(p.platform_held).toBe(true)
      expect(p.flexpay_advance_id).toBe(adv.id)
      expect(p.manual_method).toBeNull()
      expect(p.notes).toBe('Paid on time')
    }
    // The landlord's share is booked with no processing fee: nothing was charged.
    expect(Number((await ownerShares(h.rentId))[0].amount)).toBe(1000)
    expect(Number((await ownerShares(h.waterId))[0].amount)).toBe(60)
    const spread = await db.query(`SELECT 1 FROM platform_revenue_ledger WHERE type = 'banking_spread'`)
    expect(spread.rowCount).toBe(0)

    expect(adv).toMatchObject({ status: 'fronted', invoice_id: h.invoiceId, pull_day: 20, pull_attempts: 0 })
    expect(Number(adv.rent_amount)).toBe(1060)
    expect(Number(adv.tenant_fee_amount)).toBe(25)
    expect(adv.pull_date_s).toBe('2026-10-20')

    // Pull day: the GAM row is written FIRST, then Stripe is asked once.
    let seenAtCreate: any = null
    createRentPlatformChargeMock.mockImplementationOnce(async (opts: any) => {
      seenAtCreate = await payment(opts.metadata.gam_payment_id)
      return { id: 'pi_pull_1', status: 'processing' }
    })
    const before = await processFlexPayPullDay(at('2026-10-19'))
    expect(before.candidates_scanned).toBe(0)
    const pull = await processFlexPayPullDay(at('2026-10-20'))
    expect(pull).toMatchObject({ candidates_scanned: 1, pulls_initiated: 1, errors: 0 })

    expect(seenAtCreate).toMatchObject({ status: 'pending', stripe_payment_intent_id: null, entry_description: 'FLEXPAY' })
    expect(createRentPlatformChargeMock).toHaveBeenCalledTimes(1)
    const charge = createRentPlatformChargeMock.mock.calls[0][0]
    expect(charge).toMatchObject({
      amount: 1085, stripeCustomerId: 'cus_flexpay_test', paymentMethodId: 'pm_default',
      paymentMethodTypes: ['us_bank_account'], entryDescription: 'FLEXPAY',
      idempotencyKey: `flexpay_pull_${seenAtCreate.id}`,
    })
    expect(charge.metadata).toMatchObject({ gam_purpose: 'flexpay_pull', gam_payment_id: seenAtCreate.id,
                                            gam_advance_id: adv.id, gam_covered: '1060', gam_fee: '25' })

    const rows = await pullRowOf(adv.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ type: 'fee', revenue_owner: 'gam', entry_description: 'FLEXPAY',
                                    status: 'processing', stripe_payment_intent_id: 'pi_pull_1', invoice_id: null })
    expect(Number(rows[0].amount)).toBe(1085)
    const [pulled] = await advanceOf(h.tenantId)
    expect(pulled.status).toBe('pulled')
    expect(pulled.rent_payment_id).toBe(rows[0].id)
    expect(pulled.pull_attempts).toBe(1)

    // The bill's rent exists once: no FlexPay "rent" row beside it.
    const rent = await db.query(`SELECT id FROM payments WHERE lease_id = $1 AND type = 'rent'`, [h.leaseId])
    expect(rent.rows.map((x: any) => x.id)).toEqual([h.rentId])

    // A second run on the same day changes nothing.
    await processFlexPayPullDay(at('2026-10-20'))
    expect(createRentPlatformChargeMock).toHaveBeenCalledTimes(1)
  })

  it('a month already paid still pulls $25 only', async () => {
    await enablePlatform()
    const h = await seedHousehold()
    await db.query(`UPDATE payments SET status = 'settled', settled_at = NOW(), manual_method = 'cash'
                     WHERE id = ANY($1::uuid[])`, [[h.rentId, h.waterId]])

    const r = await coverFlexPayCycle(COVER_NOW)
    expect(r).toMatchObject({ bills_covered: 0, paid_already: 1, amount_covered: 0 })
    const [adv] = await advanceOf(h.tenantId)
    expect(Number(adv.rent_amount)).toBe(0)
    expect(adv.notes).toMatch(/already paid/)
    expect((await payment(h.rentId)).flexpay_advance_id).toBeNull()
    // The tenant is told the $25 is coming, and nothing else is.
    const notes = await db.query<any>(`SELECT body FROM notifications WHERE user_id = $1`, [h.tenantUserId])
    expect(notes.rows.map((n: any) => n.body)).toEqual([
      'Your October bill was already paid, so FlexPay paid nothing this month. On October 20, GAM collects the $25.00 monthly fee from your bank account.',
    ])

    await processFlexPayPullDay(at('2026-10-20'))
    expect(createRentPlatformChargeMock.mock.calls[0][0].amount).toBe(25)
    expect(Number((await pullRowOf(adv.id))[0].amount)).toBe(25)
  })

  it('never pays a late fee already charged, a carried balance, GAM\'s own row or a line whose money is moving', async () => {
    await enablePlatform()
    const h = await seedHousehold()
    const lateFee  = await addLine(h, { type: 'late_fee', entry: 'LATEFEE', amount: 25 })
    const carried  = await addLine(h, { type: 'carried_balance', entry: 'BALANCE', amount: 300 })
    const gamFee   = await addLine(h, { type: 'fee', entry: 'DECLINEFEE', amount: 1, revenueOwner: 'gam' })
    const inFlight = await addLine(h, { type: 'fee', entry: 'SUBSCRIP', amount: 15, status: 'processing', intent: 'pi_in_flight' })

    await coverFlexPayCycle(COVER_NOW)
    for (const id of [lateFee, carried, gamFee]) expect((await payment(id)).status).toBe('pending')
    expect((await payment(inFlight)).status).toBe('processing')
    const [adv] = await advanceOf(h.tenantId)
    expect(Number(adv.rent_amount)).toBe(1060)
    expect(stripeMocks.paymentIntentsCancel).not.toHaveBeenCalled()
  })

  it('a line waiting on its own retry is covered and its retry canceled: never pulled twice', async () => {
    await enablePlatform()
    const h = await seedHousehold()
    // The tenant's own bank pull bounced; its retry is scheduled for Oct 7 and
    // also carries a GAM fee row.
    const retrying = await addLine(h, { type: 'fee', entry: 'SUBSCRIP', amount: 40, status: 'failed',
                                        intent: 'pi_tenant_bounce', nextRetryAt: '2026-10-07T07:00:00Z' })
    const gamOnSamePull = await addLine(h, { type: 'fee', entry: 'DECLINEFEE', amount: 1, revenueOwner: 'gam', status: 'failed',
                                             intent: 'pi_tenant_bounce', nextRetryAt: '2026-10-07T07:00:00Z' })

    const r = await coverFlexPayCycle(COVER_NOW)
    expect(r.amount_covered).toBe(1100)
    const [adv] = await advanceOf(h.tenantId)
    const line = await payment(retrying)
    expect(line).toMatchObject({ status: 'settled', platform_held: true, flexpay_advance_id: adv.id, next_retry_at: null })
    expect(Number((await ownerShares(retrying))[0].amount)).toBe(40)
    // The retry is called off for the whole pull, and the old intent canceled
    // after commit, so the cron never pulls the tenant for a line FlexPay paid.
    const gam = await payment(gamOnSamePull)
    expect(gam).toMatchObject({ status: 'failed', next_retry_at: null })
    expect(stripeMocks.paymentIntentsCancel).toHaveBeenCalledTimes(1)
    expect(stripeMocks.paymentIntentsCancel.mock.calls[0][0]).toBe('pi_tenant_bounce')
    // The pull collects exactly what FlexPay paid.
    expect(Number(adv.rent_amount)).toBe(1100)
  })

  it('a renewal deposit increase on the bill is never covered', async () => {
    await enablePlatform()
    const h = await seedHousehold()
    // The S534 deposit increase a renewal puts on the household's bill, and a
    // move-out shortfall row (DEPOSIT with no lease fee behind it).
    const increase = await addLine(h, { type: 'deposit', entry: 'DEPOSIT', amount: 200 })
    const moveOut  = await addLine(h, { type: 'fee', entry: 'DEPOSIT', amount: 75 })

    const r = await coverFlexPayCycle(COVER_NOW)
    expect(r.amount_covered).toBe(1060)
    for (const id of [increase, moveOut]) {
      const p = await payment(id)
      expect(p).toMatchObject({ status: 'pending', flexpay_advance_id: null, platform_held: false })
    }
    const [adv] = await advanceOf(h.tenantId)
    expect(Number(adv.rent_amount)).toBe(1060)
    expect((await db.query(`SELECT 1 FROM admin_notifications WHERE category = 'flexpay_cover_share_not_booked'`)).rowCount).toBe(0)
  })

  it('a move-in deposit is never covered; a non-refundable pet deposit fee on the same bill is', async () => {
    await enablePlatform()
    const h = await seedHousehold()
    // A tenant enrolled on a pending lease: its move-in bill carries the
    // security deposit (held in trust) and a pet "deposit" that is a fee.
    await db.query(`UPDATE leases SET status = 'pending' WHERE id = $1`, [h.leaseId])
    const security = await addLine(h, { type: 'deposit', entry: 'DEPOSIT', amount: 1000 })
    const { rows: [fee] } = await db.query<{ id: string }>(
      `INSERT INTO lease_fees (lease_id, fee_type, amount, is_refundable, due_timing)
       VALUES ($1, 'pet_deposit', 150, FALSE, 'move_in') RETURNING id`, [h.leaseId])
    const { rows: [pet] } = await db.query<{ id: string }>(
      `INSERT INTO payments (landlord_id, tenant_id, lease_id, unit_id, invoice_id, type, amount, status,
                             entry_description, due_date, lease_fee_id)
       VALUES ($1, $2, $3, $4, $5, 'fee', 150, 'pending', 'DEPOSIT', $6, $7) RETURNING id`,
      [h.landlordId, h.tenantId, h.leaseId, h.unitId, h.invoiceId, DUE, fee.id])

    const r = await coverFlexPayCycle(COVER_NOW)
    expect(r.amount_covered).toBe(1210)
    expect((await payment(security)).status).toBe('pending')
    expect((await payment(pet.id)).status).toBe('settled')
    // No security deposit was paid from the float, so no deposit can read
    // funded by GAM's money.
    const funded = await db.query(`SELECT 1 FROM security_deposits WHERE lease_id = $1 AND status = 'funded'`, [h.leaseId])
    expect(funded.rowCount).toBe(0)
  })

  it('FlexPay never pays a home payment: it stays the tenant\'s, named as still due; a neighbor landlord\'s utility on the same bill is paid, its share to the neighbor', async () => {
    await enablePlatform()
    const h = await seedHousehold()
    const home = await addLine(h, { type: 'home_payment', entry: 'HOMEPMT', amount: 200 })
    // A space next door on another landlord's power, billed on this lease's invoice (S616).
    const c = await db.connect()
    let neighbor: { landlordId: string; userId: string; unitId: string }
    try {
      await c.query('BEGIN')
      const n = await seedLandlord(c)
      const np = await seedProperty(c, { landlordId: n.landlordId, ownerUserId: n.userId, managedByUserId: n.userId })
      await seedAllocationRule(c, { propertyId: np })
      neighbor = { landlordId: n.landlordId, userId: n.userId, unitId: await seedUnit(c, { propertyId: np, landlordId: n.landlordId }) }
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
    const electric = await addLine(h, { type: 'utility', entry: 'UTILITY', amount: 45,
                                        landlordId: neighbor.landlordId, unitId: neighbor.unitId, leaseId: null })

    const r = await coverFlexPayCycle(COVER_NOW)
    expect((await payment(electric)).status).toBe('settled')
    const share = await ownerShares(electric)
    expect(share).toHaveLength(1)
    expect(share[0].user_id).toBe(neighbor.userId)
    expect(Number(share[0].amount)).toBe(45)
    const [adv] = await advanceOf(h.tenantId)
    // Allocation splits a home payment into the landlord's owner share (a
    // tenant's own payment toward it is paid out like rent), but FlexPay never
    // pays one (decisions #35 point 7(e): a payment toward owning a home is a
    // real-property interest GAM will not hold a claim in). The line stays the
    // tenant's, named as still due.
    expect((ALLOCATABLE_PAYMENT_TYPES as readonly string[]).includes('home_payment')).toBe(true)
    expect(r.amount_covered).toBe(1105)
    expect(Number(adv.rent_amount)).toBe(1105)
    expect(await payment(home)).toMatchObject({ status: 'pending', flexpay_advance_id: null, platform_held: false })
    expect(await ownerShares(home)).toHaveLength(0)
    const [n] = (await tenantNotices(h.tenantUserId)).filter((x: any) => x.type === 'flexpay_bill_covered')
    expect(n.body).toContain('Still due on this bill: Home payment $200.00.')
    expect(n.body).not.toMatch(/no late fee/)
    expect(n.data.still_due).toEqual([{ label: 'Home payment', amount: 200 }])
    // No line was paid whose owner share went unbooked.
    expect((await db.query(`SELECT 1 FROM admin_notifications WHERE category = 'flexpay_cover_share_not_booked'`)).rowCount)
      .toBe(0)
  })

  it('a line reopened after the tenant disputed its payment is never paid by FlexPay: it stays open, the reversal stays open, and the tenant is told it is still due', async () => {
    await enablePlatform()
    const h = await seedHousehold()
    // The tenant paid October's water early, then disputed that payment; the
    // dispute reopened the line (payments.reversal_id) for the tenant to pay.
    const { rows: [rev] } = await db.query<{ id: string }>(
      `INSERT INTO payment_reversals (payment_id, landlord_id, tenant_id, lease_id, reversal_type, reversed_amount,
                                      stripe_event_id, raw_event)
       VALUES ($1, $2, $3, $4, 'card_dispute', 60, 'evt_dispute_water', '{}'::jsonb) RETURNING id`,
      [h.waterId, h.landlordId, h.tenantId, h.leaseId])
    await db.query(`UPDATE payments SET reversal_id = $2 WHERE id = $1`, [h.waterId, rev.id])

    const r = await coverFlexPayCycle(COVER_NOW)
    expect(r).toMatchObject({ bills_covered: 1, amount_covered: 1000 })
    expect((await payment(h.rentId)).status).toBe('settled')
    expect(await payment(h.waterId)).toMatchObject({ status: 'pending', flexpay_advance_id: null, reversal_id: rev.id })
    expect(await ownerShares(h.waterId)).toHaveLength(0)
    expect(Number((await advanceOf(h.tenantId))[0].rent_amount)).toBe(1000)
    // The reversal is resolved only by the tenant's own payment, never by GAM's float.
    const reversal = (await db.query<any>(`SELECT status, outcome FROM payment_reversals WHERE id = $1`, [rev.id])).rows[0]
    expect(reversal).toMatchObject({ status: 'open', outcome: null })
    const [n] = (await tenantNotices(h.tenantUserId)).filter((x: any) => x.type === 'flexpay_bill_covered')
    expect(n.body).toContain('Still due on this bill: Water $60.00.')
    expect(n.body).not.toMatch(/no late fee/)
  })

  it('a line credit already paid part of is never paid by FlexPay, and GAM never pulls the credit-paid part: it stays open at what is still owed, and the tenant is told by email', async () => {
    await enablePlatform()
    const h = await seedHousehold()
    // $20 of October's water was paid by money the tenant paid ahead at the desk.
    await applyPaidAhead(h, h.waterId, h.leaseId, 20)
    // A fee whose paid-ahead spend was undone (the money behind that credit was
    // disputed): the spend is 'reversed', the line open again.
    const fee = await addLine(h, { type: 'fee', entry: 'SUBSCRIP', amount: 30 })
    const reversedUse = await applyPaidAhead(h, fee, h.leaseId, 30)
    await db.query(
      `UPDATE credit_uses SET status = 'reversed', released_at = NOW(), release_reason = 'funding_reversed' WHERE id = $1`,
      [reversedUse])

    const r = await coverFlexPayCycle(COVER_NOW)
    expect(r).toMatchObject({ bills_covered: 1, amount_covered: 1000 })
    expect((await payment(h.rentId)).status).toBe('settled')
    for (const id of [h.waterId, fee]) {
      expect(await payment(id)).toMatchObject({ status: 'pending', flexpay_advance_id: null })
      expect(await ownerShares(id)).toHaveLength(0)
    }
    // GAM collects only what it paid: rent, never the credit-paid part of water.
    const [adv] = await advanceOf(h.tenantId)
    expect(Number(adv.rent_amount)).toBe(1000)
    await processFlexPayPullDay(at('2026-10-20'))
    expect(createRentPlatformChargeMock.mock.calls[0][0].amount).toBe(1025)

    const [n] = (await tenantNotices(h.tenantUserId)).filter((x: any) => x.type === 'flexpay_bill_covered')
    expect(n.body).toContain('Still due on this bill: Water $40.00 and Fee $30.00.')
    expect(n.body).not.toMatch(/no late fee/)
    expect(n.data.still_due).toEqual([{ label: 'Water', amount: 40 }, { label: 'Fee', amount: 30 }])
    expect(await emailsFor(n.id)).toHaveLength(1)
  })

  it('a share that cannot be booked never undoes the cover — the bill is paid and an admin is told', async () => {
    await enablePlatform()
    const h = await seedHousehold({ allocationRule: false })
    const r = await coverFlexPayCycle(COVER_NOW)
    expect(r.bills_covered).toBe(1)
    expect((await payment(h.rentId)).status).toBe('settled')
    const alert = await db.query<any>(
      `SELECT severity, context FROM admin_notifications WHERE category = 'flexpay_cover_share_not_booked'`)
    expect(alert.rows.map((a: any) => a.context.payment_id).sort()).toEqual([h.rentId, h.waterId].sort())
    expect(alert.rows[0].severity).toBe('critical')
  })

  it('runs on the last grace day, by the property\'s calendar and the lease\'s own grace — never before', async () => {
    await enablePlatform()
    const h = await seedHousehold()
    expect((await coverFlexPayCycle(new Date('2026-10-04T10:00:00Z'))).candidates_scanned).toBe(0)
    // 11 pm Oct 5 in Phoenix is already Oct 6 in UTC: still the last grace day.
    const r = await coverFlexPayCycle(new Date('2026-10-06T06:00:00Z'))
    expect(r).toMatchObject({ candidates_scanned: 1, bills_covered: 1 })
    expect((await payment(h.rentId)).notes).toBe('Paid on time')
    expect((await db.query(`SELECT 1 FROM admin_notifications WHERE category = 'flexpay_cover_late'`)).rowCount).toBe(0)
  })

  it('a missed last grace day is caught up the next run: paid, never called on time, and GAM pays the late fee its delay caused', async () => {
    await enablePlatform()
    const h = await seedHousehold()
    // The 3 am run on Oct 5 never happened (GAM's side); the late-fee run
    // charged at midnight after that day (00:30 Phoenix, Oct 6).
    const lateFee = await addLine(h, { type: 'late_fee', entry: 'LATEFEE', amount: 50 })
    await db.query(`UPDATE payments SET created_at = '2026-10-06T07:30:00Z' WHERE id = $1`, [lateFee])

    const r = await coverFlexPayCycle(new Date('2026-10-06T10:00:00Z'))
    expect(r).toMatchObject({ candidates_scanned: 1, bills_covered: 1, amount_covered: 1060 })
    for (const id of [h.rentId, h.waterId]) {
      const p = await payment(id)
      expect(p.status).toBe('settled')
      expect(p.notes).toBe('Paid')                 // not "Paid on time": it was not
    }
    const [adv] = await advanceOf(h.tenantId)
    expect(adv.notes).toMatch(/Made late: the last grace day was 2026-10-05/)
    expect(adv.pull_date_s).toBe('2026-10-20')
    // Decisions #37.D / terms §4.3: GAM pays the late fee its delay caused.
    // The landlord is paid it (an owner share, no processing fee), the tenant
    // never pays it (it is not in what the pull collects), and it is GAM's cost.
    const lf = await payment(lateFee)
    expect(lf).toMatchObject({ status: 'settled', platform_held: true, flexpay_advance_id: adv.id })
    expect((await ownerShares(lateFee)).map((x: any) => Number(x.amount))).toEqual([50])
    expect(Number(adv.rent_amount)).toBe(1060)
    const cost = await db.query<any>(
      `SELECT amount::float AS a FROM platform_revenue_ledger WHERE reference_id = $1 AND reference_type = 'flexpay_late_fee_paid_by_gam'`, [lateFee])
    expect(cost.rows).toEqual([{ a: -50 }])

    const tenantNote = (await db.query<any>(`SELECT body FROM notifications WHERE user_id = $1`, [h.tenantUserId])).rows[0]
    expect(tenantNote.body).toMatch(/^FlexPay paid your October bill of \$1,060\.00 to your landlord\. On October 20/)
    expect(tenantNote.body).toContain('FlexPay paid it late because of a problem on GAM\'s side, so GAM paid the $50.00 late fee your landlord charged in the meantime. You do not pay it.')
    expect(tenantNote.body).not.toMatch(/on time|no late fee|Still due/i)

    const alert = (await db.query<any>(`SELECT * FROM admin_notifications WHERE category = 'flexpay_cover_late'`)).rows
    expect(alert).toHaveLength(1)
    expect(alert[0].body).toContain('A late fee of $50.00 was charged on the bill in between because of this GAM-side delay; GAM paid it for the tenant')
    expect(alert[0].body).toContain('The tenant will still be charged the $25.00 monthly fee for this month on 2026-10-20.')
    expect(alert[0].context).toMatchObject({ last_grace_day: '2026-10-05', covered_on: '2026-10-06', late_fees: 0, late_fees_paid_by_gam: 50 })

    // The next day's run finds the cycle done.
    expect((await coverFlexPayCycle(new Date('2026-10-07T10:00:00Z'))).candidates_scanned).toBe(0)
  })

  it('a late fee the tenant would have drawn anyway stays theirs: another line on the bill was paid late by the tenant', async () => {
    await enablePlatform()
    const h = await seedHousehold()
    const trash = await addLine(h, { type: 'fee', entry: 'OTHERFEE', amount: 20 })
    await db.query(`UPDATE payments SET status = 'settled', settled_at = '2026-10-06T08:00:00Z', manual_method = 'cash' WHERE id = $1`, [trash])
    const lateFee = await addLine(h, { type: 'late_fee', entry: 'LATEFEE', amount: 50 })
    await db.query(`UPDATE payments SET created_at = '2026-10-06T07:30:00Z' WHERE id = $1`, [lateFee])
    expect((await coverFlexPayCycle(new Date('2026-10-06T10:00:00Z'))).bills_covered).toBe(1)
    expect((await payment(lateFee)).status).toBe('pending')
    expect((await db.query(`SELECT 1 FROM platform_revenue_ledger WHERE reference_type = 'flexpay_late_fee_paid_by_gam'`)).rowCount).toBe(0)
    const alert = (await db.query<any>(`SELECT body FROM admin_notifications WHERE category = 'flexpay_cover_late'`)).rows[0]
    expect(alert.body).toContain('A late fee of $50.00 on the bill stands as the tenant\'s')
  })

  it('a late fee that would have posted anyway stays the tenant\'s: a line FlexPay never pays (a home payment) is still open on the bill', async () => {
    await enablePlatform()
    const h = await seedHousehold()
    // The home payment is the tenant's own line: FlexPay never pays it, and it
    // was still unpaid on the last grace day, so the late fee would have come
    // whatever FlexPay did. GAM pays none of it (decisions #37.D: only a fee
    // GAM's delay CAUSED).
    const home = await addLine(h, { type: 'home_payment', entry: 'HOMEPMT', amount: 200 })
    const lateFee = await addLine(h, { type: 'late_fee', entry: 'LATEFEE', amount: 50 })
    await db.query(`UPDATE payments SET created_at = '2026-10-06T07:30:00Z' WHERE id = $1`, [lateFee])
    expect((await coverFlexPayCycle(new Date('2026-10-06T10:00:00Z'))).bills_covered).toBe(1)
    expect((await payment(home)).status).toBe('pending')
    expect((await payment(lateFee)).status).toBe('pending')
    expect((await db.query(`SELECT 1 FROM platform_revenue_ledger WHERE reference_type = 'flexpay_late_fee_paid_by_gam'`)).rowCount).toBe(0)
  })

  it('the catch-up stops after three days and never makes a second advance for a cycle', async () => {
    await enablePlatform()
    const a = await seedHousehold()
    // Last grace day Oct 5: Oct 8 is the last catch-up day, Oct 9 too late.
    expect((await coverFlexPayCycle(new Date('2026-10-09T10:00:00Z'))).candidates_scanned).toBe(0)
    expect(await advanceOf(a.tenantId)).toHaveLength(0)
    expect((await coverFlexPayCycle(new Date('2026-10-08T10:00:00Z'))).bills_covered).toBe(1)

    const b = await seedHousehold()
    await coverFlexPayCycle(COVER_NOW)                        // covered on time
    expect((await coverFlexPayCycle(new Date('2026-10-06T10:00:00Z'))).candidates_scanned).toBe(0)
    expect(await advanceOf(b.tenantId)).toHaveLength(1)
  })

  it('a bill FlexPay never paid by the end of its catch-up window is told to an admin once, with the late fees GAM owes for the tenant', async () => {
    await enablePlatform()
    const h = await seedHousehold()
    // Every run from the last grace day (Oct 5) through the last catch-up day
    // (Oct 8) failed on GAM's side; the late-fee run charged meanwhile.
    const lateFee = await addLine(h, { type: 'late_fee', entry: 'LATEFEE', amount: 50 })
    await db.query(`UPDATE payments SET created_at = '2026-10-06T07:30:00Z' WHERE id = $1`, [lateFee])
    // Oct 9: the window has closed.
    const r = await coverFlexPayCycle(new Date('2026-10-09T10:00:00Z'))
    expect(r).toMatchObject({ candidates_scanned: 0, bills_covered: 0, missed_covers: 1 })
    const alerts = (await db.query<any>(`SELECT severity, body, context FROM admin_notifications WHERE category = 'flexpay_cover_missed'`)).rows
    expect(alerts).toHaveLength(1)
    expect(alerts[0].severity).toBe('critical')
    expect(alerts[0].body).toContain('$1060.00 of its lines that FlexPay pays are still open')
    expect(alerts[0].body).toContain('$50.00 of late fees were charged on the bill since the last grace day')
    expect(alerts[0].body).toContain('GAM\'s to pay for the tenant (decisions #37.D)')
    expect(alerts[0].context).toMatchObject({ tenant_id: h.tenantId, invoice_id: h.invoiceId, last_grace_day: '2026-10-05', open_lines: 1060, late_fees: 50 })
    // Nothing was paid or charged by it.
    expect(await advanceOf(h.tenantId)).toHaveLength(0)
    expect((await payment(h.rentId)).status).toBe('pending')
    expect((await payment(lateFee)).status).toBe('pending')
    // Told once: the next day's run is quiet.
    expect((await coverFlexPayCycle(new Date('2026-10-10T10:00:00Z'))).missed_covers).toBe(0)
    expect((await db.query(`SELECT 1 FROM admin_notifications WHERE category = 'flexpay_cover_missed'`)).rowCount).toBe(1)
  })

  it('a bill FlexPay paid in its window, or one the tenant was never promised, is never named as missed', async () => {
    await enablePlatform()
    const paid = await seedHousehold()
    await coverFlexPayCycle(COVER_NOW)
    const joinedLate = await seedHousehold()
    await db.query(`UPDATE tenants SET flexpay_enrolled_at = '2026-10-05T17:00:00Z' WHERE id = $1`, [joinedLate.tenantId])
    expect((await coverFlexPayCycle(new Date('2026-10-09T10:00:00Z'))).missed_covers).toBe(0)
    expect((await db.query(`SELECT 1 FROM admin_notifications WHERE category = 'flexpay_cover_missed'`)).rowCount).toBe(0)
    expect(await advanceOf(paid.tenantId)).toHaveLength(1)
  })

  it('a tenant who joined after the last grace day began is not covered for that bill', async () => {
    await enablePlatform()
    const h = await seedHousehold()
    // Joined 10 am Oct 5 Phoenix, after that day's run.
    await db.query(`UPDATE tenants SET flexpay_enrolled_at = '2026-10-05T17:00:00Z' WHERE id = $1`, [h.tenantId])
    expect((await coverFlexPayCycle(new Date('2026-10-06T10:00:00Z'))).candidates_scanned).toBe(0)
    expect((await payment(h.rentId)).status).toBe('pending')
    // Joined before it began: covered by the catch-up.
    await db.query(`UPDATE tenants SET flexpay_enrolled_at = '2026-10-04T17:00:00Z' WHERE id = $1`, [h.tenantId])
    expect((await coverFlexPayCycle(new Date('2026-10-06T10:00:00Z'))).bills_covered).toBe(1)
  })

  it('a cover that fails for one tenant alerts an admin the same day and pays nothing', async () => {
    await enablePlatform()
    const h = await seedHousehold()
    // The cover's own transaction cannot get a connection (pool.query, which
    // passes a callback, still works, so the alert can be written).
    let failNext = true
    const realConnect = db.connect.bind(db) as any
    const spy = vi.spyOn(db, 'connect').mockImplementation(((cb?: any) => {
      if (!cb && failNext) { failNext = false; return Promise.reject(new Error('connection refused')) }
      return cb ? realConnect(cb) : realConnect()
    }) as any)
    const r = await coverFlexPayCycle(COVER_NOW)
    spy.mockRestore()
    expect(r.errors).toBe(1)
    expect((await payment(h.rentId)).status).toBe('pending')
    const alert = (await db.query<any>(`SELECT * FROM admin_notifications WHERE category = 'flexpay_cover_failed'`)).rows
    expect(alert).toHaveLength(1)
    expect(alert[0].severity).toBe('critical')
    expect(alert[0].body).toContain('connection refused')
    expect(alert[0].context).toMatchObject({ tenant_id: h.tenantId, invoice_id: h.invoiceId, last_grace_day: '2026-10-05' })
    // The next run (still the last grace day) pays it.
    expect((await coverFlexPayCycle(COVER_NOW)).bills_covered).toBe(1)
  })

  it('NULL grace falls back to five days; zero grace covers the day before the due date', async () => {
    await enablePlatform()
    const a = await seedHousehold({ graceDays: null })
    const b = await seedHousehold({ graceDays: 0, dueDate: '2026-10-06' })
    const r = await coverFlexPayCycle(COVER_NOW)
    expect(r.bills_covered).toBe(2)
    expect((await advanceOf(a.tenantId))).toHaveLength(1)
    expect((await advanceOf(b.tenantId))).toHaveLength(1)
  })

  it('a re-run the same day is a no-op', async () => {
    await enablePlatform()
    const h = await seedHousehold()
    await coverFlexPayCycle(COVER_NOW)
    const again = await coverFlexPayCycle(COVER_NOW)
    expect(again).toMatchObject({ advances_skipped_existing: 1, bills_covered: 0 })
    expect(await advanceOf(h.tenantId)).toHaveLength(1)
    expect(await ownerShares(h.rentId)).toHaveLength(1)
  })

  it('feature flag off or the tenant not enrolled → nothing', async () => {
    const h = await seedHousehold()
    expect((await coverFlexPayCycle(COVER_NOW)).candidates_scanned).toBe(0)
    await enablePlatform()
    await db.query(`UPDATE tenants SET flexpay_enrolled = FALSE WHERE id = $1`, [h.tenantId])
    expect((await coverFlexPayCycle(COVER_NOW)).candidates_scanned).toBe(0)
    expect((await payment(h.rentId)).status).toBe('pending')
  })

  it('a tenant on two leases is paused: no cover and no $25', async () => {
    await enablePlatform()
    const h = await seedHousehold()
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const unit2 = await seedUnit(c, { propertyId: h.propertyId, landlordId: h.landlordId })
      const lease2 = await seedLease(c, { unitId: unit2, landlordId: h.landlordId })
      await seedLeaseTenant(c, { leaseId: lease2, tenantId: h.tenantId })
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
    expect((await coverFlexPayCycle(COVER_NOW)).candidates_scanned).toBe(0)
    expect(await advanceOf(h.tenantId)).toHaveLength(0)
    expect((await getFlexPayEligibility(h.tenantId)).blockers).toContain('multiple_leases')
  })

  it('a landlord-signed new lease of the same home is not a second lease: the gate and the cover both count one', async () => {
    await enablePlatform()
    const h = await seedHousehold()
    await db.query(`UPDATE tenants SET ach_verified = TRUE, ssi_ssdi = TRUE WHERE id = $1`, [h.tenantId])
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const successor = await seedLease(c, { unitId: h.unitId, landlordId: h.landlordId, status: 'pending', startDate: '2026-11-01' })
      await c.query(`UPDATE leases SET supersedes_lease_id = $2, lease_source = 'esigned', signed_by_landlord = TRUE WHERE id = $1`,
        [successor, h.leaseId])
      await seedLeaseTenant(c, { leaseId: successor, tenantId: h.tenantId })
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }

    const elig = await getFlexPayEligibility(h.tenantId)
    expect(elig.blockers).not.toContain('multiple_leases')
    expect(elig.eligible).toBe(true)
    const r = await coverFlexPayCycle(COVER_NOW)
    expect(r.bills_covered).toBe(1)
  })

  it('the cover never fronts for a tenant GAM cannot pull: bank payments stopped ends FlexPay, the tenant is told the bill is theirs', async () => {
    await enablePlatform()
    const h = await seedHousehold()
    await db.query(`UPDATE tenants SET ach_suspended_at = NOW() WHERE id = $1`, [h.tenantId])
    const r = await coverFlexPayCycle(COVER_NOW)
    expect(r).toMatchObject({ candidates_scanned: 1, bills_covered: 0, paid_already: 0, ended_bank_stopped: 1, errors: 0 })
    // Nothing fronted: no advance, the bill lines still open, no owner share.
    expect(await advanceOf(h.tenantId)).toHaveLength(0)
    expect((await payment(h.rentId)).status).toBe('pending')
    expect((await payment(h.waterId)).status).toBe('pending')
    expect(await ownerShares(h.rentId)).toHaveLength(0)
    // Step 10 (decisions #37.D, terms §4.3): the tenant's side — FlexPay ends
    // with the 90-day rejoin wait, and joining again also waits on the block.
    const t = (await db.query<any>(
      `SELECT flexpay_enrolled, flexpay_disqualified_until FROM tenants WHERE id = $1`, [h.tenantId])).rows[0]
    expect(t.flexpay_enrolled).toBe(false)
    expect(Math.abs(new Date(t.flexpay_disqualified_until).getTime() - (Date.now() + FLEXPAY_NSF_COOLDOWN_DAYS * 86_400_000))).toBeLessThan(86_400_000)
    expect((await getFlexPayEligibility(h.tenantId)).blockers).toEqual(expect.arrayContaining(['bank_payments_stopped', 'tenant_suspended_nsf']))
    const notes = (await tenantNotices(h.tenantUserId)).filter((n: any) => n.type === 'flexpay_ended')
    expect(notes).toHaveLength(1)
    expect(notes[0].body).toContain(
      'FlexPay did not pay your bill due October 1. Still due on it: Rent $1,000.00 and Water $60.00 ($1,060.00 in all). ' +
      'That is yours to pay on the Payments page; your landlord\'s late fee can apply to it after today.')
    expect(notes[0].body).not.toContain('Your next bill is yours to pay.')
    expect(notes[0].body).toContain('Autopay is off.')
    expect(notes[0].body).not.toMatch(/repay|\bowe|loan|borrow/i)
    expect(notes[0].action_url).toBe('/payments')
    expect(notes[0].data.still_due).toEqual([{ label: 'Rent', amount: 1000 }, { label: 'Water', amount: 60 }])
    const alerts = (await db.query<any>(
      `SELECT title, body, context FROM admin_notifications WHERE category = 'flexpay_ended_bank_stopped'`)).rows
    expect(alerts).toHaveLength(1)
    expect(alerts[0].title).toMatch(/^FlexPay did not pay a bill: bank payments are stopped/)
    expect(alerts[0].body).toContain(
      '$1060.00 is still open for the tenant to pay on the bill due 2026-10-01')
    expect(alerts[0].body).toContain(': Rent $1,000.00 and Water $60.00. FlexPay paid none of it')
    expect(alerts[0].body).not.toMatch(/it is paid, or its payment is still clearing/)
    expect(alerts[0].context).toMatchObject({ open_amount: 1060 })
    // The landlord hears nothing; a second run does nothing more.
    expect((await db.query(`SELECT 1 FROM notifications WHERE user_id = $1`, [h.landlordUserId])).rowCount).toBe(0)
    expect((await coverFlexPayCycle(COVER_NOW)).candidates_scanned).toBe(0)
  })

  it('bank payments stopped on a tenant whose bill is already paid: FlexPay ends, no bill-is-yours sentence', async () => {
    await enablePlatform()
    const h = await seedHousehold()
    // October's bill was paid in cash; then a returned bank payment stopped bank payments.
    await db.query(`UPDATE payments SET status = 'settled', settled_at = NOW(), manual_method = 'cash'
                     WHERE id = ANY($1::uuid[])`, [[h.rentId, h.waterId]])
    await db.query(`UPDATE tenants SET ach_suspended_at = NOW() WHERE id = $1`, [h.tenantId])
    const r = await coverFlexPayCycle(COVER_NOW)
    expect(r).toMatchObject({ candidates_scanned: 1, bills_covered: 0, paid_already: 0, ended_bank_stopped: 1, errors: 0 })
    expect(await advanceOf(h.tenantId)).toHaveLength(0)            // nothing fronted, no $25
    expect((await db.query<any>(`SELECT flexpay_enrolled FROM tenants WHERE id = $1`, [h.tenantId])).rows[0].flexpay_enrolled)
      .toBe(false)
    const notes = (await tenantNotices(h.tenantUserId)).filter((n: any) => n.type === 'flexpay_ended')
    expect(notes).toHaveLength(1)
    expect(notes[0].body).not.toMatch(/did not pay your bill|That bill is yours|late fee/)
    expect(notes[0].body).toContain('Bank payments are stopped on your account after a bank payment was returned')
    expect(notes[0].body).toContain('Your next bill is yours to pay.')
    expect(notes[0].body).toContain('Autopay is off.')
    const alerts = (await db.query<any>(
      `SELECT title, body, context FROM admin_notifications WHERE category = 'flexpay_ended_bank_stopped'`)).rows
    expect(alerts).toHaveLength(1)
    expect(alerts[0].title).toMatch(/^FlexPay ended: bank payments are stopped/)
    expect(alerts[0].body).not.toMatch(/still open for the tenant|theirs to pay/)
    expect(alerts[0].body).toContain('Nothing on the bill due 2026-10-01')
    expect(alerts[0].body).toContain('it is paid, or its payment is still clearing')
    expect(alerts[0].context).toMatchObject({ open_amount: 0, still_due: [] })
  })

  it('bank payments stopped with only a home payment open: the tenant is told that line is theirs to pay, and the alert names it', async () => {
    await enablePlatform()
    const h = await seedHousehold()
    // Rent and water were paid in cash; the $200 home payment on the same bill
    // is still open (a line FlexPay never pays), and the late fee can land on it.
    await db.query(`UPDATE payments SET status = 'settled', settled_at = NOW(), manual_method = 'cash'
                     WHERE id = ANY($1::uuid[])`, [[h.rentId, h.waterId]])
    const hp = await addLine(h, { type: 'home_payment', entry: 'HOMEPMT', amount: 200 })
    await db.query(`UPDATE tenants SET ach_suspended_at = NOW() WHERE id = $1`, [h.tenantId])

    const r = await coverFlexPayCycle(COVER_NOW)
    expect(r).toMatchObject({ bills_covered: 0, ended_bank_stopped: 1, errors: 0 })
    expect(await advanceOf(h.tenantId)).toHaveLength(0)
    expect((await payment(hp)).status).toBe('pending')

    const notes = (await tenantNotices(h.tenantUserId)).filter((n: any) => n.type === 'flexpay_ended')
    expect(notes).toHaveLength(1)
    expect(notes[0].body).toContain(
      'FlexPay did not pay your bill due October 1. Still due on it: Home payment $200.00. ' +
      'That is yours to pay on the Payments page; your landlord\'s late fee can apply to it after today.')
    expect(notes[0].body).not.toContain('Your next bill is yours to pay.')
    expect(notes[0].body).not.toMatch(/in all|Rent|Water/)
    expect(notes[0].data.still_due).toEqual([{ label: 'Home payment', amount: 200 }])
    expect(notes[0].action_url).toBe('/payments')

    const alerts = (await db.query<any>(
      `SELECT title, body, context FROM admin_notifications WHERE category = 'flexpay_ended_bank_stopped'`)).rows
    expect(alerts).toHaveLength(1)
    expect(alerts[0].title).toMatch(/^FlexPay did not pay a bill: bank payments are stopped/)
    expect(alerts[0].body).toContain(
      '$200.00 is still open for the tenant to pay on the bill due 2026-10-01')
    expect(alerts[0].body).toContain(': Home payment $200.00. FlexPay paid none of it')
    expect(alerts[0].body).not.toMatch(/Nothing on the bill|it is paid, or its payment is still clearing/)
    expect(alerts[0].context).toMatchObject({ open_amount: 200, still_due: [{ label: 'Home payment', amount: 200 }] })
  })

  it('bank payments stopped with a disputed line and a late fee open: both named, and the late-fee warning stands for the disputed line', async () => {
    await enablePlatform()
    const h = await seedHousehold()
    await db.query(`UPDATE leases SET late_fee_enabled = FALSE WHERE id = $1`, [h.leaseId])
    await db.query(`UPDATE payments SET status = 'settled', settled_at = NOW(), manual_method = 'cash' WHERE id = $1`,
      [h.rentId])
    // The tenant paid the water by card, then disputed it: the real dispute
    // handler reopens the line and bills the dispute fee.
    await disputeWater(h)
    await addLine(h, { type: 'late_fee', entry: 'LATEFEE', amount: 25 })
    await db.query(`UPDATE tenants SET ach_suspended_at = NOW() WHERE id = $1`, [h.tenantId])

    await coverFlexPayCycle(COVER_NOW)
    const [n] = (await tenantNotices(h.tenantUserId)).filter((x: any) => x.type === 'flexpay_ended')
    expect(n.body).toContain('Still due on it: Water $60.00, Late fee $25.00 and Card dispute fee $15.00 ($100.00 in all).')
    expect(n.body).toContain('your landlord\'s late fee can apply to it after today.')
    expect(n.body).not.toMatch(/reopened/i)
    const [a] = (await db.query<any>(
      `SELECT context FROM admin_notifications WHERE category = 'flexpay_ended_bank_stopped'`)).rows
    expect(a.context).toMatchObject({ open_amount: 100 })
  })

  it('a disputed water line is named Water in the cover notice and the bank-stopped notice, never by its internal note', async () => {
    await enablePlatform()
    // The cover's notice.
    const h = await seedHousehold()
    await db.query(`UPDATE leases SET late_fee_enabled = FALSE WHERE id = $1`, [h.leaseId])
    await disputeWater(h)
    expect((await coverFlexPayCycle(COVER_NOW)).bills_covered).toBe(1)
    const [covered] = (await tenantNotices(h.tenantUserId)).filter((x: any) => x.type === 'flexpay_bill_covered')
    expect(covered.body).toContain('Still due on this bill: Water $60.00 and Card dispute fee $15.00.')
    expect(covered.body).not.toMatch(/reopened/i)

    // The bank-stopped notice.
    const g = await seedHousehold()
    await db.query(`UPDATE leases SET late_fee_enabled = FALSE WHERE id = $1`, [g.leaseId])
    await db.query(`UPDATE payments SET status = 'settled', settled_at = NOW(), manual_method = 'cash' WHERE id = $1`, [g.rentId])
    await disputeWater(g)
    await db.query(`UPDATE tenants SET ach_suspended_at = NOW() WHERE id = $1`, [g.tenantId])
    await coverFlexPayCycle(COVER_NOW)
    const [ended] = (await tenantNotices(g.tenantUserId)).filter((x: any) => x.type === 'flexpay_ended')
    expect(ended.body).toContain('Still due on it: Water $60.00 and Card dispute fee $15.00 ($75.00 in all).')
    expect(ended.body).not.toMatch(/reopened/i)
  })

  it('bank payments stopped with only a late fee open: the fee is named, with no late-fee warning (a late fee takes no further fee)', async () => {
    await enablePlatform()
    const h = await seedHousehold()
    await db.query(`UPDATE payments SET status = 'settled', settled_at = NOW(), manual_method = 'cash'
                     WHERE id = ANY($1::uuid[])`, [[h.rentId, h.waterId]])
    await addLine(h, { type: 'late_fee', entry: 'LATEFEE', amount: 25 })
    await db.query(`UPDATE tenants SET ach_suspended_at = NOW() WHERE id = $1`, [h.tenantId])

    await coverFlexPayCycle(COVER_NOW)
    const [n] = (await tenantNotices(h.tenantUserId)).filter((x: any) => x.type === 'flexpay_ended')
    expect(n.body).toContain(
      'FlexPay did not pay your bill due October 1. Still due on it: Late fee $25.00. That is yours to pay on the Payments page.')
    expect(n.body).not.toMatch(/late fee can apply/)
  })

  it('bank payments stopped while every line is still clearing: no bill sentence, and the alert says paid or clearing', async () => {
    await enablePlatform()
    const h = await seedHousehold()
    await db.query(`UPDATE payments SET status = 'processing', stripe_payment_intent_id = 'pi_tenant_clearing'
                     WHERE id = ANY($1::uuid[])`, [[h.rentId, h.waterId]])
    await db.query(`UPDATE tenants SET ach_suspended_at = NOW() WHERE id = $1`, [h.tenantId])

    await coverFlexPayCycle(COVER_NOW)
    const [n] = (await tenantNotices(h.tenantUserId)).filter((x: any) => x.type === 'flexpay_ended')
    expect(n.body).not.toMatch(/did not pay your bill|Still due|late fee/)
    expect(n.body).toContain('Your next bill is yours to pay.')
    const [a] = (await db.query<any>(
      `SELECT body, context FROM admin_notifications WHERE category = 'flexpay_ended_bank_stopped'`)).rows
    expect(a.body).toContain('it is paid, or its payment is still clearing')
    expect(a.context).toMatchObject({ open_amount: 0 })
  })

  it('OTP already paid the landlord this cycle → FlexPay pays nothing and takes only the $25', async () => {
    await enablePlatform()
    const h = await seedHousehold()
    await db.query(
      `INSERT INTO otp_advances (cycle_month, tenant_id, landlord_id, unit_id, lease_id,
                                 rent_amount, fee_amount, advance_amount, status, stripe_transfer_id)
       VALUES ('2026-10-01', $1, $2, $3, $4, 1000, 10, 990, 'advanced', 'tr_otp')`,
      [h.tenantId, h.landlordId, h.unitId, h.leaseId])
    const r = await coverFlexPayCycle(COVER_NOW)
    expect(r.paid_already).toBe(1)
    expect((await payment(h.rentId)).status).toBe('pending')
    expect(Number((await advanceOf(h.tenantId))[0].rent_amount)).toBe(0)
  })

  it('no FlexPay wording on any landlord-visible note: the lines read "Paid on time" and the landlord gets an ordinary Rent Collected notice; the tenant is told in plain words', async () => {
    await enablePlatform()
    const h = await seedHousehold()
    await coverFlexPayCycle(COVER_NOW)

    for (const id of [h.rentId, h.waterId]) expect((await payment(id)).notes).not.toMatch(/flex/i)
    const landlordNotes = await db.query<any>(`SELECT * FROM notifications WHERE user_id = $1`, [h.landlordUserId])
    expect(landlordNotes.rows).toHaveLength(1)
    const n = landlordNotes.rows[0]
    expect(n.type).toBe('rent_collected')
    expect(`${n.title} ${n.body} ${JSON.stringify(n.data)}`).not.toMatch(/flex/i)
    expect(n.body).toContain('$1060.00')
    expect(n.body).toContain('Water: $60.00')   // the utility by name, never "Utilities"

    const tenantNotes = await db.query<any>(`SELECT * FROM notifications WHERE user_id = $1`, [h.tenantUserId])
    expect(tenantNotes.rows).toHaveLength(1)
    expect(tenantNotes.rows[0].type).toBe('flexpay_bill_covered')
    expect(tenantNotes.rows[0].body).toMatch(/FlexPay paid your October bill of \$1,060\.00/)
    expect(tenantNotes.rows[0].body).toMatch(/On October 20, GAM collects \$1,060\.00 plus the \$25\.00 monthly fee/)
    expect(tenantNotes.rows[0].body).not.toMatch(/repay|owe|loan|borrow/i)
  })
})

// ─── the pull ──────────────────────────────────────────────────

describe('processFlexPayPullDay — GAM collects on the pull day', () => {
  async function covered(opts: Parameters<typeof seedHousehold>[0] = {}) {
    await enablePlatform()
    const h = await seedHousehold(opts)
    await coverFlexPayCycle(COVER_NOW)
    const [adv] = await advanceOf(h.tenantId)
    return { h, adv }
  }

  it('a lost create reply is adopted by the metadata search, never created twice', async () => {
    const { adv } = await covered()
    // Run 1: Stripe made the intent but the reply never came back.
    createRentPlatformChargeMock.mockRejectedValueOnce(new Error('socket hang up'))
    const r1 = await processFlexPayPullDay(at('2026-10-20'))
    expect(r1).toMatchObject({ pulls_initiated: 0, errors: 1 })
    const [row] = await pullRowOf(adv.id)
    expect(row).toMatchObject({ status: 'pending', stripe_payment_intent_id: null })
    let [a] = await advanceOf(adv.tenant_id)
    expect(a).toMatchObject({ status: 'fronted', pull_attempts: 1, pull_last_error: 'socket hang up' })
    // The first run wrote the row a moment before, so it did not search.
    expect(stripeMocks.paymentIntentsSearch).not.toHaveBeenCalled()

    // Run 2: the search finds the intent; it is recorded, not created again.
    stripeMocks.paymentIntentsSearch.mockResolvedValueOnce({ data: [{ id: 'pi_lost_reply', status: 'processing' }] } as any)
    const r2 = await processFlexPayPullDay(at('2026-10-21'))
    expect(r2).toMatchObject({ pulls_adopted: 1, pulls_initiated: 0 })
    expect(stripeMocks.paymentIntentsSearch.mock.calls[0][0].query).toBe(`metadata['gam_payment_id']:'${row.id}'`)
    expect(createRentPlatformChargeMock).toHaveBeenCalledTimes(1)
    expect(await payment(row.id)).toMatchObject({ status: 'processing', stripe_payment_intent_id: 'pi_lost_reply' })
    ;[a] = await advanceOf(adv.tenant_id)
    expect(a).toMatchObject({ status: 'pulled', pull_attempts: 2, pull_last_error: null })
    expect(await pullRowOf(adv.id)).toHaveLength(1)
  })

  it('a dropped connection is retried once in the same run with the same idempotency key', async () => {
    const { adv } = await covered()
    createRentPlatformChargeMock
      .mockRejectedValueOnce(Object.assign(new Error('connection reset'), { type: 'StripeConnectionError' }))
      .mockResolvedValueOnce({ id: 'pi_second_try', status: 'processing' })
    const r = await processFlexPayPullDay(at('2026-10-20'))
    expect(r.pulls_initiated).toBe(1)
    const keys = createRentPlatformChargeMock.mock.calls.map((c: any[]) => c[0].idempotencyKey)
    const [row] = await pullRowOf(adv.id)
    expect(keys).toEqual([`flexpay_pull_${row.id}`, `flexpay_pull_${row.id}`])
    expect((await advanceOf(adv.tenant_id))[0].pull_attempts).toBe(1)
  })

  it('a missed pull day catches up', async () => {
    const { adv } = await covered()
    const r = await processFlexPayPullDay(at('2026-10-23'))
    expect(r.pulls_initiated).toBe(1)
    expect((await advanceOf(adv.tenant_id))[0].status).toBe('pulled')
  })

  it('a fronted advance is still pulled with FlexPay hidden: hiding it stops new fronting, never collecting what GAM already paid', async () => {
    const { h, adv } = await covered()
    // An admin hides FlexPay after the landlord was paid from GAM's float.
    await db.query(`UPDATE system_features SET enabled = FALSE WHERE key = 'flexpay_rollout_visible'`)

    const r = await processFlexPayPullDay(at('2026-10-20'))
    expect(r).toMatchObject({ candidates_scanned: 1, pulls_initiated: 1, errors: 0 })
    expect(createRentPlatformChargeMock).toHaveBeenCalledTimes(1)
    expect(createRentPlatformChargeMock.mock.calls[0][0].amount).toBe(1085)
    expect((await advanceOf(h.tenantId))[0]).toMatchObject({ id: adv.id, status: 'pulled' })

    // Nothing new is fronted while hidden: another tenant's bill at its last
    // grace day is not paid.
    const other = await seedHousehold()
    expect((await coverFlexPayCycle(COVER_NOW)).candidates_scanned).toBe(0)
    expect(await advanceOf(other.tenantId)).toHaveLength(0)
    expect((await payment(other.rentId)).status).toBe('pending')
  })

  it('no verified bank on file is the tenant\'s: the pull is the last try failing at once — written off, FlexPay ends with the rejoin wait', async () => {
    const { h, adv } = await covered()
    // No bank account anywhere on the customer.
    stripeMocks.customersRetrieve.mockResolvedValue({ id: 'cus_flexpay_test', invoice_settings: { default_payment_method: null }, default_source: null } as any)
    savedMethods({})

    const r1 = await processFlexPayPullDay(at('2026-10-20'))
    expect(r1.advances_defaulted).toBe(1)
    const [a] = await advanceOf(h.tenantId)
    expect(a).toMatchObject({ status: 'defaulted', default_reason: FLEXPAY_DEFAULT_REASONS.bankUnavailable, pull_attempts: 1 })
    expect(a.pull_last_error).toMatch(/no verified bank account/i)
    expect(createRentPlatformChargeMock).not.toHaveBeenCalled()
    const [row] = await pullRowOf(adv.id)
    expect(row.status).toBe('failed')
    const alerts = await db.query<any>(`SELECT * FROM admin_notifications WHERE category = 'flexpay_advance_defaulted'`)
    expect(alerts.rows).toHaveLength(1)
    expect(alerts.rows[0].body).toContain(adv.id)
    // The tenant's mark: FlexPay ends with the 90-day wait.
    const t = (await db.query<any>(`SELECT flexpay_enrolled, flexpay_disqualified_until, flexpay_disqualified_reason FROM tenants WHERE id = $1`, [h.tenantId])).rows[0]
    expect(t.flexpay_enrolled).toBe(false)
    expect(t.flexpay_disqualified_reason).toBe(FLEXPAY_DEFAULT_REASONS.bankUnavailable)   // the ending's own reason (terms §4.3 "Bank payments stopped")
    expect(Math.abs(new Date(t.flexpay_disqualified_until).getTime() - (Date.now() + FLEXPAY_NSF_COOLDOWN_DAYS * 86_400_000))).toBeLessThan(86_400_000)
    // The tenant is told, in plain words, once.
    const ended = (await tenantNotices(h.tenantUserId)).filter((n: any) => n.type === 'flexpay_ended')
    expect(ended).toHaveLength(1)
    expect(ended[0].body).toMatch(new RegExp(
      '^GAM could not collect your FlexPay payment for your October bill because there is no verified bank account on your account to collect from, so your FlexPay has ended\\. ' +
      '\\$1,085\\.00 from FlexPay is still open with GAM\\. It is taken first from the next payment you make through GAM\\. ' +
      'You can join FlexPay again on [A-Z][a-z]+ \\d{1,2}, \\d{4}, once that amount is collected\\. Your next bill is yours to pay\\. ' +
      'Autopay is off\\. You can turn it on in Payments so your bills are paid on time\\.$'))
    // A second run finds nothing to do.
    expect((await processFlexPayPullDay(at('2026-10-21'))).candidates_scanned).toBe(0)
  })

  it('a create Stripe refuses for GAM\'s own reasons is never written off: every run tries again, an admin is told on the third, FlexPay stays on', async () => {
    const { h, adv } = await covered()
    const refused = () => Object.assign(new Error('Invalid mandate'), { type: 'StripeInvalidRequestError', rawType: 'invalid_request_error' })
    createRentPlatformChargeMock.mockRejectedValue(refused())
    for (const day of ['2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23']) {
      expect((await processFlexPayPullDay(at(day))).advances_defaulted).toBe(0)
    }
    let [a] = await advanceOf(h.tenantId)
    expect(a).toMatchObject({ status: 'fronted', default_reason: null, pull_attempts: 4 })
    const alerts = await db.query<any>(`SELECT body FROM admin_notifications WHERE category = 'flexpay_pull_gam_side'`)
    expect(alerts.rows).toHaveLength(1)
    expect(alerts.rows[0].body).toContain('nothing is held against the tenant')
    const t = (await db.query<any>(`SELECT flexpay_enrolled, flexpay_disqualified_until FROM tenants WHERE id = $1`, [h.tenantId])).rows[0]
    expect(t).toMatchObject({ flexpay_enrolled: true, flexpay_disqualified_until: null })
    expect((await tenantNotices(h.tenantUserId)).filter((n: any) => n.type === 'flexpay_ended')).toHaveLength(0)
    // Fixed: the next run collects it.
    createRentPlatformChargeMock.mockReset()
    createRentPlatformChargeMock.mockResolvedValue({ id: 'pi_fixed', status: 'processing' })
    expect((await processFlexPayPullDay(at('2026-10-24'))).pulls_initiated).toBe(1)
    ;[a] = await advanceOf(h.tenantId)
    expect(a.status).toBe('pulled')
    expect((await pullRowOf(adv.id))[0].stripe_payment_intent_id).toBe('pi_fixed')
  })

  it('with no default set, the tenant\'s verified bank is pulled', async () => {
    await covered()
    stripeMocks.customersRetrieve.mockResolvedValue({ id: 'cus_flexpay_test', invoice_settings: { default_payment_method: null }, default_source: null } as any)
    savedMethods({ banks: ['pm_bank_only'] })
    await processFlexPayPullDay(at('2026-10-20'))
    expect(createRentPlatformChargeMock.mock.calls[0][0].paymentMethodId).toBe('pm_bank_only')
    expect(stripeMocks.paymentMethodsList.mock.calls[0][0]).toMatchObject({ customer: 'cus_flexpay_test', type: 'us_bank_account' })
  })

  it('a card default plus a verified bank pulls the bank, never the card', async () => {
    await covered()
    stripeMocks.customersRetrieve.mockResolvedValue({ id: 'cus_flexpay_test', invoice_settings: { default_payment_method: 'pm_card_default' }, default_source: null } as any)
    savedMethods({ banks: ['pm_bank_1'], cards: ['pm_card_default'] })
    const r = await processFlexPayPullDay(at('2026-10-20'))
    expect(r.pulls_initiated).toBe(1)
    const charge = createRentPlatformChargeMock.mock.calls[0][0]
    expect(charge.paymentMethodId).toBe('pm_bank_1')
    expect(charge.paymentMethodTypes).toEqual(['us_bank_account'])
  })

  it('the default bank is pulled when the tenant has two verified banks', async () => {
    await covered()
    stripeMocks.customersRetrieve.mockResolvedValue({ id: 'cus_flexpay_test', invoice_settings: { default_payment_method: 'pm_bank_new' }, default_source: null } as any)
    savedMethods({ banks: ['pm_bank_old', 'pm_bank_new'] })
    await processFlexPayPullDay(at('2026-10-20'))
    expect(createRentPlatformChargeMock.mock.calls[0][0].paymentMethodId).toBe('pm_bank_new')
  })

  it('a bank still waiting on its microdeposits is never pulled: with no verified bank the collection is the tenant\'s last try failing', async () => {
    const { h, adv } = await covered()
    stripeMocks.customersRetrieve.mockResolvedValue({ id: 'cus_flexpay_test', invoice_settings: { default_payment_method: 'pm_bank_wait' }, default_source: null } as any)
    savedMethods({ banks: ['pm_bank_wait'] })
    stripeMocks.setupIntentsList.mockResolvedValue({ data: [{
      id: 'seti_wait', status: 'requires_action', next_action: { type: 'verify_with_microdeposits' },
      payment_method: { id: 'pm_bank_wait', type: 'us_bank_account', us_bank_account: { last4: '0001' } },
      created: Math.floor(Date.now() / 1000),
    }] } as any)
    expect((await processFlexPayPullDay(at('2026-10-20'))).advances_defaulted).toBe(1)
    expect(createRentPlatformChargeMock).not.toHaveBeenCalled()
    const [a] = await advanceOf(h.tenantId)
    expect(a).toMatchObject({ status: 'defaulted', default_reason: FLEXPAY_DEFAULT_REASONS.bankUnavailable })
    expect(a.pull_last_error).toMatch(/no verified bank account/i)
    expect((await pullRowOf(adv.id))[0].status).toBe('failed')
  })

  it('bank payments stopped for the tenant: never pulled, written off as the tenant\'s with the rejoin wait', async () => {
    const { h } = await covered()
    await db.query(`UPDATE tenants SET ach_suspended_at = NOW() WHERE id = $1`, [h.tenantId])
    expect((await processFlexPayPullDay(at('2026-10-20'))).advances_defaulted).toBe(1)
    expect(createRentPlatformChargeMock).not.toHaveBeenCalled()
    const [a] = await advanceOf(h.tenantId)
    expect(a).toMatchObject({ status: 'defaulted', default_reason: FLEXPAY_DEFAULT_REASONS.bankUnavailable })
    expect(a.pull_last_error).toMatch(/stopped/i)
    const t = (await db.query<any>(`SELECT flexpay_enrolled, flexpay_disqualified_until FROM tenants WHERE id = $1`, [h.tenantId])).rows[0]
    expect(t.flexpay_enrolled).toBe(false)
    expect(t.flexpay_disqualified_until).not.toBeNull()
    const [n] = (await tenantNotices(h.tenantUserId)).filter((x: any) => x.type === 'flexpay_ended')
    expect(n.body).toMatch(/^GAM could not collect your FlexPay payment for your October bill because bank payments are stopped on your account after a bank payment was returned, so your FlexPay has ended\./)
  })

  it('an unknown outcome on the third run never writes the advance off; the next run adopts what exists', async () => {
    const { h, adv } = await covered()
    const dropped = () => Object.assign(new Error('connection reset'), { type: 'StripeConnectionError' })
    createRentPlatformChargeMock.mockRejectedValue(dropped())
    for (const day of ['2026-10-20', '2026-10-21', '2026-10-22']) {
      expect((await processFlexPayPullDay(at(day))).errors).toBe(1)
    }
    let [a] = await advanceOf(h.tenantId)
    // The intent may exist and still succeed: never written off on an unknown.
    expect(a).toMatchObject({ status: 'fronted', pull_attempts: 3, default_reason: null })
    const t = (await db.query<any>(`SELECT flexpay_enrolled FROM tenants WHERE id = $1`, [h.tenantId])).rows[0]
    expect(t.flexpay_enrolled).toBe(true)
    const alerts = await db.query<any>(`SELECT category FROM admin_notifications WHERE category LIKE 'flexpay_%'`)
    expect(alerts.rows.map((x: any) => x.category)).toEqual(['flexpay_pull_unconfirmed'])

    // Run 4: Stripe answers; the intent a lost reply left behind is adopted.
    stripeMocks.paymentIntentsSearch.mockResolvedValueOnce({ data: [{ id: 'pi_was_there', status: 'processing' }] } as any)
    const r4 = await processFlexPayPullDay(at('2026-10-23'))
    expect(r4.pulls_adopted).toBe(1)
    ;[a] = await advanceOf(h.tenantId)
    expect(a.status).toBe('pulled')
    expect((await pullRowOf(adv.id))[0].stripe_payment_intent_id).toBe('pi_was_there')
    // Still only one "not confirmed" alert.
    expect((await db.query(`SELECT 1 FROM admin_notifications WHERE category = 'flexpay_pull_unconfirmed'`)).rowCount).toBe(1)
  })

  it('a failed search on the third run never writes the advance off, and neither does a run that knows nothing exists when the refusal is GAM\'s', async () => {
    const { h } = await covered()
    const refused = () => Object.assign(new Error('Invalid request'), { type: 'StripeInvalidRequestError', rawType: 'invalid_request_error' })
    createRentPlatformChargeMock.mockRejectedValue(refused())
    await processFlexPayPullDay(at('2026-10-20'))
    await processFlexPayPullDay(at('2026-10-21'))
    stripeMocks.paymentIntentsSearch.mockRejectedValueOnce(Object.assign(new Error('search unavailable'), { type: 'StripeAPIError' }))
    const r3 = await processFlexPayPullDay(at('2026-10-22'))
    expect(r3).toMatchObject({ advances_defaulted: 0, errors: 1 })
    expect((await advanceOf(h.tenantId))[0].status).toBe('fronted')
    // Run 4: the search answers "nothing" and Stripe refuses again — GAM's side: still never written off.
    const r4 = await processFlexPayPullDay(at('2026-10-23'))
    expect(r4.advances_defaulted).toBe(0)
    expect((await advanceOf(h.tenantId))[0]).toMatchObject({ status: 'fronted', default_reason: null })
  })

  it('a Stripe refusal that made an intent is never treated as "nothing created"', async () => {
    const { h } = await covered()
    const refusedWithIntent = () => Object.assign(new Error('payment method unusable'),
      { type: 'StripeCardError', payment_intent: { id: 'pi_refused', status: 'requires_payment_method' } })
    createRentPlatformChargeMock.mockRejectedValue(refusedWithIntent())
    for (const day of ['2026-10-20', '2026-10-21', '2026-10-22']) await processFlexPayPullDay(at(day))
    expect((await advanceOf(h.tenantId))[0]).toMatchObject({ status: 'fronted', default_reason: null })
  })

  it('an adopted intent that already succeeded pays a FlexCharge merchant its share after commit, as the webhook would', async () => {
    const { h, adv } = await covered()
    // A FlexCharge statement minimum the pull carries by GAM-first routing.
    await db.query(`UPDATE users SET stripe_connect_account_id = 'acct_merchant' WHERE id = $1`, [h.landlordUserId])
    const { rows: [acct] } = await db.query<{ id: string }>(
      `INSERT INTO flex_charge_accounts (tenant_id, property_id, landlord_id, credit_limit, status)
       VALUES ($1, $2, $3, 1000, 'active') RETURNING id`, [h.tenantId, h.propertyId, h.landlordId])
    const { rows: [stmt] } = await db.query<{ id: string }>(
      `INSERT INTO flex_charge_statements (account_id, cycle_month, balance, service_fee, total_due, new_balance, minimum_due,
                                           due_date, status)
       VALUES ($1, '2026-09-01', 50, 0, 50, 50, 50, '2026-09-01', 'open') RETURNING id`, [acct.id])
    createRentPlatformChargeMock.mockRejectedValueOnce(new Error('timeout'))
    await processFlexPayPullDay(at('2026-10-20'))
    const [row] = await pullRowOf(adv.id)
    expect(Number(row.gam_supersedence_amount)).toBe(50)
    stripeMocks.paymentIntentsSearch.mockResolvedValueOnce({ data: [{ id: 'pi_done_fc', status: 'succeeded' }] } as any)
    await processFlexPayPullDay(at('2026-10-21'))

    expect((await db.query<any>(`SELECT status FROM flex_charge_statements WHERE id = $1`, [stmt.id])).rows[0].status).toBe('paid')
    expect(stripeMocks.transfersCreate).toHaveBeenCalledTimes(1)
    const [params, opts] = stripeMocks.transfersCreate.mock.calls[0]
    expect(params).toMatchObject({ amount: 5000, currency: 'usd', destination: 'acct_merchant' })
    expect(opts).toEqual({ idempotencyKey: `flexcharge_payout_super_${stmt.id}` })
  })

  it('an adopted intent that already succeeded is settled, reconciled and booked', async () => {
    const { adv } = await covered()
    createRentPlatformChargeMock.mockRejectedValueOnce(new Error('timeout'))
    await processFlexPayPullDay(at('2026-10-20'))
    stripeMocks.paymentIntentsSearch.mockResolvedValueOnce({ data: [{ id: 'pi_done', status: 'succeeded' }] } as any)
    await processFlexPayPullDay(at('2026-10-21'))
    const [row] = await pullRowOf(adv.id)
    expect(row).toMatchObject({ status: 'settled', stripe_payment_intent_id: 'pi_done' })
    expect((await advanceOf(adv.tenant_id))[0].status).toBe('reconciled')
    const fee = await db.query<any>(`SELECT amount FROM platform_revenue_ledger WHERE type = 'flexpay_subscription'`)
    expect(fee.rows.map((x: any) => Number(x.amount))).toEqual([25])
  })

  it('carries any other GAM balance on the same pull (GAM-first routing)', async () => {
    const { h, adv } = await covered()
    // A prior cycle written off: $440 + $25 still owed to GAM.
    await db.query(
      `INSERT INTO flexpay_advances (cycle_month, tenant_id, landlord_id, unit_id, lease_id,
                                     rent_amount, tenant_fee_amount, pull_day, status, defaulted_at)
       VALUES ('2026-08-01', $1, $2, $3, $4, 440, 25, 20, 'defaulted', NOW())`,
      [h.tenantId, h.landlordId, h.unitId, h.leaseId])
    await processFlexPayPullDay(at('2026-10-20'))
    const [row] = await pullRowOf(adv.id)
    expect(Number(row.amount)).toBe(1085 + 465)
    expect(Number(row.gam_supersedence_amount)).toBe(465)
  })
})

describe('flexPayPullDateFor / isAllowedFlexPayPullDay — never the 1st-5th', () => {
  it('the pull is the tenant\'s day on or after the cover day', () => {
    expect(flexPayPullDateFor('2026-10-05', 20)).toBe('2026-10-20')
    expect(flexPayPullDateFor('2026-10-05', 6)).toBe('2026-10-06')
    expect(flexPayPullDateFor('2026-10-19', 10)).toBe('2026-11-10')
    expect(flexPayPullDateFor('2026-12-19', 10)).toBe('2027-01-10')
    expect(flexPayPullDateFor('2026-10-20', 20)).toBe('2026-10-20')
  })

  it('a pull day stored before the rule (1st-5th) is moved to the 6th', () => {
    expect(flexPayPullDateFor('2026-10-05', 3)).toBe('2026-10-06')
    expect(flexPayPullDateFor('2026-10-09', 1)).toBe('2026-11-06')
  })

  it('days 6-28 are allowed; 1-5, 29+ and fractions are not', () => {
    for (const d of [1, 2, 3, 4, 5, 0, 29, 31, 6.5]) expect(isAllowedFlexPayPullDay(d)).toBe(false)
    for (const d of [6, 15, 28]) expect(isAllowedFlexPayPullDay(d)).toBe(true)
  })

  /** Enrollment open (the launch switch) and the tenant's FlexPay request at `status`. */
  async function openEnrollment(tenantId: string, status: 'approved' | 'pending'): Promise<void> {
    await db.query(
      `INSERT INTO system_features (key, enabled, description) VALUES ('flexpay_enrollment_open', TRUE, 'S655 test')
       ON CONFLICT (key) DO UPDATE SET enabled = TRUE`)
    await db.query(
      `INSERT INTO flexpay_inquiries (tenant_id, status, claimed_income_source, reviewed_at)
       VALUES ($1, $2, 'ssdi', CASE WHEN $2 = 'approved' THEN now() END)`, [tenantId, status])
  }

  it('pull days 1–5 are refused at enrollment', async () => {
    await enablePlatform()
    const h = await seedHousehold({ enrolled: false })
    await openEnrollment(h.tenantId, 'approved')
    for (const pullDay of [1, 3, 5]) {
      const r = await enrollFlexPay({ tenantId: h.tenantId, userId: h.tenantUserId, pullDay,
                                      acceptedTerms: true, ip: null, userAgent: null })
      expect(r).toEqual({ ok: false, reason: 'Pick a pull day from the 6th through the 28th. The 1st through the 5th are not offered.' })
    }
    const t = (await db.query<any>(`SELECT flexpay_enrolled FROM tenants WHERE id = $1`, [h.tenantId])).rows[0]
    expect(t.flexpay_enrolled).toBe(false)
  })

  it('a tenant who cannot enroll yet is told that first, whatever day they picked: under review, or not launched', async () => {
    await enablePlatform()
    const h = await seedHousehold({ enrolled: false })
    const enroll = (pullDay: number) => enrollFlexPay({ tenantId: h.tenantId, userId: h.tenantUserId, pullDay,
                                                          acceptedTerms: true, ip: null, userAgent: null })
    // Before launch: the launch message, not the day rule.
    const closed = await enroll(3)
    expect(closed.ok).toBe(false)
    expect((closed as any).reason).toMatch(/hasn’t launched yet/)
    // Launched, request still under review.
    await openEnrollment(h.tenantId, 'pending')
    for (const pullDay of [3, 15]) {
      const r = await enroll(pullDay)
      expect(r).toEqual({ ok: false, reason: 'Your FlexPay request is still under review — we’ll reach out soon' })
    }
    // A day outside 1-28 is refused in the same plain words once approved.
    await db.query(`UPDATE flexpay_inquiries SET status = 'approved', reviewed_at = now() WHERE tenant_id = $1`, [h.tenantId])
    for (const pullDay of [0, 29, 6.5]) {
      expect(await enroll(pullDay)).toEqual({ ok: false, reason: 'Pick a pull day from the 6th through the 28th. The 1st through the 5th are not offered.' })
    }
    expect((await db.query<any>(`SELECT flexpay_enrolled FROM tenants WHERE id = $1`, [h.tenantId])).rows[0].flexpay_enrolled)
      .toBe(false)
  })
})

// ─── retry reprice ─────────────────────────────────────────────

describe('repriceFlexPayRetryPayment — the retry reprice uses the covered amount', () => {
  async function pulledThenBounced(retryCount: number) {
    await enablePlatform()
    const h = await seedHousehold()
    await coverFlexPayCycle(COVER_NOW)
    createRentPlatformChargeMock.mockResolvedValueOnce({ id: 'pi_repx', status: 'processing' })
    await processFlexPayPullDay(at('2026-10-20'))
    const [adv] = await advanceOf(h.tenantId)
    const [row] = await pullRowOf(adv.id)
    // The shared retry pipeline has claimed it: retry_count counts this retry.
    await db.query(`UPDATE payments SET status = 'processing', retry_count = $2 WHERE id = $1`, [row.id, retryCount])
    return { h, adv, row }
  }

  it('the first retry collects the covered amount + $25 + one returned-pull fee', async () => {
    const { adv, row } = await pulledThenBounced(1)
    await repriceFlexPayRetryPayment(row.id)
    const expected = 1060 + 25 + FLEXPAY_ACH_RETURN_FEE
    const [piId, args] = stripeMocks.paymentIntentsUpdate.mock.calls[0]
    expect(piId).toBe('pi_repx')
    expect(args.amount).toBe(Math.round(expected * 100))
    expect(args.metadata).toMatchObject({ gam_covered: '1060', gam_fee: '25', gam_returned_pull_fees: '4', gam_retry: '1',
                                          gam_payment_id: row.id, gam_advance_id: adv.id })
    expect(Number((await payment(row.id)).amount)).toBe(expected)
    // The $25 is the fee and stays the fee: a retry never re-prices it (S562).
    expect(Number((await advanceOf(adv.tenant_id))[0].tenant_fee_amount)).toBe(25)
  })

  it('the second retry passes on both bounces at cost', async () => {
    const { row } = await pulledThenBounced(2)
    await repriceFlexPayRetryPayment(row.id)
    expect(Number((await payment(row.id)).amount)).toBe(1060 + 25 + 2 * FLEXPAY_ACH_RETURN_FEE)
  })

  it('no-op when the payment is not a FlexPay pull', async () => {
    await repriceFlexPayRetryPayment('00000000-0000-0000-0000-000000000000')
    expect(stripeMocks.paymentIntentsUpdate).not.toHaveBeenCalled()
  })
})

// ─── settle ────────────────────────────────────────────────────

describe('reconcileSettledFlexPayPayment', () => {
  async function pulled() {
    await enablePlatform()
    const h = await seedHousehold()
    await coverFlexPayCycle(COVER_NOW)
    await processFlexPayPullDay(at('2026-10-20'))
    const [adv] = await advanceOf(h.tenantId)
    const [row] = await pullRowOf(adv.id)
    return { h, adv, row }
  }

  it('the pull settling reconciles the advance and books the $25 once', async () => {
    const { adv, row } = await pulled()
    await db.query(`UPDATE payments SET status = 'settled', settled_at = NOW() WHERE id = $1`, [row.id])
    await reconcileSettledFlexPayPayment(row.id)
    await reconcileSettledFlexPayPayment(row.id)
    const [a] = await advanceOf(adv.tenant_id)
    expect(a.status).toBe('reconciled')
    expect(a.reconciled_at).not.toBeNull()
    const fee = await db.query<any>(
      `SELECT amount, reference_id, reference_type FROM platform_revenue_ledger WHERE type = 'flexpay_subscription'`)
    expect(fee.rows).toEqual([{ amount: '25.00', reference_id: adv.id, reference_type: 'flexpay_advance' }])
  })

  it('inside the caller\'s transaction it commits or rolls back with it', async () => {
    const { adv, row } = await pulled()
    await db.query(`UPDATE payments SET status = 'settled', settled_at = NOW() WHERE id = $1`, [row.id])
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      await reconcileSettledFlexPayPayment(row.id, c)
      await c.query('ROLLBACK')
    } finally { c.release() }
    expect((await advanceOf(adv.tenant_id))[0].status).toBe('pulled')
    expect((await db.query(`SELECT 1 FROM platform_revenue_ledger`)).rowCount).toBe(0)
  })

  it('a pull that has not settled, or a row that is not a FlexPay pull, changes nothing', async () => {
    const { h, adv, row } = await pulled()
    await reconcileSettledFlexPayPayment(row.id)               // still processing
    await reconcileSettledFlexPayPayment(h.rentId)             // a bill line
    await reconcileSettledFlexPayPayment('00000000-0000-0000-0000-000000000000')
    expect((await advanceOf(adv.tenant_id))[0].status).toBe('pulled')
  })
})

// ─── terminal failure ──────────────────────────────────────────

describe('handleFlexPayPaymentNsf — any terminal failure', () => {
  async function failedPull(o: { retryCount: number; nextRetryAt: string | null }) {
    await enablePlatform()
    const h = await seedHousehold()
    await db.query(`UPDATE tenants SET ssi_ssdi = TRUE, ach_verified = TRUE WHERE id = $1`, [h.tenantId])
    await coverFlexPayCycle(COVER_NOW)
    await processFlexPayPullDay(at('2026-10-20'))
    const [adv] = await advanceOf(h.tenantId)
    const [row] = await pullRowOf(adv.id)
    await db.query(`UPDATE payments SET status = 'failed', retry_count = $2, next_retry_at = $3 WHERE id = $1`,
      [row.id, o.retryCount, o.nextRetryAt])
    return { h, adv, row }
  }

  it('a first-attempt terminal failure (a closed account, never retried) defaults the advance', async () => {
    const { h, adv, row } = await failedPull({ retryCount: 0, nextRetryAt: null })
    await handleFlexPayPaymentNsf(row.id)
    const [a] = await advanceOf(h.tenantId)
    expect(a).toMatchObject({ status: 'defaulted', default_reason: FLEXPAY_DEFAULT_REASONS.pullNotCollected })
    // The one bounce Stripe charged GAM for joins what is written off.
    expect(Number(a.tenant_fee_amount)).toBe(25 + FLEXPAY_ACH_RETURN_FEE)
    const t = (await db.query<any>(
      `SELECT flexpay_enrolled, flexpay_disqualified_until, flexpay_disqualified_reason FROM tenants WHERE id = $1`,
      [h.tenantId])).rows[0]
    expect(t.flexpay_enrolled).toBe(false)
    expect(t.flexpay_disqualified_reason).toBe(FLEXPAY_DEFAULT_REASONS.pullNotCollected)
    const until = new Date(t.flexpay_disqualified_until).getTime()
    expect(Math.abs(until - (Date.now() + FLEXPAY_NSF_COOLDOWN_DAYS * 86_400_000))).toBeLessThan(86_400_000)
    const alerts = await db.query<any>(`SELECT body FROM admin_notifications WHERE category = 'flexpay_advance_defaulted'`)
    expect(alerts.rows[0].body).toContain(adv.id)
  })

  it('the last retry failing defaults the advance, with every returned-pull fee: the first try and both retries', async () => {
    const { h, row } = await failedPull({ retryCount: 2, nextRetryAt: null })
    await handleFlexPayPaymentNsf(row.id)
    const [a] = await advanceOf(h.tenantId)
    expect(a.status).toBe('defaulted')
    expect(Number(a.tenant_fee_amount)).toBe(25 + 3 * FLEXPAY_ACH_RETURN_FEE)
    const alert = (await db.query<any>(`SELECT body, context FROM admin_notifications WHERE category = 'flexpay_advance_defaulted'`)).rows[0]
    expect(alert.body).toContain('$1097.00 is written off, including $12.00 of returned-pull fees passed on at cost')
    expect(alert.context).toMatchObject({ written_off: 1097, returned_pull_fees: 12 })
    // Only the $25 is ever booked as earnings, whatever the advance carries.
    await bookFlexPayFee(a.id)
    const fee = await db.query<any>(`SELECT amount FROM platform_revenue_ledger WHERE type = 'flexpay_subscription'`)
    expect(fee.rows.map((x: any) => Number(x.amount))).toEqual([25])
  })

  it('a failure with a retry still scheduled changes nothing', async () => {
    const { h, row } = await failedPull({ retryCount: 0, nextRetryAt: '2026-10-23T07:00:00Z' })
    await handleFlexPayPaymentNsf(row.id)
    expect((await advanceOf(h.tenantId))[0].status).toBe('pulled')
    const t = (await db.query<any>(`SELECT flexpay_enrolled FROM tenants WHERE id = $1`, [h.tenantId])).rows[0]
    expect(t.flexpay_enrolled).toBe(true)
  })

  it('a second write-off ends FlexPay for good', async () => {
    const { h, row } = await failedPull({ retryCount: 2, nextRetryAt: null })
    await db.query(
      `INSERT INTO flexpay_advances (cycle_month, tenant_id, landlord_id, unit_id, lease_id,
                                     rent_amount, tenant_fee_amount, pull_day, status, defaulted_at)
       VALUES ('2026-01-01', $1, $2, $3, $4, 440, 25, 20, 'defaulted', NOW())`,
      [h.tenantId, h.landlordId, h.unitId, h.leaseId])
    await handleFlexPayPaymentNsf(row.id)
    const t = (await db.query<any>(
      `SELECT flexpay_permanently_banned, flexpay_disqualified_reason, flexpay_disqualified_until FROM tenants WHERE id = $1`,
      [h.tenantId])).rows[0]
    expect(t).toMatchObject({ flexpay_permanently_banned: true, flexpay_disqualified_reason: 'permanent_second_default',
                              flexpay_disqualified_until: null })
  })

  it('a write-off GAM caused (the pull never created) never counts toward the ban', async () => {
    const { h, row } = await failedPull({ retryCount: 2, nextRetryAt: null })
    await db.query(
      `INSERT INTO flexpay_advances (cycle_month, tenant_id, landlord_id, unit_id, lease_id,
                                     rent_amount, tenant_fee_amount, pull_day, status, defaulted_at, default_reason)
       VALUES ('2026-01-01', $1, $2, $3, $4, 440, 25, 20, 'defaulted', NOW(), $5)`,
      [h.tenantId, h.landlordId, h.unitId, h.leaseId, FLEXPAY_DEFAULT_REASONS.pullNotCreated])
    await handleFlexPayPaymentNsf(row.id)
    const t = (await db.query<any>(
      `SELECT flexpay_permanently_banned, flexpay_disqualified_reason, flexpay_disqualified_until FROM tenants WHERE id = $1`,
      [h.tenantId])).rows[0]
    // Their first counted write-off: the 90-day wait, not a ban.
    expect(t.flexpay_permanently_banned).toBe(false)
    expect(t.flexpay_disqualified_reason).toBe(FLEXPAY_DEFAULT_REASONS.pullNotCollected)
    expect(t.flexpay_disqualified_until).not.toBeNull()
  })

  it('a write-off recovered since by GAM-first routing still counts: a second ends FlexPay for good', async () => {
    const { h, row } = await failedPull({ retryCount: 2, nextRetryAt: null })
    await db.query(
      `INSERT INTO flexpay_advances (cycle_month, tenant_id, landlord_id, unit_id, lease_id,
                                     rent_amount, tenant_fee_amount, pull_day, status, defaulted_at, default_reason,
                                     reconciled_at)
       VALUES ('2026-01-01', $1, $2, $3, $4, 440, 25, 20, 'reconciled', NOW() - interval '200 days', $5, NOW() - interval '100 days')`,
      [h.tenantId, h.landlordId, h.unitId, h.leaseId, FLEXPAY_DEFAULT_REASONS.pullNotCollected])
    await handleFlexPayPaymentNsf(row.id)
    const t = (await db.query<any>(`SELECT flexpay_permanently_banned FROM tenants WHERE id = $1`, [h.tenantId])).rows[0]
    expect(t.flexpay_permanently_banned).toBe(true)
  })

  it('a pull GAM itself ended (gamSide) is never the tenant\'s: FlexPay stays on, no wait, and the collection is made again', async () => {
    const { h, adv, row } = await failedPull({ retryCount: 1, nextRetryAt: null })
    // An earlier write-off at the tenant's bank: one more counted would ban.
    await db.query(
      `INSERT INTO flexpay_advances (cycle_month, tenant_id, landlord_id, unit_id, lease_id,
                                     rent_amount, tenant_fee_amount, pull_day, status, defaulted_at, default_reason)
       VALUES ('2026-01-01', $1, $2, $3, $4, 440, 25, 20, 'defaulted', NOW(), $5)`,
      [h.tenantId, h.landlordId, h.unitId, h.leaseId, FLEXPAY_DEFAULT_REASONS.pullNotCollected])
    const out = await handleFlexPayPaymentNsf(row.id, undefined, { gamSide: true, why: 'GAM could not re-price the retry' })
    expect(out).toMatchObject({ wroteOff: false, requeued: true })
    const [a] = (await advanceOf(h.tenantId)).filter((x: any) => x.id === adv.id)
    // Waiting on its pull again; the first try's bounce (one fee) is collected
    // with the try made again, the retry GAM ended never reached the bank. The
    // bounce stays counted on the row (the same collection): never folded into
    // the advance.
    expect(a).toMatchObject({ status: 'fronted', default_reason: null })
    expect(Number(a.tenant_fee_amount)).toBe(25)
    const again = await payment(row.id)
    expect(again).toMatchObject({ status: 'pending', stripe_payment_intent_id: null, next_retry_at: null, retry_count: 1,
                                  return_reason: FLEXPAY_PULL_REQUEUED_REASON })
    // What GAM collects: the bill FlexPay paid, the $25, the one bounce's fee
    // — and the earlier written-off advance ($465) rides along (GAM-first routing).
    expect(Number(again.amount)).toBe(1060 + 25 + FLEXPAY_ACH_RETURN_FEE + 465)
    expect(Number(again.gam_supersedence_amount)).toBe(465)
    const t = (await db.query<any>(
      `SELECT flexpay_enrolled, flexpay_permanently_banned, flexpay_disqualified_until FROM tenants WHERE id = $1`,
      [h.tenantId])).rows[0]
    expect(t).toMatchObject({ flexpay_enrolled: true, flexpay_permanently_banned: false, flexpay_disqualified_until: null })
    const alert = (await db.query<any>(`SELECT title, body FROM admin_notifications WHERE category = 'flexpay_pull_gam_side'`)).rows
    expect(alert).toHaveLength(1)
    expect(alert[0].body).toContain('GAM could not re-price the retry')
    expect((await tenantNotices(h.tenantUserId)).filter((n: any) => n.type === 'flexpay_ended')).toHaveLength(0)

    // The next pull run makes the collection again, with a fresh intent and a key of its own.
    createRentPlatformChargeMock.mockResolvedValueOnce({ id: 'pi_again', status: 'processing' })
    expect((await processFlexPayPullDay(at('2026-10-24'))).pulls_initiated).toBe(1)
    expect((await pullRowOf(adv.id))[0].stripe_payment_intent_id).toBe('pi_again')
    const lastCall = createRentPlatformChargeMock.mock.calls[createRentPlatformChargeMock.mock.calls.length - 1] as any[]
    expect(lastCall[0].idempotencyKey).toMatch(new RegExp(`^flexpay_pull_${row.id}_\\d+$`))
    expect(lastCall[0].amount).toBe(1060 + 25 + FLEXPAY_ACH_RETURN_FEE + 465)
  })

  it('a collection made again keeps its bank returns counted: after two returns, a return on the try made again is the last try, with each return\'s fee written off once', async () => {
    const { h, row } = await failedPull({ retryCount: 2, nextRetryAt: null })
    // GAM could not send the second retry: it never reached the bank.
    await handleFlexPayPaymentNsf(row.id, undefined, { gamSide: true, why: 'GAM could not send the retry to the bank' })
    const again = await payment(row.id)
    // The same collection: its two returns stay counted (the bank sees it at
    // most three times in all), and the try collects both returns' fees.
    expect(again).toMatchObject({ status: 'pending', retry_count: 2, stripe_payment_intent_id: null })
    expect(Number(again.amount)).toBe(1060 + 25 + 2 * FLEXPAY_ACH_RETURN_FEE)
    expect(Number((await advanceOf(h.tenantId))[0].tenant_fee_amount)).toBe(25)
    createRentPlatformChargeMock.mockResolvedValueOnce({ id: 'pi_third_try', status: 'processing' })
    expect((await processFlexPayPullDay(at('2026-10-24'))).pulls_initiated).toBe(1)
    const lastCall = createRentPlatformChargeMock.mock.calls[createRentPlatformChargeMock.mock.calls.length - 1] as any[]
    expect(lastCall[0].amount).toBe(1060 + 25 + 2 * FLEXPAY_ACH_RETURN_FEE)
    // The bank returns it a third time: no retry is left, so it is the last
    // try failing — the tenant's — and the three returns' fees join what is
    // written off, once each.
    await db.query(`UPDATE payments SET status = 'failed', next_retry_at = NULL WHERE id = $1`, [row.id])
    await handleFlexPayPaymentNsf(row.id)
    const [a] = await advanceOf(h.tenantId)
    expect(a).toMatchObject({ status: 'defaulted', default_reason: FLEXPAY_DEFAULT_REASONS.pullNotCollected })
    expect(Number(a.tenant_fee_amount)).toBe(25 + 3 * FLEXPAY_ACH_RETURN_FEE)
  })

  it('a collection that keeps failing on GAM\'s side is held for a person after the cap, never pulled again', async () => {
    const { h, adv, row } = await failedPull({ retryCount: 0, nextRetryAt: null })
    for (let n = 1; n <= FLEXPAY_MAX_GAM_SIDE_REQUEUES; n++) {
      const out = await handleFlexPayPaymentNsf(row.id, undefined, { gamSide: true, why: `problem ${n}` })
      expect(out).toMatchObject({ wroteOff: false, requeued: true, held: false })
      // The next run makes it again, and GAM's side fails it again.
      createRentPlatformChargeMock.mockResolvedValueOnce({ id: `pi_gam_try_${n}`, status: 'processing' })
      expect((await processFlexPayPullDay(at('2026-10-24'))).pulls_initiated).toBe(1)
      await db.query(`UPDATE payments SET status = 'failed', next_retry_at = NULL WHERE id = $1`, [row.id])
    }
    const out = await handleFlexPayPaymentNsf(row.id, undefined, { gamSide: true, why: 'problem again' })
    expect(out).toMatchObject({ wroteOff: false, requeued: false, held: true })
    const [a] = (await advanceOf(h.tenantId)).filter((x: any) => x.id === adv.id)
    expect(a.status).not.toBe('fronted')
    expect(a.default_reason).toBeNull()
    expect((await payment(row.id)).status).toBe('failed')
    // Nothing more is pulled until a person releases it.
    const calls = createRentPlatformChargeMock.mock.calls.length
    expect((await processFlexPayPullDay(at('2026-10-25'))).pulls_initiated).toBe(0)
    expect(createRentPlatformChargeMock.mock.calls.length).toBe(calls)
    // Nothing is held against the tenant; an admin is told, once.
    const t = (await db.query<any>(
      `SELECT flexpay_enrolled, flexpay_disqualified_until, flexpay_permanently_banned FROM tenants WHERE id = $1`, [h.tenantId])).rows[0]
    expect(t).toEqual({ flexpay_enrolled: true, flexpay_disqualified_until: null, flexpay_permanently_banned: false })
    expect((await db.query(`SELECT 1 FROM admin_notifications WHERE category = 'flexpay_pull_gam_side_held'`)).rowCount).toBe(1)
    expect((await tenantNotices(h.tenantUserId)).filter((n: any) => n.type === 'flexpay_ended')).toHaveLength(0)
  })

  it('a pull GAM could not create never makes the tenant a returner', async () => {
    const { h } = await failedPull({ retryCount: 0, nextRetryAt: '2026-10-23T07:00:00Z' })
    await db.query(
      `INSERT INTO flexpay_advances (cycle_month, tenant_id, landlord_id, unit_id, lease_id,
                                     rent_amount, tenant_fee_amount, pull_day, status, defaulted_at, default_reason)
       VALUES ('2026-01-01', $1, $2, $3, $4, 440, 25, 20, 'defaulted', NOW(), $5)`,
      [h.tenantId, h.landlordId, h.unitId, h.leaseId, FLEXPAY_DEFAULT_REASONS.pullNotCreated])
    await applyFlexPayRehabProgress(h.tenantId, 0)
    let t = (await db.query<any>(`SELECT flexpay_clean_streak FROM tenants WHERE id = $1`, [h.tenantId])).rows[0]
    expect(t.flexpay_clean_streak).toBe(0)        // a first-timer: no rehab clock runs
    // A counted write-off makes them a returner, and the clock moves.
    await db.query(`UPDATE flexpay_advances SET default_reason = $2 WHERE tenant_id = $1 AND cycle_month = '2026-01-01'`,
      [h.tenantId, FLEXPAY_DEFAULT_REASONS.pullNotCollected])
    await applyFlexPayRehabProgress(h.tenantId, 0)
    t = (await db.query<any>(`SELECT flexpay_clean_streak FROM tenants WHERE id = $1`, [h.tenantId])).rows[0]
    expect(t.flexpay_clean_streak).toBe(1)
  })

  it('a written-off pull tells the tenant FlexPay ended, what is still open, when they can join again, and that autopay is off', async () => {
    const { h } = await failedPull({ retryCount: 0, nextRetryAt: null })
    await handleFlexPayPaymentNsf(h.rentId)        // a bill line: nothing, nobody told
    expect((await tenantNotices(h.tenantUserId)).filter((n: any) => n.type === 'flexpay_ended')).toHaveLength(0)
    const [row] = await pullRowOf((await advanceOf(h.tenantId))[0].id)
    await handleFlexPayPaymentNsf(row.id)
    await handleFlexPayPaymentNsf(row.id)          // a second call: already written off, nobody told again
    const ended = (await tenantNotices(h.tenantUserId)).filter((n: any) => n.type === 'flexpay_ended')
    expect(ended).toHaveLength(1)
    expect(ended[0].title).toBe('Your FlexPay has ended')
    expect(ended[0].body).toMatch(new RegExp(
      '^GAM could not collect your FlexPay payment for your October bill on its last try, so your FlexPay has ended\\. ' +
      '\\$1,089\\.00 from FlexPay is still open with GAM\\. It is taken first from the next payment you make through GAM\\. ' +
      'You can join FlexPay again on [A-Z][a-z]+ \\d{1,2}, \\d{4}, once that amount is collected\\. ' +
      'Your next bill is yours to pay\\. Autopay is off\\. You can turn it on in Payments so your bills are paid on time\\.$'))
    expect(ended[0].body).not.toMatch(/repay|\bowe|loan|borrow|debt/i)
    expect(ended[0].action_url).toBe('/payments')
    expect(ended[0].data).toMatchObject({ why: 'not_collected', still_open: 1089, rejoin_never: false })
  })

  it('a tenant with autopay on is not told autopay is off; a second write-off says FlexPay is gone for good', async () => {
    const { h, row } = await failedPull({ retryCount: 2, nextRetryAt: null })
    await db.query(`INSERT INTO tenant_autopay (tenant_id, lease_id, enabled, pull_day) VALUES ($1, $2, TRUE, 7)`,
      [h.tenantId, h.leaseId])
    await db.query(
      `INSERT INTO flexpay_advances (cycle_month, tenant_id, landlord_id, unit_id, lease_id,
                                     rent_amount, tenant_fee_amount, pull_day, status, defaulted_at, reconciled_at)
       VALUES ('2026-01-01', $1, $2, $3, $4, 440, 25, 20, 'reconciled', NOW() - interval '200 days', NOW() - interval '100 days')`,
      [h.tenantId, h.landlordId, h.unitId, h.leaseId])
    await handleFlexPayPaymentNsf(row.id)
    const [ended] = (await tenantNotices(h.tenantUserId)).filter((n: any) => n.type === 'flexpay_ended')
    expect(ended.body).toContain('This is the second time, so FlexPay is no longer available on your account.')
    expect(ended.body).not.toContain('join FlexPay again')
    expect(ended.body).not.toContain('Autopay is off')
    expect(ended.data).toMatchObject({ rejoin_never: true })
  })

  it('a tenant who had already canceled is told what happened, never that FlexPay "ended"', async () => {
    const { h, row } = await failedPull({ retryCount: 0, nextRetryAt: null })
    await db.query(`UPDATE tenants SET flexpay_enrolled = FALSE, flexpay_pull_day = NULL WHERE id = $1`, [h.tenantId])
    await handleFlexPayPaymentNsf(row.id)
    const [n] = (await tenantNotices(h.tenantUserId)).filter((x: any) => x.type === 'flexpay_ended')
    expect(n.title).toBe('FlexPay: a payment to GAM did not go through')
    expect(n.body).toMatch(/^GAM could not collect your FlexPay payment for your October bill on its last try\. /)
    expect(n.body).not.toMatch(/has ended|next bill|Autopay/)
  })

  it('a pull GAM ended tells the tenant nothing: their FlexPay goes on', async () => {
    const { h, row } = await failedPull({ retryCount: 0, nextRetryAt: null })
    await handleFlexPayPaymentNsf(row.id, undefined, { gamSide: true })
    expect((await tenantNotices(h.tenantUserId)).filter((x: any) => x.type === 'flexpay_ended')).toHaveLength(0)
    expect((await db.query<any>(`SELECT flexpay_enrolled FROM tenants WHERE id = $1`, [h.tenantId])).rows[0].flexpay_enrolled).toBe(true)
  })

  it('a bill line, a pull already written off, or an unknown id → no-op', async () => {
    const { h } = await failedPull({ retryCount: 2, nextRetryAt: null })
    await handleFlexPayPaymentNsf(h.rentId)
    await handleFlexPayPaymentNsf('00000000-0000-0000-0000-000000000000')
    expect((await advanceOf(h.tenantId))[0].status).toBe('pulled')
    expect((await db.query(`SELECT 1 FROM admin_notifications WHERE category = 'flexpay_advance_defaulted'`)).rowCount).toBe(0)
  })
})

// ─── S655 Step 4 fix round 2 ───────────────────────────────────

/**
 * A landlord-signed new lease of the same home starting mid-month: its first
 * bill (rent $500, due `due`, five days of grace) on the new lease.
 */
async function seedSuccessorBill(h: Household, due: string): Promise<{ leaseId: string; invoiceId: string; rentId: string }> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const leaseId = await seedLease(c, { unitId: h.unitId, landlordId: h.landlordId, status: 'pending', startDate: due, rentAmount: 500 })
    await c.query(`UPDATE leases SET supersedes_lease_id = $2, lease_source = 'esigned', signed_by_landlord = TRUE,
                                     late_fee_grace_days = 5 WHERE id = $1`, [leaseId, h.leaseId])
    await seedLeaseTenant(c, { leaseId, tenantId: h.tenantId })
    const { rows: [inv] } = await c.query<{ id: string }>(
      `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date,
                             subtotal_rent, subtotal_utilities, total_amount, status)
       VALUES ($1, $2, $3, $4, $5, $6, 500, 0, 500, 'pending') RETURNING id`,
      [h.landlordId, h.tenantId, leaseId, h.unitId, `INV-${Math.random().toString(36).slice(2, 8)}`, due])
    const { rows: [r] } = await c.query<{ id: string }>(
      `INSERT INTO payments (landlord_id, tenant_id, lease_id, unit_id, invoice_id, type, amount, status,
                             entry_description, due_date)
       VALUES ($1, $2, $3, $4, $5, 'rent', 500, 'pending', 'RENT', $6) RETURNING id`,
      [h.landlordId, h.tenantId, leaseId, h.unitId, inv.id, due])
    await c.query('COMMIT')
    return { leaseId, invoiceId: inv.id, rentId: r.id }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

const tenantNotices = async (userId: string) =>
  (await db.query<any>(`SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at, id`, [userId])).rows

/**
 * Step 10: the household's water was paid by card and the tenant disputed
 * that payment — the real dispute handler reopens the line (a fresh pending
 * row with reversal_id) and bills the $15 dispute fee.
 */
async function disputeWater(h: Household): Promise<void> {
  const pi = `pi_water_${h.waterId.slice(0, 8)}`
  await db.query(
    `UPDATE payments SET status = 'settled', settled_at = NOW(), stripe_payment_intent_id = $2, stripe_charge_id = 'ch_' || $2
      WHERE id = $1`, [h.waterId, pi])
  const r = await handlePaymentReversal({
    paymentIntentId: pi, reversalType: 'card_dispute', reversedAmount: null, reversalFee: 15,
    stripeEventId: `evt_${pi}`, stripeObjectId: `du_${pi}`, rawEvent: {},
  })
  expect(r.handled).toBe(true)
}

/** The emails a notification sent (email_send_log keeps every send, suppressed in tests). */
const emailsFor = async (notificationId: string) =>
  (await db.query<any>(`SELECT to_email, subject, category FROM email_send_log WHERE related_entity_id = $1`,
                       [notificationId])).rows

/**
 * `amount` of a bill line already paid by paid-ahead money the landlord took
 * (a desk use, applied): the rest of the line is still open.
 */
async function applyPaidAhead(h: Household, paymentId: string, leaseId: string, amount: number): Promise<string> {
  const { rows: [credit] } = await db.query<{ id: string }>(
    `INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining, funded_by, received_at)
     VALUES ($1, $2, $3, $3, 'landlord', NOW() - interval '20 days') RETURNING id`,
    [leaseId, h.tenantId, amount])
  const { rows: [use] } = await db.query<{ id: string }>(
    `INSERT INTO credit_uses (prepaid_credit_id, payment_id, lease_id, amount, billing_month, source, status, applied_at)
     VALUES ($1, $2, $3, $4, '2026-10-01', 'desk', 'applied', NOW()) RETURNING id`,
    [credit.id, paymentId, leaseId, amount])
  return use.id
}

describe('inside a caller\'s transaction the tenant is told only after the commit', () => {
  async function pulled() {
    await enablePlatform()
    const h = await seedHousehold()
    await db.query(`UPDATE tenants SET ssi_ssdi = TRUE, ach_verified = TRUE WHERE id = $1`, [h.tenantId])
    await coverFlexPayCycle(COVER_NOW)
    await processFlexPayPullDay(at('2026-10-20'))
    const [adv] = await advanceOf(h.tenantId)
    const [row] = await pullRowOf(adv.id)
    return { h, adv, row }
  }
  const told = async (userId: string, category: string) => ({
    tenant: (await tenantNotices(userId)).filter((n: any) => n.type === 'flexpay_ended').length,
    admin:  (await db.query(`SELECT 1 FROM admin_notifications WHERE category = $1`, [category])).rowCount,
  })
  async function inTransaction<T>(run: (c: any) => Promise<T>, end: 'COMMIT' | 'ROLLBACK'): Promise<T> {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const r = await run(c)
      await c.query(end)
      return r
    } finally { c.release() }
  }

  it('a terminal failure: nobody is told before the commit, nobody at all on a rollback, once after a commit', async () => {
    const { h, row } = await pulled()
    await db.query(`UPDATE payments SET status = 'failed', retry_count = 0, next_retry_at = NULL WHERE id = $1`, [row.id])
    const category = 'flexpay_advance_defaulted'

    const rolledBack = await inTransaction(async c => {
      const r = await handleFlexPayPaymentNsf(row.id, c)
      expect(r.wroteOff).toBe(true)
      expect(await told(h.tenantUserId, category)).toEqual({ tenant: 0, admin: 0 })
      return r
    }, 'ROLLBACK')
    expect(rolledBack.wroteOff).toBe(true)
    expect((await advanceOf(h.tenantId))[0].status).not.toBe('defaulted')
    expect(await told(h.tenantUserId, category)).toEqual({ tenant: 0, admin: 0 })

    const committed = await inTransaction(async c => {
      const r = await handleFlexPayPaymentNsf(row.id, c)
      expect(await told(h.tenantUserId, category)).toEqual({ tenant: 0, admin: 0 })
      return r
    }, 'COMMIT')
    expect((await advanceOf(h.tenantId))[0].status).toBe('defaulted')
    await committed.afterCommit()
    await committed.afterCommit()          // run twice: still told once
    expect(await told(h.tenantUserId, category)).toEqual({ tenant: 1, admin: 1 })
  })

  it('a pull taken back: nobody is told before the commit, nobody at all on a rollback, once after a commit', async () => {
    const { h, row } = await pulled()
    await db.query(`UPDATE payments SET status = 'settled', settled_at = NOW() WHERE id = $1`, [row.id])
    await reconcileSettledFlexPayPayment(row.id)
    const category = 'flexpay_pull_taken_back'

    await inTransaction(async c => {
      expect(await handleFlexPayPullReversed(row.id, c, { reversalFee: 15 })).toMatchObject({ reversed: true })
      expect(await told(h.tenantUserId, category)).toEqual({ tenant: 0, admin: 0 })
    }, 'ROLLBACK')
    expect((await advanceOf(h.tenantId))[0].status).toBe('reconciled')
    expect(await told(h.tenantUserId, category)).toEqual({ tenant: 0, admin: 0 })

    const committed = await inTransaction(async c => {
      const r = await handleFlexPayPullReversed(row.id, c, { reversalFee: 15 })
      expect(await told(h.tenantUserId, category)).toEqual({ tenant: 0, admin: 0 })
      return r
    }, 'COMMIT')
    expect(committed.reversed).toBe(true)
    expect((await advanceOf(h.tenantId))[0].status).toBe('defaulted')
    await committed.afterCommit()
    await committed.afterCommit()
    expect(await told(h.tenantUserId, category)).toEqual({ tenant: 1, admin: 1 })
  })

  it('without a client the notices go out at once; afterCommit sends nothing more', async () => {
    const { h, row } = await pulled()
    await db.query(`UPDATE payments SET status = 'failed', retry_count = 0, next_retry_at = NULL WHERE id = $1`, [row.id])
    const r = await handleFlexPayPaymentNsf(row.id)
    expect(await told(h.tenantUserId, 'flexpay_advance_defaulted')).toEqual({ tenant: 1, admin: 1 })
    await r.afterCommit()
    expect(await told(h.tenantUserId, 'flexpay_advance_defaulted')).toEqual({ tenant: 1, admin: 1 })
  })
})

describe('a second bill in the same month', () => {
  it('a mid-month successor lease\'s first bill is covered under the same cycle\'s advance', async () => {
    await enablePlatform()
    const h = await seedHousehold()
    await coverFlexPayCycle(COVER_NOW)
    const next = await seedSuccessorBill(h, '2026-10-10')

    // Its last grace day: Oct 10 + 5 − 1 = Oct 14, before the Oct 20 pull.
    const r = await coverFlexPayCycle(new Date('2026-10-14T10:00:00Z'))
    expect(r).toMatchObject({ candidates_scanned: 1, bills_covered: 1, amount_covered: 500, errors: 0 })
    const advances = await advanceOf(h.tenantId)
    expect(advances).toHaveLength(1)
    const [adv] = advances
    expect(Number(adv.rent_amount)).toBe(1560)
    expect(adv.notes).toMatch(/paid 1 more bill line\(s\) from the bill due 2026-10-10, \$500\.00/)
    const line = await payment(next.rentId)
    expect(line).toMatchObject({ status: 'settled', platform_held: true, flexpay_advance_id: adv.id, notes: 'Paid on time' })
    expect(Number((await ownerShares(next.rentId))[0].amount)).toBe(500)

    const notes = await tenantNotices(h.tenantUserId)
    expect(notes).toHaveLength(2)
    expect(notes[1].title).toBe('FlexPay paid your bill due October 10')
    expect(notes[1].body).toBe(
      'FlexPay paid your bill due October 10 of $500.00 to your landlord on time, so it gets no late fee. ' +
      'On October 20, GAM collects $1,560.00, everything FlexPay paid this month, plus the $25.00 monthly fee from your bank account.')

    // The pull collects both bills and the $25 once.
    await processFlexPayPullDay(at('2026-10-20'))
    expect(createRentPlatformChargeMock.mock.calls[0][0].amount).toBe(1585)
    // A re-run of either day changes nothing.
    expect((await coverFlexPayCycle(new Date('2026-10-14T10:00:00Z'))).bills_covered).toBe(0)
    expect(Number((await advanceOf(h.tenantId))[0].rent_amount)).toBe(1560)
  })

  it('a second bill whose last grace day was missed is caught up under the same advance', async () => {
    await enablePlatform()
    const h = await seedHousehold()
    await coverFlexPayCycle(COVER_NOW)
    const next = await seedSuccessorBill(h, '2026-10-10')
    const r = await coverFlexPayCycle(new Date('2026-10-15T10:00:00Z'))
    expect(r).toMatchObject({ bills_covered: 1, amount_covered: 500 })
    expect((await payment(next.rentId)).notes).toBe('Paid')
    expect((await db.query(`SELECT 1 FROM admin_notifications WHERE category = 'flexpay_cover_late'`)).rowCount).toBe(1)
    // The day after, both bills are done: nothing is scanned.
    expect((await coverFlexPayCycle(new Date('2026-10-16T10:00:00Z'))).candidates_scanned).toBe(0)
  })

  it('a second bill that comes after the month\'s pull was written is not paid; the tenant is told by name, in the app and by email, that it is theirs to pay; an admin is told; a re-run tells nobody again', async () => {
    await enablePlatform()
    const h = await seedHousehold()
    await coverFlexPayCycle(COVER_NOW)
    await processFlexPayPullDay(at('2026-10-20'))
    const next = await seedSuccessorBill(h, '2026-10-24')
    // A water line on the same bill, credit already paid $20 of it: named at what is still open.
    const water = (await db.query<{ id: string }>(
      `INSERT INTO payments (landlord_id, tenant_id, lease_id, unit_id, invoice_id, type, amount, status,
                             entry_description, due_date, notes)
       VALUES ($1, $2, $3, $4, $5, 'utility', 60, 'pending', 'UTILITY', '2026-10-24', 'Water') RETURNING id`,
      [h.landlordId, h.tenantId, next.leaseId, h.unitId, next.invoiceId])).rows[0].id
    await applyPaidAhead(h, water, next.leaseId, 20)

    const r = await coverFlexPayCycle(new Date('2026-10-28T10:00:00Z'))
    expect(r).toMatchObject({ bills_covered: 0, advances_skipped_existing: 1 })
    expect((await payment(next.rentId)).status).toBe('pending')
    const alert = (await db.query<any>(`SELECT * FROM admin_notifications WHERE category = 'flexpay_second_bill_not_covered'`)).rows
    expect(alert).toHaveLength(1)
    expect(alert[0].body).toContain('$500.00 of bill lines open')
    expect(alert[0].body).toContain('its pull was already written')
    expect(alert[0].body).toContain('The tenant was told in the app and by email that FlexPay did not pay this bill and that it is theirs to pay.')
    expect(alert[0].context).toMatchObject({ open_amount: 500, tenant_told: true })
    // The pull's amount never changed.
    const [adv] = await advanceOf(h.tenantId)
    expect(Number(adv.rent_amount)).toBe(1060)

    const told = (await tenantNotices(h.tenantUserId)).filter((n: any) => n.type === 'flexpay_bill_not_covered')
    expect(told).toHaveLength(1)
    expect(told[0].title).toBe('FlexPay did not pay your bill due October 24')
    expect(told[0].body).toBe(
      'FlexPay did not pay your bill due October 24. GAM\'s FlexPay collection for October was already set, ' +
      'so this bill could not be added to it. Still due on it: Rent $500.00 and Water $40.00 ($540.00 in all). ' +
      'That is yours to pay on the Payments page today; your landlord\'s late fee can apply to a bill still open after today.')
    expect(told[0].body).not.toMatch(/repay|owe|loan|borrow/i)
    expect(told[0].action_url).toBe('/payments')
    expect(told[0].data).toMatchObject({ invoice_id: next.invoiceId, open_amount: 540 })
    expect(await emailsFor(told[0].id)).toHaveLength(1)
    // FlexPay never reaches the landlord: no landlord notice for the bill FlexPay did not pay.
    const landlordNotes = (await db.query<any>(`SELECT * FROM notifications WHERE user_id = $1`, [h.landlordUserId])).rows
    for (const n of landlordNotes) expect(`${n.title} ${n.body}`).not.toMatch(/flex/i)

    // A second run the same day tells nobody again.
    await coverFlexPayCycle(new Date('2026-10-28T11:00:00Z'))
    expect((await tenantNotices(h.tenantUserId)).filter((n: any) => n.type === 'flexpay_bill_not_covered')).toHaveLength(1)
    expect((await db.query(`SELECT 1 FROM admin_notifications WHERE category = 'flexpay_second_bill_not_covered'`)).rowCount).toBe(1)
  })
})

describe('the cover tells the tenant what is still due', () => {
  it('a bill with an open deposit after the cover never promises no late fee, and names what is still due', async () => {
    await enablePlatform()
    const h = await seedHousehold()
    await addLine(h, { type: 'deposit', entry: 'DEPOSIT', amount: 200 })
    await coverFlexPayCycle(COVER_NOW)
    const [n] = await tenantNotices(h.tenantUserId)
    expect(n.body).toBe(
      'FlexPay paid your October bill of $1,060.00 to your landlord on time. ' +
      'On October 20, GAM collects $1,060.00 plus the $25.00 monthly fee from your bank account. ' +
      'Still due on this bill: Security deposit $200.00. ' +
      'Pay what is still due on the Payments page today; your landlord\'s late fee can apply to a bill still open after today.')
    expect(n.body).not.toMatch(/no late fee|repay|owe|loan|borrow/i)
    expect(n.action_url).toBe('/payments')
    expect(n.data.still_due).toEqual([{ label: 'Security deposit', amount: 200 }])
  })

  it('a cover that leaves something due is emailed as well; a bill FlexPay paid in full is told in the app only', async () => {
    await enablePlatform()
    const full = await seedHousehold()
    const partly = await seedHousehold()
    await addLine(partly, { type: 'deposit', entry: 'DEPOSIT', amount: 200 })
    await coverFlexPayCycle(COVER_NOW)

    const [paid] = await tenantNotices(full.tenantUserId)
    expect(paid.type).toBe('flexpay_bill_covered')
    expect(await emailsFor(paid.id)).toHaveLength(0)

    const [due] = await tenantNotices(partly.tenantUserId)
    expect(due.type).toBe('flexpay_bill_covered')
    const sent = await emailsFor(due.id)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ subject: 'FlexPay paid your October bill', category: 'notif_flexpay_bill_covered' })
    const { rows: [u] } = await db.query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [partly.tenantUserId])
    expect(sent[0].to_email).toBe(u.email)
  })

  it('a superseded pull\'s other lines are named to the tenant as still due', async () => {
    await enablePlatform()
    const h = await seedHousehold()
    const retry = { status: 'failed', intent: 'pi_tenant_bounce', nextRetryAt: '2026-10-07T07:00:00Z' }
    await addLine(h, { type: 'fee', entry: 'SUBSCRIP', amount: 40, ...retry })
    await addLine(h, { type: 'fee', entry: 'DECLINEFEE', amount: 1, revenueOwner: 'gam', ...retry })
    // An older month's late fee rode the same bank pull, on no invoice of this month.
    await db.query(
      `INSERT INTO payments (landlord_id, tenant_id, lease_id, unit_id, type, amount, status, entry_description,
                             due_date, stripe_payment_intent_id, next_retry_at)
       VALUES ($1, $2, $3, $4, 'late_fee', 25, 'failed', 'LATEFEE', '2026-09-06', 'pi_tenant_bounce', '2026-10-07T07:00:00Z')`,
      [h.landlordId, h.tenantId, h.leaseId, h.unitId])

    await coverFlexPayCycle(COVER_NOW)
    const [n] = await tenantNotices(h.tenantUserId)
    expect(n.body).toMatch(/^FlexPay paid your October bill of \$1,100\.00 to your landlord on time\. /)
    expect(n.body).toContain('The bank payment that was set to be tried again is called off, because FlexPay paid the bill.')
    expect(n.body).toContain('Late fee $25.00')
    expect(n.body).toContain('Declined-payment fee $1.00')
    expect(n.body).toContain('($26.00 in all), which are still due.')
    // The GAM fee sits on this bill, so the late-fee run can still fire: no promise, and "today".
    expect(n.body).not.toMatch(/no late fee/)
    expect(n.body).toMatch(/Pay what is still due on the Payments page today/)
    expect(n.body).not.toMatch(/repay|owe|loan|borrow/i)
    expect(n.action_url).toBe('/payments')
    expect(n.data.retry_called_off.map((x: any) => x.amount).sort()).toEqual([1, 25])
    expect(n.data.still_due).toEqual([])
  })

  it('a covered row with a stale boost pays the landlord in full', async () => {
    await enablePlatform()
    const h = await seedHousehold()
    // The legacy single-row pay route stamped a $100 GAM-first boost on rent
    // when it charged; the charge failed, so the boost never arrived.
    await db.query(`UPDATE payments SET status = 'failed', stripe_payment_intent_id = 'pi_old_fail',
                                        gam_supersedence_amount = 100 WHERE id = $1`, [h.rentId])
    await coverFlexPayCycle(COVER_NOW)
    const rent = await payment(h.rentId)
    expect(rent.status).toBe('settled')
    expect(Number(rent.gam_supersedence_amount)).toBe(0)
    expect(Number((await ownerShares(h.rentId))[0].amount)).toBe(1000)
  })

  it('a late catch-up of a bill the tenant already paid still tells the admin the $25 is taken on the pull date', async () => {
    await enablePlatform()
    const h = await seedHousehold()
    await db.query(`UPDATE payments SET status = 'settled', settled_at = NOW(), manual_method = 'cash'
                     WHERE id = ANY($1::uuid[])`, [[h.rentId, h.waterId]])
    const r = await coverFlexPayCycle(new Date('2026-10-06T10:00:00Z'))
    expect(r.paid_already).toBe(1)
    const alert = (await db.query<any>(`SELECT * FROM admin_notifications WHERE category = 'flexpay_cover_late'`)).rows
    expect(alert).toHaveLength(1)
    expect(alert[0].body).toContain('the bill had been paid another way, so FlexPay paid nothing')
    expect(alert[0].body).toContain('The tenant will still be charged the $25.00 monthly fee for this month on 2026-10-20.')
    expect(alert[0].context).toMatchObject({ monthly_fee: 25, pull_date: '2026-10-20' })
  })
})

describe('the pull: an unknown outcome and an intent GAM finds already failed', () => {
  async function covered() {
    await enablePlatform()
    const h = await seedHousehold()
    await db.query(`UPDATE tenants SET ssi_ssdi = TRUE, ach_verified = TRUE WHERE id = $1`, [h.tenantId])
    await coverFlexPayCycle(COVER_NOW)
    const [adv] = await advanceOf(h.tenantId)
    return { h, adv }
  }

  /** Run 1 loses the create reply; run 2's search finds `found`. */
  async function adopt(found: Record<string, unknown>) {
    createRentPlatformChargeMock.mockRejectedValueOnce(new Error('timeout'))
    await processFlexPayPullDay(at('2026-10-20'))
    stripeMocks.paymentIntentsSearch.mockResolvedValueOnce({ data: [found] } as any)
    await processFlexPayPullDay(at('2026-10-21'))
  }

  it('an idempotency error on the third run never writes the advance off', async () => {
    const { h } = await covered()
    createRentPlatformChargeMock.mockRejectedValue(Object.assign(
      new Error('Keys for idempotent requests can only be used with the same parameters they were first used with.'),
      { type: 'StripeIdempotencyError', rawType: 'idempotency_error' }))
    for (const day of ['2026-10-20', '2026-10-21', '2026-10-22']) {
      expect((await processFlexPayPullDay(at(day))).advances_defaulted).toBe(0)
    }
    const [a] = await advanceOf(h.tenantId)
    expect(a).toMatchObject({ status: 'fronted', pull_attempts: 3, default_reason: null })
    expect((await db.query(`SELECT 1 FROM admin_notifications WHERE category = 'flexpay_pull_unconfirmed'`)).rowCount).toBe(1)
    expect((await db.query<any>(`SELECT flexpay_enrolled FROM tenants WHERE id = $1`, [h.tenantId])).rows[0].flexpay_enrolled).toBe(true)
  })

  it('an adopted intent that bounced for a reason worth retrying is tried again on the FlexPay schedule, never written off', async () => {
    const { h, adv } = await covered()
    await adopt({ id: 'pi_short', status: 'requires_payment_method', payment_method_types: ['us_bank_account'],
                  last_payment_error: { type: 'card_error', code: 'insufficient_funds', payment_method: { type: 'us_bank_account' } } })
    const [row] = await pullRowOf(adv.id)
    const { rows: [day] } = await db.query<{ d: string }>(
      `SELECT ((NOW() AT TIME ZONE 'America/Phoenix')::date + 3)::text AS d`)
    expect(row).toMatchObject({ status: 'failed', return_code: 'R01', stripe_payment_intent_id: 'pi_short' })
    const { rows: [due] } = await db.query<{ d: string }>(
      `SELECT (next_retry_at AT TIME ZONE 'America/Phoenix')::text AS d FROM payments WHERE id = $1`, [row.id])
    expect(due.d).toBe(`${day.d} 00:00:00`)
    const [a] = await advanceOf(h.tenantId)
    expect(a.status).toBe('pulled')
    expect((await db.query<any>(`SELECT flexpay_enrolled FROM tenants WHERE id = $1`, [h.tenantId])).rows[0].flexpay_enrolled).toBe(true)
    const notes = (await tenantNotices(h.tenantUserId)).filter((n: any) => n.type === 'flexpay_pull_retry')
    expect(notes).toHaveLength(1)
    expect(notes[0].body).toMatch(/^GAM's FlexPay collection of \$1,085\.00 from your bank account did not go through\. GAM tries again on /)
    expect(notes[0].body).toContain(' and collects $1,089.00. That includes $4.00, the fee GAM is charged when a bank sends a payment back, passed on at cost.')
    expect(notes[0].body).not.toMatch(/repay|owe|loan|borrow/i)
    expect(notes[0].data).toMatchObject({ failed_amount: 1085, retry_amount: 1089, bounces: 1 })
    expect(await emailsFor(notes[0].id)).toHaveLength(1)

    // The retry pulls exactly what the notice said: the reprice after the retry run claims it.
    await db.query(`UPDATE payments SET retry_count = 1 WHERE id = $1`, [row.id])
    await repriceFlexPayRetryPayment(row.id)
    expect(Number((await payment(row.id)).amount)).toBe(1089)
  })

  it('a notice for a second bounce states what the second retry pulls: both returned-pull fees, the same figure the reprice sets', async () => {
    const { h, adv } = await covered()
    await processFlexPayPullDay(at('2026-10-20'))
    const [row] = await pullRowOf(adv.id)
    // The first retry already fired (and was repriced) and bounced too.
    await db.query(`UPDATE payments SET retry_count = 1 WHERE id = $1`, [row.id])
    await repriceFlexPayRetryPayment(row.id)
    expect(Number((await payment(row.id)).amount)).toBe(1089)
    await db.query(`UPDATE payments SET status = 'failed', next_retry_at = NOW() + interval '3 days' WHERE id = $1`, [row.id])

    await notifyTenantPullRetry(row.id, '2026-10-27')
    const [n] = (await tenantNotices(h.tenantUserId)).filter((x: any) => x.type === 'flexpay_pull_retry')
    expect(n.title).toBe('FlexPay: GAM tries your bank again on October 27')
    expect(n.body).toBe(
      'GAM\'s FlexPay collection of $1,089.00 from your bank account did not go through. ' +
      'GAM tries again on October 27 and collects $1,093.00. ' +
      'That includes $8.00: $4.00 for each of the 2 times your bank sent this payment back, the fee GAM is charged, passed on at cost. ' +
      'Please have the money in the account by then.')
    expect(n.data).toMatchObject({ failed_amount: 1089, retry_amount: 1093, bounces: 2, returned_pull_fees: 8 })

    await db.query(`UPDATE payments SET retry_count = 2 WHERE id = $1`, [row.id])
    await repriceFlexPayRetryPayment(row.id)
    expect(Number((await payment(row.id)).amount)).toBe(1093)
  })

  it('an adopted intent that bounced for good writes the advance off as the tenant\'s', async () => {
    const { h, adv } = await covered()
    await adopt({ id: 'pi_closed', status: 'requires_payment_method', payment_method_types: ['us_bank_account'],
                  last_payment_error: { type: 'card_error', code: 'account_closed', payment_method: { type: 'us_bank_account' } } })
    expect((await pullRowOf(adv.id))[0]).toMatchObject({ status: 'failed', return_code: 'R02', next_retry_at: null })
    const [a] = await advanceOf(h.tenantId)
    expect(a).toMatchObject({ status: 'defaulted', default_reason: FLEXPAY_DEFAULT_REASONS.pullNotCollected })
    expect(Number(a.tenant_fee_amount)).toBe(25 + FLEXPAY_ACH_RETURN_FEE)
    const t = (await db.query<any>(`SELECT flexpay_disqualified_until FROM tenants WHERE id = $1`, [h.tenantId])).rows[0]
    expect(t.flexpay_disqualified_until).not.toBeNull()
  })

  it('an adopted intent refused as an invalid request is GAM\'s: made again, no wait, no mark and no fee', async () => {
    const { h, adv } = await covered()
    await adopt({ id: 'pi_mandate', status: 'requires_payment_method', payment_method_types: ['us_bank_account'],
                  last_payment_error: { type: 'invalid_request_error', code: 'payment_intent_mandate_invalid' } })
    const [a] = await advanceOf(h.tenantId)
    expect(a).toMatchObject({ status: 'fronted', default_reason: null })
    expect(Number(a.tenant_fee_amount)).toBe(25)
    expect((await pullRowOf(adv.id))[0]).toMatchObject({ status: 'pending', stripe_payment_intent_id: null, return_reason: FLEXPAY_PULL_REQUEUED_REASON })
    const t = (await db.query<any>(
      `SELECT flexpay_enrolled, flexpay_disqualified_until, flexpay_permanently_banned FROM tenants WHERE id = $1`,
      [h.tenantId])).rows[0]
    expect(t).toMatchObject({ flexpay_enrolled: true, flexpay_disqualified_until: null, flexpay_permanently_banned: false })
  })

  it('an adopted intent the bank refused for a reason no R-code maps is the tenant\'s bank: written off, never made again', async () => {
    const { h, adv } = await covered()
    await adopt({ id: 'pi_frozen', status: 'requires_payment_method', payment_method_types: ['us_bank_account'],
                  last_payment_error: { type: 'card_error', code: 'account_frozen', payment_method: { type: 'us_bank_account' } } })
    const [row] = await pullRowOf(adv.id)
    expect(row).toMatchObject({ status: 'failed', next_retry_at: null, stripe_payment_intent_id: 'pi_frozen' })
    expect(row.return_reason).not.toBe(FLEXPAY_PULL_REQUEUED_REASON)
    const [a] = await advanceOf(h.tenantId)
    expect(a).toMatchObject({ status: 'defaulted', default_reason: FLEXPAY_DEFAULT_REASONS.pullNotCollected })
    expect(Number(a.tenant_fee_amount)).toBe(25 + FLEXPAY_ACH_RETURN_FEE)
    expect((await db.query(`SELECT 1 FROM admin_notifications WHERE category = 'flexpay_pull_gam_side'`)).rowCount).toBe(0)
  })

  it('a canceled intent is never adopted: GAM makes the collection with a fresh intent, nothing held against the tenant', async () => {
    const { h, adv } = await covered()
    createRentPlatformChargeMock.mockRejectedValueOnce(new Error('timeout'))
    await processFlexPayPullDay(at('2026-10-20'))
    stripeMocks.paymentIntentsSearch.mockResolvedValueOnce({ data: [{ id: 'pi_gone', status: 'canceled' }] } as any)
    createRentPlatformChargeMock.mockResolvedValueOnce({ id: 'pi_fresh', status: 'processing' })
    expect((await processFlexPayPullDay(at('2026-10-21'))).pulls_initiated).toBe(1)
    const [a] = await advanceOf(h.tenantId)
    expect(a).toMatchObject({ status: 'pulled', default_reason: null })
    const [row] = await pullRowOf(adv.id)
    expect(row.stripe_payment_intent_id).toBe('pi_fresh')
    const lastCall = createRentPlatformChargeMock.mock.calls[createRentPlatformChargeMock.mock.calls.length - 1] as any[]
    expect(lastCall[0].idempotencyKey).toBe(`flexpay_pull_${row.id}_2`)
    const t = (await db.query<any>(`SELECT flexpay_enrolled, flexpay_disqualified_until FROM tenants WHERE id = $1`, [h.tenantId])).rows[0]
    expect(t).toMatchObject({ flexpay_enrolled: true, flexpay_disqualified_until: null })
  })
})

describe('handleFlexPayPaymentNsf — a write-off GAM caused adds no bounce it did not incur', () => {
  it('a GAM-side failure adds no bounce fee it did not incur', async () => {
    await enablePlatform()
    const h = await seedHousehold()
    await coverFlexPayCycle(COVER_NOW)
    await processFlexPayPullDay(at('2026-10-20'))
    const [adv] = await advanceOf(h.tenantId)
    const [row] = await pullRowOf(adv.id)
    // GAM ended the pull before any try bounced (retry_count 0).
    await db.query(`UPDATE payments SET status = 'failed', retry_count = 0, next_retry_at = NULL WHERE id = $1`, [row.id])
    await handleFlexPayPaymentNsf(row.id, undefined, { gamSide: true })
    const [a] = await advanceOf(h.tenantId)
    expect(a.status).toBe('fronted')
    expect(Number(a.tenant_fee_amount)).toBe(25)
    expect(Number((await payment(row.id)).amount)).toBe(1085)
  })
})

describe('handleFlexPayPullReversed — a settled pull taken back by the bank', () => {
  async function settledPull(o: { retryCount?: number } = {}) {
    await enablePlatform()
    const h = await seedHousehold()
    await db.query(`UPDATE tenants SET ssi_ssdi = TRUE, ach_verified = TRUE WHERE id = $1`, [h.tenantId])
    await coverFlexPayCycle(COVER_NOW)
    await processFlexPayPullDay(at('2026-10-20'))
    const [adv] = await advanceOf(h.tenantId)
    const [row] = await pullRowOf(adv.id)
    await db.query(`UPDATE payments SET status = 'settled', settled_at = NOW(), retry_count = $2 WHERE id = $1`,
      [row.id, o.retryCount ?? 0])
    await reconcileSettledFlexPayPayment(row.id)
    return { h, adv, row }
  }
  const feeBook = async () => (await db.query<any>(
    `SELECT type, amount::float AS amount, reference_type FROM platform_revenue_ledger
      WHERE type IN ('flexpay_subscription', 'adjustment') ORDER BY created_at, id`)).rows

  it('a disputed FlexPay pull re-defaults the advance, reverses the $25 and is recovered once by GAM-first routing', async () => {
    const { h, adv, row } = await settledPull({ retryCount: 1 })
    expect((await advanceOf(h.tenantId))[0].status).toBe('reconciled')
    expect(await feeBook()).toEqual([{ type: 'flexpay_subscription', amount: 25, reference_type: 'flexpay_advance' }])

    // The bank took the pull back 40 days on; Stripe kept a $15 dispute fee.
    expect(await handleFlexPayPullReversed(row.id, undefined, { reversalFee: 15 })).toMatchObject({ reversed: true })
    expect((await payment(row.id)).status).toBe('returned')
    const [a] = await advanceOf(h.tenantId)
    expect(a).toMatchObject({ status: 'defaulted', default_reason: FLEXPAY_DEFAULT_REASONS.pullNotCollected, reconciled_at: null })
    expect(a.defaulted_at).not.toBeNull()
    // $25 + one bounce before it cleared ($4) + Stripe's $15: GAM keeps no fee.
    expect(Number(a.tenant_fee_amount)).toBe(44)
    expect(await feeBook()).toEqual([
      { type: 'flexpay_subscription', amount: 25, reference_type: 'flexpay_advance' },
      { type: 'adjustment', amount: -25, reference_type: 'flexpay_advance_reversal' },
    ])
    // The tenant's mark, as for any write-off at their bank: the rejoin wait.
    const t = (await db.query<any>(
      `SELECT flexpay_enrolled, flexpay_disqualified_until, flexpay_permanently_banned, flexpay_clean_streak FROM tenants WHERE id = $1`,
      [h.tenantId])).rows[0]
    expect(t).toMatchObject({ flexpay_enrolled: false, flexpay_permanently_banned: false, flexpay_clean_streak: 0 })
    expect(t.flexpay_disqualified_until).not.toBeNull()
    const alert = (await db.query<any>(`SELECT * FROM admin_notifications WHERE category = 'flexpay_pull_taken_back'`)).rows
    expect(alert).toHaveLength(1)
    expect(alert[0].severity).toBe('critical')
    expect(alert[0].body).toContain('$1104.00, including $19.00 of Stripe fees passed on at cost')
    // The pull row carries the stamp that makes this happen once.
    expect((await payment(row.id)).return_reason).toBe(FLEXPAY_PULL_TAKEN_BACK_REASON)
    // The tenant is told, in plain words.
    const ended = (await tenantNotices(h.tenantUserId)).filter((n: any) => n.type === 'flexpay_ended')
    expect(ended).toHaveLength(1)
    expect(ended[0].body).toMatch(/^Your bank took back the FlexPay payment GAM collected for your October bill, so your FlexPay has ended\. \$1,104\.00 from FlexPay is still open with GAM\./)
    expect(ended[0].body).not.toMatch(/repay|\bowe|loan|borrow|debt/i)

    // A redelivered dispute changes nothing.
    expect(await handleFlexPayPullReversed(row.id, undefined, { reversalFee: 15 })).toMatchObject({ reversed: false })
    expect(Number((await advanceOf(h.tenantId))[0].tenant_fee_amount)).toBe(44)
    expect(await feeBook()).toHaveLength(2)

    // GAM-first routing recovers the whole of it, once.
    const { computeTenantGamOutstanding, applyTenantSupersedence } = await import('./supersedence')
    expect(await computeTenantGamOutstanding(h.tenantId)).toEqual([
      expect.objectContaining({ source: 'flexpay_advance', ref_id: adv.id, amount: 1104 })])
    const later = async (boost: number, due: string) => (await db.query<{ id: string }>(
      `INSERT INTO payments (landlord_id, tenant_id, lease_id, unit_id, type, amount, status, entry_description,
                             due_date, gam_supersedence_amount)
       VALUES ($1, $2, $3, $4, 'rent', 1000, 'settled', 'RENT', $6, $5) RETURNING id`,
      [h.landlordId, h.tenantId, h.leaseId, h.unitId, boost, due])).rows[0].id
    const apply = async (id: string) => {
      const c = await db.connect()
      try { await c.query('BEGIN'); const r = await applyTenantSupersedence(c, id); await c.query('COMMIT'); return r }
      finally { c.release() }
    }
    expect(await apply(await later(1104, '2026-11-01'))).toMatchObject({ amount_distributed: 1104, amount_residual: 0 })
    expect(await apply(await later(1104, '2026-12-01'))).toMatchObject({ amount_distributed: 0, amount_residual: 1104 })
    expect((await advanceOf(h.tenantId))[0].status).toBe('reconciled')

    // Recovered, the $25 is booked again — once.
    await bookFlexPayFee(adv.id)
    await bookFlexPayFee(adv.id)
    const book = await feeBook()
    expect(book).toHaveLength(3)
    expect(book[2]).toEqual({ type: 'flexpay_subscription', amount: 25, reference_type: 'flexpay_advance_rebooked_1' })
    expect(book.reduce((s: number, r: any) => s + r.amount, 0)).toBe(25)
  })

  it('a dispute redelivered after GAM-first recovery changes nothing: no second fee, no second reversal, GAM balance 0', async () => {
    const { h, adv, row } = await settledPull({ retryCount: 1 })
    expect(await handleFlexPayPullReversed(row.id, undefined, { reversalFee: 15 })).toMatchObject({ reversed: true })

    // GAM-first routing recovers the $1,104 from the tenant's next payment;
    // the recovery books the $25 again (services/supersedence).
    const { computeTenantGamOutstanding, applyTenantSupersedence } = await import('./supersedence')
    const { rows: [later] } = await db.query<{ id: string }>(
      `INSERT INTO payments (landlord_id, tenant_id, lease_id, unit_id, type, amount, status, entry_description,
                             due_date, gam_supersedence_amount)
       VALUES ($1, $2, $3, $4, 'rent', 1000, 'settled', 'RENT', '2026-11-01', 1104) RETURNING id`,
      [h.landlordId, h.tenantId, h.leaseId, h.unitId])
    const c = await db.connect()
    try { await c.query('BEGIN'); await applyTenantSupersedence(c, later.id); await c.query('COMMIT') }
    finally { c.release() }
    expect((await advanceOf(h.tenantId))[0].status).toBe('reconciled')
    const bookAfterRecovery = await feeBook()
    expect(bookAfterRecovery).toEqual([
      { type: 'flexpay_subscription', amount: 25, reference_type: 'flexpay_advance' },
      { type: 'adjustment', amount: -25, reference_type: 'flexpay_advance_reversal' },
      { type: 'flexpay_subscription', amount: 25, reference_type: 'flexpay_advance_rebooked_1' },
    ])

    // Stripe redelivers the dispute (or a late return arrives for the same pull).
    expect(await handleFlexPayPullReversed(row.id, undefined, { reversalFee: 15 })).toMatchObject({ reversed: false })
    const [a] = await advanceOf(h.tenantId)
    expect(a).toMatchObject({ id: adv.id, status: 'reconciled' })
    expect(Number(a.tenant_fee_amount)).toBe(44)                 // no second dispute fee
    expect(await feeBook()).toEqual(bookAfterRecovery)           // no second reversal
    expect(await computeTenantGamOutstanding(h.tenantId)).toEqual([])   // GAM balance 0
    expect((await db.query(`SELECT 1 FROM admin_notifications WHERE category = 'flexpay_pull_taken_back'`)).rowCount).toBe(1)
    expect((await tenantNotices(h.tenantUserId)).filter((n: any) => n.type === 'flexpay_ended')).toHaveLength(1)
  })

  it('a pull whose stamp was overwritten after recovery is still never written off twice', async () => {
    const { h, adv, row } = await settledPull({ retryCount: 1 })
    expect(await handleFlexPayPullReversed(row.id, undefined, { reversalFee: 15 })).toMatchObject({ reversed: true })
    const { computeTenantGamOutstanding, applyTenantSupersedence } = await import('./supersedence')
    const { rows: [later] } = await db.query<{ id: string }>(
      `INSERT INTO payments (landlord_id, tenant_id, lease_id, unit_id, type, amount, status, entry_description,
                             due_date, gam_supersedence_amount)
       VALUES ($1, $2, $3, $4, 'rent', 1000, 'settled', 'RENT', '2026-11-01', 1104) RETURNING id`,
      [h.landlordId, h.tenantId, h.leaseId, h.unitId])
    const c = await db.connect()
    try { await c.query('BEGIN'); await applyTenantSupersedence(c, later.id); await c.query('COMMIT') }
    finally { c.release() }
    expect((await advanceOf(h.tenantId))[0].status).toBe('reconciled')
    const bookAfterRecovery = await feeBook()

    // Another writer (the returned-payment route) overwrites the row's stamp.
    await db.query(
      `UPDATE payments SET status = 'returned', return_code = 'R10', return_reason = 'Customer advises not authorized'
        WHERE id = $1`, [row.id])
    expect(await handleFlexPayPullReversed(row.id, undefined, { reversalFee: 15 })).toMatchObject({ reversed: false })
    const [a] = await advanceOf(h.tenantId)
    expect(a).toMatchObject({ id: adv.id, status: 'reconciled' })
    expect(Number(a.tenant_fee_amount)).toBe(44)                 // the $15 dispute fee once, not twice
    expect(await feeBook()).toEqual(bookAfterRecovery)           // no second reversal
    expect(await computeTenantGamOutstanding(h.tenantId)).toEqual([])   // never taken from the tenant again
    expect((await db.query(`SELECT 1 FROM admin_notifications WHERE category = 'flexpay_pull_taken_back'`)).rowCount).toBe(1)
    expect((await tenantNotices(h.tenantUserId)).filter((n: any) => n.type === 'flexpay_ended')).toHaveLength(1)
  })

  it('a pull that failed, was written off and recovered, then marked returned by another writer, is never written off again', async () => {
    await enablePlatform()
    const h = await seedHousehold()
    await db.query(`UPDATE tenants SET ssi_ssdi = TRUE, ach_verified = TRUE WHERE id = $1`, [h.tenantId])
    await coverFlexPayCycle(COVER_NOW)
    await processFlexPayPullDay(at('2026-10-20'))
    const [adv] = await advanceOf(h.tenantId)
    const [row] = await pullRowOf(adv.id)
    await db.query(`UPDATE payments SET status = 'failed', retry_count = 0, next_retry_at = NULL WHERE id = $1`, [row.id])
    await handleFlexPayPaymentNsf(row.id)
    const { rows: [later] } = await db.query<{ id: string }>(
      `INSERT INTO payments (landlord_id, tenant_id, lease_id, unit_id, type, amount, status, entry_description,
                             due_date, gam_supersedence_amount)
       VALUES ($1, $2, $3, $4, 'rent', 1000, 'settled', 'RENT', '2026-11-01', 1089) RETURNING id`,
      [h.landlordId, h.tenantId, h.leaseId, h.unitId])
    const { applyTenantSupersedence } = await import('./supersedence')
    const c = await db.connect()
    try { await c.query('BEGIN'); await applyTenantSupersedence(c, later.id); await c.query('COMMIT') }
    finally { c.release() }
    expect((await advanceOf(h.tenantId))[0].status).toBe('reconciled')
    const bookBefore = await feeBook()
    await db.query(`UPDATE payments SET status = 'returned', return_code = 'R01' WHERE id = $1`, [row.id])
    expect(await handleFlexPayPullReversed(row.id)).toMatchObject({ reversed: false })
    expect((await advanceOf(h.tenantId))[0]).toMatchObject({ status: 'reconciled' })
    expect(await feeBook()).toEqual(bookBefore)
    expect((await db.query(`SELECT 1 FROM admin_notifications WHERE category = 'flexpay_pull_taken_back'`)).rowCount).toBe(0)
  })

  it('a pull a caller already marked returned (without the stamp) is still written off once', async () => {
    const { h, row } = await settledPull()
    await db.query(`UPDATE payments SET status = 'returned', return_code = 'R10' WHERE id = $1`, [row.id])
    expect(await handleFlexPayPullReversed(row.id)).toMatchObject({ reversed: true })
    expect(await payment(row.id)).toMatchObject({ status: 'returned', return_code: 'R10', return_reason: FLEXPAY_PULL_TAKEN_BACK_REASON })
    expect((await advanceOf(h.tenantId))[0].status).toBe('defaulted')
    expect(await handleFlexPayPullReversed(row.id)).toMatchObject({ reversed: false })
  })

  it('a second disputed pull bans for good', async () => {
    const { h, row } = await settledPull()
    await db.query(
      `INSERT INTO flexpay_advances (cycle_month, tenant_id, landlord_id, unit_id, lease_id,
                                     rent_amount, tenant_fee_amount, pull_day, status, defaulted_at, default_reason, reconciled_at)
       VALUES ('2026-06-01', $1, $2, $3, $4, 900, 25, 20, 'reconciled', NOW() - interval '90 days', $5, NOW() - interval '60 days')`,
      [h.tenantId, h.landlordId, h.unitId, h.leaseId, FLEXPAY_DEFAULT_REASONS.pullNotCollected])
    await handleFlexPayPullReversed(row.id)
    const t = (await db.query<any>(
      `SELECT flexpay_permanently_banned, flexpay_disqualified_reason, flexpay_disqualified_until FROM tenants WHERE id = $1`,
      [h.tenantId])).rows[0]
    expect(t).toMatchObject({ flexpay_permanently_banned: true, flexpay_disqualified_reason: 'permanent_second_default',
                              flexpay_disqualified_until: null })
    const alert = (await db.query<any>(`SELECT title FROM admin_notifications WHERE category = 'flexpay_pull_taken_back'`)).rows
    expect(alert[0].title).toMatch(/ended for good/)
  })

  it('a pull taken back that had recovered an earlier written-off advance writes that one off again, and names any other GAM balance it paid', async () => {
    const { h, row } = await settledPull()
    const { rows: [earlier] } = await db.query<{ id: string }>(
      `INSERT INTO flexpay_advances (cycle_month, tenant_id, landlord_id, unit_id, lease_id,
                                     rent_amount, tenant_fee_amount, pull_day, status, defaulted_at, default_reason, reconciled_at)
       VALUES ('2026-08-01', $1, $2, $3, $4, 440, 25, 20, 'reconciled', NOW() - interval '50 days', $5, NOW())
       RETURNING id`,
      [h.tenantId, h.landlordId, h.unitId, h.leaseId, FLEXPAY_DEFAULT_REASONS.pullNotCollected])
    await bookFlexPayFee(earlier.id)     // its recovery booked its $25
    await db.query(
      `UPDATE payments SET gam_supersedence_amount = 515, gam_supersedence_applied_at = NOW(),
              gam_supersedence_breakdown = $2::jsonb WHERE id = $1`,
      [row.id, JSON.stringify([
        { source: 'flexpay_advance', ref_id: earlier.id, amount: 465, satisfied_at: '2026-10-22T00:00:00Z' },
        { source: 'flexcharge_statement', ref_id: '11111111-1111-1111-1111-111111111111', amount: 50, satisfied_at: '2026-10-22T00:00:00Z' },
      ])])
    await handleFlexPayPullReversed(row.id)
    const e = (await db.query<any>(`SELECT status, reconciled_at FROM flexpay_advances WHERE id = $1`, [earlier.id])).rows[0]
    expect(e).toMatchObject({ status: 'defaulted', reconciled_at: null })
    const reversals = (await db.query<any>(
      `SELECT reference_id, amount::float AS amount FROM platform_revenue_ledger WHERE type = 'adjustment' ORDER BY reference_id`)).rows
    expect(reversals.map((r: any) => r.amount)).toEqual([-25, -25])
    const alert = (await db.query<any>(`SELECT body, context FROM admin_notifications WHERE category = 'flexpay_pull_taken_back'`)).rows[0]
    expect(alert.context.also_written_off).toEqual([earlier.id])
    // Named in plain words, never by the routing's source code.
    expect(alert.body).toContain('FlexCharge statement 11111111-1111-1111-1111-111111111111 ($50.00)')
    expect(alert.body).not.toContain('flexcharge_statement')
  })

  it('a bill line, a pull that never settled, or an unknown id is never treated as taken back', async () => {
    await enablePlatform()
    const h = await seedHousehold()
    await coverFlexPayCycle(COVER_NOW)
    await processFlexPayPullDay(at('2026-10-20'))
    const [adv] = await advanceOf(h.tenantId)
    const [row] = await pullRowOf(adv.id)
    expect(await handleFlexPayPullReversed(h.rentId)).toMatchObject({ reversed: false })
    expect(await handleFlexPayPullReversed(row.id)).toMatchObject({ reversed: false })        // still processing
    expect(await handleFlexPayPullReversed('00000000-0000-0000-0000-000000000000')).toMatchObject({ reversed: false })
    expect((await advanceOf(h.tenantId))[0].status).toBe('pulled')
  })
})

// ─── lock order ────────────────────────────────────────────────

describe('lock order: the tenant row before the advance, as the cover takes them', () => {
  /**
   * Hold the tenant row in another transaction, start `run`, and wait until it
   * is blocked on a lock. Then try the advance row with NOWAIT: a path that took
   * the advance first and then waited on the tenant would be holding it — the
   * cover's order (tenant, then advance) reversed, which deadlocks against a
   * cover of a second bill running at the same moment (Postgres aborts one).
   */
  async function whileTenantHeld(tenantId: string, advanceId: string, run: () => Promise<unknown>) {
    const holder = await db.connect()
    const probe = await db.connect()
    let pending: Promise<unknown> | null = null
    let blocked = false
    let advanceFree = false
    try {
      await holder.query('BEGIN')
      await holder.query(`SELECT 1 FROM tenants WHERE id = $1 FOR UPDATE`, [tenantId])
      pending = run()
      pending.catch(() => {})
      for (let i = 0; i < 150 && !blocked; i++) {
        blocked = ((await probe.query(`SELECT 1 FROM pg_locks WHERE NOT granted`)).rowCount ?? 0) > 0
        if (!blocked) await new Promise(r => setTimeout(r, 20))
      }
      await probe.query('BEGIN')
      try {
        await probe.query(`SELECT 1 FROM flexpay_advances WHERE id = $1 FOR UPDATE NOWAIT`, [advanceId])
        advanceFree = true
      } catch (e: any) {
        if (e?.code !== '55P03') throw e
      }
      await probe.query('ROLLBACK')
    } finally {
      await holder.query('ROLLBACK').catch(() => {})
      holder.release()
      probe.release()
    }
    await pending
    return { blocked, advanceFree }
  }

  async function pulled() {
    await enablePlatform()
    const h = await seedHousehold()
    await db.query(`UPDATE tenants SET ssi_ssdi = TRUE, ach_verified = TRUE WHERE id = $1`, [h.tenantId])
    await coverFlexPayCycle(COVER_NOW)
    await processFlexPayPullDay(at('2026-10-20'))
    const [adv] = await advanceOf(h.tenantId)
    const [row] = await pullRowOf(adv.id)
    return { h, adv, row }
  }

  it('a terminal pull failure waits on the tenant row before it touches the advance', async () => {
    const { h, adv, row } = await pulled()
    await db.query(`UPDATE payments SET status = 'failed', retry_count = 0, next_retry_at = NULL WHERE id = $1`, [row.id])
    const seen = await whileTenantHeld(h.tenantId, adv.id, () => handleFlexPayPaymentNsf(row.id))
    expect(seen).toEqual({ blocked: true, advanceFree: true })
    expect((await advanceOf(h.tenantId))[0].status).toBe('defaulted')
  })

  it('a pull taken back waits on the tenant row before it touches the pull row or the advance', async () => {
    const { h, adv, row } = await pulled()
    await db.query(`UPDATE payments SET status = 'settled', settled_at = NOW() WHERE id = $1`, [row.id])
    await reconcileSettledFlexPayPayment(row.id)
    const seen = await whileTenantHeld(h.tenantId, adv.id,
      () => handleFlexPayPullReversed(row.id, undefined, { reversalFee: 15 }))
    expect(seen).toEqual({ blocked: true, advanceFree: true })
    expect((await advanceOf(h.tenantId))[0].status).toBe('defaulted')
  })

  it('the settle\'s reconcile, inside the caller\'s transaction, waits on the tenant row before it touches the advance', async () => {
    const { h, adv, row } = await pulled()
    await db.query(`UPDATE payments SET status = 'settled', settled_at = NOW() WHERE id = $1`, [row.id])
    const seen = await whileTenantHeld(h.tenantId, adv.id, async () => {
      const c = await db.connect()
      try {
        await c.query('BEGIN')
        await reconcileSettledFlexPayPayment(row.id, c)
        await c.query('COMMIT')
      } catch (e) {
        await c.query('ROLLBACK').catch(() => {})
        throw e
      } finally {
        c.release()
      }
    })
    expect(seen).toEqual({ blocked: true, advanceFree: true })
    expect((await advanceOf(h.tenantId))[0].status).toBe('reconciled')
  })

  it('a pull with no verified bank waits on the tenant row before it writes the advance off', async () => {
    await enablePlatform()
    const h = await seedHousehold()
    await coverFlexPayCycle(COVER_NOW)
    const [adv] = await advanceOf(h.tenantId)
    // No bank account anywhere on the customer: the tenant's bank, written off at once.
    stripeMocks.customersRetrieve.mockResolvedValue({ id: 'cus_flexpay_test', invoice_settings: { default_payment_method: null }, default_source: null } as any)
    savedMethods({})
    const seen = await whileTenantHeld(h.tenantId, adv.id, () => processFlexPayPullDay(at('2026-10-20')))
    expect(seen).toEqual({ blocked: true, advanceFree: true })
    expect((await advanceOf(h.tenantId))[0]).toMatchObject({ status: 'defaulted', default_reason: FLEXPAY_DEFAULT_REASONS.bankUnavailable })
  })

  it('the pull run takes the tenant row before the advance, as the cover does', async () => {
    await enablePlatform()
    const h = await seedHousehold()
    await coverFlexPayCycle(COVER_NOW)
    const [adv] = await advanceOf(h.tenantId)
    const seen = await whileTenantHeld(h.tenantId, adv.id, () => processFlexPayPullDay(at('2026-10-20')))
    expect(seen).toEqual({ blocked: true, advanceFree: true })
    expect((await advanceOf(h.tenantId))[0].status).toBe('pulled')
  })
})

describe('lock order: an adopted pull that already succeeded takes the household first', () => {
  it('waits on the household before it touches the tenant row or the pull row, as the cover and the success webhook do', async () => {
    await enablePlatform()
    const h = await seedHousehold()
    await coverFlexPayCycle(COVER_NOW)
    const [adv] = await advanceOf(h.tenantId)
    // Run 1 loses the create reply: the pull row is written with no intent.
    createRentPlatformChargeMock.mockRejectedValueOnce(new Error('timeout'))
    await processFlexPayPullDay(at('2026-10-20'))
    const [row] = await pullRowOf(adv.id)
    stripeMocks.paymentIntentsSearch.mockResolvedValueOnce({ data: [{ id: 'pi_done_locked', status: 'succeeded' }] } as any)

    const holder = await db.connect()
    const probe = await db.connect()
    let pending: Promise<unknown> | null = null
    let blocked = false
    const free = { tenant: false, pullRow: false }
    try {
      await holder.query('BEGIN')
      await lockHousehold(holder, h.tenantId, h.landlordId)
      pending = processFlexPayPullDay(at('2026-10-21'))
      pending.catch(() => {})
      for (let i = 0; i < 150 && !blocked; i++) {
        blocked = ((await probe.query(`SELECT 1 FROM pg_locks WHERE NOT granted`)).rowCount ?? 0) > 0
        if (!blocked) await new Promise(r => setTimeout(r, 20))
      }
      for (const [k, sql, id] of [
        ['tenant', `SELECT 1 FROM tenants WHERE id = $1 FOR UPDATE NOWAIT`, h.tenantId],
        ['pullRow', `SELECT 1 FROM payments WHERE id = $1 FOR UPDATE NOWAIT`, row.id],
      ] as const) {
        await probe.query('BEGIN')
        try {
          await probe.query(sql, [id])
          free[k] = true
        } catch (e: any) {
          if (e?.code !== '55P03') throw e
        }
        await probe.query('ROLLBACK')
      }
    } finally {
      await holder.query('ROLLBACK').catch(() => {})
      holder.release()
      probe.release()
    }
    await pending
    expect({ blocked, ...free }).toEqual({ blocked: true, tenant: true, pullRow: true })
    expect(await payment(row.id)).toMatchObject({ status: 'settled', stripe_payment_intent_id: 'pi_done_locked' })
    expect((await advanceOf(h.tenantId))[0].status).toBe('reconciled')
  })
})

describe('adoptFlexPayPullIntent — a pull intent whose id never reached its row', () => {
  /** Covered, and the pull day's create reply lost: the pull row has no intent. */
  async function lostReply() {
    await enablePlatform()
    const h = await seedHousehold()
    await coverFlexPayCycle(COVER_NOW)
    const [adv] = await advanceOf(h.tenantId)
    createRentPlatformChargeMock.mockRejectedValueOnce(new Error('timeout'))
    await processFlexPayPullDay(at('2026-10-20'))
    const [row] = await pullRowOf(adv.id)
    expect(row).toMatchObject({ status: 'pending', stripe_payment_intent_id: null })
    return { h, adv, row }
  }
  const md = (row: any, adv: any) => ({ gam_purpose: 'flexpay_pull', gam_payment_id: row.id, gam_advance_id: adv.id,
                                        gam_tenant_id: adv.tenant_id, gam_covered: '1060', gam_fee: '25' })

  it('an orphan FlexPay success settles the pull row its metadata names, reconciles the advance and books the $25, and creates no tenant credit', async () => {
    const { h, adv, row } = await lostReply()
    const r = await adoptFlexPayPullIntent({ id: 'pi_orphan_ok', status: 'succeeded', metadata: md(row, adv) })
    expect(r).toBe('recorded')
    expect(await payment(row.id)).toMatchObject({ status: 'settled', stripe_payment_intent_id: 'pi_orphan_ok' })
    expect((await advanceOf(h.tenantId))[0].status).toBe('reconciled')
    const fee = await db.query<any>(`SELECT amount FROM platform_revenue_ledger WHERE type = 'flexpay_subscription'`)
    expect(fee.rows.map((x: any) => Number(x.amount))).toEqual([25])
    // Never the tenant's money: no paid-ahead credit, no issued credit, no remittance.
    expect((await db.query(`SELECT 1 FROM lease_prepaid_credits WHERE tenant_id = $1`, [h.tenantId])).rowCount).toBe(0)
    expect((await db.query(`SELECT 1 FROM tenant_credits WHERE tenant_id = $1`, [h.tenantId])).rowCount).toBe(0)
    expect((await db.query(`SELECT 1 FROM tenant_remittances WHERE stripe_payment_intent_id = 'pi_orphan_ok'`)).rowCount).toBe(0)

    // A redelivery, and the next pull run, change nothing.
    expect(await adoptFlexPayPullIntent({ id: 'pi_orphan_ok', status: 'succeeded', metadata: md(row, adv) })).toBe('already_recorded')
    await processFlexPayPullDay(at('2026-10-21'))
    expect(createRentPlatformChargeMock).toHaveBeenCalledTimes(1)
    expect((await db.query(`SELECT 1 FROM platform_revenue_ledger WHERE type = 'flexpay_subscription'`)).rowCount).toBe(1)
  })

  it('an orphan FlexPay failure worth retrying is scheduled on the FlexPay schedule and the tenant told the repriced amount — never written off', async () => {
    const { h, adv, row } = await lostReply()
    const r = await adoptFlexPayPullIntent({
      id: 'pi_orphan_short', status: 'requires_payment_method', payment_method_types: ['us_bank_account'],
      last_payment_error: { type: 'card_error', code: 'insufficient_funds', payment_method: { type: 'us_bank_account' } },
      metadata: md(row, adv),
    })
    expect(r).toBe('recorded')
    expect(await payment(row.id)).toMatchObject({ status: 'failed', return_code: 'R01', stripe_payment_intent_id: 'pi_orphan_short' })
    expect((await advanceOf(h.tenantId))[0].status).toBe('pulled')
    const [n] = (await tenantNotices(h.tenantUserId)).filter((x: any) => x.type === 'flexpay_pull_retry')
    expect(n.data).toMatchObject({ failed_amount: 1085, retry_amount: 1089 })
  })

  it('an intent that is not a FlexPay pull, names a row of another advance, or names a row already carrying another intent changes nothing; the last two alert', async () => {
    const { h, adv, row } = await lostReply()
    expect(await adoptFlexPayPullIntent({ id: 'pi_rent', status: 'succeeded', metadata: { gam_purpose: 'rent' } })).toBe('not_flexpay')
    expect(await adoptFlexPayPullIntent({ id: 'pi_bad', status: 'succeeded', metadata: { gam_purpose: 'flexpay_pull', gam_payment_id: 'not-a-uuid' } })).toBe('mismatch')
    expect(await adoptFlexPayPullIntent({
      id: 'pi_wrong_adv', status: 'succeeded',
      metadata: { ...md(row, adv), gam_advance_id: '00000000-0000-0000-0000-000000000000' },
    })).toBe('mismatch')
    expect(await payment(row.id)).toMatchObject({ status: 'pending', stripe_payment_intent_id: null })

    await db.query(`UPDATE payments SET stripe_payment_intent_id = 'pi_first', status = 'processing' WHERE id = $1`, [row.id])
    expect(await adoptFlexPayPullIntent({ id: 'pi_second', status: 'succeeded', metadata: md(row, adv) })).toBe('mismatch')
    expect(await payment(row.id)).toMatchObject({ status: 'processing', stripe_payment_intent_id: 'pi_first' })
    expect((await advanceOf(h.tenantId))[0].status).toBe('fronted')
    const alerts = (await db.query<any>(`SELECT body FROM admin_notifications WHERE category = 'flexpay_pull_intent_unmatched' ORDER BY created_at`)).rows
    expect(alerts).toHaveLength(3)
    expect(alerts[2].body).toContain('already carries a different intent (pi_first)')
    expect(alerts.map((a: any) => a.body).join(' ')).toContain('never the tenant\'s credit')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// S655 Step 10 — whose a failure is (decisions #36.D / #37.D, FlexPay terms
// v2.1 §4.3), joining again, and a pull written off that had succeeded.
// ═══════════════════════════════════════════════════════════════════════════

import { isCriticalNotificationType } from '@gam/shared'

describe('Step 10 — FlexPay\'s failure rules and joining again', () => {
  async function readyToJoin() {
    await enablePlatform()
    const h = await seedHousehold({ enrolled: false })
    await db.query(`UPDATE tenants SET ssi_ssdi = TRUE, ach_verified = TRUE WHERE id = $1`, [h.tenantId])
    await db.query(
      `INSERT INTO system_features (key, enabled, description) VALUES ('flexpay_enrollment_open', TRUE, 'S655 test')
       ON CONFLICT (key) DO UPDATE SET enabled = TRUE`)
    await db.query(
      `INSERT INTO flexpay_inquiries (tenant_id, status, claimed_income_source, reviewed_at) VALUES ($1, 'approved', 'ssdi', now())`,
      [h.tenantId])
    return h
  }
  const join = (h: Household) => enrollFlexPay({ tenantId: h.tenantId, userId: h.tenantUserId, pullDay: 10,
                                                  acceptedTerms: true, ip: null, userAgent: null })

  it('joining again needs the 90-day wait over AND what FlexPay paid collected (decisions #36.D), enforced on the server', async () => {
    const h = await readyToJoin()
    const adv = (await db.query<{ id: string }>(
      `INSERT INTO flexpay_advances (cycle_month, tenant_id, landlord_id, unit_id, lease_id, rent_amount, tenant_fee_amount,
                                     pull_day, status, defaulted_at, default_reason)
       VALUES ('2026-08-01', $1, $2, $3, $4, 1060, 25, 10, 'defaulted', NOW() - interval '100 days', 'pull_not_collected') RETURNING id`,
      [h.tenantId, h.landlordId, h.unitId, h.leaseId])).rows[0].id
    await db.query(`UPDATE tenants SET flexpay_disqualified_until = NOW() + interval '10 days' WHERE id = $1`, [h.tenantId])
    let r = await join(h)
    expect(r.ok).toBe(false)
    expect((r as any).reason).toMatch(/can join FlexPay again on/)
    expect((r as any).reason).toMatch(/still open with GAM/)
    // The wait is over, but what FlexPay paid is still open: still refused.
    await db.query(`UPDATE tenants SET flexpay_disqualified_until = NOW() - interval '1 day' WHERE id = $1`, [h.tenantId])
    r = await join(h)
    expect(r.ok).toBe(false)
    expect((r as any).reason).toMatch(/still open with GAM/)
    // Collected (GAM-first routing reconciled it): FlexPay can be joined.
    await db.query(`UPDATE flexpay_advances SET status = 'reconciled', reconciled_at = NOW() WHERE id = $1`, [adv])
    r = await join(h)
    expect(r.ok).toBe(true)
  })

  it('an enrollment that read eligibility before the bank went away never lands: the statement that enrolls checks again', async () => {
    const h = await readyToJoin()
    // Between the eligibility read and the enrolling statement the tenant's
    // bank stops being verified (a trigger on the acceptance row, written in
    // the same transaction just before the enrollment, plays that moment).
    await db.query(`
      CREATE OR REPLACE FUNCTION s655_test_bank_gone() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN UPDATE tenants SET ach_verified = FALSE WHERE id = NEW.tenant_id; RETURN NEW; END $$`)
    await db.query(`CREATE TRIGGER s655_test_bank_gone AFTER INSERT ON flexsuite_enrollment_acceptances
                      FOR EACH ROW EXECUTE FUNCTION s655_test_bank_gone()`)
    try {
      const r = await join(h)
      // Refused. (Here the change rolls back with the refused enrollment, so
      // the tenant is asked to try again; a real removal committed by another
      // transaction is named by its own blocker.)
      expect(r).toEqual({ ok: false, reason: 'Something on your account changed while you were joining. Please try again.' })
    } finally {
      await db.query(`DROP TRIGGER IF EXISTS s655_test_bank_gone ON flexsuite_enrollment_acceptances`)
      await db.query(`DROP FUNCTION IF EXISTS s655_test_bank_gone()`)
    }
    const t = (await db.query<any>(`SELECT flexpay_enrolled FROM tenants WHERE id = $1`, [h.tenantId])).rows[0]
    expect(t.flexpay_enrolled).toBe(false)
    // Nothing of the refused enrollment stands (the acceptance rolled back with it).
    expect((await db.query(`SELECT 1 FROM flexsuite_enrollment_acceptances WHERE tenant_id = $1`, [h.tenantId])).rowCount).toBe(0)
  })

  it('a tenant already on FlexPay is told so, never enrolled twice', async () => {
    const h = await readyToJoin()
    expect((await join(h)).ok).toBe(true)
    expect(await join(h)).toEqual({ ok: false, reason: 'You are already on FlexPay.' })
  })

  it('no verified bank at the cover: FlexPay ends without paying the bill, with the rejoin wait', async () => {
    await enablePlatform()
    const h = await seedHousehold()
    await db.query(`UPDATE tenants SET ach_verified = FALSE WHERE id = $1`, [h.tenantId])
    const r = await coverFlexPayCycle(COVER_NOW)
    expect(r).toMatchObject({ bills_covered: 0, ended_bank_stopped: 1 })
    expect(await advanceOf(h.tenantId)).toHaveLength(0)
    expect((await payment(h.rentId)).status).toBe('pending')
    const t = (await db.query<any>(`SELECT flexpay_enrolled, flexpay_disqualified_until FROM tenants WHERE id = $1`, [h.tenantId])).rows[0]
    expect(t.flexpay_enrolled).toBe(false)
    expect(t.flexpay_disqualified_until).not.toBeNull()
    const [n] = (await tenantNotices(h.tenantUserId)).filter((x: any) => x.type === 'flexpay_ended')
    expect(n.body).toMatch(/^There is no verified bank account on your account, so FlexPay cannot collect from your bank, and your FlexPay has ended\./)
    expect(n.body).toMatch(/You can join FlexPay again on [A-Z][a-z]+ \d{1,2}, \d{4}, once a verified bank account is on your account\./)
  })

  it('FlexPay\'s money notices always send: FlexPay ended, FlexPay paid the bill, a FlexPay collection tried again', () => {
    for (const t of ['flexpay_ended', 'flexpay_bill_covered', 'flexpay_pull_retry']) {
      expect(isCriticalNotificationType(t)).toBe(true)
    }
  })

  async function writtenOffPull() {
    await enablePlatform()
    const h = await seedHousehold()
    await coverFlexPayCycle(COVER_NOW)
    const [adv] = await advanceOf(h.tenantId)
    // Run 1 lost the create reply; the pull was later closed as never made.
    createRentPlatformChargeMock.mockRejectedValueOnce(new Error('timeout'))
    await processFlexPayPullDay(at('2026-10-20'))
    const [row] = await pullRowOf(adv.id)
    await db.query(`UPDATE payments SET status = 'failed' WHERE id = $1`, [row.id])
    await db.query(`UPDATE flexpay_advances SET status = 'defaulted', defaulted_at = NOW(), default_reason = 'pull_not_created' WHERE id = $1`, [adv.id])
    return { h, adv, row }
  }

  it('a pull written off as never made whose intent succeeded after all is recovered: recorded, reconciled, $25 booked, never collected twice', async () => {
    const { h, adv, row } = await writtenOffPull()
    const out = await adoptFlexPayPullIntent({ id: 'pi_was_made', status: 'succeeded',
      metadata: { gam_purpose: 'flexpay_pull', gam_payment_id: row.id, gam_advance_id: adv.id } } as any)
    expect(out).toBe('recovered')
    expect(await payment(row.id)).toMatchObject({ status: 'settled', stripe_payment_intent_id: 'pi_was_made' })
    expect((await advanceOf(h.tenantId))[0].status).toBe('reconciled')
    const fee = await db.query<any>(`SELECT amount::float AS a FROM platform_revenue_ledger WHERE reference_id = $1 AND type = 'flexpay_subscription'`, [adv.id])
    expect(fee.rows).toEqual([{ a: 25 }])
    // Nothing of it is a GAM-side balance any more: GAM-first routing never takes it again.
    expect((await db.query(`SELECT 1 FROM flexpay_advances WHERE tenant_id = $1 AND status = 'defaulted'`, [h.tenantId])).rowCount).toBe(0)
    expect((await db.query(`SELECT 1 FROM admin_notifications WHERE category = 'flexpay_pull_intent_unmatched'`)).rowCount).toBe(1)
  })

  it('a pull written off as never made, named by an intent that did not succeed, is a mismatch for a person', async () => {
    const { adv, row } = await writtenOffPull()
    const out = await adoptFlexPayPullIntent({ id: 'pi_bounced_late', status: 'requires_payment_method',
      metadata: { gam_purpose: 'flexpay_pull', gam_payment_id: row.id, gam_advance_id: adv.id } } as any)
    expect(out).toBe('mismatch')
    expect(await payment(row.id)).toMatchObject({ status: 'failed', stripe_payment_intent_id: null })
    expect((await db.query(`SELECT 1 FROM admin_notifications WHERE category = 'flexpay_pull_intent_unmatched'`)).rowCount).toBe(1)
  })

  it('an earlier, called-off intent of a pull made again is never recorded on it', async () => {
    await enablePlatform()
    const h = await seedHousehold()
    await coverFlexPayCycle(COVER_NOW)
    await processFlexPayPullDay(at('2026-10-20'))
    const [adv] = await advanceOf(h.tenantId)
    const [row] = await pullRowOf(adv.id)
    await db.query(`UPDATE payments SET status = 'failed', next_retry_at = NULL WHERE id = $1`, [row.id])
    await handleFlexPayPaymentNsf(row.id, undefined, { gamSide: true })
    const out = await adoptFlexPayPullIntent({ id: row.stripe_payment_intent_id, status: 'requires_payment_method',
      metadata: { gam_purpose: 'flexpay_pull', gam_payment_id: row.id, gam_advance_id: adv.id } } as any)
    expect(out).toBe('called_off')
    expect(await payment(row.id)).toMatchObject({ status: 'pending', stripe_payment_intent_id: null })
    expect((await advanceOf(h.tenantId))[0].status).toBe('fronted')
  })
})

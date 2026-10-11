/**
 * S620: the reconciler has to be LOUD when the ledger and Stripe disagree, and
 * SILENT when they don't. Both halves matter equally — a detector that cries
 * wolf on every in-flight ACH gets muted within a week, and a detector that
 * never fires is decoration.
 *
 * Stripe is faked here on purpose: the point is the divergence logic, and no
 * test should reach the live API to prove it.
 */
import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest'
import { query, getClient, db } from '../db'
import { seedLandlord } from '../test/dbHelpers'
import { reconcileStuckPayments, releaseUnconfirmedCardCharges, releaseUnconfirmedCharge, releaseUnconfirmedChargeDetailed, releaseFailedOnScreenConfirmation, declinedByCardBank, forgetSweptCardCharges, heldForCardholder, CARD_RELEASE_NOTE } from './paymentReconcile'
import { cleanupAllSchema, seedProperty, seedUnit, seedTenant, seedLease, seedLeaseTenant } from '../test/dbHelpers'
import { holdCredit } from '../services/creditUse'
import * as adminNotifications from '../services/adminNotifications'

// payments.landlord_id is NOT NULL — a real landlord, seeded once.
let landlordId: string

/** A Stripe stand-in that returns whatever status the case needs. */
function fakeStripe(status: string) {
  return {
    paymentIntents: {
      retrieve: vi.fn(async (id: string) => ({ id, status })),
    },
  } as any
}

/** One payment sitting in 'processing', old enough to be looked at. */
async function seedStuckPayment(piId: string | null, hoursOld = 48): Promise<string> {
  const [row] = await query<{ id: string }>(
    `INSERT INTO payments (landlord_id, type, amount, status, entry_description,
                           due_date, stripe_payment_intent_id, created_at)
     VALUES ($1, 'rent', 2.00, 'processing', 'RENT', CURRENT_DATE,
             $2, now() - ($3 || ' hours')::interval)
     RETURNING id`,
    [landlordId, piId, String(hoursOld)]
  )
  return row.id
}

describe('reconcileStuckPayments', () => {
  let notify: any
  beforeAll(async () => {
    const client = await getClient()
    try { ({ landlordId } = await seedLandlord(client)) } finally { client.release() }
  })
  beforeEach(async () => {
    await query(`DELETE FROM payments WHERE status = 'processing'`)
    notify = vi.spyOn(adminNotifications, 'createAdminNotification').mockResolvedValue(undefined as any)
  })

  it('stays SILENT while an ACH is genuinely in flight', async () => {
    // The real case that started all this: Stripe says processing, we say
    // processing, everyone agrees. Alarming here would train Nic to ignore it.
    await seedStuckPayment('pi_inflight')
    const r = await reconcileStuckPayments(fakeStripe('processing'))
    expect(r.checked).toBe(1)
    expect(r.diverged).toBe(0)
    expect(notify).not.toHaveBeenCalled()
  })

  it('ALARMS when Stripe says succeeded and we still say processing', async () => {
    // THE failure mode: the webhook was missed. The tenant paid, GAM has the
    // money, and the platform is still calling them delinquent.
    await seedStuckPayment('pi_paid')
    const r = await reconcileStuckPayments(fakeStripe('succeeded'))
    expect(r.diverged).toBe(1)
    expect(notify).toHaveBeenCalledTimes(1)
    const arg = notify.mock.calls[0][0]
    expect(arg.severity).toBe('critical')
    expect(arg.title).toMatch(/still owed in GAM/i)
    // The operator must be told to REPLAY, not to hand-edit the row — the
    // settlement path does transfers and allocation that an UPDATE would skip.
    expect(arg.body).toMatch(/replay/i)
  })

  it('ALARMS when Stripe says the payment failed and we never heard', async () => {
    await seedStuckPayment('pi_dead')
    const r = await reconcileStuckPayments(fakeStripe('canceled'))
    expect(r.diverged).toBe(1)
    expect(notify.mock.calls[0][0].severity).toBe('critical')
  })

  it('ALARMS on a processing payment with no Stripe reference at all', async () => {
    await seedStuckPayment(null)
    const r = await reconcileStuckPayments(fakeStripe('succeeded'))
    expect(r.unknown).toBe(1)
    expect(notify.mock.calls[0][0].title).toMatch(/no Stripe reference/i)
  })

  it('ignores payments too recent to judge', async () => {
    // Under the 24h floor: a card settles in seconds but an ACH does not, and
    // asking Stripe about a two-hour-old bank debit tells us nothing.
    await seedStuckPayment('pi_fresh', 2)
    const r = await reconcileStuckPayments(fakeStripe('succeeded'))
    expect(r.checked).toBe(0)
    expect(notify).not.toHaveBeenCalled()
  })
})

// ─── decisions.md #48.4: a card nobody confirmed (3-D Secure) ─────────────────
// The pay screen keeps a card charge its bank wants confirmed and holds the
// bill while the cardholder confirms. Nobody confirms within 30 minutes: the
// sweep cancels it in Stripe and releases the bill and any credit it set aside.
describe('releaseUnconfirmedCardCharges', () => {
  interface Seeded { tenantId: string; landlordId: string; leaseId: string; unitId: string; rowId: string; remId: string; creditId: string }

  /** A $1,000 bill held by a $700 card charge plus $300 of credit set aside on it. */
  async function seedHeld(pi: string, o: { minutesOld?: number; method?: 'card' | 'ach' } = {}): Promise<Seeded> {
    const c = await getClient()
    try {
      await c.query('BEGIN')
      const ll = await seedLandlord(c)
      const propertyId = await seedProperty(c, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
      const unitId = await seedUnit(c, { propertyId, landlordId: ll.landlordId })
      const tenantId = await seedTenant(c)
      const leaseId = await seedLease(c, { unitId, landlordId: ll.landlordId, rentAmount: 1000 })
      await seedLeaseTenant(c, { leaseId, tenantId })
      const rowId = (await c.query<{ id: string }>(
        `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
         VALUES ($1,$2,$3,$4,'rent',1000,'pending','2026-10-01','RENT') RETURNING id`,
        [unitId, leaseId, tenantId, ll.landlordId])).rows[0].id
      const creditId = (await c.query<{ id: string }>(
        `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category)
         VALUES ($1,$2,$3,300,300,'goodwill') RETURNING id`, [ll.landlordId, tenantId, leaseId])).rows[0].id
      const remId = (await c.query<{ id: string }>(
        `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, unapplied_amount,
                                         payment_method, gross_amount, processing_fee_amount, created_at)
         VALUES ($1,$2,$3,700,700,0,$4,725.05,25.05, now() - ($5 || ' minutes')::interval) RETURNING id`,
        [tenantId, leaseId, ll.landlordId, o.method ?? 'card', String(o.minutesOld ?? 31)])).rows[0].id
      await holdCredit(c, [{ creditKind: 'issued', creditId, paymentId: rowId, leaseId, amount: 300, billingMonth: '2026-10-01' }],
        { remittanceId: remId, source: 'portal' })
      await c.query(`UPDATE payments SET status = 'processing', platform_held = TRUE, stripe_payment_intent_id = $2 WHERE id = $1`, [rowId, pi])
      await c.query(`UPDATE tenant_remittances SET stripe_payment_intent_id = $2 WHERE id = $1`, [remId, pi])
      await c.query('COMMIT')
      return { tenantId, landlordId: ll.landlordId, leaseId, unitId, rowId, remId, creditId }
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
  }

  /**
   * Stripe as the sweep sees it: `status` until canceled; cancel may fail.
   * The charge is the pay screen's (services/rentCharge stamps
   * gam_confirm_on_screen) unless `metadata` says otherwise.
   */
  function stripeSaying(status: string, o: { cancelFails?: boolean; afterCancelFails?: string; metadata?: Record<string, string> } = {}) {
    let now = status
    const metadata = o.metadata ?? { gam_confirm_on_screen: 'true' }
    return {
      paymentIntents: {
        retrieve: vi.fn(async (id: string) => ({ id, status: now, metadata })),
        cancel: vi.fn(async (id: string) => {
          if (o.cancelFails) { if (o.afterCancelFails) now = o.afterCancelFails; throw new Error('cannot cancel') }
          now = 'canceled'
          return { id, status: 'canceled' }
        }),
      },
    } as any
  }
  const rowOf = async (id: string) => (await db.query<any>(
    `SELECT status, next_retry_at, stripe_payment_intent_id FROM payments WHERE id = $1`, [id])).rows[0]
  const remOf = async (id: string) => (await db.query<any>(`SELECT status FROM tenant_remittances WHERE id = $1`, [id])).rows[0].status
  const usesOf = async (creditId: string) => (await db.query<any>(
    `SELECT status, release_reason FROM credit_uses WHERE tenant_credit_id = $1`, [creditId])).rows
  const leftOn = async (creditId: string) => Number((await db.query<any>(
    `SELECT amount_remaining FROM tenant_credits WHERE id = $1`, [creditId])).rows[0].amount_remaining)

  beforeEach(async () => {
    await cleanupAllSchema()
    forgetSweptCardCharges()
    vi.spyOn(adminNotifications, 'createAdminNotification').mockResolvedValue(undefined as any)
  })
  const noteOf = async (remId: string) => (await db.query<any>(`SELECT notes FROM tenant_remittances WHERE id = $1`, [remId])).rows[0].notes

  it('a card payment nobody confirmed within 30 minutes is canceled and its bill released: open again as it was (not Failed), credit back, receipt failed', async () => {
    const s = await seedHeld('pi_3ds_old')
    expect(await leftOn(s.creditId)).toBe(0)
    const stripe = stripeSaying('requires_action')
    const r = await releaseUnconfirmedCardCharges(stripe)
    expect(r).toEqual({ checked: 1, released: 1, errors: 0 })
    expect(stripe.paymentIntents.cancel).toHaveBeenCalledWith('pi_3ds_old')
    expect(await rowOf(s.rowId)).toMatchObject({ status: 'pending', next_retry_at: null })
    expect((await db.query<any>(`SELECT stripe_payment_intent_id, platform_held, payment_channel FROM payments WHERE id = $1`, [s.rowId])).rows[0])
      .toEqual({ stripe_payment_intent_id: null, platform_held: false, payment_channel: null })
    expect(await remOf(s.remId)).toBe('failed')
    expect(await usesOf(s.creditId)).toEqual([{ status: 'released', release_reason: 'payment_canceled' }])
    expect(await leftOn(s.creditId)).toBe(300)
  })

  it('a payment still inside its 30 minutes is left alone — Stripe is not even asked', async () => {
    const s = await seedHeld('pi_3ds_new', { minutesOld: 10 })
    const stripe = stripeSaying('requires_action')
    const r = await releaseUnconfirmedCardCharges(stripe)
    expect(r.checked).toBe(0)
    expect(stripe.paymentIntents.retrieve).not.toHaveBeenCalled()
    expect((await rowOf(s.rowId)).status).toBe('processing')
  })

  it('a payment the cardholder confirmed in time is never touched', async () => {
    const s = await seedHeld('pi_3ds_done')
    const stripe = stripeSaying('succeeded')
    const r = await releaseUnconfirmedCardCharges(stripe)
    expect(r.released).toBe(0)
    expect(stripe.paymentIntents.cancel).not.toHaveBeenCalled()
    expect((await rowOf(s.rowId)).status).toBe('processing')
    expect(await usesOf(s.creditId)).toEqual([{ status: 'held', release_reason: null }])
  })

  it('a cancel that loses the race to the cardholder\'s confirmation leaves the payment alone', async () => {
    const s = await seedHeld('pi_3ds_race')
    const stripe = stripeSaying('requires_action', { cancelFails: true, afterCancelFails: 'processing' })
    expect(await releaseUnconfirmedCharge(stripe, 'pi_3ds_race')).toBe('went_through')
    expect((await rowOf(s.rowId)).status).toBe('processing')
    expect(await remOf(s.remId)).toBe('processing')
  })

  it('a cancel Stripe refuses for another reason is counted as an error and tried again next run', async () => {
    const s = await seedHeld('pi_3ds_stuck')
    const stripe = stripeSaying('requires_action', { cancelFails: true })
    const r = await releaseUnconfirmedCardCharges(stripe)
    expect(r).toEqual({ checked: 1, released: 0, errors: 1 })
    expect((await rowOf(s.rowId)).status).toBe('processing')
  })

  // Review (pay7 money-3): #48.4 holds only the pay screen's own card charge.
  // A move-out balance charge GAM saved but could not confirm yet
  // (depositReturn attemptGapAutoCharge, gam_kind 'deposit_return_gap', left in
  // requires_confirmation) is finishPendingGapCharges' to confirm — never the
  // sweep's to cancel.
  it('a card gap charge (a move-out balance charge) left in requires_confirmation for 40 minutes is not canceled by the sweep and its receipt is not noted canceled', async () => {
    const s = await seedHeld('pi_gap_unfinished', { minutesOld: 40 })
    const stripe = stripeSaying('requires_confirmation', { metadata: { gam_kind: 'deposit_return_gap', gam_payment_id: s.rowId } })
    const r = await releaseUnconfirmedCardCharges(stripe)
    expect(r).toEqual({ checked: 1, released: 0, errors: 0 })
    expect(stripe.paymentIntents.cancel).not.toHaveBeenCalled()
    expect(await rowOf(s.rowId)).toMatchObject({ status: 'processing', stripe_payment_intent_id: 'pi_gap_unfinished' })
    expect(await remOf(s.remId)).toBe('processing')
    expect(await noteOf(s.remId)).toBeNull()
    expect(await usesOf(s.creditId)).toEqual([{ status: 'held', release_reason: null }])
  })

  it('a card charge the pay screen did not make is asked about once, not on every five-minute run', async () => {
    await seedHeld('pi_gap_once', { minutesOld: 40 })
    const stripe = stripeSaying('requires_confirmation', { metadata: { gam_kind: 'deposit_return_gap' } })
    await releaseUnconfirmedCardCharges(stripe)
    await releaseUnconfirmedCardCharges(stripe)
    expect(stripe.paymentIntents.retrieve).toHaveBeenCalledTimes(1)
  })

  it('releasing one card charge by hand does nothing to a charge the pay screen did not make (not_held)', async () => {
    const s = await seedHeld('pi_gap_hand', { minutesOld: 40 })
    const stripe = stripeSaying('requires_confirmation', { metadata: { gam_kind: 'deposit_return_gap' } })
    expect(await releaseUnconfirmedChargeDetailed(stripe, 'pi_gap_hand')).toEqual({ outcome: 'not_held', declined: false })
    expect(stripe.paymentIntents.cancel).not.toHaveBeenCalled()
    expect((await rowOf(s.rowId)).status).toBe('processing')
    expect(await remOf(s.remId)).toBe('processing')
  })

  it('heldForCardholder: only a pay-screen charge still waiting on its cardholder', () => {
    const screen = { gam_confirm_on_screen: 'true' }
    expect(heldForCardholder({ status: 'requires_action', metadata: screen })).toBe(true)
    expect(heldForCardholder({ status: 'requires_payment_method', metadata: screen })).toBe(true)
    expect(heldForCardholder({ status: 'succeeded', metadata: screen })).toBe(false)
    expect(heldForCardholder({ status: 'requires_confirmation', metadata: { gam_kind: 'deposit_return_gap' } })).toBe(false)
    expect(heldForCardholder({ status: 'requires_action', metadata: {} })).toBe(false)
    expect(heldForCardholder(null)).toBe(false)
  })

  it('a bank payment is never swept, however old', async () => {
    const s = await seedHeld('pi_bank_old', { method: 'ach', minutesOld: 600 })
    const stripe = stripeSaying('requires_action')
    expect((await releaseUnconfirmedCardCharges(stripe)).checked).toBe(0)
    expect((await rowOf(s.rowId)).status).toBe('processing')
  })

  it('a tenant-paid platform fee the canceled charge carried is owed again on the next payment', async () => {
    const s = await seedHeld('pi_3ds_fee')
    const propertyId = (await db.query<any>(`SELECT property_id FROM units WHERE id = $1`, [s.unitId])).rows[0].property_id
    const accrual = (await db.query<{ id: string }>(
      `INSERT INTO platform_fee_accruals (property_id, landlord_id, accrual_month, rate_per_unit, min_per_connect_account, total_amount, payer, tenant_charge_id)
       VALUES ($1,$2,'2026-10-01',2,10,2,'tenant',$3) RETURNING id`, [propertyId, s.landlordId, s.rowId])).rows[0].id
    await releaseUnconfirmedCardCharges(stripeSaying('requires_action'))
    expect((await db.query<any>(`SELECT tenant_charge_id FROM platform_fee_accruals WHERE id = $1`, [accrual])).rows[0].tenant_charge_id).toBeNull()
  })

  it('releasing twice (the cancel webhook got there too) changes nothing more', async () => {
    const s = await seedHeld('pi_3ds_twice')
    const stripe = stripeSaying('requires_action')
    expect(await releaseUnconfirmedCharge(stripe, 'pi_3ds_twice')).toBe('released')
    expect(await releaseUnconfirmedCharge(stripe, 'pi_3ds_twice')).toBe('released')
    expect(stripe.paymentIntents.cancel).toHaveBeenCalledTimes(1)
    expect(await usesOf(s.creditId)).toEqual([{ status: 'released', release_reason: 'payment_canceled' }])
    expect(await leftOn(s.creditId)).toBe(300)
  })

  it('one payer only, when asked for one (the pay route frees its own payer\'s abandoned charge)', async () => {
    const a = await seedHeld('pi_3ds_a')
    const b = await seedHeld('pi_3ds_b')
    const r = await releaseUnconfirmedCardCharges(stripeSaying('requires_action'), { tenantId: a.tenantId })
    expect(r.released).toBe(1)
    expect((await rowOf(a.rowId)).status).toBe('pending')
    expect((await rowOf(b.rowId)).status).toBe('processing')
  })

  it('one company only, when asked for its companies (the landlord assistant\'s cash tool)', async () => {
    const a = await seedHeld('pi_3ds_co_a')
    const b = await seedHeld('pi_3ds_co_b')
    const r = await releaseUnconfirmedCardCharges(stripeSaying('requires_action'), { landlordIds: [a.landlordId] })
    expect(r.released).toBe(1)
    expect((await rowOf(a.rowId)).status).toBe('pending')
    expect((await rowOf(b.rowId)).status).toBe('processing')
    // No companies: nothing is released.
    expect((await releaseUnconfirmedCardCharges(stripeSaying('requires_action'), { landlordIds: [] })).checked).toBe(0)
  })

  it('a pay-screen charge already canceled (payment_intent.canceled) is released without asking Stripe again', async () => {
    const s = await seedHeld('pi_3ds_canceled_event', { minutesOld: 2 })
    const stripe = stripeSaying('canceled')
    expect(await releaseFailedOnScreenConfirmation(stripe, {
      id: 'pi_3ds_canceled_event', status: 'canceled', metadata: { gam_confirm_on_screen: 'true' },
    } as any)).toBe(true)
    expect(stripe.paymentIntents.retrieve).not.toHaveBeenCalled()
    expect(await rowOf(s.rowId)).toMatchObject({ status: 'pending', next_retry_at: null })
    expect(await leftOn(s.creditId)).toBe(300)
  })

  it('the twice-daily reconcile runs the sweep too, as a backstop', async () => {
    const s = await seedHeld('pi_3ds_backstop')
    await reconcileStuckPayments(stripeSaying('requires_action'))
    expect((await rowOf(s.rowId)).status).toBe('pending')
  })

  /** A second tenant on the same lease (one household balance). */
  async function seedCoTenant(leaseId: string): Promise<string> {
    const c = await getClient()
    try {
      const t = await seedTenant(c)
      await seedLeaseTenant(c, { leaseId, tenantId: t })
      return t
    } finally { c.release() }
  }

  it('a co-tenant\'s look at the bill frees the payer\'s abandoned charge too (one household balance)', async () => {
    const s = await seedHeld('pi_3ds_household')
    const other = await seedHeld('pi_3ds_elsewhere')
    const coTenant = await seedCoTenant(s.leaseId)
    const r = await releaseUnconfirmedCardCharges(stripeSaying('requires_action'), { tenantId: coTenant })
    expect(r.released).toBe(1)
    expect((await rowOf(s.rowId)).status).toBe('pending')
    expect(await leftOn(s.creditId)).toBe(300)
    expect((await rowOf(other.rowId)).status).toBe('processing')
  })

  async function feeOn(s: Seeded): Promise<string> {
    const propertyId = (await db.query<any>(`SELECT property_id FROM units WHERE id = $1`, [s.unitId])).rows[0].property_id
    return (await db.query<{ id: string }>(
      `INSERT INTO platform_fee_accruals (property_id, landlord_id, accrual_month, rate_per_unit, min_per_connect_account, total_amount, payer, tenant_charge_id)
       VALUES ($1,$2,'2026-10-01',2,10,2,'tenant',$3) RETURNING id`, [propertyId, s.landlordId, s.rowId])).rows[0].id
  }
  const feeLinkOf = async (accrual: string) =>
    (await db.query<any>(`SELECT tenant_charge_id FROM platform_fee_accruals WHERE id = $1`, [accrual])).rows[0].tenant_charge_id

  // Review (fix pass 2): when the bank's confirmation fails on the pay screen,
  // Stripe sends payment_intent.payment_failed — often before the screen's own
  // release lands. It is not a declined payment: the bill opens again, the
  // credit comes back, the fee link clears, and nothing else happens.
  it('the pay screen\'s card fails its bank\'s confirmation and the failure arrives first: released, not a decline — no decline fee, no failed-payment mark', async () => {
    const s = await seedHeld('pi_3ds_failed_first', { minutesOld: 2 })
    const accrual = await feeOn(s)
    const stripe = stripeSaying('requires_payment_method')
    const handled = await releaseFailedOnScreenConfirmation(stripe, {
      id: 'pi_3ds_failed_first', metadata: { gam_confirm_on_screen: 'true' },
    } as any)
    expect(handled).toBe(true)
    expect(stripe.paymentIntents.cancel).toHaveBeenCalledWith('pi_3ds_failed_first')
    expect(await rowOf(s.rowId)).toMatchObject({ status: 'pending', next_retry_at: null })
    expect(await remOf(s.remId)).toBe('failed')
    expect(await leftOn(s.creditId)).toBe(300)
    expect(await feeLinkOf(accrual)).toBeNull()
    expect((await db.query(`SELECT 1 FROM payments WHERE entry_description = 'DECLINEFEE'`)).rowCount).toBe(0)
    expect((await db.query(`SELECT 1 FROM credit_events WHERE event_type = 'payment_failed_nsf'`)).rowCount).toBe(0)
    // The screen's release lands after: nothing more happens.
    expect(await releaseUnconfirmedCharge(stripe, 'pi_3ds_failed_first')).toBe('released')
    expect(stripe.paymentIntents.cancel).toHaveBeenCalledTimes(1)
    expect(await usesOf(s.creditId)).toEqual([{ status: 'released', release_reason: 'payment_canceled' }])
  })

  it('a failed charge that was not confirmed on the pay screen is left to the normal failure path', async () => {
    const s = await seedHeld('pi_not_on_screen', { minutesOld: 2 })
    const stripe = stripeSaying('requires_payment_method')
    expect(await releaseFailedOnScreenConfirmation(stripe, { id: 'pi_not_on_screen', metadata: {} } as any)).toBe(false)
    expect(stripe.paymentIntents.retrieve).not.toHaveBeenCalled()
    expect((await rowOf(s.rowId)).status).toBe('processing')
  })

  it('a card charge the failure webhook already closed still has its platform-fee link cleared by the sweep', async () => {
    const s = await seedHeld('pi_3ds_webhook_closed', { minutesOld: 2 })
    const accrual = await feeOn(s)
    // What the failure webhook leaves: rows failed with no retry, receipt failed.
    await db.query(`UPDATE payments SET status = 'failed', next_retry_at = NULL WHERE id = $1`, [s.rowId])
    await db.query(`UPDATE tenant_remittances SET status = 'failed' WHERE id = $1`, [s.remId])
    const r = await releaseUnconfirmedCardCharges(stripeSaying('requires_payment_method'))
    expect(r.checked).toBe(0)
    expect(await feeLinkOf(accrual)).toBeNull()
  })

  it('a sweep scoped to some companies clears only their failed card charges\' platform-fee links', async () => {
    const a = await seedHeld('pi_scope_a', { minutesOld: 2 })
    const b = await seedHeld('pi_scope_b', { minutesOld: 2 })
    const feeA = await feeOn(a)
    const feeB = await feeOn(b)
    for (const s of [a, b]) {
      await db.query(`UPDATE payments SET status = 'failed', next_retry_at = NULL WHERE id = $1`, [s.rowId])
      await db.query(`UPDATE tenant_remittances SET status = 'failed' WHERE id = $1`, [s.remId])
    }
    await releaseUnconfirmedCardCharges(stripeSaying('requires_payment_method'), { landlordIds: [a.landlordId] })
    expect(await feeLinkOf(feeA)).toBeNull()
    expect(await feeLinkOf(feeB)).toBe(b.rowId)
  })

  it('a charge the card\'s bank declined after the cardholder confirmed it is released the same way and reported as declined', async () => {
    const s = await seedHeld('pi_3ds_declined', { minutesOld: 2 })
    let now = 'requires_payment_method'
    const stripe = {
      paymentIntents: {
        retrieve: vi.fn(async (id: string) => ({ id, status: now, metadata: { gam_confirm_on_screen: 'true' },
          last_payment_error: { type: 'card_error', code: 'card_declined', decline_code: 'insufficient_funds' } })),
        cancel: vi.fn(async (id: string) => { now = 'canceled'; return { id, status: 'canceled' } }),
      },
    } as any
    expect(await releaseUnconfirmedChargeDetailed(stripe, 'pi_3ds_declined')).toEqual({ outcome: 'released', declined: true })
    expect((await rowOf(s.rowId)).status).toBe('pending')
    expect(await leftOn(s.creditId)).toBe(300)
    expect((await db.query(`SELECT 1 FROM payments WHERE entry_description = 'DECLINEFEE'`)).rowCount).toBe(0)
  })

  it('only a card error other than a failed bank confirmation counts as declined', () => {
    expect(declinedByCardBank({ last_payment_error: { type: 'card_error', code: 'card_declined' } } as any)).toBe(true)
    expect(declinedByCardBank({ last_payment_error: { type: 'card_error', code: 'payment_intent_authentication_failure' } } as any)).toBe(false)
    expect(declinedByCardBank({ last_payment_error: { type: 'api_error', code: 'x' } } as any)).toBe(false)
    expect(declinedByCardBank({ last_payment_error: null } as any)).toBe(false)
    expect(declinedByCardBank(null)).toBe(false)
  })

  it('a bank payment\'s platform-fee link is never cleared by the card sweep', async () => {
    const s = await seedHeld('pi_bank_failed', { method: 'ach', minutesOld: 2 })
    const accrual = await feeOn(s)
    await db.query(`UPDATE payments SET status = 'failed', next_retry_at = NULL WHERE id = $1`, [s.rowId])
    await db.query(`UPDATE tenant_remittances SET status = 'failed' WHERE id = $1`, [s.remId])
    await releaseUnconfirmedCardCharges(stripeSaying('requires_payment_method'))
    expect(await feeLinkOf(accrual)).toBe(s.rowId)
  })

  // ── Fix pass 3 ───────────────────────────────────────────────────────────
  it('a released card payment\'s receipt records why: canceled when nobody confirmed it', async () => {
    const s = await seedHeld('pi_note_canceled')
    await releaseUnconfirmedCardCharges(stripeSaying('requires_action'))
    expect(await noteOf(s.remId)).toBe(CARD_RELEASE_NOTE.canceled)
  })

  it('a decline the failure event carries is recorded on the receipt, and a later release or cancel event never turns it back into canceled', async () => {
    const s = await seedHeld('pi_note_declined', { minutesOld: 2 })
    const stripe = stripeSaying('requires_payment_method')
    // payment_intent.payment_failed: the event's copy carries the decline; Stripe's live copy does not.
    expect(await releaseFailedOnScreenConfirmation(stripe, {
      id: 'pi_note_declined', status: 'requires_payment_method', metadata: { gam_confirm_on_screen: 'true' },
      last_payment_error: { type: 'card_error', code: 'card_declined' },
    } as any)).toBe(true)
    expect(await noteOf(s.remId)).toBe(CARD_RELEASE_NOTE.declined)
    // The screen's release (Stripe now shows no error): still declined.
    expect(await releaseUnconfirmedChargeDetailed(stripe, 'pi_note_declined')).toEqual({ outcome: 'released', declined: true })
    // payment_intent.canceled, with no error on it: still declined.
    await releaseFailedOnScreenConfirmation(stripe, { id: 'pi_note_declined', status: 'canceled', metadata: { gam_confirm_on_screen: 'true' } } as any)
    expect(await noteOf(s.remId)).toBe(CARD_RELEASE_NOTE.declined)
  })

  it('a decline learned after the screen\'s release noted the receipt canceled corrects it to declined', async () => {
    const s = await seedHeld('pi_note_late', { minutesOld: 2 })
    const stripe = stripeSaying('requires_action')
    expect(await releaseUnconfirmedChargeDetailed(stripe, 'pi_note_late')).toEqual({ outcome: 'released', declined: false })
    expect(await noteOf(s.remId)).toBe(CARD_RELEASE_NOTE.canceled)
    await releaseFailedOnScreenConfirmation(stripe, {
      id: 'pi_note_late', status: 'canceled', metadata: { gam_confirm_on_screen: 'true' },
      last_payment_error: { type: 'card_error', code: 'card_declined' },
    } as any)
    expect(await noteOf(s.remId)).toBe(CARD_RELEASE_NOTE.declined)
  })

  /**
   * What services/rentCharge leaves when a card charge pays only part of an
   * old balance: the $500 old balance split into the paid $300 slice (on the
   * charge, noted "partly paid…") and a $200 rest on its own row, written in
   * the receipt's transaction.
   */
  async function seedSplitOldBalance(pi: string): Promise<{ sliceId: string; restId: string; remId: string; tenantId: string }> {
    const c = await getClient()
    try {
      await c.query('BEGIN')
      const ll = await seedLandlord(c)
      const propertyId = await seedProperty(c, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
      const unitId = await seedUnit(c, { propertyId, landlordId: ll.landlordId })
      const tenantId = await seedTenant(c)
      const leaseId = await seedLease(c, { unitId, landlordId: ll.landlordId, rentAmount: 1000 })
      await seedLeaseTenant(c, { leaseId, tenantId })
      const remId = (await c.query<{ id: string }>(
        `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, unapplied_amount,
                                         payment_method, gross_amount, processing_fee_amount, stripe_payment_intent_id)
         VALUES ($1,$2,$3,300,300,0,'card',310.76,10.76,$4) RETURNING id`, [tenantId, leaseId, ll.landlordId, pi])).rows[0].id
      const sliceId = (await c.query<{ id: string }>(
        `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, notes, stripe_payment_intent_id, platform_held)
         VALUES ($1,$2,$3,$4,'rent',300,'processing','2026-08-01','RENT',
                 'August rent — partly paid toward the old balance; $200.00 remains on a separate row',$5,TRUE) RETURNING id`,
        [unitId, leaseId, tenantId, ll.landlordId, pi])).rows[0].id
      const restId = (await c.query<{ id: string }>(
        `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, notes, is_remainder)
         VALUES ($1,$2,$3,$4,'rent',200,'pending','2026-08-01','RENT','What is left of the old balance after a part payment',TRUE) RETURNING id`,
        [unitId, leaseId, tenantId, ll.landlordId])).rows[0].id
      await c.query(`INSERT INTO remittance_applications (remittance_id, payment_id, amount_applied) VALUES ($1,$2,300)`, [remId, sliceId])
      await c.query(`UPDATE tenant_remittances SET created_at = created_at - interval '31 minutes' WHERE id = $1`, [remId])
      await c.query(`UPDATE payments SET created_at = created_at - interval '31 minutes' WHERE id = ANY($1::uuid[])`, [[sliceId, restId]])
      await c.query('COMMIT')
      return { sliceId, restId, remId, tenantId }
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
  }

  it('a card charge that paid part of the old balance and was never confirmed leaves the old balance as it was: one row, its whole amount, no part-payment note', async () => {
    const s = await seedSplitOldBalance('pi_split_abandoned')
    await releaseUnconfirmedCardCharges(stripeSaying('requires_action'))
    const rows = (await db.query<any>(
      `SELECT id, amount::float AS amount, status, notes FROM payments WHERE tenant_id = $1 AND type = 'rent'`, [s.tenantId])).rows
    expect(rows).toEqual([{ id: s.sliceId, amount: 500, status: 'pending', notes: 'August rent' }])
  })

  it('when the rest of a split old balance was paid meanwhile, both rows stay and the note stops claiming a part payment', async () => {
    const s = await seedSplitOldBalance('pi_split_rest_paid')
    await db.query(`UPDATE payments SET status = 'settled' WHERE id = $1`, [s.restId])
    await releaseUnconfirmedCardCharges(stripeSaying('requires_action'))
    const rows = (await db.query<any>(
      `SELECT id, amount::float AS amount, status, notes FROM payments WHERE tenant_id = $1 AND type = 'rent' ORDER BY amount DESC`, [s.tenantId])).rows
    expect(rows).toEqual([
      { id: s.sliceId, amount: 300, status: 'pending', notes: 'August rent — part of the old balance; the rest is on a separate row' },
      { id: s.restId, amount: 200, status: 'settled', notes: 'What is left of the old balance after a part payment' },
    ])
  })

  it('a card charge the sweep found went through is not asked about again on every run', async () => {
    const s = await seedHeld('pi_went_through_once')
    const stripe = stripeSaying('succeeded')
    await releaseUnconfirmedCardCharges(stripe)
    await releaseUnconfirmedCardCharges(stripe)
    await releaseUnconfirmedCardCharges(stripe)
    expect(stripe.paymentIntents.retrieve).toHaveBeenCalledTimes(1)
    expect((await rowOf(s.rowId)).status).toBe('processing')
  })
})

/**
 * processAchRetries — NACHA-respecting retry cron.
 *
 * Daily job that walks `payments` rows where:
 *   - status='failed'
 *   - next_retry_at IS NOT NULL AND <= NOW()
 *   - retry_count < 2
 *   - stripe_payment_intent_id IS NOT NULL
 *
 * For each, optimistically claims (bumps retry_count, clears
 * next_retry_at, stamps last_retry_at, and — S654 — marks the rows
 * 'processing' while the pull is in flight) then fires
 * `stripe.paymentIntents.confirm`. Actual settlement comes via
 * webhook.
 *
 * Pairs with S271 webhook tests:
 *   - charge → settle (S270)
 *   - charge → fail with retryable code (S271) — sets next_retry_at
 *   - retry cron fires (this suite) — calls confirm
 *
 * Stripe SDK mocked at lib/stripe module level. No real network
 * calls; tests assert on the confirm invocations + DB side effects.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'
import { db, getClient } from '../db'
import {
  cleanupAllSchema,
  seedLandlord, seedTenant,
  seedProperty, seedUnit,
  seedRentPayment, seedLease,
} from '../test/dbHelpers'

// Mock the lib/stripe getStripe() factory. The service imports the
// helper directly; replacing it at module boundary keeps the
// fake-network surface tight.
const confirmFn = vi.fn<[string, any?], Promise<{ id: string }>>(
  async () => ({ id: 'pi_mock' })
)
// S654: a bounced intent as Stripe hands it back — "needs a payment method",
// with the account it tried on last_payment_error.
const retrieveFn = vi.fn(async (id: string): Promise<any> => ({
  id, status: 'requires_payment_method', payment_method: null,
  payment_method_types: ['us_bank_account'],
  last_payment_error: { code: 'insufficient_funds', payment_method: { id: 'pm_tenant_bank', type: 'us_bank_account' } },
}))
// S655: a pull that will not be fired is canceled; a FlexPay retry re-prices its intent.
const cancelFn = vi.fn(async (id: string) => ({ id, status: 'canceled' }))
const updateFn = vi.fn(async (id: string, _p?: any) => ({ id }))
vi.mock('../lib/stripe', () => ({
  getStripe: () => ({ paymentIntents: { confirm: confirmFn, retrieve: retrieveFn, cancel: cancelFn, update: updateFn } }),
}))
// S654: the retry cron can now tell a tenant their retry was not fired.
const { sendNotificationEmailMock, repriceMock } = vi.hoisted(() => ({
  sendNotificationEmailMock: vi.fn(async (_o?: any): Promise<string | null> => 'msg_mock'),
  repriceMock: vi.fn(async (_id: string) => undefined),
}))
vi.mock('./email', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, sendNotificationEmail: sendNotificationEmailMock }
})
vi.mock('./flexpay', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, repriceFlexPayRetryPayment: repriceMock }
})

import { processAchRetries, extractReturnCode, decideRetry, retryConfirmParams, bankRefusedDebit } from './achRetry'
import { fetchOutstandingRows } from './rentCharge'

beforeEach(async () => {
  await cleanupAllSchema()
  confirmFn.mockReset()
  confirmFn.mockResolvedValue({ id: 'pi_mock' } as any)
  retrieveFn.mockClear()
  cancelFn.mockClear()
  updateFn.mockClear()
  sendNotificationEmailMock.mockClear()
  repriceMock.mockReset()
  repriceMock.mockResolvedValue(undefined)
})

// ── Fixture builder ─────────────────────────────────────────────────────────

interface RetryablePaymentInput {
  paymentIntentId: string
  nextRetryAtOffsetSec?: number   // <0 = past, >0 = future, undefined = NULL
  retryCount?: number              // 0, 1, or 2
  status?: 'pending' | 'failed' | 'settled' | 'returned'
}

async function seedRetryablePayment(args: RetryablePaymentInput): Promise<string> {
  const client = await getClient()
  try {
    const { userId: ownerUserId, landlordId } = await seedLandlord(client)
    const tenantId = await seedTenant(client)
    const propertyId = await seedProperty(client, {
      landlordId, ownerUserId, managedByUserId: ownerUserId,
    })
    const unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: 1000 })
    const paymentId = await seedRentPayment(client, {
      unitId, tenantId, landlordId,
      amount: 1000,
      status: args.status ?? 'failed',
      stripePaymentIntentId: args.paymentIntentId,
    })

    // Patch retry_count + next_retry_at after seed (seedRentPayment
    // doesn't expose these directly; this stays test-only so adding
    // params to the seeder for one test path isn't worth it).
    const offsetSec = args.nextRetryAtOffsetSec
    await client.query(
      `UPDATE payments
          SET retry_count   = $2,
              next_retry_at = CASE WHEN $3::int IS NULL THEN NULL
                                   ELSE NOW() + ($3 || ' seconds')::interval END
        WHERE id = $1`,
      [paymentId, args.retryCount ?? 0,
       offsetSec === undefined ? null : offsetSec]
    )
    return paymentId
  } finally {
    client.release()
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('processAchRetries', () => {
  it('fires confirm for a due retry; bumps retry_count, clears next_retry_at, marks the rows in progress', async () => {
    const paymentId = await seedRetryablePayment({
      paymentIntentId: 'pi_due_1',
      nextRetryAtOffsetSec: -60,  // due 60s ago
      retryCount: 0,
    })
    const res = await processAchRetries()
    expect(res.scanned).toBe(1)
    expect(res.fired).toBe(1)
    expect(res.succeeded).toBe(1)
    expect(res.failed).toBe(0)
    expect(confirmFn.mock.calls[0][0]).toBe('pi_due_1')

    const pay = await db.query<{
      retry_count: number
      next_retry_at: string | null
      last_retry_at: string | null
      status: string
    }>(
      `SELECT retry_count, next_retry_at, last_retry_at, status
         FROM payments WHERE id=$1`,
      [paymentId]
    )
    expect(pay.rows[0]).toMatchObject({
      retry_count: 1,
      next_retry_at: null,
      // S654: in flight, like a first pull — settled or failed by the webhook.
      status: 'processing',
    })
    expect(pay.rows[0].last_retry_at).not.toBeNull()
  })

  it('skips not-yet-due payments (next_retry_at in future)', async () => {
    await seedRetryablePayment({
      paymentIntentId: 'pi_future_1',
      nextRetryAtOffsetSec: 3600,  // 1h from now
      retryCount: 0,
    })
    const res = await processAchRetries()
    expect(res.scanned).toBe(0)
    expect(confirmFn).not.toHaveBeenCalled()
  })

  it('skips payments with status != failed', async () => {
    await seedRetryablePayment({
      paymentIntentId: 'pi_settled_1',
      nextRetryAtOffsetSec: -60,
      retryCount: 0,
      status: 'settled',
    })
    const res = await processAchRetries()
    expect(res.scanned).toBe(0)
  })

  it('skips payments at the retry cap (retry_count >= 2)', async () => {
    await seedRetryablePayment({
      paymentIntentId: 'pi_cap_1',
      nextRetryAtOffsetSec: -60,
      retryCount: 2,
    })
    const res = await processAchRetries()
    expect(res.scanned).toBe(0)
    expect(confirmFn).not.toHaveBeenCalled()
  })

  it('skips payments without a Stripe PaymentIntent id', async () => {
    const client = await getClient()
    try {
      const { userId: ownerUserId, landlordId } = await seedLandlord(client)
      const tenantId = await seedTenant(client)
      const propertyId = await seedProperty(client, {
        landlordId, ownerUserId, managedByUserId: ownerUserId,
      })
      const unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: 1000 })
      const paymentId = await seedRentPayment(client, {
        unitId, tenantId, landlordId, amount: 1000, status: 'failed',
        // intentionally no stripePaymentIntentId
      })
      await client.query(
        `UPDATE payments SET next_retry_at = NOW() - INTERVAL '1 minute' WHERE id=$1`,
        [paymentId]
      )
    } finally {
      client.release()
    }
    const res = await processAchRetries()
    expect(res.scanned).toBe(0)
  })

  it('confirm() rejection: failed++, admin notification fired, retry_count still claimed', async () => {
    confirmFn.mockRejectedValueOnce(new Error('Stripe API unavailable'))
    const paymentId = await seedRetryablePayment({
      paymentIntentId: 'pi_err_1',
      nextRetryAtOffsetSec: -60,
      retryCount: 0,
    })
    const res = await processAchRetries()
    expect(res.scanned).toBe(1)
    expect(res.fired).toBe(1)
    expect(res.succeeded).toBe(0)
    expect(res.failed).toBe(1)
    expect(res.errors).toHaveLength(1)
    expect(res.errors[0]).toMatchObject({ payment_id: paymentId })

    const pay = await db.query<{ retry_count: number; next_retry_at: string | null; status: string }>(
      `SELECT retry_count, next_retry_at, status FROM payments WHERE id=$1`,
      [paymentId]
    )
    // Claim runs before the confirm; retry_count is incremented even
    // when confirm throws. Prevents an infinite retry loop on a broken
    // Stripe API connection — the row exits the queue and waits for
    // the next webhook event.
    expect(pay.rows[0].retry_count).toBe(1)
    expect(pay.rows[0].next_retry_at).toBeNull()
    // S654: Stripe says nothing is being pulled, so the charge is owed again.
    expect(pay.rows[0].status).toBe('failed')

    const notif = await db.query<{ category: string; title: string }>(
      `SELECT category, title FROM admin_notifications
        WHERE category='ach_retry_confirm_failure'`
    )
    expect(notif.rows).toHaveLength(1)
    expect(notif.rows[0].title).toMatch(/ach retry confirm failed/i)
  })

  it('processes multiple due retries in next_retry_at ASC order', async () => {
    // Two due payments, the older one first.
    const earlierId = await seedRetryablePayment({
      paymentIntentId: 'pi_first',
      nextRetryAtOffsetSec: -300,  // 5min ago
      retryCount: 0,
    })
    const laterId = await seedRetryablePayment({
      paymentIntentId: 'pi_second',
      nextRetryAtOffsetSec: -60,   // 1min ago
      retryCount: 0,
    })
    const res = await processAchRetries()
    expect(res.fired).toBe(2)
    expect(res.succeeded).toBe(2)

    // confirm called in order: earlier next_retry_at fires first
    const calls = confirmFn.mock.calls.map((c) => c[0])
    expect(calls).toEqual(['pi_first', 'pi_second'])

    const counts = await db.query<{ id: string; retry_count: number }>(
      `SELECT id, retry_count FROM payments
        WHERE id = ANY($1::uuid[])
        ORDER BY id`,
      [[earlierId, laterId]]
    )
    expect(counts.rows.every((r) => r.retry_count === 1)).toBe(true)
  })

  it('idempotent: re-running after a successful pass picks up zero rows (next_retry_at cleared)', async () => {
    await seedRetryablePayment({
      paymentIntentId: 'pi_idem_1',
      nextRetryAtOffsetSec: -60,
      retryCount: 0,
    })
    const r1 = await processAchRetries()
    expect(r1.fired).toBe(1)

    const r2 = await processAchRetries()
    expect(r2.scanned).toBe(0)
    expect(r2.fired).toBe(0)
    expect(confirmFn).toHaveBeenCalledTimes(1)  // not called again
  })
})

// ── S654: one retry per BANK PULL ───────────────────────────────────────────
// A Pay Now that covered rent + water + a fee is one payment intent on three
// rows. Confirming that intent once per row made Stripe refuse the extras and
// raised false "retry failed" admin alerts.

async function addLineToPull(paymentId: string, amount: number, type: string): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status,
                           due_date, entry_description, stripe_payment_intent_id, retry_count, next_retry_at)
     SELECT unit_id, lease_id, tenant_id, landlord_id, $2, $3, status,
            due_date, 'UTILITY', stripe_payment_intent_id, retry_count, next_retry_at
       FROM payments WHERE id = $1
     RETURNING id`,
    [paymentId, type, amount.toFixed(2)])
  return r.rows[0].id
}

describe('processAchRetries — one confirm per payment intent', () => {
  it('a three-line pull is confirmed ONCE, and every line is claimed together', async () => {
    const rentId = await seedRetryablePayment({ paymentIntentId: 'pi_multi_1', nextRetryAtOffsetSec: -60, retryCount: 0 })
    const waterId = await addLineToPull(rentId, 25.20, 'utility')
    const feeId = await addLineToPull(rentId, 6, 'fee')

    const res = await processAchRetries()
    expect(confirmFn).toHaveBeenCalledTimes(1)
    expect(confirmFn.mock.calls[0][0]).toBe('pi_multi_1')
    expect(res).toMatchObject({ scanned: 1, fired: 1, succeeded: 1, failed: 0 })

    const rows = await db.query<{ retry_count: number; next_retry_at: string | null; last_retry_at: string | null }>(
      `SELECT retry_count, next_retry_at, last_retry_at FROM payments WHERE id = ANY($1::uuid[])`,
      [[rentId, waterId, feeId]])
    expect(rows.rows).toHaveLength(3)
    for (const r of rows.rows) {
      expect(r.retry_count).toBe(1)
      expect(r.next_retry_at).toBeNull()
      expect(r.last_retry_at).not.toBeNull()
    }
  })

  it('a refused confirm on a multi-line pull raises ONE admin alert, not one per line', async () => {
    confirmFn.mockRejectedValueOnce(new Error('Stripe API unavailable'))
    const rentId = await seedRetryablePayment({ paymentIntentId: 'pi_multi_err', nextRetryAtOffsetSec: -60, retryCount: 0 })
    await addLineToPull(rentId, 25.20, 'utility')

    const res = await processAchRetries()
    expect(confirmFn).toHaveBeenCalledTimes(1)
    expect(res).toMatchObject({ scanned: 1, fired: 1, failed: 1 })
    expect(res.errors).toHaveLength(1)
    expect(res.errors[0]).toMatchObject({ stripe_payment_intent_id: 'pi_multi_err' })

    const notif = await db.query(
      `SELECT 1 FROM admin_notifications WHERE category = 'ach_retry_confirm_failure'`)
    expect(notif.rows).toHaveLength(1)
  })

  it('a second run the same day confirms nothing more', async () => {
    const rentId = await seedRetryablePayment({ paymentIntentId: 'pi_multi_idem', nextRetryAtOffsetSec: -60, retryCount: 0 })
    await addLineToPull(rentId, 25.20, 'utility')
    await processAchRetries()
    const again = await processAchRetries()
    expect(again.scanned).toBe(0)
    expect(confirmFn).toHaveBeenCalledTimes(1)
  })
})

// ── S654: Stripe NAMES a bank debit's failure ───────────────────────────────
// Live Stripe reports 'insufficient_funds', not "R01". Read by R-code only,
// every real bounce looked unreadable and was treated as final: no retries.

function failedPi(lpe: Record<string, unknown> | null, extra: Record<string, unknown> = {}): any {
  return { id: 'pi_x', object: 'payment_intent', last_payment_error: lpe, ...extra }
}
const bank = { type: 'us_bank_account' }

describe('extractReturnCode — reads the bank\'s reason by name as well as by code', () => {
  it.each([
    ['insufficient_funds', 'R01'],
    ['account_closed', 'R02'],
    ['no_account', 'R03'],
    ['invalid_account_number', 'R04'],
    ['debit_not_authorized', 'R10'],
  ])('a bank debit failing with %s reads as %s', (name, code) => {
    expect(extractReturnCode(failedPi({ code: name, payment_method: bank }))).toBe(code)
  })

  it('"insufficient_funds" by name gets its retries; "account_closed" by name does not', () => {
    expect(decideRetry(extractReturnCode(failedPi({ code: 'insufficient_funds', payment_method: bank })))).toBe('retry')
    expect(decideRetry(extractReturnCode(failedPi({ code: 'account_closed', payment_method: bank })))).toBe('permanent')
  })

  it('reads the expanded charge\'s failure_code when the error carries no code', () => {
    const pi = failedPi({ payment_method: bank }, { latest_charge: { id: 'ch_1', failure_code: 'insufficient_funds' } })
    expect(extractReturnCode(pi)).toBe('R01')
  })

  it('an intent that only allows bank debits counts as a bank failure when the error names no method', () => {
    const pi = failedPi({ code: 'insufficient_funds' }, { payment_method_types: ['us_bank_account'] })
    expect(extractReturnCode(pi)).toBe('R01')
  })

  it('an R-code given as the code is taken as-is', () => {
    expect(extractReturnCode(failedPi({ code: 'r09', payment_method: bank }))).toBe('R09')
  })

  it('the return_details R-code still wins when present', () => {
    const pi = failedPi({
      code: 'account_closed', payment_method: bank,
      payment_method_details: { us_bank_account: { return_details: { code: 'R01' } } },
    })
    expect(extractReturnCode(pi)).toBe('R01')
  })

  it('a declined CARD never reads as a bank code — cards are not retried', () => {
    // Stripe's card shape: code card_declined, decline_code insufficient_funds.
    expect(extractReturnCode(failedPi(
      { code: 'card_declined', decline_code: 'insufficient_funds', payment_method: { type: 'card' } }))).toBeNull()
    // Even a bank-sounding code on a card is not mapped.
    expect(extractReturnCode(failedPi({ code: 'insufficient_funds', payment_method: { type: 'card' } }))).toBeNull()
    expect(extractReturnCode(failedPi({ code: 'insufficient_funds' }, { payment_method_types: ['card'] }))).toBeNull()
  })

  it('a name we do not know, or no error at all, is unreadable (null → final)', () => {
    expect(extractReturnCode(failedPi({ code: 'generic_decline', payment_method: bank }))).toBeNull()
    expect(extractReturnCode(failedPi(null))).toBeNull()
    expect(decideRetry(null)).toBe('permanent')
  })
})

// Step 10 fix round (decisions #37.D, FlexPay terms §4.3): whose a failed bank
// debit is. The bank's refusal is the bank's whether or not its reason maps to
// an R-code; only Stripe refusing GAM's own request, or a cancel, is GAM's.
describe('bankRefusedDebit — a failed bank debit is the bank\'s answer, readable reason or not', () => {
  it.each(['bank_account_restricted', 'account_frozen', 'bank_ownership_changed', 'insufficient_funds', 'debit_not_authorized'])(
    'a bank debit failing with %s is the tenant\'s bank', (code) => {
      expect(bankRefusedDebit(failedPi({ type: 'card_error', code, payment_method: bank }))).toBe(true)
    })

  it('an unmapped bank reason has no R-code and is never retried, but is still the bank\'s', () => {
    const pi = failedPi({ type: 'card_error', code: 'account_frozen', payment_method: bank })
    expect(extractReturnCode(pi)).toBeNull()
    expect(decideRetry(extractReturnCode(pi))).toBe('permanent')
    expect(bankRefusedDebit(pi)).toBe(true)
  })

  it('Stripe refusing GAM\'s own request (an invalid request, an API error) is never the bank\'s', () => {
    expect(bankRefusedDebit(failedPi({ type: 'invalid_request_error', code: 'payment_intent_mandate_invalid', payment_method: bank }))).toBe(false)
    expect(bankRefusedDebit(failedPi({ type: 'api_error', payment_method: bank }))).toBe(false)
  })

  it('a canceled intent or a card is never the tenant\'s bank', () => {
    expect(bankRefusedDebit(failedPi(null, { status: 'canceled', payment_method_types: ['us_bank_account'] }))).toBe(false)
    expect(bankRefusedDebit(failedPi({ type: 'card_error', code: 'card_declined', payment_method: { type: 'card' } }))).toBe(false)
  })
})

// S654: after a bounce Stripe sends the intent back to "needs a payment method"
// and the account rides on last_payment_error. A bare confirm(id) has nothing to
// pull from, so the retry names the account the tenant paid from.
describe('the retry pulls the same bank account', () => {
  it('confirms with the payment method from the failed attempt, and the debit authorization', async () => {
    await seedRetryablePayment({ paymentIntentId: 'pi_same_bank', nextRetryAtOffsetSec: -60, retryCount: 0 })
    await processAchRetries()
    expect(retrieveFn).toHaveBeenCalledWith('pi_same_bank', { expand: ['payment_method'] })
    expect(confirmFn.mock.calls[0]).toEqual(['pi_same_bank', expect.objectContaining({
      payment_method: 'pm_tenant_bank',
      mandate_data: expect.objectContaining({ customer_acceptance: expect.objectContaining({ type: 'online' }) }),
    })])
  })

  it('a method still on the intent wins over the one on the error', () => {
    expect(retryConfirmParams({
      id: 'pi', payment_method: 'pm_on_intent', payment_method_types: ['us_bank_account'],
      last_payment_error: { payment_method: { id: 'pm_on_error' } },
    } as any)).toMatchObject({ payment_method: 'pm_on_intent' })
  })

  it('a card intent gets no bank debit authorization', () => {
    const params = retryConfirmParams({
      id: 'pi', payment_method: 'pm_card', payment_method_types: ['card'], last_payment_error: null,
    } as any)
    expect(params).toEqual({ payment_method: 'pm_card' })
  })
})

// ── S654 (review): a retry in flight is not owed twice ─────────────────────
// The claim left every row 'failed' for the 2-4 business days the retried bank
// pull takes, so Pay Now, the counter reader, autopay and a recorded cash
// payment all still saw it as owed. A tenant who paid by card in that window
// re-stamped the rows; when the retry settled, no row matched it, and the bank
// was debited twice.

async function seedLeasedRetry(paymentIntentId: string) {
  const client = await getClient()
  try {
    const { userId: ownerUserId, landlordId } = await seedLandlord(client)
    const tenantId = await seedTenant(client)
    const propertyId = await seedProperty(client, { landlordId, ownerUserId, managedByUserId: ownerUserId })
    const unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: 495 })
    const leaseId = await seedLease(client, { unitId, landlordId, rentAmount: 495 })
    const rentId = await seedRentPayment(client, {
      unitId, tenantId, landlordId, amount: 495, status: 'failed', stripePaymentIntentId: paymentIntentId,
    })
    await client.query(
      `UPDATE payments SET lease_id = $2, retry_count = 0, return_code = 'R01',
              next_retry_at = NOW() - INTERVAL '1 minute' WHERE id = $1`, [rentId, leaseId])
    return { tenantId, leaseId, rentId }
  } finally { client.release() }
}

describe('a retry in flight is not owed twice', () => {
  it('before the retry fires the charge is owed; once it fires, Pay Now no longer offers it', async () => {
    const { tenantId, leaseId, rentId } = await seedLeasedRetry('pi_inflight')
    const waterId = await addLineToPull(rentId, 25.20, 'utility')
    await db.query(`UPDATE payments SET lease_id = $2 WHERE id = $1`, [waterId, leaseId])

    expect((await fetchOutstandingRows(tenantId, leaseId)).map((r: any) => r.id).sort())
      .toEqual([rentId, waterId].sort())
    await processAchRetries()
    expect(await fetchOutstandingRows(tenantId, leaseId)).toEqual([])
  })

  it('a cash payment recorded for the whole balance while the retry is in flight leaves the in-flight lines alone', async () => {
    // The record-manual route and the assistant's cash tool both open only
    // 'pending' / 'failed' charges; an in-flight line reads 'processing'.
    const { rentId } = await seedLeasedRetry('pi_inflight_cash')
    await processAchRetries()
    const open = await db.query(
      `SELECT 1 FROM payments WHERE id = $1 AND status IN ('pending', 'failed')`, [rentId])
    expect(open.rows).toHaveLength(0)
  })

  it('a FlexPay reprice that fails puts the lines back to owed — nothing was pulled', async () => {
    repriceMock.mockRejectedValueOnce(new Error('reprice broke'))
    const { rentId } = await seedLeasedRetry('pi_reprice_fail')
    await db.query(`UPDATE payments SET entry_description = 'FLEXPAY' WHERE id = $1`, [rentId])
    const res = await processAchRetries()
    expect(confirmFn).not.toHaveBeenCalled()
    expect(res.failed).toBe(1)
    const row = (await db.query<{ status: string }>(`SELECT status FROM payments WHERE id = $1`, [rentId])).rows[0]
    expect(row.status).toBe('failed')
  })

  it('a confirm whose reply was lost but whose pull DID start keeps the lines in progress', async () => {
    confirmFn.mockRejectedValueOnce(new Error('socket hang up'))
    retrieveFn
      .mockImplementationOnce(async (id: string) => ({
        id, status: 'requires_payment_method', payment_method: null, payment_method_types: ['us_bank_account'],
        last_payment_error: { code: 'insufficient_funds', payment_method: { id: 'pm_tenant_bank', type: 'us_bank_account' } },
      }))
      .mockImplementationOnce(async (id: string) => ({ id, status: 'processing' }))
    const { rentId } = await seedLeasedRetry('pi_lost_reply')
    await processAchRetries()
    const row = (await db.query<{ status: string }>(`SELECT status FROM payments WHERE id = $1`, [rentId])).rows[0]
    expect(row.status).toBe('processing')
  })

  it('a retrieve that fails before any confirm is sent puts the lines back to owed', async () => {
    retrieveFn.mockRejectedValueOnce(new Error('Stripe API unavailable'))
    const { rentId } = await seedLeasedRetry('pi_retrieve_fail')
    await processAchRetries()
    expect(confirmFn).not.toHaveBeenCalled()
    const row = (await db.query<{ status: string }>(`SELECT status FROM payments WHERE id = $1`, [rentId])).rows[0]
    expect(row.status).toBe('failed')
  })
})

// ── S654 (review): never re-pull a line that was paid another way ──────────
// The retry re-confirms the intent's WHOLE original amount. A rent line settled
// by cash (the assistant settles one charge) or a matched bank deposit while the
// pull waited for its retry would be paid twice.
describe('a pull partly paid another way is not retried', () => {
  async function seedPartlyPaid(pi: string) {
    const { rentId, tenantId } = await seedLeasedRetry(pi)
    const waterId = await addLineToPull(rentId, 25.20, 'utility')
    await db.query(`UPDATE payments SET status = 'settled', settled_at = NOW(), manual_method = 'cash' WHERE id = $1`, [rentId])
    const email = (await db.query<{ email: string }>(
      `SELECT u.email FROM tenants t JOIN users u ON u.id = t.user_id WHERE t.id = $1`, [tenantId])).rows[0].email
    return { rentId, waterId, email }
  }

  it('no confirm is sent, and the unpaid line is owed again with no retry pending', async () => {
    const { rentId, waterId } = await seedPartlyPaid('pi_partly_paid')
    const res = await processAchRetries()
    expect(confirmFn).not.toHaveBeenCalled()
    expect(res).toMatchObject({ scanned: 1, fired: 0, skipped: 1 })
    const rows = await db.query<{ id: string; status: string; next_retry_at: string | null }>(
      `SELECT id, status, next_retry_at FROM payments WHERE id = ANY($1::uuid[])`, [[rentId, waterId]])
    const byId = Object.fromEntries(rows.rows.map((r) => [r.id, r]))
    expect(byId[rentId].status).toBe('settled')
    expect(byId[waterId]).toMatchObject({ status: 'failed', next_retry_at: null })

    // And a second run does not pick it up again.
    const again = await processAchRetries()
    expect(again.scanned).toBe(0)
  })

  it('an admin is alerted, once', async () => {
    await seedPartlyPaid('pi_partly_paid_alert')
    await processAchRetries()
    const notif = await db.query(
      `SELECT 1 FROM admin_notifications WHERE category = 'ach_retry_skipped_partly_paid'`)
    expect(notif.rows).toHaveLength(1)
  })

  it('the tenant is told the retry was not made, what is still owed, and gets the Pay now button', async () => {
    const { email } = await seedPartlyPaid('pi_partly_paid_mail')
    await processAchRetries()
    const mail = (sendNotificationEmailMock.mock.calls as any[][]).map((c) => c[0] as any)
      .find((c) => c.notificationType === 'ach_retries_exhausted')
    expect(mail.to).toBe(email)
    expect(mail.html).toContain('has since been paid another way, so we didn\'t try your bank again')
    expect(mail.html).toContain('The rest, <b>$25.20</b>, is still owed')
    expect(mail.html).toMatch(/<a href="[^"]*\/login\?ef=[^"&]+&to=%2Fpayments" class="btn">Pay now<\/a>/)
  })
})

describe('the retry names a debit authorization only for a bank account', () => {
  it('an expanded bank method on the intent gets the debit authorization', () => {
    const params = retryConfirmParams({
      id: 'pi', payment_method: { id: 'pm_bank', type: 'us_bank_account' },
      payment_method_types: ['card', 'us_bank_account'], last_payment_error: null,
    } as any)
    expect(params).toMatchObject({ payment_method: 'pm_bank', mandate_data: expect.anything() })
  })

  it('an expanded CARD on an intent that also allows bank debits gets none', () => {
    const params = retryConfirmParams({
      id: 'pi', payment_method: { id: 'pm_card', type: 'card' },
      payment_method_types: ['card', 'us_bank_account'], last_payment_error: null,
    } as any)
    expect(params).toEqual({ payment_method: 'pm_card' })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// S655 (money plan Step 10): the retry and the credit a pull set aside.
// ═══════════════════════════════════════════════════════════════════════════

import { createPaidAhead, holdCredit, supersedeScheduledRetry } from './creditUse'
import { seedLeaseTenant } from '../test/dbHelpers'

/**
 * A bounced bank pull due for its retry, the way the portal made it: rent and
 * water, $100 of paid-ahead credit set aside on the rent, the receipt carrying
 * the intent.
 */
async function seedHeldRetry(pi: string) {
  const c = await getClient()
  try {
    const { userId: ownerUserId, landlordId } = await seedLandlord(c)
    const tenantId = await seedTenant(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId, managedByUserId: ownerUserId })
    const unitId = await seedUnit(c, { propertyId, landlordId, rentAmount: 1000 })
    const leaseId = await seedLease(c, { unitId, landlordId, rentAmount: 1000 })
    await seedLeaseTenant(c, { leaseId, tenantId })
    const mk = async (type: string, amount: number) => (await c.query<{ id: string }>(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, entry_description, due_date)
       VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,'2026-10-01') RETURNING id`,
      [unitId, leaseId, tenantId, landlordId, type, amount, type === 'rent' ? 'RENT' : 'UTILITY'])).rows[0].id
    const rentId = await mk('rent', 1000)
    const waterId = await mk('utility', 40)
    const creditId = await createPaidAhead(c, { leaseId, tenantId, amount: 100, fundedBy: 'landlord', receivedAt: new Date() })
    const remId = (await c.query<{ id: string }>(
      `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, payment_method,
                                       gross_amount, processing_fee_amount)
       VALUES ($1,$2,$3,940,940,'ach',946,6) RETURNING id`, [tenantId, leaseId, landlordId])).rows[0].id
    await c.query('BEGIN')
    await holdCredit(c, [{ creditKind: 'paid_ahead', creditId, paymentId: rentId, leaseId, amount: 100, billingMonth: '2026-10-01' }],
      { remittanceId: remId, source: 'portal' })
    await c.query('COMMIT')
    await c.query(
      `UPDATE payments SET status = 'failed', stripe_payment_intent_id = $2, return_code = 'R01', retry_count = 0,
                           next_retry_at = NOW() - INTERVAL '1 minute'
        WHERE id = ANY($1::uuid[])`, [[rentId, waterId], pi])
    await c.query(`UPDATE tenant_remittances SET stripe_payment_intent_id = $2 WHERE id = $1`, [remId, pi])
    return { tenantId, landlordId, leaseId, rentId, waterId, creditId, remId }
  } finally { c.release() }
}

const useOf = async (remId: string) =>
  (await db.query<any>(`SELECT status, release_reason FROM credit_uses WHERE remittance_id = $1`, [remId])).rows[0]
const creditLeft = async (creditId: string) =>
  (await db.query<any>(`SELECT amount_remaining::float AS r FROM lease_prepaid_credits WHERE id = $1`, [creditId])).rows[0].r

describe('S655 Step 10 — the retry and its credit', () => {
  it('the retry marks rows processing and confirms once per intent, its credit still set aside', async () => {
    const f = await seedHeldRetry('pi_held_retry')
    const res = await processAchRetries()
    expect(res).toMatchObject({ scanned: 1, fired: 1, succeeded: 1 })
    expect(confirmFn).toHaveBeenCalledTimes(1)
    const rows = await db.query<any>(`SELECT status, retry_count FROM payments WHERE id = ANY($1::uuid[])`, [[f.rentId, f.waterId]])
    expect(rows.rows).toEqual([{ status: 'processing', retry_count: 1 }, { status: 'processing', retry_count: 1 }])
    expect(await useOf(f.remId)).toEqual({ status: 'held', release_reason: null })
    expect(cancelFn).not.toHaveBeenCalled()
  })

  it('a tenant payment that claimed the rows first stops the retry and releases its credit', async () => {
    const f = await seedHeldRetry('pi_paid_first')
    // The tenant pays now: their payment supersedes the scheduled retry (what
    // the portal, autopay and the desk do before they claim the rows).
    const c = await getClient()
    let cancel: string[]
    try {
      await c.query('BEGIN')
      cancel = (await supersedeScheduledRetry(c, [f.rentId, f.waterId])).cancelAfterCommit
      await c.query('COMMIT')
    } finally { c.release() }
    expect(cancel!).toEqual(['pi_paid_first'])
    const res = await processAchRetries()
    expect(res.scanned).toBe(0)
    expect(confirmFn).not.toHaveBeenCalled()
    expect(await useOf(f.remId)).toEqual({ status: 'released', release_reason: 'superseded' })
    expect(await creditLeft(f.creditId)).toBe(100)
  })

  it('a stray skip releases held credit and cancels the intent', async () => {
    const f = await seedHeldRetry('pi_stray_held')
    // The water was paid at the desk meanwhile.
    await db.query(`UPDATE payments SET status = 'settled', settled_at = NOW(), manual_method = 'cash' WHERE id = $1`, [f.waterId])
    const res = await processAchRetries()
    expect(res).toMatchObject({ scanned: 1, fired: 0, skipped: 1 })
    expect(confirmFn).not.toHaveBeenCalled()
    expect((await db.query<any>(`SELECT status, next_retry_at FROM payments WHERE id = $1`, [f.rentId])).rows[0])
      .toEqual({ status: 'failed', next_retry_at: null })
    expect(await useOf(f.remId)).toEqual({ status: 'released', release_reason: 'superseded' })
    expect(await creditLeft(f.creditId)).toBe(100)
    expect((await db.query<any>(`SELECT status FROM tenant_remittances WHERE id = $1`, [f.remId])).rows[0].status).toBe('failed')
    expect(cancelFn).toHaveBeenCalledWith('pi_stray_held')
  })

  it('a confirm error leaves the rows payable and releases held credit', async () => {
    const f = await seedHeldRetry('pi_confirm_err')
    confirmFn.mockRejectedValueOnce(new Error('No such payment_method'))
    const res = await processAchRetries()
    expect(res.failed).toBe(1)
    const rows = await db.query<any>(`SELECT status, next_retry_at FROM payments WHERE id = ANY($1::uuid[])`, [[f.rentId, f.waterId]])
    expect(rows.rows).toEqual([{ status: 'failed', next_retry_at: null }, { status: 'failed', next_retry_at: null }])
    expect(await useOf(f.remId)).toEqual({ status: 'released', release_reason: 'payment_canceled' })
    expect(await creditLeft(f.creditId)).toBe(100)
    expect(cancelFn).toHaveBeenCalledWith('pi_confirm_err')
  })

  it('a confirm error after the bank\'s answer already arrived leaves that answer alone: the credit stays set aside and the intent is not canceled', async () => {
    const f = await seedHeldRetry('pi_confirm_raced')
    // The confirm reached the bank after all and bounced: the failure webhook
    // got there first, scheduling the next retry with the credit kept aside.
    confirmFn.mockImplementationOnce(async () => {
      await db.query(
        `UPDATE payments SET status = 'failed', next_retry_at = NOW() + INTERVAL '3 days'
          WHERE stripe_payment_intent_id = 'pi_confirm_raced' AND status = 'processing'`)
      throw new Error('socket hang up')
    })
    const res = await processAchRetries()
    expect(res.failed).toBe(1)
    const rows = await db.query<any>(`SELECT status, next_retry_at FROM payments WHERE id = ANY($1::uuid[])`, [[f.rentId, f.waterId]])
    expect(rows.rows.every((r: any) => r.status === 'failed' && r.next_retry_at !== null)).toBe(true)
    expect(await useOf(f.remId)).toEqual({ status: 'held', release_reason: null })
    expect((await db.query<any>(`SELECT status FROM tenant_remittances WHERE id = $1`, [f.remId])).rows[0].status).not.toBe('failed')
    expect(cancelFn).not.toHaveBeenCalled()
    const alert = await db.query<any>(`SELECT body FROM admin_notifications WHERE category = 'ach_retry_confirm_failure'`)
    expect(alert.rows[0].body).toMatch(/already arrived and was handled/)
  })

  it('a confirm whose pull started anyway keeps its credit set aside', async () => {
    const f = await seedHeldRetry('pi_confirm_lost')
    confirmFn.mockRejectedValueOnce(new Error('socket hang up'))
    retrieveFn
      .mockImplementationOnce(async (id: string) => ({ id, status: 'requires_payment_method', payment_method: null, payment_method_types: ['us_bank_account'],
        last_payment_error: { code: 'insufficient_funds', payment_method: { id: 'pm_tenant_bank', type: 'us_bank_account' } } }))
      .mockImplementationOnce(async (id: string) => ({ id, status: 'processing' }))
    await processAchRetries()
    expect((await db.query<any>(`SELECT status FROM payments WHERE id = $1`, [f.rentId])).rows[0].status).toBe('processing')
    expect(await useOf(f.remId)).toEqual({ status: 'held', release_reason: null })
    expect(cancelFn).not.toHaveBeenCalled()
  })

  it('the FlexPay reprice case confirms the repriced amount', async () => {
    const actual = await vi.importActual<typeof import('./flexpay')>('./flexpay')
    repriceMock.mockImplementationOnce(actual.repriceFlexPayRetryPayment as (id: string) => Promise<undefined>)
    const { rentId, tenantId, leaseId } = await seedLeasedRetry('pi_flex_reprice')
    const pay = (await db.query<any>(`SELECT unit_id, landlord_id FROM payments WHERE id = $1`, [rentId])).rows[0]
    const adv = (await db.query<{ id: string }>(
      `INSERT INTO flexpay_advances (cycle_month, tenant_id, landlord_id, unit_id, lease_id, rent_amount, tenant_fee_amount,
                                     pull_day, status, fronted_at, pulled_at, pull_date)
       VALUES ('2026-10-01', $1, $2, $3, $4, 495, 25, 10, 'pulled', NOW(), NOW(), '2026-10-10') RETURNING id`,
      [tenantId, pay.landlord_id, pay.unit_id, leaseId])).rows[0].id
    await db.query(
      `UPDATE payments SET type = 'fee', entry_description = 'FLEXPAY', revenue_owner = 'gam', amount = 520, flexpay_advance_id = $2
        WHERE id = $1`, [rentId, adv])
    await db.query(`UPDATE flexpay_advances SET rent_payment_id = $2 WHERE id = $1`, [adv, rentId])
    await processAchRetries()
    // One bounce so far: the $495 FlexPay paid + the flat $25 + one $4 returned-pull fee.
    expect(updateFn).toHaveBeenCalledWith('pi_flex_reprice', expect.objectContaining({ amount: 52400 }))
    expect(confirmFn).toHaveBeenCalledTimes(1)
    expect(updateFn.mock.invocationCallOrder[0]).toBeLessThan(confirmFn.mock.invocationCallOrder[0])
    expect((await db.query<any>(`SELECT amount::float AS a FROM payments WHERE id = $1`, [rentId])).rows[0].a).toBe(524)
  })
})

describe('S655 Step 10 — a FlexPay retry that is not fired is GAM\'s', () => {
  it('a FlexPay retry whose reprice fails is GAM\'s: FlexPay stays on, no wait, and the collection is made again — once', async () => {
    repriceMock.mockRejectedValueOnce(new Error('reprice broke'))
    const { rentId, tenantId, leaseId } = await seedLeasedRetry('pi_flex_reprice_fail')
    const pay = (await db.query<any>(`SELECT unit_id, landlord_id FROM payments WHERE id = $1`, [rentId])).rows[0]
    await db.query(`UPDATE tenants SET flexpay_enrolled = TRUE, flexpay_pull_day = 10, flexpay_monthly_fee = 25, ach_verified = TRUE WHERE id = $1`, [tenantId])
    const adv = (await db.query<{ id: string }>(
      `INSERT INTO flexpay_advances (cycle_month, tenant_id, landlord_id, unit_id, lease_id, rent_amount, tenant_fee_amount,
                                     pull_day, status, fronted_at, pulled_at, pull_date)
       VALUES ('2026-10-01', $1, $2, $3, $4, 495, 25, 10, 'pulled', NOW(), NOW(), '2026-10-10') RETURNING id`,
      [tenantId, pay.landlord_id, pay.unit_id, leaseId])).rows[0].id
    await db.query(
      `UPDATE payments SET type = 'fee', entry_description = 'FLEXPAY', revenue_owner = 'gam', amount = 520, flexpay_advance_id = $2
        WHERE id = $1`, [rentId, adv])
    await db.query(`UPDATE flexpay_advances SET rent_payment_id = $2 WHERE id = $1`, [adv, rentId])

    const res = await processAchRetries()
    expect(res.failed).toBe(1)
    expect(confirmFn).not.toHaveBeenCalled()
    expect(cancelFn).toHaveBeenCalledWith('pi_flex_reprice_fail')
    // Made again: the advance waits on its pull, the row is set to be pulled
    // afresh. It is the same collection: its one bank return stays counted on
    // the row (the bank sees it at most three times in all), and the try
    // collects that return's $4 fee on the amount pulled — never folded into
    // the advance, which a write-off would add again from the count.
    const a = (await db.query<any>(`SELECT status, default_reason, tenant_fee_amount::float AS fee FROM flexpay_advances WHERE id = $1`, [adv])).rows[0]
    expect(a).toEqual({ status: 'fronted', default_reason: null, fee: 25 })
    const row = (await db.query<any>(`SELECT status, stripe_payment_intent_id, retry_count, amount::float AS amount FROM payments WHERE id = $1`, [rentId])).rows[0]
    expect(row).toEqual({ status: 'pending', stripe_payment_intent_id: null, retry_count: 1, amount: 495 + 25 + 4 })
    // Never the tenant's: FlexPay stays on, no wait.
    const t = (await db.query<any>(`SELECT flexpay_enrolled, flexpay_disqualified_until FROM tenants WHERE id = $1`, [tenantId])).rows[0]
    expect(t).toEqual({ flexpay_enrolled: true, flexpay_disqualified_until: null })
    expect((await db.query(`SELECT 1 FROM admin_notifications WHERE category = 'flexpay_pull_gam_side'`)).rowCount).toBe(1)
    // A second run changes nothing more.
    await processAchRetries()
    expect((await db.query(`SELECT 1 FROM admin_notifications WHERE category = 'flexpay_pull_gam_side'`)).rowCount).toBe(1)
    expect((await db.query<any>(`SELECT status FROM flexpay_advances WHERE id = $1`, [adv])).rows[0].status).toBe('fronted')
  })
})

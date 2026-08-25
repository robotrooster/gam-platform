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
import { query, getClient } from '../db'
import { seedLandlord } from '../test/dbHelpers'
import { reconcileStuckPayments } from './paymentReconcile'
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

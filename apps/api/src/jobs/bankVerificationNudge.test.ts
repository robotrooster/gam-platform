/**
 * S641 — chasing an unfinished bank setup.
 *
 * Two residents were parked in Stripe's `requires_action` with microdeposits
 * sent and never confirmed. One stalled nine days; the other had tried twice,
 * failed once, and was mailed "Late payment alert — Day 10" the same morning he
 * tried again. Nothing chased either of them.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const { resendSendMock, setupIntentsList } = vi.hoisted(() => ({
  resendSendMock: vi.fn(async () => ({ data: { id: `m_${Math.random().toString(36).slice(2)}` }, error: null }) as any),
  setupIntentsList: vi.fn(),
}))
vi.mock('resend', () => ({ Resend: class { emails = { send: resendSendMock } } }))
vi.mock('../lib/stripe', () => ({
  getStripe: () => ({ setupIntents: { list: setupIntentsList } }),
}))

import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedLease, seedTenant, seedLeaseTenant } from '../test/dbHelpers'
import { sendBankVerificationNudges } from './bankVerificationNudge'

const DAYS = 24 * 3600
const nowS = () => Math.floor(Date.now() / 1000)

/**
 * Stripe is waiting on the tenant. `arrival_date` is when the deposit reached
 * the bank — the real clock, not when the setup was started.
 */
const stalled = (daysSinceArrival: number, kind = 'descriptor_code') => ({
  data: [{
    status: 'requires_action',
    created: nowS() - (daysSinceArrival + 1) * DAYS,
    next_action: {
      type: 'verify_with_microdeposits',
      verify_with_microdeposits: {
        arrival_date: nowS() - daysSinceArrival * DAYS,
        microdeposit_type: kind,
        hosted_verification_url: 'https://payments.stripe.com/microdeposit/test',
      },
    },
  }],
})

beforeEach(async () => {
  await cleanupAllSchema()
  resendSendMock.mockClear()
  setupIntentsList.mockReset()
  process.env.EMAIL_SEND_LIVE = '1'
})
afterEach(() => { delete process.env.EMAIL_SEND_LIVE })

async function seedUnfinished(opts: { verified?: boolean; owes?: boolean } = {}) {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const ll = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
    const unitId = await seedUnit(c, { propertyId, landlordId: ll.landlordId })
    const leaseId = await seedLease(c, { unitId, landlordId: ll.landlordId })
    const tenantId = await seedTenant(c, { email: `t-${Math.random().toString(36).slice(2)}@mailer-test.co` })
    await seedLeaseTenant(c, { leaseId, tenantId })
    await c.query(
      `UPDATE tenants SET stripe_customer_id='cus_test', bank_last4='1501', ach_verified=$2 WHERE id=$1`,
      [tenantId, opts.verified === true])
    if (opts.owes) {
      await c.query(
        `INSERT INTO payments (landlord_id, unit_id, lease_id, type, amount, status, entry_description, due_date)
         VALUES ($1,$2,$3,'rent',460,'pending','RENT',CURRENT_DATE)`,
        [ll.landlordId, unitId, leaseId])
    }
    await c.query('COMMIT')
    return { tenantId }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

const lastSend = () => (resendSendMock.mock.calls.at(-1) as any[])![0]

describe('unfinished bank setups get chased', () => {
  it('emails somebody stalled waiting to confirm deposit amounts', async () => {
    const { tenantId } = await seedUnfinished()
    setupIntentsList.mockResolvedValue(stalled(9))

    const r = await sendBankVerificationNudges()
    expect(r.sent).toBe(1)
    expect(lastSend().subject).toContain('bank account')
    expect(lastSend().html).toContain('1501')
    // Stripe's own page is the shortest route to a finished setup
    expect(lastSend().html).toContain('payments.stripe.com/microdeposit')

    const { rows } = await db.query(
      `SELECT bank_verify_nudge_count, bank_verify_nudge_at FROM tenants WHERE id=$1`, [tenantId])
    expect(rows[0].bank_verify_nudge_count).toBe(1)
    expect(rows[0].bank_verify_nudge_at).not.toBeNull()
  })

  // Timed off Stripe's arrival_date, not off when the setup started. Asking
  // somebody to read a statement line their bank has not posted is worse than
  // saying nothing.
  it('waits until the deposit has actually landed', async () => {
    await seedUnfinished()
    setupIntentsList.mockResolvedValue(stalled(0))
    const r = await sendBankVerificationNudges()
    expect(r.sent).toBe(0)
    expect(r.skippedNotStalled).toBe(1)
  })

  it('leaves a verified tenant alone', async () => {
    await seedUnfinished({ verified: true })
    setupIntentsList.mockResolvedValue(stalled(9))
    expect((await sendBankVerificationNudges()).sent).toBe(0)
    expect(resendSendMock).not.toHaveBeenCalled()
  })

  it('says nothing when Stripe is not actually waiting on them', async () => {
    await seedUnfinished()
    setupIntentsList.mockResolvedValue({ data: [{ status: 'requires_payment_method', created: nowS() - 9*DAYS }] })
    const r = await sendBankVerificationNudges()
    expect(r.sent).toBe(0)
    expect(r.skippedNotStalled).toBe(1)
  })

  // The live account uses descriptor_code: ONE deposit with a six-character
  // code in the statement description. Telling somebody to enter two amounts
  // sends them hunting for something that is not on their statement.
  it('describes a descriptor code, not two amounts', async () => {
    await seedUnfinished()
    setupIntentsList.mockResolvedValue(stalled(8, 'descriptor_code'))
    await sendBankVerificationNudges()
    expect(lastSend().html).toContain('six-character code')
    expect(lastSend().html).not.toContain('two small deposits')
  })

  it('describes two amounts when Stripe says that is the method', async () => {
    await seedUnfinished()
    setupIntentsList.mockResolvedValue(stalled(8, 'amounts'))
    await sendBankVerificationNudges()
    expect(lastSend().html).toContain('two small deposits')
    expect(lastSend().html).not.toContain('six-character code')
  })

  // The lesson from this session's other reminder: 74 emails to one person in
  // eight days. A reminder without a ceiling is not a reminder.
  it('stops after four, and does not send twice in one window', async () => {
    const { tenantId } = await seedUnfinished()
    setupIntentsList.mockResolvedValue(stalled(9))

    expect((await sendBankVerificationNudges()).sent).toBe(1)
    // same day again — the interval has not elapsed
    expect((await sendBankVerificationNudges()).sent).toBe(0)

    await db.query(
      `UPDATE tenants SET bank_verify_nudge_count = 4,
              bank_verify_nudge_at = NOW() - interval '30 days' WHERE id=$1`, [tenantId])
    expect((await sendBankVerificationNudges()).sent).toBe(0)
  })

  // Somebody being chased for late rent may believe their bank is set up. Say so.
  it('tells a tenant who owes money that the balance is still owed', async () => {
    await seedUnfinished({ owes: true })
    setupIntentsList.mockResolvedValue(stalled(9))
    await sendBankVerificationNudges()
    expect(lastSend().html).toContain('still owed')
  })

  it('stays quiet for a tenant who owes nothing', async () => {
    await seedUnfinished()
    setupIntentsList.mockResolvedValue(stalled(9))
    await sendBankVerificationNudges()
    expect(lastSend().html).not.toContain('still owed')
  })
})

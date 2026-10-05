/**
 * S641 — chasing an unfinished bank setup.
 *
 * Two residents were parked in Stripe's `requires_action` with microdeposits
 * sent and never confirmed. One stalled nine days; the other had tried twice,
 * failed once, and was mailed "Late payment alert — Day 10" the same morning he
 * tried again. Nothing chased either of them.
 *
 * S655 (item L, keep the old bank): adding a bank no longer turns ach_verified
 * off, so a tenant with a verified bank who adds another is chased too — off
 * tenants.bank_pending_since — and the email names the bank that is waiting.
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
const stalledSetup = (daysSinceArrival: number, kind = 'descriptor_code', waitingLast4?: string) => ({
    id: 'seti_waiting',
    status: 'requires_action',
    // Stripe always names the bank on a setup waiting for its deposits; its
    // last 4 may be missing, and then the bank on file is named.
    payment_method: { id: 'pm_waiting', type: 'us_bank_account',
                      us_bank_account: waitingLast4 ? { last4: waitingLast4 } : {} },
    created: nowS() - (daysSinceArrival + 1) * DAYS,
    next_action: {
      type: 'verify_with_microdeposits',
      verify_with_microdeposits: {
        arrival_date: nowS() - daysSinceArrival * DAYS,
        microdeposit_type: kind,
        hosted_verification_url: 'https://payments.stripe.com/microdeposit/test',
      },
    },
})
const stalled = (daysSinceArrival: number, kind = 'descriptor_code', waitingLast4?: string) => ({
  data: [stalledSetup(daysSinceArrival, kind, waitingLast4)],
})

beforeEach(async () => {
  await cleanupAllSchema()
  resendSendMock.mockClear()
  setupIntentsList.mockReset()
  process.env.EMAIL_SEND_LIVE = '1'
})
afterEach(() => { delete process.env.EMAIL_SEND_LIVE })

async function seedUnfinished(opts: { verified?: boolean; owes?: boolean; pending?: boolean } = {}) {
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
      `UPDATE tenants SET stripe_customer_id='cus_test', bank_last4='1501', ach_verified=$2,
              bank_pending_since = CASE WHEN $3::boolean THEN NOW() - interval '9 days' ELSE NULL END
        WHERE id=$1`,
      [tenantId, opts.verified === true, opts.pending === true])
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

  // S655: was "leaves a verified tenant alone". A verified tenant is left alone
  // only while nothing is waiting — the old bank no longer stands in for the new.
  it('leaves a verified tenant with no bank waiting alone, without asking Stripe', async () => {
    await seedUnfinished({ verified: true })
    setupIntentsList.mockResolvedValue(stalled(9))
    expect((await sendBankVerificationNudges()).sent).toBe(0)
    expect(setupIntentsList).not.toHaveBeenCalled()
    expect(resendSendMock).not.toHaveBeenCalled()
  })

  it('chases a new bank waiting beside a verified one, and names the bank that is waiting', async () => {
    const { tenantId } = await seedUnfinished({ verified: true, pending: true })
    setupIntentsList.mockResolvedValue(stalled(9, 'descriptor_code', '7777'))
    const r = await sendBankVerificationNudges()
    expect(r.sent).toBe(1)
    expect(lastSend().html).toContain('7777')       // the new bank
    expect(lastSend().html).not.toContain('1501')   // not the verified one on file
    expect(setupIntentsList).toHaveBeenCalledWith(
      expect.objectContaining({ customer: 'cus_test', expand: ['data.payment_method'] }))
    const { rows } = await db.query(`SELECT bank_verify_nudge_count FROM tenants WHERE id=$1`, [tenantId])
    expect(rows[0].bank_verify_nudge_count).toBe(1)
  })

  it('clears the waiting flag once Stripe is no longer waiting', async () => {
    const { tenantId } = await seedUnfinished({ verified: true, pending: true })
    setupIntentsList.mockResolvedValue({ data: [{ status: 'succeeded', created: nowS() - 9 * DAYS }] })
    const r = await sendBankVerificationNudges()
    expect(r.sent).toBe(0)
    const { rows } = await db.query(`SELECT bank_pending_since FROM tenants WHERE id=$1`, [tenantId])
    expect(rows[0].bank_pending_since).toBeNull()
  })

  // S655 fix round 2: a verification recorded while Stripe could not say
  // whether another bank waited keeps the flag and the count; this run settles
  // them. The next bank's chase then starts from zero, not from where the last
  // one stopped.
  it('clearing the waiting flag starts the reminder count over', async () => {
    const { tenantId } = await seedUnfinished({ verified: true, pending: true })
    await db.query(
      `UPDATE tenants SET bank_verify_nudge_count = 2, bank_verify_nudge_at = NOW() - interval '4 days' WHERE id=$1`,
      [tenantId])
    setupIntentsList.mockResolvedValue({ data: [] })
    const r = await sendBankVerificationNudges()
    expect(r).toMatchObject({ sent: 0, skippedNotStalled: 1 })
    expect(resendSendMock).not.toHaveBeenCalled()
    const { rows: [t] } = await db.query<any>(
      `SELECT bank_pending_since, bank_verify_nudge_count, bank_verify_nudge_at FROM tenants WHERE id=$1`, [tenantId])
    expect(t).toEqual({ bank_pending_since: null, bank_verify_nudge_count: 0, bank_verify_nudge_at: null })
  })

  it('a bank still waiting keeps its reminder count when the flag is already set', async () => {
    const { tenantId } = await seedUnfinished({ verified: true, pending: true })
    await db.query(
      `UPDATE tenants SET bank_verify_nudge_count = 2, bank_verify_nudge_at = NOW() - interval '4 days' WHERE id=$1`,
      [tenantId])
    setupIntentsList.mockResolvedValue(stalled(9))
    expect((await sendBankVerificationNudges()).sent).toBe(1)
    const { rows: [t] } = await db.query<any>(
      `SELECT bank_pending_since IS NOT NULL AS waiting, bank_verify_nudge_count FROM tenants WHERE id=$1`, [tenantId])
    expect(t).toEqual({ waiting: true, bank_verify_nudge_count: 3 })
  })

  it('sets the waiting flag for a setup that never reached confirm-setup', async () => {
    const { tenantId } = await seedUnfinished()
    setupIntentsList.mockResolvedValue(stalled(9))
    await sendBankVerificationNudges()
    const { rows } = await db.query(
      `SELECT bank_pending_since IS NOT NULL AS set FROM tenants WHERE id=$1`, [tenantId])
    expect(rows[0].set).toBe(true)
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

  // Fix round 1: the job looked at only the newest 5 setups, so a waiting bank
  // behind newer card setups or retries was missed — and its flag cleared.
  it('finds a waiting bank behind more than five newer setups', async () => {
    const { tenantId } = await seedUnfinished({ verified: true, pending: true })
    const newer = Array.from({ length: 6 }, (_, i) => ({
      id: `seti_card_${i}`, status: 'succeeded', created: nowS() - i * 60,
      payment_method: { id: `pm_card_${i}`, type: 'card', card: { last4: '4242' } },
    }))
    setupIntentsList.mockImplementation(async (args: any) =>
      ({ data: [...newer, stalledSetup(9, 'descriptor_code', '7777')].slice(0, args.limit ?? 10) }))
    const r = await sendBankVerificationNudges()
    expect(r.sent).toBe(1)
    expect(lastSend().html).toContain('7777')
    const { rows } = await db.query(`SELECT bank_pending_since IS NOT NULL AS set FROM tenants WHERE id=$1`, [tenantId])
    expect(rows[0].set).toBe(true)
  })

  // Stripe is checking the deposits the tenant entered: the bank is still on
  // its way (the portal lists it as verifying), but there is nothing to ask.
  it('a bank whose deposits Stripe is checking keeps the waiting flag and is not chased', async () => {
    const { tenantId } = await seedUnfinished({ verified: true, pending: true })
    setupIntentsList.mockResolvedValue({ data: [{
      id: 'seti_checking', status: 'processing', created: nowS() - 9 * DAYS, next_action: null,
      payment_method: { id: 'pm_checking', type: 'us_bank_account', us_bank_account: { last4: '5555' } },
    }] })
    const r = await sendBankVerificationNudges()
    expect(r.sent).toBe(0)
    expect(r.skippedNotStalled).toBe(1)
    expect(resendSendMock).not.toHaveBeenCalled()
    const { rows } = await db.query(`SELECT bank_pending_since IS NOT NULL AS set FROM tenants WHERE id=$1`, [tenantId])
    expect(rows[0].set).toBe(true)
  })

  // The job's flag write used to take no lock: a confirm-setup that recorded a
  // new waiting bank while the job was asking Stripe could have its flag
  // cleared a moment later. The job now asks and writes under the tenant's
  // bank lock, so that confirm-setup lands after it.
  it('a confirm-setup that lands while the job asks Stripe keeps its waiting flag', async () => {
    const { tenantId } = await seedUnfinished({ verified: true, pending: true })
    let writer: Promise<void> | null = null
    setupIntentsList.mockImplementation(async () => {
      writer = (async () => {
        const c = await db.connect()
        try {
          await c.query('BEGIN')
          await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`tenant_bank:${tenantId}`])
          await c.query(`UPDATE tenants SET bank_pending_since = NOW() WHERE id = $1`, [tenantId])
          await c.query('COMMIT')
        } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e } finally { c.release() }
      })()
      await new Promise((r) => setTimeout(r, 300))
      return { data: [] }                     // Stripe answered before the new setup existed
    })
    await sendBankVerificationNudges()
    await writer
    const { rows } = await db.query(`SELECT bank_pending_since IS NOT NULL AS set FROM tenants WHERE id=$1`, [tenantId])
    expect(rows[0].set).toBe(true)
  })

  it('when Stripe cannot be asked, the waiting flag is left as it was', async () => {
    const { tenantId } = await seedUnfinished({ verified: true, pending: true })
    setupIntentsList.mockRejectedValue(new Error('stripe down'))
    const r = await sendBankVerificationNudges()
    expect(r.failed).toBe(1)
    const { rows } = await db.query(`SELECT bank_pending_since IS NOT NULL AS set FROM tenants WHERE id=$1`, [tenantId])
    expect(rows[0].set).toBe(true)
  })

  // "Still owed" uses the shared payable rule: a payment already on its way is
  // not called owed.
  it('does not tell a tenant whose only bill is already being paid that a balance is owed', async () => {
    const { tenantId } = await seedUnfinished()
    await db.query(
      `INSERT INTO payments (landlord_id, unit_id, lease_id, type, amount, status, entry_description, due_date,
                             stripe_payment_intent_id)
       SELECT l.landlord_id, l.unit_id, l.id, 'rent', 460, 'pending', 'RENT', CURRENT_DATE, 'pi_on_its_way'
         FROM leases l JOIN lease_tenants lt ON lt.lease_id = l.id WHERE lt.tenant_id = $1`, [tenantId])
    setupIntentsList.mockResolvedValue(stalled(9))
    await sendBankVerificationNudges()
    expect(lastSend().html).not.toContain('still owed')
  })
})

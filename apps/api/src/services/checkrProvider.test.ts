/**
 * CheckrProvider — CHECKR TENANT API contract (S553 rewrite; the previous
 * suite still asserted the pre-S551 classic API: candidate+report calls,
 * SSN in the intake, X-Checkr-Signature. The adapter moved to Tenant
 * orders in S551 — POST /orders, hosted apply flow, Tenant-Signature —
 * and this suite now pins THAT contract).
 *
 * Covered here: initiate() (order create, status mapping, guard rails),
 * verifyWebhook() (Tenant-Signature t/v1 HMAC of "<t>.<raw>"),
 * parseWebhook() (Tenant event envelope → normalized updates),
 * craDisclosure(). fetchReport + the live webhook route are covered by
 * background-checkr-webhook.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import crypto from 'crypto'
import { getProvider } from './backgroundProvider'

const provider = getProvider('checkr')

const originalEnv = { ...process.env }
beforeEach(() => {
  process.env.CHECKR_API_KEY = 'ckr_sk_test_mock_key'
  process.env.CHECKR_PACKAGE = 'essential'
  process.env.CHECKR_WEBHOOK_SECRET = 'whsec_mock_checkr_secret'
})
afterEach(() => {
  process.env = { ...originalEnv }
  vi.restoreAllMocks()
})

const happyIntake = () => ({
  backgroundCheckId: 'bg-1',
  firstName: 'Jane', lastName: 'Doe',
  email: 'jane@test.dev',
  dateOfBirth: '1990-04-12',
  street1: '100 Main St', city: 'Phoenix', state: 'AZ', zip: '85001',
  consentCredit: true, consentCriminal: true,
  // S551: the RENTAL property being screened for — required by Tenant orders.
  property: { name: 'Sunset Palms', street: '200 Palm Dr', city: 'Phoenix', state: 'AZ', zipcode: '85001' },
})

const mockOrderResponse = (order: Record<string, unknown>, ok = true, status = 200) =>
  vi.spyOn(globalThis, 'fetch' as any).mockResolvedValue({
    ok, status,
    json: async () => order,
    text: async () => JSON.stringify(order),
  } as any)

describe('CheckrProvider registration', () => {
  it('getProvider("checkr") returns the CheckrProvider instance', () => {
    expect(provider.name).toBe('checkr')
  })
})

describe('CheckrProvider.initiate (Tenant orders)', () => {
  it('happy: POSTs one order (no SSN ever) → order id as providerRef, hosted apply link surfaced', async () => {
    const spy = mockOrderResponse({ id: 'ord_abc123', status: 'waiting_for_applicant', application_url: 'https://tenant.checkr.com/apply/xyz' })
    const res = await provider.initiate(happyIntake())
    expect(res.providerRef).toBe('ord_abc123')
    expect(res.status).toBe('awaiting_applicant')
    expect(res.applicantRedirectUrl).toBe('https://tenant.checkr.com/apply/xyz')

    expect(spy).toHaveBeenCalledTimes(1) // ONE call — no candidate/report legs
    const [url, init] = spy.mock.calls[0] as [string, any]
    expect(url).toMatch(/\/orders$/)
    const body = JSON.parse(init.body)
    expect(body.order.package).toBe('essential')
    expect(body.order.property.street).toBe('200 Palm Dr')
    expect(body.order.applicant).toMatchObject({ first_name: 'Jane', email: 'jane@test.dev', dob: '1990-04-12' })
    expect(JSON.stringify(body)).not.toMatch(/ssn/i) // PII stays on Checkr's hosted form
    expect(init.headers.Authorization).toBe('Bearer ckr_sk_test_mock_key')
  })

  it.each([
    ['pending', 'processing'],
    ['completed', 'complete'],
    ['canceled', 'cancelled'],
    ['something_unknown', 'failed'],
  ])('order status "%s" maps to "%s"', async (raw, mapped) => {
    mockOrderResponse({ id: 'ord_x', status: raw, application_url: null })
    const res = await provider.initiate(happyIntake())
    expect(res.status).toBe(mapped)
  })

  // S637 — REVERSES the gate this test used to assert.
  //
  // Checkr collects the FCRA disclosure and authorization on its OWN hosted
  // apply flow (S578), which is why GAM's intake stopped rendering consent
  // boxes and the route stopped requiring them. This adapter kept demanding
  // them anyway, so it rejected every order before Checkr was ever called —
  // AFTER the applicant had paid. Anastacio Erreguin paid $44.99 and got
  // nothing; he was the first person to use the link.
  it('submits without GAM-side consent flags — Checkr collects consent itself', async () => {
    mockOrderResponse({ id: 'ord_consent', status: 'pending', application_url: null })
    const res = await provider.initiate({
      ...happyIntake(), consentCredit: false, consentCriminal: false,
    })
    expect(res.status).not.toBe('failed')
    expect(res.providerRef).toBe('ord_consent')
  })

  it('missing rental property → failed with explicit reason (Tenant orders require it)', async () => {
    const res = await provider.initiate({ ...happyIntake(), property: undefined })
    expect(res.status).toBe('failed')
    expect(res.failureReason).toMatch(/property/i)
  })

  it('missing CHECKR_API_KEY → clean throw', async () => {
    delete process.env.CHECKR_API_KEY
    await expect(provider.initiate(happyIntake())).rejects.toThrow(/CHECKR_API_KEY/)
  })

  it('order API non-2xx → failed with status + body excerpt', async () => {
    mockOrderResponse({ error: 'invalid package' }, false, 422)
    const res = await provider.initiate(happyIntake())
    expect(res.status).toBe('failed')
    expect(res.failureReason).toMatch(/422/)
    expect(res.failureReason).toMatch(/invalid package/)
  })
})

describe('CheckrProvider.verifyWebhook (Tenant-Signature)', () => {
  const raw = JSON.stringify({ id: 'evt_1', type: 'report.completed', data: { order_id: 'ord_1' } })
  const sigFor = (body: string, secret: string, t = Math.floor(Date.now() / 1000)) => {
    const v1 = crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')
    return `t=${t},v1=${v1}`
  }

  it('valid t/v1 HMAC of "<t>.<raw>" → true (array header handled)', () => {
    const sig = sigFor(raw, 'whsec_mock_checkr_secret')
    expect(provider.verifyWebhook({ 'tenant-signature': sig }, raw)).toBe(true)
    expect(provider.verifyWebhook({ 'tenant-signature': [sig] }, raw)).toBe(true)
  })

  it('wrong secret / tampered body / missing header / missing secret → false', () => {
    expect(provider.verifyWebhook({ 'tenant-signature': sigFor(raw, 'wrong_secret') }, raw)).toBe(false)
    expect(provider.verifyWebhook({ 'tenant-signature': sigFor(raw, 'whsec_mock_checkr_secret') }, raw + 'x')).toBe(false)
    expect(provider.verifyWebhook({}, raw)).toBe(false)
    delete process.env.CHECKR_WEBHOOK_SECRET
    expect(provider.verifyWebhook({ 'tenant-signature': sigFor(raw, 'whsec_mock_checkr_secret') }, raw)).toBe(false)
  })
})

describe('CheckrProvider.parseWebhook (Tenant events)', () => {
  const evt = (type: string, data: Record<string, unknown>) =>
    JSON.stringify({ id: 'evt_1', type, created_at: '2026-07-24T00:00:00Z', data })

  it('apply-flow progress events keep the order awaiting/processing', () => {
    expect(provider.parseWebhook(evt('order.applicant.visited', { id: 'ord_1' }))).toMatchObject({
      providerRef: 'ord_1', status: 'awaiting_applicant',
    })
    expect(provider.parseWebhook(evt('order.applicant.completed', { id: 'ord_1' }))).toMatchObject({
      providerRef: 'ord_1', status: 'processing',
    })
  })

  // ── S640: THE PER-PRODUCT PING IS NOTHING TO APPLY ──────────────────────
  //
  // This used to expect an update keyed by order_id. The event does not carry
  // one — its payload is the report ITEM — so in production it threw, the route
  // answered 500, and Checkr redelivered: 75 failures against 4 successes in 25
  // hours, burying the report.completed that finishes a screening. And there
  // was nothing to apply even if it had parsed; the check is already
  // processing. Null means acknowledged.
  it('report.product.completed is acknowledged, not applied', () => {
    expect(provider.parseWebhook(evt('report.product.completed', { id: 'rpi_1', report_id: 'rep_9' }))).toBeNull()
  })

  it('report.completed → complete, carrying the report ref for fetchReport', () => {
    const upd = provider.parseWebhook(evt('report.completed', { id: 'rep_9', order_id: 'ord_1' }))
    expect(upd).toMatchObject({ providerRef: 'ord_1', status: 'complete', reportRef: 'rep_9' })
  })

  // ── S640: CHECKR PROMISES A REPORT ID, NOT AN ORDER ID ──────────────────
  //
  //   "we POST a report.completed event ... including the report_id"
  //   "fetch it via GET /reports/{id} using the report_id from the payload"
  //
  // Demanding an order_id threw on the one event that matters. An empty
  // providerRef tells the route to resolve the order from the report body,
  // which does carry order_id.
  it('report.completed without an order id still yields the report ref', () => {
    const upd = provider.parseWebhook(evt('report.completed', { id: 'rep_9' }))
    expect(upd).toMatchObject({ providerRef: '', status: 'complete', reportRef: 'rep_9' })
  })

  it('accepts report_id as the pointer when that is the field they send', () => {
    const upd = provider.parseWebhook(evt('report.completed', { report_id: 'rep_9' }))
    expect(upd?.reportRef).toBe('rep_9')
  })

  // Checkr sends more event types than they document — report.product.completed
  // and the whole order.applicant.* family are absent from the published list.
  // An unknown event is acknowledged, never retried.
  it('an undocumented event type is acknowledged, not thrown', () => {
    expect(provider.parseWebhook(evt('order.mystery', { id: 'ord_1' }))).toBeNull()
  })
})

describe('CheckrProvider.craDisclosure', () => {
  it('names Checkr as the CRA with contact details', () => {
    const d = provider.craDisclosure()
    expect(d.name).toMatch(/Checkr/)
    expect(d.website).toMatch(/checkr\.com/)
    expect(d.address).toBeTruthy()
    expect(d.phone).toBeTruthy()
  })
})

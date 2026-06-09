/**
 * S420 CheckrProvider unit tests.
 *
 * Covered:
 *   - initiate() happy path: candidate + report created via mocked
 *     fetch; status mapped from Checkr's enum
 *   - initiate() missing CHECKR_API_KEY → throws clean error
 *   - initiate() missing CHECKR_PACKAGE → returns failed with explicit
 *     reason
 *   - initiate() candidate API non-2xx → failed
 *   - initiate() report API non-2xx → failed
 *   - initiate() missing consent → failed
 *   - verifyWebhook() valid HMAC → true
 *   - verifyWebhook() invalid signature → false
 *   - verifyWebhook() no secret env → false (refuse insecure)
 *   - parseWebhook() extracts id + status from Checkr envelope
 *   - parseWebhook() throws on missing data.object.id
 *   - Status mapping: each Checkr status → expected GAM enum
 *   - craDisclosure() returns Checkr's CRA contact info
 *
 * `getProvider('checkr')` is exercised implicitly to confirm
 * registration.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import crypto from 'crypto'
import { getProvider } from './backgroundProvider'

const provider = getProvider('checkr')

const originalEnv = { ...process.env }
beforeEach(() => {
  process.env.CHECKR_API_KEY = 'sk_test_mock_checkr_key'
  process.env.CHECKR_PACKAGE = 'tasker_pro'
  process.env.CHECKR_WEBHOOK_SECRET = 'whsec_mock_checkr_secret'
})
afterEach(() => {
  process.env = { ...originalEnv }
  vi.restoreAllMocks()
})

function mockFetchSequence(...responses: Array<{ ok: boolean; status?: number; body: any; bodyType?: 'json' | 'text' }>) {
  const fetchMock = vi.fn()
  for (const r of responses) {
    fetchMock.mockImplementationOnce(async () => ({
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 400),
      json: async () => (r.bodyType === 'text' ? null : r.body),
      text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)),
    } as any))
  }
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const happyIntake = () => ({
  backgroundCheckId: 'bg-1',
  firstName: 'Jane', lastName: 'Doe',
  email: 'jane@test.dev',
  dateOfBirth: '1990-04-12',
  ssnLast4: '1234',
  street1: '100 Main St', city: 'Phoenix', state: 'AZ', zip: '85001',
  consentCredit: true, consentCriminal: true,
})

// ─── name + registration ─────────────────────────────────────

describe('CheckrProvider registration', () => {
  it('getProvider("checkr") returns the CheckrProvider instance', () => {
    expect(provider.name).toBe('checkr')
  })
})

// ─── initiate() ──────────────────────────────────────────────

describe('CheckrProvider.initiate', () => {
  it('happy: candidate + report created; status mapped from Checkr "pending" → "processing"', async () => {
    const fetchMock = mockFetchSequence(
      { ok: true, body: { id: 'cand_abc123' } },
      { ok: true, body: { id: 'rep_xyz789', status: 'pending' } },
    )
    const res = await provider.initiate(happyIntake())
    expect(res.providerRef).toBe('rep_xyz789')
    expect(res.status).toBe('processing')
    expect(res.applicantRedirectUrl).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    // First call to /candidates with form-encoded body containing intake.
    const candCall = fetchMock.mock.calls[0]
    expect(candCall[0]).toMatch(/\/candidates$/)
    expect(candCall[1].method).toBe('POST')
    expect(candCall[1].headers.Authorization).toMatch(/^Basic /)
    expect(candCall[1].headers['Content-Type']).toBe('application/x-www-form-urlencoded')
    expect(String(candCall[1].body)).toContain('first_name=Jane')
    expect(String(candCall[1].body)).toContain('ssn=1234')
    // Second call to /reports with candidate_id + package.
    const repCall = fetchMock.mock.calls[1]
    expect(repCall[0]).toMatch(/\/reports$/)
    expect(String(repCall[1].body)).toContain('candidate_id=cand_abc123')
    expect(String(repCall[1].body)).toContain('package=tasker_pro')
  })

  it('Checkr "clear" status → "complete"', async () => {
    mockFetchSequence(
      { ok: true, body: { id: 'cand_1' } },
      { ok: true, body: { id: 'rep_1', status: 'clear' } },
    )
    const res = await provider.initiate(happyIntake())
    expect(res.status).toBe('complete')
  })

  it('Checkr "suspended" status → "cancelled"', async () => {
    mockFetchSequence(
      { ok: true, body: { id: 'cand_1' } },
      { ok: true, body: { id: 'rep_1', status: 'suspended' } },
    )
    const res = await provider.initiate(happyIntake())
    expect(res.status).toBe('cancelled')
  })

  it('Unknown Checkr status → failed (defensive)', async () => {
    mockFetchSequence(
      { ok: true, body: { id: 'cand_1' } },
      { ok: true, body: { id: 'rep_1', status: 'weird_unknown_status' } },
    )
    const res = await provider.initiate(happyIntake())
    expect(res.status).toBe('failed')
  })

  it('missing consent → failed without any HTTP call', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const res = await provider.initiate({ ...happyIntake(), consentCredit: false })
    expect(res.status).toBe('failed')
    expect(res.failureReason).toMatch(/consent/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('missing CHECKR_API_KEY → throws clean error', async () => {
    delete process.env.CHECKR_API_KEY
    // fetch should never be called — initiate should throw before any HTTP call.
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(provider.initiate(happyIntake())).rejects.toThrow(/CHECKR_API_KEY/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('missing CHECKR_PACKAGE → failed after candidate create with explicit reason', async () => {
    delete process.env.CHECKR_PACKAGE
    mockFetchSequence(
      { ok: true, body: { id: 'cand_1' } },
    )
    const res = await provider.initiate(happyIntake())
    expect(res.providerRef).toBe('cand_1')
    expect(res.status).toBe('failed')
    expect(res.failureReason).toMatch(/CHECKR_PACKAGE/)
  })

  it('candidate API non-2xx → failed with status + body excerpt', async () => {
    mockFetchSequence(
      { ok: false, status: 422, body: 'unprocessable_entity: missing zip' },
    )
    const res = await provider.initiate(happyIntake())
    expect(res.status).toBe('failed')
    expect(res.failureReason).toMatch(/422/)
    expect(res.failureReason).toMatch(/missing zip/)
  })

  it('report API non-2xx → failed after candidate created', async () => {
    mockFetchSequence(
      { ok: true,  body: { id: 'cand_1' } },
      { ok: false, status: 500, body: 'internal_server_error' },
    )
    const res = await provider.initiate(happyIntake())
    expect(res.providerRef).toBe('cand_1')
    expect(res.status).toBe('failed')
    expect(res.failureReason).toMatch(/500/)
  })
})

// ─── verifyWebhook() ─────────────────────────────────────────

describe('CheckrProvider.verifyWebhook', () => {
  const validBody = JSON.stringify({ type: 'report.completed', data: { object: { id: 'rep_1', status: 'clear' } } })
  function sign(body: string, secret: string): string {
    return crypto.createHmac('sha256', secret).update(body).digest('hex')
  }

  it('valid HMAC → true', () => {
    const sig = sign(validBody, 'whsec_mock_checkr_secret')
    expect(provider.verifyWebhook({ 'x-checkr-signature': sig }, validBody)).toBe(true)
  })

  it('tampered body → false', () => {
    const sig = sign(validBody, 'whsec_mock_checkr_secret')
    const tampered = validBody.replace('clear', 'consider')
    expect(provider.verifyWebhook({ 'x-checkr-signature': sig }, tampered)).toBe(false)
  })

  it('wrong secret → false', () => {
    const sig = sign(validBody, 'different_secret')
    expect(provider.verifyWebhook({ 'x-checkr-signature': sig }, validBody)).toBe(false)
  })

  it('no signature header → false', () => {
    expect(provider.verifyWebhook({}, validBody)).toBe(false)
  })

  it('CHECKR_WEBHOOK_SECRET missing → false (refuses insecure mode unlike mock)', () => {
    delete process.env.CHECKR_WEBHOOK_SECRET
    const sig = sign(validBody, 'whsec_mock_checkr_secret')
    expect(provider.verifyWebhook({ 'x-checkr-signature': sig }, validBody)).toBe(false)
  })

  it('signature header as array (express common shape) → handled', () => {
    const sig = sign(validBody, 'whsec_mock_checkr_secret')
    expect(provider.verifyWebhook({ 'x-checkr-signature': [sig] }, validBody)).toBe(true)
  })
})

// ─── parseWebhook() ──────────────────────────────────────────

describe('CheckrProvider.parseWebhook', () => {
  it('extracts id + status + adjudication; status mapped', () => {
    const body = JSON.stringify({
      type: 'report.completed',
      data: { object: { id: 'rep_42', status: 'consider', adjudication: 'engaged' } },
    })
    const u = provider.parseWebhook(body)
    expect(u.providerRef).toBe('rep_42')
    expect(u.status).toBe('complete')
    expect(u.reportSummary).toMatchObject({ adjudication: 'engaged', raw_status: 'consider' })
    expect(u.failureReason).toBeNull()
    expect(u.receivedAt).toBeInstanceOf(Date)
  })

  it('throws on missing data.object.id', () => {
    const body = JSON.stringify({ type: 'report.completed', data: { object: { status: 'clear' } } })
    expect(() => provider.parseWebhook(body)).toThrow(/data.object.id/)
  })

  it('throws on non-JSON body', () => {
    expect(() => provider.parseWebhook('not json')).toThrow()
  })
})

// ─── craDisclosure() ─────────────────────────────────────────

describe('CheckrProvider.craDisclosure', () => {
  it('returns Checkr CRA contact info for adverse-action notices', () => {
    const d = provider.craDisclosure()
    expect(d.name).toBe('Checkr, Inc.')
    expect(d.address).toMatch(/San Francisco/)
    expect(d.phone).toMatch(/\d{3}/)
    expect(d.website).toBe('https://checkr.com')
  })
})

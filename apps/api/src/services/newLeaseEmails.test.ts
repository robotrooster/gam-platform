/**
 * S655 — the emails about a NEW LEASE for a household already living there.
 *
 * Nic (10/2): tenant copy reads as a new lease / a rent update, never "we're
 * ending your lease". The current lease stays as it is until the new one
 * starts; from that day the new rent is billed, signed or not — said plainly.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const { resendSendMock } = vi.hoisted(() => ({
  resendSendMock: vi.fn(async () => ({ data: { id: 'msg_default' }, error: null }) as any),
}))
vi.mock('resend', () => ({ Resend: class { emails = { send: resendSendMock } } }))

import { cleanupAllSchema } from '../test/dbHelpers'
import * as email from './email'

beforeEach(async () => {
  await cleanupAllSchema()
  resendSendMock.mockReset()
  resendSendMock.mockResolvedValue({ data: { id: 'msg_default' }, error: null } as any)
  process.env.EMAIL_SEND_LIVE = '1'   // hits the mock above, never the network
})
afterEach(() => { delete process.env.EMAIL_SEND_LIVE })

const last = () => (resendSendMock.mock.calls.at(-1) as any[])[0] as { subject: string; html: string; from: string }
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')

describe('the tenant hears about a new lease, never an ending', () => {
  it('the signing request: nothing changes today; the new lease and its rent from the start date', async () => {
    await email.emailNewLeaseSigningRequest('pat@mailer-test.co', 'Pat', 'Unit 12 — Mountain View', 'Mountain View', 'https://x/sign/t',
      { startDate: '2027-01-01', rent: '1050.00' })
    const m = last()
    expect(m.subject).toBe('Your new lease is ready to sign — Unit 12 — Mountain View')
    const body = text(m.html)
    expect(body).toContain('Nothing changes today')
    expect(body).toContain('through December 31, 2026')
    expect(body).toContain('Starting January 1, 2027, the new lease takes over and your rent is $1,050.00 a month')
    expect(body).not.toMatch(/\bend(ing|s|ed)?\b|expir|terminat|vacate/i)
    expect(String(m.from)).toMatch(/support@/)
  })

  it('signed on or after its start date: it is their lease now — never "stays as it is through" a day already gone', async () => {
    await email.emailNewLeaseSigningRequest('pat@mailer-test.co', 'Pat', 'Unit 12 — Mountain View', 'Mountain View', 'https://x/sign/t',
      { startDate: '2027-01-01', rent: '1050.00', started: true })
    const m = last()
    expect(m.subject).toBe('Your new lease is ready to sign — Unit 12 — Mountain View')
    const body = text(m.html)
    expect(body).toContain('New lease — started January 1, 2027')
    expect(body).toContain('Your new lease started January 1, 2027 and is your lease now — $1,050.00 a month. Please read it and sign it.')
    expect(body).not.toContain('Nothing changes today')
    expect(body).not.toContain('December 31, 2026')
    expect(body).not.toMatch(/\bend(ing|s|ed)?\b|expir|terminat|vacate/i)
  })

  it('the reminder says the same, with the start date in the subject', async () => {
    await email.emailNewLeaseSigningReminder('pat@mailer-test.co', 'Pat', 'Unit 12 — Mountain View', 'Mountain View', 'https://x/sign/t',
      { startDate: '2027-01-01', rent: 1050 })
    const m = last()
    expect(m.subject).toBe('Reminder: your new lease starts January 1, 2027')
    const body = text(m.html)
    expect(body).toContain('Your current lease stays as it is through December 31, 2026')
    expect(body).not.toMatch(/\bend(ing|s|ed)?\b|expir|terminat|vacate|auto-?void/i)
  })
})

describe('the landlord hears what is true and what to do — one email for the lot', () => {
  it('a draft they never signed lapsed: nothing changed for the household, and how to send a new one', async () => {
    await email.emailNewLeaseDraftLapsed('ll@mailer-test.co', 'Nic', [{ unitLabel: 'Unit 12 — Mountain View', startDate: '2027-01-01' }])
    const m = last()
    expect(m.subject).toBe('New lease canceled (never signed): Unit 12 — Mountain View')
    const body = text(m.html)
    expect(body).toContain('before its start date (January 1, 2027), so it was canceled')
    expect(body).toContain('their current lease carries on exactly as it is')
    expect(body).toContain('Change → New lease from a date…')
  })

  it('several lapsed together are listed in one email', async () => {
    await email.emailNewLeaseDraftLapsed('ll@mailer-test.co', 'Nic', [
      { unitLabel: 'Unit 12 — Mountain View', startDate: '2027-01-01' },
      { unitLabel: 'Unit 14 — Mountain View', startDate: '2027-01-01' },
    ])
    expect(resendSendMock).toHaveBeenCalledTimes(1)
    const m = last()
    expect(m.subject).toBe('2 new leases canceled (never signed)')
    const body = text(m.html)
    expect(body).toContain('Unit 12 — Mountain View')
    expect(body).toContain('Unit 14 — Mountain View')
    expect(body).toContain('none of them was sent a draft')
  })

  it('drafts waiting on the landlord: one reminder listing each, with one link', async () => {
    await email.emailNewLeasesAwaitingLandlord('ll@mailer-test.co', 'Nic', [
      { unitLabel: 'Unit 12 — Mountain View', startDate: '2027-01-01', rent: '1050.00' },
      { unitLabel: 'Unit 14 — Mountain View', startDate: '2027-01-01', rent: '900' },
      { unitLabel: 'Unit 15 — Mountain View', startDate: '2027-01-01', rent: '875' },
    ], 'https://x/sign/a?queue=b,c')
    expect(resendSendMock).toHaveBeenCalledTimes(1)
    const m = last()
    expect(m.subject).toBe('Reminder: 3 new leases waiting for your signature')
    const body = text(m.html)
    expect(body).toContain('Unit 14 — Mountain View')
    expect(body).toContain('$900.00 a month')
    expect(body).toContain('each signature moves you on to the next')
    expect(m.html).toContain('https://x/sign/a?queue=b,c')
  })

  it('not signed yet, 14 days out: it takes over on its date either way', async () => {
    await email.emailNewLeaseTenantUnsigned('ll@mailer-test.co', 'Nic', [{
      unitLabel: 'Mountain View 12', tenantNames: 'Pat Resident', startDate: '2027-01-01', rent: '1050.00' }], { stage: 'soon' })
    const m = last()
    expect(m.subject).toBe('Not signed yet — new lease starts January 1, 2027: Mountain View 12')
    expect(text(m.html)).toContain('It takes over on January 1, 2027 whether or not they sign')
  })

  it('started and still not signed: in force and billing; open for their signature', async () => {
    await email.emailNewLeaseTenantUnsigned('ll@mailer-test.co', 'Nic', [{
      unitLabel: 'Mountain View 12', tenantNames: 'Pat Resident', startDate: '2027-01-01', rent: '1050.00' }], { stage: 'started' })
    const m = last()
    expect(m.subject).toBe('New lease started, still not signed: Mountain View 12')
    expect(text(m.html)).toContain('the household is billed the new rent of $1,050.00 from that day')
    expect(text(m.html)).toContain('stays open for their signature')
  })

  it('several households not signed: one email listing who', async () => {
    await email.emailNewLeaseTenantUnsigned('ll@mailer-test.co', 'Nic', [
      { unitLabel: 'Mountain View 12', tenantNames: 'Pat Resident', startDate: '2027-01-01', rent: '1050.00' },
      { unitLabel: 'Mountain View 14', tenantNames: 'Sam Resident', startDate: '2027-01-01', rent: '900.00' },
    ], { stage: 'soon' })
    expect(resendSendMock).toHaveBeenCalledTimes(1)
    const m = last()
    expect(m.subject).toBe('Not signed yet — 2 new leases start soon')
    const body = text(m.html)
    expect(body).toContain('Sam Resident')
    expect(body).toContain('Mountain View 14')
  })

  it('American spelling throughout: canceled, never cancelled', async () => {
    await email.emailNewLeaseDraftLapsed('ll@mailer-test.co', 'Nic', [{ unitLabel: 'Unit 12', startDate: '2027-01-01' }])
    await email.emailNewLeasesAwaitingLandlord('ll@mailer-test.co', 'Nic', [{ unitLabel: 'Unit 12', startDate: '2027-01-01', rent: 1 }], 'https://x')
    for (const call of resendSendMock.mock.calls as any[]) {
      expect(call[0].subject + ' ' + text(call[0].html)).not.toMatch(/cancell/i)
    }
  })
})

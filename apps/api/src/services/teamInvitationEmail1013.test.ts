/**
 * 10/13 evening (Nic): "team invites expire after 24 HOURS (fix the email that
 * says 7 days)."
 *
 * The team invitation's link has always died 24 hours after it was sent
 * (routes/scopes.ts), and the email said "This invitation expires in 7 days".
 * Both the first email and a resend now say 24 hours, from the one number the
 * route uses (TEAM_INVITATION_TTL_HOURS).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const { resendSendMock } = vi.hoisted(() => ({
  resendSendMock: vi.fn(async () => ({ data: { id: 'msg_default' }, error: null }) as any),
}))
vi.mock('resend', () => ({
  Resend: class {
    emails = { send: resendSendMock }
  },
}))

import { TEAM_INVITATION_TTL_HOURS } from '@gam/shared'
import { cleanupAllSchema } from '../test/dbHelpers'
import * as email from './email'

beforeEach(async () => {
  await cleanupAllSchema()
  resendSendMock.mockReset()
  // provider_message_id is UNIQUE in email_send_log: one id per send.
  let n = 0
  resendSendMock.mockImplementation(async () => ({ data: { id: `msg_${++n}` }, error: null }) as any)
  // Same as services/email.test.ts: the Resend client is mocked above, so the
  // send path is exercised without ever reaching the network.
  process.env.EMAIL_SEND_LIVE = '1'
})
afterEach(() => { delete process.env.EMAIL_SEND_LIVE })

const lastSent = () => (resendSendMock.mock.calls.at(-1) as any[])![0] as { subject: string; html: string }

describe('10/13: the team invitation email says how long the link works — 24 hours', () => {
  it('the first email says 24 hours, never 7 days', async () => {
    await email.emailInvitation('first@mailer-test.co', 'Mountain View RV', 'bookkeeper', 'https://x/invite/a')
    const { html } = lastSent()
    expect(TEAM_INVITATION_TTL_HOURS).toBe(24)
    expect(html).toContain('This invitation expires in <strong style="color:#eef1f8">24 hours</strong>.')
    expect(html).not.toMatch(/7 days|seven days/i)
  })

  it('a resend says 24 hours too, and that the earlier link no longer works', async () => {
    await email.emailInvitation('again@mailer-test.co', 'Mountain View RV', 'maintenance', 'https://x/invite/b', { resend: true })
    const { html } = lastSent()
    expect(html).toContain('This invitation expires in <strong style="color:#eef1f8">24 hours</strong>.')
    expect(html).toContain('no longer works')
    expect(html).not.toMatch(/7 days|seven days/i)
  })
})

// Found on the way: the PM-company and service-business staff invitations had
// the same wrong sentence, and their links die at 24 hours too
// (routes/pm.ts, routes/businessUsers.ts: INVITATION_TTL_HOURS = 24).
describe('10/13: the other staff invitation emails say 24 hours as well', () => {
  it('a PM company staff invitation', async () => {
    await email.emailPmInvitation('pm@mailer-test.co', 'Pat', 'Desert PM', 'staff', 'https://x/pm/accept')
    const { html } = lastSent()
    expect(html).toContain('This invitation expires in 24 hours.')
    expect(html).not.toMatch(/7 days|seven days/i)
  })

  it('a service-business staff invitation', async () => {
    await email.emailBusinessInvitation('biz@mailer-test.co', 'Sam', 'Haul Co', 'driver', 'https://x/biz/accept')
    const { html } = lastSent()
    expect(html).toContain('This invitation expires in 24 hours.')
    expect(html).not.toMatch(/7 days|seven days/i)
  })
})

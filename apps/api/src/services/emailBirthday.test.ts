/**
 * 10/13 (Nic): "Hey, happy birthday from GAM ... Thank you for using GAM" —
 * the email itself. GAM's normal (noreply) sender, the person's first name
 * escaped, the thank-you line, where to switch it off, and a log row under
 * category 'birthday'. The Resend client is mocked: nothing leaves the test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const { resendSendMock } = vi.hoisted(() => ({
  resendSendMock: vi.fn(async (_args: any) => ({ data: { id: 'msg_bday' }, error: null }) as any),
}))
vi.mock('resend', () => ({
  Resend: class { emails = { send: resendSendMock } },
}))

import { db } from '../db'
import { cleanupAllSchema } from '../test/dbHelpers'
import { emailBirthdayGreeting, mailLeavesThisMachine } from './email'

beforeEach(async () => {
  await cleanupAllSchema()
  resendSendMock.mockClear()
  // Opt into the send path so it reaches the MOCKED client (see email.test.ts).
  process.env.EMAIL_SEND_LIVE = '1'
})
afterEach(() => { delete process.env.EMAIL_SEND_LIVE })

describe('emailBirthdayGreeting', () => {
  it('wishes them happy birthday by name, thanks them for using GAM, and says how to switch it off', async () => {
    const id = await emailBirthdayGreeting({
      to: 'rosa@mailer-test.co', firstName: 'Rosa <b>', ctx: { userId: null, audience: 'tenant' },
    })
    expect(id).toBe('msg_bday')
    expect(resendSendMock).toHaveBeenCalledTimes(1)
    const call = resendSendMock.mock.calls[0][0]
    expect(call.subject).toBe('Happy birthday from GAM')
    expect(call.from).toBe('GAM <noreply@gam.test>')
    expect(call.html).toContain('Happy birthday, Rosa &lt;b&gt;!')
    expect(call.html).not.toContain('Rosa <b>')
    expect(call.text).toContain('Thank you for using GAM.')
    expect(call.text).toContain('Turn it off under Notifications')
  })

  it('no first name → a plain "Happy birthday!"', async () => {
    await emailBirthdayGreeting({ to: 'noname@mailer-test.co', firstName: '  ' })
    expect(resendSendMock.mock.calls[0][0].html).toContain('Happy birthday!')
  })

  it('is logged under category birthday, against the person', async () => {
    const { rows: [u] } = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name)
       VALUES ('logme@mailer-test.co', 'x', 'landlord', 'Lee', 'L') RETURNING id`)
    await emailBirthdayGreeting({ to: 'logme@mailer-test.co', firstName: 'Lee', ctx: { userId: u.id, audience: 'landlord' } })
    const { rows: [log] } = await db.query<any>(
      `SELECT category, status, related_entity_type, related_entity_id, metadata, landlord_id
         FROM email_send_log WHERE to_email = 'logme@mailer-test.co'`)
    expect(log).toMatchObject({
      category: 'birthday', status: 'sent', related_entity_type: 'user', related_entity_id: u.id,
      metadata: { audience: 'landlord' }, landlord_id: null,
    })
  })
})

// The birthday job asks this before it claims anyone's once-a-year row: a dev
// API shares the production database and must never use up a greeting.
describe('mailLeavesThisMachine — send()\'s own rule', () => {
  it('a non-production process with no EMAIL_SEND_LIVE sends nothing', () => {
    delete process.env.EMAIL_SEND_LIVE
    expect(process.env.NODE_ENV).not.toBe('production')
    expect(mailLeavesThisMachine()).toBe(false)
  })
  it('EMAIL_SEND_LIVE=1 (with a mail key configured) sends', () => {
    process.env.EMAIL_SEND_LIVE = '1'
    expect(mailLeavesThisMachine()).toBe(true)
  })
  it('production (with a mail key configured) sends', () => {
    delete process.env.EMAIL_SEND_LIVE
    const was = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    try { expect(mailLeavesThisMachine()).toBe(true) } finally { process.env.NODE_ENV = was }
  })
})

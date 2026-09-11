/**
 * S641 (Nic) — "do we have it set up where as soon as Stripe sends the
 * microdeposits or the verification code, it will email the tenant as well?"
 *
 * We did not. Dominic Gonzalez started a bank setup on September 2 and sat in
 * requires_action for nine days: nothing told him a deposit was coming, so
 * there was nothing for him to act on.
 *
 * These cover the EMAIL's two tenses. The wiring that fires the first one lives
 * in routes/stripe.ts at confirm time, because that response is the first
 * moment the arrival date and the hosted link exist.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const { resendSendMock } = vi.hoisted(() => ({
  resendSendMock: vi.fn(async () => ({ data: { id: `m_${Math.random().toString(36).slice(2)}` }, error: null }) as any),
}))
vi.mock('resend', () => ({ Resend: class { emails = { send: resendSendMock } } }))

import { cleanupAllSchema } from '../test/dbHelpers'
import { emailVerifyBankReminder } from './email'

beforeEach(async () => {
  await cleanupAllSchema()
  resendSendMock.mockClear()
  process.env.EMAIL_SEND_LIVE = '1'
})
afterEach(() => { delete process.env.EMAIL_SEND_LIVE })

const sent = () => (resendSendMock.mock.calls.at(-1) as any[])![0]

const base = {
  tenantName: 'Dominic',
  bankLast4: '2991',
  arrivedOn: 'Thursday, September 3',
  verificationKind: 'descriptor_code' as const,
  verifyUrl: 'https://payments.stripe.com/microdeposit/abc',
}

describe('the deposit-is-coming notice', () => {
  it('is written in the future tense and does not scold', async () => {
    await emailVerifyBankReminder('a@mailer-test.co', { ...base, kind: 'sent' })
    expect(sent().subject).toContain('on its way')
    expect(sent().html).toContain('We have sent a small verification deposit')
    expect(sent().html).toContain('When it lands')
    // a first notice must not imply they have already failed to act
    expect(sent().html).not.toContain('has not been confirmed yet')
  })

  it('carries the arrival date Stripe computed and Stripe own hosted link', async () => {
    await emailVerifyBankReminder('b@mailer-test.co', { ...base, kind: 'sent' })
    expect(sent().html).toContain('Thursday, September 3')
    expect(sent().html).toContain('payments.stripe.com/microdeposit/abc')
  })

  it('the chase is past tense and says it is outstanding', async () => {
    await emailVerifyBankReminder('c@mailer-test.co', { ...base, kind: 'reminder' })
    expect(sent().subject).toContain('Finish setting up')
    expect(sent().html).toContain('has not been confirmed yet')
    expect(sent().html).not.toContain('on its way')
  })

  it('both explain the descriptor code, never two amounts', async () => {
    for (const kind of ['sent', 'reminder'] as const) {
      await emailVerifyBankReminder(`d-${kind}@mailer-test.co`, { ...base, kind })
      expect(sent().html).toContain('six-character code')
      expect(sent().html).not.toContain('two small deposits')
    }
  })

  it('and switch to amounts when Stripe says that is the method', async () => {
    await emailVerifyBankReminder('e@mailer-test.co',
      { ...base, kind: 'sent', verificationKind: 'amounts' })
    expect(sent().html).toContain('two small deposits')
    expect(sent().html).toContain('will receive')
  })
})

/**
 * 11/1 — THE REPLY-TO KEY IS CHECKED AGAINST THE LIBRARY, NOT AGAINST US.
 *
 * services/email.ts built its Resend payload with `reply_to` from the day the
 * line was written (539fa45, 2026-08-29). The SDK (v4+; 6.12.2 here) reads
 * `replyTo` and builds its request body from a fixed allowlist, so an extra
 * `reply_to` key was not rejected — it was silently dropped. GAM therefore
 * emitted NO Reply-To header on ANY email for two months.
 *
 * With no Reply-To, a reply goes to the From address. About forty templates
 * send as 'support', so a tenant answering "if any of this looks wrong, reply
 * to this email and your landlord will take a look" reached
 * support@goldassetmanagement.com, which forwards to Nic personally. The whole
 * 10/5 reply-routing build was correct and could never take effect.
 *
 * WHY THE EXISTING TEST WENT GREEN. email.test.ts mocks the entire `resend`
 * module, so the SDK's own mapper never runs, and the assertion read
 * `.reply_to` off the mock — GAM's spelling, checked against GAM's spelling.
 * It agreed with itself for two months.
 *
 * So this file does not mock the library. It drives the REAL client against a
 * stubbed fetch and reads the bytes that would go over the wire. The key name
 * is therefore pinned to what Resend actually honours: change our spelling, or
 * upgrade to an SDK that renames the field, and this goes red.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Resend } from 'resend'

/** The outgoing request body, as the SDK would actually send it. */
async function wireBody(input: Record<string, unknown>): Promise<any> {
  let sent: any = null
  const stub = vi.fn(async (_url: any, init: any) => {
    sent = JSON.parse(String(init?.body ?? '{}'))
    return {
      ok: true, status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({ id: 'stubbed' }),
      text: async () => '{"id":"stubbed"}',
    } as any
  })
  const prior = globalThis.fetch
  globalThis.fetch = stub as any
  try {
    const client = new Resend('re_test_key_not_real')
    await client.emails.send({
      from: 'GAM <noreply@example.test>',
      to: ['someone@example.test'],
      subject: 'wire check',
      html: '<p>hi</p>',
      ...input,
    } as any)
  } finally {
    globalThis.fetch = prior
  }
  return sent
}

describe('the Reply-To key GAM sends is the one the Resend SDK honours', () => {
  beforeEach(() => { vi.restoreAllMocks() })
  afterEach(() => { vi.restoreAllMocks() })

  it('camelCase replyTo reaches the wire as reply_to', async () => {
    const body = await wireBody({ replyTo: 'landlord@example.test' })
    expect(body).toBeTruthy()
    expect(body.reply_to).toBe('landlord@example.test')
  })

  it('snake_case reply_to is SILENTLY DROPPED — the exact two-month bug', async () => {
    const body = await wireBody({ reply_to: 'landlord@example.test' })
    expect(body).toBeTruthy()
    // Not an error, not a rejection: simply absent. Nothing upstream could tell.
    expect(body.reply_to).toBeUndefined()
  })

  it('email.ts passes the honoured key, so replies reach whoever routing chose', async () => {
    // Read the source rather than the behaviour, because the failure mode here
    // is our spelling drifting from the library's and every other layer —
    // types, logs, the mocked test — reporting success while it does.
    const { readFileSync, existsSync } = await import('node:fs')
    const { join } = await import('node:path')
    // Not import.meta.url: this file is compiled by `tsc -b` for the API build,
    // which targets CommonJS and rejects import.meta outright (TS1343) — it
    // broke the 11/1 deploy after the suite had already gone green.
    const here = typeof __dirname === 'string' ? __dirname : join(process.cwd(), 'src/services')
    const candidates = [join(here, 'email.ts'), join(process.cwd(), 'src/services/email.ts')]
    const found = candidates.find(p => existsSync(p))
    expect(found, `could not find email.ts from ${here}`).toBeTruthy()
    const src = readFileSync(found!, 'utf8')
    const sendArgs = src.slice(src.indexOf('const sendArgs: any = {'))
      .slice(0, 400)
    expect(sendArgs).toMatch(/\breplyTo:/)
    expect(sendArgs).not.toMatch(/\breply_to:/)
  })
})

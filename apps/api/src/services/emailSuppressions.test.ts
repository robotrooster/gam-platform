/**
 * S651 — knowing which addresses the provider has given up on.
 *
 * A bounce fires a webhook. A suppression fires nothing, ever: the send is
 * accepted, given a message id, and discarded. Thirteen emails to Rashawn Bump
 * disappeared that way over three weeks, every one logged 'sent'.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { query } from '../db'
import { syncEmailSuppressions, suppressionFor } from './emailSuppressions'

/** A stand-in for Resend's paginated suppressions endpoint. */
function fakeResend(pages: any[][]) {
  let call = 0
  return (async (_url: any) => {
    const data = pages[call] ?? []
    const has_more = call < pages.length - 1
    call++
    return { ok: true, json: async () => ({ object: 'list', has_more, data }) } as any
  }) as unknown as typeof fetch
}

const row = (email: string, origin = 'bounce') => ({
  id: `id-${email}`, email, origin, created_at: '2026-08-29 18:20:49+00',
})

beforeEach(async () => {
  await query('DELETE FROM email_suppressions')
  process.env.RESEND_API_KEY = process.env.RESEND_API_KEY || 're_test_key'
})

describe('mirroring the provider suppression list', () => {
  it('records what the provider refuses', async () => {
    const r = await syncEmailSuppressions(fakeResend([[row('dead@icloud.com')]]))
    expect(r.fetched).toBe(1)
    expect(r.added).toBe(1)
    expect(await suppressionFor('dead@icloud.com')).toMatchObject({ origin: 'bounce' })
  })

  it('matches regardless of how the address was typed', async () => {
    await syncEmailSuppressions(fakeResend([[row('Mixed.Case@ICloud.com')]]))
    expect(await suppressionFor('mixed.case@icloud.com')).toBeTruthy()
    expect(await suppressionFor('  MIXED.CASE@icloud.com ')).toBeTruthy()
  })

  it('reads every page, so the tail is not silently un-suppressed', async () => {
    const r = await syncEmailSuppressions(fakeResend([
      [row('one@icloud.com'), row('two@icloud.com')],
      [row('three@icloud.com')],
    ]))
    expect(r.fetched).toBe(3)
    expect(await suppressionFor('three@icloud.com')).toBeTruthy()
  })

  it('un-suppresses an address the provider has dropped from the list', async () => {
    // Somebody cleaned it up, or the mailbox came back. Keeping it here would
    // make GAM refuse mail the provider is happy to deliver — a self-inflicted
    // version of the exact bug this exists to fix.
    await syncEmailSuppressions(fakeResend([[row('temp@icloud.com'), row('keep@icloud.com')]]))
    const second = await syncEmailSuppressions(fakeResend([[row('keep@icloud.com')]]))
    expect(second.removed).toBe(1)
    expect(await suppressionFor('temp@icloud.com')).toBeNull()
    expect(await suppressionFor('keep@icloud.com')).toBeTruthy()
  })

  it('says nothing about an address that was never suppressed', async () => {
    expect(await suppressionFor('fine@icloud.com')).toBeNull()
  })

  it('does nothing at all without an API key, rather than wiping the mirror', async () => {
    // A key missing from one environment must never empty the list that the
    // send path reads — that would quietly restore the old behaviour.
    await syncEmailSuppressions(fakeResend([[row('dead@icloud.com')]]))
    const saved = process.env.RESEND_API_KEY
    delete process.env.RESEND_API_KEY
    try {
      const r = await syncEmailSuppressions(fakeResend([[]]))
      expect(r.skipped).toBeTruthy()
      expect(await suppressionFor('dead@icloud.com')).toBeTruthy()
    } finally { process.env.RESEND_API_KEY = saved }
  })
})

/**
 * The half that matters: the send path must REFUSE, and must say so.
 *
 * Before this, a send to a suppressed address was accepted by the provider,
 * given a message id, discarded, and written into email_send_log as 'sent'.
 * That row is the answer to "did the tenant get their notice?", and it was
 * confidently wrong thirteen times in a row.
 */
describe('sending to an address the provider has given up on', () => {
  it('records undeliverable instead of sent, and never calls the provider', async () => {
    await query(
      `INSERT INTO email_suppressions (email, origin, suppressed_at)
       VALUES ('gone@icloud.com','bounce','2026-08-29')
       ON CONFLICT (email) DO NOTHING`)

    const prevLive = process.env.EMAIL_SEND_LIVE
    process.env.EMAIL_SEND_LIVE = '1'
    try {
      const { sendNotificationEmail } = await import('./email')
      const id = await sendNotificationEmail({
        to: 'gone@icloud.com',
        subject: 'Your lease is ready to sign',
        html: '<p>hi</p>',
        notificationType: 'esign_signing_request',
      })
      expect(id).toBeNull()   // nothing was handed to the provider
    } finally {
      if (prevLive === undefined) delete process.env.EMAIL_SEND_LIVE
      else process.env.EMAIL_SEND_LIVE = prevLive
    }

    const [log] = await query<any>(
      `SELECT status, error_message, provider_message_id FROM email_send_log
        WHERE lower(to_email)='gone@icloud.com' ORDER BY created_at DESC LIMIT 1`)
    expect(log.status).toBe('undeliverable')
    // No provider id, because the provider was never asked.
    expect(log.provider_message_id).toBeNull()
    // And the row says what to do about it, not just that something went wrong.
    expect(log.error_message).toMatch(/suppression list/i)
    expect(log.error_message).toMatch(/correct the address/i)
  })
})

/**
 * Nic: "the admin portal is not going to babysit that every day for every
 * person. It needs to flag on the landlord side."
 *
 * GAM cannot fix a dead address. Only the person who can phone the tenant and
 * ask how it is spelled can, and that is the landlord — an alert that lands
 * where nobody can act on it is a rumour.
 */
describe('telling the landlord, not just GAM', () => {
  it('notifies the landlord when an address they mail goes dead', async () => {
    const { db } = await import('../db')
    const c = await db.connect()
    let landlordUserId = '', landlordId = ''
    try {
      const { seedLandlord } = await import('../test/dbHelpers')
      const l = await seedLandlord(c)
      landlordId = l.landlordId; landlordUserId = l.userId
    } finally { c.release() }

    await query(
      `INSERT INTO users (email, password_hash, role, first_name, last_name)
       VALUES ('dead-tenant@icloud.com','x','tenant','Gone','Quiet')`)
    await query(
      `INSERT INTO email_send_log (to_email, subject, category, status, landlord_id)
       VALUES ('dead-tenant@icloud.com','Please sign','tenant_invite','sent',$1)`, [landlordId])

    await syncEmailSuppressions(fakeResend([[row('dead-tenant@icloud.com')]]))

    const [n] = await query<any>(
      `SELECT title, body, type, action_url FROM notifications
        WHERE user_id = $1 AND type = 'email_undeliverable'`, [landlordUserId])
    expect(n).toBeTruthy()
    expect(n.title).toContain('Gone Quiet')
    // Says what to DO, not just that something is wrong.
    expect(n.body).toMatch(/check the spelling/i)
    expect(n.action_url).toBe('/tenants')
  })

  it('does not nag again on the next night’s sync', async () => {
    // The sync runs nightly. A notice per night for the same dead address is
    // how a landlord learns to dismiss these without reading them.
    const { db } = await import('../db')
    const c = await db.connect()
    let landlordUserId = '', landlordId = ''
    try {
      const { seedLandlord } = await import('../test/dbHelpers')
      const l = await seedLandlord(c)
      landlordId = l.landlordId; landlordUserId = l.userId
    } finally { c.release() }

    await query(
      `INSERT INTO users (email, password_hash, role, first_name, last_name)
       VALUES ('repeat@icloud.com','x','tenant','Same','Person')`)
    await query(
      `INSERT INTO email_send_log (to_email, subject, category, status, landlord_id)
       VALUES ('repeat@icloud.com','Please sign','tenant_invite','sent',$1)`, [landlordId])

    await syncEmailSuppressions(fakeResend([[row('repeat@icloud.com')]]))
    await query('DELETE FROM email_suppressions')          // force a fresh "added"
    await syncEmailSuppressions(fakeResend([[row('repeat@icloud.com')]]))

    const notices = await query<any>(
      `SELECT id FROM notifications WHERE user_id = $1 AND type = 'email_undeliverable'`,
      [landlordUserId])
    expect(notices).toHaveLength(1)
  })
})

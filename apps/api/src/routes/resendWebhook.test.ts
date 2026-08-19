/**
 * S605: Resend delivery webhook.
 *
 * The assertions that matter are the security ones — an unsigned or tampered
 * payload must never be able to mark a landlord's address bounced, because a
 * bounce flag is what tells us to stop emailing them.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { Webhook } from 'svix'
import { db, query } from '../db'
import { cleanupAllSchema, seedLandlord } from '../test/dbHelpers'

const SECRET = 'whsec_' + Buffer.from('s'.repeat(24)).toString('base64')
process.env.RESEND_WEBHOOK_SECRET = SECRET

import { webhooksRouter } from './webhooks'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const a = express()
  // Raw body, exactly as index.ts mounts it — signature is over raw bytes.
  a.use('/webhooks/resend', express.raw({ type: 'application/json' }))
  a.use('/webhooks', webhooksRouter)
  a.use(errorHandler)
  return a
}

/** Sign a payload the way Resend/Svix does. */
function signed(payload: object) {
  const body = JSON.stringify(payload)
  const id = 'msg_test_1'
  const timestamp = new Date()
  const signature = new Webhook(SECRET).sign(id, timestamp, body)
  return {
    body,
    headers: {
      'svix-id': id,
      'svix-timestamp': Math.floor(timestamp.getTime() / 1000).toString(),
      'svix-signature': signature,
      'content-type': 'application/json',
    },
  }
}

let landlordId = ''
const MSG = 'resend-msg-abc-123'

beforeEach(async () => {
  await cleanupAllSchema()
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const ll = await seedLandlord(c)
    landlordId = ll.landlordId
    await c.query('COMMIT')
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }

  await query(
    `INSERT INTO email_send_log (to_email, subject, category, status, landlord_id, provider_message_id)
     VALUES ('ll@test.dev', 'Getting you set up on GAM', 'landlord_welcome_outreach', 'sent', $1, $2)`,
    [landlordId, MSG])
})

const readEvent = async () => (await query<{ last_event: string | null; last_event_at: Date | null }>(
  `SELECT last_event, last_event_at FROM email_send_log WHERE provider_message_id = $1`, [MSG]))[0]

describe('POST /webhooks/resend', () => {
  it('records a delivered event against the send-log row', async () => {
    const { body, headers } = signed({
      type: 'email.delivered', created_at: '2026-08-17T10:00:00.000Z', data: { email_id: MSG },
    })
    await request(buildApp()).post('/webhooks/resend').set(headers).send(body).expect(200)

    expect((await readEvent()).last_event).toBe('delivered')
  })

  it('records a bounce AND raises an admin alert — outreach going nowhere is actionable', async () => {
    const { body, headers } = signed({
      type: 'email.bounced', created_at: '2026-08-17T10:00:00.000Z', data: { email_id: MSG },
    })
    await request(buildApp()).post('/webhooks/resend').set(headers).send(body).expect(200)

    expect((await readEvent()).last_event).toBe('bounced')
    const alerts = await query<{ title: string }>(
      `SELECT title FROM admin_notifications WHERE category = 'email_delivery_failure'`)
    expect(alerts.length).toBe(1)
    expect(alerts[0].title).toMatch(/bounced/i)
  })

  it('REJECTS an unsigned payload — nobody can flag an address bounced', async () => {
    await request(buildApp())
      .post('/webhooks/resend')
      .set('content-type', 'application/json')
      .send(JSON.stringify({ type: 'email.bounced', data: { email_id: MSG } }))
      .expect(400)

    expect((await readEvent()).last_event).toBeNull()
  })

  it('REJECTS a tampered payload signed for different content', async () => {
    const { headers } = signed({ type: 'email.delivered', data: { email_id: MSG } })
    await request(buildApp())
      .post('/webhooks/resend').set(headers)
      .send(JSON.stringify({ type: 'email.bounced', data: { email_id: MSG } }))
      .expect(400)

    expect((await readEvent()).last_event).toBeNull()
  })

  it('never lets a late out-of-order event overwrite a newer one', async () => {
    const bounce = signed({
      type: 'email.bounced', created_at: '2026-08-17T12:00:00.000Z', data: { email_id: MSG } })
    await request(buildApp()).post('/webhooks/resend').set(bounce.headers).send(bounce.body).expect(200)

    // A 'delivered' that actually happened EARLIER arrives late (Svix is
    // at-least-once and unordered). It must not resurrect a dead address.
    const late = signed({
      type: 'email.delivered', created_at: '2026-08-17T09:00:00.000Z', data: { email_id: MSG } })
    await request(buildApp()).post('/webhooks/resend').set(late.headers).send(late.body).expect(200)

    expect((await readEvent()).last_event).toBe('bounced')
  })

  it('acks unmodelled event types instead of making Svix retry forever', async () => {
    const { body, headers } = signed({ type: 'email.opened', data: { email_id: MSG } })
    const r = await request(buildApp()).post('/webhooks/resend').set(headers).send(body).expect(200)
    expect(r.body.ignored).toBe(true)
    expect((await readEvent()).last_event).toBeNull()
  })
})

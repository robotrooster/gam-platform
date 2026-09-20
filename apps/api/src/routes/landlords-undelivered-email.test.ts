/**
 * S651 — telling the landlord when their mail is bouncing.
 *
 * Nic invited Arnoldo Arvizu to RV 39 at Mountain View three times and all
 * three bounced. Bounce events only ever raised a GAM-side admin notification,
 * so the one person who could fix the address never heard about it and could
 * only conclude the tenant was ignoring them.
 *
 * The two rules worth pinning are both about not crying wolf: an address that
 * bounced once and has delivered since is fine, and a message sent ten minutes
 * ago with no verdict yet must not count as good news over an older bounce.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db, query } from '../db'
import { cleanupAllSchema, seedLandlord } from '../test/dbHelpers'
import { landlordsRouter } from './landlords'
import { errorHandler } from '../middleware/errorHandler'
import { camelCaseKeys } from '../lib/caseConversion'

function buildApp() {
  const app = express()
  app.use(express.json())
  // Production camelizes every response; without this the test would assert
  // keys the portal never receives. (memory: gam-camelize-wire-contract-test-gap)
  app.use((_req, res, next) => {
    const originalJson = res.json.bind(res)
    res.json = (body: any) => originalJson(camelCaseKeys(body))
    next()
  })
  app.use('/api/landlords', landlordsRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_mail'
})

const sign = (c: any) => jwt.sign(c, process.env.JWT_SECRET!, { expiresIn: '1h' })

async function logEmail(landlordId: string, to: string, opts: {
  event?: string | null; status?: string; at: string; subject?: string
}) {
  await query(
    `INSERT INTO email_send_log
       (to_email, subject, category, status, landlord_id, last_event, last_event_at, created_at)
     VALUES ($1,$2,'tenant_invite',$3,$4,$5,$6,$6)`,
    [to, opts.subject ?? 'Please sign', opts.status ?? 'sent', landlordId,
     opts.event ?? null, opts.at])
}

async function ask(userId: string, landlordId: string) {
  return request(buildApp())
    .get('/api/landlords/me/undelivered-email')
    .set('Authorization', `Bearer ${sign({
      userId, role: 'landlord', email: 'll@t.dev',
      profileId: landlordId, landlordIds: [landlordId], permissions: {},
    })}`)
}

describe('GET /api/landlords/me/undelivered-email', () => {
  it('names the person whose mail is bouncing', async () => {
    const c = await db.connect()
    let landlordId = '', userId = ''
    try { const l = await seedLandlord(c); landlordId = l.landlordId; userId = l.userId }
    finally { c.release() }

    await logEmail(landlordId, 'arnoldo@icloud.com', { event: 'bounced', at: '2026-09-09T12:00:00Z' })
    const res = await ask(userId, landlordId)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].email).toBe('arnoldo@icloud.com')
    expect(res.body.data[0].outcome).toBe('bounced')
  })

  it('stays quiet about an address that bounced once and has delivered since', async () => {
    // Real case: landscapebygutierrez@icloud.com bounced on the 13th and
    // delivered on the 14th, 15th and 16th. Nagging about it would teach
    // everyone to stop reading this.
    const c = await db.connect()
    let landlordId = '', userId = ''
    try { const l = await seedLandlord(c); landlordId = l.landlordId; userId = l.userId }
    finally { c.release() }

    await logEmail(landlordId, 'recovered@icloud.com', { event: 'bounced',   at: '2026-09-13T12:00:00Z' })
    await logEmail(landlordId, 'recovered@icloud.com', { event: 'delivered', at: '2026-09-16T12:00:00Z' })
    const res = await ask(userId, landlordId)
    expect(res.body.data).toEqual([])
  })

  it('is not fooled by a fresh message that has no verdict yet', async () => {
    // The dangerous case. A reminder sent ten minutes ago has no delivery event
    // yet; if "no news" counted as good news it would paper over the bounce it
    // is about to repeat, and the flag would vanish every time someone resent.
    const c = await db.connect()
    let landlordId = '', userId = ''
    try { const l = await seedLandlord(c); landlordId = l.landlordId; userId = l.userId }
    finally { c.release() }

    await logEmail(landlordId, 'pending@icloud.com', { event: 'bounced', at: '2026-09-09T12:00:00Z' })
    await logEmail(landlordId, 'pending@icloud.com', { event: null,      at: '2026-09-19T12:00:00Z' })
    const res = await ask(userId, landlordId)
    expect(res.body.data.map((r: any) => r.email)).toEqual(['pending@icloud.com'])
  })

  it('never shows another company’s bounces', async () => {
    const c = await db.connect()
    let mine = '', myUser = '', theirs = ''
    try {
      const a = await seedLandlord(c); mine = a.landlordId; myUser = a.userId
      const b = await seedLandlord(c); theirs = b.landlordId
    } finally { c.release() }

    await logEmail(theirs, 'somebody-elses-tenant@icloud.com', { event: 'bounced', at: '2026-09-09T12:00:00Z' })
    const res = await ask(myUser, mine)
    expect(res.body.data).toEqual([])
  })

  it('says nothing when all the mail landed', async () => {
    const c = await db.connect()
    let landlordId = '', userId = ''
    try { const l = await seedLandlord(c); landlordId = l.landlordId; userId = l.userId }
    finally { c.release() }

    await logEmail(landlordId, 'fine@icloud.com', { event: 'delivered', at: '2026-09-16T12:00:00Z' })
    expect((await ask(userId, landlordId)).body.data).toEqual([])
  })
})

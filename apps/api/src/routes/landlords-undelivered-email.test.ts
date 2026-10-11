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
import {
  cleanupAllSchema, seedLandlord, seedTenant, seedProperty, seedUnit, seedLease, seedLeaseTenant,
} from '../test/dbHelpers'
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

/** Somebody who actually holds the address — otherwise it is nobody's problem. */
async function seedUser(email: string) {
  await query(
    `INSERT INTO users (email, password_hash, role, first_name, last_name)
     VALUES ($1,'x','tenant','Test','Person')`, [email])
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

    await seedUser('arnoldo@icloud.com')
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

    await seedUser('pending@icloud.com')
    await logEmail(landlordId, 'pending@icloud.com', { event: 'bounced', at: '2026-09-09T12:00:00Z' })
    await logEmail(landlordId, 'pending@icloud.com', { event: null,      at: '2026-09-19T12:00:00Z' })
    const res = await ask(userId, landlordId)
    expect(res.body.data.map((r: any) => r.email)).toEqual(['pending@icloud.com'])
  })

  it('forgets an address nobody holds any more', async () => {
    // Nic, on the first version of this: four of the five it flagged were typos
    // caught at onboarding and already superseded — "the person actually has
    // their account now". An address with no account and no live invitation
    // behind it cannot make anybody unreachable, and listing it forever is the
    // crying-wolf failure this endpoint exists to avoid.
    const c = await db.connect()
    let landlordId = '', userId = ''
    try { const l = await seedLandlord(c); landlordId = l.landlordId; userId = l.userId }
    finally { c.release() }

    await logEmail(landlordId, 'typo-at-onboarding@icloud.com', { event: 'bounced', at: '2026-09-01T12:00:00Z' })
    expect((await ask(userId, landlordId)).body.data).toEqual([])
  })

  it('still flags a tenant who was invited and never got the email', async () => {
    // The most important person on this list: someone with no lease and no
    // logins BECAUSE the invite bounced. A tenant invite creates the user row
    // and hangs a token off it (users.tenant_invite_token) — `invitations` is
    // team roles only and its CHECK refuses 'tenant' — so the users test above
    // is what keeps them visible. Rashawn Bump's exact shape.
    const c = await db.connect()
    let landlordId = '', userId = ''
    try { const l = await seedLandlord(c); landlordId = l.landlordId; userId = l.userId }
    finally { c.release() }

    await query(
      `INSERT INTO users (email, password_hash, role, first_name, last_name,
                          email_verified, tenant_invite_token, tenant_invite_expires_at)
       VALUES ($1,'x','tenant','Never','Arrived', FALSE, 'tok', NOW() + INTERVAL '7 days')`,
      ['never-arrived@icloud.com'])
    await logEmail(landlordId, 'never-arrived@icloud.com', { event: 'bounced', at: '2026-09-09T12:00:00Z' })

    const res = await ask(userId, landlordId)
    expect(res.body.data.map((r: any) => r.email)).toEqual(['never-arrived@icloud.com'])
  })

  it('never shows another company’s bounces', async () => {
    const c = await db.connect()
    let mine = '', myUser = '', theirs = ''
    try {
      const a = await seedLandlord(c); mine = a.landlordId; myUser = a.userId
      const b = await seedLandlord(c); theirs = b.landlordId
    } finally { c.release() }

    await seedUser('somebody-elses-tenant@icloud.com')
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

// ── Who sees whom ─────────────────────────────────────────────────────────
//
// The company filter alone let a property-scoped staff member read bounces for
// residents of every other park the company runs, and let any viewer read
// another company's unit number and the subject of another company's email.
describe('GET /api/landlords/me/undelivered-email: property scope and company isolation', () => {
  async function company() {
    const c = await db.connect()
    try {
      const l = await seedLandlord(c)
      const prop = () => seedProperty(c, { landlordId: l.landlordId, ownerUserId: l.userId, managedByUserId: l.userId })
      const park1 = await prop()
      const park2 = await prop()
      const unitIn = async (propertyId: string) => {
        const id = await seedUnit(c, { propertyId, landlordId: l.landlordId })
        const n = (await c.query<{ unit_number: string }>(`SELECT unit_number FROM units WHERE id=$1`, [id])).rows[0].unit_number
        return { id, number: n }
      }
      return { ...l, park1, park2, unitIn }
    } finally { c.release() }
  }

  /** A resident on an active lease at `unitId`, holding `email`. */
  async function resident(landlordId: string, unitId: string, email: string) {
    const c = await db.connect()
    try {
      const tenantId = await seedTenant(c, { email })
      const leaseId = await seedLease(c, { unitId, landlordId })
      await seedLeaseTenant(c, { leaseId, tenantId })
      return tenantId
    } finally { c.release() }
  }

  /** A front-desk worker scoped to `propertyIds`, with the permission this endpoint needs. */
  async function staff(landlordId: string, propertyIds: string[]) {
    const { rows: [u] } = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1,'x','onsite_manager','Front','Desk',TRUE) RETURNING id`, [`desk-${randomUUID()}@t.dev`])
    await db.query(
      `INSERT INTO onsite_manager_scopes (user_id, landlord_id, property_ids, all_properties, permissions)
       VALUES ($1,$2,$3,FALSE,$4)`,
      [u.id, landlordId, propertyIds, JSON.stringify({ 'tenants.create': true })])
    return sign({ userId: u.id, role: 'onsite_manager', email: 'desk@t.dev', profileId: null,
                  landlordId, permissions: { 'tenants.create': true } })
  }

  const askWith = (token: string) => request(buildApp())
    .get('/api/landlords/me/undelivered-email').set('Authorization', `Bearer ${token}`)

  it('park-2 staff see a bounced park-2 resident, not a park-1 one; the owner sees both', async () => {
    const co = await company()
    const u1 = await co.unitIn(co.park1)
    const u2 = await co.unitIn(co.park2)
    await resident(co.landlordId, u1.id, 'park1-resident@icloud.com')
    await resident(co.landlordId, u2.id, 'park2-resident@icloud.com')
    await logEmail(co.landlordId, 'park1-resident@icloud.com', { event: 'bounced', at: '2026-09-09T12:00:00Z' })
    await logEmail(co.landlordId, 'park2-resident@icloud.com', { event: 'bounced', at: '2026-09-10T12:00:00Z' })

    const desk = await askWith(await staff(co.landlordId, [co.park2]))
    expect(desk.status, JSON.stringify(desk.body)).toBe(200)
    expect(desk.body.data.map((r: any) => r.email)).toEqual(['park2-resident@icloud.com'])
    expect(desk.body.data[0].unitNumber).toBe(u2.number)

    const owner = await ask(co.userId, co.landlordId)
    expect(owner.body.data.map((r: any) => r.email).sort())
      .toEqual(['park1-resident@icloud.com', 'park2-resident@icloud.com'])
  })

  it('an open invitation to a park-2 site counts as a place at park 2, and only there', async () => {
    const co = await company()
    const u1 = await co.unitIn(co.park1)
    const u2 = await co.unitIn(co.park2)
    const c = await db.connect()
    try {
      const invited2 = await seedTenant(c, { email: 'invited-park2@icloud.com' })
      const invited1 = await seedTenant(c, { email: 'invited-park1@icloud.com' })
      await c.query(`INSERT INTO pending_tenant_intents (landlord_id, tenant_id, unit_id, property_id) VALUES ($1,$2,$3,$4)`,
        [co.landlordId, invited2, u2.id, co.park2])
      await c.query(`INSERT INTO pending_tenant_intents (landlord_id, tenant_id, unit_id, property_id) VALUES ($1,$2,$3,$4)`,
        [co.landlordId, invited1, u1.id, co.park1])
    } finally { c.release() }
    await logEmail(co.landlordId, 'invited-park2@icloud.com', { event: 'bounced', at: '2026-09-09T12:00:00Z' })
    await logEmail(co.landlordId, 'invited-park1@icloud.com', { event: 'bounced', at: '2026-09-09T12:00:00Z' })

    const desk = await askWith(await staff(co.landlordId, [co.park2]))
    expect(desk.body.data.map((r: any) => r.email)).toEqual(['invited-park2@icloud.com'])
    expect(desk.body.data[0].invitedUnitNumber).toBe(u2.number)
    expect(desk.body.data[0].unitNumber).toBeNull()
  })

  it('scoped staff never see a row with no resident behind it; staff with no properties see nothing', async () => {
    const co = await company()
    const u2 = await co.unitIn(co.park2)
    await resident(co.landlordId, u2.id, 'park2-resident@icloud.com')
    // An account with no tenancy anywhere (e.g. a team member's address).
    await seedUser('no-tenancy@icloud.com')
    await logEmail(co.landlordId, 'no-tenancy@icloud.com', { event: 'bounced', at: '2026-09-09T12:00:00Z' })
    await logEmail(co.landlordId, 'park2-resident@icloud.com', { event: 'bounced', at: '2026-09-09T12:00:00Z' })

    const desk = await askWith(await staff(co.landlordId, [co.park2]))
    expect(desk.body.data.map((r: any) => r.email)).toEqual(['park2-resident@icloud.com'])

    const nowhere = await askWith(await staff(co.landlordId, []))
    expect(nowhere.status).toBe(200)
    expect(nowhere.body.data).toEqual([])

    const owner = await ask(co.userId, co.landlordId)
    expect(owner.body.data.map((r: any) => r.email).sort()).toEqual(['no-tenancy@icloud.com', 'park2-resident@icloud.com'])
  })

  it('staff with every property see what the owner sees', async () => {
    const co = await company()
    const u1 = await co.unitIn(co.park1)
    await resident(co.landlordId, u1.id, 'park1-resident@icloud.com')
    await logEmail(co.landlordId, 'park1-resident@icloud.com', { event: 'bounced', at: '2026-09-09T12:00:00Z' })
    const { rows: [u] } = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1,'x','property_manager','All','Parks',TRUE) RETURNING id`, [`pm-${randomUUID()}@t.dev`])
    await db.query(
      `INSERT INTO property_manager_scopes (user_id, landlord_id, all_properties, permissions)
       VALUES ($1,$2,TRUE,$3)`, [u.id, co.landlordId, JSON.stringify({ 'tenants.create': true })])
    const res = await askWith(sign({ userId: u.id, role: 'property_manager', email: 'pm@t.dev', profileId: null,
                                     landlordId: co.landlordId, permissions: { 'tenants.create': true } }))
    expect(res.body.data.map((r: any) => r.email)).toEqual(['park1-resident@icloud.com'])
  })

  it('a person who rents from another company shows no unit number from it', async () => {
    const mine = await company()
    const theirs = await company()
    const theirUnit = await theirs.unitIn(theirs.park1)
    const tenantId = await resident(theirs.landlordId, theirUnit.id, 'rents-elsewhere@icloud.com')
    // ...and has an open invitation there too.
    const theirOther = await theirs.unitIn(theirs.park2)
    await db.query(`INSERT INTO pending_tenant_intents (landlord_id, tenant_id, unit_id, property_id) VALUES ($1,$2,$3,$4)`,
      [theirs.landlordId, tenantId, theirOther.id, theirs.park2])
    // We emailed them once (an old application, say) and it bounced.
    await logEmail(mine.landlordId, 'rents-elsewhere@icloud.com', { event: 'bounced', at: '2026-09-09T12:00:00Z' })

    const res = await ask(mine.userId, mine.landlordId)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].unitNumber).toBeNull()
    expect(res.body.data[0].invitedUnitNumber).toBeNull()
  })

  it('never carries the subject or category of any message, including another company’s', async () => {
    const mine = await company()
    const theirs = await company()
    await seedUser('shared-address@icloud.com')
    await logEmail(mine.landlordId, 'shared-address@icloud.com', { event: 'bounced', at: '2026-09-01T12:00:00Z', subject: 'Our invite' })
    // The address's latest verdict is the other company's message.
    await logEmail(theirs.landlordId, 'shared-address@icloud.com', {
      event: 'bounced', at: '2026-09-20T12:00:00Z', subject: 'Eviction notice for Unit 12' })

    const res = await ask(mine.userId, mine.landlordId)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].outcome).toBe('bounced')
    expect(res.body.data[0]).not.toHaveProperty('subject')
    expect(res.body.data[0]).not.toHaveProperty('category')
    expect(JSON.stringify(res.body)).not.toMatch(/Eviction|Our invite|tenant_invite/)
  })
})

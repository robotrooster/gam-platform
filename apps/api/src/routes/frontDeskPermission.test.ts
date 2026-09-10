/**
 * S640 (Nic) — the front-desk role is grantable without over-granting.
 *
 *   "I want her to see the front desk tab for all the to-do list... she needs to
 *    be able to record payments for people that come in to pay with cash. She
 *    needs to be able to see the outstanding balances to tell people what they
 *    owe... I do not want to allow her to issue credit at this time or import
 *    payment history."
 *
 * Two things stood in the way. The Front Desk list asked for `tenants.create`
 * to READ it, so a desk person had to be handed the power to create tenancies;
 * and `take_payment` — the key that gates recording a cash payment, the whole
 * job — had never been listed in the permission catalog, so it could not be
 * switched on for anybody at all.
 *
 * The rule Nic set for this role: "the less things that it's possible for
 * somebody to screw up, the bigger your talent pool is."
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { PERMISSION_CATALOG } from '@gam/shared'
import { getClient } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty } from '../test/dbHelpers'
import { landlordsRouter } from './landlords'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/landlords', landlordsRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_frontdesk'
})

const catalogKeys = () =>
  PERMISSION_CATALOG.flatMap(g => g.sections.flatMap(s => s.items.map(i => i.key)))

async function seedDesk(perms: Record<string, boolean>) {
  const c = await getClient()
  try {
    await c.query('BEGIN')
    const { userId: ownerId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: ownerId, managedByUserId: ownerId })
    const u = await c.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ('desk-' || gen_random_uuid() || '@t.dev','x','onsite_manager','Front','Desk',TRUE) RETURNING id`)
    await c.query('COMMIT')
    const token = jwt.sign(
      { userId: u.rows[0].id, role: 'onsite_manager', email: 'desk@t.dev',
        landlordId, landlordIds: [landlordId], permissions: perms },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { token, landlordId, propertyId }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

describe('S640 front-desk permissions', () => {
  it('lists take_payment in the catalog — otherwise the job cannot be granted', () => {
    expect(catalogKeys()).toContain('take_payment')
  })

  it('keeps import_history a separate key, so "record cash" does not imply it', () => {
    const keys = catalogKeys()
    expect(keys).toContain('payments.import_history')
    expect(keys.filter(k => k === 'take_payment')).toHaveLength(1)
  })

  it('gives the Front Desk list its own key, apart from tenant onboarding', () => {
    const keys = catalogKeys()
    expect(keys).toContain('front_desk.view')
    const group = PERMISSION_CATALOG.find(g => g.category === 'front_desk')
    expect(group).toBeTruthy()
    // Exactly one key: this role is meant to be one switch, not a panel.
    expect(group!.sections.flatMap(s => s.items)).toHaveLength(1)
  })

  it('reads the to-do list with front_desk.view alone — no tenants.create needed', async () => {
    const f = await seedDesk({ 'front_desk.view': true })
    const res = await request(buildApp())
      .get('/api/landlords/me/pending-tenants').set('Authorization', `Bearer ${f.token}`)
    expect(res.status).toBe(200)
  })

  it('still refuses somebody holding neither key', async () => {
    const f = await seedDesk({ 'balances.view': true })
    const res = await request(buildApp())
      .get('/api/landlords/me/pending-tenants').set('Authorization', `Bearer ${f.token}`)
    expect(res.status).toBe(403)
  })

  // Re-sending is the one thing the desk can DO. Retyping somebody's address
  // from a spoken sentence is how an invite reaches a stranger — that stays
  // with whoever can create a tenancy.
  it('refuses a contact EDIT from the desk role', async () => {
    const f = await seedDesk({ 'front_desk.view': true })
    const res = await request(buildApp())
      .patch('/api/landlords/me/pending-intents/00000000-0000-0000-0000-000000000001/contact')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ email: 'somewhere-else@example.com' })
    expect(res.status).toBe(403)
    expect(String(res.body.error)).toMatch(/front-desk/i)
  })

  // A resend gets past the role gate and fails on the invite not existing,
  // which is the 404 we want to see rather than a 403.
  it('lets the desk role attempt a resend', async () => {
    const f = await seedDesk({ 'front_desk.view': true })
    const res = await request(buildApp())
      .patch('/api/landlords/me/pending-intents/00000000-0000-0000-0000-000000000001/contact')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ resend: true })
    expect(res.status).toBe(404)
  })
})

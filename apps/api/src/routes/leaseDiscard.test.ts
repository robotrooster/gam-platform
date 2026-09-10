/**
 * S640 (Nic) — an unsigned draft lease needs a way out.
 *
 *   "The one lease in review, that's the one that was supposed to delete when I
 *    deleted it from the master schedule. So why is that still there? There's
 *    no way to delete it either. So it's just useless filler... just delete it
 *    for now."
 *
 * That one survived because the reservation was cancelled hours before the code
 * that takes the draft with it went live. The real problem is that there was no
 * way out: a draft nobody can execute or complete sat on the dashboard as a
 * permanent action item whose only button opened a PDF that does not exist.
 *
 * Discard is a SOFT close — the row stays, marked terminated — and it stops at
 * paperwork nobody has signed.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db, getClient } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit } from '../test/dbHelpers'
import { leasesRouter } from './leases'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/leases', leasesRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_discard'
})

async function seedDraft(status: string) {
  const c = await getClient()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const unitId = await seedUnit(c, { propertyId, landlordId, rentAmount: 589 })
    const l = await c.query<{ id: string }>(
      `INSERT INTO leases (unit_id, landlord_id, rent_amount, lease_type, status, start_date,
                           needs_review, lease_source)
       VALUES ($1,$2,589,'month_to_month',$3, CURRENT_DATE, TRUE, 'booking_draft') RETURNING id`,
      [unitId, landlordId, status])
    await c.query('COMMIT')
    const token = jwt.sign(
      { userId, role: 'landlord', email: 'll@t.dev', landlordIds: [landlordId], profileId: landlordId, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { token, leaseId: l.rows[0].id, landlordId, unitId }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

const discard = (leaseId: string, token: string) => request(buildApp())
  .post(`/api/leases/${leaseId}/discard`).set('Authorization', `Bearer ${token}`).send({})

describe('POST /api/leases/:id/discard', () => {
  it('closes an unsigned pending draft and clears it off the review list', async () => {
    const f = await seedDraft('pending')
    const res = await discard(f.leaseId, f.token)
    expect(res.status).toBe(200)
    const l = (await db.query<any>('SELECT status, needs_review FROM leases WHERE id=$1', [f.leaseId])).rows[0]
    expect(l.status).toBe('terminated')
    expect(l.needs_review).toBe(false)
  })

  // GAM keeps everything — a discard hides the draft, it does not erase it.
  it('keeps the row', async () => {
    const f = await seedDraft('pending')
    await discard(f.leaseId, f.token)
    const n = await db.query<any>('SELECT COUNT(*)::int AS c FROM leases WHERE id=$1', [f.leaseId])
    expect(n.rows[0].c).toBe(1)
  })

  it('refuses an ACTIVE lease — no button on a list page ends a tenancy', async () => {
    const f = await seedDraft('active')
    const res = await discard(f.leaseId, f.token)
    expect(res.status).toBe(400)
    const l = (await db.query<any>('SELECT status FROM leases WHERE id=$1', [f.leaseId])).rows[0]
    expect(l.status).toBe('active')
  })

  it('refuses a draft somebody has already signed — that is a void, and it notifies', async () => {
    const f = await seedDraft('pending')
    const d = await db.query<{ id: string }>(
      `INSERT INTO lease_documents (lease_id, landlord_id, title, status)
       VALUES ($1,$2,'Lease','sent') RETURNING id`, [f.leaseId, f.landlordId])
    const su = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ('signer-' || gen_random_uuid() || '@t.dev','x','tenant','Some','One',TRUE) RETURNING id`)
    await db.query(
      `INSERT INTO lease_document_signers (document_id, user_id, name, email, role, token, signed_at)
       VALUES ($1,$2,'Someone','someone@t.dev','tenant', gen_random_uuid()::text, NOW())`,
      [d.rows[0].id, su.rows[0].id])
    const res = await discard(f.leaseId, f.token)
    expect(res.status).toBe(400)
  })

  it('refuses another account’s draft', async () => {
    const mine   = await seedDraft('pending')
    const theirs = await seedDraft('pending')
    const res = await discard(theirs.leaseId, mine.token)
    expect(res.status).toBe(403)
  })
})

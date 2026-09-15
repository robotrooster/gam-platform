/**
 * S644 — the owner layer's routes.
 *
 * A manager onboarding 11,000 units has many owners, and the thing that must
 * never happen is one of them reading another's money. So most of this file is
 * about who is refused. The rest holds the one rule Nic stated as a directive:
 * a manager can let an owner in and cannot keep them out.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db, getClient } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedUserBankAccount,
} from '../test/dbHelpers'
import { pmRouter } from './pm'
import { errorHandler } from '../middleware/errorHandler'

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_pm_owners'
})

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/pm', pmRouter)
  app.use(errorHandler)
  return app
}

function tokenFor(userId: string, role: string, extra: Record<string, any> = {}) {
  return jwt.sign(
    { userId, role, email: `${userId}@t.dev`, profileId: userId, permissions: {}, ...extra },
    process.env.JWT_SECRET!, { expiresIn: '1h' })
}

async function pmStaffUser() {
  const email = `pm-${randomUUID()}@test.dev`
  const r = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1,'x','property_manager','Test','Mgr',TRUE) RETURNING id`, [email])
  const userId = r.rows[0].id
  return { userId, token: tokenFor(userId, 'property_manager') }
}

/** A manager company, an owner, and a park of theirs it runs. */
async function managedOwner(pmCompanyId?: string) {
  const client = await getClient()
  try {
    const { userId, landlordId } = await seedLandlord(client)
    const bankId = await seedUserBankAccount(client, { userId })
    let pmId = pmCompanyId
    if (!pmId) {
      const c = await client.query<{ id: string }>(
        `INSERT INTO pm_companies (name, bank_account_id) VALUES ($1,$2) RETURNING id`,
        [`PM ${randomUUID().slice(0, 6)}`, bankId])
      pmId = c.rows[0].id
    }
    const propertyId = await seedProperty(client, {
      landlordId, ownerUserId: userId, managedByUserId: userId })
    await client.query(`UPDATE properties SET pm_company_id=$2 WHERE id=$1`, [propertyId, pmId])
    await seedUnit(client, { propertyId, landlordId, rentAmount: 1000 })
    return {
      landlordId, userId, propertyId, pmCompanyId: pmId!,
      ownerToken: tokenFor(userId, 'landlord', { landlordIds: [landlordId] }),
    }
  } finally { client.release() }
}

async function makeStaff(pmCompanyId: string, userId: string, role = 'owner') {
  await db.query(
    `INSERT INTO pm_staff (pm_company_id, user_id, role, status)
     VALUES ($1,$2,$3,'active')`, [pmCompanyId, userId, role])
}

describe('the manager\'s owner list', () => {
  it('shows the owners it manages, with unit counts', async () => {
    const o = await managedOwner()
    const staff = await pmStaffUser()
    await makeStaff(o.pmCompanyId, staff.userId)

    const res = await request(buildApp())
      .get(`/api/pm/companies/${o.pmCompanyId}/owners`)
      .set('Authorization', `Bearer ${staff.token}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].landlordId).toBe(o.landlordId)
    expect(res.body.data[0].payoutMode).toBe('direct')
    expect(res.body.data[0].portalAccess).toBe('none')
    expect(res.body.data[0].unitCount).toBe(1)
  })

  it('refuses somebody who is not staff of that company', async () => {
    const o = await managedOwner()
    const stranger = await pmStaffUser()
    const res = await request(buildApp())
      .get(`/api/pm/companies/${o.pmCompanyId}/owners`)
      .set('Authorization', `Bearer ${stranger.token}`)
    expect(res.status).toBe(403)
  })
})

describe('reaching for an owner the company does not manage', () => {
  it('404s on the statement rather than returning their money', async () => {
    const mine = await managedOwner()
    const theirs = await managedOwner()          // a different company entirely
    const staff = await pmStaffUser()
    await makeStaff(mine.pmCompanyId, staff.userId)

    const res = await request(buildApp())
      .get(`/api/pm/companies/${mine.pmCompanyId}/owners/${theirs.landlordId}/statement`)
      .set('Authorization', `Bearer ${staff.token}`)
    expect(res.status).toBe(404)
    expect(JSON.stringify(res.body)).not.toContain(theirs.propertyId)
  })

  it('404s on changing their terms', async () => {
    const mine = await managedOwner()
    const theirs = await managedOwner()
    const staff = await pmStaffUser()
    await makeStaff(mine.pmCompanyId, staff.userId)

    const res = await request(buildApp())
      .patch(`/api/pm/companies/${mine.pmCompanyId}/owners/${theirs.landlordId}`)
      .set('Authorization', `Bearer ${staff.token}`)
      .send({ payoutMode: 'pm_trust' })
    expect(res.status).toBe(404)
    const row = await db.query(
      `SELECT payout_mode FROM pm_owner_relationships WHERE landlord_id=$1`,
      [theirs.landlordId])
    expect(row.rows[0].payout_mode).toBe('direct')
  })
})

describe('how an owner gets paid', () => {
  it('a manager can put one owner on a disbursement run without touching the rest', async () => {
    const a = await managedOwner()
    const b = await managedOwner(a.pmCompanyId)
    const staff = await pmStaffUser()
    await makeStaff(a.pmCompanyId, staff.userId)

    const res = await request(buildApp())
      .patch(`/api/pm/companies/${a.pmCompanyId}/owners/${a.landlordId}`)
      .set('Authorization', `Bearer ${staff.token}`)
      .send({ payoutMode: 'pm_trust', disbursementDay: 12 })
    expect(res.status).toBe(200)
    expect(res.body.data.payoutMode).toBe('pm_trust')
    expect(res.body.data.disbursementDay).toBe(12)

    const other = await db.query(
      `SELECT payout_mode FROM pm_owner_relationships WHERE landlord_id=$1`, [b.landlordId])
    expect(other.rows[0].payout_mode).toBe('direct')
  })

  it('refuses a disbursement day that does not exist in February', async () => {
    const o = await managedOwner()
    const staff = await pmStaffUser()
    await makeStaff(o.pmCompanyId, staff.userId)
    const res = await request(buildApp())
      .patch(`/api/pm/companies/${o.pmCompanyId}/owners/${o.landlordId}`)
      .set('Authorization', `Bearer ${staff.token}`)
      .send({ disbursementDay: 31 })
    expect(res.status).toBe(400)
  })

  it('a staff member cannot change the money terms — owner or manager only', async () => {
    const o = await managedOwner()
    const staff = await pmStaffUser()
    await makeStaff(o.pmCompanyId, staff.userId, 'staff')
    const res = await request(buildApp())
      .patch(`/api/pm/companies/${o.pmCompanyId}/owners/${o.landlordId}`)
      .set('Authorization', `Bearer ${staff.token}`)
      .send({ payoutMode: 'pm_trust' })
    expect(res.status).toBe(403)
  })
})

// Nic (S644, DIRECTIVE): "Owner can access if they want. Request portal access
// through PM, but PM can't deny an owner."
describe('portal access', () => {
  it('a manager can let an owner in', async () => {
    const o = await managedOwner()
    const staff = await pmStaffUser()
    await makeStaff(o.pmCompanyId, staff.userId)

    const res = await request(buildApp())
      .post(`/api/pm/companies/${o.pmCompanyId}/owners/${o.landlordId}/portal`)
      .set('Authorization', `Bearer ${staff.token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.portalAccess).toBe('active')
  })

  it('has no route for a manager to deny or revoke it', async () => {
    const o = await managedOwner()
    const staff = await pmStaffUser()
    await makeStaff(o.pmCompanyId, staff.userId)
    await request(buildApp())
      .post(`/api/pm/companies/${o.pmCompanyId}/owners/${o.landlordId}/portal`)
      .set('Authorization', `Bearer ${staff.token}`)

    // The obvious shapes a future hand might reach for. None of them exist, and
    // the PATCH that does exist refuses portalAccess as an unknown field — the
    // body schema is strict precisely so this stays true.
    const del = await request(buildApp())
      .delete(`/api/pm/companies/${o.pmCompanyId}/owners/${o.landlordId}/portal`)
      .set('Authorization', `Bearer ${staff.token}`)
    expect(del.status).toBe(404)

    const patched = await request(buildApp())
      .patch(`/api/pm/companies/${o.pmCompanyId}/owners/${o.landlordId}`)
      .set('Authorization', `Bearer ${staff.token}`)
      .send({ portalAccess: 'closed' })
    expect(patched.status).toBe(400)

    const still = await db.query(
      `SELECT portal_access FROM pm_owner_relationships WHERE landlord_id=$1`,
      [o.landlordId])
    expect(still.rows[0].portal_access).toBe('active')
  })

  it('the owner can close it themselves', async () => {
    const o = await managedOwner()
    const staff = await pmStaffUser()
    await makeStaff(o.pmCompanyId, staff.userId)
    await request(buildApp())
      .post(`/api/pm/companies/${o.pmCompanyId}/owners/${o.landlordId}/portal`)
      .set('Authorization', `Bearer ${staff.token}`)

    const res = await request(buildApp())
      .delete(`/api/pm/my-portal/${o.pmCompanyId}`)
      .set('Authorization', `Bearer ${o.ownerToken}`)
    expect(res.status).toBe(200)
    const row = await db.query(
      `SELECT portal_access FROM pm_owner_relationships WHERE landlord_id=$1`,
      [o.landlordId])
    expect(row.rows[0].portal_access).toBe('closed')
  })

  it('one owner cannot close another owner\'s portal', async () => {
    const a = await managedOwner()
    const b = await managedOwner(a.pmCompanyId)
    const staff = await pmStaffUser()
    await makeStaff(a.pmCompanyId, staff.userId)
    await request(buildApp())
      .post(`/api/pm/companies/${a.pmCompanyId}/owners/${b.landlordId}/portal`)
      .set('Authorization', `Bearer ${staff.token}`)

    // A has no open portal with this company, so their call finds nothing to
    // close — and must not reach B's.
    const res = await request(buildApp())
      .delete(`/api/pm/my-portal/${a.pmCompanyId}`)
      .set('Authorization', `Bearer ${a.ownerToken}`)
    expect(res.status).toBe(404)
    const row = await db.query(
      `SELECT portal_access FROM pm_owner_relationships WHERE landlord_id=$1`,
      [b.landlordId])
    expect(row.rows[0].portal_access).toBe('active')
  })
})

describe('what an owner reads for themselves', () => {
  it('nothing at all until somebody opened the portal', async () => {
    const o = await managedOwner()
    const res = await request(buildApp())
      .get('/api/pm/my-statements')
      .set('Authorization', `Bearer ${o.ownerToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(0)
  })

  it('their own statement once it is open', async () => {
    const o = await managedOwner()
    const staff = await pmStaffUser()
    await makeStaff(o.pmCompanyId, staff.userId)
    await request(buildApp())
      .post(`/api/pm/companies/${o.pmCompanyId}/owners/${o.landlordId}/portal`)
      .set('Authorization', `Bearer ${staff.token}`)

    const res = await request(buildApp())
      .get('/api/pm/my-statements?month=2026-08')
      .set('Authorization', `Bearer ${o.ownerToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].statement.landlordId).toBe(o.landlordId)
    expect(res.body.data[0].statement.periodMonth).toBe('2026-08-01')
  })

  it('refuses an entity the account does not own', async () => {
    const mine = await managedOwner()
    const theirs = await managedOwner()
    const res = await request(buildApp())
      .get(`/api/pm/my-statements?landlordId=${theirs.landlordId}`)
      .set('Authorization', `Bearer ${mine.ownerToken}`)
    expect(res.status).toBe(403)
  })

  it('gives a manager\'s own staff session nothing from the owner routes', async () => {
    const o = await managedOwner()
    const staff = await pmStaffUser()
    await makeStaff(o.pmCompanyId, staff.userId)
    const res = await request(buildApp())
      .get('/api/pm/my-statements')
      .set('Authorization', `Bearer ${staff.token}`)
    expect(res.status).toBe(403)
  })
})

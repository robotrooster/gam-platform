/**
 * S641 — the signing-package routes, and the two things a package must never do:
 * reach for somebody else's template, or pin to somebody else's property.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit } from '../test/dbHelpers'
import { signingPackagesRouter } from './signingPackages'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/signing-packages', signingPackagesRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_packages'
})

async function seed() {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const a = await seedLandlord(c)
    const b = await seedLandlord(c)
    const propA1 = await seedProperty(c, { landlordId: a.landlordId, ownerUserId: a.userId, managedByUserId: a.userId })
    const propA2 = await seedProperty(c, { landlordId: a.landlordId, ownerUserId: a.userId, managedByUserId: a.userId })
    const propB  = await seedProperty(c, { landlordId: b.landlordId, ownerUserId: b.userId, managedByUserId: b.userId })
    const unitA = await seedUnit(c, { propertyId: propA1, landlordId: a.landlordId })
    await c.query(`UPDATE units SET unit_type='mobile_home' WHERE id=$1`, [unitA])
    const tplA = await c.query<{ id: string }>(
      `INSERT INTO lease_templates (landlord_id, name, purpose) VALUES ($1,'A Lease','lease') RETURNING id`, [a.landlordId])
    const tplB = await c.query<{ id: string }>(
      `INSERT INTO lease_templates (landlord_id, name, purpose) VALUES ($1,'B Lease','lease') RETURNING id`, [b.landlordId])
    await c.query('COMMIT')

    const sign = (uid: string, lid: string) => jwt.sign(
      { userId: uid, role: 'landlord', email: 'l@t.dev', profileId: lid, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    return {
      a, b, propA1, propA2, propB, unitA,
      tplA: tplA.rows[0].id, tplB: tplB.rows[0].id,
      tokenA: sign(a.userId, a.landlordId), tokenB: sign(b.userId, b.landlordId),
    }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

describe('packages', () => {
  it('creates one with its items and reads it back in order', async () => {
    const f = await seed()
    const create = await request(buildApp())
      .post('/api/signing-packages').set('Authorization', `Bearer ${f.tokenA}`)
      .send({ name: 'AZ Park-Owned Homes', unitType: 'mobile_home', isDefault: true,
              items: [{ templateId: f.tplA, renewalBehavior: 'with_lease', required: true }] })
    expect(create.status).toBe(201)

    const list = await request(buildApp())
      .get('/api/signing-packages').set('Authorization', `Bearer ${f.tokenA}`)
    expect(list.status).toBe(200)
    expect(list.body.data).toHaveLength(1)
    expect(list.body.data[0].items[0].templateName).toBe('A Lease')
    expect(list.body.data[0].items[0].required).toBe(true)
  })

  it('refuses to build a package out of somebody else\'s template', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .post('/api/signing-packages').set('Authorization', `Bearer ${f.tokenA}`)
      .send({ name: 'Sneaky', items: [{ templateId: f.tplB }] })
    expect(res.status).toBe(403)
  })

  it('another landlord cannot see it', async () => {
    const f = await seed()
    await request(buildApp()).post('/api/signing-packages')
      .set('Authorization', `Bearer ${f.tokenA}`).send({ name: 'Mine' })
    const res = await request(buildApp())
      .get('/api/signing-packages').set('Authorization', `Bearer ${f.tokenB}`)
    expect(res.body.data).toHaveLength(0)
  })

  it('deleting archives rather than erasing', async () => {
    const f = await seed()
    const c = await request(buildApp()).post('/api/signing-packages')
      .set('Authorization', `Bearer ${f.tokenA}`).send({ name: 'Old' })
    await request(buildApp()).delete(`/api/signing-packages/${c.body.data.id}`)
      .set('Authorization', `Bearer ${f.tokenA}`).expect(200)

    const { rows } = await db.query(`SELECT archived_at FROM document_packages WHERE id=$1`, [c.body.data.id])
    expect(rows).toHaveLength(1)
    expect(rows[0].archived_at).not.toBeNull()
  })
})

describe('pinning a template to properties', () => {
  it('pins to two and leaves the third alone', async () => {
    const f = await seed()
    await request(buildApp())
      .put(`/api/signing-packages/templates/${f.tplA}/properties`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ propertyIds: [f.propA1, f.propA2] }).expect(200)

    const res = await request(buildApp())
      .get(`/api/signing-packages/templates/${f.tplA}/properties`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.body.data.sort()).toEqual([f.propA1, f.propA2].sort())
  })

  it('an empty list unpins back to available everywhere', async () => {
    const f = await seed()
    const app = buildApp()
    await request(app).put(`/api/signing-packages/templates/${f.tplA}/properties`)
      .set('Authorization', `Bearer ${f.tokenA}`).send({ propertyIds: [f.propA1] }).expect(200)
    await request(app).put(`/api/signing-packages/templates/${f.tplA}/properties`)
      .set('Authorization', `Bearer ${f.tokenA}`).send({ propertyIds: [] }).expect(200)

    const res = await request(app).get(`/api/signing-packages/templates/${f.tplA}/properties`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.body.data).toEqual([])
  })

  it('cannot pin to a property belonging to somebody else', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .put(`/api/signing-packages/templates/${f.tplA}/properties`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ propertyIds: [f.propB] })
    expect(res.status).toBe(403)
  })

  it('cannot pin somebody else\'s template', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .put(`/api/signing-packages/templates/${f.tplB}/properties`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ propertyIds: [f.propA1] })
    expect(res.status).toBe(404)
  })
})

describe('the draft checklist for a unit', () => {
  it('returns the default package with items pre-ticked', async () => {
    const f = await seed()
    await request(buildApp()).post('/api/signing-packages')
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ name: 'AZ Homes', unitType: 'mobile_home', isDefault: true,
              items: [{ templateId: f.tplA }] }).expect(201)

    const res = await request(buildApp())
      .get(`/api/signing-packages/for-unit/${f.unitA}`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.data.name).toBe('AZ Homes')
    expect(res.body.data.items[0].suggested).toBe(true)
  })

  it('another landlord cannot ask about this unit', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .get(`/api/signing-packages/for-unit/${f.unitA}`)
      .set('Authorization', `Bearer ${f.tokenB}`)
    expect(res.status).toBe(404)
  })
})

// ── the assembled bundle ────────────────────────────────────────────────────
import { esignRouter } from './esign'
import { packageSiblings } from '../services/signingPackages'
import { randomUUID } from 'crypto'

function buildEsignApp() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/esign', esignRouter)
  app.use(errorHandler)
  return app
}

async function seedSignableUnit() {
  const f = await seed()
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    // a second template for the package
    const rules = await c.query<{ id: string }>(
      `INSERT INTO lease_templates (landlord_id, name, purpose) VALUES ($1,'Park Rules','park_rules') RETURNING id`,
      [f.a.landlordId])
    const inst = await c.query<{ id: string }>(
      `INSERT INTO lease_templates (landlord_id, name, purpose) VALUES ($1,'Installment Sale','installment_sale') RETURNING id`,
      [f.a.landlordId])
    // a tenant who can sign
    const tu = await c.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1,'x','tenant','Test','Tenant',TRUE) RETURNING id`, [`t-${randomUUID()}@test.dev`])
    const ten = await c.query<{ id: string }>(
      `INSERT INTO tenants (user_id) VALUES ($1) RETURNING id`, [tu.rows[0].id])
    // S652: a buyer must have some standing with the landlord before they can
    // be sold a home on installments — a lease, an open invite, or a utility
    // agreement. A brand-new tenancy reaches GAM through the invite, which is
    // exactly the case Nic asked to make work.
    await c.query(
      `INSERT INTO pending_tenant_intents (landlord_id, unit_id, tenant_id)
       VALUES ($1,$2,$3)`, [f.a.landlordId, f.unitA, ten.rows[0].id])
    await c.query(`UPDATE units SET dwelling_ownership='landlord' WHERE id=$1`, [f.unitA])
    await c.query('COMMIT')
    return { ...f, rules: rules.rows[0].id, inst: inst.rows[0].id,
             tenantUserId: tu.rows[0].id, tenantId: ten.rows[0].id }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

describe('drafting a package as one bundle', () => {
  it('creates every ticked document in one group, the lease first', async () => {
    const f = await seedSignableUnit()
    const res = await request(buildEsignApp())
      .post('/api/esign/documents').set('Authorization', `Bearer ${f.tokenA}`)
      .send({
        templateId: f.tplA, unitId: f.unitA, title: 'Mobile Home Lease',
        packageTemplateIds: [f.rules, f.inst],
        homeSale: { tenantId: f.tenantId, salePrice: 24000, downPayment: 2000,
                    annualInterestRate: 0, termMonths: 55, startMonth: '2026-11-01' },
        signers: [
          { userId: f.tenantUserId, role: 'primary', name: 'Test Tenant', email: 't@test.dev' },
          { userId: f.a.userId, role: 'landlord', name: 'Owner', email: 'l@t.dev' },
        ],
      })
    expect(res.status).toBe(201)
    expect(res.body.package).toHaveLength(2)

    const siblings = await packageSiblings(res.body.data.id)
    expect(siblings).toHaveLength(3)
    expect(siblings[0].title).toBe('Mobile Home Lease')
    expect(siblings[0].isSelf).toBe(true)
  })

  // An installment contract must stay a separate instrument. Nic: the current
  // Country Acres owner bundles lot rent and the trailer into one flat price,
  // "so you don't know what's getting paid to lot rent and what's getting paid
  // to the trailer."
  it('an installment sale is its own instrument, not an addendum', async () => {
    const f = await seedSignableUnit()
    const res = await request(buildEsignApp())
      .post('/api/esign/documents').set('Authorization', `Bearer ${f.tokenA}`)
      .send({
        templateId: f.tplA, unitId: f.unitA, title: 'Lot Lease',
        packageTemplateIds: [f.inst],
        homeSale: { tenantId: f.tenantId, salePrice: 24000, downPayment: 2000,
                    annualInterestRate: 0, termMonths: 55, startMonth: '2026-11-01' },
        signers: [
          { userId: f.tenantUserId, role: 'primary', name: 'Test Tenant', email: 't@test.dev' },
          { userId: f.a.userId, role: 'landlord', name: 'Owner', email: 'l@t.dev' },
        ],
      })
    expect(res.status).toBe(201)
    const { rows } = await db.query(
      `SELECT document_type FROM lease_documents WHERE id=$1`, [res.body.package[0].id])
    expect(rows[0].document_type).toBe('purchase_agreement')
  })

  /**
   * S652 — the trap this closes.
   *
   * Ticking an installment-sale template used to produce a perfectly signable
   * agreement with no home_sale_contracts row behind it. Signing it called
   * activateHomeSaleContract, which found nothing on that document and returned
   * quietly: signed by everybody, billing nobody, silent about it. That is how
   * Country Acres ended up with eleven contracts that had to be voided.
   */
  it('refuses an installment sale with no terms rather than billing nothing', async () => {
    const f = await seedSignableUnit()
    const res = await request(buildEsignApp())
      .post('/api/esign/documents').set('Authorization', `Bearer ${f.tokenA}`)
      .send({
        templateId: f.tplA, unitId: f.unitA, title: 'Lot Lease',
        packageTemplateIds: [f.inst],
        signers: [
          { userId: f.tenantUserId, role: 'primary', name: 'Test Tenant', email: 't@test.dev' },
          { userId: f.a.userId, role: 'landlord', name: 'Owner', email: 'l@t.dev' },
        ],
      })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/terms/i)
    // Nothing half-made: no lease document either, since it is one transaction.
    const { rows } = await db.query(`SELECT 1 FROM lease_documents`)
    expect(rows).toHaveLength(0)
  })

  it('creates the contract the agreement will activate, bound to that document', async () => {
    // Nic: one packet, two documents, two signatures — and it has to work on a
    // brand-new tenancy, where there is no lease to anchor to yet.
    const f = await seedSignableUnit()
    const res = await request(buildEsignApp())
      .post('/api/esign/documents').set('Authorization', `Bearer ${f.tokenA}`)
      .send({
        templateId: f.tplA, unitId: f.unitA, title: 'Lot Lease',
        packageTemplateIds: [f.inst],
        homeSale: { tenantId: f.tenantId, salePrice: 24000, downPayment: 2000,
                    annualInterestRate: 0, termMonths: 55, startMonth: '2026-11-01' },
        signers: [
          { userId: f.tenantUserId, role: 'primary', name: 'Test Tenant', email: 't@test.dev' },
          { userId: f.a.userId, role: 'landlord', name: 'Owner', email: 'l@t.dev' },
        ],
      })
    expect(res.status, JSON.stringify(res.body)).toBe(201)

    const { rows } = await db.query(
      `SELECT c.status, c.lease_id, c.financed_amount, c.purchase_document_id, d.document_type
         FROM home_sale_contracts c
         JOIN lease_documents d ON d.id = c.purchase_document_id`)
    expect(rows).toHaveLength(1)
    expect(rows[0].document_type).toBe('purchase_agreement')
    expect(rows[0].status).toBe('pending_signature')   // nothing bills until it is signed
    expect(Number(rows[0].financed_amount)).toBe(22000)
    expect(rows[0].lease_id).toBeNull()                // no lease yet — that is the point
  })

  it('refuses to finance an RV, whichever door you come through', async () => {
    // S613 directive: financed sales convert a park-owned HOME to tenant-owned.
    // The packet must not be a way around the rule the direct route enforces.
    const f = await seedSignableUnit()
    await db.query(`UPDATE units SET unit_type='rv_spot' WHERE id=$1`, [f.unitA])
    const res = await request(buildEsignApp())
      .post('/api/esign/documents').set('Authorization', `Bearer ${f.tokenA}`)
      .send({
        templateId: f.tplA, unitId: f.unitA, title: 'Lot Lease',
        packageTemplateIds: [f.inst],
        homeSale: { tenantId: f.tenantId, salePrice: 24000, downPayment: 2000,
                    annualInterestRate: 0, termMonths: 55, startMonth: '2026-11-01' },
        signers: [
          { userId: f.tenantUserId, role: 'primary', name: 'Test Tenant', email: 't@test.dev' },
          { userId: f.a.userId, role: 'landlord', name: 'Owner', email: 'l@t.dev' },
        ],
      })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/mobile homes/i)
  })

  it('refuses a package item belonging to another landlord', async () => {
    const f = await seedSignableUnit()
    const res = await request(buildEsignApp())
      .post('/api/esign/documents').set('Authorization', `Bearer ${f.tokenA}`)
      .send({
        templateId: f.tplA, unitId: f.unitA, title: 'Lease',
        packageTemplateIds: [f.tplB],
        signers: [
          { userId: f.tenantUserId, role: 'primary', name: 'Test Tenant', email: 't@test.dev' },
          { userId: f.a.userId, role: 'landlord', name: 'Owner', email: 'l@t.dev' },
        ],
      })
    expect(res.status).toBe(403)
    // and nothing was left half-built
    const { rows } = await db.query(`SELECT COUNT(*)::int AS n FROM lease_documents`)
    expect(rows[0].n).toBe(0)
  })

  it('no package ticked leaves an ordinary single-document draft', async () => {
    const f = await seedSignableUnit()
    const res = await request(buildEsignApp())
      .post('/api/esign/documents').set('Authorization', `Bearer ${f.tokenA}`)
      .send({
        templateId: f.tplA, unitId: f.unitA, title: 'Just A Lease',
        signers: [
          { userId: f.tenantUserId, role: 'primary', name: 'Test Tenant', email: 't@test.dev' },
          { userId: f.a.userId, role: 'landlord', name: 'Owner', email: 'l@t.dev' },
        ],
      })
    expect(res.status).toBe(201)
    expect(res.body.package).toEqual([])
    const { rows } = await db.query(
      `SELECT package_group_id FROM lease_documents WHERE id=$1`, [res.body.data.id])
    expect(rows[0].package_group_id).toBeNull()
  })
})

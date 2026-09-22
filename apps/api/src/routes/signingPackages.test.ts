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

  // S652 (Blu): the lease's done screen has to lead to the next document that
  // still needs THIS signer — otherwise a nine-document packet ends after one.
  it('siblings carry the signer\'s own status and token so the page can walk them', async () => {
    const f = await seedSignableUnit()
    const res = await request(buildEsignApp())
      .post('/api/esign/documents').set('Authorization', `Bearer ${f.tokenA}`)
      .send({
        templateId: f.tplA, unitId: f.unitA, title: 'Mobile Home Lease',
        packageTemplateIds: [f.rules, f.inst],
        homeSale: { tenantId: f.tenantId, salePrice: 24000, downPayment: 2000,
                    annualInterestRate: 0, termMonths: 55, startMonth: '2026-11-01' },
        signers: [
          { userId: f.a.userId, role: 'landlord', name: 'Landlord', email: 'l@x.dev' },
          { userId: f.tenantUserId, role: 'primary', name: 'Tenant', email: 't@x.dev' },
        ],
      })
    expect(res.status).toBe(201)
    const forLandlord = await packageSiblings(res.body.data.id, f.a.userId)
    expect(forLandlord).toHaveLength(3)
    for (const d of forLandlord) {
      expect(d.mine).not.toBeNull()
      expect(d.mine!.status).not.toBe('signed')
      expect(d.mine!.token).toBeTruthy()
    }
    const forNobody = await packageSiblings(res.body.data.id, randomUUID())
    expect(forNobody.every(d => d.mine === null)).toBe(true)
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

/**
 * S652 — the tenant fields that never reached thirteen leases.
 *
 * Blu Haws read the Country Acres leases and reported it from the far end:
 * "Tenant name(s) on page 1 didn't auto populate... page 5 didn't auto
 * populate... page 7 didn't auto populate... Area for a date on page 7 didn't
 * auto-populate or give the option to manually enter anything."
 *
 * draftHouseholdLease labelled every resident 'tenant'; lease templates bind
 * their fields to 'primary' and 'co_tenant_1..3'. Nothing matched, so every
 * tenant field was pruned as an unused role slot — 70 of 125 on those
 * documents — and they went out looking finished.
 *
 * The POST /documents route had always required exactly one 'primary'. The
 * household draft calls createDocumentRecord DIRECTLY and never met that check,
 * which is the whole reason this could happen at all.
 */
describe('S652: a household lease uses the roles its template binds to', () => {
  it('drafts residents as primary and co_tenant, and the tenant fields land', async () => {
    const f = await seedSignableUnit()
    // A default template for this unit type, with a tenant-bound field on it.
    await db.query(
      `UPDATE lease_templates SET base_pdf_url = '/x.pdf' WHERE id = $1`, [f.tplA])
    await db.query(
      `INSERT INTO lease_template_fields
         (template_id, field_type, signer_role, label, lease_column, page, x, y, width, height, required, sort_order)
       VALUES ($1,'text','primary','Tenant name','tenant_name',1,10,10,100,20,FALSE,1)`,
      [f.tplA])
    // Make it THE default for this unit type, which is how the draft finds it.
    const { rows: unitRows } = await db.query<any>(
      `SELECT unit_type FROM units WHERE id = $1`, [f.unitA])
    await db.query(
      `UPDATE lease_templates
          SET unit_type = $2, is_unit_type_default = TRUE, is_active = TRUE, property_id = NULL
        WHERE id = $1`, [f.tplA, unitRows[0].unit_type])

    const { draftHouseholdLease } = await import('../services/householdLeaseDraft')
    const res: any = await draftHouseholdLease({
      landlordId: f.a.landlordId, unitId: f.unitA,
      residents: [{ userId: f.tenantUserId, name: 'Test Tenant', email: 't@test.dev', phone: null }],
    })
    // No escape hatch: if this cannot draft, the test has stopped testing the
    // thing it is named after and must say so.
    expect(res.drafted, `did not draft: ${(res as any).reason}`).toBe(true)
    const { rows: signers } = await db.query<any>(
      `SELECT role FROM lease_document_signers WHERE document_id = $1 ORDER BY role`, [res.documentId])
    expect(signers.map((r: any) => r.role)).toContain('primary')
    expect(signers.map((r: any) => r.role)).not.toContain('tenant')

    const { rows: fields } = await db.query<any>(
      `SELECT lease_column FROM lease_document_fields
        WHERE document_id = $1 AND lease_column = 'tenant_name'`, [res.documentId])
    expect(fields.length).toBeGreaterThan(0)   // the field Blu could not see
  })

  it('refuses outright to build a document for a role no template knows', async () => {
    // The guard lives in createDocumentRecord, where the household draft enters
    // — not on the route, which was always protected and never the way in.
    const f = await seedSignableUnit()
    const { createDocumentRecord } = await import('./esign')
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      await expect(createDocumentRecord(client as any, {
        landlordId: f.a.landlordId, templateId: f.tplA, unitId: f.unitA,
        title: 'Lease', basePdfUrl: null, documentType: 'original_lease',
        targetLeaseTenantId: null, promoteLeaseTenantId: null,
        signers: [
          { userId: f.a.userId, role: 'landlord', name: 'Owner', email: 'l@t.dev', orderIndex: 1 },
          { userId: f.tenantUserId, role: 'tenant', name: 'Test Tenant', email: 't@test.dev', orderIndex: 2 },
        ],
      } as any)).rejects.toThrow(/primary \/ co_tenant/i)
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  })
})

/**
 * S652 — the right lead-paint disclosure in front of the right household.
 *
 * Nic: "the goal was to have the package set up so you needed to detect who was
 * on rent to own or already tenant owned homes and apply that to the thing, and
 * have the leases that are just not on rent to own as the leased lead based
 * paint disclosure. The whole reason we built the packages process was for this
 * property."
 *
 * Blu uploaded two — "Mattoon LBP - Lease" and "Mattoon LBP - Sale" — because
 * the federal disclosure differs between selling a home and renting one. What
 * decides which is the TRANSACTION, and the database already knows it: a live
 * home-sale contract means a sale, a tenant-owned dwelling means the landlord is
 * renting land, and everything else is renting a home out.
 */
describe('S652: the packet picks the disclosure that matches the transaction', () => {
  let transactionKindForUnit: any
  beforeEach(async () => {
    ({ transactionKindForUnit } = await import('../services/signingPackages'))
  })

  it('a home being bought on installments is a sale', async () => {
    const f = await seedSignableUnit()
    await db.query(
      `INSERT INTO home_sale_contracts
         (unit_id, tenant_id, landlord_id, sale_price, down_payment, financed_amount,
          annual_interest_rate, term_months, monthly_payment, start_month, status, installments_total)
       VALUES ($1,$2,$3,24000,0,24000,0,55,400,'2026-11-01','pending_signature',55)`,
      [f.unitA, f.tenantId, f.a.landlordId])
    expect(await transactionKindForUnit(f.unitA)).toBe('sale')
  })

  it('a household that already owns its home is renting the lot', async () => {
    const f = await seedSignableUnit()
    await db.query(`UPDATE units SET dwelling_ownership='tenant' WHERE id=$1`, [f.unitA])
    expect(await transactionKindForUnit(f.unitA)).toBe('lot')
  })

  it('a park-owned home with no sale is a rental', async () => {
    const f = await seedSignableUnit()
    await db.query(`UPDATE units SET dwelling_ownership='landlord' WHERE id=$1`, [f.unitA])
    expect(await transactionKindForUnit(f.unitA)).toBe('rental')
  })

  it('a sale in flight beats the ownership flag, because ownership flips at payoff', async () => {
    // The home is still the park's on paper all the way through the contract;
    // what is being papered today is the sale.
    const f = await seedSignableUnit()
    await db.query(`UPDATE units SET dwelling_ownership='landlord' WHERE id=$1`, [f.unitA])
    await db.query(
      `INSERT INTO home_sale_contracts
         (unit_id, tenant_id, landlord_id, sale_price, down_payment, financed_amount,
          annual_interest_rate, term_months, monthly_payment, start_month, status, installments_total)
       VALUES ($1,$2,$3,24000,0,24000,0,55,400,'2026-11-01','active',55)`,
      [f.unitA, f.tenantId, f.a.landlordId])
    expect(await transactionKindForUnit(f.unitA)).toBe('sale')
  })

  it('a cancelled sale does not keep the unit looking like one', async () => {
    const f = await seedSignableUnit()
    await db.query(
      `INSERT INTO home_sale_contracts
         (unit_id, tenant_id, landlord_id, sale_price, down_payment, financed_amount,
          annual_interest_rate, term_months, monthly_payment, start_month, status, installments_total)
       VALUES ($1,$2,$3,24000,0,24000,0,55,400,'2026-11-01','cancelled',55)`,
      [f.unitA, f.tenantId, f.a.landlordId])
    expect(await transactionKindForUnit(f.unitA)).toBe('rental')
  })
})

describe('an account that runs two companies (Blu: Country Acres in IL, Oak Park in AZ)', () => {
  async function twoCompanies() {
    const f = await seed()
    await db.query(`UPDATE properties SET state='IL' WHERE landlord_id=$1`, [f.a.landlordId])
    await db.query(`UPDATE properties SET state='AZ' WHERE landlord_id=$1`, [f.b.landlordId])
    const doc = (await db.query<{ id: string }>(
      `INSERT INTO disclosure_library_documents (disclosure_type, jurisdiction, applies_to, unit_types, name, source_name, source_url, base_pdf_url)
       VALUES ('lead_based_paint','US','sale',NULL,'Federal: Lead — Sales','EPA','https://epa.gov/x','/api/esign/files/x.pdf') RETURNING id`)).rows[0].id
    // The Templates page shows one copy per form, and here it is Oak Park's.
    const azCopy = (await db.query<{ id: string }>(
      `INSERT INTO lease_templates (landlord_id, name, purpose, library_document_id) VALUES ($1,'Federal: Lead — Sales','state_disclosure',$2) RETURNING id`,
      [f.b.landlordId, doc])).rows[0].id
    const both = jwt.sign(
      { userId: f.a.userId, role: 'landlord', email: 'blu@t.dev', profileId: f.a.landlordId, landlordIds: [f.a.landlordId, f.b.landlordId], permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { ...f, doc, azCopy, both }
  }

  it('a package takes any document in the account, whichever company it is filed under — no company question', async () => {
    const f = await twoCompanies()
    // tplB is Oak Park's own lease; azCopy is Oak Park's copy of a federal form.
    const r = await request(buildApp()).post('/api/signing-packages').set('Authorization', `Bearer ${f.both}`)
      .send({ name: 'IL home sale', stateCode: 'IL', items: [{ templateId: f.tplA }, { templateId: f.tplB }, { templateId: f.azCopy }] })
    expect(r.status).toBe(201)
    const items = (await db.query(`SELECT template_id FROM document_package_items WHERE package_id=$1`, [r.body.data.id])).rows
    expect(items.map((x: any) => x.template_id).sort()).toEqual([f.tplA, f.tplB, f.azCopy].sort())
  })

  it('with no state given it still saves — the company is never asked for', async () => {
    const f = await twoCompanies()
    const r = await request(buildApp()).post('/api/signing-packages').set('Authorization', `Bearer ${f.both}`)
      .send({ name: 'No state', items: [] })
    expect(r.status).toBe(201)
  })

  it('a package filed under one company is used for a unit of the other', async () => {
    const f = await twoCompanies()
    const c = await db.connect()
    let unitB: string
    try { unitB = await seedUnit(c, { propertyId: f.propB, landlordId: f.b.landlordId }) } finally { c.release() }
    await db.query(`UPDATE units SET unit_type='mobile_home' WHERE id=$1`, [unitB!])
    // Nic's case: a second park in the SAME state, run by a different company.
    await db.query(`UPDATE properties SET state='IL' WHERE id=$1`, [f.propB])
    const r = await request(buildApp()).post('/api/signing-packages').set('Authorization', `Bearer ${f.both}`)
      .send({ name: 'Every MH park', unitType: 'mobile_home', isDefault: true, stateCode: 'IL', items: [{ templateId: f.tplA }] })
    expect(r.status).toBe(201)
    const got = await request(buildApp()).get(`/api/signing-packages/for-unit/${unitB!}`).set('Authorization', `Bearer ${f.both}`)
    expect(got.status).toBe(200)
    expect(got.body.data?.name).toBe('Every MH park')
  })

  it('a stranger\'s document is still refused', async () => {
    const f = await twoCompanies()
    const c = await db.connect(); let stranger: any
    try { await c.query('BEGIN'); stranger = await seedLandlord(c); await c.query('COMMIT') } finally { c.release() }
    const t = (await db.query<{ id: string }>(`INSERT INTO lease_templates (landlord_id, name, purpose) VALUES ($1,'Theirs','lease') RETURNING id`, [stranger.landlordId])).rows[0].id
    const r = await request(buildApp()).post('/api/signing-packages').set('Authorization', `Bearer ${f.both}`)
      .send({ name: 'IL', stateCode: 'IL', items: [{ templateId: t }] })
    expect(r.status).toBe(403)
  })
})

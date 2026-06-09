/**
 * esign.ts slice 1 — S393. Opens the esign.ts arc.
 *
 * Covered routes (8):
 *   - POST   /api/esign/witnesses/provision
 *   - GET    /api/esign/templates
 *   - POST   /api/esign/templates
 *   - GET    /api/esign/templates/:id
 *   - PATCH  /api/esign/templates/:id
 *   - DELETE /api/esign/templates/:id
 *   - PUT    /api/esign/templates/:id/fields
 *   - DELETE /api/esign/templates/:id/fields/:fieldId  (S393 fix)
 *
 * After this slice: esign.ts coverage 17/25 (68%, up from 36%).
 * Slice 2 (S394) covers documents list/batches/addendum routes
 * + upload/files.
 *
 * Production bug fixed in this slice (1):
 *   - **DELETE /templates/:id/fields/:fieldId** had no template
 *     ownership check. A caller knowing both a stranger template UUID
 *     and a matching field UUID could DELETE the stranger's field.
 *     Same class as S390 variants cross-tenant fix on
 *     pos_item_variants. Fix: SELECT the template with landlord scope
 *     first; 404 if not owned.
 *
 * Findings flagged (NOT fixed):
 *   - DELETE /templates/:id silent no-op on unknown/cross-tenant id
 *     (no SELECT-then-404 check). Caller can't distinguish
 *     "deleted" from "not found." Same shape as S390 DELETE /tax-rates.
 *   - POST /witnesses/provision enables email enumeration via
 *     `reused: true` flag in the response — any authenticated landlord
 *     with leases.create permission can probe whether a given email
 *     exists on the platform.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord } from '../test/dbHelpers'
import { esignRouter } from './esign'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/esign', esignRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_esign_tmpl'
})

interface Fixture {
  landlordAUserId: string
  landlordAId:     string
  landlordBId:     string
  tokenA:          string
  tokenB:          string
}

async function seed(): Promise<Fixture> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId: aUid, landlordId: aId } = await seedLandlord(c)
    const { userId: bUid, landlordId: bId } = await seedLandlord(c)
    await c.query('COMMIT')
    const sign = (uid: string, lid: string) => jwt.sign(
      { userId: uid, role: 'landlord', email: 'l@t.dev', profileId: lid, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    return {
      landlordAUserId: aUid, landlordAId: aId, landlordBId: bId,
      tokenA: sign(aUid, aId), tokenB: sign(bUid, bId),
    }
  } catch (e) { await c.query('ROLLBACK'); throw e }
  finally { c.release() }
}

async function seedTemplate(landlordId: string, name = 'Standard'): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO lease_templates (landlord_id, name, page_count)
     VALUES ($1, $2, 1) RETURNING id`, [landlordId, name])
  return r.rows[0].id
}

async function seedField(templateId: string, opts: { fieldType?: string; signerRole?: string } = {}): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO lease_template_fields
       (template_id, field_type, signer_role, page, x, y, width, height, required, sort_order)
     VALUES ($1, $2, $3, 1, 100, 100, 200, 50, TRUE, 0) RETURNING id`,
    [templateId, opts.fieldType ?? 'text', opts.signerRole ?? 'landlord'])
  return r.rows[0].id
}

// ───────────────────────────────────────────────────────────────────
// POST /witnesses/provision
// ───────────────────────────────────────────────────────────────────

describe('POST /witnesses/provision', () => {
  it('missing email or firstName → 400', async () => {
    const f = await seed()
    const r1 = await request(buildApp())
      .post('/api/esign/witnesses/provision')
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ firstName: 'X' })
    expect(r1.status).toBe(400)
    const r2 = await request(buildApp())
      .post('/api/esign/witnesses/provision')
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ email: 'x@y.com' })
    expect(r2.status).toBe(400)
  })

  it('invalid email format → 400', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .post('/api/esign/witnesses/provision')
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ email: 'not-an-email', firstName: 'X' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/invalid email/i)
  })

  it('new email: creates tenant user with placeholder hash; returns reused=false', async () => {
    const f = await seed()
    const email = `witness-${randomUUID()}@test.dev`
    const res = await request(buildApp())
      .post('/api/esign/witnesses/provision')
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ email, firstName: 'Wit', lastName: 'Ness' })
    expect(res.status).toBe(201)
    expect(res.body.data.userId).toBeTruthy()
    expect(res.body.data.reused).toBe(false)
    const u = await db.query<{ role: string; password_hash: string }>(
      `SELECT role, password_hash FROM users WHERE id=$1`, [res.body.data.userId])
    expect(u.rows[0].role).toBe('tenant')
    expect(u.rows[0].password_hash).toMatch(/placeholder/)
  })

  it('FINDING (S393): existing email returns reused=true → enables email enumeration', async () => {
    const f = await seed()
    const existingEmail = `existing-${randomUUID()}@test.dev`
    await db.query(
      `INSERT INTO users (email, password_hash, role, first_name, last_name) VALUES ($1, 'x', 'landlord', 'Pre', 'Existing')`,
      [existingEmail])
    const res = await request(buildApp())
      .post('/api/esign/witnesses/provision')
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ email: existingEmail, firstName: 'X' })
    expect(res.status).toBe(200)
    expect(res.body.data.reused).toBe(true)  // the enumeration signal — flagged
  })
})

// ───────────────────────────────────────────────────────────────────
// GET / POST / GET-id /templates
// ───────────────────────────────────────────────────────────────────

describe('GET /templates', () => {
  it('landlord-scoped + field_count from JOIN', async () => {
    const f = await seed()
    const tA = await seedTemplate(f.landlordAId, 'A Template')
    await seedField(tA)
    await seedField(tA)
    await seedTemplate(f.landlordBId, 'B Template')  // not seen by A
    const res = await request(buildApp())
      .get('/api/esign/templates')
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].name).toBe('A Template')
    expect(res.body.data[0].field_count).toBe(2)
  })

  it('inactive templates excluded', async () => {
    const f = await seed()
    const t = await seedTemplate(f.landlordAId, 'Old')
    await db.query(`UPDATE lease_templates SET is_active=FALSE WHERE id=$1`, [t])
    const res = await request(buildApp())
      .get('/api/esign/templates')
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.body.data).toEqual([])
  })
})

describe('POST /templates', () => {
  it('missing name → 400', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .post('/api/esign/templates')
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ description: 'noname' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/template name required/i)
  })

  it('happy: creates with pageCount default 1', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .post('/api/esign/templates')
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ name: 'Standard 12-month' })
    expect(res.status).toBe(201)
    expect(res.body.data.name).toBe('Standard 12-month')
    expect(res.body.data.page_count).toBe(1)
    expect(res.body.data.landlord_id).toBe(f.landlordAId)
  })
})

describe('GET /templates/:id', () => {
  it('cross-landlord → 404', async () => {
    const f = await seed()
    const tB = await seedTemplate(f.landlordBId)
    const res = await request(buildApp())
      .get(`/api/esign/templates/${tB}`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(404)
  })

  it('happy: returns template + fields ordered by page/sort_order/y', async () => {
    const f = await seed()
    const t = await seedTemplate(f.landlordAId)
    await seedField(t, { fieldType: 'text', signerRole: 'landlord' })
    await seedField(t, { fieldType: 'signature', signerRole: 'primary' })
    const res = await request(buildApp())
      .get(`/api/esign/templates/${t}`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.data.fields).toHaveLength(2)
  })
})

describe('PATCH /templates/:id', () => {
  it('cross-landlord → 404', async () => {
    const f = await seed()
    const tB = await seedTemplate(f.landlordBId)
    const res = await request(buildApp())
      .patch(`/api/esign/templates/${tB}`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ name: 'Hijack' })
    expect(res.status).toBe(404)
  })

  it('happy: COALESCE update preserves untouched', async () => {
    const f = await seed()
    const t = await seedTemplate(f.landlordAId, 'Original')
    const res = await request(buildApp())
      .patch(`/api/esign/templates/${t}`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ description: 'New desc' })
    expect(res.status).toBe(200)
    expect(res.body.data.description).toBe('New desc')
    expect(res.body.data.name).toBe('Original')  // preserved
  })
})

describe('DELETE /templates/:id', () => {
  it('happy: soft-deletes (is_active=FALSE)', async () => {
    const f = await seed()
    const t = await seedTemplate(f.landlordAId)
    const res = await request(buildApp())
      .delete(`/api/esign/templates/${t}`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(200)
    const row = await db.query<{ is_active: boolean }>(
      `SELECT is_active FROM lease_templates WHERE id=$1`, [t])
    expect(row.rows[0].is_active).toBe(false)
  })

  it('FINDING (S393): cross-landlord DELETE silently no-ops (no 404 check)', async () => {
    const f = await seed()
    const tB = await seedTemplate(f.landlordBId, 'B template')
    const res = await request(buildApp())
      .delete(`/api/esign/templates/${tB}`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    // Cross-tenant returns 200 with no mutation (no 404). Same class
    // as the S390 DELETE /tax-rates finding.
    expect([200, 404]).toContain(res.status)
    const row = await db.query<{ is_active: boolean }>(
      `SELECT is_active FROM lease_templates WHERE id=$1`, [tB])
    expect(row.rows[0].is_active).toBe(true)  // unchanged
  })
})

// ───────────────────────────────────────────────────────────────────
// PUT /templates/:id/fields (replace-all)
// ───────────────────────────────────────────────────────────────────

describe('PUT /templates/:id/fields', () => {
  it('cross-landlord template → 404', async () => {
    const f = await seed()
    const tB = await seedTemplate(f.landlordBId)
    const res = await request(buildApp())
      .put(`/api/esign/templates/${tB}/fields`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ fields: [] })
    expect(res.status).toBe(404)
  })

  it('invalid signer_role → 400', async () => {
    const f = await seed()
    const t = await seedTemplate(f.landlordAId)
    const res = await request(buildApp())
      .put(`/api/esign/templates/${t}/fields`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ fields: [
        { fieldType: 'text', signerRole: 'not-a-role', x: 100, y: 100 },
      ] })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/invalid signer_role/i)
  })

  it('happy: replace-all wipes old fields + inserts new', async () => {
    const f = await seed()
    const t = await seedTemplate(f.landlordAId)
    await seedField(t)  // old field
    const res = await request(buildApp())
      .put(`/api/esign/templates/${t}/fields`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ fields: [
        { fieldType: 'text', signerRole: 'landlord', label: 'New 1', x: 50, y: 50, width: 100, height: 30 },
        { fieldType: 'signature', signerRole: 'primary', label: 'New 2', x: 50, y: 100, width: 200, height: 50 },
      ] })
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(2)
    const rows = await db.query<{ label: string }>(
      `SELECT label FROM lease_template_fields WHERE template_id=$1 ORDER BY label`, [t])
    expect(rows.rows.map(r => r.label)).toEqual(['New 1', 'New 2'])
  })
})

// ───────────────────────────────────────────────────────────────────
// DELETE /templates/:id/fields/:fieldId — S393 scope fix
// ───────────────────────────────────────────────────────────────────

describe('DELETE /templates/:id/fields/:fieldId — S393 scope fix', () => {
  it('S393 fix: cross-landlord template → 404; field NOT deleted', async () => {
    const f = await seed()
    const tB = await seedTemplate(f.landlordBId)
    const fieldB = await seedField(tB)
    const res = await request(buildApp())
      .delete(`/api/esign/templates/${tB}/fields/${fieldB}`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(404)
    const row = await db.query(`SELECT id FROM lease_template_fields WHERE id=$1`, [fieldB])
    expect(row.rows).toHaveLength(1)  // unchanged
  })

  it('happy: own template + own field → deleted', async () => {
    const f = await seed()
    const t = await seedTemplate(f.landlordAId)
    const fid = await seedField(t)
    const res = await request(buildApp())
      .delete(`/api/esign/templates/${t}/fields/${fid}`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(200)
    const row = await db.query(`SELECT id FROM lease_template_fields WHERE id=$1`, [fid])
    expect(row.rows).toHaveLength(0)
  })
})

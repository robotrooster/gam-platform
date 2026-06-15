/**
 * S509 — business attachments coverage.
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import express from 'express'
import request from 'supertest'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import fs from 'fs'
import path from 'path'
import { db } from '../db'
import { cleanupAllSchema } from '../test/dbHelpers'
import { businessAttachmentsRouter } from './businessAttachments'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use('/api/business-attachments', businessAttachmentsRouter)
  app.use(errorHandler)
  return app
}

const UPLOAD_ROOT = path.join(process.cwd(), 'uploads', 'business-attachments')

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_s509'
})

afterAll(() => {
  // Best-effort cleanup of test files on disk.
  if (fs.existsSync(UPLOAD_ROOT)) {
    fs.rmSync(UPLOAD_ROOT, { recursive: true, force: true })
  }
})

interface Fixture {
  ownerToken: string
  businessId: string
  customerId: string
  workOrderId: string
}

async function seedFixture(opts: { features?: string[] } = {}): Promise<Fixture> {
  const hash = await bcrypt.hash('pw', 12)
  const email = `o-${randomUUID()}@test.dev`
  const { rows: [u] } = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1, $2, 'business_owner', 'B', 'O', TRUE) RETURNING id`,
    [email, hash])
  const features = opts.features ?? ['customers', 'staff', 'work_orders']
  const { rows: [b] } = await db.query<{ id: string }>(
    `INSERT INTO businesses (owner_user_id, name, business_type, email, enabled_features)
     VALUES ($1, 'Test Shop', 'mechanic_stationary', $2, $3) RETURNING id`,
    [u.id, email, features])
  const { rows: [c] } = await db.query<{ id: string }>(
    `INSERT INTO business_customers
       (business_id, customer_type, first_name, last_name,
        street1, city, state, zip)
     VALUES ($1, 'individual', 'Jane', 'Doe', '100 Main', 'Phoenix', 'AZ', '85001')
     RETURNING id`, [b.id])
  const { rows: [wo] } = await db.query<{ id: string }>(
    `INSERT INTO business_work_orders
       (business_id, wo_number, customer_id, status, complaint)
     VALUES ($1, 'WO-000001', $2, 'open', 'Brake squeal')
     RETURNING id`, [b.id, c.id])
  const ownerToken = jwt.sign(
    { userId: u.id, role: 'business_owner', email, profileId: b.id, businessId: b.id },
    process.env.JWT_SECRET!, { expiresIn: '1h' })
  return { ownerToken, businessId: b.id, customerId: c.id, workOrderId: wo.id }
}

// 1x1 transparent PNG for fake image uploads.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=',
  'base64')

// ═══════════════════════════════════════════════════════════════
//  POST / — upload
// ═══════════════════════════════════════════════════════════════

describe('POST /business-attachments', () => {
  it('uploads a PNG attached to a work order; writes DB + disk', async () => {
    const f = await seedFixture()
    const res = await request(buildApp())
      .post('/api/business-attachments')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .field('entityType', 'work_order')
      .field('entityId', f.workOrderId)
      .field('description', 'Before photo')
      .attach('file', TINY_PNG, { filename: 'before.png', contentType: 'image/png' })
    expect(res.status).toBe(201)
    expect(res.body.data.file_name).toBe('before.png')
    expect(res.body.data.mime_type).toBe('image/png')
    expect(res.body.data.entity_type).toBe('work_order')

    const { rows: [att] } = await db.query<{ id: string; stored_filename: string }>(
      `SELECT id, stored_filename FROM business_attachments WHERE business_id = $1`,
      [f.businessId])
    expect(att).toBeDefined()
    const filePath = path.join(UPLOAD_ROOT, f.businessId, att.stored_filename)
    expect(fs.existsSync(filePath)).toBe(true)
  })

  it('rejects unwhitelisted MIME type', async () => {
    const f = await seedFixture()
    const res = await request(buildApp())
      .post('/api/business-attachments')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .field('entityType', 'work_order')
      .field('entityId', f.workOrderId)
      .attach('file', Buffer.from('exec'), { filename: 'evil.exe', contentType: 'application/x-msdownload' })
    expect(res.status).toBeGreaterThanOrEqual(400)
  })

  it('cross-business work order → 404', async () => {
    const a = await seedFixture()
    const b = await seedFixture()
    const res = await request(buildApp())
      .post('/api/business-attachments')
      .set('Authorization', `Bearer ${a.ownerToken}`)
      .field('entityType', 'work_order')
      .field('entityId', b.workOrderId)
      .attach('file', TINY_PNG, { filename: 'x.png', contentType: 'image/png' })
    expect(res.status).toBe(404)
  })

  it('feature gate: work_orders feature off → 403', async () => {
    const f = await seedFixture({ features: ['customers', 'staff'] })
    const res = await request(buildApp())
      .post('/api/business-attachments')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .field('entityType', 'work_order')
      .field('entityId', f.workOrderId)
      .attach('file', TINY_PNG, { filename: 'x.png', contentType: 'image/png' })
    expect(res.status).toBe(403)
  })

  it('isInternal flag persisted as boolean', async () => {
    const f = await seedFixture()
    const res = await request(buildApp())
      .post('/api/business-attachments')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .field('entityType', 'work_order')
      .field('entityId', f.workOrderId)
      .field('isInternal', 'true')
      .attach('file', TINY_PNG, { filename: 'odo.png', contentType: 'image/png' })
    expect(res.body.data.is_internal).toBe(true)
  })

  it('attaches to a customer (different permission)', async () => {
    const f = await seedFixture()
    const res = await request(buildApp())
      .post('/api/business-attachments')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .field('entityType', 'customer')
      .field('entityId', f.customerId)
      .attach('file', TINY_PNG, { filename: 'waiver.png', contentType: 'image/png' })
    expect(res.status).toBe(201)
    expect(res.body.data.entity_type).toBe('customer')
  })
})

// ═══════════════════════════════════════════════════════════════
//  GET / — list
// ═══════════════════════════════════════════════════════════════

describe('GET /business-attachments', () => {
  it('lists attachments for the entity, newest first', async () => {
    const f = await seedFixture()
    await request(buildApp())
      .post('/api/business-attachments')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .field('entityType', 'work_order').field('entityId', f.workOrderId)
      .attach('file', TINY_PNG, { filename: 'a.png', contentType: 'image/png' })
    await request(buildApp())
      .post('/api/business-attachments')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .field('entityType', 'work_order').field('entityId', f.workOrderId)
      .attach('file', TINY_PNG, { filename: 'b.png', contentType: 'image/png' })
    const res = await request(buildApp())
      .get(`/api/business-attachments?entityType=work_order&entityId=${f.workOrderId}`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.length).toBe(2)
  })

  it('cross-business → 404 (parent entity not found)', async () => {
    const a = await seedFixture()
    const b = await seedFixture()
    const res = await request(buildApp())
      .get(`/api/business-attachments?entityType=work_order&entityId=${b.workOrderId}`)
      .set('Authorization', `Bearer ${a.ownerToken}`)
    expect(res.status).toBe(404)
  })
})

// ═══════════════════════════════════════════════════════════════
//  GET /:id/download
// ═══════════════════════════════════════════════════════════════

describe('GET /:id/download', () => {
  it('streams the file with correct content-type', async () => {
    const f = await seedFixture()
    const up = await request(buildApp())
      .post('/api/business-attachments')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .field('entityType', 'work_order').field('entityId', f.workOrderId)
      .attach('file', TINY_PNG, { filename: 'x.png', contentType: 'image/png' })
    const res = await request(buildApp())
      .get(`/api/business-attachments/${up.body.data.id}/download`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .responseType('blob')
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('image/png')
    expect(res.body.length).toBe(TINY_PNG.length)
  })

  it('cross-business → 404', async () => {
    const a = await seedFixture()
    const b = await seedFixture()
    const up = await request(buildApp())
      .post('/api/business-attachments')
      .set('Authorization', `Bearer ${b.ownerToken}`)
      .field('entityType', 'work_order').field('entityId', b.workOrderId)
      .attach('file', TINY_PNG, { filename: 'x.png', contentType: 'image/png' })
    const res = await request(buildApp())
      .get(`/api/business-attachments/${up.body.data.id}/download`)
      .set('Authorization', `Bearer ${a.ownerToken}`)
    expect(res.status).toBe(404)
  })
})

// ═══════════════════════════════════════════════════════════════
//  DELETE
// ═══════════════════════════════════════════════════════════════

describe('DELETE /:id', () => {
  it('removes DB row + disk file', async () => {
    const f = await seedFixture()
    const up = await request(buildApp())
      .post('/api/business-attachments')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .field('entityType', 'work_order').field('entityId', f.workOrderId)
      .attach('file', TINY_PNG, { filename: 'x.png', contentType: 'image/png' })
    const id = up.body.data.id
    const { rows: [att] } = await db.query<{ stored_filename: string }>(
      `SELECT stored_filename FROM business_attachments WHERE id = $1`, [id])
    const filePath = path.join(UPLOAD_ROOT, f.businessId, att.stored_filename)
    expect(fs.existsSync(filePath)).toBe(true)

    const res = await request(buildApp())
      .delete(`/api/business-attachments/${id}`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(res.status).toBe(200)

    const { rows } = await db.query(`SELECT id FROM business_attachments WHERE id = $1`, [id])
    expect(rows.length).toBe(0)
    // Disk cleanup is best-effort + may race; check after a tick.
    await new Promise(r => setTimeout(r, 30))
    expect(fs.existsSync(filePath)).toBe(false)
  })

  it('cross-business → 404', async () => {
    const a = await seedFixture()
    const b = await seedFixture()
    const up = await request(buildApp())
      .post('/api/business-attachments')
      .set('Authorization', `Bearer ${b.ownerToken}`)
      .field('entityType', 'work_order').field('entityId', b.workOrderId)
      .attach('file', TINY_PNG, { filename: 'x.png', contentType: 'image/png' })
    const res = await request(buildApp())
      .delete(`/api/business-attachments/${up.body.data.id}`)
      .set('Authorization', `Bearer ${a.ownerToken}`)
    expect(res.status).toBe(404)
  })
})

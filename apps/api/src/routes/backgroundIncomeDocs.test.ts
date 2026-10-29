/**
 * 10/26 (Nic) — PROOF OF INCOME ON THE APPLICATION.
 *
 *   "We don't have any way on the application for when people do the
 *    background check, we don't have any way for them to upload proof of
 *    income, right? We probably need to start adding that."
 *
 * The upload itself is the easy half. The half that matters is the way back
 * OUT: a benefit letter or a pay stub is served only to the person it belongs
 * to or the company screening them, and to nobody else. Nothing under
 * uploads/ is ever public.
 *
 * These also cover the EXISTING /id-files route, which had no test at all —
 * same shape, same stakes, found while adding this one.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import fs from 'fs'
import path from 'path'
import { db, query } from '../db'
import { cleanupAllSchema, seedLandlord } from '../test/dbHelpers'
import { backgroundRouter } from './background'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/background', backgroundRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_income_docs'
})

const tenantToken = (userId: string) => jwt.sign(
  { userId, role: 'tenant', email: 't@t.dev', profileId: userId, permissions: {} },
  process.env.JWT_SECRET!, { expiresIn: '1h' })

const landlordToken = (userId: string, landlordIds: string[]) => jwt.sign(
  { userId, role: 'landlord', email: 'll@t.dev', profileId: null, landlordIds, permissions: {} },
  process.env.JWT_SECRET!, { expiresIn: '1h' })

async function newUser(role: 'tenant' | 'landlord', first: string) {
  const u = await query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1, 'x', $2, $3, 'Doe', TRUE) RETURNING id`,
    [`${first.toLowerCase()}-${randomUUID()}@test.dev`, role, first])
  return u[0].id
}

/** An applicant with a screening record, owned by a landlord. */
async function seedCheck() {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const ll = await seedLandlord(c)
    await c.query('COMMIT')
    const applicantId = await newUser('tenant', 'Applicant')
    const bc = await query<{ id: string }>(
      `INSERT INTO background_checks (landlord_id, user_id, status)
       VALUES ($1, $2, 'pending') RETURNING id`, [ll.landlordId, applicantId])
    return { ...ll, applicantId, checkId: bc[0].id }
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e } finally { c.release() }
}

const upload = (token: string, name: string, type: string) =>
  request(buildApp()).post('/api/background/upload-income')
    .set('Authorization', `Bearer ${token}`)
    .attach('file', Buffer.from('%PDF-1.4 benefit letter'), { filename: name, contentType: type })

const fetchFile = (token: string, url: string) =>
  request(buildApp()).get(url).set('Authorization', `Bearer ${token}`)

describe('uploading proof of income', () => {
  it('takes a PDF and hands back a url under the gated path', async () => {
    const s = await seedCheck()
    const res = await upload(tenantToken(s.applicantId), 'benefits.pdf', 'application/pdf')
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data.url).toMatch(/^\/api\/background\/income-files\//)
    expect(res.body.data.filename).toBe('benefits.pdf')
    // Never under a public directory, and never beside the ID documents —
    // a separate store is what keeps the two auth checks from crossing.
    expect(res.body.data.url).not.toContain('/uploads/')
    expect(res.body.data.url).not.toContain('id-files')
  })

  // A wrong file type is the applicant's mistake, so it is a 400 with words
  // they can act on. It used to surface as a 500 from multer's thrown filter
  // error — no guidance, and a fake server fault in the log.
  it('refuses a file type that is not an image or a PDF, as a 400', async () => {
    const s = await seedCheck()
    const res = await upload(tenantToken(s.applicantId), 'payroll.exe', 'application/x-msdownload')
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('JPEG')
  })

  it('takes a photo of a benefit letter too', async () => {
    const s = await seedCheck()
    for (const [name, type] of [['letter.jpg', 'image/jpeg'], ['letter.png', 'image/png']]) {
      const res = await upload(tenantToken(s.applicantId), name, type)
      expect(res.status, name).toBe(200)
    }
  })

  it('refuses an upload with no session at all', async () => {
    const res = await request(buildApp()).post('/api/background/upload-income')
      .attach('file', Buffer.from('x'), { filename: 'b.pdf', contentType: 'application/pdf' })
    expect(res.status).toBe(401)
  })

  it('refuses a post with no file', async () => {
    const s = await seedCheck()
    const res = await request(buildApp()).post('/api/background/upload-income')
      .set('Authorization', `Bearer ${tenantToken(s.applicantId)}`)
    expect(res.status).toBe(400)
  })
})

describe('who may read a proof-of-income file', () => {
  /** Upload, then attach the url to the screening record the way /submit does. */
  async function uploaded(s: Awaited<ReturnType<typeof seedCheck>>) {
    const res = await upload(tenantToken(s.applicantId), 'award.pdf', 'application/pdf')
    expect(res.status).toBe(200)
    const url: string = res.body.data.url
    await query(
      `UPDATE background_checks SET income_document_urls = to_jsonb($2::text[]) WHERE id = $1`,
      [s.checkId, [url]])
    return url
  }

  it('serves it to the applicant it belongs to', async () => {
    const s = await seedCheck()
    const url = await uploaded(s)
    expect((await fetchFile(tenantToken(s.applicantId), url)).status).toBe(200)
  })

  it('serves it to the company screening them', async () => {
    const s = await seedCheck()
    const url = await uploaded(s)
    expect((await fetchFile(landlordToken(s.userId, [s.landlordId]), url)).status).toBe(200)
  })

  it('refuses another tenant, even a signed-in one', async () => {
    const s = await seedCheck()
    const url = await uploaded(s)
    const nosy = await newUser('tenant', 'Nosy')
    expect((await fetchFile(tenantToken(nosy), url)).status).toBe(403)
  })

  it('refuses a landlord who is not the one screening them', async () => {
    const s = await seedCheck()
    const url = await uploaded(s)
    const other = await db.connect()
    let otherLandlordId = ''
    try {
      await other.query('BEGIN')
      otherLandlordId = (await seedLandlord(other)).landlordId
      await other.query('COMMIT')
    } finally { other.release() }
    const stranger = await newUser('landlord', 'Stranger')
    expect((await fetchFile(landlordToken(stranger, [otherLandlordId]), url)).status).toBe(403)
  })

  it('refuses with no session', async () => {
    const s = await seedCheck()
    const url = await uploaded(s)
    expect((await request(buildApp()).get(url)).status).toBe(401)
  })

  it('404s a file that was uploaded but never attached to any record', async () => {
    // An orphan is nobody's: with no row pointing at it there is no owner to
    // compare against, so it must not be served to the uploader either.
    const s = await seedCheck()
    const res = await upload(tenantToken(s.applicantId), 'stray.pdf', 'application/pdf')
    expect((await fetchFile(tenantToken(s.applicantId), res.body.data.url)).status).toBe(404)
  })

  it('404s a filename that does not exist', async () => {
    const s = await seedCheck()
    const r = await fetchFile(tenantToken(s.applicantId), '/api/background/income-files/nope.pdf')
    expect(r.status).toBe(404)
  })

  it('refuses a path that climbs out of the income directory', async () => {
    const s = await seedCheck()
    for (const bad of ['..%2F..%2Fpackage.json', '....//package.json', '%2e%2e%2fpackage.json']) {
      const r = await fetchFile(tenantToken(s.applicantId), `/api/background/income-files/${bad}`)
      expect(r.status, bad).toBeGreaterThanOrEqual(400)
      expect(r.text).not.toContain('"@gam/api"')
    }
  })

  // An income document and an ID document must never be reachable through each
  // other's route: the two auth checks read different columns, so a crossed
  // path would be checked against the wrong owner.
  it('does not serve an income file through the ID route', async () => {
    const s = await seedCheck()
    const res = await upload(tenantToken(s.applicantId), 'award.pdf', 'application/pdf')
    const name = String(res.body.data.url).split('/').pop()
    const r = await fetchFile(tenantToken(s.applicantId), `/api/background/id-files/${name}`)
    expect(r.status).toBe(404)
  })
})

// Found while adding the above: /id-files had no test. Same shape, same stakes.
describe('who may read an ID document (pre-existing route, previously untested)', () => {
  async function uploadedId(s: Awaited<ReturnType<typeof seedCheck>>) {
    const res = await request(buildApp()).post('/api/background/upload-id')
      .set('Authorization', `Bearer ${tenantToken(s.applicantId)}`)
      .attach('file', Buffer.from('%PDF-1.4 drivers licence'), { filename: 'dl.pdf', contentType: 'application/pdf' })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    await query(`UPDATE background_checks SET id_document_url = $2 WHERE id = $1`,
      [s.checkId, res.body.data.url])
    return res.body.data.url as string
  }

  it('serves it to the applicant and to their screening company only', async () => {
    const s = await seedCheck()
    const url = await uploadedId(s)
    expect((await fetchFile(tenantToken(s.applicantId), url)).status).toBe(200)
    expect((await fetchFile(landlordToken(s.userId, [s.landlordId]), url)).status).toBe(200)
    const nosy = await newUser('tenant', 'Nosy')
    expect((await fetchFile(tenantToken(nosy), url)).status).toBe(403)
    expect((await request(buildApp()).get(url)).status).toBe(401)
  })
})

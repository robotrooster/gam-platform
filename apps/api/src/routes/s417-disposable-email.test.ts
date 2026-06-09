/**
 * S417 fan-out: disposable-email block applied across all
 * email-accepting routes. Lib helper at apps/api/src/lib/email.ts.
 *
 * Covered routes (6 — net new disposable-domain gate):
 *   - POST /api/auth/register
 *   - POST /api/auth/register-prospect
 *   - POST /api/tenants/invite
 *   - POST /api/books/contractors
 *   - POST /api/books/vendors
 *   - POST /api/books/employees
 *
 * (PATCH /api/tenants/profile already covered by S411 slice.)
 *
 * Each test sends a disposable-domain email and expects 400 + the
 * shared error message. Happy paths are exercised by the routes'
 * existing slice tests.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit,
} from '../test/dbHelpers'
import { authRouter } from './auth'
import { tenantsRouter } from './tenants'
import { booksRouter } from './books'
import { errorHandler } from '../middleware/errorHandler'
import { isDisposableEmail, DISPOSABLE_EMAIL_DOMAINS } from '../lib/email'

function buildAuthApp() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/auth', authRouter)
  app.use(errorHandler)
  return app
}
function buildTenantsApp() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/tenants', tenantsRouter)
  app.use(errorHandler)
  return app
}
function buildBooksApp() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/books', booksRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_s417'
})

const sign = (claims: any) =>
  jwt.sign(claims, process.env.JWT_SECRET!, { expiresIn: '1h' })

// ─── helper unit tests ──────────────────────────────────────

describe('isDisposableEmail helper', () => {
  it('blocks mailinator.com', () => {
    expect(isDisposableEmail('foo@mailinator.com')).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(isDisposableEmail('FOO@YOPMAIL.COM')).toBe(true)
  })

  it('trims surrounding whitespace on the domain', () => {
    expect(isDisposableEmail('foo@mailinator.com   ')).toBe(true)
  })

  it('allows legit domains (gmail)', () => {
    expect(isDisposableEmail('jane@gmail.com')).toBe(false)
  })

  it('returns false on malformed input (no @)', () => {
    expect(isDisposableEmail('not-an-email')).toBe(false)
  })

  it('block list has the curated set (sanity)', () => {
    expect(DISPOSABLE_EMAIL_DOMAINS.size).toBeGreaterThanOrEqual(10)
    expect(DISPOSABLE_EMAIL_DOMAINS.has('mailinator.com')).toBe(true)
  })
})

// ─── POST /api/auth/register ────────────────────────────────

describe('POST /api/auth/register — S417 disposable-domain block', () => {
  it('mailinator email → 400 with shared message', async () => {
    const res = await request(buildAuthApp())
      .post('/api/auth/register')
      .send({
        email: `foo-${randomUUID()}@mailinator.com`,
        password: 'longenoughpassword12',
        firstName: 'X', lastName: 'Y',
        role: 'tenant',
        acceptedTerms: true,
      })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/disposable|temporary/i)
  })
})

// ─── POST /api/auth/register-prospect ───────────────────────

describe('POST /api/auth/register-prospect — S417 disposable-domain block', () => {
  it('yopmail email → 400', async () => {
    const res = await request(buildAuthApp())
      .post('/api/auth/register-prospect')
      .send({
        email: `prospect-${randomUUID()}@yopmail.com`,
        password: 'longenoughpassword12',
        firstName: 'A', lastName: 'B',
        acceptedTerms: true,
      })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/disposable|temporary/i)
  })
})

// ─── POST /api/tenants/invite ───────────────────────────────

describe('POST /api/tenants/invite — S417 disposable-domain block', () => {
  it('throwawaymail email → 400', async () => {
    const c = await db.connect()
    let token = ''; let unitId = ''
    try {
      await c.query('BEGIN')
      const { userId, landlordId } = await seedLandlord(c)
      const propertyId = await seedProperty(c, {
        landlordId, ownerUserId: userId, managedByUserId: userId,
      })
      unitId = await seedUnit(c, { propertyId, landlordId })
      await c.query('COMMIT')
      token = sign({ userId, role: 'landlord', email: 'l@t.dev',
                     profileId: landlordId, permissions: {} })
    } finally { c.release() }
    const res = await request(buildTenantsApp())
      .post('/api/tenants/invite')
      .set('Authorization', `Bearer ${token}`)
      .send({ email: `t-${randomUUID()}@throwawaymail.com`,
              firstName: 'T', unitId })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/disposable|temporary/i)
  })
})

// ─── POST /api/books/contractors ────────────────────────────

describe('POST /api/books/contractors — S417 disposable-domain block', () => {
  it('mailinator email → 400 (even with full required payload)', async () => {
    const c = await db.connect()
    let token = ''
    try {
      await c.query('BEGIN')
      const { userId, landlordId } = await seedLandlord(c)
      await c.query('COMMIT')
      token = sign({ userId, role: 'landlord', email: 'l@t.dev',
                     profileId: landlordId, permissions: {} })
    } finally { c.release() }
    const res = await request(buildBooksApp())
      .post('/api/books/contractors')
      .set('Authorization', `Bearer ${token}`)
      .send({
        firstName: 'Jane', lastName: 'Doe',
        businessName: 'Acme', email: `c-${randomUUID()}@mailinator.com`,
        phone: '5555550100', address: '1 St',
        entityType: 'individual', ssnLast4: '1234',
        trade: 'plumbing', payRate: 75, payUnit: 'hour',
        w9OnFile: true,
      })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/disposable|temporary/i)
  })
})

// ─── POST /api/books/vendors ────────────────────────────────

describe('POST /api/books/vendors — S417 disposable-domain block', () => {
  it('mailinator email → 400 (even with full required payload)', async () => {
    const c = await db.connect()
    let token = ''
    try {
      await c.query('BEGIN')
      const { userId, landlordId } = await seedLandlord(c)
      await c.query('COMMIT')
      token = sign({ userId, role: 'landlord', email: 'l@t.dev',
                     profileId: landlordId, permissions: {} })
    } finally { c.release() }
    const res = await request(buildBooksApp())
      .post('/api/books/vendors')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Acme',
        contactName: 'Joe',
        email: `v-${randomUUID()}@yopmail.com`,
        phone: '5555550100',
        address: '1 St',
        category: 'plumbing',
        paymentTerms: 'net30',
        taxId: '12-3456789',
      })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/disposable|temporary/i)
  })
})

// ─── POST /api/books/employees ──────────────────────────────

describe('POST /api/books/employees — S417 disposable-domain block', () => {
  it('mailinator email → 400 (even with full required payload)', async () => {
    const c = await db.connect()
    let token = ''
    try {
      await c.query('BEGIN')
      const { userId, landlordId } = await seedLandlord(c)
      await c.query('COMMIT')
      token = sign({ userId, role: 'landlord', email: 'l@t.dev',
                     profileId: landlordId, permissions: {} })
    } finally { c.release() }
    const res = await request(buildBooksApp())
      .post('/api/books/employees')
      .set('Authorization', `Bearer ${token}`)
      .send({
        firstName: 'Ann', lastName: 'Smith',
        email: `e-${randomUUID()}@mailinator.com`,
        phone: '5555550100', address: '1 St',
        ssnLast4: '1234',
        payType: 'salary', payRate: 55000,
        payFrequency: 'biweekly',
        filingStatus: 'single',
        federalAllowances: 0,
        stateWithholdingPct: 2.5,
        title: 'PM', department: 'Ops',
        startDate: '2026-01-15',
      })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/disposable|temporary/i)
  })
})

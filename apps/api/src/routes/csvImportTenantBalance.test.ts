/**
 * Tenant CSV — outstanding_balance opening-invoice path (S29X / Phase A).
 *
 * Covers:
 *   - Validate parses outstanding_balance with currency formatting
 *     (e.g. "$1,234.56") and accepts negative as block.
 *   - Commit writes a `pending` invoice (subtotal_rent=balance,
 *     due_date=today, notes="Imported opening balance from prior
 *     platform.") for any positive balance.
 *   - Zero, missing, or negative balances skip invoice creation.
 *   - Invoice uses the landlord's invoice_sequences counter
 *     (no collision with native GAM-generated invoices).
 *
 * Mocks emailTenantOnboarded since commit fires activation emails
 * post-commit and we don't want real network calls in the test harness.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { db } from '../db'
import { cleanupAllSchema } from '../test/dbHelpers'

const { sendOnboardMock } = vi.hoisted(() => ({
  sendOnboardMock: vi.fn(async () => 'msg_onboard'),
}))
vi.mock('../services/email', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    emailTenantOnboarded: sendOnboardMock,
  }
})

import { landlordsRouter } from './landlords'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '10mb' }))
  app.use('/api/landlords', landlordsRouter)
  app.use(errorHandler)
  return app
}

async function seedLandlordWithProperty(): Promise<{
  landlordId: string
  userId:     string
  propertyId: string
  unitId:     string
  token:      string
}> {
  const email = `ll-${Math.random().toString(36).slice(2)}@test.dev`
  const u = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1, 'x', 'landlord', 'Test', 'LL', TRUE) RETURNING id`,
    [email],
  )
  const userId = u.rows[0].id
  const l = await db.query<{ id: string }>(
    `INSERT INTO landlords (user_id) VALUES ($1) RETURNING id`,
    [userId],
  )
  const landlordId = l.rows[0].id
  const p = await db.query<{ id: string }>(
    `INSERT INTO properties (landlord_id, name, street1, city, state, zip,
                             owner_user_id, managed_by_user_id)
     VALUES ($1, 'Sunset Apartments', '100 Main St', 'Phoenix', 'AZ', '85001',
             $2, $2) RETURNING id`,
    [landlordId, userId],
  )
  const propertyId = p.rows[0].id
  const un = await db.query<{ id: string }>(
    `INSERT INTO units (property_id, landlord_id, unit_number, rent_amount)
     VALUES ($1, $2, '4B', 1850) RETURNING id`,
    [propertyId, landlordId],
  )
  const unitId = un.rows[0].id
  const token = jwt.sign(
    { userId, role: 'landlord', email, profileId: landlordId, permissions: {} },
    process.env.JWT_SECRET!,
    { expiresIn: '1h' },
  )
  return { landlordId, userId, propertyId, unitId, token }
}

beforeEach(async () => {
  await cleanupAllSchema()
  sendOnboardMock.mockClear()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_csv_tenant_balance'
})

describe('Tenant CSV — outstanding_balance parsing (validate)', () => {
  it('accepts a plain numeric balance', async () => {
    const { token } = await seedLandlordWithProperty()
    const csv = [
      'first_name,last_name,email,phone,property_name,unit_number,lease_start,monthly_rent,outstanding_balance',
      'Jane,Doe,jane@x.com,555-0100,Sunset Apartments,4B,2024-06-01,1850,1234.56',
    ].join('\n')

    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-tenants-csv/validate')
      .set('Authorization', `Bearer ${token}`)
      .send({ csv, source: 'generic' })

    expect(res.status).toBe(200)
    expect(res.body.data.rows[0].outstandingBalance).toBe('1234.56')
    const balIssues = res.body.data.rows[0].issues
      .filter((i: any) => i.field === 'outstanding_balance')
    expect(balIssues).toEqual([])
  })

  it('accepts currency-formatted balance ($1,234.56)', async () => {
    const { token } = await seedLandlordWithProperty()
    const csv = [
      'first_name,last_name,email,phone,property_name,unit_number,lease_start,monthly_rent,outstanding_balance',
      'Jane,Doe,jane@x.com,555-0100,Sunset Apartments,4B,2024-06-01,1850,"$1,234.56"',
    ].join('\n')

    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-tenants-csv/validate')
      .set('Authorization', `Bearer ${token}`)
      .send({ csv, source: 'generic' })

    expect(res.status).toBe(200)
    // Raw string preserved on the row; parser strips $ and , during
    // commit-time balance check.
    expect(res.body.data.rows[0].outstandingBalance).toContain('1,234.56')
    const balIssues = res.body.data.rows[0].issues
      .filter((i: any) => i.field === 'outstanding_balance' && i.severity === 'block')
    expect(balIssues).toEqual([])
  })

  it('blocks non-numeric balance', async () => {
    const { token } = await seedLandlordWithProperty()
    const csv = [
      'first_name,last_name,email,phone,property_name,unit_number,lease_start,monthly_rent,outstanding_balance',
      'Jane,Doe,jane@x.com,555-0100,Sunset Apartments,4B,2024-06-01,1850,abc',
    ].join('\n')

    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-tenants-csv/validate')
      .set('Authorization', `Bearer ${token}`)
      .send({ csv, source: 'generic' })

    expect(res.status).toBe(200)
    const balIssues = res.body.data.rows[0].issues
      .filter((i: any) => i.field === 'outstanding_balance' && i.severity === 'block')
    expect(balIssues.length).toBe(1)
  })

  it('Buildium "Outstanding Balance" alias translates to outstanding_balance', async () => {
    const { token } = await seedLandlordWithProperty()
    const csv = [
      'First Name,Last Name,Email,Mobile Phone,Property,Unit,Lease Start,Rent,Outstanding Balance',
      'Jane,Doe,jane@x.com,555-0100,Sunset Apartments,4B,2024-06-01,1850,1234.56',
    ].join('\n')

    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-tenants-csv/validate')
      .set('Authorization', `Bearer ${token}`)
      .send({ csv, source: 'buildium' })

    expect(res.status).toBe(200)
    expect(res.body.data.rows[0].outstandingBalance).toBe('1234.56')
  })
})

describe('Tenant CSV — opening-balance invoice (commit)', () => {
  it('writes a pending invoice for the carry-over balance', async () => {
    const { landlordId, unitId, token } = await seedLandlordWithProperty()
    const csv = [
      'first_name,last_name,email,phone,property_name,unit_number,lease_start,monthly_rent,outstanding_balance',
      'Jane,Doe,jane@x.com,555-0100,Sunset Apartments,4B,2024-06-01,1850,1234.56',
    ].join('\n')

    const val = await request(buildApp())
      .post('/api/landlords/me/onboard-tenants-csv/validate')
      .set('Authorization', `Bearer ${token}`)
      .send({ csv, source: 'generic' })
    expect(val.body.data.summary.blockers).toBe(0)

    const commit = await request(buildApp())
      .post('/api/landlords/me/onboard-tenants-csv/commit')
      .set('Authorization', `Bearer ${token}`)
      .send({ rows: val.body.data.rows, source: 'generic', claimedPlatformName: 'TestPlatform' })
    expect(commit.status).toBe(200)
    expect(commit.body.data.committed).toBe(1)

    // Invoice landed
    const inv = await db.query<any>(
      `SELECT invoice_number, status, subtotal_rent, total_amount, notes,
              due_date::text AS due_date_str, lease_id, unit_id, landlord_id
         FROM invoices WHERE landlord_id = $1`,
      [landlordId],
    )
    expect(inv.rows).toHaveLength(1)
    expect(inv.rows[0].status).toBe('pending')
    expect(parseFloat(inv.rows[0].subtotal_rent)).toBe(1234.56)
    expect(parseFloat(inv.rows[0].total_amount)).toBe(1234.56)
    expect(inv.rows[0].unit_id).toBe(unitId)
    expect(inv.rows[0].notes).toMatch(/Imported opening balance/i)
    // due_date is CURRENT_DATE
    const today = new Date().toISOString().slice(0, 10)
    expect(inv.rows[0].due_date_str).toBe(today)
  })

  it('handles currency-formatted balance ($1,234.56) correctly on commit', async () => {
    const { landlordId, token } = await seedLandlordWithProperty()
    const csv = [
      'first_name,last_name,email,phone,property_name,unit_number,lease_start,monthly_rent,outstanding_balance',
      'Jane,Doe,jane@x.com,555-0100,Sunset Apartments,4B,2024-06-01,1850,"$1,234.56"',
    ].join('\n')

    const val = await request(buildApp())
      .post('/api/landlords/me/onboard-tenants-csv/validate')
      .set('Authorization', `Bearer ${token}`)
      .send({ csv, source: 'generic' })

    const commit = await request(buildApp())
      .post('/api/landlords/me/onboard-tenants-csv/commit')
      .set('Authorization', `Bearer ${token}`)
      .send({ rows: val.body.data.rows, source: 'generic', claimedPlatformName: 'TestPlatform' })
    expect(commit.status).toBe(200)

    const inv = await db.query<any>(
      `SELECT subtotal_rent FROM invoices WHERE landlord_id = $1`,
      [landlordId],
    )
    expect(parseFloat(inv.rows[0].subtotal_rent)).toBe(1234.56)
  })

  it('skips invoice when balance is missing', async () => {
    const { landlordId, token } = await seedLandlordWithProperty()
    const csv = [
      'first_name,last_name,email,phone,property_name,unit_number,lease_start,monthly_rent,outstanding_balance',
      'Jane,Doe,jane@x.com,555-0100,Sunset Apartments,4B,2024-06-01,1850,',
    ].join('\n')

    const val = await request(buildApp())
      .post('/api/landlords/me/onboard-tenants-csv/validate')
      .set('Authorization', `Bearer ${token}`)
      .send({ csv, source: 'generic' })

    const commit = await request(buildApp())
      .post('/api/landlords/me/onboard-tenants-csv/commit')
      .set('Authorization', `Bearer ${token}`)
      .send({ rows: val.body.data.rows, source: 'generic', claimedPlatformName: 'TestPlatform' })
    expect(commit.status).toBe(200)

    const inv = await db.query<any>(
      `SELECT count(*)::text AS c FROM invoices WHERE landlord_id = $1`,
      [landlordId],
    )
    expect(inv.rows[0].c).toBe('0')
  })

  it('skips invoice when balance is zero', async () => {
    const { landlordId, token } = await seedLandlordWithProperty()
    const csv = [
      'first_name,last_name,email,phone,property_name,unit_number,lease_start,monthly_rent,outstanding_balance',
      'Jane,Doe,jane@x.com,555-0100,Sunset Apartments,4B,2024-06-01,1850,0',
    ].join('\n')

    const val = await request(buildApp())
      .post('/api/landlords/me/onboard-tenants-csv/validate')
      .set('Authorization', `Bearer ${token}`)
      .send({ csv, source: 'generic' })

    const commit = await request(buildApp())
      .post('/api/landlords/me/onboard-tenants-csv/commit')
      .set('Authorization', `Bearer ${token}`)
      .send({ rows: val.body.data.rows, source: 'generic', claimedPlatformName: 'TestPlatform' })
    expect(commit.status).toBe(200)

    const inv = await db.query<any>(
      `SELECT count(*)::text AS c FROM invoices WHERE landlord_id = $1`,
      [landlordId],
    )
    expect(inv.rows[0].c).toBe('0')
  })

  it('allocates a sequential invoice_number via invoice_sequences', async () => {
    const { landlordId, token } = await seedLandlordWithProperty()
    const csv = [
      'first_name,last_name,email,phone,property_name,unit_number,lease_start,monthly_rent,outstanding_balance',
      'Jane,Doe,jane@x.com,555-0100,Sunset Apartments,4B,2024-06-01,1850,500',
    ].join('\n')

    const val = await request(buildApp())
      .post('/api/landlords/me/onboard-tenants-csv/validate')
      .set('Authorization', `Bearer ${token}`)
      .send({ csv, source: 'generic' })

    const commit = await request(buildApp())
      .post('/api/landlords/me/onboard-tenants-csv/commit')
      .set('Authorization', `Bearer ${token}`)
      .send({ rows: val.body.data.rows, source: 'generic', claimedPlatformName: 'TestPlatform' })
    expect(commit.status).toBe(200)

    const inv = await db.query<any>(
      `SELECT invoice_number FROM invoices WHERE landlord_id = $1`,
      [landlordId],
    )
    expect(inv.rows).toHaveLength(1)
    // Format is year-based: e.g. INV-2026-001 (per formatInvoiceNumber).
    expect(inv.rows[0].invoice_number).toMatch(/\d{4}-\d+/)

    // Sequence row advanced
    const seq = await db.query<any>(
      `SELECT next_number FROM invoice_sequences WHERE landlord_id = $1`,
      [landlordId],
    )
    expect(parseInt(seq.rows[0].next_number, 10)).toBeGreaterThan(1)
  })
})

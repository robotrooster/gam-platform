/**
 * Tenant CSV — outstanding_balance (S29X / Phase A; S655 draft roster).
 *
 * Covers:
 *   - Validate parses outstanding_balance with currency formatting
 *     (e.g. "$1,234.56") and blocks a value that isn't a number.
 *   - S655 (decisions 10/2): saving the draft roster KEEPS the household's
 *     old balance on the roster and bills NOTHING yet — there is no lease to
 *     bill until the landlord signs. It posts as one charge when the lease
 *     issues (esign-own-signature.test.ts covers that moment).
 *   - Zero and missing balances keep nothing; a credit is noted, not carried.
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
  // S537: tenant-CSV commit gates on a late-fee DECISION per
  // (property, unit_type) — seed an explicit no-fee decision so these
  // opening-balance tests exercise the invoice path, not the gate.
  await db.query(
    `INSERT INTO property_unit_type_late_fees (property_id, unit_type, no_late_fee)
     VALUES ($1, 'apartment', TRUE) ON CONFLICT DO NOTHING`,
    [propertyId],
  )
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

describe('Tenant CSV — the old balance rides on the draft roster, billed nothing yet', () => {
  const draft = (token: string, balance: string) => request(buildApp())
    .post('/api/landlords/me/onboard-tenants-csv/draft')
    .set('Authorization', `Bearer ${token}`)
    .send({
      source: 'generic', claimedPlatformName: 'TestPlatform',
      csv: [
        'first_name,last_name,email,phone,property_name,unit_number,lease_start,monthly_rent,outstanding_balance',
        `Jane,Doe,jane@x.com,555-0100,Sunset Apartments,4B,2024-06-01,1850,${balance}`,
      ].join('\n'),
    })
  const rosterBalance = async (landlordId: string) => (await db.query(
    `SELECT opening_balance::float AS b FROM tenant_roster_drafts WHERE landlord_id = $1`, [landlordId])).rows[0]?.b ?? null

  it('keeps a plain balance on the household and writes no invoice', async () => {
    const { token, landlordId } = await seedLandlordWithProperty()
    const res = await draft(token, '1234.56')
    expect(res.status).toBe(200)
    expect(await rosterBalance(landlordId)).toBe(1234.56)
    expect((await db.query(`SELECT id FROM invoices WHERE landlord_id = $1`, [landlordId])).rows).toEqual([])
    expect(sendOnboardMock).not.toHaveBeenCalled()
  })

  it('reads a currency-formatted balance ($1,234.56)', async () => {
    const { token, landlordId } = await seedLandlordWithProperty()
    await draft(token, '"$1,234.56"')
    expect(await rosterBalance(landlordId)).toBe(1234.56)
  })

  it('keeps nothing for a missing or zero balance', async () => {
    const a = await seedLandlordWithProperty()
    await draft(a.token, '')
    expect(await rosterBalance(a.landlordId)).toBeNull()
    await cleanupAllSchema()
    const b = await seedLandlordWithProperty()
    await draft(b.token, '0')
    expect(await rosterBalance(b.landlordId)).toBeNull()
  })

  it('a credit on the old system is noted and not carried as a charge', async () => {
    const { token, landlordId } = await seedLandlordWithProperty()
    const v = await request(buildApp())
      .post('/api/landlords/me/onboard-tenants-csv/validate')
      .set('Authorization', `Bearer ${token}`)
      .send({ source: 'generic', csv: [
        'first_name,last_name,email,phone,property_name,unit_number,outstanding_balance',
        'Jane,Doe,jane@x.com,555-0100,Sunset Apartments,4B,-40',
      ].join('\n') })
    const note = v.body.data.rows[0].issues.find((i: any) => i.field === 'outstanding_balance')
    expect(note.severity).toBe('warn')
    expect(note.message).toMatch(/credit of \$40/)
    await draft(token, '-40')
    expect(await rosterBalance(landlordId)).toBeNull()
  })
})

/**
 * 10/12 (Nic) — GAM Books ledger, phase P3: the admin's read-only view.
 *
 * The ledger is DARK: no landlord or bookkeeper screen reads it. GAM's
 * super_admin can look inside (routes/admin/ledger.ts) — status, postings with
 * their lines, a trial balance, the chart and its map, closes. Nothing there
 * posts, rebuilds, closes or repoints; anyone else gets 403.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema } from '../test/dbHelpers'
import { ledgerCompany, addOtherIncome } from '../test/ledgerFixtures'
import { adminLedgerRouter } from './admin/ledger'
import { errorHandler } from '../middleware/errorHandler'
import { drainLedgerOutbox, registerLedgerProjector, unregisterLedgerProjector, registeredLedgerSourceTypes } from '../services/ledgerEngine'
import { otherIncomeTestProjector } from '../services/ledgerTestProjector'

const app = express()
app.use(express.json())
app.use('/api/admin', adminLedgerRouter)
app.use(errorHandler)

const sign = (id: string, role: string) => jwt.sign(
  { userId: id, role, email: `${role}@test.dev`, profileId: id, permissions: {} }, process.env.JWT_SECRET!, { expiresIn: '1h' })

async function user(role: string): Promise<string> {
  return (await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified) VALUES ($1, 'x', $2, 'A', 'B', TRUE) RETURNING id`,
    [`${role}-${randomUUID()}@test.dev`, role])).rows[0].id
}

beforeEach(async () => {
  await cleanupAllSchema()
  registerLedgerProjector(otherIncomeTestProjector)
})
afterEach(() => {
  for (const t of registeredLedgerSourceTypes()) unregisterLedgerProjector(t)
})

describe('GET /api/admin/ledger/*', () => {
  it('is super_admin only', async () => {
    const co = await ledgerCompany()
    const admin = sign(await user('admin'), 'admin')
    const landlord = sign(co.ownerUserId, 'landlord')
    for (const t of [admin, landlord]) {
      const r = await request(app).get('/api/admin/ledger/status').set('Authorization', `Bearer ${t}`)
      expect(r.status).toBe(403)
    }
    expect((await request(app).get('/api/admin/ledger/status')).status).toBe(401)
  })

  it('shows what can post, what waits, postings with their lines, a balanced trial balance, the chart and the closes', async () => {
    const co = await ledgerCompany()
    const su = sign(await user('super_admin'), 'super_admin')
    const get = (path: string) => request(app).get(`/api/admin/ledger${path}`).set('Authorization', `Bearer ${su}`)
    const id = await addOtherIncome(co, { amount: 80, day: '2026-09-15' })

    const s1 = await get('/status')
    expect(s1.status).toBe(200)
    expect(s1.body.data.registeredSourceTypes).toEqual(['other_income'])
    expect(s1.body.data.outbox).toEqual([expect.objectContaining({ source_type: 'other_income', rows: 1, sources: 1 })])

    await drainLedgerOutbox()
    await db.query(`UPDATE landlord_other_income SET amount = 90 WHERE id = $1`, [id])
    await drainLedgerOutbox()

    const active = await get(`/landlords/${co.landlordId}/postings?sourceType=other_income&sourceId=${id}`)
    expect(active.status).toBe(200)
    expect(active.body.data).toHaveLength(1)
    expect(active.body.data[0].lines.map((l: any) => [l.account_code, l.debit, l.credit]))
      .toEqual([['1099', '90.00', '0.00'], ['4900', '0.00', '90.00']])
    const all = await get(`/landlords/${co.landlordId}/postings?includeSuperseded=true`)
    expect(all.body.data.map((p: any) => p.role).sort()).toEqual(['post', 'post', 'reversal'])

    const tb = await get(`/landlords/${co.landlordId}/trial-balance?byProperty=true`)
    expect(tb.status).toBe(200)
    expect(tb.body.data.totals.debits).toBe(tb.body.data.totals.credits)
    expect(tb.body.data.rows.find((r: any) => r.code === '4900')).toMatchObject({ balance_dr_minus_cr: '-90.00', property_id: co.propertyId })
    const asOf = await get(`/landlords/${co.landlordId}/trial-balance?asOf=2026-08-31`)
    expect(asOf.body.data.rows).toEqual([])

    const chart = await get(`/landlords/${co.landlordId}/chart`)
    expect(chart.body.data.map.find((m: any) => m.kind === 'role' && m.value === 'other_income')).toBeTruthy()
    expect(chart.body.data.accounts.length).toBeGreaterThan(80)

    const closes = await get(`/landlords/${co.landlordId}/closes`)
    expect(closes.body.data).toMatchObject({ settings: { closeBy: 'owner_or_bookkeeper', reopenBy: 'owner', openMonthFixes: 'restate', closedThrough: null }, history: [] })

    expect((await get('/landlords/not-a-uuid/postings')).status).toBe(400)
    expect((await get(`/landlords/${co.landlordId}/trial-balance?asOf=9/1/2026`)).status).toBe(400)
    expect((await get(`/landlords/${randomUUID()}/closes`)).status).toBe(404)

    // Read-only: nothing it served changed the ledger.
    const n = (await db.query(`SELECT count(*)::int AS n FROM ledger_postings`)).rows[0].n
    await get('/status')
    expect((await db.query(`SELECT count(*)::int AS n FROM ledger_postings`)).rows[0].n).toBe(n)
  })
})

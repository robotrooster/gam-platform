/**
 * S634 — THE OUTSTANDING BALANCE HAS TO BE EXPLAINABLE.
 *
 * Nic (DIRECTIVE): "From the landlord page, these outstanding balances need to
 * be clickable so I can get into the invoice and actually view it. There's no
 * way for me to see what the breakdown of charges is, and as a landlord, you
 * need to be able to explain that to a tenant."
 *
 * The list gave a number and nothing behind it. A resident at the counter asking
 * "what's this $217?" left the landlord with no answer the product could give,
 * which is the one moment the number had to mean something.
 *
 * What these pin: the lines come back, the NOTE on each line comes back (that is
 * the sentence the landlord repeats — meter reads, the cycle a late utility
 * belongs to), and the same scope rules as the list itself hold, so this cannot
 * become a way to read another landlord's ledger.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import request from 'supertest'
import express from 'express'
import jwt from 'jsonwebtoken'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedLease } from '../test/dbHelpers'
import { balancesRouter } from './balances'
import { errorHandler } from '../middleware/errorHandler'

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/balances', balancesRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => { await cleanupAllSchema() })

/** A tenant with one open invoice: rent + a late-arriving utility line. */
async function seedOwedTenant() {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const ll = await seedLandlord(c)
    const propertyId = await seedProperty(c, {
      landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
    const unitId = await seedUnit(c, { propertyId, landlordId: ll.landlordId })
    const tu = await c.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1,'x','tenant','Pat','Resident',TRUE) RETURNING id`,
      [`t-${Date.now()}-${Math.floor(Math.random() * 1e6)}@t.dev`])
    const t = await c.query<{ id: string }>(
      `INSERT INTO tenants (user_id) VALUES ($1) RETURNING id`, [tu.rows[0].id])
    const tenantId = t.rows[0].id
    const leaseId = await seedLease(c, { unitId, landlordId: ll.landlordId, rentAmount: 440 })

    const inv = await c.query<{ id: string }>(
      `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number,
                             due_date, subtotal_rent, subtotal_utilities, total_amount, status)
       VALUES ($1,$2,$3,$4,'INV-TEST-0001','2026-09-01',440,176.40,616.40,'pending')
       RETURNING id`,
      [ll.landlordId, tenantId, leaseId, unitId])
    const invoiceId = inv.rows[0].id

    await c.query(
      `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id,
                             type, amount, status, due_date, entry_description, notes)
       VALUES ($1,$2,$3,$4,$5,'rent',440,'pending','2026-09-01','RENT',NULL)`,
      [invoiceId, unitId, leaseId, tenantId, ll.landlordId])
    await c.query(
      `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id,
                             type, amount, status, due_date, entry_description, notes)
       VALUES ($1,$2,$3,$4,$5,'utility',176.40,'pending','2026-09-01','UTILITY',$6)`,
      [invoiceId, unitId, leaseId, tenantId, ll.landlordId,
       'Electric — Aug 2026 (used before the lease was signed)'])
    await c.query('COMMIT')
    return { ...ll, tenantId, unitId, invoiceId }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

const tokenFor = (userId: string, landlordId: string) => jwt.sign(
  // S633: a landlord session names no entity.
  { userId, role: 'landlord', email: 'll@t.dev', profileId: null,
    landlordIds: [landlordId], permissions: {} },
  process.env.JWT_SECRET!, { expiresIn: '10m' })

describe('GET /api/balances — the list', () => {
  it('shows what the tenant owes, counting every open invoice', async () => {
    const f = await seedOwedTenant()
    const res = await request(buildApp()).get('/api/balances')
      .set('Authorization', `Bearer ${tokenFor(f.userId, f.landlordId)}`)
    expect(res.status).toBe(200)
    const row = res.body.data.find((r: any) => r.tenant_id === f.tenantId || r.tenantId === f.tenantId)
    expect(row).toBeTruthy()
    expect(Number(row.balance)).toBe(616.40)
  })
})

describe('S634 GET /api/balances/:tenantId/invoices — the breakdown', () => {
  it('returns every line, with the note that explains it', async () => {
    const f = await seedOwedTenant()
    const res = await request(buildApp()).get(`/api/balances/${f.tenantId}/invoices`)
      .set('Authorization', `Bearer ${tokenFor(f.userId, f.landlordId)}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)

    const inv = res.body.data[0]
    expect(Number(inv.balance ?? inv.balance)).toBe(616.40)
    expect(inv.lines).toHaveLength(2)

    const utility = inv.lines.find((l: any) => l.type === 'utility')
    expect(Number(utility.amount)).toBe(176.40)
    // THE POINT: the note survives the round trip. Without it the landlord has
    // a number again, which is what they already had.
    expect(utility.notes).toMatch(/Electric/)
    expect(utility.notes).toMatch(/Aug 2026/)

    const rent = inv.lines.find((l: any) => l.type === 'rent')
    expect(Number(rent.amount)).toBe(440)
  })

  it("never returns another landlord's invoices", async () => {
    const f = await seedOwedTenant()
    const c = await db.connect()
    let stranger: { userId: string; landlordId: string }
    try { stranger = await seedLandlord(c) } finally { c.release() }

    const res = await request(buildApp()).get(`/api/balances/${f.tenantId}/invoices`)
      .set('Authorization', `Bearer ${tokenFor(stranger!.userId, stranger!.landlordId)}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual([])
  })

  it('returns an empty list for a tenant who owes nothing, not an error', async () => {
    const f = await seedOwedTenant()
    await db.query(`UPDATE invoices SET status = 'settled' WHERE id = $1`, [f.invoiceId])
    const res = await request(buildApp()).get(`/api/balances/${f.tenantId}/invoices`)
      .set('Authorization', `Bearer ${tokenFor(f.userId, f.landlordId)}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual([])
  })
})

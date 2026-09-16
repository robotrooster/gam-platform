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

// S648 (Nic): "every dollar should only be counted once. Everywhere." Billy
// Jose Miranda rents two spaces and showed as two people; a $100 credit came
// off both of them.
describe('S648 GET /api/balances — one line per person', () => {
  it('merges a second space and takes a general credit off only once', async () => {
    const f = await seedOwedTenant()                      // 616.40 on space one
    const c = await db.connect()
    try {
      const propertyId = (await c.query(`SELECT property_id FROM units WHERE id=$1`, [f.unitId])).rows[0].property_id
      const unit2 = await seedUnit(c, { propertyId, landlordId: f.landlordId })
      const lease2 = await seedLease(c, { unitId: unit2, landlordId: f.landlordId, rentAmount: 220 })
      await c.query(
        `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number,
                               due_date, subtotal_rent, total_amount, status)
         VALUES ($1,$2,$3,$4,'INV-TEST-0002','2026-09-01',220,220,'pending')`,
        [f.landlordId, f.tenantId, lease2, unit2])
      await c.query(
        `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining,
                                     category, reason, status, created_by)
         VALUES ($1,$2,NULL,100,100,'goodwill','test','active',$3)`,
        [f.landlordId, f.tenantId, f.userId])
    } finally { c.release() }

    const res = await request(buildApp()).get('/api/balances')
      .set('Authorization', `Bearer ${tokenFor(f.userId, f.landlordId)}`)
    expect(res.status).toBe(200)
    const rows = res.body.data.filter((r: any) => (r.tenant_id ?? r.tenantId) === f.tenantId)
    expect(rows).toHaveLength(1)
    expect(Number(rows[0].balance)).toBe(736.40)          // 616.40 + 220 − 100, once
    expect(rows[0].spaces).toHaveLength(2)
    const credited = rows[0].spaces.reduce((s: number, x: any) => s + Number(x.credit_applied ?? x.creditApplied), 0)
    expect(credited).toBe(100)
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

// ─── S637: an in-flight ACH is not an outstanding balance ────────────────────
//
// Nic: "I thought we decided that it was gonna be marked settled or paid in the
// system, or at least not outstanding, at the time the attempt is made to pay...
// I'm just trying to narrow down my outstanding balance list, and I'm unable to
// do that because he did an ACH payment."
//
// An ACH debit sits 'processing' for about four business days. Counting it as
// owed the whole time meant the list could never be worked to zero and Randall
// Cox — who had paid $520.20 — read as delinquent for days.
describe('S637 outstanding excludes money in flight', () => {
  const balanceFor = async (f: any) => {
    const res = await request(buildApp()).get('/api/balances')
      .set('Authorization', `Bearer ${tokenFor(f.userId, f.landlordId)}`)
    expect(res.status).toBe(200)
    const row = res.body.data.find((r: any) => (r.tenant_id ?? r.tenantId) === f.tenantId)
    return row ? Number(row.balance) : 0
  }

  it('a processing payment nets off the balance', async () => {
    const f = await seedOwedTenant()
    const owed = await balanceFor(f)
    expect(owed).toBe(616.40)

    await db.query(
      `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id,
                             type, amount, status, due_date, entry_description)
       VALUES ($1,$2,(SELECT lease_id FROM invoices WHERE id=$1),$3,$4,
               'rent', $5, 'processing', CURRENT_DATE, 'RENT')`,
      [f.invoiceId, f.unitId, f.tenantId, f.landlordId, owed])

    expect(await balanceFor(f)).toBe(0)
  })

  // A failure is not silent: the row flips to 'failed' and the debt returns.
  it('a failed payment leaves the balance owed', async () => {
    const f = await seedOwedTenant()
    const owed = await balanceFor(f)
    await db.query(
      `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id,
                             type, amount, status, due_date, entry_description)
       VALUES ($1,$2,(SELECT lease_id FROM invoices WHERE id=$1),$3,$4,
               'rent', $5, 'failed', CURRENT_DATE, 'RENT')`,
      [f.invoiceId, f.unitId, f.tenantId, f.landlordId, owed])

    expect(await balanceFor(f)).toBe(owed)
  })
})

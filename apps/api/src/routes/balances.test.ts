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
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedLease, seedUtilityMeter, seedUtilityBill } from '../test/dbHelpers'
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
// S655 (Nic, 10/2): "landlord screens show the full balance with 'credit
// available $X' beside it" — the credit is counted once, and never taken off.
describe('S648 GET /api/balances — one line per person', () => {
  it('merges a second space; a general credit sits beside the full balance, counted once', async () => {
    const f = await seedOwedTenant()                      // 616.40 on space one
    const c = await db.connect()
    try {
      const propertyId = (await c.query(`SELECT property_id FROM units WHERE id=$1`, [f.unitId])).rows[0].property_id
      const unit2 = await seedUnit(c, { propertyId, landlordId: f.landlordId })
      const lease2 = await seedLease(c, { unitId: unit2, landlordId: f.landlordId, rentAmount: 220 })
      const inv2 = await c.query<{ id: string }>(
        `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number,
                               due_date, subtotal_rent, total_amount, status)
         VALUES ($1,$2,$3,$4,'INV-TEST-0002','2026-09-01',220,220,'pending') RETURNING id`,
        [f.landlordId, f.tenantId, lease2, unit2])
      await c.query(
        `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id,
                               type, amount, status, due_date, entry_description)
         VALUES ($1,$2,$3,$4,$5,'rent',220,'pending','2026-09-01','RENT')`,
        [inv2.rows[0].id, unit2, lease2, f.tenantId, f.landlordId])
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
    expect(Number(rows[0].balance)).toBe(836.40)          // 616.40 + 220, nothing taken off
    expect(rows[0].credit_available).toBe(100)            // beside it, once
    expect(rows[0].spaces).toHaveLength(2)
    expect(rows[0].spaces.reduce((s: number, x: any) => s + Number(x.credit_available), 0)).toBe(100)
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
    await db.query(`UPDATE payments SET status = 'settled', settled_at = NOW() WHERE invoice_id = $1`, [f.invoiceId])
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

  // A payment in flight carries the charges it pays: they go 'processing' with
  // the intent on them (rentCharge), so they are not owed while it clears.
  it('a processing payment takes its charges off the balance', async () => {
    const f = await seedOwedTenant()
    const owed = await balanceFor(f)
    expect(owed).toBe(616.40)
    await db.query(
      `UPDATE payments SET status = 'processing', stripe_payment_intent_id = 'pi_s637_flight'
        WHERE invoice_id = $1`, [f.invoiceId])
    expect(await balanceFor(f)).toBe(0)
  })

  // A failure is not silent: the rows flip to 'failed' and the debt returns.
  it('a failed payment leaves the balance owed', async () => {
    const f = await seedOwedTenant()
    const owed = await balanceFor(f)
    await db.query(
      `UPDATE payments SET status = 'failed', stripe_payment_intent_id = 'pi_s637_failed'
        WHERE invoice_id = $1`, [f.invoiceId])
    expect(await balanceFor(f)).toBe(owed)
  })
})

// S649 (Nic): "make sure POS pay links and outstanding tickets show in
// outstanding. That way we can follow through on collecting."
describe('open pay links are outstanding', () => {
  it('lists an emailed pay link as its own line, and drops it once paid; a QR sign never shows', async () => {
    const f = await seedOwedTenant()
    const prop = (await db.query<{ property_id: string }>(`SELECT property_id FROM units WHERE id = $1`, [f.unitId])).rows[0].property_id
    const mk = (kind: string, email: string | null) => db.query<{ id: string }>(
      `INSERT INTO pos_pay_links (token, landlord_id, property_id, created_by, kind, label, items, subtotal, total, customer_name, customer_email)
       VALUES (md5(random()::text) || md5(random()::text), $1, $2, $3, $4, 'Move-out', $5::jsonb, 670.27, 670.27, 'Andres Razo', $6) RETURNING id`,
      [f.landlordId, prop, f.userId, kind, JSON.stringify([{ name: 'RV site — monthly', qty: 1, price: 589 }, { name: 'Electric (per kWh)', qty: 387, price: 0.21 }]), email])
    const link = (await mk('one_time', 'razo@example.com')).rows[0].id
    await mk('standing', null)
    const get = () => request(buildApp()).get('/api/balances').set('Authorization', `Bearer ${tokenFor(f.userId, f.landlordId)}`)
    let rows = (await get()).body.data
    const row = rows.find((r: any) => r.pay_link_id === link)
    expect(row).toMatchObject({ first_name: 'Andres', last_name: 'Razo', email: 'razo@example.com', balance: '670.27' })
    expect(rows.filter((r: any) => r.pay_link_id)).toHaveLength(1)
    // The tenant's own ledger line is untouched by it.
    expect(Number(rows.find((r: any) => r.tenant_id === f.tenantId).balance)).toBe(616.40)
    await db.query(`UPDATE pos_pay_links SET status = 'paid', paid_at = NOW() WHERE id = $1`, [link])
    rows = (await get()).body.data
    expect(rows.find((r: any) => r.pay_link_id === link)).toBeUndefined()
  })

  // S652 (Nic): "Open tickets should reflect as items to do in the front desk
  // list as well, so they don't get forgotten."
  it('lists an open register ticket as its own line, and drops it once settled', async () => {
    const f = await seedOwedTenant()
    const prop = (await db.query<{ property_id: string }>(`SELECT property_id FROM units WHERE id = $1`, [f.unitId])).rows[0].property_id
    const t = (await db.query<{ id: string }>(
      `INSERT INTO pos_open_tickets (landlord_id, property_id, created_by, tenant_id, items, note)
       VALUES ($1, $2, $3, $4, $5::jsonb, 'September electric on RV 30') RETURNING id`,
      [f.landlordId, prop, f.userId, f.tenantId, JSON.stringify([{ name: 'Electric (per kWh)', qty: 107, price: 0.21, tax: 0 }])])).rows[0].id
    const get = () => request(buildApp()).get('/api/balances').set('Authorization', `Bearer ${tokenFor(f.userId, f.landlordId)}`)
    let rows = (await get()).body.data
    const row = rows.find((r: any) => r.ticket_id === t)
    expect(row).toMatchObject({ tenant_id: f.tenantId, balance: '22.47' })
    expect(row.ticket.note).toBe('September electric on RV 30')
    // The tenant's own ledger line is untouched by it.
    expect(Number(rows.find((r: any) => r.tenant_id === f.tenantId && !r.ticket_id).balance)).toBe(616.40)
    await db.query(`UPDATE pos_open_tickets SET status = 'settled', settled_at = NOW() WHERE id = $1`, [t])
    rows = (await get()).body.data
    expect(rows.find((r: any) => r.ticket_id === t)).toBeUndefined()
  })
})

// S654: a suspended work-trade line is written OUTSIDE total_amount (the S634
// shape). Netting it again here drove RV 50 / RV 51 to -$589 and hid two
// October bills behind their September.
describe('S654 GET /api/balances — suspended lines are outside the total', () => {
  it('a partly covered bill owes exactly its uncovered line, never less', async () => {
    const f = await seedOwedTenant()                      // rent 440 + electric 176.40
    await db.query(
      `UPDATE payments SET work_trade_suspended_at = NOW(),
              notes = 'Work trade — suspended while the hours are worked; settled at month close'
        WHERE invoice_id=$1 AND type='rent'`, [f.invoiceId])
    await db.query(`UPDATE invoices SET total_amount = 176.40 WHERE id=$1`, [f.invoiceId])

    const res = await request(buildApp()).get('/api/balances')
      .set('Authorization', `Bearer ${tokenFor(f.userId, f.landlordId)}`)
    expect(res.status).toBe(200)
    const row = res.body.data.find((r: any) => r.tenant_id === f.tenantId || r.tenantId === f.tenantId)
    expect(row).toBeTruthy()
    expect(Number(row.balance)).toBe(176.40)
  })

  it('a fully covered month owes nothing — not a negative number', async () => {
    const f = await seedOwedTenant()
    await db.query(`UPDATE payments SET work_trade_suspended_at = NOW() WHERE invoice_id=$1`, [f.invoiceId])
    await db.query(`UPDATE invoices SET total_amount = 0 WHERE id=$1`, [f.invoiceId])

    const res = await request(buildApp()).get('/api/balances')
      .set('Authorization', `Bearer ${tokenFor(f.userId, f.landlordId)}`)
    expect(res.status).toBe(200)
    const row = res.body.data.find((r: any) => r.tenant_id === f.tenantId || r.tenantId === f.tenantId)
    expect(!row || Number(row.balance) === 0).toBe(true)
  })
})

// ─── S655 (money plan, Step 11): the breakdown explains the list's own number ─
describe('S655 GET /api/balances/:tenantId/invoices — each line by name', () => {
  async function trashLine(f: Awaited<ReturnType<typeof seedOwedTenant>>, note: string | null) {
    const c = await db.connect()
    try {
      const { rows: [u] } = await c.query<{ property_id: string; lease_id: string }>(
        `SELECT u.property_id, i.lease_id FROM units u JOIN invoices i ON i.unit_id = u.id WHERE i.id = $1`, [f.invoiceId])
      const { rows: [p] } = await c.query<{ id: string }>(
        `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id,
                               type, amount, status, due_date, entry_description, notes)
         VALUES ($1,$2,$3,$4,$5,'utility',25,'pending','2026-09-01','UTILITY',$6) RETURNING id`,
        [f.invoiceId, f.unitId, u.lease_id, f.tenantId, f.landlordId, note])
      const meterId = await seedUtilityMeter(c, { propertyId: u.property_id, utilityType: 'trash' })
      await seedUtilityBill(c, {
        meterId, unitId: f.unitId, tenantId: f.tenantId, leaseId: u.lease_id, landlordId: f.landlordId,
        chargeAmount: 25, paymentId: p.id, utilityType: 'trash' })
      return p.id
    } finally { c.release() }
  }
  const breakdown = async (f: any, token?: string) => {
    const res = await request(buildApp()).get(`/api/balances/${f.tenantId}/invoices`)
      .set('Authorization', `Bearer ${token ?? tokenFor(f.userId, f.landlordId)}`)
    expect(res.status).toBe(200)
    return res.body.data
  }

  it('names the utility from its bill, never "Utilities", and never from a payment note', async () => {
    const f = await seedOwedTenant()
    await trashLine(f, 'Recorded as manual money_order payment (ref 55187081609)')
    const [inv] = await breakdown(f)
    const labels = inv.lines.map((l: any) => l.label).sort()
    expect(labels).toEqual(['Electric', 'Rent', 'Trash'])
    expect(labels).not.toContain('Utilities')
    const trash = inv.lines.find((l: any) => l.label === 'Trash')
    expect(trash.detail).toBeNull()                       // the money-order tag is never the name or the detail
    const electric = inv.lines.find((l: any) => l.label === 'Electric')
    expect(electric.detail).toBe('Aug 2026 (used before the lease was signed)')
  })

  it('a late fee and a charge on no bill are in the breakdown, and it adds up to the list', async () => {
    const f = await seedOwedTenant()
    const leaseId = (await db.query(`SELECT lease_id FROM invoices WHERE id=$1`, [f.invoiceId])).rows[0].lease_id
    await db.query(
      `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
       VALUES ($1,$2,$3,$4,$5,'late_fee',15,'pending','2026-09-07','LATEFEE')`,
      [f.invoiceId, f.unitId, leaseId, f.tenantId, f.landlordId])
    await db.query(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, notes)
       VALUES ($1,$2,$3,'fee',35,'pending','2026-09-20','OTHERFEE','Dump station')`,
      [f.unitId, f.tenantId, f.landlordId])
    const list = await request(buildApp()).get('/api/balances')
      .set('Authorization', `Bearer ${tokenFor(f.userId, f.landlordId)}`)
    const row = list.body.data.find((r: any) => r.tenant_id === f.tenantId)
    expect(Number(row.balance)).toBe(666.40)
    const bills = await breakdown(f)
    expect(bills).toHaveLength(2)
    const [inv, loose] = bills
    expect(Number(inv.balance)).toBe(631.40)
    expect(inv.lines.find((l: any) => l.type === 'late_fee').label).toBe('Late fee')
    expect(loose.invoice_number).toBe('Not on a bill')
    expect(loose.lines.map((l: any) => l.label)).toEqual(['Dump station'])
    expect(bills.reduce((s: number, b: any) => s + Number(b.balance), 0)).toBeCloseTo(666.40, 2)
  })

  it('staff who may not see work trade never get a work-trade line, and the number is the same', async () => {
    const f = await seedOwedTenant()
    await db.query(
      `UPDATE payments SET work_trade_suspended_at = NOW(),
              notes = 'Work trade — suspended while the hours are worked; settled at month close'
        WHERE invoice_id = $1 AND type = 'rent'`, [f.invoiceId])
    const staff = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1,'x','onsite_manager','Desk','Clerk',TRUE) RETURNING id`, [`desk-${Date.now()}@t.dev`])
    await db.query(
      `INSERT INTO onsite_manager_scopes (user_id, landlord_id, all_properties) VALUES ($1,$2,TRUE)`,
      [staff.rows[0].id, f.landlordId])
    const deskToken = jwt.sign(
      { userId: staff.rows[0].id, role: 'onsite_manager', email: 'desk@t.dev', profileId: null,
        landlordId: f.landlordId, permissions: { 'balances.view': true } },
      process.env.JWT_SECRET!, { expiresIn: '10m' })
    const [deskView] = await breakdown(f, deskToken)
    expect(deskView.lines.map((l: any) => l.type)).toEqual(['utility'])
    expect(JSON.stringify(deskView)).not.toMatch(/Work trade/i)
    expect(Number(deskView.balance)).toBe(176.40)
    const [ownerView] = await breakdown(f)
    expect(ownerView.lines.map((l: any) => l.type).sort()).toEqual(['rent', 'utility'])
    expect(Number(ownerView.balance)).toBe(176.40)
  })
})

// decisions #10: a former resident's contact is not the company's to read.
describe('S655 open register tickets show the contact this company may see', () => {
  async function ticketFor(f: any) {
    const prop = (await db.query<{ property_id: string }>(`SELECT property_id FROM units WHERE id = $1`, [f.unitId])).rows[0].property_id
    await db.query(
      `INSERT INTO pos_customers (landlord_id, first_name, last_name, email, phone, tenant_id)
       VALUES ($1,'Pat','Resident','pat.record@gam.test','6025550100',$2)`, [f.landlordId, f.tenantId])
    const t = (await db.query<{ id: string }>(
      `INSERT INTO pos_open_tickets (landlord_id, property_id, created_by, tenant_id, items, note)
       VALUES ($1, $2, $3, $4, $5::jsonb, 'Last electric') RETURNING id`,
      [f.landlordId, prop, f.userId, f.tenantId, JSON.stringify([{ name: 'Electric (per kWh)', qty: 100, price: 0.21, tax: 0 }])])).rows[0].id
    const res = await request(buildApp()).get('/api/balances').set('Authorization', `Bearer ${tokenFor(f.userId, f.landlordId)}`)
    return res.body.data.find((r: any) => r.ticket_id === t)
  }
  const liveEmail = async (f: any) => (await db.query<{ email: string }>(
    `SELECT u.email FROM tenants t JOIN users u ON u.id = t.user_id WHERE t.id = $1`, [f.tenantId])).rows[0].email

  it('while they live here: their own account contact', async () => {
    const f = await seedOwedTenant()
    const leaseId = (await db.query(`SELECT lease_id FROM invoices WHERE id=$1`, [f.invoiceId])).rows[0].lease_id
    await db.query(`INSERT INTO lease_tenants (lease_id, tenant_id, role, status) VALUES ($1,$2,'primary','active')`, [leaseId, f.tenantId])
    const row = await ticketFor(f)
    expect(row.email).toBe(await liveEmail(f))
  })

  it('after they left: only what this company\'s register record holds, never the live account', async () => {
    const f = await seedOwedTenant()
    const leaseId = (await db.query(`SELECT lease_id FROM invoices WHERE id=$1`, [f.invoiceId])).rows[0].lease_id
    await db.query(`INSERT INTO lease_tenants (lease_id, tenant_id, role, status, removed_at) VALUES ($1,$2,'primary','removed',NOW())`, [leaseId, f.tenantId])
    await db.query(`UPDATE leases SET status = 'expired' WHERE id = $1`, [leaseId])
    const row = await ticketFor(f)
    expect(row.email).toBe('pat.record@gam.test')
    expect(row.phone).toBe('6025550100')
    expect(row.email).not.toBe(await liveEmail(f))
    expect(row.first_name).toBe('Pat')
  })
})

/** A team member of this company with these permissions, scoped to every property. */
async function teamToken(f: { landlordId: string }, role: 'property_manager' | 'onsite_manager', permissions: Record<string, boolean>) {
  const u = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1,'x',$2,'Team','Member',TRUE) RETURNING id`,
    [`${role}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@t.dev`, role])
  const table = role === 'property_manager' ? 'property_manager_scopes' : 'onsite_manager_scopes'
  await db.query(`INSERT INTO ${table} (user_id, landlord_id, all_properties) VALUES ($1,$2,TRUE)`, [u.rows[0].id, f.landlordId])
  return jwt.sign({ userId: u.rows[0].id, role, email: 'team@t.dev', profileId: null, landlordId: f.landlordId, permissions },
    process.env.JWT_SECRET!, { expiresIn: '10m' })
}

// decisions #25 (Nic, 10/3): "front desk / on-site staff never see a GRAND
// TOTAL of what everyone owes. Only account owners and property managers see
// grand totals (omitted server-side for everyone else, not just hidden)."
describe('decisions #25 the grand total of what everyone owes', () => {
  it('an account owner and a property manager get the totals', async () => {
    const f = await seedOwedTenant()
    const owner = await request(buildApp()).get('/api/balances').set('Authorization', `Bearer ${tokenFor(f.userId, f.landlordId)}`)
    expect(owner.status).toBe(200)
    expect(owner.body.meta.totals.owed).toBe(616.4)
    expect(owner.body.meta.totals.households).toBe(1)
    expect(owner.body.meta.totals.by_property).toHaveLength(1)
    const pm = await request(buildApp()).get('/api/balances')
      .set('Authorization', `Bearer ${await teamToken(f, 'property_manager', { 'balances.view': true })}`)
    expect(pm.status).toBe(200)
    expect(pm.body.meta.totals.owed).toBe(616.4)
  })

  it('front-desk staff get each person\'s balance and no total at all', async () => {
    const f = await seedOwedTenant()
    const desk = await request(buildApp()).get('/api/balances')
      .set('Authorization', `Bearer ${await teamToken(f, 'onsite_manager', { 'balances.view': true, 'payments.view_all': true })}`)
    expect(desk.status).toBe(200)
    expect(desk.body.meta).toBeUndefined()
    expect(JSON.stringify(desk.body)).not.toMatch(/"totals"/)
    const row = desk.body.data.find((r: any) => r.tenant_id === f.tenantId)
    expect(Number(row.balance)).toBe(616.4)
  })
})

// decisions #29: the Outstanding row carries every unpaid month, "Payment
// clearing", the "Work trade" mark and where Record payment opens.
describe('decisions #29 the Outstanding row, through the route', () => {
  it('every unpaid month, how late, and the charge Record payment opens on', async () => {
    const f = await seedOwedTenant()
    const res = await request(buildApp()).get('/api/balances').set('Authorization', `Bearer ${tokenFor(f.userId, f.landlordId)}`)
    const row = res.body.data.find((r: any) => r.tenant_id === f.tenantId)
    expect(row.months).toEqual([{ month: '2026-09', amount: 616.4 }])
    expect(row.status).toBe('owes')
    const rent = (await db.query<{ id: string }>(`SELECT id FROM payments WHERE invoice_id = $1 AND type = 'rent'`, [f.invoiceId])).rows[0].id
    expect(row.record_with).toEqual([{ landlord_id: f.landlordId, payment_id: rent }])
    expect(row.days_late).toBeGreaterThan(0)
  })

  it('a bill being paid by bank is on the list as "Payment clearing", owed nothing, not late', async () => {
    const f = await seedOwedTenant()
    await db.query(`UPDATE payments SET status = 'processing', stripe_payment_intent_id = 'pi_route_clear' WHERE invoice_id = $1`, [f.invoiceId])
    // The front desk's to-do list reads the same endpoint: nobody to chase.
    const todo = await request(buildApp()).get('/api/balances').set('Authorization', `Bearer ${tokenFor(f.userId, f.landlordId)}`)
    expect(todo.body.data.find((r: any) => r.tenant_id === f.tenantId)).toBeUndefined()
    // The Outstanding page asks for them.
    const res = await request(buildApp()).get('/api/balances?include=clearing').set('Authorization', `Bearer ${tokenFor(f.userId, f.landlordId)}`)
    const row = res.body.data.find((r: any) => r.tenant_id === f.tenantId)
    expect(row.status_label).toBe('Payment clearing')
    expect(Number(row.balance)).toBe(0)
    expect(row.clearing).toBe(616.4)
    expect(row.days_late).toBe(0)
    expect(res.body.meta.totals.owed).toBe(0)
    expect(res.body.meta.totals.clearing).toBe(616.4)
    // The owner's totals are the same figures whichever list the screen asked for.
    expect(todo.body.meta.totals).toEqual(res.body.meta.totals)
  })

  it('the "Work trade" mark goes to a viewer who may see work trade, never to the front desk', async () => {
    const f = await seedOwedTenant()
    await db.query(`UPDATE payments SET work_trade_suspended_at = NOW() WHERE invoice_id = $1 AND type = 'rent'`, [f.invoiceId])
    const owner = await request(buildApp()).get('/api/balances').set('Authorization', `Bearer ${tokenFor(f.userId, f.landlordId)}`)
    const o = owner.body.data.find((r: any) => r.tenant_id === f.tenantId)
    expect(o.work_trade).toBe(true)
    expect(Number(o.balance)).toBe(176.4)
    const desk = await request(buildApp()).get('/api/balances')
      .set('Authorization', `Bearer ${await teamToken(f, 'onsite_manager', { 'balances.view': true })}`)
    const d = desk.body.data.find((r: any) => r.tenant_id === f.tenantId)
    expect(d.work_trade).toBe(false)
    expect(Number(d.balance)).toBe(176.4)
  })
})

// CLAUDE.md: FlexPay must NEVER surface in the landlord portal.
describe('GAM\'s FlexPay pull never reaches a landlord screen', () => {
  it('not in the list, not in the breakdown', async () => {
    const f = await seedOwedTenant()
    const leaseId = (await db.query(`SELECT lease_id FROM invoices WHERE id=$1`, [f.invoiceId])).rows[0].lease_id
    await db.query(
      `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date,
                             entry_description, revenue_owner, notes)
       VALUES ($1,$2,$3,$4,$5,'fee',25,'pending','2026-09-01','FLEXPAY','gam','FlexPay September')`,
      [f.invoiceId, f.unitId, leaseId, f.tenantId, f.landlordId])
    await db.query(
      `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date,
                             entry_description, revenue_owner, notes, settled_at)
       VALUES ($1,$2,$3,$4,$5,'fee',25,'settled','2026-08-01','FLEXPAY','gam','FlexPay August',NOW())`,
      [f.invoiceId, f.unitId, leaseId, f.tenantId, f.landlordId])
    const auth = { Authorization: `Bearer ${tokenFor(f.userId, f.landlordId)}` }
    const list = await request(buildApp()).get('/api/balances').set(auth)
    expect(JSON.stringify(list.body)).not.toMatch(/flexpay/i)
    expect(Number(list.body.data.find((r: any) => r.tenant_id === f.tenantId).balance)).toBe(616.4)
    const res = await request(buildApp()).get(`/api/balances/${f.tenantId}/invoices`).set(auth)
    expect(res.status).toBe(200)
    expect(JSON.stringify(res.body)).not.toMatch(/flexpay/i)
    expect(Number(res.body.data[0].balance)).toBe(616.4)
  })
})

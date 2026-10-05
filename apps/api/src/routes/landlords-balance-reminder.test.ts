/**
 * S654 — the landlord's "send a balance reminder" email carries the same Pay
 * now link as the bill.
 *
 * The bill's link signs the resident in with just their password (opening it
 * from their own inbox is the proof the emailed code exists for). The reminder
 * built its own plain /payments link, so a resident who tapped it was still
 * sent off to find a code. The landlord agent's send_balance_reminder calls
 * this same route, so it is covered here too.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'

const { emailBalanceDueSpy } = vi.hoisted(() => ({
  emailBalanceDueSpy: vi.fn(async (..._args: any[]) => 'msg_reminder' as string | null),
}))
// Capture the link instead of mailing it; every other sender stays real.
vi.mock('../services/email', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, emailBalanceDue: emailBalanceDueSpy }
})
// A real dispute runs paymentReversal.handlePaymentReversal; its side trips
// (late-fee back-fill, the landlord's alert, the recovery decision) are not read here.
vi.mock('../jobs/lateFees', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  generateLateFeesForInvoice: vi.fn(async () => ({ invoicesScanned: 0, rowsWritten: 0, capsHit: 0, errors: [] })),
}))
vi.mock('../services/responsibleParty', async (orig) => ({
  ...(await orig<Record<string, unknown>>()), getPropertyResponsibleParty: vi.fn(async () => null),
}))
vi.mock('../services/reversalRecovery', async (orig) => ({
  ...(await orig<Record<string, unknown>>()), decideReversalRecovery: vi.fn(async () => null),
}))

import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedLease, seedTenant, seedLeaseTenant,
} from '../test/dbHelpers'
import { landlordsRouter } from './landlords'
import { errorHandler } from '../middleware/errorHandler'
import { verifyEmailFactorToken } from './emailOtp'
import { portalLink } from '../lib/portalUrls'
import { handlePaymentReversal } from '../services/paymentReversal'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/landlords', landlordsRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  emailBalanceDueSpy.mockClear()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_balance_reminder'
})

async function seedOwing() {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const ll = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
    const unitId = await seedUnit(c, { propertyId, landlordId: ll.landlordId })
    const leaseId = await seedLease(c, { unitId, landlordId: ll.landlordId, rentAmount: 460 })
    const tenantEmail = `pat-${randomUUID()}@mailer-test.co`
    const tenantId = await seedTenant(c, { email: tenantEmail })
    await seedLeaseTenant(c, { leaseId, tenantId })
    await c.query(
      `INSERT INTO payments (landlord_id, unit_id, lease_id, tenant_id, type, amount, status, entry_description, due_date)
       VALUES ($1,$2,$3,$4,'rent',460,'pending','RENT',CURRENT_DATE)`,
      [ll.landlordId, unitId, leaseId, tenantId])
    const tenantUserId = (await c.query<{ user_id: string }>(
      `SELECT user_id FROM tenants WHERE id = $1`, [tenantId])).rows[0].user_id
    await c.query('COMMIT')
    return { ...ll, tenantId, tenantUserId, tenantEmail }
  } catch (e) { await c.query('ROLLBACK'); throw e }
  finally { c.release() }
}

function remind(f: { userId: string; landlordId: string; tenantId: string }) {
  const token = jwt.sign(
    { userId: f.userId, role: 'landlord', email: 'll@t.dev',
      profileId: f.landlordId, landlordIds: [f.landlordId], permissions: {} },
    process.env.JWT_SECRET!, { expiresIn: '1h' })
  return request(buildApp())
    .post(`/api/landlords/me/tenants/${f.tenantId}/balance-reminder`)
    .set('Authorization', `Bearer ${token}`)
}

describe('POST /api/landlords/me/tenants/:tenantId/balance-reminder', () => {
  it('the Pay now link vouches for the resident\'s own login and lands on Payments', async () => {
    const f = await seedOwing()
    const res = await remind(f)
    expect(res.status).toBe(200)
    expect(res.body.data.sent).toBe(true)
    expect(emailBalanceDueSpy).toHaveBeenCalledTimes(1)

    const [to, args] = emailBalanceDueSpy.mock.calls[0] as [string, { portalUrl: string; total: number }]
    expect(to).toBe(f.tenantEmail)                  // mailed to the address the token is bound to
    expect(args.total).toBe(460)
    expect(args.portalUrl.startsWith(portalLink('tenant', 'login?ef='))).toBe(true)
    const u = new URL(args.portalUrl)
    expect(u.searchParams.get('to')).toBe('/payments')
    expect(verifyEmailFactorToken(u.searchParams.get('ef')!))
      .toEqual({ userId: f.tenantUserId, email: f.tenantEmail })
  })

  it('the token is the tenant\'s, never the landlord\'s who pressed send', async () => {
    const f = await seedOwing()
    await remind(f)
    const [, args] = emailBalanceDueSpy.mock.calls[0] as [string, { portalUrl: string }]
    const vouched = verifyEmailFactorToken(new URL(args.portalUrl).searchParams.get('ef')!)
    expect(vouched?.userId).not.toBe(f.userId)
  })

  it('nothing owed: no email, so no link goes out at all', async () => {
    const f = await seedOwing()
    await db.query(`UPDATE payments SET status = 'settled' WHERE tenant_id = $1`, [f.tenantId])
    const res = await remind(f)
    expect(res.status).toBe(200)
    expect(res.body.data.sent).toBe(false)
    expect(emailBalanceDueSpy).not.toHaveBeenCalled()
  })
})

// ── S654: the reminder counts only what this landlord is owed ─────────────
//
// The rows are the ones the resident's portal counts (a payment already in
// flight is not owed), and another landlord's bills and credit never enter
// this landlord's email. S655 (Nic, 10/2): the total is the FULL balance; the
// landlord's own credit is said beside it ("credit available"), never taken off.
describe('S654: the reminder\'s rows and credit are this landlord\'s own', () => {
  async function seedBills(f: { landlordId: string; tenantId: string }, leaseId: string, unitId: string,
                           bills: [string, number][]) {
    let n = 0
    for (const [due, amount] of bills) {
      const inv = await db.query<{ id: string }>(
        `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date, total_amount, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'pending') RETURNING id`,
        [f.landlordId, f.tenantId, leaseId, unitId, `INV-REM-${randomUUID().slice(0, 8)}-${++n}`, due, amount])
      await db.query(
        `INSERT INTO payments (invoice_id, landlord_id, unit_id, lease_id, tenant_id, type, amount, status, entry_description, due_date)
         VALUES ($1,$2,$3,$4,$5,'rent',$6,'pending','RENT',$7)`,
        [inv.rows[0].id, f.landlordId, unitId, leaseId, f.tenantId, amount, due])
    }
  }
  async function seedResident() {
    const c = await db.connect()
    try {
      const ll = await seedLandlord(c)
      const propertyId = await seedProperty(c, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
      const unitId = await seedUnit(c, { propertyId, landlordId: ll.landlordId })
      const leaseId = await seedLease(c, { unitId, landlordId: ll.landlordId, rentAmount: 460 })
      const tenantId = await seedTenant(c, { email: `res-${randomUUID()}@mailer-test.co` })
      await seedLeaseTenant(c, { leaseId, tenantId })
      return { ...ll, unitId, leaseId, tenantId }
    } finally { c.release() }
  }

  it('the full balance with the landlord\'s credit beside it; a payment already in flight is not owed', async () => {
    const f = await seedResident()
    await seedBills(f, f.leaseId, f.unitId, [['2026-10-01', 460]])
    await db.query(`INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category)
                    VALUES ($1,$2,$3,50,50,'goodwill')`, [f.landlordId, f.tenantId, f.leaseId])
    // A card payment already started on an older row: in flight, not owed.
    await db.query(
      `INSERT INTO payments (landlord_id, unit_id, lease_id, tenant_id, type, amount, status, entry_description, due_date, stripe_payment_intent_id)
       VALUES ($1,$2,$3,$4,'utility',75,'pending','UTILITY','2026-09-15','pi_in_flight')`,
      [f.landlordId, f.unitId, f.leaseId, f.tenantId])

    const res = await remind(f)
    expect(res.body.data).toMatchObject({ sent: true, total: 460, creditAvailable: 50, lines: 1 })
    const [, args] = emailBalanceDueSpy.mock.calls[0] as [string, { total: number; creditAvailable: number; lines: any[] }]
    expect(args.total).toBe(460)
    expect(args.creditAvailable).toBe(50)
    expect(args.lines).toHaveLength(1)
  })

  it('a resident who owes only another landlord: nothing owed here, no email, no 403', async () => {
    const mine = await seedResident()
    const theirs = await seedResident()
    const c = await db.connect()
    let theirLease: string
    try {
      theirLease = await seedLease(c, { unitId: theirs.unitId, landlordId: theirs.landlordId, rentAmount: 300 })
      await seedLeaseTenant(c, { leaseId: theirLease, tenantId: mine.tenantId })
    } finally { c.release() }
    await seedBills({ landlordId: theirs.landlordId, tenantId: mine.tenantId }, theirLease!, theirs.unitId, [['2026-08-01', 300]])

    const res = await remind(mine)
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({ sent: false, reason: 'They do not owe anything right now.' })
    expect(emailBalanceDueSpy).not.toHaveBeenCalled()
  })

  it('another landlord\'s charges and credit stay out of this landlord\'s reminder', async () => {
    const mine = await seedResident()
    const theirs = await seedResident()
    // The same resident also rents from the other landlord.
    const c = await db.connect()
    let theirLease: string
    try {
      theirLease = await seedLease(c, { unitId: theirs.unitId, landlordId: theirs.landlordId, rentAmount: 300 })
      await seedLeaseTenant(c, { leaseId: theirLease, tenantId: mine.tenantId })
    } finally { c.release() }
    await seedBills({ landlordId: theirs.landlordId, tenantId: mine.tenantId }, theirLease!, theirs.unitId, [['2026-08-01', 300]])
    await db.query(`INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category)
                    VALUES ($1,$2,NULL,200,200,'goodwill')`, [theirs.landlordId, mine.tenantId])
    await seedBills(mine, mine.leaseId, mine.unitId, [['2026-10-01', 460]])

    const res = await remind(mine)
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ sent: true, total: 460, creditAvailable: 0, lines: 1 })
    const [, args] = emailBalanceDueSpy.mock.calls[0] as [string, { lines: any[] }]
    expect(args.lines).toHaveLength(1)
  })
})


// decisions #17: each line names what it is, never "Utilities", never a payment tag.
describe('S655: the reminder names each line', () => {
  it('a utility line reads as its utility, with its read as detail', async () => {
    const f = await seedOwing()
    const lease = (await db.query<{ lease_id: string; unit_id: string }>(
      `SELECT lease_id, unit_id FROM payments WHERE tenant_id = $1 LIMIT 1`, [f.tenantId])).rows[0]
    await db.query(
      `INSERT INTO payments (landlord_id, unit_id, lease_id, tenant_id, type, amount, status, entry_description, due_date, notes)
       VALUES ($1,$2,$3,$4,'utility',22.47,'pending','UTILITY',CURRENT_DATE,
               'Electric meter 86386 → 86493 (Sep 2 → Sep 30) · 107 kWh')`,
      [f.landlordId, lease.unit_id, lease.lease_id, f.tenantId])
    const res = await remind(f)
    expect(res.body.data).toMatchObject({ sent: true, total: 482.47 })
    const [, args] = emailBalanceDueSpy.mock.calls[0] as [string, { lines: Array<{ label: string; detail: string | null }> }]
    expect(args.lines.map(l => l.label).sort()).toEqual(['Electric', 'Rent'])
    expect(args.lines.find(l => l.label === 'Electric')!.detail).toBe('meter 86386 → 86493 (Sep 2 → Sep 30) · 107 kWh')
  })

  it('a disputed electric line owed again reads Electric with its read, never its reopen note', async () => {
    const f = await seedOwing()
    const lease = (await db.query<{ lease_id: string; unit_id: string }>(
      `SELECT lease_id, unit_id FROM payments WHERE tenant_id = $1 LIMIT 1`, [f.tenantId])).rows[0]
    const elec = (await db.query<{ id: string }>(
      `INSERT INTO payments (landlord_id, unit_id, lease_id, tenant_id, type, amount, status, entry_description, due_date, notes,
                             stripe_payment_intent_id, settled_at)
       VALUES ($1,$2,$3,$4,'utility',22.47,'settled','UTILITY',CURRENT_DATE,
               'Electric meter 86386 → 86493 (Sep 2 → Sep 30) · 107 kWh','pi_reminder_elec',NOW()) RETURNING id`,
      [f.landlordId, lease.unit_id, lease.lease_id, f.tenantId])).rows[0].id
    const rev = await handlePaymentReversal({
      paymentId: elec, reversalType: 'card_dispute', reversedAmount: 22.47, reversalFee: 0,
      stripeEventId: 'evt_reminder_elec', rawEvent: {},
    })
    expect(rev.handled).toBe(true)
    const res = await remind(f)
    expect(res.body.data).toMatchObject({ sent: true, total: 482.47 })
    const [, args] = emailBalanceDueSpy.mock.calls[0] as [string, { lines: Array<{ label: string; detail: string | null }> }]
    expect(args.lines.map(l => l.label).sort()).toEqual(['Electric', 'Rent'])
    expect(args.lines.find(l => l.label === 'Electric')!.detail).toBe('meter 86386 → 86493 (Sep 2 → Sep 30) · 107 kWh')
  })
})

// S655: a property-locked staffer reminds about charges at THEIR properties
// only — the same lock as the Outstanding list the button sits on.
describe('S655: a property-locked staffer\'s reminder', () => {
  it('names only the charges at their property; one who sees no charge of the resident sends nothing', async () => {
    const f = await seedOwing()                       // $460 rent at the first park
    const c = await db.connect()
    let otherProp: string, otherUnit: string, otherLease: string
    try {
      otherProp = await seedProperty(c, { landlordId: f.landlordId, ownerUserId: f.userId, managedByUserId: f.userId })
      otherUnit = await seedUnit(c, { propertyId: otherProp, landlordId: f.landlordId })
      otherLease = await seedLease(c, { unitId: otherUnit, landlordId: f.landlordId, rentAmount: 300 })
      await seedLeaseTenant(c, { leaseId: otherLease, tenantId: f.tenantId })
      await c.query(
        `INSERT INTO payments (landlord_id, unit_id, lease_id, tenant_id, type, amount, status, entry_description, due_date)
         VALUES ($1,$2,$3,$4,'rent',300,'pending','RENT',CURRENT_DATE)`, [f.landlordId, otherUnit, otherLease, f.tenantId])
    } finally { c.release() }
    const staff = (await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1,'x','onsite_manager','Desk','Clerk',TRUE) RETURNING id`, [`desk-${randomUUID()}@t.dev`])).rows[0].id
    await db.query(`INSERT INTO onsite_manager_scopes (user_id, landlord_id, all_properties, property_ids) VALUES ($1,$2,FALSE,$3)`,
      [staff, f.landlordId, [otherProp!]])
    const token = jwt.sign(
      { userId: staff, role: 'onsite_manager', email: 'desk@t.dev', profileId: null, landlordId: f.landlordId,
        permissions: { 'payments.view': true } },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    const res = await request(buildApp())
      .post(`/api/landlords/me/tenants/${f.tenantId}/balance-reminder`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ sent: true, total: 300, lines: 1 })
    const [, args] = emailBalanceDueSpy.mock.calls[0] as [string, { total: number; lines: any[] }]
    expect(args.total).toBe(300)

    // Scoped to a park where the resident owes nothing: nothing to remind about.
    emailBalanceDueSpy.mockClear()
    await db.query(`UPDATE onsite_manager_scopes SET property_ids = '{}' WHERE user_id = $1`, [staff])
    const none = await request(buildApp())
      .post(`/api/landlords/me/tenants/${f.tenantId}/balance-reminder`)
      .set('Authorization', `Bearer ${token}`)
    expect(none.body.data).toEqual({ sent: false, reason: 'They do not owe anything right now.' })
    expect(emailBalanceDueSpy).not.toHaveBeenCalled()
  })
})

// The reminder's total is the Outstanding row's balance: the same rows, not
// just the same rule. The row counts a charge billed to the person OR sitting
// on their bill (COALESCE(p.tenant_id, inv.tenant_id)), with or without a unit.
describe('S655: the reminder total equals the Outstanding row', () => {
  it('a charge with no tenant on the tenant\'s bill, and a charge on no unit, are in the reminder total', async () => {
    const f = await seedOwing()                       // $460 rent, billed to them
    const { unit_id: unitId, lease_id: leaseId } = (await db.query<{ unit_id: string; lease_id: string }>(
      `SELECT unit_id, lease_id FROM payments WHERE tenant_id = $1`, [f.tenantId])).rows[0]
    const inv = (await db.query<{ id: string }>(
      `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date, total_amount, status)
       VALUES ($1,$2,$3,$4,$5,CURRENT_DATE,25,'pending') RETURNING id`,
      [f.landlordId, f.tenantId, leaseId, unitId, `INV-REM-${randomUUID().slice(0, 8)}`])).rows[0].id
    // On their bill, but carrying no tenant of its own.
    await db.query(
      `INSERT INTO payments (landlord_id, unit_id, lease_id, tenant_id, invoice_id, type, amount, status, entry_description, due_date)
       VALUES ($1,$2,$3,NULL,$4,'fee',25,'pending','OTHERFEE',CURRENT_DATE)`, [f.landlordId, unitId, leaseId, inv])
    // Billed to them, on no unit.
    await db.query(
      `INSERT INTO payments (landlord_id, unit_id, lease_id, tenant_id, type, amount, status, entry_description, due_date)
       VALUES ($1,NULL,NULL,$2,'fee',15,'pending','OTHERFEE',CURRENT_DATE)`, [f.landlordId, f.tenantId])

    const { listOpenTenantBalances } = await import('../services/openBalances')
    const [row] = await listOpenTenantBalances({ landlordIds: [f.landlordId], tenantIds: [f.tenantId] })
    expect(row.balance).toBe('500.00')

    const res = await remind(f)
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ sent: true, total: 500, lines: 3 })
    const [, args] = emailBalanceDueSpy.mock.calls[0] as [string, { total: number; lines: Array<{ amount: number }> }]
    expect(args.total).toBe(Number(row.balance))
    expect(args.lines.map(l => l.amount).sort((a, b) => a - b)).toEqual([15, 25, 460])
  })
})

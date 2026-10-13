/**
 * 10/12 (Nic) — the Rent Roll's moved-out setting, imported payment history
 * and the onboarding month, through the routes.
 *
 *   "who stays on the Rent Roll after moving out = LANDLORD'S CHOICE (a
 *    setting on the page: billed in last 12 months / while they owe / all
 *    time)."
 *   "CSV-imported old payment history does NOT count toward payment health —
 *    health starts with the first bill GAM wrote; imported history still shows
 *    in the report."
 *   The onboarding month is the first rent GAM wrote — never a voided line.
 */
import { randomUUID } from 'crypto'
import { describe, it, expect, beforeEach } from 'vitest'
import request from 'supertest'
import express from 'express'
import jwt from 'jsonwebtoken'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedLease, seedTenant, seedLeaseTenant } from '../test/dbHelpers'
import { balancesRouter } from './balances'
import { tenantsRouter } from './tenants'
import { errorHandler } from '../middleware/errorHandler'
import { currentBillMonth, addMonths, importedNoteParts, importedFromLabel } from '../services/householdMonths'
import { keepsMovedOut } from '../services/rentRoll'
import { RENT_ROLL_MOVED_OUT_RULES, RENT_ROLL_MOVED_OUT_LABEL } from '@gam/shared'

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/balances', balancesRouter)
  app.use('/api/tenants', tenantsRouter)
  app.use(errorHandler)
  return app
}

beforeEach(cleanupAllSchema)

const THIS = currentBillMonth()
const LAST = addMonths(THIS, -1)

async function park(name = 'Mountain View RV Ranch', company = 'Mountain View LLC') {
  const c = await db.connect()
  try {
    const ll = await seedLandlord(c)
    await c.query(`UPDATE landlords SET business_name = $2 WHERE id = $1`, [ll.landlordId, company])
    const propertyId = await seedProperty(c, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
    await c.query(`UPDATE properties SET name = $2, timezone = 'America/Phoenix', late_fee_grace_days = 5 WHERE id = $1`, [propertyId, name])
    return { ...ll, propertyId }
  } finally { c.release() }
}

interface Hh { unitId: string; leaseId: string; tenantId: string }

async function household(p: { landlordId: string; propertyId: string }, unitNumber: string, name: string,
                         o: { movedOut?: boolean; existingTenancy?: boolean } = {}): Promise<Hh> {
  const c = await db.connect()
  try {
    const unitId = await seedUnit(c, { propertyId: p.propertyId, landlordId: p.landlordId, rentAmount: 495 })
    await c.query(`UPDATE units SET unit_number = $2 WHERE id = $1`, [unitId, unitNumber])
    const leaseId = await seedLease(c, { unitId, landlordId: p.landlordId, rentAmount: 495, startDate: '2024-01-01' })
    if (o.movedOut) await c.query(`UPDATE leases SET status = 'expired' WHERE id = $1`, [leaseId])
    if (o.existingTenancy) await c.query(`UPDATE leases SET is_existing_tenancy = TRUE WHERE id = $1`, [leaseId])
    const tenantId = await seedTenant(c)
    const [first, last] = name.split(' ')
    await c.query(`UPDATE users SET first_name = $2, last_name = $3 WHERE id = (SELECT user_id FROM tenants WHERE id = $1)`, [tenantId, first, last])
    await seedLeaseTenant(c, { leaseId, tenantId, role: 'primary' })
    return { unitId, leaseId, tenantId }
  } finally { c.release() }
}

/** A bill due the 1st of `month`, written that day; `paidDay` settles it in cash on that day of the month. */
async function rent(p: { landlordId: string }, h: Hh, month: string, amount: number, paidDay?: number) {
  const inv = (await db.query<{ id: string }>(
    `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date, total_amount, status, created_at)
     VALUES ($1,$2,$3,$4,$5,$6::date,$7,'pending',$6::date) RETURNING id`,
    [p.landlordId, h.tenantId, h.leaseId, h.unitId, `INV-${randomUUID().slice(0, 8)}`, `${month}-01`, amount])).rows[0].id
  await db.query(
    `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description,
                           created_at, settled_at, manual_method)
     VALUES ($1,$2,$3,$4,$5,'rent',$6,$7,$8::date,'RENT',$8::date,
             CASE WHEN $9::int IS NULL THEN NULL ELSE ($8::date + ($9::int - 1) * interval '1 day' + interval '19 hours') END,
             CASE WHEN $9::int IS NULL THEN NULL ELSE 'cash' END)`,
    [inv, h.unitId, h.leaseId, h.tenantId, p.landlordId, amount, paidDay ? 'settled' : 'pending', `${month}-01`, paidDay ?? null])
  return inv
}

/** A payment the payment-history CSV import wrote (routes/landlords onboard-payment-history-csv/commit). */
async function imported(p: { landlordId: string }, h: Hh, day: string, amount: number, source: string, notes: string) {
  await db.query(
    `INSERT INTO payments (landlord_id, tenant_id, lease_id, unit_id, type, entry_description, amount, status,
                           due_date, settled_at, processed_at, notes, import_source, imported_at)
     VALUES ($1,$2,$3,$4,'rent','RENT',$5,'settled',$6::date,$6::date,$6::date,$7,$8,NOW())`,
    [p.landlordId, h.tenantId, h.leaseId, h.unitId, amount, day, notes, source])
}

const ownerToken = (f: { userId: string }, landlordIds: string[]) => jwt.sign(
  { userId: f.userId, role: 'landlord', email: 'll@t.dev', profileId: null, landlordIds, permissions: {} },
  process.env.JWT_SECRET!, { expiresIn: '10m' })

async function staffToken(f: { landlordId: string }, permissions: Record<string, boolean>) {
  const u = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1,'x','property_manager','Team','Member',TRUE) RETURNING id`, [`pm-${randomUUID()}@t.dev`])
  await db.query(`INSERT INTO property_manager_scopes (user_id, landlord_id, all_properties, property_ids) VALUES ($1,$2,TRUE,'{}')`,
    [u.rows[0].id, f.landlordId])
  return jwt.sign({ userId: u.rows[0].id, role: 'property_manager', email: 'pm@t.dev', profileId: null, landlordId: f.landlordId, permissions },
    process.env.JWT_SECRET!, { expiresIn: '10m' })
}

const roll = (token: string) => request(buildApp()).get(`/api/balances/rent-roll?through=${THIS}`).set('Authorization', `Bearer ${token}`)
const setRule = (token: string, body: Record<string, unknown>) =>
  request(buildApp()).put('/api/balances/rent-roll/moved-out').set('Authorization', `Bearer ${token}`).send(body)
const names = (d: any) => d.properties.flatMap((f: any) => f.rows.map((r: any) => r.name)).sort()

describe('who stays on the Rent Roll after moving out — the landlord\'s choice', () => {
  it('billed in the last 12 months by default; while they still owe; all time — and an occupied space is always a row', async () => {
    const p = await park()
    const owner = ownerToken(p, [p.landlordId])
    await rent(p, await household(p, 'RV 10', 'Lena Living'), THIS, 495, 2)
    const recent = await household(p, 'RV 20', 'Rita Recent', { movedOut: true })
    await rent(p, recent, addMonths(THIS, -11), 495, 2)                 // moved out, paid, billed 11 months back
    const owes = await household(p, 'RV 40', 'Owen Owes', { movedOut: true })
    await rent(p, owes, addMonths(THIS, -14), 495)                      // moved out over a year ago, still owes
    const gone = await household(p, 'RV 30', 'Gus Gone', { movedOut: true })
    await rent(p, gone, addMonths(THIS, -13), 495, 2)                   // moved out over a year ago, paid

    const first = (await roll(owner)).body.data
    expect(first.moved_out).toEqual([{ landlord_id: p.landlordId, company_name: 'Mountain View LLC',
      rule: 'billed_last_12_months', rule_label: 'Billed in the last 12 months' }])
    expect(first.can_change_moved_out).toBe(true)
    expect(names(first)).toEqual(['Lena Living', 'Rita Recent'])

    const owing = await setRule(owner, { rule: 'while_owing' })
    expect(owing.status, JSON.stringify(owing.body)).toBe(200)
    expect(owing.body.data).toMatchObject({ landlord_id: p.landlordId, rule: 'while_owing', rule_label: 'While they still owe' })
    const d2 = (await roll(owner)).body.data
    expect(names(d2)).toEqual(['Lena Living', 'Owen Owes'])
    // Kept for longer than a year: the row still says where it lived.
    expect(d2.properties[0].rows.find((r: any) => r.name === 'Owen Owes').units).toEqual(['RV 40'])

    await setRule(owner, { rule: 'all_time' })
    expect(names((await roll(owner)).body.data)).toEqual(['Gus Gone', 'Lena Living', 'Owen Owes', 'Rita Recent'])
    // Saving the same choice again records nothing new; every change is kept.
    await setRule(owner, { rule: 'all_time' })
    const log = (await db.query(
      `SELECT old_value->>'rule' AS was, new_value->>'rule' AS now FROM audit_log
        WHERE action = 'rent_roll_moved_out_changed' AND entity_id = $1 ORDER BY created_at`, [p.landlordId])).rows
    expect(log).toEqual([{ was: 'billed_last_12_months', now: 'while_owing' }, { was: 'while_owing', now: 'all_time' }])
  })

  it('only the owner changes it; staff see it; a bad choice and another company are refused', async () => {
    const p = await park()
    await rent(p, await household(p, 'RV 10', 'Lena Living'), THIS, 495, 2)
    const staff = await staffToken(p, { 'payments.view_all': true })
    const seen = (await roll(staff)).body.data
    expect(seen.moved_out[0].rule).toBe('billed_last_12_months')
    expect(seen.can_change_moved_out).toBe(false)
    const refused = await setRule(staff, { rule: 'all_time' })
    expect(refused.status).toBe(403)
    expect(refused.body.error).toMatch(/account owner/i)

    const owner = ownerToken(p, [p.landlordId])
    const bad = await setRule(owner, { rule: 'forever' })
    expect(bad.status).toBe(400)
    expect(bad.body.error).toBe(`Pick one: ${RENT_ROLL_MOVED_OUT_RULES.map(r => RENT_ROLL_MOVED_OUT_LABEL[r]).join(', ')}.`)
    const stranger = await park('Someone Else', 'Someone Else LLC')
    expect((await setRule(owner, { landlordId: stranger.landlordId, rule: 'all_time' })).status).toBe(403)
    expect((await db.query(`SELECT rent_roll_moved_out FROM landlords WHERE id = $1`, [stranger.landlordId])).rows[0].rent_roll_moved_out)
      .toBe('billed_last_12_months')
  })

  it('per company: an account with two companies names which one, and each company\'s rule keeps its own households', async () => {
    const a = await park('Alpha Park', 'Alpha LLC')
    const b = await (async () => {
      const c = await db.connect()
      try {
        const id = (await c.query<{ id: string }>(
          `INSERT INTO landlords (user_id, business_name, billing_starts_at) VALUES ($1, 'Bravo LLC', DATE '2000-01-01') RETURNING id`, [a.userId])).rows[0].id
        const propertyId = await seedProperty(c, { landlordId: id, ownerUserId: a.userId, managedByUserId: a.userId })
        await c.query(`UPDATE properties SET name = 'Bravo Park', timezone = 'America/Phoenix' WHERE id = $1`, [propertyId])
        return { userId: a.userId, landlordId: id, propertyId }
      } finally { c.release() }
    })()
    await rent(a, await household(a, 'A1', 'Ann Gone', { movedOut: true }), addMonths(THIS, -20), 495, 2)
    await rent(b, await household(b, 'B1', 'Bob Gone', { movedOut: true }), addMonths(THIS, -20), 495, 2)
    const owner = ownerToken(a, [a.landlordId, b.landlordId])
    const ask = await setRule(owner, { rule: 'all_time' })
    expect(ask.status).toBe(400)
    expect(ask.body.error).toMatch(/more than one company/i)
    expect((await setRule(owner, { landlordId: b.landlordId, rule: 'all_time' })).status).toBe(200)
    const d = (await roll(owner)).body.data
    expect(d.moved_out.map((m: any) => [m.company_name, m.rule])).toEqual([['Alpha LLC', 'billed_last_12_months'], ['Bravo LLC', 'all_time']])
    expect(names(d)).toEqual(['Bob Gone'])
  })

  it('the rule on its own', () => {
    const m = (month: string, owed = 0) => ({ month, owed } as any)
    expect(keepsMovedOut('billed_last_12_months', [m('2025-11')], '2025-11')).toBe(true)
    expect(keepsMovedOut('billed_last_12_months', [m('2025-10', 50)], '2025-11')).toBe(false)
    expect(keepsMovedOut('while_owing', [m('2020-01', 0.01)], '2025-11')).toBe(true)
    expect(keepsMovedOut('while_owing', [m('2026-10', 0)], '2025-11')).toBe(false)
    expect(keepsMovedOut('all_time', [m('2001-01')], '2025-11')).toBe(true)
    expect(keepsMovedOut('all_time', [], '2025-11')).toBe(false)
  })
})

describe('10/12 (Nic) review: the moved-out setting never loses money, and each company is judged on its own months', () => {
  it('while they still owe: a household that moved out and paid this month is not a row, but its rent is in this month\'s totals', async () => {
    const p = await park()
    const owner = ownerToken(p, [p.landlordId])
    await rent(p, await household(p, 'RV 10', 'Lena Living'), THIS, 495, 2)
    await rent(p, await household(p, 'RV 20', 'Mona Moved', { movedOut: true }), THIS, 495, 2)   // moved out mid-month, paid in full
    expect((await setRule(owner, { rule: 'while_owing' })).status).toBe(200)
    const d = (await roll(owner)).body.data
    expect(names(d)).toEqual(['Lena Living'])
    expect(d.totals).toMatchObject({ charged: 990, paid: 990, owed: 0 })
    expect(d.properties[0].totals).toMatchObject({ charged: 990, paid: 990, owed: 0 })
    // The default setting shows her, and the totals are the same.
    await setRule(owner, { rule: 'billed_last_12_months' })
    const d2 = (await roll(owner)).body.data
    expect(names(d2)).toEqual(['Lena Living', 'Mona Moved'])
    expect(d2.totals).toMatchObject({ charged: 990, paid: 990, owed: 0 })
  })

  it('a property sold out of the account keeps the seller\'s own setting for the seller\'s old bills', async () => {
    const p = await park('Alder Park', 'Seller LLC')
    const owner = ownerToken(p, [p.landlordId])
    await rent(p, await household(p, 'RV 1', 'Sam Sold', { movedOut: true }), addMonths(THIS, -20), 495, 2)
    expect((await setRule(owner, { rule: 'all_time' })).status).toBe(200)
    expect(names((await roll(owner)).body.data)).toEqual(['Sam Sold'])
    // Alder is transferred to another account's company (properties are never deleted).
    const buyer = await park('Buyer Home', 'Buyer LLC')
    await db.query(`UPDATE properties SET landlord_id = $2 WHERE id = $1`, [p.propertyId, buyer.landlordId])
    await db.query(`UPDATE units SET landlord_id = $2 WHERE property_id = $1`, [p.propertyId, buyer.landlordId])
    expect(names((await roll(owner)).body.data)).toEqual(['Sam Sold'])
  })

  it('one household billed by two of the account\'s companies in the same month: the months add up, never overwrite', async () => {
    const a = await park('Alpha Park', 'Alpha LLC')
    const bId = (await db.query<{ id: string }>(
      `INSERT INTO landlords (user_id, business_name, billing_starts_at) VALUES ($1, 'Bravo LLC', DATE '2000-01-01') RETURNING id`, [a.userId])).rows[0].id
    const h = await household(a, 'A1', 'Hal Both')
    await rent(a, h, THIS, 495, 2)
    // A counter charge on no space at each company, the same month.
    for (const [landlordId, amount] of [[a.landlordId, 20], [bId, 30]] as const) {
      await db.query(
        `INSERT INTO payments (tenant_id, landlord_id, type, amount, status, due_date, entry_description, created_at)
         VALUES ($1,$2,'fee',$3,'pending',$4::date,'OTHERFEE',$4::date)`, [h.tenantId, landlordId, amount, `${THIS}-01`])
    }
    const d = (await roll(ownerToken(a, [a.landlordId, bId]))).body.data
    const noSpace = d.properties.find((f: any) => f.property_id === null)
    expect(noSpace.rows).toHaveLength(1)
    expect(noSpace.rows[0].current).toMatchObject({ charged: 50, owed: 50 })
    expect(d.totals).toMatchObject({ charged: 545, owed: 50 })
  })
})

describe('imported payment history: shown in the report, never counted', () => {
  it('health, the strip, the onboarding month and the history start with the first bill GAM wrote; the report lists the import, labeled', async () => {
    const p = await park()
    const owner = ownerToken(p, [p.landlordId])
    const h = await household(p, 'RV 7', 'Ivy Import', { existingTenancy: true })
    const before = addMonths(LAST, -3)
    await imported(p, h, `${before}-14`, 495, 'buildium', 'Imported from buildium. method: Check | ref: 1042')
    await imported(p, h, `${addMonths(LAST, -2)}-01`, 495, 'generic', 'Imported from generic.')
    await rent(p, h, LAST, 495, 12)     // the first bill GAM wrote — the onboarding month, paid late
    await rent(p, h, THIS, 495, 2)      // on time

    const rep = await request(buildApp()).get(`/api/tenants/${h.tenantId}/payment-report`).set('Authorization', `Bearer ${owner}`)
    expect(rep.status, JSON.stringify(rep.body)).toBe(200)
    const r = rep.body.data
    expect(r.on_gam_since).toBe(LAST)
    expect(r.onboarding_month).toBe(LAST)
    // The onboarding month is good news only: paid late, it is left out. The imports never count.
    expect(r.health).toMatchObject({ percent: 100, on_time: 1, counted: 1, from: LAST })
    expect(r.stamps.map((s: any) => s.month)).toEqual([LAST, THIS])
    expect(r.history).toHaveLength(2)
    expect(r.history.every((l: any) => l.month >= LAST)).toBe(true)
    expect(r.imported).toEqual([
      expect.objectContaining({ paid_on: `${addMonths(LAST, -2)}-01`, label: 'Rent', amount: 495, imported_from: 'your previous software', method: null, reference: null }),
      expect.objectContaining({ paid_on: `${before}-14`, label: 'Rent', amount: 495, imported_from: 'Buildium', method: 'Check', reference: '1042', unit_number: 'RV 7' }),
    ])

    const row = (await roll(owner)).body.data.properties[0].rows.find((x: any) => x.household_id === h.tenantId)
    expect(row.health).toMatchObject({ percent: 100, counted: 1 })
    expect(row.stamps.map((s: any) => s.month)).toEqual([LAST, THIS])
    expect(row.stamps[0]).toMatchObject({ stamp: 'paid_late', onboarding: true })
  })

  it('the import\'s note in words', () => {
    expect(importedNoteParts('Imported from yardi. method: Money order | ref: A-7')).toEqual({ method: 'Money order', reference: 'A-7' })
    expect(importedNoteParts('Imported from yardi. ref: 99')).toEqual({ method: null, reference: '99' })
    expect(importedNoteParts(null)).toEqual({ method: null, reference: null })
    expect(importedFromLabel('appfolio')).toBe('AppFolio')
    expect(importedFromLabel('generic')).toBe('your previous software')
    expect(importedFromLabel('nobody')).toBe('your previous software')
  })
})

describe('the onboarding month is the first rent GAM wrote', () => {
  it('a voided rent line never moves it back', async () => {
    const p = await park()
    const owner = ownerToken(p, [p.landlordId])
    const h = await household(p, 'RV 9', 'Vera Void', { existingTenancy: true })
    // A first bill thrown away (voided) two months back.
    await db.query(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, created_at,
                             voided_at, void_reason)
       VALUES ($1,$2,$3,$4,'rent',495,'voided',$5::date,'RENT',$5::date,$5::date + interval '2 days','Written by mistake')`,
      [h.unitId, h.leaseId, h.tenantId, p.landlordId, `${addMonths(LAST, -1)}-01`])
    await rent(p, h, LAST, 495, 12)     // the real first bill: onboarding, paid late — left out
    await rent(p, h, THIS, 495, 2)
    const r = (await request(buildApp()).get(`/api/tenants/${h.tenantId}/payment-report`).set('Authorization', `Bearer ${owner}`)).body.data
    expect(r.onboarding_month).toBe(LAST)
    expect(r.health).toMatchObject({ percent: 100, on_time: 1, counted: 1 })
  })
})

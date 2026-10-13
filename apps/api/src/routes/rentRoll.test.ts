/**
 * 10/12 (Nic) — the Rent Roll (GET /api/balances/rent-roll) and the tenant
 * payment report (GET /api/tenants/:id/payment-report), through their routes.
 *
 *   "Access: owner plus anyone with 'View all payments' (payments.view_all),
 *    staff limited to their properties, grand totals follow the existing rule
 *    for who sees totals."
 *   Lease rent comes from the LEASE, not the unit listing. Every household on
 *   an occupied space is a row, including one that paid nothing.
 */
import { randomUUID } from 'crypto'
import { describe, it, expect, beforeEach } from 'vitest'
import request from 'supertest'
import express from 'express'
import jwt from 'jsonwebtoken'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedLease, seedTenant, seedLeaseTenant } from '../test/dbHelpers'
import { balancesRouter } from './balances'
import { tenantsRouter, PROFILE_HISTORY_PAGE_SIZE } from './tenants'
import { unitsRouter } from './units'
import { errorHandler } from '../middleware/errorHandler'
import { currentBillMonth, addMonths } from '../services/householdMonths'
import { lateFeeTermsText, latenessPattern, median, firstLateDayText } from '../services/tenantPaymentReport'

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/balances', balancesRouter)
  app.use('/api/tenants', tenantsRouter)
  app.use('/api/units', unitsRouter)
  app.use(errorHandler)
  return app
}

beforeEach(cleanupAllSchema)

const THIS = currentBillMonth()
const LAST = addMonths(THIS, -1)

async function park(name = 'Mountain View RV Ranch') {
  const c = await db.connect()
  try {
    const ll = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
    await c.query(`UPDATE properties SET name = $2, timezone = 'America/Phoenix', late_fee_grace_days = 5 WHERE id = $1`, [propertyId, name])
    return { ...ll, propertyId }
  } finally { c.release() }
}

async function household(p: { landlordId: string; propertyId: string }, unitNumber: string, name: string, o: { leaseRent?: number; unitRent?: number } = {}) {
  const c = await db.connect()
  try {
    const unitId = await seedUnit(c, { propertyId: p.propertyId, landlordId: p.landlordId, rentAmount: o.unitRent ?? 589 })
    await c.query(`UPDATE units SET unit_number = $2 WHERE id = $1`, [unitId, unitNumber])
    const leaseId = await seedLease(c, { unitId, landlordId: p.landlordId, rentAmount: o.leaseRent ?? 495, startDate: '2026-01-01' })
    const tenantId = await seedTenant(c)
    const [first, last] = name.split(' ')
    await c.query(`UPDATE users SET first_name = $2, last_name = $3 WHERE id = (SELECT user_id FROM tenants WHERE id = $1)`, [tenantId, first, last])
    await seedLeaseTenant(c, { leaseId, tenantId, role: 'primary' })
    return { unitId, leaseId, tenantId }
  } finally { c.release() }
}

/** A bill due the 1st of `month`, written that day; `paidDay` (day of the month) settles it in cash. */
async function rent(p: { landlordId: string }, h: { unitId: string; leaseId: string; tenantId: string }, month: string, amount: number, paidDay?: number) {
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

const ownerToken = (f: { userId: string; landlordId: string }) => jwt.sign(
  { userId: f.userId, role: 'landlord', email: 'll@t.dev', profileId: null, landlordIds: [f.landlordId], permissions: {} },
  process.env.JWT_SECRET!, { expiresIn: '10m' })

async function teamToken(f: { landlordId: string }, role: 'property_manager' | 'onsite_manager',
                         permissions: Record<string, boolean>, propertyIds: string[] | null = null) {
  const u = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1,'x',$2,'Team','Member',TRUE) RETURNING id`,
    [`${role}-${randomUUID()}@t.dev`, role])
  const table = role === 'property_manager' ? 'property_manager_scopes' : 'onsite_manager_scopes'
  await db.query(`INSERT INTO ${table} (user_id, landlord_id, all_properties, property_ids) VALUES ($1,$2,$3,$4)`,
    [u.rows[0].id, f.landlordId, propertyIds === null, propertyIds ?? []])
  return jwt.sign({ userId: u.rows[0].id, role, email: 'team@t.dev', profileId: null, landlordId: f.landlordId, permissions },
    process.env.JWT_SECRET!, { expiresIn: '10m' })
}

const roll = (token: string, q = '') => request(buildApp()).get(`/api/balances/rent-roll${q}`).set('Authorization', `Bearer ${token}`)

describe('GET /api/balances/rent-roll', () => {
  it('a folder per property; every occupied household, the lease\'s rent, its month, its stamps and its health', async () => {
    const p = await park()
    const paid = await household(p, 'RV 33', 'Penny Paid', { leaseRent: 495, unitRent: 589 })
    const owes = await household(p, 'RV 48', 'Gerald Logue')
    const silent = await household(p, 'RV 50', 'Nora Nothing')
    await rent(p, paid, LAST, 495, 3)
    await rent(p, paid, THIS, 495, 2)
    await rent(p, owes, LAST, 495, 12)
    await rent(p, owes, THIS, 495)
    const res = await roll(ownerToken(p), `?through=${THIS}`)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const d = res.body.data
    expect(d.through).toBe(THIS)
    // 10/12 (Nic): all time — the strip runs from the first bill on the page.
    expect(d.months).toEqual([LAST, THIS])
    expect(d.properties).toHaveLength(1)
    const f = d.properties[0]
    expect(f.property_name).toBe('Mountain View RV Ranch')
    expect(f.occupied).toBe(3)
    expect(f.rows.map((r: any) => r.name)).toEqual(['Penny Paid', 'Gerald Logue', 'Nora Nothing'])
    const penny = f.rows[0]
    // The LEASE's rent, never the unit's listed $589.
    expect(penny.lease_rent).toBe(495)
    expect(penny.current).toMatchObject({ stamp: 'paid_on_time', charged: 495, paid: 495, owed: 0 })
    expect(penny.health).toMatchObject({ percent: 100, on_time: 2, counted: 2 })
    const gerald = f.rows[1]
    expect(gerald.stamps.find((s: any) => s.month === LAST)).toMatchObject({ stamp: 'paid_late', days_past_grace: 7 })
    expect(gerald.current.owed).toBe(495)
    // A household that has nothing billed is still a row.
    expect(f.rows[2]).toMatchObject({ name: 'Nora Nothing', current: null, lease_rent: 495 })
    expect(f.rows[2].stamps.every((s: any) => s.stamp === null)).toBe(true)
    // Counts by month, in the folder and across the page.
    expect(f.counts.find((c: any) => c.month === LAST)).toMatchObject({ paid_on_time: 1, paid_late: 1 })
    // The owner gets the totals.
    expect(f.totals).toMatchObject({ charged: 990, paid: 495, owed: 495 })
    expect(d.totals).toMatchObject({ charged: 990, owed: 495 })
    // The picked month's lines ride each row.
    expect(gerald.lines.map((l: any) => l.label)).toEqual(['Rent'])
  })

  it('staff need "View all payments"; with it they get every row and no grand total', async () => {
    const p = await park()
    const h = await household(p, 'RV 48', 'Gerald Logue')
    await rent(p, h, THIS, 495)
    const desk = await roll(await teamToken(p, 'onsite_manager', { 'balances.view': true, 'payments.view': true }))
    expect(desk.status).toBe(403)
    const staff = await roll(await teamToken(p, 'onsite_manager', { 'payments.view_all': true }))
    expect(staff.status).toBe(200)
    expect(staff.body.data.properties[0].rows).toHaveLength(1)
    expect(staff.body.data.totals).toBeUndefined()
    expect(staff.body.data.properties[0].totals).toBeUndefined()
    const pm = await roll(await teamToken(p, 'property_manager', { 'payments.view_all': true }))
    expect(pm.body.data.totals).toBeDefined()
  })

  it('a property-locked staff member sees only their properties', async () => {
    const p = await park()
    const other = await (async () => {
      const c = await db.connect()
      try {
        const id = await seedProperty(c, { landlordId: p.landlordId, ownerUserId: p.userId, managedByUserId: p.userId })
        await c.query(`UPDATE properties SET name = 'Oak Park' WHERE id = $1`, [id])
        return { landlordId: p.landlordId, propertyId: id }
      } finally { c.release() }
    })()
    await rent(p, await household(p, 'RV 48', 'Gerald Logue'), THIS, 495)
    await rent(other, await household(other, 'MH 03', 'Josh Roby'), THIS, 440)
    const owner = await roll(ownerToken(p))
    expect(owner.body.data.properties.map((f: any) => f.property_name).sort()).toEqual(['Mountain View RV Ranch', 'Oak Park'])
    const locked = await roll(await teamToken(p, 'onsite_manager', { 'payments.view_all': true }, [other.propertyId]))
    expect(locked.body.data.properties.map((f: any) => f.property_name)).toEqual(['Oak Park'])
  })

  it('refuses a month that is not a month', async () => {
    const p = await park()
    expect((await roll(ownerToken(p), '?through=October')).status).toBe(400)
    // The old 6-or-12 choice is gone (all time); a stale client that sends it is answered all time.
    const stale = await roll(ownerToken(p), `?through=${THIS}&months=6`)
    expect(stale.status).toBe(200)
    expect(stale.body.data.months).toEqual([THIS])
  })

  // 10/12 (Nic): "Payment health and a tenant's history are ALL-TIME (since the
  // household joined GAM), not 12 months. The Rent Roll shows the full stamp
  // history."
  it('all time: the strip and the health reach back to the first bill; a household gone over a year is off the page', async () => {
    const p = await park()
    const long = await household(p, 'RV 10', 'Lena Longtime')
    const old = addMonths(THIS, -14)
    await rent(p, long, old, 495, 12)            // paid late, 14 months back
    await rent(p, long, LAST, 495, 2)
    await rent(p, long, THIS, 495, 2)
    // Moved out: billed 11 months back (still on the page) and 13 months back (off it).
    const recent = await household(p, 'RV 20', 'Rita Recent')
    await rent(p, recent, addMonths(THIS, -11), 495, 2)
    const gone = await household(p, 'RV 30', 'Gus Gone')
    await rent(p, gone, addMonths(THIS, -13), 495, 2)
    await db.query(`UPDATE leases SET status = 'expired' WHERE id = ANY($1::uuid[])`, [[recent.leaseId, gone.leaseId]])

    const d = (await roll(ownerToken(p), `?through=${THIS}`)).body.data
    expect(d.months[0]).toBe(old)
    expect(d.months).toHaveLength(15)
    expect(d.months[d.months.length - 1]).toBe(THIS)
    const rows = d.properties[0].rows
    expect(rows.map((r: any) => r.name)).toEqual(['Lena Longtime', 'Rita Recent'])
    // Rita moved out of RV 20 11 months back: still her space on the page.
    expect(rows[1].units).toEqual(['RV 20'])
    const lena = rows[0]
    expect(lena.stamps).toHaveLength(15)
    expect(lena.stamps[0]).toMatchObject({ month: old, stamp: 'paid_late' })
    // Health counts the month 14 months back: 2 of 3, not 2 of 2.
    expect(lena.health).toMatchObject({ percent: 67, on_time: 2, counted: 3, paid_late: 1, from: old, through: THIS })
    // A space billed only over a year ago is history, not the household's space now.
    const c = await db.connect()
    try {
      const oldSpace = await seedUnit(c, { propertyId: p.propertyId, landlordId: p.landlordId, rentAmount: 589 })
      await c.query(`UPDATE units SET unit_number = 'RV 09' WHERE id = $1`, [oldSpace])
      const oldLease = await seedLease(c, { unitId: oldSpace, landlordId: p.landlordId, rentAmount: 495, startDate: '2025-01-01' })
      await c.query(`UPDATE leases SET status = 'expired' WHERE id = $1`, [oldLease])
      await seedLeaseTenant(c, { leaseId: oldLease, tenantId: long.tenantId, role: 'primary' })
      await rent(p, { unitId: oldSpace, leaseId: oldLease, tenantId: long.tenantId }, addMonths(THIS, -15), 495, 3)
    } finally { c.release() }
    const again = (await roll(ownerToken(p), `?through=${THIS}`)).body.data
    const lena2 = again.properties[0].rows.find((r: any) => r.name === 'Lena Longtime')
    expect(lena2.units).toEqual(['RV 10'])
    expect(lena2.stamps[0]).toMatchObject({ month: addMonths(THIS, -15), stamp: 'paid_on_time' })
    // The report says the same, every month since the first bill.
    const rep = (await request(buildApp()).get(`/api/tenants/${long.tenantId}/payment-report`)
      .set('Authorization', `Bearer ${ownerToken(p)}`)).body.data
    expect(rep.health).toMatchObject({ percent: 75, counted: 4, from: addMonths(THIS, -15) })
    expect(lena2.health).toMatchObject({ percent: 75, counted: 4 })
    expect(rep.stamps.map((s: any) => s.month)).toEqual(again.months)
    expect(rep.on_gam_since).toBe(addMonths(THIS, -15))
  })
})

describe('GET /api/tenants/:id/payment-report', () => {
  it('the household\'s health, how late, its lease terms in words and every charge', async () => {
    const p = await park()
    const h = await household(p, 'RV 48', 'Gerald Logue')
    await db.query(`UPDATE leases SET late_fee_enabled = TRUE, late_fee_initial_amount = 0, late_fee_accrual_amount = 5,
                           late_fee_accrual_type = 'flat', late_fee_accrual_period = 'daily', late_fee_accrual_from = 'due_date'
                     WHERE id = $1`, [h.leaseId])
    await rent(p, h, addMonths(THIS, -2), 495, 2)
    await rent(p, h, LAST, 495, 8)
    await rent(p, h, THIS, 495)
    const res = await request(buildApp()).get(`/api/tenants/${h.tenantId}/payment-report`).set('Authorization', `Bearer ${ownerToken(p)}`)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const r = res.body.data
    expect(r.name).toBe('Gerald Logue')
    expect(r.leases[0]).toMatchObject({ grace_days: 5, grace_source: 'property', unit_number: 'RV 48',
      late_fee_terms: '$5 a day, counted back to the due date once the grace period has passed; no cap' })
    // This month is still open (today's day of the month less the 5-day grace
    // so far — 10/12 integration: it was a fixed 7, true only on the 12th);
    // last month was paid 3 days past grace.
    const today = Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Phoenix', day: '2-digit' }).format(new Date()))
    const openSoFar = today - 5
    expect(r.how_late.months.map((m: any) => [m.month, m.days_past_grace, m.still_open]))
      .toEqual([...(openSoFar > 0 ? [[THIS, openSoFar, true]] : []), [LAST, 3, false]])
    // The pattern is how late they PAY (months paid in full).
    expect(r.how_late.pattern).toBe('Usually 3 days past grace')
    expect(r.health).toMatchObject({ percent: 33, on_time: 1, counted: 3 })
    expect(r.history.map((l: any) => l.label)).toEqual(['Rent', 'Rent', 'Rent'])
    expect(r.history[1]).toMatchObject({ how_paid: 'Cash', days_past_grace: 3 })
  })

  it('staff without "View all payments" are refused; another company never sees it', async () => {
    const p = await park()
    const h = await household(p, 'RV 48', 'Gerald Logue')
    await rent(p, h, THIS, 495)
    const desk = await request(buildApp()).get(`/api/tenants/${h.tenantId}/payment-report`)
      .set('Authorization', `Bearer ${await teamToken(p, 'onsite_manager', { 'balances.view': true })}`)
    expect(desk.status).toBe(403)
    const stranger = await park('Someone Else')
    const other = await request(buildApp()).get(`/api/tenants/${h.tenantId}/payment-report`).set('Authorization', `Bearer ${ownerToken(stranger)}`)
    expect(other.status).toBe(403)
  })
})

describe('the report\'s words', () => {
  it('late fee terms', () => {
    const base = { late_fee_enabled: true, late_fee_initial_type: 'flat', late_fee_initial_amount: null, late_fee_accrual_type: null,
      late_fee_accrual_amount: null, late_fee_accrual_period: null, late_fee_accrual_from: 'grace_end', late_fee_cap_type: null, late_fee_cap_amount: null }
    expect(lateFeeTermsText({ ...base, late_fee_enabled: false })).toBe('No late fee')
    expect(lateFeeTermsText({ ...base, late_fee_initial_amount: '25' })).toBe('$25 once the grace period has passed; no cap')
    expect(lateFeeTermsText({ ...base, late_fee_initial_amount: '25', late_fee_accrual_amount: '5', late_fee_accrual_type: 'flat',
      late_fee_accrual_period: 'daily', late_fee_cap_type: 'flat', late_fee_cap_amount: '100' }))
      .toBe('$25 once the grace period has passed; then $5 a day, from the end of the grace period; capped at $100')
  })
  // 10/12: the first late day from the one rule (services/lateness), never "grace + 1".
  it('the first late day in words', () => {
    expect(firstLateDayText(1, 5)).toBe('the 6th')
    expect(firstLateDayText(15, 5)).toBe('the 20th')
    expect(firstLateDayText(1, 1)).toBe('the 2nd')
    expect(firstLateDayText(1, 2)).toBe('the 3rd')
    expect(firstLateDayText(5, 6)).toBe('the 11th')
    expect(firstLateDayText(28, 5)).toBe('5 days after the due date')
  })
  it('the lateness pattern: median and range', () => {
    expect(latenessPattern([1, 2, 1])).toBe('Usually 1 day past grace (1–2)')
    expect(latenessPattern([8, 10, 14, 10])).toBe('Usually 10 days past grace (8–14)')
    expect(latenessPattern([])).toBeNull()
    expect(median([1, 2])).toBe(1.5)
  })
})

// ─── 10/12 screen pass: the numbers through the routes ───────────────────────

interface BillLine {
  type: 'rent' | 'utility' | 'late_fee'
  amount: number
  /** Day of the month it was paid in cash (settled); unset = still owed. */
  paidDay?: number
  /** The rest of a bill paid in part. */
  remainder?: boolean
  /** Covered by work trade (still suspended this month). */
  workTrade?: boolean
  notes?: string
  /** Day of the month a daily late fee is dated. */
  day?: number
}

/** One bill due the 1st of `month`, written that day, with its lines (cash on the day paid). */
async function bill(p: { landlordId: string }, h: { unitId: string; leaseId: string; tenantId: string }, month: string, lines: BillLine[]) {
  const inv = (await db.query<{ id: string }>(
    `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date, total_amount, status, created_at)
     VALUES ($1,$2,$3,$4,$5,$6::date,0,'pending',$6::date) RETURNING id`,
    [p.landlordId, h.tenantId, h.leaseId, h.unitId, `INV-${randomUUID().slice(0, 8)}`, `${month}-01`])).rows[0].id
  const ENTRY = { rent: 'RENT', utility: 'UTILITY', late_fee: 'LATEFEE' } as const
  for (const l of lines) {
    await db.query(
      `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description,
                             notes, created_at, settled_at, manual_method, is_remainder, work_trade_suspended_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::date,$10,$11,$12::date,
               CASE WHEN $13::int IS NULL THEN NULL ELSE ($12::date + ($13::int - 1) * interval '1 day' + interval '19 hours') END,
               CASE WHEN $13::int IS NULL THEN NULL ELSE 'cash' END, $14, CASE WHEN $15 THEN NOW() END)`,
      [inv, h.unitId, h.leaseId, h.tenantId, p.landlordId, l.type, l.amount, l.paidDay ? 'settled' : 'pending',
       l.day ? `${month}-${String(l.day).padStart(2, '0')}` : `${month}-01`, ENTRY[l.type], l.notes ?? null, `${month}-01`,
       l.paidDay ?? null, l.remainder === true, l.workTrade === true])
  }
  return inv
}

describe('the Rent Roll, through its route: every stamp, the money and what never counts', () => {
  it('partial, paid late, outstanding, a work-trade month, a $0 line and late fees — each where Nic put it', async () => {
    const p = await park()
    const partial = await household(p, 'RV 10', 'Paula Partial')
    const late = await household(p, 'RV 11', 'Larry Late')
    const owes = await household(p, 'RV 12', 'Olive Owes')
    const trade = await household(p, 'RV 13', 'Walt Worktrade')
    // Last month (long past its grace period):
    await bill(p, partial, LAST, [
      { type: 'rent', amount: 200, paidDay: 3 },
      { type: 'rent', amount: 295, remainder: true, notes: 'What is left of this bill after a part payment' },
    ])
    await bill(p, late, LAST, [
      { type: 'rent', amount: 495, paidDay: 12 },
      { type: 'late_fee', amount: 5, day: 6 }, { type: 'late_fee', amount: 5, day: 7 }, { type: 'late_fee', amount: 5, day: 8 },
    ])
    await bill(p, owes, LAST, [
      { type: 'rent', amount: 495 },
      { type: 'utility', amount: 0, notes: 'Electric meter 49083 → 49083 · 0 kWh' },
    ])
    await bill(p, trade, LAST, [{ type: 'rent', amount: 495, workTrade: true }])
    // Two months back Larry's bill holds only a late fee: never a bill of its own.
    await bill(p, late, addMonths(LAST, -1), [{ type: 'late_fee', amount: 25, day: 6 }])

    const res = await roll(ownerToken(p), `?through=${LAST}`)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const rows = res.body.data.properties[0].rows
    const row = (name: string) => rows.find((r: any) => r.name === name)

    // YELLOW: some money in, the rest owed past grace — Owed is the difference, and it counts.
    expect(row('Paula Partial').current).toMatchObject({ stamp: 'partial', charged: 495, paid: 200, owed: 295 })
    expect(row('Paula Partial').health).toMatchObject({ counted: 1, on_time: 0, partial: 1, percent: 0 })
    // ORANGE: paid in full on the 12th — 7 days past grace (the 6th is the first late day).
    // The late fees are charged and owed, named, and never the color.
    expect(row('Larry Late').current).toMatchObject({
      stamp: 'paid_late', days_past_grace: 7, charged: 510, charged_late_fees: 15, paid: 495, owed: 15,
    })
    // A month of only a late fee is no bill: no stamp, not counted.
    expect(row('Larry Late').stamps.find((s: any) => s.month === addMonths(LAST, -1))).toMatchObject({ stamp: null, charged: 25 })
    expect(row('Larry Late').health).toMatchObject({ counted: 1, paid_late: 1, percent: 0 })
    // RED: nothing paid past grace. The $0 line is no line and no money.
    expect(row('Olive Owes').current).toMatchObject({ stamp: 'outstanding', charged: 495, owed: 495 })
    expect(row('Olive Owes').lines.map((l: any) => [l.label, l.charged])).toEqual([['Rent', 495]])
    // GREEN: a month work trade covers in full counts as paid on time — never paid, never owed.
    expect(row('Walt Worktrade').current).toMatchObject({
      stamp: 'paid_on_time', work_trade_only: true, work_trade: 495, paid: 0, owed: 0,
    })
    expect(row('Walt Worktrade').health).toMatchObject({ percent: 100, on_time: 1, counted: 1, work_trade: 1 })

    // The month's counts (folder and page), the late fees inside Charged, work trade apart.
    const f = res.body.data.properties[0]
    expect(f.counts.find((c: any) => c.month === LAST)).toMatchObject({
      paid_on_time: 1, partial: 1, paid_late: 1, outstanding: 1, due: 0, work_trade: 1,
    })
    expect(f.counts.find((c: any) => c.month === addMonths(LAST, -1))).toMatchObject({ paid_on_time: 0, paid_late: 0, outstanding: 0 })
    // 495 + (495 + 15 in late fees) + 495 + 495 by work trade.
    expect(f.totals).toMatchObject({ charged: 1995, charged_late_fees: 15, paid: 695, work_trade: 495, owed: 805 })
  })

  it('the report says the same: partials, the daily late fees as one line, work trade and how late', async () => {
    const p = await park()
    const partial = await household(p, 'RV 10', 'Paula Partial')
    const late = await household(p, 'RV 11', 'Larry Late')
    const trade = await household(p, 'RV 13', 'Walt Worktrade')
    await bill(p, partial, LAST, [
      { type: 'rent', amount: 200, paidDay: 3 },
      { type: 'rent', amount: 295, remainder: true, notes: 'What is left of this bill after a part payment' },
    ])
    await bill(p, late, LAST, [
      { type: 'rent', amount: 495, paidDay: 12 },
      { type: 'late_fee', amount: 5, day: 6 }, { type: 'late_fee', amount: 5, day: 7 }, { type: 'late_fee', amount: 5, day: 8 },
    ])
    await bill(p, late, addMonths(LAST, -1), [{ type: 'rent', amount: 495, paidDay: 7 }])
    await bill(p, trade, LAST, [{ type: 'rent', amount: 495, workTrade: true }])
    const report = (id: string) => request(buildApp()).get(`/api/tenants/${id}/payment-report`).set('Authorization', `Bearer ${ownerToken(p)}`)

    const pr = (await report(partial.tenantId)).body.data
    expect(pr.partials).toMatchObject({ months: 1, average_first_payment: 200, average_first_percent: 40 })
    expect(pr.partials.open).toEqual([expect.objectContaining({ month: LAST, owed: 295 })])

    const lr = (await report(late.tenantId)).body.data
    // How late: 7 days past grace last month, 2 the month before — usually 4.5, range 2–7.
    expect(lr.how_late.months.map((m: any) => [m.month, m.days_past_grace])).toEqual([[LAST, 7], [addMonths(LAST, -1), 2]])
    expect(lr.how_late.pattern).toBe('Usually 4.5 days past grace (2–7)')
    // The three daily late fees are one line, with how many and the days.
    const fees = lr.history.find((h: any) => h.is_late_fee)
    expect(fees).toMatchObject({ late_fee_count: 3, charged: 15, owed: 15, late_fee_from: `${LAST}-06`, late_fee_to: `${LAST}-08` })
    expect(lr.history.filter((h: any) => h.is_late_fee)).toHaveLength(1)
    expect(lr.late_fees).toMatchObject({ charged: 15, owed: 15, months: 1 })

    const wr = (await report(trade.tenantId)).body.data
    expect(wr.work_trade).toMatchObject({ months_covered: 1, value_covered: 495 })
    expect(wr.health).toMatchObject({ percent: 100, work_trade: 1 })
    expect(wr.history[0]).toMatchObject({ label: 'Rent', how_paid: 'Work trade', owed: 0 })
  })

  it('a staff member locked to another property finds no history for a resident who never lived there', async () => {
    const p = await park()
    const h = await household(p, 'RV 48', 'Gerald Logue')
    await rent(p, h, LAST, 495, 2)
    const elsewhere = await (async () => {
      const c = await db.connect()
      try { return await seedProperty(c, { landlordId: p.landlordId, ownerUserId: p.userId, managedByUserId: p.userId }) } finally { c.release() }
    })()
    const res = await request(buildApp()).get(`/api/tenants/${h.tenantId}/payment-report`)
      .set('Authorization', `Bearer ${await teamToken(p, 'onsite_manager', { 'payments.view_all': true }, [elsewhere])}`)
    expect(res.status).toBe(404)
    expect(JSON.stringify(res.body)).not.toContain('Gerald')
  })
})

describe('the report for a staff member kept to some properties (S655)', () => {
  it('names only the residents who lived there and only the work trade there', async () => {
    const p = await park()
    const other = await (async () => {
      const c = await db.connect()
      try {
        const id = await seedProperty(c, { landlordId: p.landlordId, ownerUserId: p.userId, managedByUserId: p.userId })
        await c.query(`UPDATE properties SET name = 'Oak Park' WHERE id = $1`, [id])
        return { landlordId: p.landlordId, propertyId: id }
      } finally { c.release() }
    })()
    const here = await household(p, 'RV 48', 'Gerald Logue')
    await rent(p, here, LAST, 495, 2)
    // The same primary resident on a lease at the other park, with a co-tenant there only.
    const c = await db.connect()
    let coThere: string
    try {
      const unitId = await seedUnit(c, { propertyId: other.propertyId, landlordId: p.landlordId, rentAmount: 440 })
      const leaseId = await seedLease(c, { unitId, landlordId: p.landlordId, rentAmount: 440, startDate: '2026-01-01' })
      await seedLeaseTenant(c, { leaseId, tenantId: here.tenantId, role: 'primary' })
      coThere = await seedTenant(c)
      await c.query(`UPDATE users SET first_name = 'Otto', last_name = 'Elsewhere' WHERE id = (SELECT user_id FROM tenants WHERE id = $1)`, [coThere])
      await seedLeaseTenant(c, { leaseId, tenantId: coThere, role: 'co_tenant' })
      await c.query(`INSERT INTO work_trade_agreements (landlord_id, tenant_id, unit_id, status, start_date, covered_charges, monthly_hours_target, tracks_hours)
                     VALUES ($1,$2,$3,'active','2026-01-01',ARRAY['rent'],10,FALSE)`, [p.landlordId, here.tenantId, unitId])
    } finally { c.release() }
    const owner = await request(buildApp()).get(`/api/tenants/${here.tenantId}/payment-report`).set('Authorization', `Bearer ${ownerToken(p)}`)
    expect(owner.body.data.members.map((m: any) => m.name)).toContain('Otto Elsewhere')
    expect(owner.body.data.work_trade.agreements).toHaveLength(1)
    const locked = await request(buildApp()).get(`/api/tenants/${here.tenantId}/payment-report`)
      .set('Authorization', `Bearer ${await teamToken(p, 'onsite_manager', { 'payments.view_all': true }, [p.propertyId])}`)
    expect(locked.status).toBe(200)
    expect(locked.body.data.members.map((m: any) => m.name)).toEqual(['Gerald Logue'])
    expect(locked.body.data.work_trade.agreements).toEqual([])
    expect(locked.body.data.leases.map((l: any) => l.unit_number)).toEqual(['RV 48'])
  })
})

describe('10/12 review: the report\'s household and work trade', () => {
  // A staff member kept to Park A gets the household of the person's lease AT
  // Park A — never the household of their newer lease at Park B.
  it('a property-locked viewer gets the household of the lease at their property', async () => {
    const p = await park()
    const a1 = await household(p, 'RV 10', 'Anna Primary')
    const otherProp = await (async () => {
      const c = await db.connect()
      try { return await seedProperty(c, { landlordId: p.landlordId, ownerUserId: p.userId, managedByUserId: p.userId }) } finally { c.release() }
    })()
    const c = await db.connect()
    let xavier: string
    try {
      xavier = await seedTenant(c)
      await c.query(`UPDATE users SET first_name = 'Xavier', last_name = 'Both' WHERE id = (SELECT user_id FROM tenants WHERE id = $1)`, [xavier])
      await seedLeaseTenant(c, { leaseId: a1.leaseId, tenantId: xavier, role: 'co_tenant' })
      const bUnit = await seedUnit(c, { propertyId: otherProp, landlordId: p.landlordId, rentAmount: 300 })
      const bLease = await seedLease(c, { unitId: bUnit, landlordId: p.landlordId, rentAmount: 300, startDate: '2026-06-01' })
      await seedLeaseTenant(c, { leaseId: bLease, tenantId: xavier, role: 'primary' })
    } finally { c.release() }
    await rent(p, a1, LAST, 495, 2)
    const locked = await request(buildApp()).get(`/api/tenants/${xavier}/payment-report`)
      .set('Authorization', `Bearer ${await teamToken(p, 'onsite_manager', { 'payments.view_all': true }, [p.propertyId])}`)
    expect(locked.status, JSON.stringify(locked.body)).toBe(200)
    expect(locked.body.data.household_id).toBe(a1.tenantId)
    expect(locked.body.data.name).toBe('Anna Primary')
    expect(locked.body.data.members.map((m: any) => m.name).sort()).toEqual(['Anna Primary', 'Xavier Both'])
    expect(locked.body.data.leases.map((l: any) => l.unit_number)).toEqual(['RV 10'])
    expect(locked.body.data.history.map((l: any) => l.charged)).toEqual([495])
  })

  // What a month close settled is a line too, so the history adds up to the months.
  it('a month close\'s work trade is a line in the history and on the Rent Roll\'s expanded row', async () => {
    const p = await park()
    const h = await household(p, 'RV 13', 'Walt Worktrade')
    const inv = await bill(p, h, LAST, [{ type: 'rent', amount: 0, paidDay: 28, notes: 'Covered by work-trade credit' }])
    await db.query(`UPDATE invoices SET work_trade_credit_amount = 460 WHERE id = $1`, [inv])
    const report = (await request(buildApp()).get(`/api/tenants/${h.tenantId}/payment-report`).set('Authorization', `Bearer ${ownerToken(p)}`)).body.data
    expect(report.history).toEqual([expect.objectContaining({
      label: 'Rent', charged: 460, work_trade: 460, owed: 0, how_paid: 'Work trade', paid_on: `${LAST}-01`, invoice_id: inv })])
    expect(report.work_trade.by_charge).toEqual([{ label: 'Rent', amount: 460 }])
    const row = (await roll(ownerToken(p), `?through=${LAST}`)).body.data.properties[0].rows[0]
    expect(row.current).toMatchObject({ charged: 460, work_trade: 460, stamp: 'paid_on_time' })
    expect(row.lines).toEqual([expect.objectContaining({ label: 'Rent', charged: 460, work_trade: 460 })])
  })

  // The Tenants list keeps the payment health from staff the profile keeps it from (S641).
  it('the Tenants list shows the health only to a viewer who may see payment histories', async () => {
    const p = await park()
    const h = await household(p, 'RV 48', 'Gerald Logue')
    await rent(p, h, LAST, 495, 2)
    const healthFor = async (token: string) => ((await request(buildApp()).get('/api/units').set('Authorization', `Bearer ${token}`))
      .body.data as any[]).find(u => u.tenant_id === h.tenantId).payment_health
    expect(await healthFor(ownerToken(p))).toBe(100)
    expect(await healthFor(await teamToken(p, 'onsite_manager', { 'payments.view_all': true }))).toBe(100)
    expect(await healthFor(await teamToken(p, 'onsite_manager', { 'balances.view': true }))).toBeNull()
  })
})

describe('one household, one health number on every screen', () => {
  it('the Tenants list, the profile, the Rent Roll, the report and the resident\'s own heartbeat agree', async () => {
    const p = await park()
    const h = await household(p, 'RV 48', 'Gerald Logue')
    await rent(p, h, addMonths(LAST, -2), 495, 2)   // on time
    // 7 days past grace, with daily late fees on the bill: never a bill, never a "month".
    await bill(p, h, addMonths(LAST, -1), [
      { type: 'rent', amount: 495, paidDay: 12 }, { type: 'late_fee', amount: 5, day: 6 }, { type: 'late_fee', amount: 5, day: 7 },
    ])
    await bill(p, h, LAST, [{ type: 'rent', amount: 200, paidDay: 3 }, { type: 'rent', amount: 295, remainder: true }])
    const owner = ownerToken(p)
    const app = buildApp()
    const tenantUser = (await db.query<{ user_id: string }>(`SELECT user_id FROM tenants WHERE id = $1`, [h.tenantId])).rows[0].user_id
    const tenantToken = jwt.sign({ userId: tenantUser, role: 'tenant', email: 't@t.dev', profileId: h.tenantId, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '10m' })

    const list = (await request(app).get('/api/units').set('Authorization', `Bearer ${owner}`)).body.data
    const fromList = list.find((u: any) => u.tenant_id === h.tenantId).payment_health
    const profile = (await request(app).get(`/api/tenants/${h.tenantId}/profile`).set('Authorization', `Bearer ${owner}`)).body.data
    const rollRow = (await roll(owner)).body.data.properties[0].rows.find((r: any) => r.household_id === h.tenantId)
    const report = (await request(app).get(`/api/tenants/${h.tenantId}/payment-report`).set('Authorization', `Bearer ${owner}`)).body.data
    const own = (await request(app).get('/api/tenants/me/payment-health').set('Authorization', `Bearer ${tenantToken}`)).body.data

    expect(rollRow.health.percent).not.toBeNull()
    expect(fromList).toBe(rollRow.health.percent)
    // The Tenants list's Rent is the lease's ($495), like the Rent Roll's — never the space's listed $589.
    const listRow = list.find((u: any) => u.tenant_id === h.tenantId)
    expect(Number(listRow.lease_rent_amount)).toBe(rollRow.lease_rent)
    expect(Number(listRow.rent_amount)).toBe(589)
    expect(profile.stats.onTimeRate).toBe(rollRow.health.percent)
    expect(profile.stats.health).toMatchObject({ on_time: rollRow.health.on_time, counted: rollRow.health.counted })
    expect(report.health).toMatchObject({ percent: rollRow.health.percent, on_time: rollRow.health.on_time, counted: rollRow.health.counted })
    expect(own.onTime).toMatchObject({ pct: rollRow.health.percent, onTimeCount: rollRow.health.on_time, resolved: rollRow.health.counted })
  })
})

describe('the profile\'s Payment History: the household, a page at a time', () => {
  it('no 36-row cap: newest first, every charge across the pages, none twice', async () => {
    const p = await park()
    const h = await household(p, 'RV 48', 'Gerald Logue')
    const extra = 7
    const total = PROFILE_HISTORY_PAGE_SIZE + extra
    // One late fee a day (one per bill per day), spread over three bills.
    const perBill = Math.ceil(total / 3)
    for (let b = 0; b < 3; b++) {
      const n = Math.min(perBill, total - b * perBill)
      await bill(p, h, addMonths(LAST, -b), Array.from({ length: n }, (_, i) => ({ type: 'late_fee' as const, amount: 5, day: i + 1 })))
    }
    const get = (q = '') => request(buildApp()).get(`/api/tenants/${h.tenantId}/profile${q}`).set('Authorization', `Bearer ${ownerToken(p)}`)
    const one = (await get()).body.data
    expect(one.payments).toHaveLength(PROFILE_HISTORY_PAGE_SIZE)
    expect(one.paymentsPage).toEqual({ page: 1, pageSize: PROFILE_HISTORY_PAGE_SIZE, total })
    expect(one.payments[0].label).toBe('Late fee')
    const two = (await get('?historyPage=2')).body.data
    expect(two.payments).toHaveLength(extra)
    const ids = [...one.payments, ...two.payments].map((x: any) => x.id)
    expect(new Set(ids).size).toBe(total)
    // Newest due date first across the pages.
    const dues = [...one.payments, ...two.payments].map((x: any) => String(x.due_date).slice(0, 10))
    expect([...dues].sort().reverse()).toEqual(dues)
    expect((await get('?historyPage=0')).status).toBe(400)
  })
})

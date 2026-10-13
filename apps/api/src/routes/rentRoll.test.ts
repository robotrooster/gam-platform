/**
 * 10/13 (Nic) — the Payments page (GET /api/balances/rent-roll/open-month),
 * the Rent Roll page (GET /api/balances/rent-roll/history), their property
 * picker, and the tenant payment report (GET /api/tenants/:id/payment-report),
 * through their routes.
 *
 *   "the payments page is the rent roll for the open month. And the rent roll
 *    page is the historical lookup for previous reportings for quarters or
 *    years or individual months or whatever."
 *   "for the open month I want it to be in order of space number but below any
 *    outstanding balances."
 *   One row per household — a household is a LEASE; every space shows (an empty
 *   one as Vacant); Invoiced / Paid / Owed; no On time column — one status pill.
 *   "Access: owner plus anyone with 'View all payments' (payments.view_all),
 *    staff limited to their properties, grand totals follow the existing rule
 *    for who sees totals." (10/12, unchanged)
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
/** Today's day of the month on the parks' calendar (Phoenix). The 6th is the first late day with 5 days of grace. */
const TODAY = Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Phoenix', day: '2-digit' }).format(new Date()))
const PAST_GRACE_NOW = TODAY - 5
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(THIS.slice(5, 7)) - 1]

async function park(name = 'Mountain View RV Ranch', p?: { landlordId: string; userId: string }) {
  const c = await db.connect()
  try {
    const ll = p ?? await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
    await c.query(`UPDATE properties SET name = $2, timezone = 'America/Phoenix', late_fee_grace_days = 5 WHERE id = $1`, [propertyId, name])
    return { userId: ll.userId, landlordId: ll.landlordId, propertyId }
  } finally { c.release() }
}

async function space(p: { landlordId: string; propertyId: string }, unitNumber: string, o: { paymentBlock?: boolean } = {}) {
  const c = await db.connect()
  try {
    const unitId = await seedUnit(c, { propertyId: p.propertyId, landlordId: p.landlordId, rentAmount: 589 })
    await c.query(`UPDATE units SET unit_number = $2, payment_block = $3 WHERE id = $1`, [unitId, unitNumber, o.paymentBlock === true])
    return unitId
  } finally { c.release() }
}

interface Hh { unitId: string; leaseId: string; tenantId: string }

async function household(p: { landlordId: string; propertyId: string }, unitNumber: string, name: string,
                         o: { leaseRent?: number; unitRent?: number; tenantId?: string; status?: 'active' | 'expired'; paymentBlock?: boolean } = {}): Promise<Hh> {
  const unitId = await space(p, unitNumber, { paymentBlock: o.paymentBlock })
  const c = await db.connect()
  try {
    const leaseId = await seedLease(c, { unitId, landlordId: p.landlordId, rentAmount: o.leaseRent ?? 495, startDate: '2026-01-01', status: o.status ?? 'active' })
    let tenantId = o.tenantId
    if (!tenantId) {
      tenantId = await seedTenant(c)
      const [first, last] = name.split(' ')
      await c.query(`UPDATE users SET first_name = $2, last_name = $3 WHERE id = (SELECT user_id FROM tenants WHERE id = $1)`, [tenantId, first, last])
    }
    await seedLeaseTenant(c, { leaseId, tenantId, role: 'primary' })
    return { unitId, leaseId, tenantId }
  } finally { c.release() }
}

/** A bill due the 1st of `month`, written that day; `paidDay` (day of the month) settles it in cash. */
async function rent(p: { landlordId: string }, h: Hh, month: string, amount: number, paidDay?: number) {
  const inv = (await db.query<{ id: string }>(
    `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date, total_amount, status, created_at)
     VALUES ($1,$2,$3,$4,$5,$6::date,$7,'pending',$6::date) RETURNING id`,
    [p.landlordId, h.tenantId, h.leaseId, h.unitId, `INV-${randomUUID().slice(0, 8)}`, `${month}-01`, amount])).rows[0].id
  const pay = (await db.query<{ id: string }>(
    `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description,
                           created_at, settled_at, manual_method)
     VALUES ($1,$2,$3,$4,$5,'rent',$6,$7,$8::date,'RENT',$8::date,
             CASE WHEN $9::int IS NULL THEN NULL ELSE ($8::date + ($9::int - 1) * interval '1 day' + interval '19 hours') END,
             CASE WHEN $9::int IS NULL THEN NULL ELSE 'cash' END) RETURNING id`,
    [inv, h.unitId, h.leaseId, h.tenantId, p.landlordId, amount, paidDay ? 'settled' : 'pending', `${month}-01`, paidDay ?? null])).rows[0].id
  return { invoiceId: inv, paymentId: pay }
}

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
async function bill(p: { landlordId: string }, h: Hh, month: string, lines: BillLine[]) {
  const inv = (await db.query<{ id: string }>(
    `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date, total_amount, status, created_at)
     VALUES ($1,$2,$3,$4,$5,$6::date,0,'pending',$6::date) RETURNING id`,
    [p.landlordId, h.tenantId, h.leaseId, h.unitId, `INV-${randomUUID().slice(0, 8)}`, `${month}-01`])).rows[0].id
  const ENTRY = { rent: 'RENT', utility: 'UTILITY', late_fee: 'LATEFEE' } as const
  const ids: string[] = []
  for (const l of lines) {
    ids.push((await db.query<{ id: string }>(
      `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description,
                             notes, created_at, settled_at, manual_method, is_remainder, work_trade_suspended_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::date,$10,$11,$12::date,
               CASE WHEN $13::int IS NULL THEN NULL ELSE ($12::date + ($13::int - 1) * interval '1 day' + interval '19 hours') END,
               CASE WHEN $13::int IS NULL THEN NULL ELSE 'cash' END, $14, CASE WHEN $15 THEN NOW() END) RETURNING id`,
      [inv, h.unitId, h.leaseId, h.tenantId, p.landlordId, l.type, l.amount, l.paidDay ? 'settled' : 'pending',
       l.day ? `${month}-${String(l.day).padStart(2, '0')}` : `${month}-01`, ENTRY[l.type], l.notes ?? null, `${month}-01`,
       l.paidDay ?? null, l.remainder === true, l.workTrade === true])).rows[0].id)
  }
  return { invoiceId: inv, ids }
}

const ownerToken = (f: { userId: string }, landlordIds: string[]) => jwt.sign(
  { userId: f.userId, role: 'landlord', email: 'll@t.dev', profileId: null, landlordIds, permissions: {} },
  process.env.JWT_SECRET!, { expiresIn: '10m' })
const owner = (f: { userId: string; landlordId: string }) => ownerToken(f, [f.landlordId])

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

const get = (token: string, path: string) => request(buildApp()).get(path).set('Authorization', `Bearer ${token}`)
const openMonth = (token: string, propertyId: string) => get(token, `/api/balances/rent-roll/open-month?propertyId=${propertyId}`)
const history = (token: string, propertyId: string, q: string) => get(token, `/api/balances/rent-roll/history?propertyId=${propertyId}&${q}`)
const report = (token: string, tenantId: string, q = '') => get(token, `/api/tenants/${tenantId}/payment-report${q}`)

// ─── The property picker ─────────────────────────────────────────────────────

describe('GET /api/balances/rent-roll/properties', () => {
  it('the properties the viewer may see, by name; staff locked to one see that one', async () => {
    const p = await park('Oak Park Motel and RV')
    const mv = await park('Mountain View RV Ranch', p)
    await space(p, 'RV 1')
    await space(mv, 'RV 1')
    await space(mv, 'RV 2')
    const all = await get(owner(p), '/api/balances/rent-roll/properties')
    expect(all.status, JSON.stringify(all.body)).toBe(200)
    expect(all.body.data).toEqual([
      { propertyId: mv.propertyId, name: 'Mountain View RV Ranch', spaces: 2, owned: true },
      { propertyId: p.propertyId, name: 'Oak Park Motel and RV', spaces: 1, owned: true },
    ])
    const locked = await get(await teamToken(p, 'onsite_manager', { 'payments.view_all': true }, [p.propertyId]), '/api/balances/rent-roll/properties')
    expect(locked.body.data.map((x: any) => x.name)).toEqual(['Oak Park Motel and RV'])
    const desk = await get(await teamToken(p, 'onsite_manager', { 'balances.view': true, 'payments.view': true }), '/api/balances/rent-roll/properties')
    expect(desk.status).toBe(403)
  })
})

// ─── The Payments page: the open month ──────────────────────────────────────

describe('GET /api/balances/rent-roll/open-month — the Payments page', () => {
  it('every space in space order below anyone still owing; Invoiced, Paid, Owed, the method and one status pill', async () => {
    const p = await park()
    const penny = await household(p, 'RV 10', 'Penny Paid')
    const gerald = await household(p, 'RV 2', 'Gerald Logue')
    const paula = await household(p, 'RV 1', 'Paula Partial')
    const walt = await household(p, 'RV 20', 'Walt Worktrade')
    await space(p, 'RV 3')                                 // empty
    await rent(p, penny, THIS, 495, 1)
    const geraldRent = await rent(p, gerald, THIS, 495)
    await bill(p, paula, THIS, [
      { type: 'rent', amount: 200, paidDay: 1 },
      { type: 'rent', amount: 295, remainder: true, notes: 'What is left of this bill after a part payment' },
    ])
    await bill(p, walt, THIS, [{ type: 'rent', amount: 495, workTrade: true }])
    // Someone at another park is never on this one.
    const other = await park('Oak Park Motel and RV', p)
    await rent(other, await household(other, 'MH 03', 'Josh Roby'), THIS, 440)

    const res = await openMonth(owner(p), p.propertyId)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const d = res.body.data
    expect(d).toMatchObject({ propertyId: p.propertyId, propertyName: 'Mountain View RV Ranch', month: THIS })
    // Owing first (RV 1, RV 2 in space order), then every other space in its spot — the empty one included.
    expect(d.rows.map((r: any) => [r.space, r.residents.map((x: any) => x.name).join(), r.status === 'vacant'])).toEqual([
      ['RV 1', 'Paula Partial', false],
      ['RV 2', 'Gerald Logue', false],
      ['RV 3', '', true],
      ['RV 10', 'Penny Paid', false],
      ['RV 20', 'Walt Worktrade', false],
    ])
    const row = (space: string) => d.rows.find((r: any) => r.space === space)
    // GREEN: paid in full within grace; the method is how they paid.
    expect(row('RV 10')).toMatchObject({
      invoiced: 495, paid: 495, owed: 0, status: 'paid', statusLabel: 'Paid', statusColor: 'green', methods: ['Cash'],
      leaseId: penny.leaseId, householdId: penny.tenantId, movedOut: false, recordWith: null,
    })
    expect(row('RV 10').payments).toEqual([expect.objectContaining({ amount: 495, credit: 0, methodLabel: 'Cash', status: 'settled', paidOn: `${THIS}-01` })])
    expect(row('RV 10').charges).toEqual([expect.objectContaining({ label: 'Rent', invoiced: 495, paid: 495, owed: 0, howPaid: 'Cash' })])
    // Nothing paid: gray Due <date> inside grace, red Owes +N past it — and the desk window opens on the rent.
    expect(row('RV 2')).toMatchObject({ invoiced: 495, paid: 0, owed: 495, methods: [], payments: [], recordWith: geraldRent.paymentId, dueDate: `${THIS}-01` })
    if (PAST_GRACE_NOW > 0) expect(row('RV 2')).toMatchObject({ status: 'owes', daysPastGrace: PAST_GRACE_NOW, statusLabel: `Owes +${PAST_GRACE_NOW}`, statusColor: 'red' })
    else expect(row('RV 2')).toMatchObject({ status: 'due', daysPastGrace: 0, statusLabel: `Due ${MONTH_SHORT} 1`, statusColor: 'gray' })
    // A partial: Owed is the difference; yellow inside grace, red "Owes +N" past it.
    expect(row('RV 1')).toMatchObject({ invoiced: 495, paid: 200, owed: 295, methods: ['Cash'] })
    expect(row('RV 1').status).toBe(PAST_GRACE_NOW > 0 ? 'owes' : 'partial')
    expect(row('RV 1').charges.map((c: any) => [c.invoiced, c.owed])).toEqual([[200, 0], [295, 295]])
    // Work trade covering the month: Paid, method "Work trade" — never paid money, never owed.
    expect(row('RV 20')).toMatchObject({ status: 'paid', workTradeOnly: true, methods: ['Work trade'], workTrade: 495, paid: 0, owed: 0 })
    // An empty space: gray Vacant, nothing on it.
    expect(row('RV 3')).toMatchObject({ status: 'vacant', statusLabel: 'Vacant', leaseId: null, householdId: null, invoiced: 0, recordWith: null, payments: [], charges: [] })
    // The owner gets the sums.
    expect(d.totals).toMatchObject({ invoiced: 1980, paid: 695, workTrade: 495, owed: 790, owedEarlier: 0 })
  })

  it('two spaces on two leases are two households; one payment for both is on each row for its part', async () => {
    const p = await park()
    const a = await household(p, 'RV 30', 'Hal Twice')
    const b = await household(p, 'RV 31', 'Hal Twice', { tenantId: a.tenantId, leaseRent: 300 })
    const ra = await rent(p, a, THIS, 495)
    const rb = await rent(p, b, THIS, 300)
    // One cash receipt at the desk paid both.
    const rem = (await db.query<{ id: string }>(
      `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, unapplied_amount, status,
                                       payment_method, processing_fee_amount, created_at, settled_at)
       VALUES ($1,$2,$3,795,795,0,'settled','cash',0,($4::date + interval '19 hours'),($4::date + interval '19 hours')) RETURNING id`,
      [a.tenantId, a.leaseId, p.landlordId, `${THIS}-01`])).rows[0].id
    for (const [id, amt] of [[ra.paymentId, 495], [rb.paymentId, 300]] as const) {
      await db.query(`UPDATE payments SET status = 'settled', manual_method = 'cash', settled_at = ($2::date + interval '19 hours') WHERE id = $1`, [id, `${THIS}-01`])
      await db.query(`INSERT INTO remittance_applications (remittance_id, payment_id, amount_applied) VALUES ($1,$2,$3)`, [rem, id, amt])
    }
    const d = (await openMonth(owner(p), p.propertyId)).body.data
    expect(d.rows.map((r: any) => [r.space, r.leaseId, r.invoiced, r.paid, r.owed, r.status])).toEqual([
      ['RV 30', a.leaseId, 495, 495, 0, 'paid'],
      ['RV 31', b.leaseId, 300, 300, 0, 'paid'],
    ])
    expect(d.rows[0].payments).toEqual([expect.objectContaining({ paymentId: rem, amount: 495, methodLabel: 'Cash' })])
    expect(d.rows[1].payments).toEqual([expect.objectContaining({ paymentId: rem, amount: 300, methodLabel: 'Cash' })])
  })

  it('account credit that paid the bill is in Paid (of which credit), and the method says so', async () => {
    const p = await park()
    const h = await household(p, 'RV 5', 'Cora Credit')
    const r = await rent(p, h, THIS, 495)
    const credit = (await db.query<{ id: string }>(
      `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category, reason, status, created_by)
       VALUES ($1,$2,$3,495,495,'goodwill','test','active',$4) RETURNING id`, [p.landlordId, h.tenantId, h.leaseId, p.userId])).rows[0].id
    await db.query(
      `INSERT INTO credit_uses (tenant_credit_id, payment_id, lease_id, amount, billing_month, source, status, applied_at)
       VALUES ($1,$2,$3,495,$4::date,'desk','applied',($4::date + interval '8 hours'))`, [credit, r.paymentId, h.leaseId, `${THIS}-01`])
    await db.query(`UPDATE payments SET status = 'settled', settled_at = ($2::date + interval '8 hours') WHERE id = $1`, [r.paymentId, `${THIS}-01`])
    const [row] = (await openMonth(owner(p), p.propertyId)).body.data.rows
    expect(row).toMatchObject({ invoiced: 495, paid: 495, credit: 495, owed: 0, status: 'paid', methods: ['Paid from credit'] })
    expect(row.payments).toEqual([expect.objectContaining({ amount: 495, credit: 495, methodLabel: 'Paid from credit' })])
    expect(row.charges).toEqual([expect.objectContaining({ invoiced: 495, paid: 495, credit: 495, owed: 0 })])
    const hist = (await history(owner(p), p.propertyId, `from=${THIS}&to=${THIS}`)).body.data.rows[0]
    expect(hist).toMatchObject({ invoiced: 495, paid: 495, credit: 495, owed: 0 })
    expect(hist.stamps[0]).toMatchObject({ status: 'paid', paid: 495, credit: 495 })
  })

  it('eviction mode: the row says payments are blocked and opens no desk window', async () => {
    const p = await park()
    const h = await household(p, 'RV 48', 'Evan Evicted', { paymentBlock: true })
    await rent(p, h, THIS, 495)
    const [row] = (await openMonth(owner(p), p.propertyId)).body.data.rows
    expect(row).toMatchObject({ evictionMode: true, owed: 495, recordWith: null })
  })

  it('moved-out people owing from earlier months are not on it; a lease that ended this month with a bill is, marked', async () => {
    const p = await park()
    const gone = await household(p, 'RV 40', 'Owen Owes', { status: 'expired' })
    await rent(p, gone, LAST, 495)                                // owes from last month, moved out
    const left = await household(p, 'RV 41', 'Lou Leaving', { status: 'expired' })
    await rent(p, left, THIS, 495, 1)                             // billed and paid this month, then left
    const d = (await openMonth(owner(p), p.propertyId)).body.data
    expect(d.rows.map((r: any) => [r.space, r.status === 'vacant' ? 'vacant' : r.residents[0]?.name, r.movedOut])).toEqual([
      ['RV 40', 'vacant', false],
      ['RV 41', 'Lou Leaving', true],
      ['RV 41', 'vacant', false],
    ])
    // What Owen still owes is earlier months' — on the Rent Roll's "Moved out, still owes", not here.
    expect(d.rows.find((r: any) => r.residents[0]?.name === 'Lou Leaving')).toMatchObject({ invoiced: 495, paid: 495, status: 'paid' })
  })

  it('a current household\'s earlier balance rides as owedEarlier, apart from the month', async () => {
    const p = await park()
    const h = await household(p, 'RV 5', 'Ernie Earlier')
    await rent(p, h, LAST, 495)
    await rent(p, h, THIS, 495, 1)
    const [row] = (await openMonth(owner(p), p.propertyId)).body.data.rows
    expect(row).toMatchObject({ invoiced: 495, paid: 495, owed: 0, owedEarlier: 495, status: 'paid' })
  })

  // 10/13 (Nic): "outstanding balances are always at the top of this list. And
  // then once it's paid, it drops down and inserts itself in order of space
  // number." A balance from an earlier month is an outstanding balance too.
  it('anything still owed here keeps the row at the top; a balance left on an earlier lease here is a row of its own', async () => {
    const p = await park()
    const pat = await household(p, 'RV 1', 'Pat Paid')
    await rent(p, pat, THIS, 495, 1)
    const ernie = await household(p, 'RV 9', 'Ernie Earlier')
    const sept = await rent(p, ernie, LAST, 495)
    await rent(p, ernie, THIS, 495, 1)
    // Moved from RV 50 to RV 51 here, still owing on the old lease — nothing billed on it this month.
    const mover = await household(p, 'RV 50', 'Max Mover', { status: 'expired' })
    const left = await rent(p, mover, LAST, 300)
    const moved = await household(p, 'RV 51', 'Max Mover', { tenantId: mover.tenantId })
    await rent(p, moved, THIS, 495, 1)
    // Someone who moved out owing is the Rent Roll's "Moved out, still owes", not here.
    const gone = await household(p, 'RV 60', 'Owen Owes', { status: 'expired' })
    await rent(p, gone, LAST, 495)

    const d = (await openMonth(owner(p), p.propertyId)).body.data
    expect(d.rows.map((r: any) => [r.space, r.status === 'vacant' ? 'vacant' : r.residents[0]?.name, r.owed, r.owedEarlier])).toEqual([
      ['RV 9', 'Ernie Earlier', 0, 495],
      ['RV 50', 'Max Mover', 0, 300],
      ['RV 1', 'Pat Paid', 0, 0],
      ['RV 50', 'vacant', 0, 0],
      ['RV 51', 'Max Mover', 0, 0],
      ['RV 60', 'vacant', 0, 0],
    ])
    const row = (space: string, name: string) => d.rows.find((r: any) => r.space === space && r.residents[0]?.name === name)
    // Paid this month, owing an earlier one: the month's pill, the desk window on the oldest open charge.
    expect(row('RV 9', 'Ernie Earlier')).toMatchObject({ status: 'paid', invoiced: 495, paid: 495, recordWith: sept.paymentId })
    // The old lease: no bill this month, its balance beside it, not "moved out" (they live here).
    expect(row('RV 50', 'Max Mover')).toMatchObject({
      leaseId: mover.leaseId, householdId: mover.tenantId, movedOut: false, status: 'none', statusLabel: 'No bill',
      invoiced: 0, paid: 0, owed: 0, owedEarlier: 300, recordWith: left.paymentId, payments: [], charges: [],
    })
    expect(JSON.stringify(d.rows)).not.toContain('Owen Owes')
    expect(d.totals).toMatchObject({ invoiced: 1485, paid: 1485, owed: 0, owedEarlier: 795 })
    // Paid: it drops into its space.
    await db.query(`UPDATE payments SET status = 'settled', manual_method = 'cash', settled_at = NOW() WHERE id = $1`, [sept.paymentId])
    const after = (await openMonth(owner(p), p.propertyId)).body.data
    expect(after.rows.map((r: any) => r.space)).toEqual(['RV 50', 'RV 1', 'RV 9', 'RV 50', 'RV 51', 'RV 60'])
  })

  // 10/13 review: "EVERY space shows, including empty ones as a gray 'Vacant'
  // row" — an occupied space is not empty.
  it('a space with nobody on a lease is Vacant only when empty: the owner\'s own space and a checked-in stay guest say what is there', async () => {
    const p = await park()
    const own = await space(p, 'MH 03')
    await db.query(`UPDATE units SET status = 'owner_use' WHERE id = $1`, [own])
    const stay = await space(p, 'RV 10')
    await db.query(
      `INSERT INTO unit_bookings (unit_id, landlord_id, guest_name, check_in, check_out, status, lease_type)
       VALUES ($1,$2,'Gina Guest',$3::date,$3::date + 30,'checked_in','month_to_month')`, [stay, p.landlordId, `${THIS}-01`])
    // A guest who already checked out leaves the space empty.
    const empty = await space(p, 'RV 11')
    await db.query(
      `INSERT INTO unit_bookings (unit_id, landlord_id, guest_name, check_in, check_out, status, lease_type)
       VALUES ($1,$2,'Carl Checkedout',$3::date,$3::date + 2,'checked_out','nightly')`, [empty, p.landlordId, `${THIS}-01`])
    const d = (await openMonth(owner(p), p.propertyId)).body.data
    expect(d.rows.map((r: any) => [r.key, r.space, r.status, r.statusLabel, r.statusColor, r.occupant])).toEqual([
      [`space:${own}`, 'MH 03', 'occupied', 'Owner Use', 'gray', null],
      [`space:${stay}`, 'RV 10', 'occupied', 'Checked in', 'gray', 'Gina Guest'],
      [`vacant:${empty}`, 'RV 11', 'vacant', 'Vacant', 'gray', null],
    ])
    for (const r of d.rows) {
      expect(r).toMatchObject({ householdId: null, residents: [], recordWith: null, invoiced: 0, owed: 0, owedEarlier: 0, payments: [], charges: [] })
    }
    expect(d.totals).toMatchObject({ invoiced: 0, owed: 0, owedEarlier: 0 })
    // A checked-in guest billed here on no lease is their own row — never the space's row as well.
    const c = await db.connect()
    let guest: string
    try {
      guest = await seedTenant(c)
      await c.query(`UPDATE users SET first_name = 'Gina', last_name = 'Guest' WHERE id = (SELECT user_id FROM tenants WHERE id = $1)`, [guest])
    } finally { c.release() }
    await db.query(`UPDATE unit_bookings SET tenant_id = $2 WHERE unit_id = $1`, [stay, guest])
    await db.query(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, created_at)
       VALUES ($1,$2,$3,'fee',40,'pending',$4::date,'OTHERFEE',$4::date)`, [stay, guest, p.landlordId, `${THIS}-01`])
    const billed = (await openMonth(owner(p), p.propertyId)).body.data
    expect(billed.rows.filter((r: any) => r.space === 'RV 10').map((r: any) => [r.key, r.residents[0]?.name, r.owed]))
      .toEqual([[`person:${guest}`, 'Gina Guest', 40]])
  })

  it('who: "View all payments" or the owner; staff get no sums; a property that is not theirs is a 404', async () => {
    const p = await park()
    const elsewhere = await park('Oak Park Motel and RV', p)
    await rent(p, await household(p, 'RV 48', 'Gerald Logue'), THIS, 495)
    expect((await openMonth(await teamToken(p, 'onsite_manager', { 'balances.view': true, 'payments.view': true }), p.propertyId)).status).toBe(403)
    const staff = await openMonth(await teamToken(p, 'onsite_manager', { 'payments.view_all': true }), p.propertyId)
    expect(staff.status).toBe(200)
    expect(staff.body.data.rows).toHaveLength(1)
    expect(staff.body.data.totals).toBeUndefined()
    const pm = await openMonth(await teamToken(p, 'property_manager', { 'payments.view_all': true }), p.propertyId)
    expect(pm.body.data.totals).toBeDefined()
    const locked = await openMonth(await teamToken(p, 'onsite_manager', { 'payments.view_all': true }, [elsewhere.propertyId]), p.propertyId)
    expect(locked.status).toBe(404)
    expect(JSON.stringify(locked.body)).not.toContain('Gerald')
    const stranger = await park('Someone Else')
    expect((await openMonth(owner(stranger), p.propertyId)).status).toBe(404)
    expect((await get(owner(p), '/api/balances/rent-roll/open-month')).status).toBe(400)
    expect((await get(owner(p), '/api/balances/rent-roll/open-month?propertyId=nope')).status).toBe(400)
  })
})

// ─── The Rent Roll page: the history ────────────────────────────────────────

describe('GET /api/balances/rent-roll/history — the Rent Roll page', () => {
  it('every household billed in the range, in space order, with the range\'s money, health and a stamp per month', async () => {
    const p = await park()
    const partial = await household(p, 'RV 10', 'Paula Partial')
    const late = await household(p, 'RV 2', 'Larry Late')
    const owes = await household(p, 'RV 12', 'Olive Owes')
    const trade = await household(p, 'RV 13', 'Walt Worktrade')
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

    const res = await history(owner(p), p.propertyId, `from=${addMonths(LAST, -1)}&to=${LAST}`)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const d = res.body.data
    expect(d).toMatchObject({ from: addMonths(LAST, -1), to: LAST, allTime: false, months: [addMonths(LAST, -1), LAST] })
    expect(d.rows.map((r: any) => [r.spaces, r.residents[0].name])).toEqual([
      [['RV 2'], 'Larry Late'], [['RV 10'], 'Paula Partial'], [['RV 12'], 'Olive Owes'], [['RV 13'], 'Walt Worktrade'],
    ])
    const row = (name: string) => d.rows.find((r: any) => r.residents[0].name === name)
    const stamp = (name: string, month: string) => row(name).stamps.find((s: any) => s.month === month)
    // RED, never yellow, past grace: part paid with money still owed is "Owes +N" (10/13).
    expect(row('Paula Partial')).toMatchObject({ invoiced: 495, paid: 200, owed: 295 })
    expect(stamp('Paula Partial', LAST)).toMatchObject({ status: 'owes', statusColor: 'red' })
    expect(stamp('Paula Partial', LAST).statusLabel).toMatch(/^Owes \+\d+$/)
    expect(row('Paula Partial').health).toMatchObject({ counted: 1, onTime: 0, partial: 1, percent: 0 })
    // ORANGE: paid in full on the 12th — 7 days past grace; the late fees are Invoiced and Owed, never the color.
    expect(stamp('Larry Late', LAST)).toMatchObject({ status: 'paid_late', daysPastGrace: 7, statusLabel: 'Paid late +7', statusColor: 'orange' })
    expect(row('Larry Late')).toMatchObject({ invoiced: 535, lateFees: 40, paid: 495, owed: 40 })
    // A month of only a late fee is no bill: no stamp, not counted.
    expect(stamp('Larry Late', addMonths(LAST, -1))).toMatchObject({ status: 'none', invoiced: 25 })
    expect(row('Larry Late').health).toMatchObject({ counted: 1, paidLate: 1, percent: 0 })
    // Nothing paid past grace.
    expect(stamp('Olive Owes', LAST)).toMatchObject({ status: 'owes', invoiced: 495, owed: 495 })
    expect(stamp('Olive Owes', addMonths(LAST, -1))).toMatchObject({ status: 'none', invoiced: 0 })
    // GREEN: a month work trade covers in full.
    expect(stamp('Walt Worktrade', LAST)).toMatchObject({ status: 'paid', workTrade: 495, paid: 0, owed: 0 })
    expect(row('Walt Worktrade').health).toMatchObject({ percent: 100, onTime: 1, counted: 1, workTrade: 1 })
    // "Oct: 3 late" — the month's counts.
    const counts = (month: string) => Object.fromEntries(d.monthCounts.find((c: any) => c.month === month).counts.map((c: any) => [c.status, c.households]))
    expect(counts(LAST)).toEqual({ paid: 1, paid_late: 1, partial: 0, owes: 2, due: 0 })
    expect(counts(addMonths(LAST, -1))).toEqual({ paid: 0, paid_late: 0, partial: 0, owes: 0, due: 0 })
    expect(d.totals).toMatchObject({ invoiced: 2020, lateFees: 40, paid: 695, workTrade: 495, owed: 830 })
    expect(d.movedOutOwing).toEqual([])
  })

  it('"Moved out, still owes" whatever the range, until paid; a household that moved to another space here is not moved out', async () => {
    const p = await park()
    const living = await household(p, 'RV 10', 'Lena Living')
    await rent(p, living, THIS, 495, 2)
    const recent = await household(p, 'RV 20', 'Rita Recent', { status: 'expired' })
    await rent(p, recent, addMonths(THIS, -11), 495, 2)                // moved out, paid
    const owen = await household(p, 'RV 40', 'Owen Owes', { status: 'expired' })
    await rent(p, owen, addMonths(THIS, -14), 495)                     // moved out over a year ago, still owes
    await db.query(`UPDATE leases SET end_date = $2 WHERE id = $1`, [owen.leaseId, `${addMonths(THIS, -13)}-15`])
    // Moved from RV 50 to RV 51 here, still owing on the old lease: not "moved out".
    const mover = await household(p, 'RV 50', 'Max Mover', { status: 'expired' })
    await rent(p, mover, LAST, 495)
    await household(p, 'RV 51', 'Max Mover', { tenantId: mover.tenantId })

    const d = (await history(owner(p), p.propertyId, `from=${THIS}&to=${THIS}`)).body.data
    expect(d.rows.map((r: any) => r.residents[0].name)).toEqual(['Lena Living'])
    expect(d.movedOutOwing).toEqual([expect.objectContaining({
      leaseId: owen.leaseId, householdId: owen.tenantId, spaces: ['RV 40'], owed: 495,
      months: [{ month: addMonths(THIS, -14), owed: 495 }], leaseEnded: `${addMonths(THIS, -13)}-15`,
    })])
    expect(d.movedOutOwing[0].residents.map((r: any) => r.name)).toEqual(['Owen Owes'])
    // Owen pays: off the folder.
    await db.query(`UPDATE payments SET status = 'settled', manual_method = 'cash', settled_at = NOW() WHERE lease_id = $1`, [owen.leaseId])
    expect((await history(owner(p), p.propertyId, `from=${THIS}&to=${THIS}`)).body.data.movedOutOwing).toEqual([])
    // All time: every household ever billed here, the moved-out ones marked.
    const all = (await history(owner(p), p.propertyId, 'range=all')).body.data
    expect(all).toMatchObject({ allTime: true, from: addMonths(THIS, -14), to: THIS })
    expect(all.months).toHaveLength(15)
    expect(all.rows.map((r: any) => [r.spaces[0], r.residents[0].name, r.movedOut])).toEqual([
      ['RV 10', 'Lena Living', false], ['RV 20', 'Rita Recent', true], ['RV 40', 'Owen Owes', true], ['RV 50', 'Max Mover', false],
    ])
  })

  // 10/13 (Nic): "Moved-out people who still owe sit in a collapsed 'Moved
  // out, still owes' folder until paid" — there, never a row as well.
  it('someone who moved out still owing is in the folder only, even when billed in the range; paid up, a row again', async () => {
    const p = await park()
    const lena = await household(p, 'RV 10', 'Lena Living')
    await rent(p, lena, LAST, 495, 2)
    const owen = await household(p, 'RV 40', 'Owen Owes', { status: 'expired' })
    const owed = await rent(p, owen, LAST, 495)
    const rita = await household(p, 'RV 20', 'Rita Recent', { status: 'expired' })
    await rent(p, rita, LAST, 495, 2)
    const d = (await history(owner(p), p.propertyId, `from=${LAST}&to=${LAST}`)).body.data
    expect(d.rows.map((r: any) => [r.spaces[0], r.residents[0].name, r.movedOut])).toEqual([
      ['RV 10', 'Lena Living', false], ['RV 20', 'Rita Recent', true],
    ])
    expect(d.movedOutOwing.map((m: any) => [m.spaces, m.residents[0].name, m.owed])).toEqual([[['RV 40'], 'Owen Owes', 495]])
    // The totals and the month's counts are the rows'.
    expect(d.totals).toMatchObject({ invoiced: 990, paid: 990, owed: 0 })
    const counts = Object.fromEntries(d.monthCounts[0].counts.map((c: any) => [c.status, c.households]))
    expect(counts).toMatchObject({ paid: 2, owes: 0, due: 0 })
    // Owen pays: off the folder, a row in the month he was billed.
    await db.query(`UPDATE payments SET status = 'settled', manual_method = 'cash', settled_at = NOW() WHERE id = $1`, [owed.paymentId])
    const paid = (await history(owner(p), p.propertyId, `from=${LAST}&to=${LAST}`)).body.data
    expect(paid.movedOutOwing).toEqual([])
    expect(paid.rows.map((r: any) => r.residents[0].name)).toEqual(['Lena Living', 'Rita Recent', 'Owen Owes'])
  })

  it('payment health counts each lease as its own household', async () => {
    const p = await park()
    const a = await household(p, 'RV 30', 'Hal Twice')
    const b = await household(p, 'RV 31', 'Hal Twice', { tenantId: a.tenantId })
    await rent(p, a, LAST, 495, 2)      // on time
    await rent(p, b, LAST, 300, 12)     // 7 days past grace
    const d = (await history(owner(p), p.propertyId, `from=${LAST}&to=${LAST}`)).body.data
    expect(d.rows.map((r: any) => [r.spaces[0], r.leaseId, r.health.percent, r.stamps[0].status])).toEqual([
      ['RV 30', a.leaseId, 100, 'paid'],
      ['RV 31', b.leaseId, 0, 'paid_late'],
    ])
    // The report a name opens is that lease's.
    const ra = (await report(owner(p), a.tenantId, `?leaseId=${a.leaseId}`)).body.data
    const rb = (await report(owner(p), a.tenantId, `?leaseId=${b.leaseId}`)).body.data
    expect([ra.lease_id, ra.health.percent, ra.leases.map((l: any) => l.unit_number)]).toEqual([a.leaseId, 100, ['RV 30']])
    expect([rb.lease_id, rb.health.percent, rb.leases.map((l: any) => l.unit_number)]).toEqual([b.leaseId, 0, ['RV 31']])
    // Without a lease named it is the person's whole household, as before: one
    // month for both bills, judged together (paid late by the later one).
    const whole = (await report(owner(p), a.tenantId)).body.data
    expect(whole).toMatchObject({ lease_id: null, health: { counted: 1, on_time: 0 } })
    expect(whole.leases.map((l: any) => l.unit_number).sort()).toEqual(['RV 30', 'RV 31'])
  })

  it('refuses a range that is not one; staff locked elsewhere get a 404', async () => {
    const p = await park()
    const q = async (s: string) => (await history(owner(p), p.propertyId, s)).status
    expect(await q(`from=${THIS}&to=${LAST}`)).toBe(400)
    expect(await q(`from=${THIS}`)).toBe(400)
    expect(await q('from=October&to=November')).toBe(400)
    expect(await q('range=forever')).toBe(400)
    expect(await q(`from=${LAST}&to=${THIS}`)).toBe(200)
    const elsewhere = await park('Oak Park Motel and RV', p)
    const locked = await history(await teamToken(p, 'onsite_manager', { 'payments.view_all': true }, [elsewhere.propertyId]), p.propertyId, 'range=all')
    expect(locked.status).toBe(404)
  })

  it('the moved-out setting is gone: its route answers nothing and the column decides nothing', async () => {
    const p = await park()
    const put = await request(buildApp()).put('/api/balances/rent-roll/moved-out').set('Authorization', `Bearer ${owner(p)}`).send({ rule: 'all_time' })
    expect(put.status).toBe(404)
    const old = await get(owner(p), `/api/balances/rent-roll?through=${THIS}`)
    expect(old.status).toBe(404)
  })
})

// ─── 10/6 (Nic): logged by hand after the late fee ───────────────────────────

describe('a payment logged by hand after the late fee posted counts late from the day it was logged (10/6)', () => {
  it('the Rent Roll stamps it paid late, the same as the credit history', async () => {
    const p = await park()
    const h = await household(p, 'RV 7', 'Lou Logged')
    const r = await rent(p, h, LAST, 495)
    // The late fee posted on the 6th (written then)…
    await db.query(
      `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, created_at)
       VALUES ($1,$2,$3,$4,$5,'late_fee',25,'pending',$6::date,'LATEFEE',$6::date + interval '1 hour')`,
      [r.invoiceId, h.unitId, h.leaseId, h.tenantId, p.landlordId, `${LAST}-06`])
    // …then the desk logs the cash now, dated the 2nd.
    await db.query(`UPDATE payments SET status = 'settled', manual_method = 'cash', settled_at = ($2::date + interval '10 hours') WHERE id = $1`,
      [r.paymentId, `${LAST}-02`])
    const d = (await history(owner(p), p.propertyId, `from=${LAST}&to=${LAST}`)).body.data
    expect(d.rows[0].stamps[0].status).toBe('paid_late')
    expect(d.rows[0].stamps[0].daysPastGrace).toBeGreaterThan(0)
    const rep = (await report(owner(p), h.tenantId)).body.data
    const logged = rep.history.find((l: any) => l.label === 'Rent')
    expect(logged).toMatchObject({ logged_after_late_fee: true })
    expect(logged.days_past_grace).toBe(d.rows[0].stamps[0].daysPastGrace)
  })
})

// ─── The tenant payment report ───────────────────────────────────────────────

describe('GET /api/tenants/:id/payment-report', () => {
  it('the household\'s health, every billed month in How late, its lease terms in words and every charge', async () => {
    const p = await park()
    const h = await household(p, 'RV 48', 'Gerald Logue')
    await db.query(`UPDATE leases SET late_fee_enabled = TRUE, late_fee_initial_amount = 0, late_fee_accrual_amount = 5,
                           late_fee_accrual_type = 'flat', late_fee_accrual_period = 'daily', late_fee_accrual_from = 'due_date'
                     WHERE id = $1`, [h.leaseId])
    await rent(p, h, addMonths(THIS, -2), 495, 2)
    await rent(p, h, LAST, 495, 8)
    await rent(p, h, THIS, 495)
    const res = await report(owner(p), h.tenantId)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const r = res.body.data
    expect(r.name).toBe('Gerald Logue')
    expect(r.leases[0]).toMatchObject({ grace_days: 5, grace_source: 'property', unit_number: 'RV 48',
      late_fee_terms: '$5 a day, counted back to the due date once the grace period has passed; no cap' })
    // 10/13 (Nic): every billed month — the one paid on time too — newest first, each with its pill.
    expect(r.how_late.months.map((m: any) => [m.month, m.days_past_grace, m.still_open, m.status])).toEqual([
      [THIS, Math.max(0, PAST_GRACE_NOW), true, PAST_GRACE_NOW > 0 ? 'owes' : 'due'],
      [LAST, 3, false, 'paid_late'],
      [addMonths(THIS, -2), 0, false, 'paid'],
    ])
    expect(r.how_late.months[1]).toMatchObject({ status_label: 'Paid late +3', status_color: 'orange', due_date: `${LAST}-01`, charged: 495, paid: 495, owed: 0 })
    // The pattern is how late they PAY (months paid in full).
    expect(r.how_late.pattern).toBe('Usually 3 days past grace')
    expect(r.health).toMatchObject({ percent: PAST_GRACE_NOW > 0 ? 33 : 50, on_time: 1 })
    // The all-time strip carries the same pills.
    expect(r.stamps.map((s: any) => [s.month, s.status])).toEqual([
      [addMonths(THIS, -2), 'paid'], [LAST, 'paid_late'], [THIS, PAST_GRACE_NOW > 0 ? 'owes' : 'due'],
    ])
    // "What it's for": every charge line, what it is, paid when and how, days past grace.
    expect(r.history.map((l: any) => l.label)).toEqual(['Rent', 'Rent', 'Rent'])
    expect(r.history[1]).toMatchObject({ how_paid: 'Cash', days_past_grace: 3, paid_on: `${LAST}-08`, charged: 495 })
  })

  // 10/13 (Nic): a household is a lease — the report one row opens is that lease's, imported history too.
  it('a report for one lease lists only that lease\'s imported history; a line on no lease is the lease on its space', async () => {
    const p = await park()
    const a = await household(p, 'RV 30', 'Hal Twice')
    const b = await household(p, 'RV 31', 'Hal Twice', { tenantId: a.tenantId })
    const imported = (h: Hh, leaseId: string | null, month: string, ref: string) => db.query(
      `INSERT INTO payments (landlord_id, tenant_id, lease_id, unit_id, type, entry_description, amount, status,
                             due_date, settled_at, processed_at, notes, import_source, imported_at)
       VALUES ($1,$2,$3,$4,'rent','RENT',495,'settled',$5::date,$5::date,$5::date,$6,'buildium',NOW())`,
      [p.landlordId, h.tenantId, leaseId, h.unitId, `${month}-01`, `Imported from buildium. method: Check | ref: ${ref}`])
    await imported(a, a.leaseId, addMonths(LAST, -3), 'A-1')
    await imported(b, b.leaseId, addMonths(LAST, -3), 'B-1')
    await imported(b, null, addMonths(LAST, -4), 'B-2')        // on RV 31, on no lease
    await rent(p, a, LAST, 495, 2)
    await rent(p, b, LAST, 300, 2)
    const one = (await report(owner(p), a.tenantId, `?leaseId=${b.leaseId}`)).body.data
    expect(one.imported.map((l: any) => [l.reference, l.unit_number]).sort()).toEqual([['B-1', 'RV 31'], ['B-2', 'RV 31']])
    const other = (await report(owner(p), a.tenantId, `?leaseId=${a.leaseId}`)).body.data
    expect(other.imported.map((l: any) => l.reference)).toEqual(['A-1'])
    // Without a lease named: the person's whole household, as before.
    const whole = (await report(owner(p), a.tenantId)).body.data
    expect(whole.imported.map((l: any) => l.reference).sort()).toEqual(['A-1', 'B-1', 'B-2'])
  })

  it('a lease the person is not on, or one the viewer cannot see, is a 404; a lease id that is not one is a 400', async () => {
    const p = await park()
    const h = await household(p, 'RV 48', 'Gerald Logue')
    const other = await household(p, 'RV 49', 'Nora Neighbor')
    await rent(p, h, LAST, 495, 2)
    expect((await report(owner(p), h.tenantId, `?leaseId=${other.leaseId}`)).status).toBe(404)
    expect((await report(owner(p), h.tenantId, '?leaseId=not-a-lease')).status).toBe(400)
    const elsewhere = await park('Oak Park Motel and RV', p)
    const locked = await report(await teamToken(p, 'onsite_manager', { 'payments.view_all': true }, [elsewhere.propertyId]), h.tenantId, `?leaseId=${h.leaseId}`)
    expect(locked.status).toBe(404)
  })

  it('staff without "View all payments" are refused; another company never sees it', async () => {
    const p = await park()
    const h = await household(p, 'RV 48', 'Gerald Logue')
    await rent(p, h, THIS, 495)
    expect((await report(await teamToken(p, 'onsite_manager', { 'balances.view': true }), h.tenantId)).status).toBe(403)
    const stranger = await park('Someone Else')
    expect((await report(owner(stranger), h.tenantId)).status).toBe(403)
  })

  it('partials, the daily late fees as one line, work trade and how late', async () => {
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

    const pr = (await report(owner(p), partial.tenantId)).body.data
    expect(pr.partials).toMatchObject({ months: 1, average_first_payment: 200, average_first_percent: 40 })
    expect(pr.partials.open).toEqual([expect.objectContaining({ month: LAST, owed: 295 })])
    // Past grace with money still owed: "Owes +N", not yellow.
    expect(pr.how_late.months[0]).toMatchObject({ month: LAST, status: 'owes', still_open: true })

    const lr = (await report(owner(p), late.tenantId)).body.data
    // How late: 7 days past grace last month, 2 the month before — usually 4.5, range 2–7.
    expect(lr.how_late.months.map((m: any) => [m.month, m.days_past_grace])).toEqual([[LAST, 7], [addMonths(LAST, -1), 2]])
    expect(lr.how_late.pattern).toBe('Usually 4.5 days past grace (2–7)')
    // The three daily late fees are one line, with how many and the days.
    const fees = lr.history.find((x: any) => x.is_late_fee)
    expect(fees).toMatchObject({ late_fee_count: 3, charged: 15, owed: 15, late_fee_from: `${LAST}-06`, late_fee_to: `${LAST}-08` })
    expect(lr.history.filter((x: any) => x.is_late_fee)).toHaveLength(1)
    expect(lr.late_fees).toMatchObject({ charged: 15, owed: 15, months: 1 })

    const wr = (await report(owner(p), trade.tenantId)).body.data
    expect(wr.work_trade).toMatchObject({ months_covered: 1, value_covered: 495 })
    expect(wr.health).toMatchObject({ percent: 100, work_trade: 1 })
    expect(wr.history[0]).toMatchObject({ label: 'Rent', how_paid: 'Work trade', owed: 0 })
    expect(wr.how_late.months).toEqual([expect.objectContaining({ month: LAST, status: 'paid', days_past_grace: 0 })])
  })

  it('a staff member locked to another property finds no history for a resident who never lived there', async () => {
    const p = await park()
    const h = await household(p, 'RV 48', 'Gerald Logue')
    await rent(p, h, LAST, 495, 2)
    const elsewhere = await park('Oak Park Motel and RV', p)
    const res = await report(await teamToken(p, 'onsite_manager', { 'payments.view_all': true }, [elsewhere.propertyId]), h.tenantId)
    expect(res.status).toBe(404)
    expect(JSON.stringify(res.body)).not.toContain('Gerald')
  })
})

describe('the report for a staff member kept to some properties (S655)', () => {
  it('names only the residents who lived there and only the work trade there', async () => {
    const p = await park()
    const other = await park('Oak Park', p)
    const here = await household(p, 'RV 48', 'Gerald Logue')
    await rent(p, here, LAST, 495, 2)
    // The same primary resident on a lease at the other park, with a co-tenant there only.
    const c = await db.connect()
    try {
      const unitId = await seedUnit(c, { propertyId: other.propertyId, landlordId: p.landlordId, rentAmount: 440 })
      const leaseId = await seedLease(c, { unitId, landlordId: p.landlordId, rentAmount: 440, startDate: '2026-01-01' })
      await seedLeaseTenant(c, { leaseId, tenantId: here.tenantId, role: 'primary' })
      const coThere = await seedTenant(c)
      await c.query(`UPDATE users SET first_name = 'Otto', last_name = 'Elsewhere' WHERE id = (SELECT user_id FROM tenants WHERE id = $1)`, [coThere])
      await seedLeaseTenant(c, { leaseId, tenantId: coThere, role: 'co_tenant' })
      await c.query(`INSERT INTO work_trade_agreements (landlord_id, tenant_id, unit_id, status, start_date, covered_charges, monthly_hours_target, tracks_hours)
                     VALUES ($1,$2,$3,'active','2026-01-01',ARRAY['rent'],10,FALSE)`, [p.landlordId, here.tenantId, unitId])
    } finally { c.release() }
    const all = (await report(owner(p), here.tenantId)).body.data
    expect(all.members.map((m: any) => m.name)).toContain('Otto Elsewhere')
    expect(all.work_trade.agreements).toHaveLength(1)
    const locked = await report(await teamToken(p, 'onsite_manager', { 'payments.view_all': true }, [p.propertyId]), here.tenantId)
    expect(locked.status).toBe(200)
    expect(locked.body.data.members.map((m: any) => m.name)).toEqual(['Gerald Logue'])
    expect(locked.body.data.work_trade.agreements).toEqual([])
    expect(locked.body.data.leases.map((l: any) => l.unit_number)).toEqual(['RV 48'])
    // One lease named: that lease's residents and work trade only.
    const one = (await report(owner(p), here.tenantId, `?leaseId=${here.leaseId}`)).body.data
    expect(one.members.map((m: any) => m.name)).toEqual(['Gerald Logue'])
    expect(one.work_trade.agreements).toEqual([])
  })

  // A staff member kept to Park A gets the household of the person's lease AT
  // Park A — never the household of their newer lease at Park B.
  it('a property-locked viewer gets the household of the lease at their property', async () => {
    const p = await park()
    const a1 = await household(p, 'RV 10', 'Anna Primary')
    const otherProp = await park('Oak Park', p)
    const c = await db.connect()
    let xavier: string
    try {
      xavier = await seedTenant(c)
      await c.query(`UPDATE users SET first_name = 'Xavier', last_name = 'Both' WHERE id = (SELECT user_id FROM tenants WHERE id = $1)`, [xavier])
      await seedLeaseTenant(c, { leaseId: a1.leaseId, tenantId: xavier, role: 'co_tenant' })
      const bUnit = await seedUnit(c, { propertyId: otherProp.propertyId, landlordId: p.landlordId, rentAmount: 300 })
      const bLease = await seedLease(c, { unitId: bUnit, landlordId: p.landlordId, rentAmount: 300, startDate: '2026-06-01' })
      await seedLeaseTenant(c, { leaseId: bLease, tenantId: xavier, role: 'primary' })
    } finally { c.release() }
    await rent(p, a1, LAST, 495, 2)
    const locked = await report(await teamToken(p, 'onsite_manager', { 'payments.view_all': true }, [p.propertyId]), xavier)
    expect(locked.status, JSON.stringify(locked.body)).toBe(200)
    expect(locked.body.data.household_id).toBe(a1.tenantId)
    expect(locked.body.data.name).toBe('Anna Primary')
    expect(locked.body.data.members.map((m: any) => m.name).sort()).toEqual(['Anna Primary', 'Xavier Both'])
    expect(locked.body.data.leases.map((l: any) => l.unit_number)).toEqual(['RV 10'])
    expect(locked.body.data.history.map((l: any) => l.charged)).toEqual([495])
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

describe('10/12 review: a month close\'s work trade', () => {
  // What a month close settled is a line too, so the history adds up to the months.
  it('is a line in the report\'s history and on the Rent Roll', async () => {
    const p = await park()
    const h = await household(p, 'RV 13', 'Walt Worktrade')
    const { invoiceId } = await bill(p, h, LAST, [{ type: 'rent', amount: 0, paidDay: 28, notes: 'Covered by work-trade credit' }])
    await db.query(`UPDATE invoices SET work_trade_credit_amount = 460 WHERE id = $1`, [invoiceId])
    const r = (await report(owner(p), h.tenantId)).body.data
    expect(r.history).toEqual([expect.objectContaining({
      label: 'Rent', charged: 460, work_trade: 460, owed: 0, how_paid: 'Work trade', paid_on: `${LAST}-01`, invoice_id: invoiceId })])
    expect(r.work_trade.by_charge).toEqual([{ label: 'Rent', amount: 460 }])
    const row = (await history(owner(p), p.propertyId, `from=${LAST}&to=${LAST}`)).body.data.rows[0]
    expect(row).toMatchObject({ invoiced: 460, workTrade: 460, owed: 0 })
    expect(row.stamps[0]).toMatchObject({ status: 'paid', workTrade: 460 })
  })

  // The Tenants list keeps the payment health from staff the profile keeps it from (S641).
  it('the Tenants list shows the health only to a viewer who may see payment histories', async () => {
    const p = await park()
    const h = await household(p, 'RV 48', 'Gerald Logue')
    await rent(p, h, LAST, 495, 2)
    const healthFor = async (token: string) => ((await get(token, '/api/units')).body.data as any[])
      .find(u => u.tenant_id === h.tenantId).payment_health
    expect(await healthFor(owner(p))).toBe(100)
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
    const tok = owner(p)
    const tenantUser = (await db.query<{ user_id: string }>(`SELECT user_id FROM tenants WHERE id = $1`, [h.tenantId])).rows[0].user_id
    const tenantToken = jwt.sign({ userId: tenantUser, role: 'tenant', email: 't@t.dev', profileId: h.tenantId, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '10m' })

    const list = (await get(tok, '/api/units')).body.data
    const fromList = list.find((u: any) => u.tenant_id === h.tenantId).payment_health
    const profile = (await get(tok, `/api/tenants/${h.tenantId}/profile`)).body.data
    const rollRow = (await history(tok, p.propertyId, `from=${LAST}&to=${THIS}`)).body.data.rows.find((r: any) => r.householdId === h.tenantId)
    const rep = (await report(tok, h.tenantId)).body.data
    const own = (await get(tenantToken, '/api/tenants/me/payment-health')).body.data

    expect(rollRow.health.percent).not.toBeNull()
    expect(fromList).toBe(rollRow.health.percent)
    // The Tenants list's Rent is the lease's ($495) — never the space's listed $589.
    const listRow = list.find((u: any) => u.tenant_id === h.tenantId)
    expect(Number(listRow.lease_rent_amount)).toBe(495)
    expect(Number(listRow.rent_amount)).toBe(589)
    expect(profile.stats.onTimeRate).toBe(rollRow.health.percent)
    expect(profile.stats.health).toMatchObject({ on_time: rollRow.health.onTime, counted: rollRow.health.counted })
    expect(rep.health).toMatchObject({ percent: rollRow.health.percent, on_time: rollRow.health.onTime, counted: rollRow.health.counted })
    expect(own.onTime).toMatchObject({ pct: rollRow.health.percent, onTimeCount: rollRow.health.onTime, resolved: rollRow.health.counted })
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
    const page = (q = '') => get(owner(p), `/api/tenants/${h.tenantId}/profile${q}`)
    const one = (await page()).body.data
    expect(one.payments).toHaveLength(PROFILE_HISTORY_PAGE_SIZE)
    expect(one.paymentsPage).toEqual({ page: 1, pageSize: PROFILE_HISTORY_PAGE_SIZE, total })
    expect(one.payments[0].label).toBe('Late fee')
    const two = (await page('?historyPage=2')).body.data
    expect(two.payments).toHaveLength(extra)
    const ids = [...one.payments, ...two.payments].map((x: any) => x.id)
    expect(new Set(ids).size).toBe(total)
    // Newest due date first across the pages.
    const dues = [...one.payments, ...two.payments].map((x: any) => String(x.due_date).slice(0, 10))
    expect([...dues].sort().reverse()).toEqual(dues)
    expect((await page('?historyPage=0')).status).toBe(400)
  })
})

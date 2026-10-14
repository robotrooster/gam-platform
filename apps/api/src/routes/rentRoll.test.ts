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
import { splitRegisterMoney, registerBillBackOf, unitInName, type RegisterSale } from '../services/rentRoll'

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
    const ginaStay = (await db.query<{ id: string }>(
      `INSERT INTO unit_bookings (unit_id, landlord_id, guest_name, check_in, check_out, status, lease_type)
       VALUES ($1,$2,'Gina Guest',$3::date,$3::date + 30,'checked_in','month_to_month') RETURNING id`, [stay, p.landlordId, `${THIS}-01`])).rows[0].id
    // A guest who already checked out leaves the space empty.
    const empty = await space(p, 'RV 11')
    await db.query(
      `INSERT INTO unit_bookings (unit_id, landlord_id, guest_name, check_in, check_out, status, lease_type)
       VALUES ($1,$2,'Carl Checkedout',$3::date,$3::date + 2,'checked_out','nightly')`, [empty, p.landlordId, `${THIS}-01`])
    const d = (await openMonth(owner(p), p.propertyId)).body.data
    // 10/13 (Nic): a checked-in stay guest is their stay's row ("Checked in"),
    // in the space's place — nothing paid toward it this month here.
    expect(d.rows.map((r: any) => [r.key, r.space, r.status, r.statusLabel, r.statusColor, r.occupant])).toEqual([
      [`space:${own}`, 'MH 03', 'occupied', 'Owner Use', 'gray', null],
      [`stay:${ginaStay}`, 'RV 10', 'stay', 'Checked in', 'gray', 'Gina Guest'],
      [`vacant:${empty}`, 'RV 11', 'vacant', 'Vacant', 'gray', null],
    ])
    for (const r of d.rows) {
      expect(r).toMatchObject({ householdId: null, residents: [], recordWith: null, invoiced: 0, paid: 0, owed: 0, owedEarlier: 0, payments: [], charges: [], delinquent: false })
    }
    expect(d.rows[1].stay).toMatchObject({ bookingId: ginaStay, checkIn: `${THIS}-01`, nights: 30, statusLabel: 'Checked in', refunded: 0, refunds: [] })
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

// ─── 10/13 (Nic): stays, the Delinquent tag, the desk window ─────────────────

/** A stay at a space: its booking (the guest named on it). */
async function stayAt(p: { landlordId: string }, unitId: string, o: {
  guest: string; checkIn: string; nights: number; status: string; leaseType?: string
}) {
  return (await db.query<{ id: string }>(
    `INSERT INTO unit_bookings (unit_id, landlord_id, guest_name, check_in, check_out, status, lease_type)
     VALUES ($1,$2,$3,$4::date,$4::date + $5::int,$6,$7) RETURNING id`,
    [unitId, p.landlordId, o.guest, o.checkIn, o.nights, o.status, o.leaseType ?? 'nightly'])).rows[0].id
}

/** A register sale toward a stay (stayPayments.recordSaleTowardStay's row), noon on `day` in Phoenix. */
async function registerSale(p: { landlordId: string; userId: string; propertyId: string }, bookingId: string, o: {
  method: 'cash' | 'card' | 'check'; toward: number; day: string; payLink?: boolean; balanceLink?: boolean; voided?: boolean
}) {
  const at = `${o.day} 12:00:00-07`
  let linkId: string | null = null
  if (o.payLink) {
    linkId = (await db.query<{ id: string }>(
      `INSERT INTO pos_pay_links (token, landlord_id, property_id, created_by, kind, label, items, subtotal, total, customer_email)
       VALUES ($1,$2,$3,$4,'one_time','Stay','[]'::jsonb,$5,$5,'guest@t.dev') RETURNING id`,
      [randomUUID(), p.landlordId, p.propertyId, p.userId, o.toward])).rows[0].id
    if (o.balanceLink) await db.query(`UPDATE unit_bookings SET balance_pay_link_id = $2 WHERE id = $1`, [bookingId, linkId])
  }
  const pi = o.method === 'card' ? `pi_${randomUUID()}` : null
  const sale = (await db.query<{ id: string }>(
    `INSERT INTO pos_transactions (landlord_id, cashier_id, payment_method, subtotal, total, property_id, pay_link_id,
                                   stripe_payment_intent_id, status, voided_at, created_at)
     VALUES ($1,$2,$3,$4,$4,$5,$6,$7,$8,$9,$10::timestamptz) RETURNING id`,
    [p.landlordId, p.userId, o.method, o.toward, p.propertyId, linkId, pi, o.voided ? 'voided' : 'completed',
     o.voided ? at : null, at])).rows[0].id
  return (await db.query<{ id: string }>(
    `INSERT INTO stay_payments (booking_id, landlord_id, kind, pos_transaction_id, stripe_payment_intent_id, method, toward_stay, paid_at)
     VALUES ($1,$2,'pos_sale',$3,$4,$5,$6,$7::timestamptz) RETURNING id`,
    [bookingId, p.landlordId, sale, pi, o.method, o.toward, at])).rows[0].id
}

/** The booking site's deposit (stayPayments.recordSiteDeposit's row), noon on `day` in Phoenix. */
async function siteDepositOn(p: { landlordId: string }, bookingId: string, toward: number, day: string) {
  return (await db.query<{ id: string }>(
    `INSERT INTO stay_payments (booking_id, landlord_id, kind, stripe_payment_intent_id, method, toward_stay, paid_at)
     VALUES ($1,$2,'site_deposit',$3,'card',$4,$5::timestamptz) RETURNING id`,
    [bookingId, p.landlordId, `pi_${randomUUID()}`, toward, `${day} 12:00:00-07`])).rows[0].id
}

describe('10/13 (Nic): the stays on the Payments page — "show all money coming in"', () => {
  // "The people that paid short-term stays like Space RV 10 and 11 at Mountain
  // View, those should have details of the money that was paid."
  it('each stay paid this month is a row with the money and its details; never in the bills\' Invoiced, Paid or Owed', async () => {
    const p = await park()
    const lena = await household(p, 'RV 1', 'Lena Lease')
    await rent(p, lena, THIS, 495, 1)
    // RV 10: checked in, paid at the desk through a pay link, in cash (Mountain View's RV 10 and 11).
    const rv10 = await space(p, 'RV 10')
    const rhea = await stayAt(p, rv10, { guest: 'Rhea Register', checkIn: `${THIS}-01`, nights: 31, status: 'checked_in', leaseType: 'month_to_month' })
    const rheaPaid = await registerSale(p, rhea, { method: 'cash', toward: 589, day: `${THIS}-01`, payLink: true })
    // RV 11: a guest who came and left this month — the booking site's deposit, then the balance link by card online.
    const rv11 = await space(p, 'RV 11')
    const otto = await stayAt(p, rv11, { guest: 'Otto Online', checkIn: `${THIS}-01`, nights: 2, status: 'checked_out' })
    const ottoDeposit = await siteDepositOn(p, otto, 40, `${THIS}-01`)
    const ottoBalance = await registerSale(p, otto, { method: 'card', toward: 80, day: `${THIS}-01`, payLink: true, balanceLink: true })
    await db.query(`UPDATE pos_transactions SET paid_online = TRUE WHERE id = (SELECT pos_transaction_id FROM stay_payments WHERE id = $1)`, [ottoBalance])
    // RV 12: a stay paid last month only — nothing came in this month: not on it.
    const rv12 = await space(p, 'RV 12')
    const lastStay = await stayAt(p, rv12, { guest: 'Lars Lastmonth', checkIn: `${LAST}-03`, nights: 2, status: 'checked_out' })
    await registerSale(p, lastStay, { method: 'cash', toward: 70, day: `${LAST}-03` })
    // RV 13: checked in; the register sale toward it was voided — it paid nothing.
    const rv13 = await space(p, 'RV 13')
    const vic = await stayAt(p, rv13, { guest: 'Vic Voided', checkIn: `${THIS}-01`, nights: 7, status: 'checked_in', leaseType: 'weekly' })
    await registerSale(p, vic, { method: 'cash', toward: 210, day: `${THIS}-01`, voided: true })
    // RV 14: a stay that became a lease is that lease's household, never a stay row too.
    const rv14 = await space(p, 'RV 14')
    const leased = await stayAt(p, rv14, { guest: 'Lee Leased', checkIn: `${THIS}-01`, nights: 30, status: 'confirmed' })
    await registerSale(p, leased, { method: 'cash', toward: 150, day: `${THIS}-01` })
    const c = await db.connect()
    try {
      await seedLease(c, { unitId: rv14, landlordId: p.landlordId, rentAmount: 589, startDate: `${THIS}-01`, status: 'pending' })
    } finally { c.release() }
    await db.query(`UPDATE leases SET source_booking_id = $2 WHERE unit_id = $1`, [rv14, leased])
    // Another property's stay is never on this one.
    const other = await park('Oak Park Motel and RV', p)
    const elsewhere = await stayAt(other, await space(other, 'RV 10'), { guest: 'Olga Other', checkIn: `${THIS}-01`, nights: 3, status: 'checked_in' })
    await registerSale(other, elsewhere, { method: 'cash', toward: 99, day: `${THIS}-01` })

    const res = await openMonth(owner(p), p.propertyId)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const d = res.body.data
    expect(d.rows.map((r: any) => [r.space, r.key, r.status, r.statusLabel, r.occupant ?? r.residents[0]?.name, r.paid])).toEqual([
      ['RV 1', `lease:${lena.leaseId}`, 'paid', 'Paid', 'Lena Lease', 495],
      ['RV 10', `stay:${rhea}`, 'stay', 'Checked in', 'Rhea Register', 589],
      ['RV 11', `stay:${otto}`, 'stay', 'Checked out', 'Otto Online', 120],
      ['RV 11', `vacant:${rv11}`, 'vacant', 'Vacant', undefined, 0],
      ['RV 12', `vacant:${rv12}`, 'vacant', 'Vacant', undefined, 0],
      ['RV 13', `stay:${vic}`, 'stay', 'Checked in', 'Vic Voided', 0],
      ['RV 14', `vacant:${rv14}`, 'vacant', 'Vacant', undefined, 0],
    ])
    const row = (key: string) => d.rows.find((r: any) => r.key === key)
    const dates = (from: string, nights: number) => {
      const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
      const end = new Date(`${from}T12:00:00Z`); end.setUTCDate(end.getUTCDate() + nights)
      const word = (dt: Date) => `${M[dt.getUTCMonth()]} ${dt.getUTCDate()}`
      return `${word(new Date(`${from}T12:00:00Z`))} – ${word(end)}`
    }
    // The detail: date, amount, method and what it was for.
    expect(row(`stay:${rhea}`)).toMatchObject({
      invoiced: 0, owed: 0, owedEarlier: 0, methods: ['Cash'], recordWith: null, householdId: null, residents: [], charges: [],
      delinquent: false, stay: { bookingId: rhea, checkIn: `${THIS}-01`, nights: 31, statusLabel: 'Checked in', refunded: 0, refunds: [] },
    })
    expect(row(`stay:${rhea}`).payments).toEqual([{
      paymentId: rheaPaid, paidOn: `${THIS}-01`, amount: 589, credit: 0, methodLabel: 'Cash', status: 'settled', statusLabel: 'Settled',
      reference: null, forLabel: `Stay ${dates(`${THIS}-01`, 31)} · pay link`,
    }])
    expect(row(`stay:${otto}`).methods).toEqual(['Card · online'])
    expect(row(`stay:${otto}`).payments.map((x: any) => [x.paymentId, x.amount, x.methodLabel, x.forLabel])).toEqual([
      [ottoDeposit, 40, 'Card · online', `Booking deposit · stay ${dates(`${THIS}-01`, 2)} · booking site`],
      [ottoBalance, 80, 'Card · online', `Stay balance · stay ${dates(`${THIS}-01`, 2)} · pay link`],
    ])
    expect(row(`stay:${vic}`)).toMatchObject({ paid: 0, methods: [], payments: [] })
    expect(JSON.stringify(d.rows)).not.toContain('Olga Other')
    expect(JSON.stringify(d.rows)).not.toContain('Lee Leased')
    // The stays' money is its own total — the bills still add up without it.
    expect(d.totals).toMatchObject({ invoiced: 495, paid: 495, owed: 0, stays: 709, staysRefunded: 0 })
  })

  it('money an early check-out gave back this month shows on the stay\'s row', async () => {
    const p = await park()
    const rv20 = await space(p, 'RV 20')
    const early = await stayAt(p, rv20, { guest: 'Ella Early', checkIn: `${THIS}-01`, nights: 7, status: 'checked_out', leaseType: 'weekly' })
    const sp = await registerSale(p, early, { method: 'cash', toward: 300, day: `${THIS}-01` })
    const decision = (await db.query<{ id: string }>(
      `INSERT INTO stay_checkout_decisions (booking_id, landlord_id, left_on, question, choice, status, booked_price, stayed_worth, paid,
                                            refund_total, decided_at)
       VALUES ($1,$2,$3::date,'overpaid','refund_unused','decided',300,200,300,100,NOW()) RETURNING id`,
      [early, p.landlordId, `${THIS}-01`])).rows[0].id
    const refund = (await db.query<{ id: string }>(
      `INSERT INTO stay_refund_parts (decision_id, booking_id, landlord_id, seq, kind, stay_payment_id, toward_amount, amount,
                                      label, status, refunded_at)
       VALUES ($1,$2,$3,1,'cash',$4,100,100,'Cash · register','handed_back',$5::timestamptz) RETURNING id`,
      [decision, early, p.landlordId, sp, `${THIS}-01 15:00:00-07`])).rows[0].id
    const d = (await openMonth(owner(p), p.propertyId)).body.data
    const row = d.rows.find((r: any) => r.key === `stay:${early}`)
    expect(row).toMatchObject({ paid: 300, statusLabel: 'Checked out' })
    expect(row.stay).toMatchObject({ refunded: 100, refunds: [{ refundId: refund, refundedOn: `${THIS}-01`, amount: 100, label: 'Cash · register' }] })
    expect(d.totals).toMatchObject({ stays: 300, staysRefunded: 100 })
  })

  // 10/13 (Nic): "a 'Delinquent' tag beside the name" — past grace with money
  // still owed here, this month or an earlier month; never late fees alone.
  it('Delinquent: past grace with money owed, this month or earlier; cleared the moment it is paid', async () => {
    const p = await park()
    const early = await household(p, 'RV 1', 'Ernie Earlier')
    const sept = await rent(p, early, LAST, 495)            // last month's bill, past grace
    await rent(p, early, THIS, 495, 1)
    const fees = await household(p, 'RV 2', 'Fay Fees')
    await bill(p, fees, LAST, [{ type: 'rent', amount: 495, paidDay: 1 }, { type: 'late_fee', amount: 5, day: 6 }])
    await rent(p, fees, THIS, 495, 1)
    const now = await household(p, 'RV 3', 'Nat Now')
    await rent(p, now, THIS, 495)
    const paidUp = await household(p, 'RV 4', 'Pat Paid')
    await rent(p, paidUp, THIS, 495, 1)
    const tag = async () => Object.fromEntries((await openMonth(owner(p), p.propertyId)).body.data.rows
      .map((r: any) => [r.residents[0]?.name ?? r.key, r.delinquent]))
    expect(await tag()).toEqual({
      'Ernie Earlier': true,
      // Owes only a late fee: never delinquent (late fees never decide a month's color).
      'Fay Fees': false,
      // This month's bill: delinquent once it is past its grace period.
      'Nat Now': PAST_GRACE_NOW > 0,
      'Pat Paid': false,
    })
    await db.query(`UPDATE payments SET status = 'settled', manual_method = 'cash', settled_at = NOW() WHERE id = $1`, [sept.paymentId])
    expect((await tag())['Ernie Earlier']).toBe(false)
  })

  it('the desk window rides only for a viewer who may take a payment', async () => {
    const p = await park()
    const h = await household(p, 'RV 5', 'Gerald Logue')
    const r = await rent(p, h, THIS, 495)
    const recordWith = async (token: string) => (await openMonth(token, p.propertyId)).body.data.rows[0].recordWith
    expect(await recordWith(owner(p))).toBe(r.paymentId)
    expect(await recordWith(await teamToken(p, 'onsite_manager', { 'payments.view_all': true, take_payment: true }))).toBe(r.paymentId)
    expect(await recordWith(await teamToken(p, 'onsite_manager', { 'payments.view_all': true }))).toBeNull()
  })
})

// ─── 10/13 (Nic): "show ALL money coming in" — the register and pay links ───

/**
 * A register sale or a paid pay link at a property, noon on `day` in Phoenix:
 * its items, how it was paid, who paid, and — when `stays` — its parts toward
 * stays (stay_payments, as stayPayments.recordSaleTowardStay writes them).
 */
async function sale(p: { landlordId: string; userId: string; propertyId: string }, o: {
  method: 'cash' | 'card' | 'check' | 'charge'; total: number; surcharge?: number; day: string; items: string[]
  customer?: string; tenantId?: string; payLink?: { label?: string; customerName?: string | null }; paidOnline?: boolean
  voided?: boolean; stays?: Array<{ bookingId: string; toward: number }>; screening?: number
  /** The sale's line items as the register writes them (else each of `items` at $1). */
  lines?: Array<{ name: string; category?: string; qty: number; price: number; itemId?: string }>
  tax?: number; taxBreakdown?: Array<{ name: string; rate: number; amount: number }>
}) {
  const at = `${o.day} 12:00:00-07`
  let linkId: string | null = null
  if (o.payLink) {
    linkId = (await db.query<{ id: string }>(
      `INSERT INTO pos_pay_links (token, landlord_id, property_id, created_by, kind, label, items, subtotal, total, customer_email,
                                  customer_name, status, paid_at)
       VALUES ($1,$2,$3,$4,'one_time',$5,'[]'::jsonb,$6,$6,'payer@t.dev',$7,'paid',$8::timestamptz) RETURNING id`,
      [randomUUID(), p.landlordId, p.propertyId, p.userId, o.payLink.label ?? 'Pay link', o.total - (o.surcharge ?? 0),
       o.payLink.customerName ?? null, at])).rows[0].id
  }
  let customerId: string | null = null
  if (o.customer) {
    const [first, last] = o.customer.split(' ')
    customerId = (await db.query<{ id: string }>(
      `INSERT INTO pos_customers (landlord_id, first_name, last_name, email, phone) VALUES ($1,$2,$3,'cust.secret@t.dev','602-555-0142') RETURNING id`,
      [p.landlordId, first, last])).rows[0].id
  }
  const pi = o.method === 'card' ? `pi_${randomUUID()}` : null
  const id = (await db.query<{ id: string }>(
    `INSERT INTO pos_transactions (landlord_id, cashier_id, payment_method, subtotal, surcharge, total, property_id, pay_link_id,
                                   stripe_payment_intent_id, status, voided_at, created_at, paid_online, pos_customer_id, tenant_id,
                                   tax_amount, tax_breakdown)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::timestamptz,$13,$14,$15,$16,$17::jsonb) RETURNING id`,
    [p.landlordId, p.userId, o.method, o.total - (o.surcharge ?? 0) - (o.tax ?? 0), o.surcharge ?? 0, o.total, p.propertyId, linkId, pi,
     o.voided ? 'voided' : 'completed', o.voided ? at : null, at, o.paidOnline === true, customerId, o.tenantId ?? null,
     o.tax ?? 0, o.taxBreakdown ? JSON.stringify(o.taxBreakdown) : null])).rows[0].id
  if (o.lines) {
    for (const l of o.lines) {
      await db.query(
        `INSERT INTO pos_transaction_items (transaction_id, item_id, item_name, item_category, qty, unit_price, subtotal)
         VALUES ($1,$2,$3,$4,$5,$6,ROUND($5::numeric * $6::numeric, 2))`, [id, l.itemId ?? null, l.name, l.category ?? 'misc', l.qty, l.price])
    }
  } else {
    for (const name of o.items) {
      await db.query(`INSERT INTO pos_transaction_items (transaction_id, item_name, qty, unit_price, subtotal) VALUES ($1,$2,1,1,1)`, [id, name])
    }
  }
  for (const s of o.stays ?? []) {
    await db.query(
      `INSERT INTO stay_payments (booking_id, landlord_id, kind, pos_transaction_id, stripe_payment_intent_id, method, toward_stay, paid_at)
       VALUES ($1,$2,'pos_sale',$3,$4,$5,$6,$7::timestamptz)`, [s.bookingId, p.landlordId, id, pi, o.method, s.toward, at])
  }
  if (o.screening) {
    await db.query(`INSERT INTO screening_prepayments (landlord_id, property_id, amount, source, source_id) VALUES ($1,$2,$3,'register',$4)`,
      [p.landlordId, p.propertyId, o.screening, id])
  }
  return id
}

/** A refund at the register on a sale (routes/pos refund's row), noon on `day` in Phoenix. */
async function registerRefund(p: { landlordId: string }, saleId: string, amount: number, day: string, method: 'cash' | 'check' = 'cash') {
  return (await db.query<{ id: string }>(
    `INSERT INTO pos_refunds (transaction_id, landlord_id, amount, refund_method, created_at) VALUES ($1,$2,$3,$4,$5::timestamptz) RETURNING id`,
    [saleId, p.landlordId, amount, method, `${day} 12:00:00-07`])).rows[0].id
}

describe('10/13 (Nic): "the payments page ... should show all money coming in" — the register and pay links', () => {
  it('every register sale and pay link that is no bill and no stay is a line with its day, amount, method, what it was for and who', async () => {
    const p = await park()
    const lena = await household(p, 'RV 1', 'Lena Lease')
    await rent(p, lena, THIS, 495, 1)
    // Propane to a walk-in, in cash.
    const propane = await sale(p, { method: 'cash', total: 23.92, day: `${THIS}-01`, items: ['Propane'] })
    // A pay link for a site and its electric, emailed to someone with no lease
    // or stay here (Andres Razo's, RV 27), by card online — the card fee paid
    // on top is not the property's money.
    const link = await sale(p, {
      method: 'card', total: 779.05, surcharge: 26.88, day: `${THIS}-01`, paidOnline: true,
      items: ['RV site — monthly', 'Electric (per kWh)'], payLink: { customerName: 'Andres Razo' },
    })
    // A card swiped at the register by a customer on file.
    const swiped = await sale(p, { method: 'card', total: 4.19, day: `${THIS}-01`, items: ['Propane'], customer: 'Cora Card' })
    // Never money in: a charge account (collected later), a voided sale, last month's, another property's.
    await sale(p, { method: 'charge', total: 30, day: `${THIS}-01`, items: ['Propane'] })
    await sale(p, { method: 'cash', total: 12, day: `${THIS}-01`, items: ['Firewood'], voided: true })
    await sale(p, { method: 'cash', total: 16.18, day: `${LAST}-28`, items: ['Propane'] })
    const oak = await park('Oak Park Motel and RV', p)
    await sale(oak, { method: 'cash', total: 99, day: `${THIS}-01`, items: ['Ice'] })
    // A ticket for a stay and propane: the stay's part is the stay's row, the rest is here.
    const rv10 = await space(p, 'RV 10')
    const rhea = await stayAt(p, rv10, { guest: 'Rhea Register', checkIn: `${THIS}-01`, nights: 7, status: 'checked_in', leaseType: 'weekly' })
    const mixed = await sale(p, { method: 'cash', total: 320, day: `${THIS}-01`, items: ['RV site — weekly', 'Propane'],
      stays: [{ bookingId: rhea, toward: 300 }] })
    // A stay with the guest's background check (GAM's, never the landlord's): nothing else came in.
    const rv11 = await space(p, 'RV 11')
    const sam = await stayAt(p, rv11, { guest: 'Sam Screened', checkIn: `${THIS}-01`, nights: 7, status: 'checked_in', leaseType: 'weekly' })
    await sale(p, { method: 'cash', total: 335, day: `${THIS}-01`, items: ['RV site — weekly', 'Background check'],
      stays: [{ bookingId: sam, toward: 300 }], screening: 35 })

    const res = await openMonth(owner(p), p.propertyId)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const d = res.body.data
    expect(d.otherMoney.map((x: any) => [x.saleId, x.kind, x.day, x.amount, x.methodLabel, x.forLabel, x.who])).toEqual([
      [propane, 'sale', `${THIS}-01`, 23.92, 'Cash', 'Propane · at the register', null],
      [link, 'sale', `${THIS}-01`, 752.17, 'Card · online', 'Electric (per kWh), RV site — monthly · pay link', 'Andres Razo'],
      [swiped, 'sale', `${THIS}-01`, 4.19, 'Card · in person', 'Propane · at the register', 'Cora Card'],
      [mixed, 'sale', `${THIS}-01`, 20, 'Cash', 'Propane, RV site — weekly · at the register · the stay’s part is on its row', null],
    ].sort((a, z) => String(a[0]).localeCompare(String(z[0]))))
    // The stays' money is the stays' rows; the bills still add up on their own.
    expect(d.rows.find((r: any) => r.key === `stay:${rhea}`)).toMatchObject({ paid: 300 })
    expect(d.rows.find((r: any) => r.key === `stay:${sam}`)).toMatchObject({ paid: 300 })
    expect(d.totals).toMatchObject({ invoiced: 495, paid: 495, owed: 0, stays: 600, otherIn: 800.28, otherRefunded: 0 })
    // Names, never contact details.
    expect(JSON.stringify(d)).not.toContain('cust.secret')
    expect(JSON.stringify(d)).not.toContain('602-555-0142')
    expect(JSON.stringify(d)).not.toContain('payer@t.dev')
    // Staff who see the page without the sums get the lines, never the totals.
    const staff = await teamToken(p, 'onsite_manager', { 'payments.view_all': true })
    const theirs = (await openMonth(staff, p.propertyId)).body.data
    expect(theirs.otherMoney).toHaveLength(4)
    expect(theirs.totals).toBeUndefined()
  })

  it('a refund at the register comes off the sale\'s other items first; only what is beyond them goes back from the stay', async () => {
    const p = await park()
    // A stay paid in full at the register, part of it refunded there this month.
    const rv20 = await space(p, 'RV 20')
    const ella = await stayAt(p, rv20, { guest: 'Ella Early', checkIn: `${THIS}-01`, nights: 7, status: 'checked_out', leaseType: 'weekly' })
    const ellaSale = await sale(p, { method: 'cash', total: 300, day: `${THIS}-01`, items: ['RV site — weekly'],
      stays: [{ bookingId: ella, toward: 300 }] })
    const ellaBack = await registerRefund(p, ellaSale, 100, `${THIS}-01`)
    // A stay and propane on one ticket; $80 refunded: $50 is the propane, $30 the stay.
    const rv21 = await space(p, 'RV 21')
    const mo = await stayAt(p, rv21, { guest: 'Mo Mixed', checkIn: `${THIS}-01`, nights: 7, status: 'checked_out', leaseType: 'weekly' })
    const moSale = await sale(p, { method: 'cash', total: 250, day: `${THIS}-01`, items: ['RV site — weekly', 'Propane'],
      stays: [{ bookingId: mo, toward: 200 }] })
    const moBack = await registerRefund(p, moSale, 80, `${THIS}-01`, 'check')
    // A stay paid last month, refunded at the register this month: on the page for the refund.
    const rv22 = await space(p, 'RV 22')
    const lou = await stayAt(p, rv22, { guest: 'Lou Lastmonth', checkIn: `${LAST}-20`, nights: 7, status: 'checked_out', leaseType: 'weekly' })
    const louSale = await sale(p, { method: 'cash', total: 210, day: `${LAST}-20`, items: ['RV site — weekly'],
      stays: [{ bookingId: lou, toward: 210 }] })
    const louBack = await registerRefund(p, louSale, 60, `${THIS}-01`)
    // An early check-out's refund handed back at the register is the stay's own part — counted once, there.
    const rv23 = await space(p, 'RV 23')
    const eve = await stayAt(p, rv23, { guest: 'Eve Checkout', checkIn: `${THIS}-01`, nights: 7, status: 'checked_out', leaseType: 'weekly' })
    const eveSale = await sale(p, { method: 'cash', total: 300, day: `${THIS}-01`, items: ['RV site — weekly'],
      stays: [{ bookingId: eve, toward: 300 }] })
    const eveSp = (await db.query<{ id: string }>(`SELECT id FROM stay_payments WHERE pos_transaction_id = $1`, [eveSale])).rows[0].id
    const decision = (await db.query<{ id: string }>(
      `INSERT INTO stay_checkout_decisions (booking_id, landlord_id, left_on, question, choice, status, booked_price, stayed_worth, paid,
                                            refund_total, decided_at)
       VALUES ($1,$2,$3::date,'overpaid','refund_unused','decided',300,200,300,100,NOW()) RETURNING id`,
      [eve, p.landlordId, `${THIS}-01`])).rows[0].id
    const part = (await db.query<{ id: string }>(
      `INSERT INTO stay_refund_parts (decision_id, booking_id, landlord_id, seq, kind, stay_payment_id, pos_transaction_id, toward_amount,
                                      amount, label, status, refunded_at)
       VALUES ($1,$2,$3,1,'cash',$4,$5,100,100,'Cash · register','handed_back',$6::timestamptz) RETURNING id`,
      [decision, eve, p.landlordId, eveSp, eveSale, `${THIS}-01 15:00:00-07`])).rows[0].id
    await db.query(
      `INSERT INTO pos_refunds (transaction_id, landlord_id, amount, refund_method, stay_refund_part_id, created_at)
       VALUES ($1,$2,100,'cash',$3,$4::timestamptz)`, [eveSale, p.landlordId, part, `${THIS}-01 15:00:00-07`])

    const d = (await openMonth(owner(p), p.propertyId)).body.data
    const stay = (id: string) => d.rows.find((r: any) => r.key === `stay:${id}`)
    expect(stay(ella)).toMatchObject({ paid: 300 })
    expect(stay(ella).stay).toMatchObject({
      refunded: 100, refunds: [{ refundId: ellaBack, refundedOn: `${THIS}-01`, amount: 100, label: 'Cash · refund at the register' }],
    })
    expect(stay(mo)).toMatchObject({ paid: 200 })
    expect(stay(mo).stay).toMatchObject({
      refunded: 30, refunds: [{ refundId: moBack, refundedOn: `${THIS}-01`, amount: 30, label: 'Check · refund at the register' }],
    })
    expect(stay(lou)).toMatchObject({ paid: 0, payments: [] })
    expect(stay(lou).stay).toMatchObject({ refunded: 60, refunds: [{ refundId: louBack, amount: 60 }] })
    expect(stay(eve).stay).toMatchObject({ refunded: 100, refunds: [{ refundId: part, amount: 100, label: 'Cash · register' }] })
    expect(d.otherMoney.map((x: any) => [x.saleId, x.kind, x.amount, x.methodLabel])).toEqual([
      [moSale, 'sale', 50, 'Cash'], [moSale, 'refund', 50, 'Check'],
    ])
    expect(d.otherMoney.find((x: any) => x.kind === 'refund')).toMatchObject({ id: moBack, forLabel: 'Refund at the register · Propane, RV site — weekly' })
    expect(d.totals).toMatchObject({ stays: 800, staysRefunded: 290, otherIn: 50, otherRefunded: 50 })
  })

  it('a stay put on a charge account paid nothing yet: no money on its row, never in the sums', async () => {
    const p = await park()
    const rv30 = await space(p, 'RV 30')
    const cal = await stayAt(p, rv30, { guest: 'Cal Charge', checkIn: `${THIS}-01`, nights: 7, status: 'checked_in', leaseType: 'weekly' })
    await sale(p, { method: 'charge', total: 300, day: `${THIS}-01`, items: ['RV site — weekly'], stays: [{ bookingId: cal, toward: 300 }] })
    // One who left: put on the account, nothing came in — not on the page.
    const rv31 = await space(p, 'RV 31')
    const cy = await stayAt(p, rv31, { guest: 'Cy Charged', checkIn: `${THIS}-01`, nights: 2, status: 'checked_out' })
    await sale(p, { method: 'charge', total: 80, day: `${THIS}-01`, items: ['RV site — nightly'], stays: [{ bookingId: cy, toward: 80 }] })
    const d = (await openMonth(owner(p), p.propertyId)).body.data
    expect(d.rows.find((r: any) => r.key === `stay:${cal}`)).toMatchObject({ paid: 0, methods: [], payments: [], statusLabel: 'Checked in' })
    expect(d.rows.some((r: any) => r.key === `stay:${cy}`)).toBe(false)
    expect(d.otherMoney).toEqual([])
    expect(d.totals).toMatchObject({ stays: 0, otherIn: 0 })
  })
})

describe('splitRegisterMoney: every register dollar in one place', () => {
  it('a refund comes off the sale\'s other items first, then the stays it paid, by their parts; earlier refunds count first', () => {
    const { other, stayRefunds } = splitRegisterMoney([{
      id: 's1', sold_on: '2026-10-02', sold_in_month: true, method: 'cash', paid_online: false, via_link: false,
      base: '330.00', screening: '0', who: null, items: 'Propane, RV site — weekly, RV site — weekly',
      stays: [{ bookingId: 'b1', toward: 200 }, { bookingId: 'b2', toward: 100 }],
      refunds: [
        { id: 'r0', day: '2026-09-30', inMonth: false, net: 10, method: 'cash' },   // last month: $10 of the $30 propane
        { id: 'r1', day: '2026-10-05', inMonth: true, net: 80, method: 'check' },   // $20 propane left, then $60 of the stays
      ],
    }])
    expect(other.map(x => [x.id, x.kind, x.amount])).toEqual([['s1', 'sale', 30], ['r1', 'refund', 20]])
    expect(stayRefunds.get('b1')).toEqual([{ refundId: 'r1:b1', refundedOn: '2026-10-05', amount: 40, label: 'Check · refund at the register' }])
    expect(stayRefunds.get('b2')).toEqual([{ refundId: 'r1:b2', refundedOn: '2026-10-05', amount: 20, label: 'Check · refund at the register' }])
  })

  it('a sale from last month is not this month\'s money; the background check GAM keeps never is', () => {
    const { other } = splitRegisterMoney([
      { id: 'old', sold_on: '2026-09-28', sold_in_month: false, method: 'cash', paid_online: false, via_link: false,
        base: 16.18, screening: 0, who: null, items: 'Propane', stays: [], refunds: [] },
      { id: 'chk', sold_on: '2026-10-02', sold_in_month: true, method: 'card', paid_online: true, via_link: true,
        base: 35, screening: 35, who: 'Sam Screened', items: 'Background check', stays: [], refunds: [] },
    ])
    expect(other).toEqual([])
  })
})

// ─── 10/13 (Nic): "Bookkeepers SEE the Payments and Rent Roll pages, read-only" ─

async function bookkeeperToken(f: { landlordId: string }, propertyIds: string[], o: { companyWide?: boolean; showLeaseDates?: boolean } = {}) {
  const u = (await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1,'x','bookkeeper','Bea','Keeper',TRUE) RETURNING id`, [`bk-${randomUUID()}@t.dev`])).rows[0].id
  await db.query(
    `INSERT INTO bookkeeper_scopes (user_id, landlord_id, access_level, property_ids, company_wide, show_lease_dates)
     VALUES ($1,$2,'read_write',$3,$4,$5)`, [u, f.landlordId, propertyIds, o.companyWide === true, o.showLeaseDates === true])
  return {
    userId: u,
    token: jwt.sign({ userId: u, role: 'bookkeeper', email: 'bk@t.dev', profileId: null, landlordId: f.landlordId, permissions: { access_level: 'read_write' } },
      process.env.JWT_SECRET!, { expiresIn: '10m' }),
  }
}

describe('10/13 (Nic): a bookkeeper sees the Payments page and the Rent Roll, read-only, for their properties', () => {
  it('their property boxes narrow every read; no desk window; contact details never reach them', async () => {
    const p = await park('Mountain View RV Ranch')
    const oak = await park('Oak Park Motel and RV', p)
    const h = await household(p, 'RV 48', 'Gerald Logue')
    await db.query(`UPDATE users SET email = 'gerald.secret@t.dev', phone = '480-555-0199' WHERE id = (SELECT user_id FROM tenants WHERE id = $1)`, [h.tenantId])
    await rent(p, h, THIS, 495)
    await rent(oak, await household(oak, 'MH 03', 'Josh Roby'), THIS, 440)
    const bk = (await bookkeeperToken(p, [p.propertyId])).token

    const props = await get(bk, '/api/balances/rent-roll/properties')
    expect(props.status, JSON.stringify(props.body)).toBe(200)
    expect(props.body.data.map((x: any) => x.name)).toEqual(['Mountain View RV Ranch'])
    const month = await openMonth(bk, p.propertyId)
    expect(month.status).toBe(200)
    expect(month.body.data.rows.map((r: any) => [r.space, r.residents[0]?.name, r.owed, r.recordWith])).toEqual([['RV 48', 'Gerald Logue', 495, null]])
    // decisions #25: bookkeepers see the sums (A/R totals: yes, 10/12).
    expect(month.body.data.totals).toMatchObject({ invoiced: 495, owed: 495 })
    const hist = await history(bk, p.propertyId, `from=${THIS}&to=${THIS}`)
    expect(hist.status).toBe(200)
    expect(hist.body.data.rows.map((r: any) => r.residents[0].name)).toEqual(['Gerald Logue'])
    for (const body of [props.body, month.body, hist.body]) {
      expect(JSON.stringify(body)).not.toContain('gerald.secret')
      expect(JSON.stringify(body)).not.toContain('480-555-0199')
    }
    // A property not ticked for them is not one they can see.
    expect((await openMonth(bk, oak.propertyId)).status).toBe(404)
    expect((await history(bk, oak.propertyId, 'range=all')).status).toBe(404)
    // Never anything else under /api/balances: who owes with contact details, a bill's lines, the Payments ledger.
    expect((await get(bk, '/api/balances')).status).toBe(403)
    expect((await get(bk, `/api/balances/${h.tenantId}/invoices`)).status).toBe(403)
    expect((await get(bk, `/api/balances/payments-by-month?month=${THIS}`)).status).toBe(403)
    expect((await request(buildApp()).post('/api/balances/rent-roll/open-month').set('Authorization', `Bearer ${bk}`)).status).toBe(403)
  })

  it('the lease end date in "Moved out, still owes" follows the owner\'s lease-dates box', async () => {
    const p = await park()
    const owen = await household(p, 'RV 40', 'Owen Owes', { status: 'expired' })
    await rent(p, owen, LAST, 495)
    await db.query(`UPDATE leases SET end_date = $2 WHERE id = $1`, [owen.leaseId, `${LAST}-15`])
    const ended = async (token: string) => (await history(token, p.propertyId, `from=${THIS}&to=${THIS}`)).body.data.movedOutOwing[0].leaseEnded
    expect(await ended((await bookkeeperToken(p, [p.propertyId])).token)).toBeNull()
    expect(await ended((await bookkeeperToken(p, [p.propertyId], { showLeaseDates: true })).token)).toBe(`${LAST}-15`)
    expect(await ended(owner(p))).toBe(`${LAST}-15`)
  })

  // 10/12 (Nic): a property sold out of the company is a CLEAN CUT for its
  // bookkeeper — its history up to the sale, nothing after; one that was never
  // theirs is hidden whole.
  it('the clean cut at a sale: a former property up to its last day, one never theirs not at all', async () => {
    const p = await park('Alder')
    const birch = await park('Birch', p)
    const cedar = await park('Cedar', p)
    const buyer = await park('Buyer Park')
    const al = await household(p, 'RV 1', 'Al Alder')
    await rent(p, al, LAST, 495, 2)
    const ce = await household(cedar, 'RV 9', 'Cy Cedar')
    await rent(cedar, ce, LAST, 300, 2)
    // Bea keeps Alder and Birch, company-wide: the whole company. Cedar was never hers.
    const bea = await bookkeeperToken(p, [p.propertyId, birch.propertyId], { companyWide: true })
    const { transferProperty } = await import('../services/propertyTransfer')
    for (const sold of [p.propertyId, cedar.propertyId]) {
      const t = await transferProperty({ propertyId: sold, fromLandlordId: p.landlordId, toLandlordId: buyer.landlordId, byUserId: p.userId })
      await db.query(`UPDATE property_transfers SET transferred_at = $2::timestamptz WHERE id = $1`, [t.transferId, `${LAST}-20 12:00:00-07`])
      await db.query(`UPDATE bookkeeper_former_properties SET left_at = $2::timestamptz WHERE property_transfer_id = $1`, [t.transferId, `${LAST}-20 12:00:00-07`])
    }
    // The seller's own bill on Alder after the sale: the owner's books, never past Bea's cut.
    await rent(p, al, THIS, 495)
    const props = (await get(bea.token, '/api/balances/rent-roll/properties')).body.data
    expect(props.map((x: any) => [x.name, x.owned])).toEqual([['Alder', false], ['Birch', true]])
    expect((await history(bea.token, cedar.propertyId, 'range=all')).status).toBe(404)
    expect((await openMonth(bea.token, p.propertyId)).status).toBe(404)
    const cut = (await history(bea.token, p.propertyId, `from=${LAST}&to=${THIS}`)).body.data
    expect(cut).toMatchObject({ from: LAST, to: LAST, months: [LAST] })
    expect(cut.rows.map((r: any) => [r.residents[0].name, r.invoiced, r.paid])).toEqual([['Al Alder', 495, 495]])
    expect(cut.totals).toMatchObject({ invoiced: 495, owed: 0 })
    const all = (await history(bea.token, p.propertyId, 'range=all')).body.data
    expect(all).toMatchObject({ allTime: true, to: LAST })
    // The owner reads the seller's whole history there, the later bill included.
    const own = (await history(owner(p), p.propertyId, `from=${LAST}&to=${THIS}`)).body.data
    expect(own.totals).toMatchObject({ invoiced: 990 })
  })
})

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
    // 10/13 (Nic): "Range totals INCLUDE moved-out folder households" — Owen's
    // bill in the range is in the property's Invoiced and Owed; and (round 3:
    // "Rent Roll month counts INCLUDE the moved-out folder") in the month's
    // counts too.
    expect(d.totals).toMatchObject({ invoiced: 1485, paid: 990, owed: 495 })
    // 10/13 review: and says which part is theirs, so the export's Total adds up.
    const zero = { invoiced: 0, lateFees: 0, paid: 0, credit: 0, workTrade: 0, owed: 0 }
    expect(d.movedOutOwing[0].inRange).toEqual({ ...zero, invoiced: 495, owed: 495 })
    expect(d.movedOutTotals).toEqual({ ...zero, invoiced: 495, owed: 495 })
    for (const k of ['invoiced', 'lateFees', 'paid', 'credit', 'workTrade', 'owed'] as const) {
      expect(d.rows.reduce((s: number, r: any) => s + r[k], 0) + d.movedOutTotals[k], k).toBe(d.totals[k])
    }
    const counts = Object.fromEntries(d.monthCounts[0].counts.map((c: any) => [c.status, c.households]))
    expect(counts).toEqual({ paid: 2, paid_late: 0, partial: 0, owes: 1, due: 0 })
    // A folder household billed outside the range adds nothing to it.
    const before = (await history(owner(p), p.propertyId, `from=${addMonths(LAST, -1)}&to=${addMonths(LAST, -1)}`)).body.data
    expect(before.movedOutOwing.map((m: any) => m.residents[0].name)).toEqual(['Owen Owes'])
    expect(Object.fromEntries(before.monthCounts[0].counts.map((c: any) => [c.status, c.households])))
      .toEqual({ paid: 0, paid_late: 0, partial: 0, owes: 0, due: 0 })
    expect(before.totals).toMatchObject({ invoiced: 0, paid: 0, owed: 0 })
    expect(before.movedOutOwing[0].inRange).toEqual(zero)
    expect(before.movedOutTotals).toEqual(zero)
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

  // 10/13 review: the report a name on the Payments page opens says
  // "Delinquent" when the row does — from the money, never the space's
  // overnight flag (it lags a payment until the nightly job runs).
  it('Delinquent is the Payments page\'s rule, lease by lease: past grace with money owed, cleared the moment it is paid', async () => {
    const p = await park()
    const mh23 = await household(p, 'MH 23', 'Arturo Melendez')
    const sept = await rent(p, mh23, LAST, 525)                      // past grace, unpaid
    const mh15 = await household(p, 'MH 15', 'Arturo Melendez', { tenantId: mh23.tenantId })
    await rent(p, mh15, LAST, 460, 2)
    const pat = await household(p, 'MH 24', 'Pat Paid')
    await rent(p, pat, LAST, 525, 2)
    // The spaces' overnight flags say the opposite.
    await db.query(`UPDATE units SET status = 'active' WHERE id = $1`, [mh23.unitId])
    await db.query(`UPDATE units SET status = 'delinquent' WHERE id = ANY($1::uuid[])`, [[mh15.unitId, pat.unitId]])
    const flags = async (h: Hh, q = '') => Object.fromEntries((await report(owner(p), h.tenantId, q)).body.data.leases
      .map((l: any) => [l.unit_number, l.delinquent]))
    expect(await flags(mh23)).toEqual({ 'MH 23': true, 'MH 15': false })
    expect(await flags(mh23, `?leaseId=${mh23.leaseId}`)).toEqual({ 'MH 23': true })
    expect(await flags(mh23, `?leaseId=${mh15.leaseId}`)).toEqual({ 'MH 15': false })
    expect(await flags(pat)).toEqual({ 'MH 24': false })
    const rowOf = async (leaseId: string) => (await openMonth(owner(p), p.propertyId)).body.data.rows.find((r: any) => r.leaseId === leaseId)
    expect((await rowOf(mh23.leaseId)).delinquent).toBe(true)
    // MH 23 pays this morning: the row and the report drop it at once.
    await db.query(`UPDATE payments SET status = 'settled', manual_method = 'cash', settled_at = NOW() WHERE id = $1`, [sept.paymentId])
    expect(await flags(mh23, `?leaseId=${mh23.leaseId}`)).toEqual({ 'MH 23': false })
    expect((await rowOf(mh23.leaseId)).delinquent).toBe(false)
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

// 10/13 (Nic): "Tenants list + tenant profile: split health BY LEASE."
describe('the Tenants list and the profile split payment health by lease', () => {
  it('a person on two leases reads each lease\'s own health on its row and on the profile — the Rent Roll\'s figures', async () => {
    const p = await park()
    const a = await household(p, 'RV 30', 'Hal Twice')
    const b = await household(p, 'RV 31', 'Hal Twice', { tenantId: a.tenantId })
    await rent(p, a, LAST, 495, 2)      // on time
    await rent(p, b, LAST, 300, 12)     // 7 days past grace
    const solo = await household(p, 'RV 40', 'Sol Single')
    await rent(p, solo, LAST, 495, 2)
    const rows = (await history(owner(p), p.propertyId, `from=${LAST}&to=${LAST}`)).body.data.rows
    const rollPct = (leaseId: string) => rows.find((r: any) => r.leaseId === leaseId).health.percent

    const list = await get(owner(p), '/api/tenants/health-by-unit')
    expect(list.status, JSON.stringify(list.body)).toBe(200)
    const byUnit = Object.fromEntries(list.body.data.map((x: any) => [x.unitId, [x.leaseId, x.percent]]))
    expect(byUnit).toEqual({
      [a.unitId]: [a.leaseId, rollPct(a.leaseId)],
      [b.unitId]: [b.leaseId, rollPct(b.leaseId)],
      [solo.unitId]: [solo.leaseId, rollPct(solo.leaseId)],
    })
    expect([byUnit[a.unitId][1], byUnit[b.unitId][1]]).toEqual([100, 0])

    const profile = (await get(owner(p), `/api/tenants/${a.tenantId}/profile`)).body.data
    expect(profile.stats.healthByLease.map((l: any) => [l.unit_number, l.lease_id, l.current, l.health?.percent]).sort())
      .toEqual([['RV 30', a.leaseId, true, 100], ['RV 31', b.leaseId, true, 0]])
    expect(profile.stats.healthByLease.find((l: any) => l.lease_id === a.leaseId).health)
      .toMatchObject({ on_time: 1, counted: 1, label: '100%, 1 of 1 month' })

    // Who: as the list's column always was — staff without the payment permissions get nothing.
    expect((await get(await teamToken(p, 'onsite_manager', { 'balances.view': true }), '/api/tenants/health-by-unit')).body.data).toEqual([])
    const staff = (await get(await teamToken(p, 'onsite_manager', { 'payments.view_all': true }), '/api/tenants/health-by-unit')).body.data
    expect(staff).toHaveLength(3)
    // A staff member kept to another property sees none of these spaces.
    const elsewhere = await park('Oak Park Motel and RV', p)
    expect((await get(await teamToken(p, 'onsite_manager', { 'payments.view_all': true }, [elsewhere.propertyId]), '/api/tenants/health-by-unit')).body.data).toEqual([])
    // Another company never.
    const stranger = await park('Stranger Park')
    expect((await get(owner(stranger), '/api/tenants/health-by-unit')).body.data).toEqual([])
  })

  // 10/13 review: Arturo Melendez's new MH 15 lease (waiting for signatures)
  // read "Ended" beside his MH 23. Each lease says where it stands.
  it('each lease carries its own status — one not signed yet is pending, never ended', async () => {
    const p = await park()
    const mh23 = await household(p, 'MH 23', 'Arturo Melendez')
    await rent(p, mh23, LAST, 525, 2)
    const mh15 = await household(p, 'MH 15', 'Arturo Melendez', { tenantId: mh23.tenantId })
    await db.query(`UPDATE leases SET status = 'pending' WHERE id = $1`, [mh15.leaseId])
    const old = await household(p, 'MH 09', 'Arturo Melendez', { tenantId: mh23.tenantId, status: 'expired' })
    await rent(p, old, addMonths(LAST, -1), 525, 2)
    const profile = (await get(owner(p), `/api/tenants/${mh23.tenantId}/profile`)).body.data
    const leases = profile.stats.healthByLease.map((l: any) => [l.unit_number, l.status, l.current])
    expect(leases).toHaveLength(3)
    expect(leases).toEqual(expect.arrayContaining([['MH 15', 'pending', false], ['MH 09', 'expired', false]]))
    // The current lease first.
    expect(leases[0]).toEqual(['MH 23', 'active', true])
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

// ─── 10/13 (Nic), round 3 ────────────────────────────────────────────────────

describe('10/13 (Nic), round 3: "Stay rows SHOW what\'s still owed"', () => {
  /** A one-time pay link for a stay's balance (services/stayBalance's), billed on `day` and unpaid. */
  async function balanceLink(p: { landlordId: string; userId: string; propertyId: string }, bookingId: string, amount: number,
                             day: string, status: 'open' | 'expired' | 'cancelled' = 'open') {
    const id = (await db.query<{ id: string }>(
      `INSERT INTO pos_pay_links (token, landlord_id, property_id, created_by, kind, label, items, subtotal, total, customer_email, booking_id, status)
       VALUES ($1,$2,$3,$4,'one_time','Stay balance','[]'::jsonb,$5,$5,'guest@t.dev',$6,$7) RETURNING id`,
      [randomUUID(), p.landlordId, p.propertyId, p.userId, amount, bookingId, status])).rows[0].id
    await db.query(`UPDATE unit_bookings SET balance_billed_at = $2::timestamptz, balance_pay_link_id = $3 WHERE id = $1`,
      [bookingId, `${day} 07:00:00-07`, id])
    return id
  }

  it('a stay row says what is still owed on it; what is owed now — billed, or from arrival day — is its Owed, at the top, money this month or not', async () => {
    const p = await park()
    const lena = await household(p, 'RV 1', 'Lena Lease')
    await rent(p, lena, THIS, 495, 1)
    // RV 30: booked online last month ($120 deposit then); the $360 balance billed on its pay link on arrival this month, still open.
    const rv30 = await space(p, 'RV 30')
    const bea = await stayAt(p, rv30, { guest: 'Bea Balance', checkIn: `${THIS}-01`, nights: 7, status: 'confirmed', leaseType: 'weekly' })
    await siteDepositOn(p, bea, 120, `${LAST}-20`)
    await db.query(`UPDATE unit_bookings SET total_amount = 480, deposit_amount = 120, deposit_paid_at = $2::timestamptz WHERE id = $1`,
      [bea, `${LAST}-20 12:00:00-07`])
    await balanceLink(p, bea, 360, `${THIS}-01`)
    // RV 31: paid in full at the register this month — nothing owed.
    const rv31 = await space(p, 'RV 31')
    const paul = await stayAt(p, rv31, { guest: 'Paul Paidup', checkIn: `${THIS}-01`, nights: 7, status: 'checked_in', leaseType: 'weekly' })
    await registerSale(p, paul, { method: 'cash', toward: 300, day: `${THIS}-01` })
    await db.query(`UPDATE unit_bookings SET total_amount = 300, balance_paid_at = $2::timestamptz WHERE id = $1`, [paul, `${THIS}-01 12:00:00-07`])
    // RV 33: a deposit paid this month for a stay not here yet — the rest is still owed, but not until arrival
    // (S649: the balance generates on arrival day).
    const rv33 = await space(p, 'RV 33')
    const dee = await stayAt(p, rv33, { guest: 'Dee Deposit', checkIn: `${addMonths(THIS, 1)}-03`, nights: 4, status: 'confirmed' })
    await siteDepositOn(p, dee, 50, `${THIS}-01`)
    await db.query(`UPDATE unit_bookings SET total_amount = 200, deposit_amount = 50, deposit_paid_at = $2::timestamptz WHERE id = $1`,
      [dee, `${THIS}-01 12:00:00-07`])
    // RV 32: canceled with its balance link never paid — owed by nobody, not on the page.
    const rv32 = await space(p, 'RV 32')
    const cy = await stayAt(p, rv32, { guest: 'Cy Canceled', checkIn: `${THIS}-01`, nights: 7, status: 'cancelled', leaseType: 'weekly' })
    await db.query(`UPDATE unit_bookings SET total_amount = 480, deposit_amount = 120, deposit_paid_at = $2::timestamptz WHERE id = $1`,
      [cy, `${LAST}-20 12:00:00-07`])
    await balanceLink(p, cy, 360, `${THIS}-01`)
    // RV 34: a billed balance whose link was canceled — not shown as owed here.
    const rv34 = await space(p, 'RV 34')
    const kit = await stayAt(p, rv34, { guest: 'Kit Linkcanceled', checkIn: `${THIS}-01`, nights: 7, status: 'checked_out', leaseType: 'weekly' })
    await db.query(`UPDATE unit_bookings SET total_amount = 480, deposit_amount = 120, deposit_paid_at = $2::timestamptz WHERE id = $1`,
      [kit, `${LAST}-20 12:00:00-07`])
    await balanceLink(p, kit, 360, `${THIS}-01`, 'cancelled')
    // RV 35: a stay that is over, its balance link unpaid, nothing paid this month — not on the open month,
    // as a household that moved out is not.
    const rv35 = await space(p, 'RV 35')
    const olaf = await stayAt(p, rv35, { guest: 'Olaf Over', checkIn: `${LAST}-20`, nights: 7, status: 'checked_out', leaseType: 'weekly' })
    await db.query(`UPDATE unit_bookings SET total_amount = 480, deposit_amount = 120, deposit_paid_at = $2::timestamptz WHERE id = $1`,
      [olaf, `${LAST}-10 12:00:00-07`])
    await balanceLink(p, olaf, 360, `${LAST}-20`)
    // RV 36: here since the 1st, its deposit paid last month, its balance never billed (no email to send it to) — owed now.
    const rv36 = await space(p, 'RV 36')
    const hal = await stayAt(p, rv36, { guest: 'Hal Here', checkIn: `${THIS}-01`, nights: 7, status: 'checked_in', leaseType: 'weekly' })
    await siteDepositOn(p, hal, 100, `${LAST}-20`)
    await db.query(`UPDATE unit_bookings SET total_amount = 300, deposit_amount = 100, deposit_paid_at = $2::timestamptz WHERE id = $1`,
      [hal, `${LAST}-20 12:00:00-07`])

    const res = await openMonth(owner(p), p.propertyId)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const d = res.body.data
    const row = (key: string) => d.rows.find((r: any) => r.key === key)
    // Owing now first — the stays owing now, in space order — then every other row in its spot.
    expect(d.rows.slice(0, 2).map((r: any) => [r.key, r.space, r.status, r.occupant, r.paid, r.owed, r.invoiced])).toEqual([
      [`stay:${bea}`, 'RV 30', 'stay', 'Bea Balance', 0, 360, 0],
      [`stay:${hal}`, 'RV 36', 'stay', 'Hal Here', 0, 200, 0],
    ])
    expect(row(`stay:${bea}`).stay).toMatchObject({ owed: 360, balanceBilledOn: `${THIS}-01`, statusLabel: 'Confirmed' })
    expect(row(`stay:${hal}`).stay).toMatchObject({ owed: 200, balanceBilledOn: null, statusLabel: 'Checked in' })
    // Dee: the rest of her stay is shown on the stay, owed from her arrival — nothing owed now, so in its spot.
    expect(row(`stay:${dee}`)).toMatchObject({ paid: 50, owed: 0, stay: { owed: 150, balanceBilledOn: null, checkIn: `${addMonths(THIS, 1)}-03` } })
    const keys = d.rows.map((r: any) => r.key)
    expect(keys.indexOf(`stay:${dee}`)).toBeGreaterThan(keys.indexOf(`stay:${paul}`))
    expect(row(`stay:${paul}`)).toMatchObject({ paid: 300, owed: 0, stay: { owed: 0, balanceBilledOn: null } })
    expect(row(`stay:${cy}`)).toBeUndefined()
    expect(row(`stay:${kit}`)).toBeUndefined()
    expect(row(`stay:${olaf}`)).toBeUndefined()
    // A stay is never a delinquent household, and the desk never takes its money.
    expect(row(`stay:${bea}`)).toMatchObject({ delinquent: false, recordWith: null })
    // The stays' Owed is its own sum; the bills still add up without it.
    expect(d.totals).toMatchObject({ invoiced: 495, paid: 495, owed: 0, stays: 350, staysOwed: 560 })
  })
})

describe('10/13 (Nic), round 3: "Pay links / register sales that name a space go ON that space\'s row"', () => {
  it('a sale whose words name one of the property\'s spaces is on that space\'s row; only money with no space stays in the folder', async () => {
    const p = await park()
    const lena = await household(p, 'RV 1', 'Lena Lease')
    await rent(p, lena, THIS, 495, 1)
    const rv2 = await space(p, 'RV 2')
    const rv27 = await space(p, 'RV 27')
    // Andres Razo's pay link — a month and September's electric at RV 27 (empty now), by card online.
    const andres = await sale(p, {
      method: 'card', total: 779.05, surcharge: 26.88, day: `${THIS}-01`, paidOnline: true,
      items: ['RV site — monthly', 'Electric (per kWh)', 'Electric (per kWh) — September, RV 27'], payLink: { customerName: 'Andres Razo' },
    })
    const back = await registerRefund(p, andres, 10, `${THIS}-02`)
    // A sale naming Lena's space ("rv01" is RV 1): on her household's row, beside her bills.
    const lenas = await sale(p, { method: 'cash', total: 20, day: `${THIS}-02`, items: ['Propane — rv01'] })
    // A stay paid on a ticket naming its site, with propane: the propane is on the stay's row too.
    const rv10 = await space(p, 'RV 10')
    const rhea = await stayAt(p, rv10, { guest: 'Rhea Register', checkIn: `${THIS}-01`, nights: 7, status: 'checked_in', leaseType: 'weekly' })
    const ticket = await sale(p, { method: 'cash', total: 320, day: `${THIS}-01`, items: ['RV site — weekly — 7 nights at site RV 10', 'Propane'],
      stays: [{ bookingId: rhea, toward: 300 }] })
    // The folder: propane to a walk-in (no space), a sale naming two spaces, a space that is not this property's.
    const walkIn = await sale(p, { method: 'cash', total: 23.92, day: `${THIS}-01`, items: ['Propane'] })
    const two = await sale(p, { method: 'cash', total: 40, day: `${THIS}-01`, items: ['Electric — RV 2 and RV 27'] })
    const elsewhere = await sale(p, { method: 'cash', total: 15, day: `${THIS}-01`, items: ['Water — RV 99'] })

    const res = await openMonth(owner(p), p.propertyId)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const d = res.body.data
    const row = (key: string) => d.rows.find((r: any) => r.key === key)
    // RV 27 stays a gray Vacant row in its spot — its money is on it, never Invoiced, Paid or Owed.
    expect(row(`vacant:${rv27}`)).toMatchObject({ status: 'vacant', invoiced: 0, paid: 0, owed: 0, otherIn: 752.17, otherRefunded: 10 })
    expect(row(`vacant:${rv27}`).otherMoney.map((x: any) => [x.id, x.saleId, x.kind, x.amount, x.methodLabel, x.who])).toEqual([
      [andres, andres, 'sale', 752.17, 'Card · online', 'Andres Razo'],
      [back, andres, 'refund', 10, 'Cash', 'Andres Razo'],
    ])
    // RV 2 is not RV 27.
    expect(row(`vacant:${rv2}`)).toMatchObject({ otherMoney: [], otherIn: 0, otherRefunded: 0 })
    expect(row(`lease:${lena.leaseId}`)).toMatchObject({ invoiced: 495, paid: 495, owed: 0, otherIn: 20 })
    expect(row(`lease:${lena.leaseId}`).otherMoney.map((x: any) => x.saleId)).toEqual([lenas])
    expect(row(`stay:${rhea}`)).toMatchObject({ paid: 300, otherIn: 20 })
    expect(row(`stay:${rhea}`).otherMoney.map((x: any) => x.saleId)).toEqual([ticket])
    expect(d.otherMoney.map((x: any) => x.saleId).sort()).toEqual([walkIn, two, elsewhere].sort())
    // All of it is the month's register money; of it, the folder's is apart.
    expect(d.totals).toMatchObject({
      invoiced: 495, paid: 495, owed: 0, stays: 300,
      otherIn: 871.09, otherRefunded: 10, folderIn: 78.92, folderRefunded: 0,
    })
    // Staff without the sums still get every line where it belongs.
    const staff = (await openMonth(await teamToken(p, 'onsite_manager', { 'payments.view_all': true }), p.propertyId)).body.data
    expect(staff.rows.find((r: any) => r.key === `vacant:${rv27}`).otherMoney).toHaveLength(2)
    expect(staff.otherMoney).toHaveLength(3)
    expect(staff.totals).toBeUndefined()
  })
})

// 10/13 (Nic): "When Andres Razo paid by card online for his stay ... it looks
// like that charge is just for electric. It's not ... not clickable to show an
// expanded breakdown ... It's not got a good breakdown between what's a
// billback on the electricity and what is not."
describe('10/13 (Nic): a register sale or pay link carries its breakdown', () => {
  // Andres Razo's pay link as production has it (read-only, 10/13): Oct 6, card
  // online, $752.17 + a $26.88 card fee = $779.05; its three line items.
  const ANDRES: RegisterSale = {
    id: 'ff58520a', sold_on: '2026-10-06', sold_in_month: true, method: 'card', paid_online: true, via_link: true,
    base: '752.17', screening: '0', who: 'Andres Razo',
    items: 'Electric (per kWh), Electric (per kWh) — September, RV 27, RV site — monthly', stays: [], refunds: [],
    lines: [
      { name: 'Electric (per kWh)', category: 'Utilities', qty: 387, unitPrice: 0.21, subtotal: 81.27, stayUnit: null },
      { name: 'Electric (per kWh) — September, RV 27', category: 'Utilities', qty: 390, unitPrice: 0.21, subtotal: 81.9, stayUnit: null },
      { name: 'RV site — monthly', category: 'Stays', qty: 1, unitPrice: 589, subtotal: 589, stayUnit: 'month' },
    ],
    tax: '0.00', taxes: null, discount: '0.00', discount_reason: null, card_fee: '26.88',
  }
  const sum = (parts: Array<{ amount: number }>) => Math.round(parts.reduce((t, x) => t + Math.round(x.amount * 100), 0)) / 100

  it('Andres Razo\'s $752.17: two electric bill-backs apart from the month\'s site rent, each its own amount; the card fee apart', () => {
    const [line] = splitRegisterMoney([ANDRES]).other
    expect(line).toMatchObject({ kind: 'sale', amount: 752.17, cardFee: 26.88 })
    expect(line.parts).toEqual([
      { kind: 'item', label: 'Electric (per kWh)', what: 'Electric bill-back', qty: 387, unitPrice: 0.21, unit: 'kWh', amount: 81.27 },
      { kind: 'item', label: 'Electric (per kWh) — September, RV 27', what: 'Electric bill-back', qty: 390, unitPrice: 0.21, unit: 'kWh', amount: 81.9 },
      { kind: 'item', label: 'RV site — monthly', what: 'Site rent', qty: 1, unitPrice: 589, unit: null, amount: 589 },
    ])
    expect(sum(line.parts!)).toBe(752.17)
  })

  it('propane at the counter is no bill-back; its named tax is its own part; the parts add up to the line', () => {
    // Production, Oct 6: 6.8 gal at $3.30 + $1.48 transaction privilege tax, cash.
    const [line] = splitRegisterMoney([{
      id: '37fe8a03', sold_on: '2026-10-06', sold_in_month: true, method: 'cash', paid_online: false, via_link: false,
      base: '23.92', screening: '0', who: null, items: 'Propane', stays: [], refunds: [],
      lines: [{ name: 'Propane', category: 'Utilities', qty: 6.8, unitPrice: 3.3, subtotal: 22.44, stayUnit: null }],
      tax: '1.48', taxes: [{ name: 'Transaction privilege tax', amount: 1.48 }], discount: '0', card_fee: '0',
    }]).other
    expect(line.parts).toEqual([
      { kind: 'item', label: 'Propane', what: null, qty: 6.8, unitPrice: 3.3, unit: null, amount: 22.44 },
      { kind: 'tax', label: 'Transaction privilege tax', what: null, qty: null, unitPrice: null, unit: null, amount: 1.48 },
    ])
    expect(line).toMatchObject({ amount: 23.92, cardFee: 0 })
  })

  it('what comes off is said as its own part — a discount, the background check, the stay\'s part — so the parts still add up', () => {
    const { other } = splitRegisterMoney([{
      id: 's9', sold_on: '2026-10-02', sold_in_month: true, method: 'cash', paid_online: false, via_link: false,
      base: '361.00', screening: '35', who: 'Sam', items: 'Background check, Propane, RV site — weekly',
      stays: [{ bookingId: 'b1', toward: 300 }], refunds: [],
      lines: [
        { name: 'Background check', category: 'Fee', qty: 1, unitPrice: 35, subtotal: 35 },
        { name: 'Propane', category: 'Utilities', qty: 10, unitPrice: 3.3, subtotal: 33 },
        { name: 'RV site — weekly', category: 'Stays', qty: 1, unitPrice: 300, subtotal: 300, stayUnit: 'week' },
      ],
      tax: '0', taxes: null, discount: '7.00', discount_reason: 'Neighbor', card_fee: '0',
    }])
    const sale = other[0]
    expect(sale.amount).toBe(26)
    expect(sale.parts!.map(x => [x.kind, x.label, x.amount])).toEqual([
      ['item', 'Background check', 35], ['item', 'Propane', 33], ['item', 'RV site — weekly', 300],
      ['discount', 'Discount · Neighbor', -7],
      ['screening', 'Background check — the screening’s, not yours', -35],
      ['stay', 'Toward the stay — on the stay’s row', -300],
    ])
    expect(sum(sale.parts!)).toBe(26)
  })

  it('a sale whose lines do not show all of its total says the rest; a refund has no breakdown', () => {
    const { other } = splitRegisterMoney([{
      id: 's1', sold_on: '2026-10-02', sold_in_month: true, method: 'cash', paid_online: false, via_link: false,
      base: '50', screening: '0', who: null, items: 'Laundry', stays: [],
      refunds: [{ id: 'r1', day: '2026-10-03', inMonth: true, net: 5, method: 'cash' }],
      lines: [{ name: 'Laundry', category: 'Laundry', qty: 2, unitPrice: 20, subtotal: 40 }],
    }])
    expect(other[0].parts!.map(x => [x.kind, x.label, x.amount])).toEqual([['item', 'Laundry', 40], ['rest', 'Rest of the sale', 10]])
    expect(other[1]).toMatchObject({ kind: 'refund', parts: [], cardFee: 0 })
  })

  it('a bill-back is the utility recovery report\'s rule: a utilities item naming its utility', () => {
    expect(registerBillBackOf('Utilities', 'Electric (per kWh) — September, RV 27')).toBe('electric')
    expect(registerBillBackOf('utilities', 'Water — RV 4')).toBe('water')
    expect(registerBillBackOf('Utilities', 'Sewer')).toBe('sewer')
    expect(registerBillBackOf('Utilities', 'Garbage pickup')).toBe('trash')
    expect(registerBillBackOf('Utilities', 'Gas meter')).toBe('gas')
    expect(registerBillBackOf('Utilities', 'Propane')).toBeNull()
    expect(registerBillBackOf('Utilities', 'Gasoline can')).toBeNull()
    expect(registerBillBackOf('Fuel', 'Electric scooter charge')).toBeNull()
    expect(registerBillBackOf(null, 'Electric')).toBeNull()
    expect(unitInName('Electric (per kWh)')).toBe('kWh')
    expect(unitInName('Propane (per gal)')).toBe('gal')
    expect(unitInName('RV site — monthly')).toBeNull()
  })

  it('the open month sends each sale\'s parts and card fee, on the row of the space it names and in the folder', async () => {
    const p = await park()
    const rv27 = await space(p, 'RV 27')
    const cat = (await db.query<{ id: string }>(
      `INSERT INTO pos_categories (landlord_id, name, sort_order, is_active) VALUES ($1,'Stays',1,TRUE) RETURNING id`, [p.landlordId])).rows[0].id
    const siteMonth = (await db.query<{ id: string }>(
      `INSERT INTO pos_items (landlord_id, property_id, name, category_id, sell_price, cost_price, tax_rate, stock_qty, stock_min, stock_max, stay_unit)
       VALUES ($1,$2,'RV site — monthly',$3,589,0,0,999,0,999,'month') RETURNING id`, [p.landlordId, p.propertyId, cat])).rows[0].id
    const andres = await sale(p, {
      method: 'card', total: 779.05, surcharge: 26.88, day: `${THIS}-01`, paidOnline: true, items: [], payLink: { customerName: 'Andres Razo' },
      lines: [
        { name: 'RV site — monthly', category: 'Stays', qty: 1, price: 589, itemId: siteMonth },
        { name: 'Electric (per kWh)', category: 'Utilities', qty: 387, price: 0.21 },
        { name: 'Electric (per kWh) — September, RV 27', category: 'Utilities', qty: 390, price: 0.21 },
      ],
    })
    const walkIn = await sale(p, {
      method: 'cash', total: 23.92, day: `${THIS}-01`, items: [], tax: 1.48,
      taxBreakdown: [{ name: 'Transaction privilege tax', rate: 0.066, amount: 1.48 }],
      lines: [{ name: 'Propane', category: 'Utilities', qty: 6.8, price: 3.3 }],
    })
    const res = await openMonth(owner(p), p.propertyId)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const d = res.body.data
    const onRow = d.rows.find((r: any) => r.key === `vacant:${rv27}`).otherMoney
    expect(onRow).toHaveLength(1)
    expect(onRow[0]).toMatchObject({ saleId: andres, amount: 752.17, cardFee: 26.88 })
    expect(onRow[0].parts.map((x: any) => [x.label, x.what, x.qty, x.unitPrice, x.unit, x.amount])).toEqual([
      ['Electric (per kWh)', 'Electric bill-back', 387, 0.21, 'kWh', 81.27],
      ['Electric (per kWh) — September, RV 27', 'Electric bill-back', 390, 0.21, 'kWh', 81.9],
      ['RV site — monthly', 'Site rent', 1, 589, null, 589],
    ])
    expect(d.otherMoney).toHaveLength(1)
    expect(d.otherMoney[0]).toMatchObject({ saleId: walkIn, amount: 23.92, cardFee: 0 })
    expect(d.otherMoney[0].parts.map((x: any) => [x.kind, x.label, x.amount])).toEqual([
      ['item', 'Propane', 22.44], ['tax', 'Transaction privilege tax', 1.48],
    ])
  })
})

describe('10/13 (Nic), round 3: the Rent Roll\'s stays — "an aggregate by line items … below with expandable notes"', () => {
  /** The register's stay item: what one of it buys. */
  async function stayItemOf(p: { landlordId: string; propertyId: string }, name: string, unit: 'night' | 'week' | 'month') {
    const cat = (await db.query<{ id: string }>(
      `INSERT INTO pos_categories (landlord_id, name, sort_order, is_active) VALUES ($1,$2,1,TRUE) RETURNING id`, [p.landlordId, `Stays by the ${unit}`])).rows[0].id
    return (await db.query<{ id: string }>(
      `INSERT INTO pos_items (landlord_id, property_id, name, category_id, sell_price, cost_price, tax_rate, stock_qty, stock_min, stock_max, stay_unit)
       VALUES ($1,$2,$3,$4,0,0,0,999,0,999,$5) RETURNING id`, [p.landlordId, p.propertyId, name, cat, unit])).rows[0].id
  }
  /**
   * A sale of a stay item, noon on `day`, recorded the way the register, a
   * reservation ticket and a pay link record one (routes/pos-stays.test,
   * decisions #9): a sale toward a stay on the schedule (`booking`, or
   * `pays` for several) carries the stay as ONE line, quantity 1, at what it
   * charged, whatever its length; a stay item sold with no stay on the
   * schedule is its line at `qty`. `toward`: what the sale paid toward the
   * stay (default qty × price). `stayLines`: more stay items' lines on it.
   */
  async function staySale(p: { landlordId: string; userId: string; propertyId: string }, o: {
    item: string; qty: number; price: number; day: string; method?: 'cash' | 'card' | 'charge'; booking?: string; voided?: boolean
    payLink?: boolean; also?: string[]; toward?: number; pays?: Array<{ booking: string; toward: number }>
    stayLines?: Array<{ item: string; price: number }>
  }) {
    const at = `${o.day} 12:00:00-07`
    const method = o.method ?? 'cash'
    const pays = o.pays ?? (o.booking ? [{ booking: o.booking, toward: o.toward ?? o.qty * o.price }] : [])
    const total = pays.length ? pays.reduce((t, x) => t + x.toward, 0) : o.qty * o.price
    const linkId = o.payLink ? (await db.query<{ id: string }>(
      `INSERT INTO pos_pay_links (token, landlord_id, property_id, created_by, kind, label, items, subtotal, total, customer_email, status, paid_at)
       VALUES ($1,$2,$3,$4,'one_time','Stay','[]'::jsonb,$5,$5,'guest@t.dev','paid',$6::timestamptz) RETURNING id`,
      [randomUUID(), p.landlordId, p.propertyId, p.userId, total, at])).rows[0].id : null
    const pi = method === 'card' ? `pi_${randomUUID()}` : null
    const id = (await db.query<{ id: string }>(
      `INSERT INTO pos_transactions (landlord_id, cashier_id, payment_method, subtotal, total, property_id, pay_link_id,
                                     stripe_payment_intent_id, status, voided_at, created_at)
       VALUES ($1,$2,$3,$4,$4,$5,$6,$7,$8,$9,$10::timestamptz) RETURNING id`,
      [p.landlordId, p.userId, method, total, p.propertyId, linkId, pi, o.voided ? 'voided' : 'completed', o.voided ? at : null, at])).rows[0].id
    const nameOf = async (item: string) => (await db.query<{ name: string }>(`SELECT name FROM pos_items WHERE id = $1`, [item])).rows[0].name
    const name = await nameOf(o.item)
    if (pays.length) {
      await db.query(`INSERT INTO pos_transaction_items (transaction_id, item_id, item_name, qty, unit_price, subtotal) VALUES ($1,$2,$3,1,$4,$4)`,
        [id, o.item, `${name} — the stay, one line at what it charged`, total])
    } else {
      await db.query(`INSERT INTO pos_transaction_items (transaction_id, item_id, item_name, qty, unit_price, subtotal) VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, o.item, name, o.qty, o.price, total])
    }
    for (const l of o.stayLines ?? []) {
      await db.query(`INSERT INTO pos_transaction_items (transaction_id, item_id, item_name, qty, unit_price, subtotal) VALUES ($1,$2,$3,1,$4,$4)`,
        [id, l.item, await nameOf(l.item), l.price])
    }
    for (const n of o.also ?? []) {
      await db.query(`INSERT INTO pos_transaction_items (transaction_id, item_name, qty, unit_price, subtotal) VALUES ($1,$2,1,0,0)`, [id, n])
    }
    for (const x of pays) {
      await db.query(
        `INSERT INTO stay_payments (booking_id, landlord_id, kind, pos_transaction_id, stripe_payment_intent_id, method, toward_stay, paid_at)
         VALUES ($1,$2,'pos_sale',$3,$4,$5,$6,$7::timestamptz)`, [x.booking, p.landlordId, id, pi, method, x.toward, at])
    }
    return id
  }

  it('the range\'s stays below the rows, by line item and how they were paid for, each with its notes per site; never in the spaces\' spots', async () => {
    const p = await park()
    const lena = await household(p, 'RV 1', 'Lena Lease')
    await rent(p, lena, LAST, 495, 1)
    const nightly = await stayItemOf(p, 'RV site — nightly', 'night')
    const weekly = await stayItemOf(p, 'RV site — weekly', 'week')
    const monthly = await stayItemOf(p, 'RV site — monthly', 'month')
    const at = async (n: string) => space(p, n)
    // At the register: 4 nights at RV 15; RV 18 used twice in the month (3 nights, then 5); 10 nights at RV 20 on a pay link.
    const rv15 = await at('RV 15'), rv18 = await at('RV 18'), rv20 = await at('RV 20'), rv12 = await at('RV 12')
    const a = await stayAt(p, rv15, { guest: 'Ann A', checkIn: `${LAST}-02`, nights: 4, status: 'checked_out' })
    await staySale(p, { item: nightly, qty: 4, price: 40, day: `${LAST}-02`, booking: a })
    const b = await stayAt(p, rv18, { guest: 'Ben B', checkIn: `${LAST}-05`, nights: 3, status: 'checked_out' })
    await staySale(p, { item: nightly, qty: 3, price: 40, day: `${LAST}-05`, booking: b })
    const c = await stayAt(p, rv18, { guest: 'Cal C', checkIn: `${LAST}-20`, nights: 5, status: 'checked_out' })
    await staySale(p, { item: nightly, qty: 5, price: 40, day: `${LAST}-20`, booking: c })
    const dd = await stayAt(p, rv20, { guest: 'Dot D', checkIn: `${LAST}-10`, nights: 10, status: 'checked_out' })
    await staySale(p, { item: nightly, qty: 10, price: 40, day: `${LAST}-10`, booking: dd, payLink: true, method: 'card' })
    // A week at RV 12.
    const e = await stayAt(p, rv12, { guest: 'Eve E', checkIn: `${LAST}-12`, nights: 7, status: 'checked_out', leaseType: 'weekly' })
    await staySale(p, { item: weekly, qty: 1, price: 280, day: `${LAST}-12`, booking: e })
    // Booked online: 2 nights at RV 30 (deposit, then its balance link — no stay item line), a month at RV 31.
    const rv30 = await at('RV 30'), rv31 = await at('RV 31')
    const f = await stayAt(p, rv30, { guest: 'Fay F', checkIn: `${LAST}-11`, nights: 2, status: 'checked_out' })
    await siteDepositOn(p, f, 40, `${LAST}-10`)
    await registerSale(p, f, { method: 'card', toward: 60, day: `${LAST}-11`, payLink: true, balanceLink: true })
    const g = (await db.query<{ id: string }>(
      `INSERT INTO unit_bookings (unit_id, landlord_id, guest_name, check_in, check_out, status, lease_type)
       VALUES ($1,$2,'Gus G',$3::date,$4::date,'checked_in','month_to_month') RETURNING id`,
      [rv31, p.landlordId, `${LAST}-01`, `${THIS}-01`])).rows[0].id
    await siteDepositOn(p, g, 589, `${LAST}-01`)
    // A month sold on a pay link with no stay on the schedule — its sale names RV 27 (Andres Razo's).
    await at('RV 27')
    await staySale(p, { item: monthly, qty: 1, price: 589, day: `${LAST}-06`, payLink: true, method: 'card',
      also: ['Electric (per kWh) — September, RV 27'] })
    // Never: a voided sale, a charge account, another month's, a stay that became a lease.
    const rv40 = await at('RV 40'), rv41 = await at('RV 41'), rv42 = await at('RV 42'), rv43 = await at('RV 43')
    await staySale(p, { item: nightly, qty: 2, price: 40, day: `${LAST}-03`, booking: await stayAt(p, rv40, { guest: 'Vo V', checkIn: `${LAST}-03`, nights: 2, status: 'checked_out' }), voided: true })
    await staySale(p, { item: nightly, qty: 3, price: 40, day: `${LAST}-03`, method: 'charge', booking: await stayAt(p, rv41, { guest: 'Cha C', checkIn: `${LAST}-03`, nights: 3, status: 'checked_out' }) })
    await staySale(p, { item: nightly, qty: 6, price: 40, day: `${addMonths(LAST, -1)}-03`, booking: await stayAt(p, rv42, { guest: 'Old O', checkIn: `${addMonths(LAST, -1)}-03`, nights: 6, status: 'checked_out' }) })
    const leased = await stayAt(p, rv43, { guest: 'Lee L', checkIn: `${LAST}-03`, nights: 30, status: 'confirmed' })
    await staySale(p, { item: nightly, qty: 30, price: 20, day: `${LAST}-03`, booking: leased })
    const cl = await db.connect()
    try {
      await seedLease(cl, { unitId: rv43, landlordId: p.landlordId, rentAmount: 589, startDate: `${LAST}-03`, status: 'pending' })
    } finally { cl.release() }
    await db.query(`UPDATE leases SET source_booking_id = $2 WHERE unit_id = $1`, [rv43, leased])

    const res = await history(owner(p), p.propertyId, `from=${LAST}&to=${LAST}`)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const d = res.body.data
    // The rows are the households; no stay sits in a space's spot.
    expect(d.rows.map((r: any) => r.residents[0].name)).toEqual(['Lena Lease'])
    expect(d.stays.map((s: any) => [s.key, s.label, s.quantity, s.stays, s.paid])).toEqual([
      ['night:pos', '22 nights paid for via POS', 22, 4, 880],
      ['night:booking_site', '2 nights paid for via the booking site', 2, 1, 100],
      ['week:pos', '1 week paid for via POS', 1, 1, 280],
      ['month:pos', '1 month paid for via POS', 1, 1, 589],
      ['month:booking_site', '1 month paid for via the booking site', 1, 1, 589],
    ])
    // The notes: per site, in space order — a site used twice is one note with both stays' nights.
    expect(d.stays[0].sites).toEqual([
      { space: 'RV 15', quantity: 4, stays: 1, label: '4 nights in RV 15' },
      { space: 'RV 18', quantity: 8, stays: 2, label: '8 nights in RV 18' },
      { space: 'RV 20', quantity: 10, stays: 1, label: '10 nights in RV 20' },
    ])
    expect(d.stays[2].sites).toEqual([{ space: 'RV 12', quantity: 1, stays: 1, label: '1 week in RV 12' }])
    expect(d.stays[3].sites).toEqual([{ space: 'RV 27', quantity: 1, stays: 1, label: '1 month in RV 27' }])
    expect(d.stays[4].sites.map((s: any) => s.label)).toEqual(['1 month in RV 31'])
    // The bills' totals are the bills'.
    expect(d.totals).toMatchObject({ invoiced: 495, paid: 495, owed: 0 })
    // Without the range totals, the lines and notes — never their money (decisions #25).
    const staff = (await history(await teamToken(p, 'onsite_manager', { 'payments.view_all': true }), p.propertyId, `from=${LAST}&to=${LAST}`)).body.data
    expect(staff.stays.map((s: any) => s.label)).toEqual(d.stays.map((s: any) => s.label))
    expect(staff.stays.every((s: any) => !('paid' in s))).toBe(true)
    // Another range, its own stays: the month before has only the 6 nights at RV 42.
    const before = (await history(owner(p), p.propertyId, `from=${addMonths(LAST, -1)}&to=${addMonths(LAST, -1)}`)).body.data
    expect(before.stays.map((s: any) => s.label)).toEqual(['6 nights paid for via POS'])
    // All time: every stay, whether or not a bill came first.
    const all = (await history(owner(p), p.propertyId, 'range=all')).body.data
    expect(all.stays[0]).toMatchObject({ key: 'night:pos', quantity: 28, stays: 5 })
  })

  it('a stay rung as one line counts its own length, once however many payments; a sale that paid two stays is two notes, each its own money', async () => {
    const p = await park()
    const nightly = await stayItemOf(p, 'RV site — nightly', 'night')
    const weekly = await stayItemOf(p, 'RV site — weekly', 'week')
    const at = async (n: string) => space(p, n)
    const rv12 = await at('RV 12'), rv15 = await at('RV 15'), rv16 = await at('RV 16'), rv20 = await at('RV 20')
    const rv21 = await at('RV 21'), rv22 = await at('RV 22')
    // 4 nights rung at the counter: one line, quantity 1, $160.
    const a = await stayAt(p, rv15, { guest: 'Ann A', checkIn: `${LAST}-02`, nights: 4, status: 'checked_out' })
    await staySale(p, { item: nightly, qty: 4, price: 40, day: `${LAST}-02`, booking: a })
    // 5 nights reserved: a deposit ticket, then its balance on a pay link — each a stay line of quantity 1.
    const b = await stayAt(p, rv16, { guest: 'Ben B', checkIn: `${LAST}-08`, nights: 5, status: 'checked_out' })
    await staySale(p, { item: nightly, qty: 5, price: 40, day: `${LAST}-02`, booking: b, toward: 80 })
    await staySale(p, { item: nightly, qty: 5, price: 40, day: `${LAST}-08`, booking: b, toward: 120, payLink: true, method: 'card' })
    // 2 weeks rung at the counter: one line, quantity 1, $560.
    const c = await stayAt(p, rv12, { guest: 'Cal C', checkIn: `${LAST}-03`, nights: 14, status: 'checked_out', leaseType: 'weekly' })
    await staySale(p, { item: weekly, qty: 2, price: 280, day: `${LAST}-03`, booking: c })
    // One sale that paid two stays: 3 nights at RV 20 ($120) and 2 nights at RV 21 ($80).
    const d = await stayAt(p, rv20, { guest: 'Dot D', checkIn: `${LAST}-10`, nights: 3, status: 'checked_out' })
    const e = await stayAt(p, rv21, { guest: 'Eve E', checkIn: `${LAST}-10`, nights: 2, status: 'checked_out' })
    await staySale(p, { item: nightly, qty: 5, price: 40, day: `${LAST}-10`, pays: [{ booking: d, toward: 120 }, { booking: e, toward: 80 }] })
    // A sale with two stay items' lines toward one week at RV 22: its $280 once.
    const f = await stayAt(p, rv22, { guest: 'Fay F', checkIn: `${LAST}-12`, nights: 7, status: 'checked_out', leaseType: 'weekly' })
    await staySale(p, { item: weekly, qty: 1, price: 280, day: `${LAST}-12`, booking: f, stayLines: [{ item: nightly, price: 0 }] })

    const res = await history(owner(p), p.propertyId, `from=${LAST}&to=${LAST}`)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const s = res.body.data.stays
    expect(s.map((l: any) => [l.key, l.label, l.quantity, l.stays, l.paid])).toEqual([
      ['night:pos', '14 nights paid for via POS', 14, 4, 560],
      ['week:pos', '3 weeks paid for via POS', 3, 2, 840],
    ])
    expect(s[0].sites.map((x: any) => [x.label, x.stays])).toEqual([
      ['4 nights in RV 15', 1], ['5 nights in RV 16', 1], ['3 nights in RV 20', 1], ['2 nights in RV 21', 1],
    ])
    expect(s[1].sites.map((x: any) => [x.label, x.stays])).toEqual([['2 weeks in RV 12', 1], ['1 week in RV 22', 1]])
  })
})

describe('10/13 (Nic), round 3: a bookkeeper\'s view of a sold property', () => {
  it('a bill from before the sale, paid after it, reads PAID on their Rent Roll', async () => {
    const p = await park('Alder')
    const birch = await park('Birch', p)
    const buyer = await park('Buyer Park')
    const al = await household(p, 'RV 1', 'Al Alder')
    const bill1 = await rent(p, al, LAST, 495)                  // unpaid on the day of the sale
    const bea = await bookkeeperToken(p, [p.propertyId, birch.propertyId], { companyWide: true })
    const { transferProperty } = await import('../services/propertyTransfer')
    const t = await transferProperty({ propertyId: p.propertyId, fromLandlordId: p.landlordId, toLandlordId: buyer.landlordId, byUserId: p.userId })
    await db.query(`UPDATE property_transfers SET transferred_at = $2::timestamptz WHERE id = $1`, [t.transferId, `${LAST}-20 12:00:00-07`])
    await db.query(`UPDATE bookkeeper_former_properties SET left_at = $2::timestamptz WHERE property_transfer_id = $1`, [t.transferId, `${LAST}-20 12:00:00-07`])
    const read = async () => (await history(bea.token, p.propertyId, `from=${LAST}&to=${THIS}`)).body.data
    // Before he pays: owed, as of the sale.
    const owing = await read()
    expect(owing.rows.map((r: any) => [r.residents[0].name, r.invoiced, r.paid, r.owed])).toEqual([['Al Alder', 495, 0, 495]])
    // He pays the old company's bill after the sale: paid.
    await db.query(`UPDATE payments SET status = 'settled', manual_method = 'cash', settled_at = $2::timestamptz WHERE id = $1`,
      [bill1.paymentId, `${THIS}-01 12:00:00-07`])
    const paid = await read()
    expect(paid).toMatchObject({ from: LAST, to: LAST, months: [LAST] })
    expect(paid.rows.map((r: any) => [r.residents[0].name, r.invoiced, r.paid, r.owed])).toEqual([['Al Alder', 495, 495, 0]])
    expect(paid.rows[0].stamps[0]).toMatchObject({ month: LAST, status: 'paid_late', paid: 495, owed: 0 })
    expect(paid.movedOutOwing).toEqual([])
    expect(paid.totals).toMatchObject({ invoiced: 495, paid: 495, owed: 0 })
  })
})

describe('10/13 (Nic), round 3: the tenant report\'s "Delinquent" is the Payments page\'s money rule', () => {
  it('the report of a whole household says it too — a charge on no lease past grace included — and clears when paid', async () => {
    const p = await park()
    const unitId = await space(p, 'RV 9')
    const c = await db.connect()
    let tenantId: string
    try {
      tenantId = await seedTenant(c)
    } finally { c.release() }
    await db.query(`UPDATE users SET first_name = 'Nola', last_name = 'Nolease' WHERE id = (SELECT user_id FROM tenants WHERE id = $1)`, [tenantId])
    const fee = (await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, created_at)
       VALUES ($1,$2,$3,'fee',40,'pending',$4::date,'OTHERFEE',$4::date) RETURNING id`,
      [unitId, tenantId, p.landlordId, `${LAST}-01`])).rows[0].id
    const rep = async () => (await report(owner(p), tenantId)).body.data
    expect(await rep()).toMatchObject({ delinquent: true, leases: [] })
    await db.query(`UPDATE payments SET status = 'settled', manual_method = 'cash', settled_at = NOW() WHERE id = $1`, [fee])
    expect((await rep()).delinquent).toBe(false)
  })
})

describe('the words of round 3', () => {
  it('a space named in a sale\'s words: its number, however typed; a bare number only after a word for a space; never two', async () => {
    const { spaceNamedIn } = await import('../services/rentRoll')
    const spaces = [
      { unitId: 'rv2', names: ['RV 2', null] }, { unitId: 'rv27', names: ['RV 27', null] },
      { unitId: 'mh03', names: ['MH 03', 'Space 3'] }, { unitId: 'n20', names: ['20', null] }, { unitId: 'cabin', names: ['Cabin Moose', null] },
      { unitId: 'lot7', names: ['Lot 7', null] },
    ]
    expect(spaceNamedIn(['Electric (per kWh) — September, RV 27'], spaces)).toBe('rv27')
    expect(spaceNamedIn(['rv27'], spaces)).toBe('rv27')
    expect(spaceNamedIn(['RV #027'], spaces)).toBe('rv27')
    expect(spaceNamedIn(['RV 2'], spaces)).toBe('rv2')
    expect(spaceNamedIn(['Lot rent — MH 3'], spaces)).toBe('mh03')
    expect(spaceNamedIn(['Water for space 3'], spaces)).toBe('mh03')
    expect(spaceNamedIn(['RV site — monthly'], spaces)).toBeNull()
    expect(spaceNamedIn(['Propane 20 lb'], spaces)).toBeNull()
    expect(spaceNamedIn(['Electric, site 20'], spaces)).toBe('n20')
    expect(spaceNamedIn(['Firewood #20'], spaces)).toBe('n20')
    expect(spaceNamedIn(['Firewood for cabin moose'], spaces)).toBe('cabin')
    // A space numbered with a word for a space is named by any of them.
    expect(spaceNamedIn(['Electric — lot 7'], spaces)).toBe('lot7')
    expect(spaceNamedIn(['Electric — site 07'], spaces)).toBe('lot7')
    expect(spaceNamedIn(['7 bundles of firewood'], spaces)).toBeNull()
    expect(spaceNamedIn(['Electric — RV 2', 'and RV 27'], spaces)).toBeNull()
    expect(spaceNamedIn([null, '', 'Propane'], spaces)).toBeNull()
  })

  it('a stay on the schedule, in line items: whole months, whole weeks, else nights', async () => {
    const { bookingLineItems } = await import('../services/rentRoll')
    expect(bookingLineItems({ lease_type: 'month_to_month', check_in: '2026-10-04', booked_check_out: '2026-11-04' })).toEqual({ unit: 'month', quantity: 1 })
    expect(bookingLineItems({ lease_type: 'month_to_month', check_in: '2026-01-31', booked_check_out: '2026-02-28' })).toEqual({ unit: 'month', quantity: 1 })
    expect(bookingLineItems({ lease_type: 'month_to_month', check_in: '2026-10-04', booked_check_out: '2026-12-04' })).toEqual({ unit: 'month', quantity: 2 })
    expect(bookingLineItems({ lease_type: 'month_to_month', check_in: '2026-10-04', booked_check_out: '2026-11-18' })).toEqual({ unit: 'night', quantity: 45 })
    expect(bookingLineItems({ lease_type: 'weekly', check_in: '2026-10-04', booked_check_out: '2026-10-18' })).toEqual({ unit: 'week', quantity: 2 })
    expect(bookingLineItems({ lease_type: 'weekly', check_in: '2026-10-04', booked_check_out: '2026-10-14' })).toEqual({ unit: 'night', quantity: 10 })
    expect(bookingLineItems({ lease_type: 'nightly', check_in: '2026-10-04', booked_check_out: '2026-10-07' })).toEqual({ unit: 'night', quantity: 3 })
  })

  it('the pieces add up into lines: nights, weeks, months; POS first; notes in space order; a site never named said so', async () => {
    const { stayLinesOf } = await import('../services/rentRoll')
    const lines = stayLinesOf([
      { unit: 'week', via: 'pos', quantity: 1, paidCents: 28000, space: 'RV 12', stay: 'booking:e' },
      { unit: 'night', via: 'booking_site', quantity: 2, paidCents: 10000, space: 'RV 30', stay: 'booking:f' },
      { unit: 'night', via: 'pos', quantity: 0.5, paidCents: 2000, space: null, stay: 'sale:s1' },
      { unit: 'night', via: 'pos', quantity: 3, paidCents: 12000, space: 'RV 18', stay: 'booking:b' },
      { unit: 'night', via: 'pos', quantity: 5, paidCents: 20000, space: 'RV 18', stay: 'booking:c' },
    ], true)
    expect(lines.map(l => [l.label, l.paid, l.sites.map(s => s.label)])).toEqual([
      ['8.5 nights paid for via POS', 340, ['8 nights in RV 18', '0.5 nights, no site named']],
      ['2 nights paid for via the booking site', 100, ['2 nights in RV 30']],
      ['1 week paid for via POS', 280, ['1 week in RV 12']],
    ])
    expect(stayLinesOf([{ unit: 'month', via: 'pos', quantity: 1, paidCents: 58900, space: 'RV 27', stay: 'sale:x' }], false)[0])
      .not.toHaveProperty('paid')
  })
})

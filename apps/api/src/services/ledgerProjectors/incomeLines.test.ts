/**
 * 10/14 (Nic, I1-I7) — GAM Books: income itemized by the space it is for.
 *
 *   Nic's bookkeeper (10/14): "a breakdown of where it's from, a distinction
 *   by unit type for mobile home spaces, the lot rent, any trailer payments
 *   that may be made, and RV stays that are long-term versus the short-term
 *   taxable ones ... we need everything to be as itemized as possible".
 *
 * The rule (incomeLines), the postings it makes, that work trade left out of
 * the books still nets to nothing on the new lines (commit e414400), that a
 * from-scratch rebuild posts the same books with every property netting to
 * $0 and the nightly check finding nothing, and the P&L's Detailed view.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { randomUUID } from 'crypto'
import type { LedgerAccountRole } from '@gam/shared'
import { db } from '../../db'
import { tenantCo, addLease, bill, receipt, cleanupTenantLedger } from '../../test/ledgerTenantFixtures'
import { inTx } from '../../test/ledgerFixtures'
import { booking, siteDeposit } from '../../test/ledgerP5Fixtures'
import { seedUnit } from '../../test/dbHelpers'
import { drainLedgerOutbox } from '../ledgerEngine'
import { registerProductionLedgerProjectors, unregisterProductionLedgerProjectors } from '../ledgerProjectors'
import { rebuildOwner } from '../ledgerRebuild'
import { checkOwner } from '../ledgerCheck'
import { ledgerProfitAndLoss } from '../ledgerReports'
import { rentParts, stayParts, type SpaceFacts, type StayFacts } from './incomeLines'

// 10/14 (the deploy proof): before this change every rent and stay line booked
// on its role's own account (4010 Space and lot rent, 4400 Stay income).
// `legacy.on` makes the rule do that again, so a test can post the old way and
// prove what the deploy's from-scratch rebuild does to those books. Off, the
// rule is the real one.
const legacy = vi.hoisted(() => ({ on: false }))
vi.mock('./incomeLines', async (importOriginal) => {
  const m = await importOriginal<typeof import('./incomeLines')>()
  const flat = (role: LedgerAccountRole, cents: number) => (cents ? [{ role, cents }] : [])
  return {
    ...m,
    rentParts: (space: SpaceFacts | null, cents: number, role: LedgerAccountRole = 'space_rent') =>
      legacy.on ? flat(role, cents) : m.rentParts(space, cents, role),
    stayParts: (st: StayFacts | null, cents: number, role: LedgerAccountRole = 'stay_income') =>
      legacy.on ? flat(role, cents) : m.stayParts(st, cents, role),
  }
})

const space = (o: Partial<SpaceFacts>): SpaceFacts => ({ unitType: 'mobile_home', parkOwnedHome: false, lotCents: 0, rentCents: 0, ...o })
const keyed = (parts: ReturnType<typeof rentParts>) => parts.map(p => [p.role, p.sub ? `${p.sub.kind}:${p.sub.value}` : null, p.cents])

describe('the rule (pure)', () => {
  it('a tenant-owned trailer\'s whole rent is lot rent; a park-owned one splits by the unit\'s lot rent (I4/I5)', () => {
    expect(keyed(rentParts(space({}), 46000))).toEqual([['space_rent', 'rent_line:mobile_home_lot', 46000]])
    const park = space({ parkOwnedHome: true, lotCents: 30000, rentCents: 100000 })
    expect(keyed(rentParts(park, 100000))).toEqual([
      ['space_rent', 'rent_line:mobile_home_lot', 30000], ['space_rent', 'rent_line:mobile_home_trailer', 70000]])
    // A prorated month splits in the same proportion; a credit memo takes back the same way.
    expect(keyed(rentParts(park, 50000))).toEqual([
      ['space_rent', 'rent_line:mobile_home_lot', 15000], ['space_rent', 'rent_line:mobile_home_trailer', 35000]])
    expect(keyed(rentParts(park, -100000))).toEqual([
      ['space_rent', 'rent_line:mobile_home_lot', -30000], ['space_rent', 'rent_line:mobile_home_trailer', -70000]])
    // No lot rent set: all of it is trailer rent.
    expect(keyed(rentParts(space({ parkOwnedHome: true, rentCents: 100000 }), 100000)))
      .toEqual([['space_rent', 'rent_line:mobile_home_trailer', 100000]])
  })

  it('every other space type has its own rent line; a space GAM cannot place stays on the role', () => {
    expect(keyed(rentParts(space({ unitType: 'rv_spot' }), 60000))).toEqual([['space_rent', 'rent_line:rv_spot', 60000]])
    expect(keyed(rentParts(space({ unitType: 'apartment' }), 60000))).toEqual([['space_rent', 'rent_line:apartment', 60000]])
    expect(keyed(rentParts(null, 60000))).toEqual([['space_rent', null, 60000]])
    expect(rentParts(space({}), 0)).toEqual([])
  })

  it('a stay under 30 nights is short-term; 30+ nights or a lease is long-term, on the rent line, still stay income (I2)', () => {
    const rv = space({ unitType: 'rv_spot' })
    expect(keyed(stayParts({ space: rv, nightsSold: 29, stayTerms: null }, 10000))).toEqual([['stay_income', 'stay_line:rv_spot', 10000]])
    expect(keyed(stayParts({ space: rv, nightsSold: 30, stayTerms: null }, 10000))).toEqual([['stay_income', 'rent_line:rv_spot', 10000]])
    expect(keyed(stayParts({ space: rv, nightsSold: 3, stayTerms: 'lease' }, 10000))).toEqual([['stay_income', 'rent_line:rv_spot', 10000]])
    expect(keyed(stayParts(null, 10000))).toEqual([['stay_income', null, 10000]])
  })
})

// ─── On the books ───────────────────────────────────────────────────────────

beforeEach(async () => {
  await cleanupTenantLedger()
  registerProductionLedgerProjectors()
})
afterEach(() => { legacy.on = false; unregisterProductionLedgerProjectors() })
afterAll(async () => { await cleanupTenantLedger() })

interface ItemLine { kind: string; role: string; line: string | null; account: string; parentCode: string | null; net: number }

/** A source's active income lines: role, its line (map kind:value), the account's name and parent's code, credit − debit (cents). */
async function incomeLines(sourceType: string, sourceId: string): Promise<ItemLine[]> {
  const r = await db.query<any>(
    `SELECT p.posting_kind AS kind, l.account_role AS role,
            CASE WHEN l.map_kind IN ('rent_line', 'stay_line') THEN l.map_kind || ':' || l.map_value END AS line,
            a.name AS account, pa.code AS parent_code, round((l.credit - l.debit) * 100)::bigint::text AS net
       FROM ledger_postings p JOIN ledger_posting_lines l ON l.posting_id = p.id
       JOIN books_accounts a ON a.id = l.account_id LEFT JOIN books_accounts pa ON pa.id = a.parent_account_id
      WHERE p.source_type = $1 AND p.source_id = $2 AND p.role = 'post' AND p.superseded_at IS NULL AND a.type = 'income'
      ORDER BY p.posting_kind, l.line_no`, [sourceType, sourceId])
  return r.rows.map(x => ({ kind: x.kind, role: x.role, line: x.line, account: x.account, parentCode: x.parent_code, net: Number(x.net) }))
}

/** Each income account's balance (credit − debit, cents), by name. */
async function incomeByAccount(landlordId: string): Promise<Record<string, number>> {
  const r = await db.query<{ name: string; n: string }>(
    `SELECT a.name, round(SUM(l.credit - l.debit) * 100)::bigint::text AS n
       FROM ledger_posting_lines l JOIN books_accounts a ON a.id = l.account_id
      WHERE l.landlord_id = $1 AND a.type = 'income' GROUP BY 1 ORDER BY 1`, [landlordId])
  return Object.fromEntries(r.rows.map(x => [x.name, Number(x.n)]))
}

/** Σ debits − Σ credits per property ('' = the company's own lines), cents. */
async function netByProperty(landlordId: string): Promise<Record<string, number>> {
  const r = await db.query<{ p: string; n: string }>(
    `SELECT COALESCE(property_id::text, '') AS p, round(SUM(debit - credit) * 100)::bigint::text AS n
       FROM ledger_posting_lines WHERE landlord_id = $1 GROUP BY 1`, [landlordId])
  return Object.fromEntries(r.rows.map(x => [x.p, Number(x.n)]))
}

/** The tenant's unit made a mobile home; `park` makes its trailer the park's with `lot` lot rent; tagged with a subtype. */
async function mobileHome(co: { unitId: string; propertyId: string }, o: { park: boolean; lot?: number; subtype?: string }): Promise<void> {
  await inTx(async (c) => {
    await c.query(`UPDATE units SET unit_type = 'mobile_home', dwelling_ownership = $2, lot_rent_amount = $3 WHERE id = $1`,
      [co.unitId, o.park ? 'landlord' : 'tenant', o.lot ?? 0])
    if (o.subtype) {
      const st = await c.query<{ id: string }>(
        `INSERT INTO property_unit_subtypes (property_id, unit_type, name) VALUES ($1, 'mobile_home', $2) RETURNING id`, [co.propertyId, o.subtype])
      await c.query(`INSERT INTO unit_subtype_links (unit_id, subtype_id) VALUES ($1, $2)`, [co.unitId, st.rows[0].id])
    }
  })
}

/** An early check-out on a stay: $toward of its site deposit (with $tax of lodging tax) handed back in cash at the desk. */
async function earlyCheckOutRefund(co: { landlordId: string }, bookingId: string, o: { toward: number; tax: number; on: string }): Promise<string> {
  const sp = (await db.query<{ id: string; paid: string }>(
    `SELECT id, toward_stay::text AS paid FROM stay_payments WHERE booking_id = $1 AND kind = 'site_deposit'`, [bookingId])).rows[0]
  const decision = (await db.query<{ id: string }>(
    `INSERT INTO stay_checkout_decisions (booking_id, landlord_id, left_on, question, choice, status, booked_price, stayed_worth,
                                          paid, refund_total, decided_at)
     VALUES ($1, $2, $3::date, 'overpaid', 'refund_unused', 'decided', $4::numeric, $4::numeric - $5::numeric, $4::numeric, $5::numeric, $3::timestamptz) RETURNING id`,
    [bookingId, co.landlordId, o.on, Number(sp.paid), o.toward])).rows[0].id
  return (await db.query<{ id: string }>(
    `INSERT INTO stay_refund_parts (decision_id, booking_id, landlord_id, seq, kind, stay_payment_id, stripe_payment_intent_id,
                                    toward_amount, card_fee_back, amount, lodging_tax_share, label, status, refunded_at)
     VALUES ($1, $2, $3, 1, 'cash', $4, NULL, $5, 0, $5, $6, 'Nights not stayed', 'handed_back', $7::timestamptz) RETURNING id`,
    [decision, bookingId, co.landlordId, sp.id, o.toward, o.tax, `${o.on}T18:00:00Z`])).rows[0].id
}

/** A chargeback of $amount on the booking-site deposit paid with `pi` (the payout line GAM holds back). */
async function stayChargeback(co: { landlordId: string }, pi: string, amount: number, propertyId: string): Promise<string> {
  const dp = `dp_${randomUUID()}`
  await db.query(
    `INSERT INTO connect_disputes (stripe_dispute_id, stripe_charge_id, stripe_payment_intent_id, landlord_id, amount, status)
     VALUES ($1, $2, $3, $4, $5, 'needs_response')`, [dp, `ch_${randomUUID()}`, pi, co.landlordId, amount])
  return (await db.query<{ id: string }>(
    `INSERT INTO held_payout_items (landlord_id, source_type, source_id, amount, property_id, created_at)
     VALUES ($1, 'dispute', $2, $3, $4, '2026-09-25 18:00:00+00') RETURNING id`, [co.landlordId, dp, -amount, propertyId])).rows[0].id
}

describe('rent books to its space\'s line', () => {
  it('a park-owned trailer: lot rent and trailer rent, each its own account under 4010; work trade left out nets each to nothing', async () => {
    const co = await tenantCo({ workTrade: 'left_out' })
    await mobileHome(co, { park: true, lot: 300 })
    const rent = await bill(co, { amount: 1000, due: '2026-09-01' })
    // 10/14: $460 of a $1,000 month covered by work-trade hours, the rest in money.
    const covered = await bill(co, { amount: 540, due: '2026-10-01', workTradeCredit: 460 })
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })

    expect(await incomeLines('payment', rent)).toEqual([
      { kind: 'charge', role: 'space_rent', line: 'rent_line:mobile_home_lot', account: 'Mobile home lot rent', parentCode: '4010', net: 30000 },
      { kind: 'charge', role: 'space_rent', line: 'rent_line:mobile_home_trailer', account: 'Park-owned trailer rent', parentCode: '4010', net: 70000 },
    ])
    // The hours mirror the charge's own lines: only the money counts, on each line in proportion.
    const wt = await incomeLines('payment', covered)
    expect(wt.filter(l => l.kind === 'charge').map(l => [l.line, l.net])).toEqual([
      ['rent_line:mobile_home_lot', 30000], ['rent_line:mobile_home_trailer', 70000]])
    expect(wt.filter(l => l.kind === 'work_trade').map(l => [l.line, l.net])).toEqual([
      ['rent_line:mobile_home_lot', -13800], ['rent_line:mobile_home_trailer', -32200]])
    expect(await incomeByAccount(co.landlordId)).toEqual({ 'Mobile home lot rent': 46200, 'Park-owned trailer rent': 107800 })
  })

  it('a tenant-owned trailer\'s whole rent is lot rent; an RV lease is RV long-term rent', async () => {
    const co = await tenantCo()
    await mobileHome(co, { park: false })
    const rent = await bill(co, { amount: 460, due: '2026-09-01' })
    const rvLease = await addLease(co, co.propertyId)
    await db.query(`UPDATE units SET unit_type = 'rv_spot' WHERE id = $1`, [rvLease.unitId])
    const rv = await bill(co, { amount: 550, due: '2026-09-01', unitId: rvLease.unitId, leaseId: rvLease.leaseId })
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })
    expect((await incomeLines('payment', rent)).map(l => [l.line, l.account, l.net])).toEqual([['rent_line:mobile_home_lot', 'Mobile home lot rent', 46000]])
    expect((await incomeLines('payment', rv)).map(l => [l.line, l.account, l.net])).toEqual([['rent_line:rv_spot', 'RV long-term rent', 55000]])
  })

  it('a space changed after its rent was billed never moves that rent: the space as it stood then; a rebuild finds no drift', async () => {
    const co = await tenantCo()
    await mobileHome(co, { park: true, lot: 300 })
    const sept = await bill(co, { amount: 1000, due: '2026-09-01' })
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })
    // Later the renter buys the trailer outright and the lot rent box is cleared.
    await db.query(`UPDATE units SET dwelling_ownership = 'tenant', lot_rent_amount = 0 WHERE id = $1`, [co.unitId])
    const oct = await bill(co, { amount: 1000, due: '2026-10-01' })
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })
    expect((await incomeLines('payment', sept)).map(l => [l.line, l.net])).toEqual([
      ['rent_line:mobile_home_lot', 30000], ['rent_line:mobile_home_trailer', 70000]])
    expect((await incomeLines('payment', oct)).map(l => [l.line, l.net])).toEqual([['rent_line:mobile_home_lot', 100000]])
    // The nightly check and a rebuild read the same: nothing drifted.
    expect((await checkOwner(co.owner, { repair: false })).findings).toEqual([])
    expect((await rebuildOwner(co.owner, { mode: 'dry_run' })).counts.drift).toBe(0)
  })

  it('a trailer the renter is buying from the park is the renter\'s: once the sale is active, the rent beside it is all lot rent (I5)', async () => {
    const co = await tenantCo({ homeSale: 'income_as_paid' })
    await mobileHome(co, { park: true })   // the park's trailer, no lot rent set (the box's default)
    const before = await bill(co, { amount: 460, due: '2026-08-01' })
    await db.query(
      `INSERT INTO home_sale_contracts (unit_id, lease_id, tenant_id, landlord_id, sale_price, financed_amount, term_months,
                                        monthly_payment, start_month, installments_total, status, activated_at)
       VALUES ($1, $2, $3, $4, 20000, 20000, 40, 500, '2026-09-01', 40, 'active', now())`,
      [co.unitId, co.leaseId, co.tenantId, co.landlordId])
    const after = await bill(co, { amount: 460, due: '2026-09-01' })
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })
    expect((await incomeLines('payment', before)).map(l => [l.line, l.net])).toEqual([['rent_line:mobile_home_trailer', 46000]])
    expect((await incomeLines('payment', after)).map(l => [l.line, l.net])).toEqual([['rent_line:mobile_home_lot', 46000]])
  })
})

describe('stays book short-term or long-term (I2)', () => {
  it('under 30 nights on the RV short-term line; 30+ nights on RV long-term rent; the role stays stay income', async () => {
    const co = await tenantCo()
    const rvUnit = await inTx(c => seedUnit(c, { propertyId: co.propertyId, landlordId: co.landlordId, unitType: 'rv_spot' }))
    const at = { ...co, unitId: rvUnit }
    const short = await booking(at, { checkIn: '2026-09-04', checkOut: '2026-09-08' })
    await siteDeposit(at, short, { toward: 200, lodgingTax: 20, held: 200, at: '2026-09-01 18:00:00+00' })
    const long = await booking(at, { checkIn: '2026-09-10', checkOut: '2026-10-10' })
    await siteDeposit(at, long, { toward: 600, lodgingTax: 0, held: 600, at: '2026-09-01 18:00:00+00' })
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })
    expect((await incomeLines('booking', short)).map(l => [l.role, l.line, l.account, l.parentCode, l.net])).toEqual([
      ['stay_income', 'stay_line:rv_spot', 'RV short-term stays (under 30 nights)', '4400', 18000]])
    expect((await incomeLines('booking', long)).map(l => [l.role, l.line, l.account, l.parentCode, l.net])).toEqual([
      ['stay_income', 'rent_line:rv_spot', 'RV long-term rent', '4010', 60000]])
  })

  it('a stay stretched to 30+ nights moves to long-term rent, and the refund taken off it follows within the minute', async () => {
    const co = await tenantCo()
    const rvUnit = await inTx(c => seedUnit(c, { propertyId: co.propertyId, landlordId: co.landlordId, unitType: 'rv_spot' }))
    const at = { ...co, unitId: rvUnit }
    const stay = await booking(at, { checkIn: '2026-09-04', checkOut: '2026-09-08' })
    await siteDeposit(at, stay, { toward: 200, lodgingTax: 20, held: 200, at: '2026-09-01 18:00:00+00' })
    const refund = await earlyCheckOutRefund(co, stay, { toward: 50, tax: 5, on: '2026-09-07' })
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })
    expect((await incomeLines('refund_part', refund)).map(l => l.line)).toEqual(['stay_line:rv_spot'])
    // The guest stays on to October 8: 34 nights, long-term (I2).
    await db.query(`UPDATE unit_bookings SET check_out = '2026-10-08', booked_check_out = '2026-10-08' WHERE id = $1`, [stay])
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })
    expect([...new Set((await incomeLines('booking', stay)).map(l => l.line))]).toEqual(['rent_line:rv_spot'])
    expect((await incomeLines('refund_part', refund)).map(l => l.line)).toEqual(['rent_line:rv_spot'])
    expect((await checkOwner(co.owner, { repair: false })).findings).toEqual([])
  })
})

describe('the rebuild at deploy, and the reports', () => {
  it('a from-scratch rebuild posts the same itemized books: every property nets to $0 and the nightly check finds nothing', async () => {
    const co = await tenantCo({ workTrade: 'left_out' })
    await mobileHome(co, { park: true, lot: 300 })
    const sept = await bill(co, { amount: 1000, due: '2026-09-01' })
    await bill(co, { amount: 540, due: '2026-10-01', workTradeCredit: 460 })
    await receipt(co, { method: 'cash', settledAt: '2026-09-03T17:00:00Z', apps: [{ paymentId: sept, amount: 1000 }] })
    const rvUnit = await inTx(c => seedUnit(c, { propertyId: co.propertyId2, landlordId: co.landlordId, unitType: 'rv_spot' }))
    const stay = await booking({ ...co, unitId: rvUnit }, { checkIn: '2026-09-04', checkOut: '2026-09-08' })
    await siteDeposit({ ...co, unitId: rvUnit }, stay, { toward: 200, lodgingTax: 20, held: 200, at: '2026-09-01 18:00:00+00' })
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })
    const before = await incomeByAccount(co.landlordId)

    const run = await rebuildOwner(co.owner, { mode: 'from_scratch' })
    expect(run.status).toBe('done')
    expect(run.counts.failed).toBe(0)
    expect(await incomeByAccount(co.landlordId)).toEqual(before)
    expect(Object.values(await netByProperty(co.landlordId)).every(n => n === 0)).toBe(true)
    const check = await checkOwner(co.owner, { repair: false })
    expect(check.findings).toEqual([])
    // A second rebuild finds nothing to change (no drift).
    const dry = await rebuildOwner(co.owner, { mode: 'dry_run' })
    expect(dry.counts.drift).toBe(0)
  })

  it('the P&L: Summary is today\'s groups; Detailed itemizes Received, Charged and Owed, the subtype beneath its line', async () => {
    const co = await tenantCo()
    await mobileHome(co, { park: true, lot: 300, subtype: 'Double wide' })
    const sept = await bill(co, { amount: 1000, due: '2026-09-01' })
    await bill(co, { amount: 1000, due: '2026-10-01' })
    await receipt(co, { method: 'cash', settledAt: '2026-09-03T17:00:00Z', apps: [{ paymentId: sept, amount: 1000 }] })
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })

    const pl = await ledgerProfitAndLoss({ landlordIds: [co.landlordId] }, '2026-09-01', '2026-10-31', 'Sep–Oct')
    // Summary: one rent group, as before.
    expect(pl.view.categories.map(c => [c.category, c.received, c.charged, c.owed])).toEqual([['space_rent', 1000, 2000, 1000]])
    // Detailed: the same totals, itemized.
    expect(pl.view.details!.map(d => [d.key, d.label, d.received, d.charged, d.owed])).toEqual([
      ['rent_line:mobile_home_lot', 'Mobile home lot rent', 300, 600, 300],
      ['rent_line:mobile_home_trailer', 'Park-owned trailer rent', 700, 1400, 700],
    ])
    expect(pl.view.details![0].subtypes).toEqual([{ name: 'Double wide', received: 300, charged: 600, owed: 300 }])
    for (const k of ['received', 'charged', 'owed'] as const) {
      expect(Math.round(pl.view.details!.reduce((s, d) => s + d[k], 0) * 100) / 100).toBe(pl.view[k])
    }
    expect(pl.incomeAccounts.map(a => [a.name, a.charged])).toEqual([['Mobile home lot rent', 600], ['Park-owned trailer rent', 1400]])
  })

  it('the deploy: books the old rule posted (rent on 4010, stays on 4400) move onto the lines with a from-scratch rebuild — the very books new postings make', async () => {
    /** Rent with work trade left out, a receipt, a short stay with an early check-out refund, a 30-night stay with a chargeback. */
    async function scenario() {
      const co = await tenantCo({ workTrade: 'left_out' })
      await mobileHome(co, { park: true, lot: 300 })
      const sept = await bill(co, { amount: 1000, due: '2026-09-01' })
      await bill(co, { amount: 540, due: '2026-10-01', workTradeCredit: 460 })
      await receipt(co, { method: 'cash', settledAt: '2026-09-03T17:00:00Z', apps: [{ paymentId: sept, amount: 1000 }] })
      const rvUnit = await inTx(c => seedUnit(c, { propertyId: co.propertyId2, landlordId: co.landlordId, unitType: 'rv_spot' }))
      const at = { ...co, unitId: rvUnit }
      const short = await booking(at, { checkIn: '2026-09-04', checkOut: '2026-09-08' })
      await siteDeposit(at, short, { toward: 200, lodgingTax: 20, held: 200, at: '2026-09-01 18:00:00+00' })
      const refund = await earlyCheckOutRefund(co, short, { toward: 50, tax: 5, on: '2026-09-07' })
      const pi = `pi_${randomUUID()}`
      const long = await booking(at, { checkIn: '2026-09-10', checkOut: '2026-10-10', pi })
      await siteDeposit(at, long, { toward: 600, lodgingTax: 0, held: 600, at: '2026-09-01 18:00:00+00', pi })
      const chargeback = await stayChargeback(co, pi, 200, co.propertyId2)
      return { co, short, long, refund, chargeback }
    }
    const nonZero = (m: Record<string, number>) => Object.fromEntries(Object.entries(m).filter(([, n]) => n !== 0))

    // Company A: posted by the old rule — every rent and stay line on 4010 / 4400.
    legacy.on = true
    const a = await scenario()
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })
    const old = nonZero(await incomeByAccount(a.co.landlordId))
    expect(Object.keys(old).sort()).toEqual(['Space and lot rent', 'Stay income'])
    legacy.on = false
    expect((await rebuildOwner(a.co.owner, { mode: 'dry_run' })).counts.drift).toBeGreaterThan(0)

    // Company B: the same money, posted by the new rule.
    const b = await scenario()
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })
    const fresh = nonZero(await incomeByAccount(b.co.landlordId))
    expect(fresh).toMatchObject({ 'Mobile home lot rent': 46200, 'Park-owned trailer rent': 107800 })
    expect(fresh['Space and lot rent']).toBeUndefined()
    expect(fresh['Stay income']).toBeUndefined()
    // The refund and the chargeback came off the line each stay earned on.
    expect((await incomeLines('refund_part', b.refund)).map(l => [l.role, l.line])).toEqual([['stay_income', 'stay_line:rv_spot']])
    expect((await incomeLines('held_item', b.chargeback)).map(l => [l.role, l.line, l.net])).toEqual([['stay_income', 'rent_line:rv_spot', -20000]])
    // Together the lines hold exactly what the old two accounts held.
    const sum = (m: Record<string, number>) => Object.values(m).reduce((x, n) => x + n, 0)
    expect(sum(fresh)).toBe(sum(old))

    // The deploy: a from-scratch rebuild of company A makes B's books.
    const run = await rebuildOwner(a.co.owner, { mode: 'from_scratch' })
    expect(run.status).toBe('done')
    expect(run.counts.failed).toBe(0)
    expect(nonZero(await incomeByAccount(a.co.landlordId))).toEqual(fresh)
    expect(Object.values(await netByProperty(a.co.landlordId)).every(n => n === 0)).toBe(true)
    expect((await checkOwner(a.co.owner, { repair: false })).findings).toEqual([])
    expect((await rebuildOwner(a.co.owner, { mode: 'dry_run' })).counts.drift).toBe(0)
  })

  it('Detailed: stay money received before the stay is itemized by its stay, and a refund of it comes off the same line', async () => {
    const co = await tenantCo()
    const rvUnit = await inTx(c => seedUnit(c, { propertyId: co.propertyId, landlordId: co.landlordId, unitType: 'rv_spot' }))
    const at = { ...co, unitId: rvUnit }
    const short = await booking(at, { checkIn: '2026-09-04', checkOut: '2026-09-08' })
    await siteDeposit(at, short, { toward: 200, lodgingTax: 20, held: 200, at: '2026-09-01 18:00:00+00' })
    await earlyCheckOutRefund(co, short, { toward: 50, tax: 5, on: '2026-09-07' })
    const long = await booking(at, { checkIn: '2026-10-20', checkOut: '2026-11-25' })
    await siteDeposit(at, long, { toward: 300, lodgingTax: 0, held: 300, at: '2026-09-02 18:00:00+00' })
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })

    const pl = await ledgerProfitAndLoss({ landlordIds: [co.landlordId] }, '2026-09-01', '2026-09-30', 'September')
    const d = pl.view.details!
    const line = (key: string) => d.find(x => x.key === key)
    // $180 for the short stay ($200 less its $20 tax), less the $45 refunded; $300 toward a 36-night stay.
    expect(line('stay_line:rv_spot')?.received).toBe(135)
    expect(line('rent_line:rv_spot')?.received).toBe(300)
    // Nothing left un-itemized on the Summary groups, and the lines add to the column.
    expect(d.filter(x => x.key.startsWith('c:') || x.key.startsWith('l:')).map(x => [x.key, x.received])).toEqual([])
    expect(Math.round(d.reduce((s, x) => s + x.received, 0) * 100) / 100).toBe(pl.view.received)
  })
})

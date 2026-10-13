/**
 * 10/12 (Nic) — GAM Books ledger, phase P8: the nightly parity check
 * (gam-ledger-design-2026-10-12 §10 "Cutover" 1): the ledger against the
 * money records, to the cent, an admin told of any difference.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { db } from '../db'
import { tenantCo, bill, receipt, spend, drain, cleanupTenantLedger } from '../test/ledgerTenantFixtures'
import { registerProductionLedgerProjectors, unregisterProductionLedgerProjectors } from './ledgerProjectors'
import { checkCompanyParity, parityForMonth, parityMonths, runLedgerParity } from './ledgerParity'
import { ledgerReportsLive } from './ledgerReports'
import { markRebuilt } from '../test/ledgerReportFixtures'

beforeEach(async () => {
  await cleanupTenantLedger()
  await db.query(`DELETE FROM admin_notifications WHERE category = 'books_ledger'`)
  registerProductionLedgerProjectors()
})
afterEach(() => unregisterProductionLedgerProjectors())

const notices = async () => (await db.query<{ severity: string; title: string; body: string }>(
  `SELECT severity, title, body FROM admin_notifications WHERE category = 'books_ledger' ORDER BY created_at`)).rows

describe('the ledger against the money records', () => {
  it("Todd's check: the two agree to the cent, so nothing is raised; the run is kept", async () => {
    const co = await tenantCo()
    const sep = await bill(co, { amount: 460, due: '2026-09-01' })
    const oct = await bill(co, { amount: 460, due: '2026-10-01' })
    const { creditId } = await receipt(co, {
      method: 'cash', settledAt: '2026-09-03T18:00:00Z', apps: [{ paymentId: sep, amount: 460 }], surplus: 460,
    })
    await spend(co, { paymentId: oct, amount: 460, appliedAt: '2026-10-01T15:00:00Z', prepaidCreditId: creditId! })
    await drain()

    const r = await checkCompanyParity(co.landlordId, '2026-10-12')
    expect(r.months.map(m => m.month)).toEqual(['2026-09', '2026-10'])
    const sepRec = r.months[0].measures.find(m => m.key === 'received')!
    expect([sepRec.records, sepRec.ledger, sepRec.difference]).toEqual([920, 920, 0])
    expect(r.differences).toBe(0)
    expect(await notices()).toEqual([])
    const run = (await db.query(`SELECT mode, status, scope FROM ledger_rebuild_runs WHERE id = $1`, [r.runId])).rows[0]
    expect(run).toMatchObject({ mode: 'check', status: 'done', scope: { kind: 'parity', months: ['2026-09', '2026-10'] } })
  })

  it('an old balance carried from before GAM: Charged differs on purpose, named, and the notice says so (information)', async () => {
    const co = await tenantCo()
    await bill(co, { type: 'carried_balance', amount: 250, due: '2026-10-01' })
    await drain()
    const m = await parityForMonth(co.landlordId, '2026-10-01', '2026-10-12')
    const charged = m.measures.find(x => x.key === 'charged')!
    expect([charged.records, charged.ledger, charged.difference, charged.explained]).toEqual([250, 0, -250, -250])
    expect(charged.reasons[0].reason).toMatch(/before GAM is opening equity/)
    expect(charged.byLine).toEqual([{ line: 'balances', records: 250, ledger: 0 }])

    await checkCompanyParity(co.landlordId, '2026-10-12')
    const n = await notices()
    expect(n).toHaveLength(1)
    expect(n[0].severity).toBe('info')
    expect(n[0].body).toMatch(/2026-10 Money charged: records \$250\.00, books \$0\.00 \(difference \$-250\.00, \$-250\.00 of it expected\)/)
  })

  it('a difference nobody explained is a warning', async () => {
    const co = await tenantCo()
    await bill(co, { amount: 300, due: '2026-10-01' })
    await drain()
    // The ledger lost a line the records still have (as drift would).
    await db.query(`ALTER TABLE ledger_posting_lines DISABLE TRIGGER USER`)
    try {
      await db.query(`DELETE FROM ledger_posting_lines WHERE landlord_id = $1 AND account_role = 'space_rent'`, [co.landlordId])
      await db.query(`DELETE FROM ledger_posting_lines WHERE landlord_id = $1 AND account_role = 'ar_tenants'`, [co.landlordId])
    } finally {
      await db.query(`ALTER TABLE ledger_posting_lines ENABLE TRIGGER USER`)
    }
    const r = await checkCompanyParity(co.landlordId, '2026-10-12')
    expect(r.unexplained).toBeGreaterThan(0)
    expect((await notices())[0]).toMatchObject({ severity: 'warn' })
  })

  it('the nightly job reads every company whose books were rebuilt in full, and skips the rest', async () => {
    const a = await tenantCo()
    await bill(a, { amount: 100, due: '2026-10-01' })
    const notRebuilt = await tenantCo()
    await bill(notRebuilt, { amount: 100, due: '2026-10-01' })
    const none = await tenantCo({ booksStart: null })
    await bill(none, { amount: 100, due: '2026-10-01' })
    await drain()
    await markRebuilt(a.landlordId)
    await markRebuilt(none.landlordId)
    const out = await runLedgerParity({ today: '2026-10-12' })
    expect(out.map(r => r.landlordId)).toEqual([a.landlordId])
  })

  it('the first clean check after the rebuild switches the reports to the books, and says so once', async () => {
    const co = await tenantCo()
    await bill(co, { amount: 100, due: '2026-10-01' })
    await drain()
    await markRebuilt(co.landlordId)
    expect(await ledgerReportsLive([co.landlordId])).toBe(false)
    await checkCompanyParity(co.landlordId, '2026-10-12')
    expect(await ledgerReportsLive([co.landlordId])).toBe(true)
    await checkCompanyParity(co.landlordId, '2026-10-12')
    const switched = (await notices()).filter(n => /reports now read the books/.test(n.title))
    expect(switched).toHaveLength(1)
    expect(switched[0].severity).toBe('info')
  })

  // 10/12 (Nic, ledger P8 integration): the parity shadow on a copy of
  // production found three differences every company had and nothing named,
  // so no company could switch on its own. Each is now named and expected.
  it('a bill on hold for work trade: charged on its due day on the books, left out by the records — named, expected', async () => {
    const co = await tenantCo()
    const held = await bill(co, { amount: 460, due: '2026-10-01' })
    await db.query(`UPDATE payments SET work_trade_suspended_at = '2026-10-01T16:00:00Z' WHERE id = $1`, [held])
    await drain()
    const m = await parityForMonth(co.landlordId, '2026-10-01', '2026-10-12')
    const charged = m.measures.find(x => x.key === 'charged')!
    expect([charged.records, charged.ledger, charged.difference, charged.explained]).toEqual([0, 460, 460, 460])
    expect(charged.reasons.map(r => r.reason)).toEqual([expect.stringMatching(/on hold for work trade/)])
  })

  it('work-trade hours booked as full rent plus a labor cost (L12): the full rent is charged on the books — named, expected', async () => {
    const co = await tenantCo({ workTrade: 'rent_and_labor' })
    await bill(co, { amount: 0, due: '2026-09-01', status: 'settled', settledAt: '2026-09-01T16:00:00Z', workTradeCredit: 460 })
    await drain()
    const m = await parityForMonth(co.landlordId, '2026-09-01', '2026-09-30')
    const charged = m.measures.find(x => x.key === 'charged')!
    expect([charged.records, charged.ledger, charged.difference, charged.explained]).toEqual([0, 460, 460, 460])
    expect(charged.reasons.map(r => r.reason)).toEqual([expect.stringMatching(/full rent plus a labor cost/)])
  })

  it('a one-time pay link sent in September and paid in October: the records bill it in September, the books in October — named both months', async () => {
    const co = await tenantCo()
    const link = (await db.query<{ id: string }>(
      `INSERT INTO pos_pay_links (token, landlord_id, property_id, created_by, kind, label, items, subtotal, total, customer_email, status, created_at)
       VALUES (gen_random_uuid()::text, $1, $2, $3, 'one_time', 'Stay', '[]'::jsonb, 300, 300, 'guest@t.dev', 'paid', '2026-09-18T17:00:00Z')
       RETURNING id`, [co.landlordId, co.propertyId, co.ownerUserId])).rows[0].id
    const sale = (await db.query<{ id: string }>(
      `INSERT INTO pos_transactions (landlord_id, cashier_id, payment_method, subtotal, tax_amount, surcharge, total, platform_fee,
                                     property_id, discount_amount, pay_link_id, created_at)
       VALUES ($1, $2, 'cash', 300, 0, 0, 300, 0, $3, 0, $4, '2026-10-06T17:50:00Z') RETURNING id`,
      [co.landlordId, co.ownerUserId, co.propertyId, link])).rows[0].id
    await db.query(
      `INSERT INTO pos_transaction_items (transaction_id, item_name, qty, unit_price, cost_price, subtotal) VALUES ($1, 'Stay', 1, 300, 0, 300)`, [sale])
    await drain()
    const sep = (await parityForMonth(co.landlordId, '2026-09-01', '2026-09-30')).measures.find(x => x.key === 'charged')!
    expect([sep.records, sep.ledger, sep.difference, sep.explained]).toEqual([300, 0, -300, -300])
    expect(sep.reasons.map(r => r.reason)).toEqual([expect.stringMatching(/one-time pay link/)])
    const oct = (await parityForMonth(co.landlordId, '2026-10-01', '2026-10-12')).measures.find(x => x.key === 'charged')!
    expect([oct.records, oct.ledger, oct.difference, oct.explained]).toEqual([0, 300, 300, 300])
    // Money received is the same day on both sides.
    const rec = (await parityForMonth(co.landlordId, '2026-10-01', '2026-10-12')).measures.find(x => x.key === 'received')!
    expect([rec.records, rec.ledger]).toEqual([300, 300])
  })

  it('parityMonths: last month whole and this month to date (and across a new year)', () => {
    expect(parityMonths('2026-10-12')).toEqual([{ start: '2026-09-01', end: '2026-09-30' }, { start: '2026-10-01', end: '2026-10-12' }])
    expect(parityMonths('2027-01-03')).toEqual([{ start: '2026-12-01', end: '2026-12-31' }, { start: '2027-01-01', end: '2027-01-03' }])
  })
})

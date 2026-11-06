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
  // 11/4 — THIS TEST USED TO ASSERT THE DIFFERENCE, AND NOW ASSERTS ITS ABSENCE.
  //
  // It was written 10/12 to pin a real, named difference: the books charged a
  // bill held for work trade on its due day, the money records left it out
  // until the work-trade month settled, and a reason explained the gap.
  //
  // Nic's 11/3 directive — "it should never show as November's money in the
  // first place" — took that money out of every month figure, so
  // ledgerReports' NOT_WORK_TRADE_HELD now leaves the held bill out of the
  // books' Charged too. Both sides read $0 and there is nothing left to
  // explain, so the reason was retired with it.
  //
  // KEEPING THE OLD EXPECTATION WOULD HAVE BEEN THE DANGEROUS OUTCOME, not a
  // red test: `explained` is subtracted from `difference` to get `unexplained`,
  // so a retired difference with a live reason drives unexplained to -$460,
  // parity fails, and every report for a real company silently reverts off the
  // books onto the money records. The assertion below is what proves that
  // cannot happen — it fails if either half is ever reintroduced alone.
  it('a bill on hold for work trade is not that month\'s money on EITHER side (11/3 directive) — no difference, nothing to explain', async () => {
    const co = await tenantCo()
    const held = await bill(co, { amount: 460, due: '2026-10-01' })
    await db.query(`UPDATE payments SET work_trade_suspended_at = '2026-10-01T16:00:00Z' WHERE id = $1`, [held])
    await drain()
    const m = await parityForMonth(co.landlordId, '2026-10-01', '2026-10-12')
    const charged = m.measures.find(x => x.key === 'charged')!
    expect([charged.records, charged.ledger, charged.difference, charged.explained]).toEqual([0, 0, 0, 0])
    expect(charged.reasons.map(r => r.reason)).not.toContainEqual(expect.stringMatching(/on hold for work trade/))
    // `unexplained` is what parity actually gates on, and for a measure it is
    // difference - explained (ledgerParity: a measure counts as unexplained
    // when that is non-zero). Asserted as the arithmetic rather than a field,
    // because the field lives on the RESULT and is a count of failing
    // measures, not an amount.
    expect(Math.round((charged.difference - charged.explained) * 100) / 100).toBe(0)
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

  /**
   * 11/2 — THE LINK NOBODY PAID.
   *
   * The test above covers a link that was SENT in one month and PAID in the
   * next, and it passed while Mountain View's October reported $554.05 of
   * difference that did not exist. Two of that company's reservation links
   * ($24.50 and $10.45, sent 10/24) are simply still open: the money records
   * bill a link the day it goes out and carry it as still owed, the books have
   * nothing until money arrives — correctly — and no reason named the gap.
   *
   * The dollar is read off the records reader's own events rather than
   * re-queried, because the records side carries real conditions (one link per
   * reservation, never one past its expiry, nothing for a link that is only a
   * background check) and a second hand-written copy of them is what let this
   * out in the first place.
   */
  it('a one-time pay link nobody has paid: the records bill it, the books have nothing — named', async () => {
    const co = await tenantCo()
    await db.query(
      `INSERT INTO pos_pay_links (token, landlord_id, property_id, created_by, kind, label, items, subtotal, total, customer_email, status, created_at)
       VALUES (gen_random_uuid()::text, $1, $2, $3, 'one_time', 'Site deposit', '[]'::jsonb, 24.50, 24.50, 'guest@t.dev', 'open', '2026-10-24T17:04:00Z')`,
      [co.landlordId, co.propertyId, co.ownerUserId])
    await drain()
    const oct = (await parityForMonth(co.landlordId, '2026-10-01', '2026-10-31')).measures.find(x => x.key === 'charged')!
    // Records bill it; the books have nothing; the whole difference is named,
    // so the month leaves nothing unexplained and raises no warning.
    expect([oct.records, oct.ledger, oct.difference, oct.explained]).toEqual([24.5, 0, -24.5, -24.5])
    expect(oct.reasons.map(r => r.reason)).toEqual([expect.stringMatching(/one-time pay link/)])

    const r = await checkCompanyParity(co.landlordId, '2026-10-31')
    expect(r.unexplained).toBe(0)
    const n = await notices()
    expect(n).toHaveLength(1)
    expect(n[0].severity).toBe('info')
  })

  /**
   * 11/2 (Nic: "leave it in September") — CASH IN ONE MONTH, THE BILL IT PAID IN
   * ANOTHER.
   *
   * MH 29 at Country Acres paid $500 toward September: $100 early in the month
   * and $400 that reached the bank on 10/05. September is where that income
   * belongs — dating it to arrival would put pre-GAM rent into October and
   * charge GAM's fee on it — so the bill is settled 09/01 while the books hold
   * the cash on 10/05. Nothing named it, so $400 read as unexplained and kept
   * that company's books from going live.
   */
  it("money that paid an older month's bill: cash on the books the day it came, records in the month of the bill — named both ways", async () => {
    const co = await tenantCo()
    const sep = await bill(co, { type: 'carried_balance', amount: 500, due: '2026-09-01' })
    // $100 of it arrived in September, like his did...
    await receipt(co, {
      method: 'bank_deposit', settledAt: '2026-09-03T12:00:00Z',
      apps: [{ paymentId: sep, amount: 100 }], settleRows: false,
    })
    // ...and $400 reached the bank on 10/05. settleRows:false, then settle the
    // bill in September by hand — the exact shape a carried balance takes when
    // it is settled on the day it belongs to rather than the day the money
    // turned up.
    await receipt(co, {
      method: 'bank_deposit', settledAt: '2026-10-05T12:00:00Z',
      apps: [{ paymentId: sep, amount: 400 }], settleRows: false,
    })
    await db.query(
      `UPDATE payments SET status = 'settled', settled_at = $2, manual_method = 'bank_deposit' WHERE id = $1`,
      [sep, '2026-09-01T12:00:00Z'])
    await drain()

    const oct = (await parityForMonth(co.landlordId, '2026-10-01', '2026-10-31')).measures.find(x => x.key === 'received')!
    expect([oct.difference, oct.explained]).toEqual([400, 400])
    expect(oct.reasons.map(r => r.reason)).toEqual([expect.stringMatching(/older month's bill/)])

    // The same two dates read the other way round from September's side.
    const sepM = (await parityForMonth(co.landlordId, '2026-09-01', '2026-09-30')).measures.find(x => x.key === 'received')!
    expect([sepM.difference, sepM.explained]).toEqual([-400, -400])
  })

  it('an expired open link is billed by neither side, so there is nothing to name', async () => {
    // The records skip a link past its expiry. A reason that did not would
    // explain a dollar nobody billed and push the month negative.
    const co = await tenantCo()
    await db.query(
      `INSERT INTO pos_pay_links (token, landlord_id, property_id, created_by, kind, label, items, subtotal, total, customer_email, status, created_at, expires_at)
       VALUES (gen_random_uuid()::text, $1, $2, $3, 'one_time', 'Site deposit', '[]'::jsonb, 24.50, 24.50, 'guest@t.dev', 'open', '2026-10-24T17:04:00Z', '2026-10-25T17:04:00Z')`,
      [co.landlordId, co.propertyId, co.ownerUserId])
    await drain()
    const oct = (await parityForMonth(co.landlordId, '2026-10-01', '2026-10-31')).measures.find(x => x.key === 'charged')!
    // Neither side billed it, AND nothing was named: a reason that explained a
    // dollar nobody billed would leave `explained` non-zero against a zero
    // difference, which is a phantom in the other direction.
    expect([oct.records, oct.ledger, oct.difference, oct.explained]).toEqual([0, 0, 0, 0])
    expect(oct.reasons).toEqual([])
  })

  it('parityMonths: last month whole and this month to date (and across a new year)', () => {
    expect(parityMonths('2026-10-12')).toEqual([{ start: '2026-09-01', end: '2026-09-30' }, { start: '2026-10-01', end: '2026-10-12' }])
    expect(parityMonths('2027-01-03')).toEqual([{ start: '2026-12-01', end: '2026-12-31' }, { start: '2027-01-01', end: '2027-01-03' }])
  })
})

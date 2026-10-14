/**
 * 10/12 (Nic) — GAM Books ledger, phase P8: every report reads the ledger
 * (gam-ledger-design-2026-10-12 §10, §17 "UI: the proof strip adds up").
 *
 *   Nic, 10/12: "NO Money received / Money billed toggle anywhere — show
 *   Charged, Received and Owed side by side." (L2) "Received leads."
 *
 * Real tables, the real capture triggers, the real engine with the production
 * projector set (it commits on its own connections, so every test starts from
 * a clean database).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { db } from '../db'
import {
  tenantCo, bill, receipt, spend, drain, addLease, cleanupTenantLedger, type TenantCo,
} from '../test/ledgerTenantFixtures'
import { registerProductionLedgerProjectors, unregisterProductionLedgerProjectors } from './ledgerProjectors'
import { incomeEvents, incomeBoth, moneyViewFrom, breakdownFrom, summarize, paidAheadUnusedAt } from './incomeBasis'
import {
  ledgerReportsLive, ledgerLiveCompanyIds, ledgerIncomeEvents, ledgerPLExpenses, ledgerBalanceSheet,
  ledgerTrialBalance, ledgerGeneralLedger, ledgerCashFlow, ledgerMoneyOut, ledgerProfitAndLoss, snapshotDays,
  ledgerTaxSummary, ledgerReceivables, agingBucketOf, ledgerNotLiveReason, LEDGER_REPORTS_ENV,
} from './ledgerReports'
import { computeLandlordPL, landlordPLExpenses, processingFeesByProperty } from './landlordPL'
import { createLandlordExpense, recordExpensePayment } from './landlordExpenses'
import { markLedgerLive, markRebuilt } from '../test/ledgerReportFixtures'
import { acceptParity } from './ledgerParity'

beforeEach(async () => {
  await cleanupTenantLedger()
  registerProductionLedgerProjectors()
  delete process.env[LEDGER_REPORTS_ENV]
})
afterEach(() => {
  unregisterProductionLedgerProjectors()
  delete process.env[LEDGER_REPORTS_ENV]
})

/** Todd's check (design §0): one desk check paid September and, ahead, October. */
async function toddsCheck(co: TenantCo): Promise<{ sep: string; oct: string }> {
  const sep = await bill(co, { amount: 460, due: '2026-09-01' })
  const oct = await bill(co, { amount: 460, due: '2026-10-01' })
  const { creditId } = await receipt(co, {
    method: 'check', settledAt: '2026-09-03T18:00:00Z', apps: [{ paymentId: sep, amount: 460 }], surplus: 460,
  })
  await spend(co, { paymentId: oct, amount: 460, appliedAt: '2026-10-01T15:00:00Z', prepaidCreditId: creditId! })
  await drain()
  return { sep, oct }
}

const view = async (co: TenantCo, start: string, end: string, label = 'the period') => {
  const both = await incomeBoth({ landlordIds: [co.landlordId], start, end })
  return moneyViewFrom(both.billed, both.received, { start, end, label }, both.paidAheadUnused)
}

describe('which companies read the ledger', () => {
  it('a company reads the money records until its ledger is built, then the ledger; LEDGER_REPORTS=off sends it back', async () => {
    const co = await tenantCo()
    await toddsCheck(co)
    const q = { landlordIds: [co.landlordId], start: '2026-09-01', end: '2026-09-30', basis: 'received' as const }
    expect(await ledgerReportsLive([co.landlordId])).toBe(false)
    expect((await incomeEvents(q)).some(e => e.ledger)).toBe(false)

    await markLedgerLive(co.landlordId)
    expect(await ledgerReportsLive([co.landlordId])).toBe(true)
    const evs = await incomeEvents(q)
    expect(evs.length).toBeGreaterThan(0)
    expect(evs.every(e => e.ledger === 'line')).toBe(true)

    process.env[LEDGER_REPORTS_ENV] = 'off'
    expect(await ledgerReportsLive([co.landlordId])).toBe(false)
    expect((await incomeEvents(q)).some(e => e.ledger)).toBe(false)
  })

  it('a full rebuild alone does not switch the reports; a clean parity check after it does, and an accepted one does too', async () => {
    const co = await tenantCo()
    await markRebuilt(co.landlordId)
    expect(await ledgerReportsLive([co.landlordId])).toBe(false)
    expect(await ledgerNotLiveReason(co.landlordId)).toMatch(/once the nightly check finds they match/)
    // A check with something unexplained keeps the money records.
    await db.query(`INSERT INTO ledger_rebuild_runs (landlord_id, mode, status, scope, counts, finished_at)
                    VALUES ($1, 'check', 'done', '{"kind":"parity"}'::jsonb, '{"differences":2,"unexplained":1}'::jsonb, now())`, [co.landlordId])
    expect(await ledgerReportsLive([co.landlordId])).toBe(false)
    // An admin accepts the differences: the reports switch.
    await acceptParity(co.landlordId, co.ownerUserId, 'The two DoorLoop deposits are known.')
    expect(await ledgerReportsLive([co.landlordId])).toBe(true)
    expect(await ledgerNotLiveReason(co.landlordId)).toBeNull()

    // A clean check BEFORE the first full rebuild never counts.
    const early = await tenantCo()
    await db.query(`INSERT INTO ledger_rebuild_runs (landlord_id, mode, status, scope, counts, started_at, finished_at)
                    VALUES ($1, 'check', 'done', '{"kind":"parity"}'::jsonb, '{"differences":0,"unexplained":0}'::jsonb, now() - interval '1 hour', now() - interval '1 hour')`, [early.landlordId])
    await markRebuilt(early.landlordId)
    expect(await ledgerReportsLive([early.landlordId])).toBe(false)
  })

  it('a partial rebuild (one source type, or from a date) does not make the books live; no start date never does', async () => {
    const co = await tenantCo()
    await db.query(
      `INSERT INTO ledger_rebuild_runs (landlord_id, mode, status, scope) VALUES ($1, 'apply', 'done', '{"sourceType":"payment","since":null}'::jsonb),
                                                                              ($1, 'apply', 'done', '{"sourceType":null,"since":"2026-09-01"}'::jsonb),
                                                                              ($1, 'from_scratch', 'failed', '{"sourceType":null,"since":null}'::jsonb)`,
      [co.landlordId])
    expect(await ledgerReportsLive([co.landlordId])).toBe(false)
    const none = await tenantCo({ booksStart: null })
    await markLedgerLive(none.landlordId)
    expect((await ledgerLiveCompanyIds([none.landlordId])).size).toBe(0)
  })

  it('a screen over two companies reads the ledger only when both are live (never a mix for one screen)', async () => {
    const a = await tenantCo()
    const b = await tenantCo()
    await markLedgerLive(a.landlordId)
    expect(await ledgerReportsLive([a.landlordId, b.landlordId])).toBe(false)
    expect(await ledgerReportsLive(null)).toBe(false)
    await markLedgerLive(b.landlordId)
    expect(await ledgerReportsLive([a.landlordId, b.landlordId])).toBe(true)
  })
})

describe('Received, Charged and Owed from the ledger (design §10)', () => {
  it("Todd's two-month check: September receives both months, October receives $0; each month is charged once", async () => {
    const co = await tenantCo()
    await toddsCheck(co)
    await markLedgerLive(co.landlordId)

    const sep = await view(co, '2026-09-01', '2026-09-30', 'September 2026')
    expect(sep.source).toBe('ledger')
    expect([sep.received, sep.charged, sep.owed]).toEqual([920, 460, 0])
    expect(sep.lines.find(l => l.line === 'paidAhead')!.received).toBe(460)
    expect(sep.lines.find(l => l.line === 'rent')).toMatchObject({ received: 460, charged: 460, owed: 0 })
    // The landlord holds the October half until it pays October's bill.
    expect(sep.beside.find(b => b.key === 'paidAheadUnused')!.amount).toBe(460)

    const oct = await view(co, '2026-10-01', '2026-10-31', 'October 2026')
    expect([oct.received, oct.charged, oct.owed]).toEqual([0, 460, 0])
    // The strip: owed $0 at the start + billed $460 − paid from money paid ahead $460 = $0.
    expect(oct.proof).toMatchObject({ owedAtStart: 0, billed: 460, received: 0, paidAhead: 460, owedAtEnd: 0 })
    expect(oct.tieText[1]).toMatch(/paid from money paid ahead \$460\.00 = owed \$0\.00 at the end of Oct 31, 2026/)
    expect(oct.beside.find(b => b.key === 'paidAheadUnused')).toBeUndefined()
  })

  it('Owed is the receivables at the END of the period, every bill; the strip starts from what was owed before', async () => {
    const co = await tenantCo()
    await bill(co, { amount: 1000, due: '2026-09-01' })
    const octBill = await bill(co, { amount: 1000, due: '2026-10-01' })
    await bill(co, { type: 'late_fee', amount: 25, due: '2026-10-06' })
    await receipt(co, { method: 'cash', settledAt: '2026-10-10T17:00:00Z', apps: [{ paymentId: octBill, amount: 400 }], settleRows: false })
    await drain()
    await markLedgerLive(co.landlordId)

    const sep = await view(co, '2026-09-01', '2026-09-30')
    expect([sep.received, sep.charged, sep.owed]).toEqual([0, 1000, 1000])
    const oct = await view(co, '2026-10-01', '2026-10-31')
    expect([oct.received, oct.charged, oct.owed]).toEqual([400, 1025, 1625])
    expect(oct.proof).toMatchObject({ owedAtStart: 1000, billed: 1025, received: 400, owedAtEnd: 1625 })
    const p = oct.proof!
    expect(p.owedAtStart + p.billed - p.received - p.creditsGiven - p.workTrade - p.paidAhead - p.deposits + p.corrections)
      .toBeCloseTo(p.owedAtEnd, 2)
    // A two-month view counts the last month's end once, never the two ends added.
    const both = await view(co, '2026-09-01', '2026-10-31')
    expect([both.charged, both.owed]).toEqual([2025, 1625])
    expect(both.proof).toMatchObject({ owedAtStart: 0, owedAtEnd: 1625 })
    // By category (the dashboard and property detail read breakdownFrom).
    const b = await incomeBoth({ landlordIds: [co.landlordId], start: '2026-10-01', end: '2026-10-31' })
    const br = breakdownFrom('received', b.billed, b.received)
    expect(br.categories.find(c => c.category === 'space_rent')!.owed).toBe(1600)
    expect(br.categories.find(c => c.category === 'late_fees')!.owed).toBe(25)
    // The marks the ledger adds are in no total.
    expect(summarize(b.billed, 'billed').total).toBe(1025)
  })

  it('reads one property when asked: a bill on another property is in neither column', async () => {
    const co = await tenantCo()
    await bill(co, { amount: 700, due: '2026-10-01' })
    const other = await addLease(co)
    await bill(co, { amount: 300, due: '2026-10-01', unitId: other.unitId, leaseId: other.leaseId })
    await drain()
    await markLedgerLive(co.landlordId)
    const evs = await incomeEvents({ landlordIds: [co.landlordId], start: '2026-10-01', end: '2026-10-31', basis: 'billed', propertyIds: [co.propertyId] })
    const v = moneyViewFrom(evs, [], { start: '2026-10-01', end: '2026-10-31', label: 'October' })
    expect([v.charged, v.owed]).toEqual([700, 700])
    // A former property's lines after its last day are never read (a bookkeeper's clean cut).
    const cut = await incomeEvents({
      landlordIds: [co.landlordId], start: '2026-10-01', end: '2026-10-31', basis: 'billed',
      cutoffs: [{ propertyId: co.propertyId2, lastDay: '2026-09-30' }],
    })
    expect(moneyViewFrom(cut, [], { start: '2026-10-01', end: '2026-10-31', label: 'October' }).charged).toBe(700)
  })

  it('a landlord credit is a minus line in Charged and in the strip, never money received', async () => {
    const co = await tenantCo()
    const rent = await bill(co, { amount: 500, due: '2026-10-01' })
    const credit = (await db.query<{ id: string }>(
      `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category, status)
       VALUES ($1, $2, $3, 50, 50, 'goodwill', 'active') RETURNING id`, [co.landlordId, co.tenantId, co.leaseId])).rows[0].id
    await spend(co, { paymentId: rent, amount: 50, appliedAt: '2026-10-02T15:00:00Z', tenantCreditId: credit, settle: false })
    await drain()
    await markLedgerLive(co.landlordId)
    const v = await view(co, '2026-10-01', '2026-10-31')
    expect([v.received, v.charged, v.owed]).toEqual([0, 450, 450])
    expect(v.lines.find(l => l.line === 'creditsGiven')!.charged).toBe(-50)
    expect(v.proof).toMatchObject({ billed: 500, creditsGiven: 50, owedAtEnd: 450 })
  })

  it('snapshotDays: each month end inside the period, and the last day', () => {
    expect(snapshotDays('2026-09-01', '2026-10-13')).toEqual(['2026-09-30', '2026-10-13'])
    expect(snapshotDays('2026-01-15', '2026-03-31')).toEqual(['2026-01-31', '2026-02-28', '2026-03-31'])
    expect(snapshotDays('2026-12-01', '2027-01-05')).toEqual(['2026-12-31', '2027-01-05'])
  })
})

describe('expenses: incurred (Charged-based) and paid (Received-based)', () => {
  it('a bill counts as incurred on its date and as paid on the day it was paid; the nets follow', async () => {
    const co = await tenantCo()
    const exp = await createLandlordExpense({
      landlordId: co.landlordId, category: 'repairs', amount: 300, expenseDate: '2026-09-10', propertyId: co.propertyId,
      payment: null,
    })
    await recordExpensePayment({ landlordId: co.landlordId, expenseId: exp.id, method: 'cash', paidOn: '2026-10-05', createdBy: null })
    const rent = await bill(co, { amount: 1000, due: '2026-10-01' })
    await receipt(co, { method: 'cash', settledAt: '2026-10-02T17:00:00Z', apps: [{ paymentId: rent, amount: 1000 }] })
    await drain()
    await markLedgerLive(co.landlordId)

    const sepEx = await landlordPLExpenses(co.landlordId, '2026-09-01', '2026-09-30', ['2026-09-01'])
    expect([sepEx.total, sepEx.cashTotal, sepEx.maintenance]).toEqual([300, 0, 300])
    const octEx = await landlordPLExpenses(co.landlordId, '2026-10-01', '2026-10-31', ['2026-10-01'])
    expect([octEx.total, octEx.cashTotal]).toEqual([0, 300])
    expect(octEx.byAccount!.map(a => [a.code, a.incurred, a.paid])).toEqual([['5040', 0, 300]])

    const pl = await computeLandlordPL(co.landlordId, '2026-10-01', '2026-10-31', ['2026-10-01'])
    expect(pl.view.received).toBe(1000)
    expect(pl.nets).toEqual({ received: 700, charged: 1000 })

    const ledgerPl = await ledgerProfitAndLoss({ landlordIds: [co.landlordId] }, '2026-09-01', '2026-10-31', 'Sep–Oct')
    expect(ledgerPl.expenses).toMatchObject({ paid: 300, incurred: 300 })
    expect(ledgerPl.nets).toEqual({ received: 700, charged: 700 })
    // 10/14 (Nic I1): rent books to its space's own line — an apartment's
    // rent to "Apartment rent", a sub-account under 4010 Space and lot rent.
    expect(ledgerPl.incomeAccounts.map(a => [a.code, a.name, a.charged])).toEqual([['4010-1', 'Apartment rent', 1000]])
  })

  it('money out: incurred, paid and still unpaid by category, and unpaid by vendor', async () => {
    const co = await tenantCo()
    const vendor = (await db.query<{ id: string }>(
      `INSERT INTO books_vendors (landlord_id, name) VALUES ($1, 'Acme Plumbing') RETURNING id`, [co.landlordId])).rows[0].id
    await createLandlordExpense({
      landlordId: co.landlordId, category: 'repairs', amount: 200, expenseDate: '2026-10-03', propertyId: co.propertyId,
      vendorId: vendor, payment: null,
    })
    await createLandlordExpense({
      landlordId: co.landlordId, category: 'utilities', amount: 80, expenseDate: '2026-10-04', propertyId: co.propertyId,
      payment: { method: 'cash' },
    })
    await drain()
    await markLedgerLive(co.landlordId)
    const mo = await ledgerMoneyOut({ landlordIds: [co.landlordId] }, '2026-10-01', '2026-10-31')
    expect(mo.totals).toEqual({ incurred: 280, paid: 80, unpaid: 200 })
    expect(mo.unpaidByVendor).toEqual([{ vendorId: vendor, name: 'Acme Plumbing', unpaid: 200 }])
    const repairs = mo.rows.find(r => r.incurred === 200)!
    expect(repairs).toMatchObject({ paid: 0, unpaid: 200 })
  })
})

describe('Owed by household, with aging (design §10)', () => {
  it('each bill\'s open amount is aged by its due date, by tenant and property; the total is the receivables', async () => {
    const co = await tenantCo()
    await bill(co, { amount: 300, due: '2026-08-15' })
    const sep = await bill(co, { amount: 1000, due: '2026-09-01' })
    await bill(co, { amount: 1000, due: '2026-10-01' })
    await bill(co, { amount: 1000, due: '2026-11-01' })
    await receipt(co, { method: 'cash', settledAt: '2026-09-05T17:00:00Z', apps: [{ paymentId: sep, amount: 600 }], settleRows: false })
    await drain()
    const r = await ledgerReceivables({ landlordIds: [co.landlordId] }, '2026-10-20')
    expect(r.totals.total).toBe(1700)   // the November bill is not owed yet on 10/20 (posts on its due day)
    expect(r.totals.buckets).toEqual({ current: 0, days1to30: 1000, days31to60: 400, days61to90: 300, over90: 0 })
    expect(r.rows).toHaveLength(1)
    expect(r.rows[0]).toMatchObject({ tenantId: co.tenantId, propertyId: co.propertyId, total: 1700 })
    expect(agingBucketOf('2026-10-20', '2026-10-20')).toBe('current')
    expect(agingBucketOf('2026-07-01', '2026-10-20')).toBe('over90')
  })
})

describe('beside Charged (design §10): deposits billed, a note\'s principal, tax', () => {
  it('a deposit billed is listed beside Charged, never in it', async () => {
    const co = await tenantCo()
    await bill(co, { amount: 1000, due: '2026-10-01' })
    await bill(co, { type: 'deposit', amount: 500, due: '2026-10-01' })
    await drain()
    const pl = await ledgerProfitAndLoss({ landlordIds: [co.landlordId] }, '2026-10-01', '2026-10-31', 'October')
    expect(pl.view.charged).toBe(1000)
    expect(pl.chargedBeside).toEqual([{ key: 'depositsBilled', label: 'Deposits billed (held for tenants, never income)', amount: 500 }])
    // Owed is every bill: the deposit is still owed too.
    expect(pl.view.owed).toBe(1500)
    expect(pl.view.uncategorized.find(l => l.line === 'depositsOwed')!.owed).toBe(500)
  })
})

describe('a closed month is never rewritten (design §13)', () => {
  it('a September bill written after September closed posts in October, listed as a correction to September', async () => {
    const co = await tenantCo()
    await bill(co, { amount: 500, due: '2026-09-01' })
    await drain()
    await db.query(`INSERT INTO books_period_closes (landlord_id, action, closed_through) VALUES ($1, 'close', '2026-09-30')`, [co.landlordId])
    await bill(co, { type: 'late_fee', amount: 25, due: '2026-09-20' })
    await drain()
    const sep = await ledgerProfitAndLoss({ landlordIds: [co.landlordId] }, '2026-09-01', '2026-09-30', 'September')
    expect(sep.view.charged).toBe(500)
    const oct = await ledgerProfitAndLoss({ landlordIds: [co.landlordId] }, '2026-10-01', '2026-10-31', 'October')
    expect(oct.view.charged).toBe(25)
    expect(oct.corrections).toEqual([{ month: '2026-09', received: 0, charged: 25, expensesIncurred: 0 }])
    expect(sep.corrections).toEqual([])
  })
})

describe('the statements tie out', () => {
  async function busyCompany(): Promise<TenantCo> {
    const co = await tenantCo()
    await toddsCheck(co)
    const second = await addLease(co)
    await bill(co, { amount: 1000, due: '2026-10-01', unitId: second.unitId, leaseId: second.leaseId })
    await createLandlordExpense({
      landlordId: co.landlordId, category: 'repairs', amount: 125, expenseDate: '2026-10-04', propertyId: co.propertyId,
      payment: { method: 'cash' },
    })
    await drain()
    await markLedgerLive(co.landlordId)
    return co
  }

  it('the balance sheet balances, with this year\'s earnings computed', async () => {
    const co = await busyCompany()
    const bs = await ledgerBalanceSheet({ landlordIds: [co.landlordId] }, '2026-10-31')
    expect(bs.balances).toBe(true)
    expect(bs.totalAssets).toBeCloseTo(bs.totalLiabilities + bs.totalEquity, 2)
    // Income charged 460 + 460 + 1000, less the repair: this year's earnings.
    expect(bs.earnings).toEqual({ thisYear: 1795, earlierYears: 0 })
  })

  it('the trial balance balances for the company, for each property and for the company\'s own lines', async () => {
    const co = await busyCompany()
    for (const p of ['all', co.propertyId, co.propertyId2, 'company']) {
      const tb = await ledgerTrialBalance({ landlordIds: [co.landlordId] }, '2026-10-01', '2026-10-31', p)
      expect(tb.balances, `property ${p}`).toBe(true)
    }
    const all = await ledgerTrialBalance({ landlordIds: [co.landlordId] }, '2026-10-01', '2026-10-31')
    const ar = all.rows.find(r => r.code === '1100')!
    expect([ar.opening, ar.closing]).toEqual([0, 1000])
  })

  it('the general ledger runs each line\'s balance to the account\'s balance and names the record behind it', async () => {
    const co = await busyCompany()
    const ar = (await db.query<{ id: string }>(
      `SELECT DISTINCT account_id AS id FROM ledger_posting_lines WHERE landlord_id = $1 AND account_role = 'ar_tenants'`, [co.landlordId])).rows[0].id
    const gl = (await ledgerGeneralLedger({ landlordIds: [co.landlordId] }, ar, '2026-09-01', '2026-10-31'))!
    expect(gl.opening).toBe(0)
    expect(gl.closing).toBe(1000)
    expect(gl.lines[gl.lines.length - 1].balance).toBe(1000)
    expect(gl.lines.map(l => l.source.label)).toContain('A tenant bill')
    expect(gl.lines.every(l => !l.source.label.includes('_'))).toBe(true)
    // Another company's account is not this one's to open.
    const other = await tenantCo()
    expect(await ledgerGeneralLedger({ landlordIds: [other.landlordId] }, ar, '2026-09-01', '2026-10-31')).toBeNull()
  })

  it('cash flow: the opening cash plus each row equals the closing cash', async () => {
    const co = await busyCompany()
    const cf = await ledgerCashFlow({ landlordIds: [co.landlordId] }, '2026-09-01', '2026-10-31')
    const rows = cf.rows.reduce((t, r) => t + r.amount, 0)
    expect(cf.openingCash + rows).toBeCloseTo(cf.closingCash, 2)
    expect(cf.netChange).toBeCloseTo(rows, 2)
    // Todd's $920 check came in (the drawer), the $125 repair went out of it.
    expect(cf.closingCash).toBe(795)
    expect(cf.totals.operating).toBe(795)
  })

  it('tax summary is empty when nothing taxed posted', async () => {
    const co = await busyCompany()
    const t = await ledgerTaxSummary({ landlordIds: [co.landlordId] }, '2026-01-01', '2026-12-31')
    expect(t.totals).toEqual({ collected: 0, paid: 0, owedAtEnd: 0 })
  })
})

describe('readers switched without changing their callers', () => {
  it('paid-ahead money on hand and the processing fees come from the ledger once live', async () => {
    const co = await tenantCo()
    await toddsCheck(co)
    await markLedgerLive(co.landlordId)
    expect(await paidAheadUnusedAt({ landlordIds: [co.landlordId], end: '2026-09-30' })).toBe(460)
    expect(await paidAheadUnusedAt({ landlordIds: [co.landlordId], end: '2026-10-31' })).toBe(0)
    expect((await processingFeesByProperty([co.landlordId], '2026-09-01', '2026-10-31')).size).toBe(0)
  })

  it('the ledger reader refuses nothing it cannot see: no company, no property, empty', async () => {
    expect(await ledgerIncomeEvents({ landlordIds: [], start: '2026-09-01', end: '2026-09-30', basis: 'billed' })).toEqual([])
    expect(await ledgerIncomeEvents({ landlordIds: null, start: '2026-09-01', end: '2026-09-30', basis: 'billed' })).toEqual([])
    const co = await tenantCo()
    expect(await ledgerIncomeEvents({ landlordIds: [co.landlordId], start: '2026-09-01', end: '2026-09-30', basis: 'billed', propertyIds: [] })).toEqual([])
    const ex = await ledgerPLExpenses({ landlordIds: [co.landlordId] }, '2026-09-01', '2026-09-30')
    expect(ex.total).toBe(0)
  })
})

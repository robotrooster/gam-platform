/**
 * 10/12 (Nic) — GAM Books ledger: the review of the reports (P8), the close
 * and reconciliation (P9) and the fixes lane, fixed
 * (gam-ledger-design-2026-10-12 §10, §13).
 *
 *   Nic, 10/12: "Received leads" (L2); "company-level costs: landlord's choice
 *   (Company bucket vs split by units)" (L7).
 *
 * Real tables, real capture triggers, the real engine with the production
 * projector set (it commits on its own connections, so every test starts from
 * a clean database); the pure pieces are tested on their own.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { inTx } from '../test/ledgerFixtures'
import {
  cleanupTenantLedger, tenantCo, bill, receipt, drain, addLease, type TenantCo,
} from '../test/ledgerTenantFixtures'
import { sale } from '../test/ledgerP5Fixtures'
import { markLedgerLive } from '../test/ledgerReportFixtures'
import { registerProductionLedgerProjectors, unregisterProductionLedgerProjectors } from './ledgerProjectors'
import { incomeBoth, moneyViewFrom, ledgerOwedDay, breakdownFrom, type IncomeEvent } from './incomeBasis'
import {
  ledgerGeneralLedger, ledgerCashFlow, ledgerTaxSummary, ledgerPLExpenses, ledgerIncomeEvents, expenseLinePaidCents,
  LEDGER_REPORTS_ENV, type ExpensePostingLine,
} from './ledgerReports'
import { runReport } from './reportEngine'
import { createLandlordExpense } from './landlordExpenses'
import { matchLineToExpenses } from './bankMoneyOut'
import { ensureChart } from './booksLedgerChart'
import { parityMonthsFrom, parityMonths } from './ledgerParity'
import { pickReconcileAccount, classifyStatementLines } from './bankReconciliation'
import { getPortfolioStats } from './agents/tools/getPortfolioStats'

beforeEach(async () => {
  await cleanupTenantLedger()
  registerProductionLedgerProjectors()
  delete process.env[LEDGER_REPORTS_ENV]
})
afterEach(() => {
  unregisterProductionLedgerProjectors()
  delete process.env[LEDGER_REPORTS_ENV]
})

const roleAccount = async (landlordId: string, role: string): Promise<string> =>
  (await db.query<{ id: string }>(
    `SELECT account_id AS id FROM books_account_map WHERE landlord_id = $1 AND map_kind = 'role' AND map_value = $2
      ORDER BY effective_from DESC, id DESC LIMIT 1`, [landlordId, role])).rows[0].id

describe('Owed is the balance on the day the books were read — $0 when nothing is owed then', () => {
  it('a property paid up by the end reads $0 (not September\'s $500); the properties add up to the company; the strip ties out from the books', async () => {
    const co = await tenantCo()
    const sep = await bill(co, { amount: 500, due: '2026-09-01' })
    await receipt(co, { method: 'cash', settledAt: '2026-10-05T17:00:00Z', apps: [{ paymentId: sep, amount: 500 }] })
    const other = await addLease(co)
    await bill(co, { amount: 300, due: '2026-10-01', unitId: other.unitId, leaseId: other.leaseId })
    await drain()
    await markLedgerLive(co.landlordId)

    const period = { start: '2026-09-01', end: '2026-10-31', label: 'Sep–Oct' }
    const both = await incomeBoth({ landlordIds: [co.landlordId], start: period.start, end: period.end })
    const of = (list: readonly IncomeEvent[], p: string) => list.filter(e => e.propertyId === p)
    expect(ledgerOwedDay(of(both.billed, co.propertyId))).toBe('2026-10-31')
    const one = moneyViewFrom(of(both.billed, co.propertyId), of(both.received, co.propertyId), period)
    const two = moneyViewFrom(of(both.billed, co.propertyId2), of(both.received, co.propertyId2), period)
    const all = moneyViewFrom(both.billed, both.received, period)
    expect([one.owed, two.owed, all.owed]).toEqual([0, 300, 300])
    expect(all.proof).toMatchObject({ owedAtStart: 0, owedAtEnd: 300, offBy: 0 })

    // October alone: owed at the start is September's end, read from the books.
    const oct = await incomeBoth({ landlordIds: [co.landlordId], start: '2026-10-01', end: '2026-10-31' })
    const vo = moneyViewFrom(oct.billed, oct.received, { start: '2026-10-01', end: '2026-10-31', label: 'October' })
    expect(vo.proof).toMatchObject({ owedAtStart: 500, billed: 300, received: 500, owedAtEnd: 300, offBy: 0 })
    expect(vo.tieText[1]).not.toMatch(/off by/)
    // October read out of the two months' facts (the Reports overview splits
    // them by month): its opening balance is among October's own facts.
    const inOct = (list: readonly IncomeEvent[]) => list.filter(e => e.day >= '2026-10-01' && e.day <= '2026-10-31')
    const vm = moneyViewFrom(inOct(both.billed), inOct(both.received), { start: '2026-10-01', end: '2026-10-31', label: 'October' })
    expect(vm.proof).toMatchObject({ owedAtStart: 500, owedAtEnd: 300, offBy: 0 })
    expect(vm.owed).toBe(300)
    // The dashboard's trend breaks the six months read together into months:
    // September's own end, never the six months' end.
    const inSep = (list: readonly IncomeEvent[]) => list.filter(e => e.day >= '2026-09-01' && e.day <= '2026-09-30')
    const sepBreakdown = breakdownFrom('received', inSep(both.billed), inSep(both.received), { start: '2026-09-01', end: '2026-09-30' })
    expect(sepBreakdown.categories.find(c => c.category === 'space_rent')?.owed).toBe(500)

    // The report engine: the total is the balance at the end, each property its own.
    const r = await runReport({ landlordIds: [co.landlordId], start: period.start, end: period.end, level: 'property', bucket: 'total' })
    expect(r.totals.money.owed).toBe(300)
    expect(r.rows.find(x => x.propertyId === co.propertyId)?.money.owed ?? 0).toBe(0)
    const monthly = await runReport({ landlordIds: [co.landlordId], start: period.start, end: period.end, level: 'portfolio', bucket: 'monthly' })
    expect(monthly.rows.find(x => x.period === '2026-09')?.money.owed).toBe(500)
    expect(monthly.rows.find(x => x.period === '2026-10')?.money.owed).toBe(300)
    expect(monthly.totals.money.owed).toBe(300)
  })
})

describe('the paid (Received-based) expense column is decided line by line', () => {
  const L = (lineNo: number, cents: number, kind: ExpensePostingLine['kind']): ExpensePostingLine => ({ lineNo, cents, kind })

  it('a payout split: the fee and the manager\'s cut taken from the money are paid; the cut still owed (accounts payable) is not', () => {
    const lines = [L(1, 300, 'expense'), L(2, 500, 'expense'), L(3, -800, 'paying'), L(4, 200, 'expense'), L(5, -200, 'deferred')]
    const paid = expenseLinePaidCents(lines)
    expect([paid.get(1), paid.get(2), paid.get(4) ?? 0]).toEqual([300, 500, 0])
    // Its reversal takes back exactly what it counted.
    const back = expenseLinePaidCents(lines.map(l => ({ ...l, cents: -l.cents })))
    expect([back.get(1), back.get(2), back.get(4) ?? 0]).toEqual([-300, -500, 0])
  })

  it('a card register sale counted at cost per item: the card fee is paid out of the sale, the stock used is not', () => {
    const lines = [L(1, -10000, 'paying'), L(2, -660, 'paying'), L(3, 10360, 'paying'), L(4, 300, 'expense'), L(5, 4000, 'expense'), L(6, -4000, 'deferred')]
    const paid = expenseLinePaidCents(lines)
    expect([paid.get(4), paid.get(5) ?? 0]).toEqual([300, 0])
  })

  it('an accrual is never paid; money between properties is left out of the matching', () => {
    expect(expenseLinePaidCents([L(1, 100, 'expense'), L(2, -100, 'deferred')]).get(1) ?? 0).toBe(0)
    const split = expenseLinePaidCents([L(1, 60, 'expense'), L(2, 40, 'expense'), L(3, -100, 'paying'), L(4, 40, 'skip'), L(5, -40, 'skip')])
    expect([split.get(1), split.get(2)]).toEqual([60, 40])
  })

  it('hand journal entries: an expense against an accrued account is incurred and not paid; against the checking account, paid', async () => {
    const co = await tenantCo()
    await inTx(c => ensureChart(c, co.owner))
    const repairs = await roleAccount(co.landlordId, 'repairs_maintenance')
    const checking = await roleAccount(co.landlordId, 'bank_checking')
    const accrued = (await db.query<{ id: string }>(
      `INSERT INTO books_accounts (landlord_id, code, name, type) VALUES ($1, '2500', 'Accrued expenses', 'liability') RETURNING id`,
      [co.landlordId])).rows[0].id
    const journal = (n: number, day: string, amount: number, from: string) => inTx(async (c) => {
      const e = (await c.query<{ id: string }>(
        `INSERT INTO journal_entries (landlord_id, entry_number, date, description) VALUES ($1, $2, $3, 'Repairs') RETURNING id`,
        [co.landlordId, n, day])).rows[0].id
      await c.query(`INSERT INTO journal_entry_lines (entry_id, account_id, debit) VALUES ($1, $2, $3)`, [e, repairs, amount])
      await c.query(`INSERT INTO journal_entry_lines (entry_id, account_id, credit) VALUES ($1, $2, $3)`, [e, from, amount])
    })
    await journal(1, '2026-10-05', 100, accrued)
    await journal(2, '2026-10-06', 50, checking)
    expect(await drain()).toMatchObject({ failed: 0 })
    const ex = await ledgerPLExpenses({ landlordIds: [co.landlordId] }, '2026-10-01', '2026-10-31')
    expect([ex.total, ex.cashTotal]).toEqual([150, 50])
  })
})

describe('the general ledger: the closing balance is the whole period\'s, a page at a time', () => {
  it('pages carry their running balance from every line before them; folded corrections are left out of the run', async () => {
    const co = await tenantCo()
    const ids: string[] = []
    for (let d = 1; d <= 5; d++) ids.push(await bill(co, { amount: 100, due: `2026-09-0${d}` }))
    await drain()
    // A same-day correction: the third bill becomes $150 (its old posting and its reversal fold away).
    await db.query(`UPDATE payments SET amount = 150 WHERE id = $1`, [ids[2]])
    await drain()
    const ar = await roleAccount(co.landlordId, 'ar_tenants')
    const s = { landlordIds: [co.landlordId] }
    const whole = (await ledgerGeneralLedger(s, ar, '2026-09-01', '2026-09-30'))!
    expect(whole).toMatchObject({ closing: 550, totalLines: 5, truncated: false, hiddenCorrections: 2 })
    expect(whole.lines.map(l => l.balance)).toEqual([100, 200, 350, 450, 550])
    const first = (await ledgerGeneralLedger(s, ar, '2026-09-01', '2026-09-30', { limit: 2 }))!
    expect(first).toMatchObject({ closing: 550, totalLines: 5, truncated: true, offset: 0, limit: 2 })
    expect(first.lines.map(l => l.balance)).toEqual([100, 200])
    const second = (await ledgerGeneralLedger(s, ar, '2026-09-01', '2026-09-30', { limit: 2, offset: 2 }))!
    expect(second.lines.map(l => l.balance)).toEqual([350, 450])
    expect(second.closing).toBe(550)
    const shown = (await ledgerGeneralLedger(s, ar, '2026-09-01', '2026-09-30', { showCorrections: true }))!
    expect(shown).toMatchObject({ totalLines: 7, hiddenCorrections: 0, closing: 550 })
    expect(shown.lines[shown.lines.length - 1].balance).toBe(550)
  })
})

describe('cash flow: a check is read by what it paid for', () => {
  it('an owner draw paid by check that the bank clears later is financing, never "checks that cleared"', async () => {
    const co = await tenantCo()
    await db.query(`UPDATE landlords SET books_company_costs_method = 'company_bucket' WHERE id = $1`, [co.landlordId])
    const connectionId = (await db.query<{ id: string }>(
      `INSERT INTO bank_connections (landlord_id, provider, status, display_name) VALUES ($1, 'stripe_fc', 'active', 'Operating') RETURNING id`,
      [co.landlordId])).rows[0].id
    const e = await createLandlordExpense({
      landlordId: co.landlordId, category: 'owner_draw', amount: 400, expenseDate: '2026-10-01',
      payment: { method: 'check', paidOn: '2026-10-01' },
    })
    const payment = (await db.query<{ id: string }>(`SELECT id FROM landlord_expense_payments WHERE expense_id = $1`, [e.id])).rows[0].id
    const line = (await db.query<{ id: string }>(
      `INSERT INTO bank_transactions (bank_connection_id, landlord_id, external_id, posted_date, amount, description, normalized_merchant, status, bank_status)
       VALUES ($1, $2, $3, '2026-10-09', -400, 'CHECK 1001', 'CHECK 1001', 'needs_review', 'posted') RETURNING id`,
      [connectionId, co.landlordId, randomUUID()])).rows[0].id
    await matchLineToExpenses({ landlordId: co.landlordId, lineId: line, paymentIds: [payment], by: null })
    expect(await drain()).toMatchObject({ failed: 0 })
    const cf = await ledgerCashFlow({ landlordIds: [co.landlordId] }, '2026-10-01', '2026-10-31')
    expect(cf.rows).toEqual([{ section: 'financing', key: 'ap:equity', label: 'Owner draws and money taken out', amount: -400 }])
    expect(cf.openingCash + cf.rows.reduce((t, r) => t + r.amount, 0)).toBeCloseTo(cf.closingCash, 2)
  })
})

describe('tax: given back to a customer comes off Collected, never "paid"', () => {
  it('a cash sale with tax, refunded in cash: collected $0, paid $0, owed $0', async () => {
    const co = await tenantCo()
    const s = await sale(co, {
      subtotal: 100, tax: 6.6, taxBreakdown: [{ name: 'Transaction privilege tax', rate: 0.066, amount: 6.6 }], at: '2026-09-15 18:00:00+00',
    })
    await db.query(
      `INSERT INTO pos_refunds (transaction_id, landlord_id, amount, refund_method, tax_refunded, card_fee_refunded, created_at)
       VALUES ($1, $2, 106.6, 'cash', 6.6, 0, '2026-09-20 18:00:00+00')`, [s, co.landlordId])
    expect(await drain()).toMatchObject({ failed: 0 })
    const t = await ledgerTaxSummary({ landlordIds: [co.landlordId] }, '2026-01-01', '2026-12-31')
    expect(t.totals).toEqual({ collected: 0, paid: 0, owedAtEnd: 0 })
    const sep = await ledgerTaxSummary({ landlordIds: [co.landlordId] }, '2026-09-01', '2026-09-16')
    expect(sep.totals).toEqual({ collected: 6.6, paid: 0, owedAtEnd: 6.6 })
  })
})

describe('GAM\'s company-level charges follow the company\'s choice (Nic L7)', () => {
  it('split by units: the bank cost of a pull is spread across the properties; with no choice yet it goes to the Company column (10/13, Nic)', async () => {
    const co = await tenantCo()
    await addLease(co)   // a unit on the second property
    await db.query(`UPDATE landlords SET books_company_costs_method = 'split_by_units' WHERE id = $1`, [co.landlordId])
    const charge = async (landlordId: string) => (await db.query<{ id: string }>(
      `INSERT INTO landlord_gam_charges (landlord_id, property_id, kind, amount, source_type) VALUES ($1, NULL, 'bank_debit_cost', 6, 'test') RETURNING id`,
      [landlordId])).rows[0].id
    const id = await charge(co.landlordId)
    expect(await drain()).toMatchObject({ failed: 0 })
    const ls = (await db.query<{ role: string; property_id: string | null; dr: number; cr: number }>(
      `SELECT l.account_role AS role, l.property_id, l.debit::float AS dr, l.credit::float AS cr
         FROM ledger_posting_lines l JOIN ledger_postings p ON p.id = l.posting_id
        WHERE p.source_type = 'gam_charge' AND p.source_id = $1 AND p.role = 'post' AND p.superseded_at IS NULL
          AND l.account_role <> 'interproperty_clearing'
        ORDER BY l.account_role, l.property_id`, [id])).rows
    expect(ls.filter(l => l.role === 'bank_fees').map(l => [l.property_id, l.dr]).sort())
      .toEqual([[co.propertyId, 3], [co.propertyId2, 3]].sort())
    expect(ls.filter(l => l.role === 'due_to_gam')).toEqual([{ role: 'due_to_gam', property_id: null, dr: 0, cr: 6 }])

    // 10/13 (Nic): "Company-level costs before the owner picks: post to the
    // COMPANY column by default" — nothing waits on the choice.
    const none = await tenantCo()
    await db.query(`UPDATE landlords SET books_company_costs_method = NULL WHERE id = $1`, [none.landlordId])
    const unpicked = await charge(none.landlordId)
    expect(await drain()).toMatchObject({ failed: 0 })
    const err = (await db.query<{ reason_code: string }>(
      `SELECT reason_code FROM ledger_source_errors WHERE source_type = 'gam_charge' AND source_id = $1`, [unpicked])).rows[0]
    expect(err).toBeUndefined()
    const cl = (await db.query<{ role: string; property_id: string | null; dr: number; cr: number }>(
      `SELECT l.account_role AS role, l.property_id, l.debit::float AS dr, l.credit::float AS cr
         FROM ledger_posting_lines l JOIN ledger_postings p ON p.id = l.posting_id
        WHERE p.source_type = 'gam_charge' AND p.source_id = $1 AND p.role = 'post' AND p.superseded_at IS NULL
        ORDER BY l.account_role`, [unpicked])).rows
    expect(cl).toEqual([
      { role: 'bank_fees', property_id: null, dr: 6, cr: 0 },
      { role: 'due_to_gam', property_id: null, dr: 0, cr: 6 },
    ])
  })
})

describe('the proof strip: a move-out balance the tenant still owes is billed', () => {
  it('deductions beyond the deposit: the balance owed is billed, not "paid from deposits"', async () => {
    const co = await tenantCo()
    const dep = await bill(co, { type: 'deposit', amount: 500, due: '2026-09-01' })
    await receipt(co, { method: 'cash', settledAt: '2026-09-01T18:00:00Z', apps: [{ paymentId: dep, amount: 500 }] })
    const gapRow = await bill(co, { type: 'fee', entry: 'DEPOSIT', amount: 120, due: '2026-10-31' })
    await db.query(
      `INSERT INTO deposit_returns (lease_id, tenant_id, landlord_id, total_deposit, cleaning_fee_amount, damage_lines,
                                    other_deductions, total_deductions, refund_amount, gap_amount, unpaid_balance_amount, status,
                                    gap_payment_id, finalized_at)
       VALUES ($1, $2, $3, 500, 200, '[{"description":"Broken window","amount":420}]'::jsonb, '[]'::jsonb, 620, 0, 120, 0, 'sent_gap',
               $4, '2026-10-31T18:00:00Z')`, [co.leaseId, co.tenantId, co.landlordId, gapRow])
    expect(await drain()).toMatchObject({ failed: 0 })
    const q = { landlordIds: [co.landlordId], start: '2026-10-01', end: '2026-10-31' }
    const [b, r] = await Promise.all([ledgerIncomeEvents({ ...q, basis: 'billed' }), ledgerIncomeEvents({ ...q, basis: 'received' })])
    const v = moneyViewFrom(b, r, { ...q, label: 'October' })
    expect(v.proof).toMatchObject({ billed: 120, deposits: 0, owedAtEnd: 120, offBy: 0 })
  })
})

describe('the parity check starts at the books\' start date', () => {
  it('a month that ended before the start is skipped; the month the books start in is compared from the start', () => {
    expect(parityMonthsFrom('2026-10-13', null)).toEqual(parityMonths('2026-10-13'))
    expect(parityMonthsFrom('2026-10-13', '2026-09-15')).toEqual([
      { start: '2026-09-15', end: '2026-09-30' }, { start: '2026-10-01', end: '2026-10-13' },
    ])
    expect(parityMonthsFrom('2026-10-13', '2026-10-05')).toEqual([{ start: '2026-10-05', end: '2026-10-13' }])
  })
})

describe('the assistant\'s portfolio figures on the books', () => {
  it('no expenses of their own: says so, though GAM\'s fees sit in the books\' expense accounts', async () => {
    const co = await tenantCo()
    const rent = await bill(co, { amount: 1000, due: '2026-10-01' })
    await receipt(co, { method: 'cash', settledAt: '2026-10-02T17:00:00Z', apps: [{ paymentId: rent, amount: 1000 }] })
    await db.query(
      `INSERT INTO landlord_gam_charges (landlord_id, property_id, kind, amount, source_type, created_at)
       VALUES ($1, $2, 'subscription', 30, 'test', '2026-10-03T18:00:00Z')`, [co.landlordId, co.propertyId])
    expect(await drain()).toMatchObject({ failed: 0 })
    await markLedgerLive(co.landlordId)
    const out: any = await getPortfolioStats.execute({ topic: 'money' },
      { userId: co.ownerUserId, role: 'landlord', profileId: '', landlordIds: [co.landlordId] } as any)
    expect(out.money.expensesRecorded).toBe(0)
    expect(out.money.expensesPaidEveryAccount).toBe(30)
    expect(out.notRecorded).toContain('no expenses have been recorded, so there is no cost side to this')
    expect(out.money.netNote).toMatch(/NOT a profit figure/)
  })
})

describe('bank reconciliation, pure', () => {
  const acct = (accountId: string, code: string, name: string, bankConnectionId: string | null = null) =>
    ({ accountId, code, name, bankConnectionId, linked: !!bankConnectionId } as any)
  const all = [
    acct('a1', '1010', 'Checking'),
    acct('a2', '1010-1', 'Checking: PNC Bank ••9677', 'c2'),
    acct('a3', '1010-2', 'Checking: Wells Fargo ••8739', 'c3'),
  ]

  it('names a bank account the way people say it: its number, its name, its last four, or both', () => {
    expect(pickReconcileAccount(all, 'a2').accountId).toBe('a2')
    expect(pickReconcileAccount(all, 'c3').accountId).toBe('a3')
    expect(pickReconcileAccount(all, '1010').accountId).toBe('a1')
    expect(pickReconcileAccount(all, '1010-1').accountId).toBe('a2')
    expect(pickReconcileAccount(all, '9677').accountId).toBe('a2')
    expect(pickReconcileAccount(all, '••8739').accountId).toBe('a3')
    expect(pickReconcileAccount(all, 'PNC ••9677').accountId).toBe('a2')
    expect(pickReconcileAccount(all, 'wells fargo').accountId).toBe('a3')
    expect(() => pickReconcileAccount(all, 'checking ending in 1234')).toThrow(/not one of this company/)
    expect(pickReconcileAccount(all, 'Checking').accountId).toBe('a1')   // its exact name
    expect(() => pickReconcileAccount(all, 'check')).toThrow(/Which bank account\?/)
  })

  const row = (o: Partial<any>) => ({
    id: randomUUID(), posting_id: 'p', line_no: 1, day: '2026-10-01', booked_on: '2026-10-01', amount: '0', memo: null,
    source_type: 'expense_payment', source_id: 's', posting_kind: 'main', role: 'post', reverses_posting_id: null, superseded: false,
    item_id: null, item_source: null, bank_line_id: null, bank_day: null, bank_description: null,
    superseded_by: null, replaced_by: null, orig_frozen: false, ...o,
  })

  it('a re-post of a line cleared on a finished statement: its reversal and the line that replaced it clear together', () => {
    const back = row({ posting_id: 'r1', line_no: 2, amount: '40.00', role: 'reversal', reverses_posting_id: 'p1', replaced_by: 'p2', orig_frozen: true })
    const again = row({ posting_id: 'p2', line_no: 2, amount: '-40.00' })
    const lines = classifyStatementLines([back, again] as any, '2026-10-31')
    expect(lines.map(l => [l.clearing, l.automatic])).toEqual([['cancels_out', true], ['cancels_out', true]])
    // Re-posted twice: the first reversal finds the line that stands now.
    const twice = [
      row({ posting_id: 'r1', line_no: 2, amount: '40.00', role: 'reversal', reverses_posting_id: 'p1', replaced_by: 'p2', orig_frozen: true }),
      row({ posting_id: 'p2', line_no: 2, amount: '-40.00', superseded: true, superseded_by: 'p3' }),
      row({ posting_id: 'r2', line_no: 2, amount: '40.00', role: 'reversal', reverses_posting_id: 'p2', replaced_by: 'p3' }),
      row({ posting_id: 'p3', line_no: 2, amount: '-40.00' }),
    ]
    expect(classifyStatementLines(twice as any, '2026-10-31').every(l => l.clearing === 'cancels_out')).toBe(true)
  })

  it('an opening balance changed after a finished statement is not cleared by itself, and says to undo that statement', () => {
    const back = row({ source_type: 'opening', posting_id: 'r1', line_no: 1, amount: '-1000.00', role: 'reversal', reverses_posting_id: 'p1', replaced_by: 'p2', orig_frozen: true })
    const now = row({ source_type: 'opening', posting_id: 'p2', line_no: 1, amount: '1200.00' })
    const lines = classifyStatementLines([back, now] as any, '2026-10-31')
    expect(lines.map(l => [l.clearing, l.automatic])).toEqual([[null, false], [null, false]])
    expect(lines[1].description).toMatch(/undo that statement/)
    // An opening balance never cleared before still clears by itself.
    expect(classifyStatementLines([row({ source_type: 'opening', amount: '500.00' })] as any, '2026-10-31')[0])
      .toMatchObject({ clearing: 'opening', automatic: true })
  })
})

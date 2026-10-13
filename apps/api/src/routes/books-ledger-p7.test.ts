/**
 * 10/12 (Nic) — GAM Books ledger, phase P7: payroll and the bookkeeper's
 * journal entries post themselves (gam-ledger-design-2026-10-12 §6 J3, J4,
 * §11, §13; Nic's 10/12 answers L5, L7).
 *
 *   Nic 10/12: every money event posts its own balanced lines automatically;
 *   the bookkeeper adds adjusting entries on top.
 *
 * Real routes, real capture triggers, the production projectors and the real
 * engine, on committed rows (the engine posts on its own connections).
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db } from '../db'
import { booksRouter } from './books'
import { errorHandler } from '../middleware/errorHandler'
import { cleanupAllSchema, seedLease, seedUnit } from '../test/dbHelpers'
import { ledgerCompany, inTx, type LedgerCompany } from '../test/ledgerFixtures'
import { drainLedgerOutbox, registeredLedgerSourceTypes, unregisterLedgerProjector } from '../services/ledgerEngine'
import { registerProductionLedgerProjectors, unregisterProductionLedgerProjectors } from '../services/ledgerProjectors'
import { ensureChart } from '../services/booksLedgerChart'
import { payrollExpenseIntents } from '../services/payrollMoneyOut'
import { PAYROLL_EXPENSE_LIABILITY_ROLES } from '@gam/shared'

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_books_p7'

const app = express()
app.use(express.json())
app.use('/api/books', booksRouter)
app.use(errorHandler)

const pass = (co: LedgerCompany) => jwt.sign(
  { userId: co.ownerUserId, role: 'landlord', email: 'o@t.dev', profileId: null, landlordIds: [co.landlordId], permissions: {} },
  process.env.JWT_SECRET!, { expiresIn: '1h' })
const post = (co: LedgerCompany, url: string, body: object = {}) =>
  request(app).post(`/api/books${url}`).set('Authorization', `Bearer ${pass(co)}`).send(body)
const patch = (co: LedgerCompany, url: string, body: object = {}) =>
  request(app).patch(`/api/books${url}`).set('Authorization', `Bearer ${pass(co)}`).send(body)
const get = (co: LedgerCompany, url: string) =>
  request(app).get(`/api/books${url}`).set('Authorization', `Bearer ${pass(co)}`)

beforeEach(async () => {
  await cleanupAllSchema()
  registerProductionLedgerProjectors()
})
afterEach(() => {
  unregisterProductionLedgerProjectors()
  for (const t of registeredLedgerSourceTypes()) unregisterLedgerProjector(t)
})
afterAll(async () => { await cleanupAllSchema() })

/** Posts everything waiting (the routes' own after-commit kicks may hold a key for a moment). */
async function settle(): Promise<{ failed: number }> {
  let failed = 0
  for (let i = 0; i < 20; i++) {
    const s = await drainLedgerOutbox({ ignoreBackoff: true })
    failed += s.failed
    const waiting = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ledger_outbox WHERE source_type = ANY($1::text[])`, [registeredLedgerSourceTypes()])
    if (waiting.rows[0].n === 0 && s.keys === 0) break
    await new Promise(r => setTimeout(r, 50))
  }
  return { failed }
}

interface Line { kind: string; day: string; role: string | null; account: string; dr: number; cr: number; property: string | null; system: boolean }
async function activeLines(sourceType: string, sourceId: string): Promise<Line[]> {
  const r = await db.query<any>(
    `SELECT p.posting_kind AS kind, p.intended_date::text AS day, l.account_role AS role, l.account_id AS account,
            l.debit::text AS dr, l.credit::text AS cr, l.property_id AS property, l.system_line AS system
       FROM ledger_postings p JOIN ledger_posting_lines l ON l.posting_id = p.id
      WHERE p.source_type = $1 AND p.source_id = $2 AND p.role = 'post' AND p.superseded_at IS NULL
      ORDER BY l.line_no`, [sourceType, sourceId])
  return r.rows.map(x => ({ ...x, dr: Number(x.dr), cr: Number(x.cr) }))
}
async function roleBalance(landlordId: string, role: string): Promise<number> {
  const r = await db.query<{ n: string }>(
    `SELECT COALESCE(sum(debit - credit), 0)::text AS n FROM ledger_posting_lines WHERE landlord_id = $1 AND account_role = $2`,
    [landlordId, role])
  return Math.round(Number(r.rows[0].n) * 100) / 100
}
async function accountBalance(accountId: string): Promise<number> {
  const r = await db.query<{ n: string }>(
    `SELECT COALESCE(sum(debit - credit), 0)::text AS n FROM ledger_posting_lines WHERE account_id = $1`, [accountId])
  return Math.round(Number(r.rows[0].n) * 100) / 100
}
async function waitingReason(sourceType: string, sourceId: string): Promise<string | null> {
  const r = await db.query<{ reason_code: string }>(
    `SELECT reason_code FROM ledger_source_errors WHERE source_type = $1 AND source_id = $2`, [sourceType, sourceId])
  return r.rows[0]?.reason_code ?? null
}

async function costsMethod(co: LedgerCompany, m: 'company_bucket' | 'split_by_units'): Promise<void> {
  await db.query(`UPDATE landlords SET books_company_costs_method = $2 WHERE id = $1`, [co.landlordId, m])
}

async function employee(co: LedgerCompany, o: { first: string; payType?: 'salary' | 'hourly'; rate: number }): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO books_employees (landlord_id, first_name, last_name, pay_type, pay_rate, pay_frequency, filing_status,
                                  state_withholding_pct, status)
     VALUES ($1, $2, 'Worker', $3, $4, 'biweekly', 'single', 0, 'active') RETURNING id`,
    [co.landlordId, o.first, o.payType ?? 'salary', o.rate])
  return r.rows[0].id
}

/** A run calculated and approved through the routes; returns its id. */
async function approvedRun(co: LedgerCompany, body: object): Promise<string> {
  const calc = await post(co, '/payroll/runs', { periodStart: '2026-03-01', periodEnd: '2026-03-14', payDate: '2026-03-20', payFrequency: 'biweekly', ...body })
  expect(calc.status, JSON.stringify(calc.body)).toBe(201)
  const ok = await post(co, `/payroll/runs/${calc.body.data.id}/approve`)
  expect(ok.status, JSON.stringify(ok.body)).toBe(200)
  return calc.body.data.id
}

/** The company's chart seeded the way the ledger seeds it; the account a role points at. */
async function chart(co: LedgerCompany): Promise<(role: string) => Promise<string>> {
  await inTx(c => ensureChart(c, co.owner))
  return async (role: string) => {
    const r = await db.query<{ account_id: string }>(
      `SELECT account_id FROM books_account_map WHERE landlord_id = $1 AND map_kind = 'role' AND map_value = $2
        ORDER BY effective_from DESC, id DESC LIMIT 1`, [co.landlordId, role])
    if (!r.rows[0]) throw new Error(`no account for ${role}`)
    return r.rows[0].account_id
  }
}

// ─── J3: payroll posts on the pay date ──────────────────────────────────────

describe('a payroll run posts on its pay date (J3)', () => {
  it('wages and the employer\'s taxes as expenses; withholding, the employer\'s taxes and take-home pay as liabilities', async () => {
    const co = await ledgerCompany()
    await costsMethod(co, 'company_bucket')
    const a = await employee(co, { first: 'Ann', rate: 52000 })     // 2,000 every two weeks
    const b = await employee(co, { first: 'Bo', rate: 26000 })      // 1,000
    const runId = await approvedRun(co, {
      employeeIds: [a, b],
      taxMap: { [a]: { federal: 150, state: 40, futa: 12, suta: 30 }, [b]: { federal: 50, futa: 6 } },
    })
    expect(await settle()).toEqual({ failed: 0 })
    const ls = await activeLines('payroll_run', runId)
    const by = (role: string) => ls.filter(l => l.role === role).reduce((s, l) => s + l.dr - l.cr, 0)
    // SS 6.2% and Medicare 1.45% on 3,000, each side.
    expect(by('payroll_expense')).toBe(3000)
    expect(by('employer_payroll_taxes')).toBeCloseTo(186 + 43.5 + 18 + 30, 2)
    expect(by('payroll_federal_withholding')).toBe(-200)
    expect(by('payroll_state_withholding')).toBe(-40)
    expect(by('payroll_fica')).toBeCloseTo(-(186 + 43.5) * 2, 2)
    expect(by('payroll_futa')).toBe(-18)
    expect(by('payroll_suta')).toBe(-30)
    // Take-home: 3,000 − 200 − 40 − 186 − 43.50
    expect(by('net_pay_payable')).toBeCloseTo(-2530.5, 2)
    expect(new Set(ls.map(l => l.day))).toEqual(new Set(['2026-03-20']))
    expect(ls.every(l => l.property === null)).toBe(true)
    // The run's own totals carry the employer's taxes.
    const run = (await db.query<any>(`SELECT * FROM payroll_runs WHERE id = $1`, [runId])).rows[0]
    expect([+run.total_employer_ss, +run.total_employer_medicare, +run.total_futa, +run.total_suta]).toEqual([186, 43.5, 18, 30])
    // What it left to pay is on the Expenses record as unpaid bills (L5): each
    // bill moves its own liability to Accounts payable, so every payroll
    // liability nets to $0 and Accounts payable owes it all.
    for (const role of ['net_pay_payable', 'payroll_federal_withholding', 'payroll_state_withholding', 'payroll_fica', 'payroll_futa', 'payroll_suta']) {
      expect([role, await roleBalance(co.landlordId, role)]).toEqual([role, 0])
    }
    expect(await roleBalance(co.landlordId, 'accounts_payable')).toBeCloseTo(-(2530.5 + 200 + 40 + 459 + 18 + 30), 2)
  })

  // 10/13 (Nic): "Company-level costs before the owner picks: post to the
  // COMPANY column by default"; "a later 'split by units' splits only NEW costs".
  it('goes to the Company column until the owner picks (L7); a later split by units splits only runs approved after it', async () => {
    const co = await ledgerCompany()
    const a = await employee(co, { first: 'Ann', rate: 26000 })     // 1,000
    const runId = await approvedRun(co, { employeeIds: [a] })
    expect(await settle()).toEqual({ failed: 0 })
    expect(await waitingReason('payroll_run', runId)).toBeNull()
    const companyOnly = (ls: Line[]) => ls.filter(l => l.role === 'payroll_expense').map(l => [l.property, l.dr])
    expect(companyOnly(await activeLines('payroll_run', runId))).toEqual([[null, 1000]])
    // Three units on the first property, one on the second (the fixture's unit plus three).
    await inTx(async c => {
      for (const [p, n] of [[co.propertyId, 2], [co.propertyId2, 1]] as const) {
        for (let i = 0; i < n; i++) await seedUnit(c, { propertyId: p, landlordId: co.landlordId })
      }
      // Every unit was there on the pay dates.
      await c.query(`UPDATE units SET created_at = '2026-01-01' WHERE landlord_id = $1`, [co.landlordId])
    })
    // The owner picks "split by units" after the books posted (services/booksSettings stamps the moment).
    await db.query(`UPDATE landlords SET books_company_costs_method = 'split_by_units', books_company_costs_from = now() WHERE id = $1`,
      [co.landlordId])
    // What is already in the Company column stays there — re-posted, or rebuilt.
    await db.query(`INSERT INTO ledger_outbox (source_type, source_id, owner_id) VALUES ('payroll_run', $1, $2)`, [runId, co.landlordId])
    expect(await settle()).toEqual({ failed: 0 })
    expect(companyOnly(await activeLines('payroll_run', runId))).toEqual([[null, 1000]])
    // A run approved after the pick splits.
    const calc = await post(co, '/payroll/runs', { periodStart: '2026-03-15', periodEnd: '2026-03-28', payDate: '2026-04-03',
      payFrequency: 'biweekly', employeeIds: [a] })
    expect(calc.status, JSON.stringify(calc.body)).toBe(201)
    expect((await post(co, `/payroll/runs/${calc.body.data.id}/approve`)).status).toBe(200)
    const later = calc.body.data.id as string
    expect(await settle()).toEqual({ failed: 0 })
    const ls = await activeLines('payroll_run', later)
    const wages = ls.filter(l => l.role === 'payroll_expense')
    expect(wages.map(l => [l.property, l.dr]).sort()).toEqual([[co.propertyId, 750], [co.propertyId2, 250]].sort())
    // What is owed stays company level; the clearing lines balance each property.
    expect(ls.filter(l => l.role === 'net_pay_payable').every(l => l.property === null)).toBe(true)
    const clearing = ls.filter(l => l.role === 'interproperty_clearing')
    expect(clearing.length).toBeGreaterThan(0)
    expect(clearing.every(l => l.system)).toBe(true)
    for (const p of [co.propertyId, co.propertyId2, null]) {
      const net = ls.filter(l => l.property === p).reduce((s, l) => s + l.dr - l.cr, 0)
      expect(Math.round(net * 100)).toBe(0)
    }
  })

  it('voiding an approved run takes its posting back; a draft never posts', async () => {
    const co = await ledgerCompany()
    await costsMethod(co, 'company_bucket')
    const a = await employee(co, { first: 'Ann', rate: 26000 })
    const runId = await approvedRun(co, { employeeIds: [a] })
    await settle()
    expect((await activeLines('payroll_run', runId)).length).toBeGreaterThan(0)
    const v = await post(co, `/payroll/runs/${runId}/void`)
    expect(v.status, JSON.stringify(v.body)).toBe(200)
    expect(await settle()).toEqual({ failed: 0 })
    expect(await activeLines('payroll_run', runId)).toEqual([])
    expect(await roleBalance(co.landlordId, 'payroll_expense')).toBe(0)
    expect(await roleBalance(co.landlordId, 'net_pay_payable')).toBe(0)
    const draft = await post(co, '/payroll/runs', {
      periodStart: '2026-04-01', periodEnd: '2026-04-14', payDate: '2026-04-20', payFrequency: 'biweekly', employeeIds: [a],
    })
    expect(draft.status).toBe(201)
    await settle()
    expect(await activeLines('payroll_run', draft.body.data.id)).toEqual([])
  })

  it('a paycheck that does not add up is refused by name instead of posting crooked', async () => {
    const co = await ledgerCompany()
    await costsMethod(co, 'company_bucket')
    const a = await employee(co, { first: 'Ann', rate: 26000 })
    const runId = await approvedRun(co, { employeeIds: [a] })
    await db.query(`UPDATE payroll_run_lines SET net_pay = net_pay + 5 WHERE run_id = $1`, [runId])
    await settle()
    expect(await waitingReason('payroll_run', runId)).toBe('projector_error')
  })

  it('the unpaid expenses a run leaves add up to exactly what its posting owes, one per liability', async () => {
    const intents = payrollExpenseIntents({
      id: 'r', payDate: '2026-03-20',
      lines: [
        { id: 'l1', employeeName: 'Ann Worker', net: 1500.25, federal: 100, state: 20, ss: 124, medicare: 29, employerSs: 124, employerMedicare: 29, futa: 6, suta: 15, other: 0 },
        { id: 'l2', employeeName: 'Bo Worker', net: 800, federal: 0, state: 0, ss: 62, medicare: 14.5, employerSs: 62, employerMedicare: 14.5, futa: 0, suta: 0, other: 25 },
      ],
    })
    expect(intents.filter(i => i.kind === 'payroll_net').map(i => [i.payrollRunLineId, i.cents, i.dueDate])).toEqual([
      ['l1', 150025, '2026-03-20'], ['l2', 80000, '2026-03-20'],
    ])
    expect(intents.filter(i => i.kind === 'tax_payment').map(i => [i.liabilityRole, i.cents])).toEqual([
      ['payroll_federal_withholding', 10000], ['payroll_fica', 45900], ['payroll_futa', 600],
      ['payroll_state_withholding', 2000], ['payroll_suta', 1500], ['payroll_liabilities', 2500],
    ])
    expect(intents.every(i => (PAYROLL_EXPENSE_LIABILITY_ROLES as readonly string[]).includes(i.liabilityRole))).toBe(true)
  })

  it('the database\'s list of payroll liabilities a run\'s expense clears is the shared list', async () => {
    const r = await db.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'payroll_run_expenses_role_check'`)
    const listed = [...r.rows[0].def.matchAll(/'([a-z_]+)'::text/g)].map(m => m[1]).sort()
    expect(listed).toEqual([...PAYROLL_EXPENSE_LIABILITY_ROLES].sort())
  })
})

// ─── J4: a bookkeeper's journal entry ───────────────────────────────────────

describe('a journal entry mirrors into the ledger as entered (J4)', () => {
  it('each line on its property; the ledger adds inter-property clearing lines, never the entry', async () => {
    const co = await ledgerCompany()
    const role = await chart(co)
    const repairs = await role('repairs_maintenance')
    const checking = await role('bank_checking')
    const res = await post(co, '/journal', {
      date: '2026-02-10', description: 'Repair paid from the office account',
      lines: [
        { accountId: repairs, debit: 120, credit: 0, propertyId: co.propertyId },
        { accountId: checking, debit: 0, credit: 120 },
      ],
    })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(await settle()).toEqual({ failed: 0 })
    const ls = await activeLines('manual_journal', res.body.data.id)
    expect(ls.filter(l => !l.system).map(l => [l.account, l.property, l.dr, l.cr]).sort()).toEqual([
      [repairs, co.propertyId, 120, 0], [checking, null, 0, 120],
    ].sort())
    expect(ls.filter(l => l.system).map(l => [l.role, l.property, l.dr, l.cr]).sort()).toEqual([
      ['interproperty_clearing', co.propertyId, 0, 120], ['interproperty_clearing', null, 120, 0],
    ].sort())
    // The entry itself stays exactly as entered: two lines.
    const n = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM journal_entry_lines WHERE entry_id = $1`, [res.body.data.id])
    expect(n.rows[0].n).toBe(2)
    // A unit names its property; a lease names its unit.
    const leaseId = await inTx(c => seedLease(c, { unitId: co.unitId, landlordId: co.landlordId }))
    const leased = await post(co, '/journal', {
      date: '2026-02-11', description: 'Lease-level reclass',
      lines: [
        { accountId: repairs, debit: 10, credit: 0, leaseId },
        { accountId: repairs, debit: 0, credit: 10, unitId: co.unitId },
      ],
    })
    expect(leased.status, JSON.stringify(leased.body)).toBe(201)
    expect(leased.body.data.lines.map((l: any) => [l.property_id, l.unit_id])).toEqual([
      [co.propertyId, co.unitId], [co.propertyId, co.unitId],
    ])
  })

  it('an entry dated before the books start opens in the opening posting: its balance-sheet side as entered, the rest in opening equity (J1)', async () => {
    const co = await ledgerCompany()   // books start 2026-01-01
    const role = await chart(co)
    const suspense = await role('suspense')
    const repairs = await role('repairs_maintenance')
    const res = await post(co, '/journal', {
      date: '2025-12-15', description: 'December repair still to classify',
      lines: [{ accountId: suspense, debit: 50, credit: 0 }, { accountId: repairs, debit: 0, credit: 50 }],
    })
    expect(res.status).toBe(201)
    expect(await settle()).toEqual({ failed: 0 })
    expect(await activeLines('manual_journal', res.body.data.id)).toEqual([])
    const opening = await activeLines('opening', co.landlordId)
    expect(opening.filter(l => l.account === suspense).map(l => [l.day, l.dr, l.cr])).toEqual([['2026-01-01', 50, 0]])
    expect(opening.filter(l => l.account === repairs)).toEqual([])
    expect(await roleBalance(co.landlordId, 'opening_balance_equity')).toBe(-50)
  })

  it('refuses a property, unit or lease that is not the company\'s, and a lease on another unit', async () => {
    const co = await ledgerCompany()
    const other = await ledgerCompany()
    const role = await chart(co)
    const repairs = await role('repairs_maintenance')
    const checking = await role('bank_checking')
    const lines = (extra: object) => [{ accountId: repairs, debit: 5, credit: 0, ...extra }, { accountId: checking, debit: 0, credit: 5 }]
    const p = await post(co, '/journal', { date: '2026-02-10', description: 'x', lines: lines({ propertyId: other.propertyId }) })
    expect([p.status, p.body.error]).toEqual([404, 'That property is not one of this company\'s.'])
    const u = await post(co, '/journal', { date: '2026-02-10', description: 'x', lines: lines({ unitId: other.unitId }) })
    expect(u.status).toBe(404)
    const mismatch = await post(co, '/journal', { date: '2026-02-10', description: 'x', lines: lines({ unitId: co.unitId, propertyId: co.propertyId2 }) })
    expect([mismatch.status, mismatch.body.error]).toEqual([400, 'That unit is on a different property than the line names.'])
    expect((await db.query(`SELECT 1 FROM journal_entries WHERE landlord_id = $1`, [co.landlordId])).rowCount).toBe(0)
  })

  it('refuses a line on an account GAM keeps from the money records, in words', async () => {
    const co = await ledgerCompany()
    const role = await chart(co)
    const ar = await role('ar_tenants')
    const repairs = await role('repairs_maintenance')
    const res = await post(co, '/journal', {
      date: '2026-02-10', description: 'Write a tenant off by hand',
      lines: [{ accountId: repairs, debit: 50, credit: 0 }, { accountId: ar, debit: 0, credit: 50 }],
    })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/is kept by GAM from the money records, so it takes no journal lines/)
    // The database refuses it too, even past the route.
    await expect(inTx(async c => {
      const e = await c.query<{ id: string }>(
        `INSERT INTO journal_entries (landlord_id, date, description, type) VALUES ($1, '2026-02-10', 'x', 'manual') RETURNING id`, [co.landlordId])
      await c.query(`INSERT INTO journal_entry_lines (entry_id, account_id, debit, credit) VALUES ($1, $2, 50, 0)`, [e.rows[0].id, ar])
    })).rejects.toThrow(/takes no journal lines/)
  })

  it('refuses an entry dated in a closed month; the fix is an entry after the close', async () => {
    const co = await ledgerCompany()
    const role = await chart(co)
    const repairs = await role('repairs_maintenance')
    const checking = await role('bank_checking')
    await db.query(`INSERT INTO books_period_closes (landlord_id, action, closed_through, acted_by) VALUES ($1, 'close', '2026-01-31', $2)`,
      [co.landlordId, co.ownerUserId])
    const lines = [{ accountId: repairs, debit: 5, credit: 0 }, { accountId: checking, debit: 0, credit: 5 }]
    const closed = await post(co, '/journal', { date: '2026-01-15', description: 'late January accrual', lines })
    expect(closed.status).toBe(409)
    expect(closed.body.error).toMatch(/The books are closed through 2026-01-31/)
    const open = await post(co, '/journal', { date: '2026-02-01', description: 'January accrual, booked in February', lines })
    expect(open.status).toBe(201)
  })

  it('an adjusting entry names an automatic record the company\'s ledger posted; anything else is refused', async () => {
    const co = await ledgerCompany()
    await costsMethod(co, 'company_bucket')
    const a = await employee(co, { first: 'Ann', rate: 26000 })
    const runId = await approvedRun(co, { employeeIds: [a] })
    await settle()
    const role = await chart(co)
    const wages = await role('payroll_expense')
    const checking = await role('bank_checking')
    const lines = [{ accountId: wages, debit: 25, credit: 0 }, { accountId: checking, debit: 0, credit: 25 }]
    const base = { date: '2026-03-31', description: 'Bonus accrual', type: 'adjusting', lines }
    const ok = await post(co, '/journal', { ...base, adjustsLineKey: `payroll_run:${runId}` })
    expect(ok.status, JSON.stringify(ok.body)).toBe(201)
    expect(ok.body.data.adjusts_line_key).toBe(`payroll_run:${runId}`)
    const detail = await get(co, `/journal/${ok.body.data.id}`)
    expect(detail.body.data.adjusts_record_label).toBe('A payroll run')
    const missing = await post(co, '/journal', { ...base, adjustsLineKey: 'payroll_run:00000000-0000-0000-0000-000000000000' })
    expect([missing.status, missing.body.error]).toEqual([404, 'That automatic record is not on this company\'s books.'])
    const bad = await post(co, '/journal', { ...base, adjustsLineKey: 'manual_journal:x' })
    expect(bad.status).toBe(400)
    const notAdjusting = await post(co, '/journal', { ...base, type: 'manual', adjustsLineKey: `payroll_run:${runId}` })
    expect(notAdjusting.status).toBe(400)
    const typedReversal = await post(co, '/journal', { ...base, type: 'reversing', adjustsLineKey: undefined })
    expect([typedReversal.status, typedReversal.body.error]).toEqual([400, 'Use Reverse on the entry this one takes back.'])
  })

  it('Reverse takes an entry back on a later day; voiding follows the reversal, and the ledger follows both', async () => {
    const co = await ledgerCompany()
    const role = await chart(co)
    const repairs = await role('repairs_maintenance')
    const payable = await role('suspense')
    const made = await post(co, '/journal', {
      date: '2026-03-31', description: 'Accrue the March plumber',
      lines: [{ accountId: repairs, debit: 300, credit: 0, propertyId: co.propertyId }, { accountId: payable, debit: 0, credit: 300 }],
    })
    expect(made.status).toBe(201)
    const early = await post(co, `/journal/${made.body.data.id}/reverse`, { date: '2026-03-30' })
    expect(early.status).toBe(400)
    const rev = await post(co, `/journal/${made.body.data.id}/reverse`, { date: '2026-04-01' })
    expect(rev.status, JSON.stringify(rev.body)).toBe(201)
    expect(rev.body.data.type).toBe('reversing')
    expect(rev.body.data.reverses_entry_id).toBe(made.body.data.id)
    expect(rev.body.data.lines.map((l: any) => [l.account_id, l.property_id, +l.debit, +l.credit]).sort()).toEqual([
      [repairs, co.propertyId, 0, 300], [payable, null, 300, 0],
    ].sort())
    expect(await settle()).toEqual({ failed: 0 })
    expect(await accountBalance(repairs)).toBe(0)
    expect((await activeLines('manual_journal', rev.body.data.id)).find(l => l.account === repairs)?.day).toBe('2026-04-01')
    // Once reversed, not twice; and the original cannot be voided under its reversal.
    const again = await post(co, `/journal/${made.body.data.id}/reverse`, { date: '2026-04-02' })
    expect(again.status).toBe(409)
    const voidOrig = await post(co, `/journal/${made.body.data.id}/void`)
    expect(voidOrig.status).toBe(409)
    expect(voidOrig.body.error).toMatch(/reverses this one\. Void that reversing entry first/)
    // A reversal is undone by voiding it, never reversed.
    expect((await post(co, `/journal/${rev.body.data.id}/reverse`, { date: '2026-04-03' })).status).toBe(409)
    expect((await post(co, `/journal/${rev.body.data.id}/void`)).status).toBe(200)
    expect((await post(co, `/journal/${made.body.data.id}/void`)).status).toBe(200)
    expect(await settle()).toEqual({ failed: 0 })
    expect(await activeLines('manual_journal', made.body.data.id)).toEqual([])
    expect(await activeLines('manual_journal', rev.body.data.id)).toEqual([])
    const voided = (await db.query<any>(`SELECT status, voided_at, voided_by FROM journal_entries WHERE id = $1`, [made.body.data.id])).rows[0]
    expect([voided.status, !!voided.voided_at, voided.voided_by]).toEqual(['voided', true, co.ownerUserId])
    // The list says who reverses whom.
    const list = await get(co, '/journal')
    expect(list.status).toBe(200)
    expect(list.body.data.find((e: any) => e.id === rev.body.data.id)?.reverses_entry_number).toBe(made.body.data.entry_number)
  })
})

// ─── The chart's guards read the ledger ─────────────────────────────────────

describe('an account the books hold anything on keeps its type and is turned off only for a replacement', () => {
  it('type and deactivation read the ledger; with a replacement the account retires and its open months follow', async () => {
    const co = await ledgerCompany()
    const role = await chart(co)
    const checking = await role('bank_checking')
    const made = await post(co, '/accounts', { code: '5901', name: 'Odd jobs', type: 'expense' })
    expect(made.status).toBe(201)
    const odd = made.body.data.id
    const other = (await post(co, '/accounts', { code: '5902', name: 'Odd jobs (new)', type: 'expense' })).body.data.id
    const entry = await post(co, '/journal', {
      date: '2026-02-10', description: 'Odd job',
      lines: [{ accountId: odd, debit: 40, credit: 0 }, { accountId: checking, debit: 0, credit: 40 }],
    })
    expect(entry.status).toBe(201)
    await settle()
    expect(await accountBalance(odd)).toBe(40)
    const typed = await patch(co, `/accounts/${odd}`, { type: 'asset' })
    expect([typed.status, typed.body.error]).toEqual([409, 'Odd jobs already has journal entries, so its type cannot change. Make a new account of the right type and move the balance with a journal entry.'])
    const mapped = await patch(co, `/accounts/${checking}`, { type: 'expense' })
    expect(mapped.status).toBe(409)
    expect(mapped.body.error).toMatch(/is where automatic postings go, so its type cannot change/)
    const off = await patch(co, `/accounts/${odd}`, { active: false })
    expect(off.status).toBe(409)
    expect(off.body.error).toMatch(/still has a balance of \$40\.00/)
    const listed = await get(co, '/accounts')
    expect(listed.body.data.find((a: any) => a.id === odd)?.in_use).toBe(true)
    expect(listed.body.data.find((a: any) => a.id === other)?.in_use).toBe(false)
    // Turned off in favor of the account that takes its place: its open months move there.
    const retired = await patch(co, `/accounts/${odd}`, { active: false, replacementAccountId: other })
    expect(retired.status, JSON.stringify(retired.body)).toBe(200)
    expect([retired.body.data.active, retired.body.data.replaced_by_account_id]).toEqual([false, other])
    expect(await settle()).toEqual({ failed: 0 })
    expect(await accountBalance(odd)).toBe(0)
    expect(await accountBalance(other)).toBe(40)
    // Nothing on it: turned off plainly.
    const spare = (await post(co, '/accounts', { code: '5903', name: 'Spare', type: 'expense' })).body.data.id
    expect((await patch(co, `/accounts/${spare}`, { active: false })).status).toBe(200)
  })
})

/**
 * 10/11 (Nic) — GAM Books ledger repairs. One test (or more) per defect the
 * QuickBooks comparison found and verified in the ledger:
 *
 *   1. P&L summed voided and out-of-range journal lines
 *   2. balance sheet: liabilities/equity negative, raw-sign "balanced", no earnings
 *   3. an account deactivated with money in it; no way to list or turn one back on
 *   4. account type unvalidated; duplicate codes possible
 *   5. Add Employee / Contractor / Vendor forms could not save
 *   6. employee "YTD" was lifetime; SS wage base hardcoded at 2024's
 *   7. hourly default hours by pay frequency (one shared rule)
 *   8. bills: amount > 0, pay locked + in one transaction, a row per payment
 *   9. PATCH /transactions wiped unsent fields; DELETE hard-deleted
 *  10. journal: negative amounts, cent imbalance, unchecked type, double void,
 *      one entry-number sequence for every company
 *  11. bank reconciliation: one account, its own balance, no 100-row cap
 *  12. cash flow: GAM expenses, maintenance and bank-filed other income
 *
 * (The rent roll for bookkeepers is pinned in books-reports.test.ts.)
 */

import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit } from '../test/dbHelpers'
import { todayIn } from '../lib/timezone'
import { booksDefaultHours, socialSecurityWageBase } from '@gam/shared'

import { booksRouter } from './books'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/books', booksRouter)
  app.use(errorHandler)
  return app
}

const TODAY = todayIn(null)
const YEAR = Number(TODAY.slice(0, 4))

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_books_ledger_1011'
})

interface Fixture {
  aId: string; bId: string; aUid: string
  propertyAId: string; unitAId: string
  cash: string; savings: string; income: string; expense: string
  liability: string; equity: string
  bCash: string
  vendorA: string
  A: string; B: string
  // 10/12 (Nic, ledger P6, L5): GAM Books' own Bills and Transactions serve a
  // business's books only (a landlord company's moved onto Expenses), so
  // sections 8 and 9 run as a business owner.
  bizId: string; bizUid: string; Z: string; bizCash: string; bizVendor: string
}

async function seed(): Promise<Fixture> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId: aUid, landlordId: aId } = await seedLandlord(c)
    const { userId: bUid, landlordId: bId } = await seedLandlord(c)
    const propertyAId = await seedProperty(c, { landlordId: aId, ownerUserId: aUid, managedByUserId: aUid })
    const unitAId = await seedUnit(c, { propertyId: propertyAId, landlordId: aId, rentAmount: 1000 })
    const acct = async (owner: string, code: string, name: string, type: string, subtype: string | null = null) =>
      (await c.query<{ id: string }>(
        `INSERT INTO books_accounts (landlord_id, code, name, type, subtype) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [owner, code, name, type, subtype])).rows[0].id
    const cash = await acct(aId, '1010', 'Checking', 'asset', 'bank')
    const savings = await acct(aId, '1020', 'Savings', 'asset', 'bank')
    const liability = await acct(aId, '2010', 'Accounts Payable', 'liability')
    const equity = await acct(aId, '3010', 'Owner Equity', 'equity')
    const income = await acct(aId, '4010', 'Rental Income', 'income')
    const expense = await acct(aId, '5040', 'Repairs', 'expense')
    const bCash = await acct(bId, '1010', 'B Checking', 'asset', 'bank')
    const vendorA = (await c.query<{ id: string }>(
      `INSERT INTO books_vendors (landlord_id, name) VALUES ($1, 'Acme') RETURNING id`, [aId])).rows[0].id
    const bizEmail = `biz-${randomUUID()}@test.dev`
    const bizUid = (await c.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'business_owner', 'Biz', 'Owner', TRUE) RETURNING id`, [bizEmail])).rows[0].id
    const bizId = (await c.query<{ id: string }>(
      `INSERT INTO businesses (owner_user_id, name, business_type, email) VALUES ($1, 'Acme Hauling', 'trash_hauling', $2) RETURNING id`,
      [bizUid, bizEmail])).rows[0].id
    const bizCash = (await c.query<{ id: string }>(
      `INSERT INTO books_accounts (business_id, code, name, type, subtype) VALUES ($1, '1010', 'Checking', 'asset', 'bank') RETURNING id`,
      [bizId])).rows[0].id
    const bizVendor = (await c.query<{ id: string }>(
      `INSERT INTO books_vendors (business_id, name) VALUES ($1, 'Acme') RETURNING id`, [bizId])).rows[0].id
    await c.query('COMMIT')
    const sign = (p: object) => jwt.sign(p, process.env.JWT_SECRET!, { expiresIn: '1h' })
    return {
      aId, bId, aUid, propertyAId, unitAId, cash, savings, income, expense, liability, equity, bCash, vendorA,
      A: sign({ userId: aUid, role: 'landlord', email: 'la@t.dev', profileId: null, landlordIds: [aId], permissions: {} }),
      B: sign({ userId: bUid, role: 'landlord', email: 'lb@t.dev', profileId: null, landlordIds: [bId], permissions: {} }),
      bizId, bizUid, bizCash, bizVendor,
      Z: sign({ userId: bizUid, role: 'business_owner', email: bizEmail, profileId: bizId, businessId: bizId, permissions: {} }),
    }
  } catch (e) { await c.query('ROLLBACK'); throw e }
  finally { c.release() }
}

const app = () => request(buildApp())
const post = (token: string, url: string, body: any = {}) => app().post(`/api/books${url}`).set('Authorization', `Bearer ${token}`).send(body)
const patch = (token: string, url: string, body: any = {}) => app().patch(`/api/books${url}`).set('Authorization', `Bearer ${token}`).send(body)
const get = (token: string, url: string) => app().get(`/api/books${url}`).set('Authorization', `Bearer ${token}`)
const del = (token: string, url: string) => app().delete(`/api/books${url}`).set('Authorization', `Bearer ${token}`)

/** Post a two-line entry: `amount` debited to `dr`, credited to `cr`. */
async function entry(f: Fixture, date: string, dr: string, cr: string, amount: number) {
  const r = await post(f.A, '/journal', {
    date, description: `entry ${date}`,
    lines: [{ accountId: dr, debit: amount, credit: 0 }, { accountId: cr, debit: 0, credit: amount }],
  })
  expect(r.status).toBe(201)
  return r.body.data
}

// ─── 1. P&L ──────────────────────────────────────────────────────────────────

describe('1. Books P&L counts only posted entries in the range', () => {
  it('a voided entry and an entry outside the dates are left out', async () => {
    const f = await seed()
    await entry(f, `${YEAR}-03-10`, f.cash, f.income, 1000)          // in range, posted
    const voided = await entry(f, `${YEAR}-03-11`, f.cash, f.income, 500)
    expect((await post(f.A, `/journal/${voided.id}/void`)).status).toBe(200)
    await entry(f, `${YEAR - 1}-12-31`, f.cash, f.income, 250)        // before the range
    await entry(f, `${YEAR}-03-12`, f.expense, f.cash, 300)
    const res = await get(f.A, `/reports/pl?startDate=${YEAR}-01-01&endDate=${YEAR}-12-31`)
    expect(res.status).toBe(200)
    expect(res.body.data.totalIncome).toBe(1000)
    expect(res.body.data.totalExpenses).toBe(300)
    expect(res.body.data.netIncome).toBe(700)
  })
})

// ─── 2. Balance sheet ────────────────────────────────────────────────────────

describe('2. Balance sheet in normal signs, with earnings in equity', () => {
  it('balances on real entries: liabilities and equity positive, this year and earlier years’ earnings in equity', async () => {
    const f = await seed()
    await entry(f, `${YEAR - 1}-06-01`, f.cash, f.equity, 1000)     // owner puts in 1,000
    await entry(f, `${YEAR - 1}-07-01`, f.cash, f.income, 100)      // last year's income
    await entry(f, `${YEAR}-01-15`, f.cash, f.income, 500)          // this year's income
    await entry(f, `${YEAR}-01-16`, f.expense, f.cash, 200)         // this year's repair
    await entry(f, `${YEAR}-01-17`, f.cash, f.liability, 300)       // borrowed / owed
    const res = await get(f.A, '/reports/balance-sheet')
    expect(res.status).toBe(200)
    const d = res.body.data
    expect(d.totalAssets).toBe(1700)                    // 1000 + 100 + 500 - 200 + 300
    expect(d.totalLiabilities).toBe(300)                // positive, not -300
    expect(d.liabilities[0].balance).toBe(300)
    expect(d.equity.find((a: any) => a.code === '3010').balance).toBe(1000)
    expect(d.earnings).toEqual({ thisYear: 300, earlierYears: 100 })
    expect(d.totalEquity).toBe(1400)                    // 1000 + 300 + 100
    expect(d.balances).toBe(true)
  })

  it('an accrual dated later this year (or next January) is this year’s earnings, not earlier years’', async () => {
    const f = await seed()
    await entry(f, `${YEAR - 1}-07-01`, f.cash, f.income, 100)      // last year's income
    await entry(f, `${YEAR}-12-31`, f.cash, f.income, 40)           // dated ahead of today
    await entry(f, `${YEAR + 1}-01-02`, f.cash, f.income, 7)        // dated next year
    const d = (await get(f.A, '/reports/balance-sheet')).body.data
    expect(d.earnings).toEqual({ thisYear: 47, earlierYears: 100 })
    expect(d.balances).toBe(true)
  })

  it('the chart of accounts carries each balance in its normal sign too', async () => {
    const f = await seed()
    await entry(f, `${YEAR}-02-01`, f.cash, f.income, 250)
    const res = await get(f.A, '/accounts')
    const byCode = Object.fromEntries(res.body.data.map((a: any) => [a.code, a]))
    expect(Number(byCode['4010'].balance)).toBe(-250)   // stored: debits minus credits
    expect(byCode['4010'].normal_balance).toBe(250)
    expect(byCode['1010'].normal_balance).toBe(250)
  })
})

// ─── 3. Deactivate / reactivate ──────────────────────────────────────────────

describe('3. An account is turned off only at a zero balance, and can be turned back on', () => {
  it('refuses with a plain sentence while money is in it (DELETE and PATCH alike)', async () => {
    const f = await seed()
    await entry(f, `${YEAR}-02-01`, f.cash, f.income, 125)
    const d = await del(f.A, `/accounts/${f.cash}`)
    expect(d.status).toBe(409)
    expect(d.body.error).toMatch(/Checking still has a balance of \$125\.00/)
    const p = await patch(f.A, `/accounts/${f.income}`, { active: false })
    expect(p.status).toBe(409)
    expect(p.body.error).toMatch(/Rental Income still has a balance of \$125\.00/)
    const row = await db.query(`SELECT active FROM books_accounts WHERE id=$1`, [f.cash])
    expect(row.rows[0].active).toBe(true)
    // A refused turn-off changes nothing else sent with it.
    expect((await patch(f.A, `/accounts/${f.cash}`, { name: 'Renamed', active: false })).status).toBe(409)
    const kept = await db.query(`SELECT name, active FROM books_accounts WHERE id=$1`, [f.cash])
    expect(kept.rows[0]).toEqual({ name: 'Checking', active: true })
  })

  it('a zero-balance account turns off, is listed with includeInactive, refuses new entries, and turns back on', async () => {
    const f = await seed()
    expect((await del(f.A, `/accounts/${f.savings}`)).status).toBe(200)
    const active = await get(f.A, '/accounts')
    expect(active.body.data.map((a: any) => a.code)).not.toContain('1020')
    const all = await get(f.A, '/accounts?includeInactive=true')
    const savings = all.body.data.find((a: any) => a.code === '1020')
    expect(savings.active).toBe(false)
    const refused = await post(f.A, '/journal', {
      date: `${YEAR}-02-02`, description: 'into an inactive account',
      lines: [{ accountId: f.savings, debit: 10, credit: 0 }, { accountId: f.income, debit: 0, credit: 10 }],
    })
    expect(refused.status).toBe(409)
    expect(refused.body.error).toMatch(/Savings is inactive/)
    const back = await patch(f.A, `/accounts/${f.savings}`, { active: true })
    expect(back.status).toBe(200)
    expect(back.body.data.active).toBe(true)
  })

  it('another company’s account, or none at all, is 404 (it used to answer success)', async () => {
    const f = await seed()
    expect((await del(f.A, `/accounts/${f.bCash}`)).status).toBe(404)
    expect((await del(f.A, `/accounts/${randomUUID()}`)).status).toBe(404)
  })
})

// ─── 4. Account type and code ────────────────────────────────────────────────

describe('4. Account type is one of five; codes are unique per company', () => {
  it('POST refuses a type off the list in plain words', async () => {
    const f = await seed()
    const res = await post(f.A, '/accounts', { code: '4999', name: 'Revenue', type: 'revenue' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('Choose the account type: asset, liability, equity, income or expense.')
  })

  it('the database refuses a type off the list too (books_accounts_type_check)', async () => {
    const f = await seed()
    await expect(db.query(
      `INSERT INTO books_accounts (landlord_id, code, name, type) VALUES ($1, '9999', 'X', 'Income')`, [f.aId]))
      .rejects.toThrow(/books_accounts_type_check/)
  })

  it('PATCH checks the type, and refuses a type change once the account has entries', async () => {
    const f = await seed()
    expect((await patch(f.A, `/accounts/${f.savings}`, { type: 'cash' })).status).toBe(400)
    expect((await patch(f.A, `/accounts/${f.savings}`, { type: 'expense' })).body.data.type).toBe('expense')
    await entry(f, `${YEAR}-02-01`, f.cash, f.income, 10)
    const res = await patch(f.A, `/accounts/${f.income}`, { type: 'liability' })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/already has journal entries/)
  })

  it('PATCH changes only what was sent', async () => {
    const f = await seed()
    await db.query(`UPDATE books_accounts SET description='kept' WHERE id=$1`, [f.cash])
    const res = await patch(f.A, `/accounts/${f.cash}`, { name: 'Operating Checking' })
    expect(res.body.data.name).toBe('Operating Checking')
    expect(res.body.data.subtype).toBe('bank')
    expect(res.body.data.description).toBe('kept')
  })

  it('two saves of the same code at once leave one account (unique index), the other told it exists', async () => {
    const f = await seed()
    const [r1, r2] = await Promise.all([
      post(f.A, '/accounts', { code: '6000', name: 'One', type: 'expense' }),
      post(f.A, '/accounts', { code: '6000', name: 'Two', type: 'expense' }),
    ])
    expect([r1.status, r2.status].sort()).toEqual([201, 409])
    const rows = await db.query(`SELECT 1 FROM books_accounts WHERE landlord_id=$1 AND code='6000'`, [f.aId])
    expect(rows.rows).toHaveLength(1)
  })

  it('another company may use the same code', async () => {
    const f = await seed()
    expect((await post(f.B, '/accounts', { code: '4010', name: 'B Rent', type: 'income' })).status).toBe(201)
  })
})

// ─── 5. Add Employee / Contractor / Vendor ───────────────────────────────────

describe('5. The Add forms save', () => {
  it('Add Employee: the form’s body (with its address box) saves; married_higher is not offered or taken', async () => {
    const f = await seed()
    const form = {
      firstName: 'Ana', lastName: 'Diaz', email: 'ana@diaz.test', phone: '5555550100',
      address: '12 Palm Way, Mesa AZ 85201', title: 'Groundskeeper', department: 'Grounds',
      payType: 'hourly', payRate: 18, payFrequency: 'weekly', filingStatus: 'head_of_household',
      federalAllowances: 0, stateWithholdingPct: 2.5, startDate: `${YEAR}-01-05`, ssnLast4: '4321',
    }
    const ok = await post(f.A, '/employees', form)
    expect(ok.status).toBe(201)
    expect(ok.body.data.address).toBe('12 Palm Way, Mesa AZ 85201')
    expect((await post(f.A, '/employees', { ...form, filingStatus: 'married_higher' })).status).toBe(400)
  })

  // 10/12 (Nic): a contractor is a vendor of type contractor (one list); the
  // W-9 box is one of the shared list, the taxpayer ID optional.
  it('Add Vendor as a contractor: every W-9 classification saves; an individual sends a blank taxpayer ID box', async () => {
    const f = await seed()
    const base = {
      vendorType: 'contractor', is1099: true, name: 'Lee Electric', contactName: 'Sam Lee', email: 'sam@lee.test',
      phone: '5555550111', address: '9 Oak St, Tempe AZ', trade: 'Electrician', payRate: 85, payUnit: 'hour', w9OnFile: true,
    }
    const indiv = await post(f.A, '/vendors', { ...base, taxClassification: 'individual', taxId: '' })
    expect(indiv.status).toBe(201)
    expect(indiv.body.data.has_tax_id).toBe(false)
    for (const t of ['c_corp', 's_corp', 'partnership', 'llc', 'other']) {
      const r = await post(f.A, '/vendors', { ...base, taxClassification: t, taxId: '12-3456789' })
      expect(r.status).toBe(201)
      expect(r.body.data.tax_classification).toBe(t)
    }
    const old = await post(f.A, '/vendors', { ...base, taxClassification: 'business', taxId: '12-3456789' })
    expect(old.status).toBe(400)
    expect(old.body.error).toMatch(/W-9/)
  })

  it('Add Vendor: blank account # and tax ID boxes, an address, and Cash on delivery save; prepaid is refused', async () => {
    const f = await seed()
    const form = {
      vendorType: 'utility', name: 'City Water', contactName: 'Billing Desk', email: 'billing@city.test', phone: '5555550122',
      address: '1 City Hall Plaza', category: 'Utilities', paymentTerms: 'cod',
      accountNumber: '', taxId: '', notes: '',
    }
    const ok = await post(f.A, '/vendors', form)
    expect(ok.status).toBe(201)
    expect(ok.body.data.account_number).toBeNull()
    expect(ok.body.data.has_tax_id).toBe(false)
    expect(ok.body.data.payment_terms).toBe('cod')
    expect((await post(f.A, '/vendors', { ...form, paymentTerms: 'prepaid' })).status).toBe(400)
    expect((await post(f.A, '/vendors', { ...form, taxId: '12-34' })).status).toBe(400)
    expect((await patch(f.A, `/vendors/${ok.body.data.id}`, { paymentTerms: 'prepaid' })).status).toBe(400)
  })
})

// ─── 6. Employee year-to-date ────────────────────────────────────────────────

async function employee(aId: string, payType = 'salary', payRate = 52000): Promise<string> {
  return (await db.query<{ id: string }>(
    `INSERT INTO books_employees (landlord_id, first_name, last_name, pay_type, pay_rate, pay_frequency)
     VALUES ($1, 'Pat', 'Kim', $2, $3, 'biweekly') RETURNING id`, [aId, payType, payRate])).rows[0].id
}
/** An approved run on `payDate` paying the employee `gross` (SS/Medicare as stored). */
async function approvedRun(aId: string, empId: string, payDate: string, gross: number, ss = 0) {
  const run = await db.query<{ id: string }>(
    `INSERT INTO payroll_runs (landlord_id, period_start, period_end, pay_date, pay_frequency, status, total_gross, total_ss, total_net)
     VALUES ($1, $2, $2, $2, 'biweekly', 'approved', $3, $4, $3) RETURNING id`, [aId, payDate, gross, ss])
  await db.query(
    `INSERT INTO payroll_run_lines (run_id, employee_id, pay_type, gross_pay, ss_tax, net_pay)
     VALUES ($1, $2, 'salary', $3, $4, $3)`, [run.rows[0].id, empId, gross, ss])
}

describe('6. Year-to-date is one calendar year', () => {
  it('GET /employees shows this year’s pay only (last year’s approved runs are not in it)', async () => {
    const f = await seed()
    const emp = await employee(f.aId)
    await approvedRun(f.aId, emp, `${YEAR - 1}-12-20`, 5000)
    await approvedRun(f.aId, emp, `${YEAR}-01-10`, 2000)
    // The lifetime counter the old screens read says 7,000.
    await db.query(`UPDATE books_employees SET ytd_gross = 7000 WHERE id=$1`, [emp])
    const res = await get(f.A, '/employees')
    expect(res.body.data[0].ytd_gross).toBe(2000)
    expect(res.body.data[0].ytd_year).toBe(YEAR)
  })

  it('Social Security is withheld again in a new year after last year reached the wage base', async () => {
    const f = await seed()
    const emp = await employee(f.aId, 'salary', 52000)   // 2,000 a run
    await approvedRun(f.aId, emp, `${YEAR - 1}-12-20`, 400000)
    await db.query(`UPDATE books_employees SET ytd_gross = 400000 WHERE id=$1`, [emp])
    const res = await post(f.A, '/payroll/runs', {
      periodStart: `${YEAR}-01-01`, periodEnd: `${YEAR}-01-14`, payDate: `${YEAR}-01-20`,
      payFrequency: 'biweekly', employeeIds: [emp],
    })
    expect(res.status).toBe(201)
    expect(Number(res.body.data.lines[0].ss_tax)).toBe(124)   // 6.2% of 2,000
  })

  it('the wage base is the pay year’s (2026: $184,500, not 2024’s $168,600)', async () => {
    const f = await seed()
    const emp = await employee(f.aId, 'salary', 52000)
    await approvedRun(f.aId, emp, '2026-03-01', 184000)
    const res = await post(f.A, '/payroll/runs', {
      periodStart: '2026-03-02', periodEnd: '2026-03-15', payDate: '2026-03-20',
      payFrequency: 'biweekly', employeeIds: [emp],
    })
    expect(socialSecurityWageBase(2026)).toBe(184500)
    // Only 500 of the 2,000 is under the base: 6.2% of 500 = 31.00.
    expect(Number(res.body.data.lines[0].ss_tax)).toBe(31)
  })

  it('the Tax Center W-2 table is the chosen year’s pay', async () => {
    const f = await seed()
    const emp = await employee(f.aId)
    await approvedRun(f.aId, emp, '2025-06-01', 3000)
    await approvedRun(f.aId, emp, '2026-06-01', 1200)
    await db.query(`UPDATE books_employees SET ytd_gross = 4200 WHERE id=$1`, [emp])
    const y25 = await get(f.A, '/tax/summary?year=2025')
    expect(y25.body.data.employees).toHaveLength(1)
    expect(Number(y25.body.data.employees[0].ytd_gross)).toBe(3000)
    const y26 = await get(f.A, '/tax/summary?year=2026')
    expect(Number(y26.body.data.employees[0].ytd_gross)).toBe(1200)
  })
})

// ─── 7. Default hours ────────────────────────────────────────────────────────

describe('7. Hourly default hours follow the pay frequency (shared with the preview)', () => {
  for (const [freq, hours] of [['weekly', 40], ['biweekly', 80], ['semimonthly', 86.67], ['monthly', 173.33]] as const) {
    it(`${freq}: ${hours} hours when none are entered`, async () => {
      const f = await seed()
      const emp = await employee(f.aId, 'hourly', 20)
      const res = await post(f.A, '/payroll/runs', {
        periodStart: `${YEAR}-01-01`, periodEnd: `${YEAR}-01-31`, payDate: `${YEAR}-02-01`,
        payFrequency: freq, employeeIds: [emp],
      })
      expect(res.status).toBe(201)
      expect(booksDefaultHours(freq)).toBe(hours)
      expect(Number(res.body.data.lines[0].hours_worked)).toBe(hours)
      expect(Number(res.body.data.lines[0].gross_pay)).toBe(Math.round(20 * hours * 100) / 100)
    })
  }

  it('a pay frequency off the list is refused (it used to be paid as every two weeks)', async () => {
    const f = await seed()
    const emp = await employee(f.aId)
    const res = await post(f.A, '/payroll/runs', {
      periodStart: `${YEAR}-01-01`, periodEnd: `${YEAR}-01-31`, payDate: `${YEAR}-02-01`,
      payFrequency: 'daily', employeeIds: [emp],
    })
    expect(res.status).toBe(400)
  })
})

// ─── 8. Bills ────────────────────────────────────────────────────────────────

describe('8. Bills', () => {
  it('a bill is for an amount above zero', async () => {
    const f = await seed()
    for (const amount of [0, -50, 'abc']) {
      const r = await post(f.Z, '/bills', { date: TODAY, description: 'x', amount, vendorId: f.bizVendor })
      expect(r.status).toBe(400)
    }
    const v = await db.query(`SELECT ap_balance FROM books_vendors WHERE id=$1`, [f.bizVendor])
    expect(Number(v.rows[0].ap_balance)).toBe(0)
  })

  it('a payment is above zero (a negative one used to lower what was paid)', async () => {
    const f = await seed()
    const bill = (await post(f.Z, '/bills', { date: TODAY, description: 'Roof', amount: 500, vendorId: f.bizVendor })).body.data
    const r = await post(f.Z, `/bills/${bill.id}/pay`, { amount: -100 })
    expect(r.status).toBe(400)
    const after = await db.query(`SELECT amount_paid FROM books_bills WHERE id=$1`, [bill.id])
    expect(Number(after.rows[0].amount_paid)).toBe(0)
  })

  it('two payments of the whole bill at once apply once (row lock)', async () => {
    const f = await seed()
    const bill = (await post(f.Z, '/bills', { date: TODAY, description: 'Roof', amount: 500, vendorId: f.bizVendor })).body.data
    const [r1, r2] = await Promise.all([post(f.Z, `/bills/${bill.id}/pay`, {}), post(f.Z, `/bills/${bill.id}/pay`, {})])
    expect([r1.status, r2.status].sort()).toEqual([200, 400])
    const paid = await db.query(`SELECT amount_paid, status FROM books_bills WHERE id=$1`, [bill.id])
    expect(Number(paid.rows[0].amount_paid)).toBe(500)
    const rows = await db.query(`SELECT amount FROM books_bill_payments WHERE bill_id=$1`, [bill.id])
    expect(rows.rows).toHaveLength(1)
    const v = await db.query(`SELECT ap_balance, ytd_paid FROM books_vendors WHERE id=$1`, [f.bizVendor])
    expect(Number(v.rows[0].ytd_paid)).toBe(500)
    expect(Number(v.rows[0].ap_balance)).toBe(0)
  })

  it('each payment is its own row on the day it was made; Cash Flow reads each on its own day', async () => {
    const f = await seed()
    const bill = (await post(f.Z, '/bills', { date: TODAY, description: 'Paving', amount: 1000, vendorId: f.bizVendor })).body.data
    expect((await post(f.Z, `/bills/${bill.id}/pay`, { amount: 400 })).body.data.status).toBe('partial')
    const rows = await db.query<{ paid_on: string; amount: string; source: string }>(
      `SELECT to_char(paid_on, 'YYYY-MM-DD') AS paid_on, amount, source FROM books_bill_payments WHERE bill_id=$1`, [bill.id])
    expect(rows.rows).toEqual([{ paid_on: TODAY, amount: '400.00', source: 'payment' }])
    // A second part paid on another day (written as the route would on that day).
    await db.query(
      `INSERT INTO books_bill_payments (bill_id, business_id, paid_on, amount) VALUES ($1, $2, '${YEAR - 1}-12-15', 250)`,
      [bill.id, f.bizId])
    const now = await get(f.Z, `/reports/cash-flow?startDate=${TODAY}&endDate=${TODAY}`)
    expect(now.body.data.operating.outflows.bills).toBe(400)   // the part paid today, though the bill is not paid off
    const before = await get(f.Z, `/reports/cash-flow?startDate=${YEAR - 1}-12-01&endDate=${YEAR - 1}-12-31`)
    expect(before.body.data.operating.outflows.bills).toBe(250)
  })

  it('a bill paid before payment rows existed (old pay route) still counts, on the day it was paid; Paid This Month too', async () => {
    const f = await seed()
    const bill = (await post(f.Z, '/bills', { date: TODAY, description: 'Fence', amount: 1000, vendorId: f.bizVendor })).body.data
    // Paid $300 by the old route between the migration and the deploy: no payment row.
    await db.query(`UPDATE books_bills SET amount_paid = 300, paid_at = $2::date + time '12:00', status = 'partial' WHERE id = $1`, [bill.id, TODAY])
    const cf = await get(f.Z, `/reports/cash-flow?startDate=${TODAY}&endDate=${TODAY}`)
    expect(cf.body.data.operating.outflows.bills).toBe(300)
    // A later payment by the new route adds its own row; nothing is counted twice.
    expect((await post(f.Z, `/bills/${bill.id}/pay`, { amount: 100 })).status).toBe(200)
    const after = await get(f.Z, `/reports/cash-flow?startDate=${TODAY}&endDate=${TODAY}`)
    expect(after.body.data.operating.outflows.bills).toBe(400)
    const listed = (await get(f.Z, '/bills')).body.data.find((b: any) => b.id === bill.id)
    expect(Number(listed.paid_this_month)).toBe(400)
  })

  it('an overpayment kept as vendor credit is money out too', async () => {
    const f = await seed()
    const bill = (await post(f.Z, '/bills', { date: TODAY, description: 'Gravel', amount: 100, vendorId: f.bizVendor })).body.data
    const r = await post(f.Z, `/bills/${bill.id}/pay`, { amount: 130, acceptOverpayment: true })
    expect(r.status).toBe(200)
    expect(r.body.overpaymentCreditRecorded).toBe(30)
    const cf = await get(f.Z, `/reports/cash-flow?startDate=${TODAY}&endDate=${TODAY}`)
    expect(cf.body.data.operating.outflows.bills).toBe(130)
  })
})

// ─── 9. Transactions ─────────────────────────────────────────────────────────

describe('9. Transactions: edit only what was sent; remove hides, never erases', () => {
  async function tx(f: Fixture, body: any = {}) {
    const r = await post(f.Z, '/transactions', {
      date: TODAY, description: 'Laundry coins', amount: 80, type: 'income',
      category: 'Laundry', accountId: f.bizCash, reference: 'DEP-1', ...body,
    })
    expect(r.status).toBe(201)
    return r.body.data
  }

  it('PATCH with only a description keeps the category, account and reference', async () => {
    const f = await seed()
    const t = await tx(f)
    const res = await patch(f.Z, `/transactions/${t.id}`, { description: 'Laundry room coins' })
    expect(res.status).toBe(200)
    expect(res.body.data.description).toBe('Laundry room coins')
    expect(res.body.data.category).toBe('Laundry')
    expect(res.body.data.account_id).toBe(f.bizCash)
    expect(res.body.data.reference).toBe('DEP-1')
  })

  it('a field sent empty is cleared on purpose', async () => {
    const f = await seed()
    const t = await tx(f)
    const res = await patch(f.Z, `/transactions/${t.id}`, { reference: null, category: '' })
    expect(res.body.data.reference).toBeNull()
    expect(res.body.data.category).toBeNull()
    expect(res.body.data.account_id).toBe(f.bizCash)
  })

  it('type and amount are checked on create and edit', async () => {
    const f = await seed()
    const t = await tx(f)
    expect((await patch(f.Z, `/transactions/${t.id}`, { type: 'refund' })).status).toBe(400)
    expect((await patch(f.Z, `/transactions/${t.id}`, { amount: -5 })).status).toBe(400)
    expect((await post(f.Z, '/transactions', { date: TODAY, description: 'x', amount: 5, type: 'transfer' })).status).toBe(400)
    expect((await post(f.Z, '/transactions', { date: TODAY, description: 'x', amount: 0, type: 'income' })).status).toBe(400)
  })

  it('the tiles\' totals cover every live transaction, not only the 100 the list returns', async () => {
    const f = await seed()
    await db.query(
      `INSERT INTO books_transactions (business_id, date, description, amount, type, reconciled)
       SELECT $1, $2::date, 'coin ' || g, 1, 'income', FALSE FROM generate_series(1, 105) g`, [f.bizId, TODAY])
    await db.query(
      `INSERT INTO books_transactions (business_id, date, description, amount, type, reconciled) VALUES
         ($1, $2::date, 'paint', 10, 'expense', TRUE), ($1, $2::date, 'nails', 10.5, 'expense', FALSE)`, [f.bizId, TODAY])
    const hidden = (await post(f.Z, '/transactions', { date: TODAY, description: 'gone', amount: 999, type: 'income' })).body.data
    expect((await del(f.Z, `/transactions/${hidden.id}`)).status).toBe(200)
    expect((await get(f.Z, '/transactions')).body.data).toHaveLength(100)
    const sum = await get(f.Z, '/transactions/summary')
    expect(sum.status).toBe(200)
    expect(sum.body.data).toEqual({
      totalIncome: 105, totalExpenses: 20.5, net: 84.5,
      incomeCount: 105, expenseCount: 2, unreconciled: 106, count: 107,
    })
    // Another company's books are not in them.
    expect((await get(f.B, '/transactions/summary')).body.data.count).toBe(0)
  })

  it('DELETE hides the row (kept, with who and when); every read and Cash Flow skip it', async () => {
    const f = await seed()
    const t = await tx(f)
    const d = await del(f.Z, `/transactions/${t.id}`)
    expect(d.status).toBe(200)
    const row = await db.query(`SELECT deleted_at, deleted_by FROM books_transactions WHERE id=$1`, [t.id])
    expect(row.rows).toHaveLength(1)
    expect(row.rows[0].deleted_at).not.toBeNull()
    expect(row.rows[0].deleted_by).toBe(f.bizUid)
    expect((await get(f.Z, '/transactions')).body.data).toHaveLength(0)
    const cf = await get(f.Z, `/reports/cash-flow?startDate=${TODAY}&endDate=${TODAY}`)
    expect(cf.body.data.operating.inflows.otherIncome).toBe(0)
    expect((await del(f.Z, `/transactions/${t.id}`)).status).toBe(404)
    expect((await patch(f.Z, `/transactions/${t.id}`, { description: 'back?' })).status).toBe(404)
    expect((await patch(f.Z, `/transactions/${t.id}/reconcile`)).status).toBe(404)
  })
})

// 10/12 (Nic, ledger P6, L5): a landlord company's Bills and Transactions moved
// onto Expenses (migration 20261014180300); writing them is refused in words.
describe('8b. A landlord company\'s Bills and Transactions are on Expenses now', () => {
  it('a landlord\'s bill or transaction is refused with where it goes now', async () => {
    const f = await seed()
    for (const r of [
      await post(f.A, '/bills', { date: TODAY, description: 'Roof', amount: 500, vendorId: f.vendorA }),
      await post(f.A, '/transactions', { date: TODAY, description: 'Laundry coins', amount: 80, type: 'income' }),
    ]) {
      expect(r.status).toBe(409)
      expect(r.body.error).toMatch(/on Expenses now/)
    }
  })
})

// ─── 10. Journal entries ─────────────────────────────────────────────────────

describe('10. Journal entries', () => {
  const lines = (f: Fixture, d: number | string, c: number | string) => [
    { accountId: f.cash, debit: d, credit: 0 }, { accountId: f.income, debit: 0, credit: c },
  ]

  it('a negative amount is refused (it let a one-sided entry "balance")', async () => {
    const f = await seed()
    const res = await post(f.A, '/journal', {
      date: TODAY, description: 'sneaky',
      lines: [{ accountId: f.cash, debit: 100, credit: 0 }, { accountId: f.income, debit: -100, credit: 0 }],
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/cannot be negative/)
  })

  it('a one-cent imbalance is refused; amounts that add up in cents post', async () => {
    const f = await seed()
    const off = await post(f.A, '/journal', { date: TODAY, description: 'a cent off', lines: lines(f, 100, 99.99) })
    expect(off.status).toBe(400)
    expect(off.body.error).toMatch(/out of balance/i)
    const ok = await post(f.A, '/journal', {
      date: TODAY, description: 'tenths',
      lines: [
        { accountId: f.cash, debit: 0.1, credit: 0 }, { accountId: f.cash, debit: 0.2, credit: 0 },
        { accountId: f.income, debit: 0, credit: 0.3 },
      ],
    })
    expect(ok.status).toBe(201)
    const cash = await db.query(`SELECT balance FROM books_accounts WHERE id=$1`, [f.cash])
    expect(cash.rows[0].balance).toBe('0.30')
  })

  it('an entry type off the shared list is refused', async () => {
    const f = await seed()
    const res = await post(f.A, '/journal', { date: TODAY, description: 'x', type: 'closing', lines: lines(f, 5, 5) })
    expect(res.status).toBe(400)
  })

  it('two voids at once reverse the balances once', async () => {
    const f = await seed()
    const e = await entry(f, TODAY, f.cash, f.income, 300)
    const [v1, v2] = await Promise.all([post(f.A, `/journal/${e.id}/void`), post(f.A, `/journal/${e.id}/void`)])
    expect([v1.status, v2.status].sort()).toEqual([200, 400])
    const cash = await db.query(`SELECT balance FROM books_accounts WHERE id=$1`, [f.cash])
    expect(Number(cash.rows[0].balance)).toBe(0)
  })

  it('each company numbers its own entries 1, 2, 3', async () => {
    const f = await seed()
    const a1 = await entry(f, TODAY, f.cash, f.income, 10)
    const a2 = await entry(f, TODAY, f.cash, f.income, 20)
    const bInc = (await post(f.B, '/accounts', { code: '4010', name: 'B Rent', type: 'income' })).body.data.id
    const b1 = await post(f.B, '/journal', {
      date: TODAY, description: 'B first',
      lines: [{ accountId: f.bCash, debit: 5, credit: 0 }, { accountId: bInc, debit: 0, credit: 5 }],
    })
    expect([a1.entry_number, a2.entry_number, b1.body.data.entry_number]).toEqual([1, 2, 1])
    // Entries posted at the same moment still take different numbers.
    const many = await Promise.all([1, 2, 3, 4].map(() => post(f.A, '/journal', {
      date: TODAY, description: 'burst', lines: lines(f, 1, 1),
    })))
    expect(many.map(r => r.body.data.entry_number).sort()).toEqual([3, 4, 5, 6])
  })
})

// ─── 11. Bank reconciliation ─────────────────────────────────────────────────

describe('11. Bank reconciliation is one account’s, with no row cap', () => {
  it('lists every uncleared transaction of the chosen account; balances come from that account', async () => {
    const f = await seed()
    await entry(f, TODAY, f.cash, f.equity, 1000)            // opening money in Checking
    const values: string[] = []
    const params: any[] = [f.aId, f.cash, TODAY]
    for (let i = 0; i < 105; i++) values.push(`($1, $3, 'deposit ${i}', 10, 'income', $2, FALSE)`)
    await db.query(
      `INSERT INTO books_transactions (landlord_id, date, description, amount, type, account_id, reconciled)
       VALUES ${values.join(',')}`, params)
    await db.query(
      `INSERT INTO books_transactions (landlord_id, date, description, amount, type, account_id, reconciled) VALUES
         ($1, $3, 'cleared check', 50, 'expense', $2, TRUE),
         ($1, $3, 'savings deposit', 999, 'income', $4, FALSE),
         ($1, $3, 'no account', 7, 'income', NULL, FALSE)`, [f.aId, f.cash, TODAY, f.savings])
    const res = await get(f.A, `/reconciliation?accountId=${f.cash}`)
    expect(res.status).toBe(200)
    const d = res.body.data
    expect(d.uncleared).toHaveLength(105)               // the old list stopped at 100
    expect(d.journalBalance).toBe(1000)
    expect(d.clearedNet).toBe(-50)
    expect(d.clearedBalance).toBe(950)
    expect(d.unclearedNet).toBe(1050)
    expect(d.bookBalance).toBe(2000)
    expect(d.unassignedCount).toBe(1)
    // Savings' own deposit is in Savings' reconciliation, not Checking's.
    const s = await get(f.A, `/reconciliation?accountId=${f.savings}`)
    expect(s.body.data.uncleared.map((t: any) => t.description)).toEqual(['savings deposit'])
  })

  it('another company’s account is not found; a non-bank account is refused', async () => {
    const f = await seed()
    expect((await get(f.A, `/reconciliation?accountId=${f.bCash}`)).status).toBe(404)
    expect((await get(f.A, `/reconciliation?accountId=${f.income}`)).status).toBe(400)
  })
})

// ─── 12. Cash flow ───────────────────────────────────────────────────────────

describe('12. Cash Flow includes what GAM records elsewhere', () => {
  it('Expenses-page spend, maintenance costs and bank-filed other income are in the totals', async () => {
    const f = await seed()
    await db.query(
      `INSERT INTO landlord_expenses (landlord_id, property_id, category, amount, expense_date)
       VALUES ($1, $2, 'supplies', 120, $3)`, [f.aId, f.propertyAId, TODAY])
    await db.query(
      `INSERT INTO maintenance_requests (unit_id, landlord_id, title, description, status, actual_cost, completed_at)
       VALUES ($1, $2, 'Leak', 'Kitchen sink', 'completed', 80, $3::date + time '12:00')`, [f.unitAId, f.aId, TODAY])
    await db.query(
      `INSERT INTO landlord_other_income (landlord_id, category, amount, income_date) VALUES
         ($1, 'laundry', 45, $2),
         ($1, 'owner_contribution', 5000, $2)`, [f.aId, TODAY])
    const res = await get(f.A, `/reports/cash-flow?startDate=${TODAY}&endDate=${TODAY}`)
    expect(res.status).toBe(200)
    const op = res.body.data.operating
    expect(op.inflows.filedOtherIncome).toBe(45)          // the owner's own money is not income
    expect(op.outflows.enteredExpenses).toBe(120)
    expect(op.outflows.maintenance).toBe(80)
    expect(op.inflows.total).toBe(45)
    expect(op.outflows.total).toBe(200)
    expect(op.net).toBe(-155)
    // 10/11: not income, but cash that arrived: financing, and in the net.
    expect(res.body.data.financing).toMatchObject({ ownerContributions: 5000, disbursements: 0, total: 5000 })
    expect(res.body.data.netCashFlow).toBe(4845)
  })
})

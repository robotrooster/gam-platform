/**
 * 10/12 (Nic) — GAM Books: one vendor list (the 1099 box, a year's payments),
 * the loan matcher the Bank page's filing calls, and the helpers the other
 * money-out lanes use (services/booksVendorsLoans.ts).
 *
 *   Nic 10/12: "VENDORS = one list of everyone the company pays (contractors,
 *   garbage company, power company) with a type; contractors get a 1099 box
 *   and their payments add up per calendar year."
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../db'
import { cleanupAllSchema, seedTenant, seedLease } from '../test/dbHelpers'
import { ledgerCompany, inTx, type LedgerCompany } from '../test/ledgerFixtures'
import {
  vendor1099List, vendorYearTotals, vendorOwed, listVendors, getOrCreateContractorVendorForTenant,
  matchLoanPaymentForBankLine, findLoanMatchesForBankLine, unmatchLoanBankLine, loanFigures, LOAN_COLUMNS,
} from './booksVendorsLoans'

beforeEach(async () => {
  await cleanupAllSchema()
})

const owner = (co: LedgerCompany) => ({ col: 'landlord_id' as const, id: co.landlordId })

async function vendor(co: LedgerCompany, o: { name?: string; type?: string; is1099?: boolean } = {}): Promise<string> {
  return (await db.query<{ id: string }>(
    `INSERT INTO books_vendors (landlord_id, name, vendor_type, is_1099) VALUES ($1, $2, $3, $4) RETURNING id`,
    [co.landlordId, o.name ?? 'Jose Yard Care', o.type ?? 'contractor', o.is1099 ?? true])).rows[0].id
}

/** An expense to a vendor and its payments (each { day, amount, method }). */
async function paid(co: LedgerCompany, vendorId: string, amount: number, payments: { day: string; amount: number; method?: string; voided?: boolean }[],
  o: { status?: string } = {}): Promise<string> {
  return inTx(async (c) => {
    const e = (await c.query<{ id: string }>(
      `INSERT INTO landlord_expenses (landlord_id, property_id, category, amount, expense_date, vendor_id, payments_tracked)
       VALUES ($1, $2, 'landscaping', $3, $4, $5, TRUE) RETURNING id`,
      [co.landlordId, co.propertyId, amount, payments[0]?.day ?? '2026-01-15', vendorId])).rows[0].id
    for (const p of payments) {
      await c.query(
        `INSERT INTO landlord_expense_payments (expense_id, landlord_id, paid_on, amount, method, source, voided_at)
         VALUES ($1, $2, $3, $4, $5, 'payment', $6)`,
        [e, co.landlordId, p.day, p.amount, p.method ?? 'check', p.voided ? new Date() : null])
    }
    if (o.status) await c.query(`UPDATE landlord_expenses SET status = $2, voided_at = now() WHERE id = $1`, [e, o.status])
    return e
  })
}

describe('the 1099 list: a contractor\'s payments added up per calendar year', () => {
  it('counts live payments on active expenses by the day paid; card payments are shown but not counted', async () => {
    const co = await ledgerCompany()
    const jose = await vendor(co)
    await paid(co, jose, 2500, [{ day: '2026-02-01', amount: 1500 }, { day: '2026-03-01', amount: 300, method: 'card' }])
    await paid(co, jose, 1000, [{ day: '2026-04-01', amount: 1000, voided: true }])
    await paid(co, jose, 700, [{ day: '2025-12-30', amount: 700 }])
    const t = await vendorYearTotals(db, owner(co), 2026)
    expect(t.get(jose)).toEqual({ paidCents: 180_000, cardCents: 30_000, reportableCents: 150_000 })
    const list = await vendor1099List(db, owner(co), 2026)
    expect(list.threshold).toBe(2000)
    expect(list.vendors).toMatchObject([{ vendor_id: jose, paid: 1800, paid_by_card: 300, reportable: 1500, needs_1099: false }])
    // $600 more paid in 2026 crosses the $2,000 line.
    await paid(co, jose, 600, [{ day: '2026-05-01', amount: 600 }])
    expect((await vendor1099List(db, owner(co), 2026)).vendors[0]).toMatchObject({ reportable: 2100, needs_1099: true })
    // 2025's $700 is over that year's $600 line.
    expect((await vendor1099List(db, owner(co), 2025)).vendors[0]).toMatchObject({ reportable: 700, threshold: 600, needs_1099: true })
  })

  it('lists only vendors with the 1099 box, inactive ones too (they were paid that year); a voided expense counts nothing', async () => {
    const co = await ledgerCompany()
    const power = await vendor(co, { name: 'APS', type: 'utility', is1099: false })
    const gone = await vendor(co, { name: 'Old roofer' })
    const voided = await vendor(co, { name: 'Never paid' })
    await paid(co, power, 400, [{ day: '2026-02-01', amount: 400 }])
    await paid(co, gone, 900, [{ day: '2026-02-01', amount: 900 }])
    await paid(co, voided, 900, [{ day: '2026-02-01', amount: 900 }], { status: 'voided' })
    await db.query(`UPDATE books_vendors SET status = 'inactive' WHERE id = $1`, [gone])
    expect((await vendor1099List(db, owner(co), 2026)).vendors.map(v => v.name)).toEqual(['Old roofer'])
  })

  it('the vendor list shows what each was paid this year and is still owed — never the taxpayer id itself', async () => {
    const co = await ledgerCompany()
    const jose = await vendor(co)
    await db.query(`UPDATE books_vendors SET tax_id = '12-3456789' WHERE id = $1`, [jose])
    await paid(co, jose, 1000, [{ day: '2026-02-01', amount: 400 }])
    expect((await vendorOwed(db, owner(co))).get(jose)).toBe(60_000)
    const [row] = await listVendors(db, owner(co), { year: 2026 })
    expect(row).toMatchObject({ id: jose, paid_this_year: 400, owed: 600, tax_id_last4: '6789', has_tax_id: true })
    expect(row).not.toHaveProperty('tax_id')
    expect(JSON.stringify(row)).not.toContain('3456789')
  })
})

describe('the Contractors list folds into the one Vendors list', () => {
  it('a contractor saved on the old page becomes a contractor vendor with the 1099 box, and stays in step', async () => {
    const co = await ledgerCompany()
    const c = (await db.query<{ id: string }>(
      `INSERT INTO books_contractors (landlord_id, first_name, last_name, business_name, email, entity_type, ssn_last4, trade, pay_rate, pay_unit, w9_on_file)
       VALUES ($1, 'Jose', 'Ruiz', '', 'jose@test.dev', 'individual', '1234', 'Landscaping', 25, 'hour', TRUE) RETURNING id`,
      [co.landlordId])).rows[0].id
    const v = (await db.query(`SELECT * FROM books_vendors WHERE migrated_from_contractor_id = $1`, [c])).rows[0]
    expect(v).toMatchObject({ name: 'Jose Ruiz', contact_name: 'Jose Ruiz', vendor_type: 'contractor', is_1099: true,
      tax_classification: 'individual', ssn_last4: '1234', trade: 'Landscaping', pay_unit: 'hour', w9_on_file: true, status: 'active' })
    await db.query(`UPDATE books_contractors SET business_name = 'Ruiz Yards LLC', entity_type = 'business', status = 'inactive' WHERE id = $1`, [c])
    const after = (await db.query(`SELECT * FROM books_vendors WHERE migrated_from_contractor_id = $1`, [c])).rows
    expect(after).toHaveLength(1)
    // 'business' (before 10/11) is no W-9 box: left blank, the contractor row keeps the word.
    expect(after[0]).toMatchObject({ name: 'Ruiz Yards LLC', tax_classification: null, status: 'inactive' })
  })
})

describe('getOrCreateContractorVendorForTenant — one vendor per work trader paid as a contractor', () => {
  it('made the first time (contractor, 1099 box, individual), found again after; refused for a stranger', async () => {
    const co = await ledgerCompany()
    const tenantId = await inTx(async (c) => {
      const t = await seedTenant(c)
      const lease = await seedLease(c, { unitId: co.unitId, landlordId: co.landlordId })
      await c.query(`INSERT INTO lease_tenants (lease_id, tenant_id, role) VALUES ($1, $2, 'primary')`, [lease, t])
      return t
    })
    const first = await inTx(c => getOrCreateContractorVendorForTenant(c, { landlordId: co.landlordId, tenantId }))
    expect(first).toMatchObject({ created: true, name: 'Test Tenant' })
    expect(first.id).toBe(first.vendorId)
    const v = (await db.query(`SELECT * FROM books_vendors WHERE id = $1`, [first.id])).rows[0]
    expect(v).toMatchObject({ vendor_type: 'contractor', is_1099: true, tax_classification: 'individual', tenant_id: tenantId })
    await db.query(`UPDATE books_vendors SET status = 'inactive' WHERE id = $1`, [first.id])
    const again = await inTx(c => getOrCreateContractorVendorForTenant(c, { landlordId: co.landlordId, tenantId }))
    expect(again).toMatchObject({ id: first.id, created: false })
    expect((await db.query(`SELECT status FROM books_vendors WHERE id = $1`, [first.id])).rows[0].status).toBe('active')
    const stranger = await inTx(c => seedTenant(c))
    await expect(inTx(c => getOrCreateContractorVendorForTenant(c, { landlordId: co.landlordId, tenantId: stranger })))
      .rejects.toThrow(/not one of this company's tenants/)
  })
})

describe('matchLoanPaymentForBankLine — a bank line that is a loan payment, or a loan\'s money arriving', () => {
  async function setup() {
    const co = await ledgerCompany()
    const conn = (await db.query<{ id: string }>(
      `INSERT INTO bank_connections (landlord_id, provider, institution_name, account_last4) VALUES ($1, 'csv', 'First Bank', '4321') RETURNING id`,
      [co.landlordId])).rows[0].id
    const loan = (await db.query<{ id: string }>(
      `INSERT INTO books_loans (landlord_id, property_id, name, lender_name, original_amount, annual_rate, start_date,
                                payment_amount, escrow_amount, funded_to, funded_bank_connection_id)
       VALUES ($1, $2, 'Oak Street mortgage', 'First Bank', 120000, 6, '2026-02-01', 1200, 200, 'bank', $3) RETURNING id`,
      [co.landlordId, co.propertyId, conn])).rows[0].id
    const line = async (day: string, amount: number) => (await db.query<{ id: string }>(
      `INSERT INTO bank_transactions (bank_connection_id, landlord_id, external_id, posted_date, amount, description)
       VALUES ($1, $2, gen_random_uuid()::text, $3, $4, 'FIRST BANK MTG') RETURNING id`, [conn, co.landlordId, day, amount])).rows[0].id
    return { co, conn, loan, line }
  }

  it('money out for the regular payment becomes a payment made from the line, split as GAM suggests; matching again says what it is', async () => {
    const { co, conn, loan, line } = await setup()
    const l = await line('2026-03-01', -1200)
    const m = await inTx(c => matchLoanPaymentForBankLine(c, { landlordId: co.landlordId, bankTransactionId: l }))
    // $120,000 at 6%: $600 interest, $200 escrow, $400 principal.
    expect(m).toMatchObject({ kind: 'loan_payment', loanId: loan, created: true,
      split: { principalCents: 40_000, interestCents: 60_000, escrowCents: 20_000 } })
    const p = (await db.query(`SELECT * FROM books_loan_payments WHERE id = $1`, [m!.loanPaymentId])).rows[0]
    expect(p).toMatchObject({ source: 'bank_line', method: 'bank', bank_connection_id: conn, bank_transaction_id: l })
    const again = await inTx(c => matchLoanPaymentForBankLine(c, { landlordId: co.landlordId, bankTransactionId: l }))
    expect(again).toMatchObject({ loanPaymentId: m!.loanPaymentId, created: false })
    const loanRow = (await db.query(`SELECT ${LOAN_COLUMNS} FROM books_loans l WHERE l.id = $1`, [loan])).rows
    expect((await loanFigures(db, loanRow as any)).get(loan)).toMatchObject({ balance: 119600, escrow_held: 200, payments: 1 })
  })

  it('a payment typed first for the same amount within a week is the one the line matches (no second payment)', async () => {
    const { co, loan, line } = await setup()
    const typed = (await db.query<{ id: string }>(
      `INSERT INTO books_loan_payments (loan_id, landlord_id, paid_on, amount, principal, interest, escrow, method)
       VALUES ($1, $2, '2026-03-03', 1200, 450, 550, 200, 'bank') RETURNING id`, [loan, co.landlordId])).rows[0].id
    const l = await line('2026-03-05', -1200)
    const m = await inTx(c => matchLoanPaymentForBankLine(c, { landlordId: co.landlordId, bankTransactionId: l }))
    expect(m).toMatchObject({ kind: 'loan_payment', loanPaymentId: typed, created: false })
    expect((await db.query(`SELECT count(*)::int AS n FROM books_loan_payments`)).rows[0].n).toBe(1)
    // Undo: a payment typed first is only unlinked (it stays, paid from the bank).
    const undo = await inTx(c => unmatchLoanBankLine(c, { landlordId: co.landlordId, bankTransactionId: l, actorUserId: null }))
    expect(undo).toEqual({ voidedPaymentIds: [], unlinkedPaymentIds: [typed], unlinkedLoanIds: [] })
    expect((await db.query(`SELECT bank_transaction_id, voided_at FROM books_loan_payments WHERE id = $1`, [typed])).rows[0])
      .toEqual({ bank_transaction_id: null, voided_at: null })
  })

  it('two loans with the same payment: no guess — the person picks one (loanId); Undo voids a payment made from the line', async () => {
    const { co, loan, line } = await setup()
    const other = (await db.query<{ id: string }>(
      `INSERT INTO books_loans (landlord_id, name, lender_name, original_amount, annual_rate, start_date, payment_amount, funded_to)
       VALUES ($1, 'Truck loan', 'Credit Union', 30000, 0, '2026-01-01', 1200, 'equipment') RETURNING id`, [co.landlordId])).rows[0].id
    const l = await line('2026-03-01', -1200)
    expect(await inTx(c => matchLoanPaymentForBankLine(c, { landlordId: co.landlordId, bankTransactionId: l }))).toBeNull()
    expect((await findLoanMatchesForBankLine(db, { landlordId: co.landlordId, bankTransactionId: l })).map(x => x.loanId).sort())
      .toEqual([loan, other].sort())
    const m = await inTx(c => matchLoanPaymentForBankLine(c, { landlordId: co.landlordId, bankTransactionId: l, loanId: other }))
    expect(m).toMatchObject({ loanId: other, created: true, split: { principalCents: 120_000, interestCents: 0, escrowCents: 0 } })
    const undo = await inTx(c => unmatchLoanBankLine(c, { landlordId: co.landlordId, bankTransactionId: l, actorUserId: null }))
    expect(undo.voidedPaymentIds).toEqual([m!.loanPaymentId])
    expect((await db.query(`SELECT voided_at IS NOT NULL AS v, void_reason FROM books_loan_payments WHERE id = $1`, [m!.loanPaymentId])).rows[0])
      .toMatchObject({ v: true })
  })

  it('money in for what a loan put in the bank, within a week of its start, is the loan\'s money arriving', async () => {
    const { co, loan, line } = await setup()
    const l = await line('2026-02-03', 120000)
    const m = await inTx(c => matchLoanPaymentForBankLine(c, { landlordId: co.landlordId, bankTransactionId: l }))
    expect(m).toMatchObject({ kind: 'loan_funding', loanId: loan })
    expect((await db.query(`SELECT funded_bank_transaction_id FROM books_loans WHERE id = $1`, [loan])).rows[0].funded_bank_transaction_id).toBe(l)
    const far = await line('2026-04-03', 120000)
    expect(await inTx(c => matchLoanPaymentForBankLine(c, { landlordId: co.landlordId, bankTransactionId: far }))).toBeNull()
  })

  it('a line of another company is refused; a split that does not add up is refused; never more principal than is owed', async () => {
    const { co, loan, line } = await setup()
    const other = await ledgerCompany()
    const l = await line('2026-03-01', -1200)
    await expect(inTx(c => matchLoanPaymentForBankLine(c, { landlordId: other.landlordId, bankTransactionId: l }))).rejects.toThrow(/not this company's/)
    await expect(inTx(c => matchLoanPaymentForBankLine(c, { landlordId: co.landlordId, bankTransactionId: l, loanId: loan,
      split: { principalCents: 100, interestCents: 100, escrowCents: 100 } }))).rejects.toThrow(/add up/)
    await db.query(`UPDATE books_loans SET original_amount = 100 WHERE id = $1`, [loan])
    expect(await inTx(c => matchLoanPaymentForBankLine(c, { landlordId: co.landlordId, bankTransactionId: l }))).toBeNull()
  })
})

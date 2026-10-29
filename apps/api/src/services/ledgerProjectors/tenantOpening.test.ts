/**
 * 10/12 (Nic) — GAM Books ledger, phase P4, family J: the opening posting and
 * home sales (gam-ledger-design-2026-10-12 §6 J1, J2; §15; §17 "a pre-books
 * home sale (TruBlu shape) and a new one").
 *
 *   Nic 10/12: history start and pre-GAM deposits are the landlord's choice
 *   (opening balances); L11 home sales: the whole sale at signing or income as
 *   paid; L16 TruBlu picks its own start date.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { db } from '../../db'
import { inTx, markChanged } from '../../test/ledgerFixtures'
import {
  cleanupTenantLedger, tenantCo, addLease, bill, receipt, drain, bal, activeLines, triples, bankConnection, sourceError, type TenantCo,
} from '../../test/ledgerTenantFixtures'
import { registeredLedgerSourceTypes, unregisterLedgerProjector, registerLedgerProjector } from '../ledgerEngine'
import { checkOwner } from '../ledgerCheck'
import { registerTenantLedgerProjectors } from './tenantMoney'
import { payoutDisbursementProjector } from './payoutDisbursement'
import { P6_LEDGER_PROJECTORS } from './moneyOut'

beforeEach(async () => {
  await cleanupTenantLedger()
  registerTenantLedgerProjectors()
})
afterEach(() => {
  for (const t of registeredLedgerSourceTypes()) unregisterLedgerProjector(t)
})

describe('J1: what came before the books start opens on the start date', () => {
  it('open bills, cash in the drawer and paid-ahead money the landlord holds open; the rest is 3900 — property by property', async () => {
    const co = await tenantCo({ booksStart: '2026-10-01' })
    const unpaid = await bill(co, { amount: 500, due: '2026-09-01' })
    const paid = await bill(co, { amount: 1000, due: '2026-08-01' })
    await receipt(co, { method: 'cash', settledAt: '2026-09-05T17:00:00Z', apps: [{ paymentId: paid, amount: 1000 }], surplus: 200 })
    await markChanged('opening', co.landlordId, co.landlordId)
    await drain()
    // Nothing dated before the start posts on its own.
    expect(await activeLines('payment', unpaid)).toEqual([])
    const opening = await activeLines('opening', co.landlordId)
    expect(opening.every(l => l.day === '2026-10-01' && l.category === 'opening' && l.cash === null)).toBe(true)
    expect(triples(opening).sort()).toEqual([
      ['ar_tenants', 50000, 0], ['opening_balance_equity', 0, 150000], ['tenant_prepayments', 0, 20000], ['undeposited_funds', 120000, 0],
    ])
    expect(opening.find(l => l.role === 'ar_tenants')).toMatchObject({ paymentId: unpaid, tenantId: co.tenantId, propertyId: co.propertyId })
    // The old bill paid after the start: the receipt posts, the receivable closes.
    await receipt(co, { method: 'ach', settledAt: '2026-10-03T18:00:00Z', apps: [{ paymentId: unpaid, amount: 500 }] })
    await drain()
    expect(await bal(co.landlordId, 'ar_tenants')).toBe(0)
    expect(await bal(co.landlordId, 'space_rent')).toBe(0)   // September's rent is before the books
  })

  // 10/12 (Nic, ledger review): L1 "within a minute" — a fix to a record
  // dated before the start re-posts the opening at once (the engine marks it),
  // never left to the nightly check as drift with an admin notice.
  it('a change to history before the start re-posts the opening within the minute (no nightly drift, no plug)', async () => {
    const co = await tenantCo({ booksStart: '2026-10-01' })
    const unpaid = await bill(co, { amount: 500, due: '2026-09-01' })
    const fixed = await bill(co, { amount: 300, due: '2026-09-05' })
    await markChanged('opening', co.landlordId, co.landlordId)
    await drain()
    expect(await bal(co.landlordId, 'ar_tenants')).toBe(80000)
    // Voided (it now wants nothing) and an amount fixed (still before the start).
    await db.query(`UPDATE payments SET status = 'voided', voided_at = now(), void_reason = 'billed twice' WHERE id = $1`, [unpaid])
    await db.query(`UPDATE payments SET amount = 250 WHERE id = $1`, [fixed])
    await drain()
    expect(await bal(co.landlordId, 'ar_tenants')).toBe(25000)
    const res = await checkOwner({ landlordId: co.landlordId })
    expect(res.findings.filter(f => f.check === 'source_drift')).toEqual([])
    expect(res.repaired).toBe(0)
    expect((await db.query(`SELECT 1 FROM admin_notifications WHERE category = 'books_ledger'`)).rows).toEqual([])
  })

  // 10/12 (Nic, ledger review): a bank opens only from the balance the owner
  // enters — that statement balance already holds what GAM recorded before.
  it('a bank movement before the start and an entered bank balance: Checking opens at the entered balance only', async () => {
    const co = await tenantCo({ booksStart: '2026-10-01' })
    registerLedgerProjector(payoutDisbursementProjector)
    const conn = await bankConnection(co)
    // A payout landed 9/15 (Dr 1010 / Cr 1060), and a bank-deposit receipt the bank showed 9/8 (Dr 1010 / Cr 1045).
    await db.query(
      `INSERT INTO disbursements (landlord_id, amount, status, settled_at, bank_last4, trigger_type)
       VALUES ($1, 400, 'settled', '2026-09-15T18:00:00Z', '4321', 'auto_friday')`, [co.landlordId])
    const fee = await bill(co, { type: 'fee', amount: 60, due: '2026-09-02' })
    const { remittanceId } = await receipt(co, { method: 'bank_deposit', settledAt: '2026-09-06T17:00:00Z', apps: [{ paymentId: fee, amount: 60 }] })
    await db.query(
      `INSERT INTO bank_transactions (bank_connection_id, landlord_id, external_id, posted_date, amount, status, auto_settle_undo)
       VALUES ($1, $2, 'ext-pre-start', '2026-09-08', 60, 'matched', jsonb_build_object('receiptId', $3::text))`,
      [conn, co.landlordId, remittanceId])
    // The owner's statement balance on the start date.
    await db.query(
      `INSERT INTO books_opening_items (landlord_id, kind, bank_connection_id, amount, as_of) VALUES ($1, 'bank', $2, 5000, '2026-10-01')`,
      [co.landlordId, conn])
    await drain()
    const opening = await activeLines('opening', co.landlordId)
    expect(opening.filter(l => l.role === 'bank_checking').map(l => l.dr - l.cr)).toEqual([500000])
    expect(await bal(co.landlordId, 'bank_checking')).toBe(500000)
    expect(await bal(co.landlordId, 'deposits_in_transit')).toBe(0)
    expect(await bal(co.landlordId, 'stripe_in_transit')).toBe(-40000)   // what GAM recorded paying out before the start
  })

  // 10/12 review (ledger P6): a category posts to the account it is pointed
  // at — any account of the chart — so the opening judges its lines by that
  // account, never by the category's starting role.
  it('a category pointed at an asset account: what was bought under it before the start opens on that asset, not in 3900', async () => {
    const co = await tenantCo({ booksStart: '2026-10-01' })
    for (const p of P6_LEDGER_PROJECTORS) registerLedgerProjector(p)
    await db.query(`SELECT books_seed_categories($1)`, [co.landlordId])
    const cat = (await db.query<{ id: string }>(
      `INSERT INTO books_categories (landlord_id, direction, name) VALUES ($1, 'expense', 'Capital improvements') RETURNING id`,
      [co.landlordId])).rows[0].id
    const acct = (await db.query<{ id: string }>(
      `INSERT INTO books_accounts (landlord_id, code, name, type) VALUES ($1, '1560', 'Capital improvements', 'asset') RETURNING id`,
      [co.landlordId])).rows[0].id
    await db.query(`INSERT INTO books_account_map (landlord_id, map_kind, map_value, account_id, effective_from)
                    VALUES ($1, 'expense_category', $2, $3, '0001-01-01')`, [co.landlordId, cat, acct])
    const exp = (await db.query<{ id: string }>(
      `INSERT INTO landlord_expenses (landlord_id, property_id, category, category_id, amount, expense_date, payments_tracked)
       VALUES ($1, $2, 'other', $3, 2500, '2026-09-15', TRUE) RETURNING id`, [co.landlordId, co.propertyId, cat])).rows[0].id
    await db.query(`INSERT INTO landlord_expense_payments (expense_id, landlord_id, paid_on, amount, method, source)
                    VALUES ($1, $2, '2026-09-15', 2500, 'other', 'payment')`, [exp, co.landlordId])
    await markChanged('opening', co.landlordId, co.landlordId)
    expect(await drain()).toMatchObject({ failed: 0 })
    const lines = (await db.query<{ account_id: string; dr: string; cr: string }>(
      `SELECT l.account_id, round(l.debit * 100)::bigint::text AS dr, round(l.credit * 100)::bigint::text AS cr
         FROM ledger_postings p JOIN ledger_posting_lines l ON l.posting_id = p.id
        WHERE p.source_type = 'opening' AND p.source_id = $1 AND p.role = 'post' AND p.superseded_at IS NULL`, [co.landlordId])).rows
    expect(lines.find(l => l.account_id === acct)).toMatchObject({ dr: '250000', cr: '0' })
    expect(await bal(co.landlordId, 'opening_balance_equity')).toBe(-250000)
  })

  it('an opening balance entered for an earlier start date makes the opening wait on the owner', async () => {
    const co = await tenantCo({ booksStart: '2026-10-01' })
    const conn = await bankConnection(co)
    const item = (await db.query<{ id: string }>(
      `INSERT INTO books_opening_items (landlord_id, kind, bank_connection_id, amount, as_of) VALUES ($1, 'bank', $2, 5000, '2026-08-01') RETURNING id`,
      [co.landlordId, conn])).rows[0].id
    await drain()
    expect(await activeLines('opening', co.landlordId)).toEqual([])
    expect(await sourceError('opening', co.landlordId)).toMatchObject({ reason_code: 'owner_not_ready' })
    // Entered again for the start date (the old one voided, never removed): it posts.
    await db.query(`UPDATE books_opening_items SET voided_at = now(), voided_by = $2, void_reason = 'start date moved' WHERE id = $1`,
      [item, co.ownerUserId])
    await db.query(
      `INSERT INTO books_opening_items (landlord_id, kind, bank_connection_id, amount, as_of) VALUES ($1, 'bank', $2, 5100, '2026-10-01')`,
      [co.landlordId, conn])
    await drain()
    expect(await bal(co.landlordId, 'bank_checking')).toBe(510000)
  })

  // 10/12 (Nic, ledger review): a receipt listed on the company's calendar on
  // the start day can post on its property's calendar the day before.
  it('a receipt on the start day by the company\'s calendar but the day before by its property\'s opens in the opening, not lost', async () => {
    const co = await tenantCo({ booksStart: '2026-10-01' })
    await db.query(`UPDATE landlords SET books_timezone = 'America/New_York' WHERE id = $1`, [co.landlordId])
    await db.query(`UPDATE properties SET timezone = 'Pacific/Honolulu' WHERE id = $1`, [co.propertyId])
    const rent = await bill(co, { amount: 500, due: '2026-09-01' })
    // 10/1 01:00 in New York; 9/30 19:00 in Honolulu.
    const { remittanceId } = await receipt(co, { method: 'card', settledAt: '2026-10-01T05:00:00Z', apps: [{ paymentId: rent, amount: 500 }] })
    await markChanged('opening', co.landlordId, co.landlordId)
    await drain()
    expect(await activeLines('remittance', remittanceId)).toEqual([])   // before the start on its property's calendar
    expect(await bal(co.landlordId, 'ar_tenants')).toBe(0)
    expect(await bal(co.landlordId, 'due_from_gam')).toBe(50000)
  })

  it('opening balances the owner entered: a bank balance, a deposit they hold, an "other" item on the account they named', async () => {
    const co = await tenantCo({ booksStart: '2026-10-01' })
    const conn = await bankConnection(co)
    const equipment = (await db.query<{ id: string }>(
      `INSERT INTO books_accounts (landlord_id, code, name, type) VALUES ($1, '1531', 'Golf cart', 'asset') RETURNING id`, [co.landlordId])).rows[0].id
    const loan = (await db.query<{ id: string }>(
      `INSERT INTO books_accounts (landlord_id, code, name, type) VALUES ($1, '2101', 'Cart loan', 'liability') RETURNING id`, [co.landlordId])).rows[0].id
    await db.query(
      `INSERT INTO books_opening_items (landlord_id, kind, bank_connection_id, amount, as_of) VALUES ($1, 'bank', $2, 5000, '2026-10-01')`,
      [co.landlordId, conn])
    await db.query(
      `INSERT INTO books_opening_items (landlord_id, kind, lease_id, tenant_id, amount, as_of, paid_on)
       VALUES ($1, 'deposit_held', $2, $3, 750, '2026-10-01', '2025-04-01')`, [co.landlordId, co.leaseId, co.tenantId])
    await db.query(
      `INSERT INTO books_opening_items (landlord_id, kind, account_id, amount, as_of) VALUES ($1, 'other', $2, 3000, '2026-10-01'), ($1, 'other', $3, 1200, '2026-10-01')`,
      [co.landlordId, equipment, loan])
    await drain()
    const opening = await activeLines('opening', co.landlordId)
    expect(triples(opening).filter(([r]) => r !== null && r !== 'opening_balance_equity').sort()).toEqual([
      ['bank_checking', 500000, 0], ['security_deposits_payable', 0, 75000],
    ])
    const byAccount = (await db.query<{ code: string; dr: string; cr: string }>(
      `SELECT a.code, round(l.debit * 100)::text AS dr, round(l.credit * 100)::text AS cr
         FROM ledger_postings p JOIN ledger_posting_lines l ON l.posting_id = p.id JOIN books_accounts a ON a.id = l.account_id
        WHERE p.source_type = 'opening' AND p.source_id = $1 AND p.role = 'post' AND p.superseded_at IS NULL AND l.account_role IS NULL
        ORDER BY a.code`, [co.landlordId])).rows
    expect(byAccount).toEqual([{ code: '1531', dr: '300000', cr: '0' }, { code: '2101', dr: '0', cr: '120000' }])
    // Balanced per property: the deposit (property 1) and the company-level items each balance with their own 3900.
    expect(await bal(co.landlordId, 'opening_balance_equity', { propertyId: co.propertyId })).toBe(75000)
    expect(await bal(co.landlordId, 'opening_balance_equity', { propertyId: null })).toBe(-(500000 + 300000 - 120000))
  })
})

describe('J1 (b) / J2: home sales', () => {
  async function contract(co: TenantCo, o: { start: string; activated: string; financed: number; down: number; price: number; unitId?: string }) {
    return inTx(async c => (await c.query<{ id: string }>(
      `INSERT INTO home_sale_contracts (unit_id, tenant_id, landlord_id, sale_price, down_payment, financed_amount, annual_interest_rate,
                                        term_months, monthly_payment, start_month, installments_total, status, activated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 0, 100, 100, $7, 100, 'active', $8) RETURNING id`,
      [o.unitId ?? co.unitId, co.tenantId, co.landlordId, o.price, o.down, o.financed, o.start, o.activated])).rows[0].id)
  }
  async function installment(contractId: string, n: number, month: string, principal: number, interest = 0) {
    return (await db.query<{ id: string }>(
      `INSERT INTO home_sale_installments (contract_id, installment_number, billing_month, amount, principal_portion, interest_portion, remaining_balance)
       VALUES ($1, $2, $3, $4, $5, $6, 0) RETURNING id`, [contractId, n, month, principal + interest, principal, interest])).rows[0].id
  }

  it('TruBlu\'s shape: a sale from before the books opens as the note still owed; nothing is booked as a 2026 sale', async () => {
    const co = await tenantCo({ booksStart: '2026-10-01', homeSale: 'whole_sale_at_signing' })
    const k = await contract(co, { start: '2018-03-01', activated: '2026-09-22T18:00:00Z', financed: 10000, down: 1000, price: 11000 })
    const aug = await installment(k, 1, '2026-08-01', 100)
    const sep = await installment(k, 2, '2026-09-01', 101)
    const oct = await installment(k, 3, '2026-10-01', 102, 20)
    await db.query(`UPDATE home_sale_installments SET settled_off_platform_at = now() WHERE id = ANY($1::uuid[])`, [[aug, sep]])
    const row = await bill(co, { type: 'home_payment', amount: 122, due: '2026-10-01', homeSaleInstallmentId: oct })
    await db.query(`UPDATE home_sale_installments SET payment_id = $1 WHERE id = $2`, [row, oct])
    await drain()
    expect(await activeLines('home_sale', k)).toEqual([])
    expect(await activeLines('home_installment', aug)).toEqual([])   // before the start: in the opening note
    const opening = await activeLines('opening', co.landlordId)
    expect(triples(opening)).toEqual([['home_notes_receivable', 979900, 0], ['opening_balance_equity', 0, 979900]])
    expect(triples(await activeLines('payment', row))).toEqual([['ar_tenants', 12200, 0], ['home_notes_receivable', 0, 10200], ['home_note_interest', 0, 2000]])
    expect(await bal(co.landlordId, 'home_notes_receivable')).toBe(1000000 - 10000 - 10100 - 10200)   // financed less every principal
    expect(await bal(co.landlordId, 'home_sales')).toBe(0)
  })

  it('a new sale: the whole sale when it went active; taken back when cancelled (the home returns to the books)', async () => {
    const co = await tenantCo({ booksStart: '2026-10-01', homeSale: 'whole_sale_at_signing' })
    const k = await contract(co, { start: '2026-11-01', activated: '2026-10-15T18:00:00Z', financed: 8250, down: 750, price: 9000 })
    const nov = await installment(k, 1, '2026-11-01', 150)
    const row = await bill(co, { type: 'home_payment', amount: 150, due: '2026-11-01', homeSaleInstallmentId: nov })
    await db.query(`UPDATE home_sale_installments SET payment_id = $1 WHERE id = $2`, [row, nov])
    await drain()
    const sale = await activeLines('home_sale', k)
    expect(sale.every(l => l.day === '2026-10-15' && l.kind === 'main')).toBe(true)
    expect(triples(sale)).toEqual([
      ['home_notes_receivable', 825000, 0], ['suspense', 75000, 0], ['home_sales', 0, 825000], ['home_sales', 0, 75000],
    ])
    expect(sale.filter(l => l.cash === 'in').map(l => l.dr - l.cr)).toEqual([-75000])
    await db.query(`UPDATE home_sale_contracts SET status = 'cancelled', cancelled_at = '2026-11-20T18:00:00Z' WHERE id = $1`, [k])
    await drain()
    expect(triples(await activeLines('home_sale', k), 'cancellation')).toEqual([['homes_held_for_sale', 810000, 0], ['home_notes_receivable', 0, 810000]])
    expect(await bal(co.landlordId, 'home_notes_receivable')).toBe(0)
  })

  it('income as paid: no note; only the down payment is income when the sale goes active', async () => {
    const co = await tenantCo({ booksStart: '2026-10-01', homeSale: 'income_as_paid' })
    const old = await contract(co, { start: '2019-01-01', activated: '2026-09-22T18:00:00Z', financed: 5000, down: 500, price: 5500 })
    const second = await addLease(co)
    const k = await contract(co, { start: '2026-11-01', activated: '2026-10-15T18:00:00Z', financed: 8250, down: 750, price: 9000,
      unitId: second.unitId })
    await drain()
    expect(await activeLines('home_sale', old)).toEqual([])
    expect(triples(await activeLines('home_sale', k))).toEqual([['suspense', 75000, 0], ['home_sales', 0, 75000]])
    expect(await bal(co.landlordId, 'home_notes_receivable')).toBe(0)
    expect(await activeLines('opening', co.landlordId)).toEqual([])
  })

  it('not chosen yet: the sale and the opening wait on the owner', async () => {
    const co = await tenantCo({ booksStart: '2026-10-01' })
    const k = await contract(co, { start: '2018-03-01', activated: '2026-09-22T18:00:00Z', financed: 10000, down: 1000, price: 11000 })
    await drain()
    const errs = (await db.query<{ source_type: string; reason_code: string }>(
      `SELECT source_type, reason_code FROM ledger_source_errors WHERE owner_id = $1 ORDER BY source_type`, [co.landlordId])).rows
    expect(errs).toEqual([{ source_type: 'home_sale', reason_code: 'owner_not_ready' }, { source_type: 'opening', reason_code: 'owner_not_ready' }])
    expect(k).toBeTruthy()
    // No admin notice for a source waiting on its owner, however many tries.
    await db.query(`UPDATE ledger_source_errors SET attempts = 9, next_try_at = now() WHERE owner_id = $1`, [co.landlordId])
    await drain()
    expect((await db.query(`SELECT 1 FROM admin_notifications WHERE category = 'books_ledger'`)).rows).toEqual([])
    // The nightly check counts them as pending (waiting on the owner), never as drift to re-post.
    const res = await checkOwner({ landlordId: co.landlordId })
    expect(res.findings.filter(f => f.severity === 'drift' || f.severity === 'integrity')).toEqual([])
    expect(res.findings.filter(f => f.check === 'source_drift').map(f => (f.detail as any).status).sort())
      .toEqual(['waiting_on_owner', 'waiting_on_owner'])
    expect(res.repaired).toBe(0)
  })
})

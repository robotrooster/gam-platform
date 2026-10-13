/**
 * 10/12 (Nic) — GAM BOOKS, PHASE P7: EXTRA WORK-TRADE HOURS SENT TO GAM BOOKS AS A CONTRACTOR PAYMENT
 * (gam-ledger-design-2026-10-12 §6 I6; Nic 10/12 L5, "VENDORS")
 *
 *   Nic, 10/12: paid extra work-trade hours are wages the landlord pays a
 *   person, "Both" ways — by hand (Mark paid on the Work Trade page) or by
 *   pressing Send to GAM Books, where they become payroll (W-2) or a
 *   contractor payment (1099). Money out is ONE record (L5): a contractor
 *   payment is an unpaid expense on the Expenses record, to the vendor who is
 *   this work trader — VENDORS is "one list of everyone the company pays",
 *   and a contractor's payments add up per calendar year for the 1099.
 *
 * A record sent as W-2 pay goes on a payroll run (routes/books.ts POST
 * /payroll/runs extraHours). A record sent as a contractor payment becomes,
 * when the landlord confirms it on the Run Payroll page, an unpaid expense in
 * the "Contractor payments" category, due that day, naming the vendor and the
 * record (landlord_expenses.vendor_id, work_trade_extra_hours_id — the
 * Expenses lane's columns). The record keeps "Sent to GAM Books" and names
 * the expense (books_reference_id). Paying the expense — a bank line matched
 * to it, or a payment recorded on it — pays the record (the Expenses lane
 * marks it paid with paid_how 'gam_books'). If the expense is voided instead,
 * the record is waiting for GAM Books again and can be confirmed afresh.
 *
 * The vendor: the one the landlord picks, or — when they pick none — the
 * contractor vendor who is this tenant (getOrCreateContractorVendorForTenant,
 * the vendor list's own helper: the same person is one vendor, found again the
 * next month rather than added twice).
 */
import type { PoolClient } from 'pg'
import { AppError } from '../middleware/errorHandler'
import { todayIn } from '../lib/timezone'
import { createMoneyOutExpense, createLandlordExpense } from './landlordExpenses'
import { getOrCreateContractorVendorForTenant } from './booksVendorsLoans'
import { ensureCategories } from './booksCategories'

/**
 * A record sent to GAM Books is waiting for Books while it names nothing, or
 * names a contractor expense that has since been voided. SQL over `x`
 * (work_trade_extra_hours).
 */
export const EXTRA_HOURS_WAITING_FOR_BOOKS_SQL = `(x.status = 'sent_to_books' AND (x.books_reference_id IS NULL OR EXISTS (
  SELECT 1 FROM landlord_expenses le
   WHERE le.id = x.books_reference_id AND (le.status <> 'active' OR le.voided_at IS NOT NULL))))`

/** A record of extra hours on a payroll run that is not voided (W-2). SQL over `x`. */
export const EXTRA_HOURS_ON_LIVE_RUN_SQL = `EXISTS (
  SELECT 1 FROM payroll_run_lines l JOIN payroll_runs r ON r.id = l.run_id
   WHERE l.work_trade_extra_hours_id = x.id AND r.status IN ('draft', 'approved'))`

export interface WorkTradeContractorPayment {
  expenseId: string
  vendorId: string
  vendorName: string
  amount: number
}

/**
 * Turns a record of extra hours sent to GAM Books as a contractor payment
 * (1099) into an unpaid contractor expense, in `client`'s transaction. The
 * record is locked while it is checked: it must be this company's, sent as a
 * contractor payment, and still waiting for Books (not paid, not already an
 * expense that is live).
 */
export async function recordWorkTradeContractorPayment(client: PoolClient, args: {
  landlordId: string; extraHoursId: string; vendorId?: string | null; createdBy: string | null
}): Promise<WorkTradeContractorPayment> {
  const { rows: [x] } = await client.query<any>(
    `SELECT x.*, to_char(x.period_month, 'YYYY-MM') AS period_ym,
            ${EXTRA_HOURS_ON_LIVE_RUN_SQL} AS on_run, ${EXTRA_HOURS_WAITING_FOR_BOOKS_SQL} AS waiting
       FROM work_trade_extra_hours x
      WHERE x.id = $1 AND x.landlord_id = $2 FOR UPDATE OF x`, [args.extraHoursId, args.landlordId])
  if (!x) throw new AppError(404, 'Those work-trade extra hours are not this company\'s.')
  if (x.status === 'paid') throw new AppError(409, 'These extra hours are already paid.')
  if (!x.waiting || x.on_run) throw new AppError(409, 'These extra hours are not waiting for GAM Books.')
  if (x.pay_method !== 'contractor_1099') {
    throw new AppError(409, 'These extra hours were sent as payroll (W-2). Put them on a payroll run.')
  }
  const vendorId = args.vendorId
    ?? (await getOrCreateContractorVendorForTenant(client, { landlordId: args.landlordId, tenantId: x.tenant_id })).id
  const { rows: [v] } = await client.query<{ id: string; name: string }>(
    `SELECT id, name FROM books_vendors WHERE id = $1 AND landlord_id = $2 AND status = 'active'`, [vendorId, args.landlordId])
  if (!v) throw new AppError(404, 'That vendor is not one of this company\'s.')

  const today = todayIn(null)
  const amount = +(+x.amount).toFixed(2)
  // Who was paid and which hours it pays, on the expense itself (the vendor's
  // 1099 total adds up its payments by calendar year).
  const { id: expenseId } = await createMoneyOutExpense(client, {
    landlordId: args.landlordId, categoryKey: 'contractor_payments', amount, expenseDate: today, dueDate: today,
    description: `Work-trade extra hours, ${x.period_ym}: ${v.name}`, createdBy: args.createdBy,
    vendorId: v.id, workTradeExtraHoursId: x.id,
  })
  await client.query(
    `UPDATE work_trade_extra_hours SET books_reference_id = $2, updated_at = NOW() WHERE id = $1`, [x.id, expenseId])
  return { expenseId, vendorId: v.id, vendorName: v.name, amount }
}

// ─────────────────────────────────────────────────────────────────────────────
// 10/12 (Nic) — EXTRA HOURS PAID BY HAND ARE MONEY OUT TOO
//
//   Paid extra hours are paid "Both" ways: by hand (Mark paid on the Work
//   Trade page — a check or cash, on a day) or through GAM Books. Money out is
//   ONE record (L5): every dollar out is an Expense. Until 10/12 Mark paid
//   wrote nothing to the Expenses record, so hours paid by hand never reached
//   the books or the P&L (LEDGER_SOURCE_TYPES_NOT_POSTED_YET said so).
//
// Mark paid now records ONE PAID expense, in the same transaction as the
// record turning 'paid':
//   - under the company's "Work trade labor" category (GAM's starting
//     category, migration 20261014240100 — the chart's Work-trade labor
//     account; a category the company itself named "Work trade labor" when
//     that name was taken before GAM's arrived);
//   - paid in full on the day it was paid, by the check or cash it was paid
//     with (a check clears against its bank line on the Bank page);
//   - to the contractor vendor who is this work trader when the agreement pays
//     them as a 1099 contractor (getOrCreateContractorVendorForTenant: one
//     vendor per person, their 1099 total adds up every payment); a plain
//     expense naming them in its words when they are W-2 wages paid outside
//     payroll;
//   - on the agreement's property (common, split across its spaces) while the
//     company still owns it, else at company level.
// The expense names the hours (work_trade_extra_hours_id) and the hours name
// the expense (books_reference_id). Removing the expense on the Expenses page
// puts the hours back to owed (services/landlordExpenses voidLandlordExpense);
// its payment is never taken back alone (the hours would say paid with nothing
// paid behind them).
// ─────────────────────────────────────────────────────────────────────────────

export interface WorkTradeHoursPaidByHand {
  expenseId: string
  /** The contractor vendor (1099); null for W-2 wages paid outside payroll. */
  vendorId: string | null
  amount: number
}

/**
 * Records extra hours just marked paid by hand as one PAID expense, in
 * `client`'s transaction (see above). The record must already say 'paid' with
 * paid_how check or cash — the caller's own UPDATE, under its row lock — so the
 * expense-payment trigger (20261014200420, Books-paid hours only) never takes
 * it for a GAM Books payment.
 */
export async function recordWorkTradeHoursPaidByHand(client: PoolClient, args: {
  extraHoursId: string; createdBy: string | null
}): Promise<WorkTradeHoursPaidByHand> {
  const { rows: [x] } = await client.query<{
    id: string; landlord_id: string; tenant_id: string; amount: string; pay_method: string
    status: string; paid_how: string | null; paid_on: string | null; paid_note: string | null; period_ym: string
    property_id: string | null; who: string | null
  }>(
    `SELECT x.id, x.landlord_id, x.tenant_id, x.amount::text AS amount, x.pay_method, x.status, x.paid_how,
            to_char(x.paid_on, 'YYYY-MM-DD') AS paid_on, x.paid_note, to_char(x.period_month, 'YYYY-MM') AS period_ym,
            (SELECT p.id FROM properties p WHERE p.id = un.property_id AND p.landlord_id = x.landlord_id) AS property_id,
            NULLIF(btrim(concat_ws(' ', u.first_name, u.last_name)), '') AS who
       FROM work_trade_extra_hours x
       JOIN work_trade_agreements wta ON wta.id = x.agreement_id
       JOIN units un ON un.id = wta.unit_id
       JOIN tenants t ON t.id = x.tenant_id
       JOIN users u ON u.id = t.user_id
      WHERE x.id = $1
      FOR UPDATE OF x`, [args.extraHoursId])
  if (!x) throw new AppError(404, 'Extra hours not found')
  if (x.status !== 'paid' || (x.paid_how !== 'check' && x.paid_how !== 'cash') || !x.paid_on) {
    throw new AppError(409, 'These extra hours are not marked paid by hand.')
  }
  const amount = +(+x.amount).toFixed(2)
  if (!(amount > 0)) throw new AppError(409, 'These extra hours come to nothing to pay.')
  const contractor = x.pay_method === 'contractor_1099'
  const vendor = contractor
    ? await getOrCreateContractorVendorForTenant(client, { landlordId: x.landlord_id, tenantId: x.tenant_id })
    : null
  // GAM's starting "Work trade labor" category (seeded on first use), or the
  // company's own of that name when it had taken the name first.
  await ensureCategories(client, x.landlord_id)
  const cat = (await client.query<{ id: string }>(
    `SELECT id FROM books_categories
      WHERE landlord_id = $1 AND direction = 'expense'
        AND (system_key = 'work_trade_labor'
             OR (system_key IS NULL AND archived_at IS NULL AND lower(btrim(name)) = 'work trade labor'))
      ORDER BY (system_key IS NOT NULL) DESC, created_at
      LIMIT 1`, [x.landlord_id])).rows[0]
  const who = vendor?.name ?? x.who ?? 'Work trader'
  const row = await createLandlordExpense({
    landlordId: x.landlord_id, createdBy: args.createdBy,
    categoryId: cat?.id ?? null, category: cat ? null : 'work_trade_labor',
    // The bill an archived starting category still files (as GAM's other bills do).
    allowArchivedCategory: true,
    amount, expenseDate: x.paid_on,
    description: `Work-trade extra hours, ${x.period_ym}: ${who}`
      + (contractor ? ' (contractor, 1099)' : ' (wages paid outside payroll)'),
    vendorId: vendor?.id ?? null,
    propertyId: x.property_id, isCommon: !!x.property_id,
    workTradeExtraHoursId: x.id,
    payment: { method: x.paid_how, paidOn: x.paid_on, memo: x.paid_note },
  }, client)
  await client.query(
    `UPDATE work_trade_extra_hours SET books_reference_id = $2, updated_at = NOW() WHERE id = $1`, [x.id, row.id])
  return { expenseId: row.id, vendorId: vendor?.id ?? null, amount }
}

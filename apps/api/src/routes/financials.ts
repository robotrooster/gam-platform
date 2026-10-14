/**
 * 10/11 (Nic) — THE SHARED FINANCIAL PAGES' OWN API.
 *
 * The financial pages are one set of files kept byte-identical in the landlord
 * portal and GAM Books (apps/{landlord,books}/src/financials, held together by
 * financials-parity.test.ts). The owner and their bookkeeper read them through
 * these routes, scoped by lib/financialsScope — so the same page shows each of
 * them exactly their own companies and properties.
 *
 * Read only. Money in is added up by type (services/incomePools), maintenance
 * is its cost lines (never the request, its photos or who asked), the bank is
 * its transactions, and payouts are amounts and banks (never the recipient's
 * name). 10/11 (Nic): a name is fine where the books need it — the bank memo
 * names who paid or was paid, and a bookkeeper reconciles from it — but
 * contact details are not: an email or phone number on a memo is taken out
 * before a bookkeeper reads it.
 */
import { Router } from 'express'
import { z } from 'zod'
import {
  MAINTENANCE_CATEGORY_LABEL, BANK_TXN_STATUS_LABEL, BANK_MATCH_KIND_LABEL, BANK_TXN_HIDDEN_REASONS,
  EXPENSE_CATEGORY_LABEL, OTHER_INCOME_CATEGORY_LABEL, DISBURSEMENT_STATUS_LABEL, DISBURSEMENT_TRIGGER_LABEL,
  LANDLORD_GAM_CHARGE_KIND_LABEL, BANK_LINE_MATCH_KIND_LABEL, type BankLineMatchKind,
  type MaintenanceCategory, type BankTxnStatus, type BankMatchKind, type ExpenseCategory,
  type OtherIncomeCategory, type DisbursementStatus, type LandlordGamChargeKind,
} from '@gam/shared'
import { query, queryOne } from '../db'
import { requireAuth } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { todayIn } from '../lib/timezone'
import { financialsScope, scopeProperties, refuseWithoutCompanyWide } from '../lib/financialsScope'
import { cutoffsParam, withinCutoffsSql, pastCutoff, bookkeeperMayWrite } from '../lib/bookkeeperScope'
import { incomePools } from '../services/incomePools'

export const financialsRouter = Router()
financialsRouter.use(requireAuth)

const DAY = /^\d{4}-\d{2}-\d{2}$/
const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * `?from=&to=` (days, inclusive). Default: the first of this month through
 * today, on GAM's home calendar (Phoenix — the reports' calendar). At most
 * three years at a time, so a day-by-day answer stays a page, not a dump.
 */
function period(q: any): { start: string; end: string } {
  const p = z.object({
    from: z.string().regex(DAY).optional(),
    to:   z.string().regex(DAY).optional(),
  }).parse(q ?? {})
  const today = todayIn(null)
  const start = p.from ?? `${today.slice(0, 7)}-01`
  const end = p.to ?? today
  if (end < start) throw new AppError(400, 'The end date is before the start date.')
  const days = (Date.parse(end) - Date.parse(start)) / 86_400_000
  if (days > 3 * 366) throw new AppError(400, 'Choose three years or less at a time.')
  return { start, end }
}

// GET /api/financials/scope — who is looking, and which properties they keep.
financialsRouter.get('/scope', async (req: any, res, next) => {
  try {
    const scope = await financialsScope(req)
    const properties = await scopeProperties(scope)
    const companies = await query<{ id: string; business_name: string | null }>(
      `SELECT id, business_name FROM landlords WHERE id = ANY($1::uuid[]) ORDER BY business_name NULLS LAST, id`,
      [scope.landlordIds])
    res.json({ success: true, data: {
      viewer: scope.viewer,
      // 10/12 (Nic, ledger decision 2): one level — the owner and every
      // bookkeeper remove expenses (each row's canRemove says which ones).
      canRemoveExpenses: true,
      // 10/12 (Nic): the company-wide box — the bank account, payouts and
      // payroll, and the company's Books ledger and reports. Its own box, never
      // inferred from the property boxes.
      companyWide: scope.companyWide,
      // 10/12 (Nic, BK1): the whole-company Books ledger (the company-wide box
      // or the ledger box); the monthly property report on screen. The menus
      // and the Reports page read them; the server refuses either without.
      ledger: scope.ledger,
      seesMonthlyReport: scope.seesMonthlyReport,
      companies: companies.map(c => ({ id: c.id, name: c.business_name || 'Unnamed company' })),
      properties,
    } })
  } catch (e) { next(e) }
})

// GET /api/financials/units?propertyId= — the units an expense can be filed on.
// Unit numbers only: no tenant, no lease, no status.
financialsRouter.get('/units', async (req: any, res, next) => {
  try {
    const scope = await financialsScope(req)
    const rows = await query<{ id: string; unit_number: string; property_id: string }>(
      `SELECT u.id, u.unit_number, u.property_id
         FROM units u
        WHERE u.landlord_id = ANY($1::uuid[])
          AND ($2::uuid[] IS NULL OR u.property_id = ANY($2::uuid[]))
          AND u.retired_at IS NULL
        ORDER BY u.unit_number`, [scope.landlordIds, scope.propertyIds])
    res.json({ success: true, data: rows.map(r => ({ id: r.id, unitNumber: r.unit_number, propertyId: r.property_id })) })
  } catch (e) { next(e) }
})

// GET /api/financials/income?from=&to=&propertyId= — money in, by type, by
// month and by day (services/incomePools).
financialsRouter.get('/income', async (req: any, res, next) => {
  try {
    const scope = await financialsScope(req)
    const { start, end } = period(req.query)
    res.json({ success: true, data: await incomePools({
      landlordIds: scope.landlordIds, propertyIds: scope.propertyIds, start, end,
      // 10/12: a former property's money stops at the day it left.
      cutoffs: scope.cutoffs,
    }) })
  } catch (e) { next(e) }
})

// GET /api/financials/maintenance-costs?from=&to=&propertyId= — what repairs
// cost. The P&L's own definition (services/landlordPL landlordPLExpenses):
// completed repairs with a cost, by the day they were completed. Never the
// request's wording, photos, comments or who reported it.
financialsRouter.get('/maintenance-costs', async (req: any, res, next) => {
  try {
    const scope = await financialsScope(req)
    const { start, end } = period(req.query)
    const rows = await query<any>(
      `SELECT mr.id, mr.category, mr.actual_cost::float AS amount,
              to_char((mr.completed_at AT TIME ZONE COALESCE(p.timezone, 'America/Phoenix'))::date, 'YYYY-MM-DD') AS day,
              u.unit_number, p.id AS property_id, p.name AS property_name,
              -- 10/12 (Nic, L6): the repair's bill on Expenses, and the company's choice.
              bill.id AS bill_id, bill.pay_state AS bill_pay_state, l.books_repair_bills AS repair_bill_mode
         FROM maintenance_requests mr
         JOIN landlords l       ON l.id = mr.landlord_id
         LEFT JOIN units u      ON u.id = mr.unit_id
         LEFT JOIN properties p ON p.id = u.property_id
         LEFT JOIN LATERAL (
           SELECT e.id, b.pay_state FROM landlord_expenses e JOIN v_expense_balance b ON b.expense_id = e.id
            WHERE e.maintenance_request_id = mr.id AND e.status = 'active' LIMIT 1
         ) bill ON TRUE
        WHERE mr.landlord_id = ANY($1::uuid[])
          AND mr.actual_cost IS NOT NULL
          AND mr.completed_at >= $2 AND mr.completed_at < ($3::date + 1)
          AND ($4::uuid[] IS NULL OR u.property_id = ANY($4::uuid[]))
          -- 10/12 (Nic): a former property's repairs up to the day it left.
          AND ${withinCutoffsSql('u.property_id', "(mr.completed_at AT TIME ZONE COALESCE(p.timezone, 'America/Phoenix'))::date", '$5')}
        ORDER BY mr.completed_at DESC, mr.id`,
      [scope.landlordIds, start, end, scope.propertyIds, cutoffsParam(scope.cutoffs)])
    const lines = rows.map((r: any) => ({
      id: r.id,
      day: r.day,
      category: r.category,
      categoryLabel: MAINTENANCE_CATEGORY_LABEL[r.category as MaintenanceCategory] ?? 'General / Other',
      amount: round2(r.amount),
      unitNumber: r.unit_number ?? null,
      propertyId: r.property_id ?? null,
      propertyName: r.property_name ?? null,
      // 10/12 (Nic, L6): its bill on Expenses (paid or not), and whether
      // "Record as bill" is offered (the company did not choose 'automatic').
      billId: r.bill_id ?? null,
      billPayState: r.bill_pay_state ?? null,
      // 10/12 (Nic, ledger decision 2): every bookkeeper the company keeps (one level).
      canRecordBill: !r.bill_id && r.repair_bill_mode !== 'automatic'
        && (scope.viewer !== 'bookkeeper' || bookkeeperMayWrite(req.user?.bookkeeperScope)),
    }))
    const byCategory = new Map<string, { category: string; label: string; amount: number; count: number }>()
    for (const l of lines) {
      const c = byCategory.get(l.category) ?? { category: l.category, label: l.categoryLabel, amount: 0, count: 0 }
      c.amount = round2(c.amount + l.amount); c.count += 1
      byCategory.set(l.category, c)
    }
    res.json({ success: true, data: {
      period: { start, end },
      lines,
      byCategory: [...byCategory.values()].sort((a, b) => b.amount - a.amount),
      total: round2(lines.reduce((s, l) => s + l.amount, 0)),
    } })
  } catch (e) { next(e) }
})

/** The newest bank lines a page lists; the totals always cover every line in the days asked. */
const BANK_ROWS_SHOWN = 1000

// 10/11 (Nic): names are fine for a bookkeeper, contact details are not. A bank
// memo can carry the email or phone number a Zelle payment went to or came
// from ("ZELLE FROM JANE DOE 4805551234"); a bookkeeper's copy of the memo has
// those taken out, and keeps everything else on it.
//
// Banks cut a memo off at a fixed length, so an email often arrives with no
// ending left ("JANEDOE@GMAI"): any word with an @ in it is hidden. A phone
// number can sit right against letters ("JANEDOE4805551234"), so the number's
// edges are checked against digits only.
const EMAIL_IN_MEMO = /[A-Z0-9._%+-]+@[A-Z0-9.-]*/gi
const PHONE_IN_MEMO = /(?<!\d)(?:\+?1[\s.-]?)?(?:\(\s*[2-9]\d{2}\s*\)|[2-9]\d{2})[\s.-]?[2-9]\d{2}[\s.-]?\d{4}(?!\d)/gi
export function memoWithoutContact(memo: string): string {
  return memo.replace(EMAIL_IN_MEMO, '(email hidden)').replace(PHONE_IN_MEMO, '(phone hidden)')
}

// GET /api/financials/bank-activity?from=&to= — the company's bank account, as
// the bank feed has it. Read only. 10/11 (Nic): the owner and the bookkeeper
// read the same line — the bank's memo (or the merchant the feed made of it),
// which is how a bank line is reconciled ("who was this?"), and what it was
// filed as, in its own column. A bookkeeper's memo loses any email or phone
// number on it (memoWithoutContact). Money in and money out add up EVERY line
// in the days asked; the list is the newest BANK_ROWS_SHOWN of them.
financialsRouter.get('/bank-activity', async (req: any, res, next) => {
  try {
    const scope = await financialsScope(req)
    refuseWithoutCompanyWide(scope, 'The bank account')
    const { start, end } = period(req.query)
    // One FROM and WHERE for the list and its totals, so they read the same lines.
    const from = `
         FROM bank_transactions bt
         JOIN bank_connections c ON c.id = bt.bank_connection_id
         JOIN landlords l        ON l.id = bt.landlord_id
         LEFT JOIN landlord_expenses e      ON e.id = bt.expense_id AND e.status = 'active'
         LEFT JOIN landlord_other_income oi ON oi.id = bt.landlord_other_income_id AND oi.status = 'active'
         -- 10/12 review (Nic L5): the company's own category, by its name.
         LEFT JOIN books_categories ec      ON ec.id = e.category_id
         LEFT JOIN books_categories ic      ON ic.id = oi.category_id
        WHERE bt.landlord_id = ANY($1::uuid[])
          AND NOT (COALESCE(bt.ignored_reason, '') = ANY($2::text[]))
          AND bt.posted_date BETWEEN $3::date AND $4::date`
    const params = [scope.landlordIds, [...BANK_TXN_HIDDEN_REASONS], start, end]
    const [totals, rows] = await Promise.all([
      queryOne<{ n: number; money_in: string; money_out: string }>(
        `SELECT COUNT(*)::int AS n,
                COALESCE(SUM(bt.amount) FILTER (WHERE bt.amount > 0), 0)::text AS money_in,
                COALESCE(-SUM(bt.amount) FILTER (WHERE bt.amount <= 0), 0)::text AS money_out
         ${from}`, params),
      query<any>(
        `SELECT bt.id, to_char(bt.posted_date, 'YYYY-MM-DD') AS posted_date, bt.amount::float AS amount,
              bt.description, bt.normalized_merchant, bt.status, bt.landlord_id,
              CASE WHEN bt.auto_filed_rule_id IS NOT NULL AND bt.status = 'categorized' THEN 'auto_filed'
                   WHEN bt.status <> 'matched' THEN NULL
                   WHEN bt.matched_disbursement_id IS NOT NULL THEN 'gam_payout'
                   WHEN bt.matched_payment_id IS NOT NULL THEN 'tenant_deposit'
                   WHEN bt.auto_settle_undo->>'kind' = 'deposit_slip' THEN 'deposit_slip'
                   -- 10/14 (Nic, answer 15): a check the bank returned, taken back (services/returnedCheck).
                   WHEN bt.auto_settle_undo->>'kind' = 'returned_check' THEN 'returned_check'
              END AS match_kind,
              -- 10/12 review (Nic L5): a money-out line matched to bills, GAM's
              -- fee debit, a refund, a transfer or a loan (BANK_LINE_MATCH_KINDS).
              CASE WHEN bt.status = 'matched' THEN bt.matched_kind END AS line_match_kind,
              e.category AS expense_category, oi.category AS income_category,
              ec.name AS expense_category_name, ic.name AS income_category_name,
              -- 10/12 (Nic): a line split into parts on the Bank page, each its own category.
              (SELECT json_agg(json_build_object('category', x.category, 'name', x.name, 'amount', x.amount::float)
                                ORDER BY x.amount DESC, x.category)
                 FROM (SELECT o.category, c.name, o.amount FROM landlord_other_income o
                         LEFT JOIN books_categories c ON c.id = o.category_id
                        WHERE o.bank_transaction_id = bt.id AND o.status = 'active'
                       UNION ALL
                       SELECT x2.category, c.name, x2.amount FROM landlord_expenses x2
                         LEFT JOIN books_categories c ON c.id = x2.category_id
                        WHERE x2.bank_transaction_id = bt.id AND x2.status = 'active') x
                WHERE bt.status = 'categorized' AND bt.landlord_other_income_id IS NULL AND bt.expense_id IS NULL
              ) AS split_parts,
              c.display_name AS account_name, l.business_name AS company_name
       ${from}
        ORDER BY bt.posted_date DESC, bt.created_at DESC, bt.id
        LIMIT ${BANK_ROWS_SHOWN}`, params),
    ])
    const bookkeeper = scope.viewer === 'bookkeeper'
    // 10/12 (Nic): a split line says each part's category and amount.
    // 10/12 review (Nic L5): a category the company made says its own name
    // (the old word column reads 'other' for it).
    const partLabel = (moneyIn: boolean, p: { category: string; name?: string | null; amount: number }) =>
      `${p.name || (moneyIn
        ? (OTHER_INCOME_CATEGORY_LABEL[p.category as OtherIncomeCategory] ?? 'Other income')
        : (EXPENSE_CATEGORY_LABEL[p.category as ExpenseCategory] ?? 'Other'))} $${Number(p.amount).toFixed(2)}`
    const filedAs = (r: any): string | null =>
      r.expense_category ? (r.expense_category_name || EXPENSE_CATEGORY_LABEL[r.expense_category as ExpenseCategory] || 'Other')
      : r.income_category ? (r.income_category_name || OTHER_INCOME_CATEGORY_LABEL[r.income_category as OtherIncomeCategory] || 'Other income')
      : Array.isArray(r.split_parts) && r.split_parts.length
        ? `Split: ${r.split_parts.map((p: any) => partLabel(r.amount > 0, p)).join(', ')}`
      : r.match_kind ? BANK_MATCH_KIND_LABEL[r.match_kind as BankMatchKind]
      : r.line_match_kind ? (BANK_LINE_MATCH_KIND_LABEL[r.line_match_kind as BankLineMatchKind] ?? null)
      : null
    const out = rows.map((r: any) => {
      const moneyIn = r.amount > 0
      const memo: string | null = r.description || r.normalized_merchant || null
      return {
        id: r.id,
        day: r.posted_date,
        amount: round2(r.amount),
        direction: moneyIn ? 'in' : 'out',
        description: memo
          ? (bookkeeper ? memoWithoutContact(memo) : memo)
          : (moneyIn ? 'Money in' : 'Money out'),
        filedAs: filedAs(r),
        statusLabel: BANK_TXN_STATUS_LABEL[r.status as BankTxnStatus] ?? 'Not filed yet',
        accountName: r.account_name ?? null,
        companyName: r.company_name ?? null,
      }
    })
    res.json({ success: true, data: {
      period: { start, end },
      transactions: out,
      // Every line in the days asked, not just the ones listed.
      transactionCount: totals?.n ?? out.length,
      moneyIn: round2(Number(totals?.money_in ?? 0)),
      moneyOut: round2(Number(totals?.money_out ?? 0)),
    } })
  } catch (e) { next(e) }
})

/** The newest payouts and GAM charges a page lists; the totals always cover every one. */
const PAYOUT_ROWS_SHOWN = 200

// GET /api/financials/payouts — what GAM sent the company and what GAM charged
// it. Amounts, dates, banks; never who the payout was addressed to. The totals
// (paid out, on its way, GAM charges not yet taken) add up every payout and
// every charge, all time; the lists are the newest PAYOUT_ROWS_SHOWN. 10/11: a
// GAM charge older than the newest 200 that is still unpaid stays in "not yet
// taken".
financialsRouter.get('/payouts', async (req: any, res, next) => {
  try {
    const scope = await financialsScope(req)
    refuseWithoutCompanyWide(scope, 'Payouts')
    // A payout names its company; an older one names only the account it was
    // paid to, and counts here only when that account owns no other company
    // (otherwise it blended companies and cannot be told apart).
    const payoutWhere = `
        WHERE d.landlord_id = ANY($1::uuid[])
           OR (d.landlord_id IS NULL
               AND d.user_id IN (SELECT user_id FROM landlords WHERE id = ANY($1::uuid[]))
               AND NOT EXISTS (SELECT 1 FROM landlords o
                                WHERE o.user_id = d.user_id AND NOT (o.id = ANY($1::uuid[]))))`
    const [payoutTotals, chargeTotals, payouts, charges] = await Promise.all([
      queryOne<{ settled: string; on_the_way: string; payout_count: string }>(
        `SELECT COALESCE(SUM(d.amount) FILTER (WHERE d.status = 'settled'), 0)::text AS settled,
                COALESCE(SUM(d.amount) FILTER (WHERE d.status IN ('pending', 'processing')), 0)::text AS on_the_way,
                COUNT(*)::text AS payout_count
           FROM disbursements d
         ${payoutWhere}`, [scope.landlordIds]),
      queryOne<{ outstanding: string }>(
        `SELECT COALESCE(SUM(c.amount - c.collected_amount), 0)::text AS outstanding
           FROM landlord_gam_charges c
          WHERE c.landlord_id = ANY($1::uuid[])
            -- 10/12: a voided charge (taken back, kept on file) is owed by nobody.
            AND c.voided_at IS NULL`, [scope.landlordIds]),
      query<any>(
        `SELECT d.id, d.amount::float AS amount, d.fee_charged::float AS fee_charged, d.status, d.trigger_type,
              d.created_at, d.settled_at, d.bank_name, d.bank_last4,
              ba.nickname AS bank_nickname, ba.account_number_last4 AS account_last4,
              COALESCE(ll.business_name, own.business_names) AS company_name
         FROM disbursements d
         LEFT JOIN landlords ll ON ll.id = d.landlord_id
         LEFT JOIN user_bank_accounts ba ON ba.id = d.bank_account_id
         -- 10/12 (Nic, G2): a payout no one company is stamped on came from a
         -- Stripe account several companies share (connectPayoutSync
         -- SOLE_COMPANY_ON_ACCOUNT_SQL) — or, before 10/5, from a login's
         -- account. It is labeled with EVERY company paid through that
         -- account, never the first one created (the S652 pattern,
         -- routes/disbursements companies_on_account): naming one would say
         -- the money was that company's alone.
         LEFT JOIN LATERAL (
           SELECT string_agg(x.business_name, ' + ' ORDER BY x.business_name) AS business_names
             FROM landlords x
             JOIN users xu ON xu.id = x.user_id
            WHERE CASE WHEN d.stripe_account_id IS NOT NULL
                       THEN COALESCE(x.stripe_connect_account_id, xu.stripe_connect_account_id) = d.stripe_account_id
                       ELSE x.user_id = d.user_id END
         ) own ON d.landlord_id IS NULL
       ${payoutWhere}
        ORDER BY d.created_at DESC, d.id
        LIMIT ${PAYOUT_ROWS_SHOWN}`, [scope.landlordIds]),
      query<any>(
        `SELECT c.id, c.kind, c.amount::float AS amount, c.collected_amount::float AS collected_amount,
              c.collected_at, c.created_at, p.name AS property_name, l.business_name AS company_name,
              c.property_id, p.landlord_id AS property_company_id,
              to_char((c.created_at AT TIME ZONE COALESCE(p.timezone, 'America/Phoenix'))::date, 'YYYY-MM-DD') AS charge_day
         FROM landlord_gam_charges c
         LEFT JOIN properties p ON p.id = c.property_id
         LEFT JOIN landlords  l ON l.id = c.landlord_id
        WHERE c.landlord_id = ANY($1::uuid[]) AND c.voided_at IS NULL
        ORDER BY c.created_at DESC, c.id
        LIMIT ${PAYOUT_ROWS_SHOWN}`, [scope.landlordIds]),
    ])
    const payoutRows = payouts.map((d: any) => ({
      id: d.id,
      createdAt: d.created_at,
      settledAt: d.settled_at,
      amount: round2(d.amount),
      fee: round2(d.fee_charged ?? 0),
      status: d.status,
      statusLabel: DISBURSEMENT_STATUS_LABEL[d.status as DisbursementStatus] ?? 'Pending',
      kindLabel: d.trigger_type ? (DISBURSEMENT_TRIGGER_LABEL[d.trigger_type] ?? 'Payout') : 'Payout',
      bank: d.bank_nickname || d.bank_name || null,
      bankLast4: d.account_last4 || d.bank_last4 || null,
      companyName: d.company_name ?? null,
    }))
    // 10/12 (Nic) review, BK3: the charges are company money, every one of
    // them on the list and in the totals; but a bookkeeper never reads the
    // name of a property whose history is hidden from them — one cut at its
    // last day (a charge after it), one hidden whole (a sold property never
    // theirs: HIDDEN_HISTORY), or one that left the company without being
    // theirs. The row stays, unnamed.
    const propertyHidden = (c: any): boolean => {
      if (scope.viewer !== 'bookkeeper' || !c.property_id) return false
      if (pastCutoff(scope.cutoffs, c.property_id, c.charge_day)) return true
      // The whole company's cut already names every property that left it
      // (theirs at its last day, any other hidden whole); a bookkeeper kept to
      // some properties reads a property that left only if it was theirs.
      if (scope.propertyIds === null) return false
      const leftCompany = !!c.property_company_id && !scope.landlordIds.includes(c.property_company_id)
      return leftCompany && !scope.propertyIds.includes(c.property_id)
    }
    const chargeRows = charges.map((c: any) => ({
      id: c.id,
      createdAt: c.created_at,
      kindLabel: LANDLORD_GAM_CHARGE_KIND_LABEL[c.kind as LandlordGamChargeKind] ?? 'GAM charge',
      propertyName: propertyHidden(c) ? null : (c.property_name ?? null),
      companyName: c.company_name ?? null,
      amount: round2(c.amount),
      collected: round2(c.collected_amount),
      collectedAt: c.collected_at,
    }))
    res.json({ success: true, data: {
      payouts: payoutRows,
      totalSettled: round2(Number(payoutTotals?.settled ?? 0)),
      totalOnTheWay: round2(Number(payoutTotals?.on_the_way ?? 0)),
      // 10/11: every payout the totals count; the list is the newest
      // PAYOUT_ROWS_SHOWN of them, and the page says so when it is cut.
      payoutCount: Number(payoutTotals?.payout_count ?? 0),
      gamCharges: chargeRows,
      gamChargesOutstanding: round2(Number(chargeTotals?.outstanding ?? 0)),
    } })
  } catch (e) { next(e) }
})

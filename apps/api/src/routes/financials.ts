/**
 * 10/11 (Nic) — THE SHARED FINANCIAL PAGES' OWN API.
 *
 * The financial pages are one set of files kept byte-identical in the landlord
 * portal and GAM Books (apps/{landlord,books}/src/financials, held together by
 * financials-parity.test.ts). The owner and their bookkeeper read them through
 * these routes, scoped by lib/financialsScope — so the same page shows each of
 * them exactly their own companies and properties.
 *
 * Read only, and nothing here names a person: money in is added up by type
 * (services/incomePools), maintenance is its cost lines (never the request,
 * its photos or who asked), the bank is its transactions (a bookkeeper sees
 * what a deposit was, never the payer's memo) and payouts are amounts and
 * banks (never the recipient's name).
 */
import { Router } from 'express'
import { z } from 'zod'
import {
  MAINTENANCE_CATEGORY_LABEL, BANK_TXN_STATUS_LABEL, BANK_MATCH_KIND_LABEL, BANK_TXN_HIDDEN_REASONS,
  EXPENSE_CATEGORY_LABEL, OTHER_INCOME_CATEGORY_LABEL, DISBURSEMENT_STATUS_LABEL, DISBURSEMENT_TRIGGER_LABEL,
  LANDLORD_GAM_CHARGE_KIND_LABEL,
  type MaintenanceCategory, type BankTxnStatus, type BankMatchKind, type ExpenseCategory,
  type OtherIncomeCategory, type DisbursementStatus, type LandlordGamChargeKind,
} from '@gam/shared'
import { query } from '../db'
import { requireAuth } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { todayIn } from '../lib/timezone'
import { financialsScope, scopeProperties, refuseNarrowed } from '../lib/financialsScope'
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
      // The owner removes expenses; a bookkeeper looks and adds (Nic, 10/11).
      canRemoveExpenses: scope.viewer === 'owner',
      wholeCompany: !scope.narrowed,
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
              u.unit_number, p.id AS property_id, p.name AS property_name
         FROM maintenance_requests mr
         LEFT JOIN units u      ON u.id = mr.unit_id
         LEFT JOIN properties p ON p.id = u.property_id
        WHERE mr.landlord_id = ANY($1::uuid[])
          AND mr.actual_cost IS NOT NULL
          AND mr.completed_at >= $2 AND mr.completed_at < ($3::date + 1)
          AND ($4::uuid[] IS NULL OR u.property_id = ANY($4::uuid[]))
        ORDER BY mr.completed_at DESC, mr.id`,
      [scope.landlordIds, start, end, scope.propertyIds])
    const lines = rows.map((r: any) => ({
      id: r.id,
      day: r.day,
      category: r.category,
      categoryLabel: MAINTENANCE_CATEGORY_LABEL[r.category as MaintenanceCategory] ?? 'General / Other',
      amount: round2(r.amount),
      unitNumber: r.unit_number ?? null,
      propertyId: r.property_id ?? null,
      propertyName: r.property_name ?? null,
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

// GET /api/financials/bank-activity?from=&to= — the company's bank account, as
// the bank feed has it. Read only. A bookkeeper sees what money IN was (a GAM
// payout, a tenant's bank deposit, laundry income...) but never the bank's
// memo, in either direction: on a deposit it is often the payer's name, and on
// money out it can be the person paid ("ZELLE TO JANE DOE" for a deposit
// refund). A bookkeeper's money out reads as the filed expense's own vendor and
// kind (what the Expenses page already shows them), else 'Money out'. The
// owner keeps the memo.
financialsRouter.get('/bank-activity', async (req: any, res, next) => {
  try {
    const scope = await financialsScope(req)
    refuseNarrowed(scope, 'The bank account')
    const { start, end } = period(req.query)
    const rows = await query<any>(
      `SELECT bt.id, to_char(bt.posted_date, 'YYYY-MM-DD') AS posted_date, bt.amount::float AS amount,
              bt.description, bt.normalized_merchant, bt.status, bt.landlord_id,
              CASE WHEN bt.auto_filed_rule_id IS NOT NULL AND bt.status = 'categorized' THEN 'auto_filed'
                   WHEN bt.status <> 'matched' THEN NULL
                   WHEN bt.matched_disbursement_id IS NOT NULL THEN 'gam_payout'
                   WHEN bt.matched_payment_id IS NOT NULL THEN 'tenant_deposit'
                   WHEN bt.auto_settle_undo->>'kind' = 'deposit_slip' THEN 'deposit_slip'
              END AS match_kind,
              e.category AS expense_category, e.vendor AS expense_vendor, oi.category AS income_category,
              c.display_name AS account_name, l.business_name AS company_name
         FROM bank_transactions bt
         JOIN bank_connections c ON c.id = bt.bank_connection_id
         JOIN landlords l        ON l.id = bt.landlord_id
         LEFT JOIN landlord_expenses e      ON e.id = bt.expense_id AND e.status = 'active'
         LEFT JOIN landlord_other_income oi ON oi.id = bt.landlord_other_income_id AND oi.status = 'active'
        WHERE bt.landlord_id = ANY($1::uuid[])
          AND NOT (COALESCE(bt.ignored_reason, '') = ANY($2::text[]))
          AND bt.posted_date BETWEEN $3::date AND $4::date
        ORDER BY bt.posted_date DESC, bt.created_at DESC
        LIMIT 1000`,
      [scope.landlordIds, [...BANK_TXN_HIDDEN_REASONS], start, end])
    const bookkeeper = scope.viewer === 'bookkeeper'
    const filedAs = (r: any): string | null =>
      r.expense_category ? (EXPENSE_CATEGORY_LABEL[r.expense_category as ExpenseCategory] ?? 'Other')
      : r.income_category ? (OTHER_INCOME_CATEGORY_LABEL[r.income_category as OtherIncomeCategory] ?? 'Other income')
      : r.match_kind ? BANK_MATCH_KIND_LABEL[r.match_kind as BankMatchKind]
      : null
    const out = rows.map((r: any) => {
      const moneyIn = r.amount > 0
      return {
        id: r.id,
        day: r.posted_date,
        amount: round2(r.amount),
        direction: moneyIn ? 'in' : 'out',
        description: bookkeeper
          ? (moneyIn
              ? (filedAs(r) ?? 'Money in')
              : ([r.expense_vendor?.trim(), filedAs(r)].filter(Boolean).join(' · ') || 'Money out'))
          : (r.description || r.normalized_merchant || (moneyIn ? 'Money in' : 'Money out')),
        filedAs: filedAs(r),
        statusLabel: BANK_TXN_STATUS_LABEL[r.status as BankTxnStatus] ?? 'Not filed yet',
        accountName: r.account_name ?? null,
        companyName: r.company_name ?? null,
      }
    })
    res.json({ success: true, data: {
      period: { start, end },
      transactions: out,
      moneyIn: round2(out.filter(t => t.direction === 'in').reduce((s, t) => s + t.amount, 0)),
      moneyOut: round2(out.filter(t => t.direction === 'out').reduce((s, t) => s - t.amount, 0)),
    } })
  } catch (e) { next(e) }
})

// GET /api/financials/payouts — what GAM sent the company and what GAM charged
// it. Amounts, dates, banks; never who the payout was addressed to.
financialsRouter.get('/payouts', async (req: any, res, next) => {
  try {
    const scope = await financialsScope(req)
    refuseNarrowed(scope, 'Payouts')
    // A payout names its company; an older one names only the account it was
    // paid to, and counts here only when that account owns no other company
    // (otherwise it blended companies and cannot be told apart).
    const payouts = await query<any>(
      `SELECT d.id, d.amount::float AS amount, d.fee_charged::float AS fee_charged, d.status, d.trigger_type,
              d.created_at, d.settled_at, d.bank_name, d.bank_last4,
              ba.nickname AS bank_nickname, ba.account_number_last4 AS account_last4,
              COALESCE(ll.business_name, own.business_name) AS company_name
         FROM disbursements d
         LEFT JOIN landlords ll ON ll.id = d.landlord_id
         LEFT JOIN user_bank_accounts ba ON ba.id = d.bank_account_id
         LEFT JOIN LATERAL (
           SELECT x.business_name FROM landlords x WHERE x.user_id = d.user_id ORDER BY x.created_at LIMIT 1
         ) own ON d.landlord_id IS NULL
        WHERE d.landlord_id = ANY($1::uuid[])
           OR (d.landlord_id IS NULL
               AND d.user_id IN (SELECT user_id FROM landlords WHERE id = ANY($1::uuid[]))
               AND NOT EXISTS (SELECT 1 FROM landlords o
                                WHERE o.user_id = d.user_id AND NOT (o.id = ANY($1::uuid[]))))
        ORDER BY d.created_at DESC
        LIMIT 200`, [scope.landlordIds])
    const charges = await query<any>(
      `SELECT c.id, c.kind, c.amount::float AS amount, c.collected_amount::float AS collected_amount,
              c.collected_at, c.created_at, p.name AS property_name, l.business_name AS company_name
         FROM landlord_gam_charges c
         LEFT JOIN properties p ON p.id = c.property_id
         LEFT JOIN landlords  l ON l.id = c.landlord_id
        WHERE c.landlord_id = ANY($1::uuid[])
        ORDER BY c.created_at DESC
        LIMIT 200`, [scope.landlordIds])
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
    const chargeRows = charges.map((c: any) => ({
      id: c.id,
      createdAt: c.created_at,
      kindLabel: LANDLORD_GAM_CHARGE_KIND_LABEL[c.kind as LandlordGamChargeKind] ?? 'GAM charge',
      propertyName: c.property_name ?? null,
      companyName: c.company_name ?? null,
      amount: round2(c.amount),
      collected: round2(c.collected_amount),
      collectedAt: c.collected_at,
    }))
    res.json({ success: true, data: {
      payouts: payoutRows,
      totalSettled: round2(payoutRows.filter(p => p.status === 'settled').reduce((s, p) => s + p.amount, 0)),
      totalOnTheWay: round2(payoutRows.filter(p => p.status === 'pending' || p.status === 'processing').reduce((s, p) => s + p.amount, 0)),
      gamCharges: chargeRows,
      gamChargesOutstanding: round2(chargeRows.reduce((s, c) => s + (c.amount - c.collected), 0)),
    } })
  } catch (e) { next(e) }
})

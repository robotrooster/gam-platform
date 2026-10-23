/**
 * 10/12 (Nic) — GAM BOOKS LEDGER: THE ADMIN'S READ-ONLY VIEW
 *
 * The ledger is DARK in this phase (P3): no landlord or bookkeeper screen reads
 * it. GAM's super_admin can look inside to see the engine working
 * (gam-ledger-design-2026-10-12 §8, §14). Read-only: nothing here posts,
 * rebuilds, closes or repoints.
 *
 *   GET /api/admin/ledger/status
 *       what can post, what is waiting in the outbox and for how long, what is
 *       failing, and the latest rebuild and check runs
 *   GET /api/admin/ledger/landlords/:landlordId/postings
 *       ?sourceType=&sourceId=&from=&to=&includeSuperseded=true&limit=
 *       postings with their lines (account code and name), newest first
 *   GET /api/admin/ledger/landlords/:landlordId/trial-balance?asOf=&byProperty=true
 *       debits, credits and balance per account (and property) through a day
 *   GET /api/admin/ledger/landlords/:landlordId/chart
 *       the company's accounts and where each posting role points today
 *   GET /api/admin/ledger/landlords/:landlordId/closes
 *       the company's books settings and its close / reopen history
 *
 * 10/12 (Nic, ledger P8) — the switch of a company's reports to its books
 * (services/ledgerReports ledgerReportsLive, services/ledgerParity). The only
 * writes here, and they write no money and no posting — only a parity run:
 *   GET  /api/admin/ledger/landlords/:landlordId/reports
 *       whether the company's reports read the books, why not, and its latest
 *       parity checks (what differs, what of it is expected)
 *   POST /api/admin/ledger/landlords/:landlordId/parity
 *       run the parity check now (the nightly job's own check)
 *   POST /api/admin/ledger/landlords/:landlordId/parity/accept   { reason }
 *       accept the differences the checks listed — the reports switch
 */
import { Router } from 'express'
import { z } from 'zod'
import { query } from '../../db'
import { requireAuth, requireSuperAdmin } from '../../middleware/auth'
import { AppError } from '../../middleware/errorHandler'
import { registeredLedgerSourceTypes } from '../../services/ledgerEngine'
import { currentChartMap } from '../../services/booksLedgerChart'
import { getLedgerSettings } from '../../services/ledgerClose'

export const adminLedgerRouter = Router()
adminLedgerRouter.use('/ledger', requireAuth, requireSuperAdmin)

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.')
const uuid = z.string().uuid('Not a company id.')

adminLedgerRouter.get('/ledger/status', async (_req, res, next) => {
  try {
    const [outbox, errors, runs] = await Promise.all([
      query(`SELECT source_type, count(*)::int AS rows, count(DISTINCT source_id)::int AS sources,
                    min(at) AS oldest_at
               FROM ledger_outbox GROUP BY source_type ORDER BY source_type`),
      query(`SELECT source_type, source_id, owner_id, reason_code, attempts, last_error, first_failed_at,
                    last_failed_at, next_try_at
               FROM ledger_source_errors ORDER BY last_failed_at DESC LIMIT 100`),
      query(`SELECT id, landlord_id, business_id, mode, scope, status, started_at, finished_at, counts, error
               FROM ledger_rebuild_runs ORDER BY started_at DESC LIMIT 25`),
    ])
    res.json({ success: true, data: { registeredSourceTypes: registeredLedgerSourceTypes(), outbox, errors, runs } })
  } catch (e) { next(e) }
})

const postingsQuery = z.object({
  sourceType: z.string().max(40).optional(),
  sourceId: z.string().max(80).optional(),
  from: day.optional(),
  to: day.optional(),
  includeSuperseded: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
})

adminLedgerRouter.get('/ledger/landlords/:landlordId/postings', async (req, res, next) => {
  try {
    const landlordId = uuid.parse(req.params.landlordId)
    const q = postingsQuery.parse(req.query)
    const postings = await query<any>(
      `SELECT p.id, p.source_type, p.source_id, p.posting_kind, p.role, p.is_correction,
              p.intended_date::text AS intended_date, p.accounting_date::text AS accounting_date,
              p.fingerprint, p.rule_version, p.reverses_posting_id, p.superseded_at, p.superseded_by,
              p.posted_at, p.posted_by, p.rebuild_run_id, p.memo
         FROM ledger_postings p
        WHERE p.landlord_id = $1
          AND ($2::text IS NULL OR p.source_type = $2)
          AND ($3::text IS NULL OR p.source_id = $3)
          AND ($4::date IS NULL OR p.accounting_date >= $4::date)
          AND ($5::date IS NULL OR p.accounting_date <= $5::date)
          AND ($6::boolean OR (p.role = 'post' AND p.superseded_at IS NULL))
        ORDER BY p.posted_at DESC, p.id
        LIMIT $7`,
      [landlordId, q.sourceType ?? null, q.sourceId ?? null, q.from ?? null, q.to ?? null,
       q.includeSuperseded === 'true', q.limit ?? 100])
    const ids = postings.map(p => p.id)
    const lines = ids.length === 0 ? [] : await query<any>(
      `SELECT l.posting_id, l.line_no, l.account_id, a.code AS account_code, a.name AS account_name, l.account_role,
              l.property_id, l.unit_id, l.lease_id, l.tenant_id, l.vendor_id, l.payment_id, l.report_category,
              l.cash_effect, l.tax_name, l.debit::text AS debit, l.credit::text AS credit, l.memo, l.system_line
         FROM ledger_posting_lines l JOIN books_accounts a ON a.id = l.account_id
        WHERE l.posting_id = ANY($1::uuid[])
        ORDER BY l.posting_id, l.line_no`, [ids])
    const byPosting = new Map<string, any[]>()
    for (const l of lines) {
      const arr = byPosting.get(l.posting_id) ?? []
      arr.push(l)
      byPosting.set(l.posting_id, arr)
    }
    res.json({ success: true, data: postings.map(p => ({ ...p, lines: byPosting.get(p.id) ?? [] })) })
  } catch (e) { next(e) }
})

adminLedgerRouter.get('/ledger/landlords/:landlordId/trial-balance', async (req, res, next) => {
  try {
    const landlordId = uuid.parse(req.params.landlordId)
    const q = z.object({ asOf: day.optional(), byProperty: z.enum(['true', 'false']).optional() }).parse(req.query)
    const byProperty = q.byProperty === 'true'
    const rows = await query(
      `SELECT a.id AS account_id, a.code, a.name, a.type, a.active,
              ${byProperty ? 'l.property_id,' : ''}
              sum(l.debit)::text AS debits, sum(l.credit)::text AS credits,
              (sum(l.debit) - sum(l.credit))::text AS balance_dr_minus_cr
         FROM ledger_posting_lines l JOIN books_accounts a ON a.id = l.account_id
        WHERE l.landlord_id = $1 AND ($2::date IS NULL OR l.accounting_date <= $2::date)
        GROUP BY a.id, a.code, a.name, a.type, a.active${byProperty ? ', l.property_id' : ''}
        ORDER BY a.code${byProperty ? ', l.property_id' : ''}`, [landlordId, q.asOf ?? null])
    const totals = await query<{ debits: string; credits: string }>(
      `SELECT COALESCE(sum(debit), 0)::text AS debits, COALESCE(sum(credit), 0)::text AS credits
         FROM ledger_posting_lines WHERE landlord_id = $1 AND ($2::date IS NULL OR accounting_date <= $2::date)`,
      [landlordId, q.asOf ?? null])
    res.json({ success: true, data: { asOf: q.asOf ?? null, rows, totals: totals[0] } })
  } catch (e) { next(e) }
})

adminLedgerRouter.get('/ledger/landlords/:landlordId/chart', async (req, res, next) => {
  try {
    const landlordId = uuid.parse(req.params.landlordId)
    const accounts = await query(
      `SELECT id, code, name, type, active, is_system, parent_account_id, bank_connection_id,
              replaced_by_account_id, retired_at
         FROM books_accounts WHERE landlord_id = $1 ORDER BY code`, [landlordId])
    const map = await currentChartMap({ landlordId })
    res.json({ success: true, data: { accounts, map } })
  } catch (e) { next(e) }
})

adminLedgerRouter.get('/ledger/landlords/:landlordId/closes', async (req, res, next) => {
  try {
    const landlordId = uuid.parse(req.params.landlordId)
    const exists = await query(`SELECT 1 FROM landlords WHERE id = $1`, [landlordId])
    if (!exists.length) throw new AppError(404, 'No such company.')
    const settings = await getLedgerSettings(landlordId)
    const history = await query(
      // 10/23: qualified, because `id::text AS id` makes a bare `ORDER BY id`
      // sort the TEXT — which put close 9 above reopen 10 and showed this
      // history out of order (services/ledgerCheck has the whole story).
      `SELECT id::text AS id, action, closed_through::text AS closed_through, reason, acted_by, acted_at
         FROM books_period_closes WHERE landlord_id = $1 ORDER BY books_period_closes.id DESC`, [landlordId])
    res.json({ success: true, data: { settings, history } })
  } catch (e) { next(e) }
})

// ── 10/12 (Nic, ledger P8): the switch of a company's reports to its books ──

adminLedgerRouter.get('/ledger/landlords/:landlordId/reports', async (req, res, next) => {
  try {
    const landlordId = uuid.parse(req.params.landlordId)
    const { ledgerReportsLive, ledgerNotLiveReason } = await import('../../services/ledgerReports')
    const [live, reason, runs] = await Promise.all([
      ledgerReportsLive([landlordId]),
      ledgerNotLiveReason(landlordId),
      query(`SELECT id, status, scope, counts, drift, started_at, finished_at, started_by
               FROM ledger_rebuild_runs
              WHERE landlord_id = $1 AND mode = 'check' AND scope->>'kind' = 'parity'
              ORDER BY started_at DESC LIMIT 10`, [landlordId]),
    ])
    res.json({ success: true, data: { live, reason, runs } })
  } catch (e) { next(e) }
})

adminLedgerRouter.post('/ledger/landlords/:landlordId/parity', async (req, res, next) => {
  try {
    const landlordId = uuid.parse(req.params.landlordId)
    const { checkCompanyParity } = await import('../../services/ledgerParity')
    const r = await checkCompanyParity(landlordId)
    res.json({ success: true, data: r })
  } catch (e) { next(e) }
})

adminLedgerRouter.post('/ledger/landlords/:landlordId/parity/accept', async (req, res, next) => {
  try {
    const landlordId = uuid.parse(req.params.landlordId)
    const { reason } = z.object({
      reason: z.string({ required_error: 'Say why the differences are accepted.' }).trim()
        .min(1, 'Say why the differences are accepted.').max(500, 'Keep the reason under 500 characters.'),
    }).parse(req.body ?? {})
    const { acceptParity } = await import('../../services/ledgerParity')
    const r = await acceptParity(landlordId, req.user!.userId, reason)
    res.json({ success: true, data: r })
  } catch (e) { next(e) }
})

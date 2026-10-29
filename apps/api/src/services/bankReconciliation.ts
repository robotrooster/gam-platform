/**
 * 10/12 (Nic) — GAM BOOKS LEDGER, PHASE P9: BANK RECONCILIATION ON THE LEDGER
 *
 *   Nic, 10/12 (decision 2): "Full bookkeeping (bank lines, reconciling,
 *   journal entries, bills, payroll, vendors) … never tenant-account actions …
 *   One level, no per-bookkeeper switch."
 *
 * (gam-ledger-design-2026-10-12 §13.) A bank account of the company's chart is
 * reconciled against its statement the way QuickBooks does it, on the ledger
 * GAM keeps automatically:
 *
 *   1. Pick the bank account and type the statement's last day and ending
 *      balance (startReconciliation). The beginning balance is what the last
 *      completed statement left cleared.
 *   2. Every ledger line on that account dated on or before the statement day
 *      that no earlier statement cleared is listed:
 *        - a line that came from a bank line the feed matched or filed (an
 *          expense paid by that line, a deposit slip or a receipt that reached
 *          the bank, a payout, a loan, a transfer, other income) ARRIVES
 *          TICKED — the bank already said it happened. Undoing the match on
 *          the Bank page is how it comes off;
 *        - the bank's balance on the books start date (the opening balance)
 *          arrives ticked too: it is a statement's figure;
 *        - a line and the line that took it back, both on this statement, are
 *          $0.00 together and clear together;
 *        - everything else is ticked off by hand against the statement. A
 *          bookkeeper's journal entry on the account is listed apart, as a
 *          reconciling item: no bank line stands behind it.
 *   3. When the cleared balance (beginning + what is ticked) equals the
 *      statement's ending balance — a difference of $0.00 — Finish freezes
 *      every cleared line (completeReconciliation). A bank charge on the
 *      statement that the books do not have yet is added as an expense paid
 *      from that bank (or filed from the feed), and then ticked.
 *
 * Only the latest completed statement of an account can be undone, never
 * inside a closed month, always with why (undoReconciliation); its lines are
 * let go and the record is kept. Nothing is ever deleted
 * (20261014230000_bank_reconciliation_on_the_ledger guards it in the database).
 *
 * WHO: the company's owner (founding user or co-owner), or a bookkeeper the
 * company keeps who has its ledger — the company-wide box, or "May use the
 * whole-company ledger" (Nic, 10/12, BK1; the Team page says bank
 * reconciliation comes with it). Every bookkeeper does the full bookkeeping
 * at one level (Nic, 10/12, decision 2): there is no read-only bookkeeper.
 *
 * The close-month preflight (services/ledgerClose) asks this file which linked
 * bank accounts are not reconciled through the month's end.
 *
 * Replaces the S568 statement-total check (a statement figure against what GAM
 * paid out). Production never saved one; the old rows, if any, keep
 * statement_date NULL and are left as they were.
 */
import type { PoolClient } from 'pg'
import { booksCents, type BankReconciliationItemSource, type BankReconciliationStatus } from '@gam/shared'
import { db } from '../db'
import { AppError } from '../middleware/errorHandler'
import { bookkeeperScopesOf, requestScopeOf } from '../lib/bookkeeperScope'
import { type LedgerOwner, loadOwnerContext, addDaysIso, ISO_DAY, ownerLockText } from './ledgerOwner'
import type { LedgerCheck, LedgerFinding } from './ledgerCheck'

/** The posting roles whose accounts are bank accounts (and their linked sub-accounts). */
const BANK_ROLES = ['bank_checking', 'bank_savings', 'own_deposit_account']

const dollars = (cents: number) => cents / 100
const moneyText = (cents: number) =>
  `${cents < 0 ? '−' : ''}$${(Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

type Runner = Pick<PoolClient, 'query'>

async function withClient<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await db.connect()
  try { return await fn(c) } finally { c.release() }
}
/**
 * 10/12 (Nic, review): the company's books lock, SHARED — the one posters and
 * journal entries take before they read the closed-through date (services/
 * ledgerOwner ownerLockText). A month close takes it EXCLUSIVELY, so a
 * statement completed or undone here and a close never pass each other.
 */
async function takeSharedOwnerLock(c: PoolClient, owner: LedgerOwner): Promise<void> {
  await c.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))', [ownerLockText(owner)])
}

async function inTransaction<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  return withClient(async (c) => {
    await c.query('BEGIN')
    try {
      const out = await fn(c)
      await c.query('COMMIT')
      return out
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {})
      throw e
    }
  })
}

function landlordOf(owner: LedgerOwner): string {
  if (!owner.landlordId) throw new AppError(409, 'A business\'s bank accounts reconcile on its Transactions for now.')
  return owner.landlordId
}

// ─── Who may reconcile ───────────────────────────────────────────────────────

/** An owner of the company (founding user or co-owner)? */
export async function isCompanyOwner(c: Runner, userId: string, landlordId: string): Promise<boolean> {
  const r = await c.query(
    `SELECT EXISTS (SELECT 1 FROM landlords WHERE id = $2 AND user_id = $1)
         OR EXISTS (SELECT 1 FROM landlord_members WHERE landlord_id = $2 AND user_id = $1 AND role = 'owner') AS ok`,
    [userId, landlordId])
  return !!r.rows[0]?.ok
}

/**
 * A bookkeeper the company keeps who has its ledger (the company-wide box, or
 * "May use the whole-company ledger" while they keep a property) — the owner's
 * boxes, worked out the same way as on every request (lib/bookkeeperScope).
 * One level: no read-only bookkeeper.
 */
export async function isLedgerBookkeeper(userId: string, landlordId: string): Promise<boolean> {
  const rows = await bookkeeperScopesOf(userId, landlordId)
  return rows.some(r => requestScopeOf(r).ledger)
}

/** May this person reconcile the company's bank accounts? The refusal in plain words, or null. */
export async function reconcilePermissionRefusal(c: Runner, owner: LedgerOwner, userId: string): Promise<string | null> {
  const landlordId = landlordOf(owner)
  if (await isCompanyOwner(c, userId, landlordId)) return null
  if (await isLedgerBookkeeper(userId, landlordId)) return null
  return 'Only the owner, or a bookkeeper given the company\'s ledger, reconciles the bank accounts.'
}

async function assertMayReconcile(c: Runner, owner: LedgerOwner, userId: string): Promise<void> {
  const refusal = await reconcilePermissionRefusal(c, owner, userId)
  if (refusal) throw new AppError(403, refusal)
}

// ─── The bank accounts ───────────────────────────────────────────────────────

export interface ReconcileAccount {
  accountId: string
  code: string
  name: string
  /** The linked bank (a bank feed) this account is, or null (an account with no feed). */
  bankConnectionId: string | null
  linked: boolean
  active: boolean
  /** Every line on the books for it, to date. */
  ledgerBalance: number
  /** The last completed statement's day, or null. */
  reconciledThrough: string | null
  /** That statement's ending balance (the next statement's beginning balance), or null. */
  reconciledBalance: number | null
  /** The statement being worked now, if any. */
  inProgress: { id: string; statementDate: string; statementBalance: number } | null
}

const ACCOUNTS_SQL = `
  SELECT a.id, a.code::text AS code, a.name::text AS name, a.bank_connection_id, (a.active IS NOT FALSE) AS active,
         COALESCE((SELECT sum(l.debit - l.credit) FROM ledger_posting_lines l WHERE l.account_id = a.id), 0)::text AS ledger_balance,
         done.statement_date AS reconciled_through, done.statement_balance AS reconciled_balance,
         op.id AS open_id, op.statement_date AS open_date, op.statement_balance AS open_balance
    FROM books_accounts a
    LEFT JOIN LATERAL (
      SELECT r.statement_date::text AS statement_date, r.statement_balance::text AS statement_balance
        FROM bank_reconciliations r
       WHERE r.account_id = a.id AND r.status = 'completed' AND r.statement_date IS NOT NULL
       ORDER BY r.statement_date DESC, r.completed_at DESC LIMIT 1) done ON TRUE
    LEFT JOIN LATERAL (
      SELECT r.id, r.statement_date::text AS statement_date, r.statement_balance::text AS statement_balance
        FROM bank_reconciliations r
       WHERE r.account_id = a.id AND r.status = 'open' AND r.statement_date IS NOT NULL LIMIT 1) op ON TRUE
   WHERE a.landlord_id = $1 AND a.type = 'asset'
     AND (a.bank_connection_id IS NOT NULL OR a.subtype = 'bank'
          OR EXISTS (SELECT 1 FROM books_account_map m
                      WHERE m.landlord_id = $1 AND m.account_id = a.id
                        AND ((m.map_kind = 'role' AND m.map_value = ANY($2::text[])) OR m.map_kind = 'bank_connection')))
     AND (a.active IS NOT FALSE OR EXISTS (SELECT 1 FROM ledger_posting_lines l WHERE l.account_id = a.id))`

interface AccountRow {
  id: string; code: string; name: string; bank_connection_id: string | null; active: boolean; ledger_balance: string
  reconciled_through: string | null; reconciled_balance: string | null
  open_id: string | null; open_date: string | null; open_balance: string | null
}
function accountOf(r: AccountRow): ReconcileAccount {
  return {
    accountId: r.id, code: r.code, name: r.name, bankConnectionId: r.bank_connection_id, linked: !!r.bank_connection_id,
    active: r.active, ledgerBalance: dollars(booksCents(r.ledger_balance)),
    reconciledThrough: r.reconciled_through,
    reconciledBalance: r.reconciled_balance == null ? null : dollars(booksCents(r.reconciled_balance)),
    inProgress: r.open_id ? { id: r.open_id, statementDate: r.open_date!, statementBalance: dollars(booksCents(r.open_balance)) } : null,
  }
}

/** The company's bank accounts on the chart: linked banks, Checking, Savings, its own deposit account. */
export async function listReconcileAccounts(owner: LedgerOwner, c?: Runner): Promise<ReconcileAccount[]> {
  const landlordId = landlordOf(owner)
  const run = async (x: Runner) => (await x.query<AccountRow>(`${ACCOUNTS_SQL} ORDER BY a.code, a.name`, [landlordId, BANK_ROLES])).rows.map(accountOf)
  return c ? run(c) : withClient(run)
}

async function accountFor(c: Runner, landlordId: string, accountId: string): Promise<ReconcileAccount> {
  const r = (await c.query<AccountRow>(`${ACCOUNTS_SQL} AND a.id = $3`, [landlordId, BANK_ROLES, accountId])).rows[0]
  if (!r) throw new AppError(404, 'That is not one of this company\'s bank accounts.')
  return accountOf(r)
}

/**
 * The bank account a request names: a chart account id, or a linked bank's id
 * (bank_connections). Naming nothing is fine only when the company has exactly
 * one linked bank account (or one bank account at all).
 *
 * 10/12 (Nic, review): the way people say it, too — the assistant passes
 * what the person said, never an id it cannot look up: the account's number
 * ("1011"), its name ("PNC Bank"), or the last four digits ("••9677"), alone
 * or together ("PNC ••9677"). More than one fits: it asks which.
 */
export function pickReconcileAccount(all: readonly ReconcileAccount[], named: string): ReconcileAccount {
  const q = named.trim()
  const exact = all.find(a => a.accountId === q) ?? all.find(a => a.bankConnectionId === q)
  if (exact) return exact
  const lc = q.toLowerCase()
  const one = (list: readonly ReconcileAccount[]) => (list.length === 1 ? list[0] : null)
  const byCode = one(all.filter(a => a.code.toLowerCase() === lc))
  if (byCode) return byCode
  const byName = one(all.filter(a => a.name.toLowerCase() === lc || `${a.code} ${a.name}`.toLowerCase() === lc))
  if (byName) return byName
  // "PNC ••9677" → the words "pnc" and the last four "9677".
  const plain = lc.replace(/[•·*.#]/g, ' ').replace(/\s+/g, ' ').trim()
  const last4 = /(?:^|\D)(\d{4})$/.exec(plain)?.[1] ?? null
  const words = (last4 ? plain.slice(0, -4) : plain).replace(/\b(account|acct|ending|in|the)\b/g, ' ').replace(/\s+/g, ' ').trim()
  const fits = all.filter(a => {
    const name = `${a.code} ${a.name}`.toLowerCase()
    if (last4 && !name.includes(last4)) return false
    if (words && !words.split(' ').every(w => name.includes(w))) return false
    return !!last4 || !!words
  })
  if (fits.length === 1) return fits[0]
  if (fits.length > 1) throw new AppError(400, `Which bank account? ${fits.map(a => `${a.code} ${a.name}`).join(', ')}.`)
  throw new AppError(404, `That is not one of this company's bank accounts. They are: ${all.map(a => `${a.code} ${a.name}`).join(', ') || 'none yet'}.`)
}

export async function resolveReconcileAccount(c: Runner, owner: LedgerOwner, named: string | null | undefined): Promise<ReconcileAccount> {
  const landlordId = landlordOf(owner)
  const all = (await c.query<AccountRow>(`${ACCOUNTS_SQL} ORDER BY a.code, a.name`, [landlordId, BANK_ROLES])).rows.map(accountOf)
  if (named && named.trim()) return pickReconcileAccount(all, named)
  const linked = all.filter(a => a.linked)
  if (linked.length === 1) return linked[0]
  if (all.length === 1) return all[0]
  if (!all.length) throw new AppError(409, 'This company has no bank account on its books yet. Link the bank on the Bank page first.')
  throw new AppError(400, `Which bank account? ${all.map(a => `${a.code} ${a.name}`).join(', ')}.`)
}

// ─── The lines on a statement ────────────────────────────────────────────────

/**
 * The bank line a ledger line came from, when the feed matched or filed it.
 * Keyed on the posting's source (each projector's own link to the line —
 * services/ledgerProjectors): a payment toward an expense, a loan payment or a
 * loan's money arriving, a deposit slip, other income filed from the feed, a
 * bank line matched to a record GAM has (a transfer: the receiving bank's line
 * for the receiving side), a payout the feed matched.
 */
const BANK_LINE_OF_LINE = `
  LEFT JOIN LATERAL (
    SELECT bt.id, bt.posted_date::text AS posted_date, bt.description
      FROM bank_transactions bt
     WHERE bt.landlord_id = l.landlord_id AND bt.status <> 'ignored'
       AND (a.bank_connection_id IS NULL OR bt.bank_connection_id = a.bank_connection_id)
       AND bt.id = CASE p.source_type
         WHEN 'expense_payment' THEN (SELECT ep.bank_transaction_id FROM landlord_expense_payments ep WHERE ep.id::text = p.source_id)
         WHEN 'loan_payment' THEN (SELECT lp.bank_transaction_id FROM books_loan_payments lp WHERE lp.id::text = p.source_id)
         WHEN 'loan' THEN (SELECT bl.funded_bank_transaction_id FROM books_loans bl WHERE bl.id::text = p.source_id)
         WHEN 'deposit_slip' THEN (SELECT s.bank_transaction_id FROM bank_deposit_slips s WHERE s.id::text = p.source_id)
         WHEN 'other_income' THEN (
           SELECT COALESCE(o.bank_transaction_id,
                    (SELECT b2.id FROM bank_transactions b2 WHERE b2.landlord_other_income_id = o.id ORDER BY b2.created_at, b2.id LIMIT 1))
             FROM landlord_other_income o WHERE o.id::text = p.source_id)
         WHEN 'bank_match' THEN (
           SELECT CASE WHEN b3.matched_kind = 'transfer' AND l.map_value IS DISTINCT FROM b3.bank_connection_id::text
                       THEN b3.matched_transfer_line_id ELSE b3.id END
             FROM bank_transactions b3 WHERE b3.id::text = p.source_id)
         WHEN 'disbursement' THEN (
           SELECT b4.id FROM bank_transactions b4
            WHERE b4.matched_disbursement_id::text = p.source_id AND b4.landlord_id = l.landlord_id
            ORDER BY b4.posted_date, b4.id LIMIT 1)
       END
  ) bl ON TRUE`

interface LineRow {
  id: string; posting_id: string; line_no: number; day: string; booked_on: string; amount: string; memo: string | null
  source_type: string; source_id: string; posting_kind: string; role: string; reverses_posting_id: string | null
  superseded: boolean; item_id: string | null; item_source: BankReconciliationItemSource | null
  bank_line_id: string | null; bank_day: string | null; bank_description: string | null
  /** 10/12: the posting that replaced this one (a re-post), and — on a reversal — the one that replaced its original. */
  superseded_by: string | null; replaced_by: string | null
  /** 10/12: on a reversal, the line it takes back is cleared on a finished statement. */
  orig_frozen: boolean
}

/** The lines on `accountId` dated on or before `through` that no other statement cleared. */
async function candidateLines(c: Runner, landlordId: string, accountId: string, through: string, reconciliationId: string | null): Promise<LineRow[]> {
  return (await c.query<LineRow>(
    `SELECT l.id, l.posting_id, l.line_no, l.intended_date::text AS day, l.accounting_date::text AS booked_on,
            (l.debit - l.credit)::text AS amount, COALESCE(l.memo, p.memo) AS memo,
            p.source_type, p.source_id, p.posting_kind, p.role, p.reverses_posting_id, (p.superseded_at IS NOT NULL) AS superseded,
            it.id AS item_id, it.source AS item_source,
            bl.id AS bank_line_id, bl.posted_date AS bank_day, bl.description AS bank_description,
            p.superseded_by::text AS superseded_by,
            (SELECT o.superseded_by::text FROM ledger_postings o WHERE o.id = p.reverses_posting_id) AS replaced_by,
            (p.reverses_posting_id IS NOT NULL AND EXISTS (
               SELECT 1 FROM ledger_posting_lines ol
                 JOIN bank_reconciliation_items oi ON oi.ledger_line_id = ol.id AND oi.released_at IS NULL
                 JOIN bank_reconciliations orr ON orr.id = oi.reconciliation_id AND orr.status = 'completed'
                WHERE ol.posting_id = p.reverses_posting_id AND ol.line_no = l.line_no)) AS orig_frozen
       FROM ledger_posting_lines l
       JOIN ledger_postings p ON p.id = l.posting_id
       JOIN books_accounts a ON a.id = l.account_id
       LEFT JOIN bank_reconciliation_items it
              ON it.ledger_line_id = l.id AND it.released_at IS NULL AND it.reconciliation_id = $4::uuid
       ${BANK_LINE_OF_LINE}
      WHERE l.account_id = $2 AND l.landlord_id = $1 AND l.intended_date <= $3::date
        AND NOT EXISTS (SELECT 1 FROM bank_reconciliation_items x
                         WHERE x.ledger_line_id = l.id AND x.released_at IS NULL
                           AND x.reconciliation_id IS DISTINCT FROM $4::uuid)
      ORDER BY l.intended_date, p.posted_at, l.line_no, l.id`,
    [landlordId, accountId, through, reconciliationId])).rows
}

/** How a line is cleared on this statement: automatically (and why), by a tick, or not yet. */
export type LineClearing = 'bank_line' | 'opening' | 'cancels_out' | 'ticked' | null

export interface StatementLine {
  lineId: string
  day: string
  /** Where the line sits in the books, when that differs from its own day (a correction posted later). */
  bookedOn: string | null
  /** Money into the bank is positive. */
  amount: number
  description: string
  sourceType: string
  /** A bookkeeper's journal entry: no bank line stands behind it (a reconciling item). */
  journalEntry: boolean
  /** Takes back an earlier line of the same record. */
  takesBack: boolean
  bankLine: { id: string; day: string; description: string | null } | null
  clearing: LineClearing
  /** Cleared automatically — it cannot be unticked here. */
  automatic: boolean
}

const SOURCE_WORDS: Record<string, string> = {
  expense_payment: 'Expense paid', loan_payment: 'Loan payment', loan: 'Loan', deposit_slip: 'Deposit slip',
  other_income: 'Money in', bank_match: 'Bank line', disbursement: 'Payout from GAM', opening: 'Opening balance',
  manual_journal: 'Journal entry', remittance: 'Payment received', payroll_run: 'Payroll',
}

/**
 * Sorts each candidate line into how it clears (see the header). Pure: the
 * caller read the lines on one snapshot.
 */
function classify(rows: LineRow[], through: string): StatementLine[] {
  // A line of a superseded posting and the same line of its reversal, both
  // here, are $0.00 together and clear together.
  const here = new Map(rows.map(r => [`${r.posting_id}#${r.line_no}`, r]))
  const pairs = new Set<string>()
  for (const r of rows) {
    if (r.role !== 'reversal' || !r.reverses_posting_id) continue
    const orig = here.get(`${r.reverses_posting_id}#${r.line_no}`)
    if (orig && !pairs.has(orig.id)) { pairs.add(r.id); pairs.add(orig.id) }
  }
  // 10/12 (Nic, review): a re-post (a fix, a chart repoint, a rebuild that
  // restates in place) takes a line back and posts it again. When the line
  // taken back was cleared on a FINISHED statement, its reversal pairs with
  // the line that replaced it — the same amount, back — and the two clear
  // together ($0.00), following re-posts of re-posts; otherwise both would
  // stay listed forever, and ticking one alone could never balance.
  const byPosting = new Map<string, LineRow[]>()
  for (const r of rows) {
    const l = byPosting.get(r.posting_id)
    if (l) l.push(r); else byPosting.set(r.posting_id, [r])
  }
  const openingChanged = new Set<string>()
  for (const r of rows) {
    if (r.role !== 'reversal' || !r.orig_frozen || pairs.has(r.id)) continue
    const want = -booksCents(r.amount)
    const seen = new Set<string>()
    let target = r.replaced_by
    let hit: LineRow | undefined
    while (target && !seen.has(target) && !hit) {
      seen.add(target)
      const cands = (byPosting.get(target) ?? []).filter(x => !pairs.has(x.id) && booksCents(x.amount) === want)
      hit = cands.find(x => x.line_no === r.line_no) ?? cands[0]
      target = byPosting.get(target)?.[0]?.superseded_by ?? null
    }
    if (hit) { pairs.add(r.id); pairs.add(hit.id); continue }
    // An opening balance that CHANGED after a finished statement: its old and
    // new lines are not cleared by themselves (the finished statement began
    // from the old figure) — undo that statement to take the new one in.
    if (r.source_type === 'opening') {
      openingChanged.add(r.id)
      for (const x of byPosting.get(r.replaced_by ?? '') ?? []) if (x.line_no === r.line_no) openingChanged.add(x.id)
    }
  }
  return rows.map((r) => {
    const cents = booksCents(r.amount)
    const bankOk = !!r.bank_line_id && !!r.bank_day && r.bank_day <= through
    let clearing: LineClearing = null
    let automatic = false
    if (pairs.has(r.id)) { clearing = 'cancels_out'; automatic = true }
    else if (openingChanged.has(r.id)) { clearing = r.item_id ? 'ticked' : null }
    else if (r.source_type === 'opening') { clearing = 'opening'; automatic = true }
    else if (bankOk) { clearing = 'bank_line'; automatic = true }
    else if (r.item_id) clearing = 'ticked'
    const what = SOURCE_WORDS[r.source_type] ?? 'Money'
    const changed = openingChanged.has(r.id)
      ? ' — the opening balance changed after an earlier statement was finished; undo that statement to start from the new figure'
      : ''
    return {
      lineId: r.id,
      day: r.day,
      bookedOn: r.booked_on !== r.day ? r.booked_on : null,
      amount: dollars(cents),
      description: (r.memo ? `${what}: ${r.memo}` : what) + changed,
      sourceType: r.source_type,
      journalEntry: r.source_type === 'manual_journal',
      takesBack: r.role === 'reversal',
      bankLine: r.bank_line_id && r.bank_day ? { id: r.bank_line_id, day: r.bank_day, description: r.bank_description } : null,
      clearing,
      automatic,
    }
  })
}

/** 10/12: classify, for its tests (pure: the rows one snapshot read). */
export const classifyStatementLines = classify

// ─── The worksheet ───────────────────────────────────────────────────────────

export interface ReconciliationRecord {
  id: string
  accountId: string
  status: BankReconciliationStatus
  statementDate: string
  statementBalance: number
  beginningBalance: number | null
  clearedBalance: number | null
  ledgerBalance: number | null
  openedAt: string
  completedAt: string | null
  undoneAt: string | null
  undoReason: string | null
  by: string | null
}

export interface Worksheet {
  account: ReconcileAccount
  /** The statement being worked (status open), or null when none is started. */
  reconciliation: ReconciliationRecord | null
  /** What a new statement would start from: the last completed statement's day + 1. */
  startsAfter: string | null
  beginningBalance: number
  /** Lines cleared on this statement (automatic + ticked), net. */
  clearedThisStatement: number
  clearedBalance: number
  /** Statement ending balance − cleared balance; $0.00 lets it finish. */
  difference: number | null
  /** Every line on the books for the account through the statement day. */
  ledgerBalance: number
  /** Lines through the statement day not cleared (what the statement does not show yet). */
  notCleared: number
  lines: StatementLine[]
  /** Hidden from the list: pairs that take each other back on this statement. */
  canceledPairs: number
  history: ReconciliationRecord[]
  canFinish: boolean
}

interface RecRow {
  id: string; account_id: string; status: BankReconciliationStatus; statement_date: string; statement_balance: string
  beginning_balance: string | null; cleared_balance: string | null; ledger_balance: string | null
  created_at: string; completed_at: string | null; undone_at: string | null; undo_reason: string | null; by_name: string | null
}
const REC_COLS = `r.id, r.account_id, r.status, r.statement_date::text AS statement_date, r.statement_balance::text AS statement_balance,
  r.beginning_balance::text AS beginning_balance, r.cleared_balance::text AS cleared_balance, r.ledger_balance::text AS ledger_balance,
  r.created_at::text AS created_at, r.completed_at::text AS completed_at, r.undone_at::text AS undone_at, r.undo_reason,
  NULLIF(btrim(concat_ws(' ', u.first_name, u.last_name)), '') AS by_name`
const REC_FROM = `bank_reconciliations r
  LEFT JOIN users u ON u.id = COALESCE(r.undone_by, r.completed_by, r.opened_by)`
const money = (s: string | null) => (s == null ? null : dollars(booksCents(s)))
function recordOf(r: RecRow): ReconciliationRecord {
  return {
    id: r.id, accountId: r.account_id, status: r.status, statementDate: r.statement_date,
    statementBalance: dollars(booksCents(r.statement_balance)),
    beginningBalance: money(r.beginning_balance), clearedBalance: money(r.cleared_balance), ledgerBalance: money(r.ledger_balance),
    openedAt: r.created_at, completedAt: r.completed_at, undoneAt: r.undone_at, undoReason: r.undo_reason, by: r.by_name,
  }
}

/** What the completed statements of the account left cleared (the next statement's beginning balance). */
async function clearedSoFarCents(c: Runner, accountId: string): Promise<number> {
  const r = await c.query<{ s: string }>(
    `SELECT COALESCE(sum(i.amount), 0)::text AS s
       FROM bank_reconciliation_items i JOIN bank_reconciliations r ON r.id = i.reconciliation_id
      WHERE i.account_id = $1 AND i.released_at IS NULL AND r.status = 'completed'`, [accountId])
  return booksCents(r.rows[0]?.s)
}

async function ledgerBalanceCents(c: Runner, accountId: string, through: string): Promise<number> {
  const r = await c.query<{ s: string }>(
    `SELECT COALESCE(sum(debit - credit), 0)::text AS s FROM ledger_posting_lines WHERE account_id = $1 AND accounting_date <= $2::date`,
    [accountId, through])
  return booksCents(r.rows[0]?.s)
}

async function lastCompleted(c: Runner, accountId: string): Promise<{ id: string; statement_date: string } | null> {
  return (await c.query<{ id: string; statement_date: string }>(
    `SELECT id, statement_date::text AS statement_date FROM bank_reconciliations
      WHERE account_id = $1 AND status = 'completed' AND statement_date IS NOT NULL
      ORDER BY statement_date DESC, completed_at DESC LIMIT 1`, [accountId])).rows[0] ?? null
}

async function historyOf(c: Runner, accountId: string): Promise<ReconciliationRecord[]> {
  return (await c.query<RecRow>(
    `SELECT ${REC_COLS} FROM ${REC_FROM}
      WHERE r.account_id = $1 AND r.statement_date IS NOT NULL AND r.status <> 'open'
      ORDER BY r.statement_date DESC, r.created_at DESC LIMIT 36`, [accountId])).rows.map(recordOf)
}

async function openOf(c: Runner, accountId: string): Promise<RecRow | null> {
  return (await c.query<RecRow>(
    `SELECT ${REC_COLS} FROM ${REC_FROM}
      WHERE r.account_id = $1 AND r.status = 'open' AND r.statement_date IS NOT NULL LIMIT 1`,
    [accountId])).rows[0] ?? null
}

async function worksheetOn(c: PoolClient, landlordId: string, accountId: string): Promise<Worksheet> {
  const account = await accountFor(c, landlordId, accountId)
  const open = await openOf(c, accountId)
  const last = await lastCompleted(c, accountId)
  const beginning = await clearedSoFarCents(c, accountId)
  const history = await historyOf(c, accountId)
  const startsAfter = last ? last.statement_date : null
  if (!open) {
    // Everything on the books for it to date, on the company's own calendar.
    const { today } = await loadOwnerContext(c, { landlordId })
    const ledger = await ledgerBalanceCents(c, accountId, today)
    return {
      account, reconciliation: null, startsAfter, beginningBalance: dollars(beginning), clearedThisStatement: 0,
      clearedBalance: dollars(beginning), difference: null, ledgerBalance: dollars(ledger), notCleared: dollars(ledger - beginning),
      lines: [], canceledPairs: 0, history, canFinish: false,
    }
  }
  const rec = recordOf(open)
  const lines = classify(await candidateLines(c, landlordId, accountId, rec.statementDate, rec.id), rec.statementDate)
  const clearedThis = lines.filter(l => l.clearing).reduce((s, l) => s + booksCents(l.amount), 0)
  const all = lines.reduce((s, l) => s + booksCents(l.amount), 0)
  const cleared = beginning + clearedThis
  const diff = booksCents(rec.statementBalance) - cleared
  const ledger = await ledgerBalanceCents(c, accountId, rec.statementDate)
  const canceledPairs = lines.filter(l => l.clearing === 'cancels_out').length / 2
  return {
    account, reconciliation: rec, startsAfter, beginningBalance: dollars(beginning),
    clearedThisStatement: dollars(clearedThis), clearedBalance: dollars(cleared), difference: dollars(diff),
    ledgerBalance: dollars(ledger), notCleared: dollars(all - clearedThis),
    // The pairs that cancel each other are counted, not listed.
    lines: lines.filter(l => l.clearing !== 'cancels_out'),
    canceledPairs, history, canFinish: diff === 0,
  }
}

/** The account's statement in progress (or what a new one starts from), its lines and its history. */
export async function getWorksheet(owner: LedgerOwner, accountId: string): Promise<Worksheet> {
  const landlordId = landlordOf(owner)
  return withClient(async (c) => {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    try {
      const w = await worksheetOn(c, landlordId, accountId)
      await c.query('COMMIT')
      return w
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {})
      throw e
    }
  })
}

// ─── Starting, changing, ticking, finishing, undoing ─────────────────────────

const ALREADY_OPEN = 'A statement for this account is already being reconciled. Finish it, change its date, or set it aside first.'

function statementRefusal(o: {
  statementDate: string; today: string; booksStartDate: string | null; lastCompletedDate: string | null
}): string | null {
  if (!ISO_DAY.test(o.statementDate)) return 'Enter the statement\'s last day.'
  if (o.statementDate > o.today) return 'A statement\'s last day cannot be after today.'
  if (o.booksStartDate && o.statementDate < o.booksStartDate) return `Your books start on ${o.booksStartDate}; reconcile a statement that ends on or after it.`
  if (o.lastCompletedDate && o.statementDate <= o.lastCompletedDate) {
    return `This account is reconciled through ${o.lastCompletedDate}. The next statement ends after that.`
  }
  return null
}

function balanceCents(v: unknown): number {
  const n = typeof v === 'string' ? (v.trim() === '' ? NaN : Number(v)) : v
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new AppError(400, 'Enter the statement\'s ending balance in dollars and cents.')
  return booksCents(n)
}

/**
 * Starts a statement for a bank account: its last day and ending balance (the
 * figure printed on the statement — never worked out for anyone).
 */
export async function startReconciliation(args: {
  owner: LedgerOwner; accountId: string | null; statementDate: string; statementBalance: number | string; actorUserId: string
}): Promise<Worksheet> {
  const landlordId = landlordOf(args.owner)
  const cents = balanceCents(args.statementBalance)
  return inTransaction(async (c) => {
    await assertMayReconcile(c, args.owner, args.actorUserId)
    const account = await resolveReconcileAccount(c, args.owner, args.accountId)
    if (await openOf(c, account.accountId)) throw new AppError(409, ALREADY_OPEN)
    const ctx = await loadOwnerContext(c, args.owner)
    const last = await lastCompleted(c, account.accountId)
    const refusal = statementRefusal({ statementDate: args.statementDate, today: ctx.today, booksStartDate: ctx.booksStartDate, lastCompletedDate: last?.statement_date ?? null })
    if (refusal) throw new AppError(400, refusal)
    const beginning = await clearedSoFarCents(c, account.accountId)
    const ledger = await ledgerBalanceCents(c, account.accountId, args.statementDate)
    const periodStart = last ? addDaysIso(last.statement_date, 1) : (ctx.booksStartDate && ctx.booksStartDate <= args.statementDate ? ctx.booksStartDate : `${args.statementDate.slice(0, 7)}-01`)
    try {
      await c.query(
        `INSERT INTO bank_reconciliations
           (landlord_id, account_id, period_start, period_end, statement_date, statement_balance, book_balance,
            beginning_balance, ledger_balance, status, opened_by)
         VALUES ($1, $2, $3, $4, $4, $5, $6, $6, $7, 'open', $8)`,
        [landlordId, account.accountId, periodStart, args.statementDate, (cents / 100).toFixed(2), (beginning / 100).toFixed(2),
         (ledger / 100).toFixed(2), args.actorUserId])
    } catch (e) {
      // Two people starting the same account at once: one statement in progress per account.
      if ((e as { code?: string }).code === '23505') throw new AppError(409, ALREADY_OPEN)
      throw e
    }
    return worksheetOn(c, landlordId, account.accountId)
  })
}

async function lockedOpen(c: PoolClient, landlordId: string, reconciliationId: string): Promise<RecRow> {
  const r = (await c.query<RecRow & { landlord_id: string }>(
    `SELECT ${REC_COLS}, r.landlord_id FROM ${REC_FROM}
      WHERE r.id = $1 AND r.statement_date IS NOT NULL FOR UPDATE OF r`, [reconciliationId])).rows[0]
  if (!r || r.landlord_id !== landlordId) throw new AppError(404, 'No such reconciliation.')
  if (r.status !== 'open') throw new AppError(409, r.status === 'completed' ? 'This statement is already reconciled.' : 'This statement was set aside.')
  return r
}

/** Changes the statement's last day or ending balance while it is being worked. Ticks after a new, earlier day come off. */
export async function updateReconciliation(args: {
  owner: LedgerOwner; reconciliationId: string; statementDate?: string; statementBalance?: number | string; actorUserId: string
}): Promise<Worksheet> {
  const landlordId = landlordOf(args.owner)
  return inTransaction(async (c) => {
    await assertMayReconcile(c, args.owner, args.actorUserId)
    const rec = await lockedOpen(c, landlordId, args.reconciliationId)
    const date = args.statementDate ?? rec.statement_date
    const cents = args.statementBalance === undefined ? booksCents(rec.statement_balance) : balanceCents(args.statementBalance)
    if (date !== rec.statement_date) {
      const ctx = await loadOwnerContext(c, args.owner)
      const last = await lastCompleted(c, rec.account_id)
      const refusal = statementRefusal({ statementDate: date, today: ctx.today, booksStartDate: ctx.booksStartDate, lastCompletedDate: last?.statement_date ?? null })
      if (refusal) throw new AppError(400, refusal)
      await c.query(
        `UPDATE bank_reconciliation_items i SET released_at = now(), released_by = $3, release_reason = 'unticked'
           FROM ledger_posting_lines l
          WHERE i.reconciliation_id = $1 AND i.released_at IS NULL AND l.id = i.ledger_line_id AND l.intended_date > $2::date`,
        [rec.id, date, args.actorUserId])
    }
    const ledger = await ledgerBalanceCents(c, rec.account_id, date)
    await c.query(
      `UPDATE bank_reconciliations
          SET statement_date = $2, period_end = $2, statement_balance = $3, ledger_balance = $4
        WHERE id = $1`, [rec.id, date, (cents / 100).toFixed(2), (ledger / 100).toFixed(2)])
    return worksheetOn(c, landlordId, rec.account_id)
  })
}

/**
 * Ticks lines off the statement (cleared = true) or takes ticks back off.
 * Lines that clear by themselves (a bank line, the opening balance, a pair
 * that takes itself back) are left as they are; taking one of those off is
 * refused with where to change it.
 */
export async function tickLines(args: {
  owner: LedgerOwner; reconciliationId: string; lineIds: string[]; cleared: boolean; actorUserId: string
}): Promise<Worksheet> {
  const landlordId = landlordOf(args.owner)
  const ids = [...new Set(args.lineIds)]
  if (!ids.length) throw new AppError(400, 'Choose the lines to tick.')
  if (ids.length > 2000) throw new AppError(400, 'Tick at most 2,000 lines at once.')
  return inTransaction(async (c) => {
    await assertMayReconcile(c, args.owner, args.actorUserId)
    const rec = await lockedOpen(c, landlordId, args.reconciliationId)
    const lines = classify(await candidateLines(c, landlordId, rec.account_id, rec.statement_date, rec.id), rec.statement_date)
    const byId = new Map(lines.map(l => [l.lineId, l]))
    for (const id of ids) {
      const l = byId.get(id)
      if (!l) throw new AppError(409, 'A line you chose is not on this statement (it is after the statement\'s last day, on another account, or cleared on an earlier statement).')
      if (l.automatic) {
        if (!args.cleared) {
          throw new AppError(409, l.clearing === 'bank_line'
            ? 'That line is matched to a bank line, so it is on the statement. If the match is wrong, undo it on the Bank page.'
            : 'That line clears by itself.')
        }
        continue
      }
      if (args.cleared && l.clearing !== 'ticked') {
        await c.query(
          `INSERT INTO bank_reconciliation_items (reconciliation_id, landlord_id, account_id, ledger_line_id, amount, day, source, ticked_by)
           VALUES ($1, $2, $3, $4, $5, $6, 'ticked', $7)`,
          [rec.id, landlordId, rec.account_id, id, l.amount.toFixed(2), l.day, args.actorUserId])
      } else if (!args.cleared && l.clearing === 'ticked') {
        await c.query(
          `UPDATE bank_reconciliation_items SET released_at = now(), released_by = $3, release_reason = 'unticked'
            WHERE reconciliation_id = $1 AND ledger_line_id = $2 AND released_at IS NULL`, [rec.id, id, args.actorUserId])
      }
    }
    return worksheetOn(c, landlordId, rec.account_id)
  })
}

/**
 * Finishes the statement when the difference is $0.00: every line that clears
 * by itself is written down beside the ticked ones and all of them freeze.
 */
export async function completeReconciliation(args: {
  owner: LedgerOwner; reconciliationId: string; actorUserId: string
}): Promise<Worksheet> {
  const landlordId = landlordOf(args.owner)
  return inTransaction(async (c) => {
    await takeSharedOwnerLock(c, args.owner)
    await assertMayReconcile(c, args.owner, args.actorUserId)
    const rec = await lockedOpen(c, landlordId, args.reconciliationId)
    const rows = await candidateLines(c, landlordId, rec.account_id, rec.statement_date, rec.id)
    const lines = classify(rows, rec.statement_date)
    const beginning = await clearedSoFarCents(c, rec.account_id)
    const clearedThis = lines.filter(l => l.clearing).reduce((s, l) => s + booksCents(l.amount), 0)
    const diff = booksCents(rec.statement_balance) - (beginning + clearedThis)
    if (diff !== 0) {
      throw new AppError(409, `The statement and the cleared balance are ${moneyText(diff)} apart. Tick what is on the statement (or add what is missing) until the difference is $0.00.`)
    }
    const alreadyItems = new Set(rows.filter(r => r.item_id).map(r => r.id))
    for (const l of lines) {
      if (!l.automatic || !l.clearing || alreadyItems.has(l.lineId)) continue
      await c.query(
        `INSERT INTO bank_reconciliation_items
           (reconciliation_id, landlord_id, account_id, ledger_line_id, amount, day, bank_transaction_id, source, ticked_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [rec.id, landlordId, rec.account_id, l.lineId, l.amount.toFixed(2), l.day,
         l.clearing === 'bank_line' ? l.bankLine?.id ?? null : null, l.clearing, args.actorUserId])
    }
    const ledger = await ledgerBalanceCents(c, rec.account_id, rec.statement_date)
    const cleared = ((beginning + clearedThis) / 100).toFixed(2)
    await c.query(
      `UPDATE bank_reconciliations
          SET status = 'completed', completed_at = now(), completed_by = $2,
              beginning_balance = $3, cleared_balance = $4, book_balance = $4, ledger_balance = $5
        WHERE id = $1`,
      [rec.id, args.actorUserId, (beginning / 100).toFixed(2), cleared, (ledger / 100).toFixed(2)])
    return worksheetOn(c, landlordId, rec.account_id)
  })
}

/**
 * Takes a statement back, always saying why: one being worked is set aside;
 * a completed one is undone only when it is the account's latest, nothing is
 * being worked after it, and it covers no day of a closed month. Its lines
 * are let go (the record is kept) and can clear on another statement.
 *
 * 10/12 (Nic, review): "covers" is the statement's whole span, from its first
 * day — a statement running 9/16–10/15 is what let September close (a month
 * closes when each bank's latest statement ends on or after its end), so it
 * stays while September is closed. And the undo takes the company's shared
 * books lock first, like a posting, so it waits for a close in progress (and
 * a close waits for it): a month can never close on a statement being undone.
 */
export async function undoReconciliation(args: {
  owner: LedgerOwner; reconciliationId: string; reason: string; actorUserId: string
}): Promise<Worksheet> {
  const landlordId = landlordOf(args.owner)
  const reason = (args.reason ?? '').trim()
  if (!reason) throw new AppError(400, 'Say why this reconciliation is being undone.')
  return inTransaction(async (c) => {
    await takeSharedOwnerLock(c, args.owner)
    await assertMayReconcile(c, args.owner, args.actorUserId)
    const r = (await c.query<{ id: string; landlord_id: string; account_id: string; status: BankReconciliationStatus; statement_date: string; period_start: string | null }>(
      `SELECT id, landlord_id, account_id, status, statement_date::text AS statement_date, period_start::text AS period_start
         FROM bank_reconciliations
        WHERE id = $1 AND statement_date IS NOT NULL FOR UPDATE`, [args.reconciliationId])).rows[0]
    if (!r || r.landlord_id !== landlordId) throw new AppError(404, 'No such reconciliation.')
    if (r.status === 'undone') throw new AppError(409, 'This reconciliation was already undone.')
    if (r.status === 'completed') {
      const last = await lastCompleted(c, r.account_id)
      if (last?.id !== r.id) throw new AppError(409, 'Only the latest reconciled statement of an account can be undone. Undo the later ones first.')
      if (await openOf(c, r.account_id)) throw new AppError(409, 'A later statement is being worked. Set it aside first.')
      const ctx = await loadOwnerContext(c, args.owner)
      if (ctx.closedThrough && (r.period_start ?? r.statement_date) <= ctx.closedThrough) {
        throw new AppError(409, `The books are closed through ${ctx.closedThrough}. Reopen that month to undo this reconciliation.`)
      }
    }
    await c.query(
      `UPDATE bank_reconciliations SET status = 'undone', undone_at = now(), undone_by = $2, undo_reason = $3 WHERE id = $1`,
      [r.id, args.actorUserId, reason.slice(0, 500)])
    await c.query(
      `UPDATE bank_reconciliation_items SET released_at = now(), released_by = $2, release_reason = 'reconciliation_undone'
        WHERE reconciliation_id = $1 AND released_at IS NULL`, [r.id, args.actorUserId])
    return worksheetOn(c, landlordId, r.account_id)
  })
}

/** Every ledger reconciliation of the company, newest first (the landlord's history list). */
export async function listReconciliations(owner: LedgerOwner): Promise<(ReconciliationRecord & { accountName: string })[]> {
  const landlordId = landlordOf(owner)
  return withClient(async (c) => (await c.query<RecRow & { account_name: string }>(
    `SELECT ${REC_COLS}, concat_ws(' ', a.code, a.name) AS account_name
       FROM ${REC_FROM} JOIN books_accounts a ON a.id = r.account_id
      WHERE r.landlord_id = $1 AND r.statement_date IS NOT NULL
      ORDER BY r.statement_date DESC, r.created_at DESC LIMIT 200`, [landlordId])).rows
    .map(r => ({ ...recordOf(r), accountName: r.account_name })))
}

// ─── For the close-month preflight ───────────────────────────────────────────

export interface UnreconciledAccount { accountId: string; name: string; linked: boolean; reconciledThrough: string | null }

/**
 * The company's bank accounts with money on the books on or before `through`
 * whose latest completed statement ends before `through`. A linked bank
 * account (a bank feed) blocks the close; one with no feed only warns.
 * Reads on `c`'s snapshot.
 */
export async function bankAccountsNotReconciledThrough(c: Runner, owner: LedgerOwner, through: string): Promise<UnreconciledAccount[]> {
  if (!owner.landlordId) return []
  const rows = (await c.query<AccountRow>(
    `${ACCOUNTS_SQL}
       AND EXISTS (SELECT 1 FROM ledger_posting_lines l WHERE l.account_id = a.id AND l.accounting_date <= $3::date)
       AND COALESCE((SELECT max(r.statement_date) FROM bank_reconciliations r
                      WHERE r.account_id = a.id AND r.status = 'completed' AND r.statement_date IS NOT NULL), '0001-01-01'::date) < $3::date
     ORDER BY a.code, a.name`, [owner.landlordId, BANK_ROLES, through])).rows
  return rows.map(r => ({ accountId: r.id, name: `${r.code} ${r.name}`, linked: !!r.bank_connection_id, reconciledThrough: r.reconciled_through }))
}

// ─── The nightly look at each bank account (design §8, informational) ───────

/**
 * 10/12 (Nic, ledger §8, "1010 per connection | informational"): every night,
 * beside the tie-outs, each bank account of the company is looked at — never
 * drift, never a block, kept with the night's run:
 *   bank_reconciling_items  a bookkeeper's journal lines on a bank account that
 *                           no reconciled statement has cleared (no bank line
 *                           stands behind them)
 *   bank_balance_vs_books   a linked bank's own balance (the feed's latest),
 *                           less the lines nobody has filed yet, beside what
 *                           the books say is in that account. The difference
 *                           is what has not cleared (checks out, deposits on
 *                           their way) — or something to look at.
 */
export const bankAccountsCheck: LedgerCheck = {
  name: 'bank_accounts',
  async run(client, owner): Promise<LedgerFinding[]> {
    if (!owner.landlordId) return []
    const out: LedgerFinding[] = []
    const journal = (await client.query<{ account_id: string; name: string; n: number; s: string }>(
      `WITH acct AS (${ACCOUNTS_SQL})
       SELECT acct.id AS account_id, concat_ws(' ', acct.code, acct.name) AS name, count(*)::int AS n, sum(l.debit - l.credit)::text AS s
         FROM acct
         JOIN ledger_posting_lines l ON l.account_id = acct.id
         JOIN ledger_postings p ON p.id = l.posting_id AND p.source_type = 'manual_journal'
        WHERE NOT EXISTS (SELECT 1 FROM bank_reconciliation_items i JOIN bank_reconciliations r ON r.id = i.reconciliation_id
                           WHERE i.ledger_line_id = l.id AND i.released_at IS NULL AND r.status = 'completed')
        GROUP BY acct.id, acct.code, acct.name`, [owner.landlordId, BANK_ROLES])).rows
    for (const j of journal) {
      out.push({ check: 'bank_reconciling_items', severity: 'info', detail: { accountId: j.account_id, name: j.name, lines: j.n, net: dollars(booksCents(j.s)) } })
    }
    const banks = (await client.query<{ account_id: string; name: string; bank: string | null; as_of: string | null; unfiled: string; books: string }>(
      `WITH acct AS (${ACCOUNTS_SQL})
       SELECT acct.id AS account_id, concat_ws(' ', acct.code, acct.name) AS name,
              bc.current_balance::text AS bank, bc.balance_as_of::text AS as_of,
              COALESCE((SELECT sum(bt.amount) FROM bank_transactions bt
                         WHERE bt.bank_connection_id = bc.id AND bt.status = 'needs_review'), 0)::text AS unfiled,
              COALESCE((SELECT sum(l.debit - l.credit) FROM ledger_posting_lines l WHERE l.account_id = acct.id), 0)::text AS books
         FROM acct JOIN bank_connections bc ON bc.id = acct.bank_connection_id
        WHERE bc.current_balance IS NOT NULL`, [owner.landlordId, BANK_ROLES])).rows
    for (const b of banks) {
      const bankLessUnfiled = booksCents(b.bank) - booksCents(b.unfiled)
      const books = booksCents(b.books)
      if (bankLessUnfiled === books) continue
      out.push({ check: 'bank_balance_vs_books', severity: 'info', detail: {
        accountId: b.account_id, name: b.name, bankBalance: dollars(booksCents(b.bank)), asOf: b.as_of,
        unfiled: dollars(booksCents(b.unfiled)), onTheBooks: dollars(books), notCleared: dollars(bankLessUnfiled - books),
      } })
    }
    return out
  },
}

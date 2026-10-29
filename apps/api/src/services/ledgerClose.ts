/**
 * 10/12 (Nic) — GAM BOOKS LEDGER: CLOSING A MONTH, AND THE COMPANY'S BOOKS SETTINGS
 *
 *   L3 "close/reopen month: landlord's choice (owner decides who can close
 *       and reopen)"; closing is optional.
 *   L4 "fix in an open month: landlord's choice (change that month vs show on
 *       day made)"; after a close, fixes post to the open month, labeled as
 *       corrections.
 *
 * (gam-ledger-design-2026-10-12 §13.) A close locks the company's books
 * through a month's last day. Operations are NEVER blocked by it: anything
 * dated in a closed month still happens, and its ledger lines land on the
 * first open day (they keep their own date as intended_date). The database
 * refuses a ledger line or a journal entry dated in a closed month
 * (20261013200300 / 200400) — the engine never asks it to.
 *
 * SERIALIZATION. Posters, journal entries and the line backstop take the
 * company's ledger lock SHARED before they read the lock date; close and
 * reopen take it EXCLUSIVELY and write the close row and its balance snapshot
 * in the same transaction. A line can therefore never commit into a month after
 * that month's snapshot was taken: a poster that started first finishes first
 * and is in the snapshot; one that starts after reads the new lock date and
 * lands in the next month.
 *
 * WHO. An owner always may: the company's founding user (landlords.user_id) or
 * any co-owner (landlord_members, role 'owner' — a partner invited to the
 * company is an owner of it, S605). A bookkeeper may only when the
 * company's setting says so (books_close_by / books_reopen_by =
 * 'owner_or_bookkeeper') AND the bookkeeper has the company-wide box
 * (bookkeeper_scopes company_wide). 10/12 (Nic, ledger decision 2): one level —
 * every bookkeeper the company keeps does the bookkeeping, so there is no
 * read-only bookkeeper to refuse (access_level decides nothing).
 * A reopen always says why. The owner is told when someone else closes or
 * reopens their books. The settings themselves are the owner's alone.
 *
 * PREFLIGHT for a close: nothing of the company's is still waiting in the
 * outbox or failing to post (it drains the company first; a backdated desk
 * payment or a late bank date means age alone is not enough), every
 * integrity check and money tie-out is clean, and (10/12, P9) every linked
 * bank account with money on the books is reconciled through the month's end
 * (services/bankReconciliation). WARNINGS never block: bank lines nobody filed,
 * money in "Suspense: to classify", unpaid bills past due, a bank account with
 * no feed not reconciled. The person closing sees them, and the close keeps
 * what they were shown (books_period_closes.warnings).
 *
 * THE SCREEN (10/12, P9): Books → Close month (routes/booksClose.ts,
 * getCloseStatus) shows the checklist for the month to close, the history of
 * closes and reopens, and who may do which — the company's Books Settings
 * choice. No automatic close: Books Settings offers none.
 *
 * 10/12 (Nic) review — THE EXCLUSIVE HOLD LASTS AN INSTANT. Posters wait on the
 * company lock while a close holds it, so the close never does its slow work
 * there: who is asking is checked first (a user who may not close never sets
 * off a drain); the preflight and the balance snapshot are read on ONE
 * REPEATABLE READ snapshot before the lock; under the exclusive lock the close
 * only re-checks that nothing arrived since that snapshot (the company's
 * postings — append-only, so their count moves with any new one — the last
 * close or reopen, nothing waiting, nothing failing) and writes the close row
 * and the snapshot it already read. If something did arrive, it drains and
 * tries again (three times, then asks the user to try again in a minute).
 * All of it runs on the books' own pool (db/ledgerPool).
 *
 */
import type { PoolClient } from 'pg'
import {
  LEDGER_CLOSE_PERMISSIONS, LEDGER_OPEN_MONTH_FIX_MODES, booksCents,
  type LedgerClosePermission, type LedgerOpenMonthFixMode, type LedgerCloseWarning,
} from '@gam/shared'
import { db, query } from '../db'
import { ledgerConnect } from '../db/ledgerPool'
import { AppError } from '../middleware/errorHandler'
import { createNotification } from './notifications'
import { companyWideSql } from '../lib/bookkeeperScope'
import {
  type LedgerOwner, type LedgerOwnerContext, ownerColOf, ownerIdOf, ownerLockText, loadOwnerContext, isMonthEnd, addDaysIso, ISO_DAY,
  monthEndIso,
} from './ledgerOwner'
import { drainLedgerOutbox, drainableLedgerOutboxTypes } from './ledgerEngine'
import { engineChecks, runRegisteredChecks, type LedgerFinding } from './ledgerCheck'
import { bankAccountsNotReconciledThrough } from './bankReconciliation'

/** Test hook: called once a close/reopen holds the exclusive lock (concurrency tests pause here). */
export const ledgerCloseTestHooks: { afterExclusiveLock?: (owner: LedgerOwner) => Promise<void> } = {}

export type LedgerCloseAction = 'close' | 'reopen'

/** Is this user an owner of the company: its founding user, or a co-owner (landlord_members)? */
type Queryable = { query: (sql: string, params: unknown[]) => Promise<{ rows: { ok: boolean }[] }> }
async function isCompanyOwner(c: Queryable, userId: string, landlordId: string): Promise<boolean> {
  const r = await c.query(
    `SELECT EXISTS (SELECT 1 FROM landlords WHERE id = $2 AND user_id = $1)
         OR EXISTS (SELECT 1 FROM landlord_members WHERE landlord_id = $2 AND user_id = $1 AND role = 'owner') AS ok`,
    [userId, landlordId])
  return !!r.rows[0]?.ok
}

/** Every owner of the company (founding user and co-owners), for the close notices. */
async function companyOwnerUserIds(landlordId: string): Promise<string[]> {
  const r = await query<{ id: string }>(
    `SELECT user_id AS id FROM landlords WHERE id = $1
     UNION SELECT user_id FROM landlord_members WHERE landlord_id = $1 AND role = 'owner'`, [landlordId])
  return r.map(x => x.id)
}

/** Is this user a bookkeeper of the company with the company-wide box? (10/12: one level — no read-only bookkeeper.) */
async function isCompanyWideWriteBookkeeper(c: PoolClient, userId: string, landlordId: string): Promise<boolean> {
  const r = await c.query<{ ok: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM bookkeeper_scopes bs
        WHERE bs.user_id = $1 AND bs.landlord_id = $2
          AND ${companyWideSql('bs')}) AS ok`, [userId, landlordId])
  return !!r.rows[0]?.ok
}

/**
 * May `userId` close (or reopen) this company's months? Returns the refusal in
 * plain words, or null when allowed.
 */
export async function closePermissionRefusal(
  c: PoolClient, owner: LedgerOwner, userId: string, action: LedgerCloseAction,
): Promise<string | null> {
  if (!owner.landlordId) return 'A business\'s books close in a later phase.'
  const ctx = await loadOwnerContext(c, owner)
  if (!ctx.exists) return 'No such company.'
  if (await isCompanyOwner(c, userId, owner.landlordId)) return null
  const setting: LedgerClosePermission = action === 'close' ? ctx.closeBy : ctx.reopenBy
  if (setting === 'owner') {
    return action === 'close' ? 'Only the owner closes a month in these books.' : 'Only the owner reopens a closed month in these books.'
  }
  if (await isCompanyWideWriteBookkeeper(c, userId, owner.landlordId)) return null
  return `Only the owner, or a bookkeeper with the company-wide box, may ${action} a month.`
}

export interface CloseResult {
  closeId: string
  closedThrough: string | null
  snapshotRows: number
}

/**
 * Tells every owner of the company (but the one who did it) when their books
 * were closed or reopened. Called only AFTER the close commits
 * (createNotification writes on its own connection, so a notice sent inside
 * the transaction could announce a close that then rolled back). Never throws.
 */
async function notifyOwners(owner: LedgerOwner, actorUserId: string, title: string, body: string): Promise<void> {
  if (!owner.landlordId) return
  try {
    for (const userId of await companyOwnerUserIds(owner.landlordId)) {
      if (userId === actorUserId) continue
      await createNotification({ userId, landlordId: owner.landlordId, type: 'books_month_close', title, body, sendEmail: false })
    }
  } catch { /* a notice never undoes a close */ }
}

/** Runs `fn` on a books connection (db/ledgerPool), released afterwards. */
async function withLedgerClient<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await ledgerConnect()
  try {
    return await fn(c)
  } finally {
    c.release()
  }
}

/**
 * What the exclusive lock re-checks (10/12 (Nic) review): the same values
 * mean nothing reached the company's books since the snapshot was read.
 */
interface LedgerMarks { postings: number; lastCloseId: string | null; waiting: number; failing: number; reconciled: string }
async function ledgerMarks(c: PoolClient, owner: LedgerOwner): Promise<LedgerMarks> {
  const col = ownerColOf(owner)
  const r = (await c.query<{ postings: number; last_close: string | null; waiting: number; failing: number; reconciled: string }>(
    `SELECT (SELECT count(*)::int FROM ledger_postings WHERE ${col} = $1) AS postings,
            (SELECT max(id)::text FROM books_period_closes WHERE ${col} = $1) AS last_close,
            -- 10/12 (P9): a statement undone since the snapshot changes this.
            -- 10/12 (Nic, review): every statement and its standing, not a
            -- count — one undone and another completed between the snapshot
            -- and the lock would leave a count unchanged.
            (SELECT COALESCE(md5(string_agg(r.id::text || ':' || r.status || ':' || COALESCE(r.completed_at::text, '')
                                            || ':' || COALESCE(r.undone_at::text, ''), ',' ORDER BY r.id)), '')
               FROM bank_reconciliations r
              WHERE r.${col} = $1 AND r.statement_date IS NOT NULL) AS reconciled,
            (SELECT count(*)::int FROM ledger_outbox
              WHERE source_type = ANY($2::text[]) AND (owner_id = $1 OR owner_id IS NULL)) AS waiting,
            (SELECT count(*)::int FROM ledger_source_errors
              WHERE owner_id = $1 AND source_type = ANY($2::text[])) AS failing`,
    [ownerIdOf(owner), drainableLedgerOutboxTypes()])).rows[0]
  return { postings: r.postings, lastCloseId: r.last_close, waiting: r.waiting, failing: r.failing, reconciled: r.reconciled }
}

interface BalanceRow { account_id: string; property_id: string | null; debits: string; credits: string }
/** Each account's debits and credits per property, accounting dates through `through`, on `c`'s snapshot. */
async function balancesThrough(c: PoolClient, owner: LedgerOwner, through: string): Promise<BalanceRow[]> {
  return (await c.query<BalanceRow>(
    `SELECT l.account_id, l.property_id, sum(l.debit)::text AS debits, sum(l.credit)::text AS credits
       FROM ledger_posting_lines l
      WHERE l.${ownerColOf(owner)} = $1 AND l.accounting_date <= $2::date
      GROUP BY l.account_id, l.property_id`, [ownerIdOf(owner), through])).rows
}

/** Writes a close's (or a reopen's) balance snapshot. Returns the rows written. */
async function writeSnapshot(c: PoolClient, owner: LedgerOwner, closeId: string, rows: BalanceRow[]): Promise<number> {
  if (rows.length === 0) return 0
  const r = await c.query(
    `INSERT INTO ledger_close_balances (close_id, ${ownerColOf(owner)}, account_id, property_id, debits, credits)
     SELECT $1::bigint, $2, x.a, x.p, x.d, x.c
       FROM unnest($3::uuid[], $4::uuid[], $5::numeric[], $6::numeric[]) AS x(a, p, d, c)`,
    [closeId, ownerIdOf(owner), rows.map(b => b.account_id), rows.map(b => b.property_id), rows.map(b => b.debits), rows.map(b => b.credits)])
  return r.rowCount ?? 0
}

function closeDateRefusal(ctx: LedgerOwnerContext, through: string): string | null {
  if (through >= ctx.today) return 'A month can be closed once it has ended.'
  if (ctx.closedThrough && through <= ctx.closedThrough) return `The books are already closed through ${ctx.closedThrough}.`
  return null
}

/**
 * Closes the company's books through `through` (a month's last day, before
 * today on the company's calendar, after any month already closed).
 */
export async function closeMonth(args: {
  owner: LedgerOwner; through: string; actorUserId: string; reason?: string | null
}): Promise<CloseResult> {
  const { owner, through, actorUserId } = args
  if (!ISO_DAY.test(through) || !isMonthEnd(through)) throw new AppError(400, 'Close through the last day of a month.')
  // 10/12 (Nic) review: who is asking, first — before any drain.
  const refusal = await withLedgerClient(c => closePermissionRefusal(c, owner, actorUserId, 'close'))
  if (refusal) throw new AppError(403, refusal)

  for (let attempt = 1; ; attempt++) {
    // Drain first (the preflight refuses anything left); failing sources get a
    // fresh try on the first pass.
    await drainLedgerOutbox({ ownerId: ownerIdOf(owner), ignoreBackoff: attempt === 1, maxMs: 120_000 })

    // The slow part, on one snapshot, before the lock.
    const pre = await withLedgerClient(async (c) => {
      await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      try {
        const ctx = await loadOwnerContext(c, owner)
        const dateRefusal = closeDateRefusal(ctx, through)
        if (dateRefusal) throw new AppError(409, dateRefusal)
        const problems = await closePreflight(c, owner, through)
        const marks = await ledgerMarks(c, owner)
        const balances = problems.length ? [] : await balancesThrough(c, owner, through)
        // 10/12 (P9): what the person closing is warned about, kept on the close.
        const warnings = problems.length ? [] : await closeWarnings(c, owner, through)
        await c.query('COMMIT')
        return { problems, marks, balances, warnings }
      } catch (e) {
        await c.query('ROLLBACK').catch(() => {})
        throw e
      }
    })
    if (pre.problems.length) {
      const first = blockerOf(pre.problems[0], through)
      throw new AppError(409, `The books are not ready to close: ${first.text}${pre.problems.length > 1 ? ` (and ${pre.problems.length - 1} more)` : ''}.`)
    }

    // The instant under the exclusive lock.
    let done: CloseResult | null = null
    const c = await ledgerConnect()
    try {
      await c.query('BEGIN')
      const again = await closePermissionRefusal(c, owner, actorUserId, 'close')
      if (again) throw new AppError(403, again)
      await c.query(`SET LOCAL lock_timeout = '10s'`)
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [ownerLockText(owner)])
      if (ledgerCloseTestHooks.afterExclusiveLock) await ledgerCloseTestHooks.afterExclusiveLock(owner)
      const ctx = await loadOwnerContext(c, owner)
      const dateRefusal = closeDateRefusal(ctx, through)
      if (dateRefusal) throw new AppError(409, dateRefusal)
      const now = await ledgerMarks(c, owner)
      const unchanged = now.postings === pre.marks.postings && now.lastCloseId === pre.marks.lastCloseId
        && now.reconciled === pre.marks.reconciled && now.waiting === 0 && now.failing === 0
      if (!unchanged) {
        await c.query('ROLLBACK')
      } else {
        const row = (await c.query<{ id: string }>(
          `INSERT INTO books_period_closes (${ownerColOf(owner)}, action, closed_through, reason, acted_by, warnings)
           VALUES ($1, 'close', $2, $3, $4, $5::jsonb) RETURNING id::text AS id`,
          [ownerIdOf(owner), through, args.reason?.trim() || null, actorUserId, JSON.stringify(pre.warnings)])).rows[0]
        const snapshotRows = await writeSnapshot(c, owner, row.id, pre.balances)
        await c.query('COMMIT')
        done = { closeId: row.id, closedThrough: through, snapshotRows }
      }
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      c.release()
    }
    if (done) {
      await notifyOwners(owner, actorUserId, 'A month was closed in your books',
        `Your books were closed through ${through}. Anything dated on or before it now shows as a correction in the next open month.`)
      return done
    }
    if (attempt >= 3) throw new AppError(409, 'Money is still posting to these books. Try the close again in a minute.')
  }
}

/**
 * Everything that must be true before a month closes, read on the close's
 * snapshot: nothing waiting or failing for the company, every check clean,
 * and (10/12, P9) every linked bank account with money on the books
 * reconciled through the month's end.
 */
async function closePreflight(c: PoolClient, owner: LedgerOwner, through: string): Promise<LedgerFinding[]> {
  const out: LedgerFinding[] = []
  const marks = await ledgerMarks(c, owner)
  if (marks.waiting > 0) out.push({ check: 'waiting', severity: 'pending', detail: { waiting: marks.waiting } })
  if (marks.failing > 0) out.push({ check: 'failing', severity: 'pending', detail: { failing: marks.failing } })
  for (const f of await engineChecks(c, owner)) {
    if (f.severity === 'integrity') out.push(f)
  }
  out.push(...(await runRegisteredChecks(c, owner)).filter(f => f.severity === 'integrity' || f.severity === 'drift'))
  for (const a of await bankAccountsNotReconciledThrough(c, owner, through)) {
    if (a.linked) out.push({ check: 'bank_not_reconciled', severity: 'pending', detail: { ...a } })
  }
  return out
}

// ─── The close-month screen (10/12, P9) ──────────────────────────────────────

/** One thing that stops a month from closing, in plain words. */
export interface CloseBlocker { key: string; text: string }
/** One thing the person closing is warned about; it never stops the close. */
export interface CloseWarningItem { kind: LedgerCloseWarning; count: number; amount: number; text: string }

const moneyText = (cents: number) =>
  `$${(Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/**
 * The books checks a close waits on, in plain words (services/ledgerCheck and
 * each projector phase's tie-outs). GAM is told about each one every night;
 * the fix is never a balancing entry — the record is re-posted from source.
 */
const CHECK_WORDS: Record<string, string> = {
  unbalanced: 'a posting does not balance',
  too_few_lines: 'a posting is missing a line',
  line_mismatch: 'a line is filed under the wrong posting',
  chain_broken: 'a correction does not match what it corrects',
  fingerprint_mismatch: 'a posting no longer matches its record',
  closed_month_changed: 'a closed month\'s balances changed',
  source_drift: 'some records\' postings are out of date',
  tenant_receivables: 'what tenants owe does not match their open bills',
  undeposited_funds: 'undeposited funds do not match the drawer and desk receipts',
  deposits_in_transit: 'deposits in transit do not match the deposits not yet at the bank',
  tenant_prepayments: 'paid-ahead money does not match what tenants paid ahead',
  security_deposits_payable: 'security deposits owed back do not match the deposits held',
  deposits_gam_holds: 'the deposits GAM holds for you do not match',
  home_notes_receivable: 'home-sale notes do not match what buyers still owe',
  outstanding_checks: 'outstanding checks and debits do not match what is still to clear',
  settled_rows_explained: 'a paid bill has no payment that explains it',
  accounts_payable: 'accounts payable does not match the unpaid bills',
  due_from_gam: 'money due from GAM does not match what GAM holds for you',
  sold_property_receipts: 'a payment for a sold property is waiting for review',
  p5_stripe_in_transit: 'money on its way from Stripe does not match the payouts',
  p5_due_to_gam: 'what you owe GAM does not match its charges',
}

/** A preflight finding as the screen says it. */
export function blockerOf(f: LedgerFinding, through: string): CloseBlocker {
  if (f.check === 'waiting') {
    const n = Number(f.detail.waiting) || 0
    return { key: 'waiting', text: `${plural(n, 'money record is', 'money records are')} still waiting to post to the books — check again in a minute` }
  }
  if (f.check === 'failing') {
    const n = Number(f.detail.failing) || 0
    return { key: 'failing', text: `${plural(n, 'money record', 'money records')} could not post to the books; GAM has been told` }
  }
  if (f.check === 'bank_not_reconciled') {
    const d = f.detail as { accountId?: string; name?: string; reconciledThrough?: string | null }
    return {
      key: `bank:${d.accountId ?? ''}`,
      text: `${d.name ?? 'A linked bank account'} is ${d.reconciledThrough ? `reconciled only through ${d.reconciledThrough}` : 'not reconciled yet'} — reconcile its statement through ${through}`,
    }
  }
  const base = f.check.replace(/_reader_pieces$/, '')
  return { key: `check:${f.check}`, text: `${CHECK_WORDS[base] ?? 'a books check does not tie out'} — GAM checks this every night and fixes it from the records` }
}

/**
 * What the person closing `through` is warned about (never blocks), read on
 * `c`'s snapshot: bank lines nobody filed, money left in Suspense, unpaid
 * bills past due, a bank account with no feed not reconciled.
 */
export async function closeWarnings(c: PoolClient, owner: LedgerOwner, through: string): Promise<CloseWarningItem[]> {
  if (!owner.landlordId) return []
  const id = owner.landlordId
  const out: CloseWarningItem[] = []
  const unfiled = (await c.query<{ n: number; s: string }>(
    `SELECT count(*)::int AS n, COALESCE(sum(abs(amount)), 0)::text AS s FROM bank_transactions
      WHERE landlord_id = $1 AND status = 'needs_review' AND posted_date <= $2::date`, [id, through])).rows[0]
  if (unfiled.n > 0) {
    out.push({ kind: 'unfiled_bank_lines', count: unfiled.n, amount: booksCents(unfiled.s) / 100,
      text: `${plural(unfiled.n, 'bank line', 'bank lines')} dated on or before ${through} ${unfiled.n === 1 ? 'is' : 'are'} not filed yet (${moneyText(booksCents(unfiled.s))}). File ${unfiled.n === 1 ? 'it' : 'them'} on the Bank page, or close anyway and file ${unfiled.n === 1 ? 'it' : 'them'} later — ${unfiled.n === 1 ? 'it' : 'they'} will show as corrections.` })
  }
  const suspense = (await c.query<{ n: number; s: string }>(
    `SELECT count(DISTINCT l.posting_id)::int AS n, COALESCE(sum(l.debit - l.credit), 0)::text AS s
       FROM ledger_posting_lines l
      WHERE l.landlord_id = $1 AND l.account_role = 'suspense' AND l.accounting_date <= $2::date`, [id, through])).rows[0]
  const suspenseCents = booksCents(suspense.s)
  if (suspenseCents !== 0) {
    out.push({ kind: 'suspense_balance', count: suspense.n, amount: suspenseCents / 100,
      text: `${moneyText(suspenseCents)} is sitting in Suspense: to classify on ${through}. Say what it was with a journal entry, or close anyway.` })
  }
  const overdue = (await c.query<{ n: number; s: string }>(
    `SELECT count(*)::int AS n, COALESCE(sum(v.unpaid), 0)::text AS s
       FROM v_expense_balance v JOIN landlord_expenses e ON e.id = v.expense_id
      WHERE e.landlord_id = $1 AND v.unpaid > 0 AND e.due_date IS NOT NULL AND e.due_date <= $2::date`, [id, through])).rows[0]
  if (overdue.n > 0) {
    out.push({ kind: 'overdue_bills', count: overdue.n, amount: booksCents(overdue.s) / 100,
      text: `${plural(overdue.n, 'unpaid bill was', 'unpaid bills were')} due on or before ${through} (${moneyText(booksCents(overdue.s))} still owed). They stay owed after the close.` })
  }
  for (const a of await bankAccountsNotReconciledThrough(c, owner, through)) {
    if (a.linked) continue
    out.push({ kind: 'unlinked_bank_not_reconciled', count: 1, amount: 0,
      text: `${a.name} has no linked bank feed and is ${a.reconciledThrough ? `reconciled only through ${a.reconciledThrough}` : 'not reconciled'}. Reconcile it against its statement, or close anyway.` })
  }
  return out
}

export interface CloseHistoryRow {
  id: string
  action: 'close' | 'reopen'
  closedThrough: string | null
  reason: string | null
  by: string | null
  at: string
  warnings: CloseWarningItem[]
}

export interface CloseStatus {
  closedThrough: string | null
  booksStartDate: string | null
  today: string
  closeBy: LedgerClosePermission
  reopenBy: LedgerClosePermission
  /** May the person looking close, and reopen? (the company's Books Settings choice) */
  canClose: boolean
  closeRefusal: string | null
  canReopen: boolean
  reopenRefusal: string | null
  /** The month the screen offers to close (its last day): the one after the last close, once it has ended. */
  nextThrough: string | null
  /** The month this checklist is for (its last day), or null when there is nothing to close yet. */
  through: string | null
  ready: boolean
  blockers: CloseBlocker[]
  warnings: CloseWarningItem[]
  history: CloseHistoryRow[]
}

/** The month after the last close (or the books' first month), if it has ended. */
function nextThroughOf(ctx: LedgerOwnerContext): string | null {
  const start = ctx.closedThrough ? addDaysIso(ctx.closedThrough, 1)
    : ctx.booksStartDate ?? addDaysIso(`${ctx.today.slice(0, 7)}-01`, -1)
  const end = monthEndIso(start)
  return end < ctx.today ? end : null
}

/**
 * The close-month screen: the checklist for `through` (default: the next
 * month to close), what blocks and what only warns, who may close and
 * reopen, and every close and reopen so far. Read on one snapshot; drains
 * nothing (runCloseCheck does, then reads).
 */
export async function getCloseStatus(args: { owner: LedgerOwner; viewerUserId: string; through?: string | null }): Promise<CloseStatus> {
  const { owner } = args
  if (!owner.landlordId) throw new AppError(409, 'A business\'s books close in a later phase.')
  if (args.through && (!ISO_DAY.test(args.through) || !isMonthEnd(args.through))) throw new AppError(400, 'Choose a month to close.')
  return withLedgerClient(async (c) => {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    try {
      const ctx = await loadOwnerContext(c, owner)
      if (!ctx.exists) throw new AppError(404, 'No such company.')
      const closeRefusal = await closePermissionRefusal(c, owner, args.viewerUserId, 'close')
      const reopenRefusal = await closePermissionRefusal(c, owner, args.viewerUserId, 'reopen')
      const nextThrough = nextThroughOf(ctx)
      const through = args.through ?? nextThrough
      let blockers: CloseBlocker[] = []
      let warnings: CloseWarningItem[] = []
      if (through) {
        const dateRefusal = closeDateRefusal(ctx, through)
        // One line per kind of problem (a check can find the same thing many times).
        const seen = new Set<string>()
        blockers = (dateRefusal ? [{ key: 'date', text: dateRefusal }]
          : (await closePreflight(c, owner, through)).map(f => blockerOf(f, through)))
          .filter(x => !seen.has(x.key) && !!seen.add(x.key))
        if (!dateRefusal) warnings = await closeWarnings(c, owner, through)
      }
      const history = (await c.query<{
        id: string; action: 'close' | 'reopen'; closed_through: string | null; reason: string | null; by_name: string | null
        at: string; warnings: CloseWarningItem[]
      }>(
        `SELECT c.id::text AS id, c.action, c.closed_through::text AS closed_through, c.reason,
                NULLIF(btrim(concat_ws(' ', u.first_name, u.last_name)), '') AS by_name, c.acted_at::text AS at, c.warnings
           FROM books_period_closes c LEFT JOIN users u ON u.id = c.acted_by
          WHERE c.${ownerColOf(owner)} = $1 ORDER BY c.id DESC LIMIT 100`, [ownerIdOf(owner)])).rows
      await c.query('COMMIT')
      return {
        closedThrough: ctx.closedThrough, booksStartDate: ctx.booksStartDate, today: ctx.today,
        closeBy: ctx.closeBy, reopenBy: ctx.reopenBy,
        canClose: !closeRefusal, closeRefusal, canReopen: !reopenRefusal && !!ctx.closedThrough,
        reopenRefusal: ctx.closedThrough ? reopenRefusal : 'No month is closed.',
        nextThrough, through: through ?? null, ready: !!through && blockers.length === 0,
        blockers, warnings,
        history: history.map(h => ({
          id: h.id, action: h.action, closedThrough: h.closed_through, reason: h.reason, by: h.by_name, at: h.at,
          warnings: Array.isArray(h.warnings) ? h.warnings : [],
        })),
      }
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {})
      throw e
    }
  })
}

/**
 * "Check again": posts whatever of the company's money is still waiting (a
 * fresh try for anything that failed), then reads the checklist. Only for
 * someone who may see the screen (the route decides); it changes nothing a
 * person decided.
 */
export async function runCloseCheck(args: { owner: LedgerOwner; viewerUserId: string; through?: string | null }): Promise<CloseStatus> {
  if (!args.owner.landlordId) throw new AppError(409, 'A business\'s books close in a later phase.')
  await drainLedgerOutbox({ ownerId: ownerIdOf(args.owner), ignoreBackoff: true, maxMs: 60_000 })
  return getCloseStatus(args)
}

/**
 * Reopens `month` (any day in it) and every month after it: the lock moves to
 * the day before that month. Earlier months stay closed — a close "through
 * September 30" locked everything up to that day, so reopening September leaves
 * August as it was (design §13: "Reopening a month also reopens the later
 * ones"). When no month of the books is left before it (the lock would fall
 * before the books start date), nothing stays closed. Always with a reason.
 *
 * 10/12 (Nic) review: when months stay closed, the reopen takes their balance
 * snapshot under its own row, so the nightly check keeps proving they never
 * change. Those months were closed before and stay closed, so their lines
 * cannot move: the snapshot is read before the lock and re-read under it only
 * if another close or reopen came in between.
 */
export async function reopenMonth(args: {
  owner: LedgerOwner; month: string; actorUserId: string; reason: string
}): Promise<CloseResult> {
  const { owner, actorUserId } = args
  if (!ISO_DAY.test(args.month)) throw new AppError(400, 'Choose the month to reopen.')
  const reason = (args.reason ?? '').trim()
  if (!reason) throw new AppError(400, 'Say why the month is being reopened.')
  const monthStart = `${args.month.slice(0, 7)}-01`
  const refusal = await withLedgerClient(c => closePermissionRefusal(c, owner, actorUserId, 'reopen'))
  if (refusal) throw new AppError(403, refusal)
  const keepOf = (ctx: LedgerOwnerContext): string | null => {
    const newThrough = addDaysIso(monthStart, -1)
    return ctx.booksStartDate && newThrough < ctx.booksStartDate ? null : newThrough
  }
  const pre = await withLedgerClient(async (c) => {
    const ctx = await loadOwnerContext(c, owner)
    const marks = await ledgerMarks(c, owner)
    const keep = keepOf(ctx)
    return { lastCloseId: marks.lastCloseId, keep, balances: keep && ctx.closedThrough && ctx.closedThrough >= monthStart ? await balancesThrough(c, owner, keep) : [] }
  })
  const c = await ledgerConnect()
  try {
    await c.query('BEGIN')
    const again = await closePermissionRefusal(c, owner, actorUserId, 'reopen')
    if (again) throw new AppError(403, again)
    await c.query(`SET LOCAL lock_timeout = '10s'`)
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [ownerLockText(owner)])
    if (ledgerCloseTestHooks.afterExclusiveLock) await ledgerCloseTestHooks.afterExclusiveLock(owner)
    const ctx = await loadOwnerContext(c, owner)
    if (!ctx.closedThrough || ctx.closedThrough < monthStart) throw new AppError(409, 'That month is not closed.')
    const keep = keepOf(ctx)
    const lastCloseId = (await ledgerMarks(c, owner)).lastCloseId
    const balances = keep === null ? []
      : lastCloseId === pre.lastCloseId && keep === pre.keep ? pre.balances
      : await balancesThrough(c, owner, keep)
    const row = (await c.query<{ id: string }>(
      `INSERT INTO books_period_closes (${ownerColOf(owner)}, action, closed_through, reason, acted_by)
       VALUES ($1, 'reopen', $2, $3, $4) RETURNING id::text AS id`,
      [ownerIdOf(owner), keep, reason, actorUserId])).rows[0]
    const snapshotRows = await writeSnapshot(c, owner, row.id, balances)
    await c.query('COMMIT')
    await notifyOwners(owner, actorUserId, 'A closed month was reopened in your books',
      `${monthStart.slice(0, 7)} and every month after it were reopened. Reason: ${reason}`)
    return { closeId: row.id, closedThrough: keep, snapshotRows }
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    c.release()
  }
}

export interface LedgerSettings {
  closeBy: LedgerClosePermission
  reopenBy: LedgerClosePermission
  openMonthFixes: LedgerOpenMonthFixMode
  timezone: string
  timezonePinned: boolean
  closedThrough: string | null
  booksStartDate: string | null
}

export async function getLedgerSettings(landlordId: string): Promise<LedgerSettings> {
  const c = await db.connect()
  try {
    const ctx = await loadOwnerContext(c, { landlordId })
    if (!ctx.exists) throw new AppError(404, 'No such company.')
    const pinned = (await c.query<{ p: boolean }>(`SELECT books_timezone IS NOT NULL AS p FROM landlords WHERE id = $1`, [landlordId])).rows[0].p
    return {
      closeBy: ctx.closeBy, reopenBy: ctx.reopenBy, openMonthFixes: ctx.openMonthFixes,
      timezone: ctx.timezone, timezonePinned: pinned, closedThrough: ctx.closedThrough, booksStartDate: ctx.booksStartDate,
    }
  } finally {
    c.release()
  }
}

/**
 * An owner (the founding user or a co-owner) changes who may close and reopen,
 * and where open-month fixes show. Owners only. (A fix-mode change applies to fixes made from now on;
 * nothing already posted moves.) The books calendar can be set only before the
 * company's first posting — after that, moving it would re-date posted history.
 */
export async function setLedgerSettings(args: {
  landlordId: string; actorUserId: string
  closeBy?: LedgerClosePermission; reopenBy?: LedgerClosePermission
  openMonthFixes?: LedgerOpenMonthFixMode; timezone?: string
}): Promise<LedgerSettings> {
  const owner = await query<{ user_id: string }>(`SELECT user_id FROM landlords WHERE id = $1`, [args.landlordId])
  if (!owner[0]) throw new AppError(404, 'No such company.')
  if (!(await isCompanyOwner(db, args.actorUserId, args.landlordId))) {
    throw new AppError(403, 'Only the owner changes how the books close.')
  }
  if (args.closeBy && !(LEDGER_CLOSE_PERMISSIONS as readonly string[]).includes(args.closeBy)) throw new AppError(400, 'Choose who may close a month.')
  if (args.reopenBy && !(LEDGER_CLOSE_PERMISSIONS as readonly string[]).includes(args.reopenBy)) throw new AppError(400, 'Choose who may reopen a month.')
  if (args.openMonthFixes && !(LEDGER_OPEN_MONTH_FIX_MODES as readonly string[]).includes(args.openMonthFixes)) {
    throw new AppError(400, 'Choose where fixes to an open month show.')
  }
  if (args.timezone !== undefined) {
    const ok = await query<{ ok: boolean }>(`SELECT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = $1) AS ok`, [args.timezone])
    if (!ok[0]?.ok) throw new AppError(400, 'That is not a time zone.')
    const posted = await query<{ p: boolean }>(`SELECT EXISTS (SELECT 1 FROM ledger_postings WHERE landlord_id = $1) AS p`, [args.landlordId])
    if (posted[0]?.p) throw new AppError(409, 'The books already have postings dated on their calendar; it cannot move now.')
  }
  await query(
    `UPDATE landlords
        SET books_close_by = COALESCE($2, books_close_by),
            books_reopen_by = COALESCE($3, books_reopen_by),
            books_open_month_fixes = COALESCE($4, books_open_month_fixes),
            books_timezone = COALESCE($5, books_timezone),
            updated_at = now()
      WHERE id = $1`,
    [args.landlordId, args.closeBy ?? null, args.reopenBy ?? null, args.openMonthFixes ?? null, args.timezone ?? null])
  return getLedgerSettings(args.landlordId)
}

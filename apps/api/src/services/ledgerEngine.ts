/**
 * 10/12 (Nic) — GAM BOOKS LEDGER: THE ENGINE (phase P3, "ledger engine, dark")
 *
 *   Nic: "within a minute (+ nightly tie-out check)"
 *
 * Every money event posts its own balanced lines automatically, each line
 * tagged with its property, every line rebuildable from the source rows
 * (gam-ledger-design-2026-10-12 §3, §8, §9, §13). This file is the engine; the
 * per-event projectors (what a rent charge, a receipt, a payout posts) arrive
 * in later phases and plug in through the registry below.
 *
 * HOW A MONEY CHANGE BECOMES LINES
 *   1. Inside the money transaction, a statement-level trigger appends the
 *      changed source's key to ledger_outbox (migration 20261013200600). That
 *      is all that runs inside a money write.
 *   2. After commit: the drain (every minute, drainLedgerOutbox) or the kick
 *      right after a commit (kickLedgerAfterCommit) reads outbox rows and posts
 *      each source key in ONE SHORT TRANSACTION of its own (postSource):
 *        a. advisory lock on the source (two posters of one source take turns);
 *        b. the projector reads the committed source rows and returns the
 *           postings it wants (one per company and posting kind; a missing row
 *           wants nothing);
 *        c. the shared per-company ledger lock, then the company's books start
 *           date, lock date and settings (a close takes the same lock
 *           exclusively, so the lock date cannot move under us);
 *        d. each line's posting role is resolved to the company's account
 *           through books_account_map on the line's intended date (the chart is
 *           fully editable — Nic 10/12). 10/13 (Nic): a new posting written
 *           now never names a deleted account — the account that took its
 *           place takes the line, a late record for a closed month included
 *           ("The replacement"); an active posting is unchanged while it
 *           carries what was right where it sits (a closed month keeps the
 *           account it was posted to — booksLedgerChart.accountTakingOver).
 *           A reversal (step e) still negates the posting it takes back line
 *           for line, on the accounts it was posted to — a deleted one too;
 *        e. fingerprint = sha256 of the intended lines (date, resolved account,
 *           property and other dimensions, cents). Equal to the active
 *           posting's: nothing to do. Otherwise the active posting is
 *           superseded — a reversal negates it line for line — and the new
 *           posting is written;
 *        f. dates: a posting lands on its intended date, or on the first open
 *           day when that month is closed (it keeps its intended_date, and
 *           reads as a correction). A CORRECTION (re-projection of a source
 *           that already posted) to an open month follows the company's choice
 *           (Nic 10/12, L4): 'restate' changes that month; 'day_made' shows it
 *           on the day the fix was made — 10/13 (Nic): automatic changes too
 *           (a fee true-up, a webhook, a rule re-posted by the nightly check);
 *           only GAM's own rebuilds keep the original dates;
 *        g. lines that do not balance per property get inter-property clearing
 *           lines; lines that do not balance at all are refused;
 *        h. exactly the outbox ids this pass read for the key are deleted, in
 *           the same transaction (a writer that committed after the read has a
 *           new id and stays for the next pass).
 *   3. A source that fails keeps its outbox rows; ledger_source_errors says
 *      why, counts the tries and sets the next try (an admin notice after 3).
 *
 * A BOOKS PROBLEM NEVER BLOCKS MONEY: the projector, the balance check and the
 * closed-period backstop all run in the poster's own transaction; a money
 * write only ever inserts outbox rows. 10/12 (Nic) review: every poster, the
 * drain, its runner lock and the kick run on the books' own small pool
 * (db/ledgerPool), never on a connection a money request needs; a poster waits
 * at most a second for a lock (a month close holds the company lock only for
 * an instant) and otherwise says "busy" and leaves its outbox rows for the next
 * minute; and the after-commit kicks go through one in-process queue, one at a
 * time, each transaction once.
 *
 * DARK: production registers no projector yet (services/ledgerProjectors), so
 * the drain finds nothing to post and the outbox simply fills until the
 * projector phases ship. Nothing reads the ledger yet.
 */
import { createHash, randomUUID } from 'crypto'
import type { PoolClient } from 'pg'
import {
  LEDGER_ACCOUNT_ROLE_BY_NAME, LEDGER_POSTING_KINDS, LEDGER_REPORT_CATEGORIES, LEDGER_CASH_EFFECTS,
  LEDGER_SOURCE_TYPES, LEDGER_OUTBOX_BOOKS_START, ledgerCentsToNumeric,
  type LedgerAccountRole, type LedgerSourceType, type LedgerPostingKind, type LedgerReportCategory,
  type LedgerCashEffect, type LedgerMapKind, type LedgerSourceErrorReason,
} from '@gam/shared'
import { ledgerConnect, ledgerQuery } from '../db/ledgerPool'
import { logger } from '../lib/logger'
import { createAdminNotification } from './adminNotifications'
import {
  type LedgerOwner, type LedgerOwnerContext, ownerIdOf, ownerColOf, ownerKeyOf, ownerFromRow, ownerLockText,
  loadOwnerContext, maxIso, sameOwner, ISO_DAY, pinBooksTimezone, addDaysIso,
} from './ledgerOwner'
import {
  ensureChart, readChart, resolveAccount, accountTakingOver, LedgerOwnerNotReadyError,
  type ChartState, type AccountSelector, type ResolvedAccount,
} from './booksLedgerChart'

// ─── What a projector returns ────────────────────────────────────────────────

/** One line a projector wants posted. Exactly one of debitCents / creditCents is a positive whole number of cents. */
export interface DesiredLine {
  /** The posting role the line books to (resolved through the company's map). */
  role?: LedgerAccountRole
  /** A bank's or a named tax's own sub-account under its role. */
  sub?: AccountSelector['sub']
  /** An exact account — only for a bookkeeper's journal line mirrored into the ledger. */
  accountId?: string
  debitCents?: number
  creditCents?: number
  propertyId?: string | null
  unitId?: string | null
  leaseId?: string | null
  tenantId?: string | null
  vendorId?: string | null
  paymentId?: string | null
  reportCategory?: LedgerReportCategory | null
  expenseKind?: string | null
  cashEffect?: LedgerCashEffect | null
  taxName?: string | null
  memo?: string | null
  systemLine?: boolean
}

/** One posting a projector wants: one per (company, posting kind) per source. */
export interface DesiredPosting {
  owner: LedgerOwner
  postingKind?: LedgerPostingKind
  /** The event's own day, 'YYYY-MM-DD', on the property's (or company's) calendar. */
  intendedDate: string
  memo?: string | null
  lines: DesiredLine[]
}

/** A source and the day it happened, for ordering a rebuild. */
export interface LedgerSourceRef { id: string; day?: string | null }

/**
 * A projector turns one source's COMMITTED rows into the postings it wants.
 * Projectors read facts, never current state (design §8): stored splits and
 * dates, never platform_held, a charge's collected_amount, books_accounts.balance
 * or today's property settings. A missing source row wants nothing (its
 * postings are reversed).
 */
export interface LedgerProjector {
  sourceType: LedgerSourceType
  /** Bumped when the rule changes; metadata only (the fingerprint decides). */
  ruleVersion: number
  project(client: PoolClient, sourceId: string): Promise<DesiredPosting[]>
  /** The sources of this type a company has today (a rebuild adds the ones with postings). */
  listSources(client: PoolClient, owner: LedgerOwner, opts: { since?: string | null }): Promise<LedgerSourceRef[]>
}

// ─── The registry ────────────────────────────────────────────────────────────

const registry = new Map<LedgerSourceType, LedgerProjector>()

/** Registers (or replaces) the projector for a source type. */
export function registerLedgerProjector(p: LedgerProjector): void {
  if (!(LEDGER_SOURCE_TYPES as readonly string[]).includes(p.sourceType)) {
    throw new Error(`Unknown ledger source type: ${p.sourceType}`)
  }
  registry.set(p.sourceType, p)
}
/** Removes a source type's projector (tests). */
export function unregisterLedgerProjector(sourceType: LedgerSourceType): void {
  registry.delete(sourceType)
}
export function ledgerProjectorFor(sourceType: string): LedgerProjector | null {
  return registry.get(sourceType as LedgerSourceType) ?? null
}
/** The source types that can post right now. Outbox rows of any other type wait. */
export function registeredLedgerSourceTypes(): LedgerSourceType[] {
  return [...registry.keys()]
}
/**
 * The outbox types the drain works right now: the registered source types,
 * plus a moved books start date's mark (LEDGER_OUTBOX_BOOKS_START) once
 * anything posts at all. "Waiting to post" means these (the close preflight,
 * the nightly check, the stale-outbox notice).
 */
export function drainableLedgerOutboxTypes(): string[] {
  const types: string[] = registeredLedgerSourceTypes()
  return types.length ? [...types, LEDGER_OUTBOX_BOOKS_START] : []
}

/** A uuid (an outbox owner_id names a company by its id). */
const ISO_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// ─── Errors ──────────────────────────────────────────────────────────────────

export class LedgerSourceError extends Error {
  constructor(readonly reasonCode: LedgerSourceErrorReason, message: string) {
    super(message)
  }
}

function asSourceError(e: unknown, fallback: LedgerSourceErrorReason): LedgerSourceError {
  if (e instanceof LedgerSourceError) return e
  if (e instanceof LedgerOwnerNotReadyError) return new LedgerSourceError('owner_not_ready', e.message)
  const msg = e instanceof Error ? e.message : String(e)
  return new LedgerSourceError(fallback, msg)
}

// ─── Test hooks (concurrency tests pause here; never set in production) ──────

export const ledgerTestHooks: {
  /** Called after the shared company lock is taken, before the lock date is read. */
  afterOwnerLock?: (owner: LedgerOwner, sourceType: string, sourceId: string) => Promise<void>
  /** Called with every line written and the outbox rows deleted, just before COMMIT (the most a poster ever holds). */
  beforeCommit?: (sourceType: string, sourceId: string) => Promise<void>
} = {}

// ─── Lines: validation, clearing, fingerprint ───────────────────────────────

interface ResolvedLine extends DesiredLine {
  debitCents: number
  creditCents: number
  account: ResolvedAccount
}

function isWholeCents(n: unknown): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0
}

/**
 * Checks a projector's postings and adds inter-property clearing lines where
 * value moves between properties (design §9): every posting must balance for
 * each property on its own, NULL (company level) included.
 */
export function normalizeDesired(desired: DesiredPosting[], sourceType: string, sourceId: string): DesiredPosting[] {
  const seen = new Set<string>()
  return desired.map((p) => {
    const kind = p.postingKind ?? 'main'
    if (!(LEDGER_POSTING_KINDS as readonly string[]).includes(kind)) {
      throw new LedgerSourceError('projector_error', `Unknown posting kind ${kind} for ${sourceType} ${sourceId}`)
    }
    if (!p.owner || (!p.owner.landlordId && !p.owner.businessId)) {
      throw new LedgerSourceError('projector_error', `A ${sourceType} posting names no company`)
    }
    const key = `${ownerKeyOf(p.owner)}|${kind}`
    if (seen.has(key)) throw new LedgerSourceError('projector_error', `${sourceType} ${sourceId} wants two ${kind} postings for one company`)
    seen.add(key)
    if (!ISO_DAY.test(p.intendedDate)) throw new LedgerSourceError('projector_error', `Bad intended date ${p.intendedDate}`)
    const lines: DesiredLine[] = []
    let dr = 0
    let cr = 0
    const byProperty = new Map<string, number>()
    for (const l of p.lines) {
      const d = l.debitCents ?? 0
      const c = l.creditCents ?? 0
      if (!isWholeCents(d) || !isWholeCents(c) || (d > 0) === (c > 0)) {
        throw new LedgerSourceError('projector_error', `A ${sourceType} line needs exactly one positive whole-cent side (got ${d} / ${c})`)
      }
      if (!l.accountId) {
        if (!l.role || !LEDGER_ACCOUNT_ROLE_BY_NAME[l.role]) throw new LedgerSourceError('projector_error', `Unknown posting role ${l.role}`)
        if (LEDGER_ACCOUNT_ROLE_BY_NAME[l.role].computed) throw new LedgerSourceError('projector_error', `${l.role} is worked out, never posted`)
      }
      if (l.reportCategory && !(LEDGER_REPORT_CATEGORIES as readonly string[]).includes(l.reportCategory)) {
        throw new LedgerSourceError('projector_error', `Unknown report category ${l.reportCategory}`)
      }
      if (l.cashEffect && !(LEDGER_CASH_EFFECTS as readonly string[]).includes(l.cashEffect)) {
        throw new LedgerSourceError('projector_error', `Unknown cash effect ${l.cashEffect}`)
      }
      dr += d
      cr += c
      const pk = l.propertyId ?? ''
      byProperty.set(pk, (byProperty.get(pk) ?? 0) + d - c)
      lines.push({ ...l, debitCents: d, creditCents: c })
    }
    if (dr !== cr) {
      throw new LedgerSourceError('unbalanced', `${sourceType} ${sourceId}: debits ${dr} ≠ credits ${cr} (cents)`)
    }
    if (lines.length === 0) return { ...p, postingKind: kind, lines }
    // Clearing lines, in a stable order (property id).
    for (const [pk, net] of [...byProperty.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      if (net === 0) continue
      lines.push({
        role: 'interproperty_clearing',
        propertyId: pk === '' ? null : pk,
        debitCents: net < 0 ? -net : 0,
        creditCents: net > 0 ? net : 0,
        memo: 'Moved between properties',
        systemLine: true,
      })
    }
    return { ...p, postingKind: kind, lines }
  })
}

/** The canonical form of one line for the fingerprint (and for comparing stored lines). */
export function lineTuple(day: string, l: {
  accountId: string; accountRole: string | null; mapKind: string | null; mapValue: string | null
  propertyId?: string | null; unitId?: string | null; leaseId?: string | null; tenantId?: string | null
  vendorId?: string | null; paymentId?: string | null; reportCategory?: string | null; expenseKind?: string | null
  cashEffect?: string | null; taxName?: string | null; systemLine?: boolean; debitCents: number; creditCents: number
}): string {
  return JSON.stringify([
    day, l.accountId, l.accountRole ?? '', l.mapKind ?? '', l.mapValue ?? '',
    l.propertyId ?? '', l.unitId ?? '', l.leaseId ?? '', l.tenantId ?? '', l.vendorId ?? '', l.paymentId ?? '',
    l.reportCategory ?? '', l.expenseKind ?? '', l.cashEffect ?? '', l.taxName ?? '', l.systemLine ? 1 : 0,
    l.debitCents, l.creditCents,
  ])
}

/** sha256 of the sorted line tuples. Memos and rule versions are not part of it. */
export function fingerprintOf(tuples: string[]): string {
  return createHash('sha256').update(JSON.stringify([...tuples].sort())).digest('hex')
}

/**
 * 10/12 (Nic) review: a line tuple WITHOUT its account — what the line says
 * (day, posting role, dimensions, cents) rather than where the chart put it.
 * Two postings with the same content differ only by the company's chart (a
 * repointed role, a deleted account's replacement) or not at all (a forced
 * rebuild): re-posting them is never a landlord's fix, so it keeps its dates.
 */
function contentTuple(tuple: string): string {
  const t = JSON.parse(tuple) as unknown[]
  t.splice(1, 1)   // [day, accountId, …] → [day, …]
  return JSON.stringify(t)
}
function contentFingerprintOf(tuples: string[]): string {
  return fingerprintOf(tuples.map(contentTuple))
}

/** Line tuples of a posting's STORED lines. */
async function storedTuples(client: PoolClient, postingId: string): Promise<string[]> {
  const r = await client.query<any>(
    `SELECT intended_date::text AS day, account_id, account_role, map_kind, map_value, property_id, unit_id, lease_id,
            tenant_id, vendor_id, payment_id, report_category, expense_kind, cash_effect, tax_name, system_line,
            round(debit * 100)::bigint AS dr, round(credit * 100)::bigint AS cr
       FROM ledger_posting_lines WHERE posting_id = $1`, [postingId])
  return r.rows.map(x => lineTuple(x.day, {
    accountId: x.account_id, accountRole: x.account_role, mapKind: x.map_kind, mapValue: x.map_value,
    propertyId: x.property_id, unitId: x.unit_id, leaseId: x.lease_id, tenantId: x.tenant_id, vendorId: x.vendor_id,
    paymentId: x.payment_id, reportCategory: x.report_category, expenseKind: x.expense_kind, cashEffect: x.cash_effect,
    taxName: x.tax_name, systemLine: x.system_line, debitCents: Number(x.dr), creditCents: Number(x.cr),
  }))
}

/** Fingerprint of a posting's STORED lines (the nightly check recomputes it). */
export async function storedFingerprint(client: PoolClient, postingId: string): Promise<string> {
  return fingerprintOf(await storedTuples(client, postingId))
}

async function resolveLines(
  client: PoolClient, chart: ChartState, p: DesiredPosting, readOnly: boolean,
): Promise<ResolvedLine[] | null> {
  const out: ResolvedLine[] = []
  for (const l of p.lines) {
    const account = await resolveAccount(client, chart, { role: l.role, sub: l.sub, accountId: l.accountId }, p.intendedDate, { readOnly })
    if (!account) {
      if (readOnly) return null
      throw new LedgerSourceError('post_error', `No account for posting role ${l.role ?? '(none)'}`)
    }
    out.push({ ...l, debitCents: l.debitCents ?? 0, creditCents: l.creditCents ?? 0, account })
  }
  return out
}

/**
 * 10/13 (Nic): the lines with each deleted account handed to the account that
 * took its place (booksLedgerChart.accountTakingOver) — every one of them for
 * a new posting written now (`on` omitted; a reversal is never handed on: it
 * negates the active posting line for line), or only where the replacement had
 * taken over by `on`, the day an active posting sits on. "A record dated
 * inside an already-closed month that arrives after its account was deleted
 * posts as a correction in the open month to the replacement."
 */
function takenOver(chart: ChartState, lines: ResolvedLine[], on?: string): ResolvedLine[] {
  return lines.map((l) => {
    const accountId = accountTakingOver(chart, l.account.accountId, on)
    return accountId === l.account.accountId ? l : { ...l, account: { ...l.account, accountId } }
  })
}

function tuplesOf(day: string, lines: ResolvedLine[]): string[] {
  return lines.map(l => lineTuple(day, {
    accountId: l.account.accountId, accountRole: l.account.accountRole, mapKind: l.account.mapKind, mapValue: l.account.mapValue,
    propertyId: l.propertyId, unitId: l.unitId, leaseId: l.leaseId, tenantId: l.tenantId, vendorId: l.vendorId,
    paymentId: l.paymentId, reportCategory: l.reportCategory, expenseKind: l.expenseKind, cashEffect: l.cashEffect,
    taxName: l.taxName, systemLine: l.systemLine, debitCents: l.debitCents, creditCents: l.creditCents,
  }))
}

// ─── Active postings ─────────────────────────────────────────────────────────

interface ActivePosting {
  id: string
  landlord_id: string | null
  business_id: string | null
  posting_kind: LedgerPostingKind
  fingerprint: string
  intended_date: string
  accounting_date: string
  is_correction: boolean
}

async function loadActivePostings(client: PoolClient, sourceType: string, sourceId: string): Promise<ActivePosting[]> {
  const r = await client.query<ActivePosting>(
    `SELECT id, landlord_id, business_id, posting_kind, fingerprint,
            intended_date::text AS intended_date, accounting_date::text AS accounting_date, is_correction
       FROM ledger_postings
      WHERE source_type = $1 AND source_id = $2 AND role = 'post' AND superseded_at IS NULL`, [sourceType, sourceId])
  return r.rows
}

// ─── Writing ─────────────────────────────────────────────────────────────────

async function insertPosting(client: PoolClient, a: {
  id: string; owner: LedgerOwner; sourceType: string; sourceId: string; kind: string; isCorrection: boolean
  intendedDate: string; accountingDate: string; fingerprint: string; ruleVersion: number
  postedBy: string | null; rebuildRunId: string | null; memo: string | null; lines: ResolvedLine[]
}): Promise<void> {
  await client.query(
    `INSERT INTO ledger_postings (id, ${ownerColOf(a.owner)}, source_type, source_id, posting_kind, role, is_correction,
                                  intended_date, accounting_date, fingerprint, rule_version, posted_by, rebuild_run_id, memo)
     VALUES ($1, $2, $3, $4, $5, 'post', $6, $7, $8, $9, $10, $11, $12, $13)`,
    [a.id, ownerIdOf(a.owner), a.sourceType, a.sourceId, a.kind, a.isCorrection, a.intendedDate, a.accountingDate,
     a.fingerprint, a.ruleVersion, a.postedBy, a.rebuildRunId, a.memo])
  const cols = ['posting_id', 'line_no', ownerColOf(a.owner), 'accounting_date', 'intended_date', 'account_id', 'account_role',
    'map_kind', 'map_value', 'property_id', 'unit_id', 'lease_id', 'tenant_id', 'vendor_id', 'payment_id',
    'report_category', 'expense_kind', 'cash_effect', 'tax_name', 'debit', 'credit', 'memo', 'system_line']
  const params: unknown[] = []
  const rows: string[] = []
  a.lines.forEach((l, i) => {
    const vals = [a.id, i + 1, ownerIdOf(a.owner), a.accountingDate, a.intendedDate, l.account.accountId, l.account.accountRole,
      l.account.mapKind, l.account.mapValue, l.propertyId ?? null, l.unitId ?? null, l.leaseId ?? null, l.tenantId ?? null,
      l.vendorId ?? null, l.paymentId ?? null, l.reportCategory ?? null, l.expenseKind ?? null, l.cashEffect ?? null,
      l.taxName ?? null, ledgerCentsToNumeric(l.debitCents), ledgerCentsToNumeric(l.creditCents), l.memo ?? null, !!l.systemLine]
    const ph = vals.map((v) => { params.push(v); return `$${params.length}` })
    rows.push(`(${ph.join(', ')})`)
  })
  await client.query(`INSERT INTO ledger_posting_lines (${cols.join(', ')}) VALUES ${rows.join(', ')}`, params)
}

async function insertReversal(client: PoolClient, a: {
  id: string; active: ActivePosting; accountingDate: string; ruleVersion: number; postedBy: string | null; rebuildRunId: string | null
}): Promise<void> {
  await client.query(
    `INSERT INTO ledger_postings (id, landlord_id, business_id, source_type, source_id, posting_kind, role, is_correction,
                                  intended_date, accounting_date, fingerprint, rule_version, reverses_posting_id,
                                  posted_by, rebuild_run_id, memo)
     SELECT $1, landlord_id, business_id, source_type, source_id, posting_kind, 'reversal', TRUE,
            intended_date, $3, fingerprint, $4, id, $5, $6, 'Takes back an earlier posting of the same record'
       FROM ledger_postings WHERE id = $2`,
    [a.id, a.active.id, a.accountingDate, a.ruleVersion, a.postedBy, a.rebuildRunId])
  await client.query(
    `INSERT INTO ledger_posting_lines (posting_id, line_no, landlord_id, business_id, accounting_date, intended_date,
                                       account_id, account_role, map_kind, map_value, property_id, unit_id, lease_id,
                                       tenant_id, vendor_id, payment_id, report_category, expense_kind, cash_effect,
                                       tax_name, debit, credit, memo, system_line)
     SELECT $1, line_no, landlord_id, business_id, $3, intended_date,
            account_id, account_role, map_kind, map_value, property_id, unit_id, lease_id,
            tenant_id, vendor_id, payment_id, report_category, expense_kind, cash_effect,
            tax_name, credit, debit, memo, system_line
       FROM ledger_posting_lines WHERE posting_id = $2 ORDER BY line_no`,
    [a.id, a.active.id, a.accountingDate])
}

// ─── Posting one source ──────────────────────────────────────────────────────

export interface PostSourceOptions {
  /** The outbox rows this pass read for the key; deleted with the posting. */
  outboxIds?: string[]
  /** Re-post even when the lines are unchanged (from_scratch): every company, or just this one. */
  force?: boolean | LedgerOwner
  rebuildRunId?: string | null
  /** Who caused the posting (NULL = the system). */
  actorUserId?: string | null
  /** The company the outbox named, for the error record when the projector itself fails. */
  ownerHint?: string | null
  /**
   * 10/12 (Nic, ledger review): the caller posts the company's opening posting
   * itself after this source (a rebuild walking its sources in date order), so
   * a source before the books start need not mark the opening for the drain.
   */
  openingFollows?: boolean
}

export interface PostSourceResult {
  sourceType: string
  sourceId: string
  posted: number
  reversed: number
  unchanged: number
  suppressed: number
  error?: { reasonCode: LedgerSourceErrorReason; message: string }
  /**
   * 10/12 (Nic) review: the books were busy (a lock or a books connection was
   * not free within its short wait). Nothing was written and nothing is wrong:
   * the source's outbox rows stay for the next minute's drain. Not an error.
   */
  busy?: boolean
}

/** A lock or a books connection that was not free in time: the poster steps aside. */
function isBusyError(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code
  if (code === '55P03') return true   // lock_not_available (lock_timeout)
  const msg = e instanceof Error ? e.message : ''
  return /timeout exceeded when trying to connect/i.test(msg)
}

/**
 * Brings one source's postings in line with what its projector wants now, in
 * one short transaction (see the header). Never throws for a books problem:
 * the failure is recorded in ledger_source_errors and returned.
 */
export async function postSource(sourceType: string, sourceId: string, opts: PostSourceOptions = {}): Promise<PostSourceResult> {
  const result: PostSourceResult = { sourceType, sourceId, posted: 0, reversed: 0, unchanged: 0, suppressed: 0 }
  const projector = ledgerProjectorFor(sourceType)
  if (!projector) {
    result.error = { reasonCode: 'projector_error', message: `No ledger projector for ${sourceType}` }
    return result
  }
  let ownerHint = opts.ownerHint ?? null
  // Companies whose books calendar is pinned once this has committed and its
  // connection is back in the pool (never inside the posting transaction).
  const toPin = new Set<string>()
  let failure: LedgerSourceError | null = null
  let busy = false
  let client: PoolClient
  try {
    client = await ledgerConnect()
  } catch (e) {
    if (isBusyError(e)) return { ...result, busy: true }
    throw e
  }
  try {
    await client.query('BEGIN')
    // 10/12 (Nic) review: a poster waits at most a second for a lock — another
    // poster of the same source, or a close, which holds the company lock only
    // for an instant. Longer, and it steps aside ("busy") until the next pass.
    await client.query(`SET LOCAL lock_timeout = '1s'`)
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`ledger_source:${sourceType}:${sourceId}`])

    let desired: DesiredPosting[]
    try {
      desired = await projector.project(client, sourceId)
    } catch (e) {
      throw asSourceError(e, 'projector_error')
    }
    desired = normalizeDesired(desired, sourceType, sourceId)
    const active = await loadActivePostings(client, sourceType, sourceId)

    type Group = { owner: LedgerOwner; kind: string; want?: DesiredPosting; active?: ActivePosting }
    const groups = new Map<string, Group>()
    for (const d of desired) {
      const k = `${ownerKeyOf(d.owner)}|${d.postingKind}`
      groups.set(k, { owner: d.owner, kind: d.postingKind as string, want: d })
    }
    for (const a of active) {
      const owner = ownerFromRow(a)
      const k = `${ownerKeyOf(owner)}|${a.posting_kind}`
      const g = groups.get(k) ?? { owner, kind: a.posting_kind }
      g.active = a
      groups.set(k, g)
    }
    if (!ownerHint) ownerHint = desired[0] ? ownerIdOf(desired[0].owner) : (active[0] ? ownerIdOf(ownerFromRow(active[0])) : null)

    // The shared company locks, in a fixed order (a close takes one
    // exclusively; posters only ever take them shared, so no cycle).
    const owners = new Map<string, LedgerOwner>()
    for (const g of groups.values()) owners.set(ownerKeyOf(g.owner), g.owner)
    const contexts = new Map<string, LedgerOwnerContext>()
    for (const key of [...owners.keys()].sort()) {
      const owner = owners.get(key)!
      await client.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))', [ownerLockText(owner)])
      if (ledgerTestHooks.afterOwnerLock) await ledgerTestHooks.afterOwnerLock(owner, sourceType, sourceId)
      contexts.set(key, await loadOwnerContext(client, owner))
    }

    // 10/12 (Nic, ledger review): companies whose opening posting (design J1)
    // carries this source — it is dated before their books start — and so
    // must be re-posted now that the source changed (see markOpening below).
    const markOpening = new Set<string>()
    const charts = new Map<string, ChartState>()
    const orderedGroups = [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, g]) => g)
    for (const g of orderedGroups) {
      const ctx = contexts.get(ownerKeyOf(g.owner))!
      let want = g.want
      if (want) {
        if (!ctx.exists) throw new LedgerSourceError('projector_error', `${sourceType} ${sourceId} names a company that does not exist`)
        if (g.owner.businessId) throw new LedgerSourceError('owner_not_ready', 'A business\'s books post in a later phase.')
        if (!ctx.booksStartDate) {
          throw new LedgerSourceError('no_books_start', 'The company has no books start date yet; nothing posts until it picks one.')
        }
        // Before the books start, the opening posting carries it (design J1).
        if (want.intendedDate < ctx.booksStartDate) {
          want = undefined
          result.suppressed++
          if (g.owner.landlordId) markOpening.add(g.owner.landlordId)
        }
        else if (want.lines.length === 0) want = undefined
      }
      let lines: ResolvedLine[] | null = null
      let fingerprint: string | null = null
      // 10/13 (Nic): what the active posting rightly carries where it sits — a
      // deleted account handed on only where its replacement had taken over
      // by that day (a closed month keeps the account it was posted to).
      let keptFingerprint: string | null = null
      if (want) {
        let chart = charts.get(ownerKeyOf(g.owner))
        if (!chart) { chart = await ensureChart(client, g.owner); charts.set(ownerKeyOf(g.owner), chart) }
        const asOfDay = (await resolveLines(client, chart, want, false))!
        // 10/13 (Nic): a new posting written now never names a deleted
        // account — it lands in an open month, and the open months are the
        // replacement's (a late record for a closed month too: "The
        // replacement"). The reversal below still negates the active posting
        // line for line, on the accounts it was posted to.
        lines = takenOver(chart, asOfDay)
        fingerprint = fingerprintOf(tuplesOf(want.intendedDate, lines))
        if (g.active) keptFingerprint = fingerprintOf(tuplesOf(want.intendedDate, takenOver(chart, asOfDay, g.active.accounting_date)))
      }
      const forced = opts.force === true || (!!opts.force && typeof opts.force === 'object' && sameOwner(opts.force, g.owner))
      if (g.active && want && (g.active.fingerprint === fingerprint || g.active.fingerprint === keptFingerprint) && !forced) {
        result.unchanged++; continue
      }
      if (!g.active && !want) continue

      // 10/12 (Nic) review: is this a landlord's fix, or only the chart moving
      // (a repointed role, a deleted account's replacement) or GAM re-deriving
      // the same lines (a forced rebuild)? Same content = not a fix: it keeps
      // the dates the active posting had (still never inside a closed month).
      const sameContent = !!(g.active && want &&
        contentFingerprintOf(await storedTuples(client, g.active.id)) === contentFingerprintOf(tuplesOf(want.intendedDate, lines!)))
      const gamRun = forced || !!opts.rebuildRunId
      // A correction to an open month: the company's choice (L4) — for a real
      // change only; a GAM rebuild or a chart change restates in place. A
      // closed month is never touched: everything lands on the first open day.
      // 10/13 (Nic): "day-made mode: automatic changes SHOW ON THE DAY" — a
      // change is a change whoever made it: a person's fix, a Stripe fee
      // true-up, a webhook, or a rule the nightly check re-posts all show on
      // the day made; only a rebuild GAM runs keeps the original dates
      // (ledgerDayMadeAutomatic1013.test.ts).
      const fixDay = g.active && !sameContent && !gamRun && ctx.openMonthFixes === 'day_made' ? ctx.today : null
      const newId = want ? randomUUID() : null
      if (g.active) {
        await insertReversal(client, {
          id: randomUUID(), active: g.active, accountingDate: maxIso(g.active.accounting_date, ctx.firstOpenDay, fixDay),
          ruleVersion: projector.ruleVersion, postedBy: opts.actorUserId ?? null, rebuildRunId: opts.rebuildRunId ?? null,
        })
        await client.query(
          `UPDATE ledger_postings SET superseded_at = now(), superseded_by = $2 WHERE id = $1`, [g.active.id, newId])
        result.reversed++
      }
      if (want) {
        const accountingDate = sameContent
          ? maxIso(g.active!.accounting_date, ctx.firstOpenDay)
          : maxIso(want.intendedDate, ctx.firstOpenDay, fixDay)
        await insertPosting(client, {
          id: newId!, owner: g.owner, sourceType, sourceId, kind: g.kind,
          // 10/12 (Nic): "after a close, fixes post to the open month labeled as
          // corrections" — a re-projection, or anything that lands after its own
          // day (a backdated record in a closed month), reads as a correction.
          // The same content re-posted keeps what the posting it replaces said.
          isCorrection: sameContent
            ? g.active!.is_correction || accountingDate !== want.intendedDate
            : !!g.active || accountingDate !== want.intendedDate,
          intendedDate: want.intendedDate, accountingDate,
          fingerprint: fingerprint!, ruleVersion: projector.ruleVersion, postedBy: opts.actorUserId ?? null,
          rebuildRunId: opts.rebuildRunId ?? null, memo: want.memo ?? null, lines: lines!,
        })
        if (g.owner.landlordId && !ctx.timezonePinned) toPin.add(g.owner.landlordId)
        result.posted++
      }
    }

    // 10/12 (Nic, ledger review): a change to a record dated before the books
    // start re-posts the opening posting within the minute (L1), not at the
    // nightly check as "drift". Two ways a record feeds the opening: it still
    // wants lines dated before the start (suppressed above), or it now wants
    // nothing at all and has never posted — a bill voided, a receipt undone,
    // a row removed — whose old lines the opening may still carry (only a
    // change the outbox saw: a rebuild walks the opening itself). Marked in
    // this same transaction, the way every writer marks a source: one outbox
    // row; the drain posts it (an unchanged opening posts nothing).
    if (!opts.openingFollows && sourceType !== 'opening' && registry.has('opening')) {
      const wantsNothing = desired.every(d => d.lines.length === 0) && active.length === 0
      if (wantsNothing && opts.outboxIds?.length && ownerHint && ISO_UUID.test(ownerHint)) {
        const has = await client.query<{ ok: boolean }>(
          `SELECT books_start_date IS NOT NULL AS ok FROM landlords WHERE id = $1`, [ownerHint])
        if (has.rows[0]?.ok) markOpening.add(ownerHint)
      }
      if (markOpening.size) {
        await client.query(
          `INSERT INTO ledger_outbox (source_type, source_id, owner_id)
           SELECT 'opening', x, x::uuid FROM unnest($1::text[]) AS x`, [[...markOpening].sort()])
      }
    }

    if (opts.outboxIds?.length) {
      await client.query('DELETE FROM ledger_outbox WHERE id = ANY($1::bigint[])', [opts.outboxIds])
    }
    await client.query('DELETE FROM ledger_source_errors WHERE source_type = $1 AND source_id = $2', [sourceType, sourceId])
    if (ledgerTestHooks.beforeCommit) await ledgerTestHooks.beforeCommit(sourceType, sourceId)
    // The per-property balance check is deferred to commit; run it now so a
    // refusal is reported as this source's error, not a lost connection.
    await client.query('SET CONSTRAINTS ALL IMMEDIATE')
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    if (isBusyError(e)) busy = true
    else failure = asSourceError(e, 'post_error')
  } finally {
    client.release()
  }
  // Busy: nothing written, nothing wrong, no error recorded — the outbox rows
  // stay and the next pass posts the source.
  if (busy) return { ...result, posted: 0, reversed: 0, unchanged: 0, suppressed: 0, busy: true }
  if (failure) {
    // Recorded on its own connection, after this one is back in the pool.
    result.posted = 0; result.reversed = 0; result.unchanged = 0; result.suppressed = 0
    result.error = { reasonCode: failure.reasonCode, message: failure.message }
    await recordSourceError(sourceType, sourceId, failure, ownerHint)
    return result
  }
  for (const landlordId of toPin) await pinBooksTimezone(landlordId)
  return result
}

/**
 * 10/12 (Nic, ledger P4): reasons that mean the source is WAITING ON ITS OWNER,
 * not broken — no books start date picked yet, or (owner_not_ready) an
 * accounting method the posting depends on not chosen yet on the Books
 * settings page (home sales, work trade: "landlord's choice", NULL until the
 * owner picks; services/booksSettings retries these the moment they choose).
 * No admin notice for them, a steady 15-minute retry, and the nightly check
 * counts them as pending, never as drift.
 */
export const LEDGER_WAITING_ON_OWNER_REASONS: readonly LedgerSourceErrorReason[] = ['no_books_start', 'owner_not_ready']

/** Backoff after `attempts` failures: 1, 2, 4 … minutes, at most an hour. */
function backoffMinutes(attempts: number, reason: LedgerSourceErrorReason): number {
  if (LEDGER_WAITING_ON_OWNER_REASONS.includes(reason)) return 15
  return Math.min(60, 2 ** Math.max(0, attempts - 1))
}

async function recordSourceError(sourceType: string, sourceId: string, err: LedgerSourceError, ownerId: string | null): Promise<void> {
  try {
    const prior = await ledgerQuery<{ attempts: number }>(
      `SELECT attempts FROM ledger_source_errors WHERE source_type = $1 AND source_id = $2`, [sourceType, sourceId])
    const attempts = (prior[0]?.attempts ?? 0) + 1
    const rows = await ledgerQuery<{ attempts: number; noticed_at: string | null }>(
      `INSERT INTO ledger_source_errors (source_type, source_id, owner_id, reason_code, attempts, last_error, next_try_at)
       VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(mins => $7))
       ON CONFLICT (source_type, source_id) DO UPDATE
          SET owner_id = COALESCE(EXCLUDED.owner_id, ledger_source_errors.owner_id),
              reason_code = EXCLUDED.reason_code,
              attempts = ledger_source_errors.attempts + 1,
              last_error = EXCLUDED.last_error,
              last_failed_at = now(),
              next_try_at = EXCLUDED.next_try_at
       RETURNING attempts, noticed_at`,
      [sourceType, sourceId, ownerId, err.reasonCode, attempts, err.message.slice(0, 2000), backoffMinutes(attempts, err.reasonCode)])
    const row = rows[0]
    // Design §3: an admin hears about a source after its 3rd failed try. A
    // company with no books start date (or, P4, a method not chosen yet) is
    // waiting on its owner, not broken.
    if (row && row.attempts > 3 && !row.noticed_at && !LEDGER_WAITING_ON_OWNER_REASONS.includes(err.reasonCode)) {
      await ledgerQuery(`UPDATE ledger_source_errors SET noticed_at = now() WHERE source_type = $1 AND source_id = $2`, [sourceType, sourceId])
      await createAdminNotification({
        severity: 'warn',
        category: 'books_ledger',
        title: 'A money record keeps failing to post to the books',
        body: `${sourceType} ${sourceId} failed ${row.attempts} times: ${err.message}`.slice(0, 1000),
        context: { sourceType, sourceId, ownerId, reasonCode: err.reasonCode },
      })
    }
  } catch (e) {
    logger.error({ err: e, sourceType, sourceId }, '[ledger] could not record a posting failure')
  }
}

// ─── Dry run: what would change (rebuild dry_run and the nightly check) ──────

export type SourceDiffStatus = 'equal' | 'missing' | 'stale' | 'changed' | 'no_books_start' | 'unresolved' | 'error'
  // 10/12 (Nic, ledger P4): the projector is waiting on the owner's choice (owner_not_ready).
  | 'waiting_on_owner'
export interface SourceDiff {
  sourceType: string
  sourceId: string
  ownerId: string | null
  postingKind: string | null
  status: SourceDiffStatus
  activeFingerprint?: string | null
  desiredFingerprint?: string | null
  message?: string
}

/**
 * Compares what a source's projector wants with its active postings, without
 * writing anything (no locks; it reads on the caller's snapshot, so the
 * nightly check runs it inside its REPEATABLE READ transaction).
 */
export async function diffSource(client: PoolClient, sourceType: string, sourceId: string): Promise<SourceDiff[]> {
  const projector = ledgerProjectorFor(sourceType)
  if (!projector) return [{ sourceType, sourceId, ownerId: null, postingKind: null, status: 'error', message: 'no projector' }]
  let desired: DesiredPosting[]
  try {
    desired = normalizeDesired(await projector.project(client, sourceId), sourceType, sourceId)
  } catch (e) {
    const waiting = e instanceof LedgerSourceError && e.reasonCode === 'owner_not_ready'
    return [{ sourceType, sourceId, ownerId: null, postingKind: null, status: waiting ? 'waiting_on_owner' : 'error',
      message: e instanceof Error ? e.message : String(e) }]
  }
  const active = await loadActivePostings(client, sourceType, sourceId)
  const out: SourceDiff[] = []
  const contexts = new Map<string, LedgerOwnerContext>()
  const ctxOf = async (o: LedgerOwner) => {
    const k = ownerKeyOf(o)
    if (!contexts.has(k)) contexts.set(k, await loadOwnerContext(client, o))
    return contexts.get(k)!
  }
  const charts = new Map<string, ChartState>()
  const matched = new Set<string>()
  for (const d of desired) {
    const a = active.find(x => sameOwner(ownerFromRow(x), d.owner) && x.posting_kind === d.postingKind)
    if (a) matched.add(a.id)
    const base = { sourceType, sourceId, ownerId: ownerIdOf(d.owner), postingKind: d.postingKind as string, activeFingerprint: a?.fingerprint ?? null }
    const ctx = await ctxOf(d.owner)
    if (!ctx.booksStartDate) { out.push({ ...base, status: 'no_books_start' }); continue }
    if (d.intendedDate < ctx.booksStartDate || d.lines.length === 0) {
      out.push({ ...base, status: a ? 'stale' : 'equal', desiredFingerprint: null }); continue
    }
    let lines: ResolvedLine[] | null = null
    let chart: ChartState | undefined
    try {
      chart = charts.get(ownerKeyOf(d.owner))
      if (!chart) { chart = await readChart(client, d.owner); charts.set(ownerKeyOf(d.owner), chart) }
      lines = await resolveLines(client, chart, d, true)
    } catch (e) {
      out.push({ ...base, status: 'error', message: e instanceof Error ? e.message : String(e) }); continue
    }
    if (!lines) { out.push({ ...base, status: 'unresolved' }); continue }
    // 10/13 (Nic): as postSource decides it — what a posting written now
    // carries, or what the active posting rightly carries where it sits.
    const fp = fingerprintOf(tuplesOf(d.intendedDate, takenOver(chart, lines)))
    const kept = a ? fingerprintOf(tuplesOf(d.intendedDate, takenOver(chart, lines, a.accounting_date))) : null
    out.push({ ...base, desiredFingerprint: fp, status: !a ? 'missing' : a.fingerprint === fp || a.fingerprint === kept ? 'equal' : 'changed' })
  }
  for (const a of active) {
    if (matched.has(a.id)) continue
    out.push({ sourceType, sourceId, ownerId: a.landlord_id ?? a.business_id, postingKind: a.posting_kind,
      status: 'stale', activeFingerprint: a.fingerprint, desiredFingerprint: null })
  }
  return out
}

// ─── The drain ───────────────────────────────────────────────────────────────

export interface DrainSummary {
  skipped: boolean
  keys: number
  posted: number
  reversed: number
  unchanged: number
  failed: number
  /** 10/12 (Nic) review: keys the books were too busy to post this pass (they stay for the next). */
  deferred: number
}

let lastStaleNoticeAt = 0

/** Tests: forget when the last "waiting to post" notice went out. */
export function resetLedgerStaleNoticeClock(): void {
  lastStaleNoticeAt = 0
}

/**
 * Posts what is waiting in the outbox (registered source types only), one
 * source key per transaction. With no filter it is the every-minute job: one
 * runner at a time across processes (a try-lock on 'ledger_drain'; a second
 * one returns at once). `ownerId` drains one company (its rows and rows with
 * no company named) — the nightly check and a close do this first; `xid`
 * drains one transaction's rows (the after-commit kick). Both skip the
 * runner lock; posting itself is safe to overlap (one source at a time).
 * Everything runs on the books' own pool (db/ledgerPool).
 */
export async function drainLedgerOutbox(opts: {
  ownerId?: string | null; xid?: string | null; limit?: number; maxMs?: number; ignoreBackoff?: boolean
} = {}): Promise<DrainSummary> {
  const summary: DrainSummary = { skipped: false, keys: 0, posted: 0, reversed: 0, unchanged: 0, failed: 0, deferred: 0 }
  const types = drainableLedgerOutboxTypes()
  if (types.length === 0) return summary
  const filtered = !!(opts.ownerId || opts.xid)
  let lockClient: PoolClient | null = null
  if (!filtered) {
    try {
      lockClient = await ledgerConnect()
    } catch (e) {
      if (isBusyError(e)) { summary.skipped = true; return summary }
      throw e
    }
  }
  let locked = false
  try {
    if (lockClient) {
      const got = await lockClient.query<{ ok: boolean }>(`SELECT pg_try_advisory_lock(hashtextextended('ledger_drain', 0)) AS ok`)
      if (!got.rows[0]?.ok) { summary.skipped = true; return summary }
      locked = true
    }
    const started = Date.now()
    const maxMs = opts.maxMs ?? 50_000
    const limit = opts.limit ?? 500
    const attempted = new Set<string>()
    for (;;) {
      if (Date.now() - started > maxMs) break
      const rows = await ledgerQuery<{ id: string; source_type: string; source_id: string; owner_id: string | null }>(
        `SELECT o.id::text AS id, o.source_type, o.source_id, o.owner_id
           FROM ledger_outbox o
          WHERE o.source_type = ANY($1::text[])
            AND ($2::uuid IS NULL OR o.owner_id = $2::uuid OR o.owner_id IS NULL)
            AND ($3::text IS NULL OR o.xid = $3::xid8)
            AND NOT (o.source_type || ':' || o.source_id = ANY($6::text[]))
            AND ($4::boolean OR NOT EXISTS (
                  SELECT 1 FROM ledger_source_errors e
                   WHERE e.source_type = o.source_type AND e.source_id = o.source_id
                     AND e.next_try_at > now()
                     -- a company that has since picked its books start date is retried at once
                     AND NOT (e.reason_code = 'no_books_start'
                              AND EXISTS (SELECT 1 FROM landlords l WHERE l.id = e.owner_id AND l.books_start_date IS NOT NULL))))
          ORDER BY o.id
          LIMIT $5`,
        [types, opts.ownerId ?? null, opts.xid ?? null, !!opts.ignoreBackoff, limit, [...attempted]])
      if (rows.length === 0) break
      const keys = new Map<string, { type: string; id: string; ids: string[]; owner: string | null }>()
      for (const r of rows) {
        const k = `${r.source_type}:${r.source_id}`
        const e = keys.get(k) ?? { type: r.source_type, id: r.source_id, ids: [], owner: r.owner_id }
        e.ids.push(r.id)
        if (!e.owner && r.owner_id) e.owner = r.owner_id
        keys.set(k, e)
      }
      for (const [k, e] of keys) {
        attempted.add(k)
        summary.keys++
        if (e.type === LEDGER_OUTBOX_BOOKS_START) {
          const x = await expandBooksStartMark(e.id, e.ids, e.owner)
          if (x === 'busy') summary.deferred++
          else if (x === 'failed') summary.failed++
        } else {
          const res = await postSource(e.type, e.id, { outboxIds: e.ids, ownerHint: e.owner })
          if (res.busy) summary.deferred++
          else if (res.error) summary.failed++
          summary.posted += res.posted
          summary.reversed += res.reversed
          summary.unchanged += res.unchanged
        }
        if (Date.now() - started > maxMs) break
      }
    }
    if (!filtered) await noticeStaleOutbox(types)
    return summary
  } finally {
    if (lockClient) {
      if (locked) await lockClient.query(`SELECT pg_advisory_unlock(hashtextextended('ledger_drain', 0))`).catch(() => {})
      lockClient.release()
    }
  }
}

/**
 * 10/12 (Nic) review: a company's books start date moved (the landlords
 * trigger left 'landlord id|from|to'). Every source of the company dated from
 * `from` up to (not including) `to` crossed the start: a later start takes
 * back what now opens in the opening posting, an earlier start posts what was
 * held back. Each such source — every registered projector's sources in the
 * range, and every source with a posting in it — is marked for posting, and
 * the mark is removed, in one transaction; the drain then posts them like any
 * other change (and until it has, the nightly check counts them as waiting,
 * not as drift).
 */
async function expandBooksStartMark(mark: string, outboxIds: string[], ownerHint: string | null): Promise<'done' | 'busy' | 'failed'> {
  const [landlordId, from, to] = mark.split('|')
  let client: PoolClient
  try {
    client = await ledgerConnect()
  } catch (e) {
    if (isBusyError(e)) return 'busy'
    throw e
  }
  let failure: LedgerSourceError | null = null
  try {
    await client.query('BEGIN')
    await client.query(`SET LOCAL lock_timeout = '1s'`)
    if (landlordId && ISO_DAY.test(from ?? '') && ISO_DAY.test(to ?? '')) {
      const owner: LedgerOwner = { landlordId }
      const types = registeredLedgerSourceTypes()
      const keys = new Map<string, { type: string; id: string }>()
      for (const t of types) {
        let refs: LedgerSourceRef[]
        try {
          refs = await ledgerProjectorFor(t)!.listSources(client, owner, { since: from })
        } catch (e) {
          throw asSourceError(e, 'projector_error')
        }
        // A source whose day the projector does not say is re-projected too
        // (an unchanged source posts nothing). 10/12 (Nic, ledger review): a
        // day's margin past `to` — a source may list its day on the company's
        // calendar and post on its property's, at most a day apart; one that
        // turns out not to cross posts nothing.
        const until = addDaysIso(to, 1)
        for (const r of refs) if (!r.day || r.day < until) keys.set(`${t}:${r.id}`, { type: t, id: r.id })
      }
      const posted = await client.query<{ source_type: string; source_id: string }>(
        `SELECT DISTINCT source_type, source_id FROM ledger_postings
          WHERE landlord_id = $1 AND role = 'post' AND superseded_at IS NULL AND source_type = ANY($2::text[])
            AND intended_date >= $3::date AND intended_date < $4::date`, [landlordId, types, from, to])
      for (const r of posted.rows) keys.set(`${r.source_type}:${r.source_id}`, { type: r.source_type, id: r.source_id })
      if (keys.size) {
        const list = [...keys.values()]
        await client.query(
          `INSERT INTO ledger_outbox (source_type, source_id, owner_id)
           SELECT t, i, $3::uuid FROM unnest($1::text[], $2::text[]) AS x(t, i)`,
          [list.map(k => k.type), list.map(k => k.id), landlordId])
      }
    }
    // A malformed mark is simply removed (nothing could act on it).
    await client.query('DELETE FROM ledger_outbox WHERE id = ANY($1::bigint[])', [outboxIds])
    await client.query('DELETE FROM ledger_source_errors WHERE source_type = $1 AND source_id = $2', [LEDGER_OUTBOX_BOOKS_START, mark])
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    if (isBusyError(e)) { client.release(); return 'busy' }
    failure = asSourceError(e, 'projector_error')
  }
  client.release()
  if (failure) {
    await recordSourceError(LEDGER_OUTBOX_BOOKS_START, mark, failure, ownerHint ?? landlordId ?? null)
    return 'failed'
  }
  return 'done'
}

/**
 * Design §3: an admin hears when a source has waited more than 10 minutes (at
 * most once an hour). 10/12 (Nic) review: a source held back only because its
 * company has not picked a books start date is waiting on its owner, not
 * broken (recordSourceError never alerts for it either) — it is left out.
 */
async function noticeStaleOutbox(types: string[]): Promise<void> {
  if (Date.now() - lastStaleNoticeAt < 60 * 60_000) return
  const r = await ledgerQuery<{ n: string; oldest: string | null }>(
    `SELECT count(DISTINCT (o.source_type, o.source_id))::text AS n, min(o.at)::text AS oldest
       FROM ledger_outbox o
      WHERE o.source_type = ANY($1::text[]) AND o.at < now() - interval '10 minutes'
        AND NOT EXISTS (SELECT 1 FROM ledger_source_errors e
                         WHERE e.source_type = o.source_type AND e.source_id = o.source_id
                           AND e.reason_code = ANY($2::text[]))
        AND NOT EXISTS (SELECT 1 FROM landlords l WHERE l.id = o.owner_id AND l.books_start_date IS NULL)`,
    [types, LEDGER_WAITING_ON_OWNER_REASONS])
  const n = Number(r[0]?.n ?? 0)
  if (n === 0) return
  lastStaleNoticeAt = Date.now()
  await createAdminNotification({
    severity: 'warn',
    category: 'books_ledger',
    title: 'Money records are waiting to post to the books',
    body: `${n} record(s) have waited more than 10 minutes (oldest since ${r[0].oldest}). See Admin → Ledger.`,
    context: { waiting: n, oldest: r[0].oldest },
  })
}

// ─── The after-commit kick ───────────────────────────────────────────────────

/** The current transaction's id, for kickLedgerAfterCommit (call inside the money transaction). */
export async function currentLedgerXid(client: PoolClient): Promise<string> {
  const r = await client.query<{ xid: string }>(`SELECT pg_current_xact_id()::text AS xid`)
  return r.rows[0].xid
}

export type LedgerKickResult = 'drained' | 'rolled_back' | 'gave_up' | 'idle'

interface KickItem {
  xid: string
  started: number
  maxWaitMs: number
  delay: number
  promise: Promise<LedgerKickResult>
  resolve: (r: LedgerKickResult) => void
}

/**
 * 10/12 (Nic) review: ONE in-process queue, one kick at a time, each
 * transaction once. A burst of settles never becomes a burst of posters
 * holding connections; a kick whose transaction is still open goes to the back
 * of the line instead of holding it up.
 */
const kickQueue: KickItem[] = []
const kickByXid = new Map<string, KickItem>()
let kickRunning = false
/** Beyond this many waiting kicks, a new one is left to the minute drain. */
const KICK_QUEUE_MAX = 5_000

/**
 * Posts one money transaction's sources as soon as it has committed, instead
 * of waiting for the next minute's drain. Optional: it only shortens the wait.
 * Queued (see above); waits for the transaction to end (committed → drain its
 * rows; rolled back → nothing), never throws, gives up after `maxWaitMs` (the
 * drain gets it). Kicking the same transaction twice returns the same answer.
 */
export function kickLedgerAfterCommit(xid: string, opts: { maxWaitMs?: number } = {}): Promise<LedgerKickResult> {
  if (registeredLedgerSourceTypes().length === 0) return Promise.resolve('idle')
  const existing = kickByXid.get(xid)
  if (existing) return existing.promise
  if (kickByXid.size >= KICK_QUEUE_MAX) return Promise.resolve('gave_up')
  let resolve!: (r: LedgerKickResult) => void
  const promise = new Promise<LedgerKickResult>((res) => { resolve = res })
  const item: KickItem = { xid, started: Date.now(), maxWaitMs: opts.maxWaitMs ?? 30_000, delay: 10, promise, resolve }
  kickByXid.set(xid, item)
  kickQueue.push(item)
  void runKickQueue()
  return promise
}

async function runKickQueue(): Promise<void> {
  if (kickRunning) return
  kickRunning = true
  try {
    for (let item = kickQueue.shift(); item; item = kickQueue.shift()) {
      let outcome: LedgerKickResult | 'wait'
      try {
        const st = await ledgerQuery<{ s: string | null }>(`SELECT pg_xact_status($1::xid8) AS s`, [item.xid])
        const status = st[0]?.s ?? null
        if (status === 'committed') {
          await drainLedgerOutbox({ xid: item.xid, maxMs: 20_000 })
          outcome = 'drained'
        } else if (status === 'in progress') {
          outcome = Date.now() - item.started >= item.maxWaitMs ? 'gave_up' : 'wait'
        } else {
          outcome = status === 'aborted' ? 'rolled_back' : 'gave_up'
        }
      } catch (e) {
        logger.warn({ err: e, xid: item.xid }, '[ledger] after-commit kick failed — the minute drain will post it')
        outcome = 'gave_up'
      }
      if (outcome === 'wait') {
        const again = item
        again.delay = Math.min(again.delay * 2, 250)
        const t = setTimeout(() => { kickQueue.push(again); void runKickQueue() }, again.delay)
        t.unref?.()
        continue
      }
      kickByXid.delete(item.xid)
      item.resolve(outcome)
    }
  } finally {
    kickRunning = false
  }
}

/** The account a map kind resolves to (re-exported for callers that only need the type). */
export type { LedgerMapKind }

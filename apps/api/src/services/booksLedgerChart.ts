/**
 * 10/12 (Nic) — GAM BOOKS LEDGER: THE CHART THE AUTOMATIC POSTINGS USE
 *
 *   "landlords/bookkeepers may rename, add and delete accounts"
 *
 * The chart of accounts is fully editable, so an automatic posting never names
 * an account. Each automatic line names a POSTING ROLE
 * (LEDGER_ACCOUNT_ROLE_DEFS, packages/shared) and the company's map
 * (books_account_map) says which account that role posts to, from which day.
 *
 *   ensureChart     GAM seeds the map the first time a company posts — reusing
 *                   an account the company already has at the suggested code
 *                   and type, or adding one — and re-seeds any role added in a
 *                   later release. (The company's books calendar is pinned
 *                   outside the posting transaction: ledgerOwner.pinBooksTimezone.)
 *   resolveAccount  the account a line posts to: the map row in force on the
 *                   line's intended date. A bank or a named tax gets its own
 *                   sub-account the first time it is used.
 *   repointMapping  the company points a role somewhere else. A new map row
 *                   dated the day it is made: postings dated from that day on
 *                   use the new account, everything before stays where it was
 *                   posted (history stays; a rebuild comes out the same).
 *                   Postings already made for that day or later (a bill posts
 *                   on its due date) are marked for re-posting in the same
 *                   transaction, so they move at the next drain and the
 *                   nightly check counts them as waiting, never as drift.
 *   retireAccount   "delete" an account. Never removed and its posted lines
 *                   never changed: when the map or posted lines use it, a
 *                   replacement must be chosen — the map is repointed to the
 *                   replacement and the account is retired naming it. 10/12
 *                   (Nic) review: the replacement takes over from the first
 *                   OPEN day (the whole history when nothing is closed), not
 *                   from today — otherwise a backdated payment, a late bank
 *                   match or a fix dated before the deletion would keep
 *                   landing on the deleted account. Closed months keep their
 *                   account; the open months' postings on it are marked for
 *                   re-posting and move to the replacement (a reversal and a
 *                   new posting each, dated as they were — posted lines are
 *                   never changed).
 *
 * CONTROL ACCOUNTS (10/12 (Nic) review). A control role's account (receivables,
 * money GAM holds, deposits owed …, LEDGER_CONTROL_ROLES) is proven against the
 * money records every night, and the database refuses hand journal lines on
 * any account a control role ever used. So a control role never shares its
 * account: it may not be pointed at an account another role uses or used, or
 * one with journal lines, and no other role may be pointed at an account a
 * control role uses or used. GAM's seeding follows the same rules.
 *
 * The database holds the same rules (books_account_map_guard,
 * books_accounts_ledger_guard; migrations 20261013200200 / 200300), so a route
 * that edits the chart directly cannot get around them.
 *
 * routes/books.ts is being edited by the Books lane; its account routes should
 * call repointMapping / retireAccount (deactivating an account the map points
 * at is refused by the database).
 */
import type { PoolClient } from 'pg'
import {
  LEDGER_ACCOUNT_ROLE_DEFS, LEDGER_ACCOUNT_ROLE_BY_NAME, LEDGER_MAP_BEGINNING, LEDGER_MAP_KIND_PARENT_ROLE,
  LEDGER_MAP_KINDS, type LedgerAccountRole, type LedgerMapKind, type BooksAccountType,
} from '@gam/shared'
import type { LedgerOwnerContext } from './ledgerOwner'
import { db } from '../db'
import { AppError } from '../middleware/errorHandler'
import { type LedgerOwner, ownerColOf, ownerIdOf, loadOwnerContext } from './ledgerOwner'

/** One books_account_map row as the engine reads it. */
export interface MapRow {
  id: number
  map_kind: LedgerMapKind
  map_value: string
  account_id: string
  effective_from: string
}

/** What a company's chart looks like to the engine during one transaction. */
export interface ChartState {
  owner: LedgerOwner
  map: MapRow[]
}

/** A line's account, resolved. */
export interface ResolvedAccount {
  accountId: string
  accountRole: LedgerAccountRole | null
  mapKind: LedgerMapKind | null
  mapValue: string | null
}

/** Thrown when an owner's books cannot post yet (a business, before its phase). */
export class LedgerOwnerNotReadyError extends Error {
  readonly reasonCode = 'owner_not_ready' as const
}

/** The account type a map kind's target must have. */
export function mapTargetType(kind: LedgerMapKind, value: string): BooksAccountType | null {
  if (kind === 'role') return LEDGER_ACCOUNT_ROLE_BY_NAME[value as LedgerAccountRole]?.type ?? null
  return LEDGER_ACCOUNT_ROLE_BY_NAME[LEDGER_MAP_KIND_PARENT_ROLE[kind]].type
}

async function loadMap(client: PoolClient, owner: LedgerOwner): Promise<MapRow[]> {
  const r = await client.query<MapRow>(
    `SELECT id::int AS id, map_kind, map_value, account_id, effective_from::text AS effective_from
       FROM books_account_map WHERE ${ownerColOf(owner)} = $1
      ORDER BY map_kind, map_value, effective_from DESC, id DESC`, [ownerIdOf(owner)])
  return r.rows.map(x => ({ ...x, id: Number(x.id) }))
}

/** The map row in force on `day` for (kind, value): the latest effective_from on or before it. */
export function mapRowOn(map: MapRow[], kind: LedgerMapKind, value: string, day: string): MapRow | null {
  let best: MapRow | null = null
  for (const m of map) {
    if (m.map_kind !== kind || m.map_value !== value || m.effective_from > day) continue
    if (!best || m.effective_from > best.effective_from || (m.effective_from === best.effective_from && m.id > best.id)) best = m
  }
  return best
}

/** The map row in force from today on (the latest row) for (kind, value). */
export function currentMapRow(map: MapRow[], kind: LedgerMapKind, value: string): MapRow | null {
  return mapRowOn(map, kind, value, '9999-12-31')
}

async function lockChart(client: PoolClient, owner: LedgerOwner): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`books_chart:${ownerIdOf(owner)}`])
}

/**
 * Inserts an account at the first free code: `code` itself, then '-1', '-2', …
 * (a sub-account starts at '-1': '1010-1', '1010-2', …).
 */
async function insertAccountAtFreeCode(
  client: PoolClient, owner: LedgerOwner,
  a: { code: string; name: string; type: BooksAccountType; parentAccountId?: string | null; bankConnectionId?: string | null },
  firstSuffix = 0,
): Promise<string> {
  const col = ownerColOf(owner)
  for (let n = firstSuffix; n < firstSuffix + 200; n++) {
    const code = n === 0 ? a.code : `${a.code}-${n}`
    const r = await client.query<{ id: string }>(
      `INSERT INTO books_accounts (${col}, code, name, type, is_system, parent_account_id, bank_connection_id, description)
       VALUES ($1, $2, $3, $4, TRUE, $5, $6, 'Set up by GAM for automatic postings.')
       ON CONFLICT DO NOTHING RETURNING id`,
      [ownerIdOf(owner), code.slice(0, 20), a.name, a.type, a.parentAccountId ?? null, a.bankConnectionId ?? null])
    if (r.rows[0]) return r.rows[0].id
  }
  throw new Error(`No free account code near ${a.code}`)
}

/**
 * Makes sure every posting role has a map row for this company, seeding what
 * is missing, and returns the company's whole map. Idempotent; serialized per
 * company (a transaction-level advisory lock), so two posters seeding at once
 * cannot both add an account. Runs inside the caller's transaction.
 */
export async function ensureChart(client: PoolClient, owner: LedgerOwner): Promise<ChartState> {
  if (!owner.landlordId) {
    throw new LedgerOwnerNotReadyError('A business\'s books post in a later phase.')
  }
  let map = await loadMap(client, owner)
  const roleMapped = new Set(map.filter(m => m.map_kind === 'role').map(m => m.map_value))
  const missing = LEDGER_ACCOUNT_ROLE_DEFS.filter(d => !roleMapped.has(d.role))
  if (missing.length === 0) return { owner, map }

  await lockChart(client, owner)
  // Re-read under the lock: another poster may have seeded meanwhile.
  map = await loadMap(client, owner)

  const accounts = (await client.query<{ id: string; code: string; type: string; active: boolean | null; journaled: boolean }>(
    `SELECT a.id, a.code, a.type, a.active,
            EXISTS (SELECT 1 FROM journal_entry_lines j WHERE j.account_id = a.id) AS journaled
       FROM books_accounts a WHERE a.landlord_id = $1`, [owner.landlordId])).rows
  // 10/12 (Nic) review: every account the map ever pointed at, and the ones a
  // control role ever pointed at (see CONTROL ACCOUNTS above).
  const everTargets = new Set(map.map(m => m.account_id))
  const everControlTargets = new Set(map.filter(m => isControlKey({ kind: m.map_kind, value: m.map_value })).map(m => m.account_id))
  const currentTargets = new Set<string>()
  const keys = new Set(map.map(m => `${m.map_kind}\u0000${m.map_value}`))
  for (const k of keys) {
    const [kind, value] = k.split('\u0000') as [LedgerMapKind, string]
    const row = currentMapRow(map, kind, value)
    if (row) currentTargets.add(row.account_id)
  }
  const roleAccount = new Map<string, string>()
  for (const m of map) if (m.map_kind === 'role') {
    const cur = currentMapRow(map, 'role', m.map_value)
    if (cur) roleAccount.set(m.map_value, cur.account_id)
  }

  for (const def of LEDGER_ACCOUNT_ROLE_DEFS) {
    if (roleAccount.has(def.role)) continue
    const parentId = 'parent' in def && def.parent ? roleAccount.get(def.parent) ?? null : null
    // A control role reuses only an account nothing ever mapped to and with no
    // journal lines; any other role never an account a control role used.
    const reuse = accounts.find(a => a.code === def.code && a.type === def.type && a.active !== false && !currentTargets.has(a.id)
      && (def.control ? !everTargets.has(a.id) && !a.journaled : !everControlTargets.has(a.id)))
    const accountId = reuse
      ? reuse.id
      : await insertAccountAtFreeCode(client, owner, { code: def.code, name: def.name, type: def.type, parentAccountId: parentId })
    if (reuse && parentId) {
      await client.query(`UPDATE books_accounts SET parent_account_id = COALESCE(parent_account_id, $2) WHERE id = $1`, [reuse.id, parentId])
    }
    await client.query(
      `INSERT INTO books_account_map (landlord_id, map_kind, map_value, account_id, effective_from, note)
       VALUES ($1, 'role', $2, $3, $4, 'Set up by GAM')`,
      [owner.landlordId, def.role, accountId, LEDGER_MAP_BEGINNING])
    roleAccount.set(def.role, accountId)
    currentTargets.add(accountId)
    everTargets.add(accountId)
    if (def.control) everControlTargets.add(accountId)
  }
  return { owner, map: await loadMap(client, owner) }
}

/** A line's account selector: a posting role, optionally a bank's or a tax's own sub-account under it. */
export interface AccountSelector {
  role?: LedgerAccountRole
  sub?: { kind: Exclude<LedgerMapKind, 'role'>; value: string; name?: string }
  /** An exact account (a hand journal entry's line mirrored into the ledger). */
  accountId?: string
}

/**
 * The account a line posts to on `day`. A bank connection or named tax seen
 * for the first time gets its own sub-account under its parent role's account
 * (unless `readOnly`, which returns null instead of writing).
 */
export async function resolveAccount(
  client: PoolClient, state: ChartState, sel: AccountSelector, day: string, opts: { readOnly?: boolean } = {},
): Promise<ResolvedAccount | null> {
  if (sel.accountId) {
    // 10/12 (Nic, ledger P7): a bookkeeper's journal line names its account
    // itself. Once that account is deleted (retired — retireAccount below) the
    // account that took its place takes the line too, as it takes every
    // posting role that pointed there: retirement moves an account's open
    // months to its replacement (its closed months keep their postings).
    return { accountId: await liveAccountOf(client, sel.accountId), accountRole: sel.role ?? null, mapKind: null, mapValue: null }
  }
  if (sel.sub) {
    const { kind, value } = sel.sub
    const parentRole = LEDGER_MAP_KIND_PARENT_ROLE[kind]
    const hit = mapRowOn(state.map, kind, value, day) ?? earliest(state.map, kind, value)
    const isCategory = kind === 'expense_category' || kind === 'income_category'
    // 10/12 (ledger P6): a category pointed at an account of the company's
    // choosing is no posting role's account — its lines carry no role.
    if (hit) return { accountId: hit.account_id, accountRole: isCategory ? null : sel.role ?? parentRole, mapKind: kind, mapValue: value }
    // 10/12 (Nic, ledger P6, L5): a category the company has not pointed at an
    // account of its own charges to its starting role's account (sel.role), and
    // never gets a sub-account. The line keeps the category's key, so pointing
    // the category later finds and re-posts it (services/booksCategories).
    if (isCategory) {
      const role = sel.role ?? parentRole
      const r = mapRowOn(state.map, 'role', role, day) ?? earliest(state.map, 'role', role)
      return r ? { accountId: r.account_id, accountRole: role, mapKind: kind, mapValue: value } : null
    }
    if (opts.readOnly) return null
    const parent = currentMapRow(state.map, 'role', parentRole)
    if (!parent) return null
    await lockChart(client, state.owner)
    const again = (await loadMap(client, state.owner))
    const raced = mapRowOn(again, kind, value, day) ?? earliest(again, kind, value)
    if (raced) { state.map = again; return { accountId: raced.account_id, accountRole: sel.role ?? parentRole, mapKind: kind, mapValue: value } }
    const parentCode = (await client.query<{ code: string }>(`SELECT code FROM books_accounts WHERE id = $1`, [parent.account_id])).rows[0]?.code
      ?? LEDGER_ACCOUNT_ROLE_BY_NAME[parentRole].code
    let name = sel.sub.name ?? value
    let bankConnectionId: string | null = null
    if (kind === 'bank_connection') {
      const b = (await client.query<{ institution_name: string | null; display_name: string | null; account_last4: string | null }>(
        `SELECT institution_name, display_name, account_last4 FROM bank_connections WHERE id::text = $1`, [value])).rows[0]
      bankConnectionId = b ? value : null
      // 10/12 (Nic, ledger P9 integration): the bank's display name already
      // ends in its last four on production ("PNC Bank ••9677"), so they are
      // added only when it does not — the copy's chart read "PNC Bank ••9677 ••9677".
      const shown = b?.display_name || b?.institution_name || 'bank'
      const last4 = b?.account_last4 && !shown.includes(b.account_last4) ? ` ••${b.account_last4}` : ''
      if (!sel.sub.name && b) name = `Checking: ${shown}${last4}`
    } else if (!sel.sub.name) {
      name = `Sales tax payable: ${value}`
    }
    const accountId = await insertAccountAtFreeCode(client, state.owner, {
      code: parentCode.slice(0, 16), name: name.slice(0, 200),
      type: LEDGER_ACCOUNT_ROLE_BY_NAME[parentRole].type, parentAccountId: parent.account_id, bankConnectionId,
    }, 1)
    await client.query(
      `INSERT INTO books_account_map (${ownerColOf(state.owner)}, map_kind, map_value, account_id, effective_from, note)
       VALUES ($1, $2, $3, $4, $5, 'Set up by GAM')`,
      [ownerIdOf(state.owner), kind, value, accountId, LEDGER_MAP_BEGINNING])
    state.map = await loadMap(client, state.owner)
    return { accountId, accountRole: sel.role ?? parentRole, mapKind: kind, mapValue: value }
  }
  if (!sel.role) throw new Error('A ledger line names a posting role or an account')
  const hit = mapRowOn(state.map, 'role', sel.role, day) ?? earliest(state.map, 'role', sel.role)
  if (!hit) return null
  return { accountId: hit.account_id, accountRole: sel.role, mapKind: 'role', mapValue: sel.role }
}

/**
 * 10/12 (Nic, ledger P7): the account `accountId` stands for today — itself,
 * or, once it has been retired, the account that took its place (followed
 * through a chain of retirements, never round a loop).
 */
async function liveAccountOf(client: PoolClient, accountId: string): Promise<string> {
  let at = accountId
  const seen = new Set<string>([at])
  for (let hop = 0; hop < 20; hop++) {
    const r = await client.query<{ next: string | null }>(
      `SELECT CASE WHEN active IS FALSE THEN replaced_by_account_id END AS next FROM books_accounts WHERE id = $1`, [at])
    const next = r.rows[0]?.next ?? null
    if (!next || seen.has(next)) break
    seen.add(next)
    at = next
  }
  return at
}

/** The earliest row for (kind, value): covers a day before any row's effective_from. */
function earliest(map: MapRow[], kind: LedgerMapKind, value: string): MapRow | null {
  let best: MapRow | null = null
  for (const m of map) {
    if (m.map_kind !== kind || m.map_value !== value) continue
    if (!best || m.effective_from < best.effective_from || (m.effective_from === best.effective_from && m.id < best.id)) best = m
  }
  return best
}

/** Runs `fn` in a transaction on `client` if given (the caller's), else on a fresh one. */
async function inTransaction<T>(client: PoolClient | undefined, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  if (client) return fn(client)
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const out = await fn(c)
    await c.query('COMMIT')
    return out
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    c.release()
  }
}

async function accountOf(c: PoolClient, owner: LedgerOwner, id: string, lock = false) {
  const r = await c.query<{ id: string; name: string; type: BooksAccountType; active: boolean | null; code: string }>(
    `SELECT id, name, type, active, code FROM books_accounts WHERE id = $1 AND ${ownerColOf(owner)} = $2${lock ? ' FOR UPDATE' : ''}`,
    [id, ownerIdOf(owner)])
  return r.rows[0] ?? null
}

/** One map key: a posting role, a bank's sub-account or a named tax's. */
interface MapKey { kind: LedgerMapKind; value: string }
const keyOf = (k: MapKey) => `${k.kind}\u0000${k.value}`
function isControlKey(k: MapKey): boolean {
  return k.kind === 'role' && !!LEDGER_ACCOUNT_ROLE_BY_NAME[k.value as LedgerAccountRole]?.control
}
function keyLabel(k: MapKey): string {
  if (k.kind === 'role') return LEDGER_ACCOUNT_ROLE_BY_NAME[k.value as LedgerAccountRole]?.name ?? k.value
  return k.kind === 'bank_connection' ? 'a linked bank account' : `the ${k.value} tax`
}

/**
 * 10/12 (Nic) review: may these map keys be pointed at `target`? A control
 * role needs an account of its own (nothing else uses or used it, no journal
 * lines); no other key may join an account a control role uses or used.
 * Returns the refusal in plain words, or null.
 */
async function sharingRefusal(
  c: PoolClient, owner: LedgerOwner, moving: MapKey[], target: { id: string; name: string },
): Promise<string | null> {
  const ever = (await c.query<{ map_kind: LedgerMapKind; map_value: string }>(
    `SELECT DISTINCT map_kind, map_value FROM books_account_map WHERE ${ownerColOf(owner)} = $1 AND account_id = $2`,
    [ownerIdOf(owner), target.id])).rows.map(r => ({ kind: r.map_kind, value: r.map_value }))
  const movingKeys = new Set(moving.map(keyOf))
  const others = ever.filter(k => !movingKeys.has(keyOf(k)))
  const control = moving.filter(isControlKey)
  if (control.length) {
    const role = keyLabel(control[0])
    const alongside = moving.find(m => keyOf(m) !== keyOf(control[0]))
    if (alongside) {
      return `${role} is kept by GAM from the money records and needs an account of its own; it cannot share ${target.name} with ${keyLabel(alongside)}.`
    }
    if (others.length) {
      return `${target.name} carries the postings for ${keyLabel(others[0])}. ${role} is kept by GAM from the money records and needs an account of its own. Add a new account for it.`
    }
    const journaled = (await c.query<{ j: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM journal_entry_lines WHERE account_id = $1) AS j`, [target.id])).rows[0].j
    if (journaled) {
      return `${target.name} has journal entries. ${role} is kept by GAM from the money records and needs an account with no hand entries. Add a new account for it.`
    }
    return null
  }
  const controlOther = others.find(isControlKey)
  if (controlOther) return `${target.name} is kept by GAM for ${keyLabel(controlOther)}. Choose another account.`
  return null
}

/**
 * 10/12 (Nic) review: marks for re-posting every source whose active posting
 * has a line resolved through `key` (or, with `accountId`, on that account),
 * dated `from` or later — in the caller's transaction, so the change and the
 * marks commit together. Returns how many sources were marked.
 */
async function requeuePosted(
  c: PoolClient, owner: LedgerOwner, from: string, by: { key: MapKey } | { accountId: string },
): Promise<number> {
  const col = ownerColOf(owner)
  const r = 'key' in by
    ? await c.query(
        `INSERT INTO ledger_outbox (source_type, source_id, owner_id)
         SELECT DISTINCT p.source_type, p.source_id, $1::uuid
           FROM ledger_postings p JOIN ledger_posting_lines l ON l.posting_id = p.id
          WHERE p.${col} = $1 AND p.role = 'post' AND p.superseded_at IS NULL
            AND l.map_kind = $2 AND l.map_value = $3 AND p.intended_date >= $4::date`,
        [ownerIdOf(owner), by.key.kind, by.key.value, from])
    : await c.query(
        `INSERT INTO ledger_outbox (source_type, source_id, owner_id)
         SELECT DISTINCT p.source_type, p.source_id, $1::uuid
           FROM ledger_postings p JOIN ledger_posting_lines l ON l.posting_id = p.id
          WHERE p.${col} = $1 AND p.role = 'post' AND p.superseded_at IS NULL
            AND l.account_id = $2 AND p.intended_date >= $3::date`,
        [ownerIdOf(owner), by.accountId, from])
  return r.rowCount ?? 0
}

/**
 * Points a posting role (or a bank's / a tax's sub-account mapping) at another
 * account of the company's chart, from today on (the company's own calendar).
 * Postings dated earlier keep their account. No-op when it already points
 * there. The account must be active and of the role's type.
 */
export async function repointMapping(args: {
  owner: LedgerOwner; kind: LedgerMapKind; value: string; accountId: string; actorUserId: string | null; note?: string
}, client?: PoolClient): Promise<{ changed: boolean; effectiveFrom: string }> {
  if (!(LEDGER_MAP_KINDS as readonly string[]).includes(args.kind)) throw new AppError(400, 'That is not something the books map.')
  const expected = mapTargetType(args.kind, args.value)
  if (!expected) throw new AppError(400, 'That is not a posting role the books use.')
  return inTransaction(client, async (c) => {
    await lockChart(c, args.owner)
    const acct = await accountOf(c, args.owner, args.accountId)
    if (!acct) throw new AppError(404, 'Account not found in this company\'s chart.')
    if (acct.active === false) throw new AppError(409, `${acct.name} is deleted. Choose an active account.`)
    if (acct.type !== expected) throw new AppError(409, `${acct.name} is an ${acct.type} account; this needs an ${expected} account.`)
    const ctx = await loadOwnerContext(c, args.owner)
    const map = await loadMap(c, args.owner)
    const cur = currentMapRow(map, args.kind, args.value)
    if (cur && cur.account_id === args.accountId) return { changed: false, effectiveFrom: cur.effective_from }
    const refusal = await sharingRefusal(c, args.owner, [{ kind: args.kind, value: args.value }], acct)
    if (refusal) throw new AppError(409, refusal)
    // A repoint never reaches into a closed month (the books_account_map guard
    // says the same); "from today" is always after the lock, which is never
    // today or later.
    const effectiveFrom = cur ? ctx.today : LEDGER_MAP_BEGINNING
    await c.query(
      `INSERT INTO books_account_map (${ownerColOf(args.owner)}, map_kind, map_value, account_id, effective_from, set_by, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [ownerIdOf(args.owner), args.kind, args.value, args.accountId, effectiveFrom, args.actorUserId, args.note ?? null])
    // 10/12 (Nic) review: postings already made for today or later (a bill
    // posts on its due date) resolve through the new row now; re-post them.
    await requeuePosted(c, args.owner, effectiveFrom, { key: { kind: args.kind, value: args.value } })
    return { changed: true, effectiveFrom }
  })
}

/**
 * 10/12 (Nic) review: where a retired account still takes postings, and the
 * map rows that hand those days to its replacement. For each map key, the
 * rows in force over time (the latest effective_from on or before a day wins;
 * a tie, the later row) form spans; every span on the retired account that
 * reaches an open day gets a new row for the replacement starting at the
 * span's first open day — so closed months keep their account, and every open
 * day that would have posted to the retired account posts to the replacement.
 * `pointing` is the keys whose current row is on the retired account.
 */
function retirementMoves(map: MapRow[], accountId: string, ctx: Pick<LedgerOwnerContext, 'firstOpenDay'>): {
  pointing: MapKey[]; moves: (MapKey & { from: string })[]
} {
  const firstOpen = ctx.firstOpenDay ?? LEDGER_MAP_BEGINNING
  const byKey = new Map<string, MapRow[]>()
  for (const m of map) byKey.set(keyOf({ kind: m.map_kind, value: m.map_value }), [...(byKey.get(keyOf({ kind: m.map_kind, value: m.map_value })) ?? []), m])
  const pointing: MapKey[] = []
  const moves: (MapKey & { from: string })[] = []
  for (const rows of byKey.values()) {
    // The row in force from each distinct day on (a tie: the later row).
    const sorted = [...rows].sort((a, b) => (a.effective_from < b.effective_from ? -1 : a.effective_from > b.effective_from ? 1 : a.id - b.id))
    const spans: MapRow[] = []
    for (const r of sorted) {
      if (spans.length && spans[spans.length - 1].effective_from === r.effective_from) spans[spans.length - 1] = r
      else spans.push(r)
    }
    const key: MapKey = { kind: spans[0].map_kind, value: spans[0].map_value }
    spans.forEach((span, i) => {
      if (span.account_id !== accountId) return
      const next = spans[i + 1]
      const from = span.effective_from > firstOpen ? span.effective_from : firstOpen
      if (next && from >= next.effective_from) return   // the whole span is in closed months
      moves.push({ ...key, from })
      if (!next) pointing.push(key)
    })
  }
  return { pointing, moves }
}

/**
 * "Delete" an account (Nic 10/12). GAM keeps everything: the account row and
 * every line posted to it stay as they are. When the map or posted lines
 * (automatic or a bookkeeper's journal entry) use it, a replacement of the same
 * type is required: every map key still posting to it on an open day is
 * repointed to the replacement from that key's first open day on (10/12 (Nic)
 * review: not from today — see retirementMoves), the open months' postings on
 * it are marked for re-posting, its active sub-accounts move under the
 * replacement, and it is retired naming the replacement. A control role's
 * replacement must be an account of its own (sharingRefusal). An unused
 * account is simply turned off.
 */
export async function retireAccount(args: {
  owner: LedgerOwner; accountId: string; replacementAccountId?: string | null; actorUserId: string | null
}, client?: PoolClient): Promise<{ repointed: { kind: LedgerMapKind; value: string }[]; hadHistory: boolean }> {
  return inTransaction(client, async (c) => {
    await lockChart(c, args.owner)
    const acct = await accountOf(c, args.owner, args.accountId, true)
    if (!acct) throw new AppError(404, 'Account not found in this company\'s chart.')
    if (acct.active === false) throw new AppError(409, `${acct.name} is already deleted.`)
    const usage = (await c.query<{ lines: boolean; journal: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM ledger_posting_lines WHERE account_id = $1) AS lines,
              EXISTS (SELECT 1 FROM journal_entry_lines WHERE account_id = $1) AS journal`, [acct.id])).rows[0]
    const map = await loadMap(c, args.owner)
    const ctx = await loadOwnerContext(c, args.owner)
    const { pointing, moves } = retirementMoves(map, acct.id, ctx)
    const hadHistory = usage.lines || usage.journal
    let replacement: Awaited<ReturnType<typeof accountOf>> | null = null
    if (args.replacementAccountId) {
      replacement = await accountOf(c, args.owner, args.replacementAccountId, true)
      if (!replacement) throw new AppError(404, 'The replacement account is not in this company\'s chart.')
      if (replacement.id === acct.id) throw new AppError(400, 'Choose a different account to take its place.')
      if (replacement.active === false) throw new AppError(409, `${replacement.name} is deleted. Choose an active account.`)
      if (replacement.type !== acct.type) throw new AppError(409, `${acct.name} is an ${acct.type} account; the account that takes its place must be one too.`)
      const movingKeys = [...new Map(moves.map(m => [keyOf(m), { kind: m.kind, value: m.value }])).values()]
      const refusal = await sharingRefusal(c, args.owner, movingKeys, replacement)
      if (refusal) throw new AppError(409, refusal)
    } else if (pointing.length || moves.length || hadHistory) {
      throw new AppError(409, pointing.length || moves.length
        ? `${acct.name} is where automatic postings go. Choose the account that takes its place.`
        : `${acct.name} has posted history. Choose the account that takes its place.`)
    }
    for (const m of moves) {
      await c.query(
        `INSERT INTO books_account_map (${ownerColOf(args.owner)}, map_kind, map_value, account_id, effective_from, set_by, note)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [ownerIdOf(args.owner), m.kind, m.value, replacement!.id, m.from, args.actorUserId, `Replaces ${acct.code} ${acct.name}`])
    }
    if (replacement) {
      await c.query(
        `UPDATE books_accounts SET parent_account_id = $2, updated_at = now()
          WHERE parent_account_id = $1 AND active IS NOT FALSE AND id <> $2`, [acct.id, replacement.id])
      // The open months' postings on it move to the replacement at the next drain.
      await requeuePosted(c, args.owner, ctx.firstOpenDay ?? LEDGER_MAP_BEGINNING, { accountId: acct.id })
    }
    await c.query(
      `UPDATE books_accounts
          SET active = FALSE, replaced_by_account_id = $2, retired_at = now(), retired_by = $3, updated_at = now()
        WHERE id = $1`, [acct.id, replacement?.id ?? null, args.actorUserId])
    return { repointed: pointing, hadHistory }
  })
}

/** The company's map as it stands today: every (kind, value) and its account, for the chart screen. */
export async function currentChartMap(owner: LedgerOwner): Promise<{ kind: LedgerMapKind; value: string; accountId: string; effectiveFrom: string }[]> {
  const c = await db.connect()
  try {
    const map = await loadMap(c, owner)
    const out: { kind: LedgerMapKind; value: string; accountId: string; effectiveFrom: string }[] = []
    const seen = new Set<string>()
    for (const m of map) {
      const k = `${m.map_kind}\u0000${m.map_value}`
      if (seen.has(k)) continue
      seen.add(k)
      const cur = currentMapRow(map, m.map_kind, m.map_value)!
      out.push({ kind: cur.map_kind, value: cur.map_value, accountId: cur.account_id, effectiveFrom: cur.effective_from })
    }
    return out
  } finally {
    c.release()
  }
}

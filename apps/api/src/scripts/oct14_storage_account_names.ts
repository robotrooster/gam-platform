/**
 * 10/14 (Nic) — STORAGE STAYS SEPARATE, EACH NAMED PLAINLY.
 *
 *   Nic: "storage units vs storage for rvs/boats etc" — keep them SEPARATE:
 *   a storage unit's rent is not the storage fee a tenant pays to keep an RV
 *   or a boat on a lease.
 *
 * The chart names them so from now on (packages/shared booksLedger.ts): 4060
 * is "RV and boat storage" (a lease's storage fee, role storage_fees), and a
 * storage unit's rent is "Storage unit rent" (its rent line under 4010; its
 * short-term line "Storage unit short-term stays (under 30 nights)"). A
 * company's books keep the name an account was set up with, so the accounts
 * GAM already set up under the old names are renamed here:
 *
 *   4060 role storage_fees          "Storage"            → "RV and boat storage"
 *   rent line 'storage' (under 4010) "Storage space rent" → "Storage unit rent"
 *   stay line 'storage' (under 4400) "Storage short-term stays (under 30 nights)"
 *                                   → "Storage unit short-term stays (under 30 nights)"
 *
 * Only an account GAM set up (is_system) that its key points at today and
 * that still carries GAM's old name — one a company renamed itself is left
 * alone. Only the name changes: no posting, line, amount or account moves
 * (books_accounts_ledger_guard lets a name change through untouched). Run
 * twice, the second run finds nothing to do.
 *
 * DRY RUN BY DEFAULT — read-only (it can run with default_transaction_read_only
 * on), printing every account it would rename. --apply renames them in one
 * transaction.
 *   cd apps/api && npx ts-node -T src/scripts/oct14_storage_account_names.ts
 *   cd apps/api && npx ts-node -T src/scripts/oct14_storage_account_names.ts --apply
 */
import type { PoolClient } from 'pg'
import { LEDGER_ACCOUNT_ROLE_BY_NAME, LEDGER_RENT_LINE_LABEL, LEDGER_STAY_LINE_LABEL } from '@gam/shared'
import { getClient } from '../db'

type Q = Pick<PoolClient, 'query'>

/** Each map key whose account is renamed: GAM's old name and the name it carries now. */
export const STORAGE_RENAMES: ReadonlyArray<{ kind: string; value: string; from: string; to: string }> = [
  { kind: 'role', value: 'storage_fees', from: 'Storage', to: LEDGER_ACCOUNT_ROLE_BY_NAME.storage_fees.name },
  { kind: 'rent_line', value: 'storage', from: 'Storage space rent', to: LEDGER_RENT_LINE_LABEL.storage },
  { kind: 'stay_line', value: 'storage', from: 'Storage short-term stays (under 30 nights)', to: LEDGER_STAY_LINE_LABEL.storage },
]

export interface StorageRename {
  accountId: string
  owner: string
  code: string
  kind: string
  value: string
  from: string
  to: string
}

/** Every account GAM set up under an old storage name that its key points at today (read-only). */
export async function planStorageRenames(q: Q): Promise<StorageRename[]> {
  const out: StorageRename[] = []
  for (const r of STORAGE_RENAMES) {
    if (r.from === r.to) continue
    const rows = (await q.query<{ id: string; owner: string; code: string; name: string }>(
      `SELECT a.id, a.code, a.name,
              COALESCE(NULLIF(TRIM(l.business_name), ''), b.name, a.landlord_id::text, a.business_id::text) AS owner
         FROM (SELECT DISTINCT ON (COALESCE(m.landlord_id, m.business_id)) m.account_id
                 FROM books_account_map m
                WHERE m.map_kind = $1 AND m.map_value = $2
                ORDER BY COALESCE(m.landlord_id, m.business_id), m.effective_from DESC, m.id DESC) cur
         JOIN books_accounts a ON a.id = cur.account_id
         LEFT JOIN landlords l ON l.id = a.landlord_id
         LEFT JOIN businesses b ON b.id = a.business_id
        WHERE a.is_system IS TRUE AND a.name = $3
        ORDER BY owner, a.code, a.id`, [r.kind, r.value, r.from])).rows
    for (const a of rows) out.push({ accountId: a.id, owner: a.owner, code: a.code, kind: r.kind, value: r.value, from: a.name, to: r.to })
  }
  return out
}

/** The plan in words, one line per account. */
export function describeStorageRenames(plan: readonly StorageRename[]): string[] {
  if (!plan.length) return ['  Nothing to rename: every storage account already carries its plain name (or a name its company chose).']
  return plan.map(p => `  ${p.owner}: account ${p.code} (${p.accountId}) "${p.from}" → "${p.to}"`)
}

/** Renames them (only the name, only while it is still GAM's old one). Returns how many were renamed. */
export async function applyStorageRenames(q: Q, plan: readonly StorageRename[]): Promise<number> {
  let n = 0
  for (const p of plan) {
    const r = await q.query(
      `UPDATE books_accounts SET name = $2, updated_at = now() WHERE id = $1 AND name = $3 AND is_system IS TRUE`,
      [p.accountId, p.to, p.from])
    n += r.rowCount ?? 0
  }
  return n
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply')
  const c = await getClient()
  try {
    if (!apply) {
      const plan = await planStorageRenames(c)
      console.log('DRY RUN (read-only)')
      for (const w of describeStorageRenames(plan)) console.log(w)
      console.log('Nothing written. Re-run with --apply to write.')
      return
    }
    await c.query('BEGIN')
    const plan = await planStorageRenames(c)
    console.log('APPLY')
    for (const w of describeStorageRenames(plan)) console.log(w)
    const n = await applyStorageRenames(c, plan)
    await c.query('COMMIT')
    console.log(`Committed. ${n} account${n === 1 ? '' : 's'} renamed.`)
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    c.release()
  }
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
}

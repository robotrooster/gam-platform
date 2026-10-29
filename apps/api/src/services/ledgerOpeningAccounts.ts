/**
 * 10/12 (Nic, ledger P4) — WHICH SIDE AN "OTHER" OPENING BALANCE BOOKS ON
 *
 * An "other" opening balance (books_opening_items kind 'other', the Opening
 * balances step, services/booksSettings) names the account it opens on
 * (account_id) and its amount reads in that account's NORMAL sense: an asset
 * the company has is a debit, a liability it owes or equity a credit. The
 * opening projector (ledgerProjectors/tenantOpening, design J1) needs that
 * side, and the projector rule (ledgerProjectorPurity) keeps projectors from
 * reading the chart — they name posting roles and the map resolves them.
 *
 * This is the one narrow exception, kept outside the projector files on
 * purpose: the account here is a FACT the owner entered, not a role the chart
 * resolves, and its type cannot change once the opening posting uses it (the
 * chart guard, books_accounts_ledger_guard: a type never changes while posted
 * lines use the account), so a rebuild reads the same side tomorrow.
 */
import type { PoolClient } from 'pg'
import { BOOKS_DEBIT_NORMAL_ACCOUNT_TYPES } from '@gam/shared'

/** For each account id: +1 when a positive balance is a debit (assets, expenses), −1 when a credit. */
export async function openingAccountSigns(client: PoolClient, accountIds: readonly string[]): Promise<Map<string, 1 | -1>> {
  const out = new Map<string, 1 | -1>()
  const ids = [...new Set(accountIds)]
  if (ids.length === 0) return out
  const r = await client.query<{ id: string; type: string }>(
    `SELECT id, type FROM books_accounts WHERE id = ANY($1::uuid[])`, [ids])
  for (const a of r.rows) {
    out.set(a.id, (BOOKS_DEBIT_NORMAL_ACCOUNT_TYPES as readonly string[]).includes(a.type) ? 1 : -1)
  }
  return out
}

/**
 * 10/12 (Nic, ledger P7): of these accounts, the ones whose history before the
 * books start opens in 3900 Opening balance equity rather than on the account
 * itself (design J1 a): an income or expense account (what came before is
 * equity on the start date), and a bank account (it opens only from the
 * balance the owner enters on the Opening balances step). A line that names
 * its account itself is a bookkeeper's journal entry (design J4); the
 * account's type cannot change once posted lines use it (the chart guard), so
 * a rebuild reads the same answer tomorrow.
 */
export async function openingAccountsToEquity(client: PoolClient, accountIds: readonly string[]): Promise<Set<string>> {
  const ids = [...new Set(accountIds)]
  if (ids.length === 0) return new Set()
  const r = await client.query<{ id: string }>(
    `SELECT a.id FROM books_accounts a
      WHERE a.id = ANY($1::uuid[])
        AND (a.type IN ('income', 'expense')
             OR a.bank_connection_id IS NOT NULL
             OR EXISTS (SELECT 1 FROM books_account_map m
                         WHERE m.account_id = a.id
                           AND (m.map_kind = 'bank_connection' OR (m.map_kind = 'role' AND m.map_value = 'bank_checking'))))`,
    [ids])
  return new Set(r.rows.map(x => x.id))
}

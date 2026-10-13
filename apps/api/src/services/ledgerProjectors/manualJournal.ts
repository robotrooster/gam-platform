/**
 * 10/12 (Nic) — GAM BOOKS LEDGER, PHASE P7: A BOOKKEEPER'S JOURNAL ENTRY MIRRORS INTO THE LEDGER
 * (gam-ledger-design-2026-10-12 §6 J4, §11)
 *
 *   Nic 10/12: every money event posts its own balanced lines automatically;
 *   the bookkeeper adds adjusting entries on top.
 *
 * Source 'manual_journal' = one journal_entries row and its lines. A POSTED
 * entry posts once, dated the entry's date, each line exactly as entered: the
 * account the bookkeeper picked (not a posting role — a hand entry names the
 * account itself), the side, the amount, and the property, unit and lease it
 * names (a line with no property is company level). A line carrying both a
 * debit and a credit books each side as its own line.
 *
 * journal_entry_lines stay exactly as entered. When value moves between
 * properties (a repair paid at the office charged to one park), the engine
 * adds the inter-property clearing lines (3950) to the POSTING only, as system
 * lines — never to the entry. That is why the control-account refusal reads
 * journal_entry_lines (the database refuses a hand line on an account a
 * control role uses: receivables, money GAM holds, deposits owed …, migration
 * 20261013200400) while the posting's own balance check reads the posting.
 *
 * A line on an account since deleted (retired) posts to the account that
 * took its place (the engine resolves it: booksLedgerChart.resolveAccount).
 *
 * A voided entry posts nothing: the engine takes its posting back (a
 * correction; in the first open month when the entry's month is closed). A
 * reversing entry is an entry of its own (sides swapped, its own date), so the
 * original keeps its posting and the reversal posts beside it. An adjusting
 * entry's adjusts_line_key names the automatic record it adjusts (shown beside
 * it in the general ledger); it changes nothing in the posting.
 *
 * Closed months: the database refuses an entry dated in a closed month
 * (journal_entries_closed_period_guard) — the fix is a new entry after it.
 * An entry dated before the company's books start opens in the opening
 * posting (design J1, services/ledgerProjectors/tenantOpening).
 *
 * An admin's ownerless entry and a business's entry post nothing here (the
 * business portal's books are a later phase).
 */
import type { PoolClient } from 'pg'
import type { DesiredLine, DesiredPosting, LedgerProjector, LedgerSourceRef } from '../ledgerEngine'
import type { LedgerOwner } from '../ledgerOwner'
import { cSql, isUuid } from './tenantShared'

export const MANUAL_JOURNAL_RULE_VERSION = 1

interface EntryRow {
  landlord_id: string | null
  date: string
  status: string | null
  voided_at: string | null
  description: string
  entry_number: number | null
}

interface EntryLineRow {
  account_id: string
  property_id: string | null
  unit_id: string | null
  lease_id: string | null
  description: string | null
  dr: string
  cr: string
}

export const manualJournalProjector: LedgerProjector = {
  sourceType: 'manual_journal',
  ruleVersion: MANUAL_JOURNAL_RULE_VERSION,

  async project(client: PoolClient, entryId: string): Promise<DesiredPosting[]> {
    if (!isUuid(entryId)) return []
    const e = (await client.query<EntryRow>(
      `SELECT je.landlord_id, je.date::text AS date, je.status, je.voided_at::text AS voided_at, je.description,
              je.entry_number
         FROM journal_entries je WHERE je.id = $1`, [entryId])).rows[0]
    if (!e || !e.landlord_id) return []
    if (e.voided_at || (e.status ?? 'posted') !== 'posted') return []
    const rows = (await client.query<EntryLineRow>(
      `SELECT l.account_id, l.property_id, l.unit_id, l.lease_id, l.description,
              ${cSql('l.debit')} AS dr, ${cSql('l.credit')} AS cr
         FROM journal_entry_lines l WHERE l.entry_id = $1
        ORDER BY l.created_at, l.id`, [entryId])).rows
    const lines: DesiredLine[] = []
    for (const r of rows) {
      const at = {
        accountId: r.account_id, propertyId: r.property_id, unitId: r.unit_id, leaseId: r.lease_id,
        memo: r.description || e.description,
      }
      const d = Number(r.dr)
      const c = Number(r.cr)
      if (d > 0) lines.push({ ...at, debitCents: d })
      if (c > 0) lines.push({ ...at, creditCents: c })
    }
    if (!lines.length) return []
    const memo = e.entry_number != null ? `Journal entry #${e.entry_number}: ${e.description}` : e.description
    return [{ owner: { landlordId: e.landlord_id }, intendedDate: e.date, memo, lines }]
  },

  async listSources(client: PoolClient, owner: LedgerOwner, opts: { since?: string | null }): Promise<LedgerSourceRef[]> {
    if (!owner.landlordId) return []
    const r = await client.query<{ id: string; day: string }>(
      `SELECT je.id::text AS id, je.date::text AS day FROM journal_entries je
        WHERE je.landlord_id = $1 AND ($2::date IS NULL OR je.date >= $2::date)
        ORDER BY je.date, je.id`, [owner.landlordId, opts.since ?? null])
    return r.rows
  },
}

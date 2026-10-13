/**
 * 10/12 (Nic) — GAM Books ledger (phase P3) test fixtures.
 *
 * The engine posts on its own connections and commits (one short transaction
 * per source, design §8), so ledger tests work on COMMITTED rows and clean up
 * with cleanupAllSchema between tests — never inside withRollback.
 *
 *   ledgerCompany   a landlord with a books start date, two properties, a unit
 *   addOtherIncome  a landlord_other_income row (the test projector's source)
 *   memProjector    a projector whose wanted postings a test sets by hand, for
 *                   shapes no real table gives yet (clearing, unbalanced, throwing)
 */
import type { PoolClient } from 'pg'
import { db } from '../db'
import { seedLandlord, seedProperty, seedUnit } from './dbHelpers'
import type { DesiredPosting, LedgerProjector, LedgerSourceRef } from '../services/ledgerEngine'
import type { LedgerOwner } from '../services/ledgerOwner'
import type { LedgerSourceType } from '@gam/shared'

export async function inTx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
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

export interface LedgerCompany {
  landlordId: string
  ownerUserId: string
  propertyId: string
  propertyId2: string
  unitId: string
  owner: LedgerOwner
}

/** A landlord company with books starting `booksStart` (null = none picked), two properties and a unit. */
export async function ledgerCompany(o: { booksStart?: string | null } = {}): Promise<LedgerCompany> {
  return inTx(async (c) => {
    const { userId: ownerUserId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId, managedByUserId: ownerUserId })
    const propertyId2 = await seedProperty(c, { landlordId, ownerUserId, managedByUserId: ownerUserId })
    const unitId = await seedUnit(c, { propertyId, landlordId })
    const start = o.booksStart === undefined ? '2026-01-01' : o.booksStart
    await c.query(`UPDATE landlords SET books_start_date = $2 WHERE id = $1`, [landlordId, start])
    // Set up before the test starts: nothing of its own is waiting (picking the
    // start date marked the company's opening posting, which no test projector
    // posts in this phase).
    await c.query(`DELETE FROM ledger_outbox WHERE source_type = 'opening' AND source_id = $1`, [landlordId])
    return { landlordId, ownerUserId, propertyId, propertyId2, unitId, owner: { landlordId } }
  })
}

/** Money in filed as other income (committed). Returns its id. */
export async function addOtherIncome(co: LedgerCompany, o: {
  amount: number; day: string; propertyId?: string | null; unitId?: string | null; isCommon?: boolean
}): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO landlord_other_income (landlord_id, property_id, unit_id, category, amount, income_date, is_common)
     VALUES ($1, $2, $3, 'other', $4, $5, $6) RETURNING id`,
    [co.landlordId, o.propertyId === undefined ? co.propertyId : o.propertyId, o.unitId ?? null, o.amount, o.day, !!o.isCommon])
  return r.rows[0].id
}

/** The company-local calendar day now (the engine's "today"). */
export async function companyToday(): Promise<string> {
  const r = await db.query<{ d: string }>(`SELECT (now() AT TIME ZONE 'America/Phoenix')::date::text AS d`)
  return r.rows[0].d
}

export interface PostingRow {
  id: string; role: string; posting_kind: string; is_correction: boolean; intended_date: string; accounting_date: string
  fingerprint: string; superseded_at: string | null; superseded_by: string | null; reverses_posting_id: string | null
  landlord_id: string | null; rule_version: number
}

export async function postingsOf(sourceType: string, sourceId: string): Promise<PostingRow[]> {
  const r = await db.query<PostingRow>(
    `SELECT id, role, posting_kind, is_correction, intended_date::text AS intended_date, accounting_date::text AS accounting_date,
            fingerprint, superseded_at::text AS superseded_at, superseded_by, reverses_posting_id, landlord_id, rule_version
       FROM ledger_postings WHERE source_type = $1 AND source_id = $2 ORDER BY posted_at, role DESC, id`,
    [sourceType, sourceId])
  return r.rows
}

export interface LineRow {
  posting_id: string; line_no: number; account_id: string; account_code: string; account_role: string | null
  property_id: string | null; unit_id: string | null; report_category: string | null; cash_effect: string | null
  debit: string; credit: string; system_line: boolean; accounting_date: string; intended_date: string
}

export async function linesOf(postingId: string): Promise<LineRow[]> {
  const r = await db.query<LineRow>(
    `SELECT l.posting_id, l.line_no, l.account_id, a.code AS account_code, l.account_role, l.property_id, l.unit_id,
            l.report_category, l.cash_effect, l.debit::text AS debit, l.credit::text AS credit, l.system_line,
            l.accounting_date::text AS accounting_date, l.intended_date::text AS intended_date
       FROM ledger_posting_lines l JOIN books_accounts a ON a.id = l.account_id
      WHERE l.posting_id = $1 ORDER BY l.line_no`, [postingId])
  return r.rows
}

/** Σ(credit − debit) on an account role for a company (accounting dates through `through`). */
export async function roleNet(landlordId: string, role: string, through?: string): Promise<number> {
  const r = await db.query<{ n: string }>(
    `SELECT COALESCE(sum(credit - debit), 0)::text AS n FROM ledger_posting_lines
      WHERE landlord_id = $1 AND account_role = $2 AND ($3::date IS NULL OR accounting_date <= $3::date)`,
    [landlordId, role, through ?? null])
  return Number(r.rows[0].n)
}

export async function outboxCount(sourceType?: string, sourceId?: string): Promise<number> {
  const r = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ledger_outbox
      WHERE ($1::text IS NULL OR source_type = $1) AND ($2::text IS NULL OR source_id = $2)`,
    [sourceType ?? null, sourceId ?? null])
  return r.rows[0].n
}

/**
 * A projector whose wanted postings the test sets: `wants.set(sourceId, [...])`.
 * `throwFor` makes project() throw for those ids. listSources lists every id
 * whose postings name the company.
 */
export function memProjector(sourceType: LedgerSourceType, ruleVersion = 1) {
  const wants = new Map<string, DesiredPosting[]>()
  const throwFor = new Set<string>()
  const projector: LedgerProjector = {
    sourceType,
    ruleVersion,
    async project(_c: PoolClient, sourceId: string): Promise<DesiredPosting[]> {
      if (throwFor.has(sourceId)) throw new Error(`test projector refuses ${sourceId}`)
      return (wants.get(sourceId) ?? []).map(p => ({ ...p, lines: p.lines.map(l => ({ ...l })) }))
    },
    async listSources(_c: PoolClient, owner: LedgerOwner): Promise<LedgerSourceRef[]> {
      const out: LedgerSourceRef[] = []
      for (const [id, ps] of wants) {
        const p = ps.find(x => x.owner.landlordId === owner.landlordId)
        if (p) out.push({ id, day: p.intendedDate })
      }
      return out
    },
  }
  return { projector, wants, throwFor }
}

/** Marks a source changed the way a capture trigger would (for sources with no table). */
export async function markChanged(sourceType: string, sourceId: string, ownerId: string | null): Promise<void> {
  await db.query(`INSERT INTO ledger_outbox (source_type, source_id, owner_id) VALUES ($1, $2, $3)`, [sourceType, sourceId, ownerId])
}

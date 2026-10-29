/**
 * 10/13 (Nic) — GAM BOOKS LEDGER: WHERE A COST GOES IS PICKED WHEN IT IS LOGGED
 *
 *   Nic, 10/13: "each expense is chosen on the split or specific unit or
 *   property at the time of logging. there should never be a default setting
 *   to apply expenses." And: "except gams charge all those costs get logged
 *   by a person or they wont show as itemized in the books."
 *
 * Every record a person logs that carries a cost says where it goes, in its
 * own cost_place (BOOKS_COST_PLACES; migration 20261015230000): an expense or
 * bill, a payroll run (the gross wages and the employer's taxes), a loan (each
 * payment's interest), a fixed asset (each month's depreciation):
 *   split_by_units  split across the properties the company owned on the
 *                   cost's day, by how many units each had that day — a unit
 *                   counts until the day it was retired, from the day it was
 *                   added to GAM or, when that was later, from the cost's
 *                   day as long as it was already in GAM when the cost was
 *                   logged (10/13 review: units are typed into GAM after the
 *                   books start — Oak Park's books start 8/1, its units went
 *                   in 8/14 — and the person splitting a cost chose the
 *                   properties as they stood when they logged it); company
 *                   level only when the company had no unit at all
 *   property        that property
 *   unit            that unit (on its property)
 * A record logged before 10/13 has no place and posts as it did: on its
 * property, else in the Company column (property NULL) — what the retired
 * Books setting's default put there (landlords.books_company_costs_method is
 * kept on the table and read by nothing).
 *
 * GAM's own company-wide charges are the only costs nobody logs (the $6 cost
 * of a fee pull, an instant payout's fee, a failed pull's cost, a card reader
 * piece on no property): they go to the Company column, COMPANY_COLUMN.
 *
 * Only the expense side is placed. What is owed (a payroll liability, a bill)
 * stays where its record puts it; the engine balances each property with
 * inter-property clearing lines (3950), as it does for every posting.
 *
 * Facts only (ledgerProjectorPurity): the place is stored on the record; the
 * units and owners on a past day are dated facts — units.created_at /
 * retired_at, the record's own created_at (when the cost was logged), and
 * property_transfers for a property sold to or from the company — so a
 * rebuild comes out the same tomorrow: a unit added later than both the
 * cost's day and its logging never joins its split.
 */
import type { PoolClient } from 'pg'
import type { BooksCostPlace, LedgerAccountRole } from '@gam/shared'
import type { DesiredLine } from '../ledgerEngine'
import { dr, splitCents, companyTzSql, type LineExtra } from './registerBookingPayoutKit'

/**
 * The properties the company owned on `day` and how many units each had, in a
 * stable order (property id). A property's owner on a day: the buyer of its
 * latest transfer on or before that day, else the seller of its first transfer
 * after it, else its owner today. Days are the company's books calendar. A
 * unit counts while not retired, from the day it was added to GAM — or, 10/13
 * review, from any earlier day of a cost logged (`loggedAt`, the record's
 * created_at) after it was added: units are typed in after the books start,
 * and a split chosen when the cost was logged reads the units as they stood.
 */
export async function unitsByPropertyOn(client: PoolClient, landlordId: string, day: string,
  loggedAt: string | null = null): Promise<{ propertyId: string; units: number }[]> {
  const r = await client.query<{ property_id: string; n: number }>(
    `WITH tz AS (SELECT ${companyTzSql('$1::uuid')} AS z),
          candidates AS (
            SELECT p.id, p.landlord_id FROM properties p
             WHERE p.landlord_id = $1
                OR EXISTS (SELECT 1 FROM property_transfers t
                            WHERE t.property_id = p.id AND (t.from_landlord_id = $1 OR t.to_landlord_id = $1))),
          owned AS (
            SELECT c.id FROM candidates c, tz
             WHERE COALESCE(
                     (SELECT t.to_landlord_id FROM property_transfers t
                       WHERE t.property_id = c.id AND (t.transferred_at AT TIME ZONE tz.z)::date <= $2::date
                       ORDER BY t.transferred_at DESC, t.id DESC LIMIT 1),
                     (SELECT t.from_landlord_id FROM property_transfers t
                       WHERE t.property_id = c.id AND (t.transferred_at AT TIME ZONE tz.z)::date > $2::date
                       ORDER BY t.transferred_at, t.id LIMIT 1),
                     c.landlord_id) = $1)
     SELECT u.property_id, count(*)::int AS n
       FROM units u, tz
      WHERE u.property_id IN (SELECT id FROM owned)
        AND (u.created_at IS NULL OR (u.created_at AT TIME ZONE tz.z)::date <= $2::date
             OR ($3::timestamptz IS NOT NULL AND u.created_at <= $3::timestamptz))
        AND (u.retired_at IS NULL OR (u.retired_at AT TIME ZONE tz.z)::date > $2::date)
      GROUP BY u.property_id
      ORDER BY u.property_id`, [landlordId, day, loggedAt])
  return r.rows.filter(x => x.n > 0).map(x => ({ propertyId: x.property_id, units: x.n }))
}

/** How a cost is spread on its day: one share per property (and unit), or company level (property null). */
export type CostSpread = { propertyId: string | null; unitId?: string | null; weight: number }[]

/** 10/13 (Nic): the Company column — GAM's own company-wide charges, and a cost logged before 10/13 on no property. */
export const COMPANY_COLUMN: CostSpread = [{ propertyId: null, weight: 1 }]

/** Split across the properties the company owned on `day`, by units (company level when it had none). */
export async function splitByUnits(client: PoolClient, landlordId: string, day: string, loggedAt: string | null = null): Promise<CostSpread> {
  const props = await unitsByPropertyOn(client, landlordId, day, loggedAt)
  if (!props.length) return COMPANY_COLUMN
  return props.map(p => ({ propertyId: p.propertyId, weight: p.units }))
}

/** Where a record says its cost goes (its own cost_place, property and unit). */
export interface CostPlaceFacts {
  costPlace: BooksCostPlace | null
  propertyId: string | null
  unitId: string | null
  /** 10/13 review: when the record was logged (its created_at) — a split reads the units in GAM by then too. */
  loggedAt?: string | null
}

/**
 * 10/13 (Nic): the spread of a cost a person logged, on `day`, as its record
 * says: split by units, its property, or its unit. A record with no place
 * (logged before 10/13) stays as it posted: its property, else the Company
 * column.
 */
export async function costPlaceSpread(client: PoolClient, landlordId: string, day: string, p: CostPlaceFacts): Promise<CostSpread> {
  if (p.costPlace === 'split_by_units') return splitByUnits(client, landlordId, day, p.loggedAt ?? null)
  if (p.propertyId) return [{ propertyId: p.propertyId, unitId: p.costPlace === 'unit' ? p.unitId : null, weight: 1 }]
  return COMPANY_COLUMN
}

/** A debit of `cents` on `role`, spread as `spread` says (pieces add back to the whole, to the cent). */
export function drSpread(role: LedgerAccountRole, cents: number, spread: CostSpread, extra: LineExtra = {}): DesiredLine[] {
  if (!cents) return []
  const pieces = splitCents(cents, spread.map(s => s.weight))
  return spread.flatMap((s, i) => dr(role, pieces[i], {
    ...extra, propertyId: s.propertyId, ...(s.unitId ? { unitId: s.unitId } : {}),
  }))
}

/** 10/13 (Nic): the same pieces as drSpread, credited — what takes a spread cost back exactly. */
export function crSpread(role: LedgerAccountRole, cents: number, spread: CostSpread, extra: LineExtra = {}): DesiredLine[] {
  return drSpread(role, cents, spread, extra).map(l => ({ ...l, debitCents: undefined, creditCents: l.debitCents }))
}

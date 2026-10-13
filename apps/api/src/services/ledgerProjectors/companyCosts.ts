/**
 * 10/12 (Nic) — GAM BOOKS LEDGER: WHERE A COST THAT BELONGS TO NO ONE PROPERTY GOES
 * (Nic 10/12, L7: "company-level costs: landlord's choice (Company bucket vs
 * split by units)"; gam-ledger-design-2026-10-12 §9)
 *
 * Payroll and company-wide bills belong to no one property. The owner picks,
 * once, on the Books settings page (landlords.books_company_costs_method):
 *   company_bucket   the lines stay at company level (property NULL) — a
 *                    "Company" column of their own in the reports
 *   split_by_units   the expense lines are split across the properties the
 *                    company owned on the cost's day, by how many units each
 *                    had that day (a unit counts from the day it was added
 *                    until the day it was retired)
 * Not chosen yet (NULL): the posting WAITS on the owner ('owner_not_ready':
 * retried every 15 minutes, no admin notice, retried at once when they choose).
 * GAM never picks an accounting method for a company.
 *
 * Only the expense side is split. What is owed (a payroll liability, a bill)
 * stays a company-level line; the engine balances each property with
 * inter-property clearing lines (3950), as it does for every posting.
 *
 * Facts only (ledgerProjectorPurity): the choice is fixed once the company's
 * books have posted (services/booksSettings), and the units and owners on a
 * past day are dated facts — units.created_at / retired_at, and
 * property_transfers for a property sold to or from the company — so a
 * rebuild comes out the same tomorrow.
 */
import type { PoolClient } from 'pg'
import type { BooksCompanyCostMethod, LedgerAccountRole } from '@gam/shared'
import type { DesiredLine } from '../ledgerEngine'
import { LedgerSourceError } from '../ledgerEngine'
import { dr, splitCents, companyTzSql, type LineExtra } from './registerBookingPayoutKit'

/** Nic L7: the company's choice, or the posting waits for the owner to make it. */
export async function requireCompanyCostsMethod(client: PoolClient, landlordId: string): Promise<BooksCompanyCostMethod> {
  const r = await client.query<{ m: BooksCompanyCostMethod | null }>(
    `SELECT books_company_costs_method AS m FROM landlords WHERE id = $1`, [landlordId])
  const m = r.rows[0]?.m ?? null
  if (!m) {
    throw new LedgerSourceError('owner_not_ready',
      'Waiting on the owner: where company-level costs go (a Company column of their own, or split across the properties by units) is not chosen yet on the Books settings page.')
  }
  return m
}

/**
 * The properties the company owned on `day` and how many units each had, in a
 * stable order (property id). A property's owner on a day: the buyer of its
 * latest transfer on or before that day, else the seller of its first transfer
 * after it, else its owner today. Days are the company's books calendar.
 */
export async function unitsByPropertyOn(client: PoolClient, landlordId: string, day: string): Promise<{ propertyId: string; units: number }[]> {
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
        AND (u.created_at IS NULL OR (u.created_at AT TIME ZONE tz.z)::date <= $2::date)
        AND (u.retired_at IS NULL OR (u.retired_at AT TIME ZONE tz.z)::date > $2::date)
      GROUP BY u.property_id
      ORDER BY u.property_id`, [landlordId, day])
  return r.rows.filter(x => x.n > 0).map(x => ({ propertyId: x.property_id, units: x.n }))
}

/** How a company-level cost is spread on `day`: one share per property, or company level (null) when nothing to split by. */
export type CostSpread = { propertyId: string | null; weight: number }[]

export async function companyCostSpread(client: PoolClient, landlordId: string, day: string): Promise<CostSpread> {
  const method = await requireCompanyCostsMethod(client, landlordId)
  if (method === 'company_bucket') return [{ propertyId: null, weight: 1 }]
  const props = await unitsByPropertyOn(client, landlordId, day)
  // A company with no units on that day has nothing to split by: company level.
  if (!props.length) return [{ propertyId: null, weight: 1 }]
  return props.map(p => ({ propertyId: p.propertyId, weight: p.units }))
}

/** A debit of `cents` on `role`, spread as `spread` says (pieces add back to the whole, to the cent). */
export function drSpread(role: LedgerAccountRole, cents: number, spread: CostSpread, extra: LineExtra = {}): DesiredLine[] {
  if (!cents) return []
  const pieces = splitCents(cents, spread.map(s => s.weight))
  return spread.flatMap((s, i) => dr(role, pieces[i], { ...extra, propertyId: s.propertyId }))
}

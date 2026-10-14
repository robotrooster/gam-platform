/**
 * 10/14 (Nic, I1-I7) — GAM BOOKS LEDGER: RENT AND STAYS BOOK BY THE SPACE THEY ARE FOR
 *
 *   Nic's bookkeeper (10/14): "a breakdown of where it's from, a distinction
 *   by unit type for mobile home spaces, the lot rent, any trailer payments
 *   that may be made, and RV stays that are long-term versus the short-term
 *   taxable ones ... we need everything to be as itemized as possible".
 *
 * Every projector that credits or debits rent or stay income asks here which
 * line the money is (packages/shared booksLedger.ts LEDGER_RENT_LINES /
 * LEDGER_STAY_LINES): the posting role stays space_rent / stay_income and the
 * line names its sub-account (map kind 'rent_line' / 'stay_line', added under
 * 4010 / 4400 the first time a company uses it). A charge and everything that
 * later takes it back (work trade left out of the books, a stay shortened, a
 * refund, a chargeback) ask the same question of the same facts, so they land
 * on the same line and net to nothing there.
 *
 *   Long-term (a lease's rent, a stay of 30+ nights or one a lease bills, I2):
 *     mobile home, tenant-owned trailer   all of it lot rent
 *     mobile home, park-owned trailer     lot rent = the unit's lot rent as a
 *       (units.dwelling_ownership          share of the month's rent (the
 *        'landlord')                       lease's, else the unit's); the rest
 *                                          trailer rent (I4/I5: derived, no box)
 *     every other type                    its own rent line (RV long-term rent,
 *                                          apartment rent, house rent, …)
 *   Short-term (a stay under 30 nights, I2): its type's stay line.
 *   A space GAM cannot place (no unit) stays on the role's own account.
 *
 * I5 — "the leases and purchase contracts combined with lot rent setting
 * should make it able to be derived": a trailer the renter is buying from the
 * park (a home sale gone active and not cancelled) is the renter's, so the
 * rent beside it is all lot rent; the trailer payments are home sales (I3).
 *
 * The space is read AS IT STOOD when the money was made (a bill when it was
 * billed, a stay when it was booked), from the change journal
 * (audit_row_changes, never pruned), never as it is today: a rebuild comes out
 * the same tomorrow as today (ledgerProjectorPurity), and fixing a space's type,
 * selling its trailer or changing its lot rent later never moves income
 * already booked.
 */
import type { PoolClient } from 'pg'
import {
  LEDGER_LONG_TERM_STAY_NIGHTS, LEDGER_RENT_LINES, LEDGER_RENT_LINE_LABEL, LEDGER_STAY_LINES, LEDGER_STAY_LINE_LABEL,
  type LedgerAccountRole, type LedgerRentLine, type LedgerStayLine,
} from '@gam/shared'
import type { DesiredLine } from '../ledgerEngine'

/** What a space is, for where its income books. */
export interface SpaceFacts {
  unitType: string | null
  /** A mobile home whose trailer the park owns (units.dwelling_ownership 'landlord'). */
  parkOwnedHome: boolean
  /** units.lot_rent_amount, cents. */
  lotCents: number
  /** The month's rent the lot rent is part of — the lease's, else the unit's — cents. */
  rentCents: number
}

/** One piece of income: its role, the line's sub-account (none: the role's own account) and its cents. */
export interface IncomePart {
  role: LedgerAccountRole
  sub?: DesiredLine['sub']
  cents: number
}

const isRentLine = (v: string): v is LedgerRentLine => (LEDGER_RENT_LINES as readonly string[]).includes(v)
const isStayLine = (v: string): v is LedgerStayLine => (LEDGER_STAY_LINES as readonly string[]).includes(v)

function rentSub(line: LedgerRentLine): NonNullable<DesiredLine['sub']> {
  return { kind: 'rent_line', value: line, name: LEDGER_RENT_LINE_LABEL[line] }
}
function staySub(line: LedgerStayLine): NonNullable<DesiredLine['sub']> {
  return { kind: 'stay_line', value: line, name: LEDGER_STAY_LINE_LABEL[line] }
}

/**
 * Pure: long-term money of `cents` (signed) on `space`, on its line(s).
 * `role` is the line's posting role: space_rent for a bill, stay_income for
 * a stay of 30+ nights.
 */
export function rentParts(space: SpaceFacts | null, cents: number, role: LedgerAccountRole = 'space_rent'): IncomePart[] {
  if (!cents) return []
  const t = space?.unitType ?? null
  if (!space || !t) return [{ role, cents }]
  if (t === 'mobile_home') {
    if (!space.parkOwnedHome) return [{ role, sub: rentSub('mobile_home_lot'), cents }]
    // I4/I5: the lot rent's share of the month's rent is lot rent, the rest
    // trailer rent. With no month's rent to share it in, the lot rent itself
    // (never more than the money).
    const sign = cents < 0 ? -1 : 1
    const abs = Math.abs(cents)
    const lotAbs = space.lotCents <= 0 ? 0
      : space.rentCents > 0 ? Math.min(abs, Math.round((abs * Math.min(space.lotCents, space.rentCents)) / space.rentCents))
      : Math.min(abs, space.lotCents)
    return [
      { role, sub: rentSub('mobile_home_lot'), cents: sign * lotAbs },
      { role, sub: rentSub('mobile_home_trailer'), cents: sign * (abs - lotAbs) },
    ].filter(p => p.cents !== 0)
  }
  return isRentLine(t) ? [{ role, sub: rentSub(t), cents }] : [{ role, cents }]
}

/** A stay's facts: its space, the nights sold and its terms ('lease': a lease bills the rest). */
export interface StayFacts {
  space: SpaceFacts | null
  nightsSold: number
  stayTerms: string | null
}

/** Pure: is the stay long-term (Nic I2: 30+ nights, or a lease)? */
export function stayIsLongTerm(s: Pick<StayFacts, 'nightsSold' | 'stayTerms'>): boolean {
  return s.stayTerms === 'lease' || s.nightsSold >= LEDGER_LONG_TERM_STAY_NIGHTS
}

/** Pure: stay money of `cents` (signed) on its line(s); `role` defaults to stay income. */
export function stayParts(s: StayFacts | null, cents: number, role: LedgerAccountRole = 'stay_income'): IncomePart[] {
  if (!cents) return []
  if (!s) return [{ role, cents }]
  if (stayIsLongTerm(s)) return rentParts(s.space, cents, role)
  const t = s.space?.unitType ?? null
  return t && isStayLine(t) ? [{ role, sub: staySub(t), cents }] : [{ role, cents }]
}

/**
 * SQL: column `key` of the `table` row aliased `alias` as it stood at `t`
 * (a timestamptz expression) — the first change journaled after `t` that
 * recorded the column holds its value then; none: the row as it is (it has
 * not changed since). A column added after a change was journaled is read
 * from the first change that knew it.
 */
function asOfSql(table: 'units' | 'leases', alias: string, key: string, t: string): string {
  return `(COALESCE((SELECT j.old_row -> '${key}' FROM audit_row_changes j
                      WHERE j.table_name = '${table}' AND j.row_id = ${alias}.id AND j.changed_at > ${t} AND j.old_row ? '${key}'
                      ORDER BY j.changed_at, j.id LIMIT 1),
                    to_jsonb(${alias}.${key})) #>> '{}')`
}

/**
 * SQL columns (sp_type, sp_park, sp_lot_c, sp_rent_c) of the unit aliased `u`
 * and the lease aliased `ls` (either may be NULL), as they stood at `at` (a
 * timestamptz SQL expression: when the money was made; NULL reads the oldest
 * the journal knows). A park-owned trailer the renter was buying then (a home
 * sale active at `at`) is the renter's (I5).
 */
export const SPACE_COLS_SQL = (u: string, ls: string, at: string) => {
  const t = `COALESCE((${at})::timestamptz, '-infinity'::timestamptz)`
  const unit = (key: string) => asOfSql('units', u, key, t)
  return `${unit('unit_type')} AS sp_type,
            (COALESCE(${unit('dwelling_ownership')} = 'landlord', FALSE)
             AND NOT EXISTS (SELECT 1 FROM home_sale_contracts hc
                              WHERE hc.unit_id = ${u}.id AND hc.activated_at <= ${t}
                                AND (hc.cancelled_at IS NULL OR hc.cancelled_at > ${t}))) AS sp_park,
            round(COALESCE((${unit('lot_rent_amount')})::numeric, 0) * 100)::bigint::text AS sp_lot_c,
            round(COALESCE(NULLIF((${asOfSql('leases', ls, 'rent_amount', t)})::numeric, 0), NULLIF((${unit('rent_amount')})::numeric, 0),
                           (${unit('monthly_rate')})::numeric, 0) * 100)::bigint::text AS sp_rent_c`
}

/** The SpaceFacts of a row read with SPACE_COLS_SQL (null when it names no unit). */
export function spaceOf(x: { sp_type: string | null; sp_park: boolean | null; sp_lot_c: string | null; sp_rent_c: string | null }): SpaceFacts | null {
  if (!x.sp_type) return null
  return { unitType: x.sp_type, parkOwnedHome: !!x.sp_park, lotCents: Number(x.sp_lot_c ?? 0) || 0, rentCents: Number(x.sp_rent_c ?? 0) || 0 }
}

/**
 * The space of a unit and (optionally) the lease it is rented on, as it stood
 * at `at` (an ISO time: when the money was made). `rentOf` 'unit' shares a
 * park-owned trailer's rent by the unit's own rent, as a stay does
 * (loadStay), so money a stay earned and money taken back off it split alike.
 */
export async function loadSpace(client: PoolClient, unitId: string | null, leaseId: string | null, at: string | null,
  rentOf: 'lease' | 'unit' = 'lease'): Promise<SpaceFacts | null> {
  if (!unitId && !leaseId) return null
  const r = await client.query<any>(
    `SELECT ${SPACE_COLS_SQL('su', 'sl', '$4::timestamptz')}
       FROM units su LEFT JOIN leases sl ON sl.id = $2::uuid AND $3::text = 'lease'
      WHERE su.id = COALESCE($1::uuid, (SELECT l2.unit_id FROM leases l2 WHERE l2.id = $2::uuid))`,
    [unitId, leaseId, rentOf, at])
  return r.rows[0] ? spaceOf(r.rows[0]) : null
}

/** A booking's stay facts (null: no such booking), its space as it stood when booked. The nights sold are the later of check-out and the booked check-out. */
export async function loadStay(client: PoolClient, bookingId: string | null): Promise<StayFacts | null> {
  if (!bookingId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(bookingId)) return null
  const r = await client.query<any>(
    `SELECT ${SPACE_COLS_SQL('su', 'sl', 'b.created_at')}, b.stay_terms,
            (GREATEST(b.check_out, COALESCE(b.booked_check_out, b.check_out)) - b.check_in) AS nights
       FROM unit_bookings b
       LEFT JOIN units su ON su.id = b.unit_id
       LEFT JOIN leases sl ON FALSE
      WHERE b.id = $1::uuid`, [bookingId])
  const x = r.rows[0]
  if (!x) return null
  return { space: spaceOf(x), nightsSold: Number(x.nights) || 0, stayTerms: x.stay_terms ?? null }
}

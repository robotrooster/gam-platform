/**
 * 10/12 (Nic) — GAM BOOKS LEDGER: WHOSE BOOKS, AND WHAT THEIR SETTINGS SAY
 *
 * Every ledger posting belongs to exactly one company's books: a landlord
 * company (landlords.id) or, in a later phase, a business (businesses.id). The
 * engine, the chart, the close and the checks all speak about a company
 * through this one shape, and read its books settings in one place:
 *
 *   booksStartDate   landlords.books_start_date — nothing before it posts
 *                    (it opens in the company's opening posting instead)
 *   timezone         landlords.books_timezone, else the first property's, else
 *                    America/Phoenix — the calendar "today" is read on
 *   closedThrough    the company's lock (ledger_closed_through()), NULL when
 *                    nothing is closed; firstOpenDay is the day after it
 *   openMonthFixes   Nic 10/12 (L4): 'restate' or 'day_made'
 *   closeBy/reopenBy Nic 10/12 (L3): who may close and reopen a month
 *
 * Dates travel as 'YYYY-MM-DD' strings everywhere in the ledger code (read in
 * SQL with ::text), never as JS Dates: a Date at local midnight on one machine
 * is the previous day in UTC.
 */
import type { PoolClient } from 'pg'
import type { LedgerClosePermission, LedgerOpenMonthFixMode } from '@gam/shared'
import { ledgerQuery } from '../db/ledgerPool'
import { todayIn } from '../lib/timezone'

export type LedgerOwner =
  | { landlordId: string; businessId?: undefined }
  | { businessId: string; landlordId?: undefined }

/** The owner's id, whichever kind it is. */
export function ownerIdOf(o: LedgerOwner): string {
  return (o.landlordId ?? o.businessId) as string
}
/** The column an owner is stored in. */
export function ownerColOf(o: LedgerOwner): 'landlord_id' | 'business_id' {
  return o.landlordId ? 'landlord_id' : 'business_id'
}
/** A stable text key (map keys, logs). */
export function ownerKeyOf(o: LedgerOwner): string {
  return o.landlordId ? `landlord:${o.landlordId}` : `business:${o.businessId}`
}
/** Same owner? */
export function sameOwner(a: LedgerOwner, b: LedgerOwner): boolean {
  return (a.landlordId ?? null) === (b.landlordId ?? null) && (a.businessId ?? null) === (b.businessId ?? null)
}
/** The owner a stored row names (landlord_id / business_id columns). */
export function ownerFromRow(r: { landlord_id?: string | null; business_id?: string | null }): LedgerOwner {
  if (r.landlord_id) return { landlordId: r.landlord_id }
  if (r.business_id) return { businessId: r.business_id }
  throw new Error('A ledger row names no company')
}

/**
 * The text the shared per-company ledger lock is taken on. The SQL triggers
 * use ledger_owner_lock_key() — hashtextextended('ledger_owner:' || id, 0) —
 * on the same text, so a poster, a journal entry and a close all meet on one
 * lock: posters and journal entries take it SHARED before they read the lock
 * date; a close or reopen takes it EXCLUSIVELY (design §13).
 */
export function ownerLockText(o: LedgerOwner): string {
  return `ledger_owner:${ownerIdOf(o)}`
}

/** 'YYYY-MM-DD' plus n days (calendar arithmetic, no time zone involved). */
export function addDaysIso(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d + n))
  return t.toISOString().slice(0, 10)
}
/** The later of two 'YYYY-MM-DD' days (nulls ignored). */
export function maxIso(...days: (string | null | undefined)[]): string {
  const real = days.filter((d): d is string => !!d)
  if (!real.length) throw new Error('maxIso needs at least one day')
  return real.reduce((a, b) => (a > b ? a : b))
}
/** The last day of the month 'YYYY-MM-DD' falls in. */
export function monthEndIso(day: string): string {
  const [y, m] = day.split('-').map(Number)
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)
}
/** Is 'YYYY-MM-DD' the last day of its month? */
export function isMonthEnd(day: string): boolean {
  return monthEndIso(day) === day
}
export const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/

export interface LedgerOwnerContext {
  owner: LedgerOwner
  exists: boolean
  ownerUserId: string | null
  /**
   * The COMPANY's books start: the earliest of its properties' (a derived
   * mirror kept by properties_derive_company_books_start). Null: no property
   * has picked one. Lines that name no property answer to this.
   */
  booksStartDate: string | null
  /**
   * 11/3 — each property's OWN books start, by property id (Nic, 11/2: a
   * property bought later has its own, same LLC or not). A property present
   * here with a null value has not picked one, and nothing of its posts until
   * it does. Read it through `booksStartFor`, never directly, so the
   * no-property case is answered the same way everywhere.
   */
  booksStartByProperty: ReadonlyMap<string, string | null>
  timezone: string
  /** landlords.books_timezone is set (see pinBooksTimezone); until then `timezone` is the first property's. */
  timezonePinned: boolean
  /** The company's local calendar day now. */
  today: string
  closedThrough: string | null
  /** The day after closedThrough; null when nothing is closed. */
  firstOpenDay: string | null
  openMonthFixes: LedgerOpenMonthFixMode
  closeBy: LedgerClosePermission
  reopenBy: LedgerClosePermission
}

/**
 * Reads a company's books settings and lock as of now, on `client` (so a
 * caller holding the shared ledger lock reads a lock date nobody can move).
 * A business has no books settings yet; it reads as not started.
 */
export async function loadOwnerContext(client: PoolClient, owner: LedgerOwner): Promise<LedgerOwnerContext> {
  if (owner.businessId) {
    const r = await client.query<{ exists: boolean; owner_user_id: string | null; closed_through: string | null; today: string }>(
      `SELECT EXISTS (SELECT 1 FROM businesses WHERE id = $1) AS exists,
              (SELECT owner_user_id FROM businesses WHERE id = $1) AS owner_user_id,
              ledger_closed_through(NULL, $1)::text AS closed_through,
              (now() AT TIME ZONE 'America/Phoenix')::date::text AS today`, [owner.businessId])
    const row = r.rows[0]
    return {
      owner, exists: row.exists, ownerUserId: row.owner_user_id, booksStartDate: null,
      booksStartByProperty: new Map(),
      timezone: 'America/Phoenix', timezonePinned: true, today: row.today,
      closedThrough: row.closed_through, firstOpenDay: row.closed_through ? addDaysIso(row.closed_through, 1) : null,
      openMonthFixes: 'restate', closeBy: 'owner', reopenBy: 'owner',
    }
  }
  const r = await client.query<{
    user_id: string; books_start_date: string | null; tz: string; tz_pinned: boolean; today: string; closed_through: string | null
    books_open_month_fixes: LedgerOpenMonthFixMode; books_close_by: LedgerClosePermission; books_reopen_by: LedgerClosePermission
    property_starts: Record<string, string | null> | null
  }>(
    // 11/3: one round trip still — the properties' own dates ride along as an
    // object, because loadOwnerContext runs once per owner per source and a
    // second query would double that in the engine's hottest path.
    `WITH l AS (
       SELECT l.*, COALESCE(l.books_timezone,
                (SELECT p.timezone FROM properties p
                  WHERE p.landlord_id = l.id AND p.timezone IS NOT NULL
                  ORDER BY p.created_at, p.id LIMIT 1),
                'America/Phoenix') AS tz
         FROM landlords l WHERE l.id = $1)
     SELECT l.user_id, l.books_start_date::text AS books_start_date, l.tz, l.books_timezone IS NOT NULL AS tz_pinned,
            (now() AT TIME ZONE l.tz)::date::text AS today,
            ledger_closed_through(l.id, NULL)::text AS closed_through,
            l.books_open_month_fixes, l.books_close_by, l.books_reopen_by,
            (SELECT jsonb_object_agg(p.id::text, p.books_start_date::text)
               FROM properties p WHERE p.landlord_id = l.id) AS property_starts
       FROM l`, [owner.landlordId])
  const row = r.rows[0]
  if (!row) {
    return {
      owner, exists: false, ownerUserId: null, booksStartDate: null, booksStartByProperty: new Map(),
      timezone: 'America/Phoenix', timezonePinned: true,
      today: todayIn(null), closedThrough: null, firstOpenDay: null,
      openMonthFixes: 'restate', closeBy: 'owner', reopenBy: 'owner',
    }
  }
  return {
    owner, exists: true, ownerUserId: row.user_id, booksStartDate: row.books_start_date,
    booksStartByProperty: new Map(Object.entries(row.property_starts ?? {})),
    timezone: row.tz, timezonePinned: row.tz_pinned, today: row.today,
    closedThrough: row.closed_through, firstOpenDay: row.closed_through ? addDaysIso(row.closed_through, 1) : null,
    openMonthFixes: row.books_open_month_fixes, closeBy: row.books_close_by, reopenBy: row.books_reopen_by,
  }
}

/**
 * 11/3 — THE DAY MONEY AT THIS PROPERTY BEGINS POSTING.
 *
 * Nic, 11/2: "my books for that property are going to start from when I bought
 * that property. Whether or not it's the same LLC is irrelevant."
 *
 * A line that names no property — GAM's own fee lines, a company-level entry —
 * answers to the company's earliest, because there is no property to ask and
 * the earliest is the day the company's books begin.
 *
 * A property this context has never heard of also answers to the company's
 * earliest. That is deliberately the PERMISSIVE answer (the earliest is on or
 * before every property's own), so a line we cannot place keeps posting exactly
 * as it did before the date moved onto the property. It should not happen —
 * every live posting names a property of its own owner — and treating it as
 * "not started" instead would park real money over a bookkeeping surprise.
 *
 * Null means NOT PICKED YET, which is not the same as "posts from the
 * beginning": the caller must refuse to post and wait (`no_books_start`).
 */
export function booksStartFor(
  ctx: Pick<LedgerOwnerContext, 'booksStartDate' | 'booksStartByProperty'>,
  propertyId: string | null | undefined,
): string | null {
  if (!propertyId) return ctx.booksStartDate
  if (!ctx.booksStartByProperty.has(propertyId)) return ctx.booksStartDate
  return ctx.booksStartByProperty.get(propertyId) ?? null
}

/**
 * 11/3 — SQL: THE BOOKS START DAY THAT GOVERNS A PROPERTY-SCOPED ROW.
 *
 * Nic, 11/2: a property bought later has its own books start, same LLC or not.
 * So a loan, an asset or a payment that belongs to a property answers to THAT
 * property's day — not the company's, which is now the EARLIEST of its
 * properties' and would let a later property's history in.
 *
 * The company's earliest is the fallback, and it is a real one rather than
 * defensiveness: `books_loans.property_id` and `books_fixed_assets.property_id`
 * are nullable, and a CHECK FORCES them NULL when the cost is split across
 * units. A row that names no property genuinely belongs to the company.
 *
 * Pass COLUMN EXPRESSIONS, not aliases — the property and the company may come
 * from different tables in the same query (a loan payment's company is on the
 * payment, its property on the loan).
 */
export function booksStartSql(propertyCol: string, landlordCol: string): string {
  return `COALESCE(
    (SELECT bsp.books_start_date FROM properties bsp WHERE bsp.id = ${propertyCol}),
    (SELECT min(bsp2.books_start_date) FROM properties bsp2 WHERE bsp2.landlord_id = ${landlordCol}))`
}

/**
 * Pins a company's books calendar (landlords.books_timezone) to the timezone
 * loadOwnerContext already reads for it (the first property's, else
 * America/Phoenix), the first time the company posts — so a later property
 * sale can never move the dates of company-level lines already posted.
 *
 * Its own statement on the books' pool (db/ledgerPool), NEVER inside a posting
 * transaction, and it
 * skips a landlord row another transaction holds (SKIP LOCKED): a poster must
 * never hold a row lock a money write could wait on (design §3). Skipped, it
 * pins on the company's next posting; meanwhile every reader computes the same
 * day from the same fallback. Never throws.
 */
export async function pinBooksTimezone(landlordId: string): Promise<void> {
  try {
    await ledgerQuery(
      `UPDATE landlords l
          SET books_timezone = COALESCE(
                (SELECT p.timezone FROM properties p
                  WHERE p.landlord_id = l.id AND p.timezone IS NOT NULL
                  ORDER BY p.created_at, p.id LIMIT 1), 'America/Phoenix')
        WHERE l.id = (SELECT x.id FROM landlords x
                       WHERE x.id = $1 AND x.books_timezone IS NULL
                         FOR NO KEY UPDATE SKIP LOCKED)`, [landlordId])
  } catch {
    // The next posting tries again; the fallback reads the same day meanwhile.
  }
}

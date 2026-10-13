/**
 * 10/11 (Nic) — WHICH PROPERTIES A BOOKKEEPER KEEPS, WORKED OUT IN ONE PLACE.
 *
 *   Every property is its own box. A property added or transferred in later
 *   shows up unticked.
 *
 * 10/12 (Nic) — AND THE COMPANY-WIDE BOX, AND THE CLEAN CUT AT A SALE.
 *
 *   1. "Company-wide: bank account, payouts and payroll" is its own box, the
 *      owner's choice. It alone opens the bank account, payouts, payroll and
 *      the company's Books ledger and reports (P&L, cash flow, owner
 *      statements). It is no longer inferred from "every property ticked".
 *      The property boxes keep deciding property money.
 *   2. A company with NO property box ticked is allowed when the company-wide
 *      box is. Only nothing at all is refused.
 *   3. A property sold or moved out of the company is a CLEAN CUT: the
 *      bookkeeper keeps READ access to its history for the days it was the
 *      company's — forever — and sees nothing after the transfer
 *      (bookkeeper_former_properties, dated by property_transfers).
 *   4. Lease start and end dates on their rent roll: the owner's box per
 *      bookkeeper (show_lease_dates).
 *
 * 10/12 (Nic), THREE MORE BOXES AND THE SALE ANSWER:
 *
 *   5. BK1 "May use the whole-company ledger" (company_ledger): the GAM Books
 *      ledger — chart, journal, transactions, bank reconciliation, bills,
 *      vendors, payroll, tax, P&L, balance sheet — for a bookkeeper without
 *      the company-wide box. Never the bank account or payouts (nor the Books
 *      cash flow and owner statements, which carry the payouts).
 *   6. BK2 "Company reports show the whole company" (whole_company_reports):
 *      the Books company reports (P&L, cash flow, owner statements) carry the
 *      whole company's property money; unticked, only their properties'.
 *   7. "Sees the monthly property report on screen" (sees_monthly_report).
 *   8. BK3: a bookkeeper with the company-wide box and every property the
 *      company owns today ticked IS the whole company for everything it still
 *      owns — its money on no property included, and filing at company level —
 *      even when a property they never kept was sold before (or after) they
 *      were hired. Only that sold property's history stays hidden: it is cut
 *      at HIDDEN_HISTORY (every row of it is past the cut). Before, such a
 *      property kept them from being the whole company at all.
 *
 * bookkeeper_scopes holds what the owner ticked. What the bookkeeper may read
 * is worked out from it on every request, here, for every reader: the request
 * gate (middleware/auth requireAuth), the sign-in pass (routes/auth
 * getScopeForUser), the Team page (routes/scopes), GAM Books (routes/books)
 * and the agent's roster (agents/tools/getTeam).
 *
 *   kept_ids        the ticked properties the company owns today, by name
 *   covers_all      at least one box is ticked AND every property the company
 *                   owns today is ticked (the Team page's "Every property")
 *   all_ticked      no property the company owns today is unticked (true for a
 *                   company with no property at all)
 *   company_wide    the company-wide box (an old NULL row reads as ticked in
 *                   the expand window, see below)
 *   former          the properties that left the company while ticked for
 *                   them and are not ticked again now, each with the LAST DAY
 *                   it was the company's, on the property's own calendar
 *   company_cutoffs every property that left the company and is not the
 *                   company's now, with that last day — the cut for a
 *                   bookkeeper who reads the whole company
 *
 * A request reads (requestScopeOf):
 *   propertyIds  null = the whole company — the company-wide box AND at
 *                least one property kept AND every property the company owns
 *                today ticked; it takes the company's money that sits on no
 *                property too. Else the kept properties plus the former ones
 *                (possibly none: a company-wide-only bookkeeper reads no
 *                property's money).
 *
 *   10/12 review (Nic, SECURITY): "whole" was the company-wide box and
 *   all_ticked — which is TRUE whenever the company owns no unticked property
 *   TODAY, a company that owns nothing at all included. Selling the one
 *   property a bookkeeper was never given (or every property) turned them
 *   into the whole company, and the null scope served that property's
 *   pre-sale history by landlord_id (company_cutoffs cut only after the sale).
 *   10/12 (Nic, BK3): the answer is not to refuse them the whole company but
 *   to hide that history: a property that left the company without being
 *   theirs is cut at HIDDEN_HISTORY, so the null scope reads none of it, and
 *   a company that owns nothing is never "the whole company" (a kept property
 *   is still required).
 *   cutoffs      every row of a former property dated after its last day is
 *                left out, by every reader; for a whole-company reader, every
 *                row of a property that left the company without being theirs
 *                too (HIDDEN_HISTORY). [] for an owner.
 *
 * EXPAND WINDOW. A row written before 10/11 may still hold NULL, which meant
 * "every property" — and, then, the whole company. Until a later migration
 * makes the column NOT NULL, NULL keeps that meaning here (every property, the
 * company-wide box), so nobody loses access between the deploy and the
 * backfill. Once the column is NOT NULL, the NULL branches below go.
 */
import { query } from '../db'

/** 10/12: a former property's last day ('YYYY-MM-DD', its own calendar). Rows after it are never read. */
export interface PropertyCutoff { propertyId: string; lastDay: string }
/** 10/12: a property that left the company while ticked for this bookkeeper. */
export interface FormerProperty { propertyId: string; name: string; lastDay: string }

export interface BookkeeperScopeRow {
  id: string
  user_id: string
  landlord_id: string
  access_level: string
  /** The ticked properties still the company's, by name (see header). */
  kept_ids: string[]
  /** At least one box ticked and every property the company owns today ticked. */
  covers_all: boolean
  /** No property the company owns today is unticked (true when it owns none). */
  all_ticked: boolean
  /** 10/12: the company-wide box. */
  company_wide: boolean
  /** 10/12: the lease-dates box. */
  show_lease_dates: boolean
  /** 10/12: properties that left the company while ticked for them (see header). */
  former: FormerProperty[]
  /** 10/12 (Nic, BK1): the whole-company Books ledger without the company-wide box. */
  company_ledger: boolean
  /** 10/12 (Nic, BK2): the Books company reports carry the whole company's money. */
  whole_company_reports: boolean
  /** 10/12 (Nic): the monthly property report on screen. */
  sees_monthly_report: boolean
  /** 10/12: every property that left the company, with its last day (see header). */
  company_cutoffs: PropertyCutoff[]
}

type Runner = <T>(sql: string, params: unknown[]) => Promise<T[]>

/** kept_ids for the bookkeeper_scopes row aliased `bs`. */
export function keptIdsSql(bs = 'bs'): string {
  return `(CASE WHEN ${bs}.property_ids IS NULL
      THEN ARRAY(SELECT p.id FROM properties p WHERE p.landlord_id = ${bs}.landlord_id ORDER BY p.name, p.id)
      ELSE ARRAY(SELECT p.id FROM properties p
                  WHERE p.landlord_id = ${bs}.landlord_id AND p.id = ANY(${bs}.property_ids)
                  ORDER BY p.name, p.id)
    END)`
}

/** covers_all for the bookkeeper_scopes row aliased `bs`. */
export function coversAllSql(bs = 'bs'): string {
  return `(CASE WHEN ${bs}.property_ids IS NULL THEN TRUE
      ELSE EXISTS (SELECT 1 FROM properties p
                    WHERE p.landlord_id = ${bs}.landlord_id AND p.id = ANY(${bs}.property_ids))
       AND NOT EXISTS (SELECT 1 FROM properties p
                        WHERE p.landlord_id = ${bs}.landlord_id AND NOT (p.id = ANY(${bs}.property_ids)))
    END)`
}

/** 10/12: all_ticked for the row aliased `bs` — no property of the company left unticked. */
export function allTickedSql(bs = 'bs'): string {
  return `(${bs}.property_ids IS NULL OR NOT EXISTS (SELECT 1 FROM properties p
            WHERE p.landlord_id = ${bs}.landlord_id AND NOT (p.id = ANY(${bs}.property_ids))))`
}

/** 10/12: the company-wide box for the row aliased `bs` (an old NULL row reads as ticked, see header). */
export function companyWideSql(bs = 'bs'): string {
  return `(${bs}.company_wide OR ${bs}.property_ids IS NULL)`
}

/** A timestamp's day on the property's own calendar (properties aliased `p`). */
const propertyDay = (ts: string, p: string) => `((${ts}) AT TIME ZONE COALESCE(${p}.timezone, 'America/Phoenix'))::date`

/**
 * 10/12: former for the row aliased `bs`, as jsonb [{propertyId, name, lastDay}].
 * A property ticked (and the company's) again is not former while it is.
 */
export function formerSql(bs = 'bs'): string {
  return `COALESCE((
      SELECT jsonb_agg(jsonb_build_object('propertyId', f.property_id, 'name', fp.name,
                                          'lastDay', to_char(f.last_day, 'YYYY-MM-DD'))
                       ORDER BY fp.name, fp.id)
        FROM (SELECT x.property_id, MAX(${propertyDay('x.left_at', 'xp')}) AS last_day
                FROM bookkeeper_former_properties x
                JOIN properties xp ON xp.id = x.property_id
               WHERE x.bookkeeper_scope_id = ${bs}.id
               GROUP BY x.property_id) f
        JOIN properties fp ON fp.id = f.property_id
       WHERE NOT (f.property_id = ANY(${keptIdsSql(bs)}))), '[]'::jsonb)`
}

/**
 * 10/12: company_cutoffs for the row aliased `bs`: every property transferred
 * out of the company (property_transfers) that is not the company's now, with
 * the property's own day of its latest transfer out.
 */
export function companyCutoffsSql(bs = 'bs'): string {
  return `COALESCE((
      SELECT jsonb_agg(jsonb_build_object('propertyId', t.property_id, 'lastDay', to_char(t.last_day, 'YYYY-MM-DD')))
        FROM (SELECT pt.property_id, MAX(${propertyDay('pt.transferred_at', 'tp')}) AS last_day
                FROM property_transfers pt
                JOIN properties tp ON tp.id = pt.property_id
               WHERE pt.from_landlord_id = ${bs}.landlord_id AND tp.landlord_id <> ${bs}.landlord_id
               GROUP BY pt.property_id) t), '[]'::jsonb)`
}

/**
 * A bookkeeper's scope rows, oldest first (the order the sign-in pass and the
 * request gate fall back on). `landlordId` keeps only that company's row.
 */
export async function bookkeeperScopesOf(
  userId: string,
  landlordId: string | null = null,
  run: Runner = query,
): Promise<BookkeeperScopeRow[]> {
  return run<BookkeeperScopeRow>(
    `SELECT bs.id, bs.user_id, bs.landlord_id, bs.access_level,
            ${keptIdsSql('bs')} AS kept_ids, ${coversAllSql('bs')} AS covers_all,
            ${allTickedSql('bs')} AS all_ticked, ${companyWideSql('bs')} AS company_wide,
            bs.show_lease_dates, ${formerSql('bs')} AS former, ${companyCutoffsSql('bs')} AS company_cutoffs,
            bs.company_ledger, bs.whole_company_reports, bs.sees_monthly_report
       FROM bookkeeper_scopes bs
      WHERE bs.user_id = $1 AND ($2::uuid IS NULL OR bs.landlord_id = $2::uuid)
      ORDER BY bs.created_at, bs.id`,
    [userId, landlordId])
}

/**
 * 10/12: what one request of this bookkeeper reads. Put on the request by
 * requireAuth (middleware/auth); a bare pass works it out the same way.
 */
export interface BookkeeperRequestScope {
  /**
   * Property money: null = the whole company (see the header: the company-wide
   * box, a property kept, every property the company owns today ticked — the
   * company's money on no property included, a sold property never theirs
   * hidden by `cutoffs`); else the kept properties plus the former ones. An
   * empty list reads no property.
   */
  propertyIds: string[] | null
  /** The ticked properties the company owns today: the only ones they may file on. null = whole company. */
  currentIds: string[] | null
  /** Rows of a former property after its last day are left out by every reader
   *  (and, for the whole company, every row of a property that left without
   *  being theirs: HIDDEN_HISTORY). */
  cutoffs: PropertyCutoff[]
  /** The former properties (read only, up to their last day). */
  former: FormerProperty[]
  /** The company-wide box: the bank account, payouts, payroll, the company's ledger and reports. */
  companyWide: boolean
  /** The lease-dates box: lease start and end dates on their rent roll. */
  showLeaseDates: boolean
  /**
   * 10/12 (Nic, BK1): the whole-company GAM Books ledger (chart, journal,
   * transactions, bank reconciliation, bills, vendors, payroll, tax, P&L,
   * balance sheet) — the company-wide box, or the ledger box on its own.
   */
  ledger: boolean
  /**
   * 10/12 (Nic, BK2): the property money inside the Books company reports
   * (P&L, cash flow, owner statements). Their own properties (propertyIds,
   * cutoffs) unless the "whole company" box is ticked or they are the whole
   * company; then every property the company still owns, a sold property they
   * never kept hidden (BK3).
   */
  companyReports: { propertyIds: string[] | null; cutoffs: PropertyCutoff[] }
  /** 10/12 (Nic): the monthly property report on screen (their current properties). */
  seesMonthlyReport: boolean
  /** Nothing at all: no company-wide box, no property kept, no former property. Refused downstream. */
  keepsNothing: boolean
  /**
   * 10/12 (Nic) review, SECURITY: THIS company's scope row's access level,
   * read live (bookkeeper_scopes access_level) — never the sign-in pass's, so
   * an assignment to company A never opens company B's books, and a removal
   * takes effect on the next request. 10/12 (Nic, ledger decision 2): one
   * level — any value means "a bookkeeper this company keeps" (they do the
   * full bookkeeping, bookkeeperMayWrite); null means no scope row here.
   */
  accessLevel: 'read_only' | 'read_write' | null
}

/**
 * 10/12 (Nic, BK3): the cut for a property that left the company without being
 * the bookkeeper's — before every row there is, so none of its history is ever
 * read ("only the sold property's history stays hidden").
 */
export const HIDDEN_HISTORY = '0001-01-01'

/** The request scope for one row (see header). */
export function requestScopeOf(row: BookkeeperScopeRow): BookkeeperRequestScope {
  const kept = row.kept_ids ?? []
  const former = (row.former ?? []) as FormerProperty[]
  const formerIds = former.map(f => f.propertyId).filter(id => !kept.includes(id))
  const companyCutoffs = (row.company_cutoffs ?? []) as PropertyCutoff[]
  // 10/12 (Nic, BK3): the whole company — the company-wide box and every
  // property the company owns TODAY ticked (and at least one: all_ticked alone
  // is TRUE for a company that owns nothing, the 10/12 review's hole). A
  // property that left the company does not decide it either way; the cut
  // below decides what of it they read.
  const whole = !!row.company_wide && !!row.all_ticked && kept.length > 0
  // The cut for a reader of the whole company: a former property of theirs
  // at its last day; any other property that left the company hidden whole
  // (10/12 review, SECURITY: the null scope reads by landlord_id, so without
  // this a sold property never theirs served its history to them).
  const lastDayOf = new Map<string, string>(former.map(f => [f.propertyId, f.lastDay]))
  const wholeCutoffs: PropertyCutoff[] = [
    ...companyCutoffs.map(c => ({ propertyId: c.propertyId, lastDay: lastDayOf.get(c.propertyId) ?? HIDDEN_HISTORY })),
    ...former.filter(f => !kept.includes(f.propertyId) && !companyCutoffs.some(c => c.propertyId === f.propertyId))
      .map(f => ({ propertyId: f.propertyId, lastDay: f.lastDay })),
  ]
  const ownCutoffs = former.map(f => ({ propertyId: f.propertyId, lastDay: f.lastDay }))
  const propertyIds = whole ? null : [...kept, ...formerIds]
  const cutoffs = whole ? wholeCutoffs : ownCutoffs
  // 10/12 (Nic) review, SECURITY: the ledger box (BK1) and the whole-company
  // reports box (BK2) are for a bookkeeper who keeps a property. When the last
  // property they kept leaves the company they keep only its history, up to
  // its last day (the clean cut: nothing after the transfer) — never the whole
  // company's ledger, payroll, bills or reports from then on. The company-wide
  // box is not a property box and stays what it is.
  const keepsAProperty = kept.length > 0
  const ledger = !!row.company_wide || (!!row.company_ledger && keepsAProperty)
  const wholeReports = !!row.whole_company_reports && (!!row.company_wide || keepsAProperty)
  return {
    propertyIds,
    currentIds: whole ? null : kept,
    cutoffs,
    former,
    companyWide: !!row.company_wide,
    showLeaseDates: !!row.show_lease_dates,
    ledger,
    companyReports: wholeReports && !whole
      ? { propertyIds: null, cutoffs: wholeCutoffs }
      : { propertyIds, cutoffs },
    seesMonthlyReport: !!row.sees_monthly_report,
    keepsNothing: !row.company_wide && kept.length === 0 && former.length === 0,
    accessLevel: row.access_level === 'read_write' ? 'read_write' : row.access_level === 'read_only' ? 'read_only' : null,
  }
}

/** A scope that reads nothing (no assignment at all). */
export const NO_BOOKKEEPER_SCOPE: BookkeeperRequestScope = Object.freeze({
  propertyIds: [], currentIds: [], cutoffs: [], former: [], companyWide: false, showLeaseDates: false,
  ledger: false, companyReports: Object.freeze({ propertyIds: [], cutoffs: [] }), seesMonthlyReport: false,
  keepsNothing: true, accessLevel: null,
}) as BookkeeperRequestScope

/**
 * 10/12 (Nic) review, SECURITY: may this bookkeeper write to the books of the
 * company this request is for? Judged on THAT company's scope row, read live
 * by requireAuth (the request scope), never the sign-in pass.
 *
 * 10/12 (Nic, ledger decision 2): "Full bookkeeping … never tenant-account
 * actions … One level, no per-bookkeeper switch." Every bookkeeper the company
 * keeps (a live scope row on it) does the bookkeeping; the read-only /
 * read-write box is gone (bookkeeper_scopes.access_level is kept, written
 * 'read_write', and decides nothing — migration 20261014240000). What they
 * keep is still the owner's boxes, checked by each route; a tenant's account
 * is never theirs (lib/bookkeeperAccess refuses those routes outright). No
 * scope row for the company (NO_BOOKKEEPER_SCOPE): no writes.
 */
export function bookkeeperMayWrite(scope: Pick<BookkeeperRequestScope, 'accessLevel'> | null | undefined): boolean {
  return scope?.accessLevel === 'read_write' || scope?.accessLevel === 'read_only'
}

/**
 * The refusal for a bookkeeper writing to books of a company that does not
 * keep them (no scope row on it), said the same everywhere. 10/12 (Nic): there
 * is no read-only bookkeeper any more, so this is the only reason left.
 */
export const BOOKKEEPER_NOT_ASSIGNED_REFUSAL = 'You are not assigned to that company\'s books.'
/** @deprecated 10/12 (Nic): one level — kept so older imports compile; it says why a write is refused now. */
export const READ_ONLY_REFUSAL = BOOKKEEPER_NOT_ASSIGNED_REFUSAL

/**
 * The properties a request reads for this row, in the shape every reader takes:
 * null = the whole company; else only these. [] = no property's money.
 */
export function requestPropertyIds(row: BookkeeperScopeRow): string[] | null {
  return requestScopeOf(row).propertyIds
}

// ── The clean cut, applied by every reader ─────────────────────────────────

/** 10/12: is a row of this property on this day past its former property's last day? */
export function pastCutoff(
  cutoffs: readonly PropertyCutoff[] | null | undefined,
  propertyId: string | null | undefined,
  day: string | null | undefined,
): boolean {
  if (!cutoffs?.length || !propertyId) return false
  const c = cutoffs.find(x => x.propertyId === propertyId)
  if (!c) return false
  // 10/12 (BK3): a hidden property's rows are all out, an undated one too.
  if (c.lastDay === HIDDEN_HISTORY) return true
  return !!day && String(day).slice(0, 10) > c.lastDay
}

/**
 * 10/12: the cutoffs as the jsonb parameter withinCutoffsSql reads. The keys
 * are bk_cut_* on purpose (see withinCutoffsSql).
 */
export function cutoffsParam(cutoffs: readonly PropertyCutoff[] | null | undefined): string {
  return JSON.stringify((cutoffs ?? []).map(c => ({ bk_cut_property_id: c.propertyId, bk_cut_last_day: c.lastDay })))
}

/**
 * 10/12: SQL that is TRUE unless the row is a former property's, dated after
 * its last day. `propertyCol` is the row's property, `dayExpr` its day (a
 * date), `param` a jsonb parameter from cutoffsParam ('[]' = no cut). 10/12
 * (BK3): a hidden property's rows (cut at HIDDEN_HISTORY) are all out, an
 * undated one too.
 */
export function withinCutoffsSql(propertyCol: string, dayExpr: string, param: string): string {
  // 10/12 (BK3 review): the cut's own columns are named bk_cut_* so a caller's
  // UNQUALIFIED column (landlordPL passes 'property_id') binds to its own row.
  // Named property_id / last_day, the subquery's own column won: 'property_id'
  // compared the cut with itself, so every row of every property dated after a
  // former property's last day was left out (a sold Alder hid Birch's later
  // expenses and lot rent from the bookkeeper who kept both).
  return `NOT EXISTS (SELECT 1 FROM jsonb_to_recordset(${param}::jsonb) AS bk_cut(bk_cut_property_id uuid, bk_cut_last_day date)
                       WHERE bk_cut.bk_cut_property_id = ${propertyCol}
                         AND ((${dayExpr}) > bk_cut.bk_cut_last_day OR bk_cut.bk_cut_last_day = DATE '${HIDDEN_HISTORY}'))`
}

// ── Words ───────────────────────────────────────────────────────────────────

/**
 * 10/12: the refusal for something in the company-wide box, said the same
 * everywhere. `what` reads as a subject: "The bank account", "Payroll".
 */
export function companyWideRefusal(what: string): string {
  return `${what} is in the company-wide books (the bank account, payouts and payroll), which the owner has not given you. Ask the owner for it.`
}

/**
 * 10/12 (Nic, BK1): the refusal for the whole-company Books ledger, said the
 * same everywhere, to a bookkeeper given neither the ledger box nor the
 * company-wide box.
 */
export const LEDGER_REFUSAL =
  "The company's ledger (its accounts, journal, bills, payroll and tax) is not among what the owner has given you. Ask the owner for it."

/** 10/12 (Nic): the monthly property report, to a bookkeeper not given it. */
export const MONTHLY_REPORT_REFUSAL =
  'The monthly property report is not among what the owner has given you. Ask the owner for it.'

/** 10/12: a bookkeeper who keeps nothing of the company (refused by every reader). */
export const KEEPS_NOTHING = 'None of the properties you keep belong to this company now.'

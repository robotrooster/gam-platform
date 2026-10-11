/**
 * Per-property onboarding window (S579) — the screening grandfather gate.
 *
 * A property's sitting tenants may be grandfathered past the background check
 * ONLY while its onboarding window is open. The window is system-enforced and
 * time-boxed so a landlord can't skip screening for genuinely new applicants:
 *
 *   - Opens at property creation (openOnboardingWindow).
 *   - Length = 14 days + 1 day per 10 units, capped at 30 (one billing cycle).
 *     Computed dynamically against the CURRENT unit count, so adding units
 *     during onboarding extends the window (within the cap) automatically.
 *   - Closes early when the landlord marks onboarding complete
 *     (closeOnboardingWindow), or automatically once `until` passes.
 *
 * After the window closes, every new tenant onto any unit MUST screen — there
 * is no toggle to reopen it (admin-only extension lives elsewhere). See memory
 * `gam-screening-grandfather-onboarding-window`.
 */
import { query, queryOne, getClient } from '../db'
import { AppError } from '../middleware/errorHandler'
import { MIGRATION_WINDOW_DAYS, ONBOARDING_LATE_MONTH_DAY, ONBOARDING_FIRST_BILL_NEAR_DAYS } from '@gam/shared'
import { todayIn, addDaysTo } from '../lib/timezone'
import type { PoolClient } from 'pg'

export const ONBOARDING_WINDOW_BASE_DAYS = 14
export const ONBOARDING_WINDOW_DAYS_PER_UNITS = 10 // +1 day per this many units
export const ONBOARDING_WINDOW_CAP_DAYS = 30       // one billing cycle — never default past it

const DAY_MS = 24 * 60 * 60 * 1000

/** Window length in days for a property with `unitCount` units. */
export function computeWindowDays(unitCount: number): number {
  const days = ONBOARDING_WINDOW_BASE_DAYS + Math.floor(Math.max(0, unitCount) / ONBOARDING_WINDOW_DAYS_PER_UNITS)
  return Math.min(days, ONBOARDING_WINDOW_CAP_DAYS)
}

type Runner = Pick<PoolClient, 'query'> | null

/**
 * Open the onboarding window for a freshly-created property. Idempotent: only
 * stamps `started_at` if not already set, and never reopens a completed window.
 * `window_until` is stamped as a convenience/display value; the authoritative
 * open/closed decision recomputes dynamically in getOnboardingWindow.
 */
export async function openOnboardingWindow(propertyId: string, client?: Runner): Promise<void> {
  const run = client ? (sql: string, params: any[]) => client.query(sql, params) : (sql: string, params: any[]) => query(sql, params)
  await run(
    `UPDATE properties
        SET onboarding_started_at   = COALESCE(onboarding_started_at, now()),
            onboarding_window_until = COALESCE(onboarding_started_at, now()) + ($2 || ' days')::interval
      WHERE id = $1
        AND onboarding_completed_at IS NULL
        AND onboarding_started_at IS NULL`,
    [propertyId, String(ONBOARDING_WINDOW_BASE_DAYS)],
  )
}

export interface OnboardingWindowState {
  propertyId: string
  open: boolean
  startedAt: Date | null
  until: Date | null
  completedAt: Date | null
  windowDays: number
  unitCount: number
  daysRemaining: number | null
}

/** Authoritative window state, recomputing `until` from the current unit count. */
export async function getOnboardingWindow(propertyId: string): Promise<OnboardingWindowState> {
  const row = await queryOne<{
    onboarding_started_at: string | null
    onboarding_completed_at: string | null
    unit_count: number
  }>(
    `SELECT p.onboarding_started_at, p.onboarding_completed_at,
            (SELECT COUNT(*)::int FROM units u WHERE u.property_id = p.id) AS unit_count
       FROM properties p WHERE p.id = $1`,
    [propertyId],
  )
  if (!row) throw new Error('Property not found')
  const unitCount = row.unit_count || 0
  const windowDays = computeWindowDays(unitCount)
  const startedAt = row.onboarding_started_at ? new Date(row.onboarding_started_at) : null
  const completedAt = row.onboarding_completed_at ? new Date(row.onboarding_completed_at) : null
  let until: Date | null = null
  let open = false
  let daysRemaining: number | null = null
  if (startedAt && !completedAt) {
    until = new Date(startedAt.getTime() + windowDays * DAY_MS)
    open = Date.now() < until.getTime()
    daysRemaining = open ? Math.ceil((until.getTime() - Date.now()) / DAY_MS) : 0
  }
  return { propertyId, open, startedAt, until, completedAt, windowDays, unitCount, daysRemaining }
}

/** True iff a sitting tenant may be grandfathered (screening waived) right now. */
export async function isGrandfatherEligible(propertyId: string): Promise<boolean> {
  return (await getOnboardingWindow(propertyId)).open
}

/** Mark onboarding complete — closes the window early (grandfather ends now). */
export async function closeOnboardingWindow(propertyId: string, client?: Runner): Promise<void> {
  const run = client ? (sql: string, params: any[]) => client.query(sql, params) : (sql: string, params: any[]) => query(sql, params)
  await run(
    `UPDATE properties
        SET onboarding_completed_at = COALESCE(onboarding_completed_at, now())
      WHERE id = $1`,
    [propertyId],
  )
}

export interface PropertyOnboardingWindow extends OnboardingWindowState {
  propertyName: string
  /** S648: waive late fees on each existing resident's first bill? null = not answered (no waiver). */
  lateFeeWaiver: boolean | null
  /** S655: people in this property's tenant-CSV draft roster not confirmed yet. */
  draftRosterCount: number
  /**
   * S655 (Nic, 10/2): onboarding late in the month — after the 20th in the
   * property's own calendar, or its next rent due day is close. The late-fee
   * question is flagged prominently then, because residents who take a few
   * days to sign up land straight on a first bill.
   */
  lateInMonth: boolean
  /** The property's next fixed rent due date (YYYY-MM-DD), when it bills on one fixed day. */
  nextRentDueDate: string | null
}

/**
 * S655: is it late in the month for onboarding at this property? Pure, so the
 * rule is tested on its own: after ONBOARDING_LATE_MONTH_DAY in the property's
 * calendar, or the next fixed due day is ONBOARDING_FIRST_BILL_NEAR_DAYS away
 * or less. A property billing on each move-in day has no fixed bill date, so
 * only the day-of-month half applies to it.
 */
export function onboardingLateInMonth(today: string, rentDueMode: string | null, rentDueDay: number | null):
  { lateInMonth: boolean; nextRentDueDate: string | null } {
  const dom = Number(today.slice(8, 10))
  let next: string | null = null
  if ((rentDueMode ?? 'fixed_day') === 'fixed_day') {
    const day = Math.min(28, Math.max(1, Number(rentDueDay ?? 1)))
    const thisMonth = `${today.slice(0, 7)}-${String(day).padStart(2, '0')}`
    if (thisMonth >= today) next = thisMonth
    else {
      const [y, m] = today.slice(0, 7).split('-').map(Number)
      const ny = m === 12 ? y + 1 : y
      const nm = m === 12 ? 1 : m + 1
      next = `${ny}-${String(nm).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    }
  }
  const near = next != null && next <= addDaysTo(today, ONBOARDING_FIRST_BILL_NEAR_DAYS)
  return { lateInMonth: dom > ONBOARDING_LATE_MONTH_DAY || near, nextRentDueDate: next }
}

/** Window state for every property a landlord owns — powers the onboarding banner. */
// S633: every company the ACCOUNT owns. Onboarding is per property, and an
// account's properties span its companies — scoped to one, the onboarding list
// showed half the portfolio with no sign the rest existed.
export async function listOnboardingWindowsForLandlord(landlordIds: string[]): Promise<PropertyOnboardingWindow[]> {
  if (!landlordIds.length) return []
  const rows = await query<{
    id: string; name: string
    onboarding_started_at: string | null
    onboarding_completed_at: string | null
    unit_count: number
    onboarding_late_fee_waiver: boolean | null
    timezone: string | null
    rent_due_mode: string | null
    rent_due_day: number | null
    draft_roster_count: number
  }>(
    `SELECT p.id, p.name, p.onboarding_started_at, p.onboarding_completed_at,
            p.onboarding_late_fee_waiver, p.timezone, p.rent_due_mode, p.rent_due_day,
            (SELECT COUNT(*)::int FROM units u WHERE u.property_id = p.id) AS unit_count,
            (SELECT COUNT(*)::int FROM tenant_roster_drafts r
              WHERE r.property_id = p.id AND r.confirmed_at IS NULL AND r.discarded_at IS NULL) AS draft_roster_count
       FROM properties p WHERE p.landlord_id = ANY($1::uuid[])
       ORDER BY p.created_at DESC`,
    [landlordIds],
  )
  const left = new Map<string, number>()
  for (const r of rows) left.set(r.id, (await returningResidentAllowance(r.id)).left)
  return rows.map((r) => {
    const unitCount = r.unit_count || 0
    const windowDays = computeWindowDays(unitCount)
    const startedAt = r.onboarding_started_at ? new Date(r.onboarding_started_at) : null
    const completedAt = r.onboarding_completed_at ? new Date(r.onboarding_completed_at) : null
    let until: Date | null = null
    let open = false
    let daysRemaining: number | null = null
    if (startedAt && !completedAt) {
      until = new Date(startedAt.getTime() + windowDays * DAY_MS)
      open = Date.now() < until.getTime()
      daysRemaining = open ? Math.ceil((until.getTime() - Date.now()) / DAY_MS) : 0
    }
    const late = onboardingLateInMonth(todayIn(r.timezone), r.rent_due_mode, r.rent_due_day)
    return { returningAllowanceLeft: left.get(r.id) ?? 0, propertyId: r.id, propertyName: r.name, open, startedAt, until, completedAt, windowDays, unitCount, daysRemaining, lateFeeWaiver: r.onboarding_late_fee_waiver,
             draftRosterCount: r.draft_roster_count ?? 0, lateInMonth: late.lateInMonth, nextRentDueDate: late.nextRentDueDate }
  })
}

export type ScreeningWaiveResult = { waived: boolean; reason: 'ok' | 'window_closed' | 'unit_taken' | 'not_recorded' }

/**
 * Grandfather a sitting tenant past the background check — the single source of
 * truth for the waive, used by both the explicit waive endpoint and the
 * existing-tenant onboarding routes. Enforces the gate: the property's
 * onboarding window must be OPEN and the occupied unit's grandfather slot must
 * be free (one per unit). On success records the waiver on THIS company's
 * no-unit intent (never the person's platform-wide screening status) with the
 * audit (who/when/attested/which unit) WITHOUT touching the intent's
 * unit_id (which would auto-draft a lease colliding with the e-sign flow) —
 * the grandfathered unit lands in screening_waived_unit_id instead.
 *
 * Returns a result rather than throwing so callers decide their own handling
 * (the endpoint 403/409s; onboarding just skips the waive → the tenant screens).
 * The CALLER is responsible for having verified the landlord owns the property.
 */
/**
 * S652 (Nic, option 2): a RETURNING resident — somebody the landlord attests
 * has lived at this property before — skips the background check outside the
 * onboarding window. Every attestation is recorded; a property gets a rolling
 * year's allowance of 25% of its site count, and going over it flags the
 * platform (never the landlord — "I want it to just be like, hey, you've been
 * flagged as adding too many people"). Honest parks never notice it; a park
 * waving everyone through shows up on the admin desk.
 */
export const RETURNING_RESIDENT_ALLOWANCE = 0.25

/**
 * 10/6 (Nic): the PEOPLE attested as returning at a property in the last 365
 * days — by an invite (pending_tenant_intents, waive_reason
 * 'returning_resident') or by a reservation (unit_bookings.returning_guest_at,
 * "Returning guest — they've stayed with us before"). One row per person: the
 * resident account when the person has one (a reservation's guest email is
 * matched to its account), otherwise the lowercased email. This is what the
 * allowance counts — ONE COUNT PER PERSON PER PROPERTY PER ROLLING YEAR — so a
 * person attested once is returning again for free all year, by either door.
 * `$1` is the property id.
 */
const RETURNING_PEOPLE_SQL = `
  SELECT i.tenant_id::text AS person
    FROM pending_tenant_intents i
   WHERE i.property_id = $1 AND i.waive_reason = 'returning_resident'
     AND i.screening_waived_at > NOW() - INTERVAL '365 days'
  UNION
  SELECT COALESCE(rb.tenant_id::text,
                  (SELECT rt.id::text FROM users ru JOIN tenants rt ON rt.user_id = ru.id
                    WHERE LOWER(ru.email) = LOWER(rb.guest_email)
                    ORDER BY rt.created_at LIMIT 1),
                  LOWER(rb.guest_email), rb.id::text) AS person
    FROM unit_bookings rb
    JOIN units ru2 ON ru2.id = rb.unit_id
   WHERE ru2.property_id = $1 AND rb.returning_guest_at > NOW() - INTERVAL '365 days'`

/** How much of a property's rolling-year returning-resident allowance is left. */
export async function returningResidentAllowance(propertyId: string): Promise<{ used: number; allowance: number; left: number }> {
  const row = await queryOne<{ used: string; units: string }>(
    `SELECT (SELECT COUNT(*) FROM (${RETURNING_PEOPLE_SQL}) people) AS used,
            (SELECT COUNT(*) FROM units u WHERE u.property_id = $1 AND u.retired_at IS NULL) AS units`,
    [propertyId])
  const used = Number(row?.used ?? 0)
  const allowance = Math.max(1, Math.ceil(Number(row?.units ?? 0) * RETURNING_RESIDENT_ALLOWANCE))
  return { used, allowance, left: Math.max(0, allowance - used) }
}

/**
 * 10/6 (Nic): has this person already been attested as returning at this
 * property in the last 365 days (invite or reservation)? Then attesting them
 * again is free — no new count. The person is known by their resident account
 * or their email (either is enough; both are checked).
 */
export async function personReturningAt(propertyId: string, person: { tenantId?: string | null; email?: string | null }): Promise<boolean> {
  let tenantId = person.tenantId ?? null
  let email = (person.email ?? '').trim().toLowerCase() || null
  if (tenantId && !email) {
    email = (await queryOne<{ email: string | null }>(
      `SELECT LOWER(u.email) AS email FROM tenants t JOIN users u ON u.id = t.user_id WHERE t.id = $1`, [tenantId]))?.email ?? null
  }
  if (!tenantId && email) {
    tenantId = (await queryOne<{ id: string }>(
      `SELECT t.id FROM users u JOIN tenants t ON t.user_id = u.id WHERE LOWER(u.email) = $1
        ORDER BY t.created_at LIMIT 1`, [email]))?.id ?? null
  }
  if (!tenantId && !email) return false
  const hit = await queryOne<{ one: number }>(
    `SELECT 1 AS one FROM (${RETURNING_PEOPLE_SQL}) people
      WHERE ($2::text IS NOT NULL AND people.person = $2::text)
         OR ($3::text IS NOT NULL AND people.person = $3::text)
      LIMIT 1`,
    [propertyId, tenantId, email])
  return !!hit
}

export interface ReturningAllowanceFor {
  /** Already attested at this property this rolling year — returning again costs no count. */
  free: boolean
  /** The returning choice may be used for this person now (free, or the allowance has room). */
  available: boolean
  used: number
  allowance: number
  left: number
}

/** The returning-resident allowance as it stands for one person at one property. */
export async function returningAllowanceFor(propertyId: string, person: { tenantId?: string | null; email?: string | null }): Promise<ReturningAllowanceFor> {
  const [a, free] = await Promise.all([returningResidentAllowance(propertyId), personReturningAt(propertyId, person)])
  return { ...a, free, available: free || a.left > 0 }
}

// S652 (Nic): over the allowance the option is simply DENIED — "they'll call us
// to complain that they can't skip it, and that's when we have the talk."
export const RETURNING_ALLOWANCE_USED_MESSAGE =
  'This property has used its returning-resident allowance for the year. New residents complete a background check.'
export async function applyReturningResidentWaive(opts: {
  tenantId: string; landlordId: string; propertyId: string; unitId: string; byUserId: string
}): Promise<{ waived: true; used: number; allowance: number }> {
  // 10/6 (review): under the SAME lock a reservation's "Returning guest" takes
  // (services/stayTerms attestReturningGuest) — an invite and a reservation
  // using the property's last place at the same moment: one is refused.
  const client = await getClient()
  let a: Awaited<ReturnType<typeof returningAllowanceFor>>
  let rec: Awaited<ReturnType<typeof recordWaiver>>
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`returning_allowance:${opts.propertyId}`])
    // 10/6 (Nic): one count per person per property per rolling year — a person
    // already attested here (invite or reservation) is returning again for free.
    // Read on the pool: the lock is what keeps two attestations apart, and
    // whoever held it before has committed.
    a = await returningAllowanceFor(opts.propertyId, { tenantId: opts.tenantId })
    if (!a.available) throw new AppError(409, RETURNING_ALLOWANCE_USED_MESSAGE)
    // The waiver lives on THIS company's record only — see recordWaiver.
    rec = await recordWaiver(opts, 'returning_resident', client)
    if (!rec) throw new AppError(409, WAIVER_NOT_RECORDED_MESSAGE)
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally { client.release() }
  // A waiver the account already held, or a person already counted this year,
  // is not a new use of the allowance.
  return { waived: true, used: a.used + (rec === 'recorded' && !a.free ? 1 : 0), allowance: a.allowance }
}

export async function applyScreeningWaive(opts: {
  tenantId: string
  landlordId: string
  propertyId: string
  unitId: string
  byUserId: string
}): Promise<ScreeningWaiveResult> {
  if (!(await getOnboardingWindow(opts.propertyId)).open) {
    return { waived: false, reason: 'window_closed' }
  }
  // S636 (Nic, DIRECTIVE): "All people that are onboarding as existing tenants
  // with a new electronic signature should not be asked to do the background
  // screening at all. The onboarding existing tenants should automatically be
  // bypassing that during the onboarding window."
  //
  // The slot used to be ONE PER UNIT, which quietly meant one per HOUSEHOLD: the
  // first adult invited to a mobile home was grandfathered and their spouse was
  // sent to a background check. That is the wrong shape — both of them have been
  // sitting in that home for years, and neither is applying for anything. At
  // Mountain View it put 22 existing residents in front of a screening they
  // should never have seen.
  //
  // What still bounds this is the window and the invite: a waive only happens
  // for somebody the landlord is actually onboarding to that unit, while the
  // property's onboarding window is open. Once it closes, every new resident
  // screens normally. The cap is the household, which is what it should have
  // been.

  if (!(await recordWaiver(opts, null))) return { waived: false, reason: 'not_recorded' }
  return { waived: true, reason: 'ok' }
}

/**
 * A screening waiver belongs to the COMPANY that granted it.
 *
 * It used to be written twice: onto this company's intent row AND onto the
 * person's one platform-wide screening status (tenants.background_check_status
 * = 'waived'). Every gate read the platform-wide one, so a waiver from one park
 * read as "screened" at every other landlord on GAM — the marketplace let the
 * person contact any listing's landlord, and other landlords' Applications page
 * and to-do list called them screened. It also OVERWROTE whatever was there: a
 * real approval became 'waived' (losing FlexDeposit eligibility), a denial was
 * laundered into 'waived', and a check in flight was replaced.
 *
 * Now the intent row IS the waiver, and only the granting account reads it
 * (hasScreeningWaiver / screeningWaivedByAccountSql). The person's own
 * screening status is never touched.
 *
 * The upsert targets (tenant_id, landlord_id): one live no-unit row per person
 * PER COMPANY. Keyed on tenant alone (the old index), company X's waive
 * rewrote company Y's row — Y's invite vanished from Y's pending list and Y's
 * returning-resident allowance was charged. Until the old tenant-only index is
 * dropped (after this ships), a second company's row collides with it instead
 * of overwriting it; that refusal comes back as `false` here.
 */
async function recordWaiver(
  opts: { tenantId: string; landlordId: string; propertyId: string; unitId: string; byUserId: string },
  waiveReason: 'returning_resident' | null,
  /** 10/6 (review): the caller's transaction (the returning-resident lock), or none. */
  client?: PoolClient,
): Promise<'recorded' | 'held_by_account' | false> {
  const run = client
    ? (sql: string, p: any[]) => client.query(sql, p).then(r => r.rows)
    : (sql: string, p: any[]) => query(sql, p)
  try {
    if (client) await client.query('SAVEPOINT record_waiver')
    await run(
      `INSERT INTO pending_tenant_intents
         (landlord_id, tenant_id, parser_status, property_id, unit_id,
          screening_waived, screening_waived_by, screening_waived_at, screening_attested, screening_waived_unit_id, waive_reason)
       VALUES ($1, $2, 'not_uploaded', $3, NULL, true, $4, NOW(), true, $5, $6)
       -- The per-company NO-UNIT index (this inserts unit_id NULL). See the
       -- intent_nounit_per_company migration.
       ON CONFLICT (tenant_id, landlord_id) WHERE cancelled_at IS NULL AND unit_id IS NULL DO UPDATE SET
         property_id = COALESCE(public.pending_tenant_intents.property_id, EXCLUDED.property_id),
         screening_waived = true,
         screening_waived_by = EXCLUDED.screening_waived_by,
         screening_waived_at = NOW(),
         screening_attested = true,
         screening_waived_unit_id = EXCLUDED.screening_waived_unit_id,
         waive_reason = COALESCE(EXCLUDED.waive_reason, public.pending_tenant_intents.waive_reason),
         updated_at = NOW()`,
      [opts.landlordId, opts.tenantId, opts.propertyId, opts.byUserId, opts.unitId, waiveReason],
    )
    if (client) await client.query('RELEASE SAVEPOINT record_waiver')
    return 'recorded'
  } catch (e: any) {
    if (client) await client.query('ROLLBACK TO SAVEPOINT record_waiver').catch(() => {})
    // 23505 = the person's live no-unit row belongs to another company and the
    // old tenant-only index still stands (until the post-deploy step drops
    // it). Their row is never touched.
    if (e?.code !== '23505') throw e
    // S655: a SISTER company — another company of the same account (Oak Park
    // and Mountain View) — whose row already carries a waiver is this
    // account's waiver: every reader counts it for the whole account
    // (screeningWaivedByAccountSql). Refusing here sent a returning resident
    // at the other park to "contact GAM support" for a waiver the account
    // already holds. Anything else (another account, or a sister row with no
    // waiver on it) is still refused.
    const held = (await run(
      `SELECT 1 AS one FROM pending_tenant_intents
        WHERE tenant_id = $1 AND unit_id IS NULL AND cancelled_at IS NULL
          AND screening_waived = true
          AND landlord_id IN (SELECT public.account_companies($2::uuid))
        LIMIT 1`,
      [opts.tenantId, opts.landlordId]))[0]
    return held ? 'held_by_account' : false
  }
}

export const WAIVER_NOT_RECORDED_MESSAGE =
  'The waiver could not be recorded for this person yet. Please contact GAM support.'

/**
 * Does any of these companies hold a live screening waiver for this person?
 * Pass the companies of ONE account (account_companies of the company asking)
 * — a waiver from another account never counts.
 */
export async function hasScreeningWaiver(tenantId: string, landlordIds: string[]): Promise<boolean> {
  if (!tenantId || !landlordIds.length) return false
  const row = await queryOne<{ one: number }>(
    `SELECT 1 AS one FROM pending_tenant_intents
      WHERE tenant_id = $1 AND screening_waived = true AND cancelled_at IS NULL
        AND landlord_id = ANY($2::uuid[])
      LIMIT 1`,
    [tenantId, landlordIds])
  return !!row
}

/**
 * SQL fragment for list queries: true when the account that owns
 * `landlordExpr` holds a live screening waiver for the tenant `tenantExpr`.
 * Both arguments are SQL expressions from the caller's own query, never user
 * input.
 */
export function screeningWaivedByAccountSql(tenantExpr: string, landlordExpr: string): string {
  return `EXISTS (SELECT 1 FROM pending_tenant_intents wv
                   WHERE wv.tenant_id = ${tenantExpr} AND wv.screening_waived = true
                     AND wv.cancelled_at IS NULL
                     AND wv.landlord_id IN (SELECT public.account_companies(${landlordExpr})))`
}

/**
 * SQL fragment: true when the background check row `alias` is a RENTER-POOL
 * check — one the applicant ran with no company (the listings / renter-pool
 * intake, which GAM anchors at its own pool account, landlords.is_system) and
 * agreed to share. That is the only way a check legitimately moves between
 * companies.
 *
 * consent_pool on its own is NOT enough: the same box is offered on an
 * application to a specific company, and that check is still that company's
 * own decision. Counting it let company B treat company A's approval as
 * screened (prod's one pooled check was run for a real park, not the pool).
 * A NULL landlord is the pre-S564 speculative intake — no company ran it.
 * `alias` is a table alias from the caller's own query, never user input.
 */
export function pooledCheckSql(alias: string): string {
  return `(${alias}.consent_pool = true
           AND (${alias}.landlord_id IS NULL
                OR ${alias}.landlord_id IN (SELECT pl.id FROM landlords pl WHERE pl.is_system = true)))`
}

/**
 * SQL fragment: true when the person has an APPROVED background check this
 * account may rely on — one run for any company of this account, or a
 * renter-pool check (pooledCheckSql). Another account's own check never
 * counts and is never shown, whatever its consent_pool box says.
 */
export function approvedCheckForAccountSql(tenantExpr: string, userExpr: string, landlordExpr: string): string {
  return `EXISTS (SELECT 1 FROM background_checks sbc
                   WHERE (sbc.tenant_id = ${tenantExpr} OR sbc.user_id = ${userExpr})
                     AND sbc.status = 'approved'
                     AND (${pooledCheckSql('sbc')}
                          OR sbc.landlord_id IN (SELECT public.account_companies(${landlordExpr}))))`
}

/**
 * S631 (Nic, DIRECTIVE): "When a landlord is in the onboarding window, any
 * invites should be automatically flagged as existing tenancies. It takes a
 * different path in the onboarding window, like that twenty-eight day grace
 * period that we added."
 *
 * Whoever a landlord invites while they are still moving onto the platform is,
 * by definition, somebody already living there — that is what the window is for.
 * Making the landlord tick a box per resident to say so would get it wrong at
 * exactly the moment it matters most: mid-onboarding, at volume, under time
 * pressure. The 29 invites Nic sent for Oak Park went out before this flag
 * existed and had to be backfilled by hand; that must not be the normal path.
 *
 * EITHER window counts. The per-property onboarding window is the one a landlord
 * experiences (it opens when they start setting a property up); the landlord's
 * own 28-day migration window is the platform-wide one the published terms cite.
 * A landlord papering sitting tenants is inside at least one of them, and being
 * inside either is enough.
 *
 * Fails CLOSED — an error or a missing property yields false, so the worst case
 * is a landlord marking an existing tenancy by hand, never GAM silently deciding
 * a genuine new move-in should skip proration.
 */
export async function isExistingTenancyInvite(
  landlordId: string,
  propertyId: string | null,
): Promise<boolean> {
  try {
    if (propertyId && (await getOnboardingWindow(propertyId)).open) return true
    const l = await queryOne<{ within: boolean }>(
      `SELECT (now() < created_at + ($2::int * INTERVAL '1 day')) AS within
         FROM landlords WHERE id = $1`,
      [landlordId, MIGRATION_WINDOW_DAYS],
    )
    return !!l?.within
  } catch {
    return false
  }
}

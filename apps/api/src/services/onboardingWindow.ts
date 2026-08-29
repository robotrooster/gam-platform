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
import { query, queryOne } from '../db'
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

export interface PropertyOnboardingWindow extends OnboardingWindowState { propertyName: string }

/** Window state for every property a landlord owns — powers the onboarding banner. */
export async function listOnboardingWindowsForLandlord(landlordId: string): Promise<PropertyOnboardingWindow[]> {
  const rows = await query<{
    id: string; name: string
    onboarding_started_at: string | null
    onboarding_completed_at: string | null
    unit_count: number
  }>(
    `SELECT p.id, p.name, p.onboarding_started_at, p.onboarding_completed_at,
            (SELECT COUNT(*)::int FROM units u WHERE u.property_id = p.id) AS unit_count
       FROM properties p WHERE p.landlord_id = $1
       ORDER BY p.created_at DESC`,
    [landlordId],
  )
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
    return { propertyId: r.id, propertyName: r.name, open, startedAt, until, completedAt, windowDays, unitCount, daysRemaining }
  })
}

export type ScreeningWaiveResult = { waived: boolean; reason: 'ok' | 'window_closed' | 'unit_taken' }

/**
 * Grandfather a sitting tenant past the background check — the single source of
 * truth for the waive, used by both the explicit waive endpoint and the
 * existing-tenant onboarding routes. Enforces the gate: the property's
 * onboarding window must be OPEN and the occupied unit's grandfather slot must
 * be free (one per unit). On success sets background_check_status='waived' and
 * records the audit (who/when/attested/which unit) WITHOUT touching the intent's
 * unit_id (which would auto-draft a lease colliding with the e-sign flow) —
 * the grandfathered unit lands in screening_waived_unit_id instead.
 *
 * Returns a result rather than throwing so callers decide their own handling
 * (the endpoint 403/409s; onboarding just skips the waive → the tenant screens).
 * The CALLER is responsible for having verified the landlord owns the property.
 */
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
  const taken = await queryOne<{ tenant_id: string }>(
    `SELECT tenant_id FROM pending_tenant_intents
      WHERE screening_waived_unit_id = $1 AND cancelled_at IS NULL AND tenant_id <> $2 LIMIT 1`,
    [opts.unitId, opts.tenantId],
  )
  if (taken) return { waived: false, reason: 'unit_taken' }

  await query(`UPDATE tenants SET background_check_status = 'waived' WHERE id = $1`, [opts.tenantId])
  await query(
    `INSERT INTO pending_tenant_intents
       (landlord_id, tenant_id, parser_status, property_id, unit_id,
        screening_waived, screening_waived_by, screening_waived_at, screening_attested, screening_waived_unit_id)
     VALUES ($1, $2, 'not_uploaded', $3, NULL, true, $4, NOW(), true, $5)
     -- S629: the NO-UNIT index (this inserts unit_id NULL). See the
     -- intent_unique_per_unit migration.
     ON CONFLICT (tenant_id) WHERE cancelled_at IS NULL AND unit_id IS NULL DO UPDATE SET
       property_id = COALESCE(public.pending_tenant_intents.property_id, EXCLUDED.property_id),
       screening_waived = true,
       screening_waived_by = EXCLUDED.screening_waived_by,
       screening_waived_at = NOW(),
       screening_attested = true,
       screening_waived_unit_id = EXCLUDED.screening_waived_unit_id,
       updated_at = NOW()`,
    [opts.landlordId, opts.tenantId, opts.propertyId, opts.byUserId, opts.unitId],
  )
  return { waived: true, reason: 'ok' }
}

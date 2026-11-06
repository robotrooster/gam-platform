/**
 * 11/01 — WHOSE POLICY IS THIS? ONE ANSWER, IN ONE PLACE.
 *
 * Reading another landlord's row, or another landlord's uploaded file, is the
 * recurring bug class in this codebase, and it has one cause every time: the
 * check is written again at each call site, so one call site is written without
 * it. Every read in routes/insurance.ts — the list, the lapse list, one policy,
 * and the certificate PDF — goes through `scopedPolicyWhere` below. There is no
 * second way to fetch a policy, which is the point.
 *
 * ── THE COMPANY COMES FROM THE SUBJECT ──────────────────────────────────────
 *
 * `insurance_policies` stores no landlord_id (see the migration header):
 * ownership lives on the property, and a denormalized company id is a second
 * answer that can disagree with the first. So the joins below resolve, per row:
 *
 *   owner_landlord_id  the company whose record this is, or NULL
 *   owner_property_id  the property it concerns, or NULL (company-wide)
 *
 *   property subject   -> properties.landlord_id,   properties.id
 *   lease subject      -> leases.landlord_id,       units.property_id
 *   vendor subject     -> books_vendors.landlord_id, NULL
 *   contractor subject -> NULL, NULL
 *
 * A contractor's certificate is the CONTRACTOR'S paper, not a landlord's, so it
 * resolves to no company and no landlord scope can ever match it. That is not a
 * gap: the contractor marketplace has its own privacy rule for it (a landlord
 * sees a contractor's paper only on a job that contractor bid on), and until
 * that surface exists, a landlord asking for one gets the same answer as for a
 * row that is not there.
 *
 * A vendor with a business_id instead of a landlord_id (the business portal's
 * own vendor list) likewise resolves to no company, so the landlord portal
 * cannot reach it.
 *
 * ── NARROWED STAFF ──────────────────────────────────────────────────────────
 *
 * getScopedPropertyIds returns null for "not narrowed" and a list for "these
 * properties only". A narrowed staffer is held to their list for rows that NAME
 * a property, and still sees the company's own company-wide rows (a vendor's
 * certificate is not a property's). That is the same distinction every other
 * scoped read in the portal makes — the Books P&L, the owner statements — and
 * the note on getScopedPropertyIds spells out why returning a list for an
 * unnarrowed person broke those.
 */
import type { AuthPayload } from '../middleware/auth'
import { getScopedPropertyIds } from '../middleware/auth'
import { landlordScopeIds } from '../lib/landlordScope'
import { query } from '../db'
import { addDaysTo, todayIn } from '../lib/timezone'
import {
  INSURANCE_LAPSE_DEFAULT_DAYS,
  INSURANCE_LAPSE_MAX_DAYS,
  type InsuranceCoverageType,
  type InsuranceSubject,
} from '@gam/shared'

/** Roles that see every company's rows. */
const PLATFORM_ROLES = new Set(['admin', 'super_admin'])

/**
 * The FROM clause every read shares. `ip` is the policy; `owner_landlord_id`
 * and `owner_property_id` are derived, never stored.
 */
export const POLICY_FROM = `
  FROM insurance_policies ip
  LEFT JOIN properties    sp ON sp.id = ip.property_id
  LEFT JOIN leases        sl ON sl.id = ip.lease_id
  LEFT JOIN units         su ON su.id = sl.unit_id
  LEFT JOIN books_vendors sv ON sv.id = ip.vendor_id
`

/** Derived columns, for the SELECT list and for the scope predicate alike. */
const OWNER_LANDLORD = `COALESCE(sp.landlord_id, sl.landlord_id, sv.landlord_id)`
const OWNER_PROPERTY = `COALESCE(sp.id, su.property_id)`

export interface PolicyRow {
  id: string
  subject: InsuranceSubject
  property_id: string | null
  lease_id: string | null
  vendor_id: string | null
  contractor_id: string | null
  owner_landlord_id: string | null
  owner_property_id: string | null
  subject_name: string | null
  coverage_type: InsuranceCoverageType
  carrier_name: string
  policy_number: string | null
  coverage_amount: string | null
  effective_date: string | null
  expiry_date: string | null
  proof_file_name: string | null
  proof_mime_type: string | null
  proof_file_size_bytes: number | null
  proof_uploaded_at: string | null
  has_proof: boolean
  recorded_by_user_id: string | null
  recorded_by_name: string | null
  verified_at: string | null
  verified_by_user_id: string | null
  verified_by_name: string | null
  verified: boolean
  notes: string | null
  voided_at: string | null
  void_reason: string | null
  created_at: string
  updated_at: string
}

/**
 * The SELECT list. `proof_url` is DELIBERATELY ABSENT — a path on GAM's disk is
 * not something a client needs, and the only way to the bytes is
 * GET /api/insurance/:id/proof, which authorizes the row first. `has_proof`
 * tells a screen whether to show the link.
 */
const POLICY_COLUMNS = `
  ip.id,
  ip.property_id, ip.lease_id, ip.vendor_id, ip.contractor_id,
  CASE WHEN ip.property_id   IS NOT NULL THEN 'property'
       WHEN ip.lease_id      IS NOT NULL THEN 'resident'
       WHEN ip.vendor_id     IS NOT NULL THEN 'vendor'
       ELSE 'contractor' END AS subject,
  ${OWNER_LANDLORD} AS owner_landlord_id,
  ${OWNER_PROPERTY} AS owner_property_id,
  COALESCE(sp.name, sv.name, su.unit_number) AS subject_name,
  ip.coverage_type, ip.carrier_name, ip.policy_number, ip.coverage_amount,
  -- A DATE as text, deliberately: node-postgres turns a date column into a JS
  -- Date at local midnight, and JSON.stringify then shifts it a day in half the
  -- world's timezones. ISO text sorts and reads the same everywhere. (A date
  -- cast to text is not the ORDER BY trap — every ORDER BY here is qualified
  -- with ip. anyway.)
  ip.effective_date::text AS effective_date,
  ip.expiry_date::text    AS expiry_date,
  ip.proof_file_name, ip.proof_mime_type, ip.proof_file_size_bytes, ip.proof_uploaded_at,
  (ip.proof_url IS NOT NULL) AS has_proof,
  ip.recorded_by_user_id,
  NULLIF(BTRIM(CONCAT_WS(' ', ru.first_name, ru.last_name)), '') AS recorded_by_name,
  ip.verified_at, ip.verified_by_user_id,
  NULLIF(BTRIM(CONCAT_WS(' ', vu.first_name, vu.last_name)), '') AS verified_by_name,
  (ip.verified_at IS NOT NULL) AS verified,
  ip.notes, ip.voided_at, ip.void_reason,
  ip.created_at, ip.updated_at
`

const POLICY_NAME_JOINS = `
  LEFT JOIN users ru ON ru.id = ip.recorded_by_user_id
  LEFT JOIN users vu ON vu.id = ip.verified_by_user_id
`

/**
 * The scope predicate for this caller, as SQL plus the params it needs.
 *
 * `next` is the 1-based number the first new placeholder should take, so a
 * caller that already has params appends rather than inserting — repointing
 * every later $N is how a bind-param edit 500s every request
 * ([[sql-bind-param-mid-array]]).
 *
 * A caller with no landlord scope at all (a tenant, an unscoped user) gets
 * `FALSE`: not an error, an empty list. A tenant never reaches these routes —
 * requirePerm refuses them at the door — and a read that would return nothing
 * should return nothing rather than leak the shape of a refusal.
 */
export async function scopedPolicyWhere(
  user: AuthPayload,
  next: number,
): Promise<{ sql: string; params: unknown[] }> {
  if (PLATFORM_ROLES.has(user.role)) return { sql: 'TRUE', params: [] }

  const companies = landlordScopeIds(user)
  if (!companies.length) return { sql: 'FALSE', params: [] }

  const params: unknown[] = [companies]
  let sql = `${OWNER_LANDLORD} = ANY($${next}::uuid[])`

  const scopedProperties = await getScopedPropertyIds(user)
  if (scopedProperties !== null) {
    // Narrowed. Property-bearing rows are held to the grant; the company's own
    // company-wide rows (a vendor's certificate) are still theirs.
    params.push(scopedProperties)
    sql += ` AND (${OWNER_PROPERTY} IS NULL OR ${OWNER_PROPERTY} = ANY($${next + 1}::uuid[]))`
  }
  return { sql, params }
}

/**
 * One policy, or null — null both when the row does not exist and when it is
 * not this caller's. The two are indistinguishable on purpose: "Forbidden" on a
 * guessed id confirms the id is real, which is how one landlord learns another
 * landlord's row exists.
 */
export async function getPolicyForUser(user: AuthPayload, id: string): Promise<PolicyRow | null> {
  const scope = await scopedPolicyWhere(user, 2)
  const rows = await query<PolicyRow>(
    `SELECT ${POLICY_COLUMNS} ${POLICY_FROM} ${POLICY_NAME_JOINS}
      WHERE ip.id = $1 AND (${scope.sql})`,
    [id, ...scope.params],
  )
  return rows[0] ?? null
}

/**
 * The stored file behind a policy, with the same scope check. Separate from
 * getPolicyForUser only because proof_url never belongs in a response body —
 * it is read here and handed straight to the streamer.
 */
export async function getPolicyProofForUser(
  user: AuthPayload,
  id: string,
): Promise<{ proof_url: string | null; proof_mime_type: string | null; proof_file_name: string | null } | null> {
  const scope = await scopedPolicyWhere(user, 2)
  const rows = await query<{ proof_url: string | null; proof_mime_type: string | null; proof_file_name: string | null }>(
    `SELECT ip.proof_url, ip.proof_mime_type, ip.proof_file_name ${POLICY_FROM}
      WHERE ip.id = $1 AND (${scope.sql})`,
    [id, ...scope.params],
  )
  return rows[0] ?? null
}

export interface ListPolicyFilters {
  propertyId?: string
  leaseId?: string
  vendorId?: string
  coverageType?: InsuranceCoverageType
  /** Voided rows are kept forever but are off the list unless asked for. */
  includeVoided?: boolean
}

export async function listPoliciesForUser(
  user: AuthPayload,
  filters: ListPolicyFilters = {},
): Promise<PolicyRow[]> {
  const params: unknown[] = []
  const conds: string[] = []

  if (filters.propertyId) conds.push(`ip.property_id = $${params.push(filters.propertyId)}::uuid`)
  if (filters.leaseId) conds.push(`ip.lease_id = $${params.push(filters.leaseId)}::uuid`)
  if (filters.vendorId) conds.push(`ip.vendor_id = $${params.push(filters.vendorId)}::uuid`)
  if (filters.coverageType) conds.push(`ip.coverage_type = $${params.push(filters.coverageType)}`)
  if (!filters.includeVoided) conds.push(`ip.voided_at IS NULL`)

  const scope = await scopedPolicyWhere(user, params.length + 1)
  conds.push(`(${scope.sql})`)
  params.push(...scope.params)

  // ip.expiry_date, qualified: an unqualified name resolves against the output
  // columns first ([[orderByNamesTheColumn]]). NULLS LAST keeps the policies
  // with no end date below the ones that have one.
  return query<PolicyRow>(
    `SELECT ${POLICY_COLUMNS} ${POLICY_FROM} ${POLICY_NAME_JOINS}
      WHERE ${conds.join(' AND ')}
      ORDER BY ip.expiry_date ASC NULLS LAST, ip.created_at DESC`,
    params,
  )
}

export interface LapseRow extends PolicyRow {
  /** Negative when it has already gone: -3 is "lapsed three days ago". */
  days_until_expiry: number
  expired: boolean
}

export interface LapseList {
  asOf: string
  days: number
  expired: LapseRow[]
  expiringSoon: LapseRow[]
}

/** 0..365, default 30. A caller that asks for nonsense is told, not silently clamped. */
export function lapseWindowDays(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === '') return INSURANCE_LAPSE_DEFAULT_DAYS
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0 || n > INSURANCE_LAPSE_MAX_DAYS) return null
  return n
}

/**
 * What has expired, and what expires within `days`.
 *
 * "Today" comes from the calendar, computed in JS and passed as a parameter —
 * never CURRENT_DATE. A bill, a due date or a lapse worked out from the
 * server's UTC clock is a day wrong every evening ([[gam-evening-utc-today-
 * flakes]], the todayIn note), and a date computed in SQL is also a date no
 * test can pin.
 *
 * The window is inclusive at BOTH ends and the boundary is tested: a policy
 * expiring exactly `days` out is on the list, one expiring the day after is
 * not, one that expired yesterday is, and one expiring today counts as
 * expiring today rather than as already gone.
 *
 * A policy with no expiry date is never a lapse — there is nothing to lapse.
 */
export async function lapseListForUser(
  user: AuthPayload,
  days: number = INSURANCE_LAPSE_DEFAULT_DAYS,
): Promise<LapseList> {
  const asOf = todayIn(null)
  const cutoff = addDaysTo(asOf, days)

  const params: unknown[] = [asOf, cutoff]
  const scope = await scopedPolicyWhere(user, 3)
  params.push(...scope.params)

  const rows = await query<LapseRow>(
    `SELECT ${POLICY_COLUMNS},
            (ip.expiry_date - $1::date) AS days_until_expiry,
            (ip.expiry_date < $1::date) AS expired
       ${POLICY_FROM} ${POLICY_NAME_JOINS}
      WHERE ip.voided_at IS NULL
        AND ip.expiry_date IS NOT NULL
        AND ip.expiry_date <= $2::date
        AND (${scope.sql})
      ORDER BY ip.expiry_date ASC, ip.created_at ASC`,
    params,
  )

  return {
    asOf,
    days,
    expired: rows.filter(r => r.expired),
    expiringSoon: rows.filter(r => !r.expired),
  }
}

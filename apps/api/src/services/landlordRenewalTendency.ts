/**
 * Landlord RENEWAL TENDENCY — aggregate "how this landlord handles renewals"
 * for the tenant-transparency tool (Nic 2026-06-15: "tenants should be able to
 * see that landlords renew leases for 10 percent more, or opt not to renew").
 *
 * Derived entirely from captured history — GAM models a renewal as a NEW lease
 * linked to the prior via `supersedes_lease_id` (the old rent is preserved, not
 * overwritten — see project_data_capture_mandate), so the rent delta and
 * non-renewal are computable. AGGREGATE only: a typical % increase + a
 * renewal/non-renewal rate across the landlord's leases, never naming or
 * exposing an individual other tenant. A min-count gate (≥ MIN_RENEWALS) keeps a
 * single tenancy from being inferable.
 */
import { query } from '../db'

const MIN_RENEWALS = Number(process.env.RENEWAL_TENDENCY_MIN) || 3

export interface LandlordRenewalTendency {
  /** Median rent-increase % applied on renewal (null if too few renewals to anonymize). */
  median_increase_pct: number | null
  avg_increase_pct: number | null
  renewal_count: number
  /** Of leases that ended, the share NOT renewed (null if too few to anonymize). */
  non_renewal_rate_pct: number | null
  ended_count: number
}

export async function getLandlordRenewalTendency(landlordId: string): Promise<LandlordRenewalTendency | null> {
  const id = String(landlordId || '').trim()
  if (!id) return null
  const rows = await query<{
    renewal_count: string
    median_increase_pct: string | null
    avg_increase_pct: string | null
    ended_count: string
    not_renewed_count: string
  }>(
    `WITH renewals AS (
       SELECT (b.rent_amount - a.rent_amount) / NULLIF(a.rent_amount, 0) * 100 AS pct
         FROM leases b
         JOIN leases a ON a.id = b.supersedes_lease_id
        WHERE b.landlord_id = $1 AND a.rent_amount > 0
     ),
     ended AS (
       SELECT l.id, EXISTS (SELECT 1 FROM leases s WHERE s.supersedes_lease_id = l.id) AS renewed
         FROM leases l
        WHERE l.landlord_id = $1 AND l.status IN ('expired', 'terminated')
     )
     SELECT (SELECT COUNT(*) FROM renewals)                                                          AS renewal_count,
            (SELECT round(percentile_cont(0.5) WITHIN GROUP (ORDER BY pct)::numeric, 1) FROM renewals) AS median_increase_pct,
            (SELECT round(avg(pct)::numeric, 1) FROM renewals)                                        AS avg_increase_pct,
            (SELECT COUNT(*) FROM ended)                                                              AS ended_count,
            (SELECT COUNT(*) FILTER (WHERE NOT renewed) FROM ended)                                   AS not_renewed_count`,
    [id]
  )
  const r = rows[0]
  if (!r) return null

  const renewalCount = Number(r.renewal_count)
  const endedCount = Number(r.ended_count)
  const notRenewed = Number(r.not_renewed_count)

  // Min-count gate: only surface a figure when enough events back it that no
  // single tenancy is exposed.
  const enoughRenewals = renewalCount >= MIN_RENEWALS
  const enoughEnded = endedCount >= MIN_RENEWALS

  if (!enoughRenewals && !enoughEnded) return null

  return {
    median_increase_pct: enoughRenewals && r.median_increase_pct != null ? Number(r.median_increase_pct) : null,
    avg_increase_pct: enoughRenewals && r.avg_increase_pct != null ? Number(r.avg_increase_pct) : null,
    renewal_count: renewalCount,
    non_renewal_rate_pct: enoughEnded ? Math.round((notRenewed / endedCount) * 100) : null,
    ended_count: endedCount,
  }
}

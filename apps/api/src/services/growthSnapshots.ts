/**
 * S550 (Nic) — daily growth snapshots: "track every data point we possibly
 * can" for how fast and where the platform is growing.
 *
 * created_at on every entity answers WHEN it onboarded; this captures what
 * can't be reconstructed later because it mutates — occupancy, rent roll,
 * counts that a delete would erase. One row per (date, state, city) plus a
 * platform-wide totals row ('*','*') — distinct-landlord counts don't sum
 * across cities (one landlord can span several), so totals are computed
 * globally, never derived by summing.
 *
 * Idempotent per day (upsert): re-running the cron or calling it manually
 * refreshes today's rows.
 *
 * Aggregation shape: unit/lease counts and rent roll come from the
 * properties→units→active-lease join (NO tenant join — a two-tenant lease
 * must count its rent once); active-tenant counts come from a separate
 * subquery. `scopeExpr` swaps real (state, city) for ('*','*') so both
 * passes share one statement.
 */
import { query } from '../db'

export interface GrowthSnapshotResult {
  date: string
  geoRows: number
}

function snapshotSql(scope: 'geo' | 'total'): string {
  const stateExpr = scope === 'geo' ? `UPPER(TRIM(p.state))` : `'*'`
  const cityExpr  = scope === 'geo' ? `INITCAP(TRIM(p.city))` : `'*'`
  const groupBy   = scope === 'geo' ? `GROUP BY 2, 3` : ``
  return `
    INSERT INTO platform_growth_snapshots
      (snapshot_date, state, city, landlords, properties, units,
       occupied_units, vacant_units, active_leases, active_tenants, monthly_rent_roll)
    SELECT
      CURRENT_DATE,
      ${stateExpr},
      ${cityExpr},
      COUNT(DISTINCT p.landlord_id),
      COUNT(DISTINCT p.id),
      COUNT(DISTINCT u.id),
      COUNT(DISTINCT u.id) FILTER (WHERE al.lease_id IS NOT NULL),
      COUNT(DISTINCT u.id) FILTER (WHERE u.status = 'vacant'),
      COUNT(DISTINCT al.lease_id),
      COALESCE(SUM(al.tenant_count), 0),
      COALESCE(SUM(al.rent_amount), 0)
    FROM properties p
    JOIN landlords ll ON ll.id = p.landlord_id AND ll.is_demo = FALSE
    LEFT JOIN units u ON u.property_id = p.id
    LEFT JOIN LATERAL (
      SELECT l.id AS lease_id, l.rent_amount,
             (SELECT COUNT(*) FROM lease_tenants lt
               WHERE lt.lease_id = l.id AND lt.status = 'active') AS tenant_count
        FROM leases l
       WHERE l.unit_id = u.id AND l.status = 'active'
       ORDER BY l.created_at DESC
       LIMIT 1
    ) al ON TRUE
    ${groupBy}
    ON CONFLICT (snapshot_date, state, city) DO UPDATE SET
      landlords = EXCLUDED.landlords,
      properties = EXCLUDED.properties,
      units = EXCLUDED.units,
      occupied_units = EXCLUDED.occupied_units,
      vacant_units = EXCLUDED.vacant_units,
      active_leases = EXCLUDED.active_leases,
      active_tenants = EXCLUDED.active_tenants,
      monthly_rent_roll = EXCLUDED.monthly_rent_roll
  `
}

/**
 * PROPERTY-grain snapshot — the finest grain; per-landlord and per-geo
 * rollups derive from it (the landlord "70% then, 85% now" reports).
 * Captures the mutable operational state: occupancy, delinquency,
 * eviction load, open maintenance, outstanding balances.
 */
async function capturePropertySnapshots(): Promise<void> {
  await query(`
    INSERT INTO property_growth_snapshots
      (snapshot_date, property_id, landlord_id, units, occupied_units,
       vacant_units, delinquent_units, suspended_units, active_leases,
       active_tenants, monthly_rent_roll, outstanding_balance, open_maintenance)
    SELECT
      CURRENT_DATE, p.id, p.landlord_id,
      COUNT(DISTINCT u.id),
      COUNT(DISTINCT u.id) FILTER (WHERE al.lease_id IS NOT NULL),
      COUNT(DISTINCT u.id) FILTER (WHERE u.status = 'vacant'),
      COUNT(DISTINCT u.id) FILTER (WHERE u.status = 'delinquent'),
      COUNT(DISTINCT u.id) FILTER (WHERE u.status = 'suspended'),
      COUNT(DISTINCT al.lease_id),
      COALESCE(SUM(al.tenant_count), 0),
      COALESCE(SUM(al.rent_amount), 0),
      COALESCE((SELECT SUM(pay.amount) FROM payments pay
                 JOIN leases pl ON pl.id = pay.lease_id
                 JOIN units pu ON pu.id = pl.unit_id
                WHERE pu.property_id = p.id
                  AND pay.status IN ('pending', 'failed')), 0),
      (SELECT COUNT(*) FROM maintenance_requests mr
         JOIN units mu ON mu.id = mr.unit_id
        WHERE mu.property_id = p.id
          AND mr.status NOT IN ('completed', 'cancelled'))
    FROM properties p
    LEFT JOIN units u ON u.property_id = p.id
    LEFT JOIN LATERAL (
      SELECT l.id AS lease_id, l.rent_amount,
             (SELECT COUNT(*) FROM lease_tenants lt
               WHERE lt.lease_id = l.id AND lt.status = 'active') AS tenant_count
        FROM leases l
       WHERE l.unit_id = u.id AND l.status = 'active'
       ORDER BY l.created_at DESC
       LIMIT 1
    ) al ON TRUE
    GROUP BY p.id, p.landlord_id
    ON CONFLICT (snapshot_date, property_id) DO UPDATE SET
      landlord_id = EXCLUDED.landlord_id,
      units = EXCLUDED.units,
      occupied_units = EXCLUDED.occupied_units,
      vacant_units = EXCLUDED.vacant_units,
      delinquent_units = EXCLUDED.delinquent_units,
      suspended_units = EXCLUDED.suspended_units,
      active_leases = EXCLUDED.active_leases,
      active_tenants = EXCLUDED.active_tenants,
      monthly_rent_roll = EXCLUDED.monthly_rent_roll,
      outstanding_balance = EXCLUDED.outstanding_balance,
      open_maintenance = EXCLUDED.open_maintenance
  `)
}

/**
 * Engagement history: last_login_at overwrites, so the rolling-window
 * active-user counts are captured daily on the platform totals row.
 */
async function captureEngagement(): Promise<void> {
  await query(`
    UPDATE platform_growth_snapshots SET
      -- Demo/dev accounts excluded (dev-only email domains) so engagement
      -- reflects real customers only.
      active_users_1d  = (SELECT COUNT(*) FROM users WHERE last_login_at > NOW() - INTERVAL '1 day' AND email NOT LIKE '%@demo.dev' AND email NOT LIKE '%@tenant.dev' AND email NOT LIKE '%@gam.dev' AND email NOT LIKE '%@test.dev' AND email NOT LIKE 'test%@golddoor.io'),
      active_users_7d  = (SELECT COUNT(*) FROM users WHERE last_login_at > NOW() - INTERVAL '7 days' AND email NOT LIKE '%@demo.dev' AND email NOT LIKE '%@tenant.dev' AND email NOT LIKE '%@gam.dev' AND email NOT LIKE '%@test.dev' AND email NOT LIKE 'test%@golddoor.io'),
      active_users_30d = (SELECT COUNT(*) FROM users WHERE last_login_at > NOW() - INTERVAL '30 days' AND email NOT LIKE '%@demo.dev' AND email NOT LIKE '%@tenant.dev' AND email NOT LIKE '%@gam.dev' AND email NOT LIKE '%@test.dev' AND email NOT LIKE 'test%@golddoor.io'),
      active_tenant_users_30d = (SELECT COUNT(*) FROM users
        WHERE role = 'tenant' AND last_login_at > NOW() - INTERVAL '30 days' AND email NOT LIKE '%@demo.dev' AND email NOT LIKE '%@tenant.dev' AND email NOT LIKE '%@gam.dev' AND email NOT LIKE '%@test.dev' AND email NOT LIKE 'test%@golddoor.io'),
      active_landlord_side_users_30d = (SELECT COUNT(*) FROM users
        WHERE role IN ('landlord', 'property_manager', 'onsite_manager', 'maintenance', 'bookkeeper')
          AND last_login_at > NOW() - INTERVAL '30 days' AND email NOT LIKE '%@demo.dev' AND email NOT LIKE '%@tenant.dev' AND email NOT LIKE '%@gam.dev' AND email NOT LIKE '%@test.dev' AND email NOT LIKE 'test%@golddoor.io')
    WHERE snapshot_date = CURRENT_DATE AND state = '*' AND city = '*'
  `)
}

export async function captureGrowthSnapshot(): Promise<GrowthSnapshotResult> {
  await query(snapshotSql('geo'))
  await query(snapshotSql('total'))
  await capturePropertySnapshots()
  await captureEngagement()
  const r = await query<{ n: string; d: string }>(
    `SELECT COUNT(*)::text AS n, CURRENT_DATE::text AS d
       FROM platform_growth_snapshots WHERE snapshot_date = CURRENT_DATE`,
  )
  return { date: r[0].d, geoRows: parseInt(r[0].n, 10) }
}

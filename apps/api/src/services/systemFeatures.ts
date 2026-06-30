import { query, queryOne } from '../db'

// ============================================================
// Platform-level feature flags. Designed generically so future
// flags reuse the same table without per-feature migrations.
//
// Helper short-circuits cleanly: when a flag isn't set, returns
// FALSE (closed/hidden). Callers don't need to handle "not found"
// vs "disabled" separately.
// ============================================================

export async function isFeatureEnabled(key: string): Promise<boolean> {
  const row = await queryOne<{ enabled: boolean }>(
    `SELECT enabled FROM system_features WHERE key = $1`,
    [key],
  )
  return row?.enabled === true
}

export async function listFeatures() {
  return query<{ key: string; enabled: boolean; description: string; updated_at: string }>(
    `SELECT key, enabled, description, updated_at FROM system_features ORDER BY key`,
  )
}

export async function setFeatureEnabled(
  key: string,
  enabled: boolean,
  updatedByUserId: string,
): Promise<void> {
  // Upsert, not UPDATE: a missing row must not silently no-op the toggle.
  // (description defaults to the key on first insert; the seed migration carries
  // the human-readable text for known flags.)
  await query(
    `INSERT INTO system_features (key, enabled, description, updated_by_user_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (key) DO UPDATE
        SET enabled = EXCLUDED.enabled,
            updated_at = NOW(),
            updated_by_user_id = EXCLUDED.updated_by_user_id`,
    [key, enabled, key, updatedByUserId],
  )
}

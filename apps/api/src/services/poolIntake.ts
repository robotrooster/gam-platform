/**
 * S564: renter-pool intake shell lookups.
 *
 * The pool-intake shell landlord + property (created by
 * scripts/createPoolIntakeShell.ts) anchors landlord-less ("speculative")
 * background checks: Checkr Tenant orders require a rental property, so a
 * speculative check is routed at this shell property. On completion, a check
 * against the shell landlord auto-migrates into application_pool.
 *
 * The shell is identified by a stable email (not an env var) so it resolves
 * without per-environment configuration wherever the shell has been created.
 * Kept deliberately un-cached — a single indexed lookup — so a provider flip
 * (mock → checkr) takes effect without a process restart.
 */
import { queryOne } from '../db'

export const POOL_INTAKE_EMAIL = 'pool-intake@gam.internal'

export interface PoolIntakeShell {
  landlordId: string
  userId: string
  propertyId: string
  backgroundProvider: string
  property: { name: string; street: string; city: string; state: string; zip: string }
}

/** Resolve the pool-intake shell (landlord + property), or null if not set up. */
export async function getPoolIntakeShell(): Promise<PoolIntakeShell | null> {
  const row = await queryOne<any>(
    `SELECT l.id AS landlord_id, l.user_id, l.background_provider,
            p.id AS property_id, p.name, p.street1, p.city, p.state, p.zip
       FROM landlords l
       JOIN users u ON u.id = l.user_id
       LEFT JOIN properties p ON p.landlord_id = l.id
      WHERE u.email = $1 AND l.is_system = true
      LIMIT 1`,
    [POOL_INTAKE_EMAIL]
  )
  if (!row || !row.property_id) return null
  return {
    landlordId: row.landlord_id,
    userId: row.user_id,
    propertyId: row.property_id,
    backgroundProvider: row.background_provider,
    property: { name: row.name, street: row.street1, city: row.city, state: row.state, zip: row.zip },
  }
}

/** True if the given landlord id is the pool-intake shell landlord. */
export async function isPoolIntakeLandlord(landlordId: string | null | undefined): Promise<boolean> {
  if (!landlordId) return false
  const shell = await getPoolIntakeShell()
  return !!shell && shell.landlordId === landlordId
}

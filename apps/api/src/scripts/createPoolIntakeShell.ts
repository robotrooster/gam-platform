/**
 * S564: create the GAM "Renter Pool Intake" shell entity.
 *
 * WHY: Checkr Tenant orders require a rental property; a landlord-less
 * (speculative) background check has none. This system-owned landlord + shell
 * property anchors those checks so they can run and then auto-migrate into
 * application_pool. The account also doubles as an internal dogfooding login for
 * viewing the landlord experience on real surfaces.
 *
 * Identified at runtime by the stable email below (see services/poolIntake.ts →
 * getPoolIntakeLandlord). Flagged landlords.is_system = true so it stays out of
 * aggregate landlord/revenue reporting.
 *
 * Idempotent — safe to re-run. background_provider starts 'mock' (no keys, no
 * charges); flip to 'checkr' once live keys are wired.
 *
 * Run: node -r ts-node/register apps/api/src/scripts/createPoolIntakeShell.ts
 */
import { getClient } from '../db'
import bcrypt from 'bcryptjs'

export const POOL_INTAKE_EMAIL = 'pool-intake@gam.internal'
const SHELL_PASSWORD = process.env.POOL_SHELL_PASSWORD || 'poolshell1234'
const SHELL_BUSINESS = 'GAM Renter Pool'

async function main() {
  const c = await getClient()
  try {
    await c.query('BEGIN')

    const hash = await bcrypt.hash(SHELL_PASSWORD, 12)
    const user = (await c.query(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified, email_verified_at)
       VALUES ($1, $2, 'landlord', 'GAM', 'Renter Pool', true, NOW())
       ON CONFLICT (email) DO UPDATE SET role = 'landlord'
       RETURNING id`,
      [POOL_INTAKE_EMAIL, hash]
    )).rows[0]

    let landlord = (await c.query('SELECT id FROM landlords WHERE user_id = $1', [user.id])).rows[0]
    if (!landlord) {
      landlord = (await c.query(
        `INSERT INTO landlords (user_id, business_name, is_system, onboarding_complete, background_provider)
         VALUES ($1, $2, true, true, 'mock') RETURNING id`,
        [user.id, SHELL_BUSINESS]
      )).rows[0]
    } else {
      await c.query('UPDATE landlords SET is_system = true, business_name = $2 WHERE id = $1', [landlord.id, SHELL_BUSINESS])
    }

    let prop = (await c.query('SELECT id FROM properties WHERE landlord_id = $1', [landlord.id])).rows[0]
    if (!prop) {
      prop = (await c.query(
        `INSERT INTO properties (landlord_id, name, street1, city, state, zip, type, owner_user_id, managed_by_user_id)
         VALUES ($1, 'GAM Renter Pool', '1 Renter Pool Way', 'Phoenix', 'AZ', '85001', 'mixed', $2, $2)
         RETURNING id`,
        [landlord.id, user.id]
      )).rows[0]
    }

    await c.query('COMMIT')
    console.log('✓ Pool intake shell ready:')
    console.log(`  user_id     = ${user.id}  (${POOL_INTAKE_EMAIL} / ${SHELL_PASSWORD})`)
    console.log(`  landlord_id = ${landlord.id}  (is_system=true, background_provider=mock)`)
    console.log(`  property_id = ${prop.id}`)
  } catch (e) {
    await c.query('ROLLBACK')
    throw e
  } finally {
    c.release()
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })

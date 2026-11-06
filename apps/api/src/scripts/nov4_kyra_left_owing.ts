/**
 * 11/4 — RECORD MH 18 AS HAVING LEFT OWING, THE WAY MH 28 ALREADY IS.
 *
 * Nic, 11/4: "Also move Kyra to moved out like Susie."
 *
 * Both tenancies ended 2026-10-31 and both leases are expired and terminated.
 * The only difference is that MH 28's balance was written into
 * tenant_left_owing and MH 18's was not — and that is an accident of how the
 * record gets created. The ONLY writer for a lease ending is
 * services/spotSuccession, which fires when somebody SIGNS FOR THE SPACE the
 * leaver is vacating. MH 28 had a replacement sign on 10/28, so it ran. MH 18
 * sits empty, so nothing ran and the debt was never booked, even though the
 * person walked away owing exactly the same way.
 *
 * This records it with the SAME arithmetic (whatIsStillOwedOnLease) and the
 * SAME insert the succession path uses — including its ON CONFLICT, so a later
 * re-compute still works and a second run cannot double it. Nothing bespoke.
 *
 * DONE, 11/5 — do not read the note below as outstanding work. Nic approved
 * the behavior change the same day ("that needs to be fixed right away,
 * because people are going to leave regardless of if somebody's coming in to
 * replace them or not"), and it shipped: services/leftOwingFreeze is the shared
 * writer, scheduler.processLeaseEnds books a move-out, and
 * scheduler.bookTenanciesThatLeftOwing sweeps every other way a tenancy ends.
 * This script is kept only as the record of the one repair it made.
 *
 * ORIGINAL NOTE: the real fix is that a tenancy ending should book this on its
 * own, not only when a replacement signs. That is a behavior change to the
 * move-out path and is Nic's to approve, so this script repairs the one record
 * and does not touch the path.
 *
 * Scoped to ONE lease, and it refuses anything else. Dry run unless --apply.
 *
 *   cd ~/gam/apps/api && npx ts-node -T src/scripts/nov4_kyra_left_owing.ts
 *   cd ~/gam/apps/api && npx ts-node -T src/scripts/nov4_kyra_left_owing.ts --apply
 */
import { getClient } from '../db'
import { whatIsStillOwedOnLease } from '../services/spotSuccession'

const LEASE_ID = '895264c3-1f48-47d3-884e-07647a5632db'   // MH 18, Country Acres
const UNIT_NUMBER = 'MH 18'
const PROPERTY_ID = 'e9743bfa-1972-4e40-8a1b-ad76a52a17b9'
const APPLY = process.argv.includes('--apply')

async function main() {
  const client = await getClient()
  try {
    const dbName = (await client.query<{ n: string }>('SELECT current_database() AS n')).rows[0].n
    console.log(`database: ${dbName}`)
    console.log(APPLY ? 'mode: APPLY' : 'mode: dry run (pass --apply to write)')

    await client.query('BEGIN')
    const q = { query: (sql: string, params?: unknown[]) => client.query(sql, params as any) } as any

    const lease = (await client.query<any>(
      `SELECT l.id, l.status, l.end_date::text AS end_date, l.landlord_id,
              l.terminated_at::text AS terminated_at, u.unit_number, u.property_id
         FROM leases l JOIN units u ON u.id = l.unit_id WHERE l.id = $1`, [LEASE_ID])).rows[0]
    if (!lease) throw new Error('that lease does not exist here')
    if (lease.unit_number !== UNIT_NUMBER || lease.property_id !== PROPERTY_ID) {
      throw new Error(`refusing: expected ${UNIT_NUMBER} at Country Acres, found ${lease.unit_number}`)
    }
    if (lease.status !== 'expired' || !lease.terminated_at) {
      throw new Error(`refusing: this tenancy has not ended (status ${lease.status})`)
    }

    const owed = await whatIsStillOwedOnLease(q, LEASE_ID)
    console.log(`\n${lease.unit_number}: ended ${lease.end_date}, still owed $${owed.amount.toFixed(2)} across ${owed.rows} row(s)`)
    if (owed.amount <= 0) { console.log('nothing owed — nothing to record'); await client.query('ROLLBACK'); return }

    // The succession path reads the resident while they are still ACTIVE on the
    // lease, because it runs the moment a replacement signs. This runs after the
    // tenancy already ended, so the same person now reads 'removed' — which is
    // the whole situation being recorded. Take the primary either way, and never
    // a row that was voided (that one was never really on the lease).
    const p = (await client.query<any>(
      `SELECT u.id AS user_id, u.email, u.phone, u.first_name || ' ' || u.last_name AS who
         FROM lease_tenants lt JOIN tenants t ON t.id = lt.tenant_id JOIN users u ON u.id = t.user_id
        WHERE lt.lease_id = $1 AND lt.status <> 'void'
        ORDER BY (lt.role = 'primary') DESC, (lt.status = 'active') DESC, lt.removed_at NULLS FIRST
        LIMIT 1`, [LEASE_ID])).rows[0]
    if (!p) throw new Error('no resident on that lease to record the debt against')

    const ins = await client.query<{ id: string }>(`
      INSERT INTO tenant_left_owing
        (landlord_id, property_id, user_id, email, phone, who, amount, source_kind, source_key, left_on)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'lease', $8, $9::date)
      ON CONFLICT (landlord_id, source_kind, source_key) DO UPDATE
         SET amount = EXCLUDED.amount, updated_at = NOW()
       WHERE tenant_left_owing.settled_at IS NULL
         AND COALESCE(tenant_left_owing.collected_amount, 0) = 0
         AND tenant_left_owing.amount <> EXCLUDED.amount
      RETURNING id`,
      [lease.landlord_id, PROPERTY_ID, p.user_id, p.email, p.phone, p.who,
       owed.amount, LEASE_ID, lease.end_date])
    console.log(`left-owing row: ${ins.rows[0]?.id ?? '(already recorded at this figure)'}`)

    const all = (await client.query<any>(
      `SELECT lo.who, lo.amount::text AS amount, lo.left_on::text AS left_on, lo.source_key
         FROM tenant_left_owing lo WHERE lo.property_id = $1 ORDER BY lo.left_on`, [PROPERTY_ID])).rows
    console.log('\nleft owing at this property:')
    for (const r of all) console.log(`  ${r.left_on}  $${r.amount}  (lease ${r.source_key.slice(0, 8)})`)

    await client.query(APPLY ? 'COMMIT' : 'ROLLBACK')
    console.log(APPLY ? '\nCOMMITTED' : '\nrolled back (dry run)')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e?.message ?? e); process.exit(1) })

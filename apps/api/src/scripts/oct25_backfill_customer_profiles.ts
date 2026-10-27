/**
 * 10/25 (Nic) — GIVE THE PEOPLE ALREADY ON GAM THEIR ONE GAM CUSTOMER.
 *
 *   "Each customer has one GAM customer account, so we can see everywhere that
 *    they interact with GAM... anywhere that person pops up in GAM, it is one
 *    GAM account."
 *
 * Links existing rows to a profile under the three-point rule
 * (packages/shared customerMatch — first name · last name · phone · email · a
 * saved payment method; three must agree). Nothing is invented: a row that does
 * not carry three points of its own is reported and left alone, because a
 * profile built from two points is a stranger GAM thinks it knows.
 *
 * SCOPED TO ONE NAMED COMPANY. Nic runs Mountain View and Oak Park; Country
 * Acres is TruBlu's, and a script of ours never writes rows derived from
 * another operator's customers ([[gam-other-operators-parks-are-off-limits]]).
 * 748 of the 749 register customers are Mountain View's; the one that is not is
 * TruBlu's and is excluded by this scope, not by luck.
 *
 * Run:  node -r ts-node/register apps/api/src/scripts/oct25_backfill_customer_profiles.ts [--apply]
 * Dry run reports exactly what an --apply would do, and writes nothing.
 */
import { getClient } from '../db'
import { resolveProfile } from '../services/customerProfiles'
import { hasEnoughPointsToMatch } from '@gam/shared'

// Mountain View RV Park Ranch LLC. Add Oak Park's id here when its register
// customers are entered; never a company that is not Nic's.
const COMPANIES = ['96ec7df3-362d-4777-b54c-e9604313820f']

;(async () => {
  const apply = process.argv.includes('--apply')
  const client = await getClient()
  const made = new Set<string>()
  let linked = 0, recognised = 0, tooThin = 0, ambiguous = 0
  const examples: string[] = []
  try {
    await client.query('BEGIN')

    // Residents first: a person who lives here is the fullest record of them,
    // so their profile is the one a register row should join rather than the
    // other way round.
    const residents = await client.query<any>(
      `SELECT t.id AS tenant_id, u.first_name, u.last_name, u.phone, u.email, l.id AS landlord_id
         FROM tenants t
         JOIN users u ON u.id = t.user_id
         JOIN lease_tenants lt ON lt.tenant_id = t.id
         JOIN leases le ON le.id = lt.lease_id
         JOIN units un ON un.id = le.unit_id
         JOIN properties pr ON pr.id = un.property_id
         JOIN landlords l ON l.id = pr.landlord_id
        WHERE l.id = ANY($1::uuid[])
        GROUP BY t.id, u.first_name, u.last_name, u.phone, u.email, l.id`,
      [COMPANIES])

    const registers = await client.query<any>(
      `SELECT c.id, c.first_name, c.last_name, c.phone, c.email, c.stripe_customer_id, c.landlord_id
         FROM pos_customers c
        WHERE c.landlord_id = ANY($1::uuid[]) AND c.archived_at IS NULL
        ORDER BY c.last_name, c.first_name`,
      [COMPANIES])

    const run = async (kind: 'tenant' | 'pos_customer', rows: any[], refKey: string) => {
      for (const r of rows) {
        const points = {
          firstName: r.first_name, lastName: r.last_name, phone: r.phone, email: r.email,
          paymentMethodRef: r.stripe_customer_id ?? null,
        }
        if (!hasEnoughPointsToMatch(points)) {
          tooThin++
          if (examples.length < 8) {
            examples.push(`  thin  ${kind} ${String(r.first_name || '?')} ${String(r.last_name || '')}`.trimEnd())
          }
          continue
        }
        try {
          const out = await resolveProfile(client as any, points,
            { kind, refId: r[refKey], landlordId: r.landlord_id })
          if (!out) { tooThin++; continue }
          if (out.created) made.add(out.profileId)
          else recognised++
          linked++
        } catch (e: any) {
          // Two profiles both matched on three points: a person decides, never
          // a script.
          ambiguous++
          if (examples.length < 8) {
            examples.push(`  AMBIGUOUS  ${kind} ${r.first_name} ${r.last_name} — needs a GAM admin`)
          }
        }
      }
    }

    await run('tenant', residents.rows, 'tenant_id')
    await run('pos_customer', registers.rows, 'id')

    console.log(`residents read:        ${residents.rows.length}`)
    console.log(`register customers:    ${registers.rows.length}`)
    console.log(`linked:                ${linked}`)
    console.log(`  new profiles:        ${made.size}`)
    console.log(`  joined an existing:  ${recognised}`)
    console.log(`left alone (<3 points):${tooThin}`)
    console.log(`needs a person:        ${ambiguous}`)
    if (examples.length) console.log('examples:\n' + examples.join('\n'))

    if (apply) {
      await client.query('COMMIT')
      console.log('APPLIED')
    } else {
      await client.query('ROLLBACK')
      console.log('DRY RUN — nothing written. Re-run with --apply.')
    }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    console.error(e)
    process.exitCode = 1
  } finally {
    client.release()
  }
})()

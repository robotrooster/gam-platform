/**
 * TEMPORARY probe (10/17) — delete before the session ends.
 *
 * Measures cleanupAllSchema and records the row counts of EVERY table before
 * and after it runs, so the rewrite can be compared against the old one row by
 * row. Writes /tmp/gam-cleanup-probe-<LABEL>.json.
 */
import { describe, it } from 'vitest'
import fs from 'fs'
import { db, getClient } from './db'
import {
  cleanupAllSchema, seedLandlord, seedTenant, seedProperty, seedUnit,
  seedLease, seedLeaseTenant, seedRentPayment, seedAllocationRule,
} from './test/dbHelpers'

const LABEL = process.env.PROBE_LABEL || 'x'

async function counts(): Promise<Record<string, number>> {
  const { rows } = await db.query<{ t: string }>(
    `SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY 1`)
  const parts = rows.map(r => `SELECT '${r.t}' AS t, count(*)::int AS n FROM ${r.t}`)
  const out: Record<string, number> = {}
  // chunked so the statement stays sane
  for (let i = 0; i < parts.length; i += 60) {
    const { rows: rs } = await db.query<{ t: string; n: number }>(parts.slice(i, i + 60).join(' UNION ALL '))
    for (const r of rs) if (r.n > 0) out[r.t] = Number(r.n)
  }
  return out
}

async function populate(): Promise<void> {
  const c = await getClient()
  try {
    const { userId, landlordId } = await seedLandlord(c)
    const tenantId = await seedTenant(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    await seedAllocationRule(c, { propertyId })
    const unitId = await seedUnit(c, { propertyId, landlordId })
    const leaseId = await seedLease(c, { unitId, landlordId, rentAmount: 950, startDate: '2026-08-01' })
    await seedLeaseTenant(c, { leaseId, tenantId })
    const payId = await seedRentPayment(c, { unitId, tenantId, landlordId, amount: 950 })
    // a few rows in tables the cleanup reaches only by cascade, plus the three
    // that survive it today
    await c.query(`UPDATE payments SET status = 'settled' WHERE id = $1`, [payId])
    await c.query(`INSERT INTO platform_fee_config (rate_per_unit, min_per_connect_account, notes)
                   SELECT 2.00, 10.00, 'probe'
                    WHERE NOT EXISTS (SELECT 1 FROM platform_fee_config WHERE effective_until IS NULL)`)
    await c.query(`INSERT INTO rvs (current_owner_tenant_id, unit_id, make, model, year, length_ft)
                   VALUES ($1, $2, 'Probe', 'P', 2020, 30)`, [tenantId, unitId])
    await c.query(
      `INSERT INTO agent_interaction_logs
         (conversation_id, agent_type, audience, profile_id, agent_name, handled_by_tier,
          outcome, landlord_id, actor_role, actor_subject_id, user_message, agent_reply)
       VALUES (gen_random_uuid(), 'customer_service', 'landlord', 'cs_landlord_entry', 'David', 'entry',
               'answered_entry', $1, 'landlord', $2, 'probe', 'probe')`, [landlordId, userId])
    await c.query(`INSERT INTO pos_categories (landlord_id, name) VALUES ($1, 'Probe')`, [landlordId])
    await c.query(`INSERT INTO notifications (user_id, type, title, body)
                   VALUES ($1, 'system', 'probe', 'probe')`, [userId])
    await c.query(`INSERT INTO unit_photos (landlord_id, unit_id, url) VALUES ($1, $2, '/probe.jpg')`,
      [landlordId, unitId])
    // kept tables: these must still be here after the cleanup
    await c.query(`INSERT INTO platform_processing_rates
                     (payment_method, customer_facing_flat, customer_facing_percent, stripe_cost_flat, stripe_cost_percent, notes)
                   SELECT 'ach', 6, 0, 0, 0.5, 'probe'
                    WHERE NOT EXISTS (SELECT 1 FROM platform_processing_rates WHERE payment_method='ach' AND effective_until IS NULL)`)
    await c.query(`INSERT INTO allocation_splits (payment_id, landlord_id, property_id, gross_held, landlord_fee_withheld, supersedence, owner_share)
                   VALUES ($1, $2, $3, 950, 0, 0, 950)`, [payId, landlordId, propertyId])
    await c.query(`INSERT INTO nexus_revenue_tally (state_code, period_year, revenue_usd, txn_count)
                   VALUES ('XP', 2026, 10, 1) ON CONFLICT DO NOTHING`)
  } finally { c.release() }
}

describe('cleanup probe', () => {
  it('records state + timing', async () => {
    await cleanupAllSchema()
    await populate()
    const before = await counts()
    const t0 = Date.now()
    await cleanupAllSchema()
    const populatedMs = Date.now() - t0
    const after = await counts()

    // empty-database timing: the common case (a file's beforeEach right after
    // the previous test's cleanup left almost nothing behind)
    const empties: number[] = []
    for (let i = 0; i < 10; i++) {
      const s = Date.now()
      await cleanupAllSchema()
      empties.push(Date.now() - s)
    }
    // and a populated one, repeatedly
    const pops: number[] = []
    for (let i = 0; i < 5; i++) {
      await populate()
      const s = Date.now()
      await cleanupAllSchema()
      pops.push(Date.now() - s)
    }
    fs.writeFileSync(`/tmp/gam-cleanup-probe-${LABEL}.json`, JSON.stringify({
      before, after, populatedMs, empties, pops,
    }, null, 1))
  }, 120_000)
})

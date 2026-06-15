/**
 * S479 — state-law refresh-check cron coverage.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../db'
import { cleanupAllSchema } from '../test/dbHelpers'
import { processStateLawRefreshCheck } from './stateLawRefreshCheck'

beforeEach(async () => {
  await cleanupAllSchema()
  // State-law tables aren't wiped by cleanupAllSchema (reference data
  // posture). Clear them explicitly so each test runs in a clean KB.
  await db.query(`DELETE FROM state_law_provisions`)
  await db.query(`DELETE FROM state_landlord_tenant_acts`)
})

async function seedProvision(args: {
  state: string
  topic: string
  sourceDate: string  // YYYY-MM-DD
  effectiveYear?: number
}): Promise<void> {
  const { rows: [a] } = await db.query<{ id: string }>(
    `INSERT INTO state_landlord_tenant_acts
       (state_code, act_key, act_name, unit_types, source_date, effective_year)
     VALUES ($1, 'residential', $1 || ' Residential Act',
             ARRAY['apartment']::text[], $2, $3)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [args.state, args.sourceDate, args.effectiveYear ?? 2026])
  const actId = a?.id ?? (await db.query<{ id: string }>(
    `SELECT id FROM state_landlord_tenant_acts WHERE state_code=$1 AND act_key='residential' AND effective_year=$2 LIMIT 1`,
    [args.state, args.effectiveYear ?? 2026])).rows[0].id
  await db.query(
    `INSERT INTO state_law_provisions
       (act_id, state_code, topic, rule_kind, threshold_numeric, threshold_unit,
        summary, source_date, effective_year)
     VALUES ($1, $2, $3, 'max', 1, 'unit', 'test', $4, $5)`,
    [actId, args.state, args.topic, args.sourceDate, args.effectiveYear ?? 2026])
}

function daysAgo(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 10)
}

describe('processStateLawRefreshCheck', () => {
  it('empty catalog → 0/0/no notification', async () => {
    const r = await processStateLawRefreshCheck()
    expect(r.stale_provision_count).toBe(0)
    expect(r.stale_state_count).toBe(0)
    expect(r.notification_created).toBe(false)

    const { rows } = await db.query(
      `SELECT id FROM admin_notifications WHERE category='state_law_refresh_needed'`)
    expect(rows.length).toBe(0)
  })

  it('all rows fresh → 0/0/no notification', async () => {
    await seedProvision({ state: 'AZ', topic: 'entry_notice_hours', sourceDate: daysAgo(10) })
    await seedProvision({ state: 'CA', topic: 'deposit_max_months',  sourceDate: daysAgo(30) })
    const r = await processStateLawRefreshCheck()
    expect(r.stale_provision_count).toBe(0)
    expect(r.notification_created).toBe(false)
  })

  it('stale rows → notification with severity warn + state breakdown in context', async () => {
    await seedProvision({ state: 'AZ', topic: 'entry_notice_hours', sourceDate: daysAgo(120) })
    await seedProvision({ state: 'AZ', topic: 'deposit_max_months', sourceDate: daysAgo(100) })
    await seedProvision({ state: 'NV', topic: 'entry_notice_hours', sourceDate: daysAgo(200) })
    const r = await processStateLawRefreshCheck()
    expect(r.stale_provision_count).toBe(3)
    expect(r.stale_state_count).toBe(2)
    expect(r.notification_created).toBe(true)

    const n = await db.query<any>(
      `SELECT severity, title, context FROM admin_notifications WHERE category='state_law_refresh_needed'`)
    expect(n.rows.length).toBe(1)
    expect(n.rows[0].severity).toBe('warn')
    expect(n.rows[0].title).toMatch(/3 provision\(s\) across 2 state\(s\)/)
    // States list captured in context.
    const states = n.rows[0].context.states
    expect(Array.isArray(states)).toBe(true)
    expect(states.length).toBe(2)
    // Ordered oldest first — NV (200 days) before AZ (100 days oldest topic).
    expect(states[0].state_code).toBe('NV')
    expect(states[1].state_code).toBe('AZ')
  })

  it('idempotent: second run with existing unacknowledged notification → suppress', async () => {
    await seedProvision({ state: 'AZ', topic: 'entry_notice_hours', sourceDate: daysAgo(120) })
    await processStateLawRefreshCheck()
    const r = await processStateLawRefreshCheck()
    expect(r.stale_provision_count).toBe(1)
    expect(r.notification_created).toBe(false)
    expect(r.suppressed_due_to_existing_unack).toBe(true)

    const { rows } = await db.query(
      `SELECT id FROM admin_notifications WHERE category='state_law_refresh_needed'`)
    expect(rows.length).toBe(1)  // only the first run's row
  })

  it('after acknowledging the prior notification, next run fires a new one', async () => {
    await seedProvision({ state: 'AZ', topic: 'entry_notice_hours', sourceDate: daysAgo(120) })
    await processStateLawRefreshCheck()
    await db.query(
      `UPDATE admin_notifications
          SET acknowledged_at = NOW()
        WHERE category = 'state_law_refresh_needed'`)
    const r = await processStateLawRefreshCheck()
    expect(r.notification_created).toBe(true)
    const { rows } = await db.query(
      `SELECT id FROM admin_notifications WHERE category='state_law_refresh_needed'`)
    expect(rows.length).toBe(2)
  })

  it('latest-per-(state,topic): a fresh re-read on a topic with an old historical row passes', async () => {
    // Old row first (year 2025), then a fresh row (year 2026).
    await seedProvision({
      state: 'AZ', topic: 'entry_notice_hours',
      sourceDate: daysAgo(400), effectiveYear: 2025,
    })
    await seedProvision({
      state: 'AZ', topic: 'entry_notice_hours',
      sourceDate: daysAgo(5), effectiveYear: 2026,
    })
    const r = await processStateLawRefreshCheck()
    // The LATEST per (state, topic) is the 2026 row (5 days ago).
    expect(r.stale_provision_count).toBe(0)
    expect(r.notification_created).toBe(false)
  })

  it('configurable threshold: 365-day window only flags very old rows', async () => {
    await seedProvision({ state: 'AZ', topic: 'entry_notice_hours', sourceDate: daysAgo(100) })
    const r = await processStateLawRefreshCheck(365)
    expect(r.stale_provision_count).toBe(0)
  })
})

/**
 * FlexDeposit eligibility checks — custody model (S514) + S330 blockers.
 *
 * Read-only path through getFlexDepositEligibility — tests use
 * withRollback for isolation. The function reads tenants /
 * security_deposits / background_checks / credit_events.
 *
 * The eligibility rule set:
 *   - not_ssi_ssdi (S514)               : tenants.ssi_ssdi = FALSE
 *   - ach_unverified                    : tenants.ach_verified = FALSE
 *   - no_bg_result / bg_not_approved    : background_check_status != 'approved'
 *   - risk_level_missing                : BG row missing risk_level
 *   - no_deposit_row / already_funded   : security_deposits state
 *   - insufficient_platform_tenure (S330): tenants.created_at < 30d ago
 *   - insufficient_on_time_payment_history (S330):
 *       has prior lease AND < 1 payment_received_on_time event in 90d
 *       (first-lease-ever tenants are exempt)
 *
 * S514 removed the advance/default model: there is no NSF cooldown
 * (tenant_suspended_nsf) and no permanent prior-default block
 * (prior_flexdeposit_default) — a missed installment is not a default.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../db'
import { getFlexDepositEligibility } from './flexDeposit'
import {
  withRollback, cleanupAllSchema,
  seedLandlord, seedTenant, seedProperty, seedUnit, seedLease, seedLeaseTenant,
} from '../test/dbHelpers'
import type { PoolClient } from 'pg'

// Most eligibility tests just need a tenant + an unfunded deposit row.
// Helper assembles the minimum stack inside the caller's transaction.
async function buildEligibilityStack(
  client: PoolClient,
  opts: {
    ssiSsdi?:                            boolean
    achVerified?:                        boolean
    bgStatus?:                           string | null
    riskLevel?:                          'low' | 'medium' | 'high' | 'very_high' | null
    tenantCreatedAt?:                    string  // ISO; defaults to NOW()
    skipDeposit?:                        boolean
    depositStatus?:                      'pending' | 'partial' | 'funded'
    seedPriorLease?:                     boolean
    seedPriorPlan?:                      boolean
  } = {},
): Promise<{ tenantId: string; landlordId: string }> {
  const { userId: ownerUserId, landlordId } = await seedLandlord(client)
  const tenantId = await seedTenant(client)
  // Fetch the tenant's user_id — background_checks.user_id is NOT NULL.
  const tu = await client.query<{ user_id: string }>(
    `SELECT user_id FROM tenants WHERE id = $1`,
    [tenantId],
  )
  const tenantUserId = tu.rows[0].user_id

  // tenants.background_check_id + .background_check_status are
  // separate columns. The eligibility query reads both.
  let bgId: string | null = null
  if (opts.bgStatus) {
    const bg = await client.query<{ id: string }>(
      `INSERT INTO background_checks
         (landlord_id, user_id, tenant_id, status, risk_level)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [landlordId, tenantUserId, tenantId, opts.bgStatus, opts.riskLevel ?? null],
    )
    bgId = bg.rows[0].id
  }

  // tenants.background_check_status has a NOT NULL constraint with
  // default 'not_started'. We update it only when a status is given;
  // when null is passed, we leave the default in place. ssi_ssdi
  // defaults TRUE (FlexDeposit is SSDI/SSI-only — S514).
  await client.query(
    `UPDATE tenants
        SET ssi_ssdi                    = $2,
            ach_verified                = $3,
            background_check_status     = COALESCE($4::text, background_check_status),
            background_check_id         = $5,
            created_at                  = COALESCE($6::timestamptz, created_at)
      WHERE id = $1`,
    [
      tenantId,
      opts.ssiSsdi ?? true,
      opts.achVerified ?? true,
      opts.bgStatus ?? null,
      bgId,
      opts.tenantCreatedAt ?? null,
    ],
  )

  const propertyId = await seedProperty(client, {
    landlordId, ownerUserId, managedByUserId: ownerUserId,
  })
  const unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: 1000 })

  // The current (upcoming) lease for the FlexDeposit enrollment.
  const upcomingLeaseId = await seedLease(client, {
    unitId, landlordId, rentAmount: 1000, status: 'pending',
  })
  await seedLeaseTenant(client, { leaseId: upcomingLeaseId, tenantId, role: 'primary' })

  if (!opts.skipDeposit) {
    await client.query(
      `INSERT INTO security_deposits
         (unit_id, lease_id, tenant_id, total_amount, status, held_by)
       VALUES ($1, $2, $3, 500, $4, 'gam_escrow')`,
      [unitId, upcomingLeaseId, tenantId, opts.depositStatus ?? 'pending'],
    )
  }

  if (opts.seedPriorLease) {
    // A prior lease in 'expired' status. Triggers the on-time-payment
    // check (first-lease exemption no longer applies).
    const priorUnitId = await seedUnit(client, { propertyId, landlordId, rentAmount: 900 })
    const priorLeaseId = await seedLease(client, {
      unitId: priorUnitId, landlordId, rentAmount: 900, status: 'expired',
    })
    await seedLeaseTenant(client, { leaseId: priorLeaseId, tenantId, role: 'primary' })
  }

  if (opts.seedPriorPlan) {
    // A prior FlexDeposit plan on an expired lease. Under the custody
    // model this never blocks a future enrollment (no permanent default).
    const otherUnitId = await seedUnit(client, { propertyId, landlordId, rentAmount: 900 })
    const otherLeaseId = await seedLease(client, {
      unitId: otherUnitId, landlordId, rentAmount: 900, status: 'expired',
    })
    await client.query(
      `INSERT INTO security_deposits
         (unit_id, lease_id, tenant_id, total_amount, status, held_by,
          flex_deposit_enabled, flex_deposit_plan_status)
       VALUES ($1, $2, $3, 400, 'funded', 'gam_escrow', TRUE, 'completed')`,
      [otherUnitId, otherLeaseId, tenantId],
    )
  }

  return { tenantId, landlordId }
}

// Emit a payment_received_on_time credit event for a tenant on a
// given date. Eligibility check counts these in the trailing 90d.
// credit_events.this_hash is bytea NOT NULL; use a synthetic value
// since the test doesn't care about the hash chain integrity.
async function emitOnTimePayment(
  client: PoolClient,
  tenantId: string,
  occurredAt: Date = new Date(),
): Promise<void> {
  const subj = await client.query<{ id: string }>(
    `INSERT INTO credit_subjects (subject_type, subject_ref_id)
     VALUES ('tenant', $1)
     ON CONFLICT (subject_type, subject_ref_id) DO UPDATE SET updated_at = NOW()
     RETURNING id`,
    [tenantId],
  )
  const subjectId = subj.rows[0].id
  await client.query(
    `INSERT INTO credit_events
       (subject_id, event_type, event_data, occurred_at,
        attestation_source, dimension_tags, network_visibility,
        this_hash)
     VALUES ($1, 'payment_received_on_time', '{}'::jsonb, $2,
             'gam_workflow_auto', '{}'::text[], 'visible_to_gam_network',
             decode('00', 'hex'))`,
    [subjectId, occurredAt.toISOString()],
  )
}

beforeEach(cleanupAllSchema)

// withRollback is unused here — eligibility reads through the singleton
// pool, so seeds must commit before getFlexDepositEligibility runs.
// Keeping the import for any future read-via-shared-client cases.
void withRollback

describe('getFlexDepositEligibility — pre-existing blockers', () => {
  it('returns tenant_not_found for a non-existent tenant', async () => {
    const r = await getFlexDepositEligibility('00000000-0000-0000-0000-000000000000')
    expect(r.eligible).toBe(false)
    expect(r.blockers).toContain('tenant_not_found')
  })


  it('blocks ach_unverified when tenants.ach_verified=FALSE', async () => {
    const client = await db.connect()
    let tenantId: string
    try {
      await client.query('BEGIN')
      const stack = await buildEligibilityStack(client, {
        achVerified: false, bgStatus: 'approved', riskLevel: 'low',
        tenantCreatedAt: '2020-01-01T00:00:00Z',
      })
      tenantId = stack.tenantId
      await client.query('COMMIT')
    } finally { client.release() }
    const r = await getFlexDepositEligibility(tenantId)
    expect(r.eligible).toBe(false)
    expect(r.blockers).toContain('ach_unverified')
  })

  it('blocks bg_not_approved when default not_started status (no BG check yet)', async () => {
    // tenants.background_check_status has a NOT NULL default of
    // 'not_started'. The eligibility code emits 'bg_not_approved'
    // for any non-'approved' value — 'not_started' falls into that
    // bucket. The 'no_bg_result' branch is reachable only when the
    // column is empty string, which the CHECK constraint forbids
    // — historical code path that no longer fires.
    const client = await db.connect()
    let tenantId: string
    try {
      await client.query('BEGIN')
      const stack = await buildEligibilityStack(client, {
        achVerified: true, bgStatus: null,
        tenantCreatedAt: '2020-01-01T00:00:00Z',
      })
      tenantId = stack.tenantId
      await client.query('COMMIT')
    } finally { client.release() }
    const r = await getFlexDepositEligibility(tenantId)
    expect(r.blockers).toContain('bg_not_approved')
  })

  it('blocks bg_not_approved when background_check_status=submitted (in-progress)', async () => {
    const client = await db.connect()
    let tenantId: string
    try {
      await client.query('BEGIN')
      const stack = await buildEligibilityStack(client, {
        achVerified: true, bgStatus: 'submitted',
        tenantCreatedAt: '2020-01-01T00:00:00Z',
      })
      tenantId = stack.tenantId
      await client.query('COMMIT')
    } finally { client.release() }
    const r = await getFlexDepositEligibility(tenantId)
    expect(r.blockers).toContain('bg_not_approved')
  })

  it('blocks risk_level_missing when bg approved but no risk_level set', async () => {
    const client = await db.connect()
    let tenantId: string
    try {
      await client.query('BEGIN')
      const stack = await buildEligibilityStack(client, {
        achVerified: true, bgStatus: 'approved', riskLevel: null,
        tenantCreatedAt: '2020-01-01T00:00:00Z',
      })
      tenantId = stack.tenantId
      await client.query('COMMIT')
    } finally { client.release() }
    const r = await getFlexDepositEligibility(tenantId)
    expect(r.blockers).toContain('risk_level_missing')
  })

  it('blocks not_ssi_ssdi when tenant is not an SSDI/SSI recipient (S514)', async () => {
    const client = await db.connect()
    let tenantId: string
    try {
      await client.query('BEGIN')
      const stack = await buildEligibilityStack(client, {
        ssiSsdi: false,
        achVerified: true, bgStatus: 'approved', riskLevel: 'low',
        tenantCreatedAt: '2020-01-01T00:00:00Z',
      })
      tenantId = stack.tenantId
      await client.query('COMMIT')
    } finally { client.release() }
    const r = await getFlexDepositEligibility(tenantId)
    expect(r.eligible).toBe(false)
    expect(r.blockers).toContain('not_ssi_ssdi')
  })

  it('blocks no_deposit_row when no security_deposits row for tenant', async () => {
    const client = await db.connect()
    let tenantId: string
    try {
      await client.query('BEGIN')
      const stack = await buildEligibilityStack(client, {
        achVerified: true, bgStatus: 'approved', riskLevel: 'low',
        skipDeposit: true,
        tenantCreatedAt: '2020-01-01T00:00:00Z',
      })
      tenantId = stack.tenantId
      await client.query('COMMIT')
    } finally { client.release() }
    const r = await getFlexDepositEligibility(tenantId)
    expect(r.blockers).toContain('no_deposit_row')
  })
})

describe('getFlexDepositEligibility — S330 platform tenure', () => {
  it('blocks insufficient_platform_tenure when tenant created < 30 days ago', async () => {
    const recent = new Date(Date.now() - 5 * 86400_000).toISOString()
    const client = await db.connect()
    let tenantId: string
    try {
      await client.query('BEGIN')
      const stack = await buildEligibilityStack(client, {
        achVerified: true, bgStatus: 'approved', riskLevel: 'low',
        tenantCreatedAt: recent,
      })
      tenantId = stack.tenantId
      await client.query('COMMIT')
    } finally { client.release() }
    const r = await getFlexDepositEligibility(tenantId)
    expect(r.blockers).toContain('insufficient_platform_tenure')
  })

  it('does not block on tenure when tenant created > 30 days ago', async () => {
    const old = new Date(Date.now() - 60 * 86400_000).toISOString()
    const client = await db.connect()
    let tenantId: string
    try {
      await client.query('BEGIN')
      const stack = await buildEligibilityStack(client, {
        achVerified: true, bgStatus: 'approved', riskLevel: 'low',
        tenantCreatedAt: old,
      })
      tenantId = stack.tenantId
      await client.query('COMMIT')
    } finally { client.release() }
    const r = await getFlexDepositEligibility(tenantId)
    expect(r.blockers).not.toContain('insufficient_platform_tenure')
  })
})

describe('getFlexDepositEligibility — S514 prior plan does not block', () => {
  it('does NOT block when a prior FlexDeposit plan exists (no permanent default)', async () => {
    const client = await db.connect()
    let tenantId: string
    try {
      await client.query('BEGIN')
      const stack = await buildEligibilityStack(client, {
        achVerified: true, bgStatus: 'approved', riskLevel: 'low',
        tenantCreatedAt: '2020-01-01T00:00:00Z',
        seedPriorPlan: true,
      })
      tenantId = stack.tenantId
      await client.query('COMMIT')
    } finally { client.release() }
    const r = await getFlexDepositEligibility(tenantId)
    expect(r.blockers).not.toContain('not_ssi_ssdi')
    // The prior plan never adds a blocker — eligibility is unaffected.
    expect(r.eligible).toBe(true)
  })
})

describe('getFlexDepositEligibility — S330 on-time payment history', () => {
  it('exempts first-lease-ever tenant (no prior leases) from the history check', async () => {
    const client = await db.connect()
    let tenantId: string
    try {
      await client.query('BEGIN')
      const stack = await buildEligibilityStack(client, {
        achVerified: true, bgStatus: 'approved', riskLevel: 'low',
        tenantCreatedAt: '2020-01-01T00:00:00Z',
        // No seedPriorLease — only the upcoming pending lease exists.
      })
      tenantId = stack.tenantId
      await client.query('COMMIT')
    } finally { client.release() }
    const r = await getFlexDepositEligibility(tenantId)
    expect(r.blockers).not.toContain('insufficient_on_time_payment_history')
    expect(r.eligible).toBe(true)
  })

  it('blocks when prior lease exists but zero on-time payments in 90d window', async () => {
    const client = await db.connect()
    let tenantId: string
    try {
      await client.query('BEGIN')
      const stack = await buildEligibilityStack(client, {
        achVerified: true, bgStatus: 'approved', riskLevel: 'low',
        tenantCreatedAt: '2020-01-01T00:00:00Z',
        seedPriorLease: true,
      })
      tenantId = stack.tenantId
      await client.query('COMMIT')
    } finally { client.release() }
    const r = await getFlexDepositEligibility(tenantId)
    expect(r.blockers).toContain('insufficient_on_time_payment_history')
  })

  it('passes when prior lease exists AND at least one on-time payment in 90d window', async () => {
    const client = await db.connect()
    let tenantId: string
    try {
      await client.query('BEGIN')
      const stack = await buildEligibilityStack(client, {
        achVerified: true, bgStatus: 'approved', riskLevel: 'low',
        tenantCreatedAt: '2020-01-01T00:00:00Z',
        seedPriorLease: true,
      })
      tenantId = stack.tenantId
      await emitOnTimePayment(client, tenantId, new Date(Date.now() - 14 * 86400_000))
      await client.query('COMMIT')
    } finally { client.release() }
    const r = await getFlexDepositEligibility(tenantId)
    expect(r.blockers).not.toContain('insufficient_on_time_payment_history')
    expect(r.eligible).toBe(true)
  })

  it('still blocks when the on-time payment is OUTSIDE the 90d window', async () => {
    const client = await db.connect()
    let tenantId: string
    try {
      await client.query('BEGIN')
      const stack = await buildEligibilityStack(client, {
        achVerified: true, bgStatus: 'approved', riskLevel: 'low',
        tenantCreatedAt: '2020-01-01T00:00:00Z',
        seedPriorLease: true,
      })
      tenantId = stack.tenantId
      // 120 days ago — outside the 90d lookback
      await emitOnTimePayment(client, tenantId, new Date(Date.now() - 120 * 86400_000))
      await client.query('COMMIT')
    } finally { client.release() }
    const r = await getFlexDepositEligibility(tenantId)
    expect(r.blockers).toContain('insufficient_on_time_payment_history')
  })
})

describe('getFlexDepositEligibility — happy path', () => {
  it('returns eligible=true + max_installments set when all checks pass', async () => {
    const client = await db.connect()
    let tenantId: string
    try {
      await client.query('BEGIN')
      const stack = await buildEligibilityStack(client, {
        achVerified: true, bgStatus: 'approved', riskLevel: 'low',
        tenantCreatedAt: '2020-01-01T00:00:00Z',
        // first-lease-ever (no prior lease seeded) → exempt from history check
      })
      tenantId = stack.tenantId
      await client.query('COMMIT')
    } finally { client.release() }
    const r = await getFlexDepositEligibility(tenantId)
    expect(r.eligible).toBe(true)
    expect(r.blockers).toEqual([])
    expect(r.max_installments).toBeGreaterThan(0)
    expect(r.risk_level).toBe('low')
    expect(r.deposit_amount).toBe(500)
  })
})

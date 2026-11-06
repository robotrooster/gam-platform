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
 *   - landlord_not_established (10/27):
 *       has prior lease AND tenants.created_at < 30d ago
 *       (first-lease-ever tenants are exempt — 10/26: move-in is
 *        FlexDeposit's only entry point, so a first-lease tenant has no
 *        tenure to show and the gate would block every real applicant)
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
import {
  getFlexDepositEligibility, FLEX_DEPOSIT_MIN_LANDLORD_DAYS, FLEX_DEPOSIT_SIGNING_WINDOW_DAYS,
  flexDepositOffer, flexDepositSignPrompt,
} from './flexDeposit'
import {
  withRollback, cleanupAllSchema, seedDepositCustodyRule,
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
    /** The deposit's size. Defaults to 500 — inside the grid's lowest bracket. */
    depositAmount?:                      number
    /** 10/27: when the lease was signed, and when the bank link was begun. */
    signedDaysAgo?:                      number
    bankStartedDaysAgo?:                 number | null
    seedPriorLease?:                     boolean
    seedPriorPlan?:                      boolean
    /** 10/27: the landlord's own standing — vetted, established, collecting. */
    landlordCreatedAt?:                  string   // ISO; defaults to 60 days ago
    landlordPayoutsEnabled?:             boolean  // defaults true
    landlordMoneyMoving?:                boolean  // defaults true
  } = {},
): Promise<{ tenantId: string; landlordId: string }> {
  const { userId: ownerUserId, landlordId } = await seedLandlord(client)
  // ── 10/27 (Nic): THE 30 DAYS ARE THE LANDLORD'S ──────────────────────────
  // "landlord has to be vetted and moving money through the system. not the
  // new tenant." Every test here is about the RESIDENT, so the landlord is
  // seeded the way a real one looks by default — on GAM for two months,
  // vetted by Stripe for payouts, money settling — and the three landlord
  // cases are exercised on their own below.
  await client.query(
    `UPDATE landlords
        SET created_at = COALESCE($2::timestamptz, NOW() - INTERVAL '60 days'),
            connect_payouts_enabled = $3
      WHERE id = $1`,
    [landlordId, opts.landlordCreatedAt ?? null, opts.landlordPayoutsEnabled ?? true],
  )
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
       VALUES ($1, $2, $3, $5, $4, 'gam_escrow')`,
      [unitId, upcomingLeaseId, tenantId, opts.depositStatus ?? 'pending',
       (opts.depositAmount ?? 500).toFixed(2)],
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

  // 10/27: the signing day and the day the bank link began, which together
  // decide whether FlexDeposit is still on offer.
  if (opts.signedDaysAgo !== undefined) {
    await client.query(
      `UPDATE leases SET signed_at = NOW() - ($2::int || ' days')::interval WHERE id = $1`,
      [upcomingLeaseId, opts.signedDaysAgo])
  }
  if (opts.bankStartedDaysAgo !== undefined) {
    await client.query(
      `UPDATE tenants SET bank_pending_since = CASE WHEN $2::int IS NULL THEN NULL
                            ELSE NOW() - ($2::int || ' days')::interval END
        WHERE id = $1`,
      [tenantId, opts.bankStartedDaysAgo])
  }

  // Money actually settling through GAM for this company, inside the window.
  if (opts.landlordMoneyMoving !== false) {
    await client.query(
      `INSERT INTO payments
         (landlord_id, tenant_id, unit_id, lease_id, type, amount, status,
          entry_description, due_date, settled_at)
       VALUES ($1, $2, $3, $4, 'rent', 1000, 'settled', 'RENT',
               CURRENT_DATE - 10, NOW() - INTERVAL '10 days')`,
      [landlordId, tenantId, unitId, upcomingLeaseId],
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

beforeEach(async () => {
  await cleanupAllSchema()
  // 10/29: FlexDeposit is a custody product and now refuses a state whose
  // rules do not permit GAM's vehicle. cleanupAllSchema truncates the rules
  // table and the gate fails closed, so every suite has to say where it is.
  await seedDepositCustodyRule(db)
})

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


  // 10/28 (Nic): an unverified bank no longer refuses enrolment — only a bank
  // nobody has STARTED does. Verification is microdeposits and takes days, and
  // "they should be able to be like, hey, I'm interested in signing up."
  it('blocks somebody who has not started a bank link at all', async () => {
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
    expect(r.blockers).toContain('no_bank_started')
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

  /**
   * 10/29 (Nic): "FlexPay is for fixed income people. FlexDeposit is for
   * anybody. Two different requirements for two different products."
   *
   * This test asserted the opposite until today — FlexDeposit refused anyone
   * who was not an SSDI/SSI recipient, which is FlexPay's rule and only
   * FlexPay's. FlexPay fronts the landlord's rent and is gated on verified
   * fixed income; FlexDeposit floats nothing, so there is no exposure for an
   * income test to tier. Kept as an explicit assertion, not deleted, so the
   * gate cannot quietly come back.
   */
  it('is open to a tenant who is NOT an SSDI/SSI recipient', async () => {
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
    expect(r.blockers).not.toContain('not_ssi_ssdi')
    expect(r.eligible).toBe(true)
  })

  /**
   * 10/29 (Nic): "no we are not blocking by state. let her use flex deposit"
   *
   * A state gate was added here earlier the same day and taken straight back
   * out on his instruction. FlexDeposit does not consult the S604 custody
   * rules: a resident in a state recorded `blocked` enrolls like anyone else,
   * and enrollment still takes GAM custody. Asserted rather than deleted so a
   * later session cannot quietly put the gate back and call it a fix.
   */
  it('does NOT refuse a state whose custody rules are blocked', async () => {
    const client = await db.connect()
    let tenantId: string
    try {
      await client.query('BEGIN')
      const stack = await buildEligibilityStack(client, {
        achVerified: true, bgStatus: 'approved', riskLevel: 'low',
        tenantCreatedAt: '2020-01-01T00:00:00Z',
      })
      // Illinois, recorded blocked — MH 28 at Country Acres - Mattoon.
      await client.query(
        `INSERT INTO state_deposit_custody_rules
           (state_code, custody_status, allows_treasury_bills, statute_citation)
         VALUES ('IL', 'blocked', FALSE, '765 ILCS 745/18')
         ON CONFLICT (state_code) DO UPDATE
            SET custody_status = 'blocked', allows_treasury_bills = FALSE`)
      await client.query(
        `UPDATE properties SET state = 'IL'
          WHERE id = (SELECT un.property_id FROM security_deposits sd
                        JOIN units un ON un.id = sd.unit_id
                       WHERE sd.tenant_id = $1 LIMIT 1)`, [stack.tenantId])
      tenantId = stack.tenantId
      await client.query('COMMIT')
    } finally { client.release() }
    const r = await getFlexDepositEligibility(tenantId)
    expect(r.blockers).toEqual([])
    expect(r.eligible).toBe(true)
  })

  /**
   * 10/29 (Nic): "it needs to be there until the deposit is handled one way or
   * another." The offer is what every surface reads — the portal prompt, the
   * signing prompt and the one-time email — so it is asserted on the FACTS
   * that end it, never on anything a resident clicked.
   */
  describe('the standing deposit offer', () => {
    // The offer checks visibility, so these switch the product on the way
    // production has it.
    beforeEach(async () => {
      await db.query(
        `INSERT INTO system_features (key, enabled, description)
         VALUES ('flexdeposit_rollout_visible', TRUE, '10/29 offer test')
         ON CONFLICT (key) DO UPDATE SET enabled = TRUE`)
    })

    const offerFor = async (opts: Parameters<typeof buildEligibilityStack>[1] = {}) => {
      const client = await db.connect()
      let tenantId: string
      try {
        await client.query('BEGIN')
        const stack = await buildEligibilityStack(client, {
          achVerified: true, bgStatus: 'approved', riskLevel: 'low',
          tenantCreatedAt: '2020-01-01T00:00:00Z', ...opts,
        })
        tenantId = stack.tenantId
        await client.query('COMMIT')
      } finally { client.release() }
      return { tenantId, offer: await flexDepositOffer({ tenantId }) }
    }

    it('stands while the deposit is unpaid, with the figures the screens show', async () => {
      const { offer } = await offerFor({ depositAmount: 500 })
      expect(offer).not.toBeNull()
      expect(offer!.depositAmount).toBe(500)
      expect(offer!.collected).toBe(0)
      expect(offer!.choices.map(c => c.payments)).toEqual([2, 4])
      // The point of the prompt: less than the whole deposit, today.
      expect(offer!.lowestFirstPull).toBeLessThan(500)
      expect(offer!.lowestFirstPull)
        .toBe(Math.min(...offer!.choices.map(c => c.firstPull)))
    })

    it('still stands on a part-paid deposit', async () => {
      const { tenantId } = await offerFor({ depositAmount: 500 })
      await db.query(
        `UPDATE security_deposits SET collected_amount = 100, status = 'partial'
          WHERE tenant_id = $1`, [tenantId])
      const offer = await flexDepositOffer({ tenantId })
      expect(offer).not.toBeNull()
      expect(offer!.collected).toBe(100)
    })

    /**
     * 10/29 (Nic, reading the demo preview): "That's only showing the total of
     * payments what they'll pay. It's not showing what's due at move-in. It
     * needs to generate whatever their first month is."
     *
     * The plan's figures describe the DEPOSIT alone, so a resident reading
     * "$273.00 at move-in" against a $900 move-in bill was reading a number
     * they were never going to pay. The rest of that bill rides on the offer.
     */
    it('carries the rest of the move-in bill, so due-at-move-in is the real figure', async () => {
      const { tenantId, offer } = await offerFor({ depositAmount: 500 })
      // Nothing else billed yet: the deposit figures stand alone.
      expect(offer!.otherDueNow).toBe(0)

      const ctx = await db.query<{ unit_id: string; lease_id: string; landlord_id: string }>(
        `SELECT sd.unit_id, sd.lease_id, un.landlord_id FROM security_deposits sd
           JOIN units un ON un.id = sd.unit_id WHERE sd.tenant_id = $1`, [tenantId])
      const { unit_id, lease_id, landlord_id } = ctx.rows[0]
      // Their first month's rent, unpaid, on the same lease.
      await db.query(
        `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status,
                               entry_description, due_date, revenue_owner)
         VALUES ($1,$2,$3,$4,'rent',900,'pending','RENT',CURRENT_DATE,'landlord')`,
        [unit_id, lease_id, tenantId, landlord_id])

      const after = await flexDepositOffer({ tenantId })
      expect(after!.otherDueNow).toBe(900)
      // Which is what the screen adds to the first pull.
      const two = after!.choices.find(c => c.payments === 2)!
      expect(after!.otherDueNow + two.firstPull).toBeGreaterThan(900)
      expect(after!.otherDueNow + two.firstPull).toBeLessThan(900 + 500)
    })

    /**
     * The security deposit is the one charge the plan REPLACES, so counting it
     * here would bill it twice on the same screen. A pet or key deposit is a
     * separate charge they still owe in full, and stays in.
     */
    it('leaves the security deposit out of it, but not a pet deposit', async () => {
      const { tenantId } = await offerFor({ depositAmount: 500 })
      const ctx = await db.query<{ unit_id: string; lease_id: string; landlord_id: string }>(
        `SELECT sd.unit_id, sd.lease_id, un.landlord_id FROM security_deposits sd
           JOIN units un ON un.id = sd.unit_id WHERE sd.tenant_id = $1`, [tenantId])
      const { unit_id, lease_id, landlord_id } = ctx.rows[0]
      // The security deposit as the move-in bundle bills it: no lease_fee_id.
      await db.query(
        `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status,
                               entry_description, due_date, revenue_owner)
         VALUES ($1,$2,$3,$4,'deposit',500,'pending','DEPOSIT',CURRENT_DATE,'landlord')`,
        [unit_id, lease_id, tenantId, landlord_id])
      expect((await flexDepositOffer({ tenantId }))!.otherDueNow).toBe(0)

      // A pet deposit carries its own lease_fees row.
      const fee = await db.query<{ id: string }>(
        `INSERT INTO lease_fees (lease_id, fee_type, due_timing, amount, description, is_refundable)
         VALUES ($1,'pet_deposit','move_in',200,'Pet deposit',TRUE) RETURNING id`, [lease_id])
      await db.query(
        `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status,
                               entry_description, due_date, revenue_owner, lease_fee_id)
         VALUES ($1,$2,$3,$4,'deposit',200,'pending','DEPOSIT',CURRENT_DATE,'landlord',$5)`,
        [unit_id, lease_id, tenantId, landlord_id, fee.rows[0].id])
      expect((await flexDepositOffer({ tenantId }))!.otherDueNow).toBe(200)
    })

    it('ends when the deposit is funded', async () => {
      const { tenantId } = await offerFor({ depositAmount: 500 })
      await db.query(
        `UPDATE security_deposits SET collected_amount = 500, status = 'funded'
          WHERE tenant_id = $1`, [tenantId])
      expect(await flexDepositOffer({ tenantId })).toBeNull()
    })

    it('ends when a plan is already running', async () => {
      const { tenantId } = await offerFor({ depositAmount: 500 })
      await db.query(
        `UPDATE security_deposits SET flex_deposit_enabled = TRUE,
                flex_deposit_plan_status = 'active' WHERE tenant_id = $1`, [tenantId])
      expect(await flexDepositOffer({ tenantId })).toBeNull()
    })

    it('says nothing while the product is switched off', async () => {
      const { tenantId } = await offerFor({ depositAmount: 500 })
      await db.query(`UPDATE system_features SET enabled = FALSE WHERE key = 'flexdeposit_rollout_visible'`)
      expect(await flexDepositOffer({ tenantId })).toBeNull()
    })

    /**
     * The signing prompt used to fire ONLY for somebody whose bank was neither
     * verified nor begun — which skipped exactly the people ready to enrol.
     * It now reads this same offer, so a resident with a verified bank is
     * prompted rather than passed over.
     */
    it('is what the signing prompt reads, verified bank included', async () => {
      const { tenantId } = await offerFor({ depositAmount: 500 })
      const u = await db.query<{ user_id: string }>(
        `SELECT user_id FROM tenants WHERE id = $1`, [tenantId])
      const prompt = await flexDepositSignPrompt(u.rows[0].user_id)
      expect(prompt).toEqual({ depositAmount: 500 })
    })
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

// Well inside the 90d on-time-payment lookback, and after the account in the
// returning-resident cases was opened, so the fixture stays chronologically sane.
const DAY_MS = 86_400_000
const RECENT_ON_TIME_PAYMENT_DAYS = 7
const daysAgoIso = (days: number): string =>
  new Date(Date.now() - days * DAY_MS).toISOString()

// ── 10/27 (Nic): THE 30 DAYS BELONG TO THE LANDLORD ─────────────────────────
//
//   "the 30 day gate was against the landlord profile. landlord has to be
//    vetted and moving money through the system. not the new tenant"
//
// S330 wrote it as a check on the RESIDENT's account age, which was the wrong
// party and unsatisfiable: FlexDeposit is only offered at move-in, so the
// person being asked has had an account for a day. It never bit because the
// product was off. GAM holds the deposit while the landlord's books read it as
// settled, so the party worth vetting is the landlord.
describe('getFlexDepositEligibility — the landlord has to be established', () => {
  const landlordCase = async (opts: Parameters<typeof buildEligibilityStack>[1]) => {
    const client = await db.connect()
    let tenantId: string
    try {
      await client.query('BEGIN')
      const stack = await buildEligibilityStack(client, {
        achVerified: true, bgStatus: 'approved', riskLevel: 'low', ...opts,
      })
      tenantId = stack.tenantId
      await client.query('COMMIT')
    } finally { client.release() }
    return await getFlexDepositEligibility(tenantId)
  }

  it('a brand-new resident at an established park is fully eligible — the move-in case', async () => {
    // Zero days on the platform, which is every move-in there will ever be.
    const r = await landlordCase({ tenantCreatedAt: new Date().toISOString() })
    expect(r.blockers).toEqual([])
    expect(r.eligible).toBe(true)
  })

  it('blocks when the company has been on GAM less than 30 days', async () => {
    const r = await landlordCase({ landlordCreatedAt: daysAgoIso(FLEX_DEPOSIT_MIN_LANDLORD_DAYS - 1) })
    expect(r.blockers).toEqual(['landlord_not_established'])
    expect(r.eligible).toBe(false)
  })

  it('blocks when the company is not vetted for payouts', async () => {
    const r = await landlordCase({ landlordPayoutsEnabled: false })
    expect(r.blockers).toEqual(['landlord_not_established'])
  })

  it('blocks when no money has settled through GAM for the company', async () => {
    const r = await landlordCase({ landlordMoneyMoving: false })
    expect(r.blockers).toEqual(['landlord_not_established'])
  })

  it('an old account with nothing moving through it is still not established', async () => {
    const r = await landlordCase({
      landlordCreatedAt: daysAgoIso(400), landlordMoneyMoving: false,
    })
    expect(r.blockers).toEqual(['landlord_not_established'])
  })

  it("a returning resident's own account age is not a gate any more", async () => {
    const client = await db.connect()
    let tenantId: string
    try {
      await client.query('BEGIN')
      const stack = await buildEligibilityStack(client, {
        achVerified: true, bgStatus: 'approved', riskLevel: 'low',
        tenantCreatedAt: daysAgoIso(1),
        seedPriorLease: true,
      })
      tenantId = stack.tenantId
      // The prior lease switches on the on-time-payment gate; satisfy it so
      // the equality below proves nothing else fired.
      await emitOnTimePayment(
        client, tenantId,
        new Date(Date.now() - RECENT_ON_TIME_PAYMENT_DAYS * DAY_MS),
      )
      await client.query('COMMIT')
    } finally { client.release() }
    const r = await getFlexDepositEligibility(tenantId)
    expect(r.blockers).toEqual([])
    expect(r.eligible).toBe(true)
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


// ── 10/27 (Nic): A DEPOSIT OVER THE TOP OF THE GRID STILL GETS A PLAN ───────
//
//   "We don't do deposits over $3,000. So that means if somebody's splitting a
//    payment more than that ... say the payment's $4,000 for the deposit. They
//    can split the $3,000 into four payments, they pay the $167 or whatever the
//    fee is, for the four payments, they pay the first payment of the $3,000,
//    so $750, and then they pay the difference of that $1,000 gap from $3,000
//    to $4,000 all at once."
//
// This is what the RESIDENT is offered, which is where it has to be right: a
// $4,000 deposit used to be refused a plan outright.
describe('getFlexDepositEligibility — a deposit above the grid', () => {
  const offered = async (depositAmount: number) => {
    const client = await db.connect()
    let tenantId: string
    try {
      await client.query('BEGIN')
      const stack = await buildEligibilityStack(client, {
        achVerified: true, bgStatus: 'approved', riskLevel: 'low', depositAmount,
      })
      tenantId = stack.tenantId
      await client.query('COMMIT')
    } finally { client.release() }
    return await getFlexDepositEligibility(tenantId)
  }

  it("Nic's $4,000: a plan on the first $3,000, $1,000 up front, and it IS offered", async () => {
    const r = await offered(4000)
    expect(r.eligible).toBe(true)
    const four = r.choices.find(c => c.payments === 4)!
    expect(four.fee).toBe(173)
    expect(four.installment).toBe(750)
    expect(four.payUpFront).toBe(1000)
    // The first collection: payment 1 + the whole fee + the part above the grid.
    expect(four.firstPull).toBe(750 + 173 + 1000)
    expect(four.total).toBe(4000 + 173)
    const two = r.choices.find(c => c.payments === 2)!
    expect([two.fee, two.installment, two.payUpFront]).toEqual([124, 1500, 1000])
  })

  it('a deposit inside the grid has nothing up front', async () => {
    const r = await offered(900)
    expect(r.choices.map(c => [c.payments, c.fee, c.installment, c.payUpFront]))
      .toEqual([[2, 48, 450, 0], [4, 67, 225, 0]])
  })

  it('exactly at the ceiling: the whole $3,000 splits, nothing up front', async () => {
    const r = await offered(3000)
    const four = r.choices.find(c => c.payments === 4)!
    expect([four.fee, four.installment, four.payUpFront, four.firstPull])
      .toEqual([173, 750, 0, 923])
  })
})


// ── 10/27 (Nic): STARTED ON THE DAY, FINISHED INSIDE FIVE ───────────────────
//
//   "They just need to initiate that process like on the day they sign the
//    lease. If they wait a day or two to like do that, they're not eligible for
//    flex deposit."
//
// A bank is verified only by microdeposits and they take a day or two, so the
// window exists to give them those days — not to let the landlord wait a week
// on a deposit. Five, because "we have to account for mid month lease starts or
// pro rated terms for early move in. those landlords will want the money the
// quickest."
describe('getFlexDepositEligibility — the window after signing', () => {
  const sign = async (o: Parameters<typeof buildEligibilityStack>[1]) => {
    const client = await db.connect()
    let tenantId: string
    try {
      await client.query('BEGIN')
      const stack = await buildEligibilityStack(client, {
        bgStatus: 'approved', riskLevel: 'low', ...o,
      })
      tenantId = stack.tenantId
      await client.query('COMMIT')
    } finally { client.release() }
    return await getFlexDepositEligibility(tenantId)
  }

  it('signed today, bank link begun today, microdeposits still in flight: offered', async () => {
    const r = await sign({ achVerified: false, signedDaysAgo: 0, bankStartedDaysAgo: 0 })
    // 10/28: this test's TITLE always said "offered" while its assertion said
    // blocked — the intent was written down and never built. Now it is: a link
    // in flight is enough to enrol and read your own terms, and nothing is
    // recorded as paid until an installment actually lands.
    expect(r.blockers).toEqual([])
    expect(r.blockers).not.toContain('bank_link_not_started_on_signing_day')
    expect(r.blockers).not.toContain('signing_window_closed')
  })

  it('signed yesterday and never started the bank: refused for the day, not the wait', async () => {
    const r = await sign({ achVerified: false, signedDaysAgo: 1, bankStartedDaysAgo: null })
    expect(r.blockers).toContain('bank_link_not_started_on_signing_day')
  })

  it('signed two days ago and only started the bank today: too late', async () => {
    const r = await sign({ achVerified: false, signedDaysAgo: 2, bankStartedDaysAgo: 0 })
    expect(r.blockers).toContain('bank_link_not_started_on_signing_day')
  })

  it('five days on from signing is still inside the window', async () => {
    const r = await sign({ achVerified: true, signedDaysAgo: FLEX_DEPOSIT_SIGNING_WINDOW_DAYS, bankStartedDaysAgo: FLEX_DEPOSIT_SIGNING_WINDOW_DAYS })
    expect(r.blockers).toEqual([])
    expect(r.eligible).toBe(true)
  })

  it('a day past it, the deposit is simply owed as billed', async () => {
    const r = await sign({ achVerified: true, signedDaysAgo: FLEX_DEPOSIT_SIGNING_WINDOW_DAYS + 1, bankStartedDaysAgo: FLEX_DEPOSIT_SIGNING_WINDOW_DAYS + 1 })
    expect(r.blockers).toEqual(['signing_window_closed'])
    expect(r.eligible).toBe(false)
  })

  it('a verified bank is proof on its own — the start date is not held against them', async () => {
    // Verified, but the link was begun the day AFTER signing. They plainly did
    // the work; refusing here would be refusing the paperwork, not the fact.
    const r = await sign({ achVerified: true, signedDaysAgo: 2, bankStartedDaysAgo: 1 })
    expect(r.blockers).toEqual([])
    expect(r.eligible).toBe(true)
  })

  it('nothing signed yet is not a refusal — the offer is open until it is', async () => {
    const r = await sign({ achVerified: true })   // signed_at untouched (null)
    expect(r.blockers).toEqual([])
  })
})


// ── 10/27 (Nic): THE NUDGE BEFORE THEY SIGN ─────────────────────────────────
//
//   "Before signing, they need to have a pop-up that says... hey, in order to
//    do flex deposit, please link your bank account."
//
// The first version of this read a tenant_id off the SIGNER row. That column
// does not exist, so the lookup never ran and the prompt silently never
// appeared — the kind of nothing that looks exactly like a working feature.
//
// ── 10/29 (Nic): AND IT IS NOT A BANK NUDGE ANY MORE ───────────────────────
//
//   "We need the prompt to pop up for any tenants when the deposit has not
//    been paid yet... It needs to be there until the deposit is handled one
//    way or another."
//
// It used to fire ONLY for somebody whose bank was neither verified nor begun,
// which skipped exactly the people ready to enrol — the resident at MH 28
// verified her bank the morning after signing and would never have been shown
// it. It now reads the standing offer, so a verified bank is a reason to
// prompt, not a reason to stay quiet. The three cases below that asserted the
// old silence are kept, flipped, so the narrowing cannot come back by accident.
describe('flexDepositSignPrompt — what the signer is told before signing', () => {
  // There is no point nudging somebody about a product that is switched off,
  // so the prompt checks visibility — which means these tests have to switch
  // it on, the way production has it.
  beforeEach(async () => {
    await db.query(
      `INSERT INTO system_features (key, enabled, description)
       VALUES ('flexdeposit_rollout_visible', TRUE, '10/27 test')
       ON CONFLICT (key) DO UPDATE SET enabled = TRUE`)
  })

  it('says nothing at all while the product is switched off', async () => {
    await db.query(`UPDATE system_features SET enabled = FALSE WHERE key = 'flexdeposit_rollout_visible'`)
    const { prompt } = await promptFor({ achVerified: false, depositAmount: 900, bankStartedDaysAgo: null })
    expect(prompt).toBeNull()
  })

  const promptFor = async (o: Parameters<typeof buildEligibilityStack>[1]) => {
    const client = await db.connect()
    let userId: string
    try {
      await client.query('BEGIN')
      const stack = await buildEligibilityStack(client, { bgStatus: 'approved', riskLevel: 'low', ...o })
      userId = (await client.query<{ user_id: string }>(
        `SELECT user_id FROM tenants WHERE id = $1`, [stack.tenantId])).rows[0].user_id
      await client.query('COMMIT')
    } finally { client.release() }
    const { flexDepositSignPrompt } = await import('./flexDeposit')
    return { userId: userId!, prompt: await flexDepositSignPrompt(userId!) }
  }

  it('names the deposit when there is one and no bank yet', async () => {
    const { prompt } = await promptFor({ achVerified: false, depositAmount: 900, bankStartedDaysAgo: null })
    expect(prompt).toEqual({ depositAmount: 900 })
  })

  it('STILL prompts once the bank is verified — they are the readiest of all', async () => {
    const { prompt } = await promptFor({ achVerified: true, depositAmount: 900 })
    expect(prompt).toEqual({ depositAmount: 900 })
  })

  it('STILL prompts while microdeposits are in flight', async () => {
    const { prompt } = await promptFor({ achVerified: false, depositAmount: 900, bankStartedDaysAgo: 0 })
    expect(prompt).toEqual({ depositAmount: 900 })
  })

  it('says nothing when the landlord is charging no deposit', async () => {
    const { prompt } = await promptFor({ achVerified: false, skipDeposit: true })
    expect(prompt).toBeNull()
  })

  it('says nothing to somebody with no tenant profile at all', async () => {
    const { flexDepositSignPrompt } = await import('./flexDeposit')
    const u = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, first_name, last_name, role, email_verified)
       VALUES ($1, 'x', 'No', 'Profile', 'tenant', TRUE) RETURNING id`,
      [`noprofile-${Date.now()}@test.dev`])
    expect(await flexDepositSignPrompt(u.rows[0].id)).toBeNull()
  })
})

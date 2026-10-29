/**
 * FlexSuite enrollment acceptance — S314 audit chain + S323
 * re-acceptance flow.
 *
 * Covers:
 *   - recordAcceptance: row insertion + sha256 hash on rendered_text
 *   - getPendingReAcceptances: status detection across template-
 *     version mismatch + pre-S314 no-row + already-current-version
 *     cases
 *   - commitReAcceptance: end-to-end re-acceptance (skips the
 *     post-commit PDF email by no-op'ing the Resend send when
 *     RESEND_API_KEY is unset — email-sender is best-effort and
 *     catches errors internally)
 *   - renderReAcceptanceTerms (10/26): the FlexDeposit agreement now
 *     states the one-time service fee the plan was SOLD at, read from
 *     security_deposits.flex_deposit_service_fee. Covered both ways —
 *     the stored price prints, and a plan with no price on record
 *     refuses to re-render instead of printing "[Not Provided]" where
 *     the price goes.
 *
 * All tests use the cleanupAllSchema + getClient pattern because
 * recordAcceptance + commitReAcceptance commit their own
 * transactions through the singleton pool, not the caller's tx.
 */

import crypto from 'crypto'
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../db'
import {
  recordAcceptance,
  getPendingReAcceptances,
  commitReAcceptance,
  renderReAcceptanceTerms,
  FLEXPAY_TEMPLATE_VERSION,
  FLEXDEPOSIT_TEMPLATE_VERSION,
} from './flexsuiteAcceptance'
import {
  cleanupAllSchema,
  seedLandlord, seedTenant, seedProperty, seedUnit,
  seedLease, seedLeaseTenant,
} from '../test/dbHelpers'

beforeEach(cleanupAllSchema)

// Seed a tenant who's enrolled in FlexPay (flexpay_enrolled=TRUE,
// pull_day + monthly_fee set). Returns the tenant id + their user id.
async function seedFlexPayEnrolledTenant(): Promise<{
  tenantId: string; userId: string; landlordId: string
}> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const { userId: landlordUserId, landlordId } = await seedLandlord(client)
    const tenantId = await seedTenant(client)
    const tu = await client.query<{ user_id: string }>(
      `SELECT user_id FROM tenants WHERE id = $1`,
      [tenantId],
    )
    const tenantUserId = tu.rows[0].user_id
    await client.query(
      `UPDATE tenants
          SET flexpay_enrolled    = TRUE,
              flexpay_pull_day    = 15,
              flexpay_monthly_fee = 20,
              flexpay_enrolled_at = NOW()
        WHERE id = $1`,
      [tenantId],
    )
    // A property + unit so the acceptance render can fetch context.
    const propertyId = await seedProperty(client, {
      landlordId, ownerUserId: landlordUserId, managedByUserId: landlordUserId,
    })
    void await seedUnit(client, { propertyId, landlordId, rentAmount: 1000 })
    await client.query('COMMIT')
    return { tenantId, userId: tenantUserId, landlordId }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally { client.release() }
}

// 10/26 — THE FIXTURE PLAN'S FIGURES COME FROM THE PRICE CARD.
//
// FlexDeposit's fee is no longer a constant: it is read from
// flexdeposit_fee_schedule at enrollment and the price the plan was SOLD at is
// stamped on security_deposits.flex_deposit_service_fee, so a later re-price
// cannot restate what a tenant accepted. A fixture plan therefore has to be a
// plan the price card can actually produce, or its stored fee is a price
// nobody set.
//
//   deposit $1,000  the $1,000-1,499 bracket. Brackets are half-open, so
//                   exactly $1,000 sits in this one, not in 0-999.
//   4 payments      $93.00. FlexDeposit sells exactly two splits, 2 and 4;
//                   the 3-payment plan this fixture used to seed has no row in
//                   the grid at all, so no plan could have been sold at one and
//                   no honest fee could be stamped on it.
//   $1,000 / 4      $250.00 an installment, with no rounding residue to carry
//                   on installment 1.
//
// Verified against gam_test.flexdeposit_fee_schedule (the 10/26 grid, seeded by
// test/globalSetup.ts effective 2020-01-01), not taken from memory.
const FIXTURE_DEPOSIT_TOTAL      = 1000
const FIXTURE_SERVICE_FEE        = 93
const FIXTURE_INSTALLMENT_AMOUNT = 250
// Monthly from the lease start, the way enrollment lays a schedule out.
const FIXTURE_INSTALLMENT_DUE_DATES = ['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01']
const FIXTURE_INSTALLMENT_COUNT  = FIXTURE_INSTALLMENT_DUE_DATES.length  // 4 — see above

// Seed a tenant who's enrolled in FlexDeposit (deposit row +
// installments + active plan status). Required by
// renderReAcceptanceTerms('flexdeposit').
async function seedFlexDepositEnrolledTenant(opts: {
  /**
   * The fee stamped on the plan. `null` seeds a plan with NO price on record —
   * what a plan that predates the column looks like — which the re-render has
   * to refuse. Omit it for a normally priced plan.
   */
  serviceFee?: number | null
} = {}): Promise<{
  tenantId: string; userId: string; landlordId: string; depositId: string
}> {
  const serviceFee = opts.serviceFee === undefined ? FIXTURE_SERVICE_FEE : opts.serviceFee
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const { userId: landlordUserId, landlordId } = await seedLandlord(client)
    const tenantId = await seedTenant(client)
    const tu = await client.query<{ user_id: string }>(
      `SELECT user_id FROM tenants WHERE id = $1`,
      [tenantId],
    )
    const tenantUserId = tu.rows[0].user_id
    const propertyId = await seedProperty(client, {
      landlordId, ownerUserId: landlordUserId, managedByUserId: landlordUserId,
    })
    const unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: 1000 })
    const leaseId = await seedLease(client, {
      unitId, landlordId, rentAmount: 1000, status: 'active',
      startDate: FIXTURE_INSTALLMENT_DUE_DATES[0],
    })
    await seedLeaseTenant(client, { leaseId, tenantId, role: 'primary' })
    const dep = await client.query<{ id: string }>(
      `INSERT INTO security_deposits
         (unit_id, lease_id, tenant_id, total_amount, status, held_by,
          flex_deposit_enabled, flex_deposit_plan_status,
          installment_count, installment_amount, installments_paid,
          installments_remaining, gam_advance_amount,
          flex_deposit_service_fee)
       VALUES ($1, $2, $3, $4, 'partial', 'gam_escrow',
               TRUE, 'active',
               $5, $6, 0, $5, 0,
               $7)
       RETURNING id`,
      [
        unitId, leaseId, tenantId, FIXTURE_DEPOSIT_TOTAL,
        FIXTURE_INSTALLMENT_COUNT, FIXTURE_INSTALLMENT_AMOUNT,
        serviceFee,
      ],
    )
    const depositId = dep.rows[0].id
    for (const [i, dueDate] of FIXTURE_INSTALLMENT_DUE_DATES.entries()) {
      await client.query(
        `INSERT INTO flex_deposit_installments
           (security_deposit_id, tenant_id, installment_number, installment_count,
            amount, due_date, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending')`,
        [depositId, tenantId, i + 1, FIXTURE_INSTALLMENT_COUNT,
         FIXTURE_INSTALLMENT_AMOUNT, dueDate],
      )
    }
    await client.query('COMMIT')
    return { tenantId, userId: tenantUserId, landlordId, depositId }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally { client.release() }
}

describe('recordAcceptance', () => {
  it('inserts a row with sha256 hash on rendered_text', async () => {
    const { tenantId, userId } = await seedFlexPayEnrolledTenant()
    const client = await db.connect()
    let acceptanceId: string
    try {
      await client.query('BEGIN')
      acceptanceId = await recordAcceptance({
        client,
        tenantId,
        userId,
        productType:     'flexpay',
        templateVersion: '1.0.0',
        populatedContent: { pullDay: 15, fee: 20 },
        renderedText:    'Test rendered SLA text for hashing.',
        ip:              '127.0.0.1',
        userAgent:       'test-suite',
      })
      await client.query('COMMIT')
    } finally { client.release() }

    const row = await db.query<{
      tenant_id: string; product_type: string; template_version: string;
      content_hash: string; accepted_ip: string; accepted_user_agent: string;
    }>(
      `SELECT tenant_id, product_type, template_version, content_hash,
              accepted_ip, accepted_user_agent
         FROM flexsuite_enrollment_acceptances WHERE id = $1`,
      [acceptanceId],
    )
    expect(row.rows).toHaveLength(1)
    const r = row.rows[0]
    expect(r.tenant_id).toBe(tenantId)
    expect(r.product_type).toBe('flexpay')
    expect(r.template_version).toBe('1.0.0')
    expect(r.accepted_ip).toBe('127.0.0.1')
    expect(r.accepted_user_agent).toBe('test-suite')
    // Hash matches sha256 of the rendered_text we passed in.
    const expectedHash = crypto
      .createHash('sha256')
      .update('Test rendered SLA text for hashing.', 'utf8')
      .digest('hex')
    expect(r.content_hash).toBe(expectedHash)
  })
})

describe('getPendingReAcceptances', () => {
  it('returns empty when tenant has no enrollments', async () => {
    const client = await db.connect()
    let tenantId: string
    try {
      await client.query('BEGIN')
      tenantId = await seedTenant(client)
      await client.query('COMMIT')
    } finally { client.release() }
    const pending = await getPendingReAcceptances(tenantId)
    expect(pending).toEqual([])
  })

  it('returns flexpay pending when enrolled but no acceptance row (pre-S314)', async () => {
    const { tenantId } = await seedFlexPayEnrolledTenant()
    const pending = await getPendingReAcceptances(tenantId)
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({
      product:        'flexpay',
      currentVersion: '(none)',
      latestVersion:  FLEXPAY_TEMPLATE_VERSION,
      flexpayPullDay: 15,
      flexpayMonthlyFee: 20,
    })
  })

  it('returns empty when enrolled and latest acceptance is at current version', async () => {
    const { tenantId, userId } = await seedFlexPayEnrolledTenant()
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      await recordAcceptance({
        client, tenantId, userId,
        productType:     'flexpay',
        templateVersion: FLEXPAY_TEMPLATE_VERSION,
        populatedContent: { pullDay: 15, fee: 20 },
        renderedText:    'current-version text',
        ip:              null, userAgent: null,
      })
      await client.query('COMMIT')
    } finally { client.release() }
    const pending = await getPendingReAcceptances(tenantId)
    expect(pending).toEqual([])
  })

  it('returns pending when latest acceptance is on an OLD version', async () => {
    const { tenantId, userId } = await seedFlexPayEnrolledTenant()
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      await recordAcceptance({
        client, tenantId, userId,
        productType:     'flexpay',
        templateVersion: '0.9.0',  // old
        populatedContent: { pullDay: 15, fee: 20 },
        renderedText:    'old-version text',
        ip:              null, userAgent: null,
      })
      await client.query('COMMIT')
    } finally { client.release() }
    const pending = await getPendingReAcceptances(tenantId)
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({
      product:        'flexpay',
      currentVersion: '0.9.0',
      latestVersion:  FLEXPAY_TEMPLATE_VERSION,
    })
  })

  it('returns flexdeposit pending when enrolled with active plan + no acceptance', async () => {
    const { tenantId } = await seedFlexDepositEnrolledTenant()
    const pending = await getPendingReAcceptances(tenantId)
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({
      product:        'flexdeposit',
      currentVersion: '(none)',
      latestVersion:  FLEXDEPOSIT_TEMPLATE_VERSION,
      flexdepositInstallmentCount: FIXTURE_INSTALLMENT_COUNT,
    })
  })
})

describe('renderReAcceptanceTerms', () => {
  it('renders flexpay text using the tenant\'s current pullDay + fee', async () => {
    const { tenantId, userId } = await seedFlexPayEnrolledTenant()
    const { renderedText, populatedContent } = await renderReAcceptanceTerms({
      tenantId, userId, product: 'flexpay', ip: null, userAgent: null,
    })
    expect(renderedText.length).toBeGreaterThan(0)
    expect(populatedContent.pullDay).toBe(15)
    expect(populatedContent.fee).toBe(20)
  })

  it('renders flexdeposit text with the persisted installment schedule', async () => {
    const { tenantId, userId } = await seedFlexDepositEnrolledTenant()
    const { renderedText, populatedContent } = await renderReAcceptanceTerms({
      tenantId, userId, product: 'flexdeposit', ip: null, userAgent: null,
    })
    expect(renderedText.length).toBeGreaterThan(0)
    expect(populatedContent.installmentCount).toBe(FIXTURE_INSTALLMENT_COUNT)
    expect(populatedContent.installments).toHaveLength(FIXTURE_INSTALLMENT_COUNT)
    // 10/26: the agreement has to STATE the one-time fee, so pin the sentence
    // that carries it. A document a resident accepts must never say
    // "[Not Provided]" where the price goes.
    expect(renderedText).toContain(`one-time service fee of $${FIXTURE_SERVICE_FEE}.00`)
  })

  // 10/26: the other half of the price guard. A plan enrolled before
  // flex_deposit_service_fee existed has no price on record, and an agreement
  // that printed "[Not Provided]" where the price belongs would be worse than
  // no agreement — so the re-render refuses with a 409. Nothing covered this.
  it('refuses to re-render a flexdeposit plan with no service fee on record', async () => {
    // Identical to the plan above in every other respect — same deposit, same
    // schedule, same active status. The missing price is the only difference.
    const { tenantId, userId } = await seedFlexDepositEnrolledTenant({ serviceFee: null })
    const err: any = await renderReAcceptanceTerms({
      tenantId, userId, product: 'flexdeposit', ip: null, userAgent: null,
    }).then(
      () => { throw new Error('expected the re-render to refuse, but it produced an agreement') },
      (e: unknown) => e,
    )
    expect(err.statusCode).toBe(409)
    expect(err.message).toMatch(/no service fee on record/)
  })

  // 10/26: the fee is stamped at enrollment and NEVER re-quoted, so a plan sold
  // at an older price keeps printing that price. $86 is a real grid figure from
  // a DIFFERENT bracket ($1,500-1,999 split two ways), chosen so a render that
  // re-quoted this plan from today's card would print $93 and fail here.
  const FEE_THIS_PLAN_WAS_SOLD_AT = 86
  it('prints the fee stored on the plan, not a fresh quote from the price card', async () => {
    const { tenantId, userId } = await seedFlexDepositEnrolledTenant({
      serviceFee: FEE_THIS_PLAN_WAS_SOLD_AT,
    })
    const { renderedText } = await renderReAcceptanceTerms({
      tenantId, userId, product: 'flexdeposit', ip: null, userAgent: null,
    })
    expect(renderedText).toContain(`one-time service fee of $${FEE_THIS_PLAN_WAS_SOLD_AT}.00`)
    expect(renderedText).not.toContain(`one-time service fee of $${FIXTURE_SERVICE_FEE}.00`)
  })

  it('throws 409 when product is flexpay but tenant not enrolled', async () => {
    const client = await db.connect()
    let tenantId: string; let userId: string
    try {
      await client.query('BEGIN')
      tenantId = await seedTenant(client)
      const tu = await client.query<{ user_id: string }>(
        `SELECT user_id FROM tenants WHERE id = $1`,
        [tenantId],
      )
      userId = tu.rows[0].user_id
      await client.query('COMMIT')
    } finally { client.release() }
    await expect(
      renderReAcceptanceTerms({ tenantId, userId, product: 'flexpay', ip: null, userAgent: null })
    ).rejects.toThrow(/Not enrolled in FlexPay/)
  })
})

describe('commitReAcceptance', () => {
  it('writes a new acceptance row at the current template version', async () => {
    const { tenantId, userId } = await seedFlexPayEnrolledTenant()
    const acceptanceId = await commitReAcceptance({
      tenantId, userId, product: 'flexpay',
      ip: '10.0.0.1', userAgent: 'reaccept-suite',
    })
    expect(acceptanceId).toMatch(/^[0-9a-f-]{36}$/)

    const row = await db.query<{ template_version: string; product_type: string }>(
      `SELECT template_version, product_type
         FROM flexsuite_enrollment_acceptances WHERE id = $1`,
      [acceptanceId],
    )
    expect(row.rows[0].template_version).toBe(FLEXPAY_TEMPLATE_VERSION)
    expect(row.rows[0].product_type).toBe('flexpay')
  })

  it('clears the pending re-acceptance for the product after commit', async () => {
    const { tenantId, userId } = await seedFlexPayEnrolledTenant()
    // Verify pending exists pre-commit.
    let pending = await getPendingReAcceptances(tenantId)
    expect(pending).toHaveLength(1)
    expect(pending[0].product).toBe('flexpay')

    await commitReAcceptance({
      tenantId, userId, product: 'flexpay', ip: null, userAgent: null,
    })

    pending = await getPendingReAcceptances(tenantId)
    expect(pending).toEqual([])
  })
})

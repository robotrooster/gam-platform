/**
 * Stripe webhook handler — `payment_intent.succeeded` rent slice.
 *
 * Mocks the Stripe SDK at module level: `webhooks.constructEvent`
 * returns the raw body parsed as JSON (no signature verification),
 * `transfers.create` is a vi.fn() that resolves immediately.
 * That short-circuits real Stripe network calls while letting the
 * webhook handler exercise its full transaction:
 *   - flip payment to settled
 *   - call executeRentAllocation (writes user_balance_ledger +
 *     platform_revenue_ledger rows)
 *   - emit a credit_events `payment_received_*` event
 *   - fire post-commit Stripe transfer attempts (mocked away)
 *
 * Scope: the rent path of payment_intent.succeeded. Deferred:
 *   - payment_intent.payment_failed (NACHA retry semantics)
 *   - charge.dispute.* events
 *   - utility payment path (same allocation engine, different
 *     entry_description; would mostly duplicate the rent assertions)
 *   - POS terminal PI early-return is covered with one short test
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'

// Stripe must be mocked BEFORE webhooks.ts imports it. vi.mock is
// hoisted automatically.
// Silence real outbound emails — Resend would 403 against the test
// 'from' address. The notifications.ts service routes through
// `sendNotificationEmail` from email.ts; overriding that one export
// is enough to suppress all the rent-collected / rent-failed /
// retries-exhausted email firings the webhook triggers as side-effects.
// Notification rows still land in the DB (we don't assert on them).
vi.mock('../services/email', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    sendNotificationEmail: vi.fn(async () => undefined),
  }
})

vi.mock('stripe', () => {
  const transfersCreate = vi.fn(async () => ({ id: 'tr_mock' }))
  const customersRetrieve = vi.fn(async () => ({}))
  const paymentIntentsCreate = vi.fn(async () => ({ id: 'pi_mock' }))
  const constructEvent = (body: Buffer | string, _sig: any, _secret: string) => {
    const text = typeof body === 'string' ? body : body.toString('utf8')
    return JSON.parse(text)
  }
  function FakeStripe(this: any) {
    this.webhooks = { constructEvent }
    this.transfers = { create: transfersCreate }
    this.customers = { retrieve: customersRetrieve }
    this.paymentIntents = { create: paymentIntentsCreate }
  }
  ;(FakeStripe as any).__mocks = { transfersCreate, customersRetrieve, paymentIntentsCreate, constructEvent }
  return { default: FakeStripe }
})

import Stripe from 'stripe'
import { webhooksRouter } from './webhooks'
import { db, getClient } from '../db'
import {
  cleanupAllSchema,
  seedLandlord, seedManager, seedTenant,
  seedProperty, seedUnit,
  seedAllocationRule, seedRentPayment,
  seedLease, seedLeaseTenant,
  seedUtilityMeter, seedUtilityBill, seedUtilityPayment,
} from '../test/dbHelpers'

const stripeMocks: {
  transfersCreate:      ReturnType<typeof vi.fn>
  customersRetrieve:    ReturnType<typeof vi.fn>
  paymentIntentsCreate: ReturnType<typeof vi.fn>
} = (Stripe as any).__mocks

// ── HTTP test app ───────────────────────────────────────────────────────────

function buildApp() {
  const app = express()
  app.use('/webhooks/stripe', express.raw({ type: 'application/json' }))
  app.use('/webhooks', webhooksRouter)
  return app
}

// ── Event-builder helpers ───────────────────────────────────────────────────

interface PiEventOpts {
  paymentIntentId: string
  paymentMethod?: 'us_bank_account' | 'card'
  chargeId?: string
  metadata?: Record<string, string>
}

function buildPaymentIntentSucceeded(opts: PiEventOpts): string {
  // Returns a JSON string. supertest's `.send(string)` with
  // Content-Type: application/json forwards bytes as-is; passing a
  // Buffer instead would trigger JSON.stringify(buffer) → the
  // `{"type":"Buffer","data":[...]}` representation, which our
  // express.raw + JSON.parse pipeline can't unwrap back to the
  // original payload.
  const evt = {
    id: 'evt_' + opts.paymentIntentId,
    type: 'payment_intent.succeeded',
    data: {
      object: {
        id: opts.paymentIntentId,
        metadata: opts.metadata ?? {},
        charges: {
          data: [{
            id: opts.chargeId ?? 'ch_' + opts.paymentIntentId,
            payment_method_details: {
              type: opts.paymentMethod ?? 'us_bank_account',
            },
          }],
        },
      },
    },
  }
  return JSON.stringify(evt)
}

interface PiFailedOpts {
  paymentIntentId: string
  returnCode?: string | null   // null = no return_details payload
  metadata?: Record<string, string>
}

function buildPaymentIntentFailed(opts: PiFailedOpts): string {
  const lpe: Record<string, unknown> = {}
  if (opts.returnCode !== undefined && opts.returnCode !== null) {
    lpe.payment_method_details = {
      us_bank_account: { return_details: { code: opts.returnCode } },
    }
  }
  const evt = {
    id: 'evt_' + opts.paymentIntentId,
    type: 'payment_intent.payment_failed',
    data: {
      object: {
        id: opts.paymentIntentId,
        metadata: opts.metadata ?? {},
        last_payment_error: lpe,
      },
    },
  }
  return JSON.stringify(evt)
}

beforeEach(async () => {
  await cleanupAllSchema()
  stripeMocks.transfersCreate.mockClear()
  stripeMocks.customersRetrieve.mockClear()
  stripeMocks.paymentIntentsCreate.mockClear()
  // Webhook handler reads STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET
  // before invoking the Stripe SDK — values don't matter because the
  // SDK is mocked, but they must be defined or `new Stripe(undefined!, …)`
  // would throw inside the FakeStripe constructor (no-op here, but
  // belt-and-suspenders).
  process.env.STRIPE_SECRET_KEY     = 'sk_test_mocked'
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_mocked'
})

// Pool lifecycle: don't end the singleton in afterAll. Multiple test
// files share the same process under vitest singleFork — whichever
// file ran first would otherwise close the pool out from under the
// rest. The process exit handles teardown.

// ── Suite-wide rate setup (rent allocation needs processing rates) ──────────

beforeEach(async () => {
  await db.query(
    `INSERT INTO platform_processing_rates
       (payment_method, customer_facing_flat, customer_facing_percent,
        stripe_cost_flat, stripe_cost_percent)
     VALUES ('ach', 0, 1.0, 0, 0.5)
        ON CONFLICT DO NOTHING`
  )
})

// ── Tests ───────────────────────────────────────────────────────────────────

describe('POST /webhooks/stripe — signature handling', () => {
  it('400 when constructEvent throws (invalid JSON simulates bad signature)', async () => {
    // The mock's `constructEvent` JSON.parses the raw body, so feeding
    // garbage triggers the same 400 path that a real bad signature
    // would. Real Stripe would throw on signature mismatch; we throw
    // on JSON parse failure. Same handler-level branch either way.
    const app = buildApp()
    const res = await request(app)
      .post('/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', 'nope')
      .send('not-valid-json')
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/signature/i)
  })
})

describe('POST /webhooks/stripe — payment_intent.succeeded rent', () => {
  it('happy path: ACH rent settles → allocation runs → ledger rows written', async () => {
    const client = await getClient()
    let ownerUserId: string, landlordId: string, paymentId: string
    try {
      const seedRes = await seedLandlord(client)
      ownerUserId = seedRes.userId
      landlordId = seedRes.landlordId
      const tenantId = await seedTenant(client)
      const propertyId = await seedProperty(client, {
        landlordId, ownerUserId, managedByUserId: ownerUserId,
      })
      const unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: 1000 })
      await seedAllocationRule(client, { propertyId, achFeePayer: 'tenant' })
      paymentId = await seedRentPayment(client, {
        unitId, tenantId, landlordId, amount: 1000, status: 'pending',
        stripePaymentIntentId: 'pi_rent_happy_1',
      })
    } finally {
      client.release()
    }

    const app = buildApp()
    const body = buildPaymentIntentSucceeded({
      paymentIntentId: 'pi_rent_happy_1',
      paymentMethod: 'us_bank_account',
    })
    const res = await request(app)
      .post('/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', 't=1,v1=stub')
      .send(body)

    if (res.status !== 200) {
      // eslint-disable-next-line no-console
      console.error('webhook responded', res.status, res.body)
    }
    expect(res.status).toBe(200)

    const pay = await db.query<{
      status: string; settled_at: string | null;
      stripe_charge_id: string | null
    }>(
      `SELECT status, settled_at, stripe_charge_id FROM payments WHERE id=$1`,
      [paymentId!]
    )
    expect(pay.rows[0].status).toBe('settled')
    expect(pay.rows[0].settled_at).not.toBeNull()
    expect(pay.rows[0].stripe_charge_id).toBe('ch_pi_rent_happy_1')

    const ownerLedger = await db.query<{ amount: string; type: string }>(
      `SELECT amount::text AS amount, type FROM user_balance_ledger
        WHERE reference_id=$1`,
      [paymentId!]
    )
    expect(ownerLedger.rows).toHaveLength(1)
    expect(ownerLedger.rows[0]).toMatchObject({
      amount: '1000.00',
      type: 'allocation_owner_share',
    })

    const spread = await db.query<{ amount: string }>(
      `SELECT amount::text AS amount FROM platform_revenue_ledger
        WHERE reference_id=$1 AND type='banking_spread'`,
      [paymentId!]
    )
    expect(spread.rows[0].amount).toBe('5.00')
  })

  it('idempotent: re-firing the same event does not write duplicate ledger rows', async () => {
    const client = await getClient()
    let paymentId: string
    try {
      const { userId: ownerUserId, landlordId } = await seedLandlord(client)
      const tenantId = await seedTenant(client)
      const propertyId = await seedProperty(client, {
        landlordId, ownerUserId, managedByUserId: ownerUserId,
      })
      const unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: 1000 })
      await seedAllocationRule(client, { propertyId, achFeePayer: 'tenant' })
      paymentId = await seedRentPayment(client, {
        unitId, tenantId, landlordId, amount: 1000, status: 'pending',
      })
      await client.query(
        `UPDATE payments SET stripe_payment_intent_id=$1 WHERE id=$2`,
        ['pi_rent_idem_1', paymentId]
      )
    } finally {
      client.release()
    }

    const app = buildApp()
    const body = buildPaymentIntentSucceeded({
      paymentIntentId: 'pi_rent_idem_1',
      paymentMethod: 'us_bank_account',
    })

    const r1 = await request(app)
      .post('/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', 't=1,v1=stub')
      .send(body)
    expect(r1.status).toBe(200)

    const r2 = await request(app)
      .post('/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', 't=1,v1=stub')
      .send(body)
    expect(r2.status).toBe(200)

    // The settle UPDATE has `status != 'settled'` so the second pass
    // matches nothing — no second allocation run. Ledger stays single.
    const count = await db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM user_balance_ledger WHERE reference_id=$1`,
      [paymentId!]
    )
    expect(count.rows[0].n).toBe('1')
  })

  it('separate manager: allocation_manager_fee row written via webhook', async () => {
    const client = await getClient()
    let paymentId: string, managerUserId: string
    try {
      const { userId: ownerUserId, landlordId } = await seedLandlord(client)
      managerUserId = await seedManager(client)
      const tenantId = await seedTenant(client)
      const propertyId = await seedProperty(client, {
        landlordId, ownerUserId, managedByUserId: managerUserId,
      })
      const unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: 1000 })
      await seedAllocationRule(client, {
        propertyId,
        achFeePayer: 'landlord',
        rentPercent: 10,
      })
      paymentId = await seedRentPayment(client, {
        unitId, tenantId, landlordId, amount: 1000, status: 'pending',
      })
      await client.query(
        `UPDATE payments SET stripe_payment_intent_id=$1 WHERE id=$2`,
        ['pi_rent_mgr_1', paymentId]
      )
    } finally {
      client.release()
    }

    const app = buildApp()
    const body = buildPaymentIntentSucceeded({
      paymentIntentId: 'pi_rent_mgr_1',
      paymentMethod: 'us_bank_account',
    })
    const res = await request(app)
      .post('/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', 't=1,v1=stub')
      .send(body)
    expect(res.status).toBe(200)

    const mgrLedger = await db.query<{ amount: string; user_id: string }>(
      `SELECT amount::text AS amount, user_id FROM user_balance_ledger
        WHERE reference_id=$1 AND type='allocation_manager_fee'`,
      [paymentId!]
    )
    expect(mgrLedger.rows[0]).toMatchObject({
      amount: '99.00',
      user_id: managerUserId!,
    })
  })

  it('POS terminal PI: early-returns without allocation', async () => {
    // Send a payment_intent.succeeded with metadata.gam_purpose set.
    // No matching `payments` row needs to exist — handler short-circuits
    // before the settle UPDATE.
    const app = buildApp()
    const body = buildPaymentIntentSucceeded({
      paymentIntentId: 'pi_pos_terminal_1',
      paymentMethod: 'card',
      metadata: { gam_purpose: 'pos_terminal' },
    })
    const res = await request(app)
      .post('/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', 't=1,v1=stub')
      .send(body)
    expect(res.status).toBe(200)

    const ledger = await db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM user_balance_ledger`
    )
    expect(ledger.rows[0].n).toBe('0')
  })

  it('no matching payment row: webhook returns 200, no ledger rows', async () => {
    // Stripe replays old events sometimes; an unknown PI is benign.
    const app = buildApp()
    const body = buildPaymentIntentSucceeded({
      paymentIntentId: 'pi_unknown_1',
      paymentMethod: 'us_bank_account',
    })
    const res = await request(app)
      .post('/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', 't=1,v1=stub')
      .send(body)
    expect(res.status).toBe(200)

    const ledger = await db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM user_balance_ledger`
    )
    expect(ledger.rows[0].n).toBe('0')
  })

  it('allocation failure: 500 + admin notification, no ledger writes', async () => {
    // Set the property up without an allocation rule. executeRentAllocation
    // throws "no allocation rule" → tx rolls back → admin_notifications
    // row inserted, response 500.
    const client = await getClient()
    let paymentId: string
    try {
      const { userId: ownerUserId, landlordId } = await seedLandlord(client)
      const tenantId = await seedTenant(client)
      const propertyId = await seedProperty(client, {
        landlordId, ownerUserId, managedByUserId: ownerUserId,
      })
      const unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: 1000 })
      // NO seedAllocationRule call → allocation engine rejects.
      paymentId = await seedRentPayment(client, {
        unitId, tenantId, landlordId, amount: 1000, status: 'pending',
      })
      await client.query(
        `UPDATE payments SET stripe_payment_intent_id=$1 WHERE id=$2`,
        ['pi_rent_failure_1', paymentId]
      )
    } finally {
      client.release()
    }

    const app = buildApp()
    const body = buildPaymentIntentSucceeded({
      paymentIntentId: 'pi_rent_failure_1',
      paymentMethod: 'us_bank_account',
    })
    const res = await request(app)
      .post('/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', 't=1,v1=stub')
      .send(body)
    expect(res.status).toBe(500)

    // Payment stays unsettled (tx rolled back).
    const pay = await db.query<{ status: string }>(
      `SELECT status FROM payments WHERE id=$1`,
      [paymentId!]
    )
    expect(pay.rows[0].status).toBe('pending')

    // Ledger empty (rollback).
    const lc = await db.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM user_balance_ledger`)
    expect(lc.rows[0].n).toBe('0')

    // Admin notification fired.
    const notif = await db.query<{ category: string }>(
      `SELECT category FROM admin_notifications
        WHERE category='webhook_payment_settled_handler_failed'`
    )
    expect(notif.rows).toHaveLength(1)
  })
})

describe('POST /webhooks/stripe — payment_intent.payment_failed', () => {
  // ── Helper: seed a minimal lease/payment stack and stamp the PI id.
  // The failed branch doesn't need allocation rules or processing rates
  // — those only matter on settle. Just need a payment row keyed by
  // stripe_payment_intent_id.
  async function seedPendingPayment(args: {
    paymentIntentId: string
    retryCount?: number
    amount?: number
  }): Promise<string> {
    const client = await getClient()
    try {
      const { userId: ownerUserId, landlordId } = await seedLandlord(client)
      const tenantId = await seedTenant(client)
      const propertyId = await seedProperty(client, {
        landlordId, ownerUserId, managedByUserId: ownerUserId,
      })
      const unitId = await seedUnit(client, {
        propertyId, landlordId, rentAmount: args.amount ?? 1000,
      })
      const paymentId = await seedRentPayment(client, {
        unitId, tenantId, landlordId,
        amount: args.amount ?? 1000,
        status: 'pending',
        stripePaymentIntentId: args.paymentIntentId,
      })
      if (args.retryCount !== undefined) {
        await client.query(
          `UPDATE payments SET retry_count=$1 WHERE id=$2`,
          [args.retryCount, paymentId]
        )
      }
      return paymentId
    } finally {
      client.release()
    }
  }

  it('retryable code (R01 insufficient funds): schedules retry, next_retry_at NOT NULL', async () => {
    const paymentId = await seedPendingPayment({
      paymentIntentId: 'pi_fail_r01_1',
    })
    const app = buildApp()
    const res = await request(app)
      .post('/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', 't=1,v1=stub')
      .send(buildPaymentIntentFailed({
        paymentIntentId: 'pi_fail_r01_1', returnCode: 'R01',
      }))
    expect(res.status).toBe(200)

    const pay = await db.query<{
      status: string; return_code: string | null; next_retry_at: string | null
    }>(
      `SELECT status, return_code, next_retry_at FROM payments WHERE id=$1`,
      [paymentId]
    )
    expect(pay.rows[0]).toMatchObject({
      status: 'failed',
      return_code: 'R01',
    })
    expect(pay.rows[0].next_retry_at).not.toBeNull()

    // Non-terminal — no payment_failed_nsf credit event emitted.
    const events = await db.query<{ event_type: string }>(
      `SELECT event_type FROM credit_events`
    )
    const types = events.rows.map((r) => r.event_type)
    expect(types).not.toContain('payment_failed_nsf')
  })

  it('non-retryable code (R02 account closed): permanent failure, next_retry_at=NULL, payment_failed_nsf emitted', async () => {
    const paymentId = await seedPendingPayment({
      paymentIntentId: 'pi_fail_r02_1',
    })
    const app = buildApp()
    const res = await request(app)
      .post('/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', 't=1,v1=stub')
      .send(buildPaymentIntentFailed({
        paymentIntentId: 'pi_fail_r02_1', returnCode: 'R02',
      }))
    expect(res.status).toBe(200)

    const pay = await db.query<{
      status: string; return_code: string | null; next_retry_at: string | null
    }>(
      `SELECT status, return_code, next_retry_at FROM payments WHERE id=$1`,
      [paymentId]
    )
    expect(pay.rows[0]).toMatchObject({
      status: 'failed',
      return_code: 'R02',
      next_retry_at: null,
    })

    const events = await db.query<{ event_type: string }>(
      `SELECT event_type FROM credit_events ce
         JOIN credit_subjects cs ON cs.id = ce.subject_id
        WHERE cs.subject_ref_id IS NOT NULL`
    )
    expect(events.rows.map((r) => r.event_type))
      .toContain('payment_failed_nsf')
  })

  it('zero-tolerance code (R05 unauthorized): permanent failure, no retry scheduled', async () => {
    const paymentId = await seedPendingPayment({
      paymentIntentId: 'pi_fail_r05_1',
    })
    const app = buildApp()
    const res = await request(app)
      .post('/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', 't=1,v1=stub')
      .send(buildPaymentIntentFailed({
        paymentIntentId: 'pi_fail_r05_1', returnCode: 'R05',
      }))
    expect(res.status).toBe(200)

    const pay = await db.query<{
      status: string; return_code: string | null; next_retry_at: string | null
    }>(
      `SELECT status, return_code, next_retry_at FROM payments WHERE id=$1`,
      [paymentId]
    )
    expect(pay.rows[0]).toMatchObject({
      status: 'failed',
      return_code: 'R05',
      next_retry_at: null,
    })
  })

  it('retry cap reached (retry_count=2): falls through to permanent', async () => {
    const paymentId = await seedPendingPayment({
      paymentIntentId: 'pi_fail_cap_1',
      retryCount: 2,
    })
    const app = buildApp()
    const res = await request(app)
      .post('/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', 't=1,v1=stub')
      .send(buildPaymentIntentFailed({
        paymentIntentId: 'pi_fail_cap_1', returnCode: 'R01',
      }))
    expect(res.status).toBe(200)

    const pay = await db.query<{
      status: string; next_retry_at: string | null
    }>(
      `SELECT status, next_retry_at FROM payments WHERE id=$1`,
      [paymentId]
    )
    expect(pay.rows[0]).toMatchObject({
      status: 'failed',
      next_retry_at: null,
    })
  })

  it('missing return code: defaults to permanent (conservative)', async () => {
    const paymentId = await seedPendingPayment({
      paymentIntentId: 'pi_fail_norc_1',
    })
    const app = buildApp()
    const res = await request(app)
      .post('/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', 't=1,v1=stub')
      .send(buildPaymentIntentFailed({
        paymentIntentId: 'pi_fail_norc_1', returnCode: null,
      }))
    expect(res.status).toBe(200)

    const pay = await db.query<{
      status: string; return_code: string | null; next_retry_at: string | null
    }>(
      `SELECT status, return_code, next_retry_at FROM payments WHERE id=$1`,
      [paymentId]
    )
    expect(pay.rows[0]).toMatchObject({
      status: 'failed',
      return_code: null,
      next_retry_at: null,
    })
  })

  it('POS terminal failure: early-returns, no DB write', async () => {
    const paymentId = await seedPendingPayment({
      paymentIntentId: 'pi_fail_pos_1',
    })
    const app = buildApp()
    const res = await request(app)
      .post('/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', 't=1,v1=stub')
      .send(buildPaymentIntentFailed({
        paymentIntentId: 'pi_fail_pos_1',
        returnCode: 'R01',
        metadata: { gam_purpose: 'pos_terminal' },
      }))
    expect(res.status).toBe(200)

    // Payment row untouched (status stays 'pending').
    const pay = await db.query<{ status: string }>(
      `SELECT status FROM payments WHERE id=$1`,
      [paymentId]
    )
    expect(pay.rows[0].status).toBe('pending')
  })

  it('unknown PI id: webhook returns 200 with no side effects', async () => {
    const app = buildApp()
    const res = await request(app)
      .post('/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', 't=1,v1=stub')
      .send(buildPaymentIntentFailed({
        paymentIntentId: 'pi_fail_unknown_1', returnCode: 'R01',
      }))
    expect(res.status).toBe(200)
  })
})

// ── charge.dispute.* ────────────────────────────────────────────────────────

interface DisputeEventOpts {
  type: 'charge.dispute.created' | 'charge.dispute.updated' | 'charge.dispute.closed'
  disputeId: string
  chargeId: string
  paymentIntentId?: string | null
  amountCents: number
  status?: string
  reason?: string
  evidenceDueByEpoch?: number  // unix seconds
}

function buildDisputeEvent(opts: DisputeEventOpts): string {
  const obj: Record<string, unknown> = {
    id: opts.disputeId,
    charge: opts.chargeId,
    amount: opts.amountCents,
    currency: 'usd',
    reason: opts.reason ?? 'general',
    status: opts.status ?? 'needs_response',
  }
  if (opts.paymentIntentId) obj.payment_intent = opts.paymentIntentId
  if (opts.evidenceDueByEpoch) {
    obj.evidence_details = { due_by: opts.evidenceDueByEpoch }
  }
  return JSON.stringify({
    id: 'evt_' + opts.disputeId,
    type: opts.type,
    data: { object: obj },
  })
}

describe('POST /webhooks/stripe — charge.dispute.*', () => {
  it('charge.dispute.created: inserts connect_disputes row linked to GAM payment', async () => {
    // Seed a payment so the dispute can resolve payment_id / landlord_id.
    const client = await getClient()
    let landlordId: string, paymentId: string
    try {
      const { userId: ownerUserId, landlordId: lid } = await seedLandlord(client)
      landlordId = lid
      const tenantId = await seedTenant(client)
      const propertyId = await seedProperty(client, {
        landlordId, ownerUserId, managedByUserId: ownerUserId,
      })
      const unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: 1000 })
      paymentId = await seedRentPayment(client, {
        unitId, tenantId, landlordId, amount: 1000, status: 'settled',
        stripePaymentIntentId: 'pi_dispute_1',
      })
    } finally {
      client.release()
    }

    const app = buildApp()
    const res = await request(app)
      .post('/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', 't=1,v1=stub')
      .send(buildDisputeEvent({
        type: 'charge.dispute.created',
        disputeId: 'dp_test_1',
        chargeId: 'ch_pi_dispute_1',
        paymentIntentId: 'pi_dispute_1',
        amountCents: 50_000,
        reason: 'fraudulent',
        evidenceDueByEpoch: Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
      }))
    expect(res.status).toBe(200)

    const disp = await db.query<{
      stripe_dispute_id: string
      payment_id: string | null
      landlord_id: string | null
      amount: string
      reason: string | null
      status: string
      evidence_due_by: string | null
    }>(
      `SELECT stripe_dispute_id, payment_id, landlord_id,
              amount::text AS amount, reason, status, evidence_due_by
         FROM connect_disputes WHERE stripe_dispute_id=$1`,
      ['dp_test_1']
    )
    expect(disp.rows).toHaveLength(1)
    expect(disp.rows[0]).toMatchObject({
      stripe_dispute_id: 'dp_test_1',
      payment_id: paymentId!,
      landlord_id: landlordId!,
      amount: '500.00',
      reason: 'fraudulent',
      status: 'needs_response',
    })
    expect(disp.rows[0].evidence_due_by).not.toBeNull()
  })

  it('charge.dispute.updated: upserts status on an existing row', async () => {
    // First fire .created, then .updated with a different status.
    const app = buildApp()
    await request(app)
      .post('/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', 't=1,v1=stub')
      .send(buildDisputeEvent({
        type: 'charge.dispute.created',
        disputeId: 'dp_upd_1', chargeId: 'ch_upd_1',
        amountCents: 25_000, status: 'needs_response',
      }))
    const r2 = await request(app)
      .post('/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', 't=1,v1=stub')
      .send(buildDisputeEvent({
        type: 'charge.dispute.updated',
        disputeId: 'dp_upd_1', chargeId: 'ch_upd_1',
        amountCents: 25_000, status: 'under_review',
      }))
    expect(r2.status).toBe(200)

    const rows = await db.query<{ status: string }>(
      `SELECT status FROM connect_disputes WHERE stripe_dispute_id=$1`,
      ['dp_upd_1']
    )
    expect(rows.rows).toHaveLength(1)
    expect(rows.rows[0].status).toBe('under_review')
  })

  it('charge.dispute.closed with no GAM payment linkage: still inserts row (payment_id null)', async () => {
    // Dispute on a charge GAM doesn't recognize (cross-platform Stripe
    // event, or test fixture without a seeded payment). recordDisputeEvent
    // tolerates a missing payment match and writes payment_id=NULL.
    const app = buildApp()
    const res = await request(app)
      .post('/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', 't=1,v1=stub')
      .send(buildDisputeEvent({
        type: 'charge.dispute.closed',
        disputeId: 'dp_orphan_1', chargeId: 'ch_unknown_1',
        paymentIntentId: 'pi_unknown_dispute',
        amountCents: 10_000, status: 'won',
      }))
    expect(res.status).toBe(200)

    const rows = await db.query<{ payment_id: string | null; status: string }>(
      `SELECT payment_id, status FROM connect_disputes WHERE stripe_dispute_id=$1`,
      ['dp_orphan_1']
    )
    expect(rows.rows[0]).toMatchObject({ payment_id: null, status: 'won' })
  })
})

// ── payment_intent.succeeded — utility branch ───────────────────────────────

describe('POST /webhooks/stripe — payment_intent.succeeded utility', () => {
  it('utility settle: allocation runs + utility_bills.status flips to paid', async () => {
    const client = await getClient()
    let paymentId: string, billId: string
    try {
      const { userId: ownerUserId, landlordId } = await seedLandlord(client)
      const tenantId = await seedTenant(client)
      const propertyId = await seedProperty(client, {
        landlordId, ownerUserId, managedByUserId: ownerUserId,
      })
      const unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: 1000 })
      await seedAllocationRule(client, { propertyId, achFeePayer: 'tenant' })
      const leaseId = await seedLease(client, { unitId, landlordId, rentAmount: 1000 })
      await seedLeaseTenant(client, { leaseId, tenantId })
      const meterId = await seedUtilityMeter(client, { propertyId })
      paymentId = await seedUtilityPayment(client, {
        unitId, tenantId, landlordId, leaseId,
        amount: 80, status: 'pending',
        stripePaymentIntentId: 'pi_util_1',
      })
      billId = await seedUtilityBill(client, {
        meterId, unitId, tenantId, leaseId, landlordId,
        chargeAmount: 80, paymentId, status: 'billed',
      })
    } finally {
      client.release()
    }

    const app = buildApp()
    const res = await request(app)
      .post('/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', 't=1,v1=stub')
      .send(buildPaymentIntentSucceeded({
        paymentIntentId: 'pi_util_1',
        paymentMethod: 'us_bank_account',
      }))
    expect(res.status).toBe(200)

    // Payment settled.
    const pay = await db.query<{ status: string }>(
      `SELECT status FROM payments WHERE id=$1`,
      [paymentId!]
    )
    expect(pay.rows[0].status).toBe('settled')

    // utility_bill flipped to paid.
    const bill = await db.query<{ status: string; paid_at: string | null }>(
      `SELECT status, paid_at FROM utility_bills WHERE id=$1`,
      [billId!]
    )
    expect(bill.rows[0].status).toBe('paid')
    expect(bill.rows[0].paid_at).not.toBeNull()

    // Allocation engine wrote owner_share + banking_spread (same engine
    // as rent — utility uses identical allocation math per S122).
    const ledger = await db.query<{ type: string; amount: string }>(
      `SELECT type, amount::text AS amount FROM user_balance_ledger
        WHERE reference_id=$1`,
      [paymentId!]
    )
    expect(ledger.rows).toHaveLength(1)
    expect(ledger.rows[0]).toMatchObject({
      type: 'allocation_owner_share',
      amount: '80.00',
    })

    const spread = await db.query<{ amount: string }>(
      `SELECT amount::text AS amount FROM platform_revenue_ledger
        WHERE reference_id=$1 AND type='banking_spread'`,
      [paymentId!]
    )
    expect(spread.rows[0].amount).toBe('0.40')  // 80 * (1.0% - 0.5%) = 0.40
  })
})

// ── account.updated ────────────────────────────────────────────────────────

interface AccountEventOpts {
  accountId:         string
  chargesEnabled?:   boolean
  payoutsEnabled?:   boolean
  detailsSubmitted?: boolean
}

function buildAccountUpdatedEvent(opts: AccountEventOpts): string {
  return JSON.stringify({
    id:      'evt_' + opts.accountId,
    type:    'account.updated',
    data: {
      object: {
        id:                 opts.accountId,
        charges_enabled:    opts.chargesEnabled    ?? false,
        payouts_enabled:    opts.payoutsEnabled    ?? false,
        details_submitted:  opts.detailsSubmitted  ?? false,
      },
    },
  })
}

describe('POST /webhooks/stripe — account.updated', () => {
  it('KYC clears on users row: capability flags + synced_at flip on the matching landlord', async () => {
    const client = await getClient()
    let userId: string
    try {
      ;({ userId } = await seedLandlord(client))
      await client.query(
        `UPDATE users SET stripe_connect_account_id = $1 WHERE id = $2`,
        ['acct_user_kyc_1', userId]
      )
    } finally {
      client.release()
    }

    const app = buildApp()
    const res = await request(app)
      .post('/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', 't=1,v1=stub')
      .send(buildAccountUpdatedEvent({
        accountId:         'acct_user_kyc_1',
        chargesEnabled:    true,
        payoutsEnabled:    true,
        detailsSubmitted:  true,
      }))
    expect(res.status).toBe(200)

    const row = await db.query<{
      connect_charges_enabled:           boolean
      connect_payouts_enabled:           boolean
      connect_details_submitted:         boolean
      stripe_connect_status_synced_at:   string | null
    }>(
      `SELECT connect_charges_enabled, connect_payouts_enabled,
              connect_details_submitted, stripe_connect_status_synced_at
         FROM users WHERE id = $1`,
      [userId!]
    )
    expect(row.rows[0]).toMatchObject({
      connect_charges_enabled:   true,
      connect_payouts_enabled:   true,
      connect_details_submitted: true,
    })
    expect(row.rows[0].stripe_connect_status_synced_at).not.toBeNull()
  })

  it('KYC clears on pm_companies row: same flag flip path applies to PM org accounts', async () => {
    // PM companies share the same readiness cache as users; the webhook
    // handler runs both UPDATEs unconditionally and at-most-one matches
    // (account ids are unique across both tables).
    const client = await getClient()
    let pmCompanyId: string
    try {
      // Direct insert (skip seedPmCompany which requires a bank_account_id;
      // we don't need bank linkage for the account.updated branch).
      const r = await client.query<{ id: string }>(
        `INSERT INTO pm_companies (name, stripe_connect_account_id)
         VALUES ('Acct Test PM Co', $1) RETURNING id`,
        ['acct_pm_kyc_1']
      )
      pmCompanyId = r.rows[0].id
    } finally {
      client.release()
    }

    const app = buildApp()
    const res = await request(app)
      .post('/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', 't=1,v1=stub')
      .send(buildAccountUpdatedEvent({
        accountId:         'acct_pm_kyc_1',
        chargesEnabled:    true,
        payoutsEnabled:    true,
        detailsSubmitted:  true,
      }))
    expect(res.status).toBe(200)

    const row = await db.query<{
      connect_charges_enabled:   boolean
      connect_payouts_enabled:   boolean
      connect_details_submitted: boolean
    }>(
      `SELECT connect_charges_enabled, connect_payouts_enabled,
              connect_details_submitted
         FROM pm_companies WHERE id = $1`,
      [pmCompanyId!]
    )
    expect(row.rows[0]).toMatchObject({
      connect_charges_enabled:   true,
      connect_payouts_enabled:   true,
      connect_details_submitted: true,
    })
  })

  it('no matching account on either table: silent 200, no rows updated', async () => {
    // Cross-platform Stripe events fire account.updated for accounts
    // GAM has never seen. The handler should no-op cleanly.
    const client = await getClient()
    let userId: string
    try {
      ;({ userId } = await seedLandlord(client))
      // Deliberately DO NOT set stripe_connect_account_id — this user
      // has no Connect account. The unrelated account event should not
      // flip any flags on this user.
    } finally {
      client.release()
    }

    const app = buildApp()
    const res = await request(app)
      .post('/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', 't=1,v1=stub')
      .send(buildAccountUpdatedEvent({
        accountId:         'acct_orphan_1',
        chargesEnabled:    true,
        payoutsEnabled:    true,
        detailsSubmitted:  true,
      }))
    expect(res.status).toBe(200)

    // Unrelated user is untouched.
    const row = await db.query<{
      connect_charges_enabled:           boolean
      stripe_connect_status_synced_at:   string | null
    }>(
      `SELECT connect_charges_enabled, stripe_connect_status_synced_at
         FROM users WHERE id = $1`,
      [userId!]
    )
    expect(row.rows[0].connect_charges_enabled).toBe(false)
    expect(row.rows[0].stripe_connect_status_synced_at).toBeNull()
  })

  it('partial KYC (details=false): flags update faithfully, reconcile branch skipped', async () => {
    // Stripe pings account.updated as requirements accumulate, not just
    // when KYC clears. With details_submitted=false the handler must
    // still snapshot the current state (so the dashboard reflects it)
    // but skip the platform-held-payments reconcile branch — that
    // branch only fires once the account is fully usable.
    const client = await getClient()
    let userId: string
    try {
      ;({ userId } = await seedLandlord(client))
      await client.query(
        `UPDATE users SET stripe_connect_account_id = $1 WHERE id = $2`,
        ['acct_user_partial_1', userId]
      )
    } finally {
      client.release()
    }

    const app = buildApp()
    const res = await request(app)
      .post('/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', 't=1,v1=stub')
      .send(buildAccountUpdatedEvent({
        accountId:         'acct_user_partial_1',
        chargesEnabled:    false,
        payoutsEnabled:    false,
        detailsSubmitted:  false,
      }))
    expect(res.status).toBe(200)

    const row = await db.query<{
      connect_charges_enabled:           boolean
      connect_payouts_enabled:           boolean
      connect_details_submitted:         boolean
      stripe_connect_status_synced_at:   string | null
    }>(
      `SELECT connect_charges_enabled, connect_payouts_enabled,
              connect_details_submitted, stripe_connect_status_synced_at
         FROM users WHERE id = $1`,
      [userId!]
    )
    expect(row.rows[0]).toMatchObject({
      connect_charges_enabled:   false,
      connect_payouts_enabled:   false,
      connect_details_submitted: false,
    })
    // Synced_at still updates regardless of capability state — it's a
    // "last-seen" timestamp, not a "fully-ready" one.
    expect(row.rows[0].stripe_connect_status_synced_at).not.toBeNull()
  })
})

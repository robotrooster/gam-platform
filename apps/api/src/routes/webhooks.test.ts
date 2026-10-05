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

// S654: pass-through spy on the credit emitters so a test can see the
// calendar day and the property zone the webhook hands them. Behavior is the
// real emitter's.
vi.mock('../services/creditLedgerEmitters', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/creditLedgerEmitters')>()
  return {
    ...actual,
    emitPaymentSettledEvent: vi.fn(actual.emitPaymentSettledEvent),
    emitPaymentFailedEvent: vi.fn(actual.emitPaymentFailedEvent),
  }
})

vi.mock('stripe', () => {
  // S655: a small in-memory Stripe for the saved methods, so the verified-bank
  // routine (tenantBankMethods.recordVerifiedTenantBank) sees what a real
  // customer holds: each payment method's owner and metadata, the default.
  const state = {
    pms: new Map<string, any>(),
    defaults: new Map<string, string>(),
  }
  const bankPm = (id: string, customer: string | null) => ({
    id, type: 'us_bank_account', customer, metadata: {},
    us_bank_account: { last4: '6789', routing_number: '110000000', bank_name: 'Test Bank' },
  })
  const transfersCreate = vi.fn(async () => ({ id: 'tr_mock' }))
  const customersRetrieve = vi.fn(async (id: string) => ({
    id, invoice_settings: { default_payment_method: state.defaults.get(id) ?? null },
  }))
  const customersUpdate = vi.fn(async (id: string, p: any) => {
    const d = p?.invoice_settings?.default_payment_method
    if (d) state.defaults.set(id, d)
    return { id }
  })
  const paymentIntentsCreate = vi.fn(async () => ({ id: 'pi_mock' }))
  const paymentIntentsCancel = vi.fn(async (id: string) => ({ id, status: 'canceled' }))
  // S570: setup_intent.succeeded handler retrieves the PM for bank last4.
  const paymentMethodsRetrieve = vi.fn(async (id: string) =>
    state.pms.get(id) ?? { id, us_bank_account: { last4: '6789', routing_number: '110000000' } })
  const paymentMethodsUpdate = vi.fn(async (id: string, p: any) => {
    const pm = state.pms.get(id)
    if (pm && p?.metadata) pm.metadata = { ...(pm.metadata ?? {}), ...p.metadata }
    return pm ?? { id }
  })
  const paymentMethodsList = vi.fn(async (q: any) => ({
    data: [...state.pms.values()].filter((pm) => pm.customer === q?.customer && pm.type === q?.type),
  }))
  const setupIntentsList = vi.fn(async () => ({ data: [] }))
  // S654: payment_failed reads a bare latest_charge id's failure_code.
  const chargesRetrieve = vi.fn(async (id: string): Promise<any> => ({ id }))
  const constructEvent = (body: Buffer | string, _sig: any, _secret: string) => {
    const text = typeof body === 'string' ? body : body.toString('utf8')
    return JSON.parse(text)
  }
  function FakeStripe(this: any) {
    this.webhooks = { constructEvent }
    this.transfers = { create: transfersCreate }
    this.customers = { retrieve: customersRetrieve, update: customersUpdate }
    this.paymentIntents = { create: paymentIntentsCreate, cancel: paymentIntentsCancel }
    this.paymentMethods = { retrieve: paymentMethodsRetrieve, update: paymentMethodsUpdate, list: paymentMethodsList }
    this.setupIntents = { list: setupIntentsList }
    this.charges = { retrieve: chargesRetrieve }
  }
  ;(FakeStripe as any).__mocks = {
    transfersCreate, customersRetrieve, customersUpdate, paymentIntentsCreate, paymentIntentsCancel,
    paymentMethodsRetrieve, paymentMethodsUpdate, chargesRetrieve, constructEvent, state, bankPm,
  }
  return { default: FakeStripe }
})

import Stripe from 'stripe'
import { webhooksRouter } from './webhooks'
import { emitPaymentSettledEvent, emitPaymentFailedEvent } from '../services/creditLedgerEmitters'
import { sendNotificationEmail } from '../services/email'
import { db, getClient } from '../db'
import {
  cleanupAllSchema,
  seedLandlord, seedManager, seedTenant,
  seedProperty, seedUnit,
  seedAllocationRule, seedRentPayment,
  seedLease, seedLeaseTenant,
  seedUtilityMeter, seedUtilityBill, seedUtilityPayment,
  seedUserBankAccount, seedPmCompany,
} from '../test/dbHelpers'

/**
 * A bill row as a charge leaves it: claimed ('processing') with its intent on
 * it — every bill charge claims its rows before the intent exists, and a
 * success settles only rows still waiting on it (plan §3).
 */
async function seedClaimedRent(client: Parameters<typeof seedRentPayment>[0],
  p: Omit<Parameters<typeof seedRentPayment>[1], 'status'>): Promise<string> {
  const id = await seedRentPayment(client, p)
  await client.query(`UPDATE payments SET status = 'processing' WHERE id = $1`, [id])
  return id
}
async function seedClaimedUtility(client: Parameters<typeof seedUtilityPayment>[0],
  p: Omit<Parameters<typeof seedUtilityPayment>[1], 'status'>): Promise<string> {
  const id = await seedUtilityPayment(client, p)
  await client.query(`UPDATE payments SET status = 'processing' WHERE id = $1`, [id])
  return id
}

const stripeMocks: {
  transfersCreate:      ReturnType<typeof vi.fn>
  customersRetrieve:    ReturnType<typeof vi.fn>
  customersUpdate:      ReturnType<typeof vi.fn>
  paymentIntentsCreate: ReturnType<typeof vi.fn>
  paymentIntentsCancel: ReturnType<typeof vi.fn>
  chargesRetrieve:      ReturnType<typeof vi.fn>
  state: { pms: Map<string, any>; defaults: Map<string, string> }
  bankPm: (id: string, customer: string | null) => any
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
  paymentMethod?: 'us_bank_account' | 'card' | 'card_present'
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
        // S560: modern Stripe payload shape — `latest_charge` (expanded
        // object), NOT the removed `charges.data` list. Exercises the real
        // resolveCharge path so the regression can't be masked again.
        latest_charge: {
          id: opts.chargeId ?? 'ch_' + opts.paymentIntentId,
          payment_method_details: {
            type: opts.paymentMethod ?? 'us_bank_account',
          },
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
  stripeMocks.state.pms.clear()
  stripeMocks.state.defaults.clear()
  stripeMocks.customersUpdate.mockClear()
  stripeMocks.paymentIntentsCancel.mockClear()
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
  // S654: a card tapped on the counter reader arrives as `card_present`. It is
  // a card — same rate row, same settlement — and must never roll back forever.
  it('a counter-reader card (card_present) settles like any card', async () => {
    const client = await getClient()
    let paymentId: string
    try {
      const seedRes = await seedLandlord(client)
      const tenantId = await seedTenant(client)
      const propertyId = await seedProperty(client, { landlordId: seedRes.landlordId, ownerUserId: seedRes.userId, managedByUserId: seedRes.userId })
      const unitId = await seedUnit(client, { propertyId, landlordId: seedRes.landlordId, rentAmount: 1000 })
      await seedAllocationRule(client, { propertyId, achFeePayer: 'tenant', cardFeePayer: 'tenant' })
      // Reference data the cleanup leaves alone: seed only if missing, tagged, removed below.
      await client.query(
        `INSERT INTO platform_processing_rates (payment_method, customer_facing_flat, customer_facing_percent, stripe_cost_flat, stripe_cost_percent, notes)
         SELECT 'card', 0.55, 3.5, 0.26, 2.9, 's654-tapped-card-test'
          WHERE NOT EXISTS (SELECT 1 FROM platform_processing_rates WHERE payment_method = 'card' AND effective_until IS NULL)`)
      paymentId = await seedClaimedRent(client, {
        unitId, tenantId, landlordId: seedRes.landlordId, amount: 1000,
        stripePaymentIntentId: 'pi_rent_tapped_1',
      })
    } finally { client.release() }
    const res = await request(buildApp())
      .post('/webhooks/stripe').set('Content-Type', 'application/json').set('stripe-signature', 't=1,v1=stub')
      .send(buildPaymentIntentSucceeded({ paymentIntentId: 'pi_rent_tapped_1', paymentMethod: 'card_present', metadata: { gam_purpose: 'rent_terminal' } }))
    expect(res.status).toBe(200)
    const pay = await db.query<{ status: string }>(`SELECT status FROM payments WHERE id=$1`, [paymentId!])
    expect(pay.rows[0].status).toBe('settled')
    await db.query(`DELETE FROM platform_processing_rates WHERE notes = 's654-tapped-card-test'`)
  })

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
      paymentId = await seedClaimedRent(client, {
        unitId, tenantId, landlordId, amount: 1000,
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
    // S603: $1,000 rent + $10 tenant-paid fee = $1,010 processed; Stripe's
    // 0.5% of that is $5.05, so the spread is $10.00 - $5.05 = $4.95.
    expect(spread.rows[0].amount).toBe('4.95')
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
      paymentId = await seedClaimedRent(client, {
        unitId, tenantId, landlordId, amount: 1000,
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
      paymentId = await seedClaimedRent(client, {
        unitId, tenantId, landlordId, amount: 1000,
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
      paymentId = await seedClaimedRent(client, {
        unitId, tenantId, landlordId, amount: 1000,
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
    expect(pay.rows[0].status).toBe('processing')

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

  // S654: the credit tier compares calendar days where the PROPERTY is. The
  // webhook hands the emitter the due day as 'YYYY-MM-DD' and the property's
  // zone; rent paid on its due date by that property's clock is on time at
  // any hour (it used to turn late at 5 pm Phoenix, when UTC rolled over).
  it('rent paid on its due date in the property\'s zone is recorded on time', async () => {
    const tz = 'Pacific/Honolulu'
    const client = await getClient()
    let paymentId: string, tenantId: string
    try {
      const { userId: ownerUserId, landlordId } = await seedLandlord(client)
      tenantId = await seedTenant(client)
      const propertyId = await seedProperty(client, { landlordId, ownerUserId, managedByUserId: ownerUserId })
      await client.query(`UPDATE properties SET timezone = $2 WHERE id = $1`, [propertyId, tz])
      const unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: 1000 })
      await seedAllocationRule(client, { propertyId, achFeePayer: 'tenant' })
      paymentId = await seedClaimedRent(client, {
        unitId, tenantId, landlordId, amount: 1000, stripePaymentIntentId: 'pi_rent_tz_1',
      })
      await client.query(
        `UPDATE payments SET due_date = (NOW() AT TIME ZONE $2)::date WHERE id = $1`, [paymentId, tz])
    } finally { client.release() }
    const due = (await db.query<{ d: string }>(
      `SELECT due_date::text AS d FROM payments WHERE id = $1`, [paymentId!])).rows[0].d

    vi.mocked(emitPaymentSettledEvent).mockClear()
    const res = await request(buildApp())
      .post('/webhooks/stripe').set('Content-Type', 'application/json').set('stripe-signature', 't=1,v1=stub')
      .send(buildPaymentIntentSucceeded({ paymentIntentId: 'pi_rent_tz_1', paymentMethod: 'us_bank_account' }))
    expect(res.status).toBe(200)

    expect(vi.mocked(emitPaymentSettledEvent)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(emitPaymentSettledEvent).mock.calls[0][1]).toMatchObject({
      paymentId: paymentId!, dueDate: due, propertyTz: tz,
    })
    const ev = await db.query<{ event_type: string; event_data: any }>(
      `SELECT ce.event_type, ce.event_data FROM credit_events ce
         JOIN credit_subjects cs ON cs.id = ce.subject_id
        WHERE cs.subject_type = 'tenant' AND cs.subject_ref_id = $1`, [tenantId!])
    expect(ev.rows).toHaveLength(1)
    expect(ev.rows[0].event_type).toBe('payment_received_on_time')
    expect(ev.rows[0].event_data.due_date).toBe(due)
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

    // S654: the due day goes to the ledger as a calendar date, not a Date.
    const due = (await db.query<{ d: string }>(
      `SELECT due_date::text AS d FROM payments WHERE id = $1`, [paymentId])).rows[0].d
    const nsfCall = vi.mocked(emitPaymentFailedEvent).mock.calls.find((c) => c[1].paymentId === paymentId)
    expect(nsfCall?.[1].dueDate).toBe(due)
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

  // ── S603: declined-CARD-attempt fee ($1.00, 'DECLINEFEE') ──────────────
  // Stripe bills per AUTHORIZATION, so every refused card attempt costs GAM
  // $0.28 with no revenue. ACH is excluded (it carries its own $4 RETURNFEE).
  function buildCardFailed(paymentIntentId: string): string {
    return JSON.stringify({
      id: 'evt_' + paymentIntentId,
      type: 'payment_intent.payment_failed',
      data: {
        object: {
          id: paymentIntentId,
          metadata: {},
          payment_method_types: ['card'],
          last_payment_error: { payment_method: { type: 'card' } },
        },
      },
    })
  }

  async function postEvent(body: string) {
    return request(buildApp())
      .post('/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', 't=1,v1=stub')
      .send(body)
  }

  it('S603 card decline: bills a $1.00 DECLINEFEE row to the tenant', async () => {
    await seedPendingPayment({ paymentIntentId: 'pi_card_decline_1' })
    expect((await postEvent(buildCardFailed('pi_card_decline_1'))).status).toBe(200)

    const fees = await db.query<{ amount: string; type: string; status: string }>(
      `SELECT amount, type, status FROM payments WHERE entry_description='DECLINEFEE'`
    )
    expect(fees.rows).toHaveLength(1)
    expect(fees.rows[0]).toMatchObject({ type: 'fee', status: 'pending' })
    expect(parseFloat(fees.rows[0].amount)).toBe(1.00)
  })

  it('S603 ACH decline: bills NO decline fee (ACH keeps its own $4 return fee)', async () => {
    await seedPendingPayment({ paymentIntentId: 'pi_ach_decline_1' })
    expect((await postEvent(buildPaymentIntentFailed({
      paymentIntentId: 'pi_ach_decline_1', returnCode: 'R01',
    }))).status).toBe(200)

    const fees = await db.query(
      `SELECT 1 FROM payments WHERE entry_description='DECLINEFEE'`
    )
    expect(fees.rows).toHaveLength(0)
  })

  it('S603 card decline: a redelivered webhook does NOT double-bill the fee', async () => {
    await seedPendingPayment({ paymentIntentId: 'pi_card_dupe_1' })
    // Stripe redelivery: the raw-event insert is ON CONFLICT DO NOTHING but does
    // not halt reprocessing, so idempotency has to hold at the fee insert.
    expect((await postEvent(buildCardFailed('pi_card_dupe_1'))).status).toBe(200)
    expect((await postEvent(buildCardFailed('pi_card_dupe_1'))).status).toBe(200)

    const fees = await db.query(
      `SELECT 1 FROM payments WHERE entry_description='DECLINEFEE'`
    )
    expect(fees.rows).toHaveLength(1)
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

  // S654: one email per thing. The tenant's retry / retries-exhausted email
  // was sent from inside the per-landlord-contact loop: two contacts sent the
  // tenant two identical emails, no contact sent none.
  describe('ACH retry notices: the tenant is told once, whatever the landlord contact count', () => {
    async function seedWithContacts(paymentIntentId: string, contacts: number, retryCount = 0) {
      const client = await getClient()
      try {
        const { userId: ownerUserId, landlordId } = await seedLandlord(client)
        const tenantId = await seedTenant(client)
        const propertyId = await seedProperty(client, { landlordId, ownerUserId, managedByUserId: ownerUserId })
        const unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: 1000 })
        // A PM company manages the property: its active staff are the
        // landlord-side contacts (0, 1 or many).
        const bankAccountId = await seedUserBankAccount(client, { userId: ownerUserId })
        const pmCompanyId = await seedPmCompany(client, { bankAccountId })
        await client.query(`UPDATE properties SET pm_company_id = $2 WHERE id = $1`, [propertyId, pmCompanyId])
        const staffEmails: string[] = []
        for (let i = 0; i < contacts; i++) {
          const email = `pm-staff-${i}-${paymentIntentId}@test.dev`
          const staffUserId = await seedManager(client, { email })
          await client.query(
            `INSERT INTO pm_staff (pm_company_id, user_id, role, status) VALUES ($1, $2, 'staff', 'active')`,
            [pmCompanyId, staffUserId])
          staffEmails.push(email)
        }
        const paymentId = await seedRentPayment(client, {
          unitId, tenantId, landlordId, amount: 1000, status: 'pending', stripePaymentIntentId: paymentIntentId,
        })
        if (retryCount) await client.query(`UPDATE payments SET retry_count = $2 WHERE id = $1`, [paymentId, retryCount])
        const tenantEmail = (await client.query<{ email: string }>(
          `SELECT u.email FROM tenants t JOIN users u ON u.id = t.user_id WHERE t.id = $1`, [tenantId])).rows[0].email
        return { tenantEmail, staffEmails }
      } finally { client.release() }
    }

    function emailsOfType(type: string): string[] {
      return vi.mocked(sendNotificationEmail).mock.calls
        .filter((c) => c[0].notificationType === type)
        .map((c) => c[0].to)
    }

    beforeEach(() => { vi.mocked(sendNotificationEmail).mockClear() })

    for (const contacts of [2, 0]) {
      it(`retry scheduled, ${contacts} landlord contacts → tenant gets exactly one email`, async () => {
        const pi = `pi_ach_once_retry_${contacts}`
        const { tenantEmail, staffEmails } = await seedWithContacts(pi, contacts)
        const res = await postEvent(buildPaymentIntentFailed({ paymentIntentId: pi, returnCode: 'R01' }))
        expect(res.status).toBe(200)

        expect(emailsOfType('ach_retry_scheduled')).toEqual([tenantEmail])
        expect(emailsOfType('ach_retry_scheduled_info').sort()).toEqual([...staffEmails].sort())
      })

      it(`retries exhausted, ${contacts} landlord contacts → tenant gets exactly one email`, async () => {
        const pi = `pi_ach_once_exhausted_${contacts}`
        const { tenantEmail, staffEmails } = await seedWithContacts(pi, contacts, 2)
        const res = await postEvent(buildPaymentIntentFailed({ paymentIntentId: pi, returnCode: 'R01' }))
        expect(res.status).toBe(200)

        expect(emailsOfType('ach_retries_exhausted')).toEqual([tenantEmail])
        expect(emailsOfType('ach_retries_exhausted_landlord').sort()).toEqual([...staffEmails].sort())
      })
    }
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

// ── S654: the payment-didn't-go-through email (item G) ─────────────────────
// Nic: the "Payment cannot be retried" email needs a Pay now button, it must be
// true for both reasons it is sent, and the bank's reason must be read by name
// (Stripe's 'insufficient_funds') as well as by R-code so retries actually happen.
describe('POST /webhooks/stripe — payment_intent.payment_failed: what the tenant is told', () => {
  async function seedPull(args: {
    paymentIntentId: string
    lines?: Array<{ type: 'rent' | 'utility' | 'fee' | 'deposit'; amount: number }>
    retryCount?: number
    timezone?: string
  }) {
    const client = await getClient()
    try {
      const { userId: ownerUserId, landlordId } = await seedLandlord(client)
      const tenantId = await seedTenant(client)
      const propertyId = await seedProperty(client, { landlordId, ownerUserId, managedByUserId: ownerUserId })
      if (args.timezone) await client.query(`UPDATE properties SET timezone = $2 WHERE id = $1`, [propertyId, args.timezone])
      const unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: 1000 })
      const ids: Record<string, string> = {}
      for (const line of args.lines ?? [{ type: 'rent', amount: 1000 }]) {
        const entry = line.type === 'rent' ? 'RENT' : line.type === 'utility' ? 'UTILITY'
          : line.type === 'deposit' ? 'DEPOSIT' : 'OTHERFEE'
        const r = await client.query<{ id: string }>(
          `INSERT INTO payments (unit_id, tenant_id, landlord_id, type, amount, status,
                                 entry_description, due_date, stripe_payment_intent_id, retry_count)
           VALUES ($1, $2, $3, $4, $5, 'processing', $6, CURRENT_DATE, $7, $8) RETURNING id`,
          [unitId, tenantId, landlordId, line.type, line.amount.toFixed(2), entry,
           args.paymentIntentId, args.retryCount ?? 0])
        ids[line.type] = r.rows[0].id
      }
      const t = (await client.query<{ email: string; user_id: string }>(
        `SELECT u.email, u.id AS user_id FROM tenants t JOIN users u ON u.id = t.user_id WHERE t.id = $1`,
        [tenantId])).rows[0]
      return { ids, tenantEmail: t.email, tenantUserId: t.user_id, propertyId }
    } finally { client.release() }
  }

  function failedEvent(pi: string, lpe: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
    return JSON.stringify({
      id: 'evt_' + pi, type: 'payment_intent.payment_failed',
      data: { object: { id: pi, metadata: {}, last_payment_error: lpe, ...extra } },
    })
  }
  const bankError = (code: string) => ({ code, payment_method: { type: 'us_bank_account' } })
  const post = (body: string) => request(buildApp())
    .post('/webhooks/stripe')
    .set('Content-Type', 'application/json')
    .set('stripe-signature', 't=1,v1=stub')
    .send(body)
  const mailOf = (type: string) => vi.mocked(sendNotificationEmail).mock.calls
    .map((c) => c[0] as any).filter((c) => c.notificationType === type)

  beforeEach(() => { vi.mocked(sendNotificationEmail).mockClear() })

  it('Stripe\'s named "insufficient_funds" schedules a retry (read as R01), not a final failure', async () => {
    const { ids } = await seedPull({ paymentIntentId: 'pi_named_nsf' })
    expect((await post(failedEvent('pi_named_nsf', bankError('insufficient_funds')))).status).toBe(200)
    const row = (await db.query<{ return_code: string; next_retry_at: string | null }>(
      `SELECT return_code, next_retry_at FROM payments WHERE id = $1`, [ids.rent])).rows[0]
    expect(row.return_code).toBe('R01')
    expect(row.next_retry_at).not.toBeNull()
    expect(mailOf('ach_retry_scheduled')).toHaveLength(1)
    expect(mailOf('ach_retries_exhausted')).toHaveLength(0)
  })

  it('the retry is set for the start of the property\'s day three days out — the day the email names', async () => {
    const tz = 'America/New_York'
    const { ids } = await seedPull({ paymentIntentId: 'pi_retry_day', timezone: tz })
    await post(failedEvent('pi_retry_day', bankError('insufficient_funds')))
    const row = (await db.query<{ local_day: string; local_time: string; want_day: string }>(
      `SELECT (next_retry_at AT TIME ZONE $2)::date::text AS local_day,
              (next_retry_at AT TIME ZONE $2)::time::text AS local_time,
              ((NOW() AT TIME ZONE $2)::date + 3)::text AS want_day
         FROM payments WHERE id = $1`, [ids.rent, tz])).rows[0]
    expect(row.local_day).toBe(row.want_day)
    expect(row.local_time).toBe('00:00:00')
    // The email names that same day.
    const [y, m, d] = row.want_day.split('-').map(Number)
    const label = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' })
      .format(new Date(Date.UTC(y, m - 1, d)))
    expect(mailOf('ach_retry_scheduled')[0].subject).toBe(`Payment retry scheduled — ${label}`)
  })

  it('a closed account on the FIRST try: final, "your bank turned down", with a Pay now button to the signed link', async () => {
    const { ids, tenantEmail } = await seedPull({ paymentIntentId: 'pi_named_closed' })
    await post(failedEvent('pi_named_closed', bankError('account_closed')))
    const row = (await db.query<{ return_code: string; next_retry_at: string | null }>(
      `SELECT return_code, next_retry_at FROM payments WHERE id = $1`, [ids.rent])).rows[0]
    expect(row).toMatchObject({ return_code: 'R02', next_retry_at: null })

    const mails = mailOf('ach_retries_exhausted')
    expect(mails.map((m) => m.to)).toEqual([tenantEmail])
    const html: string = mails[0].html
    expect(html).toContain('Your bank turned down your <b>$1000.00</b> payment')
    expect(html).toContain('because the account is closed')
    expect(html).not.toMatch(/multiple|NACHA|exhausted/i)
    expect(html).toMatch(/<a href="[^"]*\/login\?ef=[^"&]+&to=%2Fpayments" class="btn">Pay now<\/a>/)
  })

  it('retries used up (R01 on the last retry): says it tried 3 times, and still has the button', async () => {
    await seedPull({ paymentIntentId: 'pi_used_up', retryCount: 2 })
    await post(failedEvent('pi_used_up', bankError('insufficient_funds')))
    const html: string = mailOf('ach_retries_exhausted')[0].html
    expect(html).toContain('from your bank 3 times')
    expect(html).toContain('the last time because there was not enough money in the account')
    expect(html).toContain('>Pay now</a>')
  })

  it('a pull that covered several lines: every notice quotes the whole pull, not its first line', async () => {
    await seedPull({
      paymentIntentId: 'pi_multi_line', retryCount: 2,
      lines: [{ type: 'rent', amount: 495 }, { type: 'utility', amount: 25.20 }],
    })
    await post(failedEvent('pi_multi_line', bankError('insufficient_funds')))
    const html: string = mailOf('ach_retries_exhausted')[0].html
    expect(html).toContain('<b>$520.20</b>')
    expect(html).not.toContain('$495.00')
  })

  it('a pull that covered several lines: the retry notice quotes the whole pull too', async () => {
    await seedPull({
      paymentIntentId: 'pi_multi_retry',
      lines: [{ type: 'rent', amount: 495 }, { type: 'utility', amount: 25.20 }],
    })
    await post(failedEvent('pi_multi_retry', bankError('insufficient_funds')))
    expect(mailOf('ach_retry_scheduled')[0].html).toContain('<b>$520.20</b>')
    const rows = await db.query<{ next_retry_at: string | null }>(
      `SELECT next_retry_at FROM payments WHERE stripe_payment_intent_id = 'pi_multi_retry'`)
    expect(rows.rows).toHaveLength(2)
    expect(rows.rows.every((r) => r.next_retry_at !== null)).toBe(true)
  })

  it('the rent line speaks for the pull in the credit history, even when a fee line shares it', async () => {
    const { ids } = await seedPull({
      paymentIntentId: 'pi_anchor_rent',
      lines: [{ type: 'fee', amount: 6 }, { type: 'rent', amount: 495 }],
    })
    vi.mocked(emitPaymentFailedEvent).mockClear()
    await post(failedEvent('pi_anchor_rent', bankError('account_closed')))
    const calls = vi.mocked(emitPaymentFailedEvent).mock.calls
    expect(calls).toHaveLength(1)
    expect(calls[0][1].paymentId).toBe(ids.rent)
  })

  it('a FlexDeposit installment pull is not this notice\'s to tell — it has its own scheduled retry', async () => {
    await seedPull({ paymentIntentId: 'pi_fd_pull', lines: [{ type: 'deposit', amount: 150 }] })
    await post(failedEvent('pi_fd_pull', bankError('insufficient_funds'),
      { metadata: { gam_purpose: 'flexdeposit_installment' } }))
    expect(mailOf('ach_retries_exhausted')).toHaveLength(0)
    expect(mailOf('ach_retries_exhausted_landlord')).toHaveLength(0)
    expect(mailOf('ach_retry_scheduled')).toHaveLength(0)
  })

  // S654: the FlexDeposit handler sat inside the rent-only gate, and an
  // installment row is type 'deposit' — so it never ran.
  async function seedInstallmentPull(pi: string, attemptCount: number) {
    const { ids } = await seedPull({ paymentIntentId: pi, lines: [{ type: 'deposit', amount: 150 }] })
    const pay = (await db.query<{ unit_id: string; tenant_id: string; landlord_id: string }>(
      `SELECT unit_id, tenant_id, landlord_id FROM payments WHERE id = $1`, [ids.deposit])).rows[0]
    const client = await getClient()
    try {
      const leaseId = await seedLease(client, { unitId: pay.unit_id, landlordId: pay.landlord_id })
      const dep = (await client.query<{ id: string }>(
        `INSERT INTO security_deposits (unit_id, lease_id, tenant_id, total_amount, held_by)
         VALUES ($1, $2, $3, 600, 'gam_escrow') RETURNING id`,
        [pay.unit_id, leaseId, pay.tenant_id])).rows[0].id
      const inst = (await client.query<{ id: string }>(
        `INSERT INTO flex_deposit_installments
           (security_deposit_id, tenant_id, installment_number, installment_count, amount, due_date,
            payment_id, attempt_count)
         VALUES ($1, $2, 1, 4, 150, CURRENT_DATE, $3, $4) RETURNING id`,
        [dep, pay.tenant_id, ids.deposit, attemptCount])).rows[0].id
      return inst
    } finally { client.release() }
  }
  const installmentStatus = async (id: string) => (await db.query<{ status: string }>(
    `SELECT status FROM flex_deposit_installments WHERE id = $1`, [id])).rows[0].status

  it('a FlexDeposit installment whose retry pull also bounces is marked missed', async () => {
    const inst = await seedInstallmentPull('pi_fd_retry_bounce', 2)
    await post(failedEvent('pi_fd_retry_bounce', bankError('insufficient_funds'),
      { metadata: { gam_purpose: 'flexdeposit_installment' } }))
    expect(await installmentStatus(inst)).toBe('missed')
  })

  it('a FlexDeposit installment whose FIRST pull bounces waits for its scheduled retry', async () => {
    const inst = await seedInstallmentPull('pi_fd_first_bounce', 1)
    await post(failedEvent('pi_fd_first_bounce', bankError('insufficient_funds'),
      { metadata: { gam_purpose: 'flexdeposit_installment' } }))
    expect(await installmentStatus(inst)).toBe('pending')
  })

  // ── S654 (review): a retry in flight bounces again ──────────────────────
  // The retry cron marks a pull's rows 'processing' while the bank works on it.
  // A second bounce must put them back to owed, with the right notice.
  it('a first retry that bounces short of money again: owed, one more retry set, "this is the last retry"', async () => {
    const { ids } = await seedPull({ paymentIntentId: 'pi_retry1_bounce', retryCount: 1 })
    await post(failedEvent('pi_retry1_bounce', bankError('insufficient_funds')))
    const row = (await db.query<{ status: string; next_retry_at: string | null }>(
      `SELECT status, next_retry_at FROM payments WHERE id = $1`, [ids.rent])).rows[0]
    expect(row.status).toBe('failed')
    expect(row.next_retry_at).not.toBeNull()
    const html: string = mailOf('ach_retry_scheduled')[0].html
    expect(html).toContain('This is the last retry')
    expect(html).not.toContain('first of two')
  })

  it('a first bounce schedules the first of two retries — it never says "can\'t try again"', async () => {
    await seedPull({ paymentIntentId: 'pi_first_of_two' })
    await post(failedEvent('pi_first_of_two', bankError('insufficient_funds')))
    const html: string = mailOf('ach_retry_scheduled')[0].html
    expect(html).toContain('This is the first of two retries')
    expect(html).not.toContain('can\'t try your bank again')
  })

  it('a retry in flight that bounces on a closed account: owed, final, "your bank turned down"', async () => {
    const { ids } = await seedPull({ paymentIntentId: 'pi_retry_closed', retryCount: 1 })
    await post(failedEvent('pi_retry_closed', bankError('account_closed')))
    const row = (await db.query<{ status: string; next_retry_at: string | null }>(
      `SELECT status, next_retry_at FROM payments WHERE id = $1`, [ids.rent])).rows[0]
    expect(row).toMatchObject({ status: 'failed', next_retry_at: null })
    expect(mailOf('ach_retries_exhausted')[0].html).toContain('Your bank turned down')
  })

  // S654 (review): webhook events carry latest_charge as a bare id. When the
  // intent names no reason, the charge's failure_code is read.
  it('reads the reason from the charge when the event carries only its id', async () => {
    stripeMocks.chargesRetrieve.mockImplementationOnce(async (id: string) => ({ id, failure_code: 'insufficient_funds' }))
    const { ids } = await seedPull({ paymentIntentId: 'pi_bare_charge' })
    await post(failedEvent('pi_bare_charge', { payment_method: { type: 'us_bank_account' } },
      { latest_charge: 'ch_bare_1' }))
    expect(stripeMocks.chargesRetrieve).toHaveBeenCalledWith('ch_bare_1')
    const row = (await db.query<{ return_code: string | null; next_retry_at: string | null }>(
      `SELECT return_code, next_retry_at FROM payments WHERE id = $1`, [ids.rent])).rows[0]
    expect(row.return_code).toBe('R01')
    expect(row.next_retry_at).not.toBeNull()
  })

  // ── S654 (review): a bounced FlexDeposit pull still tells the TENANT ────
  it('FlexDeposit first bounce: the tenant alone is told, with the scheduled retry day', async () => {
    const inst = await seedInstallmentPull('pi_fd_tell_first', 1)
    await db.query(`UPDATE flex_deposit_installments SET retry_pull_date = CURRENT_DATE + 5 WHERE id = $1`, [inst])
    await post(failedEvent('pi_fd_tell_first', bankError('insufficient_funds'),
      { metadata: { gam_purpose: 'flexdeposit_installment' } }))
    const mails = mailOf('flexdeposit_payment_failed')
    expect(mails).toHaveLength(1)
    expect(mails[0].html).toContain('We\'ll try your bank again on <b>')
    expect(mails[0].html).toContain('because there was not enough money in the account')
    // Nobody on the landlord side hears about FlexDeposit.
    expect(mailOf('ach_retries_exhausted_landlord')).toHaveLength(0)
    expect(mailOf('ach_retry_scheduled_info')).toHaveLength(0)
  })

  it('FlexDeposit retry bounce: the tenant is told the installment was missed, with a button to the Lease page', async () => {
    await seedInstallmentPull('pi_fd_tell_missed', 2)
    await post(failedEvent('pi_fd_tell_missed', bankError('insufficient_funds'),
      { metadata: { gam_purpose: 'flexdeposit_installment' } }))
    const [mail] = mailOf('flexdeposit_payment_failed')
    expect(mail.subject).toBe('A deposit installment was missed')
    expect(mail.html).toMatch(/<a href="[^"]*\/login\?ef=[^"&]+&to=%2Flease" class="btn">Go to your lease<\/a>/)
  })

  it('a FlexDeposit pay-ahead that bounces: the tenant is told nothing else changes', async () => {
    await seedPull({ paymentIntentId: 'pi_fd_payahead', lines: [{ type: 'deposit', amount: 450 }] })
    await post(failedEvent('pi_fd_payahead', bankError('account_closed'),
      { metadata: { gam_purpose: 'flexdeposit_payahead' } }))
    const [mail] = mailOf('flexdeposit_payment_failed')
    expect(mail.html).toContain('<b>$450.00</b> payment toward your deposit didn\'t go through because the account is closed')
    expect(mailOf('ach_retries_exhausted')).toHaveLength(0)
  })

  it('a declined card says the card was declined, not "your bank"', async () => {
    await seedPull({ paymentIntentId: 'pi_card_final' })
    await post(failedEvent('pi_card_final',
      { code: 'card_declined', decline_code: 'insufficient_funds', payment_method: { type: 'card' } },
      { payment_method_types: ['card'] }))
    const html: string = mailOf('ach_retries_exhausted')[0].html
    expect(html).toContain('Your card was declined')
    expect(html).not.toContain('Your bank')
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
    // Decisions #55-AMENDED: the win raises its one notice; nothing was reversed, so nothing to undo.
    const told = await db.query<{ severity: string; title: string }>(
      `SELECT severity, title FROM admin_notifications WHERE category = 'dispute_won_undo_by_hand'`)
    expect(told.rows).toEqual([{ severity: 'critical', title: 'A dispute was won: nothing to undo (pi_unknown_dispute)' }])
  })

  /** A settled $1,000 rent row paid by `pi`, for the escalation and the win below. */
  async function settledRent(pi: string): Promise<string> {
    const client = await getClient()
    try {
      const { userId: ownerUserId, landlordId } = await seedLandlord(client)
      const tenantId = await seedTenant(client)
      const propertyId = await seedProperty(client, { landlordId, ownerUserId, managedByUserId: ownerUserId })
      const unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: 1000 })
      return await seedRentPayment(client, { unitId, tenantId, landlordId, amount: 1000, status: 'settled', stripePaymentIntentId: pi })
    } finally { client.release() }
  }
  const postDispute = (o: { type: DisputeEventOpts['type'] | 'charge.dispute.funds_withdrawn' | 'charge.dispute.funds_reinstated'; status: string; eventId: string; pi: string }) =>
    request(buildApp()).post('/webhooks/stripe')
      .set('Content-Type', 'application/json').set('stripe-signature', 't=1,v1=stub')
      .send(JSON.stringify({
        id: o.eventId, type: o.type,
        data: { object: { id: 'dp_' + o.pi, object: 'dispute', charge: 'ch_' + o.pi, payment_intent: o.pi, amount: 100_000,
          currency: 'usd', reason: 'fraudulent', status: o.status } },
      }))
  const recordsFor = async (pi: string) => (await db.query<{ stripe_event_id: string }>(
    `SELECT pr.stripe_event_id FROM payment_reversals pr JOIN payments p ON p.id = pr.payment_id
      WHERE p.stripe_payment_intent_id = $1 ORDER BY pr.created_at`, [pi])).rows.map(r => r.stripe_event_id)

  it('an inquiry that escalates through charge.dispute.updated reverses exactly once through the real route, whatever events follow', async () => {
    const rent = await settledRent('pi_escalate')
    expect((await postDispute({ type: 'charge.dispute.created', status: 'warning_needs_response', eventId: 'evt_esc_0', pi: 'pi_escalate' })).status).toBe(200)
    expect(await recordsFor('pi_escalate')).toEqual([])
    expect((await db.query<{ status: string }>(`SELECT status FROM payments WHERE id = $1`, [rent])).rows[0].status).toBe('settled')
    expect((await postDispute({ type: 'charge.dispute.updated', status: 'needs_response', eventId: 'evt_esc_1', pi: 'pi_escalate' })).status).toBe(200)
    expect(await recordsFor('pi_escalate')).toEqual(['evt_esc_1'])
    expect((await db.query<{ status: string }>(`SELECT status FROM payments WHERE id = $1`, [rent])).rows[0].status).toBe('returned')
    for (const [type, status, eventId] of [
      ['charge.dispute.funds_withdrawn', 'needs_response', 'evt_esc_2'],
      ['charge.dispute.updated', 'under_review', 'evt_esc_3'],
      ['charge.dispute.closed', 'lost', 'evt_esc_4'],
    ] as const) {
      expect((await postDispute({ type, status, eventId, pi: 'pi_escalate' })).status).toBe(200)
    }
    expect(await recordsFor('pi_escalate')).toEqual(['evt_esc_1'])
    expect((await db.query(`SELECT 1 FROM payments WHERE reversal_id IS NOT NULL`)).rowCount).toBe(1)
    expect((await db.query(`SELECT 1 FROM payments WHERE entry_description = 'RETURNFEE'`)).rowCount).toBe(1)
  })

  it('a won dispute through the real route undoes nothing by itself and raises ONE critical notice listing what to undo by hand, with amounts', async () => {
    const rent = await settledRent('pi_won_route')
    expect((await postDispute({ type: 'charge.dispute.created', status: 'needs_response', eventId: 'evt_wr_0', pi: 'pi_won_route' })).status).toBe(200)
    const reopened = (await db.query<{ id: string }>(`SELECT id FROM payments WHERE reversal_id IS NOT NULL`)).rows[0].id
    expect((await postDispute({ type: 'charge.dispute.closed', status: 'won', eventId: 'evt_wr_1', pi: 'pi_won_route' })).status).toBe(200)
    expect((await postDispute({ type: 'charge.dispute.funds_reinstated', status: 'won', eventId: 'evt_wr_2', pi: 'pi_won_route' })).status).toBe(200)
    // Nothing undone by itself.
    expect((await db.query<{ id: string; status: string }>(
      `SELECT id, status FROM payments WHERE id = ANY($1::uuid[]) ORDER BY status`, [[rent, reopened]])).rows)
      .toEqual([{ id: reopened, status: 'pending' }, { id: rent, status: 'returned' }])
    expect((await db.query(`SELECT 1 FROM held_payout_items WHERE source_id LIKE '%returned\\_on\\_win%'`)).rowCount).toBe(0)
    // One notice, the steps with their amounts.
    const told = (await db.query<{ severity: string; title: string; body: string }>(
      `SELECT severity, title, body FROM admin_notifications WHERE category = 'dispute_won_undo_by_hand'`)).rows
    expect(told).toHaveLength(1)
    expect(told[0].severity).toBe('critical')
    expect(told[0].title).toMatch(/^A dispute was won: undo \d+ things by hand \(pi_won_route\)$/)
    expect(told[0].body).toContain(`Void the reopened rent charge of $1000.00 (line ${reopened}): Test Tenant no longer owes it.`)
    expect(told[0].body).toContain(`Mark the disputed rent line paid again (line ${rent}, $1000.00 of it was taken back).`)
    // The won event said nothing of Stripe's fee: the notice says to check, never that it was kept.
    expect(told[0].body).toMatch(/Check in Stripe whether it gave its dispute fee back with the win\. If it did, take the \$15\.00 dispute fee billed to Test Tenant \(line [0-9a-f-]+\) off; if not, it stays\./)
    expect(told[0].body).toContain('GAM absorbs none of it.')
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
      paymentId = await seedClaimedUtility(client, {
        unitId, tenantId, landlordId, leaseId,
        amount: 80,
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

// ── S570: setup_intent.succeeded — microdeposit ACH verification completes ──
function buildSetupIntentSucceeded(metadata: Record<string, string>, opts: { customer?: string; paymentMethod?: string } = {}): string {
  return JSON.stringify({
    id: 'evt_si_' + (metadata.tenantId ?? metadata.gam_pos_customer_id ?? 'x'),
    type: 'setup_intent.succeeded',
    data: {
      object: {
        id: 'seti_' + (metadata.tenantId ?? metadata.gam_pos_customer_id ?? 'x'),
        object: 'setup_intent',
        customer: opts.customer ?? 'cus_mock',
        payment_method: opts.paymentMethod ?? 'pm_mock',
        metadata,
      },
    },
  })
}

describe('POST /webhooks/stripe — setup_intent.succeeded (S570 microdeposit verify)', () => {
  it('tenant path: flips ach_verified TRUE + stamps bank + logs first_sender (idempotent)', async () => {
    const client = await getClient()
    let tenantId: string
    try {
      tenantId = await seedTenant(client)
      await client.query(`UPDATE tenants SET ach_verified=FALSE, stripe_customer_id='cus_tenant_md' WHERE id=$1`, [tenantId])
    } finally { client.release() }
    // S655: the bank must be on the tenant's own customer to be recorded.
    stripeMocks.state.pms.set('pm_mock', stripeMocks.bankPm('pm_mock', 'cus_tenant_md'))

    const app = buildApp()
    const send = () => request(app).post('/webhooks/stripe')
      .set('Content-Type', 'application/json').set('stripe-signature', 't=1,v1=stub')
      .send(buildSetupIntentSucceeded({ tenantId: tenantId! }, { customer: 'cus_tenant_md' }))

    expect((await send()).status).toBe(200)
    const t = await db.query<any>(`SELECT ach_verified, bank_last4 FROM tenants WHERE id=$1`, [tenantId!])
    expect(t.rows[0].ach_verified).toBe(true)
    expect(t.rows[0].bank_last4).toBe('6789')
    let log = await db.query<any>(`SELECT count(*)::int AS n FROM ach_monitoring_log WHERE tenant_id=$1 AND event_type='first_sender'`, [tenantId!])
    expect(log.rows[0].n).toBe(1)

    // Re-delivery is idempotent: no second first_sender row.
    expect((await send()).status).toBe(200)
    log = await db.query<any>(`SELECT count(*)::int AS n FROM ach_monitoring_log WHERE tenant_id=$1 AND event_type='first_sender'`, [tenantId!])
    expect(log.rows[0].n).toBe(1)
  })

  it('POS path: flips pos_customers.ach_verified TRUE + marks invitation accepted', async () => {
    const client = await getClient()
    let posCustId: string, invId: string
    try {
      const { landlordId } = await seedLandlord(client)
      const pc = await client.query(
        `INSERT INTO pos_customers (landlord_id, first_name, last_name, email, ach_verified)
         VALUES ($1,'Pat','Poser','pat@poser.dev',FALSE) RETURNING id`, [landlordId])
      posCustId = pc.rows[0].id
      const iv = await client.query(
        `INSERT INTO pos_customer_invitations (pos_customer_id, landlord_id, token, status, setup_intent_id, expires_at)
         VALUES ($1,$2,'tok_md','in_progress','seti_pos', NOW() + interval '7 days') RETURNING id`,
        [posCustId, landlordId])
      invId = iv.rows[0].id
    } finally { client.release() }

    const app = buildApp()
    const res = await request(app).post('/webhooks/stripe')
      .set('Content-Type', 'application/json').set('stripe-signature', 't=1,v1=stub')
      .send(buildSetupIntentSucceeded(
        { gam_purpose: 'pos_customer_ach_onboarding', gam_pos_customer_id: posCustId!, gam_invitation_id: invId! },
        { customer: 'cus_pos_md' }))
    expect(res.status).toBe(200)
    const pc = await db.query<any>(`SELECT ach_verified, bank_last4 FROM pos_customers WHERE id=$1`, [posCustId!])
    expect(pc.rows[0].ach_verified).toBe(true)
    expect(pc.rows[0].bank_last4).toBe('6789')
    const iv = await db.query<any>(`SELECT status FROM pos_customer_invitations WHERE id=$1`, [invId!])
    expect(iv.rows[0].status).toBe('accepted')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// S655 (money plan Step 10): the success / failure / cancel webhooks on the
// credit ledger. Every fixture is the shape services/rentCharge writes: rows
// pending → credit held on the receipt → rows claimed 'processing' with the
// intent → the receipt carries the intent.
// ═══════════════════════════════════════════════════════════════════════════

import { createPaidAhead, holdCredit } from '../services/creditUse'

interface S655Household {
  landlordId: string; landlordUserId: string; tenantId: string; tenantUserId: string
  propertyId: string; unitId: string; leaseId: string
}

async function s655Household(rent = 1000): Promise<S655Household> {
  const c = await getClient()
  try {
    const { userId: landlordUserId, landlordId } = await seedLandlord(c)
    const tenantId = await seedTenant(c)
    const tenantUserId = (await c.query<{ user_id: string }>(`SELECT user_id FROM tenants WHERE id = $1`, [tenantId])).rows[0].user_id
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: landlordUserId, managedByUserId: landlordUserId })
    const unitId = await seedUnit(c, { propertyId, landlordId, rentAmount: rent })
    await seedAllocationRule(c, { propertyId, achFeePayer: 'tenant', cardFeePayer: 'tenant' })
    const leaseId = await seedLease(c, { unitId, landlordId, rentAmount: rent })
    await seedLeaseTenant(c, { leaseId, tenantId })
    return { landlordId, landlordUserId, tenantId, tenantUserId, propertyId, unitId, leaseId }
  } finally { c.release() }
}

async function s655Row(h: S655Household, o: {
  amount: number; type?: string; entry?: string; owner?: string; status?: string; due?: string; pi?: string | null
}): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, entry_description,
                           due_date, revenue_owner, stripe_payment_intent_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::date,$10,$11) RETURNING id`,
    [h.unitId, h.leaseId, h.tenantId, h.landlordId, o.type ?? 'rent', o.amount, o.status ?? 'pending',
     o.entry ?? (o.type === 'utility' ? 'UTILITY' : 'RENT'), o.due ?? '2026-10-01', o.owner ?? 'landlord', o.pi ?? null])
  return r.rows[0].id
}

async function s655Remittance(h: S655Household, o: { amount: number; unapplied?: number; method?: 'ach' | 'card'; fee?: number; pi?: string | null }): Promise<string> {
  const fee = o.fee ?? (o.method === 'card' ? 0 : 6)
  const r = await db.query<{ id: string }>(
    `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, unapplied_amount,
                                     payment_method, gross_amount, processing_fee_amount, stripe_payment_intent_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [h.tenantId, h.leaseId, h.landlordId, o.amount, o.amount - (o.unapplied ?? 0), o.unapplied ?? 0,
     o.method ?? 'ach', o.amount + fee, fee, o.pi ?? null])
  return r.rows[0].id
}

async function s655PaidAhead(h: S655Household, amount: number, fundedBy: 'landlord' | 'gam' = 'landlord'): Promise<string> {
  const c = await getClient()
  try {
    return await createPaidAhead(c as any, { leaseId: h.leaseId, tenantId: h.tenantId, amount, fundedBy, receivedAt: new Date('2026-09-01T12:00:00Z') })
  } finally { c.release() }
}

/** Set credit aside on the receipt (rows still pending, no intent), as rentCharge does before it claims them. */
async function s655Hold(h: S655Household, creditId: string, paymentId: string, remittanceId: string, amount: number): Promise<void> {
  const c = await getClient()
  try {
    await c.query('BEGIN')
    await holdCredit(c as any, [{ creditKind: 'paid_ahead', creditId, paymentId, leaseId: h.leaseId, amount, billingMonth: '2026-10-01' }],
      { remittanceId, source: 'portal' })
    await c.query('COMMIT')
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

/** Claim the rows for the charge and stamp the intent on them and the receipt. */
async function s655Claim(rowIds: string[], remittanceId: string | null, pi: string): Promise<void> {
  await db.query(
    `UPDATE payments SET status = 'processing', platform_held = TRUE, stripe_payment_intent_id = $2 WHERE id = ANY($1::uuid[])`,
    [rowIds, pi])
  if (remittanceId) await db.query(`UPDATE tenant_remittances SET stripe_payment_intent_id = $2 WHERE id = $1`, [remittanceId, pi])
}

function s655Succeeded(pi: string, o: { metadata?: Record<string, string>; method?: 'us_bank_account' | 'card'; amountReceived?: number; eventId?: string } = {}): string {
  return JSON.stringify({
    id: o.eventId ?? 'evt_ok_' + pi,
    type: 'payment_intent.succeeded',
    data: { object: {
      id: pi, metadata: o.metadata ?? {}, amount_received: o.amountReceived,
      payment_method_types: [o.method ?? 'us_bank_account'],
      latest_charge: { id: 'ch_' + pi, payment_method_details: { type: o.method ?? 'us_bank_account' } },
    } },
  })
}

function s655Failed(pi: string, code: string | null, o: { eventId?: string; metadata?: Record<string, string> } = {}): string {
  return JSON.stringify({
    id: o.eventId ?? 'evt_fail_' + pi + '_' + (code ?? 'none'),
    type: 'payment_intent.payment_failed',
    data: { object: {
      id: pi, metadata: o.metadata ?? {}, payment_method_types: ['us_bank_account'],
      last_payment_error: code ? { payment_method_details: { us_bank_account: { return_details: { code } } } } : {},
    } },
  })
}

function s655Canceled(pi: string): string {
  return JSON.stringify({ id: 'evt_cancel_' + pi, type: 'payment_intent.canceled', data: { object: { id: pi, metadata: {} } } })
}

async function s655Post(body: string) {
  return request(buildApp()).post('/webhooks/stripe').set('Content-Type', 'application/json').set('stripe-signature', 't=1,v1=stub').send(body)
}

describe('S655 Step 10 — payment_intent.succeeded on the credit ledger', () => {
  it('success applies the remittance\'s held credit in the same transaction as the settle', async () => {
    const h = await s655Household()
    const rent = await s655Row(h, { amount: 1000 })
    const credit = await s655PaidAhead(h, 100, 'landlord')
    const rem = await s655Remittance(h, { amount: 900 })
    await s655Hold(h, credit, rent, rem, 100)
    await s655Claim([rent], rem, 'pi_s655_held')

    const res = await s655Post(s655Succeeded('pi_s655_held', { metadata: { gam_remittance_id: rem } }))
    expect(res.status).toBe(200)

    const use = await db.query<any>(`SELECT status, applied_at FROM credit_uses WHERE remittance_id = $1`, [rem])
    expect(use.rows).toHaveLength(1)
    expect(use.rows[0].status).toBe('applied')
    expect((await db.query<any>(`SELECT status FROM payments WHERE id = $1`, [rent])).rows[0].status).toBe('settled')
    expect((await db.query<any>(`SELECT amount_remaining::float AS r FROM lease_prepaid_credits WHERE id = $1`, [credit])).rows[0].r).toBe(0)
    // The owner share is the money part only: the landlord already holds the $100 check money.
    const money = await db.query<any>(`SELECT money_part::float AS m, gam_held_part::float AS g FROM v_payment_money WHERE payment_id = $1`, [rent])
    expect(money.rows[0]).toEqual({ m: 900, g: 900 })
    const share = await db.query<any>(`SELECT amount::float AS a FROM user_balance_ledger WHERE reference_id = $1 AND type = 'allocation_owner_share'`, [rent])
    expect(share.rows).toEqual([{ a: 900 }])
    const r = await db.query<any>(`SELECT status, applied_amount::float AS a, unapplied_amount::float AS u FROM tenant_remittances WHERE id = $1`, [rem])
    expect(r.rows[0]).toEqual({ status: 'settled', a: 900, u: 0 })
    // Nothing over the bill: no paid-ahead money was made.
    expect((await db.query(`SELECT 1 FROM lease_prepaid_credits WHERE source_remittance_id = $1`, [rem])).rowCount).toBe(0)
  })

  it('a row credit the landlord holds paid whole is not platform-held and books no owner share (I8)', async () => {
    const h = await s655Household()
    const rent = await s655Row(h, { amount: 1000 })
    const water = await s655Row(h, { amount: 50, type: 'utility' })
    const credit = await s655PaidAhead(h, 50, 'landlord')
    const rem = await s655Remittance(h, { amount: 1000 })
    await s655Hold(h, credit, water, rem, 50)
    await s655Claim([rent, water], rem, 'pi_s655_i8')

    expect((await s655Post(s655Succeeded('pi_s655_i8', { metadata: { gam_remittance_id: rem } }))).status).toBe(200)
    const rows = await db.query<any>(`SELECT id, status, platform_held FROM payments WHERE id = ANY($1::uuid[]) ORDER BY amount`, [[rent, water]])
    expect(rows.rows.map((r: any) => [r.status, r.platform_held])).toEqual([['settled', false], ['settled', true]])
    expect((await db.query(`SELECT 1 FROM user_balance_ledger WHERE reference_id = $1`, [water])).rowCount).toBe(0)
  })

  it('a redelivered success changes nothing and never re-settles a returned row', async () => {
    const h = await s655Household()
    const rent = await s655Row(h, { amount: 1000 })
    const rem = await s655Remittance(h, { amount: 1000 })
    await s655Claim([rent], rem, 'pi_s655_redeliver')
    const body = s655Succeeded('pi_s655_redeliver', { metadata: { gam_remittance_id: rem } })
    expect((await s655Post(body)).status).toBe(200)
    // A dispute reopened it meanwhile.
    await db.query(`UPDATE payments SET status = 'returned' WHERE id = $1`, [rent])
    expect((await s655Post(body)).status).toBe(200)
    expect((await db.query<any>(`SELECT status FROM payments WHERE id = $1`, [rent])).rows[0].status).toBe('returned')
    const ledger = await db.query(`SELECT 1 FROM user_balance_ledger WHERE reference_id = $1`, [rent])
    expect(ledger.rowCount).toBe(1)
    expect((await db.query(`SELECT 1 FROM lease_prepaid_credits WHERE source_remittance_id = $1`, [rem])).rowCount).toBe(0)
  })

  it('the surplus becomes GAM-held paid-ahead money received now', async () => {
    const h = await s655Household()
    const rent = await s655Row(h, { amount: 1000 })
    const rem = await s655Remittance(h, { amount: 1200, unapplied: 200 })
    await s655Claim([rent], rem, 'pi_s655_surplus')
    const before = Date.now()
    expect((await s655Post(s655Succeeded('pi_s655_surplus', { metadata: { gam_remittance_id: rem } }))).status).toBe(200)
    const pc = await db.query<any>(
      `SELECT amount_original::float AS a, amount_remaining::float AS r, funded_by, received_at, lease_id
         FROM lease_prepaid_credits WHERE source_remittance_id = $1`, [rem])
    expect(pc.rows).toHaveLength(1)
    expect(pc.rows[0]).toMatchObject({ a: 200, r: 200, funded_by: 'gam', lease_id: h.leaseId })
    expect(new Date(pc.rows[0].received_at).getTime()).toBeGreaterThanOrEqual(before - 1000)
    // A planned over-payment is not news to GAM.
    expect((await db.query(`SELECT 1 FROM admin_notifications WHERE category = 'stripe_surplus_banked'`)).rowCount).toBe(0)
  })

  it('a success whose rows were settled elsewhere banks the money and alerts', async () => {
    const h = await s655Household()
    const rent = await s655Row(h, { amount: 1000 })
    const rem = await s655Remittance(h, { amount: 1000 })
    // The receipt's planned line, as rentCharge writes it with the charge.
    await db.query(`INSERT INTO remittance_applications (remittance_id, payment_id, amount_applied) VALUES ($1, $2, 1000)`, [rem, rent])
    await s655Claim([rent], rem, 'pi_s655_elsewhere')
    // Paid at the desk while the bank payment was clearing (an edge the lock
    // normally prevents): the row is no longer waiting on this charge. The
    // desk wrote its own receipt and line for it.
    await db.query(`UPDATE payments SET status = 'settled', settled_at = NOW(), manual_method = 'cash' WHERE id = $1`, [rent])
    const desk = (await db.query<{ id: string }>(
      `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, unapplied_amount, payment_method, status, settled_at)
       VALUES ($1,$2,$3,1000,1000,0,'cash','settled',NOW()) RETURNING id`, [h.tenantId, h.leaseId, h.landlordId])).rows[0].id
    await db.query(`INSERT INTO remittance_applications (remittance_id, payment_id, amount_applied) VALUES ($1, $2, 1000)`, [desk, rent])
    expect((await s655Post(s655Succeeded('pi_s655_elsewhere', { metadata: { gam_remittance_id: rem } }))).status).toBe(200)
    // The bill is paid once: only the desk's receipt carries it as a line; the
    // bank payment's money is all paid-ahead credit, never a second line.
    const lines = await db.query<any>(`SELECT remittance_id FROM remittance_applications WHERE payment_id = $1`, [rent])
    expect(lines.rows).toEqual([{ remittance_id: desk }])
    const pc = await db.query<any>(`SELECT amount_original::float AS a, funded_by FROM lease_prepaid_credits WHERE source_remittance_id = $1`, [rem])
    expect(pc.rows).toEqual([{ a: 1000, funded_by: 'gam' }])
    const r = await db.query<any>(`SELECT status, applied_amount::float AS a, unapplied_amount::float AS u FROM tenant_remittances WHERE id = $1`, [rem])
    expect(r.rows[0]).toEqual({ status: 'settled', a: 0, u: 1000 })
    expect((await db.query(`SELECT 1 FROM admin_notifications WHERE category = 'stripe_surplus_banked'`)).rowCount).toBe(1)
    // The desk-settled row is untouched: no Stripe owner share on it.
    expect((await db.query(`SELECT 1 FROM user_balance_ledger WHERE reference_id = $1`, [rent])).rowCount).toBe(0)
  })

  it('a success that paid one of its two lines keeps only that line on its receipt and banks the rest', async () => {
    const h = await s655Household()
    const rent = await s655Row(h, { amount: 1000 })
    const water = await s655Row(h, { amount: 40, type: 'utility' })
    const rem = await s655Remittance(h, { amount: 1040 })
    await db.query(
      `INSERT INTO remittance_applications (remittance_id, payment_id, amount_applied) VALUES ($1, $2, 1000), ($1, $3, 40)`,
      [rem, rent, water])
    await s655Claim([rent, water], rem, 'pi_s655_half')
    // The water was paid at the desk meanwhile.
    await db.query(`UPDATE payments SET status = 'settled', settled_at = NOW(), manual_method = 'cash' WHERE id = $1`, [water])
    expect((await s655Post(s655Succeeded('pi_s655_half', { metadata: { gam_remittance_id: rem } }))).status).toBe(200)
    const lines = await db.query<any>(
      `SELECT payment_id, amount_applied::float AS a FROM remittance_applications WHERE remittance_id = $1`, [rem])
    expect(lines.rows).toEqual([{ payment_id: rent, a: 1000 }])
    const r = await db.query<any>(`SELECT applied_amount::float AS a, unapplied_amount::float AS u FROM tenant_remittances WHERE id = $1`, [rem])
    expect(r.rows[0]).toEqual({ a: 1000, u: 40 })
    const pc = await db.query<any>(`SELECT amount_original::float AS a FROM lease_prepaid_credits WHERE source_remittance_id = $1`, [rem])
    expect(pc.rows).toEqual([{ a: 40 }])
  })

  it('a success whose remittance never committed rebuilds it from the intent and banks the money', async () => {
    const h = await s655Household()
    const remId = '0b7d0d2e-5d7c-4f7a-9d2f-1a2b3c4d5e6f'
    // $1,000 by bank with the tenant's flat $6 fee on top.
    const body = s655Succeeded('pi_s655_orphan', {
      amountReceived: 100600,
      metadata: { gam_remittance_id: remId, tenant_id: h.tenantId, landlord_id: h.landlordId, gam_lease_id: h.leaseId, gam_charge_source: 'portal' },
    })
    expect((await s655Post(body)).status).toBe(200)
    const r = await db.query<any>(
      `SELECT id, status, amount::float AS a, gross_amount::float AS g, processing_fee_amount::float AS f, stripe_payment_intent_id AS pi
         FROM tenant_remittances WHERE id = $1`, [remId])
    expect(r.rows[0]).toEqual({ id: remId, status: 'settled', a: 1000, g: 1006, f: 6, pi: 'pi_s655_orphan' })
    const pc = await db.query<any>(`SELECT amount_original::float AS a, funded_by FROM lease_prepaid_credits WHERE source_remittance_id = $1`, [remId])
    expect(pc.rows).toEqual([{ a: 1000, funded_by: 'gam' }])
    expect((await db.query(`SELECT 1 FROM admin_notifications WHERE category = 'stripe_surplus_banked'`)).rowCount).toBe(1)
    // A receipt that never committed never had lines (rentCharge writes them in
    // the same transaction): the rebuilt one carries none — its money is all
    // paid-ahead credit.
    expect((await db.query(`SELECT 1 FROM remittance_applications WHERE remittance_id = $1`, [remId])).rowCount).toBe(0)
    // Redelivered: still one receipt, one credit.
    expect((await s655Post(body)).status).toBe(200)
    expect((await db.query(`SELECT 1 FROM lease_prepaid_credits WHERE source_remittance_id = $1`, [remId])).rowCount).toBe(1)
  })

  it('remittances created before deploy (no held uses) settle normally', async () => {
    const h = await s655Household()
    const rent = await s655Row(h, { amount: 1000 })
    const water = await s655Row(h, { amount: 40, type: 'utility' })
    const rem = await s655Remittance(h, { amount: 1040 })
    await s655Claim([rent, water], rem, 'pi_s655_predeploy')
    expect((await s655Post(s655Succeeded('pi_s655_predeploy', { metadata: { gam_remittance_id: rem } }))).status).toBe(200)
    const rows = await db.query<any>(`SELECT status FROM payments WHERE id = ANY($1::uuid[])`, [[rent, water]])
    expect(rows.rows.every((r: any) => r.status === 'settled')).toBe(true)
    const shares = await db.query<any>(`SELECT SUM(amount)::float AS s FROM user_balance_ledger WHERE reference_id = ANY($1::uuid[]) AND type = 'allocation_owner_share'`, [[rent, water]])
    expect(shares.rows[0].s).toBe(1040)
    expect((await db.query<any>(`SELECT status FROM tenant_remittances WHERE id = $1`, [rem])).rows[0].status).toBe('settled')
  })
})

describe('Step 10 review — the Rent Collected notice names every line (decisions #17)', () => {
  it('a water line reads "Water" and a late fee "Late fee" in the landlord\'s breakdown, never a raw type', async () => {
    const h = await s655Household()
    const rent = await s655Row(h, { amount: 1000 })
    const water = await s655Row(h, { amount: 60, type: 'utility' })
    const late = await s655Row(h, { amount: 25, type: 'late_fee', entry: 'LATEFEE' })
    const c = await getClient()
    try {
      const meterId = await seedUtilityMeter(c, { propertyId: h.propertyId, utilityType: 'water' })
      await seedUtilityBill(c, { meterId, unitId: h.unitId, tenantId: h.tenantId, leaseId: h.leaseId, landlordId: h.landlordId,
                                 chargeAmount: 60, paymentId: water, status: 'billed', utilityType: 'water' } as any)
    } finally { c.release() }
    const rem = await s655Remittance(h, { amount: 1085 })
    await s655Claim([rent, water, late], rem, 'pi_s655_named')
    expect((await s655Post(s655Succeeded('pi_s655_named', { metadata: { gam_remittance_id: rem } }))).status).toBe(200)
    const n = (await db.query<any>(`SELECT data FROM notifications WHERE type = 'rent_collected' AND user_id = $1`, [h.landlordUserId])).rows
    expect(n).toHaveLength(1)
    const labels = (n[0].data.breakdown as Array<{ label: string; amount: number }>).map(b => [b.label, b.amount])
    expect(labels).toEqual(expect.arrayContaining([['Rent', 1000], ['Water', 60], ['Late fee', 25]]))
    for (const [label] of labels) expect(label).not.toMatch(/^(utility|late_fee|fee)$/)
  })
})

describe('S655 Step 10 — payment_intent.payment_failed and .canceled on the credit ledger', () => {
  it('a retryable failure keeps the credit held; a final failure releases it', async () => {
    const h = await s655Household()
    const rent = await s655Row(h, { amount: 1000 })
    const credit = await s655PaidAhead(h, 100)
    const rem = await s655Remittance(h, { amount: 900 })
    await s655Hold(h, credit, rent, rem, 100)
    await s655Claim([rent], rem, 'pi_s655_bounce')

    expect((await s655Post(s655Failed('pi_s655_bounce', 'R01'))).status).toBe(200)
    let row = (await db.query<any>(`SELECT status, next_retry_at FROM payments WHERE id = $1`, [rent])).rows[0]
    expect(row.status).toBe('failed')
    expect(row.next_retry_at).not.toBeNull()
    expect((await db.query<any>(`SELECT status FROM credit_uses WHERE remittance_id = $1`, [rem])).rows[0].status).toBe('held')
    expect((await db.query<any>(`SELECT status FROM tenant_remittances WHERE id = $1`, [rem])).rows[0].status).toBe('processing')

    // The retry fires (the cron claims the rows), and the bank closes the account.
    await db.query(`UPDATE payments SET status = 'processing', retry_count = 1, next_retry_at = NULL WHERE id = $1`, [rent])
    expect((await s655Post(s655Failed('pi_s655_bounce', 'R02'))).status).toBe(200)
    row = (await db.query<any>(`SELECT status, next_retry_at FROM payments WHERE id = $1`, [rent])).rows[0]
    expect(row).toEqual({ status: 'failed', next_retry_at: null })
    const use = (await db.query<any>(`SELECT status, release_reason FROM credit_uses WHERE remittance_id = $1`, [rem])).rows[0]
    expect(use).toEqual({ status: 'released', release_reason: 'payment_failed' })
    expect((await db.query<any>(`SELECT amount_remaining::float AS r FROM lease_prepaid_credits WHERE id = $1`, [credit])).rows[0].r).toBe(100)
    expect((await db.query<any>(`SELECT status FROM tenant_remittances WHERE id = $1`, [rem])).rows[0].status).toBe('failed')
  })

  it('a redelivered failure never reopens a desk-settled row', async () => {
    const h = await s655Household()
    const rent = await s655Row(h, { amount: 1000 })
    const rem = await s655Remittance(h, { amount: 1000 })
    await s655Claim([rent], rem, 'pi_s655_desk')
    const body = s655Failed('pi_s655_desk', 'R01')
    expect((await s655Post(body)).status).toBe(200)
    // The tenant pays cash at the desk; the bank's failure is delivered again.
    await db.query(`UPDATE payments SET status = 'settled', settled_at = NOW(), manual_method = 'cash', next_retry_at = NULL WHERE id = $1`, [rent])
    vi.mocked(sendNotificationEmail).mockClear()
    expect((await s655Post(body)).status).toBe(200)
    expect((await db.query<any>(`SELECT status FROM payments WHERE id = $1`, [rent])).rows[0].status).toBe('settled')
    // Nothing moved, so nobody is told again.
    expect(vi.mocked(sendNotificationEmail)).not.toHaveBeenCalled()
  })

  it('a redelivered retryable failure does not move the retry day or notify twice', async () => {
    const h = await s655Household()
    const rent = await s655Row(h, { amount: 1000 })
    await s655Claim([rent], null, 'pi_s655_twice')
    const body = s655Failed('pi_s655_twice', 'R01')
    expect((await s655Post(body)).status).toBe(200)
    await db.query(`UPDATE payments SET next_retry_at = '2030-01-01T00:00:00Z' WHERE id = $1`, [rent])
    vi.mocked(sendNotificationEmail).mockClear()
    expect((await s655Post(body)).status).toBe(200)
    const row = (await db.query<any>(`SELECT next_retry_at FROM payments WHERE id = $1`, [rent])).rows[0]
    expect(new Date(row.next_retry_at).toISOString()).toBe('2030-01-01T00:00:00.000Z')
    expect(vi.mocked(sendNotificationEmail)).not.toHaveBeenCalled()
  })

  it('payment_intent.canceled releases held credit and leaves rows payable', async () => {
    const h = await s655Household()
    const rent = await s655Row(h, { amount: 1000 })
    const credit = await s655PaidAhead(h, 100)
    const rem = await s655Remittance(h, { amount: 900 })
    await s655Hold(h, credit, rent, rem, 100)
    await s655Claim([rent], rem, 'pi_s655_cancel')
    expect((await s655Post(s655Canceled('pi_s655_cancel'))).status).toBe(200)
    const row = (await db.query<any>(`SELECT status, next_retry_at FROM payments WHERE id = $1`, [rent])).rows[0]
    expect(row).toEqual({ status: 'failed', next_retry_at: null })
    const payable = await db.query(`SELECT 1 FROM payments p WHERE p.id = $1 AND p.status IN ('pending','failed')
                                       AND (p.status = 'failed' OR p.stripe_payment_intent_id IS NULL)`, [rent])
    expect(payable.rowCount).toBe(1)
    const use = (await db.query<any>(`SELECT status, release_reason FROM credit_uses WHERE remittance_id = $1`, [rem])).rows[0]
    expect(use).toEqual({ status: 'released', release_reason: 'payment_canceled' })
    expect((await db.query<any>(`SELECT amount_remaining::float AS r FROM lease_prepaid_credits WHERE id = $1`, [credit])).rows[0].r).toBe(100)
    expect((await db.query<any>(`SELECT status FROM tenant_remittances WHERE id = $1`, [rem])).rows[0].status).toBe('failed')
  })
})

describe('S655 Step 10 — FlexPay pulls through the webhooks', () => {
  async function flexPull(h: S655Household, pi: string, o: { retryCount?: number; amount?: number } = {}) {
    await db.query(`UPDATE tenants SET flexpay_enrolled = TRUE, flexpay_pull_day = 10, flexpay_monthly_fee = 25 WHERE id = $1`, [h.tenantId])
    const adv = (await db.query<{ id: string }>(
      `INSERT INTO flexpay_advances (cycle_month, tenant_id, landlord_id, unit_id, lease_id, rent_amount, tenant_fee_amount,
                                     pull_day, status, fronted_at, pulled_at, pull_date)
       VALUES ('2026-10-01', $1, $2, $3, $4, 500, 25, 10, 'pulled', NOW(), NOW(), '2026-10-10') RETURNING id`,
      [h.tenantId, h.landlordId, h.unitId, h.leaseId])).rows[0].id
    const row = (await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, entry_description, due_date,
                             revenue_owner, stripe_payment_intent_id, flexpay_advance_id, retry_count)
       VALUES ($1,$2,$3,$4,'fee',$5,'processing','FLEXPAY','2026-10-10','gam',$6,$7,$8) RETURNING id`,
      [h.unitId, h.leaseId, h.tenantId, h.landlordId, o.amount ?? 525, pi, adv, o.retryCount ?? 0])).rows[0].id
    await db.query(`UPDATE flexpay_advances SET rent_payment_id = $2 WHERE id = $1`, [adv, row])
    return { adv, row }
  }

  it('FLEXPAY settle: no allocation, no Rent Collected email, $25 booked', async () => {
    const h = await s655Household()
    const { adv, row } = await flexPull(h, 'pi_s655_flex_ok')
    expect((await s655Post(s655Succeeded('pi_s655_flex_ok', { metadata: { gam_purpose: 'flexpay_pull', gam_payment_id: row } }))).status).toBe(200)
    expect((await db.query<any>(`SELECT status FROM payments WHERE id = $1`, [row])).rows[0].status).toBe('settled')
    expect((await db.query<any>(`SELECT status FROM flexpay_advances WHERE id = $1`, [adv])).rows[0].status).toBe('reconciled')
    const fee = await db.query<any>(`SELECT amount::float AS a FROM platform_revenue_ledger WHERE reference_id = $1 AND type = 'flexpay_subscription'`, [adv])
    expect(fee.rows).toEqual([{ a: 25 }])
    expect((await db.query(`SELECT 1 FROM user_balance_ledger WHERE reference_id = $1`, [row])).rowCount).toBe(0)
    expect((await db.query(`SELECT 1 FROM notifications WHERE type = 'rent_collected'`)).rowCount).toBe(0)
    // Redelivered: the $25 is booked once.
    expect((await s655Post(s655Succeeded('pi_s655_flex_ok', { metadata: { gam_purpose: 'flexpay_pull', gam_payment_id: row } }))).status).toBe(200)
    expect((await db.query(`SELECT 1 FROM platform_revenue_ledger WHERE reference_id = $1 AND type = 'flexpay_subscription'`, [adv])).rowCount).toBe(1)
  })

  it('a first-attempt terminal failure defaults the FlexPay advance (a closed account is never retried)', async () => {
    const h = await s655Household()
    const { adv, row } = await flexPull(h, 'pi_s655_flex_closed')
    expect((await s655Post(s655Failed('pi_s655_flex_closed', 'R02', { metadata: { gam_purpose: 'flexpay_pull', gam_payment_id: row } }))).status).toBe(200)
    expect((await db.query<any>(`SELECT status, next_retry_at FROM payments WHERE id = $1`, [row])).rows[0]).toEqual({ status: 'failed', next_retry_at: null })
    const a = (await db.query<any>(`SELECT status, default_reason FROM flexpay_advances WHERE id = $1`, [adv])).rows[0]
    expect(a).toEqual({ status: 'defaulted', default_reason: 'pull_not_collected' })
    const t = (await db.query<any>(`SELECT flexpay_enrolled, flexpay_disqualified_until FROM tenants WHERE id = $1`, [h.tenantId])).rows[0]
    expect(t.flexpay_enrolled).toBe(false)
    expect(t.flexpay_disqualified_until).not.toBeNull()
    // The landlord never hears of a FlexPay bounce.
    expect((await db.query(`SELECT 1 FROM notifications WHERE user_id = $1`, [h.landlordUserId])).rowCount).toBe(0)
  })

  it('a FlexPay pull the bank returned for a reason no R-code maps is the tenant\'s bank: written off once, never made again', async () => {
    const h = await s655Household()
    const { adv, row } = await flexPull(h, 'pi_s655_flex_frozen')
    const body = JSON.stringify({
      id: 'evt_fail_flex_frozen', type: 'payment_intent.payment_failed',
      data: { object: {
        id: 'pi_s655_flex_frozen', metadata: { gam_purpose: 'flexpay_pull', gam_payment_id: row }, payment_method_types: ['us_bank_account'],
        last_payment_error: { type: 'card_error', code: 'account_frozen', payment_method: { type: 'us_bank_account' } },
      } },
    })
    expect((await s655Post(body)).status).toBe(200)
    // The last try failing at the tenant's bank (terms §4.3): never retried
    // (§4.1 retries only a shortage of funds), never made again by GAM.
    const p = (await db.query<any>(`SELECT status, next_retry_at, stripe_payment_intent_id, return_reason FROM payments WHERE id = $1`, [row])).rows[0]
    expect(p).toMatchObject({ status: 'failed', next_retry_at: null, stripe_payment_intent_id: 'pi_s655_flex_frozen' })
    expect(String(p.return_reason ?? '')).not.toMatch(/made again/)
    const a = (await db.query<any>(`SELECT status, default_reason, tenant_fee_amount::float AS fee FROM flexpay_advances WHERE id = $1`, [adv])).rows[0]
    // This return's $4 fee joins what is written off: GAM never keeps it.
    expect(a).toEqual({ status: 'defaulted', default_reason: 'pull_not_collected', fee: 25 + 4 })
    const t = (await db.query<any>(`SELECT flexpay_enrolled, flexpay_disqualified_until FROM tenants WHERE id = $1`, [h.tenantId])).rows[0]
    expect(t.flexpay_enrolled).toBe(false)
    expect(t.flexpay_disqualified_until).not.toBeNull()
    expect((await db.query(`SELECT 1 FROM admin_notifications WHERE category = 'flexpay_pull_gam_side'`)).rowCount).toBe(0)
    // Redelivered: nothing more.
    expect((await s655Post(body)).status).toBe(200)
    expect((await db.query<any>(`SELECT tenant_fee_amount::float AS fee FROM flexpay_advances WHERE id = $1`, [adv])).rows[0].fee).toBe(29)
  })

  it('a FlexPay pull Stripe refused for GAM\'s own request is GAM\'s: the collection is made again and FlexPay goes on', async () => {
    const h = await s655Household()
    const { adv, row } = await flexPull(h, 'pi_s655_flex_badreq')
    const body = JSON.stringify({
      id: 'evt_fail_flex_badreq', type: 'payment_intent.payment_failed',
      data: { object: {
        id: 'pi_s655_flex_badreq', metadata: { gam_purpose: 'flexpay_pull', gam_payment_id: row }, payment_method_types: ['us_bank_account'],
        last_payment_error: { type: 'invalid_request_error', code: 'payment_intent_mandate_invalid', payment_method: { type: 'us_bank_account' } },
      } },
    })
    expect((await s655Post(body)).status).toBe(200)
    expect((await db.query<any>(`SELECT status, stripe_payment_intent_id FROM payments WHERE id = $1`, [row])).rows[0])
      .toEqual({ status: 'pending', stripe_payment_intent_id: null })
    expect((await db.query<any>(`SELECT status, default_reason FROM flexpay_advances WHERE id = $1`, [adv])).rows[0])
      .toEqual({ status: 'fronted', default_reason: null })
    const t = (await db.query<any>(`SELECT flexpay_enrolled, flexpay_disqualified_until FROM tenants WHERE id = $1`, [h.tenantId])).rows[0]
    expect(t).toEqual({ flexpay_enrolled: true, flexpay_disqualified_until: null })
  })

  it('a first-retry failure does not end FlexPay while the second retry is scheduled', async () => {
    const h = await s655Household()
    const { adv, row } = await flexPull(h, 'pi_s655_flex_retry1', { retryCount: 1 })
    expect((await s655Post(s655Failed('pi_s655_flex_retry1', 'R01', { metadata: { gam_purpose: 'flexpay_pull', gam_payment_id: row } }))).status).toBe(200)
    const p = (await db.query<any>(`SELECT status, next_retry_at FROM payments WHERE id = $1`, [row])).rows[0]
    expect(p.status).toBe('failed')
    expect(p.next_retry_at).not.toBeNull()
    expect((await db.query<any>(`SELECT status FROM flexpay_advances WHERE id = $1`, [adv])).rows[0].status).toBe('pulled')
    expect((await db.query<any>(`SELECT flexpay_enrolled FROM tenants WHERE id = $1`, [h.tenantId])).rows[0].flexpay_enrolled).toBe(true)
    // The tenant is told the retry day, in FlexPay's words; the landlord hears nothing.
    expect((await db.query(`SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'flexpay_pull_retry'`, [h.tenantUserId])).rowCount).toBe(1)
    expect((await db.query(`SELECT 1 FROM notifications WHERE user_id = $1`, [h.landlordUserId])).rowCount).toBe(0)
  })
})

describe('S655 Step 10 — setup_intent.succeeded with a bank already on file', () => {
  it('a verified bank already on file: the new bank is promoted once', async () => {
    const c = await getClient()
    let tenantId: string
    try {
      tenantId = await seedTenant(c)
      await c.query(`UPDATE tenants SET ach_verified = TRUE, bank_last4 = '1111', stripe_customer_id = 'cus_two_banks' WHERE id = $1`, [tenantId])
    } finally { c.release() }
    stripeMocks.state.pms.set('pm_old_bank', { ...stripeMocks.bankPm('pm_old_bank', 'cus_two_banks'), us_bank_account: { last4: '1111', routing_number: '110000000' } })
    stripeMocks.state.pms.set('pm_new_bank', stripeMocks.bankPm('pm_new_bank', 'cus_two_banks'))
    stripeMocks.state.defaults.set('cus_two_banks', 'pm_old_bank')

    const body = buildSetupIntentSucceeded({ tenantId: tenantId! }, { customer: 'cus_two_banks', paymentMethod: 'pm_new_bank' })
    expect((await s655Post(body)).status).toBe(200)
    expect(stripeMocks.state.defaults.get('cus_two_banks')).toBe('pm_new_bank')
    const promotions = () => stripeMocks.customersUpdate.mock.calls.filter((call: any[]) => call[0] === 'cus_two_banks').length
    expect(promotions()).toBe(1)
    const t = (await db.query<any>(`SELECT ach_verified, bank_last4 FROM tenants WHERE id = $1`, [tenantId!])).rows[0]
    expect(t).toEqual({ ach_verified: true, bank_last4: '6789' })

    // The tenant then chooses the old bank as default; a redelivered event keeps their choice.
    stripeMocks.state.defaults.set('cus_two_banks', 'pm_old_bank')
    expect((await s655Post(body)).status).toBe(200)
    expect(promotions()).toBe(1)
    expect(stripeMocks.state.defaults.get('cus_two_banks')).toBe('pm_old_bank')
  })
})

describe('S655 Step 10 — a FlexPay pull failure on GAM\'s side', () => {
  it('a FlexPay pull canceled at Stripe is GAM\'s: the collection is made again and FlexPay goes on', async () => {
    const h = await s655Household()
    await db.query(`UPDATE tenants SET flexpay_enrolled = TRUE, flexpay_pull_day = 10, flexpay_monthly_fee = 25 WHERE id = $1`, [h.tenantId])
    const adv = (await db.query<{ id: string }>(
      `INSERT INTO flexpay_advances (cycle_month, tenant_id, landlord_id, unit_id, lease_id, rent_amount, tenant_fee_amount,
                                     pull_day, status, fronted_at, pulled_at, pull_date)
       VALUES ('2026-10-01', $1, $2, $3, $4, 500, 25, 10, 'pulled', NOW(), NOW(), '2026-10-10') RETURNING id`,
      [h.tenantId, h.landlordId, h.unitId, h.leaseId])).rows[0].id
    const row = (await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, entry_description, due_date,
                             revenue_owner, stripe_payment_intent_id, flexpay_advance_id)
       VALUES ($1,$2,$3,$4,'fee',525,'processing','FLEXPAY','2026-10-10','gam','pi_flex_canceled',$5) RETURNING id`,
      [h.unitId, h.leaseId, h.tenantId, h.landlordId, adv])).rows[0].id
    await db.query(`UPDATE flexpay_advances SET rent_payment_id = $2 WHERE id = $1`, [adv, row])

    expect((await s655Post(s655Canceled('pi_flex_canceled'))).status).toBe(200)
    expect((await db.query<any>(`SELECT status, stripe_payment_intent_id FROM payments WHERE id = $1`, [row])).rows[0])
      .toEqual({ status: 'pending', stripe_payment_intent_id: null })
    expect((await db.query<any>(`SELECT status, default_reason FROM flexpay_advances WHERE id = $1`, [adv])).rows[0])
      .toEqual({ status: 'fronted', default_reason: null })
    const t = (await db.query<any>(`SELECT flexpay_enrolled, flexpay_disqualified_until FROM tenants WHERE id = $1`, [h.tenantId])).rows[0]
    expect(t).toEqual({ flexpay_enrolled: true, flexpay_disqualified_until: null })
    expect((await db.query(`SELECT 1 FROM notifications WHERE type = 'flexpay_ended'`)).rowCount).toBe(0)
  })
})

describe('S655 Step 10 — rent paid past a shortened stay, settled by the webhook', () => {
  it('rent still clearing when a stay was shortened is banked as stay-shortened money when its payment succeeds', async () => {
    const { syncLeaseWithBookingDates } = await import('../services/bookingLeaseBilling')
    const h = await s655Household(950)
    await db.query(`UPDATE leases SET start_date = '2026-08-10' WHERE id = $1`, [h.leaseId])
    const bookingId = (await db.query<{ id: string }>(
      `INSERT INTO unit_bookings
         (unit_id, landlord_id, lease_type, check_in, check_out, nights, guest_name, guest_email, status, source)
       VALUES ($1, $2, 'month_to_month', '2026-08-10', '2027-01-28', 171, 'Sched Guest', 'sched-guest-wh@test.dev', 'confirmed', 'public')
       RETURNING id`, [h.unitId, h.landlordId])).rows[0].id
    await db.query(
      `UPDATE leases SET lease_source = 'booking_draft', source_booking_id = $2, end_date = '2027-01-28', needs_review = false WHERE id = $1`,
      [h.leaseId, bookingId])
    // Arrival paid; September's bank pull is clearing when the stay is shortened to Sep 20.
    await s655Row(h, { amount: 696.67, status: 'settled', due: '2026-08-10' })
    const sep = await s655Row(h, { amount: 950, due: '2026-09-01' })
    const rem = await s655Remittance(h, { amount: 950 })
    await s655Claim([sep], rem, 'pi_s655_stay_clearing')
    await db.query(`UPDATE unit_bookings SET check_out = '2026-09-20', nights = 41 WHERE id = $1`, [bookingId])
    await syncLeaseWithBookingDates(bookingId)
    expect((await db.query(`SELECT 1 FROM lease_prepaid_credits WHERE lease_id = $1`, [h.leaseId])).rowCount).toBe(0)

    expect((await s655Post(s655Succeeded('pi_s655_stay_clearing', { metadata: { gam_remittance_id: rem } }))).status).toBe(200)
    // $696.67 + $950 paid − $1,275.86 the stay owes = $370.81, banked once.
    const banked = await db.query<any>(
      `SELECT amount_original::float AS a, funded_by, source_payment_id FROM lease_prepaid_credits
        WHERE lease_id = $1 AND funded_by = 'reclassified'`, [h.leaseId])
    expect(banked.rows).toEqual([{ a: 370.81, funded_by: 'reclassified', source_payment_id: sep }])
  })
})

describe('Step 10 fix pass 2 — success settles only the rows still waiting on its charge (plan §3)', () => {
  it('a success for an intent whose rows failed for good never settles them: the money is banked as credit, with an alert', async () => {
    const h = await s655Household()
    const rent = await s655Row(h, { amount: 1000 })
    const credit = await s655PaidAhead(h, 100)
    const rem = await s655Remittance(h, { amount: 900 })
    await s655Hold(h, credit, rent, rem, 100)
    await s655Claim([rent], rem, 'pi_fp2_final_then_ok')
    // The bank closes the account: final, the credit goes back, the receipt closes.
    expect((await s655Post(s655Failed('pi_fp2_final_then_ok', 'R02'))).status).toBe(200)
    expect((await db.query<any>(`SELECT status, next_retry_at FROM payments WHERE id = $1`, [rent])).rows[0])
      .toEqual({ status: 'failed', next_retry_at: null })

    // Stripe then reports the same intent succeeded (it cannot, today — but if it ever did).
    expect((await s655Post(s655Succeeded('pi_fp2_final_then_ok', { metadata: { gam_remittance_id: rem } }))).status).toBe(200)
    // The charge never settles the row: no charge id stamped, the credit it set aside stays given back.
    expect((await db.query<any>(`SELECT stripe_charge_id FROM payments WHERE id = $1`, [rent])).rows[0].stripe_charge_id).toBeNull()
    expect((await db.query<any>(`SELECT status FROM credit_uses WHERE remittance_id = $1`, [rem])).rows).toEqual([{ status: 'released' }])
    // The $900 that arrived is GAM-held paid-ahead money; the whole-bill check then pays the
    // bill in full from it and the tenant's own $100 — every dollar counted once.
    const uses = await db.query<any>(
      `SELECT pc.funded_by, cu.amount::float AS a FROM credit_uses cu JOIN lease_prepaid_credits pc ON pc.id = cu.prepaid_credit_id
        WHERE cu.payment_id = $1 AND cu.status = 'applied' ORDER BY cu.amount`, [rent])
    expect(uses.rows).toEqual([{ funded_by: 'landlord', a: 100 }, { funded_by: 'gam', a: 900 }])
    expect((await db.query<any>(`SELECT status FROM payments WHERE id = $1`, [rent])).rows[0].status).toBe('settled')
    const share = await db.query<any>(`SELECT amount::float AS a FROM user_balance_ledger WHERE reference_id = $1 AND type = 'allocation_owner_share'`, [rent])
    expect(share.rows).toEqual([{ a: 900 }])
    const pc = await db.query<any>(`SELECT amount_original::float AS a, funded_by FROM lease_prepaid_credits WHERE source_remittance_id = $1`, [rem])
    expect(pc.rows).toEqual([{ a: 900, funded_by: 'gam' }])
    expect((await db.query<any>(`SELECT status, applied_amount::float AS a, unapplied_amount::float AS u FROM tenant_remittances WHERE id = $1`, [rem])).rows[0])
      .toEqual({ status: 'settled', a: 0, u: 900 })
    // Banked with a warning, never the critical "receipt short" alert.
    expect((await db.query(`SELECT 1 FROM admin_notifications WHERE category = 'stripe_surplus_banked'`)).rowCount).toBe(1)
    expect((await db.query(`SELECT 1 FROM admin_notifications WHERE category = 'stripe_receipt_short'`)).rowCount).toBe(0)
  })

  it('a success settles a row whose retry is still scheduled and spends the credit still held', async () => {
    const h = await s655Household()
    const rent = await s655Row(h, { amount: 1000 })
    const credit = await s655PaidAhead(h, 100)
    const rem = await s655Remittance(h, { amount: 900 })
    await s655Hold(h, credit, rent, rem, 100)
    await s655Claim([rent], rem, 'pi_fp2_retry_then_ok')
    expect((await s655Post(s655Failed('pi_fp2_retry_then_ok', 'R01'))).status).toBe(200)
    expect((await db.query<any>(`SELECT next_retry_at FROM payments WHERE id = $1`, [rent])).rows[0].next_retry_at).not.toBeNull()

    expect((await s655Post(s655Succeeded('pi_fp2_retry_then_ok', { metadata: { gam_remittance_id: rem } }))).status).toBe(200)
    expect((await db.query<any>(`SELECT status, next_retry_at FROM payments WHERE id = $1`, [rent])).rows[0])
      .toEqual({ status: 'settled', next_retry_at: null })
    expect((await db.query<any>(`SELECT status FROM credit_uses WHERE remittance_id = $1`, [rem])).rows[0].status).toBe('applied')
    expect((await db.query(`SELECT 1 FROM lease_prepaid_credits WHERE source_remittance_id = $1`, [rem])).rowCount).toBe(0)
  })

  it('a pending bill row carrying the intent is never settled by it; a product pull\'s own pending row is', async () => {
    const h = await s655Household()
    // A bill row the charge never claimed (every bill charge claims its rows as processing first).
    const rent = await s655Row(h, { amount: 1000, pi: 'pi_fp2_unclaimed' })
    const rem = await s655Remittance(h, { amount: 1000, pi: 'pi_fp2_unclaimed' })
    expect((await s655Post(s655Succeeded('pi_fp2_unclaimed', { metadata: { gam_remittance_id: rem } }))).status).toBe(200)
    // The charge never settles it as its own row: no charge id stamped on it.
    expect((await db.query<any>(`SELECT stripe_charge_id FROM payments WHERE id = $1`, [rent])).rows[0].stripe_charge_id).toBeNull()
    expect((await db.query<any>(`SELECT amount_original::float AS a FROM lease_prepaid_credits WHERE source_remittance_id = $1`, [rem])).rows)
      .toEqual([{ a: 1000 }])

    // A FlexCredit fee pull is written pending with its intent already on it: its success settles it.
    const fee = await s655Row(h, { amount: 5, type: 'fee', entry: 'SUBSCRIP', owner: 'gam', pi: 'pi_fp2_product_pull' })
    expect((await s655Post(s655Succeeded('pi_fp2_product_pull', { metadata: { gam_purpose: 'flexcredit_fee', gam_tenant_id: h.tenantId } }))).status).toBe(200)
    expect((await db.query<any>(`SELECT status FROM payments WHERE id = $1`, [fee])).rows[0].status).toBe('settled')
  })
})

describe('Step 10 fix pass 3 — a success that passes rows over never strands them or the money', () => {
  it('a pending bill row the charge never claimed loses the intent and is paid by the money it banked, with the alert saying so', async () => {
    const h = await s655Household()
    const rent = await s655Row(h, { amount: 1000, pi: 'pi_fp3_unclaimed' })
    const rem = await s655Remittance(h, { amount: 1000, pi: 'pi_fp3_unclaimed' })
    expect((await s655Post(s655Succeeded('pi_fp3_unclaimed', { metadata: { gam_remittance_id: rem } }))).status).toBe(200)
    // The intent is off the row, so it is payable — and the whole-bill check paid it from the $1,000 banked.
    expect((await db.query<any>(`SELECT status, stripe_payment_intent_id AS pi, stripe_charge_id FROM payments WHERE id = $1`, [rent])).rows[0])
      .toEqual({ status: 'settled', pi: null, stripe_charge_id: null })
    const uses = await db.query<any>(
      `SELECT pc.funded_by, cu.amount::float AS a FROM credit_uses cu JOIN lease_prepaid_credits pc ON pc.id = cu.prepaid_credit_id
        WHERE cu.payment_id = $1 AND cu.status = 'applied'`, [rent])
    expect(uses.rows).toEqual([{ funded_by: 'gam', a: 1000 }])
    const alert = (await db.query<any>(`SELECT body, context FROM admin_notifications WHERE category = 'stripe_surplus_banked'`)).rows
    expect(alert).toHaveLength(1)
    expect(alert[0].body).toContain('was never claimed by it')
    expect(alert[0].body).not.toContain('failed for good')
    expect(alert[0].context.never_claimed).toEqual([rent])
  })

  it('a product pull whose row failed for good, then succeeds with no receipt: an admin is told to place the money', async () => {
    const h = await s655Household()
    const fee = await s655Row(h, { amount: 5, type: 'fee', entry: 'SUBSCRIP', owner: 'gam', pi: 'pi_fp3_pull_failed' })
    await db.query(`UPDATE payments SET status = 'failed', next_retry_at = NULL WHERE id = $1`, [fee])
    const ok = s655Succeeded('pi_fp3_pull_failed', { metadata: { gam_purpose: 'flexcredit_fee', gam_tenant_id: h.tenantId } })
    expect((await s655Post(ok)).status).toBe(200)
    expect((await db.query<any>(`SELECT status FROM payments WHERE id = $1`, [fee])).rows[0].status).toBe('failed')
    const alert = (await db.query<any>(`SELECT severity, body, context FROM admin_notifications WHERE category = 'stripe_success_unplaced'`)).rows
    expect(alert).toHaveLength(1)
    expect(alert[0].severity).toBe('critical')
    expect(alert[0].body).toContain(`${fee} (failed)`)
    expect(alert[0].context).toMatchObject({ stripe_payment_intent_id: 'pi_fp3_pull_failed', rows: [{ id: fee, status: 'failed' }] })
  })

  it('a redelivered success of a product pull it settled raises no alert', async () => {
    const h = await s655Household()
    const fee = await s655Row(h, { amount: 5, type: 'fee', entry: 'SUBSCRIP', owner: 'gam', pi: 'pi_fp3_pull_ok' })
    const ok = s655Succeeded('pi_fp3_pull_ok', { metadata: { gam_purpose: 'flexcredit_fee', gam_tenant_id: h.tenantId } })
    expect((await s655Post(ok)).status).toBe(200)
    expect((await s655Post(ok)).status).toBe(200)
    expect((await db.query<any>(`SELECT status FROM payments WHERE id = $1`, [fee])).rows[0].status).toBe('settled')
    expect((await db.query(`SELECT 1 FROM admin_notifications WHERE category = 'stripe_success_unplaced'`)).rowCount).toBe(0)
  })

  it('a redelivered success of a settled product pull with no charge id recorded raises no alert', async () => {
    // Settled before the charge id was kept: stripe_charge_id NULL, no receipt.
    // It is this charge's own row, not money with nothing waiting on it.
    const h = await s655Household()
    const fee = await s655Row(h, { amount: 5, type: 'fee', entry: 'SUBSCRIP', owner: 'gam', pi: 'pi_fp3_pull_nochg' })
    await db.query(
      `UPDATE payments SET status = 'settled', settled_at = NOW(), stripe_charge_id = NULL WHERE id = $1`, [fee])
    const ok = s655Succeeded('pi_fp3_pull_nochg', { metadata: { gam_purpose: 'flexcredit_fee', gam_tenant_id: h.tenantId } })
    expect((await s655Post(ok)).status).toBe(200)
    expect((await db.query<any>(`SELECT status FROM payments WHERE id = $1`, [fee])).rows[0].status).toBe('settled')
    expect((await db.query(`SELECT 1 FROM admin_notifications WHERE category = 'stripe_success_unplaced'`)).rowCount).toBe(0)
  })

  it('a success whose settled row carries a DIFFERENT charge id still raises the unplaced alert', async () => {
    const h = await s655Household()
    const fee = await s655Row(h, { amount: 5, type: 'fee', entry: 'SUBSCRIP', owner: 'gam', pi: 'pi_fp3_pull_otherchg' })
    await db.query(
      `UPDATE payments SET status = 'settled', settled_at = NOW(), stripe_charge_id = 'ch_some_other_charge' WHERE id = $1`, [fee])
    const ok = s655Succeeded('pi_fp3_pull_otherchg', { metadata: { gam_purpose: 'flexcredit_fee', gam_tenant_id: h.tenantId } })
    expect((await s655Post(ok)).status).toBe(200)
    const alert = (await db.query<any>(`SELECT severity, context FROM admin_notifications WHERE category = 'stripe_success_unplaced'`)).rows
    expect(alert).toHaveLength(1)
    expect(alert[0].severity).toBe('critical')
    expect(alert[0].context).toMatchObject({ stripe_payment_intent_id: 'pi_fp3_pull_otherchg', rows: [{ id: fee, status: 'settled' }] })
  })
})

describe('Early check-out fix pass (review r3) — a refund that failed before GAM recorded it', () => {
  const post = (body: string) => request(buildApp()).post('/webhooks/stripe')
    .set('Content-Type', 'application/json').set('stripe-signature', 't=1,v1=stub').send(body)
  const failedRefund = (partId: string) => JSON.stringify({
    id: `evt_stay_refund_${partId}`, type: 'refund.updated',
    data: { object: { id: `re_${partId.slice(0, 8)}`, object: 'refund', status: 'failed',
      metadata: { gam_purpose: 'stay_early_checkout_refund', gam_stay_refund_part_id: partId } } },
  })

  it('while the refund is still being sent it answers 500 so Stripe sends it again; once no send is running it answers 200', async () => {
    const partId = '6f1c2a4e-0d5b-4c33-9a71-2b8e5d4f9c10'
    const sending = await getClient()
    try {
      // The send holds the part's lock while it records the refund (earlyCheckOut runCardPart).
      await sending.query(`SELECT pg_advisory_lock(hashtextextended($1, 0))`, [`stay-refund-part:${partId}`])
      const busy = await post(failedRefund(partId))
      expect(busy.status).toBe(500)
      expect(busy.body.error).toBe('refund still being recorded — send again')
      await sending.query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [`stay-refund-part:${partId}`])
    } finally { sending.release() }
    expect((await post(failedRefund(partId))).status).toBe(200)
  })
})

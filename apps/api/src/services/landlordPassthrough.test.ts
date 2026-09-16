/**
 * S428 services-audit slice 5c (of 3): landlordPassthrough.ts.
 *
 * `reconcilePlatformHeldPayments(landlordUserId)` aggregates unfired
 * `allocation_owner_share` ledger rows for a landlord and fires a
 * Stripe Connect Transfer to their Connect account, then flips
 * payments.platform_held=FALSE.
 *
 * Tests focus on the no-op edge cases and the happy path (with a
 * mocked Stripe Transfer). Failure-rollback path is implicitly
 * covered — if the transaction fails, the function throws and the
 * caller (Stripe webhook) decides how to handle.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

const transferMock = vi.hoisted(() =>
  vi.fn(async () => ({ id: 'tr_mock_' + Math.random().toString(36).slice(2, 8) }))
)
const adminNotifyMock = vi.hoisted(() => vi.fn(async () => undefined))

vi.mock('./stripeConnect', () => ({
  createPmCompanyTransfer: transferMock,
}))
vi.mock('./adminNotifications', () => ({
  createAdminNotification: adminNotifyMock,
}))

import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant } from '../test/dbHelpers'
import { reconcilePlatformHeldPayments, tryReconcileForLandlordUserId, recoverPendingPlatformTransfers, heldOwnerShareForUser } from './landlordPassthrough'

beforeEach(async () => {
  await cleanupAllSchema()
  transferMock.mockClear()
  adminNotifyMock.mockClear()
  transferMock.mockResolvedValue({ id: 'tr_mock_default' } as any)
})

interface Ctx {
  landlordUserId: string
  landlordId:     string
  unitId:         string
  tenantId:       string
  paymentId:      string
}

async function seedCtx(opts: { connectAccount?: string | null } = {}): Promise<Ctx> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId: landlordUserId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, {
      landlordId, ownerUserId: landlordUserId, managedByUserId: landlordUserId,
    })
    const unitId = await seedUnit(c, { propertyId, landlordId })
    const tenantId = await seedTenant(c)
    await c.query(
      `UPDATE users SET stripe_connect_account_id=$1 WHERE id=$2`,
      [opts.connectAccount === undefined ? 'acct_test_s428' : opts.connectAccount,
       landlordUserId])
    // Seed a settled, platform_held rent payment.
    const { rows: [{ id: paymentId }] } = await c.query<{ id: string }>(
      `INSERT INTO payments
         (unit_id, tenant_id, landlord_id, type, amount, status,
          entry_description, due_date, platform_held, settled_at)
       VALUES ($1, $2, $3, 'rent', 1000, 'settled', 'RENT', CURRENT_DATE,
               TRUE, NOW()) RETURNING id`,
      [unitId, tenantId, landlordId])
    await c.query('COMMIT')
    return { landlordUserId, landlordId, unitId, tenantId, paymentId }
  } catch (e) { await c.query('ROLLBACK'); throw e }
  finally { c.release() }
}

async function seedOwnerShareLedger(ctx: Ctx, amount: number): Promise<void> {
  await db.query(
    `INSERT INTO user_balance_ledger
       (user_id, type, amount, balance_after, reference_id, reference_type, notes)
     VALUES ($1, 'allocation_owner_share', $2, $2, $3, 'payment',
             'S428 test allocation')`,
    [ctx.landlordUserId, amount, ctx.paymentId])
}

// ── S640: AN ACCOUNT THAT OWNS TWO COMPANIES ───────────────────────────────
//
// The reserve step was a queryOne over `users JOIN landlords`, so an account
// owning two companies matched twice and it silently took whichever row came
// back first. Nic's account owns Mountain View and Oak Park; Mountain View
// sorts first, so Oak Park's card and ACH rent could never leave the platform
// balance — with nothing anywhere saying so. It has not bitten only because
// Oak Park's residents have all paid cash so far.
/**
 * S640 — ONE TRANSFER, MANY PAYMENTS.
 *
 * Found firing Mountain View's first real disbursement by hand: both companies
 * failed on a unique index over user_balance_ledger.stripe_transfer_id. That
 * index is from S119, when a transfer was fired per ledger row for a PM cut.
 * The platform-held passthrough sums every settled payment into ONE transfer and
 * stamps its id on each reserved row — so three payments meant three rows
 * carrying the same id, and the reservation rolled back.
 *
 * It had never fired with more than one payment in the batch. The Sep 8 sweep of
 * $589 worked because it was a single payment; an ordinary month could not have
 * paid out at all, for any landlord, and the failure showed only in the job's
 * error array.
 */
describe('S640 a batch with several payments in it', () => {
  it('moves every settled payment in one transfer', async () => {
    const ctx = await seedCtx()
    await seedOwnerShareLedger(ctx, 500)

    // Two more settled, platform-held payments on the same landlord — the
    // ordinary case of three residents paying by card in one month.
    for (const amount of [300, 200]) {
      const { rows: [p] } = await db.query<{ id: string }>(
        `INSERT INTO payments
           (unit_id, tenant_id, landlord_id, type, amount, status, entry_description,
            due_date, platform_held, settled_at)
         VALUES ($1,$2,$3,'rent',$4,'settled','RENT', CURRENT_DATE - $5::int, TRUE, NOW())
         RETURNING id`,
        [ctx.unitId, ctx.tenantId, ctx.landlordId, amount, amount])
      await db.query(
        `INSERT INTO user_balance_ledger
           (user_id, type, amount, balance_after, reference_id, reference_type, notes)
         VALUES ($1,'allocation_owner_share',$2,$2,$3,'payment','S640 batch')`,
        [ctx.landlordUserId, amount, p.id])
    }

    const res = await reconcilePlatformHeldPayments(ctx.landlordUserId)
    expect(res.attempted).toBe(true)
    expect(res.amount).toBe(1000)          // 500 + 300 + 200, not just the first
    expect(transferMock).toHaveBeenCalledTimes(1)

    // Every row carries the same transfer id, which is the point.
    const { rows } = await db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM user_balance_ledger
        WHERE type = 'allocation_owner_share' AND stripe_transfer_id IS NOT NULL
          AND stripe_transfer_id NOT LIKE 'intent:%'`)
    expect(Number(rows[0].n)).toBe(3)

    const held = await db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM payments WHERE platform_held = TRUE`)
    expect(Number(held.rows[0].n)).toBe(0)
  })
})

describe('S640 an account with several companies', () => {
  async function seedSecondCompany(ctx: Ctx, connectAccount: string) {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const l = await c.query<{ id: string }>(
        `INSERT INTO landlords (user_id, business_name, stripe_connect_account_id)
         VALUES ($1, 'Second Company', $2) RETURNING id`, [ctx.landlordUserId, connectAccount])
      const landlordId = l.rows[0].id
      const propertyId = await seedProperty(c, {
        landlordId, ownerUserId: ctx.landlordUserId, managedByUserId: ctx.landlordUserId })
      const unitId = await seedUnit(c, { propertyId, landlordId })
      const tenantId = await seedTenant(c)
      const pay = await c.query<{ id: string }>(
        `INSERT INTO payments
           (unit_id, tenant_id, landlord_id, type, amount, status,
            entry_description, due_date, platform_held, settled_at)
         VALUES ($1,$2,$3,'rent',700,'settled','RENT',CURRENT_DATE,TRUE,NOW()) RETURNING id`,
        [unitId, tenantId, landlordId])
      await c.query('COMMIT')
      return { landlordId, paymentId: pay.rows[0].id }
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
  }

  it('sweeps BOTH companies, each to its own Connect account', async () => {
    // Distinct ids per call: real Stripe never returns the same transfer twice,
    // and user_balance_ledger has a unique index on stripe_transfer_id that
    // says so. The shared default id is a harness artifact, not the product.
    let n = 0
    transferMock.mockImplementation(async () => ({ id: `tr_mock_multi_${++n}` }) as any)
    const ctx = await seedCtx({ connectAccount: null })
    await db.query(`UPDATE landlords SET stripe_connect_account_id='acct_first' WHERE id=$1`, [ctx.landlordId])
    await seedOwnerShareLedger(ctx, 950)

    const second = await seedSecondCompany(ctx, 'acct_second')
    await db.query(
      `INSERT INTO user_balance_ledger
         (user_id, type, amount, balance_after, reference_id, reference_type, notes)
       VALUES ($1,'allocation_owner_share',$2,$2,$3,'payment','S640 second company')`,
      [ctx.landlordUserId, 680, second.paymentId])

    const res = await reconcilePlatformHeldPayments(ctx.landlordUserId)
    expect(res.attempted).toBe(true)
    expect(res.amount).toBe(1630)              // 950 + 680, not 950
    expect(transferMock).toHaveBeenCalledTimes(2)

    const destinations = transferMock.mock.calls
      .map((c: any[]) => c[0]?.destinationConnectAccountId)
    expect(destinations).toContain('acct_first')
    expect(destinations).toContain('acct_second')

    // Neither company's money is left claimable a second time.
    const held = await db.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM payments WHERE platform_held = TRUE`)
    expect(Number(held.rows[0].c)).toBe(0)
  })

  it('one company owing nothing does not stop the other being swept', async () => {
    const ctx = await seedCtx({ connectAccount: null })
    await db.query(`UPDATE landlords SET stripe_connect_account_id='acct_first' WHERE id=$1`, [ctx.landlordId])
    // No ledger row for the FIRST company — nothing owed there.
    const second = await seedSecondCompany(ctx, 'acct_second')
    await db.query(
      `INSERT INTO user_balance_ledger
         (user_id, type, amount, balance_after, reference_id, reference_type, notes)
       VALUES ($1,'allocation_owner_share',$2,$2,$3,'payment','S640 second only')`,
      [ctx.landlordUserId, 680, second.paymentId])

    const res = await reconcilePlatformHeldPayments(ctx.landlordUserId)
    expect(res.attempted).toBe(true)
    expect(res.amount).toBe(680)
    expect(transferMock).toHaveBeenCalledTimes(1)
  })
})

describe('reconcilePlatformHeldPayments', () => {
  it('unknown user (no landlords row) → noop, no Stripe call', async () => {
    const res = await reconcilePlatformHeldPayments(
      '00000000-0000-0000-0000-000000000000')
    expect(res).toEqual({ attempted: false, payments_settled: 0, transfer_id: null, amount: 0 })
    expect(transferMock).not.toHaveBeenCalled()
  })

  it('landlord with no Connect account → noop', async () => {
    const ctx = await seedCtx({ connectAccount: null })
    await seedOwnerShareLedger(ctx, 950)
    const res = await reconcilePlatformHeldPayments(ctx.landlordUserId)
    expect(res.attempted).toBe(false)
    expect(transferMock).not.toHaveBeenCalled()
  })

  it('no unfired owner_share rows → noop', async () => {
    const ctx = await seedCtx()
    // No ledger rows seeded.
    const res = await reconcilePlatformHeldPayments(ctx.landlordUserId)
    expect(res.attempted).toBe(false)
    expect(transferMock).not.toHaveBeenCalled()
    // Payment.platform_held stays TRUE.
    const { rows: [p] } = await db.query<any>(
      `SELECT platform_held FROM payments WHERE id=$1`, [ctx.paymentId])
    expect(p.platform_held).toBe(true)
  })

  it('happy: aggregates owed + fires Transfer + flips platform_held + stamps stripe_transfer_id', async () => {
    const ctx = await seedCtx()
    await seedOwnerShareLedger(ctx, 950)
    transferMock.mockResolvedValueOnce({ id: 'tr_happy_path_test' } as any)
    const res = await reconcilePlatformHeldPayments(ctx.landlordUserId)
    expect(res.attempted).toBe(true)
    expect(res.amount).toBe(950)
    expect(res.transfer_id).toBe('tr_happy_path_test')
    expect(res.payments_settled).toBe(1)
    // Stripe was called with the owed amount + correct destination + metadata.
    expect(transferMock).toHaveBeenCalledWith(expect.objectContaining({
      amount: 950,
      destinationConnectAccountId: 'acct_test_s428',
      metadata: expect.objectContaining({
        gam_kind: 'platform_held_passthrough',
        gam_landlord_id: ctx.landlordId,
        gam_landlord_user_id: ctx.landlordUserId,
      }),
    }))
    // Ledger row stamped with the transfer id.
    const { rows: [l] } = await db.query<any>(
      `SELECT stripe_transfer_id FROM user_balance_ledger
        WHERE user_id=$1 AND type='allocation_owner_share'`,
      [ctx.landlordUserId])
    expect(l.stripe_transfer_id).toBe('tr_happy_path_test')
    // Payment row flipped to platform_held=FALSE.
    const { rows: [p] } = await db.query<any>(
      `SELECT platform_held FROM payments WHERE id=$1`, [ctx.paymentId])
    expect(p.platform_held).toBe(false)
  })

  it('S602: a held deposit is NEVER batched — stays platform_held=TRUE while rent passes through', async () => {
    const ctx = await seedCtx()
    await seedOwnerShareLedger(ctx, 950)  // rent owner-share
    // A settled, platform-held tenant deposit sitting in the trust pool (no owner-share).
    const { rows: [{ id: depositPaymentId }] } = await db.query<{ id: string }>(
      `INSERT INTO payments
         (unit_id, tenant_id, landlord_id, type, amount, status,
          entry_description, due_date, platform_held, settled_at)
       VALUES ($1, $2, $3, 'deposit', 1500, 'settled', 'DEPOSIT', CURRENT_DATE,
               TRUE, NOW()) RETURNING id`,
      [ctx.unitId, ctx.tenantId, ctx.landlordId])
    transferMock.mockResolvedValueOnce({ id: 'tr_rent_only' } as any)
    const res = await reconcilePlatformHeldPayments(ctx.landlordUserId)
    // Only the rent owner-share is transferred; the deposit is not in the batch.
    expect(res.amount).toBe(950)
    expect(transferMock).toHaveBeenCalledWith(expect.objectContaining({ amount: 950 }))
    // Rent flips to passed-through; the deposit STAYS held in trust.
    const { rows: [rent] } = await db.query<any>(`SELECT platform_held FROM payments WHERE id=$1`, [ctx.paymentId])
    const { rows: [dep]  } = await db.query<any>(`SELECT platform_held FROM payments WHERE id=$1`, [depositPaymentId])
    expect(rent.platform_held).toBe(false)
    expect(dep.platform_held).toBe(true)
  })

  it('S561: nets a scheduled reversal receivable against the payout + resolves it', async () => {
    const ctx = await seedCtx()
    await seedOwnerShareLedger(ctx, 950)
    // Landlord owes back a reversed $200 (scheduled to net).
    await db.query(
      `INSERT INTO payment_reversals
         (payment_id, landlord_id, reversal_type, reversed_amount, reversal_fee,
          stripe_event_id, raw_event, recovery_method, recovery_status, status)
       VALUES ($1,$2,'ach_unauthorized',200,4,'evt_net_200','{}','netting','scheduled_netting','recovering')`,
      [ctx.paymentId, ctx.landlordId])
    transferMock.mockResolvedValueOnce({ id: 'tr_net_750' } as any)

    const res = await reconcilePlatformHeldPayments(ctx.landlordUserId)
    // Transfer is owed minus netted: 950 - 200 = 750.
    expect(res.amount).toBe(750)
    expect(transferMock).toHaveBeenCalledWith(expect.objectContaining({ amount: 750 }))
    // The receivable is fully recovered + resolved as a landlord clawback.
    const { rows: [rev] } = await db.query<any>(
      `SELECT recovered_amount, recovery_status, status, outcome, late_fee_owner
         FROM payment_reversals WHERE stripe_event_id='evt_net_200'`)
    expect(Number(rev.recovered_amount)).toBe(200)
    expect(rev).toMatchObject({ recovery_status: 'recovered', status: 'resolved', outcome: 'landlord_clawback', late_fee_owner: 'landlord' })
  })

  it('S561: a receivable LARGER than the batch is NOT partially netted — full transfer fires, receivable carries', async () => {
    const ctx = await seedCtx()
    await seedOwnerShareLedger(ctx, 950)
    // Landlord owes back $1200 — MORE than this batch's $950. No-partial rule
    // (Nic S561): net fully or not at all → nothing nets, the full $950 goes out,
    // the receivable carries for a fully-covering batch or a full clawback.
    await db.query(
      `INSERT INTO payment_reversals
         (payment_id, landlord_id, reversal_type, reversed_amount, reversal_fee,
          stripe_event_id, raw_event, recovery_method, recovery_status, status)
       VALUES ($1,$2,'ach_unauthorized',1200,4,'evt_net_1200','{}','netting','scheduled_netting','recovering')`,
      [ctx.paymentId, ctx.landlordId])
    transferMock.mockResolvedValueOnce({ id: 'tr_full_950' } as any)

    const res = await reconcilePlatformHeldPayments(ctx.landlordUserId)
    expect(res.amount).toBe(950)                       // full transfer, nothing netted
    expect(transferMock).toHaveBeenCalledWith(expect.objectContaining({ amount: 950 }))
    // Receivable untouched — recovered 0, still scheduled (no landlord shortfall).
    const { rows: [rev] } = await db.query<any>(
      `SELECT recovered_amount, recovery_status, status FROM payment_reversals WHERE stripe_event_id='evt_net_1200'`)
    expect(Number(rev.recovered_amount)).toBe(0)
    expect(rev).toMatchObject({ recovery_status: 'scheduled_netting', status: 'recovering' })
  })

  it('already-fired ledger row (stripe_transfer_id NOT NULL) is excluded from sum', async () => {
    const ctx = await seedCtx()
    // Seed a second platform_held payment so the two ledger rows have
    // distinct (reference_id, reference_type, type) tuples — the
    // ux_user_balance_ledger_idempotent UNIQUE blocks duplicates.
    // Different due_date to dodge the S414 partial UNIQUE on
    // (unit_id, due_date) WHERE type='rent' AND status NOT IN ('failed','returned').
    const { rows: [{ id: paymentId2 }] } = await db.query<{ id: string }>(
      `INSERT INTO payments
         (unit_id, tenant_id, landlord_id, type, amount, status,
          entry_description, due_date, platform_held, settled_at)
       VALUES ($1, $2, $3, 'rent', 500, 'settled', 'RENT',
               CURRENT_DATE - INTERVAL '1 month',
               TRUE, NOW()) RETURNING id`,
      [ctx.unitId, ctx.tenantId, ctx.landlordId])
    // Already-fired row → distinct payment_id; should NOT count.
    await db.query(
      `INSERT INTO user_balance_ledger
         (user_id, type, amount, balance_after, reference_id, reference_type, notes, stripe_transfer_id)
       VALUES ($1, 'allocation_owner_share', 500, 500, $2, 'payment',
               'already fired', 'tr_prior')`,
      [ctx.landlordUserId, paymentId2])
    await seedOwnerShareLedger(ctx, 450)  // unfired against ctx.paymentId
    transferMock.mockResolvedValueOnce({ id: 'tr_just_the_450' } as any)
    const res = await reconcilePlatformHeldPayments(ctx.landlordUserId)
    expect(res.amount).toBe(450)  // not 950
    expect(transferMock).toHaveBeenCalledWith(expect.objectContaining({ amount: 450 }))
  })

  it('S580: Transfer failure → batch RESERVED (platform_held=false) + intent left pending; no throw, no double-pay', async () => {
    const ctx = await seedCtx()
    await seedOwnerShareLedger(ctx, 950)
    transferMock.mockRejectedValueOnce(new Error('Stripe is down'))
    const res = await reconcilePlatformHeldPayments(ctx.landlordUserId)
    // Reserved: attempted, but the Transfer is pending (id null) — money is safe.
    expect(res.attempted).toBe(true)
    expect(res.transfer_id).toBeNull()
    expect(res.amount).toBe(950)
    // platform_held flipped FALSE (reserved) so it can't be re-summed into a 2nd transfer.
    const { rows: [p] } = await db.query<any>(`SELECT platform_held FROM payments WHERE id=$1`, [ctx.paymentId])
    expect(p.platform_held).toBe(false)
    // Owner-share carries the intent sentinel, NOT a real transfer id.
    const { rows: [l] } = await db.query<any>(`SELECT stripe_transfer_id FROM user_balance_ledger WHERE user_id=$1 AND type='allocation_owner_share'`, [ctx.landlordUserId])
    expect(l.stripe_transfer_id).toMatch(/^intent:/)
    // A durable pending intent exists with the owed amount + a recorded attempt.
    const { rows: [intent] } = await db.query<any>(`SELECT status, amount, attempts FROM platform_transfer_intents WHERE landlord_id=$1`, [ctx.landlordId])
    expect(intent.status).toBe('pending')
    expect(Number(intent.amount)).toBe(950)
    expect(intent.attempts).toBe(1)
    // First failure is recoverable → no critical notification yet.
    expect(adminNotifyMock).not.toHaveBeenCalled()
  })

  it('S580: no double-pay — a second reconcile after a reserved batch fires no new transfer', async () => {
    const ctx = await seedCtx()
    await seedOwnerShareLedger(ctx, 950)
    transferMock.mockRejectedValueOnce(new Error('Stripe down'))
    await reconcilePlatformHeldPayments(ctx.landlordUserId) // reserves; transfer fails → pending
    transferMock.mockClear()
    const res2 = await reconcilePlatformHeldPayments(ctx.landlordUserId)
    expect(res2.attempted).toBe(false)          // owner-share already reserved → nothing to do
    expect(transferMock).not.toHaveBeenCalled()
    const { rows } = await db.query<any>(`SELECT COUNT(*)::int AS n FROM platform_transfer_intents WHERE landlord_id=$1`, [ctx.landlordId])
    expect(rows[0].n).toBe(1)                    // still exactly one intent
  })

  it('S580: recovery re-fires a stuck pending intent with the same idempotency key', async () => {
    const ctx = await seedCtx()
    await seedOwnerShareLedger(ctx, 950)
    transferMock.mockRejectedValueOnce(new Error('Stripe down'))
    await reconcilePlatformHeldPayments(ctx.landlordUserId) // → pending
    const { rows: [intent0] } = await db.query<any>(`SELECT id FROM platform_transfer_intents WHERE landlord_id=$1`, [ctx.landlordId])
    transferMock.mockResolvedValueOnce({ id: 'tr_recovered' } as any)
    const rec = await recoverPendingPlatformTransfers(0) // grace 0 → include the fresh intent
    expect(rec.recovered).toBe(1)
    expect(transferMock).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: `platform_passthrough_${intent0.id}`, amount: 950,
    }))
    const { rows: [intent] } = await db.query<any>(`SELECT status, stripe_transfer_id FROM platform_transfer_intents WHERE id=$1`, [intent0.id])
    expect(intent).toMatchObject({ status: 'transferred', stripe_transfer_id: 'tr_recovered' })
    const { rows: [l] } = await db.query<any>(`SELECT stripe_transfer_id FROM user_balance_ledger WHERE user_id=$1 AND type='allocation_owner_share'`, [ctx.landlordUserId])
    expect(l.stripe_transfer_id).toBe('tr_recovered')
  })
})

describe('tryReconcileForLandlordUserId', () => {
  it('swallows errors (best-effort hook)', async () => {
    const ctx = await seedCtx()
    await seedOwnerShareLedger(ctx, 100)
    transferMock.mockRejectedValueOnce(new Error('Stripe down'))
    // Should NOT throw — the function is the webhook entry point.
    await expect(tryReconcileForLandlordUserId(ctx.landlordUserId))
      .resolves.toBeUndefined()
  })
})

describe('heldOwnerShareForUser (S639 — display twin of the RESERVE sum)', () => {
  it('sums unfired owner-share on settled platform-held payments', async () => {
    const ctx = await seedCtx()
    await seedOwnerShareLedger(ctx, 950)
    expect(await heldOwnerShareForUser(ctx.landlordUserId)).toBe(950)
  })

  it('ignores rows already stamped with a transfer id', async () => {
    const ctx = await seedCtx()
    await seedOwnerShareLedger(ctx, 950)
    await db.query(
      `UPDATE user_balance_ledger SET stripe_transfer_id='tr_already' WHERE user_id=$1`,
      [ctx.landlordUserId])
    expect(await heldOwnerShareForUser(ctx.landlordUserId)).toBe(0)
  })

  it('ignores non-platform-held payments (cash recorded manually)', async () => {
    const ctx = await seedCtx()
    await seedOwnerShareLedger(ctx, 950)
    await db.query(
      `UPDATE payments SET platform_held=FALSE WHERE id=$1`, [ctx.paymentId])
    expect(await heldOwnerShareForUser(ctx.landlordUserId)).toBe(0)
  })

  it('unknown user → 0, no throw', async () => {
    expect(await heldOwnerShareForUser('00000000-0000-0000-0000-000000000000')).toBe(0)
  })

  it('stays in lockstep with RESERVE: held drains to 0 the moment a batch reserves it', async () => {
    const ctx = await seedCtx()
    await seedOwnerShareLedger(ctx, 950)
    expect(await heldOwnerShareForUser(ctx.landlordUserId)).toBe(950)
    await reconcilePlatformHeldPayments(ctx.landlordUserId)
    // The batch stamped the ledger rows (sentinel, then real id) and flipped
    // platform_held — the displayed held balance must read 0 immediately, not
    // double-count money already on its way out.
    expect(await heldOwnerShareForUser(ctx.landlordUserId)).toBe(0)
  })
})

// ── S648: REGISTER CARD SALES RIDE THE SAME BATCH ─────────────────────────
//
// Nic: "All the propane sales throughout the week will go in a batch payment
// ... All that money needs to flow directly to GAM first and then be dispersed
// that way." A register card sale is charged on GAM's account; what the
// landlord is owed for it waits on the sale row until the weekly batch.
describe('S648 register card sales in the payout batch', () => {
  async function seedSale(ctx: Ctx, opts: { owed: number; method?: string; pi?: string | null }): Promise<string> {
    const { rows: [{ id }] } = await db.query<{ id: string }>(
      `INSERT INTO pos_transactions
         (landlord_id, cashier_id, payment_method, subtotal, total, surcharge,
          stripe_payment_intent_id, payout_owed)
       VALUES ($1, $2, $3, $4, $4, 0, $5, $6) RETURNING id`,
      [ctx.landlordId, ctx.landlordUserId, opts.method ?? 'card', opts.owed,
       opts.pi === undefined ? 'pi_' + Math.random().toString(36).slice(2) : opts.pi, opts.owed])
    return id
  }

  it('pays rent and register sales in one transfer, and marks each sale carried', async () => {
    const ctx = await seedCtx()
    await seedOwnerShareLedger(ctx, 950)
    const s1 = await seedSale(ctx, { owed: 20 })
    const s2 = await seedSale(ctx, { owed: 15.5 })
    expect(await heldOwnerShareForUser(ctx.landlordUserId)).toBe(985.5)
    transferMock.mockResolvedValueOnce({ id: 'tr_with_sales' } as any)
    const res = await reconcilePlatformHeldPayments(ctx.landlordUserId)
    expect(res.amount).toBe(985.5)
    expect(transferMock).toHaveBeenCalledTimes(1)
    const { rows } = await db.query<any>(
      `SELECT t.id, i.stripe_transfer_id FROM pos_transactions t
         JOIN platform_transfer_intents i ON i.id = t.payout_intent_id
        WHERE t.id = ANY($1::uuid[])`, [[s1, s2]])
    expect(rows).toHaveLength(2)
    expect(rows.every((r: any) => r.stripe_transfer_id === 'tr_with_sales')).toBe(true)
    expect(await heldOwnerShareForUser(ctx.landlordUserId)).toBe(0)
  })

  it('a week of register sales alone pays out, and never twice', async () => {
    const ctx = await seedCtx()
    await seedSale(ctx, { owed: 42 })
    transferMock.mockResolvedValueOnce({ id: 'tr_sales_only' } as any)
    expect((await reconcilePlatformHeldPayments(ctx.landlordUserId)).amount).toBe(42)
    const again = await reconcilePlatformHeldPayments(ctx.landlordUserId)
    expect(again.attempted).toBe(false)
    expect(transferMock).toHaveBeenCalledTimes(1)
  })

  it('cash sales owe nothing and are never in a batch', async () => {
    const ctx = await seedCtx()
    const cash = await seedSale(ctx, { owed: 0, method: 'cash', pi: null })
    expect(await heldOwnerShareForUser(ctx.landlordUserId)).toBe(0)
    await reconcilePlatformHeldPayments(ctx.landlordUserId)
    const { rows: [r] } = await db.query<any>(`SELECT payout_intent_id FROM pos_transactions WHERE id=$1`, [cash])
    expect(r.payout_intent_id).toBeNull()
  })

  it('a register-sale chargeback is netted from the next payout', async () => {
    const ctx = await seedCtx()
    const sale = await seedSale(ctx, { owed: 100, pi: 'pi_disputed' })
    const { handlePosSaleDispute } = await import('./posSaleReversal')
    const first = await handlePosSaleDispute({
      paymentIntentId: 'pi_disputed', amountCents: 10380, feeCents: 1500,
      stripeEventId: 'evt_pos_dispute', stripeDisputeId: 'dp_1', rawEvent: {},
    })
    expect(first.handled).toBe(true)
    // Stripe re-delivers; one receivable.
    expect((await handlePosSaleDispute({
      paymentIntentId: 'pi_disputed', amountCents: 10380, feeCents: 1500,
      stripeEventId: 'evt_pos_dispute', stripeDisputeId: 'dp_1', rawEvent: {},
    })).handled).toBe(false)
    const { rows: [rev] } = await db.query<any>(
      `SELECT id, pos_transaction_id, payment_id, reversed_amount FROM payment_reversals WHERE stripe_event_id='evt_pos_dispute'`)
    expect(rev.pos_transaction_id).toBe(sale)
    expect(rev.payment_id).toBeNull()
    // The whole disputed charge plus Stripe's fee — GAM absorbs nothing.
    expect(Number(rev.reversed_amount)).toBe(118.8)
    await db.query(`UPDATE payment_reversals SET recovery_method='netting', recovery_status='scheduled_netting', status='recovering' WHERE id=$1`, [rev.id])
    await seedOwnerShareLedger(ctx, 950)
    transferMock.mockResolvedValueOnce({ id: 'tr_after_dispute' } as any)
    const res = await reconcilePlatformHeldPayments(ctx.landlordUserId)
    expect(res.amount).toBe(Math.round((950 + 100 - 118.8) * 100) / 100)
  })

  it('a dispute on something that is not a register sale is left alone', async () => {
    const { handlePosSaleDispute } = await import('./posSaleReversal')
    const r = await handlePosSaleDispute({
      paymentIntentId: 'pi_rent_somewhere', amountCents: 100, feeCents: 0,
      stripeEventId: 'evt_x', stripeDisputeId: 'dp_x', rawEvent: {},
    })
    expect(r).toEqual({ handled: false, reason: 'not a register sale' })
  })
})

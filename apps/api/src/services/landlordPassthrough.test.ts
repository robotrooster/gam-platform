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
// S650: GAM's own available balance at Stripe — what the batch may claim.
const balanceMock = vi.hoisted(() => vi.fn(async () => ({ available: [{ currency: 'usd', amount: 100_000_00 }] })))
vi.mock('../lib/stripe', () => ({
  getStripe: () => ({ balance: { retrieve: balanceMock } }),
}))

import { db } from '../db'
import { BUSINESS_TYPES } from '@gam/shared'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant } from '../test/dbHelpers'
import { reconcilePlatformHeldPayments, tryReconcileForLandlordUserId, recoverPendingPlatformTransfers, heldOwnerShareForUser, executePlatformTransferIntent } from './landlordPassthrough'
import { takePayoutCut, payoutCutLockKey, cutUnderLock } from './payoutCut'
import { stampPayoutTransfers } from './payoutComposition'

beforeEach(async () => {
  await cleanupAllSchema()
  transferMock.mockClear()
  adminNotifyMock.mockClear()
  transferMock.mockResolvedValue({ id: 'tr_mock_default' } as any)
  balanceMock.mockClear()
  balanceMock.mockResolvedValue({ available: [{ currency: 'usd', amount: 100_000_00 }] } as any)
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

// ── S650: A BATCH NEVER CLAIMS MORE THAN GAM ACTUALLY HAS ──────────────────
//
// Nic: "Why the fuck would money fail to move for insufficient funds? We only
// move the money that was paid to us."
//
// Because `settled` here means the tenant's bank cleared it, and Stripe makes
// an ACH's funds available about four business days later. On 2026-09-16 the
// batch claimed $4,154.89 of Mountain View rent whose newest payments were
// still ripening; Stripe refused the whole Transfer and the older, available
// money sat stuck behind the newer for three days.
describe('S650 the batch is capped by the available balance', () => {
  async function seedExtraPayment(ctx: Ctx, amount: number, daysAgo: number): Promise<string> {
    const { rows: [p] } = await db.query<{ id: string }>(
      `INSERT INTO payments
         (unit_id, tenant_id, landlord_id, type, amount, status, entry_description,
          due_date, platform_held, settled_at)
       VALUES ($1,$2,$3,'rent',$4,'settled','RENT', CURRENT_DATE - $5::int, TRUE, NOW())
       RETURNING id`,
      [ctx.unitId, ctx.tenantId, ctx.landlordId, amount, daysAgo])
    await db.query(
      `INSERT INTO user_balance_ledger
         (user_id, type, amount, balance_after, reference_id, reference_type, notes, created_at)
       VALUES ($1,'allocation_owner_share',$2,$2,$3,'payment','S650', NOW() - ($4 || ' days')::interval)`,
      [ctx.landlordUserId, amount, p.id, String(daysAgo)])
    return p.id
  }

  it('moves the money that has cleared and leaves the rest claimable', async () => {
    const ctx = await seedCtx()
    await seedOwnerShareLedger(ctx, 500)
    await db.query(`UPDATE user_balance_ledger SET created_at = NOW() - interval '9 days'
                     WHERE reference_id = $1`, [ctx.paymentId])   // the oldest money
    await seedExtraPayment(ctx, 300, 5)
    const newest = await seedExtraPayment(ctx, 400, 1)      // still ripening at Stripe
    balanceMock.mockResolvedValue({ available: [{ currency: 'usd', amount: 800_00 }] } as any)

    const res = await reconcilePlatformHeldPayments(ctx.landlordUserId)
    expect(res.attempted).toBe(true)
    expect(res.amount).toBe(800)                            // 500 + 300, not 1200
    expect(transferMock).toHaveBeenCalledTimes(1)

    // The newest payment was NOT claimed — it goes out on the next run.
    const still = await db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM payments WHERE platform_held = TRUE AND id = $1`, [newest])
    expect(Number(still.rows[0].n)).toBe(1)
    const unstamped = await db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM user_balance_ledger
        WHERE type='allocation_owner_share' AND reference_id = $1 AND stripe_transfer_id IS NULL`, [newest])
    expect(Number(unstamped.rows[0].n)).toBe(1)
  })

  it('claims nothing at all when none of it has cleared yet', async () => {
    const ctx = await seedCtx()
    await seedOwnerShareLedger(ctx, 500)
    balanceMock.mockResolvedValue({ available: [{ currency: 'usd', amount: 0 }] } as any)

    const res = await reconcilePlatformHeldPayments(ctx.landlordUserId)
    expect(res.attempted).toBe(false)
    expect(transferMock).not.toHaveBeenCalled()
    const held = await db.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM payments WHERE platform_held = TRUE`)
    expect(Number(held.rows[0].n)).toBe(1)                  // nothing was claimed
  })

  it('still pays out when the balance cannot be read (Stripe down)', async () => {
    const ctx = await seedCtx()
    await seedOwnerShareLedger(ctx, 500)
    balanceMock.mockRejectedValue(new Error('stripe unreachable'))

    const res = await reconcilePlatformHeldPayments(ctx.landlordUserId)
    expect(res.attempted).toBe(true)
    expect(res.amount).toBe(500)
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

// ── S648: EVERY CENT IS HELD, THEN BATCHED ─────────────────────────────────
//
// Nic: "money all needs to flow through the platform. Every single cent...
// We are gonna hold all funds even if briefly." Register sales, stay deposits
// and the chargebacks against them ride the landlord's rent batch.
describe('S648 held items in the landlord payout batch', () => {
  async function hold(ctx: Ctx, amount: number, sourceType: any = 'pos_sale', sourceId?: string): Promise<void> {
    const { recordHeldItem } = await import('./heldPayouts')
    await recordHeldItem({ landlordId: ctx.landlordId, sourceType, sourceId: sourceId ?? Math.random().toString(36).slice(2), amount })
  }

  it('pays rent, register sales and stay deposits in one transfer, and marks each item carried', async () => {
    const ctx = await seedCtx()
    await seedOwnerShareLedger(ctx, 950)
    await hold(ctx, 20)
    await hold(ctx, 15.5, 'booking_deposit')
    expect(await heldOwnerShareForUser(ctx.landlordUserId)).toBe(985.5)
    transferMock.mockResolvedValueOnce({ id: 'tr_with_sales' } as any)
    const res = await reconcilePlatformHeldPayments(ctx.landlordUserId)
    expect(res.amount).toBe(985.5)
    expect(transferMock).toHaveBeenCalledTimes(1)
    const { rows } = await db.query<any>(
      `SELECT i.stripe_transfer_id FROM held_payout_items h
         JOIN platform_transfer_intents i ON i.id = h.payout_intent_id
        WHERE h.landlord_id = $1`, [ctx.landlordId])
    expect(rows).toHaveLength(2)
    expect(rows.every((r: any) => r.stripe_transfer_id === 'tr_with_sales')).toBe(true)
    expect(await heldOwnerShareForUser(ctx.landlordUserId)).toBe(0)
  })

  it('a week of register sales alone pays out, and never twice', async () => {
    const ctx = await seedCtx()
    await hold(ctx, 42)
    transferMock.mockResolvedValueOnce({ id: 'tr_sales_only' } as any)
    expect((await reconcilePlatformHeldPayments(ctx.landlordUserId)).amount).toBe(42)
    const again = await reconcilePlatformHeldPayments(ctx.landlordUserId)
    expect(again.attempted).toBe(false)
    expect(transferMock).toHaveBeenCalledTimes(1)
  })

  it('a register-sale chargeback comes out of the next payout, recorded once', async () => {
    const ctx = await seedCtx()
    await db.query(
      `INSERT INTO pos_transactions (landlord_id, cashier_id, payment_method, subtotal, total, stripe_payment_intent_id)
       VALUES ($1, $2, 'card', 100, 103.8, 'pi_disputed')`, [ctx.landlordId, ctx.landlordUserId])
    await hold(ctx, 100)
    const { recordChargeback } = await import('./heldPayouts')
    const args = { paymentIntentId: 'pi_disputed', amountCents: 10380, feeCents: 1500, stripeDisputeId: 'dp_1' }
    expect((await recordChargeback(args)).handled).toBe(true)
    expect((await recordChargeback(args)).handled).toBe(false)  // Stripe re-delivers
    const { rows: [d] } = await db.query<any>(`SELECT amount FROM held_payout_items WHERE source_type = 'dispute'`)
    // The whole disputed charge plus Stripe's fee — GAM absorbs nothing.
    expect(Number(d.amount)).toBe(-118.8)
    await seedOwnerShareLedger(ctx, 950)
    transferMock.mockResolvedValueOnce({ id: 'tr_after_dispute' } as any)
    const res = await reconcilePlatformHeldPayments(ctx.landlordUserId)
    expect(res.amount).toBe(Math.round((950 + 100 - 118.8) * 100) / 100)
  })

  it('when chargebacks outweigh everything, nothing moves and it all carries', async () => {
    const ctx = await seedCtx()
    await hold(ctx, 20)
    await hold(ctx, -50, 'dispute')
    const res = await reconcilePlatformHeldPayments(ctx.landlordUserId)
    expect(res.attempted).toBe(false)
    expect(transferMock).not.toHaveBeenCalled()
    const { rows } = await db.query(`SELECT 1 FROM held_payout_items WHERE landlord_id = $1 AND payout_intent_id IS NULL`, [ctx.landlordId])
    expect(rows).toHaveLength(2)
  })

  it('a dispute on something GAM did not hold for anyone is left alone', async () => {
    const { recordChargeback } = await import('./heldPayouts')
    const r = await recordChargeback({ paymentIntentId: 'pi_rent_somewhere', amountCents: 100, feeCents: 0, stripeDisputeId: 'dp_x' })
    expect(r).toEqual({ handled: false, reason: 'not a held charge' })
  })
})

describe('S648 business payout batch', () => {
  async function seedBusiness(connect: string | null = 'acct_biz_s648'): Promise<{ businessId: string }> {
    const c = await db.connect()
    try {
      const { userId } = await seedLandlord(c)
      const { rows: [b] } = await c.query<{ id: string }>(
        `INSERT INTO businesses (owner_user_id, name, business_type, email, stripe_connect_account_id)
         VALUES ($1, 'Test Hauling', $2, 'biz@example.com', $3) RETURNING id`, [userId, BUSINESS_TYPES[0], connect])
      return { businessId: b.id }
    } finally { c.release() }
  }

  it('pays what GAM holds for the business in one transfer, then nothing twice', async () => {
    const { businessId } = await seedBusiness()
    const { recordHeldItem, reconcileBusinessHeldFunds, heldForBusiness } = await import('./heldPayouts')
    await recordHeldItem({ businessId, sourceType: 'business_invoice_payment', sourceId: 'cs_1', amount: 193.2 })
    await recordHeldItem({ businessId, sourceType: 'business_pos_sale', sourceId: 'tx_1', amount: 9.61 })
    await recordHeldItem({ businessId, sourceType: 'refund', sourceId: 're_1', amount: -20 })
    expect(await heldForBusiness(businessId)).toBe(182.81)
    transferMock.mockResolvedValueOnce({ id: 'tr_biz' } as any)
    const r = await reconcileBusinessHeldFunds(businessId)
    expect(r.amount).toBe(182.81)
    expect(transferMock).toHaveBeenCalledWith(expect.objectContaining({
      amount: 182.81, destinationConnectAccountId: 'acct_biz_s648',
      metadata: expect.objectContaining({ gam_business_id: businessId }),
    }))
    const { rows: [i] } = await db.query<any>(`SELECT status, stripe_transfer_id, landlord_id FROM platform_transfer_intents WHERE business_id = $1`, [businessId])
    expect(i).toMatchObject({ status: 'transferred', stripe_transfer_id: 'tr_biz', landlord_id: null })
    expect((await reconcileBusinessHeldFunds(businessId)).intentId).toBeNull()
    expect(transferMock).toHaveBeenCalledTimes(1)
  })

  it('no payout account → nothing moves', async () => {
    const { businessId } = await seedBusiness(null)
    const { recordHeldItem, reconcileBusinessHeldFunds } = await import('./heldPayouts')
    await recordHeldItem({ businessId, sourceType: 'business_pos_sale', sourceId: 'tx_2', amount: 10 })
    expect((await reconcileBusinessHeldFunds(businessId)).intentId).toBeNull()
    expect(transferMock).not.toHaveBeenCalled()
  })

  it('an item names exactly one payee', async () => {
    const { recordHeldItem } = await import('./heldPayouts')
    await expect(recordHeldItem({ sourceType: 'refund', sourceId: 'x', amount: -1 })).rejects.toThrow(/one payee/)
  })
})

// ── S655 review: A TRANSFER IS NEVER IN NO PAYOUT ──────────────────────────
//
// A GAM sweep carries every transfer dated at or before its cut, and the next
// sweep starts at that cut. The confirm used to date a transfer NOW() — when
// its transaction BEGAN — and the row only became visible at COMMIT. Begun
// before a payout's cut and committed after the payout looked for its
// transfers, it was too late for that payout and too early for the next one:
// listed in no payout, ever. Confirm and cut now share one lock per Connect
// account, and the transfer is dated when it is written.
describe('a transfer confirmed while a payout takes its cut', () => {
  const HOLD_KEY = 6550002   // the test's own lock, held to pause a confirm mid-transaction

  async function pendingIntent(ctx: Ctx, account: string, amount: number): Promise<string> {
    return (await db.query<{ id: string }>(
      `INSERT INTO platform_transfer_intents
         (landlord_id, landlord_user_id, destination_connect_account_id, amount, gross_owed, status)
       VALUES ($1,$2,$3,$4,$4,'pending') RETURNING id`,
      [ctx.landlordId, ctx.landlordUserId, account, amount])).rows[0].id
  }
  async function sweepAt(ctx: Ctx, payoutId: string, amount: number, at: Date): Promise<string> {
    return (await db.query<{ id: string }>(
      `INSERT INTO disbursements (user_id, landlord_id, trigger_type, amount, status, stripe_payout_id, initiated_at, fee_charged)
       VALUES ($1,$2,'auto_friday',$3,'processing',$4,$5,0) RETURNING id`,
      [ctx.landlordUserId, ctx.landlordId, amount, payoutId, at])).rows[0].id
  }
  async function waitersOn(key: number): Promise<number> {
    return (await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_locks
        WHERE locktype = 'advisory' AND NOT granted AND classid = 0 AND objid = $1`, [key])).rows[0].n
  }
  async function until(check: () => Promise<boolean>, what: string) {
    for (let i = 0; i < 200; i++) {
      if (await check()) return
      await new Promise(r => setTimeout(r, 25))
    }
    throw new Error(`timed out waiting for ${what}`)
  }

  it('a transfer being confirmed when the payout takes its cut is waited for, and that payout carries it', async () => {
    const ctx = await seedCtx({ connectAccount: 'acct_cut_wait' })
    const intentId = await pendingIntent(ctx, 'acct_cut_wait', 75)
    transferMock.mockResolvedValueOnce({ id: 'tr_cut_wait' } as any)

    // Pause the confirm after it has dated the transfer and before it commits.
    await db.query(`
      CREATE OR REPLACE FUNCTION zz_test_hold_confirm() RETURNS trigger AS $$
      BEGIN
        IF OLD.status = 'pending' AND NEW.status = 'transferred' THEN
          PERFORM pg_advisory_xact_lock(${HOLD_KEY});
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`)
    await db.query(`CREATE TRIGGER zz_test_hold_confirm AFTER UPDATE ON platform_transfer_intents
                      FOR EACH ROW EXECUTE FUNCTION zz_test_hold_confirm()`)
    const holder = await db.connect()
    try {
      await holder.query(`SELECT pg_advisory_lock(${HOLD_KEY})`)
      const confirming = executePlatformTransferIntent(intentId)
      confirming.catch(() => {})
      await until(async () => (await waitersOn(HOLD_KEY)) > 0, 'the confirm to be mid-transaction')

      let cut: Date | null = null
      const cutting = takePayoutCut('acct_cut_wait').then(d => { cut = d; return d })
      cutting.catch(() => {})
      // The cut waits for the transfer being confirmed.
      await new Promise(r => setTimeout(r, 300))
      expect(cut, 'the cut was taken while a transfer to the account was still being confirmed').toBeNull()

      await holder.query(`SELECT pg_advisory_unlock(${HOLD_KEY})`)
      expect(await confirming).toBe('tr_cut_wait')
      const at = await cutting

      const t = (await db.query<{ status: string; on_or_before: boolean }>(
        `SELECT status, transferred_at <= $2::timestamptz AS on_or_before
           FROM platform_transfer_intents WHERE id = $1`, [intentId, at])).rows[0]
      expect(t).toEqual({ status: 'transferred', on_or_before: true })

      // The payout made at that cut finds it, committed, and carries it.
      const sweep = await sweepAt(ctx, 'po_cut_wait', 75, at)
      const r = await stampPayoutTransfers({
        disbursementId: sweep, connectAccountId: 'acct_cut_wait', payoutAmount: 75, payoutAt: at,
      })
      expect(r.intentIds).toEqual([intentId])
      expect(r.residual).toBe(0)
    } finally {
      await holder.query(`SELECT pg_advisory_unlock_all()`).catch(() => {})
      holder.release()
      await db.query(`DROP TRIGGER IF EXISTS zz_test_hold_confirm ON platform_transfer_intents`)
      await db.query(`DROP FUNCTION IF EXISTS zz_test_hold_confirm()`)
    }
  })

  // The confirm's transaction can BEGIN before a payout's cut and reach the lock
  // only after it. Dated by when it began (NOW()), it would sit before a cut
  // whose payout never saw it, and after nothing the next payout looks at.
  it('a confirm that began before the cut but reached the lock after it is dated after the cut, so the next payout carries it', async () => {
    const ctx = await seedCtx({ connectAccount: 'acct_cut_began' })
    const intentId = await pendingIntent(ctx, 'acct_cut_began', 55)
    transferMock.mockResolvedValueOnce({ id: 'tr_cut_began' } as any)

    // A payout run holding the account's cut lock, as takePayoutCut does.
    const run = await db.connect()
    let at!: Date
    try {
      await run.query('BEGIN')
      await run.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [payoutCutLockKey('acct_cut_began')])
      const confirming = executePlatformTransferIntent(intentId)
      confirming.catch(() => {})
      await until(async () => (await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`)).rows[0].n > 0,
        'the confirm to wait on the cut lock')
      at = await cutUnderLock(run)
      await run.query('COMMIT')
      expect(await confirming).toBe('tr_cut_began')
    } finally { run.release() }

    const after = (await db.query<{ after: boolean }>(
      `SELECT transferred_at > $2::timestamptz AS after FROM platform_transfer_intents WHERE id = $1`,
      [intentId, at])).rows[0].after
    expect(after, 'the transfer was dated before a cut it was not visible to').toBe(true)

    const first = await sweepAt(ctx, 'po_cut_began', 0.01, at)
    expect((await stampPayoutTransfers({
      disbursementId: first, connectAccountId: 'acct_cut_began', payoutAmount: 0.01, payoutAt: at,
    })).intentIds).toEqual([])
    const nextAt = (await db.query<{ at: Date }>(`SELECT clock_timestamp() AS at`)).rows[0].at
    const next = await sweepAt(ctx, 'po_cut_began_next', 55, nextAt)
    expect((await stampPayoutTransfers({
      disbursementId: next, connectAccountId: 'acct_cut_began', payoutAmount: 55, payoutAt: nextAt,
    })).intentIds).toEqual([intentId])
  })

  // A batch netted down to $0 makes no Stripe call and has no confirm: the
  // reserve writes it already 'transferred'. Dated by the app's clock without
  // the cut lock, it could sit before a sweep's cut and commit after that
  // sweep looked — in no payout, and the payments netted inside it listed in
  // no payout breakdown.
  it('a batch netted down to $0 while a payout takes its cut waits for the cut, is dated after it, and the next payout carries it', async () => {
    const ctx = await seedCtx({ connectAccount: 'acct_cut_netted' })
    await seedOwnerShareLedger(ctx, 200)
    // The landlord owes back exactly what this batch would pay: it nets to $0.
    await db.query(
      `INSERT INTO payment_reversals
         (payment_id, landlord_id, reversal_type, reversed_amount, reversal_fee,
          stripe_event_id, raw_event, recovery_method, recovery_status, status)
       VALUES ($1,$2,'ach_unauthorized',200,4,'evt_net_cut','{}','netting','scheduled_netting','recovering')`,
      [ctx.paymentId, ctx.landlordId])

    // A payout run holding the account's cut lock, as takePayoutCut does.
    const run = await db.connect()
    let at!: Date
    try {
      await run.query('BEGIN')
      await run.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [payoutCutLockKey('acct_cut_netted')])
      const reserving = reconcilePlatformHeldPayments(ctx.landlordUserId)
      reserving.catch(() => {})
      await until(async () => (await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`)).rows[0].n > 0,
        'the netted batch to wait on the cut lock')
      at = await cutUnderLock(run)
      await run.query('COMMIT')
      expect((await reserving).transfer_id).toMatch(/^netted:/)
    } finally { run.release() }
    expect(transferMock).not.toHaveBeenCalled()

    const rows = (await db.query<{ id: string; status: string; amount: number; after: boolean }>(
      `SELECT id, status, amount::float AS amount, transferred_at > $2::timestamptz AS after
         FROM platform_transfer_intents WHERE landlord_id = $1`, [ctx.landlordId, at])).rows
    expect(rows).toHaveLength(1)
    expect(rows[0], 'the netted batch was dated before a cut it was not visible to')
      .toMatchObject({ status: 'transferred', amount: 0, after: true })

    const first = await sweepAt(ctx, 'po_cut_netted', 0.01, at)
    expect((await stampPayoutTransfers({
      disbursementId: first, connectAccountId: 'acct_cut_netted', payoutAmount: 0.01, payoutAt: at,
    })).intentIds).toEqual([])
    const nextAt = (await db.query<{ at: Date }>(`SELECT clock_timestamp() AS at`)).rows[0].at
    const next = await sweepAt(ctx, 'po_cut_netted_next', 0.01, nextAt)
    expect((await stampPayoutTransfers({
      disbursementId: next, connectAccountId: 'acct_cut_netted', payoutAmount: 0.01, payoutAt: nextAt,
    })).intentIds).toEqual([rows[0].id])
  })

  it('a transfer confirmed after the cut is dated after it: that payout leaves it, the next payout carries it', async () => {
    const ctx = await seedCtx({ connectAccount: 'acct_cut_after' })
    const intentId = await pendingIntent(ctx, 'acct_cut_after', 40)
    transferMock.mockResolvedValueOnce({ id: 'tr_cut_after' } as any)

    const at = await takePayoutCut('acct_cut_after')
    expect(await executePlatformTransferIntent(intentId)).toBe('tr_cut_after')
    const after = (await db.query<{ after: boolean }>(
      `SELECT transferred_at > $2::timestamptz AS after FROM platform_transfer_intents WHERE id = $1`,
      [intentId, at])).rows[0].after
    expect(after).toBe(true)

    const first = await sweepAt(ctx, 'po_cut_first', 0.01, at)
    const r1 = await stampPayoutTransfers({
      disbursementId: first, connectAccountId: 'acct_cut_after', payoutAmount: 0.01, payoutAt: at,
    })
    expect(r1.intentIds).toEqual([])

    const nextAt = (await db.query<{ at: Date }>(`SELECT clock_timestamp() AS at`)).rows[0].at
    const next = await sweepAt(ctx, 'po_cut_next', 40, nextAt)
    const r2 = await stampPayoutTransfers({
      disbursementId: next, connectAccountId: 'acct_cut_after', payoutAmount: 40, payoutAt: nextAt,
    })
    expect(r2.intentIds).toEqual([intentId])
    expect(r2.residual).toBe(0)
  })

  // The cut is stored in whole milliseconds. Cut down to the millisecond, a
  // transfer confirmed just before it, in the same millisecond, was dated after
  // it — its money in this payout, its line on the next. Rounded up without
  // waiting, one confirmed just after could be dated at or before it.
  it('a transfer dated just before the cut is inside it and one dated just after is outside it, even within the same millisecond', async () => {
    const clock = async () => (await db.query<{ t: string }>(`SELECT clock_timestamp()::text AS t`)).rows[0].t
    const inside = async (t: string, cut: Date) =>
      (await db.query<{ ok: boolean }>(`SELECT $1::timestamptz <= $2::timestamptz AS ok`, [t, cut])).rows[0].ok
    for (let i = 0; i < 40; i++) {
      const before = await clock()
      const cut = await takePayoutCut('acct_cut_ms')
      const after = await clock()
      expect(await inside(before, cut), `dated ${before}, before a cut at ${cut.toISOString()}`).toBe(true)
      expect(await inside(after, cut), `dated ${after}, after a cut at ${cut.toISOString()}`).toBe(false)
    }
  })
})

/**
 * S655 money plan Step 7 — the three paths that delete unpaid charge rows
 * (a voided lease's unwind, a shortened stay, a reservation's fee when the
 * reservation is canceled or released) never lose a credit record.
 *
 * The rules (the database enforces the first two, M4):
 *   - a credit use is never deleted; a use given back (released) keeps its
 *     record with no target when its unpaid row is removed;
 *   - a row carrying a live use (held or applied) cannot be deleted;
 *   - a row a payment was TRIED on — a bank or card payment that bounced or is
 *     being retried, a receipt applied to it, credit a payment set aside on it —
 *     is a record GAM keeps (Nic: "GAM never erases"; the receipt's foreign key
 *     refuses the delete anyway). The void is refused in plain words before
 *     anything changes; a canceled or released reservation's fee is voided as
 *     a kept record (decisions #48.5: status 'voided', in no balance);
 *   - the hourly event sweep never releases an event while a bank retry still
 *     to come carries its deposit (decisions #52: a payment in flight decides —
 *     cleared keeps the event, failed for good releases it);
 *   - a voided fee is no longer owed, so a bank retry still to come for that
 *     fee ALONE is stopped first (a cancel): its held credit is released and the retry is
 *     canceled (plan: supersedeScheduledRetry before the delete). A retry that
 *     also carries the household's rent is never sent for the full amount once
 *     the fee is voided (achRetry: a line paid another way): the rent is owed
 *     again and the tenant is asked to pay; the fee's money is never pulled.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { PoolClient } from 'pg'
import { db, getClient } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant, seedLease, seedLeaseTenant, seedAllocationRule,
} from '../test/dbHelpers'

vi.mock('../services/email', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, sendNotificationEmail: vi.fn(async () => null) }
})
// A stopped bank retry is canceled at Stripe after the commit.
const stripeCancel = vi.hoisted(() => vi.fn(async (id: string) => ({ id, status: 'canceled' })))
vi.mock('../lib/stripe', async (orig) => ({
  ...(await orig<typeof import('./stripe')>()),
  getStripe: () => ({ paymentIntents: { cancel: stripeCancel } }),
}))

// The 15-minute cancel job must never send a new lease it has to hold to the
// void (which refuses it) — counted here.
const voidCalls = vi.hoisted(() => ({ n: 0 }))
vi.mock('./voidDocument', async (orig) => {
  const real = await orig<typeof import('./voidDocument')>()
  return { ...real, voidDocument: async (...a: Parameters<typeof real.voidDocument>) => { voidCalls.n++; return real.voidDocument(...a) } }
})

import { unwindIssuedLease, returnDepositCountedOnce } from './unwindIssuedLease'
import { processTenantEvents, processNewLeaseSignings } from '../jobs/scheduler'
import { handlePaymentReversal } from '../services/paymentReversal'
import { reconcileSettledDepositPayment } from '../services/leaseFeesSync'
import { backfillInvoices } from '../jobs/invoiceGeneration'
import { syncLeaseWithBookingDates } from '../services/bookingLeaseBilling'
import { createIssuedCredit, holdCredit, releaseHeldForRemittance } from '../services/creditUse'
import { settleManualRentPayment } from '../services/manualPaymentSettle'
import { lockHousehold } from '../services/moneyPredicates'

interface Fx { userId: string; landlordId: string; propertyId: string; unitId: string; tenantId: string; leaseId: string }

async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await getClient()
  try {
    await c.query('BEGIN')
    const r = await fn(c)
    await c.query('COMMIT')
    return r
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {})
    throw e
  } finally { c.release() }
}

async function fixture(o: { rent?: number; start?: string } = {}): Promise<Fx> {
  return tx(async c => {
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    await seedAllocationRule(c, { propertyId, achFeePayer: 'tenant', cardFeePayer: 'tenant' })
    const unitId = await seedUnit(c, { propertyId, landlordId })
    const tenantId = await seedTenant(c)
    const leaseId = await seedLease(c, { unitId, landlordId, rentAmount: o.rent ?? 460, startDate: o.start ?? '2026-10-01' })
    await seedLeaseTenant(c, { leaseId, tenantId, role: 'primary' })
    return { userId, landlordId, propertyId, unitId, tenantId, leaseId }
  })
}

async function row(f: Fx, o: { amount: number; type?: string; entry?: string; status?: string; intent?: string | null;
  nextRetryAt?: string | null; due?: string }): Promise<string> {
  return (await db.query<{ id: string }>(
    `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description,
                           stripe_payment_intent_id, next_retry_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [f.unitId, f.leaseId, f.tenantId, f.landlordId, o.type ?? 'rent', o.amount.toFixed(2), o.status ?? 'pending',
     o.due ?? '2026-10-01', o.entry ?? 'RENT', o.intent ?? null, o.nextRetryAt ?? null])).rows[0].id
}

async function remittance(f: Fx, intent: string | null): Promise<string> {
  return (await db.query<{ id: string }>(
    `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, unapplied_amount,
                                     status, payment_method, stripe_payment_intent_id, processing_fee_amount)
     VALUES ($1,$2,$3,1,1,0,'processing','ach',$4,0) RETURNING id`,
    [f.tenantId, f.leaseId, f.landlordId, intent])).rows[0].id
}

/** $amount of a lease credit set aside on `paymentId` by a charge (remittance `rem`). */
async function hold(f: Fx, paymentId: string, amount: number, rem: string, leaseId = f.leaseId): Promise<string> {
  const creditId = await tx(c => createIssuedCredit(c, {
    landlordId: f.landlordId, tenantId: f.tenantId, leaseId, amount, category: 'goodwill', reason: 'test', createdBy: f.userId }))
  await tx(c => holdCredit(c, [{ creditKind: 'issued', creditId, paymentId, leaseId, amount, billingMonth: '2026-10-01' }],
    { remittanceId: rem, source: 'portal' }))
  return creditId
}

const exists = async (id: string) => (await db.query(`SELECT 1 FROM payments WHERE id = $1`, [id])).rows.length === 1
const usesOf = async (creditId: string) => (await db.query<{ status: string; payment_id: string | null }>(
  `SELECT status, payment_id FROM credit_uses WHERE tenant_credit_id = $1`, [creditId])).rows
const remaining = async (creditId: string) =>
  Number((await db.query<{ r: string }>(`SELECT amount_remaining::text AS r FROM tenant_credits WHERE id = $1`, [creditId])).rows[0].r)

/** An event booked by the tenant, its start just passed, its $50 deposit charge `feeId`. */
async function unpaidEvent(f: Fx, feeId: string): Promise<string> {
  const area = (await db.query<{ id: string }>(
    `INSERT INTO common_areas (property_id, landlord_id, name, events_enabled, event_deposit_amount, event_auto_release)
     VALUES ($1,$2,'Clubhouse',TRUE,50,TRUE) RETURNING id`, [f.propertyId, f.landlordId])).rows[0].id
  return (await db.query<{ id: string }>(
    `INSERT INTO common_area_reservations
       (common_area_id, property_id, landlord_id, reserved_by_tenant_id, created_by_user_id, kind, starts_at, ends_at, status, fee_amount, fee_payment_id)
     VALUES ($1,$2,$3,$4,(SELECT user_id FROM tenants WHERE id = $4),'event', now() - interval '1 minute', now() + interval '3 hours','approved',50,$5) RETURNING id`,
    [area, f.propertyId, f.landlordId, f.tenantId, feeId])).rows[0].id
}

beforeEach(async () => { await cleanupAllSchema(); stripeCancel.mockClear(); voidCalls.n = 0 })

describe('deleting unpaid charges keeps every credit record', () => {
  it('unwind, stay shortening and common-area release delete unpaid charges that carry only released credit', async () => {
    // ── A reservation released at its start with the deposit unpaid ──
    const a = await fixture()
    const fee = await row(a, { amount: 50, type: 'fee', entry: 'OTHERFEE' })
    // A payment once set $50 of credit aside on the deposit, then failed: given back.
    const aRem = await remittance(a, null)
    const aCredit = await hold(a, fee, 50, aRem)
    await tx(c => releaseHeldForRemittance(c, aRem, 'payment_failed'))
    const reservation = await unpaidEvent(a, fee)
    await processTenantEvents()
    expect(await exists(fee)).toBe(false)
    expect(await usesOf(aCredit)).toEqual([{ status: 'released', payment_id: null }])
    expect(await remaining(aCredit)).toBe(50)
    const res = (await db.query<{ status: string; fee_voided: boolean }>(
      `SELECT status, fee_voided FROM common_area_reservations WHERE id = $1`, [reservation])).rows[0]
    expect(res).toEqual({ status: 'cancelled', fee_voided: true })

    // ── A lease voided before the tenant signed ──
    const b = await fixture()
    const rent = await row(b, { amount: 460 })
    const bRem = await remittance(b, null)
    const bCredit = await hold(b, rent, 60, bRem)
    await tx(c => releaseHeldForRemittance(c, bRem, 'payment_canceled'))
    const out = await tx(c => unwindIssuedLease(c.query.bind(c) as any,
      { id: '00000000-0000-0000-0000-000000000001', lease_id: b.leaseId, issued_at: new Date(), unit_id: b.unitId }))
    expect(out.unwound).toBe(true)
    expect(await exists(rent)).toBe(false)
    expect(await usesOf(bCredit)).toEqual([{ status: 'released', payment_id: null }])
    expect(await remaining(bCredit)).toBe(60)

    // ── A stay shortened on the schedule ──
    const s = await fixture({ rent: 950, start: '2026-08-10' })
    const booking = (await db.query<{ id: string }>(
      `INSERT INTO unit_bookings (unit_id, landlord_id, lease_type, check_in, check_out, nights, guest_name, guest_email, status, source)
       VALUES ($1,$2,'month_to_month','2026-08-10','2027-01-28',171,'Sched Guest','sched-guest@test.dev','confirmed','public') RETURNING id`,
      [s.unitId, s.landlordId])).rows[0].id
    await db.query(
      `UPDATE leases SET lease_source='booking_draft', source_booking_id=$2, end_date='2027-01-28', needs_review=false WHERE id=$1`,
      [s.leaseId, booking])
    await backfillInvoices({ from: '2026-08-01', to: '2027-02-28', leaseId: s.leaseId })
    const december = (await db.query<{ id: string }>(
      `SELECT id FROM payments WHERE lease_id = $1 AND type = 'rent' AND due_date = '2026-12-01'`, [s.leaseId])).rows[0].id
    const sRem = await remittance(s, null)
    const sCredit = await hold(s, december, 100, sRem)
    await tx(c => releaseHeldForRemittance(c, sRem, 'superseded'))
    await db.query(`UPDATE unit_bookings SET check_out = '2026-11-15', nights = 97 WHERE id = $1`, [booking])
    await syncLeaseWithBookingDates(booking)
    expect(await exists(december)).toBe(false)
    expect(await usesOf(sCredit)).toEqual([{ status: 'released', payment_id: null }])
    expect(await remaining(sCredit)).toBe(100)
  })

  it('the database refuses to delete a charge a payment has set credit aside on', async () => {
    const f = await fixture()
    const rent = await row(f, { amount: 460, status: 'processing', intent: 'pi_inflight' })
    await hold(f, rent, 40, await remittance(f, 'pi_inflight'))
    await db.query(`UPDATE payments SET status = 'pending' WHERE id = $1`, [rent])
    await expect(db.query(`DELETE FROM payments WHERE id = $1`, [rent])).rejects.toThrow(/has account credit on it and cannot be deleted/)
  })
})

describe('a charge a payment was tried on is never deleted', () => {
  /**
   * A bank payment bounced and is due to be tried again; $40 of credit rides
   * it, set aside. `withRent`: the same pull also paid the household's $460
   * rent (it bounced with it, and is retried with it).
   */
  async function bouncedWithRetry(f: Fx, o: { amount: number; type?: string; entry?: string; withRent?: boolean }) {
    const id = await row(f, { amount: o.amount, type: o.type, entry: o.entry, status: 'processing', intent: 'pi_bounced' })
    const rent = o.withRent ? await row(f, { amount: 460, status: 'processing', intent: 'pi_bounced' }) : null
    const rem = await remittance(f, 'pi_bounced')
    await db.query(`INSERT INTO remittance_applications (remittance_id, payment_id, amount_applied) VALUES ($1,$2,$3)`,
      [rem, id, (o.amount - 40).toFixed(2)])
    if (rent) {
      await db.query(`INSERT INTO remittance_applications (remittance_id, payment_id, amount_applied) VALUES ($1,$2,460)`, [rem, rent])
    }
    const creditId = await hold(f, id, 40, rem)
    await db.query(`UPDATE payments SET status = 'failed', next_retry_at = now() + interval '3 days' WHERE id = ANY($1::uuid[])`,
      [[id, ...(rent ? [rent] : [])]])
    return { id, rent, creditId }
  }
  const retryOf = async (id: string) => (await db.query<{ status: string; retry: Date | null }>(
    `SELECT status, next_retry_at AS retry FROM payments WHERE id = $1`, [id])).rows[0]

  it('voiding a lease whose bill a payment was tried on is refused in plain words, and nothing changes', async () => {
    const f = await fixture()
    const x = await bouncedWithRetry(f, { amount: 460 })
    await expect(tx(c => unwindIssuedLease(c.query.bind(c) as any,
      { id: '00000000-0000-0000-0000-000000000002', lease_id: f.leaseId, issued_at: new Date(), unit_id: f.unitId })))
      .rejects.toThrow(/A payment was tried on this lease's bill .* Create a superseding document instead\./)
    const p = (await db.query<{ status: string; retry: Date | null }>(
      `SELECT status, next_retry_at AS retry FROM payments WHERE id = $1`, [x.id])).rows[0]
    expect(p.status).toBe('failed')
    expect(p.retry).not.toBeNull()
    expect(await usesOf(x.creditId)).toEqual([{ status: 'held', payment_id: x.id }])
    expect((await db.query<{ status: string }>(`SELECT status FROM leases WHERE id = $1`, [f.leaseId])).rows[0].status).toBe('active')
  })

  // decisions #52 (renamed from "they release held credit and cancel the
  // retry first: a released reservation's deposit retried alone is never
  // pulled again and is voided as a kept record", which released the event
  // and stopped the retry while that retry still carried the deposit): a
  // scheduled bank retry is a payment in flight (#46.1b), so the event waits
  // for it. Failed for good, the deposit nobody owes is voided as a kept
  // record (#48.5) — not deleted, in no balance, nothing left to review.
  it('a reservation deposit retried alone keeps the event while the retry is to come; once the retry fails for good the event is released and the deposit voided as a kept record', async () => {
    const f = await fixture()
    const x = await bouncedWithRetry(f, { amount: 50, type: 'fee', entry: 'OTHERFEE' })
    const reservation = await unpaidEvent(f, x.id)
    const resRow = async () => (await db.query<{ status: string; fee_voided: boolean; fee_payment_id: string | null }>(
      `SELECT status, fee_voided, fee_payment_id FROM common_area_reservations WHERE id = $1`, [reservation])).rows[0]
    await processTenantEvents()

    // The retry may still bring the money: nothing changes, nothing is stopped.
    expect(await resRow()).toEqual({ status: 'approved', fee_voided: false, fee_payment_id: x.id })
    expect((await retryOf(x.id)).retry).not.toBeNull()
    expect(stripeCancel).not.toHaveBeenCalled()
    expect(await usesOf(x.creditId)).toEqual([{ status: 'held', payment_id: x.id }])

    // The retry bounced for good: its schedule is cleared and the credit it
    // set aside is given back (the webhook's final-failure path).
    await db.query(`UPDATE payments SET next_retry_at = NULL, retry_count = 2 WHERE id = $1`, [x.id])
    const rem = (await db.query<{ id: string }>(`SELECT id FROM tenant_remittances WHERE stripe_payment_intent_id = 'pi_bounced'`)).rows[0].id
    await tx(c => releaseHeldForRemittance(c, rem, 'payment_failed'))
    await processTenantEvents()

    // The event is released: the space is open to everyone again.
    expect(await resRow()).toEqual({ status: 'cancelled', fee_voided: true, fee_payment_id: x.id })
    // The deposit is no longer owed; the credit is the tenant's again.
    expect(await retryOf(x.id)).toEqual({ status: 'voided', retry: null })
    expect(stripeCancel).not.toHaveBeenCalled()
    expect(await usesOf(x.creditId)).toEqual([{ status: 'released', payment_id: x.id }])
    expect(await remaining(x.creditId)).toBe(40)
    // The charge a payment was tried on is kept as the record.
    expect(await exists(x.id)).toBe(true)
    // Nothing is left for anyone to review, and the release notice does not
    // say the deposit still shows.
    expect((await db.query(`SELECT 1 FROM admin_notifications WHERE category = 'reservation_fee_kept'`)).rowCount).toBe(0)
    const notice = (await db.query<{ body: string }>(
      `SELECT n.body FROM notifications n JOIN tenants t ON t.user_id = n.user_id WHERE t.id = $1 AND n.type = 'amenity_unavailable'`,
      [f.tenantId])).rows
    expect(notice).toHaveLength(1)
    expect(notice[0].body).toMatch(/The space is open to everyone as usual\.$/)
    expect(notice[0].body).not.toMatch(/still shows/)
  })

  // decisions #52 (renamed from "a retry that also carries the household's
  // rent is left to run: the deposit is kept and the tenant and GAM are told
  // the same reason", which released the event while the retry still carried
  // the deposit — the tenant would pay for an event that no longer existed):
  // the retry bundled with rent is a payment in flight, so the event waits.
  it('a retry that also carries the household\'s rent keeps the event until it is decided: nothing is stopped, nobody is told, and the retry clearing keeps the event', async () => {
    const f = await fixture()
    const x = await bouncedWithRetry(f, { amount: 50, type: 'fee', entry: 'OTHERFEE', withRent: true })
    const reservation = await unpaidEvent(f, x.id)
    await processTenantEvents()

    expect((await db.query<{ status: string; fee_voided: boolean }>(
      `SELECT status, fee_voided FROM common_area_reservations WHERE id = $1`, [reservation])).rows[0])
      .toEqual({ status: 'approved', fee_voided: false })
    // Nothing is stopped: the deposit and the rent keep the retry they share,
    // and the credit the pull set aside stays with it.
    expect((await retryOf(x.id)).status).toBe('failed')
    expect((await retryOf(x.id)).retry).not.toBeNull()
    expect((await retryOf(x.rent!)).retry).not.toBeNull()
    expect(stripeCancel).not.toHaveBeenCalled()
    expect(await usesOf(x.creditId)).toEqual([{ status: 'held', payment_id: x.id }])
    expect((await db.query(`SELECT 1 FROM admin_notifications WHERE category = 'reservation_fee_kept'`)).rowCount).toBe(0)
    expect((await db.query(
      `SELECT 1 FROM notifications n JOIN tenants t ON t.user_id = n.user_id WHERE t.id = $1 AND n.type = 'amenity_unavailable'`,
      [f.tenantId])).rowCount).toBe(0)

    // The retry ran and cleared: the deposit is paid, the event is theirs.
    await db.query(`UPDATE payments SET status = 'settled', settled_at = now(), next_retry_at = NULL WHERE id = ANY($1::uuid[])`,
      [[x.id, x.rent]])
    await processTenantEvents()
    expect((await db.query<{ status: string; fee_voided: boolean }>(
      `SELECT status, fee_voided FROM common_area_reservations WHERE id = $1`, [reservation])).rows[0])
      .toEqual({ status: 'approved', fee_voided: false })
  })

  it('a shared retry with nothing left to come is no reason to keep the deposit: it is voided as a record', async () => {
    const f = await fixture()
    const x = await bouncedWithRetry(f, { amount: 50, type: 'fee', entry: 'OTHERFEE', withRent: true })
    // The bank retries ran out: nothing will pull the deposit or the rent again.
    await db.query(`UPDATE payments SET next_retry_at = NULL WHERE id = ANY($1::uuid[])`, [[x.id, x.rent]])
    const rem = (await db.query<{ id: string }>(`SELECT id FROM tenant_remittances WHERE stripe_payment_intent_id = 'pi_bounced'`)).rows[0].id
    await tx(c => releaseHeldForRemittance(c, rem, 'payment_failed'))
    const reservation = await unpaidEvent(f, x.id)
    await processTenantEvents()
    expect((await db.query<{ fee_voided: boolean }>(
      `SELECT fee_voided FROM common_area_reservations WHERE id = $1`, [reservation])).rows[0].fee_voided).toBe(true)
    expect(await retryOf(x.id)).toEqual({ status: 'voided', retry: null })
    expect(await retryOf(x.rent!)).toEqual({ status: 'failed', retry: null })   // still owed
    expect(stripeCancel).not.toHaveBeenCalled()
    expect((await db.query(`SELECT 1 FROM admin_notifications WHERE category = 'reservation_fee_kept'`)).rowCount).toBe(0)
  })
})

describe('a new lease that will not go ahead hands the deposit back counted once', () => {
  /**
   * The household's $500 deposit, fully paid on the lease they are on, was
   * moved onto the new lease (a renewal), which raised it to $600: a $100
   * top-up billed on the new lease. `topUp` is what became of that top-up
   * payment ('settled', 'returned', or none).
   */
  async function renewalWithDeposit(o: { topUp: 'settled' | 'returned' | null; collectedBefore?: number; petDeposit?: boolean;
    /** The lease they are on ended early, nobody signed the renewal: the 15-minute job's case. */
    endedEarly?: boolean }) {
    const f = await fixture({ start: '2025-10-01' })
    const before = o.collectedBefore ?? 500
    return tx(async c => {
      const renewalId = (await c.query<{ id: string }>(
        `INSERT INTO leases (unit_id, landlord_id, rent_amount, lease_type, status, start_date, supersedes_lease_id, lease_source,
                             signed_by_landlord)
         VALUES ($1,$2,480,'month_to_month','pending','2026-11-01',$3,'esigned',TRUE) RETURNING id`,
        [f.unitId, f.landlordId, f.leaseId])).rows[0].id
      if (o.endedEarly) {
        await c.query(`UPDATE leases SET status = 'terminated', terminated_at = now() - interval '1 day' WHERE id = $1`, [f.leaseId])
      }
      await seedLeaseTenant(c, { leaseId: renewalId, tenantId: f.tenantId, role: 'primary' })
      await c.query(
        `INSERT INTO lease_fees (lease_id, fee_type, amount, is_refundable, due_timing, description, money_kind)
         VALUES ($1,'security_deposit',100,TRUE,'move_in','[deposit top-up on renewal] $500.00 carried + $100.00 newly billed','deposit')`,
        [renewalId])
      const paidTopUp = o.topUp ? 100 : 0
      const collected = before + paidTopUp
      const depositId = (await c.query<{ id: string }>(
        `INSERT INTO security_deposits (unit_id, lease_id, tenant_id, total_amount, collected_amount, status, held_by)
         VALUES ($1,$2,$3,600,$4,$5,'landlord') RETURNING id`,
        [f.unitId, renewalId, f.tenantId, collected, collected >= 600 ? 'funded' : 'partial'])).rows[0].id
      if (o.topUp) {
        // Paid by bank or card: Stripe settled it, and its webhook raised the
        // record (the only settle that does — see 'paid in cash at the desk').
        await c.query(
          `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, settled_at,
                                 stripe_payment_intent_id)
           VALUES ($1,$2,$3,$4,'deposit',100,$5,'2026-10-20','DEPOSIT', now(), 'pi_renewal_topup')`,
          [f.unitId, renewalId, f.tenantId, f.landlordId, o.topUp])
      }
      if (o.petDeposit) {
        // A pet deposit paid on the new lease is its own deposit: it never fed this record.
        const petFee = (await c.query<{ id: string }>(
          `INSERT INTO lease_fees (lease_id, fee_type, amount, is_refundable, due_timing, money_kind)
           VALUES ($1,'pet_deposit',150,TRUE,'move_in','deposit') RETURNING id`, [renewalId])).rows[0].id
        await c.query(
          `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, lease_fee_id, settled_at)
           VALUES ($1,$2,$3,$4,'deposit',150,'settled','2026-10-20','DEPOSIT',$5, now())`,
          [f.unitId, renewalId, f.tenantId, f.landlordId, petFee])
      }
      const docId = (await c.query<{ id: string }>(
        `INSERT INTO lease_documents (landlord_id, title, status, renews_lease_id, lease_id, issued_at)
         VALUES ($1,'Renewal','pending',$2,$3, now()) RETURNING id`, [f.landlordId, f.leaseId, renewalId])).rows[0].id
      const topUpId = o.topUp ? (await c.query<{ id: string }>(
        `SELECT id FROM payments WHERE lease_id = $1 AND type = 'deposit' AND lease_fee_id IS NULL`, [renewalId])).rows[0].id : null
      return { ...f, renewalId, depositId, docId, topUpId }
    })
  }
  const deposit = async (id: string) => (await db.query<{ lease_id: string; total: string; collected: string; status: string }>(
    `SELECT lease_id, total_amount::text AS total, collected_amount::text AS collected, status FROM security_deposits WHERE id = $1`,
    [id])).rows[0]

  it('a new lease held with its top-up still to be returned: the lease that ended gets its $500, not $600', async () => {
    const r = await renewalWithDeposit({ topUp: 'settled', petDeposit: true })
    const moved = await tx(c => returnDepositCountedOnce(c.query.bind(c) as any, r.renewalId, r.leaseId))
    expect(moved).toBe(1)
    expect(await deposit(r.depositId)).toEqual({ lease_id: r.leaseId, total: '500.00', collected: '500.00', status: 'funded' })
    // The job runs again until the document is stamped: nothing moves twice.
    expect(await tx(c => returnDepositCountedOnce(c.query.bind(c) as any, r.renewalId, r.leaseId))).toBe(0)
    expect(await deposit(r.depositId)).toEqual({ lease_id: r.leaseId, total: '500.00', collected: '500.00', status: 'funded' })
  })

  /** The bank sends the renewal's $100 top-up back — the real path: the top-up is marked returned and reopened. */
  const bankReturnsTopUp = (r: { topUpId: string | null }) => handlePaymentReversal({
    paymentId: r.topUpId!, reversalType: 'ach_return', reversedAmount: 100, reversalFee: 0,
    stripeEventId: `evt_topup_returned_${r.topUpId}`, rawEvent: {},
  })

  it('a renewal whose top-up the bank sent back cannot be voided: the reopened charge is a payment tried on its bill', async () => {
    const r = await renewalWithDeposit({ topUp: 'settled' })
    expect((await bankReturnsTopUp(r)).handled).toBe(true)
    await expect(tx(c => unwindIssuedLease(c.query.bind(c) as any,
      { id: r.docId, lease_id: r.renewalId, issued_at: new Date(), unit_id: r.unitId })))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/^A payment was tried on this lease's bill/) })
    // Nothing changed: the deposit record is still on the renewal, at what it showed.
    expect(await deposit(r.depositId)).toEqual({ lease_id: r.renewalId, total: '600.00', collected: '600.00', status: 'funded' })
  })

  it('the job holding a new lease that never starts hands the deposit back at what was really paid when the bank sent the top-up back, then cancels it', async () => {
    const r = await renewalWithDeposit({ topUp: 'settled', endedEarly: true })
    expect((await bankReturnsTopUp(r)).handled).toBe(true)

    await processNewLeaseSignings({ hour: 3 })
    // The returned $100 never counted: the lease that ended gets its $500.
    expect(await deposit(r.depositId)).toEqual({ lease_id: r.leaseId, total: '500.00', collected: '500.00', status: 'funded' })
    // The reopened top-up was never owed (the lease never starts) and came off,
    // so nothing holds it: no "can't be canceled" notice, no stamp, no void tried yet.
    expect(voidCalls.n).toBe(0)
    const doc1 = (await db.query<{ status: string; held: Date | null }>(
      `SELECT status, new_lease_cancel_held_at AS held FROM lease_documents WHERE id = $1`, [r.docId])).rows[0]
    expect(doc1).toEqual({ status: 'pending', held: null })

    await processNewLeaseSignings({ hour: 3 })
    // The next run cancels it, and the landlord hears exactly that, once.
    expect(voidCalls.n).toBe(1)
    expect((await db.query<{ status: string }>(`SELECT status FROM lease_documents WHERE id = $1`, [r.docId])).rows[0].status).toBe('voided')
    expect((await db.query<{ status: string }>(`SELECT status FROM leases WHERE id = $1`, [r.renewalId])).rows[0].status).toBe('terminated')
    expect(await deposit(r.depositId)).toEqual({ lease_id: r.leaseId, total: '500.00', collected: '500.00', status: 'funded' })
    const told = (await db.query<{ title: string }>(
      `SELECT n.title FROM notifications n JOIN landlords l ON l.user_id = n.user_id
        WHERE l.id = $1 AND n.type = 'lease_renewal_status'`, [r.landlordId])).rows
    expect(told.map(x => x.title)).toEqual([expect.stringMatching(/^New lease canceled — /)])
  })

  it('a new lease whose bill had a bounced payment is held and told once, not retried every run', async () => {
    const r = await renewalWithDeposit({ topUp: null, endedEarly: true })
    // The household paid the renewal's first rent by bank; it bounced, and a
    // retry is due in three days. The pull was for this bill alone.
    const rent = (await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description,
                             stripe_payment_intent_id, next_retry_at)
       VALUES ($1,$2,$3,$4,'rent',480,'failed','2026-11-01','RENT','pi_new_lease_bounced', now() + interval '3 days') RETURNING id`,
      [r.unitId, r.renewalId, r.tenantId, r.landlordId])).rows[0].id
    const rem = (await db.query<{ id: string }>(
      `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, unapplied_amount,
                                       status, payment_method, stripe_payment_intent_id, processing_fee_amount)
       VALUES ($1,$2,$3,486,480,0,'failed','ach','pi_new_lease_bounced',6) RETURNING id`,
      [r.tenantId, r.renewalId, r.landlordId])).rows[0].id
    await db.query(`INSERT INTO remittance_applications (remittance_id, payment_id, amount_applied) VALUES ($1,$2,480)`, [rem, rent])

    for (let run = 0; run < 3; run++) await processNewLeaseSignings({ hour: 3 })

    // Never sent to the void (which refuses it) — not once, let alone every run.
    expect(voidCalls.n).toBe(0)
    const doc = (await db.query<{ status: string; held: Date | null }>(
      `SELECT status, new_lease_cancel_held_at AS held FROM lease_documents WHERE id = $1`, [r.docId])).rows[0]
    expect(doc.status).toBe('pending')
    expect(doc.held).not.toBeNull()
    // Held like a paid one: the deposit record is back on the lease that ended.
    expect(await deposit(r.depositId)).toEqual({ lease_id: r.leaseId, total: '500.00', collected: '500.00', status: 'funded' })
    // The retry would have pulled money for a lease that never starts: stopped, and canceled at Stripe once.
    expect((await db.query<{ status: string; retry: Date | null }>(
      `SELECT status, next_retry_at AS retry FROM payments WHERE id = $1`, [rent])).rows[0]).toEqual({ status: 'failed', retry: null })
    expect(stripeCancel.mock.calls).toEqual([['pi_new_lease_bounced']])
    // The bounced charge is the payment's record: kept, for GAM to take off.
    expect(await exists(rent)).toBe(true)
    // The landlord side hears once, in words that fit (no "$0.00 was paid").
    const told = (await db.query<{ title: string; body: string }>(
      `SELECT n.title, n.body FROM notifications n JOIN landlords l ON l.user_id = n.user_id
        WHERE l.id = $1 AND n.type = 'lease_renewal_status'`, [r.landlordId])).rows
    expect(told).toHaveLength(1)
    expect(told[0].title).toMatch(/^New lease can't be canceled yet — /)
    expect(told[0].body).toMatch(/It will never start, but a payment was tried on its bill and did not go through, so it can't be canceled until GAM takes that charge off\./)
    expect(told[0].body).not.toMatch(/\$0\.00/)
    // GAM hears once, naming the charge to take off.
    const gam = (await db.query<{ title: string; body: string; context: any }>(
      `SELECT title, body, context FROM admin_notifications WHERE category = 'new_lease_cancel_held'`)).rows
    expect(gam).toHaveLength(1)
    expect(gam[0].title).toMatch(/^New lease can't be canceled — a payment was tried on its bill \(/)
    expect(gam[0].body).toMatch(/1 unpaid charge on it could not be taken off because other records point at it \(the \$480\.00 rent charge due November 1, 2026\)/)
    expect(gam[0].context).toMatchObject({ tried_count: 1, kept: 1, cleared: true })
  })

  it('with no deposit payment on the new lease the move is unchanged: a part-paid deposit goes back part-paid', async () => {
    const r = await renewalWithDeposit({ topUp: null, collectedBefore: 300 })
    const out = await tx(c => unwindIssuedLease(c.query.bind(c) as any,
      { id: r.docId, lease_id: r.renewalId, issued_at: new Date(), unit_id: r.unitId }))
    expect(out.unwound).toBe(true)
    expect(await deposit(r.depositId)).toEqual({ lease_id: r.leaseId, total: '500.00', collected: '300.00', status: 'partial' })
  })

  /**
   * The household pays the charge a return reopened: it settles through the
   * real deposit hook, which leaves a record that already reads funded as it
   * is (the return never lowered it).
   */
  async function householdPaysReopened(r: { renewalId: string }): Promise<string> {
    const reopened = (await db.query<{ id: string }>(
      `SELECT id FROM payments WHERE lease_id = $1 AND type = 'deposit' AND reversal_id IS NOT NULL`, [r.renewalId])).rows[0].id
    await db.query(
      `UPDATE payments SET status = 'settled', settled_at = now(), stripe_payment_intent_id = 'pi_reopened_topup' WHERE id = $1`,
      [reopened])
    await reconcileSettledDepositPayment(reopened)
    return reopened
  }

  it('a top-up returned by the bank and paid again goes back at $500, not $400', async () => {
    const r = await renewalWithDeposit({ topUp: 'settled', endedEarly: true })
    expect((await bankReturnsTopUp(r)).handled).toBe(true)
    await householdPaysReopened(r)
    // One $100 top-up's worth of money ever raised the record.
    expect(await deposit(r.depositId)).toEqual({ lease_id: r.renewalId, total: '600.00', collected: '600.00', status: 'funded' })

    await processNewLeaseSignings({ hour: 3 })
    // The lease that ended gets the $500 the household paid before the renewal;
    // the $100 they paid again stays on the new lease, to be returned to them.
    expect(await deposit(r.depositId)).toEqual({ lease_id: r.leaseId, total: '500.00', collected: '500.00', status: 'funded' })
    // Money was paid on the new lease, so it is held, not sent to the void.
    expect(voidCalls.n).toBe(0)
    expect((await db.query<{ held: Date | null }>(
      `SELECT new_lease_cancel_held_at AS held FROM lease_documents WHERE id = $1`, [r.docId])).rows[0].held).not.toBeNull()
  })

  it('a top-up partly disputed and the disputed part paid again goes back at $500, not $460', async () => {
    const r = await renewalWithDeposit({ topUp: 'settled' })
    expect((await handlePaymentReversal({
      paymentId: r.topUpId!, reversalType: 'card_dispute', reversedAmount: 40, reversalFee: 0,
      stripeEventId: `evt_topup_disputed_${r.topUpId}`, rawEvent: {},
    })).handled).toBe(true)
    await householdPaysReopened(r)
    await tx(c => returnDepositCountedOnce(c.query.bind(c) as any, r.renewalId, r.leaseId))
    expect(await deposit(r.depositId)).toEqual({ lease_id: r.leaseId, total: '500.00', collected: '500.00', status: 'funded' })
  })

  it('a deposit part-paid before the renewal whose top-up was paid goes back at what was paid before the renewal', async () => {
    // $300 of the $500 paid, raised to $600, the $100 top-up paid: the record
    // reads $400 of $600 — short of its target, so all of the top-up raised it.
    const r = await renewalWithDeposit({ topUp: 'settled', collectedBefore: 300 })
    expect(await deposit(r.depositId)).toEqual({ lease_id: r.renewalId, total: '600.00', collected: '400.00', status: 'partial' })
    await tx(c => returnDepositCountedOnce(c.query.bind(c) as any, r.renewalId, r.leaseId))
    expect(await deposit(r.depositId)).toEqual({ lease_id: r.leaseId, total: '500.00', collected: '300.00', status: 'partial' })
  })

  /** The renewal's $100 top-up, billed on the new lease, unpaid. */
  async function topUpCharge(r: { unitId: string; renewalId: string; tenantId: string; landlordId: string },
    o: { status?: string; intent?: string } = {}): Promise<string> {
    return (await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description,
                             stripe_payment_intent_id)
       VALUES ($1,$2,$3,$4,'deposit',100,$5,'2026-10-20','DEPOSIT',$6) RETURNING id`,
      [r.unitId, r.renewalId, r.tenantId, r.landlordId, o.status ?? 'pending', o.intent ?? null])).rows[0].id
  }

  /** The settle the desk (or the bank-deposit match) runs, under the household lock, then its after-commit step. */
  async function settleOffStripe(r: { landlordId: string; tenantId: string; unitId: string; renewalId: string; userId: string },
    topUp: string, how: 'desk_cash' | 'bank_match'): Promise<string[]> {
    const c = await getClient()
    let res: Awaited<ReturnType<typeof settleManualRentPayment>>
    try {
      await c.query('BEGIN')
      await lockHousehold(c, r.tenantId, r.landlordId)
      const payment = { id: topUp, landlord_id: r.landlordId, tenant_id: r.tenantId, unit_id: r.unitId,
                        lease_id: r.renewalId, due_date: '2026-10-20' }
      res = how === 'desk_cash'
        ? await settleManualRentPayment(c, {
            payment, method: 'cash', settledAt: null, settleHousehold: true, amountTendered: 100, creditToUse: 0,
            takenBy: r.userId, source: 'desk', sendReceipt: false })
        : await settleManualRentPayment(c, {
            payment, method: 'check', settledAt: new Date(), provenance: 'matched to a bank deposit posted 2026-10-21' })
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e } finally { c.release() }
    await res.afterCommit()
    return res.settledPaymentIds
  }

  it('a renewal top-up paid in cash at the desk goes back at $500', async () => {
    // $500 paid in full, raised to $600 by the renewal: the record reads $500 of $600.
    const r = await renewalWithDeposit({ topUp: null })
    const topUp = await topUpCharge(r)
    // The household pays the $100 top-up in cash at the front desk (the real desk settle).
    expect(await settleOffStripe(r, topUp, 'desk_cash')).toEqual([topUp])
    expect((await db.query(`SELECT status, manual_method FROM payments WHERE id = $1`, [topUp])).rows[0])
      .toEqual({ status: 'settled', manual_method: 'cash' })
    // Then the lease they are on is replaced early and nobody signs the renewal.
    await db.query(`UPDATE leases SET status = 'terminated', terminated_at = now() - interval '1 day' WHERE id = $1`, [r.leaseId])
    await processNewLeaseSignings({ hour: 3 })
    // The lease that ended gets the $500 paid before the renewal, not $400; the
    // $100 paid in cash stays on the new lease, to be given back to them.
    expect(await deposit(r.depositId)).toEqual({ lease_id: r.leaseId, total: '500.00', collected: '500.00', status: 'funded' })
    expect(voidCalls.n).toBe(0)
  })

  it('a renewal top-up matched from a bank deposit goes back at $500', async () => {
    const r = await renewalWithDeposit({ topUp: null, endedEarly: true })
    const topUp = await topUpCharge(r)
    // The household's check for the $100 shows up in the landlord's bank and is matched to the top-up.
    expect(await settleOffStripe(r, topUp, 'bank_match')).toEqual([topUp])
    await processNewLeaseSignings({ hour: 3 })
    expect(await deposit(r.depositId)).toEqual({ lease_id: r.leaseId, total: '500.00', collected: '500.00', status: 'funded' })
  })

  it('a card payment of the top-up settling while the new lease is held finishes first and is counted once', async () => {
    const r = await renewalWithDeposit({ topUp: null, endedEarly: true })
    const topUp = await topUpCharge(r, { status: 'processing', intent: 'pi_topup_in_flight' })
    // Stripe's webhook settles it: the charge is marked settled (not committed
    // yet) and the record is raised on the hook's own connection (committed).
    const hook = await getClient()
    try {
      await hook.query('BEGIN')
      await hook.query(
        `UPDATE payments SET status = 'settled', settled_at = now() WHERE stripe_payment_intent_id = 'pi_topup_in_flight'`)
      await reconcileSettledDepositPayment(topUp)
      expect(await deposit(r.depositId)).toEqual({ lease_id: r.renewalId, total: '600.00', collected: '600.00', status: 'funded' })
      // Meanwhile the job holding the new lease moves the deposit back.
      const held = tx(c => returnDepositCountedOnce(c.query.bind(c) as any, r.renewalId, r.leaseId))
      // It waits for the settle under way (polled, up to two seconds), which then commits.
      for (let i = 0; i < 100; i++) {
        const waiting = (await db.query<{ n: number }>(
          `SELECT COUNT(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`)).rows[0].n
        if (waiting > 0) break
        await new Promise(res => setTimeout(res, 20))
      }
      await hook.query('COMMIT')
      await held
    } catch (e) { await hook.query('ROLLBACK').catch(() => {}); throw e } finally { hook.release() }
    // The $100 is counted once: the lease that ended gets its $500, not $600.
    expect(await deposit(r.depositId)).toEqual({ lease_id: r.leaseId, total: '500.00', collected: '500.00', status: 'funded' })
  })

  it('the 15-minute cancel takes the household before the document: while another writer holds the household the document stays free, and the cancel lands once it lets go', async () => {
    // The lock order is household, then its leases, then rows. The job's hold
    // path takes the household and then the document; a cancel that took the
    // document first and then waited on the household could deadlock with it.
    const r = await renewalWithDeposit({ topUp: null, endedEarly: true })
    const holder = await getClient()
    const other = await getClient()
    let job: Promise<void> | null = null
    let done = false
    try {
      await holder.query('BEGIN')
      await lockHousehold(holder, r.tenantId, r.landlordId)
      job = processNewLeaseSignings({ hour: 3 }).then(() => { done = true })
      // The cancel waits on the household (polled, up to five seconds)...
      let waiting = false
      for (let i = 0; i < 100 && !waiting; i++) {
        waiting = (await db.query<{ n: number }>(
          `SELECT COUNT(*)::int AS n FROM pg_locks
            WHERE locktype = 'advisory' AND NOT granted
              AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`)).rows[0].n > 0
        if (!waiting) await new Promise(res => setTimeout(res, 50))
      }
      expect(waiting).toBe(true)
      expect(done).toBe(false)
      // ...without the document in hand: another writer can take it at once.
      await other.query('BEGIN')
      const free = await other.query(`SELECT id FROM lease_documents WHERE id = $1 FOR UPDATE NOWAIT`, [r.docId])
      expect(free.rows).toHaveLength(1)
      await other.query('ROLLBACK')
      await holder.query('COMMIT')
      await job
    } finally {
      await other.query('ROLLBACK').catch(() => {})
      await holder.query('ROLLBACK').catch(() => {})
      await job?.catch(() => {})
      other.release()
      holder.release()
    }
    expect(voidCalls.n).toBe(1)
    expect((await db.query<{ status: string }>(`SELECT status FROM lease_documents WHERE id = $1`, [r.docId])).rows[0].status).toBe('voided')
    expect((await db.query<{ status: string }>(`SELECT status FROM leases WHERE id = $1`, [r.renewalId])).rows[0].status).toBe('terminated')
  })
})

describe('a void never strands a charge the landlord recorded', () => {
  /** A $75 damage charge and propane payment 2 of 4 ($40) riding the lease's open bill. */
  async function recordedOnBill(f: Fx, leaseId: string) {
    const fee = await row({ ...f, leaseId }, { amount: 75, type: 'fee', entry: 'OTHERFEE' })
    const propaneRow = await row({ ...f, leaseId }, { amount: 40, type: 'fee', entry: 'OTHERFEE' })
    const oneOff = (await db.query<{ id: string }>(
      `INSERT INTO tenant_one_off_charges (landlord_id, tenant_id, lease_id, unit_id, charge_type, amount, reason, incident_date,
                                          status, payment_id, billed_at)
       VALUES ($1,$2,$3,$4,'damage',75,'Broken window','2026-09-14','billed',$5, now()) RETURNING id`,
      [f.landlordId, f.tenantId, leaseId, f.unitId, fee])).rows[0].id
    const fill = (await db.query<{ id: string }>(
      `INSERT INTO propane_fills (property_id, landlord_id, unit_id, lease_id, tenant_id, fill_date, gallons, price_per_gallon,
                                  total_amount, installment_count)
       VALUES ($1,$2,$3,$4,$5,'2026-09-03',40,4,160,4) RETURNING id`,
      [f.propertyId, f.landlordId, f.unitId, leaseId, f.tenantId])).rows[0].id
    const installment = (await db.query<{ id: string }>(
      `INSERT INTO propane_fill_installments (fill_id, installment_number, amount, billing_cycle_month, payment_id)
       VALUES ($1,2,40,'2026-10-01',$2) RETURNING id`, [fill, propaneRow])).rows[0].id
    return { fee, propaneRow, oneOff, fill, installment }
  }

  it('voiding a lease (not a renewal) whose bill carries a damage charge and a propane payment is refused, naming them, and nothing changes', async () => {
    const f = await fixture()
    const x = await recordedOnBill(f, f.leaseId)
    await expect(tx(c => unwindIssuedLease(c.query.bind(c) as any,
      { id: '00000000-0000-0000-0000-000000000003', lease_id: f.leaseId, issued_at: new Date(), unit_id: f.unitId })))
      .rejects.toMatchObject({
        statusCode: 409,
        message: 'You recorded charges for this household on this lease: propane payment 2 of 4 ($40.00, filled ' +
          'September 3, 2026) and the $75.00 damage charge "Broken window" (September 14, 2026). Voiding the lease would leave ' +
          'them with no lease to be billed on, so the lease cannot be voided. Create a superseding document instead.',
      })
    expect(await exists(x.fee)).toBe(true)
    expect(await exists(x.propaneRow)).toBe(true)
    expect((await db.query(`SELECT status, payment_id FROM tenant_one_off_charges WHERE id = $1`, [x.oneOff])).rows[0])
      .toEqual({ status: 'billed', payment_id: x.fee })
    expect((await db.query(`SELECT payment_id FROM propane_fill_installments WHERE id = $1`, [x.installment])).rows[0])
      .toEqual({ payment_id: x.propaneRow })
    expect((await db.query<{ status: string }>(`SELECT status FROM leases WHERE id = $1`, [f.leaseId])).rows[0].status).toBe('active')
  })

  it('voiding a lease (not a renewal) with a damage charge still waiting for its next bill is refused, naming it, and nothing changes', async () => {
    // Recorded, not billed yet: the bill run reaches it only through an active
    // lease, so on a voided one it would never be billed.
    const f = await fixture()
    const oneOff = (await db.query<{ id: string }>(
      `INSERT INTO tenant_one_off_charges (landlord_id, tenant_id, lease_id, unit_id, charge_type, amount, reason, incident_date)
       VALUES ($1,$2,$3,$4,'damage',75,'Broken window','2026-09-14') RETURNING id`,
      [f.landlordId, f.tenantId, f.leaseId, f.unitId])).rows[0].id
    const fill = (await db.query<{ id: string }>(
      `INSERT INTO propane_fills (property_id, landlord_id, unit_id, lease_id, tenant_id, fill_date, gallons, price_per_gallon,
                                  total_amount, installment_count)
       VALUES ($1,$2,$3,$4,$5,'2026-09-03',40,4,160,4) RETURNING id`,
      [f.propertyId, f.landlordId, f.unitId, f.leaseId, f.tenantId])).rows[0].id
    await db.query(
      `INSERT INTO propane_fill_installments (fill_id, installment_number, amount, billing_cycle_month)
       VALUES ($1,3,40,'2026-11-01')`, [fill])
    await expect(tx(c => unwindIssuedLease(c.query.bind(c) as any,
      { id: '00000000-0000-0000-0000-000000000004', lease_id: f.leaseId, issued_at: new Date(), unit_id: f.unitId })))
      .rejects.toMatchObject({
        statusCode: 409,
        message: 'You recorded charges for this household on this lease: propane payment 3 of 4 ($40.00, filled ' +
          'September 3, 2026) and the $75.00 damage charge "Broken window" (September 14, 2026). Voiding the lease would leave ' +
          'them with no lease to be billed on, so the lease cannot be voided. Create a superseding document instead.',
      })
    expect((await db.query(`SELECT status, lease_id FROM tenant_one_off_charges WHERE id = $1`, [oneOff])).rows[0])
      .toEqual({ status: 'pending', lease_id: f.leaseId })
    expect((await db.query<{ status: string }>(`SELECT status FROM leases WHERE id = $1`, [f.leaseId])).rows[0].status).toBe('active')
  })

  it('a refusal over a charge not billed yet names the path that works: cancel it, then void', async () => {
    const f = await fixture()
    const oneOff = (await db.query<{ id: string }>(
      `INSERT INTO tenant_one_off_charges (landlord_id, tenant_id, lease_id, unit_id, charge_type, amount, reason, incident_date)
       VALUES ($1,$2,$3,$4,'damage',75,'Broken window','2026-09-14') RETURNING id`,
      [f.landlordId, f.tenantId, f.leaseId, f.unitId])).rows[0].id
    const doc = { id: '00000000-0000-0000-0000-000000000006', lease_id: f.leaseId, issued_at: new Date(), unit_id: f.unitId }
    await expect(tx(c => unwindIssuedLease(c.query.bind(c) as any, doc)))
      .rejects.toMatchObject({
        statusCode: 409,
        message: 'You recorded a charge for this household on this lease: the $75.00 damage charge "Broken window" ' +
          '(September 14, 2026). Voiding the lease would leave it with no lease to be billed on, so the lease cannot be voided. ' +
          'If it should not be billed, cancel it on the tenant\'s page first, then void this lease. Otherwise, create a superseding document.',
      })
    // Following that step works: once canceled, the same void goes through.
    await db.query(`UPDATE tenant_one_off_charges SET status = 'cancelled', cancelled_at = now() WHERE id = $1`, [oneOff])
    expect((await tx(c => unwindIssuedLease(c.query.bind(c) as any, doc))).unwound).toBe(true)
  })

  it('a charge the landlord already canceled does not stop the void', async () => {
    const f = await fixture()
    await db.query(
      `INSERT INTO tenant_one_off_charges (landlord_id, tenant_id, lease_id, unit_id, charge_type, amount, reason, incident_date,
                                          status, cancelled_at, cancel_reason)
       VALUES ($1,$2,$3,$4,'damage',75,'Broken window','2026-09-14','cancelled', now(), 'entered twice')`,
      [f.landlordId, f.tenantId, f.leaseId, f.unitId])
    const out = await tx(c => unwindIssuedLease(c.query.bind(c) as any,
      { id: '00000000-0000-0000-0000-000000000005', lease_id: f.leaseId, issued_at: new Date(), unit_id: f.unitId }))
    expect(out.unwound).toBe(true)
    expect((await db.query<{ status: string }>(`SELECT status FROM leases WHERE id = $1`, [f.leaseId])).rows[0].status).toBe('terminated')
  })

  it('a renewal voided with them on its bill sends them back to the lease the household is on, to be billed there', async () => {
    const f = await fixture({ start: '2025-10-01' })
    const renewalId = await tx(async c => {
      const id = (await c.query<{ id: string }>(
        `INSERT INTO leases (unit_id, landlord_id, rent_amount, lease_type, status, start_date, supersedes_lease_id, lease_source)
         VALUES ($1,$2,480,'month_to_month','pending','2026-11-01',$3,'esigned') RETURNING id`,
        [f.unitId, f.landlordId, f.leaseId])).rows[0].id
      await seedLeaseTenant(c, { leaseId: id, tenantId: f.tenantId, role: 'primary' })
      return id
    })
    const docId = (await db.query<{ id: string }>(
      `INSERT INTO lease_documents (landlord_id, title, status, renews_lease_id, lease_id, issued_at)
       VALUES ($1,'Renewal','pending',$2,$3, now()) RETURNING id`, [f.landlordId, f.leaseId, renewalId])).rows[0].id
    const x = await recordedOnBill(f, renewalId)
    const out = await tx(c => unwindIssuedLease(c.query.bind(c) as any,
      { id: docId, lease_id: renewalId, issued_at: new Date(), unit_id: f.unitId }))
    expect(out.unwound).toBe(true)
    expect(await exists(x.fee)).toBe(false)
    expect(await exists(x.propaneRow)).toBe(false)
    expect((await db.query(`SELECT status, payment_id, lease_id FROM tenant_one_off_charges WHERE id = $1`, [x.oneOff])).rows[0])
      .toEqual({ status: 'pending', payment_id: null, lease_id: f.leaseId })
    expect((await db.query(`SELECT payment_id FROM propane_fill_installments WHERE id = $1`, [x.installment])).rows[0])
      .toEqual({ payment_id: null })
    expect((await db.query(`SELECT lease_id FROM propane_fills WHERE id = $1`, [x.fill])).rows[0]).toEqual({ lease_id: f.leaseId })
  })
})

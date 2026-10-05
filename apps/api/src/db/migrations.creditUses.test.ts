/**
 * S655 money plan, Step 1: the database rules behind every credit spend.
 *
 * M4 (credit_uses + trg_credit_uses_apply) is the one place a credit's balance
 * moves and the one place that decides what credit may pay. These tests drive
 * the database directly, the way every code path will, so a path that forgets a
 * rule is still refused by the table. The expand migrations M1-M3 and M5-M12
 * and the contract step C0 are covered at the end.
 *
 * Most tests run in a transaction that is rolled back; the concurrency test
 * commits real rows on two connections and cleans up after itself.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import type { PoolClient } from 'pg'
import { db } from './index'
import {
  CREDIT_USE_SOURCES, CREDIT_USE_STATUSES, CREDIT_USE_RELEASE_REASONS, PREPAID_FUNDED_BY,
  DEPOSIT_SLIP_STATUSES, DEPOSIT_SLIP_SOURCES, PLATFORM_REVENUE_TYPES, HELD_PAYOUT_SOURCE_TYPES,
  TENANT_CREDIT_ALL_CATEGORIES, REVENUE_OWNERS, FLEXPAY_RETURNED_PULL_FEE, FLEXPAY_REJOIN_WAIT_DAYS,
} from '@gam/shared'
import { FLEXPAY_ACH_RETURN_FEE, FLEXPAY_NSF_COOLDOWN_DAYS } from '../services/flexpay'
import { creditEligibleRowSql } from '../services/moneyPredicates'
import {
  cleanupAllSchema, withRollback, seedLandlord, seedProperty, seedUnit, seedTenant,
  seedLease, seedLeaseTenant, seedLeaseFee, seedDepositReturnDraft,
} from '../test/dbHelpers'

// ─── fixture ────────────────────────────────────────────────────────────────

interface Household {
  landlordId: string; userId: string; propertyId: string
  unitId: string; tenantId: string; leaseId: string
}

async function household(
  c: PoolClient,
  o: { landlord?: { landlordId: string; userId: string }; propertyId?: string; tenantId?: string } = {},
): Promise<Household> {
  const ll = o.landlord ?? await seedLandlord(c)
  const propertyId = o.propertyId
    ?? await seedProperty(c, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
  const unitId = await seedUnit(c, { propertyId, landlordId: ll.landlordId })
  const tenantId = o.tenantId ?? await seedTenant(c)
  const leaseId = await seedLease(c, { unitId, landlordId: ll.landlordId, rentAmount: 460, status: 'active' })
  await seedLeaseTenant(c, { leaseId, tenantId, role: 'primary' })
  return { ...ll, propertyId, unitId, tenantId, leaseId }
}

interface ChargeOpts {
  type?: string; amount?: number; status?: string; entry?: string; owner?: string
  leaseFeeId?: string | null; reversalId?: string | null; workTrade?: boolean
  unitId?: string | null; leaseId?: string | null; tenantId?: string; landlordId?: string
  intent?: string | null; chargeId?: string | null; manualMethod?: string | null
  platformHeld?: boolean; dueDate?: string
}
// Rent is unique per lease and due date (ux_payments_rent_idempotent), so every
// charge gets its own day unless a test names one.
let dueSeq = 0
function nextDue(): string {
  const d = new Date(Date.UTC(2027, 0, 1) + (dueSeq++) * 86_400_000)
  return d.toISOString().slice(0, 10)
}
async function charge(c: PoolClient, f: Household, o: ChargeOpts = {}): Promise<string> {
  const status = o.status ?? 'pending'
  const r = await c.query<{ id: string }>(
    `INSERT INTO payments
       (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, entry_description,
        due_date, revenue_owner, lease_fee_id, reversal_id, work_trade_suspended_at,
        stripe_payment_intent_id, stripe_charge_id, manual_method, platform_held, settled_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::date,$10,$11,$12,$13,$14,$15,$16,$17,
             CASE WHEN $7 = 'settled' THEN now() END)
     RETURNING id`,
    [o.unitId === undefined ? f.unitId : o.unitId,
     o.leaseId === undefined ? f.leaseId : o.leaseId,
     o.tenantId ?? f.tenantId, o.landlordId ?? f.landlordId,
     o.type ?? 'rent', o.amount ?? 460, status, o.entry ?? 'RENT',
     o.dueDate ?? nextDue(), o.owner ?? 'landlord', o.leaseFeeId ?? null, o.reversalId ?? null,
     o.workTrade ? new Date() : null, o.intent ?? null, o.chargeId ?? null, o.manualMethod ?? null,
     o.platformHeld ?? false])
  return r.rows[0].id
}

async function issued(
  c: PoolClient, f: Household, amount: number,
  o: { leaseId?: string | null; category?: string; tenantId?: string; landlordId?: string } = {},
): Promise<string> {
  const r = await c.query<{ id: string }>(
    `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category, reason)
     VALUES ($1,$2,$3,$4,$4,$5,'test') RETURNING id`,
    [o.landlordId ?? f.landlordId, o.tenantId ?? f.tenantId,
     o.leaseId === undefined ? f.leaseId : o.leaseId, amount, o.category ?? 'goodwill'])
  return r.rows[0].id
}

async function paidAhead(
  c: PoolClient, f: Household, amount: number,
  o: { fundedBy?: string | null; leaseId?: string; sourceRemittanceId?: string | null } = {},
): Promise<string> {
  const r = await c.query<{ id: string }>(
    `INSERT INTO lease_prepaid_credits
       (lease_id, tenant_id, amount_original, amount_remaining, funded_by, received_at, source_remittance_id)
     VALUES ($1,$2,$3,$3,$4,now(),$5) RETURNING id`,
    [o.leaseId ?? f.leaseId, f.tenantId, amount,
     o.fundedBy === undefined ? 'landlord' : o.fundedBy, o.sourceRemittanceId ?? null])
  return r.rows[0].id
}

async function remittance(c: PoolClient, f: Household, amount: number, intent: string | null = null): Promise<string> {
  const r = await c.query<{ id: string }>(
    `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, payment_method, stripe_payment_intent_id)
     VALUES ($1,$2,$3,$4,$4,'card',$5) RETURNING id`,
    [f.tenantId, f.leaseId, f.landlordId, amount, intent])
  return r.rows[0].id
}

interface UseOpts {
  tenantCreditId?: string; prepaidCreditId?: string
  paymentId?: string | null; depositReturnId?: string; paymentReversalId?: string
  remittanceId?: string | null; leaseId: string; amount: number
  status?: 'held' | 'applied'; source?: string; month?: string
}
const USE_SQL = `
  INSERT INTO credit_uses
    (tenant_credit_id, prepaid_credit_id, payment_id, deposit_return_id, payment_reversal_id,
     remittance_id, lease_id, amount, billing_month, source, status, applied_at)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::date,$10,$11, CASE WHEN $11 = 'applied' THEN now() END)
  RETURNING id`
function useParams(o: UseOpts): unknown[] {
  const status = o.status ?? 'applied'
  return [o.tenantCreditId ?? null, o.prepaidCreditId ?? null, o.paymentId ?? null,
    o.depositReturnId ?? null, o.paymentReversalId ?? null, o.remittanceId ?? null,
    o.leaseId, o.amount, o.month ?? '2026-10-01',
    o.source ?? (status === 'held' ? 'portal' : 'desk'), status]
}
async function use(c: PoolClient, o: UseOpts): Promise<string> {
  return (await c.query<{ id: string }>(USE_SQL, useParams(o))).rows[0].id
}

/** Run one statement that the database must refuse; the transaction carries on. */
async function refused(c: PoolClient, sql: string, params: unknown[], re: RegExp): Promise<void> {
  await c.query('SAVEPOINT expect_refusal')
  let err: any = null
  try { await c.query(sql, params) } catch (e) { err = e }
  await c.query('ROLLBACK TO SAVEPOINT expect_refusal')
  expect(err, `expected the database to refuse: ${sql.trim().split('\n')[0]}`).not.toBeNull()
  expect(String(err?.message)).toMatch(re)
}
const refusedUse = (c: PoolClient, o: UseOpts, re: RegExp) => refused(c, USE_SQL, useParams(o), re)

async function remaining(c: PoolClient, table: 'tenant_credits' | 'lease_prepaid_credits', id: string): Promise<number> {
  return Number((await c.query(`SELECT amount_remaining FROM ${table} WHERE id = $1`, [id])).rows[0].amount_remaining)
}
async function issuedOn(c: PoolClient, paymentId: string): Promise<number> {
  return Number((await c.query(`SELECT issued_credit_amount FROM payments WHERE id = $1`, [paymentId])).rows[0].issued_credit_amount)
}
async function reversalOf(c: PoolClient, f: Household, paymentId: string, event = `evt_${randomUUID()}`): Promise<string> {
  const r = await c.query<{ id: string }>(
    `INSERT INTO payment_reversals (payment_id, landlord_id, tenant_id, lease_id, reversal_type, reversed_amount, stripe_event_id, raw_event)
     VALUES ($1,$2,$3,$4,'card_dispute',100,$5,'{}'::jsonb) RETURNING id`,
    [paymentId, f.landlordId, f.tenantId, f.leaseId, event])
  return r.rows[0].id
}

// Whether contract step C0 is already in this database. The final money run
// applies C0 to the test database (money plan Step 16), and every other run
// does not, so the two assertions that see C0's effects ask instead of assuming.
let c0Live = false
beforeAll(async () => {
  await cleanupAllSchema()
  const t = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgname LIKE 'trg_%_remaining_by_ledger'`)
  c0Live = t.rows[0].n > 0
})
afterAll(async () => { await cleanupAllSchema() })

// ─── the ledger ─────────────────────────────────────────────────────────────

describe('S655 credit_uses: what a use may be', () => {
  it('a credit use starts held or applied', async () => {
    await withRollback(async c => {
      const f = await household(c)
      const row = await charge(c, f)
      const credit = await issued(c, f, 100)
      await refused(c,
        `INSERT INTO credit_uses (tenant_credit_id, payment_id, lease_id, amount, billing_month, source, status, released_at, release_reason)
         VALUES ($1,$2,$3,10,'2026-10-01','desk','released',now(),'superseded')`,
        [credit, row, f.leaseId], /starts held or applied/)
      // Only a Stripe charge sets credit aside: a held use needs its remittance.
      await refusedUse(c, { tenantCreditId: credit, paymentId: row, leaseId: f.leaseId, amount: 10, status: 'held', source: 'portal' },
        /credit_uses_held_rides_a_charge/)
      await refusedUse(c, { tenantCreditId: credit, paymentId: row, leaseId: f.leaseId, amount: 10, status: 'held', source: 'desk',
        remittanceId: await remittance(c, f, 10) }, /credit_uses_held_rides_a_charge/)
      await use(c, { tenantCreditId: credit, paymentId: row, leaseId: f.leaseId, amount: 10, status: 'held', source: 'portal',
        remittanceId: await remittance(c, f, 450) })
      // The desk spends at once (on a charge no other payment has credit on).
      await use(c, { tenantCreditId: credit, paymentId: await charge(c, f), leaseId: f.leaseId, amount: 10 })
      expect(await remaining(c, 'tenant_credits', credit)).toBe(80)
    })
  })

  it('a use on a GAM fee, a FLEXPAY pull, a move-out DEPOSIT row or a home payment is refused', async () => {
    await withRollback(async c => {
      const f = await household(c)
      const credit = await issued(c, f, 1000)
      const paidAheadId = await paidAhead(c, f, 1000)
      const rows = [
        await charge(c, f, { type: 'fee', entry: 'RETURNFEE', owner: 'gam', amount: 6 }),
        await charge(c, f, { type: 'fee', entry: 'FLEXPAY', amount: 485 }),
        await charge(c, f, { type: 'fee', entry: 'DEPOSIT', amount: 120 }),          // move-out shortfall
        await charge(c, f, { type: 'deposit', entry: 'DEPOSIT', amount: 460 }),      // the security deposit itself
        await charge(c, f, { type: 'home_payment', entry: 'HOMEPMT', amount: 200 }),
        await charge(c, f, { type: 'platform_fee', entry: 'SUBSCRIP', owner: 'gam', amount: 2 }),
        await charge(c, f, { type: 'fee', entry: 'OTHERFEE', owner: 'held', amount: 460 }),
      ]
      for (const paymentId of rows) {
        await refusedUse(c, { tenantCreditId: credit, paymentId, leaseId: f.leaseId, amount: 1 }, /not an eligible landlord charge/)
        await refusedUse(c, { prepaidCreditId: paidAheadId, paymentId, leaseId: f.leaseId, amount: 1 }, /not an eligible landlord charge/)
      }
      expect(await remaining(c, 'tenant_credits', credit)).toBe(1000)
      expect(await remaining(c, 'lease_prepaid_credits', paidAheadId)).toBe(1000)
    })
  })

  it('a non-refundable pet-deposit fee row is credit-eligible', async () => {
    await withRollback(async c => {
      const f = await household(c)
      const feeId = await seedLeaseFee(c, { leaseId: f.leaseId, feeType: 'pet_deposit', amount: 150, dueTiming: 'move_in', isRefundable: false })
      const row = await charge(c, f, { type: 'fee', entry: 'DEPOSIT', amount: 150, leaseFeeId: feeId })
      const credit = await issued(c, f, 150)
      await use(c, { tenantCreditId: credit, paymentId: row, leaseId: f.leaseId, amount: 150 })
      expect(await issuedOn(c, row)).toBe(150)
    })
  })

  it("a use on another lease or a neighbor's utility is refused", async () => {
    await withRollback(async c => {
      const f = await household(c)
      const second = await household(c, { landlord: { landlordId: f.landlordId, userId: f.userId }, propertyId: f.propertyId, tenantId: f.tenantId })
      const neighbor = await seedLandlord(c)
      const leaseCredit = await issued(c, f, 100)                 // tied to lease 1
      const money = await paidAhead(c, f, 100)                     // lease 1's paid-ahead money
      const otherLeaseRent = await charge(c, second)
      // Paid-ahead money pays only its own lease, however the use is labeled.
      await refusedUse(c, { prepaidCreditId: money, paymentId: otherLeaseRent, leaseId: second.leaseId, amount: 10 }, /pays only its own lease/)
      await refusedUse(c, { prepaidCreditId: money, paymentId: otherLeaseRent, leaseId: f.leaseId, amount: 10 }, /not an eligible landlord charge/)
      await refusedUse(c, { tenantCreditId: leaseCredit, paymentId: otherLeaseRent, leaseId: second.leaseId, amount: 10 }, /belongs to another lease/)
      // A neighbor landlord's utility on this tenant's converged invoice is not on this lease.
      const neighborWater = await charge(c, f, { type: 'utility', entry: 'UTILITY', amount: 40, leaseId: null, landlordId: neighbor.landlordId })
      await refusedUse(c, { prepaidCreditId: money, paymentId: neighborWater, leaseId: f.leaseId, amount: 10 }, /not an eligible landlord charge/)
      await refusedUse(c, { tenantCreditId: leaseCredit, paymentId: neighborWater, leaseId: f.leaseId, amount: 10 }, /not an eligible landlord charge/)
    })
  })

  it("a general credit cannot pay another tenant's bill with the same landlord", async () => {
    await withRollback(async c => {
      const f = await household(c)
      const otherTenant = await household(c, { landlord: { landlordId: f.landlordId, userId: f.userId }, propertyId: f.propertyId })
      const sameTenantSecondLease = await household(c, { landlord: { landlordId: f.landlordId, userId: f.userId }, propertyId: f.propertyId, tenantId: f.tenantId })
      const elsewhere = await household(c, { tenantId: f.tenantId })   // same person, another landlord
      const general = await issued(c, f, 300, { leaseId: null })
      await refusedUse(c, { tenantCreditId: general, paymentId: await charge(c, otherTenant), leaseId: otherTenant.leaseId, amount: 10 },
        /pays only its own tenant's bills with the landlord who gave it/)
      await refusedUse(c, { tenantCreditId: general, paymentId: await charge(c, elsewhere), leaseId: elsewhere.leaseId, amount: 10 },
        /pays only its own tenant's bills with the landlord who gave it/)
      // The same person's other lease with the same landlord is theirs to pay.
      await use(c, { tenantCreditId: general, paymentId: await charge(c, sameTenantSecondLease), leaseId: sameTenantSecondLease.leaseId, amount: 10 })
      expect(await remaining(c, 'tenant_credits', general)).toBe(290)
    })
  })

  it("a general credit cannot pay a row with no tenant on someone else's lease (a missing tenant refuses, never lets it through)", async () => {
    await withRollback(async c => {
      const f = await household(c)
      const otherTenant = await household(c, { landlord: { landlordId: f.landlordId, userId: f.userId }, propertyId: f.propertyId })
      const general = await issued(c, otherTenant, 100, { leaseId: null })
      const noTenantRow = await charge(c, f)
      await c.query(`UPDATE payments SET tenant_id = NULL WHERE id = $1`, [noTenantRow])
      await refusedUse(c, { tenantCreditId: general, paymentId: noTenantRow, leaseId: f.leaseId, amount: 10 },
        /pays only its own tenant's bills with the landlord who gave it/)
      // A co-tenant on the lease may still pay it: the lease says it is theirs.
      await seedLeaseTenant(c, { leaseId: f.leaseId, tenantId: otherTenant.tenantId, role: 'co_tenant' })
      await use(c, { tenantCreditId: general, paymentId: noTenantRow, leaseId: f.leaseId, amount: 10 })
      expect(await remaining(c, 'tenant_credits', general)).toBe(90)
    })
  })

  it("a lease-tied credit stamped with another landlord cannot pay this lease's bills", async () => {
    await withRollback(async c => {
      const f = await household(c)
      const stranger = await seedLandlord(c)
      const wrongLandlord = await issued(c, f, 100, { landlordId: stranger.landlordId })   // lease_id = this lease
      await refusedUse(c, { tenantCreditId: wrongLandlord, paymentId: await charge(c, f), leaseId: f.leaseId, amount: 10 },
        /given by another landlord/)
      expect(await remaining(c, 'tenant_credits', wrongLandlord)).toBe(100)
    })
  })

  it('a use on a settled row is refused', async () => {
    await withRollback(async c => {
      const f = await household(c)
      const credit = await issued(c, f, 100)
      for (const status of ['settled', 'returned', 'paid_via_deposit']) {
        const row = await charge(c, f, { status })
        await refusedUse(c, { tenantCreditId: credit, paymentId: row, leaseId: f.leaseId, amount: 10 }, /already paid/)
      }
    })
  })

  it('a pending charge that already carries a Stripe intent takes no use (the same rule as payableRowSql)', async () => {
    await withRollback(async c => {
      const f = await household(c)
      const credit = await issued(c, f, 100)
      const money = await paidAhead(c, f, 100)
      const stamped = await charge(c, f, { status: 'pending', intent: 'pi_pending_stamped' })
      // Its money may be on the way under that intent, so neither the desk, the
      // whole-bill rule nor a card charge may put credit on it.
      await refusedUse(c, { tenantCreditId: credit, paymentId: stamped, leaseId: f.leaseId, amount: 10, source: 'desk' }, /already paid or being paid/)
      await refusedUse(c, { prepaidCreditId: money, paymentId: stamped, leaseId: f.leaseId, amount: 10, source: 'whole_bill' }, /already paid or being paid/)
      await refusedUse(c, { tenantCreditId: credit, paymentId: stamped, leaseId: f.leaseId, amount: 10, status: 'held', source: 'portal',
        remittanceId: await remittance(c, f, 450, 'pi_pending_stamped') }, /already paid or being paid/)
      expect(await remaining(c, 'tenant_credits', credit)).toBe(100)
      expect(await remaining(c, 'lease_prepaid_credits', money)).toBe(100)
      // The app's own rule agrees: the row is not payable, so not credit-eligible.
      const eligible = await c.query<{ ok: boolean }>(
        `SELECT ${creditEligibleRowSql('p')} AS ok FROM payments p WHERE p.id = $1`, [stamped])
      expect(eligible.rows[0].ok).toBe(false)
      // The same row with no intent, and a failed row with an old intent, still take credit.
      const owed = await charge(c, f, { status: 'pending' })
      await use(c, { tenantCreditId: credit, paymentId: owed, leaseId: f.leaseId, amount: 10, source: 'desk' })
      const failed = await charge(c, f, { status: 'failed', intent: 'pi_old_failed' })
      await use(c, { prepaidCreditId: money, paymentId: failed, leaseId: f.leaseId, amount: 10, source: 'desk' })
      expect(await remaining(c, 'tenant_credits', credit)).toBe(90)
      expect(await remaining(c, 'lease_prepaid_credits', money)).toBe(90)
      // The deploy backfill still records history on such a row (it spends
      // nothing: the balance was already lowered before the ledger existed).
      await c.query(`SET LOCAL gam.credit_backfill = 'on'`)
      await use(c, { tenantCreditId: credit, paymentId: stamped, leaseId: f.leaseId, amount: 5, source: 'backfill' })
      expect(await remaining(c, 'tenant_credits', credit)).toBe(90)
      expect(await issuedOn(c, stamped)).toBe(5)
    })
  })

  it("a charge whose money is in flight takes only its own Stripe charge's held use", async () => {
    await withRollback(async c => {
      const f = await household(c)
      const credit = await issued(c, f, 100)
      const money = await paidAhead(c, f, 100)
      const inFlight = await charge(c, f, { status: 'processing', intent: 'pi_in_flight' })
      // The desk, the whole-bill rule, a backfill-free path: none may spend on it.
      await refusedUse(c, { tenantCreditId: credit, paymentId: inFlight, leaseId: f.leaseId, amount: 10, source: 'desk' }, /already paid or being paid/)
      await refusedUse(c, { prepaidCreditId: money, paymentId: inFlight, leaseId: f.leaseId, amount: 10, source: 'whole_bill' }, /already paid or being paid/)
      // Another Stripe charge may not set credit aside on it: its money is
      // already in flight under pi_in_flight.
      await refusedUse(c, { tenantCreditId: credit, paymentId: inFlight, leaseId: f.leaseId, amount: 10, status: 'held', source: 'portal',
        remittanceId: await remittance(c, f, 450, 'pi_other_charge') }, /already paid or being paid/)
      // Nor may a remittance not yet stamped with its intent: a path that puts
      // the charge in flight first stamps its remittance before holding credit.
      await refusedUse(c, { tenantCreditId: credit, paymentId: inFlight, leaseId: f.leaseId, amount: 10, status: 'held', source: 'portal',
        remittanceId: await remittance(c, f, 450, null) }, /already paid or being paid/)
      // The charge that put it in flight sets its credit aside on it.
      await use(c, { tenantCreditId: credit, paymentId: inFlight, leaseId: f.leaseId, amount: 10, status: 'held', source: 'portal',
        remittanceId: await remittance(c, f, 450, 'pi_in_flight') })
      expect(await remaining(c, 'tenant_credits', credit)).toBe(90)
      expect(await remaining(c, 'lease_prepaid_credits', money)).toBe(100)
    })
  })

  it("a failed charge whose retry is still scheduled takes no other use until the retry's credit is released", async () => {
    await withRollback(async c => {
      const f = await household(c)
      const credit = await issued(c, f, 200)
      const money = await paidAhead(c, f, 200)
      const row = await charge(c, f, { amount: 100, status: 'failed', intent: 'pi_retry_A' })
      await c.query(`UPDATE payments SET next_retry_at = now() + interval '1 day' WHERE id = $1`, [row])
      const retryRem = await remittance(c, f, 60, 'pi_retry_A')
      const retryCredit = await use(c, { tenantCreditId: credit, paymentId: row, leaseId: f.leaseId, amount: 40, status: 'held', remittanceId: retryRem })
      // The whole-bill rule, the desk and a new card payment would each let the
      // retry's $60 and their own credit both pay this $100 row.
      await refusedUse(c, { tenantCreditId: credit, paymentId: row, leaseId: f.leaseId, amount: 60, source: 'whole_bill' },
        /release the scheduled retry's credit first/)
      await refusedUse(c, { prepaidCreditId: money, paymentId: row, leaseId: f.leaseId, amount: 60, source: 'desk' },
        /release the scheduled retry's credit first/)
      await refusedUse(c, { tenantCreditId: credit, paymentId: row, leaseId: f.leaseId, amount: 60, status: 'held',
        remittanceId: await remittance(c, f, 40, 'pi_new_charge') }, /release the scheduled retry's credit first/)
      // The retry's own payment may still add to what it set aside.
      await use(c, { prepaidCreditId: money, paymentId: row, leaseId: f.leaseId, amount: 10, status: 'held', remittanceId: retryRem })
      expect(await remaining(c, 'tenant_credits', credit)).toBe(160)
      expect(await remaining(c, 'lease_prepaid_credits', money)).toBe(190)
      // Superseding the retry gives its credit back; then the bill can be paid.
      await c.query(`UPDATE credit_uses SET status = 'released', released_at = now(), release_reason = 'superseded'
                      WHERE remittance_id = $1 AND status = 'held'`, [retryRem])
      await c.query(`UPDATE payments SET next_retry_at = NULL WHERE id = $1`, [row])
      await use(c, { tenantCreditId: credit, paymentId: row, leaseId: f.leaseId, amount: 100, source: 'whole_bill' })
      expect(await remaining(c, 'tenant_credits', credit)).toBe(100)
      expect(await remaining(c, 'lease_prepaid_credits', money)).toBe(200)
      expect(await issuedOn(c, row)).toBe(100)
      const live = await c.query(`SELECT count(*)::int AS n FROM credit_uses WHERE id = $1 AND status = 'released'`, [retryCredit])
      expect(live.rows[0].n).toBe(1)
    })
  })

  it('a use on a reopened (reversal) row is refused', async () => {
    await withRollback(async c => {
      const f = await household(c)
      const original = await charge(c, f, { status: 'returned' })
      const reopened = await charge(c, f, { reversalId: await reversalOf(c, f, original) })
      await refusedUse(c, { tenantCreditId: await issued(c, f, 100), paymentId: reopened, leaseId: f.leaseId, amount: 10 }, /not an eligible landlord charge/)
      await refusedUse(c, { prepaidCreditId: await paidAhead(c, f, 100), paymentId: reopened, leaseId: f.leaseId, amount: 10 }, /not an eligible landlord charge/)
    })
  })

  it('a work-trade suspended row is refused', async () => {
    await withRollback(async c => {
      const f = await household(c)
      const covered = await charge(c, f, { workTrade: true })
      await refusedUse(c, { tenantCreditId: await issued(c, f, 100), paymentId: covered, leaseId: f.leaseId, amount: 10 }, /not an eligible landlord charge/)
    })
  })

  it('a voided tenant credit or a withdrawn paid-ahead credit cannot be used', async () => {
    await withRollback(async c => {
      const f = await household(c)
      const row = await charge(c, f)
      const voided = await issued(c, f, 100)
      await c.query(`UPDATE tenant_credits SET status = 'void', voided_at = now() WHERE id = $1`, [voided])
      await refusedUse(c, { tenantCreditId: voided, paymentId: row, leaseId: f.leaseId, amount: 10 }, /voided credit cannot be used/)
      const withdrawn = await paidAhead(c, f, 100)
      await c.query(`UPDATE lease_prepaid_credits SET voided_at = now(), void_reason = 'bank deposit undone' WHERE id = $1`, [withdrawn])
      await refusedUse(c, { prepaidCreditId: withdrawn, paymentId: row, leaseId: f.leaseId, amount: 10 }, /withdrawn credit cannot be used/)
      // A withdrawal must say why.
      await refused(c, `UPDATE lease_prepaid_credits SET voided_at = now() WHERE id = $1`, [await paidAhead(c, f, 5)],
        /lease_prepaid_credits_void_has_reason/)
    })
  })

  it('spending past amount_remaining fails (no double spend)', async () => {
    await withRollback(async c => {
      const f = await household(c)
      const credit = await issued(c, f, 100)
      await use(c, { tenantCreditId: credit, paymentId: await charge(c, f, { amount: 60 }), leaseId: f.leaseId, amount: 60 })
      await refusedUse(c, { tenantCreditId: credit, paymentId: await charge(c, f, { amount: 60 }), leaseId: f.leaseId, amount: 60 },
        /tenant_credits_amount_remaining_check/)
      const money = await paidAhead(c, f, 50)
      await use(c, { prepaidCreditId: money, paymentId: await charge(c, f, { amount: 50 }), leaseId: f.leaseId, amount: 50 })
      await refusedUse(c, { prepaidCreditId: money, paymentId: await charge(c, f, { amount: 50 }), leaseId: f.leaseId, amount: 1 },
        /lease_prepaid_credits_amount_remaining_check/)
      expect(await remaining(c, 'tenant_credits', credit)).toBe(40)
      expect(await remaining(c, 'lease_prepaid_credits', money)).toBe(0)
      // One row cannot be covered past its own amount, even from two credits.
      const row = await charge(c, f, { amount: 30 })
      await use(c, { tenantCreditId: credit, paymentId: row, leaseId: f.leaseId, amount: 20 })
      await refusedUse(c, { tenantCreditId: await issued(c, f, 100), paymentId: row, leaseId: f.leaseId, amount: 20 }, /paid twice by credit/)
    })
  })
})

describe('S655 credit_uses: concurrency', () => {
  it('two concurrent uses cannot cover one row past its amount', async () => {
    const setup = await db.connect()
    let f: Household, row: string, creditA: string, creditB: string
    try {
      await setup.query('BEGIN')
      f = await household(setup)
      row = await charge(setup, f, { amount: 100 })
      creditA = await issued(setup, f, 100)
      creditB = await issued(setup, f, 100)
      await setup.query('COMMIT')
    } finally { setup.release() }

    const one = await db.connect()
    const two = await db.connect()
    try {
      await one.query('BEGIN')
      await two.query('BEGIN')
      await use(one, { tenantCreditId: creditA, paymentId: row, leaseId: f.leaseId, amount: 100 })
      const twoPid = (await two.query(`SELECT pg_backend_pid() AS pid`)).rows[0].pid
      // The second writer waits on the charge row the first one locked...
      const second = use(two, { tenantCreditId: creditB, paymentId: row, leaseId: f.leaseId, amount: 100 })
        .then(() => null, (e: Error) => e)
      for (let i = 0; i < 100; i++) {
        const w = await db.query(`SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1`, [twoPid])
        if (w.rows[0]?.wait_event_type === 'Lock') break
        await new Promise(r => setTimeout(r, 20))
      }
      // ...and, once the first commits, sees its use and is refused.
      await one.query('COMMIT')
      const err = await second
      expect(err).not.toBeNull()
      expect(String(err?.message)).toMatch(/paid twice by credit/)
      await two.query('ROLLBACK')

      const uses = await db.query(`SELECT tenant_credit_id FROM credit_uses WHERE payment_id = $1`, [row])
      expect(uses.rows.map(r => r.tenant_credit_id)).toEqual([creditA])
      const left = await db.query(`SELECT id, amount_remaining::float AS r FROM tenant_credits WHERE id = ANY($1)`, [[creditA, creditB]])
      expect(Object.fromEntries(left.rows.map(r => [r.id, r.r]))).toEqual({ [creditA]: 0, [creditB]: 100 })
    } finally {
      // A failed expectation leaves a transaction open; end it before the
      // connection goes back to the pool, or cleanup waits on its locks.
      // Both at once: whichever one is still waiting on the other's lock
      // finishes when the other ends.
      await Promise.all([one.query('ROLLBACK').catch(() => {}), two.query('ROLLBACK').catch(() => {})])
      one.release(); two.release()
      await cleanupAllSchema()
    }
  })

  // payments.issued_credit_amount is summed by the ledger trigger. These two
  // interleavings each lost a use before the trigger locked the charge on a
  // status move too: the second writer summed the uses from a view taken
  // before it waited on the first writer's charge lock, then wrote that stale
  // sum over the first writer's. The issued part is what keeps landlord-issued
  // credit out of income and out of a payout, so a lost use is money GAM would
  // pay out without having received it.
  async function committedCharge(o: ChargeOpts & { intent: string }): Promise<{
    f: Household; row: string; rem: string; creditX: string; creditY: string
  }> {
    const setup = await db.connect()
    try {
      await setup.query('BEGIN')
      const f = await household(setup)
      const row = await charge(setup, f, { amount: 100, ...o })
      const rem = await remittance(setup, f, 100, o.intent)
      const creditX = await issued(setup, f, 100)
      const creditY = await issued(setup, f, 100)
      await setup.query('COMMIT')
      return { f, row, rem, creditX, creditY }
    } catch (e) {
      await setup.query('ROLLBACK').catch(() => {})
      throw e
    } finally { setup.release() }
  }
  async function blockedOnALock(pid: number): Promise<boolean> {
    for (let i = 0; i < 150; i++) {
      const w = await db.query(`SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1`, [pid])
      if (w.rows[0]?.wait_event_type === 'Lock') return true
      await new Promise(r => setTimeout(r, 20))
    }
    return false
  }
  async function issuedVsLedger(row: string): Promise<{ column: number; ledger: number }> {
    const r = await db.query(
      `SELECT p.issued_credit_amount::float AS column,
              (SELECT COALESCE(SUM(u.amount), 0) FROM credit_uses u JOIN tenant_credits tc ON tc.id = u.tenant_credit_id
                WHERE u.payment_id = p.id AND u.status = 'applied' AND tc.category <> 'deposit_interest')::float AS ledger
         FROM payments p WHERE p.id = $1`, [row])
    return r.rows[0]
  }

  it('issued_credit_amount keeps a use spent while another writer releases held credit on the same charge', async () => {
    const intent = `pi_${randomUUID()}`
    const { f, row, rem, creditX, creditY } = await committedCharge({ status: 'failed', intent })
    const held = (await db.query<{ id: string }>(USE_SQL, useParams(
      { tenantCreditId: creditX, paymentId: row, remittanceId: rem, leaseId: f.leaseId, amount: 40, status: 'held' }))).rows[0].id
    const one = await db.connect()
    const two = await db.connect()
    try {
      await one.query('BEGIN')
      await two.query('BEGIN')
      // Writer two spends $30 of another credit on the charge (riding the same
      // payment, so the one-payment rule lets it) and has not committed yet.
      await use(two, { tenantCreditId: creditY, paymentId: row, remittanceId: rem, leaseId: f.leaseId, amount: 30, source: 'portal' })
      // Writer one gives the $40 held credit back; it waits on the charge...
      const onePid = (await one.query(`SELECT pg_backend_pid() AS pid`)).rows[0].pid
      const release = one.query(
        `UPDATE credit_uses SET status = 'released', released_at = now(), release_reason = 'payment_failed' WHERE id = $1`, [held])
        .then(() => null, (e: Error) => e)
      expect(await blockedOnALock(onePid)).toBe(true)
      // ...and once two commits, finishes without dropping two's $30.
      await two.query('COMMIT')
      expect(await release).toBeNull()
      await one.query('COMMIT')
      expect(await issuedVsLedger(row)).toEqual({ column: 30, ledger: 30 })
      const left = await db.query(`SELECT id, amount_remaining::float AS r FROM tenant_credits WHERE id = ANY($1)`, [[creditX, creditY]])
      expect(Object.fromEntries(left.rows.map(r => [r.id, r.r]))).toEqual({ [creditX]: 100, [creditY]: 70 })
    } finally {
      // A failed expectation leaves a transaction open; end it before the
      // connection goes back to the pool, or cleanup waits on its locks.
      // Both at once: whichever one is still waiting on the other's lock
      // finishes when the other ends.
      await Promise.all([one.query('ROLLBACK').catch(() => {}), two.query('ROLLBACK').catch(() => {})])
      one.release(); two.release()
      await cleanupAllSchema()
    }
  })

  it('issued_credit_amount counts both uses when two writers spend held credit on the same charge at once', async () => {
    const intent = `pi_${randomUUID()}`
    const { f, row, rem, creditX, creditY } = await committedCharge({ status: 'processing', intent })
    const holdOne = async (credit: string, amount: number) => (await db.query<{ id: string }>(USE_SQL, useParams(
      { tenantCreditId: credit, paymentId: row, remittanceId: rem, leaseId: f.leaseId, amount, status: 'held' }))).rows[0].id
    const thirty = await holdOne(creditX, 30)
    const forty = await holdOne(creditY, 40)
    const one = await db.connect()
    const two = await db.connect()
    const apply = `UPDATE credit_uses SET status = 'applied', applied_at = now() WHERE id = $1`
    try {
      await one.query('BEGIN')
      await two.query('BEGIN')
      await two.query(apply, [thirty])
      const onePid = (await one.query(`SELECT pg_backend_pid() AS pid`)).rows[0].pid
      const second = one.query(apply, [forty]).then(() => null, (e: Error) => e)
      expect(await blockedOnALock(onePid)).toBe(true)
      await two.query('COMMIT')
      expect(await second).toBeNull()
      await one.query('COMMIT')
      expect(await issuedVsLedger(row)).toEqual({ column: 70, ledger: 70 })
    } finally {
      // A failed expectation leaves a transaction open; end it before the
      // connection goes back to the pool, or cleanup waits on its locks.
      // Both at once: whichever one is still waiting on the other's lock
      // finishes when the other ends.
      await Promise.all([one.query('ROLLBACK').catch(() => {}), two.query('ROLLBACK').catch(() => {})])
      one.release(); two.release()
      await cleanupAllSchema()
    }
  })
})

describe('S655 credit_uses: status moves the balance exactly once', () => {
  it('held→applied lowers nothing twice; held→released restores once; applied→reversed restores once and only for paid-ahead', async () => {
    await withRollback(async c => {
      const f = await household(c)
      const credit = await issued(c, f, 100)
      const rem = await remittance(c, f, 500)
      const rowA = await charge(c, f, { amount: 460 })
      const held = await use(c, { tenantCreditId: credit, paymentId: rowA, leaseId: f.leaseId, amount: 40, status: 'held', remittanceId: rem })
      expect(await remaining(c, 'tenant_credits', credit)).toBe(60)
      expect(await issuedOn(c, rowA)).toBe(0)               // held is not spent yet
      await c.query(`UPDATE credit_uses SET status = 'applied', applied_at = now() WHERE id = $1`, [held])
      expect(await remaining(c, 'tenant_credits', credit)).toBe(60)
      expect(await issuedOn(c, rowA)).toBe(40)

      const rowB = await charge(c, f, { amount: 30 })
      const failed = await use(c, { tenantCreditId: credit, paymentId: rowB, leaseId: f.leaseId, amount: 30, status: 'held', remittanceId: rem })
      expect(await remaining(c, 'tenant_credits', credit)).toBe(30)
      await c.query(`UPDATE credit_uses SET status = 'released', released_at = now(), release_reason = 'payment_failed' WHERE id = $1`, [failed])
      expect(await remaining(c, 'tenant_credits', credit)).toBe(60)
      // Writing the same status again changes nothing.
      await c.query(`UPDATE credit_uses SET status = 'released' WHERE id = $1`, [failed])
      expect(await remaining(c, 'tenant_credits', credit)).toBe(60)
      await refused(c, `UPDATE credit_uses SET status = 'applied', applied_at = now(), released_at = NULL, release_reason = NULL WHERE id = $1`,
        [failed], /cannot go from released to applied/)
      // Issued credit is never reversed: spent, it comes back only when a
      // shortened stay no longer has the nights it paid (released, 'stay_shortened').
      await refused(c, `UPDATE credit_uses SET status = 'reversed', released_at = now(), release_reason = 'funding_reversed' WHERE id = $1`,
        [held], /credit_uses_reversed_is_paid_ahead/)
      await refused(c, `UPDATE credit_uses SET status = 'released', applied_at = NULL, released_at = now(), release_reason = 'superseded' WHERE id = $1`,
        [held], /cannot go from applied to released/)

      const money = await paidAhead(c, f, 50, { fundedBy: 'gam' })
      const spent = await use(c, { prepaidCreditId: money, paymentId: await charge(c, f, { amount: 25 }), leaseId: f.leaseId, amount: 25 })
      expect(await remaining(c, 'lease_prepaid_credits', money)).toBe(25)
      await c.query(`UPDATE credit_uses SET status = 'reversed', released_at = now(), release_reason = 'funding_reversed' WHERE id = $1`, [spent])
      expect(await remaining(c, 'lease_prepaid_credits', money)).toBe(50)
      await refused(c, `UPDATE credit_uses SET status = 'applied', released_at = NULL, release_reason = NULL WHERE id = $1`,
        [spent], /cannot go from reversed to applied/)
      expect(await remaining(c, 'lease_prepaid_credits', money)).toBe(50)
    })
  })

  it('landlord-issued credit spent on rent comes back when a stay is shortened: the credit is whole again, the use keeps the day it was spent, and the rent row comes down by the same amount', async () => {
    await withRollback(async c => {
      const f = await household(c)
      const credit = await issued(c, f, 100)
      const row = await charge(c, f, { amount: 460 })
      const spent = await use(c, { tenantCreditId: credit, paymentId: row, leaseId: f.leaseId, amount: 60 })
      await c.query(`UPDATE payments SET status = 'settled', settled_at = now(), manual_method = 'cash' WHERE id = $1`, [row])
      const spentAt = (await c.query(`SELECT applied_at FROM credit_uses WHERE id = $1`, [spent])).rows[0].applied_at
      expect(await remaining(c, 'tenant_credits', credit)).toBe(40)
      expect(await issuedOn(c, row)).toBe(60)
      // Given back for any other reason, or without the day it was spent, is refused.
      await refused(c, `UPDATE credit_uses SET status = 'released', released_at = now(), release_reason = 'superseded' WHERE id = $1`,
        [spent], /credit_uses_status_stamps|cannot go from applied to released/)
      await refused(c, `UPDATE credit_uses SET status = 'released', applied_at = NULL, released_at = now(), release_reason = 'stay_shortened' WHERE id = $1`,
        [spent], /credit_uses_status_stamps|keeps the day it was used/)

      await c.query(`UPDATE credit_uses SET status = 'released', released_at = now(), release_reason = 'stay_shortened' WHERE id = $1`, [spent])
      expect(await remaining(c, 'tenant_credits', credit)).toBe(100)
      expect(await issuedOn(c, row)).toBe(0)
      // The row asks only what its own money paid; that money ($400) never moved,
      // so no report or payout counts the given-back credit as money.
      expect(Number((await c.query(`SELECT amount FROM payments WHERE id = $1`, [row])).rows[0].amount)).toBe(400)
      expect(Number((await c.query(`SELECT money_part FROM v_payment_money WHERE payment_id = $1`, [row])).rows[0].money_part)).toBe(400)
      const u = (await c.query(`SELECT applied_at, release_reason FROM credit_uses WHERE id = $1`, [spent])).rows[0]
      expect(u.applied_at).toEqual(spentAt)
      expect(u.release_reason).toBe('stay_shortened')
      // Writing it again moves nothing twice; it never goes back to spent.
      await c.query(`UPDATE credit_uses SET status = 'released' WHERE id = $1`, [spent])
      expect(await remaining(c, 'tenant_credits', credit)).toBe(100)
      expect(Number((await c.query(`SELECT amount FROM payments WHERE id = $1`, [row])).rows[0].amount)).toBe(400)
      await refused(c, `UPDATE credit_uses SET status = 'applied', released_at = NULL, release_reason = NULL WHERE id = $1`,
        [spent], /cannot go from released to applied/)
      // Credit given back is not live credit: the row may go (an unpaid one past the new end).
      const unpaid = await charge(c, f, { amount: 460 })
      const onUnpaid = await use(c, { tenantCreditId: credit, paymentId: unpaid, leaseId: f.leaseId, amount: 30 })
      await c.query(`UPDATE credit_uses SET status = 'released', released_at = now(), release_reason = 'stay_shortened' WHERE id = $1`, [onUnpaid])
      await c.query(`DELETE FROM payments WHERE id = $1`, [unpaid])
      expect((await c.query(`SELECT payment_id, status FROM credit_uses WHERE id = $1`, [onUnpaid])).rows[0])
        .toEqual({ payment_id: null, status: 'released' })
      expect(await remaining(c, 'tenant_credits', credit)).toBe(100)
    })
  })

  it('only credit the landlord issued, spent on rent, comes back for a shortened stay: deposit interest, money paid ahead and credit on a fee are refused', async () => {
    await withRollback(async c => {
      const f = await household(c)
      const giveBack = `UPDATE credit_uses SET status = 'released', released_at = now(), release_reason = 'stay_shortened' WHERE id = $1`
      const interest = await use(c, { tenantCreditId: await issued(c, f, 20, { category: 'deposit_interest' }),
        paymentId: await charge(c, f), leaseId: f.leaseId, amount: 20 })
      await refused(c, giveBack, [interest], /Only credit the landlord issued, spent on rent/)
      const money = await use(c, { prepaidCreditId: await paidAhead(c, f, 50), paymentId: await charge(c, f), leaseId: f.leaseId, amount: 50 })
      await refused(c, giveBack, [money], /Only credit the landlord issued, spent on rent/)
      const onFee = await use(c, { tenantCreditId: await issued(c, f, 25), paymentId: await charge(c, f, { type: 'fee', entry: 'OTHERFEE' }),
        leaseId: f.leaseId, amount: 25 })
      await refused(c, giveBack, [onFee], /Only credit the landlord issued, spent on rent/)
      // Credit only set aside (held) is given back the ordinary way, never as a stay give-back.
      const held = await use(c, { tenantCreditId: await issued(c, f, 10), paymentId: await charge(c, f), leaseId: f.leaseId,
        amount: 10, status: 'held', remittanceId: await remittance(c, f, 450) })
      await refused(c, giveBack, [held], /credit_uses_status_stamps/)
    })
  })

  it('issued_credit_amount follows applied landlord-issued uses and ignores deposit interest', async () => {
    await withRollback(async c => {
      const f = await household(c)
      const row = await charge(c, f, { amount: 935.45 })
      await use(c, { tenantCreditId: await issued(c, f, 450), paymentId: row, leaseId: f.leaseId, amount: 450 })
      expect(await issuedOn(c, row)).toBe(450)
      await use(c, { tenantCreditId: await issued(c, f, 20, { category: 'deposit_interest' }), paymentId: row, leaseId: f.leaseId, amount: 20 })
      expect(await issuedOn(c, row)).toBe(450)
      await use(c, { prepaidCreditId: await paidAhead(c, f, 15), paymentId: row, leaseId: f.leaseId, amount: 15 })
      expect(await issuedOn(c, row)).toBe(450)
      await use(c, { tenantCreditId: await issued(c, f, 10, { leaseId: null }), paymentId: row, leaseId: f.leaseId, amount: 10 })
      expect(await issuedOn(c, row)).toBe(460)
      // Only the ledger writes it: it is a whole-row recompute, never an increment.
      const recount = await c.query(
        `SELECT COALESCE(SUM(u.amount),0)::float AS s FROM credit_uses u JOIN tenant_credits tc ON tc.id = u.tenant_credit_id
          WHERE u.payment_id = $1 AND u.status = 'applied' AND tc.category <> 'deposit_interest'`, [row])
      expect(recount.rows[0].s).toBe(460)
      await refused(c, `UPDATE payments SET issued_credit_amount = -1 WHERE id = $1`, [row], /payments_issued_credit_amount_nonneg/)
    })
  })

  it('credit uses cannot be deleted or edited except status', async () => {
    await withRollback(async c => {
      const f = await household(c)
      const id = await use(c, { tenantCreditId: await issued(c, f, 100), paymentId: await charge(c, f), leaseId: f.leaseId, amount: 10 })
      await refused(c, `DELETE FROM credit_uses WHERE id = $1`, [id], /kept forever/)
      await refused(c, `UPDATE credit_uses SET amount = 5 WHERE id = $1`, [id], /only its status moves/)
      await refused(c, `UPDATE credit_uses SET billing_month = '2026-11-01' WHERE id = $1`, [id], /only its status moves/)
      await refused(c, `UPDATE credit_uses SET payment_id = $2 WHERE id = $1`, [id, await charge(c, f)], /only its status moves/)
      await refused(c, `UPDATE credit_uses SET source = 'portal' WHERE id = $1`, [id], /only its status moves/)
      // The stamps are history: the day a credit was used (deposit interest counts
      // as income that day) never moves, with or without a status change.
      await refused(c, `UPDATE credit_uses SET applied_at = '2020-01-01' WHERE id = $1`, [id], /only its status moves/)
      await refused(c, `UPDATE credit_uses SET status = 'applied', applied_at = '2020-01-01' WHERE id = $1`, [id], /only its status moves/)
      const money = await paidAhead(c, f, 50)
      const spent = await use(c, { prepaidCreditId: money, paymentId: await charge(c, f), leaseId: f.leaseId, amount: 25 })
      await refused(c, `UPDATE credit_uses SET status = 'reversed', applied_at = '2020-01-01', released_at = now(), release_reason = 'funding_reversed' WHERE id = $1`,
        [spent], /keeps the day it was used/)
      await c.query(`UPDATE credit_uses SET status = 'reversed', released_at = now(), release_reason = 'funding_reversed' WHERE id = $1`, [spent])
      await refused(c, `UPDATE credit_uses SET released_at = '2020-01-01' WHERE id = $1`, [spent], /only its status moves/)
      // A released use: when and why it was given back never move either, not
      // even alongside the FK's own change (payment_id to NULL).
      const row = await charge(c, f)
      const given = await use(c, { tenantCreditId: await issued(c, f, 100), paymentId: row, leaseId: f.leaseId, amount: 10, status: 'held',
        remittanceId: await remittance(c, f, 450) })
      await c.query(`UPDATE credit_uses SET status = 'released', released_at = now(), release_reason = 'payment_failed' WHERE id = $1`, [given])
      await refused(c, `UPDATE credit_uses SET release_reason = 'superseded' WHERE id = $1`, [given], /only its status moves/)
      await refused(c, `UPDATE credit_uses SET payment_id = NULL, released_at = '2020-01-01' WHERE id = $1`, [given], /only its status moves/)
      // A live use keeps its target (the one-target check and the trigger both refuse it).
      await refused(c, `UPDATE credit_uses SET payment_id = NULL WHERE id = $1`, [id], /credit_uses_one_target|only its status moves/)
      const stamps = await c.query(`SELECT id, applied_at, released_at, release_reason FROM credit_uses WHERE id = ANY($1)`, [[id, spent, given]])
      const by = Object.fromEntries(stamps.rows.map(r => [r.id, r]))
      for (const r of stamps.rows) {
        for (const at of [r.applied_at, r.released_at]) if (at) expect(new Date(at).getUTCFullYear()).toBeGreaterThan(2020)
      }
      expect([by[id].release_reason, by[spent].release_reason, by[given].release_reason]).toEqual([null, 'funding_reversed', 'payment_failed'])
      await refused(c, `INSERT INTO credit_uses (tenant_credit_id, payment_id, lease_id, amount, billing_month, source, status, applied_at)
                        VALUES ($1,$2,$3,10,'2026-10-15','desk','applied',now())`,
        [await issued(c, f, 100), await charge(c, f), f.leaseId], /credit_uses_month_is_first/)
    })
  })

  it('deleting an unpaid charge keeps its released uses with no target; a charge with a live use cannot be deleted', async () => {
    await withRollback(async c => {
      const f = await household(c)
      const credit = await issued(c, f, 100)
      const row = await charge(c, f)
      const held = await use(c, { tenantCreditId: credit, paymentId: row, leaseId: f.leaseId, amount: 40, status: 'held', remittanceId: await remittance(c, f, 420) })
      await refused(c, `DELETE FROM payments WHERE id = $1`, [row], /has account credit on it and cannot be deleted/)
      await c.query(`UPDATE credit_uses SET status = 'released', released_at = now(), release_reason = 'superseded' WHERE id = $1`, [held])
      await c.query(`DELETE FROM payments WHERE id = $1`, [row])
      const kept = await c.query(`SELECT status, payment_id, amount::float AS amount FROM credit_uses WHERE id = $1`, [held])
      expect(kept.rows[0]).toEqual({ status: 'released', payment_id: null, amount: 40 })
      expect(await remaining(c, 'tenant_credits', credit)).toBe(100)

      const spentRow = await charge(c, f)
      await use(c, { tenantCreditId: credit, paymentId: spentRow, leaseId: f.leaseId, amount: 10 })
      await refused(c, `DELETE FROM payments WHERE id = $1`, [spentRow], /has account credit on it/)
    })
  })

  it('the backfill switch works only for source backfill', async () => {
    await withRollback(async c => {
      const f = await household(c)
      // Without the switch, nobody may write a backfill use.
      await refusedUse(c, { tenantCreditId: await issued(c, f, 100), paymentId: await charge(c, f), leaseId: f.leaseId, amount: 10, source: 'backfill' },
        /only for the deploy backfill/)

      await c.query(`SET LOCAL gam.credit_backfill = 'on'`)
      // Kim Harland: the $450 move-in special already came off her credit and her
      // rent already settled. The backfill records it without spending it twice.
      const kim = await issued(c, f, 450)
      await c.query(`UPDATE tenant_credits SET amount_remaining = 0 WHERE id = $1`, [kim])
      const rent = await charge(c, f, { amount: 935.45, status: 'settled', manualMethod: 'money_order' })
      await use(c, { tenantCreditId: kim, paymentId: rent, leaseId: f.leaseId, amount: 450, source: 'backfill', month: '2026-09-01' })
      expect(await remaining(c, 'tenant_credits', kim)).toBe(0)
      expect(await issuedOn(c, rent)).toBe(450)
      // The switch changes nothing for any other source.
      const other = await issued(c, f, 100)
      await refusedUse(c, { tenantCreditId: other, paymentId: await charge(c, f, { status: 'settled' }), leaseId: f.leaseId, amount: 10, source: 'desk' },
        /already paid/)
      await use(c, { tenantCreditId: other, paymentId: await charge(c, f), leaseId: f.leaseId, amount: 10, source: 'desk' })
      expect(await remaining(c, 'tenant_credits', other)).toBe(90)
      // Eligibility still holds for the backfill: it can never put credit on a GAM fee.
      await refusedUse(c, { tenantCreditId: other, paymentId: await charge(c, f, { type: 'fee', entry: 'RETURNFEE', owner: 'gam', status: 'settled' }),
        leaseId: f.leaseId, amount: 5, source: 'backfill' }, /not an eligible landlord charge/)
    })
  })

  it('move-out uses take only paid-ahead money or deposit interest from their own lease; dispute clawbacks take only paid-ahead money', async () => {
    await withRollback(async c => {
      const f = await household(c)
      const other = await household(c, { landlord: { landlordId: f.landlordId, userId: f.userId }, propertyId: f.propertyId, tenantId: f.tenantId })
      const money = await paidAhead(c, f, 80)
      const returnId = await seedDepositReturnDraft(c, { leaseId: f.leaseId, tenantId: f.tenantId, landlordId: f.landlordId, totalDeposit: 460 })
      const otherReturn = await seedDepositReturnDraft(c, { leaseId: other.leaseId, tenantId: f.tenantId, landlordId: f.landlordId, totalDeposit: 460 })
      await refusedUse(c, { prepaidCreditId: money, depositReturnId: otherReturn, leaseId: f.leaseId, amount: 10, source: 'move_out' },
        /joins only its own lease's move-out/)
      // Landlord-issued credit never joins a move-out (the trigger reads its category).
      await refusedUse(c, { tenantCreditId: await issued(c, f, 50), depositReturnId: returnId, leaseId: f.leaseId, amount: 10, source: 'move_out' },
        /Only deposit interest on this lease joins its move-out/)
      // A move-out use is always source 'move_out'.
      await refusedUse(c, { prepaidCreditId: money, depositReturnId: returnId, leaseId: f.leaseId, amount: 10, source: 'portal' },
        /credit_uses_move_out_is_paid_ahead/)
      // Deposit interest the tenant was credited on this lease is owed back with the deposit;
      // interest credited on another lease is not this move-out's.
      const interest = await issued(c, f, 12, { category: 'deposit_interest' })
      await use(c, { tenantCreditId: interest, depositReturnId: returnId, leaseId: f.leaseId, amount: 12, source: 'move_out' })
      expect(await remaining(c, 'tenant_credits', interest)).toBe(0)
      await refusedUse(c, { tenantCreditId: await issued(c, f, 12, { category: 'deposit_interest', leaseId: other.leaseId }),
        depositReturnId: returnId, leaseId: f.leaseId, amount: 5, source: 'move_out' },
        /Only deposit interest on this lease joins its move-out/)
      await use(c, { prepaidCreditId: money, depositReturnId: returnId, leaseId: f.leaseId, amount: 30, source: 'move_out' })
      const reversal = await reversalOf(c, f, await charge(c, f, { status: 'returned' }))
      await use(c, { prepaidCreditId: money, paymentReversalId: reversal, leaseId: f.leaseId, amount: 50, source: 'reversal' })
      expect(await remaining(c, 'lease_prepaid_credits', money)).toBe(0)
    })
  })
})

describe('S655 views: who paid each charge', () => {
  it('v_payment_money: a failed-then-desk-settled row with an old intent has gam_held_part 0', async () => {
    await withRollback(async c => {
      const f = await household(c)
      const desk = await charge(c, f, { status: 'settled', manualMethod: 'cash', intent: 'pi_old_failed', chargeId: 'ch_old' })
      const card = await charge(c, f, { status: 'settled', intent: 'pi_card', chargeId: 'ch_card', platformHeld: true })
      const money = await c.query(`SELECT payment_id, money_part::float, gam_held_part::float FROM v_payment_money WHERE payment_id = ANY($1)`, [[desk, card]])
      const by = Object.fromEntries(money.rows.map(r => [r.payment_id, r]))
      expect(by[desk]).toMatchObject({ money_part: 460, gam_held_part: 0 })
      expect(by[card]).toMatchObject({ money_part: 460, gam_held_part: 460 })
    })
  })

  it("v_payment_money: a settled GAM fee, a FLEXPAY pull and a Stripe-settled held move-in box each have gam_held_part 0", async () => {
    await withRollback(async c => {
      const f = await household(c)
      const fee = await seedLeaseFee(c, { leaseId: f.leaseId, feeType: 'last_month_rent', amount: 460, dueTiming: 'move_in' })
      await c.query(`UPDATE lease_fees SET money_kind = 'prepaid' WHERE id = $1`, [fee])
      const stripe = { status: 'settled', intent: 'pi_gam', chargeId: 'ch_gam', platformHeld: true }
      const gamFee = await charge(c, f, { ...stripe, type: 'fee', entry: 'RETURNFEE', owner: 'gam', amount: 6 })
      const pull = await charge(c, f, { ...stripe, type: 'fee', entry: 'FLEXPAY', owner: 'gam', amount: 25 })
      const box = await charge(c, f, { type: 'fee', entry: 'OTHERFEE', owner: 'held', leaseFeeId: fee, status: 'processing', intent: 'pi_box', platformHeld: true })
      await c.query(`UPDATE payments SET status = 'settled', settled_at = now(), stripe_charge_id = 'ch_box' WHERE id = $1`, [box])
      const landlordRent = await charge(c, f, stripe)
      const v = await c.query(`SELECT payment_id, money_part::float, gam_held_part::float FROM v_payment_money WHERE payment_id = ANY($1)`,
        [[gamFee, pull, box, landlordRent]])
      const by = Object.fromEntries(v.rows.map(r => [r.payment_id, r]))
      expect(by[gamFee]).toMatchObject({ money_part: 6, gam_held_part: 0 })
      expect(by[pull]).toMatchObject({ money_part: 25, gam_held_part: 0 })
      expect(by[box]).toMatchObject({ money_part: 460, gam_held_part: 0 })
      expect(by[landlordRent]).toMatchObject({ money_part: 460, gam_held_part: 460 })
    })
  })

  it('v_payment_money: a deposit held in trust and a move-out refund row carry no payout figure; a card-paid move-out shortfall does', async () => {
    await withRollback(async c => {
      const f = await household(c)
      const stripe = { status: 'settled', chargeId: 'ch_trust', platformHeld: true }
      // The security deposit and a refundable pet deposit (both type deposit)
      // stay in trust until move-out; paid out at settle they would be paid twice.
      const security = await charge(c, f, { ...stripe, intent: 'pi_dep', type: 'deposit', entry: 'DEPOSIT', amount: 500 })
      const refundablePet = await seedLeaseFee(c, { leaseId: f.leaseId, feeType: 'pet_deposit', amount: 150, dueTiming: 'move_in', isRefundable: true })
      const pet = await charge(c, f, { ...stripe, intent: 'pi_pet', type: 'deposit', entry: 'DEPOSIT', amount: 150, leaseFeeId: refundablePet })
      // The move-out refund row: the landlord owes it back.
      const refund = await charge(c, f, { status: 'settled', type: 'fee', entry: 'DEPOSIT', amount: -200 })
      // Deductions past the deposit, paid by the tenant's card: the landlord's money.
      const shortfall = await charge(c, f, { ...stripe, intent: 'pi_gap', type: 'fee', entry: 'DEPOSIT', amount: 120 })
      const v = await c.query(`SELECT payment_id, money_part::float, gam_held_part::float FROM v_payment_money WHERE payment_id = ANY($1)`,
        [[security, pet, refund, shortfall]])
      const by = Object.fromEntries(v.rows.map(r => [r.payment_id, r]))
      expect(by[security]).toMatchObject({ money_part: 500, gam_held_part: 0 })
      expect(by[pet]).toMatchObject({ money_part: 150, gam_held_part: 0 })
      expect(by[refund]).toMatchObject({ money_part: -200, gam_held_part: 0 })
      expect(by[shortfall]).toMatchObject({ money_part: 120, gam_held_part: 120 })
      // Nothing here touches the trust flag the admin "deposits held" card counts.
      const flags = await c.query(`SELECT bool_and(platform_held) AS held FROM payments WHERE id = ANY($1)`, [[security, pet]])
      expect(flags.rows[0].held).toBe(true)
    })
  })

  it('the move-in box money is paid out once: on the row its paid-ahead credit pays, never on the box row too', async () => {
    await withRollback(async c => {
      const f = await household(c)
      const fee = await seedLeaseFee(c, { leaseId: f.leaseId, feeType: 'last_month_rent', amount: 460, dueTiming: 'move_in' })
      await c.query(`UPDATE lease_fees SET money_kind = 'prepaid' WHERE id = $1`, [fee])
      const box = await charge(c, f, { type: 'fee', entry: 'OTHERFEE', owner: 'held', leaseFeeId: fee, status: 'processing', intent: 'pi_box', platformHeld: true })
      await c.query(`UPDATE payments SET status = 'settled', settled_at = now(), stripe_charge_id = 'ch_box' WHERE id = $1`, [box])
      const credit = (await c.query(`SELECT id, funded_by FROM lease_prepaid_credits WHERE source_payment_id = $1`, [box])).rows[0]
      expect(credit.funded_by).toBe('gam')
      // The last month's rent, paid by that money (the whole-bill rule).
      const lastMonth = await charge(c, f)
      await use(c, { prepaidCreditId: credit.id, paymentId: lastMonth, leaseId: f.leaseId, amount: 460, source: 'whole_bill' })
      await c.query(`UPDATE payments SET status = 'settled', settled_at = now(), platform_held = true WHERE id = $1`, [lastMonth])
      const v = await c.query(`SELECT payment_id, gam_funded_credit::float, gam_held_part::float FROM v_payment_money WHERE payment_id = ANY($1)`,
        [[box, lastMonth]])
      const by = Object.fromEntries(v.rows.map(r => [r.payment_id, r]))
      expect(by[box].gam_held_part).toBe(0)
      expect(by[lastMonth]).toMatchObject({ gam_funded_credit: 460, gam_held_part: 460 })
      // Everything a payout could carry for this money, summed over every row: once.
      const total = await c.query(`SELECT SUM(gam_held_part)::float AS s FROM v_payment_money WHERE payment_id = ANY($1)`, [[box, lastMonth]])
      expect(total.rows[0].s).toBe(460)
    })
  })

  it('splits a row by who paid it: issued credit, landlord-held and GAM-held paid-ahead, deposit interest, money', async () => {
    await withRollback(async c => {
      const f = await household(c)
      const row = await charge(c, f, { amount: 460 })
      await use(c, { tenantCreditId: await issued(c, f, 100), paymentId: row, leaseId: f.leaseId, amount: 100 })
      await use(c, { tenantCreditId: await issued(c, f, 20, { category: 'deposit_interest' }), paymentId: row, leaseId: f.leaseId, amount: 20 })
      await use(c, { prepaidCreditId: await paidAhead(c, f, 30, { fundedBy: 'landlord' }), paymentId: row, leaseId: f.leaseId, amount: 30 })
      await use(c, { prepaidCreditId: await paidAhead(c, f, 40, { fundedBy: 'gam' }), paymentId: row, leaseId: f.leaseId, amount: 40 })
      // Before P2, a credit with no funded_by is GAM-held only when Stripe funded it.
      const stripeRem = await remittance(c, f, 50, 'pi_overpaid')
      await use(c, { prepaidCreditId: await paidAhead(c, f, 50, { fundedBy: null, sourceRemittanceId: stripeRem }), paymentId: row, leaseId: f.leaseId, amount: 50 })
      await c.query(`UPDATE payments SET status = 'settled', settled_at = now(), stripe_charge_id = 'ch_rest', platform_held = true WHERE id = $1`, [row])
      const v = (await c.query(
        `SELECT issued_credit_amount::float AS issued, landlord_held_credit::float AS landlord_held,
                gam_funded_credit::float AS gam_funded, paid_ahead_credit::float AS paid_ahead,
                deposit_interest_credit::float AS interest, money_part::float AS money, gam_held_part::float AS gam_held
           FROM v_payment_money WHERE payment_id = $1`, [row])).rows[0]
      expect(v).toEqual({ issued: 100, landlord_held: 30, gam_funded: 110, paid_ahead: 120, interest: 20, money: 220, gam_held: 330 })
      const kinds = await c.query(`SELECT kind, funded_by, gam_held FROM v_credit_uses WHERE payment_id = $1 ORDER BY amount`, [row])
      expect(kinds.rows).toEqual([
        { kind: 'deposit_interest', funded_by: null, gam_held: true },
        { kind: 'paid_ahead', funded_by: 'landlord', gam_held: false },
        { kind: 'paid_ahead', funded_by: 'gam', gam_held: true },
        { kind: 'paid_ahead', funded_by: null, gam_held: true },
        { kind: 'issued', funded_by: null, gam_held: false },
      ])
    })
  })
})

// ─── the rest of the expand migrations ─────────────────────────────────────

describe('S655 expand migrations', () => {
  it('a prepaid move-in fee settled on the platform is funded by gam, at the desk by landlord', async () => {
    await withRollback(async c => {
      const f = await household(c)
      const fee = await seedLeaseFee(c, { leaseId: f.leaseId, feeType: 'last_month_rent', amount: 460, dueTiming: 'move_in' })
      await c.query(`UPDATE lease_fees SET money_kind = 'prepaid' WHERE id = $1`, [fee])
      const online = await charge(c, f, { type: 'fee', entry: 'OTHERFEE', owner: 'held', leaseFeeId: fee, status: 'processing', intent: 'pi_movein', platformHeld: true })
      const desk = await charge(c, f, { type: 'fee', entry: 'OTHERFEE', owner: 'held', leaseFeeId: fee })
      await c.query(`UPDATE payments SET status = 'settled', settled_at = '2026-09-03T15:00:00Z' WHERE id = $1`, [online])
      await c.query(`UPDATE payments SET status = 'settled', settled_at = '2026-09-04T15:00:00Z', manual_method = 'cash' WHERE id = $1`, [desk])
      const credits = await c.query(
        `SELECT source_payment_id, funded_by, received_at, amount_remaining::float AS left FROM lease_prepaid_credits WHERE source_payment_id = ANY($1)`,
        [[online, desk]])
      const by = Object.fromEntries(credits.rows.map(r => [r.source_payment_id, r]))
      expect(by[online].funded_by).toBe('gam')
      expect(new Date(by[online].received_at).toISOString()).toBe('2026-09-03T15:00:00.000Z')
      expect(by[desk].funded_by).toBe('landlord')
      expect(new Date(by[desk].received_at).toISOString()).toBe('2026-09-04T15:00:00.000Z')
      expect(by[desk].left).toBe(460)
    })
  })

  it('a card-settled move-in box stamped platform_held = FALSE in the same settling UPDATE is still funded by gam', async () => {
    await withRollback(async c => {
      const f = await household(c)
      const fee = await seedLeaseFee(c, { leaseId: f.leaseId, feeType: 'last_month_rent', amount: 460, dueTiming: 'move_in' })
      await c.query(`UPDATE lease_fees SET money_kind = 'prepaid' WHERE id = $1`, [fee])
      // A settle that applies "payout figure 0 → platform_held FALSE" to the box
      // row (its gam_held_part is 0) must not hand GAM's $460 to the landlord's
      // side of the ledger, where it would never be released.
      const byCharge = await charge(c, f, { type: 'fee', entry: 'OTHERFEE', owner: 'held', leaseFeeId: fee, status: 'processing', intent: 'pi_box_card', platformHeld: true })
      await c.query(`UPDATE payments SET status = 'settled', settled_at = now(), stripe_charge_id = 'ch_box_card', platform_held = FALSE WHERE id = $1`, [byCharge])
      // The same with only the intent on the row (no charge id written yet).
      const byIntent = await charge(c, f, { type: 'fee', entry: 'OTHERFEE', owner: 'held', leaseFeeId: fee, status: 'processing', intent: 'pi_box_intent', platformHeld: true })
      await c.query(`UPDATE payments SET status = 'settled', settled_at = now(), platform_held = FALSE WHERE id = $1`, [byIntent])
      const funded = await c.query(`SELECT source_payment_id, funded_by FROM lease_prepaid_credits WHERE source_payment_id = ANY($1)`, [[byCharge, byIntent]])
      expect(Object.fromEntries(funded.rows.map(r => [r.source_payment_id, r.funded_by]))).toEqual({ [byCharge]: 'gam', [byIntent]: 'gam' })
    })
  })

  it('a move-in box paid at the desk over an old card intent is funded by landlord', async () => {
    await withRollback(async c => {
      const f = await household(c)
      const fee = await seedLeaseFee(c, { leaseId: f.leaseId, feeType: 'last_month_rent', amount: 460, dueTiming: 'move_in' })
      await c.query(`UPDATE lease_fees SET money_kind = 'prepaid' WHERE id = $1`, [fee])
      // The card bounced (the intent stays on the row); the tenant then paid cash.
      const box = await charge(c, f, { type: 'fee', entry: 'OTHERFEE', owner: 'held', leaseFeeId: fee, status: 'failed', intent: 'pi_bounced', platformHeld: true })
      await c.query(`UPDATE payments SET status = 'settled', settled_at = now(), manual_method = 'cash', platform_held = FALSE WHERE id = $1`, [box])
      // Even a hand payment that left platform_held TRUE is the landlord's money.
      const check = await charge(c, f, { type: 'fee', entry: 'OTHERFEE', owner: 'held', leaseFeeId: fee, platformHeld: true })
      await c.query(`UPDATE payments SET status = 'settled', settled_at = now(), manual_method = 'check' WHERE id = $1`, [check])
      const funded = await c.query(`SELECT source_payment_id, funded_by FROM lease_prepaid_credits WHERE source_payment_id = ANY($1)`, [[box, check]])
      expect(Object.fromEntries(funded.rows.map(r => [r.source_payment_id, r.funded_by]))).toEqual({ [box]: 'landlord', [check]: 'landlord' })
    })
  })

  it('a withdrawn move-in box credit comes back when the same row is paid again, funded by whoever holds the new money', async () => {
    await withRollback(async c => {
      const f = await household(c)
      const fee = await seedLeaseFee(c, { leaseId: f.leaseId, feeType: 'last_month_rent', amount: 460, dueTiming: 'move_in' })
      await c.query(`UPDATE lease_fees SET money_kind = 'prepaid' WHERE id = $1`, [fee])
      // Settled by a bank-deposit match (the landlord holds it)...
      const box = await charge(c, f, { type: 'fee', entry: 'OTHERFEE', owner: 'held', leaseFeeId: fee })
      await c.query(`UPDATE payments SET status = 'settled', settled_at = '2026-09-04T15:00:00Z', manual_method = 'check' WHERE id = $1`, [box])
      const first = (await c.query(`SELECT id, funded_by FROM lease_prepaid_credits WHERE source_payment_id = $1`, [box])).rows[0]
      expect(first.funded_by).toBe('landlord')
      // ...the match is undone: the row is owed again and its credit withdrawn...
      await c.query(`UPDATE payments SET status = 'pending', settled_at = NULL, manual_method = NULL WHERE id = $1`, [box])
      await c.query(`UPDATE lease_prepaid_credits SET voided_at = now(), void_reason = 'bank deposit match undone' WHERE id = $1`, [first.id])
      // ...and the tenant pays it by card.
      await c.query(`UPDATE payments SET status = 'processing', stripe_payment_intent_id = 'pi_box', platform_held = true WHERE id = $1`, [box])
      await c.query(`UPDATE payments SET status = 'settled', settled_at = '2026-10-05T15:00:00Z', stripe_charge_id = 'ch_box' WHERE id = $1`, [box])
      const back = await c.query(
        `SELECT id, funded_by, received_at, voided_at, void_reason, amount_remaining::float AS left
           FROM lease_prepaid_credits WHERE source_payment_id = $1`, [box])
      expect(back.rows).toHaveLength(1)
      expect(back.rows[0]).toMatchObject({ id: first.id, funded_by: 'gam', voided_at: null, void_reason: null, left: 460 })
      expect(new Date(back.rows[0].received_at).toISOString()).toBe('2026-10-05T15:00:00.000Z')
    })
  })

  it('a box credit that was spent, or never withdrawn, keeps its record when its row settles again', async () => {
    await withRollback(async c => {
      const f = await household(c)
      const fee = await seedLeaseFee(c, { leaseId: f.leaseId, feeType: 'last_month_rent', amount: 460, dueTiming: 'move_in' })
      await c.query(`UPDATE lease_fees SET money_kind = 'prepaid' WHERE id = $1`, [fee])
      const settleAgain = async (box: string) => {
        await c.query(`UPDATE payments SET status = 'pending', settled_at = NULL, manual_method = NULL WHERE id = $1`, [box])
        await c.query(`UPDATE payments SET status = 'settled', settled_at = now(), stripe_payment_intent_id = 'pi_' || md5(id::text),
                              stripe_charge_id = 'ch_again', platform_held = true WHERE id = $1`, [box])
      }
      const neverWithdrawn = await charge(c, f, { type: 'fee', entry: 'OTHERFEE', owner: 'held', leaseFeeId: fee, status: 'settled', manualMethod: 'cash' })
      await settleAgain(neverWithdrawn)
      const kept = await c.query(`SELECT funded_by, voided_at FROM lease_prepaid_credits WHERE source_payment_id = $1`, [neverWithdrawn])
      expect(kept.rows).toEqual([{ funded_by: 'landlord', voided_at: null }])

      const spentBox = await charge(c, f, { type: 'fee', entry: 'OTHERFEE', owner: 'held', leaseFeeId: fee, status: 'settled', manualMethod: 'cash' })
      const spentCredit = (await c.query(`SELECT id FROM lease_prepaid_credits WHERE source_payment_id = $1`, [spentBox])).rows[0].id
      await use(c, { prepaidCreditId: spentCredit, paymentId: await charge(c, f, { amount: 100 }), leaseId: f.leaseId, amount: 100 })
      await c.query(`UPDATE lease_prepaid_credits SET voided_at = now(), void_reason = 'test' WHERE id = $1`, [spentCredit])
      await settleAgain(spentBox)
      const spent = await c.query(`SELECT funded_by, void_reason, amount_remaining::float AS left FROM lease_prepaid_credits WHERE source_payment_id = $1`, [spentBox])
      expect(spent.rows).toEqual([{ funded_by: 'landlord', void_reason: 'test', left: 360 }])
    })
  })

  it('delinquency no longer nets saved credit', async () => {
    await withRollback(async c => {
      const f = await household(c)
      await c.query(`UPDATE units SET status = 'active' WHERE id = $1`, [f.unitId])
      // $460 of saved credit used to hide a $460 late rent entirely.
      await issued(c, f, 460)
      const late = await charge(c, f, { dueDate: '2026-01-01' })
      expect((await c.query(`SELECT status FROM units WHERE id = $1`, [f.unitId])).rows[0].status).toBe('delinquent')
      // Paying the rent clears it.
      await c.query(`UPDATE payments SET status = 'settled', settled_at = now() WHERE id = $1`, [late])
      expect((await c.query(`SELECT status FROM units WHERE id = $1`, [f.unitId])).rows[0].status).toBe('active')
    })
  })

  it('the database CHECKs list exactly the shared values', async () => {
    const defs = await db.query<{ conname: string; def: string }>(
      `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname IN ('credit_uses_source_check','credit_uses_status_check','credit_uses_status_stamps',
                          'lease_prepaid_credits_funded_by_check','bank_deposit_slips_status_check',
                          'bank_deposit_slips_source_check','platform_revenue_ledger_type_check',
                          'held_payout_items_source_type_check','tenant_credits_category_check',
                          'payments_revenue_owner_check')`)
    const def = Object.fromEntries(defs.rows.map(r => [r.conname, r.def]))
    const quoted = (d: string) => [...d.matchAll(/'([a-z_]+)'::text/g)].map(m => m[1]).sort()
    const same = (name: string, values: readonly string[]) =>
      expect(quoted(def[name]), name).toEqual([...values].sort())
    same('credit_uses_source_check', CREDIT_USE_SOURCES)
    same('credit_uses_status_check', CREDIT_USE_STATUSES)
    same('lease_prepaid_credits_funded_by_check', PREPAID_FUNDED_BY)
    same('bank_deposit_slips_status_check', DEPOSIT_SLIP_STATUSES)
    same('bank_deposit_slips_source_check', DEPOSIT_SLIP_SOURCES)
    same('platform_revenue_ledger_type_check', PLATFORM_REVENUE_TYPES)
    same('held_payout_items_source_type_check', HELD_PAYOUT_SOURCE_TYPES)
    same('tenant_credits_category_check', TENANT_CREDIT_ALL_CATEGORIES)
    same('payments_revenue_owner_check', REVENUE_OWNERS)
    for (const reason of CREDIT_USE_RELEASE_REASONS) expect(def.credit_uses_status_stamps).toContain(`'${reason}'`)
  })

  it('FlexPay: a month already paid has a $0 cover but never a $0 fee, and one pull row per advance', async () => {
    await withRollback(async c => {
      const f = await household(c)
      const advance = async (rent: number, fee: number) => (await c.query<{ id: string }>(
        `INSERT INTO flexpay_advances (cycle_month, tenant_id, landlord_id, unit_id, lease_id, rent_amount, tenant_fee_amount, pull_day, pull_date)
         VALUES ('2026-10-01',$1,$2,$3,$4,$5,$6,15,'2026-10-15') RETURNING id`,
        [f.tenantId, f.landlordId, f.unitId, f.leaseId, rent, fee])).rows[0].id
      const paidMonth = await advance(0, 25)
      await refused(c, `INSERT INTO flexpay_advances (cycle_month, tenant_id, landlord_id, unit_id, lease_id, rent_amount, tenant_fee_amount, pull_day)
                        VALUES ('2026-10-01',$1,$2,$3,$4,460,0,15)`, [f.tenantId, f.landlordId, f.unitId, f.leaseId], /flexpay_advances_amounts_check/)
      await refused(c, `UPDATE flexpay_advances SET pull_attempts = -1 WHERE id = $1`, [paidMonth], /flexpay_advances_pull_attempts_nonneg/)
      const pull = await charge(c, f, { type: 'fee', entry: 'FLEXPAY', owner: 'gam', amount: 25 })
      await c.query(`UPDATE payments SET flexpay_advance_id = $2 WHERE id = $1`, [pull, paidMonth])
      await refused(c, `UPDATE payments SET flexpay_advance_id = $2 WHERE id = $1`,
        [await charge(c, f, { type: 'fee', entry: 'FLEXPAY', owner: 'gam', amount: 25 }), paidMonth], /ux_payments_one_flexpay_pull_per_advance/)
      // Covered bill lines carry the advance too, any number of them.
      await c.query(`UPDATE payments SET flexpay_advance_id = $2 WHERE id IN ($1, $3)`, [await charge(c, f), paidMonth, await charge(c, f, { type: 'utility', entry: 'UTILITY' })])
      await c.query(`INSERT INTO platform_revenue_ledger (type, amount, balance_after) VALUES ('flexpay_subscription', 25, 25)`)
    })
  })

  it('the FlexPay terms quote the $4 retry fee and the 90-day wait the FlexPay service actually applies', () => {
    expect(FLEXPAY_RETURNED_PULL_FEE).toBe(FLEXPAY_ACH_RETURN_FEE)
    expect(FLEXPAY_REJOIN_WAIT_DAYS).toBe(FLEXPAY_NSF_COOLDOWN_DAYS)
  })

  it('autopay keeps saved credit unless the tenant turns on "use my credit first"', async () => {
    await withRollback(async c => {
      const f = await household(c)
      const r = await c.query(`INSERT INTO tenant_autopay (tenant_id, lease_id) VALUES ($1,$2) RETURNING use_credit`, [f.tenantId, f.leaseId])
      expect(r.rows[0].use_credit).toBe(false)
      const t = await c.query(`SELECT bank_pending_since, ach_suspended_at FROM tenants WHERE id = $1`, [f.tenantId])
      expect(t.rows[0]).toEqual({ bank_pending_since: null, ach_suspended_at: null })
    })
  })

  it('deposit slips: other money needs a note, staff slips need an author, a receipt sits in one live slip', async () => {
    await withRollback(async c => {
      const f = await household(c)
      const slip = (other: number, note: string | null, author: string | null) => c.query<{ id: string }>(
        `INSERT INTO bank_deposit_slips (landlord_id, property_id, deposit_date, total, other_amount, other_note, created_by)
         VALUES ($1,$2,'2026-10-02',500,$3,$4,$5) RETURNING id`, [f.landlordId, f.propertyId, other, note, author])
      await refused(c, `INSERT INTO bank_deposit_slips (landlord_id, deposit_date, total, other_amount, created_by) VALUES ($1,'2026-10-02',500,40,$2)`,
        [f.landlordId, f.userId], /bank_deposit_slips_other_needs_note/)
      await refused(c, `INSERT INTO bank_deposit_slips (landlord_id, deposit_date, total) VALUES ($1,'2026-10-02',500)`,
        [f.landlordId], /bank_deposit_slips_staff_has_author/)
      const one = (await slip(40, 'laundry quarters', f.userId)).rows[0].id
      const two = (await slip(0, null, f.userId)).rows[0].id
      const receipt = await remittance(c, f, 460)
      await c.query(`INSERT INTO bank_deposit_slip_items (slip_id, remittance_id, amount) VALUES ($1,$2,460)`, [one, receipt])
      await refused(c, `INSERT INTO bank_deposit_slip_items (slip_id, remittance_id, amount) VALUES ($1,$2,460)`, [two, receipt], /ux_slip_items_remittance_live/)
      await c.query(`UPDATE bank_deposit_slip_items SET voided_at = now() WHERE slip_id = $1`, [one])
      await c.query(`INSERT INTO bank_deposit_slip_items (slip_id, remittance_id, amount) VALUES ($1,$2,460)`, [two, receipt])
      await refused(c, `UPDATE bank_deposit_slips SET status = 'matched' WHERE id = $1`, [two], /bank_deposit_slips_matched_has_txn/)
    })
  })

  it('an undone bank-deposit match frees the charge for another deposit; auto-filing is stamped in pairs', async () => {
    await withRollback(async c => {
      const f = await household(c)
      const conn = (await c.query<{ id: string }>(`INSERT INTO bank_connections (landlord_id) VALUES ($1) RETURNING id`, [f.landlordId])).rows[0].id
      const txn = async (amount: number) => (await c.query<{ id: string }>(
        `INSERT INTO bank_transactions (bank_connection_id, landlord_id, external_id, posted_date, amount)
         VALUES ($1,$2,$3,'2026-10-02',$4) RETURNING id`, [conn, f.landlordId, randomUUID(), amount])).rows[0].id
      const first = await txn(460), second = await txn(460)
      const row = await charge(c, f, { status: 'settled', manualMethod: 'cash' })
      const alloc = `INSERT INTO bank_deposit_allocations (bank_transaction_id, payment_id, landlord_id, amount, effective_paid_date)
                     VALUES ($1,$2,$3,460,'2026-10-02')`
      await c.query(alloc, [first, row, f.landlordId])
      await refused(c, alloc, [second, row, f.landlordId], /ux_bank_deposit_allocations_payment_live/)
      await c.query(`UPDATE bank_deposit_allocations SET reversed_at = now(), reversed_by = $2 WHERE bank_transaction_id = $1`, [first, f.userId])
      await c.query(alloc, [second, row, f.landlordId])
      // The running code's ON CONFLICT target is still there.
      await c.query(`${alloc} ON CONFLICT (bank_transaction_id, payment_id) DO NOTHING`, [second, row, f.landlordId])

      const rule = (await c.query<{ id: string; auto_file_income: boolean }>(
        `INSERT INTO landlord_merchant_rules (landlord_id, normalized_merchant, category, scope_kind, last_direction)
         VALUES ($1,'SQUARE','other_income','property_common','in') RETURNING id, auto_file_income`, [f.landlordId])).rows[0]
      expect(rule.auto_file_income).toBe(true)
      await refused(c, `UPDATE bank_transactions SET auto_filed_rule_id = $2 WHERE id = $1`, [first, rule.id], /bank_transactions_auto_filed_pair/)
      await c.query(`UPDATE bank_transactions SET auto_filed_rule_id = $2, auto_filed_at = now() WHERE id = $1`, [first, rule.id])
      await refused(c, `UPDATE landlord_merchant_rules SET last_direction = 'sideways' WHERE id = $1`, [rule.id], /landlord_merchant_rules_last_direction_check/)
    })
  })

  it('a dispute keeps one record per row; one remittance per intent; one paid-ahead credit per remittance', async () => {
    await withRollback(async c => {
      const f = await household(c)
      const event = `evt_${randomUUID()}`
      await reversalOf(c, f, await charge(c, f, { status: 'returned' }), event)
      const second = await charge(c, f, { status: 'returned' })
      const sameEventSecondRow = `INSERT INTO payment_reversals (payment_id, reversal_type, reversed_amount, stripe_event_id, raw_event)
                                  VALUES ($1,'card_dispute',10,$2,'{}'::jsonb)`
      if (!c0Live) {
        // Until C0 the old one-per-event constraint still stands (old code's ON CONFLICT target).
        await refused(c, sameEventSecondRow, [second, event], /payment_reversals_stripe_event_id_key/)
      } else {
        // C0 dropped it: the same event reopens a second row, one record per (event, row).
        await c.query(sameEventSecondRow, [second, event])
        await refused(c, sameEventSecondRow, [second, event], /ux_payment_reversals_event_payment/)
      }
      await c.query(`INSERT INTO held_payout_items (landlord_id, source_type, source_id, amount) VALUES ($1,'deposit_settlement',$2,-35.50)`,
        [f.landlordId, randomUUID()])

      const rem = await remittance(c, f, 500, 'pi_once')
      await refused(c, `INSERT INTO tenant_remittances (tenant_id, landlord_id, amount, applied_amount, payment_method, stripe_payment_intent_id)
                        VALUES ($1,$2,500,500,'card','pi_once')`, [f.tenantId, f.landlordId], /ux_tenant_remittances_intent/)
      await paidAhead(c, f, 40, { fundedBy: 'gam', sourceRemittanceId: rem })
      await refused(c, `INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining, source_remittance_id)
                        VALUES ($1,$2,40,40,$3)`, [f.leaseId, f.tenantId, rem], /ux_lease_prepaid_credits_source_remittance/)
      // Desk receipts carry no intent, any number of them.
      await remittance(c, f, 20); await remittance(c, f, 20)
    })
  })

  it('landlord-issued credits are journaled like paid-ahead credits', async () => {
    await withRollback(async c => {
      const f = await household(c)
      const credit = await issued(c, f, 100)
      await use(c, { tenantCreditId: credit, paymentId: await charge(c, f), leaseId: f.leaseId, amount: 25 })
      const j = await c.query(`SELECT old_row->>'amount_remaining' AS was, new_row->>'amount_remaining' AS now
                                 FROM audit_row_changes WHERE table_name = 'tenant_credits' AND row_id = $1`, [credit])
      expect(j.rows).toEqual([{ was: '100.00', now: '75.00' }])
    })
  })
})

describe('S655 test cleanup knows the new tables', () => {
  it('cleanupAllSchema clears credit uses, deposit slips and FlexPay-covered lines', async () => {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const f = await household(c)
      const row = await charge(c, f)
      await use(c, { tenantCreditId: await issued(c, f, 100), paymentId: row, leaseId: f.leaseId, amount: 10 })
      const slip = (await c.query<{ id: string }>(
        `INSERT INTO bank_deposit_slips (landlord_id, deposit_date, total, created_by) VALUES ($1,'2026-10-02',460,$2) RETURNING id`,
        [f.landlordId, f.userId])).rows[0].id
      await c.query(`INSERT INTO bank_deposit_slip_items (slip_id, remittance_id, amount) VALUES ($1,$2,460)`, [slip, await remittance(c, f, 460)])
      const advance = (await c.query<{ id: string }>(
        `INSERT INTO flexpay_advances (cycle_month, tenant_id, landlord_id, unit_id, lease_id, rent_amount, tenant_fee_amount, pull_day)
         VALUES ('2026-10-01',$1,$2,$3,$4,460,25,15) RETURNING id`, [f.tenantId, f.landlordId, f.unitId, f.leaseId])).rows[0].id
      await c.query(`UPDATE payments SET flexpay_advance_id = $2 WHERE id = $1`, [await charge(c, f), advance])
      await c.query('COMMIT')
    } finally { c.release() }

    await cleanupAllSchema()
    const left = await db.query(
      `SELECT (SELECT count(*) FROM credit_uses)::int AS uses, (SELECT count(*) FROM bank_deposit_slips)::int AS slips,
              (SELECT count(*) FROM flexpay_advances)::int AS advances, (SELECT count(*) FROM tenant_credits)::int AS credits,
              (SELECT count(*) FROM payments)::int AS payments`)
    expect(left.rows[0]).toEqual({ uses: 0, slips: 0, advances: 0, credits: 0, payments: 0 })
  })

  // decisions #11: a tenant's reported bank deposit that the landlord's own
  // receipt covered is 'recorded' and RESTRICTs that receipt.
  it('cleanupAllSchema clears a recorded bank-deposit report before the receipt it points at', async () => {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const f = await household(c)
      const receipt = await remittance(c, f, 460)
      await c.query(
        `INSERT INTO tenant_declared_deposits (tenant_id, lease_id, landlord_id, amount, declared_date, method, status, recorded_remittance_id)
         VALUES ($1,$2,$3,460,'2026-10-02','cash','recorded',$4)`, [f.tenantId, f.leaseId, f.landlordId, receipt])
      await c.query('COMMIT')
    } finally { c.release() }

    await cleanupAllSchema()
    const left = await db.query(
      `SELECT (SELECT count(*) FROM tenant_declared_deposits)::int AS reports, (SELECT count(*) FROM tenant_remittances)::int AS receipts`)
    expect(left.rows[0]).toEqual({ reports: 0, receipts: 0 })
  })
})

// ─── contract step C0 ───────────────────────────────────────────────────────

describe('S655 contract step C0', () => {
  // 10/4: C0 moved from contract/ into migrations/.
  const C0 = fs.readFileSync(path.join(__dirname, 'migrations', '20261003109000_credit_ledger_guards.sql'), 'utf8')

  it('C0: a direct write to amount_remaining is refused; the ledger and the backfill pass', async () => {
    // DDL is transactional: applied and checked inside one transaction, then
    // rolled back, so no other suite ever sees the guards.
    await withRollback(async c => {
      await c.query(C0)
      await c.query(C0)          // idempotent
      const f = await household(c)
      const credit = await issued(c, f, 100)
      const money = await paidAhead(c, f, 100)
      await refused(c, `UPDATE tenant_credits SET amount_remaining = 0 WHERE id = $1`, [credit], /moves only through credit_uses/)
      await refused(c, `UPDATE lease_prepaid_credits SET amount_remaining = 0 WHERE id = $1`, [money], /moves only through credit_uses/)
      await refused(c, `INSERT INTO tenant_credits (landlord_id, tenant_id, amount_original, amount_remaining) VALUES ($1,$2,50,10)`,
        [f.landlordId, f.tenantId], /starts whole/)
      await refused(c, `INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining) VALUES ($1,$2,50,0)`,
        [f.leaseId, f.tenantId], /starts whole/)
      // The ledger moves it.
      await use(c, { tenantCreditId: credit, paymentId: await charge(c, f), leaseId: f.leaseId, amount: 30 })
      await use(c, { prepaidCreditId: money, paymentId: await charge(c, f), leaseId: f.leaseId, amount: 30 })
      expect(await remaining(c, 'tenant_credits', credit)).toBe(70)
      expect(await remaining(c, 'lease_prepaid_credits', money)).toBe(70)
      // Other columns are untouched by the guard: a void leaves the balance alone.
      await c.query(`UPDATE tenant_credits SET status = 'void', voided_at = now() WHERE id = $1`, [credit])
      // The deploy backfill may restore Russ Fuller's credit before voiding it.
      await c.query(`SET LOCAL gam.credit_backfill = 'on'`)
      await c.query(`UPDATE tenant_credits SET amount_remaining = 100 WHERE id = $1`, [credit])
      await c.query(`INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining) VALUES ($1,$2,37.60,0)`,
        [f.leaseId, f.tenantId])
      await c.query(`SET LOCAL gam.credit_backfill = 'off'`)
      // A withdrawn move-in box credit still comes back whole when its row is paid
      // again: restoring it never writes the balance.
      const fee = await seedLeaseFee(c, { leaseId: f.leaseId, feeType: 'last_month_rent', amount: 460, dueTiming: 'move_in' })
      await c.query(`UPDATE lease_fees SET money_kind = 'prepaid' WHERE id = $1`, [fee])
      const box = await charge(c, f, { type: 'fee', entry: 'OTHERFEE', owner: 'held', leaseFeeId: fee, status: 'settled', manualMethod: 'check' })
      await c.query(`UPDATE lease_prepaid_credits SET voided_at = now(), void_reason = 'bank deposit match undone' WHERE source_payment_id = $1`, [box])
      await c.query(`UPDATE payments SET status = 'pending', settled_at = NULL, manual_method = NULL WHERE id = $1`, [box])
      await c.query(`UPDATE payments SET status = 'settled', settled_at = now(), stripe_payment_intent_id = 'pi_c0_box',
                            stripe_charge_id = 'ch_c0_box', platform_held = true WHERE id = $1`, [box])
      const restored = await c.query(`SELECT funded_by, voided_at, amount_remaining::float AS left FROM lease_prepaid_credits WHERE source_payment_id = $1`, [box])
      expect(restored.rows).toEqual([{ funded_by: 'gam', voided_at: null, left: 460 }])
      // One reversal record per row now; the same row twice is still refused.
      const event = `evt_${randomUUID()}`
      await reversalOf(c, f, await charge(c, f, { status: 'returned' }), event)
      const second = await charge(c, f, { status: 'returned' })
      await reversalOf(c, f, second, event)
      await refused(c, `INSERT INTO payment_reversals (payment_id, reversal_type, reversed_amount, stripe_event_id, raw_event)
                        VALUES ($1,'card_dispute',10,$2,'{}'::jsonb)`, [second, event], /ux_payment_reversals_event_payment/)
    })
    // Rolled back: the database is as it was before this test — no guards for
    // every other suite on a plain run, both guards still there when the final
    // run applied C0 first (Step 16).
    const t = await db.query(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgname LIKE 'trg_%_remaining_by_ledger'`)
    expect(t.rows[0].n).toBe(c0Live ? 2 : 0)
    const old = await db.query(`SELECT 1 FROM pg_constraint WHERE conname = 'payment_reversals_stripe_event_id_key'`)
    expect(old.rowCount).toBe(c0Live ? 0 : 1)
  })
})

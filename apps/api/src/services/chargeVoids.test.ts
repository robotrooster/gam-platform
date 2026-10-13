/**
 * 10/12 (Nic) — keep everything: the places that DELETED a charge nobody owes
 * now VOID it (services/chargeVoids; design gam-ledger-design-2026-10-12 §P2).
 *
 * Proven here, for each path:
 *   - the row is KEPT — status 'voided', stamped with when and why, at its
 *     amount, on its lease and bill;
 *   - every figure reads exactly what it read when the row was deleted
 *     (test/voidedChargeTotals: Money billed and received, the household's
 *     quote, what is owed, each bill's status and total, the space's status,
 *     payment health — read with the voided rows kept, then with them deleted);
 *   - a row another record points at is never voided out from under it (the
 *     rows the database refused to delete): kept, or the change refused;
 *   - a voided row frees what the deleted one freed: the month's one rent slot,
 *     and the bill's status.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { PoolClient } from 'pg'
import { db, getClient } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant, seedLease, seedLeaseTenant, seedAllocationRule,
} from '../test/dbHelpers'

vi.mock('./email', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, sendNotificationEmail: vi.fn(async () => null) }
})

import { chargeHeldByRecordSql, voidUnowedCharges, voidUnowedChargesOrRefuse } from './chargeVoids'
import { voidedKeptVsDeleted } from '../test/voidedChargeTotals'
import { unwindIssuedLease, LEASE_VOIDED_CHARGE_REASON } from '../lib/unwindIssuedLease'
import { clearNeverOwedOnHeldNewLease, NEW_LEASE_NEVER_STARTS_CHARGE_REASON } from './renewalSuccessor'
import { syncLeaseWithBookingDates, STAY_SHORTENED_RENT_VOID_REASON } from './bookingLeaseBilling'
import { voidUnpaidReservationFee, RESERVATION_FEE_VOID_REASON } from './commonAreas'

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

async function bill(f: Fx, leaseId: string, due: string, o: { rent?: number; fees?: number; deposits?: number; utilities?: number } = {}): Promise<string> {
  const total = (o.rent ?? 0) + (o.fees ?? 0) + (o.deposits ?? 0) + (o.utilities ?? 0)
  return (await db.query<{ id: string }>(
    `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date,
                           subtotal_rent, subtotal_fees, subtotal_deposits, subtotal_utilities, total_amount)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [f.landlordId, f.tenantId, leaseId, f.unitId, `INV-${due}-${Math.random().toString(36).slice(2, 8)}`, due,
     o.rent ?? 0, o.fees ?? 0, o.deposits ?? 0, o.utilities ?? 0, total])).rows[0].id
}

const ENTRY: Record<string, string> = { rent: 'RENT', fee: 'OTHERFEE', deposit: 'DEPOSIT', utility: 'UTILITY', late_fee: 'LATEFEE' }

async function charge(f: Fx, o: {
  leaseId?: string | null; invoiceId?: string | null; type?: string; amount: number; status?: string; due?: string
  nextRetryAt?: string | null; suspended?: boolean
}): Promise<string> {
  const type = o.type ?? 'rent'
  return (await db.query<{ id: string }>(
    `INSERT INTO payments (unit_id, lease_id, invoice_id, tenant_id, landlord_id, type, amount, status, due_date,
                           entry_description, settled_at, next_retry_at, work_trade_suspended_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, CASE WHEN $8 = 'settled' THEN now() END, $11,
             CASE WHEN $12 THEN now() END) RETURNING id`,
    [f.unitId, o.leaseId === undefined ? f.leaseId : o.leaseId, o.invoiceId ?? null, f.tenantId, f.landlordId,
     type, o.amount.toFixed(2), o.status ?? 'pending', o.due ?? '2026-10-01', ENTRY[type] ?? 'RENT',
     o.nextRetryAt ?? null, o.suspended === true])).rows[0].id
}

/** A receipt applied to the charge — a record that refused its delete. */
async function receiptOn(f: Fx, paymentId: string, leaseId = f.leaseId): Promise<void> {
  const rem = (await db.query<{ id: string }>(
    `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, unapplied_amount,
                                     status, payment_method, stripe_payment_intent_id, processing_fee_amount)
     VALUES ($1,$2,$3,10,10,0,'processing','ach',NULL,0) RETURNING id`,
    [f.tenantId, leaseId, f.landlordId])).rows[0].id
  await db.query(`INSERT INTO remittance_applications (remittance_id, payment_id, amount_applied) VALUES ($1,$2,10)`, [rem, paymentId])
}

/** A financed home sale with installment 1 billed as a home payment on `leaseId`'s bill. */
async function homePaymentOnBill(f: Fx, leaseId: string, due: string): Promise<{ sale: string; inst: string; hp: string; inv: string }> {
  const sale = (await db.query<{ id: string }>(
    `INSERT INTO home_sale_contracts (unit_id, tenant_id, landlord_id, sale_price, down_payment, financed_amount,
       annual_interest_rate, term_months, monthly_payment, start_month, status, installments_total)
     VALUES ($1,$2,$3,11000,0,11000,0,55,200,$4,'active',55) RETURNING id`,
    [f.unitId, f.tenantId, f.landlordId, due])).rows[0].id
  const inst = (await db.query<{ id: string }>(
    `INSERT INTO home_sale_installments (contract_id, installment_number, billing_month, amount, principal_portion, interest_portion, remaining_balance)
     VALUES ($1,1,$2,200,200,0,10800) RETURNING id`, [sale, due])).rows[0].id
  const inv = await bill(f, leaseId, due, { rent: 0 })
  const hp = (await db.query<{ id: string }>(
    `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, home_sale_installment_id)
     VALUES ($1,$2,$3,$4,$5,'home_payment',200,'pending',$6,'HOMEPMT',$7) RETURNING id`,
    [inv, f.unitId, leaseId, f.tenantId, f.landlordId, due, inst])).rows[0].id
  await db.query(`UPDATE home_sale_installments SET payment_id = $1 WHERE id = $2`, [hp, inst])
  return { sale, inst, hp, inv }
}

/**
 * The installment is unbilled again and its slot on payments is free: a bill
 * run (ON CONFLICT on home_sale_installment_id, as invoiceGeneration and
 * homeSale insert) bills it once more, and the sale goes on.
 */
async function expectInstallmentBillsAgain(f: Fx, sale: string, inst: string, voidedId: string): Promise<void> {
  expect((await db.query(`SELECT payment_id FROM home_sale_installments WHERE id = $1`, [inst])).rows[0].payment_id).toBeNull()
  expect((await db.query(`SELECT home_sale_installment_id FROM payments WHERE id = $1`, [voidedId])).rows[0].home_sale_installment_id).toBeNull()
  // The journal still says which installment the voided row billed.
  const was = (await db.query<{ v: string }>(
    `SELECT old_row->>'home_sale_installment_id' AS v FROM audit_row_changes
      WHERE table_name = 'payments' AND row_id = $1 AND old_row->>'home_sale_installment_id' IS NOT NULL
      ORDER BY id DESC LIMIT 1`, [voidedId])).rows[0]
  expect(was?.v).toBe(inst)
  expect((await db.query(`SELECT status FROM home_sale_contracts WHERE id = $1`, [sale])).rows[0].status).toBe('active')
  const re = await db.query(
    `INSERT INTO payments (unit_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, home_sale_installment_id)
     VALUES ($1,$2,$3,'home_payment',200,'pending','2026-12-01','HOMEPMT',$4)
     ON CONFLICT (home_sale_installment_id) WHERE home_sale_installment_id IS NOT NULL DO NOTHING RETURNING id`,
    [f.unitId, f.tenantId, f.landlordId, inst])
  expect(re.rowCount).toBe(1)
}

const row = async (id: string) => (await db.query<any>(
  `SELECT status, amount::float AS amount, void_reason, voided_at IS NOT NULL AS stamped, invoice_id, lease_id,
          next_retry_at, work_trade_suspended_at
     FROM payments WHERE id = $1`, [id])).rows[0]
const q = (c: PoolClient) => c.query.bind(c) as any

beforeEach(async () => { await cleanupAllSchema() })

describe('chargeHeldByRecordSql — the rows a delete was refused on', () => {
  it('names every foreign key into payments with no ON DELETE action (a new one fails here until it is added)', async () => {
    const fks = (await db.query<{ tbl: string; col: string }>(
      `SELECT regexp_replace(c.conrelid::regclass::text, '^public\\.', '') AS tbl, a.attname AS col
         FROM pg_constraint c
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
        WHERE c.contype = 'f' AND c.confrelid = 'public.payments'::regclass AND c.confdeltype IN ('a', 'r')
        ORDER BY 1, 2`)).rows
    expect(fks.length).toBeGreaterThan(15)
    const sql = chargeHeldByRecordSql('p').replace(/\s+/g, ' ')
    for (const fk of fks) {
      expect(sql, `${fk.tbl}.${fk.col}`).toMatch(new RegExp(`FROM ${fk.tbl} x WHERE[^)]*x\\.${fk.col} = p\\.id`))
    }
    // …and live account credit (trg_payments_keep_rows_with_live_credit).
    expect(sql).toContain(`FROM credit_uses x WHERE x.payment_id = p.id AND x.status <> 'released'`)
  })

  it('every OTHER foreign key into payments is named with what a void does about it (10/12 review: a new one fails here until someone decides)', async () => {
    // A delete fired each of these (SET NULL / CASCADE / SET DEFAULT) and each
    // had a side effect a void does not get for free — the home-installment
    // release was lost that way. The header of services/chargeVoids says what
    // each path does; this list must match the live schema exactly.
    const ACCOUNTED: Record<string, string> = {
      'home_sale_installments.payment_id': 'released by voidUnowedCharges (installment unbilled, slot given up)',
      'utility_bills.payment_id': 'unlinked by the paths that void utility lines (unwindIssuedLease, renewalSuccessor)',
      'common_area_reservations.fee_payment_id': 'kept on purpose: the reservation names its voided fee, marked fee_voided',
      'credit_uses.payment_id': 'only a released use can be on a voided charge; left as it is',
      'connect_disputes.payment_id': 'a dispute is on a paid charge, never one still owed',
    }
    const fks = (await db.query<{ k: string }>(
      `SELECT regexp_replace(c.conrelid::regclass::text, '^public\\.', '') || '.' || a.attname AS k
         FROM pg_constraint c
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
        WHERE c.contype = 'f' AND c.confrelid = 'public.payments'::regclass AND c.confdeltype NOT IN ('a', 'r')
        ORDER BY 1`)).rows.map(r => r.k)
    expect(fks).toEqual(Object.keys(ACCOUNTED).sort())
  })
})

describe('voidUnowedCharges', () => {
  it('voids only what is still owed and nothing points at, keeps the amount, stamps why, clears the retry and the work-trade park', async () => {
    const f = await fixture()
    const pending = await charge(f, { amount: 460, nextRetryAt: '2026-10-09T00:00:00Z' })
    const failed = await charge(f, { type: 'fee', amount: 25, status: 'failed', suspended: true })
    const settled = await charge(f, { type: 'fee', amount: 30, status: 'settled' })
    const receipted = await charge(f, { type: 'utility', amount: 40 })
    await receiptOn(f, receipted)

    const out = await tx(c => voidUnowedCharges(q(c), [pending, failed, settled, receipted, pending], 'Test: not owed'))
    expect(out.voided.map(v => v.id).sort()).toEqual([pending, failed].sort())
    expect(out.held).toEqual([receipted])

    for (const [id, amount] of [[pending, 460], [failed, 25]] as const) {
      expect(await row(id)).toMatchObject({
        status: 'voided', amount, void_reason: 'Test: not owed', stamped: true, lease_id: f.leaseId,
        next_retry_at: null, work_trade_suspended_at: null,
      })
    }
    expect(await row(settled)).toMatchObject({ status: 'settled', void_reason: null })
    expect(await row(receipted)).toMatchObject({ status: 'pending', void_reason: null })
    // A voided row is a record: it never changes again (trg_payments_voided_is_a_record).
    await expect(db.query(`UPDATE payments SET status = 'pending', voided_at = NULL, void_reason = NULL WHERE id = $1`, [pending]))
      .rejects.toThrow(/was voided: it is a record/)
  })

  it('the refusing form refuses in plain words before voiding anything when a record points at one of them', async () => {
    const f = await fixture()
    const free = await charge(f, { amount: 460 })
    const receipted = await charge(f, { type: 'utility', amount: 40 })
    await receiptOn(f, receipted)
    await expect(tx(c => voidUnowedChargesOrRefuse(q(c), [free, receipted], 'Test: not owed', 'Refused in plain words.')))
      .rejects.toMatchObject({ statusCode: 409, message: 'Refused in plain words.' })
    expect((await row(free)).status).toBe('pending')
    await expect(tx(c => voidUnowedCharges(q(c), [free], ' '))).rejects.toThrow(/needs its reason/)
  })
})

describe('a voided row frees what a deleted one freed', () => {
  it('the month\'s one rent slot: a new rent row for the same space and date can be billed', async () => {
    const f = await fixture()
    const first = await charge(f, { amount: 460 })
    // While it is owed, a second live rent row for the space and date is refused.
    await expect(charge(f, { amount: 460, leaseId: null })).rejects.toThrow(/ux_payments_unit_rent_due_date_active/)
    await tx(c => voidUnowedCharges(q(c), [first], 'Test: not owed'))
    const second = await charge(f, { amount: 480, leaseId: null })
    expect((await row(second)).status).toBe('pending')
  })

  it('the bill\'s status: a bill whose lines are paid and voided reads settled', async () => {
    const f = await fixture()
    const inv = await bill(f, f.leaseId, '2026-10-01', { rent: 460, fees: 25 })
    await charge(f, { amount: 460, status: 'settled', invoiceId: inv })
    const fee = await charge(f, { type: 'fee', amount: 25, invoiceId: inv })
    await db.query(`SELECT fn_invoice_status_rollup_single($1::uuid)`, [inv])
    expect((await db.query(`SELECT status FROM invoices WHERE id = $1`, [inv])).rows[0].status).toBe('partial')
    await tx(c => voidUnowedCharges(q(c), [fee], 'Test: not owed'))
    expect((await db.query(`SELECT status FROM invoices WHERE id = $1`, [inv])).rows[0].status).toBe('settled')
  })
})

describe('each path voids instead of deleting, and every figure reads as it did', () => {
  it('a lease voided before the tenant signed', async () => {
    const f = await fixture()
    const inv = await bill(f, f.leaseId, '2026-10-01', { rent: 460, fees: 25 })
    const rent = await charge(f, { amount: 460, invoiceId: inv })
    const fee = await charge(f, { type: 'fee', amount: 25, invoiceId: inv })
    const out = await tx(c => unwindIssuedLease(q(c),
      { id: '00000000-0000-0000-0000-0000000000a1', lease_id: f.leaseId, issued_at: new Date(), unit_id: f.unitId }))
    expect(out.unwound).toBe(true)
    for (const [id, amount] of [[rent, 460], [fee, 25]] as const) {
      expect(await row(id)).toMatchObject({ status: 'voided', amount, void_reason: LEASE_VOIDED_CHARGE_REASON, invoice_id: inv })
    }
    expect((await db.query(`SELECT status FROM invoices WHERE id = $1`, [inv])).rows[0].status).toBe('void')
    const r = await voidedKeptVsDeleted(f.landlordId, f.tenantId)
    expect(r.voidedRows).toBe(2)
    expect(r.kept).toEqual(r.deleted)
  })

  it('a home payment on a lease voided before signing lets go of its installment, which bills again (10/12 review)', async () => {
    const f = await fixture()
    const { sale, inst, hp, inv } = await homePaymentOnBill(f, f.leaseId, '2026-10-01')
    await tx(c => unwindIssuedLease(q(c),
      { id: '00000000-0000-0000-0000-0000000000a3', lease_id: f.leaseId, issued_at: new Date(), unit_id: f.unitId }))
    expect(await row(hp)).toMatchObject({ status: 'voided', void_reason: LEASE_VOIDED_CHARGE_REASON, invoice_id: inv })
    await expectInstallmentBillsAgain(f, sale, inst, hp)
  })

  it('a lease voided before the tenant signed is refused when a record points at a charge on its bill', async () => {
    const f = await fixture()
    const inv = await bill(f, f.leaseId, '2026-10-01', { rent: 460 })
    const rent = await charge(f, { amount: 460, invoiceId: inv })
    // A record the void's own checks do not ask about: an early-termination
    // request names it as its fee. Its delete used to fail and take the whole
    // void down; now the void is refused in plain words, and nothing changes.
    await db.query(
      `INSERT INTO lease_termination_requests (lease_id, tenant_id, landlord_id, requested_by_user_id, fee_amount, fee_basis, fee_payment_id)
       VALUES ($1, $2, $3, $4, 460, 'no_policy', $5)`, [f.leaseId, f.tenantId, f.landlordId, f.userId, rent])
    await expect(tx(c => unwindIssuedLease(q(c),
      { id: '00000000-0000-0000-0000-0000000000a2', lease_id: f.leaseId, issued_at: new Date(), unit_id: f.unitId })))
      .rejects.toMatchObject({ statusCode: 409 })
    expect((await row(rent)).status).toBe('pending')
    expect((await db.query(`SELECT status FROM leases WHERE id = $1`, [f.leaseId])).rows[0].status).toBe('active')
  })

  it('a new lease that will never start: what it billed is voided, a charge a record points at is kept', async () => {
    const f = await fixture({ start: '2025-10-01' })
    const newLeaseId = await tx(async c => {
      const id = (await c.query<{ id: string }>(
        `INSERT INTO leases (unit_id, landlord_id, rent_amount, lease_type, status, start_date, supersedes_lease_id, lease_source)
         VALUES ($1,$2,480,'month_to_month','pending','2026-11-01',$3,'esigned') RETURNING id`,
        [f.unitId, f.landlordId, f.leaseId])).rows[0].id
      await seedLeaseTenant(c, { leaseId: id, tenantId: f.tenantId, role: 'primary' })
      return id
    })
    // Its first bill: a deposit top-up already paid, rent and a fee never owed.
    const inv = await bill(f, newLeaseId, '2026-11-01', { rent: 480, fees: 25, deposits: 50 })
    const paid = await charge(f, { leaseId: newLeaseId, invoiceId: inv, type: 'deposit', amount: 50, status: 'settled', due: '2026-11-01' })
    const rent = await charge(f, { leaseId: newLeaseId, invoiceId: inv, amount: 480, due: '2026-11-01' })
    const fee = await charge(f, { leaseId: newLeaseId, invoiceId: inv, type: 'fee', amount: 25, due: '2026-11-01' })
    // A charge with a receipt applied to it: the delete was refused, so it is kept for GAM.
    const receipted = await charge(f, { leaseId: newLeaseId, type: 'utility', amount: 40, due: '2026-11-01' })
    await receiptOn(f, receipted, newLeaseId)

    const out = await tx(c => clearNeverOwedOnHeldNewLease(q(c), newLeaseId, f.leaseId))
    expect(out).toMatchObject({ charges: 2, bills: 0, retotaled: 1, kept: 1 })
    expect(out.keptCharges.map(k => k.paymentId)).toEqual([receipted])
    for (const [id, amount] of [[rent, 480], [fee, 25]] as const) {
      expect(await row(id)).toMatchObject({ status: 'voided', amount, void_reason: NEW_LEASE_NEVER_STARTS_CHARGE_REASON, invoice_id: inv })
    }
    expect(await row(paid)).toMatchObject({ status: 'settled', amount: 50 })
    expect(await row(receipted)).toMatchObject({ status: 'pending' })
    // The bill is what is left on it: the $50 paid — and it reads settled, the
    // voided lines left out of its status as the deleted ones were.
    expect((await db.query<any>(`SELECT status, total_amount::float AS total, subtotal_deposits::float AS deposits FROM invoices WHERE id = $1`, [inv])).rows[0])
      .toEqual({ status: 'settled', total: 50, deposits: 50 })
    // Run again: nothing new.
    expect(await tx(c => clearNeverOwedOnHeldNewLease(q(c), newLeaseId, f.leaseId))).toMatchObject({ charges: 0, retotaled: 0, kept: 1 })
    const r = await voidedKeptVsDeleted(f.landlordId, f.tenantId)
    expect(r.voidedRows).toBe(2)
    expect(r.kept).toEqual(r.deleted)
  })

  it('a home payment on a new lease that never starts lets go of its installment, which bills again (10/12 review)', async () => {
    const f = await fixture({ start: '2025-10-01' })
    const newLeaseId = await tx(async c => {
      const id = (await c.query<{ id: string }>(
        `INSERT INTO leases (unit_id, landlord_id, rent_amount, lease_type, status, start_date, supersedes_lease_id, lease_source)
         VALUES ($1,$2,480,'month_to_month','pending','2026-11-01',$3,'esigned') RETURNING id`,
        [f.unitId, f.landlordId, f.leaseId])).rows[0].id
      await seedLeaseTenant(c, { leaseId: id, tenantId: f.tenantId, role: 'primary' })
      return id
    })
    const { sale, inst, hp } = await homePaymentOnBill(f, newLeaseId, '2026-11-01')
    const out = await tx(c => clearNeverOwedOnHeldNewLease(q(c), newLeaseId, f.leaseId))
    expect(out).toMatchObject({ charges: 1, kept: 0 })
    expect(await row(hp)).toMatchObject({ status: 'voided', void_reason: NEW_LEASE_NEVER_STARTS_CHARGE_REASON })
    await expectInstallmentBillsAgain(f, sale, inst, hp)
  })

  it('rent past a shortened stay\'s new end', async () => {
    const f = await fixture({ rent: 950, start: '2026-08-10' })
    const booking = (await db.query<{ id: string }>(
      `INSERT INTO unit_bookings (unit_id, landlord_id, lease_type, check_in, check_out, nights, guest_name, guest_email, status, source)
       VALUES ($1,$2,'month_to_month','2026-08-10','2027-01-28',171,'Sched Guest','sched-guest@test.dev','confirmed','public') RETURNING id`,
      [f.unitId, f.landlordId])).rows[0].id
    await db.query(
      `UPDATE leases SET lease_source='booking_draft', source_booking_id=$2, end_date='2027-01-28', needs_review=false WHERE id=$1`,
      [f.leaseId, booking])
    await charge(f, { amount: 674.19, status: 'settled', due: '2026-08-10' })
    await charge(f, { amount: 950, status: 'settled', due: '2026-09-01' })
    // October's bill carries water beside the rent; November's only rent.
    const octInv = await bill(f, f.leaseId, '2026-10-01', { rent: 950, utilities: 40 })
    const oct = await charge(f, { amount: 950, invoiceId: octInv, due: '2026-10-01' })
    await charge(f, { type: 'utility', amount: 40, invoiceId: octInv, due: '2026-10-01' })
    const novInv = await bill(f, f.leaseId, '2026-11-01', { rent: 950 })
    const nov = await charge(f, { amount: 950, invoiceId: novInv, due: '2026-11-01' })

    // The guest now leaves October 1: October and November are not owed.
    await db.query(`UPDATE unit_bookings SET check_out = '2026-10-01', nights = 52 WHERE id = $1`, [booking])
    await syncLeaseWithBookingDates(booking)

    expect(await row(oct)).toMatchObject({ status: 'voided', amount: 950, void_reason: STAY_SHORTENED_RENT_VOID_REASON, invoice_id: octInv })
    // November's bill had nothing else on it. 10/12 (Nic, G7): the empty bill is
    // VOIDED, not deleted — it keeps its voided rent line, and it lets go of the
    // lease (voided_from_lease_id) so the month can be billed again if the stay
    // grows back.
    expect(await row(nov)).toMatchObject({ status: 'voided', amount: 950, void_reason: STAY_SHORTENED_RENT_VOID_REASON, invoice_id: novInv })
    expect((await db.query<any>(
      `SELECT status, total_amount::float AS total, lease_id, voided_from_lease_id FROM invoices WHERE id = $1`, [novInv])).rows[0])
      .toEqual({ status: 'void', total: 0, lease_id: null, voided_from_lease_id: f.leaseId })
    expect((await db.query<any>(`SELECT status, subtotal_rent::float AS rent, total_amount::float AS total FROM invoices WHERE id = $1`, [octInv])).rows[0])
      .toEqual({ status: 'pending', rent: 0, total: 40 })
    const r = await voidedKeptVsDeleted(f.landlordId, f.tenantId)
    expect(r.voidedRows).toBe(2)
    expect(r.kept).toEqual(r.deleted)
  })

  it('a reservation\'s fee nothing was tried on, when the reservation goes away', async () => {
    const f = await fixture()
    const fee = await charge(f, { type: 'fee', amount: 50 })
    const area = (await db.query<{ id: string }>(
      `INSERT INTO common_areas (property_id, landlord_id, name, events_enabled, event_deposit_amount, event_auto_release)
       VALUES ($1,$2,'Clubhouse',TRUE,50,TRUE) RETURNING id`, [f.propertyId, f.landlordId])).rows[0].id
    const reservation = (await db.query<{ id: string }>(
      `INSERT INTO common_area_reservations
         (common_area_id, property_id, landlord_id, reserved_by_tenant_id, created_by_user_id, kind, starts_at, ends_at, status, fee_amount, fee_payment_id)
       VALUES ($1,$2,$3,$4,(SELECT user_id FROM tenants WHERE id = $4),'event', now() + interval '3 days', now() + interval '3 days 3 hours','approved',50,$5)
       RETURNING id`, [area, f.propertyId, f.landlordId, f.tenantId, fee])).rows[0].id

    const outcome = await tx(c => voidUnpaidReservationFee(c,
      { id: reservation, fee_payment_id: fee, reserved_by_tenant_id: f.tenantId, landlord_id: f.landlordId }))
    expect(outcome).toBe('voided')
    expect(await row(fee)).toMatchObject({ status: 'voided', amount: 50, void_reason: RESERVATION_FEE_VOID_REASON })
    // The reservation still names its fee, marked voided — as a fee a payment was tried on always was.
    expect((await db.query<any>(`SELECT fee_payment_id, fee_voided FROM common_area_reservations WHERE id = $1`, [reservation])).rows[0])
      .toEqual({ fee_payment_id: fee, fee_voided: true })
    const r = await voidedKeptVsDeleted(f.landlordId, f.tenantId)
    expect(r.voidedRows).toBe(1)
    expect(r.kept).toEqual(r.deleted)
  })
})

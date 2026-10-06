/**
 * 10/6 (Nic) — the data check for late fees ZEROED between 10/5 and the
 * credit rule ("they get a credit against their bill and the late payment
 * still shows on their payment history"). Each such fee is built here exactly
 * as the old code left it (amount $0, its "Reversed: rent was paid …" note,
 * the rent marked from the deposit's day), then: a dry run changes nothing;
 * --apply puts the fee back as charged with a late-fee credit against it,
 * rewrites a bank match's undo record so Undo still works, and supersedes the
 * rent's mark with a LATE one from the day it was recorded; a second run finds
 * nothing. A fee the landlord deleted is not there to find.
 */
import { randomUUID } from 'crypto'
import { describe, it, expect, beforeEach } from 'vitest'
import type { PoolClient } from 'pg'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedLease, seedTenant, seedLeaseTenant } from '../test/dbHelpers'
import { emitPaymentSettledEvent } from '../services/creditLedgerEmitters'
import { undoDepositMatch } from '../services/bankDepositConfirm'
import { fixReversedLateFees } from './oct6_fix_reversed_late_fees'

const TZ = 'America/Phoenix'

beforeEach(cleanupAllSchema)

async function tx<T>(fn: (c: PoolClient) => Promise<T>, commit: boolean): Promise<T> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const r = await fn(c)
    await c.query(commit ? 'COMMIT' : 'ROLLBACK')
    return r
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e } finally { c.release() }
}

/**
 * A $600 rent due ten days ago, paid by a bank deposit made that day and
 * recorded yesterday, whose $25 late fee (charged five days after the due
 * date) the old code zeroed — the rent marked as the old code marked it.
 */
async function zeroedTheOldWay(o: { onboarding: boolean }) {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const ll = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
    await c.query(`UPDATE properties SET timezone = $2 WHERE id = $1`, [propertyId, TZ])
    const unitId = await seedUnit(c, { propertyId, landlordId: ll.landlordId, rentAmount: 600 })
    const leaseId = await seedLease(c, { unitId, landlordId: ll.landlordId, rentAmount: 600 })
    await c.query(`UPDATE leases SET is_existing_tenancy = $2, late_fee_grace_days = 3 WHERE id = $1`, [leaseId, o.onboarding])
    const tenantId = await seedTenant(c)
    await seedLeaseTenant(c, { leaseId, tenantId, role: 'primary' })
    const invoiceId = (await c.query<{ id: string }>(
      `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date, subtotal_rent, total_amount, status)
       VALUES ($1,$2,$3,$4,$5,(NOW() AT TIME ZONE $6)::date - 10, 600, 600, 'pending') RETURNING id`,
      [ll.landlordId, tenantId, leaseId, unitId, `INV-${randomUUID().slice(0, 8)}`, TZ])).rows[0].id
    const rentId = (await c.query<{ id: string }>(
      `INSERT INTO payments (landlord_id, tenant_id, unit_id, lease_id, type, amount, status, entry_description, due_date, invoice_id, created_at)
       VALUES ($1,$2,$3,$4,'rent',600,'pending','RENT',(NOW() AT TIME ZONE $5)::date - 10,$6, NOW() - interval '10 days') RETURNING id`,
      [ll.landlordId, tenantId, unitId, leaseId, TZ, invoiceId])).rows[0].id
    const dueDay = (await c.query<{ d: string }>(`SELECT due_date::text AS d FROM payments WHERE id = $1`, [rentId])).rows[0].d
    const feeId = (await c.query<{ id: string }>(
      `INSERT INTO payments (landlord_id, tenant_id, unit_id, lease_id, invoice_id, type, amount, status, due_date, entry_description, created_at)
       VALUES ($1,$2,$3,$4,$5,'late_fee',25,'pending',$6::date + 5,'LATEFEE', NOW() - interval '5 days') RETURNING id`,
      [ll.landlordId, tenantId, unitId, leaseId, invoiceId, dueDay])).rows[0].id
    await c.query('COMMIT')
    // Yesterday the landlord recorded the deposit; the old code zeroed the fee …
    await db.query(
      `UPDATE payments SET amount = 0, status = 'settled', settled_at = NOW() - interval '1 day',
              notes = COALESCE(notes || ' — ', '') || 'Reversed: rent was paid ' || $2 || ', before this fee accrued'
        WHERE id = $1`, [feeId, dueDay])
    await db.query(`UPDATE audit_row_changes SET changed_at = NOW() - interval '1 day' WHERE row_id = $1`, [feeId])
    // … and settled the rent on the deposit's day, marking it from that day (on time).
    const settledAt = new Date(`${dueDay}T19:00:00Z`)
    await db.query(`UPDATE payments SET status = 'settled', settled_at = $2, manual_method = 'bank_deposit' WHERE id = $1`, [rentId, settledAt])
    if (!o.onboarding) {
      await tx(cl => emitPaymentSettledEvent(cl, {
        tenantId, paymentId: rentId, paymentType: 'rent', amount: '600', dueDate: dueDay, settledAt, graceDays: 3,
        stripePaymentIntentId: null, propertyTz: TZ, attestationSource: 'landlord_self_reported_with_evidence',
      }), true)
    }
    return { landlordId: ll.landlordId, ownerUserId: ll.userId, tenantId, leaseId, unitId, invoiceId, rentId, feeId, dueDay }
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e } finally { c.release() }
}

const fee = async (id: string) => (await db.query<any>(
  `SELECT amount::float AS amount, status, issued_credit_amount::float AS credited, notes FROM payments WHERE id = $1`, [id])).rows[0] ?? null
const liveMarks = async (id: string) => (await db.query<any>(
  `SELECT id, event_type, event_data FROM credit_events
    WHERE event_type LIKE 'payment_received_%' AND event_data->>'payment_id' = $1 AND superseded_by IS NULL`, [id])).rows

describe('oct6_fix_reversed_late_fees', () => {
  it('a dry run changes nothing; --apply restores the fee, credits it, and marks the rent LATE from the day it was recorded; a second run finds nothing', async () => {
    const z = await zeroedTheOldWay({ onboarding: false })
    const onTime = await liveMarks(z.rentId)
    expect(onTime.map(m => m.event_type)).toEqual(['payment_received_on_time'])

    const dry = await tx(c => fixReversedLateFees(c), false)
    expect(dry.fixed).toHaveLength(1)
    expect(await fee(z.feeId)).toMatchObject({ amount: 0, status: 'settled', credited: 0 })
    expect((await db.query(`SELECT 1 FROM tenant_credits WHERE tenant_id = $1`, [z.tenantId])).rowCount).toBe(0)
    expect((await liveMarks(z.rentId)).map(m => m.id)).toEqual([onTime[0].id])

    const r = await tx(c => fixReversedLateFees(c), true)
    expect(r.skipped).toEqual([])
    expect(r.fixed).toHaveLength(1)
    expect(r.fixed[0]).toMatchObject({ paymentId: z.feeId, amount: 25, paidOn: z.dueDay })
    expect(r.fixed[0].marks).toEqual([expect.objectContaining({ paymentId: z.rentId, action: 'corrected', was: 'payment_received_on_time' })])
    const f = await fee(z.feeId)
    expect(f).toMatchObject({ amount: 25, status: 'settled', credited: 25 })
    expect(f.notes).toContain(`Late fee credited: rent was paid ${z.dueDay}`)
    expect((await db.query<any>(
      `SELECT tc.category, tc.status, u.source, u.status AS use_status FROM tenant_credits tc
         JOIN credit_uses u ON u.tenant_credit_id = tc.id WHERE u.payment_id = $1`, [z.feeId])).rows)
      .toEqual([{ category: 'late_fee_refund', status: 'active', source: 'late_fee_credit', use_status: 'applied' }])
    expect((await db.query<any>(`SELECT status FROM invoices WHERE id = $1`, [z.invoiceId])).rows[0].status).toBe('settled')
    // The on-time mark is superseded (never edited) by a late one from yesterday.
    const now = await liveMarks(z.rentId)
    expect(now).toHaveLength(1)
    expect(now[0].event_type).toMatch(/^payment_received_late_(minor|major|severe)$/)
    expect(now[0].event_data).toMatchObject({ late_fee_on_bill: true, corrects_event_id: onTime[0].id })
    const yesterday = (await db.query<{ d: string }>(`SELECT ((NOW() - interval '1 day') AT TIME ZONE $1)::date::text AS d`, [TZ])).rows[0].d
    expect((await db.query<{ d: string }>(`SELECT (($1::timestamptz) AT TIME ZONE $2)::date::text AS d`, [now[0].event_data.paid_at, TZ])).rows[0].d)
      .toBe(yesterday)
    expect((await db.query<any>(`SELECT superseded_reason FROM credit_events WHERE id = $1`, [onTime[0].id])).rows[0].superseded_reason)
      .toBe('data_entry_error_corrected')

    const again = await tx(c => fixReversedLateFees(c), true)
    expect(again).toEqual({ fixed: [], skipped: [], subjects: [] })
  })

  it('the onboarding bill (no mark written then): credited, and a LATE mark written; a deleted onboarding fee is not there to find', async () => {
    const z = await zeroedTheOldWay({ onboarding: true })
    expect(await liveMarks(z.rentId)).toEqual([])
    const gone = await zeroedTheOldWay({ onboarding: true })
    await db.query(`DELETE FROM payments WHERE id = $1`, [gone.feeId])

    const r = await tx(c => fixReversedLateFees(c), true)
    expect(r.fixed.map(x => x.paymentId)).toEqual([z.feeId])
    expect(r.fixed[0].marks).toEqual([expect.objectContaining({ action: 'written', was: null })])
    expect(await fee(z.feeId)).toMatchObject({ amount: 25, credited: 25 })
    expect((await liveMarks(z.rentId))[0].event_type).toMatch(/^payment_received_late_/)
    expect(await fee(gone.feeId)).toBeNull()
  })

  it('a bank match\'s undo record lists the fee as credited afterwards, so Undo takes the credit back exactly', async () => {
    const z = await zeroedTheOldWay({ onboarding: false })
    const rem = (await db.query<{ id: string }>(
      `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, unapplied_amount, status, payment_method, processing_fee_amount)
       VALUES ($1,$2,$3,600,600,0,'settled','bank_deposit',0) RETURNING id`, [z.tenantId, z.leaseId, z.landlordId])).rows[0].id
    await db.query(`INSERT INTO remittance_applications (remittance_id, payment_id, amount_applied) VALUES ($1,$2,600)`, [rem, z.rentId])
    const conn = (await db.query<{ id: string }>(
      `INSERT INTO bank_connections (landlord_id, provider, status) VALUES ($1,'stripe_fc','active') RETURNING id`, [z.landlordId])).rows[0].id
    const undoRecord = {
      version: 1,
      rows: [{ paymentId: z.rentId, priorStatus: 'pending', priorNextRetryAt: null, priorIntentId: null, money: 600 }],
      lateFeesZeroed: [{ paymentId: z.feeId, priorAmount: 25, priorStatus: 'pending', priorNotes: null }],
      lateFeeRefundCreditIds: [], paidAheadCreditId: null, receiptId: rem, declarationId: null, creditEventIds: [], confirmedBy: null,
    }
    const txn = (await db.query<{ id: string }>(
      `INSERT INTO bank_transactions (bank_connection_id, landlord_id, external_id, posted_date, amount, description, status,
                                      matched_payment_id, auto_settle_undo)
       VALUES ($1,$2,$3,$4::date,600,'BRANCH DEPOSIT','matched',$5,$6::jsonb) RETURNING id`,
      [conn, z.landlordId, randomUUID(), z.dueDay, z.rentId, JSON.stringify(undoRecord)])).rows[0].id

    const r = await tx(c => fixReversedLateFees(c), true)
    expect(r.fixed[0].undoRecordUpdated).toBe(txn)
    const after = (await db.query<any>(`SELECT auto_settle_undo FROM bank_transactions WHERE id = $1`, [txn])).rows[0].auto_settle_undo
    expect(after.lateFeesZeroed).toEqual([])
    expect(after.lateFeesCredited).toEqual([expect.objectContaining({ paymentId: z.feeId, amount: 25, priorStatus: 'pending' })])

    const u = await undoDepositMatch({ bankTransactionId: txn, landlordId: z.landlordId, undoneBy: z.ownerUserId })
    expect(u.lateFeesRestored).toBe(1)
    expect(await fee(z.feeId)).toMatchObject({ amount: 25, status: 'pending', credited: 0 })
    expect((await db.query<any>(`SELECT status FROM tenant_credits WHERE id = $1`, [after.lateFeesCredited[0].creditId])).rows[0].status)
      .toBe('void')
  })

  it('a utility on the same bill paid on time BEFORE the fee was charged keeps its on-time mark (review fix)', async () => {
    const z = await zeroedTheOldWay({ onboarding: false })
    // A $40 utility on the bill, paid on its due day — eight days ago in GAM,
    // three days before the late fee posted — and marked on time then.
    const utilId = (await db.query<{ id: string }>(
      `INSERT INTO payments (landlord_id, tenant_id, unit_id, lease_id, type, amount, status, entry_description, due_date, invoice_id, created_at)
       VALUES ($1,$2,$3,$4,'utility',40,'pending','UTILITY',$5::date,$6, NOW() - interval '10 days') RETURNING id`,
      [z.landlordId, z.tenantId, z.unitId, z.leaseId, z.dueDay, z.invoiceId])).rows[0].id
    const paidAt = new Date(`${z.dueDay}T18:00:00Z`)
    await db.query(`UPDATE payments SET status = 'settled', settled_at = $2, manual_method = 'cash' WHERE id = $1`, [utilId, paidAt])
    await db.query(`UPDATE audit_row_changes SET changed_at = NOW() - interval '8 days' WHERE row_id = $1`, [utilId])
    await tx(cl => emitPaymentSettledEvent(cl, {
      tenantId: z.tenantId, paymentId: utilId, paymentType: 'utility', amount: '40', dueDate: z.dueDay, settledAt: paidAt, graceDays: 3,
      stripePaymentIntentId: null, propertyTz: TZ, attestationSource: 'landlord_self_reported_with_evidence',
    }), true)
    const utilBefore = await liveMarks(utilId)
    expect(utilBefore.map(m => m.event_type)).toEqual(['payment_received_on_time'])

    const r = await tx(c => fixReversedLateFees(c), true)
    expect(r.fixed).toHaveLength(1)
    // Only the rent (paid while the fee was on the bill) is corrected.
    expect(r.fixed[0].marks.map(m => m.paymentId)).toEqual([z.rentId])
    expect((await liveMarks(z.rentId))[0].event_type).toMatch(/^payment_received_late_/)
    expect((await liveMarks(utilId)).map(m => m.id)).toEqual([utilBefore[0].id])
  })

  it('a fee zeroed before 10/5 is left alone', async () => {
    const z = await zeroedTheOldWay({ onboarding: false })
    await db.query(`UPDATE payments SET settled_at = '2026-09-20T12:00:00Z' WHERE id = $1`, [z.feeId])
    const r = await tx(c => fixReversedLateFees(c), true)
    expect(r.fixed).toEqual([])
    expect(await fee(z.feeId)).toMatchObject({ amount: 0 })
  })
})

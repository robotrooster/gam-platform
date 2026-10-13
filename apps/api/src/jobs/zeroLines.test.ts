/**
 * 10/12 (Nic) — "$0 lines are ignored."
 *
 * Gerald Logue's October bill carried a $0.00 electric line (his August
 * reading, 49083 → 49083, released when he signed): the monthly run wrote a
 * line for a reading that billed nothing. It read like rent on his profile,
 * counted against his payment health and kept his late fees running. And a
 * $0 line recorded as paid earned a credit mark (Ignacio Gutierrez).
 *
 *   - the monthly run writes no line for a $0 reading: it is marked billed
 *     (read, charged nothing) and never picked up again;
 *   - a $0 line earns no credit mark — unless work trade paid it (hours, not
 *     money: "count work trade as on time");
 *   - a mark's grace is the lease's, else the property's, else 5.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import type { PoolClient } from 'pg'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedLease, seedTenant, seedLeaseTenant,
  seedUtilityMeter, seedUtilityBill,
} from '../test/dbHelpers'
import { generateInvoices } from './invoiceGeneration'
import { emitPaymentSettledEvent } from '../services/creditLedgerEmitters'

beforeEach(cleanupAllSchema)

const RUN_AT = new Date('2026-03-05T14:00:00Z')
const DUE = '2026-03-01'

async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await db.connect()
  try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r }
  catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e } finally { c.release() }
}

async function stack(bills: Array<['electric' | 'water', number]>) {
  return tx(async c => {
    const ll = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
    await c.query(`UPDATE properties SET timezone = 'America/Phoenix' WHERE id = $1`, [propertyId])
    const unitId = await seedUnit(c, { propertyId, landlordId: ll.landlordId })
    const leaseId = await seedLease(c, { unitId, landlordId: ll.landlordId, status: 'active', rentAmount: 460, startDate: '2026-01-01' })
    await c.query(`UPDATE leases SET rent_due_day = 1 WHERE id = $1`, [leaseId])
    const tenantId = await seedTenant(c)
    await seedLeaseTenant(c, { leaseId, tenantId, role: 'primary' })
    const billIds: string[] = []
    for (const [utilityType, amt] of bills) {
      const meterId = await seedUtilityMeter(c, { propertyId, utilityType })
      billIds.push(await seedUtilityBill(c, {
        meterId, unitId, tenantId, leaseId, landlordId: ll.landlordId,
        chargeAmount: amt, billingCycleMonth: DUE, status: 'unbilled', utilityType,
      }))
    }
    return { ...ll, propertyId, unitId, leaseId, tenantId, billIds }
  })
}

describe('the monthly run and a $0 reading', () => {
  it('writes no line for a $0 reading — it is billed as nothing — and bills the reading that charges money', async () => {
    const s = await stack([['electric', 0], ['water', 31.5]])
    await generateInvoices(RUN_AT)
    const lines = (await db.query<{ amount: number }>(
      `SELECT amount::float AS amount FROM payments WHERE lease_id = $1 AND type = 'utility'`, [s.leaseId])).rows
    expect(lines).toEqual([{ amount: 31.5 }])
    const [zero, real] = s.billIds
    const bills = (await db.query<{ id: string; status: string; payment_id: string | null; billed_at: Date | null }>(
      `SELECT id, status, payment_id, billed_at FROM utility_bills WHERE id = ANY($1::uuid[])`, [s.billIds])).rows
    const z = bills.find(b => b.id === zero)!
    expect(z.status).toBe('billed')
    expect(z.payment_id).toBeNull()
    expect(z.billed_at).not.toBeNull()
    expect(bills.find(b => b.id === real)!.payment_id).not.toBeNull()
  })

  it('the next month\'s run does not pick the $0 reading up again', async () => {
    const s = await stack([['electric', 0]])
    await generateInvoices(RUN_AT)
    await generateInvoices(new Date('2026-04-05T14:00:00Z'))
    const lines = (await db.query(`SELECT 1 FROM payments WHERE lease_id = $1 AND type = 'utility'`, [s.leaseId])).rows
    expect(lines).toEqual([])
  })
})

describe('a $0 line and the credit history', () => {
  const zeroLine = (s: Awaited<ReturnType<typeof stack>>, notes: string | null) => db.query<{ id: string }>(
    `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, notes, settled_at)
     VALUES ($1,$2,$3,$4,'utility',0,'settled','2026-10-01','UTILITY',$5,NOW()) RETURNING id`,
    [s.unitId, s.leaseId, s.tenantId, s.landlordId, notes]).then(r => r.rows[0].id)
  const marks = async (tenantId: string) => (await db.query<{ event_type: string; event_data: any }>(
    `SELECT e.event_type, e.event_data FROM credit_events e JOIN credit_subjects cs ON cs.id = e.subject_id
      WHERE cs.subject_ref_id = $1 AND e.event_type LIKE 'payment_received_%' AND e.superseded_by IS NULL`, [tenantId])).rows

  it('a $0 line recorded as paid earns no mark (Ignacio Gutierrez\'s $0.00 electric)', async () => {
    const s = await stack([])
    const id = await zeroLine(s, 'Electric meter 00645 → 00645 · 0 kWh — Recorded as manual cash payment')
    await tx(c => emitPaymentSettledEvent(c, {
      tenantId: s.tenantId, paymentId: id, paymentType: 'utility', amount: '0', dueDate: '2026-10-01',
      settledAt: new Date('2026-10-03T17:00:00Z'), graceDays: null, stripePaymentIntentId: null, propertyTz: 'America/Phoenix',
    }))
    expect(await marks(s.tenantId)).toEqual([])
  })

  // 10/12 (Nic): "one mark per invoice" — the month close settles the line at
  // $0 and keeps the hours' value on its invoice (work_trade_credit_amount):
  // the bill is covered, so it is on time.
  it('a line work trade paid still earns its on-time mark', async () => {
    const s = await stack([])
    const id = await zeroLine(s, 'Work trade — suspended — Covered by work-trade credit')
    const inv = (await db.query<{ id: string }>(
      `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date, total_amount, status, work_trade_credit_amount)
       VALUES ($1,$2,$3,$4,'INV-WT-0','2026-10-01',0,'settled',42) RETURNING id`,
      [s.landlordId, s.tenantId, s.leaseId, s.unitId])).rows[0].id
    await db.query(`UPDATE payments SET invoice_id = $2 WHERE id = $1`, [id, inv])
    await tx(c => emitPaymentSettledEvent(c, {
      tenantId: s.tenantId, paymentId: id, paymentType: 'utility', amount: '42', dueDate: '2026-10-01',
      settledAt: new Date('2026-10-01T12:00:00Z'), graceDays: null, stripePaymentIntentId: null, propertyTz: 'America/Phoenix',
    }))
    expect((await marks(s.tenantId)).map(m => m.event_type)).toEqual(['payment_received_on_time'])
  })

  it('no lease grace: the property\'s grace decides (the one chain), and the mark records it', async () => {
    const s = await stack([])
    await db.query(`UPDATE properties SET late_fee_grace_days = 10 WHERE id = $1`, [s.propertyId])
    const id = (await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, created_at, settled_at)
       VALUES ($1,$2,$3,$4,'rent',460,'settled','2026-10-01','RENT','2026-09-30','2026-10-09T17:00:00Z') RETURNING id`,
      [s.unitId, s.leaseId, s.tenantId, s.landlordId])).rows[0].id
    // Paid Oct 9: past a 5-day grace, inside the property's 10.
    await tx(c => emitPaymentSettledEvent(c, {
      tenantId: s.tenantId, paymentId: id, paymentType: 'rent', amount: '460', dueDate: '2026-10-01',
      settledAt: new Date('2026-10-09T17:00:00Z'), graceDays: null, stripePaymentIntentId: null, propertyTz: 'America/Phoenix',
    }))
    // 10/12: inside the grace period is on time (one rule: no "within grace" tier on a bill).
    const [m] = await marks(s.tenantId)
    expect(m.event_type).toBe('payment_received_on_time')
    expect(m.event_data.grace_days).toBe(10)
  })
})

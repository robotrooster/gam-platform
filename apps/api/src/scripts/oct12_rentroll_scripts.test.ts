/**
 * 10/12 (Nic) — the one-time corrections behind the one payment-health rule,
 * each run as its dry run (one transaction, rolled back: nothing changes) and
 * then applied (and run again: nothing left to do), on fixtures shaped like
 * production:
 *   oct12_void_zero_lines     — the open $0 lines are voided; the reading stays billed
 *   oct12_rerate_late_marks   — every payment history rebuilt as one mark per bill (the late-written
 *                               bill, the 6th, the $0 line, the onboarding month, an unpaid bill)
 *   oct12_gerald_meter        — RV 48's $22.47 estimate voided, the meter repaired and
 *                               confirmed working: his next flat read bills $0, not another estimate
 */
import { randomUUID } from 'crypto'
import { describe, it, expect, beforeEach, beforeAll } from 'vitest'
import type { PoolClient } from 'pg'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedLease, seedTenant, seedLeaseTenant, seedUtilityMeter, seedUtilityBill } from '../test/dbHelpers'
import { appendEvent, verifyChain } from '../services/creditLedger'
import { voidZeroLines, ZERO_LINE_VOID_REASON } from './oct12_void_zero_lines'
import { planRebuild, applyRebuild, describeRebuild, formatRebuild, direction } from './oct12_rerate_late_marks'
import { fixGeraldMeter, ESTIMATE_VOID_REASON } from './oct12_gerald_meter'
import { generateBillsForMeter } from '../services/utilityBilling'
import { ensureMeterZeroUseSchema } from '../test/pendingMeterSchema'

const TZ = 'America/Phoenix'

beforeAll(ensureMeterZeroUseSchema)
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

async function world(o: { unitNumber?: string; existingTenancy?: boolean } = {}) {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const ll = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
    await c.query(`UPDATE properties SET timezone = $2, late_fee_grace_days = 5 WHERE id = $1`, [propertyId, TZ])
    const unitId = await seedUnit(c, { propertyId, landlordId: ll.landlordId })
    if (o.unitNumber) await c.query(`UPDATE units SET unit_number = $2 WHERE id = $1`, [unitId, o.unitNumber])
    const leaseId = await seedLease(c, { unitId, landlordId: ll.landlordId, rentAmount: 495, startDate: '2026-09-16' })
    await c.query(`UPDATE leases SET is_existing_tenancy = $2 WHERE id = $1`, [leaseId, o.existingTenancy === true])
    const tenantId = await seedTenant(c)
    await seedLeaseTenant(c, { leaseId, tenantId, role: 'primary' })
    await c.query('COMMIT')
    return { ...ll, propertyId, unitId, leaseId, tenantId }
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e } finally { c.release() }
}
type World = Awaited<ReturnType<typeof world>>

async function invoice(w: World, due: string, writtenAt: string, number = `INV-${randomUUID().slice(0, 8)}`) {
  return (await db.query<{ id: string }>(
    `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date, total_amount,
                           subtotal_rent, subtotal_utilities, status, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,517.47,495,22.47,'pending',($7::timestamp AT TIME ZONE $8)) RETURNING id`,
    [w.landlordId, w.tenantId, w.leaseId, w.unitId, number, due, writtenAt, TZ])).rows[0].id
}

async function line(w: World, invoiceId: string, l: {
  type: 'rent' | 'utility'; amount: number; due: string; writtenAt: string
  settledAt?: string; notes?: string; wtSuspended?: boolean
}) {
  return (await db.query<{ id: string }>(
    `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date,
                           entry_description, notes, created_at, settled_at, work_trade_suspended_at, manual_method)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,($12::timestamp AT TIME ZONE $13),
             CASE WHEN $14::text IS NULL THEN NULL ELSE ($14::timestamp AT TIME ZONE $13) END,
             CASE WHEN $15 THEN NOW() END, CASE WHEN $14::text IS NULL THEN NULL ELSE 'cash' END) RETURNING id`,
    [invoiceId, w.unitId, w.leaseId, w.tenantId, w.landlordId, l.type, l.amount, l.settledAt ? 'settled' : 'pending', l.due,
     l.type === 'rent' ? 'RENT' : 'UTILITY', l.notes ?? null, l.writtenAt, TZ, l.settledAt ?? null, l.wtSuspended === true])).rows[0].id
}

/** A payment mark written the old way (straight into the ledger). */
async function oldMark(w: World, paymentId: string, eventType: string, due: string, paidAt: string, extra: Record<string, unknown> = {}) {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const r = await appendEvent({
      subjectType: 'tenant', subjectRefId: w.tenantId, eventType: eventType as any,
      eventData: { payment_id: paymentId, payment_type: 'rent', amount: '495', due_date: due, paid_at: new Date(paidAt).toISOString(), grace_days: 5, ...extra },
      occurredAt: new Date(paidAt), attestationSource: 'landlord_self_reported_with_evidence', attestationEvidence: {},
      dimensionTags: ['payment_reliability'],
      networkVisibility: ['payment_received_on_time', 'payment_received_late_grace'].includes(eventType) ? 'visible_to_current_landlord' : 'visible_to_gam_network',
    }, c)
    await c.query('COMMIT')
    return r.eventId
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e } finally { c.release() }
}

const liveMarks = async (paymentId: string) => (await db.query<{ id: string; event_type: string; event_data: any; superseded_reason: string | null }>(
  `SELECT id, event_type, event_data, superseded_reason FROM credit_events
    WHERE event_type LIKE 'payment_received_%' AND event_data->>'payment_id' = $1 AND superseded_by IS NULL`, [paymentId])).rows
const row = async (id: string) => (await db.query<any>(
  `SELECT status, void_reason, amount::float AS amount, notes FROM payments WHERE id = $1`, [id])).rows[0]

describe('oct12_void_zero_lines', () => {
  it('a dry run changes nothing; --apply voids the open $0 line (the reading stays billed); a second run finds nothing', async () => {
    const w = await world({ unitNumber: 'RV 48' })
    const inv = await invoice(w, '2026-10-01', '2026-10-01 05:00')
    const zero = await line(w, inv, { type: 'utility', amount: 0, due: '2026-10-01', writtenAt: '2026-10-01 05:00',
      notes: 'Electric meter 49083 → 49083 (Aug 1 → Sep 2) · 0 kWh' })
    const rent = await line(w, inv, { type: 'rent', amount: 495, due: '2026-10-01', writtenAt: '2026-10-01 05:00' })
    // Left alone: a $0 line already settled (Ignacio's), and a covered work-trade line.
    const settledZero = await line(w, inv, { type: 'utility', amount: 0, due: '2026-10-01', writtenAt: '2026-10-01 05:00', settledAt: '2026-10-03 10:00' })
    const meterId = await (async () => { const c = await db.connect(); try { return await seedUtilityMeter(c, { propertyId: w.propertyId, utilityType: 'electric' }) } finally { c.release() } })()
    const reading = await (async () => { const c = await db.connect(); try {
      return await seedUtilityBill(c, { meterId, unitId: w.unitId, tenantId: w.tenantId, leaseId: w.leaseId, landlordId: w.landlordId,
        chargeAmount: 0, paymentId: zero, billingCycleMonth: '2026-08-01', status: 'billed', utilityType: 'electric' })
    } finally { c.release() } })()

    const dry = await tx(c => voidZeroLines(c, { landlordIds: [w.landlordId] }), false)
    expect(dry.map(v => v.paymentId)).toEqual([zero])
    expect(dry[0]).toMatchObject({ unitNumber: 'RV 48', readingId: reading, readingStatus: 'billed' })
    expect((await row(zero)).status).toBe('pending')

    const done = await tx(c => voidZeroLines(c, { landlordIds: [w.landlordId] }), true)
    expect(done).toHaveLength(1)
    expect(await row(zero)).toMatchObject({ status: 'voided', void_reason: ZERO_LINE_VOID_REASON })
    expect((await row(rent)).status).toBe('pending')
    expect((await row(settledZero)).status).toBe('settled')
    const bill = (await db.query<any>(`SELECT status, payment_id FROM utility_bills WHERE id = $1`, [reading])).rows[0]
    expect(bill).toMatchObject({ status: 'billed', payment_id: zero })

    expect(await tx(c => voidZeroLines(c, { landlordIds: [w.landlordId] }), true)).toEqual([])
  })
})

// 10/12 (Nic): "the payment history should be a health percentage. one mark
// per invoice." oct12_rerate_late_marks is now the rebuild of every history as
// one mark per bill (services/creditBillMarks); the four per-line corrections
// it made before (bills written late, the first late day, $0 lines, the
// onboarding month) are carried by the bill rule.
describe('oct12_rerate_late_marks — every history rebuilt as one mark per bill', () => {
  const AS_OF = '2026-10-12'
  const readOnly = (fn: (c: PoolClient) => Promise<unknown>) => tx(async c => { await c.query('SET TRANSACTION READ ONLY'); return fn(c) }, false)
  const marksOf = async (tenantId: string) => (await db.query<{ id: string; event_type: string; event_data: any; superseded_by: string | null; superseded_reason: string | null }>(
    `SELECT e.id, e.event_type, e.event_data, e.superseded_by, e.superseded_reason
       FROM credit_events e JOIN credit_subjects s ON s.id = e.subject_id
      WHERE s.subject_ref_id = $1 AND e.event_type LIKE 'payment_%' ORDER BY e.recorded_at, e.id`, [tenantId])).rows

  it('Gerald\'s September and October: their per-line marks become one mark per bill; the dry run only reads; a second run finds nothing', async () => {
    const w = await world({ existingTenancy: true })
    // September (his onboarding month): due 9/1, written 9/16, paid 9/17 — "late, major" the old way; on time by the rule.
    const sepInv = await invoice(w, '2026-09-01', '2026-09-16 09:00')
    const sep = await line(w, sepInv, { type: 'rent', amount: 495, due: '2026-09-01', writtenAt: '2026-09-16 09:00', settledAt: '2026-09-17 10:13' })
    const sepMark = await oldMark(w, sep, 'payment_received_late_major', '2026-09-01', '2026-09-17T17:13:00Z')
    // October: rent paid on the 6th ("within grace" the old way), a $0 electric
    // recorded as cash and a line work trade settled at $0, each with its own mark.
    const octInv = await invoice(w, '2026-10-01', '2026-09-30 05:00')
    const oct = await line(w, octInv, { type: 'rent', amount: 495, due: '2026-10-01', writtenAt: '2026-09-30 05:00', settledAt: '2026-10-06 09:00' })
    const octMark = await oldMark(w, oct, 'payment_received_late_grace', '2026-10-01', '2026-10-06T16:00:00Z')
    const zero = await line(w, octInv, { type: 'utility', amount: 0, due: '2026-10-01', writtenAt: '2026-09-30 05:00', settledAt: '2026-10-03 10:00' })
    const zeroMark = await oldMark(w, zero, 'payment_received_late_grace', '2026-10-01', '2026-10-03T17:00:00Z')
    const wt = await line(w, octInv, { type: 'utility', amount: 0, due: '2026-10-01', writtenAt: '2026-09-30 05:00',
      settledAt: '2026-10-31 23:00', notes: 'Covered by work-trade credit' })
    const wtMark = await oldMark(w, wt, 'payment_received_on_time', '2026-10-01', '2026-10-01T12:00:00Z')
    const before = await marksOf(w.tenantId)

    // The dry run: a READ ONLY transaction — it could not write if it tried.
    const report = await readOnly(async c => describeRebuild(c, await planRebuild(c, { asOf: AS_OF }))) as Awaited<ReturnType<typeof describeRebuild>>
    expect(await marksOf(w.tenantId)).toEqual(before)
    expect(report).toHaveLength(1)
    expect(report[0]).toMatchObject({
      tenantId: w.tenantId,
      before: { marks: 4, onTime: 1, percent: 25 },
      after: { bills: 2, onTime: 1, percent: 50 },
    })
    expect(report[0].bills.map(b => [b.after, b.direction])).toEqual([
      ['on time', 'better'],
      ['late, 1–3 days past grace (1 day past grace)', 'worse'],
    ])
    expect(formatRebuild(report, 'DRY RUN')).toContain('2 bill(s) or mark(s): 1 better, 1 worse, 0 the same')

    const done = await tx(c => applyRebuild(c, { asOf: AS_OF }), true)
    expect(done.changes.map(c => [c.invoiceId, c.now])).toEqual([[sepInv, 'payment_received_on_time'], [octInv, 'payment_received_late_minor']])
    expect(done.subjects).toHaveLength(1)
    const now = (await marksOf(w.tenantId)).filter(m => !m.superseded_by)
    expect(now.map(m => [m.event_data.invoice_id, m.event_type])).toEqual([[sepInv, 'payment_received_on_time'], [octInv, 'payment_received_late_minor']])
    expect(now[0].event_data).toMatchObject({ mark_basis: 'invoice', onboarding_month: true, replaces_event_ids: [sepMark] })
    expect([...now[1].event_data.replaces_event_ids].sort()).toEqual([octMark, zeroMark, wtMark].sort())
    for (const id of [sepMark, octMark, zeroMark, wtMark]) {
      expect((await marksOf(w.tenantId)).find(m => m.id === id)).toMatchObject({ superseded_reason: 'replaced_by_bill_mark' })
    }
    const sid = (await db.query<{ id: string }>(`SELECT id FROM credit_subjects WHERE subject_ref_id = $1`, [w.tenantId])).rows[0].id
    expect((await verifyChain(sid)).ok).toBe(true)

    const again = await tx(c => applyRebuild(c, { asOf: AS_OF }), true)
    expect(again.changes).toEqual([])
    expect(again.orphansWithdrawn).toEqual([])
  })

  it('an unpaid bill past grace gets its mark; an onboarding bill paid late loses its late mark; a mark with no bill is withdrawn', async () => {
    const w = await world({ existingTenancy: true })
    // Mireya Fierro: the onboarding bill, paid 9/15, "late, major" — no late fee on it.
    const sepInv = await invoice(w, '2026-09-01', '2026-09-03 09:00')
    const rent = await line(w, sepInv, { type: 'rent', amount: 495, due: '2026-09-01', writtenAt: '2026-09-03 09:00', settledAt: '2026-09-15 10:00' })
    const rentMark = await oldMark(w, rent, 'payment_received_late_major', '2026-09-01', '2026-09-15T17:00:00Z')
    // October: nothing paid, past grace on 10/12.
    const octInv = await invoice(w, '2026-10-01', '2026-09-30 05:00')
    await line(w, octInv, { type: 'rent', amount: 495, due: '2026-10-01', writtenAt: '2026-09-30 05:00' })
    // A mark whose payment row no longer exists.
    const orphan = await oldMark(w, randomUUID(), 'payment_received_late_minor', '2026-08-01', '2026-08-09T17:00:00Z')

    const report = await readOnly(async c => describeRebuild(c, await planRebuild(c, { asOf: AS_OF }))) as Awaited<ReturnType<typeof describeRebuild>>
    expect(report[0].bills.map(b => [b.before, b.after, b.direction])).toEqual([
      ['rent: late, 4–15 days past grace', 'no mark', 'better'],
      ['no mark', 'unpaid past grace', 'worse'],
    ])
    expect(report[0].orphans).toEqual([{ eventId: orphan, mark: 'late, 1–3 days past grace', direction: 'better', why: 'its payment row no longer exists' }])

    const done = await tx(c => applyRebuild(c, { asOf: AS_OF }), true)
    expect(done.orphansWithdrawn.map(o => o.id)).toEqual([orphan])
    const all = await marksOf(w.tenantId)
    for (const id of [rentMark, orphan]) expect(all.find(m => m.id === id)).toMatchObject({ superseded_by: id, superseded_reason: 'attestation_invalidated' })
    expect(all.filter(m => !m.superseded_by).map(m => [m.event_data.invoice_id, m.event_type, m.event_data.stamp]))
      .toEqual([[octInv, 'payment_skipped', 'outstanding']])
    const again = await tx(c => applyRebuild(c, { asOf: AS_OF }), true)
    expect(again.changes).toEqual([])
  })

  it('better or worse: the worst mark before against the one after', () => {
    expect(direction(['payment_received_on_time', 'payment_received_on_time'], 'payment_received_on_time')).toBe('same')
    expect(direction(['payment_received_late_major'], 'payment_received_on_time')).toBe('better')
    expect(direction(['payment_received_late_grace'], 'payment_received_late_minor')).toBe('worse')
    expect(direction(['payment_received_late_severe'], null)).toBe('better')
    expect(direction(['payment_received_on_time'], null)).toBe('worse')
    expect(direction([], 'payment_skipped')).toBe('worse')
    expect(direction([], 'payment_received_on_time')).toBe('better')
  })
})

describe('oct12_gerald_meter', () => {
  async function gerald() {
    const w = await world({ unitNumber: 'RV 48', existingTenancy: true })
    const inv = await invoice(w, '2026-10-01', '2026-09-30 05:00', 'INV-T-00076')
    await line(w, inv, { type: 'rent', amount: 495, due: '2026-10-01', writtenAt: '2026-09-30 05:00' })
    const est = await line(w, inv, { type: 'utility', amount: 22.47, due: '2026-10-01', writtenAt: '2026-09-30 05:00' })
    const c = await db.connect()
    try {
      const meterId = await seedUtilityMeter(c, { propertyId: w.propertyId, utilityType: 'electric' })
      await c.query(`UPDATE utility_meters SET label = 'RV 48 electric', out_of_service = TRUE, out_of_service_since = '2026-10-05' WHERE id = $1`, [meterId])
      await c.query(`INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1,$2)`, [meterId, w.unitId])
      for (const [day, cycle] of [['2026-08-01', '2026-08-01'], ['2026-09-02', '2026-09-01'], ['2026-09-30', '2026-10-01']]) {
        await c.query(`INSERT INTO utility_meter_readings (meter_id, reading_date, reading_value, billing_cycle_month, reason, created_by_user_id)
                       VALUES ($1,$2,49083,$3,'monthly_cycle',$4)`, [meterId, day, cycle, w.userId])
      }
      const reading = await seedUtilityBill(c, { meterId, unitId: w.unitId, tenantId: w.tenantId, leaseId: w.leaseId, landlordId: w.landlordId,
        chargeAmount: 22.47, paymentId: est, billingCycleMonth: '2026-09-01', status: 'billed', utilityType: 'electric' })
      return { w, inv, est, meterId, reading }
    } finally { c.release() }
  }
  const who = (g: Awaited<ReturnType<typeof gerald>>) =>
    ({ tenantId: g.w.tenantId, invoiceNumber: 'INV-T-00076', amount: 22.47, unitNumber: 'RV 48' })

  it('a dry run changes nothing; --apply voids the $22.47 and puts the meter back as "Works, tenant uses no power"; a second run has nothing to do', async () => {
    const g = await gerald()
    const dry = await tx(c => fixGeraldMeter(c, who(g)), false)
    expect(dry).toMatchObject({ refused: null, voided: { paymentId: g.est, amount: 22.47 }, meterBackInService: { meterId: g.meterId },
      zeroUseConfirmed: { meterId: g.meterId } })
    expect((await row(g.est)).status).toBe('pending')
    expect((await db.query<any>(`SELECT out_of_service FROM utility_meters WHERE id = $1`, [g.meterId])).rows[0].out_of_service).toBe(true)

    const done = await tx(c => fixGeraldMeter(c, who(g)), true)
    expect(done.refused).toBeNull()
    expect(await row(g.est)).toMatchObject({ status: 'voided', void_reason: ESTIMATE_VOID_REASON, amount: 22.47 })
    expect((await db.query<any>(`SELECT status FROM utility_bills WHERE id = $1`, [g.reading])).rows[0].status).toBe('void')
    expect((await db.query<any>(`SELECT total_amount::float AS t, subtotal_utilities::float AS u FROM invoices WHERE id = $1`, [g.inv])).rows[0])
      .toEqual({ t: 495, u: 0 })
    const meter = (await db.query<any>(
      `SELECT out_of_service, out_of_service_since, zero_use_confirmed_at IS NOT NULL AS confirmed,
              zero_use_confirmed_by_user_id IS NOT NULL AS confirmed_by
         FROM utility_meters WHERE id = $1`, [g.meterId])).rows[0]
    expect(meter).toEqual({ out_of_service: false, out_of_service_since: null, confirmed: true, confirmed_by: true })
    // 10/12 (review): the meter was never replaced, so his history does not say it was.
    const reads = (await db.query<any>(`SELECT 1 FROM utility_meter_readings WHERE meter_id = $1 AND reason = 'meter_replaced'`, [g.meterId])).rows
    expect(reads).toEqual([])

    const again = await tx(c => fixGeraldMeter(c, who(g)), true)
    expect(again).toEqual({ voided: null, meterBackInService: null, zeroUseConfirmed: null, refused: null })
  })

  it('his next flat read bills $0 — not marked broken again, no estimate — while Mountain View still estimates; once it moves the confirmation is cleared', async () => {
    const g = await gerald()
    await db.query(`UPDATE properties SET estimates_stuck_meters = TRUE WHERE id = $1`, [g.w.propertyId])
    await tx(c => fixGeraldMeter(c, who(g)), true)
    // The next cycle read, a month after his last one, shows the same 49083.
    const nextRead = (reason: string, days: number, value: number) => db.query<{ cycle: string }>(
      `INSERT INTO utility_meter_readings (meter_id, reading_date, reading_value, billing_cycle_month, reason, created_by_user_id)
       SELECT r.meter_id, r.reading_date + $3::int, $4,
              ((SELECT MAX(c.billing_cycle_month) FROM utility_meter_readings c WHERE c.meter_id = $1 AND c.reason = 'monthly_cycle')
                 + interval '1 month')::date,
              'monthly_cycle', r.created_by_user_id
         FROM utility_meter_readings r WHERE r.meter_id = $1 AND r.reason = $2
        ORDER BY r.reading_date DESC LIMIT 1
       RETURNING to_char(billing_cycle_month, 'YYYY-MM-DD') AS cycle`, [g.meterId, reason, days, value])
    const next = (await nextRead('monthly_cycle', 31, 49083)).rows[0].cycle
    await generateBillsForMeter(g.meterId, new Date(`${next}T00:00:00Z`))
    const meter = (await db.query<any>(`SELECT out_of_service, zero_use_confirmed_at IS NOT NULL AS confirmed FROM utility_meters WHERE id = $1`, [g.meterId])).rows[0]
    expect(meter).toEqual({ out_of_service: false, confirmed: true })
    const bills = (await db.query<any>(
      `SELECT charge_amount::float AS charge, allocation_method FROM utility_bills WHERE meter_id = $1 AND billing_cycle_month = $2`, [g.meterId, next])).rows
    expect(bills.filter(b => b.charge > 0 || b.allocation_method === 'comparable_low')).toEqual([])
    expect((await db.query(`SELECT 1 FROM notifications WHERE type = 'utility_meter_broken'`)).rows).toEqual([])

    // The meter moves the month after: the confirmation has done its job.
    const after = (await nextRead('monthly_cycle', 30, 49190)).rows[0].cycle
    await generateBillsForMeter(g.meterId, new Date(`${after}T00:00:00Z`))
    expect((await db.query<any>(`SELECT zero_use_confirmed_at FROM utility_meters WHERE id = $1`, [g.meterId])).rows[0].zero_use_confirmed_at).toBeNull()
  })

  it('refuses, changing nothing, when a record points at the line (the check every void path makes)', async () => {
    const g = await gerald()
    await db.query(
      `INSERT INTO ach_monitoring_log (payment_id, event_type, tenant_id, amount) VALUES ($1, 'return_received', $2, 22.47)`,
      [g.est, g.w.tenantId])
    const r = await tx(c => fixGeraldMeter(c, who(g)), true)
    expect(r.refused).toMatch(/a record points at/)
    expect((await row(g.est)).status).toBe('pending')
  })

  it('refuses, changing nothing, when the line has money on it', async () => {
    const g = await gerald()
    await db.query(`UPDATE payments SET status = 'settled', settled_at = NOW(), manual_method = 'cash' WHERE id = $1`, [g.est])
    const r = await tx(c => fixGeraldMeter(c, who(g)), true)
    expect(r.refused).toMatch(/settled/)
    expect(r.voided).toBeNull()
  })
})

/**
 * 10/12 (Nic) — "the payment history should be a health percentage. one mark
 * per invoice."
 *
 * A tenant's payment history is ONE mark per bill, rated by the payment-health
 * rule (the same stamp the Rent Roll gives the same bill), written and
 * corrected only through the ledger's own mechanism (append + supersede, the
 * hash chain intact).
 */
import { randomUUID } from 'crypto'
import { describe, it, expect, beforeEach } from 'vitest'
import type { PoolClient } from 'pg'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedLease, seedTenant, seedLeaseTenant } from '../test/dbHelpers'
import { householdMonths } from './householdMonths'
import {
  judgeBills, planBillMarks, syncBillMarks, syncBillMarksForPayments, syncBillMarksNightly, billsToReview,
  billMarkEventType, BILL_MARK_BASIS, BILL_MARK_RULE,
} from './creditBillMarks'
import {
  emitPaymentSettledEvent, emitPaymentFailedEvent, reRateMarksFromBankDate, undoBankDateMarks,
  reRateMarksWithoutLateFee, isOnboardingMonthCharge,
} from './creditLedgerEmitters'
import { appendEvent, supersedeEvent, verifyChain, findSubjectId } from './creditLedger'
import { openDispute, resolveDispute } from './creditDispute'
import { runWorkTradeSettlement } from '../jobs/workTradeSettlement'
import { hourRateFor } from './workTradeSettlement'

const AS_OF = '2026-10-12'
const TZ = 'America/Phoenix'

beforeEach(cleanupAllSchema)

interface World { landlordId: string; userId: string; propertyId: string; unitId: string; leaseId: string; tenantId: string }

async function world(o: { existingTenancy?: boolean } = {}): Promise<World> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const ll = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
    await c.query(`UPDATE properties SET timezone = $2, late_fee_grace_days = 5 WHERE id = $1`, [propertyId, TZ])
    const unitId = await seedUnit(c, { propertyId, landlordId: ll.landlordId, rentAmount: 589 })
    const leaseId = await seedLease(c, { unitId, landlordId: ll.landlordId, rentAmount: 495, startDate: '2026-08-01' })
    await c.query(`UPDATE leases SET is_existing_tenancy = $2 WHERE id = $1`, [leaseId, o.existingTenancy === true])
    const tenantId = await seedTenant(c)
    await seedLeaseTenant(c, { leaseId, tenantId, role: 'primary' })
    await c.query('COMMIT')
    return { landlordId: ll.landlordId, userId: ll.userId, propertyId, unitId, leaseId, tenantId }
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e } finally { c.release() }
}

interface Line {
  type: 'rent' | 'utility' | 'fee' | 'late_fee' | 'home_payment'
  amount: number
  status?: 'pending' | 'settled' | 'processing' | 'voided'
  /** Phoenix local 'YYYY-MM-DD HH:MM' the money came in. */
  paidAt?: string
  method?: 'cash' | 'card'
  notes?: string
  wtSuspended?: boolean
  due?: string
}
const ENTRY: Record<Line['type'], string> = { rent: 'RENT', utility: 'UTILITY', fee: 'OTHERFEE', late_fee: 'LATEFEE', home_payment: 'HOMEPMT' }

/** One bill: an invoice due `due`, written at `writtenAt` (Phoenix local), with its lines. */
async function bill(w: World, due: string, writtenAt: string, lines: Line[], o: { wtCredit?: number } = {}): Promise<{ invoiceId: string; ids: string[] }> {
  const invoiceId = (await db.query<{ id: string }>(
    `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date, total_amount, status,
                           created_at, work_trade_credit_amount)
     VALUES ($1,$2,$3,$4,$5,$6,0,'pending',($7::timestamp AT TIME ZONE $8),$9) RETURNING id`,
    [w.landlordId, w.tenantId, w.leaseId, w.unitId, `INV-${randomUUID().slice(0, 8)}`, due, writtenAt, TZ, o.wtCredit ?? 0])).rows[0].id
  const ids: string[] = []
  for (const l of lines) {
    const settled = l.status === 'settled'
    const id = (await db.query<{ id: string }>(
      `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date,
                             entry_description, notes, created_at, settled_at, manual_method, work_trade_suspended_at,
                             stripe_payment_intent_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,($12::timestamp AT TIME ZONE $13),
               CASE WHEN $14::text IS NULL THEN NULL ELSE ($14::timestamp AT TIME ZONE $13) END,
               $15, CASE WHEN $16 THEN NOW() END, $17) RETURNING id`,
      [invoiceId, w.unitId, w.leaseId, w.tenantId, w.landlordId, l.type, l.amount,
       l.status === 'voided' ? 'pending' : (l.status ?? 'pending'), l.due ?? due, ENTRY[l.type], l.notes ?? null, writtenAt, TZ,
       settled ? l.paidAt ?? null : null, settled && l.method !== 'card' ? 'cash' : null, l.wtSuspended === true,
       l.status === 'processing' || (settled && l.method === 'card') ? `pi_${randomUUID().slice(0, 8)}` : null])).rows[0].id
    if (l.status === 'voided') await db.query(`UPDATE payments SET status = 'voided', voided_at = NOW(), void_reason = 'test' WHERE id = $1`, [id])
    if (settled && l.method === 'card') {
      const rem = (await db.query<{ id: string }>(
        `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, unapplied_amount, status,
                                         payment_method, processing_fee_amount, stripe_payment_intent_id, created_at, settled_at)
         VALUES ($1,$2,$3,$4,$4,0,'settled','card',0,$5,($6::timestamp AT TIME ZONE $7),($6::timestamp AT TIME ZONE $7)) RETURNING id`,
        [w.tenantId, w.leaseId, w.landlordId, l.amount, `pi_${randomUUID().slice(0, 8)}`, l.paidAt, TZ])).rows[0].id
      await db.query(`INSERT INTO remittance_applications (remittance_id, payment_id, amount_applied) VALUES ($1,$2,$3)`, [rem, id, l.amount])
    }
    ids.push(id)
  }
  return { invoiceId, ids }
}

async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const r = await fn(c)
    await c.query('COMMIT')
    return r
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e } finally { c.release() }
}

const settle = (id: string, at: string) => db.query(
  `UPDATE payments SET status = 'settled', manual_method = 'cash', settled_at = ($2::timestamp AT TIME ZONE $3) WHERE id = $1`, [id, at, TZ])

/** Every payment mark on the tenant's record, oldest first, with what superseded it. */
const marksOf = async (tenantId: string) => (await db.query<{
  id: string; event_type: string; event_data: any; superseded_by: string | null; superseded_reason: string | null
  attestation_source: string; network_visibility: string; occurred_at: Date
}>(
  `SELECT e.id, e.event_type, e.event_data, e.superseded_by, e.superseded_reason, e.attestation_source,
          e.network_visibility, e.occurred_at
     FROM credit_events e JOIN credit_subjects s ON s.id = e.subject_id
    WHERE s.subject_type = 'tenant' AND s.subject_ref_id = $1 AND e.event_type LIKE 'payment_%'
    ORDER BY e.recorded_at, e.id`, [tenantId])).rows
const live = async (tenantId: string) => (await marksOf(tenantId)).filter(m => !m.superseded_by)

/** A per-line mark written the old way (before 10/12), straight into the ledger. */
async function oldLineMark(tenantId: string, paymentId: string, eventType: string, paidAt: string): Promise<string> {
  return tx(async c => (await appendEvent({
    subjectType: 'tenant', subjectRefId: tenantId, eventType: eventType as any,
    eventData: { payment_id: paymentId, payment_type: 'rent', amount: '495', due_date: '2026-09-01', paid_at: new Date(paidAt).toISOString(), grace_days: 5 },
    occurredAt: new Date(paidAt), attestationSource: 'landlord_self_reported_with_evidence', attestationEvidence: {},
    dimensionTags: ['payment_reliability'],
    networkVisibility: eventType === 'payment_received_on_time' || eventType === 'payment_received_late_grace' ? 'visible_to_current_landlord' : 'visible_to_gam_network',
  }, c)).eventId)
}

describe('the mark a bill earns', () => {
  it('maps the stamp and its days past grace to the event the ledger and the score already know', () => {
    expect(billMarkEventType('paid_on_time', 0)).toBe('payment_received_on_time')
    expect(billMarkEventType('paid_late', 1)).toBe('payment_received_late_minor')
    expect(billMarkEventType('paid_late', 3)).toBe('payment_received_late_minor')
    expect(billMarkEventType('paid_late', 4)).toBe('payment_received_late_major')
    expect(billMarkEventType('paid_late', 15)).toBe('payment_received_late_major')
    expect(billMarkEventType('paid_late', 16)).toBe('payment_received_late_severe')
    expect(billMarkEventType('partial', 4)).toBe('payment_partial')
    expect(billMarkEventType('outstanding', 7)).toBe('payment_skipped')
    expect(billMarkEventType('due', 0)).toBeNull()
    expect(billMarkEventType(null, 0)).toBeNull()
  })
})

describe('the same stamp as the Rent Roll (one payment-health rule)', () => {
  // Each bill is judged per bill here and per household-month by householdMonths;
  // with one bill a month the two must agree exactly (the SQL is kept line for line).
  async function agree(w: World, invoiceId: string, month: string) {
    const [b] = await judgeBills(db, [invoiceId], { asOf: AS_OF })
    const [m] = await householdMonths({ landlordIds: [w.landlordId], from: month, through: month, asOf: AS_OF })
    expect(b.stamp).toBe(m?.stamp ?? null)
    expect(b.days).toBe(m?.days_past_grace ?? 0)
    expect(b.counted).toBe(m?.counted ?? false)
    expect(b.onTime).toBe(m?.on_time ?? false)
    expect(b.onboarding).toBe(m?.onboarding ?? false)
    expect(b.lateFeeOnBill).toBe(m?.late_fee_on_bill ?? false)
    expect(b.chargedBase).toBe(m?.charged_base ?? 0)
    expect(b.owedBase).toBe(m?.owed_base ?? 0)
    expect(b.workTradeOnly).toBe(m?.work_trade_only ?? false)
    expect(b.firstLateDay).toBe(m?.first_late_day ?? null)
    expect(b.paidInFullOn).toBe(m?.paid_in_full_on ?? null)
    expect(b.householdId).toBe(w.tenantId)
    return b
  }

  it('paid on the 5th: on time; on the 6th: 1 day past grace (late, minor)', async () => {
    const w = await world()
    const aug = await bill(w, '2026-08-01', '2026-07-30 05:00', [{ type: 'rent', amount: 495, status: 'settled', method: 'cash', paidAt: '2026-08-05 16:00' }])
    const sep = await bill(w, '2026-09-01', '2026-08-30 05:00', [{ type: 'rent', amount: 495, status: 'settled', method: 'card', paidAt: '2026-09-06 09:00' }])
    expect((await agree(w, aug.invoiceId, '2026-08')).mark).toBe('payment_received_on_time')
    expect((await agree(w, sep.invoiceId, '2026-09'))).toMatchObject({ stamp: 'paid_late', days: 1, mark: 'payment_received_late_minor' })
  })

  it('rent on time and electric paid on the 10th: ONE mark, paid late by the latest line (5 days, late, major)', async () => {
    const w = await world()
    const b = await bill(w, '2026-09-01', '2026-08-30 05:00', [
      { type: 'rent', amount: 495, status: 'settled', method: 'cash', paidAt: '2026-09-02 10:00' },
      { type: 'utility', amount: 40, status: 'settled', method: 'cash', paidAt: '2026-09-10 10:00' },
    ])
    expect(await agree(w, b.invoiceId, '2026-09')).toMatchObject({ stamp: 'paid_late', days: 5, mark: 'payment_received_late_major', paidInFullOn: '2026-09-10' })
  })

  it('part paid with the rest owed past grace: partial; nothing paid past grace: outstanding (unpaid past grace)', async () => {
    const w = await world()
    const sep = await bill(w, '2026-09-01', '2026-08-30 05:00', [
      { type: 'rent', amount: 495, status: 'settled', method: 'cash', paidAt: '2026-09-02 10:00' },
      { type: 'utility', amount: 40 },
    ])
    const oct = await bill(w, '2026-10-01', '2026-09-30 05:00', [{ type: 'rent', amount: 495 }])
    expect(await agree(w, sep.invoiceId, '2026-09')).toMatchObject({ stamp: 'partial', mark: 'payment_partial' })
    expect(await agree(w, oct.invoiceId, '2026-10')).toMatchObject({ stamp: 'outstanding', days: 7, mark: 'payment_skipped' })
  })

  it('$0 lines and late fees never decide it; a voided line is left out', async () => {
    const w = await world()
    const b = await bill(w, '2026-09-01', '2026-08-30 05:00', [
      { type: 'rent', amount: 495, status: 'settled', method: 'cash', paidAt: '2026-09-02 10:00' },
      { type: 'utility', amount: 0, notes: 'Electric meter 49083 → 49083 · 0 kWh' },
      { type: 'late_fee', amount: 25, due: '2026-09-06' },
      { type: 'utility', amount: 40, status: 'voided' },
    ])
    expect(await agree(w, b.invoiceId, '2026-09')).toMatchObject({ stamp: 'paid_on_time', chargedBase: 495, mark: 'payment_received_on_time', lateFeeOnBill: true })
  })

  it('a bill GAM wrote after its due date counts from the day it was written (Gerald Logue\'s September)', async () => {
    const w = await world({ existingTenancy: true })
    const b = await bill(w, '2026-09-01', '2026-09-16 09:00', [{ type: 'rent', amount: 495, status: 'settled', method: 'card', paidAt: '2026-09-17 10:13' }])
    expect(await agree(w, b.invoiceId, '2026-09')).toMatchObject({ stamp: 'paid_on_time', onboarding: true, mark: 'payment_received_on_time' })
  })

  it('work trade covering the bill (held, or settled at the month close) is on time', async () => {
    const w = await world()
    const held = await bill(w, '2026-10-01', '2026-09-30 05:00', [{ type: 'rent', amount: 495, wtSuspended: true }])
    const closed = await bill(w, '2026-09-01', '2026-08-30 05:00',
      [{ type: 'rent', amount: 0, status: 'settled', paidAt: '2026-10-01 01:00', notes: 'Covered by work-trade credit' }], { wtCredit: 495 })
    expect(await agree(w, held.invoiceId, '2026-10')).toMatchObject({ stamp: 'paid_on_time', workTradeOnly: true, mark: 'payment_received_on_time' })
    expect(await agree(w, closed.invoiceId, '2026-09')).toMatchObject({ stamp: 'paid_on_time', workTradeOnly: true, mark: 'payment_received_on_time' })
  })

  it('the onboarding month is good news only: paid late earns no mark — unless a late fee was charged on the bill', async () => {
    const a = await world({ existingTenancy: true })
    const aBill = await bill(a, '2026-09-01', '2026-08-30 05:00', [{ type: 'rent', amount: 495, status: 'settled', method: 'cash', paidAt: '2026-09-15 10:00' }])
    expect(await agree(a, aBill.invoiceId, '2026-09')).toMatchObject({ stamp: 'paid_late', onboarding: true, counted: false, mark: null })
    const b = await world({ existingTenancy: true })
    const bBill = await bill(b, '2026-09-01', '2026-08-30 05:00', [
      { type: 'rent', amount: 495, status: 'settled', method: 'cash', paidAt: '2026-09-15 10:00' },
      { type: 'late_fee', amount: 25, due: '2026-09-06' },
    ])
    expect(await agree(b, bBill.invoiceId, '2026-09')).toMatchObject({ stamp: 'paid_late', onboarding: true, counted: true, mark: 'payment_received_late_major' })
  })

  it('inside the grace period nothing is judged yet (due: no mark)', async () => {
    const w = await world()
    const b = await bill(w, '2026-10-10', '2026-10-01 05:00', [{ type: 'rent', amount: 495 }])
    expect(await agree(w, b.invoiceId, '2026-10')).toMatchObject({ stamp: 'due', counted: false, mark: null })
  })
})

describe('the onboarding month never counts voided rent (10/12)', () => {
  it('rent written and voided for August does not make August the onboarding month: September is', async () => {
    const w = await world({ existingTenancy: true })
    await bill(w, '2026-08-01', '2026-07-30 05:00', [{ type: 'rent', amount: 495, status: 'voided' }])
    const sep = await bill(w, '2026-09-01', '2026-08-30 05:00', [{ type: 'rent', amount: 495, status: 'settled', method: 'cash', paidAt: '2026-09-20 10:00' }])
    expect(await isOnboardingMonthCharge(db, sep.ids[0])).toBe(true)
    const [b] = await judgeBills(db, [sep.invoiceId], { asOf: AS_OF })
    expect(b).toMatchObject({ onboarding: true, counted: false, mark: null })
  })
})

describe('one mark per bill, through the ledger only', () => {
  it('a settle writes the bill\'s ONE mark; settling its other line writes nothing more; the chain verifies', async () => {
    const w = await world()
    const b = await bill(w, '2026-09-01', '2026-08-30 05:00', [
      { type: 'rent', amount: 495, status: 'settled', method: 'card', paidAt: '2026-09-02 10:00' },
      { type: 'utility', amount: 40, status: 'settled', method: 'card', paidAt: '2026-09-03 10:00' },
    ])
    for (const id of b.ids) {
      await tx(c => emitPaymentSettledEvent(c, {
        tenantId: w.tenantId, paymentId: id, paymentType: 'rent', amount: '495', dueDate: '2026-09-01',
        settledAt: new Date(), graceDays: null, stripePaymentIntentId: null,
      }))
    }
    const ms = await marksOf(w.tenantId)
    expect(ms).toHaveLength(1)
    expect(ms[0]).toMatchObject({
      event_type: 'payment_received_on_time', superseded_by: null, attestation_source: 'stripe_attested',
      network_visibility: 'visible_to_current_landlord',
    })
    expect(ms[0].event_data).toMatchObject({
      mark_basis: BILL_MARK_BASIS, rule: BILL_MARK_RULE, invoice_id: b.invoiceId, bill_month: '2026-09', due_date: '2026-09-01',
      stamp: 'paid_on_time', days_past_grace: 0, grace_days: 5, paid_in_full_on: '2026-09-03', charged: '535.00', owed: '0.00',
    })
    expect([...ms[0].event_data.payment_ids].sort()).toEqual([...b.ids].sort())
    expect(new Date(ms[0].occurred_at).toISOString()).toBe('2026-09-03T12:00:00.000Z')
    const sid = await findSubjectId('tenant', w.tenantId)
    expect((await verifyChain(sid!)).ok).toBe(true)
  })

  it('unpaid past grace: the nightly run marks it; paid later: the mark is corrected to paid late, the old one superseded', async () => {
    const w = await world()
    const b = await bill(w, '2026-09-01', '2026-08-30 05:00', [{ type: 'rent', amount: 495 }])
    const night = await syncBillMarksNightly({ asOf: '2026-09-12' })
    expect(night).toMatchObject({ changed: 1, errors: 0 })
    let ms = await live(w.tenantId)
    expect(ms.map(m => m.event_type)).toEqual(['payment_skipped'])
    expect(ms[0].network_visibility).toBe('visible_to_gam_network')
    expect(ms[0].event_data).toMatchObject({ stamp: 'outstanding', first_late_day: '2026-09-06' })
    const outstanding = ms[0].id
    // A second night changes nothing.
    expect(await syncBillMarksNightly({ asOf: '2026-09-13' })).toMatchObject({ changed: 0 })

    await settle(b.ids[0], '2026-09-14 10:00')
    await tx(c => emitPaymentSettledEvent(c, {
      tenantId: w.tenantId, paymentId: b.ids[0], paymentType: 'rent', amount: '495', dueDate: '2026-09-01',
      settledAt: new Date(), graceDays: null, stripePaymentIntentId: null,
    }))
    ms = await live(w.tenantId)
    expect(ms).toHaveLength(1)
    expect(ms[0]).toMatchObject({ event_type: 'payment_received_late_major' })
    expect(ms[0].event_data).toMatchObject({ stamp: 'paid_late', days_past_grace: 9, corrects_event_id: outstanding })
    const old = (await marksOf(w.tenantId)).find(m => m.id === outstanding)!
    expect(old).toMatchObject({ superseded_by: ms[0].id, superseded_reason: 'bill_status_changed' })
    expect((await verifyChain((await findSubjectId('tenant', w.tenantId))!)).ok).toBe(true)
  })

  it('per-line marks written before 10/12 are replaced by the bill\'s one mark', async () => {
    const w = await world()
    const b = await bill(w, '2026-09-01', '2026-08-30 05:00', [
      { type: 'rent', amount: 495, status: 'settled', method: 'cash', paidAt: '2026-09-02 10:00' },
      { type: 'utility', amount: 40, status: 'settled', method: 'cash', paidAt: '2026-09-04 10:00' },
    ])
    const r = await oldLineMark(w.tenantId, b.ids[0], 'payment_received_on_time', '2026-09-02T17:00:00Z')
    const u = await oldLineMark(w.tenantId, b.ids[1], 'payment_received_late_grace', '2026-09-04T17:00:00Z')
    const [change] = await tx(c => syncBillMarks(c, [b.invoiceId], { asOf: AS_OF }))
    expect(change).toMatchObject({ action: 'correct', was: null, now: 'payment_received_on_time' })
    expect(change.wasLines.sort()).toEqual(['payment_received_late_grace', 'payment_received_on_time'])
    const ms = await live(w.tenantId)
    expect(ms).toHaveLength(1)
    expect(ms[0].event_data.replaces_event_ids.sort()).toEqual([r, u].sort())
    for (const id of [r, u]) {
      expect((await marksOf(w.tenantId)).find(m => m.id === id)).toMatchObject({ superseded_by: ms[0].id, superseded_reason: 'replaced_by_bill_mark' })
    }
    // Run twice: nothing more.
    expect(await tx(c => syncBillMarks(c, [b.invoiceId], { asOf: AS_OF }))).toEqual([])
  })

  it('a bill that earns no mark has its marks withdrawn (a voided bill; the onboarding month paid late)', async () => {
    const w = await world()
    const b = await bill(w, '2026-09-01', '2026-08-30 05:00', [{ type: 'rent', amount: 495, status: 'settled', method: 'cash', paidAt: '2026-09-02 10:00' }])
    await tx(c => syncBillMarks(c, [b.invoiceId], { asOf: AS_OF }))
    const [mark] = await live(w.tenantId)
    await db.query(`UPDATE invoices SET status = 'void' WHERE id = $1`, [b.invoiceId])
    const [change] = await tx(c => syncBillMarks(c, [b.invoiceId], { asOf: AS_OF }))
    expect(change).toMatchObject({ action: 'withdraw', was: 'payment_received_on_time', now: null })
    expect(await live(w.tenantId)).toEqual([])
    expect((await marksOf(w.tenantId)).find(m => m.id === mark.id)).toMatchObject({ superseded_by: mark.id, superseded_reason: 'attestation_invalidated' })

    const o = await world({ existingTenancy: true })
    const ob = await bill(o, '2026-09-01', '2026-08-30 05:00', [{ type: 'rent', amount: 495, status: 'settled', method: 'cash', paidAt: '2026-09-15 10:00' }])
    const oldLate = await oldLineMark(o.tenantId, ob.ids[0], 'payment_received_late_major', '2026-09-15T17:00:00Z')
    await tx(c => syncBillMarks(c, [ob.invoiceId], { asOf: AS_OF }))
    expect(await live(o.tenantId)).toEqual([])
    expect((await marksOf(o.tenantId)).find(m => m.id === oldLate)).toMatchObject({ superseded_by: oldLate, superseded_reason: 'attestation_invalidated' })
  })

  it('a mark an admin corrected after a dispute is left alone', async () => {
    const w = await world()
    const b = await bill(w, '2026-09-01', '2026-08-30 05:00', [{ type: 'rent', amount: 495, status: 'settled', method: 'cash', paidAt: '2026-09-20 10:00' }])
    const disputed = await oldLineMark(w.tenantId, b.ids[0], 'payment_received_late_severe', '2026-09-20T17:00:00Z')
    const fixed = await oldLineMark(w.tenantId, b.ids[0], 'payment_received_on_time', '2026-09-20T17:00:00Z')
    await tx(c => supersedeEvent(c, disputed, fixed, 'correction_after_dispute'))
    const [plan] = await planBillMarks(db, [b.invoiceId], { asOf: AS_OF })
    expect(plan.action).toBe('disputed')
    expect(await tx(c => syncBillMarks(c, [b.invoiceId], { asOf: AS_OF }))).toEqual([])
    expect((await live(w.tenantId)).map(m => m.id)).toEqual([fixed])
  })

  it('money still clearing on the bill: left as it is until it settles', async () => {
    const w = await world()
    const b = await bill(w, '2026-09-01', '2026-08-30 05:00', [{ type: 'rent', amount: 495, status: 'processing' }])
    const [plan] = await planBillMarks(db, [b.invoiceId], { asOf: AS_OF })
    expect(plan.action).toBe('clearing')
    expect(await tx(c => syncBillMarks(c, [b.invoiceId], { asOf: AS_OF }))).toEqual([])
    expect(await live(w.tenantId)).toEqual([])
  })

  // A charge written on no invoice (a longer stay's extra rent): part of its
  // lease's bill due the same day when there is one, else a bill of its own.
  it('a charge on no invoice is part of its lease\'s bill due that day — else a bill of its own', async () => {
    const w = await world()
    const sep = await bill(w, '2026-09-01', '2026-08-30 05:00', [{ type: 'rent', amount: 495, status: 'settled', method: 'cash', paidAt: '2026-09-02 10:00' }])
    const extra = (await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description,
                             settled_at, manual_method, created_at, is_remainder, notes)
       VALUES ($1,$2,$3,$4,'rent',120,'settled','2026-09-01','RENT',('2026-09-12 10:00'::timestamp AT TIME ZONE $5),'cash',
               ('2026-09-10 09:00'::timestamp AT TIME ZONE $5), TRUE, 'Stay now ends October 1, 2026: the rest of September 2026') RETURNING id`,
      [w.unitId, w.leaseId, w.tenantId, w.landlordId, TZ])).rows[0].id
    const [change] = await tx(c => syncBillMarksForPayments(c, [extra]))
    // Written 9/10 and paid 9/12 — inside its own grace from the day it was written: the bill stays on time.
    expect(change).toMatchObject({ billKey: sep.invoiceId, invoiceId: sep.invoiceId, now: 'payment_received_on_time' })
    expect([...(await live(w.tenantId))[0].event_data.payment_ids].sort()).toEqual([sep.ids[0], extra].sort())

    // October has no invoice: the charge is a bill of its own, keyed by its row.
    const lone = (await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, created_at)
       VALUES ($1,$2,$3,$4,'rent',495,'pending','2026-10-01','RENT',('2026-09-28 09:00'::timestamp AT TIME ZONE $5)) RETURNING id`,
      [w.unitId, w.leaseId, w.tenantId, w.landlordId, TZ])).rows[0].id
    const [own] = await tx(c => syncBillMarksForPayments(c, [lone]))
    expect(own).toMatchObject({ billKey: `row:${lone}`, invoiceId: null, now: 'payment_skipped' })
    const loneMark = (await live(w.tenantId)).find(m => m.event_data.bill_key === `row:${lone}`)!
    expect(loneMark.event_data).toMatchObject({ invoice_id: null, due_date: '2026-10-01', stamp: 'outstanding' })
    // The nightly run finds it among the bills to look at.
    expect(await billsToReview(db, 72)).toContain(`row:${lone}`)

    // October's invoice is written afterwards: the charge is part of it now,
    // and its own mark is replaced by the invoice's (never two marks for one bill).
    const octInv = (await db.query<{ id: string }>(
      `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date, total_amount, status)
       VALUES ($1,$2,$3,$4,'INV-OCT-LATE','2026-10-01',495,'pending') RETURNING id`,
      [w.landlordId, w.tenantId, w.leaseId, w.unitId])).rows[0].id
    const [rekeyed] = await tx(c => syncBillMarksForPayments(c, [lone]))
    expect(rekeyed).toMatchObject({ billKey: octInv, now: 'payment_skipped' })
    expect(rekeyed.supersededIds).toEqual([loneMark.id])
    const now = (await live(w.tenantId)).filter(m => m.event_data.bill_month === '2026-10')
    expect(now.map(m => m.event_data.bill_key)).toEqual([octInv])
    expect((await marksOf(w.tenantId)).find(m => m.id === loneMark.id)).toMatchObject({ superseded_reason: 'bill_status_changed' })
  })

  it('a failed payment is not its own mark any more: the bill\'s mark shows what came of it', async () => {
    const w = await world()
    const b = await bill(w, '2026-09-01', '2026-08-30 05:00', [{ type: 'rent', amount: 495 }])
    await db.query(`UPDATE payments SET status = 'failed' WHERE id = $1`, [b.ids[0]])
    await tx(c => emitPaymentFailedEvent(c, {
      tenantId: w.tenantId, paymentId: b.ids[0], paymentType: 'rent', amount: '495', dueDate: '2026-09-01',
      failedAt: new Date(), stripePaymentIntentId: 'pi_x', failureCode: 'R01', failureMessage: 'insufficient funds',
    }))
    const ms = await marksOf(w.tenantId)
    expect(ms.map(m => m.event_type)).toEqual(['payment_skipped'])
  })
})

describe('logged by hand after a late fee was charged (10/6: "no exceptions")', () => {
  it('counts from the day GAM recorded it, not the day typed on it; with the late fee deleted it counts from the typed day', async () => {
    const w = await world()
    const today = (await db.query<{ d: string }>(`SELECT (NOW() AT TIME ZONE $1)::date::text AS d`, [TZ])).rows[0].d
    const due = (await db.query<{ d: string }>(`SELECT ($1::date - 20)::text AS d`, [today])).rows[0].d
    const b = await bill(w, due, `${due} 05:00`, [{ type: 'rent', amount: 495 }])
    // A late fee charged on the first late day (five days ago in GAM)…
    const fee = (await db.query<{ id: string }>(
      `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, created_at)
       VALUES ($1,$2,$3,$4,$5,'late_fee',25,'pending',$6::date + 5,'LATEFEE', NOW() - interval '15 days') RETURNING id`,
      [b.invoiceId, w.unitId, w.leaseId, w.tenantId, w.landlordId, due])).rows[0].id
    // …then the desk logs cash today, dated the due day.
    await settle(b.ids[0], `${due} 10:00`)
    const [late] = await judgeBills(db, [b.invoiceId])
    expect(late).toMatchObject({ stamp: 'paid_late', paidInFullOn: today, loggedAfterLateFee: true, lateFeeOnBill: true })
    // The landlord deletes the fee (onboarding month, their choice): the typed day stands.
    await db.query(`UPDATE payments SET status = 'voided', voided_at = NOW(), void_reason = 'deleted' WHERE id = $1`, [fee])
    const [clean] = await judgeBills(db, [b.invoiceId])
    expect(clean).toMatchObject({ stamp: 'paid_on_time', paidInFullOn: due, loggedAfterLateFee: false, lateFeeOnBill: false })
  })
})

describe('the bank decides the day (10/6), bill by bill', () => {
  it('a hand-logged payment matched to a bank line dated the 3rd is on time; undoing the match judges it again without it', async () => {
    const w = await world()
    // Logged by hand on the 9th (late); the bank shows the deposit on the 3rd.
    const b = await bill(w, '2026-09-01', '2026-08-30 05:00', [{ type: 'rent', amount: 495, status: 'settled', method: 'cash', paidAt: '2026-09-09 10:00' }])
    await tx(c => syncBillMarks(c, [b.invoiceId]))
    expect((await live(w.tenantId)).map(m => m.event_type)).toEqual(['payment_received_late_major'])
    const corrections = await tx(c => reRateMarksFromBankDate(c, { paymentIds: b.ids, paidOn: '2026-09-03' }))
    expect(corrections).toHaveLength(1)
    expect(corrections[0]).toMatchObject({ paymentId: b.ids[0], paymentIds: b.ids, invoiceId: b.invoiceId,
      was: 'payment_received_late_major', now: 'payment_received_on_time' })
    expect((await live(w.tenantId)).map(m => m.event_type)).toEqual(['payment_received_on_time'])
    // The match writes its allocation after the marks; the undo runs before reversing it.
    const conn = (await db.query<{ id: string }>(
      `INSERT INTO bank_connections (landlord_id, provider, status) VALUES ($1,'stripe_fc','active') RETURNING id`, [w.landlordId])).rows[0].id
    const txn = (await db.query<{ id: string }>(
      `INSERT INTO bank_transactions (bank_connection_id, landlord_id, external_id, posted_date, amount, description, status)
       VALUES ($1,$2,$3,'2026-09-03',495,'BRANCH DEPOSIT','matched') RETURNING id`, [conn, w.landlordId, randomUUID()])).rows[0].id
    await db.query(`INSERT INTO bank_deposit_allocations (bank_transaction_id, payment_id, landlord_id, amount, effective_paid_date)
                    VALUES ($1,$2,$3,495,'2026-09-03')`, [txn, b.ids[0], w.landlordId])
    // With the allocation on record the nightly run agrees: on time.
    expect((await planBillMarks(db, [b.invoiceId]))[0].action).toBe('none')
    const subjects = await tx(c => undoBankDateMarks(c, corrections))
    expect(subjects).toHaveLength(1)
    expect((await live(w.tenantId)).map(m => m.event_type)).toEqual(['payment_received_late_major'])
  })
})

describe('a late fee deleted in the onboarding month (10/6)', () => {
  it('with no late fee left, the onboarding bill paid late loses its late mark', async () => {
    const w = await world({ existingTenancy: true })
    const b = await bill(w, '2026-09-01', '2026-08-30 05:00', [
      { type: 'rent', amount: 495, status: 'settled', method: 'cash', paidAt: '2026-09-15 10:00' },
      { type: 'late_fee', amount: 25, due: '2026-09-06' },
    ])
    await tx(c => syncBillMarks(c, [b.invoiceId]))
    expect((await live(w.tenantId)).map(m => m.event_type)).toEqual(['payment_received_late_major'])
    await db.query(`UPDATE payments SET status = 'voided', voided_at = NOW(), void_reason = 'deleted' WHERE id = $1`, [b.ids[1]])
    const subjects = await tx(c => reRateMarksWithoutLateFee(c, b.invoiceId))
    expect(subjects).toHaveLength(1)
    expect(await live(w.tenantId)).toEqual([])
  })
})

describe('the nightly run reads only bills that can still change', () => {
  it('a bill paid and marked long ago is not read again; an unmarked or open one is', async () => {
    const w = await world()
    const old = await bill(w, '2026-07-01', '2026-06-28 05:00', [{ type: 'rent', amount: 495, status: 'settled', method: 'cash', paidAt: '2026-07-02 10:00' }])
    const open = await bill(w, '2026-09-01', '2026-08-30 05:00', [{ type: 'rent', amount: 495 }])
    await tx(c => syncBillMarks(c, [old.invoiceId]))
    // Nothing touched it lately (its rows and invoice were written months ago in this fixture).
    await tx(async c => {
      // Back-date the fixture as if written in June (the invoice's own triggers would stamp now).
      await c.query(`SET LOCAL session_replication_role = replica`)
      await c.query(`UPDATE invoices SET updated_at = '2026-07-02', created_at = '2026-06-28' WHERE id = $1`, [old.invoiceId])
      await c.query(`UPDATE payments SET created_at = '2026-06-28' WHERE invoice_id = $1`, [old.invoiceId])
      await c.query(`UPDATE audit_row_changes SET changed_at = '2026-07-02' WHERE table_name = 'payments'`)
    })
    const ids = await billsToReview(db, 72)
    expect(ids).toContain(open.invoiceId)
    expect(ids).not.toContain(old.invoiceId)
  })
})

// ─── 10/12 review ────────────────────────────────────────────────────────────

describe('history imported from another platform never counts (10/12, Nic: "health starts with the first bill GAM wrote")', () => {
  it('an imported row is never a bill, never earns a mark, and never moves the onboarding month', async () => {
    const w = await world({ existingTenancy: true })
    const imp = (await db.query<{ id: string }>(
      `INSERT INTO payments (landlord_id, tenant_id, lease_id, unit_id, type, entry_description, amount, status,
                             due_date, settled_at, notes, import_source, imported_at)
       VALUES ($1,$2,$3,$4,'rent','RENT',495,'settled','2026-07-01','2026-07-01','Imported from buildium.','buildium',NOW())
       RETURNING id`, [w.landlordId, w.tenantId, w.leaseId, w.unitId])).rows[0].id
    // GAM's first bill (August), paid late with no late fee: the onboarding month — good news only.
    const aug = await bill(w, '2026-08-01', '2026-07-25 07:00',
      [{ type: 'rent', amount: 495, status: 'settled', method: 'cash', paidAt: '2026-08-20 10:00' }])
    expect(await isOnboardingMonthCharge(db, aug.ids[0])).toBe(true)
    const [augBill] = await judgeBills(db, [aug.invoiceId], { asOf: AS_OF })
    expect(augBill).toMatchObject({ onboarding: true, mark: null })
    const [impBill] = await judgeBills(db, [`row:${imp}`], { asOf: AS_OF })
    expect(impBill).toMatchObject({ chargedBase: 0, mark: null })
    await syncBillMarksNightly({ asOf: AS_OF })
    expect(await marksOf(w.tenantId)).toEqual([])
  })
})

describe('a bill in dispute is left alone until the dispute is resolved (10/12 review)', () => {
  async function disputedOutstanding() {
    const w = await world()
    const b = await bill(w, '2026-09-01', '2026-08-25 07:00', [{ type: 'rent', amount: 495 }])
    await tx(c => syncBillMarks(c, [b.invoiceId], { asOf: '2026-09-20' }))
    const [m1] = await live(w.tenantId)
    expect(m1.event_type).toBe('payment_skipped')
    const subjectId = (await findSubjectId('tenant', w.tenantId))!
    const d = await openDispute({ disputingSubjectId: subjectId, disputingSubjectType: 'tenant',
      disputingSubjectRefId: w.tenantId, disputedEventId: m1.id, reason: 'factual_inaccuracy' })
    return { w, b, m1, subjectId, d }
  }
  const corrected = (w: World, m1: any, disputeId: string) => ({
    subjectType: 'tenant' as const, subjectRefId: w.tenantId, eventType: 'payment_received_late_minor' as any,
    eventData: { ...m1.event_data, dispute_corrected: true, dispute_id: disputeId }, occurredAt: new Date(m1.occurred_at),
    attestationSource: 'system_derived' as any, attestationEvidence: { dispute_id: disputeId },
    dimensionTags: ['payment_reliability'] as any, networkVisibility: 'visible_to_gam_network' as any,
  })

  it('a payment mid-dispute does not re-judge the bill; the admin\'s correction leaves ONE live mark, and it stays', async () => {
    const { w, b, m1, subjectId, d } = await disputedOutstanding()
    await settle(b.ids[0], '2026-09-25 10:00')
    const [plan] = await planBillMarks(db, [b.invoiceId], { asOf: '2026-09-25' })
    expect(plan.action).toBe('disputed')
    expect(await tx(c => syncBillMarks(c, [b.invoiceId], { asOf: '2026-09-25' }))).toEqual([])
    expect((await live(w.tenantId)).map(m => m.id)).toEqual([m1.id])

    const r = await resolveDispute({ disputeId: d.disputeId, outcome: 'corrected', correctedEvent: corrected(w, m1, d.disputeId),
      supersedeReason: 'correction_after_dispute' })
    expect((await live(w.tenantId)).map(m => m.id)).toEqual([r.correctedEventId])
    expect((await marksOf(w.tenantId)).find(m => m.id === m1.id))
      .toMatchObject({ superseded_by: r.correctedEventId, superseded_reason: 'correction_after_dispute' })
    expect(await tx(c => syncBillMarks(c, [b.invoiceId], { asOf: AS_OF }))).toEqual([])
    expect((await verifyChain(subjectId)).ok).toBe(true)
  })

  it('upheld: the bill is judged again as usual', async () => {
    const { w, b, m1, d } = await disputedOutstanding()
    await settle(b.ids[0], '2026-09-25 10:00')
    await resolveDispute({ disputeId: d.disputeId, outcome: 'upheld' })
    const [change] = await tx(c => syncBillMarks(c, [b.invoiceId], { asOf: AS_OF }))
    expect(change).toMatchObject({ action: 'correct', was: 'payment_skipped' })
    expect((await live(w.tenantId)).map(m => m.event_type)).toEqual([change.now])
    expect((await marksOf(w.tenantId)).find(m => m.id === m1.id)).toMatchObject({ superseded_reason: 'bill_status_changed' })
  })

  it('a mark the ledger already replaced is never superseded again: the admin cannot correct it, and its link stands', async () => {
    const { w, m1, d } = await disputedOutstanding()
    // Replaced before this rule existed (withdrawn: it points at itself).
    expect(await tx(c => supersedeEvent(c, m1.id, m1.id, 'attestation_invalidated'))).toBe(true)
    expect(await tx(c => supersedeEvent(c, m1.id, m1.id, 'bill_status_changed'))).toBe(false)
    await expect(resolveDispute({ disputeId: d.disputeId, outcome: 'corrected', correctedEvent: corrected(w, m1, d.disputeId),
      supersedeReason: 'correction_after_dispute' })).rejects.toThrow(/already replaced/)
    expect((await marksOf(w.tenantId)).find(m => m.id === m1.id))
      .toMatchObject({ superseded_by: m1.id, superseded_reason: 'attestation_invalidated' })
    expect(await live(w.tenantId)).toEqual([])
    expect((await db.query(`SELECT status FROM credit_disputes WHERE id = $1`, [d.disputeId])).rows[0].status).toBe('open')
  })
})

describe('a work-trade month close judges the bill once (10/12 review)', () => {

  it('a month the hours cover in full keeps its one on-time mark — nothing withdrawn, no duplicate', async () => {
    const c = await db.connect()
    let s: { tenantId: string; invoiceId: string }
    try {
      await c.query('BEGIN')
      const { userId, landlordId } = await seedLandlord(c)
      const tenantId = await seedTenant(c)
      const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
      const unitId = await seedUnit(c, { propertyId, landlordId, rentAmount: 500 })
      const leaseId = await seedLease(c, { unitId, landlordId, rentAmount: 500 })
      await seedLeaseTenant(c, { leaseId, tenantId, role: 'primary' })
      const agreementId = (await c.query<{ id: string }>(
        `INSERT INTO work_trade_agreements (unit_id, tenant_id, landlord_id, start_date, status, monthly_hours_target, carry_forward_months, tracks_hours)
         VALUES ($1,$2,$3,'2026-08-01','active',80,1,TRUE) RETURNING id`, [unitId, tenantId, landlordId])).rows[0].id
      const invoiceId = (await c.query<{ id: string }>(
        `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date, subtotal_rent, total_amount, work_trade_agreement_id, late_fee_exempt)
         VALUES ($1,$2,$3,$4,$5,'2026-09-01',500,0,$6,TRUE) RETURNING id`,
        [landlordId, tenantId, leaseId, unitId, `WT-${randomUUID().slice(0, 8)}`, agreementId])).rows[0].id
      await c.query(
        `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, work_trade_suspended_at)
         VALUES ($1,$2,$3,$4,$5,'rent',500,'pending','2026-09-01','RENT',NOW())`, [invoiceId, unitId, leaseId, tenantId, landlordId])
      await c.query(
        `INSERT INTO work_trade_settlements (agreement_id, invoice_id, period_month, target_hours, hour_rate, basis_amount)
         VALUES ($1,$2,'2026-09-01',80,$3,500)`, [agreementId, invoiceId, hourRateFor(500, 80).toFixed(4)])
      await c.query(
        `INSERT INTO work_trade_logs (agreement_id, tenant_id, submitted_by, work_date, hours, description, status)
         VALUES ($1,$2,$3,'2026-09-15',100,'work','approved')`, [agreementId, tenantId, userId])
      await c.query('COMMIT')
      s = { tenantId, invoiceId }
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e } finally { c.release() }
    // The nightly marks the month on time while its hours are still coming in (suspended = covered).
    await syncBillMarksNightly({ asOf: '2026-09-20' })
    expect((await marksOf(s!.tenantId)).map(m => m.event_type)).toEqual(['payment_received_on_time'])
    const r = await runWorkTradeSettlement('2026-09-01')
    expect(r.errors).toEqual([])
    const all = await marksOf(s!.tenantId)
    expect(all.map(m => [m.event_type, m.superseded_by])).toEqual([['payment_received_on_time', null]])
  })
})

describe('the nightly run does not re-read, forever, a bill that can never get a final mark (10/12 review)', () => {
  it('nothing charged on it, an onboarding month closed and not counted, a refund written as a negative fee', async () => {
    const w = await world({ existingTenancy: true })
    const onboarding = await bill(w, '2026-08-01', '2026-07-30 05:00',
      [{ type: 'rent', amount: 495, status: 'settled', method: 'cash', paidAt: '2026-08-20 10:00' }])
    const feeOnly = await bill(w, '2026-09-15', '2026-09-15 05:00', [{ type: 'late_fee', amount: 25 }])
    const open = await bill(w, '2026-09-01', '2026-08-30 05:00', [{ type: 'rent', amount: 495 }])
    const refund = (await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, notes)
       VALUES ($1,$2,$3,'fee',-100,'pending','2026-09-30','OTHERFEE','Deposit refund') RETURNING id`,
      [w.unitId, w.tenantId, w.landlordId])).rows[0].id
    // Nothing touched them lately.
    await tx(async c => {
      await c.query(`SET LOCAL session_replication_role = replica`)
      await c.query(`UPDATE invoices SET updated_at = '2026-09-01', created_at = '2026-08-01' WHERE tenant_id = $1`, [w.tenantId])
      await c.query(`UPDATE payments SET created_at = '2026-08-01', settled_at = CASE WHEN settled_at IS NULL THEN NULL ELSE '2026-08-20'::timestamptz END
                      WHERE tenant_id = $1`, [w.tenantId])
      await c.query(`UPDATE audit_row_changes SET changed_at = '2026-08-20' WHERE table_name = 'payments'`)
    })
    const ids = await billsToReview(db, 72)
    expect(ids).toContain(open.invoiceId)
    expect(ids).not.toContain(onboarding.invoiceId)
    expect(ids).not.toContain(feeOnly.invoiceId)
    expect(ids).not.toContain(`row:${refund}`)
  })
})

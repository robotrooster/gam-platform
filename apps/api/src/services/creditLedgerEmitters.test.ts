/**
 * S447 services-audit slice 23 (multi-session arc 1/2-3) —
 * creditLedgerEmitters.ts WORKFLOW emitters.
 *
 * The file holds 21 emitters total. This first slice covers the
 * 12 that fire from workflow triggers (payments, lease, inspection,
 * entry-request, maintenance) — small, deterministic wrappers
 * around appendEvent. Caller-detector emitters (system_derived
 * attestation: tenancy_ended_with_balance, balance_paid_post_move,
 * lease_anniversary, recurring_repair, habitability_unresolved_30d,
 * multi_landlord_history_clean) defer to S448 along with their
 * cron-detector context.
 *
 * Strategy: appendEvent runs LIVE against the real chain — no
 * mocks. For each emitter, we pin event_type, dimension_tags,
 * network_visibility, attestation_source, attestation_evidence
 * presence, and the structurally-important event_data fields.
 *
 * Coverage:
 *   - classifyPaymentTier (pure tier-classifier)
 *   - emitPaymentSettledEvent — 5 tier branches + visibility split
 *   - emitPaymentFailedEvent  — single event shape
 *   - emitLeaseSignedTenant  / emitLeaseSignedLandlord — per-tenant
 *     fanout, single landlord event, shared dimension tags
 *   - emitInspectionFinalizedEvents — move-in (3 sub-events) /
 *     move-out (3 sub-events) / periodic early return
 *   - emitLeaseTerminatedNaturalEvents — per-tenant fanout +
 *     landlord (visibility differs across subjects)
 *   - emitLeaseRenewedEvents — per-tenant + landlord
 *   - emitEntryRequestResponseEvents — granted-in-time / granted-late
 *     (no event) / denied
 *   - emitEntryRecordedEvents — compliant (within window + granted) /
 *     breach (outside window OR not granted)
 *   - classifyMaintenanceTier (pure)
 *   - emitMaintenanceResolvedEvents — 4 response-tier branches
 *     with visibility flip on breach
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { PoolClient } from 'pg'
import { randomUUID } from 'crypto'
import { db } from '../db'
import {
  classifyPaymentTier,
  classifyMaintenanceTier,
  emitPaymentSettledEvent,
  emitPaymentFailedEvent,
  emitLeaseSignedTenant,
  emitLeaseSignedLandlord,
  emitInspectionFinalizedEvents,
  emitLeaseTerminatedNaturalEvents,
  emitLeaseRenewedEvents,
  emitEntryRequestResponseEvents,
  emitEntryRecordedEvents,
  emitMaintenanceResolvedEvents,
  emitTenancyEndedWithBalanceEvent,
  emitBalancePaidPostMoveEvent,
  emitLeaseAnniversaryEvent,
  emitRecurringRepairEvent,
  emitHabitabilityUnresolvedEvent,
  emitMultiLandlordHistoryCleanEvent,
  correctLateMarksForBillsWrittenLate,
} from './creditLedgerEmitters'
import { appendEvent, verifyChain } from './creditLedger'
import type { CreditEventType } from '@gam/shared'

// The score recompute a late-mark correction runs needs the published formula,
// which the schema-only test database does not carry; record the call instead.
const { recomputeMock } = vi.hoisted(() => ({ recomputeMock: vi.fn(async (_subjectId: string) => ({})) }))
vi.mock('./creditScore', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  recomputeAndSnapshot: recomputeMock,
}))
import {
  cleanupAllSchema,
  seedLandlord, seedTenant, seedProperty, seedUnit, seedLease, seedLeaseTenant, seedRentPayment,
} from '../test/dbHelpers'
import { settleManualRentPayment } from './manualPaymentSettle'
import { logger } from '../lib/logger'

beforeEach(async () => {
  await cleanupAllSchema()
  recomputeMock.mockClear()
})

// S652 (Nic): "don't count the onboarding month for anything negative, only
// positive." The onboarding month is the month of the first rent charge on an
// existing-tenancy lease.
describe('onboarding month is never negative', () => {
  async function seedOnboarded() {
    const { seedLandlord, seedProperty, seedUnit, seedTenant, seedLease } = await import('../test/dbHelpers')
    const c = await db.connect()
    try {
      const { userId, landlordId } = await seedLandlord(c)
      const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
      const unitId = await seedUnit(c, { propertyId, landlordId })
      const tenantId = await seedTenant(c)
      const leaseId = await seedLease(c, { unitId, landlordId, startDate: '2024-03-01' })
      await c.query(`UPDATE leases SET is_existing_tenancy = TRUE WHERE id = $1`, [leaseId])
      // Written a week before each due date, as the bill run does.
      const pay = async (due: string) => (await c.query<{ id: string }>(
        `INSERT INTO payments (unit_id, tenant_id, landlord_id, lease_id, type, amount, status, entry_description, due_date, created_at)
         VALUES ($1,$2,$3,$4,'rent',900,'settled','RENT',$5,$5::date - 7) RETURNING id`, [unitId, tenantId, landlordId, leaseId, due])).rows[0].id
      return { tenantId, first: await pay('2026-09-01'), second: await pay('2026-10-01') }
    } finally { c.release() }
  }
  const eventsFor = async (tenantId: string) => (await db.query<any>(
    `SELECT ce.event_type FROM credit_events ce JOIN credit_subjects cs ON cs.id = ce.subject_id
      WHERE cs.subject_type='tenant' AND cs.subject_ref_id=$1 ORDER BY ce.recorded_at`, [tenantId])).rows.map(r => r.event_type)

  it('a late payment in the onboarding month writes nothing; on time writes a good mark', async () => {
    const s = await seedOnboarded()
    await withTx(c => emitPaymentSettledEvent(c, {
      tenantId: s.tenantId, paymentId: s.first, paymentType: 'rent', amount: '900',
      dueDate: new Date('2026-09-01T00:00:00Z'), settledAt: new Date('2026-09-28T00:00:00Z'), graceDays: 5, stripePaymentIntentId: null,
    }))
    expect(await eventsFor(s.tenantId)).toEqual([])
    await withTx(c => emitPaymentSettledEvent(c, {
      tenantId: s.tenantId, paymentId: s.first, paymentType: 'rent', amount: '900',
      dueDate: new Date('2026-09-01T00:00:00Z'), settledAt: new Date('2026-09-01T12:00:00Z'), graceDays: 5, stripePaymentIntentId: null,
    }))
    expect(await eventsFor(s.tenantId)).toEqual(['payment_received_on_time'])
  })

  it('the month after onboarding is scored normally', async () => {
    const s = await seedOnboarded()
    await withTx(c => emitPaymentSettledEvent(c, {
      tenantId: s.tenantId, paymentId: s.second, paymentType: 'rent', amount: '900',
      dueDate: new Date('2026-10-01T00:00:00Z'), settledAt: new Date('2026-10-28T00:00:00Z'), graceDays: 5, stripePaymentIntentId: null,
    }))
    expect(await eventsFor(s.tenantId)).toEqual(['payment_received_late_severe'])
  })
})

/**
 * Run a function inside a transaction, passing the PoolClient through.
 * Emitters require a PoolClient (the workflow's transaction); in tests
 * we own the BEGIN/COMMIT and just hand the client through.
 */
async function withTx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await db.connect()
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

/** Read the (single) event for a given subject. Asserts uniqueness. */
async function readSoleEvent(
  subjectType: 'tenant' | 'landlord',
  subjectRefId: string,
): Promise<any> {
  const { rows } = await db.query<any>(
    `SELECT e.*
       FROM credit_events e
       JOIN credit_subjects s ON s.id = e.subject_id
      WHERE s.subject_type = $1 AND s.subject_ref_id = $2`,
    [subjectType, subjectRefId])
  expect(rows).toHaveLength(1)
  return rows[0]
}

/** Read all events for a subject, ordered by recorded_at then id. */
async function readAllEvents(
  subjectType: 'tenant' | 'landlord',
  subjectRefId: string,
): Promise<any[]> {
  const { rows } = await db.query<any>(
    `SELECT e.*
       FROM credit_events e
       JOIN credit_subjects s ON s.id = e.subject_id
      WHERE s.subject_type = $1 AND s.subject_ref_id = $2
      ORDER BY e.recorded_at ASC, e.id ASC`,
    [subjectType, subjectRefId])
  return rows
}

// ─── classifyPaymentTier (pure) ────────────────────────────────

describe('classifyPaymentTier', () => {
  const due = new Date('2026-06-01T00:00:00Z')
  it('settled before due-EOD → on_time', () => {
    expect(classifyPaymentTier({
      dueDate: due,
      settledAt: new Date('2026-06-01T20:00:00Z'),
      graceDays: 5,
    })).toBe('payment_received_on_time')
  })
  it('settled after due-EOD but within grace → late_grace', () => {
    expect(classifyPaymentTier({
      dueDate: due,
      settledAt: new Date('2026-06-04T12:00:00Z'),
      graceDays: 5,
    })).toBe('payment_received_late_grace')
  })
  it('≤72h past grace-end → late_minor', () => {
    expect(classifyPaymentTier({
      dueDate: due,
      settledAt: new Date('2026-06-08T00:00:00Z'),  // 0.000... h past grace-end
      graceDays: 5,
    })).toBe('payment_received_late_minor')
  })
  it('72h–15d past grace-end → late_major', () => {
    expect(classifyPaymentTier({
      dueDate: due,
      settledAt: new Date('2026-06-12T00:00:00Z'),  // ~4d past grace-end
      graceDays: 5,
    })).toBe('payment_received_late_major')
  })
  it('>15d past grace-end → late_severe', () => {
    expect(classifyPaymentTier({
      dueDate: due,
      settledAt: new Date('2026-06-25T00:00:00Z'),  // ~17d past grace-end
      graceDays: 5,
    })).toBe('payment_received_late_severe')
  })
})

// S654: the tier compares calendar days where the property is. The due day
// used to end at 23:59:59 UTC (4:59 pm Phoenix), so rent paid that evening
// was recorded one tier late.
describe('classifyPaymentTier — the property calendar decides the day (S654)', () => {
  it('rent due Oct 1, paid 6:30 pm Oct 1 in Phoenix → on time', () => {
    expect(classifyPaymentTier({
      dueDate: '2026-10-01',
      settledAt: new Date('2026-10-02T01:30:00Z'),   // 6:30 pm Oct 1 Phoenix
      graceDays: 5,
      propertyTz: 'America/Phoenix',
    })).toBe('payment_received_on_time')
  })

  it('a Date due date (node-pg local midnight) reads the same day', () => {
    expect(classifyPaymentTier({
      dueDate: new Date('2026-10-01T07:00:00Z'),     // Oct 1 00:00 Phoenix
      settledAt: new Date('2026-10-02T01:30:00Z'),
      graceDays: 5,
    })).toBe('payment_received_on_time')
  })

  it('paid the evening of the last grace day → still within grace', () => {
    expect(classifyPaymentTier({
      dueDate: '2026-10-01',
      settledAt: new Date('2026-10-07T05:00:00Z'),   // 10 pm Oct 6 Phoenix
      graceDays: 5,
    })).toBe('payment_received_late_grace')
  })

  it('uses the property zone, not Phoenix, when one is given', () => {
    const settledAt = new Date('2026-10-02T05:30:00Z') // 10:30 pm Oct 1 Phoenix, 1:30 am Oct 2 New York
    expect(classifyPaymentTier({ dueDate: '2026-10-01', settledAt, graceDays: 5, propertyTz: 'America/Phoenix' }))
      .toBe('payment_received_on_time')
    expect(classifyPaymentTier({ dueDate: '2026-10-01', settledAt, graceDays: 5, propertyTz: 'America/New_York' }))
      .toBe('payment_received_late_grace')
  })

  it('an unrecognized zone reads on Phoenix and does not throw (settle must not roll back)', () => {
    expect(() => classifyPaymentTier({
      dueDate: '2026-10-01', settledAt: new Date('2026-10-02T01:30:00Z'), graceDays: 5, propertyTz: 'Arizona',
    })).not.toThrow()
    expect(classifyPaymentTier({
      dueDate: '2026-10-01',
      settledAt: new Date('2026-10-02T01:30:00Z'),   // 6:30 pm Oct 1 Phoenix
      graceDays: 5,
      propertyTz: 'Arizona',
    })).toBe('payment_received_on_time')
  })

  // S654: the fallback must not be silent — the bad zone is logged so it gets fixed.
  it('an unrecognized zone logs a warning naming the zone; a good zone logs nothing', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation((() => undefined) as any)
    try {
      classifyPaymentTier({
        dueDate: '2026-10-01', settledAt: new Date('2026-10-02T01:30:00Z'), graceDays: 5, propertyTz: 'America/Phoenix',
      })
      expect(warn).not.toHaveBeenCalled()
      classifyPaymentTier({
        dueDate: '2026-10-01', settledAt: new Date('2026-10-02T01:30:00Z'), graceDays: 5, propertyTz: 'Arizona',
      })
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn.mock.calls[0][0]).toEqual({ propertyTz: 'Arizona' })
    } finally { warn.mockRestore() }
  })

  it('emitPaymentSettledEvent with an unrecognized zone still records the event', async () => {
    const tenantId = randomUUID()
    await withTx(c => emitPaymentSettledEvent(c, {
      tenantId, paymentId: randomUUID(), paymentType: 'rent', amount: '1000',
      dueDate: '2026-10-01', settledAt: new Date('2026-10-02T01:30:00Z'),
      graceDays: 5, stripePaymentIntentId: null, propertyTz: 'Arizona',
    }))
    const e = await readSoleEvent('tenant', tenantId)
    expect(e.event_type).toBe('payment_received_on_time')
  })

  // S654: the desk (cash/check) settle classified with a Date due date and no
  // zone, so it always read Phoenix's calendar. It now passes the due day as
  // text and the property's zone, as the Stripe webhook does.
  it('a desk cash settle reads the property\'s calendar, not Phoenix\'s', async () => {
    const c = await db.connect()
    let tenantId = ''
    try {
      await c.query('BEGIN')
      const { userId, landlordId } = await seedLandlord(c)
      tenantId = await seedTenant(c)
      const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
      await c.query(`UPDATE properties SET timezone = 'America/New_York' WHERE id = $1`, [propertyId])
      const unitId = await seedUnit(c, { propertyId, landlordId })
      const leaseId = await seedLease(c, { unitId, landlordId })
      await seedLeaseTenant(c, { leaseId, tenantId })
      await c.query(`UPDATE leases SET late_fee_grace_days = 5 WHERE id = $1`, [leaseId])
      const paymentId = await seedRentPayment(c, { unitId, tenantId, landlordId, amount: 1000, status: 'pending' })
      await c.query(`UPDATE payments SET lease_id = $2, due_date = DATE '2026-10-01', created_at = '2026-09-25T17:00:00Z' WHERE id = $1`, [paymentId, leaseId])
      await settleManualRentPayment(c, {
        payment: {
          id: paymentId, landlord_id: landlordId, tenant_id: tenantId, unit_id: unitId,
          lease_id: leaseId, due_date: '2026-10-01',
        },
        method: 'cash',
        // 1:30 am Oct 2 in New York (10:30 pm Oct 1 in Phoenix).
        settledAt: new Date('2026-10-02T05:30:00Z'),
      })
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e }
    finally { c.release() }

    const e = await readSoleEvent('tenant', tenantId)
    expect(e.event_type).toBe('payment_received_late_grace')
    expect(e.event_data.due_date).toBe('2026-10-01')
    expect(e.attestation_source).toBe('landlord_self_reported_with_evidence')
  })

  it('late tiers count whole days past the last grace day', () => {
    const tier = (paidPhoenixEvening: string) => classifyPaymentTier({
      dueDate: '2026-10-01', graceDays: 5, propertyTz: 'America/Phoenix',
      // 7 pm Phoenix on the given day is 02:00Z the next day.
      settledAt: new Date(Date.parse(`${paidPhoenixEvening}T19:00:00-07:00`)),
    })
    expect(tier('2026-10-09')).toBe('payment_received_late_minor')   // 3 days past Oct 6
    expect(tier('2026-10-10')).toBe('payment_received_late_major')   // 4 days
    expect(tier('2026-10-21')).toBe('payment_received_late_major')   // 15 days
    expect(tier('2026-10-22')).toBe('payment_received_late_severe')  // 16 days
  })

  it('emitPaymentSettledEvent records the evening payment on time, with the due day as a date', async () => {
    const tenantId = randomUUID()
    await withTx(c => emitPaymentSettledEvent(c, {
      tenantId, paymentId: randomUUID(), paymentType: 'rent', amount: '1000',
      dueDate: '2026-10-01', settledAt: new Date('2026-10-02T01:30:00Z'),
      graceDays: 5, stripePaymentIntentId: null, propertyTz: 'America/Phoenix',
    }))
    const e = await readSoleEvent('tenant', tenantId)
    expect(e.event_type).toBe('payment_received_on_time')
    expect(e.network_visibility).toBe('visible_to_current_landlord')
    expect(e.event_data.due_date).toBe('2026-10-01')
  })

  it('emitPaymentFailedEvent records the due day as a date', async () => {
    const tenantId = randomUUID()
    await withTx(c => emitPaymentFailedEvent(c, {
      tenantId, paymentId: randomUUID(), paymentType: 'rent', amount: '1000',
      dueDate: '2026-10-01', failedAt: new Date('2026-10-02T01:30:00Z'),
      stripePaymentIntentId: null, failureCode: 'R01', failureMessage: null,
    }))
    const e = await readSoleEvent('tenant', tenantId)
    expect(e.event_data.due_date).toBe('2026-10-01')
  })
})

// A bill cannot be late before GAM writes it. A longer stay's rent
// (bookingLeaseBilling billLongerStay) is written the day the stay grows but
// carries its month's own due date; the mark counts from the later of the two.
describe('a bill written after its due date is rated from the day it was written', () => {
  async function seedStay() {
    const c = await db.connect()
    try {
      const { userId, landlordId } = await seedLandlord(c)
      const tenantId = await seedTenant(c)
      const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
      await c.query(`UPDATE properties SET timezone = 'America/Phoenix' WHERE id = $1`, [propertyId])
      const unitId = await seedUnit(c, { propertyId, landlordId })
      const leaseId = await seedLease(c, { unitId, landlordId, startDate: '2026-08-10' })
      await seedLeaseTenant(c, { leaseId, tenantId })
      await c.query(`UPDATE leases SET late_fee_grace_days = 5 WHERE id = $1`, [leaseId])
      return { landlordId, tenantId, unitId, leaseId }
    } finally { c.release() }
  }
  type Stay = Awaited<ReturnType<typeof seedStay>>
  /** A rent row as GAM wrote it: `writtenAt` is its created_at. */
  const bill = async (s: Stay, b: {
    due: string; writtenAt: string; amount: number; notes: string
    isRemainder?: boolean; status?: string; reversalId?: string | null
  }) => (await db.query<{ id: string }>(
    `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date,
                           entry_description, notes, is_remainder, revenue_owner, created_at, reversal_id)
     VALUES ($1,$2,$3,$4,'rent',$5,$6,$7::date,'RENT',$8,$9,'landlord',$10::timestamptz,$11) RETURNING id`,
    [s.unitId, s.leaseId, s.tenantId, s.landlordId, b.amount, b.status ?? 'pending', b.due, b.notes,
     b.isRemainder ?? false, b.writtenAt, b.reversalId ?? null])).rows[0].id
  /** Cash at the desk for that one row, at `at`. */
  const payAtDesk = (s: Stay, paymentId: string, due: string, at: string) => withTx(c => settleManualRentPayment(c, {
    payment: { id: paymentId, landlord_id: s.landlordId, tenant_id: s.tenantId, unit_id: s.unitId, lease_id: s.leaseId, due_date: due },
    method: 'cash', settledAt: new Date(at),
  }))
  /** Settled through the shared settle hook as a Stripe payment, at `at`. */
  const payOnline = async (paymentId: string, at: string) => {
    const { afterRowsSettled } = await import('./settleHooks')
    await withTx(async c => {
      await c.query(`UPDATE payments SET status = 'settled', settled_at = $2::timestamptz WHERE id = $1`, [paymentId, at])
      await afterRowsSettled(c, [paymentId], { attestationSource: 'stripe_attested', receipt: null })
    })
  }
  const markOf = async (s: Stay) => {
    const all = await readAllEvents('tenant', s.tenantId)
    expect(all).toHaveLength(1)
    return all[0]
  }

  it('a longer-stay bill paid the day it is billed is on time on the credit record (the rest of the month)', async () => {
    const s = await seedStay()
    // The stay grew on Oct 10 (10 am Phoenix): the rest of October, due Oct 1.
    const id = await bill(s, {
      due: '2026-10-01', writtenAt: '2026-10-10T17:00:00Z', amount: 520.97, isRemainder: true,
      notes: 'Stay now ends November 1, 2026: the rest of October 2026',
    })
    await payAtDesk(s, id, '2026-10-01', '2026-10-10T22:00:00Z')   // 3 pm the same day
    const e = await markOf(s)
    expect(e.event_type).toBe('payment_received_on_time')
    expect(e.network_visibility).toBe('visible_to_current_landlord')
    expect(e.event_data.due_date).toBe('2026-10-01')
    expect(e.event_data.billed_on).toBe('2026-10-10')
  })

  it('a longer-stay bill paid the day it is billed is on time on the credit record (a whole month written after the catch-up window)', async () => {
    const s = await seedStay()
    // November was added on Dec 10, more than 30 days after its due date.
    const id = await bill(s, {
      due: '2026-11-01', writtenAt: '2026-12-10T17:00:00Z', amount: 950,
      notes: 'Stay now ends January 1, 2027: rent for November 2026',
    })
    await payOnline(id, '2026-12-10T22:00:00Z')
    const e = await markOf(s)
    expect(e.event_type).toBe('payment_received_on_time')
    expect(e.attestation_source).toBe('stripe_attested')
    expect(e.event_data.due_date).toBe('2026-11-01')
    expect(e.event_data.billed_on).toBe('2026-12-10')
  })

  it('a longer-stay bill gets its grace days from the day it was written', async () => {
    const s = await seedStay()
    const id = await bill(s, {
      due: '2026-10-01', writtenAt: '2026-10-10T17:00:00Z', amount: 520.97, isRemainder: true,
      notes: 'Stay now ends November 1, 2026: the rest of October 2026',
    })
    await payAtDesk(s, id, '2026-10-01', '2026-10-14T22:00:00Z')   // 4 days after it was written
    expect((await markOf(s)).event_type).toBe('payment_received_late_grace')
  })

  it('a longer-stay bill paid well after it was written is still late', async () => {
    const s = await seedStay()
    const id = await bill(s, {
      due: '2026-10-01', writtenAt: '2026-10-10T17:00:00Z', amount: 520.97, isRemainder: true,
      notes: 'Stay now ends November 1, 2026: the rest of October 2026',
    })
    // Grace ends Oct 15 (5 days from Oct 10); Oct 25 is 10 days past it.
    await payAtDesk(s, id, '2026-10-01', '2026-10-25T22:00:00Z')
    const e = await markOf(s)
    expect(e.event_type).toBe('payment_received_late_major')
    expect(e.network_visibility).toBe('visible_to_gam_network')
  })

  it('a bill written before its due date and paid late is still late, counted from the due date', async () => {
    const s = await seedStay()
    const id = await bill(s, { due: '2026-10-01', writtenAt: '2026-09-25T17:00:00Z', amount: 950, notes: 'October rent' })
    // Grace ends Oct 6; Oct 10 is 4 days past it.
    await payAtDesk(s, id, '2026-10-01', '2026-10-10T22:00:00Z')
    const e = await markOf(s)
    expect(e.event_type).toBe('payment_received_late_major')
    expect(e.event_data.billed_on).toBeUndefined()
  })

  it('a payment recorded on a bill written after the money arrived is rated from its due date', async () => {
    const s = await seedStay()
    // History written up later: March's rent, paid March 21, is recorded on a
    // row GAM wrote on Oct 3. The row records an older bill; the money came in
    // 20 days after the due date, so the payment is late.
    const id = await bill(s, { due: '2026-03-01', writtenAt: '2026-10-03T17:00:00Z', amount: 950, notes: 'March rent' })
    await withTx(c => emitPaymentSettledEvent(c, {
      tenantId: s.tenantId, paymentId: id, paymentType: 'rent', amount: '950',
      dueDate: '2026-03-01', settledAt: new Date('2026-03-21T19:00:00Z'), graceDays: 5,
      stripePaymentIntentId: null, propertyTz: 'America/Phoenix',
    }))
    const e = await markOf(s)
    // Grace ends March 6; March 21 is 15 days past it.
    expect(e.event_type).toBe('payment_received_late_major')
    expect(e.network_visibility).toBe('visible_to_gam_network')
    expect(e.event_data.due_date).toBe('2026-03-01')
    expect(e.event_data.billed_on).toBeUndefined()
  })

  it('a bill written on the day its money came in still counts from the day it was written', async () => {
    const s = await seedStay()
    // Written at 10 am, paid at 3 pm the same day: the day it was written is
    // not after the day it was paid.
    const id = await bill(s, {
      due: '2026-10-01', writtenAt: '2026-10-10T17:00:00Z', amount: 520.97, isRemainder: true,
      notes: 'Stay now ends November 1, 2026: the rest of October 2026',
    })
    await withTx(c => emitPaymentSettledEvent(c, {
      tenantId: s.tenantId, paymentId: id, paymentType: 'rent', amount: '520.97',
      dueDate: '2026-10-01', settledAt: new Date('2026-10-10T22:00:00Z'), graceDays: 5,
      stripePaymentIntentId: null, propertyTz: 'America/Phoenix',
    }))
    const e = await markOf(s)
    expect(e.event_type).toBe('payment_received_on_time')
    expect(e.event_data.billed_on).toBe('2026-10-10')
  })

  it('the rest of a part-paid old bill counts from that bill, not from the day it was split off', async () => {
    const s = await seedStay()
    // October's bill (written Sep 25) was paid down at the desk on Nov 5; the
    // rest went on its own row that day and was paid the same day.
    await bill(s, {
      due: '2026-10-01', writtenAt: '2026-09-25T17:00:00Z', amount: 500, status: 'settled',
      notes: 'October rent — partly paid toward the old balance; $450.00 remains on a separate row',
    })
    const rest = await bill(s, {
      due: '2026-10-01', writtenAt: '2026-11-05T17:00:00Z', amount: 450, isRemainder: true,
      notes: 'What is left of the old balance after a part payment',
    })
    await payAtDesk(s, rest, '2026-10-01', '2026-11-05T22:00:00Z')
    const e = await markOf(s)
    expect(e.event_type).toBe('payment_received_late_severe')
    expect(e.event_data.billed_on).toBeUndefined()
  })

  it('only rent and utility rows carry a payment mark: a late fee or a home payment writes nothing', async () => {
    const s = await seedStay()
    for (const [type, entry] of [['late_fee', 'LATEFEE'], ['home_payment', 'HOMEPMT']] as const) {
      const id = (await db.query<{ id: string }>(
        `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
         VALUES ($1,$2,$3,$4,$5,50,'settled','2026-10-01',$6) RETURNING id`,
        [s.unitId, s.leaseId, s.tenantId, s.landlordId, type, entry])).rows[0].id
      await withTx(c => emitPaymentSettledEvent(c, {
        tenantId: s.tenantId, paymentId: id, paymentType: 'rent', amount: '50',
        dueDate: '2026-10-01', settledAt: new Date('2026-10-20T22:00:00Z'), graceDays: 5,
        stripePaymentIntentId: 'pi_beside_rent', propertyTz: 'America/Phoenix',
      }))
    }
    expect(await readAllEvents('tenant', s.tenantId)).toHaveLength(0)
  })

  it('a row reopened after a reversal counts from the bill it reopens', async () => {
    const s = await seedStay()
    const original = await bill(s, {
      due: '2026-10-01', writtenAt: '2026-09-25T17:00:00Z', amount: 950, status: 'returned', notes: 'October rent',
    })
    const rev = (await db.query<{ id: string }>(
      `INSERT INTO payment_reversals (payment_id, landlord_id, tenant_id, lease_id, reversal_type, reversed_amount,
                                      stripe_event_id, raw_event)
       VALUES ($1,$2,$3,$4,'ach_return',950,$5,'{}'::jsonb) RETURNING id`,
      [original, s.landlordId, s.tenantId, s.leaseId, `evt_${randomUUID()}`])).rows[0].id
    const reopened = await bill(s, {
      due: '2026-10-01', writtenAt: '2026-11-05T17:00:00Z', amount: 950,
      notes: 'Reopened after payment reversal', reversalId: rev,
    })
    await withTx(c => emitPaymentSettledEvent(c, {
      tenantId: s.tenantId, paymentId: reopened, paymentType: 'rent', amount: '950',
      dueDate: '2026-10-01', settledAt: new Date('2026-11-05T22:00:00Z'), graceDays: 5,
      stripePaymentIntentId: null, propertyTz: 'America/Phoenix',
    }))
    expect((await markOf(s)).event_type).toBe('payment_received_late_severe')
  })

  // ── Marks written before the rule: corrected once, at deploy ──────────────

  /** A late mark as the emitter wrote it before it read the day the bill was written. */
  const oldMark = (s: Stay, paymentId: string, m: { tier: CreditEventType; due: string; paidAt: string }) =>
    appendEvent({
      subjectType: 'tenant', subjectRefId: s.tenantId, eventType: m.tier,
      eventData: {
        payment_id: paymentId, payment_type: 'rent', amount: '520.97',
        due_date: m.due, paid_at: new Date(m.paidAt).toISOString(), grace_days: 5,
      },
      occurredAt: new Date(m.paidAt),
      attestationSource: 'stripe_attested',
      attestationEvidence: { stripe_payment_intent_id: 'pi_before_the_rule' },
      dimensionTags: ['payment_reliability'],
      networkVisibility: 'visible_to_gam_network',
    })
  /** The rest of October, written Oct 10 (10 am Phoenix), due Oct 1. */
  const restOfOctober = (s: Stay) => bill(s, {
    due: '2026-10-01', writtenAt: '2026-10-10T17:00:00Z', amount: 520.97, isRemainder: true, status: 'settled',
    notes: 'Stay now ends November 1, 2026: the rest of October 2026',
  })

  it('a late mark written before the rule, on a bill paid the day it was written, is replaced by an on-time mark that names the day it was billed', async () => {
    const s = await seedStay()
    const id = await restOfOctober(s)
    const old = await oldMark(s, id, { tier: 'payment_received_late_major', due: '2026-10-01', paidAt: '2026-10-10T22:00:00Z' })

    const fixed = await correctLateMarksForBillsWrittenLate({ dryRun: false })

    expect(fixed).toEqual([{
      eventId: old.eventId, correctedEventId: expect.any(String), tenantId: s.tenantId, paymentId: id,
      dueDate: '2026-10-01', billedOn: '2026-10-10',
      was: 'payment_received_late_major', now: 'payment_received_on_time',
    }])
    const [before, after] = await readAllEvents('tenant', s.tenantId)
    // The late mark stays in the chain, superseded, so scores skip it.
    expect(before.id).toBe(old.eventId)
    expect(before.superseded_by).toBe(after.id)
    expect(before.superseded_reason).toBe('data_entry_error_corrected')
    // The good mark the current landlord sees, for the same payment and time.
    expect(after.event_type).toBe('payment_received_on_time')
    expect(after.network_visibility).toBe('visible_to_current_landlord')
    expect(after.superseded_by).toBeNull()
    expect(after.event_data).toMatchObject({
      payment_id: id, due_date: '2026-10-01', billed_on: '2026-10-10',
      paid_at: '2026-10-10T22:00:00.000Z', grace_days: 5, corrects_event_id: old.eventId,
    })
    expect(new Date(after.occurred_at).toISOString()).toBe('2026-10-10T22:00:00.000Z')
    expect(after.attestation_source).toBe('stripe_attested')
    expect(after.attestation_evidence).toEqual({ stripe_payment_intent_id: 'pi_before_the_rule' })
    // Appended, never rewritten: the hash chain still checks out.
    expect((await verifyChain(old.subjectId)).ok).toBe(true)
    // The tenant's score is worked out again without the late mark.
    expect(recomputeMock.mock.calls).toEqual([[old.subjectId]])
  })

  it('a dry run of the late-mark correction lists what it would change and changes nothing', async () => {
    const s = await seedStay()
    const id = await restOfOctober(s)
    const old = await oldMark(s, id, { tier: 'payment_received_late_major', due: '2026-10-01', paidAt: '2026-10-14T22:00:00Z' })

    const listed = await correctLateMarksForBillsWrittenLate({ dryRun: true })

    // Paid four days after it was written: within grace, counted from that day.
    expect(listed).toEqual([expect.objectContaining({
      eventId: old.eventId, correctedEventId: null, now: 'payment_received_late_grace',
    })])
    const all = await readAllEvents('tenant', s.tenantId)
    expect(all).toHaveLength(1)
    expect(all[0].superseded_by).toBeNull()
    expect(recomputeMock).not.toHaveBeenCalled()
  })

  it('a late mark still late when counted from the day the bill was written is left as it is', async () => {
    const s = await seedStay()
    const id = await restOfOctober(s)
    // Grace ends Oct 15 (5 days from Oct 10); Oct 25 is 10 days past it: late_major either way.
    await oldMark(s, id, { tier: 'payment_received_late_major', due: '2026-10-01', paidAt: '2026-10-25T22:00:00Z' })
    expect(await correctLateMarksForBillsWrittenLate({ dryRun: false })).toEqual([])
    const all = await readAllEvents('tenant', s.tenantId)
    expect(all).toHaveLength(1)
    expect(all[0].superseded_by).toBeNull()
  })

  it('a late mark on a row written after its money came in is left as it is', async () => {
    const s = await seedStay()
    // March's rent, paid March 21, written up on a row GAM wrote on Oct 3.
    const id = await bill(s, { due: '2026-03-01', writtenAt: '2026-10-03T17:00:00Z', amount: 950, status: 'settled', notes: 'March rent' })
    await oldMark(s, id, { tier: 'payment_received_late_major', due: '2026-03-01', paidAt: '2026-03-21T19:00:00Z' })
    expect(await correctLateMarksForBillsWrittenLate({ dryRun: false })).toEqual([])
    const all = await readAllEvents('tenant', s.tenantId)
    expect(all).toHaveLength(1)
    expect(all[0].superseded_by).toBeNull()
  })

  it('a late mark on a bill written before its due date is left as it is', async () => {
    const s = await seedStay()
    const id = await bill(s, { due: '2026-10-01', writtenAt: '2026-09-25T17:00:00Z', amount: 950, status: 'settled', notes: 'October rent' })
    await oldMark(s, id, { tier: 'payment_received_late_major', due: '2026-10-01', paidAt: '2026-10-10T22:00:00Z' })
    expect(await correctLateMarksForBillsWrittenLate({ dryRun: false })).toEqual([])
    expect((await readAllEvents('tenant', s.tenantId))[0].superseded_by).toBeNull()
  })

  it('a late mark that is less late counted from the day the bill was written is replaced by the lesser late mark', async () => {
    const s = await seedStay()
    const id = await restOfOctober(s)
    // Paid Oct 17: 11 days past grace from the due date, 2 days past grace from Oct 10.
    const old = await oldMark(s, id, { tier: 'payment_received_late_major', due: '2026-10-01', paidAt: '2026-10-17T22:00:00Z' })
    expect(await correctLateMarksForBillsWrittenLate({ dryRun: false })).toEqual([
      expect.objectContaining({ eventId: old.eventId, was: 'payment_received_late_major', now: 'payment_received_late_minor' }),
    ])
    const [, after] = await readAllEvents('tenant', s.tenantId)
    expect(after.event_type).toBe('payment_received_late_minor')
    expect(after.network_visibility).toBe('visible_to_gam_network')
  })

  it('a late mark in the onboarding month that is still late counted from the day the bill was written is never replaced by another late mark', async () => {
    const s = await seedStay()
    // The household moved onto GAM mid-tenancy: this is its first rent month.
    await db.query(`UPDATE leases SET is_existing_tenancy = TRUE WHERE id = $1`, [s.leaseId])
    const id = await restOfOctober(s)
    await oldMark(s, id, { tier: 'payment_received_late_major', due: '2026-10-01', paidAt: '2026-10-17T22:00:00Z' })
    expect(await correctLateMarksForBillsWrittenLate({ dryRun: false })).toEqual([])
    const all = await readAllEvents('tenant', s.tenantId)
    expect(all).toHaveLength(1)
    expect(all[0].superseded_by).toBeNull()
  })

  it('a late mark in the onboarding month on a bill paid the day it was written becomes an on-time mark', async () => {
    const s = await seedStay()
    await db.query(`UPDATE leases SET is_existing_tenancy = TRUE WHERE id = $1`, [s.leaseId])
    const id = await restOfOctober(s)
    await oldMark(s, id, { tier: 'payment_received_late_major', due: '2026-10-01', paidAt: '2026-10-10T22:00:00Z' })
    expect(await correctLateMarksForBillsWrittenLate({ dryRun: false })).toEqual([
      expect.objectContaining({ now: 'payment_received_on_time' }),
    ])
  })

  it('the late-mark correction runs once: a second run finds nothing', async () => {
    const s = await seedStay()
    const id = await restOfOctober(s)
    await oldMark(s, id, { tier: 'payment_received_late_minor', due: '2026-10-01', paidAt: '2026-10-10T22:00:00Z' })
    expect(await correctLateMarksForBillsWrittenLate({ dryRun: false })).toHaveLength(1)
    expect(await correctLateMarksForBillsWrittenLate({ dryRun: false })).toEqual([])
    expect(await readAllEvents('tenant', s.tenantId)).toHaveLength(2)
  })

  it('a mark written under the rule (it records billed_on) is never corrected again', async () => {
    const s = await seedStay()
    const id = await bill(s, {
      due: '2026-10-01', writtenAt: '2026-10-10T17:00:00Z', amount: 520.97, isRemainder: true,
      notes: 'Stay now ends November 1, 2026: the rest of October 2026',
    })
    await payAtDesk(s, id, '2026-10-01', '2026-10-25T22:00:00Z')
    expect((await markOf(s)).event_data.billed_on).toBe('2026-10-10')
    expect(await correctLateMarksForBillsWrittenLate({ dryRun: false })).toEqual([])
  })
})

// ─── emitPaymentSettledEvent ───────────────────────────────────

describe('emitPaymentSettledEvent', () => {
  const tenantId = randomUUID()
  const paymentId = randomUUID()
  const due = new Date('2026-06-01T00:00:00Z')

  it('on_time → visible_to_current_landlord (positive)', async () => {
    await withTx(c => emitPaymentSettledEvent(c, {
      tenantId, paymentId, paymentType: 'rent',
      amount: '1000.00',
      dueDate: due,
      settledAt: new Date('2026-06-01T18:00:00Z'),
      graceDays: 5,
      stripePaymentIntentId: 'pi_test_on_time',
    }))
    const e = await readSoleEvent('tenant', tenantId)
    expect(e.event_type).toBe('payment_received_on_time')
    expect(e.network_visibility).toBe('visible_to_current_landlord')
    expect(e.dimension_tags).toEqual(['payment_reliability'])
    expect(e.attestation_source).toBe('stripe_attested')
    expect(e.attestation_evidence).toEqual({ stripe_payment_intent_id: 'pi_test_on_time' })
    expect(e.event_data.payment_id).toBe(paymentId)
    expect(e.event_data.amount).toBe('1000.00')
    expect(e.event_data.grace_days).toBe(5)
  })

  it('late_grace → still visible_to_current_landlord (within grace = positive)', async () => {
    await withTx(c => emitPaymentSettledEvent(c, {
      tenantId, paymentId, paymentType: 'rent',
      amount: 950,
      dueDate: due,
      settledAt: new Date('2026-06-04T12:00:00Z'),
      graceDays: 5,
      stripePaymentIntentId: 'pi_late_grace',
    }))
    const e = await readSoleEvent('tenant', tenantId)
    expect(e.event_type).toBe('payment_received_late_grace')
    expect(e.network_visibility).toBe('visible_to_current_landlord')
    expect(e.event_data.amount).toBe('950')         // number → String(950)
  })

  it('late_minor → visible_to_gam_network (adverse)', async () => {
    await withTx(c => emitPaymentSettledEvent(c, {
      tenantId, paymentId, paymentType: 'rent',
      amount: '1000',
      dueDate: due,
      settledAt: new Date('2026-06-08T00:00:00Z'),
      graceDays: 5,
      stripePaymentIntentId: 'pi_late_minor',
    }))
    const e = await readSoleEvent('tenant', tenantId)
    expect(e.event_type).toBe('payment_received_late_minor')
    expect(e.network_visibility).toBe('visible_to_gam_network')
  })

  it('null stripePaymentIntentId → attestation_evidence is empty object', async () => {
    await withTx(c => emitPaymentSettledEvent(c, {
      tenantId, paymentId, paymentType: 'utility',
      amount: '85.50',
      dueDate: due,
      settledAt: new Date('2026-06-01T08:00:00Z'),
      graceDays: 5,
      stripePaymentIntentId: null,
    }))
    const e = await readSoleEvent('tenant', tenantId)
    expect(e.attestation_evidence).toEqual({})
    expect(e.event_data.payment_type).toBe('utility')
  })

  it('graceDays NULL → defaults to 5 in event_data', async () => {
    await withTx(c => emitPaymentSettledEvent(c, {
      tenantId, paymentId, paymentType: 'rent',
      amount: '1000',
      dueDate: due,
      settledAt: new Date('2026-06-04T12:00:00Z'),
      graceDays: null,
      stripePaymentIntentId: 'pi_default_grace',
    }))
    const e = await readSoleEvent('tenant', tenantId)
    expect(e.event_type).toBe('payment_received_late_grace') // grace=5 used
    expect(e.event_data.grace_days).toBe(5)
  })
})

// ─── emitPaymentFailedEvent ────────────────────────────────────

describe('emitPaymentFailedEvent', () => {
  it('records payment_failed_nsf with full evidence + visibility', async () => {
    const tenantId = randomUUID()
    const paymentId = randomUUID()
    const due = new Date('2026-06-01T00:00:00Z')
    const failedAt = new Date('2026-06-03T15:30:00Z')

    await withTx(c => emitPaymentFailedEvent(c, {
      tenantId, paymentId, paymentType: 'rent',
      amount: '1200.50',
      dueDate: due,
      failedAt,
      stripePaymentIntentId: 'pi_failed_1',
      failureCode: 'R01',
      failureMessage: 'Insufficient funds',
    }))
    const e = await readSoleEvent('tenant', tenantId)
    expect(e.event_type).toBe('payment_failed_nsf')
    expect(e.network_visibility).toBe('visible_to_gam_network')
    expect(e.dimension_tags).toEqual(['payment_reliability'])
    expect(e.attestation_source).toBe('stripe_attested')
    expect(e.attestation_evidence).toEqual({ stripe_payment_intent_id: 'pi_failed_1' })
    expect(e.event_data.failure_code).toBe('R01')
    expect(e.event_data.failure_message).toBe('Insufficient funds')
    expect(new Date(e.event_data.failed_at).getTime()).toBe(failedAt.getTime())
  })

  it('null stripe id → empty evidence object (still records event)', async () => {
    const tenantId = randomUUID()
    await withTx(c => emitPaymentFailedEvent(c, {
      tenantId, paymentId: randomUUID(), paymentType: 'rent',
      amount: 800,
      dueDate: new Date('2026-06-01T00:00:00Z'),
      failedAt: new Date('2026-06-04T00:00:00Z'),
      stripePaymentIntentId: null,
      failureCode: null,
      failureMessage: null,
    }))
    const e = await readSoleEvent('tenant', tenantId)
    expect(e.attestation_evidence).toEqual({})
    expect(e.event_data.amount).toBe('800')
  })
})

// ─── emitLeaseSignedTenant / Landlord ──────────────────────────

describe('emitLeaseSigned (tenant + landlord)', () => {
  it('tenant signing → lease_signed on tenant subject, tenancy_stability tag, current-landlord visibility', async () => {
    const tenantId = randomUUID()
    const leaseId = randomUUID()
    const documentId = randomUUID()
    const signedAt = new Date('2026-05-15T10:00:00Z')

    await withTx(c => emitLeaseSignedTenant(c, { tenantId, leaseId, documentId, signedAt }))
    const e = await readSoleEvent('tenant', tenantId)
    expect(e.event_type).toBe('lease_signed')
    expect(e.dimension_tags).toEqual(['tenancy_stability'])
    expect(e.network_visibility).toBe('visible_to_current_landlord')
    expect(e.attestation_source).toBe('gam_workflow_auto')
    expect(e.attestation_evidence).toEqual({ lease_document_id: documentId })
    expect(e.event_data.lease_id).toBe(leaseId)
  })

  it('landlord signing → single landlord event with tenant_count in event_data', async () => {
    const landlordId = randomUUID()
    const leaseId = randomUUID()
    const documentId = randomUUID()
    await withTx(c => emitLeaseSignedLandlord(c, {
      landlordId, leaseId, documentId,
      signedAt: new Date('2026-05-15T10:05:00Z'),
      tenantCount: 2,
    }))
    const e = await readSoleEvent('landlord', landlordId)
    expect(e.event_type).toBe('lease_signed')
    expect(e.event_data.tenant_count).toBe(2)
    expect(e.event_data.lease_id).toBe(leaseId)
  })

  it('multi-tenant lease → each tenant emits separately; both events visible per-subject', async () => {
    const tenantA = randomUUID()
    const tenantB = randomUUID()
    const leaseId = randomUUID()
    const documentId = randomUUID()
    const signedAt = new Date('2026-05-15T10:00:00Z')

    await withTx(async c => {
      await emitLeaseSignedTenant(c, { tenantId: tenantA, leaseId, documentId, signedAt })
      await emitLeaseSignedTenant(c, { tenantId: tenantB, leaseId, documentId, signedAt })
    })
    expect((await readAllEvents('tenant', tenantA))).toHaveLength(1)
    expect((await readAllEvents('tenant', tenantB))).toHaveLength(1)
  })
})

// ─── emitInspectionFinalizedEvents ─────────────────────────────

describe('emitInspectionFinalizedEvents', () => {
  it('periodic inspection → no-op, no events', async () => {
    const tenantId = randomUUID()
    const landlordId = randomUUID()
    await withTx(c => emitInspectionFinalizedEvents(c, {
      inspectionType: 'periodic',
      tenantId, landlordId,
      inspectionId: randomUUID(),
      finalizedAt: new Date('2026-06-01T12:00:00Z'),
      photoCount: 5,
    }))
    expect(await readAllEvents('tenant', tenantId)).toHaveLength(0)
    expect(await readAllEvents('landlord', landlordId)).toHaveLength(0)
  })

  it('move-in within ±1d of lease start + photos → 3 events (tenant inspection + photos + landlord unit-ready)', async () => {
    const tenantId = randomUUID()
    const landlordId = randomUUID()
    const inspectionId = randomUUID()
    const leaseStart = new Date('2026-06-01T00:00:00Z')
    const finalizedAt = new Date('2026-06-01T15:00:00Z') // within ±1d

    await withTx(c => emitInspectionFinalizedEvents(c, {
      inspectionType: 'move_in',
      tenantId, landlordId,
      inspectionId,
      finalizedAt,
      photoCount: 8,
      leaseStartDate: leaseStart,
    }))

    const tenantEvts = await readAllEvents('tenant', tenantId)
    expect(tenantEvts.map(e => e.event_type).sort())
      .toEqual(['move_in_inspection_completed', 'move_in_photos_submitted'])
    for (const e of tenantEvts) {
      expect(e.attestation_source).toBe('gam_workflow_auto')
      expect(e.attestation_evidence).toEqual({ inspection_id: inspectionId })
    }
    const completed = tenantEvts.find(e => e.event_type === 'move_in_inspection_completed')!
    expect(completed.dimension_tags.sort()).toEqual(['property_care', 'tenancy_stability'])
    const photos = tenantEvts.find(e => e.event_type === 'move_in_photos_submitted')!
    expect(photos.event_data.photo_count).toBe(8)

    const llEvts = await readAllEvents('landlord', landlordId)
    expect(llEvts).toHaveLength(1)
    expect(llEvts[0].event_type).toBe('unit_ready_on_move_in_date')
    expect(llEvts[0].dimension_tags.sort()).toEqual(['cooperation', 'property_care'])
  })

  it('move-in OUTSIDE ±1d window → tenant event only, NO landlord unit-ready', async () => {
    const tenantId = randomUUID()
    const landlordId = randomUUID()
    await withTx(c => emitInspectionFinalizedEvents(c, {
      inspectionType: 'move_in',
      tenantId, landlordId,
      inspectionId: randomUUID(),
      finalizedAt: new Date('2026-06-04T00:00:00Z'),  // 3 days after start
      photoCount: 0,
      leaseStartDate: new Date('2026-06-01T00:00:00Z'),
    }))
    expect(await readAllEvents('tenant', tenantId)).toHaveLength(1)  // inspection_completed only (no photos)
    expect(await readAllEvents('landlord', landlordId)).toHaveLength(0)
  })

  it('move-in with leaseStartDate=null → no landlord unit-ready event', async () => {
    const tenantId = randomUUID()
    const landlordId = randomUUID()
    await withTx(c => emitInspectionFinalizedEvents(c, {
      inspectionType: 'move_in',
      tenantId, landlordId,
      inspectionId: randomUUID(),
      finalizedAt: new Date('2026-06-01T12:00:00Z'),
      photoCount: 0,
      leaseStartDate: null,
    }))
    expect(await readAllEvents('landlord', landlordId)).toHaveLength(0)
  })

  it('move-out matches move-in → matches event (positive, current-landlord visibility)', async () => {
    const tenantId = randomUUID()
    const inspectionId = randomUUID()
    await withTx(c => emitInspectionFinalizedEvents(c, {
      inspectionType: 'move_out',
      tenantId, landlordId: randomUUID(),
      inspectionId,
      finalizedAt: new Date('2026-09-01T15:00:00Z'),
      photoCount: 3,
      matchesMoveIn: true,
    }))
    const evts = await readAllEvents('tenant', tenantId)
    const types = evts.map(e => e.event_type).sort()
    expect(types).toEqual([
      'move_out_condition_matches_move_in',
      'move_out_inspection_completed',
      'move_out_photos_submitted',
    ])
    const matches = evts.find(e => e.event_type === 'move_out_condition_matches_move_in')!
    expect(matches.network_visibility).toBe('visible_to_current_landlord')
  })

  it('move-out damage documented → adverse event with gam_network visibility', async () => {
    const tenantId = randomUUID()
    await withTx(c => emitInspectionFinalizedEvents(c, {
      inspectionType: 'move_out',
      tenantId, landlordId: randomUUID(),
      inspectionId: randomUUID(),
      finalizedAt: new Date('2026-09-01T15:00:00Z'),
      photoCount: 0,
      matchesMoveIn: false,
      damageDocumented: true,
    }))
    const evts = await readAllEvents('tenant', tenantId)
    const damage = evts.find(e => e.event_type === 'move_out_condition_damage_documented')!
    expect(damage).toBeDefined()
    expect(damage.network_visibility).toBe('visible_to_gam_network')
  })

  it('move-out without tenantId → no events (early return guard)', async () => {
    const landlordId = randomUUID()
    await withTx(c => emitInspectionFinalizedEvents(c, {
      inspectionType: 'move_out',
      tenantId: null, landlordId,
      inspectionId: randomUUID(),
      finalizedAt: new Date('2026-09-01T15:00:00Z'),
      photoCount: 5,
      matchesMoveIn: true,
    }))
    expect(await readAllEvents('landlord', landlordId)).toHaveLength(0)
  })
})

// ─── emitLeaseTerminatedNaturalEvents ──────────────────────────

describe('emitLeaseTerminatedNaturalEvents', () => {
  it('per-tenant fanout + single landlord event; tenant visibility=gam_network, landlord=current', async () => {
    const tenantA = randomUUID()
    const tenantB = randomUUID()
    const landlordId = randomUUID()
    const leaseId = randomUUID()
    const terminatedAt = new Date('2026-08-31T23:59:00Z')

    await withTx(c => emitLeaseTerminatedNaturalEvents(c, {
      leaseId, landlordId, tenantIds: [tenantA, tenantB], terminatedAt,
    }))

    const eA = await readSoleEvent('tenant', tenantA)
    const eB = await readSoleEvent('tenant', tenantB)
    expect(eA.event_type).toBe('lease_terminated_natural')
    expect(eA.network_visibility).toBe('visible_to_gam_network')
    expect(eA.attestation_source).toBe('gam_workflow_auto')
    expect(eA.dimension_tags).toEqual(['tenancy_stability'])
    expect(eB.network_visibility).toBe('visible_to_gam_network')

    const ll = await readSoleEvent('landlord', landlordId)
    expect(ll.event_type).toBe('lease_terminated_natural')
    expect(ll.network_visibility).toBe('visible_to_current_landlord')
  })

  it('empty tenantIds → only landlord event written', async () => {
    const landlordId = randomUUID()
    await withTx(c => emitLeaseTerminatedNaturalEvents(c, {
      leaseId: randomUUID(), landlordId, tenantIds: [],
      terminatedAt: new Date('2026-08-31T00:00:00Z'),
    }))
    const { rows } = await db.query<any>(`SELECT COUNT(*)::int AS n FROM credit_events`)
    expect(rows[0].n).toBe(1)
    expect(await readAllEvents('landlord', landlordId)).toHaveLength(1)
  })
})

// ─── emitLeaseRenewedEvents ────────────────────────────────────

describe('emitLeaseRenewedEvents', () => {
  it('per-tenant + landlord; ALL events have current-landlord visibility (renewal is positive)', async () => {
    const tenantA = randomUUID()
    const landlordId = randomUUID()
    const leaseId = randomUUID()
    await withTx(c => emitLeaseRenewedEvents(c, {
      leaseId, landlordId, tenantIds: [tenantA],
      renewedAt: new Date('2026-09-01T00:00:00Z'),
    }))
    const t = await readSoleEvent('tenant', tenantA)
    expect(t.event_type).toBe('lease_renewed')
    expect(t.network_visibility).toBe('visible_to_current_landlord')
    expect(t.dimension_tags).toEqual(['tenancy_stability'])
    const ll = await readSoleEvent('landlord', landlordId)
    expect(ll.event_type).toBe('lease_renewed')
    expect(ll.network_visibility).toBe('visible_to_current_landlord')
  })
})

// ─── emitEntryRequestResponseEvents ────────────────────────────

describe('emitEntryRequestResponseEvents', () => {
  const proposedWindowStart = new Date('2026-06-10T14:00:00Z')

  it('granted IN TIME (responded before window start) → entry_request_granted_within_window', async () => {
    const tenantId = randomUUID()
    const requestId = randomUUID()
    await withTx(c => emitEntryRequestResponseEvents(c, {
      tenantId, requestId,
      decision: 'granted',
      respondedAt: new Date('2026-06-09T20:00:00Z'),  // before window
      proposedWindowStart,
    }))
    const e = await readSoleEvent('tenant', tenantId)
    expect(e.event_type).toBe('entry_request_granted_within_window')
    expect(e.dimension_tags).toEqual(['cooperation'])
    expect(e.network_visibility).toBe('visible_to_current_landlord')
    expect(e.attestation_evidence).toEqual({ entry_request_id: requestId })
  })

  it('granted LATE (responded after window start) → NO event written', async () => {
    const tenantId = randomUUID()
    await withTx(c => emitEntryRequestResponseEvents(c, {
      tenantId, requestId: randomUUID(),
      decision: 'granted',
      respondedAt: new Date('2026-06-10T14:30:00Z'),  // 30min into window
      proposedWindowStart,
    }))
    expect(await readAllEvents('tenant', tenantId)).toHaveLength(0)
  })

  it('denied → entry_request_denied (denial is a right, no score impact but logged)', async () => {
    const tenantId = randomUUID()
    const requestId = randomUUID()
    await withTx(c => emitEntryRequestResponseEvents(c, {
      tenantId, requestId,
      decision: 'denied',
      respondedAt: new Date('2026-06-09T20:00:00Z'),
      proposedWindowStart,
    }))
    const e = await readSoleEvent('tenant', tenantId)
    expect(e.event_type).toBe('entry_request_denied')
    expect(e.network_visibility).toBe('visible_to_current_landlord')
  })
})

// ─── emitEntryRecordedEvents ───────────────────────────────────

describe('emitEntryRecordedEvents', () => {
  const windowStart = new Date('2026-06-10T14:00:00Z')
  const windowEnd   = new Date('2026-06-10T16:00:00Z')

  it('compliant: within window AND granted → proper_entry_notice_given, returns compliant', async () => {
    const landlordId = randomUUID()
    const requestId = randomUUID()
    const result = await withTx(c => emitEntryRecordedEvents(c, {
      landlordId, requestId,
      enteredAt: new Date('2026-06-10T15:00:00Z'),
      proposedWindowStart: windowStart,
      proposedWindowEnd:   windowEnd,
      grantedDecision: 'granted',
    }))
    expect(result.outcome).toBe('compliant')
    const e = await readSoleEvent('landlord', landlordId)
    expect(e.event_type).toBe('proper_entry_notice_given')
    expect(e.network_visibility).toBe('visible_to_current_landlord')
  })

  it('breach: outside window → entry_compliance_breach, gam_network visibility', async () => {
    const landlordId = randomUUID()
    const result = await withTx(c => emitEntryRecordedEvents(c, {
      landlordId, requestId: randomUUID(),
      enteredAt: new Date('2026-06-10T18:00:00Z'),    // 2h past window
      proposedWindowStart: windowStart,
      proposedWindowEnd:   windowEnd,
      grantedDecision: 'granted',
    }))
    expect(result.outcome).toBe('breach')
    const e = await readSoleEvent('landlord', landlordId)
    expect(e.event_type).toBe('entry_compliance_breach')
    expect(e.network_visibility).toBe('visible_to_gam_network')
    expect(e.event_data.within_window).toBe(false)
    expect(e.event_data.granted_decision).toBe('granted')
  })

  it('breach: within window but NOT granted (or null) → still breach', async () => {
    const landlordId = randomUUID()
    const result = await withTx(c => emitEntryRecordedEvents(c, {
      landlordId, requestId: randomUUID(),
      enteredAt: new Date('2026-06-10T15:00:00Z'),
      proposedWindowStart: windowStart,
      proposedWindowEnd:   windowEnd,
      grantedDecision: null,
    }))
    expect(result.outcome).toBe('breach')
    const e = await readSoleEvent('landlord', landlordId)
    expect(e.event_type).toBe('entry_compliance_breach')
    expect(e.event_data.within_window).toBe(true)
    expect(e.event_data.granted_decision).toBeNull()
  })
})

// ─── classifyMaintenanceTier (pure) ────────────────────────────

describe('classifyMaintenanceTier', () => {
  const created = new Date('2026-06-01T12:00:00Z')

  it('≤24h → within_24h', () => {
    expect(classifyMaintenanceTier({
      createdAt: created,
      resolvedAt: new Date('2026-06-02T11:00:00Z'),
    })).toBe('within_24h')
  })
  it('24h<x≤72h → within_72h', () => {
    expect(classifyMaintenanceTier({
      createdAt: created,
      resolvedAt: new Date('2026-06-04T00:00:00Z'),
    })).toBe('within_72h')
  })
  it('72h<x≤SLA (default 7d) → within_sla', () => {
    expect(classifyMaintenanceTier({
      createdAt: created,
      resolvedAt: new Date('2026-06-07T12:00:00Z'),
    })).toBe('within_sla')
  })
  it('past SLA → breach_sla', () => {
    expect(classifyMaintenanceTier({
      createdAt: created,
      resolvedAt: new Date('2026-06-12T12:00:00Z'),
    })).toBe('breach_sla')
  })
  it('custom slaHours respected — 96h elapsed with 80h SLA → breach', () => {
    // The 24h / 72h tier checks short-circuit before slaHours is used,
    // so the custom SLA only changes the within_sla vs breach_sla cutoff.
    expect(classifyMaintenanceTier({
      createdAt: created,
      resolvedAt: new Date('2026-06-05T12:00:00Z'),    // +96h
      slaHours: 80,                                      // custom shorter SLA
    })).toBe('breach_sla')
    // Same elapsed under DEFAULT SLA (7d=168h) → within_sla.
    expect(classifyMaintenanceTier({
      createdAt: created,
      resolvedAt: new Date('2026-06-05T12:00:00Z'),
    })).toBe('within_sla')
  })
})

// ─── emitMaintenanceResolvedEvents ─────────────────────────────

describe('emitMaintenanceResolvedEvents', () => {
  const requestId = randomUUID()
  const resolvedAt = new Date('2026-06-05T12:00:00Z')

  it('within_24h → maintenance_response_24h, current-landlord visibility', async () => {
    const landlordId = randomUUID()
    await withTx(c => emitMaintenanceResolvedEvents(c, {
      landlordId, requestId, resolvedAt, responseTier: 'within_24h',
    }))
    const e = await readSoleEvent('landlord', landlordId)
    expect(e.event_type).toBe('maintenance_response_24h')
    expect(e.network_visibility).toBe('visible_to_current_landlord')
    expect(e.dimension_tags.sort()).toEqual(['cooperation', 'property_care'])
  })

  it('within_72h → maintenance_response_72h', async () => {
    const landlordId = randomUUID()
    await withTx(c => emitMaintenanceResolvedEvents(c, {
      landlordId, requestId, resolvedAt, responseTier: 'within_72h',
    }))
    const e = await readSoleEvent('landlord', landlordId)
    expect(e.event_type).toBe('maintenance_response_72h')
    expect(e.network_visibility).toBe('visible_to_current_landlord')
  })

  it('within_sla → maintenance_response_within_sla', async () => {
    const landlordId = randomUUID()
    await withTx(c => emitMaintenanceResolvedEvents(c, {
      landlordId, requestId, resolvedAt, responseTier: 'within_sla',
    }))
    const e = await readSoleEvent('landlord', landlordId)
    expect(e.event_type).toBe('maintenance_response_within_sla')
    expect(e.network_visibility).toBe('visible_to_current_landlord')
  })

  it('breach_sla → maintenance_response_breach_sla + visibility flips to gam_network', async () => {
    const landlordId = randomUUID()
    await withTx(c => emitMaintenanceResolvedEvents(c, {
      landlordId, requestId, resolvedAt, responseTier: 'breach_sla',
    }))
    const e = await readSoleEvent('landlord', landlordId)
    expect(e.event_type).toBe('maintenance_response_breach_sla')
    expect(e.network_visibility).toBe('visible_to_gam_network')
    expect(e.event_data.response_tier).toBe('breach_sla')
  })
})

// ═══════════════════════════════════════════════════════════════
//  S448 ─ DETECTOR EMITTERS (attestation_source='system_derived')
// ═══════════════════════════════════════════════════════════════
//
// These emitters fire from background cron detectors rather than
// inline workflow triggers. Idempotency is owned by the detector
// itself (each detector queries the chain for a prior emission
// before firing); the emitters just persist what they're handed.
// So coverage focuses on the contract — event_type,
// dimension_tags, network_visibility, attestation persistence —
// not idempotency, which lives in the caller's seam.

// ─── emitTenancyEndedWithBalanceEvent ──────────────────────────

describe('emitTenancyEndedWithBalanceEvent', () => {
  it('records tenancy_ended_with_balance with full reconciliation payload', async () => {
    const tenantId = randomUUID()
    const leaseId = randomUUID()
    const occurredAt = new Date('2026-09-15T12:00:00Z')

    await withTx(c => emitTenancyEndedWithBalanceEvent(c, {
      tenantId, leaseId,
      expectedTotal: 12000,
      receivedTotal: 11250,
      delta: 750,
      occurredAt,
    }))

    const e = await readSoleEvent('tenant', tenantId)
    expect(e.event_type).toBe('tenancy_ended_with_balance')
    expect(e.network_visibility).toBe('visible_to_gam_network')
    expect(e.dimension_tags.sort()).toEqual(['payment_reliability', 'tenancy_stability'])
    expect(e.attestation_source).toBe('system_derived')
    expect(e.attestation_evidence).toEqual({ lease_id: leaseId })
    expect(e.event_data.lease_id).toBe(leaseId)
    expect(e.event_data.expected_total).toBe(12000)
    expect(e.event_data.received_total).toBe(11250)
    expect(e.event_data.delta).toBe(750)
    expect(e.event_data.settlement_status).toBe('unpaid')
    expect(new Date(e.occurred_at).getTime()).toBe(occurredAt.getTime())
  })

  it('zero delta still records the event (caller decides when to fire)', async () => {
    // Detector-owned idempotency: if the caller decides to fire with
    // delta=0 (edge case where rounding lands exactly on zero), the
    // emitter doesn't second-guess. It persists what it's handed.
    const tenantId = randomUUID()
    await withTx(c => emitTenancyEndedWithBalanceEvent(c, {
      tenantId, leaseId: randomUUID(),
      expectedTotal: 0, receivedTotal: 0, delta: 0,
      occurredAt: new Date('2026-09-15T12:00:00Z'),
    }))
    const e = await readSoleEvent('tenant', tenantId)
    expect(e.event_data.delta).toBe(0)
    expect(e.event_data.settlement_status).toBe('unpaid')
  })
})

// ─── emitBalancePaidPostMoveEvent ──────────────────────────────

describe('emitBalancePaidPostMoveEvent', () => {
  it('records balance_paid_post_move with current-landlord visibility (positive recovery)', async () => {
    const tenantId = randomUUID()
    const leaseId = randomUUID()
    const occurredAt = new Date('2026-11-10T15:00:00Z')

    await withTx(c => emitBalancePaidPostMoveEvent(c, {
      tenantId, leaseId, occurredAt,
    }))

    const e = await readSoleEvent('tenant', tenantId)
    expect(e.event_type).toBe('balance_paid_post_move')
    expect(e.network_visibility).toBe('visible_to_current_landlord')
    expect(e.dimension_tags).toEqual(['payment_reliability'])
    expect(e.attestation_source).toBe('system_derived')
    expect(e.attestation_evidence).toEqual({ lease_id: leaseId })
    expect(e.event_data.lease_id).toBe(leaseId)
  })

  it('multiple post-move payoffs across leases → distinct events per lease (caller-owned idempotency)', async () => {
    const tenantId = randomUUID()
    const leaseA = randomUUID()
    const leaseB = randomUUID()
    await withTx(async c => {
      await emitBalancePaidPostMoveEvent(c, {
        tenantId, leaseId: leaseA,
        occurredAt: new Date('2026-11-10T15:00:00Z'),
      })
      await emitBalancePaidPostMoveEvent(c, {
        tenantId, leaseId: leaseB,
        occurredAt: new Date('2027-02-01T15:00:00Z'),
      })
    })
    const evts = await readAllEvents('tenant', tenantId)
    expect(evts).toHaveLength(2)
    expect(evts.map(e => e.event_data.lease_id).sort()).toEqual([leaseA, leaseB].sort())
  })
})

// ─── emitLeaseAnniversaryEvent ─────────────────────────────────

describe('emitLeaseAnniversaryEvent', () => {
  it('records lease_anniversary with anniversary_year payload + current-landlord visibility', async () => {
    const tenantId = randomUUID()
    const leaseId = randomUUID()
    const occurredAt = new Date('2027-06-01T00:00:00Z')

    await withTx(c => emitLeaseAnniversaryEvent(c, {
      tenantId, leaseId,
      anniversaryYear: 1,
      occurredAt,
    }))

    const e = await readSoleEvent('tenant', tenantId)
    expect(e.event_type).toBe('lease_anniversary')
    expect(e.network_visibility).toBe('visible_to_current_landlord')
    expect(e.dimension_tags).toEqual(['tenancy_stability'])
    expect(e.attestation_source).toBe('gam_workflow_auto')  // distinct from system_derived (S448 batch — note exception)
    expect(e.attestation_evidence).toEqual({ lease_id: leaseId })
    expect(e.event_data.lease_id).toBe(leaseId)
    expect(e.event_data.anniversary_year).toBe(1)
  })

  it('multi-year anniversaries: same tenant + lease, different years → separate events', async () => {
    const tenantId = randomUUID()
    const leaseId = randomUUID()
    await withTx(async c => {
      await emitLeaseAnniversaryEvent(c, {
        tenantId, leaseId, anniversaryYear: 1,
        occurredAt: new Date('2027-06-01T00:00:00Z'),
      })
      await emitLeaseAnniversaryEvent(c, {
        tenantId, leaseId, anniversaryYear: 2,
        occurredAt: new Date('2028-06-01T00:00:00Z'),
      })
    })
    const evts = await readAllEvents('tenant', tenantId)
    expect(evts).toHaveLength(2)
    expect(evts.map(e => e.event_data.anniversary_year).sort()).toEqual([1, 2])
  })
})

// ─── emitRecurringRepairEvent ──────────────────────────────────

describe('emitRecurringRepairEvent', () => {
  it('records recurring_repair_same_issue with both request ids in evidence + gam_network visibility', async () => {
    const landlordId = randomUUID()
    const priorRequestId = randomUUID()
    const currentRequestId = randomUUID()
    const occurredAt = new Date('2026-07-20T12:00:00Z')

    await withTx(c => emitRecurringRepairEvent(c, {
      landlordId, priorRequestId, currentRequestId,
      category: 'plumbing_leak',
      occurredAt,
    }))

    const e = await readSoleEvent('landlord', landlordId)
    expect(e.event_type).toBe('recurring_repair_same_issue')
    expect(e.network_visibility).toBe('visible_to_gam_network')
    expect(e.dimension_tags).toEqual(['property_care'])
    expect(e.attestation_source).toBe('system_derived')
    // Evidence carries BOTH request ids so a future audit can replay
    // the duplicate detection (the prior + current pair is what made
    // this a "same issue" rather than a fresh report).
    expect(e.attestation_evidence).toEqual({
      prior_request_id: priorRequestId,
      current_request_id: currentRequestId,
    })
    expect(e.event_data.prior_request_id).toBe(priorRequestId)
    expect(e.event_data.current_request_id).toBe(currentRequestId)
    expect(e.event_data.category).toBe('plumbing_leak')
  })
})

// ─── emitHabitabilityUnresolvedEvent ───────────────────────────

describe('emitHabitabilityUnresolvedEvent', () => {
  it('records habitability_complaint_unresolved_30d with days_open + category', async () => {
    const landlordId = randomUUID()
    const requestId = randomUUID()
    const detectedAt = new Date('2026-08-01T00:00:00Z')

    await withTx(c => emitHabitabilityUnresolvedEvent(c, {
      landlordId, requestId,
      category: 'no_heat',
      daysOpen: 31,
      detectedAt,
    }))

    const e = await readSoleEvent('landlord', landlordId)
    expect(e.event_type).toBe('habitability_complaint_unresolved_30d')
    expect(e.network_visibility).toBe('visible_to_gam_network')
    expect(e.dimension_tags).toEqual(['property_care'])
    expect(e.attestation_source).toBe('system_derived')
    expect(e.attestation_evidence).toEqual({ maintenance_request_id: requestId })
    expect(e.event_data.maintenance_request_id).toBe(requestId)
    expect(e.event_data.category).toBe('no_heat')
    expect(e.event_data.days_open).toBe(31)
    expect(new Date(e.occurred_at).getTime()).toBe(detectedAt.getTime())
  })

  it('higher days_open value passes through unchanged (detector decides when to fire)', async () => {
    const landlordId = randomUUID()
    await withTx(c => emitHabitabilityUnresolvedEvent(c, {
      landlordId, requestId: randomUUID(),
      category: 'no_water', daysOpen: 90,
      detectedAt: new Date('2026-08-01T00:00:00Z'),
    }))
    const e = await readSoleEvent('landlord', landlordId)
    expect(e.event_data.days_open).toBe(90)
  })
})

// ─── emitMultiLandlordHistoryCleanEvent ────────────────────────

describe('emitMultiLandlordHistoryCleanEvent', () => {
  it('records multi_landlord_history_clean with full counts on tenant subject', async () => {
    const tenantId = randomUUID()
    const occurredAt = new Date('2027-01-15T12:00:00Z')

    await withTx(c => emitMultiLandlordHistoryCleanEvent(c, {
      tenantId,
      landlordCount: 3,
      cleanLeaseCount: 4,
      occurredAt,
    }))

    const e = await readSoleEvent('tenant', tenantId)
    expect(e.event_type).toBe('multi_landlord_history_clean')
    expect(e.network_visibility).toBe('visible_to_gam_network')
    expect(e.dimension_tags.sort()).toEqual(['community_fit', 'tenancy_stability'])
    expect(e.attestation_source).toBe('system_derived')
    expect(e.attestation_evidence).toEqual({
      distinct_landlord_count: 3,
      clean_lease_count: 4,
    })
    expect(e.event_data.distinct_landlord_count).toBe(3)
    expect(e.event_data.clean_lease_count).toBe(4)
  })

  it('different (landlordCount, cleanLeaseCount) values pass through', async () => {
    const tenantId = randomUUID()
    await withTx(c => emitMultiLandlordHistoryCleanEvent(c, {
      tenantId, landlordCount: 5, cleanLeaseCount: 7,
      occurredAt: new Date('2027-01-15T12:00:00Z'),
    }))
    const e = await readSoleEvent('tenant', tenantId)
    expect(e.event_data.distinct_landlord_count).toBe(5)
    expect(e.event_data.clean_lease_count).toBe(7)
  })
})

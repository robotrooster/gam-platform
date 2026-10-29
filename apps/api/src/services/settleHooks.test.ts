/**
 * S655 money plan, Step 1: afterRowsSettled, the one routine every settle path
 * runs once money has landed (desk, webhook, credit-only, whole-bill, FlexPay
 * cover, bank match, posted payment). Callers pass the rows their own UPDATE
 * just settled; the payment mark is guarded against a replay regardless.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import type { PoolClient } from 'pg'

const sendPaymentReceipt = vi.fn(async (_opts: unknown) => 'msg_1' as string | null)
vi.mock('./paymentReceipt', () => ({ sendPaymentReceipt: (opts: unknown) => sendPaymentReceipt(opts) }))

import { afterRowsSettled } from './settleHooks'
import { supersedeEvent } from './creditLedger'
import {
  cleanupAllSchema, withRollback, seedLandlord, seedProperty, seedUnit, seedTenant, seedLease, seedLeaseTenant,
} from '../test/dbHelpers'

interface Household { landlordId: string; tenantId: string; unitId: string; leaseId: string }

async function household(c: PoolClient): Promise<Household> {
  const ll = await seedLandlord(c)
  const propertyId = await seedProperty(c, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
  const unitId = await seedUnit(c, { propertyId, landlordId: ll.landlordId })
  const tenantId = await seedTenant(c)
  const leaseId = await seedLease(c, { unitId, landlordId: ll.landlordId, status: 'active' })
  await seedLeaseTenant(c, { leaseId, tenantId })
  // Still in onboarding grace: the first settled rent is what makes them live.
  await c.query(`UPDATE landlords SET billing_starts_at = NULL WHERE id = $1`, [ll.landlordId])
  return { landlordId: ll.landlordId, tenantId, unitId, leaseId }
}

// Rent is unique per lease and due date, so each row gets its own day — and
// (10/12, "one mark per invoice") its own bill, unless it is put on one.
// Settled rows are paid at 15:00 UTC on their due day (8 am in Phoenix): on time.
let dueSeq = 0
async function settled(c: PoolClient, f: Household, o: {
  type?: string; entry?: string; status?: string; intent?: string; reversalId?: string; invoiceId?: string; due?: string
} = {}) {
  const due = o.due ?? new Date(Date.UTC(2026, 9, 1) + (dueSeq++) * 86_400_000).toISOString().slice(0, 10)
  const invoiceId = o.invoiceId ?? (await c.query<{ id: string }>(
    `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date, total_amount, status, created_at)
     VALUES ($1,$2,$3,$4,$5,$6::date,460,'pending',$6::date - 5) RETURNING id`,
    [f.landlordId, f.tenantId, f.leaseId, f.unitId, `INV-${due}-${dueSeq}-${Math.random().toString(36).slice(2, 8)}`, due])).rows[0].id
  const r = await c.query<{ id: string }>(
    `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount, status, entry_description,
                           due_date, settled_at, stripe_payment_intent_id, reversal_id, created_at)
     VALUES ($11,$1,$2,$3,$4,$5,460,$6,$7,$10::date,
             CASE WHEN $6 = 'settled' THEN ($10::date + time '15:00') AT TIME ZONE 'UTC' END,$8,$9,$10::date - 5) RETURNING id`,
    [f.unitId, f.leaseId, f.tenantId, f.landlordId, o.type ?? 'rent', o.status ?? 'settled',
     o.entry ?? 'RENT', o.intent ?? null, o.reversalId ?? null, due, invoiceId])
  return r.rows[0].id
}

/** The live bill marks on the bills these rows are on (one per bill), by bill due date. */
async function marks(c: PoolClient, paymentIds: string[]) {
  const r = await c.query(
    `SELECT e.id, p.id::text AS payment_id, e.event_type, e.attestation_source, e.attestation_evidence
       FROM credit_events e
       JOIN payments p ON p.invoice_id::text = e.event_data->>'invoice_id'
      WHERE p.id = ANY($1::uuid[]) AND e.event_data->>'mark_basis' = 'invoice' AND e.superseded_by IS NULL
      ORDER BY e.event_data->>'due_date', p.id`,
    [paymentIds])
  return r.rows
}

beforeAll(async () => { await cleanupAllSchema() })
afterAll(async () => { await cleanupAllSchema() })
beforeEach(() => { sendPaymentReceipt.mockClear() })

describe('S655 afterRowsSettled', () => {
  it("the first settled rent starts the landlord's billing and each bill gets its ONE payment mark (a late fee alone is no bill's mark)", async () => {
    await withRollback(async c => {
      const f = await household(c)
      const rent = await settled(c, f)
      const water = await settled(c, f, { type: 'utility', entry: 'UTILITY' })
      const late = await settled(c, f, { type: 'late_fee', entry: 'LATEFEE' })
      const out = await afterRowsSettled(c, [rent, water, late], {
        attestationSource: 'landlord_self_reported_with_evidence',
        attestationEvidence: { manual_method: 'cash', reference: null },
        receipt: null,
      })
      expect(out.billingActivated).toBe(1)
      expect(out.eventsEmitted).toBe(2)
      expect(out.settledIds).toEqual([rent, water, late].sort())
      const live = await c.query(`SELECT billing_starts_at FROM landlords WHERE id = $1`, [f.landlordId])
      expect(live.rows[0].billing_starts_at).not.toBeNull()
      const m = await marks(c, [rent, water, late])
      // 10/12: derived from the bill's own records, not from the caller's attestation.
      expect(m.map(r => [r.payment_id, r.event_type, r.attestation_source])).toEqual([
        [rent, 'payment_received_on_time', 'system_derived'],
        [water, 'payment_received_on_time', 'system_derived'],
      ])
      expect(m[0].attestation_evidence.payment_ids).toEqual([rent])
    })
  })

  it('rent and utility on one bill settled together: one mark for the bill', async () => {
    await withRollback(async c => {
      const f = await household(c)
      const rent = await settled(c, f)
      const inv = (await c.query<{ invoice_id: string }>(`SELECT invoice_id FROM payments WHERE id = $1`, [rent])).rows[0].invoice_id
      const due = (await c.query<{ d: string }>(`SELECT due_date::text AS d FROM payments WHERE id = $1`, [rent])).rows[0].d
      const water = await settled(c, f, { type: 'utility', entry: 'UTILITY', invoiceId: inv, due })
      const out = await afterRowsSettled(c, [rent, water], { attestationSource: 'stripe_attested', receipt: null })
      expect(out.eventsEmitted).toBe(1)
      const m = await marks(c, [rent])
      expect(m).toHaveLength(1)
      expect([...m[0].attestation_evidence.payment_ids].sort()).toEqual([rent, water].sort())
    })
  })

  it('a reopened row starts nothing; its bill is judged on its own records (paid again on its due day: on time)', async () => {
    await withRollback(async c => {
      const f = await household(c)
      const original = await settled(c, f, { status: 'returned' })
      const inv = (await c.query<{ invoice_id: string; d: string }>(
        `SELECT invoice_id, due_date::text AS d FROM payments WHERE id = $1`, [original])).rows[0]
      const reversal = (await c.query<{ id: string }>(
        `INSERT INTO payment_reversals (payment_id, reversal_type, reversed_amount, stripe_event_id, raw_event)
         VALUES ($1,'card_dispute',460,'evt_hook','{}'::jsonb) RETURNING id`, [original])).rows[0].id
      const repaid = await settled(c, f, { reversalId: reversal, invoiceId: inv.invoice_id, due: inv.d })
      const out = await afterRowsSettled(c, [repaid], { attestationSource: 'stripe_attested', receipt: { method: 'card' } })
      expect(out).toMatchObject({ billingActivated: 0, eventsEmitted: 1, settledIds: [repaid] })
      // The 'returned' original is left out of the bill; the reopened row carries it.
      expect((await marks(c, [repaid])).map(m => [m.event_type, m.attestation_evidence.payment_ids]))
        .toEqual([['payment_received_on_time', [repaid]]])
    })
  })

  it('a row that already carries its payment mark never gets a second one (a replayed webhook, a caller passing old rows)', async () => {
    await withRollback(async c => {
      const f = await household(c)
      const rent = await settled(c, f, { intent: 'pi_first' })
      const first = await afterRowsSettled(c, [rent], { attestationSource: 'stripe_attested', receipt: null })
      expect(first).toMatchObject({ eventsEmitted: 1, alreadyMarked: [], billingActivated: 1 })

      // The same settle replayed, alongside a row this transaction really did settle.
      const water = await settled(c, f, { type: 'utility', entry: 'UTILITY' })
      const replay = await afterRowsSettled(c, [rent, water], { attestationSource: 'stripe_attested', receipt: null })
      expect(replay).toMatchObject({ eventsEmitted: 1, alreadyMarked: [rent], billingActivated: 0 })
      const m = await marks(c, [rent, water])
      expect(m.map(r => r.payment_id).sort()).toEqual([rent, water].sort())

      // Replayed again (whatever the caller says now): the bills' marks stand, nothing is written.
      const again = await afterRowsSettled(c, [rent, water], { attestationSource: 'landlord_self_reported_with_evidence', receipt: null })
      expect(again).toMatchObject({ eventsEmitted: 0, alreadyMarked: [rent, water].sort() })
      expect((await marks(c, [rent, water])).map(r => r.id)).toEqual(m.map(r => r.id))
    })
  })

  it('a bank-matched line that is undone and paid again carries exactly one live payment mark', async () => {
    await withRollback(async c => {
      const f = await household(c)
      const rent = await settled(c, f)
      const matched = await afterRowsSettled(c, [rent], {
        attestationSource: 'landlord_self_reported_with_evidence', receipt: null })
      expect(matched.eventsEmitted).toBe(1)

      // undoDepositMatch: the line is owed again and its mark is withdrawn
      // (a mark pointing at itself, reason attestation_invalidated).
      const first = (await marks(c, [rent]))[0].id
      await supersedeEvent(c, first, first, 'attestation_invalidated')
      await c.query(`UPDATE payments SET status = 'pending', settled_at = NULL WHERE id = $1`, [rent])

      // Then the tenant genuinely pays it.
      await c.query(`UPDATE payments SET status = 'settled', settled_at = due_date + time '15:00' WHERE id = $1`, [rent])
      const paid = await afterRowsSettled(c, [rent], { attestationSource: 'stripe_attested', receipt: null })
      expect(paid).toMatchObject({ eventsEmitted: 1, alreadyMarked: [] })

      const live = await marks(c, [rent])
      expect(live).toHaveLength(1)
      expect(live[0].id).not.toBe(first)
      expect(live[0].event_type).toBe('payment_received_on_time')

      // A replay after that still adds nothing.
      const replay = await afterRowsSettled(c, [rent], { attestationSource: 'stripe_attested', receipt: null })
      expect(replay).toMatchObject({ eventsEmitted: 0, alreadyMarked: [rent] })
    })
  })

  it('rows that are not settled are skipped', async () => {
    await withRollback(async c => {
      const f = await household(c)
      const paid = await settled(c, f)
      const open = await settled(c, f, { status: 'pending' })
      const out = await afterRowsSettled(c, [open, paid, paid], { attestationSource: 'gam_workflow_auto', receipt: { method: 'account credit' } })
      expect(out.settledIds).toEqual([paid])
      expect(out.eventsEmitted).toBe(1)
      await out.afterCommit()
      expect(sendPaymentReceipt).toHaveBeenCalledWith({ method: 'account credit', paymentIds: [paid] })
    })
  })

  it('the receipt waits for afterCommit, covers every settled row, and goes once', async () => {
    await withRollback(async c => {
      const f = await household(c)
      const rent = await settled(c, f)
      const water = await settled(c, f, { type: 'utility', entry: 'UTILITY' })
      const out = await afterRowsSettled(c, [water, rent], {
        attestationSource: 'landlord_self_reported_with_evidence', receipt: { method: 'check', reference: '1042' } })
      expect(sendPaymentReceipt).not.toHaveBeenCalled()
      await out.afterCommit()
      await out.afterCommit()
      expect(sendPaymentReceipt).toHaveBeenCalledTimes(1)
      expect(sendPaymentReceipt).toHaveBeenCalledWith({ method: 'check', reference: '1042', paymentIds: [rent, water].sort() })

      const silent = await afterRowsSettled(c, [rent], { attestationSource: 'gam_workflow_auto', receipt: null })
      await silent.afterCommit()
      expect(sendPaymentReceipt).toHaveBeenCalledTimes(1)
    })
  })

  it('a receipt that fails never throws', async () => {
    await withRollback(async c => {
      const f = await household(c)
      const rent = await settled(c, f)
      sendPaymentReceipt.mockRejectedValueOnce(new Error('mail is down'))
      const out = await afterRowsSettled(c, [rent], { attestationSource: 'stripe_attested', receipt: { method: 'card' } })
      await expect(out.afterCommit()).resolves.toBeUndefined()
    })
  })

  // 10/12: a bill's mark is derived from the bill's records — it cites the bill
  // and its lines, never a payment intent (an old, failed intent on a row the
  // desk or credit paid cannot leak onto it).
  it('a bill mark cites its bill and lines, never a payment intent', async () => {
    await withRollback(async c => {
      const f = await household(c)
      const byCard = await settled(c, f, { intent: 'pi_card' })
      const byCredit = await settled(c, f, { type: 'utility', entry: 'UTILITY', intent: 'pi_old_failed' })
      await afterRowsSettled(c, [byCard], { attestationSource: 'stripe_attested', receipt: null })
      await afterRowsSettled(c, [byCredit], { attestationSource: 'gam_workflow_auto', receipt: null })
      const m = Object.fromEntries((await marks(c, [byCard, byCredit])).map(r => [r.payment_id, r]))
      for (const id of [byCard, byCredit]) {
        expect(m[id].attestation_source).toBe('system_derived')
        expect(m[id].attestation_evidence.payment_ids).toEqual([id])
        expect(JSON.stringify(m[id].attestation_evidence)).not.toContain('pi_')
      }
    })
  })

  it('nothing passed in, nothing done', async () => {
    await withRollback(async c => {
      const out = await afterRowsSettled(c, [], { attestationSource: 'stripe_attested', receipt: { method: 'card' } })
      expect(out).toMatchObject({ settledIds: [], billingActivated: 0, eventsEmitted: 0 })
      await out.afterCommit()
      expect(sendPaymentReceipt).not.toHaveBeenCalled()
    })
  })
})

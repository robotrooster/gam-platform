/**
 * S436 services-audit slice 13 — closes the stripeConnect.ts arc.
 * Webhook recorders for `payout.*` and `charge.dispute.*` events.
 *
 *   - recordPayoutEvent(payout, accountId) — upserts `connect_payouts`,
 *     propagates terminal status onto `disbursements`, fan-outs
 *     paid/failed notifications via dynamically-imported notifiers
 *     (user vs pm_company routing).
 *   - recordDisputeEvent(dispute) — upserts `connect_disputes`,
 *     resolves linked payment via stripe_payment_intent_id.
 *
 * Both are idempotent on their unique stripe id columns.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

const {
  notifyConnectPayoutPaidMock,
  notifyConnectPayoutFailedMock,
  notifyPmCompanyPayoutPaidMock,
  notifyPmCompanyPayoutFailedMock,
} = vi.hoisted(() => ({
  notifyConnectPayoutPaidMock:    vi.fn(async () => undefined),
  notifyConnectPayoutFailedMock:  vi.fn(async () => undefined),
  notifyPmCompanyPayoutPaidMock:  vi.fn(async () => undefined),
  notifyPmCompanyPayoutFailedMock:vi.fn(async () => undefined),
}))

vi.mock('./notifications', () => ({
  notifyConnectPayoutPaid:    notifyConnectPayoutPaidMock,
  notifyConnectPayoutFailed:  notifyConnectPayoutFailedMock,
  notifyPmCompanyPayoutPaid:  notifyPmCompanyPayoutPaidMock,
  notifyPmCompanyPayoutFailed:notifyPmCompanyPayoutFailedMock,
}))

import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant,
  seedUserBankAccount, seedPmCompany,
} from '../test/dbHelpers'
import { recordPayoutEvent, recordDisputeEvent } from './stripeConnect'

beforeEach(async () => {
  // `disbursements` isn't in cleanupAllSchema and FKs landlords; pre-clean
  // so the global landlords DELETE in cleanupAllSchema doesn't trip the FK.
  await db.query(`DELETE FROM disbursements`)
  await cleanupAllSchema()
  notifyConnectPayoutPaidMock.mockReset()
  notifyConnectPayoutFailedMock.mockReset()
  notifyPmCompanyPayoutPaidMock.mockReset()
  notifyPmCompanyPayoutFailedMock.mockReset()
})

// ─── helpers ─────────────────────────────────────────────────

async function seedUserWithConnect(connectId: string): Promise<string> {
  const c = await db.connect()
  let userId = ''
  try {
    await c.query('BEGIN')
    const { userId: uid } = await seedLandlord(c)
    userId = uid
    await c.query('COMMIT')
  } finally { c.release() }
  await db.query(
    `UPDATE users SET stripe_connect_account_id=$2 WHERE id=$1`,
    [userId, connectId])
  return userId
}

async function seedPmCompanyWithConnect(connectId: string): Promise<string> {
  const c = await db.connect()
  let pmCompanyId = ''
  try {
    await c.query('BEGIN')
    const { userId } = await seedLandlord(c)
    const bankId = await seedUserBankAccount(c, { userId })
    pmCompanyId = await seedPmCompany(c, { bankAccountId: bankId })
    await c.query('COMMIT')
  } finally { c.release() }
  await db.query(
    `UPDATE pm_companies SET stripe_connect_account_id=$2 WHERE id=$1`,
    [pmCompanyId, connectId])
  return pmCompanyId
}

function fakePayout(opts: {
  id?: string
  status?: 'pending' | 'paid' | 'failed' | 'canceled' | 'in_transit'
  amountCents?: number
  arrivalDateUnix?: number | null
  failureCode?: string | null
  failureMessage?: string | null
  destination?: string | null
}): any {
  return {
    id: opts.id ?? 'po_test',
    status: opts.status ?? 'pending',
    amount: opts.amountCents ?? 50000,
    currency: 'usd',
    arrival_date: opts.arrivalDateUnix === undefined ? 1749600000 : opts.arrivalDateUnix,
    destination: opts.destination === undefined ? 'ba_dest' : opts.destination,
    failure_code: opts.failureCode ?? null,
    failure_message: opts.failureMessage ?? null,
  }
}

// ─── recordPayoutEvent ───────────────────────────────────────

describe('recordPayoutEvent — entity resolution', () => {
  it('unknown Connect account → silent noop (no insert)', async () => {
    await recordPayoutEvent(fakePayout({}), 'acct_unknown')
    const { rows } = await db.query(`SELECT COUNT(*)::int AS n FROM connect_payouts`)
    expect(rows[0].n).toBe(0)
  })

  it('user-owned account → inserts with user_id set; pm_company_id NULL', async () => {
    const userId = await seedUserWithConnect('acct_user_match')
    await recordPayoutEvent(fakePayout({ id: 'po_user', status: 'paid' }),
      'acct_user_match')
    const { rows: [row] } = await db.query<any>(
      `SELECT user_id, pm_company_id, amount, status, stripe_account_id, destination_bank_id
         FROM connect_payouts WHERE stripe_payout_id='po_user'`)
    expect(row.user_id).toBe(userId)
    expect(row.pm_company_id).toBeNull()
    expect(Number(row.amount)).toBe(500)
    expect(row.status).toBe('paid')
    expect(row.stripe_account_id).toBe('acct_user_match')
    expect(row.destination_bank_id).toBe('ba_dest')
  })

  it('pm_company-owned account → inserts with pm_company_id set; user_id NULL', async () => {
    const pmCompanyId = await seedPmCompanyWithConnect('acct_pm_match')
    await recordPayoutEvent(fakePayout({ id: 'po_pm', status: 'pending' }),
      'acct_pm_match')
    const { rows: [row] } = await db.query<any>(
      `SELECT user_id, pm_company_id FROM connect_payouts WHERE stripe_payout_id='po_pm'`)
    expect(row.pm_company_id).toBe(pmCompanyId)
    expect(row.user_id).toBeNull()
  })
})

describe('recordPayoutEvent — idempotency + status updates', () => {
  it('ON CONFLICT updates status + arrival_date + failure on re-fire', async () => {
    await seedUserWithConnect('acct_idem')
    await recordPayoutEvent(fakePayout({
      id: 'po_idem', status: 'pending', arrivalDateUnix: 1749600000,
    }), 'acct_idem')
    // Re-fire with a TERMINAL paid status and new arrival date.
    await recordPayoutEvent(fakePayout({
      id: 'po_idem', status: 'paid', arrivalDateUnix: 1749700000,
    }), 'acct_idem')
    const { rows } = await db.query<any>(
      `SELECT status, arrival_date::text FROM connect_payouts WHERE stripe_payout_id='po_idem'`)
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('paid')
  })

  it('failure_code + failure_message persisted on failed status', async () => {
    await seedUserWithConnect('acct_fail')
    await recordPayoutEvent(fakePayout({
      id: 'po_fail', status: 'failed',
      failureCode: 'account_closed',
      failureMessage: 'The bank account is closed.',
    }), 'acct_fail')
    const { rows: [row] } = await db.query<any>(
      `SELECT failure_code, failure_message FROM connect_payouts WHERE stripe_payout_id='po_fail'`)
    expect(row.failure_code).toBe('account_closed')
    expect(row.failure_message).toBe('The bank account is closed.')
  })

  it('null arrival_date supported (Stripe sometimes omits it on early events)', async () => {
    await seedUserWithConnect('acct_no_arrival')
    await recordPayoutEvent(fakePayout({
      id: 'po_no_arrival', status: 'pending', arrivalDateUnix: null,
    }), 'acct_no_arrival')
    const { rows: [row] } = await db.query<any>(
      `SELECT arrival_date FROM connect_payouts WHERE stripe_payout_id='po_no_arrival'`)
    expect(row.arrival_date).toBeNull()
  })
})

describe('recordPayoutEvent — S113-Phase4 disbursements propagation', () => {
  it('paid → disbursements row with matching stripe_payout_id flips to settled + settled_at stamped', async () => {
    const userId = await seedUserWithConnect('acct_disb_paid')
    // Seed a disbursement row tied to this payout id.
    const { rows: [{ id: landlordId }] } = await db.query<{ id: string }>(
      `SELECT id FROM landlords WHERE user_id=$1`, [userId])
    await db.query(
      `INSERT INTO disbursements (landlord_id, amount, status, stripe_payout_id)
       VALUES ($1, 500, 'processing', $2)`,
      [landlordId, 'po_disb_paid'])
    await recordPayoutEvent(fakePayout({ id: 'po_disb_paid', status: 'paid' }),
      'acct_disb_paid')
    const { rows: [d] } = await db.query<any>(
      `SELECT status, settled_at FROM disbursements WHERE stripe_payout_id='po_disb_paid'`)
    expect(d.status).toBe('settled')
    expect(d.settled_at).not.toBeNull()
  })

  it('failed → disbursements row flips to failed + failure note appended', async () => {
    const userId = await seedUserWithConnect('acct_disb_fail')
    const { rows: [{ id: landlordId }] } = await db.query<{ id: string }>(
      `SELECT id FROM landlords WHERE user_id=$1`, [userId])
    await db.query(
      `INSERT INTO disbursements (landlord_id, amount, status, stripe_payout_id)
       VALUES ($1, 500, 'processing', $2)`,
      [landlordId, 'po_disb_fail'])
    await recordPayoutEvent(fakePayout({
      id: 'po_disb_fail', status: 'failed',
      failureCode: 'invalid_routing_number',
      failureMessage: 'Routing number does not exist.',
    }), 'acct_disb_fail')
    const { rows: [d] } = await db.query<any>(
      `SELECT status, notes FROM disbursements WHERE stripe_payout_id='po_disb_fail'`)
    expect(d.status).toBe('failed')
    expect(d.notes).toMatch(/invalid_routing_number/)
    expect(d.notes).toMatch(/Routing number does not exist/)
  })

  it('pending → disbursements flips to processing', async () => {
    const userId = await seedUserWithConnect('acct_disb_pend')
    const { rows: [{ id: landlordId }] } = await db.query<{ id: string }>(
      `SELECT id FROM landlords WHERE user_id=$1`, [userId])
    await db.query(
      `INSERT INTO disbursements (landlord_id, amount, status, stripe_payout_id)
       VALUES ($1, 500, 'pending', $2)`,
      [landlordId, 'po_disb_pend'])
    await recordPayoutEvent(fakePayout({ id: 'po_disb_pend', status: 'pending' }),
      'acct_disb_pend')
    const { rows: [d] } = await db.query<any>(
      `SELECT status FROM disbursements WHERE stripe_payout_id='po_disb_pend'`)
    expect(d.status).toBe('processing')
  })
})

describe('recordPayoutEvent — S175/S176 notifications', () => {
  it('paid + user account → notifyConnectPayoutPaid fires with full args', async () => {
    const userId = await seedUserWithConnect('acct_notify_paid')
    await db.query(`UPDATE users SET email='u@example.com', phone='+15555550001' WHERE id=$1`, [userId])
    await recordPayoutEvent(fakePayout({ id: 'po_notify_paid', status: 'paid' }),
      'acct_notify_paid')
    expect(notifyConnectPayoutPaidMock).toHaveBeenCalledWith(expect.objectContaining({
      userId,
      userEmail: 'u@example.com',
      userPhone: '+15555550001',
      amount: 500,
      stripePayoutId: 'po_notify_paid',
    }))
    expect(notifyConnectPayoutFailedMock).not.toHaveBeenCalled()
  })

  it('failed + user account → notifyConnectPayoutFailed fires with reason + failureCode', async () => {
    const userId = await seedUserWithConnect('acct_notify_fail')
    await db.query(`UPDATE users SET email='u@example.com' WHERE id=$1`, [userId])
    await recordPayoutEvent(fakePayout({
      id: 'po_notify_fail', status: 'failed',
      failureCode: 'no_account', failureMessage: 'Account does not exist.',
    }), 'acct_notify_fail')
    expect(notifyConnectPayoutFailedMock).toHaveBeenCalledWith(expect.objectContaining({
      userId,
      reason: 'Account does not exist.',
      failureCode: 'no_account',
    }))
  })

  it('paid + pm_company → notifyPmCompanyPayoutPaid fires', async () => {
    const pmCompanyId = await seedPmCompanyWithConnect('acct_pm_paid')
    await recordPayoutEvent(fakePayout({ id: 'po_pm_paid', status: 'paid' }),
      'acct_pm_paid')
    expect(notifyPmCompanyPayoutPaidMock).toHaveBeenCalledWith(expect.objectContaining({
      pmCompanyId,
      amount: 500,
      stripePayoutId: 'po_pm_paid',
    }))
    expect(notifyConnectPayoutPaidMock).not.toHaveBeenCalled()
  })

  it('failed + pm_company → notifyPmCompanyPayoutFailed fires', async () => {
    const pmCompanyId = await seedPmCompanyWithConnect('acct_pm_fail')
    await recordPayoutEvent(fakePayout({
      id: 'po_pm_fail', status: 'failed',
      failureCode: 'bank_blocked', failureMessage: 'Bank blocked transfer.',
    }), 'acct_pm_fail')
    expect(notifyPmCompanyPayoutFailedMock).toHaveBeenCalledWith(expect.objectContaining({
      pmCompanyId,
      reason: 'Bank blocked transfer.',
      failureCode: 'bank_blocked',
    }))
  })

  it('non-terminal status (pending) → no notification', async () => {
    await seedUserWithConnect('acct_pend_notify')
    await recordPayoutEvent(fakePayout({ id: 'po_pend', status: 'pending' }),
      'acct_pend_notify')
    expect(notifyConnectPayoutPaidMock).not.toHaveBeenCalled()
    expect(notifyConnectPayoutFailedMock).not.toHaveBeenCalled()
  })

  it('notification call throws → swallowed (webhook does not fail)', async () => {
    await seedUserWithConnect('acct_notify_throw')
    notifyConnectPayoutPaidMock.mockRejectedValueOnce(new Error('SMS service down'))
    // Function must complete without rejecting; row still gets written.
    await expect(recordPayoutEvent(
      fakePayout({ id: 'po_throw', status: 'paid' }), 'acct_notify_throw',
    )).resolves.toBeUndefined()
    const { rows } = await db.query(
      `SELECT COUNT(*)::int AS n FROM connect_payouts WHERE stripe_payout_id='po_throw'`)
    expect(rows[0].n).toBe(1)
  })
})

// ─── recordDisputeEvent ──────────────────────────────────────

describe('recordDisputeEvent', () => {
  interface DisputeCtx {
    paymentId: string
    landlordId: string
    paymentIntentId: string
    chargeId: string
  }

  async function seedDisputableCtx(piId: string, chargeId: string): Promise<DisputeCtx> {
    const c = await db.connect()
    let paymentId = ''
    let landlordId = ''
    try {
      await c.query('BEGIN')
      const { userId, landlordId: lid } = await seedLandlord(c)
      landlordId = lid
      const propertyId = await seedProperty(c, {
        landlordId, ownerUserId: userId, managedByUserId: userId,
      })
      const unitId = await seedUnit(c, { propertyId, landlordId })
      const tenantId = await seedTenant(c)
      const { rows: [{ id }] } = await c.query<{ id: string }>(
        `INSERT INTO payments
           (unit_id, tenant_id, landlord_id, type, amount, status,
            entry_description, due_date,
            stripe_payment_intent_id, stripe_charge_id)
         VALUES ($1, $2, $3, 'rent', 1000, 'settled', 'RENT', CURRENT_DATE, $4, $5)
         RETURNING id`,
        [unitId, tenantId, landlordId, piId, chargeId])
      paymentId = id
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e }
    finally { c.release() }
    return { paymentId, landlordId, paymentIntentId: piId, chargeId }
  }

  function fakeDispute(opts: {
    id?: string
    chargeIdOrObj?: string | { id: string }
    paymentIntentIdOrObj?: string | { id: string } | null
    status?: string
    reason?: string | null
    amountCents?: number
    evidenceDueByUnix?: number | null
  }): any {
    return {
      id: opts.id ?? 'dp_test',
      charge: opts.chargeIdOrObj ?? 'ch_test',
      payment_intent: opts.paymentIntentIdOrObj === undefined ? 'pi_test' : opts.paymentIntentIdOrObj,
      status: opts.status ?? 'needs_response',
      reason: opts.reason === undefined ? 'fraudulent' : opts.reason,
      amount: opts.amountCents ?? 100000,
      currency: 'usd',
      evidence_details: opts.evidenceDueByUnix === null
        ? undefined
        : { due_by: opts.evidenceDueByUnix ?? 1749700000 },
    }
  }

  it('happy: inserts with payment_id + landlord_id resolved via stripe_payment_intent_id', async () => {
    const ctx = await seedDisputableCtx('pi_disp_happy', 'ch_disp_happy')
    await recordDisputeEvent(fakeDispute({
      id: 'dp_happy', chargeIdOrObj: 'ch_disp_happy',
      paymentIntentIdOrObj: 'pi_disp_happy',
    }))
    const { rows: [row] } = await db.query<any>(
      `SELECT payment_id, landlord_id, amount, status, reason,
              stripe_charge_id, stripe_payment_intent_id, evidence_due_by
         FROM connect_disputes WHERE stripe_dispute_id='dp_happy'`)
    expect(row.payment_id).toBe(ctx.paymentId)
    expect(row.landlord_id).toBe(ctx.landlordId)
    expect(Number(row.amount)).toBe(1000)
    expect(row.status).toBe('needs_response')
    expect(row.reason).toBe('fraudulent')
    expect(row.stripe_charge_id).toBe('ch_disp_happy')
    expect(row.stripe_payment_intent_id).toBe('pi_disp_happy')
    expect(row.evidence_due_by).not.toBeNull()
  })

  it('payment_intent as expandable object → extracts .id and resolves', async () => {
    const ctx = await seedDisputableCtx('pi_disp_obj', 'ch_disp_obj')
    await recordDisputeEvent(fakeDispute({
      id: 'dp_obj_pi',
      chargeIdOrObj: 'ch_disp_obj',
      paymentIntentIdOrObj: { id: 'pi_disp_obj' } as any,
    }))
    const { rows: [row] } = await db.query<any>(
      `SELECT payment_id FROM connect_disputes WHERE stripe_dispute_id='dp_obj_pi'`)
    expect(row.payment_id).toBe(ctx.paymentId)
  })

  it('charge as expandable object → extracts .id into stripe_charge_id', async () => {
    await recordDisputeEvent(fakeDispute({
      id: 'dp_obj_charge',
      chargeIdOrObj: { id: 'ch_extracted' } as any,
      paymentIntentIdOrObj: null,
    }))
    const { rows: [row] } = await db.query<any>(
      `SELECT stripe_charge_id FROM connect_disputes WHERE stripe_dispute_id='dp_obj_charge'`)
    expect(row.stripe_charge_id).toBe('ch_extracted')
  })

  it('no payment_intent → payment_id + landlord_id NULL (orphan dispute)', async () => {
    await recordDisputeEvent(fakeDispute({
      id: 'dp_orphan', paymentIntentIdOrObj: null,
    }))
    const { rows: [row] } = await db.query<any>(
      `SELECT payment_id, landlord_id FROM connect_disputes WHERE stripe_dispute_id='dp_orphan'`)
    expect(row.payment_id).toBeNull()
    expect(row.landlord_id).toBeNull()
  })

  it('idempotent on stripe_dispute_id: ON CONFLICT updates status + evidence_due_by', async () => {
    await recordDisputeEvent(fakeDispute({
      id: 'dp_idem', status: 'needs_response',
      evidenceDueByUnix: 1749700000,
    }))
    await recordDisputeEvent(fakeDispute({
      id: 'dp_idem', status: 'won',
      evidenceDueByUnix: 1749800000,
    }))
    const { rows } = await db.query<any>(
      `SELECT status, evidence_due_by::text FROM connect_disputes WHERE stripe_dispute_id='dp_idem'`)
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('won')
  })
})

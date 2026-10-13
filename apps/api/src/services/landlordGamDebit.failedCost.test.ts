/**
 * 10/12 (Nic, G1): "gam eats no fees of failed pulls ever." Whatever a failed
 * or returned bank pull of GAM's fees actually cost GAM is owed by the
 * landlord — on the spot or on a later return alike — billed at cost as its
 * own GAM charge ('bank_debit_failed_cost'), and the pull's own $6 price is
 * taken back (voided, kept).
 */
import { describe, it, expect, beforeAll, beforeEach, vi, afterEach } from 'vitest'
import { query, getClient } from '../db'
import { seedLandlord } from '../test/dbHelpers'
import { chargeLandlord, outstandingForLandlord } from './landlordGamAccount'

let landlordId: string

const owe = (amount: number, sourceId: string) =>
  chargeLandlord(null, { landlordId, kind: 'subscription', amount, sourceType: 'test_fee', sourceId })

async function withLinkedBank() {
  await query(
    `UPDATE landlords SET gam_debit_payment_method_id = 'pm_test_bank', stripe_fc_customer_id = 'cus_test' WHERE id = $1`,
    [landlordId])
}

/** A Stripe whose failed debit cost `debitFee` + `failureFee` cents. */
function stripeWith(o: {
  retrieve?: (id: string, params?: any) => Promise<any>
  create?: (...a: any[]) => Promise<any>
}) {
  const retrieve = vi.fn(o.retrieve ?? (async () => ({ latest_charge: null })))
  const create = vi.fn(o.create ?? (async () => ({ id: 'pi_made', status: 'processing' })))
  vi.resetModules()
  vi.doMock('../lib/stripe', () => ({ getStripe: () => ({ paymentIntents: { retrieve, create, search: async () => ({ data: [] }) } }) }))
  return { retrieve, create }
}
const failedCharge = (debitFee: number, failureFee: number) => async () => ({
  latest_charge: {
    id: 'ch_1',
    balance_transaction: { id: 'txn_1', fee: debitFee },
    failure_balance_transaction: { id: 'txn_2', fee: failureFee },
  },
})

beforeAll(async () => {
  const client = await getClient()
  try { ({ landlordId } = await seedLandlord(client)) } finally { client.release() }
})
beforeEach(async () => {
  await query(`DELETE FROM landlord_gam_charge_collections`)
  await query(`UPDATE landlord_gam_debits SET failure_cost_charge_id = NULL WHERE landlord_id = $1`, [landlordId])
  await query(`DELETE FROM landlord_gam_debits WHERE landlord_id = $1`, [landlordId])
  await query(`DELETE FROM landlord_gam_charges WHERE landlord_id = $1`, [landlordId])
  await query(`DELETE FROM admin_notifications WHERE category LIKE 'gam_debit%'`)
})
afterEach(() => { vi.doUnmock('../lib/stripe') })

describe('what a failed pull cost (failedPullCostCents)', () => {
  it('is the debit\'s own fee plus the failure fee, and nothing when no charge was ever made', async () => {
    const { failedPullCostCents } = await import('./landlordGamDebit')
    expect(await failedPullCostCents({ paymentIntents: { retrieve: failedCharge(80, 400) } }, 'pi_x')).toBe(480)
    expect(await failedPullCostCents({ paymentIntents: { retrieve: async () => ({ latest_charge: null }) } }, 'pi_x')).toBe(0)
    // A fee Stripe gave back on the failure lowers it; never below zero.
    expect(await failedPullCostCents({ paymentIntents: { retrieve: failedCharge(80, -80) } }, 'pi_x')).toBe(0)
    // An answer GAM cannot read is not "nothing": it throws and is asked again.
    await expect(failedPullCostCents({ paymentIntents: { retrieve: async () => ({ latest_charge: 'ch_unexpanded' }) } }, 'pi_x'))
      .rejects.toThrow()
  })
})

describe('a pull the bank returned days later', () => {
  it('bills the landlord what it actually cost, takes back its $6, and keeps the charges owed', async () => {
    const { retrieve } = stripeWith({ retrieve: failedCharge(80, 400) })
    const mod = await import('./landlordGamDebit')
    await withLinkedBank()
    await owe(150, 'f1111111-1111-1111-1111-111111111111')
    const out = await mod.debitLandlordForCharges(landlordId)
    expect(out).toMatchObject({ status: 'debited', chargesAmount: 150, bankCost: 6, total: 156 })

    await mod.settleGamDebit('pi_made', false, 'R01 insufficient funds', out.debitId)
    expect(retrieve).toHaveBeenCalledWith('pi_made', expect.objectContaining({ expand: expect.any(Array) }))

    const lines = await query<any>(
      `SELECT kind, amount::text AS amount, voided_at IS NOT NULL AS voided, void_reason, source_type, source_id
         FROM landlord_gam_charges WHERE landlord_id = $1 ORDER BY created_at, kind`, [landlordId])
    expect(lines.find((l: any) => l.kind === 'bank_debit_cost')).toMatchObject({ voided: true, void_reason: 'bank_debit_failed' })
    expect(lines.find((l: any) => l.kind === 'bank_debit_failed_cost')).toMatchObject({
      amount: '4.80', voided: false, source_type: 'gam_bank_debit_failed', source_id: out.debitId })
    // Owed now: the $150 of fees (the pull failed) and the $4.80 it cost — not the $6.
    expect(await outstandingForLandlord(landlordId)).toBe(154.8)
    const [d] = await query<any>(
      `SELECT status, failure_cost_amount::text AS cost, failure_cost_charge_id IS NOT NULL AS billed
         FROM landlord_gam_debits WHERE id = $1`, [out.debitId])
    expect(d).toEqual({ status: 'failed', cost: '4.80', billed: true })

    // A replayed failure webhook bills nothing more.
    await mod.settleGamDebit('pi_made', false, 'R01 insufficient funds', out.debitId)
    const n = await query(`SELECT 1 FROM landlord_gam_charges WHERE landlord_id = $1 AND kind = 'bank_debit_failed_cost'`, [landlordId])
    expect(n).toHaveLength(1)
  })

  it('when Stripe cannot be read at the failure, nothing is billed yet — the sweep reads it and bills it once', async () => {
    stripeWith({ retrieve: async () => { throw Object.assign(new Error('Request timed out'), { type: 'StripeConnectionError' }) } })
    let mod = await import('./landlordGamDebit')
    await withLinkedBank()
    await owe(150, 'f2222222-1111-1111-1111-111111111111')
    const out = await mod.debitLandlordForCharges(landlordId)
    await mod.settleGamDebit('pi_made', false, 'R01', out.debitId)
    const [before] = await query<any>(`SELECT failure_cost_read_at FROM landlord_gam_debits WHERE id = $1`, [out.debitId])
    expect(before.failure_cost_read_at).toBeNull()
    expect(await query(`SELECT 1 FROM landlord_gam_charges WHERE kind = 'bank_debit_failed_cost' AND landlord_id = $1`, [landlordId]))
      .toHaveLength(0)

    stripeWith({ retrieve: failedCharge(0, 400) })
    mod = await import('./landlordGamDebit')
    expect(await mod.readFailedPullCosts()).toMatchObject({ read: 1 })
    expect(await mod.readFailedPullCosts()).toMatchObject({ considered: 0 })
    const rows = await query<any>(
      `SELECT amount::text AS amount FROM landlord_gam_charges WHERE kind = 'bank_debit_failed_cost' AND landlord_id = $1`, [landlordId])
    expect(rows).toEqual([{ amount: '4.00' }])
  })

  it('a pull still unread after a few days tells an admin, once', async () => {
    stripeWith({ retrieve: async () => { throw Object.assign(new Error('Stripe is down'), { type: 'StripeAPIError', statusCode: 500 }) } })
    const mod = await import('./landlordGamDebit')
    const [d] = await query<{ id: string }>(
      `INSERT INTO landlord_gam_debits (landlord_id, charges_amount, bank_cost_amount, total_amount, status,
                                        stripe_payment_intent_id, settled_at, updated_at)
       VALUES ($1, 100, 6, 106, 'failed', 'pi_old_fail', NOW() - INTERVAL '5 days', NOW() - INTERVAL '5 days') RETURNING id`,
      [landlordId])
    await mod.readFailedPullCosts()
    await mod.readFailedPullCosts()
    const told = await query<any>(`SELECT context->>'debit_id' AS id FROM admin_notifications WHERE category = 'gam_debit_failed_cost_unread'`)
    expect(told).toEqual([{ id: d.id }])
  })
})

describe('a pull refused on the spot', () => {
  it('that Stripe made and failed: its cost is billed; one it never made cost nothing', async () => {
    // Refused with the failed intent in the error: it cost a fee.
    stripeWith({
      create: async () => { throw Object.assign(new Error('Your bank declined the debit'), {
        type: 'StripeCardError', statusCode: 402, raw: { payment_intent: { id: 'pi_refused' } } }) },
      retrieve: failedCharge(0, 150),
    })
    let mod = await import('./landlordGamDebit')
    await withLinkedBank()
    await owe(150, 'f3333333-1111-1111-1111-111111111111')
    const first = await mod.debitLandlordForCharges(landlordId)
    expect(first).toMatchObject({ status: 'skipped', reason: 'stripe_failed' })
    const [d1] = await query<any>(
      `SELECT stripe_payment_intent_id AS pi, failure_cost_amount::text AS cost FROM landlord_gam_debits WHERE id = $1`, [first.debitId])
    expect(d1).toEqual({ pi: 'pi_refused', cost: '1.50' })

    // Refused outright, nothing made (the S652 mandate refusal): $0, nothing billed.
    stripeWith({
      create: async () => { throw Object.assign(new Error('requires a mandate'), { type: 'StripeInvalidRequestError', statusCode: 400 }) },
    })
    mod = await import('./landlordGamDebit')
    const second = await mod.debitLandlordForCharges(landlordId)
    const [d2] = await query<any>(
      `SELECT failure_cost_amount::text AS cost, failure_cost_charge_id FROM landlord_gam_debits WHERE id = $1`, [second.debitId])
    expect(d2).toEqual({ cost: '0.00', failure_cost_charge_id: null })
    const costs = await query<any>(
      `SELECT amount::text AS amount FROM landlord_gam_charges WHERE kind = 'bank_debit_failed_cost' AND landlord_id = $1`, [landlordId])
    expect(costs).toEqual([{ amount: '1.50' }])
    // Both $6 lines were taken back as never made; kept on file.
    const sixes = await query<any>(
      `SELECT void_reason FROM landlord_gam_charges WHERE kind = 'bank_debit_cost' AND landlord_id = $1`, [landlordId])
    expect(sixes.map((r: any) => r.void_reason)).toEqual(['bank_debit_not_made', 'bank_debit_not_made'])
  })
})

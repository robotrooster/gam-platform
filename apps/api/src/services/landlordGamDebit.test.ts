/**
 * S651: the last-resort bank pull for an all-cash property, and the rule that
 * makes it arguable-with rather than disputable.
 *
 * Nic (S650): "Never ACH-debit a landlord by default — take it out of the money
 * flowing through. When the debit is built for all-cash properties, the bank
 * cost is its own line item so the landlord doesn't dispute the charge."
 *
 * The gates are what this file is mostly about. A debit that fires when it
 * should not have is not a bug you find in staging — it is money out of
 * somebody's bank account, and the first person to notice is them.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { query, getClient } from '../db'
import { seedLandlord } from '../test/dbHelpers'
import { chargeLandlord } from './landlordGamAccount'
import {
  bankCostFor, debitLandlordForCharges, settleGamDebit,
  ACH_DEBIT_RATE, ACH_DEBIT_CAP,
} from './landlordGamDebit'

let landlordId: string

const owe = (amount: number, sourceId: string) =>
  chargeLandlord(null, {
    landlordId, kind: 'subscription', amount,
    sourceType: 'test_fee', sourceId,
  })

/** Put the landlord in the one state where a debit is allowed to happen. */
async function authorize() {
  await query(
    `UPDATE landlords
        SET gam_debit_authorized_at = NOW(), gam_debit_revoked_at = NULL,
            gam_debit_payment_method_id = 'pm_test_bank',
            stripe_fc_customer_id = 'cus_test'
      WHERE id = $1`, [landlordId])
}

describe('what the bank pull costs', () => {
  it('is Stripe’s published ACH price', () => {
    expect(bankCostFor(130)).toBe(Math.round(130 * ACH_DEBIT_RATE * 100) / 100)
    expect(bankCostFor(130)).toBe(1.04)
  })

  it('never exceeds the cap, however big the debt', () => {
    // 0.8% of $10,000 would be $80; Stripe caps ACH debit at $5.
    expect(bankCostFor(10_000)).toBe(ACH_DEBIT_CAP)
  })

  it('is nothing when nothing is owed', () => {
    expect(bankCostFor(0)).toBe(0)
    expect(bankCostFor(-5)).toBe(0)
  })
})

describe('the gates on a landlord debit', () => {
  beforeAll(async () => {
    const client = await getClient()
    try { ({ landlordId } = await seedLandlord(client)) } finally { client.release() }
  })

  beforeEach(async () => {
    await query(`DELETE FROM landlord_gam_debits WHERE landlord_id = $1`, [landlordId])
    await query(`DELETE FROM landlord_gam_charges WHERE landlord_id = $1`, [landlordId])
    await query(
      `UPDATE landlords
          SET gam_debit_authorized_at = NULL, gam_debit_revoked_at = NULL,
              gam_debit_payment_method_id = NULL
        WHERE id = $1`, [landlordId])
  })

  it('refuses when the landlord never authorized it — the default', async () => {
    await owe(500, '11111111-1111-1111-1111-111111111111')
    const out = await debitLandlordForCharges(landlordId)
    expect(out).toEqual({ status: 'skipped', reason: 'not_authorized' })
  })

  it('refuses after the authorization is revoked', async () => {
    await authorize()
    await query(
      `UPDATE landlords SET gam_debit_revoked_at = NOW() WHERE id = $1`, [landlordId])
    await owe(500, '22222222-2222-2222-2222-222222222222')
    expect((await debitLandlordForCharges(landlordId)).reason).toBe('not_authorized')
  })

  it('refuses when the balance is under the property threshold', async () => {
    // Carrying $20 to next month is cheaper than a bank pull. That is the
    // whole reason the threshold exists.
    await authorize()
    await owe(20, '33333333-3333-3333-3333-333333333333')
    expect((await debitLandlordForCharges(landlordId)).reason).toBe('under_threshold')
  })

  it('refuses when nothing is owed', async () => {
    await authorize()
    expect((await debitLandlordForCharges(landlordId)).reason).toBe('nothing_owed')
  })

  it('refuses while a pull is still settling', async () => {
    // ACH takes days. A daily job that cannot see yesterday's pull would take
    // the same fees again on day two — and the landlord would be down twice.
    await authorize()
    await owe(500, '44444444-4444-4444-4444-444444444444')
    await query(
      `INSERT INTO landlord_gam_debits
         (landlord_id, charges_amount, bank_cost_amount, total_amount, status)
       VALUES ($1, 500, 4, 504, 'pending')`, [landlordId])
    expect((await debitLandlordForCharges(landlordId)).reason).toBe('debit_in_flight')
  })
})

describe('settling a pull', () => {
  beforeAll(async () => {
    const client = await getClient()
    try { ({ landlordId } = await seedLandlord(client)) } finally { client.release() }
  })
  beforeEach(async () => {
    await query(`DELETE FROM landlord_gam_debits WHERE landlord_id = $1`, [landlordId])
    await query(`DELETE FROM landlord_gam_charges WHERE landlord_id = $1`, [landlordId])
  })

  it('marks the charges collected only when the money actually lands', async () => {
    const chargeId = await owe(130, '55555555-5555-5555-5555-555555555555')
    await query(
      `INSERT INTO landlord_gam_debits
         (landlord_id, charges_amount, bank_cost_amount, total_amount, status,
          stripe_payment_intent_id, charge_ids)
       VALUES ($1, 130, 1.04, 131.04, 'pending', 'pi_ok', ARRAY[$2::uuid])`,
      [landlordId, chargeId])

    await settleGamDebit('pi_ok', true)

    const [c] = await query<any>(
      `SELECT collected_amount::text AS collected, collected_at
         FROM landlord_gam_charges WHERE id = $1`, [chargeId])
    expect(parseFloat(c.collected)).toBe(130)
    expect(c.collected_at).toBeTruthy()
  })

  it('leaves the charges owed when the bank refuses', async () => {
    // The pull bouncing days later must not leave a fee marked paid — next
    // month's would accrue on top of a debt that never cleared.
    const chargeId = await owe(130, '66666666-6666-6666-6666-666666666666')
    await query(
      `INSERT INTO landlord_gam_debits
         (landlord_id, charges_amount, bank_cost_amount, total_amount, status,
          stripe_payment_intent_id, charge_ids)
       VALUES ($1, 130, 1.04, 131.04, 'pending', 'pi_nsf', ARRAY[$2::uuid])`,
      [landlordId, chargeId])

    await settleGamDebit('pi_nsf', false, 'insufficient funds')

    const [c] = await query<any>(
      `SELECT collected_amount::text AS collected FROM landlord_gam_charges WHERE id = $1`,
      [chargeId])
    expect(parseFloat(c.collected)).toBe(0)
    const [d] = await query<any>(
      `SELECT status, failure_reason FROM landlord_gam_debits WHERE stripe_payment_intent_id = 'pi_nsf'`)
    expect(d.status).toBe('failed')
    expect(d.failure_reason).toContain('insufficient funds')
  })

  it('ignores a webhook replayed after the debit already settled', async () => {
    const chargeId = await owe(130, '77777777-7777-7777-7777-777777777777')
    await query(
      `INSERT INTO landlord_gam_debits
         (landlord_id, charges_amount, bank_cost_amount, total_amount, status,
          stripe_payment_intent_id, charge_ids)
       VALUES ($1, 130, 1.04, 131.04, 'succeeded', 'pi_dupe', ARRAY[$2::uuid])`,
      [landlordId, chargeId])

    await settleGamDebit('pi_dupe', false, 'late failure')

    const [d] = await query<any>(
      `SELECT status FROM landlord_gam_debits WHERE stripe_payment_intent_id = 'pi_dupe'`)
    expect(d.status).toBe('succeeded')
  })
})

describe('the bank cost is charged as its own line', () => {
  beforeAll(async () => {
    const client = await getClient()
    try { ({ landlordId } = await seedLandlord(client)) } finally { client.release() }
  })
  beforeEach(async () => {
    await query(`DELETE FROM landlord_gam_debits WHERE landlord_id = $1`, [landlordId])
    await query(`DELETE FROM landlord_gam_charges WHERE landlord_id = $1`, [landlordId])
  })

  it('writes a bank_debit_cost charge beside the fees, not folded into them', async () => {
    // Nic's whole point: two numbers the landlord can each check, rather than
    // one $131.04 that matches no invoice they hold.
    vi.resetModules()
    vi.doMock('../lib/stripe', () => ({
      getStripe: () => ({
        paymentIntents: { create: async () => ({ id: 'pi_created' }) },
      }),
    }))
    const { debitLandlordForCharges: debit } = await import('./landlordGamDebit')

    await authorize()
    await owe(130, '88888888-8888-8888-8888-888888888888')
    const out = await debit(landlordId)

    expect(out.status).toBe('debited')
    expect(out.chargesAmount).toBe(130)
    expect(out.bankCost).toBe(1.04)
    expect(out.total).toBe(131.04)

    const lines = await query<any>(
      `SELECT kind, amount::text AS amount FROM landlord_gam_charges
        WHERE landlord_id = $1 ORDER BY created_at`, [landlordId])
    expect(lines.map((l: any) => l.kind)).toEqual(['subscription', 'bank_debit_cost'])
    expect(parseFloat(lines[1].amount)).toBe(1.04)
    vi.doUnmock('../lib/stripe')
  })
})

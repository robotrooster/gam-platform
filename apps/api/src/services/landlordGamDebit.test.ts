/**
 * S651: the last-resort bank pull for an all-cash property, and the rule that
 * makes it arguable-with rather than disputable.
 *
 * Nic (S650): "Never ACH-debit a landlord by default — take it out of the money
 * flowing through. When the debit is built for all-cash properties, the bank
 * cost is its own line item so the landlord doesn't dispute the charge."
 *
 * "By default" means not first, NOT optional. Nic, on a draft that had a
 * consent toggle: "That's not a landlord choice to fucking pay us. It's
 * mandatory." So there is no test here for refusing an unwilling landlord —
 * there is no such state. What IS tested is that it cannot fire twice, cannot
 * fire under the threshold, and cannot mark a fee paid before the money lands.
 * Each of those is real money out of somebody's account, and the first person
 * to notice would be them.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { query, getClient } from '../db'
import { seedLandlord } from '../test/dbHelpers'
import { chargeLandlord } from './landlordGamAccount'
import { PROCESSING_FEES } from '@gam/shared'
import {
  bankCostFor, debitLandlordForCharges, settleGamDebit, ACH_DEBIT_FLAT,
} from './landlordGamDebit'

let landlordId: string

const owe = (amount: number, sourceId: string) =>
  chargeLandlord(null, {
    landlordId, kind: 'subscription', amount,
    sourceType: 'test_fee', sourceId,
  })

/**
 * Give the landlord a bank GAM can reach. Not consent — plumbing. Without a
 * usable link the pull cannot happen at all, which is its own tested case.
 */
async function withLinkedBank() {
  await query(
    `UPDATE landlords
        SET gam_debit_payment_method_id = 'pm_test_bank',
            stripe_fc_customer_id = 'cus_test'
      WHERE id = $1`, [landlordId])
}

describe('what the bank transfer costs', () => {
  it('is $6 — GAM has one ACH price and this is not allowed to be a second one', () => {
    // Nic: "Our ACH cost is fucking $6 flat." Pinned against the shared
    // schedule rather than a literal, so this fails loudly if the two ever
    // drift apart. (memory: gam-ach-fee-schedule-untouchable)
    expect(bankCostFor(130)).toBe(6)
    expect(ACH_DEBIT_FLAT).toBe(PROCESSING_FEES.ACH_FLAT)
  })

  it('is the same $6 at any size — no percentage, no cap, no second answer', () => {
    expect(bankCostFor(48)).toBe(6)
    expect(bankCostFor(82)).toBe(6)
    expect(bankCostFor(10_000)).toBe(6)
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
      `UPDATE landlords SET gam_debit_payment_method_id = NULL WHERE id = $1`, [landlordId])
  })

  it('refuses when the balance is under the property threshold', async () => {
    // Carrying $20 to next month is cheaper than a bank pull. That is the
    // whole reason the threshold exists, and it is the only reason a solvent
    // debt is ever left uncollected.
    await withLinkedBank()
    await owe(20, '33333333-3333-3333-3333-333333333333')
    expect((await debitLandlordForCharges(landlordId)).reason).toBe('under_threshold')
  })

  it('refuses when nothing is owed', async () => {
    await withLinkedBank()
    expect((await debitLandlordForCharges(landlordId)).reason).toBe('nothing_owed')
  })

  it('refuses while a pull is still settling', async () => {
    // ACH takes days. A daily job that cannot see yesterday's pull would take
    // the same fees again on day two — and the landlord would be down twice.
    await withLinkedBank()
    await owe(500, '44444444-4444-4444-4444-444444444444')
    await query(
      `INSERT INTO landlord_gam_debits
         (landlord_id, charges_amount, bank_cost_amount, total_amount, status)
       VALUES ($1, 500, 4, 504, 'pending')`, [landlordId])
    expect((await debitLandlordForCharges(landlordId)).reason).toBe('debit_in_flight')
  })

  it('reports an uncollectable landlord rather than writing the debt off', async () => {
    // No bank GAM can reach. The fee is still owed — this is a collection
    // failure somebody has to act on, not an exemption the landlord earned by
    // never linking an account.
    await owe(500, '99999999-9999-9999-9999-999999999999')
    const out = await debitLandlordForCharges(landlordId)
    expect(out.reason).toBe('no_bank_link')

    const [c] = await query<any>(
      `SELECT collected_amount::text AS collected FROM landlord_gam_charges
        WHERE landlord_id = $1`, [landlordId])
    expect(parseFloat(c.collected)).toBe(0)
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
    const chargeId = await owe(82, '55555555-5555-5555-5555-555555555555')
    await query(
      `INSERT INTO landlord_gam_debits
         (landlord_id, charges_amount, bank_cost_amount, total_amount, status,
          stripe_payment_intent_id, charge_ids)
       VALUES ($1, 82, 6, 88, 'pending', 'pi_ok', ARRAY[$2::uuid])`,
      [landlordId, chargeId])

    await settleGamDebit('pi_ok', true)

    const [c] = await query<any>(
      `SELECT collected_amount::text AS collected, collected_at
         FROM landlord_gam_charges WHERE id = $1`, [chargeId])
    expect(parseFloat(c.collected)).toBe(82)
    expect(c.collected_at).toBeTruthy()
  })

  it('leaves the charges owed when the bank refuses', async () => {
    // The pull bouncing days later must not leave a fee marked paid — next
    // month's would accrue on top of a debt that never cleared.
    const chargeId = await owe(82, '66666666-6666-6666-6666-666666666666')
    await query(
      `INSERT INTO landlord_gam_debits
         (landlord_id, charges_amount, bank_cost_amount, total_amount, status,
          stripe_payment_intent_id, charge_ids)
       VALUES ($1, 82, 6, 88, 'pending', 'pi_nsf', ARRAY[$2::uuid])`,
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
    const chargeId = await owe(82, '77777777-7777-7777-7777-777777777777')
    await query(
      `INSERT INTO landlord_gam_debits
         (landlord_id, charges_amount, bank_cost_amount, total_amount, status,
          stripe_payment_intent_id, charge_ids)
       VALUES ($1, 82, 6, 88, 'succeeded', 'pi_dupe', ARRAY[$2::uuid])`,
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

    // Two months of Mountain View's platform fee ($82 for 41 spots), which is
    // how an all-cash park actually reaches the $100 threshold — one month
    // alone never does, and that is the design working.
    await withLinkedBank()
    await owe(82, '88888888-8888-8888-8888-888888888888')
    await owe(82, '88888888-8888-8888-8888-888888888889')
    const out = await debit(landlordId)

    expect(out.status).toBe('debited')
    expect(out.chargesAmount).toBe(164)
    expect(out.bankCost).toBe(6)
    expect(out.total).toBe(170)

    const lines = await query<any>(
      `SELECT kind, amount::text AS amount FROM landlord_gam_charges
        WHERE landlord_id = $1 ORDER BY created_at`, [landlordId])
    // The transfer's $6 is its OWN row, not folded into either fee.
    expect(lines.map((l: any) => l.kind))
      .toEqual(['subscription', 'subscription', 'bank_debit_cost'])
    expect(parseFloat(lines[2].amount)).toBe(6)
    vi.doUnmock('../lib/stripe')
  })
})

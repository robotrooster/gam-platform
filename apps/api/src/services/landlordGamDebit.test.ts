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
import { outstandingForLandlord } from './landlordGamAccount'

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
    await query(`DELETE FROM landlord_gam_charge_collections`)
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
         (landlord_id, charges_amount, bank_cost_amount, total_amount, status, stripe_payment_intent_id)
       VALUES ($1, 500, 4, 504, 'pending', 'pi_settling')`, [landlordId])
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
    await query(`DELETE FROM landlord_gam_charge_collections`)
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

  it('records what the pull collected on each charge, against the pull (10/12, ledger P0)', async () => {
    // A charge half-netted from a payout before the pull: the pull collects
    // only the half still owed, and its records add up to what it pulled.
    const fee = (await owe(48, '5aaaaaaa-5555-5555-5555-555555555555'))!
    await query(`UPDATE landlord_gam_charges SET collected_amount = 20 WHERE id = $1`, [fee])
    const cost = (await chargeLandlord(null, {
      landlordId, kind: 'bank_debit_cost', amount: 6, sourceType: 'gam_bank_debit_cost', sourceId: null,
    }))!
    const [d] = await query<{ id: string }>(
      `INSERT INTO landlord_gam_debits
         (landlord_id, charges_amount, bank_cost_amount, total_amount, status,
          stripe_payment_intent_id, charge_ids)
       VALUES ($1, 28, 6, 34, 'pending', 'pi_rec', $2) RETURNING id`,
      [landlordId, [fee, cost]])

    await settleGamDebit('pi_rec', true)
    await settleGamDebit('pi_rec', true)   // a replay records nothing more

    const rows = await query<any>(
      `SELECT charge_id, amount::text AS amount, landlord_gam_debit_id, platform_transfer_intent_id
         FROM landlord_gam_charge_collections c ORDER BY c.amount DESC`)
    expect(rows).toEqual([
      { charge_id: fee, amount: '28.00', landlord_gam_debit_id: d.id, platform_transfer_intent_id: null },
      { charge_id: cost, amount: '6.00', landlord_gam_debit_id: d.id, platform_transfer_intent_id: null },
    ])
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

  // 10/3 (Nic's admin cards): the $6 that paid for the pull is GAM's
  // processing revenue. Stripe's fee on the pull was always counted as a cost;
  // the $6 was counted nowhere.
  it('books the $6 bank cost as GAM\'s processing revenue when the money lands — once, however often the webhook comes', async () => {
    const chargeId = await owe(48, '99999999-5555-5555-5555-555555555555')
    const [d] = await query<{ id: string }>(
      `INSERT INTO landlord_gam_debits
         (landlord_id, charges_amount, bank_cost_amount, total_amount, status,
          stripe_payment_intent_id, charge_ids)
       VALUES ($1, 48, 6, 54, 'pending', 'pi_cost', ARRAY[$2::uuid]) RETURNING id`,
      [landlordId, chargeId])

    await settleGamDebit('pi_cost', true)
    await query(`UPDATE landlord_gam_debits SET status = 'pending' WHERE id = $1`, [d.id])   // a replay racing the first
    await settleGamDebit('pi_cost', true)

    const rows = await query<any>(
      `SELECT type, amount::text AS amount, customer_fee_charged::text AS fee, reference_type
         FROM platform_revenue_ledger WHERE reference_id = $1`, [d.id])
    expect(rows).toEqual([{ type: 'banking_spread', amount: '6.00', fee: '6.00', reference_type: 'gam_bank_debit' }])
  })

  it('books nothing when the bank refuses the pull', async () => {
    const chargeId = await owe(48, '99999999-6666-6666-6666-666666666666')
    const [d] = await query<{ id: string }>(
      `INSERT INTO landlord_gam_debits
         (landlord_id, charges_amount, bank_cost_amount, total_amount, status,
          stripe_payment_intent_id, charge_ids)
       VALUES ($1, 48, 6, 54, 'pending', 'pi_cost_nsf', ARRAY[$2::uuid]) RETURNING id`,
      [landlordId, chargeId])
    await settleGamDebit('pi_cost_nsf', false, 'insufficient funds')
    expect(await query(`SELECT 1 FROM platform_revenue_ledger WHERE reference_id = $1`, [d.id])).toEqual([])
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
    await query(`DELETE FROM landlord_gam_charge_collections`)
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

  it('a pull Stripe refuses on the spot voids ITS cost line and keeps it (10/12, ledger P0: never deleted)', async () => {
    vi.resetModules()
    vi.doMock('../lib/stripe', () => ({
      getStripe: () => ({
        // Stripe answered and refused (lib/stripeRefusal): a definite refusal.
        paymentIntents: { create: async () => { throw Object.assign(new Error('bank account closed'), { type: 'StripeCardError', statusCode: 402 }) } },
      }),
    }))
    const { debitLandlordForCharges: debit } = await import('./landlordGamDebit')
    // Another cost line, raised minutes ago for an earlier pull, that the old
    // ten-minute DELETE would have taken with it.
    const other = (await chargeLandlord(null, {
      landlordId, kind: 'bank_debit_cost', amount: 6, sourceType: 'gam_bank_debit_cost', sourceId: null,
    }))!
    await query(`UPDATE landlord_gam_charges SET collected_amount = 6 WHERE id = $1`, [other])
    await withLinkedBank()
    await owe(120, '8aaaaaaa-8888-8888-8888-888888888888')
    const out = await debit(landlordId)
    expect(out).toMatchObject({ status: 'skipped', reason: 'stripe_failed' })

    const lines = await query<any>(
      `SELECT id, kind, voided_at IS NOT NULL AS voided, void_reason FROM landlord_gam_charges
        WHERE landlord_id = $1 AND kind = 'bank_debit_cost' ORDER BY created_at`, [landlordId])
    expect(lines).toHaveLength(2)
    expect(lines.find((l: any) => l.id === other)).toMatchObject({ voided: false, void_reason: null })
    expect(lines.find((l: any) => l.id !== other)).toMatchObject({ voided: true, void_reason: 'bank_debit_not_made' })
    // Owed again: only the fee — the voided cost is owed by nobody.
    expect(await outstandingForLandlord(landlordId)).toBe(120)
    const [d] = await query<any>(`SELECT status FROM landlord_gam_debits WHERE id = $1`, [out.debitId])
    expect(d.status).toBe('failed')
    vi.doUnmock('../lib/stripe')
  })

  it('pulls what is owed when it claims the charges, never a voided one', async () => {
    vi.resetModules()
    vi.doMock('../lib/stripe', () => ({
      getStripe: () => ({ paymentIntents: { create: async () => ({ id: 'pi_claim' }) } }),
    }))
    const { debitLandlordForCharges: debit } = await import('./landlordGamDebit')
    await withLinkedBank()
    await owe(90, '9aaaaaaa-9999-9999-9999-999999999999')
    const gone = (await owe(40, '9bbbbbbb-9999-9999-9999-999999999999'))!
    await query(
      `UPDATE landlord_gam_charges SET voided_at = NOW(), void_reason = 'screening_payment_taken_back' WHERE id = $1`, [gone])
    await owe(20, '9ccccccc-9999-9999-9999-999999999999')
    const out = await debit(landlordId)
    expect(out).toMatchObject({ status: 'debited', chargesAmount: 110, bankCost: 6, total: 116 })
    const [d] = await query<any>(`SELECT charge_ids FROM landlord_gam_debits WHERE id = $1`, [out.debitId])
    expect(d.charge_ids).not.toContain(gone)
    vi.doUnmock('../lib/stripe')
  })
})

describe('10/12 review: a pull whose answer from Stripe was lost', () => {
  beforeAll(async () => {
    const client = await getClient()
    try { ({ landlordId } = await seedLandlord(client)) } finally { client.release() }
  })
  beforeEach(async () => {
    await query(`DELETE FROM landlord_gam_charge_collections`)
    await query(`DELETE FROM landlord_gam_debits WHERE landlord_id = $1`, [landlordId])
    await query(`DELETE FROM landlord_gam_charges WHERE landlord_id = $1`, [landlordId])
    await query(`DELETE FROM admin_notifications WHERE category LIKE 'gam_debit%'`)
  })

  const timeout = () => Object.assign(new Error('Request timed out'), { type: 'StripeConnectionError' })

  async function withStripe(m: { create?: (...a: any[]) => Promise<any>; search?: (...a: any[]) => Promise<any> }) {
    const create = vi.fn(m.create ?? (async () => ({ id: 'pi_unused', status: 'processing' })))
    const search = vi.fn(m.search ?? (async () => ({ data: [] })))
    vi.resetModules()
    vi.doMock('../lib/stripe', () => ({ getStripe: () => ({ paymentIntents: { create, search } }) }))
    const mod = await import('./landlordGamDebit')
    return { mod, create, search }
  }

  it('a timeout after Stripe made the pull leaves it pending, its cost line owed; the webhook finds it by its own id and settles it, and nothing is pulled twice', async () => {
    const { mod, create } = await withStripe({ create: async () => { throw timeout() } })
    await withLinkedBank()
    await owe(150, 'a1111111-1111-1111-1111-111111111111')
    const first = await mod.debitLandlordForCharges(landlordId)
    expect(first).toMatchObject({ status: 'skipped', reason: 'stripe_failed' })
    // Asked under the pull's own key.
    expect(create.mock.calls[0][1]).toEqual({ idempotencyKey: `gam_debit_${first.debitId}` })
    const [d] = await query<any>(`SELECT status, stripe_payment_intent_id, failure_reason FROM landlord_gam_debits WHERE id = $1`, [first.debitId])
    expect(d).toMatchObject({ status: 'pending', stripe_payment_intent_id: null, failure_reason: 'Request timed out' })
    const cost = await query<any>(`SELECT voided_at FROM landlord_gam_charges WHERE landlord_id = $1 AND kind = 'bank_debit_cost'`, [landlordId])
    expect(cost).toHaveLength(1)
    expect(cost[0].voided_at).toBeNull()

    // The pull Stripe had made lands: found by gam_debit_id, stamped, settled.
    await mod.settleGamDebit('pi_really_made', true, undefined, first.debitId)
    const [after] = await query<any>(`SELECT status, stripe_payment_intent_id FROM landlord_gam_debits WHERE id = $1`, [first.debitId])
    expect(after).toEqual({ status: 'succeeded', stripe_payment_intent_id: 'pi_really_made' })
    expect(await outstandingForLandlord(landlordId)).toBe(0)
    // The records add up to what the bank took: no mismatch told to anyone.
    expect((await query(`SELECT 1 FROM admin_notifications WHERE category LIKE 'gam_debit_%collected'`)).length).toBe(0)
    // Next night: nothing owed, nothing pulled.
    expect((await mod.debitLandlordForCharges(landlordId)).reason).toBe('nothing_owed')
    expect(create).toHaveBeenCalledTimes(1)
    vi.doUnmock('../lib/stripe')
  })

  it('the next sweep asks Stripe again: a pull it finds by the pull\'s id is stamped, never made twice', async () => {
    const { mod, create, search } = await withStripe({
      create: async () => { throw timeout() },
    })
    await withLinkedBank()
    await owe(150, 'a2222222-1111-1111-1111-111111111111')
    const first = await mod.debitLandlordForCharges(landlordId)
    search.mockResolvedValueOnce({ data: [{ id: 'pi_found', status: 'processing' }] })
    const again = await mod.debitLandlordForCharges(landlordId)
    expect(again).toMatchObject({ status: 'skipped', reason: 'debit_in_flight', debitId: first.debitId })
    expect(search.mock.calls[0][0]).toEqual({ query: `metadata['gam_debit_id']:'${first.debitId}'`, limit: 10 })
    expect(create).toHaveBeenCalledTimes(1)
    const [d] = await query<any>(`SELECT status, stripe_payment_intent_id FROM landlord_gam_debits WHERE id = $1`, [first.debitId])
    expect(d).toEqual({ status: 'pending', stripe_payment_intent_id: 'pi_found' })
    vi.doUnmock('../lib/stripe')
  })

  it('…and one Stripe never received is sent again with the same request under the same key', async () => {
    let n = 0
    const { mod, create } = await withStripe({
      create: async () => { n++; if (n === 1) throw timeout(); return { id: 'pi_second_ask', status: 'processing' } },
    })
    await withLinkedBank()
    await owe(150, 'a3333333-1111-1111-1111-111111111111')
    const first = await mod.debitLandlordForCharges(landlordId)
    await mod.debitLandlordForCharges(landlordId)
    expect(create).toHaveBeenCalledTimes(2)
    expect(create.mock.calls[1]).toEqual(create.mock.calls[0])       // same request, same key
    const [d] = await query<any>(`SELECT status, stripe_payment_intent_id FROM landlord_gam_debits WHERE id = $1`, [first.debitId])
    expect(d).toEqual({ status: 'pending', stripe_payment_intent_id: 'pi_second_ask' })
    vi.doUnmock('../lib/stripe')
  })

  it('a pull that took more than its charges still owed says so, with the difference', async () => {
    const chargeId = await owe(82, 'a4444444-1111-1111-1111-111111111111')
    await query(
      `INSERT INTO landlord_gam_debits
         (landlord_id, charges_amount, bank_cost_amount, total_amount, status, stripe_payment_intent_id, charge_ids)
       VALUES ($1, 82, 0, 82, 'pending', 'pi_over', ARRAY[$2::uuid])`, [landlordId, chargeId])
    // Netted $30 of it by a payout of the old code while the pull was in flight.
    await query(`UPDATE landlord_gam_charges SET collected_amount = 30 WHERE id = $1`, [chargeId])
    await settleGamDebit('pi_over', true)
    const notes = await query<any>(`SELECT category, context FROM admin_notifications WHERE category = 'gam_debit_overcollected'`)
    expect(notes).toHaveLength(1)
    expect(notes[0].context).toMatchObject({ pulled: 82, recorded: 52 })
  })
})

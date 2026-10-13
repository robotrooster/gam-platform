/**
 * S620: what a landlord owes GAM, and the rule that GAM takes it from money
 * already moving rather than debiting a bank account.
 *
 * Nic: "we'll just take it all out of the card balance. It doesn't make sense
 * to debit the account of the landlord — that's just more money moving back
 * and forth, and we wanna eliminate moves."
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { query, getClient } from '../db'
import { seedLandlord } from '../test/dbHelpers'
import {
  chargeLandlord, outstandingForLandlord, netAgainstDisbursement,
  debitThresholdForLandlord, markBalance, DEFAULT_DEBIT_THRESHOLD,
  recordGamChargeCollections, voidGamCharge, type GamChargeTake,
} from './landlordGamAccount'

let landlordId: string

const charge = (amount: number, sourceId: string) =>
  chargeLandlord(null, {
    landlordId, kind: 'subscription', amount,
    sourceType: 'test', sourceId,
  })

describe('landlord GAM account', () => {
  beforeAll(async () => {
    const client = await getClient()
    try { ({ landlordId } = await seedLandlord(client)) } finally { client.release() }
  })
  beforeEach(async () => {
    await query(`DELETE FROM landlord_gam_charge_collections`)
    await query(`DELETE FROM landlord_gam_debits WHERE landlord_id = $1`, [landlordId])
    await query(`DELETE FROM landlord_gam_charges WHERE landlord_id = $1`, [landlordId])
  })

  it('records what the landlord owes', async () => {
    await charge(10, '11111111-1111-1111-1111-111111111111')
    await charge(10, '22222222-2222-2222-2222-222222222222')
    expect(await outstandingForLandlord(landlordId)).toBe(20)
  })

  it('cannot bill the same event twice', async () => {
    // A retried recording, or a webhook delivered twice, must not double-charge.
    const id = '33333333-3333-3333-3333-333333333333'
    expect(await charge(10, id)).toBeTruthy()
    expect(await charge(10, id)).toBeNull()
    expect(await outstandingForLandlord(landlordId)).toBe(10)
  })

  it('takes the whole debt out of a disbursement that covers it', async () => {
    // Six small charges, then one ACH rent payment big enough to cover them —
    // Nic's expected case, and the one where nothing gets debited.
    for (let i = 0; i < 6; i++) await charge(10, `4444444${i}-4444-4444-4444-444444444444`)
    const taken = await netAgainstDisbursement(await client(), landlordId, 750, [])
    expect(taken).toBe(60)
    expect(await outstandingForLandlord(landlordId)).toBe(0)
  })

  it('takes PART of the debt and carries the rest — this is what avoids a debit', async () => {
    // Deliberately unlike the reversal netting beside it, which is
    // full-net-or-nothing. Carrying a remainder is the point.
    await charge(70, '55555555-5555-5555-5555-555555555555')
    const taken = await netAgainstDisbursement(await client(), landlordId, 50, [])
    expect(taken).toBe(50)
    expect(await outstandingForLandlord(landlordId)).toBe(20)
  })

  it('takes nothing when there is no money on its way', async () => {
    await charge(10, '66666666-6666-6666-6666-666666666666')
    expect(await netAgainstDisbursement(await client(), landlordId, 0, [])).toBe(0)
    expect(await outstandingForLandlord(landlordId)).toBe(10)
  })

  it('defaults the debit threshold to $100 and records a mark either way', async () => {
    expect(await debitThresholdForLandlord(landlordId)).toBe(DEFAULT_DEBIT_THRESHOLD)
    await charge(80, '77777777-7777-7777-7777-777777777777')
    const b = await markBalance(landlordId)
    expect(b.owed).toBe(80)
    // The NEAR MISS is the point — $80 against $100 must be visible without
    // anything having tripped.
    expect(b.overThreshold).toBe(false)
    const marks = await query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM landlord_gam_balance_marks WHERE landlord_id = $1`, [landlordId])
    expect(Number(marks[0].n)).toBeGreaterThan(0)
  })

  it('flags once the balance reaches the threshold', async () => {
    await charge(100, '88888888-8888-8888-8888-888888888888')
    expect((await markBalance(landlordId)).overThreshold).toBe(true)
  })

  // ── 10/12 (Nic, ledger P0): what collected each charge, and never twice ──

  it('says what it kept from each charge, oldest first, so the batch can record it', async () => {
    const a = await charge(30, 'a1111111-1111-1111-1111-111111111111')
    const b = await charge(30, 'b2222222-2222-2222-2222-222222222222')
    const takes: GamChargeTake[] = []
    expect(await netAgainstDisbursement(await client(), landlordId, 45, takes)).toBe(45)
    expect(takes).toEqual([{ chargeId: a, amount: 30 }, { chargeId: b, amount: 15 }])
  })

  it('never nets a charge a bank pull is still collecting (design §16.1: it was collected twice)', async () => {
    // A pull claimed the $48 platform fee and is waiting on the bank. The
    // payout that runs before it settles must leave that charge alone: the
    // pull's settlement marks every charge it carries collected in full, so a
    // netted one would be paid from the payout AND the bank.
    const inPull = await charge(48, 'c3333333-3333-3333-3333-333333333333')
    const free = await charge(20, 'd4444444-4444-4444-4444-444444444444')
    await query(
      `INSERT INTO landlord_gam_debits (landlord_id, charges_amount, bank_cost_amount, total_amount, status, charge_ids)
       VALUES ($1, 48, 6, 54, 'pending', $2)`, [landlordId, [inPull]])
    const takes: GamChargeTake[] = []
    expect(await netAgainstDisbursement(await client(), landlordId, 500, takes)).toBe(20)
    expect(takes).toEqual([{ chargeId: free, amount: 20 }])
    const [c] = await query<any>(`SELECT collected_amount::text AS c FROM landlord_gam_charges WHERE id = $1`, [inPull])
    expect(c.c).toBe('0.00')

    // The pull failed: the charge is the payout's to take again.
    await query(`UPDATE landlord_gam_debits SET status = 'failed' WHERE landlord_id = $1`, [landlordId])
    const again: GamChargeTake[] = []
    expect(await netAgainstDisbursement(await client(), landlordId, 500, again)).toBe(48)
    expect(again).toEqual([{ chargeId: inPull, amount: 48 }])
  })

  it('a voided charge is kept on file and owed by nobody — never netted, never counted', async () => {
    const gone = (await charge(25, 'e5555555-5555-5555-5555-555555555555'))!
    await charge(10, 'f6666666-6666-6666-6666-666666666666')
    expect(await voidGamCharge(null, gone, 'screening_payment_taken_back')).toBe(true)
    // Kept: the row is still there, with when and why.
    const [row] = await query<any>(`SELECT voided_at, void_reason FROM landlord_gam_charges WHERE id = $1`, [gone])
    expect(row.voided_at).not.toBeNull()
    expect(row.void_reason).toBe('screening_payment_taken_back')
    expect(await outstandingForLandlord(landlordId)).toBe(10)
    const takes: GamChargeTake[] = []
    expect(await netAgainstDisbursement(await client(), landlordId, 500, takes)).toBe(10)
    expect(takes.map(t => t.chargeId)).not.toContain(gone)
    // Voiding twice does nothing more.
    expect(await voidGamCharge(null, gone, 'screening_payment_taken_back')).toBe(false)
  })

  it('never voids a charge something was collected on, or one a bank pull is carrying', async () => {
    const part = (await charge(40, '17777777-7777-7777-7777-777777777777'))!
    await netAgainstDisbursement(await client(), landlordId, 15, [])
    expect(await voidGamCharge(null, part, 'screening_payment_taken_back')).toBe(false)

    const carried = (await charge(30, '18888888-8888-8888-8888-888888888888'))!
    await query(
      `INSERT INTO landlord_gam_debits (landlord_id, charges_amount, bank_cost_amount, total_amount, status, charge_ids)
       VALUES ($1, 30, 6, 36, 'pending', $2)`, [landlordId, [carried]])
    expect(await voidGamCharge(null, carried, 'screening_payment_taken_back')).toBe(false)
    const rows = await query<any>(`SELECT COUNT(*)::int AS n FROM landlord_gam_charges WHERE voided_at IS NOT NULL AND landlord_id = $1`, [landlordId])
    expect(rows[0].n).toBe(0)
  })

  it('10/12 review: a void that waits on a pull claiming the charge sees that pull once it commits, and leaves the charge alone', async () => {
    const id = (await charge(48, '1aaaaaaa-7777-7777-7777-777777777777'))!
    // A bank pull claims the charge (row-locked, FOR UPDATE, not changed) and
    // has not committed yet.
    const pull = await getClient()
    try {
      await pull.query('BEGIN')
      await pull.query(`SELECT id FROM landlord_gam_charges WHERE id = $1 FOR UPDATE`, [id])
      await pull.query(
        `INSERT INTO landlord_gam_debits (landlord_id, charges_amount, bank_cost_amount, total_amount, status, charge_ids)
         VALUES ($1, 48, 6, 54, 'pending', $2)`, [landlordId, [id]])
      const voiding = voidGamCharge(null, id, 'screening_payment_taken_back')
      await new Promise(r => setTimeout(r, 200))         // the void is waiting on the row
      await pull.query('COMMIT')
      expect(await voiding).toBe(false)
    } finally { pull.release() }
    const [row] = await query<any>(`SELECT voided_at FROM landlord_gam_charges WHERE id = $1`, [id])
    expect(row.voided_at).toBeNull()
  })

  it('a void must say why — the database refuses a reason outside the shared list', async () => {
    const id = (await charge(5, '19999999-9999-9999-9999-999999999999'))!
    await expect(query(
      `UPDATE landlord_gam_charges SET voided_at = NOW(), void_reason = 'because' WHERE id = $1`, [id])).rejects.toThrow()
    await expect(query(
      `UPDATE landlord_gam_charges SET voided_at = NOW() WHERE id = $1`, [id])).rejects.toThrow()
  })

  it('records each collection against exactly one source, and adds up to collected_amount', async () => {
    const a = (await charge(30, '2aaaaaaa-1111-1111-1111-111111111111'))!
    const b = (await charge(12, '2bbbbbbb-2222-2222-2222-222222222222'))!
    const [debit] = await query<{ id: string }>(
      `INSERT INTO landlord_gam_debits (landlord_id, charges_amount, bank_cost_amount, total_amount, status, charge_ids)
       VALUES ($1, 42, 6, 48, 'succeeded', $2) RETURNING id`, [landlordId, [a, b]])
    const c = await client()
    try {
      await c.query('BEGIN')
      await recordGamChargeCollections(c, [{ chargeId: a, amount: 30 }, { chargeId: b, amount: 12 }, { chargeId: b, amount: 0 }],
        { landlordGamDebitId: debit.id })
      await c.query('COMMIT')
    } finally { c.release() }
    const rows = await query<any>(
      `SELECT charge_id, amount::text AS amount, landlord_gam_debit_id, platform_transfer_intent_id, derived
         FROM landlord_gam_charge_collections c ORDER BY c.amount DESC`)
    expect(rows).toEqual([
      { charge_id: a, amount: '30.00', landlord_gam_debit_id: debit.id, platform_transfer_intent_id: null, derived: false },
      { charge_id: b, amount: '12.00', landlord_gam_debit_id: debit.id, platform_transfer_intent_id: null, derived: false },
    ])
    // A row naming both sources, or neither, is refused.
    await expect(query(
      `INSERT INTO landlord_gam_charge_collections (charge_id, amount) VALUES ($1, 1)`, [a])).rejects.toThrow()
  })
})

/** netAgainstDisbursement needs a client; each test gets its own. */
async function client() {
  const c = await getClient()
  // Released by the pool on process teardown; these are short-lived reads.
  return c
}

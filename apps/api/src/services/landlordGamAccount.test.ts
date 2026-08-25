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
} from './landlordGamAccount'

let landlordId: string

const charge = (amount: number, sourceId: string) =>
  chargeLandlord(null, {
    landlordId, kind: 'manual_payment_fee', amount,
    sourceType: 'test', sourceId,
  })

describe('landlord GAM account', () => {
  beforeAll(async () => {
    const client = await getClient()
    try { ({ landlordId } = await seedLandlord(client)) } finally { client.release() }
  })
  beforeEach(async () => {
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
    // Six cash payments, then one ACH rent payment big enough to cover them —
    // Nic's expected case, and the one where nothing gets debited.
    for (let i = 0; i < 6; i++) await charge(10, `4444444${i}-4444-4444-4444-444444444444`)
    const taken = await netAgainstDisbursement(await client(), landlordId, 750)
    expect(taken).toBe(60)
    expect(await outstandingForLandlord(landlordId)).toBe(0)
  })

  it('takes PART of the debt and carries the rest — this is what avoids a debit', async () => {
    // Deliberately unlike the reversal netting beside it, which is
    // full-net-or-nothing. Carrying a remainder is the point.
    await charge(70, '55555555-5555-5555-5555-555555555555')
    const taken = await netAgainstDisbursement(await client(), landlordId, 50)
    expect(taken).toBe(50)
    expect(await outstandingForLandlord(landlordId)).toBe(20)
  })

  it('takes nothing when there is no money on its way', async () => {
    await charge(10, '66666666-6666-6666-6666-666666666666')
    expect(await netAgainstDisbursement(await client(), landlordId, 0)).toBe(0)
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
})

/** netAgainstDisbursement needs a client; each test gets its own. */
async function client() {
  const c = await getClient()
  // Released by the pool on process teardown; these are short-lived reads.
  return c
}

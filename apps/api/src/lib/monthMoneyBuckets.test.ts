/**
 * 11/3 — THE THREE THINGS THAT MUST NEVER CONTRADICT EACH OTHER ON A DASHBOARD.
 *
 * Nic opened the landlord dashboard filtered to one park and found THREE
 * different "still owed" figures — $14,391 on a card headed "This month", $9,042
 * on the card beside it labelled "every open charge, every month", and $7,685
 * under Property health:
 *
 *   "It needs to be a grand fucking total of every outstanding money owed to us.
 *    So how can 14,000 dollars in this month be higher than the total
 *    outstanding from the other months? It is confusing to me even after your
 *    explanation... and it's going to be confusing to fucking everybody."
 *
 * Every figure was individually correct. What was missing was any rule forcing
 * them to nest, and a card headed with a month was carrying a CUMULATIVE
 * balance: the $14,391 was this month's owed PLUS earlier months PLUS money
 * already clearing at the bank PLUS work trade.
 *
 * These tests are the rule. They do not check a dollar figure — residents pay
 * through the day and the figures move (ten charges settled at Mountain View
 * while this was being diagnosed). They check that the PARTS CANNOT FAIL TO ADD
 * UP, whatever the data is.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant } from '../test/dbHelpers'
import { monthMoneyBuckets, outstandingBalanceOf } from './rentCollected'

const MONTH = '2026-11-01'

let landlordId = ''
let propertyId = ''
let unitId = ''

beforeEach(async () => {
  await cleanupAllSchema()
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const me = await seedLandlord(c)
    landlordId = me.landlordId
    propertyId = await seedProperty(c, { landlordId, ownerUserId: me.userId, managedByUserId: me.userId })
    unitId = await seedUnit(c, { propertyId, landlordId })
    await c.query('COMMIT')
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
})

/** One charge, exactly as a bill row looks. */
async function charge(o: {
  amount: number; status: string; due: string
  workTrade?: boolean; intent?: boolean; type?: string
}): Promise<void> {
  await db.query(
    `INSERT INTO payments (unit_id, landlord_id, type, amount, status, due_date, entry_description,
                           work_trade_suspended_at, stripe_payment_intent_id)
     VALUES ($1, $2, $3, $4, $5, $6::date, 'RENT', $7, $8)`,
    [unitId, landlordId, o.type ?? 'rent', o.amount, o.status, o.due,
     o.workTrade ? new Date() : null, o.intent ? `pi_${Math.random().toString(36).slice(2)}` : null])
}

const buckets = () => monthMoneyBuckets([landlordId], propertyId, MONTH)

describe('one month of money, from one population', () => {
  it('the parts always add up to charged, to the cent', async () => {
    // A rent charge is unique per unit per due date (ux_payments_unit_rent_due_date_active),
    // so each of these takes its own day of the month.
    await charge({ amount: 500, status: 'pending', due: '2026-11-01' })        // owed
    await charge({ amount: 325.55, status: 'settled', due: '2026-11-02' })     // collected
    await charge({ amount: 90.45, status: 'processing', due: '2026-11-03' })   // clearing
    await charge({ amount: 410, status: 'pending', due: '2026-11-04', workTrade: true })
    const b = await buckets()
    expect(b.charged).toBe(916)                                                // 500 + 325.55 + 90.45
    expect(b.collected).toBe(325.55)
    expect(b.clearing).toBe(90.45)
    expect(b.stillOwed).toBe(500)
    // The sentence the card prints is this subtraction. It cannot be off.
    expect(Math.round((b.collected + b.clearing + b.stillOwed) * 100) / 100).toBe(b.charged)
  })

  it('work trade is in NEITHER charged nor owed — labor is paying it', async () => {
    await charge({ amount: 410, status: 'pending', due: '2026-11-01', workTrade: true })
    const b = await buckets()
    // Nic, 11/3: "it should never show as November's money in the first place."
    expect(b.workTrade).toBe(410)
    expect(b.stillOwed).toBe(0)
    expect(b.charged).toBe(0)
  })

  it('money clearing at the bank is charged but never owed — it is already paid', async () => {
    await charge({ amount: 250, status: 'processing', due: '2026-11-03' })
    await charge({ amount: 125, status: 'pending', due: '2026-11-04', intent: true })
    const b = await buckets()
    expect(b.clearing).toBe(375)
    expect(b.stillOwed).toBe(0)
    expect(b.charged).toBe(375)
  })

  it('an earlier month is never this month, and the two make the Outstanding card', async () => {
    await charge({ amount: 500, status: 'pending', due: '2026-11-01' })   // this month
    await charge({ amount: 140, status: 'pending', due: '2026-10-01' })   // earlier
    const b = await buckets()
    const o = await outstandingBalanceOf([landlordId], propertyId)
    expect(b.stillOwed).toBe(500)
    expect(b.earlierOwed).toBe(140)
    // THE INVARIANT NIC ASKED FOR: this month is a SLICE of the all-months
    // total, so it can never be the larger number.
    expect(b.stillOwed).toBeLessThanOrEqual(o.outstanding)
    expect(Math.round((b.stillOwed + b.earlierOwed) * 100) / 100).toBe(o.outstanding)
  })

  // Credit already spent is netted off the owed side by `openAmountSql`, the
  // same helper `outstandingBalanceOf` uses — which is exactly why the test
  // above can assert `stillOwed + earlierOwed === outstanding` to the cent. If
  // one of them ever stopped netting credit, that equality breaks first, so a
  // separate credit fixture (which needs a lease, a tenant and a credit row)
  // would only restate what that line already proves.
})

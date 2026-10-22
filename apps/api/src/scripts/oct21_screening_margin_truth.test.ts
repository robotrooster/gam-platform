/**
 * The $14.75 the books handed to Checkr.
 *
 * Five applicants paid $44.99 for a price built on an ID scan no order ever
 * asked for. Checkr invoiced $34.99. The split is derived — charged, less GAM's
 * $5 and the card fee, is called Checkr's — so each check set aside $37.94 for
 * a $34.99 bill. Nic's call was not to refund, so the $2.95 apiece is GAM's and
 * the book should say so.
 *
 * What is guarded here is mostly what the script REFUSES. It rewrites earnings
 * rows on real money, so every reason to leave a row alone is worth a test.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { randomUUID } from 'crypto'
import { getClient } from '../db'
import {
  planScreeningMarginTruth, applyScreeningMarginTruth,
  CHECKR_ESSENTIAL_ONLY_USD, OLD_APPLICANT_PRICE_USD, OLD_FLAT_MARGIN_USD,
} from './oct21_screening_margin_truth'
import { seedLandlord, seedProperty } from '../test/dbHelpers'

const PAID = { products: { criminal_history: 'clear', credit_report: 'clear' } }
const WITH_ID_SCAN = { products: { criminal_history: 'clear', identity_verification: 'clear' } }

describe('correcting the screening margin to what GAM really kept', () => {
  let client: any, landlordId: string, userId: string

  beforeEach(async () => {
    client = await getClient()
    await client.query('BEGIN')
    const l = await seedLandlord(client)
    landlordId = l.landlordId; userId = l.userId
    await seedProperty(client, { landlordId, ownerUserId: userId, managedByUserId: userId })
  })
  afterEach(async () => { await client.query('ROLLBACK'); client.release() })

  /** A screening exactly as the five real ones look. */
  async function check(opts: {
    charged?: number; margin?: number | null; cardFee?: number | null
    summary?: any; refunded?: boolean
  } = {}) {
    const id = (await client.query(
      `INSERT INTO background_checks (user_id, landlord_id, status, amount_charged,
                                      applicant_payment_intent_id, report_summary, platform_net, refunded_at)
       VALUES ($1,$2,'approved',$3,$4,$5::jsonb,$6,$7) RETURNING id`,
      [userId, landlordId, opts.charged ?? OLD_APPLICANT_PRICE_USD, 'pi_' + randomUUID(),
       JSON.stringify(opts.summary ?? PAID), opts.margin ?? null, opts.refunded ? new Date() : null])).rows[0].id
    if (opts.margin !== null) {
      await client.query(
        `INSERT INTO platform_revenue_ledger (type, amount, reference_type, reference_id, notes, balance_after)
         VALUES ('screening_margin',$1,'background_check',$2,'seed',0)`, [opts.margin ?? OLD_FLAT_MARGIN_USD, id])
    }
    if (opts.cardFee !== null) {
      await client.query(
        `INSERT INTO platform_revenue_ledger (type, amount, reference_type, reference_id, customer_fee_charged, notes, balance_after)
         VALUES ('banking_spread',0.49,'background_check',$1,$2,'seed',0)`, [id, opts.cardFee ?? 2.05])
    }
    return id
  }

  it('moves $2.95 a check — $44.99 less the $2.05 card fee less Checkr\'s $34.99 is $7.95', async () => {
    const id = await check()
    const plan = await planScreeningMarginTruth(client)
    const mine = plan.fixes.filter(f => f.backgroundCheckId === id)
    expect(mine).toHaveLength(1)
    expect(mine[0]).toMatchObject({ fromMargin: OLD_FLAT_MARGIN_USD, toMargin: 7.95, cardFee: 2.05 })
    expect(round(mine[0].toMargin - mine[0].fromMargin)).toBe(2.95)

    await applyScreeningMarginTruth(client, { ...plan, fixes: mine })
    const { rows: [l] } = await client.query(
      `SELECT amount::float AS amount, notes FROM platform_revenue_ledger
        WHERE type = 'screening_margin' AND reference_id = $1`, [id])
    expect(l.amount).toBe(7.95)
    expect(l.notes).toMatch(/never ordered/)
    const { rows: [bc] } = await client.query(`SELECT platform_net::float AS net FROM background_checks WHERE id = $1`, [id])
    expect(bc.net).toBe(7.95)
  })

  it('leaves what was really Checkr\'s: after the fix the derived hold is their invoice to the cent', async () => {
    const id = await check()
    const plan = await planScreeningMarginTruth(client)
    const f = plan.fixes.find(x => x.backgroundCheckId === id)!
    // services/stripeCosts: checkrHeld = charged - (margin + the card fee charged)
    expect(round(f.charged - (f.toMargin + f.cardFee))).toBe(CHECKR_ESSENTIAL_ONLY_USD)
  })

  it('the card fee row is not touched — a fee really was charged and 49c of it really was GAM\'s', async () => {
    const id = await check()
    const plan = await planScreeningMarginTruth(client)
    await applyScreeningMarginTruth(client, { ...plan, fixes: plan.fixes.filter(f => f.backgroundCheckId === id) })
    const { rows: [s] } = await client.query(
      `SELECT amount::float AS amount, customer_fee_charged::float AS fee FROM platform_revenue_ledger
        WHERE type = 'banking_spread' AND reference_id = $1`, [id])
    expect(s).toEqual({ amount: 0.49, fee: 2.05 })
  })

  it('refuses a check whose report shows the ID scan RAN — Checkr invoiced more than the package', async () => {
    const id = await check({ summary: WITH_ID_SCAN })
    const plan = await planScreeningMarginTruth(client)
    expect(plan.fixes.find(f => f.backgroundCheckId === id)).toBeUndefined()
    expect(plan.skipped.find(s => s.backgroundCheckId === id)!.why).toMatch(/ID scan ran/)
  })

  it('refuses a refunded check — its money is not GAM\'s to rebook', async () => {
    const id = await check({ refunded: true })
    const plan = await planScreeningMarginTruth(client)
    expect(plan.fixes.find(f => f.backgroundCheckId === id)).toBeUndefined()
    expect(plan.skipped.find(s => s.backgroundCheckId === id)!.why).toMatch(/refunded/)
  })

  it('refuses a check charged the new price — it was never built on the missing scan', async () => {
    const id = await check({ charged: 46.03 })
    const plan = await planScreeningMarginTruth(client)
    expect(plan.fixes.find(f => f.backgroundCheckId === id)).toBeUndefined()
    expect(plan.skipped.find(s => s.backgroundCheckId === id)!.why).toMatch(/not the old \$44\.99/)
  })

  it('refuses a check with no card-fee row to read, and one already corrected — it never runs twice', async () => {
    const noFee = await check({ cardFee: null })
    const done  = await check({ margin: 7.95 })
    const plan = await planScreeningMarginTruth(client)
    expect(plan.fixes.map(f => f.backgroundCheckId)).not.toContain(noFee)
    expect(plan.fixes.map(f => f.backgroundCheckId)).not.toContain(done)
    expect(plan.skipped.find(s => s.backgroundCheckId === noFee)!.why).toMatch(/banking_spread/)
    expect(plan.skipped.find(s => s.backgroundCheckId === done)!.why).toMatch(/not the old flat/)
  })
})

const round = (n: number) => Math.round(n * 100) / 100

/**
 * Financing a job — can this landlord actually carry it?
 *
 * The rule under test is Nic's, 10/31, in his words:
 *
 *   "based on landlord revenue and ability to repay. a one unit landlord at 800
 *    rent can never cover a job that big. lets say monthly payment 2 or 4 has
 *    to be equal or less than 25 percent of incoming invoices. scoped to leased
 *    units not short term stays. short term stays price off the lowest income
 *    over the last 6 months"
 *
 * His one-unit-at-$800 example is a test case below, by name, because it is the
 * case he used to explain the rule and it is the one that must never regress.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import type { PoolClient } from 'pg'
import { db, query } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant,
  seedLease, seedLeaseTenant,
} from '../test/dbHelpers'
import { todayIn } from '../lib/timezone'
import {
  financingCapacityFor, canFinance, requireFinancingFee, financingOutlay,
  FINANCING_CLOSED,
} from './jobFinancing'
import { financingFeeForReturn, FINANCING_PER_DOLLAR_MONTH } from '@gam/shared'

/**
 * Financing ships OFF (system_features.job_financing_enabled, migration
 * 20261101020000) because the reserve pool is not funded. The arithmetic below
 * is what will be true when it opens, so every case here switches it on first
 * — and `cleanupAllSchema` wipes system_features, so the row has to be put
 * back after the wipe rather than once at the top of the file.
 *
 * The one case that does NOT switch it on is the last describe block, which is
 * the only one that tests the shipping default.
 */
async function financingOpen() {
  await query(
    `INSERT INTO system_features (key, enabled, description)
     VALUES ('job_financing_enabled', TRUE, 'test')
     ON CONFLICT (key) DO UPDATE SET enabled = TRUE`)
}

beforeEach(async () => {
  await cleanupAllSchema()
  await financingOpen()
})

interface World {
  landlordId: string
  userId: string
  propertyId: string
}

/** A company with `leases` active leases, each invoicing `rent` a month. */
async function world(opts: { rent?: number; leases?: number } = {}): Promise<World> {
  const rent = opts.rent ?? 800
  const leases = opts.leases ?? 1
  const c: PoolClient = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    for (let i = 0; i < leases; i++) {
      const unitId = await seedUnit(c, { propertyId, landlordId })
      const tenantId = await seedTenant(c)
      const leaseId = await seedLease(c, { unitId, landlordId, status: 'active', rentAmount: rent })
      await seedLeaseTenant(c, { leaseId, tenantId })
    }
    await c.query('COMMIT')
    return { landlordId, userId, propertyId }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

const capacity = (w: World) => financingCapacityFor({ landlordIds: [w.landlordId] })

// ── his own example ───────────────────────────────────────────

describe('the one-unit park at $800, which is the example the rule came from', () => {
  it('can carry $200 a month and no more', async () => {
    const w = await world({ rent: 800, leases: 1 })
    const c = await capacity(w)
    expect(c.leaseMonthly).toBe(800)
    expect(c.leasesCounted).toBe(1)
    expect(c.monthlyIncome).toBe(800)
    expect(c.maxMonthlyPayment).toBe(200)      // 25% of 800
  })

  it('can never reach a $20,000 roof, over either plan length', async () => {
    const w = await world({ rent: 800, leases: 1 })
    expect(await canFinance({ landlordIds: [w.landlordId], amount: 20000, payments: 2 })
      .then(r => r.allowed)).toBe(false)
    expect(await canFinance({ landlordIds: [w.landlordId], amount: 20000, payments: 4 })
      .then(r => r.allowed)).toBe(false)
  })

  it('reaches $400 over two payments and $800 over four — and says so', async () => {
    const w = await world({ rent: 800, leases: 1 })
    const c = await capacity(w)
    // maxFinanced is the job PLUS its fee: the fee is spread across the
    // payments, so the landlord repays both and the ceiling covers both.
    expect(c.maxFinanced[2]).toBe(400)
    expect(c.maxFinanced[4]).toBe(800)

    // The largest JOB over two payments is $400 less its $25 fee = $375.
    expect((await canFinance({ landlordIds: [w.landlordId], amount: 375, payments: 2 })).allowed).toBe(true)
    expect((await canFinance({ landlordIds: [w.landlordId], amount: 376, payments: 2 })).allowed).toBe(false)
    // Over four payments, $800 less its $70 fee = $730.
    expect((await canFinance({ landlordIds: [w.landlordId], amount: 730, payments: 4 })).allowed).toBe(true)
    expect((await canFinance({ landlordIds: [w.landlordId], amount: 731, payments: 4 })).allowed).toBe(false)
  })

  it('a refusal over two payments names the four-payment plan that WOULD work', async () => {
    const w = await world({ rent: 800, leases: 1 })
    const r = await canFinance({ landlordIds: [w.landlordId], amount: 700, payments: 2 })
    expect(r.allowed).toBe(false)
    // $700 over 2 carries a $25 fee -> $725 -> $362.50 a month, over the $200
    // ceiling. Over 4 the fee is $70 -> $770 -> $192.50, which fits.
    expect(r.refusal).toMatch(/\$362\.50 a month/)
    expect(r.refusal).toMatch(/Over 4 payments it would be \$192\.50 a month, which it does/)
  })

  it('a refusal with no plan length that works names the largest job it can finance', async () => {
    const w = await world({ rent: 800, leases: 1 })
    const r = await canFinance({ landlordIds: [w.landlordId], amount: 20000, payments: 4 })
    expect(r.refusal).toMatch(/could carry about \$800\.00 including the fee/)
  })
})

// ── a bigger book ─────────────────────────────────────────────

describe('a bigger book carries a bigger job', () => {
  it('scales with the rent roll, with no ceiling of its own', async () => {
    const w = await world({ rent: 900, leases: 29 })   // 26,100 a month
    const c = await capacity(w)
    expect(c.leaseMonthly).toBe(26100)
    expect(c.maxMonthlyPayment).toBe(6525)
    // There is no fixed maximum job — a 29-space park reaches a $26,100 roof
    // over four payments, which is the whole point of an affordability rule.
    expect(c.maxFinanced[4]).toBe(26100)
    expect((await canFinance({ landlordIds: [w.landlordId], amount: 20000, payments: 4 })).allowed).toBe(true)
  })

  it('counts FLAT RENT ONLY — not a monthly ongoing fee, which can be re-rated', async () => {
    const w = await world({ rent: 800, leases: 1 })
    const lease = await query<{ id: string }>(`SELECT id FROM leases LIMIT 1`)
    await query(
      `INSERT INTO lease_fees (lease_id, fee_type, amount, due_timing, is_refundable)
       VALUES ($1, 'other_fee', 40, 'monthly_ongoing', FALSE)`, [lease[0].id])
    // Nic, 10/31: "it only needs to be flat rent. It should not count any
    // utilities for bill back or late fees, because those are variables that
    // can change." A lease fee can be added or re-rated the same way.
    const c = await capacity(w)
    expect(c.leaseMonthly).toBe(800)
    expect(c.maxMonthlyPayment).toBe(200)
  })

  it('counts no utility bill-back and no late fee, however much of either arrives', async () => {
    const w = await world({ rent: 800, leases: 1 })
    const c = await capacity(w)
    expect(c.leaseMonthly).toBe(800)
    // Said out loud on the result, so a screen can explain the figure.
    expect(c.basis).toMatch(/no utilities, no late fees/)
  })

  it('leaves out a move-in or move-out fee, which is not monthly income', async () => {
    const w = await world({ rent: 800, leases: 1 })
    const lease = await query<{ id: string }>(`SELECT id FROM leases LIMIT 1`)
    await query(
      `INSERT INTO lease_fees (lease_id, fee_type, amount, due_timing, is_refundable)
       VALUES ($1, 'other_fee', 500, 'move_in', FALSE)`, [lease[0].id])
    expect((await capacity(w)).leaseMonthly).toBe(800)
  })

  it('counts only ACTIVE leases — an ended tenancy invoices nothing', async () => {
    const w = await world({ rent: 800, leases: 2 })
    expect((await capacity(w)).leaseMonthly).toBe(1600)
    await query(`UPDATE leases SET status = 'terminated' WHERE id = (SELECT id FROM leases LIMIT 1)`)
    const c = await capacity(w)
    expect(c.leaseMonthly).toBe(800)
    expect(c.leasesCounted).toBe(1)
  })
})

// ── the unpredictable half, taken at its worst ────────────────

describe('short stays and the register are measured at their WORST month', () => {
  /** Put `amount` of register income on the books in the month `n` months back. */
  async function incomeInMonthsBack(w: World, n: number, amount: number) {
    const [y, m] = todayIn(null).slice(0, 7).split('-').map(Number)
    const total = (y * 12 + (m - 1)) - n
    const month = `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`
    // 'laundry' with no category_id is the house pattern for a plain
    // other-income row that counts on the P&L (routes/reports.test.ts).
    await query(
      `INSERT INTO landlord_other_income (landlord_id, property_id, category, amount, income_date)
       VALUES ($1, $2, 'laundry', $3, $4::date)`,
      [w.landlordId, w.propertyId, amount, `${month}-15`])
    return month
  }

  it('a month with nothing in it makes the unpredictable half contribute nothing', async () => {
    const w = await world({ rent: 800, leases: 1 })
    // Five good months and one empty one: the empty one decides.
    for (const n of [1, 2, 3, 4, 5]) await incomeInMonthsBack(w, n, 2000)
    const c = await capacity(w)
    expect(c.variableMonthly).toBe(0)
    expect(c.monthlyIncome).toBe(800)
    // A seasonal park cannot finance against a peak it does not repeat.
    expect(c.maxMonthlyPayment).toBe(200)
  })

  it('every month earning something lifts capacity by the LOWEST of them', async () => {
    const w = await world({ rent: 800, leases: 1 })
    const amounts = [2000, 1500, 400, 3000, 2500, 900]
    for (let n = 1; n <= 6; n++) await incomeInMonthsBack(w, n, amounts[n - 1])
    const c = await capacity(w)
    expect(c.variableMonthly).toBe(400)           // the worst month, not the average
    expect(c.monthlyIncome).toBe(1200)            // 800 rent + 400
    expect(c.maxMonthlyPayment).toBe(300)
    expect(c.variableMonths.length).toBe(6)
    expect(c.variableMonths.map(m => m.amount)).toContain(400)
  })

  it('names which month set the figure, so a low number can be explained', async () => {
    const w = await world({ rent: 800, leases: 1 })
    let worst = ''
    for (let n = 1; n <= 6; n++) {
      const month = await incomeInMonthsBack(w, n, n === 3 ? 100 : 5000)
      if (n === 3) worst = month
    }
    const c = await capacity(w)
    expect(c.variableMonthly).toBe(100)
    expect(c.variableWorstMonth).toBe(worst)
  })

  it('ignores the month in progress, which is half-counted by definition', async () => {
    const w = await world({ rent: 800, leases: 1 })
    for (let n = 1; n <= 6; n++) await incomeInMonthsBack(w, n, 2000)
    // A big sale TODAY must not move capacity, and an empty start of this month
    // must not collapse it.
    await query(
      `INSERT INTO landlord_other_income (landlord_id, property_id, category, amount, income_date)
       VALUES ($1, $2, 'laundry', 99999, CURRENT_DATE)`,
      [w.landlordId, w.propertyId])
    const c = await capacity(w)
    expect(c.variableMonthly).toBe(2000)
    expect(c.variableMonths.some(m => m.month === todayIn(null).slice(0, 7))).toBe(false)
  })

  // There is deliberately NO test here for a month that nets negative. The
  // give-back lines (returned, creditsGiven, stayShortened, paidAheadRefunded)
  // are excluded from the sum, and landlord_other_income's own CHECK forbids a
  // negative amount — so no month can reach that state, and a test pretending
  // to drive it would assert nothing while looking like coverage. The clamp in
  // the service says the same thing in its comment.
})

// ── scope ─────────────────────────────────────────────────────

describe('capacity is scoped like every other read', () => {
  it('another company\'s rent roll is not this company\'s capacity', async () => {
    const mine = await world({ rent: 800, leases: 1 })
    await world({ rent: 5000, leases: 20 })        // somebody else's park
    const c = await capacity(mine)
    expect(c.leaseMonthly).toBe(800)
    expect(c.maxMonthlyPayment).toBe(200)
  })

  it('a caller scoped to no property gets nothing, never the whole book', async () => {
    const w = await world({ rent: 800, leases: 1 })
    const c = await financingCapacityFor({ landlordIds: [w.landlordId], propertyIds: [] })
    expect(c.monthlyIncome).toBe(0)
    expect(c.maxMonthlyPayment).toBe(0)
    expect(c.whyNone).toMatch(/no rent coming in/)
  })

  it('a caller with no company at all gets nothing and a reason', async () => {
    const c = await financingCapacityFor({ landlordIds: [] })
    expect(c.maxMonthlyPayment).toBe(0)
    expect(c.whyNone).not.toBeNull()
  })

  it('narrowing to one property measures only that property', async () => {
    const w = await world({ rent: 800, leases: 1 })
    const other = await db.connect()
    try {
      await other.query('BEGIN')
      const p2 = await seedProperty(other, {
        landlordId: w.landlordId, ownerUserId: w.userId, managedByUserId: w.userId })
      const u2 = await seedUnit(other, { propertyId: p2, landlordId: w.landlordId })
      const t2 = await seedTenant(other)
      const l2 = await seedLease(other, { unitId: u2, landlordId: w.landlordId, status: 'active', rentAmount: 1200 })
      await seedLeaseTenant(other, { leaseId: l2, tenantId: t2 })
      await other.query('COMMIT')
    } finally { other.release() }

    expect((await capacity(w)).leaseMonthly).toBe(2000)
    const narrowed = await financingCapacityFor({
      landlordIds: [w.landlordId], propertyIds: [w.propertyId] })
    expect(narrowed.leaseMonthly).toBe(800)
  })
})

// ── the arithmetic itself ─────────────────────────────────────

describe('the payment ceiling', () => {
  it('rounds DOWN to the cent, so it never creeps past a quarter of income', async () => {
    const w = await world({ rent: 333.33, leases: 1 })
    const c = await capacity(w)
    // 25% of 333.33 is 83.3325 — a payment ceiling must not round up to 83.34.
    expect(c.maxMonthlyPayment).toBe(83.33)
    expect(c.maxMonthlyPayment).toBeLessThanOrEqual(c.monthlyIncome * 0.25)
  })

  it('states how it was worked out, rather than leaving a screen to guess', async () => {
    const w = await world({ rent: 800, leases: 1 })
    const c = await capacity(w)
    expect(c.basis).toMatch(/worst of the last 6 complete months/)
    expect(c.basis).toMatch(/25%/)
  })

  it('refuses a job with no amount', async () => {
    const w = await world({ rent: 8000, leases: 1 })
    for (const amount of [0, -100, NaN]) {
      const r = await canFinance({ landlordIds: [w.landlordId], amount, payments: 2 })
      expect(r.allowed).toBe(false)
      expect(r.refusal).toMatch(/has to have an amount/)
    }
  })
})

// ── the price card, and what the landlord actually pays ───────

describe('the financing fee, and the plan it makes', () => {
  it('is a flat fee per month of GAM\'s money, at $0.05 per dollar per month', async () => {
    // 10/31 (Nic): "Pick the line where the to-pay payments on the job is 235
    // $235 on a $10,000 job. And go from there. Use that across the board."
    //   fee = 0.0235 x job x (payments - 1)
    for (const [job, n, want] of [
      [10000, 2, 235], [10000, 4, 705], [10000, 6, 1175], [10000, 12, 2585],
      [20000, 2, 470], [20000, 4, 1410], [20000, 6, 2350], [20000, 12, 5170],
    ] as Array<[number, 2 | 4 | 6 | 12, number]>) {
      expect(await requireFinancingFee(job, n)).toBe(want)
    }
  })

  it('does NOT copy FlexDeposit, which is priced for a different purpose', async () => {
    // His reasoning for separating them: "Flex deposit was about helping low
    // income fixed... relieving a burden on their ability to move into a
    // place." GAM floats nothing on a deposit and fronts the contractor here.
    const fd = await query<{ fee: string }>(
      `SELECT fee::text AS fee FROM flexdeposit_fee_schedule
        WHERE 2800 > deposit_min AND 2800 <= deposit_max AND payments = 2`)
    const job = await requireFinancingFee(2800, 2)
    expect(job).not.toBe(Number(fd[0].fee))
    // FlexDeposit is untouched by any of this.
    expect(Number(fd[0].fee)).toBe(124)
  })

  it('scales straight with the job size — no volume discount, by construction', async () => {
    // A consequence of "flat fee per month" rather than a choice anybody made:
    // twice the job is twice the fee. FlexPay and FlexDeposit both taper; this
    // does not. Recorded so a later session does not read it as a bug.
    const ten = await requireFinancingFee(10000, 4)
    const twenty = await requireFinancingFee(20000, 4)
    expect(twenty).toBe(ten * 2)
  })

  it('refuses a job above the top bracket rather than making it free', async () => {
    await expect(requireFinancingFee(25000, 4)).rejects.toThrow(/does not finance/i)
    await expect(requireFinancingFee(25000, 4)).rejects.toThrow(/up to \$20,000/)
  })

  it('a later re-price never reaches a plan already priced today', async () => {
    const before = await requireFinancingFee(9000, 4)
    await query(
      `INSERT INTO job_financing_fee_schedule (job_min, job_max, payments, fee, effective_from, note)
       VALUES (7500, 10000, 4, 9999, CURRENT_DATE + 1, 'test re-price, tomorrow')`)
    try {
      expect(await requireFinancingFee(9000, 4)).toBe(before)
    } finally {
      // The price card is a KEPT table (CLEANUP_KEEPS), so cleanupAllSchema does
      // NOT wipe this row between tests — it would price every later test in
      // this file at $9,999. A file that borrows a price card puts it back
      // itself; services/flexFees.test.ts learned the same lesson.
      await query(`DELETE FROM job_financing_fee_schedule WHERE note = 'test re-price, tomorrow'`)
    }
  })

  it('splits the fee across the payments, so every payment is the same', async () => {
    const w = await world({ rent: 3000, leases: 10 })      // 30,000 a month
    const r = await canFinance({ landlordIds: [w.landlordId], amount: 10000, payments: 4 })
    expect(r.allowed).toBe(true)
    expect(r.fee).toBe(705)
    expect(r.financedTotal).toBe(10705)
    expect(r.schedule).toEqual([2676.25, 2676.25, 2676.25, 2676.25])
    expect(r.monthlyPayment).toBe(2676.25)
    // NOT FlexDeposit's shape: nothing rides the first payment.
    expect(new Set(r.schedule).size).toBe(1)
  })

  it('measures the 25% rule against the payment INCLUDING the fee', async () => {
    // Flat rent of $10,400 supports a $2,600 payment exactly. A $10,000 job
    // over four is $2,500 of job — which fits — but $2,631.25 with the fee,
    // which does not. The fee has to be in the test or this slips through.
    const w = await world({ rent: 10400, leases: 1 })
    const c = await capacity(w)
    expect(c.maxMonthlyPayment).toBe(2600)
    const r = await canFinance({ landlordIds: [w.landlordId], amount: 10000, payments: 4 })
    expect(r.monthlyPayment).toBe(2676.25)
    expect(r.allowed).toBe(false)
    expect(r.refusal).toMatch(/\$2,676\.25 a month/)
  })

  it('a refusal prices the other plan length on its OWN row, not the same fee', async () => {
    const w = await world({ rent: 2200, leases: 1 })        // $550 a month ceiling
    const r = await canFinance({ landlordIds: [w.landlordId], amount: 2000, payments: 2 })
    expect(r.allowed).toBe(false)
    // $2,000 lands in the $1,500–2,000 bracket (job_max is inclusive), so over
    // 2 the fee is $45 -> $2,045 -> $1,022.50 a month, over the $550 ceiling.
    // Over 4 the fee is $140 -> $2,140 -> $535.00, which fits. The sentence must
    // quote the 4-payment figure priced on its OWN row, not 2000/4.
    expect(r.refusal).toMatch(/\$1,022\.50 a month/)
    expect(r.refusal).toMatch(/Over 4 payments it would be \$535\.00 a month/)
  })

  it('the top bracket needs a real rent roll behind it', async () => {
    // Over four payments a $20,000 job is $5,240 a month, so about $20,960 of
    // flat rent — his intent exactly: a small park can never reach it.
    const small = await world({ rent: 800, leases: 1 })
    expect((await canFinance({ landlordIds: [small.landlordId], amount: 20000, payments: 4 })).allowed)
      .toBe(false)
    const park = await world({ rent: 900, leases: 29 })     // 26,100 a month
    const r = await canFinance({ landlordIds: [park.landlordId], amount: 20000, payments: 4 })
    expect(r.monthlyPayment).toBe(5352.50)
    expect(r.allowed).toBe(true)
  })
})

// ── six payments, on bigger jobs only ─────────────────────────

describe('six payments', () => {
  it('six and twelve are offered above $5,000 and not below it', async () => {
    expect(await requireFinancingFee(9000, 6)).toBe(1175)
    expect(await requireFinancingFee(9000, 12)).toBe(2585)
    for (const n of [6, 12] as const) {
      await expect(requireFinancingFee(2800, n)).rejects.toThrow(/does not finance/i)
      await expect(requireFinancingFee(4000, n)).rejects.toThrow(/does not finance/i)
    }
  })

  it('every bracket in the table IS the formula, to the dollar', async () => {
    // He asked "wouldn't the four payment fee just be double what the two
    // payment fee is?" — it is TRIPLE, because GAM's money is out for
    // (payments - 1) months: one against three. The relationship lives in the
    // formula, so the table is checked against the FORMULA rather than against
    // a multiple of another already-rounded fee, which magnifies that fee's $5
    // rounding by up to eleven times and proves nothing.
    const brackets = await query<{ job_max: string; payments: number; fee: string }>(
      `SELECT job_max::text, payments, fee::text FROM job_financing_fee_schedule
        ORDER BY job_financing_fee_schedule.job_max, payments`)
    expect(brackets.length).toBe(34)
    for (const b of brackets) {
      const want = financingFeeForReturn({
        job: Number(b.job_max),
        payments: b.payments,
        // $0.05 per dollar of GAM's money per month = 60% a year, which is the
        // $235-on-a-$10,000-job line Nic picked.
        annualReturn: FINANCING_PER_DOLLAR_MONTH * 12,
      })
      expect(Number(b.fee), `${b.payments} payments up to $${b.job_max}`).toBe(want)
    }
  })

  it('prices a longer plan higher every time, at every job size', async () => {
    for (const amount of [6000, 9000, 11000, 14000, 19000]) {
      let prev = 0
      for (const n of [2, 4, 6, 12] as const) {
        const fee = await requireFinancingFee(amount, n)
        expect(fee).toBeGreaterThan(prev)
        prev = fee
      }
    }
  })

  it('escalates properly: 2 cheapest, then 4, then 6, then 12', async () => {
    // His words: "the total cost of finance on doing 6 payments is going to be
    // way higher than doing just 2 payments, and 4 will be a middle ground."
    const fees = []
    for (const n of [2, 4, 6, 12] as const) fees.push(await requireFinancingFee(9000, n))
    for (let i = 1; i < fees.length; i++) expect(fees[i]).toBeGreaterThan(fees[i - 1])
  })

  it('lets a smaller park reach a job four payments cannot', async () => {
    // A $20,000 roof: ~$20,960 of flat rent needed over four, ~$14,230 over six.
    // This park is in between, so six is the only plan that reaches it.
    const w = await world({ rent: 900, leases: 18 })      // $16,200 a month
    const four = await canFinance({ landlordIds: [w.landlordId], amount: 20000, payments: 4 })
    expect(four.allowed).toBe(false)
    const six = await canFinance({ landlordIds: [w.landlordId], amount: 20000, payments: 6 })
    expect(six.allowed).toBe(true)
    expect(six.fee).toBe(2350)
    expect(six.schedule.length).toBe(6)
    expect(six.monthlyPayment).toBeCloseTo(3725, 2)
  })

  it('a four-payment refusal points at six when six would work', async () => {
    const w = await world({ rent: 900, leases: 18 })
    const r = await canFinance({ landlordIds: [w.landlordId], amount: 20000, payments: 4 })
    expect(r.refusal).toMatch(/Over 6 payments it would be \$3,725\.00 a month, which it does/)
  })

  it('the database refuses a six-payment bracket below the floor', async () => {
    await expect(query(
      `INSERT INTO job_financing_fee_schedule (job_min, job_max, payments, fee, effective_from)
       VALUES (900, 1000, 6, 90, DATE '2020-01-01')`)).rejects.toThrow()
  })
})

// ── what the reserve pool has to fund ─────────────────────────

describe('what GAM has to front', () => {
  it('matches his own arithmetic on a $10,000 job to the cent', async () => {
    // 10/31 (Nic): "on a $10,000 job... we take $300 at 3%, the contractor needs
    // $9,700... the first payment of either 4 or 6 on that, let's say 4, is
    // going to be what, $2,500 with our installment loan, $2,600. So we need
    // roughly $7,000 out of pocket for a $10,000 job. So we need roughly 70% in
    // the pool."
    const o = financingOutlay({ amount: 10000, payments: 4, fee: 705, cutPercent: 3 })
    expect(o.marketplaceCut).toBe(300)
    expect(o.toContractor).toBe(9700)
    expect(o.collectedOnDayOne).toBe(2676.25)
    expect(o.outOfPocket).toBe(7023.75)
    expect(o.shareOfJob).toBeCloseTo(0.702, 3)      // his 70%
  })

  it('the longer the plan, the hungrier the pool', async () => {
    const two  = financingOutlay({ amount: 10000, payments: 2, fee: 235,  cutPercent: 3 })
    const four = financingOutlay({ amount: 10000, payments: 4, fee: 705,  cutPercent: 3 })
    const six  = financingOutlay({ amount: 10000, payments: 6, fee: 1175, cutPercent: 3 })
    expect(two.shareOfJob).toBeCloseTo(0.46, 2)
    expect(four.shareOfJob).toBeCloseTo(0.70, 2)
    expect(six.shareOfJob).toBeCloseTo(0.78, 2)
    // The option that lets a smaller park reach a big job is the one that costs
    // the pool most, and it holds the money two months longer as well.
    expect(six.outOfPocket).toBeGreaterThan(four.outOfPocket)
  })

  it('scales with the job, so the pool can be sized off it', async () => {
    const ten = financingOutlay({ amount: 10000, payments: 4, fee: 705, cutPercent: 3 })
    const twenty = financingOutlay({ amount: 20000, payments: 4, fee: 1410, cutPercent: 3 })
    expect(twenty.outOfPocket).toBe(14047.5)
    // Ten concurrent $10,000 jobs on four payments need about $70,200 standing by.
    expect(ten.outOfPocket * 10).toBeCloseTo(70237.5, 2)
  })

  it('is stated on every quote, because a plan GAM cannot fund is not a plan', async () => {
    const w = await world({ rent: 3000, leases: 10 })
    const r = await canFinance({ landlordIds: [w.landlordId], amount: 10000, payments: 4 })
    expect(r.allowed).toBe(true)
    expect(r.outlay).not.toBeNull()
    expect(r.outlay!.outOfPocket).toBe(7023.75)
    expect(r.outlay!.marketplaceCut).toBe(300)
    // The cut comes from its own price card, not a constant.
    expect(r.outlay!.toContractor).toBe(9700)
  })

  it('takes the cut from the price card, so a re-priced cut moves the outlay', async () => {
    const w = await world({ rent: 3000, leases: 10 })
    await query(
      `INSERT INTO marketplace_cut_rates (percent, effective_from, note)
       VALUES (5.000, CURRENT_DATE - 1, 'test cut re-price')`)
    try {
      const r = await canFinance({ landlordIds: [w.landlordId], amount: 10000, payments: 4 })
      expect(r.outlay!.marketplaceCut).toBe(500)
      expect(r.outlay!.toContractor).toBe(9500)
      expect(r.outlay!.outOfPocket).toBe(6823.75)
    } finally {
      // A kept table: put it back, or every later test prices the cut at 5%.
      await query(`DELETE FROM marketplace_cut_rates WHERE note = 'test cut re-price'`)
    }
  })
})

/**
 * THE SHIPPING DEFAULT: closed.
 *
 * 10/31 (Nic): "I think we launch the contractor stuff now just have financing
 * jobs off. We still take 3 percent... Reserve pool comes later." So the
 * marketplace goes live and this does not, and the thing that keeps it shut is
 * one platform flag that defaults to FALSE.
 */
describe('financing is held closed until the reserve pool is funded', () => {
  it('a company that could easily carry the job is still refused', async () => {
    const w = await world({ rent: 5000, leases: 10 })
    // Switched on by beforeEach — turn it back off to see the shipping state.
    await query(`UPDATE system_features SET enabled = FALSE WHERE key = 'job_financing_enabled'`)
    const r = await canFinance({ landlordIds: [w.landlordId], amount: 4000, payments: 2 })
    expect(r.allowed).toBe(false)
    expect(r.refusal).toBe(FINANCING_CLOSED)
    // $50,000 a month of rent carries a great deal; none of it is quoted.
    expect(r.maxMonthlyPayment).toBe(0)
    expect(r.fee).toBe(0)
    expect(r.schedule).toEqual([])
    expect(r.outlay).toBeNull()
  })

  it('refuses without reading their rent roll — nothing was measured', async () => {
    const w = await world({ rent: 5000, leases: 10 })
    await query(`UPDATE system_features SET enabled = FALSE WHERE key = 'job_financing_enabled'`)
    const r = await canFinance({ landlordIds: [w.landlordId], amount: 4000, payments: 2 })
    expect(r.capacity.leaseMonthly).toBe(0)
    expect(r.capacity.leasesCounted).toBe(0)
    expect(r.capacity.basis).toMatch(/not open/i)
  })

  it('the refusal leaves them somewhere to go, and never says the marketplace is shut', async () => {
    const w = await world({ rent: 800 })
    await query(`UPDATE system_features SET enabled = FALSE WHERE key = 'job_financing_enabled'`)
    const r = await canFinance({ landlordIds: [w.landlordId], amount: 4000, payments: 2 })
    expect(r.refusal).toMatch(/take bids/i)
    expect(r.refusal).not.toMatch(/unavailable|error|cannot/i)
  })

  it('a missing flag row is closed, not open — absence is never permission', async () => {
    const w = await world({ rent: 5000, leases: 10 })
    await query(`DELETE FROM system_features WHERE key = 'job_financing_enabled'`)
    const r = await canFinance({ landlordIds: [w.landlordId], amount: 4000, payments: 2 })
    expect(r.allowed).toBe(false)
    expect(r.refusal).toBe(FINANCING_CLOSED)
  })
})

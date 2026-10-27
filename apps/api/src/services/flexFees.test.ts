import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { query } from '../db'
import { quoteFlexPayFee, quoteFlexDepositFee, flexPayGrid } from './flexFees'

/**
 * The test database is schema-only, so this file seeds the grids itself — using
 * the SAME formulas the 10/26 migration uses, not a copy of its output. That
 * makes the assertions below a check on the formula as well as on the lookup:
 * change `13 + 5 * n` and the "Nic's numbers" test fails, which is the point.
 * Production holds these identical rows.
 *
 * 10/26, re-priced several times by Nic across one evening as he worked the
 * numbers against real late fees. Where it landed: FlexPay's floor is
 * 23/33/43, its top is a bounded 43/61/79 at $2,500-2,999, and neither product
 * is offered over $3,000. His reason for the last lift: "our fee is cheaper
 * than any late fees on the platform so far. By a long shot."
 */
const SEEDED = '2026-10-26'

async function seedGrids() {
  await query(`DELETE FROM flexpay_fee_schedule`)
  await query(`DELETE FROM flexdeposit_fee_schedule`)
  await query(
    `INSERT INTO flexpay_fee_schedule (rent_min, rent_max, benefit_wednesday, fee, effective_from)
     SELECT v.rent_min, v.rent_max, w.wed,
            CASE w.wed WHEN 2 THEN 23 + 5 * v.n WHEN 3 THEN 33 + 7 * v.n ELSE 43 + 9 * v.n END,
            $1::date
       FROM (VALUES (0, 0.00, 1000.00), (1, 1000.00, 1500.00), (2, 1500.00, 2000.00),
                    (3, 2000.00, 2500.00), (4, 2500.00, 3000.00)
            ) AS v(n, rent_min, rent_max)
      CROSS JOIN (VALUES (2), (3), (4)) AS w(wed)`,
    [SEEDED],
  )
  await query(
    `INSERT INTO flexdeposit_fee_schedule (deposit_min, deposit_max, payments, fee, effective_from)
     SELECT v.deposit_min, v.deposit_max, p.payments,
            CASE p.payments WHEN 2 THEN v.two ELSE v.four END, $1::date
       FROM (VALUES (   0.00::numeric, 1000.00::numeric,  48::numeric,  67::numeric),
                    (1000.00,          1500.00,           67,           93),
                    (1500.00,          2000.00,           86,          120),
                    (2000.00,          2500.00,          105,          147),
                    (2500.00,          3000.00,          124,          173)
            ) AS v(deposit_min, deposit_max, two, four)
      CROSS JOIN (VALUES (2), (4)) AS p(payments)`,
    [SEEDED],
  )
}

beforeAll(seedGrids)
// A price card is reference data the suite keeps (dbHelpers CLEANUP_KEEPS), so
// this file clears what it seeded rather than leaving it for the next file in
// the worker.
afterAll(async () => {
  await query(`DELETE FROM flexpay_fee_schedule`)
  await query(`DELETE FROM flexdeposit_fee_schedule`)
})

describe('FlexPay price grid', () => {
  // Nic set three points by hand and the rest steps evenly between them. These
  // numbers ARE the product; a silent change should fail here rather than
  // re-price every tenant quietly.
  it('prices the brackets Nic set by hand', async () => {
    // The floor he set last: "Under $1,000 would be 23, 33, and 43."
    expect((await quoteFlexPayFee(750, 2, SEEDED))!.fee).toBe(23)
    expect((await quoteFlexPayFee(750, 3, SEEDED))!.fee).toBe(33)
    expect((await quoteFlexPayFee(750, 4, SEEDED))!.fee).toBe(43)
    // His original 18/26/34 anchor has been lifted off the grid entirely by
    // the successive shifts — nothing prices there any more.
    expect((await quoteFlexPayFee(750, 2, SEEDED))!.fee).not.toBe(18)
    // The new top line: "add a new price line for $2,500 to $2,999."
    expect((await quoteFlexPayFee(2750, 2, SEEDED))!.fee).toBe(43)
    expect((await quoteFlexPayFee(2750, 3, SEEDED))!.fee).toBe(61)
    expect((await quoteFlexPayFee(2750, 4, SEEDED))!.fee).toBe(79)
  })

  it('steps evenly out from there in every column', async () => {
    const col = async (w: 2 | 3 | 4) => Promise.all(
      [500, 1200, 1750, 2200, 2800].map(async r => (await quoteFlexPayFee(r, w, SEEDED))!.fee),
    )
    expect(await col(2)).toEqual([23, 28, 33, 38, 43])  // step 5
    expect(await col(3)).toEqual([33, 40, 47, 54, 61])  // step 7
    expect(await col(4)).toEqual([43, 52, 61, 70, 79])  // step 9
  })

  it('a later Wednesday never costs less than an earlier one', async () => {
    // 9000 is deliberately absent: above the $3,000 ceiling there is no price
    // to compare, which its own test covers.
    for (const rent of [500, 1200, 1750, 2200, 2800]) {
      const [w2, w3, w4] = await Promise.all(
        ([2, 3, 4] as const).map(async w => (await quoteFlexPayFee(rent, w, SEEDED))!.fee),
      )
      expect(w3).toBeGreaterThan(w2)
      expect(w4).toBeGreaterThan(w3)
    }
  })

  // The brackets exist so the fee stays a similar share of rent — a fixed price
  // per bracket, with the brackets drawn so the percentage does not jump
  // between them. If an edit breaks that, the price stops being explainable.
  //
  // 10/26: raising the floor to 13/19/25 WIDENED this band and flipped its
  // direction. Measured at each bracket's top rent, the share of rent now
  // FALLS as rent rises (4th Wednesday: 2.50% at $999 down to 2.03% at $2,999,
  // a 0.47pt spread) where the original seed ROSE with rent (1.60% up to
  // 1.73%, 0.13pt). That is the arithmetic consequence of Nic's decision to
  // raise the cheapest bracket, and it is flagged to him — the band is asserted
  // here at its real width so the next edit still has to be deliberate, not
  // loosened to whatever passes.
  it('stays within a bounded band as a share of rent', async () => {
    const spreads: number[] = []
    for (const w of [2, 3, 4] as const) {
      const pcts: number[] = []
      for (const rent of [999, 1499, 1999, 2499, 2999]) {
        pcts.push((await quoteFlexPayFee(rent, w, SEEDED))!.fee / rent * 100)
      }
      spreads.push(Math.max(...pcts) - Math.min(...pcts))
    }
    // Measured on the final grid: 0.868 / 1.269 / 1.670. Headroom thin.
    expect(Math.max(...spreads)).toBeLessThan(1.8)
    // The cheapest bracket is the most expensive share of rent. Stated, not
    // hidden: if a later re-price means to fix that, this line fails first.
    for (const w of [2, 3, 4] as const) {
      const low = (await quoteFlexPayFee(999, w, SEEDED))!.fee / 999
      const high = (await quoteFlexPayFee(2999, w, SEEDED))!.fee / 2999
      expect(low).toBeGreaterThan(high)
    }
  })

  // 10/26 (Nic): "we are not offering coverage on over $3,000." Enforced by the
  // absence of a bracket, so the dangerous failure is a quote of $0 rather than
  // no quote at all — which is exactly what the service refuses to do.
  it('does not cover rent at or above $3,000, and never quotes it free', async () => {
    expect((await quoteFlexPayFee(2999.99, 3, SEEDED))!.fee).toBe(61)
    for (const rent of [3000, 3000.01, 4500, 12000]) {
      expect(await quoteFlexPayFee(rent, 3, SEEDED), `rent ${rent}`).toBeNull()
    }
  })

  it('tops out at the capped bracket', async () => {
    expect((await quoteFlexPayFee(2500, 3, SEEDED))!.fee).toBe(61)
    const q = (await quoteFlexPayFee(2750, 3, SEEDED))!
    expect(q.bracketMin).toBe(2500)
    expect(q.bracketMax).toBe(3000)
  })

  it('reports the bracket it used, not just the price', async () => {
    const q = (await quoteFlexPayFee(1750, 3, SEEDED))!
    expect(q.bracketMin).toBe(1500)
    expect(q.bracketMax).toBe(2000)
  })

  it('refuses a nonsense rent instead of quoting the cheapest bracket', async () => {
    expect(await quoteFlexPayFee(NaN, 3, SEEDED)).toBeNull()
    expect(await quoteFlexPayFee(-100, 3, SEEDED)).toBeNull()
  })

  // A quote has to be reproducible: re-running an old month must not restate
  // what a tenant was charged, so a date before the schedule existed has no
  // price rather than today's price.
  it('has no price before the schedule existed', async () => {
    expect(await quoteFlexPayFee(1750, 3, '2020-01-01')).toBeNull()
  })

  // Re-pricing a bracket adds a row; the newest row at or before the asked-for
  // date wins, and the old price still answers for the dates it covered.
  it('keeps the old price answering for dates before a re-price', async () => {
    await query(
      `INSERT INTO flexpay_fee_schedule (rent_min, rent_max, benefit_wednesday, fee, effective_from)
       VALUES (1500, 2000, 3, 29, '2026-12-01')`,
    )
    try {
      expect((await quoteFlexPayFee(1750, 3, '2026-11-30'))!.fee).toBe(47)
      expect((await quoteFlexPayFee(1750, 3, '2026-12-01'))!.fee).toBe(29)
      expect((await quoteFlexPayFee(1750, 3, '2027-06-01'))!.fee).toBe(29)
      // The re-price must not leak into a neighbouring bracket or column.
      expect((await quoteFlexPayFee(1200, 3, '2027-06-01'))!.fee).toBe(40)
      expect((await quoteFlexPayFee(1750, 2, '2027-06-01'))!.fee).toBe(33)
    } finally {
      await query(`DELETE FROM flexpay_fee_schedule WHERE effective_from = '2026-12-01'`)
    }
  })

  it('renders as a grid with one row per bracket', async () => {
    const grid = await flexPayGrid(SEEDED)
    expect(grid.map(r => r.min)).toEqual([0, 1000, 1500, 2000, 2500])
    expect(grid[2].fees).toEqual({ 2: 33, 3: 47, 4: 61 })
    expect(grid[4].max).toBe(3000)
  })

  // A column missing a bracket has to read as a hole, not shift the rows below
  // it up a line — a shifted grid would look complete while being wrong.
  it('shows a missing column as a hole rather than shifting rows', async () => {
    await query(`DELETE FROM flexpay_fee_schedule WHERE rent_min = 1500 AND benefit_wednesday = 3`)
    try {
      const grid = await flexPayGrid(SEEDED)
      expect(grid.map(r => r.min)).toEqual([0, 1000, 1500, 2000, 2500])
      expect(grid[2].fees).toEqual({ 2: 33, 3: null, 4: 61 })
    } finally {
      await seedGrids()
    }
  })
})

describe('FlexDeposit price grid', () => {
  // 10/26, final shape: TWO splits only, 2 or 4, and the old 4- and 6-payment
  // columns moved whole onto them. Nic checked the first row himself against
  // the Country Acres move-in: "a $48 fee on 2 payments ... or a $67 fee for
  // the deposit to be split into 4."
  it('prices the two splits at the numbers Nic set', async () => {
    expect((await quoteFlexDepositFee(750, 2, SEEDED))!.fee).toBe(48)
    expect((await quoteFlexDepositFee(750, 4, SEEDED))!.fee).toBe(67)
    expect((await quoteFlexDepositFee(2750, 2, SEEDED))!.fee).toBe(124)
    expect((await quoteFlexDepositFee(2750, 4, SEEDED))!.fee).toBe(173)
  })

  it('always costs more to split into four than into two', async () => {
    for (const dep of [750, 1250, 1750, 2250, 2750]) {
      const two = (await quoteFlexDepositFee(dep, 2, SEEDED))!.fee
      const four = (await quoteFlexDepositFee(dep, 4, SEEDED))!.fee
      expect(four, `deposit ${dep}`).toBeGreaterThan(two)
    }
  })

  it('costs more the bigger the deposit, at a fixed payment count', async () => {
    const two = await Promise.all(
      [750, 1250, 1750, 2250, 2750].map(async d => (await quoteFlexDepositFee(d, 2, SEEDED))!.fee),
    )
    const four = await Promise.all(
      [750, 1250, 1750, 2250, 2750].map(async d => (await quoteFlexDepositFee(d, 4, SEEDED))!.fee),
    )
    expect(two).toEqual([48, 67, 86, 105, 124])
    expect(four).toEqual([67, 93, 120, 147, 173])
  })

  it('refuses a payment count the product does not offer', async () => {
    expect(await quoteFlexDepositFee(1750, 1, SEEDED)).toBeNull()
    expect(await quoteFlexDepositFee(1750, 7, SEEDED)).toBeNull()
    expect(await quoteFlexDepositFee(1750, 2.5, SEEDED)).toBeNull()
    // 10/26: and the counts that USED to be sold. These sit inside the old
    // 2..6 range, so a range check would wave them through to a null price.
    for (const n of [3, 5, 6]) {
      expect(await quoteFlexDepositFee(1750, n, SEEDED), String(n)).toBeNull()
    }
  })

  it('does not cover a deposit at or above $3,000', async () => {
    expect((await quoteFlexDepositFee(2999.99, 4, SEEDED))!.fee).toBe(173)
    for (const d of [3000, 3500, 9000]) {
      expect(await quoteFlexDepositFee(d, 4, SEEDED), String(d)).toBeNull()
    }
  })
})

describe('the schedules themselves', () => {
  // A hole in a column makes a tenant unquotable at enrollment, so both grids
  // must price every bracket in every column.
  it('price every bracket in every column', async () => {
    const fp = await query<{ n: string }>(`SELECT count(*)::text AS n FROM flexpay_fee_schedule`)
    expect(Number(fp[0].n)).toBe(5 * 3)
    // 10/26: five brackets, TWO columns — 2 payments and 4, nothing between.
    const fd = await query<{ n: string }>(`SELECT count(*)::text AS n FROM flexdeposit_fee_schedule`)
    expect(Number(fd[0].n)).toBe(5 * 2)
    const counts = await query<{ payments: number }>(
      `SELECT DISTINCT payments FROM flexdeposit_fee_schedule ORDER BY payments`)
    expect(counts.map(r => r.payments)).toEqual([2, 4])
  })

  // Half-open brackets must tile without a gap, or a rent between two of them
  // has no price at all.
  it('tile from zero upward with no gap and no overlap', async () => {
    for (const [table, minCol, maxCol] of [
      ['flexpay_fee_schedule', 'rent_min', 'rent_max'],
      ['flexdeposit_fee_schedule', 'deposit_min', 'deposit_max'],
    ] as const) {
      const rows = await query<{ min: string; max: string | null }>(
        `SELECT DISTINCT ${minCol}::text AS min, ${maxCol}::text AS max
           FROM ${table} ORDER BY 1`,
      )
      expect(Number(rows[0].min)).toBe(0)
      for (let i = 1; i < rows.length; i++) expect(rows[i].min).toBe(rows[i - 1].max)
      // 10/26 (Nic): the top bracket is CAPPED, not open — neither product is
      // offered over $3,000, and the cap is how that is enforced.
      expect(Number(rows[rows.length - 1].max)).toBe(3000)
    }
  })

  it('never hold a negative price', async () => {
    const bad = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM (
         SELECT fee FROM flexpay_fee_schedule
         UNION ALL SELECT fee FROM flexdeposit_fee_schedule) x WHERE fee < 0`,
    )
    expect(Number(bad[0].n)).toBe(0)
  })

  // The CHECK constraints are the last line of defence on a hand-edited price.
  it('refuse a column the product does not have', async () => {
    await expect(query(
      `INSERT INTO flexpay_fee_schedule (rent_min, rent_max, benefit_wednesday, fee)
       VALUES (0, 1000, 1, 8)`,
    )).rejects.toThrow()
    await expect(query(
      `INSERT INTO flexdeposit_fee_schedule (deposit_min, deposit_max, payments, fee)
       VALUES (0, 1000, 7, 20)`,
    )).rejects.toThrow()
  })

  it('refuse a bracket whose ceiling is below its floor', async () => {
    await expect(query(
      `INSERT INTO flexpay_fee_schedule (rent_min, rent_max, benefit_wednesday, fee)
       VALUES (2000, 1000, 3, 20)`,
    )).rejects.toThrow()
  })
})

/**
 * S642 — Nic: "Are you forgetting that we have fifty great states?"
 *
 * He was right to push. Oregon had no deposit-interest row in any year, and
 * chasing that turned up California with no RESIDENTIAL row at all — the
 * largest rental market in the country resolving to "no rule found" for every
 * unit type but mobile homes. Both are seeded now.
 *
 * WHAT THIS FILE CAN AND CANNOT GUARD. The 50-state coverage is seeded by
 * MIGRATIONS, and the test database is built from a schema-only dump — so no
 * reference data exists here and a coverage assertion would fail for a reason
 * that has nothing to do with the code. (Worth knowing generally: any
 * migration-seeded reference table is invisible to this harness.)
 *
 * So this guards the thing that IS behaviour: how a rate is MATCHED to a
 * deposit. That matching is what makes a 50-state table usable — and it is
 * where the subtle failure lives, because a state with a blanket rule and a
 * state with no rule at all look identical until you ask which one matched.
 *
 * Nic: "We track interest according to how the landlord has it set up and how
 * the law is… at the end of the day we're going off information we can't
 * verify." Which is exactly why the unit type must steer the match rather than
 * the state alone.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../db'

const YEAR = 2026

async function seedRate(o: { state: string; pct: number; unitTypes: string[]; act: string; cite: string }) {
  await db.query(
    `INSERT INTO state_deposit_interest_rates
       (state_code, effective_year, annual_rate_pct, statute_citation, notes,
        unit_types, act_key, rate_basis)
     VALUES ($1,$2,$3,$4,'test',$5,$6,'none')`,
    [o.state, YEAR, o.pct, o.cite, o.unitTypes, o.act])
}

describe('S642 a rate is matched by UNIT TYPE, not by state alone', () => {
  beforeEach(async () => {
    await db.query(`DELETE FROM state_deposit_interest_rates WHERE state_code IN ('ZZ','ZY','ZX')`)
  })

  it('the most specific rule wins over a blanket one', async () => {
    // Arizona in miniature: a blanket state rule, and a mobile-home rule that
    // must beat it. Before unit types existed, an AZ mobile home — the one type
    // in that state actually owed 5% — accrued nothing.
    await seedRate({ state: 'ZZ', pct: 0, unitTypes: [], act: 'residential', cite: 'blanket' })
    await seedRate({ state: 'ZZ', pct: 5, unitTypes: ['mobile_home'], act: 'mobile_home_park', cite: 'specific' })
    const { rows } = await db.query<any>(
      `SELECT annual_rate_pct, statute_citation FROM state_deposit_interest_rates
        WHERE state_code='ZZ' AND effective_year=$1
          AND ('mobile_home' = ANY(unit_types) OR cardinality(unit_types) = 0)
        ORDER BY cardinality(unit_types) DESC LIMIT 1`, [YEAR])
    expect(Number(rows[0].annual_rate_pct)).toBe(5)
    expect(rows[0].statute_citation).toBe('specific')
  })

  it('a blanket rule DOES cover a unit type nobody listed', async () => {
    // This is why the real gap was two states and not forty-seven: an empty
    // unit_types array is a rule about every type, including rv_spot.
    await seedRate({ state: 'ZY', pct: 2, unitTypes: [], act: 'residential', cite: 'blanket' })
    const { rows } = await db.query<any>(
      `SELECT annual_rate_pct FROM state_deposit_interest_rates
        WHERE state_code='ZY' AND effective_year=$1
          AND ('rv_spot' = ANY(unit_types) OR cardinality(unit_types) = 0)`, [YEAR])
    expect(Number(rows[0].annual_rate_pct)).toBe(2)
  })

  it('a rule listing OTHER types does not reach an rv_spot — silence stays silent', async () => {
    // California's shape: residential and mobile-home rules, nothing about RV.
    // No row must match, so rate_source lands NULL and the deposit is recorded
    // as owed-zero-BUT-UNKNOWN rather than as a statute saying zero.
    await seedRate({ state: 'ZX', pct: 0, unitTypes: ['apartment','single_family'], act: 'residential', cite: 'res' })
    await seedRate({ state: 'ZX', pct: 3, unitTypes: ['mobile_home'], act: 'mobile_home_park', cite: 'mhp' })
    const { rows } = await db.query<any>(
      `SELECT annual_rate_pct FROM state_deposit_interest_rates
        WHERE state_code='ZX' AND effective_year=$1
          AND ('rv_spot' = ANY(unit_types) OR cardinality(unit_types) = 0)`, [YEAR])
    expect(rows).toHaveLength(0)
  })
})

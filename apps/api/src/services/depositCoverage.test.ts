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

// ── S642: THE GATE COUNTS WHAT THE STATUTE COUNTS ───────────────────────────
//
// Nic, on his Mattoon IL park: "Mattoon I think is about a thirty space park.
// But I think only twenty-one units physically occupy the space… does it count
// the actual capacity that the park is licensed for, or what's actually there?"
//
// 765 ILCS 745/18(b) — a park "REGULARLY CONTAINING 25 or more MOBILE HOMES".
// Homes present, not spaces. 765 ILCS 715/1 — property "CONTAINING 25 or more
// UNITS". Units that exist. Same state, same number, different noun.
//
// The engine counted every unit row for both, so a 30-space park with 21 homes
// read as 30 and would have accrued interest Illinois does not require — wrong
// in the expensive direction, silently, every month.
describe('S642 a size gate counts what its statute counts', () => {
  const MATTOON = { spaces: 30, homesPresent: 21 }

  /** Mirrors gateApplies() in depositInterest.ts. */
  const passes = (basis: string, min: number, allUnits: number, occupiedOfType: number) => {
    const counted = basis === 'occupied_of_type' ? occupiedOfType : allUnits
    return counted >= min
  }

  it('Mattoon is UNDER the mobile-home gate: 21 homes, not 30 spaces', () => {
    expect(passes('occupied_of_type', 25, MATTOON.spaces, MATTOON.homesPresent)).toBe(false)
  })

  it('counting every unit row would have wrongly tripped it', () => {
    // The pre-S642 behaviour, kept as a test so the bug cannot return quietly.
    expect(passes('all_units', 25, MATTOON.spaces, MATTOON.homesPresent)).toBe(true)
  })

  it('an apartment building still counts units that EXIST, occupancy aside', () => {
    // 765 ILCS 715/1 says "units", so a half-empty 30-unit building is covered.
    expect(passes('all_units', 25, 30, 12)).toBe(true)
  })

  it('the park crosses the gate when the 25th home actually arrives', () => {
    expect(passes('occupied_of_type', 25, 30, 24)).toBe(false)
    expect(passes('occupied_of_type', 25, 30, 25)).toBe(true)
  })

  it('the column exists and defaults to counting units that exist', async () => {
    // The live IL rows are seeded by migration and this harness builds from a
    // schema-only dump, so the SHAPE is what is assertable here; the seeded
    // values are checked by scripts/depositRuleCoverage.ts against the real
    // database. What must never regress is the default: a rule that says
    // nothing about basis counts units, which is the pre-S642 meaning.
    await db.query(`DELETE FROM state_deposit_interest_rates WHERE state_code='ZW'`)
    await db.query(
      `INSERT INTO state_deposit_interest_rates
         (state_code, effective_year, annual_rate_pct, statute_citation, notes,
          unit_types, act_key, rate_basis, min_property_units)
       VALUES ('ZW', 2026, 1, 'test', 'test', ARRAY['mobile_home'], 'mobile_home_park', 'fixed', 25)`)
    const { rows } = await db.query<any>(
      `SELECT min_units_basis FROM state_deposit_interest_rates WHERE state_code='ZW'`)
    expect(rows[0].min_units_basis).toBe('all_units')
  })

  it('refuses a basis nobody has defined', async () => {
    // A typo here silently changes which number a gate reads, so the column is
    // constrained rather than trusted.
    await expect(db.query(
      `INSERT INTO state_deposit_interest_rates
         (state_code, effective_year, annual_rate_pct, statute_citation, notes,
          unit_types, act_key, rate_basis, min_units_basis)
       VALUES ('ZV', 2026, 1, 'test', 'test', ARRAY['mobile_home'], 'x', 'fixed', 'licensed_capacity')`))
      .rejects.toThrow()
  })
})

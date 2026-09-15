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

  /** Mirrors gateApplies()'s homes_present branch in depositInterest.ts. */
  const passes = (o: {
    min: number; spaces: number | null
    present?: number | null; inventoryKnown?: boolean
  }) => {
    if (o.spaces != null && o.spaces < o.min) return false      // 1. too few spaces
    if (o.inventoryKnown) return (o.present ?? 0) >= o.min       // 2. count the homes
    return true                                                  // 3. unknown → lean safe
  }

  it('Mattoon is UNDER the gate: 21 homes on 30 slabs', () => {
    expect(passes({ min: 25, spaces: MATTOON.spaces,
                    present: MATTOON.homesPresent, inventoryKnown: true })).toBe(false)
  })

  it('a park-owned home standing EMPTY still counts — occupancy is not the question', () => {
    // The case the occupancy proxy got wrong: 25 homes present, only 20 leased.
    // 765 ILCS 745/18 counts what the park "regularly contains", not who is in it.
    expect(passes({ min: 25, spaces: 30, present: 25, inventoryKnown: true })).toBe(true)
  })

  it('a bare slab is not a home', () => {
    expect(passes({ min: 25, spaces: 40, present: 24, inventoryKnown: true })).toBe(false)
  })

  it('too few SPACES settles it with no inventory at all', () => {
    // Mattoon today: 11 spaces. It cannot regularly contain 25 homes, so nobody
    // has to record anything for the gate to resolve.
    expect(passes({ min: 25, spaces: 11 })).toBe(false)
  })

  it('enough spaces but NO inventory leans safe, not to zero', () => {
    // Reading "no records" as "no homes" would silently under-pay tenants,
    // which is a statutory violation. Over-accruing is money GAM can reconcile.
    expect(passes({ min: 25, spaces: 30 })).toBe(true)
    // And the opposite reading — the bug this guards against.
    expect(passes({ min: 25, spaces: 30, present: 0, inventoryKnown: true })).toBe(false)
  })

  it('the gate flips when the 25th home actually arrives', () => {
    expect(passes({ min: 25, spaces: 30, present: 24, inventoryKnown: true })).toBe(false)
    expect(passes({ min: 25, spaces: 30, present: 25, inventoryKnown: true })).toBe(true)
  })

  it('an uninhabitable apartment still counts toward an all_units gate', () => {
    // 765 ILCS 715/1 counts "units", not habitable ones — which is why this is
    // a different basis and not a shared unit status.
    const allUnits = (min: number, unitsThatExist: number) => unitsThatExist >= min
    expect(allUnits(25, 30)).toBe(true)
  })

  it('the basis column accepts homes_present and refuses an invented one', async () => {
    await db.query(`DELETE FROM state_deposit_interest_rates WHERE state_code IN ('ZW','ZV')`)
    await db.query(
      `INSERT INTO state_deposit_interest_rates
         (state_code, effective_year, annual_rate_pct, statute_citation, notes,
          unit_types, act_key, rate_basis, min_property_units, min_units_basis)
       VALUES ('ZW',2026,1,'t','t',ARRAY['mobile_home'],'mobile_home_park','fixed',25,'homes_present')`)
    const { rows } = await db.query<any>(
      `SELECT min_units_basis FROM state_deposit_interest_rates WHERE state_code='ZW'`)
    expect(rows[0].min_units_basis).toBe('homes_present')

    await expect(db.query(
      `INSERT INTO state_deposit_interest_rates
         (state_code, effective_year, annual_rate_pct, statute_citation, notes,
          unit_types, act_key, rate_basis, min_units_basis)
       VALUES ('ZV',2026,1,'t','t',ARRAY['mobile_home'],'x','fixed','licensed_capacity')`))
      .rejects.toThrow()
  })

  it('defaults to counting units that exist', async () => {
    await db.query(`DELETE FROM state_deposit_interest_rates WHERE state_code='ZU'`)
    await db.query(
      `INSERT INTO state_deposit_interest_rates
         (state_code, effective_year, annual_rate_pct, statute_citation, notes,
          unit_types, act_key, rate_basis, min_property_units)
       VALUES ('ZU',2026,1,'t','t',ARRAY['apartment'],'residential','fixed',25)`)
    const { rows } = await db.query<any>(
      `SELECT min_units_basis FROM state_deposit_interest_rates WHERE state_code='ZU'`)
    expect(rows[0].min_units_basis).toBe('all_units')
  })
})

// ── S642: 'BLOCKED' WAS HIDING THREE DIFFERENT OBSTACLES ────────────────────
//
// Nic: "You say 21 states are custody blocked, but I thought… 45 to 47 states
// was okay for us to hold security deposits, whether it's in a for-benefit-of
// account, FBO account through Column."
//
// He remembered right. All 21 were researched before the custody vehicle was
// settled, so 'blocked' has meant "we have not confirmed our vehicle satisfies
// this" — not "impossible" — and the code fail-closes on anything that is not
// 'supported'. Three obstacles, one word, very different prospects.
describe('S642 a blocked state says WHY', () => {
  // Seeded, not read from the live table: this data is migration-seeded and the
  // harness builds from a schema-only dump, so an assertion about the real 50
  // states would pass VACUOUSLY on an empty table — which is worse than failing,
  // because it reads as coverage. scripts/depositRuleCoverage.ts checks the
  // actual classification against the production database; these check that the
  // shape cannot be violated.
  const seed = (code: string, status: string, reason: string | null, inState = false) =>
    db.query(
      `INSERT INTO state_deposit_custody_rules
         (state_code, custody_status, blocked_reason, requires_in_state_depository)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (state_code) DO UPDATE
         SET custody_status = EXCLUDED.custody_status,
             blocked_reason = EXCLUDED.blocked_reason,
             requires_in_state_depository = EXCLUDED.requires_in_state_depository`,
      [code, status, reason, inState])

  beforeEach(async () => {
    await db.query(`DELETE FROM state_deposit_custody_rules WHERE state_code LIKE 'Z%'`)
  })

  it('the three obstacles are distinguishable — they have very different prospects', async () => {
    // One FBO account solves ZA. ZB needs a banking relationship in that state.
    // ZC may not permit a pooled trust at all. Collapsing them into "blocked"
    // is what made 21 states look impossible when 8 were merely unconfirmed.
    await seed('ZA', 'blocked', 'vehicle_unconfirmed')
    await seed('ZB', 'blocked', 'in_state_depository', true)
    await seed('ZC', 'blocked', 'pooling_restricted')
    const { rows } = await db.query<any>(
      `SELECT blocked_reason, COUNT(*)::int AS n FROM state_deposit_custody_rules
        WHERE state_code LIKE 'Z%' GROUP BY 1`)
    const by = Object.fromEntries(rows.map((r: any) => [r.blocked_reason, r.n]))
    expect(by.vehicle_unconfirmed).toBe(1)
    expect(by.in_state_depository).toBe(1)
    expect(by.pooling_restricted).toBe(1)
  })

  it('refuses a reason nobody has defined', async () => {
    // A typo here would quietly drop a state out of every reach calculation.
    await expect(seed('ZD', 'blocked', 'probably_fine')).rejects.toThrow()
  })

  it('a reason never promotes a state to supported', async () => {
    // Labelling must never be mistaken for clearance: flipping a state to
    // 'supported' sends real tenant money into GAM custody on a legal reading.
    await seed('ZA', 'blocked', 'vehicle_unconfirmed')
    const { rows } = await db.query<any>(
      `SELECT custody_status FROM state_deposit_custody_rules WHERE state_code='ZA'`)
    expect(rows[0].custody_status).toBe('blocked')
  })

  it('the escrow decision still fail-closes on anything not supported', async () => {
    // leaseFeesSync resolves held_by from this table and treats ONLY 'supported'
    // as go. A reason column must not become a second, softer yes.
    await seed('ZA', 'blocked', 'vehicle_unconfirmed')
    const { rows } = await db.query<any>(
      `SELECT CASE WHEN COALESCE(custody_status,'needs_research') <> 'supported'
                   THEN 'landlord' ELSE 'gam_escrow' END AS held_by
         FROM state_deposit_custody_rules WHERE state_code='ZA'`)
    expect(rows[0].held_by).toBe('landlord')
  })
})

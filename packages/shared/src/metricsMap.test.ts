import { describe, it, expect } from 'vitest'
import {
  CENSUS_BASIS_SLOT, METRICS_BOUNDARY_LAYERS, METRICS_CENSUS_BASES, METRICS_CENSUS_BASIS_LABEL,
  METRICS_CENSUS_BASIS_MEANING, METRICS_CENSUS_BASIS_NOUN, METRICS_CENSUS_LEVELS,
  METRICS_CENSUS_OVER_MEANING, METRICS_CONCENTRATION_LEVELS, METRICS_CONCENTRATION_MEANING,
  METRICS_ELECTION_LEVELS, METRICS_ELECTION_OFFICES, METRICS_ELECTION_OFFICE_LABEL,
  METRICS_LEAN_FULL, METRICS_LEAN_MEANING, METRICS_MAP_COUNTRY_LEVELS, METRICS_MAP_LEVELS,
  METRICS_MAP_LEVEL_CREDIT, METRICS_MAP_LEVEL_LABEL, METRICS_MAP_LEVEL_NOUN,
  METRICS_MAP_LEVEL_PLURAL, METRICS_MAP_MEASURES, METRICS_MAP_MEASURE_LABEL,
  METRICS_MAP_STATE_LEVELS, METRICS_MAP_WORLD_LEVELS, METRICS_MAP_WORLD_NOTE,
  METRICS_SATURATION_FULL, METRICS_WINDOW_CENSUS, METRICS_WINDOW_GAM, METRICS_WINDOW_SHARE,
  METRICS_WINDOW_VOTES, censusCountsNothing, censusNoRowHere, censusNotAtLevel, formatShare,
  hasCensus, hasConcentration, hasElections, isMetricsBoundaryLayer, isMetricsWorldLevel,
  leanNoResult, leanNotAtLevel, leanStateGap, marginMoveText, marginText, offersLean, sharePercent
} from './metricsMap'

/**
 * 10/17 (Nic) — the Metrics map's levels and its two overlays.
 *
 * The map now covers the rest of the world ("break the rest of the countries
 * down by states or province and then possibly cities as well or counties, if
 * they have counties within those provinces") and colors by a percentage as
 * well as a count: saturation against census data ("we are responsible for 30%
 * of the population or 60% of the total rental units") and concentration over
 * the voting districts ("what areas GAM is heavily concentrated in").
 *
 * The two percentages are of DIFFERENT WHOLES and must never be read as the
 * same number, so every one of them carries its own words.
 */
describe('the map levels', () => {
  it('every level is named three ways and says where its shapes came from', () => {
    for (const level of METRICS_MAP_LEVELS) {
      expect(METRICS_MAP_LEVEL_LABEL[level], level).toBeTruthy()
      expect(METRICS_MAP_LEVEL_NOUN[level], level).toBeTruthy()
      expect(METRICS_MAP_LEVEL_PLURAL[level], level).toBeTruthy()
      // gam-no-raw-enums-in-ui: nothing on screen is ever the level's own key.
      expect(METRICS_MAP_LEVEL_LABEL[level], level).not.toBe(level)
      expect(METRICS_MAP_LEVEL_CREDIT[level], level).toMatch(/^Shapes: .+\.$/)
    }
    // 10/17 (Nic): "Credit geoBoundaries on the map (CC BY 4.0)."
    expect(METRICS_MAP_LEVEL_CREDIT.adm2).toContain('geoBoundaries')
    expect(METRICS_MAP_LEVEL_CREDIT.adm2).toContain('CC BY 4.0')
  })

  it('the world levels are the three outside the United States, and the voting districts stay inside it', () => {
    expect(METRICS_MAP_WORLD_LEVELS).toEqual(['country', 'adm1', 'adm2'])
    for (const level of METRICS_MAP_WORLD_LEVELS) expect(isMetricsWorldLevel(level), level).toBe(true)
    for (const level of ['state', 'county', 'place', 'cd', 'sldu', 'sldl', 'zcta'] as const) {
      expect(isMetricsWorldLevel(level), level).toBe(false)
    }
    // Nic: voting districts are United States only.
    expect(METRICS_CONCENTRATION_LEVELS).toEqual(['cd', 'sldu', 'sldl'])
    for (const level of METRICS_MAP_WORLD_LEVELS) expect(hasConcentration(level), level).toBe(false)
    // A level drawn one state at a time and one drawn one country at a time are never the same level.
    for (const level of METRICS_MAP_COUNTRY_LEVELS) expect(METRICS_MAP_STATE_LEVELS).not.toContain(level)
    // Every level whose shapes the API serves is a real level of the map.
    for (const layer of METRICS_BOUNDARY_LAYERS) {
      expect(METRICS_MAP_LEVELS, layer).toContain(layer)
      expect(isMetricsBoundaryLayer(layer), layer).toBe(true)
    }
    expect(isMetricsBoundaryLayer('state')).toBe(false)
    expect(isMetricsBoundaryLayer('world')).toBe(false)
  })

  it('census numbers reach the United States levels and no further', () => {
    expect(METRICS_CENSUS_LEVELS).toEqual(['state', 'county', 'place', 'cd', 'sldu', 'sldl', 'zcta'])
    for (const level of METRICS_MAP_WORLD_LEVELS) expect(hasCensus(level), level).toBe(false)
    for (const level of METRICS_CENSUS_LEVELS) expect(hasCensus(level), level).toBe(true)
  })
})

describe('the overlays', () => {
  it('offers Units, Money and the three overlays, each with its own name', () => {
    // 10/18 (Nic): `lean` is the third — "the overlay to show which way those
    // certain districts vote".
    expect(METRICS_MAP_MEASURES).toEqual(['units', 'money', 'saturation', 'concentration', 'lean'])
    for (const m of METRICS_MAP_MEASURES) {
      expect(METRICS_MAP_MEASURE_LABEL[m], m).toBeTruthy()
      expect(METRICS_MAP_MEASURE_LABEL[m], m).not.toBe(m)
    }
  })

  it('has three denominators, each its own view, each saying in plain words what it means', () => {
    // Nic: "show all. because we are doing short term rentals as well as living
    // situations. its not only regular rentals. toggle each view/metric".
    expect(METRICS_CENSUS_BASES).toEqual(['renter', 'homes', 'people'])
    // Each reads a different one of the three numbers in a census row.
    expect(new Set(METRICS_CENSUS_BASES.map(b => CENSUS_BASIS_SLOT[b])).size).toBe(3)
    for (const b of METRICS_CENSUS_BASES) {
      expect(METRICS_CENSUS_BASIS_LABEL[b], b).toBeTruthy()
      expect(METRICS_CENSUS_BASIS_NOUN[b], b).toBeTruthy()
      // Nic: "say plainly on screen what each percentage means."
      expect(METRICS_CENSUS_BASIS_MEANING[b], b).toMatch(/\.$/)
      expect(METRICS_CENSUS_BASIS_MEANING[b].length, b).toBeGreaterThan(40)
      expect(METRICS_CENSUS_BASIS_MEANING[b], b).toMatch(/GAM/)
    }
    // A share of the population is not a share of households, and the sentence says so.
    expect(METRICS_CENSUS_BASIS_MEANING.people).toMatch(/more than one person/)
    // The concentration sentence says outright that it is a share of GAM.
    expect(METRICS_CONCENTRATION_MEANING).toMatch(/share of GAM, not a share of the district/)
  })

  it('no sentence claims a share cannot pass 100%, and one says what it means when it does', () => {
    // 10/17 (review): these read "out of every 100 … this many ARE spaces on
    // GAM", under a number that in GAM's own market reads 210% — a park in a
    // Census place with 47 renter-occupied homes. The sentence has to be true
    // at 210%, and something on screen has to say why.
    for (const b of METRICS_CENSUS_BASES) {
      expect(METRICS_CENSUS_BASIS_MEANING[b], b).not.toMatch(/out of every/i)
      expect(METRICS_CENSUS_BASIS_MEANING[b], b).not.toMatch(/this many are/i)
    }
    expect(METRICS_CENSUS_OVER_MEANING).toMatch(/more spaces/)
    expect(METRICS_CENSUS_OVER_MEANING).toMatch(/100%/)
    // The color tops out there; the number itself never does.
    expect(METRICS_SATURATION_FULL).toBe(100)

    // Amado, Arizona (Census place 0401990): 41 people, 41 housing units, no
    // renter-occupied home at all. ZIP 85645 around it counts 47.
    expect(sharePercent(99, 47)).toBeCloseTo(210.638, 3)
    expect(formatShare(sharePercent(99, 47))).toBe('211%')
    expect(formatShare(sharePercent(99, 41))).toBe('241%')
    expect(formatShare(100.4)).toBe('100%')
    expect(formatShare(999.6)).toBe('1000%')
  })

  it('an area the Census counts nothing in is named, not read as 0%', () => {
    // 10/17 (review): Amado's own Census place counts no renter-occupied home,
    // so the division has nothing to divide by. 0% says "GAM is not there",
    // which is the opposite of the truth — the area is named with the reason.
    expect(sharePercent(99, 0)).toBe(0)
    expect(censusCountsNothing(METRICS_CENSUS_BASIS_NOUN.renter))
      .toBe('The Census counts no renter-occupied homes here, so there is no share to draw.')
    for (const b of METRICS_CENSUS_BASES) {
      expect(censusCountsNothing(METRICS_CENSUS_BASIS_NOUN[b]), b).toMatch(/^The Census counts no .+\.$/)
    }
  })

  it('the world levels say on screen that a waterfront address is placed by the nearest province', () => {
    // 10/17 (review): downtown Miami, Venice, Copenhagen and Nuuk are all
    // outside the land in the raw Natural Earth file. They are placed in the
    // nearest province within a few miles, and that rule is not a quiet one.
    expect(METRICS_MAP_WORLD_NOTE).toMatch(/nearest state or province/)
    expect(METRICS_MAP_WORLD_NOTE).toMatch(/named below/)
  })

  it('a share is exact, and on screen it is one decimal — never a real share rounded away', () => {
    // 10/17 (review): rounding inside the division turned four spaces in a
    // city of 300,000 renter homes into "0%" — which reads as "GAM is not
    // there". The division is exact; the rounding happens on screen.
    expect(sharePercent(1240, 38771)).toBeCloseTo(3.1983, 4)
    expect(sharePercent(38771, 38771)).toBe(100)
    expect(sharePercent(1, 3)).toBeCloseTo(33.3333, 4)
    expect(sharePercent(4, 300000)).toBeGreaterThan(0)
    // Nothing to divide by — a territory the survey has no row for, or an
    // empty area — is 0, never Infinity and never NaN.
    expect(sharePercent(5, 0)).toBe(0)
    expect(sharePercent(0, 100)).toBe(0)
    expect(sharePercent(5, -1)).toBe(0)
    expect(sharePercent(-5, 100)).toBe(0)
    expect(sharePercent(NaN, 100)).toBe(0)

    expect(formatShare(sharePercent(1240, 38771))).toBe('3.2%')
    expect(formatShare(sharePercent(1, 3))).toBe('33.3%')
    expect(formatShare(60)).toBe('60%')
    expect(formatShare(60.02)).toBe('60%')
    expect(formatShare(100)).toBe('100%')
    expect(formatShare(0)).toBe('0%')
    // A real share too small for a tenth says so instead of reading as none.
    expect(formatShare(sharePercent(4, 300000))).toBe('<0.1%')
    expect(formatShare(0.04)).toBe('<0.1%')
    expect(formatShare(0.06)).toBe('0.1%')
    expect(formatShare(0.1)).toBe('0.1%')
  })

  it("Nic's own example: Santa Cruz County, three ways", () => {
    // 266,021 people, 106,635 housing units, 38,771 of them rented.
    const census: [number, number, number] = [266021, 106635, 38771]
    const spaces = 1240
    const by = (b: typeof METRICS_CENSUS_BASES[number]) => formatShare(sharePercent(spaces, census[CENSUS_BASIS_SLOT[b]]))
    expect(by('renter')).toBe('3.2%')
    expect(by('homes')).toBe('1.2%')
    expect(by('people')).toBe('0.5%')
    // The three are different numbers of different things, which is the point
    // of making each its own view.
    expect(new Set([by('renter'), by('homes'), by('people')]).size).toBe(3)
    // The numerator both ways: every space, and the spaces occupied this month.
    expect(formatShare(sharePercent(910, census[CENSUS_BASIS_SLOT.renter]))).toBe('2.3%')
  })
})

// ─── 10/18 (Nic): how an area votes ─────────────────────────────────────────

describe('the election layer', () => {
  it('is a contest at a level, not a presidency — any office drops into the same shape', () => {
    // Nic: "I don't only want presidential stuff, I want mayor data, governor
    // data, city council data, voting on public policy, whether it's
    // left-leaning or conservative. I want the data at every level that we can
    // get it."
    expect(METRICS_ELECTION_OFFICES).toContain('president')
    for (const o of ['governor', 'senate', 'state_senate', 'state_house', 'mayor', 'city_council', 'measure'] as const) {
      expect(METRICS_ELECTION_OFFICES, o).toContain(o)
      // No raw enums on screen (gam-no-raw-enums-in-ui).
      expect(METRICS_ELECTION_OFFICE_LABEL[o], o).toBeTruthy()
      expect(METRICS_ELECTION_OFFICE_LABEL[o], o).not.toBe(o)
    }
  })

  it('ONLY COUNTIES ARE EXACT, and every other level says so instead of deriving one', () => {
    // Nic: "there is no equally free keyless source for congressional or
    // legislative districts, so on those levels say plainly that the lean is
    // not available for districts yet rather than deriving a number from
    // county votes — a made-up district margin is worse than none."
    expect(METRICS_ELECTION_LEVELS).toEqual(['county'])
    expect(hasElections('county')).toBe(true)
    for (const level of ['cd', 'sldu', 'sldl', 'state', 'place', 'zcta'] as const) {
      expect(hasElections(level), level).toBe(false)
      // Still offered there — that is where the plain sentence is read.
      expect(offersLean(level), level).toBe(true)
      expect(leanNotAtLevel(METRICS_MAP_LEVEL_NOUN[level], METRICS_MAP_LEVEL_PLURAL[level]), level)
        .toMatch(/^No election results are published by .+ They are published county by county/)
    }
    // The returns are the United States'; the world's levels never offer it.
    for (const level of METRICS_MAP_WORLD_LEVELS) expect(offersLean(level), level).toBe(false)
  })

  it('says a margin, a missing one and a swing in plain words, in the contest\'s own terms', () => {
    expect(marginText(-18.6, 'Republican', 'Democratic')).toBe('Democratic +18.6')
    expect(marginText(33.9, 'Republican', 'Democratic')).toBe('Republican +33.9')
    expect(marginText(0.01, 'Republican', 'Democratic')).toBe('Even')
    // A ballot measure is the same shape with its own two sides named.
    expect(marginText(-7.5, 'No', 'Yes')).toBe('Yes +7.5')
    expect(leanNoResult('county')).toBe('No result is published for this county in that contest.')
    expect(leanStateGap('Alaska', 'this state reported it by "State House District 1" and the like, not by county'))
      .toBe('No result for this area: Alaska — this state reported it by "State House District 1" and the like, not by county.')
    expect(marginMoveText(-47.1, -18.6, 'Republican', 'Democratic', '2016'))
      .toBe('28.5 points toward the Republican side since 2016.')
    // The color's own sentence says what it is, and never claims a GAM number.
    expect(METRICS_LEAN_MEANING).toMatch(/share of every vote cast/)
    expect(METRICS_LEAN_MEANING).toMatch(/marker shows where GAM has spaces/)
    expect(METRICS_LEAN_FULL).toBe(60)
  })

  it('the window has one set of headings, and a plain sentence where a count is missing', () => {
    // Nic: "In plain words throughout, never a raw code ... Where a level has
    // no census match, say so plainly rather than showing a blank or a zero."
    for (const h of [METRICS_WINDOW_CENSUS, METRICS_WINDOW_GAM, METRICS_WINDOW_SHARE, METRICS_WINDOW_VOTES]) {
      expect(h).toBeTruthy()
      expect(h).not.toMatch(/_/)
    }
    expect(censusNotAtLevel('state or province'))
      .toBe('The U.S. Census counts the United States only, so there is no census number for a state or province here.')
    expect(censusNoRowHere('ZIP code')).toBe('The Census has no row for this ZIP code, so there is no share to work out.')
  })
})

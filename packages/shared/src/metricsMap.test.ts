import { describe, it, expect } from 'vitest'
import {
  CENSUS_BASIS_SLOT, METRICS_BOUNDARY_LAYERS, METRICS_CENSUS_BASES, METRICS_CENSUS_BASIS_LABEL,
  METRICS_CENSUS_BASIS_MEANING, METRICS_CENSUS_BASIS_NOUN, METRICS_CENSUS_LEVELS, METRICS_CENSUS_OVER_MEANING,
  METRICS_CONCENTRATION_LEVELS,
  METRICS_CONCENTRATION_MEANING, METRICS_MAP_COUNTRY_LEVELS, METRICS_MAP_LEVELS, METRICS_MAP_LEVEL_CREDIT,
  METRICS_MAP_LEVEL_LABEL, METRICS_MAP_LEVEL_NOUN, METRICS_MAP_LEVEL_PLURAL, METRICS_MAP_MEASURES,
  METRICS_MAP_MEASURE_LABEL, METRICS_MAP_STATE_LEVELS, METRICS_MAP_WORLD_LEVELS, METRICS_MAP_WORLD_NOTE,
  METRICS_SATURATION_FULL, censusCountsNothing, formatShare, hasCensus,
  hasConcentration, isMetricsBoundaryLayer, isMetricsWorldLevel, sharePercent,
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

describe('the two overlays', () => {
  it('offers Units, Money and the two overlays, each with its own name', () => {
    expect(METRICS_MAP_MEASURES).toEqual(['units', 'money', 'saturation', 'concentration'])
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

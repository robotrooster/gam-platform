/**
 * 10/13 (Nic): the admin Metrics heat map's levels. Nic: toggle levels for
 * "cities, congressional districts, state legislative districts (senate and
 * house), and ZIP codes", beside the state and county levels it had (10/12).
 *
 * One list for the API (which places each property at every level and serves
 * the boundary files) and the admin page (which draws them).
 */
export const METRICS_MAP_LEVELS = [
  'state', 'county', 'place', 'cd', 'sldu', 'sldl', 'zcta',
  // 10/17 (Nic): the rest of the world. "That's only pertinent to the United
  // States for now. Just break the rest of the countries down by states or
  // province and then possibly cities as well or counties, if they have
  // counties within those provinces."
  'country', 'adm1', 'adm2',
] as const
export type MetricsMapLevel = typeof METRICS_MAP_LEVELS[number]

/** The levels whose boundary files the API serves (state and county shapes ship in us-atlas). */
export const METRICS_BOUNDARY_LAYERS = ['place', 'cd', 'sldu', 'sldl', 'zcta', 'country', 'adm1', 'adm2'] as const
export type MetricsBoundaryLayer = typeof METRICS_BOUNDARY_LAYERS[number]

/** Levels drawn one state at a time — there are tens of thousands of them nationwide. */
export const METRICS_MAP_STATE_LEVELS: ReadonlyArray<MetricsBoundaryLayer> = ['place', 'sldu', 'sldl', 'zcta']

/**
 * 10/17 (Nic): the levels outside the United States. A property lands on these
 * by its map location alone — GAM holds a U.S. state on an address, never a
 * country, so there is nothing on an address to place one by.
 */
export const METRICS_MAP_WORLD_LEVELS: ReadonlyArray<MetricsBoundaryLayer> = ['country', 'adm1', 'adm2']
export const isMetricsWorldLevel = (l: MetricsMapLevel): boolean =>
  (METRICS_MAP_WORLD_LEVELS as readonly string[]).includes(l)

/**
 * 10/17 (Nic): levels drawn one country at a time — "if they have counties
 * within those provinces". 199 countries have a level below their provinces
 * and the rest have none, so a country with no file simply has no such level.
 */
export const METRICS_MAP_COUNTRY_LEVELS: ReadonlyArray<MetricsBoundaryLayer> = ['adm2']

/**
 * 10/17 (review): said under the map at a world level, because it would
 * otherwise be a quiet rule. The world's shapes are drawn for the whole earth,
 * and at that scale a waterfront address is often in the water: downtown
 * Miami, Venice, Copenhagen and Nuuk are all outside the land in the raw
 * Natural Earth file, before anything here simplifies it. So a location that
 * is inside nothing is placed in the nearest state or province within a few
 * miles, and anything farther out than that is named under the map as always.
 */
export const METRICS_MAP_WORLD_NOTE =
  'The world is drawn coarsely enough to see all of it at once, so a waterfront address can sit just off the land: one that is inside nothing is counted in the nearest state or province within a few miles, and anything farther out is named below.'

/**
 * 10/17 (Nic): where each level's shapes come from, under the map. The ADM2
 * line is geoBoundaries' CC BY 4.0 attribution — Nic: "Credit geoBoundaries on
 * the map (CC BY 4.0)" — and must stay as long as that level is drawn.
 */
export const METRICS_MAP_LEVEL_CREDIT: Readonly<Record<MetricsMapLevel, string>> = {
  state: 'Shapes: U.S. Census boundaries (public domain).',
  county: 'Shapes: U.S. Census boundaries (public domain).',
  place: 'Shapes: U.S. Census cartographic boundary files (public domain).',
  cd: 'Shapes: U.S. Census cartographic boundary files (public domain).',
  sldu: 'Shapes: U.S. Census cartographic boundary files (public domain).',
  sldl: 'Shapes: U.S. Census cartographic boundary files (public domain).',
  zcta: 'Shapes: U.S. Census cartographic boundary files (public domain).',
  country: 'Shapes: Natural Earth (public domain).',
  adm1: 'Shapes: Natural Earth (public domain).',
  adm2: 'Shapes: geoBoundaries (geoboundaries.org), CC BY 4.0.',
}

/**
 * 10/17: the land around the United States, for the globe — Nic asked to
 * "click and drag to rotate the earth" and it was turning over blank ocean.
 * Served like a boundary file (behind admin login, from the API's own folder),
 * but it is NOT a map level: no property is ever placed in it and it never
 * appears in the level menu.
 */
export const METRICS_WORLD_LAYER = 'world' as const

export function isMetricsBoundaryLayer(v: unknown): v is MetricsBoundaryLayer {
  return typeof v === 'string' && (METRICS_BOUNDARY_LAYERS as readonly string[]).includes(v)
}

/** What each level is called on the page. */
export const METRICS_MAP_LEVEL_LABEL: Readonly<Record<MetricsMapLevel, string>> = {
  state: 'State',
  county: 'County',
  place: 'City',
  cd: 'Congressional district',
  sldu: 'State senate district',
  sldl: 'State house district',
  zcta: 'ZIP code',
  country: 'Country',
  adm1: 'State or province',
  adm2: 'County or district',
}

/** One of them, in a sentence ("Hover or tap a city …"). */
export const METRICS_MAP_LEVEL_NOUN: Readonly<Record<MetricsMapLevel, string>> = {
  state: 'state',
  county: 'county',
  place: 'city',
  cd: 'congressional district',
  sldu: 'state senate district',
  sldl: 'state house district',
  zcta: 'ZIP code',
  country: 'country',
  adm1: 'state or province',
  adm2: 'county or district',
}

/** The plural, for "Top …" and "Show all …". */
export const METRICS_MAP_LEVEL_PLURAL: Readonly<Record<MetricsMapLevel, string>> = {
  state: 'states',
  county: 'counties',
  place: 'cities',
  cd: 'congressional districts',
  sldu: 'state senate districts',
  sldl: 'state house districts',
  zcta: 'ZIP codes',
  country: 'countries',
  adm1: 'states and provinces',
  adm2: 'counties and districts',
}

/** A ZIP code area's name (the Census files carry only the code). */
export const zipAreaName = (zip: string): string => `ZIP ${zip}`

// ── 10/17 (Nic): the two overlays ────────────────────────────────────────────

/**
 * 10/17 (Nic): what the color on the map stands for.
 *
 * `saturation` is the census overlay — "overlay against census data and say,
 * hey, look, we're in Santa Cruz County and we are responsible for 30% of the
 * population or 60% of the total rental units ... so we can target areas that
 * have room to grow. Whereas if we're already highly saturated ... we may not
 * want to have any more marketing dollars spent there."
 *
 * `concentration` is the voting-district overlay — "an overlay to show what
 * areas GAM is heavily concentrated in and how those voting districts kind of
 * line up, and see where we can focus."
 *
 * The two are different wholes and must never be read as the same number:
 * saturation is GAM's share of THAT AREA's market, concentration is that
 * area's share of EVERYTHING GAM manages.
 */
export const METRICS_MAP_MEASURES = ['units', 'money', 'saturation', 'concentration'] as const
export type MetricsMapMeasure = typeof METRICS_MAP_MEASURES[number]

export const METRICS_MAP_MEASURE_LABEL: Readonly<Record<MetricsMapMeasure, string>> = {
  units: 'Units',
  money: 'Money',
  saturation: 'Saturation',
  concentration: 'Concentration',
}

/**
 * The levels the census numbers reach. They are U.S. Census counts, so the
 * world's own levels have none — the page says so rather than drawing a
 * percentage of nothing.
 */
export const METRICS_CENSUS_LEVELS: ReadonlyArray<MetricsMapLevel> =
  ['state', 'county', 'place', 'cd', 'sldu', 'sldl', 'zcta']
export const hasCensus = (l: MetricsMapLevel): boolean => (METRICS_CENSUS_LEVELS as readonly string[]).includes(l)

/** The voting districts the concentration overlay is drawn over (Nic: U.S. only). */
export const METRICS_CONCENTRATION_LEVELS: ReadonlyArray<MetricsMapLevel> = ['cd', 'sldu', 'sldl']
export const hasConcentration = (l: MetricsMapLevel): boolean =>
  (METRICS_CONCENTRATION_LEVELS as readonly string[]).includes(l)

/**
 * 10/17 (Nic): the three things a saturation percentage can be out of — "show
 * all. because we are doing short term rentals as well as living situations.
 * its not only regular rentals. toggle each view/metric". Each is its own
 * view, and each says on screen what it means.
 */
export const METRICS_CENSUS_BASES = ['renter', 'homes', 'people'] as const
export type MetricsCensusBasis = typeof METRICS_CENSUS_BASES[number]

/** Which of a census area's three numbers each view divides by (the order the files are written in). */
export const CENSUS_BASIS_SLOT: Readonly<Record<MetricsCensusBasis, 0 | 1 | 2>> = {
  people: 0,
  homes: 1,
  renter: 2,
}

export const METRICS_CENSUS_BASIS_LABEL: Readonly<Record<MetricsCensusBasis, string>> = {
  renter: 'Renter homes',
  homes: 'All homes',
  people: 'People',
}

/** What the area's own number is, in words — "60% of the 38,771 renter-occupied homes here". */
export const METRICS_CENSUS_BASIS_NOUN: Readonly<Record<MetricsCensusBasis, string>> = {
  renter: 'renter-occupied homes',
  homes: 'housing units',
  people: 'people',
}

/**
 * 10/17 (Nic): "say plainly on screen what each percentage means" — the one
 * sentence under the map for the view on screen.
 *
 * 10/17 (review): each one used to read "out of every 100 … this many ARE
 * spaces on GAM", which says a share can never pass 100. It can, and in GAM's
 * own market it does: Amado, Arizona is 41 people and 41 housing units with
 * NO renter-occupied home in the survey, and one park there is a hundred
 * spaces. So each sentence now says what the number really is — spaces GAM
 * has for every 100 the Census counts — which stays true at 210%.
 */
export const METRICS_CENSUS_BASIS_MEANING: Readonly<Record<MetricsCensusBasis, string>> = {
  renter: 'For every 100 renter-occupied homes the Census counts in an area, this is how many spaces GAM has there.',
  homes: 'For every 100 housing units the Census counts in an area — rented, owned or empty — this is how many spaces GAM has there.',
  people: 'Spaces on GAM for every 100 people the Census counts in an area. One space can hold more than one person, so this reads low everywhere.',
}

/**
 * 10/17 (review): the sentence that joins the one above when something on
 * screen is over 100%. An RV or mobile-home park in a tiny Census place is
 * routinely bigger than the survey's whole count there, and "fully saturated"
 * is the honest reading — not an error, and not a number to hide or clip.
 */
export const METRICS_CENSUS_OVER_MEANING =
  'Over 100% means GAM has more spaces in that area than the Census counts there at all — the survey does not count an RV or mobile-home site as a home unless somebody lives in it year round.'

/** Where the saturation color tops out: as many spaces as the Census counts, or more. */
export const METRICS_SATURATION_FULL = 100

/**
 * 10/17 (review): an area GAM is in that the Census counts nothing in. It used
 * to drop off the map, out of the list and out of every note under it — it
 * read as 0%, which says "GAM is not there". It is named instead, with the
 * reason, and the words say which of the three counts is missing.
 */
export const censusCountsNothing = (noun: string): string =>
  `The Census counts no ${noun} here, so there is no share to draw.`

/** The concentration overlay's own sentence — a share of GAM, not a share of the area. */
export const METRICS_CONCENTRATION_MEANING =
  'Out of every 100 spaces GAM has placed at this level, this many sit in that district. It is a share of GAM, not a share of the district.'

/**
 * A percentage, exactly — 0 when there is nothing to divide by, and never
 * NaN or Infinity (a territory the survey has no row for divides by nothing).
 *
 * 10/17 (review): this used to round to a tenth, and four spaces in a city of
 * 300,000 renter homes came out as "0%" — which reads as "GAM is not there",
 * the opposite of the truth, on the very map Nic uses to decide where to push.
 * The rounding belongs on screen (formatShare), where a share too small for a
 * tenth says so; the color scale and the ranking read the exact number.
 */
export function sharePercent(numerator: number, denominator: number): number {
  if (!(denominator > 0) || !(numerator > 0)) return 0
  return (numerator / denominator) * 100
}

/**
 * A share on screen: "60%", "3.2%", and "<0.1%" for a share too small for a
 * tenth. Past 100% the tenth is noise, so it reads whole ("211%") — the number
 * is never clipped to 100, because more spaces than the Census counts is the
 * truth about that area, not an error (METRICS_CENSUS_OVER_MEANING).
 */
export function formatShare(percent: number): string {
  if (!(percent > 0)) return '0%'
  // Anything that would round to 0.0% is still something, and says so.
  if (percent < 0.05) return '<0.1%'
  if (percent >= 100) return `${Math.round(percent)}%`
  const r = Math.round(percent * 10) / 10
  return `${r % 1 === 0 ? r.toFixed(0) : r.toFixed(1)}%`
}

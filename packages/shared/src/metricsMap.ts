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

/**
 * Levels whose boundary files come one per state — there are tens of thousands
 * of these areas nationwide. 10/18 (Nic): the page loads a file for every
 * state GAM has data in and draws them together ("I can't just see them all in
 * the city breakdown, like all every state"); it is not one state at a time.
 */
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
 * 10/17 (Nic): levels whose boundary files come one per country — "if they have
 * counties within those provinces". 199 countries have a level below their
 * provinces and the rest have none, so a country with no file simply has no
 * such level. 10/18 (Nic): the page merges the countries GAM has data in, by
 * the same rule as the states above.
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
/**
 * 10/18 (Nic): `lean` is the election overlay — "the overlay to show which way
 * those certain districts vote, and where our strong areas tend to be in
 * Democratic areas or Republican areas". The color is the area's own vote, not
 * a GAM number at all; GAM's footprint is marked over it.
 */
export const METRICS_MAP_MEASURES = ['units', 'money', 'saturation', 'concentration', 'lean'] as const
export type MetricsMapMeasure = typeof METRICS_MAP_MEASURES[number]

export const METRICS_MAP_MEASURE_LABEL: Readonly<Record<MetricsMapMeasure, string>> = {
  units: 'Units',
  money: 'Money',
  saturation: 'Saturation',
  concentration: 'Concentration',
  lean: 'How it votes',
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

// ── 10/18 (Nic): how an area votes, and the window beside the map ────────────

/**
 * 10/18 (Nic): "the overlay to show which way those certain districts vote,
 * and where our strong areas tend to be in Democratic areas or Republican
 * areas, for the landlord onboarding process and total unit count."
 *
 * And, the same day: "I don't only want presidential stuff, I want mayor data,
 * governor data, city council data, voting on public policy, whether it's
 * left-leaning or conservative. I want the data at every level that we can get
 * it... get what you can for now. Any missing data, we can always add it in
 * later. This is just building the foundation for things I'm going to be
 * looking at in the future."
 *
 * So this is a general election-results layer, not a presidential one. One
 * contest is an office and a year with its two sides NAMED — "Republican" and
 * "Democratic", or "No" and "Yes" on a ballot measure — so nothing on the page
 * ever assumes which words to use. A governor's race, a mayor, a city council
 * seat or a vote on a policy drops in as another contest in the same shape
 * (apps/admin/scripts/build-election-results.mjs).
 */
export const METRICS_ELECTION_OFFICES = [
  'president', 'governor', 'senate', 'state_senate', 'state_house',
  'mayor', 'city_council', 'measure',
] as const
export type MetricsElectionOffice = typeof METRICS_ELECTION_OFFICES[number]

/** What each kind of contest is called on the page. */
export const METRICS_ELECTION_OFFICE_LABEL: Readonly<Record<MetricsElectionOffice, string>> = {
  president: 'President',
  governor: 'Governor',
  senate: 'U.S. Senate',
  state_senate: 'State senate',
  state_house: 'State house',
  mayor: 'Mayor',
  city_council: 'City council',
  measure: 'Ballot measure',
}

/** One contest in a level's election file, as the builder writes it. */
export interface MetricsElectionContest {
  /** "president-2024" — the key each area's result is under. */
  id: string
  office: MetricsElectionOffice
  year: number
  /** What it was, in words: "2024 presidential margin". */
  label: string
  /** What the two sides were called. A positive margin is `right`. */
  right: string
  left: string
  /** Where the votes came from, for the credit line under the map. */
  source: string
  /** How many areas have a result in this contest — a measure sits in one city, a presidency in every county. */
  areas?: number
  /**
   * The states this contest has no figures for at this level, by state FIPS,
   * each with the reason in words — a state that reported by ward or by
   * district, or one figure for the whole state. The page says it rather than
   * drawing a number nobody reported.
   */
  gaps?: Record<string, { name: string; why: string }>
}

/** One area's result in one contest: the margin, and the votes behind it. */
export interface MetricsElectionResult {
  /** The margin in percentage points — positive is the contest's `right`. */
  m: number
  /** Votes on the right, votes on the left, and every vote cast. */
  r?: number
  l?: number
  t?: number
}

/** One map level's election file (apps/api/elections, served per level). */
export interface MetricsElectionFile {
  level: string
  contests: MetricsElectionContest[]
  /** area code → contest id → that area's result. Sparse: a contest can cover one city. */
  areas: Record<string, Record<string, MetricsElectionResult>>
}

/**
 * The levels with an election file beside the API. ONLY COUNTIES ARE EXACT
 * today: presidential returns are published county by county, and there is no
 * free keyless source for a congressional or legislative district — so a
 * district says plainly that no result is published for it instead of carrying
 * a margin worked out from county votes, which would be a number nobody
 * reported. A new level is added here when its own file lands.
 */
export const METRICS_ELECTION_LEVELS: ReadonlyArray<MetricsMapLevel> = ['county']
export const hasElections = (l: MetricsMapLevel): boolean =>
  (METRICS_ELECTION_LEVELS as readonly string[]).includes(l)

/**
 * Where the overlay is OFFERED: every level of the United States, whose
 * returns these are. It is offered at the levels that have no file on purpose
 * — Nic asked for the districts, and the honest answer there is the overlay
 * saying so on screen rather than the choice quietly not being there.
 */
export const offersLean = (l: MetricsMapLevel): boolean => !isMetricsWorldLevel(l)

/**
 * Where the lean color tops out, in percentage points. Half of all counties
 * voted by more than 42 points in 2024 and a tenth by more than 70, so a
 * scale that ended at 40 would paint half the country one flat color; 60
 * keeps the gradation where the counties actually are, and the key says the
 * end means "60 points or more".
 */
export const METRICS_LEAN_FULL = 60

/** The overlay's own sentence: what the color is, and what the dots are. */
export const METRICS_LEAN_MEANING =
  'The color is how an area voted in the contest shown — the winning side\'s lead as a share of every vote cast. A marker shows where GAM has spaces, so a strong area can be read against the way it votes.'

/** A level with no election file: said on screen, instead of a number nobody reported. */
export const leanNotAtLevel = (noun: string, plural: string): string =>
  `No election results are published by ${noun}, so there is no lean to draw for ${plural}. They are published county by county — switch to the county level to see them.`

/** A state that reported a contest some other way, in words, for an area in it. */
export const leanStateGap = (stateName: string, why: string): string =>
  `No result for this area: ${stateName} — ${why}.`

/** An area with no row in the chosen contest. */
export const leanNoResult = (noun: string): string => `No result is published for this ${noun} in that contest.`

/** A margin in words: "Republican +18.6", "Democratic +4", "Even". */
export function marginText(margin: number, right: string, left: string): string {
  if (!Number.isFinite(margin) || Math.abs(margin) < 0.05) return 'Even'
  const points = Math.abs(Math.round(margin * 10) / 10)
  const text = points % 1 === 0 ? points.toFixed(0) : points.toFixed(1)
  return `${margin > 0 ? right : left} +${text}`
}

/**
 * How far an area has moved between two contests, in words — the swing Nic
 * reads 2016 against 2024 for. Positive is toward the contest's `right`.
 */
export function marginMoveText(from: number, to: number, right: string, left: string, fromLabel: string): string {
  const move = Math.round((to - from) * 10) / 10
  if (Math.abs(move) < 0.05) return `No move since ${fromLabel}.`
  const points = Math.abs(move)
  const text = points % 1 === 0 ? points.toFixed(0) : points.toFixed(1)
  return `${text} ${points === 1 ? 'point' : 'points'} toward the ${move > 0 ? right : left} side since ${fromLabel}.`
}

/**
 * 10/18 (Nic): THE WINDOW. "I just like the actual counties to be clickable
 * and have it pull up in a separate little window... if I click on Santa Cruz
 * County in Arizona, I'd like it to pull up a little window and say, hey, at
 * the last census this many people lived in this county, people renting on GAM
 * are a certain percentage of the total population."
 *
 * The headings it reads under, so the same words are used on every level.
 */
export const METRICS_WINDOW_CENSUS = 'At the last census'
export const METRICS_WINDOW_GAM = 'GAM here'
export const METRICS_WINDOW_SHARE = "GAM's share here"
export const METRICS_WINDOW_VOTES = 'How it votes'

/** No census numbers reach this level at all — the world's own levels. */
export const censusNotAtLevel = (noun: string): string =>
  `The U.S. Census counts the United States only, so there is no census number for a ${noun} here.`

/** The Census has no row for this one area, at a level it otherwise covers. */
export const censusNoRowHere = (noun: string): string =>
  `The Census has no row for this ${noun}, so there is no share to work out.`

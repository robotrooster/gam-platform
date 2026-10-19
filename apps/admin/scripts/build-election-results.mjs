#!/usr/bin/env node
/**
 * 10/18 (Nic): builds the election results behind the admin Metrics map's lean
 * overlay. Nic: "the overlay to show which way those certain districts vote,
 * and where our strong areas tend to be in Democratic areas or Republican
 * areas, for the landlord onboarding process and total unit count."
 *
 * AND NOT ONLY PRESIDENTIAL — Nic, the same day: "I don't only want
 * presidential stuff, I want mayor data, governor data, city council data,
 * voting on public policy, whether it's left-leaning or conservative. I want
 * the data at every level that we can get it... get what you can for now. Any
 * missing data, we can always add it in later. This is just building the
 * foundation for things I'm going to be looking at in the future."
 *
 * So the file is a general ELECTION RESULTS layer, not a presidential one.
 * Three things, and nothing about any one office:
 *
 *   an area (a county, a city, a district — whatever level the file is for)
 *   a contest (an office and a year, named by what it actually was)
 *   a margin (how far right or left that area voted in that contest)
 *
 * A governor's race, a senate race, a state legislature race, a mayor, a city
 * council seat or a vote on a ballot measure drops into that same shape with
 * nothing reshaped: add a contest to CONTESTS below with a reader for its file,
 * and the level's own file gains it. Each contest carries what its two sides
 * were CALLED ("Republican" / "Democratic", or "No" / "Yes" on a measure), so
 * the page never has to assume the words.
 *
 * WHAT IS ON DISK TODAY is the county presidential returns that sit beside the
 * Census and Natural Earth downloads in ~/gam-geo-raw/elections (public data,
 * no key). Nothing is fetched here. Two shapes, because the 2016 cut is older:
 *
 *   county_2024.csv  state_name,county_fips,county_name,votes_gop,votes_dem,
 *   county_2020.csv  total_votes,diff,per_gop,per_dem,per_point_diff
 *   county_2016.csv  ,votes_dem,votes_gop,total_votes,per_dem,per_gop,diff,
 *                    per_point_diff,state_abbr,county_name,combined_fips
 *
 * ONLY COUNTIES ARE EXACT, for now. These returns are published county by
 * county, so the county level is the only one built here; the map says plainly
 * at every other level that no result is published for it rather than working
 * a district's margin out of county votes, which would be a number nobody
 * reported. More levels arrive as their own files do.
 *
 * Usage (from anywhere — the raw folder is only ever read, never run from):
 *   node apps/admin/scripts/build-election-results.mjs [rawDir] [outDir]
 *   rawDir defaults to ~/gam-geo-raw/elections, outDir to apps/api/elections.
 *
 * What it writes — one file per map level, gzipped, served by the API behind
 * admin login (GET /api/admin/metrics/elections/:level, never on a public site
 * or a CDN, gam-nothing-public-rule) and read by the page when the lean
 * overlay is turned on. Internal metrics only.
 *
 *   county.json.gz   code → each contest's margin, and its votes
 *   index.json       the contests, their counts and their gaps (plain JSON)
 *
 * THE MARGIN is worked out one way for every contest, from the votes
 * themselves rather than from a file's own percentage columns (the 2016 cut
 * writes its margin as the string "15.17%"):
 *
 *   margin = (votes on the right − votes on the left) ÷ every vote cast × 100
 *
 * Positive is the right, negative the left, and the denominator is every vote
 * cast — third parties and write-ins included — so "R+12.4" means the
 * Republican lead was 12.4% of the whole vote, which is how a margin is
 * quoted. One number, one meaning, whatever the office.
 *
 * WHERE A STATE DOES NOT REPORT BY THE LEVEL'S OWN AREAS. Each area is keyed
 * by the SAME code the boundary files and the map use, so the join is code to
 * code with nothing matched by name — and that is exactly why a state that
 * reports some other way has to be left out rather than joined:
 *
 *   - Alaska reports by state house district. Its 2024 rows are numbered
 *     02001–02040 and its 2016 rows carry one statewide figure repeated under
 *     every borough's code, so joining either would hang a district's margin
 *     (or the whole state's) on a borough — 02013 is a real borough code AND a
 *     2024 house district number.
 *   - The District of Columbia's 2024 rows are its eight wards, and Ward 1's
 *     number is 11001, which is the District's own county code.
 *   - Connecticut's 2024 rows are the nine planning regions that replaced its
 *     counties in 2022. They are kept under their own codes (the Census's own
 *     county file is cut that way too), and because the map still draws the
 *     pre-2022 counties, a Connecticut county reads its 2020 and 2016 margins
 *     and says the 2024 one is not reported for it.
 *
 * Both tests are mechanical, so a later file is caught the same way. A state's
 * rows are left out of a contest when MOST of them are not areas at that level
 * (that is a state reporting by something else — wards, districts), or when
 * two of them report the exact same three vote counts (two counties never cast
 * identical votes; one statewide number copied across a state's rows always
 * does). Every state left out is written into the file with the reason, and
 * the page says it in words.
 *
 * A single row that is not an area is a different thing — a renamed or retired
 * county, like South Dakota's Shannon County in the 2016 cut, which became
 * Oglala Lakota County in 2015. That one row is dropped and recorded in
 * index.json; the rest of the state's counties keep their margins.
 */
import fs from 'node:fs'
import zlib from 'node:zlib'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const [rawArg, outArg] = process.argv.slice(2).filter(a => !a.startsWith('--'))
const RAW = path.resolve(rawArg ?? path.join(os.homedir(), 'gam-geo-raw/elections'))
const OUT = path.resolve(outArg ?? path.join(HERE, '../../api/elections'))
const CENSUS = path.resolve(path.join(HERE, '../../api/census'))

// 10/18 — WHERE THESE VOTES COME FROM, STATED HONESTLY.
//
// The build agent wrote "Official county presidential returns" and flagged that
// it could not verify the publisher. It is NOT official returns, and the credit
// line said so wrongly on a screen Nic reads.
//
// The three files in ~/gam-geo-raw/elections identify themselves by their own
// column names: votes_gop / votes_dem / per_point_diff, with `combined_fips` in
// the 2016 cut and `county_fips` in the later two. That is Tony McGovern's
// (tonmcg) county-level election results set, compiled by scraping news-outlet
// county reporting — which is also why `per_point_diff` is a percent STRING in
// 2016 and a decimal everywhere else, the exact drift the margin math works
// around.
//
// So: good enough to aim a growth map at a county, and NOT a canvass. Nothing
// GAM shows a customer, a bank or a regulator should cite it. The map is
// internal metrics only (Nic, 10/17: "the map is for internal metrics only.
// It's not really commercial use"), which is the only reason it belongs here.
//
// If Nic says he pulled these from somewhere else, correct this one string and
// re-run this script — it flows to the stored file and to the credit line.
const SOURCE = 'County presidential margins compiled by tonmcg from news-outlet returns — not official canvasses'

/**
 * THE CONTESTS, newest first — the order the page offers them in, so the
 * newest is what the color shows until he picks another.
 *
 * `office` is the kind of contest, for grouping later ('president', 'governor',
 * 'senate', 'state_house', 'mayor', 'city_council', 'measure'); `right` and
 * `left` are what that contest's two sides were called, which is all the page
 * needs to name them. A new contest at an existing level is one more entry
 * here; a new LEVEL is one more entry with its own `level`.
 */
const CONTESTS = [
  { id: 'president-2024', level: 'county', office: 'president', year: 2024, label: '2024 presidential margin', right: 'Republican', left: 'Democratic', source: SOURCE, file: 'county_2024.csv' },
  { id: 'president-2020', level: 'county', office: 'president', year: 2020, label: '2020 presidential margin', right: 'Republican', left: 'Democratic', source: SOURCE, file: 'county_2020.csv' },
  { id: 'president-2016', level: 'county', office: 'president', year: 2016, label: '2016 presidential margin', right: 'Republican', left: 'Democratic', source: SOURCE, file: 'county_2016.csv' },
]

const t0 = Date.now()
const log = (...m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...m)

// ── What counts as an area at a level ────────────────────────────────────────

/**
 * Every county code the map and the Census file know, which is what a row has
 * to be keyed by to be joined: the county shapes the map draws (us-atlas, the
 * same file the API places properties in) and the Census's own county list
 * (apps/api/census, cut for the saturation overlay). The union, because the
 * two differ on Connecticut — the shapes are its pre-2022 counties and the
 * Census file its planning regions.
 */
function countyCodes() {
  const ids = new Set()
  const atlas = require('us-atlas/counties-10m.json')
  for (const g of atlas.objects.counties.geometries) ids.add(String(g.id))
  const census = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(CENSUS, 'county.json.gz'))).toString('utf8'))
  for (const code of Object.keys(census.areas)) ids.add(code)
  return ids
}

/** level → the codes an area at that level can have. One level today; one entry per level. */
const AREA_CODES = { county: countyCodes }

/** What one of a level's areas is called in a sentence, for the reasons the page reads out. */
const AREA_NOUN = { county: 'county' }

// ── Reading a file ───────────────────────────────────────────────────────────

/** One CSV line into cells, with quoted cells ("37,410") kept whole. */
function cells(line) {
  const out = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quoted) {
      if (c === '"') { if (line[i + 1] === '"') { cell += '"'; i++ } else quoted = false } else cell += c
    } else if (c === '"') quoted = true
    else if (c === ',') { out.push(cell); cell = '' }
    else cell += c
  }
  out.push(cell)
  return out
}

/** A vote count: whole numbers, written "93003.0" in the 2016 cut. */
function voteCount(text, where) {
  const n = Number(text)
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) throw new Error(`${where}: "${text}" is not a vote count`)
  return n
}

/**
 * One contest's rows: { code, group, groupName, name, right, left, total }.
 * `group` is the state the row's area is in, which is the unit the two tests
 * below are applied to. The columns are read by NAME off the header, so the
 * 2016 cut's different order (and its unnamed first column) needs no special
 * case — only its state abbreviation and its unpadded FIPS do.
 */
function readContest(contest) {
  const file = path.join(RAW, contest.file)
  const lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/)
  const head = cells(lines[0]).map(h => h.trim())
  const at = name => {
    const i = head.indexOf(name)
    if (i < 0) throw new Error(`${file}: no ${name} column (header: ${head.join(',')})`)
    return i
  }
  const codeAt = head.includes('county_fips') ? at('county_fips') : at('combined_fips')
  const stateAt = head.includes('state_name') ? at('state_name') : at('state_abbr')
  const rightAt = at('votes_gop')
  const leftAt = at('votes_dem')
  const totalAt = at('total_votes')
  const nameAt = at('county_name')
  const rows = []
  for (const line of lines.slice(1)) {
    const c = cells(line)
    // The older cut writes a FIPS as a number, so Arizona's 04023 is "4023".
    const code = c[codeAt].trim().padStart(5, '0')
    if (!/^\d{5}$/.test(code)) throw new Error(`${file}: "${c[codeAt]}" is not an area code`)
    rows.push({
      code,
      group: code.slice(0, 2),
      groupName: c[stateAt].trim(),
      name: c[nameAt].trim(),
      right: voteCount(c[rightAt], `${file} ${code} votes_gop`),
      left: voteCount(c[leftAt], `${file} ${code} votes_dem`),
      total: voteCount(c[totalAt], `${file} ${code} total_votes`),
    })
  }
  log(`${contest.file}: ${rows.length.toLocaleString('en-US')} rows`)
  return rows
}

// ── Which of a state's rows are this level's own areas at all ────────────────

/** The margin in percentage points: the right positive, the left negative. */
const marginOf = r => (r.total > 0 ? Math.round(((r.right - r.left) / r.total) * 1000) / 10 : 0)

/**
 * More than this share of a state's rows not being areas at this level is a
 * state reporting by something else entirely — wards, legislative districts —
 * and the whole state is left out. One or two stale codes in a long list is a
 * renamed county, and only those rows are dropped.
 */
const MOSTLY_NOT_AREAS = 0.1

/**
 * A state's rows for one contest: which to keep, which single rows to drop,
 * and why the state is left out when it is. See the header — Alaska, the
 * District of Columbia's 2024 wards and a statewide figure copied across a
 * state's rows each fail one of the two tests.
 */
function judge(rows, codes, noun) {
  const notAreas = rows.filter(r => !codes.has(r.code))
  if (notAreas.length > rows.length * MOSTLY_NOT_AREAS) {
    const names = [...new Set(notAreas.map(r => `"${r.name}"`))].slice(0, 2).join(' and ')
    return { keep: false, why: `this state reported it by ${names} and the like, not by ${noun}` }
  }
  const keep = rows.filter(r => codes.has(r.code))
  const seen = new Map()
  for (const r of keep) {
    const key = `${r.right}/${r.left}/${r.total}`
    const first = seen.get(key)
    if (first) {
      return {
        keep: false,
        why: first.name === r.name
          ? `this state reported one figure for the whole state rather than by ${noun}`
          : `this state reported the same votes for ${first.name} and ${r.name}, which is one figure for more than one ${noun}`,
      }
    }
    seen.set(key, r)
  }
  return { keep, dropped: notAreas }
}

// ── Build, one level at a time ───────────────────────────────────────────────

const levels = [...new Set(CONTESTS.map(c => c.level))]
fs.mkdirSync(OUT, { recursive: true })
const index = {}
let bytes = 0

for (const level of levels) {
  const codes = AREA_CODES[level]()
  const noun = AREA_NOUN[level]
  log(`${level}: ${codes.size.toLocaleString('en-US')} area codes the map and the Census file know`)
  /** code → contest id → { m, r, l, t } */
  const areas = new Map()
  const contests = []
  for (const contest of CONTESTS.filter(c => c.level === level)) {
    const rows = readContest(contest)
    const byGroup = new Map()
    for (const r of rows) {
      const list = byGroup.get(r.group) ?? []
      list.push(r)
      byGroup.set(r.group, list)
    }
    const gaps = {}
    const dropped = []
    let kept = 0
    for (const [group, list] of [...byGroup].sort(([a], [b]) => a.localeCompare(b))) {
      const verdict = judge(list, codes, noun)
      if (!verdict.keep) {
        gaps[group] = { name: list[0].groupName, why: verdict.why }
        log(`  ${contest.id} ${list[0].groupName}: left out — ${verdict.why}`)
        continue
      }
      for (const r of verdict.dropped) {
        dropped.push(`${r.groupName} ${r.name} (${r.code}) is not a ${noun} on this map`)
        log(`  ${contest.id} ${r.groupName} ${r.name} (${r.code}): dropped, not an area on this map`)
      }
      for (const r of verdict.keep) {
        const row = areas.get(r.code) ?? {}
        row[contest.id] = { m: marginOf(r), r: r.right, l: r.left, t: r.total }
        areas.set(r.code, row)
        kept++
      }
    }
    const { file: _file, level: _level, ...rest } = contest
    contests.push({ ...rest, areas: kept, ...(Object.keys(gaps).length ? { gaps } : {}), ...(dropped.length ? { dropped } : {}) })
    const out = Object.keys(gaps).length
    log(`${contest.id}: ${kept.toLocaleString('en-US')} areas kept, ${out} ${out === 1 ? 'state' : 'states'} left out`)
  }
  const rows = [...areas.entries()].sort(([a], [b]) => a.localeCompare(b))
  // The served file carries what the page says on screen: each contest, its
  // two sides, where it came from, and the states it has no figures for. The
  // single stale rows are the build's own record (index.json), not the page's.
  const body = zlib.gzipSync(JSON.stringify({
    level,
    contests: contests.map(({ dropped: _dropped, ...c }) => c),
    areas: Object.fromEntries(rows),
  }), { level: 9 })
  fs.writeFileSync(path.join(OUT, `${level}.json.gz`), body)
  bytes += body.length
  const spread = (id => rows.map(([, r]) => r[id]?.m).filter(m => m != null).sort((a, b) => a - b))(contests[0].id)
  index[level] = {
    areas: rows.length,
    file: `${level}.json.gz`,
    contests: contests.map(c => ({
      id: c.id, office: c.office, year: c.year, label: c.label, areas: c.areas,
      states_left_out: Object.values(c.gaps ?? {}).map(g => `${g.name}: ${g.why}`),
      rows_dropped: c.dropped ?? [],
    })),
    newest: spread.length
      ? { contest: contests[0].id, lowest: spread[0], median: spread[Math.floor(spread.length / 2)], highest: spread[spread.length - 1] }
      : null,
  }
  log(`${level}: ${rows.length.toLocaleString('en-US')} areas, ${(body.length / 1e3).toFixed(0)} KB`)
}

fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify({
  about: 'Built by apps/admin/scripts/build-election-results.mjs from official election returns (public data). Do not edit by hand; re-run the script.',
  margin: 'Votes on the right minus votes on the left, over every vote cast, in percentage points. Positive is the right.',
  shape: 'An area, a contest (an office and a year, with its two sides named), and that area\'s margin in it. Any office at any level drops into the same shape.',
  levels: index,
}, null, 1))
log(`done: ${(bytes / 1e3).toFixed(0)} KB (gzipped) written to ${OUT}`)

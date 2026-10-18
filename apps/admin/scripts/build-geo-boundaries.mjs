#!/usr/bin/env node
/**
 * 10/13 (Nic): builds the boundary files the admin Metrics map draws at its new
 * levels — "cities, congressional districts, state legislative districts
 * (senate and house), and ZIP codes" — from the U.S. Census cartographic
 * boundary files Nic approved downloading (public data):
 *
 *   cb_2023_us_cd118_500k    congressional districts, 118th Congress
 *   cb_2023_us_sldu_500k     state legislative districts, upper chamber (state senate)
 *   cb_2023_us_sldl_500k     state legislative districts, lower chamber (state house / assembly)
 *   cb_2023_us_place_500k    places: incorporated cities and towns, and Census-designated places
 *   cb_2020_us_zcta520_500k  ZIP Code Tabulation Areas (Census's drawn area for each ZIP code)
 *
 * 10/17 it also cuts the land around the United States for the globe, from the
 * Natural Earth download beside them (public domain):
 *
 *   world/ne_10m_admin_1_states_provinces   every country's land, for the globe
 *
 * 10/17 (Nic) it cuts the rest of the world's own map levels from the two
 * world downloads. Nic: "that's only pertinent to the United States for now.
 * Just break the rest of the countries down by states or province and then
 * possibly cities as well or counties, if they have counties within those
 * provinces."
 *
 *   world/ne_10m_admin_1_states_provinces   countries, and their states and provinces
 *   world/geoBoundariesCGAZ_ADM2            the level below a province, in the 199
 *                                           countries that have one — counties,
 *                                           districts, municipalities, communes.
 *                                           geoBoundaries, CC BY 4.0: the map credits
 *                                           it on screen (METRICS_LEVEL_CREDIT).
 *
 * Usage (from anywhere — the raw folder is only ever read, never run from):
 *   node apps/admin/scripts/build-geo-boundaries.mjs [rawDir] [outDir] [--only=cd,place,sldu,sldl,zcta]
 *   rawDir defaults to ~/gam-geo-raw (the unzipped downloads), outDir to apps/api/geo.
 *   The world's own levels are heavy to cut (a 213 MB shapefile, read one
 *   country at a time so it never sits in memory whole):
 *   node --max-old-space-size=8192 … --only=country,adm1,adm2
 *
 * What it writes (served by the API behind admin login — GET
 * /api/admin/metrics/boundaries — and read by the API to place each property;
 * never put on a public site or a CDN). Gzipped on disk: the API hands the
 * file to the browser as it is (Content-Encoding: gzip) and unzips it once for
 * itself, so the files stay small in the repository and on the wire.
 *   cd.json.gz                    every congressional district (the national map)
 *   place/<state FIPS>.json.gz    one file per state, so the page loads only the state on screen
 *   sldu/<state FIPS>.json.gz     the same for state senate districts
 *   sldl/<state FIPS>.json.gz     the same for state house districts
 *   zcta/<state FIPS>.json.gz     the same for ZIP code areas
 *   zcta-states.json.gz           which state's file holds each ZIP code (a ZIP that crosses a
 *                                 state line is filed once, with the state its middle is in)
 *   world.json.gz                 every country's land but the United States' (the globe)
 *   country.json.gz               every country, the United States among them (the world map's top level)
 *   adm1.json.gz                  every country's states and provinces
 *   adm2/<ISO3>.json.gz           one file per country that has a level below its provinces,
 *                                 so the page loads only the country on screen
 *   index.json                    the editions and which states have which files (plain JSON)
 *
 * Each file is TopoJSON (one object, "areas"; each area's id is its Census
 * code) in longitude/latitude, so the flat map, the globe and the API's
 * "which district is this property in" all read the same shapes. The shapes
 * are simplified hard to keep the files small: a state file keeps the detail
 * that shows when that state fills the map, a small area (a city's ZIP code)
 * the detail that shows when the globe is zoomed in to it, and the
 * congressional file a bit more than the national map shows. A property within
 * a few hundred yards of a line can land in the neighbor — fine for a heat
 * map, not for anything legal.
 *
 * Tools: topojson-server and topojson-simplify build and simplify the
 * topology; d3-geo checks every shape still draws as itself (a ring simplified
 * inside out would paint the whole globe). The shapefile reader is the few
 * lines below, so nothing else is needed.
 *
 * 10/17: the two topojson build tools are NOT in the app's own package list —
 * they are only ever used to cut these files by hand, and nothing the portal
 * ships imports them, so they stay out of what every install pulls down. Run
 * this with them installed (`npm i -D --no-save topojson-server@3.0.1
 * topojson-simplify@3.0.3`) when the Census publishes a new edition. The files
 * it writes are already built and committed; this is not part of any build.
 */
import fs from 'node:fs'
import zlib from 'node:zlib'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { geoArea } from 'd3-geo'

const require = createRequire(import.meta.url)
/**
 * 10/17 (review): the two build-only tools are deliberately not in any package
 * list (see the note at the top), so say which command installs them rather
 * than failing with a bare module-not-found three years from now.
 */
const buildTool = name => {
  try { return require(name) } catch {
    console.error(`[build-geo-boundaries] ${name} is not installed. It is a build-only tool and is kept out of the app's package list on purpose. Install both and run again:\n  npm i -D --no-save topojson-server@3.0.1 topojson-simplify@3.0.3`)
    process.exit(1)
  }
}
const { topology } = buildTool('topojson-server')
const { presimplify } = buildTool('topojson-simplify')
const { quantize, feature, merge } = require('topojson-client')

const HERE = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const flags = Object.fromEntries(args.filter(a => a.startsWith('--')).map(a => a.slice(2).split('=')))
const [rawArg, outArg] = args.filter(a => !a.startsWith('--'))
const RAW = path.resolve(rawArg ?? path.join(os.homedir(), 'gam-geo-raw'))
const OUT = path.resolve(outArg ?? path.join(HERE, '../../api/geo'))
const ONLY = flags.only ? new Set(flags.only.split(',')) : null

/** Pixels a state file is drawn across, and how much smaller than one pixel a dropped wiggle is. */
const STATE_PX = 900
/** The congressional file: one degree of the map is drawn about this many pixels across. */
const CD_PX_PER_DEGREE = 400
/** A triangle of points smaller than this many square pixels is simplified away. */
const KEEP_PX2 = 0.6
/** A small area keeps this many pixels' worth of detail across its own width (see buildTopology). */
const AREA_PX = 20
/** Islands and holes smaller than this many square pixels are left out (never an area's biggest piece). */
const DROP_PX2 = 1.5
/** Grid points across each file after simplification (TopoJSON quantization). */
const QUANTIZE = 1e5

/** The globe's world land: one degree is drawn about this many pixels across. */
const WORLD_PX_PER_DEGREE = 2.5
/**
 * 10/17 (review): the world's own map LEVELS — the countries, and their states
 * and provinces — are cut forty times finer than the globe's backdrop, because
 * the API places properties in them and the backdrop is only a fill. At the
 * backdrop's detail a fjord is one straight line and a property in Nuuk came
 * out inside no country on earth.
 *
 * 10/17 (second review): 25 was still too coarse for GAM's own coast. At that
 * cut DROP_PX2 throws away every piece under about 29 square kilometers, which
 * is every island in the Florida Keys — Key West and Marathon were in no
 * country on earth. At 100 one pixel is a kilometer: the Keys, Nantucket,
 * Catalina and Galveston all come through, a line is simplified by under a
 * kilometer, and the two files together are 2 MB instead of 1 MB. A property
 * within half a mile of a border can still land on the wrong side — fine for a
 * heat map, not for anything legal or billed, as everywhere else here. The
 * handful of places that are outside the land in the RAW file (downtown Miami,
 * Venice, Copenhagen, Nuuk) are placed by WORLD_SNAP_KM in the API instead;
 * no amount of detail here reaches them.
 */
const WORLD_LEVEL_PX_PER_DEGREE = 100

const LAYERS = {
  // 10/17: the land around the United States, for the globe — Nic asked to
  // "click and drag to rotate the earth" and it was turning over blank ocean.
  // Natural Earth (public domain), downloaded beside the Census files. One
  // shape per country, so the lines BETWEEN countries are drawn and the
  // province lines inside them are not. The United States itself is left out:
  // the globe draws it from us-atlas, in finer detail.
  world: { dir: 'world/ne_10m_admin_1_states_provinces', base: 'ne_10m_admin_1_states_provinces',
           edition: 'Natural Earth 10m admin-1 states and provinces, 1:10,000,000 (public domain)' },
  // 10/17 (Nic): the rest of the world's own map levels — "break the rest of
  // the countries down by states or province and then possibly cities as well
  // or counties, if they have counties within those provinces". `country` and
  // `adm1` come from the same Natural Earth file as the globe's land (this one
  // keeps the United States, which the globe's backdrop leaves out); `adm2` is
  // geoBoundaries, which is CC BY 4.0 — credited on the map itself.
  country: { dir: 'world/ne_10m_admin_1_states_provinces', base: 'ne_10m_admin_1_states_provinces',
             edition: 'Natural Earth 10m admin-1 states and provinces, 1:10,000,000 (public domain)' },
  adm1:    { dir: 'world/ne_10m_admin_1_states_provinces', base: 'ne_10m_admin_1_states_provinces',
             edition: 'Natural Earth 10m admin-1 states and provinces, 1:10,000,000 (public domain)' },
  adm2:    { dir: 'world/geoBoundariesCGAZ_ADM2', base: 'geoBoundariesCGAZ_ADM2', encoding: 'latin1',
             edition: 'geoBoundaries CGAZ ADM2, release 5.0 (geoBoundaries, CC BY 4.0)' },
  cd:    { dir: 'cb_2023_us_cd118_500k', edition: 'Census 2023 cartographic boundaries, 118th Congress, 1:500,000' },
  sldu:  { dir: 'cb_2023_us_sldu_500k',  edition: 'Census 2023 cartographic boundaries, state legislative districts (upper chamber), 1:500,000' },
  sldl:  { dir: 'cb_2023_us_sldl_500k',  edition: 'Census 2023 cartographic boundaries, state legislative districts (lower chamber), 1:500,000' },
  place: { dir: 'cb_2023_us_place_500k', edition: 'Census 2023 cartographic boundaries, places, 1:500,000' },
  zcta:  { dir: 'cb_2020_us_zcta520_500k', edition: 'Census 2020 cartographic boundaries, ZIP Code Tabulation Areas, 1:500,000' },
}

/**
 * 10/17 (review): geoBoundaries keys a country by ISO 3166 and Natural Earth
 * by its own three letters, and for three countries the two disagree. Every
 * world level here is keyed by Natural Earth's code, because the provinces are
 * what the API places a property in and the country comes off the province —
 * so a district file written under the other code can never be asked for.
 * Kosovo, South Sudan and Western Sahara were exactly that: 30 KB of districts
 * on disk while a property in Pristina was told its country has none.
 */
const ADM2_COUNTRY = { XKX: 'KOS', SSD: 'SDS', ESH: 'SAH' }

/**
 * 10/17 (review): geoBoundaries lost the alphabet for 654 of its districts —
 * 103 distinct names, Russian and Japanese, are literally "????????? ?????"
 * in the download, and 51 areas share one of them. A row of question marks is
 * not a name: the area is numbered instead, which at least tells two of them
 * apart on the map and never puts punctuation on screen as a place.
 */
const districtName = (name, n) => (/[\p{L}\p{N}]/u.test(name) ? name : `Unnamed area ${n}`)

// ── Reading a shapefile ──────────────────────────────────────────────────────

/** Strict UTF-8: throws on bytes that are not valid UTF-8, which is the whole point below. */
const utf8 = new TextDecoder('utf-8', { fatal: true })

/**
 * One value out of a DBF, in the encoding that download writes.
 *
 * 10/17 (review): geoBoundaries' ADM2 file is MIXED. 5,280 of its 5,294
 * accented names are Latin-1 ("Malësi e Madhe"), and 14 are UTF-8 bytes — the
 * ten Māori names with macrons and four Peruvian ones with an ñ. Read as
 * Latin-1 those fourteen shipped as "WaitematÄ Local Board Area"; read as
 * UTF-8 the other 5,280 break. So a value with a high byte is read as UTF-8
 * when it IS valid UTF-8 and as Latin-1 when it is not: a real Latin-1 name
 * that happens to be valid multi-byte UTF-8 would have to contain "Ã±"
 * literally, which no place is called.
 */
function dbfText(buf, at, len, encoding) {
  const slice = buf.subarray(at, at + len)
  if (encoding === 'latin1') {
    for (const b of slice) {
      if (b > 127) {
        try { return utf8.decode(slice).replace(/\0/g, '').trim() } catch { break }
      }
    }
  }
  // Census files pad with spaces, Natural Earth with NULs; strip both.
  return buf.toString(encoding, at, at + len).replace(/\0/g, '').trim()
}

/**
 * `encoding` is how that download writes its text: Census and Natural Earth
 * write UTF-8; geoBoundaries writes Latin-1 (all but fourteen rows — see
 * dbfText), and read as UTF-8 every accented district name in it ("Malësi e
 * Madhe") comes out broken.
 */
function readDbf(file, encoding = 'utf8') {
  const buf = fs.readFileSync(file)
  const count = buf.readUInt32LE(4), headerLen = buf.readUInt16LE(8), recordLen = buf.readUInt16LE(10)
  const fields = []
  for (let at = 32; buf[at] !== 0x0d; at += 32) {
    const name = buf.toString('latin1', at, at + 11).replace(/\0[\s\S]*$/, '')
    fields.push({ name, len: buf[at + 16] })
  }
  const rows = []
  for (let r = 0; r < count; r++) {
    let at = headerLen + r * recordLen + 1 // the first byte is the deleted flag
    const row = {}
    for (const f of fields) { row[f.name] = dbfText(buf, at, f.len, encoding); at += f.len }
    rows.push(row)
  }
  return rows
}

/** One record's rings, [[lng, lat], …]; null for an empty one. Polygons only (types 5/15/25). */
function shapeRings(buf, rec, file) {
  const type = buf.readInt32LE(rec)
  if (type === 0) return null
  if (type !== 5 && type !== 15 && type !== 25) throw new Error(`${file}: shape type ${type} is not a polygon`)
  const parts = buf.readInt32LE(rec + 36), points = buf.readInt32LE(rec + 40)
  const partsAt = rec + 44, pointsAt = partsAt + 4 * parts
  const rings = []
  for (let p = 0; p < parts; p++) {
    const start = buf.readInt32LE(partsAt + 4 * p)
    const end = p + 1 < parts ? buf.readInt32LE(partsAt + 4 * (p + 1)) : points
    const ring = []
    for (let i = start; i < end; i++) ring.push([buf.readDoubleLE(pointsAt + 16 * i), buf.readDoubleLE(pointsAt + 16 * i + 8)])
    rings.push(ring)
  }
  return rings
}

/** Every record's rings, in file order. */
function readShp(file) {
  const buf = fs.readFileSync(file)
  const shapes = []
  for (let off = 100; off < buf.length;) {
    const len = buf.readInt32BE(off + 4) * 2
    shapes.push(shapeRings(buf, off + 8, file))
    off = off + 8 + len
  }
  return shapes
}

/**
 * 10/17: SOME records' rings, read straight off the disk by the index beside
 * the shapefile (.shx). The world's ADM2 download is a 213 MB shapefile — read
 * whole it would sit in memory as tens of millions of little arrays, so it is
 * read one country at a time and each country let go before the next.
 */
function openShp(base) {
  const shx = fs.readFileSync(`${base}.shx`)
  const fd = fs.openSync(`${base}.shp`, 'r')
  const at = i => [shx.readInt32BE(100 + 8 * i) * 2, shx.readInt32BE(104 + 8 * i) * 2]
  return {
    count: (shx.length - 100) / 8,
    /** Record i's rings; `null` for an empty record. */
    rings(i) {
      const [offset, len] = at(i)
      const buf = Buffer.alloc(len + 8)
      fs.readSync(fd, buf, 0, len + 8, offset)
      return shapeRings(buf, 8, `${base}.shp`)
    },
    close() { fs.closeSync(fd) },
  }
}

function layerBase(key) {
  const dir = path.join(RAW, LAYERS[key].dir)
  return path.join(dir, LAYERS[key].base ?? LAYERS[key].dir)
}

function readLayer(key) {
  const base = layerBase(key)
  const rows = readDbf(`${base}.dbf`, LAYERS[key].encoding)
  const shapes = readShp(`${base}.shp`)
  if (rows.length !== shapes.length) throw new Error(`${key}: ${rows.length} rows but ${shapes.length} shapes`)
  return rows.map((row, i) => ({ row, polygons: shapes[i] ? toPolygons(shapes[i]) : [] }))
}

/** A layer's rows only, with the shapes left on disk for openShp to read a few at a time. */
function readLayerRows(key) {
  return readDbf(`${layerBase(key)}.dbf`, LAYERS[key].encoding)
}

// ── Geometry helpers ─────────────────────────────────────────────────────────

/** Positive when counter-clockwise (x east, y north). */
function signedArea(ring) {
  let s = 0
  for (let i = 0, n = ring.length, j = n - 1; i < n; j = i++) s += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1]
  return s / 2
}

function ringContains(ring, [x, y]) {
  let inside = false
  for (let i = 0, n = ring.length, j = n - 1; i < n; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j]
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/**
 * A shapefile's rings → polygons. Outer rings run clockwise and holes
 * counter-clockwise (the shapefile standard, and the way d3-geo reads them);
 * each hole goes with the smallest outer ring around it.
 */
function toPolygons(rings) {
  const polys = []
  const holes = []
  for (const r of rings) (signedArea(r) <= 0 ? polys.push([r]) : holes.push(r))
  for (const h of holes) {
    let best = null, bestArea = Infinity
    for (const p of polys) {
      const a = -signedArea(p[0])
      if (a < bestArea && h.slice(0, 3).some(pt => ringContains(p[0], pt))) { best = p; bestArea = a }
    }
    // A counter-clockwise ring inside nothing is an outer ring drawn the other way round.
    if (best) best.push(h)
    else polys.push([h.slice().reverse()])
  }
  return polys
}

const polyArea = poly => -signedArea(poly[0]) - poly.slice(1).reduce((s, h) => s + signedArea(h), 0)

/** [west, south, east, north] of some polygons; a box across the date line is measured the short way. */
function boxOf(polygonLists) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity
  let w2 = Infinity, e2 = -Infinity
  for (const polys of polygonLists) for (const poly of polys) for (const [x, y] of poly[0]) {
    if (x < w) w = x; if (x > e) e = x; if (y < s) s = y; if (y > n) n = y
    const x2 = x > 0 ? x - 360 : x
    if (x2 < w2) w2 = x2; if (x2 > e2) e2 = x2
  }
  return e2 - w2 < e - w ? [w2, s, e2, n] : [w, s, e, n]
}

/**
 * A point inside a polygon, away from its edges: the middle of the widest
 * span a level line crosses (so never in a hole and never on an edge).
 */
function interiorPoint(poly) {
  let s = Infinity, n = -Infinity
  for (const [, y] of poly[0]) { if (y < s) s = y; if (y > n) n = y }
  for (const f of [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8]) {
    const y = s + (n - s) * f + 1e-9
    const xs = []
    for (const r of poly) for (let i = 0, k = r.length, j = k - 1; i < k; j = i++) {
      const [x1, y1] = r[j], [x2, y2] = r[i]
      if ((y1 > y) !== (y2 > y)) xs.push(x1 + ((y - y1) * (x2 - x1)) / (y2 - y1))
    }
    xs.sort((a, b) => a - b)
    let best = null, width = -1
    for (let k = 0; k + 1 < xs.length; k += 2) if (xs[k + 1] - xs[k] > width) { width = xs[k + 1] - xs[k]; best = [(xs[k] + xs[k + 1]) / 2, y] }
    if (best) return best
  }
  return poly[0][0]
}

// ── Building one file ────────────────────────────────────────────────────────

/**
 * Areas → simplified, quantized TopoJSON. `pxDeg` is how many degrees one
 * pixel covers when the file fills the map.
 */
function buildTopology(areas, pxDeg) {
  const keep = KEEP_PX2 * pxDeg * pxDeg
  const drop = DROP_PX2 * pxDeg * pxDeg
  const features = []
  for (const a of areas) {
    if (!a.polygons.length) continue
    const sized = a.polygons.map(p => ({ p, area: polyArea(p) })).sort((x, y) => y.area - x.area)
    const kept = sized.filter((x, i) => i === 0 || x.area >= drop)
      .map(({ p }) => [p[0], ...p.slice(1).filter(h => signedArea(h) >= drop)])
    features.push({
      type: 'Feature', id: a.id, properties: a.properties ?? null,
      geometry: kept.length === 1 ? { type: 'Polygon', coordinates: kept[0] } : { type: 'MultiPolygon', coordinates: kept },
    })
  }
  const topo = topology({ areas: { type: 'FeatureCollection', features } }, 1e6)
  const pre = presimplify(topo)
  const geoms = pre.objects.areas.geometries
  const ringsOf = g => (g.type === 'Polygon' ? g.arcs : g.type === 'MultiPolygon' ? g.arcs.flat() : [])
  const arcIndex = id => (id < 0 ? ~id : id)
  const arcOf = id => pre.arcs[arcIndex(id)]

  // A small area keeps the detail it needs to look like itself when the map
  // is zoomed in to it (AREA_PX across its own width), not only what shows
  // when the whole file fills the map — a city's ZIP codes are a few pixels
  // wide at the state view. A line two areas share keeps the finer of the two.
  const arcKeep = new Float64Array(pre.arcs.length).fill(keep)
  geoms.forEach((g, i) => {
    const [w, s, e, n] = boxOf([[features[i].geometry.type === 'Polygon'
      ? features[i].geometry.coordinates : features[i].geometry.coordinates[0]]])
    const own = KEEP_PX2 * (Math.max(e - w, n - s) / AREA_PX) ** 2
    for (const ring of ringsOf(g)) for (const id of ring) arcKeep[arcIndex(id)] = Math.min(arcKeep[arcIndex(id)], own)
  })

  // Every ring keeps at least three points of its own, so no small area
  // simplifies down to a line (or to nothing).
  for (const g of geoms) {
    for (const ring of ringsOf(g)) {
      let kept = 0
      const spare = []
      for (const id of ring) {
        const arc = arcOf(id), min = arcKeep[arcIndex(id)]
        for (let i = 0; i < arc.length - 1; i++) if (arc[i][2] >= min) kept++
        for (let i = 1; i < arc.length - 1; i++) if (arc[i][2] < min) spare.push(arc[i])
      }
      spare.sort((x, y) => y[2] - x[2])
      for (let k = 0; kept < 3 && k < spare.length; k++, kept++) spare[k][2] = Infinity
    }
  }

  // topojson-simplify's simplify() with one minimum weight per line.
  const simplified = () => ({
    type: 'Topology', bbox: pre.bbox, objects: pre.objects,
    arcs: pre.arcs.map((arc, a) => arc.filter(p => p[2] >= arcKeep[a]).map(p => [p[0], p[1]])),
  })

  // An area whose simplified shape would draw inside out (d3-geo reads a ring
  // that flipped as the whole globe minus the area) keeps every point instead.
  for (let pass = 0; ; pass++) {
    const out = quantize(simplified(), QUANTIZE)
    const bad = out.objects.areas.geometries
      .map((g, i) => (g.type && geoArea(feature(out, g)) > 2 * Math.PI ? i : -1))
      .filter(i => i >= 0)
    if (!bad.length) return { topo: out, kept: geoms.length }
    if (pass >= 2) throw new Error(`${bad.length} areas still draw inside out`)
    for (const i of bad) for (const ring of ringsOf(geoms[i])) for (const id of ring) for (const pt of arcOf(id)) pt[2] = Infinity
  }
}

/** Writes `rel` gzipped (as `rel`.gz) and returns the bytes on disk; index.json stays plain. */
function writeJson(rel, data, { plain = false } = {}) {
  const file = path.join(OUT, plain ? rel : `${rel}.gz`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const body = plain ? Buffer.from(JSON.stringify(data, null, 1)) : zlib.gzipSync(JSON.stringify(data), { level: 9 })
  fs.writeFileSync(file, body)
  return body.length
}

const statePxDeg = areas => { const [w, s, e, n] = boxOf(areas.map(a => a.polygons)); return Math.max(e - w, n - s) / STATE_PX }

// ── The layers ───────────────────────────────────────────────────────────────

const summary = {}
const t0 = Date.now()
function log(...m) { console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...m) }

function byState(areas) {
  const groups = new Map()
  for (const a of areas) { const g = groups.get(a.state) ?? []; g.push(a); groups.set(a.state, g) }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))
}

function writeByState(key, areas) {
  fs.rmSync(path.join(OUT, key), { recursive: true, force: true })
  const states = []
  let bytes = 0, count = 0
  for (const [state, group] of byState(areas)) {
    const { topo, kept } = buildTopology(group, statePxDeg(group))
    bytes += writeJson(`${key}/${state}.json`, topo)
    count += kept
    states.push(state)
  }
  summary[key] = { states, areas: count, bytes }
  log(`${key}: ${count} areas in ${states.length} state files, ${(bytes / 1e6).toFixed(2)} MB`)
}

/**
 * 10/17 (Nic): the same, one country at a time, for the world's own levels.
 * A country's areas are read only while its file is being written and let go
 * before the next, so the 213 MB ADM2 shapefile never sits in memory whole.
 * The index lists these under `countries` — they are ISO 3166 three-letter
 * codes, not state FIPS codes, and the API tells the two apart by shape.
 */
function writeByCountry(key, codes, areasFor) {
  fs.rmSync(path.join(OUT, key), { recursive: true, force: true })
  const countries = []
  let bytes = 0, count = 0
  for (const code of codes) {
    const group = areasFor(code)
    if (!group.length) continue
    const { topo, kept } = buildTopology(group, statePxDeg(group))
    bytes += writeJson(`${key}/${code}.json`, topo)
    count += kept
    countries.push(code)
  }
  summary[key] = { countries, areas: count, bytes }
  log(`${key}: ${count} areas in ${countries.length} country files, ${(bytes / 1e6).toFixed(2)} MB`)
}

/**
 * 10/17: the Natural Earth provinces, read once for both world levels (the
 * countries are these merged). A row with no country code of its own is left
 * out — it is a disputed area Natural Earth files under no country, and the
 * map would have nothing true to say about it.
 */
let neProvinces = null
function provinces() {
  if (!neProvinces) {
    neProvinces = readLayer('country')
      .filter(({ row, polygons }) => polygons.length && /^[A-Z]{3}$/.test(row.adm0_a3))
      .map(({ row, polygons }) => ({
        id: row.adm1_code || `${row.adm0_a3}-${row.provnum_ne}`,
        name: row.name || row.name_en || row.adm1_code,
        country: row.adm0_a3, countryName: row.admin, polygons,
      }))
  }
  return neProvinces
}

/**
 * 10/17 (review): a country's provinces DISSOLVED into the country — the lines
 * between them gone, the outside edge kept.
 *
 * The first cut of this simply piled every province of a country into one
 * shape, and the simplifier then threw away every piece smaller than a pixel
 * and a half. A province that small is not an island, it is a city: Mexico
 * City and Reykjavík came out as HOLES punched through their own countries,
 * and a point inside either was in no country at all. Dissolving them first
 * means a piece that gets dropped is a real island off the coast, never a hole
 * inland.
 *
 * Done on a shared topology, which is what makes the shared lines findable:
 * two provinces that touch are the same arc in it, and merging drops it.
 */
function dissolveCountries(areas) {
  const features = areas.map(a => ({
    type: 'Feature', id: a.country, properties: null,
    geometry: a.polygons.length === 1
      ? { type: 'Polygon', coordinates: a.polygons[0] }
      : { type: 'MultiPolygon', coordinates: a.polygons },
  }))
  const topo = topology({ areas: { type: 'FeatureCollection', features } }, 1e6)
  const groups = new Map()
  topo.objects.areas.geometries.forEach((g, i) => {
    const code = features[i].id
    groups.set(code, [...(groups.get(code) ?? []), g])
  })
  const nameOf = new Map(areas.map(a => [a.country, a.countryName]))
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([code, geoms]) => {
    const shape = merge(topo, geoms)
    return {
      id: code,
      properties: { name: nameOf.get(code) || code },
      polygons: shape.type === 'Polygon' ? [shape.coordinates] : shape.coordinates,
    }
  })
}

/** Census "ZZZ" districts are the water and land no district covers — not districts. */
const isDistrict = code => !/^Z+$/.test(code)

let cdAreas = null
function congressional() {
  if (!cdAreas) {
    cdAreas = readLayer('cd').map(({ row, polygons }) => ({
      id: row.GEOID, state: row.STATEFP, polygons, properties: { name: row.NAMELSAD },
    })).filter(a => isDistrict(a.id.slice(2)))
  }
  return cdAreas
}

const builders = {
  /**
   * 10/17: the globe's world land. The provinces of each country are gathered
   * into ONE shape for that country, so a shared province line is interior to
   * it and the page's border mesh draws only coastlines and the lines between
   * countries. The United States is left out — the globe draws it from
   * us-atlas, and a second, coarser copy under it would only double its coast.
   */
  world() {
    const areas = dissolveCountries(provinces().filter(p => p.country !== 'USA'))
    const { topo, kept } = buildTopology(areas, 1 / WORLD_PX_PER_DEGREE)
    const bytes = writeJson('world.json', topo)
    summary.world = { file: 'world.json.gz', areas: kept, bytes }
    log(`world: ${kept} countries, ${(bytes / 1e6).toFixed(2)} MB`)
  },
  /**
   * 10/17 (Nic): every country, for the top of the world map — "break the rest
   * of the countries down by states or province". The provinces of each
   * country are merged into one shape, so the page's border mesh draws
   * coastlines and the lines between countries. The United States IS in this
   * one (the globe's backdrop file leaves it out, because the globe draws it
   * from us-atlas in finer detail).
   */
  country() {
    const areas = dissolveCountries(provinces())
    const { topo, kept } = buildTopology(areas, 1 / WORLD_LEVEL_PX_PER_DEGREE)
    const bytes = writeJson('country.json', topo)
    summary.country = { file: 'country.json.gz', areas: kept, bytes }
    log(`country: ${kept} countries, ${(bytes / 1e6).toFixed(2)} MB`)
  },
  /**
   * 10/17 (Nic): "states or province" for every country — one national file,
   * like the congressional districts. Each area carries its country, so the
   * page can name "Entre Ríos, Argentina" without a second file.
   */
  adm1() {
    const areas = provinces()
      .map(p => ({ id: p.id, polygons: p.polygons, properties: { name: p.name, country: p.country, countryName: p.countryName } }))
      .sort((a, b) => a.id.localeCompare(b.id))
    const { topo, kept } = buildTopology(areas, 1 / WORLD_LEVEL_PX_PER_DEGREE)
    const bytes = writeJson('adm1.json', topo)
    summary.adm1 = { file: 'adm1.json.gz', areas: kept, bytes }
    log(`adm1: ${kept} states and provinces, ${(bytes / 1e6).toFixed(2)} MB`)
  },
  /**
   * 10/17 (Nic): the level below a province, "if they have counties within
   * those provinces" — counties, districts, municipalities, communes,
   * whatever that country calls it. geoBoundaries has one for 199 countries
   * and nothing for the rest, which is exactly the "show whichever levels a
   * country actually has" rule: a country with no file has no such level.
   *
   * An area's id is its country and its place in that country's file
   * (BRA.0001). geoBoundaries' own shapeID is a 23-character string, and
   * nothing but these files ever reads the id — the API places properties in
   * the very shapes it serves the page — so the short one keeps 49,349 ids out
   * of the files for nothing.
   *
   * 10/17 (review): THE FILES ARE NAMED BY NATURAL EARTH'S CODE, not
   * geoBoundaries' (ADM2_COUNTRY). A property reaches this level through the
   * province it is in, and the provinces are Natural Earth's — so a file under
   * any other code is a file nothing can ever ask for. Three of them were:
   * Kosovo's districts sat on disk as XKX.json.gz while a property in Pristina
   * was told its country has no districts at all.
   */
  adm2() {
    const rows = readLayerRows('adm2')
    const shp = openShp(layerBase('adm2'))
    if (rows.length !== shp.count) throw new Error(`adm2: ${rows.length} rows but ${shp.count} shapes`)
    const byCountry = new Map()
    // geoBoundaries files the disputed areas (Abyei, the West Bank, the
    // Falklands, Aksai Chin and the rest) under a number instead of a country
    // code. They belong to no country here: GAM's map takes no side on them,
    // and a property whose map location is in one is named under the map as
    // being inside no district of its country, like any other gap.
    const disputed = []
    rows.forEach((row, i) => {
      if (!/^[A-Z]{3}$/.test(row.shapeGroup)) { disputed.push(row.shapeName); return }
      const code = ADM2_COUNTRY[row.shapeGroup] ?? row.shapeGroup
      byCountry.set(code, [...(byCountry.get(code) ?? []), i])
    })
    if (disputed.length) log(`adm2: ${disputed.length} disputed areas belong to no country and were left out: ${disputed.join(', ')}`)
    // A country Natural Earth has no province for cannot be reached: no
    // property can ever be placed in it, so the file would be dead weight.
    // Nothing is in this list today — it is here so a new edition of either
    // download says so out loud instead of writing files nobody can open.
    const reachable = new Set(provinces().map(p => p.country))
    const orphans = [...byCountry.keys()].filter(c => !reachable.has(c)).sort()
    if (orphans.length) {
      log(`adm2: ${orphans.length} countries have districts but no province in Natural Earth, so no property can reach them; left out: ${orphans.join(' ')}`)
      for (const c of orphans) byCountry.delete(c)
    }
    try {
      writeByCountry('adm2', [...byCountry.keys()].sort(), code => {
        const out = []
        for (const i of byCountry.get(code)) {
          const rings = shp.rings(i)
          const polygons = rings ? toPolygons(rings) : []
          if (!polygons.length) continue
          const n = out.length + 1
          out.push({
            id: `${code}.${String(n).padStart(4, '0')}`,
            polygons,
            properties: { name: districtName(rows[i].shapeName, n) },
          })
        }
        return out
      })
    } finally { shp.close() }
  },
  cd() {
    const areas = congressional()
    const { topo, kept } = buildTopology(areas, 1 / CD_PX_PER_DEGREE)
    const bytes = writeJson('cd.json', topo)
    summary.cd = { file: 'cd.json.gz', areas: kept, bytes }
    log(`cd: ${kept} districts, ${(bytes / 1e6).toFixed(2)} MB`)
  },
  sldu() {
    const areas = readLayer('sldu').map(({ row, polygons }) => ({
      id: row.GEOID, state: row.STATEFP, polygons, properties: { name: row.NAMELSAD },
    })).filter(a => isDistrict(a.id.slice(2)))
    writeByState('sldu', areas)
  },
  sldl() {
    const areas = readLayer('sldl').map(({ row, polygons }) => ({
      id: row.GEOID, state: row.STATEFP, polygons, properties: { name: row.NAMELSAD },
    })).filter(a => isDistrict(a.id.slice(2)))
    writeByState('sldl', areas)
  },
  place() {
    const areas = readLayer('place').map(({ row, polygons }) => ({
      id: row.GEOID, state: row.STATEFP, polygons, name: row.NAME, label: row.NAMELSAD,
    }))
    // Two places of one name in one state (a city and a Census-designated
    // place, say) carry their full Census name so the page can tell them apart.
    const seen = new Map()
    for (const a of areas) { const k = `${a.state}|${a.name.toLowerCase()}`; seen.set(k, (seen.get(k) ?? 0) + 1) }
    let twins = 0
    for (const a of areas) {
      const twin = seen.get(`${a.state}|${a.name.toLowerCase()}`) > 1
      if (twin) twins++
      a.properties = twin ? { name: a.name, label: a.label } : { name: a.name }
    }
    log(`place: ${twins} places share a name with another place in their state`)
    writeByState('place', areas)
  },
  zcta() {
    // A ZIP area carries no state; it is filed with the state its middle is in,
    // found inside the congressional districts (which cover every state).
    const districts = congressional().flatMap(a => a.polygons.map(p => ({ state: a.state, poly: p, box: boxOf([[p]]) })))
    const stateAt = pt => {
      for (const d of districts) {
        if (pt[0] < d.box[0] || pt[0] > d.box[2] || pt[1] < d.box[1] || pt[1] > d.box[3]) continue
        if (d.poly.reduce((inside, ring) => (ringContains(ring, pt) ? !inside : inside), false)) return d.state
      }
      return null
    }
    const areas = []
    const unfiled = []
    for (const { row, polygons } of readLayer('zcta')) {
      if (!polygons.length) continue
      const biggest = polygons.reduce((a, b) => (polyArea(b) > polyArea(a) ? b : a))
      let state = stateAt(interiorPoint(biggest))
      if (!state) {
        // The middle is in water the district lines leave out: go by its corners.
        const votes = new Map()
        for (const pt of biggest[0].filter((_, i) => i % Math.max(1, Math.floor(biggest[0].length / 40)) === 0)) {
          const s = stateAt(pt); if (s) votes.set(s, (votes.get(s) ?? 0) + 1)
        }
        state = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
      }
      if (!state) { unfiled.push(row.ZCTA5CE20); continue }
      areas.push({ id: row.ZCTA5CE20, state, polygons, properties: null })
    }
    if (unfiled.length) log(`zcta: ${unfiled.length} ZIP areas are in no state and were left out: ${unfiled.join(' ')}`)
    writeByState('zcta', areas)
    const index = {}
    for (const [state, group] of byState(areas)) index[state] = group.map(a => a.id).sort().join(' ')
    summary.zcta.bytes += writeJson('zcta-states.json', index)
  },
}

fs.mkdirSync(OUT, { recursive: true })
const previous = (() => { try { return JSON.parse(fs.readFileSync(path.join(OUT, 'index.json'), 'utf8')) } catch { return null } })()
for (const key of Object.keys(LAYERS)) {
  if (ONLY && !ONLY.has(key)) { if (previous?.layers?.[key]) summary[key] = previous.layers[key]; continue }
  builders[key]()
}
const layers = {}
for (const key of Object.keys(LAYERS)) {
  if (!summary[key]) continue
  const { bytes: _bytes, ...rest } = summary[key]
  layers[key] = { ...rest, edition: LAYERS[key].edition }
}
writeJson('index.json', {
  about: 'Built by apps/admin/scripts/build-geo-boundaries.mjs from U.S. Census cartographic boundary files and Natural Earth (both public domain), and — for the level below a province outside the United States — geoBoundaries, used under CC BY 4.0 and credited on the map itself. Do not edit by hand; re-run the script.',
  layers,
}, { plain: true })
const total = Object.values(summary).reduce((s, l) => s + (l.bytes ?? 0), 0)
log(`done: ${(total / 1e6).toFixed(2)} MB (gzipped) written this run to ${OUT}`)

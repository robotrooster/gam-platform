/**
 * 10/13 (Nic) — the Metrics map's shapes and math: the flat map at every level
 * ("cities, congressional districts, state legislative districts (senate and
 * house), and ZIP codes", beside states and counties) and the 3D globe ("click
 * and drag to rotate the earth ... zooming in and out").
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join, resolve } from 'path'
import { gunzipSync } from 'zlib'
import { createRequire } from 'module'
import { geoCentroid, geoPath } from 'd3-geo'
import { feature } from 'topojson-client'
import type { Topology } from 'topojson-specification'
import {
  DOT_BELOW_PX, H, MAX_ZOOM, MIN_ZOOM, US_VIEW, W, WORLD_VIEW, areaAt, areaCountry, areaName, buildLayer,
  buildUsAtlas, buildWorld, dragRotate, flatCountry, flatNational, flatState, flatWorld, globeProjection, heat,
  inBounds, mixRgb, nationalProjection, strength, viewFor, worldProjection, zoomBy,
} from './metricsMapGeo'

const require = createRequire(import.meta.url)
const us = buildUsAtlas(require('us-atlas/counties-10m.json') as Topology)
/** The API's own boundary files (apps/api/geo), exactly as GET /admin/metrics/boundaries sends them. */
const GEO = resolve(__dirname, '../../../api/geo')
const boundary = (rel: string) => JSON.parse(gunzipSync(readFileSync(join(GEO, `${rel}.json.gz`))).toString('utf8')) as Topology

describe('the flat map', () => {
  it('draws the 50 states and DC; the territories are left off the Albers USA picture (the globe has them)', () => {
    const flat = flatNational(us, 'state')
    const drawn = flat.areas.filter(a => a.d).map(a => a.id)
    expect(drawn).toHaveLength(51)
    expect(flat.areas.filter(a => !a.d).map(a => a.id).sort()).toEqual(['60', '66', '69', '72', '78'])
    expect(flat.states).not.toBe('')
    expect(flat.nation).not.toBe('')
  })

  // The flat map used to draw us-atlas's own pre-projected file; it now
  // projects the longitude/latitude edition (the one the API places properties
  // in and the globe turns). It must draw the same picture.
  it('projects the longitude/latitude counties exactly where us-atlas\'s own Albers file puts them', () => {
    const albers = require('us-atlas/counties-albers-10m.json') as Topology
    const flatPath = geoPath(nationalProjection())
    const planePath = geoPath()
    const albersById = new Map((feature(albers, albers.objects.counties as any) as any).features.map((f: any) => [String(f.id), f]))
    for (const id of ['04025', '04023', '17029', '06037', '02020', '15003', '12086', '36061']) {
      const mine = us.counties.find(c => c.id === id)!
      const [x, y] = flatPath.centroid(mine.feature)
      const [ax, ay] = planePath.centroid(albersById.get(id) as any)
      expect(Math.hypot(x - ax, y - ay), id).toBeLessThan(1.5)
    }
  })

  it('draws a congressional district map of the whole country from the API\'s file', () => {
    const layer = buildLayer('cd', null, boundary('cd'))
    const flat = flatNational(us, 'cd', layer)
    expect(flat.areas).toHaveLength(441)
    expect(flat.areas.find(a => a.id === '0402')).toMatchObject({ name: 'Congressional District 2' })
    expect(flat.areas.find(a => a.id === '0402')!.d).not.toBe('')
    // Puerto Rico's seat is drawn on the globe only.
    expect(flat.areas.find(a => a.id === '7298')!.d).toBe('')
    expect(flat.borders).not.toBe('')
  })

  it('draws one state filling the frame at the city, district and ZIP code levels', () => {
    for (const level of ['zcta', 'place', 'sldu', 'sldl'] as const) {
      const layer = buildLayer(level, '04', boundary(`${level}/04`))
      const flat = flatState(us, '04', layer)!
      const drawn = flat.areas.filter(a => a.d)
      expect(drawn.length, level).toBeGreaterThan(20)
      expect(flat.nation, level).not.toBe('')   // Arizona's own outline
      expect(flat.context, level).not.toBe('')  // its county lines
    }
    const zips = flatState(us, '04', buildLayer('zcta', '04', boundary('zcta/04')))!
    expect(zips.areas.find(a => a.id === '85362')).toMatchObject({ name: 'ZIP 85362' })
  })

  it('fits Alaska across the date line, and Puerto Rico, into the frame', () => {
    for (const st of ['02', '72', '11']) {
      const layer = buildLayer('zcta', st, boundary(`zcta/${st}`))
      const flat = flatState(us, st, layer)!
      const box = (d: string) => {
        const nums = d.match(/-?\d+(\.\d+)?/g)!.map(Number)
        const xs = nums.filter((_, i) => i % 2 === 0), ys = nums.filter((_, i) => i % 2 === 1)
        return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
      }
      const [x0, y0, x1, y1] = box(flat.nation)
      expect(x0, st).toBeGreaterThanOrEqual(0); expect(y0, st).toBeGreaterThanOrEqual(0)
      expect(x1, st).toBeLessThanOrEqual(W); expect(y1, st).toBeLessThanOrEqual(H)
      expect(Math.max(x1 - x0, (y1 - y0) * (W / H)), st).toBeGreaterThan(W * 0.8)
    }
  })

  it('a place too small to see gets a marker; a big one does not', () => {
    const flat = flatState(us, '04', buildLayer('place', '04', boundary('place/04')))!
    const yarnell = flat.areas.find(a => a.id === '0484980')!   // a small town at the state view
    const phoenix = flat.areas.find(a => a.id === '0455000')!
    expect(yarnell.dot).toBeDefined()
    expect(phoenix.dot).toBeUndefined()
    expect(DOT_BELOW_PX).toBeGreaterThan(0)
  })

  it('names areas the way each level does', () => {
    expect(areaName('zcta', '85362', null)).toBe('ZIP 85362')
    expect(areaName('place', '5546775', { name: 'Lisbon', label: 'Lisbon village' })).toBe('Lisbon village')
    expect(areaName('cd', '0402', { name: 'Congressional District 2' })).toBe('Congressional District 2')
  })

  // 10/17 (Nic): "break the rest of the countries down by states or province
  // and then possibly cities as well or counties, if they have counties within
  // those provinces."
  it('draws the whole world at the country and province levels', () => {
    const countries = buildLayer('country', null, boundary('country'))
    const world = flatWorld(countries, countries)
    expect(world.areas.length).toBeGreaterThan(200)
    for (const id of ['USA', 'CAN', 'BRA', 'AUS', 'JPN', 'ZAF']) {
      expect(world.areas.find(a => a.id === id)?.d, id).not.toBe('')
    }
    // The United States is on the world map too — this file keeps it, unlike
    // the globe's backdrop, which leaves it out for us-atlas to draw.
    expect(world.areas.find(a => a.id === 'USA')!.name).toMatch(/United States/)
    // At the country level the lines between countries ARE the level's own.
    expect(world.borders).not.toBe('')
    expect(world.context).toBe('')
    // Every country fits inside the frame, and the frame is the same one the
    // United States is drawn in.
    for (const a of world.areas.filter(x => x.d)) {
      expect(a.d, a.id).not.toMatch(/-?\d{5,}/)
    }

    const provinces = buildLayer('adm1', null, boundary('adm1'))
    const flat = flatWorld(provinces, countries)
    expect(flat.areas.length).toBeGreaterThan(4000)
    // The provinces sit on the country lines, drawn faintly underneath.
    expect(flat.context).not.toBe('')
    expect(flat.areas.find(a => a.name === 'Entre Ríos')?.d).not.toBe('')
  })

  it('draws one country filling the frame at the county-or-district level', () => {
    const countries = buildLayer('country', null, boundary('country'))
    const districts = buildLayer('adm2', 'CAN', boundary('adm2/CAN'))
    const outline = countries.areas.find(a => a.id === 'CAN')!
    const flat = flatCountry(districts, outline)!
    expect(flat.areas.length).toBeGreaterThan(50)
    expect(flat.areas.find(a => a.name === 'Toronto')!.d).not.toBe('')
    expect(flat.nation).not.toBe('')      // the country's own edge, around its districts
    expect(flatCountry(districts, null)).toBeNull()
  })

  it('a province carries its country, so one file names "Entre Ríos, Argentina"', () => {
    const provinces = buildLayer('adm1', null, boundary('adm1'))
    expect(provinces.country.get('ARG-1309')).toEqual({ code: 'ARG', name: 'Argentina' })
    expect(areaCountry('country', 'CAN', { name: 'Canada' })).toEqual({ code: 'CAN', name: 'Canada' })
    expect(areaCountry('adm1', 'CAN-682', { name: 'Ontario', country: 'CAN', countryName: 'Canada' }))
      .toEqual({ code: 'CAN', name: 'Canada' })
    // A United States level goes by state, not by country.
    expect(areaCountry('zcta', '85362', null)).toBeNull()
    expect(areaCountry('place', '0484980', { name: 'Yarnell' })).toBeNull()
    // The districts of one country are drawn from that country's own file, so
    // they carry nothing of their own.
    const districts = buildLayer('adm2', 'CAN', boundary('adm2/CAN'))
    expect(districts.country.size).toBe(0)
    expect(districts.state).toBe('CAN')
  })

  it('the world is drawn in a world projection, not the United States frame', () => {
    const p = worldProjection()
    // Greenwich at the equator lands in the middle; the whole earth fits.
    const [x, y] = p([0, 0])!
    expect(Math.abs(x - W / 2)).toBeLessThan(2)
    expect(Math.abs(y - H / 2)).toBeLessThan(2)
    for (const pt of [[-180, 0], [180, 0], [0, 90], [0, -90], [151, -33], [-157, 21]] as Array<[number, number]>) {
      const at = p(pt)
      expect(at, String(pt)).not.toBeNull()
      expect(at![0] >= 0 && at![0] <= W, String(pt)).toBe(true)
      expect(at![1] >= 0 && at![1] <= H, String(pt)).toBe(true)
    }
    // Albers USA has nothing to say about Argentina; this projection does.
    expect(nationalProjection()([-60, -32])).toBeNull()
    expect(p([-60, -32])).not.toBeNull()
  })
})

describe('the globe', () => {
  const arizona = us.stateById.get('04')!

  it('opens on the whole earth at a world level, and nothing is zoomed in on', () => {
    // 10/17 (Nic): the world's levels face the earth, not the lower 48.
    expect(WORLD_VIEW.zoom).toBeLessThan(US_VIEW.zoom)
    const p = globeProjection(WORLD_VIEW, W, H)
    for (const pt of [[0, 0], [13, 52], [151, -33]] as Array<[number, number]>) {
      expect(p(pt), String(pt)).not.toBeNull()
    }
  })

  it('opens on the United States, with the earth\'s curve in view', () => {
    const p = globeProjection(US_VIEW, W, H)
    const [x, y] = p(geoCentroid(us.stateById.get('20')!.feature))!   // Kansas, the middle
    expect(Math.abs(x - W / 2)).toBeLessThan(W * 0.1)
    expect(Math.abs(y - H / 2)).toBeLessThan(H * 0.15)
    expect(p.scale()).toBeLessThan(W / 2)                              // the globe's edge shows left and right
  })

  it('a drag turns the earth with the pointer, slower the further in', () => {
    const right = dragRotate(US_VIEW, 100, 0, W, H)
    expect(right.rotate[0]).toBeGreaterThan(US_VIEW.rotate[0])        // the earth moves right: the middle goes west
    const down = dragRotate(US_VIEW, 0, 100, W, H)
    expect(down.rotate[1]).toBeLessThan(US_VIEW.rotate[1])            // the earth moves down: the middle goes north
    const near = { ...US_VIEW, zoom: US_VIEW.zoom * 10 }
    expect(Math.abs(dragRotate(near, 100, 0, W, H).rotate[0] - near.rotate[0]))
      .toBeLessThan(Math.abs(right.rotate[0] - US_VIEW.rotate[0]))
    // Never over the pole.
    expect(dragRotate(US_VIEW, 0, -1e6, W, H).rotate[1]).toBe(89)
    // Longitude wraps instead of growing without end.
    expect(Math.abs(dragRotate(US_VIEW, 1e5, 0, W, H).rotate[0])).toBeLessThanOrEqual(180)
  })

  it('zooms in and out within limits', () => {
    expect(zoomBy(US_VIEW, 2).zoom).toBeCloseTo(US_VIEW.zoom * 2)
    expect(zoomBy(US_VIEW, 1e9).zoom).toBe(MAX_ZOOM)
    expect(zoomBy(US_VIEW, 1e-9).zoom).toBe(MIN_ZOOM)
  })

  it('faces a state and zooms in to it', () => {
    const v = viewFor(arizona.feature)
    const [lng, lat] = geoCentroid(arizona.feature)
    expect(v.rotate[0]).toBeCloseTo(-lng, 5)
    expect(v.rotate[1]).toBeCloseTo(-lat, 5)
    expect(v.zoom).toBeGreaterThan(US_VIEW.zoom * 3)
    // Arizona fills most of the frame but stays inside it.
    const b = geoPath(globeProjection(v, W, H)).bounds(arizona.feature)
    expect(b[1][1] - b[0][1]).toBeGreaterThan(H * 0.5)
    expect(b[0][1]).toBeGreaterThanOrEqual(0)
    expect(b[1][1]).toBeLessThanOrEqual(H)
  })

  it('picks the area under the pointer, and never one on the far side of the earth', () => {
    const v = viewFor(arizona.feature)
    const p = globeProjection(v, W, H)
    expect(areaAt(us.states, p, W / 2, H / 2)?.id).toBe('04')
    const [nmX, nmY] = p([-106, 34.5])!                                  // a point in New Mexico
    expect(areaAt(us.states, p, nmX, nmY)?.id).toBe('35')
    const far = globeProjection({ rotate: [-90, 0], zoom: 1 }, W, H)   // facing the Indian Ocean side
    expect(areaAt(us.states, far, W / 2, H / 2)).toBeNull()
    expect(areaAt(us.states, far, 0, 0)).toBeNull()                   // outside the globe entirely
  })

  it('reads a box across the date line (Alaska) the short way round', () => {
    const ak = us.stateById.get('02')!
    expect(ak.bounds[0][0]).toBeGreaterThan(ak.bounds[1][0])          // west edge east of the east edge
    expect(inBounds(ak.bounds, -150, 64)).toBe(true)
    expect(inBounds(ak.bounds, 178, 52)).toBe(true)                   // the far Aleutians
    expect(inBounds(ak.bounds, 0, 64)).toBe(false)
    expect(inBounds(arizona.bounds, -111.7, 34.3)).toBe(true)
    expect(inBounds(arizona.bounds, -100, 34.3)).toBe(false)
  })

  it('draws the whole country as one shape, for the gray land under the colors', () => {
    // 10/17: the globe's land has to be a shape the map library can draw, not
    // a collection wearing its name.
    expect(us.land.type).toBe('Feature')
    expect(us.land.geometry).toBeTruthy()
    const path = geoPath(globeProjection(US_VIEW, W, H))
    expect((path(us.land) ?? '').length).toBeGreaterThan(1000)
    expect(us.nation.coordinates.length).toBeGreaterThan(0)
  })

  it('turns over the land around the United States, not blank ocean', () => {
    // 10/17 (review): Nic asked to "click and drag to rotate the earth" and
    // the earth had no land on it but ours. The file beside the API holds every
    // country but the United States, one shape each — so the lines are
    // coastlines and the lines between countries, never province lines.
    const world = buildWorld(boundary('world'))
    expect(world.land.geometry).toBeTruthy()
    const path = geoPath(globeProjection(US_VIEW, W, H))
    expect((path(world.land) ?? '').length).toBeGreaterThan(1000)
    expect(world.borders.coordinates.length).toBeGreaterThan(0)

    // Facing the United States, Mexico and Canada are painted and the United
    // States itself is not in this file (the globe draws it from us-atlas).
    const ids = (feature(boundary('world'), boundary('world').objects.areas as any) as any).features.map((f: any) => String(f.id))
    expect(ids).toContain('MEX')
    expect(ids).toContain('CAN')
    expect(ids).not.toContain('USA')

    // Mexico City and Ottawa land on the painted land, and inside the frame.
    for (const [lng, lat] of [[-99.13, 19.43], [-75.70, 45.42]]) {
      const [x, y] = path.centroid({ type: 'Point', coordinates: [lng, lat] } as any)
      expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true)
      expect(x).toBeGreaterThanOrEqual(0)
      expect(x).toBeLessThanOrEqual(W)
    }
  })
})

describe('the color', () => {
  it('the globe mixes the same gold the flat map asks CSS for', () => {
    expect(heat(0)).toBe('var(--heat-none)')
    expect(heat(0.5)).toBe('color-mix(in srgb, var(--heat-hi) 50%, var(--heat-base))')
    expect(mixRgb([255, 255, 255], [0, 0, 0], 0.25)).toBe('rgb(64, 64, 64)')
    expect(mixRgb([201, 162, 39], [18, 21, 25], 1)).toBe('rgb(201, 162, 39)')
    expect(strength(0, 10)).toBe(0)
    expect(strength(10, 10)).toBe(1)
    expect(strength(1, 100)).toBeCloseTo(0.18 + 0.082, 5)
    // 10/17 (review): the saturation overlay tops its scale out at 100%, so a
    // value past the top is full gold rather than running over it.
    expect(strength(211, 100)).toBe(1)
    expect(strength(106, 100)).toBe(1)
  })
})

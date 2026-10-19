/**
 * 10/13 (Nic) — the Metrics map's shapes and math: the flat map at every level
 * ("cities, congressional districts, state legislative districts (senate and
 * house), and ZIP codes", beside states and counties) and the 3D globe ("click
 * and drag to rotate the earth ... zooming in and out").
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'fs'
import { join, resolve } from 'path'
import { gunzipSync } from 'zlib'
import { createRequire } from 'module'
import { geoCentroid, geoPath } from 'd3-geo'
import { feature } from 'topojson-client'
import type { Topology } from 'topojson-specification'
import {
  DOT_BELOW_PX, H, HOME_VIEW, LEAN_EVEN_RGB, LEAN_KEY_STEPS, LEAN_LEFT_RGB, LEAN_RIGHT_RGB,
  MAX_DEPTH, MAX_ZOOM, MIN_DEPTH, MIN_ZOOM, US_VIEW, W, WORLD_VIEW, areaAt,
  areaCountry, areaName, buildLayer, buildUsAtlas, buildWorld, dotNeeded, dragRotate, flatCenterPoint, flatLook,
  flatNational, flatPan, flatWorld, flatZoom, forgetElections, forgetLayers, globeProjection, globeViewOf, heat,
  homeView, inBounds, layerKey, leanColor, leanStrength, loadElections, loadLayerGroups, mergeLayers, mixRgb,
  nationalProjection, strength, viewFor, viewOfArea,
  viewOfGlobe, worldProjection, zoomBy,
} from './metricsMapGeo'
import { METRICS_LEAN_FULL, marginMoveText, marginText } from '@gam/shared'

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

  // 10/18 (Nic): "when I change it to the city view, I have to then select
  // between Arizona and Illinois. I can't just see them all in the city
  // breakdown, like all every state." Every state GAM is in, in one picture,
  // in the same frame every other United States level is drawn in.
  it('draws every state GAM is in at once at the city, district and ZIP code levels', () => {
    for (const level of ['zcta', 'place', 'sldu', 'sldl'] as const) {
      const merged = mergeLayers(level, ['04', '17'], ['04', '17'].map(g => buildLayer(level, g, boundary(`${level}/${g}`))))
      const flat = flatNational(us, level, merged)
      const drawn = flat.areas.filter(a => a.d)
      expect(drawn.length, level).toBeGreaterThan(50)
      // Both states' own areas are on it, drawn where the national map puts them.
      const az = drawn.filter(a => a.id.startsWith('04'))
      const il = drawn.filter(a => a.id.startsWith('17'))
      if (level !== 'zcta') {           // ZIP codes do not carry a state in their code
        expect(az.length, level).toBeGreaterThan(10)
        expect(il.length, level).toBeGreaterThan(10)
      }
      expect(flat.states, level).not.toBe('')   // the state lines of the whole country
      expect(flat.nation, level).not.toBe('')
      // The faint lines underneath are the county lines of the states drawn —
      // and of those states only, not all 3,100 counties.
      expect(flat.context, level).not.toBe('')
      const national = flatNational(us, 'county')
      expect(flat.context.length, level).toBeLessThan(national.borders.length)
    }
    const zips = flatNational(us, 'zcta', mergeLayers('zcta', ['04'], [buildLayer('zcta', '04', boundary('zcta/04'))]))
    expect(zips.areas.find(a => a.id === '85362')).toMatchObject({ name: 'ZIP 85362' })
    expect(zips.areas.find(a => a.id === '85362')!.d).not.toBe('')
  })

  it('draws Alaska\'s and Hawaii\'s own ZIP codes in the frame; Puerto Rico\'s go to the globe', () => {
    // Albers USA insets Alaska and Hawaii and leaves the territories out, so a
    // ZIP code follows its state exactly as the state level does — rather than
    // each state having had its own frame to fill.
    const merged = mergeLayers('zcta', ['02', '15', '72'], ['02', '15', '72'].map(g => buildLayer('zcta', g, boundary(`zcta/${g}`))))
    const flat = flatNational(us, 'zcta', merged)
    const inFrame = (d: string) => {
      const nums = d.match(/-?\d+(\.\d+)?/g)!.map(Number)
      const xs = nums.filter((_, i) => i % 2 === 0), ys = nums.filter((_, i) => i % 2 === 1)
      return Math.min(...xs) >= -1 && Math.min(...ys) >= -1 && Math.max(...xs) <= W + 1 && Math.max(...ys) <= H + 1
    }
    const anchorage = flat.areas.find(a => a.id === '99501')!   // Anchorage
    const honolulu = flat.areas.find(a => a.id === '96813')!    // Honolulu
    expect(inFrame(anchorage.d)).toBe(true)
    expect(inFrame(honolulu.d)).toBe(true)
    // Puerto Rico is not in the Albers USA picture at all (the globe has it),
    // and the page names anything with a number there under the map.
    expect(flat.areas.find(a => a.id === '00901')!.d).toBe('')
  })

  it('a place too small to see gets a marker, until it has been zoomed in on', () => {
    const flat = flatNational(us, 'place', mergeLayers('place', ['04'], [buildLayer('place', '04', boundary('place/04'))]))
    const yarnell = flat.areas.find(a => a.id === '0484980')!   // a small town
    const phoenix = flat.areas.find(a => a.id === '0455000')!
    expect(yarnell.dot).toBeDefined()
    expect(phoenix.dot).toBeUndefined()
    expect(DOT_BELOW_PX).toBeGreaterThan(0)
    // 10/18 (Nic): the marker stands in for a shape too small to see; zoomed
    // in far enough the shape itself is there and the marker goes away.
    expect(dotNeeded(yarnell, 1)).toBe(true)
    expect(dotNeeded(yarnell, 1000)).toBe(false)
    expect(dotNeeded(phoenix, 1)).toBe(false)
  })

  // 10/18 (Nic): the lean overlay marks EVERY area GAM is in, whatever its
  // size, so every drawn shape carries its own middle — not only the ones too
  // small to see.
  it('every drawn shape carries its middle, for the lean overlay\'s markers', () => {
    const flat = flatNational(us, 'county')
    const drawn = flat.areas.filter(a => a.d)
    expect(drawn.length).toBeGreaterThan(3000)
    expect(drawn.every(a => !!a.at)).toBe(true)
    const santaCruz = flat.areas.find(a => a.id === '04023')!   // big enough to see: no marker
    expect(santaCruz.dot).toBeUndefined()
    expect(santaCruz.at![0]).toBeGreaterThan(0)
    expect(santaCruz.at![1]).toBeGreaterThan(0)
    // A shape the picture cannot draw has no middle either (Puerto Rico).
    expect(flat.areas.find(a => a.id === '72001')!.at).toBeUndefined()
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

  // 10/18 (Nic): the same rule as the states — every country GAM is in, drawn
  // together on the one world picture, with nothing to pick.
  it('draws every country GAM is in at the county-or-district level', () => {
    const countries = buildLayer('country', null, boundary('country'))
    const districts = mergeLayers('adm2', ['CAN', 'USA'], ['CAN', 'USA'].map(c => buildLayer('adm2', c, boundary(`adm2/${c}`))))
    const flat = flatWorld(districts, countries)
    expect(districts.groups).toEqual(['CAN', 'USA'])
    expect(flat.areas.length).toBeGreaterThan(3000)
    expect(flat.areas.find(a => a.name === 'Toronto')!.d).not.toBe('')
    expect(flat.areas.find(a => a.id.startsWith('USA.'))!.d).not.toBe('')
    // The country lines are drawn faintly under them, as they are under the provinces.
    expect(flat.context).not.toBe('')
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
    // 10/18 (Nic): several countries' districts are drawn at once, so each
    // district carries its own country — read off its code, since the file
    // itself has nothing but the name.
    const districts = buildLayer('adm2', 'CAN', boundary('adm2/CAN'))
    expect(districts.groups).toEqual(['CAN'])
    expect(districts.country.get('CAN.0036')).toEqual({ code: 'CAN', name: 'CAN' })
    expect(areaCountry('adm2', 'USA.1184', { name: 'Yavapai' })).toEqual({ code: 'USA', name: 'USA' })
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

// ─── 10/18 (Nic): every state at once, and the view that stays ──────────────

describe('loading a level a file at a time', () => {
  /** A stand-in for the admin's API client: the API's own files, and a count of the asks. */
  const stub = (fail: string[] = []) => {
    const asked: string[] = []
    return {
      asked,
      api: {
        get: async (url: string) => {
          asked.push(url)
          const rel = url.replace('/admin/metrics/boundaries/', '')
          if (fail.includes(rel)) throw new Error(`no file for ${rel}`)
          return { data: boundary(rel) }
        },
      } as any,
    }
  }

  beforeEach(() => forgetLayers())

  it('asks for every state with data and joins them into one picture', async () => {
    const { api, asked } = stub()
    const layer = await loadLayerGroups(api, 'place', ['04', '17'])
    expect(asked).toEqual(['/admin/metrics/boundaries/place/04', '/admin/metrics/boundaries/place/17'])
    expect(layer.groups).toEqual(['04', '17'])
    expect(layer.failed).toEqual([])
    // Both files' cities, and both files' outlines, are in the one picture.
    const one = buildLayer('place', '04', boundary('place/04'))
    const two = buildLayer('place', '17', boundary('place/17'))
    expect(layer.areas).toHaveLength(one.areas.length + two.areas.length)
    expect(layer.borders.coordinates).toHaveLength(one.borders.coordinates.length + two.borders.coordinates.length)
    expect(layer.areas.find(a => a.id === '0484980')?.name).toBe('Yarnell')
    expect(layer.areas.find(a => a.id === '1747553')?.name).toMatch(/Mattoon/)
    expect(layerKey('place', layer.groups)).toBe('place/04+17')

    // Each file is its own cache entry: going back asks for nothing again,
    // and adding a state asks only for the state that was added.
    await loadLayerGroups(api, 'place', ['04', '17'])
    expect(asked).toHaveLength(2)
    const more = await loadLayerGroups(api, 'place', ['04', '06', '17'])
    expect(asked).toEqual([...asked.slice(0, 2), '/admin/metrics/boundaries/place/06'])
    expect(more.groups).toEqual(['04', '06', '17'])
  })

  it('one state\'s file failing does not take the others down, and is tried again', async () => {
    const { api, asked } = stub(['place/17'])
    const layer = await loadLayerGroups(api, 'place', ['04', '17'])
    // Arizona is drawn; Illinois is named as missing instead of blanking the
    // map. The picture is still the one that was asked for — both states — so
    // nothing on the page sits waiting for a file that is not coming.
    expect(layer.failed).toEqual(['17'])
    expect(layer.groups).toEqual(['04', '17'])
    expect(layerKey('place', layer.groups)).toBe('place/04+17')
    expect(layer.areas.length).toBeGreaterThan(400)
    expect(layer.areas.some(a => a.id.startsWith('04'))).toBe(true)
    const flat = flatNational(us, 'place', layer)
    expect(flat.areas.filter(a => a.d).length).toBeGreaterThan(400)
    // A picture with a hole in it is not remembered, so asking again really
    // asks again — which is what the Try again button under the map does.
    asked.length = 0
    await loadLayerGroups(api, 'place', ['04', '17'])
    expect(asked).toEqual(['/admin/metrics/boundaries/place/17'])
  })

  it('every file failing is a map that could not be drawn', async () => {
    const { api } = stub(['place/04', 'place/17'])
    await expect(loadLayerGroups(api, 'place', ['04', '17'])).rejects.toThrow()
  })

  it('a level that comes in one national file is one fetch, with no states of its own', async () => {
    const { api, asked } = stub()
    const layer = await loadLayerGroups(api, 'cd', null)
    expect(asked).toEqual(['/admin/metrics/boundaries/cd'])
    expect(layer.groups).toEqual([])
    expect(layerKey('cd', layer.groups)).toBe('cd')
  })
})

describe('the view that stays put', () => {
  const arizona = us.stateById.get('04')!

  it('is the same view on the globe and on the flat map', () => {
    // 10/18 (Nic): "I'd like it to stay — if I zoom in on a certain depth or
    // whatever." A depth is a multiple of where the picture opens, so the
    // globe and the flat map mean the same thing by it.
    expect(homeView(false)).toEqual(US_VIEW)
    expect(homeView(true)).toEqual(WORLD_VIEW)
    expect(globeViewOf(HOME_VIEW, US_VIEW)).toEqual(US_VIEW)
    expect(globeViewOf({ center: null, depth: 4 }, US_VIEW).zoom).toBeCloseTo(US_VIEW.zoom * 4, 6)
    // Turning and zooming the globe, then reading it back, is lossless.
    const turned = zoomBy(dragRotate(US_VIEW, 120, -40, W, H), 3)
    const kept = viewOfGlobe(turned, US_VIEW)
    expect(globeViewOf(kept, US_VIEW).rotate[0]).toBeCloseTo(turned.rotate[0], 6)
    expect(globeViewOf(kept, US_VIEW).rotate[1]).toBeCloseTo(turned.rotate[1], 6)
    expect(globeViewOf(kept, US_VIEW).zoom).toBeCloseTo(turned.zoom, 6)
    // And the depth is held inside the globe's own limits.
    expect(viewOfGlobe({ rotate: [0, 0], zoom: MAX_ZOOM * 10 }, US_VIEW).depth).toBe(MAX_DEPTH)
    expect(viewOfGlobe({ rotate: [0, 0], zoom: 0 }, US_VIEW).depth).toBe(MIN_DEPTH)
  })

  it('zooms the flat picture about a point and keeps that point still', () => {
    const p = nationalProjection()
    // Nothing moved yet: the whole frame, as it has always been drawn.
    expect(flatLook(p, HOME_VIEW)).toEqual({ k: 1, x: 0, y: 0 })
    const phoenix = p([-112.07, 33.45])!
    const inAt = flatZoom(p, HOME_VIEW, 6, [phoenix[0], phoenix[1]])
    expect(inAt.depth).toBeCloseTo(6, 6)
    const look = flatLook(p, inAt)
    // Phoenix is where it was on screen, with everything around it six times bigger.
    expect(look.k).toBeCloseTo(6, 6)
    expect(phoenix[0] * look.k + look.x).toBeCloseTo(phoenix[0], 4)
    expect(phoenix[1] * look.k + look.y).toBeCloseTo(phoenix[1], 4)
    // Arizona now fills a good part of the frame — which is what the state
    // picker's "one state filling the map" used to be for.
    const [[x0, y0], [x1, y1]] = geoPath(p).bounds(arizona.feature)
    expect((x1 - x0) * look.k).toBeGreaterThan(W * 0.5)
    expect((y1 - y0) * look.k).toBeGreaterThan(H * 0.5)
    // Zooming out comes back to where it started.
    const out = flatZoom(p, inAt, 1 / 6, [phoenix[0], phoenix[1]])
    expect(out.depth).toBeCloseTo(1, 6)
    expect(flatCenterPoint(p, out)[0]).toBeCloseTo(W / 2, 2)
    expect(flatCenterPoint(p, out)[1]).toBeCloseTo(H / 2, 2)
  })

  it('pans the flat picture with the pointer, and never off the edge of what it can draw', () => {
    const p = nationalProjection()
    const start = flatZoom(p, HOME_VIEW, 4)
    const moved = flatPan(p, start, 60, -30)
    expect(moved.depth).toBeCloseTo(4, 6)
    const was = flatCenterPoint(p, start)
    const now = flatCenterPoint(p, moved)
    // The land moved right and up with the pointer, so the middle moved left and down.
    expect(now[0]).toBeCloseTo(was[0] - 60 / 4, 2)
    expect(now[1]).toBeCloseTo(was[1] + 30 / 4, 2)
    // A drag that would carry the middle out past what Albers USA draws keeps
    // the view it had, instead of snapping the map to nowhere.
    const far = flatPan(p, moved, 1e6, 1e6)
    expect(far).toEqual(moved)
    // A depth is never past the limits either.
    expect(flatZoom(p, HOME_VIEW, 1e9).depth).toBe(MAX_DEPTH)
    expect(flatZoom(p, HOME_VIEW, 1e-9).depth).toBe(MIN_DEPTH)
  })

  it('keeps the middle and the depth as closely as two projections allow', () => {
    // Switching between the flat map and the globe, and between a United
    // States level and a world one, must not snap home.
    const world = worldProjection()
    const us48 = nationalProjection()
    const onArizona = viewOfArea(arizona.feature, US_VIEW)
    expect(onArizona.center![0]).toBeCloseTo(geoCentroid(arizona.feature)[0], 5)
    expect(onArizona.depth).toBeGreaterThan(3)
    // The world picture can draw Arizona, so it keeps both.
    const worldLook = flatLook(world, onArizona)
    expect(worldLook.k).toBeCloseTo(onArizona.depth, 6)
    expect(worldLook).not.toEqual({ k: 1, x: 0, y: 0 })
    // Albers USA cannot draw Argentina at all; that picture opens where it
    // opens rather than showing nothing, and the kept view is untouched.
    const onArgentina: typeof onArizona = { center: [-60, -32], depth: 9 }
    expect(flatLook(us48, onArgentina)).toEqual({ k: 1, x: 0, y: 0 })
    expect(flatLook(world, onArgentina).k).toBeCloseTo(9, 6)
    // The globe faces it either way: a globe has no edge to fall off.
    expect(globeViewOf(onArgentina, US_VIEW).rotate).toEqual([60, 32])
  })
})

// ─── 10/18 (Nic): how an area votes ─────────────────────────────────────────

describe('the lean overlay', () => {
  beforeEach(() => { forgetElections() })

  it('is a diverging red/blue scale that is colour-blind safe and never black', () => {
    // Nic asked for "a diverging red/blue scale that is colour-blind safe and
    // legible in both themes". Red and blue (ColorBrewer's RdBu), not red and
    // green, and both ends at a middling lightness so neither sinks into the
    // dark page or the light one.
    const [rr, rg, rb] = LEAN_RIGHT_RGB
    const [lr, lg, lb] = LEAN_LEFT_RGB
    expect(rr).toBeGreaterThan(rb)                 // the right end is red
    expect(lb).toBeGreaterThan(lr)                 // the left end is blue
    for (const c of [...LEAN_RIGHT_RGB, ...LEAN_LEFT_RGB, ...LEAN_EVEN_RGB]) {
      expect(c).toBeGreaterThan(50)                // nothing near black
      expect(c).toBeLessThan(230)                  // nothing near white
    }
    // Told apart without seeing red or green: the two ends differ in their
    // blue channel alone by a wide margin.
    expect(Math.abs(rb - lb)).toBeGreaterThan(60)
    expect(rg).toBeLessThan(lg + 80)

    // The scale runs from the even gray out to each end, and tops out there.
    expect(leanColor(0)).toBe(mixRgb(LEAN_LEFT_RGB, LEAN_EVEN_RGB, 0))
    expect(leanColor(METRICS_LEAN_FULL)).toBe(`rgb(${LEAN_RIGHT_RGB.join(', ')})`)
    expect(leanColor(-METRICS_LEAN_FULL)).toBe(`rgb(${LEAN_LEFT_RGB.join(', ')})`)
    // Past the top it holds, exactly as the gold scale does — a 92-point
    // county is not drawn stronger than the end of the key.
    expect(leanColor(92.5)).toBe(leanColor(METRICS_LEAN_FULL))
    expect(leanStrength(0)).toBe(0)
    expect(leanStrength(METRICS_LEAN_FULL / 2)).toBeCloseTo(0.5, 6)
    expect(leanStrength(1e6)).toBe(1)
    expect(leanStrength(NaN)).toBe(0)
    // Every step of the key is its own colour, and the middle one is the gray.
    const steps = LEAN_KEY_STEPS.map(leanColor)
    expect(new Set(steps).size).toBe(LEAN_KEY_STEPS.length)
    expect(steps[2]).toBe(leanColor(0))
  })

  it('says a margin and a swing in words, with the contest\'s own two sides', () => {
    // Santa Cruz County, Arizona: Democratic +18.6 in 2024, Democratic +47.1
    // in 2016 — a 28.5-point move toward the Republican side.
    expect(marginText(-18.6, 'Republican', 'Democratic')).toBe('Democratic +18.6')
    expect(marginText(18.65, 'Republican', 'Democratic')).toBe('Republican +18.7')
    expect(marginText(0, 'Republican', 'Democratic')).toBe('Even')
    expect(marginText(-4, 'Republican', 'Democratic')).toBe('Democratic +4')
    // A ballot measure is the same shape with its own two sides.
    expect(marginText(12.2, 'No', 'Yes')).toBe('No +12.2')
    expect(marginMoveText(-47.1, -18.6, 'Republican', 'Democratic', '2016'))
      .toBe('28.5 points toward the Republican side since 2016.')
    expect(marginMoveText(-18.6, -47.1, 'Republican', 'Democratic', '2016'))
      .toBe('28.5 points toward the Democratic side since 2016.')
    expect(marginMoveText(-18.6, -18.6, 'Republican', 'Democratic', '2016')).toBe('No move since 2016.')
  })

  it('fetches a level\'s results once, and forgets a failure so it can be tried again', async () => {
    const asked: string[] = []
    const api: any = { get: async (url: string) => { asked.push(url); return { data: { level: 'county', contests: [], areas: {} } } } }
    await loadElections(api, 'county')
    await loadElections(api, 'county')
    expect(asked).toEqual(['/admin/metrics/elections/county'])
    const failing: any = { get: async (url: string) => { asked.push(url); throw new Error('no file') } }
    forgetElections()
    await expect(loadElections(failing, 'county')).rejects.toThrow()
    await expect(loadElections(failing, 'county')).rejects.toThrow()
    expect(asked).toHaveLength(3)
  })
})

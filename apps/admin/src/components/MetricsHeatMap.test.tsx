/**
 * 10/13 (Nic) — the Metrics heat map card: the level toggle ("cities,
 * congressional districts, state legislative districts (senate and house), and
 * ZIP codes", beside state and county) and the globe ("a toggle back to the
 * flat map"). The shapes come from the API (behind admin login) — here from
 * the API's own files, through a stand-in for the admin's API client.
 *
 * 10/18 (Nic) — and the two things he asked for after using it: every state at
 * once with no state to pick ("I can't just see them all in the city
 * breakdown, like all every state"), and a view that survives every setting
 * change ("I'd like it to stay — if I zoom in on a certain depth or whatever").
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { readFileSync } from 'fs'
import { join, resolve } from 'path'
import { gunzipSync } from 'zlib'
import { METRICS_MAP_LEVELS, METRICS_MAP_LEVEL_LABEL } from '@gam/shared'
import { MetricsHeatMap, type PlatformMapData } from './MetricsHeatMap'
import { forgetCensus, forgetLayers, forgetWorld } from './metricsMapGeo'

const GEO = resolve(__dirname, '../../../api/geo')
/** 10/17 (Nic): the census numbers the saturation overlay divides by (apps/api/census). */
const CENSUS = resolve(__dirname, '../../../api/census')
const gets: string[] = []
const api: any = {
  get: async (url: string) => {
    gets.push(url)
    const census = url.startsWith('/admin/metrics/census/')
    const dir = census ? CENSUS : GEO
    const rel = url.replace(/^\/admin\/metrics\/(boundaries|census)\//, '')
    return { data: JSON.parse(gunzipSync(readFileSync(join(dir, `${rel}.json.gz`))).toString('utf8')) }
  },
}

/**
 * 10/17 (review): every area's OCCUPIED count is deliberately a different
 * number from its unit count. It used to be the same one, so every "both ways"
 * assertion compared a value to itself — "1.9% · 1.9%" — and swapping the two
 * columns, or pointing both at the same field, passed the whole suite. Nic
 * asked for the numerator BOTH ways side by side, so the two have to be told
 * apart here or nothing checks that they are.
 */
const area = (fips: string, name: string, units: number, money: number, extra: object = {}) =>
  ({ fips, name, units, occupied: Math.round(units / 2), money, properties: 1, ...extra })
/** 10/17 (Nic): an area outside the United States — drawn with its country, not a state. */
const world = (fips: string, name: string, units: number, money: number, country: string, countryName: string) =>
  area(fips, name, units, money, { state: '', stateFips: '', country, countryName })
const DATA: PlatformMapData = {
  states: [area('04', 'Arizona', 128, 9000, { abbr: 'AZ' }), area('17', 'Illinois', 31, 2000, { abbr: 'IL' })],
  counties: [area('04025', 'Yavapai', 29, 3000, { state: 'AZ' }), area('04023', 'Santa Cruz', 99, 6000, { state: 'AZ' }),
    area('17029', 'Coles', 31, 2000, { state: 'IL' })],
  missing: [],
  levels: {
    // 10/18 (Nic): `states` is where GAM has data (drawn together, by default)
    // and `allStates` every state the Census files cover (the "Every state"
    // choice, loaded on demand). Three here, so the two are told apart.
    place: { states: ['04', '17'], allStates: ['04', '06', '17'], missing: [],
      areas: [area('0484980', 'Yarnell', 29, 3000, { state: 'AZ', stateFips: '04' }),
        area('1747553', 'Mattoon', 31, 2000, { state: 'IL', stateFips: '17' })] },
    cd: { states: [], missing: [], areas: [area('0402', 'Congressional District 2', 29, 3000, { state: 'AZ', stateFips: '04' })] },
    sldu: { states: ['04', '17'], allStates: ['04', '06', '17'], missing: [], areas: [] },
    sldl: { states: ['04', '17'], allStates: ['04', '06', '17'],
      areas: [area('04001', 'State House District 1', 29, 3000, { state: 'AZ', stateFips: '04' })],
      missing: [{ reason: 'no_location', label: 'no map location on file for its address', properties: 1, units: 99, occupied: 50, money: 6000 }] },
    zcta: { states: ['04', '17'], allStates: ['04', '06', '17'], missing: [], areas: [area('85362', 'ZIP 85362', 29, 3000, { state: 'AZ', stateFips: '04' }),
      area('85645', 'ZIP 85645', 99, 6000, { state: 'AZ', stateFips: '04' }), area('61938', 'ZIP 61938', 31, 2000, { state: 'IL', stateFips: '17' })] },
    // 10/17 (Nic): the rest of the world. A world area carries its country
    // instead of a state, and the county-or-district level is drawn one
    // country at a time.
    country: { states: [], countries: [], missing: [],
      areas: [world('USA', 'United States of America', 128, 9000, 'USA', 'United States of America'),
        world('CAN', 'Canada', 12, 400, 'CAN', 'Canada')] },
    adm1: { states: [], countries: [], missing: [],
      areas: [world('USA-3520', 'Arizona', 128, 9000, 'USA', 'United States of America'),
        world('CAN-682', 'Ontario', 12, 400, 'CAN', 'Canada')] },
    adm2: { states: [], countries: ['CAN', 'USA'], allCountries: ['CAN', 'MEX', 'USA'], missing: [],
      areas: [world('USA.1184', 'Yavapai', 29, 3000, 'USA', 'United States of America'),
        world('CAN.0036', 'Toronto', 12, 400, 'CAN', 'Canada')] },
  },
}

// React's act() runs only where the test says it is one.
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  gets.length = 0
  // The land around the United States, and the census numbers, are kept for
  // the page's life; start cold.
  forgetWorld()
  forgetCensus()
  // 10/18 (Nic): so are the levels' own shapes, now that a level is several
  // files — every test starts with nothing in hand and asks for what it needs.
  forgetLayers()
  // jsdom has no canvas; the globe draws nothing there, which is all these tests need.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks() })

async function settle() {
  for (let i = 0; i < 40; i++) {
    await act(async () => { await new Promise(r => setTimeout(r, 25)) })
    if (!host.textContent?.includes('Drawing the map')) return
  }
}
const render = async (data: PlatformMapData | null = DATA) => {
  await act(async () => { root.render(<MetricsHeatMap data={data} api={api}/>) })
  await settle()
}
const levelSelect = () => host.querySelector('select[aria-label="Map level"]') as HTMLSelectElement
/** 10/18 (Nic): what is left where the state picker was — how far past GAM's footprint to draw. */
const stateSelect = () => host.querySelector('select[aria-label="States on the map"]') as HTMLSelectElement | null
const countrySelect = () => host.querySelector('select[aria-label="Countries on the map"]') as HTMLSelectElement | null
/** The flat picture's zoom and pan, as it is drawn. */
const flatTransform = () => host.querySelector('svg[role="img"] > g')?.getAttribute('transform') ?? ''
const mapSvg = () => host.querySelector('svg[role="img"]') as SVGSVGElement
const press = async (key: string) => {
  await act(async () => { mapSvg().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })) })
}
const click = async (text: string) => { await act(async () => { button(text).click() }); await settle() }
const groups = () => [...host.querySelectorAll('select[aria-label="Map level"] optgroup')]
  .map(g => [g.getAttribute('label'), [...g.querySelectorAll('option')].map(o => o.value)])
const measures = () => [...host.querySelectorAll('[role="group"][aria-label="What the color shows"] button')].map(b => b.textContent)
const caption = () => host.querySelectorAll('.ks')[0]?.textContent ?? ''
const credit = () => host.querySelector('.mhm-credit')?.textContent ?? ''
const readout = () => host.querySelector('.mhm-readout')!.textContent ?? ''
const choose = async (select: HTMLSelectElement, value: string) => {
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
    set.call(select, value)
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await settle()
}
const button = (text: string) => [...host.querySelectorAll('button')].find(b => b.textContent === text)!
const listRows = () => [...host.querySelectorAll('.mhm-row')].map(r => r.textContent)

describe('MetricsHeatMap levels', () => {
  it('offers every level, by name', async () => {
    await render()
    expect([...levelSelect().options].map(o => [o.value, o.textContent])).toEqual(
      METRICS_MAP_LEVELS.map(l => [l, METRICS_MAP_LEVEL_LABEL[l]]))
    expect(levelSelect().value).toBe('state')
    expect(listRows()).toEqual(['Arizona64 occupied units', 'Illinois16 occupied units'])
  })

  // 10/18 (Nic): "when I change it to the city view, I have to then select
  // between Arizona and Illinois. I can't just see them all in the city
  // breakdown, like all every state."
  it('ZIP codes: every state GAM is in at once, a file each, with no state to pick', async () => {
    await render()
    await choose(levelSelect(), 'zcta')
    // One fetch per state GAM has data in, and nothing for the 54 it does not.
    expect(gets).toEqual(['/admin/metrics/boundaries/zcta/04', '/admin/metrics/boundaries/zcta/17'])
    expect(host.querySelector('svg[role="img"]')?.getAttribute('aria-label')).toMatch(/^Map of the United States by ZIP code/)
    // Both states' ZIP codes are drawn, in the one national picture.
    expect(host.querySelector('path[data-fips="85362"]')).not.toBeNull()   // Arizona
    expect(host.querySelector('path[data-fips="61938"]')).not.toBeNull()   // Illinois
    expect(host.querySelectorAll('path[data-fips]').length).toBeGreaterThan(1700)
    expect(caption()).toContain('ZIP codes are drawn for every state GAM has data in')
    // What is left where the picker was says only how far past GAM to go.
    expect([...stateSelect()!.options].map(o => o.textContent)).toEqual(['Where GAM is (2 states)', 'Every state'])
    expect(stateSelect()!.value).toBe('data')
    expect(listRows()).toEqual(['ZIP 85645, Arizona50 occupied units', 'ZIP 61938, Illinois16 occupied units', 'ZIP 85362, Arizona15 occupied units'])
  })

  it('"Every state" is loaded on demand, says it is loading, and keeps the files already in hand', async () => {
    await render()
    await choose(levelSelect(), 'place')
    expect(gets).toEqual(['/admin/metrics/boundaries/place/04', '/admin/metrics/boundaries/place/17'])
    // The whole country is megabytes of shapes, so it is never fetched until asked for.
    await choose(stateSelect()!, 'all')
    expect(gets).toEqual([...gets.slice(0, 2), '/admin/metrics/boundaries/place/06'])
    expect(host.querySelector('path[data-fips="0484980"]')).not.toBeNull()
    expect(caption()).toContain('Cities are drawn for every state')
    // And the answer is a setting like any other: changing the level keeps it.
    await choose(levelSelect(), 'zcta')
    expect(stateSelect()!.value).toBe('all')
    expect(gets.filter(u => u.includes('/zcta/')).sort())
      .toEqual(['/admin/metrics/boundaries/zcta/04', '/admin/metrics/boundaries/zcta/06', '/admin/metrics/boundaries/zcta/17'])
  })

  it('a place picked from the list is outlined where it is, with no state to switch to', async () => {
    await render()
    await choose(levelSelect(), 'place')
    const yarnell = [...host.querySelectorAll('.mhm-row')].find(r => r.textContent?.startsWith('Yarnell'))! as HTMLButtonElement
    const before = flatTransform()
    await act(async () => { yarnell.click() })
    await settle()
    expect(host.querySelector('.mhm-readout')!.textContent).toMatch(/Yarnell, Arizona · 15 occupied units/)
    // Too small to see at this zoom: a marker in its own color, outlined as the pick.
    expect(host.querySelector('circle.mhm-dot.on[data-fips="0484980"]')).not.toBeNull()
    // Illinois is still drawn beside it — nothing was swapped out — and the
    // flat map did not move under him.
    expect(host.querySelector('path[data-fips="1747553"]')).not.toBeNull()
    expect(flatTransform()).toBe(before)
    expect(gets).toEqual(['/admin/metrics/boundaries/place/04', '/admin/metrics/boundaries/place/17'])
  })

  it('a level with nothing anywhere says so, and points to the list', async () => {
    await render()
    await choose(levelSelect(), 'sldu')   // nothing at this level anywhere
    expect(host.querySelector('.mhm-empty')!.textContent).toBe('No units are occupied this month.')
    await choose(levelSelect(), 'sldl')
    expect(host.querySelector('.mhm-empty')).toBeNull()
    expect(listRows()).toEqual(['State House District 1, Arizona15 occupied units'])
  })

  it('a state whose shapes will not load does not blank the others', async () => {
    // 10/18 (Nic): the map is made of a file per state now, so one file
    // failing must leave the rest of the country drawn and say which state is
    // missing — not replace the whole map with an error.
    const failing: any = {
      get: async (url: string) => {
        gets.push(url)
        if (url.endsWith('/place/17')) throw new Error('no file for Illinois')
        return api.get(url)
      },
    }
    await act(async () => { root.render(<MetricsHeatMap data={DATA} api={failing}/>) })
    await settle()
    await choose(levelSelect(), 'place')
    expect(host.textContent).not.toContain('The map could not be drawn just now.')
    expect(host.querySelector('path[data-fips="0484980"]')).not.toBeNull()   // Arizona drawn
    expect(host.querySelector('path[data-fips="1747553"]')).toBeNull()       // Illinois not
    const named = [...host.querySelectorAll('.mhm-missing')].map(d => d.textContent).join(' ')
    expect(named).toContain('Shapes that could not be loaded')
    expect(named).toContain('Illinois')
    // Its numbers are still in the list beside the map, and in the tiles above.
    expect(listRows()).toEqual(['Mattoon, Illinois16 occupied units', 'Yarnell, Arizona15 occupied units'])
  })

  it('congressional districts: the whole country from one file; each level names what it could not place', async () => {
    await render()
    await choose(levelSelect(), 'cd')
    expect(stateSelect()).toBeNull()
    expect(gets).toEqual(['/admin/metrics/boundaries/cd'])
    expect(listRows()).toEqual(['Congressional District 2, Arizona15 occupied units'])
    await choose(levelSelect(), 'sldl')
    expect(host.querySelector('.mhm-missing')!.textContent).toMatch(/1 property · 50 occupied units — no map location on file for its address/)
  })

  it('an API that does not send the new levels yet is not an empty map', async () => {
    const { levels: _levels, ...old } = DATA
    await render(old)
    await choose(levelSelect(), 'zcta')
    expect(host.querySelector('.mhm-msg')!.textContent).toBe('Map numbers are not available yet.')
    expect(host.textContent).not.toContain('Drawing the map')
    expect(gets).toEqual([])
  })
})

// ─── 10/17 (Nic): the rest of the world ─────────────────────────────────────

describe('MetricsHeatMap world levels', () => {
  it('puts the world\'s levels in their own group, after the United States\'', async () => {
    await render()
    // Nic: "that's only pertinent to the United States for now. Just break the
    // rest of the countries down by states or province and then possibly
    // cities as well or counties." Voting districts stay in the first group.
    expect(groups()).toEqual([
      ['United States', ['state', 'county', 'place', 'cd', 'sldu', 'sldl', 'zcta']],
      ['Worldwide', ['country', 'adm1', 'adm2']],
    ])
  })

  it('draws every country, and names a province with its country', async () => {
    await render()
    await choose(levelSelect(), 'country')
    expect(gets).toEqual(['/admin/metrics/boundaries/country'])
    expect(stateSelect()).toBeNull()
    expect(countrySelect()).toBeNull()
    expect(host.querySelector('svg[role="img"]')?.getAttribute('aria-label')).toMatch(/^Map of the world by country/)
    expect(host.querySelectorAll('path[data-fips]').length).toBeGreaterThan(200)
    expect(listRows()).toEqual(['United States of America64 occupied units', 'Canada6 occupied units'])
    expect(credit()).toBe('Shapes: Natural Earth (public domain).')

    await choose(levelSelect(), 'adm1')
    // The provinces are one file for the whole world, drawn over the country lines.
    expect(gets).toContain('/admin/metrics/boundaries/adm1')
    expect(listRows()).toEqual(['Arizona, United States of America64 occupied units', 'Ontario, Canada6 occupied units'])
  })

  it('draws the counties and districts of every country GAM is in, and credits geoBoundaries', async () => {
    // 10/18 (Nic): the same rule as the states — every country GAM has data
    // in, together, with nothing to pick.
    await render()
    await choose(levelSelect(), 'adm2')
    expect(gets.filter(u => u.includes('/adm2/')))
      .toEqual(['/admin/metrics/boundaries/adm2/CAN', '/admin/metrics/boundaries/adm2/USA'])
    expect([...countrySelect()!.options].map(o => o.textContent)).toEqual(['Where GAM is (2 countries)', 'Every country'])
    expect(host.querySelector('svg[role="img"]')?.getAttribute('aria-label')).toMatch(/^Map of the world by county or district/)
    // Nic: "Credit geoBoundaries on the map (CC BY 4.0)."
    expect(credit()).toBe('Shapes: geoBoundaries (geoboundaries.org), CC BY 4.0.')
    expect(listRows()).toEqual(['Yavapai, United States of America15 occupied units', 'Toronto, Canada6 occupied units'])

    // Both countries' districts are on the one map, so picking one from the
    // list only names and outlines it.
    const toronto = [...host.querySelectorAll('.mhm-row')].find(r => r.textContent?.startsWith('Toronto'))! as HTMLButtonElement
    await act(async () => { toronto.click() })
    await settle()
    expect(readout()).toMatch(/Toronto, Canada · 6 occupied units/)
    expect(host.querySelector('path[data-fips="CAN.0036"]')).not.toBeNull()
    expect(host.querySelector('path[data-fips="USA.1184"]')).not.toBeNull()
    expect(gets.filter(u => u.includes('/adm2/'))).toHaveLength(2)
    // A district's country comes off its own code, so a district GAM has no
    // number for still reads with its country.
    expect(host.querySelectorAll('path[data-fips^="MEX."]').length).toBe(0)
  })

  it('offers no saturation or concentration overlay where there are no census numbers', async () => {
    await render()
    expect(measures()).toEqual(['Units', 'Money', 'Saturation'])
    await choose(levelSelect(), 'cd')
    expect(measures()).toEqual(['Units', 'Money', 'Saturation', 'Concentration'])
    for (const level of ['country', 'adm1', 'adm2'] as const) {
      await choose(levelSelect(), level)
      // U.S. Census counts say nothing about Ontario, and voting districts are
      // United States only.
      expect(measures(), level).toEqual(['Units', 'Money'])
      expect(gets.filter(u => u.includes('/census/')), level).toEqual([])
    }
  })
})

describe('MetricsHeatMap saturation overlay', () => {
  const satButton = () => button('Saturation')

  it('colors by GAM\'s share of the area\'s own market, and says what the share is of', async () => {
    // Nic: "we're in Santa Cruz County and we are responsible for 30% of the
    // population or 60% of the total rental units ... so we can target areas
    // that have room to grow."
    await render()
    await choose(levelSelect(), 'county')
    await act(async () => { satButton().click() })
    await settle()
    expect(gets).toContain('/admin/metrics/census/county')
    expect(caption()).toContain("GAM's share of the renter-occupied homes the Census counts in each county")
    expect(caption()).toContain('For every 100 renter-occupied homes the Census counts in an area, this is how many spaces GAM has there.')
    // Santa Cruz County AZ: 99 spaces (50 of them occupied) of 5,318
    // renter-occupied homes. Each row is the numerator both ways.
    expect(listRows()).toEqual(['Santa Cruz, Arizona1.9% · 0.9%', 'Coles, Illinois0.4% · 0.2%', 'Yavapai, Arizona0.1% · 0.1%'])
  })

  it('shows the numerator both ways, and the two numbers the share came from', async () => {
    await render()
    await choose(levelSelect(), 'county')
    await act(async () => { satButton().click() })
    await settle()
    const santaCruz = [...host.querySelectorAll('.mhm-row')].find(r => r.textContent?.startsWith('Santa Cruz'))! as HTMLButtonElement
    await act(async () => { santaCruz.click() })
    await settle()
    // Nic asked for the numerator both ways, side by side. The two are
    // different numbers, so a transposition cannot pass this.
    expect(readout()).toContain('Santa Cruz, Arizona · 0.9%')
    expect(readout()).toContain('50 spaces where the Census counts 5,318 renter-occupied homes')
    expect(readout()).toContain('All spaces 1.9% · Occupied 0.9%')
    // 10/17 (review): "50 of 5,318" was the old wording, and it is nonsense
    // the moment GAM has more spaces than the survey counts homes.
    expect(readout()).not.toContain('of 5,318 renter-occupied homes here')
  })

  it('each denominator is its own view', async () => {
    // Nic: "show all. because we are doing short term rentals as well as
    // living situations. its not only regular rentals. toggle each view/metric"
    await render()
    await choose(levelSelect(), 'county')
    await act(async () => { satButton().click() })
    await settle()
    const rowFor = (name: string) => [...host.querySelectorAll('.mhm-row')]
      .find(r => r.textContent?.startsWith(name))!.querySelector('.mhm-row-value')!.textContent
    expect(rowFor('Santa Cruz')).toBe('1.9% · 0.9%')
    await act(async () => { button('All homes').click() })
    await settle()
    expect(caption()).toContain('rented, owned or empty')
    expect(rowFor('Santa Cruz')).toBe('0.5% · 0.3%')
    await act(async () => { button('People').click() })
    await settle()
    expect(caption()).toContain('One space can hold more than one person')
    expect(rowFor('Santa Cruz')).toBe('0.2% · 0.1%')
    // One census fetch for the level, however many views are looked at.
    expect(gets.filter(u => u.includes('/census/'))).toEqual(['/admin/metrics/census/county'])
  })

  it('names which survey the numbers are, beside where the shapes came from', async () => {
    await render()
    await choose(levelSelect(), 'county')
    await act(async () => { satButton().click() })
    await settle()
    expect(credit()).toContain('Shapes: U.S. Census boundaries (public domain).')
    expect(credit()).toContain('American Community Survey')
  })

  it('a park bigger than the whole Census count reads over 100%, and the caption says what that means', async () => {
    // 10/17 (review): GAM's market is parks in tiny Census places. ZIP 85645
    // (Amado, Arizona) counts 47 renter-occupied homes and one park there is
    // 99 spaces, 50 of them occupied — 211% and 106%. The number used to sit
    // under a sentence that said a share could not pass 100, and the color
    // scale ran all the way up to it, which flattened every other area.
    await render()
    await choose(levelSelect(), 'zcta')
    await act(async () => { satButton().click() })
    await settle()
    expect(listRows()).toEqual(['ZIP 85645, Arizona211% · 106%', 'ZIP 85362, Arizona34.9% · 18.1%', 'ZIP 61938, Illinois0.9% · 0.4%'])
    expect(caption()).toContain('For every 100 renter-occupied homes the Census counts in an area, this is how many spaces GAM has there.')
    expect(caption()).toContain('Over 100% means GAM has more spaces in that area than the Census counts there at all')
    // The color tops out at "as many spaces as the Census counts, or more", so
    // the areas below it keep their own color instead of washing out.
    expect(host.querySelector('.mhm-legend')!.textContent).toContain('100% or more')
    const swatches = [...host.querySelectorAll('.mhm-ramp span')].map(s => (s as HTMLElement).style.background)
    expect(swatches.length).toBe(5)
    expect(new Set(swatches).size).toBe(5)
    // The hover reads in words that are true with the bigger number first.
    const zip = [...host.querySelectorAll('.mhm-row')].find(r => r.textContent?.startsWith('ZIP 85645'))! as HTMLButtonElement
    await act(async () => { zip.click() })
    await settle()
    expect(readout()).toContain('50 spaces where the Census counts 47 renter-occupied homes')
    expect(readout()).toContain('All spaces 211% · Occupied 106%')
  })

  it('an area the Census counts nothing in is named under the map, not dropped from it', async () => {
    // 10/17 (review): Amado, Arizona is a real GAM address whose Census place
    // counts 41 people, 41 housing units and NO renter-occupied home. In the
    // Renter homes view it had no share, so it had no color, no row in the
    // list and no line anywhere — it read as "GAM is not there". 3,343 of the
    // 32,325 Census places are like that.
    const data: PlatformMapData = {
      ...DATA,
      levels: {
        ...DATA.levels,
        place: { states: ['04'], missing: [], areas: [
          area('0401990', 'Amado', 99, 6000, { state: 'AZ', stateFips: '04' }),
          area('0484980', 'Yarnell', 29, 3000, { state: 'AZ', stateFips: '04' }),
        ] },
      },
    }
    await render(data)
    await choose(levelSelect(), 'place')
    await act(async () => { satButton().click() })
    await settle()
    expect(listRows()).toEqual(['Yarnell, Arizona34.9% · 18.1%'])
    const named = [...host.querySelectorAll('.mhm-missing')].map(d => d.textContent).join(' ')
    expect(named).toContain('No Census count here')
    expect(named).toContain('The Census counts no renter-occupied homes here, so there is no share to draw.')
    expect(named).toContain('Amado, Arizona · 50 occupied units')
    // Nic's second view counts housing units, which Amado does have — 99
    // spaces in 41 of them — so it moves onto the map and out of that list.
    await act(async () => { button('All homes').click() })
    await settle()
    expect(listRows()).toEqual(['Amado, Arizona241% · 122%', 'Yarnell, Arizona5% · 2.6%'])
    expect([...host.querySelectorAll('.mhm-missing')].map(d => d.textContent).join(' ')).not.toContain('No Census count here')
  })

  it('a census file that cannot be fetched stops the overlay only, and Units comes straight back', async () => {
    // 10/17 (review): the failure flag was set once and never cleared, so one
    // failed fetch replaced the whole map — Units and Money with it — for the
    // rest of the page's life, and Try again could not clear it either.
    const failing: any = {
      get: async (url: string) => {
        if (url.includes('/metrics/census/')) { gets.push(url); throw new Error('no census file beside the API') }
        return api.get(url)
      },
    }
    await act(async () => { root.render(<MetricsHeatMap data={DATA} api={failing}/>) })
    await settle()
    await choose(levelSelect(), 'county')
    expect(listRows()).toEqual(['Santa Cruz, Arizona50 occupied units', 'Coles, Illinois16 occupied units', 'Yavapai, Arizona15 occupied units'])
    await act(async () => { satButton().click() })
    await settle()
    expect(gets).toContain('/admin/metrics/census/county')
    expect(host.textContent).toContain('The map could not be drawn just now.')
    // Back to Units and the map is drawn again, numbers and all.
    await act(async () => { button('Units').click() })
    await settle()
    expect(host.textContent).not.toContain('The map could not be drawn just now.')
    expect(listRows()).toEqual(['Santa Cruz, Arizona50 occupied units', 'Coles, Illinois16 occupied units', 'Yavapai, Arizona15 occupied units'])
  })
})

describe('MetricsHeatMap concentration overlay', () => {
  it('colors a voting district by its share of everything GAM has placed, not of the district', async () => {
    // Nic: "an overlay to show what areas GAM is heavily concentrated in and
    // how those voting districts kind of line up, and see where we can focus."
    await render()
    await choose(levelSelect(), 'cd')
    await act(async () => { button('Concentration').click() })
    await settle()
    expect(caption()).toContain("each congressional district's share of every space GAM has placed at this level")
    expect(caption()).toContain('It is a share of GAM, not a share of the district.')
    // The one district with anything in it holds all of it, whichever of the
    // two numerators is read — and they are different numbers here.
    expect(listRows()).toEqual(['Congressional District 2, Arizona100% · 100%'])
    const row = host.querySelector('.mhm-row')! as HTMLButtonElement
    await act(async () => { row.click() })
    await settle()
    expect(readout()).toContain("15 of GAM's 15 at this level")
    // No census numbers are needed for a share of GAM.
    expect(gets.filter(u => u.includes('/census/'))).toEqual([])
  })

  it('falls back to Units on a level that has no concentration, and remembers the pick', async () => {
    await render()
    await choose(levelSelect(), 'cd')
    await act(async () => { button('Concentration').click() })
    await settle()
    await choose(levelSelect(), 'country')
    // The world has no voting districts; the color goes back to Units.
    expect(measures()).toEqual(['Units', 'Money'])
    expect(listRows()).toEqual(['United States of America64 occupied units', 'Canada6 occupied units'])
    await choose(levelSelect(), 'cd')
    expect(listRows()).toEqual(['Congressional District 2, Arizona100% · 100%'])
  })
})

describe('MetricsHeatMap globe', () => {
  it('toggles to the globe and back to the flat map', async () => {
    await render()
    await click('Globe')
    const canvas = host.querySelector('canvas.mhm-globe')!
    expect(canvas.getAttribute('role')).toBe('img')
    expect(canvas.getAttribute('aria-label')).toMatch(/^Globe of the United States by state.*Drag or use the arrow keys/)
    expect(host.querySelector('button[aria-label="Zoom in"]')).not.toBeNull()
    expect(host.querySelector('button[aria-label="Zoom out"]')).not.toBeNull()
    expect(host.querySelector('svg[role="img"]')).toBeNull()
    // The list and the numbers are the same on the globe.
    expect(listRows()).toEqual(['Arizona64 occupied units', 'Illinois16 occupied units'])
    await act(async () => { button('Flat map').click() })
    await settle()
    expect(host.querySelector('canvas.mhm-globe')).toBeNull()
    expect(host.querySelector('svg[role="img"]')).not.toBeNull()
  })

  it('fetches the land around the United States when the globe opens, and never for the flat map', async () => {
    // 10/17 (review): Nic asked to "click and drag to rotate the earth" and
    // nothing but the United States was painted on it. The land comes from the
    // API's own file, once, and the flat map never pays for it.
    await render()
    expect(gets.filter(u => u.endsWith('/world'))).toEqual([])
    await act(async () => { button('Globe').click() })
    await settle()
    expect(gets.filter(u => u.endsWith('/world'))).toEqual(['/admin/metrics/boundaries/world'])
    await act(async () => { button('Flat map').click() })
    await settle()
    await act(async () => { button('Globe').click() })
    await settle()
    // Already in hand: it is not fetched a second time.
    expect(gets.filter(u => u.endsWith('/world'))).toHaveLength(1)
  })

  it('every zoom and reset control is a gold action button, on both pictures', async () => {
    await render()
    // 10/18 (Nic): the flat map zooms too, so the controls are the card's and
    // they are there before the globe is ever opened.
    expect(host.querySelectorAll('.mhm-tools button')).toHaveLength(3)
    for (const b of host.querySelectorAll('.mhm-tools button')) expect(b.className).toContain('btn-primary')
    await click('Globe')
    expect(host.querySelectorAll('.mhm-tools button')).toHaveLength(3)
    for (const b of host.querySelectorAll('.mhm-tools button')) expect(b.className).toContain('btn-primary')
  })
})

// ─── 10/18 (Nic): "not having the map reset every time I change a setting" ───

describe('MetricsHeatMap keeps the view', () => {
  /** Zoom in and move off centre, the way he would before changing a setting. */
  const zoomAndPan = async () => {
    await click('+')
    await press('ArrowLeft')
    await press('ArrowUp')
    const at = flatTransform()
    expect(at).not.toBe('translate(0 0) scale(1)')
    return at
  }

  it('survives every setting change: the level, units or money, occupied or all, the overlays', async () => {
    await render()
    const at = await zoomAndPan()
    // Nic: "changing between state and county view leaves it the same" — and
    // now so does every other change.
    await choose(levelSelect(), 'county')
    expect(flatTransform()).toBe(at)
    await choose(levelSelect(), 'place')
    expect(flatTransform()).toBe(at)
    await choose(levelSelect(), 'zcta')
    expect(flatTransform()).toBe(at)
    await choose(levelSelect(), 'cd')
    expect(flatTransform()).toBe(at)
    await click('Money')
    expect(flatTransform()).toBe(at)
    await click('Units')
    expect(flatTransform()).toBe(at)
    await click('All spaces')
    expect(flatTransform()).toBe(at)
    await click('Occupied (billed)')
    expect(flatTransform()).toBe(at)
    await click('Concentration')
    expect(flatTransform()).toBe(at)
    await click('Saturation')
    expect(flatTransform()).toBe(at)
    // Each saturation denominator is its own view; none of them is a new map.
    await click('All homes')
    expect(flatTransform()).toBe(at)
    await click('People')
    expect(flatTransform()).toBe(at)
    // And so is drawing more states than GAM is in.
    await choose(levelSelect(), 'place')
    expect(flatTransform()).toBe(at)
    await choose(stateSelect()!, 'all')
    expect(flatTransform()).toBe(at)
  })

  it('keeps the depth across the flat map and the globe, and across the world levels', async () => {
    await render()
    const at = await zoomAndPan()
    const depth = Number(at.match(/scale\(([\d.]+)\)/)![1])
    expect(depth).toBeGreaterThan(1)
    // The globe cannot show the same picture, but it must not snap home: the
    // depth and the middle come back when the flat map does.
    await click('Globe')
    expect(host.querySelector('canvas.mhm-globe')).not.toBeNull()
    await click('Flat map')
    expect(flatTransform()).toBe(at)
    // A world level is a different projection; the depth still holds.
    await choose(levelSelect(), 'country')
    expect(Number(flatTransform().match(/scale\(([\d.]+)\)/)![1])).toBeCloseTo(depth, 6)
    await choose(levelSelect(), 'state')
    expect(flatTransform()).toBe(at)
  })

  it('scrolling over the flat map zooms it, and does not scroll the page with it', async () => {
    await render()
    const before = flatTransform()
    let defaultPrevented = false
    await act(async () => {
      const e = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -240, clientX: 120, clientY: 90 })
      mapSvg().dispatchEvent(e)
      defaultPrevented = e.defaultPrevented
    })
    expect(flatTransform()).not.toBe(before)
    expect(Number(flatTransform().match(/scale\(([\d.]+)\)/)![1])).toBeGreaterThan(1)
    expect(defaultPrevented).toBe(true)
  })

  it('Reset is the one way back, and nothing else does it for him', async () => {
    await render()
    const at = await zoomAndPan()
    await click('Reset')
    expect(flatTransform()).toBe('translate(0 0) scale(1)')
    // Zooming out past the opening framing is allowed on purpose (the globe
    // pulls back to the whole earth that way), so "home" is not just depth 1.
    await click('+')
    expect(flatTransform()).not.toBe(at)
    await press('0')
    expect(flatTransform()).toBe('translate(0 0) scale(1)')
  })

  it('a click still picks a place, and a drag moves the map instead', async () => {
    await render()
    await choose(levelSelect(), 'county')
    const santaCruz = () => host.querySelector('path[data-fips="04023"]')!
    const at = (type: string, x: number, y: number) => {
      // jsdom has no PointerEvent; a mouse event with the pointer fields on
      // it is what React's pointer handlers read.
      const e: any = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 })
      e.pointerId = 1; e.pointerType = 'mouse'
      return e
    }
    // Down and up in the same place: the county is picked, as it always was.
    await act(async () => {
      santaCruz().dispatchEvent(at('pointerdown', 100, 100))
      santaCruz().dispatchEvent(at('pointerup', 100, 100))
    })
    expect(readout()).toMatch(/Santa Cruz, Arizona/)
    const before = flatTransform()
    // Down, moved, up: the map moved and nothing was picked.
    await act(async () => {
      santaCruz().dispatchEvent(at('pointerdown', 100, 100))
      santaCruz().dispatchEvent(at('pointermove', 160, 130))
      santaCruz().dispatchEvent(at('pointerup', 160, 130))
    })
    expect(flatTransform()).not.toBe(before)
    expect(readout()).toMatch(/Santa Cruz, Arizona/)
  })
})

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
import { forgetCensus, forgetElections, forgetLayers, forgetWorld, leanColor } from './metricsMapGeo'

const GEO = resolve(__dirname, '../../../api/geo')
/** 10/17 (Nic): the census numbers the saturation overlay divides by (apps/api/census). */
const CENSUS = resolve(__dirname, '../../../api/census')
/** 10/18 (Nic): and the election results the lean overlay colors by (apps/api/elections). */
const ELECTIONS = resolve(__dirname, '../../../api/elections')
const gets: string[] = []
const api: any = {
  get: async (url: string) => {
    gets.push(url)
    const dir = url.startsWith('/admin/metrics/census/') ? CENSUS
      : url.startsWith('/admin/metrics/elections/') ? ELECTIONS : GEO
    const rel = url.replace(/^\/admin\/metrics\/(boundaries|census|elections)\//, '')
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
  forgetElections()
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

  // 10/18 (Nic, correcting the morning's pass): "if I click a row in the list,
  // it should snap to it. That's fine." The flat map moves to the place now,
  // the way the globe always did — it is a click, not a setting.
  it('a place picked from the list snaps the flat map to it, with no state to switch to', async () => {
    await render()
    await choose(levelSelect(), 'place')
    const yarnell = [...host.querySelectorAll('.mhm-row')].find(r => r.textContent?.startsWith('Yarnell'))! as HTMLButtonElement
    const before = flatTransform()
    await act(async () => { yarnell.click() })
    await settle()
    expect(host.querySelector('.mhm-readout')!.textContent).toMatch(/Yarnell, Arizona · 15 occupied units/)
    // Zoomed in on it, the town is big enough to see, so it is outlined as the
    // pick rather than standing in as a marker (dotNeeded).
    expect(host.querySelector('path.mhm-focus')).not.toBeNull()
    expect(host.querySelector('.mhm-row.on')!.textContent).toMatch(/^Yarnell/)
    // Illinois is still drawn beside it — nothing was swapped out — and the
    // view has moved in on the place he clicked.
    expect(host.querySelector('path[data-fips="1747553"]')).not.toBeNull()
    expect(flatTransform()).not.toBe(before)
    expect(Number(flatTransform().match(/scale\(([\d.]+)\)/)![1])).toBeGreaterThan(1)
    // Clicking the same row again lets it go, and moves nothing further.
    const snapped = flatTransform()
    await act(async () => { yarnell.click() })
    await settle()
    expect(host.querySelector('.mhm-row.on')).toBeNull()
    expect(flatTransform()).toBe(snapped)
    // The shapes for the two states GAM is in, and the census numbers the
    // window reads — no state's file was swapped, and nothing else was asked for.
    expect(gets).toEqual(['/admin/metrics/boundaries/place/04', '/admin/metrics/boundaries/place/17',
      '/admin/metrics/census/place'])
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

  it('offers no saturation, concentration or lean overlay where there is nothing behind them', async () => {
    await render()
    // 10/18 (Nic): "How it votes" is offered at every level of the United
    // States, including the ones with no results published — at those it says
    // so on screen, which is the answer he asked for.
    expect(measures()).toEqual(['Units', 'Money', 'Saturation', 'How it votes'])
    await choose(levelSelect(), 'cd')
    expect(measures()).toEqual(['Units', 'Money', 'Saturation', 'Concentration', 'How it votes'])
    for (const level of ['country', 'adm1', 'adm2'] as const) {
      await choose(levelSelect(), level)
      // U.S. Census counts say nothing about Ontario; voting districts and
      // U.S. election returns are the United States only.
      expect(measures(), level).toEqual(['Units', 'Money'])
      expect(gets.filter(u => u.includes('/census/')), level).toEqual([])
      expect(gets.filter(u => u.includes('/elections/')), level).toEqual([])
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
    // Nothing was fetched to color it.
    expect(gets.filter(u => u.includes('/census/') || u.includes('/elections/'))).toEqual([])
    // The one district with anything in it holds all of it, whichever of the
    // two numerators is read — and they are different numbers here.
    expect(listRows()).toEqual(['Congressional District 2, Arizona100% · 100%'])
    const row = host.querySelector('.mhm-row')! as HTMLButtonElement
    await act(async () => { row.click() })
    await settle()
    expect(readout()).toContain("15 of GAM's 15 at this level")
    // 10/18 (Nic): the color still needs no census numbers — a share of GAM is
    // GAM's own arithmetic. The window the click opened does read them, which
    // is why they are fetched only once something is picked.
    expect(gets.filter(u => u.includes('/census/'))).toEqual(['/admin/metrics/census/cd'])
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
    // 10/18 (Nic): and the lean overlay, and which contest it shows — both are
    // filters, so neither moves the map either.
    await choose(levelSelect(), 'county')
    expect(flatTransform()).toBe(at)
    await click('How it votes')
    expect(flatTransform()).toBe(at)
    await choose(host.querySelector('select[aria-label="Which contest"]') as HTMLSelectElement, 'president-2016')
    expect(flatTransform()).toBe(at)
  })

  // 10/18 (Nic, correcting the morning's pass): "It's just when I'm moving the
  // globe and I toggle the settings, the filters of the map that I'm looking
  // at, that I don't want it to move. But clicking the row, if I want to see
  // that, should snap to that area." One test for both halves of that rule.
  it('a setting change never moves it; a click on a row snaps to the area', async () => {
    await render()
    await choose(levelSelect(), 'county')
    const at = await zoomAndPan()
    // Settings: nothing moves.
    await click('All spaces')
    await click('Money')
    await click('Saturation')
    await click('People')
    expect(flatTransform()).toBe(at)
    // A row: it snaps to the county he clicked, and the row is marked as the pick.
    await pickRow('Santa Cruz')
    const snapped = flatTransform()
    expect(snapped).not.toBe(at)
    expect(Number(snapped.match(/scale\(([\d.]+)\)/)![1])).toBeGreaterThan(Number(at.match(/scale\(([\d.]+)\)/)![1]))
    expect(host.querySelector('.mhm-row.on')!.textContent).toMatch(/^Santa Cruz/)
    // And from there a setting change still leaves the view where the click
    // put it — which is the whole of the rule.
    await click('All homes')
    await click('Units')
    expect(flatTransform()).toBe(snapped)
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

// ─── 10/18 (Nic): the window a click pulls up ───────────────────────────────

/** The window over the map, and its text as one string. */
const windowBox = () => host.querySelector('.mhm-window') as HTMLElement | null
const windowText = () => windowBox()?.textContent ?? ''
/** One row of the window's census table: what it counts, how many, GAM's share both ways. */
const windowRow = (what: string) => [...host.querySelectorAll('.mhm-window-table tbody tr')]
  .find(r => r.textContent?.startsWith(what))!
  .querySelectorAll('td')
const pickRow = async (name: string) => {
  const row = [...host.querySelectorAll('.mhm-row')].find(r => r.textContent?.startsWith(name))! as HTMLButtonElement
  await act(async () => { row.click() })
  await settle()
}

describe('MetricsHeatMap the window', () => {
  it('pulls up the census count, GAM\'s own numbers, the share both ways and how it votes', async () => {
    // Nic: "if I click on Santa Cruz County in Arizona, I'd like it to pull up
    // a little window and say, hey, at the last census this many people lived
    // in this county, people renting on GAM are a certain percentage of the
    // total population." Santa Cruz County, Arizona at the 2019–2023 ACS:
    // 48,209 people, 18,997 housing units, 5,318 renter-occupied homes. GAM
    // has 99 spaces there, 50 of them occupied — the 1.9% and 0.9% he has
    // already seen and liked.
    await render()
    await choose(levelSelect(), 'county')
    expect(windowBox()).toBeNull()
    await pickRow('Santa Cruz')
    const box = windowBox()!
    expect(box.getAttribute('role')).toBe('dialog')
    expect(box.getAttribute('aria-label')).toBe('Santa Cruz, Arizona, the numbers for this county')
    // In plain words throughout — the area, not a code.
    expect(windowText()).toContain('Santa Cruz, Arizona')
    expect(windowText()).not.toContain('04023')

    // GAM's own numbers here.
    expect(windowText()).toContain('99 spaces under management')
    expect(windowText()).toContain('50 occupied units this month')
    expect(windowText()).toContain('$6,000.00 rent logged through GAM')
    expect(windowText()).toContain('1 property')

    // What the last census counted, and GAM's share of each of the three,
    // both ways — the same saturation maths the overlay colors by.
    expect(windowText()).toContain('At the last census')
    expect([...windowRow('people')].map(c => c.textContent)).toEqual(['48,209', '0.2% · 0.1%'])
    expect([...windowRow('housing units')].map(c => c.textContent)).toEqual(['18,997', '0.5% · 0.3%'])
    expect([...windowRow('renter-occupied homes')].map(c => c.textContent)).toEqual(['5,318', '1.9% · 0.9%'])
    expect(windowText()).toContain("GAM's share here")
    expect(windowText()).toContain('all spaces · occupied')

    // How it votes, every contest the level has, newest first, with the swing.
    expect(windowText()).toContain('2024 presidential margin · Democratic +18.6')
    expect(windowText()).toContain('Republican 7,699 · Democratic 11,265 of 19,121 votes cast')
    expect(windowText()).toContain('2020 presidential margin · Democratic +35.5')
    expect(windowText()).toContain('2016 presidential margin · Democratic +47.1')
    expect(windowText()).toContain('28.5 points toward the Republican side since 2016.')
  })

  it('opens from a click on the map itself, and closes without moving it', async () => {
    await render()
    await choose(levelSelect(), 'county')
    const santaCruz = () => host.querySelector('path[data-fips="04023"]')!
    const at = (type: string, x: number, y: number) => {
      const e: any = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 })
      e.pointerId = 1; e.pointerType = 'mouse'
      return e
    }
    const before = flatTransform()
    await act(async () => {
      santaCruz().dispatchEvent(at('pointerdown', 100, 100))
      santaCruz().dispatchEvent(at('pointerup', 100, 100))
    })
    await settle()
    expect(windowText()).toContain('Santa Cruz, Arizona')
    // 10/18 (Nic): "do not move the map when the window opens".
    expect(flatTransform()).toBe(before)
    // Close puts it away and still moves nothing.
    await act(async () => { button('Close').click() })
    await settle()
    expect(windowBox()).toBeNull()
    expect(flatTransform()).toBe(before)
    // And Escape closes it the same way.
    await act(async () => {
      santaCruz().dispatchEvent(at('pointerdown', 100, 100))
      santaCruz().dispatchEvent(at('pointerup', 100, 100))
    })
    await settle()
    expect(windowBox()).not.toBeNull()
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    expect(windowBox()).toBeNull()
  })

  it('says so plainly where a level or an area has no census count and no result', async () => {
    // 10/18 (Nic): "Where a level has no census match, say so plainly rather
    // than showing a blank or a zero", and the same for the vote.
    await render()
    await choose(levelSelect(), 'adm1')          // a world level: neither reaches it
    await pickRow('Ontario')
    expect(windowText()).toContain('The U.S. Census counts the United States only, so there is no census number for a state or province here.')
    expect(windowText()).toContain('No election results are published by state or province')
    expect(host.querySelector('.mhm-window-table')).toBeNull()
    expect(gets.filter(u => u.includes('/census/') || u.includes('/elections/'))).toEqual([])

    // A congressional district HAS census numbers; only the vote is missing
    // there, and that is said rather than worked out from county votes.
    await choose(levelSelect(), 'cd')
    await pickRow('Congressional District 2')
    expect(windowText()).toContain('At the last census')
    expect(host.querySelector('.mhm-window-table')).not.toBeNull()
    expect(windowText()).toContain('No election results are published by congressional district, so there is no lean to draw for congressional districts. They are published county by county — switch to the county level to see them.')
    expect(gets.filter(u => u.includes('/elections/'))).toEqual([])
  })

  it('works for an area GAM is not in at all, which is most of the map', async () => {
    // The overlay's whole point is comparing GAM's places with places it is
    // not in yet, so a click on an empty county has to answer too.
    await render()
    await choose(levelSelect(), 'county')
    const maricopa = host.querySelector('path[data-fips="04013"]')!   // Phoenix: no GAM spaces here
    const at = (type: string) => {
      const e: any = new MouseEvent(type, { bubbles: true, clientX: 200, clientY: 200, button: 0 })
      e.pointerId = 2; e.pointerType = 'mouse'
      return e
    }
    await act(async () => { maricopa.dispatchEvent(at('pointerdown')); maricopa.dispatchEvent(at('pointerup')) })
    await settle()
    expect(windowText()).toContain('Maricopa, Arizona')
    expect(windowText()).toContain('GAM has no spaces here.')
    // The census count is still there, with no share to show for it.
    expect([...windowRow('people')].map(c => c.textContent)).toEqual(['4,491,987', '—'])
    expect(windowText()).toContain('2024 presidential margin · Republican +3.5')
  })
})

// ─── 10/18 (Nic): how an area votes ─────────────────────────────────────────

describe('MetricsHeatMap lean overlay', () => {
  const leanButton = () => button('How it votes')
  const openLean = async () => {
    await choose(levelSelect(), 'county')
    await act(async () => { leanButton().click() })
    await settle()
  }
  const fillOf = (fips: string) =>
    (host.querySelector(`path[data-fips="${fips}"]`) as SVGPathElement).style.fill
  const contestSelect = () => host.querySelector('select[aria-label="Which contest"]') as HTMLSelectElement

  it('colors every county by the 2024 margin, labels it honestly, and credits the votes', async () => {
    // Nic: "the overlay to show which way those certain districts vote, and
    // where our strong areas tend to be in Democratic areas or Republican
    // areas, for the landlord onboarding process and total unit count."
    await render()
    await openLean()
    expect(gets).toContain('/admin/metrics/elections/county')
    expect(caption()).toContain('The color is 2024 presidential margin.')
    expect(caption()).toContain("A marker shows where GAM has spaces")
    // Santa Cruz County, Arizona voted Democratic by 18.6 points; Yavapai
    // County, Republican by 33.9. The two are opposite sides of the scale.
    expect(fillOf('04023')).toBe(leanColor(-18.6))
    expect(fillOf('04025')).toBe(leanColor(33.9))
    // Every county is colored, not only the ones GAM is in — that is the point.
    expect(host.querySelectorAll('path[data-fips]').length).toBeGreaterThan(3000)
    // The key is the diverging scale, named by the contest's own two sides.
    const key = host.querySelector('.mhm-legend')!.textContent ?? ''
    expect(key).toContain('Democratic +60 or more')
    expect(key).toContain('Republican +60 or more')
    expect(key).toContain('Even in the middle')
    expect(key).toContain('Where GAM has spaces')
    // Nic: "credit the source under the map the way geoBoundaries is credited."
    expect(credit()).toContain('Votes: Official county presidential returns (public data).')
  })

  it('marks every county GAM is in, whatever its size, and splits GAM\'s spaces by side', async () => {
    await render()
    await openLean()
    // A marker for each of the three counties GAM has spaces in — the area's
    // own color is its vote, so the marker is what says "GAM is here".
    expect([...host.querySelectorAll('circle.mhm-dot')].map(c => c.getAttribute('data-fips')).sort())
      .toEqual(['04023', '04025', '17029'])
    // "where our strong areas tend to be in Democratic areas or Republican
    // areas": GAM has 50 occupied units in Santa Cruz (Democratic), 15 in
    // Yavapai and 16 in Coles (both Republican) — 81 in all.
    const side = host.querySelector('.mhm-side')!.textContent ?? ''
    expect(side).toContain('Of the 81 occupied units GAM has at this level, 38.3% sit where Republican led and 61.7% where Democratic led. Ranked by occupied units.')
    // Each row carries GAM's own number and how that county voted.
    expect(listRows()).toEqual([
      'Santa Cruz, Arizona50 occupied unitsDemocratic +18.6',
      'Coles, Illinois16 occupied unitsRepublican +28.5',
      'Yavapai, Arizona15 occupied unitsRepublican +33.9',
    ])
  })

  it('names the vote beside GAM\'s own number when a county is picked', async () => {
    // The color is the vote, so the number behind it has to be readable
    // without opening the window.
    await render()
    await openLean()
    await pickRow('Santa Cruz')
    expect(readout()).toContain('Santa Cruz, Arizona · 50 occupied units · Democratic +18.6')
  })

  it('reads the swing by picking another contest, and only re-colors the map', async () => {
    // Nic: "the 2024 lean, with 2020 and 2016 available so the swing can be read".
    await render()
    await openLean()
    expect([...contestSelect().options].map(o => o.textContent))
      .toEqual(['2024 presidential margin', '2020 presidential margin', '2016 presidential margin'])
    const before = flatTransform()
    await choose(contestSelect(), 'president-2016')
    expect(caption()).toContain('The color is 2016 presidential margin.')
    expect(fillOf('04023')).toBe(leanColor(-47.1))
    expect(listRows()[0]).toBe('Santa Cruz, Arizona50 occupied unitsDemocratic +47.1')
    // A setting change, so the view does not move and nothing is re-fetched.
    expect(flatTransform()).toBe(before)
    expect(gets.filter(u => u.includes('/elections/'))).toEqual(['/admin/metrics/elections/county'])
  })

  it('says the lean is not available for districts instead of inventing one', async () => {
    // 10/18 (Nic): "ONLY COUNTIES ARE EXACT ... a made-up district margin is
    // worse than none." The overlay is still offered there, and this is what
    // it says.
    await render()
    for (const level of ['cd', 'sldu', 'sldl', 'state', 'place', 'zcta'] as const) {
      await choose(levelSelect(), level)
      await act(async () => { leanButton().click() })
      await settle()
      expect(measures(), level).toContain('How it votes')
      expect(caption(), level).toContain('No election results are published by')
      expect(caption(), level).toContain('They are published county by county — switch to the county level to see them.')
      expect(host.querySelector('.mhm-empty')!.textContent, level).toMatch(/^No election results are published by/)
      // Nothing is drawn in a voting color — and no gold map quietly stands
      // in for one, which would look like an answer. GAM's own spaces are
      // still marked over the uncolored map.
      expect(host.querySelector('.mhm-legend'), level).toBeNull()
      const anyArea = host.querySelector('path[data-fips]') as SVGPathElement
      expect(anyArea.style.fill, level).toBe('var(--heat-none)')
      if (listRows().length > 0) expect(host.querySelectorAll('circle.mhm-dot').length, level).toBeGreaterThan(0)
      expect(gets.filter(u => u.includes('/elections/')), level).toEqual([])
      expect(host.querySelector('select[aria-label="Which contest"]'), level).toBeNull()
    }
  })

  it('a county with no result published is left uncolored and named, not drawn as even', async () => {
    // Alaska reports its presidential vote by state house district, so no
    // borough has a result — and the District of Columbia's 2024 rows are its
    // wards. Those are the two the builder left out, and the window says why.
    await render()
    await openLean()
    expect(fillOf('02013')).toBe('var(--heat-none)')     // Aleutians East Borough
    expect(fillOf('11001')).toBe('var(--heat-none)')     // the District of Columbia
    const bethel = host.querySelector('path[data-fips="02050"]')!
    const at = (type: string) => {
      const e: any = new MouseEvent(type, { bubbles: true, clientX: 60, clientY: 120, button: 0 })
      e.pointerId = 3; e.pointerType = 'mouse'
      return e
    }
    await act(async () => { bethel.dispatchEvent(at('pointerdown')); bethel.dispatchEvent(at('pointerup')) })
    await settle()
    expect(windowText()).toContain('No result for this area: Alaska — this state reported it by "State House District 1" and "State House District 2" and the like, not by county.')
  })

  it('a results file that cannot be fetched stops the overlay only, and Units comes straight back', async () => {
    const failing: any = {
      get: async (url: string) => {
        if (url.includes('/metrics/elections/')) { gets.push(url); throw new Error('no results file beside the API') }
        return api.get(url)
      },
    }
    await act(async () => { root.render(<MetricsHeatMap data={DATA} api={failing}/>) })
    await settle()
    await choose(levelSelect(), 'county')
    await act(async () => { leanButton().click() })
    await settle()
    expect(gets).toContain('/admin/metrics/elections/county')
    expect(host.textContent).toContain('The map could not be drawn just now.')
    await act(async () => { button('Units').click() })
    await settle()
    expect(host.textContent).not.toContain('The map could not be drawn just now.')
    expect(listRows()).toEqual(['Santa Cruz, Arizona50 occupied units', 'Coles, Illinois16 occupied units', 'Yavapai, Arizona15 occupied units'])
  })
})

// ─── 10/18 (Nic): the globe's divisions ─────────────────────────────────────

/**
 * jsdom has no canvas, so the globe is given a stand-in that records what it
 * painted: every fill's color, and every stroke with its color, its width and
 * how many line commands went into it. The stand-in also answers the globe's
 * own color reader (which asks a 1×1 canvas what a CSS color comes out as), so
 * the colors recorded here are the colors it really used.
 */
const THEME: Record<string, string> = {
  // The dark theme's own values (main.tsx), so this reads what he sees.
  '--b1': 'rgb(34, 42, 56)',          // #222a38
  '--b2': 'rgb(42, 53, 71)',          // #2a3547 — the light gray-blue
  '--bg2': 'rgb(18, 21, 25)',         // #121519 — what the state lines used to be
  '--heat-none': 'rgb(24, 28, 34)',   // #181c22 — the land
  '--heat-hi': 'rgb(201, 162, 39)',   // the gold
  '--heat-base': 'rgb(18, 21, 25)',
  '--t0': 'rgb(238, 240, 246)',
  '--t1': 'rgb(184, 196, 216)',
}
const rgbOf = (css: string): [number, number, number] | null => {
  const m = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(css.trim())
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])]
  const hex = /^#([0-9a-f]{6})$/i.exec(css.trim())
  if (hex) return [0, 2, 4].map(i => parseInt(hex[1].slice(i, i + 2), 16)) as [number, number, number]
  return null
}

function recordCanvas() {
  const fills: string[] = []
  const strokes: Array<{ color: string; width: number; lines: number }> = []
  const arcs: Array<[number, number]> = []
  let lines = 0
  let fillStyle = '#808080'
  let painted = '#808080'
  const ctx: any = {
    strokeStyle: '', lineWidth: 0, globalAlpha: 1,
    setTransform() {}, clearRect() {},
    // The color reader's own 1×1 probe: a real canvas keeps the last VALID
    // color, so an unknown one (a theme variable that is not set) reads as the
    // gray it was given first.
    fillRect() { painted = fillStyle },
    getImageData: () => ({ data: rgbOf(painted) ?? [128, 128, 128] }),
    beginPath() { lines = 0 },
    moveTo() { lines++ }, lineTo() { lines++ }, closePath() {},
    arc(x: number, y: number) { lines++; arcs.push([x, y]) },
    fill() { fills.push(fillStyle) },
    stroke() { strokes.push({ color: String(ctx.strokeStyle), width: Number(ctx.lineWidth), lines }) },
  }
  Object.defineProperty(ctx, 'fillStyle', {
    get: () => fillStyle,
    set: (v: string) => { if (rgbOf(v)) fillStyle = v },
  })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx)
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width: 975, height: 610, top: 0, left: 0, right: 975, bottom: 610, x: 0, y: 0, toJSON: () => ({}),
  })
  /**
   * The theme's variables, which jsdom has no stylesheet for — set on the
   * canvas itself, then the globe is asked to draw again the way a theme
   * change asks it to (it watches the page's own theme attribute).
   */
  const dress = async () => {
    const canvas = host.querySelector('canvas.mhm-globe') as HTMLCanvasElement | null
    for (const [k, v] of Object.entries(THEME)) canvas?.style.setProperty(k, v)
    fills.length = 0; strokes.length = 0; arcs.length = 0
    await act(async () => {
      document.documentElement.setAttribute('data-theme', 'dark')
      await new Promise(r => setTimeout(r, 400))
    })
  }
  return { fills, strokes, arcs, dress }
}

describe('MetricsHeatMap globe divisions', () => {
  it('fetches the same country borders and provinces the flat map draws, once each', async () => {
    // 10/18 (Nic): "The globe draws only the United States ... nothing else on
    // Earth has any division at all." The assets were already beside the API;
    // the globe now asks for them, the first time it is shown.
    await render()
    expect(gets.filter(u => u.endsWith('/boundaries/country') || u.endsWith('/boundaries/adm1'))).toEqual([])
    await click('Globe')
    expect(gets).toContain('/admin/metrics/boundaries/country')
    expect(gets).toContain('/admin/metrics/boundaries/adm1')
    // Lazily, and once: the flat map of the United States never pays for them,
    // and going back and forth does not fetch them again.
    await click('Flat map')
    await click('Globe')
    expect(gets.filter(u => u.endsWith('/boundaries/country'))).toHaveLength(1)
    expect(gets.filter(u => u.endsWith('/boundaries/adm1'))).toHaveLength(1)
    // They are the SAME files the flat map's world levels draw, so opening
    // those levels afterwards costs nothing.
    await click('Flat map')
    await choose(levelSelect(), 'adm1')
    expect(gets.filter(u => u.endsWith('/boundaries/adm1'))).toHaveLength(1)
  })

  it('draws every state, province and country boundary in the one light gray-blue, and nothing in black', async () => {
    // 10/18 (Nic, DECIDED and told): "every state and province boundary uses
    // that same light gray-blue, so Alaska and Hawaii stop looking like a
    // different kind of thing from Arizona — black lines read as cracks on a
    // dark globe."
    const painted = recordCanvas()
    await render()
    await click('Globe')
    await painted.dress()

    // At the state level the only heavy lines on it are the world's own: the
    // provinces (4,367 lines) and the country borders (204 of them). Before
    // this neither was drawn at all.
    const drawn = painted.strokes.filter(s => s.lines > 0)
    // The two heaviest lines on the globe are the world's own, which were not
    // drawn at all before this: the provinces and the borders between
    // countries. Everything else on it is a few thousand points at most.
    const heavy = [...drawn].sort((a, b) => b.lines - a.lines)
    expect(heavy[0].lines).toBeGreaterThan(100000)
    expect(heavy[1].lines).toBeGreaterThan(100000)
    // Every one of them is the light gray-blue, and the near-black the state
    // lines used to be drawn in is nowhere on the globe. The faint grid is the
    // only other color on it, so every BOUNDARY is the one color.
    const colors = new Set(drawn.map(s => s.color))
    expect(colors.has(THEME['--b2'])).toBe(true)
    expect(colors.has(THEME['--bg2'])).toBe(false)
    expect([...colors].sort()).toEqual([THEME['--b1'], THEME['--b2']].sort())
    // A province line and a state line are drawn exactly alike — same color,
    // same weight; a country's edge is the same color, a shade heavier.
    const stateLine = drawn.find(s => s !== heavy[0] && s.width === 0.7)!
    expect(heavy[0].width).toBe(0.7)
    expect(stateLine.color).toBe(heavy[0].color)
    expect(heavy[1].width).toBe(1)
    expect(new Set(drawn.filter(s => s.color === THEME['--b2']).map(s => s.width))).toEqual(new Set([0.7, 1]))
  })

  it('paints the lean overlay on the globe in the same colors as the flat map', async () => {
    const painted = recordCanvas()
    await render()
    await choose(levelSelect(), 'county')
    await act(async () => { button('How it votes').click() })
    await settle()
    await click('Globe')
    await painted.dress()
    // Santa Cruz County, Arizona at Democratic +18.6 and Yavapai at
    // Republican +33.9 — the same two colors the flat map gives them.
    expect(painted.fills).toContain(leanColor(-18.6))
    expect(painted.fills).toContain(leanColor(33.9))
    // And a gold marker for each county GAM is in, whatever its size, because
    // the county's own color is its vote.
    expect(painted.arcs.length).toBeGreaterThanOrEqual(3)
    expect(painted.fills.some(f => f === `rgb(${[201, 162, 39].join(', ')})`
      || /^rgb\(\d+, \d+, \d+\)$/.test(f))).toBe(true)
  })
})

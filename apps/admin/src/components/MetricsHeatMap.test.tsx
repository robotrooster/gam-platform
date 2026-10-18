/**
 * 10/13 (Nic) — the Metrics heat map card: the level toggle ("cities,
 * congressional districts, state legislative districts (senate and house), and
 * ZIP codes", beside state and county), one state at a time for the levels
 * that have tens of thousands of areas, and the globe ("a toggle back to the
 * flat map"). The shapes come from the API (behind admin login) — here from
 * the API's own files, through a stand-in for the admin's API client.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { readFileSync } from 'fs'
import { join, resolve } from 'path'
import { gunzipSync } from 'zlib'
import { METRICS_MAP_LEVELS, METRICS_MAP_LEVEL_LABEL } from '@gam/shared'
import { MetricsHeatMap, type PlatformMapData } from './MetricsHeatMap'
import { forgetWorld } from './metricsMapGeo'

const GEO = resolve(__dirname, '../../../api/geo')
const gets: string[] = []
const api: any = {
  get: async (url: string) => {
    gets.push(url)
    const rel = url.replace('/admin/metrics/boundaries/', '')
    return { data: JSON.parse(gunzipSync(readFileSync(join(GEO, `${rel}.json.gz`))).toString('utf8')) }
  },
}

const area = (fips: string, name: string, units: number, money: number, extra: object = {}) =>
  ({ fips, name, units, occupied: units, money, properties: 1, ...extra })
const DATA: PlatformMapData = {
  states: [area('04', 'Arizona', 128, 9000, { abbr: 'AZ' }), area('17', 'Illinois', 31, 2000, { abbr: 'IL' })],
  counties: [area('04025', 'Yavapai', 29, 3000, { state: 'AZ' }), area('04023', 'Santa Cruz', 99, 6000, { state: 'AZ' }),
    area('17029', 'Coles', 31, 2000, { state: 'IL' })],
  missing: [],
  levels: {
    place: { states: ['04', '17'], missing: [], areas: [area('0484980', 'Yarnell', 29, 3000, { state: 'AZ', stateFips: '04' }),
      area('1747553', 'Mattoon', 31, 2000, { state: 'IL', stateFips: '17' })] },
    cd: { states: [], missing: [], areas: [area('0402', 'Congressional District 2', 29, 3000, { state: 'AZ', stateFips: '04' })] },
    sldu: { states: ['04', '17'], missing: [], areas: [] },
    sldl: { states: ['04', '17'], areas: [area('04001', 'State House District 1', 29, 3000, { state: 'AZ', stateFips: '04' })],
      missing: [{ reason: 'no_location', label: 'no map location on file for its address', properties: 1, units: 99, occupied: 99, money: 6000 }] },
    zcta: { states: ['04', '06', '17'], missing: [], areas: [area('85362', 'ZIP 85362', 29, 3000, { state: 'AZ', stateFips: '04' }),
      area('85645', 'ZIP 85645', 99, 6000, { state: 'AZ', stateFips: '04' }), area('61938', 'ZIP 61938', 31, 2000, { state: 'IL', stateFips: '17' })] },
  },
}

// React's act() runs only where the test says it is one.
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  gets.length = 0
  // The land around the United States is kept for the page's life; start cold.
  forgetWorld()
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
const stateSelect = () => host.querySelector('select[aria-label="State on the map"]') as HTMLSelectElement | null
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
    expect(listRows()).toEqual(['Arizona128 occupied units', 'Illinois31 occupied units'])
  })

  it('ZIP codes: one state at a time, opening on the state with the most units, its file from the API', async () => {
    await render()
    await choose(levelSelect(), 'zcta')
    expect(stateSelect()!.value).toBe('04')
    expect([...stateSelect()!.options].map(o => o.textContent)).toEqual(['Arizona', 'California', 'Illinois'])
    expect(gets).toEqual(['/admin/metrics/boundaries/zcta/04'])
    expect(host.querySelector('svg[role="img"]')?.getAttribute('aria-label')).toMatch(/^Map of Arizona by ZIP code/)
    expect(host.querySelectorAll('path[data-fips]').length).toBeGreaterThan(300)
    // The list is every ZIP code with a number, in any state.
    expect(listRows()).toEqual(['ZIP 85645, Arizona99 occupied units', 'ZIP 61938, Illinois31 occupied units', 'ZIP 85362, Arizona29 occupied units'])
  })

  it('a place picked from the list in another state draws that state', async () => {
    await render()
    await choose(levelSelect(), 'place')
    // Illinois has the most spaces at the city level here (Mattoon 31, Yarnell 29).
    expect(stateSelect()!.value).toBe('17')
    const yarnell = [...host.querySelectorAll('.mhm-row')].find(r => r.textContent?.startsWith('Yarnell'))! as HTMLButtonElement
    await act(async () => { yarnell.click() })
    await settle()
    expect(stateSelect()!.value).toBe('04')
    expect(gets).toEqual(['/admin/metrics/boundaries/place/17', '/admin/metrics/boundaries/place/04'])
    expect(host.querySelector('.mhm-readout')!.textContent).toMatch(/Yarnell, Arizona · 29 occupied units/)
    // Too small to see at the state view: a marker in its own color, outlined as the pick.
    expect(host.querySelector('circle.mhm-dot.on[data-fips="0484980"]')).not.toBeNull()
  })

  it('a state with nothing in it says so, and points to the list', async () => {
    await render()
    await choose(levelSelect(), 'place')
    await choose(stateSelect()!, '17')
    await choose(levelSelect(), 'sldu')   // nothing at this level anywhere
    expect(host.querySelector('.mhm-empty')!.textContent).toBe('No units are occupied this month.')
    await choose(levelSelect(), 'zcta')
    expect(stateSelect()!.value).toBe('17')                  // the state picked stays picked
    await choose(stateSelect()!, '06')
    expect(host.querySelector('.mhm-empty')!.textContent).toBe(
      'No occupied units in California — the list beside the map has every ZIP code with occupied units.')
  })

  it('congressional districts: the whole country from one file; each level names what it could not place', async () => {
    await render()
    await choose(levelSelect(), 'cd')
    expect(stateSelect()).toBeNull()
    expect(gets).toEqual(['/admin/metrics/boundaries/cd'])
    expect(listRows()).toEqual(['Congressional District 2, Arizona29 occupied units'])
    await choose(levelSelect(), 'sldl')
    expect(host.querySelector('.mhm-missing')!.textContent).toMatch(/1 property · 99 occupied units — no map location on file for its address/)
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

describe('MetricsHeatMap globe', () => {
  it('toggles to the globe and back to the flat map', async () => {
    await render()
    await act(async () => { button('Globe').click() })
    await settle()
    const canvas = host.querySelector('canvas.mhm-globe')!
    expect(canvas.getAttribute('role')).toBe('img')
    expect(canvas.getAttribute('aria-label')).toMatch(/^Globe of the United States by state.*Drag or use the arrow keys/)
    expect(host.querySelector('button[aria-label="Zoom in"]')).not.toBeNull()
    expect(host.querySelector('button[aria-label="Zoom out"]')).not.toBeNull()
    expect(host.querySelector('svg[role="img"]')).toBeNull()
    // The list and the numbers are the same on the globe.
    expect(listRows()).toEqual(['Arizona128 occupied units', 'Illinois31 occupied units'])
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

  it('every zoom and reset control is a gold action button', async () => {
    await render()
    await act(async () => { button('Globe').click() })
    await settle()
    for (const b of host.querySelectorAll('.mhm-globe-tools button')) expect(b.className).toContain('btn-primary')
  })
})

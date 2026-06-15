/**
 * S465 — geocoder service coverage.
 *
 * No DB. Mocks fetch (passed in as a stub via the function's second
 * parameter) so we exercise every branch of the response handling
 * without real network calls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { geocode } from './geocoder'

const ADDR = {
  street1: '100 Elm St',
  city: 'Phoenix', state: 'AZ', zip: '85001',
}

beforeEach(() => {
  // Make sure GEOCODER_URL doesn't leak between tests.
  delete process.env.GEOCODER_URL
})

describe('geocode', () => {
  it('happy: returns { lat, lon } from first result', async () => {
    const fakeFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => [{ lat: '33.4484', lon: '-112.0740' }],
    } as any))
    const r = await geocode(ADDR, fakeFetch as any)
    expect(r).toEqual({ lat: 33.4484, lon: -112.0740 })
    expect(fakeFetch).toHaveBeenCalledTimes(1)
    const [url, init] = fakeFetch.mock.calls[0] as any[]
    expect(url).toContain('format=json')
    expect(url).toContain('limit=1')
    expect(decodeURIComponent(url)).toContain('100 Elm St, Phoenix, AZ, 85001')
    expect(init.headers['User-Agent']).toContain('GoldAssetManagement')
  })

  it('respects GEOCODER_URL env override', async () => {
    process.env.GEOCODER_URL = 'https://nominatim.internal.gam/search'
    const fakeFetch = vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => [{ lat: '33.0', lon: '-112.0' }],
    } as any))
    await geocode(ADDR, fakeFetch as any)
    const [url] = fakeFetch.mock.calls[0] as any[]
    expect(url).toMatch(/^https:\/\/nominatim\.internal\.gam\/search/)
  })

  it('non-200 response → null', async () => {
    const fakeFetch = vi.fn(async () => ({
      ok: false, status: 503,
      json: async () => ({}),
    } as any))
    const r = await geocode(ADDR, fakeFetch as any)
    expect(r).toBeNull()
  })

  it('empty array response → null', async () => {
    const fakeFetch = vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => [],
    } as any))
    const r = await geocode(ADDR, fakeFetch as any)
    expect(r).toBeNull()
  })

  it('non-array response → null', async () => {
    const fakeFetch = vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ unexpected: 'shape' }),
    } as any))
    const r = await geocode(ADDR, fakeFetch as any)
    expect(r).toBeNull()
  })

  it('malformed coords (NaN) → null', async () => {
    const fakeFetch = vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => [{ lat: 'not-a-number', lon: '-112.0' }],
    } as any))
    const r = await geocode(ADDR, fakeFetch as any)
    expect(r).toBeNull()
  })

  it('fetch throws → null (network error swallowed)', async () => {
    const fakeFetch = vi.fn(async () => { throw new Error('ECONNREFUSED') })
    const r = await geocode(ADDR, fakeFetch as any)
    expect(r).toBeNull()
  })

  it('street2 is intentionally OMITTED from the query string', async () => {
    const fakeFetch = vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => [{ lat: '33', lon: '-112' }],
    } as any))
    await geocode({
      ...ADDR, street2: 'Apt 5B',
    }, fakeFetch as any)
    const [url] = fakeFetch.mock.calls[0] as any[]
    expect(decodeURIComponent(url)).not.toContain('Apt 5B')
  })
})

import { describe, it, expect } from 'vitest'
import { AUTO_PLACE_ESTIMATE, autoPlaceTimeoutMs } from './autoPlaceEstimate'

describe('auto-place wait messaging', () => {
  // Nic's wording: a couple of minutes, ceiling of five. Same for every
  // document — no per-page arithmetic, nothing scoped to one property's lease.
  it('states a rough expectation and a ceiling', () => {
    expect(AUTO_PLACE_ESTIMATE).toBe('usually a couple of minutes, and rarely more than five')
  })

  it('carries no page count — the copy is identical for every document', () => {
    expect(AUTO_PLACE_ESTIMATE).not.toMatch(/\d+\s*pages?/)
    expect(AUTO_PLACE_ESTIMATE).not.toMatch(/seconds/)
  })
})

describe('autoPlaceTimeoutMs', () => {
  // A flat cap is what threw away a finished 8-page placement: the job took
  // 1m42s, the client gave up at 4m for unrelated reasons, and 69 placed fields
  // went in the bin. The cap must always sit well clear of the real work.
  it('never cuts off a document that is still working', () => {
    for (const pages of [1, 8, 20, 40, 120]) {
      const realWorkMs = pages * 13_000
      expect(autoPlaceTimeoutMs(pages)).toBeGreaterThan(realWorkMs * 2)
    }
  })

  it('grows with the document and floors at five minutes', () => {
    expect(autoPlaceTimeoutMs(1)).toBe(300_000)
    expect(autoPlaceTimeoutMs(8)).toBe(540_000)
    expect(autoPlaceTimeoutMs(40)).toBe(2_460_000)
    expect(autoPlaceTimeoutMs(8)).toBeLessThan(autoPlaceTimeoutMs(20))
  })

  it('falls back to a sane cap when the page count is unknown', () => {
    for (const v of [0, null, undefined, NaN]) {
      expect(autoPlaceTimeoutMs(v as any)).toBe(540_000)
    }
  })
})

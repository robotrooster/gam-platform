/**
 * 10/13 (Nic) — the Rent Roll's range: "custom ranges per property with pre
 * populated quick select buttons" — Last month · This quarter · Last quarter ·
 * This year · Last year · All time, plus a custom start/end month range. One
 * view for every property: it rides in the page's address.
 */
import { describe, it, expect } from 'vitest'
import {
  RANGE_PICKS, RANGE_PICK_LABEL, DEFAULT_RANGE_PICK, addMonths, rangeOfPick, viewFromParams, withViewParams, isRangePick,
  historyPath, rangeKey, monthChoices, customRange,
} from './rentRollRange'

describe('the quick picks', () => {
  it('are Nic’s six, in his order', () => {
    expect(RANGE_PICKS.map(p => RANGE_PICK_LABEL[p])).toEqual(['Last month', 'This quarter', 'Last quarter', 'This year', 'Last year', 'All time'])
    expect(DEFAULT_RANGE_PICK).toBe('last_month')
  })

  it('cover calendar months and quarters, judged on today', () => {
    const today = '2026-10-13'
    expect(rangeOfPick('last_month', today)).toEqual({ all: false, from: '2026-09', to: '2026-09' })
    expect(rangeOfPick('this_quarter', today)).toEqual({ all: false, from: '2026-10', to: '2026-10' })
    expect(rangeOfPick('last_quarter', today)).toEqual({ all: false, from: '2026-07', to: '2026-09' })
    expect(rangeOfPick('this_year', today)).toEqual({ all: false, from: '2026-01', to: '2026-10' })
    expect(rangeOfPick('last_year', today)).toEqual({ all: false, from: '2025-01', to: '2025-12' })
    expect(rangeOfPick('all', today)).toEqual({ all: true })
  })

  it('reach back across the new year in January', () => {
    const today = '2027-01-05'
    expect(rangeOfPick('last_month', today)).toEqual({ all: false, from: '2026-12', to: '2026-12' })
    expect(rangeOfPick('last_quarter', today)).toEqual({ all: false, from: '2026-10', to: '2026-12' })
    expect(rangeOfPick('this_quarter', today)).toEqual({ all: false, from: '2027-01', to: '2027-01' })
    expect(rangeOfPick('this_quarter', '2026-08-20')).toEqual({ all: false, from: '2026-07', to: '2026-08' })
  })

})

describe('the view in the address', () => {
  const today = '2026-10-13'
  const view = (q: string, t = today) => viewFromParams(new URLSearchParams(q), t)
  const lastMonth = { pick: 'last_month', range: { all: false, from: '2026-09', to: '2026-09' } }

  it('a quick pick by name stays lit and means its words on the day: in January "This year" is not "This quarter"', () => {
    expect(view('range=last_quarter')).toEqual({ pick: 'last_quarter', range: { all: false, from: '2026-07', to: '2026-09' } })
    expect(view('range=all')).toEqual({ pick: 'all', range: { all: true } })
    expect(view('range=this_year', '2027-01-09')).toEqual({ pick: 'this_year', range: { all: false, from: '2027-01', to: '2027-01' } })
    expect(view('range=this_quarter', '2027-01-09').pick).toBe('this_quarter')
    expect(isRangePick('last_year')).toBe(true)
    expect(isRangePick('last_decade')).toBe(false)
  })

  it('a custom range lights no pick; anything the page cannot show opens on the default (Last month)', () => {
    expect(view('from=2026-01&to=2026-03')).toEqual({ pick: null, range: { all: false, from: '2026-01', to: '2026-03' } })
    expect(view('')).toEqual(lastMonth)
    expect(view('range=last_decade')).toEqual(lastMonth)
    expect(view('from=2026-05&to=2026-03')).toEqual(lastMonth)   // backwards
    expect(view('from=2026-13&to=2026-14')).toEqual(lastMonth)   // not months
    expect(view('from=2026-01')).toEqual(lastMonth)              // no end
    expect(view('from=2026-10&to=2026-12')).toEqual(lastMonth)   // the future
  })

  it('writes the view and keeps every other param (the property)', () => {
    const p = withViewParams(new URLSearchParams('property=mv&range=all'), { from: '2026-07', to: '2026-09' })
    expect(p.toString()).toBe('property=mv&from=2026-07&to=2026-09')
    expect(withViewParams(p, 'last_year').toString()).toBe('property=mv&range=last_year')
  })

  it('asks the server for one property and the range', () => {
    expect(historyPath('p1', { all: false, from: '2026-07', to: '2026-09' })).toBe('/balances/rent-roll/history?propertyId=p1&from=2026-07&to=2026-09')
    expect(historyPath('p1', { all: true })).toBe('/balances/rent-roll/history?propertyId=p1&range=all')
    expect(rangeKey({ all: true })).toBe('all')
    expect(rangeKey({ all: false, from: '2026-07', to: '2026-09' })).toBe('2026-07..2026-09')
  })
})

describe('the custom range', () => {
  it('a start after the end moves the end; an end before the start moves the start', () => {
    const cur = { from: '2026-04', to: '2026-06' }
    expect(customRange(cur, 'from', '2026-05')).toEqual({ from: '2026-05', to: '2026-06' })
    expect(customRange(cur, 'from', '2026-08')).toEqual({ from: '2026-08', to: '2026-08' })
    expect(customRange(cur, 'to', '2026-02')).toEqual({ from: '2026-02', to: '2026-02' })
    expect(customRange(cur, 'to', '2026-09')).toEqual({ from: '2026-04', to: '2026-09' })
  })

  it('offers this month back to January five years ago, newest first, and further when the range reaches back', () => {
    const m = monthChoices('2026-10-13')
    expect(m[0]).toBe('2026-10')
    expect(m[m.length - 1]).toBe('2021-01')
    expect(m).toHaveLength(70)
    expect(monthChoices('2026-10-13', '2019-06').slice(-1)[0]).toBe('2019-06')
    expect(addMonths('2026-01', -1)).toBe('2025-12')
    expect(addMonths('2026-11', 3)).toBe('2027-02')
  })
})

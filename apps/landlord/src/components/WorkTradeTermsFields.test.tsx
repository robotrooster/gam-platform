// @vitest-environment jsdom
/**
 * 10/6 (Nic): "Can I mark somebody as work trade through the reservation flow?
 * ... Mark them as work trade. Boom." — the one work-trade picker the invite
 * and the schedule's reservation form share: everything covered by default
 * (untick any), monitored or trusted, hours per the property. And the
 * returning-guest choice beside the background check: greyed with the reason
 * (never a count) when the property's allowance is used up.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { WORK_TRADE_COVERABLE } from '@gam/shared'

vi.mock('../lib/api', () => ({ apiGet: async () => ({}) }))

import {
  WorkTradeTermsFields, defaultWorkTradeTerms, workTradeTermsPayload, workTradeLine, workTradeTermsFrom, workTradeEditPayload, type WorkTradeTerms,
} from './WorkTradeTermsFields'
import { ReturningGuestChoice, RETURNING_GUEST_WORDS } from './ReturningGuestChoice'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host) })
afterEach(() => { act(() => root.unmount()); host.remove() })

let latest: WorkTradeTerms | null = null
function Picker({ hours }: { hours?: number }) {
  const [v, setV] = useState<WorkTradeTerms>(defaultWorkTradeTerms)
  latest = v
  return <WorkTradeTermsFields value={v} onChange={setV} propertyHours={hours ?? null} />
}
const boxes = () => Array.from(host.querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[]
const radios = () => Array.from(host.querySelectorAll('input[type="radio"]')) as HTMLInputElement[]

describe('the work-trade picker', () => {
  it('covers everything by default, monitored, hours tracked at the property\'s setting', () => {
    act(() => root.render(<Picker hours={40} />))
    const covered = boxes().slice(0, WORK_TRADE_COVERABLE.length)
    expect(covered.every(b => b.checked)).toBe(true)
    expect(host.textContent).toContain('Monitored')
    expect(host.textContent).toContain('Trusted')
    expect(radios()[0].checked).toBe(true)
    expect((host.querySelector('input[type="number"]') as HTMLInputElement).placeholder).toBe('property setting (40)')
    expect(workTradeTermsPayload(latest!)).toEqual({
      coveredCharges: [...WORK_TRADE_COVERABLE], tracksHours: true, hoursTarget: null, duties: null, trusted: false,
    })
  })

  it('untick any; pick trusted', () => {
    act(() => root.render(<Picker />))
    act(() => { boxes()[0].click() })        // Rent
    act(() => { radios()[1].click() })       // Trusted
    expect(latest!.coveredCharges).not.toContain('rent')
    expect(latest!.trusted).toBe(true)
    expect(workTradeLine({ coveredCharges: latest!.coveredCharges, trusted: true })).toBe(
      'Work trade — covers: Electric, Water, Sewer, Natural gas, Trash, Propane, Fees, trusted')
  })

  it('reads a stay\'s trade back, and says "everything" when it is', () => {
    const t = workTradeTermsFrom({ coveredCharges: [...WORK_TRADE_COVERABLE], trusted: false, tracksHours: false, monthlyHoursTarget: 20 })
    expect(t).toMatchObject({ tracksHours: false, hoursTarget: '20', trusted: false })
    expect(workTradeLine({ coveredCharges: [...WORK_TRADE_COVERABLE], trusted: false })).toBe('Work trade — covers: everything, monitored')
  })
})

describe('the returning-guest choice', () => {
  it('available: a box to tick', () => {
    const on = vi.fn()
    act(() => root.render(<ReturningGuestChoice offer={{ available: true, free: false, message: null }} checked={false} onChange={on} fee={42.94} />))
    expect(host.textContent).toContain(RETURNING_GUEST_WORDS)
    expect(host.textContent).toContain('$42.94')
    act(() => { boxes()[0].click() })
    expect(on).toHaveBeenCalledWith(true)
  })

  it('used up: greyed with the reason, nothing to tick, never a count', () => {
    const words = 'This property has used its returning-resident allowance for the year. New residents complete a background check.'
    act(() => root.render(<ReturningGuestChoice offer={{ available: false, free: false, message: words }} checked={false} onChange={() => {}} />))
    expect(boxes()).toHaveLength(0)
    expect(host.textContent).toContain(words)
    expect(host.textContent).not.toMatch(/\d+ of \d+|left/)
  })

  it('not offered (a desk without the permission): nothing at all', () => {
    act(() => root.render(<ReturningGuestChoice offer={null} checked={false} onChange={() => {}} />))
    expect(host.textContent).toBe('')
  })
})

describe('what a reservation edit sends for the work trade (10/6 review)', () => {
  // As the schedule reads a stay's work trade back (server shape, camelized).
  const traded = { coveredCharges: [...WORK_TRADE_COVERABLE], trusted: false, tracksHours: true, monthlyHoursTarget: 40, duties: null }

  it('a front desk without the work-trade permission sends nothing — its notes or dates still save', () => {
    expect(workTradeEditPayload({ canManage: false, ticked: true, terms: workTradeTermsFrom(traded), original: traded })).toEqual({})
    expect(workTradeEditPayload({ canManage: false, ticked: false, terms: defaultWorkTradeTerms(), original: traded })).toEqual({})
  })

  it('unchanged terms send nothing; changed terms send them; ticked off sends null; ticked on a stay with none sends the terms', () => {
    const same = workTradeTermsFrom(traded)
    expect(workTradeEditPayload({ canManage: true, ticked: true, terms: same, original: traded })).toEqual({})
    const changed = { ...same, trusted: true }
    expect(workTradeEditPayload({ canManage: true, ticked: true, terms: changed, original: traded }))
      .toEqual({ workTrade: workTradeTermsPayload(changed) })
    expect(workTradeEditPayload({ canManage: true, ticked: false, terms: same, original: traded })).toEqual({ workTrade: null })
    expect(workTradeEditPayload({ canManage: true, ticked: false, terms: same, original: null })).toEqual({})
    expect(workTradeEditPayload({ canManage: true, ticked: true, terms: defaultWorkTradeTerms(), original: null }))
      .toEqual({ workTrade: workTradeTermsPayload(defaultWorkTradeTerms()) })
  })
})

// @vitest-environment jsdom
/**
 * 10/6 (Nic): "If I pick a start date, I want some buttons that say add a day,
 * add a week, add a month... And then it will give you the total number of
 * nights. And automatically input the leaving date... if I click four times on
 * the button to add a day, it would change the leaving date to be four days
 * after the start of the reservation."
 *
 * StayDatesFields is the New Reservation window's first screen: arrival, the
 * three gold buttons, the leaving date and "N nights — leaving <day>". A
 * leaving date picked by hand still works and keeps the count in step.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'

vi.mock('../lib/api', () => ({
  apiGet: async () => ({}), apiPatch: async () => ({}), apiPost: async () => ({}), apiDelete: async () => ({}),
}))
vi.mock('../components/dialogs', () => ({
  toast: Object.assign(() => {}, { error: () => {} }),
  appConfirm: vi.fn(async () => true), appPrompt: vi.fn(async () => null),
}))
vi.mock('../lib/permissions', () => ({ usePerms: () => ({ can: () => true, isOwner: true }) }))

import { StayDatesFields, lengthenStay } from './SchedulePage'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
let seen: { checkIn: string; checkOut: string } = { checkIn: '', checkOut: '' }
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

function Harness({ checkIn = '', checkOut = '' }: { checkIn?: string; checkOut?: string }) {
  const [d, setD] = useState({ checkIn, checkOut })
  seen = d
  return <StayDatesFields checkIn={d.checkIn} checkOut={d.checkOut} onChange={(ci, co) => setD({ checkIn: ci, checkOut: co })} />
}
const render = (p: { checkIn?: string; checkOut?: string } = {}) => act(() => { root.render(<Harness {...p} />) })
const button = (label: string) => [...host.querySelectorAll('button')].find(b => b.textContent === label) as HTMLButtonElement
const press = (label: string, times = 1) => { for (let i = 0; i < times; i++) act(() => { button(label).click() }) }
const nightsLine = () => host.querySelector('[data-testid="resv-nights"]')?.textContent ?? null
const leavingInput = () => host.querySelector('input[aria-label="Leaving"]') as HTMLInputElement
function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('New Reservation — Add a day / Add a week / Add a month', () => {
  it('the buttons are gold action buttons, and wait for an arrival date', () => {
    render()
    for (const label of ['Add a day', 'Add a week', 'Add a month']) {
      expect(button(label).className).toContain('btn-primary')
      expect(button(label).disabled).toBe(true)
    }
    expect(nightsLine()).toBeNull()
  })

  it('four presses of Add a day → 4 nights, leaving four days after arrival', () => {
    render({ checkIn: '2026-10-30' })
    press('Add a day', 4)
    expect(seen.checkOut).toBe('2026-11-03')
    expect(leavingInput().value).toBe('2026-11-03')
    expect(nightsLine()).toBe('4 nights — leaving Tue, Nov 3')
  })

  it('one press is one night', () => {
    render({ checkIn: '2026-10-30' })
    press('Add a day')
    expect(nightsLine()).toBe('1 night — leaving Sat, Oct 31')
  })

  it('Add a week is seven nights, and adds to what is there', () => {
    render({ checkIn: '2026-10-04' })
    press('Add a week')
    expect(nightsLine()).toBe('7 nights — leaving Sun, Oct 11')
    press('Add a day')
    expect(nightsLine()).toBe('8 nights — leaving Mon, Oct 12')
  })

  it('Add a month is one calendar month, across month lengths', () => {
    render({ checkIn: '2026-10-04' })
    press('Add a month')
    expect(seen.checkOut).toBe('2026-11-04')
    expect(nightsLine()).toBe('31 nights — leaving Wed, Nov 4')
    press('Add a month')
    expect(seen.checkOut).toBe('2026-12-04')
    expect(nightsLine()).toBe('61 nights — leaving Fri, Dec 4')
  })

  it('a leaving date picked by hand still works, keeps the count, and the buttons add to it', () => {
    render({ checkIn: '2026-09-30' })
    press('Add a day', 3)
    // A wrong press is fixed by picking the day: leaving on the 5th is five nights.
    type(leavingInput(), '2026-10-05')
    expect(seen.checkOut).toBe('2026-10-05')
    expect(nightsLine()).toBe('5 nights — leaving Mon, Oct 5')
    press('Add a week')
    expect(nightsLine()).toBe('12 nights — leaving Mon, Oct 12')
  })
})

describe('lengthenStay', () => {
  it('lengthens from the leaving date, or from arrival when there is none (or it is not after arrival)', () => {
    expect(lengthenStay('2026-10-04', '', 'day')).toBe('2026-10-05')
    expect(lengthenStay('2026-10-04', '2026-10-04', 'week')).toBe('2026-10-11')
    expect(lengthenStay('2026-10-04', '2026-10-10', 'week')).toBe('2026-10-17')
    expect(lengthenStay('2027-01-31', '', 'month')).toBe('2027-02-28')
    expect(lengthenStay('2028-01-31', '', 'month')).toBe('2028-02-29')
    expect(lengthenStay('', '', 'day')).toBeNull()
  })

  it('Add a month counts whole months from the arrival, so a 29th–31st arrival never drifts short', () => {
    // 10/6 (Nic): two presses from Jan 31 are two whole months — Mar 31, 59
    // nights — the two months the price charges, not Mar 28.
    expect(lengthenStay('2027-01-31', '2027-02-28', 'month')).toBe('2027-03-31')
    expect(lengthenStay('2026-10-31', '2026-11-30', 'month')).toBe('2026-12-31')
    expect(lengthenStay('2027-01-30', '2027-02-28', 'month')).toBe('2027-03-30')
    // A leaving day that is not whole months from arrival gains one month from where it is.
    expect(lengthenStay('2027-01-31', '2027-02-10', 'month')).toBe('2027-03-10')
  })
})

describe('Add a month pressed twice from the end of a month', () => {
  it('Jan 31 → Feb 28 → Mar 31 (59 nights)', () => {
    render({ checkIn: '2027-01-31' })
    press('Add a month', 2)
    expect(seen.checkOut).toBe('2027-03-31')
    expect(nightsLine()).toBe('59 nights — leaving Wed, Mar 31')
  })
  it('Oct 31 → Nov 30 → Dec 31', () => {
    render({ checkIn: '2026-10-31' })
    press('Add a month', 2)
    expect(seen.checkOut).toBe('2026-12-31')
    expect(nightsLine()).toBe('61 nights — leaving Thu, Dec 31')
  })
})

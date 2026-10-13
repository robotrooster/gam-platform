/**
 * 10/12 (Nic) — the Rent Roll: property folders (a single property opens by
 * itself), one row per household with the lease's rent, Charged with its late
 * fees named, Paid, Owed, a colored status that also says it in words, payment
 * health, and a strip of monthly stamps with the month's counts. A name opens
 * the tenant report. Totals across people show only when the server sent them.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from 'react-query'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

const server = vi.hoisted(() => ({ roll: null as any, gets: [] as string[], hold: null as Promise<void> | null, puts: [] as Array<{ url: string; body: any }> }))
vi.mock('../lib/api', () => ({
  api: {
    get: async (url: string) => {
      server.gets.push(url)
      if (server.hold) await server.hold
      if (url.startsWith('/balances/rent-roll')) return { data: { success: true, data: JSON.parse(JSON.stringify(server.roll)) } }
      throw new Error(`unexpected api.get ${url}`)
    },
    put: async (url: string, body: any) => {
      server.puts.push({ url, body })
      if (url === '/balances/rent-roll/moved-out') {
        const r = server.roll.movedOut.find((m: any) => m.landlordId === body.landlordId)
        r.rule = body.rule
        return { data: { success: true, data: r } }
      }
      throw new Error(`unexpected api.put ${url}`)
    },
  },
}))

import { RentRollPage, countsText, pickerMonths, newestFirst, movedOutNote } from './RentRollPage'
import { csvField, csvLine, stripYear } from '../lib/paymentStamps'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const stamp = (month: string, s: string | null, over: any = {}) => ({
  month, stamp: s, stampLabel: s, daysPastGrace: 0, charged: s ? 495 : 0, chargedLateFees: 0, paid: 0, credit: 0, workTrade: 0,
  owed: 0, firstPaidOn: null, paidInFullOn: null, onboarding: false, workTradeOnly: false, ...over,
})
const counts = (month: string, over: any = {}) => ({ month, paidOnTime: 0, partial: 0, paidLate: 0, outstanding: 0, due: 0, workTrade: 0, ...over })
const MONTHS = ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']

function gerald() {
  const oct = stamp('2026-10', 'outstanding', { daysPastGrace: 7, charged: 577.47, chargedLateFees: 60, owed: 577.47 })
  return {
    householdId: 'g1', name: 'Gerald Logue', propertyId: 'mv', units: ['RV 48'], leaseRent: 495,
    current: oct,
    stamps: [...MONTHS.slice(0, 4).map(m => stamp(m, null)), stamp('2026-09', 'paid_on_time', { onboarding: true, paid: 495, paidInFullOn: '2026-09-17' }), oct],
    health: { percent: 50, onTime: 1, counted: 2, paidLate: 0, partial: 0, outstanding: 1, notCounted: 0, workTrade: 0, from: '2025-11', through: '2026-10', label: '50%, 1 of 2 months' },
    delinquent: true, evictionMode: false, workTrade: false,
    lines: [{ paymentId: 'l1', householdId: 'g1', month: '2026-10', dueDate: '2026-10-01', label: 'Rent', detail: null, type: 'rent',
      unitNumber: 'RV 48', propertyName: 'Mountain View', charged: 495, paid: 0, credit: 0, workTrade: 0, owed: 495, paidOn: null,
      howPaid: null, daysPastGrace: 7, invoiceId: 'i1', isLateFee: false }],
  }
}

function roll(over: any = {}) {
  return {
    through: '2026-10', months: MONTHS,
    properties: [{ propertyId: 'mv', propertyName: 'Mountain View RV Ranch', occupied: 1, rows: [gerald()],
      counts: MONTHS.map(m => counts(m, m === '2026-10' ? { outstanding: 1 } : m === '2026-09' ? { paidOnTime: 1 } : {})) }],
    counts: MONTHS.map(m => counts(m, m === '2026-10' ? { outstanding: 1 } : m === '2026-09' ? { paidOnTime: 1 } : {})),
    ...over,
  }
}

let host: HTMLDivElement
let root: Root
beforeEach(() => { server.gets = []; server.puts = []; server.hold = null; host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host) })
afterEach(() => { act(() => root.unmount()); host.remove() })

const text = () => host.textContent ?? ''
async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 150; i++) {
    if (check()) return
    await act(async () => { await new Promise(r => setTimeout(r, 10)) })
  }
  throw new Error(`timed out waiting for ${what}\n${text()}`)
}
async function render(wait = 'Mountain View RV Ranch') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    root.render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/rent-roll']}>
          <Routes>
            <Route path="/rent-roll" element={<RentRollPage />} />
            <Route path="/tenants/:id/report" element={<div>REPORT PAGE</div>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>)
  })
  await until(() => text().includes(wait), 'the page')
}

describe('the Rent Roll', () => {
  it('a single property opens by itself; the household row says what was charged, owed, how late and how healthy', async () => {
    server.roll = roll()
    await render()
    // 10/12 (Nic): all time — no 6- or 12-month choice is asked for.
    expect(server.gets[0]).toMatch(/^\/balances\/rent-roll\?through=\d{4}-\d{2}$/)
    expect(text()).toContain('Gerald Logue')
    expect(text()).toContain('RV 48')
    expect(text()).toContain('$495.00')                  // the lease's rent
    expect(text()).toContain('$577.47')                  // charged, late fees included …
    expect(text()).toContain('incl. $60.00 late fees')   // … and named
    expect(text()).toContain('Outstanding')
    expect(text()).toContain('7 days past grace')
    expect(text()).toContain('Delinquent')
    expect(text()).toContain('50%')
    expect(text()).toContain('1 of 2 mo')
    // The stamps carry letters, not only colors; the onboarding month is marked.
    const stamps = [...host.querySelectorAll('.rr-split .rr-stamp')]
    expect(stamps.map(s => s.textContent)).toContain('O+7')
    expect(stamps.some(s => s.classList.contains('onboarding') && s.textContent === 'P')).toBe(true)
    // The month header counts the late households.
    expect(host.querySelector('.rr-month-late')?.textContent).toBe('1 late')
  })

  // 10/12 (Nic): "the full stamp history as a horizontally scrolling strip
  // (newest first visible), name column beside it not over it."
  it('the full stamp history scrolls sideways beside the names, newest month first; a past year is marked', async () => {
    const all = ['2025-11', '2025-12', ...MONTHS]
    const r = gerald()
    r.stamps = [stamp('2025-11', 'paid_late', { daysPastGrace: 2, paid: 495 }), stamp('2025-12', null), ...r.stamps]
    server.roll = roll({
      months: all,
      properties: [{ propertyId: 'mv', propertyName: 'Mountain View RV Ranch', occupied: 1, rows: [r], counts: all.map(m => counts(m)) }],
      counts: all.map(m => counts(m)),
    })
    await render()
    expect(text()).not.toContain('Show 12 months')
    // The names are their own table, beside the scrolling one — never inside it.
    expect(host.querySelector('.rr-split > .rr-fixed .rr-name-link')?.textContent).toBe('Gerald Logue')
    expect(host.querySelector('.rr-split > .rr-scroll .rr-name-link')).toBeNull()
    const scroller = host.querySelector('.rr-split > .rr-scroll')!
    expect(scroller.getAttribute('role')).toBe('region')
    // Every month, newest first, right after the month's figures.
    const heads = [...scroller.querySelectorAll('thead th.stampcol')].map(th => th.getAttribute('title'))
    expect(heads).toEqual(['October 2026', 'September 2026', 'August 2026', 'July 2026', 'June 2026', 'May 2026',
      'December 2025', 'November 2025'])
    expect(scroller.querySelectorAll('thead th.stampcol')[7].textContent).toContain('’25')
    const rowStamps = [...scroller.querySelectorAll('tbody .rr-stamp')].map(s => s.textContent)
    expect(rowStamps[0]).toBe('O+7')
    expect(rowStamps[rowStamps.length - 1]).toBe('L+2')
    // The phone card carries the whole strip too, newest first.
    const card = [...host.querySelectorAll('.rr-card-stamps .rr-stamp-month')].map(s => s.textContent)
    expect(card).toHaveLength(8)
    expect(card[0]).toBe('Oct')
    expect(card[7]).toBe('Nov’25')
  })

  it('totals show only when the server sent them', async () => {
    server.roll = roll()
    await render()
    expect(text()).not.toContain('Charged ·')
    act(() => root.unmount())
    root = createRoot(host)
    server.roll = roll({ totals: { charged: 577.47, chargedLateFees: 60, paid: 0, credit: 0, workTrade: 0, owed: 577.47 } })
    server.roll.properties[0].totals = { charged: 577.47, chargedLateFees: 60, paid: 0, credit: 0, workTrade: 0, owed: 577.47 }
    await render()
    expect(text()).toContain('Charged · Oct')
    expect(text()).toContain('Owed$577.47')
  })

  it('a name opens the tenant report', async () => {
    server.roll = roll()
    await render()
    const link = host.querySelector('.rr-split .rr-name-link') as HTMLButtonElement
    await act(async () => { link.click() })
    await until(() => text().includes('REPORT PAGE'), 'the report')
  })

  it('the chevron shows the month’s charges with what each is for', async () => {
    server.roll = roll()
    await render()
    const caret = host.querySelector('.rr-split .rr-caret') as HTMLButtonElement
    await act(async () => { caret.click() })
    expect(host.querySelector('.rr-split-only .rr-lines-table')?.textContent).toContain('Rent')
  })

  // 10/12: on a long folder the panel opens far below the row — it is brought into view.
  it('the chevron brings the month’s charges into view', async () => {
    server.roll = roll()
    const scrolled: Element[] = []
    const had = (Element.prototype as any).scrollIntoView
    ;(Element.prototype as any).scrollIntoView = function (this: Element) { scrolled.push(this) }
    try {
      await render()
      const caret = host.querySelector('.rr-split .rr-caret') as HTMLButtonElement
      await act(async () => { caret.click() })
      expect(scrolled).toContain(host.querySelector('.rr-split-only'))
    } finally {
      (Element.prototype as any).scrollIntoView = had
    }
  })

  // 10/12: while a newly picked month loads, the figures on screen are the last
  // month's — they keep that month's name, dimmed, never the new month's.
  it('a newly picked month keeps the last figures under their own month, dimmed, until the new ones arrive', async () => {
    server.roll = roll()
    await render()
    let release!: () => void
    server.hold = new Promise<void>(r => { release = r })
    const select = host.querySelector('select.rr-month') as HTMLSelectElement
    const picked = [...select.options].map(o => o.value).find(v => v !== '2026-10' && v !== select.value)!
    await act(async () => { select.value = picked; select.dispatchEvent(new Event('change', { bubbles: true })) })
    const summary = () => host.querySelector('.rr-summary') as HTMLElement
    expect(summary().getAttribute('aria-busy')).toBe('true')
    expect(summary().textContent).toContain('October 2026')
    expect(host.querySelector('.rr-folder')!.getAttribute('aria-busy')).toBe('true')
    server.roll = roll({ through: picked })
    server.hold = null
    await act(async () => { release() })
    await until(() => summary().getAttribute('aria-busy') === null, 'the picked month')
    expect(summary().textContent).not.toContain('October 2026')
  })

  it('search finds by name or space; nothing found says so', async () => {
    server.roll = roll()
    await render()
    const input = host.querySelector('input.search-input') as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => { setter.call(input, 'zzz'); input.dispatchEvent(new Event('input', { bubbles: true })) })
    expect(text()).toContain('No one matches')
  })
})

// 10/12 (Nic): "who stays on the Rent Roll after moving out = LANDLORD'S
// CHOICE (a setting on the page: billed in last 12 months / while they owe /
// all time)."
describe('who stays after moving out', () => {
  const mv = (over: any = {}) => ({ landlordId: 'c1', companyName: 'Mountain View LLC', rule: 'billed_last_12_months', ruleLabel: 'Billed in the last 12 months', ...over })

  it('the owner picks it on the page; the choice is saved and the roll read again', async () => {
    server.roll = roll({ movedOut: [mv()], canChangeMovedOut: true })
    await render()
    const select = host.querySelector('.rr-moved-out select') as HTMLSelectElement
    expect(select).toBeTruthy()
    expect(select.closest('label')?.textContent).toContain('Keep moved-out households')
    expect([...select.options].map(o => o.textContent)).toEqual(['Billed in the last 12 months', 'While they still owe', 'All time'])
    expect(select.value).toBe('billed_last_12_months')
    const before = server.gets.length
    await act(async () => { select.value = 'while_owing'; select.dispatchEvent(new Event('change', { bubbles: true })) })
    await until(() => server.gets.length > before, 'the roll read again')
    expect(server.puts).toEqual([{ url: '/balances/rent-roll/moved-out', body: { landlordId: 'c1', rule: 'while_owing' } }])
    await until(() => (host.querySelector('.rr-moved-out select') as HTMLSelectElement).value === 'while_owing', 'the new choice')
  })

  it('anyone else reads it in words, with nothing to change', async () => {
    server.roll = roll({ movedOut: [mv({ rule: 'all_time', ruleLabel: 'All time' })], canChangeMovedOut: false })
    await render()
    expect(host.querySelector('.rr-moved-out select')).toBeNull()
    expect(host.querySelector('.rr-moved-out')?.textContent).toBe('Keep moved-out householdsAll time')
  })

  it('an account with two companies has one choice per company, by name', async () => {
    server.roll = roll({ movedOut: [mv(), mv({ landlordId: 'c2', companyName: 'Oak Park LLC', rule: 'all_time', ruleLabel: 'All time' })], canChangeMovedOut: true })
    await render()
    const items = [...host.querySelectorAll('.rr-moved-out-item')]
    expect(items.map(i => i.querySelector('span')?.textContent)).toEqual([
      'Mountain View LLC: keep moved-out households', 'Oak Park LLC: keep moved-out households'])
    expect(items.map(i => (i.querySelector('select') as HTMLSelectElement).value)).toEqual(['billed_last_12_months', 'all_time'])
  })

  it('the empty page says who appears under the rule', async () => {
    server.roll = roll({ properties: [], movedOut: [mv({ rule: 'while_owing', ruleLabel: 'While they still owe' })], canChangeMovedOut: true })
    await render('No households yet')
    expect(text()).toContain('anyone who moved out but still owes')
    expect(movedOutNote(undefined)).toContain('billed in the last 12 months')
    expect(movedOutNote([mv({ rule: 'all_time' })])).toContain('everyone who ever lived here')
    expect(movedOutNote([mv(), mv({ landlordId: 'c2', rule: 'all_time' })])).toContain('each company keeps')
  })
})

describe('helpers', () => {
  // 10/12: names are typed by tenants; one that starts like a formula must not run in Excel.
  it('a CSV field that starts like a formula reads as text; numbers stay numbers', () => {
    expect(csvField('=HYPERLINK("http://x","y")')).toBe(`"'=HYPERLINK(""http://x"",""y"")"`)
    expect(csvField('+1 555')).toBe(`'+1 555`)
    expect(csvField('-x')).toBe(`'-x`)
    expect(csvField('@sum')).toBe(`'@sum`)
    expect(csvField(-5)).toBe('-5')
    expect(csvField('Gerald Logue')).toBe('Gerald Logue')
    expect(csvLine(['a,b', 3, null])).toBe('"a,b",3,')
  })
  it('counts say each stamp in words', () => {
    expect(countsText(counts('2026-10', { paidOnTime: 3, paidLate: 1, outstanding: 2 }))).toBe('3 on time · 1 paid late · 2 outstanding')
  })
  it('the strip reads newest first; another year than the picked one is marked', () => {
    expect(newestFirst(['2026-08', '2026-09', '2026-10'])).toEqual(['2026-10', '2026-09', '2026-08'])
    expect(newestFirst(undefined)).toEqual([])
    expect(stripYear('2025-12', '2026-10')).toBe('’25')
    expect(stripYear('2026-01', '2026-10')).toBeNull()
  })
  it('the picker offers 24 months, newest first', () => {
    const m = pickerMonths('2026-10-12')
    expect(m).toHaveLength(24)
    expect(m[0]).toBe('2026-10')
    expect(m[10]).toBe('2025-12')
  })
})

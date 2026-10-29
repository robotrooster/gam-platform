/**
 * 10/13 (Nic) — the Rent Roll is the history lookup, one property at a time:
 *
 *   "the rent roll page is the historical lookup for previous reportings for
 *    quarters or years or individual months or whatever … I don't like having
 *    Mountain View and Oak Park options right next to each other at the top …
 *    I don't want to be able to have one property looking one way and one
 *    property looking another way … too much … clutter."
 *
 * Answered 10/13: pick the property first (one property opens straight to
 * it); quick picks Last month · This quarter · Last quarter · This year · Last
 * year · All time and a custom start/end month, one view for every property;
 * rows in space order with Invoiced · Paid · Owed, health and a colored stamp
 * per month in words; a collapsed "Moved out, still owes" folder; no
 * moved-out setting, no instruction paragraph; Print and Export CSV stay; a
 * name opens that household's (lease's) report. Every figure is the server's.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from 'react-query'
import { MemoryRouter, Routes, Route, useLocation, useParams } from 'react-router-dom'
import { RENT_ROLL_STATUS_COLOR, rentRollStatusText, type RentRollMonthStatus } from '@gam/shared'

const server = vi.hoisted(() => ({
  properties: [] as any[],
  propsFail: null as any,
  history: null as null | ((q: URLSearchParams) => any),
  gets: [] as string[],
  hold: null as Promise<void> | null,
  puts: [] as string[],
}))
vi.mock('../lib/api', () => ({
  api: {
    get: async (url: string) => {
      server.gets.push(url)
      if (url === '/balances/rent-roll/properties') {
        if (server.propsFail) throw server.propsFail
        return { data: { success: true, data: JSON.parse(JSON.stringify(server.properties)) } }
      }
      if (url.startsWith('/balances/rent-roll/history?')) {
        if (server.hold) await server.hold
        const q = new URLSearchParams(url.split('?')[1])
        return { data: { success: true, data: JSON.parse(JSON.stringify(server.history!(q))) } }
      }
      throw new Error(`unexpected api.get ${url}`)
    },
    put: async (url: string) => { server.puts.push(url); throw new Error(`unexpected api.put ${url}`) },
  },
}))

// 10/13 (Nic): a bookkeeper reads the Rent Roll too — the signed-in user decides whether a name opens the report.
const auth = vi.hoisted(() => ({ user: { role: 'landlord', permissions: {} } as any }))
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ user: auth.user }) }))

import { RentRollPage, newestFirst, rangeTitle, monthCountWords, rentRollCsv, csvFileName, movedOutInRangeWords, staysMeta } from './RentRollPage'
import { rangeOfPick, historyPath } from '../components/rentroll/rentRollRange'
import { localToday } from '../lib/creditDesk'
import { csvField, csvLine } from '../lib/paymentStamps'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const MV = { propertyId: 'mv', name: 'Mountain View RV Ranch', spaces: 52, owned: true }
const OP = { propertyId: 'op', name: 'Oak Park', spaces: 29, owned: true }

/** A month's stamp as the server builds it (the shared words and colors). */
const stamp = (month: string, status: RentRollMonthStatus, over: any = {}) => {
  const days = over.daysPastGrace ?? 0
  return {
    month, status, statusLabel: rentRollStatusText({ status, daysPastGrace: days }), statusColor: RENT_ROLL_STATUS_COLOR[status],
    daysPastGrace: days, invoiced: status === 'none' ? 0 : 495, paid: 0, credit: 0, workTrade: 0, owed: 0, onboarding: false, ...over,
  }
}
const health = (percent: number | null, label: string) => ({
  percent, onTime: 1, counted: 2, paidLate: 0, partial: 0, outstanding: 1, notCounted: 0, workTrade: 0, from: '2026-03', through: '2026-09', label,
})
const resident = (tenantId: string, name: string, primary = true) => ({ tenantId, name, primary })

function gerald(months: string[]) {
  return {
    key: 'lease:l48', leaseId: 'l48', householdId: 'g1', residents: [resident('g1', 'Gerald Logue'), resident('g2', 'Gina Logue', false)],
    spaces: ['RV 10'], movedOut: false,
    invoiced: 577.47, lateFees: 60, paid: 0, credit: 0, workTrade: 0, owed: 577.47,
    health: health(50, '50%, 1 of 2 months'),
    stamps: months.map(m => m === months[months.length - 1]
      ? stamp(m, 'owes', { daysPastGrace: 7, invoiced: 577.47, owed: 577.47 })
      : stamp(m, 'paid', { paid: 495, onboarding: true })),
  }
}
function ana(months: string[]) {
  return {
    key: 'lease:l2', leaseId: 'l2', householdId: 'a1', residents: [resident('a1', 'Ana Ruiz')],
    spaces: ['RV 2'], movedOut: false,
    invoiced: 990, lateFees: 0, paid: 990, credit: 0, workTrade: 0, owed: 0,
    health: health(100, '100%, 2 of 2 months'),
    stamps: months.map(m => m === months[0] ? stamp(m, 'none') : stamp(m, 'paid_late', { daysPastGrace: 5, paid: 495 })),
  }
}

function history(q: URLSearchParams, over: any = {}) {
  const all = q.get('range') === 'all'
  const from = all ? '2026-03' : q.get('from')!
  const to = all ? '2026-10' : q.get('to')!
  const months: string[] = []
  for (let m = from; m <= to; m = `${Number(m.slice(5)) === 12 ? Number(m.slice(0, 4)) + 1 : m.slice(0, 4)}-${String(Number(m.slice(5)) % 12 + 1).padStart(2, '0')}`) months.push(m)
  const propertyId = q.get('propertyId')!
  return {
    propertyId, propertyName: propertyId === 'op' ? 'Oak Park' : 'Mountain View RV Ranch', from, to, allTime: all, months,
    monthCounts: months.map(m => ({ month: m, counts: [
      { status: 'paid', label: 'Paid', households: 0 },
      { status: 'paid_late', label: 'Paid late', households: m === months[0] ? 0 : 1 },
      { status: 'partial', label: 'Partial', households: 0 },
      { status: 'owes', label: 'Owes', households: m === months[months.length - 1] ? 1 : 0 },
      { status: 'due', label: 'Due', households: 0 },
    ] })),
    // In space order, as the server sends them: RV 2 before RV 10.
    rows: [ana(months), gerald(months)],
    movedOutOwing: [],
    ...over,
  }
}

const today = localToday()
const lastMonth = rangeOfPick('last_month', today) as { all: false; from: string; to: string }

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  server.gets = []; server.puts = []; server.hold = null; server.propsFail = null
  server.properties = [MV]
  server.history = q => history(q)
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove() })

const text = () => host.textContent ?? ''
async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 150; i++) {
    if (check()) return
    await act(async () => { await new Promise(r => setTimeout(r, 10)) })
  }
  throw new Error(`timed out waiting for ${what}\n${text()}`)
}
function Report() {
  const { id } = useParams()
  const loc = useLocation()
  return <div>REPORT {id} {loc.search}</div>
}
function Where() {
  const loc = useLocation()
  return <span data-where={loc.search} />
}
async function render(wait: string | (() => boolean) = 'Ana Ruiz', search = '') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    root.render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[`/rent-roll${search}`]}>
          <Routes>
            <Route path="/rent-roll" element={<><RentRollPage /><Where /></>} />
            <Route path="/tenants/:id/report" element={<Report />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>)
  })
  await until(typeof wait === 'string' ? () => text().includes(wait) : wait, 'the page')
}
const historyGets = () => server.gets.filter(u => u.startsWith('/balances/rent-roll/history'))
const button = (label: string | RegExp) => [...host.querySelectorAll('button')]
  .find(b => typeof label === 'string' ? b.textContent?.trim() === label : label.test(b.textContent ?? '')) as HTMLButtonElement
const click = async (b: HTMLElement) => { await act(async () => { b.click() }) }
const where = () => host.querySelector('[data-where]')?.getAttribute('data-where') ?? ''
const select = async (el: HTMLSelectElement, value: string) => {
  await act(async () => { el.value = value; el.dispatchEvent(new Event('change', { bubbles: true })) })
}

describe('the Rent Roll: one property at a time', () => {
  it('a company with one property opens straight to it, on last month; no moved-out setting, no instruction paragraph', async () => {
    await render()
    expect(historyGets()).toEqual([historyPath('mv', lastMonth)])
    expect(host.querySelector('.rrh-head-name')?.textContent).toBe('Mountain View RV Ranch')
    // Nothing to go back to with one property.
    expect(button(/All properties/)).toBeUndefined()
    expect(text()).not.toContain('Pick a property')
    expect(text()).not.toContain('Keep moved-out households')
    expect(host.querySelector('.rr-moved-out')).toBeNull()
    expect(host.querySelector('.page-subtitle')).toBeNull()
    expect(server.puts).toEqual([])
    // Print and Export CSV stay, gold.
    expect(button(/Print/).className).toContain('btn-primary')
    expect(button(/Export CSV/).className).toContain('btn-primary')
    expect(button('Last month').getAttribute('aria-pressed')).toBe('true')
  })

  it('two properties: the page asks first and never shows them side by side; inside one, "All properties" goes back', async () => {
    server.properties = [MV, OP]
    await render('Pick a property')
    expect(historyGets()).toEqual([])
    const picks = [...host.querySelectorAll('.rrh-prop')].map(b => b.textContent)
    expect(picks).toEqual(['Mountain View RV Ranch52 spaces', 'Oak Park29 spaces'])
    await click(host.querySelectorAll('.rrh-prop')[1] as HTMLElement)
    await until(() => host.querySelector('.rrh-head-name')?.textContent === 'Oak Park' && text().includes('Ana Ruiz'), 'Oak Park')
    expect(historyGets()).toEqual([historyPath('op', lastMonth)])
    // Inside a property: no other property's name or figures.
    expect(text()).not.toContain('Mountain View')
    expect(button(/All properties/).className).toContain('btn-ghost')
    await click(button(/All properties/))
    await until(() => text().includes('Pick a property'), 'the pick again')
  })

  it('one view for every property: the range picked in one stays when another is opened', async () => {
    server.properties = [MV, OP]
    await render('Pick a property')
    await click(host.querySelectorAll('.rrh-prop')[0] as HTMLElement)
    await until(() => text().includes('Ana Ruiz'), 'Mountain View')
    await click(button('Last year'))
    const lastYear = rangeOfPick('last_year', today)
    await until(() => historyGets().includes(historyPath('mv', lastYear)), 'last year')
    expect(where()).toContain('range=last_year')
    await click(button(/All properties/))
    await until(() => text().includes('Pick a property'), 'the pick')
    await click(host.querySelectorAll('.rrh-prop')[1] as HTMLElement)
    await until(() => historyGets().includes(historyPath('op', lastYear)), 'Oak Park, last year')
    expect(button('Last year').getAttribute('aria-pressed')).toBe('true')
    expect(button('Last month').getAttribute('aria-pressed')).toBe('false')
  })

  it('each quick pick asks for its months; All time asks for all; From/To is a custom range that never runs backwards', async () => {
    await render()
    for (const [label, pick] of [['This quarter', 'this_quarter'], ['Last quarter', 'last_quarter'], ['This year', 'this_year']] as const) {
      await click(button(label))
      await until(() => historyGets().includes(historyPath('mv', rangeOfPick(pick, today))), label)
      expect(button(label).className).toContain('btn-primary')
    }
    await click(button('All time'))
    await until(() => historyGets().includes('/balances/rent-roll/history?propertyId=mv&range=all'), 'all time')
    await until(() => text().includes('All time · March – October 2026'), 'the all-time title')
    // All time's months are known now: the boxes show them.
    const from = host.querySelector('select.rrh-from') as HTMLSelectElement
    const to = host.querySelector('select.rrh-to') as HTMLSelectElement
    expect([from.value, to.value]).toEqual(['2026-03', '2026-10'])
    await select(from, '2026-05')
    await until(() => historyGets().includes(historyPath('mv', { all: false, from: '2026-05', to: '2026-10' })), 'the custom range')
    expect(RANGE_LABELS().every(l => button(l).getAttribute('aria-pressed') === 'false')).toBe(true)
    // An end before the start moves the start to it.
    await select(host.querySelector('select.rrh-to') as HTMLSelectElement, '2026-04')
    await until(() => historyGets().includes(historyPath('mv', { all: false, from: '2026-04', to: '2026-04' })), 'the end moved the start')
    expect(where()).toBe('?from=2026-04&to=2026-04')
  })

  it('rows in space order; Invoiced, Paid and Owed for the range; health; one stamp per month in words, newest first', async () => {
    await render(undefined, '?range=this_year')
    const fixed = [...host.querySelectorAll('.rr-split .rr-fixed tbody tr')].map(r => r.textContent)
    expect(fixed[0]).toBe('RV 2Ana Ruiz')
    expect(fixed[1]).toBe('RV 10Gerald Logue+ Gina Logue')
    const scroll = host.querySelector('.rr-split .rr-scroll')!
    const heads = [...scroll.querySelectorAll('thead th')].map(th => th.textContent)
    expect(heads.slice(0, 4)).toEqual(['Invoiced', 'Paid', 'Owed', 'Health'])
    const range = rangeOfPick('this_year', today) as { from: string; to: string }
    const monthHeads = [...scroll.querySelectorAll('thead th.rrh-stampcol')].map(th => th.getAttribute('title'))
    expect(monthHeads[0]).toBe(new Date(Number(range.to.slice(0, 4)), Number(range.to.slice(5)) - 1, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' }))
    const gerald = [...scroll.querySelectorAll('tbody tr')][1]
    const cells = [...gerald.querySelectorAll('td')].map(td => td.textContent)
    expect(cells[0]).toBe('$577.47incl. $60.00 late fees')
    expect(cells[1]).toBe('$0.00')
    expect(cells[2]).toBe('$577.47')
    expect(cells[3]).toBe('50%')
    // Newest month first: the red "Owes +7" sits right after Health.
    const geraldStamps = [...gerald.querySelectorAll('.rrs')]
    expect(geraldStamps[0].textContent).toBe('Owes +7')
    expect(geraldStamps[0].className).toContain('red')
    const anaStamps = [...[...scroll.querySelectorAll('tbody tr')][0].querySelectorAll('.rrs')]
    expect(anaStamps[0].textContent).toBe('Paid late +5')
    expect(anaStamps[0].className).toContain('orange')
    // No cryptic letter codes; a month with no bill is a quiet dash that says so on hover.
    expect(text()).not.toMatch(/\b[POLD]\+\d/)
    const none = anaStamps[anaStamps.length - 1]
    expect(none.textContent).toBe('—')
    expect(none.getAttribute('title')).toMatch(/No bill$/)
    // Each month's households in words, in their colors.
    const foot = [...scroll.querySelectorAll('tfoot td.rrh-stampcol')]
    expect(foot[0].textContent).toBe('1 paid late1 owes')
    expect(foot[0].querySelector('.rrs-count.red')?.textContent).toBe('1 owes')
  })

  // 10/13 (Nic), the onboarding month (September at Mountain View) paid late:
  // "Keep it out, but say so." Nothing counted yet is said in words, never a
  // bare dash; beside a percentage, the hover says the onboarding month is out.
  it('health with nothing counted yet says why in words — never a bare dash; the onboarding month left out is said', async () => {
    server.history = q => {
      const h = history(q)
      const [a, g] = h.rows
      return { ...h, rows: [
        { ...a, health: { ...health(null, 'Onboarding month — not counted'), onTime: 0, counted: 0, outstanding: 0, notCounted: 2, onboardingLeftOut: true } },
        { ...g, health: { ...health(100, '100%, 1 of 1 month'), onboardingLeftOut: true } },
        { ...g, key: 'lease:l9', leaseId: 'l9', householdId: 'n1', residents: [resident('n1', 'Nell New')], spaces: ['RV 12'],
          health: { ...health(null, 'No months to judge yet'), onTime: 0, counted: 0, outstanding: 0 } },
      ] }
    }
    await render(undefined, '?range=this_year')
    const healthCells = [...host.querySelectorAll('.rr-split .rr-scroll tbody tr')].map(tr => tr.querySelectorAll('td')[3])
    expect(healthCells.map(td => td.textContent)).toEqual(['Onboarding month — not counted', '100%', 'No months to judge yet'])
    expect(healthCells[0].querySelector('.rr-health-words')).not.toBeNull()
    expect(healthCells[0].querySelector('span')!.getAttribute('title')).toMatch(/^Pays on time: Onboarding month — not counted — all time through /)
    expect(healthCells[1].querySelector('span')!.getAttribute('title')).toMatch(/^Pays on time: 100%, 1 of 1 month · the onboarding month is not counted — all time through /)
    expect(healthCells.some(td => td.textContent === '—')).toBe(false)
    // The phone cards say the same.
    expect([...host.querySelectorAll('.rr-cards .rr-card')].map(c => c.querySelector('.rr-card-top > div:last-child')!.textContent))
      .toEqual(['Health Onboarding month — not counted', 'Health 100%', 'Health No months to judge yet'])
  })

  it('a month in another year than the range’s end carries its year', async () => {
    await render(undefined, '?from=2025-11&to=2026-01')
    const heads = [...host.querySelectorAll('.rr-scroll thead th.rrh-stampcol')].map(th => th.textContent)
    expect(heads).toEqual(['Jan', 'Dec’25', 'Nov’25'])
    expect(text()).toContain('November 2025 – January 2026')
  })

  it('totals across households show only when the server sent them', async () => {
    await render()
    expect(host.querySelector('.rrh-summary')?.textContent).toBe(rangeTitle({ from: lastMonth.from, to: lastMonth.to, allTime: false }))
    act(() => root.unmount())
    root = createRoot(host)
    server.history = q => history(q, { totals: { invoiced: 1567.47, lateFees: 60, paid: 990, credit: 0, workTrade: 0, owed: 577.47 } })
    await render()
    const summary = host.querySelector('.rrh-summary')!.textContent
    expect(summary).toContain('Invoiced $1,567.47')
    expect(summary).toContain('Paid $990.00')
    expect(summary).toContain('Owed $577.47')
    expect(summary).not.toContain('Work trade')
    expect(summary).not.toContain('moved-out')
  })

  // 10/13 review: the printed page says where the totals' extra comes from.
  it('totals that count the moved-out households\' bills say how much of them is theirs', async () => {
    const marta = { invoiced: 495, lateFees: 0, paid: 0, credit: 0, workTrade: 0, owed: 495 }
    server.history = q => history(q, {
      totals: { invoiced: 1485, lateFees: 0, paid: 990, credit: 0, workTrade: 0, owed: 495 }, movedOutTotals: marta,
      movedOutOwing: [{ key: 'lease:l9', leaseId: 'l9', householdId: 'm1', residents: [resident('m1', 'Marta Diaz')], spaces: ['RV 7'],
        owed: 495, months: [{ month: '2026-09', owed: 495 }], leaseEnded: null, inRange: marta }],
    })
    await render()
    expect(host.querySelector('.rrh-summary .rrh-incl')!.textContent)
      .toBe('Includes the moved-out households\' bills in this range: invoiced $495.00 · paid $0.00 · owed $495.00')
    expect(movedOutInRangeWords({ movedOutTotals: { ...marta, invoiced: 0, owed: 0 }, movedOutOwing: [] })).toBeNull()
  })

  it('a name opens that household’s report — its lease', async () => {
    await render()
    const link = [...host.querySelectorAll('.rr-split .rr-name-link')].find(b => b.textContent === 'Gerald Logue') as HTMLButtonElement
    await click(link)
    await until(() => text().includes('REPORT g1 ?leaseId=l48'), 'the report')
  })

  // 10/13 (Nic): "Bookkeepers SEE the Payments and Rent Roll pages, read-only."
  it('a bookkeeper reads the same page — Print and Export kept — and a name is just the name (the report is not theirs)', async () => {
    auth.user = { role: 'bookkeeper', permissions: { access_level: 'read_write' } }
    server.history = q => history(q, { movedOutOwing: [{
      key: 'lease:l9', leaseId: 'l9', householdId: 'm1', residents: [resident('m1', 'Marta Diaz')], spaces: ['RV 7'], owed: 515,
      months: [{ month: '2026-08', owed: 495 }], leaseEnded: null, inRange: { invoiced: 495, lateFees: 0, paid: 0, credit: 0, workTrade: 0, owed: 495 },
    }] })
    try {
      await render()
      const names = [...host.querySelectorAll('.rr-split .rr-name-link')]
      expect(names.map(n => n.textContent)).toEqual(['Ana Ruiz', 'Gerald Logue'])
      expect(names.every(n => n.tagName === 'SPAN')).toBe(true)
      expect(button(/Print/)).toBeDefined()
      expect(button(/Export CSV/)).toBeDefined()
      await click(host.querySelector('.rrh-folder-head') as HTMLElement)
      const row = host.querySelector('.rrh-mo-table tbody tr')!
      // The lease end date only when the owner ticked the box (the server sends it or not).
      expect([...row.querySelectorAll('td')].map(td => td.textContent)).toEqual(['RV 7', 'Marta Diaz', '—', 'Aug 2026 $495.00', '$515.00'])
      expect(row.querySelector('button')).toBeNull()
    } finally {
      auth.user = { role: 'landlord', permissions: {} }
    }
  })

  it('"Moved out, still owes" is collapsed until opened; each household with what it still owes for, its name opening its report', async () => {
    server.history = q => history(q, { movedOutOwing: [{
      key: 'lease:l9', leaseId: 'l9', householdId: 'm1', residents: [resident('m1', 'Marta Diaz')], spaces: ['RV 7'], owed: 515,
      months: [{ month: '2026-08', owed: 495 }, { month: '2026-09', owed: 20 }], leaseEnded: '2026-08-31',
      inRange: { invoiced: 515, lateFees: 20, paid: 0, credit: 0, workTrade: 0, owed: 515 },
    }] })
    await render()
    const head = host.querySelector('.rrh-folder-head') as HTMLButtonElement
    expect(head.textContent).toBe('Moved out, still owes1 household')
    expect(head.getAttribute('aria-expanded')).toBe('false')
    expect(text()).not.toContain('Marta Diaz')
    await click(head)
    const row = host.querySelector('.rrh-mo-table tbody tr')!
    expect([...row.querySelectorAll('td')].map(td => td.textContent)).toEqual(
      ['RV 7', 'Marta Diaz', 'Aug 31, 2026', 'Aug 2026 $495.00 · Sep 2026 $20.00', '$515.00'])
    await click(row.querySelector('.rr-name-link') as HTMLElement)
    await until(() => text().includes('REPORT m1 ?leaseId=l9'), 'the report')
  })

  // 10/14 (Nic): "The Rent Roll's 'Moved out, still owes' folder also lists
  // checked-out stay guests who still owe — same rule, same wording."
  it('a stay guest who checked out still owing is in the folder too, in the Payments page\'s words; the name opens nothing', async () => {
    const zero = { invoiced: 0, lateFees: 0, paid: 0, credit: 0, workTrade: 0, owed: 0 }
    server.history = q => history(q, { movedOutOwing: [
      { key: 'lease:l9', kind: 'household', leaseId: 'l9', householdId: 'm1', residents: [resident('m1', 'Marta Diaz')], guest: null,
        stayDates: null, checkedOut: null, spaces: ['RV 7'], owed: 495, months: [{ month: '2026-08', owed: 495 }], leaseEnded: null,
        inRange: zero },
      { key: 'stay:b1', kind: 'stay', leaseId: null, householdId: null, residents: [], guest: 'Olaf Over', stayDates: 'Sep 20 – Sep 27',
        checkedOut: '2026-09-27', spaces: ['RV 35'], owed: 360, months: [], leaseEnded: null, inRange: zero },
    ] })
    await render()
    const head = host.querySelector('.rrh-folder-head') as HTMLButtonElement
    expect(head.textContent).toBe('Moved out, still owes1 household · 1 stay guest')
    await click(head)
    const rows = [...host.querySelectorAll('.rrh-mo-table tbody tr')]
    expect([...rows[1].querySelectorAll('td')].map(td => td.textContent)).toEqual(
      ['RV 35', 'Olaf Over', '—', 'Stay Sep 20 – Sep 27 · checked out Sep 27, 2026', '$360.00'])
    expect(rows[1].querySelector('button')).toBeNull()
    const lines = rentRollCsv(server.history!(new URLSearchParams('propertyId=mv&from=2026-09&to=2026-09'))).trimEnd().split('\n')
    expect(lines.slice(-2)).toEqual([
      'RV 7,Marta Diaz,,0,0,0,495,August 2026 $495.00',
      'RV 35,Olaf Over,,0,0,0,360,"Stay Sep 20 – Sep 27 · checked out Sep 27, 2026"',
    ])
  })

  it('no folder when nobody who moved out still owes; a range nobody was billed in says so', async () => {
    server.history = q => history(q, { rows: [] })
    await render('Nobody was billed here')
    expect(host.querySelector('.rrh-folder')).toBeNull()
  })

  // 10/12: while a new range loads, the figures on screen keep their own range's name, dimmed.
  it('another range keeps the last figures under their own name, dimmed, until the new ones arrive', async () => {
    await render()
    let release!: () => void
    server.hold = new Promise<void>(r => { release = r })
    await click(button('Last year'))
    const summary = () => host.querySelector('.rrh-summary') as HTMLElement
    expect(summary().getAttribute('aria-busy')).toBe('true')
    expect(summary().textContent).toBe(rangeTitle({ from: lastMonth.from, to: lastMonth.to, allTime: false }))
    expect(host.querySelector('.rrh-card')!.getAttribute('aria-busy')).toBe('true')
    server.hold = null
    await act(async () => { release() })
    await until(() => summary().getAttribute('aria-busy') === null, 'last year')
    const ly = rangeOfPick('last_year', today) as { from: string; to: string }
    expect(summary().textContent).toBe(rangeTitle({ from: ly.from, to: ly.to, allTime: false }))
  })

  it('without "View all payments" the page says which permission it needs', async () => {
    server.propsFail = { response: { status: 403, data: { error: 'Insufficient permissions' } } }
    await render('View all payments')
    expect(text()).not.toContain('Insufficient permissions')
  })

  it('a property in the address that is not the viewer’s is not opened; the pick is asked, the view kept', async () => {
    server.properties = [MV, OP]
    await render('Pick a property', '?property=elsewhere&range=last_year')
    // Nothing of any property shows (the server answers 404 for one that is not theirs).
    expect(text()).not.toContain('Ana Ruiz')
    expect(host.querySelector('.rrh-head')).toBeNull()
    await click(host.querySelectorAll('.rrh-prop')[0] as HTMLElement)
    await until(() => historyGets().includes(historyPath('mv', rangeOfPick('last_year', today))), 'Mountain View, last year')
  })
})

const RANGE_LABELS = () => ['Last month', 'This quarter', 'Last quarter', 'This year', 'Last year', 'All time']

describe('the spreadsheet and the helpers', () => {
  const q = new URLSearchParams('propertyId=mv&from=2026-08&to=2026-09')

  // 10/13 (Nic): "Range totals INCLUDE moved-out folder households" — 10/13
  // review: so their bills in the range are a line above the Total, and the
  // Total is the lines above it added up.
  it('the CSV is the rows as on screen (months newest first), the folder\'s bills in the range and the totals when sent, then "Moved out, still owes"', () => {
    const marta = { invoiced: 515, lateFees: 20, paid: 0, credit: 0, workTrade: 0, owed: 515 }
    const h = history(q, {
      totals: { invoiced: 2082.47, lateFees: 80, paid: 990, credit: 0, workTrade: 0, owed: 1092.47 },
      movedOutTotals: marta,
      movedOutOwing: [{ key: 'lease:l9', leaseId: 'l9', householdId: 'm1', residents: [resident('m1', 'Marta Diaz')], spaces: ['RV 7'],
        owed: 515, months: [{ month: '2026-08', owed: 495 }, { month: '2026-09', owed: 20 }], leaseEnded: '2026-08-31', inRange: marta }],
    })
    const lines = rentRollCsv(h).trimEnd().split('\n')
    expect(lines[0]).toBe('Space,Tenant,Moved out,Invoiced,Late fees,Paid,Account credit,Work trade,Owed,Payment health,September 2026,August 2026')
    expect(lines[1]).toBe('RV 2,Ana Ruiz,,990,0,990,0,0,0,100%,Paid late +5,No bill')
    expect(lines[2]).toBe('RV 10,"Gerald Logue, Gina Logue",,577.47,60,0,0,0,577.47,50%,Owes +7,Paid')
    expect(lines[3]).toBe(',"Moved out, still owes — bills in this range",,515,20,0,0,0,515')
    expect(lines[4]).toBe(',Total,,2082.47,80,990,0,0,1092.47')
    // The Total is the lines above it, column by column.
    const nums = (l: string) => l.replace(/^.*?,,/, '').split(',').slice(0, 6).map(Number)
    const sum = [lines[1], lines[2]].map(l => l.replace(/^RV \d+,(?:"[^"]*"|[^,]*),,/, '').split(',').slice(0, 6).map(Number))
      .concat([nums(lines[3])]).reduce((s, xs) => s.map((v, i) => Math.round((v + xs[i]) * 100) / 100))
    expect(sum).toEqual(nums(lines[4]))
    expect(lines.slice(5)).toEqual(['', '"Moved out, still owes"',
      'Space,Tenant,Lease ended,Invoiced in range,Paid in range,Owed in range,Owed,Still owes for',
      'RV 7,Marta Diaz,2026-08-31,515,0,515,515,August 2026 $495.00; September 2026 $20.00'])
    expect(csvFileName(h)).toBe('rent-roll-mountain-view-rv-ranch-2026-08-to-2026-09.csv')
    expect(csvFileName({ ...h, allTime: true })).toBe('rent-roll-mountain-view-rv-ranch-all-time.csv')
    expect(csvFileName({ ...h, from: '2026-09' })).toBe('rent-roll-mountain-view-rv-ranch-2026-09.csv')
  })

  // 10/12: names are typed by tenants; one that starts like a formula must not run in Excel.
  it('a CSV field that starts like a formula reads as text; numbers stay numbers', () => {
    expect(csvField('=HYPERLINK("http://x","y")')).toBe(`"'=HYPERLINK(""http://x"",""y"")"`)
    expect(csvField('+1 555')).toBe(`'+1 555`)
    expect(csvField('-x')).toBe(`'-x`)
    expect(csvField('@sum')).toBe(`'@sum`)
    expect(csvField(-5)).toBe('-5')
    expect(csvField('Gerald Logue')).toBe('Gerald Logue')
    expect(csvLine(['a,b', 3, null])).toBe('"a,b",3,')
    const h = history(q, { rows: [{ ...ana(['2026-08', '2026-09']), residents: [resident('x', '=cmd()')] }] })
    expect(rentRollCsv(h).split('\n')[1]).toMatch(/^RV 2,'=cmd\(\),/)
  })

  it('the range on screen in words; a month’s counts in words and colors; newest first', () => {
    expect(rangeTitle({ from: '2026-09', to: '2026-09', allTime: false })).toBe('September 2026')
    expect(rangeTitle({ from: '2026-07', to: '2026-09', allTime: false })).toBe('July – September 2026')
    expect(rangeTitle({ from: '2025-11', to: '2026-01', allTime: false })).toBe('November 2025 – January 2026')
    expect(rangeTitle({ from: '2026-03', to: '2026-10', allTime: true })).toBe('All time · March – October 2026')
    expect(monthCountWords({ month: '2026-10', counts: [
      { status: 'paid', label: 'Paid', households: 8 }, { status: 'paid_late', label: 'Paid late', households: 3 },
      { status: 'partial', label: 'Partial', households: 0 },
    ] })).toEqual([{ status: 'paid', text: '8 paid', color: 'green' }, { status: 'paid_late', text: '3 paid late', color: 'orange' }])
    expect(monthCountWords(undefined)).toEqual([])
    expect(newestFirst(['2026-08', '2026-09', '2026-10'])).toEqual(['2026-10', '2026-09', '2026-08'])
    expect(newestFirst(undefined)).toEqual([])
  })
})

// 10/13 (Nic), round 3: "show stays as an aggregate by line items. eg 22 nights
// paid for via pos and 1 week paid for via pos … dont put these stays in the
// spot put them below with expandable notes. 4 nights in 15 and 8 nights in 18 etc."
describe('10/13 (Nic), round 3: the stays below the rows, by line item, with expandable notes', () => {
  const stays = (paid: boolean) => [
    { key: 'night:pos', unit: 'night', via: 'pos', quantity: 22, label: '22 nights paid for via POS', stays: 4,
      ...(paid ? { paid: 880 } : {}),
      sites: [
        { space: 'RV 15', quantity: 4, stays: 1, label: '4 nights in RV 15' },
        { space: 'RV 18', quantity: 8, stays: 2, label: '8 nights in RV 18' },
        { space: 'RV 20', quantity: 10, stays: 1, label: '10 nights in RV 20' },
      ] },
    { key: 'week:pos', unit: 'week', via: 'pos', quantity: 1, label: '1 week paid for via POS', stays: 1,
      ...(paid ? { paid: 280 } : {}), sites: [{ space: 'RV 12', quantity: 1, stays: 1, label: '1 week in RV 12' }] },
  ]

  it('a Stays card below the households, never in a space\'s row; each line opens to its notes per site', async () => {
    server.history = q => history(q, { stays: stays(true), totals: { invoiced: 1567.47, lateFees: 60, paid: 990, credit: 0, workTrade: 0, owed: 577.47 } })
    await render()
    const card = host.querySelector('[data-section="stays"]')!
    expect(card).not.toBeNull()
    // Below the households' table.
    const tableCard = host.querySelector('.rrh-card')!
    expect(tableCard.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // No stay in any space's row.
    expect(tableCard.textContent).not.toContain('nights')
    expect(card.querySelector('.rrh-stays-head')!.textContent).toBe('Stays5 stays')
    const heads = [...card.querySelectorAll('button.rrh-stay-head')]
    expect(heads.map(b => b.textContent)).toEqual(['22 nights paid for via POS$880.00', '1 week paid for via POS$280.00'])
    expect(heads.map(b => b.getAttribute('aria-expanded'))).toEqual(['false', 'false'])
    expect(card.querySelector('.rrh-stay-notes')).toBeNull()
    await click(heads[0] as HTMLElement)
    expect([...card.querySelectorAll('li[data-line="night:pos"] .rrh-stay-notes li')].map(li => li.textContent))
      .toEqual(['4 nights in RV 15', '8 nights in RV 18', '10 nights in RV 20'])
    expect(card.querySelector('li[data-line="week:pos"] .rrh-stay-notes')).toBeNull()
    await click(heads[0] as HTMLElement)
    expect(card.querySelector('.rrh-stay-notes')).toBeNull()
  })

  it('without the range totals, the lines and notes but never their money; none at all, no card', async () => {
    server.history = q => history(q, { stays: stays(false) })
    await render()
    expect([...host.querySelectorAll('button.rrh-stay-head')].map(b => b.textContent))
      .toEqual(['22 nights paid for via POS', '1 week paid for via POS'])
    act(() => root.unmount())
    root = createRoot(host)
    server.history = q => history(q, { stays: [] })
    await render()
    expect(host.querySelector('[data-section="stays"]')).toBeNull()
  })

  it('the spreadsheet carries the same lines, with their notes, after the rest', () => {
    const h = history(new URLSearchParams('propertyId=mv&from=2026-09&to=2026-09'), { stays: stays(true) })
    const lines = rentRollCsv(h).trimEnd().split('\n')
    expect(lines.slice(-5)).toEqual([
      '', 'Stays', 'Line item,Stays,Paid,Sites',
      '22 nights paid for via POS,4,880,4 nights in RV 15; 8 nights in RV 18; 10 nights in RV 20',
      '1 week paid for via POS,1,280,1 week in RV 12',
    ])
    const noMoney = rentRollCsv(history(new URLSearchParams('propertyId=mv&from=2026-09&to=2026-09'), { stays: stays(false) })).trimEnd().split('\n')
    expect(noMoney.slice(-3)).toEqual(['Line item,Stays,Sites', '22 nights paid for via POS,4,4 nights in RV 15; 8 nights in RV 18; 10 nights in RV 20', '1 week paid for via POS,1,1 week in RV 12'])
    expect(staysMeta([{ stays: 1 }])).toBe('1 stay')
  })
})

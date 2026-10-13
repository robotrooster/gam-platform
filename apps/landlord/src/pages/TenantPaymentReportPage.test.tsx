/**
 * 10/12 (Nic) — the tenant payment report (/tenants/:id/report), printable:
 *
 *   "household-wide; summary (payment health %, months on time / late /
 *    partial / outstanding over the window); HOW LATE: each late month's days
 *    past grace, plus the pattern (median and range, e.g. 'usually 1-2 days
 *    past grace'); PARTIALS: count, average partial amount, average days to
 *    settle the rest; full charge history with a 'What it's for' column …"
 *
 * Every figure is the server's; the page says it. Days late are days past the
 * grace period, and a charge still owed inside its grace is "Not late yet",
 * never "On time".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from 'react-query'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

const server = vi.hoisted(() => ({ report: null as any, gets: [] as string[], fail: null as any }))
vi.mock('../lib/api', () => ({
  api: {
    get: async (url: string) => {
      server.gets.push(url)
      if (server.fail) throw server.fail
      if (url === '/tenants/t1/payment-report') return { data: { success: true, data: JSON.parse(JSON.stringify(server.report)) } }
      throw new Error(`unexpected api.get ${url}`)
    },
  },
}))

import { TenantPaymentReportPage } from './TenantPaymentReportPage'
import { healthColor, lineLateness } from '../lib/paymentStamps'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const stamp = (month: string, s: string | null, over: any = {}) => ({
  month, stamp: s, stampLabel: s, daysPastGrace: 0, charged: s ? 495 : 0, paid: 0, credit: 0, workTrade: 0, owed: 0,
  paidInFullOn: null, onboarding: false, workTradeOnly: false, counted: !!s, ...over,
})
const line = (over: any = {}) => ({
  paymentId: 'p1', householdId: 'g1', month: '2026-10', dueDate: '2026-10-01', label: 'Rent', detail: null, type: 'rent',
  unitNumber: 'RV 48', propertyName: 'Mountain View', charged: 495, paid: 0, credit: 0, workTrade: 0, owed: 495, paidOn: null,
  howPaid: null, daysPastGrace: 7, invoiceId: 'i10', isLateFee: false, ...over,
})

function report(over: any = {}) {
  return {
    householdId: 'g1',
    members: [{ tenantId: 'g1', name: 'Gerald Logue', role: 'primary' }, { tenantId: 'g2', name: 'Gina Logue', role: 'co_tenant' }],
    name: 'Gerald Logue',
    leases: [{ leaseId: 'l1', propertyName: 'Mountain View', unitNumber: 'RV 48', status: 'active', leaseTypeLabel: 'Month to month',
      startDate: '2026-09-01', endDate: null, rentAmount: 495, rentDueDay: 1, graceDays: 5, graceSourceLabel: "the property's",
      firstLateDayText: 'the 6th',
      lateFeeTerms: '$5 a day, counted back to the due date once the grace period has passed; no cap', existingTenancy: true,
      delinquent: true, evictionMode: false }],
    onGamSince: '2026-09', onboardingMonth: '2026-09', balanceOwedNow: 577.47,
    // 10/12 (Nic): all time — from the household's first bill on GAM, oldest first on the wire.
    health: { percent: 50, onTime: 1, counted: 2, paidLate: 0, partial: 0, outstanding: 1, notCounted: 0, workTrade: 0,
      from: '2026-09', through: '2026-10', label: '50%, 1 of 2 months' },
    stamps: [
      stamp('2026-09', 'paid_on_time', { onboarding: true, paid: 495, paidInFullOn: '2026-09-17' }),
      stamp('2026-10', 'outstanding', { daysPastGrace: 7, owed: 577.47 }),
    ],
    howLate: {
      months: [{ month: '2026-10', daysPastGrace: 7, paidInFullOn: null, stillOpen: true, firstLateDay: '2026-10-06' }],
      pattern: null, median: null, min: null, max: null, average: null,
      distribution: [
        { bucket: 'within_grace', label: 'Paid within grace', months: 1 },
        { bucket: 'd1_3', label: '1–3 days past grace', months: 0 },
      ],
      worst: { month: '2026-10', daysPastGrace: 7 }, trend: null,
    },
    partials: { months: 0, averageFirstPayment: null, averageFirstPercent: null, averageDaysToSettle: null, open: [] },
    lateFees: { charged: 60, paid: 0, credit: 0, owed: 60, months: 1 },
    creditApplied: 0,
    workTrade: { monthsCovered: 0, valueCovered: 0, byCharge: [], agreements: [], hours: [] },
    history: [
      line(),
      line({ paymentId: 'e1', label: 'Electric', detail: 'September usage', type: 'utility', charged: 22.47, owed: 22.47, daysPastGrace: 0 }),
      line({ paymentId: 'f1', label: 'Late fees, 12 days', type: 'late_fee', isLateFee: true, charged: 60, owed: 60, daysPastGrace: 0,
        lateFeeCount: 12, lateFeeFrom: '2026-10-01', lateFeeTo: '2026-10-12',
        lateFees: Array.from({ length: 12 }, (_, i) => line({ paymentId: `f${i + 1}`, label: 'Late fee', type: 'late_fee', isLateFee: true, charged: 5, owed: 5 })) }),
      line({ paymentId: 's1', month: '2026-09', dueDate: '2026-09-01', charged: 495, paid: 495, owed: 0, paidOn: '2026-09-17',
        howPaid: 'Card · online', daysPastGrace: 0, invoiceId: 'i9' }),
    ],
    ...over,
  }
}

let host: HTMLDivElement
let root: Root
beforeEach(() => { server.gets = []; server.fail = null; server.report = report(); host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host) })
afterEach(() => { act(() => root.unmount()); host.remove() })

const text = () => host.textContent ?? ''
async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 150; i++) {
    if (check()) return
    await act(async () => { await new Promise(r => setTimeout(r, 10)) })
  }
  throw new Error(`timed out waiting for ${what}\n${text()}`)
}
async function render(wait = 'Payment report') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    root.render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/tenants/t1/report']}>
          <Routes><Route path="/tenants/:id/report" element={<TenantPaymentReportPage />} /></Routes>
        </MemoryRouter>
      </QueryClientProvider>)
  })
  await until(() => text().includes(wait), 'the report')
}

describe('the tenant payment report', () => {
  it('the household, its health, the lease terms in words and how late — always days past grace', async () => {
    await render()
    expect(server.gets).toEqual(['/tenants/t1/payment-report'])
    expect(text()).toContain('Payment report — Gerald Logue')
    expect(text()).toContain('Household: Gerald Logue, Gina Logue')
    expect(text()).toContain('50%, 1 of 2 months')
    // 10/12: the first late day is the server's (services/lateness), never grace + 1.
    expect(text()).toContain("5 days (the property's) — late from the 6th")
    expect(text()).toContain('$5 a day, counted back to the due date')
    expect(text()).toContain('Existing tenancy — the first month is good news only')
    expect(text()).toContain('Delinquent')
    // Nothing paid late yet: the open month is listed "so far", not as a pattern.
    expect(text()).toContain('Nothing paid late yet')
    expect(text()).toContain('7 so far')
    // Stamps carry letters as well as colors.
    expect([...host.querySelectorAll('.tr-strip .rr-stamp')].map(s => s.textContent)).toContain('O+7')
  })

  // 10/12 (Nic): "payment health and a tenant's history are ALL-TIME (since the
  // household joined GAM), not 12 months."
  it('all time: every month since the first bill, newest first, a past year marked', async () => {
    server.report = report({
      health: { percent: 67, onTime: 2, counted: 3, paidLate: 0, partial: 0, outstanding: 1, notCounted: 0, workTrade: 0,
        from: '2025-12', through: '2026-10', label: '67%, 2 of 3 months' },
      stamps: [
        stamp('2025-12', 'paid_on_time', { paid: 495, paidInFullOn: '2025-12-02' }),
        ...['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08'].map(m => stamp(m, null)),
        stamp('2026-09', 'paid_on_time', { paid: 495, paidInFullOn: '2026-09-17' }),
        stamp('2026-10', 'outstanding', { daysPastGrace: 7, owed: 577.47 }),
      ],
    })
    await render()
    expect(text()).toContain('Months, all time')
    expect(text()).not.toContain('last 12')
    expect(text()).toContain('All time: December 2025 – October 2026')
    const months = [...host.querySelectorAll('.tr-strip .rr-stamp-month')].map(s => s.textContent)
    expect(months).toHaveLength(11)
    expect(months[0]).toBe('Oct')
    expect(months[1]).toBe('Sep')
    expect(months[10]).toBe('Dec’25')
  })

  it('every charge says what it is for; daily late fees are one line that opens to the days', async () => {
    await render()
    const table = [...host.querySelectorAll('table.tr-history')].pop()!
    expect(table.textContent).toContain("What it's for")
    expect(table.textContent).toContain('Electric')
    expect(table.textContent).toContain('September usage')
    expect(table.textContent).toContain('Late fees, 12 days')
    expect(table.textContent).toContain('Card · online')
    // A charge still owed inside its grace is not "On time".
    expect(table.textContent).toContain('Not late yet')
    expect(table.querySelectorAll('tr.tr-fees')).toHaveLength(0)
    const show = [...table.querySelectorAll('button')].find(b => b.textContent === 'show days') as HTMLButtonElement
    await act(async () => { show.click() })
    expect(table.querySelectorAll('tr.tr-fees')).toHaveLength(12)
  })

  it('partial payments: how many, the average first payment, the days to settle the rest, and what is still open', async () => {
    server.report = report({
      partials: { months: 2, averageFirstPayment: 200, averageFirstPercent: 40, averageDaysToSettle: 6.5,
        open: [{ month: '2026-10', owed: 295, daysSinceFirstPayment: 9 }] },
    })
    await render()
    expect(text()).toContain('Months paid in parts2')
    expect(text()).toContain('Average first payment$200.00')
    expect(text()).toContain('40%')
    expect(text()).toContain('Average days to pay the rest6.5')
    expect(text()).toContain('$295.00 · 9 days since the first payment')
  })

  it('the Print button is gold and the server\'s refusal is said in its words', async () => {
    await render()
    const print = [...host.querySelectorAll('button')].find(b => /Print/.test(b.textContent ?? ''))!
    expect(print.className).toContain('btn-primary')
    act(() => root.unmount())
    root = createRoot(host)
    server.fail = { response: { status: 404, data: { error: 'There is no payment history for this resident at the properties you can see.' } } }
    await render('There is no payment history')
  })

  it('a 403 says which permission it needs, never the server\'s "Insufficient permissions"', async () => {
    server.fail = { response: { status: 403, data: { error: 'Insufficient permissions' } } }
    await render('View all payments')
    expect(text()).not.toContain('Insufficient permissions')
    expect([...host.querySelectorAll('button')].some(b => /Read it again/.test(b.textContent ?? ''))).toBe(false)
  })
})

describe('the shared words and colors', () => {
  // 10/12 (Nic): "CSV-imported old payment history does NOT count toward
  // payment health … imported history still shows in the report."
  it('imported history is its own section, each line labeled with where it came from; none means no section', async () => {
    await render()
    expect(text()).not.toContain('Imported history')
    act(() => root.unmount())
    root = createRoot(host)
    server.report = report({ imported: [
      { paymentId: 'x1', householdId: 'g1', paidOn: '2026-07-14', label: 'Rent', type: 'rent', unitNumber: 'RV 48', propertyId: 'mv',
        propertyName: 'Mountain View', amount: 495, importedFrom: 'Buildium', method: 'Check', reference: '1042' },
      { paymentId: 'x2', householdId: 'g1', paidOn: '2026-06-01', label: 'Rent', type: 'rent', unitNumber: 'RV 48', propertyId: 'mv',
        propertyName: 'Mountain View', amount: 495, importedFrom: 'your previous software', method: null, reference: null },
    ] })
    await render()
    const section = [...host.querySelectorAll('.tr-section')].find(s => s.textContent?.includes('Imported history'))!
    expect(section).toBeTruthy()
    expect(section.textContent).toContain('Payments brought in from Buildium, your previous software.')
    // 10/12 (Nic) review: the import takes any date, so the page never claims the payments came before GAM.
    expect(section.textContent).not.toContain('made before')
    expect(section.textContent).toContain('never count toward payment health')
    const rows = [...section.querySelectorAll('tbody tr')].map(r => [...r.querySelectorAll('td')].map(td => td.textContent))
    expect(rows[0]).toEqual(['Jul 14, 2026', 'RentReference 1042', 'RV 48', '$495.00', 'Check', 'Imported from Buildium'])
    expect(rows[1][5]).toBe('Imported from your previous software')
    expect(rows[1][4]).toBe('—')
    // The health card is the server's, untouched by the imports.
    expect(text()).toContain('50%, 1 of 2 months')
  })

  it('one health color everywhere: 90 green, 75 amber, below red, gray before a month is judged', () => {
    expect(healthColor(95)).toBe('var(--green)')
    expect(healthColor(75)).toBe('var(--amber)')
    expect(healthColor(72)).toBe('var(--red)')
    expect(healthColor(null)).toBe('var(--text-3)')
  })
  it('a line\'s lateness: days past grace, on time once paid, not late yet while owed, nothing for a late fee', () => {
    expect(lineLateness({ isLateFee: false, daysPastGrace: 3, owed: 0, workTrade: 0 })).toBe('3')
    expect(lineLateness({ isLateFee: false, daysPastGrace: 0, owed: 0, workTrade: 0 })).toBe('On time')
    expect(lineLateness({ isLateFee: false, daysPastGrace: 0, owed: 495, workTrade: 0 })).toBe('Not late yet')
    expect(lineLateness({ isLateFee: true, daysPastGrace: 0, owed: 5, workTrade: 0 })).toBe('—')
  })
})

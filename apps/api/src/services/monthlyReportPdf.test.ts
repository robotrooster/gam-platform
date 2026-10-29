/**
 * 10/12 (Nic) — the monthly property report as a PDF ("EMAILED at month close
 * WITH A PDF attachment so they can put it to their books"; the PDF includes
 * tenant names). It builds, it carries every group's figures and the names,
 * it survives words Helvetica cannot draw, and the file is named for the
 * company and month. No database: the report is built by hand.
 */
import zlib from 'zlib'
import { describe, it, expect } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { renderMonthlyReportPdf, monthlyReportFilename, pdfText, pdfMoney } from './monthlyReportPdf'
import { moneyViewFrom, type IncomeEvent } from './incomeBasis'
import type { MonthlyPropertyReport, ReportProperty } from './monthlyPropertyReport'

/** pdf-lib deflates its streams and draws text as <hex> Tj: inflate and decode them. */
function pdfWords(buf: Buffer): string {
  const hay = buf.toString('latin1')
  const out: string[] = []
  for (const m of hay.matchAll(/<<([^>]*)>>\s*stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    if (!/\/Filter\s*\/FlateDecode/.test(m[1] ?? '')) continue
    const raw = Buffer.from(m[2] ?? '', 'latin1')
    for (const f of [() => zlib.inflateSync(raw), () => zlib.inflateSync(Buffer.concat([raw, Buffer.from('\r', 'latin1')])),
                     () => zlib.inflateSync(raw, { finishFlush: zlib.constants.Z_SYNC_FLUSH })]) {
      try { out.push(f().toString('latin1')); break } catch { /* next */ }
    }
  }
  return out.join('\n').replace(/<([0-9A-Fa-f\s]+)>\s*Tj/g, (_, hex: string) => {
    const h = hex.replace(/\s+/g, '')
    const bytes: number[] = []
    for (let i = 0; i + 1 < h.length; i += 2) bytes.push(parseInt(h.slice(i, i + 2), 16))
    return Buffer.from(bytes).toString('latin1')
  })
}

const ev = (o: Partial<IncomeEvent> & Pick<IncomeEvent, 'line' | 'amount' | 'day'>): IncomeEvent => ({
  landlordId: 'l', propertyId: 'p', unitId: null, leaseId: null, paymentId: null, dueDate: null,
  category: null, part: null, inTotal: true, moveOutId: null, ...o,
})

function property(name: string, late: Array<{ name: string; days: number; owed: number }>): ReportProperty {
  const period = { start: '2026-09-01', end: '2026-09-30', label: 'September 2026' }
  const view = moneyViewFrom(
    [ev({ line: 'rent', category: 'space_rent', amount: 1100, day: '2026-09-01', dueDate: '2026-09-01', part: 'paid' }),
     ev({ line: 'lateFees', category: 'late_fees', amount: 25, day: '2026-09-07', dueDate: '2026-09-07', part: 'stillOwed' })],
    [ev({ line: 'rent', category: 'space_rent', amount: 1100, day: '2026-09-03', dueDate: '2026-09-01' }),
     ev({ line: 'depositsHeld', amount: 500, day: '2026-09-01', inTotal: false })],
    period)
  return {
    property: { id: name, name, city: 'Phoenix', state: 'AZ' },
    tenants: {
      leasesStarted: 1, leasesRenewed: 0, existingOnboarded: 0, leasesEnded: 1, moveIns: 1, moveOuts: 1,
      spaces: 3, occupied: 2, vacant: 1, occupancyPercent: 67, occupancyAsOf: '2026-09-30', occupancyFrom: 'month_end_snapshot',
    },
    payments: {
      counts: [
        { stamp: 'paid_on_time', label: 'Paid on time', households: 1 },
        { stamp: 'paid_late', label: 'Paid late', households: late.length },
        { stamp: 'partial', label: 'Partial', households: 0 },
        { stamp: 'outstanding', label: 'Outstanding', households: 0 },
        { stamp: 'due', label: 'Due', households: 0 },
      ],
      households: 1 + late.length,
      late: late.map((l, i) => ({ householdId: `h${i}`, name: l.name, units: [`A${i + 2}`], stamp: 'paid_late', stampLabel: 'Paid late', daysPastGrace: l.days, owed: l.owed })),
    },
    money: {
      view,
      expenses: { lines: [{ key: 'platformFee', label: 'GAM platform fee', amount: 10 }, { key: 'processingFees', label: 'Payment processing fees', amount: 0 }], total: 10 },
      net: { received: 1090, charged: 1115 },
      workTradeCovered: 0, depositsReceived: 500, depositsReturned: 300,
    },
    operations: {
      utilityCycle: 'September 2026',
      utilities: [{ utility: 'water', label: 'Water', billedBack: 185, utilityBill: 200 }, { utility: 'electric', label: 'Electric', billedBack: 40, utilityBill: null }],
      utilityExpensesLogged: 80,
      maintenance: { opened: 2, closed: 1, cost: 75 },
      stays: { stays: 1, nights: 3, bookedThisMonth: 1 },
    },
  }
}

function report(props: ReportProperty[], company = 'Owner Parks LLC'): MonthlyPropertyReport {
  const one = props[0]
  return {
    company: { id: 'c', name: company }, month: '2026-09', monthLabel: 'September 2026',
    period: { start: '2026-09-01', end: '2026-09-30' }, generatedAt: '2026-10-02T15:00:00.000Z',
    properties: props,
    notInTotals: null,
    totals: {
      tenants: { ...one.tenants },
      payments: { counts: one.payments.counts, households: 2, late: 1 },
      money: { ...one.money },
      operations: { maintenance: one.operations.maintenance, stays: one.operations.stays, utilityExpensesLogged: 80 },
    },
  }
}

describe('the monthly report PDF', () => {
  it('builds a real PDF with all four groups, the tie line and the late households by name', async () => {
    const buf = await renderMonthlyReportPdf(report([property('Alpha Park', [{ name: 'Bob Baker', days: 7, owed: 25 }])]))
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-')
    const doc = await PDFDocument.load(buf)
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(1)
    expect(doc.getTitle()).toBe('Monthly property report - Owner Parks LLC - September 2026')
    const words = pdfWords(buf)
    for (const s of [
      'MONTHLY PROPERTY REPORT', 'Owner Parks LLC', 'Alpha Park',
      'TENANTS AND LEASES', 'Move-ins', 'Move-outs',
      'Bob Baker', 'Days past grace', 'Paid late: 1',
      'Charged', 'Received', 'Owed', 'Lot/space rent', '$1,125.00', '$1,100.00',
      'Of $1,125.00 charged, $1,100.00 is collected and $25.00 is still owed.',
      'Payment processing fees', 'Income less expenses', 'Deposits returned', '$300.00',
      "The utility's own bill", 'Not entered', 'Maintenance closed', 'Nights stayed this month',
    ]) expect(words, s).toContain(s)
  })

  it('a company with several properties gets a cover with every property added up, then one section each', async () => {
    const buf = await renderMonthlyReportPdf(report([
      property('Alpha Park', [{ name: 'Bob Baker', days: 7, owed: 25 }]),
      property('Bravo Park', []),
    ]))
    const doc = await PDFDocument.load(buf)
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(3)
    const words = pdfWords(buf)
    expect(words).toContain('ALL PROPERTIES')
    expect(words).toContain('Bravo Park')
    expect(words).toContain('Nobody is past the grace period for this month.')
    expect(words).toMatch(/Page 1 of \d+/)
  })

  it('Received leads every money table, and the whole company\'s money no property holds is named beside the totals (10/12)', async () => {
    const r = report([property('Alpha Park', []), property('Bravo Park', [])])
    const buf = await renderMonthlyReportPdf({ ...r, notInTotals: { received: 0, charged: 0, expenses: 50 } })
    const words = pdfWords(buf)
    expect(words.indexOf('Net on received')).toBeGreaterThan(-1)
    expect(words.indexOf('Net on received')).toBeLessThan(words.indexOf('Net on charged'))
    expect(words).toContain('Booked to the company')
    expect(words).toContain('$50.00')
  })

  it('a name Helvetica cannot draw never stops the render', async () => {
    const buf = await renderMonthlyReportPdf(report([property('Ōkubo Park — East', [{ name: 'Zoë Ng 李', days: 3, owed: -0 }])], 'Owner “Parks” LLC'))
    const words = pdfWords(buf)
    expect(words).toContain('Zoë Ng ?')
    expect(words).toContain('?kubo Park -- East')
    expect(pdfText('−$12.00 — “ok” …')).toBe('-$12.00 -- "ok" ...')
    expect(pdfMoney(-12)).toBe('-$12.00')
    expect(pdfMoney(1234.5)).toBe('$1,234.50')
  })

  // 10/12 (Nic) review: "Occupancy 100%, counted Sep 30" was not true once
  // occupied meant the spaces GAM billed for the month (a space empty from the
  // 15th still counts). The line says what each number is.
  it('says what the occupancy figure is: occupied = spaces GAM billed for the month; the day the spaces were counted', async () => {
    const snap = pdfWords(await renderMonthlyReportPdf(report([property('Alpha Park', [])])))
    expect(snap).toContain('Occupancy 67%: occupied = spaces GAM billed for September 2026; spaces counted Sep 30, 2026.')
    const p = property('Alpha Park', [])
    const today = pdfWords(await renderMonthlyReportPdf(report([
      { ...p, tenants: { ...p.tenants, occupancyAsOf: '2026-10-12', occupancyFrom: 'today' } }])))
    expect(today).toContain('occupied = spaces GAM billed for September 2026; spaces counted today (Oct 12, 2026); no month-end count was taken.')
    expect(today).not.toMatch(/counted Sep 30/)
  })

  it('an empty report still builds', async () => {
    const r = report([property('Alpha Park', [])])
    const buf = await renderMonthlyReportPdf({ ...r, properties: [] })
    expect(pdfWords(buf)).toContain('No properties to report on for this month.')
  })

  it('the file is named for the company and the month', () => {
    expect(monthlyReportFilename({ company: { id: 'c', name: 'Owner Parks, LLC' }, month: '2026-09' })).toBe('Monthly-report-Owner-Parks-LLC-2026-09.pdf')
    expect(monthlyReportFilename({ company: { id: 'c', name: '' }, month: '2026-09' })).toBe('Monthly-report-company-2026-09.pdf')
  })
})

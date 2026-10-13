/**
 * 10/12 (Nic) — THE MONTHLY PROPERTY REPORT AS A PDF.
 *
 *   "EMAILED at month close WITH A PDF attachment so they can put it to
 *    their books." The PDF includes tenant names (Nic chose "email with PDF").
 *
 * Draws services/monthlyPropertyReport's figures — never computes one — with
 * pdf-lib, the library services/flexsuitePdf already uses (no new
 * dependency). Landscape letter, white page, dark text and gold rules, so it
 * prints the way the screen reads. One cover with every property added up
 * (when there is more than one), then one section per property in Nic's four
 * groups: tenants & leases, payments (the colored stamps), money (Received /
 * Charged / Owed side by side — 10/12, Nic: Received leads — how they tie,
 * expenses, net), operations.
 *
 * Buffer out, nothing written to disk: the email attaches it, the report page
 * streams it.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage, type RGB } from 'pdf-lib'
import { MONEY_COLUMNS, MONEY_COLUMN_LABEL, MONEY_COLUMN_NOTE, PAYMENT_STAMP_LETTER, type PaymentStamp } from '@gam/shared'
import type { MonthlyPropertyReport, ReportProperty, ReportPayments } from './monthlyPropertyReport'
import type { MoneyView } from './incomeBasis'

const PAGE_W = 792    // 11" landscape
const PAGE_H = 612    // 8.5"
const MX = 36
const TOP = 40
const BOTTOM = 40
const W = PAGE_W - MX * 2

const INK = rgb(0.10, 0.11, 0.13)
const MUTED = rgb(0.42, 0.44, 0.48)
const RULE = rgb(0.82, 0.83, 0.85)
const ZEBRA = rgb(0.965, 0.965, 0.97)
const HEAD_BG = rgb(0.93, 0.93, 0.94)
const GOLD = rgb(0.72, 0.56, 0.13)
const BAND = rgb(0.05, 0.07, 0.10)

/** 10/12 (Nic): the stamp colors — green paid, yellow partial, orange paid late, red outstanding, gray due. */
export const STAMP_PDF_COLOR: Record<PaymentStamp, RGB> = {
  paid_on_time: rgb(0.16, 0.6, 0.33),
  partial:      rgb(0.93, 0.76, 0.12),
  paid_late:    rgb(0.93, 0.49, 0.13),
  outstanding:  rgb(0.82, 0.2, 0.2),
  due:          rgb(0.62, 0.63, 0.66),
}

/**
 * Helvetica draws WinAnsi only. The few characters the report's own words use
 * are mapped; anything else outside Latin-1 (a resident's name in another
 * script) becomes '?', never a crash mid-render.
 */
export function pdfText(s: unknown): string {
  return String(s ?? '')
    .replace(/[−–]/g, '-')     // minus, en dash
    .replace(/—/g, '--')            // em dash
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, '...')
    .replace(/ /g, ' ')
    .replace(/•/g, '*')
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, '?')
}

/** Dollars for the page: $1,234.56 and -$12.00. */
export function pdfMoney(n: number | null | undefined): string {
  if (n == null || !isFinite(Number(n))) return '-'
  const v = Math.round(Number(n) * 100) / 100
  return `${v < 0 ? '-' : ''}$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/** "Sep 30, 2026" for a calendar day. */
function dayWords(ymd: string): string {
  const [y, m, d] = ymd.slice(0, 10).split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}

interface Col { label: string; width: number; align?: 'left' | 'right' | 'center' }

class Layout {
  page!: PDFPage
  y = 0
  pages: PDFPage[] = []
  constructor(
    readonly doc: PDFDocument, readonly font: PDFFont, readonly bold: PDFFont,
    readonly headLeft: string, readonly headRight: string,
  ) {}

  newPage(withHead = true): void {
    this.page = this.doc.addPage([PAGE_W, PAGE_H])
    this.pages.push(this.page)
    this.y = PAGE_H - TOP
    if (withHead) {
      this.text(this.headLeft, MX, this.y, 9, this.bold, INK)
      const rw = this.font.widthOfTextAtSize(pdfText(this.headRight), 8)
      this.text(this.headRight, PAGE_W - MX - rw, this.y, 8, this.font, MUTED)
      this.y -= 6
      this.page.drawLine({ start: { x: MX, y: this.y }, end: { x: PAGE_W - MX, y: this.y }, thickness: 1, color: GOLD })
      this.y -= 16
    }
  }

  ensure(h: number): void {
    if (this.y - h < BOTTOM) this.newPage()
  }

  text(s: string, x: number, y: number, size: number, font: PDFFont = this.font, color: RGB = INK): void {
    this.page.drawText(pdfText(s), { x, y, size, font, color })
  }

  /** Wrap words to a width; returns the lines. */
  wrap(s: string, size: number, width: number, font: PDFFont = this.font): string[] {
    const out: string[] = []
    for (const para of pdfText(s).split('\n')) {
      let line = ''
      for (const w of para.split(/\s+/).filter(Boolean)) {
        const next = line ? `${line} ${w}` : w
        if (font.widthOfTextAtSize(next, size) <= width) line = next
        else { if (line) out.push(line); line = w }
      }
      out.push(line)
    }
    return out
  }

  paragraph(s: string, size = 8.5, color: RGB = INK, font: PDFFont = this.font): void {
    for (const l of this.wrap(s, size, W, font)) {
      this.ensure(size + 4)
      this.text(l, MX, this.y, size, font, color)
      this.y -= size + 3.5
    }
  }

  heading(s: string): void {
    this.ensure(48)
    this.y -= 4
    this.text(s.toUpperCase(), MX, this.y, 10, this.bold, GOLD)
    this.y -= 5
    this.page.drawLine({ start: { x: MX, y: this.y }, end: { x: PAGE_W - MX, y: this.y }, thickness: 0.5, color: RULE })
    this.y -= 13
  }

  /** Label/value pairs in `per` columns. */
  pairs(items: Array<[string, string]>, per = 4): void {
    const colW = W / per
    for (let i = 0; i < items.length; i += per) {
      this.ensure(26)
      items.slice(i, i + per).forEach(([k, v], j) => {
        const x = MX + j * colW
        this.text(k, x, this.y, 7.5, this.font, MUTED)
        this.text(v, x, this.y - 11, 10.5, this.bold, INK)
      })
      this.y -= 28
    }
  }

  table(cols: Col[], rows: string[][], opts: { totalRow?: boolean; bolds?: number[] } = {}): void {
    const rowH = 14
    const drawRow = (cells: string[], y: number, font: PDFFont, bg?: RGB) => {
      if (bg) this.page.drawRectangle({ x: MX, y: y - 4, width: W, height: rowH, color: bg })
      let x = MX
      cells.forEach((c, j) => {
        const col = cols[j]
        const size = 8.5
        let s = pdfText(c)
        while (s.length > 1 && font.widthOfTextAtSize(s, size) > col.width - 8) s = s.slice(0, -2) + '.'
        const tw = font.widthOfTextAtSize(s, size)
        const tx = col.align === 'right' ? x + col.width - 4 - tw : col.align === 'center' ? x + (col.width - tw) / 2 : x + 4
        this.text(s, tx, y, size, font, INK)
        x += col.width
      })
    }
    const head = () => {
      this.ensure(rowH * 2)
      drawRow(cols.map(c => c.label), this.y, this.bold, HEAD_BG)
      this.y -= rowH
    }
    head()
    rows.forEach((r, i) => {
      if (this.y - rowH < BOTTOM) { this.newPage(); head() }
      const isTotal = opts.totalRow && i === rows.length - 1
      if (isTotal) this.page.drawLine({ start: { x: MX, y: this.y + rowH - 4 }, end: { x: PAGE_W - MX, y: this.y + rowH - 4 }, thickness: 0.8, color: INK })
      drawRow(r, this.y, isTotal || opts.bolds?.includes(i) ? this.bold : this.font, !isTotal && i % 2 === 1 ? ZEBRA : undefined)
      this.y -= rowH
    })
    this.y -= 8
  }

  /** The colored stamp chips with their counts. */
  stamps(counts: ReportPayments['counts']): void {
    this.ensure(30)
    let x = MX
    for (const c of counts) {
      const box = 16
      this.page.drawRectangle({ x, y: this.y - 5, width: box, height: box, color: STAMP_PDF_COLOR[c.stamp] })
      const letter = PAYMENT_STAMP_LETTER[c.stamp]
      const lw = this.bold.widthOfTextAtSize(pdfText(letter), 9)
      this.text(letter, x + (box - lw) / 2, this.y - 0.5, 9, this.bold, rgb(1, 1, 1))
      const label = `${c.label}: ${c.households}`
      this.text(label, x + box + 5, this.y, 9, this.bold, INK)
      x += box + 5 + this.bold.widthOfTextAtSize(pdfText(label), 9) + 18
    }
    this.y -= 24
  }
}

const money = pdfMoney

/**
 * 10/12 review: the whole company's money that no property above holds (income
 * with no space behind it, the company's own costs) — beside the totals, so the
 * totals plus it are the month's P&L. The Reports page says the same words.
 */
export function notInTotalsWords(x: NonNullable<MonthlyPropertyReport['notInTotals']>): string {
  return `Booked to the company, not to a property in this report, so in none of its property figures: `
    + `${MONEY_COLUMN_LABEL.received.toLowerCase()} ${money(x.received)}, ${MONEY_COLUMN_LABEL.charged.toLowerCase()} ${money(x.charged)}, `
    + `expenses ${money(x.expenses)}. With these, the figures add up to the month's profit and loss.`
}

function moneyTable(L: Layout, view: MoneyView): void {
  const cols: Col[] = [
    { label: 'Category', width: 300 },
    { label: MONEY_COLUMN_LABEL.received, width: 140, align: 'right' },
    { label: MONEY_COLUMN_LABEL.charged, width: 140, align: 'right' },
    { label: MONEY_COLUMN_LABEL.owed, width: 140, align: 'right' },
  ]
  const rows = [
    ...view.categories.map(c => [c.label, money(c.received), money(c.charged), money(c.owed)]),
    ...view.uncategorized.map(c => [c.label, money(c.received), money(c.charged), money(c.owed)]),
  ]
  if (!rows.length) rows.push(['Nothing received or charged', money(0), money(0), money(0)])
  rows.push(['Total', money(view.received), money(view.charged), money(view.owed)])
  L.table(cols, rows, { totalRow: true })
  for (const t of view.tieText) L.paragraph(t, 8, MUTED)
  L.y -= 4
}

function propertySection(L: Layout, r: MonthlyPropertyReport, p: ReportProperty): void {
  const t = p.tenants
  L.ensure(60)
  L.text(p.property.name, MX, L.y, 16, L.bold, INK)
  const where = [p.property.city, p.property.state].filter(Boolean).join(', ')
  if (where) L.text(where, MX, L.y - 13, 8.5, L.font, MUTED)
  L.y -= where ? 30 : 22

  L.heading('Tenants and leases')
  L.pairs([
    ['Leases started', `${t.leasesStarted}`],
    ['Renewed (new lease, same household)', `${t.leasesRenewed}`],
    ['Leases ended', `${t.leasesEnded}`],
    ['Existing tenants moved onto GAM', `${t.existingOnboarded}`],
    ['Move-ins', `${t.moveIns}`],
    ['Move-outs', `${t.moveOuts}`],
    ['Occupied spaces', `${t.occupied} of ${t.spaces}`],
    ['Vacant spaces', `${t.vacant}`],
  ])
  // 10/12 (Nic) review: say what each number is — occupied is the spaces GAM
  // billed for the month (held at any point in it, the way the bill counts
  // them); the spaces are counted on the day named.
  L.paragraph(`Occupancy ${t.occupancyPercent == null ? '-' : `${t.occupancyPercent}%`}: occupied = spaces GAM billed for ${r.monthLabel}; `
    + (t.occupancyFrom === 'month_end_snapshot' ? `spaces counted ${dayWords(t.occupancyAsOf)}.` : `spaces counted today (${dayWords(t.occupancyAsOf)}); no month-end count was taken.`), 8, MUTED)

  L.heading(`Payments - bills due in ${r.monthLabel}, one stamp per household`)
  L.stamps(p.payments.counts)
  if (p.payments.late.length) {
    L.paragraph("Who's late (days past the grace period):", 8.5, INK, L.bold)
    L.table([
      { label: 'Household', width: 250 },
      { label: 'Space', width: 150 },
      { label: 'Status', width: 120 },
      { label: 'Days past grace', width: 100, align: 'right' },
      { label: 'Still owed', width: 100, align: 'right' },
    ], p.payments.late.map(h => [h.name, h.units.join(', '), h.stampLabel, `${h.daysPastGrace}`, money(h.owed)]))
  } else {
    L.paragraph('Nobody is past the grace period for this month.', 8.5, MUTED)
  }

  L.heading('Money - received, charged and owed')
  moneyTable(L, p.money.view)
  L.table([
    { label: 'Expenses', width: 580 },
    { label: 'Amount', width: 140, align: 'right' },
  ], [...p.money.expenses.lines.map(l => [l.label, money(l.amount)]), ['Total expenses', money(p.money.expenses.total)]], { totalRow: true })
  L.table([
    { label: 'Net', width: 300 },
    { label: `On ${MONEY_COLUMN_LABEL.received.toLowerCase()}`, width: 140, align: 'right' },
    { label: `On ${MONEY_COLUMN_LABEL.charged.toLowerCase()}`, width: 140, align: 'right' },
    { label: '', width: 140 },
  ], [['Income less expenses', money(p.money.net.received), money(p.money.net.charged), '']], { bolds: [0] })
  L.pairs([
    ['Covered by work trade (never money)', money(p.money.workTradeCovered)],
    ['Deposits received (held for tenants)', money(p.money.depositsReceived)],
    ['Deposits returned', money(p.money.depositsReturned)],
  ], 3)

  L.heading('Operations')
  if (p.operations.utilities.length) {
    L.table([
      { label: `Utility (${p.operations.utilityCycle} cycle)`, width: 240 },
      { label: 'Billed back to tenants', width: 160, align: 'right' },
      { label: "The utility's own bill", width: 160, align: 'right' },
      { label: 'Difference', width: 160, align: 'right' },
    ], p.operations.utilities.map(u => [
      u.label, money(u.billedBack), u.utilityBill == null ? 'Not entered' : money(u.utilityBill),
      u.utilityBill == null ? '-' : money(u.billedBack - u.utilityBill),
    ]))
  } else {
    L.paragraph('No utilities were billed back this cycle.', 8.5, MUTED)
  }
  L.pairs([
    ['Utility bills logged as expenses', money(p.operations.utilityExpensesLogged)],
    ['Maintenance opened', `${p.operations.maintenance.opened}`],
    ['Maintenance closed', `${p.operations.maintenance.closed}`],
    ['Maintenance cost', money(p.operations.maintenance.cost)],
    ['Stays (nightly and weekly)', `${p.operations.stays.stays}`],
    ['Nights stayed this month', `${p.operations.stays.nights}`],
    ['Stays booked this month', `${p.operations.stays.bookedThisMonth}`],
  ])
}

function cover(L: Layout, r: MonthlyPropertyReport): void {
  L.newPage(false)
  const band = 74
  L.page.drawRectangle({ x: 0, y: PAGE_H - band, width: PAGE_W, height: band, color: BAND })
  L.text('MONTHLY PROPERTY REPORT', MX, PAGE_H - 32, 15, L.bold, GOLD)
  L.text(`${r.company.name}  ·  ${r.monthLabel}`, MX, PAGE_H - 52, 10, L.font, rgb(0.85, 0.86, 0.88))
  const prep = `Prepared ${dayWords(r.generatedAt)} by Gold Asset Management from the company's own records.`
  L.text(prep, MX, PAGE_H - 65, 7.5, L.font, rgb(0.6, 0.62, 0.66))
  L.y = PAGE_H - band - 22
  L.paragraph(MONEY_COLUMNS.map(k => `${MONEY_COLUMN_LABEL[k]}: ${MONEY_COLUMN_NOTE[k]}`).join('  '), 7.5, MUTED)
  L.y -= 4
  if (r.properties.length <= 1) {
    if (r.notInTotals) L.paragraph(notInTotalsWords(r.notInTotals), 8, MUTED)
    return
  }
  L.heading('All properties')
  const rows = r.properties.map(p => [
    p.property.name,
    p.tenants.occupancyPercent == null ? '-' : `${p.tenants.occupancyPercent}%`,
    money(p.money.view.received), money(p.money.view.charged), money(p.money.view.owed),
    money(p.money.expenses.total), money(p.money.net.received), money(p.money.net.charged),
  ])
  const T = r.totals
  rows.push(['Total', T.tenants.occupancyPercent == null ? '-' : `${T.tenants.occupancyPercent}%`,
    money(T.money.view.received), money(T.money.view.charged), money(T.money.view.owed),
    money(T.money.expenses.total), money(T.money.net.received), money(T.money.net.charged)])
  L.table([
    { label: 'Property', width: 190 },
    { label: 'Occupancy', width: 60, align: 'right' },
    { label: MONEY_COLUMN_LABEL.received, width: 80, align: 'right' },
    { label: MONEY_COLUMN_LABEL.charged, width: 80, align: 'right' },
    { label: MONEY_COLUMN_LABEL.owed, width: 75, align: 'right' },
    { label: 'Expenses', width: 75, align: 'right' },
    { label: 'Net on received', width: 80, align: 'right' },
    { label: 'Net on charged', width: 80, align: 'right' },
  ], rows, { totalRow: true })
  for (const t of T.money.view.tieText) L.paragraph(t, 8, MUTED)
  if (r.notInTotals) L.paragraph(notInTotalsWords(r.notInTotals), 8, MUTED)
  L.y -= 6
  L.heading(`Payments - every property, bills due in ${r.monthLabel}`)
  L.stamps(T.payments.counts)
  L.pairs([
    ['Leases started', `${T.tenants.leasesStarted}`], ['Leases ended', `${T.tenants.leasesEnded}`],
    ['Move-ins', `${T.tenants.moveIns}`], ['Move-outs', `${T.tenants.moveOuts}`],
  ])
}

/** The report as a PDF (a Buffer to attach or stream). */
export async function renderMonthlyReportPdf(r: MonthlyPropertyReport): Promise<Buffer> {
  const doc = await PDFDocument.create()
  doc.setTitle(pdfText(`Monthly property report - ${r.company.name} - ${r.monthLabel}`))
  doc.setAuthor('Gold Asset Management')
  doc.setSubject(pdfText(`${r.monthLabel}: tenants and leases, payments, money, operations`))
  doc.setCreationDate(new Date(r.generatedAt))
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const L = new Layout(doc, font, bold, `Monthly property report · ${r.company.name}`, r.monthLabel)

  cover(L, r)
  r.properties.forEach((p, i) => {
    if (i > 0 || r.properties.length > 1) L.newPage()
    propertySection(L, r, p)
  })
  if (!r.properties.length) L.paragraph('No properties to report on for this month.', 10, MUTED)

  const n = L.pages.length
  L.pages.forEach((pg, i) => {
    const s = pdfText(`${r.company.name}  ·  ${r.monthLabel}  ·  Page ${i + 1} of ${n}`)
    pg.drawLine({ start: { x: MX, y: BOTTOM - 14 }, end: { x: PAGE_W - MX, y: BOTTOM - 14 }, thickness: 0.4, color: RULE })
    pg.drawText(s, { x: MX, y: BOTTOM - 26, size: 7, font, color: MUTED })
  })
  return Buffer.from(await doc.save())
}

/** "Monthly-report-Mountain-View-RV-2026-09.pdf" */
export function monthlyReportFilename(r: Pick<MonthlyPropertyReport, 'company' | 'month'>): string {
  const slug = pdfText(r.company.name).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'company'
  return `Monthly-report-${slug}-${r.month}.pdf`
}

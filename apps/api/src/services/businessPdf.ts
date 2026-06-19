/**
 * S504 — business-portal PDF generation.
 *
 * Four renderers, one shared template family:
 *
 *   renderInvoicePdf       — sent/paid/draft invoice with line items + totals + pay link
 *   renderWorkOrderPdf     — intake info + labor/parts lines + totals + closeout
 *   renderQuotePdf         — proposal with expires_at + status
 *   renderPosReceiptPdf    — receipt with line items + payment method + change
 *
 * Built on pdf-lib (already in this codebase for FlexSuite acceptance
 * snapshots). White background, dark text, gold accent strip on the
 * header — print-friendly + customer-shareable.
 *
 * All renderers return a Buffer; the caller pipes it to the HTTP
 * response with Content-Type: application/pdf. Nothing persists to
 * disk.
 */

import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from 'pdf-lib'

// ── Constants ─────────────────────────────────────────────────

const PAGE_W = 612      // 8.5" × 72
const PAGE_H = 792      // 11" × 72
const MARGIN_L = 48
const MARGIN_R = 48
const MARGIN_TOP = 56
const MARGIN_BOTTOM = 56

const HEADER_GOLD = rgb(0.788, 0.635, 0.153)        // matches --gold
const TEXT_DARK  = rgb(0.10, 0.13, 0.17)
const TEXT_MID   = rgb(0.35, 0.38, 0.43)
const TEXT_LIGHT = rgb(0.55, 0.58, 0.63)
const RULE       = rgb(0.85, 0.85, 0.88)
const ROW_ALT    = rgb(0.97, 0.97, 0.98)

const FONT_SIZE_BODY  = 10
const FONT_SIZE_LABEL = 8
const FONT_SIZE_HEAD  = 22
const FONT_SIZE_H2    = 12
const LINE_HEIGHT     = 14

// ── Common input types ────────────────────────────────────────

export interface BusinessInfo {
  name: string
  email: string | null
  phone: string | null
  street1: string | null
  street2: string | null
  city: string | null
  state: string | null
  zip: string | null
}

export interface CustomerInfo {
  firstName: string | null
  lastName: string | null
  companyName: string | null
  email: string | null
  phone: string | null
  street1: string | null
  city: string | null
  state: string | null
  zip: string | null
}

interface LineRow {
  description:     string
  quantity:       number
  unitPrice:      number
  lineTotal:      number
  discountAmount?: number   // S504 — per-line discount $ off (line_total is already net)
}

// ── Internal helpers ──────────────────────────────────────────

interface Doc {
  pdf: PDFDocument
  page: PDFPage
  font: PDFFont
  fontBold: PDFFont
  fontMono: PDFFont
  cursorY: number
}

async function newDoc(): Promise<Doc> {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([PAGE_W, PAGE_H])
  const font     = await pdf.embedFont(StandardFonts.Helvetica)
  const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold)
  const fontMono = await pdf.embedFont(StandardFonts.Courier)
  return { pdf, page, font, fontBold, fontMono, cursorY: PAGE_H - MARGIN_TOP }
}

function text(doc: Doc, str: string, x: number, y: number, opts: {
  size?: number
  bold?: boolean
  mono?: boolean
  color?: ReturnType<typeof rgb>
  align?: 'left' | 'right'
  maxWidth?: number
} = {}) {
  const font = opts.mono ? doc.fontMono : opts.bold ? doc.fontBold : doc.font
  const size = opts.size ?? FONT_SIZE_BODY
  const color = opts.color ?? TEXT_DARK
  let drawX = x
  if (opts.align === 'right') {
    const w = font.widthOfTextAtSize(str, size)
    drawX = x - w
  }
  doc.page.drawText(str, { x: drawX, y, size, font, color })
}

function ruleH(doc: Doc, y: number, color: ReturnType<typeof rgb> = RULE) {
  doc.page.drawLine({
    start: { x: MARGIN_L, y },
    end:   { x: PAGE_W - MARGIN_R, y },
    thickness: 0.7,
    color,
  })
}

function ensurePage(doc: Doc, minSpace: number) {
  if (doc.cursorY - minSpace < MARGIN_BOTTOM + 40) {
    doc.page = doc.pdf.addPage([PAGE_W, PAGE_H])
    doc.cursorY = PAGE_H - MARGIN_TOP
  }
}

function fmtMoney(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return '—'
  const dt = d instanceof Date ? d : new Date(d)
  return dt.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
}

function customerName(c: CustomerInfo): string {
  if (c.companyName) return c.companyName
  return `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim() || 'Customer'
}

function businessAddress(b: BusinessInfo): string[] {
  const out: string[] = []
  if (b.street1) out.push(b.street1)
  if (b.street2) out.push(b.street2)
  const cityLine = [b.city, b.state, b.zip].filter(Boolean).join(', ')
  if (cityLine) out.push(cityLine)
  return out
}

function customerAddress(c: CustomerInfo): string[] {
  const out: string[] = []
  if (c.street1) out.push(c.street1)
  const cityLine = [c.city, c.state, c.zip].filter(Boolean).join(', ')
  if (cityLine) out.push(cityLine)
  return out
}

// ── Shared layout primitives ──────────────────────────────────

function drawHeader(doc: Doc, business: BusinessInfo, docType: string, docNumber: string) {
  // Gold accent strip across top
  doc.page.drawRectangle({
    x: 0, y: PAGE_H - 6,
    width: PAGE_W, height: 6,
    color: HEADER_GOLD,
  })

  // Business name (left)
  text(doc, business.name, MARGIN_L, PAGE_H - 36, {
    size: FONT_SIZE_HEAD, bold: true, color: TEXT_DARK,
  })

  let infoY = PAGE_H - 50
  const addr = businessAddress(business)
  for (const ln of addr) {
    text(doc, ln, MARGIN_L, infoY, { size: 9, color: TEXT_MID })
    infoY -= 11
  }
  if (business.phone) {
    text(doc, business.phone, MARGIN_L, infoY, { size: 9, color: TEXT_MID })
    infoY -= 11
  }
  if (business.email) {
    text(doc, business.email, MARGIN_L, infoY, { size: 9, color: TEXT_MID })
    infoY -= 11
  }

  // Doc type + number (right)
  text(doc, docType.toUpperCase(), PAGE_W - MARGIN_R, PAGE_H - 36, {
    size: 18, bold: true, color: HEADER_GOLD, align: 'right',
  })
  text(doc, docNumber, PAGE_W - MARGIN_R, PAGE_H - 54, {
    size: 13, mono: true, color: TEXT_DARK, align: 'right',
  })

  doc.cursorY = Math.min(infoY - 18, PAGE_H - 110)
}

function drawCustomerBlock(doc: Doc, customer: CustomerInfo, headingLabel: string) {
  text(doc, headingLabel, MARGIN_L, doc.cursorY, {
    size: FONT_SIZE_LABEL, bold: true, color: TEXT_LIGHT,
  })
  doc.cursorY -= 14
  text(doc, customerName(customer), MARGIN_L, doc.cursorY, {
    size: 12, bold: true,
  })
  doc.cursorY -= 14
  for (const ln of customerAddress(customer)) {
    text(doc, ln, MARGIN_L, doc.cursorY, { size: 10, color: TEXT_MID })
    doc.cursorY -= 12
  }
  if (customer.email) {
    text(doc, customer.email, MARGIN_L, doc.cursorY, { size: 10, color: TEXT_MID })
    doc.cursorY -= 12
  }
  if (customer.phone) {
    text(doc, customer.phone, MARGIN_L, doc.cursorY, { size: 10, color: TEXT_MID })
    doc.cursorY -= 12
  }
  doc.cursorY -= 8
}

function drawMetaPanel(doc: Doc, rows: Array<{ label: string; value: string }>) {
  // Right-side panel ~200px wide aligned with customer block.
  const panelX = PAGE_W - MARGIN_R - 200
  const startY = doc.cursorY + (rows.length * 18) + 8 + 14
  doc.page.drawRectangle({
    x: panelX, y: startY - (rows.length * 18) - 10,
    width: 200, height: (rows.length * 18) + 10,
    color: rgb(0.96, 0.96, 0.97),
    borderColor: RULE,
    borderWidth: 0.5,
  })
  let y = startY - 8
  for (const r of rows) {
    text(doc, r.label.toUpperCase(), panelX + 10, y, {
      size: 7, color: TEXT_LIGHT, bold: true,
    })
    text(doc, r.value, panelX + 200 - 10, y, {
      size: 11, bold: true, align: 'right',
    })
    y -= 18
  }
}

function drawLineTable(doc: Doc, lines: LineRow[]) {
  ensurePage(doc, 60)
  const tableTop = doc.cursorY
  const colDescX  = MARGIN_L
  const colQtyX   = MARGIN_L + 290
  const colUnitX  = MARGIN_L + 360
  const colTotalX = PAGE_W - MARGIN_R

  // Header row
  doc.page.drawRectangle({
    x: MARGIN_L - 4, y: tableTop - 4,
    width: (PAGE_W - MARGIN_L - MARGIN_R) + 8, height: 22,
    color: rgb(0.95, 0.95, 0.97),
  })
  text(doc, 'DESCRIPTION', colDescX, tableTop + 6, {
    size: 8, bold: true, color: TEXT_LIGHT,
  })
  text(doc, 'QTY', colQtyX + 35, tableTop + 6, {
    size: 8, bold: true, color: TEXT_LIGHT, align: 'right',
  })
  text(doc, 'UNIT', colUnitX + 50, tableTop + 6, {
    size: 8, bold: true, color: TEXT_LIGHT, align: 'right',
  })
  text(doc, 'TOTAL', colTotalX, tableTop + 6, {
    size: 8, bold: true, color: TEXT_LIGHT, align: 'right',
  })
  doc.cursorY = tableTop - 20

  // Body rows
  let alt = false
  for (const ln of lines) {
    ensurePage(doc, 30)
    if (alt) {
      doc.page.drawRectangle({
        x: MARGIN_L - 4, y: doc.cursorY - 4,
        width: (PAGE_W - MARGIN_L - MARGIN_R) + 8, height: 22,
        color: ROW_ALT,
      })
    }
    // Description (wraps if needed). S504: a per-line discount appends a
    // compact "(−$X.XX off)" marker so the net line total is explained.
    const descMaxW = colQtyX - colDescX - 12
    const desc = (ln.discountAmount ?? 0) > 0
      ? `${ln.description}  (−${fmtMoney(ln.discountAmount!)} off)`
      : ln.description
    const truncated = truncToWidth(desc, doc.font, FONT_SIZE_BODY, descMaxW)
    text(doc, truncated, colDescX, doc.cursorY + 4, {})
    text(doc, String(ln.quantity), colQtyX + 35, doc.cursorY + 4, {
      mono: true, align: 'right',
    })
    text(doc, fmtMoney(ln.unitPrice), colUnitX + 50, doc.cursorY + 4, {
      mono: true, align: 'right',
    })
    text(doc, fmtMoney(ln.lineTotal), colTotalX, doc.cursorY + 4, {
      mono: true, bold: true, align: 'right',
    })
    doc.cursorY -= 18
    alt = !alt
  }

  doc.cursorY -= 4
  ruleH(doc, doc.cursorY)
  doc.cursorY -= 10
}

function drawTotals(doc: Doc, rows: Array<{ label: string; value: string; big?: boolean }>) {
  const labelX = PAGE_W - MARGIN_R - 160
  const valueX = PAGE_W - MARGIN_R
  for (const r of rows) {
    ensurePage(doc, 20)
    const sz = r.big ? 14 : 10
    text(doc, r.label, labelX, doc.cursorY, {
      size: r.big ? 11 : 9,
      bold: r.big, color: r.big ? TEXT_DARK : TEXT_MID,
    })
    text(doc, r.value, valueX, doc.cursorY, {
      size: sz, mono: true, bold: r.big,
      color: r.big ? HEADER_GOLD : TEXT_DARK,
      align: 'right',
    })
    doc.cursorY -= r.big ? 22 : 16
  }
  doc.cursorY -= 8
}

function drawFooter(doc: Doc, lines: string[]) {
  ensurePage(doc, 60)
  doc.cursorY -= 8
  ruleH(doc, doc.cursorY)
  doc.cursorY -= 14
  for (const ln of lines) {
    text(doc, ln, MARGIN_L, doc.cursorY, { size: 9, color: TEXT_MID })
    doc.cursorY -= 12
  }
}

function truncToWidth(s: string, font: PDFFont, size: number, maxW: number): string {
  if (font.widthOfTextAtSize(s, size) <= maxW) return s
  let out = s
  while (out.length > 0 && font.widthOfTextAtSize(out + '…', size) > maxW) {
    out = out.slice(0, -1)
  }
  return out + '…'
}

async function finalize(doc: Doc): Promise<Buffer> {
  // useObjectStreams: false keeps the text content streams uncompressed
  // so PDF viewers (and copy/paste, and search) can see the strings
  // we drew. Trade-off is a slightly larger file; for these small
  // single-page docs the size hit is negligible.
  const bytes = await doc.pdf.save({ useObjectStreams: false })
  return Buffer.from(bytes)
}

// ═══════════════════════════════════════════════════════════════
//  Invoice
// ═══════════════════════════════════════════════════════════════

export interface InvoicePdfInput {
  business:       BusinessInfo
  customer:       CustomerInfo
  invoiceNumber:  string
  status:         'draft' | 'sent' | 'paid' | 'void'
  issueDate:      Date | string
  dueDate:        Date | string
  lines:          LineRow[]
  subtotal:       number
  discountAmount?: number   // S513 — pre-tax discount
  taxAmount:      number
  totalAmount:    number
  amountPaid:     number
  notes:          string | null
  hostedPayUrl:   string | null
}

export async function renderInvoicePdf(args: InvoicePdfInput): Promise<Buffer> {
  const doc = await newDoc()

  drawHeader(doc, args.business, 'Invoice', args.invoiceNumber)

  // Meta panel: issue / due / status
  drawMetaPanel(doc, [
    { label: 'Issue date', value: fmtDate(args.issueDate) },
    { label: 'Due date',   value: fmtDate(args.dueDate) },
    { label: 'Status',     value: args.status.toUpperCase() },
  ])

  drawCustomerBlock(doc, args.customer, 'BILL TO')

  drawLineTable(doc, args.lines)

  const balance = args.totalAmount - args.amountPaid
  const discount = args.discountAmount ?? 0
  const totals: Array<{ label: string; value: string; big?: boolean }> = [
    { label: 'Subtotal', value: fmtMoney(args.subtotal) },
  ]
  if (discount > 0) totals.push({ label: 'Discount', value: `-${fmtMoney(discount)}` })
  totals.push({ label: 'Tax',   value: fmtMoney(args.taxAmount) })
  totals.push({ label: 'Total', value: fmtMoney(args.totalAmount), big: true })
  if (args.amountPaid > 0) {
    totals.push({ label: 'Paid',         value: fmtMoney(args.amountPaid) })
    totals.push({ label: 'Balance due',  value: fmtMoney(balance), big: true })
  }
  drawTotals(doc, totals)

  if (args.hostedPayUrl) {
    ensurePage(doc, 50)
    text(doc, 'PAY ONLINE', MARGIN_L, doc.cursorY, {
      size: 9, bold: true, color: TEXT_LIGHT,
    })
    doc.cursorY -= 14
    text(doc, args.hostedPayUrl, MARGIN_L, doc.cursorY, {
      size: 9, color: HEADER_GOLD,
    })
    doc.cursorY -= 18
  }

  const footer: string[] = []
  if (args.notes) footer.push(`Notes: ${args.notes}`)
  footer.push(`Generated ${fmtDate(new Date())}`)
  drawFooter(doc, footer)

  return finalize(doc)
}

// ═══════════════════════════════════════════════════════════════
//  Work order
// ═══════════════════════════════════════════════════════════════

export interface WorkOrderPdfInput {
  business:         BusinessInfo
  customer:         CustomerInfo
  woNumber:         string
  status:           string
  createdAt:        Date | string
  intakeMileage:    number | null
  closeoutMileage:  number | null
  closeoutNotes:    string | null
  complaint:        string | null
  vehicle: {
    year: number | null
    make: string | null
    model: string | null
    vin:   string | null
    licensePlate: string | null
  } | null
  lines: Array<LineRow & { lineType: 'labor' | 'part' | 'fee' }>
  laborSubtotal:    number
  partsSubtotal:    number
  taxAmount:        number
  totalAmount:      number
}

export async function renderWorkOrderPdf(args: WorkOrderPdfInput): Promise<Buffer> {
  const doc = await newDoc()

  drawHeader(doc, args.business, 'Work Order', args.woNumber)

  const metaRows = [
    { label: 'Opened', value: fmtDate(args.createdAt) },
    { label: 'Status', value: args.status.toUpperCase() },
  ]
  if (args.intakeMileage !== null) {
    metaRows.push({ label: 'Mileage', value: args.intakeMileage.toLocaleString() })
  }
  drawMetaPanel(doc, metaRows)

  drawCustomerBlock(doc, args.customer, 'CUSTOMER')

  // Vehicle block
  if (args.vehicle) {
    ensurePage(doc, 60)
    text(doc, 'VEHICLE', MARGIN_L, doc.cursorY, {
      size: FONT_SIZE_LABEL, bold: true, color: TEXT_LIGHT,
    })
    doc.cursorY -= 14
    const ymm = [args.vehicle.year, args.vehicle.make, args.vehicle.model].filter(Boolean).join(' ')
    text(doc, ymm || '(unidentified)', MARGIN_L, doc.cursorY, { size: 11, bold: true })
    doc.cursorY -= 14
    if (args.vehicle.vin) {
      text(doc, `VIN ${args.vehicle.vin}`, MARGIN_L, doc.cursorY, { size: 9, mono: true, color: TEXT_MID })
      doc.cursorY -= 12
    }
    if (args.vehicle.licensePlate) {
      text(doc, `Plate ${args.vehicle.licensePlate}`, MARGIN_L, doc.cursorY, { size: 9, mono: true, color: TEXT_MID })
      doc.cursorY -= 12
    }
    doc.cursorY -= 8
  }

  // Complaint
  if (args.complaint) {
    ensurePage(doc, 60)
    text(doc, 'COMPLAINT', MARGIN_L, doc.cursorY, {
      size: FONT_SIZE_LABEL, bold: true, color: TEXT_LIGHT,
    })
    doc.cursorY -= 14
    drawWrappedText(doc, args.complaint, PAGE_W - MARGIN_L - MARGIN_R)
    doc.cursorY -= 8
  }

  // Line items
  drawLineTable(doc, args.lines.map(l => ({
    description: `[${l.lineType.toUpperCase()}] ${l.description}`,
    quantity:    l.quantity,
    unitPrice:   l.unitPrice,
    lineTotal:   l.lineTotal,
  })))

  drawTotals(doc, [
    { label: 'Labor',  value: fmtMoney(args.laborSubtotal) },
    { label: 'Parts',  value: fmtMoney(args.partsSubtotal) },
    { label: 'Tax',    value: fmtMoney(args.taxAmount) },
    { label: 'Total',  value: fmtMoney(args.totalAmount), big: true },
  ])

  // Closeout
  if (args.closeoutMileage !== null || args.closeoutNotes) {
    ensurePage(doc, 60)
    text(doc, 'CLOSEOUT', MARGIN_L, doc.cursorY, {
      size: FONT_SIZE_LABEL, bold: true, color: TEXT_LIGHT,
    })
    doc.cursorY -= 14
    if (args.closeoutMileage !== null) {
      text(doc, `Mileage at closeout: ${args.closeoutMileage.toLocaleString()}`,
        MARGIN_L, doc.cursorY, { size: 10, color: TEXT_MID })
      doc.cursorY -= 12
    }
    if (args.closeoutNotes) {
      drawWrappedText(doc, args.closeoutNotes, PAGE_W - MARGIN_L - MARGIN_R)
    }
    doc.cursorY -= 8
  }

  drawFooter(doc, [`Generated ${fmtDate(new Date())}`])
  return finalize(doc)
}

// ═══════════════════════════════════════════════════════════════
//  Quote / estimate
// ═══════════════════════════════════════════════════════════════

export interface QuotePdfInput {
  business:           BusinessInfo
  customer:           CustomerInfo
  quoteNumber:        string
  status:             string
  createdAt:          Date | string
  expiresAt:          Date | string | null
  intakeDescription:  string | null
  notes:              string | null
  lines:              LineRow[]
  subtotal:           number
  discountAmount?:    number   // S503 — pre-tax discount
  taxAmount:          number
  totalAmount:        number
}

export async function renderQuotePdf(args: QuotePdfInput): Promise<Buffer> {
  const doc = await newDoc()

  drawHeader(doc, args.business, 'Estimate', args.quoteNumber)

  const metaRows = [
    { label: 'Created', value: fmtDate(args.createdAt) },
    { label: 'Status',  value: args.status.toUpperCase() },
  ]
  if (args.expiresAt) {
    metaRows.push({ label: 'Valid until', value: fmtDate(args.expiresAt) })
  }
  drawMetaPanel(doc, metaRows)

  drawCustomerBlock(doc, args.customer, 'PREPARED FOR')

  if (args.intakeDescription) {
    ensurePage(doc, 60)
    text(doc, 'SCOPE', MARGIN_L, doc.cursorY, {
      size: FONT_SIZE_LABEL, bold: true, color: TEXT_LIGHT,
    })
    doc.cursorY -= 14
    drawWrappedText(doc, args.intakeDescription, PAGE_W - MARGIN_L - MARGIN_R)
    doc.cursorY -= 8
  }

  drawLineTable(doc, args.lines)

  const quoteDiscount = args.discountAmount ?? 0
  const quoteTotals: Array<{ label: string; value: string; big?: boolean }> = [
    { label: 'Subtotal', value: fmtMoney(args.subtotal) },
  ]
  if (quoteDiscount > 0) {
    quoteTotals.push({ label: 'Discount', value: `-${fmtMoney(quoteDiscount)}` })
  }
  quoteTotals.push({ label: 'Tax', value: fmtMoney(args.taxAmount) })
  quoteTotals.push({ label: 'Total', value: fmtMoney(args.totalAmount), big: true })
  drawTotals(doc, quoteTotals)

  const footerLines: string[] = []
  if (args.notes) footerLines.push(args.notes)
  footerLines.push('Reply to this email or contact us to accept or ask questions.')
  footerLines.push(`Generated ${fmtDate(new Date())}`)
  drawFooter(doc, footerLines)
  return finalize(doc)
}

// ═══════════════════════════════════════════════════════════════
//  POS receipt
// ═══════════════════════════════════════════════════════════════

export interface PosReceiptPdfInput {
  business:        BusinessInfo
  customer:        CustomerInfo | null   // walk-ins have no customer
  receiptNumber:   string
  createdAt:       Date | string
  status:          'completed' | 'refunded' | 'void'
  paymentMethod:   string
  amountTendered:  number | null
  changeDue:       number | null
  refundReason:    string | null
  lines:           LineRow[]
  subtotal:        number
  discountAmount?: number   // S513 — pre-tax discount
  taxAmount:       number
  tipAmount?:      number   // S512 — gratuity, separate from the sale
  totalAmount:     number
}

export async function renderPosReceiptPdf(args: PosReceiptPdfInput): Promise<Buffer> {
  const doc = await newDoc()

  drawHeader(doc, args.business, 'Receipt', args.receiptNumber)

  drawMetaPanel(doc, [
    { label: 'Date',    value: fmtDate(args.createdAt) },
    { label: 'Status',  value: args.status.toUpperCase() },
    { label: 'Payment', value: args.paymentMethod === 'cash' ? 'Cash'
                            : args.paymentMethod === 'card_recorded' ? 'Card'
                            : args.paymentMethod },
  ])

  if (args.customer) {
    drawCustomerBlock(doc, args.customer, 'CUSTOMER')
  } else {
    doc.cursorY -= 8
  }

  drawLineTable(doc, args.lines)

  // S512: total_amount is sale-only (subtotal + tax). The grand total the
  // customer paid adds the tip, shown as the bold "Total" line.
  const tip = args.tipAmount ?? 0
  const discount = args.discountAmount ?? 0
  const grandTotal = args.totalAmount + tip
  const totals: Array<{ label: string; value: string; big?: boolean }> = [
    { label: 'Subtotal', value: fmtMoney(args.subtotal) },
  ]
  if (discount > 0) totals.push({ label: 'Discount', value: `-${fmtMoney(discount)}` })
  totals.push({ label: 'Tax', value: fmtMoney(args.taxAmount) })
  if (tip > 0) totals.push({ label: 'Tip', value: fmtMoney(tip) })
  totals.push({ label: 'Total', value: fmtMoney(grandTotal), big: true })
  if (args.paymentMethod === 'cash' && args.amountTendered !== null) {
    totals.push({ label: 'Tendered', value: fmtMoney(args.amountTendered) })
    totals.push({ label: 'Change',   value: fmtMoney(args.changeDue ?? 0) })
  }
  drawTotals(doc, totals)

  const footer: string[] = []
  if (args.status === 'refunded' && args.refundReason) {
    footer.push(`Refunded: ${args.refundReason}`)
  }
  footer.push('Thank you for your business!')
  footer.push(`Generated ${fmtDate(new Date())}`)
  drawFooter(doc, footer)
  return finalize(doc)
}

// ── Wrapped text helper ───────────────────────────────────────

function drawWrappedText(doc: Doc, raw: string, maxWidth: number) {
  const words = raw.split(/\s+/)
  let line = ''
  for (const w of words) {
    const candidate = line ? `${line} ${w}` : w
    if (doc.font.widthOfTextAtSize(candidate, FONT_SIZE_BODY) > maxWidth) {
      text(doc, line, MARGIN_L, doc.cursorY, { color: TEXT_MID })
      doc.cursorY -= LINE_HEIGHT
      ensurePage(doc, 20)
      line = w
    } else {
      line = candidate
    }
  }
  if (line) {
    text(doc, line, MARGIN_L, doc.cursorY, { color: TEXT_MID })
    doc.cursorY -= LINE_HEIGHT
  }
}

/**
 * S582 (Nic): document-first PDF for a MONEY add-on addendum.
 *
 * The S581 money-add-on flow (POST /esign/documents/addendum-terms with
 * `scheduledChanges`) attaches a rent change / new recurring charge to a lease
 * but, when the landlord uploads NO base PDF and picks NO template (the
 * MoneyAddonModal case), the signed document had `base_pdf_url = null` — so the
 * tenant signed nothing that stated the money term. That violates
 * document-first enforcement (memory `gam-document-first-enforcement`): the
 * billable term must PRINT on the signed document, because courts enforce the
 * document, not how the software is configured.
 *
 * This generator renders a self-contained addendum PDF that prints the exact
 * change(s) + effective date + mode-appropriate acknowledgment language, and
 * places e-sign signature/date field boxes for each signer — returned so the
 * caller can persist them as `lease_document_fields`. The document then signs +
 * stamps like any template-based document.
 *
 * Field coordinates use the editor's TOP-LEFT origin (y-down): `y` is the
 * distance from the top of the page to the top of the box. `services/pdfStamp.ts`
 * converts back to pdf-lib space with `pdfY = pageHeight - y - height`, so a box
 * whose bottom sits on a drawn signature line has `y = pageHeight - lineY - height`.
 *
 * National-platform rule: NO state-specific legal language — generic wording only.
 */

import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
import { PDFDocument, StandardFonts, rgb, PDFFont, PDFPage } from 'pdf-lib'
import { query, queryOne } from '../db'

export type MoneyAddonMode = 'agreement' | 'notice'

export interface MoneyAddonChange {
  changeType:      'rent' | 'recurring_fee'
  effectiveDate:   string            // 'YYYY-MM-DD'
  newRentAmount?:  number
  feeType?:        string
  feeAmount?:      number
  feeDescription?: string | null
}

/** A signer that will sign THIS document (landlord always; tenants in agreement mode). */
export interface MoneyAddonSigner {
  role: string                       // 'landlord' | 'primary' | 'co_tenant_1' ...
  name: string
}

/** A placed e-sign field box (top-left / y-down convention — matches pdfStamp). */
export interface MoneyAddonFieldBox {
  signerRole:  string
  fieldType:   'signature' | 'date'
  leaseColumn: string | null
  label:       string
  page:        number                // 1-based
  x:           number
  y:           number                // top of box from top of page
  width:       number
  height:      number
  required:    boolean
}

export interface GenerateMoneyAddonPdfResult {
  filename:  string
  fileUrl:   string                  // /api/esign/files/<filename>
  pageCount: number
  fields:    MoneyAddonFieldBox[]
}

const UPLOAD_DIR = path.join(process.cwd(), 'uploads', 'leases')

// Tenant-facing labels for a recurring fee (no raw enums in the printed doc).
// Kept in sync with services/scheduledLeaseChanges.ts RECURRING_FEE_LABEL.
const RECURRING_FEE_LABEL: Record<string, string> = {
  pet_rent: 'pet rent', parking_rent: 'parking', storage_rent: 'storage',
  amenity_fee_monthly: 'amenity', trash_fee: 'trash', pest_control_fee: 'pest control',
  technology_fee: 'technology', other_fee: 'monthly charge',
}

interface LeaseContext {
  property_name: string
  unit_number:   string
  landlord_name: string
  tenant_names:  string[]
  current_rent:  number
}

async function loadContext(leaseId: string): Promise<LeaseContext> {
  const lease = await queryOne<{
    property_name: string; unit_number: string; landlord_name: string; rent_amount: string
  }>(`
    SELECT p.name AS property_name, u.unit_number,
           lu.first_name || ' ' || lu.last_name AS landlord_name,
           l.rent_amount
      FROM leases l
      JOIN units u      ON u.id = l.unit_id
      JOIN properties p ON p.id = u.property_id
      JOIN landlords la ON la.id = l.landlord_id
      JOIN users lu     ON lu.id = la.user_id
     WHERE l.id = $1`, [leaseId])
  if (!lease) throw new Error(`Lease ${leaseId} not found`)

  const tenantRows = await query<{ name: string }>(`
    SELECT u.first_name || ' ' || u.last_name AS name
      FROM lease_tenants lt
      JOIN tenants t ON t.id = lt.tenant_id
      JOIN users   u ON u.id = t.user_id
     WHERE lt.lease_id = $1 AND lt.status = 'active'
     ORDER BY u.last_name, u.first_name`, [leaseId])

  return {
    property_name: lease.property_name,
    unit_number:   lease.unit_number,
    landlord_name: lease.landlord_name,
    tenant_names:  tenantRows.map(r => r.name),
    current_rent:  Number(lease.rent_amount),
  }
}

const money = (n: number | null | undefined) =>
  n == null ? '—' : `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

// 'YYYY-MM-DD' → 'Month D, YYYY' with NO timezone shift (parse the parts, don't
// new Date('YYYY-MM-DD') which is UTC-midnight and can render a day early).
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December']
function prettyDate(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd)
  if (!m) return ymd
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`
}

function describeChange(c: MoneyAddonChange, ctx: LeaseContext): { title: string; from: string; to: string } {
  if (c.changeType === 'rent') {
    return {
      title: `Monthly rent change — effective ${prettyDate(c.effectiveDate)}`,
      from:  `From: ${money(ctx.current_rent)} per month`,
      to:    `To:   ${money(c.newRentAmount)} per month`,
    }
  }
  const label = c.feeDescription?.trim() || RECURRING_FEE_LABEL[c.feeType || ''] || 'monthly charge'
  return {
    title: `New monthly charge — effective ${prettyDate(c.effectiveDate)}`,
    from:  `Charge: ${label}`,
    to:    `Amount: ${money(c.feeAmount)} per month`,
  }
}

export interface GenerateMoneyAddonPdfInput {
  leaseId:  string
  title:    string
  mode:     MoneyAddonMode
  changes:  MoneyAddonChange[]
  signers:  MoneyAddonSigner[]       // who actually signs this document
}

/**
 * Generate the money-add-on addendum PDF and its e-sign field boxes. Writes the
 * file to uploads/leases and returns the URL + the boxes to persist.
 */
export async function generateMoneyAddonPdf(
  input: GenerateMoneyAddonPdfInput,
): Promise<GenerateMoneyAddonPdfResult> {
  if (input.changes.length === 0) throw new Error('money add-on PDF requires at least one change')
  if (input.signers.length === 0) throw new Error('money add-on PDF requires at least one signer')

  const ctx = await loadContext(input.leaseId)
  if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true })

  const pdf = await PDFDocument.create()
  const font     = await pdf.embedFont(StandardFonts.Helvetica)
  const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold)

  const black = rgb(0, 0, 0)
  const grey  = rgb(0.4, 0.4, 0.4)
  const gold  = rgb(0.788, 0.635, 0.153)
  const margin = 54
  const PAGE_W = 612, PAGE_H = 792

  const pages: PDFPage[] = []
  let page: PDFPage = pdf.addPage([PAGE_W, PAGE_H]); pages.push(page)
  let y = PAGE_H - margin

  const newPage = () => { page = pdf.addPage([PAGE_W, PAGE_H]); pages.push(page); y = PAGE_H - margin }
  const ensure = (need: number) => { if (y < margin + need) newPage() }
  const pageNo = () => pages.length          // 1-based index of the current page

  const line = (text: string, size: number, f: PDFFont, color = black, indent = 0, gap = 4) => {
    ensure(size + gap)
    page.drawText(text, { x: margin + indent, y, size, font: f, color })
    y -= size + gap
  }
  const wrapped = (text: string, size: number, f: PDFFont, color = black, indent = 0) => {
    const maxWidth = PAGE_W - margin * 2 - indent
    const words = text.split(' ')
    let ln = ''
    for (const w of words) {
      const test = ln ? ln + ' ' + w : w
      if (f.widthOfTextAtSize(test, size) > maxWidth && ln) { line(ln, size, f, color, indent, 4); ln = w }
      else ln = test
    }
    if (ln) line(ln, size, f, color, indent, 4)
  }
  const heading = (t: string) => { ensure(26); y -= 4; page.drawText(t, { x: margin, y, size: 11, font: fontBold, color: grey }); y -= 16 }

  // ── HEADER ──
  page.drawText('LEASE ADDENDUM', { x: margin, y, size: 22, font: fontBold, color: black })
  y -= 8
  page.drawLine({ start: { x: margin, y: y - 4 }, end: { x: PAGE_W - margin, y: y - 4 }, thickness: 1.5, color: gold })
  y -= 26
  line(input.title, 12, fontBold, black, 0, 12)

  // ── INFO ──
  const kv = (k: string, v: string) => {
    ensure(16)
    page.drawText(k, { x: margin, y, size: 10, font: fontBold, color: grey })
    page.drawText(v, { x: margin + 110, y, size: 10, font, color: black })
    y -= 15
  }
  kv('Property:', ctx.property_name)
  kv('Unit:', ctx.unit_number)
  y -= 6

  // ── PARTIES ──
  heading('PARTIES')
  kv('Landlord:', ctx.landlord_name)
  kv('Tenant(s):', ctx.tenant_names.length ? ctx.tenant_names.join(', ') : '—')
  y -= 6

  // ── CHANGES ──
  heading('CHANGE(S) TO LEASE TERMS')
  for (const c of input.changes) {
    const d = describeChange(c, ctx)
    line('•  ' + d.title, 10, fontBold, black, 0, 6)
    line(d.from, 10, font, grey, 16, 4)
    line(d.to,   10, fontBold, gold, 16, 10)
  }

  // ── ACKNOWLEDGMENT ──
  heading('ACKNOWLEDGMENT')
  if (input.mode === 'agreement') {
    wrapped(
      'By signing below, the Tenant(s) agree to the change(s) set forth above, to take effect on the date shown. All other terms of the lease remain in full force and effect.',
      9.5, font, black)
  } else {
    wrapped(
      'This addendum serves as written notice of the change(s) set forth above, to take effect on the date shown. The Tenant(s) will acknowledge receipt of this notice electronically. All other terms of the lease remain in full force and effect.',
      9.5, font, black)
  }
  y -= 10

  // ── SIGNATURES ──
  heading('SIGNATURES')
  const fields: MoneyAddonFieldBox[] = []
  const BOX_H = 22, SIG_W = 220, DATE_W = 130, DATE_X = margin + 260
  for (const s of input.signers) {
    // Each signer needs a signature line + a date line + a box above each.
    ensure(56)
    const roleLabel = s.role === 'landlord' ? 'Landlord'
      : s.role === 'primary' ? 'Tenant'
      : /^co_tenant_/.test(s.role) ? 'Tenant' : s.role.replace(/_/g, ' ')
    page.drawText(`${roleLabel}: ${s.name}`, { x: margin, y, size: 10, font: fontBold, color: black })
    y -= 20
    const lineY = y            // pdf-lib baseline for both the signature + date underline
    page.drawLine({ start: { x: margin, y: lineY }, end: { x: margin + SIG_W, y: lineY }, thickness: 0.7, color: grey })
    page.drawLine({ start: { x: DATE_X, y: lineY }, end: { x: DATE_X + DATE_W, y: lineY }, thickness: 0.7, color: grey })
    y -= 11
    page.drawText('Signature', { x: margin, y, size: 8, font, color: grey })
    page.drawText('Date',      { x: DATE_X, y, size: 8, font, color: grey })
    y -= 22

    const topY = PAGE_H - lineY - BOX_H    // convert baseline → top-left box origin
    fields.push({
      signerRole: s.role, fieldType: 'signature', leaseColumn: null,
      label: `${roleLabel} signature`, page: pageNo(),
      x: margin, y: topY, width: SIG_W, height: BOX_H, required: true,
    })
    fields.push({
      signerRole: s.role, fieldType: 'date', leaseColumn: 'date_signed',
      label: 'Date signed', page: pageNo(),
      x: DATE_X, y: topY, width: DATE_W, height: BOX_H, required: false,
    })
  }

  const bytes = await pdf.save()
  const filename = 'addendum-money-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(4).toString('hex') + '.pdf'
  fs.writeFileSync(path.join(UPLOAD_DIR, filename), bytes)

  return {
    filename,
    fileUrl:   '/api/esign/files/' + filename,
    pageCount: pdf.getPageCount(),
    fields,
  }
}

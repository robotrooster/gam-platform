// Lease PDF generator (S508).
//
// Renders a full Residential Lease Agreement PDF from the structured lease
// terms, so EVERY lease — e-signed, manually created, or imported — has a
// document the tenant and landlord can view in the in-browser pdf.js viewer.
// Modeled on services/addendumPdf.ts (same pdf-lib + US-Letter layout).
//
// National-platform rule: NO state-specific legal language. Clauses are
// generic with "consult your local laws" hedging only.

import { PDFDocument, StandardFonts, rgb, PDFFont, PDFPage } from 'pdf-lib'
import { query, queryOne } from '../db'

interface LeasePdfContext {
  lease_id:        string
  status:          string
  property_name:   string
  unit_number:     string
  landlord_name:   string
  tenant_names:    string[]
  start_date:      Date | null
  end_date:        Date | null
  lease_type:      string | null
  rent_amount:     number
  rent_due_day:    number | null
  late_fee_enabled: boolean
  late_fee_initial_amount: number | null
  late_fee_initial_type:   string | null
  late_fee_grace_days:     number | null
  security_deposit: number | null
  other_fees:      Array<{ label: string; amount: number; timing: string }>
  signed_by_landlord: boolean
  signed_by_tenant:   boolean
  signed_at:       Date | null
}

const FEE_TYPE_LABEL: Record<string, string> = {
  pet_fee: 'Pet fee', pet_deposit: 'Pet deposit', cleaning_fee: 'Cleaning fee',
  parking_fee: 'Parking fee', application_fee: 'Application fee',
  early_termination_fee: 'Early termination fee', other_fee: 'Other fee',
  utility_fee: 'Utility fee', admin_fee: 'Admin fee',
}

async function loadContext(leaseId: string): Promise<LeasePdfContext> {
  const l = await queryOne<any>(`
    SELECT l.*, p.name AS property_name, u.unit_number,
           lu.first_name || ' ' || lu.last_name AS landlord_name
      FROM leases l
      JOIN units u      ON u.id = l.unit_id
      JOIN properties p ON p.id = u.property_id
      JOIN landlords la ON la.id = l.landlord_id
      JOIN users lu     ON lu.id = la.user_id
     WHERE l.id = $1`, [leaseId])
  if (!l) throw new Error(`Lease ${leaseId} not found`)

  const tenantRows = await query<{ name: string }>(`
    SELECT u.first_name || ' ' || u.last_name AS name
      FROM lease_tenants lt
      JOIN tenants t ON t.id = lt.tenant_id
      JOIN users   u ON u.id = t.user_id
     WHERE lt.lease_id = $1 AND lt.status = 'active'
     ORDER BY u.last_name, u.first_name`, [leaseId])

  const fees = await query<any>(
    `SELECT fee_type, amount, due_timing FROM lease_fees WHERE lease_id = $1 ORDER BY due_timing, fee_type`,
    [leaseId])

  const depositRow = fees.find(f => f.fee_type === 'security_deposit')
  const otherFees = fees
    .filter(f => f.fee_type !== 'security_deposit')
    .map(f => ({
      label: FEE_TYPE_LABEL[f.fee_type] ?? f.fee_type,
      amount: Number(f.amount),
      timing: String(f.due_timing || '').replace(/_/g, ' '),
    }))

  return {
    lease_id:      l.id,
    status:        l.status,
    property_name: l.property_name,
    unit_number:   l.unit_number,
    landlord_name: l.landlord_name,
    tenant_names:  tenantRows.map(r => r.name),
    start_date:    l.start_date ? new Date(l.start_date) : null,
    end_date:      l.end_date ? new Date(l.end_date) : null,
    lease_type:    l.lease_type,
    rent_amount:   Number(l.rent_amount),
    rent_due_day:  l.rent_due_day != null ? Number(l.rent_due_day) : null,
    late_fee_enabled:        l.late_fee_enabled ?? false,
    late_fee_initial_amount: l.late_fee_initial_amount != null ? Number(l.late_fee_initial_amount) : null,
    late_fee_initial_type:   l.late_fee_initial_type,
    late_fee_grace_days:     l.late_fee_grace_days != null ? Number(l.late_fee_grace_days) : null,
    security_deposit: depositRow ? Number(depositRow.amount) : null,
    other_fees:    otherFees,
    signed_by_landlord: l.signed_by_landlord ?? false,
    signed_by_tenant:   l.signed_by_tenant ?? false,
    signed_at:     l.signed_at ? new Date(l.signed_at) : null,
  }
}

const money = (n: number | null) =>
  n == null ? '—' : `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const dateStr = (d: Date | null) =>
  d ? d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : '—'

/** Generate the lease agreement PDF and return the raw bytes. */
export async function generateLeasePdfBytes(leaseId: string): Promise<Uint8Array> {
  const ctx = await loadContext(leaseId)

  const pdf = await PDFDocument.create()
  const font     = await pdf.embedFont(StandardFonts.Helvetica)
  const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold)

  const black = rgb(0, 0, 0)
  const grey  = rgb(0.4, 0.4, 0.4)
  const gold  = rgb(0.788, 0.635, 0.153)
  const margin = 54

  let page: PDFPage = pdf.addPage([612, 792])
  let { width, height } = page.getSize()
  let y = height - margin

  const ensure = (need: number) => {
    if (y < margin + need) {
      page = pdf.addPage([612, 792])
      y = page.getSize().height - margin
    }
  }
  // simple word-wrap writer
  const writeWrapped = (text: string, size: number, f: PDFFont, color = black, indent = 0) => {
    const maxWidth = width - margin * 2 - indent
    const words = text.split(' ')
    let line = ''
    for (const w of words) {
      const test = line ? line + ' ' + w : w
      if (f.widthOfTextAtSize(test, size) > maxWidth && line) {
        ensure(size + 4)
        page.drawText(line, { x: margin + indent, y, size, font: f, color })
        y -= size + 4
        line = w
      } else line = test
    }
    if (line) {
      ensure(size + 4)
      page.drawText(line, { x: margin + indent, y, size, font: f, color })
      y -= size + 4
    }
  }
  const heading = (t: string) => { ensure(28); y -= 6; page.drawText(t, { x: margin, y, size: 11, font: fontBold, color: grey }); y -= 16 }
  const kv = (k: string, v: string) => {
    ensure(16)
    page.drawText(k, { x: margin, y, size: 10, font: fontBold, color: black })
    page.drawText(v, { x: margin + 150, y, size: 10, font, color: black })
    y -= 15
  }

  // ── HEADER ──
  page.drawText('RESIDENTIAL LEASE AGREEMENT', { x: margin, y, size: 18, font: fontBold, color: black })
  y -= 8
  page.drawLine({ start: { x: margin, y: y - 4 }, end: { x: width - margin, y: y - 4 }, thickness: 1.5, color: gold })
  y -= 26

  // ── PROPERTY ──
  heading('PROPERTY')
  kv('Property:', ctx.property_name)
  kv('Unit:', ctx.unit_number)

  // ── PARTIES ──
  heading('PARTIES')
  kv('Landlord:', ctx.landlord_name)
  kv('Tenant(s):', ctx.tenant_names.length ? ctx.tenant_names.join(', ') : '—')

  // ── TERM ──
  heading('TERM')
  const isMonthToMonth = !ctx.end_date || ctx.lease_type === 'month_to_month'
  kv('Start date:', dateStr(ctx.start_date))
  kv('End date:', isMonthToMonth ? 'Month-to-month' : dateStr(ctx.end_date))

  // ── RENT ──
  heading('RENT')
  kv('Monthly rent:', money(ctx.rent_amount))
  kv('Due day:', ctx.rent_due_day != null ? `Day ${ctx.rent_due_day} of each month` : '—')
  if (ctx.late_fee_enabled) {
    const lf = ctx.late_fee_initial_type === 'percent'
      ? `${ctx.late_fee_initial_amount ?? 0}% of rent`
      : money(ctx.late_fee_initial_amount)
    kv('Late fee:', `${lf}${ctx.late_fee_grace_days != null ? ` after a ${ctx.late_fee_grace_days}-day grace period` : ''}`)
  }

  // ── DEPOSIT & FEES ──
  heading('DEPOSIT & FEES')
  kv('Security deposit:', money(ctx.security_deposit))
  for (const f of ctx.other_fees) kv(`${f.label}:`, `${money(f.amount)}${f.timing ? ` (${f.timing})` : ''}`)

  // ── TERMS ──
  heading('TERMS & CONDITIONS')
  const clauses = [
    'Tenant agrees to pay the monthly rent in full by the due date stated above. Rent is collected electronically through the GAM platform.',
    'Tenant shall keep the premises in clean and sanitary condition and shall not make alterations without the Landlord\'s written consent.',
    'The security deposit, if any, is held against unpaid rent and damages beyond normal wear and tear, and is returned per the terms of this lease and applicable law.',
    'Either party may terminate this agreement in accordance with its term and any notice requirements. Early termination may incur the fee stated above, if applicable.',
    'This agreement is governed by the laws of the jurisdiction where the property is located. Both parties should consult their local laws for any jurisdiction-specific requirements.',
  ]
  let i = 1
  for (const c of clauses) { writeWrapped(`${i}.  ${c}`, 9.5, font, black); y -= 3; i++ }

  // ── SIGNATURES ──
  heading('SIGNATURES')
  const sigStatus = (signed: boolean) =>
    signed && ctx.signed_at ? `Signed ${ctx.signed_at.toLocaleDateString()}` : 'Pending signature'
  ensure(40)
  page.drawText('Landlord:', { x: margin, y, size: 10, font: fontBold, color: black })
  page.drawText(ctx.landlord_name, { x: margin + 90, y, size: 10, font, color: black })
  page.drawText(sigStatus(ctx.signed_by_landlord), { x: width - margin - 150, y, size: 9, font, color: ctx.signed_by_landlord ? rgb(0.16, 0.64, 0.35) : grey })
  y -= 18
  for (const tn of (ctx.tenant_names.length ? ctx.tenant_names : ['—'])) {
    ensure(20)
    page.drawText('Tenant:', { x: margin, y, size: 10, font: fontBold, color: black })
    page.drawText(tn, { x: margin + 90, y, size: 10, font, color: black })
    page.drawText(sigStatus(ctx.signed_by_tenant), { x: width - margin - 150, y, size: 9, font, color: ctx.signed_by_tenant ? rgb(0.16, 0.64, 0.35) : grey })
    y -= 18
  }

  // ── FOOTER ──
  y -= 10
  ensure(14)
  const executed = ctx.signed_by_landlord && ctx.signed_by_tenant
  writeWrapped(
    executed
      ? 'This document reflects the executed lease terms of record on the GAM platform.'
      : 'This document reflects the current lease terms of record on the GAM platform and is not yet fully executed.',
    8, font, grey)

  return await pdf.save()
}

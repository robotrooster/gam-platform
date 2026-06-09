/**
 * S212 (B1+B2 phase 2B kickoff): generate a lease-addendum PDF from
 * a non-material change set. Companion to S202's
 * lease_addendum_recorded credit-ledger emit and S210/S211's read
 * surfaces.
 *
 * Scope of THIS session: ship the generation primitive. The next
 * session wires it into the leases PATCH endpoint's
 * `confirm_addendum: true` branch + sends the resulting PDF through
 * the existing addendum-terms esign flow so all current tenants
 * countersign it.
 *
 * Output convention matches the rest of the e-sign storage layer:
 *   filesystem  → process.cwd()/uploads/leases/<filename>
 *   served via  → /api/esign/files/<filename>
 *   filename    → addendum-<isoDate>-<random8>.pdf
 *
 * No template reads — the PDF is generated programmatically. The
 * S202 handoff suggested a "blank addendum template + field
 * binding" but that's overengineering for a doc that's mostly
 * generated text and a structured diff list. Keep it
 * template-free; landlord configurability lives in the source
 * lease, not the addendum-of-record.
 */

import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { ADDENDUM_DIFF_FIELD_LABEL, formatAddendumDiffValue } from '@gam/shared'
import { query, queryOne } from '../db'

export interface AddendumChange {
  field: string
  from:  string
  to:    string
}

export interface GenerateAddendumPdfInput {
  leaseId:           string
  changes:           AddendumChange[]
  recordedByUserId:  string
  recordedAt?:       Date
}

export interface GenerateAddendumPdfResult {
  filename:    string
  filePath:    string   // absolute filesystem path
  fileUrl:     string   // /api/esign/files/<filename>
  pageCount:   number
}

interface LeaseContext {
  lease_id:        string
  property_name:   string
  unit_number:     string
  landlord_name:   string
  tenant_names:    string[]
  recorded_by:     string
}

const UPLOAD_DIR = path.join(process.cwd(), 'uploads', 'leases')

async function loadLeaseContext(leaseId: string, recordedByUserId: string): Promise<LeaseContext> {
  const lease = await queryOne<{
    property_name: string
    unit_number:   string
    landlord_name: string
  }>(`
    SELECT p.name AS property_name,
           u.unit_number,
           lu.first_name || ' ' || lu.last_name AS landlord_name
      FROM leases l
      JOIN units u           ON u.id = l.unit_id
      JOIN properties p      ON p.id = u.property_id
      JOIN landlords la      ON la.id = l.landlord_id
      JOIN users lu          ON lu.id = la.user_id
     WHERE l.id = $1`,
    [leaseId]
  )
  if (!lease) throw new Error(`Lease ${leaseId} not found`)

  const tenantRows = await query<{ name: string }>(`
    SELECT u.first_name || ' ' || u.last_name AS name
      FROM lease_tenants lt
      JOIN tenants t ON t.id = lt.tenant_id
      JOIN users   u ON u.id = t.user_id
     WHERE lt.lease_id = $1
       AND lt.status = 'active'
     ORDER BY u.last_name, u.first_name`,
    [leaseId]
  )

  const recorded = await queryOne<{ name: string }>(
    'SELECT first_name || \' \' || last_name AS name FROM users WHERE id = $1',
    [recordedByUserId]
  )

  return {
    lease_id:      leaseId,
    property_name: lease.property_name,
    unit_number:   lease.unit_number,
    landlord_name: lease.landlord_name,
    tenant_names:  tenantRows.map(r => r.name),
    recorded_by:   recorded?.name ?? '(unknown user)',
  }
}

export async function generateAddendumPdf(
  input: GenerateAddendumPdfInput,
): Promise<GenerateAddendumPdfResult> {
  if (input.changes.length === 0) {
    throw new Error('Cannot generate addendum PDF from empty change set')
  }

  const ctx = await loadLeaseContext(input.leaseId, input.recordedByUserId)
  const recordedAt = input.recordedAt ?? new Date()

  if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true })

  const pdfDoc = await PDFDocument.create()
  const helvetica     = await pdfDoc.embedFont(StandardFonts.Helvetica)
  const helveticaBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold)

  const page = pdfDoc.addPage([612, 792]) // US Letter, 72 DPI
  const { width, height } = page.getSize()
  const margin = 54

  const black = rgb(0, 0, 0)
  const grey  = rgb(0.4, 0.4, 0.4)
  const gold  = rgb(0.788, 0.635, 0.153) // #c9a227

  let y = height - margin

  // ── HEADER ──
  page.drawText('LEASE ADDENDUM', {
    x: margin, y, size: 22, font: helveticaBold, color: black,
  })
  y -= 8
  page.drawLine({
    start: { x: margin, y: y - 4 },
    end:   { x: width - margin, y: y - 4 },
    thickness: 1.5, color: gold,
  })
  y -= 28

  // ── LEASE INFO BLOCK ──
  const infoLines: Array<[string, string]> = [
    ['Property:',       ctx.property_name],
    ['Unit:',           ctx.unit_number],
    ['Effective Date:', recordedAt.toLocaleDateString(undefined, { year:'numeric', month:'long', day:'numeric' })],
    ['Lease ID:',       ctx.lease_id],
  ]
  for (const [label, value] of infoLines) {
    page.drawText(label, { x: margin,        y, size: 10, font: helveticaBold, color: grey })
    page.drawText(value, { x: margin + 110,  y, size: 10, font: helvetica,     color: black })
    y -= 16
  }
  y -= 8

  // ── PARTIES ──
  page.drawText('PARTIES', { x: margin, y, size: 11, font: helveticaBold, color: grey })
  y -= 16
  page.drawText('Landlord:', { x: margin,       y, size: 10, font: helveticaBold, color: black })
  page.drawText(ctx.landlord_name, { x: margin + 70, y, size: 10, font: helvetica, color: black })
  y -= 14
  page.drawText('Tenant(s):', { x: margin, y, size: 10, font: helveticaBold, color: black })
  for (let i = 0; i < ctx.tenant_names.length; i++) {
    page.drawText(ctx.tenant_names[i], { x: margin + 70, y, size: 10, font: helvetica, color: black })
    y -= 14
  }
  y -= 6

  // ── CHANGES ──
  page.drawText('CHANGES TO LEASE TERMS', { x: margin, y, size: 11, font: helveticaBold, color: grey })
  y -= 16

  for (const c of input.changes) {
    const label = ADDENDUM_DIFF_FIELD_LABEL[c.field] ?? c.field
    const fromVal = formatAddendumDiffValue(c.field, c.from)
    const toVal   = formatAddendumDiffValue(c.field, c.to)

    page.drawText('•', { x: margin,      y, size: 10, font: helveticaBold, color: black })
    page.drawText(label,   { x: margin + 14, y, size: 10, font: helveticaBold, color: black })
    y -= 14
    page.drawText(`From: ${fromVal}`, { x: margin + 24, y, size: 10, font: helvetica, color: grey })
    y -= 13
    page.drawText(`To:   ${toVal}`,   { x: margin + 24, y, size: 10, font: helveticaBold, color: gold })
    y -= 18
  }
  y -= 6

  // ── BOILERPLATE ──
  const boilerplate = [
    'This addendum is incorporated into and made part of the lease',
    'agreement referenced above. All other terms of the lease remain in',
    'full force and effect. The signatures below acknowledge receipt of',
    'and agreement to the changes set forth in this addendum.',
  ]
  for (const line of boilerplate) {
    page.drawText(line, { x: margin, y, size: 10, font: helvetica, color: black })
    y -= 13
  }
  y -= 6

  page.drawText(`Recorded by: ${ctx.recorded_by} on ${recordedAt.toLocaleString()}`, {
    x: margin, y, size: 9, font: helvetica, color: grey,
  })
  y -= 26

  // ── SIGNATURE BLOCKS ──
  page.drawText('SIGNATURES', { x: margin, y, size: 11, font: helveticaBold, color: grey })
  y -= 22

  const signers = [
    { role: 'Landlord', name: ctx.landlord_name },
    ...ctx.tenant_names.map(name => ({ role: 'Tenant', name })),
  ]
  for (const s of signers) {
    if (y < margin + 60) {
      // unlikely with current change-set sizes, but page-overflow guard
      const next = pdfDoc.addPage([612, 792])
      y = next.getSize().height - margin
      next.drawText('(continued)', { x: margin, y, size: 9, font: helvetica, color: grey })
      y -= 20
    }
    page.drawText(s.role + ': ' + s.name, { x: margin, y, size: 10, font: helveticaBold, color: black })
    y -= 14
    page.drawLine({ start: { x: margin,     y }, end: { x: margin + 240, y }, thickness: 0.7, color: grey })
    page.drawLine({ start: { x: margin + 280, y }, end: { x: margin + 420, y }, thickness: 0.7, color: grey })
    y -= 11
    page.drawText('Signature', { x: margin,     y, size: 8, font: helvetica, color: grey })
    page.drawText('Date',      { x: margin + 280, y, size: 8, font: helvetica, color: grey })
    y -= 26
  }

  const pdfBytes = await pdfDoc.save()
  const filename = 'addendum-' + recordedAt.toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(4).toString('hex') + '.pdf'
  const filePath = path.join(UPLOAD_DIR, filename)
  fs.writeFileSync(filePath, pdfBytes)

  return {
    filename,
    filePath,
    fileUrl:   '/api/esign/files/' + filename,
    pageCount: pdfDoc.getPageCount(),
  }
}

/**
 * S573 (Nic): inspection summary report.
 *
 * On finalize, GAM generates a PDF summary of the inspection — every area/item
 * with its condition, notes and estimated repair cost; the signatures; and for
 * a move-out, the item-by-item comparison against the linked move-in (the
 * mismatch detail that finalize computes but otherwise discards). The report is
 * filed to BOTH parties: report_url on the inspection (landlord reporting) and a
 * `documents` row with tenant_id set (the tenant portal's Documents tab).
 *
 * Storage convention (mirrors the e-sign PDF layer):
 *   filesystem → process.cwd()/uploads/inspections/<filename>
 *   served via → /api/inspections/report-files/<filename>
 *   filename   → inspection-report-<id8>-<random8>.pdf
 */
import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
import { PDFDocument, StandardFonts, rgb, type PDFPage, type PDFFont } from 'pdf-lib'
import { query, queryOne } from '../db'
import { humanize, INSPECTION_ITEM_CONDITION_LABEL, INSPECTION_CONDITION_RANK } from '@gam/shared'

const REPORT_DIR = path.join(process.cwd(), 'uploads', 'inspections')

const TYPE_LABEL: Record<string, string> = {
  move_in: 'Move-in', move_out: 'Move-out', periodic: 'Periodic', turnover: 'Turnover',
}
// S573: null condition = not yet inspected.
const condLabel = (c: string | null | undefined): string =>
  c ? (INSPECTION_ITEM_CONDITION_LABEL[c as keyof typeof INSPECTION_ITEM_CONDITION_LABEL] ?? c) : 'Not inspected'
const CONDITION_RANK = INSPECTION_CONDITION_RANK

export interface InspectionReportResult {
  filename: string
  filePath: string
  fileUrl: string
  fileSize: number
  pageCount: number
}

interface Ctx {
  id: string
  inspection_type: string
  status: string
  conducted_at: string | null
  finalized_at: string | null
  notes: string | null
  comparison_inspection_id: string | null
  unit_number: string | null
  unit_type: string | null
  property_name: string
  street1: string | null
  city: string | null
  state: string | null
  landlord_name: string
  tenant_first: string | null
  tenant_last: string | null
  conducted_by: string | null
}
interface Item { area: string; item_label: string; condition: string | null; notes: string | null; estimated_repair_cost: string | null }
interface Sig { signer_role: string; signed_at: string; name: string }

export async function generateInspectionReportPdf(inspectionId: string): Promise<InspectionReportResult> {
  const ctx = await queryOne<Ctx>(`
    SELECT i.id, i.inspection_type, i.status, i.conducted_at, i.finalized_at, i.notes,
           i.comparison_inspection_id,
           u.unit_number, u.unit_type, p.name AS property_name, p.street1, p.city, p.state,
           lu.first_name || ' ' || lu.last_name AS landlord_name,
           tu.first_name AS tenant_first, tu.last_name AS tenant_last,
           cu.first_name || ' ' || cu.last_name AS conducted_by
      FROM unit_inspections i
      JOIN units u ON u.id = i.unit_id
      JOIN properties p ON p.id = u.property_id
      JOIN landlords la ON la.id = i.landlord_id
      JOIN users lu ON lu.id = la.user_id
      LEFT JOIN tenants t ON t.id = i.tenant_id
      LEFT JOIN users tu ON tu.id = t.user_id
      LEFT JOIN users cu ON cu.id = i.conducted_by_user_id
     WHERE i.id = $1`, [inspectionId])
  if (!ctx) throw new Error(`Inspection ${inspectionId} not found`)

  const items = await query<Item>(
    `SELECT area, item_label, condition, notes, estimated_repair_cost
       FROM unit_inspection_items WHERE inspection_id = $1 ORDER BY area, item_label`,
    [inspectionId])
  const sigs = await query<Sig>(
    `SELECT s.signer_role, s.signed_at, us.first_name || ' ' || us.last_name AS name
       FROM unit_inspection_signatures s JOIN users us ON us.id = s.signer_user_id
      WHERE s.inspection_id = $1 ORDER BY s.signed_at`,
    [inspectionId])

  // Move-out comparison detail (from→to) against the linked move-in.
  let mismatches: Array<{ area: string; item: string; from: string; to: string }> = []
  if (ctx.inspection_type === 'move_out' && ctx.comparison_inspection_id) {
    const inItems = await query<Item>(
      `SELECT area, item_label, condition, notes, estimated_repair_cost FROM unit_inspection_items WHERE inspection_id = $1`,
      [ctx.comparison_inspection_id])
    const inMap = new Map(inItems.map(it => [`${it.area}|${it.item_label}`, it.condition]))
    for (const out of items) {
      if (!out.condition) continue
      const inCond = inMap.get(`${out.area}|${out.item_label}`)
      if (!inCond) continue
      if ((CONDITION_RANK[out.condition] ?? 0) > (CONDITION_RANK[inCond] ?? 0)) {
        mismatches.push({ area: out.area, item: out.item_label, from: inCond, to: out.condition })
      }
    }
  }

  if (!fs.existsSync(REPORT_DIR)) fs.mkdirSync(REPORT_DIR, { recursive: true })
  const pdfDoc = await PDFDocument.create()
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica)
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold)
  const black = rgb(0.09, 0.09, 0.11), grey = rgb(0.42, 0.42, 0.46), gold = rgb(0.788, 0.635, 0.153)
  const red = rgb(0.72, 0.16, 0.16), green = rgb(0.15, 0.5, 0.24)
  const margin = 54, pageW = 612, pageH = 792

  let page: PDFPage = pdfDoc.addPage([pageW, pageH])
  let y = pageH - margin
  const ensure = (need: number) => { if (y - need < margin) { page = pdfDoc.addPage([pageW, pageH]); y = pageH - margin } }
  // WinAnsi (StandardFonts.Helvetica) can't encode chars outside Latin-1 + a
  // few typographic extras. User data (notes, names) may contain anything —
  // normalize the common ones and drop the rest so a stray emoji / CJK / arrow
  // never throws mid-report.
  const safe = (s: string) => (s || '')
    .replace(/→/g, '->').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/…/g, '...')
    .replace(/[^\x09\x0A\x0D\x20-\xFF–—•]/g, '?')
  const text = (s: string, x: number, size: number, f: PDFFont, color = black) => page.drawText(safe(s), { x, y, size, font: f, color })
  const wrap = (s: string, max: number, size: number, f: PDFFont): string[] => {
    const words = safe(s).split(/\s+/); const lines: string[] = []; let cur = ''
    for (const w of words) {
      const t = cur ? cur + ' ' + w : w
      if (f.widthOfTextAtSize(t, size) > max && cur) { lines.push(cur); cur = w } else cur = t
    }
    if (cur) lines.push(cur)
    return lines.length ? lines : ['']
  }

  // ── Header ──
  text('INSPECTION REPORT', margin, 22, bold)
  y -= 8
  page.drawLine({ start: { x: margin, y: y - 4 }, end: { x: pageW - margin, y: y - 4 }, thickness: 1.5, color: gold })
  y -= 26
  text(`${TYPE_LABEL[ctx.inspection_type] ?? ctx.inspection_type} inspection`, margin, 12, bold, gold)
  y -= 22

  // ── Info block ──
  const tenantName = [ctx.tenant_first, ctx.tenant_last].filter(Boolean).join(' ') || '—'
  const addr = [ctx.street1, ctx.city, ctx.state].filter(Boolean).join(', ')
  const info: Array<[string, string]> = [
    ['Property:', ctx.property_name + (addr ? `  (${addr})` : '')],
    ['Unit:', `${ctx.unit_number ?? '—'}${ctx.unit_type ? '  ·  ' + humanize(ctx.unit_type) : ''}`],
    ['Tenant:', tenantName],
    ['Landlord:', ctx.landlord_name],
    ['Conducted by:', ctx.conducted_by ?? '—'],
    ['Finalized:', ctx.finalized_at ? new Date(ctx.finalized_at).toLocaleString('en-US') : '—'],
  ]
  for (const [k, v] of info) {
    ensure(16)
    text(k, margin, 10, bold, grey); text(v, margin + 92, 10, font)
    y -= 15
  }
  y -= 8

  // ── Move-out comparison result ──
  if (ctx.inspection_type === 'move_out' && ctx.comparison_inspection_id) {
    ensure(40)
    text('MOVE-OUT COMPARISON', margin, 11, bold, grey); y -= 16
    if (mismatches.length === 0) {
      text('Unit matches move-in condition — no new damage documented.', margin, 10, font, green); y -= 16
    } else {
      text(`${mismatches.length} item(s) worse than move-in:`, margin, 10, bold, red); y -= 15
      for (const m of mismatches) {
        ensure(14)
        text(`•  ${m.area} — ${m.item}:`, margin + 8, 9.5, font, black)
        text(`${condLabel(m.from)} -> ${condLabel(m.to)}`, margin + 300, 9.5, bold, red)
        y -= 14
      }
    }
    y -= 10
  }

  // ── Checklist by area ──
  ensure(24)
  text('CHECKLIST', margin, 11, bold, grey); y -= 18
  let lastArea = ''
  for (const it of items) {
    if (it.area !== lastArea) {
      ensure(20); y -= 4
      text(it.area, margin, 10.5, bold, black); y -= 15
      lastArea = it.area
    }
    ensure(14)
    const condColor = it.condition === 'damaged_missing' ? red
      : !it.condition ? grey : black
    text(it.item_label, margin + 12, 9.5, font)
    text(condLabel(it.condition), margin + 300, 9.5, bold, condColor)
    const cost = it.estimated_repair_cost != null && Number(it.estimated_repair_cost) > 0
      ? `$${Number(it.estimated_repair_cost).toFixed(2)}` : ''
    if (cost) text(cost, margin + 420, 9.5, font, red)
    y -= 13
    if (it.notes) {
      for (const line of wrap(it.notes, pageW - margin - (margin + 24), 8.5, font)) {
        ensure(11); text(line, margin + 24, 8.5, font, grey); y -= 11
      }
    }
  }
  y -= 10

  // ── Signatures ──
  if (sigs.length) {
    ensure(20 + sigs.length * 14)
    text('SIGNATURES', margin, 11, bold, grey); y -= 16
    for (const s of sigs) {
      text(`${humanize(s.signer_role)}:`, margin, 9.5, bold, black)
      text(`${s.name}  ·  ${new Date(s.signed_at).toLocaleString('en-US')}`, margin + 90, 9.5, font)
      y -= 14
    }
    y -= 8
  }

  // ── Footer ──
  ensure(14)
  text(`Generated by GAM  ·  ${new Date().toLocaleString('en-US')}`, margin, 8, font, grey)

  const bytes = await pdfDoc.save()
  const filename = `inspection-report-${inspectionId.slice(0, 8)}-${crypto.randomBytes(4).toString('hex')}.pdf`
  const filePath = path.join(REPORT_DIR, filename)
  fs.writeFileSync(filePath, bytes)
  return {
    filename,
    filePath,
    fileUrl: `/api/inspections/report-files/${filename}`,
    fileSize: bytes.length,
    pageCount: pdfDoc.getPageCount(),
  }
}

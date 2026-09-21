/**
 * S652 — THE ACKNOWLEDGEMENTS, AS THEIR OWN DOCUMENT.
 *
 * Nic, reading Blu's lease: "on the lease, there's an acknowledgement... is that
 * acknowledgement a legal requirement? And is that also in your disclosure
 * list?" Then: "can you get those acknowledgements, a copy of those into the
 * system?"
 *
 * It is a requirement, and it is in the list — `statutory_acknowledgement`, one
 * of the 45 categories. What it was NOT was a document GAM could hand anybody:
 * it existed only as four initial lines buried on page 4 of one park's lease
 * form, which is exactly the shape that cannot be sent to a sitting tenant who
 * signed on paper years ago, and cannot be reused by the next Illinois park.
 *
 * So it becomes a one-page form of its own, categorised, state-tagged, and
 * fielded. The four lines are the Illinois Mobile Home Landlord and Tenant
 * Rights Act's own list — the IDPH pamphlet, the lease exhibited before
 * signing, the 24-month written offer made on a date that precedes signature,
 * and the park rules — reproduced from Blu's form, which is where they were
 * already correct.
 *
 * GAM DOES NOT POLICE THIS. Nic: "We don't police what's required where... they
 * could upload the other 13 to kind of fill out the robustness of their
 * operation." This is a form on the shelf, tagged IL so the coverage view can
 * say the shelf is stocked. Nobody is blocked for not using it.
 *
 * NOT added to Blu's packet: his lease already carries these four lines on page
 * 4, and a packet that asks the same household to initial them twice is worse
 * than one that asks once. This copy is for the next park, and for a tenant
 * whose lease predates GAM.
 *
 *     DRY=1 npx ts-node apps/api/src/scripts/mattoon/load9_il_acknowledgements.ts
 */
import fs from 'fs'
import path from 'path'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { query } from '../../db'

const LANDLORD_ID = 'e8904104-ab16-4d02-b6f8-cac88d738aae' // TruBlu Management LLC
const DRY = process.env.DRY === '1'

const TITLE = 'STATUTORY ACKNOWLEDGEMENTS'
const SUBTITLE = 'Mobile Home Park Lot Lease — Illinois'
const INTRO = 'Tenant acknowledges, by initialing:'
const ITEMS = [
  'Tenant was offered the Illinois Department of Public Health pamphlet on tenant and park operator rights.',
  'Tenant was exhibited a copy of the Lease before signing.',
  'On the date written below — a date preceding the signatures below — Landlord offered Tenant a written lease of not less than twenty-four (24) months.',
  'Tenant received the Park Rules before signing.',
]

async function build(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([612, 792]) // US Letter
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  const ink = rgb(0, 0, 0)
  const L = 54, R = 558

  const draw = (t: string, x: number, y: number, size: number, f = font) =>
    page.drawText(t, { x, y, size, font: f, color: ink })

  // Wrap to the column width, returning the y below the last line drawn.
  const para = (t: string, x: number, y: number, size: number, width: number): number => {
    const words = t.split(' ')
    let line = ''
    for (const w of words) {
      const next = line ? `${line} ${w}` : w
      if (font.widthOfTextAtSize(next, size) > width) { draw(line, x, y, size); y -= size + 3; line = w }
      else line = next
    }
    if (line) { draw(line, x, y, size); y -= size + 3 }
    return y
  }

  let y = 726
  draw(TITLE, L, y, 15, bold); y -= 19
  draw(SUBTITLE, L, y, 10.5); y -= 26
  page.drawLine({ start: { x: L, y }, end: { x: R, y }, thickness: 0.8, color: ink }); y -= 26

  const propY = y
  draw('Property:', L, y, 10, bold); page.drawLine({ start: { x: L + 58, y: y - 2 }, end: { x: 330, y: y - 2 }, thickness: 0.6, color: ink })
  draw('Lot #:', 348, y, 10, bold); page.drawLine({ start: { x: 390, y: y - 2 }, end: { x: R, y: y - 2 }, thickness: 0.6, color: ink })
  y -= 26
  const tenantY = y
  draw('Tenant:', L, y, 10, bold); page.drawLine({ start: { x: L + 58, y: y - 2 }, end: { x: 330, y: y - 2 }, thickness: 0.6, color: ink })
  draw('Date:', 348, y, 10, bold); page.drawLine({ start: { x: 390, y: y - 2 }, end: { x: R, y: y - 2 }, thickness: 0.6, color: ink })
  y -= 36

  draw(INTRO, L, y, 11, bold); y -= 22

  const initialBoxes: Array<{ y: number }> = []
  ITEMS.forEach((text, i) => {
    draw(`(${i + 1})`, L, y, 10.5, bold)
    page.drawLine({ start: { x: L + 24, y: y - 2 }, end: { x: L + 66, y: y - 2 }, thickness: 0.7, color: ink })
    initialBoxes.push({ y })
    const after = para(text, L + 78, y, 10.5, R - (L + 78))
    y = Math.min(y - 24, after - 14)
  })

  y -= 4
  const offerY = y
  draw('Date of the written 24-month offer:', L, y, 10, bold)
  page.drawLine({ start: { x: L + 186, y: y - 2 }, end: { x: L + 336, y: y - 2 }, thickness: 0.7, color: ink })
  y -= 46

  page.drawLine({ start: { x: L, y }, end: { x: R, y }, thickness: 0.8, color: ink }); y -= 22
  draw('LANDLORD', L, y, 10, bold); draw('TENANT', 330, y, 10, bold); y -= 30

  const sigY = y
  for (const x of [L, 330]) {
    page.drawLine({ start: { x, y: sigY }, end: { x: x + 200, y: sigY }, thickness: 0.7, color: ink })
    draw('Signature', x, sigY - 12, 8.5)
    page.drawLine({ start: { x, y: sigY - 44 }, end: { x: x + 200, y: sigY - 44 }, thickness: 0.7, color: ink })
    draw('Print name', x, sigY - 56, 8.5)
    page.drawLine({ start: { x, y: sigY - 88 }, end: { x: x + 200, y: sigY - 88 }, thickness: 0.7, color: ink })
    draw('Date', x, sigY - 100, 8.5)
  }

  ;(build as any).anchors = { initialBoxes, offerY, sigY, propY, tenantY }
  return pdf.save()
}

async function main() {
  const existing = await query<{ id: string }>(
    `SELECT id FROM lease_templates
      WHERE landlord_id=$1 AND disclosure_type='statutory_acknowledgement' AND state_code='IL'`,
    [LANDLORD_ID])
  if (existing.length) { console.log('already loaded:', existing[0].id); return }

  const bytes = await build()
  const { initialBoxes, offerY, sigY, propY, tenantY } = (build as any).anchors as
    { initialBoxes: Array<{ y: number }>, offerY: number, sigY: number, propY: number, tenantY: number }

  const filename = `${Date.now()}-il-statutory-acknowledgements.pdf`
  const dir = path.resolve(__dirname, '../../../uploads/leases')
  const dest = path.join(dir, filename)

  // Field coordinates are stored top-left origin, the way the placer writes them;
  // pdf-lib draws from the bottom. One conversion, here, against the same page height.
  const H = 792
  const top = (yBottom: number, h: number) => H - yBottom - h

  const fields: Array<[string, string | null, string, string | null, number, number, number, number, boolean, number]> = [
    // type, signer_role, label, lease_column, x, y, w, h, required, sort
    ['text',      null,      'Property',  'property_name',   112, top(propY - 2, 16),   218, 16, false, 1],
    ['text',      null,      'Lot #',     'unit_number',     390, top(propY - 2, 16),   168, 16, false, 2],
    ['text',      null,      'Tenant',    'tenant_name',     112, top(tenantY - 2, 16), 218, 16, false, 3],
    ['date',      'primary', 'Date',      'date_signed',     390, top(tenantY - 2, 16), 168, 16, true,  4],
  ]
  initialBoxes.forEach((b, i) => fields.push(
    ['initials', 'primary', `Acknowledgement ${i + 1}`, 'tenant_initial', 78, top(b.y - 2, 16), 42, 16, true, 10 + i]))
  fields.push(['text', null, 'Date of the 24-month offer', null, 240, top(offerY - 2, 16), 150, 16, false, 20])
  fields.push(
    ['signature', 'landlord', 'Landlord signature', 'landlord_signature', 54,  top(sigY, 30), 200, 30, true, 30],
    ['text',      'landlord', 'Landlord print',     'landlord_name',     54,  top(sigY - 44, 16), 200, 16, false, 31],
    ['date',      'landlord', 'Landlord date',      'date_signed',       54,  top(sigY - 88, 16), 200, 16, true, 32],
    ['signature', 'primary',  'Tenant signature',   'tenant_signature',  330, top(sigY, 30), 200, 30, true, 33],
    ['text',      'primary',  'Tenant print',       'tenant_name',       330, top(sigY - 44, 16), 200, 16, false, 34],
    ['date',      'primary',  'Tenant date',        'date_signed',       330, top(sigY - 88, 16), 200, 16, true, 35],
  )

  if (DRY) {
    if (process.env.DRY_OUT) { fs.writeFileSync(process.env.DRY_OUT, bytes); console.log('preview ->', process.env.DRY_OUT) }
    console.log(`would write ${dest} (${bytes.length} bytes) + ${fields.length} fields`)
    for (const f of fields) console.log('   ', f.slice(0, 4).join(' | '))
    return
  }

  fs.writeFileSync(dest, bytes)
  console.log('wrote', dest)

  const tpl = await query<{ id: string }>(
    `INSERT INTO lease_templates
       (landlord_id, name, description, base_pdf_url, page_count, unit_type,
        purpose, applies_to, disclosure_type, state_code)
     VALUES ($1,$2,$3,$4,1,'mobile_home','state_disclosure','rental','statutory_acknowledgement','IL')
     RETURNING id`,
    [LANDLORD_ID,
     'Illinois Statutory Acknowledgements — Mobile Home Park',
     'The four acknowledgements an Illinois park operator takes at signing: the IDPH pamphlet, the lease exhibited beforehand, the written 24-month offer, and the park rules. Reproduced as a standalone form so it can be sent on its own.',
     `/api/esign/files/${filename}`])
  const templateId = tpl[0].id

  for (const [type, role, label, col, x, y, w, h, req, sort] of fields) {
    await query(
      `INSERT INTO lease_template_fields
         (template_id, field_type, signer_role, label, lease_column, page, x, y, width, height, required, sort_order)
       VALUES ($1,$2,$3,$4,$5,1,$6,$7,$8,$9,$10,$11)`,
      [templateId, type, role, label, col, x, y, w, h, req, sort])
  }
  console.log('template', templateId, 'with', fields.length, 'fields')
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })

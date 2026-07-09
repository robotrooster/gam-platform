// S535 demo seed: the CROSS-TEMPLATE renewal test run (Nic).
// Creates a second, visually different lease template — "Updated
// Residential Lease (2026)" — binding a WIDER field set (lease type,
// pet deposit, late fee, utility responsibilities) than the original
// demo form, so renewing an existing lease onto it demonstrates the
// old lease's data auto-populating a brand-new form. Also enriches
// Carol Vasquez's Apt 202 demo lease with the terms the new form
// binds (late fee $50 flat / 3-day grace, electric = tenant,
// water = landlord) so every field has something to carry.
// Idempotent. Run from apps/api:
//   node -r ts-node/register/transpile-only src/scripts/seedUpdatedTemplateDemo.ts
import fs from 'fs'
import path from 'path'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { query, queryOne } from '../db'

const CAROL_LEASE = '518d0504-e6f3-4855-8b9d-84add2e1306d'

async function buildPdf(): Promise<Uint8Array> {
  const W = 612, H = 792
  const doc = await PDFDocument.create()
  const page = doc.addPage([W, H])
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const gray = rgb(0.45, 0.45, 0.45)
  const gold = rgb(0.63, 0.51, 0.15)
  const black = rgb(0.08, 0.08, 0.08)
  const text = (s: string, x: number, topY: number, o: { b?: boolean; size?: number; color?: any } = {}) =>
    page.drawText(s, { x, y: H - topY, size: o.size ?? 9.5, font: o.b ? bold : font, color: o.color ?? black })
  const blank = (x: number, topY: number, w: number, h: number, cap: string) => {
    page.drawLine({ start: { x, y: H - (topY + h) }, end: { x: x + w, y: H - (topY + h) }, thickness: 0.8, color: gray })
    page.drawText(cap, { x, y: H - topY + 3, size: 6.5, font, color: gray })
  }

  page.drawRectangle({ x: 0, y: H - 78, width: W, height: 78, color: rgb(0.97, 0.95, 0.9) })
  text('GOLD ASSET MANAGEMENT', 72, 40, { b: true, size: 11, color: gold })
  text('RESIDENTIAL LEASE — 2026 UPDATED FORM', 72, 62, { b: true, size: 15 })
  text('This updated-form Lease binds the parties below to the terms entered in this document.', 72, 94, { size: 9 })

  blank(72, 110, 200, 22, 'TENANT NAME')
  blank(300, 110, 90, 22, 'UNIT')
  blank(410, 110, 130, 22, 'LEASE TYPE')
  text('1. RENT & TERM. Rent is due on the first of each month for the term below.', 72, 150)
  blank(72, 160, 110, 22, 'MONTHLY RENT ($)')
  blank(210, 160, 110, 22, 'START DATE')
  blank(340, 160, 110, 22, 'END DATE')
  text('2. DEPOSITS. Held and returned per applicable law; carried deposits are never re-billed.', 72, 200)
  blank(72, 210, 110, 22, 'SECURITY DEPOSIT ($)')
  blank(210, 210, 110, 22, 'PET DEPOSIT ($)')
  text('3. LATE PAYMENT. The late fee below applies after the grace period.', 72, 250)
  blank(72, 260, 110, 22, 'LATE FEE ($)')
  blank(210, 260, 90, 22, 'GRACE (DAYS)')
  text('4. UTILITIES. Responsibility per utility (tenant / landlord):', 72, 300)
  blank(72, 310, 110, 22, 'ELECTRIC')
  blank(210, 310, 110, 22, 'WATER')

  const clauses: Array<[string, string]> = [
    ['5. OCCUPANCY.', 'Occupied only by Tenant and disclosed occupants; subletting needs written consent.'],
    ['6. MAINTENANCE.', 'Reported through the portal; Landlord maintains habitability per law.'],
    ['7. NOTICES.', 'Delivered through the portal and to addresses on file; check local requirements.'],
    ['8. ADDENDA.', 'Amendments are recorded as signed addenda through the platform.'],
    ['9. ENTIRE AGREEMENT.', 'This Lease with its addenda is the entire agreement between the parties.'],
  ]
  let y = 360
  for (const [head, body] of clauses) {
    text(head, 72, y, { b: true })
    text(body, 185, y)
    y += 26
  }

  text('EXECUTED by the parties below.', 72, 570)
  blank(72, 600, 200, 40, 'LANDLORD SIGNATURE')
  blank(300, 600, 110, 22, 'DATE')
  blank(72, 680, 200, 40, 'TENANT SIGNATURE')
  blank(300, 680, 110, 22, 'DATE')
  return doc.save()
}

async function main() {
  // 1. Base PDF (public demo asset, same pattern as demo-lease.pdf).
  const bytes = await buildPdf()
  // S535 lockdown: template demo assets live in uploads/public — the only
  // statically-served subdir besides unit-photos.
  const out = path.join(process.cwd(), 'uploads', 'public', 'updated-form-2026.pdf')
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, bytes)

  // 2. Template + fields (idempotent by name).
  const landlord = await queryOne<{ id: string }>(
    `SELECT l.id FROM landlords l JOIN users u ON u.id = l.user_id WHERE u.email = 'james@demo.dev'`)
  if (!landlord) throw new Error('demo landlord missing')
  let tmpl = await queryOne<{ id: string }>(
    `SELECT id FROM lease_templates WHERE landlord_id=$1 AND name='Updated Residential Lease (2026)'`,
    [landlord.id])
  if (!tmpl) {
    tmpl = await queryOne<{ id: string }>(
      `INSERT INTO lease_templates (landlord_id, name, description, base_pdf_url, page_count, is_active)
       VALUES ($1, 'Updated Residential Lease (2026)',
               'Updated form — wider term set: lease type, pet deposit, late fee, utilities',
               '/uploads/public/updated-form-2026.pdf', 1, TRUE)
       RETURNING id`, [landlord.id])
    const F = (type: string, role: string, label: string, col: string | null,
               x: number, y: number, w: number, h: number, req = true) =>
      query(`INSERT INTO lease_template_fields
               (template_id, field_type, signer_role, label, lease_column, page, x, y, width, height, required)
             VALUES ($1,$2,$3,$4,$5,1,$6,$7,$8,$9,$10)`,
        [tmpl!.id, type, role, label, col, x, y, w, h, req])
    await F('text', 'landlord', 'Tenant Name', 'tenant_name', 72, 110, 200, 22)
    await F('text', 'landlord', 'Unit', 'unit_number', 300, 110, 90, 22)
    await F('text', 'landlord', 'Lease Type', 'lease_type', 410, 110, 130, 22)
    await F('text', 'landlord', 'Monthly Rent', 'rent_amount', 72, 160, 110, 22)
    await F('date', 'landlord', 'Lease Start', 'start_date', 210, 160, 110, 22)
    await F('date', 'landlord', 'Lease End', 'end_date', 340, 160, 110, 22)
    await F('text', 'landlord', 'Security Deposit', 'security_deposit', 72, 210, 110, 22)
    await F('text', 'landlord', 'Pet Deposit', 'pet_deposit', 210, 210, 110, 22, false)
    await F('text', 'landlord', 'Late Fee', 'late_fee_initial_flat', 72, 260, 110, 22, false)
    await F('text', 'landlord', 'Late Fee Grace Days', 'late_fee_grace_days', 210, 260, 90, 22, false)
    await F('text', 'landlord', 'Electric Responsibility', 'utility_electric_responsibility', 72, 310, 110, 22, false)
    await F('text', 'landlord', 'Water Responsibility', 'utility_water_responsibility', 210, 310, 110, 22, false)
    await F('signature', 'landlord', 'Landlord Signature', 'landlord_signature', 72, 600, 200, 40)
    await F('date', 'landlord', 'Date Signed', 'date_signed', 300, 600, 110, 22)
    await F('signature', 'primary', 'Tenant Signature', 'tenant_signature', 72, 680, 200, 40)
    await F('date', 'primary', 'Date Signed', 'date_signed', 300, 680, 110, 22)
    console.log('Created template', tmpl!.id)
  } else {
    console.log('Template already exists', tmpl.id)
  }

  // 3. Enrich Carol's lease so the new form has data to carry.
  await query(`
    UPDATE leases SET late_fee_enabled=TRUE, late_fee_initial_amount=50,
           late_fee_initial_type='flat', late_fee_grace_days=3, updated_at=NOW()
     WHERE id=$1 AND late_fee_initial_amount IS NULL`, [CAROL_LEASE])
  await query(`
    INSERT INTO lease_utility_responsibilities (lease_id, utility_type, tenant_responsible)
    SELECT $1, v.t, v.r FROM (VALUES ('electric', TRUE), ('water', FALSE)) AS v(t, r)
    WHERE NOT EXISTS (SELECT 1 FROM lease_utility_responsibilities
                       WHERE lease_id=$1 AND utility_type=v.t)`, [CAROL_LEASE])
  console.log('Demo ready: renew Apt 202 onto "Updated Residential Lease (2026)"')
  process.exit(0)
}

main().catch(e => { console.error(e); process.exit(1) })

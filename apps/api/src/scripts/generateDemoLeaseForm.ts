// S534: regenerate uploads/leases/demo-lease.pdf as a REAL lease form.
// The demo template's base PDF was a blank 1.2KB stub, so the e-sign
// signing view rendered an empty white page with floating inputs —
// "open and sign doesn't render anything" (Nic). This draws a lease
// form whose printed labels + blanks line up with the demo template's
// lease_template_fields coordinates (top-left origin, 612×792):
//   y=120  Tenant Name (x72 w220) · Unit Number (x320 w120)
//   y=170  Monthly Rent (x72 w140) · Lease Start (x240 w130) · Lease End (x400 w130)
//   y=220  Security Deposit (x72 w140)
//   y=600  Landlord Signature (x72 w200) · Date (x300 w120)
//   y=680  Tenant Signature (x72 w200) · Date (x300 w120)
// Run from apps/api:  node -r ts-node/register/transpile-only src/scripts/generateDemoLeaseForm.ts
import fs from 'fs'
import path from 'path'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'

async function main() {
  const W = 612, H = 792
  const doc = await PDFDocument.create()
  const page = doc.addPage([W, H])
  const font = await doc.embedFont(StandardFonts.TimesRoman)
  const bold = await doc.embedFont(StandardFonts.TimesRomanBold)
  const gray = rgb(0.45, 0.45, 0.45)
  const black = rgb(0.1, 0.1, 0.1)

  // Helpers convert the template's top-left y to PDF bottom-left space.
  const text = (str: string, x: number, topY: number, opts: { b?: boolean; size?: number; color?: any } = {}) =>
    page.drawText(str, { x, y: H - topY, size: opts.size ?? 10, font: opts.b ? bold : font, color: opts.color ?? black })
  const blank = (x: number, topY: number, w: number, h: number, caption: string) => {
    // Underline at the field's bottom edge + a small caption above it.
    page.drawLine({ start: { x, y: H - (topY + h) }, end: { x: x + w, y: H - (topY + h) }, thickness: 0.8, color: gray })
    page.drawText(caption, { x, y: H - topY + 3, size: 7, font, color: gray })
  }

  text('RESIDENTIAL LEASE AGREEMENT', 72, 52, { b: true, size: 16 })
  text('Standard Residential Lease — Gold Asset Management', 72, 70, { size: 9, color: gray })
  text('This Lease Agreement ("Lease") is entered into between the Landlord and the Tenant named', 72, 96, { size: 9.5 })
  text('below for the premises identified below, on the terms set out in this Lease.', 72, 109, { size: 9.5 })

  blank(72, 120, 220, 24, 'TENANT NAME')
  blank(320, 120, 120, 24, 'UNIT')
  text('1. TERM AND RENT. Tenant agrees to pay the monthly rent below, due on the first day of', 72, 158, { size: 9.5 })
  blank(72, 170, 140, 24, 'MONTHLY RENT ($)')
  blank(240, 170, 130, 24, 'LEASE START')
  blank(400, 170, 130, 24, 'LEASE END')
  text('each month, for the term beginning and ending on the dates above.', 72, 212, { size: 9.5 })
  blank(72, 220, 140, 24, 'SECURITY DEPOSIT ($)')

  const clauses: Array<[string, string[]]> = [
    ['2. SECURITY DEPOSIT.', ['The deposit above is held per applicable law and returned less lawful', 'deductions within the statutory window after move-out.']],
    ['3. UTILITIES.', ['Sub-metered utilities are billed to Tenant monthly with meter reads shown on the', 'invoice. Utilities included in rent are identified in the utility addendum, if any.']],
    ['4. LATE PAYMENT.', ['Rent unpaid after any grace period stated in this Lease accrues the late', 'charges disclosed at signing. Fees appear on the monthly invoice.']],
    ['5. OCCUPANCY.', ['The premises are occupied only by Tenant and the occupants disclosed to', 'Landlord. Subletting requires prior written consent.']],
    ['6. MAINTENANCE.', ['Tenant reports maintenance through the portal. Landlord maintains the', 'premises in habitable condition as required by law.']],
    ['7. NOTICES.', ['Notices are delivered through the portal and to the addresses on file. Check', 'your local rules for jurisdiction-specific notice requirements.']],
    ['8. ENTIRE AGREEMENT.', ['This Lease with its addenda is the entire agreement. Amendments', 'are recorded as signed addenda through the platform.']],
  ]
  let y = 268
  for (const [head, lines] of clauses) {
    text(head, 72, y, { b: true, size: 9.5 })
    text(lines[0], 176, y, { size: 9.5 })
    if (lines[1]) { y += 13; text(lines[1], 72, y, { size: 9.5 }) }
    y += 24
  }

  text('IN WITNESS WHEREOF, the parties execute this Lease below.', 72, 570, { size: 9.5 })
  blank(72, 600, 200, 40, 'LANDLORD SIGNATURE')
  blank(300, 600, 120, 24, 'DATE')
  blank(72, 680, 200, 40, 'TENANT SIGNATURE')
  blank(300, 680, 120, 24, 'DATE')

  const bytes = await doc.save()
  const out = path.join(process.cwd(), 'uploads', 'leases', 'demo-lease.pdf')
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, bytes)
  console.log('Wrote', out, bytes.length, 'bytes')
}

main().catch(e => { console.error(e); process.exit(1) })

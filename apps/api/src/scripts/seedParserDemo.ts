// One-off demo seed (S534): populate the existing pending-tenant intent
// (Henry Park, james@demo.dev) with a realistic PARSED state so Nic can
// walk the lease-parser review window. Generates a lease-style PDF with
// pdf-lib, drops it in uploads/lease-pdfs-pending, and writes a
// ParserOutput + flags matching the shared shape. Run from apps/api:
//   npx ts-node <this file>
import fs from 'fs'
import path from 'path'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { query, queryOne } from '../db'

async function main() {
  const intent = await queryOne<any>(
    `SELECT pti.id FROM pending_tenant_intents pti
      JOIN tenants t ON t.id = pti.tenant_id
      JOIN users u ON u.id = t.user_id
     WHERE u.email = 'henry@tenant.dev' AND pti.resolved_at IS NULL`)
  if (!intent) throw new Error('Henry intent not found')

  // ── Lease-style PDF ────────────────────────────────────────────────
  const doc = await PDFDocument.create()
  const page = doc.addPage([612, 792])
  const font = await doc.embedFont(StandardFonts.TimesRoman)
  const bold = await doc.embedFont(StandardFonts.TimesRomanBold)
  let y = 740
  const line = (text: string, opts: { b?: boolean; size?: number; gap?: number } = {}) => {
    page.drawText(text, { x: 54, y, size: opts.size ?? 10.5, font: opts.b ? bold : font })
    y -= opts.gap ?? 16
  }
  line('RESIDENTIAL LEASE AGREEMENT — RV SPACE', { b: true, size: 14, gap: 26 })
  line('This Lease Agreement is made between Gold Asset Management (Landlord) and the', {})
  line('undersigned Tenant(s) for the premises described below.', { gap: 22 })
  line('PREMISES: Space RV 01, Sunset Palms RV Resort, Phoenix, AZ', { gap: 20 })
  line('TENANT: Henry Park', {})
  line('Phone: (602) 555-0184        Email: henry@tenant.dev', { gap: 20 })
  line('TERM: This lease is for a fixed term beginning August 1, 2026 and ending', {})
  line('July 31, 2027, after which it converts to a month-to-month tenancy unless', {})
  line('either party gives thirty (30) days written notice.', { gap: 20 })
  line('RENT: Tenant agrees to pay rent in monthly installments of $650.00, due on', {})
  line('the first (1st) day of each month.', { gap: 20 })
  line('SECURITY DEPOSIT: One month\'s rent ($650.00), due prior to move-in and held', {})
  line('per applicable law.', { gap: 20 })
  line('LATE FEES: A late fee of $35.00 applies after a grace period of three (3) days.', { gap: 20 })
  line('UTILITIES: Electric is sub-metered and billed to Tenant monthly. Water and', {})
  line('sewer are included in rent.', { gap: 20 })
  line('SUBLETTING: Subletting is not permitted without prior written consent.', { gap: 30 })
  line('Tenant signature: ____________________________     Date: ____________', { gap: 20 })
  line('Landlord signature: __________________________     Date: ____________', {})
  const bytes = await doc.save()

  const filename = `${Date.now()}-demolease01.pdf`
  const dir = path.join(process.cwd(), 'uploads', 'lease-pdfs-pending')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, filename), bytes)

  // ── ParserOutput (shared shape) ────────────────────────────────────
  const f = (value: any, confidence: number, rawText?: string) => ({ value, confidence, ...(rawText ? { rawText } : {}) })
  const output = {
    tenants: [{
      firstName: f('Henry', 0.96, 'TENANT: Henry Park'),
      lastName:  f('Park', 0.96, 'TENANT: Henry Park'),
      email:     f('henry@tenant.dev', 0.98, 'Email: henry@tenant.dev'),
      phone:     f('6025550184', 0.62, 'Phone: (602) 555-0184'),
      isPrimary: true,
    }],
    unit: {
      propertyName: f('Sunset Palms RV Resort', 0.93, 'Space RV 01, Sunset Palms RV Resort'),
      unitNumber:   f('RV 01', 0.91, 'Space RV 01'),
      unitType:     f('rv_spot', 0.85),
    },
    lease: {
      leaseType:          f('fixed_term', 0.9, 'fixed term beginning August 1, 2026'),
      leaseStart:         f('2026-08-01', 0.94, 'beginning August 1, 2026'),
      leaseEnd:           f('2027-07-31', 0.94, 'ending July 31, 2027'),
      monthlyRent:        f(650, 0.97, 'monthly installments of $650.00'),
      securityDeposit:    f(650, 0.88, "Security Deposit: One month's rent ($650.00)"),
      lateFeeAmount:      f(35, 0.9, 'late fee of $35.00'),
      lateFeeGraceDays:   f(3, 0.9, 'grace period of three (3) days'),
      autoRenew:          f(true, 0.82, 'converts to a month-to-month tenancy'),
      autoRenewMode:      f('convert_to_month_to_month', 0.82),
      noticeDaysRequired: f(30, 0.9, 'thirty (30) days written notice'),
      subleasingAllowed:  f('with_consent', 0.8, 'not permitted without prior written consent'),
    },
    extractionExtras: {
      utilities: 'Electric sub-metered to tenant; water/sewer included in rent',
    },
    parserVersion: 'gam-parser-0.1.0',
    parsedAt: new Date().toISOString(),
  }
  const flags = [
    {
      category: 'field_low_confidence', severity: 'confirm', field: 'tenants.0.phone',
      message: 'Phone number extracted with low confidence — verify against the document.',
      found: '(602) 555-0184',
    },
    {
      category: 'field_missing', severity: 'confirm', field: 'tenants.0.dateOfBirth',
      message: 'Date of birth could not be located in the document.',
    },
  ]

  await query(
    `UPDATE pending_tenant_intents
        SET parser_status = 'parsed',
            imported_pdf_url = $2,
            parser_output = $3::jsonb,
            parser_flags = $4::jsonb,
            parser_error = NULL,
            parser_started_at = NOW() - interval '2 minutes',
            parser_finished_at = NOW(),
            updated_at = NOW()
      WHERE id = $1`,
    [intent.id, filename, JSON.stringify(output), JSON.stringify(flags)])

  console.log('Seeded parsed intent', intent.id, '→', filename)
  process.exit(0)
}

main().catch(e => { console.error(e); process.exit(1) })

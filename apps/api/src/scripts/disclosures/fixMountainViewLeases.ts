/**
 * S652 — Mountain View's leases stop saying Oak Park.
 *
 * Nic: "all things to do with Mountain View should not reference Oak Park at
 * all. Anywhere that says Oak Park should say Mountain View RV Park Ranch LLC or
 * a shortened version of that to fit in the available space... wherever the
 * space allows it to not overlap the next line of text." LLC name, per Nic:
 * Mountain View RV Park Ranch LLC. Park manager: Nicholas Rhoades. Address and
 * phone as they already appear on Mountain View's own mobile home lease.
 *
 * HOW. Each wrong run of text is covered and the right text drawn in the same
 * place, in Times (the leases are Times New Roman), sized down only as far as
 * needed to stay inside the space the old text had. The page itself — its size,
 * its layout, where every box sits — is untouched, so the templates keep their
 * boxes; each gets the new file through the same path as Replace PDF, and the
 * lease is re-read for what it contains. Documents already sent keep the file
 * they were sent with.
 *
 *   PREVIEW=<dir> ... writes the corrected PDFs to <dir>, changes nothing
 *   (no env)      ... writes them to uploads and points both templates at them
 */
import fs from 'fs'
import path from 'path'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { query } from '../../db'

// A band of a line to clear — every run inside it, the visible text AND the
// older text hidden underneath from an earlier edit — and what to write there.
// FOUND WHILE DOING THIS: most of this lease was already corrected by an
// earlier edit that typed Mountain View on top of Oak Park, leaving the old
// words in the file underneath. A text reader sees both layers, which is how
// the header got reported as saying Oak Park when the page shows Mountain View.
// Only what is still wrong ON THE PAGE is touched here, after rendering each
// line to check.
type Fix = {
  page: number; baseline: number; x1: number; x2: number; text: string; bold?: boolean
  maxRight?: number   // the line is empty after x2 — the new text may run to here at full size
  fitTo?: number      // clear to x2 but keep the text short of this (the space before the next word)
}

const RV: Fix[] = [
  // "between Mountain View RV Park LLC (“Landlord”)": add Ranch; the earlier edit
  // also ran into "Landlord".
  { page: 1, baseline: 371.7, x1: 43.0, x2: 224.4, text: 'between Mountain View RV Park Ranch LLC (“' },
  // premises: add Ranch and the comma; the earlier edit ran into "(“Premises”)".
  // the earlier edit's text ran under "(“", so that bracket is cleared and redrawn too
  { page: 1, baseline: 321.2, x1: 43.0, x2: 410.2, fitTo: 410.0, text: 'stay in this park, Mountain View RV Park Ranch, 2843 E Frontage Rd, Amado AZ 85645 (“' },
  // rent payable to "Mountain View RV Park LLC" → Ranch; it ran into the closing quote.
  // takes the closing quote's room too, so the name stays readable
  { page: 2, baseline: 447.7, x1: 106.9, x2: 263.8, fitTo: 261.0, text: 'Mountain View RV Park Ranch LLC”.', bold: true },
  // still says Oak Park — and the line is empty after it, so full size
  { page: 4, baseline: 346.4, x1: 211.3, x2: 357.1, text: 'Mountain View Rules and Regulations.', maxRight: 568 },
  // "The Premises is managed by Richard Wolvin" — the manager is Nicholas Rhoades
  { page: 5, baseline: 333.8, x1: 43.1, x2: 518.8,
    text: 'by Nicholas Rhoades but Landlord may from time to time appoint a new manager. The present Park Manager' },
]
const MH: Fix[] = [
  { page: 4, baseline: 397.0, x1: 211.3, x2: 357.1, text: 'Mountain View Rules and Regulations.', maxRight: 568 },
]

const DIR = path.resolve(__dirname, '../../../uploads/leases')
const FILES = {
  rv: { src: '1788361156208-2bcan0x2uwr.pdf', template: 'Mountain View RV Spot Lease', fixes: RV },
  mh: { src: '1788315512907-8258etqvoju.pdf', template: 'Mountain View Mobile Home', fixes: MH },
}

async function fixFile(src: string, fixes: Fix[]): Promise<Uint8Array> {
  const bytes = fs.readFileSync(path.join(DIR, src))
  const pdf = await PDFDocument.load(bytes)
  const regular = await pdf.embedFont(StandardFonts.TimesRoman)
  const bold = await pdf.embedFont(StandardFonts.TimesRomanBold)
  const SIZE = 11.04   // the lease's body size
  for (const f of fixes) {
    const page = pdf.getPage(f.page - 1)
    // clear the band: from a descender below this baseline (and the hidden
    // run a point lower) to the cap height above it
    page.drawRectangle({ x: f.x1, y: f.baseline - 4.2, width: f.x2 - f.x1, height: 14.6, color: rgb(1, 1, 1) })
    const font = f.bold ? bold : regular
    const room = (f.maxRight ?? f.fitTo ?? f.x2) - f.x1
    let s = SIZE
    while (s > 6 && font.widthOfTextAtSize(f.text, s) > room) s -= 0.05
    page.drawText(f.text, { x: f.x1 + 0.1, y: f.baseline, size: s, font, color: rgb(0, 0, 0) })
    console.log(`  p${f.page}  ${s.toFixed(1)}pt  ${f.text.slice(0, 72)}`)
  }
  return pdf.save()
}

;(async () => {
  const out = process.env.PREVIEW
  for (const [key, f] of Object.entries(FILES)) {
    console.log(`\n${f.template}`)
    const fixed = await fixFile(f.src, f.fixes)
    const name = `${Date.now()}-${key}-mountain-view-corrected.pdf`
    if (out) { fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(path.join(out, name), fixed); console.log('  preview →', name); continue }
    fs.writeFileSync(path.join(DIR, name), fixed)
    const t = await query<{ id: string; base_pdf_url: string }>(
      `SELECT id, base_pdf_url FROM lease_templates WHERE name=$1 AND is_active`, [f.template])
    if (t.length !== 1 || !t[0].base_pdf_url.endsWith(f.src)) throw new Error(`template ${f.template} is not on ${f.src}`)
    await query(`UPDATE lease_templates SET base_pdf_url=$2, updated_at=now() WHERE id=$1`, [t[0].id, `/api/esign/files/${name}`])
    const { detectCoverings } = await import('../../services/sleeveDetection')
    const exec = { query: (sql: string, params: any[]) => query<any>(sql, params).then(r => ({ rows: r })) }
    const r = await detectCoverings(exec, t[0].id)
    console.log(`  template now on ${name}; re-read: ${r.covered.join(', ')}`)
  }
  process.exit(0)
})().catch(e => { console.error(e.message); process.exit(1) })

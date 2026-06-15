/**
 * PDF-based statute ingester (S453) for states that publish their code only as
 * text-based PDFs (ND Century Code; extensible to others). Downloads each
 * chapter PDF, extracts text with `pdftotext -layout`, and splits into sections
 * by the state's section-number pattern.
 *
 * Run: cd apps/api && node -r ts-node/register src/db/ingestPdfStateLaw.ts <STATE|ALL>
 * Requires the `pdftotext` binary (poppler). Idempotent (ON CONFLICT DO NOTHING).
 */

import { execFileSync } from 'child_process'
import { query } from './index'

const SOURCE_DATE = '2026-06-13'
const EFFECTIVE_YEAR = 2026

interface ActSpec { actKey: string; url: string; sectionRe: RegExp }
interface StateSpec {
  state: string
  acts: ActSpec[]
  /** Optional: only keep section numbers matching this — lets an act point at a
   *  whole-title PDF with a broad sectionRe (so every section is correctly
   *  bounded by the next header) while storing only the landlord/tenant range. */
  keepRe?: RegExp
}

function pdfToText(url: string): string {
  const tmp = `/tmp/pdfstat_${Date.now()}_${Math.floor(Math.abs(Math.sin(url.length) * 1e6))}.pdf`
  execFileSync('curl', ['-sL', '--max-time', '60', '-A', 'GAM-statute-ingest/1.0', '-o', tmp, url], { maxBuffer: 256 * 1024 * 1024 })
  const out = execFileSync('pdftotext', ['-layout', tmp, '-'], { maxBuffer: 256 * 1024 * 1024 }).toString('utf8')
  try { execFileSync('rm', ['-f', tmp]) } catch {}
  return out
}

function clean(s: string): string {
  return s.replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

interface Sec { number: string; title: string | null; text: string }

function split(text: string, act: ActSpec, keepRe?: RegExp): Sec[] {
  const re = new RegExp(act.sectionRe.source, act.sectionRe.flags.includes('g') ? act.sectionRe.flags : act.sectionRe.flags + 'g')
  const hits: { num: string; start: number; end: number }[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    // Normalize unicode dashes to ASCII hyphen so keepRe (ASCII) matches and the
    // stored number is consistent with citationFor (same trap as the headless ingester).
    const num = m[1].trim().replace(/[‐-―]/g, '-')
    hits.push({ num, start: m.index, end: m.index + m[0].length })
    if (m.index === re.lastIndex) re.lastIndex++
  }
  const out: Sec[] = []
  for (let i = 0; i < hits.length; i++) {
    if (keepRe && !keepRe.test(hits[i].num)) continue
    let body = clean(text.slice(hits[i].end, i + 1 < hits.length ? hits[i + 1].start : undefined))
    // drop trailing source/history note lines
    body = body.replace(/\n(Source:|S\.L\. \d{4})[\s\S]*$/i, '').trim()
    let title: string | null = null
    const dot = body.indexOf('.')
    if (dot > 0 && dot <= 110) title = body.slice(0, dot).replace(/\n/g, ' ').trim() || null
    out.push({ number: hits[i].num, title, text: body })
  }
  return out
}

const CONFIGS: Record<string, StateSpec> = {
  // North Dakota Century Code — text PDFs at ndlegis.gov/cencode/. Title 47:
  // ch 47-16 Leasing of Real Property (the general landlord/tenant chapter);
  // ch 47-17 rights/obligations of lessor & lessee. Sections like "47-16-01.".
  ND: {
    state: 'ND',
    acts: [
      { actKey: 'residential', url: 'https://ndlegis.gov/cencode/t47c16.pdf', sectionRe: /\b(47-16-\d+(?:\.\d+)?)\.\s/ },
      { actKey: 'general_landlord_tenant', url: 'https://ndlegis.gov/cencode/t47c17.pdf', sectionRe: /\b(47-17-\d+(?:\.\d+)?)\.\s/ },
    ],
  },
  // Colorado Revised Statutes — official .gov PDF (whole Title 38 = Property).
  // Article 38-12 "Tenants and Landlords" holds all L/T law (deposits 38-12-101+,
  // mobile-home-park 38-12-200/1001+, residential health/safety 38-12-501+,
  // eviction/warranty 38-12-801+). The 38-12 regex keeps only that article.
  CO: {
    state: 'CO',
    acts: [
      { actKey: 'residential', url: 'https://leg.colorado.gov/sites/default/files/images/olls/crs2023-title-38.pdf', sectionRe: /\b(38-12-\d+(?:\.\d+)?)\.\s/ },
    ],
  },
  // Wyoming Statutes — official whole-title PDFs at wyoleg.gov/statutes/compress/.
  // All residential L/T law sits in Title 1, Chapter 21: Article 10 Forcible Entry
  // & Detainer (eviction, 1-21-1001+), Article 12 Residential Rental Property Act
  // (1-21-1201+), Article 13 Safe Homes Act (domestic-abuse lease protections,
  // 1-21-1301+). The sectionRe matches EVERY Title-1 header (so each kept section
  // is bounded by the next header in the doc, not run to EOF); keepRe restricts
  // storage to the Ch-21 L/T range. (Article 11 is all repealed — excluded.)
  // Title 34/29 fragments (deposit interest, liens) deferred.
  WY: {
    state: 'WY',
    keepRe: /^1-21-(10|12|13)\d\d$/,
    acts: [
      { actKey: 'residential', url: 'https://wyoleg.gov/statutes/compress/title01.pdf', sectionRe: /^[ \t]+(\d+-\d+-\d+(?:\.\d+)?)\.[ \t]/m },
    ],
  },
  // Pennsylvania — residential L/T law is UNCONSOLIDATED (not in Pa.C.S. Title 68);
  // it lives entirely in the Landlord and Tenant Act of 1951 (Act 20 of 1951,
  // 68 P.S. § 250.101+), which the official PA General Assembly site (palegis.us,
  // formerly legis.state.pa.us) serves as a clean text PDF via view-statute?txtType=PDF.
  // The whole Act (incl. Article V eviction/notice-to-quit + security-deposit rules)
  // is one PDF → one 'residential' act. Mobile/manufactured-home-park tenancies are
  // a separate 1976 Act (Act 261, "Manufactured Home Community Rights Act").
  // Section headers in the PDF body read "  Section 501.  Notice to Quit.--(a)…";
  // the lookahead keeps the catchline intact, the {2,} indent excludes the col-0 TOC,
  // and the optional \f tolerates pdftotext page-break form-feeds before a header.
  PA: {
    state: 'PA',
    acts: [
      { actKey: 'residential', url: 'https://www.palegis.us/statutes/unconsolidated/law-information/view-statute?txtType=PDF&SessYr=1951&ActNum=0020.&SessInd=0', sectionRe: /^\f? {2,}Section\s+(\d+(?:\.\d+)?(?:-[A-Z])?)\.\s+(?=[A-Z("])/m },
      { actKey: 'mobile_home_park', url: 'https://www.palegis.us/statutes/unconsolidated/law-information/view-statute?txtType=PDF&SessYr=1976&ActNum=0261.&SessInd=0', sectionRe: /^\f? {2,}Section\s+(\d+(?:\.\d+)?(?:-[A-Z])?)\.\s+(?=[A-Z("])/m },
    ],
  },
}

async function main() {
  const want = (process.argv[2] || 'ALL').toUpperCase()
  const targets = want === 'ALL' ? Object.keys(CONFIGS) : [want]
  for (const st of targets) {
    const spec = CONFIGS[st]
    if (!spec) { console.error('no PDF config for', st); continue }
    console.log(`\n=== ${spec.state} (PDF) ===`)
    const counts: Record<string, number> = {}
    let total = 0
    for (const act of spec.acts) {
      try {
        const text = pdfToText(act.url)
        const secs = split(text, act, spec.keepRe)
        let ok = 0
        for (const s of secs) {
          if (!s.text || s.text.length < 25) continue
          await query(
            `INSERT INTO state_law_section_texts
               (state_code, act_key, section_number, section_title, full_text, source_url, source_date, effective_year)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
             ON CONFLICT (state_code, act_key, section_number, effective_year) DO NOTHING`,
            [spec.state, act.actKey, s.number, s.title, s.text, act.url, SOURCE_DATE, EFFECTIVE_YEAR]
          )
          ok++
        }
        counts[act.actKey] = (counts[act.actKey] || 0) + ok
        total += ok
        console.log(`  [${act.actKey}] ${act.url.split('/').pop()} → ${secs.length} parsed, ${ok} kept`)
      } catch (e: any) {
        console.warn(`  ! ${act.actKey} ${act.url}: ${e?.message || e}`)
      }
    }
    console.log(`${spec.state} done. inserted=${total}`, counts)
  }
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })

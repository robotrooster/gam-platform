/**
 * California property-tax statute full-text ingester (CA legal corpus,
 * property_tax category — the sanctioned retrieve+cite+date carve-out:
 * verbatim statutory text, never advice).
 *
 * SOURCE (official only — leginfo.legislature.ca.gov, no Justia/Lexis/Wayback):
 *   California Revenue and Taxation Code, Division 1 — Property Taxation
 *   (§§ 50-5911). Plain curl with a normal User-Agent returns full HTML;
 *   no JS/cookies needed.
 *
 * STRATEGY — fetch whole articles/chapters at once, not section-by-section.
 * The TOC tree (codes_displayexpandedbranch.xhtml for Division 1) enumerates
 * every leaf node as a `codes_displayText.xhtml?...&part=&chapter=&article=`
 * URL. Each displayText page renders the ENTIRE leaf's section run inline:
 *
 *   <h6 ...><a href="javascript:submitCodesValues('218.', '<treepath>',
 *      '<year>','<ch>','<sec>', '<id>')">218.</a></h6>
 *   <p style="margin:0;display:inline;">(a) ... body ...</p>
 *   ...
 *   <p style="...font-size:0.9em;"><i>(Amended by Stats. 2023, Ch. 781 ...)</i></p>
 *
 * The trailing enactment parenthetical (Amended/Added/Enacted by Stats. YYYY ...)
 * is the verbatim citation+date stamp; it is KEPT as the source-note trailer of
 * full_text. We split a leaf page on each submitCodesValues anchor: section
 * number = the anchor's first arg (trailing '.' stripped); body = everything
 * up to the next anchor (or the leaf-container end). Tags stripped, entities
 * unescaped, whitespace collapsed. Repealed/reserved/empty (<20 char) dropped.
 *
 * TOPIC -> PART MAP (the 5 feature-chapter groups from triage). Sections are
 * keyed uniquely by (state, act_key, section_number, year), so a section lands
 * exactly once regardless of grouping; ON CONFLICT DO NOTHING absorbs overlap.
 *   exemptions            -> Part 2 Ch 1 (Taxable & Exempt Property, §§201-242 +
 *                            welfare/charitable exemptions; homeowners' §218)
 *   assessment            -> Part 0.5 (change in ownership / new construction
 *                            §§60-69.5) + Part 2 (Assessment §§201-1367)
 *   assessment_review     -> Part 3 (Equalization §§1601-2125; appeals boards)
 *   levy_collection_payment -> Part 4 (Levy §§2151-2326) + Part 5 (Collection
 *                            §§2501-3205; Nov 1/Dec 10 due+delinquency §2617-18)
 *   delinquency_tax_sale  -> Part 6 (Tax Sales §§3351-3972) + Part 7 (Redemption
 *                            §§4101-4379)
 *
 * Run: cd apps/api && node -r ts-node/register src/db/ingestCAPropertyTax.ts
 * Idempotent (ON CONFLICT DO NOTHING).
 */

import { execFileSync } from 'child_process'
import { query } from './index'
import { stripTags } from './ingestStateLawCorpus'

const STATE = 'CA'
const ACT_KEY = 'property_tax'
const LAW_CATEGORY = 'property_tax'
const SOURCE_DATE = '2026-06-14'
const EFFECTIVE_YEAR = 2026
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) GAM-statute-ingest/1.0'
const BASE = 'https://leginfo.legislature.ca.gov/faces'

/** Per-section permalink (the canonical citable URL on the official site). */
const sectionUrl = (num: string) =>
  `${BASE}/codes_displaySection.xhtml?lawCode=RTC&sectionNum=${num}.`

/** Whole-leaf display page (renders every section in the part/chapter/article). */
const leafUrl = (part: string, chapter: string, article: string) =>
  `${BASE}/codes_displayText.xhtml?lawCode=RTC&division=1.&title=&part=${part}&chapter=${chapter}&article=${article}`

/** TOC branch for Division 1 — enumerates every displayText leaf node. */
const DIV1_BRANCH = `${BASE}/codes_displayexpandedbranch.xhtml?tocCode=RTC&division=1.&title=&part=&chapter=&article=&nodetreepath=2`

// The 5 topics map onto these Division-1 parts. Restrict harvested leaves to them.
const TARGET_PARTS = new Set(['0.5.', '2.', '3.', '4.', '5.', '6.', '7.'])

interface Leaf { part: string; chapter: string; article: string }
interface Section { number: string; title: string | null; text: string }

function curl(url: string): string {
  const buf = execFileSync('curl', ['-sL', '--max-time', '90', '-A', UA, url], {
    maxBuffer: 512 * 1024 * 1024,
  })
  return buf.toString('utf-8')
}

/**
 * Harvest every Division-1 leaf node (part/chapter/article triple) from the
 * expanded TOC branch, keeping only TARGET_PARTS. De-dupe preserving order.
 */
function harvestLeaves(html: string): Leaf[] {
  const re =
    /codes_displayText\.xhtml\?lawCode=RTC&amp;division=1\.&amp;title=&amp;part=([0-9.]*)&amp;chapter=([0-9.]*)&amp;article=([0-9.]*)/g
  const seen = new Set<string>()
  const out: Leaf[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const [, part, chapter, article] = m
    if (!TARGET_PARTS.has(part)) continue
    const key = `${part}|${chapter}|${article}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ part, chapter, article })
  }
  return out
}

/**
 * Parse one displayText leaf page into its constituent sections. Each section
 * begins at a submitCodesValues anchor and runs to the next anchor (or the end
 * of the rendered section run). full_text keeps the trailing enactment note.
 */
function parseLeaf(html: string): Section[] {
  // NOTE: do NOT pre-truncate on </body>. The displayText page emits the static
  // shell's </body> EARLY (~29KB), THEN injects the statute section run, THEN a
  // second </body>, THEN JSF nav chrome / ViewState. So the section anchors live
  // AFTER the first </body>; truncating there drops everything (v1 bug). Instead
  // we parse anchors on the full HTML and bound only the LAST section's run at
  // the first </body> that follows it (which strips the trailing nav chrome).
  // Anchor first-arg forms, ALL of which must be captured. RTC Division 1 today
  // numbers exclusively in the decimal style (218., 2192.1.), so the prior
  // digit-only regex was correct for the current corpus. But the sibling CIV/BPC
  // ingester (ingestCARealEstate.ts) DOES hit letter-suffix and bracket forms
  // (the nonjudicial-foreclosure run CIV 2924a-2924p, renumbered [1053.]), and a
  // digit-only regex silently drops those — absorbing their text into the
  // preceding section. We mirror that ingester's hardened regex here so the two
  // stay in parity and a future-year RTC addition in either form can't be
  // dropped silently:
  //   - bare number      submitCodesValues('218.', ...)
  //   - letter suffix    submitCodesValues('2924b.', ...)
  //   - bracketed        submitCodesValues('[1053.]', ...)
  // Strip surrounding brackets + the trailing dot to store the clean number;
  // lowercase the letter suffix for stable keying. The inner-text matcher must
  // be permissive ([^<]*) because such labels render as "2924b." / "[1053.]",
  // not pure digits.
  const anchorRe = /<a href="javascript:submitCodesValues\('(\[?[0-9]+(?:\.[0-9]+)*[a-zA-Z]*\.?\]?)'[^"]*"[^>]*>[^<]*<\/a>/g
  const marks: { num: string; start: number; end: number }[] = []
  let m: RegExpExecArray | null
  while ((m = anchorRe.exec(html)) !== null) {
    const num = m[1]
      .replace(/[[\]]/g, '')
      .replace(/\.$/, '')
      .replace(/([0-9])([A-Z]+)$/, (_s, d, l) => d + l.toLowerCase())
    marks.push({ num, start: anchorRe.lastIndex, end: 0 })
  }
  if (marks.length === 0) return []
  // Each section ends where the next section's <h6> row opens (so the trailing
  // enactment-note <p> stays with the section it belongs to). The last section
  // ends at the first </body> after it — past the statute run, before the chrome.
  for (let i = 0; i < marks.length; i++) {
    if (i + 1 < marks.length) {
      marks[i].end = findAnchorOpen(html, marks[i + 1].start)
    } else {
      const close = html.toLowerCase().indexOf('</body>', marks[i].start)
      marks[i].end = close === -1 ? html.length : close
    }
  }

  const out: Section[] = []
  for (const mk of marks) {
    const raw = html.slice(mk.start, mk.end)
    const text = stripTags(raw, true).trim()
    if (!text || text.length < 20) continue
    if (/^repealed\b/i.test(text)) continue
    if (/^\[?\s*reserved\.?\s*\]?$/i.test(text)) continue
    // CA RTC section bodies carry no separate catchline; title stays null.
    out.push({ number: mk.num, title: null, text })
  }
  return out
}

/** Walk backwards from an anchor's inner-text start to the opening <h6> of its row. */
function findAnchorOpen(html: string, anchorInnerStart: number): number {
  const h6 = html.lastIndexOf('<h6', anchorInnerStart)
  return h6 === -1 ? anchorInnerStart : h6
}

async function main() {
  console.log(`\n=== CA — ingesting property-tax full-text corpus (as of ${SOURCE_DATE}) ===`)

  const leaves = harvestLeaves(curl(DIV1_BRANCH))
  console.log(`harvested ${leaves.length} Division-1 leaf nodes across parts ${[...TARGET_PARTS].join(', ')}`)
  if (leaves.length === 0) throw new Error('TOC harvest returned 0 leaves — aborting (source layout changed?)')

  let inserted = 0
  let parsed = 0
  let skippedLeaves = 0
  const seenSections = new Set<string>()

  for (let i = 0; i < leaves.length; i++) {
    const lf = leaves[i]
    const url = leafUrl(lf.part, lf.chapter, lf.article)
    let sections: Section[] = []
    try {
      sections = parseLeaf(curl(url))
    } catch (e: any) {
      console.warn(`  ! leaf p${lf.part}c${lf.chapter}a${lf.article}: ${e?.message || e}`)
      skippedLeaves++
      continue
    }
    if (sections.length === 0) {
      skippedLeaves++
    }
    for (const s of sections) {
      parsed++
      if (seenSections.has(s.number)) continue // same section can recur if a leaf overlaps; first wins
      seenSections.add(s.number)
      const res = await query<{ id: string }>(
        `INSERT INTO state_law_section_texts
           (state_code, act_key, section_number, section_title, full_text, source_url, source_date, effective_year, law_category)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (state_code, act_key, section_number, effective_year) DO NOTHING
         RETURNING id`,
        [STATE, ACT_KEY, s.number, s.title, s.text, sectionUrl(s.number), SOURCE_DATE, EFFECTIVE_YEAR, LAW_CATEGORY]
      )
      if (res.length > 0) inserted++
    }
    process.stdout.write(
      `\r  [${i + 1}/${leaves.length}] p${lf.part}c${lf.chapter}a${lf.article || '-'}  parsed=${parsed} inserted=${inserted}   `
    )
    await new Promise((r) => setTimeout(r, 250)) // politeness
  }

  console.log(
    `\nCA done. leaves=${leaves.length} (empty/failed=${skippedLeaves}) parsedSections=${parsed} distinctInserted=${inserted}`
  )
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

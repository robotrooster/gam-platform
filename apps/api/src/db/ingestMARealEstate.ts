/**
 * Massachusetts non-tax REAL-ESTATE statute full-text ingester (S-corpus,
 * real-estate-domain batch). Sanctioned retrieve+cite+date carve-out: GAM
 * stores the VERBATIM official statute text, cites it, dates it, and NEVER
 * advises. Source is the official Massachusetts Legislature site only
 * (malegislature.gov General Laws).
 *
 * This is the reusable per-state ingester for MA's real-estate-adjacent
 * categories. Each block is keyed identically in law_category AND act_key
 * (e.g. broker_licensing/broker_licensing), inserted with
 *   ON CONFLICT (state_code, act_key, section_number, effective_year) DO NOTHING.
 *
 * --- broker_licensing ---------------------------------------------------------
 * Real-estate broker/salesman licensing is a SUB-RUN of the omnibus professions
 * chapter (M.G.L. Part I, Title XVI, Chapter 112 — Registration of Certain
 * Professions and Occupations), which carries 100+ sections covering every
 * licensed profession. The RE broker/salesman act is the contiguous
 * alpha-suffixed block §§ 87PP through 87DDD½.
 *
 * URL pattern: .../Chapter112/Section87{XX}, where {XX} is an alpha suffix.
 * MA encodes fractional ("half"/"quarter") sections in the URL with a tilde:
 *   Section87XX1~2  = § 87XX½        Section87DDD1~2 = § 87DDD½
 *   Section87AAA3~4 = § 87AAA¾
 *
 * The Chapter112 TOC lists ALL sections of ALL professions in document order,
 * and that order is NOT clean — e.g. § 87CCCC / § 87DDDD (Operators of Drinking
 * Water Supply Facilities, a SEPARATE profession's quadruple-letter block) sit
 * interleaved among the RE half-sections. So we cannot slice by TOC position; we
 * compute a real ORDINAL from each suffix — (tier=letter-repeat-count,
 * letterValue A=1..Z=26, fraction from the N~M tail) — and keep only those whose
 * ordinal falls in [87PP, 87DDD½]. That mathematically excludes the tier-4
 * drinking-water sections (87CCCC, 87DDDD, ...) while keeping every RE
 * half-section in range. § 87DDD itself is Repealed and is dropped by the
 * Repealed/Reserved filter in parseSectionPage.
 *
 * (Appraiser licensing — §§ 173-195, Board of Registration of Real Estate
 *  Appraisers — is a separate block in the same chapter; not requested here,
 *  so not ingested. Documented for a future appraiser run.)
 *
 * Run: cd apps/api && node -r ts-node/register src/db/ingestMARealEstate.ts
 * Idempotent. Reuses stripTags from the corpus framework.
 */

import { query } from './index'
import { stripTags } from './ingestStateLawCorpus'

const STATE = 'MA'
const SOURCE_DATE = '2026-06-14'
const EFFECTIVE_YEAR = 2026
const BASE = 'https://malegislature.gov'
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) GAM-statute-ingest/1.0 (compliance research)'

interface Parsed { number: string; title: string | null; text: string }

/**
 * Decode the typographic named entities malegislature.gov emits that the shared
 * decodeEntities() (named set is nbsp/amp/lt/gt/quot/#39 + numeric/hex) does not
 * cover — chiefly &mdash; in definition catchlines and dashes. Scoped to this
 * ingester so the shared corpus framework's behavior is untouched.
 */
function decodeTypographicEntities(s: string): string {
  return s
    .replace(/&mdash;/gi, '—')
    .replace(/&ndash;/gi, '–')
    .replace(/&hellip;/gi, '…')
    .replace(/&rsquo;/gi, '’')
    .replace(/&lsquo;/gi, '‘')
    .replace(/&rdquo;/gi, '”')
    .replace(/&ldquo;/gi, '“')
    .replace(/&sect;/gi, '§')
}

/** Each real-estate category block: a TOC page + a section-href filter. */
interface Block {
  category: string // law_category bucket
  /**
   * act_key. Defaults to `category`. Override ONLY when a single law_category
   * bucket spans multiple distinct statutory acts whose section numbers collide
   * on the unique key (state_code, act_key, section_number, effective_year).
   * Matches the established corpus convention (cf. IL mortgage_lien_foreclosure,
   * which splits into mechanics_lien / mortgage / reverse_mortgage / … act_keys).
   * MA's mortgage_lien_foreclosure spans Ch.244 (foreclosure) and Ch.254
   * (mechanic's liens), both with plain-integer §§ 1,2,3… — without distinct
   * act_keys the Ch.254 rows silently lose to ON CONFLICT.
   */
  actKey?: string
  toc: string
  /**
   * Keep predicate evaluated against the FULL section href. For whole-chapter
   * blocks this is a simple `/ChapterNNN/Section` substring match (so we never
   * pick up cross-references to other chapters that may appear on the TOC).
   * For sub-runs of an omnibus chapter (broker_licensing) it range-filters on
   * the alpha suffix.
   */
  keep: (href: string) => boolean
}

/** Whole-chapter keep: href must belong to exactly this chapter segment. */
function wholeChapter(chapterSeg: string): (href: string) => boolean {
  const re = new RegExp(`/${chapterSeg}/Section[0-9A-Za-z~]+$`)
  return (href) => re.test(href)
}

async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'User-Agent': UA } })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  return res.text()
}

/**
 * Ordinal for a "87"-style alpha suffix so we can range-filter a sub-run out of
 * the omnibus professions chapter. Suffix examples: "87PP", "87AAA", "87XX1~2",
 * "87AAA3~4". We strip the leading numeric stem ("87"), then decode:
 *   tier        = count of the repeated letter (P=1, PP=2, AAA=3, CCCC=4)
 *   letterValue = A=1 .. Z=26 (all repeated letters are identical in MA's scheme)
 *   fraction    = N/M from a trailing "N~M" (½, ¾, ...), else 0
 * Sort key = tier*1000 + letterValue + fraction. Returns null if unparseable.
 */
function suffixOrdinal(label: string): number | null {
  const m = label.match(/^87([A-Z]+)(?:(\d+)~(\d+))?$/i)
  if (!m) return null
  const letters = m[1].toUpperCase()
  // all letters in a real MA repeated-suffix are the same char; guard anyway
  if (!/^(.)\1*$/.test(letters)) return null
  const tier = letters.length
  const letterValue = letters.charCodeAt(0) - 64 // A=1
  const fraction = m[2] && m[3] ? Number(m[2]) / Number(m[3]) : 0
  return tier * 1000 + letterValue + fraction
}

const RE_LO = suffixOrdinal('87PP')! // lower bound: § 87PP
const RE_HI = suffixOrdinal('87DDD1~2')! // upper bound: § 87DDD½

const BLOCKS: Block[] = [
  {
    // Real-estate broker/salesman licensing — sub-run §§ 87PP..87DDD½ of the
    // omnibus professions chapter 112. Suffix-range filtered.
    category: 'broker_licensing',
    toc: `${BASE}/Laws/GeneralLaws/PartI/TitleXVI/Chapter112`,
    keep: (href) => {
      const sfx = suffixFromHref(href)
      if (sfx === null) return false
      const o = suffixOrdinal(sfx)
      return o !== null && o >= RE_LO && o <= RE_HI
    },
  },
  {
    // Round-2: deeds, conveyances, recording of instruments, title. Whole
    // chapter 183 (Alienation of Land). Per the MA category map this also
    // carries the mortgage-substance sections §§ 18-67 (statutory mortgage
    // condition, power of sale, foreclosure-by-sale notice) — those count
    // here under conveyancing_title and are NOT re-inserted under
    // mortgage_lien_foreclosure to avoid double-counting.
    category: 'conveyancing_title',
    toc: `${BASE}/Laws/GeneralLaws/PartII/TitleI/Chapter183`,
    keep: wholeChapter('Chapter183'),
  },
  {
    // Round-2: Massachusetts Condominium Act. Whole chapter 183A. MA has NO
    // separate cooperative/common-interest-community real-property statute
    // (co-ops are corporate-form under Ch. 157B), so 183A is the canonical
    // condo_coop source.
    category: 'condo_coop',
    toc: `${BASE}/Laws/GeneralLaws/PartII/TitleI/Chapter183A`,
    keep: wholeChapter('Chapter183A'),
  },
  {
    // Round-2: mortgage_lien_foreclosure spans two whole chapters —
    //   Ch. 244 (Foreclosure and Redemption of Mortgages — procedure), and
    //   Ch. 254 (Liens on Buildings and Land — mechanic's/construction liens).
    // Mortgage SUBSTANCE (§§ 183:18-67) is counted under conveyancing_title.
    category: 'mortgage_lien_foreclosure',
    actKey: 'ch244_foreclosure',
    toc: `${BASE}/Laws/GeneralLaws/PartIII/TitleIII/Chapter244`,
    keep: wholeChapter('Chapter244'),
  },
  {
    category: 'mortgage_lien_foreclosure',
    actKey: 'ch254_liens',
    toc: `${BASE}/Laws/GeneralLaws/PartIII/TitleIV/Chapter254`,
    keep: wholeChapter('Chapter254'),
  },
  {
    // Round-2: catch-all real-property chapter — estates in land, entry and
    // possession, use-restrictions, right-of-first-refusal, transfer fees.
    // Whole chapter 184. (General adverse possession is MA common law; the
    // closest codified provisions are limitation periods in Ch. 260 and the
    // registered-land bar in Ch. 185 §53 — not requested here.)
    category: 'general_real_property',
    toc: `${BASE}/Laws/GeneralLaws/PartII/TitleI/Chapter184`,
    keep: wholeChapter('Chapter184'),
  },
]

/**
 * Parse one malegislature.gov section page. The catchline lives in
 *   <h2 id="skipTo" ...>Section NUM: <small>TITLE</small></h2>
 * and the body <p> blocks follow, ending at </main>. Drops repealed/reserved.
 */
function parseSectionPage(html: string): Parsed | null {
  const h2 = html.match(/<h2[^>]*id="skipTo"[^>]*>\s*Section\s+([0-9A-Za-z\/]+)\s*:\s*<small>([\s\S]*?)<\/small>/i)
  if (!h2) return null
  const number = h2[1].trim()
  const title = decodeTypographicEntities(stripTags(h2[2], false)) || null
  if (title && /^repealed/i.test(title)) return null
  if (title && /^\[?reserved\.?\]?$/i.test(title)) return null
  const after = html.slice(h2.index! + h2[0].length)
  const end = after.indexOf('</main>')
  const region = end >= 0 ? after.slice(0, end) : after
  const text = decodeTypographicEntities(stripTags(region, true))
  if (!text || text.length < 20) return null
  if (/^\s*Repealed/i.test(text) || /^\[?reserved\.?\]?$/i.test(text)) return null
  return { number, title, text }
}

/** Pull the section href suffix (e.g. "87RR", "87DDD1~2") from a TOC href. */
function suffixFromHref(href: string): string | null {
  const m = href.match(/\/Section([0-9A-Za-z~]+)$/)
  return m ? m[1] : null
}

async function ingestBlock(block: Block): Promise<{ ok: number; skipped: number }> {
  const actKey = block.actKey ?? block.category
  const tocHtml = await fetchHtml(block.toc)
  // All distinct section hrefs in this chapter's TOC.
  const allHrefs = [...new Set(
    [...tocHtml.matchAll(/href="(\/Laws\/GeneralLaws\/[^"]+\/Section[0-9A-Za-z~]+)"/gi)].map((m) => m[1])
  )]
  // Keep only those this block wants (whole-chapter or suffix-range filter).
  const hrefs = allHrefs.filter((h) => block.keep(h))
  console.log(`[${block.category}] ${allHrefs.length} TOC links → ${hrefs.length} in range`)

  let ok = 0
  let skipped = 0
  const CONC = 4
  for (let i = 0; i < hrefs.length; i += CONC) {
    const batch = hrefs.slice(i, i + CONC)
    const parsed = await Promise.all(
      batch.map(async (h) => {
        try {
          return { p: parseSectionPage(await fetchHtml(BASE + h)), href: h }
        } catch (e: any) {
          console.warn(`  ! ${h}: ${e?.message || e}`)
          return { p: null as Parsed | null, href: h }
        }
      })
    )
    for (const { p, href } of parsed) {
      if (!p || !p.number || !p.text || p.text.length < 20) { skipped++; continue }
      await query(
        `INSERT INTO state_law_section_texts
           (state_code, act_key, section_number, section_title, full_text, source_url, source_date, effective_year, law_category)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (state_code, act_key, section_number, effective_year) DO NOTHING`,
        [STATE, actKey, p.number, p.title, p.text, BASE + href, SOURCE_DATE, EFFECTIVE_YEAR, block.category]
      )
      ok++
    }
    process.stdout.write(`\r  [${block.category}] ${Math.min(i + CONC, hrefs.length)}/${hrefs.length}`)
  }
  console.log(`\n  [${block.category}] inserted ${ok}, skipped ${skipped}`)
  return { ok, skipped }
}

async function main() {
  console.log(`\n=== MA — ingesting real-estate statute corpus (as of ${SOURCE_DATE}) ===`)
  const counts: Record<string, number> = {}
  for (const block of BLOCKS) {
    const { ok } = await ingestBlock(block)
    counts[block.category] = (counts[block.category] || 0) + ok
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  console.log(`\nMA real-estate done. inserted=${total}`, counts)
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })

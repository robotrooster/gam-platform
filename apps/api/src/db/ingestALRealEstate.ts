/**
 * Alabama (AL) non-tax real-estate statute full-text ingester.
 *
 * Sanctioned retrieve+cite+date carve-out (verbatim official statute text, never
 * advice). Source is the Alabama Legislature's OFFICIAL code server:
 *   https://alison.legislature.state.al.us  (Code of Alabama 1975)
 * No Justia / Lexis / Wayback — primary state source only.
 *
 * FETCH MECHANICS — official GraphQL API
 *   Endpoint:  POST https://alison.legislature.state.al.us/graphql
 *   Headers:   Content-Type: application/json
 *              Origin: https://alison.legislature.state.al.us   (REQUIRED — the
 *                server rejects operations without it even though introspection
 *                is disabled).
 *
 *   ENUMERATION (one call):
 *     query { codeOfAlabamaTitles }
 *   Returns the WHOLE code tree as ONE delimited string. Records split on the
 *   U+222B '∫' char; fields within a record split on U+2020 '†'. Three record
 *   shapes appear:
 *       Title  : [codeId, "Title N ..."]                       (NF=2)
 *       Chapter: [codeId, "Chapter N ...", "§a to §b"]         (NF=3)
 *       Section: [codeId, "Section <displayId> <Catchline>."]  (NF=2)
 *   A Section record's label is "Section " + displayId + " " + catchline; the
 *   displayId is the first whitespace-delimited token after "Section ". We keep
 *   Section records whose displayId begins with a target chapter prefix.
 *
 *   PER-SECTION TEXT:
 *     query { codesOfAlabama(where:{type:{eq:Section},displayId:{eq:"35-4-20"}},
 *             versions:true){ data { codeId displayId title content history } } }
 *   `content` is HTML (<p>…</p>); `title` embeds the displayId
 *   ("Section 35-4-20 <Catchline>"); `history` holds source-act citations with
 *   HTML entities (&sect; etc.). Each displayId returns exactly one record (the
 *   tree already lists future-effective versions as distinct displayIds; verified
 *   0 duplicate displayIds across the target ranges).
 *
 *   PARSE: section_number = displayId. section_title = `title` with the leading
 *   "Section <displayId>" stripped (keeps any "[Effective until …]" annotation
 *   the state itself carries in the catchline). full_text = stripTags(content) —
 *   verbatim plain text, entities decoded, <p>/<br> -> newlines.
 *
 *   DROP: repealed / renumbered / reserved / transferred catchlines; empty or
 *   <20-char bodies (the state emits title-only stubs for removed sections); any
 *   body that is itself just "[Repealed.]"-style boilerplate.
 *
 * CATEGORY -> CHAPTER MAP (act_key == law_category for every block, per spec):
 *   conveyancing_title         35-4  (Conveyances & Creation of Estates)
 *                              35-4A (Uniform Statutory Rule Against Perpetuities)
 *   condo_coop                 35-8  (Condominium Ownership — pre-1991)
 *                              35-8A (Alabama Uniform Condominium Act of 1991)
 *                              35-8B (Community Development Districts)
 *                              35-20 (Alabama Homeowners' Association Act)
 *                              [AL has NO separate housing-cooperative act;
 *                               common-interest law lives in these chapters.]
 *   broker_licensing           34-27  (Real Estate Brokers — License Law of 1951)
 *                              34-27A (Real Estate Appraisers)
 *   mortgage_lien_foreclosure  35-10  (Mortgages — power-of-sale foreclosure)
 *                              35-10A (Asset-Backed Securities Facilitation Act)
 *                              35-11  (Liens — incl. mechanic's/materialman's at
 *                                      35-11-210 et seq.)
 *                              6-5-247..6-5-257 (post-foreclosure statutory
 *                                      right of redemption — Title 6, not 35)
 *   general_real_property      35-1  (General Provisions / alien ownership)
 *                              35-2  (Surveys)
 *                              35-3  (Boundaries)
 *                              35-6  (Partition) + 35-6A (Uniform Partition of
 *                                      Heirs Property Act)
 *                              35-7  (Partition Fences)
 *                              35-9B (Squatting)
 *                              35-12 (Lost / Unclaimed Property)
 *                              35-13/14/15/18/19 (misc residual Title 35)
 *                              6-5-200..6-5-228 (adverse possession & related
 *                                      real-property doctrines — Title 6)
 *      NOTE — exclusions: 35-9 (Landlord & Tenant) and 35-9A (URLTA) and
 *      35-12A (Manufactured Home Parks) are deliberately NOT pulled here. They
 *      are already ingested under law_category='landlord_tenant'. The spec rule
 *      for general_real_property is "residual Title 35 chapters NOT claimed by
 *      the other categories"; those three ARE claimed (by landlord_tenant), so
 *      re-ingesting them under a second category would duplicate the same body
 *      of law. Single-source discipline wins.
 *
 * Run: cd apps/api && node -r ts-node/register src/db/ingestALRealEstate.ts
 * Idempotent (ON CONFLICT DO NOTHING).
 */

import { query } from './index'
import { stripTags } from './ingestStateLawCorpus'

const STATE = 'AL'
const SOURCE_DATE = '2026-06-14'
const EFFECTIVE_YEAR = 2026
const GRAPHQL = 'https://alison.legislature.state.al.us/graphql'
const ORIGIN = 'https://alison.legislature.state.al.us'
const SOURCE_URL = 'https://alison.legislature.state.al.us/code-of-alabama'
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'

const REC_SEP = '∫' // ∫
const FLD_SEP = '†' // †

interface SectionMeta {
  displayId: string
  label: string
}

/** Low-level GraphQL POST with the required Origin header + browser UA. */
async function gql<T>(queryStr: string): Promise<T> {
  const res = await fetch(GRAPHQL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: ORIGIN,
      'User-Agent': UA,
    },
    body: JSON.stringify({ query: queryStr }),
  })
  if (!res.ok) throw new Error(`GraphQL HTTP ${res.status} ${res.statusText}`)
  const json: any = await res.json()
  if (json.errors) throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`)
  return json.data as T
}

/**
 * Fetch the whole-code tree once and return every Section record (displayId +
 * full label). Title/Chapter records are dropped here; chapter filtering happens
 * in the caller.
 */
async function fetchSectionIndex(): Promise<SectionMeta[]> {
  const data = await gql<{ codeOfAlabamaTitles: string }>(`query{ codeOfAlabamaTitles }`)
  const tree = data.codeOfAlabamaTitles
  const out: SectionMeta[] = []
  for (const rec of tree.split(REC_SEP)) {
    const fields = rec.split(FLD_SEP)
    if (fields.length !== 2) continue
    const label = fields[1]
    if (!label.startsWith('Section ')) continue
    const m = label.match(/^Section\s+(\S+)\s/)
    if (!m) continue
    out.push({ displayId: m[1], label })
  }
  return out
}

interface Parsed {
  number: string
  title: string | null
  text: string
}

/** Fetch one section's verbatim text by displayId. Returns null if dropped. */
async function fetchSection(displayId: string): Promise<Parsed | null> {
  const q = `query{ codesOfAlabama(where:{type:{eq:Section},displayId:{eq:"${displayId}"}},versions:true){ data { displayId title content history } } }`
  const data = await gql<{ codesOfAlabama: { data: Array<{ displayId: string; title: string | null; content: string | null; history: string | null }> } }>(q)
  const arr = data.codesOfAlabama?.data ?? []
  if (arr.length === 0) return null
  const rec = arr[0]

  // Title: strip the embedded "Section <displayId>" citation prefix; keep the
  // rest verbatim (incl. any "[Effective …]" annotation the state carries).
  let title: string | null = null
  if (rec.title) {
    title = rec.title
      .replace(new RegExp(`^Section\\s+${displayId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`, 'i'), '')
      .trim()
    if (!title) title = null
  }

  // Repealed / renumbered / reserved / transferred title-only stubs.
  if (title && /^\[?\s*(repealed|renumbered|reserved|transferred|omitted)\b/i.test(title)) return null

  const text = stripTags(rec.content ?? '', true)
  if (!text || text.length < 20) return null
  // Body-as-status-placeholder. The state keeps the ORIGINAL catchline as the
  // title (e.g. "Trusts May Be Created…") but replaces the body with a one-line
  // status notice ("Repealed by Act 2006-216…", "Transferred to Section 19-3B-…",
  // "Renumbered as §11-51-132…", "Amended and renumbered as…"). That notice is
  // not statute text — drop it. We anchor on the body STARTING with the status
  // verb (the §-cite that follows is short) rather than requiring an exact match.
  if (/^\[?\s*(repealed|renumbered|reserved|transferred|omitted|moved)\b/i.test(text)) return null
  if (/^\[?\s*amended and renumbered\b/i.test(text)) return null

  return { number: displayId, title, text }
}

/** Insert one parsed section under act_key == law_category == category. */
async function insertSection(category: string, s: Parsed): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `INSERT INTO state_law_section_texts
       (state_code, act_key, section_number, section_title, full_text, source_url, source_date, effective_year, law_category)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (state_code, act_key, section_number, effective_year) DO NOTHING
     RETURNING id`,
    [STATE, category, s.number, s.title, s.text, SOURCE_URL, SOURCE_DATE, EFFECTIVE_YEAR, category]
  )
  return rows.length > 0
}

/**
 * Predicate factory: does a displayId belong to this category? Matchers are
 * chapter-prefix strings (e.g. "35-4-") plus explicit Title-6 displayId lists.
 */
interface CategorySpec {
  /** Title-35/34 chapter prefixes, e.g. "35-4-". Disjoint between categories. */
  prefixes: string[]
  /** Explicit Title-6 displayIds (adverse possession / redemption). */
  explicit?: string[]
}

const PLAN: Record<string, CategorySpec> = {
  conveyancing_title: {
    prefixes: ['35-4-', '35-4A-'],
  },
  condo_coop: {
    prefixes: ['35-8-', '35-8A-', '35-8B-', '35-20-'],
  },
  broker_licensing: {
    prefixes: ['34-27-', '34-27A-'],
  },
  mortgage_lien_foreclosure: {
    prefixes: ['35-10-', '35-10A-', '35-11-'],
    // Statutory right of redemption after foreclosure sale — Title 6, Ch 5,
    // Art 9 (6-5-247 .. 6-5-257). Enumerated explicitly so we don't pull the
    // unrelated 6-5-2xx trespass/limitations sections.
    explicit: [
      '6-5-247', '6-5-248', '6-5-249', '6-5-250', '6-5-251', '6-5-252',
      '6-5-253', '6-5-254', '6-5-255', '6-5-256', '6-5-257',
    ],
  },
  general_real_property: {
    // Residual Title 35 chapters NOT claimed by the four categories above and
    // NOT already ingested under landlord_tenant (35-9, 35-9A, 35-12A excluded).
    prefixes: [
      '35-1-', '35-2-', '35-3-', '35-6-', '35-6A-', '35-7-', '35-9B-',
      '35-12-', '35-13-', '35-14-', '35-15-', '35-18-', '35-19-',
    ],
    // Adverse possession & related real-property doctrines — Title 6, Ch 5,
    // Art 7 (6-5-200 .. 6-5-218) + Art 8 limitations (6-5-220 .. 6-5-228).
    explicit: [
      '6-5-200', '6-5-210', '6-5-211', '6-5-212', '6-5-213', '6-5-214',
      '6-5-215', '6-5-216', '6-5-217', '6-5-218', '6-5-220', '6-5-221',
      '6-5-222', '6-5-223', '6-5-224', '6-5-225', '6-5-226', '6-5-227',
      '6-5-228',
    ],
  },
}

/**
 * Guard: 35-12 prefix must NOT swallow 35-12A (Manufactured Home Parks, owned
 * by landlord_tenant). "35-12A-1".startsWith("35-12-") is false (char after
 * "35-12" is "A", not "-"), so the prefix match is already safe. This helper
 * documents/enforces that invariant for any displayId.
 */
function prefixMatches(displayId: string, prefixes: string[]): boolean {
  return prefixes.some((p) => displayId.startsWith(p))
}

async function main() {
  console.log(`\n=== AL — round-2 ingest of non-tax real-estate statute corpus (as of ${SOURCE_DATE}) ===`)
  console.log('Fetching code tree (codeOfAlabamaTitles)…')
  const index = await fetchSectionIndex()
  console.log(`  index: ${index.length} total Section records in the Code of Alabama`)

  // Assign each indexed section to at most one category (prefixes are disjoint;
  // Title-6 explicit lists are disjoint too). Build per-category displayId lists.
  const byCategory: Record<string, string[]> = {}
  for (const cat of Object.keys(PLAN)) byCategory[cat] = []

  const explicitOwner: Record<string, string> = {}
  for (const [cat, spec] of Object.entries(PLAN)) {
    for (const did of spec.explicit ?? []) explicitOwner[did] = cat
  }

  for (const { displayId } of index) {
    // Title-35/34 prefix routing.
    let assigned = false
    for (const [cat, spec] of Object.entries(PLAN)) {
      if (prefixMatches(displayId, spec.prefixes)) {
        byCategory[cat].push(displayId)
        assigned = true
        break
      }
    }
    if (assigned) continue
    // Title-6 explicit routing.
    const owner = explicitOwner[displayId]
    if (owner) byCategory[owner].push(displayId)
  }

  // Sanity: confirm every explicit Title-6 displayId was actually found in the
  // index (so a typo/renumber surfaces instead of silently under-counting).
  for (const [cat, spec] of Object.entries(PLAN)) {
    for (const did of spec.explicit ?? []) {
      if (!byCategory[cat].includes(did)) {
        console.warn(`  WARN: explicit ${did} (${cat}) not present in code index`)
      }
    }
  }

  const counts: Record<string, { found: number; parsed: number; inserted: number; dropped: number }> = {}

  for (const [category, dids] of Object.entries(byCategory)) {
    console.log(`\n--- ${category}: ${dids.length} candidate sections ---`)
    let parsed = 0
    let inserted = 0
    let dropped = 0
    for (const did of dids) {
      let rec: Parsed | null = null
      // Light retry — the API occasionally rate-trims under burst.
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          rec = await fetchSection(did)
          break
        } catch (e) {
          if (attempt === 2) {
            console.warn(`    fetch failed ${did}: ${(e as Error).message}`)
          } else {
            await new Promise((r) => setTimeout(r, 600 * (attempt + 1)))
          }
        }
      }
      if (!rec) {
        dropped++
        continue
      }
      parsed++
      if (await insertSection(category, rec)) inserted++
      await new Promise((r) => setTimeout(r, 70)) // politeness between section fetches
    }
    counts[category] = { found: dids.length, parsed, inserted, dropped }
    console.log(`  [${category}] found ${dids.length}, parsed ${parsed}, inserted ${inserted}, dropped ${dropped}`)
  }

  console.log('\n=== AL done ===')
  for (const [cat, c] of Object.entries(counts)) {
    console.log(`  ${cat}: found=${c.found} parsed=${c.parsed} inserted=${c.inserted} dropped=${c.dropped}`)
  }
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

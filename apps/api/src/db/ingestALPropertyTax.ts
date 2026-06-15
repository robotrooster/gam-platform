/**
 * Alabama property-tax statute full-text ingester (S-series property_tax corpus).
 *
 * SOURCE (official): the Alabama Legislature's Code of Alabama 1975, served by a
 * Next.js SPA at https://alison.legislature.state.al.us/code-of-alabama . The
 * page itself is a TOC / navigation shell (title "Alabama Legislature", body is
 * link nav only) — the statutory PROSE is NOT in the HTML. It is served by the
 * site's public, unauthenticated GraphQL API at
 *   POST https://alison.legislature.state.al.us/graphql
 * A browser-like User-Agent avoids 000-level blocks. Introspection is disabled
 * but the two queries below were recovered from the JS bundles.
 *
 * INGEST RECIPE (two-step, per chapter):
 *   (1) Enumerate every section displayId in a chapter with a left-anchored
 *       prefix search:
 *         { displayIds: codeOfAlabamaDisplayIds(search: "40-9-") }
 *       The server filters EXACTLY on the prefix ("40-3-" does not leak "40-30-"),
 *       so a chapter prefix returns precisely that chapter's section ids
 *       (e.g. "40-9-1", "40-9-21.2").
 *   (2) For each displayId, fetch the verbatim body:
 *         codesOfAlabama(where:{ type:{eq:Section}, displayId:{eq:$id} }){
 *           data { displayId title catchLine content history effectiveDate }
 *         }
 *       - title    = "Section 40-9-1 Exemption..." (full heading)
 *       - catchLine = the heading text only (used as section_title)
 *       - content  = verbatim statute body as HTML (<p>...</p>, subsection
 *                    markers (1)/(a) inline)
 *       - history  = source-note citation string for dating, e.g.
 *                    "(Acts 1935, No. 194, p. 256; Code 1940, T. 51, §2; ...)"
 *
 * Title 40 ("Revenue and Taxation") chapters mapped to the five feature groups.
 * All land under ONE act_key + law_category = 'property_tax' (the property-tax
 * retrieve+cite+date carve-out). The feature-group → chapter map is documented
 * inline below for future maintainers; we do not store the group separately.
 *   exemptions             -> Ch. 9  (40-9-)   Exemptions From Taxation
 *   assessment             -> Ch. 7  (40-7-)   Assessment of Taxes Generally
 *                           + Ch. 8  (40-8-)   Rate of Taxation / classification
 *   assessment_review      -> Ch. 3  (40-3-)   Boards of Equalization / appeals
 *   levy_collection_payment-> Ch. 11 (40-11-)  When taxes due / delinquent
 *   delinquency_tax_sale   -> Ch. 10 (40-10-)  Sale of Land / liens / redemption
 *
 * Post-process: stripTags (the corpus helper — <p> → newline, entity decode,
 * whitespace collapse) on `content`; append the `history` note as the trailing
 * source-note line of full_text (the carve-out keeps source notes for dating).
 * Drop repealed / reserved / empty / <20-char bodies.
 *
 * NOTE: the legacy host alisondb.legislature.state.al.us/.../1975/40-9-1.htm is
 * now NXDOMAIN (decommissioned) — only the GraphQL API above is targeted.
 *
 * Run: cd apps/api && node -r ts-node/register src/db/ingestALPropertyTax.ts
 * Idempotent (ON CONFLICT DO NOTHING).
 */

import { execFileSync } from 'child_process'
import { query } from './index'
import { stripTags, decodeEntities } from './ingestStateLawCorpus'

const STATE = 'AL'
const ACT_KEY = 'property_tax'
const LAW_CATEGORY = 'property_tax'
const SOURCE_DATE = '2026-06-14'
const EFFECTIVE_YEAR = 2026
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) GAM-statute-ingest/1.0'
const GRAPHQL = 'https://alison.legislature.state.al.us/graphql'
const CODE_BASE = 'https://alison.legislature.state.al.us/code-of-alabama'
const sourceUrl = (id: string) => `${CODE_BASE}?section=${id}`

// Feature-group → Title-40 chapter prefixes. All ingested under one act_key.
const CHAPTERS: { group: string; prefix: string }[] = [
  { group: 'exemptions', prefix: '40-9-' },
  { group: 'assessment', prefix: '40-7-' },
  { group: 'assessment', prefix: '40-8-' },
  { group: 'assessment_review', prefix: '40-3-' },
  { group: 'levy_collection_payment', prefix: '40-11-' },
  { group: 'delinquency_tax_sale', prefix: '40-10-' },
]

interface Parsed {
  number: string
  title: string | null
  text: string
}

/** POST a GraphQL query, return parsed JSON. Throws on transport/GraphQL error. */
function gql(queryStr: string, variables?: Record<string, unknown>): any {
  const payload = JSON.stringify(variables ? { query: queryStr, variables } : { query: queryStr })
  const buf = execFileSync(
    'curl',
    [
      '-s',
      '--max-time',
      '60',
      '-A',
      UA,
      '-X',
      'POST',
      GRAPHQL,
      '-H',
      'Content-Type: application/json',
      '-d',
      payload,
    ],
    { maxBuffer: 256 * 1024 * 1024 }
  )
  const json = JSON.parse(buf.toString('utf-8'))
  if (json.errors) throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`)
  return json.data
}

/** Enumerate all section displayIds in a chapter (left-anchored prefix). */
function enumerateChapter(prefix: string): string[] {
  const data = gql(`{ displayIds: codeOfAlabamaDisplayIds(search: "${prefix}") }`)
  const ids: string[] = data?.displayIds || []
  // Defensive: keep only true prefix matches (server already does this).
  return ids.filter((id) => id.startsWith(prefix))
}

const SEC_QUERY = `query Sec($id:String){
  codesOfAlabama(where:{ type:{ eq:Section }, displayId:{ eq:$id } }){
    data { displayId title catchLine content history }
  }
}`

/**
 * Fetch + parse one section into {number, title, full_text}. The full_text is
 * the verbatim stripped `content` with the `history` source-note appended as a
 * trailing line (kept for the retrieve+cite+date dating anchor). Returns null
 * for repealed / reserved / empty / too-short / not-found bodies.
 */
function fetchSection(id: string): Parsed | null {
  const data = gql(SEC_QUERY, { id })
  const rows = data?.codesOfAlabama?.data || []
  if (rows.length === 0) return null
  const row = rows[0]

  const rawContent: string = row.content || ''
  let body = stripTags(rawContent, true)
  if (!body) return null

  // Title = catchLine (heading only), entity-decoded. Fall back to `title`.
  let title: string | null = row.catchLine
    ? decodeEntities(String(row.catchLine)).trim()
    : row.title
      ? decodeEntities(String(row.title)).trim()
      : null
  if (title === '') title = null

  // Drop repealed / reserved / transferred sections (no live prose).
  const headProbe = `${title || ''} ${body}`.trim()
  if (/^\s*(repealed|reserved|transferred|renumbered)\b/i.test(headProbe)) return null
  if (/^\[?\s*(repealed|reserved)\b/i.test(body)) return null
  if (body.length < 20) return null

  // Append the history source-note as the trailing dating anchor. AL history
  // notes carry the named entity &sect; (the § section sign) which the shared
  // decodeEntities (numeric-only for named) does not cover — decode it here.
  const history = row.history
    ? decodeEntities(String(row.history)).replace(/&sect;/gi, '§').trim()
    : ''
  const fullText = history ? `${body}\n\nHistory: ${history}` : body

  return { number: id, title, text: fullText }
}

async function main() {
  console.log(`\n=== AL property_tax — ingesting Title 40 corpus (as of ${SOURCE_DATE}) ===`)

  // 1) Enumerate every chapter, de-dup ids across the (group,prefix) list.
  const idToGroup = new Map<string, string>()
  for (const { group, prefix } of CHAPTERS) {
    const ids = enumerateChapter(prefix)
    console.log(`  [${group}] ${prefix} -> ${ids.length} section ids`)
    for (const id of ids) if (!idToGroup.has(id)) idToGroup.set(id, group)
  }
  const allIds = [...idToGroup.keys()]
  console.log(`  total distinct section ids: ${allIds.length}`)

  // 2) Fetch + parse + insert, with politeness pauses.
  let inserted = 0
  let skipped = 0
  let failed = 0
  const failedIds: string[] = []
  const CONC = 4

  for (let i = 0; i < allIds.length; i += CONC) {
    if (i > 0) await new Promise((r) => setTimeout(r, 250))
    const batch = allIds.slice(i, i + CONC)
    const results = batch.map((id) => {
      try {
        return { id, p: fetchSection(id) as Parsed | null, err: null as string | null }
      } catch (e: any) {
        return { id, p: null, err: e?.message || String(e) }
      }
    })
    for (const { id, p, err } of results) {
      if (err) {
        failed++
        failedIds.push(id)
        console.warn(`\n  ! fetch failed ${id}: ${err}`)
        continue
      }
      if (!p) {
        skipped++
        continue
      }
      const rows = await query(
        `INSERT INTO state_law_section_texts
           (state_code, act_key, section_number, section_title, full_text,
            source_url, source_date, effective_year, law_category)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (state_code, act_key, section_number, effective_year) DO NOTHING
         RETURNING id`,
        [
          STATE,
          ACT_KEY,
          p.number,
          p.title,
          p.text,
          sourceUrl(p.number),
          SOURCE_DATE,
          EFFECTIVE_YEAR,
          LAW_CATEGORY,
        ]
      )
      if (rows.length > 0) inserted++
    }
    process.stdout.write(`\r  fetched ${Math.min(i + CONC, allIds.length)}/${allIds.length}`)
  }

  console.log(
    `\n\nAL property_tax done. inserted=${inserted}, skipped(repealed/reserved/empty)=${skipped}, failed=${failed}`
  )
  if (failedIds.length) console.log(`  failed ids: ${failedIds.join(', ')}`)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

/**
 * 10/13 (Nic) — the voided documents already on file for his two companies,
 * erased.
 *
 *   "I don't want voided forms archived. I want them completely erased from
 *    existence ... If it never completed, it doesn't exist."
 *
 * Going forward the void button erases instead (lib/voidDocument.endDocument,
 * the test in lib/eraseUnfinishedDocument).
 * This clears what was voided before that, for Oak Park and Mountain View only
 * (his answer: "Clean up existing ones for Nic's companies only") — MH 15's
 * five forms among them (Arturo's packet: "lease ONLY — Nic never wanted the
 * package; the 5 forms were voided (to be erased)").
 *
 * WHAT IT ERASES: a VOIDED document of those two companies that nothing keeps
 * — the one test the void button uses (keptReasonSql): it never issued a
 * lease or billed anyone, no resident signed it, no sale or money change from
 * it started. Each goes with its boxes, signers and the rows hanging off it,
 * exactly as the button erases one.
 *
 * WHAT IT NEVER TOUCHES:
 *   - A voided document money touched — RV 09's lease, which Nic's signature
 *     issued and billed, stays on record as voided. Printed with the reason.
 *   - Any document not voided: still out for signature, or drafted and
 *     waiting. Nic said to erase what never completed, but one still in
 *     progress may yet complete — printed, and left (the question of drafts
 *     still waiting goes back to him).
 *   - Arturo's MH 15 lease (a2f30572…), whatever state it is in — on its own,
 *     or as part of another document's packet.
 *   - Completed documents (counted, not listed).
 *
 * DRY RUN BY DEFAULT — reads only (one READ ONLY transaction), so it can be
 * pointed at production: prints every unfinished document of the two
 * companies (company, title, status, and why it is erased or kept) and the
 * files only the erased ones use. --apply erases them in one transaction, then
 * removes those files from this machine's uploads folder (run it from
 * apps/api on the machine that serves the files; a file not found here is
 * reported and left).
 *   cd apps/api && npx ts-node -T src/scripts/oct13_erase_unfinished_documents.ts
 *   cd apps/api && npx ts-node -T src/scripts/oct13_erase_unfinished_documents.ts --apply
 */
import type { PoolClient } from 'pg'
import { getClient } from '../db'
import {
  planErase, eraseUnfinishedDocument, removeOrphanedDocumentFiles,
} from '../lib/eraseUnfinishedDocument'

type Q = (sql: string, params?: any[]) => Promise<{ rows: any[] }>

/** Nic's two companies — the only ones his answer covers. */
export const NIC_COMPANIES: Readonly<Record<string, string>> = {
  '8d59242e-c1e5-48a7-b768-420c57fb5fca': 'Oak Park',
  '96ec7df3-362d-4777-b54c-e9604313820f': 'Mountain View',
}

/** Arturo's MH 15 lease (waiting on Nic's signature on 10/13): never touched here. */
export const PROTECTED_DOCUMENTS: readonly string[] = ['a2f30572-2b70-459f-aee9-a5f4514e1ffa']

/** MH 15's five voided forms — the dry run says whether each is erased. */
export const MH15_VOIDED_FORMS: readonly string[] = [
  '2ef3f489-6504-4679-ac52-fb092d0bbaa7',
  '91ddc8f3-00e2-460d-b552-4cba037d5a72',
  '9bbaae51-1f33-4cd1-a7b4-e1cddac37859',
  '81f30f99-b7a8-4aa4-b505-b285a8e4b7fe',
  '9f4160e7-d403-49a3-957e-7647425942d2',
]

export type Verdict = 'erase' | 'kept' | 'in_progress' | 'protected'

export interface DocumentLine {
  id: string
  company: string
  title: string
  status: string
  unit: string | null
  verdict: Verdict
  /** Why it is erased, or why it stays. */
  why: string
  /** Erased along with it (a packet lease's other unfinished documents). */
  goesWith: string[]
  leaseId: string | null
  documentType: string
}

export interface CleanupPlan {
  lines: DocumentLine[]
  completed: number
  /** Files only the erased documents use. */
  files: string[]
}

export async function planCleanup(q: Q): Promise<CleanupPlan> {
  const ids = Object.keys(NIC_COMPANIES)
  const docs = (await q(
    `SELECT d.id, d.landlord_id, d.title, d.status, d.document_type, d.lease_id,
            -- The park's calendar day, not the server's.
            to_char(d.voided_at AT TIME ZONE COALESCE(pr.timezone, 'America/Phoenix'), 'YYYY-MM-DD') AS voided_on,
            d.void_reason, COALESCE(u.display_label, u.unit_number) AS unit,
            (SELECT COUNT(*)::int FROM lease_document_fields f WHERE f.document_id = d.id) AS boxes,
            (SELECT COUNT(*)::int FROM lease_document_signers s WHERE s.document_id = d.id) AS signers,
            (SELECT COUNT(*)::int FROM notifications n
              WHERE n.data->>'documentId' = d.id::text OR n.data->>'document_id' = d.id::text) AS bell
       FROM lease_documents d
       LEFT JOIN units u ON u.id = d.unit_id
       LEFT JOIN properties pr ON pr.id = u.property_id
      WHERE d.landlord_id = ANY($1::uuid[]) AND d.status <> 'completed'
      ORDER BY d.landlord_id, d.created_at, d.id`, [ids])).rows
  const completed = Number((await q(
    `SELECT COUNT(*)::int AS n FROM lease_documents WHERE landlord_id = ANY($1::uuid[]) AND status = 'completed'`,
    [ids])).rows[0].n)

  const lines: DocumentLine[] = []
  const covered = new Map<string, string>()   // erased with another document → that document's title
  const eraseIds: string[] = []
  const urls: string[] = []
  for (const d of docs) {
    const base = {
      id: d.id, company: NIC_COMPANIES[d.landlord_id] ?? d.landlord_id, title: d.title,
      status: d.status, unit: d.unit ?? null, goesWith: [] as string[], leaseId: d.lease_id ?? null,
      documentType: d.document_type,
    }
    if (PROTECTED_DOCUMENTS.includes(d.id)) {
      lines.push({ ...base, verdict: 'protected', why: 'Arturo\'s MH 15 lease — never touched by this cleanup.' })
      continue
    }
    if (d.status !== 'voided') {
      const p = await planErase(q, d.id)
      lines.push({ ...base, verdict: 'in_progress',
        why: `${d.status === 'pending' ? 'Still a draft'
               : d.status === 'execution_failed' ? 'Signed by everyone (only building the lease failed)'
               : 'Still out for signature'} — not touched.` +
             (p.erased ? '' : ` (Voided later, it would stay on record: ${p.words})`) })
      continue
    }
    // A protected document is never taken along with another either (a
    // packet's lease takes its packet's forms).
    const p = await planErase(q, d.id, { onlyVoided: true, protectedIds: PROTECTED_DOCUMENTS })
    if (!p.erased) {
      lines.push({ ...base, verdict: 'kept', why: `${p.words} It stays on record as voided.` })
      continue
    }
    const others = p.documents.filter(x => x.id !== d.id)
    for (const o of others) covered.set(o.id, d.title)
    lines.push({
      ...base, verdict: 'erase', goesWith: others.map(o => o.id),
      why: `Voided ${d.voided_on ?? '(no date)'}${d.void_reason ? ` ("${d.void_reason}")` : ''}; never issued a lease, ` +
           `billed nobody, no resident signed it. Goes with it: ${d.boxes} box${d.boxes === 1 ? '' : 'es'}, ` +
           `${d.signers} signer${d.signers === 1 ? '' : 's'}` +
           (d.bell ? `, ${d.bell} bell notification${d.bell === 1 ? '' : 's'} pointing at it` : '') +
           (others.length ? `, and ${others.length} other document${others.length === 1 ? '' : 's'} of its packet` : '') + '.',
    })
    for (const x of p.documents) if (!eraseIds.includes(x.id)) eraseIds.push(x.id)
    urls.push(...p.files)
  }
  // A packet's form erased with its lease is not erased twice.
  for (const l of lines) {
    if (l.verdict === 'erase' && covered.has(l.id)) l.why += ` (Erased with "${covered.get(l.id)}".)`
  }

  // Files only the erased documents use: nothing else — a template, a library
  // form, another document — names them.
  const files: string[] = []
  for (const url of [...new Set(urls)]) {
    const used = (await q(
      `SELECT 1 FROM lease_documents WHERE (base_pdf_url = $1 OR executed_pdf_url = $1) AND id <> ALL($2::uuid[])
       UNION ALL SELECT 1 FROM lease_templates WHERE base_pdf_url = $1
       UNION ALL SELECT 1 FROM disclosure_library_documents WHERE base_pdf_url = $1
       LIMIT 1`, [url, eraseIds])).rows[0]
    if (!used) files.push(url)
  }
  return { lines, completed, files }
}

/** Erase every document the plan erases, in the caller's transaction. Returns the ids erased. */
export async function applyCleanup(q: Q, plan: CleanupPlan): Promise<{ erased: string[]; files: string[]; refused: DocumentLine[] }> {
  const erased: string[] = []
  const files: string[] = []
  const refused: DocumentLine[] = []
  for (const l of plan.lines) {
    if (l.verdict !== 'erase' || erased.includes(l.id)) continue
    // The same test again, under the erase's own locks: anything that changed
    // since the plan was read keeps its document.
    const out = await eraseUnfinishedDocument(q, { id: l.id, lease_id: l.leaseId, document_type: l.documentType },
      { onlyVoided: true, protectedIds: PROTECTED_DOCUMENTS })
    if (!out.erased) { refused.push({ ...l, verdict: 'kept', why: `${out.words} It stays on record as voided.` }); continue }
    erased.push(...out.documents.map(d => d.id))
    files.push(...out.files)
  }
  return { erased, files, refused }
}

export function formatPlan(plan: CleanupPlan, heading: string): string {
  const out: string[] = [heading, '']
  const groups: Array<[Verdict, string]> = [
    ['erase', 'ERASED — voided, never completed, no money touched'],
    ['kept', 'KEPT — voided, but stays on record'],
    ['in_progress', 'NOT TOUCHED — still in progress'],
    ['protected', 'NOT TOUCHED — protected'],
  ]
  for (const [v, title] of groups) {
    const ls = plan.lines.filter(l => l.verdict === v)
    out.push(`${title}: ${ls.length}`)
    for (const l of ls) {
      out.push(`  ${l.company} | ${l.unit ? `Unit ${l.unit} | ` : ''}${l.title} | ${l.status} | ${l.id}`)
      out.push(`      ${l.why}`)
    }
    out.push('')
  }
  const erasing = new Set(plan.lines.filter(l => l.verdict === 'erase').flatMap(l => [l.id, ...l.goesWith]))
  const mh15 = MH15_VOIDED_FORMS.filter(id => erasing.has(id)).length
  out.push(`MH 15's five voided forms: ${mh15} of 5 erased.`)
  out.push(`Completed documents (kept, not listed): ${plan.completed}`)
  out.push(`Files only the erased documents use: ${plan.files.length ? plan.files.join(', ') : 'none (every one is a template\'s or the library\'s and stays)'}`)
  return out.join('\n')
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply')
  const c: PoolClient = await getClient()
  const q: Q = c.query.bind(c) as any
  let files: string[] = []
  try {
    if (!apply) {
      // Reads only: the database refuses any write in this transaction.
      await c.query('BEGIN TRANSACTION READ ONLY')
      console.log(formatPlan(await planCleanup(q), 'DRY RUN — nothing written (re-run with --apply to erase).'))
      await c.query('ROLLBACK')
      return
    }
    await c.query('BEGIN')
    const plan = await planCleanup(q)
    const done = await applyCleanup(q, plan)
    await c.query('COMMIT')
    // Said only once it is true: nothing is "erased" until the COMMIT is in.
    console.log(formatPlan(plan, `APPLY — committed: ${done.erased.length} document(s) erased.`))
    for (const r of done.refused) console.log(`  Kept after all (changed since the plan): ${r.title} — ${r.why}`)
    files = done.files
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    c.release()
  }
  // After the commit: files nothing names any more.
  if (files.length) {
    const c2 = await getClient()
    try {
      const r = await removeOrphanedDocumentFiles(c2.query.bind(c2) as any, files)
      console.log(`Files removed: ${r.removed.length ? r.removed.join(', ') : 'none here'}` +
        (r.left.length ? `; could not remove: ${r.left.join(', ')}` : ''))
    } finally { c2.release() }
  }
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
}

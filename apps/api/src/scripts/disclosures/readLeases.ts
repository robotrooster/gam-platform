/**
 * S652 — read every landlord document for the sleeves it fills.
 *   REPORT=1 ... prints what each PDF contains, writes nothing
 *   (no env)     re-reads every active template and replaces its auto coverings
 */
import { query } from '../../db'
import { readDocument, detectCoverings } from '../../services/sleeveDetection'
import { readStoredFile, uploadKeyFromStored } from '../../lib/storage'
const exec = { query: (sql: string, params: any[]) => query<any>(sql, params).then(r => ({ rows: r })) }
;(async () => {
  const ts = await query<any>(`SELECT id, name, base_pdf_url FROM lease_templates
     WHERE is_active AND library_document_id IS NULL AND base_pdf_url IS NOT NULL ORDER BY name`)
  for (const t of ts) {
    if (process.env.REPORT) {
      const key = uploadKeyFromStored('leases', t.base_pdf_url)
      const found = key ? await readDocument(await readStoredFile(key)) : []
      console.log(`\n== ${t.name}`)
      for (const x of found) console.log(`   · ${x.disclosureType.padEnd(26)} ${x.evidence.slice(0, 110)}`)
    } else {
      const r = await detectCoverings(exec, t.id)
      console.log(`${t.name}: ${r.covered.join(', ') || '(nothing)'}${r.error ? '  ERROR ' + r.error : ''}`)
    }
  }
  process.exit(0)
})()

/**
 * S652 — re-read every landlord document after the detector learns something
 * new, so what the sleeves show matches what the documents actually contain.
 *     npx ts-node src/scripts/disclosures/redetectAll.ts
 */
import { db, query } from '../../db'
import { detectCoverings } from '../../services/sleeveDetection'

async function main() {
  const ts = await query<{ id: string; name: string }>(
    `SELECT id, name FROM lease_templates WHERE is_active AND library_document_id IS NULL AND base_pdf_url IS NOT NULL ORDER BY name`)
  const q = { query: (sql: string, params: any[]) => db.query(sql, params) }
  for (const t of ts) {
    const r = await detectCoverings(q, t.id)
    console.log(`${t.name}: ${r.covered.join(', ') || '—'}${r.error ? `  (${r.error})` : ''}`)
  }
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })

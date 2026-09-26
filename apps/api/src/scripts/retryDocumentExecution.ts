/**
 * S652 — Finish a fully-signed document that was parked in execution_failed.
 * Runs the same build the last signature runs, then marks it completed. Only
 * for documents whose every signer has signed; anything else is refused.
 *     npx ts-node src/scripts/retryDocumentExecution.ts <document id>... [--apply]
 */
import path from 'path'
import fs from 'fs'
import { query, queryOne } from '../db'
import { buildLeaseFromDocument } from '../routes/esign'
import { stampPdf } from '../services/pdfStamp'
import { extractUploadFilename } from '../lib/uploadPaths'
const uploadDir = path.join(process.cwd(), 'uploads', 'leases')

/** The same stamp the last signature makes: every field and signature burned onto the template PDF. */
async function stampExecuted(id: string): Promise<string | null> {
  const doc = await queryOne<any>(`SELECT id, base_pdf_url FROM lease_documents WHERE id=$1`, [id])
  const source = doc?.base_pdf_url ? extractUploadFilename(doc.base_pdf_url) : null
  if (!source || !fs.existsSync(path.join(uploadDir, source))) return null
  const fields = await query<any>('SELECT * FROM lease_document_fields WHERE document_id=$1', [id])
  const signers = await query<any>('SELECT * FROM lease_document_signers WHERE document_id=$1', [id])
  const out = path.join(uploadDir, 'executed-' + id + '.pdf')
  await stampPdf(path.join(uploadDir, source), fields.map((f: any) => ({
    page: parseInt(f.page) || 1, x: parseFloat(f.x) || 0, y: parseFloat(f.y) || 0,
    width: parseFloat(f.width) || 100, height: parseFloat(f.height) || 30,
    field_type: f.field_type, value: f.value, font_css: f.font_css, checkbox_mark: f.checkbox_mark,
  })), signers.map((s: any) => ({ name: s.name, email: s.email, role: s.role, signed_at: s.signed_at })), out)
  const url = '/api/esign/files/executed-' + id + '.pdf'
  await query('UPDATE lease_documents SET executed_pdf_url=$1 WHERE id=$2', [url, id])
  return url
}
const APPLY = process.argv.includes('--apply')
const IDS = process.argv.slice(2).filter((a) => !a.startsWith('--'))
async function main() {
  for (const id of IDS) {
    const d = await queryOne<any>(`SELECT d.id, d.status, d.title, d.void_reason FROM lease_documents d WHERE d.id=$1`, [id])
    if (!d) { console.log(`${id}: not found`); continue }
    const unsigned = await query<any>(`SELECT role FROM lease_document_signers WHERE document_id=$1 AND status<>'signed'`, [id])
    console.log(`${d.title}\n   ${d.status} — ${d.void_reason ?? ''}${unsigned.length ? `  (still unsigned: ${unsigned.map((u: any) => u.role).join(', ')})` : ''}`)
    if (d.status !== 'execution_failed' || unsigned.length) { console.log('   skipped'); continue }
    if (!APPLY) { console.log('   (dry run)'); continue }
    try {
      const r = await buildLeaseFromDocument(id)
      await query(`UPDATE lease_documents SET status='completed', completed_at=NOW(), execution_failed_at=NULL, void_reason=NULL, updated_at=NOW() WHERE id=$1`, [id])
      const url = await stampExecuted(id).catch((e) => { console.log(`   (stamp failed: ${e.message})`); return null })
      console.log(`   ✓ completed (lease ${r.leaseId || '—'}${url ? ', signed PDF stamped' : ''})`)
    } catch (e: any) {
      console.log(`   ✗ still fails: ${e.message}`)
    }
  }
}
main().then(() => process.exit(0), (e) => { console.error(e.message ?? e); process.exit(1) })

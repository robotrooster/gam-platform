/**
 * S652 — Draft one packet document again from its template, in the same slot,
 * with the same signers, after a voided copy. Built for MH 30's lead-based
 * paint sales disclosure, which Jeff Bowman's (now removed) Decline button
 * voided after Blu and Kim had signed it.
 *     npx ts-node src/scripts/mattoon/load23_redraft_doc.ts --doc <voided document id> [--apply] [--email]
 * --email sends Blu (the first signer) his signing link for the new copy.
 */
import { query, queryOne, getClient } from '../../db'
import { createDocumentRecord, signingUrlFor } from '../../routes/esign'
import { emailSigningRequest } from '../../services/email'
const APPLY = process.argv.includes('--apply')
const EMAIL = process.argv.includes('--email')
const DOC = process.argv[process.argv.indexOf('--doc') + 1]
async function main() {
  if (!DOC || !process.argv.includes('--doc')) throw new Error('--doc <id> is required')
  const d = await queryOne<any>(`SELECT d.*, u.unit_number, p.name AS property_name FROM lease_documents d JOIN units u ON u.id=d.unit_id JOIN properties p ON p.id=u.property_id WHERE d.id=$1`, [DOC])
  if (!d) throw new Error('document not found')
  if (d.status !== 'voided') throw new Error(`document is ${d.status}, not voided`)
  const live = await queryOne<any>(
    `SELECT id FROM lease_documents WHERE package_group_id=$1 AND package_sort_order=$2 AND status NOT IN ('voided') AND id<>$3`,
    [d.package_group_id, d.package_sort_order, d.id])
  if (live) throw new Error(`slot ${d.package_sort_order} of this packet already has a live document ${live.id}`)
  const tmpl = await queryOne<any>(`SELECT id, name, base_pdf_url, version FROM lease_templates WHERE id=$1`, [d.template_id])
  if (!tmpl?.base_pdf_url) throw new Error('template has no PDF')
  const signers = await query<any>(`SELECT user_id, role, name, email, phone, order_index FROM lease_document_signers WHERE document_id=$1 ORDER BY order_index`, [d.id])
  console.log(`${d.property_name} ${d.unit_number}: "${d.title}" slot ${d.package_sort_order}, template "${tmpl.name}" v${tmpl.version}`)
  for (const s of signers) console.log(`   signer ${s.order_index}: ${s.role} ${s.name} <${s.email}>`)
  const c = await getClient()
  let doc: any
  try {
    await c.query('BEGIN')
    doc = await createDocumentRecord(c, {
      landlordId: d.landlord_id, templateId: tmpl.id, unitId: d.unit_id, leaseId: d.lease_id ?? null,
      title: d.title, basePdfUrl: tmpl.base_pdf_url, documentType: d.document_type,
      targetLeaseTenantId: null, promoteLeaseTenantId: null,
      signers: signers.map((s: any) => ({ userId: s.user_id, role: s.role, name: s.name, email: s.email, phone: s.phone, orderIndex: s.order_index })),
      packageGroupId: d.package_group_id, packageId: d.package_id, packageSortOrder: d.package_sort_order,
      templateVersion: Number(tmpl.version) || 1,
    } as any)
    await c.query(`UPDATE lease_documents SET status='sent', sent_at=NOW(), updated_at=NOW() WHERE id=$1`, [doc.id])
    await c.query(`UPDATE lease_document_signers SET status='sent', invite_sent=TRUE, invite_sent_at=NOW() WHERE document_id=$1 AND role='landlord'`, [doc.id])
    await c.query(APPLY ? 'COMMIT' : 'ROLLBACK')
    console.log(`   ↻ drafted ${doc.id} — ${APPLY ? 'APPLIED' : '(dry run — nothing written)'}`)
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e } finally { c.release() }
  if (APPLY && EMAIL) {
    const landlord = signers.find((s: any) => s.role === 'landlord')
    const signer = await queryOne<any>(`SELECT * FROM lease_document_signers WHERE document_id=$1 AND user_id=$2`, [doc.id, landlord.user_id])
    await emailSigningRequest(landlord.email, landlord.name, `${d.title} (drafted again — needs your signature)`,
      `${d.property_name} ${d.unit_number}`, landlord.name, signingUrlFor(signer, doc.id, signer), { landlordId: d.landlord_id, documentId: doc.id })
    console.log(`   emailed ${landlord.email}`)
  }
}
main().then(() => process.exit(0), (e) => { console.error(e.message ?? e); process.exit(1) })

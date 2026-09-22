/**
 * S652 — Every document Blu has NOT signed, re-drafted from today's templates.
 *
 * Nic: "he does not want to re-sign the parts that he already did, so just
 * update anything that he hasn't already signed — re-upload the other
 * documents to his package with current templates, even, just so we don't
 * accidentally miss something."
 *
 * A document is a copy of its template taken at draft time, so a document
 * Blu has not signed is voided and drafted again — same packet, same place in
 * it, same signers — from the template as it stands now. The lease and
 * anything he signed stay exactly as they are. The sheet's installment
 * numbers prefill the contract's boxes; what he types and signs is the record.
 * Tenants who were emailed before but never opened anything are set back to
 * "not yet invited", so the packet invites them once when Blu finishes it.
 *     npx ts-node src/scripts/mattoon/load21_refresh_unsigned.ts [--apply]
 *     then: NODE_ENV=production npx ts-node src/scripts/mattoon/load18_blu_continuation.ts --apply
 */
import { query, queryOne, getClient } from '../../db'
import { createDocumentRecord } from '../../routes/esign'
import { voidDocument } from '../../lib/voidDocument'
import fs from 'fs'

const APPLY = process.argv.includes('--apply')
// --purpose installment_sale : only documents drafted from templates of that
// purpose (Blu re-saved the installment contract's fields on the 22nd; the
// other templates did not change, and re-drafting them would only cost him
// the pages he has already worked through).
const PURPOSE = (() => { const i = process.argv.indexOf('--purpose'); return i > 0 ? process.argv[i + 1] : null })()
const PROPERTY = 'e9743bfa-1972-4e40-8a1b-ad76a52a17b9'
const TERMS: Record<string, { monthly: number; payments: number }> = {
  '18': { monthly: 100, payments: 60 },
  '21': { monthly: 200, payments: 60 },
}

async function main() {
  const sheet: any[] = JSON.parse(fs.readFileSync(__dirname + '/lots.json', 'utf8'))
  const units = await query<any>(
    `SELECT u.id, u.unit_number FROM units u WHERE u.property_id=$1 AND u.retired_at IS NULL
        AND EXISTS (SELECT 1 FROM lease_documents d WHERE d.unit_id=u.id AND d.status NOT IN ('voided'))
      ORDER BY NULLIF(regexp_replace(u.unit_number,'\\D','','g'),'')::int`, [PROPERTY])
  let voided = 0, drafted = 0
  for (const unit of units) {
    const lot = String(Number(unit.unit_number.replace(/\D/g, '')))
    const row = sheet.find((r) => String(r.lot) === lot)
    const t = TERMS[lot] ?? (row?.rto === 'x' && Number(row.rto_pay) > 0 && Number(String(row.months_left ?? '').replace(/\D/g, '')) > 0
      ? { monthly: Number(row.rto_pay), payments: Number(String(row.months_left).replace(/\D/g, '')) } : null)
    const docs = await query<any>(
      `SELECT d.*, (SELECT status FROM lease_document_signers s WHERE s.document_id=d.id AND s.role='landlord') AS blu,
              (SELECT purpose FROM lease_templates t WHERE t.id=d.template_id) AS purpose
         FROM lease_documents d WHERE d.unit_id=$1 AND d.status NOT IN ('voided','completed') ORDER BY d.package_sort_order`, [unit.id])
    const stale = docs.filter((d: any) => d.blu !== 'signed' && (!PURPOSE || d.purpose === PURPOSE))
    console.log(`${unit.unit_number}: ${docs.length} documents, Blu signed ${docs.length - stale.length}, re-drafting ${stale.length}${t ? ` (contract $${t.monthly} × ${t.payments})` : ''}`)
    if (!stale.length) continue

    const c = await getClient()
    try {
      await c.query('BEGIN')
      const q = (s: string, v?: any[]) => c.query(s, v)
      for (const d of stale) {
        const signers = (await q(`SELECT user_id, role, name, email, phone, order_index FROM lease_document_signers WHERE document_id=$1 ORDER BY order_index`, [d.id])).rows
        const tmpl = (await q(`SELECT id, name, base_pdf_url, purpose, version FROM lease_templates WHERE id=$1`, [d.template_id])).rows[0]
        if (!tmpl?.base_pdf_url) throw new Error(`${unit.unit_number}: template for "${d.title}" has no PDF`)
        await voidDocument(q as any, d, 'Re-drafted from the updated template (S652)')
        voided++
        const isSale = tmpl.purpose === 'installment_sale'
        const prefill = isSale && t ? {
          sale_price: (t.monthly * t.payments).toFixed(2), sale_down_payment: '0.00',
          sale_monthly_payment: t.monthly.toFixed(2), sale_term_months: String(t.payments),
          sale_interest_rate: '0', sale_first_payment_month: '10/1/2026',
        } : {}
        const doc = await createDocumentRecord(c, {
          landlordId: d.landlord_id, templateId: tmpl.id, unitId: unit.id, leaseId: d.lease_id ?? null,
          title: d.title, basePdfUrl: tmpl.base_pdf_url, documentType: d.document_type,
          targetLeaseTenantId: null, promoteLeaseTenantId: null,
          signers: signers.map((s: any) => ({ userId: s.user_id, role: s.role, name: s.name, email: s.email, phone: s.phone, orderIndex: s.order_index })),
          prefillValues: prefill,
          packageGroupId: d.package_group_id, packageId: d.package_id, packageSortOrder: d.package_sort_order,
          templateVersion: Number(tmpl.version) || 1,
        } as any)
        await q(`UPDATE lease_documents SET status='sent', sent_at=NOW(), updated_at=NOW() WHERE id=$1`, [doc.id])
        await q(`UPDATE lease_document_signers SET status='sent', invite_sent=TRUE, invite_sent_at=NOW() WHERE document_id=$1 AND role='landlord'`, [doc.id])
        drafted++
        console.log(`   ↻ ${d.title}`)
      }
      // A tenant who was emailed about the old copies but never opened anything
      // is not invited yet: the packet invites them once when Blu finishes it.
      const reset = await q(
        `UPDATE lease_document_signers s SET status='pending', invite_sent=FALSE, invite_sent_at=NULL
          FROM lease_documents d WHERE d.id=s.document_id AND d.unit_id=$1 AND d.status NOT IN ('voided','completed')
            AND s.role <> 'landlord' AND s.status='sent' AND s.viewed_at IS NULL AND s.signed_at IS NULL RETURNING s.name`, [unit.id])
      if (reset.rowCount) console.log(`   tenant invite reset: ${reset.rows.map((r: any) => r.name).join(', ')}`)
      await c.query(APPLY ? 'COMMIT' : 'ROLLBACK')
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e } finally { c.release() }
  }
  console.log(`\n${voided} voided, ${drafted} drafted fresh — ${APPLY ? 'APPLIED' : '(dry run — nothing written)'}`)
}
main().then(() => process.exit(0), e => { console.error(e.message ?? e); process.exit(1) })

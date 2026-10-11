/**
 * S652 — Re-draft ONE installment contract with the sheet's remaining terms.
 *
 * Nic: Troy Street (MH 22) "has wrong payoff dates for the installment contract
 * … if he signed it the way it reads now, his would be paid off." Blu typed the
 * ORIGINAL 2018 contract (120 × $75) over the prefilled remaining schedule; the
 * paper is the record, so the paper has to say what is left: N payments of $M
 * from the first billing cycle. Voids the signed-by-landlord copy, cancels its
 * pending sale record, drafts a fresh copy in the same packet slot with the
 * right numbers prefilled, and marks it sent (Blu signs first, tenant after).
 *     npx ts-node src/scripts/mattoon/load22_redraft_contract.ts --unit "MH 22" --monthly 75 --payments 33 --first 10/1/2026 [--apply]
 */
import { query, getClient } from '../../db'
import { createDocumentRecord } from '../../routes/esign'
import { voidDocument } from '../../lib/voidDocument'

const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null }
const APPLY = process.argv.includes('--apply')
const PROPERTY = 'e9743bfa-1972-4e40-8a1b-ad76a52a17b9'

async function main() {
  const unitNo = arg('--unit'); const monthly = Number(arg('--monthly')); const payments = Number(arg('--payments')); const first = arg('--first') || '10/1/2026'
  if (!unitNo || !monthly || !payments) throw new Error('--unit, --monthly, --payments required')
  const unit = (await query<any>(`SELECT id, unit_number FROM units WHERE property_id=$1 AND unit_number=$2 AND retired_at IS NULL`, [PROPERTY, unitNo]))[0]
  if (!unit) throw new Error(`no unit ${unitNo}`)
  const d = (await query<any>(`SELECT d.* FROM lease_documents d WHERE d.unit_id=$1 AND d.document_type='purchase_agreement' AND d.status NOT IN ('voided','completed') ORDER BY d.created_at DESC LIMIT 1`, [unit.id]))[0]
  if (!d) throw new Error(`no live installment contract on ${unitNo}`)
  const signers = await query<any>(`SELECT user_id, role, name, email, phone, order_index, status FROM lease_document_signers WHERE document_id=$1 ORDER BY order_index`, [d.id])
  const tmpl = (await query<any>(`SELECT id, name, base_pdf_url, version FROM lease_templates WHERE id=$1`, [d.template_id]))[0]
  const typed = await query<any>(`SELECT lease_column, value FROM lease_document_fields WHERE document_id=$1 AND lease_column LIKE 'sale_%' ORDER BY 1`, [d.id])
  console.log(`${unitNo}: "${d.title}" ${d.status} — signers ${signers.map((s: any) => `${s.role}:${s.status}`).join(', ')}`)
  console.log(`  typed now: ${typed.map((t: any) => `${t.lease_column}=${t.value}`).join(', ')}`)
  console.log(`  re-draft:  $${monthly} × ${payments} from ${first} = $${(monthly * payments).toFixed(2)}`)
  const c = await getClient()
  try {
    await c.query('BEGIN')
    const q = (s: string, v?: any[]) => c.query(s, v)
    await voidDocument(q as any, d, 'Re-drafted with the remaining installment terms (S652, Nic)')
    const cancelled = await q(`UPDATE home_sale_contracts SET status='cancelled', updated_at=NOW() WHERE unit_id=$1 AND status='pending_signature' RETURNING id`, [unit.id])
    const doc = await createDocumentRecord(c, {
      landlordId: d.landlord_id, templateId: tmpl.id, unitId: unit.id, leaseId: d.lease_id ?? null,
      title: d.title, basePdfUrl: tmpl.base_pdf_url, documentType: d.document_type,
      targetLeaseTenantId: null, promoteLeaseTenantId: null,
      signers: signers.map((s: any) => ({ userId: s.user_id, role: s.role, name: s.name, email: s.email, phone: s.phone, orderIndex: s.order_index })),
      prefillValues: {
        sale_price: (monthly * payments).toFixed(2), sale_down_payment: '0.00',
        sale_monthly_payment: monthly.toFixed(2), sale_term_months: String(payments),
        sale_interest_rate: '0', sale_first_payment_month: first,
      },
      packageGroupId: d.package_group_id, packageId: d.package_id, packageSortOrder: d.package_sort_order,
      templateVersion: Number(tmpl.version) || 1,
    } as any)
    await q(`UPDATE lease_documents SET status='sent', sent_at=NOW(), updated_at=NOW() WHERE id=$1`, [doc.id])
    await q(`UPDATE lease_document_signers SET status='sent', invite_sent=TRUE, invite_sent_at=NOW() WHERE document_id=$1 AND role='landlord'`, [doc.id])
    // the tenant was never asked to sign this copy; the packet invites them once Blu is done
    await q(`UPDATE lease_document_signers SET status='pending', invite_sent=FALSE, invite_sent_at=NULL WHERE document_id=$1 AND role<>'landlord'`, [doc.id])
    console.log(`  voided ${d.id}, cancelled ${cancelled.rowCount} sale record(s), drafted ${doc.id}`)
    await c.query(APPLY ? 'COMMIT' : 'ROLLBACK')
    console.log(APPLY ? 'APPLIED' : '(dry run — nothing written)')
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e } finally { c.release() }
}
main().then(() => process.exit(0), e => { console.error(e.message ?? e); process.exit(1) })

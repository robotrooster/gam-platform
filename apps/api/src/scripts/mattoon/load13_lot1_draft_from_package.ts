/**
 * S652 — Lot 1, drafted from Blu's package, left for Blu to send.
 *
 * Nic: "create the packet so that he can do it for lot one. And then we will
 * let him test it, see if there's anything else we want to change."
 *
 * Same money as load8 (Nic: the remaining balance IS the price — $11,000 over
 * 55 months at $200, no down payment, no interest); same people (the Sheptock
 * account signs, the other adult on the sheet is a named occupant). What is
 * new: the documents are the ones the PACKAGE picks for this unit — a sale, so
 * the Sales lead form and the installment contract are in. It goes to Blu
 * first, as every packet does (the landlord's signature issues it); nothing
 * reaches the tenant until Blu has read it and signed.
 *     npx ts-node src/scripts/mattoon/load13_lot1_draft_from_package.ts [--apply]
 */
import { query, queryOne, getClient } from '../../db'
import { createDocumentRecord, signingUrlFor } from '../../routes/esign'
import { emailSigningRequest } from '../../services/email'
import { createHomeSaleContract } from '../../services/homeSale'
import { resolvePackageForUnit } from '../../services/signingPackages'
import crypto from 'crypto'
import fs from 'fs'

const APPLY = process.argv.includes('--apply')
const LOT = 'Lot 1'
const MONTHLY = 200, PAYMENTS = 55, START_MONTH = '2026-10-01'

async function main() {
  const prop = await queryOne<any>(`SELECT id, name, landlord_id, state FROM properties WHERE name ILIKE '%country acres%'`)
  const unit = await queryOne<any>(
    `SELECT id, unit_number FROM units WHERE property_id=$1 AND (unit_number=$2 OR display_label=$2) AND retired_at IS NULL`,
    [prop.id, LOT])
  if (!unit) throw new Error('Lot 1 not found')

  const residents = await query<any>(
    `SELECT u.id AS user_id, u.first_name||' '||u.last_name AS name, u.email, u.phone
       FROM users u WHERE u.role='tenant' AND u.last_name ILIKE 'Sheptock' ORDER BY 2`)
  const tenant = await queryOne<any>(`SELECT t.id FROM tenants t WHERE t.user_id=$1`, [residents[0].user_id])
  const owner = await queryOne<any>(
    `SELECT l.user_id, u.first_name||' '||u.last_name AS name, u.email, u.phone
       FROM landlords l JOIN users u ON u.id=l.user_id WHERE l.id=$1`, [prop.landlord_id])
  const sheet: any[] = JSON.parse(fs.readFileSync(__dirname + '/lots.json', 'utf8'))
  const row = sheet.find((r) => String(r.lot) === LOT.replace(/\D/g, ''))
  const household: string[] = String(row?.tenant ?? '').split(/\n/).map((n: string) => n.trim()).filter(Boolean)
  const signerNames = residents.map((r: any) => String(r.name).toLowerCase())
  const occupants = household.filter((n) => !signerNames.includes(n.toLowerCase()))

  const live = await query<any>(`SELECT id, title FROM lease_documents WHERE unit_id=$1 AND status NOT IN ('completed','voided')`, [unit.id])
  if (live.length) throw new Error(`Lot 1 already has ${live.length} unfinished document(s): ${live.map((d: any) => d.title).join('; ')}`)
  const liveSale = await queryOne<any>(`SELECT id FROM home_sale_contracts WHERE unit_id=$1 AND status NOT IN ('cancelled','paid_off')`, [unit.id])
  if (liveSale) throw new Error('Lot 1 already has a live home sale')

  console.log(`${prop.name} · ${unit.unit_number} (${prop.state})`)
  console.log(`  signers   ${owner.name} (landlord), ${residents.map((r: any) => r.name).join(', ')}`)
  console.log(`  occupants ${occupants.join(', ') || '(none)'}`)
  console.log(`  sale      $${(MONTHLY * PAYMENTS).toLocaleString()} over ${PAYMENTS} months at $${MONTHLY}, no down payment`)

  const signers = [
    { userId: owner.user_id, role: 'landlord', name: owner.name, email: owner.email, phone: owner.phone, orderIndex: 1 },
    ...residents.map((r: any, i: number) => ({
      userId: r.user_id, role: i === 0 ? 'primary' : `co_tenant_${i}`, name: r.name, email: r.email, phone: r.phone, orderIndex: i + 2,
    })),
  ]

  // The sale first, on its own: the package judges the unit through the pool,
  // so an uncommitted sale would still read as a rental.
  const saleClient = await getClient()
  let sale: any
  try {
    await saleClient.query('BEGIN')
    sale = await createHomeSaleContract(saleClient, {
      unitId: unit.id, leaseId: null, tenantId: tenant.id, landlordId: prop.landlord_id,
      salePrice: MONTHLY * PAYMENTS, downPayment: 0, annualInterestRate: 0,
      termMonths: PAYMENTS, startMonth: START_MONTH, planType: 'flat', pendingSignature: true,
    })
    if (APPLY) await saleClient.query('COMMIT')
    else {
      // dry run: peek at the package from inside the transaction, then undo
      const kind = await saleClient.query(`SELECT status FROM home_sale_contracts WHERE id=$1`, [sale.id])
      console.log(`  sale row  ${kind.rows[0].status} (dry run)`)
      await saleClient.query('ROLLBACK')
    }
  } catch (e) { await saleClient.query('ROLLBACK').catch(() => {}); throw e } finally { saleClient.release() }

  const client = await getClient()
  let leaseDocId = ''
  try {
    await client.query('BEGIN')
    const pkg = await resolvePackageForUnit({ landlordIds: [prop.landlord_id], unitId: unit.id })
    if (!pkg) throw new Error('No default package resolves for Lot 1')
    const picked = pkg.items.filter(i => APPLY ? i.suggested : (i.suggested || /sold/.test(i.reason)))
    console.log(`  package   ${pkg.name}`)
    for (const i of pkg.items) console.log(`    ${picked.includes(i) ? '[x]' : '[ ]'} ${i.templateName}${picked.includes(i) ? '' : `  — ${i.reason}`}`)
    if (!APPLY) { await client.query('ROLLBACK'); console.log('\n(dry run — nothing written; the sale papers tick once the sale is real)'); process.exit(0) }

    const groupId = crypto.randomUUID()
    let order = 0, saleDocId: string | null = null
    for (const i of picked) {
      const t = await queryOne<any>(`SELECT id, name, base_pdf_url, purpose FROM lease_templates WHERE id=$1`, [i.templateId])
      const documentType = t.purpose === 'lease' ? 'original_lease' : t.purpose === 'installment_sale' ? 'purchase_agreement' : 'addendum_terms'
      const prefill = t.purpose === 'lease'
        ? (occupants.length ? { occupant_names: occupants.join(', ') } : {})
        : t.purpose === 'installment_sale' ? {
            sale_price: (MONTHLY * PAYMENTS).toFixed(2), sale_down_payment: '0.00',
            sale_financed_amount: Number(sale.financed_amount).toFixed(2),
            sale_monthly_payment: Number(sale.monthly_payment).toFixed(2),
            sale_term_months: String(PAYMENTS), sale_interest_rate: '0', sale_first_payment_month: START_MONTH,
          } : {}
      const doc = await createDocumentRecord(client, {
        landlordId: prop.landlord_id, templateId: t.id, unitId: unit.id, leaseId: null,
        title: documentType === 'original_lease' ? `Lease — ${prop.name} ${unit.unit_number}` : `${t.name} — ${unit.unit_number}`,
        basePdfUrl: t.base_pdf_url, documentType,
        targetLeaseTenantId: null, promoteLeaseTenantId: null,
        signers, prefillValues: prefill,
        packageGroupId: groupId, packageId: pkg.packageId, packageSortOrder: order++,
      } as any)
      if (documentType === 'purchase_agreement') saleDocId = doc.id
      if (documentType === 'original_lease') leaseDocId = doc.id
      console.log(`  drafted   ${doc.title}`)
    }
    if (saleDocId) await client.query(`UPDATE home_sale_contracts SET purchase_document_id=$2, updated_at=NOW() WHERE id=$1`, [sale.id, saleDocId])
    await client.query('COMMIT')
    console.log(`\npacket ${groupId} — ${picked.length} documents`)
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e } finally { client.release() }

  // The lease is the way in; the signing screen walks Blu through the siblings.
  const f = await query<any>(
    `SELECT lease_column, count(*) AS n FROM lease_document_fields
      WHERE document_id=$1 AND lease_column IN ('tenant_name','tenant_initial','date_signed') GROUP BY 1 ORDER BY 1`, [leaseDocId])
  console.log('  lease tenant fields:', f.map((x: any) => `${x.lease_column}×${x.n}`).join(', ') || 'NONE')
  const first = await queryOne<any>(
    `SELECT s.* FROM lease_document_signers s WHERE s.document_id=$1 ORDER BY s.order_index LIMIT 1`, [leaseDocId])
  if (first.role !== 'landlord') throw new Error(`First signer is ${first.role} — stopping.`)
  await emailSigningRequest(first.email, first.name, `Lease — ${prop.name} ${unit.unit_number}`,
    `${prop.name} ${unit.unit_number}`, owner.name, signingUrlFor(first, leaseDocId, first),
    { landlordId: prop.landlord_id, documentId: leaseDocId })
  await query(`UPDATE lease_documents SET status='sent', sent_at=NOW(), updated_at=NOW()
                WHERE package_group_id=(SELECT package_group_id FROM lease_documents WHERE id=$1)`, [leaseDocId])
  await query(`UPDATE lease_document_signers SET status='sent' WHERE id=$1`, [first.id])
  console.log(`sent to ${first.name} <${first.email}> — nothing to the tenant until Blu signs`)
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })

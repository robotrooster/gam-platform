/**
 * S652 — Every other Country Acres household, drafted from Blu's package.
 *
 * Nic: "Blu was satisfied with his first build so he wants all the rest of the
 * packages ... put everybody on their appropriate package and send them to him
 * for signature draft. He's waiting for it right now."
 *
 * One package covers the park; what a household signs is decided by what is
 * being papered. A park-owned home on installments is a SALE (the installment
 * contract and the sales-side lead form ride along); a tenant-owned home is a
 * LOT lease (no dwelling papers — the park is not the one providing the
 * dwelling). Sale money comes straight off Blu's sheet exactly as Lot 1's did:
 * what is LEFT is the price, over the months left, at the installment, no down
 * payment, no interest. Each packet goes to Blu first; nothing reaches a tenant
 * until he has read it and signed.
 *     npx ts-node src/scripts/mattoon/load16_everyone_on_their_package.ts [--apply] [--only 8,11]
 */
import { query, queryOne, getClient } from '../../db'
import { createDocumentRecord, signingUrlFor } from '../../routes/esign'
import { emailSigningRequest } from '../../services/email'
import { createHomeSaleContract } from '../../services/homeSale'
import { resolvePackageForUnit } from '../../services/signingPackages'
import crypto from 'crypto'
import fs from 'fs'

const APPLY = process.argv.includes('--apply')
const onlyArg = process.argv[process.argv.indexOf('--only') + 1]
const ONLY = process.argv.includes('--only') ? new Set(onlyArg.split(',').map(s => s.trim())) : null
const START_MONTH = '2026-10-01'
/** Where the sheet's numbers are in the notes rather than the columns. */
const TERMS: Record<string, { monthly: number; payments: number; why: string }> = {
  '18': { monthly: 100, payments: 60, why: 'sheet: "$550 a month for 5 years" — $450 lot rent + $100 on the home' },
  '21': { monthly: 200, payments: 60, why: 'sheet: "$650 for 5 years" — $450 lot rent + $200 on the home' },
}

async function main() {
  const prop = await queryOne<any>(`SELECT id, name, landlord_id, state FROM properties WHERE name ILIKE '%country acres%'`)
  const owner = await queryOne<any>(
    `SELECT l.user_id, u.first_name||' '||u.last_name AS name, u.email, u.phone
       FROM landlords l JOIN users u ON u.id=l.user_id WHERE l.id=$1`, [prop.landlord_id])
  const sheet: any[] = JSON.parse(fs.readFileSync(__dirname + '/lots.json', 'utf8'))
  const held: string[] = []

  for (const row of sheet) {
    if (row.occupied !== 'Yes' || row.lot === '1') continue
    if (ONLY && !ONLY.has(String(row.lot))) continue
    const label = `MH ${String(row.lot).padStart(2, '0')}`
    const unit = await queryOne<any>(
      `SELECT id, unit_number, dwelling_ownership FROM units WHERE property_id=$1 AND unit_number=$2 AND retired_at IS NULL`, [prop.id, label])
    if (!unit) { held.push(`${label}: no such unit`); continue }

    const live = await query<any>(`SELECT title FROM lease_documents WHERE unit_id=$1 AND status NOT IN ('completed','voided')`, [unit.id])
    if (live.length) { held.push(`${label}: already has ${live.length} unfinished document(s)`); continue }
    if (await queryOne(`SELECT 1 FROM home_sale_contracts WHERE unit_id=$1 AND status NOT IN ('cancelled','paid_off')`, [unit.id])) {
      held.push(`${label}: already has a live home sale`); continue
    }

    const household: string[] = String(row.tenant ?? '').split(/\n/).map((n: string) => n.trim()).filter(Boolean)
    const residents = await query<any>(
      `SELECT u.id AS user_id, u.first_name||' '||u.last_name AS name, u.email, u.phone, t.id AS tenant_id
         FROM users u JOIN tenants t ON t.user_id=u.id
        WHERE u.role='tenant' AND u.first_name||' '||u.last_name = ANY($1::text[])
        ORDER BY (lower(u.email) = lower($2)) DESC, u.created_at`, [household, String(row.email ?? '')])
    if (!residents.length) { held.push(`${label}: nobody in the household has an account`); continue }
    const signerNames = residents.map((r: any) => String(r.name).toLowerCase())
    const occupants = household.filter((n) => !signerNames.includes(n.toLowerCase()))

    // What is being papered.
    const tenantOwned = unit.dwelling_ownership === 'tenant'
    let terms: { monthly: number; payments: number; why: string } | null = null
    if (!tenantOwned && row.rto === 'x') {
      const t = TERMS[String(row.lot)]
      const monthly = t?.monthly ?? Number(row.rto_pay ?? 0)
      const payments = t?.payments ?? Number(String(row.months_left ?? '').replace(/\D/g, ''))
      // No number to write = no contract to write; the lease and disclosures
      // do not wait on it. Blu adds the installment contract when he has it.
      if (!(monthly > 0) || !(payments > 0)) {
        console.log(`\n${label}: sheet says installments but $${monthly} × ${payments || '?'} months — "${row.notes ?? ''}" — drafting the lease without a sale`)
      } else terms = { monthly, payments, why: t?.why ?? `sheet: $${row.amount_left} left, ${payments} months, $${monthly}/mo` }
    }

    console.log(`\n${prop.name} · ${unit.unit_number} — ${tenantOwned ? 'tenant-owned home, lot lease' : terms ? 'park-owned home on installments' : 'park-owned home, rental'}`)
    console.log(`  signers   ${owner.name} (landlord), ${residents.map((r: any) => r.name).join(', ')}`)
    console.log(`  occupants ${occupants.join(', ') || '(none)'}`)
    if (terms) console.log(`  sale      $${(terms.monthly * terms.payments).toLocaleString()} over ${terms.payments} months at $${terms.monthly}, no down payment — ${terms.why}`)

    const signers = [
      { userId: owner.user_id, role: 'landlord', name: owner.name, email: owner.email, phone: owner.phone, orderIndex: 1 },
      ...residents.map((r: any, i: number) => ({
        userId: r.user_id, role: i === 0 ? 'primary' : `co_tenant_${i}`, name: r.name, email: r.email, phone: r.phone, orderIndex: i + 2,
      })),
    ]

    // The sale first, on its own: the package judges the unit through the pool.
    let sale: any = null
    if (terms) {
      const c = await getClient()
      try {
        await c.query('BEGIN')
        sale = await createHomeSaleContract(c, {
          unitId: unit.id, leaseId: null, tenantId: residents[0].tenant_id, landlordId: prop.landlord_id,
          salePrice: terms.monthly * terms.payments, downPayment: 0, annualInterestRate: 0,
          termMonths: terms.payments, startMonth: START_MONTH, planType: 'flat', pendingSignature: true,
        })
        await c.query(APPLY ? 'COMMIT' : 'ROLLBACK')
      } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e } finally { c.release() }
    }

    const client = await getClient()
    let leaseDocId = ''
    try {
      await client.query('BEGIN')
      const pkg = await resolvePackageForUnit({ landlordIds: [prop.landlord_id], unitId: unit.id, kind: terms ? 'sale' : undefined })
      if (!pkg) throw new Error(`No default package resolves for ${label}`)
      // Lot 1 went to Blu with the radon pair in it and he approved that packet;
      // a sale packet here matches it rather than the package's own reading.
      const picked = pkg.items.filter(i => i.suggested || (terms && /radon/i.test(i.templateName)))
      console.log(`  package   ${pkg.name}`)
      for (const i of pkg.items) console.log(`    ${picked.includes(i) ? '[x]' : '[ ]'} ${i.templateName}${picked.includes(i) ? '' : `  — ${i.reason}`}`)
      if (!APPLY) { await client.query('ROLLBACK'); continue }

      const groupId = crypto.randomUUID()
      let order = 0, saleDocId: string | null = null
      for (const i of picked) {
        const t = await queryOne<any>(`SELECT id, name, base_pdf_url, purpose FROM lease_templates WHERE id=$1`, [i.templateId])
        const documentType = t.purpose === 'lease' ? 'original_lease' : t.purpose === 'installment_sale' ? 'purchase_agreement' : 'addendum_terms'
        const prefill = t.purpose === 'lease'
          ? (occupants.length ? { occupant_names: occupants.join(', ') } : {})
          : t.purpose === 'installment_sale' && sale ? {
              sale_price: (terms!.monthly * terms!.payments).toFixed(2), sale_down_payment: '0.00',
              sale_financed_amount: Number(sale.financed_amount).toFixed(2),
              sale_monthly_payment: Number(sale.monthly_payment).toFixed(2),
              sale_term_months: String(terms!.payments), sale_interest_rate: '0', sale_first_payment_month: START_MONTH,
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
      }
      if (sale && !saleDocId) throw new Error(`${label}: sale without an installment contract in the packet`)
      if (sale && saleDocId) await client.query(`UPDATE home_sale_contracts SET purchase_document_id=$2, updated_at=NOW() WHERE id=$1`, [sale.id, saleDocId])
      if (!leaseDocId) throw new Error(`${label}: no lease in the packet`)
      await client.query('COMMIT')
      console.log(`  packet    ${groupId} — ${picked.length} documents`)
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e } finally { client.release() }

    const first = await queryOne<any>(`SELECT * FROM lease_document_signers WHERE document_id=$1 ORDER BY order_index LIMIT 1`, [leaseDocId])
    if (first.role !== 'landlord') throw new Error(`${label}: first signer is ${first.role} — stopping.`)
    await emailSigningRequest(first.email, first.name, `Lease — ${prop.name} ${unit.unit_number}`,
      `${prop.name} ${unit.unit_number}`, owner.name, signingUrlFor(first, leaseDocId, first),
      { landlordId: prop.landlord_id, documentId: leaseDocId })
    await query(`UPDATE lease_documents SET status='sent', sent_at=NOW(), updated_at=NOW() WHERE package_group_id=(SELECT package_group_id FROM lease_documents WHERE id=$1)`, [leaseDocId])
    await query(`UPDATE lease_document_signers SET status='sent' WHERE id=$1`, [first.id])
    console.log(`  sent to ${first.name} <${first.email}>`)
  }
  if (held.length) console.log(`\nHELD (nothing drafted):\n  ${held.join('\n  ')}`)
  if (!APPLY) console.log('\n(dry run — nothing written)')
  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })

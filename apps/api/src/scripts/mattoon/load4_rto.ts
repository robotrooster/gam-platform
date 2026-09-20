/**
 * S651 — Mattoon load, stage 4: the rent-to-own installment contracts,
 * bundled with each lease as a signing PACKAGE.
 *
 * Nine of the thirteen households are buying their home on installments. Nic
 * wanted them as their own contract rather than a clause in the lease, using
 * Blu's own form — and the package machinery (S641) exists for exactly this
 * case. Its own header quotes him: "a lot of people are gonna be like, well, I
 * already signed the lease, what's this for? And it's like, okay, that's your
 * installment sale contract." It has never been used on a real park.
 *
 * The lease drafted in stage 3 and the contract drafted here share a
 * package_group_id, so the signing screen can say "1 of 2" and carry somebody
 * from one to the next.
 *
 * WHAT IS PREFILLED, AND WHAT DELIBERATELY IS NOT. The tenant's name, the park
 * address and the remaining term come straight off Blu's sheet and are safe.
 * Every money field is left blank. The sheet records what is LEFT to pay
 * ($11,000 over 55 months), never the original sale price or the down payment,
 * and the template's own rent_amount box could reasonably mean the lot rent
 * ($450) or the installment ($200) — writing a number into a contract on a
 * guess is how somebody ends up holding a signed document that says the wrong
 * thing. Blu has the originals; he fills those in as he reviews.
 */
import { query, getClient } from '../../db'
import { createDocumentRecord } from '../../routes/esign'
import { randomUUID } from 'crypto'
import fs from 'fs'

const DRY = process.env.DRY === '1'
const SRC = __dirname + '/lots.json'
const PROPERTY = 'e9743bfa-1972-4e40-8a1b-ad76a52a17b9'
const LANDLORD = 'e8904104-ab16-4d02-b6f8-cac88d738aae'
const ADDRESS = '10055 US-45, Mattoon, IL 61938'
/** Blu's installment form — the only one of his two carrying sale price and down payment. */
const TEMPLATE = '98081591-5553-42b5-aff4-7158abeea46c'  // Country Acres Mattoon Installment

async function main() {
  const rows: any[] = JSON.parse(fs.readFileSync(SRC, 'utf8'))
  const seen = new Set<string>()
  const rto = rows.filter((r) => {
    const ok = /^\d+$/.test(r.lot) && r.tenant && r.tenant.toLowerCase() !== 'vacant'
      && r.rto === 'x' && !seen.has(r.lot)
    if (ok) seen.add(r.lot)
    return ok
  })

  const tpl = await query<any>(`SELECT id, name, base_pdf_url, version FROM lease_templates WHERE id=$1`, [TEMPLATE])
  if (!tpl.length) throw new Error('installment template not found')
  console.log(`template: ${tpl[0].name}\n`)

  let made = 0, skipped = 0
  for (const r of rto) {
    const unitNumber = `Lot ${r.lot}`
    const ctx = await query<any>(
      `SELECT u.id AS unit_id,
              d.id AS lease_doc_id, d.package_group_id,
              (SELECT json_agg(json_build_object('userId', s.user_id, 'role', s.role,
                       'name', s.name, 'email', s.email, 'phone', s.phone,
                       'orderIndex', s.order_index) ORDER BY s.order_index)
                 FROM lease_document_signers s WHERE s.document_id = d.id) AS signers
         FROM units u
         LEFT JOIN lease_documents d ON d.unit_id = u.id
              AND d.document_type='original_lease' AND d.voided_at IS NULL
        WHERE u.property_id=$1 AND u.unit_number=$2 AND u.retired_at IS NULL`,
      [PROPERTY, unitNumber])
    if (!ctx.length || !ctx[0].lease_doc_id) {
      console.log(`  ${unitNumber.padEnd(8)} no lease document — skipped`); skipped++; continue
    }
    const { unit_id, lease_doc_id, signers } = ctx[0]

    const already = await query<any>(
      `SELECT id FROM lease_documents WHERE unit_id=$1 AND document_type='purchase_agreement'
        AND voided_at IS NULL`, [unit_id])
    if (already.length) { console.log(`  ${unitNumber.padEnd(8)} contract already exists — skipped`); skipped++; continue }

    const months = /^\d+$/.test(String(r.months_left ?? '')) ? String(r.months_left) : null
    const primary = signers.find((s: any) => s.role === 'tenant')
    const prefill: Record<string, string> = {
      tenant_name: primary?.name ?? '',
      property_address: ADDRESS,
      ...(months ? { sale_term_months: months } : {}),
    }

    if (DRY) {
      console.log(`  ${unitNumber.padEnd(8)} would draft — ${primary?.name}` +
                  `  term=${months ?? '(not on the sheet)'}` +
                  `  balance=${r.amount_left ?? '(not on the sheet)'} @ $${r.rto_pay}/mo`)
      made++; continue
    }

    const groupId = ctx[0].package_group_id ?? randomUUID()
    const c = await getClient()
    try {
      await c.query('BEGIN')
      // The lease becomes item 1 of the bundle; the contract follows it.
      await c.query(
        `UPDATE lease_documents SET package_group_id=$2, package_sort_order=0 WHERE id=$1`,
        [lease_doc_id, groupId])
      const doc = await createDocumentRecord(c, {
        landlordId: LANDLORD,
        templateId: TEMPLATE,
        unitId: unit_id,
        leaseId: null,
        title: `Installment sale contract — Country Acres ${unitNumber}`,
        basePdfUrl: tpl[0].base_pdf_url,
        documentType: 'purchase_agreement' as any,
        targetLeaseTenantId: null,
        promoteLeaseTenantId: null,
        signers,                       // same order: Blu first, then the household
        prefillValues: prefill,
        packageGroupId: groupId,
        packageSortOrder: 1,
        templateVersion: tpl[0].version ?? null,
      } as any)
      await c.query('COMMIT')
      console.log(`  ${unitNumber.padEnd(8)} drafted  ${doc.id}  (bundled with the lease)`)
      made++
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
  }
  console.log(`\n${made} contract(s) · ${skipped} skipped`)
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })

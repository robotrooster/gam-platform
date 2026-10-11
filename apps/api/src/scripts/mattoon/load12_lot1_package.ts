/**
 * S652 — Blu's Lot 1 packet, as a PACKAGE he sends himself.
 *
 * Nic: "create the packet so that he can do it for lot one. And then we will
 * let him test it, see if there's anything else we want to change."
 *
 * Illinois, mobile home lot, home on installments. Every document is one Blu
 * already has or one the government publishes (adopted into his account here).
 * Order is the order the tenant signs: the Safe Homes summary is the lease's
 * FIRST page by statute; the lease; the installment contract; then the papers
 * handed over with a sale and a home; the act last, offered rather than signed.
 *     npx ts-node src/scripts/mattoon/load12_lot1_package.ts
 */
import { db, query, queryOne } from '../../db'
import { adoptLibraryDocument } from '../../services/disclosureLibrary'

const BLU = 'e8904104-ab16-4d02-b6f8-cac88d738aae'   // TruBlu Management LLC (Country Acres)

async function main() {
  const q = { query: (sql: string, params: any[]) => db.query(sql, params) }
  const lib = async (needle: string) => {
    const d = await queryOne<any>(
      `SELECT id, name FROM disclosure_library_documents WHERE retired_at IS NULL AND superseded_by_id IS NULL AND name ILIKE $1`, [`%${needle}%`])
    if (!d) throw new Error(`library: no document like "${needle}"`)
    const { templateId, alreadyHeld } = await adoptLibraryDocument(q as any, BLU, d.id)
    console.log(`${alreadyHeld ? 'held' : 'adopted'}: ${d.name}`)
    return templateId
  }
  const own = async (name: string) => {
    const t = await queryOne<{ id: string }>(
      `SELECT id FROM lease_templates WHERE landlord_id=$1 AND is_active AND name=$2`, [BLU, name])
    if (!t) throw new Error(`Blu has no template "${name}"`)
    return t.id
  }

  // [templateId, at renewal, always]
  const items: Array<[string, string, boolean]> = [
    [await lib('Summary of Rights for Safer Homes'),         'with_lease',        true],
    [await own('Mattoon Lease, EX A and B'),                'with_lease',        true],
    [await own('Mattoon Installment Contract'),             'once_per_tenancy',  false],
    [await lib('Lead-Based Paint Disclosure — Sales'),      'once_per_tenancy',  false],
    [await lib('Protect Your Family From Lead'),            'once_per_tenancy',  false],
    [await lib('Disclosure of Information on Radon Hazards'), 'once_per_tenancy', false],
    [await lib('Radon Guide for Tenants'),                  'once_per_tenancy',  false],
    [await lib('Living in a Manufactured Home Community'),  'once_per_tenancy',  false],
    [await lib('Mobile Home Landlord and Tenant Rights Act'), 'on_version_change', false],
  ]

  const name = 'Illinois — mobile home lot, home on installments'
  const existing = await queryOne<{ id: string }>(
    `SELECT id FROM document_packages WHERE landlord_id=$1 AND name=$2 AND archived_at IS NULL`, [BLU, name])
  const pkgId = existing?.id ?? (await queryOne<{ id: string }>(
    `INSERT INTO document_packages (landlord_id, name, description, unit_type, is_default, state_code)
     VALUES ($1,$2,$3,'mobile_home',true,'IL') RETURNING id`,
    [BLU, name, 'Lot lease with the home sold on installments — the Lot 1 packet.']))!.id
  await query(`DELETE FROM document_package_items WHERE package_id=$1`, [pkgId])
  let sort = 0
  for (const [templateId, renewal, always] of items) {
    await query(
      `INSERT INTO document_package_items (package_id, template_id, sort_order, renewal_behavior, required)
       VALUES ($1,$2,$3,$4,$5)`, [pkgId, templateId, sort++, renewal, always])
  }
  console.log(`package ${existing ? 'rebuilt' : 'created'}: ${name} — ${items.length} documents`)
  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })

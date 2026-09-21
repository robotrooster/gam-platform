/**
 * S652 — clear Lot 1, and put the government forms on Blu's shelf.
 *
 * Nic: "remove everything from lot one. We're going to redraft the package...
 * you may need to get in there and edit Blu's templates if they're not showing
 * the right way... get those forms in there for the package. I will double check
 * with him that he's updated his specific lease template. And then we will get
 * the package drawn up. Once that one is good, then we'll send it to everybody.
 * But he needs to edit whatever box is on his template first."
 *
 * So this does NOT draft or send anything. Three steps, one transaction:
 *
 *  1. Void the three Lot 1 documents still out for signature. Nobody has signed
 *     any of them. Voided, not erased — GAM keeps the record that they went out
 *     — through lib/voidDocument, the same steps the Void button runs. The
 *     installment agreement's pending sale is cancelled by the trigger that
 *     this very cleanup is the reason for.
 *
 *  2. Put three library forms on Blu's shelf: EPA's Sales lead disclosure (the
 *     home is being sold, so Sales — never both), the January 2026 lead
 *     pamphlet that line (d) of that form says the buyer received, and IDPH's
 *     "Living in a Manufactured Home Community," the pamphlet his own lease's
 *     acknowledgement says was offered.
 *
 *  3. Retire Blu's own two lead-paint uploads. They are the same federal form in
 *     his attorney's layout, tagged as LEASES rather than disclosures — so the
 *     lease picker offered them, and a packet could carry them beside EPA's copy,
 *     which is the "two lead-based paint things" Nic asked about. Retired
 *     (is_active = false), not deleted: one click puts them back.
 *
 *     DRY=1 npx ts-node src/scripts/mattoon/load10_clear_lot1_stock_blu.ts
 */
import { db } from '../../db'
import { voidDocument } from '../../lib/voidDocument'
import { adoptLibraryDocument } from '../../services/disclosureLibrary'

const BLU = 'e8904104-ab16-4d02-b6f8-cac88d738aae'
const DRY = process.env.DRY === '1'
const REASON = 'Withdrawn to redraft with the government forms library (S652). Nothing was signed.'

const LIBRARY = [
  'Lead-Based Paint Disclosure — Sales (EPA Form 9600-040)',
  'Protect Your Family From Lead in Your Home (January 2026)',
  'Living in a Manufactured Home Community (Illinois, 2018)',
]
const RETIRE = ['Mattoon LBP - Lease', 'Mattoon LBP - Sale']

async function main() {
  const client = await db.connect()
  const q = client.query.bind(client) as any
  try {
    await client.query('BEGIN')

    const docs = (await client.query(
      `SELECT d.* FROM lease_documents d JOIN units u ON u.id = d.unit_id
        WHERE d.landlord_id = $1 AND u.unit_number = 'MH 01'
          AND d.status NOT IN ('voided','completed')
        ORDER BY d.package_sort_order NULLS LAST, d.created_at`, [BLU])).rows
    console.log(`1. void ${docs.length} Lot 1 document(s):`)
    for (const d of docs) {
      console.log(`     ${d.status.padEnd(8)} ${d.title}`)
      if (!DRY) await voidDocument(q, d, REASON)
    }

    console.log('2. put on Blu\'s shelf:')
    for (const name of LIBRARY) {
      const lib = (await client.query(
        `SELECT id FROM disclosure_library_documents
          WHERE name = $1 AND retired_at IS NULL AND superseded_by_id IS NULL`, [name])).rows[0]
      if (!lib) throw new Error(`not on the shelf: ${name}`)
      if (DRY) { console.log(`     ${name}`); continue }
      const out = await adoptLibraryDocument(client as any, BLU, lib.id)
      console.log(`     ${out.alreadyHeld ? 'already had' : 'added     '} ${name}`)
    }

    console.log('3. retire Blu\'s own lead-paint uploads:')
    for (const name of RETIRE) {
      const t = (await client.query(
        `SELECT id, is_active FROM lease_templates WHERE landlord_id=$1 AND name=$2`, [BLU, name])).rows[0]
      if (!t) { console.log(`     (not found) ${name}`); continue }
      console.log(`     ${name}${t.is_active ? '' : ' — already retired'}`)
      if (!DRY && t.is_active) await client.query(`UPDATE lease_templates SET is_active=false, updated_at=now() WHERE id=$1`, [t.id])
    }

    if (DRY) { await client.query('ROLLBACK'); console.log('\nDRY — nothing written.') }
    else {
      await client.query('COMMIT')
      const sale = (await client.query(
        `SELECT h.status FROM home_sale_contracts h JOIN units u ON u.id=h.unit_id
          WHERE h.landlord_id=$1 AND u.unit_number='MH 01' ORDER BY h.created_at DESC LIMIT 1`, [BLU])).rows[0]
      console.log(`\nLot 1's pending sale is now: ${sale?.status ?? '(none)'}`)
    }
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e }
  finally { client.release() }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })

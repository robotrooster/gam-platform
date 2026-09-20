/**
 * S651 — name the other adults on the lease.
 *
 * Six adults on Blu's sheet share a household mailbox, so only the
 * mailbox-holder became an account and a signer. I decided that quietly, on the
 * correct reasoning that an account needs a real address and GAM never invents
 * one — and skipped the conclusion that does not follow from it: not having an
 * email does not mean you are not on the lease. They ended up named NOWHERE on
 * the document.
 *
 * Nic caught it: "some people do not have emails, like lot 21 there's only one
 * email for three people... I thought you were going to bring that up."
 *
 * They go in the occupant_names box: named residents, no account, no email, not
 * financially liable — which is what the sheet actually records them as. A
 * signing co-tenant needs their own address and can be added by addendum later.
 */
import { query } from '../../db'
import fs from 'fs'

const DRY = process.env.DRY === '1'
const SRC = __dirname + '/lots.json'
const PROPERTY = 'e9743bfa-1972-4e40-8a1b-ad76a52a17b9'

async function main() {
  const rows: any[] = JSON.parse(fs.readFileSync(SRC, 'utf8'))
  const seen = new Set<string>()
  const occ = rows.filter((r) => {
    const ok = /^\d+$/.test(r.lot) && r.tenant && r.tenant.toLowerCase() !== 'vacant' && !seen.has(r.lot)
    if (ok) seen.add(r.lot)
    return ok
  })

  let filled = 0, skipped = 0
  for (const r of occ) {
    const unitNumber = `Lot ${r.lot}`
    const names: string[] = String(r.tenant).split(/\n|\//).map((x: string) => x.trim()).filter(Boolean)

    const doc = await query<any>(
      `SELECT d.id,
              (SELECT array_agg(s.name ORDER BY s.order_index)
                 FROM lease_document_signers s
                WHERE s.document_id = d.id AND s.role = 'tenant') AS signers
         FROM lease_documents d JOIN units u ON u.id = d.unit_id
        WHERE u.property_id = $1 AND u.unit_number = $2
          AND d.document_type = 'original_lease' AND d.voided_at IS NULL`,
      [PROPERTY, unitNumber])
    if (!doc.length) { skipped++; continue }

    const signers: string[] = doc[0].signers ?? []
    // Whoever is on the household but not already signing.
    const others = names.filter((n) => !signers.some((s) => s.toLowerCase() === n.toLowerCase()))
    if (!others.length) { skipped++; continue }

    const value = others.join(', ')
    if (DRY) {
      console.log(`  ${unitNumber.padEnd(8)} signs: ${signers.join(', ')}   →  occupants: ${value}`)
      filled++; continue
    }
    const res = await query<any>(
      `UPDATE lease_document_fields
          SET value = $2
        WHERE document_id = $1 AND lease_column = 'occupant_names'
        RETURNING id`, [doc[0].id, value])
    if (res.length) {
      console.log(`  ${unitNumber.padEnd(8)} occupants: ${value}`)
      filled++
    } else {
      console.log(`  ${unitNumber.padEnd(8)} NO occupant_names box on this document — ${value} not recorded`)
      skipped++
    }
  }
  console.log(`\n${filled} document(s) named · ${skipped} needed nothing`)
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })

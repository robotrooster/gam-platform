/**
 * S652 — One email per lot to Blu: the next document in that packet that still
 * needs his signature. He signed nine leases and was never led to the other
 * eight documents behind each; the page walks him now (deploy 37), and this is
 * the way back in for the packets he already left.
 *     npx ts-node src/scripts/mattoon/load18_blu_continuation.ts [--apply]
 */
import { query, queryOne } from '../../db'
import { signingUrlFor } from '../../routes/esign'
import { emailSigningRequest } from '../../services/email'
import { packageSiblings } from '../../services/signingPackages'

const APPLY = process.argv.includes('--apply')
const onlyArg = process.argv[process.argv.indexOf('--only') + 1]
const ONLY = process.argv.includes('--only') ? `MH ${onlyArg.padStart(2, '0')}` : null
const PROPERTY = 'e9743bfa-1972-4e40-8a1b-ad76a52a17b9'

async function main() {
  const prop = await queryOne<any>(`SELECT id, name, landlord_id FROM properties WHERE id=$1`, [PROPERTY])
  const owner = await queryOne<any>(
    `SELECT l.user_id, u.first_name||' '||u.last_name AS name, u.email FROM landlords l JOIN users u ON u.id=l.user_id WHERE l.id=$1`, [prop.landlord_id])
  const leases = await query<any>(
    `SELECT d.id, u.unit_number, u.dwelling_ownership FROM lease_documents d JOIN units u ON u.id=d.unit_id
      WHERE u.property_id=$1 AND d.document_type='original_lease' AND d.status NOT IN ('voided','completed')
      ORDER BY u.unit_number`, [PROPERTY])
  for (const l of leases) {
    if (ONLY && l.unit_number !== ONLY) continue
    const sib = await packageSiblings(l.id, owner.user_id)
    const hasSale = sib.some(d => /Installment Contract/.test(d.title))
    const kind = l.dwelling_ownership === 'tenant' ? 'tenant-owned home' : 'park-owned home'
    const next = sib.find(d => d.mine && d.mine.status !== 'signed' && d.mine.status !== 'declined' && d.status !== 'completed' && d.status !== 'voided')
    const left = sib.filter(d => d.mine && d.mine.status !== 'signed' && d.status !== 'completed').length
    console.log(`${l.unit_number}  ${kind}, ${sib.length} documents, installment contract: ${hasSale ? 'YES' : 'no'};  ${left} still need Blu → next: ${next?.title ?? '(none)'}`)
    if (!next || !APPLY) continue
    const signer = await queryOne<any>(`SELECT * FROM lease_document_signers WHERE document_id=$1 AND user_id=$2`, [next.id, owner.user_id])
    await emailSigningRequest(owner.email, owner.name, `${next.title} (${sib.indexOf(next) + 1} of ${sib.length} — ${left} still need your signature)`,
      `${prop.name} ${l.unit_number}`, owner.name, signingUrlFor(signer, next.id, signer), { landlordId: prop.landlord_id, documentId: next.id })
    await query(`UPDATE lease_document_signers SET invite_sent=TRUE, invite_sent_at=NOW() WHERE id=$1`, [signer.id])
    console.log(`   sent`)
  }
  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })

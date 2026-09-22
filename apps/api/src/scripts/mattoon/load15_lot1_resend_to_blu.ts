/** S652 — the Lot 1 signing email to Blu, sent for real (load13 ran outside production and the mail was suppressed). */
import { queryOne } from '../../db'
import { signingUrlFor } from '../../routes/esign'
import { emailSigningRequest } from '../../services/email'
const GROUP = '3878f05e-62b6-4144-af65-b986f4ae8988'
async function main() {
  const lease = await queryOne<any>(
    `SELECT d.id, d.landlord_id, u.unit_number, p.name AS property_name, lu.first_name||' '||lu.last_name AS owner
       FROM lease_documents d JOIN units u ON u.id=d.unit_id JOIN properties p ON p.id=u.property_id
       JOIN landlords l ON l.id=d.landlord_id JOIN users lu ON lu.id=l.user_id
      WHERE d.package_group_id=$1 AND d.document_type='original_lease'`, [GROUP])
  const first = await queryOne<any>(`SELECT * FROM lease_document_signers WHERE document_id=$1 ORDER BY order_index LIMIT 1`, [lease.id])
  if (first.role !== 'landlord') throw new Error('first signer is not the landlord')
  await emailSigningRequest(first.email, first.name, `Lease — ${lease.property_name} ${lease.unit_number}`,
    `${lease.property_name} ${lease.unit_number}`, lease.owner, signingUrlFor(first, lease.id, first),
    { landlordId: lease.landlord_id, documentId: lease.id })
  console.log(`emailed ${first.name} <${first.email}>`)
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })

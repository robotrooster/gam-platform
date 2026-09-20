/**
 * S652 — throw away the thirteen, and draft ONE for Blu to look at.
 *
 * Nic: "Delete all the bad leases. We are going to do a test and just draft the
 * one lease for the Sheptock household, send it to Blu first as the signer as
 * the landlord, and then before he signs it he's going to see if anything else
 * needs to be evaluated so that we can go from there before we send them to
 * everybody."
 *
 * WHY DELETE RATHER THAN VOID. Void keeps the row — the document, its fields and
 * its signers stay forever and show up in history. That is right for a document
 * that meant something and was withdrawn. These meant nothing: they were built
 * from a template Blu has since replaced, and they were missing 70 of its 125
 * fields because every resident was labelled with a signer role no template
 * binds to, so not one tenant name, initial or signature date ever reached them.
 * Nic: "something that was never a real issue, of real substance or value to the
 * system needs to just kind of be pruned completely."
 *
 * Nothing is lost by it: no signature was ever recorded on any of the thirteen,
 * and nothing else in the database referenced them. The emails GAM sent Blu
 * about them remain in the send log, which is the record that matters.
 *
 * Run with --apply. Without it, says what it would do and touches nothing.
 */
import { query, queryOne } from '../../db'
import { draftHouseholdLease } from '../../services/householdLeaseDraft'
import { signingUrlFor } from '../../routes/esign'
import { emailSigningRequest } from '../../services/email'

const APPLY = process.argv.includes('--apply')
const LOT = 'Lot 1'

async function main() {
  const prop = await queryOne<any>(
    `SELECT p.id, p.name, p.landlord_id FROM properties p WHERE p.name ILIKE '%country acres%'`)
  if (!prop) throw new Error('Country Acres not found')

  // ── 1. the thirteen ──────────────────────────────────────────────────────
  const bad = await query<any>(
    `SELECT d.id, u.unit_number FROM lease_documents d
       JOIN units u ON u.id = d.unit_id
      WHERE d.landlord_id = $1 AND d.status = 'sent'
      ORDER BY u.unit_number`, [prop.landlord_id])
  const signed = await query<any>(
    `SELECT 1 FROM lease_document_signers s
      WHERE s.document_id = ANY($1::uuid[]) AND s.status = 'signed'`,
    [bad.map((d: any) => d.id)])
  if (signed.length) throw new Error('One of these has a signature on it — stopping.')

  console.log(`${bad.length} unsigned lease documents to delete:`)
  for (const d of bad) console.log(`  ${d.unit_number}`)

  if (APPLY) {
    // fields and signers cascade; nothing else references these.
    const del = await query<any>(
      `DELETE FROM lease_documents WHERE id = ANY($1::uuid[]) RETURNING id`,
      [bad.map((d: any) => d.id)])
    console.log(`  deleted ${del.length}`)
  }

  // ── 2. one lease, for Blu to read ────────────────────────────────────────
  const unit = await queryOne<any>(
    `SELECT id FROM units WHERE property_id=$1 AND unit_number=$2 AND retired_at IS NULL`,
    [prop.id, LOT])
  if (!unit) throw new Error(`${LOT} not found`)

  // The residents of this household, as the load recorded them.
  const residents = await query<any>(
    `SELECT DISTINCT u.id AS user_id, u.first_name||' '||u.last_name AS name, u.email, u.phone
       FROM users u
      WHERE u.role = 'tenant'
        AND u.last_name ILIKE 'Sheptock'
      ORDER BY 2`)
  console.log(`\n${LOT} residents: ${residents.map((r: any) => `${r.name} <${r.email}>`).join(', ') || '(none found)'}`)
  if (!residents.length) throw new Error('No Sheptock resident account found')

  if (!APPLY) { console.log('\n(dry run — nothing written)'); process.exit(0) }

  const res: any = await draftHouseholdLease({
    landlordId: prop.landlord_id, unitId: unit.id,
    residents: residents.map((r: any) => ({
      userId: r.user_id, name: r.name, email: r.email, phone: r.phone,
    })),
  })
  if (!res.drafted) throw new Error(`Not drafted: ${res.reason}`)
  console.log(`drafted ${res.documentId}`)

  // Proof the fix took: the tenant fields have to be ON it this time.
  const fields = await query<any>(
    `SELECT lease_column, count(*) AS n FROM lease_document_fields
      WHERE document_id=$1 AND lease_column IN ('tenant_name','tenant_initial','date_signed')
      GROUP BY 1 ORDER BY 1`, [res.documentId])
  console.log('  tenant fields on the document:',
    fields.map((f: any) => `${f.lease_column}×${f.n}`).join(', ') || 'NONE — stop and investigate')
  const roles = await query<any>(
    `SELECT role, name FROM lease_document_signers WHERE document_id=$1 ORDER BY order_index`,
    [res.documentId])
  console.log('  signers:', roles.map((r: any) => `${r.role}=${r.name}`).join(', '))

  // ── 3. to Blu, and only Blu ──────────────────────────────────────────────
  // The first signer by order is the landlord (the household draft puts him at
  // orderIndex 1 for exactly this reason — a last glance before it reaches a
  // resident). Sending therefore mails him and nobody else.
  const first = await queryOne<any>(
    `SELECT s.*, u.email_verified, u.tenant_invite_token
       FROM lease_document_signers s LEFT JOIN users u ON u.id = s.user_id
      WHERE s.document_id=$1 ORDER BY s.order_index LIMIT 1`, [res.documentId])
  if (first.role !== 'landlord') throw new Error(`First signer is ${first.role}, not the landlord — stopping.`)

  const doc = await queryOne<any>(
    `SELECT d.title, d.landlord_id, u.unit_number, p.name AS property_name,
            lu.first_name||' '||lu.last_name AS landlord_name
       FROM lease_documents d
       JOIN units u ON u.id=d.unit_id JOIN properties p ON p.id=u.property_id
       JOIN landlords la ON la.id=d.landlord_id JOIN users lu ON lu.id=la.user_id
      WHERE d.id=$1`, [res.documentId])

  const url = signingUrlFor(first, res.documentId, first)
  await emailSigningRequest(
    first.email, first.name, doc.title, `${doc.property_name} ${doc.unit_number}`,
    doc.landlord_name, url, { landlordId: doc.landlord_id, documentId: res.documentId })
  await query(
    `UPDATE lease_documents SET status='sent', sent_at=NOW(), updated_at=NOW() WHERE id=$1`,
    [res.documentId])
  await query(
    `UPDATE lease_document_signers SET status='sent', updated_at=NOW() WHERE id=$1`, [first.id])
  console.log(`\nsent to ${first.name} <${first.email}> only`)
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })

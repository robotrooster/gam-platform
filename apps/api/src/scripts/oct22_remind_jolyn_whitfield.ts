/**
 * 10/22 (Nic): "can you send for Country Acres in Mattoon a new reminder
 * signing email for Joe Lynn? I can't remember the last name. She's part of the
 * original batch that went out and has never signed."
 *
 * "Joe Lynn" is Jolyn Whitfield, MH 24 at Country Acres - Mattoon.
 *
 * ONE EMAIL, NOT NINE. Her packet is nine live documents — the lease, the
 * Mattoon installment contract and seven Illinois/federal disclosures — all
 * under one package_group_id. S652 (Nic): "he just wants one per packet", after
 * Blu got about fifty refreshed reminders. So this reminds on the LEASE, which
 * is the one the packet hangs off, and never loops the nine.
 *
 * It uses the same call the Remind button uses (routes/esign
 * POST /documents/:id/remind — emailSigningReminder, then the signer's
 * reminder bookkeeping), so nothing here is a second way to send a reminder.
 *
 * DRY RUN BY DEFAULT — prints who it would reach and sends nothing.
 *   cd apps/api && npx ts-node -T src/scripts/oct22_remind_jolyn_whitfield.ts
 *   cd apps/api && npx ts-node -T src/scripts/oct22_remind_jolyn_whitfield.ts --send
 */
import { query, queryOne } from '../db'

const PACKET = '56a7d39f-8994-4f7c-a0df-77975258f5bb'
const HER = 'whitfieldjolyn@icloud.com'

async function main() {
  const send = process.argv.includes('--send')

  const doc = await queryOne<any>(`
    SELECT d.id, d.title, d.status, u.property_id, u.unit_number,
           s.id AS signer_id, s.name, s.email, s.user_id, s.token, s.role,
           s.reminder_count, to_char(s.reminder_sent_at, 'YYYY-MM-DD HH24:MI') AS last_reminder
      FROM lease_documents d
      JOIN lease_document_signers s ON s.document_id = d.id AND LOWER(s.email) = $2
      LEFT JOIN units u ON u.id = d.unit_id
     WHERE d.package_group_id = $1
       AND d.status NOT IN ('voided', 'completed')
       AND s.status <> 'signed'
       AND d.title ILIKE 'Lease%'
     LIMIT 1`, [PACKET, HER])

  if (!doc) { console.log('\n  Nothing to remind — no unsigned lease in that packet.\n'); return }

  const packet = await query<{ title: string }>(
    `SELECT d.title FROM lease_documents d
      WHERE d.package_group_id = $1 AND d.status NOT IN ('voided','completed')
      ORDER BY d.created_at`, [PACKET])

  console.log(`\n  ${doc.name} · ${doc.email} · ${doc.unit_number ?? '(no site)'}`)
  console.log(`  Reminding on: ${doc.title}`)
  console.log(`  Her packet is ${packet.length} document(s); ONE email goes out, not ${packet.length}.`)
  console.log(`  Reminders already sent: ${doc.reminder_count}${doc.last_reminder ? ` · last ${doc.last_reminder}` : ''}`)

  if (!send) { console.log('\nDRY RUN — nothing sent. Re-run with --send.\n'); return }

  // The route's own helpers, exported rather than copied — S654's rule that a
  // resident is reached ONLY at the address on their own account is not a
  // thing to have two versions of.
  const { signerDeliveryAddress, signerReplyTo } = await import('../routes/esign')
  const { emailSigningReminder } = await import('../services/email')
  const { portalUrl } = await import('../lib/portalUrls')

  const sendTo = await signerDeliveryAddress(doc)
  if (!sendTo) { console.log('\n  No address on her account to send to.\n'); return }
  const signingUrl = `${portalUrl('landlord')}/sign/${doc.token || doc.id}`

  // documentCount makes this ONE email that covers the whole packet — the
  // email itself says "Documents" and the link walks her through the rest
  // (services/email emailSigningReminder, S652).
  const landlordName = (await queryOne<{ n: string }>(
    `SELECT COALESCE(NULLIF(btrim(l.business_name), ''), 'your landlord') AS n
       FROM lease_documents d JOIN landlords l ON l.id = d.landlord_id WHERE d.id = $1`,
    [doc.id]))?.n ?? 'your landlord'

  await emailSigningReminder(sendTo, doc.name, doc.title, doc.unit_number ?? '', landlordName, signingUrl,
    { landlordId: undefined, documentId: doc.id, documentCount: packet.length,
      replyTo: await signerReplyTo(doc, doc.property_id) })
  await query(
    `UPDATE lease_document_signers SET reminder_count = 0, reminder_sent_at = NOW() WHERE id = $1`,
    [doc.signer_id])
  console.log(`\n  Sent to ${sendTo}.\n`)
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })

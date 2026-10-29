/**
 * 10/17 (Nic): "Josh Roby at Oak Park needed a new link email for his other
 * lease. I guess he's finally going to sign that and try to get current on his
 * rent." Asked which, he said: fresh links for BOTH.
 *
 * Josh holds two active leases at Oak Park from 9/16, MH 03 and RV 27, both
 * still unsigned, and he owes on both ($465 on MH 03, $1,008 on RV 27). GAM
 * chased each one five times and stopped at the ceiling, so nothing is going
 * out any more: MH 03 he has opened, RV 27 he never has.
 *
 * This does exactly what the Remind button does (POST /esign/documents/:id/
 * remind): one email per document to the address on his own account, through
 * the same one-link rule (services/tenantLeaseLink), and reminder_count back
 * to 0 so the nightly chaser starts over.
 *
 *   npx ts-node -T src/scripts/oct17_josh_roby_fresh_links.ts           (dry run)
 *   npx ts-node -T src/scripts/oct17_josh_roby_fresh_links.ts --apply
 */
import { query, queryOne } from '../db'
import { emailSigningReminder } from '../services/email'
import { portalUrl } from '../lib/portalUrls'

const APPLY = process.argv.includes('--apply')
const JOSH = '7a771dab-cf2a-4a5c-870b-816653806b62'

async function main() {
  const rows = await query<any>(`
    SELECT d.id AS doc_id, d.title, d.landlord_id, u.property_id, u.unit_number, p.name AS property_name,
           s.id AS signer_id, s.name, s.role, s.user_id, s.token, s.status, s.reminder_count,
           s.viewed_at IS NOT NULL AS opened,
           (lu.first_name || ' ' || lu.last_name) AS landlord_name,
           (SELECT COALESCE(SUM(pay.amount), 0) FROM payments pay
             WHERE pay.unit_id = d.unit_id AND pay.status IN ('pending', 'failed')
               AND pay.work_trade_suspended_at IS NULL) AS owed
      FROM lease_document_signers s
      JOIN lease_documents d ON d.id = s.document_id
      LEFT JOIN units u ON u.id = d.unit_id
      LEFT JOIN properties p ON p.id = u.property_id
      JOIN landlords la ON la.id = d.landlord_id
      JOIN users lu ON lu.id = la.user_id
     WHERE s.user_id = $1 AND s.status IN ('sent', 'viewed')
       AND d.status NOT IN ('completed', 'voided', 'execution_failed')
     ORDER BY u.unit_number`, [JOSH])

  if (!rows.length) throw new Error('nothing of Josh\'s is waiting to be signed')

  for (const r of rows) {
    // The same rule the route uses (routes/esign signerDeliveryAddress): a
    // resident's copy goes to the address on their own account, never to
    // whatever was typed on the document.
    const sendTo = (await queryOne<{ email: string }>(
      `SELECT email FROM users WHERE id = $1`, [r.user_id]))!.email
    const unitLabel = r.unit_number ? `Unit ${r.unit_number} — ${r.property_name}` : r.title
    console.log(`${r.unit_number}: ${r.title}`)
    console.log(`  to ${sendTo} · reminded ${r.reminder_count} times already · ${r.opened ? 'he has opened it' : 'he has NEVER opened it'} · $${Number(r.owed).toFixed(2)} owed on that space`)
    if (!APPLY) { console.log('  would send a fresh link and reset the reminder count to 0\n'); continue }

    let signingUrl = `${portalUrl('landlord')}/sign/${r.token || r.doc_id}`
    let needsSetup = false
    const { tenantLeaseLink } = await import('../services/tenantLeaseLink')
    const link = await tenantLeaseLink({ userId: r.user_id, documentId: r.doc_id, signerToken: r.token, sendTo })
    signingUrl = link.url
    needsSetup = link.needsSetup
    await emailSigningReminder(sendTo, r.name, r.title, unitLabel, r.landlord_name, signingUrl,
      { landlordId: r.landlord_id, documentId: r.doc_id, needsSetup })
    await query(`UPDATE lease_document_signers SET reminder_count = 0, reminder_sent_at = NOW() WHERE id = $1`, [r.signer_id])
    console.log(`  sent, and the nightly chaser starts over\n`)
  }
  console.log(APPLY ? 'APPLIED' : 'DRY RUN — nothing sent (pass --apply)')
  process.exit(0)
}

main().catch(e => { console.error('FAILED:', e?.message ?? e); process.exit(1) })

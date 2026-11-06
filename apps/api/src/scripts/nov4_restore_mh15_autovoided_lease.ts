/**
 * 11/4 — PUT MH 15'S LEASE PAPERWORK BACK. IT WAS AUTO-VOIDED AFTER NIC SAID
 * NOT TO.
 *
 * Nic, earlier today: "I think we need to not void paperwork that has money
 * attached to it. So put the schedule back intact. Don't let it void again."
 *
 * The source was changed to do exactly that. It was never deployed: production
 * runs the Nov 3 16:32 build, whose scheduler still carries
 * "auto-voided: signers did not respond within 48 hours", and that job runs
 * every 15 minutes. At 19:45 today it voided
 *
 *   Lease — Unit MH 15 — Mountain View RV Ranch   (a2f30572…, original_lease)
 *
 * and emailed all three recipients to say so. The landlord had signed it on
 * 10/13; the resident had been asked the maximum five times and never signed,
 * so the resend path had nothing left to resend and fell through to the void —
 * the live build working as it was written, before Nic's instruction.
 *
 * WHAT THE VOID TOUCHED: one row. The change journal for 19:44–19:46 holds the
 * lease_documents row and nothing else — the lease is still active with all 37
 * of its charges, no home sale was unwound, no payment moved. So the repair is
 * the row, exactly as the journal recorded it before the void:
 *
 *   status 'voided' → 'in_progress',  voided_at → NULL,  void_reason → NULL
 *
 * WHAT THIS DOES NOT DO. It does not reset the resident's five asks: somebody
 * who has ignored five needs a phone call, not a sixth email, and resetting the
 * counter would also hand the live job a reason to resend. It does not stop the
 * job either — that is a deploy or the ESIGN_48H_CUTOVER brake, and both are
 * Nic's to call. Four more documents hit the same wall tomorrow afternoon.
 *
 * Scoped to this ONE document, and it refuses unless the row still reads exactly
 * as the auto-void left it. Dry run unless --apply.
 *
 *   cd ~/gam/apps/api && npx ts-node -T src/scripts/nov4_restore_mh15_autovoided_lease.ts
 *   cd ~/gam/apps/api && npx ts-node -T src/scripts/nov4_restore_mh15_autovoided_lease.ts --apply
 */
import { getClient } from '../db'

const DOCUMENT_ID = 'a2f30572-2b70-459f-aee9-a5f4514e1ffa'
const TITLE = 'Lease — Unit MH 15 — Mountain View RV Ranch'
const AUTO_VOID_REASON = 'auto-voided: signers did not respond within 48 hours'
const RESTORE_TO = 'in_progress'
const APPLY = process.argv.includes('--apply')

async function main() {
  const client = await getClient()
  try {
    const dbName = (await client.query<{ n: string }>('SELECT current_database() AS n')).rows[0].n
    console.log(`database: ${dbName}`)
    console.log(APPLY ? 'mode: APPLY' : 'mode: dry run (pass --apply to write)')

    await client.query('BEGIN')

    const d = (await client.query<any>(
      `SELECT id, title, document_type, status, voided_at::text AS voided_at, void_reason,
              lease_id, signing_window_restarted_at::text AS window_restarted
         FROM lease_documents WHERE id = $1 FOR UPDATE`, [DOCUMENT_ID])).rows[0]
    if (!d) throw new Error('that document does not exist here')
    if (d.title !== TITLE) throw new Error(`refusing: expected "${TITLE}", found "${d.title}"`)
    if (d.status !== 'voided' || d.voided_at === null) {
      throw new Error(`refusing: it is not voided any more (status ${d.status}) — somebody has already dealt with it`)
    }
    if (d.void_reason !== AUTO_VOID_REASON) {
      throw new Error(`refusing: this was not the 48-hour auto-void. Its reason reads "${d.void_reason}" — `
        + 'a void somebody made on purpose is not this script\'s to undo.')
    }

    // What the journal says it was, so the restore is the recorded state and
    // not a guess. The audit trigger wrote it when the void happened.
    const before = (await client.query<any>(
      `SELECT old_row->>'status' AS status, old_row->>'voided_at' AS voided_at, old_row->>'void_reason' AS void_reason
         FROM audit_row_changes
        WHERE table_name = 'lease_documents' AND row_id = $1
          AND new_row->>'void_reason' = $2
        ORDER BY changed_at DESC LIMIT 1`, [DOCUMENT_ID, AUTO_VOID_REASON])).rows[0]
    if (!before) throw new Error('refusing: the change journal has no record of this void to restore from')
    if (before.status !== RESTORE_TO || before.voided_at !== null || before.void_reason !== null) {
      throw new Error(`refusing: the journal says it was "${before.status}" / ${before.voided_at} / ${before.void_reason}, `
        + `which is not the state this script restores`)
    }
    console.log(`\n${d.title}`)
    console.log(`  now:     ${d.status}  (${d.void_reason})`)
    console.log(`  journal: ${before.status}  before the auto-void`)

    await client.query(
      `UPDATE lease_documents
          SET status = $2, voided_at = NULL, void_reason = NULL, updated_at = NOW()
        WHERE id = $1`, [DOCUMENT_ID, RESTORE_TO])

    const now = (await client.query<any>(
      `SELECT status, voided_at, void_reason FROM lease_documents WHERE id = $1`, [DOCUMENT_ID])).rows[0]
    console.log(`  after:   ${now.status}  voided_at ${now.voided_at}  reason ${now.void_reason}`)

    const signers = (await client.query<any>(
      `SELECT role, status, COALESCE(invite_resend_count, 0) AS asks
         FROM lease_document_signers WHERE document_id = $1 ORDER BY role`, [DOCUMENT_ID])).rows
    console.log('\nsigners (untouched):')
    for (const s of signers) console.log(`  ${s.role.padEnd(10)} ${s.status.padEnd(8)} ${s.asks} ask(s) sent`)

    const lease = (await client.query<any>(
      `SELECT l.status, l.start_date::text AS start_date,
              (SELECT COUNT(*) FROM payments p WHERE p.lease_id = l.id) AS charges
         FROM leases l WHERE l.id = $1`, [d.lease_id])).rows[0]
    if (lease) console.log(`\nthe lease behind it: ${lease.status}, from ${lease.start_date}, ${lease.charges} charge(s) — unchanged`)

    await client.query(APPLY ? 'COMMIT' : 'ROLLBACK')
    console.log(APPLY ? '\nCOMMITTED' : '\nrolled back (dry run)')
    if (APPLY) {
      console.log('\nThe live job still voids, and it runs every 15 minutes. This document is')
      console.log('eligible again the moment it is restored, so it needs the job stopped — a')
      console.log('deploy, or ESIGN_48H_CUTOVER set forward and the API restarted.')
    }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e?.message ?? e); process.exit(1) })

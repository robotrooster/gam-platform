/**
 * S652 (Nic): "repair the mobile home six lease. His agreement shouldn't be
 * paused… the space rent is ongoing. It never just stops."
 *
 * Blu signed Country Acres MH 06 and MH 17 on 9/22 with end dates already in
 * the past; the landlord's signature issued both, and that night's lease-end
 * job expired them, removed the residents, vacated the sites, drafted deposit
 * returns and wrote "tenancy ended" into the credit ledger. None of it
 * happened. This puts both tenancies back as what they are — ongoing,
 * month-to-month space rent — and marks the ledger entries as data-entry
 * errors superseded by the lease signing they never overrode.
 *     npx ts-node src/scripts/mattoon/load24_reinstate_leases.ts [--apply]
 */
import { getClient } from '../../db'
const APPLY = process.argv.includes('--apply')
const LEASES = ['adb21e73-43a7-4b88-a7c2-b96d87019ae5', '5ec24b82-25b9-4be4-9ed8-15514d65c486']
async function main() {
  const c = await getClient()
  try {
    await c.query('BEGIN')
    for (const leaseId of LEASES) {
      const l = (await c.query(`SELECT l.id, l.status, l.end_date, u.unit_number, u.id AS unit_id FROM leases l JOIN units u ON u.id=l.unit_id WHERE l.id=$1`, [leaseId])).rows[0]
      console.log(`${l.unit_number}: lease ${l.status}, ended ${l.end_date?.toISOString?.().slice(0,10) ?? l.end_date}`)
      await c.query(`UPDATE leases SET status='active', lease_type='month_to_month', end_date=NULL, terminated_at=NULL, updated_at=NOW() WHERE id=$1`, [leaseId])
      const lt = await c.query(`UPDATE lease_tenants SET status='active', removed_at=NULL, removed_reason=NULL, updated_at=NOW() WHERE lease_id=$1 AND removed_reason='lease_ended' RETURNING tenant_id`, [leaseId])
      console.log(`   ${lt.rowCount} resident(s) restored to the lease`)
      await c.query(`UPDATE units SET status='active', updated_at=NOW() WHERE id=$1 AND status='vacant'`, [l.unit_id])
      const dr = await c.query(`DELETE FROM deposit_returns WHERE lease_id=$1 AND status='draft' RETURNING id`, [leaseId])
      console.log(`   ${dr.rowCount} deposit-return draft(s) removed`)
      const wt = await c.query(`UPDATE work_trade_agreements SET status='active', updated_at=NOW() WHERE unit_id=$1 AND status='paused' AND paused_by_hibernation=FALSE AND tenant_id = ANY($2::uuid[]) RETURNING id`, [l.unit_id, lt.rows.map((r: any) => r.tenant_id)])
      if (wt.rowCount) console.log(`   work trade resumed`)
      // Ledger: the expiry's entries are data-entry errors; the signing stands.
      const bogus = await c.query(
        `SELECT e.id, e.subject_id, e.event_type FROM credit_events e
          WHERE e.event_type IN ('lease_terminated_natural','tenancy_ended_with_balance','balance_paid_post_move')
            AND e.event_data->>'lease_id' = $1 AND e.superseded_by IS NULL`, [leaseId])
      for (const b of bogus.rows) {
        const truth = (await c.query(
          `SELECT id FROM credit_events WHERE subject_id=$1 AND event_type='lease_signed' AND event_data->>'lease_id'=$2 ORDER BY occurred_at LIMIT 1`,
          [b.subject_id, leaseId])).rows[0]
        if (!truth) { console.log(`   ! no lease_signed event for subject ${b.subject_id}; ${b.event_type} left as is`); continue }
        await c.query(`UPDATE credit_events SET superseded_by=$2, superseded_reason='data_entry_error_corrected' WHERE id=$1`, [b.id, truth.id])
        console.log(`   ledger: ${b.event_type} superseded`)
      }
    }
    // MH 17's lease document still awaits Cameron: its end date must not read as already over.
    const f = await c.query(`UPDATE lease_document_fields SET value='-' WHERE id='1e9b2ddc-67f3-44d8-9a6c-1cce580b1ade' AND value='2/26/2026' RETURNING id`)
    console.log(`MH 17 lease document end date → "-" (month to month): ${f.rowCount ? 'done' : 'already'}`)
    await c.query(APPLY ? 'COMMIT' : 'ROLLBACK')
    console.log(APPLY ? 'APPLIED' : '(dry run — nothing written)')
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e } finally { c.release() }
}
main().then(() => process.exit(0), (e) => { console.error(e.message ?? e); process.exit(1) })

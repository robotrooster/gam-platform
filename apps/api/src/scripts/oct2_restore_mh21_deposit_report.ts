/**
 * S655 — put MH 21's $666.50 deposit report of 9/4 back to pending. ONE-TIME.
 *
 * Country Acres (TruBlu Management) has no bank feed linked. The nightly sweep
 * expired this report anyway on 9/26 as "not found in your landlord's bank
 * feed" — there was no feed to look in — and counted it as a strike against
 * the tenant. The sweep is fixed (jobs/declaredDepositExpiry.ts: a report only
 * expires once the company has an active link that synced past the report's
 * window). This undoes the one report it got wrong, which also removes the
 * strike, so MH 21's 10/1 $815.00 report can no longer be the "second strike"
 * that sends Blu a "repeated reports have not matched" alert.
 *
 * RUN IT AFTER THE CODE DEPLOY. On the build running today the sweep would
 * expire it again the next morning at 3:40am Phoenix (9/4 is long past the
 * 7-day window).
 *
 * The tenant was told on 9/26 that their deposit could not be found; that
 * notice stays (GAM keeps everything). Nothing was ever credited by the report,
 * so no balance moves.
 *
 * DRY RUN BY DEFAULT. DRY=0 applies.
 *   cd apps/api && npx ts-node -T src/scripts/oct2_restore_mh21_deposit_report.ts
 *   cd apps/api && DRY=0 npx ts-node -T src/scripts/oct2_restore_mh21_deposit_report.ts
 */
import { getClient } from '../db'

const DECLARATION_ID = '42eac0cb-b0b5-4962-9820-2e4c1c3e5801'

;(async () => {
  const apply = process.env.DRY === '0'
  const c = await getClient()
  try {
    await c.query('BEGIN')
    const d = (await c.query(
      `SELECT d.id, d.status, d.amount::text AS amount, d.declared_date::text AS declared_date,
              d.resolution_note, d.bank_transaction_id, d.tenant_id, l.business_name,
              (SELECT count(*)::int FROM bank_connections c WHERE c.landlord_id = d.landlord_id AND c.status = 'active') AS active_links,
              (SELECT count(*)::int FROM tenant_declared_deposits x WHERE x.tenant_id = d.tenant_id AND x.status = 'unconfirmed') AS strikes
         FROM tenant_declared_deposits d JOIN landlords l ON l.id = d.landlord_id
        WHERE d.id = $1 FOR UPDATE OF d`, [DECLARATION_ID])).rows[0]
    if (!d) throw new Error('Report not found.')
    console.log(`Report: ${d.business_name}, $${d.amount} declared ${d.declared_date}, status ${d.status}; ` +
      `tenant strikes now ${d.strikes}; active bank links ${d.active_links}`)
    if (d.status !== 'unconfirmed' || d.amount !== '666.50' || d.declared_date !== '2026-09-04' || d.bank_transaction_id) {
      throw new Error('The report is not in the state this fix was written for — nothing changed.')
    }
    if (d.active_links > 0) {
      console.log('NOTE: the company now has a linked bank. Restoring is still right — the report expired with no feed to check —\n' +
        '      but once that link has synced past 9/11 the fixed sweep will judge it again.')
    }

    await c.query(
      `UPDATE tenant_declared_deposits
          SET status = 'pending', resolution_note = NULL, updated_at = NOW()
        WHERE id = $1 AND status = 'unconfirmed'`, [DECLARATION_ID])
    const after = (await c.query(
      `SELECT count(*)::int AS n FROM tenant_declared_deposits WHERE tenant_id = $1 AND status = 'unconfirmed'`,
      [d.tenant_id])).rows[0].n
    console.log(`→ pending again; tenant strikes ${d.strikes} → ${after}`)

    if (apply) { await c.query('COMMIT'); console.log('APPLIED') }
    else { await c.query('ROLLBACK'); console.log('DRY RUN — rolled back. DRY=0 to apply.') }
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {})
    console.error(e instanceof Error ? e.message : e)
    process.exitCode = 1
  } finally {
    c.release()
    process.exit()
  }
})()

/**
 * 10/29 — ONE-OFF: create the security_deposits record for MH 28 at Country
 * Acres - Mattoon, which signed on 10/28 and never got one.
 *
 * The signing path was the only writer of a deposit amount that never called
 * syncSecurityDepositRow (fixed in routes/esign.ts the same day). MH 28 is the
 * first and only lease that fell through: the platform had ZERO deposit records
 * in it, so its $450 due 11/01 would have settled with nothing recording that
 * it was held, no holder, no interest accrual, and nothing on Deposits held.
 *
 * Runs the real sync rather than hand-written SQL, so the holder is resolved by
 * the same S604 custody gate every other lease goes through — which, for
 * Illinois, means the LANDLORD holds it (765 ILCS 745/18; GAM's vehicle is
 * recorded `blocked`/`vehicle_unconfirmed` there).
 *
 * Idempotent: the sync upserts and leaves an enrolled or funded row alone.
 * Scoped to one named lease — never a sweep.
 */
import { db, queryOne } from '../db'
import { syncSecurityDepositRow } from '../services/leaseFeesSync'

const LEASE_ID = '45e021a1-a044-400f-a50a-197e69c767e9'

async function main() {
  const fee = await queryOne<{ amount: string; unit_number: string; property: string }>(
    `SELECT lf.amount::text AS amount, u.unit_number, p.name AS property
       FROM lease_fees lf
       JOIN leases l ON l.id = lf.lease_id
       JOIN units u ON u.id = l.unit_id
       JOIN properties p ON p.id = u.property_id
      WHERE lf.lease_id = $1 AND lf.fee_type = 'security_deposit'
        AND lf.due_timing = 'move_in'
      LIMIT 1`, [LEASE_ID])
  if (!fee) throw new Error(`No move-in security deposit fee on lease ${LEASE_ID}`)
  if (fee.property !== 'Country Acres - Mattoon' || fee.unit_number !== 'MH 28') {
    throw new Error(`Refusing: expected Country Acres - Mattoon / MH 28, got ${fee.property} / ${fee.unit_number}`)
  }

  await syncSecurityDepositRow(LEASE_ID, Number(fee.amount))

  const row = await queryOne<any>(
    `SELECT id, total_amount::text AS total, collected_amount::text AS collected,
            status, held_by, flex_deposit_enabled
       FROM security_deposits WHERE lease_id = $1 AND status <> 'voided'`, [LEASE_ID])
  console.log(`${fee.property} / ${fee.unit_number}:`, row)
  await db.end()
}

main().catch(e => { console.error(e); process.exit(1) })

/**
 * S654 — four prepaid-credit releases this morning booked a payout to the
 * landlord for money GAM never held.
 *
 * Nic: "Glenda Greek and Todd Niemeyer also paid by check… Mark Rensberger…
 * he's not paid with card ever. Why is that saying that that's going to be
 * dispersed to our account? That's a huge problem."
 *
 * The credits were funded by checks the landlord already has (Greek: a check
 * remittance; Niemeier, Renspurger, Rader: credit entered by the landlord).
 * The release settled the October rows correctly but stamped them
 * platform_held and booked an allocation_owner_share, so Tuesday's batch would
 * have paid the landlord again out of GAM's Stripe balance.
 *
 * Fix: platform_held=false on those rows, the four owner-share ledger rows
 * removed. The rows stay settled (the tenant did pay — by check, to the
 * landlord). The rule itself is fixed in services/prepaidRelease.ts.
 *
 * DRY=1 prints and rolls back.
 */
import { getClient } from '../db'

;(async () => {
  const dry = process.env.DRY === '1'
  const c = await getClient()
  try {
    await c.query('BEGIN')
    const { rows } = await c.query<any>(
      `SELECT p.id AS payment_id, us.last_name, p.amount, p.platform_held,
              (SELECT json_agg(json_build_object('id', l.id, 'type', l.type, 'amount', l.amount))
                 FROM user_balance_ledger l WHERE l.reference_id = p.id AND l.reference_type = 'payment') AS ledger
         FROM payments p
         JOIN lease_prepaid_credit_draws d ON d.billing_month = '2026-10-01' AND d.lease_id = p.lease_id
         JOIN lease_prepaid_credits cr ON cr.id = d.credit_id
         LEFT JOIN tenant_remittances rm ON rm.id = cr.source_remittance_id
         LEFT JOIN payments sp ON sp.id = cr.source_payment_id
         JOIN tenants t ON t.id = p.tenant_id JOIN users us ON us.id = t.user_id
        WHERE p.settled_at >= '2026-10-01' AND p.status = 'settled' AND p.notes ILIKE '%prepaid credit%'
          AND NOT ((rm.payment_method IN ('ach','card') AND rm.stripe_payment_intent_id IS NOT NULL) OR COALESCE(sp.platform_held, false))
        GROUP BY p.id, us.last_name`)
    for (const r of rows) {
      console.log(`${r.last_name}: $${r.amount} platform_held=${r.platform_held} ledger=${JSON.stringify(r.ledger)}`)
      await c.query(`UPDATE payments SET platform_held = false, notes = notes || ' (collected by the landlord, not GAM)' WHERE id = $1 AND platform_held = true`, [r.payment_id])
      const del = await c.query(`DELETE FROM user_balance_ledger WHERE reference_id = $1 AND reference_type = 'payment' AND type = 'allocation_owner_share' RETURNING id`, [r.payment_id])
      console.log(`   → platform_held=false, ${del.rowCount} owner-share ledger row(s) removed`)
    }
    if (dry) { await c.query('ROLLBACK'); console.log('DRY RUN — rolled back') }
    else { await c.query('COMMIT'); console.log('COMMITTED') }
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error(e); process.exit(1) }
  finally { c.release(); process.exit(0) }
})()

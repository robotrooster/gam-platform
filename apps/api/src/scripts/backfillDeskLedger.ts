/**
 * S652 (Nic) — past desk payments into the credit ledger, GOOD MARKS ONLY.
 *
 * Until deploy 58 only Stripe settlements wrote to the credit ledger; cash,
 * check and money-order payments recorded at the front desk were invisible.
 * Nic: "it needs to count every payment method"; "don't count the onboarding
 * month for anything negative, only positive"; "tenants that would gain a late
 * mark should really only be nobody this month."
 *
 * So: every desk-recorded rent/utility settlement paid on time or within grace
 * gets its event (on_time / late_grace, landlord-attested). Late ones are
 * skipped entirely — no negative event from the past. Prior-arrangement
 * history is not a payment and is skipped.
 *     npx ts-node -r dotenv/config --transpile-only src/scripts/backfillDeskLedger.ts [--apply]
 */
import { getClient } from '../db'
import { emitPaymentSettledEvent, classifyPaymentTier } from '../services/creditLedgerEmitters'

const APPLY = process.argv.includes('--apply')

async function main() {
  const c = await getClient()
  try {
    await c.query('BEGIN')
    const { rows } = await c.query<any>(`
      SELECT p.id, p.tenant_id, p.type, p.amount, p.due_date, p.settled_at, p.manual_method,
             COALESCE(l.late_fee_grace_days, 5) AS grace,
             u.first_name || ' ' || u.last_name AS tenant
        FROM payments p
        JOIN tenants t ON t.id = p.tenant_id JOIN users u ON u.id = t.user_id
        LEFT JOIN leases l ON l.id = p.lease_id
       WHERE p.status = 'settled' AND p.manual_method IS NOT NULL AND p.manual_method <> 'prior_arrangement'
         AND p.type IN ('rent','utility') AND p.due_date IS NOT NULL AND p.settled_at IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM credit_events ce WHERE ce.event_data->>'payment_id' = p.id::text)
       ORDER BY p.settled_at`)
    let good = 0, skipped = 0
    for (const r of rows) {
      const tier = classifyPaymentTier({ dueDate: new Date(r.due_date), settledAt: new Date(r.settled_at), graceDays: Number(r.grace) })
      if (tier !== 'payment_received_on_time' && tier !== 'payment_received_late_grace') { skipped++; continue }
      await emitPaymentSettledEvent(c, {
        tenantId: r.tenant_id, paymentId: r.id, paymentType: r.type, amount: r.amount,
        dueDate: new Date(r.due_date), settledAt: new Date(r.settled_at), graceDays: Number(r.grace),
        stripePaymentIntentId: null, attestationSource: 'landlord_self_reported_with_evidence',
        attestationEvidence: { manual_method: r.manual_method, backfilled: true },
      })
      good++
      console.log(`  + ${r.tenant.padEnd(26)} ${r.type.padEnd(8)} due ${String(r.due_date).slice(0, 10)} paid ${String(r.settled_at).slice(0, 10)}  ${tier}`)
    }
    console.log(`\n${good} good marks written, ${skipped} late desk payments left out (nothing negative from the past) — ${APPLY ? 'APPLIED' : 'dry run'}`)
    await c.query(APPLY ? 'COMMIT' : 'ROLLBACK')
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e } finally { c.release() }
}
main().then(() => process.exit(0), e => { console.error(e); process.exit(1) })

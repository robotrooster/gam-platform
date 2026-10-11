/**
 * S655 money plan P5 (Step 5, item L) — "a bank is waiting" for banks already
 * waiting at deploy. ONE-TIME.
 *
 * Keep the old bank: adding a bank no longer turns tenants.ach_verified off, so
 * the verification nudge now selects by tenants.bank_pending_since (set at
 * confirm-setup from the deploy on). Banks that were ALREADY waiting on their
 * microdeposits when the code shipped have no flag. This sets it.
 *
 * The plan said "bank_pending_since = now() for every tenant with a Stripe
 * customer and no verified bank (18), and let the nudge's own Stripe check clear
 * the rest". This asks Stripe first instead, so the flag lands only on a bank
 * Stripe is really waiting on, dated when that setup started. It also corrects
 * the other half of the same definition: ach_verified now means "has a verified
 * bank", so a row that says no while Stripe holds a verified bank (a webhook
 * that never arrived) is turned on, with bank_last4 naming that bank. A row that
 * says verified while Stripe shows no verified bank is only REPORTED — that is
 * for a person to look at, never for a script to undo.
 *
 * One exception to turning it on: a tenant an ACH return blocked (NACHA zero
 * tolerance, a 'zero_tolerance_block' row in ach_monitoring_log or its archive)
 * whose block is not carried in tenants.ach_suspended_at. Before the deploy,
 * handle-return wrote the block as ach_verified = FALSE and nothing else, so
 * turning it on would quietly lift the block. Those rows are left off and
 * printed as CHECK lines for a person.
 *
 * RUN AFTER migration 20261003100600_tenant_bank_pending_and_suspension is
 * applied and the code is deployed (checked below). Stripe is only read; the
 * database changes in one transaction.
 *
 * DRY RUN BY DEFAULT. DRY=0 applies.
 *   cd apps/api && npx ts-node -T src/scripts/oct3_bank_pending_since_backfill.ts
 *   cd apps/api && DRY=0 npx ts-node -T src/scripts/oct3_bank_pending_since_backfill.ts
 */
import { getClient } from '../db'
import {
  readStripeMethodFacts,
  planBankBackfill,
  type BankBackfillPlan,
  type BankBackfillRow,
} from '../services/tenantBankMethods'

interface Row extends BankBackfillRow {
  stripe_customer_id: string
  name: string
}

;(async () => {
  const apply = process.env.DRY === '0'
  const c = await getClient()
  try {
    const col = await c.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = 'tenants' AND column_name = 'bank_pending_since'`)
    if (!col.rowCount) {
      throw new Error('Migration 20261003100600_tenant_bank_pending_and_suspension is not applied — run it first.')
    }

    const rows = (await c.query<Row>(
      `SELECT t.id, t.stripe_customer_id, t.ach_verified, t.bank_pending_since, t.bank_last4,
              t.ach_suspended_at,
              (SELECT max(b.created_at) FROM (
                  SELECT created_at FROM ach_monitoring_log
                   WHERE tenant_id = t.id AND event_type = 'zero_tolerance_block'
                  UNION ALL
                  SELECT created_at FROM ach_monitoring_log_archive
                   WHERE tenant_id = t.id AND event_type = 'zero_tolerance_block') b
              ) AS zero_tolerance_blocked_at,
              trim(coalesce(u.first_name, '') || ' ' || coalesce(u.last_name, '')) AS name
         FROM tenants t JOIN users u ON u.id = t.user_id
        WHERE t.stripe_customer_id IS NOT NULL
        ORDER BY u.last_name, u.first_name, t.id`)).rows
    console.log(`${rows.length} tenant(s) with a Stripe customer.`)

    // Stripe first, outside any transaction: a slow or failed lookup must not
    // hold locks, and a tenant Stripe could not answer for is left alone.
    const plans: { row: Row; plan: BankBackfillPlan }[] = []
    let unreadable = 0
    for (const row of rows) {
      try {
        const facts = await readStripeMethodFacts(row.stripe_customer_id, { strict: true })
        plans.push({ row, plan: planBankBackfill(row, facts) })
      } catch (e: any) {
        unreadable++
        console.log(`SKIP  ${row.name} (${row.id}): Stripe could not be read — ${e?.message ?? e}`)
      }
    }

    let pendingSet = 0, pendingCleared = 0, verifiedSet = 0, warned = 0, blocked = 0
    await c.query('BEGIN')
    for (const { row, plan } of plans) {
      // First, so correcting ach_verified below can never lift the block.
      if (plan.carrySuspension) {
        blocked++
        console.log(`${apply ? 'BLOCK' : 'WOULD BLOCK'} ${row.name} (${row.id}): an ACH return blocked bank payments on ${plan.carrySuspension.toISOString()} (NACHA zero tolerance) — carried into its own column, bank payments stay stopped.`)
        await c.query(`UPDATE tenants SET ach_suspended_at = COALESCE(ach_suspended_at, $2) WHERE id = $1`, [row.id, plan.carrySuspension])
      }
      if (plan.pendingSince !== undefined) {
        if (plan.pendingSince) {
          pendingSet++
          console.log(`${apply ? 'SET  ' : 'WOULD SET  '} ${row.name}: a bank is waiting on its deposits since ${plan.pendingSince.toISOString()}`)
        } else {
          pendingCleared++
          console.log(`${apply ? 'CLEAR' : 'WOULD CLEAR'} ${row.name}: no bank is waiting on its deposits`)
        }
        await c.query(`UPDATE tenants SET bank_pending_since = $2 WHERE id = $1`, [row.id, plan.pendingSince])
      }
      if (plan.markVerified) {
        verifiedSet++
        console.log(`${apply ? 'VERIFY' : 'WOULD VERIFY'} ${row.name}: Stripe holds a verified bank ••${plan.markVerified.last4 ?? '????'}; ach_verified was off`)
        await c.query(
          `UPDATE tenants SET ach_verified = TRUE, bank_last4 = $2, bank_routing_last4 = $3,
                  bank_verify_nudge_count = 0, bank_verify_nudge_at = NULL
            WHERE id = $1 AND ach_verified = FALSE`,
          [row.id, plan.markVerified.last4, plan.markVerified.routingLast4])
      }
      if (plan.warnVerifiedWithoutBank) {
        warned++
        console.log(`CHECK ${row.name} (${row.id}): marked bank-verified, but Stripe shows no verified bank. Not changed — look at it by hand.`)
      }
    }
    if (apply) await c.query('COMMIT')
    else await c.query('ROLLBACK')

    console.log(
      `${apply ? 'Done.' : 'DRY RUN — nothing changed.'} ` +
      `waiting flag set ${pendingSet}, cleared ${pendingCleared}; bank-verified turned on ${verifiedSet}; ` +
      `to check by hand ${warned + blocked} (${blocked} blocked by an ACH return); Stripe unreadable ${unreadable}.`)
    process.exit(0)
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {})
    console.error(e)
    process.exit(1)
  } finally {
    c.release()
  }
})()

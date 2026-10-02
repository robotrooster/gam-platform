/**
 * S655 — record which transfers each existing payout carried. ONE-TIME BACKFILL.
 *
 * From now on GAM records it the moment a payout is fired (jobs/autoPayouts.ts)
 * or filed from Stripe (services/connectPayoutSync.ts). The payouts made before
 * that have nothing linked, so their bank rows and Payouts-page entries cannot
 * list the payments inside them. Needs migration
 * 20261002172200_payout_transfer_link applied first (checked below).
 *
 * Rebuilds the link with the same rule the live code uses
 * (services/payoutComposition.stampPayoutTransfers), payout by payout, OLDEST
 * FIRST. Each payout looks at its Connect account's transfers that landed
 * before it, after the account's previous GAM sweep, and are not yet in an
 * earlier payout. GAM's own sweeps (auto_friday / catch_up) pay out the whole
 * balance, so they take every one of those transfers; a payout made in the
 * Stripe dashboard takes them oldest first, while they fit.
 *
 * Production, verified read-only (exact sums):
 *   65d0a4a4 $2,638.11 (9/10)  ← 9450b8c1 $589.00 + 201b3a4a $2,049.11
 *   e63b202c $4,154.89 (9/21)  ← c05a3c73 $4,154.89
 *   c355293e   $413.00 (9/21)  ← 5c65eec4 $413.00 (RV 48 rent $495 less $82 of GAM charges)
 *   a448278d   $14.07 register sale (9/30) — in no September payout (the next payout carries it).
 * The script refuses to commit if production's result differs from that.
 *
 * RUN ORDER — this is not "any time after the migration":
 *   1. migration 20261002172200_payout_transfer_link
 *   2. this script, DRY, then DRY=0
 *   3. the code deploy
 * Running it BEFORE the deploy is safe: the running build never reads or writes
 * platform_transfer_intents.disbursement_id. After the deploy, the new code
 * links every payout it fires or hears about (Tuesday's run, a payout made in
 * the Stripe dashboard, the nightly sync) to the transfers waiting before it,
 * and with September's payouts unlinked, "waiting" would include rent September
 * already paid out. The live code guards against that too: it never takes a
 * transfer older than the account's last GAM sweep (stampPayoutTransfers), so
 * on production's data a new payout claims only a448278d and later transfers
 * even if this has not run. Run it first anyway — until it runs, September's
 * payouts list nothing on the bank row or the Payouts page.
 * If a payout lands between steps 2 and 3, run this again just before the
 * deploy: it only touches payouts with nothing linked, so a second run links
 * the new one and leaves the verified mapping alone.
 * After the deploy the nightly payout sync (services/connectPayoutSync.ts) also
 * re-records any payout that did not fail and still has nothing linked, with
 * this same rule, oldest payout first — the net under a recording that failed.
 * That is not a substitute for this script: it raises an admin notice for any
 * payout that does not tie out, and it never checks production's result
 * against the verified mapping above.
 *
 * DRY RUN BY DEFAULT. DRY=0 applies (one transaction).
 *   cd apps/api && npx ts-node -T src/scripts/oct2_payout_transfer_backfill.ts
 *   cd apps/api && DRY=0 npx ts-node -T src/scripts/oct2_payout_transfer_backfill.ts
 */
import { getClient } from '../db'
import { stampPayoutTransfers } from '../services/payoutComposition'

// disbursement → transfers it must end up with, where those rows exist.
const EXPECTED: Record<string, string[]> = {
  '65d0a4a4-b146-4595-928b-66eb2d46157c': ['9450b8c1-792a-4234-8c2c-8af8cfdf6e18', '201b3a4a-8713-49a8-885a-c59a4d9bf2af'],
  'e63b202c-e6c4-49c1-ac7d-1f7fd2311c32': ['c05a3c73-5a1c-4bb7-9c35-43d566c1650e'],
  'c355293e-bb00-41fe-935f-54fecb87ce94': ['5c65eec4-32f9-4990-afeb-a6bf3417850d'],
}
const STAYS_UNLINKED = ['a448278d-c1bd-4b53-8e05-f9f0abae6288']

;(async () => {
  const apply = process.env.DRY === '0'
  const c = await getClient()
  try {
    await c.query('BEGIN')
    const col = await c.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = 'platform_transfer_intents' AND column_name = 'disbursement_id'`)
    if (!col.rowCount) throw new Error('Migration 20261002172200_payout_transfer_link is not applied — run it first.')

    // Every payout with nothing linked yet, oldest first, with the account it
    // swept. A failed payout carried nothing.
    const payouts = (await c.query(
      `SELECT d.id, d.amount::float AS amount, d.status, d.trigger_type,
              COALESCE(d.initiated_at, d.created_at) AS payout_at,
              COALESCE((SELECT l.stripe_connect_account_id FROM landlords l WHERE l.id = d.landlord_id),
                       (SELECT u.stripe_connect_account_id FROM users u WHERE u.id = d.user_id)) AS account
         FROM disbursements d
        WHERE d.stripe_payout_id IS NOT NULL
          AND d.status <> 'failed'
          AND NOT EXISTS (SELECT 1 FROM platform_transfer_intents i WHERE i.disbursement_id = d.id)
        ORDER BY COALESCE(d.initiated_at, d.created_at), d.created_at`)).rows

    let linked = 0
    for (const p of payouts) {
      if (!p.account) { console.log(`  ${p.id} $${p.amount.toFixed(2)} — no Connect account on file, skipped`); continue }
      const r = await stampPayoutTransfers({
        disbursementId: p.id, connectAccountId: p.account, payoutAmount: p.amount,
        payoutAt: new Date(p.payout_at), client: c, notifyOnGap: false,
        // A dry run is rolled back: it logs no take-back that never happened.
        trial: !apply,
      })
      linked += r.intentIds.length
      console.log(`  ${new Date(p.payout_at).toLocaleDateString('en-CA', { timeZone: 'America/Phoenix' })} ${p.id} $${p.amount.toFixed(2)} (${p.trigger_type}, ${p.status})` +
        ` ← ${r.intentIds.length} transfer(s) $${r.transfersTotal.toFixed(2)}${r.residual ? `  ⚠ $${r.residual.toFixed(2)} not traced` : ''}`)
    }
    console.log(`Transfers linked: ${linked}`)

    // Production guard: the result must be the verified one.
    for (const [disb, intents] of Object.entries(EXPECTED)) {
      const exists = await c.query(`SELECT 1 FROM disbursements WHERE id = $1`, [disb])
      if (!exists.rowCount) continue
      const got = (await c.query(
        `SELECT id FROM platform_transfer_intents WHERE disbursement_id = $1 ORDER BY id`, [disb])).rows.map((r: any) => r.id)
      if (JSON.stringify(got) !== JSON.stringify([...intents].sort())) {
        throw new Error(`Payout ${disb} would carry ${JSON.stringify(got)}, expected ${JSON.stringify(intents)}. Rolled back.`)
      }
    }
    // Not in any September payout. A payout made after it (October onward,
    // filed by the new code or by a second run of this) may carry it.
    const strays = (await c.query(
      `SELECT id FROM platform_transfer_intents WHERE id = ANY($1::uuid[]) AND disbursement_id = ANY($2::uuid[])`,
      [STAYS_UNLINKED, Object.keys(EXPECTED)])).rows
    if (strays.length) throw new Error(`${strays.map((r: any) => r.id).join(', ')} landed after every September payout and cannot be in one. Rolled back.`)

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

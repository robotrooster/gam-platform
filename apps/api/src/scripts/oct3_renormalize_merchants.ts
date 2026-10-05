/**
 * S655 money plan P7 (Step 12) — re-key every bank row's payer. ONE-TIME.
 *
 * services/bankFeed.normalizeMerchant now drops every word with a digit in it
 * (a reference, a store number, a date). Under the old rule each Square payout
 * was its own payer ("SQUARE INC SQ261001 T3H80F2ZQ67M"), so nothing learned
 * from one deposit could apply to the next, and auto-filing (K-D) could never
 * recognize the second deposit from a payer. This recomputes
 * bank_transactions.normalized_merchant from each row's own bank wording, and
 * re-keys landlord_merchant_rules (0 rules on 10/3) the same way.
 *
 * Nothing about what a row IS changes: no status, no filing, no amount — only
 * the payer key. A rule whose new key would collide with another rule of the
 * same company is not merged by a script: it is printed and the run refuses
 * (a person decides which choice to keep).
 *
 * RUN AFTER the Step 12 code is deployed (the new normalizer must be the one
 * the sync writes with) and BEFORE oct3_square_payouts_mountain_view.ts.
 *
 * DRY RUN BY DEFAULT. DRY=0 applies (one transaction).
 *   cd apps/api && npx ts-node -T src/scripts/oct3_renormalize_merchants.ts
 *   cd apps/api && DRY=0 npx ts-node -T src/scripts/oct3_renormalize_merchants.ts
 */
import { getClient } from '../db'
import { normalizeMerchant } from '../services/bankFeed'

;(async () => {
  const apply = process.env.DRY === '0'
  const c = await getClient()
  try {
    await c.query('BEGIN')
    const col = await c.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = 'landlord_merchant_rules' AND column_name = 'last_direction'`)
    if (!col.rowCount) throw new Error('Migration 20261003100900_bank_income_auto_file is not applied — run it first.')

    // ── Bank rows ────────────────────────────────────────────────────────────
    const rows = (await c.query<{ id: string; landlord: string | null; description: string | null; normalized_merchant: string | null }>(
      `SELECT t.id, l.business_name AS landlord, t.description, t.normalized_merchant
         FROM bank_transactions t JOIN landlords l ON l.id = t.landlord_id
        ORDER BY l.business_name, t.posted_date, t.id FOR UPDATE OF t`)).rows
    const changes = rows
      .map(r => ({ ...r, next: normalizeMerchant(r.description) }))
      .filter(r => (r.normalized_merchant ?? '') !== r.next)
    console.log(`${rows.length} bank row(s); ${changes.length} get a new payer key.`)
    const byMove = new Map<string, number>()
    for (const r of changes) {
      const k = `${r.landlord ?? '(no name)'}: "${r.normalized_merchant ?? ''}" → "${r.next}"`
      byMove.set(k, (byMove.get(k) ?? 0) + 1)
    }
    for (const [k, n] of [...byMove.entries()].sort()) console.log(`    ${n} × ${k}`)
    for (const r of changes) {
      await c.query(`UPDATE bank_transactions SET normalized_merchant = $2 WHERE id = $1`, [r.id, r.next])
    }

    // ── Payer rules ──────────────────────────────────────────────────────────
    const rules = (await c.query<{ id: string; landlord_id: string; normalized_merchant: string }>(
      `SELECT id, landlord_id, normalized_merchant FROM landlord_merchant_rules ORDER BY landlord_id, id FOR UPDATE`)).rows
    const nextKey = new Map(rules.map(r => [r.id, normalizeMerchant(r.normalized_merchant)]))
    const seen = new Map<string, string>()
    const collisions: string[] = []
    for (const r of rules) {
      const k = `${r.landlord_id}|${nextKey.get(r.id)}`
      if (seen.has(k)) collisions.push(`    rules ${seen.get(k)} and ${r.id} would both become "${nextKey.get(r.id)}"`)
      else seen.set(k, r.id)
    }
    console.log(`${rules.length} payer rule(s).`)
    if (collisions.length) {
      collisions.forEach(x => console.log(x))
      throw new Error(`${collisions.length} payer rule(s) would collide. Decide which to keep, then run again. Nothing changed.`)
    }
    let reKeyed = 0
    for (const r of rules) {
      const k = nextKey.get(r.id)!
      if (k === r.normalized_merchant) continue
      if (!k) {
        console.log(`    rule ${r.id} ("${r.normalized_merchant}") would have no payer left — left as it is`)
        continue
      }
      await c.query(`UPDATE landlord_merchant_rules SET normalized_merchant = $2, updated_at = now() WHERE id = $1`, [r.id, k])
      console.log(`    rule ${r.id}: "${r.normalized_merchant}" → "${k}"`)
      reKeyed++
    }
    console.log(`  → ${changes.length} bank row(s) and ${reKeyed} rule(s) re-keyed.`)

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

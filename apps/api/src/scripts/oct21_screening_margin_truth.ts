/**
 * 10/21 (Nic) — THE $14.75 THE BOOKS GAVE TO CHECKR AND GAM ACTUALLY KEPT.
 *
 *   "We're not going to refund the $2.95 a piece. We're just going to correct
 *    it going forward to actually order the scan."
 *   "Yeah, correct the 1475 to just be extra income for GAM."
 *
 * WHAT HAPPENED
 *   Every applicant's price was built on an ID scan the orders never asked for
 *   (services/backgroundProvider — the code that asks landed four hours after
 *   the last of these five orders went out) and that the Checkr property had
 *   switched off. Five people paid $44.99. Checkr invoiced $34.99 each, one
 *   line, "Essential Tenant Screening package", no add-on — the September
 *   receipts say so in black and white.
 *
 *   The books never saw it. A screening's split is derived, not stored:
 *   whatever the applicant paid, less GAM's $5 and the card fee, is treated as
 *   Checkr's. So each of these five put $37.94 aside for an invoice of $34.99.
 *   $2.95 apiece, $14.75 in all, sitting in a bucket marked "owed to Checkr"
 *   that is really GAM's own money.
 *
 *   Nobody is being refunded — Nic's call — so the money is GAM's and the book
 *   should say GAM's. That is the whole of this script.
 *
 * WHAT IT DOES
 *   For each of those checks, raises its screening_margin (and the check's own
 *   platform_net) from the flat $5 to what GAM really kept:
 *
 *       charged $44.99 - card fee $2.05 - Checkr's invoice $34.99 = $7.95
 *
 *   The banking_spread row is left exactly as it is: a card fee really was
 *   charged on top of these five, and 49c of it really was GAM's spread over
 *   Stripe's cost. Nothing about that changed. Only the share that was called
 *   Checkr's moves, and it moves to the one place it belongs.
 *
 *   After this, services/stripeCosts derives checkr_held = 44.99 - (7.95 +
 *   2.05) = $34.99 — Checkr's actual invoice — for every one of them.
 *
 * WHAT IT REFUSES
 *   Anything it cannot prove. A check whose report shows identity_verification
 *   actually ran was invoiced $38.94, not $34.99, and is left alone. So is one
 *   that was refunded, one charged anything other than $44.99, one with no
 *   banking_spread row to read the card fee from, and one whose margin is not
 *   still the flat $5 (already corrected, or never the old shape).
 *
 * DRY RUN BY DEFAULT — reads production, writes nothing (it runs fine with
 * default_transaction_read_only on), printing every row it would change.
 *   cd apps/api && npx ts-node -T src/scripts/oct21_screening_margin_truth.ts
 *   cd apps/api && npx ts-node -T src/scripts/oct21_screening_margin_truth.ts --apply
 */
import type { PoolClient } from 'pg'
import { getClient } from '../db'
import { CHECKR_ID_SCAN_ADD_ON } from '../services/backgroundProvider'

/**
 * What Checkr invoiced per report while the ID scan was never ordered — read
 * off the September receipts (orders ord_eO03X8uvQ2iFvXNOK-ix8A and
 * ord_eYGxNbEzRx2fxW2h7VLigA), both one line, "Essential Tenant Screening
 * package", $34.99, total $34.99.
 */
export const CHECKR_ESSENTIAL_ONLY_USD = 34.99
/** What an applicant was charged while the price was built on a $2.95 add-on. */
export const OLD_APPLICANT_PRICE_USD = 44.99
/** The flat margin the old model booked on every screening. */
export const OLD_FLAT_MARGIN_USD = 5

type Q = Pick<PoolClient, 'query'>
const round2 = (n: number) => Math.round(n * 100) / 100

export interface MarginFix {
  backgroundCheckId: string
  ledgerId: string
  who: string
  charged: number
  cardFee: number
  fromMargin: number
  toMargin: number
}
export interface MarginPlan {
  fixes: MarginFix[]
  skipped: { backgroundCheckId: string; why: string }[]
  total: number
}

interface Row {
  id: string
  who: string
  charged: string | null
  refunded: string | null
  platform_net: string | null
  report_summary: any
  ledger_id: string | null
  margin: string | null
  card_fee: string | null
}

/** Read-only: everything --apply would change. */
export async function planScreeningMarginTruth(q: Q): Promise<MarginPlan> {
  const plan: MarginPlan = { fixes: [], skipped: [], total: 0 }
  const { rows } = await q.query<Row>(`
    SELECT bc.id,
           COALESCE(NULLIF(btrim(u.first_name || ' ' || u.last_name), ''), bc.id::text) AS who,
           bc.amount_charged::text  AS charged,
           bc.refunded_at::text     AS refunded,
           bc.platform_net::text    AS platform_net,
           bc.report_summary,
           m.id::text               AS ledger_id,
           m.amount::text           AS margin,
           (SELECT MAX(s.customer_fee_charged) FROM platform_revenue_ledger s
             WHERE s.type = 'banking_spread' AND s.reference_type = 'background_check'
               AND s.reference_id = bc.id)::text AS card_fee
      FROM background_checks bc
      LEFT JOIN users u ON u.id = bc.user_id
      LEFT JOIN platform_revenue_ledger m
             ON m.type = 'screening_margin' AND m.reference_type = 'background_check'
            AND m.reference_id = bc.id
     WHERE bc.applicant_payment_intent_id IS NOT NULL
     ORDER BY bc.created_at`)

  for (const r of rows) {
    const skip = (why: string) => plan.skipped.push({ backgroundCheckId: r.id, why })
    if (r.refunded) { skip('refunded — its money is not GAM\'s to rebook'); continue }
    if (!r.ledger_id || r.margin == null) { skip('no screening_margin row to correct'); continue }
    if (r.card_fee == null) { skip('no banking_spread row, so the card fee inside it is unknown'); continue }
    const charged = Number(r.charged)
    const margin = Number(r.margin)
    const cardFee = Number(r.card_fee)
    if (round2(charged) !== OLD_APPLICANT_PRICE_USD) { skip(`charged $${charged.toFixed(2)}, not the old $${OLD_APPLICANT_PRICE_USD}`); continue }
    if (round2(margin) !== OLD_FLAT_MARGIN_USD) { skip(`margin is $${margin.toFixed(2)}, not the old flat $${OLD_FLAT_MARGIN_USD} — leave it`); continue }
    // The one thing that would make $34.99 the wrong invoice.
    const products = r.report_summary?.products
    if (products && Object.prototype.hasOwnProperty.call(products, CHECKR_ID_SCAN_ADD_ON)) {
      skip('its report shows the ID scan ran, so Checkr invoiced more than the package alone'); continue
    }
    const toMargin = round2(charged - cardFee - CHECKR_ESSENTIAL_ONLY_USD)
    if (toMargin <= margin) { skip(`nothing to move (would be $${toMargin.toFixed(2)})`); continue }
    plan.fixes.push({ backgroundCheckId: r.id, ledgerId: r.ledger_id, who: r.who, charged, cardFee, fromMargin: margin, toMargin })
    plan.total = round2(plan.total + (toMargin - margin))
  }
  return plan
}

export async function applyScreeningMarginTruth(q: Q, plan: MarginPlan): Promise<void> {
  for (const f of plan.fixes) {
    await q.query(
      `UPDATE platform_revenue_ledger
          SET amount = $2,
              notes = 'Screening margin (applicant paid; settles to the platform) — corrected 10/21: the ID scan inside the price was never ordered, so Checkr invoiced the package alone'
        WHERE id = $1`, [f.ledgerId, f.toMargin])
    await q.query(`UPDATE background_checks SET platform_net = $2 WHERE id = $1`, [f.backgroundCheckId, f.toMargin])
  }
}

async function main() {
  const apply = process.argv.includes('--apply')
  const client = await getClient()
  try {
    const plan = await planScreeningMarginTruth(client)
    for (const s of plan.skipped) console.log(`  skipped ${s.backgroundCheckId}: ${s.why}`)
    for (const f of plan.fixes) {
      console.log(`  ${f.who}: $${f.charged.toFixed(2)} paid - $${f.cardFee.toFixed(2)} card - $${CHECKR_ESSENTIAL_ONLY_USD} Checkr`
        + ` → margin $${f.fromMargin.toFixed(2)} becomes $${f.toMargin.toFixed(2)}`)
    }
    console.log(`\n  ${plan.fixes.length} screening(s), $${plan.total.toFixed(2)} moved from "owed to Checkr" to GAM's own.`)
    if (!apply) { console.log('\nDRY RUN — nothing written. Re-run with --apply.'); return }
    await client.query('BEGIN')
    await applyScreeningMarginTruth(client, plan)
    await client.query('COMMIT')
    console.log('\nApplied.')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally { client.release() }
}

if (require.main === module) main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })

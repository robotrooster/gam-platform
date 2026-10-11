/**
 * 10/3 — the data side of Nic's admin money cards ("Is that actually
 * accurate?"). Run once at the deploy that ships the new Processing Margin and
 * GAM's Own Money cards, AFTER migration 20261004001000 is applied.
 *
 * STRIPE MUST BE REACHABLE (the live key in apps/api/.env): step 0 re-reads
 * every Stripe charge since July with the new sync, and the script refuses to
 * run without it. The old nightly sync keeps storing new fee lines without
 * Stripe's sales tax and leaves new bank fees untied to their payments, and
 * looks back only 10 days — so a fix limited to the lines known on 10/3 would
 * leave every line stored after it wrong for good (on a 10/4 copy of
 * production: Authorization Boost txn_1UMewTDNEru9AEpKM0ykj6OR stored $1.05,
 * $1.12 left the balance — a −$0.07 gap no later sync could reach).
 *
 * The Stripe balance was reconciled to the cent on 10/3: GAM's own money was
 * $318.76 (= $242.88 GAM earned and holds + $75.88 of background-check money
 * applicants paid, which is Checkr's). These are the small booking gaps that
 * reconciliation found, each fixed once:
 *
 *   1. The 9/19 background check's card spread (revenue row 6ef96274) never
 *      recorded the $2.05 card fee the applicant paid, so the true-up left it
 *      out. Every screening spread with no fee recorded gets the fee inside
 *      what the applicant was charged (3.5% + $0.55).
 *   2. Register and pay-link card fees were never booked as GAM's earnings —
 *      4 sales, $2.83 — while Stripe's cost of those charges was. Each is
 *      booked on the day of its sale.
 *   3. The $6 bank cost on Oak Park's GAM-fee debit (cce1498e, settled 10/1)
 *      was never booked either — only Stripe's $0.27 on it was. Booked on the
 *      day it settled.
 *   0. Every Stripe charge since 2026-07-01 is read again with the new sync
 *      (stripeCosts.syncStripeCosts), on this script's own transaction: each
 *      fee line is set to what actually left the balance (Stripe's sales tax
 *      included), and each bank payment's fee line is tied to its payment —
 *      the 10/3 lines below and every line stored since.
 *   4. Printed check: the 16 fee lines found stored without their sales tax
 *      on 10/3 ($2.46 in all — Authorization Boost and the bank-feed charges)
 *      now read what left the balance.
 *   5. Printed check: the six bank-payment fee lines known on 10/3 are tied to
 *      their payments (new column), so the Processing Margin card can show
 *      what Stripe took on each one and keep a clearing payment's fee out of
 *      the month until it clears.
 *   6. Each paid screening's platform_net says $5 (what GAM kept), not the
 *      column's stale $15 default.
 *   7. The payout record now says which GAM charges it netted (generated
 *      column from the migration): Mountain View's 9/21 payout (5c65eec4)
 *      shows $82. Printed here as a check; nothing to write.
 *   8. Every month with Stripe costs or fees is trued up again under the
 *      card's rules — July's $0.24 of costs never had a true-up at all.
 *   9. The revenue book's running balance (balance_after) is restated from
 *      $0 in date order. Rows written for an earlier day and the month-end
 *      true-ups had left it drifting (18 of 46 rows by the evening of 10/3); no total ever
 *      read it, every figure is a SUM(amount). Each true-up in step 8 then
 *      restates its own month onward, so it stays a real running balance.
 *
 * Idempotent: each step only touches what is still wrong, and a true-up
 * replaces its own previous row. Running it twice changes nothing the second
 * time.
 *
 * DRY=1 (the default) does every step inside one transaction — the Stripe
 * sync included — prints what it did and what each month's true-up would
 * become, and rolls it all back (Stripe is only read):
 *   DRY=1 node -r ts-node/register src/scripts/oct3_gam_money_card_data.ts
 *   DRY=0 node -r ts-node/register src/scripts/oct3_gam_money_card_data.ts
 */
import type { PoolClient } from 'pg'
import { getClient, query } from '../db'
import {
  cardSaleOnBalanceSql, PROCESSING_MARGIN_ON_THE_BOOK_SQL, realLandlordSql, recordPlatformRevenue, restateRunningBalance, trueUpProcessingMargin,
} from '../services/platformRevenue'
import { marginForMonth, PAYMENT_TIED_TXN_TYPES, screeningFeeInside, syncStripeCosts } from '../services/stripeCosts'
import { stripeSecretKeyOrNull } from '../lib/stripe'
import Stripe from 'stripe'

/** Step 0 reads Stripe back to here: the first month with Stripe charges (July's $0.24). */
const SYNC_FROM = '2026-07-01'

/** [stripe_txn_id, amount stored without the tax, what left the balance] — Stripe, 10/3. */
const TAXED_FEE_LINES: Array<[string, number, number]> = [
  ['txn_1UMIWoDNEru9AEpK33ml6zug', 0.78, 0.83],   // Authorization Boost (2026-10-02)
  ['txn_1ULwFiDNEru9AEpKb6BOB44S', 2.93, 3.12],   // Authorization Boost (2026-10-01)
  ['txn_1ULZvCDNEru9AEpKsVRKXChq', 0.90, 0.96],   // Connections Transaction Subscription (September)
  ['txn_1ULYxvDNEru9AEpKefYUrskx', 12.90, 13.75], // Connections Balance Refresh (September)
  ['txn_1UGsFoDNEru9AEpK5yLfcizC', 0.82, 0.87],   // Authorization Boost (2026-09-17)
  ['txn_1UGUwaDNEru9AEpK9CaaFpM1', 0.98, 1.04],   // Authorization Boost (2026-09-16)
  ['txn_1UFmNSDNEru9AEpK7zQcPPQX', 0.86, 0.92],   // Authorization Boost (2026-09-14)
  ['txn_1UFPtJDNEru9AEpKuL02YfuQ', 1.26, 1.34],   // Authorization Boost (2026-09-13)
  ['txn_1UF2tjDNEru9AEpK9zeGFxZh', 1.18, 1.26],   // Authorization Boost (2026-09-12)
  ['txn_1UEh87DNEru9AEpKLOhVNsb6', 0.98, 1.04],   // Authorization Boost (2026-09-11)
  ['txn_1UEKg9DNEru9AEpKDUlInX47', 0.86, 0.92],   // Authorization Boost (2026-09-10)
  ['txn_1UCs6WDNEru9AEpKK9NsPCAz', 1.35, 1.44],   // Authorization Boost (2026-09-06)
  ['txn_1UCVgADNEru9AEpKxdr77Bow', 1.18, 1.26],   // Authorization Boost (2026-09-05)
  ['txn_1UBn5vDNEru9AEpKs3A7gdjS', 0.98, 1.04],   // Authorization Boost (2026-09-03)
  ['txn_1UAhYZDNEru9AEpK0C12fIc1', 0.30, 0.32],   // Connections Transaction Subscription (August)
  ['txn_1UAgsPDNEru9AEpKKpyclBsK', 9.30, 9.91],   // Connections Balance Refresh (August)
]

/** [stripe_processing_costs.stripe_txn_id, the PaymentIntent it came from] — Stripe, 10/3. */
const BANK_FEE_PAYMENTS: Array<[string, string]> = [
  ['txn_3U6GFiDNEru9AEpK1geZNfAh:fee', 'pi_3U6GFiDNEru9AEpK1f6pGlDP'],   // Aug test payment ($8.00)
  ['txn_3UByDfDNEru9AEpK21W8kQUi:fee', 'pi_3UByDfDNEru9AEpK2tB2YAtE'],   // Randall Cox, September
  ['txn_3UDvG5DNEru9AEpK2VBGF5C7:fee', 'pi_3UDvG5DNEru9AEpK2d7eGBwW'],   // Mireya Fierro, September
  ['txn_3UK4lZDNEru9AEpK1fW36kur:fee', 'pi_3UK4lZDNEru9AEpK17s3i4lH'],   // Oak Park GAM-fee debit
  ['txn_3ULlcUDNEru9AEpK2BlZdygc:fee', 'pi_3ULlcUDNEru9AEpK2CGlGLM2'],   // Randall Cox, October (clearing)
  ['txn_3ULlPkDNEru9AEpK2KfrDwvM:fee', 'pi_3ULlPkDNEru9AEpK2J3WxEN0'],   // Mireya Fierro, October (clearing)
]

const money = (n: number) => `$${n.toFixed(2)}`

async function columnExists(c: PoolClient, table: string, column: string): Promise<boolean> {
  const r = await c.query(
    `SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [table, column])
  return r.rows.length > 0
}

/** The true-up preview, read on the script's own transaction so it sees steps 1–6. */
async function previewTrueUp(c: PoolClient, month: string) {
  const exec = async (sql: string, params?: unknown[]) => (await c.query(sql, params as any[])).rows
  const card = await marginForMonth(month, exec)
  const recorded = Number((await c.query<{ amt: string }>(
    `SELECT COALESCE(SUM(amount), 0)::text AS amt FROM platform_revenue_ledger
      WHERE to_char(date_trunc('month', created_at), 'YYYY-MM') = $1
        AND ${PROCESSING_MARGIN_ON_THE_BOOK_SQL}`, [month])).rows[0].amt)
  const existing = Number((await c.query<{ amt: string }>(
    `SELECT COALESCE(SUM(amount), 0)::text AS amt FROM platform_revenue_ledger
      WHERE type = 'adjustment' AND reference_type = 'processing_margin_true_up'
        AND to_char(date_trunc('month', created_at), 'YYYY-MM') = $1`, [month])).rows[0].amt)
  return { card, recorded, existing, adjustment: Math.round((card.margin - recorded) * 100) / 100 }
}

async function main() {
  const dryRun = process.env.DRY !== '0'
  const key = stripeSecretKeyOrNull()
  if (!key) throw new Error('Stripe is not configured (no STRIPE_SECRET_KEY): this script re-reads Stripe\'s charges and must run with Stripe reachable.')
  const stripe = new Stripe(key, { apiVersion: '2023-10-16' })
  const c = await getClient()
  const months: string[] = []
  try {
    await c.query('BEGIN')
    if (!(await columnExists(c, 'stripe_processing_costs', 'stripe_payment_intent_id'))
        || !(await columnExists(c, 'platform_transfer_intents', 'gam_fees_kept_amount'))) {
      throw new Error('Apply migration 20261004001000_gam_money_cards_cost_links.sql first (npm run migrate), then run this.')
    }

    // 0. Every Stripe charge since July, read again with the new sync, written
    // on this transaction: amounts to what left the balance (sales tax
    // included), each payment's own fee line tied to its payment.
    const lookbackDays = Math.ceil((Date.now() - Date.parse(`${SYNC_FROM}T00:00:00Z`)) / 86_400_000) + 1
    const synced = await syncStripeCosts({
      stripe, lookbackDays, exec: async (sql, params) => (await c.query(sql, params as any[])).rows,
    })
    if (synced.scanned === 0) throw new Error('Stripe returned nothing since ' + SYNC_FROM + ' — is the key live and Stripe reachable?')
    console.log(`0. Stripe re-read since ${SYNC_FROM} (${lookbackDays} days): ${synced.scanned} balance lines, ${synced.stored} new cost line(s), ${synced.updated} corrected, ${synced.skipped} unchanged or not a cost`)

    // Every revenue write below takes the ledger's one lock; take it now so the
    // rest of the run is one step in the ledger's running balance. 10/4 (review,
    // fix pass 1): taken AFTER step 0 — reading Stripe back to July takes
    // seconds (more as volume grows), its writes are cost-line UPSERTs that need
    // no ledger lock, and holding the lock through it made every revenue write
    // in production (allocation when rent settles gives up after 10s) wait.
    await c.query(`SELECT pg_advisory_xact_lock(hashtextextended('platform_revenue', 0))`)

    // 1. Screening card spreads with no fee recorded.
    const spreads = (await c.query<{ id: string; charged: string }>(
      `SELECT l.id, bc.amount_charged::text AS charged
         FROM platform_revenue_ledger l JOIN background_checks bc ON bc.id = l.reference_id
        WHERE l.type = 'banking_spread' AND l.reference_type = 'background_check'
          AND l.customer_fee_charged IS NULL AND bc.amount_charged > 0`)).rows
    for (const r of spreads) {
      const fee = screeningFeeInside(Number(r.charged))
      await c.query(`UPDATE platform_revenue_ledger SET customer_fee_charged = $2 WHERE id = $1 AND customer_fee_charged IS NULL`, [r.id, fee])
      console.log(`1. screening spread ${r.id}: card fee recorded ${money(fee)} (on a ${money(Number(r.charged))} check)`)
    }
    if (!spreads.length) console.log('1. every screening spread already records its card fee')

    // 2. Register / pay-link card fees never booked.
    const sales = (await c.query<{ id: string; fee: string; property_id: string | null; at: Date; online: boolean }>(
      `SELECT pt.id, pt.platform_fee::text AS fee, pt.property_id, pt.created_at AS at,
              (pt.pay_link_id IS NOT NULL OR pt.paid_online) AS online
         FROM pos_transactions pt
        WHERE pt.payment_method IN ('card', 'card_on_file') AND pt.stripe_payment_intent_id IS NOT NULL
          -- 10/3 (review): a sale refunded at the register is paid back by
          -- hand; its charge and GAM's fee stayed on the balance.
          AND ${cardSaleOnBalanceSql('pt.status')} AND pt.platform_fee > 0
          -- S653: a demo or GAM-internal account's sale is not revenue (the
          -- writer skips it, and the card leaves it out).
          AND ${realLandlordSql('pt.landlord_id')}
          AND NOT EXISTS (SELECT 1 FROM platform_revenue_ledger l
                           WHERE l.type = 'banking_spread' AND l.reference_type = 'pos_transaction'
                             AND l.reference_id = pt.id)
        ORDER BY pt.created_at`)).rows
    for (const s of sales) {
      const fee = Number(s.fee)
      await recordPlatformRevenue({
        type: 'banking_spread', amount: fee, customerFeeCharged: fee,
        referenceId: s.id, referenceType: 'pos_transaction', propertyId: s.property_id, at: s.at,
        notes: s.online ? 'Card fee on a pay link payment (booked 10/3)' : 'Card fee on a register card sale (booked 10/3)',
      }, c)
      const booked = await c.query(`SELECT 1 FROM platform_revenue_ledger WHERE type = 'banking_spread' AND reference_type = 'pos_transaction' AND reference_id = $1`, [s.id])
      if (!booked.rows.length) throw new Error(`could not book the card fee on sale ${s.id}`)
      console.log(`2. ${s.online ? 'pay link' : 'register'} sale ${s.id} (${new Date(s.at).toISOString().slice(0, 10)}): card fee ${money(fee)} booked`)
    }
    console.log(`2. ${sales.length} card sale fee(s), ${money(sales.reduce((a, s) => a + Number(s.fee), 0))}`)

    // 3. Bank costs on GAM-fee debits never booked.
    const debits = (await c.query<{ id: string; cost: string; at: Date }>(
      `SELECT d.id, d.bank_cost_amount::text AS cost, COALESCE(d.settled_at, d.updated_at) AS at
         FROM landlord_gam_debits d
        WHERE d.status = 'succeeded' AND d.bank_cost_amount > 0
          AND NOT EXISTS (SELECT 1 FROM platform_revenue_ledger l
                           WHERE l.type = 'banking_spread' AND l.reference_type = 'gam_bank_debit'
                             AND l.reference_id = d.id)`)).rows
    for (const d of debits) {
      const cost = Number(d.cost)
      await recordPlatformRevenue({
        type: 'banking_spread', amount: cost, customerFeeCharged: cost,
        referenceId: d.id, referenceType: 'gam_bank_debit', at: d.at,
        notes: 'Bank transfer cost on a debit of GAM fees ($6 flat, GAM\'s one ACH price) (booked 10/3)',
      }, c)
      const booked = await c.query(`SELECT 1 FROM platform_revenue_ledger WHERE type = 'banking_spread' AND reference_type = 'gam_bank_debit' AND reference_id = $1`, [d.id])
      if (!booked.rows.length) throw new Error(`could not book the bank cost on debit ${d.id}`)
      console.log(`3. GAM-fee debit ${d.id}: bank cost ${money(cost)} booked`)
    }
    if (!debits.length) console.log('3. every settled GAM-fee debit already books its bank cost')

    // 4. Printed check: the fee lines stored without their sales tax on 10/3
    // now read what left the balance (step 0 set them; nothing is written here).
    let wrong = 0
    for (const [id, stored, net] of TAXED_FEE_LINES) {
      const r = await c.query<{ amount: string }>(`SELECT amount::text AS amount FROM stripe_processing_costs WHERE stripe_txn_id = $1`, [id])
      const now = r.rows[0] ? Number(r.rows[0].amount) : null
      if (now != null && Math.abs(now - net) < 0.005) { console.log(`4. ${id}: ${money(net)} (was ${money(stored)} without the tax) — ok`); continue }
      wrong++
      console.log(`4. ${id}: ${now == null ? 'not on record' : `on record as ${money(now)}`}, Stripe took ${money(net)} — CHECK BY HAND`)
    }
    console.log(wrong ? `4. ${wrong} line(s) still wrong after the sync — check them by hand` : '4. every line known on 10/3 reads what left the balance')

    // 5. Printed check: the bank-payment fee lines known on 10/3 are tied to
    // their payments (step 0 tied them). Only a payment's own fee line is ever
    // tied (stripeCosts PAYMENT_TIED_TXN_TYPES); a dispute's or a return's fee
    // counts in the month Stripe took it.
    let untied = 0
    for (const [txn, pi] of BANK_FEE_PAYMENTS) {
      const r = await c.query<{ amount: string; pi: string | null }>(
        `SELECT amount::text AS amount, stripe_payment_intent_id AS pi FROM stripe_processing_costs
          WHERE stripe_txn_id = $1 AND txn_type = ANY($2::text[])`, [txn, [...PAYMENT_TIED_TXN_TYPES]])
      const row = r.rows[0]
      if (row?.pi === pi) { console.log(`5. ${txn} (${money(Number(row.amount))}) -> ${pi} — ok`); continue }
      untied++
      console.log(`5. ${txn}: ${row ? `tied to ${row.pi ?? 'nothing'}` : 'not on record'}, expected ${pi} — CHECK BY HAND`)
    }
    const [{ n: openBankFees }] = (await c.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM stripe_processing_costs
        WHERE txn_type = ANY($1::text[]) AND stripe_payment_intent_id IS NULL`, [[...PAYMENT_TIED_TXN_TYPES]])).rows
    console.log(`5. ${untied ? `${untied} known line(s) not tied — check by hand; ` : ''}payment fee lines tied to nothing: ${openBankFees}`)

    // 6. Screening platform_net = what GAM kept.
    const nets = (await c.query<{ id: string; was: string | null; now: string }>(
      `UPDATE background_checks bc SET platform_net = m.amt
         FROM (SELECT reference_id, SUM(amount) AS amt FROM platform_revenue_ledger
                WHERE type = 'screening_margin' AND reference_type = 'background_check'
                GROUP BY reference_id) m,
              background_checks prev
        WHERE bc.id = m.reference_id AND prev.id = bc.id AND bc.platform_net IS DISTINCT FROM m.amt
        RETURNING bc.id, prev.platform_net::text AS was, bc.platform_net::text AS now`)).rows
    for (const n of nets) console.log(`6. screening ${n.id}: platform_net ${n.was ?? 'none'} -> ${money(Number(n.now))}`)
    if (!nets.length) console.log('6. every screening already says what GAM kept')

    // 7. The payout record says what GAM kept back.
    const kept = (await c.query<{ id: string; gross: string; amount: string; kept: string }>(
      `SELECT id, gross_owed::text AS gross, amount::text AS amount, gam_fees_kept_amount::text AS kept
         FROM platform_transfer_intents WHERE gam_fees_kept_amount <> 0 ORDER BY created_at`)).rows
    for (const k of kept) console.log(`7. payout ${k.id}: ${money(Number(k.gross))} owed, ${money(Number(k.amount))} sent, ${money(Number(k.kept))} of GAM charges netted`)

    // 9 (before 8's preview, so the preview runs on the restated book). The
    // running balance, restated from $0 in (created_at, id) order.
    const restated = await restateRunningBalance(async (sql, params) => (await c.query(sql, params as any[])).rows, '-infinity')
    console.log(`9. running balance restated: ${restated} row(s) corrected`)

    // 8. Every month with fees or Stripe costs, trued up under the card's rules.
    const first = (await c.query<{ m: string | null }>(
      `SELECT LEAST(
         (SELECT to_char(MIN(COALESCE(period_start, posted_at::date)), 'YYYY-MM') FROM stripe_processing_costs),
         (SELECT to_char(MIN(COALESCE(settled_at, created_at)), 'YYYY-MM') FROM tenant_remittances
           WHERE payment_method IN ('card', 'ach') AND stripe_payment_intent_id IS NOT NULL)) AS m`)).rows[0].m
    const last = (await c.query<{ m: string }>(`SELECT to_char(NOW(), 'YYYY-MM') AS m`)).rows[0].m
    for (let m = first ?? last; m <= last; ) {
      months.push(m)
      const [y, mo] = m.split('-').map(Number)
      m = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`
    }
    for (const m of months) {
      const p = await previewTrueUp(c, m)
      console.log(`8. ${m}: fees ${money(p.card.feeRevenue)} − Stripe ${money(p.card.stripeCost)}`
        + (p.card.feesBack.total !== 0 ? ` + disputes and returned payments ${money(p.card.feesBack.total)}` : '')
        + ` = margin ${money(p.card.margin)}`
        + ` | on the book before the true-up ${money(p.recorded)} | true-up ${money(p.existing)} -> ${money(p.adjustment)}`
        + (p.card.clearing.count ? ` | still clearing: ${p.card.clearing.count} payment(s), ${money(p.card.clearing.fees)} of fees` : ''))
    }

    await c.query(dryRun ? 'ROLLBACK' : 'COMMIT')
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    c.release()
  }

  if (!dryRun) {
    for (const m of months) {
      const r = await trueUpProcessingMargin(`${m}-01`)
      console.log(`8. ${m} trued up: margin ${money(r.actualMargin)}, adjustment ${money(r.previousTrueUp)} -> ${money(r.adjustment)}`)
    }
    const [sum] = await query<{ total: string }>(`SELECT COALESCE(SUM(amount), 0)::text AS total FROM platform_revenue_ledger`)
    console.log(`Revenue book total now ${money(Number(sum.total))}.`)
  }
  console.log(dryRun ? 'DRY RUN — every step above was rolled back; nothing changed.' : 'Done.')
  process.exit(0)
}

main().catch(e => { console.error(e); process.exit(1) })

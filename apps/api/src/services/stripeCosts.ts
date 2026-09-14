/**
 * S642 (Nic): "Instead of showing $199 fees from Stripe I want to see our
 * margin on that too."
 *
 * Pulls what Stripe actually charged GAM and stores it, so margin is a figure
 * the platform holds rather than one somebody has to go ask Stripe for.
 *
 * THE SHAPE OF THE DATA IS NOT OUR CHOICE. The account is on unbundled
 * (interchange-plus) pricing: every charge balance-transaction returns fee = 0
 * and fee_details = [], and the real costs arrive as separate daily aggregates —
 * one "Transaction network costs" line, one "Stripe volume fee" line, and so on,
 * each covering that day's entire card volume. So this syncs those lines. There
 * is no per-payment cost to sync, and a per-payment number would be invented.
 */
import Stripe from 'stripe'
import { query } from '../db'
import { logger } from '../lib/logger'
import { stripeSecretKeyOrNull } from '../lib/stripe'

const key = stripeSecretKeyOrNull()
const stripe = key ? new Stripe(key, { apiVersion: '2023-10-16' }) : null

/** Categories, in the order a human would want them read. */
export const COST_CATEGORIES = [
  'card_interchange',
  'stripe_volume_fee',
  'authorization_boost',
  'per_authorization',
  'radar',
  'bank_debit_fee',
  'card_fee',
  'bank_linking',
  'other',
] as const
export type CostCategory = typeof COST_CATEGORIES[number]

export const COST_LABELS: Record<CostCategory, string> = {
  card_interchange:    'Card network interchange',
  stripe_volume_fee:   'Stripe volume fee',
  authorization_boost: 'Authorization Boost',
  per_authorization:   'Stripe per-authorization',
  radar:               'Radar (fraud screening)',
  bank_debit_fee:      'Bank debit fee (ACH)',
  card_fee:            'Card fee charged on the charge',
  bank_linking:        'Bank linking (Financial Connections)',
  other:               'Other Stripe charges',
}

/**
 * Stripe's description prose is the only thing distinguishing these, so the
 * mapping lives in ONE place and the stored row carries our category — a read
 * should never be re-parsing English.
 */
export function categorise(description: string): CostCategory {
  const d = (description || '').toLowerCase()
  if (d.includes('connections'))          return 'bank_linking'
  if (d.includes('radar'))                return 'radar'
  if (d.includes('authorization boost'))  return 'authorization_boost'
  if (d.includes('per-autho'))            return 'per_authorization'
  if (d.includes('network cost'))         return 'card_interchange'
  if (d.includes('volume fee'))           return 'stripe_volume_fee'
  return 'other'
}

/** "(2026-08-01 - 2026-08-31)" → the period the charge covers, when named. */
export function parsePeriod(description: string): { start: string | null; end: string | null } {
  const m = /\((\d{4}-\d{2}-\d{2})\s*-\s*(\d{4}-\d{2}-\d{2})\)/.exec(description || '')
  if (m) return { start: m[1], end: m[2] }
  const single = /\((\d{4}-\d{2}-\d{2})\)/.exec(description || '')
  return single ? { start: single[1], end: single[1] } : { start: null, end: null }
}

export interface SyncResult { scanned: number; stored: number; skipped: number }

/**
 * Idempotent: keyed on Stripe's own transaction id, so re-running cannot
 * double-count. Double-counting here would silently understate margin, which is
 * the one failure this whole thing exists to prevent.
 */
export async function syncStripeCosts(opts: { lookbackDays?: number } = {}): Promise<SyncResult> {
  const out: SyncResult = { scanned: 0, stored: 0, skipped: 0 }
  if (!stripe) return out
  const since = Math.floor(Date.now() / 1000) - (opts.lookbackDays ?? 45) * 86400

  // ACH debit fees do NOT arrive as their own cost line — they are the `fee`
  // field on the type='payment' balance transaction itself (0.5% of the debit,
  // e.g. $2.33 on $466). Card charges under unbundled pricing carry fee = 0, so
  // this loop finds nothing for them, which is correct: their cost is in the
  // aggregate lines below. Missing this understated cost — and therefore
  // OVERSTATED margin — by the whole ACH rail.
  for (const type of ['payment', 'charge'] as const) {
    let after: string | undefined
    for (;;) {
      const page: Stripe.ApiList<Stripe.BalanceTransaction> = await stripe.balanceTransactions.list({
        limit: 100, type, created: { gte: since },
        ...(after ? { starting_after: after } : {}),
      })
      for (const t of page.data) {
        out.scanned++
        if (!t.fee || t.fee <= 0) { out.skipped++; continue }
        const desc = `${type === 'payment' ? 'Bank debit' : 'Card'} fee on ${t.id}`
        const res = await query<{ id: string }>(
          `INSERT INTO stripe_processing_costs
             (stripe_txn_id, txn_type, category, description, amount, posted_at, period_start, period_end)
           VALUES ($1,$2,$3,$4,$5, to_timestamp($6), NULL, NULL)
           ON CONFLICT (stripe_txn_id) DO NOTHING
           RETURNING id`,
          // Keyed distinctly from any aggregate line that might share the id.
          [`${t.id}:fee`, type, type === 'payment' ? 'bank_debit_fee' : 'card_fee',
           desc, t.fee / 100, t.created])
        if (res.length) out.stored++; else out.skipped++
      }
      if (!page.has_more) break
      after = page.data[page.data.length - 1]?.id
      if (!after) break
    }
  }

  for (const type of ['stripe_fee', 'network_cost'] as const) {
    let startingAfter: string | undefined
    for (;;) {
      const page: Stripe.ApiList<Stripe.BalanceTransaction> = await stripe.balanceTransactions.list({
        limit: 100, type, created: { gte: since },
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      })
      for (const t of page.data) {
        out.scanned++
        // Stripe posts costs as NEGATIVE balance moves. A non-negative one is
        // not a cost (a reversal, a credit) and is left alone rather than
        // stored as a negative cost that would quietly inflate margin.
        if (t.amount >= 0) { out.skipped++; continue }
        const desc = t.description ?? ''
        const period = parsePeriod(desc)
        const res = await query<{ id: string }>(
          `INSERT INTO stripe_processing_costs
             (stripe_txn_id, txn_type, category, description, amount, posted_at, period_start, period_end)
           VALUES ($1,$2,$3,$4,$5, to_timestamp($6), $7, $8)
           ON CONFLICT (stripe_txn_id) DO NOTHING
           RETURNING id`,
          [t.id, type, categorise(desc), desc, Math.abs(t.amount) / 100, t.created,
           period.start, period.end])
        if (res.length) out.stored++; else out.skipped++
      }
      if (!page.has_more) break
      startingAfter = page.data[page.data.length - 1]?.id
      if (!startingAfter) break
    }
  }
  logger.info(out, '[stripe-costs] synced what Stripe charged us')
  return out
}

export interface MarginRow {
  month: string
  feeRevenue: number      // what tenants were charged
  stripeCost: number      // what Stripe charged GAM, posted that month
  margin: number
  marginPct: number | null
  byCategory: Array<{ category: CostCategory; label: string; amount: number }>
  byRail: Array<{ rail: string; charged: number; count: number }>
}

/** Exact at the month level, which is the level at which it is knowable. */
export async function marginByMonth(months = 6): Promise<MarginRow[]> {
  const revenue = await query<{ month: string; fee: string }>(
    `SELECT to_char(date_trunc('month', COALESCE(settled_at, created_at)), 'YYYY-MM') AS month,
            COALESCE(SUM(processing_fee_amount), 0)::text AS fee
       FROM tenant_remittances
      WHERE status IN ('settled','processing')
        AND COALESCE(settled_at, created_at) >= date_trunc('month', NOW()) - ($1 || ' months')::interval
      GROUP BY 1`, [months])
  const costs = await query<{ month: string; category: string; amount: string }>(
    // Attributed to the period the charge COVERS when Stripe names one. August's
    // bank-linking bill posts on September 1 (and at 00:00 UTC, which is still
    // August in Phoenix — so posting date alone was both wrong and wrong in a
    // way that depended on the server's timezone).
    `SELECT to_char(date_trunc('month', COALESCE(period_start, posted_at::date)), 'YYYY-MM') AS month,
            category, COALESCE(SUM(amount), 0)::text AS amount
       FROM stripe_processing_costs
      WHERE COALESCE(period_start, posted_at::date)
            >= (date_trunc('month', NOW()) - ($1 || ' months')::interval)::date
      GROUP BY 1, 2`, [months])
  const rails = await query<{ month: string; rail: string; charged: string; n: string }>(
    `SELECT to_char(date_trunc('month', COALESCE(settled_at, created_at)), 'YYYY-MM') AS month,
            COALESCE(payment_method, 'unknown') AS rail,
            COALESCE(SUM(processing_fee_amount), 0)::text AS charged,
            COUNT(*)::text AS n
       FROM tenant_remittances
      WHERE status IN ('settled','processing')
        AND COALESCE(settled_at, created_at) >= date_trunc('month', NOW()) - ($1 || ' months')::interval
      GROUP BY 1, 2`, [months])

  const monthsSet = new Set<string>([...revenue.map(r => r.month), ...costs.map(c => c.month)])
  return [...monthsSet].sort().reverse().map(month => {
    const feeRevenue = Math.round(parseFloat(revenue.find(r => r.month === month)?.fee ?? '0') * 100) / 100
    const cats = costs.filter(c => c.month === month)
    const stripeCost = Math.round(cats.reduce((s, c) => s + parseFloat(c.amount), 0) * 100) / 100
    const margin = Math.round((feeRevenue - stripeCost) * 100) / 100
    return {
      month, feeRevenue, stripeCost, margin,
      marginPct: feeRevenue > 0 ? Math.round((margin / feeRevenue) * 1000) / 10 : null,
      byCategory: COST_CATEGORIES
        .map(category => ({
          category,
          label: COST_LABELS[category],
          amount: Math.round(cats.filter(c => c.category === category)
            .reduce((s, c) => s + parseFloat(c.amount), 0) * 100) / 100,
        }))
        .filter(c => c.amount > 0),
      byRail: rails.filter(r => r.month === month).map(r => ({
        rail: r.rail,
        charged: Math.round(parseFloat(r.charged) * 100) / 100,
        count: parseInt(r.n, 10),
      })).sort((a, b) => b.charged - a.charged),
    }
  })
}

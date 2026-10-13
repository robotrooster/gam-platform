/**
 * 10/12 (Nic) — GAM BOOKS LEDGER, PHASE P5: GAM SENDS THE LANDLORD'S MONEY TO THEIR STRIPE ACCOUNT
 * (gam-ledger-design-2026-10-12 §6 G2, G2b, H6)
 *
 * Source 'transfer_intent' = one platform_transfer_intents row, posted once it
 * is transferred (transferred_at, the company's books calendar).
 *
 * The weekly batch ('payout'): what the batch claimed — the owner shares it
 * stamped (user_balance_ledger, by the intent's stamp) and the held lines it
 * carried (held_payout_items.payout_intent_id), together gross_owed — leaves
 * Due from GAM (1050). Out of it:
 *   - the reversals it netted (netted_amount) close the hole a payment
 *     reversal already took out of 1050 on its own day (design E1): Dr 1050;
 *   - GAM's charges it kept (gam_fees_kept_amount, by the collections recorded
 *     against the batch — landlord_gam_charge_collections, design P0): Dr Due
 *     to GAM (2080) — the "GAM fees netted" (H6); 10/13 (Nic): a card reader
 *     piece it kept is Dr Supplies (5140) instead — "each $87.50 → SUPPLIES,
 *     in the month GAM COLLECTED it" (its charge posts nothing of its own,
 *     payoutGamCharges);
 *   - the rest is the transfer: Dr Stripe balance, on its way to your bank (1060).
 *
 *   Cr Due from GAM (1050)       each claimed share and line, at its property
 *   Dr Due from GAM (1050)       the netted reversals, at their payments' property
 *   Dr Due to GAM (2080)         each kept GAM charge, at the charge's property
 *   Dr Supplies (5140)           each kept card reader piece, at its property (one
 *                                on no property: a company-level cost, companyCosts)
 *   Dr Stripe in transit (1060)  amount, at the properties the money left
 *
 * A fully netted batch (amount 0) posts the same lines without the 1060 line.
 *
 * A recorded direct transfer (design G2b, migration 20261013090100):
 *   'deposit_settlement'   a move-out's escrow settlement — Dr 1060 the
 *                          transfer. 10/12 (Nic, ledger integrate): what it
 *                          carries comes from where the books hold it — the
 *                          paid-ahead money GAM held that the move-out used is
 *                          already in Due from GAM (P4 C10 put it there): Cr
 *                          1050 for that (never more than the transfer); the
 *                          rest is deposit money GAM held: Cr Deposits GAM holds
 *                          for you (1070), on the move-out's lease. (The move-out
 *                          itself posts only the liability and income side,
 *                          P4 D3, so nothing moved it to 1050 before.)
 *   'flexcharge_merchant'  store charge accounts are not enabled (design F7):
 *                          it waits.
 * A business's transfer waits for the business portal's books (a later phase).
 * Pending and failed intents post nothing.
 */
import type { PoolClient } from 'pg'
import type { DesiredLine, DesiredPosting, LedgerProjector, LedgerSourceRef } from '../ledgerEngine'
import type { LedgerOwner } from '../ledgerOwner'
import { cr, dr, toCents, splitCents, waitsOnRule, localDaySql, companyTzSql, type LineExtra } from './registerBookingPayoutKit'
import { readerPieceLines, READER_PIECE_KIND } from './payoutGamCharges'

interface IntentRow {
  id: string; landlord_id: string | null; amount: string; gross_owed: string; netted_amount: string
  kept: string | null; status: string; transferred_at: string | null; purpose: string; deposit_return_id: string | null
  stripe_transfer_id: string | null; created_at_exact: string; day: string | null
}

async function loadIntent(client: PoolClient, intentId: string): Promise<IntentRow | null> {
  const r = await client.query<IntentRow>(
    `SELECT i.id, i.landlord_id, i.amount::text, i.gross_owed::text, i.netted_amount::text,
            i.gam_fees_kept_amount::text AS kept, i.status, i.transferred_at::text, i.purpose, i.deposit_return_id,
            i.stripe_transfer_id, i.created_at::text AS created_at_exact,
            CASE WHEN i.transferred_at IS NULL OR i.landlord_id IS NULL THEN NULL
                 ELSE ${localDaySql('i.transferred_at', companyTzSql('i.landlord_id'))} END AS day
       FROM platform_transfer_intents i WHERE i.id::text = $1`, [intentId])
  return r.rows[0] ?? null
}

/**
 * SQL: the paid-ahead money GAM held that a move-out (`returnExpr`, a
 * deposit_returns id) used — what the credit uses at that move-out put in Due
 * from GAM (1050, tenantCredits C10). 10/12 (Nic, ledger review): ONE figure for
 * the escrow settlement's posting (below) and the nightly 1050 check
 * (services/ledgerDueFromGamCheck), so the two never disagree.
 */
export function gamHeldPaidAheadAtMoveOutSql(returnExpr: string): string {
  return `COALESCE((SELECT sum(cu.amount) FROM credit_uses cu
                     JOIN lease_prepaid_credits pc ON pc.id = cu.prepaid_credit_id
                     LEFT JOIN tenant_remittances src ON src.id = pc.source_remittance_id
                    WHERE cu.deposit_return_id = ${returnExpr} AND cu.status IN ('applied', 'reversed') AND cu.applied_at IS NOT NULL
                      AND CASE WHEN pc.funded_by IS NOT NULL THEN pc.funded_by = 'gam'
                               ELSE COALESCE(src.payment_method IN ('card', 'ach') AND src.stripe_payment_intent_id IS NOT NULL, FALSE) END), 0)`
}

/** What of an escrow settlement transfer (`amountCents`) comes out of Due from GAM: the paid-ahead GAM held, never more than the transfer. */
export function escrowFromDueCents(amountCents: number, paidAheadCents: number): number {
  return Math.max(0, Math.min(amountCents, paidAheadCents))
}

/** Signed cents by property ('' = company level). */
type ByProperty = Map<string, number>
function add(m: ByProperty, property: string | null, cents: number): void {
  const k = property ?? ''
  m.set(k, (m.get(k) ?? 0) + cents)
}
/** `total` cents spread over a by-property map's positive amounts (company level when there are none). */
function spread(total: number, weights: ByProperty): ByProperty {
  const keys = [...weights.keys()].filter(k => (weights.get(k) ?? 0) > 0).sort()
  const out: ByProperty = new Map()
  if (!keys.length) { if (total) out.set('', total); return out }
  const pieces = splitCents(total, keys.map(k => weights.get(k)!))
  keys.forEach((k, i) => { if (pieces[i]) out.set(k, pieces[i]) })
  return out
}
const prop = (k: string): string | null => (k === '' ? null : k)

/**
 * A weekly batch's money by property: what it claimed (shares + held lines,
 * scaled to gross_owed), the reversals it netted, the GAM charges it kept, and
 * what went to the landlord's Stripe (1060). Exported for the payout (G3),
 * which splits its own amount the same way.
 */
export async function batchByProperty(client: PoolClient, i: IntentRow): Promise<{
  claimed: ByProperty; netted: ByProperty; kept: ByProperty; toStripe: ByProperty
}> {
  const stamps = [`intent:${i.id}`, `netted:${i.id}`, i.stripe_transfer_id].filter((x): x is string => !!x)
  const raw: ByProperty = new Map()
  for (const r of (await client.query<{ property_id: string | null; s: string }>(
    `SELECT property_id, SUM(amount)::text AS s FROM user_balance_ledger
      WHERE type = 'allocation_owner_share' AND reference_type = 'payment' AND stripe_transfer_id = ANY($1::text[])
      GROUP BY property_id`, [stamps])).rows) add(raw, r.property_id, toCents(r.s))
  for (const r of (await client.query<{ property_id: string | null; s: string }>(
    `SELECT property_id, SUM(amount)::text AS s FROM held_payout_items WHERE payout_intent_id::text = $1 GROUP BY property_id`,
    [i.id])).rows) add(raw, r.property_id, toCents(r.s))
  const gross = toCents(i.gross_owed)
  const rawTotal = [...raw.values()].reduce((a, b) => a + b, 0)
  // The claims add up to gross_owed (the batch summed exactly these); should a
  // stamp ever be missing, gross_owed is the figure, spread like the rest.
  const claimed = rawTotal === gross ? raw : spread(gross, raw)

  const nettedTotal = toCents(i.netted_amount)
  const nettedWeights: ByProperty = new Map()
  if (nettedTotal) {
    // The reversals this batch netted were resolved in its own transaction
    // (landlordPassthrough.applyReversalNetting: recovered_at = the batch's NOW()).
    for (const r of (await client.query<{ property_id: string | null; s: string }>(
      `SELECT u.property_id, SUM(pr.reversed_amount)::text AS s
         FROM payment_reversals pr
         LEFT JOIN payments p ON p.id = pr.payment_id
         LEFT JOIN units u ON u.id = p.unit_id
        WHERE pr.landlord_id = $1 AND pr.outcome = 'landlord_clawback' AND pr.recovered_at = $2::timestamptz
        GROUP BY u.property_id`, [i.landlord_id, i.created_at_exact])).rows) add(nettedWeights, r.property_id, toCents(r.s))
  }
  const netted = spread(nettedTotal, nettedWeights)

  const keptTotal = toCents(i.kept)
  const keptWeights: ByProperty = new Map()
  for (const r of (await client.query<{ property_id: string | null; s: string }>(
    `SELECT c.property_id, SUM(col.amount)::text AS s
       FROM landlord_gam_charge_collections col JOIN landlord_gam_charges c ON c.id = col.charge_id
      WHERE col.platform_transfer_intent_id::text = $1 GROUP BY c.property_id`, [i.id])).rows) add(keptWeights, r.property_id, toCents(r.s))
  const keptRaw = [...keptWeights.values()].reduce((a, b) => a + b, 0)
  const kept = keptRaw === keptTotal ? keptWeights : spread(keptTotal, keptWeights)

  // What reached the landlord's Stripe, at the properties the money left from.
  const residual: ByProperty = new Map()
  for (const [k, v] of claimed) add(residual, prop(k), v)
  for (const [k, v] of netted) add(residual, prop(k), -v)
  for (const [k, v] of kept) add(residual, prop(k), -v)
  const toStripe = spread(toCents(i.amount), residual)
  return { claimed, netted, kept, toStripe }
}

export const payoutTransferProjector: LedgerProjector = {
  sourceType: 'transfer_intent',
  // 2 (10/12 integrate): a move-out's escrow settlement leaves 1070 (and 1050 for paid-ahead GAM held).
  // 3 (10/13, Nic): a card reader piece the batch kept is a Supplies expense, not Due to GAM.
  ruleVersion: 3,

  async project(client: PoolClient, intentId: string): Promise<DesiredPosting[]> {
    const i = await loadIntent(client, intentId)
    if (!i || !i.landlord_id || i.status !== 'transferred' || !i.day) return []
    const owner = { landlordId: i.landlord_id }
    if (i.purpose === 'flexcharge_merchant') {
      throw waitsOnRule('A store charge-account merchant transfer posts once charge accounts are enabled (design F7).')
    }
    if (i.purpose === 'deposit_settlement') {
      const p = (await client.query<{ property_id: string | null; lease_id: string | null; paid_ahead: string }>(
        `SELECT u.property_id, dr.lease_id, ${gamHeldPaidAheadAtMoveOutSql('dr.id')}::text AS paid_ahead
           FROM deposit_returns dr JOIN leases l ON l.id = dr.lease_id JOIN units u ON u.id = l.unit_id
          WHERE dr.id = $1`, [i.deposit_return_id])).rows[0]
      const at: LineExtra = { propertyId: p?.property_id ?? null }
      const amt = toCents(i.amount)
      const fromDue = escrowFromDueCents(amt, toCents(p?.paid_ahead))
      const memo = 'Move-out deposit settlement sent to your Stripe account'
      return [{ owner, intendedDate: i.day, memo, lines: [
        ...dr('stripe_in_transit', amt, { ...at, memo }),
        ...cr('due_from_gam', fromDue, { ...at, memo: 'Paid-ahead money GAM held, used at move-out, sent to you' }),
        ...cr('deposits_gam_holds', amt - fromDue, { ...at, leaseId: p?.lease_id ?? null, memo: 'Deposit money GAM held, sent to you at move-out' }),
      ] }]
    }
    const b = await batchByProperty(client, i)
    // 10/13 (Nic): the card reader pieces this batch kept, by property — a
    // Supplies expense on the batch's day (never more than the batch kept there).
    const pieces: ByProperty = new Map()
    for (const r of (await client.query<{ property_id: string | null; s: string }>(
      `SELECT c.property_id, SUM(col.amount)::text AS s
         FROM landlord_gam_charge_collections col JOIN landlord_gam_charges c ON c.id = col.charge_id
        WHERE col.platform_transfer_intent_id::text = $1 AND c.kind = $2 GROUP BY c.property_id`, [i.id, READER_PIECE_KIND])).rows) {
      add(pieces, r.property_id, toCents(r.s))
    }
    const lines: DesiredLine[] = []
    for (const [k, v] of b.claimed) lines.push(...cr('due_from_gam', v, { propertyId: prop(k), memo: 'Paid out in this week\'s batch' }))
    for (const [k, v] of b.netted) lines.push(...dr('due_from_gam', v, { propertyId: prop(k), memo: 'A reversed payment repaid from this batch' }))
    for (const [k, v] of b.kept) {
      const piece = Math.min(pieces.get(k) ?? 0, v)
      lines.push(...dr('due_to_gam', v - piece, { propertyId: prop(k), memo: 'GAM charges taken from this batch' }))
      lines.push(...await readerPieceLines(client, {
        landlordId: i.landlord_id, propertyId: prop(k), cents: piece, day: i.day, recorded: { at: i.transferred_at }, side: 'dr' }))
    }
    for (const [k, v] of b.toStripe) lines.push(...dr('stripe_in_transit', v, { propertyId: prop(k), memo: 'Sent to your Stripe account' }))
    return [{ owner, intendedDate: i.day, memo: 'Weekly payout batch', lines }]
  },

  async listSources(client: PoolClient, owner: LedgerOwner, opts: { since?: string | null }): Promise<LedgerSourceRef[]> {
    if (!owner.landlordId) return []
    const r = await client.query<{ id: string; day: string | null }>(
      `SELECT i.id::text AS id,
              CASE WHEN i.transferred_at IS NULL THEN NULL ELSE ${localDaySql('i.transferred_at', companyTzSql('i.landlord_id'))} END AS day
         FROM platform_transfer_intents i
        WHERE i.landlord_id = $1 AND ($2::date IS NULL OR COALESCE(i.transferred_at, i.created_at) >= $2::date - INTERVAL '1 day')`,
      [owner.landlordId, opts.since ?? null])
    return r.rows
  },
}

export { loadIntent }

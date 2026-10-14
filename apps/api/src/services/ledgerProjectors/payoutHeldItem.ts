/**
 * 10/12 (Nic) — GAM BOOKS LEDGER, PHASE P5: WHAT GAM HOLDS FOR A LANDLORD, LINE BY LINE
 * (gam-ledger-design-2026-10-12 §6 G4, E2, F4; Nic's 10/12 answer L13)
 *
 * Source 'held_item' = one held_payout_items row: a line GAM owes (or takes
 * from) a landlord on their next payout. Each money movement has exactly ONE
 * posting owner (design §1), so a held line posts only what no other source
 * does — the releases, GAM's processing fee on a charge whose rows had no held
 * share, Stripe's kept dispute fee, and a chargeback on a register sale or a
 * stay deposit. On the line's day (its property's calendar):
 *
 *   deposit_settlement  > 0   deposit money GAM held, released at move-out
 *                             (kept:<move-out>, a payment GAM may not hold,
 *                             cash-part:<part>):  Dr 1050 / Cr Deposits GAM
 *                             holds for you (1070)
 *                       < 0   GAM's own lines a deposit the landlord holds
 *                             paid (gam_lines:<move-out>, a negative escrow
 *                             settlement):  Dr Security deposits payable (2020)
 *                             / Cr 1050
 *   platform_fee              the processing fee the landlord covers on a
 *                             charge none of whose rows had a held share
 *                             (processing_fee:<intent>):  Dr Processing fees
 *                             (5115) / Cr 1050
 *   dispute  stripe_fee_kept:…  Stripe's fee on a disputed rent charge (E2):
 *                             Dr Chargeback and return fees (5116) / Cr 1050;
 *                             given back on a win (…:returned_on_win, positive):
 *                             the mirror
 *   dispute  <dispute id>     a chargeback on a register sale or a stay deposit
 *                             (F4): the sale's (or deposit's) share before tax
 *                             off Sales returns (4520, goods) / Stay income
 *                             (4400, a stay), its tax back to the tax payable,
 *                             the rest (Stripe's dispute fee, the card fee) to
 *                             5116; Cr 1050 the line. Won (…:returned_on_win,
 *                             positive): the mirror. Received goes down that day.
 *
 *   refund  gam_debit_dispute_won:<pull>:<charge>, gam_charge_voided:<charge>
 *                             10/13 (Nic): "Won GAM pull dispute: AUTOMATIC (back
 *                             to collected; anything collected twice credited
 *                             back)" — a GAM charge GAM collected twice (the
 *                             disputed pull took it, and a payout or a later
 *                             pull took it again before the win), or collected
 *                             and then voided (a dispute's cost the win or a
 *                             re-bill took back), given back on the next payout
 *                             (services/landlordGamDebit): the second collection
 *                             debited Due to GAM a second time, so the line
 *                             credits it back — Dr 1050 / Cr Due to GAM (2080),
 *                             at the charge's property. A card reader piece is
 *                             never owed (its collection was a Supplies expense):
 *                             Dr 1050 / Cr Supplies (5140)
 *
 * Posts nothing (their source already did; they only feed the nightly 1050
 * check): 'prepaid_draw' — Nic L13: money paid ahead that GAM holds is NOT on
 * the landlord's books until it pays a bill, so there is no 1055 balance to
 * release from; the credit use that spends it (a bill, "Keep it", a move-out)
 * or the refund part that hands it back in cash posts it into 1050 (P4,
 * design C1/C7/C10/D4) — 'pos_sale' (registerSale), 'booking_deposit' (bookingStay), any other 'refund'
 * (an early check-out's refund part — design D4 — and Stripe's kept fee on a
 * refunded set-aside payment — registerHeld), and the dispute lines of a rent
 * dispute's owner share ('owner_share_…': the payment reversal and the
 * paid-ahead money it touched post those — design E1, C9). A business's line
 * waits for the business portal's own books (a later phase).
 */
import type { PoolClient } from 'pg'
import type { DesiredLine, DesiredPosting, LedgerProjector, LedgerSourceRef } from '../ledgerEngine'
import type { LedgerOwner } from '../ledgerOwner'
import {
  cr, dr, toCents, splitCents, taxLines, scaleTaxParts, loadSale, saleMakeUp, missingFact, localDaySql,
  propertyTzSql, LODGING_TAX_NAME, type LineExtra,
} from './registerBookingPayoutKit'
import { loadStay, stayParts } from './incomeLines'
import { READER_PIECE_KIND, readerPieceLines } from './payoutGamCharges'

const WON = ':returned_on_win'

/**
 * 10/13 (Nic): the payout lines that give a landlord back a GAM charge
 * collected twice, or collected and then voided (services/landlordGamDebit
 * gamDebitWonGiveBackSourceId / gamChargeVoidedGiveBackSourceId — held to these
 * by ledgerGamDebitDisputeWon.test.ts). The charge is the last part.
 */
export const GAM_CHARGE_GIVE_BACK_PREFIXES = ['gam_debit_dispute_won:', 'gam_charge_voided:'] as const
export function gamChargeGivenBack(sourceType: string, sourceId: string): string | null {
  if (sourceType !== 'refund' || !GAM_CHARGE_GIVE_BACK_PREFIXES.some(p => sourceId.startsWith(p))) return null
  const id = sourceId.split(':').pop() ?? ''
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? id : null
}

interface HeldRow {
  id: string; landlord_id: string | null; property_id: string | null; source_type: string; source_id: string
  amount: string; day: string
}

/** A chargeback (amount < 0) or its give-back on a win (amount > 0) on a register sale or a stay deposit (design F4). */
async function chargebackLines(client: PoolClient, h: HeldRow): Promise<DesiredLine[]> {
  const line = toCents(h.amount)
  const won = h.source_id.endsWith(WON)
  const disputeId = won ? h.source_id.slice(0, -WON.length) : h.source_id
  const cd = (await client.query<{ pi: string | null; amount: string }>(
    `SELECT stripe_payment_intent_id AS pi, amount::text AS amount FROM connect_disputes WHERE stripe_dispute_id = $1`,
    [disputeId])).rows[0]
  if (!cd?.pi) throw missingFact(`The chargeback ${disputeId} names no card charge GAM has on record.`)
  const disputed = toCents(cd.amount)
  // sign: a chargeback takes money (Dr income, Dr tax, Cr 1050); a win gives it back.
  const sign = line < 0 ? 1 : -1
  const at: LineExtra = { propertyId: h.property_id }
  const back: LineExtra = { cashEffect: 'in', reportCategory: 'refunds' }
  const out: DesiredLine[] = []

  const saleRow = (await client.query<{ id: string }>(
    `SELECT id::text FROM pos_transactions WHERE stripe_payment_intent_id = $1 AND landlord_id = $2 ORDER BY created_at LIMIT 1`,
    [cd.pi, h.landlord_id])).rows[0]
  if (saleRow) {
    const sale = (await loadSale(client, saleRow.id))!
    const mk = await saleMakeUp(client, sale)
    const total = toCents(sale.total)
    const taken = Math.min(disputed, total)
    const income = total > 0 ? Math.round((taken * mk.preTaxCents) / total) : 0
    const tax = total > 0 ? Math.round((taken * toCents(sale.tax_amount)) / total) : 0
    const parts = splitCents(income, [Math.max(0, mk.goodsPreTaxCents), ...mk.stays.map(s => Math.max(0, s.preTaxCents))])
    const saleAt: LineExtra = { propertyId: sale.property_id, tenantId: sale.tenant_id }
    out.push(...dr('sales_returns', sign * (parts[0] ?? 0), { ...saleAt, ...back, memo: 'Chargeback on a register sale' }))
    // 10/14 (Nic I1, I2): off the stay's own line, where it was earned.
    for (const [i, s] of mk.stays.entries()) {
      const stay = await loadStay(client, s.bookingId)
      for (const p of stayParts(stay, sign * (parts[i + 1] ?? 0))) {
        out.push(...dr(p.role, p.cents, {
          propertyId: s.propertyId ?? sale.property_id, unitId: s.unitId, tenantId: s.tenantId, ...back, sub: p.sub, memo: 'Chargeback on stay money',
        }))
      }
    }
    out.push(...taxLines(scaleTaxParts(mk.taxParts, sign * tax), 'dr', { ...saleAt, cashEffect: 'in', reportCategory: 'tax_collected' }))
  } else {
    const dep = (await client.query<{ booking_id: string; property_id: string | null; unit_id: string | null; tenant_id: string | null; toward: string | null; tax: string | null }>(
      `SELECT b.id::text AS booking_id, u.property_id, b.unit_id, b.tenant_id, sp.toward_stay::text AS toward, sp.lodging_tax_amount::text AS tax
         FROM unit_bookings b
         LEFT JOIN units u ON u.id = b.unit_id
         LEFT JOIN stay_payments sp ON sp.booking_id = b.id AND sp.kind = 'site_deposit'
        WHERE b.stripe_payment_intent_id = $1 AND b.landlord_id = $2`, [cd.pi, h.landlord_id])).rows[0]
    if (!dep?.toward) throw missingFact(`The chargeback ${disputeId} is on a charge that is neither a register sale nor a booking-site deposit.`)
    if (dep.tax == null) throw missingFact('The disputed booking-site deposit does not say how much lodging tax it carried.')
    const toward = toCents(dep.toward)
    const taken = Math.min(disputed, toward)
    const tax = toward > 0 ? Math.round((taken * toCents(dep.tax)) / toward) : 0
    const stayAt: LineExtra = { propertyId: dep.property_id, unitId: dep.unit_id, tenantId: dep.tenant_id }
    for (const p of stayParts(await loadStay(client, dep.booking_id), sign * (taken - tax))) {
      out.push(...dr(p.role, p.cents, { ...stayAt, ...back, sub: p.sub, memo: 'Chargeback on a stay deposit' }))
    }
    out.push(...dr('lodging_tax_payable', sign * tax, { ...stayAt, cashEffect: 'in', reportCategory: 'tax_collected', taxName: LODGING_TAX_NAME }))
  }
  // The line itself, and the rest of it — Stripe's dispute fee and the card fee — to chargeback fees.
  const taken = out.reduce((a, l) => a + (l.debitCents ?? 0) - (l.creditCents ?? 0), 0)
  out.push(...cr('due_from_gam', -line, { ...at, memo: won ? 'Chargeback given back: the dispute was won' : 'Chargeback taken from the money GAM holds for you' }))
  out.push(...dr('chargeback_fees', -line - taken, { ...at, memo: 'Chargeback fees' }))
  return out
}

export const payoutHeldItemProjector: LedgerProjector = {
  sourceType: 'held_item',
  // 10/13 (Nic): 2 — a GAM charge given back on a payout (a won pull dispute, a voided collected charge).
  // 3 — 10/14 (Nic I1, I2): a chargeback on stay money comes off the stay's own line (incomeLines).
  ruleVersion: 3,

  async project(client: PoolClient, itemId: string): Promise<DesiredPosting[]> {
    const h = (await client.query<HeldRow & { created_at: string }>(
      `SELECT h.id, h.landlord_id, h.property_id, h.source_type, h.source_id, h.amount::text, h.created_at::text,
              ${localDaySql('h.created_at', propertyTzSql('h.property_id', 'h.landlord_id'))} AS day
         FROM held_payout_items h WHERE h.id::text = $1`, [itemId])).rows[0]
    // A business's line waits for the business portal's books (a later phase).
    if (!h || !h.landlord_id) return []
    const a = toCents(h.amount)
    const at: LineExtra = { propertyId: h.property_id }
    let lines: DesiredLine[] = []
    let memo = ''
    switch (h.source_type) {
      case 'deposit_settlement':
        if (a > 0) {
          memo = 'Deposit money GAM held, released to you at move-out'
          lines = [...dr('due_from_gam', a, { ...at, memo }), ...cr('deposits_gam_holds', a, { ...at, memo })]
        } else {
          memo = 'GAM\'s own charges a deposit you hold paid, taken from your payout'
          lines = [...dr('security_deposits_payable', -a, { ...at, memo }), ...cr('due_from_gam', -a, { ...at, memo })]
        }
        break
      case 'platform_fee':
        memo = 'Processing fee you cover, taken from your payout'
        lines = [...dr('processing_fees', -a, { ...at, memo }), ...cr('due_from_gam', -a, { ...at, memo })]
        break
      case 'dispute':
        if (h.source_id.startsWith('owner_share_')) return []
        if (h.source_id.startsWith('stripe_fee_kept:')) {
          memo = a < 0 ? 'Stripe\'s dispute fee on a disputed payment' : 'Stripe\'s dispute fee given back: the dispute was won'
          lines = [...dr('chargeback_fees', -a, { ...at, memo }), ...cr('due_from_gam', -a, { ...at, memo })]
        } else {
          memo = a < 0 ? 'Chargeback' : 'Chargeback given back'
          lines = await chargebackLines(client, h)
        }
        break
      case 'refund': {
        // 10/13 (Nic): a GAM charge given back (collected twice, or collected
        // and voided). Any other refund line: its own source posts it.
        const chargeId = gamChargeGivenBack(h.source_type, h.source_id)
        if (!chargeId || a <= 0) return []
        const c = (await client.query<{ kind: string }>(
          `SELECT kind FROM landlord_gam_charges WHERE id = $1 AND landlord_id = $2`, [chargeId, h.landlord_id])).rows[0]
        if (!c) throw missingFact(`The GAM charge ${chargeId} this payout line gives back is not on record for the company.`)
        memo = h.source_id.startsWith('gam_charge_voided:')
          ? 'GAM charge taken back after it was collected: given back on your payout'
          : 'GAM charge collected twice (your bank\'s dispute on a fee pull was won): given back on your payout'
        lines = [
          ...dr('due_from_gam', a, { ...at, memo }),
          ...(c.kind === READER_PIECE_KIND
            ? readerPieceLines({ propertyId: h.property_id, cents: a, side: 'cr' })
            : cr('due_to_gam', a, { ...at, memo })),
        ]
        break
      }
      default:
        // 'prepaid_draw' (L13), 'pos_sale', 'booking_deposit': their own source posts them.
        return []
    }
    if (!lines.length) return []
    return [{ owner: { landlordId: h.landlord_id }, intendedDate: h.day, memo, lines }]
  },

  async listSources(client: PoolClient, owner: LedgerOwner, opts: { since?: string | null }): Promise<LedgerSourceRef[]> {
    if (!owner.landlordId) return []
    const r = await client.query<{ id: string; day: string }>(
      `SELECT h.id::text AS id, ${localDaySql('h.created_at', propertyTzSql('h.property_id', 'h.landlord_id'))} AS day
         FROM held_payout_items h
        WHERE h.landlord_id = $1
          AND (h.source_type IN ('deposit_settlement', 'platform_fee', 'dispute')
               OR (h.source_type = 'refund' AND (h.source_id LIKE 'gam_debit_dispute_won:%' OR h.source_id LIKE 'gam_charge_voided:%')))
          AND ($2::date IS NULL OR h.created_at >= $2::date - INTERVAL '1 day')`,
      [owner.landlordId, opts.since ?? null])
    return r.rows
  },
}

// apps/api/src/services/paymentReversal.ts
//
// S561 (money-flow platform-holds, Phase 3): post-settlement reversal handler.
//
// A payment that already SETTLED (and was batched to the landlord) is taken
// back — a card chargeback, or an ACH unauthorized return Stripe sends as a
// dispute (up to 60 days on), or a late ACH return once its event is wired at
// C3. Stripe pulls the funds back from GAM's platform balance, but the landlord
// already has the money. This handler reopens what the tenant owes and records
// the landlord receivable. Reclaiming the cash from the landlord (net vs ACH
// pull) is the recovery engine's (services/reversalRecovery.ts).
//
// S655 (money plan §3 "Dispute", Step 10) — ONE CHARGE, EVERY ROW IT PAID:
//
//   Until now a dispute reopened ONE rent or utility row (LIMIT 1) and
//   payment_reversals allowed one record per event, so a dispute on a Pay Now
//   that paid rent + water + a late fee reopened the rent and silently left the
//   rest paid — the landlord kept money Stripe took back from GAM. Now:
//
//   - Every row the disputed charge paid reopens: the landlord's rows AND GAM's
//     own rows. A row is "paid by the charge" when it carries the charge's
//     intent and settled through it (never a row a desk settled under an old,
//     bounced intent: manual_method is set on those). A row an EARLIER event
//     already marked 'returned' for its paid-ahead part only (a credit_spend
//     reopen: the money behind that credit was disputed first) still holds
//     this charge's own money and is a row the charge paid too: it loses its
//     money part less whatever of its money an earlier record already took
//     back (records on it less its reversed credit uses), so its own money is
//     reopened once and never twice, whichever dispute arrives first.
//   - One payment_reversals record per (event, row) (M11's unique index):
//     reversed_amount = what THAT row lost. The original row goes 'returned'
//     and a fresh 'pending' row is written for the amount it lost, with its
//     original due date (late fees back-fill from it) and reversal_id set — so
//     it is never paid by credit (moneyPredicates.creditEligibleRowSql) and its
//     re-payment resolves the reversal (resolveReversalOnTenantPayment).
//   - What a row lost is its MONEY part (v_payment_money.money_part). Credit
//     uses on the disputed charge stay 'applied' (money plan §7, R1-1): credit
//     is never given back, so nothing can be spent or paid out twice, and the
//     tenant owes again only the money the dispute took.
//   - If the charge also banked paid-ahead money (the remittance's surplus),
//     that money goes first (creditUse.clawBackDisputedCharge): the unspent
//     part is taken back; each spend of it on a later bill is undone
//     (applied → reversed) and THAT row reopens for the use amount, with its
//     own record in this event.
//   - A partial dispute takes the surplus first (unspent, then set aside, then
//     spent), then the charge's rows NEWEST first, until the disputed amount is
//     met. A row that lost nothing still gets a $0 record naming the event
//     ('not_needed', 'resolved') — the record a take-back of the credit names.
//     When the rows' own money cannot take what the surplus leaves (a row the
//     charge's banked money paid holds no money of its own), spends are undone
//     whole until the claim is met, and only the claimed dollars come off the
//     credit; what still cannot be placed is told to an admin
//     ('payment_reversal_short') — never left on nobody (Step 10, pass 4).
//   - MORE THAN ONE DISPUTE ON A CHARGE (fix pass rev8): each event is
//     counted with the disputes of the charge already handled
//     (cumulativeDisputeSplit) — the money first, the card fee only past the
//     money — and a row an earlier dispute reopened in part still gives the
//     rest of its money to a later one ($60 then $20 on $50 rent + $51 paid
//     ahead: $51 + $9, then $20 more of the rent). A later dispute's card-fee
//     part is named to settle by hand ('payment_reversal_short', with
//     creditUse's 'dispute_second_on_charge' notice: the same money, settled
//     once), never netted from a landlord here. What no bill or paid-ahead
//     money can carry is told whenever the charge has rows, even when an
//     earlier dispute already reopened them all.
//   - ONLY MONEY STRIPE TOOK (fix pass 2): an inquiry (warning_*, a bank's
//     question before a dispute) moves no money and reverses nothing — an
//     admin is told once ('dispute_inquiry_open'); the event that turns it
//     into a dispute reverses it. Each Stripe dispute or return is taken back
//     ONCE, whatever event brings it (later events for it change nothing).
//     Step 10 final fix (decisions #55): the webhook calls this on EVERY
//     dispute event (created, updated, funds_withdrawn, closed) with the
//     dispute's status, so the escalation is reversed by whichever event
//     says money was taken — once, on the dispute id.
//   - A DISPUTE GAM WINS (decisions #55-AMENDED) is undone BY HAND for this
//     deploy: the webhook raises one critical notice per won dispute
//     (raiseWonDisputeNotice, below) listing the reopened rows to void, the
//     landlord's share to give back, the paid-ahead money to restore and the
//     fee lines, with amounts — nothing is changed automatically.
//     undoWonDispute (the automatic undo) is kept for the follow-up and is not
//     called. Stripe put the money back, so from the win on its records take
//     nothing from a row in the dispute counts (creditUse.liveReversalSql):
//     a later dispute of the same charge is counted without them.
//   - The pass-through dispute/return fee is billed to the tenant ONCE per
//     Stripe object (a GAM 'fee' row, RETURNFEE), at what Stripe charged, and
//     recorded on one record: a second event for the same dispute or return
//     writes $0 fee records.
//   - The card or bank fee the dispute took back is the landlord's, never
//     GAM's (decisions #38 Q4, FINAL: "GAM absorbs nothing and keeps the card
//     fee it already earned. Same treatment as a chargeback"; #22; CLAUDE.md
//     S512). GAM's spread booked on the charge STAYS booked, and the whole fee
//     the dispute took back (Stripe's kept cost plus GAM's spread) is one
//     negative line on the landlord's next payout (held_payout_items,
//     'dispute', 'stripe_fee_kept:…', once per charge and landlord). This
//     replaces money plan §3's "negative adjustment for GAM's spread"
//     (DISPUTE_FEE_RULE). On a property where the landlord pays the bank fee
//     the fee was never on top of the charge: their owner share was already
//     the money less the fee, so what they give back for the row (below)
//     carries it — the same rule, nothing netted twice. A charge that paid
//     none of the landlord's rows and banked no paid-ahead money was GAM's own
//     (a GAM fee): GAM was its recipient and bears it.
//   - A dispute or return that finds nothing to reverse on a charge GAM knows
//     (its rows or receipt carry the intent) is told to an admin, loudly:
//     Stripe took the money back and nothing was reopened.
//   - A FlexPay pull is GAM's own money: its row is never reopened; the
//     FlexPay handler writes its advance off (flexpay.handleFlexPayPullReversed)
//     in the same transaction.
//   - Each landlord is told ONCE per event, with the total the tenant owes
//     again on THAT landlord's rows (a neighbor landlord's utility on the same
//     bill is told to its own landlord, never to the other — audience
//     isolation); the recovery engine decides ONE recovery per event and
//     landlord across its rows.
//   - WHAT THE LANDLORD GIVES BACK (Step 10 review, pass 2): only what they
//     were actually paid. A row's owner share sits on GAM's balance until the
//     Tuesday batch pays it, and the batch never pays a 'returned' row, so:
//       · the part of the share not paid out yet is WITHHELD — its ledger rows
//         are stamped 'withheld:<record>' (never paid by any batch) and counts
//         as recovered on the spot (recovered_amount; 'recovered' when it
//         covers the loss), so when the tenant pays again the landlord is paid
//         again (allocation) and is never short;
//       · what of that unpaid share the row did NOT lose (a $400 row of which
//         only a $300 credit part was disputed) is still the landlord's: one
//         positive held_payout_items line ('dispute', owner_share_untouched:
//         <record>) pays it on the next batch;
//       · only the part already paid out is recovered from the landlord
//         ('pending': netting or a pull, reversalRecovery);
//       · a row a second event reaches again withholds first from what the
//         first left unpaid on its held line (a negative line nets it).
//     So a dispute before the payout never takes the money twice (the share
//     stranded AND a recovery), and one after it recovers exactly what went out.
//   - GAM-first money (payments.gam_supersedence_amount, money the charge
//     routed to the tenant's GAM balances before the landlord's share) is
//     never the landlord's: it is the first part of a row's money a dispute
//     takes, never recovered from the landlord, and the GAM balances it paid
//     are opened again (flexpay.reopenGamFirstBalances) — what a dispute took
//     back the tenant owes again, exactly as before they paid, and ONCE: the
//     reopened landlord row asks only for the rest (lost − routed; no row
//     when that is 0), so the routed part is owed only on the GAM balance.
//
// HELD LINES THIS FILE WRITES (source 'dispute'): 'owner_share_untouched:',
// 'owner_share_withheld:' and 'owner_share_returned:' move the landlord's own
// rent share between payouts (rent already counted on the rows — never
// income), and 'stripe_fee_kept:' is the landlord's fee cost. Every reader of
// 'dispute' held lines must tell these from a register/stay chargeback
// (heldPayouts.recordChargeback, source id = Stripe's dispute id):
// disputeShareLineSql and disputeFeeLineSql (below) say which is which.
//
// Idempotent per event: an event with any record is done (a redelivered
// dispute changes nothing). Runs under the household lock (§1.5), the tenant
// row (the FlexPay order: tenant before advances), the weekly payout's lock for
// every landlord the charge paid (so a batch claiming owner shares and a
// reversal withholding them never interleave), then a lock on the charge, then
// its rows in id order.
//
// DEPLOY NOTE: until contract step C0 drops the old UNIQUE(stripe_event_id),
// a second record for the same event is refused by it: a dispute touching two
// or more rows then fails, rolls back whole, and Stripe redelivers it once C0
// is in (minutes after the restart; production has no disputes).

import type { PoolClient } from 'pg'
import { getClient, queryOne, query } from '../db'
import { createAdminNotification } from './adminNotifications'
import { logger } from '../lib/logger'
import type { PaymentReversalType, PrepaidFundedBy } from '@gam/shared'
import { lockHousehold } from './moneyPredicates'

const toCents = (v: number | string | null | undefined): number => Math.round(Number(v ?? 0) * 100)
const toDollars = (c: number): number => Math.round(c) / 100

export interface PaymentReversalInput {
  /** The charge Stripe took back. */
  paymentIntentId?: string | null
  /**
   * Older callers: one settled row. Its charge's intent is used when it has one
   * (every row of that charge reopens); a row with no intent reopens alone.
   */
  paymentId?: string | null
  reversalType:      PaymentReversalType
  /**
   * Dollars Stripe took back (a dispute's amount, card fee included). Leave it
   * out for a bank return or a dispute of the whole charge.
   */
  reversedAmount?:   number | null
  reversalFee:       number          // what Stripe charged GAM for the event; passed through to the tenant at cost
  stripeEventId:     string          // idempotency
  stripeObjectId?:   string | null   // dispute id / charge id / refund id
  connectDisputeId?: string | null   // connect_disputes.id for card disputes
  /**
   * Fix pass 2 (review): the dispute's Stripe status at this event, when the
   * caller knows it. Left out, it is read off the raw dispute event, else off
   * the dispute on file (connect_disputes). Only a status under which Stripe
   * holds the money (creditUse.DISPUTE_STATUSES_MONEY_TAKEN) reverses
   * anything: an inquiry (warning_*) moves no money.
   */
  disputeStatus?:    string | null
  rawEvent:          unknown         // raw webhook payload, stored append-only
}

export interface ReopenedRow {
  /** The row that lost money (now 'returned'), or a row that lost nothing (still 'settled'). */
  paymentId: string
  reversalId: string
  /** The fresh pending row the tenant pays again; null when the row lost nothing. */
  newPaymentId: string | null
  /** Dollars this row lost (the record's reversed_amount). */
  lost: number
  /**
   * Dollars the tenant owes again on the reopened row (newPaymentId's amount):
   * what the row lost less its GAM-first money, which is owed again on the GAM
   * balance it paid instead. 0 when no row was reopened.
   */
  owedAgain: number
  revenueOwner: string
  /** The row's landlord (a neighbor's utility on the same bill has its own). */
  landlordId: string
  /** Part of what the row lost was paid out to the landlord: GAM recovers that part from them (netting or a pull). */
  landlordRecovery: boolean
  /** Dollars of the landlord's unpaid owner share withheld for this loss (never paid out; counts as recovered). */
  withheld: number
  /** Dollars of GAM-first money the row lost (never the landlord's; its GAM balances are opened again). */
  routed: number
  /** 'charge': a row the charge paid. 'credit_spend': a later row the charge's paid-ahead money paid. */
  kind: 'charge' | 'credit_spend'
  /** GAM balances the row's GAM-first money paid that could not be opened again here: a person does it. */
  gamBalancesByHand?: Array<{ source: string; ref_id: string; amount: number }>
  /** Cents of GAM-first money lost that no whole GAM balance could carry (told to an admin). */
  routedUnplacedCents?: number
}

export interface PaymentReversalResult {
  handled:     boolean
  reason?:     string
  /** The event's first record (older callers). */
  reversalId?: string
  reversalIds: string[]
  rows:        ReopenedRow[]
  /** Dollars the tenant owes again across every reopened row. */
  reopenedTotal: number
  /** Dollars of reopened landlord rows, every landlord together. */
  landlordTotal: number
  /** The same, per landlord: what EACH landlord is told (one notice each). */
  landlordTotals: Record<string, number>
  /** Dollars of the charge's paid-ahead money taken back or claimed. */
  creditClawed: number
  feeRowId:    string | null
  /** Dollars of GAM's banking spread taken off the book (always 0 under the rule in force: GAM keeps it). */
  spreadReversed: number
  /** Dollars of the fee the dispute took back netted from landlords' next payouts (DISPUTE_FEE_RULE). */
  stripeFeeKept: number
}

const REVERSAL_FEE_DESCRIPTION: Record<PaymentReversalType, string> = {
  ach_return:       'ACH return fee (passed through at cost)',
  ach_unauthorized: 'ACH unauthorized-return fee (passed through at cost)',
  card_dispute:     'Card dispute fee (passed through at cost)',
}

/** The note on a reopened row: the original's own description first, so every namer reads the line as it was. */
export const REOPENED_NOTE = 'reopened after a payment reversal'

function reopenedNotes(origNotes: string | null): string {
  const head = (origNotes ?? '').split(' — ')[0].trim()
  return head ? `${head} — ${REOPENED_NOTE}` : `Reopened after a payment reversal`
}

interface ChargeRow {
  id: string; type: string; status: string; amount: string; invoice_id: string | null
  tenant_id: string | null; landlord_id: string; lease_id: string | null; unit_id: string | null
  due_date: string; entry_description: string | null; revenue_owner: string; lease_fee_id: string | null
  notes: string | null; created_at: Date; money_part: string
}

const NONE = (reason: string): PaymentReversalResult => ({
  handled: false, reason, reversalIds: [], rows: [], reopenedTotal: 0, landlordTotal: 0, landlordTotals: {},
  creditClawed: 0, feeRowId: null, spreadReversed: 0, stripeFeeKept: 0,
})

/**
 * WHO BEARS THE CARD OR BANK FEE A DISPUTE TOOK BACK, for a fee paid on top of
 * the charge (a fee the landlord paid was never on top: their share already
 * carried it).
 *   'landlord_bears_whole_fee' — IN FORCE (decisions #38 Q4, Nic 10/3, FINAL:
 *     "GAM absorbs nothing and keeps the card fee it already earned. Same
 *     treatment as a chargeback"): GAM's spread stays booked, and the
 *     landlord's next payout carries the WHOLE fee the dispute took (Stripe's
 *     kept cost plus GAM's spread).
 *   'gam_gives_up_spread' — money plan §3's earlier rule, superseded by #38:
 *     GAM's spread is reversed in platform revenue and the landlord carries
 *     only Stripe's own kept cost.
 */
export type DisputeFeeRule = 'gam_gives_up_spread' | 'landlord_bears_whole_fee'
export const DISPUTE_FEE_RULE = 'landlord_bears_whole_fee' as DisputeFeeRule

/**
 * Cents of a disputed charge's fee its landlords carry under `rule`: Stripe's
 * kept cost (the fee booked less GAM's spread), or the whole fee, for the
 * share of the fee the dispute took (`feeTaken` of `feeTotal`).
 */
export function disputeFeeBorneCents(
  rule: DisputeFeeRule,
  a: { feeCents: number; spreadCents: number; feeTaken: number; feeTotal: number },
): number {
  const borne = rule === 'landlord_bears_whole_fee' ? a.feeCents : a.feeCents - a.spreadCents
  if (borne <= 0) return 0
  const share = a.feeTotal > 0 ? Math.min(1, a.feeTaken / a.feeTotal) : 1
  return Math.max(0, Math.round(borne * share))
}

/** The weekly payout's own lock key (landlordPassthrough.reservePlatformHeldBatch). */
const payoutLockKey = (landlordId: string) => `platform_held_reconcile:${landlordId}`

/**
 * SQL, on a held_payout_items alias: a line this file wrote for the landlord's
 * OWN share of a disputed row ('owner_share_…') — rent already counted on the
 * rows, moving between payouts. Never income, never a chargeback: a reader of
 * 'dispute' lines leaves it out.
 */
export function disputeShareLineSql(h: string): string {
  return `(${h}.source_type = 'dispute' AND ${h}.source_id LIKE 'owner\\_share\\_%')`
}

/**
 * SQL, on a held_payout_items alias: the card or bank fee a dispute took back,
 * netted from a landlord's payout ('stripe_fee_kept:…', negative). The
 * landlord's cost (shown beside the total, like a chargeback's fees), never a
 * register sale or income.
 */
export function disputeFeeLineSql(h: string): string {
  return `(${h}.source_type = 'dispute' AND ${h}.source_id LIKE 'stripe\\_fee\\_kept:%')`
}

/** Held-line source ids for a record's owner share (held_payout_items, source 'dispute'). */
const untouchedShareSource = (reversalId: string) => `owner_share_untouched:${reversalId}`
const withheldShareSource = (reversalId: string) => `owner_share_withheld:${reversalId}`
const returnedShareSource = (reversalId: string) => `owner_share_returned:${reversalId}`
/** A cash repayment of a reopened move-out deposit charge the landlord took: the part that refills GAM (decisions #54). */
const refillShareSource = (reversalId: string) => `owner_share_refill:${reversalId}`
/** The stamp on an owner-share ledger row a record withheld (never paid by a batch). */
const withheldStamp = (reversalId: string) => `withheld:${reversalId}`

/** The household a charge belongs to (its receipt's, else its rows'): the lock every money writer takes first. */
async function chargeHousehold(
  pi: string | null, onlyRowId: string | null,
): Promise<{ tenantId: string; landlordId: string } | null> {
  if (pi) {
    const rem = await queryOne<{ tenant_id: string; landlord_id: string }>(
      `SELECT tenant_id, landlord_id FROM tenant_remittances
        WHERE stripe_payment_intent_id = $1 ORDER BY created_at, id LIMIT 1`, [pi])
    if (rem) return { tenantId: rem.tenant_id, landlordId: rem.landlord_id }
  }
  const row = await queryOne<{ tenant_id: string | null; landlord_id: string }>(
    `SELECT p.tenant_id, COALESCE(l.landlord_id, p.landlord_id) AS landlord_id
       FROM payments p LEFT JOIN leases l ON l.id = p.lease_id
      WHERE ${pi ? 'p.stripe_payment_intent_id = $1' : 'p.id = $1::uuid'} AND p.tenant_id IS NOT NULL
      ORDER BY (p.type = 'rent') DESC, p.id LIMIT 1`, [pi ?? onlyRowId])
  return row?.tenant_id ? { tenantId: row.tenant_id, landlordId: row.landlord_id } : null
}

/**
 * Write one row's record for this event and, when it lost money, reopen it:
 * the original goes 'returned' and a fresh 'pending' row is written for the
 * amount lost less its GAM-first money (that part is owed again on the GAM
 * balance it paid; gam_supersedence_amount is never copied) — type, entry,
 * owner and lease fee copied, so a disputed
 * non-refundable pet fee stays the landlord's income and a GAM row stays
 * GAM's). Its utility bill is owed again. Returns the record and the new row.
 * Exported for the success webhook, which reopens a row whose credit turned
 * out to be disputed money (creditUse.reverseHeldSpendsOfDisputedMoney).
 */
export async function writeRowReversal(
  client: PoolClient,
  a: {
    row: Pick<ChargeRow, 'id' | 'type' | 'amount' | 'invoice_id' | 'tenant_id' | 'landlord_id' | 'lease_id' | 'unit_id'
      | 'due_date' | 'entry_description' | 'revenue_owner' | 'lease_fee_id' | 'notes'>
    lostCents: number
    reversalType: PaymentReversalType
    reversalFee: number
    stripeEventId: string
    stripeObjectId?: string | null
    connectDisputeId?: string | null
    rawEvent: unknown
    kind: 'charge' | 'credit_spend'
  },
): Promise<ReopenedRow | null> {
  const r = a.row
  const lost = Math.max(0, a.lostCents)
  const ins = await client.query<{ id: string }>(
    `INSERT INTO payment_reversals
       (payment_id, landlord_id, tenant_id, lease_id, reversal_type,
        reversed_amount, reversal_fee, stripe_event_id, stripe_object_id,
        connect_dispute_id, raw_event, recovery_status, status, resolved_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'not_needed',$12,
             CASE WHEN $12 = 'resolved' THEN NOW() END)
     ON CONFLICT (stripe_event_id, payment_id) DO NOTHING
     RETURNING id`,
    [r.id, r.landlord_id, r.tenant_id, r.lease_id, a.reversalType,
     toDollars(lost).toFixed(2), a.reversalFee.toFixed(2), a.stripeEventId, a.stripeObjectId ?? null,
     a.connectDisputeId ?? null, JSON.stringify(a.rawEvent ?? {}),
     lost > 0 ? 'open' : 'resolved'])
  const reversalId = ins.rows[0]?.id
  if (!reversalId) return null   // this event already reopened this row

  // The landlord's side: GAM-first money first (never theirs), then their
  // owner share — withheld where GAM still holds it, recovered where it was
  // paid out (header, "What the landlord gives back").
  // Step 9 final fix (decisions #54): a deposit payment a finalized move-out
  // already settled (released_by_deposit_return_id) is no owner share: what of
  // it went to the landlord is the share the deductions KEPT, and that is
  // what is asked back of them, from their next payout (settleDepositKeptSide).
  const releasedDeposit = lost > 0 && r.type === 'deposit' && a.kind === 'charge'
    && !!(await client.query(
      `SELECT 1 FROM payments WHERE id = $1 AND released_by_deposit_return_id IS NOT NULL`, [r.id])).rowCount
  const side = releasedDeposit
    ? { routed: 0, withheld: await settleDepositKeptSide(client, { row: r, reversalId, lostCents: lost }), needed: 0,
        byHand: [] as Array<{ source: string; ref_id: string; amount: number }>, unplaced: 0 }
    : lost > 0 && r.revenue_owner === 'landlord'
      ? await settleLandlordSide(client, { row: r, reversalId, lostCents: lost, kind: a.kind })
      : { routed: 0, withheld: 0, needed: 0, byHand: [] as Array<{ source: string; ref_id: string; amount: number }>, unplaced: 0 }
  const landlordRecovery = side.needed > 0
  if (lost > 0 && (r.revenue_owner === 'landlord' || releasedDeposit)) {
    // Recovered so far: the share withheld, plus GAM-first money (GAM's own,
    // never asked of the landlord). 'recovered' when nothing is left to ask of
    // them — the same end state a netting leaves (landlordPassthrough), so a
    // re-payment pays the landlord again; 'pending' when part was paid out.
    const recovered = side.withheld + side.routed
    const state = landlordRecovery ? 'pending' : side.withheld > 0 ? 'recovered' : 'not_needed'
    await client.query(
      `UPDATE payment_reversals
          SET recovered_amount = $2,
              recovery_status  = $3,
              recovered_at     = CASE WHEN $3 = 'recovered' THEN NOW() END,
              outcome          = CASE WHEN $3 = 'recovered' THEN 'landlord_clawback' END,
              late_fee_owner   = CASE WHEN $3 = 'recovered' THEN 'landlord' END,
              status           = CASE WHEN $3 = 'recovered' THEN 'resolved' ELSE status END,
              resolved_at      = CASE WHEN $3 = 'recovered' THEN NOW() ELSE resolved_at END,
              updated_at       = NOW()
        WHERE id = $1`,
      [reversalId, toDollars(Math.min(recovered, lost)).toFixed(2), state])
  }

  // What the tenant owes again ON THIS ROW: what it lost, less GAM-first money
  // (that part is owed again on the GAM balance it paid, opened again above —
  // never twice). A row whose whole loss was GAM-first money gets no reopened
  // row, and its record is settled now: nothing is owed again on the row and
  // nothing is asked of the landlord.
  const owedAgain = Math.max(0, lost - side.routed)
  if (lost > 0 && owedAgain === 0 && !landlordRecovery) {
    await client.query(
      `UPDATE payment_reversals SET status = 'resolved', resolved_at = COALESCE(resolved_at, NOW()), updated_at = NOW()
        WHERE id = $1`, [reversalId])
  }

  let newPaymentId: string | null = null
  if (lost > 0) {
    await client.query(
      `UPDATE payments SET status = 'returned', return_code = $2, return_reason = $3
        WHERE id = $1`,
      [r.id, a.reversalType, REVERSAL_FEE_DESCRIPTION[a.reversalType]])
  }
  if (owedAgain > 0) {
    // A rent row can lose money twice — its paid-ahead part to one dispute,
    // its own money to another — so its month may already hold a live rent
    // row (the first reopen, owed or paid again). The second reopen is then
    // that month's second rent row: is_remainder, the flag the one-rent-row-
    // per-month indexes leave out (as a part-paid row's rest is).
    newPaymentId = (await client.query<{ id: string }>(
      `INSERT INTO payments
         (unit_id, lease_id, tenant_id, landlord_id, type, amount, status,
          entry_description, due_date, invoice_id, notes, reversal_id, revenue_owner, lease_fee_id, is_remainder)
       VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,$8::date,$9,$10,$11,$12,$13,
               $5 = 'rent' AND EXISTS (
                 SELECT 1 FROM payments q
                  WHERE q.type = 'rent' AND NOT q.is_remainder AND q.id <> $14::uuid AND q.due_date = $8::date
                    AND ((q.lease_id = $2::uuid AND q.status IN ('pending', 'processing', 'settled'))
                         OR (q.unit_id = $1::uuid AND q.status NOT IN ('failed', 'returned')))))
       RETURNING id`,
      [r.unit_id, r.lease_id, r.tenant_id, r.landlord_id, r.type, toDollars(owedAgain).toFixed(2),
       r.entry_description, r.due_date, r.invoice_id, reopenedNotes(r.notes), reversalId,
       r.revenue_owner, r.lease_fee_id, r.id])).rows[0].id
    // A utility line is owed again: its bill is no longer paid.
    if (r.type === 'utility') {
      await client.query(
        `UPDATE utility_bills SET status = 'billed', paid_at = NULL, updated_at = NOW()
          WHERE payment_id = $1 AND status = 'paid'`, [r.id])
    }
  }
  return {
    paymentId: r.id, reversalId, newPaymentId, lost: toDollars(lost), owedAgain: toDollars(owedAgain),
    revenueOwner: r.revenue_owner,
    landlordId: r.landlord_id, landlordRecovery, withheld: toDollars(side.withheld), routed: toDollars(side.routed),
    kind: a.kind,
    ...(side.byHand.length > 0 ? { gamBalancesByHand: side.byHand } : {}),
    ...(side.unplaced > 0 ? { routedUnplacedCents: side.unplaced } : {}),
  }
}

/**
 * The landlord's side of one row's loss (cents in, cents out), inside the
 * record's transaction:
 *   1. GAM-first money the row lost (`routed`, 'charge' rows only): the row's
 *      gam_supersedence_amount less what earlier records already took of it —
 *      a dispute takes the GAM-routed part of a row's money first. Never asked
 *      of the landlord (their share never included it); the GAM balances it
 *      paid are opened again, whole balances only, the last paid first.
 *   2. The landlord's part (`lost − routed`): withheld from their owner share
 *      GAM still holds — the row's unpaid owner-share ledger rows (stamped so
 *      no batch pays them) and any unpaid held line an earlier record of this
 *      row left them. What of the unpaid share the row did not lose is paid to
 *      them on a held line (all of it when the row lost only GAM-first money);
 *      what an earlier line carries is netted back with a negative line.
 *   3. `needed`: the rest of the landlord's part, from what was paid out — but
 *      only from a landlord ever booked an owner share on the row (none: GAM
 *      holds nothing of theirs to ask back).
 * The caller holds the row, the household and the payout lock.
 */
async function settleLandlordSide(
  client: PoolClient,
  a: { row: { id: string; landlord_id: string }; reversalId: string; lostCents: number; kind: 'charge' | 'credit_spend' },
): Promise<{ routed: number; withheld: number; needed: number
             byHand: Array<{ source: string; ref_id: string; amount: number }>; unplaced: number }> {
  const { liveReversalSql, reversedUseOfWonDisputeSql } = await import('./creditUse')
  const facts = (await client.query<{ g: string; before: string; booked: string }>(
    `SELECT COALESCE(p.gam_supersedence_amount, 0)::text AS g,
            GREATEST(0,
              COALESCE((SELECT SUM(pr.reversed_amount) FROM payment_reversals pr
                         WHERE pr.payment_id = p.id AND pr.id <> $2 AND ${liveReversalSql('pr')}), 0)
              - COALESCE((SELECT SUM(cu.amount) FROM credit_uses cu
                           WHERE cu.payment_id = p.id AND cu.status = 'reversed'
                             AND NOT ${reversedUseOfWonDisputeSql('cu')}), 0))::text AS before,
            COALESCE((SELECT SUM(l.amount) FROM user_balance_ledger l
                       WHERE l.reference_type = 'payment' AND l.reference_id = p.id
                         AND l.type = 'allocation_owner_share'), 0)::text AS booked
       FROM payments p WHERE p.id = $1`, [a.row.id, a.reversalId])).rows[0]
  const g = toCents(facts?.g)
  // 1. GAM-first money: the first part of the row's own money any dispute takes.
  let routed = 0
  let byHand: Array<{ source: string; ref_id: string; amount: number }> = []
  let unplaced = 0
  if (a.kind === 'charge' && g > 0) {
    const routedBefore = Math.min(g, toCents(facts?.before))
    routed = Math.min(Math.max(0, g - routedBefore), a.lostCents)
    if (routed > 0) {
      const { reopenGamFirstBalances } = await import('./flexpay')
      const re = await reopenGamFirstBalances(client, {
        paymentId: a.row.id, upToCents: routed,
        why: `the payment that paid it (${a.row.id}) was disputed or returned`,
      })
      byHand = re.othersToReopen
      unplaced = re.unplacedCents
    }
  }
  const landlordPart = Math.max(0, a.lostCents - routed)

  // 2. Withhold what GAM still holds of the landlord's share on this row.
  //    Even when the row lost only GAM-first money (landlordPart 0): the row
  //    goes 'returned' and no batch pays a returned row, so its whole unpaid
  //    share moves to the held line below — never stranded.
  //    The stamp is an UPDATE, so a batch that already claimed a row (its own
  //    stamp) is never stamped again here: that row was paid out.
  const unpaid = (await client.query<{ amount: string }>(
    `UPDATE user_balance_ledger SET stripe_transfer_id = $2
      WHERE reference_type = 'payment' AND reference_id = $1
        AND type = 'allocation_owner_share' AND stripe_transfer_id IS NULL
      RETURNING amount::text AS amount`,
    [a.row.id, withheldStamp(a.reversalId)])).rows.reduce((s, x) => s + toCents(x.amount), 0)
  const earlier = (await client.query<{ s: string }>(
    `SELECT COALESCE(SUM(h.amount), 0)::text AS s FROM held_payout_items h
      WHERE h.source_type = 'dispute' AND h.payout_intent_id IS NULL
        AND h.source_id IN (
          SELECT 'owner_share_untouched:' || pr.id FROM payment_reversals pr WHERE pr.payment_id = $1 AND pr.id <> $2
          UNION ALL
          SELECT 'owner_share_withheld:' || pr.id FROM payment_reversals pr WHERE pr.payment_id = $1 AND pr.id <> $2)`,
    [a.row.id, a.reversalId])).rows[0]
  const earlierUnpaid = Math.max(0, toCents(earlier?.s))
  const fromLedger = Math.min(landlordPart, unpaid)
  const fromEarlier = Math.min(landlordPart - fromLedger, earlierUnpaid)
  const withheld = fromLedger + fromEarlier
  const { recordHeldItem } = await import('./heldPayouts')
  if (unpaid - fromLedger > 0) {
    await recordHeldItem({
      landlordId: a.row.landlord_id, sourceType: 'dispute', sourceId: untouchedShareSource(a.reversalId),
      amount: toDollars(unpaid - fromLedger),
      description: 'Your share of a payment that was partly taken back: the part the tenant still paid',
    }, client)
  }
  if (fromEarlier > 0) {
    await recordHeldItem({
      landlordId: a.row.landlord_id, sourceType: 'dispute', sourceId: withheldShareSource(a.reversalId),
      amount: -toDollars(fromEarlier),
      description: 'A payment taken back: held back from your share of it that was still to be paid',
    }, client)
  }
  // 3. The rest was paid out: asked back of a landlord ever booked a share.
  const needed = toCents(facts?.booked) > 0 ? landlordPart - withheld : 0
  return { routed, withheld, needed, byHand, unplaced }
}

/**
 * The payout lines a deposit's kept share moves on (decisions #54) — the same
 * sources as a withheld owner share — in plain words, naming the space and
 * the tenant like every other move-out line (never who held the money, #47c).
 */
async function depositLineWords(client: PoolClient, paymentId: string, which: 'back' | 'returned' | 'refill' | 'won', cents = 0): Promise<string> {
  const w = (await client.query<{ unit_number: string | null; tenant_name: string | null }>(
    `SELECT un.unit_number, NULLIF(btrim(CONCAT(u.first_name, ' ', u.last_name)), '') AS tenant_name
       FROM payments p LEFT JOIN units un ON un.id = p.unit_id
       LEFT JOIN tenants t ON t.id = p.tenant_id LEFT JOIN users u ON u.id = t.user_id
      WHERE p.id = $1`, [paymentId])).rows[0]
  const space = w?.unit_number ?? 'the space'
  const who = w?.tenant_name ?? 'the tenant'
  if (which === 'refill') {
    // Fix pass (rev8): said by its amount — the refill is what the dispute
    // took from GAM, which is the refunded part only when the move-out's
    // payment to the landlord went out (an escrow transfer that never did
    // makes it the whole repayment).
    return `Move-out at ${space}: ${who} paid the reopened deposit charge again to you in person — $${toDollars(cents).toFixed(2)} of it makes up what the dispute or bank return took back, so it comes out of this payout (the part kept for the deductions stays yours)`
  }
  if (which === 'won') {
    return `Move-out at ${space}: deposit money kept for the deductions, taken back by ${who}'s card dispute, paid to you again — the card company decided the dispute for us`
  }
  return which === 'back'
    ? `Move-out at ${space}: deposit money kept for the deductions was taken back by ${who}'s card dispute or bank return — it comes out of this payout`
    : `Move-out at ${space}: deposit money kept for the deductions, taken back by a dispute or bank return, paid to you again — ${who} paid it again`
}

/**
 * SQL on a held_payout_items alias and a payment_reversals alias: one of the
 * record's kept-share asks (decisions #54) — its first line
 * ('owner_share_withheld:<record>') or a later top-up
 * ('owner_share_withheld:<record>:more:<n>', topUpDepositKeptAsk).
 */
const withheldOfRecordSql = (h: string, pr: string) =>
  `(${h}.source_type = 'dispute' AND ${h}.source_id LIKE 'owner\\_share\\_withheld:%' AND split_part(${h}.source_id, ':', 2) = ${pr}.id::text)`

/** Admin alert categories finalize raises when a GAM-escrow move-out's transfer to the landlord did not go out. */
const ESCROW_TRANSFER_NOT_SENT = ['deposit_disbursement_pending_no_connect', 'deposit_disbursement_transfer_failed'] as const

/** What the kept-share rule asks of the landlord for one deposit payment, in cents (depositAskFigures). */
interface DepositAskFigures {
  /** What more is the landlord's to give back on this payment (their share of what was taken, less what was asked already). */
  want: number
  /** What more may be asked of them over the whole move-out: what it paid them, less what was asked, plus what was paid back. */
  cap: number
  /** A GAM-escrow move-out whose payment to the landlord never went out: what would have been asked had it gone. */
  notPaidOut: number
}

/**
 * Decisions #54 — the figures behind a kept-share ask on one deposit payment
 * a finalized move-out settled (payments.released_by_deposit_return_id).
 * `reversalId` is the record being written now (left out of "before"; null
 * for a re-count of every record), `lostCents` what it takes.
 *
 * What of the payment went to the landlord:
 *   - a REPAYMENT of a reopened deposit charge (payments.reversal_id set):
 *     exactly what it paid them back (the 'owner_share_returned:<its record>'
 *     line) — the rest of it refilled GAM;
 *   - a payment released whole where GAM may not hold deposits (its own
 *     'deposit_settlement' item, source = the payment): all of it;
 *   - otherwise only the share the deductions KEPT (the payment less the
 *     refund parts planned from it), and of that only the landlord's part:
 *     the move-out's kept money went to the landlord less GAM's own bill lines
 *     it paid (the 'kept:<move-out>' item for a deposit the landlord's record
 *     holds; the escrow transfer — kept money less GAM's own lines — for a
 *     GAM-escrow record, and nothing when that transfer never went out),
 *     shared over the move-out's original payments pro rata.
 * The take lands on the payment's money in this order:
 *   1. the refund share NOT sent yet (stopped, or still open) —
 *      noteDepositRefundOfReturnedPayment stops it; a part whose refund already
 *      reached the card or bank ("The refund went to …") is sent, never open;
 *   2. the share the deductions kept — the landlord's part of it;
 *   3. the refund share already sent — owed again by the tenant (#51).
 * Counted over every record on the payment (never asked twice) and over the
 * whole move-out (never more than it paid them, net of what was paid back).
 */
async function depositAskFigures(
  client: PoolClient,
  a: { paymentId: string; reversalId: string | null; lostCents: number },
): Promise<DepositAskFigures | null> {
  // Decisions #55: a record of a dispute GAM won took nothing in the end (its
  // ask was given back on the win) — never counted as taken or asked.
  const { liveReversalSql } = await import('./creditUse')
  const { livePartSql } = await import('./earlyCheckOut')
  const { openPartSql, DEPOSIT_PART_TAKEN_BACK } = await import('./depositRefundSend')
  const taken = `'${DEPOSIT_PART_TAKEN_BACK.replace(/'/g, "''")}'`
  const planned = (pay: string) => `COALESCE((SELECT SUM(rp.toward_amount) FROM stay_refund_parts rp
      WHERE rp.deposit_payment_id = ${pay}.id AND ${livePartSql('rp')}), 0)`
  const custodyItem = (pay: string) => `EXISTS (SELECT 1 FROM held_payout_items hq WHERE hq.source_type = 'deposit_settlement'
      AND hq.source_id = ${pay}.id::text AND hq.amount > 0)`
  const askedOn = (where: string) => `COALESCE((SELECT -SUM(h.amount) FROM held_payout_items h
      JOIN payment_reversals pr ON ${withheldOfRecordSql('h', 'pr')}
     WHERE pr.id IS DISTINCT FROM $2::uuid AND ${liveReversalSql('pr')} AND ${where}), 0)`
  const f = (await client.query<{
    draft_id: string; amount: string; reversal_id: string | null; custody_item: string | null; planned: string
    stopped: string; open: string; taken_before: string; asked_p: string; returned_share: string
  }>(
    `SELECT p.released_by_deposit_return_id AS draft_id, p.amount::text AS amount, p.reversal_id,
            (SELECT h.amount::text FROM held_payout_items h
              WHERE h.source_type = 'deposit_settlement' AND h.source_id = p.id::text AND h.amount > 0 LIMIT 1) AS custody_item,
            ${planned('p')}::text AS planned,
            COALESCE((SELECT SUM(rp.toward_amount) FROM stay_refund_parts rp
                       WHERE rp.deposit_payment_id = p.id AND ${livePartSql('rp')} AND rp.failure = ${taken}), 0)::text AS stopped,
            COALESCE((SELECT SUM(rp.toward_amount) FROM stay_refund_parts rp
                       WHERE rp.deposit_payment_id = p.id AND ${openPartSql('rp')}
                         AND NOT (rp.status = 'failed' AND rp.failure IS NOT NULL AND rp.failure ~ '^The refund went to ')), 0)::text AS open,
            COALESCE((SELECT SUM(pr.reversed_amount) FROM payment_reversals pr
                       WHERE pr.payment_id = p.id AND pr.id IS DISTINCT FROM $2::uuid AND ${liveReversalSql('pr')}), 0)::text AS taken_before,
            ${askedOn('pr.payment_id = p.id')}::text AS asked_p,
            COALESCE((SELECT SUM(h.amount) FROM held_payout_items h
                       WHERE h.source_type = 'dispute' AND p.reversal_id IS NOT NULL
                         AND h.source_id = 'owner_share_returned:' || p.reversal_id::text), 0)::text AS returned_share
       FROM payments p WHERE p.id = $1 AND p.type = 'deposit' AND p.released_by_deposit_return_id IS NOT NULL`,
    [a.paymentId, a.reversalId])).rows[0]
  if (!f) return null
  const ofMoveOut = `pr.payment_id IN (SELECT q.id FROM payments q WHERE q.released_by_deposit_return_id = dr.id)`
  const d = (await client.query<{
    kept_d: string; kept_item: string | null; escrow: boolean; negative: boolean; gam_lines: string
    custody_paid: string; asked_d: string; returned_d: string; not_sent: boolean
  }>(
    `SELECT COALESCE((SELECT SUM(GREATEST(0, q.amount - ${planned('q')})) FROM payments q
                       WHERE q.released_by_deposit_return_id = dr.id AND q.type = 'deposit'
                         AND q.reversal_id IS NULL AND NOT ${custodyItem('q')}), 0)::text AS kept_d,
            (SELECT h.amount::text FROM held_payout_items h
              WHERE h.source_type = 'deposit_settlement' AND h.source_id = 'kept:' || dr.id::text) AS kept_item,
            COALESCE(sd.held_by = 'gam_escrow', FALSE) AS escrow,
            EXISTS (SELECT 1 FROM held_payout_items h WHERE h.source_type = 'deposit_settlement'
                      AND h.source_id = dr.id::text AND h.amount < 0) AS negative,
            COALESCE((SELECT SUM(g.amount) FROM payments g
                       WHERE g.lease_id = dr.lease_id AND g.revenue_owner = 'gam' AND g.status = 'paid_via_deposit'
                         AND g.settled_at = dr.finalized_at), 0)::text AS gam_lines,
            COALESCE((SELECT SUM(h.amount) FROM held_payout_items h JOIN payments q ON h.source_id = q.id::text
                       WHERE h.source_type = 'deposit_settlement' AND h.amount > 0
                         AND q.released_by_deposit_return_id = dr.id AND q.reversal_id IS NULL), 0)::text AS custody_paid,
            ${askedOn(ofMoveOut)}::text AS asked_d,
            COALESCE((SELECT SUM(h.amount) FROM held_payout_items h JOIN payment_reversals pr
                        ON h.source_id = 'owner_share_returned:' || pr.id::text
                       WHERE h.source_type = 'dispute' AND ${liveReversalSql('pr')} AND ${ofMoveOut}), 0)::text AS returned_d,
            EXISTS (SELECT 1 FROM admin_notifications n
                     WHERE n.category = ANY($3::text[]) AND n.context->>'deposit_return_id' = dr.id::text) AS not_sent
       FROM deposit_returns dr LEFT JOIN security_deposits sd ON sd.id = dr.security_deposit_id
      WHERE dr.id = $1`, [f.draft_id, a.reversalId, [...ESCROW_TRANSFER_NOT_SENT]])).rows[0]
  const takenCum = toCents(f.taken_before) + a.lostCents
  const askedP = Math.max(0, toCents(f.asked_p))
  const keptD = toCents(d?.kept_d)
  // What the move-out paid the landlord of the kept deposit money: the escrow
  // transfer, or their 'kept:' payout line. An escrow transfer that never went
  // out (no payout account, or it failed — finalize's admin alert says so)
  // paid them nothing: nothing is asked of them, and the admin is told.
  const keptIfSent = !d ? 0
    : d.escrow ? (d.negative ? 0 : Math.max(0, keptD - toCents(d.gam_lines)))
    : Math.max(0, toCents(d.kept_item))
  const paidKept = d?.escrow && d.not_sent ? 0 : keptIfSent
  const paidD = paidKept + Math.max(0, toCents(d?.custody_paid))
  const cap = paidD - Math.max(0, toCents(d?.asked_d)) + Math.max(0, toCents(d?.returned_d))
  let notPaidOut = 0
  let landlordsCum: number
  if (f.reversal_id) {
    // A repayment: the landlord's share of it is what it paid them back.
    landlordsCum = Math.min(takenCum, Math.max(0, toCents(f.returned_share)))
  } else if (f.custody_item != null) {
    landlordsCum = Math.min(takenCum, toCents(f.custody_item))
  } else {
    const keptP = Math.max(0, toCents(f.amount) - toCents(f.planned))
    const keptTaken = Math.min(keptP, Math.max(0, takenCum - toCents(f.stopped) - toCents(f.open)))
    const share = (paid: number) => keptD > 0 ? Math.floor(keptTaken * Math.min(paid, keptD) / keptD) : 0
    landlordsCum = share(paidKept)
    if (paidKept < keptIfSent) notPaidOut = Math.max(0, Math.min(share(keptIfSent) - askedP, a.lostCents || Infinity))
  }
  return { want: landlordsCum - askedP, cap, notPaidOut }
}

/**
 * Step 9 final fix — decisions #54 (S512 / #51 "recover from the recipient the
 * money was routed to"). A GAM-held deposit payment (`row`) that a finalized
 * move-out already settled (payments.released_by_deposit_return_id) is
 * disputed or bank-returned. Of the money it lost, what had gone to the
 * landlord (depositAskFigures) is asked back of them on their next payout: ONE
 * negative held line ('dispute', owner_share_withheld:<record> — an
 * owner-share move, never income), counted as recovered on the spot. Returns
 * that amount in cents.
 *
 * Fix pass 2: a dispute of the tenant's REPAYMENT of a reopened deposit charge
 * asks back only what that repayment paid the landlord (never the whole
 * repayment as if it were move-out deposit money); a repayment that paid them
 * nothing asks nothing. A refund part counted here as not sent that turns out
 * sent after all is topped up later (topUpDepositKeptAsk, from
 * noteDepositRefundOfReturnedPayment). An escrow move-out whose transfer to
 * the landlord never went out asks nothing and tells the admin what to hold
 * back when it is paid by hand.
 * The tenant's repayment of the reopened charge refills GAM and pays this
 * line back to the landlord once (resolveReversalOnTenantPayment).
 */
async function settleDepositKeptSide(
  client: PoolClient,
  a: { row: { id: string; landlord_id: string }; reversalId: string; lostCents: number },
): Promise<number> {
  const fig = await depositAskFigures(client, { paymentId: a.row.id, reversalId: a.reversalId, lostCents: a.lostCents })
  if (!fig) return 0
  if (fig.notPaidOut > 0) await alertKeptShareNotPaidOut(client, a.row.id, a.reversalId, fig.notPaidOut)
  const x = Math.max(0, Math.min(fig.want, fig.cap, a.lostCents))
  if (x <= 0) return 0
  const { recordHeldItem } = await import('./heldPayouts')
  await recordHeldItem({
    landlordId: a.row.landlord_id, sourceType: 'dispute', sourceId: withheldShareSource(a.reversalId),
    amount: -toDollars(x), description: await depositLineWords(client, a.row.id, 'back'),
  }, client)
  return x
}

/** Inside the caller's transaction (rolls back with it): the escrow transfer never went out, so the admin holds the share back by hand. */
async function alertKeptShareNotPaidOut(client: PoolClient, paymentId: string, reversalId: string | null, cents: number): Promise<void> {
  const dr = (await client.query<{ id: string }>(
    `SELECT released_by_deposit_return_id AS id FROM payments WHERE id = $1`, [paymentId])).rows[0]?.id
  await client.query(
    `INSERT INTO admin_notifications (severity, category, title, body, context) VALUES ('warn', $1, $2, $3, $4)`,
    ['deposit_kept_share_not_paid_out',
     'A disputed deposit\'s kept share was never paid to the landlord',
     `A dispute or bank return took back $${toDollars(cents).toFixed(2)} of the deposit money this move-out kept for the deductions. ` +
       'The move-out\'s payment of that money to the landlord never went out (no payout account, or the transfer failed), ' +
       `so nothing was taken off their payout for it. When that move-out payment is made by hand, pay them $${toDollars(cents).toFixed(2)} less — ` +
       'unless the tenant has paid the reopened deposit charge again by then: then pay it in full. ' +
       // Fix pass (rev8): the alert finalize raised is never cleared, so the
       // payment may have been made by hand already (or a transfer that
       // seemed to fail went through) — then the money is with the landlord.
       `If that move-out payment already reached them (paid by hand, or the transfer went through after all), take $${toDollars(cents).toFixed(2)} back ` +
       'off their next payout instead — GAM does not absorb it. ' +
       `Move-out ${dr ?? 'unknown'}, deposit payment ${paymentId}.`,
     JSON.stringify({ deposit_return_id: dr ?? null, payment_id: paymentId, payment_reversal_id: reversalId, not_paid_out_cents: cents })])
}

/**
 * Fix pass 2 (review): settleDepositKeptSide counts a refund part not sent yet
 * as taking the dispute first — it is stopped after the commit
 * (noteDepositRefundOfReturnedPayment). When such a part turns out to have
 * gone to the card or bank after all (an earlier try's answer was lost), the
 * take really landed on the kept share: the landlord's part of it is asked of
 * them now, on a further line of the latest record on the payment
 * ('owner_share_withheld:<record>:more:<asked so far>'), capped as before.
 * Re-counted from what the parts are now, so a pass that finds nothing new
 * asks nothing. Not once the tenant has paid a reopened charge of this
 * payment again: that repayment already refilled what the dispute took.
 * Runs inside the caller's transaction, under the household lock; takes the
 * landlord's payout lock. Returns the cents asked now.
 */
export async function topUpDepositKeptAsk(client: PoolClient, paymentId: string): Promise<number> {
  // Decisions #55: only records still standing (a won dispute's ask was given back).
  const { liveReversalSql } = await import('./creditUse')
  const live = (r: string) => liveReversalSql(r)
  // Fix pass (rev8): what may still be asked is what EVERY record on the
  // payment has left to recover (a payment with two records whose latest is
  // already recovered in full still owes the top-up of the earlier one); the
  // line is written on the latest record, and the recovery is spread over the
  // records newest first.
  const head = (await client.query<{ landlord_id: string; repaid: boolean; rec_id: string | null; rec_left: string | null }>(
    `SELECT p.landlord_id,
            EXISTS (SELECT 1 FROM payment_reversals r WHERE r.payment_id = p.id AND r.outcome = 'tenant_paid' AND ${live('r')}) AS repaid,
            (SELECT r.id FROM payment_reversals r WHERE r.payment_id = p.id AND r.reversed_amount > 0 AND ${live('r')}
              ORDER BY r.created_at DESC, r.id DESC LIMIT 1) AS rec_id,
            (SELECT COALESCE(SUM(GREATEST(0, r.reversed_amount - r.recovered_amount)), 0)::text FROM payment_reversals r
              WHERE r.payment_id = p.id AND r.reversed_amount > 0 AND ${live('r')}) AS rec_left
       FROM payments p
      WHERE p.id = $1 AND p.type = 'deposit' AND p.reversal_id IS NULL AND p.released_by_deposit_return_id IS NOT NULL
        AND p.status = 'returned'`, [paymentId])).rows[0]
  if (!head?.rec_id || head.repaid || !head.landlord_id) return 0
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [payoutLockKey(head.landlord_id)])
  const fig = await depositAskFigures(client, { paymentId, reversalId: null, lostCents: 0 })
  if (!fig) return 0
  const x = Math.max(0, Math.min(fig.want, fig.cap, toCents(head.rec_left)))
  if (x <= 0) return 0
  const askedSoFar = toCents((await client.query<{ s: string }>(
    `SELECT COALESCE(-SUM(h.amount), 0)::text AS s FROM held_payout_items h
       JOIN payment_reversals pr ON ${withheldOfRecordSql('h', 'pr')}
      WHERE pr.payment_id = $1 AND ${live('pr')}`, [paymentId])).rows[0]?.s)
  const { recordHeldItem } = await import('./heldPayouts')
  const wrote = await recordHeldItem({
    landlordId: head.landlord_id, sourceType: 'dispute',
    sourceId: `${withheldShareSource(head.rec_id)}:more:${askedSoFar + x}`,
    amount: -toDollars(x), description: await depositLineWords(client, paymentId, 'back'),
  }, client)
  if (!wrote) return 0
  const recs = (await client.query<{ id: string; left: string }>(
    `SELECT r.id, GREATEST(0, r.reversed_amount - r.recovered_amount)::text AS left FROM payment_reversals r
      WHERE r.payment_id = $1 AND r.reversed_amount > 0 AND ${live('r')}
      ORDER BY r.created_at DESC, r.id DESC FOR UPDATE OF r`, [paymentId])).rows
  let spread = x
  for (const r of recs) {
    const add = Math.min(spread, toCents(r.left))
    if (add <= 0) continue
    spread -= add
    await client.query(
      `UPDATE payment_reversals
          SET recovered_amount = LEAST(reversed_amount, recovered_amount + $2::numeric),
              -- As settleDepositKeptSide: what is asked of the landlord is
              -- asked on their payout at once — nothing left for the
              -- recovery engine to net or pull.
              recovery_status  = 'recovered',
              recovered_at     = COALESCE(recovered_at, NOW()),
              outcome          = 'landlord_clawback',
              late_fee_owner   = 'landlord',
              status           = 'resolved',
              resolved_at      = COALESCE(resolved_at, NOW()),
              updated_at       = NOW()
        WHERE id = $1`, [r.id, toDollars(add).toFixed(2)])
    if (spread <= 0) break
  }
  return x
}

/**
 * Fix pass (rev8): what ONE event takes of a charge, counted over every
 * dispute of that charge already handled, in cents. Stripe can take a charge
 * back in more than one dispute (or reopen one), and each dispute's amount is
 * its own; the card fee on top is what the disputes together take past the
 * charge's money. So:
 *   earlier  = the amounts of the charge's disputes Stripe still holds
 *              (DISPUTE_STATUSES_MONEY_TAKEN) that an event already handled
 *              (a record names them), this dispute left out;
 *   together = earlier + this event's amount, never past the charge's gross;
 *   money    = what of `together` is the charge's money, less what of
 *              `earlier` was; fee = the rest, less the fee `earlier` took.
 * `full` when this event takes the whole charge (no amount given: a bank
 * return; or a dispute of all of it) — every row's remaining money then
 * reopens. `earlier` > 0 marks a FOLLOW-UP dispute: its card-fee part is not
 * netted from a landlord by the handler but named to settle by hand (with
 * creditUse's 'dispute_second_on_charge' notice), as before. A second event for a dispute already handled (the same Stripe
 * object, another event id) takes nothing more: `full` false, both 0, so it
 * writes only its $0 records. A charge with no receipt is counted per event
 * (pi null: its money is read off its rows as they are now).
 */
async function cumulativeDisputeSplit(
  client: PoolClient,
  a: { pi: string | null; input: PaymentReversalInput; gross: number; chargeMoney: number },
): Promise<{ full: boolean; moneyTaken: number; feeTaken: number; earlier: number }> {
  const { input, gross, chargeMoney } = a
  const feeTotal = Math.max(0, gross - chargeMoney)
  if (input.reversedAmount != null && input.stripeObjectId) {
    const done = await client.query(
      `SELECT 1 FROM payment_reversals WHERE stripe_object_id = $1 AND stripe_event_id <> $2 LIMIT 1`,
      [input.stripeObjectId, input.stripeEventId])
    if ((done.rowCount ?? 0) > 0) return { full: false, moneyTaken: 0, feeTaken: 0, earlier: 0 }
  }
  let earlier = 0
  if (a.pi) {
    const { DISPUTE_STATUSES_MONEY_TAKEN } = await import('./creditUse')
    earlier = toCents((await client.query<{ s: string }>(
      `SELECT COALESCE(SUM(d.amount), 0)::text AS s FROM connect_disputes d
        WHERE d.stripe_payment_intent_id = $1 AND d.status = ANY($2::text[])
          AND d.id IS DISTINCT FROM $3::uuid AND d.stripe_dispute_id IS DISTINCT FROM $4::text
          AND EXISTS (SELECT 1 FROM payment_reversals pr
                       WHERE pr.connect_dispute_id = d.id OR pr.stripe_object_id = d.stripe_dispute_id)`,
      [a.pi, [...DISPUTE_STATUSES_MONEY_TAKEN], input.connectDisputeId ?? null, input.stripeObjectId ?? null])).rows[0]?.s)
  }
  const earlierTaken = Math.min(gross, earlier)
  const earlierMoney = Math.min(earlierTaken, chargeMoney)
  const earlierFee = Math.min(feeTotal, earlierTaken - earlierMoney)
  // Whole by this event's own amount (a bank return, or a dispute of all of
  // it): a later dispute that only brings the total to the gross is partial —
  // its budget (the money left) already reaches every row's remaining money.
  const full = input.reversedAmount == null || toCents(input.reversedAmount) >= gross
  const together = full ? gross : Math.min(gross, earlier + Math.max(0, toCents(input.reversedAmount)))
  const togetherMoney = Math.min(together, chargeMoney)
  return {
    full,
    moneyTaken: Math.max(0, togetherMoney - earlierMoney),
    feeTaken: Math.max(0, Math.min(feeTotal, together - togetherMoney) - earlierFee),
    earlier,
  }
}

/**
 * A settled charge was taken back (see the header). Returns what it did;
 * `handled` false with a reason when there was nothing to do (an event already
 * handled, a charge with no settled row and no paid-ahead money).
 */
export async function handlePaymentReversal(input: PaymentReversalInput): Promise<PaymentReversalResult> {
  // Which charge.
  let pi = input.paymentIntentId ?? null
  let onlyRowId: string | null = null
  if (!pi && input.paymentId) {
    const r = await queryOne<{ pi: string | null; manual_method: string | null }>(
      `SELECT stripe_payment_intent_id AS pi, manual_method FROM payments WHERE id = $1`, [input.paymentId])
    if (!r) return NONE('payment_not_found')
    if (r.pi && !r.manual_method) pi = r.pi
    else onlyRowId = input.paymentId
  }
  if (!pi && !onlyRowId) return NONE('no_charge')
  // A redelivered event changes nothing.
  if (await queryOne(`SELECT 1 FROM payment_reversals WHERE stripe_event_id = $1 LIMIT 1`, [input.stripeEventId])) {
    return NONE('already_processed')
  }
  // Fix pass 2 (review): ONE take-back per Stripe dispute or return, whatever
  // event brings it. A later event for a dispute already handled (an
  // inquiry that became a dispute and is then updated again, a redelivery
  // under another event id) changes nothing — it never reopens or alerts again.
  if (input.stripeObjectId && await queryOne(
    `SELECT 1 FROM payment_reversals WHERE stripe_object_id = $1 AND stripe_event_id <> $2 LIMIT 1`,
    [input.stripeObjectId, input.stripeEventId])) {
    return NONE('already_processed')
  }
  // Fix pass 2 (review): a dispute under which Stripe holds no money changes
  // nothing. An INQUIRY (warning_needs_response, warning_under_review) is a
  // bank's question before any dispute: no money was taken, so no bill is
  // reopened, nothing is withheld or asked of the landlord, no fee is billed
  // (before this, an inquiry did all of that and the tenant owed twice). When
  // the inquiry becomes a dispute (needs_response), the event that says so
  // reverses it, once (the check above).
  const status = await disputeStatusOf(input)
  if (status != null) {
    const { DISPUTE_STATUSES_MONEY_TAKEN } = await import('./creditUse')
    if (!(DISPUTE_STATUSES_MONEY_TAKEN as readonly string[]).includes(status)) {
      // Fix pass 1 (rev10, review): an inquiry first heard of at its close
      // (warning_closed) needs no answer — nobody is told to answer it.
      if (status.startsWith('warning_') && status !== 'warning_closed') await alertInquiryOpen(pi, onlyRowId, input, status)
      return NONE(status.startsWith('warning_') ? 'inquiry' : 'no_money_taken')
    }
  }

  const who = await chargeHousehold(pi, onlyRowId)
  const feeDescription = REVERSAL_FEE_DESCRIPTION[input.reversalType]
  const flexAfter: Array<() => Promise<void>> = []
  /** Admin alerts this event raises, sent after the commit (never for a rolled-back event). */
  const afterAlerts: Array<Parameters<typeof createAdminNotification>[0]> = []
  let result: PaymentReversalResult = NONE('nothing_to_reverse')
  const invoices = new Set<string>()
  // Decisions #55: a dispute GAM won took nothing in the end — its records and
  // the spends it undid are left out of what a row already lost.
  const { liveReversalSql, reversedUseOfWonDisputeSql } = await import('./creditUse')

  // Every landlord the charge paid (a neighbor's utility on the bill has its
  // own), and the receipt's: their payout locks are taken before any row.
  const payees = (await query<{ landlord_id: string }>(
    `SELECT DISTINCT landlord_id::text AS landlord_id FROM (
       SELECT p.landlord_id FROM payments p
        WHERE ${pi ? 'p.stripe_payment_intent_id = $1' : 'p.id = $1::uuid'} AND p.landlord_id IS NOT NULL
       UNION ALL
       SELECT r.landlord_id FROM tenant_remittances r WHERE $2::text IS NOT NULL AND r.stripe_payment_intent_id = $2
     ) x`, [pi ?? onlyRowId, pi])).map(r => r.landlord_id)
  if (who) payees.push(who.landlordId)

  const client = await getClient()
  try {
    await client.query('BEGIN')
    if (who) {
      await lockHousehold(client, who.tenantId, who.landlordId)
      // The tenant row before any FlexPay advance (flexpay's lock order): a
      // GAM balance this charge's GAM-first money paid may be opened again.
      await client.query(`SELECT 1 FROM tenants WHERE id = $1 FOR UPDATE`, [who.tenantId])
    }
    // The weekly payout's lock for each landlord, in id order: a batch
    // claiming their owner shares and this reversal withholding them never
    // interleave (a share is either paid out or withheld, never both).
    for (const id of [...new Set(payees)].sort()) {
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [payoutLockKey(id)])
    }
    // Serialize deliveries for the same charge (two events, one charge).
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [`payment_reversal:${pi ?? onlyRowId}`])
    if ((await client.query(
      `SELECT 1 FROM payment_reversals
        WHERE stripe_event_id = $1 OR ($2::text IS NOT NULL AND stripe_object_id = $2)
        LIMIT 1`,
      [input.stripeEventId, input.stripeObjectId ?? null])).rowCount) {
      await client.query('ROLLBACK')
      return NONE('already_processed')
    }
    // Fix pass 2 (review): read the dispute on file again under the charge's
    // lock. A win (or any status under which Stripe holds no money) recorded
    // while this event was on its way — a stale 'needs_response' handled at
    // the same moment as the win — reverses nothing: the won dispute is
    // undone by hand from its notice (decisions #55-AMENDED), and this event
    // must not add to it. A bank return has no dispute on file and is not affected.
    if (input.stripeObjectId || input.connectDisputeId) {
      const onFile = (await client.query<{ status: string }>(
        `SELECT status FROM connect_disputes
          WHERE ($1::uuid IS NOT NULL AND id = $1::uuid) OR ($2::text IS NOT NULL AND stripe_dispute_id = $2)
          LIMIT 1`, [input.connectDisputeId ?? null, input.stripeObjectId ?? null])).rows[0]?.status
      const { DISPUTE_STATUSES_MONEY_TAKEN: TAKEN } = await import('./creditUse')
      if (onFile != null && !(TAKEN as readonly string[]).includes(onFile)) {
        await client.query('ROLLBACK')
        return NONE(onFile.startsWith('warning_') ? 'inquiry' : 'no_money_taken')
      }
    }

    // The rows the charge paid, locked in id order, then what of each row's
    // OWN money is still there to lose: its money part, less any of it an
    // earlier record already took back (the records on the row, less the
    // credit part those records undid: its reversed credit uses). A row an
    // earlier event marked 'returned' only for its paid-ahead part is one of
    // them (see the header); one whose own money is all taken back already
    // is not. Fix pass (rev8): so is a row an earlier PARTIAL dispute
    // reopened only in part (a $60 dispute that took $9 of a $50 rent row
    // after the $51 paid ahead) — it still holds $41 of this charge's money,
    // and a later dispute of the same charge takes from it. Its remaining
    // money is read below (money_part); a row with none left drops out there.
    const lockedIds = (await client.query<{ id: string }>(
      `SELECT p.id FROM payments p
        WHERE ${pi ? `p.stripe_payment_intent_id = $1 AND p.manual_method IS NULL` : `p.id = $1::uuid`}
          AND (p.status = 'settled'
               OR (p.status = 'returned'
                   AND (EXISTS (SELECT 1 FROM credit_uses cu WHERE cu.payment_id = p.id AND cu.status = 'reversed'
                                  AND NOT ${reversedUseOfWonDisputeSql('cu')})
                        OR EXISTS (SELECT 1 FROM payment_reversals pr WHERE pr.payment_id = p.id AND pr.reversed_amount > 0
                                     AND ${liveReversalSql('pr')}))))
        ORDER BY p.id FOR UPDATE`, [pi ?? onlyRowId])).rows.map(r => r.id)
    const rows = (lockedIds.length === 0 ? [] : (await client.query<ChargeRow>(
      `SELECT p.id, p.type, p.status, p.amount::text AS amount, p.invoice_id, p.tenant_id, p.landlord_id,
              p.lease_id, p.unit_id, p.due_date::text AS due_date, p.entry_description, p.revenue_owner,
              p.lease_fee_id, p.notes, p.created_at,
              GREATEST(0, vm.money_part - GREATEST(0,
                COALESCE((SELECT SUM(pr.reversed_amount) FROM payment_reversals pr
                           WHERE pr.payment_id = p.id AND ${liveReversalSql('pr')}), 0)
                - COALESCE((SELECT SUM(cu.amount) FROM credit_uses cu
                             WHERE cu.payment_id = p.id AND cu.status = 'reversed'
                               AND NOT ${reversedUseOfWonDisputeSql('cu')}), 0)))::text AS money_part
         FROM payments p JOIN v_payment_money vm ON vm.payment_id = p.id
        WHERE p.id = ANY($1::uuid[])
        ORDER BY p.id`, [lockedIds])).rows)
      .filter(r => r.status === 'settled' || toCents(r.money_part) > 0)
    const flexRows = rows.filter(r => r.entry_description === 'FLEXPAY')
    const charged = rows.filter(r => r.entry_description !== 'FLEXPAY')

    const rem = pi ? (await client.query<{
      id: string; amount: string; gross_amount: string | null; processing_fee_amount: string
      lease_id: string | null; tenant_id: string; landlord_id: string
    }>(
      `SELECT id, amount::text AS amount, gross_amount::text AS gross_amount,
              processing_fee_amount::text AS processing_fee_amount, lease_id, tenant_id, landlord_id
         FROM tenant_remittances WHERE stripe_payment_intent_id = $1
        ORDER BY created_at, id LIMIT 1 FOR UPDATE`, [pi])).rows[0] : undefined

    // What the charge was: its money (the receipt's amount — rows plus any
    // surplus banked as paid-ahead money), and its gross (the card fee on top).
    const rowMoney = charged.reduce((s, r) => s + Math.max(0, toCents(r.money_part)), 0)
      + flexRows.reduce((s, r) => s + toCents(r.amount), 0)
    const chargeMoney = rem ? toCents(rem.amount) : rowMoney
    const gross = rem?.gross_amount != null ? toCents(rem.gross_amount) : chargeMoney
    // Fix pass (rev8): what this event takes is counted CUMULATIVELY over the
    // disputes of this charge already handled (cumulativeDisputeSplit): the
    // money comes first and the card fee is only what runs past the money,
    // over all of them together — $60 then $44.55 on a $101 + $3.55 charge
    // is $41 of money and the $3.55 fee on the second, never $44.55 of money.
    // A second event for a dispute already handled takes nothing more.
    const split = await cumulativeDisputeSplit(client, { pi: rem ? pi : null, input, gross, chargeMoney })
    const full = split.full
    const moneyTaken = split.moneyTaken
    const feeTaken = split.feeTaken
    const followUpDispute = split.earlier > 0

    // 1. Paid-ahead money this charge banked goes first.
    const { clawBackDisputedCharge, clawBackRemittanceCredit, takeBackDisputedCredit } = await import('./creditUse')
    if (pi) await client.query('SAVEPOINT reversal_claw')
    let claw = pi
      ? await clawBackDisputedCharge(client, { paymentIntentId: pi, reversalId: null, maxAmount: full ? undefined : toDollars(moneyTaken) })
      : null
    // A partial claim stops the take-back at the first spend bigger than what
    // is left, on the word that the charge's rows take the rest. When the
    // rows' own money cannot (the charge failed for good, then succeeded: its
    // money was banked and a whole-bill check paid its only row from it, so
    // the row holds no money of its own), the take-back is done again, whole
    // spends until the claim is met — that row reopens for the spend, and only
    // the claimed dollars are taken off the credit (the rest of the spend is
    // the tenant's credit again). Never a part of the claim left on nobody.
    //
    // The ROLLBACK TO SAVEPOINT below undoes only what this transaction wrote.
    // It is safe because it runs only when charged.length > 0: such a charge
    // has rows on its intent (disputeClaimOnCredit's chargeRows > 0), so the
    // first take-back went through clawBackRemittanceCredit, which writes
    // nothing outside this transaction (no admin alert on the pool). If that
    // ever changes, an alert raised by the first take-back would survive the
    // rollback and be false.
    let wholeSpends = false
    if (claw?.creditId && rem && !full && charged.length > 0) {
      const rowOwn = charged.reduce((s, r) => s + Math.max(0, toCents(r.money_part)), 0)
      const left = moneyTaken - toCents(claw.clawed) - rowOwn
      const spendsLeft = left > 0 && ((await client.query(
        `SELECT 1 FROM credit_uses WHERE prepaid_credit_id = $1 AND status = 'applied' AND payment_id IS NOT NULL LIMIT 1`,
        [claw.creditId])).rowCount ?? 0) > 0
      if (spendsLeft) {
        await client.query('ROLLBACK TO SAVEPOINT reversal_claw')
        claw = { ...(await clawBackRemittanceCredit(client, rem.id, null,
          { maxAmount: toDollars(moneyTaken), wholeUsesUntilMet: true })), withdrawn: false, unrecorded: 0 }
        wholeSpends = true
      }
    }
    if (pi) await client.query('RELEASE SAVEPOINT reversal_claw')
    const clawed = claw ? toCents(claw.clawed) : 0

    // A row this charge's paid-ahead money paid (its spend is undone below)
    // is that money's row, not one the charge's own money paid — even when it
    // still carries the intent (the intent failed for good, then succeeded:
    // its money was banked and a whole-bill check paid the row from it). Such
    // a row with no money of its own on it is reopened once, for the spend
    // (step 4); one with money of its own loses both on one record (step 3).
    const spends = new Map<string, number>()
    for (const u of claw?.reversed ?? []) spends.set(u.paymentId, (spends.get(u.paymentId) ?? 0) + toCents(u.amount))
    const byCharge = charged.filter(r => !(toCents(r.money_part) === 0 && spends.has(r.id)))
    const spendOnChargedRow = new Map<string, number>()
    for (const r of byCharge) {
      const c = spends.get(r.id)
      if (c != null) { spendOnChargedRow.set(r.id, c); spends.delete(r.id) }
    }

    // 2. Then the charge's rows, newest first.
    let budget = full ? Number.POSITIVE_INFINITY : Math.max(0, moneyTaken - clawed)
    const lostByRow = new Map<string, number>()
    const newestFirst = [...byCharge].sort((a, b) =>
      b.due_date.localeCompare(a.due_date)
      || new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      || b.id.localeCompare(a.id))
    for (const r of newestFirst) {
      const m = Math.max(0, toCents(r.money_part))
      const take = Math.min(m, budget)
      lostByRow.set(r.id, take)
      budget -= take
    }
    // A partial claim that neither the paid-ahead money nor the rows could
    // carry in full: Stripe took that much back and nothing here reopens it.
    // Told loudly — never GAM's loss in silence. (A charge with no rows of
    // its own is told by the take-back itself: creditUse's 'disputed_credit_short'.)
    // Fix pass (rev8): told even when no row of the charge is left to take
    // anything (an earlier dispute reopened them all) — a charge that HAS
    // rows is never told by the take-back, so this is the only alert there.
    // A follow-up dispute's card-fee part is told here too (never netted from
    // a landlord, see step 9): with creditUse's notice naming the same
    // dollars, it is one amount to settle once.
    const feeByHand = followUpDispute ? feeTaken : 0
    const notPlaced = (full ? 0 : budget) + feeByHand
    const rowsOnCharge = charged.length > 0 || (notPlaced > 0 && pi != null && ((await client.query(
      `SELECT 1 FROM payments p WHERE p.stripe_payment_intent_id = $1 AND p.manual_method IS NULL
          AND p.status IN ('settled', 'returned', 'paid_via_deposit') LIMIT 1`, [pi])).rowCount ?? 0) > 0)
    if (notPlaced > 0 && rowsOnCharge) {
      const took = moneyTaken + feeByHand
      afterAlerts.push({
        severity: 'critical', category: 'payment_reversal_short',
        title: `$${toDollars(notPlaced).toFixed(2)} of a ${input.reversalType === 'card_dispute' ? 'dispute' : 'bank return'} was not reopened on any bill (${pi ?? onlyRowId})`,
        body: `Stripe took back $${toDollars(took).toFixed(2)} of this payment (event ${input.stripeEventId}), but its paid-ahead money ` +
          `and the bills it paid could carry only $${toDollars(took - notPlaced).toFixed(2)} of it` +
          (feeByHand > 0 ? ` ($${toDollars(feeByHand).toFixed(2)} of it is card fee, which a later dispute of the same payment does not take off the landlord's payout by itself)` : '') +
          `. Bill the other $${toDollars(notPlaced).toFixed(2)} to the tenant, or settle it with the landlord, by hand — GAM does not absorb it.`,
        context: { stripe_payment_intent_id: pi, payment_id: onlyRowId, stripe_event_id: input.stripeEventId, short: toDollars(notPlaced),
                   card_fee_part: toDollars(feeByHand) },
      })
    }

    if (charged.length === 0 && flexRows.length === 0 && !claw?.creditId) {
      await client.query('ROLLBACK')
      // A charge GAM does not know at all (no row, no receipt) is not a tenant
      // payment: 'unknown_charge', for the caller to place.
      const known = await alertNothingReversed(pi, onlyRowId, input)
      return NONE(known ? 'not_settled' : 'unknown_charge')
    }

    // The event's fee goes on a record, and is billed, ONCE per Stripe object:
    // a second event for the same dispute or return (a new event id) names
    // itself with $0 records, so a reader summing reversal_fee counts Stripe's
    // cost once.
    const feeNote = `${feeDescription} — ${input.stripeObjectId ?? input.stripeEventId}`
    const feeBilledBefore = input.reversalFee > 0 && (((await client.query(
      `SELECT 1 FROM payments d WHERE d.entry_description = 'RETURNFEE' AND d.notes = $1
       UNION ALL
       SELECT 1 FROM payment_reversals pr
        WHERE $2::text IS NOT NULL AND pr.stripe_object_id = $2 AND pr.stripe_event_id <> $3 AND pr.reversal_fee > 0
       LIMIT 1`, [feeNote, input.stripeObjectId ?? null, input.stripeEventId])).rowCount ?? 0) > 0)
    const eventFee = feeBilledBefore ? 0 : input.reversalFee

    // 3. One record per row of the charge; a row that lost money reopens.
    const out: ReopenedRow[] = []
    const anchor = [...byCharge].sort((a, b) =>
      Number(b.type === 'rent') - Number(a.type === 'rent') || a.id.localeCompare(b.id))[0] ?? null
    for (const r of byCharge) {
      const rr = await writeRowReversal(client, {
        row: r, lostCents: (lostByRow.get(r.id) ?? 0) + (spendOnChargedRow.get(r.id) ?? 0), reversalType: input.reversalType,
        // The event's fee is recorded once, on the row that speaks for the charge.
        reversalFee: anchor && r.id === anchor.id ? eventFee : 0,
        stripeEventId: input.stripeEventId, stripeObjectId: input.stripeObjectId,
        connectDisputeId: input.connectDisputeId, rawEvent: input.rawEvent, kind: 'charge',
      })
      if (rr) { out.push(rr); if (rr.newPaymentId && r.invoice_id) invoices.add(r.invoice_id) }
    }

    // 4. Later bills the charge's paid-ahead money paid: each reopens for the use amount.
    //    With no row of the charge's own to speak for it, the first carries the event's fee.
    let feeOnSpend = !anchor && flexRows.length === 0
    for (const [paymentId, cents] of [...spends.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const row = (await client.query<ChargeRow>(
        `SELECT p.id, p.type, p.status, p.amount::text AS amount, p.invoice_id, p.tenant_id, p.landlord_id,
                p.lease_id, p.unit_id, p.due_date::text AS due_date, p.entry_description, p.revenue_owner,
                p.lease_fee_id, p.notes, p.created_at, '0' AS money_part
           FROM payments p WHERE p.id = $1 FOR UPDATE`, [paymentId])).rows[0]
      if (!row) continue
      const rr = await writeRowReversal(client, {
        row, lostCents: cents, reversalType: input.reversalType, reversalFee: feeOnSpend ? eventFee : 0,
        stripeEventId: input.stripeEventId, stripeObjectId: input.stripeObjectId,
        connectDisputeId: input.connectDisputeId, rawEvent: input.rawEvent, kind: 'credit_spend',
      })
      if (rr) { feeOnSpend = false; out.push(rr); if (rr.newPaymentId && row.invoice_id) invoices.add(row.invoice_id) }
    }

    // 5. FlexPay pulls: GAM's own money — its advance is written off, never a reopened row.
    for (const f of flexRows) {
      const { handleFlexPayPullReversed } = await import('./flexpay')
      const fx = await handleFlexPayPullReversed(f.id, client, { reversalFee: eventFee })
      flexAfter.push(fx.afterCommit)
      const rec = await client.query<{ id: string }>(
        `INSERT INTO payment_reversals
           (payment_id, landlord_id, tenant_id, lease_id, reversal_type, reversed_amount, reversal_fee,
            stripe_event_id, stripe_object_id, connect_dispute_id, raw_event, recovery_status, status, resolved_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'not_needed','resolved',NOW())
         ON CONFLICT (stripe_event_id, payment_id) DO NOTHING RETURNING id`,
        [f.id, f.landlord_id, f.tenant_id, f.lease_id, input.reversalType, toDollars(toCents(f.amount)).toFixed(2),
         byCharge.length === 0 ? eventFee.toFixed(2) : '0.00', input.stripeEventId, input.stripeObjectId ?? null,
         input.connectDisputeId ?? null, JSON.stringify(input.rawEvent ?? {})])
      if (rec.rows[0]) {
        out.push({ paymentId: f.id, reversalId: rec.rows[0].id, newPaymentId: null, lost: toDollars(toCents(f.amount)), owedAgain: 0,
                   revenueOwner: f.revenue_owner, landlordId: f.landlord_id, landlordRecovery: false,
                   withheld: 0, routed: 0, kind: 'charge' })
      }
    }

    // A charge that paid no rows (money paid ahead, nothing owed): one $0
    // record names the event, so the credit's take-back has a record and a
    // redelivery is recognized.
    if (out.length === 0 && claw?.creditId && rem) {
      const lease = rem.lease_id ?? (await client.query<{ lease_id: string }>(
        `SELECT lease_id FROM lease_prepaid_credits WHERE id = $1`, [claw.creditId])).rows[0]?.lease_id ?? null
      const holder = await client.query<{ id: string }>(
        `SELECT p.id FROM payments p WHERE p.stripe_payment_intent_id = $1 ORDER BY p.id LIMIT 1`, [pi])
      if (holder.rows[0]) {
        const rec = await client.query<{ id: string }>(
          `INSERT INTO payment_reversals
             (payment_id, landlord_id, tenant_id, lease_id, reversal_type, reversed_amount, reversal_fee,
              stripe_event_id, stripe_object_id, connect_dispute_id, raw_event, recovery_status, status, resolved_at)
           VALUES ($1,$2,$3,$4,$5,0,$6,$7,$8,$9,$10,'not_needed','resolved',NOW())
           ON CONFLICT (stripe_event_id, payment_id) DO NOTHING RETURNING id`,
          [holder.rows[0].id, rem.landlord_id, rem.tenant_id, lease, input.reversalType, eventFee.toFixed(2),
           input.stripeEventId, input.stripeObjectId ?? null, input.connectDisputeId ?? null, JSON.stringify(input.rawEvent ?? {})])
        if (rec.rows[0]) out.push({ paymentId: holder.rows[0].id, reversalId: rec.rows[0].id, newPaymentId: null, lost: 0, owedAgain: 0,
                                    revenueOwner: 'landlord', landlordId: rem.landlord_id, landlordRecovery: false,
                                    withheld: 0, routed: 0, kind: 'charge' })
      }
    }

    // 6. The credit's take-back that waited for a record of this event.
    //    takeBackDisputedCredit reads what the dispute still claims off the
    //    records, where a spend reopened on a row that carries this charge's
    //    own intent counts as money off the charge's rows — read twice, so it
    //    can take back less than the take-back above owes the dispute. What it
    //    leaves is taken here, against this event's record, never more than
    //    the credit holds. After whole spends (above), the take-back already
    //    knows exactly what the claim is: that amount is taken, and only that
    //    (the rest of the undone spend is the tenant's credit again).
    if (claw?.creditId && toCents(claw.drainPending) > 0) {
      const named = out.find(o => o.kind === 'charge')?.reversalId ?? out[0]?.reversalId ?? null
      const owed = toCents(claw.drainPending)
      if (!named) {
        await takeBackDisputedCredit(client, claw.creditId, null)
      } else if (wholeSpends) {
        await drainCreditForRecord(client, claw.creditId, named, owed)
      } else {
        const r = await takeBackDisputedCredit(client, claw.creditId, named)
        if (toCents(r.drained) < owed) await drainCreditForRecord(client, claw.creditId, named, owed - toCents(r.drained))
      }
    }

    // 7. The dispute/return fee, once per event, billed to the tenant at cost.
    // A FlexPay-only charge carries it on its advance instead (written off with
    // it). The note names Stripe's dispute (or the event): a redelivery of an
    // event that could write no record finds the fee already billed.
    let feeRowId: string | null = null
    const feeHome = anchor ?? (claw?.creditId ? await creditHome(client, claw.creditId) : null)
    if (eventFee > 0 && feeHome && feeHome.tenant_id) {
      feeRowId = (await client.query<{ id: string }>(
        `INSERT INTO payments
           (unit_id, lease_id, tenant_id, landlord_id, type, amount, status,
            entry_description, due_date, invoice_id, notes, revenue_owner)
         -- S609: GAM's own fee (REVENUE_OWNERS, packages/shared) — never an owner share.
         SELECT $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'fee', $5::numeric, 'pending', 'RETURNFEE',
                COALESCE((SELECT (NOW() AT TIME ZONE pr.timezone)::date FROM units u JOIN properties pr ON pr.id = u.property_id
                           WHERE u.id = $1::uuid), (NOW() AT TIME ZONE 'America/Phoenix')::date),
                $6::uuid, $7::text, 'gam'
          WHERE NOT EXISTS (SELECT 1 FROM payments d WHERE d.entry_description = 'RETURNFEE' AND d.notes = $7::text)
         RETURNING id`,
        [feeHome.unit_id, feeHome.lease_id, feeHome.tenant_id, feeHome.landlord_id,
         eventFee.toFixed(2), feeHome.invoice_id, feeNote])).rows[0]?.id ?? null
    } else if (eventFee > 0 && flexRows.length === 0) {
      afterAlerts.push({
        severity: 'warn', category: 'payment_reversal_fee_unbilled',
        title: `A ${input.reversalType === 'card_dispute' ? 'dispute' : 'return'} fee of $${input.reversalFee.toFixed(2)} could not be billed`,
        body: `Stripe charged $${input.reversalFee.toFixed(2)} for event ${input.stripeEventId} on ${pi ?? onlyRowId}, but no tenant charge or credit could carry it. Bill it to the tenant by hand — GAM does not absorb it.`,
        context: { stripe_event_id: input.stripeEventId, stripe_payment_intent_id: pi, reversal_fee: input.reversalFee },
      })
    }

    // 8. GAM's spread booked on the charge: kept under the rule in force
    // (decisions #38 Q4: GAM keeps the fee it already earned); reversed for
    // the part of the fee the dispute took only under the superseded rule.
    const firstRecord = out[0]?.reversalId ?? null
    const spreadRef = rem?.id ?? firstRecord
    const spreadReversed = spreadRef && feeTaken > 0 && DISPUTE_FEE_RULE === 'gam_gives_up_spread'
      ? await reverseChargeSpread(client, { pi, onlyRowId, remittanceId: rem?.id ?? null, feeTotal: Math.max(0, gross - chargeMoney),
          feeTaken, reference: spreadRef, eventId: input.stripeEventId, propertyUnitId: anchor?.unit_id ?? null })
      : 0

    // 9. The fee the dispute took back (the whole of it under the rule in
    // force; Stripe's kept cost only under the superseded one), split among
    // the landlords by each one's share of the money this event took back —
    // their rows' losses, plus the charge's unspent paid-ahead money for the
    // receipt's landlord (it was held for them). The share of GAM's own money
    // (a GAM fee, a FlexPay pull, GAM-first money a landlord row routed to a
    // GAM balance) is GAM's: GAM was its recipient. Once per charge and landlord.
    const weights = new Map<string, number>()
    let weightTotal = 0
    for (const o of out) {
      const c = toCents(o.lost)
      if (c <= 0) continue
      weightTotal += c
      const theirs = o.revenueOwner === 'landlord' ? Math.max(0, c - toCents(o.routed)) : 0
      if (theirs > 0) weights.set(o.landlordId, (weights.get(o.landlordId) ?? 0) + theirs)
    }
    const spendCents = (claw?.reversed ?? []).reduce((s, u) => s + toCents(u.amount), 0)
    const unspentClawed = Math.max(0, clawed - spendCents)
    if (unspentClawed > 0 && rem) {
      weightTotal += unspentClawed
      weights.set(rem.landlord_id, (weights.get(rem.landlord_id) ?? 0) + unspentClawed)
    }
    // A follow-up dispute's card-fee part is named to settle by hand (the
    // short alert above, and creditUse's 'dispute_second_on_charge' notice),
    // never netted here too: one place settles it.
    const stripeFeeKept = feeTaken > 0 && !followUpDispute && pi && weights.size > 0
      ? await chargeKeptStripeFee(client, {
          pi, remittanceId: rem?.id ?? null, feeTotal: Math.max(0, gross - chargeMoney), feeTaken,
          weights, weightTotal, reversalType: input.reversalType, eventId: input.stripeEventId, alerts: afterAlerts,
        })
      : 0

    // 9b. GAM-first money the charge lost that could not be put back on a
    // GAM balance here: a person reopens it (never silently GAM's loss).
    const byHand = out.flatMap(o => o.gamBalancesByHand ?? [])
    const unplaced = out.reduce((s, o) => s + (o.routedUnplacedCents ?? 0), 0)
    if (byHand.length > 0 || unplaced > 0) {
      afterAlerts.push({
        severity: 'critical', category: 'payment_reversal_gam_balance_reopen',
        title: `A disputed or returned payment had paid GAM balances: reopen them (${pi ?? onlyRowId})`,
        body: `Part of this payment went to the tenant's GAM balances first (GAM-first routing), and Stripe took it back (event ${input.stripeEventId}). ` +
          (byHand.length > 0
            ? `These balances it paid must be opened again by hand: ${byHand.map(b => `${b.source} ${b.ref_id} ($${b.amount.toFixed(2)})`).join(', ')}. `
            : '') +
          (unplaced > 0
            ? `$${toDollars(unplaced).toFixed(2)} of it could not be put back on a whole balance; bill it to the tenant as a GAM balance. `
            : '') +
          'None of it is recovered from the landlord: it was never theirs.',
        context: { stripe_payment_intent_id: pi, stripe_event_id: input.stripeEventId, by_hand: byHand, unplaced: toDollars(unplaced) },
      })
    }

    // 10. The bills those rows sit on are open again.
    for (const invoiceId of [...invoices].sort()) {
      const others = await client.query(
        `SELECT 1 FROM payments
          WHERE invoice_id = $1 AND type <> 'late_fee' AND status = 'settled' LIMIT 1`, [invoiceId])
      await client.query(
        `UPDATE invoices SET status = $2, updated_at = NOW() WHERE id = $1 AND status <> 'void'`,
        [invoiceId, (others.rowCount ?? 0) > 0 ? 'partial' : 'pending'])
    }

    await client.query('COMMIT')
    const reopenedTotal = toDollars(out.filter(o => o.newPaymentId).reduce((s, o) => s + toCents(o.owedAgain), 0))
    const perLandlord = new Map<string, number>()
    for (const o of out) {
      if (!o.newPaymentId || o.revenueOwner !== 'landlord') continue
      perLandlord.set(o.landlordId, (perLandlord.get(o.landlordId) ?? 0) + toCents(o.owedAgain))
    }
    const landlordTotal = toDollars([...perLandlord.values()].reduce((s, c) => s + c, 0))
    result = {
      handled: true, reversalId: firstRecord ?? undefined, reversalIds: out.map(o => o.reversalId), rows: out,
      reopenedTotal, landlordTotal,
      landlordTotals: Object.fromEntries([...perLandlord.entries()].map(([k, c]) => [k, toDollars(c)])),
      creditClawed: toDollars(clawed), feeRowId, spreadReversed: toDollars(spreadReversed),
      stripeFeeKept: toDollars(stripeFeeKept),
    }
  } catch (e) {
    try { await client.query('ROLLBACK') } catch { /* already rolled back */ }
    // Fix pass (rev8): "try again in a moment" (a refund of this money was
    // being sent at that same moment, or Stripe could not be reached) is no
    // failure: nothing was written, and the caller's retry (Stripe redelivers
    // a webhook it got no 2xx for) handles it. Logged, never a critical alert.
    const { isDisputeRetryLater } = await import('./creditUse')
    if (isDisputeRetryLater(e)) {
      logger.warn({ err: e, stripe_payment_intent_id: pi, stripe_event_id: input.stripeEventId },
        '[payment_reversal] put off: try again in a moment')
      throw e
    }
    await createAdminNotification({
      severity: 'critical',
      category: 'payment_reversal_failed',
      title:    `Payment reversal handling failed for ${pi ?? onlyRowId}`,
      body:     e instanceof Error ? e.message : String(e),
      context:  { stripe_payment_intent_id: pi, payment_id: input.paymentId ?? null, stripe_event_id: input.stripeEventId },
    }).catch(() => {})
    throw e
  } finally {
    client.release()
  }

  // ── After the commit ───────────────────────────────────────────────────────
  for (const a of afterAlerts) await createAdminNotification(a).catch(() => {})
  for (const send of flexAfter) {
    try { await send() } catch (e) { logger.error({ err: e }, '[payment_reversal] FlexPay notice failed') }
  }
  // Back-fill late fees on the reopened bills now, so the balance and the
  // landlord's notice are true today. Best effort; the nightly run backstops it.
  for (const invoiceId of [...invoices].sort()) {
    try {
      const { generateLateFeesForInvoice } = await import('../jobs/lateFees')
      await generateLateFeesForInvoice(invoiceId)
    } catch (e) {
      logger.error({ err: e, invoice_id: invoiceId }, '[payment_reversal] late-fee backfill failed')
    }
  }
  // Step 9 final fix (deprefund review): a deposit payment part of whose money
  // a finalized move-out put on its refund — the refund share not sent yet is
  // stopped for what this took back, and the reopened charge lowered by it
  // (decisions #51/#54), for EVERY caller (the dispute webhook, the bank-return
  // route), so the owner's to-do never asks for a refund the return already
  // sent back. Idempotent (a caller that also runs it changes nothing); never throws.
  for (const r of result.rows) {
    if (!r.newPaymentId) continue
    try {
      const { noteDepositRefundOfReturnedPayment } = await import('./depositRefundSend')
      await noteDepositRefundOfReturnedPayment(r.paymentId)
    } catch (e) {
      logger.error({ err: e, payment_id: r.paymentId }, '[payment_reversal] move-out refund check failed')
    }
  }
  // Before the landlord's notice: a reopened deposit charge that check lowered
  // (the dispute already gave the unsent refund back) is told at what the
  // tenant really owes now, never at the amount first reopened.
  const nothingOwedNow = new Set<string>()
  const depositNow = (await query<{ id: string; owed: string }>(
    `SELECT id, CASE WHEN status IN ('pending', 'failed') THEN amount ELSE 0 END::text AS owed
       FROM payments WHERE id = ANY($1::uuid[]) AND type = 'deposit'`,
    [result.rows.filter(r => r.newPaymentId).map(r => r.newPaymentId!)]).catch(() => [])).reduce(
    (m, x) => m.set(x.id, toCents(x.owed)), new Map<string, number>())
  for (const r of result.rows) {
    const now = r.newPaymentId ? depositNow.get(r.newPaymentId) : undefined
    if (now === undefined || r.revenueOwner !== 'landlord') continue
    const less = Math.max(0, toCents(r.owedAgain) - now)
    if (less <= 0) continue
    result.landlordTotals[r.landlordId] = toDollars(toCents(result.landlordTotals[r.landlordId] ?? 0) - less)
    result.landlordTotal = toDollars(toCents(result.landlordTotal) - less)
    result.reopenedTotal = toDollars(toCents(result.reopenedTotal) - less)
    if (toCents(result.landlordTotals[r.landlordId]) <= 0) nothingOwedNow.add(r.landlordId)
  }
  // ONE notice per landlord per event, with only that landlord's rows: they
  // must hear the tenant owes again, or they never act — and never hear of
  // another landlord's money (a neighbor's utility on the same bill).
  for (const landlordId of Object.keys(result.landlordTotals).sort()) {
    // The tenant owes this landlord nothing again (the dispute only took back a refund never sent): nothing to tell.
    if (nothingOwedNow.has(landlordId)) continue
    await notifyLandlordOfReversal(result, landlordId).catch((e) =>
      logger.error({ err: e, stripe_event_id: input.stripeEventId, landlord_id: landlordId }, '[payment_reversal] landlord notify failed'))
  }
  // ONE recovery decision per event, across its rows (net vs ACH pull).
  if (result.rows.some(r => r.landlordRecovery)) {
    try {
      const { decideEventRecovery } = await import('./reversalRecovery')
      await decideEventRecovery(input.stripeEventId)
    } catch (e) {
      logger.error({ err: e, stripe_event_id: input.stripeEventId }, '[payment_reversal] recovery decision failed')
    }
  }
  return result
}

// ─── A dispute GAM won (decisions #55) ───────────────────────────────────────

export interface WonDisputeInput {
  /** Stripe's dispute id: the records' stripe_object_id. */
  stripeDisputeId: string
  /** The webhook event that said the dispute was won. */
  stripeEventId: string
  /** connect_disputes.id, when on file. */
  connectDisputeId?: string | null
  /** The disputed charge (dispute.payment_intent). */
  paymentIntentId?: string | null
  /**
   * Cents of Stripe's dispute fee Stripe gave back with the win
   * (stripeCosts.disputeFeeReturnedOnWinCents of the dispute object). The
   * pass-through dispute fee billed to the tenant is taken off only when
   * Stripe gave it back; a fee Stripe kept is still its actual cost, passed
   * through at cost as before.
   */
  feeReturnedCents: number
}

export interface WonDisputeResult {
  handled: boolean
  reason?: string
  /** Reopened rows the tenant no longer owes ('voided'). */
  voidedRows: string[]
  /** The disputed rows paid again ('returned' → 'settled'). */
  restoredRows: string[]
  /** Dollars given back to each landlord on a held line (what was withheld or recovered from them). */
  landlordGivenBack: Record<string, number>
  /** Dollars of paid-ahead money given back to the tenant (new GAM-held paid-ahead credit). */
  creditRestored: number
  creditIds: string[]
  feeRowVoided: boolean
  lateFeesVoided: string[]
  /** Dollars of the card or bank fee the dispute had netted from landlords, handed back. */
  feeLinesGivenBack: number
  /** What a person settles by hand (also told to an admin, loudly). */
  byHand: string[]
  /** Ended leases the given-back paid-ahead money went to: listed for the landlord's paid-ahead money choice (#46.1). */
  waitsForChoice: string[]
}

/** The admin notice that marks a won dispute's undo as done (written in its own transaction). */
export const DISPUTE_WON_UNDONE_CATEGORY = 'dispute_won_undone'

const WON_NOTE = 'the card company decided the dispute for us and the money came back'

/**
 * NOT CALLED IN THIS DEPLOY (decisions #55-AMENDED): a won dispute is undone
 * by hand from the notice raiseWonDisputeNotice (below) raises. Kept for the
 * follow-up that wires it together with the report readers; known open review
 * points for that follow-up: a late fee the tenant already PAID for a day only
 * the reopened line was owed stays paid (step 6 voids only unpaid ones), and
 * step 6 voids nothing on a bill with any other line still open.
 *
 * Step 10 final fix — decisions #55 ("A dispute GAM WINS undoes exactly what
 * that dispute did: the reopened rows it created are voided (the tenant no
 * longer owes them), the landlord's withheld or netted share is given back on
 * a held line, drained paid-ahead credit is restored, and later disputes count
 * it consistently"). Runs on charge.dispute.closed / funds_reinstated with
 * status 'won', after the webhook recorded the win (connect_disputes.status
 * 'won' — the mark every count reads: creditUse.liveReversalSql). Per record
 * of the dispute:
 *
 *   - its reopened row, still owed (pending with no charge on it, or failed —
 *     a scheduled bank retry is called off and its set-aside credit given
 *     back first), is VOIDED: kept as a record, out of every balance;
 *   - the row the dispute took back goes from 'returned' to 'settled' again —
 *     the charge's money is GAM's again (utility bills follow it to 'paid') —
 *     unless another dispute still standing took money off it too;
 *   - what was taken from the landlord for it (their unpaid share withheld,
 *     an earlier held line netted, or a recovery netted from a payout — the
 *     record's recovered amount less GAM-first money, which was never theirs)
 *     is given back on ONE positive held line ('owner_share_returned_on_win:
 *     <record>'), and a recovery still to come is called off;
 *   - a reopened row the tenant ALREADY PAID AGAIN is left as it is (that
 *     payment squared the landlord through the normal repayment path): the
 *     tenant paid twice and GAM holds the second payment (Stripe gave the
 *     first back), so it becomes their GAM-held paid-ahead money — the rule
 *     for any money GAM holds beyond what is owed (§3);
 *   - a reopened row whose payment is still clearing cannot be decided here:
 *     a person settles it (told loudly).
 *
 * Then, once per dispute:
 *   - paid-ahead money the dispute drained (its 'reversal' take-backs, or the
 *     credit it withdrew) comes back as new GAM-held paid-ahead money, less
 *     the spends it undid on rows paid by them again (those rows are paid by
 *     the spend once more — v_payment_money counts a reversed use on the row);
 *     a credit use is a record and never moves back, so this is a new credit.
 *     When it undid MORE of a credit's spends than it took off it (a partial
 *     dispute undoes a spend whole), the credit holds that difference twice:
 *     it is taken off the credit in the same transaction (fix pass 2), then
 *     off the tenant's repayment of such a row, and only what neither holds
 *     is told by hand;
 *   - a charge that paid no bill has no record (nothing to name): the credit
 *     it withdrew is found by the charge's intent, the fee by its note, the
 *     kept-fee line by the intent (fix pass 2), so its win undoes them too;
 *   - money given back on a lease that has ended waits for the landlord's
 *     paid-ahead money choice (decisions #46.1: it is on their to-do);
 *   - the pass-through dispute fee billed to the tenant is voided when Stripe
 *     gave its fee back (a fee already paid becomes their paid-ahead money);
 *   - the card or bank fee the dispute netted from landlords' payouts
 *     ('stripe_fee_kept:<intent>:<landlord>') is handed back on the line
 *     stripeCosts reads for it (wonDisputeFeeReturnSourceId);
 *   - late fees back-filled on the reopened bills are voided when nothing
 *     else on that bill is owed — only those for days when nothing else on
 *     the bill was owed (a fee for a day another line was still unpaid is the
 *     landlord's) — and the bill reads paid again.
 * What it cannot undo by itself (GAM balances GAM-first money reopened, a
 * FlexPay pull written off, a move-out refund the dispute stopped, the
 * paid-ahead money screen's lines) is told to an admin with the amounts —
 * never left on nobody, never absorbed by GAM in silence.
 *
 * Idempotent: one undo per dispute (an admin notice in the same transaction
 * marks it done; every write is also guarded by state). Same lock order as
 * handlePaymentReversal. Refused (handled false) unless the dispute on file
 * says 'won'.
 */
export async function undoWonDispute(input: WonDisputeInput): Promise<WonDisputeResult> {
  const out: WonDisputeResult = {
    handled: false, voidedRows: [], restoredRows: [], landlordGivenBack: {}, creditRestored: 0, creditIds: [],
    feeRowVoided: false, lateFeesVoided: [], feeLinesGivenBack: 0, byHand: [], waitsForChoice: [],
  }
  const {
    DISPUTE_STATUS_WON, DISPUTE_STATUSES_MONEY_TAKEN, liveReversalSql, supersedeScheduledRetry, cancelSupersededIntents, createPaidAhead,
    runWholeBillCheckAfterCommit, takeBackCreditAgainstRecord, WITHDRAWN_BY_CARD_DISPUTE, WITHDRAWN_BY_BANK_RETURN,
  } = await import('./creditUse')
  const won = await queryOne<{ id: string; pi: string | null }>(
    `SELECT id, stripe_payment_intent_id AS pi FROM connect_disputes
      WHERE stripe_dispute_id = $1 AND status = $2`, [input.stripeDisputeId, DISPUTE_STATUS_WON])
  if (!won) return { ...out, reason: 'not_won' }
  const connectId = input.connectDisputeId ?? won.id
  const recsSql = `SELECT pr.id FROM payment_reversals pr
                    WHERE pr.stripe_object_id = $1 OR pr.connect_dispute_id = $2::uuid`
  const head = await queryOne<{ payment_id: string; pi: string | null }>(
    `SELECT pr.payment_id, p.stripe_payment_intent_id AS pi FROM payment_reversals pr JOIN payments p ON p.id = pr.payment_id
      WHERE pr.id IN (${recsSql}) ORDER BY (p.manual_method IS NULL AND p.stripe_payment_intent_id IS NOT NULL) DESC, pr.created_at, pr.id LIMIT 1`,
    [input.stripeDisputeId, connectId])
  // Fix pass 2 (review): a charge that paid no bill (all of it banked as
  // paid-ahead money) has no record when the dispute withdrew that money
  // whole (creditUse.withdrawDisputedCredit) or kept a partial claim on it
  // (alertDisputeUnrecorded) — there is no row a record could name. The win
  // still undoes what that dispute did there: the withdrawn credit given back
  // (step 3 finds it by the charge's intent), the pass-through fee (step 4,
  // by its note) and the kept-fee line (step 5, by the intent). Only a
  // dispute with neither a record nor a charge has nothing to undo.
  const pi = input.paymentIntentId ?? won.pi ?? head?.pi ?? null
  if (!head && !pi) return { ...out, reason: 'nothing_reversed' }
  const markerSql = `SELECT 1 FROM admin_notifications WHERE category = '${DISPUTE_WON_UNDONE_CATEGORY}' AND context->>'stripe_dispute_id' = $1
                     UNION ALL
                     SELECT 1 FROM admin_notifications_archive WHERE category = '${DISPUTE_WON_UNDONE_CATEGORY}' AND context->>'stripe_dispute_id' = $1
                     LIMIT 1`
  if (await queryOne(markerSql, [input.stripeDisputeId])) return { ...out, reason: 'already_undone' }

  const who = await chargeHousehold(pi, head?.payment_id ?? null)
  const payees = (await query<{ landlord_id: string }>(
    `SELECT DISTINCT landlord_id::text AS landlord_id FROM (
       SELECT pr.landlord_id FROM payment_reversals pr WHERE pr.id IN (${recsSql}) AND pr.landlord_id IS NOT NULL
       UNION ALL
       SELECT p.landlord_id FROM payments p WHERE $3::text IS NOT NULL AND p.stripe_payment_intent_id = $3 AND p.landlord_id IS NOT NULL
       UNION ALL
       SELECT r.landlord_id FROM tenant_remittances r WHERE $3::text IS NOT NULL AND r.stripe_payment_intent_id = $3) x`,
    [input.stripeDisputeId, connectId, pi])).map(r => r.landlord_id)
  if (who) payees.push(who.landlordId)

  const cancelAfter: string[] = []
  const wholeBill = new Map<string, { tenantId: string; landlordId: string }>()
  const client = await getClient()
  try {
    await client.query('BEGIN')
    if (who) {
      await lockHousehold(client, who.tenantId, who.landlordId)
      await client.query(`SELECT 1 FROM tenants WHERE id = $1 FOR UPDATE`, [who.tenantId])
    }
    for (const id of [...new Set(payees)].sort()) {
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [payoutLockKey(id)])
    }
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`payment_reversal:${pi ?? head!.payment_id}`])
    if ((await client.query(markerSql, [input.stripeDisputeId])).rowCount) {
      await client.query('ROLLBACK')
      return { ...out, reason: 'already_undone' }
    }

    const recs = (await client.query<{
      id: string; payment_id: string; landlord_id: string | null; tenant_id: string | null; reversed_amount: string
      recovered_amount: string; recovery_status: string; created_at: Date
      p_type: string; p_status: string; p_entry: string | null; p_owner: string; p_invoice: string | null; p_lease: string | null
      p_unit: string | null; p_gam_first: string; p_released: string | null; p_pi: string | null; p_manual: string | null
    }>(
      `SELECT pr.id, pr.payment_id, pr.landlord_id, pr.tenant_id, pr.reversed_amount::text AS reversed_amount,
              pr.recovered_amount::text AS recovered_amount, pr.recovery_status, pr.created_at,
              p.type AS p_type, p.status AS p_status, p.entry_description AS p_entry, p.revenue_owner AS p_owner,
              p.invoice_id AS p_invoice, p.lease_id AS p_lease, p.unit_id AS p_unit,
              COALESCE(p.gam_supersedence_amount, 0)::text AS p_gam_first, p.released_by_deposit_return_id::text AS p_released,
              p.stripe_payment_intent_id AS p_pi, p.manual_method AS p_manual
         FROM payment_reversals pr JOIN payments p ON p.id = pr.payment_id
        WHERE pr.id IN (${recsSql})
        ORDER BY pr.id FOR UPDATE OF pr`, [input.stripeDisputeId, connectId])).rows
    const recIds = recs.map(r => r.id)
    // The rows they reopened, locked in id order with the originals.
    const reopened = (await client.query<{
      id: string; reversal_id: string; status: string; amount: string; lease_id: string | null; tenant_id: string | null
      invoice_id: string | null; pi: string | null
    }>(
      `SELECT id, reversal_id, status, amount::text AS amount, lease_id, tenant_id, invoice_id, stripe_payment_intent_id AS pi
         FROM payments WHERE reversal_id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`, [recIds])).rows
    await client.query(`SELECT 1 FROM payments WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
      [[...new Set(recs.map(r => r.payment_id))]])
    const byRec = new Map<string, typeof reopened>()
    for (const n of reopened) byRec.set(n.reversal_id, [...(byRec.get(n.reversal_id) ?? []), n])

    const invoices = new Set<string>()
    const earliest = recs.reduce((m, r) => (r.created_at < m ? r.created_at : m), recs[0]?.created_at ?? new Date())
    /** Rows whose undone spends count as paid by the spend again (not given back as credit). */
    const paidBySpendAgain = new Set<string>()
    const repaidCredit: Array<{ leaseId: string | null; tenantId: string | null; cents: number; rowId: string; origId: string; deposit: boolean }> = []
    const { recordHeldItem } = await import('./heldPayouts')

    // 1. The reopened rows, record by record.
    const toVoid: string[] = []
    const decided = new Map<string, 'void' | 'repaid' | 'in_flight' | 'none'>()
    for (const r of recs) {
      const rows = byRec.get(r.id) ?? []
      let state: 'void' | 'repaid' | 'in_flight' | 'none' = 'none'
      for (const n of rows) {
        if (n.status === 'voided') { state = state === 'none' ? 'void' : state; continue }
        if ((n.status === 'pending' && !n.pi) || n.status === 'failed') { toVoid.push(n.id); if (state === 'none') state = 'void'; continue }
        if (n.status === 'settled' || n.status === 'paid_via_deposit') {
          state = 'repaid'
          repaidCredit.push({ leaseId: n.lease_id, tenantId: n.tenant_id, cents: toCents(n.amount), rowId: n.id,
                              origId: r.payment_id, deposit: n.status === 'paid_via_deposit' })
          continue
        }
        state = 'in_flight'
        out.byHand.push(`The reopened charge ${n.id} ($${toDollars(toCents(n.amount)).toFixed(2)}) is being paid right now (${n.status}). ` +
          'If that payment clears, the tenant has paid it twice (the card company gave the first payment back): save what they paid again as their paid-ahead money. ' +
          'If it fails, void the charge (they no longer owe it) and give the landlord back what record ' + r.id + ' recovered from them.')
      }
      decided.set(r.id, state)
      if (r.p_invoice) invoices.add(r.p_invoice)
      for (const n of rows) if (n.invoice_id) invoices.add(n.invoice_id)
    }
    if (toVoid.length > 0) {
      // A scheduled bank retry on them is called off first (its set-aside credit given back).
      const sup = await supersedeScheduledRetry(client, toVoid)
      cancelAfter.push(...sup.cancelAfterCommit)
      const v = await client.query<{ id: string }>(
        // A voided rent row is a record, never the month's rent row: it is
        // marked a remainder so the one-rent-row-per-unit-and-month index
        // (which leaves out only failed and returned rows) lets the disputed
        // row it replaced be the month's rent again (step 2).
        `UPDATE payments SET status = 'voided', voided_at = NOW(), next_retry_at = NULL,
                is_remainder = is_remainder OR type = 'rent',
                void_reason = $2, notes = COALESCE(notes || ' — ', '') || $3
          WHERE id = ANY($1::uuid[]) AND status IN ('pending', 'failed')
            AND NOT EXISTS (SELECT 1 FROM credit_uses u WHERE u.payment_id = payments.id AND u.status IN ('held', 'applied'))
          RETURNING id`,
        [toVoid, `No longer owed: ${WON_NOTE}`, `Dispute ${input.stripeDisputeId} won — no longer owed`])
      out.voidedRows.push(...v.rows.map(x => x.id))
      const missed = toVoid.filter(id => !out.voidedRows.includes(id))
      for (const id of missed) {
        out.byHand.push(`The reopened charge ${id} could not be voided (credit is set aside or spent on it). Take it off the tenant's balance by hand: the dispute was won.`)
        const rec = reopened.find(n => n.id === id)
        if (rec) decided.set(rec.reversal_id, 'in_flight')
      }
    }

    // 2. The disputed rows are paid again, and the landlord gets back what was taken from them.
    for (const r of recs) {
      const state = decided.get(r.id)
      if (state === 'repaid' || state === 'in_flight') continue
      const lost = toCents(r.reversed_amount)
      if (r.p_entry === 'FLEXPAY' && lost > 0) {
        out.byHand.push(`FlexPay pull ${r.payment_id} ($${toDollars(lost).toFixed(2)}) was written off when it was disputed. The money came back: put the FlexPay advance back as collected by hand.`)
        continue
      }
      // Paid again — unless a dispute still standing took money off it too.
      const restored = await client.query(
        `UPDATE payments SET status = 'settled', return_code = NULL, return_reason = NULL
          WHERE id = $1 AND status = 'returned'
            AND NOT EXISTS (SELECT 1 FROM payment_reversals pr
                             WHERE pr.payment_id = payments.id AND pr.reversed_amount > 0 AND ${liveReversalSql('pr')})
          RETURNING id`, [r.payment_id])
      if (restored.rowCount) { out.restoredRows.push(r.payment_id); paidBySpendAgain.add(r.payment_id) }
      // What was taken from the landlord for this record: what it recovered,
      // less GAM-first money (never theirs). A reopened row asks lost − routed,
      // so routed = lost − that row's amount (a deposit row routes nothing).
      if (lost > 0 && (r.p_owner === 'landlord' || r.p_released) && r.landlord_id) {
        const askedAgain = (byRec.get(r.id) ?? []).reduce((s, n) => s + toCents(n.amount), 0)
        const routed = r.p_type === 'deposit' ? 0 : Math.max(0, lost - askedAgain)
        if (routed > 0) {
          out.byHand.push(`Payment ${r.payment_id}: $${toDollars(routed).toFixed(2)} of it had paid the tenant's GAM balances first (GAM-first routing). ` +
            'The dispute opened those balances again; the money came back, so mark them paid again by hand.')
        }
        const paidBack = toCents((await client.query<{ s: string }>(
          `SELECT COALESCE(SUM(amount), 0)::text AS s FROM held_payout_items
            WHERE source_type = 'dispute' AND source_id = $1`, [returnedShareSource(r.id)])).rows[0]?.s)
        const give = Math.max(0, toCents(r.recovered_amount) - routed - paidBack)
        if (give > 0) {
          const wrote = await recordHeldItem({
            landlordId: r.landlord_id, sourceType: 'dispute', sourceId: wonShareSource(r.id), amount: toDollars(give),
            description: r.p_type === 'deposit'
              ? await depositLineWords(client, r.payment_id, 'won')
              : 'A disputed payment came back — the card company decided for us — so your share of it is paid to you again',
          }, client)
          if (wrote) out.landlordGivenBack[r.landlord_id] = toDollars(toCents(out.landlordGivenBack[r.landlord_id] ?? 0) + give)
        }
      }
      if (r.p_type === 'deposit') {
        const { DEPOSIT_PART_TAKEN_BACK } = await import('./depositRefundSend')
        const stopped = toCents((await client.query<{ s: string }>(
          `SELECT COALESCE(SUM(toward_amount), 0)::text AS s FROM stay_refund_parts
            WHERE deposit_payment_id = $1 AND failure = $2`, [r.payment_id, DEPOSIT_PART_TAKEN_BACK])).rows[0]?.s)
        if (stopped > 0) {
          out.byHand.push(`The move-out refund of $${toDollars(stopped).toFixed(2)} from deposit payment ${r.payment_id} was stopped when it was disputed. ` +
            'The money came back: send that refund to the tenant by hand.')
        }
      }
      // Nothing more is asked of the landlord for it; the record is settled.
      await client.query(
        `UPDATE payment_reversals
            SET recovery_status = CASE WHEN recovery_status IN ('pending', 'scheduled_netting') THEN 'not_needed' ELSE recovery_status END,
                status = 'resolved', resolved_at = COALESCE(resolved_at, NOW()), updated_at = NOW()
          WHERE id = $1`, [r.id])
    }

    // 3. Paid-ahead money the dispute drained comes back (a new credit: a use never moves back).
    const credits = (await client.query<{
      credit_id: string; lease_id: string; tenant_id: string; funded_by: string; drained: string; withdrawn: string; undone: string
      undone_rows: string[] | null
    }>(
      `SELECT c.id AS credit_id, c.lease_id, c.tenant_id, c.funded_by,
              COALESCE((SELECT SUM(u.amount) FROM credit_uses u
                         WHERE u.prepaid_credit_id = c.id AND u.source = 'reversal' AND u.status = 'applied'
                           AND u.payment_reversal_id = ANY($1::uuid[])), 0)::text AS drained,
              CASE WHEN c.voided_at IS NOT NULL AND c.void_reason = ANY($3::text[]) AND rm.stripe_payment_intent_id = $2
                        AND NOT EXISTS (SELECT 1 FROM payment_reversals lr JOIN payments lp ON lp.id = lr.payment_id
                                         WHERE lp.stripe_payment_intent_id = rm.stripe_payment_intent_id
                                           AND NOT (lr.id = ANY($1::uuid[])) AND ${liveReversalSql('lr')})
                        -- Fix pass 2 (review): a charge that paid no bill has no
                        -- record to tell which dispute withdrew it: another
                        -- dispute of the charge still holding money keeps it withdrawn.
                        AND NOT EXISTS (SELECT 1 FROM connect_disputes od
                                         WHERE od.stripe_payment_intent_id = rm.stripe_payment_intent_id
                                           AND od.stripe_dispute_id <> $4 AND od.status = ANY($5::text[]))
                   THEN c.amount_remaining ELSE 0 END::text AS withdrawn,
              COALESCE((SELECT SUM(u.amount) FROM credit_uses u JOIN payment_reversals wr
                           ON wr.payment_id = u.payment_id AND wr.created_at = u.released_at
                         WHERE u.prepaid_credit_id = c.id AND u.status = 'reversed' AND wr.id = ANY($1::uuid[])), 0)::text AS undone,
              ARRAY(SELECT DISTINCT u.payment_id::text FROM credit_uses u JOIN payment_reversals wr
                       ON wr.payment_id = u.payment_id AND wr.created_at = u.released_at
                     WHERE u.prepaid_credit_id = c.id AND u.status = 'reversed' AND wr.id = ANY($1::uuid[])) AS undone_rows
         FROM lease_prepaid_credits c
         LEFT JOIN tenant_remittances rm ON rm.id = c.source_remittance_id
        WHERE EXISTS (SELECT 1 FROM credit_uses u WHERE u.prepaid_credit_id = c.id
                        AND ((u.source = 'reversal' AND u.payment_reversal_id = ANY($1::uuid[]))
                             OR (u.status = 'reversed' AND EXISTS (SELECT 1 FROM payment_reversals wr
                                   WHERE wr.payment_id = u.payment_id AND wr.created_at = u.released_at AND wr.id = ANY($1::uuid[])))))
           OR (c.voided_at IS NOT NULL AND c.void_reason = ANY($3::text[]) AND rm.stripe_payment_intent_id = $2)
        ORDER BY c.id FOR UPDATE OF c`,
      [recIds, pi, [WITHDRAWN_BY_CARD_DISPUTE, WITHDRAWN_BY_BANK_RETURN], input.stripeDisputeId, [...DISPUTE_STATUSES_MONEY_TAKEN]])).rows
    /** What a credit still holds twice after the take-back below (netted against the tenant's repayments of its rows). */
    const excessLeft: Array<{ creditId: string; cents: number; rows: Set<string> }> = []
    for (const c of credits) {
      // Every spend this dispute undid was paid again: by the spend on a row
      // paid again (v_payment_money counts it there), or by the tenant's own
      // repayment of its reopened row (given back below, whole).
      const back = toCents(c.drained) + toCents(c.withdrawn) - toCents(c.undone)
      if (back < 0) {
        // Fix pass 2 (review): the dispute undid more of the credit's spends
        // than it took off the credit (a partial dispute undoes a spend whole
        // and takes back only the claim). Those spends put their money back on
        // the credit, and the win makes them pay their rows again — so the
        // credit holds that money twice. It is taken off now, in this
        // transaction, before the whole-bill check could spend it: a take-back
        // against one of this dispute's records (a dispute GAM won, so no
        // dispute count reads it as a claim), never more than the credit holds.
        let excess = -back
        const rows = new Set(c.undone_rows ?? [])
        const name = recs.find(r => rows.has(r.payment_id))?.id ?? recs[0]?.id ?? null
        if (name) excess -= await takeBackCreditAgainstRecord(client, c.credit_id, name, excess)
        if (excess > 0) excessLeft.push({ creditId: c.credit_id, cents: excess, rows })
        continue
      }
      if (back === 0) continue
      const id = await createPaidAhead(client, {
        leaseId: c.lease_id, tenantId: c.tenant_id, amount: toDollars(back),
        fundedBy: c.funded_by as PrepaidFundedBy, receivedAt: new Date(),
        note: `Paid-ahead money given back: ${WON_NOTE} (dispute ${input.stripeDisputeId})`,
      })
      out.creditIds.push(id)
      out.creditRestored = toDollars(toCents(out.creditRestored) + back)
      const hh = await billHouseholdOf(client, c.lease_id)
      if (hh) wholeBill.set(`${hh.tenantId}:${hh.landlordId}`, hh)
    }
    // A reopened row the tenant already paid again: paid twice — the second
    // payment is theirs. What a credit still holds twice (above: it was spent
    // since) comes off the repayment of a row whose spend of it was undone —
    // that repayment and the spend paid the same row.
    for (const p of repaidCredit) {
      for (const e of excessLeft) {
        if (p.cents <= 0) break
        if (e.cents <= 0 || !e.rows.has(p.origId)) continue
        const n = Math.min(e.cents, p.cents)
        e.cents -= n
        p.cents -= n
      }
    }
    for (const e of excessLeft) {
      if (e.cents <= 0) continue
      out.byHand.push(`Paid-ahead credit ${e.creditId}: the dispute undid $${toDollars(e.cents).toFixed(2)} more of its spends than it took back, ` +
        'and the credit was spent since, so it could not be taken off it. The tenant has had that much paid-ahead money twice: bill it back to them or settle it with the landlord by hand.')
    }
    for (const p of repaidCredit) {
      if (!p.leaseId || !p.tenantId || p.cents <= 0) {
        if (p.cents > 0) out.byHand.push(`Reopened charge ${p.rowId} was paid again ($${toDollars(p.cents).toFixed(2)}), and the disputed payment came back too: refund or credit the tenant by hand (no lease to hold it).`)
        continue
      }
      const id = await createPaidAhead(client, {
        leaseId: p.leaseId, tenantId: p.tenantId, amount: toDollars(p.cents), fundedBy: 'gam', receivedAt: new Date(),
        note: `Paid twice: ${WON_NOTE} after this was paid again${p.deposit ? ' from the security deposit at move-out' : ''} (dispute ${input.stripeDisputeId})`,
      })
      out.creditIds.push(id)
      out.creditRestored = toDollars(toCents(out.creditRestored) + p.cents)
      const hh = await billHouseholdOf(client, p.leaseId)
      if (hh) wholeBill.set(`${hh.tenantId}:${hh.landlordId}`, hh)
    }

    // 4. The pass-through dispute fee, when Stripe gave its fee back.
    const feeRows = (await client.query<{ id: string; status: string; amount: string; lease_id: string | null; tenant_id: string | null }>(
      `SELECT id, status, amount::text AS amount, lease_id, tenant_id FROM payments
        WHERE entry_description = 'RETURNFEE' AND notes = ANY($1::text[]) ORDER BY id FOR UPDATE`,
      [Object.values(REVERSAL_FEE_DESCRIPTION).map(d => `${d} — ${input.stripeDisputeId}`)])).rows
    let feeBack = Math.max(0, input.feeReturnedCents)
    for (const f of feeRows) {
      const amt = toCents(f.amount)
      if (feeBack < amt) {
        if (feeBack > 0) out.byHand.push(`Stripe gave back only $${toDollars(feeBack).toFixed(2)} of the $${toDollars(amt).toFixed(2)} dispute fee billed to the tenant (${f.id}). Lower it by hand.`)
        continue
      }
      feeBack -= amt
      if (f.status === 'pending' || f.status === 'failed') {
        const v = await client.query(
          `UPDATE payments SET status = 'voided', voided_at = NOW(), next_retry_at = NULL, void_reason = $2
            WHERE id = $1 AND status IN ('pending', 'failed')
              AND NOT EXISTS (SELECT 1 FROM credit_uses u WHERE u.payment_id = payments.id AND u.status IN ('held', 'applied'))`,
          [f.id, `No longer owed: ${WON_NOTE}, and Stripe gave its dispute fee back`])
        if (v.rowCount) { out.feeRowVoided = true; out.voidedRows.push(f.id) }
      } else if ((f.status === 'settled' || f.status === 'paid_via_deposit') && f.lease_id && f.tenant_id) {
        const id = await createPaidAhead(client, {
          leaseId: f.lease_id, tenantId: f.tenant_id, amount: toDollars(amt), fundedBy: 'gam', receivedAt: new Date(),
          note: `Dispute fee given back: ${WON_NOTE}, and Stripe gave its fee back (dispute ${input.stripeDisputeId})`,
        })
        out.creditIds.push(id)
        out.creditRestored = toDollars(toCents(out.creditRestored) + amt)
      } else {
        out.byHand.push(`The dispute fee ${f.id} ($${toDollars(amt).toFixed(2)}) is ${f.status}; Stripe gave its fee back, so take it off by hand.`)
      }
    }

    // 5. The fee the dispute netted from landlords' payouts, handed back on the line stripeCosts reads.
    if (pi) {
      const { wonDisputeFeeReturnSourceId } = await import('./stripeCosts')
      const kept = (await client.query<{ landlord_id: string; charged: string }>(
        `SELECT h.landlord_id::text AS landlord_id, (-SUM(h.amount))::text AS charged FROM held_payout_items h
          WHERE h.source_type = 'dispute' AND h.landlord_id IS NOT NULL
            AND h.source_id = 'stripe_fee_kept:' || $1 || ':' || h.landlord_id::text
          GROUP BY h.landlord_id ORDER BY 1`, [pi])).rows
      for (const k of kept) {
        const c = toCents(k.charged)
        if (c <= 0) continue
        const wrote = await recordHeldItem({
          landlordId: k.landlord_id, sourceType: 'dispute', sourceId: wonDisputeFeeReturnSourceId(pi, k.landlord_id),
          amount: toDollars(c),
          description: 'The card fee taken off your payout for a disputed payment, given back: the card company decided the dispute for us',
        }, client)
        if (wrote) out.feeLinesGivenBack = toDollars(toCents(out.feeLinesGivenBack) + c)
      }
      // The paid-ahead money screen's own lines for this charge (choice46c) are not undone here.
      const choice = await client.query(
        `SELECT 1 FROM held_payout_items WHERE source_type = 'dispute' AND source_id LIKE $1 LIMIT 1`,
        [`owner\\_share\\_returned:paid-ahead-choice:${pi.replace(/[\\%_]/g, m => '\\' + m)}:%`])
      if (choice.rowCount) {
        out.byHand.push(`The dispute had also charged the landlord back for paid-ahead money the paid-ahead money screen paid out (lines owner_share_returned:paid-ahead-choice:${pi}:…). The money came back: give those lines back by hand.`)
      }
    }

    // 6. The bills: late fees back-filled because of the reopen are voided when
    //    nothing else on the bill is owed, and the bill reads paid again.
    for (const invoiceId of [...invoices].sort()) {
      const open = (await client.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM payments
          WHERE invoice_id = $1 AND type <> 'late_fee' AND status IN ('pending', 'failed', 'processing')`, [invoiceId])).rows[0]?.n ?? 0
      if (open === 0) {
        // Fix pass 2 (review): only the late fees the reopen earned. A bill's
        // late fees are counted on the bill (one per day it is late), never per
        // line, so a fee written after the dispute is the reopen's only when,
        // on its day, nothing else on the bill was owed: every other line was
        // already paid by then (or did not exist yet). A fee for a day another
        // line was still unpaid (paid later, after that day) is the landlord's
        // and stays owed. This dispute's own rows (paid again by the win) and
        // the rows it reopened (voided above) are not "another line".
        const fees = await client.query<{ id: string }>(
          `UPDATE payments SET status = 'voided', voided_at = NOW(), next_retry_at = NULL, void_reason = $3
            WHERE id IN (SELECT q.id FROM payments q
                          LEFT JOIN units qu ON qu.id = q.unit_id LEFT JOIN properties qp ON qp.id = qu.property_id
                          WHERE q.invoice_id = $1 AND q.type = 'late_fee' AND q.status IN ('pending', 'failed')
                            AND q.created_at >= $2::timestamptz
                            AND NOT EXISTS (SELECT 1 FROM credit_uses u WHERE u.payment_id = q.id AND u.status IN ('held', 'applied'))
                            AND NOT EXISTS (
                              SELECT 1 FROM payments o
                               WHERE o.invoice_id = q.invoice_id AND o.type <> 'late_fee'
                                 AND o.status IN ('settled', 'paid_via_deposit')
                                 AND NOT (o.id = ANY($4::uuid[]))
                                 AND NOT (o.reversal_id IS NOT NULL AND o.reversal_id = ANY($5::uuid[]))
                                 AND (o.created_at AT TIME ZONE COALESCE(qp.timezone, 'America/Phoenix'))::date <= q.due_date
                                 -- A line paid with no day on file (an old import) was paid before.
                                 AND o.settled_at IS NOT NULL
                                 AND (o.settled_at AT TIME ZONE COALESCE(qp.timezone, 'America/Phoenix'))::date > q.due_date)
                          ORDER BY q.id FOR UPDATE OF q)
            RETURNING id`,
          [invoiceId, earliest, `No longer owed: ${WON_NOTE}`, [...new Set(recs.map(r => r.payment_id))], recIds])
        out.lateFeesVoided.push(...fees.rows.map(x => x.id))
      }
      const s = (await client.query<{ open: number; paid: number }>(
        `SELECT COUNT(*) FILTER (WHERE status IN ('pending', 'failed', 'processing'))::int AS open,
                COUNT(*) FILTER (WHERE status IN ('settled', 'paid_via_deposit'))::int AS paid
           FROM payments WHERE invoice_id = $1`, [invoiceId])).rows[0]
      await client.query(
        `UPDATE invoices SET status = $2, updated_at = NOW() WHERE id = $1 AND status <> 'void'`,
        [invoiceId, (s?.open ?? 0) === 0 ? ((s?.paid ?? 0) > 0 ? 'settled' : 'pending') : ((s?.paid ?? 0) > 0 ? 'partial' : 'pending')])
    }

    // Fix pass 2 (review, decisions #46.1): paid-ahead money given back on a
    // lease that has ENDED (a reopened charge paid again — by the tenant, or
    // from the security deposit at move-out — while the disputed payment came
    // back too) is not GAM's to decide: it is listed for the landlord's
    // paid-ahead money choice (refund it, keep it, or leave it as their
    // credit) on their to-do, like any money paid ahead left on an ended lease.
    if (out.creditIds.length > 0) {
      const { endedLeaseSql } = await import('./paidAheadChoice')
      out.waitsForChoice = (await client.query<{ lease_id: string }>(
        `SELECT DISTINCT c.lease_id::text AS lease_id FROM lease_prepaid_credits c
           JOIN leases l ON l.id = c.lease_id JOIN units u ON u.id = l.unit_id JOIN properties pr ON pr.id = u.property_id
          WHERE c.id = ANY($1::uuid[]) AND ${endedLeaseSql('l', 'pr')}
          ORDER BY 1`, [out.creditIds])).rows.map(r => r.lease_id)
    }

    // Done: the mark (in this transaction), with what was undone.
    await client.query(
      `INSERT INTO admin_notifications (severity, category, title, body, context) VALUES ('info', $1, $2, $3, $4)`,
      [DISPUTE_WON_UNDONE_CATEGORY,
       `A dispute was won: what it reopened was undone (${pi ?? input.stripeDisputeId})`,
       `Stripe gave back the disputed money (dispute ${input.stripeDisputeId}). ` +
         `${out.voidedRows.length} reopened charge(s) voided, ${out.restoredRows.length} bill line(s) paid again, ` +
         `$${Object.values(out.landlordGivenBack).reduce((s, v) => s + v, 0).toFixed(2)} given back to landlords, ` +
         `$${out.creditRestored.toFixed(2)} of paid-ahead money given back to the tenant.` +
         (out.waitsForChoice.length > 0
           ? ` ${out.waitsForChoice.length} lease(s) it went to had ended: the landlord decides that money (refund, keep, or leave it as their credit) from their to-do list.`
           : '') +
         (out.byHand.length > 0 ? ` ${out.byHand.length} thing(s) to settle by hand — see the alert.` : ''),
       JSON.stringify({ stripe_dispute_id: input.stripeDisputeId, stripe_event_id: input.stripeEventId, stripe_payment_intent_id: pi,
                        voided: out.voidedRows, restored: out.restoredRows, landlord_given_back: out.landlordGivenBack,
                        credit_restored: out.creditRestored, credit_ids: out.creditIds, late_fees_voided: out.lateFeesVoided,
                        fee_lines_given_back: out.feeLinesGivenBack, waits_for_choice: out.waitsForChoice, by_hand: out.byHand })])
    await client.query('COMMIT')
    out.handled = true
  } catch (e) {
    try { await client.query('ROLLBACK') } catch { /* already rolled back */ }
    throw e
  } finally {
    client.release()
  }

  // ── After the commit ───────────────────────────────────────────────────────
  if (cancelAfter.length > 0) await cancelSupersededIntents(cancelAfter)
  if (out.byHand.length > 0) {
    await createAdminNotification({
      severity: 'critical', category: 'dispute_won_by_hand',
      title: `A won dispute left ${out.byHand.length} thing(s) to settle by hand (${pi ?? input.stripeDisputeId})`,
      body: out.byHand.join('\n') + '\nGAM does not absorb any of it.',
      context: { stripe_dispute_id: input.stripeDisputeId, stripe_payment_intent_id: pi, by_hand: out.byHand },
    }).catch(() => {})
  }
  // Paid-ahead money was created: a bill it now covers whole is paid from it (§3).
  for (const hh of wholeBill.values()) {
    await runWholeBillCheckAfterCommit(hh).catch((e: unknown) =>
      logger.error({ err: e, stripe_dispute_id: input.stripeDisputeId }, '[payment_reversal] whole-bill check after a won dispute failed'))
  }
  return out
}

/** The held line that gives a landlord back what a won dispute's record took from them. */
const wonShareSource = (reversalId: string) => `owner_share_returned_on_win:${reversalId}`

// ─── A dispute GAM won: undone BY HAND for this deploy (decisions #55-AMENDED) ─
//
// Decisions #55-AMENDED (10/4 ~midnight): "for this deploy, a won dispute is
// NOT undone automatically. The webhook raises ONE critical admin notice per
// won dispute, listing exactly what to undo by hand (the reopened rows to void,
// the landlord share to give back, credit to restore, fees), with amounts.
// Undoing it automatically is a follow-up, built with the report readers."
//
// So the webhook never calls undoWonDispute (above — kept for that follow-up)
// nor heldPayouts.recordChargeback's 'won' branch. It calls
// raiseWonDisputeNotice, which only READS: the list below is what
// undoWonDispute would do, worded for a person, with every amount and the
// line each step touches. Nothing is written but the one notice.

/** The one critical notice a won dispute raises (once per Stripe dispute id). */
export const DISPUTE_WON_UNDO_BY_HAND_CATEGORY = 'dispute_won_undo_by_hand'

export interface WonDisputeNoticeInput {
  /** Stripe's dispute id. */
  stripeDisputeId: string
  /** The webhook event that said the dispute was won. */
  stripeEventId: string
  /** connect_disputes.id, when on file. */
  connectDisputeId?: string | null
  /** The disputed charge (dispute.payment_intent). */
  paymentIntentId?: string | null
  /** The disputed amount Stripe put back, in cents (dispute.amount). */
  disputedCents: number
  /** Stripe's dispute fee on the dispute, in cents (the positive fees of its balance transactions). */
  feeCents: number
  /** Cents of that fee Stripe gave back with the win (stripeCosts.disputeFeeReturnedOnWinCents). */
  feeReturnedCents: number
}

export interface WonDisputeHandList {
  /** Each step in plain words, with its amount and the line it touches. Empty: nothing to undo. */
  steps: string[]
  /** Reopened charges the tenant no longer owes: void them. */
  rowsToVoid: Array<{ id: string; amount: number }>
  /** Disputed bill lines to mark paid again. */
  rowsToMarkPaid: string[]
  /** Dollars to give back to each landlord or business (withheld, netted, the kept card fee, a chargeback). */
  giveBack: Record<string, number>
  /** Dollars of recovery still to be asked of each landlord: call it off. */
  recoveryToCallOff: Record<string, number>
  /** Dollars of paid-ahead money to restore to the tenant (net of spends marked paid again). */
  creditToRestore: number
  /** Dollars of pass-through dispute fee to take off the tenant (void, or save as paid-ahead if paid). */
  feeToTakeOff: number
  /** Dollars of Stripe's dispute fee Stripe kept that nothing billed to anyone. */
  feeKeptUnbilled: number
}

const PAYMENT_KIND_WORDS: Record<string, string> = {
  rent: 'rent', fee: 'fee', deposit: 'security deposit', utility: 'utility', float_fee: 'FlexPay fee',
  late_fee: 'late fee', platform_fee: 'GAM fee', home_payment: 'home payment',
}
const kindWords = (type: string, entry: string | null): string =>
  entry === 'RETURNFEE' ? 'dispute or return fee' : entry === 'FLEXPAY' ? 'FlexPay payment' : (PAYMENT_KIND_WORDS[type] ?? type)
const usd = (cents: number): string => `$${toDollars(cents).toFixed(2)}`
const addTo = (m: Record<string, number>, who: string, cents: number) => {
  m[who] = toDollars(toCents(m[who] ?? 0) + cents)
}

/**
 * What undoing a won dispute takes, read only (one client, no writes). Mirrors
 * undoWonDispute step by step so the follow-up and the notice agree.
 */
export async function wonDisputeHandList(client: PoolClient, input: WonDisputeNoticeInput): Promise<WonDisputeHandList> {
  const out: WonDisputeHandList = {
    steps: [], rowsToVoid: [], rowsToMarkPaid: [], giveBack: {}, recoveryToCallOff: {},
    creditToRestore: 0, feeToTakeOff: 0, feeKeptUnbilled: 0,
  }
  const { WITHDRAWN_BY_CARD_DISPUTE, WITHDRAWN_BY_BANK_RETURN, DISPUTE_STATUSES_MONEY_TAKEN, liveReversalSql } = await import('./creditUse')
  const cd = (await client.query<{ id: string; pi: string | null }>(
    `SELECT id, stripe_payment_intent_id AS pi FROM connect_disputes WHERE stripe_dispute_id = $1`, [input.stripeDisputeId])).rows[0]
  const connectId = input.connectDisputeId ?? cd?.id ?? null
  const pi = input.paymentIntentId ?? cd?.pi ?? null

  const recs = (await client.query<{
    id: string; payment_id: string; landlord_id: string | null; reversed_amount: string; recovered_amount: string
    recovery_status: string; created_at: Date; p_type: string; p_status: string; p_entry: string | null
    p_owner: string; p_invoice: string | null; p_released: string | null; landlord_name: string | null
  }>(
    `SELECT pr.id, pr.payment_id, pr.landlord_id::text AS landlord_id, pr.reversed_amount::text AS reversed_amount,
            pr.recovered_amount::text AS recovered_amount, pr.recovery_status, pr.created_at,
            p.type AS p_type, p.status AS p_status, p.entry_description AS p_entry, p.revenue_owner AS p_owner,
            p.invoice_id AS p_invoice, p.released_by_deposit_return_id::text AS p_released,
            COALESCE(NULLIF(TRIM(l.business_name), ''), NULLIF(TRIM(u.first_name || ' ' || u.last_name), '')) AS landlord_name
       FROM payment_reversals pr
       JOIN payments p ON p.id = pr.payment_id
       LEFT JOIN landlords l ON l.id = pr.landlord_id
       LEFT JOIN users u ON u.id = l.user_id
      WHERE pr.stripe_object_id = $1 OR ($2::uuid IS NOT NULL AND pr.connect_dispute_id = $2::uuid)
      ORDER BY pr.created_at, pr.id`, [input.stripeDisputeId, connectId])).rows
  const recIds = recs.map(r => r.id)
  const reopened = recIds.length === 0 ? [] : (await client.query<{
    id: string; reversal_id: string; status: string; amount: string; type: string; entry: string | null
    pi: string | null; invoice_id: string | null; retry: boolean
  }>(
    `SELECT id, reversal_id::text AS reversal_id, status, amount::text AS amount, type, entry_description AS entry,
            stripe_payment_intent_id AS pi, invoice_id, (next_retry_at IS NOT NULL) AS retry
       FROM payments WHERE reversal_id = ANY($1::uuid[]) ORDER BY id`, [recIds])).rows
  // Who paid: the disputed rows' tenant, else the receipt's (a charge that paid no bill).
  const tenant = (await client.query<{ name: string | null }>(
    `SELECT NULLIF(TRIM(u.first_name || ' ' || u.last_name), '') AS name
       FROM (SELECT p.tenant_id, 0 AS o FROM payments p
              WHERE p.tenant_id IS NOT NULL AND (p.id = ANY($1::uuid[]) OR ($2::text IS NOT NULL AND p.stripe_payment_intent_id = $2))
             UNION ALL
             SELECT r.tenant_id, 1 FROM tenant_remittances r WHERE $2::text IS NOT NULL AND r.stripe_payment_intent_id = $2) x
       JOIN tenants t ON t.id = x.tenant_id JOIN users u ON u.id = t.user_id
      ORDER BY x.o LIMIT 1`, [recs.map(r => r.payment_id), pi])).rows[0]?.name ?? 'the tenant'
  const who = (r: { landlord_name: string | null; landlord_id: string | null }) => r.landlord_name ?? `landlord ${r.landlord_id}`

  // 1. Record by record: the reopened charges, the disputed line, the landlord's share.
  const invoices = new Set<string>()
  for (const r of recs) {
    const lost = toCents(r.reversed_amount)
    const rows = reopened.filter(n => n.reversal_id === r.id)
    const what = kindWords(r.p_type, r.p_entry)
    if (r.p_invoice) invoices.add(r.p_invoice)
    let repaid = false
    let inFlight = false
    for (const n of rows) {
      if (n.invoice_id) invoices.add(n.invoice_id)
      const amt = toCents(n.amount)
      if (n.status === 'voided') continue
      if ((n.status === 'pending' && !n.pi) || n.status === 'failed') {
        out.rowsToVoid.push({ id: n.id, amount: toDollars(amt) })
        out.steps.push(`Void the reopened ${kindWords(n.type, n.entry)} charge of ${usd(amt)} (line ${n.id}): ${tenant} no longer owes it.` +
          (n.retry ? ' Call off its scheduled bank retry first.' : ''))
      } else if (n.status === 'settled' || n.status === 'paid_via_deposit') {
        repaid = true
        out.creditToRestore = toDollars(toCents(out.creditToRestore) + amt)
        out.steps.push(`${tenant} already paid the reopened ${kindWords(n.type, n.entry)} charge again (${usd(amt)}, line ${n.id}` +
          `${n.status === 'paid_via_deposit' ? ', from the security deposit' : ''}), and the card company gave the first payment back too: ` +
          `save ${usd(amt)} as their paid-ahead money. Leave the line and the landlord as that payment left them.`)
      } else {
        inFlight = true
        out.steps.push(`The reopened ${kindWords(n.type, n.entry)} charge of ${usd(amt)} (line ${n.id}) is being paid right now. ` +
          `If that payment clears, ${tenant} has paid it twice: save it as their paid-ahead money. If it fails, void the charge and give the landlord back what record ${r.id} took from them.`)
      }
    }
    if (repaid || inFlight || lost <= 0) continue
    if (r.p_entry === 'FLEXPAY') {
      out.steps.push(`FlexPay payment ${r.payment_id} (${usd(lost)}) was written off when it was disputed. The money came back: mark the FlexPay advance collected.`)
      continue
    }
    if (r.p_status === 'returned') {
      out.rowsToMarkPaid.push(r.payment_id)
      out.steps.push(`Mark the disputed ${what} line paid again (line ${r.payment_id}, ${usd(lost)} of it was taken back).`)
    }
    if (lost > 0 && (r.p_owner === 'landlord' || r.p_released) && r.landlord_id) {
      const askedAgain = rows.reduce((s, n) => s + toCents(n.amount), 0)
      const routed = r.p_type === 'deposit' ? 0 : Math.max(0, lost - askedAgain)
      if (routed > 0) {
        out.steps.push(`${usd(routed)} of line ${r.payment_id} had paid ${tenant}'s GAM balances first. The dispute opened those balances again; mark them paid again.`)
      }
      const paidBack = toCents((await client.query<{ s: string }>(
        `SELECT COALESCE(SUM(amount), 0)::text AS s FROM held_payout_items WHERE source_type = 'dispute' AND source_id = $1`,
        [returnedShareSource(r.id)])).rows[0]?.s)
      const give = Math.max(0, toCents(r.recovered_amount) - routed - paidBack)
      if (give > 0) {
        addTo(out.giveBack, who(r), give)
        out.steps.push(`Give ${who(r)} back ${usd(give)} that was withheld from or netted out of their payout for the disputed ${what} ` +
          `(record ${r.id}; a positive payout line with source id ${wonShareSource(r.id)}).`)
      }
      const stillAsked = toCents(r.reversed_amount) - toCents(r.recovered_amount)
      if (['pending', 'scheduled_netting'].includes(r.recovery_status) && stillAsked > 0) {
        addTo(out.recoveryToCallOff, who(r), stillAsked)
        out.steps.push(`Call off the ${usd(stillAsked)} still to be asked of ${who(r)} for it (record ${r.id}: recovery not needed, resolved).`)
      }
    }
    if (r.p_type === 'deposit') {
      const { DEPOSIT_PART_TAKEN_BACK } = await import('./depositRefundSend')
      const stopped = toCents((await client.query<{ s: string }>(
        `SELECT COALESCE(SUM(toward_amount), 0)::text AS s FROM stay_refund_parts WHERE deposit_payment_id = $1 AND failure = $2`,
        [r.payment_id, DEPOSIT_PART_TAKEN_BACK])).rows[0]?.s)
      if (stopped > 0) {
        out.steps.push(`The move-out refund of ${usd(stopped)} from deposit payment ${r.payment_id} was stopped when it was disputed. The money came back: send that refund to ${tenant}.`)
      }
    }
  }

  // 2. Paid-ahead money the dispute took (its take-backs, a credit it withdrew whole), less spends it undid.
  const credits = (await client.query<{ credit_id: string; drained: string; withdrawn: string; undone: string; undone_rows: string[] | null }>(
    `SELECT c.id AS credit_id,
            COALESCE((SELECT SUM(u.amount) FROM credit_uses u
                       WHERE u.prepaid_credit_id = c.id AND u.source = 'reversal' AND u.status = 'applied'
                         AND u.payment_reversal_id = ANY($1::uuid[])), 0)::text AS drained,
            CASE WHEN c.voided_at IS NOT NULL AND c.void_reason = ANY($3::text[]) AND rm.stripe_payment_intent_id = $2
                      AND NOT EXISTS (SELECT 1 FROM payment_reversals lr JOIN payments lp ON lp.id = lr.payment_id
                                       WHERE lp.stripe_payment_intent_id = rm.stripe_payment_intent_id
                                         AND NOT (lr.id = ANY($1::uuid[])) AND ${liveReversalSql('lr')})
                      AND NOT EXISTS (SELECT 1 FROM connect_disputes od
                                       WHERE od.stripe_payment_intent_id = rm.stripe_payment_intent_id
                                         AND od.stripe_dispute_id <> $4 AND od.status = ANY($5::text[]))
                 THEN c.amount_remaining ELSE 0 END::text AS withdrawn,
            COALESCE((SELECT SUM(u.amount) FROM credit_uses u JOIN payment_reversals wr
                         ON wr.payment_id = u.payment_id AND wr.created_at = u.released_at
                       WHERE u.prepaid_credit_id = c.id AND u.status = 'reversed' AND wr.id = ANY($1::uuid[])), 0)::text AS undone,
            ARRAY(SELECT DISTINCT u.payment_id::text FROM credit_uses u JOIN payment_reversals wr
                     ON wr.payment_id = u.payment_id AND wr.created_at = u.released_at
                   WHERE u.prepaid_credit_id = c.id AND u.status = 'reversed' AND wr.id = ANY($1::uuid[])) AS undone_rows
       FROM lease_prepaid_credits c
       LEFT JOIN tenant_remittances rm ON rm.id = c.source_remittance_id
      WHERE EXISTS (SELECT 1 FROM credit_uses u WHERE u.prepaid_credit_id = c.id
                      AND ((u.source = 'reversal' AND u.payment_reversal_id = ANY($1::uuid[]))
                           OR (u.status = 'reversed' AND EXISTS (SELECT 1 FROM payment_reversals wr
                                 WHERE wr.payment_id = u.payment_id AND wr.created_at = u.released_at AND wr.id = ANY($1::uuid[])))))
         OR ($2::text IS NOT NULL AND c.voided_at IS NOT NULL AND c.void_reason = ANY($3::text[]) AND rm.stripe_payment_intent_id = $2)
      ORDER BY c.id`,
    [recIds, pi, [WITHDRAWN_BY_CARD_DISPUTE, WITHDRAWN_BY_BANK_RETURN], input.stripeDisputeId, [...DISPUTE_STATUSES_MONEY_TAKEN]])).rows
  for (const c of credits) {
    const took = toCents(c.drained) + toCents(c.withdrawn)
    const undone = toCents(c.undone)
    const back = took - undone
    const rowsWords = (c.undone_rows ?? []).length > 0 ? ` (lines ${(c.undone_rows ?? []).join(', ')})` : ''
    if (undone > 0) {
      out.steps.push(`The dispute undid ${usd(undone)} of spends of paid-ahead credit ${c.credit_id}${rowsWords}: ` +
        'mark those lines paid by that credit again (the spend pays them once more), and do not also give that money back.')
    }
    if (back > 0) {
      out.creditToRestore = toDollars(toCents(out.creditToRestore) + back)
      out.steps.push(`Restore ${usd(back)} of paid-ahead money to ${tenant} that the dispute took off credit ${c.credit_id}` +
        `${toCents(c.withdrawn) > 0 ? ' (the dispute withdrew it)' : ''}: new GAM-held paid-ahead money.`)
    } else if (back < 0) {
      out.steps.push(`The dispute undid ${usd(-back)} more of credit ${c.credit_id}'s spends than it took off it, so once those lines are paid by it again ` +
        `the credit holds ${usd(-back)} twice: take ${usd(-back)} off credit ${c.credit_id}.`)
    }
  }

  // 3. Fees: the pass-through dispute fee billed to the tenant, the card fee netted from landlords, a held charge's chargeback.
  const feeRows = (await client.query<{ id: string; status: string; amount: string }>(
    `SELECT id, status, amount::text AS amount FROM payments
      WHERE entry_description = 'RETURNFEE' AND notes = ANY($1::text[]) ORDER BY id`,
    [Object.values(REVERSAL_FEE_DESCRIPTION).map(d => `${d} — ${input.stripeDisputeId}`)])).rows
  let feeBack = Math.max(0, input.feeReturnedCents)
  // The won event did not say Stripe's fee (no balance transactions on it): whether it came back is unknown.
  const feeUnknown = input.feeCents <= 0 && input.feeReturnedCents <= 0
  for (const f of feeRows) {
    const amt = toCents(f.amount)
    if (feeUnknown) {
      out.steps.push(`Check in Stripe whether it gave its dispute fee back with the win. If it did, take the ${usd(amt)} dispute fee billed to ${tenant} (line ${f.id}) off; if not, it stays.`)
      continue
    }
    if (feeBack <= 0) {
      out.steps.push(`Stripe kept its dispute fee, so the ${usd(amt)} dispute fee billed to ${tenant} (line ${f.id}) stays.`)
      continue
    }
    const off = Math.min(feeBack, amt)
    feeBack -= off
    out.feeToTakeOff = toDollars(toCents(out.feeToTakeOff) + off)
    const whole = off === amt
    if (f.status === 'pending' || f.status === 'failed') {
      out.steps.push(whole
        ? `Void the ${usd(amt)} dispute fee billed to ${tenant} (line ${f.id}): Stripe gave its fee back.`
        : `Lower the ${usd(amt)} dispute fee billed to ${tenant} (line ${f.id}) by ${usd(off)}: Stripe gave back only that much of its fee.`)
    } else if (f.status === 'settled' || f.status === 'paid_via_deposit') {
      out.steps.push(`${tenant} already paid the ${usd(amt)} dispute fee (line ${f.id}) and Stripe gave back ${usd(off)} of it: save ${usd(off)} as their paid-ahead money.`)
    } else {
      out.steps.push(`The ${usd(amt)} dispute fee billed to ${tenant} (line ${f.id}) is ${f.status}; Stripe gave back ${usd(off)} of it: take that off once it settles or fails.`)
    }
  }
  if (pi) {
    const kept = (await client.query<{ landlord_id: string; name: string | null; charged: string }>(
      `SELECT h.landlord_id::text AS landlord_id,
              MAX(COALESCE(NULLIF(TRIM(l.business_name), ''), NULLIF(TRIM(u.first_name || ' ' || u.last_name), ''))) AS name,
              (-SUM(h.amount))::text AS charged
         FROM held_payout_items h
         LEFT JOIN landlords l ON l.id = h.landlord_id LEFT JOIN users u ON u.id = l.user_id
        WHERE h.source_type = 'dispute' AND h.landlord_id IS NOT NULL
          AND h.source_id = 'stripe_fee_kept:' || $1 || ':' || h.landlord_id::text
        GROUP BY h.landlord_id ORDER BY 1`, [pi])).rows
    const { wonDisputeFeeReturnSourceId } = await import('./stripeCosts')
    for (const k of kept) {
      const c = toCents(k.charged)
      if (c <= 0) continue
      const name = k.name ?? `landlord ${k.landlord_id}`
      addTo(out.giveBack, name, c)
      out.steps.push(`Give ${name} back the ${usd(c)} card or bank fee taken off their payout for the disputed payment ` +
        `(a positive payout line with source id ${wonDisputeFeeReturnSourceId(pi, k.landlord_id)}).`)
    }
    const choice = await client.query(
      `SELECT 1 FROM held_payout_items WHERE source_type = 'dispute' AND source_id LIKE $1 LIMIT 1`,
      [`owner\\_share\\_returned:paid-ahead-choice:${pi.replace(/[\\%_]/g, m => '\\' + m)}:%`])
    if (choice.rowCount) {
      out.steps.push(`The dispute also charged the landlord back for paid-ahead money the paid-ahead money screen paid out (lines owner_share_returned:paid-ahead-choice:${pi}:…). Give those lines back.`)
    }
  }
  // A held charge (register sale, stay deposit, business invoice): its chargeback line.
  const chargeback = (await client.query<{ taken: string; name: string | null }>(
    `SELECT (-h.amount)::text AS taken,
            COALESCE(NULLIF(TRIM(l.business_name), ''), NULLIF(TRIM(u.first_name || ' ' || u.last_name), ''), b.name) AS name
       FROM held_payout_items h
       LEFT JOIN landlords l ON l.id = h.landlord_id LEFT JOIN users u ON u.id = l.user_id
       LEFT JOIN businesses b ON b.id = h.business_id
      WHERE h.source_type = 'dispute' AND h.source_id = $1 AND h.amount < 0`, [input.stripeDisputeId])).rows[0]
  if (chargeback) {
    const taken = toCents(chargeback.taken)
    const back = Math.min(taken, Math.max(0, input.disputedCents) + Math.max(0, input.feeReturnedCents))
    const keptByStripe = Math.max(0, input.feeCents - input.feeReturnedCents)
    if (back > 0) {
      const { wonChargebackReturnSourceId } = await import('./stripeCosts')
      const name = chargeback.name ?? 'the payee'
      addTo(out.giveBack, name, back)
      out.steps.push(`Give ${name} back ${usd(back)} of the ${usd(taken)} chargeback taken off their payout ` +
        `(${usd(Math.max(0, input.disputedCents))} of the sale${input.feeReturnedCents > 0 ? ` and the ${usd(input.feeReturnedCents)} dispute fee Stripe returned` : ''}; ` +
        `a positive payout line with source id ${wonChargebackReturnSourceId(input.stripeDisputeId)}).` +
        (keptByStripe > 0 ? ` Stripe kept ${usd(keptByStripe)} of its dispute fee: that part stays with them.` : '') +
        (feeUnknown && taken > back ? ` Check in Stripe whether it gave its dispute fee back with the win; if it did, give that back to them too (up to ${usd(taken - back)} more).` : ''))
    }
  }
  // Stripe kept its fee and nothing billed it to anyone: never GAM's in silence.
  const keptCents = Math.max(0, input.feeCents - input.feeReturnedCents)
  if (keptCents > 0 && feeRows.length === 0 && !chargeback) {
    out.feeKeptUnbilled = toDollars(keptCents)
    out.steps.push(`Stripe kept ${usd(keptCents)} of its dispute fee, and nothing billed it to anyone for this dispute. ` +
      'Decide who bears it (the tenant who disputed, or the landlord the payment went to) and bill it — GAM does not absorb it.')
  }

  // 4. Late fees written on the reopened bills since the dispute.
  if (invoices.size > 0 && recs.length > 0) {
    const earliest = recs[0].created_at
    const fees = (await client.query<{ id: string; amount: string; due: string }>(
      `SELECT id, amount::text AS amount, due_date::text AS due FROM payments
        WHERE invoice_id = ANY($1::uuid[]) AND type = 'late_fee' AND status IN ('pending', 'failed', 'settled', 'paid_via_deposit')
          AND created_at >= $2::timestamptz
        ORDER BY due_date, id`, [[...invoices], earliest])).rows
    for (const f of fees) {
      out.steps.push(`Check the ${usd(toCents(f.amount))} late fee for ${f.due} (line ${f.id}): if only the reopened charge was owed that day, ` +
        `it was charged because of the dispute — void it (or save it as ${tenant}'s paid-ahead money if they paid it).`)
    }
  }
  return out
}

/**
 * Decisions #55-AMENDED: a won dispute raises ONE critical admin notice listing
 * exactly what to undo by hand, with amounts — once per Stripe dispute id,
 * whatever events say 'won' (closed, funds_reinstated, a redelivery). Nothing
 * else is written. The reads and the once-check run on one client under a lock
 * on the dispute; the notice itself is written by createAdminNotification (so
 * it reaches the super admins' email like every critical notice) while that
 * lock is held, so a second won event waits and then finds it.
 */
export async function raiseWonDisputeNotice(input: WonDisputeNoticeInput): Promise<{ raised: boolean; list: WonDisputeHandList | null }> {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`dispute_won_notice:${input.stripeDisputeId}`])
    // Review (rev10): wait for a chargeback or reversal of this dispute that
    // is already running (a stale event delivered beside the win), so the
    // hand list below reads what it moved. Same keys those paths take; the
    // chargeback and reversal paths never wait on this notice, so no cycle.
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`chargeback:${input.stripeDisputeId}`])
    const reversalKey = input.paymentIntentId ?? (await client.query<{ pi: string | null }>(
      `SELECT stripe_payment_intent_id AS pi FROM connect_disputes WHERE stripe_dispute_id = $1`,
      [input.stripeDisputeId])).rows[0]?.pi ?? null
    if (reversalKey) {
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`payment_reversal:${reversalKey}`])
    }
    const seen = await client.query(
      `SELECT 1 FROM admin_notifications WHERE category = $1 AND context->>'stripe_dispute_id' = $2
       UNION ALL
       SELECT 1 FROM admin_notifications_archive WHERE category = $1 AND context->>'stripe_dispute_id' = $2
       LIMIT 1`, [DISPUTE_WON_UNDO_BY_HAND_CATEGORY, input.stripeDisputeId])
    if (seen.rowCount) {
      await client.query('COMMIT')
      return { raised: false, list: null }
    }
    const list = await wonDisputeHandList(client, input)
    const pi = input.paymentIntentId ?? null
    const head = `Stripe decided dispute ${input.stripeDisputeId} for GAM and put back ${usd(Math.max(0, input.disputedCents))}` +
      `${pi ? ` on payment ${pi}` : ''}` +
      `${input.feeCents > 0 ? `, with ${usd(input.feeReturnedCents)} of its ${usd(input.feeCents)} dispute fee` : ''}. ` +
      'GAM does not undo a won dispute by itself yet: nothing was changed.'
    const body = list.steps.length === 0
      ? `${head} No bill was reopened and nothing was taken from anyone for it, so there is nothing to undo.`
      : `${head} Undo these by hand:\n${list.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}\nGAM absorbs none of it.`
    await createAdminNotification({
      severity: 'critical',
      category: DISPUTE_WON_UNDO_BY_HAND_CATEGORY,
      title: list.steps.length === 0
        ? `A dispute was won: nothing to undo (${pi ?? input.stripeDisputeId})`
        : `A dispute was won: undo ${list.steps.length} thing${list.steps.length === 1 ? '' : 's'} by hand (${pi ?? input.stripeDisputeId})`,
      body,
      context: {
        stripe_dispute_id: input.stripeDisputeId, stripe_event_id: input.stripeEventId, stripe_payment_intent_id: pi,
        disputed: toDollars(Math.max(0, input.disputedCents)), dispute_fee: toDollars(input.feeCents),
        dispute_fee_returned: toDollars(input.feeReturnedCents),
        rows_to_void: list.rowsToVoid, rows_to_mark_paid: list.rowsToMarkPaid, give_back: list.giveBack,
        recovery_to_call_off: list.recoveryToCallOff, credit_to_restore: list.creditToRestore,
        fee_to_take_off: list.feeToTakeOff, fee_kept_unbilled: list.feeKeptUnbilled, steps: list.steps,
      },
    })
    await client.query('COMMIT')
    return { raised: true, list }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

/**
 * Fix pass 1 (rev10, review): the dispute fee GAM passed on for a dispute is
 * Stripe's actual fee when the event that took the money carried it, else the
 * $15 fallback. A later event of the same dispute (funds_withdrawn) that
 * carries Stripe's actual fee is otherwise ignored (the take-back runs once):
 * when that fee differs from what was billed to the tenant or netted from the
 * payee, an admin is told once per dispute to correct it — never a silent
 * difference GAM carries. Never throws.
 */
export async function alertDisputeFeeDiffers(input: {
  stripeDisputeId: string; paymentIntentId: string | null; disputedCents: number; actualFeeCents: number; stripeEventId: string
}): Promise<boolean> {
  if (input.actualFeeCents <= 0) return false
  try {
    const billed = await queryOne<{ tenant_fee: string; payee_fee: string | null }>(
      `SELECT COALESCE((SELECT SUM(reversal_fee) FROM payment_reversals WHERE stripe_object_id = $1), 0)::text AS tenant_fee,
              (SELECT (-amount - $2::numeric)::text FROM held_payout_items
                WHERE source_type = 'dispute' AND source_id = $1 AND amount < 0 LIMIT 1) AS payee_fee`,
      [input.stripeDisputeId, toDollars(Math.max(0, input.disputedCents))])
    const tenantFee = toCents(billed?.tenant_fee)
    const payeeFee = billed?.payee_fee != null ? toCents(billed.payee_fee) : null
    const recorded = tenantFee > 0 ? tenantFee : payeeFee
    if (recorded == null || recorded <= 0 || recorded === input.actualFeeCents) return false
    const seen = await queryOne(
      `SELECT 1 FROM admin_notifications WHERE category = 'dispute_fee_differs' AND context->>'stripe_dispute_id' = $1
       UNION ALL
       SELECT 1 FROM admin_notifications_archive WHERE category = 'dispute_fee_differs' AND context->>'stripe_dispute_id' = $1
       LIMIT 1`, [input.stripeDisputeId])
    if (seen) return false
    const onWhom = tenantFee > 0 ? 'billed to the tenant (the dispute fee line)' : 'netted from the payee\'s payout (the chargeback line)'
    await createAdminNotification({
      severity: 'warn',
      category: 'dispute_fee_differs',
      title: `Stripe's dispute fee differs from what GAM passed on (${input.paymentIntentId ?? input.stripeDisputeId})`,
      body: `Dispute ${input.stripeDisputeId}: Stripe's fee is ${usd(input.actualFeeCents)}, but ${usd(recorded)} was ${onWhom} ` +
        `when the money was taken (Stripe had not said its fee yet). Correct that line by ${usd(Math.abs(input.actualFeeCents - recorded))} ` +
        `(${input.actualFeeCents > recorded ? 'up' : 'down'}) — the fee is passed on at Stripe's actual cost, never more, and GAM absorbs none of it.`,
      context: { stripe_dispute_id: input.stripeDisputeId, stripe_payment_intent_id: input.paymentIntentId, stripe_event_id: input.stripeEventId,
                 actual_fee: toDollars(input.actualFeeCents), passed_on: toDollars(recorded) },
    })
    return true
  } catch (e) {
    logger.error({ err: e, stripe_dispute_id: input.stripeDisputeId }, '[payment_reversal] dispute fee check failed')
    return false
  }
}


/** The household a lease's bills belong to (creditUse.billHouseholdTenant). */
async function billHouseholdOf(client: PoolClient, leaseId: string): Promise<{ tenantId: string; landlordId: string } | null> {
  const { billHouseholdTenant } = await import('./creditUse')
  return billHouseholdTenant(client, leaseId)
}

/**
 * Take `cents` of a disputed charge's paid-ahead credit off it, against this
 * event's record: a 'reversal' use, the same one creditUse writes
 * (takeBackForDispute). Never more than the credit holds; nothing off a
 * withdrawn credit (out of every balance already). Returns cents taken.
 */
async function drainCreditForRecord(client: PoolClient, creditId: string, reversalId: string, cents: number): Promise<number> {
  if (cents <= 0) return 0
  const c = (await client.query<{ lease_id: string; amount_remaining: string; voided_at: Date | null }>(
    `SELECT lease_id, amount_remaining::text AS amount_remaining, voided_at FROM lease_prepaid_credits WHERE id = $1 FOR UPDATE`,
    [creditId])).rows[0]
  if (!c || c.voided_at) return 0
  const take = Math.min(cents, toCents(c.amount_remaining))
  if (take <= 0) return 0
  await client.query(
    `INSERT INTO credit_uses
       (prepaid_credit_id, payment_reversal_id, lease_id, amount, billing_month, source, status, applied_at)
     VALUES ($1, $2, $3, $4, date_trunc('month', now())::date, 'reversal', 'applied', now())`,
    [creditId, reversalId, c.lease_id, toDollars(take).toFixed(2)])
  logger.warn({ creditId, reversalId, drained: toDollars(take) }, '[payment_reversal] disputed paid-ahead money taken back, not given back')
  return take
}

/** Where a fee rides when the charge paid no rows: the credit's lease, its unit and its tenant. */
async function creditHome(client: PoolClient, creditId: string): Promise<Pick<ChargeRow,
  'unit_id' | 'lease_id' | 'tenant_id' | 'landlord_id' | 'invoice_id'> | null> {
  const r = (await client.query<{ unit_id: string | null; lease_id: string; tenant_id: string; landlord_id: string }>(
    `SELECT l.unit_id, c.lease_id, c.tenant_id, l.landlord_id
       FROM lease_prepaid_credits c JOIN leases l ON l.id = c.lease_id WHERE c.id = $1`, [creditId])).rows[0]
  return r ? { ...r, invoice_id: null } : null
}

/**
 * Take GAM's banking spread on a disputed charge off the book, for the part of
 * the charge's fee the dispute took (all of it for a whole dispute). Once per
 * charge: the reference is the charge's receipt (else the event's first
 * record), and a reference already reversed is not reversed again. Returns
 * cents reversed.
 */
async function reverseChargeSpread(
  client: PoolClient,
  a: { pi: string | null; onlyRowId: string | null; remittanceId: string | null; feeTotal: number; feeTaken: number
       reference: string; eventId: string; propertyUnitId: string | null },
): Promise<number> {
  const done = await client.query(
    `SELECT 1 FROM platform_revenue_ledger WHERE reference_type = 'dispute_spread_reversal' AND reference_id = $1 LIMIT 1`,
    [a.reference])
  if ((done.rowCount ?? 0) > 0) return 0
  const booked = toCents((await client.query<{ s: string }>(
    `SELECT COALESCE(SUM(l.amount), 0)::text AS s FROM platform_revenue_ledger l
      WHERE l.type = 'banking_spread'
        AND ((l.reference_type = 'payment' AND l.reference_id IN (
                SELECT p.id FROM payments p
                 WHERE ${a.pi ? 'p.stripe_payment_intent_id = $1' : 'p.id = $1::uuid'}))
             OR (l.reference_type = 'tenant_remittance' AND l.reference_id = $2::uuid))`,
    [a.pi ?? a.onlyRowId, a.remittanceId])).rows[0]?.s)
  if (booked === 0) return 0
  const share = a.feeTotal > 0 ? Math.min(1, a.feeTaken / a.feeTotal) : 1
  const reverse = Math.round(booked * share)
  if (reverse === 0) return 0
  const prop = a.propertyUnitId
    ? (await client.query<{ property_id: string }>(`SELECT property_id FROM units WHERE id = $1`, [a.propertyUnitId])).rows[0]?.property_id ?? null
    : null
  const { recordPlatformRevenue } = await import('./platformRevenue')
  await recordPlatformRevenue({
    type: 'adjustment',
    amount: -toDollars(reverse),
    referenceId: a.reference,
    referenceType: 'dispute_spread_reversal',
    propertyId: prop,
    notes: `Banking spread taken back: charge ${a.pi ?? a.onlyRowId} was disputed or returned (event ${a.eventId})`,
  }, client)
  return reverse
}

/**
 * The fee a dispute took back is the landlords' (decisions #38 Q4, #22), a
 * negative line on each one's next payout; together they carry it for the
 * share of the money taken back that was theirs, each by its own share
 * (`weights` of `weightTotal`, cents — what is not a landlord's weight is
 * GAM's own and stays GAM's). Under the rule in force
 * ('landlord_bears_whole_fee') that is the WHOLE fee the dispute took
 * (`feeTaken`: what Stripe took beyond the charge's money — the payer got it
 * back), so GAM keeps the fee it earned and absorbs nothing. Under the
 * superseded rule it is only Stripe's own kept cost, read from the spread
 * booked on the charge (fee charged less GAM's spread), and when the book
 * cannot say what Stripe kept an admin is told to net it by hand — never
 * silently GAM's. Once per charge and landlord (held_payout_items is unique
 * per source). Returns cents.
 */
async function chargeKeptStripeFee(
  client: PoolClient,
  a: { pi: string; remittanceId: string | null; feeTotal: number; feeTaken: number
       weights: Map<string, number>; weightTotal: number
       reversalType: PaymentReversalType; eventId: string
       alerts: Array<Parameters<typeof createAdminNotification>[0]>
       rule?: DisputeFeeRule },
): Promise<number> {
  const rule = a.rule ?? DISPUTE_FEE_RULE
  const landlordIds = [...a.weights.keys()].sort()
  const what = a.reversalType === 'card_dispute' ? 'disputed card payment' : 'bank payment taken back'
  let kept: number
  if (rule === 'landlord_bears_whole_fee') {
    kept = Math.max(0, Math.round(a.feeTaken))
  } else {
    const book = (await client.query<{ n: number; unknown: number; fee: string; spread: string }>(
      `SELECT COUNT(*)::int AS n,
              COUNT(*) FILTER (WHERE l.customer_fee_charged IS NULL)::int AS unknown,
              COALESCE(SUM(l.customer_fee_charged), 0)::text AS fee,
              COALESCE(SUM(l.amount), 0)::text AS spread
         FROM platform_revenue_ledger l
        WHERE l.type = 'banking_spread'
          AND ((l.reference_type = 'payment'
                AND l.reference_id IN (SELECT p.id FROM payments p WHERE p.stripe_payment_intent_id = $1))
               OR (l.reference_type = 'tenant_remittance' AND l.reference_id = $2::uuid))`,
      [a.pi, a.remittanceId])).rows[0]
    if (!book || book.n === 0 || book.unknown > 0) {
      a.alerts.push({
        severity: 'warn', category: 'dispute_stripe_fee_unread',
        title: `Stripe's kept fee on a ${what} could not be read (${a.pi})`,
        body: `Stripe keeps its processing fee when a payment is taken back, and that cost is the landlord's (decisions #38). ` +
          `GAM's book does not say what Stripe charged on ${a.pi} (event ${a.eventId}), so nothing was netted from ` +
          `${landlordIds.length === 1 ? `landlord ${landlordIds[0]}` : `landlords ${landlordIds.join(', ')}`}. ` +
          'Read the fee in Stripe and net it from their next payouts by hand, each by its share of the money taken back — GAM does not absorb it.',
        context: { stripe_payment_intent_id: a.pi, landlord_ids: landlordIds, stripe_event_id: a.eventId },
      })
      return 0
    }
    kept = disputeFeeBorneCents(rule, {
      feeCents: toCents(book.fee), spreadCents: toCents(book.spread), feeTaken: a.feeTaken, feeTotal: a.feeTotal })
  }
  if (kept <= 0 || a.weightTotal <= 0) return 0
  // Each landlord's part, by its weight; the cents rounding left over goes to
  // the largest remainders, never past what the landlords' weights carry.
  const landlordWeight = landlordIds.reduce((s, id) => s + (a.weights.get(id) ?? 0), 0)
  const landlordsCents = Math.round(kept * Math.min(1, landlordWeight / a.weightTotal))
  const parts = landlordIds.map(id => {
    const exact = landlordWeight > 0 ? landlordsCents * (a.weights.get(id) ?? 0) / landlordWeight : 0
    return { id, cents: Math.floor(exact), rest: exact - Math.floor(exact) }
  })
  let left = landlordsCents - parts.reduce((s, p) => s + p.cents, 0)
  for (const p of [...parts].sort((x, y) => y.rest - x.rest || x.id.localeCompare(y.id))) {
    if (left <= 0) break
    p.cents += 1
    left -= 1
  }
  const { recordHeldItem } = await import('./heldPayouts')
  let charged = 0
  for (const p of parts) {
    if (p.cents <= 0) continue
    const recorded = await recordHeldItem({
      landlordId: p.id, sourceType: 'dispute', sourceId: `stripe_fee_kept:${a.pi}:${p.id}`,
      amount: -toDollars(p.cents),
      description: rule === 'landlord_bears_whole_fee'
        ? `The ${a.reversalType === 'card_dispute' ? 'card' : 'bank'} fee on a ${what}: it went back to the payer with the payment, so it comes off your payout`
        : `Stripe's processing fee on a ${what} — Stripe keeps it when a payment is taken back`,
    }, client)
    if (recorded) { charged += p.cents; continue }
    // Fix pass (rev9): the line is once per charge and landlord. When an
    // earlier dispute of this charge was WON, that line was handed back (by
    // hand from the won-dispute notice, decisions #55-AMENDED, on the source
    // id stripeCosts.wonDisputeFeeReturnSourceId) and this later dispute's fee cannot ride it again —
    // told to an admin to net by hand, never GAM's in silence.
    const handedBack = await client.query(
      `SELECT 1 FROM held_payout_items WHERE source_type = 'dispute' AND source_id = $1 || ':returned_on_win'`,
      [`stripe_fee_kept:${a.pi}:${p.id}`])
    if (handedBack.rowCount) {
      a.alerts.push({
        severity: 'critical', category: 'dispute_fee_after_win_unnetted',
        title: `A later dispute's ${a.reversalType === 'card_dispute' ? 'card' : 'bank'} fee was not taken off the landlord's payout (${a.pi})`,
        body: `An earlier dispute of this payment was won and its fee handed back, so this dispute's $${toDollars(p.cents).toFixed(2)} fee ` +
          `(event ${a.eventId}) could not be put on landlord ${p.id}'s payout the same way. Net it from their next payout by hand — GAM does not absorb it.`,
        context: { stripe_payment_intent_id: a.pi, landlord_id: p.id, stripe_event_id: a.eventId, amount: toDollars(p.cents) },
      })
    }
  }
  return charged
}

/**
 * Fix pass 2 (review): the dispute's status at this event — the caller's word,
 * else the raw dispute event's, else the dispute on file. null when the event
 * is not a dispute (a bank return) or nothing says.
 */
async function disputeStatusOf(input: PaymentReversalInput): Promise<string | null> {
  if (input.disputeStatus) return input.disputeStatus
  const ev = input.rawEvent as { type?: unknown; data?: { object?: { object?: unknown; status?: unknown } } } | null | undefined
  const obj = ev?.data?.object
  const isDispute = obj?.object === 'dispute' || (typeof ev?.type === 'string' && ev.type.startsWith('charge.dispute.'))
  if (isDispute && typeof obj?.status === 'string' && obj.status) return obj.status
  if (!input.connectDisputeId && !input.stripeObjectId) return null
  const row = await queryOne<{ status: string | null }>(
    `SELECT status FROM connect_disputes
      WHERE ($1::uuid IS NOT NULL AND id = $1::uuid) OR ($2::text IS NOT NULL AND stripe_dispute_id = $2)
      ORDER BY (id = $1::uuid) DESC NULLS LAST LIMIT 1`,
    [input.connectDisputeId ?? null, input.stripeObjectId ?? null])
  return row?.status ?? null
}

/**
 * An inquiry (a bank's question before a dispute) opened on a tenant payment:
 * Stripe took no money, so nothing was reopened. Told to an admin once per
 * inquiry, so it is answered — and, if it becomes a dispute, checked that the
 * bills it paid were reopened then. Never throws.
 */
async function alertInquiryOpen(pi: string | null, onlyRowId: string | null, input: PaymentReversalInput, status: string): Promise<void> {
  try {
    const key = input.stripeObjectId ?? input.stripeEventId
    const seen = await queryOne(
      `SELECT 1 FROM admin_notifications WHERE category = 'dispute_inquiry_open' AND context->>'stripe_dispute_id' = $1
       UNION ALL
       SELECT 1 FROM admin_notifications_archive WHERE category = 'dispute_inquiry_open' AND context->>'stripe_dispute_id' = $1
       LIMIT 1`, [key])
    if (seen) return
    const amount = input.reversedAmount != null ? `$${input.reversedAmount.toFixed(2)}` : 'the payment'
    await createAdminNotification({
      severity: 'warn',
      category: 'dispute_inquiry_open',
      title: `A bank inquiry was opened on a tenant payment (${pi ?? onlyRowId})`,
      body: `The payer's bank asked about ${amount} of this payment (inquiry ${key}). Stripe has not taken any money back, ` +
        'so no bill was reopened, nothing was taken from the landlord and no dispute fee was billed. ' +
        'Make sure it is answered (the landlord can answer it from their Disputes page) before its deadline. If the bank turns it into a dispute, the bills this payment paid ' +
        'are reopened then — check that they were.',
      context: { stripe_dispute_id: key, stripe_payment_intent_id: pi, payment_id: onlyRowId, stripe_event_id: input.stripeEventId,
                 dispute_status: status, amount: input.reversedAmount ?? null },
    })
  } catch (e) {
    logger.error({ err: e, stripe_payment_intent_id: pi, stripe_event_id: input.stripeEventId }, '[payment_reversal] inquiry alert failed')
  }
}

/**
 * A dispute or return that reopened nothing on a charge GAM knows (rows or a
 * receipt carry its intent): Stripe took the money back and no row was
 * reopened — rows settled another way, or already reopened in full. Told to
 * an admin loudly; never silent. Returns whether GAM knows the charge (false:
 * no row and no receipt carry it). Never throws.
 */
async function alertNothingReversed(pi: string | null, onlyRowId: string | null, input: PaymentReversalInput): Promise<boolean> {
  let known = true
  try {
    const facts = await queryOne<{ known: boolean; disputed: boolean; statuses: string | null }>(
      pi
        ? `SELECT (EXISTS (SELECT 1 FROM payments WHERE stripe_payment_intent_id = $1)
                   OR EXISTS (SELECT 1 FROM tenant_remittances WHERE stripe_payment_intent_id = $1)) AS known,
                  EXISTS (SELECT 1 FROM connect_disputes WHERE stripe_payment_intent_id = $1) AS disputed,
                  (SELECT string_agg(DISTINCT status, ', ') FROM payments WHERE stripe_payment_intent_id = $1) AS statuses`
        : `SELECT EXISTS (SELECT 1 FROM payments WHERE id = $1::uuid) AS known, FALSE AS disputed,
                  (SELECT status FROM payments WHERE id = $1::uuid) AS statuses`,
      [pi ?? onlyRowId])
    known = !!facts?.known
    if (!facts || !known) return false
    const kind = input.reversalType === 'card_dispute' ? 'dispute' : 'bank return'
    await createAdminNotification({
      severity: 'critical',
      category: 'payment_reversal_nothing_reopened',
      title: `A ${kind} reopened nothing on a tenant payment (${pi ?? onlyRowId})`,
      body: `Stripe took back $${(input.reversedAmount ?? 0).toFixed(2)} (event ${input.stripeEventId}${facts.disputed ? ', a recorded dispute' : ''}), ` +
        `but no row this payment paid is still settled through it (its rows: ${facts.statuses ?? 'none'}). ` +
        'Nothing is owed again and nothing is recovered from the landlord: look at the payment and reopen what it paid by hand.',
      context: { stripe_payment_intent_id: pi, payment_id: onlyRowId, stripe_event_id: input.stripeEventId,
                 reversal_type: input.reversalType, dispute_recorded: facts.disputed },
    })
  } catch (e) {
    logger.error({ err: e, stripe_payment_intent_id: pi, stripe_event_id: input.stripeEventId }, '[payment_reversal] nothing-reopened alert failed')
  }
  return known
}

/** A refill line given back after the cash repayment that charged it was undone (undoTenantPaidResolution). */
const refillBackSource = (reversalId: string) => `owner_share_refill_back:${reversalId}`

/**
 * The record's refill lines (a cash repayment's 'owner_share_refill:<record>'
 * and later ones ':<n>') and the lines that gave them back: cents still
 * charged to the landlord for it, and how many refill / give-back lines exist.
 */
async function refillLines(client: PoolClient, reversalId: string): Promise<{ charged: number; lines: number; backs: number }> {
  const refill = refillShareSource(reversalId)
  const back = refillBackSource(reversalId)
  const r = (await client.query<{ s: string; lines: number; backs: number }>(
    `SELECT COALESCE(-SUM(amount), 0)::text AS s,
            COUNT(*) FILTER (WHERE source_id = $1 OR left(source_id, length($1) + 1) = $1 || ':')::int AS lines,
            COUNT(*) FILTER (WHERE left(source_id, length($2)) = $2)::int AS backs
       FROM held_payout_items
      WHERE source_type = 'dispute'
        AND (source_id = $1 OR left(source_id, length($1) + 1) = $1 || ':' OR left(source_id, length($2)) = $2)`,
    [refill, back])).rows[0]
  return { charged: Math.max(0, toCents(r?.s)), lines: r?.lines ?? 0, backs: r?.backs ?? 0 }
}

/**
 * Fix pass 2 (review) — a reopened charge whose repayment resolved its record
 * (resolveReversalOnTenantPayment) is owed again: the payment that paid it was
 * taken back off the bill (a bank-deposit match undone). Puts the record back
 * the way the reversal left it, inside the caller's transaction, under the
 * landlord's payout lock:
 *   - outcome / status / resolved_at / late_fee_owner back to what the
 *     recovery says (a recovered record stays 'landlord_clawback', resolved;
 *     one GAM still recovers stays open);
 *   - a cash repayment's refill lines ('owner_share_refill:<record>', what
 *     came off the landlord's payout for cash they then never had) are given
 *     back on a positive line ('owner_share_refill_back:<record>:<n>'), which
 *     nets the refill on the same payout when it is not paid out yet;
 *   - the reopened deposit charge, no longer paid, is no longer the
 *     move-out's money (released_by_deposit_return_id cleared, never on
 *     GAM's balance).
 * Only cash, check or money-order repayments can be taken off a bill this
 * way, and only those write refill lines: a record an online repayment
 * resolved (late_fee_owner 'gam'), or one not resolved by the tenant, is left
 * alone.
 * Idempotent. Exported for the undo of a bank-deposit match
 * (bankDepositConfirm), and used by resolveReversalOnTenantPayment when a
 * stale resolution meets a real repayment.
 */
export async function undoTenantPaidResolution(client: PoolClient, reversalId: string): Promise<void> {
  // Fix pass (rev9, lock order): the weekly payout takes the landlord's payout
  // lock and THEN locks their records (landlordPassthrough.applyReversalNetting);
  // so does this — the landlord is read unlocked, the payout lock taken, and
  // only then the record locked. The other order could deadlock with a batch.
  const who = (await client.query<{ landlord_id: string | null }>(
    `SELECT landlord_id FROM payment_reversals WHERE id = $1`, [reversalId])).rows[0]
  if (!who) return
  if (who.landlord_id) await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [payoutLockKey(who.landlord_id)])
  const rec = (await client.query<{ outcome: string | null; late_fee_owner: string | null; landlord_id: string | null; payment_id: string }>(
    `SELECT outcome, late_fee_owner, landlord_id, payment_id FROM payment_reversals WHERE id = $1 FOR UPDATE`, [reversalId])).rows[0]
  // Only a cash repayment's resolution (late_fee_owner 'landlord') is undone.
  if (!rec || rec.outcome !== 'tenant_paid' || rec.late_fee_owner !== 'landlord') return
  if (rec.landlord_id) {
    const fam = await refillLines(client, reversalId)
    if (fam.charged > 0) {
      const { recordHeldItem } = await import('./heldPayouts')
      const w = (await client.query<{ unit_number: string | null; tenant_name: string | null }>(
        `SELECT un.unit_number, NULLIF(btrim(CONCAT(u.first_name, ' ', u.last_name)), '') AS tenant_name
           FROM payments p LEFT JOIN units un ON un.id = p.unit_id
           LEFT JOIN tenants t ON t.id = p.tenant_id LEFT JOIN users u ON u.id = t.user_id
          WHERE p.id = $1`, [rec.payment_id])).rows[0]
      await recordHeldItem({
        landlordId: rec.landlord_id, sourceType: 'dispute', sourceId: `${refillBackSource(reversalId)}:${fam.backs}`,
        amount: toDollars(fam.charged),
        description: `Move-out at ${w?.unit_number ?? 'the space'}: the in-person payment of ${w?.tenant_name ?? 'the tenant'}'s reopened deposit charge ` +
          `was taken off the bill, so the $${toDollars(fam.charged).toFixed(2)} taken off your payout for it is given back`,
      }, client)
    }
  }
  await client.query(
    `UPDATE payment_reversals
        SET outcome        = CASE WHEN recovery_status = 'recovered' THEN 'landlord_clawback' END,
            late_fee_owner = CASE WHEN recovery_status = 'recovered' THEN 'landlord' END,
            -- As the recovery engine left it: a recovery whose way was
            -- chosen (netting, or a pull still to run) is 'recovering'.
            status         = CASE WHEN recovery_status = 'recovered' THEN 'resolved'
                                  WHEN recovery_status = 'scheduled_netting' OR recovery_method IS NOT NULL THEN 'recovering'
                                  ELSE 'open' END,
            resolved_at    = CASE WHEN recovery_status = 'recovered' THEN COALESCE(recovered_at, resolved_at) END,
            updated_at     = NOW()
      WHERE id = $1`, [reversalId])
  await client.query(
    `UPDATE payments SET released_by_deposit_return_id = NULL, platform_held = FALSE
      WHERE reversal_id = $1 AND type = 'deposit' AND status NOT IN ('settled', 'paid_via_deposit')
        AND released_by_deposit_return_id IS NOT NULL`, [reversalId])
}

/**
 * Resolve a reversal when the tenant re-pays the reopened row. Called from the
 * settle path INSIDE the settling transaction (the reopened row carries
 * payments.reversal_id). Returns whether the landlord was ALREADY made to give
 * back what the row lost (clawed back, or their unpaid share withheld):
 *   - true  → the caller re-disburses the re-payment to the landlord (normal
 *             allocation) — they were made short by the clawback.
 *   - false → GAM KEEPS the re-payment (reimbursing its reversal loss); the
 *             landlord's scheduled clawback is cancelled (recovery_status =
 *             'not_needed'), and whatever WAS already taken from them for
 *             this record — their unpaid share withheld (Step 10 review, pass
 *             2) — is paid back to them on a held line, so a landlord is never
 *             short by a part-recovery when GAM keeps the re-payment.
 * Either way GAM keeps the late fee + reversal fee (late_fee_owner = 'gam').
 *
 * Paid from the security deposit at move-out (depositReturn sweeps the
 * reopened row to 'paid_via_deposit'): that money goes to the LANDLORD, not
 * GAM, so nothing is cancelled — the recovery stands (it is what makes GAM
 * whole for what Stripe took back), the record only learns the tenant paid.
 * Returns true then (the landlord already has the re-payment). Idempotent.
 */
export async function resolveReversalOnTenantPayment(
  client: PoolClient,
  reversalId: string,
  /**
   * Fix pass 2 (decisions #54): the repayment was cash, check or money order
   * taken by the landlord (manualPaymentSettle) — the landlord holds it. For a
   * reopened deposit charge a move-out settled, nothing is paid to them: they
   * keep from the cash the kept share they gave back, and the rest of it (what
   * refills GAM) comes off their next payout ('owner_share_refill:<record>').
   */
  opts: { landlordHoldsCash?: boolean } = {},
): Promise<boolean> {
  const read = async () => (await client.query<{
    recovery_status: string; recovered_amount: string; reversed_amount: string; landlord_id: string
    outcome: string | null; late_fee_owner: string | null; via_deposit: boolean; resolved_here: boolean; cash_settled: boolean
  }>(
    `SELECT r.recovery_status,
            r.recovered_amount::text AS recovered_amount,
            r.reversed_amount::text  AS reversed_amount,
            r.landlord_id, r.outcome, r.late_fee_owner,
            EXISTS (SELECT 1 FROM payments n WHERE n.reversal_id = r.id AND n.status = 'paid_via_deposit') AS via_deposit,
            (r.updated_at = now()) AS resolved_here,
            EXISTS (SELECT 1 FROM payments n WHERE n.reversal_id = r.id AND n.status = 'settled'
                      AND n.manual_method IS NOT NULL) AS cash_settled
       FROM payment_reversals r WHERE r.id = $1 FOR UPDATE`,
    [reversalId]
  )).rows[0]
  // Fix pass (rev9, lock order): a cash resolution may be undone below, which
  // needs the landlord's payout lock — taken BEFORE the record is locked, the
  // order the weekly payout takes them in (payout lock, then the landlord's
  // records), so the two never deadlock.
  const pre = (await client.query<{ landlord_id: string | null; outcome: string | null; late_fee_owner: string | null }>(
    `SELECT landlord_id, outcome, late_fee_owner FROM payment_reversals WHERE id = $1`, [reversalId])).rows[0]
  if (!pre) return false
  if (pre.landlord_id && pre.outcome === 'tenant_paid' && pre.late_fee_owner === 'landlord') {
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [payoutLockKey(pre.landlord_id)])
  }
  let rev = await read()
  if (!rev) return false
  if (rev.outcome === 'tenant_paid') {
    // Fix pass 2 (review): a resolution that no longer stands is never
    // trusted. A CASH repayment's resolution (late_fee_owner 'landlord': the
    // landlord holds that money) met by a payment that is not cash, in a
    // later transaction, while the reopened row is no longer paid in cash:
    // the cash was taken off the bill since (a bank-deposit match undone) and
    // this is a real repayment. Trusting the old resolution would let GAM keep
    // this repayment while the landlord's recovery stood (collected twice), so
    // it is undone first and this payment resolves the record afresh. Any
    // other second call (the same payment again) changes nothing.
    const staleCash = !rev.resolved_here && !opts.landlordHoldsCash && !rev.via_deposit
      && rev.late_fee_owner === 'landlord' && !rev.cash_settled
    if (!staleCash) return rev.recovery_status === 'recovered'
    await undoTenantPaidResolution(client, reversalId)
    rev = await read()
    if (!rev) return false
  }

  const recovered = toCents(rev.recovered_amount)
  const reversed  = toCents(rev.reversed_amount)
  const fullyRecovered = rev.recovery_status === 'recovered' || (reversed > 0 && recovered >= reversed)

  if (rev.via_deposit) {
    await client.query(
      `UPDATE payment_reversals SET outcome = 'tenant_paid', updated_at = NOW() WHERE id = $1`, [reversalId])
    return true
  }

  // Step 9 final fix (decisions #54): the reopened charge of a deposit payment
  // a finalized move-out already settled, paid again. The re-payment refills
  // what the dispute took from GAM: it is NOT a deposit GAM holds in trust (the
  // tenancy's deposit was settled at move-out) and is never released to the
  // landlord by a move-out or payout again — stamped with that move-out, off
  // the trust count. What the landlord gave back of the kept share
  // (settleDepositKeptSide's negative line) is paid back to them once, on a
  // held line: the tenant has now paid it, so it is theirs again. When their
  // line is not netted yet, the two cancel on the same payout.
  const dep = (await client.query<{ draft_id: string | null; payment_id: string }>(
    `SELECT p.released_by_deposit_return_id AS draft_id, p.id AS payment_id
       FROM payment_reversals r JOIN payments p ON p.id = r.payment_id
      WHERE r.id = $1 AND p.type = 'deposit'`, [reversalId])).rows[0]
  if (dep?.draft_id) {
    const repaid = (await client.query<{ amount: string }>(
      `UPDATE payments SET platform_held = FALSE, released_by_deposit_return_id = $2
        WHERE reversal_id = $1 AND type = 'deposit' AND status = 'settled'
        RETURNING amount::text AS amount`, [reversalId, dep.draft_id])).rows.reduce((t, x) => t + toCents(x.amount), 0)
    // Every kept-share ask of this record: its first line and any top-up (topUpDepositKeptAsk).
    const asked = toCents((await client.query<{ s: string }>(
      `SELECT COALESCE(-SUM(h.amount), 0)::text AS s FROM held_payout_items h
        WHERE h.source_type = 'dispute' AND (h.source_id = $1 OR h.source_id LIKE $1 || ':%')`,
      [withheldShareSource(reversalId)])).rows[0]?.s)
    if (opts.landlordHoldsCash) {
      // The landlord holds the whole repayment: their kept share is theirs
      // again out of it; the rest refills what the dispute took from GAM.
      const refill = Math.max(0, repaid - asked)
      if (refill > 0 && rev.landlord_id) {
        // Never charged twice: what an earlier cash repayment of this record
        // still charges them (one undone since is given back first,
        // undoTenantPaidResolution) counts toward it.
        const fam = await refillLines(client, reversalId)
        const more = refill - fam.charged
        if (more > 0) {
          const { recordHeldItem } = await import('./heldPayouts')
          await recordHeldItem({
            landlordId: rev.landlord_id, sourceType: 'dispute',
            sourceId: fam.lines === 0 ? refillShareSource(reversalId) : `${refillShareSource(reversalId)}:${fam.lines}`,
            amount: -toDollars(more), description: await depositLineWords(client, dep.payment_id, 'refill', more),
          }, client)
        }
      }
      // late_fee_owner 'landlord': the landlord holds this repayment, late
      // fees paid with it included — and it marks a cash resolution (above).
      await client.query(
        `UPDATE payment_reversals
            SET outcome = 'tenant_paid', late_fee_owner = 'landlord', status = 'resolved',
                resolved_at = COALESCE(resolved_at, NOW()), updated_at = NOW()
          WHERE id = $1`, [reversalId])
      return false
    }
    if (asked > 0 && rev.landlord_id) {
      const { recordHeldItem } = await import('./heldPayouts')
      await recordHeldItem({
        landlordId: rev.landlord_id, sourceType: 'dispute', sourceId: returnedShareSource(reversalId),
        amount: toDollars(asked), description: await depositLineWords(client, dep.payment_id, 'returned'),
      }, client)
    }
    await client.query(
      `UPDATE payment_reversals
          SET outcome = 'tenant_paid', late_fee_owner = 'gam', status = 'resolved',
              resolved_at = COALESCE(resolved_at, NOW()), updated_at = NOW()
        WHERE id = $1`, [reversalId])
    return asked > 0
  }

  // Fix pass (rev8): any other reopened charge paid again in cash, a check or
  // a money order (manualPaymentSettle): the landlord holds that money, as
  // with a security-deposit sweep above — nothing is cancelled and nothing
  // withheld is paid back (they would be paid twice); the recovery stands,
  // the record only learns the tenant paid.
  if (opts.landlordHoldsCash) {
    // late_fee_owner 'landlord': they hold the cash, late fees paid with it
    // included (and it marks a cash resolution, above).
    await client.query(
      `UPDATE payment_reversals SET outcome = 'tenant_paid', late_fee_owner = 'landlord', updated_at = NOW() WHERE id = $1`,
      [reversalId])
    return true
  }

  await client.query(
    `UPDATE payment_reversals
        SET outcome         = 'tenant_paid',
            late_fee_owner  = 'gam',
            status          = 'resolved',
            resolved_at     = COALESCE(resolved_at, NOW()),
            recovery_status = CASE WHEN $2 THEN recovery_status ELSE 'not_needed' END,
            updated_at = NOW()
      WHERE id = $1`,
    [reversalId, fullyRecovered]
  )

  if (!fullyRecovered && rev.landlord_id) {
    // GAM keeps the re-payment: what was withheld from the landlord for this
    // record goes back to them (their share's stamped rows, less the part of
    // it already paid back on a held line, plus what an earlier held line of
    // theirs was netted for it).
    const w = (await client.query<{ stamped: string; untouched: string; netted: string }>(
      `SELECT COALESCE((SELECT SUM(amount) FROM user_balance_ledger
                         WHERE type = 'allocation_owner_share' AND stripe_transfer_id = $1), 0)::text AS stamped,
              COALESCE((SELECT SUM(amount) FROM held_payout_items
                         WHERE source_type = 'dispute' AND source_id = $2), 0)::text AS untouched,
              COALESCE((SELECT -SUM(amount) FROM held_payout_items
                         WHERE source_type = 'dispute' AND source_id = $3), 0)::text AS netted`,
      [withheldStamp(reversalId), untouchedShareSource(reversalId), withheldShareSource(reversalId)])).rows[0]
    const withheld = Math.max(0, toCents(w?.stamped) - toCents(w?.untouched) + toCents(w?.netted))
    const back = Math.min(withheld, recovered)
    if (back > 0) {
      const { recordHeldItem } = await import('./heldPayouts')
      await recordHeldItem({
        landlordId: rev.landlord_id, sourceType: 'dispute', sourceId: returnedShareSource(reversalId),
        amount: toDollars(back),
        description: 'Your share held back after a payment was taken back, paid now: the tenant paid it again',
      }, client)
    }
    // The rest of recovered_amount may be GAM-first money (GAM's own, never
    // the landlord's, at most the row's routed amount). Anything beyond that
    // was recovered from the landlord another way (a netting or a pull only
    // ever recovers a whole record, so this is not expected): a person pays
    // it back to them.
    const routedMax = Math.min(reversed, toCents((await client.query<{ g: string }>(
      `SELECT COALESCE(p.gam_supersedence_amount, 0)::text AS g
         FROM payment_reversals r JOIN payments p ON p.id = r.payment_id WHERE r.id = $1`, [reversalId])).rows[0]?.g))
    const unexplained = recovered - back - routedMax
    if (unexplained > 0) {
      await createAdminNotification({
        severity: 'warn',
        category: 'payment_reversal_partial_clawback_tenant_paid',
        title:    `Reversal ${reversalId}: tenant re-paid after part of it was recovered from the landlord`,
        body:     `GAM kept the tenant's re-payment. Landlord ${rev.landlord_id} had $${toDollars(unexplained).toFixed(2)} recovered from them for it ` +
                  `(of $${toDollars(reversed).toFixed(2)} taken back) that was not their withheld share: pay that back to them.`,
        context:  { reversal_id: reversalId, landlord_id: rev.landlord_id, recovered: toDollars(recovered),
                    withheld_returned: toDollars(back), unexplained: toDollars(unexplained) },
      })
    }
  }

  return fullyRecovered
}

/**
 * The bold landlord alert, ONCE per event and landlord: the tenant, the space,
 * and what the tenant owes again on THIS landlord's rows (the reopened lines
 * plus the late fees back-filled on those bills, this landlord's only). To
 * the responsible party of the property those rows sit at — never another
 * landlord's money (a neighbor's utility on the same bill is told to its own
 * landlord).
 */
async function notifyLandlordOfReversal(result: PaymentReversalResult, landlordId: string): Promise<void> {
  const landlordRows = result.rows.filter(r => r.newPaymentId && r.revenueOwner === 'landlord' && r.landlordId === landlordId)
  const anchorRow = landlordRows[0]
  if (!anchorRow) return
  const ctx = await query<{
    landlord_id_pk: string; property_id: string
    tenant_name: string; unit_number: string; property_name: string
    invoice_id: string | null
  }>(
    `SELECT l.id AS landlord_id_pk, pr.id AS property_id,
            tu.first_name || ' ' || tu.last_name AS tenant_name,
            un.unit_number, pr.name AS property_name, p.invoice_id
       FROM payments p
       JOIN tenants t     ON t.id = p.tenant_id
       JOIN users tu      ON tu.id = t.user_id
       JOIN landlords l   ON l.id = p.landlord_id
       JOIN units un      ON un.id = p.unit_id
       JOIN properties pr ON pr.id = un.property_id
      WHERE p.id = $1`,
    [anchorRow.newPaymentId]
  )
  const c = ctx[0]
  if (!c) return

  // What the tenant owes again for this landlord: every reopened landlord row,
  // plus the late fees now open on those bills.
  const owed = await queryOne<{ owed: string }>(
    `SELECT COALESCE(SUM(p.amount), 0)::text AS owed FROM payments p
      WHERE p.status IN ('pending', 'failed') AND p.revenue_owner = 'landlord' AND p.landlord_id = $2
        AND (p.id = ANY($1::uuid[])
             OR (p.type = 'late_fee' AND p.invoice_id IN (
                   SELECT q.invoice_id FROM payments q WHERE q.id = ANY($1::uuid[]) AND q.invoice_id IS NOT NULL)))`,
    [landlordRows.map(r => r.newPaymentId), landlordId])
  const amountOwed = Math.max(result.landlordTotals[landlordId] ?? 0, Number(owed?.owed ?? 0))

  const { getPropertyResponsibleParty } = await import('./responsibleParty')
  const targets = await getPropertyResponsibleParty(c.property_id)
  if (!targets) return
  const { notifyRentReversed } = await import('./notifications')
  for (const recipient of targets.primaries) {
    await notifyRentReversed({
      landlordUserId: recipient.user_id,
      landlordId:     c.landlord_id_pk,
      landlordEmail:  recipient.email,
      landlordPhone:  recipient.phone ?? undefined,
      tenantName:     c.tenant_name,
      unitNumber:     c.unit_number,
      propertyName:   c.property_name,
      amountOwed,
      actionUrl:      c.invoice_id ? `/payments?invoice=${c.invoice_id}` : undefined,
    })
  }
}

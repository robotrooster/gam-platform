// S624 — settling charges paid outside the platform: cash, a check or a money
// order handed over at the desk (POST /payments/:id/record-manual), the
// landlord assistant's record_cash_payment, a payment posted ahead of the bill
// (services/postPayment), and the bank-deposit match (one named row).
//
// One home on purpose: the rules here are small, unobvious and hard-won, and a
// second copy would drift silently because both paths would still "work".
//
// S654 (Nic): "There's no fee. Paying cash or check is free." Nothing here
// raises a fee row, a ledger line or a landlord charge, on any payment.
//
// S655 (money plan §3, Step 8) — THE DESK ROW OF THE MATRIX:
//   - WHAT IS SETTLED: the household's bank-payable rows (this person with this
//     company, every lease), whole, oldest first. GAM's own charges and another
//     company's charges on the same bill are left for an online payment and
//     listed as "Pay online", so the window's total equals the portal's. Rows
//     with money in flight are left alone. A space in eviction hold is left out.
//   - THE OLD BALANCE (carried forward) is never required: it is paid last,
//     from whatever is over the current bill (S622), and only that part of a
//     carried row may be paid in part.
//   - CREDIT IS NEVER NETTED BY ITSELF (bug 2). The desk sees "credit
//     available $X" and must say Use or Save (creditToUse: the usable figure or
//     0). A figure that moved since the window loaded is a 409 and the window
//     refetches. Uses go straight to applied (the money is already here). With
//     credit used, money over the bill may go to the old balance or back as
//     change — never become new credit beside the credit being spent.
//   - THE RECEIPT: one tenant_remittances row per desk action (method,
//     reference, who took it, gross_amount NULL — no Stripe involved), plus a
//     remittance_application for every row money paid; credit spent beside
//     that money is linked to the receipt (its credit used = the sum of its
//     uses). A credit-only settle writes none. The amount is what went in the
//     drawer: handed over less change given back.
//   - THE SURPLUS: cash over the bill is "Give $X change" or "Keep $X as
//     credit — no change on hand", chosen, never defaulted (S637). Money kept
//     pays the old balance first and only the rest becomes credit (credit
//     never sits beside an old balance it could have paid). A check or
//     money order has no change (S648): its extra goes to the old balance, then
//     becomes paid-ahead money, and the desk must first confirm the amount
//     written on it ("You typed $486.00 against $485.45 owed — is the money
//     order really $486.00?" — Kim Harland's $0.55, Fuller's $0.88 were typed
//     round-ups). Paid-ahead money from the desk is the landlord's
//     (funded_by 'landlord', received_at = when it was taken, linked to the
//     receipt).
//   - THE PAYOUT: the landlord already holds cash and checks, so a desk row
//     pays out nothing (platform_held FALSE) — except the part GAM-held credit
//     paid (paid-ahead money that came through Stripe, deposit interest): that
//     books the owner share with no second fee and marks the row platform_held
//     so the weekly batch reserves it. The old 'prepaid_draw' held item for
//     every desk draw is gone (it paid the landlord their own check twice:
//     bug 1).
//   - AFTER: activation, the payment-history mark and the receipt email run
//     through settleHooks.afterRowsSettled (the receipt after the caller's
//     commit, via afterCommit()).
//
// The bank-deposit match (services/bankDepositConfirm) still settles ONE named
// row at a time through the 'row' scope below: no credit, no receipt (it writes
// its own), no surplus.

import type { PoolClient } from 'pg'
import type { ManualPaymentMethod } from '@gam/shared'
import { sortForAllocation } from '@gam/shared'
import { AppError } from '../middleware/errorHandler'
import { lockHousehold, payableRowSql } from './moneyPredicates'
import {
  householdQuote, supersedeScheduledRetry, applyCredit, createPaidAhead, cancelSupersededIntents,
  type CreditPlanLine, type QuoteRow, type ScheduledRetry,
} from './creditUse'
import { executeRentAllocation, ALLOCATABLE_PAYMENT_TYPES } from './allocation'
import { afterRowsSettled } from './settleHooks'
import { reconcileSettledDepositPayment, type DepositRecordRaised } from './leaseFeesSync'
import { logger } from '../lib/logger'
import { activateBillingForMoneyMoved } from './billingActivation'

/**
 * What became of cash handed over beyond the bill (and the old balance).
 * Only cash has a choice; a check or money order's extra is always credit.
 * (Step 16: lift into packages/shared/src/money.ts with DESK_SURPLUS_HANDLING_LABEL.)
 */
export const DESK_SURPLUS_HANDLING = ['change', 'credit'] as const
export type DeskSurplusHandling = typeof DESK_SURPLUS_HANDLING[number]
export const DESK_SURPLUS_HANDLING_LABEL: Record<DeskSurplusHandling, string> = {
  change: 'Gave change',
  credit: 'Kept as credit — no change on hand',
}

const toCents = (v: number | string | null | undefined): number => Math.round(Number(v ?? 0) * 100)
const toDollars = (c: number): number => Math.round(c) / 100
const money = (c: number): string => `$${toDollars(c).toFixed(2)}`
const methodWord = (m: ManualPaymentMethod) => (m === 'money_order' ? 'money order' : m)

export interface ManualSettleInput {
  /** The charge the desk opened the window on (any open charge of the household). Caller has locked it. */
  payment: {
    id: string; landlord_id: string; tenant_id: string | null; unit_id: string | null
    lease_id: string | null; due_date: string
  }
  method: ManualPaymentMethod
  /** When the money actually moved. NULL: now. */
  settledAt: Date | null
  reference?: string | null
  /** Extra sentence for the payments' notes — e.g. which bank row proved it. */
  provenance?: string | null
  /**
   * S636/S652 (Nic): cash pays the household's WHOLE balance, like a card —
   * "I can't apply cash to one or the other." Either flag selects the desk
   * (household) scope. Neither: the named row only (the bank-deposit match).
   */
  settleWholeBalance?: boolean
  settleHousehold?: boolean
  /** What was handed over (household scope: required). */
  amountTendered?: number | null
  /** Cash over the bill: "Give $X change" or "Keep $X as credit". No default. */
  surplusHandling?: DeskSurplusHandling
  /**
   * Credit the desk chose to use: the usable figure ("Use $X") or 0 ("Save").
   * Required when credit could pay part of the bill.
   */
  creditToUse?: number | null
  /** A posted payment: never spends credit, never asks. */
  neverUseCredit?: boolean
  /** Money toward the old (carried) balance. Cash: chosen. Check/money order: the over, up to the old balance. */
  towardOldBalance?: number | null
  /** A check or money order over the bill: the desk confirmed the amount written on it. */
  confirmWrittenAmount?: boolean
  /** Who took it (tenant_remittances.received_by; credit_uses.created_by). */
  takenBy?: string | null
  /** credit_uses.source for credit spent here. */
  source?: 'desk' | 'landlord_agent'
  /** Notes written on the receipt. */
  notes?: string | null
  /**
   * Where paid-ahead money sits. Default: the opened charge's lease, else the
   * household's newest active lease.
   */
  creditLeaseId?: string | null
  /** Email the resident a receipt after commit (default true in household scope). */
  sendReceipt?: boolean
}

export interface ManualSettleResult {
  /** The rows this settled — what the receipt itemizes. */
  settledPaymentIds: string[]
  /** Money that landed on charges (current bill plus old balance). */
  amountSettled: number
  /** Credit spent on the bill. */
  creditUsed: number
  /** Money over the bill and the old balance. */
  surplus: number
  /** Cash handed back. */
  changeGiven: number
  /** Money that went to the old balance. */
  towardOldBalance: number
  /** Paid-ahead money created from the surplus. */
  creditId: string | null
  /** The desk receipt (tenant_remittances), when money changed hands. */
  receiptId: string | null
  /**
   * 10/4 (decisions #46.3): what each security deposit this settled did to its
   * deposit record — raised by the money taken, and now held by the LANDLORD
   * (it was paid in person or into their bank). The bank-deposit match keeps
   * it so Undo puts the record back exactly.
   */
  depositRecords: DepositRecordRaised[]
  /** Call once after COMMIT: the receipt email and canceling replaced bank retries. Never throws. */
  afterCommit: () => Promise<void>
}

// ─── The desk quote ─────────────────────────────────────────────────────────

export interface DeskRow {
  id: string
  leaseId: string | null
  invoiceId: string | null
  landlordId: string
  type: string
  entryDescription: string
  revenueOwner: string
  amount: number
  dueDate: string
  createdAt: string
  /** Credit already spent on it (money owes the rest). */
  appliedCredit: number
  unitId: string | null
}

export interface DeskQuote {
  tenantId: string
  landlordId: string
  /** What the desk takes now: the household's bank-payable rows (not the old balance), oldest first. */
  rows: DeskRow[]
  /** The old balance (carried forward): paid last, from whatever is over. */
  carried: DeskRow[]
  /** GAM's charges and another company's on this household's bill: paid online. */
  payOnline: DeskRow[]
  /** Rows on a space in eviction hold: money cannot be taken for them. */
  paused: DeskRow[]
  currentTotal: number
  carriedTotal: number
  payOnlineTotal: number
  pausedTotal: number
  /** Money already on its way (card or bank clearing). */
  inFlightTotal: number
  creditAlreadyApplied: number
  /** "Credit available $X": what credit may pay of the current bill. */
  usableCredit: number
  /**
   * Credit that would pay part of the current bill but is set aside by a bank
   * payment retrying on a bill the desk does not take (a space in eviction
   * hold, rent past a stay's end): not usable here until that retry resolves.
   */
  creditSetAsideElsewhere: number
  /** Every dollar of credit on file with this company. */
  creditOnFile: number
  /** Money owed now if the desk uses the credit. */
  owedIfUsed: number
  /** Money owed now if the desk saves it. */
  owedIfSaved: number
  /** The whole balance the portal shows: current + old balance + pay online. */
  fullBalance: number
  creditPlan: CreditPlanLine[]
  scheduledRetries: ScheduledRetry[]
  retryRowIds: string[]
}

function toDeskRow(r: QuoteRow, unitId: string | null): DeskRow {
  return {
    id: r.id, leaseId: r.leaseId, invoiceId: r.invoiceId, landlordId: r.landlordId,
    type: r.type, entryDescription: r.entryDescription, revenueOwner: r.revenueOwner,
    amount: r.amount, dueDate: r.dueDate, createdAt: r.createdAt, appliedCredit: r.appliedOnRow, unitId,
  }
}

function sortDesk(rows: DeskRow[]): DeskRow[] {
  const byId = new Map(rows.map(r => [r.id, r]))
  return sortForAllocation(rows.map(r => ({
    id: r.id, amount: r.amount, due_date: r.dueDate, type: r.type,
    entry_description: r.entryDescription, created_at: r.createdAt,
  }))).map(x => byId.get(x.id)!)
}

/**
 * What the desk window shows for one household (a person with one company),
 * and what the desk settle takes. Read-only; `lock` inside a write after
 * lockHousehold.
 */
export async function deskQuote(
  client: PoolClient,
  opts: { tenantId: string; landlordId: string; lock?: boolean },
): Promise<DeskQuote> {
  const q = await householdQuote(client, { tenantId: opts.tenantId, landlordId: opts.landlordId, lock: opts.lock })
  const all: QuoteRow[] = [...q.leases.flatMap(l => l.rows), ...q.noLeaseRows]
  const ids = [...new Set(all.map(r => r.id))]
  const units = new Map<string, { unitId: string | null; blocked: boolean }>()
  if (ids.length > 0) {
    const u = await client.query<{ id: string; unit_id: string | null; blocked: boolean }>(
      `SELECT p.id, p.unit_id, COALESCE(un.payment_block, FALSE) AS blocked
         FROM payments p LEFT JOIN units un ON un.id = p.unit_id
        WHERE p.id = ANY($1::uuid[])`, [ids])
    for (const r of u.rows) units.set(r.id, { unitId: r.unit_id, blocked: r.blocked })
  }
  const seen = new Set<string>()
  const rows: DeskRow[] = []
  const carried: DeskRow[] = []
  const payOnline: DeskRow[] = []
  const paused: DeskRow[] = []
  let inFlight = 0
  for (const r of all) {
    if (seen.has(r.id)) continue
    seen.add(r.id)
    const unit = units.get(r.id) ?? { unitId: null, blocked: false }
    const row = toDeskRow(r, unit.unitId)
    // Money already on its way. GAM's FlexPay pull is never counted: FlexPay
    // never appears in the landlord portal (CLAUDE.md, S541).
    if (r.inFlight) { if (r.entryDescription !== 'FLEXPAY') inFlight += toCents(r.amount); continue }
    if (!r.payable || r.pastStayEnd) continue
    if (r.bankPayable && unit.blocked) { paused.push(row); continue }
    if (r.bankPayable && r.carried) { carried.push(row); continue }
    if (r.bankPayable) { rows.push(row); continue }
    if (r.required) payOnline.push(row)
  }
  const deskIds = new Set(rows.map(r => r.id))
  // The household plan counts credit a scheduled bank retry sets aside as
  // free (paying now replaces the retry). The desk replaces only the retries
  // on rows it takes (supersedeScheduledRetry on the current bill and the old
  // balance), so credit a retry holds on any other row — a space in eviction
  // hold, rent past a stay's end — is not the desk's to spend: spending it
  // would take the credit below zero. Each credit's share here is cut to what
  // is free at the desk: what is on it now, plus what replacing those
  // retries gives back. The figure is the same before and after that
  // replacing, so the window and the settle agree. (The portal refuses the
  // same case: rentCharge creditStillHeldElsewhere.)
  const takenIds = [...rows, ...carried].map(r => r.id)
  const releasedHere = new Map<string, number>()
  if (takenIds.length > 0) {
    const h = await client.query<{ credit_id: string; amount: string }>(
      `SELECT COALESCE(u.tenant_credit_id, u.prepaid_credit_id) AS credit_id, SUM(u.amount)::text AS amount
         FROM credit_uses u
        WHERE u.status = 'held'
          AND (u.payment_id = ANY($1::uuid[])
               OR u.remittance_id IN (
                    SELECT r.id FROM tenant_remittances r
                     WHERE r.stripe_payment_intent_id IN (
                       SELECT p.stripe_payment_intent_id FROM payments p
                        WHERE p.id = ANY($1::uuid[]) AND p.status = 'failed' AND p.stripe_payment_intent_id IS NOT NULL
                          AND (p.next_retry_at IS NOT NULL
                               OR EXISTS (SELECT 1 FROM credit_uses u2 WHERE u2.payment_id = p.id AND u2.status = 'held')))))
        GROUP BY 1`, [takenIds])
    for (const x of h.rows) releasedHere.set(x.credit_id, toCents(x.amount))
  }
  // Never more than the credit's own free figure (a dispute's claim already
  // came off it, remaining first).
  const free = new Map<string, number>(q.credits.map(c => [c.id,
    toCents(c.amountRemaining) + Math.min(releasedHere.get(c.id) ?? 0, toCents(c.releasable))]))
  const creditPlan: CreditPlanLine[] = []
  let setAside = 0
  // Plan lines run oldest bill first per credit, so a cut comes off the newest.
  for (const l of q.plan) {
    if (!deskIds.has(l.paymentId)) continue
    const want = toCents(l.amount)
    const left = free.get(l.creditId) ?? 0
    const take = Math.min(want, left)
    free.set(l.creditId, left - take)
    setAside += want - take
    if (take > 0) creditPlan.push(take === want ? l : { ...l, amount: toDollars(take) })
  }
  const sum = (xs: DeskRow[]) => xs.reduce((s, r) => s + toCents(r.amount), 0)
  const applied = rows.reduce((s, r) => s + toCents(r.appliedCredit), 0)
  const usable = creditPlan.reduce((s, l) => s + toCents(l.amount), 0)
  const current = sum(rows)
  const allRows = [...rows, ...carried]
  return {
    tenantId: opts.tenantId,
    landlordId: opts.landlordId,
    rows: sortDesk(rows),
    carried: sortDesk(carried),
    payOnline: sortDesk(payOnline),
    paused: sortDesk(paused),
    currentTotal: toDollars(current),
    carriedTotal: toDollars(sum(carried)),
    payOnlineTotal: toDollars(sum(payOnline)),
    pausedTotal: toDollars(sum(paused)),
    inFlightTotal: toDollars(inFlight),
    creditAlreadyApplied: toDollars(applied),
    usableCredit: toDollars(usable),
    creditSetAsideElsewhere: toDollars(setAside),
    creditOnFile: q.totals.creditOnFile,
    owedIfUsed: toDollars(Math.max(0, current - applied - usable)),
    owedIfSaved: toDollars(Math.max(0, current - applied)),
    fullBalance: toDollars(current + sum(carried) + sum(payOnline)),
    creditPlan,
    scheduledRetries: q.leases.flatMap(l => l.scheduledRetries),
    retryRowIds: allRows.filter(r => all.some(x => x.id === r.id && (x.retryScheduled || x.heldOnRow > 0))).map(r => r.id),
  }
}

// ─── The settle ─────────────────────────────────────────────────────────────

/**
 * 10/4 (decisions #46.3): a security deposit taken outside Stripe — cash, a
 * check or a money order at the desk, the landlord agent's cash payment, a
 * posted receipt, a bank-deposit match — raises its deposit record and is
 * recorded as held by the landlord (leaseFeesSync.reconcileSettledDepositPayment,
 * the same call the Stripe webhook makes). Before this only the webhook (and
 * the bank match, for a landlord-held record) raised it: a deposit paid at the
 * desk left the record at $0, so the move-out counted nothing and the tenant
 * was refunded nothing. Pet, key and cleaning deposits have no record; who
 * holds them is read off their own payment at move-out. Inside the caller's
 * transaction, for the rows it just settled.
 */
async function recordDepositsCollected(client: PoolClient, settledIds: readonly string[]): Promise<DepositRecordRaised[]> {
  if (settledIds.length === 0) return []
  // Fix pass 2 (review): a reopened deposit charge of a finalized move-out,
  // paid again here, is no deposit held for the tenancy: resolveReopenedPaidAgain
  // (run first) stamped it as that move-out's money, refilling what a dispute
  // took. It never raises or re-points the closed move-out's deposit record
  // (its held_by stays as the move-out left it).
  const rows = (await client.query<{ id: string }>(
    `SELECT p.id FROM payments p
      WHERE p.id = ANY($1::uuid[]) AND p.type = 'deposit' AND p.lease_fee_id IS NULL AND p.status = 'settled'
        AND p.released_by_deposit_return_id IS NULL
      ORDER BY p.id`, [[...settledIds]])).rows
  const out: DepositRecordRaised[] = []
  for (const r of rows) {
    const raised = await reconcileSettledDepositPayment(r.id, client)
    if (raised) out.push(raised)
  }
  return out
}

/**
 * Fix pass (rev8, decisions #54 / S512 "GAM never absorbs"): a charge a
 * dispute or bank return reopened (payments.reversal_id), paid again here in
 * cash, a check or a money order — every manual path (the desk, a posted
 * payment, the bank-deposit match, the landlord assistant) comes through
 * settleManualRentPayment. The landlord holds that money, so the reversal is
 * resolved as theirs (resolveReversalOnTenantPayment, landlordHoldsCash):
 * for a reopened move-out deposit charge the part that refills what the
 * dispute took from GAM comes off their next payout, and the kept share they
 * gave back stays theirs out of the cash — never paid to them twice, never
 * GAM's loss; for any other reopened charge the landlord's recovery stands.
 * Only rows money from the drawer paid (a row account credit paid in full
 * carries no manual method). Inside the settle's transaction, under the
 * household lock.
 */
async function resolveReopenedPaidAgain(client: PoolClient, settledIds: readonly string[]): Promise<void> {
  if (settledIds.length === 0) return
  const recs = (await client.query<{ reversal_id: string }>(
    `SELECT DISTINCT p.reversal_id::text AS reversal_id FROM payments p
      WHERE p.id = ANY($1::uuid[]) AND p.reversal_id IS NOT NULL AND p.status = 'settled' AND p.manual_method IS NOT NULL
      ORDER BY 1`, [[...settledIds]])).rows
  if (recs.length === 0) return
  const { resolveReversalOnTenantPayment } = await import('./paymentReversal')
  for (const r of recs) await resolveReversalOnTenantPayment(client, r.reversal_id, { landlordHoldsCash: true })
}

export async function settleManualRentPayment(
  client: PoolClient, input: ManualSettleInput,
): Promise<ManualSettleResult> {
  const household = input.settleWholeBalance === true || input.settleHousehold === true
  return household ? settleHousehold(client, input) : settleOneRow(client, input)
}

/**
 * I8 for a row settled outside Stripe: cash, checks, money orders and bank
 * deposits are the landlord's already, so a row is never GAM's to pay out —
 * except the part GAM-held credit paid (paid-ahead money that came through
 * Stripe, deposit interest). A security deposit or a prepaid box taken this
 * way is the landlord's to hold (only landlord-owned rent, utilities and fees
 * can carry GAM-held credit at all). Read before the row is settled; the
 * credit part does not depend on the row's status.
 */
const OFF_PLATFORM_PLATFORM_HELD_SQL = `
  CASE WHEN p.revenue_owner = 'landlord' AND p.type <> 'deposit'
       THEN COALESCE((SELECT vm.gam_held_part > 0 FROM v_payment_money vm WHERE vm.payment_id = p.id), FALSE)
       ELSE FALSE END`

/**
 * GAM-held credit on a row settled outside Stripe: the landlord's share rides
 * the Tuesday payout, with no second processing fee. A failure refuses the
 * whole settle with the next step said plainly.
 */
async function bookGamHeldOwnerShare(client: PoolClient, settledIds: readonly string[], nextStep: string): Promise<void> {
  if (settledIds.length === 0) return
  const held = await client.query<{ payment_id: string; type: string; revenue_owner: string; unit_id: string | null }>(
    `SELECT vm.payment_id, p.type, p.revenue_owner, p.unit_id
       FROM v_payment_money vm JOIN payments p ON p.id = vm.payment_id
      WHERE vm.payment_id = ANY($1::uuid[]) AND vm.gam_held_part > 0
      ORDER BY vm.payment_id`, [[...settledIds]])
  for (const h of held.rows) {
    if (!(ALLOCATABLE_PAYMENT_TYPES as readonly string[]).includes(h.type) || h.revenue_owner !== 'landlord' || !h.unit_id) continue
    try {
      await executeRentAllocation(client, h.payment_id, 'ach', { feeAlreadyCollected: true })
    } catch (e) {
      logger.error({ err: e, paymentId: h.payment_id }, '[desk] GAM-held credit could not be booked to the landlord payout')
      throw new AppError(409,
        'Part of this credit came through GAM and could not be added to the landlord\'s payout right now, so nothing was recorded. ' +
        nextStep)
    }
  }
}

/**
 * The bank-deposit match: the named row only, as money the landlord took. No
 * credit is spent (a deposit is new money, bug 2), no receipt (the match writes
 * its own), no surplus.
 *
 * Like every other settle (§3): only a row still payable is taken (a row
 * whose money is already on its way is left alone) and the count is checked;
 * a bank retry scheduled on the row is replaced first — its held credit given
 * back, its schedule cleared on every row of that pull — and the old pull is
 * canceled in afterCommit(), which the caller runs after its COMMIT. The
 * caller holds the household lock (lockHousehold) before locking the row.
 */
async function settleOneRow(client: PoolClient, input: ManualSettleInput): Promise<ManualSettleResult> {
  const { payment, method } = input
  const refNote = input.reference ? ` (ref ${input.reference})` : ''
  const provenance = input.provenance ? ` — ${input.provenance}` : ''
  const superseded = await supersedeScheduledRetry(client, [payment.id])
  const settled = await client.query<{ id: string; amount: string }>(
    `UPDATE payments p
        SET status = 'settled', settled_at = COALESCE($2::timestamptz, NOW()),
            manual_method = $3, platform_held = ${OFF_PLATFORM_PLATFORM_HELD_SQL}, next_retry_at = NULL,
            notes = COALESCE(p.notes || ' — ', '') || $4
      WHERE p.id = $1 AND ${payableRowSql('p')}
     RETURNING p.id, p.amount::text`,
    [payment.id, input.settledAt, method, `Recorded as manual ${method} payment${refNote}${provenance}`])
  if (settled.rows.length !== 1) {
    throw new AppError(409,
      'This charge is no longer open to settle — it was paid, or a payment for it is already on its way. Nothing was recorded; look at it again.')
  }
  const ids = settled.rows.map(r => r.id)
  await resolveReopenedPaidAgain(client, ids)
  await bookGamHeldOwnerShare(client, ids, 'Let GAM support know.')
  const depositRecords = await recordDepositsCollected(client, ids)
  await afterRowsSettled(client, ids, {
    attestationSource: 'landlord_self_reported_with_evidence',
    attestationEvidence: { manual_method: method, reference: input.reference ?? null },
    receipt: null,
  })
  let done = false
  return {
    settledPaymentIds: ids,
    amountSettled: toDollars(settled.rows.reduce((s, r) => s + toCents(r.amount), 0)),
    creditUsed: 0, surplus: 0, changeGiven: 0, towardOldBalance: 0,
    creditId: null, receiptId: null, depositRecords,
    afterCommit: async () => {
      if (done) return
      done = true
      await cancelSupersededIntents(superseded.cancelAfterCommit)
    },
  }
}

async function settleHousehold(client: PoolClient, input: ManualSettleInput): Promise<ManualSettleResult> {
  const { payment, method } = input
  if (!payment.tenant_id) {
    throw new AppError(409, 'This charge has no resident on it, so there is no balance to take a payment against.')
  }
  const tenantId = payment.tenant_id
  const landlordId = payment.landlord_id
  if (input.amountTendered == null) {
    throw new AppError(422, 'Enter the amount handed over.')
  }
  const tendered = toCents(input.amountTendered)
  if (tendered < 0) throw new AppError(422, 'The amount handed over cannot be below zero.')

  await lockHousehold(client, tenantId, landlordId)
  // Paying at the desk over a scheduled bank retry replaces that retry: its
  // held credit comes back first and the pull is canceled after commit.
  const before = await deskQuote(client, { tenantId, landlordId, lock: true })
  let cancelAfterCommit: string[] = []
  if (before.retryRowIds.length > 0) {
    cancelAfterCommit = (await supersedeScheduledRetry(client, before.retryRowIds)).cancelAfterCommit
  }
  const q = before.retryRowIds.length > 0 ? await deskQuote(client, { tenantId, landlordId, lock: true }) : before

  if (q.rows.length === 0 && q.carried.length === 0) {
    if (q.paused.length > 0) {
      throw new AppError(409, 'This space is in eviction mode — recording a payment is paused. Contact the landlord.')
    }
    if (q.payOnline.length > 0) {
      throw new AppError(409, `Everything open here ($${q.payOnlineTotal.toFixed(2)}) is paid online, not at the desk.`)
    }
    throw new AppError(409, 'Nothing is owed here right now.')
  }

  // ── The credit choice ───────────────────────────────────────────────────
  const usable = toCents(q.usableCredit)
  let useCredit = false
  if (!input.neverUseCredit) {
    if (usable > 0) {
      if (input.creditToUse == null) {
        throw new AppError(422,
          `This account has ${money(usable)} of credit that can pay part of this bill. Choose Use ${money(usable)} or Save before recording.`)
      }
      const chosen = toCents(input.creditToUse)
      if (chosen !== 0 && chosen !== usable) {
        throw new AppError(409, `The credit available changed — it's now ${money(usable)}. Look at the bill again and choose Use or Save.`)
      }
      useCredit = chosen === usable
    } else if (input.creditToUse != null && toCents(input.creditToUse) > 0) {
      throw new AppError(409, 'The credit available changed — it is now $0.00. Look at the bill again.')
    }
  }

  // ── The money ───────────────────────────────────────────────────────────
  const planned = new Map<string, number>()
  if (useCredit) for (const l of q.creditPlan) planned.set(l.paymentId, (planned.get(l.paymentId) ?? 0) + toCents(l.amount))
  const creditUsed = useCredit ? usable : 0
  const lines: { paymentId: string; cents: number }[] = []
  let owed = 0
  for (const r of q.rows) {
    const m = Math.max(0, toCents(r.amount) - toCents(r.appliedCredit) - (planned.get(r.id) ?? 0))
    owed += m
    if (m > 0) lines.push({ paymentId: r.id, cents: m })
  }
  // Rent is pay-in-full platform-wide — a partial can reset a landlord's
  // eviction clock (standing directive).
  if (tendered < owed) {
    throw new AppError(422,
      `That is ${money(owed - tendered)} short — ${money(tendered)} against ${money(owed)} owed. Rent is paid in full.`)
  }
  const over = tendered - owed
  const carriedOwed = q.carried.reduce((s, r) => s + toCents(r.amount) - toCents(r.appliedCredit), 0)
  const isCash = method === 'cash'

  // Toward the old balance (decisions: the desk treats carried arrears like
  // the portal — paid last, from whatever is over the current bill). Money
  // that STAYS — a check or money order's extra, or cash the desk keeps
  // ("Keep as credit — no change on hand") — pays the old balance first, and
  // only what is left becomes paid-ahead money: credit never sits beside an
  // open old balance it could have paid. Cash handed back as change was never
  // over, so it goes there only when the desk says how much (or when nothing
  // else is owed — the old balance is then the only thing it can be for).
  const keepsMoney = !isCash || input.surplusHandling === 'credit'
  const oldFirst = Math.min(over, carriedOwed)
  let towardOld: number
  if (input.towardOldBalance != null) {
    towardOld = toCents(input.towardOldBalance)
    if (towardOld < 0) throw new AppError(422, 'The old-balance amount cannot be below zero.')
    if (towardOld > oldFirst) {
      throw new AppError(422, carriedOwed === 0
        ? 'There is no old balance to put money toward.'
        : `At most ${money(oldFirst)} can go toward the old balance.`)
    }
    if (keepsMoney && towardOld < oldFirst) {
      throw new AppError(422,
        `Money kept on the account pays the old balance first: ${money(oldFirst)} of the ${money(over)} over the bill goes to the ` +
        `${money(carriedOwed)} old balance${over > oldFirst ? ` and ${money(over - oldFirst)} is kept as credit` : ''}. ` +
        `Leave the old-balance amount out${isCash ? ', or give the rest back as change' : ''}.`)
    }
  } else if (keepsMoney || (owed === 0 && creditUsed === 0)) {
    towardOld = oldFirst
  } else {
    towardOld = 0
  }
  const surplus = over - towardOld

  // S648 (Nic): only cash gets change — "They can't write a check for a
  // hundred dollars over the rent and use it like an ATM."
  if (surplus > 0 && !isCash && input.surplusHandling === 'change') {
    throw new AppError(422,
      `No change can be given on a ${methodWord(method)}. The ${money(surplus)} over the balance stays on their account as credit.`)
  }
  // S637 (Nic): "it needs to be manually clicked by the person taking the
  // cash. That way no mistakes could happen." Refused, never guessed. Keeping
  // it is said as what it does: the old balance first, then credit.
  if (surplus > 0 && isCash && input.surplusHandling !== 'change' && input.surplusHandling !== 'credit') {
    const keepOld = Math.min(over, carriedOwed)
    const keep = keepOld > 0
      ? `"Keep it — no change on hand" (${money(keepOld)} pays the old balance first` +
        `${over > keepOld ? `, ${money(over - keepOld)} kept as credit` : ''})`
      : `"Keep ${money(surplus)} as credit"`
    throw new AppError(422,
      `That is ${money(surplus)} over the ${money(owed + towardOld)} being paid. Choose "Give ${money(surplus)} change" or ${keep}.`)
  }
  const keepAsCredit = surplus > 0 && keepsMoney
  if (keepAsCredit && creditUsed > 0) {
    const afterOld = towardOld > 0 ? ` left after ${money(towardOld)} to the old balance` : ''
    throw new AppError(422, isCash
      ? `Credit is being used on this bill, so the ${money(surplus)} extra${afterOld} can only be handed back as change.`
      : `Credit is being used on this bill and the ${methodWord(method)} is ${money(surplus)} over it${afterOld}. Save the credit instead.`)
  }

  // Something has to be paid: with no current bill and nothing going to the
  // old balance, the desk would be told "recorded" for nothing (probe P7).
  if (q.rows.length === 0 && towardOld === 0) {
    throw new AppError(422, tendered === 0
      ? 'Enter the amount handed over — only the old balance is open here, and it is paid with money.'
      : 'Nothing would be paid — only the old balance is open here and none of this money is going to it. ' +
        'Put the amount toward the old balance, or record nothing.')
  }

  // Extra money kept on the account sits on a lease here. Looked up (read
  // only) before the written-amount question and before anything is written,
  // so a resident with no lease here — a moved-out resident paying a final
  // bill with a check over it — is refused once, never asked to confirm the
  // amount first, and nothing (not even an old-balance split) is written.
  const creditLease = keepAsCredit ? await leaseForCredit(client, input, tenantId, landlordId) : null
  if (keepAsCredit && !creditLease) {
    throw new AppError(409, isCash
      ? 'This resident has no lease here to hold a credit on. Hand the difference back as change.'
      : 'This resident has no lease here to hold a credit on, so a check over the bill cannot be taken.')
  }

  // A check or money order written over the bill: confirm the written amount
  // before any of it goes anywhere (a typed round-up becomes a stray credit).
  // Asked last, once every other refusal above has had its say, so the desk
  // never confirms an amount and is then refused for something else (credit
  // used with a check over the bill is "Save the credit instead"; no lease to
  // hold the extra is "cannot be taken" — each said once). The question
  // names what the money is paying: the current bill, the old balance a
  // check's extra goes to first, or both — never "$0.00 owed" while an old
  // balance is open (verify r2).
  if (!isCash && over > 0 && input.confirmWrittenAmount !== true) {
    const against = carriedOwed === 0
      ? `against ${money(owed)} owed`
      : owed === 0
        ? `toward the ${money(carriedOwed)} old balance`
        : `against the ${money(owed)} bill and a ${money(carriedOwed)} old balance`
    throw new AppError(422,
      `You typed ${money(tendered)} ${against} — is the ${methodWord(method)} really ${money(tendered)}? ` +
      `Check the amount written on it, then confirm.`)
  }
  const changeGiven = surplus > 0 && !keepAsCredit ? surplus : 0
  const kept = tendered - changeGiven   // what went in the drawer

  // ── Write ───────────────────────────────────────────────────────────────
  const refNote = input.reference ? ` (ref ${input.reference})` : ''
  const provenance = input.provenance ? ` — ${input.provenance}` : ''
  const note = `Recorded as manual ${method} payment${refNote}${provenance}`

  // The old balance, oldest first; only the last row it reaches may be paid in part.
  const carriedPaid: string[] = []
  let leftOld = towardOld
  for (const r of q.carried) {
    if (leftOld <= 0) break
    const rowOwed = toCents(r.amount) - toCents(r.appliedCredit)
    if (rowOwed <= 0) continue
    const take = Math.min(leftOld, rowOwed)
    if (take < rowOwed) {
      await client.query(
        `UPDATE payments SET amount = $2::numeric,
                notes = COALESCE(notes || ' — ', '') || 'partly paid toward the old balance; $' || $3 || ' remains on a separate row'
          WHERE id = $1`,
        [r.id, toDollars(take).toFixed(2), toDollars(rowOwed - take).toFixed(2)])
      await client.query(
        `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, invoice_id,
                               type, amount, status, due_date, entry_description, notes, is_remainder, revenue_owner)
         SELECT unit_id, lease_id, tenant_id, landlord_id, invoice_id,
                type, $2::numeric, 'pending', due_date, entry_description,
                'What is left of the old balance after a part payment', TRUE, revenue_owner
           FROM payments WHERE id = $1`,
        [r.id, toDollars(rowOwed - take).toFixed(2)])
    }
    carriedPaid.push(r.id)
    lines.push({ paymentId: r.id, cents: take })
    leftOld -= take
  }

  // The receipt first, when money went in the drawer, so credit spent beside
  // that money is linked to it: a receipt's credit used is the sum of its uses
  // (plan §1.1; GET /payments/remittances reads it that way). A credit-only
  // settle writes no receipt and its uses stand alone.
  let receiptId: string | null = null
  let creditId: string | null = null
  const amountSettled = lines.reduce((s, l) => s + l.cents, 0)
  if (kept > 0) {
    // The receipt says what was handed over and what became of any extra —
    // the old balance it paid, change, or credit: the desk's own answer, never
    // a default (S637; harland-credits 10/3).
    const oldPart = towardOld > 0 ? `; ${money(towardOld)} went to the old balance` : ''
    const handedOver = isCash
      ? `Handed over ${money(tendered)}`
      : `Handed over a ${methodWord(method)} for ${money(tendered)} (amount confirmed)`
    const handed = changeGiven > 0
      ? `Handed over ${money(tendered)}${oldPart}; ${money(changeGiven)} given back as change.`
      : keepAsCredit && isCash
        ? `Handed over ${money(tendered)}${oldPart}; ${towardOld > 0 ? 'the other ' : ''}${money(surplus)} kept as credit — no change on hand.`
        : keepAsCredit
          ? `${handedOver}${oldPart}; ${towardOld > 0 ? `the other ${money(surplus)}` : `${money(surplus)} over the bill`} kept as credit.`
          : towardOld > 0 && over > 0
            ? `${handedOver}${oldPart}.`
            : null
    const rem = await client.query<{ id: string }>(
      `INSERT INTO tenant_remittances
         (tenant_id, lease_id, landlord_id, amount, applied_amount, unapplied_amount, status,
          payment_method, gross_amount, processing_fee_amount, settled_at, reference, notes, received_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'settled', $7, NULL, 0, COALESCE($8::timestamptz, NOW()), $9, $10, $11)
       RETURNING id`,
      [tenantId, creditLease ?? payment.lease_id, landlordId, toDollars(kept).toFixed(2),
       toDollars(amountSettled).toFixed(2), toDollars(keepAsCredit ? surplus : 0).toFixed(2),
       method, input.settledAt, input.reference || null,
       [input.notes, handed].filter(Boolean).join(' ') || null, input.takenBy ?? null])
    receiptId = rem.rows[0].id
    // 10/5 (Nic): "money movement is the end of onboarding" — cash, a check or
    // a money order taken at the desk ends the free onboarding window, even
    // when all of it is kept as credit and no bill settles.
    await activateBillingForMoneyMoved(client, [landlordId])
  }

  // Credit next (applied: the money is already here), then the rows.
  if (useCredit && q.creditPlan.length > 0) {
    await applyCredit(client, q.creditPlan, {
      source: input.source ?? 'desk', createdBy: input.takenBy ?? null, remittanceId: receiptId,
    })
  }
  const toSettle = [...q.rows.map(r => r.id), ...carriedPaid]
  // A row the account credit paid in full carries no money from the drawer:
  // its note says what paid it, never "Recorded as manual cash payment".
  const moneyRows = new Set(lines.filter(l => l.cents > 0).map(l => l.paymentId))
  const creditOnlyRows = toSettle.filter(id => !moneyRows.has(id))
  const settled = await client.query<{ id: string }>(
    `UPDATE payments p
        SET status = 'settled', settled_at = COALESCE($2::timestamptz, NOW()),
            -- What the drawer paid is written down as the method. A row the
            -- account credit paid in full took nothing from the drawer: it
            -- carries no method, so it is never counted as cash collected and
            -- not banked (cashBankingControl) or shown "Paid by Cash".
            manual_method = CASE WHEN p.id = ANY($5::uuid[]) THEN NULL ELSE $3 END,
            next_retry_at = NULL,
            -- I8: only what GAM holds pays out — the part GAM-held credit paid.
            platform_held = ${OFF_PLATFORM_PLATFORM_HELD_SQL},
            notes = COALESCE(p.notes || ' — ', '') ||
                    CASE WHEN p.id = ANY($5::uuid[]) THEN 'Paid with account credit (recorded at the desk)' ELSE $4 END
      WHERE p.id = ANY($1::uuid[]) AND ${payableRowSql('p')}
     RETURNING p.id`,
    [toSettle, input.settledAt, method, note, creditOnlyRows])
  if (settled.rows.length !== toSettle.length) {
    throw new AppError(409, 'Part of this balance changed while it was being recorded. Nothing was recorded — look at the bill again.')
  }
  const settledIds = settled.rows.map(r => r.id).sort()
  await resolveReopenedPaidAgain(client, settledIds)

  // GAM-held credit on a desk row: the landlord's share rides the Tuesday
  // payout, with no second processing fee. The settle rolls back whole on a
  // failure; the desk is told plainly what to do next.
  await bookGamHeldOwnerShare(client, settledIds, 'Choose Save to take the payment without the credit, and let GAM support know.')
  const depositRecords = await recordDepositsCollected(client, settledIds)

  // Where each dollar of the drawer's money landed, and what it banked.
  if (receiptId) {
    for (const l of lines) {
      if (l.cents <= 0) continue
      await client.query(
        `INSERT INTO remittance_applications (remittance_id, payment_id, amount_applied) VALUES ($1, $2, $3)`,
        [receiptId, l.paymentId, toDollars(l.cents).toFixed(2)])
    }
    if (keepAsCredit && creditLease) {
      creditId = await createPaidAhead(client, {
        leaseId: creditLease, tenantId, amount: toDollars(surplus), fundedBy: 'landlord',
        receivedAt: input.settledAt ?? new Date(), sourceRemittanceId: receiptId,
        note: `Paid ahead at the desk (${methodWord(method)}${refNote})`,
      })
    }
  }

  const after = await afterRowsSettled(client, settledIds, {
    attestationSource: 'landlord_self_reported_with_evidence',
    attestationEvidence: { manual_method: method, reference: input.reference ?? null },
    receipt: input.sendReceipt === false ? null : {
      method: kept === 0 ? 'your account credit'
        : changeGiven > 0 ? `${methodWord(method)} (change given ${money(changeGiven)})`
        : keepAsCredit && isCash ? `${methodWord(method)} (${money(surplus)} kept as credit — no change on hand)`
        : methodWord(method),
      reference: input.reference ?? null,
      creditBanked: keepAsCredit ? toDollars(surplus) : 0,
    },
  })

  let done = false
  return {
    settledPaymentIds: settledIds,
    amountSettled: toDollars(amountSettled),
    creditUsed: toDollars(creditUsed),
    surplus: toDollars(surplus),
    changeGiven: toDollars(changeGiven),
    towardOldBalance: toDollars(towardOld),
    creditId,
    receiptId,
    depositRecords,
    afterCommit: async () => {
      if (done) return
      done = true
      await after.afterCommit()
      await cancelSupersededIntents(cancelAfterCommit)
    },
  }
}

/** The lease paid-ahead money sits on: the one asked for, the opened charge's, else the newest active one. */
async function leaseForCredit(client: PoolClient, input: ManualSettleInput, tenantId: string, landlordId: string): Promise<string | null> {
  const r = await client.query<{ id: string }>(
    `SELECT l.id FROM leases l
      WHERE l.landlord_id = $2
        AND l.status IN ('active','pending')
        AND EXISTS (SELECT 1 FROM lease_tenants lt WHERE lt.lease_id = l.id AND lt.tenant_id = $1
                       AND lt.status IN ('active','pending_add','pending_remove'))
      ORDER BY COALESCE(l.id = $3::uuid, FALSE) DESC, COALESCE(l.id = $4::uuid, FALSE) DESC, (l.status = 'active') DESC, l.start_date DESC, l.id
      LIMIT 1`,
    [tenantId, landlordId, input.creditLeaseId ?? null, input.payment.lease_id ?? null])
  return r.rows[0]?.id ?? null
}

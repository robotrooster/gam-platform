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
//
// 10/14 (Nic) — EACH BILL IS PAID ON ITS OWN: "we also need to be able to log
// each separate bill as one payment ... the only thing I wanted paid together
// was the itemized lines of that invoice. It couldn't settle separately, but
// each separate invoice is its own thing." Billy Miranda (Oak Park, RV 34 and
// RV 35, two leases): Tyler could not log his cash against RV 34 alone. The
// desk now PICKS the bills the money pays (billIds; nothing is picked for it):
//   - A BILL is one invoice — every line on it the desk takes, paid together
//     and whole (a charge on no invoice is a bill by itself);
//   - within ONE space the oldest bill is paid first: a bill can be picked
//     only with every older open bill of that space ("October waits for
//     September"); different spaces are independent (Nic 10/13: two spaces on
//     two leases are two households);
//   - everything above applies to the picked bills exactly as it applied to
//     the whole balance: pay in full unless the property takes part payments,
//     Use or Save, change or credit, the receipt, late fees judged bill by
//     bill, every guard. Credit pays only the picked bills (the plan is built
//     over them, creditUse householdQuote planOnly).
// No bills named (the landlord assistant, a posted payment): every bill, the
// whole balance, as before.

import type { PoolClient } from 'pg'
import type { ManualPaymentMethod } from '@gam/shared'
import {
  sortForAllocation, MANUAL_PAYMENT_METHOD_WORD, lateFeeCreditedTenantText, BANK_DEPOSIT_METHOD_NOT_TAKEN,
  PART_PAYABLE_TYPES, placePartPayment, paidAheadGoesOn,
} from '@gam/shared'
import type { ReportClosedByRecording } from '../jobs/declaredDepositExpiry'
import { AppError } from '../middleware/errorHandler'
import { lockHousehold, payableRowSql } from './moneyPredicates'
import {
  householdQuote, supersedeScheduledRetry, applyCredit, createPaidAhead, cancelSupersededIntents,
  type CreditPlanLine, type QuoteRow, type ScheduledRetry,
} from './creditUse'
import { executeRentAllocation, ALLOCATABLE_PAYMENT_TYPES } from './allocation'
import { afterRowsSettled } from './settleHooks'
import { reconcileSettledDepositPayment, stampDepositCollectedBy, type DepositRecordRaised } from './leaseFeesSync'
import { logger } from '../lib/logger'
import { activateBillingForMoneyMoved } from './billingActivation'
import { PART_PAYMENT_REST_NOTE } from './creditLedgerEmitters'
import type { CreditedLateFee } from './lateFeeCredit'

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
const methodWord = (m: ManualPaymentMethod) => MANUAL_PAYMENT_METHOD_WORD[m]

// 10/5 (Nic): the note on the rest of a bill a part payment did not cover
// (creditLedgerEmitters, which reads it to count the rest from its bill).
export { PART_PAYMENT_REST_NOTE }

/**
 * 10/5 (Nic): the kinds of charge a part payment may leave partly paid (rent
 * only) — one definition, in @gam/shared beside placePartPayment, so the
 * Record payment window places money exactly as the settle does.
 */
export { PART_PAYABLE_TYPES }

/** 10/5 (Nic): a bank deposit is told apart by the reference on the bank's receipt. */
export const BANK_DEPOSIT_REFERENCE_REQUIRED =
  'Enter the deposit reference number from the bank\'s receipt — it tells this deposit apart from anyone else\'s for the same amount.'

/**
 * 10/6 (Nic): "Do you allow tenants to go into the bank and deposit their rent
 * for this unit or for this property? We don't do that here at Mountain
 * View." Does the property of this space (or lease) take rent its tenants
 * deposit at the landlord's bank (properties.tenants_deposit_at_bank)? False
 * when the space or its property is unknown.
 */
export async function tenantsDepositAtBank(
  runner: Pick<PoolClient, 'query'>, at: { unitId?: string | null; leaseId?: string | null },
): Promise<boolean> {
  const r = await runner.query<{ ok: boolean }>(
    `SELECT COALESCE(pr.tenants_deposit_at_bank, FALSE) AS ok
       FROM units u JOIN properties pr ON pr.id = u.property_id
      WHERE u.id = COALESCE($1::uuid, (SELECT l.unit_id FROM leases l WHERE l.id = $2::uuid))`,
    [at.unitId ?? null, at.leaseId ?? null])
  return r.rows[0]?.ok === true
}

/** 10/6: refuse a recorded "Bank deposit" where the property does not take them, in plain words. */
export async function assertBankDepositTaken(
  runner: Pick<PoolClient, 'query'>, at: { unitId?: string | null; leaseId?: string | null },
): Promise<void> {
  if (!(await tenantsDepositAtBank(runner, at))) throw new AppError(409, BANK_DEPOSIT_METHOD_NOT_TAKEN)
}

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
  /**
   * 10/14 (Nic): "each separate invoice is its own thing" — the bills (DeskBill
   * ids) this money pays, picked at the desk. Within a space every older open
   * bill must be picked too. Absent: every bill (the whole balance).
   */
  billIds?: readonly string[] | null
  /**
   * 10/15 (Nic): the device this was typed on, kept with the receipt so "who
   * recorded this" is answerable later. GAM's own receipts pass nothing.
   */
  takenFrom?: { ip?: string | null; device?: string | null } | null
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
  /** 10/6: where a late-fee delete was chosen, for its audit record. Default Record payment. */
  lateFeeDeleteVia?: 'record_payment' | 'post_payment'
  /**
   * 10/5 (Nic): a BANK DEPOSIT's date, from the bank's receipt (YYYY-MM-DD,
   * not after today — the caller checks). When the deposit pays the bill in
   * full, late fees charged for days after it come off exactly as a tenant's
   * corroborated report takes them off (bankDepositConfirm.reverseLateFees):
   * 10/6 (Nic) — unpaid ones are CREDITED (the fee stays, a late-fee credit
   * nets it out, and the payment still counts late), ones already paid come
   * back as a late-fee refund credit. A bill paid only in part keeps its late
   * fees, owed.
   */
  depositedOn?: string | null
  /**
   * 10/6 (Nic): "the late fee is only available to be completely deleted
   * during the onboarding month." The box on Record payment / Post a payment
   * ("Delete the late fee completely (onboarding month)", off by default): an
   * unpaid late fee this bank deposit takes off an ONBOARDING bill is deleted
   * outright, with no credit (services/lateFeeDelete), and nothing shows on
   * the tenant's record. Any other bill's fee is credited. The caller has
   * checked who may (canDeleteLateFees).
   */
  deleteOnboardingLateFees?: boolean
  /**
   * 10/6 (Nic, "Yes, build it"): the bank-deposit match (row scope) — a bank
   * line matched to the bill, so the payment-history mark counts from the
   * bank's day (settleHooks bankValidated), on time if it was on time.
   */
  bankValidated?: boolean
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
  /**
   * 10/5 (Nic): a part payment — what is still owed on the bill the desk took
   * (0 when it was paid in full), and the open rows that owe it: the rest of a
   * rent bill paid in part, and any bill the money did not reach.
   */
  stillOwed: number
  /**
   * 10/6 (Nic): money a part payment could not place that goes on the rest of
   * what they owe by itself right after the commit (money paid ahead, drawn by
   * the route's whole-bill check). Already taken out of `stillOwed`; its rows
   * in `stillOwedRows` still show what they owe before it lands.
   */
  leftoverOnBalance: number
  stillOwedRows: StillOwedRow[]
  /** Rows this settle paid in part (each has a rest row among stillOwedRows). */
  partPaidIds: string[]
  /**
   * 10/5 (Nic): late fees taken off because a bank deposit dated before them
   * paid the bill in full — 10/6: credited (unpaid; `unbilled` is what the
   * late-fee credits netted out) and refunded as credit (already paid). Zero
   * when nothing came off.
   */
  lateFeesReversed: { unbilled: number; refunded: number; refundCreditIds: string[] }
  /** 10/6 (Nic): late fees deleted outright from onboarding bills (the box), and what they were. */
  lateFeesDeleted: { count: number; amount: number }
  /**
   * 10/6 (Nic): the box was ticked but a late fee could not be deleted (most
   * often money is recorded against it) — each reason in plain words, once.
   * That fee was credited instead (or, when it could not be, is still owed —
   * the reason says which). Empty when nothing was refused.
   */
  lateFeeDeleteRefusals: string[]
  /**
   * 10/6 (Nic): a bill a late fee came off of (credited, refunded, or deleted
   * by the box) still has a late fee on it afterwards, so that bill's payment
   * counts LATE on the tenant's history, from the day it was recorded — no
   * exceptions (services/settleHooks). Read from what is left, not from what
   * was done. Both sides are told so.
   */
  lateFeeCountsLate: boolean
  /**
   * 10/6: the box deleted a late fee from a bill that still has another late
   * fee on it — "nothing shows on their record" would be false there.
   */
  lateFeeDeletedStillLate: boolean
  /** Call once after COMMIT: the receipt email and canceling replaced bank retries. Never throws. */
  afterCommit: () => Promise<void>
}

/** An open charge a part payment left owed. */
export interface StillOwedRow {
  id: string
  type: string
  entryDescription: string
  dueDate: string
  /** Money still owed on it. */
  amount: number
  /** The row it is the rest of (paid in part now); null for a bill the money did not reach. */
  restOf: string | null
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
  /** Credit the desk's "Use" would spend on it (the credit plan's lines for this row). */
  creditIfUsed: number
  unitId: string | null
  /**
   * Credit may pay it (the quote's answer, creditEligibleRowSql). A home
   * payment, a GAM fee and a deposit are never credit's, so money kept on the
   * account is not "sitting beside" them (10/15).
   */
  creditEligible: boolean
}

/**
 * 10/14 (Nic): one bill — "the itemized lines of that invoice", paid together
 * and whole. Its id is its invoice's (deskBillId); a charge on no invoice is a
 * bill by itself.
 */
export interface DeskBill {
  id: string
  /** The space (lease) the bill is on; null for charges on no lease. */
  leaseId: string | null
  unitNumber: string | null
  /** YYYY-MM-DD: the invoice's due date, else its oldest line's. */
  dueDate: string
  /** Its lines the desk takes, oldest first. */
  rows: DeskRow[]
  total: number
  /** Credit already spent on its lines. */
  creditAlreadyApplied: number
  /** What it still owes before any credit the desk uses now. */
  owed: number
  /**
   * The older open bills of the same space. "October waits for September":
   * this bill can be picked only with every one of them.
   */
  olderBillIds: string[]
}

/** 10/14: the bill a charge is on — its invoice, else the charge itself. */
export function deskBillId(r: { id: string; invoiceId: string | null }): string {
  return r.invoiceId ?? r.id
}

export interface DeskQuote {
  tenantId: string
  landlordId: string
  /**
   * What the desk takes now: the bank-payable rows (not the old balance) of
   * the bills picked — every bill when none were named — oldest first.
   */
  rows: DeskRow[]
  /** 10/14 (Nic): every open bill the desk takes, oldest first — what the desk picks from. */
  bills: DeskBill[]
  /** The bills picked that are open here, in bill order; null when none were named (every bill). */
  pickedBillIds: string[] | null
  /** Picked bills no longer open here (paid meanwhile, or a payment on its way): in no figure. */
  pickedNotOpen: string[]
  /** A picked bill an older open bill of the same space waits on, that older bill not picked. */
  pickedOutOfOrder: Array<{ billId: string; olderBillId: string }>
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
  /** The whole balance the portal shows: every bill + old balance + pay online (picked or not). */
  fullBalance: number
  creditPlan: CreditPlanLine[]
  scheduledRetries: ScheduledRetry[]
  retryRowIds: string[]
  /**
   * The spaces the balance draw passes over, so money kept is never parked
   * where it could not be spent (creditUse.drawCreditOnBalance): a bank
   * payment already on its way for one of its bills (that pull is the payer's),
   * credit a payment set aside on a bill still owed, and rent past a shortened
   * stay's end. Read as it stands AFTER this payment replaces the retries on
   * the bills it takes.
   */
  drawSkipsLeaseIds: string[]
  /**
   * 10/5 (Nic): whether money RECORDED here may be less than this bill —
   * every property the bill's charges sit on has "Accept partial payments"
   * on. Off (the default): pay in full.
   */
  partialAllowed: boolean
  /**
   * 10/26 (Nic): the landlord turned OFF "let residents save credit for
   * later" at every property the credit would pay on, so the desk does not
   * get the Use/Save question — the credit goes on the bill and the screen
   * says so.
   *
   *   "If the landlord chooses to let them save it up for later, then they
   *    can have the choice to save it up for later. But if the landlord's
   *    choice is to use it, they don't ever see anything except a statement."
   *
   * His point was that a resident paying CASH had no way to hold credit while
   * a resident paying in the app did. The desk has always asked Use/Save
   * (planTender's choose_credit stop), so the cash payer could hold it — but
   * it asked regardless of the property setting, which is the real gap: at a
   * property set to use the credit, the desk still offered Save.
   *
   * Scoped to the bills the credit would actually pay (creditPlan), not every
   * row, and true only when EVERY one of them forbids saving — a household
   * spanning two properties where one allows it keeps the question.
   */
  creditMustBeUsed: boolean
}

function toDeskRow(r: QuoteRow, unitId: string | null): DeskRow {
  return {
    id: r.id, leaseId: r.leaseId, invoiceId: r.invoiceId, landlordId: r.landlordId,
    type: r.type, entryDescription: r.entryDescription, revenueOwner: r.revenueOwner,
    amount: r.amount, dueDate: r.dueDate, createdAt: r.createdAt, appliedCredit: r.appliedOnRow, creditIfUsed: 0, unitId,
    creditEligible: r.creditEligible,
  }
}

function sortDesk(rows: DeskRow[]): DeskRow[] {
  const byId = new Map(rows.map(r => [r.id, r]))
  return sortForAllocation(rows.map(r => ({
    id: r.id, amount: r.amount, due_date: r.dueDate, type: r.type,
    entry_description: r.entryDescription, created_at: r.createdAt,
  }))).map(x => byId.get(x.id)!)
}

/** 10/14: "September" for a bill due 2026-09-01. */
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
function billWords(b: Pick<DeskBill, 'dueDate' | 'unitNumber'>): string {
  const m = /^\d{4}-(\d{2})/.exec(b.dueDate)
  const month = m ? MONTH_NAMES[Number(m[1]) - 1] : null
  return `the ${month ? `${month} ` : ''}bill${b.unitNumber ? ` on ${b.unitNumber}` : ''}`
}

/**
 * 10/15 (Nic): "money gets applied to the most outstanding balance first.
 * Somebody can't go put $1,000 credit and not pay a $2,000 existing bill." The
 * household's spaces that still OWE a bill credit may pay once the rows this
 * payment is settling are off the list, oldest bill first — where money kept
 * on the account has to SIT if it is ever to pay that bill, because paid-ahead
 * money pays only its own space's bills (the credit ledger's rule, M4). The
 * caller takes the first of these in the property the money came in on
 * (leaseForCredit), so a second space in the same park is used when the oldest
 * bill of all is in another park; empty when nothing else is owed, and then the
 * money waits for a next bill as before.
 *
 * Review fix (10/17): a space the balance draw passes over is left out — money
 * parked there could not be spent, which is the very thing this prevents.
 */
function leasesOwingOldestFirst(
  q: Pick<DeskQuote, 'bills' | 'drawSkipsLeaseIds'>, settling: ReadonlySet<string>,
): string[] {
  const skip = new Set(q.drawSkipsLeaseIds)
  // The row's own lease is a neighbor landlord's on a neighbor's utility, so
  // the space is the BILL's (the household lease its invoice sits on).
  const spaceOfRow = new Map<string, string>()
  const open: DeskRow[] = []
  for (const b of q.bills) {
    if (b.leaseId === null || skip.has(b.leaseId)) continue
    for (const r of b.rows) {
      if (!r.creditEligible || settling.has(r.id)) continue
      if (toCents(r.amount) - toCents(r.appliedCredit) <= 0) continue
      spaceOfRow.set(r.id, b.leaseId)
      open.push(r)
    }
  }
  const order: string[] = []
  for (const r of sortDesk(open)) {
    const leaseId = spaceOfRow.get(r.id)!
    if (!order.includes(leaseId)) order.push(leaseId)
  }
  return order
}

/** The space number money kept would land on, as the desk knows it. */
const spaceNumber = (q: Pick<DeskQuote, 'bills'>, leaseId: string): string | null =>
  q.bills.find(b => b.leaseId === leaseId)?.unitNumber ?? null

/**
 * 10/14 (Nic): why the bills picked cannot be taken as they are — a picked
 * bill no longer open here (409: look at the bills again), or one an older
 * open bill of its space waits on (422: "October waits for September").
 * Null when the pick is good (or nothing was named).
 */
export function pickRefusal(q: Pick<DeskQuote, 'bills' | 'pickedBillIds' | 'pickedNotOpen' | 'pickedOutOfOrder'>): { status: 409 | 422; text: string } | null {
  if (q.pickedBillIds === null) return null
  if (q.pickedNotOpen.length > 0) {
    return {
      status: 409,
      text: 'A bill picked here is no longer open — it was paid, or a payment for it is on its way. Nothing was recorded; look at the bills again.',
    }
  }
  const first = q.pickedOutOfOrder[0]
  if (first) {
    const older = q.bills.find(b => b.id === first.olderBillId)
    const w = older ? billWords(older) : 'an older bill of the same space'
    return {
      status: 422,
      text: `${w.charAt(0).toUpperCase()}${w.slice(1)} is older and still open — pick it too. In one space the oldest bill is paid first.`,
    }
  }
  return null
}

/**
 * What the desk window shows for one household (a person with one company),
 * and what the desk settle takes. Read-only; `lock` inside a write after
 * lockHousehold. 10/14 (Nic): `billIds` — the bills the desk picked; every
 * figure but the full balance is for those bills alone. Absent: every bill.
 */
export async function deskQuote(
  client: PoolClient,
  opts: { tenantId: string; landlordId: string; lock?: boolean; billIds?: readonly string[] | null },
): Promise<DeskQuote> {
  const picked = opts.billIds == null ? null : new Set(opts.billIds)
  const q = await householdQuote(client, {
    tenantId: opts.tenantId, landlordId: opts.landlordId, lock: opts.lock,
    // 10/14: credit pays only the bills picked.
    ...(picked ? { planOnly: (r: QuoteRow) => picked.has(deskBillId(r)) } : {}),
  })
  const all: QuoteRow[] = [...q.leases.flatMap(l => l.rows), ...q.noLeaseRows]
  const ids = [...new Set(all.map(r => r.id))]
  const units = new Map<string, { unitId: string | null; blocked: boolean; unitNumber: string | null; billDue: string | null }>()
  if (ids.length > 0) {
    const u = await client.query<{ id: string; unit_id: string | null; blocked: boolean; unit_number: string | null; bill_due: string | null }>(
      `SELECT p.id, p.unit_id, COALESCE(un.payment_block, FALSE) AS blocked, un.unit_number,
              inv.due_date::text AS bill_due
         FROM payments p LEFT JOIN units un ON un.id = p.unit_id
         LEFT JOIN invoices inv ON inv.id = p.invoice_id
        WHERE p.id = ANY($1::uuid[])`, [ids])
    for (const r of u.rows) units.set(r.id, { unitId: r.unit_id, blocked: r.blocked, unitNumber: r.unit_number, billDue: r.bill_due })
  }
  const seen = new Set<string>()
  // Every row the desk takes, on every bill (deskRows), and the space each is on.
  const deskRows: DeskRow[] = []
  const spaceOf = new Map<string, string | null>()
  const carried: DeskRow[] = []
  const payOnline: DeskRow[] = []
  const paused: DeskRow[] = []
  let inFlight = 0
  for (const r of all) {
    if (seen.has(r.id)) continue
    seen.add(r.id)
    const unit = units.get(r.id) ?? { unitId: null, blocked: false, unitNumber: null, billDue: null }
    const row = toDeskRow(r, unit.unitId)
    // Money already on its way. GAM's FlexPay pull is never counted: FlexPay
    // never appears in the landlord portal (CLAUDE.md, S541).
    if (r.inFlight) { if (r.entryDescription !== 'FLEXPAY') inFlight += toCents(r.amount); continue }
    if (!r.payable || r.pastStayEnd) continue
    if (r.bankPayable && unit.blocked) { paused.push(row); continue }
    if (r.bankPayable && r.carried) { carried.push(row); continue }
    if (r.bankPayable) { deskRows.push(row); spaceOf.set(r.id, r.scopeLeaseId ?? r.leaseId); continue }
    if (r.required) payOnline.push(row)
  }

  // 10/14 (Nic): the bills — each invoice's lines the desk takes, together.
  const byBill = new Map<string, DeskRow[]>()
  for (const r of sortDesk(deskRows)) {
    const k = deskBillId(r)
    byBill.set(k, [...(byBill.get(k) ?? []), r])
  }
  const billList = [...byBill.entries()].map(([id, rs]) => {
    const head = units.get(rs[0].id)
    const total = rs.reduce((s, r) => s + toCents(r.amount), 0)
    const appliedC = rs.reduce((s, r) => s + toCents(r.appliedCredit), 0)
    return {
      id,
      leaseId: spaceOf.get(rs[0].id) ?? null,
      unitNumber: rs.map(r => units.get(r.id)?.unitNumber).find(x => !!x) ?? null,
      dueDate: (head?.billDue ?? rs.map(r => r.dueDate).sort()[0]).slice(0, 10),
      rows: rs,
      total: toDollars(total),
      creditAlreadyApplied: toDollars(appliedC),
      owed: toDollars(Math.max(0, total - appliedC)),
      olderBillIds: [] as string[],
    }
  }).sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.id.localeCompare(b.id))
  // "October waits for September": within one space, every bill due earlier.
  for (const b of billList) {
    b.olderBillIds = billList.filter(o => o.leaseId === b.leaseId && o.dueDate < b.dueDate).map(o => o.id)
  }
  const bills: DeskBill[] = billList
  const openBills = new Set(bills.map(b => b.id))
  const pickedBillIds = picked == null ? null : bills.filter(b => picked.has(b.id)).map(b => b.id)
  const pickedNotOpen = picked == null ? [] : [...picked].filter(id => !openBills.has(id)).sort()
  const pickedOutOfOrder: Array<{ billId: string; olderBillId: string }> = []
  if (picked) {
    for (const b of bills) {
      if (!picked.has(b.id)) continue
      for (const o of b.olderBillIds) if (!picked.has(o)) pickedOutOfOrder.push({ billId: b.id, olderBillId: o })
    }
  }
  // What the desk takes now: the bills picked (every bill when none were named).
  const rows = picked == null ? deskRows : deskRows.filter(r => picked.has(deskBillId(r)))

  const deskIds = new Set(rows.map(r => r.id))
  // The household plan counts credit a scheduled bank retry sets aside as
  // free (paying now replaces the retry). The desk replaces only the retries
  // on rows it takes (supersedeScheduledRetry on the current bill and the old
  // balance), so credit a retry holds on any other row — a space in eviction
  // hold, rent past a stay's end, a bill not picked — is not the desk's to
  // spend: spending it would take the credit below zero. Each credit's share
  // here is cut to what is free at the desk: what is on it now, plus what
  // replacing those retries gives back. The figure is the same before and
  // after that replacing, so the window and the settle agree. (The portal
  // refuses the same case: rentCharge creditStillHeldElsewhere.)
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
  const planned = new Map<string, number>()
  for (const l of creditPlan) planned.set(l.paymentId, (planned.get(l.paymentId) ?? 0) + toCents(l.amount))
  for (const r of rows) r.creditIfUsed = toDollars(planned.get(r.id) ?? 0)
  // 10/5 (Nic): "Maybe that's something we set at the property level settings
  // and let his property be set to take partial payments." Every property this
  // bill's charges sit on must allow it (a household can span two).
  let partialAllowed = false
  if (rows.length > 0) {
    const pa = await client.query<{ ok: boolean | null }>(
      `SELECT bool_and(COALESCE(pr.accept_partial_payments, FALSE)) AS ok
         FROM payments p
         LEFT JOIN leases l      ON l.id = p.lease_id
         LEFT JOIN units u       ON u.id = COALESCE(p.unit_id, l.unit_id)
         LEFT JOIN properties pr ON pr.id = u.property_id
        WHERE p.id = ANY($1::uuid[])`, [rows.map(r => r.id)])
    partialAllowed = pa.rows[0]?.ok === true
  }
  // 10/26 (Nic): the same per-property fold as partialAllowed, over the bills
  // the credit would pay. No credit to place -> no question to suppress.
  let creditMustBeUsed = false
  const creditTargets = [...new Set(creditPlan.map(l => l.paymentId))]
  if (creditTargets.length > 0) {
    const cs = await client.query<{ ok: boolean | null }>(
      `SELECT bool_and(NOT COALESCE(pr.credit_save_up_allowed, TRUE)) AS ok
         FROM payments p
         LEFT JOIN leases l      ON l.id = p.lease_id
         LEFT JOIN units u       ON u.id = COALESCE(p.unit_id, l.unit_id)
         LEFT JOIN properties pr ON pr.id = u.property_id
        WHERE p.id = ANY($1::uuid[])`, [creditTargets])
    creditMustBeUsed = cs.rows[0]?.ok === true
  }
  const sum = (xs: DeskRow[]) => xs.reduce((s, r) => s + toCents(r.amount), 0)
  const applied = rows.reduce((s, r) => s + toCents(r.appliedCredit), 0)
  const usable = creditPlan.reduce((s, l) => s + toCents(l.amount), 0)
  const current = sum(rows)
  const allRows = [...rows, ...carried]
  const taken = new Set(takenIds)
  return {
    tenantId: opts.tenantId,
    landlordId: opts.landlordId,
    rows: sortDesk(rows),
    bills,
    pickedBillIds,
    pickedNotOpen,
    pickedOutOfOrder,
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
    // The whole balance, every bill whether picked or not.
    fullBalance: toDollars(sum(deskRows) + sum(carried) + sum(payOnline)),
    creditPlan,
    // A bank retry is replaced only when its bill is taken here (10/14: a bill
    // not picked keeps its retry).
    scheduledRetries: q.leases.flatMap(l => l.scheduledRetries)
      .filter(rt => picked == null || rt.paymentIds.some(id => taken.has(id))),
    retryRowIds: allRows.filter(r => all.some(x => x.id === r.id && (x.retryScheduled || x.heldOnRow > 0))).map(r => r.id),
    // The same three cases the one credit service skips (creditUse
    // drawCreditOnBalance): a scheduled bank retry, credit set aside on a bill
    // still owed, rent past a shortened stay's end.
    drawSkipsLeaseIds: q.leases.filter(l =>
      l.scheduledRetries.length > 0 || l.pastStayEndRentIds.length > 0
      || l.rows.some(r => r.payable && toCents(r.heldOnRow) > 0)).map(l => l.leaseId),
    partialAllowed,
    creditMustBeUsed,
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
  // 10/12 (Nic, ledger P1): who collected each deposit payment settled here
  // is stored now (payments.deposit_collected_by) — every one, a pet, key or
  // cleaning deposit and a reopened move-out charge included, though only a
  // security deposit moves its record below.
  await stampDepositCollectedBy(client, settledIds)
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
    bankValidated: input.bankValidated === true,
  })
  let done = false
  return {
    settledPaymentIds: ids,
    amountSettled: toDollars(settled.rows.reduce((s, r) => s + toCents(r.amount), 0)),
    creditUsed: 0, surplus: 0, changeGiven: 0, towardOldBalance: 0,
    creditId: null, receiptId: null, depositRecords,
    stillOwed: 0, leftoverOnBalance: 0, stillOwedRows: [], partPaidIds: [],
    lateFeesReversed: { unbilled: 0, refunded: 0, refundCreditIds: [] },
    lateFeesDeleted: { count: 0, amount: 0 },
    lateFeeDeleteRefusals: [],
    lateFeeCountsLate: false,
    lateFeeDeletedStillLate: false,
    afterCommit: async () => {
      if (done) return
      done = true
      await cancelSupersededIntents(superseded.cancelAfterCommit)
    },
  }
}

/**
 * 10/5 (Nic) — a bank deposit dated before late fees were charged.
 *
 * "late fees go by when the tenant actually made the deposit" (S624,
 * services/depositBackdate.ts). The office logs a resident's bank deposit
 * after the fact, from the bank's receipt; a late fee charged for a day after
 * the money was already in the bank was never owed. The unpaid ones on each
 * bill of the household's current balance come off here, BEFORE the money is
 * placed — the same reversal a tenant's corroborated report gets
 * (bankDepositConfirm.reverseLateFees): 10/6 (Nic), each is CREDITED (the fee
 * stays, a late-fee credit nets it out), or, on the onboarding bill when the
 * landlord ticked the box (`deleteOnboarding`), deleted outright. The fees
 * already paid are left for the caller to refund once the bill is paid.
 * Inside a savepoint (`bank_deposit_backdate`): the caller releases it when
 * the deposit pays the bill in full, and rolls back to it when it does not (a
 * bill paid in part keeps its late fees, owed).
 *
 * The desk window's quote shows the bill the same way (GET
 * /payments/:id/record-manual/quote?depositedOn=), inside a transaction it
 * rolls back.
 */
export async function creditLateFeesAfterDeposit(
  client: PoolClient, q: DeskQuote, depositedOn: string,
  o: {
    createdBy: string | null; onlyInvoices?: ReadonlySet<string>
    deleteOnboarding?: { deletedBy: string | null; via: 'record_payment' | 'post_payment' } | null
  },
): Promise<{
  /** Dollars of unpaid late fees credited. */
  unbilled: number
  /** Every unpaid late fee taken off the bill — credited or deleted. */
  offIds: string[]
  credited: CreditedLateFee[]
  deleted: Array<{ paymentId: string; amount: number; invoiceId: string }>
  deleteRefusals: string[]
  /** Credit the tenant had spent on a fee that was never owed, given back (rare). */
  refunded: number
  refundCreditIds: string[]
}> {
  const { reverseLateFees } = await import('./bankDepositConfirm')
  const settlingIds = q.rows.map(r => r.id)
  const invoices = deskInvoices(q).filter(i => !o.onlyInvoices || o.onlyInvoices.has(i))
  let unbilled = 0
  let refunded = 0
  const credited: CreditedLateFee[] = []
  const deleted: Array<{ paymentId: string; amount: number; invoiceId: string }> = []
  const deleteRefusals = new Set<string>()
  const refundCreditIds: string[] = []
  for (const invoiceId of invoices) {
    const head = q.rows.find(r => r.invoiceId === invoiceId)!
    const r = await reverseLateFees(client, invoiceId, depositedOn, {
      settlingIds, tenantId: q.tenantId, landlordId: q.landlordId, leaseId: head.leaseId,
      createdBy: o.createdBy, refundPaid: false, deleteOnboarding: o.deleteOnboarding ?? null,
    })
    unbilled += toCents(r.unbilled)
    refunded += toCents(r.refunded)
    credited.push(...r.credited)
    deleted.push(...r.deleted)
    for (const m of r.deleteRefusals) deleteRefusals.add(m)
    if (r.refundCreditId) refundCreditIds.push(r.refundCreditId)
  }
  return {
    unbilled: toDollars(unbilled), offIds: [...credited.map(c => c.paymentId), ...deleted.map(d => d.paymentId)],
    credited, deleted, deleteRefusals: [...deleteRefusals], refunded: toDollars(refunded), refundCreditIds,
  }
}

/**
 * 10/6 (Nic): what the window shows for a bank deposit dated back — the late
 * fees that come off when it pays each bill in full (creditLateFeesAfterDeposit:
 * credited), bill by bill, and how much of that is on an ONBOARDING bill
 * (where the landlord may tick "Delete the late fee completely"). Inside the
 * caller's transaction, which the caller rolls back: a look changes nothing.
 */
export async function backdatedLateFeesPreview(
  client: PoolClient, q0: DeskQuote, depositedOn: string,
): Promise<{ offIds: string[]; unbilled: number; byBill: Map<string, number>; onboardingOff: number }> {
  const z = await creditLateFeesAfterDeposit(client, q0, depositedOn, { createdBy: null })
  const byBill = new Map<string, number>()
  for (const r of q0.rows) {
    if (!r.invoiceId || !z.offIds.includes(r.id)) continue
    byBill.set(r.invoiceId, Math.round(((byBill.get(r.invoiceId) ?? 0) + r.amount) * 100) / 100)
  }
  const { isOnboardingBill } = await import('./lateFeeDelete')
  let onboardingOff = 0
  for (const [invoiceId, amount] of byBill) {
    if (await isOnboardingBill(client, invoiceId)) onboardingOff += toCents(amount)
  }
  return { offIds: z.offIds, unbilled: z.unbilled, byBill, onboardingOff: toDollars(onboardingOff) }
}

/** The bills (invoices) the desk's current balance is made of, in a fixed order. */
function deskInvoices(q: DeskQuote): string[] {
  return [...new Set(q.rows.map(r => r.invoiceId).filter((x): x is string => !!x))].sort()
}

/** What money owes on each row once the credit the desk chose is spent (the settle's own arithmetic). */
function owedOnRows(q: DeskQuote, useCredit: boolean): Map<string, number> {
  const planned = new Map<string, number>()
  if (useCredit) for (const l of q.creditPlan) planned.set(l.paymentId, (planned.get(l.paymentId) ?? 0) + toCents(l.amount))
  return new Map(q.rows.map(r => [r.id, Math.max(0, toCents(r.amount) - toCents(r.appliedCredit) - (planned.get(r.id) ?? 0))]))
}

/**
 * 10/5 (Nic): how a part payment walks the bills — oldest first, each row in
 * full; a rent row it cannot cover in full is paid in part (PART_PAYABLE_TYPES)
 * and the money stops there; any other row it cannot cover is passed by and
 * stays open whole. 10/6 (Nic): money is never left over as credit while the
 * balance is owed — the newest rent paid in full is paid last instead and takes
 * the rest in part (@gam/shared placePartPayment, which the Record payment
 * window calls too). The settle places the money this way, and the bank-deposit
 * backdate judges each bill by it.
 */
function splitPartPayment(rows: readonly DeskRow[], owedOn: ReadonlyMap<string, number>, tendered: number): {
  paid: { paymentId: string; cents: number }[]
  partSplits: { row: DeskRow; take: number; owedOnRow: number }[]
  notReached: DeskRow[]
  left: number
} {
  const p = placePartPayment(rows, r => owedOn.get(r.id) ?? 0, tendered)
  return {
    paid: p.paid.map(x => ({ paymentId: x.row.id, cents: x.cents })),
    partSplits: p.partSplits,
    notReached: p.notReached,
    left: p.left,
  }
}

/**
 * 10/5 (Nic): the bills this money pays IN FULL — every bill when it covers
 * the whole balance, otherwise each bill none of whose rows the part payment
 * leaves owed (paid in part or not reached). "A bill paid in full gets the
 * reversal; a bill paid only in part keeps its late fees" — judged bill by
 * bill, never for the household as a whole.
 */
function invoicesPaidInFull(q: DeskQuote, tendered: number, useCredit: boolean): Set<string> {
  const owedOn = owedOnRows(q, useCredit)
  const all = deskInvoices(q)
  const owed = [...owedOn.values()].reduce((s, m) => s + m, 0)
  if (tendered >= owed) return new Set(all)
  const s = splitPartPayment(q.rows, owedOn, tendered)
  const short = new Set([...s.partSplits.map(x => x.row.invoiceId), ...s.notReached.map(r => r.invoiceId)])
  return new Set(all.filter(i => !short.has(i)))
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
  // 10/5 (Nic): "a reference number to the bank deposit in case somebody else
  // happens to deposit the same amount" — required, like a check's number.
  if (method === 'bank_deposit' && !(input.reference ?? '').trim()) {
    throw new AppError(422, BANK_DEPOSIT_REFERENCE_REQUIRED)
  }
  // 10/6 (Nic): only where tenants deposit rent at the bank (the property setting).
  if (method === 'bank_deposit') {
    await assertBankDepositTaken(client, { unitId: payment.unit_id, leaseId: payment.lease_id })
  }

  await lockHousehold(client, tenantId, landlordId)
  // 10/14 (Nic): the bills the desk picked (none named: every bill). A pick
  // that no longer stands — a bill paid meanwhile, or one an older open bill
  // of its space waits on — is refused before anything is written.
  const billIds = input.billIds ?? null
  // Paying at the desk over a scheduled bank retry replaces that retry: its
  // held credit comes back first and the pull is canceled after commit.
  const before = await deskQuote(client, { tenantId, landlordId, lock: true, billIds })
  const badPick = pickRefusal(before)
  if (badPick) throw new AppError(badPick.status, badPick.text)
  let cancelAfterCommit: string[] = []
  if (before.retryRowIds.length > 0) {
    cancelAfterCommit = (await supersedeScheduledRetry(client, before.retryRowIds)).cancelAfterCommit
  }
  let q = before.retryRowIds.length > 0 ? await deskQuote(client, { tenantId, landlordId, lock: true, billIds }) : before
  // 10/14: extra money kept on the account sits on the space of the newest
  // bill picked (paid-ahead money then goes on that space's own bills).
  const pickedLease = billIds === null ? null
    : before.bills.filter(b => (before.pickedBillIds ?? []).includes(b.id) && b.leaseId).at(-1)?.leaseId ?? null

  // 10/5 (Nic): a bank deposit dated before late fees were charged — the
  // unpaid ones come off first on each bill the deposit pays in full
  // (creditLateFeesAfterDeposit — 10/6: credited, or deleted from the
  // onboarding bill when the box is ticked). Judged bill by bill, on the bill as it stands
  // without them, with the credit choice the desk made: a bill the money pays
  // only in part (or does not reach) has its fees put back, and they stay
  // owed. Putting a bill's fees back can leave less money for a later bill,
  // so the bills are judged again until none changes.
  const backdatedTo = method === 'bank_deposit' && input.depositedOn ? input.depositedOn : null
  let backdateCreditedCents = 0
  // 10/6 (Nic): the unpaid late fees the deposit's date took off — credited
  // (as they were before, for the record), or deleted from the onboarding
  // bill when the landlord ticked the box — and why a ticked box could not.
  let backdateCredited: CreditedLateFee[] = []
  let backdateDeleted: Array<{ paymentId: string; amount: number; invoiceId: string }> = []
  let backdateDeleteRefusals: string[] = []
  let backdateSpentBack = 0
  const backdateRefundCredits: string[] = []
  const deleteOnboarding = input.deleteOnboardingLateFees
    ? { deletedBy: input.takenBy ?? null, via: input.lateFeeDeleteVia ?? 'record_payment' } as const : null
  if (backdatedTo && q.rows.length > 0) {
    const choseCredit = !input.neverUseCredit && input.creditToUse != null && toCents(input.creditToUse) > 0
    const keep = new Set(deskInvoices(q))
    while (keep.size > 0) {
      await client.query('SAVEPOINT bank_deposit_backdate')
      const z = await creditLateFeesAfterDeposit(client, q, backdatedTo, {
        createdBy: input.takenBy ?? null, onlyInvoices: keep, deleteOnboarding,
      })
      if (z.offIds.length === 0) {
        await client.query('RELEASE SAVEPOINT bank_deposit_backdate')
        break
      }
      const withoutFees = await deskQuote(client, { tenantId, landlordId, lock: true, billIds })
      // A property that takes no part payments: paid in full, or refused
      // below as short anyway — the refusal then names the bill without those fees.
      const paidInFull = withoutFees.partialAllowed ? invoicesPaidInFull(withoutFees, tendered, choseCredit) : keep
      const short = [...keep].filter(i => !paidInFull.has(i))
      if (short.length === 0) {
        q = withoutFees
        backdateCreditedCents = toCents(z.unbilled)
        backdateCredited = z.credited
        backdateDeleted = z.deleted
        backdateDeleteRefusals = z.deleteRefusals
        backdateSpentBack = toCents(z.refunded)
        backdateRefundCredits.push(...z.refundCreditIds)
        await client.query('RELEASE SAVEPOINT bank_deposit_backdate')
        break
      }
      await client.query('ROLLBACK TO SAVEPOINT bank_deposit_backdate')
      await client.query('RELEASE SAVEPOINT bank_deposit_backdate')
      for (const i of short) keep.delete(i)
    }
  }

  // 10/14 (Nic): nothing is picked for the desk.
  if (q.pickedBillIds !== null && q.pickedBillIds.length === 0 && q.bills.length > 0 && q.carried.length === 0) {
    throw new AppError(422, 'Pick the bills this money pays — each bill is paid whole.')
  }
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
  // 10/26 (Nic): where the landlord turned saving off, there is no choice to
  // make — the credit goes on the bill. Enforced here and not only in the
  // window, so a desk screen left open from before the setting changed cannot
  // still save it, and neverUseCredit cannot be used to route around it.
  //
  // neverUseCredit is NOT a Save answer and is not refused here. It is the
  // posted-payment path (services/postPayment): money that arrived before
  // there was a bill, which by S655 never spends credit and never asks about
  // it. Refusing it would have broken posting a check at a property that
  // turned saving off — the setting is about a payer's choice, not about
  // forcing old money into every unrelated path.
  if (usable > 0 && q.creditMustBeUsed && !input.neverUseCredit) {
    if (input.creditToUse != null && toCents(input.creditToUse) === 0) {
      throw new AppError(409,
        `Credit goes on the balance at this property — it cannot be saved for later. `
        + `Record this payment again and the ${money(usable)} of credit will be used on this bill.`)
    }
    if (input.creditToUse != null && toCents(input.creditToUse) !== usable) {
      throw new AppError(409, `The credit available changed — it's now ${money(usable)}. Look at the bill again.`)
    }
    useCredit = true
  } else if (!input.neverUseCredit) {
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
  let lines: { paymentId: string; cents: number }[] = []
  let owed = 0
  const owedOn = new Map<string, number>()
  for (const r of q.rows) {
    const m = Math.max(0, toCents(r.amount) - toCents(r.appliedCredit) - (planned.get(r.id) ?? 0))
    owedOn.set(r.id, m)
    owed += m
    if (m > 0) lines.push({ paymentId: r.id, cents: m })
  }
  // Rent is pay-in-full platform-wide — a partial can reset a landlord's
  // eviction clock (standing directive) — unless the property takes part
  // payments (10/5, Nic: "there's really no way to stop somebody from going
  // into the bank and making a partial ... We need that to log that and still
  // be able to charge late fees to the people that didn't pay in full.").
  const partial = tendered < owed
  // 10/6 (Nic): "the credit needs to be applied to the entire balance." The
  // pay-in-full rule governs the tenant's own money handed over — it never
  // keeps their credit off the bill. The desk may apply the credit alone
  // ("Use", nothing handed over) even when it pays only part of the bill: it
  // goes on the oldest lines first (the plan), part of a line where it runs
  // out, and the rest stays owed.
  const creditOnlyPart = partial && tendered === 0 && useCredit && creditUsed > 0
  if (partial && !q.partialAllowed && !creditOnlyPart) {
    throw new AppError(422,
      `That is ${money(owed - tendered)} short — ${money(tendered)} against ${money(owed)} owed. Rent is paid in full.`)
  }
  // ── A part payment (10/5): the money pays the oldest bills first, each in
  // full. A rent bill it cannot cover in full is paid in part: what it pays
  // settles, and the rest stays open on its own row of the same bill, so late
  // fees keep applying to it as the lease says. Any other bill it cannot cover
  // in full is passed by (PART_PAYABLE_TYPES) and stays open whole. Money left
  // after that (rare: only when every bill left is one that cannot be paid in
  // part) is kept like any money kept — the old balance first, then credit.
  let partSplits: { row: DeskRow; take: number; owedOnRow: number }[] = []
  let notReached: DeskRow[] = []
  let over: number
  if (partial) {
    if (tendered === 0 && !creditOnlyPart) {
      throw new AppError(422, 'Enter the amount they paid — with nothing paid there is nothing to record.')
    }
    if (input.towardOldBalance != null && toCents(input.towardOldBalance) > 0) {
      throw new AppError(422,
        `This is less than the ${money(owed)} bill, so none of it goes to the old balance — the bill is paid first. Leave the old-balance amount out.`)
    }
    const split = splitPartPayment(q.rows, owedOn, tendered)
    lines = split.paid
    partSplits = split.partSplits
    notReached = split.notReached
    over = split.left
  } else {
    over = tendered - owed
  }
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
  // A part payment keeps whatever it could not place: nobody is handed change
  // on a payment that is short.
  const keepsMoney = partial || !isCash || input.surplusHandling === 'credit'
  const oldFirst = Math.min(over, carriedOwed)
  let towardOld: number
  if (input.towardOldBalance != null && !partial) {
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
  if (surplus > 0 && isCash && !partial && input.surplusHandling !== 'change' && input.surplusHandling !== 'credit') {
    const keepOld = Math.min(over, carriedOwed)
    const keep = keepOld > 0
      ? `"Keep it — no change on hand" (${money(keepOld)} pays the old balance first` +
        `${over > keepOld ? `, ${money(over - keepOld)} kept as credit` : ''})`
      : `"Keep ${money(surplus)} as credit"`
    throw new AppError(422,
      `That is ${money(surplus)} over the ${money(owed + towardOld)} being paid. Choose "Give ${money(surplus)} change" or ${keep}.`)
  }
  const keepAsCredit = surplus > 0 && keepsMoney
  if (keepAsCredit && creditUsed > 0 && partial) {
    throw new AppError(422,
      `Credit is being used on this bill and ${money(surplus)} of this payment would be kept as credit beside it. Save the credit instead.`)
  }
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
  // 10/15 (Nic): money kept goes where it is OWED. The household's spaces that
  // still owe a bill this payment is not already settling, oldest bill first
  // (leasesOwingOldestFirst), so the next moment's balance draw spends it there
  // instead of parking a credit beside an open bill. The lease the money came
  // in on still wins when nothing else is owed, and a space in another park is
  // never chosen: the money has to be reported as arriving where it arrived, so
  // the first of these IN THAT PROPERTY is taken (leaseForCredit) — review fix
  // 10/17: a park where a second space owes no longer loses the money to the
  // space that was just paid because the oldest bill of all is in another park.
  const owesLeases = keepAsCredit ? leasesOwingOldestFirst(q, new Set(lines.map(l => l.paymentId))) : []
  const creditLease = keepAsCredit
    ? await leaseForCredit(client, input, tenantId, landlordId, pickedLease, owesLeases) : null
  if (keepAsCredit && !creditLease) {
    throw new AppError(409, isCash
      ? 'This resident has no lease here to hold a credit on. Hand the difference back as change.'
      : 'This resident has no lease here to hold a credit on, so a check over the bill cannot be taken.')
  }
  // Said as what it does, never as "credit" while that balance is owed (10/6):
  // the space the money lands on, when it is not the one it came in on. Only
  // when that space really owes a bill credit may pay (review fix 10/17): a
  // caller that names the space itself may name one whose only open charge is
  // a home payment, which credit never pays — the money waits there as credit.
  const keptGoesTo = keepAsCredit && creditLease && creditLease !== (pickedLease ?? input.payment.lease_id)
    && owesLeases.includes(creditLease)
    ? spaceNumber(q, creditLease) : null

  // A check or money order written over the bill: confirm the written amount
  // before any of it goes anywhere (a typed round-up becomes a stray credit).
  // Asked last, once every other refusal above has had its say, so the desk
  // never confirms an amount and is then refused for something else (credit
  // used with a check over the bill is "Save the credit instead"; no lease to
  // hold the extra is "cannot be taken" — each said once). The question
  // names what the money is paying: the current bill, the old balance a
  // check's extra goes to first, or both — never "$0.00 owed" while an old
  // balance is open (verify r2).
  if (!isCash && !partial && over > 0 && input.confirmWrittenAmount !== true) {
    const against = carriedOwed === 0
      ? `against ${money(owed)} owed`
      : owed === 0
        ? `toward the ${money(carriedOwed)} old balance`
        : `against the ${money(owed)} bill and a ${money(carriedOwed)} old balance`
    throw new AppError(422,
      `You typed ${money(tendered)} ${against} — is the ${methodWord(method)} really ${money(tendered)}? ` +
      (method === 'bank_deposit'
        ? `Check the amount on the bank's receipt, then confirm.`
        : `Check the amount written on it, then confirm.`))
  }
  const changeGiven = surplus > 0 && !keepAsCredit ? surplus : 0
  const kept = tendered - changeGiven   // what went in the drawer

  // ── Write ───────────────────────────────────────────────────────────────
  const refNote = input.reference ? ` (ref ${input.reference})` : ''
  const provenance = input.provenance ? ` — ${input.provenance}` : ''
  // 10/5: a bank deposit is named in words (the older methods keep the notes they always had).
  const note = `Recorded as manual ${method === 'bank_deposit' ? methodWord(method) : method} payment${refNote}${provenance}`

  // 10/5: a rent bill paid in part — the paid slice keeps the row (and any
  // credit already on it); the rest stays open on its own row of the same
  // bill (is_remainder), owed as before, late fees and all. Every dollar is
  // counted once: slice + rest = the bill.
  const restRows: StillOwedRow[] = []
  for (const sp of partSplits) {
    const restC = sp.owedOnRow - sp.take
    const sliceC = toCents(sp.row.amount) - restC
    await client.query(
      `UPDATE payments SET amount = $2::numeric,
              notes = COALESCE(notes || ' — ', '') || 'paid in part; $' || $3 || ' still owed'
        WHERE id = $1`,
      [sp.row.id, toDollars(sliceC).toFixed(2), toDollars(restC).toFixed(2)])
    const rest = await client.query<{ id: string }>(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, invoice_id,
                             type, amount, status, due_date, entry_description, notes, is_remainder, revenue_owner,
                             space_carryforward_id)
       SELECT unit_id, lease_id, tenant_id, landlord_id, invoice_id,
              type, $2::numeric, 'pending', due_date, entry_description, $3, TRUE, revenue_owner,
              space_carryforward_id
         FROM payments WHERE id = $1
       RETURNING id`,
      [sp.row.id, toDollars(restC).toFixed(2), PART_PAYMENT_REST_NOTE])
    restRows.push({
      id: rest.rows[0].id, type: sp.row.type, entryDescription: sp.row.entryDescription,
      dueDate: sp.row.dueDate, amount: toDollars(restC), restOf: sp.row.id,
    })
  }
  const stillOwedRows: StillOwedRow[] = [
    ...restRows,
    ...notReached.map(r => ({
      id: r.id, type: r.type, entryDescription: r.entryDescription, dueDate: r.dueDate,
      amount: toDollars(owedOn.get(r.id) ?? 0), restOf: null,
    })),
  ].sort((a, b) => a.dueDate.localeCompare(b.dueDate))
  // 10/6 (Nic): money a part payment could not place (no rent on that bill
  // to take it) is kept as money paid ahead, and that goes on the rest of what
  // they owe by itself right after this commit (creditUse.drawCreditOnBalance,
  // via the route's whole-bill check) — so it is said that way, never as
  // "credit" while the balance is owed. Only what no open line can take
  // (a home payment is never paid with it) waits for their next bill.
  const leftoverOnBalanceC = partial && keepAsCredit
    ? Math.min(surplus, notReached.filter(paidAheadGoesOn).reduce((s, r) => s + (owedOn.get(r.id) ?? 0), 0))
    : 0
  const stillOwedC = stillOwedRows.reduce((s, r) => s + toCents(r.amount), 0) - leftoverOnBalanceC

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
        // 10/19 (Nic): space_carryforward_id comes with it. A carried space-rent
        // balance is ONE settlement, and the claim reads its own charge rows to
        // know whether anything is still owed — a remainder that forgot the link
        // would make a $100 payment on an $880 balance look like the end of it,
        // and the departing resident's record would show it paid off.
        `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, invoice_id,
                               type, amount, status, due_date, entry_description, notes, is_remainder, revenue_owner,
                               space_carryforward_id)
         SELECT unit_id, lease_id, tenant_id, landlord_id, invoice_id,
                type, $2::numeric, 'pending', due_date, entry_description,
                'What is left of the old balance after a part payment', TRUE, revenue_owner,
                space_carryforward_id
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
  let reportClosed: ReportClosedByRecording | null = null
  const amountSettled = lines.reduce((s, l) => s + l.cents, 0)
  if (kept > 0) {
    // The receipt says what was handed over and what became of any extra —
    // the old balance it paid, change, or credit: the desk's own answer, never
    // a default (S637; harland-credits 10/3).
    const oldPart = towardOld > 0 ? `; ${money(towardOld)} went to the old balance` : ''
    const handedOver = isCash
      ? `Handed over ${money(tendered)}`
      : method === 'bank_deposit'
        ? `Deposited ${money(tendered)} at the bank${partial ? '' : ' (amount confirmed)'}`
        : `Handed over a ${methodWord(method)} for ${money(tendered)}${partial ? '' : ' (amount confirmed)'}`
    // 10/15: what the kept money IS — money going on another space's open bill,
    // not a credit waiting for a next bill.
    const keptWords = keptGoesTo ? `goes on what ${keptGoesTo} still owes` : 'kept as credit'
    const handed = partial
      ? `${handedOver}${oldPart}` +
        `${leftoverOnBalanceC > 0 ? `; ${money(leftoverOnBalanceC)} goes on the rest of what they owe` : ''}` +
        `${keepAsCredit && surplus > leftoverOnBalanceC
          ? `; ${money(surplus - leftoverOnBalanceC)} ${keptGoesTo ? keptWords : 'kept toward their next bill'}` : ''}. ` +
        `Part payment: ${money(stillOwedC)} still owed.`
      : changeGiven > 0
      ? `Handed over ${money(tendered)}${oldPart}; ${money(changeGiven)} given back as change.`
      : keepAsCredit && isCash
        ? `Handed over ${money(tendered)}${oldPart}; ${towardOld > 0 ? 'the other ' : ''}${money(surplus)} ${keptWords}${keptGoesTo ? '.' : ' — no change on hand.'}`
        : keepAsCredit
          ? `${handedOver}${oldPart}; ${towardOld > 0 ? `the other ${money(surplus)}` : `${money(surplus)} over the bill`} ${keptWords}.`
          : towardOld > 0 && over > 0
            ? `${handedOver}${oldPart}.`
            : null
    const rem = await client.query<{ id: string }>(
      `INSERT INTO tenant_remittances
         (tenant_id, lease_id, landlord_id, amount, applied_amount, unapplied_amount, status,
          payment_method, gross_amount, processing_fee_amount, settled_at, reference, notes, received_by,
          received_ip, received_device)
       VALUES ($1, $2, $3, $4, $5, $6, 'settled', $7, NULL, 0, COALESCE($8::timestamptz, NOW()), $9, $10, $11,
               $12::inet, $13)
       RETURNING id`,
      // The receipt sits where the money was TAKEN (the bills picked, else the
      // charge's lease) — 10/15: money kept may now land on another space of
      // the household, and the receipt never moves with it.
      [tenantId, pickedLease ?? payment.lease_id ?? creditLease, landlordId, toDollars(kept).toFixed(2),
       toDollars(amountSettled).toFixed(2), toDollars(keepAsCredit ? surplus : 0).toFixed(2),
       method, input.settledAt, input.reference || null,
       [input.notes, handed].filter(Boolean).join(' ') || null, input.takenBy ?? null,
       input.takenFrom?.ip || null, input.takenFrom?.device?.slice(0, 300) || null])
    receiptId = rem.rows[0].id
    // 10/5 (Nic): "money movement is the end of onboarding" — cash, a check or
    // a money order taken at the desk ends the free onboarding window, even
    // when all of it is kept as credit and no bill settles.
    await activateBillingForMoneyMoved(client, [landlordId])
    // 10/6 (Nic): a bank deposit the landlord records closes the tenant's own
    // report of it now (the sweep's rule, jobs/declaredDepositExpiry), and the
    // tenant is told after the commit. Whether they reported it first changes
    // nothing about a late fee: "No exceptions" (Nic, 10/6).
    if (method === 'bank_deposit') {
      const { closeReportForRecordedBankDeposit } = await import('../jobs/declaredDepositExpiry')
      reportClosed = await closeReportForRecordedBankDeposit(client, receiptId)
    }
  }

  // Credit next (applied: the money is already here), then the rows.
  if (useCredit && q.creditPlan.length > 0) {
    await applyCredit(client, q.creditPlan, {
      source: input.source ?? 'desk', createdBy: input.takenBy ?? null, remittanceId: receiptId,
    })
  }
  // Every row of the bill the money (or the credit) paid in full, and each
  // slice of a bill paid in part; a bill a part payment did not reach stays open.
  const lineIds = new Set(lines.map(l => l.paymentId))
  const toSettle = [...q.rows.filter(r => (owedOn.get(r.id) ?? 0) === 0 || lineIds.has(r.id)).map(r => r.id), ...carriedPaid]
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

  // 10/5 (Nic): on each bill the deposit paid in full, late fees the tenant
  // had already paid for days after the deposit come back as a late-fee
  // refund credit (the unpaid ones were credited or deleted before the money
  // was placed). A bill paid only in part, or not reached, keeps every late
  // fee.
  let backdateRefunded = backdateSpentBack
  const refundedFeeIds: string[] = []
  if (backdatedTo) {
    const { reverseLateFees } = await import('./bankDepositConfirm')
    const short = new Set([...partSplits.map(x => x.row.invoiceId), ...notReached.map(r => r.invoiceId)])
    const invoices = deskInvoices(q).filter(i => !short.has(i))
    for (const invoiceId of invoices) {
      const head = q.rows.find(r => r.invoiceId === invoiceId)!
      const r = await reverseLateFees(client, invoiceId, backdatedTo, {
        settlingIds: settledIds, tenantId, landlordId, leaseId: head.leaseId, createdBy: input.takenBy ?? null,
      })
      backdateCreditedCents += toCents(r.unbilled)
      backdateRefunded += toCents(r.refunded)
      if (r.refundCreditId) backdateRefundCredits.push(r.refundCreditId)
      backdateCredited.push(...r.credited)
      refundedFeeIds.push(...r.refundedIds)
    }
  }
  const deletedCount = backdateDeleted.length
  const deletedCents = backdateDeleted.reduce((s, d) => s + toCents(d.amount), 0)

  // 10/6 (Nic): "they get a credit against their bill and the late payment
  // still shows on their payment history" — "No exceptions", whether or not
  // the tenant reported the deposit first. A late fee credited or refunded
  // here stays on its bill, so that bill's rent and utility are marked LATE
  // from today, the day this was recorded (afterRowsSettled reads the fee on
  // the bill). Only the onboarding box deleted it outright — then the bill has
  // no late fee and its mark counts from the deposit's date, the onboarding
  // month's positive-only rule applying as always.
  // Judged on what is actually left (review fix): a bill whose late fee was
  // credited or refunded keeps it, so it counts late; a bill whose late fee
  // the box deleted counts late only if ANOTHER late fee is still on it (one
  // charged before the deposit, or one they had already paid) — the same test
  // settleHooks marks by (amount > 0, not voided).
  const feeBills = new Set(backdateDeleted.map(d => d.invoiceId))
  const keptFeeIds = [...backdateCredited.map(c => c.paymentId), ...refundedFeeIds]
  const keptBills = keptFeeIds.length === 0 ? [] : (await client.query<{ invoice_id: string }>(
    `SELECT DISTINCT invoice_id::text AS invoice_id FROM payments
      WHERE id = ANY($1::uuid[]) AND invoice_id IS NOT NULL ORDER BY 1`, [keptFeeIds])).rows.map(r => r.invoice_id)
  for (const b of keptBills) feeBills.add(b)
  const stillLateBills = new Set(feeBills.size === 0 ? [] : (await client.query<{ invoice_id: string }>(
    `SELECT DISTINCT f.invoice_id::text AS invoice_id FROM payments f
      WHERE f.invoice_id = ANY($1::uuid[]) AND f.type = 'late_fee' AND f.amount > 0 AND f.status <> 'voided'
      ORDER BY 1`, [[...feeBills]])).rows.map(r => r.invoice_id))
  const lateFeeCountsLate = stillLateBills.size > 0
  const lateFeeDeletedStillLate = backdateDeleted.some(d => stillLateBills.has(d.invoiceId))

  const partPaidIds = partSplits.map(sp => sp.row.id).sort()
  const after = await afterRowsSettled(client, settledIds, {
    attestationSource: 'landlord_self_reported_with_evidence',
    attestationEvidence: { manual_method: method, reference: input.reference ?? null },
    // 10/5 (Nic): a bill's on-time or late mark is for the day it is paid in
    // full — a slice paid in part carries none; its rest earns the mark.
    partPaidIds,
    receipt: input.sendReceipt === false ? null : {
      method: kept === 0 ? 'your account credit'
        : changeGiven > 0 ? `${methodWord(method)} (change given ${money(changeGiven)})`
        : keepAsCredit && isCash ? `${methodWord(method)} (${money(surplus)} kept as credit — no change on hand)`
        : methodWord(method),
      reference: input.reference ?? null,
      creditBanked: keepAsCredit ? toDollars(surplus) : 0,
      // 10/5: the receipt says what was paid and what is still owed.
      partPaidIds,
      stillOwedPaymentIds: stillOwedRows.map(r => r.id),
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
    stillOwed: toDollars(stillOwedC),
    leftoverOnBalance: toDollars(leftoverOnBalanceC),
    stillOwedRows,
    partPaidIds,
    lateFeesReversed: {
      unbilled: toDollars(backdateCreditedCents), refunded: toDollars(backdateRefunded), refundCreditIds: backdateRefundCredits,
    },
    lateFeesDeleted: { count: deletedCount, amount: toDollars(deletedCents) },
    lateFeeDeleteRefusals: backdateDeleteRefusals,
    lateFeeCountsLate,
    lateFeeDeletedStillLate,
    afterCommit: async () => {
      if (done) return
      done = true
      await after.afterCommit()
      await cancelSupersededIntents(cancelAfterCommit)
      if (reportClosed) {
        const { tellTenantReportRecorded } = await import('../jobs/declaredDepositExpiry')
        await tellTenantReportRecorded({
          tenantId: reportClosed.tenantId, receiptAmount: reportClosed.receiptAmount, word: methodWord('bank_deposit'),
          recordedOn: reportClosed.recordedOn, reportAmount: reportClosed.reportAmount, declaredDate: reportClosed.declaredDate,
        }).catch(e => logger.error({ err: e }, '[manual-settle] report-recorded notice failed'))
      }
      if (backdatedTo && backdateCreditedCents + backdateRefunded > 0) {
        await tellTenantLateFeesCredited(tenantId, backdatedTo, toDollars(backdateCreditedCents), toDollars(backdateRefunded),
          backdateCredited.length + refundedFeeIds.length)
          .catch(e => logger.error({ err: e }, '[manual-settle] late-fee notice failed'))
        // A refund credit that covers a whole bill pays it (its own transaction).
        if (backdateRefundCredits.length > 0) {
          const { runWholeBillCheckAfterCommit } = await import('./creditUse')
          await runWholeBillCheckAfterCommit({ tenantId, landlordId })
            .catch(e => logger.error({ err: e }, '[manual-settle] whole-bill check failed'))
        }
      }
    },
  }
}

/**
 * 10/6 (Nic): the tenant hears that a late fee was credited (or given back as
 * credit when they had already paid it), and that the payment still counts
 * late on their payment history ("No exceptions"). A fee the landlord deleted
 * in the onboarding month is not mentioned: nothing shows on their record.
 * Never throws past the caller's catch.
 */
async function tellTenantLateFeesCredited(
  tenantId: string, depositedOn: string, credited: number, refunded: number, count: number,
): Promise<void> {
  const { queryOne } = await import('../db')
  const { createNotification } = await import('./notifications')
  const u = (await queryOne<{ user_id: string }>(`SELECT user_id FROM tenants WHERE id = $1`, [tenantId]))?.user_id
  if (!u) return
  await createNotification({
    userId: u,
    type: 'payment_recorded',
    title: 'Your late fee was credited',
    body: lateFeeCreditedTenantText({ depositedOn, credited, refunded, count }),
    actionUrl: '/payments',
  })
}

/**
 * The lease paid-ahead money sits on: the one asked for, the space of the
 * bills picked (10/14), the opened charge's, else the newest active one.
 */
async function leaseForCredit(
  client: PoolClient, input: ManualSettleInput, tenantId: string, landlordId: string, pickedLease: string | null = null,
  owesLeases: readonly string[] = [],
): Promise<string | null> {
  // 10/15 (Nic): after a caller that says where ($3, a posted payment), the
  // space that still OWES wins — money goes on the most outstanding balance
  // first — taking them oldest bill first ($6, in that order). Only inside the
  // property the money came in on: the paid-ahead line of Money received and
  // the owner statement read the lease a credit sits on, so sending it to
  // another park would report the arrival in the wrong place. So a park where a
  // second space owes keeps the money (review fix 10/17), and only when no
  // space there owes does the pick fall back to the bills picked, the charge's
  // own lease, and the newest active lease, exactly as before.
  const r = await client.query<{ id: string }>(
    `WITH arrival AS (
       SELECT un.property_id FROM leases l0 JOIN units un ON un.id = l0.unit_id WHERE l0.id = $7::uuid
     )
     SELECT l.id FROM leases l
       LEFT JOIN units u ON u.id = l.unit_id
      WHERE l.landlord_id = $2
        AND l.status IN ('active','pending')
        AND EXISTS (SELECT 1 FROM lease_tenants lt WHERE lt.lease_id = l.id AND lt.tenant_id = $1
                       AND lt.status IN ('active','pending_add','pending_remove'))
      ORDER BY COALESCE(l.id = $3::uuid, FALSE) DESC,
               CASE WHEN (SELECT property_id FROM arrival) IS NULL
                          OR u.property_id = (SELECT property_id FROM arrival)
                      THEN COALESCE(array_position($6::uuid[], l.id), 1000000) ELSE 1000000 END,
               COALESCE(l.id = $5::uuid, FALSE) DESC,
               COALESCE(l.id = $4::uuid, FALSE) DESC, (l.status = 'active') DESC, l.start_date DESC, l.id
      LIMIT 1`,
    [tenantId, landlordId, input.creditLeaseId ?? null, input.payment.lease_id ?? null, pickedLease,
     owesLeases.length > 0 ? owesLeases : null, pickedLease ?? input.payment.lease_id ?? null])
  return r.rows[0]?.id ?? null
}

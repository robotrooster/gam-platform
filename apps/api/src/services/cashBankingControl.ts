// S624 — did the office bank what it collected?
//
// Nic (S624): "a landlord would mark each one paid as they collect the rent in
// person in the office, and then the bulk deposit would be sorted and verified
// against those ones that were marked paid in person. It needs a double
// verification."
//
// This is worth more than the reconciliation time it saves. On-site staff take
// cash and mark each tenant paid; the deposit posts days later; nobody has ever
// been able to check the two against each other without doing it by hand. A
// property collecting $3,000 and banking $2,750 leaves a $250 gap WITH NAMES
// ATTACHED — the specific payments that were taken and never reached the bank.
//
// It reports; it never accuses and never reverses anything. Cash legitimately
// sits in a drawer over a weekend, and a deposit legitimately spans two days of
// collection. The output is "here is what is outstanding and for how long",
// which is a question a human should answer.
//
// S655 (money plan Step 12, K-B): what is counted is what went into the BAG,
// not charge rows:
//   - every desk RECEIPT (tenant_remittances: cash, check, money order) — what
//     was handed over, so a $500 bill that paid $460 and kept $40 as credit is
//     $500; never a receipt a bank match wrote (that money went straight into
//     the bank), never a Stripe one, and a prior arrangement (paid before GAM)
//     has no receipt at all;
//   - every REGISTER cash sale, net of refunds;
//   - none of them on a slip the bank has matched.
// It is split in two: "on a deposit slip, waiting for the bank" and "not on any
// slip". The second is the one with a grace period — the first already left the
// drawer; a slip the bank has not shown after 5 business days is flagged
// (services/depositSlips).

import { DateTime } from 'luxon'
import { db, query } from '../db'
import { cashNotBanked, overdueSlipCount, type CashItem, type CashItemKind } from './depositSlips'

export interface UnbankedCollection {
  /** The receipt or the register sale. */
  id: string
  kind: CashItemKind
  /** Who paid (a tenant, a register customer), or null when nobody was named. */
  payerName: string | null
  unitNumber: string | null
  propertyName: string | null
  amount: number
  collectedOn: string
  daysOutstanding: number
  /** cash, check or money_order. */
  method: string
  /** The open deposit slip it is on, if any. */
  slipId: string | null
  slipDepositDate: string | null
  /** The bill lines a receipt paid, oldest first; paymentId is the first (null for a register sale). */
  paymentIds: string[]
  paymentId: string | null
}

export interface CashBankingPosition {
  /** Everything taken and not yet in the bank: on a slip, plus off any slip past the grace. */
  unbanked: UnbankedCollection[]
  unbankedTotal: number
  /** The oldest gap, in days. The number that actually matters. */
  oldestDays: number
  /** Ticked onto a deposit slip; the bank has not shown it yet. */
  onSlip: { items: UnbankedCollection[]; total: number }
  /** On no slip at all, older than the grace. */
  notOnSlip: { items: UnbankedCollection[]; total: number }
  /** Open slips the bank has not shown within 5 business days. */
  slipsOverdue: number
  /**
   * Deposits in the window that no charge was matched to — the other side of
   * the same question. Money arrived that nobody has attributed.
   */
  unattributedDeposits: number
  unattributedTotal: number
}

const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * Where a landlord's cash stands right now.
 *
 * `graceDays` exists because same-day banking is not the standard anyone works
 * to — an office collecting on the 1st and banking on the 3rd is normal, and
 * flagging that as a discrepancy would train people to ignore the report. Only
 * what is older than the grace shows up off a slip; what is on a slip always
 * shows (it has left the drawer and is waiting for the bank).
 *
 * propertyIds narrows to a staffer's properties (null = all).
 */
export async function cashBankingPosition(
  landlordId: string, opts: { graceDays?: number; asOf?: string; propertyIds?: string[] | null } = {},
): Promise<CashBankingPosition> {
  const grace = opts.graceDays ?? 3
  const asOf = opts.asOf ?? DateTime.now().setZone('America/Phoenix').toISODate()!
  const daysFrom = (d: string) =>
    Math.round((Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${d}T00:00:00Z`)) / 86400000)

  const items = await cashNotBanked(db, landlordId, { includeOnSlip: true, propertyIds: opts.propertyIds ?? null })
  const view = (i: CashItem): UnbankedCollection => ({
    id: i.id, kind: i.kind, payerName: i.payerName, unitNumber: i.unitNumber, propertyName: i.propertyName,
    amount: i.amount, collectedOn: i.collectedOn, daysOutstanding: Math.max(0, daysFrom(i.collectedOn)),
    method: i.method, slipId: i.slipId, slipDepositDate: i.slipDepositDate,
    paymentIds: i.paymentIds, paymentId: i.paymentIds[0] ?? null,
  })
  const onSlip = items.filter(i => i.slipId).map(view)
  const notOnSlip = items.filter(i => !i.slipId && i.collectedOn <= asOf && daysFrom(i.collectedOn) >= grace).map(view)
  const unbanked = [...onSlip, ...notOnSlip].sort((a, b) => a.collectedOn.localeCompare(b.collectedOn) || a.id.localeCompare(b.id))
  const sum = (xs: UnbankedCollection[]) => round2(xs.reduce((s, r) => s + r.amount, 0))

  const other = await query<{ n: string; total: string }>(
    `SELECT COUNT(*) AS n, COALESCE(SUM(amount),0)::text AS total
       FROM bank_transactions
      WHERE landlord_id = $1 AND amount > 0 AND status = 'needs_review'
        AND COALESCE(bank_status, 'posted') <> 'void'
        AND posted_date >= ($2::date - 90)`,
    [landlordId, asOf])

  return {
    unbanked,
    unbankedTotal: sum(unbanked),
    oldestDays: unbanked.length ? Math.max(...unbanked.map(r => r.daysOutstanding)) : 0,
    onSlip: { items: onSlip, total: sum(onSlip) },
    notOnSlip: { items: notOnSlip, total: sum(notOnSlip) },
    slipsOverdue: await overdueSlipCount(landlordId),
    unattributedDeposits: parseInt(other[0]?.n ?? '0', 10),
    unattributedTotal: round2(Number(other[0]?.total ?? 0)),
  }
}

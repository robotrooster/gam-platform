// S637 (Nic): "Fix it so that people get an email confirmation of their receipt."
//
// One place that builds a receipt, used by every path money can arrive through —
// the desk recording cash or a check, the Stripe webhook for card and ACH, and
// (S655) a bill paid with account credit (services/settleHooks.afterRowsSettled
// for the credit-only and whole-bill settles). A receipt is the same document to
// the person who paid however it arrived, and three copies of this logic would
// drift (see manualPaymentSettle's header for why the settle itself has one home).
//
// Reads its own rows rather than taking figures from the caller: the caller
// knows what it settled, but the receipt has to say what the resident actually
// owes against, and that is the ledger's answer.
//
// S655 (10/3, Kim Harland): her 9/9 receipt said $936 for a $486 money order.
// It printed every line at its full amount and called the sum "Total paid",
// though $450 of it was the landlord's move-in special. Now the money and the
// credit are separate lines: each charge by name at its amount, "Account credit
// applied −$X" on its own line (credit_uses on these rows), anything kept on the
// account "+$Y", and the total is the money that actually changed hands:
//   amount = lines − credit applied + credit kept.
// A bill paid entirely by credit is a "paid with your account credit" receipt
// with nothing charged.
//
// S655 (review): the receipt goes to the person who PAID (S637), not to the
// person the charge is billed to. Lease charges carry the primary resident's
// tenant_id, so when a co-tenant paid the lease's rent (portal card or bank,
// or at the desk) the primary got the payer's amount and method and the payer
// got nothing. The payer is: the caller's payerTenantId when it knows it, else
// the tenant on the remittance that paid these rows (remittance_applications),
// else — a settle with no remittance, such as one paid from credit — the
// person the first row is billed to.
import { query } from '../db'
import { logger } from '../lib/logger'
import { emailPaymentReceipt } from './email'
import { replyToProperty } from './replyRouting'
import { chargeLabel, chargeDetail, chargeLabelColumnsSql } from './invoiceNotice'

const TENANT_APP_URL = process.env.TENANT_APP_URL || 'http://localhost:3002'

export interface ReceiptOpts {
  paymentIds: string[]
  method: string
  reference?: string | null
  /** ACH in flight — the money is submitted but has not cleared. */
  pending?: boolean
  creditBanked?: number
  /**
   * The person who paid, when the caller knows it (a credit-only settle has no
   * remittance to read it from). Else it is read from the remittance that paid
   * these rows, else the person the first row is billed to.
   */
  payerTenantId?: string | null
}

/** One line of a receipt: the charge by name, with its detail, at its full amount. */
export interface ReceiptLine { label: string; detail: string | null; amount: number }

export interface ReceiptFigures {
  lines: ReceiptLine[]
  /** Σ lines. */
  linesTotal: number
  /** Account credit (any kind) that paid part of these lines. */
  creditApplied: number
  /** Money kept on the account from this payment. */
  creditBanked: number
  /** The money that changed hands: linesTotal − creditApplied + creditBanked. */
  amount: number
  /** "October bill" when every line is on one month's bill, else null. */
  billLabel: string | null
}

const cents = (v: number | string | null | undefined) => Math.round(Number(v ?? 0) * 100)

/**
 * The receipt's figures for these rows (exported for the tests and any screen
 * that shows the same receipt). Credit counts when it is spent on a row
 * (applied) or set aside on it while the payment clears (held).
 */
export function receiptFigures(rows: Array<{
  type: string; amount: number | string; notes: string | null; entry_description?: string | null
  utility_type?: string | null; fee_type?: string | null; fee_description?: string | null
  /** chargeLabelColumnsSql: a reopened charge is named by the charge it was reopened from. */
  origin_notes?: string | null
  due_date: string; due_month_label?: string | null; credit_used: number | string
}>, creditBanked = 0): ReceiptFigures {
  const lines: ReceiptLine[] = rows.map(r => ({
    label: chargeLabel(r),
    // Rent's detail is the bill it is for; anything else, its read or period.
    detail: r.type === 'rent' ? `due ${r.due_date}` : chargeDetail(r),
    amount: Number(r.amount),
  }))
  const linesTotal = lines.reduce((s, l) => s + cents(l.amount), 0)
  const credit = Math.min(linesTotal, rows.reduce((s, r) => s + cents(r.credit_used), 0))
  const banked = Math.max(0, cents(creditBanked))
  const months = [...new Set(rows.map(r => r.due_month_label).filter(Boolean))]
  return {
    lines,
    linesTotal: linesTotal / 100,
    creditApplied: credit / 100,
    creditBanked: banked / 100,
    amount: (linesTotal - credit + banked) / 100,
    billLabel: months.length === 1 ? `${months[0]} bill` : null,
  }
}

interface ReceiptPayer { tenant_id: string; email: string | null; first_name: string | null; tenant_name: string | null }

/**
 * Who paid these rows: the caller's payerTenantId, else the tenant on the
 * remittance that paid them (the latest one that did not fail), else the
 * person the first row is billed to. A payer with no email gets no receipt:
 * it is never sent to someone else in their place.
 */
async function receiptPayer(
  opts: ReceiptOpts,
  first: { tenant_id: string; email: string | null; first_name: string | null; tenant_name: string | null },
): Promise<ReceiptPayer | null> {
  let payerId = opts.payerTenantId ?? null
  if (!payerId) {
    const rem = await query<{ tenant_id: string }>(
      `SELECT r.tenant_id
         FROM remittance_applications ra
         JOIN tenant_remittances r ON r.id = ra.remittance_id
        WHERE ra.payment_id = ANY($1::uuid[])
        ORDER BY (r.status = 'failed'), r.created_at DESC, r.id
        LIMIT 1`,
      [opts.paymentIds])
    payerId = rem[0]?.tenant_id ?? null
  }
  if (!payerId || payerId === first.tenant_id) {
    return { tenant_id: first.tenant_id, email: first.email, first_name: first.first_name, tenant_name: first.tenant_name }
  }
  const who = await query<ReceiptPayer>(
    `SELECT t.id AS tenant_id, u.email, u.first_name, TRIM(CONCAT_WS(' ', u.first_name, u.last_name)) AS tenant_name
       FROM tenants t JOIN users u ON u.id = t.user_id
      WHERE t.id = $1`,
    [payerId])
  return who[0] ?? null
}

/**
 * Send one receipt covering the rows settled in a single event.
 *
 * Never throws: a receipt that fails must not roll back money that has already
 * moved. Failures are logged and are visible in email_send_log by absence.
 */
export async function sendPaymentReceipt(opts: ReceiptOpts): Promise<string | null> {
  if (!opts.paymentIds.length) return null
  try {
    const rows = await query<any>(
      `SELECT p.id, p.type, p.amount::float AS amount, p.notes, p.entry_description, p.revenue_owner,
              ${chargeLabelColumnsSql('p')},
              to_char(p.due_date,'Mon FMDD, YYYY') AS due_date,
              to_char(COALESCE(inv.due_date, p.due_date),'FMMonth') AS due_month_label,
              COALESCE(p.settled_at, NOW()) AS paid_at,
              p.landlord_id, p.tenant_id,
              (SELECT COALESCE(SUM(cu.amount), 0) FROM credit_uses cu
                WHERE cu.payment_id = p.id AND cu.status IN ('held','applied'))::float AS credit_used,
              u.email, TRIM(CONCAT_WS(' ', u.first_name, u.last_name)) AS tenant_name,
              u.first_name,
              un.unit_number, un.property_id, pr.name AS property_name
         FROM payments p
         LEFT JOIN invoices inv ON inv.id = p.invoice_id
         JOIN tenants t ON t.id = p.tenant_id
         JOIN users u ON u.id = t.user_id
         JOIN units un ON un.id = p.unit_id
         JOIN properties pr ON pr.id = un.property_id
        WHERE p.id = ANY($1::uuid[])
        ORDER BY CASE p.type WHEN 'rent' THEN 0 WHEN 'utility' THEN 1
                             WHEN 'fee' THEN 2 ELSE 3 END, p.due_date, p.created_at`,
      [opts.paymentIds])
    if (!rows.length) return null

    const first = rows[0]
    const payer = await receiptPayer(opts, first)
    if (!payer?.email) return null

    const f = receiptFigures(rows, opts.creditBanked ?? 0)
    return await emailPaymentReceipt(payer.email, {
      tenantName: payer.first_name || payer.tenant_name || 'there',
      unitLabel: `Unit ${first.unit_number} — ${first.property_name}`,
      // What they handed over — the surplus is theirs too, and a receipt that
      // omits it reads as if we took the difference quietly. Credit that paid
      // part of the bill is not money they handed over, so it is not in it.
      amount: f.amount,
      method: opts.method,
      reference: opts.reference ?? null,
      paidAt: new Date(first.paid_at),
      lines: f.lines,
      pending: opts.pending === true,
      creditApplied: f.creditApplied,
      creditBanked: f.creditBanked,
      billLabel: f.billLabel,
      portalUrl: TENANT_APP_URL,
    }, {
      landlordId: first.landlord_id,
      tenantId: payer.tenant_id,
      paymentId: first.id,
      // 10/5: replies reach the people who run this property (services/replyRouting)
      // — unless the receipt covers a GAM product (FlexPay and the like), whose
      // questions are GAM's.
      replyTo: rows.every((r: any) => r.revenue_owner === 'landlord') ? replyToProperty(first.property_id) : undefined,
    })
  } catch (e) {
    logger.error({ err: e, paymentIds: opts.paymentIds }, '[receipt] could not send payment receipt')
    return null
  }
}

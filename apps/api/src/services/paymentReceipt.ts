// S637 (Nic): "Fix it so that people get an email confirmation of their receipt."
//
// One place that builds a receipt, used by every path money can arrive through —
// the desk recording cash or a check, and the Stripe webhook for card and ACH.
// A receipt is the same document to the person who paid however it arrived, and
// three copies of this logic would drift the way the fee rules nearly did
// (see manualPaymentSettle's header).
//
// Reads its own rows rather than taking figures from the caller: the caller
// knows what it settled, but the receipt has to say what the resident actually
// owes against, and that is the ledger's answer.
import { query } from '../db'
import { logger } from '../lib/logger'
import { emailPaymentReceipt } from './email'

const TENANT_APP_URL = process.env.TENANT_APP_URL || 'http://localhost:3002'

/** Human label for a charge row, matching what the tenant sees in the portal. */
function labelFor(row: { type: string; notes: string | null; due_date: string }): string {
  const note = (row.notes ?? '').split(' — ')[0].trim()
  if (row.type === 'utility' && note) return note
  if (row.type === 'rent') return `Rent — due ${row.due_date}`
  if (row.type === 'fee') return note || 'Fee'
  if (row.type === 'deposit') return 'Security deposit'
  return note || row.type
}

export interface ReceiptOpts {
  paymentIds: string[]
  method: string
  reference?: string | null
  /** ACH in flight — the money is submitted but has not cleared. */
  pending?: boolean
  creditBanked?: number
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
      `SELECT p.id, p.type, p.amount::float AS amount, p.notes,
              to_char(p.due_date,'Mon FYYYY') AS due_date_label,
              to_char(p.due_date,'Mon D, YYYY') AS due_date,
              COALESCE(p.settled_at, NOW()) AS paid_at,
              p.landlord_id, p.tenant_id,
              u.email, TRIM(CONCAT_WS(' ', u.first_name, u.last_name)) AS tenant_name,
              u.first_name,
              un.unit_number, pr.name AS property_name
         FROM payments p
         JOIN tenants t ON t.id = p.tenant_id
         JOIN users u ON u.id = t.user_id
         JOIN units un ON un.id = p.unit_id
         JOIN properties pr ON pr.id = un.property_id
        WHERE p.id = ANY($1::uuid[])
        ORDER BY CASE p.type WHEN 'rent' THEN 0 WHEN 'utility' THEN 1
                             WHEN 'fee' THEN 2 ELSE 3 END`,
      [opts.paymentIds])
    if (!rows.length) return null

    const first = rows[0]
    if (!first.email) return null

    const lines = rows.map((r: any) => ({ label: labelFor(r), amount: Number(r.amount) }))
    const total = Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100) / 100

    return await emailPaymentReceipt(first.email, {
      tenantName: first.first_name || first.tenant_name || 'there',
      unitLabel: `Unit ${first.unit_number} — ${first.property_name}`,
      // What they handed over — the surplus is theirs too, and a receipt that
      // omits it reads as if we took the difference quietly.
      amount: Math.round((total + (opts.creditBanked ?? 0)) * 100) / 100,
      method: opts.method,
      reference: opts.reference ?? null,
      paidAt: new Date(first.paid_at),
      lines,
      pending: opts.pending === true,
      creditBanked: opts.creditBanked,
      portalUrl: TENANT_APP_URL,
    }, {
      landlordId: first.landlord_id,
      tenantId: first.tenant_id,
      paymentId: first.id,
    })
  } catch (e) {
    logger.error({ err: e, paymentIds: opts.paymentIds }, '[receipt] could not send payment receipt')
    return null
  }
}

/**
 * S641 — tell the tenant their bill exists.
 *
 * Nic: "a lot of people are saying, oh, I never got my bill. I don't know what
 * I owe."
 *
 * Invoice generation sent no email at all. In the thirty days before this was
 * written, the only billing mail any tenant received was 197 LATE notices: we
 * never announced a bill, then chased people for missing it.
 *
 * Deliberately a SEPARATE PASS rather than a send inside the generation
 * transaction. Three reasons: a mail provider timing out must never roll back
 * an invoice; a send that fails can be retried on the next pass without
 * double-billing anybody; and the catch-up/backfill paths get the same
 * behaviour for free.
 *
 * `invoices.sent_at` already existed and had never been set on a single row —
 * it is exactly the "the tenant has been told" stamp, so no migration.
 */
import { allocateCredits } from '@gam/shared'
import { query, queryOne } from '../db'
import { logger } from '../lib/logger'
import { emailInvoiceReady } from './email'
import { portalLink } from '../lib/portalUrls'

/**
 * How recent an invoice has to be for us to announce it.
 *
 * A bill from three months ago is not news, and a backfill or an admin
 * catch-up run must never turn into a mailout. Anything older simply is not
 * picked up — it is NOT stamped as sent, because claiming we told somebody
 * when we did not is the failure this whole file exists to fix.
 */
const DEFAULT_WITHIN_DAYS = 7

export interface InvoiceNoticeResult {
  considered: number
  sent: number
  skippedNoEmail: number
  failed: number
}

interface PendingInvoice {
  id: string
  landlord_id: string
  tenant_id: string | null
  invoice_number: string
  due_date: string
  due_label: string
  total_amount: string
  work_trade_credit_amount: string
  unit_number: string | null
  property_name: string | null
  tenant_email: string | null
  tenant_first_name: string | null
  landlord_name: string | null
}

/** The same plain-English labelling the landlord's balance reminder uses. */
function labelFor(row: { type: string; notes: string | null }): string {
  const note = String(row.notes ?? '').split(' — ')[0].trim()
  if (row.type === 'rent') return 'Rent'
  if (row.type === 'utility') return note || 'Utilities'
  if (row.type === 'deposit') return 'Security deposit'
  if (row.type === 'late_fee') return 'Late fee'
  return note || row.type.replace(/_/g, ' ')
}

/**
 * Announce every freshly generated invoice that the tenant has not been told
 * about. Idempotent: `sent_at` is stamped on success, so a re-run is a no-op.
 */
export async function sendPendingInvoiceNotices(
  opts: { withinDays?: number; timezone?: string; invoiceId?: string } = {},
): Promise<InvoiceNoticeResult> {
  const withinDays = opts.withinDays ?? DEFAULT_WITHIN_DAYS
  const result: InvoiceNoticeResult = { considered: 0, sent: 0, skippedNoEmail: 0, failed: 0 }

  const pending = await query<PendingInvoice>(`
    SELECT i.id, i.landlord_id, i.tenant_id, i.invoice_number,
           to_char(i.due_date, 'YYYY-MM-DD') AS due_date,
           to_char(i.due_date, 'FMMonth FMDD, YYYY') AS due_label,
           i.total_amount::text,
           i.work_trade_credit_amount::text,
           u.unit_number, p.name AS property_name,
           tu.email      AS tenant_email,
           tu.first_name AS tenant_first_name,
           COALESCE(NULLIF(l.business_name, ''), lu.first_name || ' ' || lu.last_name) AS landlord_name
      FROM invoices i
      JOIN units u       ON u.id = i.unit_id
      JOIN properties p  ON p.id = u.property_id
      JOIN landlords l   ON l.id = i.landlord_id
      JOIN users lu      ON lu.id = l.user_id
      LEFT JOIN tenants t ON t.id = i.tenant_id
      LEFT JOIN users tu  ON tu.id = t.user_id
     WHERE i.sent_at IS NULL
       AND ($3::uuid IS NULL OR i.id = $3::uuid)
       AND ($3::uuid IS NOT NULL OR i.due_date >= CURRENT_DATE - ($1::int || ' days')::interval)
       AND ($2::text IS NULL OR p.timezone = $2::text)
     ORDER BY i.due_date, i.invoice_number
  `, [withinDays, opts.timezone ?? null, opts.invoiceId ?? null])

  result.considered = pending.length

  for (const inv of pending) {
    if (!inv.tenant_email) {
      // No address on file. Leave sent_at NULL so it is visibly un-announced
      // rather than silently marked done.
      result.skippedNoEmail++
      continue
    }
    try {
      // Charge lines come from the payment rows this invoice created. Work-trade
      // suspended rows are excluded from the list and shown as one credit line:
      // they are real charges that nobody owes.
      const lines = await query<{ type: string; notes: string | null; amount: string }>(
        `SELECT type, notes, amount::text
           FROM payments
          WHERE invoice_id = $1 AND work_trade_suspended_at IS NULL
          ORDER BY CASE type WHEN 'rent' THEN 0 WHEN 'deposit' THEN 1 ELSE 2 END, created_at`,
        [inv.id])

      // S648 (Nic): "every dollar should only be counted once." Every invoice
      // email used to claim the person's WHOLE credit, so two bills in one run
      // each showed it coming off. Spent once across their open bills with this
      // landlord, oldest first, lease-tied credits only on their own lease.
      const pool = await query<{ lease_id: string | null; amount: string }>(
        `SELECT lease_id, amount_remaining::text AS amount
           FROM tenant_credits
          WHERE tenant_id = $1 AND landlord_id = $2
            AND status = 'active' AND amount_remaining > 0`,
        [inv.tenant_id, inv.landlord_id])
      const openBills = pool.length ? await query<{ id: string; lease_id: string | null; open: string; due: string }>(
        `SELECT i.id, i.lease_id, to_char(i.due_date, 'YYYY-MM-DD') AS due,
                (i.total_amount - COALESCE((SELECT SUM(p.amount) FROM payments p
                   WHERE p.invoice_id = i.id
                     AND (p.status IN ('settled','processing') OR p.work_trade_suspended_at IS NOT NULL)), 0))::text AS open
           FROM invoices i
          WHERE i.tenant_id = $1 AND i.landlord_id = $2
            AND (i.status IN ('pending','partial') OR i.id = $3)`,
        [inv.tenant_id, inv.landlord_id, inv.id]) : []

      const invoiceTotal = Number(inv.total_amount)
      const creditApplied = pool.length
        ? Math.min(Math.max(0, invoiceTotal), allocateCredits(
            pool.map(c => ({ leaseId: c.lease_id, amount: Number(c.amount) })),
            openBills.map(b => ({ key: b.id, leaseId: b.lease_id, total: Number(b.open), earliestDue: b.due })),
          ).applied[inv.id] ?? 0)
        : 0
      const total = Math.round((invoiceTotal - creditApplied) * 100) / 100

      await emailInvoiceReady(inv.tenant_email, {
        tenantName: inv.tenant_first_name || 'there',
        unitLabel: [inv.property_name, inv.unit_number].filter(Boolean).join(' — ')
          || inv.unit_number || 'your unit',
        invoiceNumber: inv.invoice_number,
        dueDateLabel: inv.due_label,
        total,
        lines: lines.map(l => ({ label: labelFor(l), amount: Number(l.amount) })),
        workTradeCredit: Number(inv.work_trade_credit_amount) || 0,
        creditApplied,
        portalUrl: portalLink('tenant', 'payments'),
        landlordName: inv.landlord_name || undefined,
      }, { landlordId: inv.landlord_id, tenantId: inv.tenant_id ?? undefined, invoiceId: inv.id })

      await query(`UPDATE invoices SET sent_at = NOW() WHERE id = $1`, [inv.id])
      result.sent++
    } catch (e) {
      // One bad address must not stop the rest of the run, and the invoice
      // stays un-stamped so the next pass tries again.
      result.failed++
      logger.error({ err: e, invoiceId: inv.id }, '[invoice-notice] send failed')
    }
  }

  return result
}

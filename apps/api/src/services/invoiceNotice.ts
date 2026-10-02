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
 * behavior for free.
 *
 * `invoices.sent_at` already existed and had never been set on a single row —
 * it is exactly the "the tenant has been told" stamp, so no migration.
 */
import { allocateCredits } from '@gam/shared'
import { query, queryOne } from '../db'
import { logger } from '../lib/logger'
import { emailInvoiceReady } from './email'
import { portalLink } from '../lib/portalUrls'
import { signEmailFactorToken } from '../routes/emailOtp'

// S654 (Nic): the Pay now link signs the resident in with just their password.
// Opening it proves the inbox, which is what the emailed code was for — so no
// leaving the app to go find a code, which is where phones were losing people.
// Lands on Payments. A row with no portal account keeps the plain link.
// Exported (S654) so every tenant email that sends someone to pay uses this one
// link, not a hand-built /payments URL that still asks for the code.
// `to` picks the landing page (S654: a FlexDeposit installment is funded from
// the Lease page, not Payments); every caller that omits it lands on Payments.
export function payNowLink(
  inv: { tenant_user_id: string | null; tenant_email: string | null },
  to: '/payments' | '/lease' = '/payments',
): string {
  if (!inv.tenant_user_id || !inv.tenant_email) return portalLink('tenant', to.slice(1))
  const ef = signEmailFactorToken({ userId: inv.tenant_user_id, email: inv.tenant_email })
  return portalLink('tenant', `login?ef=${encodeURIComponent(ef)}&to=${encodeURIComponent(to)}`)
}


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
  /** S654: work-trade months with nothing owed — told nothing, on purpose. */
  skippedCovered: number
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
  work_trade_agreement_id: string | null
  unit_number: string | null
  property_name: string | null
  tenant_user_id: string | null
  tenant_email: string | null
  tenant_first_name: string | null
  landlord_name: string | null
}

/** The same plain-English labeling the landlord's balance reminder uses. */
export function labelFor(row: { type: string; notes: string | null }): string {
  const note = String(row.notes ?? '').split(' — ')[0].trim()
  if (row.type === 'rent') return 'Rent'
  if (row.type === 'utility') return note || 'Utilities'
  if (row.type === 'deposit') return note || 'Security deposit'
  if (row.type === 'late_fee') return 'Late fee'
  return note || row.type.replace(/_/g, ' ')
}

/**
 * Announce every freshly generated invoice that the tenant has not been told
 * about. Idempotent: `sent_at` is stamped on success, so a re-run is a no-op.
 */
export async function sendPendingInvoiceNotices(
  opts: { withinDays?: number; timezone?: string; invoiceId?: string; updated?: boolean } = {},
): Promise<InvoiceNoticeResult> {
  const withinDays = opts.withinDays ?? DEFAULT_WITHIN_DAYS
  const result: InvoiceNoticeResult = { considered: 0, sent: 0, skippedNoEmail: 0, skippedCovered: 0, failed: 0 }

  const pending = await query<PendingInvoice>(`
    SELECT i.id, i.landlord_id, i.tenant_id, i.invoice_number,
           to_char(i.due_date, 'YYYY-MM-DD') AS due_date,
           to_char(i.due_date, 'FMMonth FMDD, YYYY') AS due_label,
           i.total_amount::text,
           i.work_trade_credit_amount::text,
           i.work_trade_agreement_id,
           u.unit_number, p.name AS property_name,
           tu.id         AS tenant_user_id,
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
       -- S652 (Nic): Donald Hamp paid his first bill by check the day it was
       -- made, and the next morning's pass mailed him "$137.43 due". A bill
       -- that is already settled (or voided) is never announced as due.
       AND i.status NOT IN ('settled', 'void')
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
      const lines = await query<{ type: string; notes: string | null; amount: string; status: string; lease_id: string | null }>(
        `SELECT type, notes, amount::text, status, lease_id
           FROM payments
          WHERE invoice_id = $1 AND work_trade_suspended_at IS NULL
          ORDER BY CASE type WHEN 'rent' THEN 0 WHEN 'deposit' THEN 1 ELSE 2 END, created_at`,
        [inv.id])
      // S654 (Nic): "Work trade people are on work trade. There's no bills going
      // out to those people." A month the trade covers in full has nothing to
      // announce — every line is suspended and the total is zero. Stamped as
      // told so the next pass does not keep reconsidering it; a trade that
      // leaves something owed (a utility the agreement does not cover) is a
      // real bill and goes out with only the owed lines on it.
      if (inv.work_trade_agreement_id && lines.length === 0) {
        await query(`UPDATE invoices SET sent_at = NOW() WHERE id = $1`, [inv.id])
        result.skippedCovered++
        continue
      }
      // S653 (Nic): "most people are going to see that email, think they owe
      // $900 or whatever... they just saw the headline." The headline is what
      // they will actually be asked for: what is still OPEN on this bill, less
      // the paid-ahead money this month may use, less any credit on account.
      // A line already settled — covered by paid-ahead credit when the bill
      // was made, or a check that beat the email — is shown as covered, not due.
      const paidAlready = Math.round(lines
        .filter(l => l.status === 'settled' || l.status === 'processing')
        .reduce((s, l) => s + Number(l.amount), 0) * 100) / 100

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
                -- S654: a suspended work-trade line is already outside
                -- total_amount (the S634 shape, every writer); netting it again
                -- here drove these balances negative.
                (i.total_amount - COALESCE((SELECT SUM(p.amount) FROM payments p
                   WHERE p.invoice_id = i.id
                     AND p.status IN ('settled','processing')), 0))::text AS open
           FROM invoices i
          WHERE i.tenant_id = $1 AND i.landlord_id = $2
            AND (i.status IN ('pending','partial') OR i.id = $3)`,
        [inv.tenant_id, inv.landlord_id, inv.id]) : []

      const invoiceTotal = Number(inv.total_amount)
      const openNow = Math.round(Math.max(0, invoiceTotal - paidAlready) * 100) / 100
      // S653: the paid-ahead money this bill's month may still use (capped by
      // the resident's monthly draw, if they set one). It is netted when they
      // pay, so the headline nets it now.
      const leaseId = lines.find(l => l.lease_id)?.lease_id ?? null
      let prepaidApplied = 0
      if (leaseId && openNow > 0) {
        const { prepaidDrawAvailable } = await import('./prepaidRelease')
        const { db } = await import('../db')
        const month = inv.due_date.slice(0, 7) + '-01'
        prepaidApplied = Math.min(openNow, (await prepaidDrawAvailable(db as any, leaseId, month)).available)
      }
      const creditApplied = pool.length
        ? Math.min(Math.max(0, openNow - prepaidApplied), allocateCredits(
            pool.map(c => ({ leaseId: c.lease_id, amount: Number(c.amount) })),
            openBills.map(b => ({ key: b.id, leaseId: b.lease_id, total: Number(b.open), earliestDue: b.due })),
          ).applied[inv.id] ?? 0)
        : 0
      const total = Math.round((openNow - prepaidApplied - creditApplied) * 100) / 100

      await emailInvoiceReady(inv.tenant_email, {
        tenantName: inv.tenant_first_name || 'there',
        unitLabel: [inv.property_name, inv.unit_number].filter(Boolean).join(' — ')
          || inv.unit_number || 'your unit',
        invoiceNumber: inv.invoice_number,
        dueDateLabel: inv.due_label,
        total,
        lines: lines.map(l => ({
          label: labelFor(l), amount: Number(l.amount),
          covered: l.status === 'settled' || l.status === 'processing',
          coveredHow: (l.notes ?? '').includes('prepaid credit') ? 'paid-ahead credit' : 'already paid',
        })),
        workTradeCredit: Number(inv.work_trade_credit_amount) || 0,
        prepaidApplied,
        creditApplied,
        portalUrl: payNowLink(inv),
        landlordName: inv.landlord_name || undefined,
        updated: !!opts.updated,
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

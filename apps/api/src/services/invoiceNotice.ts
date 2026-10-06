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
import {
  UTILITY_TYPE_LABEL, LEASE_COLUMN_LABEL, PAYMENT_ENTRY_DESCRIPTION_LABELS, humanize, type UtilityType,
} from '@gam/shared'
import { query } from '../db'
import { logger } from '../lib/logger'
import { emailInvoiceReady } from './email'
import { replyToProperty } from './replyRouting'
import { portalLink } from '../lib/portalUrls'
import { signEmailFactorToken } from '../routes/emailOtp'
import { creditBeside, openBalanceSql, openAmountSql } from './openBalances'

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
  property_id: string
  property_name: string | null
  tenant_user_id: string | null
  tenant_email: string | null
  tenant_first_name: string | null
  landlord_name: string | null
}

// ─── What a charge line is called (decisions #17) ────────────────────────────
//
// Nic (10/3): "Bill and email lines name the utility: 'Water', 'Electric',
// 'Trash', 'Sewer' — never a generic 'Utilities' line." Kim Harland's October
// email read "Utilities $10.45" (her water) and "Utilities $25" (her trash).
// And a line was named after whatever its note said first, so a utility the
// desk had recorded read "Recorded as manual money_order payment (ref …)".
//
// One labeler, used by every place a charge is written out to a person: the
// bill email, the balance reminder, the receipt, the Outstanding breakdown, the
// agents (and the portal, through the API that carries `label`). The NAME
// comes from what the charge is — the utility bill it pays
// (utility_bills.payment_id → utility_type), its lease fee, its entry code, its
// type; the note only supplies the DETAIL (the meter read, the period), and a
// payment tag in a note ("Recorded as …", "covered by …", "Work trade — …") is
// never either.

export interface ChargeLabelRow {
  type: string
  notes?: string | null
  entry_description?: string | null
  /** utility_bills.utility_type of the bill this charge pays (chargeLabelColumnsSql). */
  utility_type?: string | null
  /** lease_fees.fee_type behind the charge (chargeLabelColumnsSql). */
  fee_type?: string | null
  /** lease_fees.description: the landlord's own name for the fee, when they gave one. */
  fee_description?: string | null
  /**
   * A reopened charge only: the note of the charge first billed, the one a
   * dispute or bank return reopened it from (chargeLabelColumnsSql). Its own
   * note is only the reopen tag, so its name and detail come from this one.
   */
  origin_notes?: string | null
}

const SQL_ALIAS = /^[a-z_][a-z0-9_]*$/i

/**
 * The charges a line takes its name from, as a recursive WITH named `a` (id,
 * lease_fee_id, notes, reversal_id, depth): the charge itself (depth 0), then,
 * when a dispute or bank return reopened it (payments.reversal_id), the charge
 * it was reopened from, and so on back to the charge first billed (a reopened
 * line that was paid and disputed again). paymentReversal writes the reopened
 * row with no utility bill, no lease fee and only its reopen note, so a
 * disputed Water line read "Utility" everywhere it was owed again.
 */
function labelSourcesSql(p: string, a: string): string {
  return `WITH RECURSIVE ${a}(id, lease_fee_id, notes, reversal_id, depth) AS (
            SELECT ${p}.id, ${p}.lease_fee_id, ${p}.notes, ${p}.reversal_id, 0
            UNION ALL
            SELECT ${a}_o.id, ${a}_o.lease_fee_id, ${a}_o.notes, ${a}_o.reversal_id, ${a}_s.depth + 1
              FROM ${a} ${a}_s
              JOIN payment_reversals ${a}_rv ON ${a}_rv.id = ${a}_s.reversal_id
              JOIN payments ${a}_o ON ${a}_o.id = ${a}_rv.payment_id
             WHERE ${a}_s.depth < 8)`
}

/**
 * The columns chargeLabel/chargeDetail read beyond the payments row itself
 * (`p` is the payments alias, or a CTE over payments.*): utility_type,
 * fee_type, fee_description and origin_notes. A charge a dispute or bank
 * return reopened is named by the charge it was reopened from (decisions #17:
 * a disputed Water line is still "Water" — on Outstanding, the ledger, the bill
 * email, the balance reminder and the receipt), its own utility bill or lease
 * fee first when it has one.
 */
export function chargeLabelColumnsSql(p = 'p'): string {
  if (!SQL_ALIAS.test(p)) throw new Error(`chargeLabelColumnsSql: "${p}" is not a table alias`)
  const feeId = `CASE WHEN ${p}.reversal_id IS NULL THEN ${p}.lease_fee_id
                      ELSE (${labelSourcesSql(p, 'ls_f')}
                            SELECT ls_f.lease_fee_id FROM ls_f
                             WHERE ls_f.lease_fee_id IS NOT NULL ORDER BY ls_f.depth LIMIT 1) END`
  return `CASE WHEN ${p}.reversal_id IS NULL
               THEN (SELECT ub_l.utility_type FROM utility_bills ub_l
                      WHERE ub_l.payment_id = ${p}.id ORDER BY ub_l.created_at, ub_l.id LIMIT 1)
               ELSE (${labelSourcesSql(p, 'ls_u')}
                     SELECT ub_l.utility_type FROM ls_u JOIN utility_bills ub_l ON ub_l.payment_id = ls_u.id
                      ORDER BY ls_u.depth, ub_l.created_at, ub_l.id LIMIT 1) END AS utility_type,
          (SELECT lf_l.fee_type FROM lease_fees lf_l WHERE lf_l.id = ${feeId}) AS fee_type,
          (SELECT NULLIF(btrim(lf_l.description), '') FROM lease_fees lf_l WHERE lf_l.id = ${feeId}) AS fee_description,
          CASE WHEN ${p}.reversal_id IS NOT NULL
               THEN (${labelSourcesSql(p, 'ls_n')}
                     SELECT ls_n.notes FROM ls_n WHERE ls_n.depth > 0 ORDER BY ls_n.depth DESC LIMIT 1) END AS origin_notes`
}

const UTILITY_WORDS: Array<[RegExp, UtilityType]> = [
  [/\belectric(ity)?\b/i, 'electric'],
  [/\bwater\b/i, 'water'],
  [/\bsewer\b/i, 'sewer'],
  [/\b(natural )?gas\b/i, 'gas'],
  [/\btrash\b/i, 'trash'],
  [/\bpropane\b/i, 'propane'],
]
/**
 * A note segment that is about the PAYMENT, never the charge. 10/5: so are
 * "paid in part; $X still owed" (a part payment's paid slice) and "partly paid
 * toward the old balance; …" / "part of the old balance; …" (an old balance
 * paid down) — never shown as what the charge is.
 */
const TAG = /^(recorded as|covered by|paid (with|on time|off-platform|in full|in part)|partly paid|part of the old balance|work trade|suspended|waived|reopened|corrected|correction|settled|refunded|s\d{3,}:)/i
/** A note segment that only names the space ("RV 44"): the bill already says where. */
const SPACE_ONLY = /^(rv|mh|apt|apartment|unit|lot|site|space|spot|house|cabin|storage)\s*#?\s*[\w-]{1,6}$/i

function noteSegments(notes: string | null | undefined): string[] {
  return String(notes ?? '').split(' — ').map(x => x.trim()).filter(Boolean)
}
/** The note's segments that describe the charge: no payment tags, no bare space name. */
function describingSegments(notes: string | null | undefined): string[] {
  return noteSegments(notes).filter(x => !TAG.test(x) && !SPACE_ONLY.test(x))
}

/**
 * The segments that describe this charge: its own note's, or — a reopened
 * charge — the note of the charge it was reopened from (origin_notes).
 * paymentReversal writes a reopened row's note as the FIRST segment of the
 * note it reopened plus the reopen tag ("Final electric — reopened after a
 * payment reversal"), so that copied head is the original cut short: a final
 * meter bill "Final electric — meter 100 → 200" would lose its read on every
 * bill, receipt and reminder that shows the line owed again. When the row's
 * own note is only that copy (or only the tag), the original's segments are
 * read whole, with anything the row's note adds after them. A reopened row
 * whose note was written to say something else keeps its own words.
 */
function chargeSegments(row: ChargeLabelRow): string[] {
  const own = describingSegments(row.notes)
  const origin = describingSegments(row.origin_notes)
  if (!origin.length) return own
  const originHead = (noteSegments(row.origin_notes)[0] ?? '').toLowerCase()
  const copiedHead = !!originHead && (noteSegments(row.notes)[0] ?? '').toLowerCase() === originHead
  if (own.length && !copiedHead) return own
  const seen = new Set(origin.map(s => s.toLowerCase()))
  return [...origin, ...own.filter(s => !seen.has(s.toLowerCase()))]
}

/** The utility a charge is for: its bill's type, then PROPANE, then the note's own words. */
export function utilityOf(row: ChargeLabelRow): UtilityType | null {
  const t = String(row.utility_type ?? '').toLowerCase()
  if (t && t in UTILITY_TYPE_LABEL) return t as UtilityType
  if (String(row.entry_description ?? '').toUpperCase() === 'PROPANE') return 'propane'
  for (const seg of chargeSegments(row)) {
    for (const [re, type] of UTILITY_WORDS) if (re.test(seg)) return type
  }
  return null
}

/** A lease fee's name on a bill: "Pet rent", "Trash" — the lease column label without its "(monthly)". */
function feeName(feeType: string): string {
  if (feeType === 'trash_fee') return UTILITY_TYPE_LABEL.trash
  const label = (LEASE_COLUMN_LABEL as Record<string, string | undefined>)[feeType]
  return label ? label.replace(/\s*\([^)]*\)\s*$/, '') : humanize(feeType)
}

/** What a charge line is called, in plain words. Never "Utilities". */
export function chargeLabel(row: ChargeLabelRow): string {
  const entry = String(row.entry_description ?? '').toUpperCase()
  const firstNote = chargeSegments(row)[0] ?? ''
  switch (row.type) {
    case 'rent': return 'Rent'
    case 'utility': {
      const u = utilityOf(row)
      return u ? UTILITY_TYPE_LABEL[u] : 'Utility'
    }
    case 'late_fee': return 'Late fee'
    case 'home_payment': return 'Home payment'
    case 'carried_balance': return 'Earlier balance'
    case 'deposit':
      return row.fee_description || (row.fee_type ? feeName(row.fee_type) : 'Security deposit')
  }
  if (row.fee_type) return row.fee_description || feeName(row.fee_type)
  if (entry === 'PROPANE') return UTILITY_TYPE_LABEL.propane
  if (entry === 'DEPOSIT') return 'Security deposit'
  const coded = (PAYMENT_ENTRY_DESCRIPTION_LABELS as Record<string, string | undefined>)[entry]
  if (coded) return coded
  if (firstNote) return firstNote.length > 60 ? `${firstNote.slice(0, 57)}…` : firstNote
  return row.type === 'fee' ? 'Fee' : humanize(row.type)
}

/**
 * The detail behind a line, when its note carries one: the meter read, the
 * period, the installment — never a payment tag, never the line's own name
 * again. null when there is nothing to add.
 */
export function chargeDetail(row: ChargeLabelRow): string | null {
  const label = chargeLabel(row).toLowerCase()
  const out: string[] = []
  for (const seg of chargeSegments(row)) {
    const lower = seg.toLowerCase()
    if (lower === label) continue
    // "Electric meter 44999 → 45219 …" under "Electric": the read, not the word again.
    const rest = lower.startsWith(label + ' ') ? seg.slice(label.length).trim() : seg
    if (rest && rest.toLowerCase() !== label) out.push(rest)
  }
  // The note is the label itself when the charge has no other name ("Fee" from a note).
  const detail = out.join(' — ')
  return detail && detail.toLowerCase() !== label ? detail : null
}

/** @deprecated name kept for existing callers: chargeLabel. */
export const labelFor = (row: ChargeLabelRow): string => chargeLabel(row)

/** Why a line on the bill is not owed: a tag beside it, never its name. */
function coveredHow(l: { status: string; amount: string; credit_applied: string; open: boolean }): string {
  if (l.status === 'processing' || (l.status === 'pending' && !l.open)) return 'payment clearing'
  if (l.status === 'paid_via_deposit') return 'taken from the deposit'
  const amt = Math.round(Number(l.amount) * 100)
  if (amt > 0 && Math.round(Number(l.credit_applied) * 100) >= amt) return 'paid with your account credit'
  return 'already paid'
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
           u.unit_number, u.property_id, p.name AS property_name,
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
      // they are real charges that nobody owes. GAM's FlexPay pull is never part
      // of a tenant's bill.
      const lines = await query<{
        id: string; type: string; notes: string | null; entry_description: string | null
        amount: string; status: string; lease_id: string | null
        utility_type: string | null; fee_type: string | null; fee_description: string | null
        open: boolean; open_amount: string; credit_applied: string
      }>(
        `SELECT p.id, p.type, p.notes, p.entry_description, p.amount::text, p.status, p.lease_id,
                ${chargeLabelColumnsSql('p')},
                ${openBalanceSql('p')} AS open,
                ${openAmountSql('p')}::text AS open_amount,
                COALESCE((SELECT SUM(u.amount) FROM credit_uses u
                           WHERE u.payment_id = p.id AND u.status = 'applied'), 0)::text AS credit_applied
           FROM payments p
          WHERE p.invoice_id = $1 AND p.work_trade_suspended_at IS NULL
            AND p.entry_description IS DISTINCT FROM 'FLEXPAY'
            -- a disputed original: its reopened row is the line that is owed
            AND p.status <> 'returned'
          ORDER BY CASE p.type WHEN 'rent' THEN 0 WHEN 'deposit' THEN 1 ELSE 2 END, p.created_at`,
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

      // S655 (Nic, 10/2): THE FULL BILL. The headline is what this bill still
      // owes — every line that is open, at what it still owes — with nothing
      // taken off for credit: "credit auto-applies only when it covers the
      // WHOLE bill; otherwise the tenant is asked" when they pay. A line that
      // was already paid (a check that beat the email, a bill the account
      // credit paid in full) is listed as covered, not due.
      const total = Math.round(lines.reduce((s, l) => s + (l.open ? Math.round(Number(l.open_amount) * 100) : 0), 0)) / 100

      // The credit Pay Now will offer them for this bill: the household plan's
      // share for this lease (oldest bill first, eligible lines only, within a
      // monthly draw cap). Said beside the bill, never netted off it.
      const leaseId = lines.find(l => l.lease_id)?.lease_id ?? null
      let creditAvailable = 0
      if (leaseId && inv.tenant_id && total > 0) {
        const c = await creditBeside({ tenantId: inv.tenant_id, landlordIds: [inv.landlord_id], leaseIds: [leaseId] })
        creditAvailable = c.usableByLease.get(leaseId) ?? 0
      }

      await emailInvoiceReady(inv.tenant_email, {
        tenantName: inv.tenant_first_name || 'there',
        unitLabel: [inv.property_name, inv.unit_number].filter(Boolean).join(' — ')
          || inv.unit_number || 'your unit',
        invoiceNumber: inv.invoice_number,
        dueDateLabel: inv.due_label,
        total,
        lines: lines.map(l => ({
          label: chargeLabel(l),
          detail: chargeDetail(l),
          amount: Number(l.amount),
          covered: !l.open,
          coveredHow: coveredHow(l),
        })),
        workTradeCredit: Number(inv.work_trade_credit_amount) || 0,
        creditAvailable,
        portalUrl: payNowLink(inv),
        landlordName: inv.landlord_name || undefined,
        updated: !!opts.updated,
      }, {
        landlordId: inv.landlord_id, tenantId: inv.tenant_id ?? undefined, invoiceId: inv.id,
        // 10/5: replies reach the people who run this property (services/replyRouting).
        replyTo: replyToProperty(inv.property_id),
      })

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

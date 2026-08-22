import { DateTime } from 'luxon'
import type { PoolClient } from 'pg'
import { getClient, query } from '../db'
import { logger } from '../lib/logger'
import { ensureBillsForUnit } from '../services/utilityBilling'
import { allocateInvoiceNumber } from '../services/invoiceNumbers'
import { registerEngine } from './timezoneCronManager'
import { dueDatesInRange } from './invoiceGeneration'

// ============================================================
// S615 (Nic, LAUNCH-CRITICAL) — the invoice for a space with no lease.
//
//   "We need to fix the billing for utilities next door immediately, because we
//    already collect from those units next door. That is an Oak Park launch
//    necessity. That's seventy-five dollars in trash cans and utilities on one
//    electric submeter from next door."
//
// S614 built the attribution: a utility_bills row can name a SERVICE AGREEMENT
// instead of a lease, so the three trash cans and the one submetered apartment
// next door finally have a payer. It stopped at the money. invoiceGeneration
// iterates ACTIVE LEASES, so those bills were written and then sat there —
// never on a document, never collectable, still cash in hand across the fence.
//
// This is the parallel driver. It is deliberately a SEPARATE loop rather than a
// branch inside invoiceGeneration, because almost nothing in that function
// applies here: no rent, no monthly fees, no proration, no move-in bundle to
// avoid double-billing, no sublease, no booking schedule, no work trade (there
// is no labour arrangement with the neighbour), no prepaid rent. Threading a
// "lease might be null" flag through 900 lines of rent logic to reach the ~80
// that matter would put every rent tenant one null-check away from a bad bill.
//
// What it DOES share, deliberately, because they must not drift:
//   · dueDatesInRange   — the same cycle math, including the short-month clamp
//   · ensureBillsForUnit — the same per-unit billing readiness
//   · allocateInvoiceNumber — one invoice sequence per landlord, not two
//
// WHAT IS INTENTIONALLY ABSENT: the S534 read-hold. A leased unit holds its
// WHOLE invoice (rent included) when a tenant-responsible meter is unread,
// because sending rent without the utilities means two documents and a
// confused tenant. Here the utilities ARE the invoice — an unread meter means
// there is simply nothing to bill this cycle, and the bill rides the next one
// via the same two-cycle straggler lookback every other utility charge uses.
// Cutting a $0 invoice instead would be a document that says nothing.
// ============================================================

export interface ServiceInvoiceResult {
  invoicesInserted: number
  utilitiesInserted: number
  agreementsProcessed: number
}

interface ActiveAgreement {
  id: string
  landlord_id: string
  unit_id: string
  tenant_id: string
  billing_due_day: number
  start_date: string
  end_date: string | null
  property_tz: string
}

const CATCHUP_DAYS = 30

/**
 * Cut invoices for every agreement in `agreements`, for every due date in the
 * catch-up window that does not already have one.
 */
async function runServiceGeneration(
  agreements: ActiveAgreement[],
  nowUtc: Date,
): Promise<ServiceInvoiceResult> {
  let invoicesInserted = 0
  let utilitiesInserted = 0

  for (const sa of agreements) {
    const agreementStart = DateTime.fromISO(sa.start_date, { zone: sa.property_tz })
    const agreementEnd = sa.end_date
      ? DateTime.fromISO(sa.end_date, { zone: sa.property_tz })
      : null

    const todayInTz = DateTime.fromJSDate(nowUtc, { zone: sa.property_tz }).startOf('day')
    const catchupStart = todayInTz.minus({ days: CATCHUP_DAYS })
    const windowStart = catchupStart > agreementStart ? catchupStart : agreementStart
    const windowEnd = agreementEnd && agreementEnd < todayInTz ? agreementEnd : todayInTz
    if (windowEnd < windowStart) continue

    const dueDates = dueDatesInRange(windowStart, windowEnd, sa.billing_due_day)
    if (dueDates.length === 0) continue

    for (const dueDate of dueDates) {
      // Generate whatever this space's readings now support. Same call the
      // lease path makes, and for the same reason: billing readiness is
      // per-unit, so one unread meter elsewhere on the property never holds
      // this space's charges.
      try {
        await ensureBillsForUnit(sa.unit_id, dueDate)
      } catch (e) {
        logger.error({ err: e, agreementId: sa.id, dueDate },
          '[ServiceInvoice] bill generation failed — invoice attempt continues with existing bills')
      }

      // Every uninvoiced bill on this agreement whose cycle has arrived.
      // Prior-cycle stragglers ride along, exactly as they do on a lease
      // invoice, so a late meter read is billed rather than lost.
      const bills = await query<{
        id: string
        charge_amount: string
        utility_type: string
        allocation_method: string
        allocation_basis: string | null
        rate_per_unit: string | null
        usage_amount: string | null
        reading_start: string | null
        reading_end: string | null
        reading_start_date: string | null
        reading_end_date: string | null
        digits: number | null
      }>(
        `SELECT ub.id, (ub.charge_amount + ub.tax_amount)::text AS charge_amount,
                ub.utility_type, ub.allocation_method, ub.allocation_basis,
                ub.rate_per_unit, ub.usage_amount,
                ub.reading_start, ub.reading_end,
                ub.reading_start_date, ub.reading_end_date, m.digits
           FROM utility_bills ub
           JOIN utility_meters m ON m.id = ub.meter_id
          WHERE ub.service_agreement_id = $1
            AND ub.payment_id IS NULL
            AND ub.status IN ('unbilled','billed')
            AND ub.billing_cycle_month <= date_trunc('month', $2::date)::date
          ORDER BY ub.billing_cycle_month ASC, ub.id ASC`,
        [sa.id, dueDate],
      )

      // Nothing to say — say nothing. A $0 invoice for a space whose meter has
      // not been read yet is noise to the payer and clutter on the ledger, and
      // it would burn this cycle's idempotency key so the real charge could
      // never land on it once the read arrives.
      if (bills.length === 0) continue

      const total = bills.reduce((s, b) => s + Number(b.charge_amount), 0)

      const client = await getClient()
      try {
        await client.query('BEGIN')
        const year = DateTime.fromISO(dueDate).year
        const invoiceNumber = await allocateInvoiceNumber(client, sa.landlord_id, year)

        const invRes = await client.query<{ id: string }>(
          `INSERT INTO invoices (
             landlord_id, tenant_id, lease_id, unit_id, service_agreement_id,
             invoice_number, due_date,
             subtotal_rent, subtotal_fees, subtotal_utilities, total_amount,
             work_trade_credit_amount, work_trade_credit_hours, work_trade_agreement_id
           ) VALUES ($1, $2, NULL, $3, $4, $5, $6, 0, 0, $7, $7, 0, 0, NULL)
           -- The predicate is REQUIRED: this is a partial unique index, and
           -- Postgres will not infer one for ON CONFLICT unless the statement
           -- repeats it. Without it this raises 42P10 rather than de-duping.
           ON CONFLICT (service_agreement_id, due_date)
             WHERE service_agreement_id IS NOT NULL
             DO NOTHING
           RETURNING id`,
          [sa.landlord_id, sa.tenant_id, sa.unit_id, sa.id,
           invoiceNumber, dueDate, total.toFixed(2)],
        )
        // Already invoiced this cycle. Roll back so the reserved invoice
        // number is released rather than burned on a document that does not
        // exist — the lease path does the same.
        if (invRes.rows.length === 0) { await client.query('ROLLBACK'); continue }
        const invoiceId = invRes.rows[0].id

        for (const b of bills) {
          const paymentId = await insertUtilityRow(client, {
            invoiceId, sa, dueDate, bill: b,
          })
          await client.query(
            `UPDATE utility_bills
                SET payment_id = $1, status = 'billed',
                    billed_at = COALESCE(billed_at, NOW()), updated_at = NOW()
              WHERE id = $2`,
            [paymentId, b.id],
          )
          utilitiesInserted++
        }

        // NO CREDIT APPLICATION HERE, deliberately. tenant_credits is keyed to
        // lease_id, so a service payer cannot hold a credit at all today — a
        // call to applyCreditsToOpenCharges would find nothing by construction,
        // which reads like "credits are handled" while handling nothing. When a
        // landlord needs to forgive part of a neighbour's utility bill, that
        // wants the same nullable-lease treatment this migration gave invoices,
        // plus a way to issue one from the agreement. Left undone and visible
        // rather than stubbed and invisible.

        await client.query('COMMIT')
        invoicesInserted++
      } catch (e) {
        // Per-agreement isolation, same posture as the lease loop: one bad
        // agreement must not starve every other payer of their bill.
        await client.query('ROLLBACK').catch(() => {})
        logger.error({ err: e, agreementId: sa.id, dueDate },
          '[ServiceInvoice] agreement skipped — generation continues')
        continue
      } finally {
        client.release()
      }
    }
  }

  return { invoicesInserted, utilitiesInserted, agreementsProcessed: agreements.length }
}

/**
 * One utility child row. Line notes match the lease path's exactly — the payer
 * next door reads the same bill format the tenants do, which is both the point
 * and what the state bill-format rules require (opening and closing reads plus
 * the dates they were taken).
 */
async function insertUtilityRow(
  client: PoolClient,
  args: { invoiceId: string; sa: ActiveAgreement; dueDate: string; bill: any },
): Promise<string> {
  const { invoiceId, sa, dueDate, bill: b } = args
  const UNIT_LABEL: Record<string, string> = {
    electric: 'kWh', water: 'gal', sewer: 'gal', gas: 'therms', propane: 'gal',
  }
  const pad = (v: any) => v == null ? null
    : String(Math.trunc(Number(v))).padStart(Number(b.digits) || 6, '0')
  const d = (v: any) => v == null ? null
    : new Date(v).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
  const dateNote = b.reading_start_date && b.reading_end_date
    ? ` (${d(b.reading_start_date)} → ${d(b.reading_end_date)})` : ''
  const type = String(b.utility_type || 'utility')
  const note = b.reading_start != null && b.reading_end != null
    ? `${type[0].toUpperCase() + type.slice(1)} meter ${pad(b.reading_start)} → ${pad(b.reading_end)}${dateNote} · ${Number(b.usage_amount || 0).toLocaleString()} ${UNIT_LABEL[type] || 'units'}`
    : b.allocation_method === 'flat_rate' && Number(b.allocation_basis || 1) > 1
      ? `${Number(b.allocation_basis)} × $${Number(b.rate_per_unit || 0).toFixed(2)}`
      : null

  const res = await client.query<{ id: string }>(
    `INSERT INTO payments (
       invoice_id, unit_id, lease_id, tenant_id, landlord_id,
       type, amount, status, due_date, entry_description, notes
     ) VALUES ($1, $2, NULL, $3, $4, 'utility', $5, 'pending', $6, 'UTILITY', $7)
     RETURNING id`,
    [invoiceId, sa.unit_id, sa.tenant_id, sa.landlord_id,
     Number(b.charge_amount).toFixed(2), dueDate, note],
  )
  return res.rows[0].id
}

const AGREEMENT_SELECT = `
  SELECT sa.id, sa.landlord_id, sa.unit_id, sa.tenant_id, sa.billing_due_day,
         to_char(sa.start_date, 'YYYY-MM-DD') AS start_date,
         to_char(sa.end_date,   'YYYY-MM-DD') AS end_date,
         COALESCE(p.timezone, 'America/Phoenix') AS property_tz
    FROM utility_service_agreements sa
    JOIN units u ON u.id = sa.unit_id
    JOIN properties p ON p.id = u.property_id
   WHERE sa.status = 'active'`

/** Every active agreement, any timezone. Used by tests and manual catch-up. */
export async function generateServiceAgreementInvoices(
  nowUtc: Date = new Date(),
): Promise<ServiceInvoiceResult> {
  const agreements = await query<ActiveAgreement>(AGREEMENT_SELECT)
  return runServiceGeneration(agreements, nowUtc)
}

/** Timezone-scoped variant, called by the per-tz cron. */
export async function generateServiceAgreementInvoicesForTimezone(
  tz: string,
  nowUtc: Date = new Date(),
): Promise<ServiceInvoiceResult> {
  const agreements = await query<ActiveAgreement>(
    `${AGREEMENT_SELECT} AND p.timezone = $1`, [tz])
  return runServiceGeneration(agreements, nowUtc)
}

/**
 * Registered on the SAME schedule as invoice generation (7am local, with the
 * five follow-up ticks that catch the hour boundary), so a landlord who serves
 * a space next door sees that bill go out the same morning their tenants' do.
 */
export function registerServiceAgreementInvoiceEngine(): void {
  registerEngine('serviceInvoices', {
    cronExpr: '0,10,20,30,40,50 7 * * *',
    handler: async (tz: string) => {
      try {
        const r = await generateServiceAgreementInvoicesForTimezone(tz)
        if (r.invoicesInserted > 0) {
          logger.info({ tz, invoices: r.invoicesInserted, utilities: r.utilitiesInserted },
            '[ServiceInvoice] utility-service invoices generated')
        }
      } catch (e) {
        logger.error({ err: e, tz }, '[ServiceInvoice] error')
      }
    },
    label: 'Utility-service invoices',
  })
}

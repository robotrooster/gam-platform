import { DateTime } from 'luxon'
import type { PoolClient } from 'pg'
import { getClient, query } from '../db'
import { logger } from '../lib/logger'
import { ensureBillsForUnit } from '../services/utilityBilling'
import { allocateInvoiceNumber } from '../services/invoiceNumbers'
import { registerEngine } from './timezoneCronManager'
import { dueDatesInRange } from './invoiceGeneration'
import { hourRateFor } from '../services/workTradeSettlement'
import { emitPaymentSettledEvent } from '../services/creditLedgerEmitters'

/**
 * 10/6 (Nic): "the stay's utility agreement bills nothing for covered
 * utilities". A work trade made for a stay (services/stayWorkTrade) covers its
 * utilities the way a lease's does in the monthly run (invoiceGeneration): a
 * covered charge rides on the invoice as a SUSPENDED line — worked off, not
 * owed — and the invoice is exempt from late fees while the hours are worked.
 * A bill is covered when the payer's work trade on that space ran on the day
 * the bill was read (its cycle month when it has no read) and lists the
 * utility. A trade that tracks hours opens its month's settlement period over
 * the covered amount, so the month-close run settles it like any other.
 */
const WT_SUSPENDED_NOTE = 'work trade, suspended until month close'
const WT_COVERED_NOTE = 'Covered by work trade'
interface CoveringTrade {
  id: string; status: string; covered_charges: string[] | null; tracks_hours: boolean; monthly_hours_target: number
  start_date: string; end_date: string | null
}
/**
 * 10/6 (review): how a covered line is written. A LIVE trade's line is
 * suspended and its month's settlement period is opened, so the month-close run
 * settles it. A trade that has already ENDED (the stay's last utility bill is
 * usually cut after check-out, when the trade ended and its own end settlement
 * already ran) has no close left to release a suspended line — it would sit
 * pending forever. Its covered line is settled as covered outright.
 */
type CoveredAs = 'suspended' | 'covered' | null
function tradeCovering(trades: CoveringTrade[], bill: { utility_type: string; read_end: string | null; cycle: string }): CoveringTrade | null {
  const day = (bill.read_end ?? bill.cycle).slice(0, 10)
  return trades.find(w =>
    w.start_date.slice(0, 7) <= day.slice(0, 7) && (w.start_date <= day || !bill.read_end)
    && (w.end_date == null || w.end_date >= day)
    && (!w.covered_charges || w.covered_charges.length === 0 || w.covered_charges.includes(String(bill.utility_type)))) ?? null
}

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
// is no labor arrangement with the neighbor), no prepaid rent. Threading a
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
  /** 'active', or 'ended' with charges still to send (its final bill). */
  status: string
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
    const dueDates = windowEnd < windowStart ? [] : dueDatesInRange(windowStart, windowEnd, sa.billing_due_day)

    // 10/5 (Nic, prepaid stays — M7): an ENDED agreement still owes what was
    // used inside its dates — a stay's check-out read bills its last stretch
    // after the stay is over, and a month read can land after it ended. Those
    // charges have no due date of its own left, so they go out on a final
    // bill dated today, the way a departing lease's final utilities do
    // (invoiceGeneration generateFinalUtilityInvoice). Only an agreement with
    // charges still to send is read here (AGREEMENT_SELECT).
    if (sa.status === 'ended') {
      const today = todayInTz.toISODate()!
      if (!dueDates.includes(today)) dueDates.push(today)
    }
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
        cycle: string
        read_end: string | null
      }>(
        `SELECT ub.id, (ub.charge_amount + ub.tax_amount)::text AS charge_amount,
                to_char(ub.billing_cycle_month, 'YYYY-MM-DD') AS cycle,
                to_char(ub.reading_end_date, 'YYYY-MM-DD') AS read_end,
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
      // 10/6: the payer's work trade on this space, if any (a stay's).
      const trades = await query<CoveringTrade>(
        `SELECT id, status, covered_charges, tracks_hours, monthly_hours_target,
                to_char(start_date, 'YYYY-MM-DD') AS start_date, to_char(end_date, 'YYYY-MM-DD') AS end_date
           FROM work_trade_agreements
          WHERE unit_id = $1 AND tenant_id = $2 AND status <> 'paused'
          ORDER BY created_at DESC`, [sa.unit_id, sa.tenant_id])
      const covering = bills.map(b => tradeCovering(trades, b))
      const coveredAs: CoveredAs[] = covering.map(w => !w ? null : w.status === 'active' ? 'suspended' : 'covered')
      const coveredTotal = bills.reduce((s, b, i) => s + (covering[i] ? Number(b.charge_amount) : 0), 0)
      // The live trade whose month-close settles the suspended lines.
      const liveTrade = covering.find((w, i) => w && coveredAs[i] === 'suspended') ?? null
      const suspendedTotal = bills.reduce((s, b, i) => s + (coveredAs[i] === 'suspended' ? Number(b.charge_amount) : 0), 0)
      const trade = liveTrade ?? covering.find(Boolean) ?? null
      const owed = Math.round((total - coveredTotal) * 100) / 100

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
             work_trade_credit_amount, work_trade_credit_hours, work_trade_agreement_id,
             late_fee_exempt
           ) VALUES ($1, $2, NULL, $3, $4, $5, $6, 0, 0, $7, $8, 0, 0, $9, $9::uuid IS NOT NULL)
           -- The predicate is REQUIRED: this is a partial unique index, and
           -- Postgres will not infer one for ON CONFLICT unless the statement
           -- repeats it. Without it this raises 42P10 rather than de-duping.
           ON CONFLICT (service_agreement_id, due_date)
             WHERE service_agreement_id IS NOT NULL
             DO NOTHING
           RETURNING id`,
          [sa.landlord_id, sa.tenant_id, sa.unit_id, sa.id,
           invoiceNumber, dueDate, total.toFixed(2), owed.toFixed(2), trade?.id ?? null],
        )
        // Already invoiced this cycle. Roll back so the reserved invoice
        // number is released rather than burned on a document that does not
        // exist — the lease path does the same.
        if (invRes.rows.length === 0) { await client.query('ROLLBACK'); continue }
        const invoiceId = invRes.rows[0].id

        for (const [i, b] of bills.entries()) {
          const paymentId = await insertUtilityRow(client, {
            invoiceId, sa, dueDate, bill: b, coveredAs: coveredAs[i],
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

        // 10/6: a live trade opens its month's settlement period over what it
        // covered here — the month-close run settles it. 10/6 (review): ALWAYS,
        // whether or not it tracks hours (S637, jobs/moveInBundle): the period is
        // the only thing that clears a suspended line. A trade that does not
        // track hours (trusted, or Track hours off) asks 0 hours, and the close
        // credits the whole basis.
        if (liveTrade && suspendedTotal > 0) {
          const monthStart = DateTime.fromISO(dueDate).startOf('month')
          const target = liveTrade.tracks_hours ? (Number(liveTrade.monthly_hours_target) || 0) : 0
          await client.query(
            `INSERT INTO work_trade_settlements
               (agreement_id, invoice_id, period_month, target_hours,
                hour_rate, basis_amount, period_start, period_end)
             VALUES ($1, $2, $3::date, $4, $5, $6, $3::date, $7::date)
             ON CONFLICT (agreement_id, period_start) DO NOTHING`,
            [liveTrade.id, invoiceId, monthStart.toISODate(), target.toFixed(2),
             hourRateFor(suspendedTotal, target).toFixed(4), suspendedTotal.toFixed(2),
             monthStart.endOf('month').toISODate()])
        }

        // NO CREDIT APPLICATION HERE, deliberately. tenant_credits is keyed to
        // lease_id, so a service payer cannot hold a credit at all today — a
        // call to applyCreditsToOpenCharges would find nothing by construction,
        // which reads like "credits are handled" while handling nothing. When a
        // landlord needs to forgive part of a neighbor's utility bill, that
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
  args: { invoiceId: string; sa: ActiveAgreement; dueDate: string; bill: any; coveredAs?: CoveredAs },
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

  const covered = args.coveredAs === 'covered'
  const suspended = args.coveredAs === 'suspended'
  const res = await client.query<{ id: string }>(
    `INSERT INTO payments (
       invoice_id, unit_id, lease_id, tenant_id, landlord_id,
       type, amount, status, due_date, entry_description, notes, work_trade_suspended_at, settled_at
     ) VALUES ($1, $2, NULL, $3, $4, 'utility', $5, $9, $6, 'UTILITY', $7, $8, CASE WHEN $9 = 'settled' THEN NOW() END)
     RETURNING id`,
    [invoiceId, sa.unit_id, sa.tenant_id, sa.landlord_id,
     // 10/6 (review): covered by a trade that has ended — settled as covered,
     // the same way the month-close settles a covered line (amount 0).
     covered ? '0.00' : Number(b.charge_amount).toFixed(2), dueDate,
     // 10/6: a utility the payer's work trade covers — worked off, not owed.
     suspended ? [note, WT_SUSPENDED_NOTE].filter(Boolean).join(' — ')
       : covered ? [note, `${WT_COVERED_NOTE} (${'$' + Number(b.charge_amount).toFixed(2)})`].filter(Boolean).join(' — ')
       : note,
     suspended ? new Date().toISOString() : null,
     covered ? 'settled' : 'pending'],
  )
  const paymentId = res.rows[0].id
  // S652 (Nic): work trade counts as on time — the credit history says so, as
  // the month-close does for the lines it covers.
  if (covered && sa.tenant_id) {
    await emitPaymentSettledEvent(client, {
      tenantId: sa.tenant_id, paymentId, paymentType: 'utility', amount: Number(b.charge_amount),
      dueDate, settledAt: new Date(`${dueDate}T12:00:00Z`), graceDays: null,
      stripePaymentIntentId: null, attestationSource: 'gam_workflow_auto',
      attestationEvidence: { covered_by: 'work_trade', invoice_id: invoiceId },
    })
  }
  return paymentId
}

// S616: an agreement whose space is LINKED to another landlord's leased unit
// no longer cuts its own invoice — its charges ride that unit's tenant invoice
// instead, so the tenant gets one document. Excluded here rather than left to
// race the lease run for the bill: whichever attached it first would win, and
// the loser would produce an invoice that is empty or, worse, a second document
// for charges already billed.
const AGREEMENT_SELECT = `
  SELECT sa.id, sa.status, sa.landlord_id, sa.unit_id, sa.tenant_id, sa.billing_due_day,
         to_char(sa.start_date, 'YYYY-MM-DD') AS start_date,
         to_char(sa.end_date,   'YYYY-MM-DD') AS end_date,
         COALESCE(p.timezone, 'America/Phoenix') AS property_tz
    FROM utility_service_agreements sa
    JOIN units u ON u.id = sa.unit_id
    JOIN properties p ON p.id = u.property_id
   WHERE (sa.status = 'active'
          -- 10/5 (M7): an ended agreement with charges still to send — its
          -- final bill (runServiceGeneration).
          OR (sa.status = 'ended' AND EXISTS (
                SELECT 1 FROM utility_bills ub
                 WHERE ub.service_agreement_id = sa.id AND ub.payment_id IS NULL
                   AND ub.status IN ('unbilled', 'billed')
                   -- a meter that did not move after they left is no final bill
                   AND ub.charge_amount + ub.tax_amount > 0)))
     -- S616 (Nic): nobody is invoiced by GAM without having agreed to be.
     -- Either the payer accepted their portal invite, or the landlord attested
     -- that they agreed off-platform (the arrangements that predate GAM).
     -- Charges still ACCRUE while neither is true — the meter turned — they
     -- simply are not issued, and they ride the first invoice after consent
     -- lands via the ordinary straggler lookback.
     AND (sa.payer_accepted_at IS NOT NULL OR sa.payer_attested_at IS NOT NULL)
     AND NOT EXISTS (
       SELECT 1 FROM cross_property_service_links l
        WHERE l.service_agreement_id = sa.id AND l.status = 'active')`

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

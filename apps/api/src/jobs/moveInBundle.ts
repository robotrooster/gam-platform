import { DateTime } from 'luxon'
import type { PoolClient } from 'pg'
import { daysInMonth, formatInvoiceNumber } from '@gam/shared'
import { getClient, queryOne } from '../db'
import { logger } from '../lib/logger'
import { isBookingScheduleLease, bookingRentForDueDate } from '../services/bookingLeaseBilling'
import { allocateInvoiceNumber } from '../services/invoiceNumbers'

// ============================================================
// S26a: Move-in invoice generator (replaces S25 moveInBundle)
// Called at lease finalize — NOT by daily cron.
// Creates one invoice dated lease.start_date containing:
//   - Rent (prorated if start_date.day > 1, full rent if day=1)
//   - All move_in fees from lease_fees, INCLUDING security_deposit
//     (S196: security_deposit is now a lease_fees row, not a column)
// Security deposit specifically flows into a payments row with
// type='deposit' (not 'fee') for historical audit clarity; all
// other move_in lease_fees create type='fee' rows.
// Idempotent via ux_invoices_lease_due_date.
// ============================================================

interface MoveInInputs {
  lease_id: string
  unit_id: string
  tenant_id: string | null
  landlord_id: string
  rent_amount: number
  start_date: string          // YYYY-MM-DD
}

export interface MoveInBundleResult {
  invoiceCreated: boolean
  invoiceId: string | null
  invoiceNumber: string | null
  rentAmount: number
  moveInFeesInserted: number
  depositInserted: boolean
}

/**
 * Map a lease_fees.fee_type to the NACHA-shaped payments.entry_description
 * enum (CHECK on payments.entry_description). Deposit-shape fee_types map
 * to 'DEPOSIT'; last_month_rent maps to 'RENT' (it IS prepaid rent);
 * everything else to 'SUBSCRIP'.
 */
function entryDescriptionForFeeType(feeType: string): 'DEPOSIT' | 'RENT' | 'SUBSCRIP' {
  if (feeType === 'pet_deposit' || feeType === 'key_deposit' || feeType === 'cleaning_deposit') return 'DEPOSIT'
  if (feeType === 'last_month_rent') return 'RENT'
  return 'SUBSCRIP'
}

/** Banker's rounding (half-even) to cents. */
export function roundHalfEvenCents(value: number): number {
  const cents = value * 100
  const floor = Math.floor(cents)
  const diff = cents - floor
  if (diff < 0.5) return floor / 100
  if (diff > 0.5) return (floor + 1) / 100
  return (floor % 2 === 0 ? floor : floor + 1) / 100
}

/**
 * Rent for the move-in invoice. Prorated if start_date.day > 1, full rent if
 * day == 1.
 *
 * S631 (Nic, DIRECTIVE): an EXISTING TENANCY is NEVER prorated — it is billed a
 * full month, for the cycle `existingTenancyCycle` names.
 *
 * "For onboarding existing tenants, I don't want it to prorate the rent amount.
 *  It should bill new signups that move in at that point. But for the onboarding
 *  window and process, it shouldn't prorate."
 *
 * Proration answers "how much of this month did you live here". For a new
 * move-in that is the right question; for a resident of six years signing on the
 * 29th it is the wrong one — nothing about the tenancy started that day, only
 * the paperwork.
 *
 * A FIRST ATTEMPT AT THIS BILLED ZERO and was wrong. Nic: "During the onboarding
 * window, if somebody's onboarding mid-month, it doesn't want to bill them until
 * the first of the next month, right? But whereas we're billing at the end of
 * the month, and people might not actually sign the lease till tomorrow or the
 * next day, that needs to bill them for September." Skipping the partial month
 * handed every resident signing on 1–2 September a free September. Which month
 * is owed is not derivable from the signing date — it depends on which months
 * the landlord already collected off-platform, which is why the landlord names
 * the cycle (properties.first_billing_cycle) and this function is only told the
 * answer.
 */
export function moveInRentAmount(
  rentAmount: number,
  startDate: string,
  isExistingTenancy = false,
): number {
  // An existing tenancy always owes a whole month — the cycle it lands on is
  // decided by existingTenancyCycle(), not by how much of it had elapsed.
  if (isExistingTenancy) return roundHalfEvenCents(rentAmount)
  const dt = DateTime.fromISO(startDate, { zone: 'utc' })
  if (dt.day === 1) return roundHalfEvenCents(rentAmount)
  const dim = daysInMonth(dt.year, dt.month)
  const daysRemaining = dim - dt.day + 1
  return roundHalfEvenCents(rentAmount * daysRemaining / dim)
}

/**
 * Which cycle an existing tenancy's FIRST invoice belongs to, as YYYY-MM-01.
 *
 * The later of the PROPERTY's declared first billing cycle and the month the
 * lease starts in. Later, not earlier: a landlord who says "start me in October"
 * is saying they collected September themselves, and a lease that starts in
 * November cannot be billed for October.
 *
 * S633: the cycle is read off the property, not the entity. Onboarding happens
 * one property at a time, so a park bought in November under an LLC that
 * onboarded another park in September must not inherit September and invoice
 * its residents for months they already paid someone else. There is deliberately
 * no fallback to the entity's old value — an unanswered property bills the month
 * each lease starts in, which is the reading that never double-bills.
 *
 * With no declared cycle it is simply the lease's own month — a landlord signing
 * residents up in September is normally billing them for September, and that is
 * also the reading that never silently skips a month.
 */
export function existingTenancyCycle(
  startDate: string,
  firstBillingCycle: string | null,
): string {
  const leaseMonth = startDate.slice(0, 8) + '01'
  if (!firstBillingCycle) return leaseMonth
  const declared = String(firstBillingCycle).slice(0, 8) + '01'
  return declared > leaseMonth ? declared : leaseMonth
}


export async function generateMoveInInvoice(
  inputs: MoveInInputs,
  externalClient?: PoolClient
): Promise<MoveInBundleResult> {
  // S548: booking-sourced leases prorate the arrival month at monthly/30
  // (the calendar schedule the guest was quoted); regular leases keep the
  // long-standing days-remaining/days-in-month proration.
  // S28: optional caller-owned transaction. When externalClient is provided,
  // skip BEGIN/COMMIT/ROLLBACK/release — caller owns the tx lifecycle.
  // Standalone call path (no externalClient) preserved for catch-up backfill
  // and any other one-shot invoice generation.
  const ownsTx = !externalClient
  const client: PoolClient = externalClient || await getClient()

  // ── S634: READ ON THE CALLER'S CONNECTION, NOT THE POOL ────────────────────
  //
  // Both reads below were `queryOne` — a SEPARATE pool connection — while the
  // caller (routes/esign.ts) holds an open transaction. At READ COMMITTED that
  // connection cannot see the caller's uncommitted rows, so this function was
  // deciding the invoice from a stale picture of the lease. The file already
  // documents this exact hazard for lease_fees a few lines down; the fix simply
  // never reached these two.
  //
  // It bit RV 03 the day its lease was signed, in two ways at once:
  //
  //   · esign sets `leases.is_existing_tenancy = TRUE` in its transaction. This
  //     read missed it, so an EXISTING tenancy papered on 31 August was treated
  //     as a new move-in and billed ONE DAY of prorated rent ($14.19) instead of
  //     the whole cycle it owed.
  //   · esign creates the work-trade agreement in the same transaction,
  //     deliberately just before this runs (S631: "the work-trade agreement has
  //     inserted it slightly before the invoice is created"). This read missed
  //     that too, so the invoice was never stamped with the agreement and never
  //     marked late_fee_exempt — a work-trade tenant left exposed to late fees
  //     on rent they are working off, and an invoice the settlement job cannot
  //     credit.
  //
  // Nic found the second one from the outside: "Why is RV three prorated rent?
  // That's a work trade agreement."
  //
  // S633: first_billing_cycle lives on the PROPERTY (leases carry unit_id, so
  // reach it through units). See existingTenancyCycle() for why the grain moved.
  const leaseMetaRes = await client.query<{
    lease_source: string | null; end_date: string | null
    is_existing_tenancy: boolean; first_billing_cycle: string | null
  }>(
    `SELECT l.lease_source, to_char(l.end_date, 'YYYY-MM-DD') AS end_date,
            COALESCE(l.is_existing_tenancy, false) AS is_existing_tenancy,
            to_char(p.first_billing_cycle, 'YYYY-MM-DD') AS first_billing_cycle
       FROM leases l
       JOIN units u ON u.id = l.unit_id
       JOIN properties p ON p.id = u.property_id
      WHERE l.id = $1`,
    [inputs.lease_id])
  const leaseMeta = leaseMetaRes.rows[0] ?? null
  const bookingArrival = leaseMeta && isBookingScheduleLease(leaseMeta)
    ? bookingRentForDueDate(inputs.start_date, leaseMeta.end_date!, inputs.rent_amount, inputs.start_date)
    : null
  const rentForMoveIn = bookingArrival != null
    ? roundHalfEvenCents(bookingArrival)
    : moveInRentAmount(inputs.rent_amount, inputs.start_date, !!leaseMeta?.is_existing_tenancy)

  // S631: an existing tenancy's first invoice is dated the 1st of its billing
  // cycle, not the signing date. That is what makes it a September invoice for
  // someone who signed on 2 September — and it is deliberately a date that may
  // already be past, because an existing tenant knows when rent is due. Nic:
  // "For existing tenants, the anticipation of due date and bill pay and all
  // that stuff is known. It's an existing tenancy. Late fees are there."
  const invoiceDueDate = leaseMeta?.is_existing_tenancy
    ? existingTenancyCycle(inputs.start_date, leaseMeta.first_billing_cycle)
    : inputs.start_date

  // S631 (Nic): a work-trade tenant must not be fined while they are working the
  // month off. The monthly cron has stamped late_fee_exempt for this since S623;
  // the MOVE-IN invoice never did, so the very first invoice of a work-trade
  // tenancy — the one most likely to sit open while the hours are earned — was
  // the only chargeable one. The agreement is created from the invite at signing
  // (routes/esign.ts), immediately before this runs — and S634 made that
  // actually true by reading it on the caller's connection instead of the pool.
  const wtAgreementRes = await client.query<{ id: string; covered_charges: string[] | null }>(
    `SELECT id, covered_charges FROM work_trade_agreements
      WHERE unit_id = $1 AND tenant_id = $2 AND status = 'active'
        AND start_date <= ($3::date + INTERVAL '1 month' - INTERVAL '1 day')
        AND (end_date IS NULL OR end_date >= $3::date)
      LIMIT 1`,
    [inputs.unit_id, inputs.tenant_id, invoiceDueDate])
  const wtAgreement = wtAgreementRes.rows[0] ?? null
  /**
   * S634 (Nic): "work trade should be including the utilities... Landlords are
   * gonna want that per agreement with specific people. My agreement with RV 03
   * is that it's including utilities too."
   *
   * The agreement already carries `covered_charges` and the landlord already
   * picks them per agreement (the Covers control on the Work Trade page). What
   * the suspension did not do was READ it — only rent was suspended, so a tenant
   * whose trade covers electricity still had the electricity sitting as money
   * owed while they worked it off.
   *
   * An empty/absent list means everything is covered, matching the monthly run's
   * reading of the same column.
   */
  const wtCovers = (kind: string): boolean => {
    if (!wtAgreement) return false
    const list = wtAgreement.covered_charges
    return !list || list.length === 0 || list.includes(kind)
  }

  // Query fees on the same connection as the writes. When caller owns the
  // transaction, lease_fees rows they just inserted are invisible from a
  // separate pool connection at READ COMMITTED. Reading via `client` ensures
  // we see the in-flight inserts.
  const feesRes = await client.query(
    `SELECT id, fee_type, amount, description
     FROM lease_fees
     WHERE lease_id = $1 AND due_timing = 'move_in'`,
    [inputs.lease_id]
  )
  const fees = feesRes.rows as Array<{
    id: string; fee_type: string; amount: string; description: string | null
  }>

  try {
    if (ownsTx) await client.query('BEGIN')

    const year = DateTime.fromISO(invoiceDueDate).year
    const invoiceNumber = await allocateInvoiceNumber(client, inputs.landlord_id, year)

    // S196: security_deposit is now a lease_fees row inside `fees`.
    // Pull it out for the dedicated type='deposit' payment row, and
    // exclude it from the fee-loop total so it doesn't double-count.
    const depositFee = fees.find(f => f.fee_type === 'security_deposit')
    const fullDepositAmount = depositFee ? Number(depositFee.amount) : 0
    const nonDepositFees = fees.filter(f => f.fee_type !== 'security_deposit')
    const feesTotal = nonDepositFees.reduce((s, f) => s + Number(f.amount), 0)

    // S246/S527: FlexDeposit branch (CUSTODY model — GAM advances
    // nothing). When the tenant has enrolled BEFORE move-in, the
    // deposit line is excluded from the landlord-facing invoice
    // entirely — landlord sees only rent + non-deposit fees; their
    // "Security Deposits" page shows the deposit held in GAM custody,
    // funded as installments collect. Tenant pays installment 1
    // alongside rent + fees in the combined move-in PI; remaining N-1
    // installments are scheduled via flex_deposit_installments rows
    // (created at enroll time before this generator runs).
    let depositAmountForInvoice = fullDepositAmount
    let firstInstallmentAmount = 0
    let flexDepositActive = false
    let flexDepositSecurityDepositId: string | null = null
    if (depositFee && inputs.tenant_id) {
      const fdRow = await client.query<{ id: string; flex_deposit_enabled: boolean; first_amount: string | null; portability_status: string }>(
        `SELECT sd.id, sd.flex_deposit_enabled, sd.portability_status,
                (SELECT amount::text FROM flex_deposit_installments
                  WHERE security_deposit_id = sd.id AND installment_number = 1) AS first_amount
           FROM security_deposits sd
          WHERE sd.tenant_id = $1 AND sd.lease_id = $2
          LIMIT 1`,
        [inputs.tenant_id, inputs.lease_id],
      )
      // S516: double-charge guard. A deposit carried forward from a prior
      // GAM lease is already held in custody for this lease — never bill a
      // fresh deposit at move-in.
      if (fdRow.rows[0]?.portability_status === 'carried_forward') {
        depositAmountForInvoice = 0
      } else if (fdRow.rows[0]?.flex_deposit_enabled && fdRow.rows[0]?.first_amount) {
        flexDepositActive = true
        flexDepositSecurityDepositId = fdRow.rows[0].id
        firstInstallmentAmount = Number(fdRow.rows[0].first_amount)
        // Invoice deposit line disappears; landlord doesn't see
        // anything deposit-related on this invoice.
        depositAmountForInvoice = 0
      }
    }
    // S634 (Nic, DIRECTIVE): "Have the work trade exist, but be suspended...
    // and it creates only at the month close." A work-trade tenant is working
    // THIS month's rent off during it — there is no arrears arrangement, so the
    // rent must not read as money owed while they work. The line is still
    // written (the month's worth is what the hours are priced against, and the
    // tenant should see what the month was worth) but it is suspended and stays
    // out of the amount due. Month close leaves either 0 or the prorated lapse.
    const rentSuspended = wtCovers('rent') && rentForMoveIn > 0
    const totalAmount = (rentSuspended ? 0 : rentForMoveIn)
      + feesTotal + depositAmountForInvoice + firstInstallmentAmount

    const invoiceRes = await client.query(
      `INSERT INTO invoices (
         landlord_id, tenant_id, lease_id, unit_id,
         invoice_number, due_date,
         subtotal_rent, subtotal_fees, subtotal_deposits, total_amount,
         work_trade_agreement_id, late_fee_exempt
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (lease_id, due_date) DO NOTHING
       RETURNING id`,
      [
        inputs.landlord_id, inputs.tenant_id, inputs.lease_id, inputs.unit_id,
        invoiceNumber, invoiceDueDate,
        rentForMoveIn.toFixed(2),
        feesTotal.toFixed(2),
        depositAmountForInvoice.toFixed(2),
        totalAmount.toFixed(2),
        wtAgreement?.id ?? null,
        !!wtAgreement,
      ]
    )

    if (invoiceRes.rows.length === 0) {
      // Idempotent skip — invoice already exists for (lease_id, due_date).
      // Owns-tx case: roll back the BEGIN we issued (nothing else dirty).
      // Caller-owns case: do nothing — caller decides commit vs rollback.
      if (ownsTx) await client.query('ROLLBACK')
      return {
        invoiceCreated: false,
        invoiceId: null,
        invoiceNumber: null,
        rentAmount: rentForMoveIn,
        moveInFeesInserted: 0,
        depositInserted: false,
      }
    }

    const invoiceId = invoiceRes.rows[0].id as string

    // S631: no rent line when there is no rent to charge. An existing tenancy
    // papered mid-month owes nothing until the next cycle, and a $0 'pending'
    // rent charge is not nothing — it sits in the tenant's ledger as an unpaid
    // item, shows on their portal, and is exactly the sort of row a late-fee or
    // dunning sweep has to be taught to ignore. Deposits and move-in fees on the
    // same invoice are unaffected; they are separately owed either way.
    if (rentForMoveIn > 0) {
      await client.query(
        `INSERT INTO payments (
           invoice_id, unit_id, lease_id, tenant_id, landlord_id,
           type, amount, status, due_date, entry_description,
           work_trade_suspended_at, notes
         ) VALUES ($1, $2, $3, $4, $5, 'rent', $6, 'pending', $7, 'RENT', $8, $9)`,
        [
          invoiceId, inputs.unit_id, inputs.lease_id, inputs.tenant_id, inputs.landlord_id,
          rentForMoveIn.toFixed(2), invoiceDueDate,
          // S634: suspended while the hours are being worked — see totalAmount.
          rentSuspended ? new Date().toISOString() : null,
          rentSuspended ? 'Work trade — suspended while the hours are worked; settled at month close' : null,
        ]
      )
    }

    let moveInFeesInserted = 0
    for (const fee of nonDepositFees) {
      await client.query(
        `INSERT INTO payments (
           invoice_id, unit_id, lease_id, tenant_id, landlord_id,
           type, amount, status, due_date, entry_description, lease_fee_id
         ) VALUES ($1, $2, $3, $4, $5, 'fee', $6, 'pending', $7, $8, $9)`,
        [
          invoiceId, inputs.unit_id, inputs.lease_id, inputs.tenant_id, inputs.landlord_id,
          fee.amount, invoiceDueDate,
          entryDescriptionForFeeType(fee.fee_type),
          fee.id,
        ]
      )
      moveInFeesInserted++
    }

    let depositInserted = false
    if (depositAmountForInvoice > 0) {
      await client.query(
        `INSERT INTO payments (
           invoice_id, unit_id, lease_id, tenant_id, landlord_id,
           type, amount, status, due_date, entry_description
         ) VALUES ($1, $2, $3, $4, $5, 'deposit', $6, 'pending', $7, 'DEPOSIT')`,
        [
          invoiceId, inputs.unit_id, inputs.lease_id, inputs.tenant_id, inputs.landlord_id,
          depositAmountForInvoice.toFixed(2), invoiceDueDate,
        ]
      )
      depositInserted = true
    }

    // S246: FlexDeposit installment 1 payment row. Tagged
    // entry_description='DEPOSIT' so allocation + audit treats it
    // consistently with the regular deposit. The payments row carries
    // the installment-1 amount (the tenant's first portion of their
    // own deposit — there is no GAM-fronted gap under custody);
    // landlord doesn't see this row tied to their dashboard because
    // it's NOT linked to the invoice (invoice_id=NULL) — its
    // visibility is tenant-side only.
    let flexDepositInstallment1PaymentId: string | null = null
    if (flexDepositActive && firstInstallmentAmount > 0) {
      const inst1 = await client.query<{ id: string }>(
        `INSERT INTO payments (
           unit_id, lease_id, tenant_id, landlord_id,
           type, amount, status, due_date, entry_description, notes
         ) VALUES ($1, $2, $3, $4, 'deposit', $5, 'pending', $6, 'DEPOSIT', $7)
         RETURNING id`,
        [
          inputs.unit_id, inputs.lease_id, inputs.tenant_id, inputs.landlord_id,
          firstInstallmentAmount.toFixed(2), invoiceDueDate,
          `FlexDeposit installment 1 (deposit ${flexDepositSecurityDepositId})`,
        ]
      )
      flexDepositInstallment1PaymentId = inst1.rows[0].id
    }

    // ── S634: UTILITIES ALREADY METERED RIDE THE FIRST INVOICE ───────────────
    //
    // Nic, on RV 02 the day its lease was signed: "the outstanding balance list
    // is not showing anything with the utilities for RV two."
    //
    // It could not. The move-in invoice billed rent, fees and deposit and never
    // looked at utility_bills — and the MONTHLY run deliberately skips a lease's
    // entire START MONTH, because the prorated move-in invoice already covers
    // it. So a lease starting 1 September had its August utilities land in
    // NOVEMBER'S invoice at the earliest: released onto the lease, correct in
    // every table, and invisible on the only document the tenant is asked to pay.
    //
    // These are the shares held while the unit was mid-onboarding and released
    // when the lease was signed (releaseSuspendedChargesForLease). The usage is
    // real, the other residents were already charged around it, and this is the
    // tenant's first bill — which is exactly where it belongs.
    //
    // S634 (Nic): a utility the AGREEMENT COVERS is suspended exactly like the
    // rent — "my agreement with RV 03 is that it's including utilities too."
    // Which utilities is per agreement, off `covered_charges`, which the
    // landlord sets on the Work Trade page. An uncovered one is ordinary money
    // owed on this invoice.
    //
    // Same straggler rule the monthly run uses: anything for a cycle on or
    // before this invoice's, that no invoice has claimed yet.
    let utilitiesTotal = 0        // what the utilities are WORTH (all of them)
    let utilitiesOwed = 0         // what is actually due now (uncovered only)
    let wtUtilityBasis = 0        // covered utilities — priced into the hours
    const unbilled = await client.query<any>(
      `SELECT ub.id, ub.charge_amount, ub.utility_type, ub.landlord_id,
              to_char(ub.billing_cycle_month, 'Mon YYYY') AS cycle_label
         FROM utility_bills ub
        WHERE ub.lease_id = $1
          AND ub.payment_id IS NULL
          AND ub.status IN ('unbilled','billed')
          AND ub.billing_cycle_month <= date_trunc('month', $2::date)::date
        ORDER BY ub.billing_cycle_month ASC, ub.id ASC`,
      [inputs.lease_id, invoiceDueDate])
    for (const ub of unbilled.rows) {
      const amount = Number(ub.charge_amount)
      if (!(amount > 0)) continue
      const covered = wtCovers(String(ub.utility_type))
      const label = `${String(ub.utility_type)[0].toUpperCase()}${String(ub.utility_type).slice(1)} — ${ub.cycle_label} (used before the lease was signed)`
      const up = await client.query<{ id: string }>(
        `INSERT INTO payments (
           invoice_id, unit_id, lease_id, tenant_id, landlord_id,
           type, amount, status, due_date, entry_description, notes,
           work_trade_suspended_at
         ) VALUES ($1, $2, $3, $4, $5, 'utility', $6, 'pending', $7, 'UTILITY', $8, $9)
         RETURNING id`,
        [
          // S616 posture: the row's landlord is the BILL's own, which is the
          // lease's for every ordinary utility.
          invoiceId, inputs.unit_id, inputs.lease_id, inputs.tenant_id, ub.landlord_id,
          amount.toFixed(2), invoiceDueDate,
          covered ? `${label} — work trade, suspended until month close` : label,
          covered ? new Date().toISOString() : null,
        ])
      await client.query(
        `UPDATE utility_bills SET payment_id = $1, status = 'billed', billed_at = NOW(), updated_at = NOW()
          WHERE id = $2`, [up.rows[0].id, ub.id])
      utilitiesTotal += amount
      if (covered) wtUtilityBasis += amount
      else utilitiesOwed += amount
    }
    if (utilitiesTotal > 0) {
      // subtotal records what the month was WORTH; the total is what is OWED, so
      // a suspended utility shows on the document and not in the amount due.
      await client.query(
        `UPDATE invoices
            SET subtotal_utilities = COALESCE(subtotal_utilities, 0) + $2,
                total_amount       = total_amount + $3,
                updated_at         = NOW()
          WHERE id = $1`,
        [invoiceId, utilitiesTotal.toFixed(2), utilitiesOwed.toFixed(2)])
    }

    // ── S634: OPEN THE WORK-TRADE PERIOD ─────────────────────────────────────
    //
    // Only the monthly run opened one, so a work-trade tenancy that begins with
    // a signed lease had NO period for month close to settle: the hours were
    // logged, the invoice sat there, and nothing ever reconciled them. The
    // suspensions above depend on this — a suspended line with no period would
    // stay suspended forever.
    //
    // Runs AFTER the utility sweep on purpose: the basis is everything the
    // agreement covers, and until the utilities are on the invoice their value
    // is not known. Pricing the hours against rent alone would make an hour buy
    // less than the agreement says it does.
    if (wtAgreement) {
      const basis = (rentSuspended ? rentForMoveIn : 0) + wtUtilityBasis
      if (basis > 0) {
        const monthStart = invoiceDueDate.slice(0, 8) + '01'
        const wtRow = await client.query<{ monthly_hours_target: string | null }>(
          `SELECT monthly_hours_target FROM work_trade_agreements WHERE id = $1`,
          [wtAgreement.id])
        const fullTarget = Number(wtRow.rows[0]?.monthly_hours_target ?? 0)
        // Prorate the hours by how much of the month the rent covers: a half
        // month of rent cannot ask for a full month of labour.
        const fullMonthRent = Number(inputs.rent_amount) || rentForMoveIn
        const target = fullTarget > 0 && fullMonthRent > 0 && rentForMoveIn > 0
          ? Math.round((fullTarget * (rentForMoveIn / fullMonthRent)) * 100) / 100
          : fullTarget
        if (target > 0) {
          await client.query(
            `INSERT INTO work_trade_settlements
               (agreement_id, invoice_id, period_month, target_hours, hour_rate, basis_amount)
             VALUES ($1, $2, $3::date, $4, $5, $6)
             ON CONFLICT (agreement_id, period_month) DO NOTHING`,
            [wtAgreement.id, invoiceId, monthStart, target.toFixed(2),
             (basis / target).toFixed(4), basis.toFixed(2)])
        }
      }
    }

    if (ownsTx) await client.query('COMMIT')

    // S246/S527: post-commit FlexDeposit settlement. Flips installment
    // 1 to settled and updates the custody counters. NO Connect
    // Transfer fires — the deposit stays in gam_escrow for the life of
    // the lease (settleFlexDepositMoveIn returns stripeTransferId:
    // null); GAM advances nothing, so there is no gap to cover.
    // Best-effort: on failure an admin notification is recorded and
    // the cron retry path picks it up.
    if (flexDepositActive && flexDepositSecurityDepositId && flexDepositInstallment1PaymentId && inputs.tenant_id) {
      try {
        const { settleFlexDepositMoveIn } = await import('../services/flexDeposit')
        await settleFlexDepositMoveIn({
          tenantId:           inputs.tenant_id,
          securityDepositId:  flexDepositSecurityDepositId,
          movInPaymentId:     flexDepositInstallment1PaymentId,
        })
      } catch (e) {
        logger.error({ err: e, security_deposit_id: flexDepositSecurityDepositId }, '[moveIn][flex-deposit-settle]')
        // Don't throw — invoice is created, tenant payment will
        // succeed separately. S260: no Connect Transfer at move-in
        // (all FlexDeposit deposits gam_escrow); the only inside-tx
        // work here is flipping installment 1 status + deposit
        // counters, no money movement.
      }
    }

    return {
      invoiceCreated: true,
      invoiceId,
      invoiceNumber,
      rentAmount: rentForMoveIn,
      moveInFeesInserted,
      depositInserted,
    }
  } catch (e) {
    if (ownsTx) await client.query('ROLLBACK')
    throw e
  } finally {
    if (ownsTx) client.release()
  }
}

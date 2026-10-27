// apps/api/src/jobs/lateFees.ts
// S26b: Late fee detection engine.
//
// Cron firing model (S26b-tz): registered per-property-timezone via
// timezoneCronManager. Each timezone fires 6 times during 00:00-00:59 local
// (at minutes :00, :10, :20, :30, :40, :50). Outside that window, no cron
// fires for that timezone — saves compute, no global polling.
//
// Engine reads invoices for properties in the firing timezone only,
// generates initial + accrual late_fee child rows attached via invoice_id.
// Cap is total-inclusive; cap-edge writes a partial row of exactly the
// remaining amount, then stops accruing (locked decision: cap-edge partial).
// Idempotent via ux_payments_late_fee_idempotent partial unique index —
// the 6 firings per timezone per night are safe; first writes, rest no-op.
//
// S655: each invoice is decided under the household lock, right after the
// whole-bill credit rule, and re-read fresh before any fee (lateFeeForInvoice).

import type { PoolClient } from 'pg'
import { getClient } from '../db'
import {
  lateFeeStartDate,
  nextAccrualDate,
  addAccrualPeriods,
  computeLateFeeAmount,
  capRemaining,
  type LateFeeKind,
  type LateFeeAccrualPeriod,
  type LateFeeAccrualFrom,
} from '@gam/shared'
import { registerEngine } from './timezoneCronManager'
import { deletedLateFeeDates, LATE_FEE_DELETED_ACTION } from '../services/lateFeeDelete'
import { lateCountsFromSql, pastGraceSql, propertyDaySql } from '../services/lateness'
import { logger } from '../lib/logger'
import { lockHousehold } from '../services/moneyPredicates'
import { settleWholeBillIfCovered, billHouseholdTenant, type WholeBillResult } from '../services/creditUse'

/**
 * A late fee on one of these is a fee the bill was charged — its day is
 * charged and its amount counts toward the cap. 10/12 (Nic): including
 * 'failed' and 'paid_via_deposit'. A bounced bank pull (autopay, "pay in
 * full") covers the rent AND the late fees, and the bank refusing it marks
 * every line of it 'failed' (routes/webhooks failIntentRows): still owed, and
 * the retry (services/achRetry) or any other payment picks up those same rows.
 * Read as uncharged, the next night charged every one of those days again
 * (past the cap), and the retry of the whole pull — rent included — then hit
 * the one-fee-per-day index (ux_payments_late_fee_idempotent) and could never
 * run. A fee the deposit paid was charged and paid; its day was charged again
 * too. Not here: 'returned' (a reversal re-bills what is owed again as a fresh
 * row on the same day — services/paymentReversal) and 'voided'.
 */
const CHARGED_LATE_FEE_STATUSES_SQL = `('pending', 'processing', 'settled', 'failed', 'paid_via_deposit')`

interface QualifyingInvoice {
  invoice_id: number
  // S615: NULL on a utility-service invoice — it has an agreement, not a lease.
  lease_id: string | null
  landlord_id: string
  unit_id: string | null
  resolved_unit_id: string
  tenant_id: string | null
  due_date: string
  /** 10/12 (Nic): the day lateness starts — the due date, or the day GAM wrote the bill when later. */
  late_from: string
  today_local: string
  late_fee_grace_days: number
  late_fee_initial_type: LateFeeKind
  late_fee_initial_amount: string
  late_fee_accrual_type: LateFeeKind | null
  late_fee_accrual_amount: string | null
  late_fee_accrual_period: LateFeeAccrualPeriod | null
  late_fee_accrual_from: LateFeeAccrualFrom
  late_fee_cap_type: LateFeeKind | null
  late_fee_cap_amount: string | null
}

export interface LateFeeResult {
  invoicesScanned: number
  rowsWritten: number
  capsHit: number
  errors: { invoice_id: number; error: string }[]
}

/**
 * The qualifying-invoice SELECT, shared by the nightly per-timezone cron and
 * the on-demand single-invoice path (post-settlement reversal reopen). The
 * caller supplies the row filter ($1): the cron filters by property timezone,
 * the reopen path by invoice id. Everything after the filter is identical so
 * both qualify invoices the same way — grace crossed, lease late-fee
 * configured, an unpaid non-late-fee base charge exists, none in-flight.
 */
function qualifyingInvoicesSql(rowFilter: string): string {
  return `
      SELECT
        i.id AS invoice_id,
        i.lease_id,
        i.landlord_id,
        i.unit_id,
        u.id AS resolved_unit_id,
        i.tenant_id,
        i.due_date::text AS due_date,
        ls.late_from::text AS late_from,
        d.today::text AS today_local,
        g.days AS late_fee_grace_days,
        -- 10/25 (Nic): and an INSTALLMENT CONTRACT, the third document a bill
        -- can belong to. "It's an installment contract that may carry its own
        -- late terms... we need to have the capability for landlords." Exactly
        -- one of the three is present per the invoices CHECK, so these stay
        -- unambiguous rather than becoming a precedence rule.
        COALESCE(l.late_fee_initial_type, sa.late_fee_initial_type, hs.late_fee_initial_type) AS late_fee_initial_type,
        COALESCE(l.late_fee_initial_amount, sa.late_fee_initial_amount, hs.late_fee_initial_amount)::text AS late_fee_initial_amount,
        COALESCE(l.late_fee_accrual_type, sa.late_fee_accrual_type, hs.late_fee_accrual_type) AS late_fee_accrual_type,
        COALESCE(l.late_fee_accrual_amount, sa.late_fee_accrual_amount, hs.late_fee_accrual_amount)::text AS late_fee_accrual_amount,
        COALESCE(l.late_fee_accrual_period, sa.late_fee_accrual_period, hs.late_fee_accrual_period) AS late_fee_accrual_period,
        COALESCE(l.late_fee_accrual_from, sa.late_fee_accrual_from, hs.late_fee_accrual_from, 'grace_end') AS late_fee_accrual_from,
        COALESCE(l.late_fee_cap_type, sa.late_fee_cap_type, hs.late_fee_cap_type) AS late_fee_cap_type,
        COALESCE(l.late_fee_cap_amount, sa.late_fee_cap_amount, hs.late_fee_cap_amount)::text AS late_fee_cap_amount
      FROM invoices i
      -- S615: an invoice belongs to EITHER a lease or a utility service
      -- agreement, so the lease join can no longer be an inner one — it was
      -- silently excluding every next-door utility invoice from the late-fee
      -- engine entirely. Both instruments carry the same stamped parameters,
      -- and exactly one of them is present per the invoices CHECK, so the
      -- COALESCE pairs above are unambiguous rather than a precedence rule.
      LEFT JOIN leases l ON l.id = i.lease_id
      -- S616 (Nic, DIRECTIVE): "late fees only go to the utility landlord when
      -- there's only utilities. When there's a lease, late fees go to the
      -- leasing landlord."
      --
      -- So an agreement's own late-fee terms apply ONLY while it is unlinked.
      -- Once the space is linked to another landlord's leased unit, its charges
      -- ride that lease's invoice and that lease's late fee governs the whole
      -- balance — one fee, one landlord, under one document's rules. The
      -- utility landlord gives up his. Nic, on why: "That way it's smoother.
      -- The tenant's not getting billed for two separate types of late fees,
      -- and we're not miscalculating... if it's fifty dollars in electric and
      -- five hundred dollars in rent, are we taking one eleventh of the late
      -- fees and ratioing it out? I don't wanna deal with any of that. It
      -- complicates books on both sides."
      --
      -- A linked agreement should have no invoices of its own to reach this
      -- query at all; the join condition is belt-and-braces for a straggler
      -- issued before the link went live.
      LEFT JOIN utility_service_agreements sa
             ON sa.id = i.service_agreement_id
            AND NOT EXISTS (
              SELECT 1 FROM cross_property_service_links cl
               WHERE cl.service_agreement_id = sa.id AND cl.status = 'active')
      -- 10/25 (Nic): the installment (home/trailer) contract whose own bill
      -- this is. Its terms apply to its own bill only — a trailer payment is
      -- never on a rent bill, so there is no two-documents-one-bill question
      -- of the kind S616 had to settle for utilities.
      LEFT JOIN home_sale_contracts hs ON hs.id = i.home_sale_contract_id
      JOIN units u ON u.id = COALESCE(i.unit_id, l.unit_id)
      JOIN properties p ON p.id = u.property_id
      -- 10/12 (Nic): "Grace = lease, else property, else 5 — the only chain."
      -- This skipped the property (lease → service agreement → 5), so a lease
      -- drafted with no grace of its own fined on the platform's 5 days even
      -- where the park had set its own; the Outstanding list, the ledger and
      -- the delinquency check already read the property's
      -- (services/openBalances graceDaysSql). The service agreement stands in
      -- for the lease on a utility-only invoice (exactly one of the two is
      -- present, per the invoices CHECK). Named once here, so the qualifying
      -- check, the home-payment rule below and processInvoice all use the
      -- same number.
      CROSS JOIN LATERAL (
        SELECT COALESCE(l.late_fee_grace_days, sa.late_fee_grace_days, hs.late_fee_grace_days,
                        p.late_fee_grace_days, 5) AS days
      ) g
      -- The park's today.
      CROSS JOIN LATERAL (SELECT ${propertyDaySql('NOW()', 'p')} AS today) d
      -- 10/12 (Nic): "Lateness start = due date, or the day GAM wrote the bill
      -- when later" — a bill written after its due date (the onboarding bill
      -- written mid-month, a monthly run that caught up late) starts its grace
      -- the day it was written, on the property's calendar: a tenant cannot pay
      -- a bill before it exists. The same rule as services/lateness
      -- (lateCountsFrom) — an unpaid bill is always written on or before today.
      -- A bill reopened by a bounced payment keeps its own written day, so its
      -- fees still count back to the due date.
      CROSS JOIN LATERAL (
        SELECT ${lateCountsFromSql('i.due_date', propertyDaySql('i.created_at', 'p'), 'd.today')} AS late_from
      ) ls
      WHERE ${rowFilter}
        AND i.status IN ('pending', 'partial')
        -- S605 (Nic): a balance carried in from the landlord's previous system
        -- must not start compounding the day it is entered. "A tenant on a
        -- catch-up plan shouldn't be fined for arrears from the old system."
        -- Set per invoice, so a landlord CAN opt a specific debt back in.
        AND i.late_fee_exempt = false
        -- ── S640 (Nic): THE ONBOARDING WAIVER CANNOT DEPEND ON A STAMP ───────
        --
        --   "That's a false flag on the tenants currently, because onboarding
        --    tenants are exempt from late fees."
        --
        -- The S639 waiver — an existing resident's FIRST bill on the platform is
        -- never late, because the delay was our onboarding and not theirs — is
        -- stamped onto late_fee_exempt when the invoice is generated. That is
        -- fine for invoices the generator makes, and useless for every other
        -- way an invoice comes into being: two of the five delinquent leases
        -- carry is_existing_tenancy with a first invoice and no stamp, because
        -- their invoices were written before the rule existed or by another
        -- path. Nothing would have re-checked before fining them.
        --
        -- So the condition is asserted here as well, against the facts rather
        -- than against a flag. The stamp stays — it is the record, and a
        -- landlord can still opt a specific debt back in by clearing it — but
        -- it is no longer the only thing standing between an onboarding
        -- resident and a fee they were promised they would not get.
        --
        -- COALESCE, not a bare comparison: a utility-service invoice has no
        -- lease at all, so is_existing_tenancy is NULL there, and NULL inside a
        -- NOT(...) filters the row out entirely — it would have silently
        -- stopped late fees on every service agreement on the platform. Two
        -- tests caught it; without them nobody would have noticed for months.
        --
        -- S648 (Nic): only where the landlord CHOSE the waiver for this
        -- property ("the tenants need to be billed late fees if the landlord
        -- doesn't agree to waive them"). Unanswered (NULL) = no waiver.
        AND NOT (
          COALESCE(l.is_existing_tenancy, FALSE)
          AND COALESCE(p.onboarding_late_fee_waiver, FALSE)
          -- S654: a VOIDED history invoice (Country Acres' "billed before GAM"
          -- rows) is not a prior bill; counting it defeated the waiver for ten
          -- of twelve residents.
          AND NOT EXISTS (SELECT 1 FROM invoices ip
                           WHERE ip.lease_id = l.id AND ip.due_date < i.due_date AND ip.status <> 'void')
        )
        -- 10/25: the installment contract is the third document that can turn
        -- fees on. Left out of THESE two (while its terms were read above), a
        -- trailer bill had l and sa both NULL, so the COALESCE compared NULL to
        -- true and the bill was filtered out — the landlord's own late terms
        -- would have been saved, shown, and then silently never charged.
        AND COALESCE(l.late_fee_enabled, sa.late_fee_enabled, hs.late_fee_enabled) = true
        AND COALESCE(l.late_fee_initial_amount, sa.late_fee_initial_amount, hs.late_fee_initial_amount) IS NOT NULL
        -- The first late day is the lateness start + grace (due the 1st, 5 days
        -- of grace: the 6th), and the fee charges at midnight on it — '>=', not
        -- '>' (10/12, Nic: "the 6th is late, the day late fees start").
        -- 10/12 (Nic): with a grace of 0 the NEXT day is late — paying on the
        -- due date is on time — so the grace counts as at least 1
        -- (services/lateness pastGraceSql: start + GREATEST(grace, 1)).
        --
        -- A bill already fined (a fee it was charged — live, bounced or paid
        -- from the deposit: CHARGED_LATE_FEE_STATUSES_SQL — or one the landlord
        -- deleted: services/lateFeeDelete) is already late: its fees stand, and its next
        -- ones follow its first fee's calendar (processInvoice). The start and
        -- the grace decide only when a bill not yet fined first goes late, so a
        -- bill fined before the start moved to the day it was written, or
        -- before a grace edit, neither pauses nor charges a second first fee.
        AND (
          ${pastGraceSql('d.today', 'ls.late_from', 'g.days')}
          OR EXISTS (SELECT 1 FROM payments lf
                      WHERE lf.invoice_id = i.id AND lf.type = 'late_fee'
                        AND lf.status IN ${CHARGED_LATE_FEE_STATUSES_SQL})
          OR EXISTS (SELECT 1 FROM audit_log al
                      WHERE al.entity_type = 'invoice' AND al.entity_id = i.id
                        AND al.action = '${LATE_FEE_DELETED_ACTION}')
        )
        -- S537 (Nic): late fees track UNPAID BASE CHARGES, never themselves.
        -- (a) Stop accruing once every non-late-fee child is settled — a
        --     partial invoice whose only open child is the late fee itself
        --     must not snowball daily forever.
        --
        -- 10/12 (Nic): a bill is never "unpaid" because of a $0 line. Only a
        -- charge with money on it that is still owed keeps the fees running:
        --   - more than $0. A $0 line (a meter that read nothing, a fee
        --     zeroed by the landlord) is never paid, because there is nothing
        --     to pay, so it sat 'pending' and kept a fully paid bill late
        --     forever — and the bill's status counts it too
        --     (fn_invoice_status_rollup counts every line), so the bill stayed
        --     'partial' and in this scan.
        --   - not covered by work trade (work_trade_suspended_at): labor pays
        --     it, it is never owed (moneyPredicates.payableRowSql).
        --   - still owed: 'pending' or 'failed'. It used to be anything but
        --     'settled', so a line paid from the deposit, a voided line, and
        --     the 'returned' original of a reversal (whose owed part is a fresh
        --     'pending' row — services/paymentReversal) all kept fees running
        --     once everything owed was paid. A line still clearing is the
        --     postmark rule's, (b) below.
        AND EXISTS (
          SELECT 1 FROM payments pb
           WHERE pb.invoice_id = i.id AND pb.type != 'late_fee'
             AND pb.status IN ('pending', 'failed')
             AND pb.amount > 0
             AND pb.work_trade_suspended_at IS NULL
             -- 10/25: this applies only to bills written BEFORE 10/25. A
             -- trailer payment is its own bill now (invoices.home_sale_contract_id),
             -- written late_fee_exempt, so no new installment is ever on a rent
             -- bill and none can be the line that keeps one late. The rule stays
             -- because the bills that already carry one are still being paid.
             --
             -- 10/12 (Nic): a charge the tenant could not have seen cannot make
             -- them late. Since the landlord's signature starts a home sale
             -- billing, an installment can join a bill that is ALREADY late
             -- (services/homeSale attachDueInstallmentsToOpenInvoices — MH 18
             -- and MH 24 at Country Acres, put on October's bill on the 12th).
             -- Such a line never counts as the unpaid charge that keeps a bill
             -- late: once everything else is paid, the fees stop exactly as
             -- they would have without it (an accruing fee would otherwise
             -- restart and back-fill every day since the due date). A fee
             -- already on the bill stays as it is, and a percent fee is figured
             -- on the rent alone (processInvoice), so the line never makes one
             -- bigger. An installment line written with the bill (the monthly
             -- run) still counts — even when that run wrote the bill late (a
             -- catch-up after a held meter read or a missed run), so only a
             -- line added on a later day than the bill itself is passed over;
             -- so does a line re-billed after a bounced payment (no
             -- installment id on it — services/paymentReversal).
             -- 10/12 (Nic): "already late" is the bill's first late day — its
             -- lateness start + GREATEST(grace, 1), as in the check above.
             AND NOT (pb.home_sale_installment_id IS NOT NULL
                      AND ${propertyDaySql('pb.created_at', 'p')} > ${propertyDaySql('i.created_at', 'p')}
                      AND ${pastGraceSql(propertyDaySql('pb.created_at', 'p'), 'ls.late_from', 'g.days')})
        )
        -- (b) Postmark rule: an in-flight payment (ACH 'processing' takes
        --     2-4 business days) counts as paid on its initiation date. No
        --     fee while it clears; if it FAILS the child flips to a
        --     non-settled status and the next nightly run back-fills every
        --     missed tick since the due date — fees land retroactively,
        --     which is the correct outcome for a bounced payment (and for a
        --     post-settlement reversal, which flips 'settled' → 'returned').
        AND NOT EXISTS (
          SELECT 1 FROM payments pf
           WHERE pf.invoice_id = i.id AND pf.type != 'late_fee'
             AND pf.status = 'processing'
        )
  `
}

/**
 * Run the late fee engine for invoices on properties in the given timezone.
 * Called by per-tz cron at midnight local (and the 5 follow-up :10/:20/:30/
 * :40/:50 ticks). SQL scopes to properties.timezone = $1.
 */
export async function generateLateFeesForTimezone(
  tz: string
): Promise<LateFeeResult> {
  const result: LateFeeResult = {
    invoicesScanned: 0,
    rowsWritten: 0,
    capsHit: 0,
    errors: [],
  }

  const client = await getClient()
  try {
    // Filter:
    //   - invoice in pending/partial (settled/void excluded)
    //   - lease has late_fee_enabled and initial_amount configured
    //   - property is in the specified timezone
    //   - property-local today is on or past the bill's first late day
    //     (lateness start + GREATEST(grace, 1)), or the bill is already fined
    const { rows: invoices } = await client.query<QualifyingInvoice>(
      qualifyingInvoicesSql('p.timezone = $1'), [tz]
    )

    result.invoicesScanned = invoices.length

    for (const inv of invoices) {
      let receipts: WholeBillResult['afterCommit'] | null = null
      try {
        await client.query('BEGIN')
        receipts = await lateFeeForInvoice(client, inv, result)
        await client.query('COMMIT')
      } catch (e: unknown) {
        await client.query('ROLLBACK').catch(() => {})
        const msg = e instanceof Error ? e.message : String(e)
        result.errors.push({ invoice_id: inv.invoice_id, error: msg })
        logger.error({ err: e, tz, invoice_id: inv.invoice_id }, '[LateFees] invoice error')
        continue
      }
      // A bill the credit paid gets its "paid with your account credit"
      // receipt once the settle is committed. Never throws.
      if (receipts) await receipts()
    }
  } finally {
    client.release()
  }

  return result
}

/**
 * One invoice, inside the caller's transaction (S655 money plan §1.5 and the
 * whole-bill rule, Nic 10/2):
 *   1. The household lock, like every writer of the household's money. The
 *      invoice was picked by a scan that ran before this transaction, so a
 *      tenant may have paid, or a credit landed, in between.
 *   2. The whole-bill rule, right before the fee: a credit that covers the
 *      whole bill pays it now, and a bill paid in full is not late. 10/6
 *      (Nic): money paid ahead also goes on the balance, part of a bill when
 *      it cannot pay all of it (creditUse.drawPaidAheadOnBalance); other
 *      saved credit that covers less settles nothing. Whatever is still owed
 *      after that does NOT stop the fee (Nic: "saved credit doesn't stop a
 *      late fee unless it covers the whole bill"). Savepoint-guarded: if the credit step fails, the bill stays
 *      open and the fee is raised exactly as before.
 *   3. The invoice is asked again, fresh, under the lock: the fee is raised
 *      only if it still qualifies (anything paid since the scan — by credit
 *      here, by the tenant, the desk or a bank deposit — means no fee).
 * Returns the credit receipts to send after COMMIT, if the credit paid a bill.
 */
async function lateFeeForInvoice(
  client: PoolClient,
  scanned: QualifyingInvoice,
  result: LateFeeResult,
): Promise<WholeBillResult['afterCommit'] | null> {
  let receipts: WholeBillResult['afterCommit'] | null = null
  // The bill's household: the invoice's tenant, else (an invoice written
  // without one) the lease's resident.
  const hh = scanned.tenant_id
    ? { tenantId: scanned.tenant_id, landlordId: scanned.landlord_id }
    : scanned.lease_id ? await billHouseholdTenant(client, scanned.lease_id) : null
  if (hh) {
    await lockHousehold(client, hh.tenantId, hh.landlordId)
    await client.query('SAVEPOINT late_fee_whole_bill')
    try {
      const wb = await settleWholeBillIfCovered(client, {
        tenantId: hh.tenantId, landlordId: hh.landlordId, source: 'whole_bill',
      })
      await client.query('RELEASE SAVEPOINT late_fee_whole_bill')
      if (wb.settledIds.length > 0) {
        receipts = wb.afterCommit
        logger.info({ invoice_id: scanned.invoice_id, settled: wb.settledIds.length },
          '[LateFees] the account credit covered the whole bill — paid before any late fee')
      }
    } catch (e) {
      await client.query('ROLLBACK TO SAVEPOINT late_fee_whole_bill')
      logger.error({ err: e, invoice_id: scanned.invoice_id },
        '[LateFees] the credit check before the fee failed — the bill is treated as unpaid')
    }
  }
  const { rows } = await client.query<QualifyingInvoice>(
    qualifyingInvoicesSql('i.id = $1'), [scanned.invoice_id])
  const fresh = rows[0]
  if (!fresh) return receipts
  await processInvoice(client, fresh, result)
  return receipts
}

/**
 * S561: on-demand late-fee (re)generation for a SINGLE invoice. Called when a
 * post-settlement payment reversal reopens an invoice
 * (services/paymentReversal.ts) — runs the identical qualifying logic +
 * processInvoice as the nightly cron, so the reopened invoice immediately
 * back-fills every late-fee tick retroactively to the original due date ("as
 * if the payment never happened") instead of waiting for the next nightly run.
 * No-op if the invoice doesn't qualify (grace not crossed, no late-fee config,
 * nothing unpaid, an in-flight retry, etc.).
 *
 * S655: it runs on its OWN connection and takes the household lock
 * (lateFeeForInvoice). Call it only AFTER the caller's transaction has
 * committed — never from inside a transaction that holds that household's
 * lock: it would wait on the caller, the caller on it, and Postgres cannot see
 * that as a deadlock (the caller's connection is merely idle in its
 * transaction), so both hang for good. paymentReversal calls it after its
 * COMMIT. creditUse.runWholeBillCheckAfterCommit has the same rule.
 */
export async function generateLateFeesForInvoice(invoiceId: string): Promise<LateFeeResult> {
  const result: LateFeeResult = { invoicesScanned: 0, rowsWritten: 0, capsHit: 0, errors: [] }
  const client = await getClient()
  try {
    const { rows: invoices } = await client.query<QualifyingInvoice>(
      qualifyingInvoicesSql('i.id = $1'), [invoiceId]
    )
    result.invoicesScanned = invoices.length
    for (const inv of invoices) {
      let receipts: WholeBillResult['afterCommit'] | null = null
      try {
        await client.query('BEGIN')
        receipts = await lateFeeForInvoice(client, inv, result)
        await client.query('COMMIT')
      } catch (e: unknown) {
        await client.query('ROLLBACK').catch(() => {})
        const msg = e instanceof Error ? e.message : String(e)
        result.errors.push({ invoice_id: inv.invoice_id, error: msg })
        logger.error({ err: e, invoice_id: inv.invoice_id }, '[LateFees] on-demand invoice error')
        continue
      }
      if (receipts) await receipts()
    }
  } finally {
    client.release()
  }
  return result
}

// S558 (Nic): the S537 policy-ceiling helper (policyScheduleTotal) was removed
// with the ceiling itself — billing is now pure lease-stamp. The (property,
// unit_type) policy stays authoritative at DRAFT + the onboarding gate; it no
// longer bounds billing of an already-signed lease.

async function processInvoice(
  client: PoolClient,
  inv: QualifyingInvoice,
  result: LateFeeResult
): Promise<void> {
  const today = inv.today_local

  // Percent-of-rent late fees base on the FULL month's rent (Nic, S581 — "% of
  // the whole rent"). SUM the live rent rows rather than grabbing one: a rent
  // row split by a partial credit becomes a reduced original + a remainder row
  // that together equal the full rent, and a reversal reopen adds a fresh rent
  // row alongside the old one. Restricting to pending/processing/settled counts
  // the current obligation exactly once — it excludes the 'returned' half of a
  // reopen (double-count) and 'paid_via_deposit' artifacts. The old
  // `LIMIT 1` picked ONE piece arbitrarily (even the already-paid slice),
  // under-basing the fee whenever the rent had been split.
  //
  // 10/12 (Nic): and 'failed'. A bounced pull leaves the rent row itself
  // 'failed' — still owed, and the row the retry or any other payment settles
  // (moneyPredicates.payableRowSql); nothing writes a second row for it. Left
  // out, a bounce made the rent $0 here: a percent fee charged nothing, and a
  // percent cap read as reached, which stopped even a flat fee.
  //
  // S615: a bill with NO LEASE and so no rent row anywhere bases the percentage
  // on its own billable charges instead — for a utility-service bill the
  // utilities, and (10/25) for an installment contract's own bill the
  // installment, which in each case is the entire obligation. Without this a
  // percent-of-rent property would compute every such fee as exactly $0 and a
  // percent CAP would return 0 remaining, which blocks even a FLAT fee: the
  // bill would look configured, qualify, and then quietly never charge
  // anything. Scoped to lease_id IS NULL so a leased invoice's basis is
  // byte-identical to what it was.
  const ownChargesAreTheObligation = inv.lease_id == null
  const { rows: rentRows } = await client.query<{ total: string }>(
    ownChargesAreTheObligation
      ? `SELECT COALESCE(SUM(amount), 0)::text AS total
           FROM payments
          WHERE invoice_id = $1 AND type <> 'late_fee'
            AND status IN ('pending', 'processing', 'settled', 'failed')`
      : `SELECT COALESCE(SUM(amount), 0)::text AS total
           FROM payments
          WHERE invoice_id = $1 AND type = 'rent'
            AND status IN ('pending', 'processing', 'settled', 'failed')`
  , [inv.invoice_id])
  const rentAmount = Number(rentRows[0].total)

  // S558 (Nic): billing = PURE lease-stamp. Every parameter comes from the
  // SIGNED lease (inv.late_fee_*) — the current property policy has NO effect on
  // an existing lease's charges. The document is the charge: it keeps FlexPay
  // savings math and every downstream calc consistent, and a mid-lease policy
  // change (even tenant-favorable) has to go through a superseding lease, not a
  // silent settings tweak. The class policy is used only at DRAFT/gate time.
  // (Removed the S537 tenant-favorable policy ceiling per Nic.)

  // Every fee the bill was charged (CHARGED_LATE_FEE_STATUSES_SQL): its days
  // are never charged again, and its amounts count toward the cap.
  const { rows: existingFees } = await client.query<{ amount: string; due_date: string }>(`
    SELECT amount::text AS amount, due_date::text AS due_date
    FROM payments
    WHERE invoice_id = $1
      AND type = 'late_fee'
      AND status IN ${CHARGED_LATE_FEE_STATUSES_SQL}
    ORDER BY due_date ASC
  `, [inv.invoice_id])
  let existingSum = existingFees.reduce((s, r) => s + Number(r.amount), 0)
  const existingDates = new Set(existingFees.map(r => r.due_date))
  // 10/6 (Nic): a late fee the landlord deleted on the onboarding bill
  // (services/lateFeeDelete) is never charged again — its day counts as
  // charged, at $0, exactly as a zeroed fee's does.
  for (const d of await deletedLateFeeDates(client, String(inv.invoice_id), inv.due_date)) existingDates.add(d)
  // 10/12 (Nic): the first fee on a bill (live or deleted) fixes where its
  // fees start. Grace now follows the property's setting, which the landlord
  // can edit while a bill is late; re-reading it every night moved the first
  // fee to a new day — a SECOND initial fee — and a lowered grace back-filled
  // daily fees for days that were inside the grace when they passed. Once a
  // bill has been fined, a later grace edit changes nothing on it.
  const firstCharged = [...existingDates].sort()[0] ?? null

  // Cap = the lease's OWN stamped cap (late_fee_cap_*), part of the signed doc.
  const capKind = inv.late_fee_cap_type
  const capAmt = inv.late_fee_cap_amount !== null ? Number(inv.late_fee_cap_amount) : null
  let remaining = capRemaining(capKind, capAmt, rentAmount, existingSum)

  if (capKind !== null && remaining <= 0) {
    return
  }

  // S577: retroactive modes (due_date / due_date_inclusive) charge ONLY the
  // daily/period accrual, counted back to the lateness start (10/12: the due
  // date, or the day GAM wrote the bill when later) — no separate flat
  // "initial" fee. Guard applies only when an accrual is actually configured;
  // a flat-fee-only policy still charges its flat fee regardless of anchor.
  const accrualFrom = inv.late_fee_accrual_from || 'grace_end'
  const hasAccrual =
    inv.late_fee_accrual_type !== null &&
    inv.late_fee_accrual_amount !== null &&
    inv.late_fee_accrual_period !== null
  const retroactiveNoInitial = accrualFrom !== 'grace_end' && hasAccrual

  // 10/12 (Nic): a bill not yet fined is first fined on its first late day —
  // the lateness start (the due date, or the day GAM wrote the bill when
  // later) + GREATEST(grace, 1): with a grace of 0, the day after.
  const initialDate = lateFeeStartDate(inv.late_from, inv.late_fee_grace_days)

  if (!retroactiveNoInitial && firstCharged == null && !existingDates.has(initialDate)) {
    const rawInitial = computeLateFeeAmount(
      inv.late_fee_initial_type,
      Number(inv.late_fee_initial_amount),
      rentAmount
    )
    let initialAmt = rawInitial
    let capHitOnInitial = false
    if (capKind !== null && initialAmt > remaining) {
      initialAmt = remaining
      capHitOnInitial = true
    }
    if (initialAmt > 0) {
      await insertLateFeeRow(client, inv, initialDate, initialAmt)
      result.rowsWritten += 1
      existingSum += initialAmt
      existingDates.add(initialDate)
      remaining = capRemaining(capKind, capAmt, rentAmount, existingSum)
      if (capHitOnInitial) {
        result.capsHit += 1
        return
      }
    }
  }

  if (
    inv.late_fee_accrual_type === null ||
    inv.late_fee_accrual_amount === null ||
    inv.late_fee_accrual_period === null
  ) {
    return
  }

  const accrualKind: LateFeeKind = inv.late_fee_accrual_type
  const accrualAmt = Number(inv.late_fee_accrual_amount)
  const period: LateFeeAccrualPeriod = inv.late_fee_accrual_period

  const accrualDay = accrualCalendar(inv, accrualFrom, period, firstCharged)
  // 10/12 (Nic): a monthly fee charges once a month. A month that already has
  // a fee on this bill (live, deleted or bounced) is never charged again, on
  // whatever day of it the calendar now falls.
  const monthsCharged = new Set([...existingDates].map(d => d.slice(0, 7)))
  for (let occ = 1; occ <= MAX_OCCURRENCES; occ++) {
    const tickDate = accrualDay(occ)
    if (tickDate > today) break
    // Never back-fill before the bill's first fee (see firstCharged above).
    if (firstCharged && tickDate < firstCharged) continue
    if (existingDates.has(tickDate)) continue
    if (period === 'monthly' && monthsCharged.has(tickDate.slice(0, 7))) continue

    const rawTick = computeLateFeeAmount(accrualKind, accrualAmt, rentAmount)
    if (rawTick <= 0) break

    let tickAmt = rawTick
    let capHit = false
    if (capKind !== null && tickAmt > remaining) {
      tickAmt = remaining
      capHit = true
    }
    if (tickAmt <= 0) break

    await insertLateFeeRow(client, inv, tickDate, tickAmt)
    result.rowsWritten += 1
    existingSum += tickAmt
    existingDates.add(tickDate)
    monthsCharged.add(tickDate.slice(0, 7))
    remaining = capRemaining(capKind, capAmt, rentAmount, existingSum)

    if (capHit) {
      result.capsHit += 1
      break
    }
  }
}

const MAX_OCCURRENCES = 5000

/** Is `day` one of the days (n = 1, 2, …) of the calendar `at`? */
function fallsOn(at: (n: number) => string, day: string): boolean {
  for (let n = 1; n <= MAX_OCCURRENCES; n++) {
    const d = at(n)
    if (d === day) return true
    if (d > day) return false
  }
  return false
}

/**
 * The day of a bill's n-th accrual fee (n = 1, 2, …).
 *
 * Counted from the grace's end: every period after the bill's first late day.
 * 10/12 (Nic): once a bill has a fee, its calendar is the one it was fined on
 * — not today's grace setting, and not a lateness start that moved to the day
 * the bill was written — so neither an edited grace nor the 10/12 rule shifts
 * a weekly or monthly fee onto a new day and charges that period twice
 * (existing fees stand). A bill not yet fined counts from its first late day.
 *
 * The calendar a fined bill was fined on is the one its first fee sits on — as
 * its first late day, or as one of its periods: today's start first, then the
 * due date's (a bill fined before 10/12 counted from its due date even when GAM
 * wrote it later). 10/12: the first fee itself is not that start. A monthly fee
 * falls on the same day each month, clamped to a short month's last day; a bill
 * whose first fee was a monthly fee on June 30th (no first fee of its own: $0,
 * or a percent of no rent) took June 30th as its start, moved every later month
 * to the 30th, and charged July and August twice (7/31 and 7/30, 8/31 and
 * 8/30). Only when neither calendar has the first fee — the grace was edited
 * after the bill was fined — does the count go on from the first fee itself
 * (and processInvoice never charges a month twice).
 *
 * Counted back (due_date / due_date_inclusive): from the lateness start. A bill
 * fined before 10/12 counted back to its due date even when GAM wrote it later;
 * when its first fee sits on the due date's count and not on the start's, it
 * keeps the due date's count (its fees stand, and no period gets a second fee).
 */
function accrualCalendar(
  inv: QualifyingInvoice,
  from: LateFeeAccrualFrom,
  period: LateFeeAccrualPeriod,
  firstCharged: string | null,
): (n: number) => string {
  if (from === 'grace_end') {
    const graceEnd = (start: string) => {
      const first = lateFeeStartDate(start, inv.late_fee_grace_days)
      return { first, at: (n: number) => addAccrualPeriods(first, period, n) }
    }
    const now = graceEnd(inv.late_from)
    if (firstCharged == null || firstCharged < inv.due_date) return now.at
    for (const c of [now, graceEnd(inv.due_date)]) {
      if (c.first === firstCharged || fallsOn(c.at, firstCharged)) return c.at
    }
    return n => addAccrualPeriods(firstCharged, period, n)
  }
  const countedFrom = (start: string) => (n: number) =>
    nextAccrualDate(start, inv.late_fee_grace_days, period, n, from)
  if (firstCharged != null && inv.late_from !== inv.due_date
      && !fallsOn(countedFrom(inv.late_from), firstCharged) && fallsOn(countedFrom(inv.due_date), firstCharged)) {
    return countedFrom(inv.due_date)
  }
  return countedFrom(inv.late_from)
}

async function insertLateFeeRow(
  client: PoolClient,
  inv: QualifyingInvoice,
  dueDate: string,
  amount: number
): Promise<void> {
  const res = await client.query(`
    INSERT INTO payments (
      landlord_id, unit_id, lease_id, tenant_id,
      type, amount, status, entry_description,
      due_date, invoice_id
    ) VALUES (
      $1, $2, $3, $4,
      'late_fee', $5, 'pending', 'LATEFEE',
      $6, $7
    )
    ON CONFLICT (invoice_id, due_date)
      WHERE type = 'late_fee'
        AND status IN ('pending', 'processing', 'settled')
    DO NOTHING
    RETURNING id
  `, [
    inv.landlord_id,
    inv.unit_id,
    inv.lease_id,
    inv.tenant_id,
    amount,
    dueDate,
    inv.invoice_id,
  ])

  // S542: a fresh late fee is a fixed-income-timing indicator — ask
  // the tenant privately whether FlexPay would prevent the next one.
  // Own pool connection + never throws; fee generation must not care.
  if ((res.rowCount ?? 0) > 0 && inv.tenant_id) {
    const { maybeCreateQuestionnaire } = await import('../services/tenantQuestionnaires')
    await maybeCreateQuestionnaire(inv.tenant_id, 'late_fee_fixed_income')
  }
}

/**
 * Register the late-fee engine with the timezone cron manager.
 * Cron expression: minutes 0,10,20,30,40,50 of hour 0 in property timezone.
 * (6 firings per timezone per night, all within 00:00-00:59 local.)
 */
export function registerLateFeeEngine(): void {
  registerEngine('lateFees', {
    cronExpr: '0,10,20,30,40,50 0 * * *',
    handler: async (tz: string) => {
      const r = await generateLateFeesForTimezone(tz)
      if (r.invoicesScanned > 0 || r.errors.length > 0) {
        logger.info({ tz, scanned: r.invoicesScanned, wrote: r.rowsWritten, caps_hit: r.capsHit, errors: r.errors.length }, '[LateFees] scan complete')
      }
    },
    label: 'Late fees',
  })
}

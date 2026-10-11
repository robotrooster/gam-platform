/**
 * S609 — paying a landlord their share of money a tenant paid ahead.
 *
 * NIC, DIRECTIVE: "We hold anything paid ahead that we'd need to possibly give
 * back to a tenant on move out. It's gonna be hard to claw back from a
 * landlord... And the goal is to become the bank, to keep balances on file."
 * And on the release: "If somebody prepays a full year ahead of time, that money
 * sits on GAM's books, and we disburse to the landlord each month as invoice
 * comes due."
 *
 * So: a tenant pays twelve months up front. GAM holds all twelve. Each month,
 * when that month's bill is raised, that month's share — and only that month's
 * share — is handed to the landlord. A tenant who moves out in March gets the
 * rest back, and GAM never has to ask a landlord to send money back.
 *
 * THE DEFECT THIS FIXES. Marking next month's bill "covered by prepaid credit"
 * was already built (S537) and it settled the bill correctly — but it stopped
 * there. It never told the payout side that the landlord had earned anything, so
 * the money stayed on GAM's books permanently: the tenant's bill said paid, the
 * landlord's account said nothing arrived, and no report would ever have shown
 * the gap. Live today via shortened RV stays, which bank prepaid money the same
 * way. Every release now books the landlord's share the same way a card or bank
 * payment does, and it rides out on the ordinary weekly payout.
 *
 * NO SECOND PROCESSING FEE. The card or bank fee came out when the tenant
 * actually paid, months ago, on the whole amount they handed over. Releasing a
 * month later moves money that is already sitting on GAM's balance — no bank is
 * involved and nobody is charged again.
 *
 * WHAT DOES AND DOES NOT GET HANDED OVER. Whatever is the LANDLORD'S money —
 * rent, utilities, late fees off the lease, fees they billed by hand (S609,
 * Nic). GAM's own charges (a returned bank payment, a declined card, an
 * opt-in product) are stamped revenue_owner='gam'
 * at creation and are not paid out through this rail. A row also needs a unit,
 * since that is how a property and therefore an owner is resolved.
 *
 * S654/S655 — ONLY MONEY GAM HOLDS IS RELEASED. A check the landlord deposited,
 * cash at the desk, a typed-in carry-forward (funded_by 'landlord') and rent
 * already paid on a shortened stay (funded_by 'reclassified': it went out with
 * the original rent) settle the bill but pay out nothing. Spends are records in
 * the credit ledger (credit_uses); the landlord's share is read from the row's
 * gam_held_part (services/allocation).
 */

import type { PoolClient } from 'pg'
import {
  billHouseholdTenant, paidAheadDrawnByMonth, settleWholeBillIfCovered, usablePaidAheadSql, disputeClaimJoinSql,
} from './creditUse'
import { createAdminNotification } from './adminNotifications'
import { logger } from '../lib/logger'

/**
 * S653 (Nic): "use only a dedicated amount of the credit each month, to where
 * she would still get a partial bill each month."
 *
 * How much paid-ahead credit this lease may spend against `billingMonth`
 * (YYYY-MM-01): the credit on hand, capped by leases.prepaid_monthly_draw less
 * whatever this month has already drawn. NULL cap = the whole balance, which
 * is how a year's prepayment has always worked.
 *
 * S655: "drawn" is the credit ledger — paid-ahead uses set aside or spent on
 * this month's charges (credit_uses, held + applied) — and a withdrawn credit
 * (voided_at) is out of the balance. `remaining` is the USABLE remaining
 * (creditUse.usablePaidAheadSql): what a dispute or return of a credit's own
 * Stripe funding still claims is not the tenant's to draw.
 */
export async function prepaidDrawAvailable(
  client: PoolClient,
  leaseId: string,
  billingMonth: string,
): Promise<{ remaining: number; cap: number | null; drawnThisMonth: number; available: number }> {
  // Step 10: the usable remaining (creditUse.usablePaidAheadSql) — money a
  // dispute or return of the credit's own funding still claims is never drawn.
  const r = await client.query<{ remaining: string; cap: string | null }>(`
    SELECT COALESCE((SELECT SUM(${usablePaidAheadSql('c', 'dc')})
                       FROM lease_prepaid_credits c ${disputeClaimJoinSql('c', 'dc')}
                      WHERE c.lease_id = $1 AND c.amount_remaining > 0 AND c.voided_at IS NULL), 0)::text AS remaining,
           (SELECT prepaid_monthly_draw::text FROM leases WHERE id = $1) AS cap`,
    [leaseId])
  const row = r.rows[0]
  const month = `${String(billingMonth).slice(0, 7)}-01`
  const drawn = await paidAheadDrawnByMonth(client, [leaseId])
  const remaining = Math.round(Number(row?.remaining ?? 0) * 100) / 100
  const cap = row?.cap == null ? null : Math.round(Number(row.cap) * 100) / 100
  const drawnThisMonth = Math.round((drawn.get(`${leaseId}|${month}`) ?? 0) * 100) / 100
  const available = cap == null ? remaining : Math.max(0, Math.min(remaining, Math.round((cap - drawnThisMonth) * 100) / 100))
  return { remaining, cap, drawnThisMonth, available }
}

export interface PrepaidReleaseResult {
  /** Dollars of credit spent. */
  consumed:      number
  /** Charge rows settled by it. */
  rowsCovered:   number
  /** Dollars booked to the landlord (GAM-held credit only). */
  releasedToLandlord: number
}

/**
 * S537/S609 → S655: the bill run's credit step for one lease.
 *
 * Now THE WHOLE-BILL RULE (creditUse.settleWholeBillIfCovered, Nic 10/2):
 * credit — paid ahead, issued, deposit interest — settles the lease's bill
 * only when it covers every required row in full; anything less settles
 * nothing and the credit waits for the tenant's choice. A $200 monthly draw
 * cap no longer picks off a $60 water line on its own: the bill is whole or
 * untouched. GAM-held credit books the landlord's share with no second fee;
 * landlord-held and issued credit book nothing (bug 1, S654).
 *
 * Thin wrapper: the bill run (jobs/invoiceGeneration) and the portal charge
 * (services/rentCharge) now call the whole-bill rule themselves (Steps 7 and
 * 8), so no production code calls this; only its tests do. Deleted in Step 18;
 * do not add callers. Sends no receipt: it runs inside the caller's
 * transaction, and a receipt goes only after a commit.
 *
 * THE INVOICE ALWAYS WINS. This runs inside invoice generation's per-lease
 * transaction, so anything thrown here would roll back the whole invoice and
 * the tenant would get NO BILL AT ALL. Everything runs inside a savepoint: a
 * failure leaves the credit untouched and the charge open, an admin is told,
 * and the bill still goes out.
 */
export async function consumePrepaidCreditForInvoice(
  client: PoolClient,
  opts: { leaseId: string; invoiceId: string },
): Promise<PrepaidReleaseResult> {
  const NONE: PrepaidReleaseResult = { consumed: 0, rowsCovered: 0, releasedToLandlord: 0 }
  await client.query('SAVEPOINT prepaid_release')
  try {
    const hh = await billHouseholdTenant(client, opts.leaseId, opts.invoiceId)
    if (!hh) {
      await client.query('RELEASE SAVEPOINT prepaid_release')
      return NONE
    }
    const r = await settleWholeBillIfCovered(client, {
      tenantId: hh.tenantId, landlordId: hh.landlordId, source: 'whole_bill',
      onlyLeaseIds: [opts.leaseId], receipt: false,
    })
    await client.query('RELEASE SAVEPOINT prepaid_release')
    const result: PrepaidReleaseResult = {
      consumed: Math.round(r.leases.reduce((s, l) => s + l.creditUsed, 0) * 100) / 100,
      rowsCovered: r.settledIds.length,
      releasedToLandlord: Math.round(r.leases.reduce((s, l) => s + l.ownerShareBooked, 0) * 100) / 100,
    }
    if (result.consumed > 0) {
      logger.info({ leaseId: opts.leaseId, invoiceId: opts.invoiceId, ...result },
        '[prepaid-release] the whole bill was paid from credit')
    }
    return result
  } catch (e) {
    await client.query('ROLLBACK TO SAVEPOINT prepaid_release')
    logger.error({ err: e, ...opts }, '[prepaid-release] credit step failed — credit left untouched, invoice stands')
    await createAdminNotification({
      severity: 'critical',
      category: 'prepaid_release_failed',
      title: `Credit could not be applied to the bill on lease ${opts.leaseId}`,
      body: `The tenant's credit was NOT applied to invoice ${opts.invoiceId} (${e instanceof Error ? e.message : String(e)}). The invoice went out in full and the credit is intact. The next bill run or credit applies it once the cause is fixed.`,
      context: { lease_id: opts.leaseId, invoice_id: opts.invoiceId },
    }).catch(() => {})
    return NONE
  }
}

/**
 * S607 → S655 — applying credit to a tenant's open bill.
 *
 * Nic (S607): "The credit needs to go to the balance and kind of zero it out so
 * that the landlord's not thinking that the tenant still owes money."
 * Nic (S637): "Credits do not fucking split charges... we don't do partial
 * payments."
 * Nic (10/2, the rule that replaces both): credit applies by itself ONLY when it
 * covers the WHOLE bill. Otherwise the tenant chooses, at payment, "Use all $X"
 * or "Save it for later".
 *
 * This file used to spend credit itself: it settled whatever open charges a
 * credit could fully cover, oldest first, and lowered amount_remaining by hand.
 * That is how Kim Harland's $450 Move In Special was chopped into a water row,
 * a trash row and five late fees, and how a landlord's write-off showed as
 * collected rent. Every spend now goes through the credit ledger
 * (services/creditUse), and the only automatic spend is the whole-bill rule.
 *
 * THIN WRAPPER. The bill run (jobs/invoiceGeneration) and the portal charge
 * (services/rentCharge) now call creditUse.settleWholeBillIfCovered themselves
 * (Steps 7 and 8); no production code calls this, only its tests. Deleted in
 * Step 18. Do not add callers.
 */

import type { PoolClient } from 'pg'
import { billHouseholdTenant, settleWholeBillIfCovered } from './creditUse'

export interface CreditApplicationResult {
  /** Dollars of credit spent. */
  applied: number
  /** Charge rows settled by it. */
  rowsTouched: number
}

/**
 * @deprecated S655 — call creditUse.settleWholeBillIfCovered (inside a write)
 * or creditUse.runWholeBillCheckAfterCommit (after one).
 *
 * The whole-bill rule for one lease: when the household's credit covers every
 * required row of the lease's bill in full, the bill is settled from credit;
 * otherwise nothing changes. `scope` and `invoiceId` are accepted for the old
 * callers and no longer narrow anything: the whole bill is the unit (older
 * open rows on the lease included).
 */
export async function applyCreditsToOpenCharges(
  client: PoolClient,
  opts: { leaseId: string; scope: 'invoice' | 'lease'; invoiceId?: string },
): Promise<CreditApplicationResult> {
  const hh = await billHouseholdTenant(client, opts.leaseId, opts.invoiceId ?? null)
  if (!hh) return { applied: 0, rowsTouched: 0 }
  const r = await settleWholeBillIfCovered(client, {
    tenantId: hh.tenantId, landlordId: hh.landlordId, source: 'whole_bill',
    onlyLeaseIds: [opts.leaseId], receipt: false,
  })
  return {
    applied: Math.round(r.leases.reduce((s, l) => s + l.creditUsed, 0) * 100) / 100,
    rowsTouched: r.settledIds.length,
  }
}

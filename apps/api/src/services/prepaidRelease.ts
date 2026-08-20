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
 * Nic). GAM's own charges (a returned bank payment, a declined card, a
 * manual-payment recording, an opt-in product) are stamped revenue_owner='gam'
 * at creation and are not paid out through this rail. A row also needs a unit,
 * since that is how a property and therefore an owner is resolved.
 */

import type { PoolClient } from 'pg'
import { executeRentAllocation, ALLOCATABLE_PAYMENT_TYPES, type PaymentMethod } from './allocation'
import { createAdminNotification } from './adminNotifications'
import { logger } from '../lib/logger'

export interface PrepaidReleaseResult {
  /** Dollars of prepaid credit consumed. */
  consumed:      number
  /** Charge rows settled or reduced by it. */
  rowsCovered:   number
  /** Dollars booked to the landlord as earned this cycle. */
  releasedToLandlord: number
}

/**
 * Draw a lease's prepaid credit down against a freshly-raised invoice, oldest
 * credit first, and hand the landlord the rent/utility portion of what it
 * covered.
 *
 * Caller owns the transaction (invoice generation runs one per lease).
 */
/**
 * THE INVOICE ALWAYS WINS. This runs inside invoice generation's per-lease
 * transaction, so anything thrown here would roll back the whole invoice and the
 * tenant would get NO BILL AT ALL — a far worse outcome than the landlord's
 * money waiting another month.
 *
 * So the release runs inside a savepoint. If booking the landlord's share fails
 * (a property with no allocation rule, a missing processing rate, a PM plan with
 * no bank), everything this function did is undone: the credit is untouched and
 * the charge stays pending, exactly as if the tenant had no credit. The bill
 * still goes out, the tenant still owes the right amount, their money is still
 * theirs, and an admin is told loudly. Next month's run picks it up once the
 * configuration is fixed. Nothing is lost and nothing is silently wrong.
 */
export async function consumePrepaidCreditForInvoice(
  client: PoolClient,
  opts: { leaseId: string; invoiceId: string },
): Promise<PrepaidReleaseResult> {
  const NONE: PrepaidReleaseResult = { consumed: 0, rowsCovered: 0, releasedToLandlord: 0 }
  await client.query('SAVEPOINT prepaid_release')
  try {
    const r = await releaseInner(client, opts)
    await client.query('RELEASE SAVEPOINT prepaid_release')
    return r
  } catch (e) {
    await client.query('ROLLBACK TO SAVEPOINT prepaid_release')
    logger.error({ err: e, ...opts }, '[prepaid-release] could not book the landlord share — credit left untouched, invoice stands')
    await createAdminNotification({
      severity: 'critical',
      category: 'prepaid_release_failed',
      title: `Prepaid rent could not be released to the landlord on lease ${opts.leaseId}`,
      body: `The tenant's prepaid credit was NOT applied to invoice ${opts.invoiceId} because the landlord's share could not be booked (${e instanceof Error ? e.message : String(e)}). The invoice went out in full and the tenant's credit is intact — but they are being asked to pay for a month they already paid for. Fix the property's payout configuration; the next invoice run will apply the credit.`,
      context: { lease_id: opts.leaseId, invoice_id: opts.invoiceId },
    }).catch(() => {})
    return NONE
  }
}

async function releaseInner(
  client: PoolClient,
  opts: { leaseId: string; invoiceId: string },
): Promise<PrepaidReleaseResult> {
  const credits = await client.query<{ id: string; amount_remaining: string; source_remittance_id: string | null }>(
    `SELECT id, amount_remaining::text, source_remittance_id
       FROM lease_prepaid_credits
      WHERE lease_id = $1 AND amount_remaining > 0
      ORDER BY created_at ASC
      FOR UPDATE`,
    [opts.leaseId])

  let available = credits.rows.reduce((sum, c) => sum + Number(c.amount_remaining), 0)
  if (available <= 0.005) return { consumed: 0, rowsCovered: 0, releasedToLandlord: 0 }

  // How the tenant originally paid. Only used to pick which rate row the
  // allocation engine reads; the fee itself is suppressed on a release, so this
  // cannot change what anyone is charged. Defaults to bank when the credit came
  // from somewhere other than a remittance (a shortened stay, for instance).
  const methodRow = await client.query<{ payment_method: string }>(
    `SELECT payment_method FROM tenant_remittances
      WHERE id = ANY($1::uuid[]) AND payment_method IN ('ach','card')
      ORDER BY created_at DESC LIMIT 1`,
    [credits.rows.map(c => c.source_remittance_id).filter(Boolean)])
  const paymentMethod: PaymentMethod =
    methodRow.rows[0]?.payment_method === 'card' ? 'card' : 'ach'

  const fresh = await client.query<{ id: string; amount: string; type: string; revenue_owner: string; unit_id: string | null }>(
    `SELECT id, amount::text, type, revenue_owner, unit_id FROM payments
      WHERE invoice_id = $1 AND status = 'pending'
      ORDER BY due_date ASC, created_at ASC
      FOR UPDATE`,
    [opts.invoiceId])

  let consumed = 0
  let rowsCovered = 0
  // Rows the landlord has now earned. Collected as we go, allocated after the
  // draw-down so every covered row is already settled when allocation reads it.
  const earned: string[] = []

  for (const row of fresh.rows) {
    if (available <= 0.005) break
    const rowAmt = Number(row.amount)
    const apply = Math.min(rowAmt, available)
    // S609: the landlord's money is anything owed under the lease — rent,
    // utilities, late fees, fees they billed. GAM's own charges are stamped at
    // creation and stay with GAM; a row with no unit has no property to resolve
    // an owner from.
    const landlordsMoney =
      (ALLOCATABLE_PAYMENT_TYPES as readonly string[]).includes(row.type) &&
      row.revenue_owner === 'landlord' &&
      !!row.unit_id

    if (apply >= rowAmt - 0.005) {
      await client.query(
        `UPDATE payments
            SET status='settled', settled_at=NOW(), platform_held = $2,
                notes = COALESCE(notes || ' — ', '') || 'covered by prepaid credit (paid ahead)'
          WHERE id = $1`, [row.id, landlordsMoney])
      if (landlordsMoney) earned.push(row.id)
    } else {
      // Partly covered: the covered slice settles and a fresh row carries the
      // remainder, so the ledger keeps saying what was paid ahead versus what is
      // still owed rather than quietly rewriting the original amount.
      const remainder = Math.round((rowAmt - apply) * 100) / 100
      await client.query(
        `UPDATE payments
            SET amount = $2::numeric, status='settled', settled_at=NOW(), platform_held = $3,
                notes = COALESCE(notes || ' — ', '') || 'partially covered by prepaid credit'
          WHERE id = $1`, [row.id, apply.toFixed(2), landlordsMoney])
      await client.query(
        `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id,
                               type, amount, status, due_date, entry_description, notes, is_remainder)
         SELECT invoice_id, unit_id, lease_id, tenant_id, landlord_id,
                type, $2::numeric, 'pending', due_date, entry_description,
                'Remainder after prepaid credit application', TRUE
           FROM payments WHERE id = $1`,
        [row.id, remainder.toFixed(2)])
      if (landlordsMoney) earned.push(row.id)
    }
    available -= apply
    consumed += apply
    rowsCovered++
  }

  // Draw the consumed total down across the credits themselves, oldest first.
  let toDraw = consumed
  for (const c of credits.rows) {
    if (toDraw <= 0.005) break
    const draw = Math.min(Number(c.amount_remaining), toDraw)
    await client.query(
      `UPDATE lease_prepaid_credits
          SET amount_remaining = amount_remaining - $2::numeric, updated_at = NOW()
        WHERE id = $1`, [c.id, draw.toFixed(2)])
    toDraw -= draw
  }

  // Book the landlord's share of what they just earned. Without this the money
  // stays on GAM's balance forever — the whole point of the service.
  let releasedToLandlord = 0
  for (const paymentId of earned) {
    await executeRentAllocation(client, paymentId, paymentMethod, { feeAlreadyCollected: true })
    const owner = await client.query<{ amount: string }>(
      `SELECT amount::text FROM user_balance_ledger
        WHERE reference_id = $1 AND reference_type = 'payment'
          AND type = 'allocation_owner_share'`,
      [paymentId])
    releasedToLandlord += owner.rows.reduce((s, r) => s + Number(r.amount), 0)
  }

  const result = {
    consumed: Math.round(consumed * 100) / 100,
    rowsCovered,
    releasedToLandlord: Math.round(releasedToLandlord * 100) / 100,
  }
  if (result.consumed > 0) {
    logger.info({ leaseId: opts.leaseId, invoiceId: opts.invoiceId, ...result },
      '[prepaid-release] prepaid credit applied and landlord share booked')
  }
  return result
}

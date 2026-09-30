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

/**
 * S653 (Nic): "use only a dedicated amount of the credit each month, to where
 * she would still get a partial bill each month."
 *
 * How much paid-ahead credit this lease may spend against `billingMonth`
 * (YYYY-MM-01): the credit on hand, capped by leases.prepaid_monthly_draw less
 * whatever this month has already drawn. NULL cap = the whole balance, which
 * is how a year's prepayment has always worked.
 */
export async function prepaidDrawAvailable(
  client: PoolClient,
  leaseId: string,
  billingMonth: string,
): Promise<{ remaining: number; cap: number | null; drawnThisMonth: number; available: number }> {
  const r = await client.query<{ remaining: string; cap: string | null; drawn: string }>(`
    SELECT COALESCE((SELECT SUM(amount_remaining) FROM lease_prepaid_credits WHERE lease_id = $1 AND amount_remaining > 0), 0)::text AS remaining,
           (SELECT prepaid_monthly_draw::text FROM leases WHERE id = $1) AS cap,
           COALESCE((SELECT SUM(amount) FROM lease_prepaid_credit_draws WHERE lease_id = $1 AND billing_month = $2::date), 0)::text AS drawn`,
    [leaseId, billingMonth])
  const row = r.rows[0]
  const remaining = Math.round(Number(row?.remaining ?? 0) * 100) / 100
  const cap = row?.cap == null ? null : Math.round(Number(row.cap) * 100) / 100
  const drawnThisMonth = Math.round(Number(row?.drawn ?? 0) * 100) / 100
  const available = cap == null ? remaining : Math.max(0, Math.min(remaining, Math.round((cap - drawnThisMonth) * 100) / 100))
  return { remaining, cap, drawnThisMonth, available }
}

/** The billing month a payment row belongs to: its invoice's due month. */
export async function billingMonthOfInvoice(client: PoolClient, invoiceId: string): Promise<string> {
  const r = await client.query<{ m: string }>(
    `SELECT to_char(date_trunc('month', due_date), 'YYYY-MM-01') AS m FROM invoices WHERE id = $1`, [invoiceId])
  return r.rows[0]?.m ?? new Date().toISOString().slice(0, 7) + '-01'
}

/**
 * Spend `amount` of the lease's paid-ahead credit, oldest credit first, and
 * write the draw against `billingMonth` so the monthly cap can see it. Shared
 * by the invoice run and the desk (which settles one bill from cash + credit).
 */
export async function drawPrepaidCredit(
  client: PoolClient,
  opts: { leaseId: string; amount: number; billingMonth: string; paymentId?: string | null },
): Promise<number> {
  const credits = await client.query<{ id: string; amount_remaining: string }>(
    `SELECT id, amount_remaining::text FROM lease_prepaid_credits
      WHERE lease_id = $1 AND amount_remaining > 0 ORDER BY created_at ASC FOR UPDATE`, [opts.leaseId])
  let toDraw = Math.round(opts.amount * 100) / 100
  let drawn = 0
  for (const c of credits.rows) {
    if (toDraw <= 0.005) break
    const draw = Math.min(Number(c.amount_remaining), toDraw)
    await client.query(
      `UPDATE lease_prepaid_credits SET amount_remaining = amount_remaining - $2::numeric, updated_at = NOW() WHERE id = $1`,
      [c.id, draw.toFixed(2)])
    await client.query(
      `INSERT INTO lease_prepaid_credit_draws (lease_id, credit_id, payment_id, amount, billing_month) VALUES ($1, $2, $3, $4, $5)`,
      [opts.leaseId, c.id, opts.paymentId ?? null, draw.toFixed(2), opts.billingMonth])
    toDraw = Math.round((toDraw - draw) * 100) / 100
    drawn = Math.round((drawn + draw) * 100) / 100
  }
  return drawn
}

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

  // S653: the month's cap, if the resident asked for one. What this invoice
  // may use is the smaller of the credit on hand and the cap less what the
  // month has already drawn.
  const billingMonth = await billingMonthOfInvoice(client, opts.invoiceId)
  const draw = await prepaidDrawAvailable(client, opts.leaseId, billingMonth)
  let available = draw.available
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
    // S609: the landlord's money is anything owed under the lease — rent,
    // utilities, late fees, fees they billed. GAM's own charges are stamped at
    // creation and stay with GAM; a row with no unit has no property to resolve
    // an owner from.
    const landlordsMoney =
      (ALLOCATABLE_PAYMENT_TYPES as readonly string[]).includes(row.type) &&
      row.revenue_owner === 'landlord' &&
      !!row.unit_id

    // S637 — MONEY PAID AHEAD DOES NOT SPLIT A CHARGE EITHER.
    //
    // Nic (DIRECTIVE): "we don't do partial payments." This did the same split
    // as the landlord-credit path — covered slice settled, `Remainder after…`
    // row inserted — and defended it in a comment as keeping "the ledger"
    // honest, which is backwards: it rewrote the rent row instead of leaving
    // the balance to carry.
    //
    // Prepaid money differs from a landlord credit in one way that matters: the
    // tenant really did hand it over and GAM is holding it, so settling a bill
    // out of it IS a real settlement and the landlord genuinely earns that
    // month's share. That part is untouched. What changes is that a bill is
    // cleared WHOLE or left alone, with the rest staying on the account as the
    // tenant's money — exactly what a year's prepayment is supposed to do while
    // it waits for next month's bill.
    if (rowAmt > available + 0.005) continue

    await client.query(
      `UPDATE payments
          SET status='settled', settled_at=NOW(), platform_held = $2,
              notes = COALESCE(notes || ' — ', '') || 'covered by prepaid credit (paid ahead)'
        WHERE id = $1`, [row.id, landlordsMoney])
    if (landlordsMoney) earned.push(row.id)
    available -= rowAmt
    consumed += rowAmt
    rowsCovered++
  }

  // Draw the consumed total down across the credits themselves, oldest first,
  // written against the month so the cap can see it (S653).
  if (consumed > 0.005) {
    await drawPrepaidCredit(client, { leaseId: opts.leaseId, amount: consumed, billingMonth })
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

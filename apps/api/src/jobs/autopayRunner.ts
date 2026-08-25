/**
 * S609 — the job that actually charges a tenant's scheduled rent.
 *
 * Runs once a day per property timezone, in the morning local time, so a bank
 * pull happens during a business day the tenant would expect rather than at
 * whatever hour the server thinks it is.
 *
 * WHAT IT CHARGES: the live outstanding balance, read at the moment it runs.
 * Nothing is forecast (Nic) — between the tenant choosing a day and the charge
 * landing, the balance moves for entirely ordinary reasons, so a figure captured
 * in advance is a promise the system cannot keep. It charges the balance in
 * full, exactly like the Pay button, through exactly the same code
 * (services/rentCharge) — a scheduled payment and a pressed button must never
 * produce a different fee or a different owner share.
 *
 * WHEN IT RUNS FOR A LEASE: on the day the tenant picked, or on the rent due
 * date if they picked nothing. A day EARLIER in the month than the due day means
 * next month's occurrence — choosing the 1st when rent is due the 5th cannot
 * mean "four days before it is owed".
 *
 * NEVER TWICE: `last_run_cycle` is claimed in its own committed statement BEFORE
 * the charge is attempted, and only a row that has not already claimed the cycle
 * can claim it. A restarted job, an overlapping run, or a second server can only
 * lose that race — none of them can charge a tenant a second time.
 *
 * ON FAILURE (Nic): the schedule stays on, both sides are told, and it disarms
 * itself after two failures in a row. See the migration for the reasoning.
 */

import { query, queryOne } from '../db'
import { getStripe } from '../lib/stripe'
import { chargeLeaseBalance } from '../services/rentCharge'
import { createNotification } from '../services/notifications'
import { logger } from '../lib/logger'
import { registerEngine } from './timezoneCronManager'

/** Failures in a row before autopay switches itself off (Nic). */
export const AUTOPAY_DISARM_AFTER_FAILURES = 2

export interface AutopayRunResult {
  considered: number
  charged:    number
  failed:     number
  skipped:    number
}

/**
 * Is today the day this lease's autopay should run?
 *
 * `pullDay` null → the rent due day. Otherwise the chosen day, except that a
 * chosen day before the due day belongs to the NEXT cycle — which, from the
 * runner's point of view, still just means "fire on that date".
 */
export function isPullDayToday(
  todayDayOfMonth: number,
  pullDay: number | null,
  rentDueDay: number | null,
): boolean {
  const target = pullDay ?? rentDueDay ?? 1
  return todayDayOfMonth === target
}

/** Today's date in a timezone, as {ymd, day}. */
export function localToday(tz: string): { ymd: string; day: number } {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  })
  const ymd = fmt.format(new Date())
  return { ymd, day: Number(ymd.slice(8, 10)) }
}

/**
 * Charge every scheduled autopay falling due today for properties in `tz`.
 */
export async function runAutopayForTimezone(tz: string): Promise<AutopayRunResult> {
  const { ymd, day } = localToday(tz)
  // The cycle key: one attempt per lease per calendar month.
  const cycle = `${ymd.slice(0, 7)}-01`

  const candidates = await query<{
    autopay_id: string; tenant_id: string; lease_id: string
    pull_day: number | null; rent_due_day: number | null
    payment_method_id: string | null; stripe_customer_id: string | null
  }>(
    `SELECT a.id AS autopay_id, a.tenant_id, a.lease_id, a.pull_day,
            l.rent_due_day, a.payment_method_id, t.stripe_customer_id
       FROM tenant_autopay a
       JOIN leases l   ON l.id = a.lease_id
       JOIN units u    ON u.id = l.unit_id
       JOIN properties p ON p.id = u.property_id
       JOIN tenants t  ON t.id = a.tenant_id
      WHERE a.enabled
        AND l.status = 'active'
        AND p.timezone = $1
        AND (a.last_run_cycle IS NULL OR a.last_run_cycle < $2::date)`,
    [tz, cycle])

  const result: AutopayRunResult = { considered: 0, charged: 0, failed: 0, skipped: 0 }

  for (const c of candidates) {
    if (!isPullDayToday(day, c.pull_day, c.rent_due_day)) continue
    result.considered++

    // Claim the cycle FIRST, in its own committed statement. Whatever happens
    // next — success, decline, a crash mid-charge — this tenant cannot be
    // charged again this month by another run.
    const claimed = await queryOne<{ id: string }>(
      `UPDATE tenant_autopay
          SET last_run_cycle = $2::date, updated_at = NOW()
        WHERE id = $1 AND (last_run_cycle IS NULL OR last_run_cycle < $2::date)
        RETURNING id`,
      [c.autopay_id, cycle])
    if (!claimed) { result.skipped++; continue }

    try {
      const method = await resolvePaymentMethod(c.payment_method_id, c.stripe_customer_id)
      if (!method) {
        throw new Error('No usable payment method on file')
      }

      // The live balance, right now. Nothing forecast.
      // S622: autopay charges what the LEASE billed — never the carried-forward
      // balance.
      //
      // Arrears imported from a landlord's previous system are the one charge a
      // tenant may pay in part, precisely because they are usually large and on
      // a catch-up footing. Sweeping them into an automatic pull inverts that:
      // a tenant who set up autopay for $800 of rent would wake up to an $1,800
      // debit on their chosen day, out of an account that may hold neither. That
      // is worse than the FIFO trap this carve-out exists to prevent — it does
      // not just misapply the money, it takes money that was never authorised.
      //
      // Paying arrears down stays a deliberate act by the tenant, in whatever
      // amount they can manage, through Pay Now.
      const balance = await queryOne<{ total: string }>(
        `SELECT COALESCE(SUM(amount), 0)::text AS total FROM payments
          WHERE lease_id = $1 AND tenant_id = $2
            AND type <> 'carried_balance'
            AND ((status = 'pending' AND stripe_payment_intent_id IS NULL)
                 OR status = 'failed')`,
        [c.lease_id, c.tenant_id])
      const amount = Math.round(Number(balance?.total ?? 0) * 100) / 100
      if (amount <= 0) {
        // Nothing owed — a tenant who is paid ahead, or who already paid by
        // hand this month. Not a failure and not worth a notification.
        result.skipped++
        await query(
          `UPDATE tenant_autopay SET last_success_cycle = $2::date, consecutive_failures = 0,
                  last_error = NULL, updated_at = NOW() WHERE id = $1`,
          [c.autopay_id, cycle])
        continue
      }

      await chargeLeaseBalance({
        tenantId:          c.tenant_id,
        leaseId:           c.lease_id,
        amount,
        paymentMethodId:   method.id,
        paymentMethodType: method.type,
        source:            'autopay',
      })

      await query(
        `UPDATE tenant_autopay
            SET last_success_cycle = $2::date, consecutive_failures = 0,
                last_error = NULL, updated_at = NOW()
          WHERE id = $1`,
        [c.autopay_id, cycle])
      result.charged++

      await notifyTenant(c.tenant_id, 'autopay',
        'Autopay submitted',
        method.type === 'ach'
          ? `We've started your scheduled rent payment of $${amount.toFixed(2)}. Bank payments usually take 3–5 business days to clear.`
          : `Your card was charged $${amount.toFixed(2)} for rent. A receipt is on its way.`)
    } catch (e) {
      result.failed++
      await handleFailure(c, e)
    }
  }

  if (result.considered > 0) logger.info({ tz, ...result }, '[autopay]')
  return result
}

/**
 * Which method to charge. A tenant who named one gets that; otherwise whatever
 * their default is TODAY, so someone who switches from card to bank does not
 * have to re-arm autopay.
 *
 * A bank still awaiting microdeposit confirmation cannot be charged, and a card
 * that has since been removed is gone — either way this returns null and the
 * failure path tells the tenant, rather than throwing an opaque Stripe error.
 */
async function resolvePaymentMethod(
  chosenId: string | null,
  stripeCustomerId: string | null,
): Promise<{ id: string; type: 'ach' | 'card' } | null> {
  if (!stripeCustomerId) return null
  const stripe = getStripe()

  if (chosenId) {
    try {
      const pm = await stripe.paymentMethods.retrieve(chosenId)
      if (pm.customer === stripeCustomerId) {
        return { id: pm.id, type: pm.type === 'card' ? 'card' : 'ach' }
      }
    } catch { /* removed since it was chosen — fall through to the default */ }
  }

  const customer = await stripe.customers.retrieve(stripeCustomerId)
  const defaultId = (customer && !('deleted' in customer && customer.deleted))
    ? ((customer as any).invoice_settings?.default_payment_method as string | null) ?? null
    : null
  if (defaultId) {
    const pm = await stripe.paymentMethods.retrieve(defaultId)
    return { id: pm.id, type: pm.type === 'card' ? 'card' : 'ach' }
  }

  // No default set: take a verified bank, else a card.
  const [banks, cards] = await Promise.all([
    stripe.paymentMethods.list({ customer: stripeCustomerId, type: 'us_bank_account', limit: 1 }),
    stripe.paymentMethods.list({ customer: stripeCustomerId, type: 'card', limit: 1 }),
  ])
  if (banks.data[0]) return { id: banks.data[0].id, type: 'ach' }
  if (cards.data[0]) return { id: cards.data[0].id, type: 'card' }
  return null
}

/**
 * A pull failed. Count it, tell both sides, and switch autopay off if this is
 * the second failure in a row.
 */
async function handleFailure(
  c: { autopay_id: string; tenant_id: string; lease_id: string },
  e: unknown,
): Promise<void> {
  const message = e instanceof Error ? e.message : String(e)
  const row = await queryOne<{ consecutive_failures: number }>(
    `UPDATE tenant_autopay
        SET consecutive_failures = consecutive_failures + 1,
            last_error = $2, updated_at = NOW()
      WHERE id = $1
      RETURNING consecutive_failures`,
    [c.autopay_id, message.slice(0, 500)])
  const failures = row?.consecutive_failures ?? 1
  const disarming = failures >= AUTOPAY_DISARM_AFTER_FAILURES

  if (disarming) {
    await query(
      `UPDATE tenant_autopay
          SET enabled = FALSE, disarmed_at = NOW(),
              disarmed_reason = 'Two scheduled payments in a row could not be completed.',
              updated_at = NOW()
        WHERE id = $1`,
      [c.autopay_id])
  }

  logger.warn({ leaseId: c.lease_id, failures, disarming, err: message }, '[autopay] pull failed')

  // The tenant believes the money moved. Tell them plainly that it did not, and
  // that rent is still owed — never a bank error code.
  await notifyTenant(c.tenant_id, 'autopay_failed',
    disarming ? 'Autopay has been turned off' : 'Your scheduled rent payment didn’t go through',
    disarming
      ? 'Two scheduled payments in a row couldn’t be completed, so we’ve switched autopay off to stop your bank charging you for further attempts. Your rent is still owed — pay it from the Payments page, then turn autopay back on.'
      : 'Your scheduled rent payment couldn’t be completed, so your rent is still owed. Check the account you pay from, then pay from the Payments page. Autopay is still on and will try again next month.')

  // The landlord is watching a lease that says a payment is scheduled. Without
  // this they read the silence as a tenant who stopped paying.
  const landlord = await queryOne<{ user_id: string; unit_number: string; property_name: string }>(
    `SELECT lu.id AS user_id, u.unit_number, pr.name AS property_name
       FROM leases l
       JOIN units u ON u.id = l.unit_id
       JOIN properties pr ON pr.id = u.property_id
       JOIN landlords ld ON ld.id = l.landlord_id
       JOIN users lu ON lu.id = ld.user_id
      WHERE l.id = $1`,
    [c.lease_id])
  if (landlord) {
    await createNotification({
      userId: landlord.user_id,
      type: 'autopay_failed',
      title: `Scheduled rent payment didn’t go through — ${landlord.property_name} · Unit ${landlord.unit_number}`,
      body: disarming
        ? 'The tenant’s scheduled payment failed twice, so it has been switched off. Their rent is still owed and they have been told.'
        : 'The tenant’s scheduled payment failed. Their rent is still owed and they have been told. The schedule is still on for next month.',
      actionUrl: '/leases',
    }).catch(() => {})
  }
}

async function notifyTenant(
  tenantId: string, type: 'autopay' | 'autopay_failed', title: string, body: string,
): Promise<void> {
  const u = await queryOne<{ user_id: string }>(
    `SELECT user_id FROM tenants WHERE id = $1`, [tenantId])
  if (!u?.user_id) return
  await createNotification({
    userId: u.user_id, type, title, body, actionUrl: '/payments',
  }).catch(() => {})
}

/**
 * Register autopay with the timezone cron manager.
 *
 * 09:00 in the PROPERTY's local time — the pull happens during a business day
 * the tenant would recognise, not at whatever hour the server happens to be in.
 * Late fees run at local midnight and invoices at local 07:00, so by 09:00 the
 * balance this job reads already includes today's charges and today's accrual.
 */
export function registerAutopayEngine(): void {
  registerEngine('autopay', {
    cronExpr: '0 9 * * *',
    handler: async (tz: string) => {
      try {
        await runAutopayForTimezone(tz)
      } catch (e) {
        logger.error({ err: e, tz }, '[autopay] error')
      }
    },
    label: 'Tenant autopay',
  })
}

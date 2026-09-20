/**
 * S652 — the standing rule that suspends a landlord's portal, run by nobody.
 *
 * Nic, throwing out the version where a person at GAM decided: "I don't want it
 * flipped by a person. Like, that means somebody manually had to go in there and
 * do that and make a choice. And choice creates the opportunity for
 * discrimination. We need to have a standing company rule and a sweep that
 * happens when that threshold is reached."
 *
 * WHY THE RULE IS NOT A DOLLAR AMOUNT. That was my instinct and it is wrong in
 * both directions at once. Nic: "we can't have a flat dollar amount because that
 * gives the smaller landlords years to potentially not pay. And smaller or
 * bigger landlords would be locked out immediately on a technicality. So it
 * needs to be per billing cycle." A $500 trigger is four years of patience for
 * somebody running a duplex on the $10 minimum, and a fortnight's grace for a
 * 300-unit portfolio. The same number means two completely different things.
 *
 * THE RULE, in his words: "if somebody's on the $10 a month minimum to run their
 * duplex and they owe us and it can't be collected because they paid cash, and
 * then the next bill comes around for the other $10 to total $20, if they don't
 * pay that within like 48 hours of that second bill coming due, it's locked."
 *
 * So: a bill went uncollected, the NEXT month's bill arrived, and 48 hours later
 * both are still sitting there with no way to take the money. Two cycles is the
 * grace period, and it scales itself — it is one month of patience whether the
 * bill is $10 or $4,000.
 *
 * "And it will cut them off right in the middle of rent collection, which is the
 * biggest headache, which is kind of the point."
 *
 * WHAT IT WILL NOT DO: lock somebody GAM can actually collect from. If rent is
 * flowing there is money to net against, and if a bank is linked the debit sweep
 * takes it. This only reaches a landlord whose tenants all pay cash and who has
 * connected no bank — which is to say, somebody who has quietly opted out of
 * every collection route GAM has. Tenants are never touched (see middleware/auth).
 */
import { query } from '../db'
import { logger } from '../lib/logger'

/** Hours after the second bill lands before the portal goes. */
export const LOCK_GRACE_HOURS = 48

export interface LockCandidate {
  landlordId: string
  businessName: string | null
  owed: number
  /** How many monthly bills are sitting uncollected. Two is the trigger. */
  unpaidCycles: number
  /** When the most recent uncollected bill was raised. */
  latestBillAt: string
  hoursSinceLatestBill: number
}

/**
 * Landlords the rule has caught, and how close the rest are.
 *
 * `secondBillAt` exists so the WARNING can go out when the second bill lands
 * rather than at the moment of the lock — Nic: "they'll get warnings before
 * that, but that's the absolute cutoff."
 */
export async function lockCandidates(): Promise<{ due: LockCandidate[]; warning: LockCandidate[] }> {
  const rows = await query<any>(
    `SELECT l.id, l.business_name, l.platform_locked_at, l.gam_debit_payment_method_id,
            COALESCE(SUM(c.amount - c.collected_amount), 0)::float AS owed,
            -- Only the RECURRING bill counts as a cycle. A manual-payment fee or
            -- the cost of a bank transfer rides along on somebody's balance; it
            -- is not "the next bill coming around".
            COUNT(DISTINCT date_trunc('month', c.created_at))
              FILTER (WHERE c.source_type = 'platform_fee_accrual')::int AS unpaid_cycles,
            MAX(c.created_at) FILTER (WHERE c.source_type = 'platform_fee_accrual') AS latest_bill_at,
            EXISTS (
              -- Money moving through GAM at this landlord in the last 35 days.
              -- 'settled' is the only status that means it actually moved;
              -- payments.status has no 'succeeded'.
              SELECT 1 FROM payments p
               WHERE p.landlord_id = l.id AND p.status = 'settled'
                 AND p.created_at >= NOW() - INTERVAL '35 days') AS has_flow
       FROM landlords l
       JOIN landlord_gam_charges c ON c.landlord_id = l.id AND c.collected_amount < c.amount
      WHERE l.is_demo = FALSE AND l.platform_locked_at IS NULL
      GROUP BY l.id`)

  const due: LockCandidate[] = []
  const warning: LockCandidate[] = []
  for (const r of rows) {
    if (!(Number(r.owed) > 0)) continue
    // Collectable is not delinquent. Netting takes it out of money already
    // moving; a linked bank gets swept at 08:30. Neither needs a lock.
    if (r.has_flow === true) continue
    if (r.gam_debit_payment_method_id) continue
    if (!r.latest_bill_at) continue

    const hours = (Date.now() - new Date(r.latest_bill_at).getTime()) / 3_600_000
    const c: LockCandidate = {
      landlordId: r.id,
      businessName: r.business_name,
      owed: Math.round(Number(r.owed) * 100) / 100,
      unpaidCycles: Number(r.unpaid_cycles),
      latestBillAt: new Date(r.latest_bill_at).toISOString(),
      hoursSinceLatestBill: Math.floor(hours),
    }
    if (c.unpaidCycles >= 2 && hours >= LOCK_GRACE_HOURS) due.push(c)
    else if (c.unpaidCycles >= 2) warning.push(c)
  }
  return { due, warning }
}

/**
 * Apply the rule. Locks, warns, and gives access back to anyone who has settled.
 *
 * Unlocking is automatic on purpose: the lock exists to collect money, so the
 * instant the money is there the reason is gone. Nobody should have to ring GAM
 * and wait for somebody to notice they paid.
 */
export async function runPortalLockSweep(): Promise<{
  locked: number; warned: number; released: number
}> {
  // Released first — somebody who paid overnight must never be re-locked by the
  // same run that is about to read their balance.
  const released = await query<{ id: string; business_name: string | null }>(
    `UPDATE landlords l
        SET platform_locked_at = NULL, uncollectable_notice_at = NULL, updated_at = NOW()
      WHERE l.platform_locked_at IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM landlord_gam_charges c
           WHERE c.landlord_id = l.id AND c.collected_amount < c.amount)
      RETURNING l.id, l.business_name`)
  for (const r of released) {
    logger.warn({ landlordId: r.id }, '[portal-lock] balance settled — access restored')
  }

  const { due, warning } = await lockCandidates()
  const { createNotification } = await import('./notifications')

  let warned = 0
  for (const c of warning) {
    // One warning per second bill, not one per night. A daily countdown email
    // is how somebody learns to filter GAM's mail the week before it matters.
    const already = await query<{ id: string }>(
      `SELECT id FROM notifications
        WHERE landlord_id = $1 AND type = 'gam_portal_lock_warning'
          AND created_at >= $2::timestamptz`, [c.landlordId, c.latestBillAt])
    if (already.length) continue
    const owner = await ownerOf(c.landlordId)
    if (!owner) continue
    await createNotification({
      userId: owner.user_id,
      landlordId: c.landlordId,
      type: 'gam_portal_lock_warning',
      title: 'Your GAM balance is two bills overdue',
      body: `$${c.owed.toFixed(2)} is outstanding across two billing cycles and we have no way to `
        + `collect it — no rent is moving through GAM and there is no bank account on file. `
        + `Access to the portal is suspended ${LOCK_GRACE_HOURS} hours after this month's bill unless `
        + `it is settled. Connecting a bank under Banking settles it automatically.`,
      actionUrl: '/banking',
      sendEmail: true,
      emailTo: owner.email,
      emailSubject: 'Your Gold Asset Management account is about to be suspended',
      emailHtml: `<p>Hi ${owner.first_name || 'there'},</p>`
        + `<p><strong>$${c.owed.toFixed(2)}</strong> is outstanding on your Gold Asset Management `
        + `account across two billing cycles, and we have no way to collect it — no rent is moving `
        + `through GAM, and there is no bank account on file.</p>`
        + `<p>Unless it is settled, portal access is suspended ${LOCK_GRACE_HOURS} hours after this `
        + `month's bill. Connecting a bank account under <strong>Banking</strong> settles it `
        + `automatically and takes a minute.</p>`
        + `<p>Your tenants are not affected either way — rent keeps being collected as normal.</p>`,
    }).catch(() => {})
    warned++
  }

  let locked = 0
  for (const c of due) {
    await query(
      `UPDATE landlords
          SET platform_locked_at = NOW(),
              platform_locked_reason = $2,
              updated_at = NOW()
        WHERE id = $1 AND platform_locked_at IS NULL`,
      [c.landlordId,
       `$${c.owed.toFixed(2)} outstanding across ${c.unpaidCycles} billing cycles with no way to collect it.`])
    const owner = await ownerOf(c.landlordId)
    if (owner) {
      await createNotification({
        userId: owner.user_id,
        landlordId: c.landlordId,
        type: 'gam_portal_locked',
        title: 'Your GAM account is suspended',
        body: `$${c.owed.toFixed(2)} has been outstanding across ${c.unpaidCycles} billing cycles. `
          + `Access is restored automatically as soon as the balance is settled.`,
        sendEmail: true,
        emailTo: owner.email,
        emailSubject: 'Your Gold Asset Management account has been suspended',
        emailHtml: `<p>Hi ${owner.first_name || 'there'},</p>`
          + `<p>Access to your Gold Asset Management portal has been suspended. `
          + `<strong>$${c.owed.toFixed(2)}</strong> has been outstanding across ${c.unpaidCycles} `
          + `billing cycles and we have not been able to collect it.</p>`
          + `<p>Connecting a bank account restores access automatically — you can still reach that `
          + `page while the rest of the portal is closed. Or reply to this email and we will sort it `
          + `out with you.</p>`
          + `<p>Your tenants are not affected. Rent is still being collected and they can still `
          + `reach you.</p>`,
      }).catch(() => {})
    }
    logger.error({ landlordId: c.landlordId, owed: c.owed, cycles: c.unpaidCycles },
      '[portal-lock] SUSPENDED — two cycles uncollected with no route to collect')
    locked++
  }

  return { locked, warned, released: released.length }
}

async function ownerOf(landlordId: string) {
  const rows = await query<{ user_id: string; email: string; first_name: string | null }>(
    `SELECT l.user_id, u.email, u.first_name
       FROM landlords l JOIN users u ON u.id = l.user_id WHERE l.id = $1`, [landlordId])
  return rows[0] ?? null
}

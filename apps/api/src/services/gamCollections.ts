/**
 * S652 — GAM's own collections book: what we were owed, and what actually came in.
 *
 * Nic: "we need a log on the admin side that money that we are actually
 * expected to take in is taken in. We need to operate bookkeeping on our own
 * stats. And immediately reach out to people when there's a problem."
 *
 * NOT THE SAME THING AS THE EARNINGS DASHBOARD, and the difference is the whole
 * point. platform_revenue_ledger answers "what did GAM earn" — it books a fee
 * the moment it is earned, which is correct accrual and says nothing about
 * whether the money arrived. This answers "what did GAM actually get", which is
 * the question that matters when a park is all cash and every collection route
 * runs through a bank nobody has linked.
 *
 * The gap between the two numbers IS the report. A month where they match is a
 * month nobody needs to read.
 */
import { query } from '../db'
import { logger } from '../lib/logger'
import { debitThresholdForLandlord } from './landlordGamAccount'

export interface CollectionsRow {
  landlordId: string
  businessName: string | null
  billed: number
  collected: number
  outstanding: number
  /** Days since the oldest still-unpaid charge was raised. */
  oldestUnpaidDays: number | null
  /** How GAM would get this: netted from a payout, pulled from a bank, or nothing. */
  route: 'netting' | 'bank_debit' | 'none'
  overThreshold: boolean
  noticeSentAt: string | null
  lockedAt: string | null
}

export interface CollectionsBook {
  billed: number
  collected: number
  outstanding: number
  /** What GAM has no route to collect — the number that should be zero. */
  uncollectable: number
  rows: CollectionsRow[]
}

/**
 * Every landlord who has ever been billed by GAM, and what came of it.
 *
 * Includes the settled ones on purpose. A collections report that only lists
 * problems cannot tell you whether the problems are two out of three or two out
 * of two hundred, and that ratio is the only thing that makes the number mean
 * anything.
 */
export async function collectionsBook(): Promise<CollectionsBook> {
  const rows = await query<any>(
    `SELECT l.id, l.business_name, l.platform_locked_at, l.uncollectable_notice_at,
            l.gam_debit_payment_method_id,
            COALESCE(SUM(c.amount), 0)::float                      AS billed,
            COALESCE(SUM(c.collected_amount), 0)::float            AS collected,
            MIN(c.created_at) FILTER (WHERE c.collected_amount < c.amount) AS oldest_unpaid,
            EXISTS (SELECT 1 FROM properties p
                     WHERE p.landlord_id = l.id AND p.review_status = 'active') AS has_property
       FROM landlords l
       JOIN landlord_gam_charges c ON c.landlord_id = l.id
      WHERE l.is_demo = FALSE
      GROUP BY l.id
      ORDER BY (COALESCE(SUM(c.amount),0) - COALESCE(SUM(c.collected_amount),0)) DESC`)

  const out: CollectionsRow[] = []
  let billed = 0, collected = 0, uncollectable = 0

  for (const r of rows) {
    const rowBilled = Math.round(Number(r.billed) * 100) / 100
    const rowCollected = Math.round(Number(r.collected) * 100) / 100
    const outstanding = Math.round((rowBilled - rowCollected) * 100) / 100
    billed += rowBilled
    collected += rowCollected

    const threshold = await debitThresholdForLandlord(r.id)
    // Netting is the preferred route and costs nothing: it takes GAM's fee out
    // of money already moving to the landlord. It only exists if money IS
    // moving, which is why an all-cash park falls through to the bank debit.
    // 'settled' is the only status that means the money actually moved —
    // payments.status is pending/processing/settled/failed/returned, and there
    // is no 'succeeded'. A query for one silently matches nothing, which would
    // have reported every landlord on earth as having no way to pay.
    const netting = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM payments
        WHERE landlord_id = $1 AND status = 'settled'
          AND created_at >= NOW() - INTERVAL '35 days'`, [r.id])
    const hasFlow = Number(netting[0]?.n ?? 0) > 0
    const route: CollectionsRow['route'] = hasFlow ? 'netting'
      : r.gam_debit_payment_method_id ? 'bank_debit' : 'none'
    if (outstanding > 0 && route === 'none') uncollectable += outstanding

    out.push({
      landlordId: r.id,
      businessName: r.business_name,
      billed: rowBilled,
      collected: rowCollected,
      outstanding,
      oldestUnpaidDays: r.oldest_unpaid
        ? Math.floor((Date.now() - new Date(r.oldest_unpaid).getTime()) / 86400000)
        : null,
      route,
      overThreshold: outstanding >= threshold,
      noticeSentAt: r.uncollectable_notice_at,
      lockedAt: r.platform_locked_at,
    })
  }

  return {
    billed: Math.round(billed * 100) / 100,
    collected: Math.round(collected * 100) / 100,
    outstanding: Math.round((billed - collected) * 100) / 100,
    uncollectable: Math.round(uncollectable * 100) / 100,
    rows: out,
  }
}

/**
 * Tell a landlord GAM cannot collect from them — once, and early.
 *
 * Nic: "immediately reach out to people when there's a problem." The problem
 * here is silent by construction: the fee accrues, the sweep finds no bank, and
 * the only trace is an error line. The landlord's first hint under the old
 * behaviour would have been a locked portal, which is an ambush.
 *
 * Sent ONCE per landlord (uncollectable_notice_at). A monthly drip about the
 * same unlinked bank teaches people to filter GAM's mail, and the one message
 * that matters later would go with it.
 */
export async function noticeUncollectableLandlords(): Promise<{ notified: number }> {
  const { uncollectableLandlords } = await import('./landlordGamDebit')
  const candidates = (await uncollectableLandlords()).filter((c) => !c.noticeSentAt && !c.lockedAt)
  if (!candidates.length) return { notified: 0 }

  const { createNotification } = await import('./notifications')
  let notified = 0
  for (const c of candidates) {
    const owner = await query<{ user_id: string; email: string; first_name: string | null }>(
      `SELECT l.user_id, u.email, u.first_name
         FROM landlords l JOIN users u ON u.id = l.user_id WHERE l.id = $1`, [c.landlordId])
    const o = owner[0]
    if (!o) continue
    await createNotification({
      userId: o.user_id,
      landlordId: c.landlordId,
      type: 'gam_balance_uncollectable',
      title: `We can't collect your Gold Asset Management balance`,
      body: `Your account has an outstanding balance of $${c.owed.toFixed(2)} and we have no bank `
        + `account we can collect it from. Connecting one under Banking takes a minute and settles it `
        + `automatically. If we cannot collect, access to the portal is eventually suspended — `
        + `your tenants are never affected.`,
      actionUrl: '/banking',
      sendEmail: true,
      emailTo: o.email,
      emailSubject: 'Action needed: we cannot collect your GAM balance',
      emailHtml: `<p>Hi ${o.first_name || 'there'},</p>`
        + `<p>Your Gold Asset Management account has an outstanding balance of `
        + `<strong>$${c.owed.toFixed(2)}</strong>, and there is no bank account on file we can `
        + `collect it from.</p>`
        + `<p>Connecting one under <strong>Banking</strong> in your portal settles it automatically — `
        + `we take it from the same account your rent already moves through, and you never have to `
        + `think about it again.</p>`
        + `<p>If we cannot collect, portal access is eventually suspended. Your tenants are not `
        + `affected either way — rent keeps being collected as normal.</p>`,
    }).catch(() => {})
    await query(
      `UPDATE landlords SET uncollectable_notice_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [c.landlordId])
    notified++
  }
  if (notified) logger.warn({ notified }, '[gam-collections] told landlords we cannot collect')
  return { notified }
}

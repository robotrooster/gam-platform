/**
 * Customer Web Push (service-business, S510).
 *
 * Free browser push (no SMS/email) so a business's customer is alerted
 * "you're next" / "completed" / "couldn't service you" even when the
 * portal tab is closed. The customer opts in from the portal; we store
 * one subscription per device and fan out on stop events.
 *
 * VAPID keys come from env in production (VAPID_PUBLIC_KEY /
 * VAPID_PRIVATE_KEY); a dev fallback pair keeps local working without
 * touching .env. Expired subscriptions (404/410) are pruned on send.
 */

import webpush from 'web-push'
import { query, queryOne } from '../db'
import { logger } from '../lib/logger'

// Dev fallback VAPID pair (local only). Production overrides via env.
const DEV_VAPID_PUBLIC = 'BIGN9lFsLk8j2VnH_wl1Ch9Z10a_CHrJLIbdzsr2h0GMD3VDOTvFOXjldoELSUF4pBFAH_SfA1a3wQZq3A16nbk'
const DEV_VAPID_PRIVATE = 'a0gWf1Y8TgoolNCERVRc4uvjp2-vJqVHsVeu7y6XziY'

export const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || DEV_VAPID_PUBLIC
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || DEV_VAPID_PRIVATE
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:ops@goldassetmanagement.com'

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY)

export interface PushSubscriptionInput {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

/** Upsert a device subscription for a customer (idempotent on endpoint). */
export async function saveSubscription(args: {
  businessId: string; customerId: string; subscription: PushSubscriptionInput
}): Promise<void> {
  const { endpoint, keys } = args.subscription
  if (!endpoint || !keys?.p256dh || !keys?.auth) return
  await query(
    `INSERT INTO customer_push_subscriptions (business_id, customer_id, endpoint, p256dh, auth)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (endpoint) DO UPDATE
       SET customer_id = EXCLUDED.customer_id, p256dh = EXCLUDED.p256dh,
           auth = EXCLUDED.auth, last_used_at = now()`,
    [args.businessId, args.customerId, endpoint, keys.p256dh, keys.auth])
}

export type StopEvent = 'next' | 'completed' | 'skipped'

function messageFor(event: StopEvent, businessName: string, reason: string | null): { title: string; body: string } {
  switch (event) {
    case 'next':      return { title: `${businessName} is on the way`, body: `You're the next stop.` }
    case 'completed': return { title: `${businessName} — service complete`, body: `Your stop was just completed.` }
    case 'skipped':   return { title: `${businessName} — couldn't service today`, body: reason || `We weren't able to complete your stop today.` }
  }
}

/**
 * Push a stop event to the stop's customer (no-op for dump/depot stops,
 * or a customer with no subscriptions). Fire-and-forget; never throws.
 */
export async function notifyStopCustomer(stopId: string, event: StopEvent): Promise<void> {
  try {
    const row = await queryOne<{ customer_id: string | null; business_name: string; driver_notes: string | null }>(
      `SELECT a.customer_id, b.name AS business_name, rs.driver_notes
         FROM route_stops rs
         JOIN generated_routes r ON r.id = rs.route_id
         JOIN businesses b       ON b.id = r.business_id
         LEFT JOIN appointments a ON a.id = rs.appointment_id
        WHERE rs.id = $1`, [stopId])
    if (!row?.customer_id) return

    const subs = await query<{ id: string; endpoint: string; p256dh: string; auth: string }>(
      `SELECT id, endpoint, p256dh, auth FROM customer_push_subscriptions WHERE customer_id = $1`,
      [row.customer_id])
    if (subs.length === 0) return

    const msg = messageFor(event, row.business_name, event === 'skipped' ? row.driver_notes : null)
    const payload = JSON.stringify({ title: msg.title, body: msg.body, tag: `stop-${stopId}` })

    await Promise.all(subs.map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload)
      } catch (e: any) {
        const code = e?.statusCode
        if (code === 404 || code === 410) {
          await query(`DELETE FROM customer_push_subscriptions WHERE id = $1`, [s.id]).catch(() => {})
        } else {
          logger.warn({ err: e, code }, '[customer-push] send failed')
        }
      }
    }))
  } catch (e) {
    logger.warn({ err: e }, '[customer-push] notify failed')
  }
}

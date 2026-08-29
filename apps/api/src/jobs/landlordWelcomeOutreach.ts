/**
 * S605 (Nic): automated onboarding-call outreach for SELF-SIGNED-UP landlords.
 *
 * Our first organic signup created an account, landed on the onboarding wizard,
 * and left 16 seconds later. Nothing ever reached out — the only thing the
 * signup produced was an internal admin alert nobody was watching at 5:46am.
 *
 * This job closes that. Every landlord who signs up on their own gets a short,
 * personal-feeling note offering an onboarding call, addressed by the first name
 * they typed at registration.
 *
 * ── Why it's delayed, not fired at signup ────────────────────────────────
 * An email that lands the instant you hit "create account" is transparently
 * automated, and it competes with the 2FA code the account is waiting on. A
 * note that shows up ~90 minutes later reads like a person noticed. That delay
 * IS the feature — do not "optimise" it into the signup handler.
 *
 * ── Who gets it ─────────────────────────────────────────────────────────
 *   • ORGANIC only — no closer (portfolio_manager_id) and no referring landlord
 *     (referred_by_user_id). A rep-closed signup already has a human on it; a
 *     second "hi, I'm Nic" would step on that rep's relationship.
 *   • Email-verified only. An unverified address is often a typo, and bouncing
 *     first-contact mail damages the sending domain's reputation.
 *   • Not demo / not system landlords.
 *   • Never twice — landlords.welcome_outreach_sent_at is the durable guard
 *     (see the migration header for why not email_send_log).
 *
 * ── Send window ─────────────────────────────────────────────────────────
 * A "real person" does not email you at 3:40am. SEND_WINDOW_START_HOUR ..
 * SEND_WINDOW_END_HOUR (Phoenix) is when sending IS allowed — 8am–7pm by
 * default. Outside it the work is HELD, not skipped, so a 2am signup gets its
 * note at 8am rather than never. MAX_AGE_HOURS then stops the job from one day
 * waking up and mailing a stale backlog after an outage — anything older than
 * that window is marked sent-without-sending and left alone.
 */
import { query } from '../db'
import { logger } from '../lib/logger'
import { emailLandlordWelcomeOutreach } from '../services/email'

/** Minutes after signup before the note goes out. */
export const OUTREACH_DELAY_MINUTES = Number(process.env.LANDLORD_OUTREACH_DELAY_MINUTES || 90)
/**
 * The window during which sending is ALLOWED — Phoenix, inclusive start /
 * exclusive end. Defaults to 8am–7pm. (Named for what it permits, not what it
 * blocks: "quiet hours" would be the inverse 13 hours and reads backwards.)
 */
export const SEND_WINDOW_START_HOUR = Number(process.env.LANDLORD_OUTREACH_HOUR_START || 8)
export const SEND_WINDOW_END_HOUR = Number(process.env.LANDLORD_OUTREACH_HOUR_END || 19)
/** Past this age we stop trying and just mark the row, so an outage can't cause a stale blast. */
export const MAX_AGE_HOURS = Number(process.env.LANDLORD_OUTREACH_MAX_AGE_HOURS || 72)
/** How long the booking link in the email stays live. */
export const BOOKING_TOKEN_TTL_DAYS = Number(process.env.LANDLORD_OUTREACH_TOKEN_TTL_DAYS || 30)

const MARKETING_URL = () => (process.env.MARKETING_URL || 'http://localhost:3004').replace(/\/$/, '')

/**
 * Mint the prefill token for this landlord's booking link.
 *
 * The token rides in the URL FRAGMENT (#onboarding/<token>), not a query
 * string: fragments are never sent to any server, so the credential stays out
 * of access logs and Referer headers even as the link is forwarded around.
 *
 * Returns null on failure — the email then falls back to reply-to-schedule copy
 * rather than not going out at all.
 */
async function mintBookingUrl(userId: string, landlordId: string): Promise<string | null> {
  try {
    const rows = await query<{ token: string }>(
      `INSERT INTO landlord_onboarding_booking_tokens (user_id, landlord_id, expires_at)
       VALUES ($1, $2, now() + ($3 || ' days')::interval)
       RETURNING token`,
      [userId, landlordId, String(BOOKING_TOKEN_TTL_DAYS)])
    if (!rows[0]) return null
    return `${MARKETING_URL()}/#onboarding/${rows[0].token}`
  } catch (e) {
    logger.error({ err: e, landlordId }, '[landlord-outreach] booking token mint failed')
    return null
  }
}

export interface WelcomeOutreachResult {
  sent: number
  /** Outside the send window — held for the next in-window run, not dropped. */
  heldOutsideSendWindow: number
  expired: number
  errors: number
}

interface Row {
  landlord_id: string
  user_id: string
  email: string
  first_name: string
  property_count: string
  created_at: Date
}

/** Phoenix has no DST, but read the hour via the zone rather than assuming UTC-7. */
function phoenixHour(now: Date): number {
  return Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Phoenix', hour: 'numeric', hour12: false,
    }).format(now)
  )
}

export function withinSendWindow(now: Date): boolean {
  const h = phoenixHour(now)
  return h >= SEND_WINDOW_START_HOUR && h < SEND_WINDOW_END_HOUR
}

export async function sendLandlordWelcomeOutreach(now: Date = new Date()): Promise<WelcomeOutreachResult> {
  const result: WelcomeOutreachResult = { sent: 0, heldOutsideSendWindow: 0, expired: 0, errors: 0 }

  const rows = await query<Row>(
    `SELECT l.id  AS landlord_id,
            u.id  AS user_id,
            u.email,
            u.first_name,
            l.created_at,
            (SELECT COUNT(*) FROM properties p WHERE p.landlord_id = l.id) AS property_count
       FROM landlords l
       JOIN users u ON u.id = l.user_id
      WHERE l.welcome_outreach_sent_at IS NULL
        AND l.is_demo   = FALSE
        AND l.is_system = FALSE
        AND l.portfolio_manager_id IS NULL      -- no closing rep
        AND l.referred_by_user_id  IS NULL      -- no referring landlord
        AND u.email_verified = TRUE
        AND u.role = 'landlord'
        AND l.created_at <= $1::timestamptz - ($2 || ' minutes')::interval
        -- S629 (Nic): "I got an onboarding email from GAM support to my email."
        --
        -- This selected ENTITIES, and every criterion above is true of a brand
        -- new LLC created by a landlord who has been running for weeks. So
        -- adding a second entity sent that landlord "Getting you set up on
        -- GAM" — a first-contact onboarding-call note — as though they had
        -- just discovered the product. It happened twice in one evening: a
        -- landlord who signed up on the 24th got one for his second LLC, and
        -- Nic got one for an entity created for him on the 28th.
        --
        -- The outreach is addressed to a PERSON, not to a company, so the
        -- question is whether this human is new — not whether this row is.
        -- Anyone with an older entity, or who has already been written to on
        -- any of their entities, is not.
        AND NOT EXISTS (
          SELECT 1 FROM landlords prior
           WHERE prior.user_id = u.id
             AND prior.id <> l.id
             AND (prior.created_at < l.created_at
                  OR prior.welcome_outreach_sent_at IS NOT NULL)
        )
      ORDER BY l.created_at`,
    [now.toISOString(), String(OUTREACH_DELAY_MINUTES)]
  )

  if (rows.length === 0) return result

  // Age out anything the delay window has long passed (outage backlog) BEFORE
  // the send-window gate, so stale rows never sit in the queue forever.
  const cutoff = new Date(now.getTime() - MAX_AGE_HOURS * 3600_000)
  const stale = rows.filter((r) => new Date(r.created_at) < cutoff)
  const fresh = rows.filter((r) => new Date(r.created_at) >= cutoff)
  if (stale.length > 0) {
    await query(
      `UPDATE landlords SET welcome_outreach_sent_at = now(), updated_at = now()
        WHERE id = ANY($1::uuid[])`,
      [stale.map((r) => r.landlord_id)])
    result.expired = stale.length
    logger.info({ expired: stale.length },
      '[landlord-outreach] past max age — marked without sending')
  }

  if (fresh.length === 0) return result

  // Hold (don't drop) work that lands outside the send window — the next
  // in-window run picks it up, so a 2am signup goes out at 8am.
  if (!withinSendWindow(now)) {
    result.heldOutsideSendWindow = fresh.length
    logger.info({ holding: fresh.length, phoenixHour: phoenixHour(now) },
      '[landlord-outreach] outside the send window — holding until it reopens')
    return result
  }

  for (const r of fresh) {
    try {
      const bookingUrl = await mintBookingUrl(r.user_id, r.landlord_id)
      await emailLandlordWelcomeOutreach({
        to: r.email,
        firstName: r.first_name,
        stalledInSetup: Number(r.property_count) === 0,
        bookingUrl,
        ctx: { landlordId: r.landlord_id, userId: r.user_id },
      })
      // Stamp only after a successful send, so a transient email failure retries
      // on the next run instead of silently losing the outreach.
      await query(
        `UPDATE landlords SET welcome_outreach_sent_at = now(), updated_at = now() WHERE id = $1`,
        [r.landlord_id])
      result.sent++
    } catch (e) {
      result.errors++
      logger.error({ err: e, landlordId: r.landlord_id }, '[landlord-outreach] send failed')
    }
  }

  if (result.sent > 0 || result.errors > 0) {
    logger.info(result, '[landlord-outreach] run complete')
  }
  return result
}

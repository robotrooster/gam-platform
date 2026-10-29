/**
 * 10/13 (Nic): "emailing tenants on their birthday and saying, Hey, happy
 * birthday from GAM ... just like a happy birthday message. Thank you for
 * using GAM, that sort of thing." He chose TENANTS + LANDLORDS.
 *
 * ── Who gets it ──────────────────────────────────────────────────────────
 *   • Every CURRENT tenant — on an active lease (a seat that is 'active', or
 *     'pending_remove': a roommate whose removal is still waiting on
 *     signatures still lives there — the same "current" every other GAM
 *     count uses). Their birthday is tenants.date_of_birth, the date copied
 *     off their signed lease.
 *   • Every LANDLORD — an account that owns a company (its founding owner or a
 *     co-owner). Their birthday is users.date_of_birth, typed on their own
 *     Settings → Account card.
 *   Demo and system companies are left out. No birthday on file, no email —
 *   ever.
 *   10/14 (Nic): "people under 18 cant be on a lease legally right? 18 and
 *   up" — nobody under 18 is emailed: a birthday that makes the person
 *   younger than 18 today is skipped (that also catches a lease's signing
 *   date typed into the birthdate box). They turn 18 on the birthday itself,
 *   so an 18th birthday is greeted.
 *   10/14 (Nic): only VERIFIED email addresses (users.email_verified) — an
 *   address nobody has proven is never written to.
 *   10/14 (Nic): only CURRENT tenants, never past ones (above); a landlord
 *   who typed their own birthday keeps getting theirs.
 *
 * ── When ─────────────────────────────────────────────────────────────────
 * Once a day, a Phoenix morning (scheduler.ts). "Today" is Phoenix's calendar
 * date — at that hour it is the same date everywhere in the US. A Feb 29
 * birthday is greeted on Feb 28 in a year with no Feb 29.
 *
 * ── Once per person per year ─────────────────────────────────────────────
 * birthday_greetings (user_id, greeting_year) is unique. A row is CLAIMED
 * before the send, so two runs the same morning can never both send.
 *
 * Only a machine that actually sends mail runs this at all
 * (mailLeavesThisMachine). A dev API shares the production database; if it
 * took part, it could win the claim at 9:15, send nothing, and leave
 * production to find the row and skip the person — and with one run a day,
 * that person's greeting would be gone for the year. A machine that sends
 * nothing now counts the birthdays and stops, touching no row.
 *
 * A send that still does not go out (no provider message id: an address the
 * mail service refuses) gives the claim back, so a re-run can greet them once
 * the address is fixed.
 *
 * ── Turning it off ───────────────────────────────────────────────────────
 * The per-type email switch every GAM email uses: notification_preferences
 * type 'birthday', email off (Settings → Notification Preferences for a
 * landlord, Profile → Notifications for a tenant). Default is on.
 */
import { query } from '../db'
import { logger } from '../lib/logger'
import { dateIn } from '../lib/timezone'
import { emailBirthdayGreeting, mailLeavesThisMachine } from '../services/email'

/** The notification_preferences type that switches the birthday email off. */
export const BIRTHDAY_NOTIFICATION_TYPE = 'birthday'

const ZONE = 'America/Phoenix'

const isLeapYear = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0

/**
 * Which birthdays are greeted on `ymd` (YYYY-MM-DD): that month and day — and
 * on Feb 28 of a year with no Feb 29, the Feb 29 birthdays too.
 */
export function birthdaysOn(ymd: string): { year: number; month: number; days: number[] } {
  const [year, month, day] = ymd.split('-').map(Number)
  const days = month === 2 && day === 28 && !isLeapYear(year) ? [28, 29] : [day]
  return { year, month, days }
}

export interface BirthdayEmailResult {
  /** Phoenix date the run greeted. */
  date: string
  /** People whose birthday is today. */
  birthdays: number
  sent: number
  /** Turned the birthday email off. */
  optedOut: number
  /** Already greeted this year. */
  alreadyGreeted: number
  /** The send did not go out — the claim was given back. */
  notSent: number
  errors: number
  /** This machine sends no mail: birthdays counted, nobody claimed or emailed. */
  mailOff: boolean
}

interface Row {
  user_id: string
  email: string
  first_name: string | null
  audience: 'tenant' | 'landlord'
  opted_out: boolean
  already_greeted: boolean
}

export async function runBirthdayEmails(now: Date = new Date()): Promise<BirthdayEmailResult> {
  const today = dateIn(ZONE, now)
  const { year, month, days } = birthdaysOn(today)
  const result: BirthdayEmailResult = {
    date: today, birthdays: 0, sent: 0, optedOut: 0, alreadyGreeted: 0, notSent: 0, errors: 0,
    mailOff: false,
  }

  // One row per person. Someone found on both lists (a tenant row on a
  // landlord's own account) is still one person and gets one email.
  const rows = await query<Row>(`
    WITH people AS (
      SELECT u.id AS user_id, u.email, u.first_name, 'tenant'::text AS audience,
             t.date_of_birth AS dob
        FROM tenants t
        JOIN users u ON u.id = t.user_id
       WHERE t.date_of_birth IS NOT NULL
         AND u.email_verified = TRUE
         AND EXISTS (
           SELECT 1
             FROM lease_tenants lt
             JOIN leases l     ON l.id  = lt.lease_id
             JOIN landlords la ON la.id = l.landlord_id
            WHERE lt.tenant_id = t.id
              AND lt.status IN ('active', 'pending_remove')
              AND l.status  = 'active'
              AND la.is_demo   = FALSE
              AND la.is_system = FALSE)
      UNION ALL
      SELECT u.id, u.email, u.first_name, 'landlord'::text, u.date_of_birth
        FROM users u
       WHERE u.role = 'landlord'
         AND u.date_of_birth IS NOT NULL
         AND u.email_verified = TRUE
         AND EXISTS (
           SELECT 1 FROM landlords la
            WHERE la.is_demo   = FALSE
              AND la.is_system = FALSE
              AND (la.user_id = u.id
                   OR EXISTS (SELECT 1 FROM landlord_members m
                               WHERE m.landlord_id = la.id AND m.user_id = u.id)))
    )
    SELECT DISTINCT ON (p.user_id)
           p.user_id, p.email, p.first_name, p.audience,
           EXISTS (SELECT 1 FROM notification_preferences np
                    WHERE np.user_id = p.user_id AND np.type = $4
                      AND np.email_enabled = FALSE)                       AS opted_out,
           EXISTS (SELECT 1 FROM birthday_greetings g
                    WHERE g.user_id = p.user_id AND g.greeting_year = $5) AS already_greeted
      FROM people p
     WHERE EXTRACT(MONTH FROM p.dob)::int = $1
       AND EXTRACT(DAY   FROM p.dob)::int = ANY($2::int[])
       -- 10/14 (Nic): 18 and up (18 on the birthday itself; a Feb 29
       -- birthday's 18th falls on Feb 28 in a year without one).
       AND (p.dob + interval '18 years')::date <= $3::date
     ORDER BY p.user_id, (p.audience = 'landlord') DESC`,
    [month, days, today, BIRTHDAY_NOTIFICATION_TYPE, year])

  result.birthdays = rows.length

  // No mail leaves this machine: never claim (see the header).
  if (!mailLeavesThisMachine()) {
    result.mailOff = true
    return result
  }

  for (const r of rows) {
    if (r.opted_out) { result.optedOut++; continue }
    if (r.already_greeted) { result.alreadyGreeted++; continue }

    // Claim first: a second run racing this one finds the row and stops.
    const claim = await query<{ id: string }>(
      `INSERT INTO birthday_greetings (user_id, greeting_year) VALUES ($1, $2)
       ON CONFLICT (user_id, greeting_year) DO NOTHING
       RETURNING id`, [r.user_id, year])
    if (!claim[0]) { result.alreadyGreeted++; continue }
    const claimId = claim[0].id

    try {
      const messageId = await emailBirthdayGreeting({
        to: r.email,
        firstName: r.first_name,
        ctx: { userId: r.user_id, audience: r.audience },
      })
      if (messageId) {
        result.sent++
      } else {
        // Nothing left the building — give the year's greeting back.
        await query(`DELETE FROM birthday_greetings WHERE id = $1`, [claimId])
        result.notSent++
      }
    } catch (e) {
      result.errors++
      logger.error({ err: e, userId: r.user_id }, '[birthday-emails] send failed')
      await query(`DELETE FROM birthday_greetings WHERE id = $1`, [claimId]).catch((err) =>
        logger.error({ err, userId: r.user_id }, '[birthday-emails] could not give the claim back'))
    }
  }

  return result
}

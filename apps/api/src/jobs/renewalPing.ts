/**
 * S628 (Nic) — the 60-day renewal question, asked of the TENANT first.
 *
 * S562 built renewal landlord-first: the tenant saw nothing until the landlord
 * set landlord_renewal_offered_at. Nic described it the other way round — "ping
 * the tenant at 60 days, the landlord hears at 32" — and confirmed tenant-first
 * when asked this session. Nothing anywhere sent that 60-day ping; the question
 * simply waited for a landlord who had no prompt to ask it.
 *
 * Why it matters more than a nicety: notice periods run 30 or 60 days depending
 * on the state, auto-renew is retired platform-wide (S562), and the person who
 * knows first whether they are staying is the one living there. A tenant who has
 * decided to leave and is never asked says nothing until the month it is too
 * late to re-let — and the landlord loses a month they would not have lost.
 *
 * TWO BEATS, one job, run daily:
 *
 *   60 days out — ask the tenant. Once per lease (tenant_renewal_pinged_at).
 *   32 days out — tell the landlord where it stands, WHATEVER the tenant said.
 *                 "Nothing yet" is the most important of the four answers: it
 *                 is the one that means the landlord has to go and ask.
 *
 * The 32-day alert is deliberately not conditional on an answer. An alert that
 * only fires when the tenant replied would be silent in exactly the case that
 * needs a human.
 *
 * A lease whose tenant has ALREADY given their answer is not pinged — the
 * question has been answered and asking again is noise. A lease the landlord
 * has already made an offer on is still pinged: an offer is the landlord's
 * position, not the tenant's answer.
 */
import { query } from '../db'
import { logger } from '../lib/logger'
import { createNotification } from '../services/notifications'

/** Ask the tenant this far out. */
const TENANT_PING_DAYS = 60
/** Tell the landlord this far out. */
const LANDLORD_ALERT_DAYS = 32

export interface RenewalPingResult {
  pinged: number
  alerted: number
  errors: number
}

const INTENT_WORDS: Record<string, string> = {
  yes:    'told you they want to stay',
  no:     'given notice that they are leaving',
  unsure: 'said they have not decided yet',
}

export async function runRenewalPings(): Promise<RenewalPingResult> {
  let pinged = 0, alerted = 0, errors = 0

  // ── 60 days out: ask the tenant ──────────────────────────────────────
  //
  // A window rather than an exact day: a job that only matches end_date - 60
  // exactly skips every lease on a day the job did not run, and skips it
  // silently and forever. The pinged_at guard is what keeps it to once.
  const toPing = await query<any>(`
    SELECT l.id AS lease_id, l.landlord_id,
           (l.end_date - CURRENT_DATE)::int AS days_left,
           to_char(l.end_date, 'FMMonth FMDD, YYYY') AS end_date_label,
           un.unit_number, p.name AS property_name,
           tu.id AS user_id, tu.email, tu.first_name
      FROM leases l
      JOIN units un ON un.id = l.unit_id
      JOIN properties p ON p.id = un.property_id
      JOIN lease_tenants lt ON lt.lease_id = l.id AND lt.status = 'active'
      JOIN tenants t ON t.id = lt.tenant_id
      JOIN users tu ON tu.id = t.user_id
     WHERE l.status = 'active'
       AND l.end_date IS NOT NULL
       AND l.tenant_renewal_pinged_at IS NULL
       AND l.tenant_renewal_intent IS NULL
       AND l.end_date > CURRENT_DATE
       AND l.end_date <= CURRENT_DATE + $1::int
  `, [TENANT_PING_DAYS])

  const pingedLeases = new Set<string>()
  for (const r of toPing) {
    try {
      // Every active tenant on the lease is asked — a household where only the
      // primary is asked answers for people who were never consulted.
      await createNotification({
        userId: r.user_id,
        landlordId: r.landlord_id,
        type: 'lease_renewal_question',
        title: `Are you staying? — ${r.property_name} Unit ${r.unit_number}`,
        body:
          `Your lease ends on ${r.end_date_label}, about ${r.days_left} days from now. ` +
          `Let your landlord know whether you plan to stay on, so they can get the paperwork ` +
          `started — or, if you are moving out, so everyone has notice in good time. ` +
          `You can say yes, no, or that you have not decided.`,
        data: { leaseId: r.lease_id, daysLeft: r.days_left },
        actionUrl: '/lease',
        sendEmail: true,
        emailTo: r.email,
        emailSubject: `Your lease ends ${r.end_date_label} — are you staying?`,
      })
      pingedLeases.add(r.lease_id)
    } catch (e) {
      errors++
      logger.error({ err: e, leaseId: r.lease_id }, '[renewal-ping] tenant ping failed')
    }
  }
  if (pingedLeases.size) {
    await query(
      `UPDATE leases SET tenant_renewal_pinged_at = NOW(), updated_at = NOW()
        WHERE id = ANY($1::uuid[])`, [[...pingedLeases]])
    pinged = pingedLeases.size
  }

  // ── 32 days out: tell the landlord where it stands ───────────────────
  const toAlert = await query<any>(`
    SELECT l.id AS lease_id, l.landlord_id, l.tenant_renewal_intent,
           l.landlord_renewal_offered_at,
           (l.end_date - CURRENT_DATE)::int AS days_left,
           to_char(l.end_date, 'FMMonth FMDD, YYYY') AS end_date_label,
           un.unit_number, p.name AS property_name,
           lu.id AS landlord_user_id, lu.email AS landlord_email,
           COALESCE(NULLIF(TRIM(tu.first_name || ' ' || tu.last_name), ''), tu.email) AS tenant_name
      FROM leases l
      JOIN units un ON un.id = l.unit_id
      JOIN properties p ON p.id = un.property_id
      JOIN landlords la ON la.id = l.landlord_id
      JOIN users lu ON lu.id = la.user_id
      JOIN lease_tenants lt ON lt.lease_id = l.id AND lt.status = 'active'
                           AND lt.role = 'primary'
      JOIN tenants t ON t.id = lt.tenant_id
      JOIN users tu ON tu.id = t.user_id
     WHERE l.status = 'active'
       AND l.end_date IS NOT NULL
       AND l.landlord_renewal_alerted_at IS NULL
       AND l.end_date > CURRENT_DATE
       AND l.end_date <= CURRENT_DATE + $1::int
  `, [LANDLORD_ALERT_DAYS])

  const alertedLeases = new Set<string>()
  for (const r of toAlert) {
    try {
      const said = r.tenant_renewal_intent
        ? `${r.tenant_name} has ${INTENT_WORDS[r.tenant_renewal_intent] ?? 'answered'}.`
        : `${r.tenant_name} has not answered yet — worth asking them directly.`
      const next = r.tenant_renewal_intent === 'no'
        ? 'Nothing renews automatically, so the lease ends on that date. Time to list the unit.'
        : r.landlord_renewal_offered_at
          ? 'You have already offered renewal on this one.'
          : 'If you want to keep them, offer renewal so the new lease can be drawn in time.'
      await createNotification({
        userId: r.landlord_user_id,
        landlordId: r.landlord_id,
        type: 'lease_renewal_status',
        title: `${r.days_left} days left — ${r.property_name} Unit ${r.unit_number}`,
        body: `This lease ends on ${r.end_date_label}. ${said} ${next}`,
        data: {
          leaseId: r.lease_id,
          daysLeft: r.days_left,
          tenantIntent: r.tenant_renewal_intent ?? null,
        },
        actionUrl: `/leases?open=${r.lease_id}`,
        sendEmail: true,
        emailTo: r.landlord_email,
        emailSubject: `Lease ending ${r.end_date_label} — Unit ${r.unit_number}`,
      })
      alertedLeases.add(r.lease_id)
    } catch (e) {
      errors++
      logger.error({ err: e, leaseId: r.lease_id }, '[renewal-ping] landlord alert failed')
    }
  }
  if (alertedLeases.size) {
    await query(
      `UPDATE leases SET landlord_renewal_alerted_at = NOW(), updated_at = NOW()
        WHERE id = ANY($1::uuid[])`, [[...alertedLeases]])
    alerted = alertedLeases.size
  }

  if (pinged || alerted || errors) logger.info({ pinged, alerted, errors }, '[renewal-ping] daily run complete')
  return { pinged, alerted, errors }
}

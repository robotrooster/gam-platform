/**
 * PM readiness 4 — WHO AN OWNER STATEMENT GOES TO, AND WHETHER IT WENT.
 *
 * Two jobs, both about delivery and neither about money:
 *
 *   1. the statements that are DUE for a month — one per owner entity per
 *      manager, which is exactly what the owner portal shows (an owner with
 *      parks under two managers gets two statements: two sets of fees, two
 *      people to ring about them);
 *   2. the record that one went out, which jobs/ownerStatementEmail claims
 *      before it sends (so a re-run cannot double-send) and the owner-facing
 *      endpoints read to say "sent on X".
 *
 * WHO THE RECIPIENT IS. The owner entity's own account holder — landlords.user_id
 * → users.email. Deliberately NOT the monthly property report's recipient list
 * (monthly_report_recipients): that list is a LANDLORD's choice about their own
 * company's report, and an owner statement is a different document with a
 * different audience. One address per statement until an owner asks for more;
 * adding a list is a new mechanism and would be Nic's call.
 *
 * WHY THE SCOPE IS pm_owner_relationships AND NOT every landlord. A
 * self-managed owner is the landlord of their own park and already receives
 * the monthly property report on the 2nd (jobs/monthlyPropertyReportEmail).
 * This document is what a MANAGER owes an owner. Gated on the relationship
 * being active, and NOT on portal_access — S645: access is not a manager's to
 * grant for an owner's own money, and a statement is the most literal case of
 * that.
 */
import { query } from '../db'

/** One statement that is due for a month: an owner entity, a manager, an address. */
export interface OwnerStatementDue {
  landlordId: string
  pmCompanyId: string
  pmCompanyName: string
  /** The owner entity as the owner knows it: their company name, else their own name. */
  entityName: string
  /** The person who owns the entity. */
  ownerName: string | null
  ownerUserId: string
  email: string
  /**
   * Where a reply lands: the manager's owner-role staff member, so an owner
   * who answers the statement reaches the person who runs their park and not
   * GAM support (services/replyRouting). Null when the company has no active
   * owner-role staff, which falls back to GAM support.
   */
  replyToUserId: string | null
  /** The company's own clock, for deciding what is due: the zone most of its properties keep. */
  timezone: string | null
}

/**
 * Every statement due to be sent, one row per owner entity and manager.
 *
 * Demo accounts and GAM's own system companies are excluded for the reason
 * jobs/monthlyPropertyReportEmail and jobs/platformFeeAccrual exclude them:
 * their owner addresses are internal or seeded, every send bounces, and
 * bounces cost the real sending domain its reputation.
 *
 * `only` narrows to named owner entities, for tests and a re-run by hand.
 */
export async function ownerStatementsDue(only: readonly string[] | null = null): Promise<OwnerStatementDue[]> {
  return query<OwnerStatementDue>(`
    SELECT r.landlord_id                                   AS "landlordId",
           r.pm_company_id                                 AS "pmCompanyId",
           c.name                                          AS "pmCompanyName",
           COALESCE(NULLIF(btrim(l.business_name), ''),
                    NULLIF(btrim(concat_ws(' ', u.first_name, u.last_name)), ''),
                    'Your properties')                     AS "entityName",
           NULLIF(btrim(concat_ws(' ', u.first_name, u.last_name)), '') AS "ownerName",
           u.id                                            AS "ownerUserId",
           u.email                                         AS "email",
           (SELECT s.user_id FROM pm_staff s
             WHERE s.pm_company_id = c.id AND s.role = 'owner' AND s.status = 'active'
             ORDER BY s.created_at, s.user_id LIMIT 1)      AS "replyToUserId",
           (SELECT p.timezone FROM properties p
             WHERE p.landlord_id = l.id AND p.pm_company_id = c.id AND p.timezone IS NOT NULL
             GROUP BY p.timezone ORDER BY COUNT(*) DESC, p.timezone LIMIT 1) AS "timezone"
      FROM pm_owner_relationships r
      JOIN pm_companies c ON c.id = r.pm_company_id
      JOIN landlords l    ON l.id = r.landlord_id
      JOIN users u        ON u.id = l.user_id
     WHERE r.status = 'active'
       AND c.status <> 'suspended'
       AND l.is_demo = FALSE
       AND l.is_system = FALSE
       AND ($1::uuid[] IS NULL OR r.landlord_id = ANY($1::uuid[]))
     ORDER BY r.landlord_id, c.name, r.pm_company_id`,
    [only ? [...only] : null])
}

/** What the owner-facing endpoints print beside a statement. */
export interface OwnerStatementDelivery {
  status: 'sending' | 'sent' | 'not_sent'
  /** ISO instant the mail service accepted it, or null. */
  sentAt: string | null
  /** The address it went to — the owner's own, so it is theirs to see. */
  email: string
  attempts: number
  /** Why it has not gone, in the words the job recorded. Null once sent. */
  lastError: string | null
}

/**
 * The latest send of one owner's statement for one month and manager, or null
 * when none has been attempted. Keyed exactly as the send is claimed, so
 * "sent on X" can never show another manager's statement.
 */
export async function ownerStatementDelivery(opts: {
  landlordId: string
  pmCompanyId: string
  periodMonth: string
}): Promise<OwnerStatementDelivery | null> {
  const rows = await query<OwnerStatementDelivery>(`
    SELECT status, sent_at AS "sentAt", email, attempts, last_error AS "lastError"
      FROM owner_statement_sends
     WHERE landlord_id = $1 AND pm_company_id = $2 AND period_month = $3::date
     ORDER BY updated_at DESC, created_at DESC
     LIMIT 1`,
    [opts.landlordId, opts.pmCompanyId, opts.periodMonth.slice(0, 7) + '-01'])
  const r = rows[0]
  if (!r) return null
  return { ...r, sentAt: r.sentAt ? new Date(r.sentAt).toISOString() : null }
}

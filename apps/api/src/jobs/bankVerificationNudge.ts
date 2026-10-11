/**
 * S641 — chase an unfinished bank setup.
 *
 * Found while running down a Stripe error in the log. Two residents had entered
 * bank details and were parked in Stripe's `requires_action`: the two small
 * deposits had been sent and neither had come back to confirm the amounts. One
 * had been stalled for nine days. The other had tried twice, failed once, and
 * was being mailed "Late payment alert — Day 10" on the same morning he tried
 * again.
 *
 * Nothing chased either of them. The portal showed a bank on file, the late-fee
 * engine saw somebody not paying, and the single step between the two was one
 * nobody was reminded to take. These are people actively trying to pay.
 *
 * Cadence learned the hard way this session: a reminder without a ceiling is not
 * a reminder. Signing reminders once ran every two hours forever and sent 74
 * emails to one person in eight days. Every three days, four times, then stop —
 * after that it is a phone call, not an email.
 *
 * S655 (item L, keep the old bank): adding a bank no longer turns ach_verified
 * off, so "no verified bank" stopped being the only sign of a setup in
 * progress. A tenant with a verified bank who adds a new one is waiting just
 * the same, and is chased the same. The shortlist is therefore
 * tenants.bank_pending_since (set at confirm-setup, and by the P5 backfill)
 * PLUS anybody with no verified bank yet — the original net, kept because a
 * browser that never reached confirm-setup leaves no flag behind. Stripe then
 * decides: a bank still waiting sets the flag if it was missing; nothing
 * waiting clears it. The email names the bank that is waiting (read off its
 * SetupIntent), not the verified one on file.
 *
 * Which banks are waiting is the portal's own list
 * (services/tenantBankMethods.listWaitingBankSetups: up to 20 setups, so a
 * waiting bank behind newer card setups or retries is still found), and the
 * flag is read and written under the tenant's bank lock
 * (refreshBankPendingFlag), so a confirm-setup landing while the job runs
 * keeps its flag. A bank whose deposits Stripe is checking (processing) is
 * still waiting — the flag stays — but there is nothing to ask the tenant, so
 * no email goes out for it.
 */
import { query } from '../db'
import { logger } from '../lib/logger'
import { emailVerifyBankReminder } from '../services/email'
import { portalLink } from '../lib/portalUrls'
import { refreshBankPendingFlag } from '../services/tenantBankMethods'
import { payableRowSql } from '../services/moneyPredicates'

const NUDGE_EVERY_HOURS = 72
const MAX_NUDGES = 4

/**
 * Grace after the deposit ACTUALLY LANDS, not after the setup started.
 *
 * Nic: "whatever the longest time the deposits would realistically take to
 * finish is, have it remind them." We do not have to estimate that — Stripe
 * reports an `arrival_date` on the SetupIntent, so the reminder is timed off
 * the real event. A day after it lands is the earliest the message can be true
 * and useful; before that we would be telling somebody to look for something
 * their bank has not posted yet.
 */
const GRACE_AFTER_ARRIVAL_HOURS = 24

export interface BankNudgeResult {
  considered: number
  sent: number
  skippedNotStalled: number
  failed: number
}

export async function sendBankVerificationNudges(
  opts: { now?: Date } = {},
): Promise<BankNudgeResult> {
  const result: BankNudgeResult = { considered: 0, sent: 0, skippedNotStalled: 0, failed: 0 }

  // The DB knows who STARTED a setup. Only Stripe knows whether it is still
  // waiting — so the shortlist is cheap here and confirmed there, rather than
  // mailing anyone on our own stale copy of the truth.
  const candidates = await query<any>(`
    SELECT t.id, t.bank_last4, t.stripe_customer_id, t.bank_verify_nudge_count,
           t.bank_pending_since,
           u.email, u.first_name,
           (SELECT ll.id FROM leases l
              JOIN units un ON un.id = l.unit_id
              JOIN landlords ll ON ll.id = un.landlord_id
             WHERE l.id = (SELECT lease_id FROM lease_tenants lt
                            WHERE lt.tenant_id = t.id AND lt.removed_at IS NULL
                            ORDER BY lt.created_at DESC LIMIT 1)) AS landlord_id,
           -- "Still owed" in the email: the shared payable rule, so a payment
           -- already on its way is not called owed.
           EXISTS (SELECT 1 FROM payments p
                    JOIN lease_tenants lt2 ON lt2.lease_id = p.lease_id AND lt2.tenant_id = t.id
                                         AND lt2.removed_at IS NULL
                   WHERE ${payableRowSql('p')}) AS has_balance_due
      FROM tenants t
      JOIN users u ON u.id = t.user_id
     WHERE (t.bank_pending_since IS NOT NULL OR t.ach_verified = FALSE)
       AND t.stripe_customer_id IS NOT NULL
       AND u.email IS NOT NULL
       AND t.bank_verify_nudge_count < $1
       AND (t.bank_verify_nudge_at IS NULL
            OR t.bank_verify_nudge_at < NOW() - ($2::int || ' hours')::interval)
  `, [MAX_NUDGES, NUDGE_EVERY_HOURS])

  if (!candidates.length) return result

  for (const t of candidates) {
    try {
      // Stripe's answer and the flag, under the tenant's bank lock.
      const waiting = await refreshBankPendingFlag(t.id)
      // Stalled means: Stripe is waiting on THEM, specifically for the deposit
      // amounts or code. A setup that merely failed is a different
      // conversation, and one Stripe is checking needs nothing from them.
      const target = waiting.find((w) => w.awaitingTenant)
      if (!target) {
        result.skippedNotStalled++
        continue
      }
      // The bank that is waiting — which, now that the old bank is kept, is not
      // necessarily the one on file.
      const waitingLast4: string | null = target.last4 ?? t.bank_last4

      const detail = target.microdeposits
      // Stripe reports when the deposit reaches the bank. Fall back to the
      // setup's creation only if it is somehow absent.
      const arrivalMs = detail?.arrivalDate != null
        ? detail.arrivalDate * 1000
        : target.createdAt?.getTime() ?? Date.now()
      const now = (opts.now ?? new Date()).getTime()
      if (now - arrivalMs < GRACE_AFTER_ARRIVAL_HOURS * 3600 * 1000) {
        result.skippedNotStalled++
        continue
      }

      result.considered++
      await emailVerifyBankReminder(t.email, {
        tenantName: t.first_name || 'there',
        bankLast4: waitingLast4,
        arrivedOn: new Date(arrivalMs).toLocaleDateString('en-US',
          { month: 'long', day: 'numeric', timeZone: 'America/Phoenix' }),
        // Driven by what Stripe reports, never assumed: sending somebody
        // hunting for two amounts when their statement carries a code is worse
        // than writing nothing.
        verificationKind: detail?.type === 'amounts' ? 'amounts' : 'descriptor_code',
        verifyUrl: detail?.verifyUrl || portalLink('tenant', 'payments'),
        // The chase, not the announcement — that one already went out at setup.
        kind: 'reminder',
        hasBalanceDue: t.has_balance_due === true,
      }, { landlordId: t.landlord_id ?? undefined, tenantId: t.id })

      // Counted only while the count is the one this run read: a confirm-setup
      // that started a new bank meanwhile reset it, and that new bank's chase
      // starts from zero.
      await query(
        `UPDATE tenants SET bank_verify_nudge_at = NOW(),
                bank_verify_nudge_count = bank_verify_nudge_count + 1
          WHERE id = $1 AND bank_verify_nudge_count = $2`, [t.id, t.bank_verify_nudge_count])
      result.sent++
    } catch (e) {
      // One unreachable customer must not stop the rest, and an unstamped row
      // is simply tried again on the next pass.
      result.failed++
      logger.error({ err: e, tenantId: t.id }, '[bank-verify-nudge] failed for tenant')
    }
  }

  return result
}

import cron from 'node-cron'
import { DateTime } from 'luxon'
import { notifyLeaseExpiring, notifyLowStock } from '../services/notifications'
import {
  emailSigningReminder, emailDocumentAutoVoided, emailSigningRequest,
  emailNewLeaseDraftLapsed, emailNewLeaseSigningReminder, emailNewLeasesAwaitingLandlord,
  type NewLeaseDigestItem,
} from '../services/email'
import { documentDateToIso, NEW_LEASE_TENANT_REMINDER_DAYS } from '@gam/shared'
import { runLateBalanceDigest } from './lateBalanceDigest'
import { tenantLeaseLink } from '../services/tenantLeaseLink'
import { replyToProperty } from '../services/replyRouting'
import { portalLink } from '../lib/portalUrls'
import { query, queryOne, getClient } from '../db'
import { cascadeLeaseTenantsOnVoid } from '../lib/leaseDocCascade'
import { generateInvoices, registerInvoiceEngine, unbilledDueDates, CATCHUP_DAYS } from './invoiceGeneration'
import { registerLateFeeEngine } from './lateFees'
import { registerServiceAgreementInvoiceEngine } from './serviceAgreementInvoices'
import { registerAutopayEngine } from './autopayRunner'
import { registerRefreshCron, refreshTimezoneCrons, summary as tzCronSummary } from './timezoneCronManager'
import { expireStaleInvitations as expireStalePmPropertyInvitations } from '../services/pm'
import { getPropertyResponsibleParty } from '../services/responsibleParty'
import { logger } from '../lib/logger'
import { reconcileStuckPayments, releaseUnconfirmedCardCharges } from './paymentReconcile'
import { getStripe } from '../lib/stripe'
import { todayIn, addDaysTo, monthStartOf } from '../lib/timezone'

// ============================================================
// GAM PAYMENT SCHEDULER
// All cron jobs that power payment processing + reminders.
// ============================================================

// ── LEASE EXPIRATION NOTICES ────────────────────────────────
// Fires once per lease when (end_date - expiration_notice_days) is today or past
// Landlord-configurable. No state-specific legal logic.
export async function checkLeaseExpiryNotices() {
  try {
    // S183: route to per-property responsible party (PM company staff
    // fan-out, individually-delegated user, or owner if self-managed).
    // Pre-S183 this notified the landlord owner regardless of delegation.
    const expiring = await query<any>(`
      SELECT l.id, l.end_date, l.landlord_id, l.expiration_notice_days,
        l.auto_renew, l.auto_renew_mode,
        p.id as property_id, p.name as property_name,
        un.unit_number,
        vuo.primary_first_name as tenant_first, vuo.primary_last_name as tenant_last,
        EXTRACT(DAY FROM l.end_date::timestamp - NOW())::int as days_remaining
      FROM leases l
      JOIN units un ON un.id = l.unit_id
      JOIN properties p ON p.id = un.property_id
      LEFT JOIN v_unit_occupancy vuo ON vuo.unit_id = un.id
      WHERE l.status = 'active'
        AND l.end_date IS NOT NULL
        AND l.expiration_notice_sent_at IS NULL
        AND l.end_date <= CURRENT_DATE + (l.expiration_notice_days || ' days')::interval
        AND l.end_date >= CURRENT_DATE
        -- S655: a lease with a new lease signed by the landlord to follow it is
        -- not "expiring" — the household is staying on the new one.
        AND NOT EXISTS (
          SELECT 1 FROM leases s
           WHERE s.supersedes_lease_id = l.id AND s.status IN ('pending', 'active')
             AND s.signed_by_landlord = TRUE)
    `)
    for (const lease of expiring) {
      const tName = ((lease.tenant_first || '') + ' ' + (lease.tenant_last || '')).trim() || 'Tenant'
      const targets = await getPropertyResponsibleParty(lease.property_id)
      const recipients = targets?.primaries ?? []
      for (const recipient of recipients) {
        await notifyLeaseExpiring({
          landlordUserId: recipient.user_id,
          landlordId: lease.landlord_id,
          landlordEmail: recipient.email,
          landlordPhone: recipient.phone ?? undefined,
          tenantName: tName,
          unitNumber: lease.unit_number,
          propertyName: lease.property_name,
          endDate: lease.end_date,
          daysRemaining: lease.days_remaining,
          leaseId: lease.id
        })
      }
      await query('UPDATE leases SET expiration_notice_sent_at=NOW() WHERE id=$1', [lease.id])
      logger.info(`[LeaseExpiry] Notice sent for lease ${lease.id} (unit ${lease.unit_number}, ${lease.days_remaining}d remaining, auto_renew=${lease.auto_renew}, recipients=${recipients.length}, kind=${targets?.kind ?? 'unresolved'})`)
    }
    if (expiring.length > 0) {
      logger.info(`[LeaseExpiry] ${expiring.length} expiration notice(s) sent`)
    }
  } catch(e) { logger.error({ err: e }, '[SCHEDULER] lease expiry notice') }
}

// ── LEASE END PROCESSOR ─────────────────────────────────────
// When end_date hits: auto-renew per landlord config, or expire + vacate
// W-7 (S531): flip fully-signed pending leases (typically renewals drafted
// via the renewal-decision flow, future-dated at creation) to active when
// their start date arrives, and mark the unit occupied. Runs in the 2am
// cron BEFORE processLeaseEnds so a renewal starting the day after the old
// lease ends activates before/despite the old lease's expiry handling — except
// a renewal whose old lease is past its end and still in force: that one comes
// into force at the hand-off (processLeaseEnds), never alongside it.
//
// S655 (Nic, 10/2): a NEW LEASE for a household already living there — a
// month-to-month included — ends the lease it follows the day before it starts,
// whether or not the tenant has signed it. That end date is written here, on the
// start date, so the wait below holds the new lease and processLeaseEnds hands
// the household over the same night (services/renewalSuccessor).
//
// Decisions 10/2 #7: never a stretch with no lease. A signed fixed term that
// runs out before its new lease starts HOLDS OVER — at the old rent — until the
// day before; that is written here too, before processLeaseEnds can read the
// passed end date as a move-out.
export async function activatePendingLeases() {
  try {
    try {
      const { holdOverUntilNewLeaseStarts } = await import('../services/renewalSuccessor')
      const held = await holdOverUntilNewLeaseStarts(
        async (sql, params) => ({ rows: await query<any>(sql, params) }))
      for (const h of held) {
        logger.info(`[LeaseActivate] lease ${h.leaseId}: term ended ${h.termEnded}; holds over at the old rent to ${h.holdsOverTo} — its new lease ${h.renewalId} starts the day after`)
      }
    } catch (e) {
      // processLeaseEnds never hands over to a new lease that has not started,
      // and the bill run bills a held-over lease to the day before its new lease
      // either way — so a missed night loses nothing.
      logger.error({ err: e }, '[LeaseActivate] could not write the holdover end dates — retried tomorrow')
    }
    try {
      const { closePredecessorOfStartedRenewals } = await import('../services/renewalSuccessor')
      const closed = await closePredecessorOfStartedRenewals(
        async (sql, params) => ({ rows: await query<any>(sql, params) }))
      for (const c of closed) {
        logger.info(`[LeaseActivate] lease ${c.predecessorId} ends ${c.endDate} — its new lease ${c.renewalId} starts the day after`)
      }
    } catch (e) {
      // The new lease stays pending another night; the old one keeps billing
      // up to the day before it (the bill run's own clamp), so nothing doubles.
      logger.error({ err: e }, '[LeaseActivate] could not end the leases that new leases follow — retried tomorrow')
    }
    const { followsLeaseEndedEarlyUnsigned } = await import('../services/renewalSuccessor')
    const due = await query<any>(`
      SELECT id, unit_id FROM leases
      WHERE status='pending'
        -- S647: the LANDLORD's signature is what makes a tenancy real and
        -- billable now (Nic: "bill it out to everybody upon my signature").
        -- Requiring the tenant's too would strand a future-dated lease in
        -- 'pending' forever if they never got around to signing — never
        -- activating, and therefore never billing, which is the exact failure
        -- issuance exists to end.
        AND signed_by_landlord=TRUE
        AND start_date <= CURRENT_DATE
        -- RENEWAL HAND-OFF: a renewal waits while the lease it renews is past
        -- its end but still has a bill to make (processLeaseEnds holds the
        -- hand-off for it, and activates the renewal when it hands off). So a
        -- household never has two leases in force on the unit — two would
        -- count its people twice in a split by headcount. Bounded by the bill
        -- run's catch-up window, so a stuck hand-off cannot hold it forever.
        -- S655: nor while the lease it follows is still open (a month-to-month
        -- the step above could not end tonight) — a new lease never comes into
        -- force beside the old one; the hand-off brings it in.
        AND NOT EXISTS (
          SELECT 1 FROM leases pl
           WHERE pl.status = 'active' AND pl.unit_id = leases.unit_id
             AND ((pl.end_date < CURRENT_DATE AND pl.end_date >= CURRENT_DATE - $1::int)
                  OR pl.end_date IS NULL OR pl.end_date >= leases.start_date)
             AND (pl.id = leases.supersedes_lease_id
                  OR EXISTS (SELECT 1 FROM lease_documents d
                              WHERE d.lease_id = leases.id AND d.renews_lease_id = pl.id)))
        -- S655: and never a new lease whose household ENDED the lease it follows
        -- early, with nobody having signed the new one: nobody is staying on to
        -- take it up. Brought into force it occupied the emptied space again and
        -- billed the new rent to a household that had gone. It is canceled
        -- (processNewLeaseSignings); until then it simply never starts.
        AND NOT ${followsLeaseEndedEarlyUnsigned('leases')}`, [CATCHUP_DAYS])
    for (const l of due) {
      await query(`UPDATE leases SET status='active', updated_at=NOW() WHERE id=$1`, [l.id])
      await query(`UPDATE units SET status='active', updated_at=NOW() WHERE id=$1`, [l.unit_id])
      logger.info(`[LeaseActivate] pending lease ${l.id} reached start date — now active (unit ${l.unit_id})`)
    }

    // S618: the same sweep for a lease that was created ALREADY ACTIVE but
    // future-dated. The trigger added in 20260823120000 occupies the unit when
    // such a lease is written, but a lease starting next month is correctly
    // skipped then — and nothing rewrites that row on the day it starts, so no
    // trigger ever fires again. This is what closes that day.
    //
    // It doubles as the drift reconcile: any started, active lease whose unit
    // still reads empty gets corrected here, whatever wrote it. Only ever
    // promotes vacant/available — 'delinquent' and 'suspended' are already
    // occupied and must keep their meaning.
    const occupied = await query<any>(`
      UPDATE units u
         SET status='active', updated_at=NOW()
       WHERE u.status IN ('vacant','available')
         AND u.retired_at IS NULL
         AND EXISTS (
           SELECT 1 FROM leases l
            WHERE l.unit_id = u.id AND l.status='active'
              AND l.start_date IS NOT NULL AND l.start_date <= CURRENT_DATE)
      RETURNING u.id`)
    if (occupied.length) {
      logger.info(`[LeaseActivate] occupied ${occupied.length} unit(s) holding a started active lease but still marked empty`)
    }
  } catch(e) { logger.error({ err: e }, '[SCHEDULER] activate pending leases') }
}

/**
 * RENEWAL HAND-OFF: money still open on the old lease goes with the tenancy.
 *
 * Utility bills, one-off charges, propane installments, landlord credits and
 * paid-ahead money are kept on the lease, and the new lease's bills only look
 * at their own lease. Left behind, December's read entered on the 31st was
 * never invoiced, and a standing $10 credit stopped reducing anything. Only
 * OPEN rows move — what is settled stays on the old lease as its history —
 * and they move, never get recreated, so a paid-ahead row keeps whose money
 * it is (S654: GAM-held vs landlord-recorded). One transaction: all or none.
 *
 * S655: under the household lock (every writer of the household's money takes
 * it), and a credit moves when anything of it is still the household's to
 * use: money left on it, OR money a payment still in flight has set aside. A
 * credit fully held by a bank payment that is clearing reads $0 left, so it
 * used to stay behind; when that payment then failed, the credit came back on
 * the expired lease, where no bill would ever reach it. A withdrawn paid-ahead
 * credit stays where it is (it can never be used).
 */
export async function handOffOpenItemsToRenewal(
  oldLeaseId: string, newLeaseId: string,
): Promise<Record<string, number>> {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    const { billHouseholdTenant } = await import('../services/creditUse')
    const { lockHousehold } = await import('../services/moneyPredicates')
    const hh = await billHouseholdTenant(client, oldLeaseId)
    if (hh) await lockHousehold(client, hh.tenantId, hh.landlordId)
    const moved = async (sql: string) =>
      (await client.query(sql, [oldLeaseId, newLeaseId])).rowCount ?? 0
    const counts = {
      utilityBills: await moved(
        `UPDATE utility_bills SET lease_id = $2, updated_at = NOW()
          WHERE lease_id = $1 AND payment_id IS NULL AND status IN ('unbilled', 'billed')`),
      oneOffCharges: await moved(
        `UPDATE tenant_one_off_charges SET lease_id = $2, updated_at = NOW()
          WHERE lease_id = $1 AND status = 'pending'`),
      propaneFills: await moved(
        `UPDATE propane_fills f SET lease_id = $2
          WHERE f.lease_id = $1
            AND EXISTS (SELECT 1 FROM propane_fill_installments i
                         WHERE i.fill_id = f.id AND i.payment_id IS NULL)`),
      credits: await moved(
        `UPDATE tenant_credits tc SET lease_id = $2, updated_at = NOW()
          WHERE tc.lease_id = $1 AND tc.status = 'active'
            AND (tc.amount_remaining > 0
                 OR EXISTS (SELECT 1 FROM credit_uses u
                             WHERE u.tenant_credit_id = tc.id AND u.status = 'held'))`),
      paidAhead: await moved(
        `UPDATE lease_prepaid_credits c SET lease_id = $2, updated_at = NOW()
          WHERE c.lease_id = $1 AND c.voided_at IS NULL
            AND (c.amount_remaining > 0
                 OR EXISTS (SELECT 1 FROM credit_uses u
                             WHERE u.prepaid_credit_id = c.id AND u.status = 'held'))`),
      // Autopay is one row per lease, and the runner only pulls for a lease in
      // force. Left on the old lease it never ran again — every renewal bill
      // un-pulled, each one turning into a late fee. It goes with the household
      // as it is (pull day, payment method, and the month it last ran, so that
      // month is never pulled twice), for someone who is on the renewal, unless
      // the renewal already has its own.
      autopay: await moved(
        `UPDATE tenant_autopay a SET lease_id = $2, updated_at = NOW()
          WHERE a.lease_id = $1
            AND NOT EXISTS (SELECT 1 FROM tenant_autopay x WHERE x.lease_id = $2)
            AND EXISTS (SELECT 1 FROM lease_tenants lt
                         WHERE lt.lease_id = $2 AND lt.tenant_id = a.tenant_id
                           AND lt.status IN ('active', 'pending_add'))`),
    }
    await client.query('COMMIT')
    return counts
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

export async function processLeaseEnds() {
  try {
    const ended = await query<any>(`
      SELECT l.*, un.id as unit_id_ref, un.unit_number,
             (l.end_date < CURRENT_DATE) AS past_end
      FROM leases l
      JOIN units un ON un.id = l.unit_id
      WHERE l.status = 'active'
        AND l.end_date IS NOT NULL
        AND l.end_date <= CURRENT_DATE
    `)
    for (const lease of ended) {
      {
        // Auto-renew RETIRED (Nic, S562): a lease NEVER auto-extends or reverts to
        // month-to-month. Every lease expires at its end_date unless a signed
        // successor renewal was explicitly drafted — renewal is always a conscious
        // decision by both parties, so no tenant is "trapped" by forgetting a lease
        // end. (The old extend_same_term / convert_to_month_to_month modes are dead.)
        // Expire the lease, cascade to lease_tenants, vacate the unit.
        // W-7 (S531): unless a signed successor lease is queued on this unit
        // (a renewal drafted via the renewal-decision flow) — then this is a
        // HANDOFF, not a move-out: the unit stays occupied and no
        // deposit-return draft is created (the deposit carried forward onto
        // the successor at renewal completion).
        const successor = await queryOne<any>(`
          SELECT s.id,
                 -- This lease's own renewal: linked by the signing that built
                 -- it (a renewal drafted before the link existed is found by
                 -- its document).
                 (s.supersedes_lease_id = $2
                   OR EXISTS (SELECT 1 FROM lease_documents d
                               WHERE d.lease_id = s.id AND d.renews_lease_id = $2)) AS renews,
                 -- Somebody on this lease is on the next one too.
                 EXISTS (SELECT 1 FROM lease_tenants nt
                           JOIN lease_tenants ot ON ot.tenant_id = nt.tenant_id
                          WHERE nt.lease_id = s.id AND nt.status IN ('active','pending_add')
                            AND ot.lease_id = $2 AND ot.status IN ('active','pending_add','pending_remove')) AS same_household,
                 -- Decisions 10/2 #7: it has not started yet.
                 (s.start_date > CURRENT_DATE) AS not_started
          FROM leases s
          WHERE s.unit_id=$1 AND s.status IN ('pending','active') AND s.id != $2
            AND s.start_date > $3
            -- S647: landlord signature only, for the same reason as
            -- activatePendingLeases. A renewal is issued the moment the
            -- landlord signs it, so requiring the tenant's signature here would
            -- treat a renewal they simply had not opened yet as a MOVE-OUT:
            -- unit vacated, tenants removed, deposit-return draft created, on a
            -- resident who is not leaving. Reading it as a handoff is the
            -- recoverable direction — if they really do go, terminating the
            -- successor produces the deposit return then.
            AND s.signed_by_landlord=TRUE
          ORDER BY (s.supersedes_lease_id = $2) DESC NULLS LAST, s.start_date ASC LIMIT 1`,
          [lease.unit_id, lease.id, lease.start_date])

        // RENEWAL (Nic: "people get billed on their due date according to how
        // the landlord sets the property"): the old lease is in force through
        // its last day, and that day can be a due date. Expiring it at 2am ON
        // its end date, before the 7am bill run, lost that bill — a renewal
        // ending 10/1 never billed October. With a renewal following, the
        // hand-off happens the morning AFTER the last day. A plain move-out
        // keeps today's timing (the move-out notice reads the end date as the
        // day they leave).
        if (successor?.renews && !lease.past_end) continue

        // HOLDOVER (decisions 10/2 #7: "there is never a stretch with no
        // lease"). The household's own new lease has not started: handing over
        // now would leave them on a lease not in force — no rent billed for the
        // gap, autopay moved to it, and no lease to write a leaving date on. The
        // old lease carries on at the old rent until the day before (its end date
        // is normally already moved there — renewalSuccessor.holdOverUntilNewLeaseStarts).
        if (successor?.renews && successor.not_started) continue

        // ...and until the old lease's last bill is made. A bill still held (an
        // unread meter, a reading run the landlord has not approved yet) or
        // missed on its last due date was lost at the hand-off: once expired the
        // bill run never looks at the lease again, and the renewal's schedule
        // counts that month as the old lease's. A renewal ending 10/1 whose
        // October bill waited on approval never billed October. The renewal
        // waits pending meanwhile (activatePendingLeases). The wait ends when the
        // run itself would give up on the date (its catch-up window).
        if (successor?.renews) {
          let owed: string[]
          try {
            owed = await unbilledDueDates(lease.id)
          } catch (e) {
            logger.error({ err: e, leaseId: lease.id }, '[LeaseEnd] could not check the old lease for an unmade bill — the hand-off waits a night')
            continue
          }
          if (owed.length > 0) {
            logger.info({ leaseId: lease.id, successorId: successor.id, owed },
              '[LeaseEnd] renewal hand-off waits — the old lease still has a bill to make')
            continue
          }
        }

        // A signed lease for somebody ELSE on this unit is the next tenancy,
        // not a renewal: this household is moving out. Only the unit stays
        // occupied. (It used to read as a hand-off: no deposit return for the
        // people leaving, a "renewed" credit event, work trade left running.)
        const handOff = !!successor && (successor.renews || successor.same_household)

        // The renewal's open money follows it, before the old lease closes. If
        // the move fails the old lease stays active another night and this is
        // retried — its bills cannot overlap the renewal's (the bill run stops
        // a lease the day before a fully signed renewal starts).
        if (successor?.renews) {
          try {
            const moved = await handOffOpenItemsToRenewal(lease.id, successor.id)
            logger.info({ leaseId: lease.id, successorId: successor.id, ...moved },
              '[LeaseEnd] renewal hand-off: open items moved to the new lease')
          } catch (e) {
            logger.error({ err: e, leaseId: lease.id, successorId: successor.id },
              '[LeaseEnd] renewal hand-off could not move the open items — the old lease stays active and retries tomorrow')
            continue
          }
        }

        await query(`UPDATE leases SET status='expired', terminated_at=NOW() WHERE id=$1`, [lease.id])
        // Final sweep (10/3): an add-a-roommate spot nobody signed ('pending_add')
        // never joined this lease, so it did not END with it: it is void, the
        // way voiding its addendum leaves it (lib/leaseDocCascade.ts). Only the
        // people who were on the lease are 'removed' / lease_ended.
        await query(
          `UPDATE lease_tenants SET status='void', updated_at=NOW() WHERE lease_id=$1 AND status='pending_add'`,
          [lease.id])
        await query(`
          UPDATE lease_tenants
          SET status='removed', removed_at=NOW(), removed_reason='lease_ended', updated_at=NOW()
          WHERE lease_id=$1 AND status IN ('active','pending_remove')
        `, [lease.id])
        if (handOff) {
          logger.info(`[LeaseEnd] Expired lease ${lease.id}; unit ${lease.unit_id} hands off to successor lease ${successor.id} — no vacate, no deposit-return draft`)
          // The renewal comes into force now, not before (see the wait above).
          if (successor.renews) {
            await query(
              `UPDATE leases SET status='active', updated_at=NOW()
                WHERE id=$1 AND status='pending' AND signed_by_landlord=TRUE AND start_date <= CURRENT_DATE`,
              [successor.id])
          }
          try {
            await emitLeaseLifecycleEvent('renewed', lease.id, lease.landlord_id)
          } catch (e) {
            logger.error({ err: e }, '[LeaseEnd][credit-emit] renewed (handoff)')
          }
          continue
        }
        if (successor) {
          logger.info(`[LeaseEnd] Expired lease ${lease.id}; the next tenancy (lease ${successor.id}) holds unit ${lease.unit_id} — this household is moving out`)
        } else {
          await query(`UPDATE units SET status='vacant', updated_at=NOW() WHERE id=$1`, [lease.unit_id])
          logger.info(`[LeaseEnd] Expired lease ${lease.id}, vacated unit ${lease.unit_id}`)
        }

        // Credit ledger: lease_terminated_natural for every active
        // tenant on the lease + a single landlord event.
        try {
          await emitLeaseLifecycleEvent('terminated_natural', lease.id, lease.landlord_id)
        } catch (e) {
          logger.error({ err: e }, '[LeaseEnd][credit-emit] terminated_natural')
        }

        // S113-PhaseB: auto-create the deposit-return draft when a lease
        // expires naturally. The draft picks up move_out + other lease_fees
        // automatically (via depositReturn.calculateDepositReturn). Landlord
        // adds any damage lines, then finalizes — finalize creates a refund
        // payment row OR a gap invoice (with auto-charge attempt) per
        // Nic's "deduct from deposit, invoice difference" spec.
        try {
          const { createOrFetchDraft } = await import('../services/depositReturn')
          const draft = await createOrFetchDraft(lease.id)
          const { createAdminNotification } = await import('../services/adminNotifications')
          await createAdminNotification({
            severity: 'info',
            category: 'deposit_return_draft_created',
            title:    `Deposit return draft awaiting review for lease ${lease.id}`,
            body:
              `Lease expired with ${Number(draft.cleaning_fee_amount) > 0
                ? `$${draft.cleaning_fee_amount} in lease_fees auto-deducted`
                : 'no lease_fees to auto-deduct'}. ` +
              `Total deposit: $${draft.total_deposit}. ` +
              `Add any damage lines and finalize to issue refund or gap invoice.`,
            context: {
              lease_id:           lease.id,
              deposit_return_id:  draft.id,
              total_deposit:      Number(draft.total_deposit),
              cleaning_fee_amount: Number(draft.cleaning_fee_amount),
            },
          })
        } catch (e) {
          logger.error({ err: e }, '[LeaseEnd][deposit-return-draft]')
        }

        // S576 (B-8): work trade is rent-for-labor — it can't outlive the
        // tenancy. This branch is a real move-out (no signed successor), so
        // pause any active work-trade agreement for this unit's departing
        // tenant(s). The landlord to-do (GET /me/todos) then surfaces it as
        // "renew the lease — even month-to-month — with a work-trade addendum
        // to resume." M2M leases never reach this processor (end_date IS NULL),
        // so an ongoing month-to-month work-trade is left untouched, and a
        // renewal HANDOFF above already `continue`d (work trade keeps running).
        try {
          const paused = await query<any>(
            `UPDATE work_trade_agreements
                SET status='paused', updated_at=NOW()
              WHERE unit_id=$1 AND status='active'
                AND tenant_id IN (SELECT tenant_id FROM lease_tenants WHERE lease_id=$2)
              RETURNING id`,
            [lease.unit_id, lease.id])
          if (paused.length > 0) {
            logger.info(`[LeaseEnd] Paused ${paused.length} work-trade agreement(s) on unit ${lease.unit_number ?? lease.unit_id} — lease ${lease.id} expired with no successor`)
          }
        } catch (e) {
          logger.error({ err: e }, '[LeaseEnd][work-trade-pause]')
        }
      }
    }
    if (ended.length > 0) {
      logger.info(`[LeaseEnd] ${ended.length} lease(s) processed at end_date`)
    }
  } catch(e) { logger.error({ err: e }, '[SCHEDULER] lease end processor') }
}

/**
 * Emit lease-lifecycle credit-ledger events post-update. Splits
 * tenants from landlords; lazy-imports the credit-ledger services so
 * scheduler.ts top-of-file imports stay tidy.
 */
async function emitLeaseLifecycleEvent(
  kind: 'renewed' | 'terminated_natural',
  leaseId: string,
  landlordId: string,
): Promise<void> {
  const tenants = await query<{ tenant_id: string }>(
    `SELECT lt.tenant_id
       FROM lease_tenants lt
      WHERE lt.lease_id = $1
        AND lt.status IN ('active', 'removed')`,
    [leaseId],
  )
  const tenantIds = Array.from(new Set(tenants.map((t) => t.tenant_id))).filter(Boolean)

  const { getClient } = await import('../db')
  const { emitLeaseRenewedEvents, emitLeaseTerminatedNaturalEvents } = await import(
    '../services/creditLedgerEmitters'
  )

  const client = await getClient()
  try {
    await client.query('BEGIN')
    if (kind === 'renewed') {
      await emitLeaseRenewedEvents(client, {
        leaseId,
        landlordId,
        tenantIds,
        renewedAt: new Date(),
      })
    } else {
      await emitLeaseTerminatedNaturalEvents(client, {
        leaseId,
        landlordId,
        tenantIds,
        terminatedAt: new Date(),
      })
    }
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

// ── INVITATION EXPIRY ───────────────────────────────────────
// Hourly — flips pending invitations past expires_at to 'expired'
// and writes an invitation.expired platform_events row with actor null
// (expiry is a system event, not a user action).
async function processInvitationExpiry() {
  try {
    const expired = await query<any>(`
      UPDATE invitations
      SET status = 'expired'
      WHERE status = 'pending' AND expires_at < NOW()
      RETURNING id
    `)
    for (const row of expired) {
      await query(`
        INSERT INTO platform_events
          (subject_type, subject_id, event_type, actor_user_id, payload)
        VALUES ('invitation', $1, 'invitation.expired', NULL, '{}'::jsonb)
      `, [row.id])
    }
    if (expired.length > 0) {
      logger.info(`[InvitationExpiry] ${expired.length} in-house invitation(s) expired`)
    }

    // S112: same sweep for pm_invitations. No platform_events row — that
    // table's subject_type CHECK only allows 'invitation' (in-house);
    // pm_invitations have their own status='expired' as the audit signal.
    const pmExpired = await query<any>(`
      UPDATE pm_invitations
      SET status = 'expired'
      WHERE status = 'pending' AND expires_at < NOW()
      RETURNING id
    `)
    if (pmExpired.length > 0) {
      logger.info(`[InvitationExpiry] ${pmExpired.length} PM invitation(s) expired`)
    }

    // S157: same sweep for pm_property_invitations (the bidirectional
    // property-link consent handshake table — distinct from pm_invitations
    // which is staff-onboarding). 72-hour TTL, no platform_events row.
    // S160: switched to the services/pm.ts helper so tests can exercise
    // the same code path the cron uses.
    const pmPropExpiredCount = await expireStalePmPropertyInvitations()
    if (pmPropExpiredCount > 0) {
      logger.info(`[InvitationExpiry] ${pmPropExpiredCount} PM property invitation(s) expired`)
    }
  } catch(e) { logger.error({ err: e }, '[SCHEDULER] invitation expiry') }
}

// ── ESIGN TIMEOUTS (S29 item 4) ─────────────────────────────
// Every 15 min. NON-renewal docs only. Renewals (renews_lease_id) get
// their own cadence at the bottom of this function (S536): deadline =
// 1 day before the predecessor lease ends, landlord reminded each
// morning, tenant reminded twice daily after the landlord signs.
//
// S636 (Nic) — TWO 48-HOUR WINDOWS, one per side:
//   "From the time I sign it to the time tenants sign it needs to only
//    be forty eight hours. They don't need seven fucking days. From the
//    time the tenant accepts the portal invite to the time the landlord
//    signs the lease needs to also be forty eight hours."
//
// Before S636 the two sides were wildly asymmetric and the tenant side
// had no clock at all: the auto-void only looked at status='sent', and
// the landlord's signature flips a doc to 'in_progress', so the moment
// the landlord signed the document left the expiry window FOREVER.
// Eleven Oak Park / Mountain View leases were sitting in exactly that
// state — signed by the landlord, waiting on a tenant, no deadline and
// (pass 1 being one-shot) no further reminders after the first nudge.
//
//   Window A — waiting on the LANDLORD: 48h from sent_at (the doc is
//     drafted and sent the moment the tenant accepts their portal
//     invite, so sent_at IS the accept moment).
//   Window B — waiting on a TENANT: 48h from the LANDLORD'S signature.
//     Anchored on the landlord, not per-signer, so a household of three
//     signers still shares ONE 48-hour deadline rather than resetting
//     the clock at each relay hop.
//
// Reminders: a signer waiting on the landlord still gets the one-shot
// 2h nudge. A tenant whose landlord has ALREADY signed is nudged every
// 2 hours until they sign or the window closes (Nic: "Send reminders
// every two fucking hours for the tenant that hasn't signed after the
// landlord has already signed"). Job cadence is 15 min, so the
// reminder_sent_at gap check is what paces it.
//
// Auto-void uses cascade-first ordering for idempotent re-runs:
// pending_add/pending_remove cleanup is a no-op once already updated,
// so a partial failure is safely re-tried on the next cycle.
// S636: the moment the two 48-hour windows started existing. Documents
// already in flight are floored at this instant so the new rule cannot
// retroactively void a lease that was live and legitimately waiting.
// Read at call time (not module load) and overridable, so the window
// tests can place the cutover in the past and exercise the real query.
const esign48hCutover = () => process.env.ESIGN_48H_CUTOVER || '2026-09-02T21:00:00Z'

// S652 (Nic, Blu): "he just wants one per packet." Blu's eight re-drafted
// packets produced fifty-four reminder emails in one tick — one for every
// document, each saying the same sentence. A packet is signed as one thing:
// one reminder per signer per packet, pointing at the first document that
// still needs them (the sign page walks them through the rest), and stamped
// on every document in it so the cadence and the cap count packets, not pages.
//
// Link: landlords sign in the landlord portal with their signer token (S629 —
// a document id is not recognized as a token URL and demanded a login);
// tenants get the one link that sets up their account and opens the lease
// (S647). Same helper the send path uses.
//
// S654: a signing token is a full stand-in for that signer, so it is mailed
// only to the address on the signer's own account (`send_to`, the same rule as
// signerDeliveryAddress in routes/esign.ts) — never the signer row's address,
// which can be stale. And one reminder per PERSON per packet: grouping by the
// row's address split one person in two when their rows disagreed (the email
// correction moved only the lease's row) and mailed the old mailbox a token
// whose signing page carries the rest of the packet. A landlord's rows keep
// their own address (the property's on-site signer), so it stays in their key.
async function remindByPacket(rows: any[], tag: string): Promise<number> {
  const groups = new Map<string, any[]>()
  for (const r of rows) {
    const who = r.role === 'landlord'
      ? `landlord|${r.user_id}|${String(r.send_to).toLowerCase()}`
      : `signer|${r.user_id}`
    const k = `${who}|${r.package_group_id ?? r.doc_id}`
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k)!.push(r)
  }
  let sent = 0
  for (const g of groups.values()) {
    g.sort((a, b) => Number(a.package_sort_order ?? 0) - Number(b.package_sort_order ?? 0))
    const r = g[0]
    try {
      const unitLabel = r.unit_number ? `Unit ${r.unit_number} — ${r.property_name}` : r.title
      // S654: portalLink, never a localhost fallback (S641).
      const { url, needsSetup } = r.role === 'landlord'
        ? { url: portalLink('landlord', `sign/${r.token || r.doc_id}`), needsSetup: false }
        : await tenantLeaseLink({ userId: r.user_id, documentId: r.doc_id, signerToken: r.token, sendTo: r.send_to })
      const title = g.length > 1 ? `your ${g.length} documents for ${unitLabel}` : r.title
      await emailSigningReminder(r.send_to, r.name, title, unitLabel, r.landlord_name, url,
        { landlordId: r.landlord_id, documentId: r.doc_id, needsSetup, documentCount: g.length,
          // 10/5: a resident's reply reaches the people who run this property
          // (services/replyRouting); the landlord's own reminder stays GAM's.
          replyTo: r.role === 'landlord' ? undefined : replyToProperty(r.property_id) })
      await query(
        `UPDATE lease_document_signers
            SET reminder_sent_at = NOW(), reminder_count = COALESCE(reminder_count, 0) + 1
          WHERE id = ANY($1::uuid[])`, [g.map((x: any) => x.id)])
      sent++
    } catch (e) {
      logger.error({ err: e, signer_id: r.id, documents: g.length }, `[ESIGN-TIMEOUTS] ${tag} failed`)
    }
  }
  return sent
}

export async function processEsignTimeouts() {
  try {
    // Pass 1: reminders.
    //
    // S636 (Nic): two cadences now. A signer the LANDLORD has not yet
    // cleared keeps the original one-shot nudge at +2h. A tenant whose
    // landlord HAS signed is nudged every 2 hours until they sign —
    // that is the case that used to go permanently silent after one
    // email. `landlordSigned` distinguishes them in a single query so
    // the relay ordering stays in one place.
    // S654: send_to — the address on the signer's own account; the landlord's
    // row keeps its own (see remindByPacket).
    const remind = await query<any>(`
      SELECT s.id, s.email, s.name, s.role, s.token, s.user_id,
             CASE WHEN s.role = 'landlord' THEN s.email ELSE COALESCE(su.email, s.email) END AS send_to,
             d.id as doc_id, d.title, d.landlord_id, d.package_group_id, d.package_sort_order,
             u.unit_number, u.property_id, p.name as property_name,
             lu.first_name || ' ' || lu.last_name as landlord_name
      FROM lease_document_signers s
      LEFT JOIN users su ON su.id = s.user_id
      JOIN lease_documents d ON d.id = s.document_id
      LEFT JOIN units u ON u.id = d.unit_id
      LEFT JOIN properties p ON p.id = u.property_id
      JOIN landlords la ON la.id = d.landlord_id
      JOIN users lu ON lu.id = la.user_id
      WHERE s.status IN ('sent','viewed')
        AND s.invite_sent_at IS NOT NULL
        AND s.invite_sent_at < NOW() - INTERVAL '2 hours'
        AND d.status NOT IN ('completed','voided','execution_failed')
        AND d.renews_lease_id IS NULL
        -- S638: never chase somebody whose turn has not come. A co-tenant that
        -- the old resend wrongly stamped would otherwise be reminded every two
        -- hours about a document they cannot submit.
        AND NOT EXISTS (
          SELECT 1 FROM lease_document_signers earlier
           WHERE earlier.document_id = d.id
             AND earlier.order_index < s.order_index
             AND earlier.status <> 'signed')
        AND (
          CASE WHEN s.role <> 'landlord' AND EXISTS (
                 SELECT 1 FROM lease_document_signers ls
                  WHERE ls.document_id = d.id
                    AND ls.role = 'landlord'
                    AND ls.status = 'signed')
                 AND NOT EXISTS (
                 SELECT 1 FROM lease_document_signers ls2
                  WHERE ls2.document_id = d.id
                    AND ls2.role = 'landlord'
                    AND ls2.status <> 'signed')
               -- S639: the landlord is done and we are waiting on this tenant.
               -- This used to read "nudge every 2 hours" with no ceiling, which
               -- on the live database meant 952 emails to 39 people over eight
               -- days — about eighty to one resident. A reminder that arrives
               -- every couple of hours forever is not a reminder, and it is the
               -- fastest route to our domain being treated as a spam sender,
               -- which would take the invites and receipts down with it.
               --
               -- Once a day, five times, then stop. Somebody who has ignored
               -- five daily reminders is not going to sign because of a sixth;
               -- they need a phone call, and the document auto-voids anyway.
               THEN (s.reminder_sent_at IS NULL
                     OR s.reminder_sent_at < NOW() - INTERVAL '24 hours')
                AND COALESCE(s.reminder_count, 0) < 5
               -- still waiting on the landlord: one nudge, as before
               ELSE s.reminder_sent_at IS NULL
          END)
    `)
    const remindersSent = await remindByPacket(remind as any[], 'reminder')
    if (remindersSent > 0) {
      logger.info(`[ESIGN-TIMEOUTS] sent ${remindersSent} reminder(s) for ${(remind as any[]).length} document(s)`)
    }

    // Pass 2: auto-void — BOTH 48-hour windows (S636).
    //
    //   status='sent'        → nobody has signed; waiting on the
    //                          landlord. 48h from sent_at, which is the
    //                          moment the tenant accepted their portal
    //                          invite (the draft is created and sent in
    //                          that same request).
    //   status='in_progress' → the landlord signed and a tenant has
    //                          not. 48h from the LANDLORD'S signature,
    //                          shared by every remaining signer, so a
    //                          three-signer household does not reset
    //                          the clock at each relay hop.
    //
    // GRANDFATHER: eleven leases were already parked in 'in_progress'
    // with no deadline when this shipped — some for days. Measuring
    // their window from a signature in the past would void live,
    // in-flight leases the instant this deployed, including ones Nic
    // was actively chasing. GREATEST() floors every anchor at the
    // cutover, so pre-existing documents get a full fresh 48 hours from
    // the moment the rule started existing. Harmless once past.
    const expired = await query<any>(`
      SELECT d.id, d.title, d.document_type, d.landlord_id,
             u.unit_number, u.property_id, p.name as property_name
      FROM lease_documents d
      LEFT JOIN units u ON u.id = d.unit_id
      LEFT JOIN properties p ON p.id = u.property_id
      WHERE d.renews_lease_id IS NULL
        AND (
          -- Window A — waiting on the LANDLORD. S647: only while a TENANT is
          -- actually waiting. Nic's S636 rule is "from the time the tenant
          -- accepts the portal invite to the time the landlord signs", and it
          -- was anchored on sent_at only because a draft used to be sent the
          -- instant a tenant accepted. Since S647 drafts are made and sent at
          -- ONBOARDING, before any tenant has been told anything, and they wait
          -- in the landlord's queue at the landlord's pace. Voiding those after
          -- 48 hours would wipe a whole onboarding batch the landlord had not
          -- reached yet, and strand each household behind a voided draft.
          (d.status='sent'
             AND d.sent_at IS NOT NULL
             AND EXISTS (
               SELECT 1 FROM pending_tenant_intents pa
                WHERE pa.draft_document_id = d.id AND pa.accepted_at IS NOT NULL
                  AND GREATEST(d.sent_at, pa.accepted_at, $1::timestamptz)
                        < NOW() - INTERVAL '48 hours'))
          OR
          (d.status='in_progress'
             AND EXISTS (
               SELECT 1 FROM lease_document_signers ls
                WHERE ls.document_id = d.id
                  AND ls.role = 'landlord'
                  AND ls.status = 'signed'
                  AND GREATEST(ls.signed_at, d.signing_window_restarted_at, $1::timestamptz)
                        < NOW() - INTERVAL '48 hours')
             AND EXISTS (
               SELECT 1 FROM lease_document_signers ps
                WHERE ps.document_id = d.id
                  AND ps.status IN ('pending','sent','viewed')))
        )
    `, [esign48hCutover()])
    for (const d of expired as any[]) {
      try {
        // ── S637 (Nic, DIRECTIVE): RESEND, DON'T VOID, WHEN HE HAS SIGNED ──
        //
        //   "I'm not gonna fucking sign it every time somebody fails to do
        //    their part on time. It needs to be resent to them for signature."
        //
        // Voiding here destroyed the landlord's completed signature because a
        // tenant was slow — and on MH 25 it destroyed a co-tenant's too, where
        // two of three had signed. The people who did their part paid for the
        // one who didn't.
        //
        // So: if the landlord has signed and everyone outstanding is a TENANT,
        // nudge exactly those people again and restart the window. The document
        // survives with every signature on it. It repeats every 48 hours until
        // it is signed or the landlord voids it by hand.
        // ── S638 (Nic, DIRECTIVE): RESEND TO ONE PERSON, NOT THE HOUSEHOLD ────
        //
        //   "I don't want it to send to them at all out of order because I have
        //    several people that think they already did it when they actually
        //    haven't."
        //
        // This used to take EVERY outstanding signer and email them all in one
        // pass, stamping invite_sent_at on each. So a co-tenant two places down
        // the order got a "please sign" for a document that was not yet theirs:
        // Brandon Valdez and Yesenia Sanchez were both mailed at 15:15:02 on the
        // 7th, Ruben Chavarin and Obed Parra both at 13:45:02 on the 8th. They
        // opened it, filled it in, could not submit, and told Nic they had
        // signed.
        //
        // Only the person whose turn it actually is — lowest order_index still
        // unsigned. The same rule the submit gate and the signing view use.
        // S654: send_to — the address on the signer's own account, never the
        // signer row's (only tenants reach the resend below; see remindByPacket).
        const outstanding = await query<any>(`
          SELECT s.id, s.name, s.email, s.role, s.token, s.user_id,
                 CASE WHEN s.role = 'landlord' THEN s.email ELSE COALESCE(su.email, s.email) END AS send_to
            FROM lease_document_signers s
            LEFT JOIN users su ON su.id = s.user_id
           WHERE s.document_id = $1 AND s.status <> 'signed'
           ORDER BY s.order_index
           LIMIT 1`, [d.id])
        const landlordSigned = await query<any>(`
          SELECT 1 FROM lease_document_signers
           WHERE document_id = $1 AND role = 'landlord' AND status = 'signed'`, [d.id])
        const onlyTenantsLeft = (outstanding as any[]).length > 0
          && (outstanding as any[]).every(s => s.role !== 'landlord')

        if (landlordSigned.length > 0 && onlyTenantsLeft) {
          const unitLabel = d.unit_number ? `Unit ${d.unit_number} — ${d.property_name}` : d.title
          const ll = await queryOne<any>(`
            SELECT (lu.first_name || ' ' || lu.last_name) AS name
              FROM landlords la JOIN users lu ON lu.id = la.user_id WHERE la.id = $1`,
            [d.landlord_id])
          for (const s of outstanding as any[]) {
            try {
              // Same shape the reminder uses — the token IS the identity, so
              // the link works without a login (S629).
              // S647: tenant-only here (onlyTenantsLeft), so always the
              // one-link rule — set up the account and open the lease.
              const link = await tenantLeaseLink({
                userId: s.user_id, documentId: d.id, signerToken: s.token, sendTo: s.send_to })
              await emailSigningRequest(s.send_to, s.name, d.title, unitLabel,
                ll?.name || 'Your landlord', link.url,
                { landlordId: d.landlord_id, documentId: d.id, needsSetup: link.needsSetup,
                  // 10/5: replies reach the people who run this property (services/replyRouting).
                  replyTo: replyToProperty(d.property_id) })
              await query(
                `UPDATE lease_document_signers
                    SET status='sent', invite_sent=TRUE, invite_sent_at=NOW() WHERE id=$1`, [s.id])
            } catch (e) {
              logger.error({ err: e, signer_id: s.id }, '[ESIGN-TIMEOUTS] resend failed')
            }
          }
          await query(
            `UPDATE lease_documents SET signing_window_restarted_at=NOW(), updated_at=NOW() WHERE id=$1`,
            [d.id])
          logger.info({ document_id: d.id, resent: (outstanding as any[]).length },
            '[ESIGN-TIMEOUTS] window restarted — resent rather than voided')
          continue
        }

        await cascadeLeaseTenantsOnVoid(query, d)
        await query(`UPDATE lease_documents SET status='voided', voided_at=NOW(), void_reason=$1, updated_at=NOW() WHERE id=$2`,
          ['auto-voided: signers did not respond within 48 hours', d.id])

        const unitLabel = d.unit_number ? `Unit ${d.unit_number} — ${d.property_name}` : d.title
        // S654: each signer at the address on their own account (the landlord's
        // row keeps its own), never a signer row's possibly stale one.
        const recipients = await query<any>(`
          SELECT CASE WHEN s.role = 'landlord' THEN s.email ELSE COALESCE(su.email, s.email) END AS email, s.name, s.role
            FROM lease_document_signers s LEFT JOIN users su ON su.id = s.user_id
           WHERE s.document_id=$1
          UNION ALL
          SELECT lu.email, (lu.first_name || ' ' || lu.last_name) as name, 'landlord' AS role
          FROM landlords la JOIN users lu ON lu.id = la.user_id WHERE la.id=$2
        `, [d.id, d.landlord_id])
        for (const rcp of recipients as any[]) {
          try {
            // 10/5: a resident's reply ("contact the landlord") reaches the property
            // (services/replyRouting); the landlord side's copies stay GAM's.
            await emailDocumentAutoVoided(rcp.email, rcp.name, d.title, unitLabel, { landlordId: d.landlord_id, documentId: d.id,
              replyTo: rcp.role === 'landlord' ? undefined : replyToProperty(d.property_id) })
          } catch(e) {
            logger.error({ err: e, recipient_email: rcp.email }, '[ESIGN-TIMEOUTS] auto-void email failed')
          }
        }
      } catch(e) {
        logger.error({ err: e, document_id: d.id }, '[ESIGN-TIMEOUTS] auto-void failed for doc')
      }
    }
    if ((expired as any[]).length > 0) {
      logger.info(`[ESIGN-TIMEOUTS] auto-voided ${(expired as any[]).length} document(s)`)
    }

    // ── RENEWALS: A NEW LEASE FOR A HOUSEHOLD ALREADY LIVING THERE ──────
    // Their own clock (passes 1 and 2 exclude renews_lease_id). S655.
    await processNewLeaseSignings()
  } catch(e) { logger.error({ err: e }, '[SCHEDULER] esign timeouts') }
}

/** 'YYYY-MM-DD' from a document date box (M/D/YYYY, or ISO), or null. */
function docBoxDate(raw: string | null | undefined): string | null {
  const t = String(raw ?? '').trim()
  if (!t) return null
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(t)?.[1] || documentDateToIso(t)
  return iso || null
}

/**
 * S536 → S655: A NEW LEASE FOR A HOUSEHOLD ALREADY LIVING THERE (a renewal —
 * month-to-month included) runs on its own clock.
 *
 * Nic (10/2): "they always get charged the new rent, whether or not they sign
 * it... the old one is expired... they've had plenty of notice." So a new lease
 * the LANDLORD has signed is never canceled for want of the tenant's
 * signature: it takes over on its start date (activatePendingLeases →
 * processLeaseEnds) and stays open for theirs. The S536 deadline-void that used
 * to cancel it a day before the old lease ended — and then vacate a household
 * that was not leaving — is gone.
 *
 * Only a draft the landlord NEVER signed lapses, once its start date has passed
 * (it was never sent to the household, so only the landlord hears). Without a
 * readable start date, the old S536 rule decides: the day before the old lease's
 * end, or the end of the month after drafting for a month-to-month.
 *
 * Reminders (one email per stage, never a stream):
 *   - the landlord, each morning at 8 while drafts wait on them (at most 8) —
 *     ONE email listing every draft waiting on that person, with one link that
 *     signs them in a row (S652 "one email per thing": a park-wide batch of 40
 *     is one email, not 40). The lapse notice is one email per person too;
 *   - the tenant at 9, 14 days and 3 days before the start — after the signing
 *     request they got when the landlord signed, and the banner in their portal.
 *     NEW_LEASE_TENANT_REMINDER_DAYS.
 *
 * The landlord's own "not signed yet" alerts (14 days out, and on the start
 * date) are sent by jobs/renewalPing.
 */
export async function processNewLeaseSignings(opts: { hour?: number } = {}) {
  const hour = opts.hour ?? new Date().getHours()

  // ── Lapse: a draft the landlord never signed ────────────────────────────
  const drafts = await query<any>(`
    SELECT d.id, d.title, d.document_type, d.landlord_id, d.lease_id, d.issued_at, d.unit_id,
           u.unit_number, p.name AS property_name, COALESCE(p.timezone, 'America/Phoenix') AS tz,
           (SELECT f.value FROM lease_document_fields f
             WHERE f.document_id = d.id AND f.lease_column = 'start_date'
               AND f.value IS NOT NULL AND btrim(f.value) <> ''
             LIMIT 1) AS start_raw,
           to_char(COALESCE(ol.end_date,
                            (date_trunc('month', d.created_at) + INTERVAL '2 months' - INTERVAL '1 day')::date),
                   'YYYY-MM-DD') AS fallback_last
      FROM lease_documents d
      JOIN leases ol ON ol.id = d.renews_lease_id
      LEFT JOIN units u ON u.id = d.unit_id
      LEFT JOIN properties p ON p.id = u.property_id
     WHERE d.status IN ('sent','in_progress')
       AND d.issued_at IS NULL AND d.lease_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM lease_document_signers ls
                        WHERE ls.document_id = d.id AND ls.role = 'landlord' AND ls.status = 'signed')
  `)
  let lapsed = 0
  // One lapse email per landlord-side person, listing every draft of theirs that
  // lapsed in this run.
  const lapseMail = new Map<string, { email: string; name: string; landlordId: string; items: NewLeaseDigestItem[]; documentId: string }>()
  for (const d of drafts as any[]) {
    try {
      const today = todayIn(d.tz)
      const startIso = docBoxDate(d.start_raw)
      const due = startIso ? today > startIso : today >= addDaysTo(d.fallback_last, -1)
      if (!due) continue
      const vc = await getClient()
      try {
        await vc.query('BEGIN')
        await cascadeLeaseTenantsOnVoid(vc.query.bind(vc) as any, d)
        const { unwindIssuedLease } = await import('../lib/unwindIssuedLease')
        await unwindIssuedLease(vc.query.bind(vc), d)
        await vc.query(`UPDATE lease_documents SET status='voided', voided_at=NOW(), void_reason=$1, updated_at=NOW() WHERE id=$2`,
          ['auto-voided: the landlord never signed this new lease before its start date', d.id])
        await vc.query('COMMIT')
      } catch (e) {
        await vc.query('ROLLBACK').catch(() => {})
        throw e
      } finally {
        vc.release()
      }
      lapsed++
      const unitLabel = d.unit_number ? `Unit ${d.unit_number} — ${d.property_name}` : d.title
      // The household was never sent this draft — only the landlord side hears.
      const recipients = await query<any>(`
        SELECT s.email, s.name FROM lease_document_signers s
         WHERE s.document_id = $1 AND s.role = 'landlord'
        UNION
        SELECT lu.email, (lu.first_name || ' ' || lu.last_name) AS name
          FROM landlords la JOIN users lu ON lu.id = la.user_id WHERE la.id = $2
      `, [d.id, d.landlord_id])
      for (const rcp of recipients as any[]) {
        const key = String(rcp.email || '').toLowerCase()
        if (!key) continue
        if (!lapseMail.has(key)) {
          lapseMail.set(key, { email: rcp.email, name: rcp.name, landlordId: d.landlord_id, items: [], documentId: d.id })
        }
        const m = lapseMail.get(key)!
        if (!m.items.some(i => i.unitLabel === unitLabel && i.startDate === startIso)) {
          m.items.push({ unitLabel, startDate: startIso })
        }
      }
    } catch (e) {
      logger.error({ err: e, document_id: d.id }, '[ESIGN-TIMEOUTS] new-lease lapse failed for doc')
    }
  }
  for (const m of lapseMail.values()) {
    try {
      await emailNewLeaseDraftLapsed(m.email, m.name, m.items, { landlordId: m.landlordId, documentId: m.documentId })
    } catch (e) {
      logger.error({ err: e, recipient_email: m.email }, '[ESIGN-TIMEOUTS] new-lease lapse email failed')
    }
  }
  if (lapsed > 0) logger.info(`[ESIGN-TIMEOUTS] ${lapsed} unsigned new-lease draft(s) lapsed at their start date`)

  // ── The lease it follows ended EARLY: nobody is staying on ──────────────
  // The household's lease was ended early while a landlord-signed new lease
  // waited, and nobody in the household had signed it
  // (renewalSuccessor.followsLeaseEndedEarlyUnsigned). Ending it early through
  // the tenant's or the landlord's own button is refused up front now
  // (newLeaseBlocksEarlyEnd), so this is a lease that REPLACED it (a paper
  // lease imported over it). Left alone the new lease came into force on its
  // start date, occupied the emptied space again and billed the new rent to a
  // household that had gone — and by then it could no longer be canceled. It is
  // canceled now, exactly as the window's Cancel button would (lib/voidDocument:
  // the lease row ends, the deposit record goes back to the lease that ended),
  // and the landlord side hears once — one notice per person for the lot. A new
  // lease somebody in the household signed stands (S558; decisions 10/2 #8) and
  // is never touched here.
  //
  // MONEY PAID ON IT holds the cancel. lib/unwindIssuedLease refuses to void a
  // lease money has moved on — undoing a payment is a refund, not a void — e.g.
  // a deposit top-up the tenant paid early. That used to fail here on every
  // run, forever: an error in the log every 15 minutes, the deposit record left
  // on a lease that will never start (so the lease that ended had none to
  // return), and nobody told. Now, once: the deposit record goes back to the
  // lease that ended; what the new lease billed that was never owed comes off
  // (renewalSuccessor.clearNeverOwedOnHeldNewLease — the household that left is
  // not shown a deposit due on it, asked to pay it, or charged a late fee on
  // it); the landlord side and GAM hear. Nobody can sign it meanwhile (GET and
  // POST /esign/sign), so it still never starts. Once the payment has been
  // returned or moved, the next run cancels it like any other.
  //
  // A PAYMENT TRIED ON ITS BILL holds it the same way (fix round 1): a bank or
  // card payment that bounced or is to be retried, a reopened charge the bank
  // sent back, a receipt or credit on a charge — lib/unwindIssuedLease refuses
  // that void too (countTriedCharges), so sending it to the cancel failed
  // every run, exactly as above. It is held instead: a bank retry that would
  // pull money only for this bill is stopped first (a pull that also carries
  // what the household owes elsewhere runs on), then what was never owed comes
  // off. If nothing paid or tried is left after that, it is not held — the
  // next run cancels it like any other, and the landlord hears "canceled",
  // not "can't be canceled".
  //
  // The document is stamped (new_lease_cancel_held_at) so later runs leave it
  // be — LAST, and only once every one of those has landed. The notice helpers
  // never throw (a failed write is only logged), so "landed" is read back from
  // the tables, not assumed (the in-app notice; for someone whose in-app notices
  // are off, the email that went out, recorded on the document's audit trail so
  // it is never sent twice): a notice that did not land leaves the document
  // unstamped and the next run sends what is missing, to only who is missing
  // it, instead of the lease sitting stopped with nobody told. GAM's notice
  // carries what it said (`cleared`, `kept` in its context): when a later run
  // has to leave charges for GAM to take off by hand that the notice did not
  // name — its first clear-up failed, so it could only say "the next run tries
  // again" — GAM gets one follow-up naming them before the document is stamped.
  try {
    const {
      newLeasesAfterEarlyEnd, clearNeverOwedOnHeldNewLease, sayMoney, sayKeptCharges,
    } = await import('../services/renewalSuccessor')
    const { voidDocument } = await import('../lib/voidDocument')
    // S655: the deposit move that counts the new lease's own deposit payments
    // once, and the household lock every writer of a household's money takes
    // — resolved the void's own way (lockLeaseHousehold), so the cancel, the
    // hold and the void inside the cancel all take the same key.
    const {
      returnDepositCountedOnce, countTriedCharges, stopRetriesForChargesTheVoidRemoves, lockLeaseHousehold,
    } = await import('../lib/unwindIssuedLease')
    const { cancelSupersededIntents } = await import('../services/creditUse')
    const { moneyPaidOnLease } = await import('../services/renewalSuccessor')
    const readQ = async (sql: string, params?: any[]) => ({ rows: await query<any>(sql, params) })
    const endedEarly = await newLeasesAfterEarlyEnd(readQ)
    const words = (iso: string) => DateTime.fromISO(iso).toFormat('LLLL d, yyyy')
    type Notice = Map<string, { email: string; landlordId: string; items: any[] }>
    const canceled: Notice = new Map()
    const held: Notice = new Map()
    /** Everyone on the landlord side of document $1 (landlord $2) — its landlord signers and the account owner. */
    const LANDLORD_SIDE = `
        SELECT s.user_id, COALESCE(su.email, s.email) AS email
          FROM lease_document_signers s LEFT JOIN users su ON su.id = s.user_id
         WHERE s.document_id = $1 AND s.role = 'landlord' AND s.user_id IS NOT NULL
        UNION
        SELECT lu.id, lu.email FROM landlords la JOIN users lu ON lu.id = la.user_id WHERE la.id = $2`
    const addTo = (into: Notice, d: any, p: { user_id: string; email: string }) => {
      if (!into.has(p.user_id)) into.set(p.user_id, { email: p.email, landlordId: d.landlord_id, items: [] })
      const items = into.get(p.user_id)!.items
      if (!items.some((x: any) => x.id === d.id)) items.push(d)
    }
    /** Everyone on the landlord side of `d`, once each. */
    const addLandlordSide = async (into: Notice, d: any) => {
      for (const p of await query<{ user_id: string; email: string }>(LANDLORD_SIDE, [d.id, d.landlord_id])) addTo(into, d, p)
    }
    // Held: everything for it is done once it is stamped — it waits on the
    // payment, quietly. The rest are held below, after the cancels.
    const toHold: any[] = []
    for (const d of endedEarly) {
      // A payment tried on its bill holds it like money paid on it: the void
      // would refuse it (lib/unwindIssuedLease, the same count).
      d.tried_count = await countTriedCharges(readQ, d.new_lease_id)
      if (Number(d.paid_count) > 0 || d.tried_count > 0) {
        if (!d.new_lease_cancel_held_at) toHold.push(d)
        continue
      }
      const vc = await getClient()
      try {
        await vc.query('BEGIN')
        // S655 lock order — household, then its leases, then rows: the
        // household first, as the hold below takes it, never after the
        // document (a cancel holding the document while it waited on the
        // household could deadlock with a hold of the same document). The
        // void's unwind takes the same key again, at no cost.
        await lockLeaseHousehold(vc.query.bind(vc), d.new_lease_id)
        // Held for the void, and read again: a signature a moment ago keeps it
        // (voidDocument refuses a document a tenant has signed).
        const live = (await vc.query(
          `SELECT * FROM lease_documents WHERE id = $1 AND status NOT IN ('completed','voided') FOR UPDATE`, [d.id])).rows[0]
        if (!live) { await vc.query('ROLLBACK'); continue }
        await voidDocument(vc.query.bind(vc), live,
          `canceled: the lease it follows ended early (${d.ended_on}) and nobody in the household had signed it`)
        await vc.query('COMMIT')
      } catch (e) {
        await vc.query('ROLLBACK').catch(() => {})
        logger.error({ err: e, document_id: d.id, lease_id: d.new_lease_id },
          '[ESIGN-TIMEOUTS] could not cancel a new lease whose lease ended early — it stays pending and never starts')
        continue
      } finally {
        vc.release()
      }
      logger.info({ document_id: d.id, lease_id: d.new_lease_id, ended_lease_id: d.ended_lease_id },
        '[ESIGN-TIMEOUTS] new lease canceled — the lease it follows ended early')
      await addLandlordSide(canceled, d)
    }
    const { createNotification } = await import('../services/notifications')
    for (const [userId, t] of canceled) {
      const one = t.items.length === 1
      const first = t.items[0]
      const line = (d: any) => `${d.unit_label} at ${d.property_name} (its lease ended early on ${words(d.ended_on)}; ` +
        `the new lease was to start ${words(d.new_start_date)})`
      try {
        await createNotification({
          userId, landlordId: t.landlordId,
          type: 'lease_renewal_status',
          title: one ? `New lease canceled — ${first.unit_label}, ${first.property_name}`
                     : `${t.items.length} new leases canceled`,
          body: (one
            ? `The lease for ${first.unit_label} at ${first.property_name} ended early on ${words(first.ended_on)}, and nobody ` +
              `in the household had signed the new lease that was to start ${words(first.new_start_date)}, so it has been canceled. `
            : `These leases ended early, and nobody in the household had signed the new lease that was to follow, so each new ` +
              `lease has been canceled: ${t.items.map(line).join('; ')}. `) +
            'Nothing else to do. If a household is staying after all, invite them again from the Tenants page.',
          data: { documentIds: t.items.map((d: any) => d.id), leaseIds: t.items.map((d: any) => d.new_lease_id) },
          actionUrl: '/leases',
          sendEmail: true,
          emailTo: t.email,
          emailSubject: one ? `New lease canceled — ${first.unit_label}, ${first.property_name}`
                            : `${t.items.length} new leases canceled`,
        })
      } catch (e) {
        logger.error({ err: e, user_id: userId }, '[ESIGN-TIMEOUTS] new-lease canceled notice failed')
      }
    }
    // ── Held: money paid on it ──────────────────────────────────────────────
    // One run at a time through this step (a transaction-scoped advisory lock),
    // so two overlapping runs never tell anyone twice.
    if (toHold.length) {
      const gate = await getClient()
      try {
        await gate.query('BEGIN')
        const ours = (await gate.query(
          `SELECT pg_try_advisory_xact_lock(hashtextextended('new_lease_cancel_held', 0)) AS ok`)).rows[0]?.ok === true
        if (ours) {
          // 1. The money side, per document, in its own transaction: the deposit
          //    record back on the lease that ended, then what was never owed off
          //    the new lease. A failure taking the charges off is kept apart
          //    (savepoint) so the deposit move and the notices still go ahead;
          //    the document then stays unstamped and the next run tries again.
          //    `kept`: unpaid charge rows another record points at, which stay
          //    for GAM to take off by hand (named in GAM's notice).
          const ready: any[] = []
          const cleared = new Set<string>()
          type Kept = Awaited<ReturnType<typeof clearNeverOwedOnHeldNewLease>>['keptCharges']
          const kept = new Map<string, Kept>()
          for (const d of toHold) {
            const vc = await getClient()
            try {
              await vc.query('BEGIN')
              // S655: the household's lock first — this moves their deposit
              // record and takes unpaid charges off the new lease.
              await lockLeaseHousehold(vc.query.bind(vc), d.new_lease_id)
              const live = (await vc.query(
                `SELECT id FROM lease_documents
                  WHERE id = $1 AND status NOT IN ('completed','voided') AND new_lease_cancel_held_at IS NULL
                  FOR UPDATE`, [d.id])).rows[0]
              if (!live) { await vc.query('ROLLBACK'); continue }
              const vq = vc.query.bind(vc) as any
              await returnDepositCountedOnce(vq, d.new_lease_id, d.ended_lease_id)
              // Bank pulls stopped in this transaction, canceled at Stripe after
              // its COMMIT — only if the savepoint that stopped them held.
              let stopped: string[] = []
              await vc.query('SAVEPOINT never_owed')
              try {
                // A bank retry still to come for this bill alone would pull
                // money for a lease that never starts: stopped first, and the
                // credit it set aside given back, so its charge can come off.
                const stop = await stopRetriesForChargesTheVoidRemoves(vc, d.new_lease_id)
                const off = await clearNeverOwedOnHeldNewLease(vq, d.new_lease_id, d.ended_lease_id)
                await vc.query('RELEASE SAVEPOINT never_owed')
                stopped = stop
                cleared.add(d.id)
                kept.set(d.id, off.keptCharges)
                if (off.charges || off.bills || off.retotaled || off.utilityBills) {
                  logger.info({ document_id: d.id, lease_id: d.new_lease_id, ...off },
                    '[ESIGN-TIMEOUTS] held new lease — its unpaid charges and open bills taken off (never owed)')
                }
                if (off.kept) {
                  logger.warn({ document_id: d.id, lease_id: d.new_lease_id, kept: off.kept,
                                kept_payment_ids: off.keptCharges.map(k => k.paymentId) },
                    '[ESIGN-TIMEOUTS] held new lease — unpaid charge rows other records point at were left for GAM')
                }
              } catch (e) {
                await vc.query('ROLLBACK TO SAVEPOINT never_owed')
                logger.error({ err: e, document_id: d.id, lease_id: d.new_lease_id },
                  '[ESIGN-TIMEOUTS] could not take the unpaid charges off a held new lease — retried next run')
              }
              // Still held? Read again now the never-owed charges are off: with
              // no money paid on it and no charge a payment was tried on left,
              // nothing stops the cancel, and the next run makes it (the
              // landlord hears "canceled", never "can't be canceled" first).
              d.tried_count = await countTriedCharges(vq, d.new_lease_id)
              const stillHeld = !!(await moneyPaidOnLease(vq, d.new_lease_id)) || d.tried_count > 0
              await vc.query('COMMIT')
              await cancelSupersededIntents(stopped)   // never throws
              if (stillHeld) {
                ready.push(d)
              } else {
                logger.info({ document_id: d.id, lease_id: d.new_lease_id },
                  '[ESIGN-TIMEOUTS] new lease after an early end — what held it is cleared; canceled next run')
              }
            } catch (e) {
              await vc.query('ROLLBACK').catch(() => {})
              logger.error({ err: e, document_id: d.id, lease_id: d.new_lease_id },
                '[ESIGN-TIMEOUTS] could not hold a new lease with money paid or a payment tried on it — retried next run')
            } finally {
              vc.release()
            }
          }

          // Who on the landlord side has had the held notice naming `d` (read
          // back, not assumed):
          //   - the in-app notice is in their bell (a notifications row naming it);
          //   - or, for someone whose in-app notices of this kind are off, the
          //     email — their only copy — went out. There is no row of theirs to
          //     read back, so once email_send_log shows it went, step 2 records it
          //     on the document's own trail (audit_log, HELD_EMAILED), naming
          //     them. Final sweep (10/3): they used to count as never told, so
          //     every run that found the document still unstamped (its clear-up
          //     failing, a notice to GAM or to someone else not landing) emailed
          //     them the same notice again — every 15 minutes while it lasted;
          //   - or both their in-app notices and their emails of this kind are
          //     off: there is nothing to send them.
          // A copy that did not land counts as not told: they are sent it again
          // next run, and the document is not stamped until it lands.
          const HELD_EMAILED = 'document.new_lease_cancel_held_emailed'
          const landlordSide = (d: any) => query<{ user_id: string; email: string; told: boolean; in_app_off: boolean }>(`
            SELECT x.user_id, x.email,
                   (EXISTS (SELECT 1 FROM notifications n
                             WHERE n.user_id = x.user_id AND n.type = 'lease_renewal_status'
                               AND n.data->>'kind' = 'new_lease_cancel_held'
                               AND (n.data->'documentIds') ? $3)
                    OR EXISTS (SELECT 1 FROM audit_log a
                                WHERE a.action = $4 AND a.entity_type = 'lease_document' AND a.entity_id = $1
                                  AND a.new_value->>'userId' = x.user_id::text)
                    OR EXISTS (SELECT 1 FROM notification_preferences np
                                WHERE np.user_id = x.user_id AND np.type = 'lease_renewal_status'
                                  AND np.in_app_enabled = FALSE AND np.email_enabled = FALSE)) AS told,
                   EXISTS (SELECT 1 FROM notification_preferences np
                            WHERE np.user_id = x.user_id AND np.type = 'lease_renewal_status'
                              AND np.in_app_enabled = FALSE) AS in_app_off
              FROM (${LANDLORD_SIDE}) x`, [d.id, d.landlord_id, String(d.id), HELD_EMAILED])
          // GAM's latest notice about `d` (read back, not assumed) — its context
          // says what that notice told GAM: whether the unpaid charges had come
          // off (`cleared`) and how many were left to take off by hand (`kept`).
          const gamLast = async (d: any) => (await queryOne<{ context: any }>(
            `SELECT context FROM admin_notifications
              WHERE category = 'new_lease_cancel_held' AND context->>'document_id' = $1::text
              ORDER BY created_at DESC, id DESC LIMIT 1`, [d.id]))?.context ?? null
          /**
           * GAM's notices about `d` already say everything this run found: it was
           * told at all, and — when charges were left for GAM to take off by hand —
           * a notice said the charges came off and named at least that many. A
           * notice from a run whose clear-up failed ("the next run tries again")
           * says nothing about what a later run had to leave behind.
           */
          const gamUpToDate = (d: any, last: any): boolean => {
            if (!last) return false
            const k = kept.get(d.id)?.length ?? 0
            return !(cleared.has(d.id) && k > 0) || (last.cleared === true && Number(last.kept ?? 0) >= k)
          }
          const keptSentence = (k: Kept) =>
            `${k.length} unpaid charge${k.length === 1 ? '' : 's'} on it could not be taken off because other records ` +
            `point at ${k.length === 1 ? 'it' : 'them'} (${sayKeptCharges(k)}) — take ${k.length === 1 ? 'it' : 'them'} ` +
            'off by hand so the household is not asked to pay.'
          const gamContext = (d: any, extra: Record<string, unknown> = {}) => ({
            document_id: d.id, new_lease_id: d.new_lease_id, ended_lease_id: d.ended_lease_id, paid_total: d.paid_total,
            tried_count: d.tried_count ?? 0, cleared: cleared.has(d.id), kept: kept.get(d.id)?.length ?? 0,
            kept_payment_ids: (kept.get(d.id) ?? []).map(k => k.paymentId).filter(Boolean),
            ...extra,
          })

          // 2. The landlord side: one notice per person for the lot, to
          //    whoever has not had one naming that space yet.
          /** People whose in-app notices of this kind are off: their copy is the email alone. */
          const emailOnly = new Set<string>()
          for (const d of ready) {
            for (const p of await landlordSide(d)) {
              if (p.told) continue
              addTo(held, d, p)
              if (p.in_app_off) emailOnly.add(p.user_id)
            }
          }
          // "Nothing unpaid is billed" is said only where it is true this run.
          const allOff = (items: any[]) => items.every((d: any) => cleared.has(d.id) && !kept.get(d.id)?.length)
          // Money paid on it, or (no money moved) a payment tried on its bill
          // that did not go through: what holds it, in words.
          const paidOn = (d: any) => Number(d.paid_count) > 0
          for (const [userId, t] of held) {
            const one = t.items.length === 1
            const first = t.items[0]
            const everyPaid = t.items.every(paidOn)
            const line = (d: any) => `${d.unit_label} at ${d.property_name} (` +
              (paidOn(d) ? `${sayMoney(Number(d.paid_total))} paid` : 'a payment tried on its bill did not go through') +
              `; its lease ended early on ${words(d.ended_on)}; the new lease was to start ${words(d.new_start_date)})`
            const title = one ? `New lease can't be canceled yet — ${first.unit_label}, ${first.property_name}`
                              : `${t.items.length} new leases can't be canceled yet`
            // The database's own clock, so the read-back below finds only this send.
            const sentFrom = emailOnly.has(userId)
              ? (await queryOne<{ at: string }>(`SELECT clock_timestamp()::text AS at`))?.at ?? null
              : null
            await createNotification({
              userId, landlordId: t.landlordId,
              type: 'lease_renewal_status',
              title,
              body: (one
                ? `The lease for ${first.unit_label} at ${first.property_name} ended early on ${words(first.ended_on)}, and nobody ` +
                  `in the household had signed the new lease that was to start ${words(first.new_start_date)}. It will never ` +
                  (paidOn(first)
                    ? `start, but ${sayMoney(Number(first.paid_total))} was already paid on it, so it can't be canceled until that ` +
                      'money is returned or moved. '
                    : 'start, but a payment was tried on its bill and did not go through, so it can\'t be canceled until GAM ' +
                      'takes that charge off. ') +
                  'The deposit record is back on the lease that ended' +
                  (allOff([first]) ? ', and nothing unpaid on the new lease is billed to the household. ' : '. ')
                : 'These leases ended early, and nobody in the household had signed the new lease that was to follow. None of ' +
                  (everyPaid
                    ? 'those new leases will start, but money was already paid on each, so they can\'t be canceled until it is ' +
                      'returned or moved: '
                    : 'those new leases will start, but money was paid, or a payment was tried, on each, so they can\'t be ' +
                      'canceled until that is sorted out: ') +
                  `${t.items.map(line).join('; ')}. The deposit records are back on the leases that ended` +
                  (allOff(t.items) ? ', and nothing unpaid on the new leases is billed to the households. ' : '. ')) +
                'GAM has been told. To speed it up, email support@goldassetmanagement.com and name the ' +
                (one ? 'space' : 'spaces') + '. Once it is sorted, ' + (one ? 'the new lease is' : 'each is') + ' canceled for you.',
              // `kind` is what a later run reads back to know this person was told.
              data: { kind: 'new_lease_cancel_held', documentIds: t.items.map((d: any) => d.id),
                      leaseIds: t.items.map((d: any) => d.new_lease_id) },
              actionUrl: '/leases',
              sendEmail: true,
              emailTo: t.email,
              emailSubject: title,
            })
            // In-app notices off: no row of theirs to read back, so read back that
            // the email went out (email_send_log — 'failed' means the provider
            // refused it; an address the provider will not deliver to can never
            // land, so trying again changes nothing) and record it on each
            // document it named, for later runs (landlordSide).
            if (sentFrom) {
              try {
                const sent = await queryOne<{ id: string }>(
                  `SELECT id FROM email_send_log
                    WHERE category = 'notif_lease_renewal_status' AND metadata->>'user_id' = $1
                      AND subject = $2 AND created_at >= $3::timestamptz AND status <> 'failed'
                    ORDER BY created_at DESC LIMIT 1`, [userId, title, sentFrom])
                if (sent) {
                  for (const d of t.items) {
                    await query(
                      `INSERT INTO audit_log (user_id, action, entity_type, entity_id, new_value)
                       VALUES (NULL, $1, 'lease_document', $2, $3::jsonb)`,
                      [HELD_EMAILED, d.id, JSON.stringify({ userId, sentTo: t.email, subject: title, emailLogId: sent.id })])
                  }
                } else {
                  logger.warn({ user_id: userId, document_ids: t.items.map((d: any) => d.id) },
                    '[ESIGN-TIMEOUTS] held new lease — the email to someone with in-app notices off did not go out; sent again next run')
                }
              } catch (e) {
                logger.error({ err: e, user_id: userId },
                  '[ESIGN-TIMEOUTS] held new lease — could not record the email to someone with in-app notices off; sent again next run')
              }
            }
          }

          // 3. GAM, once per new lease — and once more if a later run had to
          //    leave charges for GAM to take off by hand that GAM's notice did not
          //    name (the first run's clear-up failed, so its notice could only say
          //    "the next run tries again"). Without it the document was stamped
          //    with the charge still due and nobody told to take it off.
          const { createAdminNotification } = await import('../services/adminNotifications')
          for (const d of ready) {
            const last = await gamLast(d)
            if (last) {
              if (gamUpToDate(d, last)) continue
              const k = kept.get(d.id) ?? []
              logger.warn({ document_id: d.id, lease_id: d.new_lease_id, kept: k.length },
                '[ESIGN-TIMEOUTS] held new lease — charges left for GAM that its notice did not name; GAM told')
              await createAdminNotification({
                severity: 'warn',
                category: 'new_lease_cancel_held',
                title: `Unpaid charges to take off by hand — ${d.unit_label}, ${d.property_name}`,
                body: `Follow-up on the new lease for ${d.unit_label} at ${d.property_name} that can't be canceled ` +
                  (paidOn(d)
                    ? `(${sayMoney(Number(d.paid_total))} was paid on it; it will never start). Its unpaid charges have now been ` +
                      `taken off, except: ${keptSentence(k)} Return or move the payment as before; the next run then cancels ` +
                      'the new lease.'
                    : '(a payment was tried on its bill and did not go through; it will never start). Its unpaid charges have ' +
                      `now been taken off, except: ${keptSentence(k)} Once they are off, the next run cancels the new lease.`),
                context: gamContext(d, { follow_up: true }),
              })
              continue
            }
            logger.warn({ document_id: d.id, lease_id: d.new_lease_id, ended_lease_id: d.ended_lease_id, paid_total: d.paid_total,
                          tried_count: d.tried_count },
              paidOn(d)
                ? '[ESIGN-TIMEOUTS] new lease after an early end has money paid on it — held until it is returned; landlord side and GAM told'
                : '[ESIGN-TIMEOUTS] new lease after an early end has a payment tried on its bill — held until that charge is off; landlord side and GAM told')
            await createAdminNotification({
              severity: 'warn',
              category: 'new_lease_cancel_held',
              title: paidOn(d)
                ? `New lease can't be canceled — money paid on it (${d.unit_label}, ${d.property_name})`
                : `New lease can't be canceled — a payment was tried on its bill (${d.unit_label}, ${d.property_name})`,
              body: `The lease it follows ended early on ${words(d.ended_on)} and nobody in the household signed the new lease ` +
                `(it was to start ${words(d.new_start_date)}), so it will never start. ` +
                (paidOn(d)
                  ? `But ${sayMoney(Number(d.paid_total))} was already paid on it. Return or move that payment; the next run then ` +
                    'cancels the new lease. '
                  : 'But a payment was tried on its bill and did not go through, and the charge it was tried on is the record ' +
                    'of that payment, so the void refuses it. Once no such charge is left on it, the next run cancels the new lease. ') +
                'The deposit record is already back on the lease that ended' +
                (!cleared.has(d.id) ? '. Its unpaid charges could not be taken off yet; the next run tries again. '
                  : kept.get(d.id)?.length ? `. ${keptSentence(kept.get(d.id)!)} `
                  : ', and nothing unpaid on the new lease is billed to the household. ') +
                'The landlord is told too.',
              context: gamContext(d),
            })
          }

          // 4. The stamp, last: only for a document whose charges came off, whose
          //    GAM notices say everything this run found (gamUpToDate — including
          //    any charges left for GAM to take off by hand), and that everyone on
          //    the landlord side was told about (landlordSide — by email alone for
          //    someone whose in-app notices are off). Anything missing is sent
          //    again next run.
          for (const d of ready) {
            if (!cleared.has(d.id) || !gamUpToDate(d, await gamLast(d))) continue
            if ((await landlordSide(d)).some(p => !p.told)) {
              logger.warn({ document_id: d.id }, '[ESIGN-TIMEOUTS] held new lease — a landlord-side notice did not land; sent again next run')
              continue
            }
            await query(
              `UPDATE lease_documents SET new_lease_cancel_held_at = NOW(), updated_at = NOW()
                WHERE id = $1 AND new_lease_cancel_held_at IS NULL`, [d.id])
          }
        }
      } finally {
        await gate.query('ROLLBACK').catch(() => {})
        gate.release()
      }
    }
  } catch (e) {
    logger.error({ err: e }, '[ESIGN-TIMEOUTS] new leases after an early end — sweep failed; retried next run')
  }

  // ── The landlord, each morning, while drafts wait on them ───────────────
  // One email per landlord-side signer, listing every draft waiting on them.
  if (hour === 8) {
    const rows = await query<any>(`
      SELECT s.id, s.email, s.name, s.token, s.user_id,
             d.id AS doc_id, d.landlord_id, COALESCE(u.display_label, u.unit_number) AS unit_number,
             p.name AS property_name, d.title,
             (SELECT f.value FROM lease_document_fields f WHERE f.document_id = d.id
                AND f.lease_column = 'start_date' AND f.value IS NOT NULL AND btrim(f.value) <> '' LIMIT 1) AS start_raw,
             (SELECT f.value FROM lease_document_fields f WHERE f.document_id = d.id
                AND f.lease_column = 'rent_amount' AND f.value IS NOT NULL AND btrim(f.value) <> '' LIMIT 1) AS rent_raw
        FROM lease_document_signers s
        JOIN lease_documents d ON d.id = s.document_id
        LEFT JOIN units u ON u.id = d.unit_id
        LEFT JOIN properties p ON p.id = u.property_id
       WHERE d.renews_lease_id IS NOT NULL
         AND d.status IN ('sent','in_progress')
         AND s.role = 'landlord' AND s.status IN ('sent','viewed')
         AND (s.reminder_sent_at IS NULL OR s.reminder_sent_at < NOW() - INTERVAL '20 hours')
         AND COALESCE(s.reminder_count, 0) < 8
       ORDER BY p.name, COALESCE(u.display_label, u.unit_number)
    `)
    const byPerson = new Map<string, any[]>()
    for (const r of rows as any[]) {
      if (!docBoxDate(r.start_raw)) continue
      const key = `${r.user_id}|${String(r.email || '').toLowerCase()}`
      if (!byPerson.has(key)) byPerson.set(key, [])
      byPerson.get(key)!.push(r)
    }
    let sent = 0
    for (const group of byPerson.values()) {
      const r = group[0]
      try {
        const items: NewLeaseDigestItem[] = group.map((g: any) => ({
          unitLabel: g.unit_number ? `Unit ${g.unit_number} — ${g.property_name}` : g.title,
          startDate: docBoxDate(g.start_raw),
          rent: String(g.rent_raw ?? '').replace(/[$,\s]/g, ''),
        }))
        // The signing link opens the first; the rest ride along in ?queue= as
        // their own signer tokens, so it works from the email with no session.
        const refs = group.map((g: any) => g.token || g.doc_id)
        const queue = refs.slice(1, 60)
        const url = portalLink('landlord', `sign/${refs[0]}${queue.length ? `?queue=${queue.join(',')}` : ''}`)
        await emailNewLeasesAwaitingLandlord(r.email, r.name, items, url,
          { landlordId: r.landlord_id, documentId: group.length === 1 ? r.doc_id : undefined })
        await query(`UPDATE lease_document_signers
                        SET reminder_sent_at = NOW(), reminder_count = COALESCE(reminder_count, 0) + 1
                      WHERE id = ANY($1::uuid[])`, [group.map((g: any) => g.id)])
        sent++
      } catch (e) {
        logger.error({ err: e, signer_ids: group.map((g: any) => g.id) }, '[ESIGN-TIMEOUTS] new-lease landlord reminder failed')
      }
    }
    if (sent > 0) logger.info(`[ESIGN-TIMEOUTS] sent ${sent} new-lease landlord reminder email(s)`)
  }

  // ── The tenant, 14 and 3 days before the start ──────────────────────────
  if (hour === 9) {
    const { followsLeaseEndedEarlyUnsigned } = await import('../services/renewalSuccessor')
    const rows = await query<any>(`
      SELECT s.id, s.name, s.token, s.user_id,
             COALESCE(su.email, s.email) AS send_to,
             d.id AS doc_id, d.landlord_id, u.unit_number, u.property_id, p.name AS property_name, d.title,
             to_char(nl.start_date, 'YYYY-MM-DD') AS start_date, nl.rent_amount::text AS rent,
             lu.first_name || ' ' || lu.last_name AS landlord_name
        FROM lease_document_signers s
        LEFT JOIN users su ON su.id = s.user_id
        JOIN lease_documents d ON d.id = s.document_id
        JOIN leases nl ON nl.id = d.lease_id
        LEFT JOIN units u ON u.id = d.unit_id
        LEFT JOIN properties p ON p.id = u.property_id
        JOIN landlords la ON la.id = d.landlord_id
        JOIN users lu ON lu.id = la.user_id
       WHERE d.renews_lease_id IS NOT NULL
         AND d.status IN ('sent','in_progress')
         AND nl.status IN ('pending','active')
         AND s.role <> 'landlord' AND s.status IN ('sent','viewed')
         AND COALESCE(s.reminder_count, 0) < 8
         -- Not a new lease whose lease before it ENDED EARLY with nobody signed:
         -- it never starts, nobody can sign it, and it is being canceled (or
         -- waits on money paid on it) — a "please sign" would invite them back
         -- into a lease for a home they left.
         AND NOT ${followsLeaseEndedEarlyUnsigned('nl')}
         -- Their turn: everyone before them, the landlord included, has signed.
         AND NOT EXISTS (SELECT 1 FROM lease_document_signers e
                          WHERE e.document_id = d.id AND e.status <> 'signed'
                            AND (e.order_index < s.order_index OR e.role = 'landlord'))
         -- A stage (14 or 3 days out) has arrived since we last wrote to them.
         AND EXISTS (SELECT 1 FROM unnest($1::int[]) AS k(days)
                      WHERE CURRENT_DATE >= nl.start_date - k.days
                        AND COALESCE(s.reminder_sent_at, s.invite_sent_at, d.created_at)::date
                              < nl.start_date - k.days)
    `, [[...NEW_LEASE_TENANT_REMINDER_DAYS]])
    let sent = 0
    for (const r of rows as any[]) {
      try {
        const unitLabel = r.unit_number ? `Unit ${r.unit_number} — ${r.property_name}` : r.title
        const link = await tenantLeaseLink({ userId: r.user_id, documentId: r.doc_id, signerToken: r.token, sendTo: r.send_to })
        await emailNewLeaseSigningReminder(r.send_to, r.name, unitLabel, r.landlord_name, link.url,
          { startDate: r.start_date, rent: r.rent, needsSetup: link.needsSetup,
            landlordId: r.landlord_id, documentId: r.doc_id,
            // 10/5: replies reach the people who run this property (services/replyRouting).
            replyTo: replyToProperty(r.property_id) })
        await query(`UPDATE lease_document_signers
                        SET reminder_sent_at = NOW(), reminder_count = COALESCE(reminder_count, 0) + 1
                      WHERE id = $1`, [r.id])
        sent++
      } catch (e) {
        logger.error({ err: e, signer_id: r.id }, '[ESIGN-TIMEOUTS] new-lease tenant reminder failed')
      }
    }
    if (sent > 0) logger.info(`[ESIGN-TIMEOUTS] sent ${sent} new-lease tenant reminder(s)`)
  }
}

async function checkLowStock() {
  try {
    // S192: route per-property when items have property_id; fall back
    // to per-landlord (legacy) for items with NULL property_id. Per-
    // property pings go through the responsible-party resolver so a
    // PM-managed property's low-stock alerts go to the PM staff, not
    // the landlord owner.
    //
    // Group by (landlord_id, property_id). NULL is its own bucket per
    // SQL grouping semantics — that becomes the "landlord-wide" bucket.
    const groups = await query<{
      landlord_id: string
      property_id: string | null
    }>(
      `SELECT DISTINCT landlord_id, property_id
         FROM pos_items
        WHERE is_active = TRUE
          AND stock_qty <= stock_min`,
    )

    for (const g of groups) {
      const low = await query<any>(
        `SELECT pi.*, v.name as vendor_name
           FROM pos_items pi
           LEFT JOIN pos_vendors v ON v.id = pi.vendor_id
          WHERE pi.landlord_id = $1
            AND pi.stock_qty <= pi.stock_min
            AND pi.is_active = TRUE
            AND ${g.property_id === null ? 'pi.property_id IS NULL' : 'pi.property_id = $2'}`,
        g.property_id === null ? [g.landlord_id] : [g.landlord_id, g.property_id],
      )
      if (low.length === 0) continue

      if (g.property_id) {
        // Per-property: route via responsible-party resolver.
        const { getPropertyResponsibleParty } = await import('../services/responsibleParty')
        const targets = await getPropertyResponsibleParty(g.property_id)
        if (!targets) continue
        for (const recipient of targets.primaries) {
          await notifyLowStock({
            landlordUserId: recipient.user_id,
            landlordId:     g.landlord_id,
            landlordEmail:  recipient.email,
            items:          low,
          })
        }
      } else {
        // Landlord-wide (legacy posture for items with NULL property_id).
        const landlord = await queryOne<{ id: string; email: string }>(
          `SELECT u.id, u.email FROM landlords l JOIN users u ON u.id = l.user_id WHERE l.id = $1`,
          [g.landlord_id],
        )
        if (landlord) {
          await notifyLowStock({
            landlordUserId: landlord.id,
            landlordId:     g.landlord_id,
            landlordEmail:  landlord.email,
            items:          low,
          })
        }
      }
    }
  } catch(e) { logger.error({ err: e }, '[SCHEDULER] low stock') }
}

// W-46: business-use supplies (parts_inventory) low-stock sweep. Separate
// from the POS sweep above — parts_inventory has no property_id, so alerts
// are landlord-wide only. min_quantity > 0 makes targets opt-in: items
// without a set minimum never nag.
async function checkPartsLowStock() {
  try {
    const groups = await query<{ landlord_id: string }>(
      `SELECT DISTINCT landlord_id FROM parts_inventory
        WHERE min_quantity > 0 AND quantity <= min_quantity`,
    )
    for (const g of groups) {
      const low = await query<any>(
        `SELECT name, quantity, min_quantity, unit FROM parts_inventory
          WHERE landlord_id = $1 AND min_quantity > 0 AND quantity <= min_quantity
          ORDER BY name ASC`,
        [g.landlord_id],
      )
      if (low.length === 0) continue
      const landlord = await queryOne<{ id: string; email: string }>(
        `SELECT u.id, u.email FROM landlords l JOIN users u ON u.id = l.user_id WHERE l.id = $1`,
        [g.landlord_id],
      )
      if (landlord) {
        const { notifyPartsLowStock } = await import('../services/notifications')
        await notifyPartsLowStock({ landlordUserId: landlord.id, landlordId: g.landlord_id, landlordEmail: landlord.email, items: low })
      }
    }
  } catch(e) { logger.error({ err: e }, '[SCHEDULER] parts low stock') }
}

// W-46: serviceable-asset upkeep reminders — scheduled_maintenance rows
// whose next_due has arrived. Fires daily until marked complete (which
// advances next_due by the recurrence), same nag posture as low-stock.
async function checkServiceDue() {
  try {
    const groups = await query<{ landlord_id: string }>(
      `SELECT DISTINCT landlord_id FROM scheduled_maintenance
        WHERE next_due IS NOT NULL AND next_due <= CURRENT_DATE`,
    )
    for (const g of groups) {
      const due = await query<any>(
        `SELECT sm.title, sm.next_due, p.name as property_name
           FROM scheduled_maintenance sm
           LEFT JOIN properties p ON p.id = sm.property_id
          WHERE sm.landlord_id = $1 AND sm.next_due IS NOT NULL AND sm.next_due <= CURRENT_DATE
          ORDER BY sm.next_due ASC`,
        [g.landlord_id],
      )
      if (due.length === 0) continue
      const landlord = await queryOne<{ id: string; email: string }>(
        `SELECT u.id, u.email FROM landlords l JOIN users u ON u.id = l.user_id WHERE l.id = $1`,
        [g.landlord_id],
      )
      if (landlord) {
        const { notifyServiceDue } = await import('../services/notifications')
        await notifyServiceDue({ landlordUserId: landlord.id, landlordId: g.landlord_id, landlordEmail: landlord.email, items: due })
      }
    }
  } catch(e) { logger.error({ err: e }, '[SCHEDULER] service due') }
}

// W-20 (S531): site reveal — the guest learns their site the MORNING OF
// check-in, at 6:30am in the property's local timezone (Nic S576: gives the
// guest a couple hours' notice before arrival). A previous-day (or pre-6:30am)
// extension can still re-site the incoming guest with zero visible movement,
// because nothing is promised until this message. Runs every 15 minutes;
// reveals confirmed same-day arrivals once 6:30am local has passed. The stamp
// (site_reveal_sent_at) is THE movement fence — once sent, the booking can't be
// re-sited. Tentative (unpaid) holds are never revealed.
const SITE_REVEAL_LOCAL_TIME = '06:30'
export async function revealTodaysSites() {
  try {
    const due = await query<any>(`
      SELECT b.id, b.guest_name, b.guest_email, b.landlord_id,
             to_char(b.check_in, 'YYYY-MM-DD') AS check_in_date,
             u.unit_number, u.check_in_time, u.property_id, p.name AS property_name
        FROM unit_bookings b
        JOIN units u ON u.id = b.unit_id
        JOIN properties p ON p.id = u.property_id
       WHERE b.status = 'confirmed'
         AND b.check_in = (now() AT TIME ZONE COALESCE(p.timezone, 'America/Phoenix'))::date
         AND b.site_reveal_sent_at IS NULL
         AND b.guest_email IS NOT NULL
         AND (now() AT TIME ZONE COALESCE(p.timezone, 'America/Phoenix'))::time
             >= $1::time`, [SITE_REVEAL_LOCAL_TIME])
    for (const b of due) {
      try {
        const { emailBookingSiteAssignment } = await import('../services/email')
        await emailBookingSiteAssignment({
          to: b.guest_email,
          guestName: b.guest_name,
          propertyName: b.property_name,
          unitNumber: b.unit_number,
          // S654: the booking's own check-in day (the property's today, per
          // the WHERE above) — the UTC date ran a day ahead after 5 pm Phoenix.
          checkIn: b.check_in_date,
          checkInTime: b.check_in_time,
          // 10/5: replies reach the people who run this property (services/replyRouting).
          ctx: { landlordId: b.landlord_id, bookingId: b.id, replyTo: replyToProperty(b.property_id) },
        })
        await query(`UPDATE unit_bookings SET site_reveal_sent_at = NOW() WHERE id = $1`, [b.id])
        logger.info(`[site-reveal] booking=${b.id} site=${b.unit_number}`)
      } catch (e) {
        logger.error({ err: e }, `[site-reveal] booking=${b.id} — will retry next run`)
      }
    }
  } catch(e) { logger.error({ err: e }, '[SCHEDULER] site reveal') }
}

// W-44 (S531): tenant private events — hourly sweep, three passes.
//   1. ANNOUNCE: deposit settled → mass property announcement (deferred
//      from approval time; fireAmenityAlert skips deposit-events).
//   2. AUTO-RELEASE: event start arrived with the deposit unpaid → the
//      space becomes NOT private (cancel + void the unpaid deposit +
//      tell the tenant), when the area's event_auto_release is on. A
//      deposit that cannot be taken off holds the release (GAM is told once).
//   3. WAITING FEES: a canceled reservation whose fee was still being paid
//      at the cancel is decided once that payment clears or fails for good
//      (decisions #52; services/commonAreas decideWaitingReservationFee).
export async function processTenantEvents() {
  try {
    // "Is this event's deposit paid?" has ONE definition (services/commonAreas
    // reservationFeePaidSql): the deposit row itself, or — after a dispute or
    // bank return took its money back — the row that dispute reopened, paid
    // again. Testing pay.status alone read a re-paid disputed deposit as
    // unpaid: the event was never announced and was released at its start
    // with the tenant's money kept.
    const { reservationFeePaidSql, reservationFeeMovingSql, reservationFeeUnpaidHowSql } = await import('../services/commonAreas')
    // Pass 1 — announce paid events that haven't been announced. Only money
    // that has ARRIVED announces an event (['settled']).
    const toAnnounce = await query<any>(`
      SELECT car.id, car.property_id, car.landlord_id, car.title, car.kind,
             car.starts_at, car.ends_at, car.reserved_by_tenant_id,
             ca.name AS area_name, p.name AS property_name
        FROM common_area_reservations car
        JOIN common_areas ca ON ca.id = car.common_area_id
        JOIN properties p ON p.id = car.property_id
       WHERE car.kind = 'event'
         AND car.reserved_by_tenant_id IS NOT NULL
         AND car.status = 'approved'
         AND car.notify_residents = TRUE
         AND car.residents_notified_at IS NULL
         AND car.fee_amount > 0
         AND ${reservationFeePaidSql('car.fee_payment_id', ['settled'])}`)
    for (const r of toAnnounce) {
      try {
        const { notifyAmenityUnavailable } = await import('../services/notifications')
        await notifyAmenityUnavailable({
          propertyId: r.property_id, landlordId: r.landlord_id, propertyName: r.property_name,
          areaName: r.area_name, kind: 'event', reason: r.title,
          startsAt: r.starts_at, endsAt: r.ends_at, excludeTenantId: r.reserved_by_tenant_id,
        })
        await query(`UPDATE common_area_reservations SET residents_notified_at = now() WHERE id = $1`, [r.id])
        logger.info(`[events] announced private event ${r.id} (${r.area_name})`)
      } catch (e) { logger.error({ err: e }, `[events] announce ${r.id}`) }
    }

    // Pass 2 — release events whose start arrived with the deposit unpaid.
    const toRelease = await query<any>(`
      SELECT car.id, car.fee_payment_id, car.reserved_by_tenant_id,
             car.landlord_id, car.property_id, car.starts_at, car.ends_at,
             ca.name AS area_name, p.name AS property_name,
             tu.id AS tenant_user_id, tu.email AS tenant_email
        FROM common_area_reservations car
        JOIN common_areas ca ON ca.id = car.common_area_id
        JOIN properties p ON p.id = car.property_id
        JOIN tenants t ON t.id = car.reserved_by_tenant_id
        JOIN users tu ON tu.id = t.user_id
       WHERE car.kind = 'event'
         AND car.reserved_by_tenant_id IS NOT NULL
         AND car.status = 'approved'
         AND car.fee_amount > 0
         AND car.starts_at <= now()
         AND ca.event_auto_release = TRUE
         -- No deposit row, or a deposit not paid (paid, clearing or paid from
         -- the deposit — on the row or on the row a dispute reopened).
         AND NOT ${reservationFeePaidSql('car.fee_payment_id')}
         -- Never while a payment carrying it is still in flight (decisions
         -- #52): a card or bank payment that may still be going through, or a
         -- bank retry still to come — alone or bundled with the household's
         -- rent. A later run decides: the payment cleared (the event is kept)
         -- or failed for good (the event is released, the deposit voided).
         AND NOT ${reservationFeeMovingSql('car.fee_payment_id')}`)
    const { lockHousehold } = await import('../services/moneyPredicates')
    const { voidUnpaidReservationFee, alertEventReleaseHeld, eventReleasedNotice } = await import('../services/commonAreas')
    const { cancelSupersededIntents } = await import('../services/creditUse')
    for (const r of toRelease) {
      try {
        // S655: one transaction, under the household lock (the deposit is
        // household money), with the reservation and its deposit read fresh: a
        // deposit paid since the scan keeps the event, and the release and the
        // deposit's fate land together. The deposit used to be deleted after
        // the event was already marked released; a deposit a payment had been
        // tried on refused the delete, and the event stayed released while the
        // tenant was still billed for it.
        let outcome: 'none' | 'voided' | 'kept' | 'paid' | 'still_paid' | 'held' = 'none'
        let feePaymentId: string | null = null
        let feeAmount = 0
        // The event had been announced to the property (its deposit was paid,
        // then a dispute took it back): the property is told it is open again.
        let announced = false
        // Why the deposit was unpaid (read before the void changes it), and
        // when the event ends (read fresh): the tenant's notice says the true
        // reason, and "open to everyone" only while the event's time is ahead.
        let unpaidHow: 'taken_back' | 'did_not_go_through' | 'not_paid' = 'not_paid'
        let endsAt: string | Date = r.ends_at
        // A bank retry of the deposit alone that the release stopped: canceled after COMMIT.
        const stopped: string[] = []
        const client = await getClient()
        try {
          await client.query('BEGIN')
          await lockHousehold(client, r.reserved_by_tenant_id, r.landlord_id)
          // Read fresh under the household lock, every test the scan used
          // checked again BEFORE anything changes: a deposit paid since the
          // scan — on its own row or on the row a dispute reopened — keeps the
          // event; a payment on it that started since — or a bank retry
          // scheduled since — is still in flight (a later run decides, #52);
          // and an event the landlord moved
          // later, or an area whose auto-release was turned off, is not
          // released.
          const cur = (await client.query<any>(
            `SELECT car.id, car.status, car.fee_payment_id, car.fee_amount::text AS fee_amount,
                    car.reserved_by_tenant_id, car.landlord_id,
                    (car.notify_residents AND car.residents_notified_at IS NOT NULL) AS announced,
                    (car.starts_at <= now() AND ca.event_auto_release = TRUE) AS due,
                    ${reservationFeePaidSql('car.fee_payment_id')} AS fee_paid,
                    ${reservationFeeMovingSql('car.fee_payment_id')} AS fee_moving,
                    CASE WHEN car.fee_payment_id IS NULL THEN 'not_paid'
                         ELSE ${reservationFeeUnpaidHowSql('car.fee_payment_id')} END AS fee_unpaid_how,
                    car.ends_at
               FROM common_area_reservations car
               JOIN common_areas ca ON ca.id = car.common_area_id
              WHERE car.id = $1
              FOR UPDATE OF car`, [r.id])).rows[0]
          if (!cur || cur.status !== 'approved' || cur.due !== true || cur.fee_paid || cur.fee_moving) {
            await client.query('ROLLBACK')
            continue
          }
          feePaymentId = cur.fee_payment_id
          feeAmount = Number(cur.fee_amount)
          announced = cur.announced === true
          unpaidHow = cur.fee_unpaid_how ?? 'not_paid'
          endsAt = cur.ends_at ?? r.ends_at
          // The deposit's fate first, under its own row lock: a payment that
          // landed between the read above and this lock reads 'paid' here.
          outcome = await voidUnpaidReservationFee(client, cur, stopped)
          if (outcome === 'paid') {
            // The tenant paid for the event: it stays theirs. Nothing the void
            // pass touched is kept (it touches nothing on 'paid'; the rollback
            // makes sure), and no retry it stopped is canceled.
            await client.query('ROLLBACK')
            stopped.length = 0
            outcome = 'still_paid'
          } else if (outcome === 'kept') {
            // The deposit is owed by nobody once the event is released, but it
            // cannot be taken off (account credit already spent on it, or a
            // dispute reopened only part of it). Releasing anyway left the
            // tenant billed — autopay or their next pay-in-full would collect
            // it — for an event taken away. So nothing changes: the event
            // stays theirs, the deposit stays owed, and GAM is told once to
            // decide with the landlord (keep the event, or release it and give
            // back the credit / refund the paid part — Nic's call, not GAM's).
            await client.query('ROLLBACK')
            stopped.length = 0
            outcome = 'held'
          } else {
            await client.query(
              `UPDATE common_area_reservations
                  -- After the note the landlord typed when approving it, never over it.
                  SET status='cancelled',
                      decision_note = CASE WHEN COALESCE(btrim(decision_note), '') = '' THEN $2
                                           ELSE rtrim(decision_note) || E'\n\n' || $2 END,
                      updated_at=now()
                WHERE id = $1`, [r.id, 'Auto-released: event deposit unpaid by start time'])
            await client.query('COMMIT')
          }
        } catch (e) {
          await client.query('ROLLBACK').catch(() => {})
          throw e
        } finally {
          client.release()
        }
        if (outcome === 'still_paid') continue
        if (outcome === 'held') {
          await alertEventReleaseHeld({
            reservationId: r.id, paymentId: feePaymentId, landlordId: r.landlord_id,
            tenantId: r.reserved_by_tenant_id, amount: feeAmount,
          })   // never throws; once per reservation
          continue
        }
        await cancelSupersededIntents(stopped)   // never throws
        const { createNotification } = await import('../services/notifications')
        await createNotification({
          userId: r.tenant_user_id, landlordId: r.landlord_id,
          type: 'amenity_unavailable',
          title: `Event released — ${r.area_name}`,
          body: eventReleasedNotice({ areaName: r.area_name, how: unpaidHow, endsAt }),
          data: { reservationId: r.id },
          sendEmail: true, emailTo: r.tenant_email,
          // 10/5: replies reach the people who run this property (services/replyRouting).
          replyTo: replyToProperty(r.property_id),
        })
        // An event the property had been told about (its deposit was paid, then
        // a dispute or bank return took it back) is open again — the property
        // is told, as when an announced event is canceled (routes/commonAreas).
        // Not once the event's time is over: "open again" for a time already
        // past tells nobody anything (a release can come days late, #52).
        if (announced && new Date(endsAt).getTime() > Date.now()) {
          try {
            const { notifyAmenityEventReleased } = await import('../services/notifications')
            await notifyAmenityEventReleased({
              propertyId: r.property_id, landlordId: r.landlord_id, propertyName: r.property_name ?? '',
              areaName: r.area_name, startsAt: r.starts_at, endsAt,
            })
          } catch (e) { logger.error({ err: e }, `[events] open-again notice ${r.id}`) }
        }
        logger.info(`[events] auto-released unpaid event ${r.id} (${r.area_name})`)
      } catch (e) { logger.error({ err: e }, `[events] release ${r.id}`) }
    }

    // Pass 3 — a canceled reservation whose fee (or event deposit) was still
    // being paid at the cancel: decided once that payment clears (refund due /
    // the deposit stands) or fails for good (taken off, never collected, the
    // landlord never told to refund money that did not arrive). Decisions #52.
    // Every waiting fee, page by page (a fee still in flight is left as it
    // is, so a first-page-only pass would recheck the same rows forever).
    const { decideAllWaitingReservationFees } = await import('../services/commonAreas')
    const decidedFees = await decideAllWaitingReservationFees()
    for (const [id, out] of Object.entries(decidedFees)) {
      logger.info(`[events] canceled reservation ${id}: waiting fee decided (${out})`)
    }
  } catch(e) { logger.error({ err: e }, '[SCHEDULER] tenant events') }
}

// ── EMAIL_SEND_LOG PRUNE ────────────────────────────────────
// S103: daily prune of email_send_log. Sent rows decay after 90 days
// (the operational use case is recent failure surfacing; sent rows
// past 90d carry minimal value and inflate the table indefinitely).
// Failed rows survive 365 days — adverse-action / FCRA-adjacent
// failures should outlive any reasonable audit window.
//
// S637 (Nic, DIRECTIVE): "no way to be deleted by any super admin, even me.
// The log is the log." CORRESPONDENCE IS EXEMPT — a letter a person wrote to
// a customer, and our reach-out to a new signup, are kept forever. The reason
// this prune exists is that sign-in codes and rent receipts inflate the table
// without bound, and neither of those is a conversation.
//
// The predicate is email_log_is_permanent(category), the same one the DELETE
// trigger enforces. Filtering here as well is not redundant: without it every
// run would throw against the trigger and log a failure for rows it was never
// meant to touch.
//
// Defensive cap of 10k deletes per status per run keeps a runaway
// backlog from pinning the table; subsequent daily runs catch up.
// In steady state each run deletes whatever crossed the threshold
// on the previous day — typically tens to low hundreds of rows.
// Exported under a test-explicit name: the prune's exemption for
// correspondence is a directive ("the log is the log"), so it is held by a
// test rather than by reading the query.
export const pruneEmailSendLogForTest = () => pruneEmailSendLog()

async function pruneEmailSendLog() {
  const SENT_RETENTION_DAYS = 90
  const FAILED_RETENTION_DAYS = 365
  const LIMIT_PER_RUN = 10000

  try {
    const sentRes = await query<{ deleted: number }>(`
      WITH del AS (
        DELETE FROM email_send_log
        WHERE id IN (
          SELECT id FROM email_send_log
          WHERE status = 'sent'
            AND created_at < NOW() - ($1::int * INTERVAL '1 day')
            AND NOT email_log_is_permanent(category)
          LIMIT $2
        )
        RETURNING 1
      ) SELECT COUNT(*)::int AS deleted FROM del
    `, [SENT_RETENTION_DAYS, LIMIT_PER_RUN])

    const failedRes = await query<{ deleted: number }>(`
      WITH del AS (
        DELETE FROM email_send_log
        WHERE id IN (
          SELECT id FROM email_send_log
          WHERE status = 'failed'
            AND created_at < NOW() - ($1::int * INTERVAL '1 day')
            AND NOT email_log_is_permanent(category)
          LIMIT $2
        )
        RETURNING 1
      ) SELECT COUNT(*)::int AS deleted FROM del
    `, [FAILED_RETENTION_DAYS, LIMIT_PER_RUN])

    const sent = sentRes[0]?.deleted ?? 0
    const failed = failedRes[0]?.deleted ?? 0
    if (sent > 0 || failed > 0) {
      logger.info(`[email-prune] sent=${sent} failed=${failed}`)
    }
  } catch (e) {
    logger.error({ err: e }, '[email-prune] error')
  }
}

// ── OPERATIONAL LOG PRUNES ──────────────────────────────────
// S104: same defensive 10k-per-run cap as the S103 email prune.
//
// notifications + tenant_notifications: read past 180 days deleted
//   (UI clutter; landlord/tenant has already seen and dismissed);
//   unread past 365 days deleted (almost certainly abandoned, and
//   keeping unread-forever creates fake action items on dashboards).
// platform_events: >365 days. Generic event stream, year is plenty.
// pos_inventory_log: >365 days. Standard retail inventory audit window.
//
// Compliance-sensitive tables (admin_action_log, audit_log,
// ach_monitoring_log) are deliberately NOT included — those need
// explicit retention policy from Nic, not a default.
async function pruneOperationalLogs() {
  const READ_NOTIF_DAYS = 180
  const UNREAD_NOTIF_DAYS = 365
  const PLATFORM_EVENTS_DAYS = 365
  const POS_INV_LOG_DAYS = 365
  const LIMIT_PER_RUN = 10000

  async function pruneByCondition(label: string, table: string, where: string, days: number): Promise<number> {
    try {
      const res = await query<{ deleted: number }>(`
        WITH del AS (
          DELETE FROM ${table}
          WHERE id IN (
            SELECT id FROM ${table}
            WHERE ${where}
              AND created_at < NOW() - ($1::int * INTERVAL '1 day')
            LIMIT $2
          )
          RETURNING 1
        ) SELECT COUNT(*)::int AS deleted FROM del
      `, [days, LIMIT_PER_RUN])
      return res[0]?.deleted ?? 0
    } catch (e) {
      logger.error({ err: e, prune_label: label }, '[ops-prune] error')
      return 0
    }
  }

  const counts = {
    notif_read:        await pruneByCondition('notifications.read',        'notifications',        'read = true',  READ_NOTIF_DAYS),
    notif_unread:      await pruneByCondition('notifications.unread',      'notifications',        'read = false', UNREAD_NOTIF_DAYS),
    tnotif_read:       await pruneByCondition('tenant_notifications.read', 'tenant_notifications', 'read = true',  READ_NOTIF_DAYS),
    tnotif_unread:     await pruneByCondition('tenant_notifications.unread','tenant_notifications','read = false', UNREAD_NOTIF_DAYS),
    platform_events:   await pruneByCondition('platform_events',           'platform_events',      'true',         PLATFORM_EVENTS_DAYS),
    pos_inventory_log: await pruneByCondition('pos_inventory_log',         'pos_inventory_log',    'true',         POS_INV_LOG_DAYS),
  }

  const total = Object.values(counts).reduce((s, n) => s + n, 0)
  if (total > 0) {
    const parts = Object.entries(counts).filter(([, n]) => n > 0).map(([k, n]) => `${k}=${n}`).join(' ')
    logger.info(`[ops-prune] ${parts}`)
  }
}

// ── BACKGROUND CHECK EXPIRY (SCREENING_VALID_MONTHS freshness window; S653: a year) ──
// Daily at 3 AM. Flips bgc.status -> 'expired' for completed/approved rows
// past expires_at. Cascades to tenants.background_check_status,
// application_pool.status, and in-flight pool_match_requests.status.
// Terminal match statuses (report_purchased, not_interested) are preserved.
async function processBackgroundCheckExpiry() {
  try {
    const expired = await query<any>(`
      WITH expired_bgc AS (
        UPDATE background_checks
        SET status = 'expired'
        WHERE status IN ('complete','approved')
          AND expires_at IS NOT NULL
          AND expires_at < NOW()
        RETURNING id, tenant_id, pool_entry_id
      ),
      expired_tenants AS (
        UPDATE tenants
        SET background_check_status = 'expired'
        WHERE background_check_id IN (SELECT id FROM expired_bgc)
        RETURNING id
      ),
      expired_pool AS (
        UPDATE application_pool
        SET status = 'expired'
        WHERE id IN (SELECT pool_entry_id FROM expired_bgc WHERE pool_entry_id IS NOT NULL)
          AND status IN ('available','matched')
        RETURNING id
      ),
      expired_matches AS (
        UPDATE pool_match_requests
        SET status = 'expired'
        WHERE pool_entry_id IN (SELECT id FROM expired_pool)
          AND status IN ('pending','interested')
        RETURNING id
      )
      SELECT
        (SELECT COUNT(*)::int FROM expired_bgc) AS bgc,
        (SELECT COUNT(*)::int FROM expired_tenants) AS tenants,
        (SELECT COUNT(*)::int FROM expired_pool) AS pool,
        (SELECT COUNT(*)::int FROM expired_matches) AS matches
    `)
    const r = expired[0]
    if (r && r.bgc > 0) {
      logger.info(`[BgcExpiry] ${r.bgc} check(s) expired (tenants:${r.tenants} pool:${r.pool} matches:${r.matches})`)
    }
  } catch(e) { logger.error({ err: e }, '[SCHEDULER] background check expiry') }
}

export function schedulerInit() {
  logger.info('⏰ Scheduler initialized')

  // S654: daily crons run on Phoenix time, so each fires at the same local hour
  // on any host (the API is moving to a UTC host, S641). Two exceptions, pinned
  // to UTC on purpose: payout sync (4:10 UTC) and auto-payouts (1:00 UTC), because
  // Stripe releases funds at 00:00 UTC (S617). Leave those two on UTC.

  // ── PAYMENT RECONCILIATION ──────────────────────────────────
  // S620. The ONLY path from 'processing' to 'settled' is the
  // payment_intent.succeeded webhook arriving. Miss it — endpoint down, Mac
  // mid-brownout, Stripe retries exhausted — and the payment stays
  // 'processing' forever with nothing ever looking again: the tenant has
  // paid, GAM holds the money, and the platform keeps calling them
  // delinquent while late fees accrue.
  //
  // Twice daily rather than hourly: this asks Stripe about payments already
  // 24h old, so there is nothing an hourly cadence would catch sooner, and
  // it keeps the API-call volume trivial.
  cron.schedule('0 9,21 * * *', async () => {
    try {
      await reconcileStuckPayments(getStripe())
    } catch (err) {
      logger.error({ err }, '[reconcile] payment reconciliation failed')
    }
  }, { timezone: 'America/Phoenix' })

  // ── CARD PAYMENTS NOBODY CONFIRMED (decisions.md #48.4) ─────
  // A card the tenant pay screen is confirming with its bank (3-D Secure)
  // holds the bill for at most 30 minutes (CARD_CONFIRM_HOLD_MINUTES). Every
  // five minutes, any such hold past its time is canceled in Stripe and its
  // bill opened again — so the screen's "canceled by itself" time holds even
  // when nobody looks at the bill again, and staff screens never show a hold
  // that has run out. Stripe is built only when a hold is due (most runs find
  // none). Offset to :02/:07/… so it never stacks on the other 5-minute jobs;
  // a run still going when the next is due is not started twice.
  let cardHoldSweepRunning = false
  cron.schedule('2-59/5 * * * *', async () => {
    if (cardHoldSweepRunning) return
    cardHoldSweepRunning = true
    try {
      await releaseUnconfirmedCardCharges(getStripe)
    } catch (err) {
      logger.error({ err }, '[reconcile] unconfirmed card release failed')
    } finally {
      cardHoldSweepRunning = false
    }
  })

  // ── LEASE EXPIRATION NOTICES ────────────────────────────────
  // Daily at 8am — notify landlord when lease approaches end_date
  cron.schedule('0 8 * * *', checkLeaseExpiryNotices, { timezone: 'America/Phoenix' })

  // S652 (Nic): a card-reader request must never sit unseen. Every morning,
  // one email while anything is waiting on GAM; silent otherwise.
  cron.schedule('5 8 * * *', async () => {
    try {
      const { chaseReaderOrders } = await import('../services/readerOrders')
      const r = await chaseReaderOrders()
      if (r.sent) logger.info(r, '[reader-orders] morning chase')
    } catch (e) { logger.error({ err: e }, '[reader-orders] chase failed') }
  }, { timezone: 'America/Phoenix' })

  // Utility reading runs — daily 7am Phoenix; self-gates to the last
  // business day of the month (weekends + US federal holidays walked
  // backward). Opens a run per property with readable meters and
  // prompts the landlord + property staff to start reading.
  cron.schedule('0 7 * * *', async () => {
    try {
      const { openDueReadingRuns } = await import('../services/utilityReadingRuns')
      const r = await openDueReadingRuns()
      if (r.opened > 0) logger.info(r, '[reading-runs]')
    } catch (e) {
      logger.error({ err: e }, '[reading-runs] fatal')
    }
    // S652 (Nic): tenants billed on their own date are read the business day
    // before it. Say so on that day — and keep saying it while one is overdue,
    // because a missed read holds that tenant's whole invoice.
    try {
      const { promptTenantDateMeterReads } = await import('../services/utilityReadingRuns')
      const r = await promptTenantDateMeterReads()
      if (r.prompted > 0) logger.info(r, '[tenant-date-reads]')
    } catch (e) {
      logger.error({ err: e }, '[tenant-date-reads] fatal')
    }
    // S548 (Nic): every morning — not just month-end — prompt for meter
    // reads on submetered sites whose guests pull out TODAY. The at-checkout
    // read closes the departing guest's bill same-day and baselines the
    // meter for the next arrival.
    try {
      const { promptMoveOutMeterReads } = await import('../services/utilityReadingRuns')
      const r = await promptMoveOutMeterReads()
      if (r.prompted > 0) logger.info(r, '[moveout-reads]')
    } catch (e) {
      logger.error({ err: e }, '[moveout-reads] fatal')
    }
    // S548 (Nic): dwellings + storage leases that just ended get their
    // in-person move-out walkthrough scheduled (3-business-day deadline)
    // and the assigned staff prompted — the deposit return is gated on it.
    try {
      const { scheduleMoveOutInspections } = await import('../services/moveOutInspections')
      const r = await scheduleMoveOutInspections()
      if (r.scheduled > 0) logger.info(r, '[moveout-inspections]')
    } catch (e) {
      logger.error({ err: e }, '[moveout-inspections] fatal')
    }
  }, { timezone: 'America/Phoenix' })

  // 16a Step 3: auto-payout batch. Fires Mon-Fri 9am Phoenix.
  //
  // S616: the engine no longer self-gates to Tuesday. It measures every
  // landlord's rent roll EVERY weekday, because a threshold can be crossed on
  // any of them, and schedules the payout four BUSINESS days out (S617 — Stripe
  // releases an ACH four business days out, and the calendar count this used to
  // do fired before the money existed). Tuesday still governs the
  // short-term-stay stream, PM companies, businesses, and any landlord with no
  // rent roll to measure, shifted forward over US federal holidays.
  // S617 (Nic): "an hour after the money becomes available." Stripe releases
  // funds at a hard 00:00:00 UTC boundary on the available_on date, so this
  // runs at 01:00 UTC — not 9am Phoenix, which was sixteen hours late and cost
  // the landlord most of a business day at his own bank. UTC, because that is
  // the frame available_on is expressed in and the engine now counts in it too.
  // S652 (Nic, option 1): nightly, every Connect account's payouts as Stripe
  // has them — a payout made in the Stripe dashboard shows on the landlord's
  // page by morning. Two free read calls per account.
  cron.schedule('10 4 * * *', async () => {
    try {
      const { syncConnectPayouts } = await import('../services/connectPayoutSync')
      const r = await syncConnectPayouts()
      if (r.created || r.updated) logger.info(r, '[payout-sync]')
    } catch (e) { logger.error({ err: e }, '[payout-sync] fatal') }
  }, { timezone: 'UTC' })

  cron.schedule('0 1 * * 1-5', async () => {
    // 10/5 (Nic): a space occupied after the 1st is billed for THAT month on
    // the next weeknight — first, so the payout run right after nets it
    // (jobs/platformFeeAccrual processPlatformFeeTopUp). Its own try: a failed
    // top-up is logged and the payouts still go out. This schedule (6 pm
    // Phoenix, Sunday through Thursday) is also written into
    // services/billableUnits lastTopUpOfMonthSql — change both together.
    try {
      const { processPlatformFeeTopUp } = await import('./platformFeeAccrual')
      const topUp = await processPlatformFeeTopUp()
      if (topUp.propertiesRaised || topUp.propertiesCreated
          || topUp.errors.length || topUp.tenantPayerSkipped.length) {
        logger.info(topUp, '[platform-fee-topup]')
      }
    } catch (e) {
      logger.error({ err: e }, '[platform-fee-topup] fatal')
    }
    try {
      const { processAutoPayouts } = await import('./autoPayouts')
      const result = await processAutoPayouts()
      if (result.candidatesScanned > 0 || result.errors.length > 0) {
        logger.info(result, '[auto-payouts]')
      }
      // S652 (Nic, option 1): stamp each payout with the bank it went to, and
      // pick up any the landlord made in Stripe themselves. Reads only — free.
      const { syncConnectPayouts } = await import('../services/connectPayoutSync')
      await syncConnectPayouts().catch(err => logger.error({ err }, '[payout-sync] after auto-payouts failed'))
    } catch (e) {
      logger.error({ err: e }, '[auto-payouts] fatal')
    }
  }, { timezone: 'UTC' })

  // ── S640 (Nic): THE YEARLY EMERGENCY-CONTACT CHECK ─────────────────────
  //
  //   "Maybe make a thing where we can ping tenants to update an emergency
  //    contact — maybe once a year, we make sure it's still relevant."
  //
  // Weekly, mid-morning, and deliberately quiet: it asks a household at most
  // once every ninety days and only when their contact is missing or a year
  // unconfirmed. Nothing here is urgent — a resident at the counter is a far
  // better prompt than an email, which is what the Front Desk list is for. The
  // signing reminders are the cautionary tale: 952 emails to 39 people.
  cron.schedule('0 10 * * 2', async () => {
    try {
      const { pingTenantsForEmergencyContact } = await import('./emergencyContactRefresh')
      const r = await pingTenantsForEmergencyContact()
      if (r.asked > 0) logger.info(r, '[emergency-contact-refresh]')
    } catch (e) {
      logger.error({ err: e }, '[emergency-contact-refresh] fatal')
    }
  }, { timezone: 'America/Phoenix' })

  // ── S640 (Nic): ASK CHECKR WHERE THE SCREENING IS ──────────────────────
  //
  //   "We do really need to fix whatever you were talking about with the
  //    background check. I have sent the link to a couple more people through
  //    text message today."
  //
  // Checkr finished Anastacio Erreguin's report at 15:19 Phoenix on Sep 9 and
  // GAM never heard — not one request has reached /api/background/webhook in
  // the entire log window. His screening sat at `processing` for twenty-two
  // hours until Nic decided it by hand, on a report he could not see.
  //
  // Every ten minutes, because an applicant sitting on the "under review" page
  // is the whole experience of this product, and because Checkr turned that
  // report around in about two hours — ten minutes is noise against that and
  // costs one API call per in-flight check.
  cron.schedule('*/10 * * * *', async () => {
    try {
      const { syncPendingBackgroundChecks } = await import('../services/backgroundCheckSync')
      const r = await syncPendingBackgroundChecks()
      if (r.advanced > 0 || r.errors > 0) logger.info(r, '[bgc-sync]')
    } catch (e) {
      logger.error({ err: e }, '[bgc-sync] fatal')
    }
  })

  // S616 (Nic): link a neighbor's serviced space to the unit its own landlord
  // leases, automatically. "We are gonna be linking the units on the back end
  // automatically." Daily, because either side can onboard first.
  cron.schedule('30 6 * * *', async () => {
    try {
      const { autoLinkNeighborServices } = await import('../services/crossPropertyAutoLink')
      const r = await autoLinkNeighborServices()
      if (r.linked > 0) logger.info(r, '[auto-link] neighbor services linked')
    } catch (e) {
      logger.error({ err: e }, '[auto-link] fatal')
    }
  }, { timezone: 'America/Phoenix' })

  // S561: reversal recovery. The handler decides net-vs-pull immediately when a
  // reversal opens; this daily pass is the backstop — it decides any that
  // slipped through and flips scheduled nettings past the 2-week cap to ACH
  // pulls (their anticipated influx never arrived). Daily 8am Phoenix.
  cron.schedule('0 8 * * *', async () => {
    try {
      const { processPendingReversalRecoveries, escalateStaleNetting } = await import('../services/reversalRecovery')
      const decided = await processPendingReversalRecoveries()
      const escalated = await escalateStaleNetting()
      if (decided.decided > 0 || escalated.escalated > 0) {
        logger.info({ ...decided, ...escalated }, '[reversal-recovery]')
      }
    } catch (e) {
      logger.error({ err: e }, '[reversal-recovery] fatal')
    }
  }, { timezone: 'America/Phoenix' })

  // S473: stale-route cleanup (service-business / Phase 1a.3). Daily
  // at 1:45am Phoenix — sits between the materializer (1:15am) and
  // the platform-fee accrual (1:30am 1st-only) / lease-end-processor
  // (2:00am). Hard-deletes generated_routes rows created for a date
  // more than 7 days ago and never moved past status='generated'.
  // Routes that started or completed are never touched. FK cascade
  // pulls the route_stops along with them.
  // S536: business invoicing subscription — accrue on the 1st for the
  // prior month, retry pending collections daily. 4:15am Phoenix.
  // S550 (Nic): nightly address-verification sweep — every property ends
  // up with coordinates (heat-map infrastructure) + graded verification.
  // Never-attempted rows first, weekly retry of 'unverified'.
  cron.schedule('0 4 * * *', async () => {
    try {
      const { sweepUnverifiedAddresses } = await import('../services/addressVerification')
      const r = await sweepUnverifiedAddresses()
      if (r.attempted > 0) logger.info(r, '[address-verify-sweep]')
    } catch (e) {
      logger.error({ err: e }, '[address-verify-sweep] fatal')
    }
  }, { timezone: 'America/Phoenix' })

  // S581 (Nic): apply due scheduled money changes carried by signed terms
  // addendums — a base-rent change (e.g. AZ mobile-home space rent) or a new
  // recurring charge (parking/garage). Runs early (04:30) so a change effective
  // today lands on leases.rent_amount / lease_fees BEFORE the 07:00-local invoice
  // generation picks it up that day.
  cron.schedule('30 4 * * *', async () => {
    try {
      const { applyDueScheduledChanges } = await import('../services/scheduledLeaseChanges')
      const r = await applyDueScheduledChanges()
      if (r.applied > 0 || r.cancelled > 0) logger.info(r, '[scheduled-lease-change]')
    } catch (e) {
      logger.error({ err: e }, '[scheduled-lease-change] fatal')
    }
    // S654: 04:30 Phoenix on any host, so the run time and the park-calendar
    // "today" it applies changes for (Phoenix by default) agree.
  }, { timezone: 'America/Phoenix' })

  // S582 (Nic): tenant invite nudge — remind tenants BEFORE their 7-day invite
  // lapses (reduces onboarding drop-off; the control tower alerts the landlord
  // only after it expires). 10am daily; the job self-spaces reminders per intent.
  // S641: chase unfinished bank setups. 9:30am Phoenix — late enough that
  // somebody can act on it during a working day, and once daily because the job
  // paces itself (every 72 hours, four times, then stop).
  cron.schedule('30 9 * * *', async () => {
    try {
      const { sendBankVerificationNudges } = await import('./bankVerificationNudge')
      const r = await sendBankVerificationNudges()
      if (r.sent > 0 || r.failed > 0) logger.info(r, '[bank-verify-nudge]')
    } catch (e) {
      logger.error({ err: e }, '[bank-verify-nudge] fatal')
    }
  }, { timezone: 'America/Phoenix' })

  cron.schedule('0 10 * * *', async () => {
    try {
      const { nudgeExpiringInvites } = await import('./inviteNudge')
      const r = await nudgeExpiringInvites()
      if (r.nudged > 0 || r.errors > 0) logger.info(r, '[invite-nudge]')
    } catch (e) {
      logger.error({ err: e }, '[invite-nudge] fatal')
    }
  }, { timezone: 'America/Phoenix' })

  // S628 (Nic): renewal is TENANT-FIRST — ask the tenant at 60 days, tell the
  // landlord at 32. Nothing sent that question before; it waited on a landlord
  // who had no prompt to ask it. 10:30, just after the invite nudge, so the two
  // tenant-facing daily emails do not land in the same minute.
  cron.schedule('30 10 * * *', async () => {
    try {
      const { runRenewalPings } = await import('./renewalPing')
      const r = await runRenewalPings()
      if (r.pinged > 0 || r.alerted > 0 || r.errors > 0) logger.info(r, '[renewal-ping]')
    } catch (e) {
      logger.error({ err: e }, '[renewal-ping] fatal')
    }
  }, { timezone: 'America/Phoenix' })

  // S550 (Nic): daily growth snapshot — per-(state,city) + platform totals
  // (landlords/properties/units/occupancy/rent-roll). History starts the
  // day it landed; powers growth-velocity charts + the heat map over time.
  cron.schedule('10 4 * * *', async () => {
    try {
      const { captureGrowthSnapshot } = await import('../services/growthSnapshots')
      const r = await captureGrowthSnapshot()
      logger.info(r, '[growth-snapshot]')
    } catch (e) {
      logger.error({ err: e }, '[growth-snapshot] fatal')
    }
  }, { timezone: 'America/Phoenix' })

  cron.schedule('15 4 * * *', async () => {
    try {
      const { processBusinessMonthlyFees } = await import('./businessMonthlyFees')
      const r = await processBusinessMonthlyFees()
      if (r.accrued || r.collected || r.failed) logger.info(r, '[business-fees]')
    } catch (e) { logger.error({ err: e }, '[business-fees] fatal') }
  }, { timezone: 'America/Phoenix' })

  // S568 (Nic): financed home/RV sales. Daily bill any amortized home-sale
  // installment whose billing month has arrived (a standalone type='home_payment'
  // charge that rides the platform-holds batch to the landlord/seller), then
  // reconcile — mark contracts paid off and flip the unit to tenant-owned once
  // every installment has settled. Idempotent (installment.payment_id guard);
  // daily cadence catches any month boundary regardless of property timezone.
  cron.schedule('20 4 * * *', async () => {
    try {
      const { billDueHomeSaleInstallments, reconcileAllHomeSaleContracts } = await import('../services/homeSale')
      // S654: the month on GAM's home calendar (Phoenix), not the host's clock.
      const asOf = monthStartOf(todayIn(null))
      const billed = await billDueHomeSaleInstallments(asOf)
      await reconcileAllHomeSaleContracts()
      if (billed) logger.info({ billed, asOf }, '[home-sale-billing]')
    } catch (e) { logger.error({ err: e }, '[home-sale-billing] fatal') }
    // S654: 04:20 Phoenix, so the run and its Phoenix month agree on any host.
  }, { timezone: 'America/Phoenix' })

  // S568 (Nic): investor-operator lot rent. Daily accrue this month's lot-rent
  // obligations for homes on homes-only external parks (one per unit/month,
  // idempotent) so the investor's net (tenant rent − lot rent) stays current.
  cron.schedule('25 4 * * *', async () => {
    try {
      // S605 (Nic): folded into the sublease shelf — same business case, and
      // unusable without the outside park on GAM ("everything would have to be
      // manually input... it's not worth having"). Skip while shelved.
      const { isFeatureEnabled } = await import('../services/systemFeatures')
      if (!(await isFeatureEnabled('subleasing_enabled'))) return
      const { accrueLotRentCharges } = await import('../services/lotRent')
      // S654: the month on GAM's home calendar (Phoenix), not the host's clock.
      const asOf = monthStartOf(todayIn(null))
      const accrued = await accrueLotRentCharges(asOf)
      if (accrued) logger.info({ accrued, asOf }, '[lot-rent-accrual]')
    } catch (e) { logger.error({ err: e }, '[lot-rent-accrual] fatal') }
    // S654: 04:25 Phoenix, so the run and its Phoenix month agree on any host.
  }, { timezone: 'America/Phoenix' })

  cron.schedule('45 1 * * *', async () => {
    try {
      const { processRouteCleanup } = await import('./routeCleanup')
      const result = await processRouteCleanup()
      if (result.routes_deleted > 0) {
        logger.info(result, '[route-cleanup]')
      }
    } catch (e) {
      logger.error({ err: e }, '[route-cleanup] fatal')
    }
  }, { timezone: 'America/Phoenix' })

  // S542: FlexPay demand discovery — tenants already flagged ssi_ssdi
  // with an active lease who never engaged with FlexPay get the
  // private ssi_ssdi_signal questionnaire. Idempotent (one-shot per
  // tenant); no-ops while flexpay_rollout_visible is off. 5:30am PHX.
  cron.schedule('30 5 * * *', async () => {
    try {
      const { sweepSsiSsdiQuestionnaires } = await import('../services/tenantQuestionnaires')
      await sweepSsiSsdiQuestionnaires()
    } catch (e) { logger.error({ err: e }, '[questionnaire-sweep] fatal') }
    // S546: backend-only pre-qualification — warm every file before
    // interest arrives. NEVER tenant-visible.
    try {
      const { sweepFlexpayPrequal } = await import('../services/flexpayAutoVerify')
      await sweepFlexpayPrequal()
    } catch (e) { logger.error({ err: e }, '[flexpay-prequal] fatal') }
  }, { timezone: 'America/Phoenix' })

  // S542b: FlexPay queue follow-up vigilance (Nic: "reaching out, and
  // then following up"). Daily summary alert when pending inquiries
  // are aging past 7 days without review — the queue is first come,
  // first serve, so a stale head blocks everyone behind it.
  cron.schedule('45 5 * * *', async () => {
    try {
      const { queryOne } = await import('../db')
      const aging = await queryOne<{ n: string; oldest_days: string }>(
        `SELECT COUNT(*)::text AS n,
                COALESCE(MAX(EXTRACT(DAY FROM NOW() - created_at))::int, 0)::text AS oldest_days
           FROM flexpay_inquiries
          WHERE status = 'pending' AND created_at < NOW() - INTERVAL '7 days'`)
      if (aging && Number(aging.n) > 0) {
        const { createAdminNotification } = await import('../services/adminNotifications')
        await createAdminNotification({
          severity: 'warn',
          category: 'flexpay_queue_aging',
          title: `FlexPay queue: ${aging.n} request(s) pending > 7 days`,
          body: `Oldest has waited ${aging.oldest_days} days. The queue orders by float need (shortest first) — review the head of the queue in Admin → FlexPay Requests.`,
          context: { pending_over_7d: Number(aging.n), oldest_days: Number(aging.oldest_days) },
        })
      }
    } catch (e) { logger.error({ err: e }, '[flexpay-queue-aging] fatal') }
  }, { timezone: 'America/Phoenix' })

  // Route auto-advance (service-business). Every minute: walk every
  // in_progress route and auto-complete stops whose timer has elapsed
  // (planned drive leg + 1 min after the previous stop finalized).
  // Drivers don't tap a per-stop button — this is what marks stops
  // done; their only manual action is Skip. Idempotent; future stops
  // wait. When a route's stops are all finalized, the route completes.
  cron.schedule('* * * * *', async () => {
    try {
      const { processRouteAutoAdvance } = await import('./routeAutoAdvance')
      const result = await processRouteAutoAdvance()
      if (result.stops_completed > 0 || result.routes_completed > 0) {
        logger.info(result, '[route-auto-advance]')
      }
    } catch (e) {
      logger.error({ err: e }, '[route-auto-advance] fatal')
    }
  }, { timezone: 'America/Phoenix' })

  // S517: public booking holds + waitlist claims. Every minute — expire
  // abandoned tentative deposit holds (frees the calendar) + stale 1-hour
  // waitlist claims, then promote the next eligible waitlister for any unit
  // a cancellation/expiry just freed. Idempotent.
  cron.schedule('* * * * *', async () => {
    try {
      const { sweepBookingHoldsAndClaims } = await import('../services/propertyBooking')
      const r = await sweepBookingHoldsAndClaims()
      if (r.holdsExpired > 0 || r.claimsExpired > 0 || r.promoted > 0) {
        logger.info(r, '[booking-sweep]')
      }
    } catch (e) {
      logger.error({ err: e }, '[booking-sweep] fatal')
    }
  })

  // S517: flip scheduled service-interruption notices to 'active' once their
  // start time arrives (every 5 min). Resolution stays manual — see
  // services/serviceInterruptions.ts for why we don't auto-resolve.
  cron.schedule('*/5 * * * *', async () => {
    try {
      const { activateDueServiceInterruptions } = await import('../services/serviceInterruptions')
      const r = await activateDueServiceInterruptions()
      if (r.activated > 0) logger.info(r, '[service-interruption-activate]')
    } catch (e) {
      logger.error({ err: e }, '[service-interruption-activate] fatal')
    }
  })

  // S553: sales-call reminders — every 15 min, emails prospects whose
  // Portfolio Specialist call starts within ~1h. Idempotent (reminded_at).
  cron.schedule('*/15 * * * *', async () => {
    try {
      const { sendDueCallReminders } = await import('../services/salesCalls')
      const r = await sendDueCallReminders()
      if (r.sent > 0) logger.info(r, '[sales-call-reminders]')
    } catch (e) {
      logger.error({ err: e }, '[sales-call-reminders] fatal')
    }
  })

  // S468: recurring-schedule materializer (service-business / Phase 1a.2).
  // Daily at 1:15am Phoenix — sits between manager-fee accrual (1am 1st)
  // and platform-fee accrual (1:30am 1st); on non-monthly days it has the
  // window to itself. Walks every active recurring_schedules row and
  // inserts the next 60 days of appointments. Idempotent via partial
  // UNIQUE (recurring_schedule_id, scheduled_for) WHERE recurring_schedule_id
  // IS NOT NULL — re-runs are no-ops. Owners can also trigger materialization
  // on-demand via POST /api/recurring-schedules/:id/materialize (S461) for
  // immediate visibility after editing a schedule.
  cron.schedule('15 1 * * *', async () => {
    try {
      const { materializeAllSchedules } = await import('../services/recurringScheduleMaterializer')
      const result = await materializeAllSchedules()
      if (result.schedules_scanned > 0 || result.errors > 0) {
        logger.info(result, '[recurring-schedule-materializer]')
      }
    } catch (e) {
      logger.error({ err: e }, '[recurring-schedule-materializer] fatal')
    }
  }, { timezone: 'America/Phoenix' })

  // S518: business appointment reminders. Hourly — emails the customer
  // once when their appointment enters the next-24h window (reminder_sent_at
  // one-shot guard). Cuts no-shows for appointment-based businesses.
  cron.schedule('5 * * * *', async () => {
    try {
      const { sendAppointmentReminders } = await import('../services/appointmentReminders')
      await sendAppointmentReminders()
    } catch (e) {
      logger.error({ err: e }, '[appointment-reminders] fatal')
    }
  }, { timezone: 'America/Phoenix' })

  // S69: monthly manager-fee accrual. Fires 1st of each month at 1am Phoenix.
  // Posts allocation_manager_fee ledger entries for properties with
  // flat_monthly_fee or per_unit_fee configured. Idempotent per (property, month).
  cron.schedule('0 1 1 * *', async () => {
    try {
      const { processMonthlyFeeAccrual } = await import('./monthlyFeeAccrual')
      const result = await processMonthlyFeeAccrual()
      logger.info(result, '[monthly-fee-accrual]')
    } catch (e) {
      logger.error({ err: e }, '[monthly-fee-accrual] fatal')
    }
  }, { timezone: 'America/Phoenix' })

  // S624 — expire tenant deposit reports the bank never confirmed. Daily,
  // 3:40am Phoenix, after the overnight bank syncs have had their chance to
  // produce the matching row.
  cron.schedule('40 3 * * *', async () => {
    try {
      const { sweepExpiredDeclarations } = await import('./declaredDepositExpiry')
      const result = await sweepExpiredDeclarations()
      logger.info(result, '[declared-deposit-expiry]')
    } catch (e) {
      logger.error({ err: e }, '[declared-deposit-expiry] fatal')
    }
  }, { timezone: 'America/Phoenix' })

  // S624 — WORK-TRADE MONTH CLOSE. 1st of the month, 2:15am Phoenix.
  //
  // Deliberately AFTER invoice generation and the fee accruals: it settles the
  // month that just ENDED, using hours logged during it, against the invoice
  // that issued at the start of it. Running it before those would settle a month
  // whose late-arriving approvals had not landed yet.
  //
  // Nic (S623): "when you're working, those hours should be covering the month
  // that you're gonna be staying." That is only expressible once the month is
  // over — September's hours do not exist on September 1st — which is why this
  // is a job and not part of billing.
  //
  // S648 (Nic): tenants due on another day settle the day after each of their
  // own periods ends — so this now fires DAILY. The calendar close still runs
  // only on the 1st, unchanged.
  cron.schedule('15 2 * * *', async () => {
    const now = DateTime.now().setZone('America/Phoenix')
    const { runWorkTradeSettlement, runDueWorkTradeSettlements } = await import('./workTradeSettlement')
    if (now.day === 1) {
      try {
        const closed = now.minus({ months: 1 }).startOf('month').toISODate()!
        const result = await runWorkTradeSettlement(closed)
        logger.info({ ...result, period: closed }, '[work-trade-settlement]')
      } catch (e) {
        logger.error({ err: e }, '[work-trade-settlement] fatal')
      }
    }
    try {
      const result = await runDueWorkTradeSettlements(now.toISODate()!)
      if (result.agreementsProcessed > 0 || result.errors.length > 0) {
        logger.info(result, '[work-trade-settlement:due-date]')
      }
    } catch (e) {
      logger.error({ err: e }, '[work-trade-settlement:due-date] fatal')
    }
  }, { timezone: 'America/Phoenix' })

  // S649 (Nic): the rest of a short stay goes out on arrival day. Hourly, so
  // each property's arrival day starts in its own time zone; the booking row
  // is claimed first, so a stay is only ever billed once.
  cron.schedule('5 * * * *', async () => {
    try {
      const { billStayBalances } = await import('../services/stayBalance')
      const r = await billStayBalances()
      if (r.billed || r.failed) logger.info(r, '[stay-balance]')
    } catch (e) {
      logger.error({ err: e }, '[stay-balance] fatal')
    }
  })

  // Step 9 review (fix pass 2): a move-out balance charge saved on its row but
  // never confirmed (Stripe could not be reached at finalize) is finished here —
  // confirmed with its own key (never a second charge), left to the webhook
  // when its money is moving, or let go so the balance is payable again.
  // Hourly; safe to run again. Without it the row stayed 'processing' for good:
  // the tenant could not pay it and the landlord could not record it.
  cron.schedule('35 * * * *', async () => {
    try {
      const { finishPendingGapCharges } = await import('../services/depositReturn')
      const r = await finishPendingGapCharges()
      if (r.checked > 0 || r.errors.length > 0) logger.info(r, '[deposit-return-gap-finisher]')
    } catch (e) {
      logger.error({ err: e }, '[deposit-return-gap-finisher] fatal')
    }
  })

  // Fix pass (rev8, decisions #47a: a deposit refund GAM holds goes back BY
  // ITSELF when the move-out is finalized): a card or bank refund part left
  // "sending" (a crash between finalize and Stripe, or Stripe's answer lost)
  // is sent again here every 15 minutes — the same runner and key, so a
  // refund Stripe already made is found and recorded, never sent twice —
  // instead of waiting for someone to open the move-out page. Offset to
  // :04/:19/:34/:49 so it never stacks on the quarter-hour jobs; a run still
  // going when the next is due is not started twice. Never throws.
  let staleDepositRefundsRunning = false
  cron.schedule('4-59/15 * * * *', async () => {
    if (staleDepositRefundsRunning) return
    staleDepositRefundsRunning = true
    try {
      const { resumeStaleDepositRefunds } = await import('../services/depositRefundSend')
      const n = await resumeStaleDepositRefunds()
      if (n > 0) logger.info({ moveOuts: n }, '[deposit-refund-sweep] resumed refunds left sending')
    } catch (e) {
      logger.error({ err: e }, '[deposit-refund-sweep] fatal')
    } finally {
      staleDepositRefundsRunning = false
    }
  })

  // S650 (Nic): "I want it synced up with the margin so far, the real numbers
  // that have actually happened... we can still true up as more payments are
  // made." So it runs EVERY day over the current month and the one before it,
  // recomputing rather than stacking — the books track reality as it lands
  // instead of waiting for the month to close.
  cron.schedule('0 6 * * *', async () => {
    try {
      const { trueUpProcessingMargin } = await import('../services/platformRevenue')
      // S654: this month and last on GAM's home calendar (Phoenix), not UTC's.
      const thisMonth = monthStartOf(todayIn(null))
      for (const month of [thisMonth, monthStartOf(addDaysTo(thisMonth, -1))]) {
        const r = await trueUpProcessingMargin(month)
        if (r.adjustment !== 0) logger.info(r, '[processing-margin-true-up]')
      }
    } catch (e) {
      logger.error({ err: e }, '[processing-margin-true-up] fatal')
    }
  }, { timezone: 'America/Phoenix' })

  // S650 (Nic): "we only move the money that was paid to us" — a second daily
  // pass at any landlord batch still waiting on GAM's Stripe balance, so a
  // missed 01:00 UTC payout run cannot cost a landlord another whole day.
  cron.schedule('0 8 * * *', async () => {
    try {
      const { recoverPendingPlatformTransfers } = await import('../services/landlordPassthrough')
      const r = await recoverPendingPlatformTransfers()
      if (r.recovered || r.stillPending) logger.info(r, '[passthrough-recovery]')
    } catch (e) {
      logger.error({ err: e }, '[passthrough-recovery] fatal')
    }
  }, { timezone: 'America/Phoenix' })

  // S651: mirror the mail provider's suppression list. An address it has given
  // up on produces no event of any kind, so without this a send to a dead
  // address is indistinguishable from a delivered one — thirteen emails to one
  // tenant vanished that way before anyone noticed.
  cron.schedule('35 4 * * *', async () => {
    try {
      const { syncEmailSuppressions } = await import('../services/emailSuppressions')
      const r = await syncEmailSuppressions()
      if (r.added || r.removed) logger.warn(r, '[email-suppressions] list changed')
    } catch (e) {
      logger.error({ err: e }, '[email-suppressions] sync failed')
    }
  }, { timezone: 'America/Phoenix' })

  // S651: a park with no coordinates is invisible to every renter searching
  // nearby, and creation only ever tries to geocode once. Retry the stragglers
  // nightly, and shout about any that keep refusing to resolve.
  cron.schedule('50 3 * * *', async () => {
    try {
      const { backfillPropertyCoordinates } = await import('./geocodeBackfill')
      const r = await backfillPropertyCoordinates()
      if (r.missing) logger.info({ missing: r.missing, placed: r.placed }, '[geocode-backfill]')
    } catch (e) {
      logger.error({ err: e }, '[geocode-backfill] fatal')
    }
  }, { timezone: 'America/Phoenix' })

  // S652 (Nic): the standing rule that suspends a portal, run by nobody.
  // "I don't want it flipped by a person... choice creates the opportunity for
  // discrimination. We need to have a standing company rule and a sweep."
  //
  // Runs AFTER the 08:30 debit sweep on purpose: anybody who linked a bank
  // overnight has already been collected from by the time this looks, so the
  // rule can never suspend somebody GAM could have charged that morning.
  cron.schedule('0 9 * * *', async () => {
    try {
      const { runPortalLockSweep } = await import('../services/portalLockSweep')
      const r = await runPortalLockSweep()
      if (r.locked || r.warned || r.released) logger.warn(r, '[portal-lock] sweep')
    } catch (e) {
      logger.error({ err: e }, '[portal-lock] sweep failed')
    }
  }, { timezone: 'America/Phoenix' })

  // S652 (Nic): "immediately reach out to people when there's a problem."
  // A landlord GAM cannot collect from is a silent problem — the fee accrues,
  // the sweep finds no bank, and nothing reaches the one person who can fix it.
  // Runs BEFORE the debit sweep so somebody who links a bank that morning is
  // collected from the same day rather than chased first.
  cron.schedule('0 8 * * *', async () => {
    try {
      const { noticeUncollectableLandlords } = await import('../services/gamCollections')
      const r = await noticeUncollectableLandlords()
      if (r.notified) logger.warn(r, '[gam-collections] uncollectable notices sent')
    } catch (e) {
      logger.error({ err: e }, '[gam-collections] notice sweep failed')
    }
  }, { timezone: 'America/Phoenix' })

  // S651: the last-resort bank pull, deliberately scheduled 30 minutes AFTER
  // the passthrough recovery above. Netting gets every chance first — that is
  // the whole order of preference Nic set out — so by the time this runs,
  // anything collectable from money already moving has been collected, and
  // what is left is a landlord whose tenants all pay cash.
  //
  // Does nothing on a normal night: it looks at every landlord who owes GAM
  // anything, and pulls only from the ones over their threshold. There is no
  // opt-in — a landlord does not get to decline paying for the park GAM runs,
  // and a switch here would make an all-cash park free.
  cron.schedule('30 8 * * *', async () => {
    try {
      const { runGamDebitSweep } = await import('../services/landlordGamDebit')
      const r = await runGamDebitSweep()
      if (r.debited) logger.warn(r, '[gam-debit-sweep] pulled fees from a bank')
      else if (r.considered) logger.info(r, '[gam-debit-sweep]')
    } catch (e) {
      logger.error({ err: e }, '[gam-debit-sweep] fatal')
    }
  }, { timezone: 'America/Phoenix' })

  // S650 (Nic): held utilities nobody claimed by the time a property's
  // onboarding window closes are presumed settled off-platform.
  cron.schedule('40 3 * * *', async () => {
    try {
      const { expireHeldChargesAfterOnboarding } = await import('../services/utilityBilling')
      const r = await expireHeldChargesAfterOnboarding()
      if (r.closed) logger.info(r, '[held-utility-expiry]')
    } catch (e) {
      logger.error({ err: e }, '[held-utility-expiry] fatal')
    }
  }, { timezone: 'America/Phoenix' })

  // S648: every cent GAM takes must be recorded against someone, and nobody
  // should owe GAM back for long without it being seen.
  cron.schedule('45 3 * * *', async () => {
    try {
      const { runHeldReconcile } = await import('../services/heldReconcile')
      const r = await runHeldReconcile()
      if (r.unrecorded || r.floated) logger.warn(r, '[held-reconcile]')
    } catch (e) {
      logger.error({ err: e }, '[held-reconcile] fatal')
    }
  }, { timezone: 'America/Phoenix' })

  // S120: per-occupied-unit + per-property-min platform fee accrual.
  // Fires 1st of each month at 1:30am Phoenix (just after the manager
  // fee accrual at 1am, so we don't compete for advisory locks). Posts
  // platform_fee_subscription entries to platform_revenue_ledger for
  // landlord-payer properties; tenant-payer properties get only the
  // accrual row, picked up by the rent-charge code later.
  cron.schedule('30 1 1 * *', async () => {
    try {
      const { processPlatformFeeAccrual, processScreeningFeeSweep } = await import('./platformFeeAccrual')
      const result = await processPlatformFeeAccrual()
      logger.info(result, '[platform-fee-accrual]')
      // S552: sweep unbilled screening accruals ($5 compliance fees +
      // capped-state shortfalls) into platform revenue in the same run.
      const sweep = await processScreeningFeeSweep()
      logger.info(sweep, '[screening-fee-sweep]')
      // S652: the month's piece of any card reader on a plan.
      const { raiseDueInstallments } = await import('../services/readerOrders')
      logger.info({ raised: await raiseDueInstallments() }, '[reader-installments]')
    } catch (e) {
      logger.error({ err: e }, '[platform-fee-accrual] fatal')
    }
  }, { timezone: 'America/Phoenix' })

  // S600: no-double-bill onboarding grace — daily cap sweep. Runs 1:15am Phoenix,
  // just BEFORE the monthly platform-fee accrual (1:30am on the 1st), so a landlord
  // whose grace cap month has arrived is flipped to billing in time for that month's
  // accrual. Cheap no-op on non-cap days (only un-activated rows past their cap move).
  // First settled rent (webhooks.ts) activates earlier and this sweep skips them.
  cron.schedule('15 1 * * *', async () => {
    try {
      const { applyBillingGraceCaps } = await import('./platformFeeAccrual')
      const flipped = await applyBillingGraceCaps()
      if (flipped > 0) logger.info({ flipped }, '[billing-grace-cap] landlords flipped to billing')
    } catch (e) {
      logger.error({ err: e }, '[billing-grace-cap] fatal')
    }
  }, { timezone: 'America/Phoenix' })

  // S567: portfolio-manager commission accrual. Fires 1st of each month at
  // 1:45am Phoenix (after platform-fee accrual at 1:30). Writes commission_
  // accruals rows per occupied unit — 25¢ closing + 25¢ service to the closing
  // agent (or a CS specialist / the pot when self-closed) + 10¢ always to the
  // pot. Idempotent per (landlord, month, role).
  cron.schedule('45 1 1 * *', async () => {
    try {
      const { processCommissionAccrual } = await import('./commissionAccrual')
      const result = await processCommissionAccrual()
      logger.info(result, '[commission-accrual]')
    } catch (e) {
      logger.error({ err: e }, '[commission-accrual] fatal')
    }
  }, { timezone: 'America/Phoenix' })

  // S598: customer-service 24h assignment SLA. Hourly — any landlord that needs
  // its own CS specialist (self-closed) and is still unassigned >24h after signup
  // is auto-assigned to the owner (the default/sole CS rep today) so the mandatory
  // CS commission always has a payee. A future claim/round-robin layer slots in
  // ahead of this backstop.
  cron.schedule('20 * * * *', async () => {
    try {
      const { processCsAssignmentSla } = await import('./csAssignmentSla')
      const r = await processCsAssignmentSla()
      if (r.assigned > 0) logger.info(r, '[cs-sla]')
    } catch (e) {
      logger.error({ err: e }, '[cs-sla] fatal')
    }
  }, { timezone: 'America/Phoenix' })

  // S605: bank-feed sync. Stripe backfills a newly linked account
  // asynchronously ("refresh is still pending"), so the first sync usually
  // returns nothing — without this the landlord would have to keep pressing
  // Sync themselves.
  //
  // S617 (Nic): hourly -> every six hours, on the quarters. This calls
  // financialConnections.accounts.refresh once per ACTIVE CONNECTION per run,
  // so the cost is linear in connected accounts: hourly was 720 calls a month
  // each, and at thousands of Connect accounts that is bandwidth spent to
  // re-learn a number that changes daily at best. Nic: "reducing bandwidth at
  // scale when we have thousands of connect accounts might save some computer
  // space."
  //
  // Four a day is still well inside what the feature needs — the sync exists so
  // a landlord does not have to press Sync, not to be a live balance ticker,
  // and any screen that wants it fresher can refresh that one connection on
  // demand. Nic flagged one possible reason the old rate existed: the business
  // portal wanting a card payment to reach a business user within a day. That
  // path does not read this cron (business money lands on their own Connect at
  // charge time), so it is not a reason to keep hourly — but if a future
  // business-portal flow ever does depend on feed freshness, raise it for THAT
  // connection rather than putting every landlord back on hourly.
  cron.schedule('0 0,6,12,18 * * *', async () => {
    try {
      const { syncAllActiveConnections } = await import('../services/bankFeed')
      const r = await syncAllActiveConnections()
      if (r.inserted > 0) logger.info(r, '[bank-feed-sync]')
    } catch (e) {
      logger.error({ err: e }, '[bank-feed-sync] fatal')
    }
  }, { timezone: 'America/Phoenix' })

  // S642 (Nic): "I want to see our margin on that too." Pulls what Stripe
  // actually charged GAM so margin is a figure the platform holds rather than
  // one somebody has to go ask Stripe for. Idempotent on Stripe's own
  // transaction id, and the lookback overlaps deliberately — a cost that posts
  // late is picked up on the next run rather than lost.
  cron.schedule('20 5 * * *', async () => {
    try {
      const { syncStripeCosts } = await import('../services/stripeCosts')
      const r = await syncStripeCosts({ lookbackDays: 10 })
      if (r.stored > 0) logger.info(r, '[stripe-costs]')
    } catch (e) {
      logger.error({ err: e }, '[stripe-costs] fatal')
    }
  }, { timezone: 'America/Phoenix' })

  // S642 (Nic): "Calculate interest, have it be paid out as credit where
  // applicable." Deposit interest accrued monthly since S604 and was only ever
  // paid at MOVE-OUT. Eight states require it paid annually while the tenancy
  // continues — AZ, IL, MA, NJ, NM, OH, PA, RI — so a tenant three years into a
  // lease was owed money the platform had calculated and never handed over.
  //
  // Daily rather than yearly, because it pays on each tenancy's OWN
  // anniversary: a deposit becomes due the day its oldest unpaid month turns
  // twelve. A once-a-year run would make most tenants wait up to eleven extra
  // months, and would put every payout on one day. Almost every run does
  // nothing, which is the point.
  //
  // 6am Phoenix — before the invoice generator at 7, so a credit issued today
  // lands on today's bill rather than next month's.
  cron.schedule('0 6 * * *', async () => {
    try {
      const { payAnnualDepositInterest } = await import('../services/depositInterestPayout')
      const r = await payAnnualDepositInterest()
      if (r.paid > 0 || r.errors > 0) logger.info(r, '[deposit-interest]')
    } catch (e) {
      logger.error({ err: e }, '[deposit-interest] fatal')
    }
  }, { timezone: 'America/Phoenix' })

  // ── S642: THE BALANCE REFRESH IS ITS OWN JOB, ON BANKING DAYS ─────────────
  //
  // Nic: "Change it to once a day and only Monday through Friday excluding
  // banking holidays. There's no reason their real bank would even update on
  // banking holidays or weekends, so let's match that."
  //
  // Every Financial Connections balance refresh is billable, and this used to
  // ride along with the transaction sync above — four times a day, every day.
  // August's bill for ONE linked account was $9.30 of balance refreshes against
  // $0.30 for the transaction subscription the feature actually exists for.
  //
  // 4x daily = 1,460 calls per account per year. Once per banking day = ~251.
  // An 83% cut that costs nothing observable: the number was never fresher than
  // the bank's own posting schedule, and a landlord who wants it now still has
  // the per-connection refresh on the page.
  //
  // 7am Phoenix — after overnight ACH posting, before anyone opens the books.
  // The holiday test reuses the payout engine's calendar rather than inventing
  // a second one, so "is the bank open" has ONE answer platform-wide.
  cron.schedule('0 7 * * 1-5', async () => {
    try {
      const { isUsFederalHoliday } = await import('@gam/shared')
      const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Phoenix' })
      if (isUsFederalHoliday(today)) {
        logger.info({ today }, '[bank-balance-refresh] banks are shut, skipping')
        return
      }
      const { refreshAllBalances } = await import('../services/bankFeed')
      const r = await refreshAllBalances()
      logger.info({ ...r, today }, '[bank-balance-refresh]')
    } catch (e) {
      logger.error({ err: e }, '[bank-balance-refresh] fatal')
    }
  }, { timezone: 'America/Phoenix' })

  // S605 (Nic): retry lease drafts still waiting. Saving a template as the
  // unit-type default fires drafting immediately — this is the backstop for
  // everything else. Nic: "on the off chance that something does fail, what
  // initiates the retry?" Without it, a draft that failed for a transient
  // reason sat unresolved until the landlord happened to re-save a template.
  //
  // Hourly: a lease drafting an hour after the invite is invisible to the
  // landlord (it still waits for their signature either way), and the query is
  // indexed on unresolved rows so a settled queue is nearly free.
  cron.schedule('25 * * * *', async () => {
    try {
      const { draftAllPendingLeases } = await import('../services/householdLeaseDraft')
      const r = await draftAllPendingLeases()
      if (r.drafted > 0) logger.info(r, '[lease-draft-retry]')
    } catch (e) {
      logger.error({ err: e }, '[lease-draft-retry] fatal')
    }
  }, { timezone: 'America/Phoenix' })

  // S605: vendor + own-stack health. Every 15 min, alerting into
  // admin_notifications only on a TRANSITION into trouble — Nic asked for
  // notification in the admin portal rather than having to visit four vendor
  // dashboards to discover something broke.
  cron.schedule('*/15 * * * *', async () => {
    try {
      const { runPlatformHealthCheck } = await import('../services/platformHealth')
      const r = await runPlatformHealthCheck()
      if (r.alerted.length > 0) logger.warn(r, '[platform-health]')
    } catch (e) {
      logger.error({ err: e }, '[platform-health] fatal')
    }
  }, { timezone: 'America/Phoenix' })

  // S605: post-signup onboarding-call outreach for self-signed-up landlords.
  // Every 15 min so the note lands close to the intended ~90-minute mark rather
  // than up to an hour late. The job itself owns the delay, the organic-only
  // filter, and the business-hours gate — this is just the tick.
  cron.schedule('*/15 * * * *', async () => {
    try {
      const { sendLandlordWelcomeOutreach } = await import('./landlordWelcomeOutreach')
      const r = await sendLandlordWelcomeOutreach()
      if (r.sent > 0 || r.errors > 0) logger.info(r, '[landlord-outreach]')
    } catch (e) {
      logger.error({ err: e }, '[landlord-outreach] fatal')
    }
  }, { timezone: 'America/Phoenix' })

  // S199: end-of-term sublease auto-termination. Fires daily at 2:30am
  // Phoenix to flip active subleases to terminated when their end_date
  // has passed. Emits sublease_completed_natural credit-ledger event
  // (distinct from the early-termination flow which fires
  // sublease_terminated_early at PATCH time). Best-effort
  // notifications to all three parties via notifySubleaseTerminated.
  cron.schedule('30 2 * * *', async () => {
    try {
      const { processSubleaseEndOfTerm } = await import('./subleaseEndOfTerm')
      const result = await processSubleaseEndOfTerm()
      if (result.terminated_count > 0) {
        logger.info(result, '[sublease-end-of-term]')
      }
    } catch (e) {
      logger.error({ err: e }, '[sublease-end-of-term] fatal')
    }
  }, { timezone: 'America/Phoenix' })

  // S552: stale screening sweep. Daily 2:40am Phoenix — checks stuck in
  // awaiting_applicant past BGC_STALE_DAYS (default 30; the applicant
  // never finished Checkr's apply flow) are cancelled and the applicant
  // refunded in full (MN et al. require refunds when no screening runs).
  cron.schedule('40 2 * * *', async () => {
    try {
      const { sweepStaleBackgroundChecks } = await import('../services/backgroundRefund')
      const result = await sweepStaleBackgroundChecks()
      if (result.swept > 0) {
        logger.info(result, '[bgc-stale-sweep]')
      }
    } catch (e) {
      logger.error({ err: e }, '[bgc-stale-sweep] fatal')
    }
  }, { timezone: 'America/Phoenix' })

  // S188: deposit interest accrual. Fires 1st of each month at 3am
  // Phoenix to accrue the just-completed previous month for every
  // funded deposit in escrow whose state has a hardcoded statutory
  // rate. Idempotent via UNIQUE(security_deposit_id, accrual_month).
  // Per CLAUDE.md S177 carve-out: hard-regulatory accommodation, not
  // landlord-configurable.
  cron.schedule('0 3 1 * *', async () => {
    try {
      const { runPreviousMonthAccrual } = await import('../services/depositInterest')
      const result = await runPreviousMonthAccrual()
      logger.info(result, '[deposit-interest-accrual]')
    } catch (e) {
      logger.error({ err: e }, '[deposit-interest-accrual] fatal')
    }
  }, { timezone: 'America/Phoenix' })

  // S133: monthly compliance archive. Fires 1st of each month at 2am
  // Phoenix (after the fee accruals). Moves rows older than 24 months
  // out of the hot compliance/audit tables into <table>_archive
  // siblings. Pre-launch volume is near zero; the cron is in place
  // so it accrues quietly as data ages rather than needing a
  // backfill later.
  cron.schedule('0 2 1 * *', async () => {
    try {
      const { processComplianceArchive } = await import('./complianceArchive')
      const result = await processComplianceArchive()
      logger.info(result, '[compliance-archive]')
    } catch (e) {
      logger.error({ err: e }, '[compliance-archive] fatal')
    }
  }, { timezone: 'America/Phoenix' })

  // S479: state-law KB refresh-burden surfacer. Weekly on Sundays at
  // 5am Phoenix — right after the credit Merkle anchor (4am Sun) in
  // the low-contention Sunday morning window. Walks the LATEST
  // provision per (state, topic), surfaces an admin notification when
  // any row's source_date is older than 90 days. Idempotent via the
  // existing-unack check inside the job (no double-firing while the
  // refresh burden hasn't been touched).
  cron.schedule('0 5 * * 0', async () => {
    try {
      const { processStateLawRefreshCheck } = await import('./stateLawRefreshCheck')
      const result = await processStateLawRefreshCheck()
      if (result.stale_provision_count > 0) {
        logger.info(result, '[state-law-refresh-check]')
      }
    } catch (e) {
      logger.error({ err: e }, '[state-law-refresh-check] fatal')
    }
  }, { timezone: 'America/Phoenix' })

  // Credit ledger weekly Merkle anchor. Sundays at 4am Phoenix —
  // very low contention window, well outside the daily processors
  // and the monthly accruals/archive. One row per week into
  // credit_merkle_anchors; empty-ledger weeks skip the insert
  // (FK requires earliest/latest event ids).
  cron.schedule('0 4 * * 0', async () => {
    try {
      const { processCreditMerkleAnchor } = await import('./creditMerkleAnchor')
      const result = await processCreditMerkleAnchor()
      if (result.anchored) {
        logger.info(result, '[credit-merkle-anchor]')
      }
    } catch (e) {
      logger.error({ err: e }, '[credit-merkle-anchor] fatal')
    }
  }, { timezone: 'America/Phoenix' })

  // Credit ledger nightly recompute. 3am Phoenix — sits between
  // lease-ends (2am) and background-check expiry (3am same minute on
  // a different table set, no contention). Recomputes scores for
  // every subject with active events and refreshes the stats panel.
  cron.schedule('0 3 * * *', async () => {
    try {
      const { processCreditNightly } = await import('./creditNightly')
      const result = await processCreditNightly()
      logger.info(result, '[credit-nightly]')
    } catch (e) {
      logger.error({ err: e }, '[credit-nightly] fatal')
    }
  }, { timezone: 'America/Phoenix' })

  // Agent interaction-log content retention. Scrubs verbatim TENANT
  // content (message/reply/tool results) older than the retention window
  // (default 1yr) while keeping the metric columns for reporting. Landlord
  // content is kept indefinitely. 3:45am Phoenix — after credit-nightly.
  cron.schedule('45 3 * * *', async () => {
    try {
      const { scrubExpiredTenantContent } = await import('../services/agents/retention')
      const scrubbed = await scrubExpiredTenantContent()
      if (scrubbed > 0) logger.info({ scrubbed }, '[agent-retention] scrubbed tenant content')
    } catch (e) {
      logger.error({ err: e }, '[agent-retention] fatal')
    }
  }, { timezone: 'America/Phoenix' })

  // Maintenance credit detectors: recurring_repair_same_issue +
  // habitability_complaint_unresolved_30d. 2:30am Phoenix — between
  // lease-ends (2am) and credit-nightly (3am), so any events emitted
  // here flow into the same nightly score recompute.
  cron.schedule('30 2 * * *', async () => {
    try {
      const { processMaintenanceCreditDetectors } = await import('./maintenanceCreditDetectors')
      const result = await processMaintenanceCreditDetectors()
      if (result.recurring_emitted > 0 || result.habitability_emitted > 0 || result.errors > 0) {
        logger.info(result, '[maint-credit-detector]')
      }
    } catch (e) {
      logger.error({ err: e }, '[maint-credit-detector] fatal')
    }
  }, { timezone: 'America/Phoenix' })

  // Lease lifecycle credit detectors: lease_anniversary +
  // multi_landlord_history_clean. 2:45am Phoenix.
  cron.schedule('45 2 * * *', async () => {
    try {
      const { processLeaseLifecycleCreditDetectors } = await import('./leaseLifecycleCreditDetectors')
      const result = await processLeaseLifecycleCreditDetectors()
      if (
        result.anniversaries_emitted > 0 ||
        result.multi_landlord_emitted > 0 ||
        result.errors > 0
      ) {
        logger.info(result, '[lease-lifecycle-credit]')
      }
    } catch (e) {
      logger.error({ err: e }, '[lease-lifecycle-credit] fatal')
    }
  }, { timezone: 'America/Phoenix' })

  // Recurring-violation detector. 2:35am Phoenix — between maintenance
  // detectors (2:30am) and lease-lifecycle (2:45am).
  cron.schedule('35 2 * * *', async () => {
    try {
      const { processRecurringViolationDetector } = await import('./recurringViolationDetector')
      const result = await processRecurringViolationDetector()
      if (result.emitted > 0 || result.errors > 0) {
        logger.info(result, '[recurring-violation-detector]')
      }
    } catch (e) {
      logger.error({ err: e }, '[recurring-violation-detector] fatal')
    }
  }, { timezone: 'America/Phoenix' })

  // Balance credit detectors: tenancy_ended_with_balance + balance_paid_post_move.
  // 2:50am Phoenix.
  cron.schedule('50 2 * * *', async () => {
    try {
      const { processBalanceCreditDetectors } = await import('./balanceCreditDetectors')
      const result = await processBalanceCreditDetectors()
      if (
        result.tenancy_ended_with_balance_emitted > 0 ||
        result.balance_paid_post_move_emitted > 0 ||
        result.errors > 0
      ) {
        logger.info(result, '[balance-credit-detector]')
      }
    } catch (e) {
      logger.error({ err: e }, '[balance-credit-detector] fatal')
    }
  }, { timezone: 'America/Phoenix' })

  // OTP rent advance — daily tick at 3pm Phoenix; runs the
  // monthly advance only when today is the last business day of
  // the month. Gated by system_features.otp_rollout_visible inside
  // the service (no-op while OTP is hidden; kept for re-enable).
  cron.schedule('0 15 * * *', async () => {
    try {
      const { isLastBusinessDayOfMonth, processMonthlyAdvance } = await import('../services/otp')
      // S654: Phoenix's calendar day.
      if (!isLastBusinessDayOfMonth(todayIn(null))) return
      const result = await processMonthlyAdvance()
      logger.info(result, '[otp-advance]')
    } catch (e) {
      logger.error({ err: e }, '[otp-advance] fatal')
    }
  }, { timezone: 'America/Phoenix' })

  // S655 (Nic 10/2): FlexPay covers the whole monthly bill — daily at 3am
  // Phoenix. For every FlexPay tenant whose cycle invoice reaches its LAST
  // GRACE DAY today (invoice due + grace − 1, the property's calendar), the
  // bill's open landlord lines are paid from GAM's float, before the late-fee
  // engine's midnight run. A month already paid still makes an advance for the
  // $25. A bill this run missed (the server was down that morning, or the run
  // failed for that tenant — an admin is alerted the same day) is caught up by
  // the next runs for FLEXPAY_COVER_CATCHUP_DAYS days, flagged to an admin as
  // late. Gated by system_features.flexpay_rollout_visible inside the service.
  cron.schedule('0 3 * * *', async () => {
    try {
      const { coverFlexPayCycle } = await import('../services/flexpay')
      const result = await coverFlexPayCycle()
      if (result.candidates_scanned > 0) {
        logger.info(result, '[flexpay-cover]')
      }
    } catch (e) {
      logger.error({ err: e }, '[flexpay-cover] fatal')
      // The whole run failed: no FlexPay bill was paid today, and the late-fee
      // run comes at midnight. Best effort — the database may be the cause.
      try {
        const { createAdminNotification } = await import('../services/adminNotifications')
        await createAdminNotification({
          severity: 'critical',
          category: 'flexpay_cover_run_failed',
          title:    'The FlexPay daily run failed — no bill was paid today',
          body:     `The 3 am FlexPay run stopped before paying anything: ${e instanceof Error ? e.message : String(e)}. ` +
                    'Bills whose last grace day is today get the landlord\'s late fee at midnight unless the cause is fixed and the run is made today. ' +
                    'The next runs catch up missed bills for a few days.',
          context:  {},
        })
      } catch (alertErr) {
        logger.error({ err: alertErr }, '[flexpay-cover] could not alert an admin')
      }
    }
  }, { timezone: 'America/Phoenix' })

  // S655: FlexPay pull — daily at 5am Phoenix. Collects every covered cycle
  // whose pull_date has come (never the 1st-5th): the pull row is written
  // first, Stripe is searched before any create, and a missed day is caught up
  // the next run.
  cron.schedule('0 5 * * *', async () => {
    try {
      const { processFlexPayPullDay } = await import('../services/flexpay')
      const result = await processFlexPayPullDay()
      if (result.candidates_scanned > 0) {
        logger.info(result, '[flexpay-pull]')
      }
    } catch (e) {
      logger.error({ err: e }, '[flexpay-pull] fatal')
    }
  }, { timezone: 'America/Phoenix' })

  // S246: FlexDeposit installment cron — daily at 6am Phoenix.
  // Pulls installments 2..N from tenants whose due_date <= today.
  cron.schedule('0 6 * * *', async () => {
    try {
      const { processFlexDepositInstallmentDue } = await import('../services/flexDeposit')
      const result = await processFlexDepositInstallmentDue()
      if (result.candidates_scanned > 0) {
        logger.info(result, '[flexdeposit-installment]')
      }
    } catch (e) {
      logger.error({ err: e }, '[flexdeposit-installment] fatal')
    }
  }, { timezone: 'America/Phoenix' })

  // S246: FlexDeposit custody fee — monthly on the 1st at 7am
  // Phoenix. $3 charge per active FlexDeposit-enrolled tenant.
  // Idempotent via UNIQUE (cycle_month, tenant_id).
  cron.schedule('0 7 1 * *', async () => {
    try {
      const { processFlexDepositCustodyFee } = await import('../services/flexDeposit')
      const result = await processFlexDepositCustodyFee()
      logger.info(result, '[flexdeposit-custody]')
    } catch (e) {
      logger.error({ err: e }, '[flexdeposit-custody] fatal')
    }
  }, { timezone: 'America/Phoenix' })

  // S565: FlexCredit reporting fee — monthly on the 1st at 7:05am Phoenix.
  // $5 charge per credit_reporting_enrolled tenant. Idempotent via
  // UNIQUE (cycle_month, tenant_id). No-ops while flexcredit_rollout_visible
  // is OFF (no tenant can be enrolled), so it's dormant until launch.
  cron.schedule('5 7 1 * *', async () => {
    try {
      const { processFlexCreditFee } = await import('../services/flexCredit')
      const result = await processFlexCreditFee()
      logger.info(result, '[flexcredit-fee]')
    } catch (e) {
      logger.error({ err: e }, '[flexcredit-fee] fatal')
    }
  }, { timezone: 'America/Phoenix' })

  // S254: FlexCharge statement generation — 1st of each month at
  // noon Phoenix. Walks every active account and cuts the prior
  // month's statement (idempotent — UNIQUE on cycle_month catches
  // re-runs). Accounts with no pending tx skip cleanly.
  cron.schedule('0 12 1 * *', async () => {
    try {
      const { processFlexChargeStatementGeneration } = await import('../services/flexCharge')
      const result = await processFlexChargeStatementGeneration()
      logger.info(result, '[flexcharge-stmt-gen]')
    } catch (e) {
      logger.error({ err: e }, '[flexcharge-stmt-gen] fatal')
    }
  }, { timezone: 'America/Phoenix' })

  // S253: FlexCharge statement billing — daily 8am Phoenix tick.
  // Walks open statements where due_date <= today (i.e., from the
  // 15th of each month onward; statements generated mid-cycle catch
  // up on the next tick). ACH-pulls total_due from customer's
  // verified bank, flips statement to 'billed'. Webhook
  // reconciliation flips 'paid' + fires merchant Transfer.
  cron.schedule('0 8 * * *', async () => {
    try {
      const { processFlexChargeStatementBilling } = await import('../services/flexCharge')
      const result = await processFlexChargeStatementBilling()
      if (result.scanned > 0) {
        logger.info(result, '[flexcharge-stmt-bill]')
      }
    } catch (e) {
      logger.error({ err: e }, '[flexcharge-stmt-bill] fatal')
    }
  }, { timezone: 'America/Phoenix' })

  // Operational nudges: inspection scheduled-for reminders +
  // entry-request stale auto-cancel. Hourly so reminders land
  // close to the 24h-out boundary regardless of the tenant's
  // local time, and stale requests don't sit in pending status
  // past their window end for long.
  cron.schedule('15 * * * *', async () => {
    try {
      const { processOperationalNudges } = await import('./operationalNudges')
      const result = await processOperationalNudges()
      if (
        result.inspection_reminders_sent > 0 ||
        result.entry_requests_auto_cancelled > 0 ||
        result.errors > 0
      ) {
        logger.info(result, '[operational-nudges]')
      }
    } catch (e) {
      logger.error({ err: e }, '[operational-nudges] fatal')
    }
  })
  // Background check 6-month freshness expiry. 3 AM daily, low-contention window.
  cron.schedule('0 3 * * *', processBackgroundCheckExpiry, { timezone: 'America/Phoenix' })

  // S565: nightly economic-nexus tally. 3:20am, after the 3am low-contention
  // jobs. Sums GAM's own revenue by customer state (current + prior calendar
  // year) → nexus_revenue_tally, feeding the admin nexus dashboard. Monitoring
  // only — never collects tax.
  cron.schedule('20 3 * * *', async () => {
    try {
      const { recomputeNexusTally } = await import('../services/nexusMonitor')
      const { rows } = await recomputeNexusTally()
      logger.info(`[SCHEDULER] nexus tally recomputed — ${rows} state-year rows`)
    } catch (e) { logger.error({ err: e }, '[SCHEDULER] nexus tally') }
  }, { timezone: 'America/Phoenix' })

  // ── LEASE END PROCESSOR ─────────────────────────────────────
  // Daily at 2am — activate signed pending leases whose start date arrived
  // (W-7 renewals), THEN process leases that hit end_date.
  cron.schedule('0 2 * * *', async () => {
    await activatePendingLeases()
    await processLeaseEnds()
  }, { timezone: 'America/Phoenix' })

  // ── LOW STOCK CHECK ─────────────────────────────────────────
  // Daily at 9am — notify landlords of low-stock POS items
  cron.schedule('0 9 * * *', checkLowStock, { timezone: 'America/Phoenix' })

  // W-46: same 9am slot — business-supplies low stock + equipment
  // service-due reminders (both land on /inventory)
  cron.schedule('0 9 * * *', checkPartsLowStock, { timezone: 'America/Phoenix' })
  cron.schedule('0 9 * * *', checkServiceDue, { timezone: 'America/Phoenix' })

  // W-20 (S531): schedule self-compression — nightly at 3:30am (after the
  // 2am lease-end processor so handoffs/expiries settle first). The site
  // reveal runs every 15 minutes and fires 1 HOUR BEFORE each unit's
  // check-in time (property-timezone aware).
  cron.schedule('30 3 * * *', async () => {
    try {
      const { compressAllSchedules } = await import('../services/scheduleCompression')
      const moved = await compressAllSchedules()
      if (moved > 0) logger.info(`[compress] nightly pass moved ${moved} booking(s)`)
      // S649: stays the pack couldn't move off an out-of-order site
      const { alertStaysOnOutOfOrderSites } = await import('../services/outOfOrder')
      const { query: q } = await import('../db')
      for (const p of await q<{ property_id: string }>(
        `SELECT DISTINCT u.property_id FROM unit_out_of_order o JOIN units u ON u.id = o.unit_id WHERE o.cleared_at IS NULL`)) {
        await alertStaysOnOutOfOrderSites(p.property_id)
      }
    } catch (e) { logger.error({ err: e }, '[SCHEDULER] schedule compression') }
  }, { timezone: 'America/Phoenix' })
  cron.schedule('*/15 * * * *', revealTodaysSites)

  // W-44 (S531): hourly private-event sweep — announce paid events,
  // auto-release unpaid ones at start time.
  cron.schedule('15 * * * *', processTenantEvents)

  // S103/S104/S121: daily 4am Phoenix prune + reconciliation block. Sits
  // between the 3:30am POS EOD and the 7am invoice-gen runs — light load,
  // no overlap with other jobs. Each handler is independently
  // failure-isolated (its own try/catch), so one going sideways doesn't
  // block the rest.
  cron.schedule('0 4 * * *', async () => {
    await pruneEmailSendLog()
    await pruneOperationalLogs()
    try {
      const { reconcilePmTransfers } = await import('./pmTransferReconciliation')
      const r = await reconcilePmTransfers()
      if (r.stale_groups_scanned > 0) {
        logger.info(r, '[pm-transfer-recon]')
      }
    } catch (e) {
      logger.error({ err: e }, '[pm-transfer-recon] fatal')
    }

    // S113-Phase1: parallel reconciliation pass for in-house manager
    // fee Transfers. Same cadence as the PM pass — both target unfired
    // user_balance_ledger rows older than 1 hour.
    try {
      const { reconcileManagerTransfers } = await import('./managerTransferReconciliation')
      const r = await reconcileManagerTransfers()
      if (r.stale_groups_scanned > 0) {
        logger.info(r, '[manager-transfer-recon]')
      }
    } catch (e) {
      logger.error({ err: e }, '[manager-transfer-recon] fatal')
    }

    // S124: ACH retry firing — walks payments where next_retry_at is due
    // and re-confirms the PaymentIntent. NACHA permits up to 2 retries;
    // retry_count CHECK enforces the cap. Errors logged, not thrown.
    try {
      const { processAchRetries } = await import('../services/achRetry')
      const r = await processAchRetries()
      if (r.fired > 0) {
        logger.info(r, '[ach-retry]')
      }
    } catch (e) {
      logger.error({ err: e }, '[ach-retry] fatal')
    }
  }, { timezone: 'America/Phoenix' })

  // ── POS END-OF-DAY (S95) ────────────────────────────────────
  // Daily at 3:30am Phoenix — auto-close yesterday's books for every
  // landlord that had POS activity. Cashiers can manually close earlier
  // via POST /api/pos/eod/close (with drawer count); the cron is the
  // safety net so every active day gets a settlement row even if the
  // cashier forgets the manual close. Idempotent via UNIQUE
  // (landlord_id, business_day) — re-run is safe.
  cron.schedule('30 3 * * *', async () => {
    try {
      const { generateEodForAllActiveLandlords } = await import('../services/posEod')
      // Yesterday in Phoenix-local — compute via the DB so we don't
      // mismatch the engine's day-window math.
      const yesterday = await queryOne<{ d: string }>(
        `SELECT to_char((NOW() AT TIME ZONE 'America/Phoenix')::date - 1, 'YYYY-MM-DD') AS d`
      )
      if (!yesterday) return
      const results = await generateEodForAllActiveLandlords(yesterday.d)
      if (results.length > 0) {
        logger.info(`[pos-eod] auto-closed ${results.length} landlord-day(s) for ${yesterday.d}`)
      }
    } catch (e) {
      logger.error({ err: e }, '[pos-eod] fatal')
    }
  }, { timezone: 'America/Phoenix' })

  // S86: removed three stub crons whose bodies were pure console.log:
  //
  //   - 28th-of-month rent collection (TODO: Stripe ACH pulls). Tenant ACH
  //     pulls run via FlexPay tier scheduling now; the legacy 28th-bulk
  //     cron has no engine. Rebuild when the tenant-side rent-collection
  //     orchestration lands (separate from FlexPay).
  //
  //   - Reserve fund contribution (TODO: calculate prior-month net). The
  //     reserve_fund_state table exists but the contribution math is part
  //     of the post-launch chargeback-coverage subsystem (16a flagged as
  //     a separate concern). No engine consumes the table today.
  //
  // None of the three did real work; deleting them removes scheduler
  // noise without losing functionality.

  // ── LATE PAYMENT DETECTION ──────────────────────────────────
  // Run daily at 7am Phoenix — detect failed/missing ACH pulls. S654: pinned
  // to Phoenix; unpinned it ran at the host's 7am (midnight Phoenix on UTC).
  cron.schedule('0 7 * * *', async () => {
    try {
      // Rent due 5+ days ago that hasn't settled. S654: these rows only mark
      // units delinquent now; the morning email reads the Outstanding list.
      const overdue = await query<any>(`
        SELECT p.*, u.unit_number, u.id AS unit_id,
          t.id AS tenant_id, t.ssi_ssdi,
          tu.email AS tenant_email, tu.first_name AS tenant_first,
          tu.last_name AS tenant_last,
          ul.email AS landlord_email,
          COALESCE(l.business_name, ul.first_name || ' ' || ul.last_name) AS landlord_name,
          pr.name AS property_name
        FROM payments p
        JOIN units u ON u.id = p.unit_id
        JOIN properties pr ON pr.id = u.property_id
        JOIN tenants t ON t.id = p.tenant_id
        JOIN users tu ON tu.id = t.user_id
        JOIN landlords l ON l.id = p.landlord_id
        JOIN users ul ON ul.id = l.user_id
        WHERE p.type = 'rent'
          AND p.status IN ('pending','failed')
          AND p.due_date <= NOW() - INTERVAL '5 days'
          AND u.payment_block = FALSE
          -- ── S638 (Nic): WORK TRADE IS NOT LATE ────────────────────────────
          --
          --   "It shouldn't be emailing the landlord about work trade people."
          --
          -- A suspended row settles at month close against approved hours, not
          -- in cash. Nothing about it is overdue, yet this job read it as unpaid
          -- rent: it emailed Nic a late alert about HIMSELF on his own MH 02
          -- work-trade unit at 7am, marked the unit delinquent, and bumped the
          -- resident's late-payment count — every single morning.
          AND p.work_trade_suspended_at IS NULL
      `)

      for (const payment of overdue) {
        // S652 (Nic): the "late payments" number is no longer kept here. This
        // added one every MORNING a balance stayed open, so thirty days late
        // read as thirty late payments. It now derives from the credit ledger,
        // which records each charge once, at settlement, with its due date,
        // paid date and grace — the same events the score reads.

        // Mark unit delinquent
        await query(
          `UPDATE units SET status = 'delinquent' WHERE id = $1 AND status = 'active'`,
          [payment.unit_id]
        )
      }

      // S652 (Nic): "The landlord doesn't need one email per person that's
      // outstanding... I don't need 15 emails." S654: the email now reads the
      // Outstanding list — every overdue dollar (rent, utilities, fees), one
      // line per person, one email per account. The rent rows above only drive
      // the unit's delinquent status. Its own try/catch, so a mail failure never
      // stops the delinquency clear below.
      try {
        const d = await runLateBalanceDigest()
        if (d.sent > 0 || d.failed > 0) logger.info(d, '[late-balance-digest]')
      } catch (e) { logger.error({ err: e }, '[late-balance-digest] fatal') }

      // ── S638 (Nic): DELINQUENCY HAS TO BE ABLE TO END ─────────────────────
      //
      //   "The current unit overview list shows several people being delinquent
      //    that are not delinquent... It also has the work trade people as
      //    delinquent."
      //
      // One line above flips a unit to 'delinquent' and, until now, nothing
      // anywhere flipped it back — so a unit marked once stayed marked however
      // much the resident paid. Thirteen units were showing delinquent, four of
      // them work-trade households who owe nothing at all and never did.
      //
      // Cleared here, in the same pass that sets it, against the same
      // definition of owed: a genuine cash charge, past due, not suspended, not
      // covered by a credit. If it is not owed, the unit is not delinquent.
      const cleared = await query<{ id: string }>(`
        UPDATE units u SET status = 'active', updated_at = NOW()
         WHERE u.status = 'delinquent'
           AND NOT EXISTS (
             SELECT 1 FROM payments p
              WHERE p.unit_id = u.id
                AND p.type = 'rent'
                AND p.status IN ('pending','failed')
                AND p.work_trade_suspended_at IS NULL
                AND p.due_date <= NOW() - INTERVAL '5 days')
        RETURNING u.id`)
      if (cleared.length > 0) {
        logger.info(`[Scheduler] ${cleared.length} unit(s) no longer delinquent`)
      }

      if (overdue.length > 0) {
        logger.info(`[Scheduler] ${overdue.length} overdue payment(s) processed`)
      }
    } catch (e) { logger.error({ err: e }, '[Scheduler] Late payment detection error') }
  }, { timezone: 'America/Phoenix' })

  // S86: removed two more stub crons —
  //
  //   - FlexDeposit installment pulls. The TODO never initiated the ACH
  //     pull but the surrounding UPDATE incremented installments_paid +
  //     collected_amount, granting credit without ever moving money.
  //     Restore as part of FlexDeposit rebuild (Stage-2 Flex Suite).
  //
  //   - Utility billing 15th-of-month cron (TODO body, pure log). The
  //     utility_bills table is phantom (DEFERRED Item 10). Rebuild as
  //     part of the utility billing subsystem.
  //
  // FlexPay daily pull and FlexCharge daily pull were also removed —
  // FlexPay marked rent rows 'processing' without an actual ACH; FlexCharge
  // queried the phantom flex_charge_accounts table and would have thrown.
  // Both rebuild as part of Stage-2 Flex Suite.

  // ── NACHA RETURN MONITORING ─────────────────────────────────
  // Run daily at 8am — check return rates, alert if approaching threshold
  cron.schedule('0 8 * * *', async () => {
    try {
      const [stats] = await query<any>(`
        SELECT
          COUNT(*) FILTER (WHERE status = 'returned') AS returns,
          COUNT(*) FILTER (WHERE type = 'rent' AND created_at > NOW() - INTERVAL '30 days') AS total,
          COUNT(*) FILTER (WHERE zero_tolerance_flag = TRUE AND created_at > NOW() - INTERVAL '30 days') AS zero_tolerance
        FROM payments
        WHERE type = 'rent'
          AND created_at > NOW() - INTERVAL '30 days'
      `)
      const returnRate = stats.total > 0 ? (stats.returns / stats.total) : 0
      if (returnRate > 0.03) {
        logger.warn({ return_rate: returnRate }, '[NACHA ALERT] return rate exceeds 3% threshold')
      }
      if (stats.zero_tolerance > 0) {
        logger.error({ zero_tolerance_count: stats.zero_tolerance }, '[NACHA ZERO-TOLERANCE] zero-tolerance returns this month — manual review required')
      }
    } catch (e) { logger.error({ err: e }, '[Scheduler] NACHA monitoring error') }
  }, { timezone: 'America/Phoenix' })


  // S86: FlexPay + FlexCharge pull crons removed — see deletion-rationale
  // comment further up. Rebuild with Stage-2 Flex Suite.

  // ── INVITATION EXPIRY ───────────────────────────────────────
  // Hourly at :10 — expire pending invitations past 24h TTL
  cron.schedule('10 * * * *', processInvitationExpiry)

  // S29 item 4: e-sign reminders (2h) + auto-void (24h). Every 15 min.
  cron.schedule('*/15 * * * *', processEsignTimeouts)

  // Run every hour — flip scheduled-activation units to active once due
  cron.schedule('5 * * * *', async () => {
    try {
      const due = await query<any>(`
        SELECT id, unit_number, scheduled_activation_at
        FROM units
        WHERE scheduled_activation_at IS NOT NULL
          AND scheduled_activation_at <= NOW()
          AND status <> 'active'
        LIMIT 500
      `)
      for (const u of due) {
        await query(`
          UPDATE units
          SET status='active', scheduled_activation_at=NULL, scheduled_activation_by=NULL, updated_at=NOW()
          WHERE id=$1
        `, [u.id])
        logger.info(`[ActivationScheduler] Activated unit ${u.unit_number} (${u.id}) — scheduled for ${u.scheduled_activation_at}`)
      }
      if ((due as any[]).length > 0) {
        logger.info(`[ActivationScheduler] ${(due as any[]).length} unit(s) activated this hour`)
      }
    } catch (e) { logger.error({ err: e }, '[Scheduler] Activation scheduler error') }
  })

  registerInvoiceEngine()
  // S615: the same 7am-local slot, so a landlord's next-door utility bills go
  // out the same morning their tenants' invoices do.
  registerServiceAgreementInvoiceEngine()
  registerLateFeeEngine()
  registerAutopayEngine()
  registerRefreshCron()
  // initial population — async, will populate per-tz crons on next tick
  refreshTimezoneCrons().then(({ added }) => {
    const sum = tzCronSummary()
    for (const [engineId, info] of Object.entries(sum)) {
      logger.info({ engine_id: engineId, tz_count: info.tzCount, label: info.label }, `   ✓ ${info.label.padEnd(22)} ${info.tzCount} timezone(s) registered (S26b-tz)`)
    }
  }).catch((e: unknown) => logger.error({ err: e }, '[Scheduler] Initial tz cron refresh error'))

    logger.info('   ✓ Recurring materializer: Daily 1:15am Phoenix (service-business / Phase 1a)')
    logger.info('   ✓ Route cleanup:        Daily 1:45am Phoenix (stale unstarted routes, 7-day retention)')
    logger.info('   ✓ State-law refresh:    Weekly Sun 5am Phoenix (admin notif when source_date > 90 days)')
    logger.info('   ✓ Lease expiry notices: Daily 8am (per lease expiration_notice_days)')
  logger.info('   ✓ Lease end processor:  Daily 2am (auto-renew or expire)')
  logger.info('   ✓ Low stock check:      Daily 9am')
  logger.info('   ✓ POS EOD auto-close:   Daily 3:30am Phoenix')
  logger.info('   ✓ Late detection:       Daily 7am')
  logger.info('   ✓ NACHA monitoring:     Daily 8am')
  logger.info('   ✓ Unit activations:     Hourly at :05')
  logger.info('   ✓ Invitation expiry:    Hourly at :10')
  logger.info('   ✓ Tz refresh:           Daily 3am UTC')
  logger.info('   ✓ Recurring invoices:   Daily 9:30am Phoenix\n')

  // S505: business-portal recurring invoice generation. Daily at
  // 9:30am Phoenix (after the auto-payouts cron at 9am to avoid CPU
  // contention with the heavier payout sweep). Sweeps active
  // schedules whose next_due_date has arrived and generates one
  // invoice each; auto-send flag is honored per-schedule.
  cron.schedule('30 9 * * *', async () => {
    try {
      const { generateAllDueRecurringInvoices } = await import('../services/recurringInvoiceGeneration')
      const r = await generateAllDueRecurringInvoices()
      if (r.processed > 0 || r.failed > 0) {
        logger.info(`[recurring] processed=${r.processed} failed=${r.failed}`)
      }
    } catch (e) {
      logger.error({ err: e }, '[recurring-cron] sweep crashed')
    }
  }, { timezone: 'America/Phoenix' })
}


// === S26a: invoice generation ===
// Daily 1am Phoenix-local (08:00 UTC). Idempotent via ux_invoices_lease_due_date.
// Generates an invoice per active lease for each missed/current cycle due date,
// with rent + monthly_ongoing fee children. Catch-up window: 30 days.

import cron from 'node-cron'
import { notifyLeaseExpiring, notifyLowStock } from '../services/notifications'
import {
  emailSigningReminder, emailDocumentAutoVoided,
  sendLatePaymentNotice, sendOnTimePayInvitation,
} from '../services/email'
import { query, queryOne } from '../db'
import { cascadeLeaseTenantsOnVoid } from '../lib/leaseDocCascade'
import { generateInvoices, registerInvoiceEngine } from './invoiceGeneration'
import { registerLateFeeEngine } from './lateFees'
import { registerRefreshCron, refreshTimezoneCrons, summary as tzCronSummary } from './timezoneCronManager'
import { expireStaleInvitations as expireStalePmPropertyInvitations } from '../services/pm'
import { getPropertyResponsibleParty } from '../services/responsibleParty'
import { logger } from '../lib/logger'

// ============================================================
// GAM PAYMENT SCHEDULER
// All cron jobs that power the On-Time Pay SLA
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
export async function processLeaseEnds() {
  try {
    const ended = await query<any>(`
      SELECT l.*, un.id as unit_id_ref
      FROM leases l
      JOIN units un ON un.id = l.unit_id
      WHERE l.status = 'active'
        AND l.end_date IS NOT NULL
        AND l.end_date <= CURRENT_DATE
    `)
    for (const lease of ended) {
      if (lease.auto_renew && lease.auto_renew_mode === 'extend_same_term') {
        // Original term length in days
        const termDays = await queryOne<any>(`
          SELECT (end_date - start_date)::int as days FROM leases WHERE id=$1
        `, [lease.id])
        const days = termDays?.days || 365
        await query(`
          UPDATE leases
          SET end_date = end_date + ($1 || ' days')::interval,
              expiration_notice_sent_at = NULL
          WHERE id = $2
        `, [days, lease.id])
        logger.info(`[LeaseEnd] Extended lease ${lease.id} by ${days} days (auto_renew: extend_same_term)`)

        // Credit ledger: lease_renewed for every active tenant + landlord.
        try {
          await emitLeaseLifecycleEvent('renewed', lease.id, lease.landlord_id)
        } catch (e) {
          logger.error({ err: e }, '[LeaseEnd][credit-emit] renewed')
        }
      } else if (lease.auto_renew && lease.auto_renew_mode === 'convert_to_month_to_month') {
        await query(`
          UPDATE leases
          SET lease_type = 'month_to_month',
              end_date = NULL,
              expiration_notice_sent_at = NULL,
              auto_renew = false,
              auto_renew_mode = NULL
          WHERE id = $1
        `, [lease.id])
        logger.info(`[LeaseEnd] Converted lease ${lease.id} to month-to-month (auto_renew: convert)`)
      } else {
        // No auto-renew: expire the lease, cascade to lease_tenants, vacate the unit
        await query(`UPDATE leases SET status='expired', terminated_at=NOW() WHERE id=$1`, [lease.id])
        await query(`
          UPDATE lease_tenants
          SET status='removed', removed_at=NOW(), removed_reason='lease_ended', updated_at=NOW()
          WHERE lease_id=$1 AND status IN ('active','pending_add','pending_remove')
        `, [lease.id])
        await query(`UPDATE units SET status='vacant', updated_at=NOW() WHERE id=$1`, [lease.unit_id])
        logger.info(`[LeaseEnd] Expired lease ${lease.id}, vacated unit ${lease.unit_id}`)

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
// Every 15 min: 2h reminder (one-shot per signer) + 24h auto-void.
// Reminder anchor is invite_sent_at (per-signer), so when the cascade
// flips the next signer to 'sent', their 2h clock resets correctly.
// Auto-void uses cascade-first ordering for idempotent re-runs:
// pending_add/pending_remove cleanup is a no-op once already updated,
// so a partial failure is safely re-tried on the next cycle.
async function processEsignTimeouts() {
  try {
    // Pass 1: reminders
    const remind = await query<any>(`
      SELECT s.id, s.email, s.name,
             d.id as doc_id, d.title, d.landlord_id,
             u.unit_number, p.name as property_name,
             lu.first_name || ' ' || lu.last_name as landlord_name
      FROM lease_document_signers s
      JOIN lease_documents d ON d.id = s.document_id
      LEFT JOIN units u ON u.id = d.unit_id
      LEFT JOIN properties p ON p.id = u.property_id
      JOIN landlords la ON la.id = d.landlord_id
      JOIN users lu ON lu.id = la.user_id
      WHERE s.status IN ('sent','viewed')
        AND s.reminder_sent_at IS NULL
        AND s.invite_sent_at IS NOT NULL
        AND s.invite_sent_at < NOW() - INTERVAL '2 hours'
        AND d.status NOT IN ('completed','voided','execution_failed')
    `)
    for (const r of remind as any[]) {
      try {
        const unitLabel = r.unit_number ? `Unit ${r.unit_number} — ${r.property_name}` : r.title
        const signingUrl = `${process.env.TENANT_APP_URL || 'http://localhost:3002'}/sign/${r.doc_id}`
        await emailSigningReminder(r.email, r.name, r.title, unitLabel, r.landlord_name, signingUrl, { landlordId: r.landlord_id, documentId: r.doc_id })
        await query(`UPDATE lease_document_signers SET reminder_sent_at=NOW() WHERE id=$1`, [r.id])
      } catch(e) {
        logger.error({ err: e, signer_id: r.id }, '[ESIGN-TIMEOUTS] reminder failed for signer')
      }
    }
    if ((remind as any[]).length > 0) {
      logger.info(`[ESIGN-TIMEOUTS] sent ${(remind as any[]).length} reminder(s)`)
    }

    // Pass 2: auto-void
    const expired = await query<any>(`
      SELECT d.id, d.title, d.document_type, d.landlord_id,
             u.unit_number, p.name as property_name
      FROM lease_documents d
      LEFT JOIN units u ON u.id = d.unit_id
      LEFT JOIN properties p ON p.id = u.property_id
      WHERE d.status='sent'
        AND d.sent_at IS NOT NULL
        AND d.sent_at < NOW() - INTERVAL '24 hours'
    `)
    for (const d of expired as any[]) {
      try {
        await cascadeLeaseTenantsOnVoid(query, d)
        await query(`UPDATE lease_documents SET status='voided', voided_at=NOW(), void_reason=$1, updated_at=NOW() WHERE id=$2`,
          ['auto-voided: signers did not respond within 24 hours', d.id])

        const unitLabel = d.unit_number ? `Unit ${d.unit_number} — ${d.property_name}` : d.title
        const recipients = await query<any>(`
          SELECT email, name FROM lease_document_signers WHERE document_id=$1
          UNION ALL
          SELECT lu.email, (lu.first_name || ' ' || lu.last_name) as name
          FROM landlords la JOIN users lu ON lu.id = la.user_id WHERE la.id=$2
        `, [d.id, d.landlord_id])
        for (const rcp of recipients as any[]) {
          try {
            await emailDocumentAutoVoided(rcp.email, rcp.name, d.title, unitLabel, { landlordId: d.landlord_id, documentId: d.id })
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
  } catch(e) { logger.error({ err: e }, '[SCHEDULER] esign timeouts') }
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

// ── EMAIL_SEND_LOG PRUNE ────────────────────────────────────
// S103: daily prune of email_send_log. Sent rows decay after 90 days
// (the operational use case is recent failure surfacing; sent rows
// past 90d carry minimal value and inflate the table indefinitely).
// Failed rows survive 365 days — adverse-action / FCRA-adjacent
// failures should outlive any reasonable audit window.
//
// Defensive cap of 10k deletes per status per run keeps a runaway
// backlog from pinning the table; subsequent daily runs catch up.
// In steady state each run deletes whatever crossed the threshold
// on the previous day — typically tens to low hundreds of rows.
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
// bulletin_reveal_log, ach_monitoring_log) are deliberately NOT
// included — those need explicit retention policy from Nic, not a
// default.
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

// ── BACKGROUND CHECK EXPIRY (6-month freshness window) ──────
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

  // ── LEASE EXPIRATION NOTICES ────────────────────────────────
  // Daily at 8am — notify landlord when lease approaches end_date
  cron.schedule('0 8 * * *', checkLeaseExpiryNotices)

  // 16a Step 3: auto-Friday payout queue. Fires Mon-Fri 9am Phoenix; engine
  // self-gates to only run on the auto-payout day (Friday, shifted forward
  // over US federal holidays).
  cron.schedule('0 9 * * 1-5', async () => {
    try {
      const { processAutoPayouts } = await import('./autoPayouts')
      const result = await processAutoPayouts()
      if (result.candidatesScanned > 0 || result.errors.length > 0) {
        logger.info(result, '[auto-payouts]')
      }
    } catch (e) {
      logger.error({ err: e }, '[auto-payouts] fatal')
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

  // S120: per-occupied-unit + per-property-min platform fee accrual.
  // Fires 1st of each month at 1:30am Phoenix (just after the manager
  // fee accrual at 1am, so we don't compete for advisory locks). Posts
  // platform_fee_subscription entries to platform_revenue_ledger for
  // landlord-payer properties; tenant-payer properties get only the
  // accrual row, picked up by the rent-charge code later.
  cron.schedule('30 1 1 * *', async () => {
    try {
      const { processPlatformFeeAccrual } = await import('./platformFeeAccrual')
      const result = await processPlatformFeeAccrual()
      logger.info(result, '[platform-fee-accrual]')
    } catch (e) {
      logger.error({ err: e }, '[platform-fee-accrual] fatal')
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
  // the month (so ACH initiated today clears in landlord's bank
  // by the 1st). Gated by system_features.otp_rollout_visible
  // inside the service; safe to leave in scheduler permanently.
  cron.schedule('0 15 * * *', async () => {
    try {
      const { isLastBusinessDayOfMonth, processMonthlyAdvance } = await import('../services/otp')
      if (!isLastBusinessDayOfMonth(new Date())) return
      const result = await processMonthlyAdvance()
      logger.info(result, '[otp-advance]')
    } catch (e) {
      logger.error({ err: e }, '[otp-advance] fatal')
    }
  }, { timezone: 'America/Phoenix' })

  // S245: FlexPay grace-period-end advance — daily at 3am Phoenix.
  // Fronts rent to landlord on the day rent_due_day + grace_days
  // matches today's day-of-month. Suppressed automatically when OTP
  // already advanced this cycle (no double-front). Gated by
  // system_features.flexpay_rollout_visible inside the service.
  cron.schedule('0 3 * * *', async () => {
    try {
      const { processGracePeriodAdvance } = await import('../services/flexpay')
      const result = await processGracePeriodAdvance()
      if (result.candidates_scanned > 0) {
        logger.info(result, '[flexpay-front]')
      }
    } catch (e) {
      logger.error({ err: e }, '[flexpay-front] fatal')
    }
  }, { timezone: 'America/Phoenix' })

  // S245: FlexPay tenant pull — daily at 5am Phoenix. Initiates the
  // tenant ACH pull (rent + fee) for every flexpay_advances row
  // whose pull_day matches today and whose grace-end advance has
  // already settled.
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
  cron.schedule('0 3 * * *', processBackgroundCheckExpiry)

  // ── LEASE END PROCESSOR ─────────────────────────────────────
  // Daily at 2am — process leases that hit end_date (auto-renew or expire)
  cron.schedule('0 2 * * *', processLeaseEnds)

  // ── LOW STOCK CHECK ─────────────────────────────────────────
  // Daily at 9am — notify landlords of low-stock POS items
  cron.schedule('0 9 * * *', checkLowStock)

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
  //   - On-Time Pay disbursement SLA (TODO: disburse from reserve). OTP
  //     enablement is DEFERRED Item 16 batch 3+. Re-add when SetupIntent
  //     enrollment + Stripe Connect payout flow are wired together.
  //
  //   - Reserve fund contribution (TODO: calculate prior-month net). The
  //     reserve_fund_state table exists but the contribution math is part
  //     of the post-launch chargeback-coverage subsystem (16a flagged as
  //     a separate concern). No engine consumes the table today.
  //
  // None of the three did real work; deleting them removes scheduler
  // noise without losing functionality.

  // ── LATE PAYMENT DETECTION ──────────────────────────────────
  // Run daily at 7am — detect failed/missing ACH pulls
  cron.schedule('0 7 * * *', async () => {
    try {
      // Payments due 5+ days ago that haven't settled. SELECT pulls
      // everything the email senders need so each row is self-sufficient
      // (one round trip per payment for the increment + status update,
      // no per-row joins for email payloads).
      const overdue = await query<any>(`
        SELECT p.*, u.unit_number, u.id AS unit_id,
          t.id AS tenant_id, t.late_payment_count, t.ssi_ssdi,
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
      `)

      for (const payment of overdue) {
        // Increment late count
        await query(
          `UPDATE tenants SET late_payment_count = late_payment_count + 1 WHERE id = $1`,
          [payment.tenant_id]
        )

        // Mark unit delinquent
        await query(
          `UPDATE units SET status = 'delinquent' WHERE id = $1 AND status = 'active'`,
          [payment.unit_id]
        )

        // S88: notify landlord every detection cycle. Email failures must
        // not abort the loop — log and keep processing other payments.
        const daysLate = Math.max(
          0,
          Math.floor((Date.now() - new Date(payment.due_date).getTime()) / (24 * 60 * 60 * 1000))
        )
        if (payment.landlord_email) {
          try {
            await sendLatePaymentNotice({
              landlordEmail: payment.landlord_email,
              landlordName:  payment.landlord_name || 'there',
              tenantName:    `${payment.tenant_first || ''} ${payment.tenant_last || ''}`.trim() || 'Tenant',
              unitNumber:    payment.unit_number || '—',
              propertyName:  payment.property_name || '—',
              daysLate,
              amount:        Number(payment.amount || 0),
              ctx:           { landlordId: payment.landlord_id, paymentId: payment.id },
            })
          } catch (e) { logger.error({ err: e }, '[EMAIL late_payment]') }
        }

        // After 2 late payments — invite tenant to On-Time Pay (one-shot
        // per tenant via on_time_pay_invite_sent_at sentinel).
        if (payment.late_payment_count >= 1) { // Already incremented above, so this is 2+
          const tenant = await queryOne<any>(
            `SELECT * FROM tenants WHERE id = $1`, [payment.tenant_id]
          )
          if (tenant && !tenant.on_time_pay_enrolled && !tenant.on_time_pay_invite_sent_at) {
            await query(
              `UPDATE tenants SET on_time_pay_invite_sent_at = NOW() WHERE id = $1`,
              [payment.tenant_id]
            )
            if (payment.tenant_email) {
              try {
                await sendOnTimePayInvitation({
                  email:      payment.tenant_email,
                  firstName:  payment.tenant_first || 'there',
                  lateCount:  payment.late_payment_count + 1,
                  rentAmount: Number(payment.amount || 0),
                  ctx:        { landlordId: payment.landlord_id, tenantId: payment.tenant_id },
                })
              } catch (e) { logger.error({ err: e }, '[EMAIL otp_invite]') }
            }
          }
        }
      }

      if (overdue.length > 0) {
        logger.info(`[Scheduler] ${overdue.length} overdue payment(s) processed`)
      }
    } catch (e) { logger.error({ err: e }, '[Scheduler] Late payment detection error') }
  })

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
  })


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
  registerLateFeeEngine()
  registerRefreshCron()
  // initial population — async, will populate per-tz crons on next tick
  refreshTimezoneCrons().then(({ added }) => {
    const sum = tzCronSummary()
    for (const [engineId, info] of Object.entries(sum)) {
      logger.info({ engine_id: engineId, tz_count: info.tzCount, label: info.label }, `   ✓ ${info.label.padEnd(22)} ${info.tzCount} timezone(s) registered (S26b-tz)`)
    }
  }).catch((e: unknown) => logger.error({ err: e }, '[Scheduler] Initial tz cron refresh error'))

    logger.info('   ✓ Lease expiry notices: Daily 8am (per lease expiration_notice_days)')
  logger.info('   ✓ Lease end processor:  Daily 2am (auto-renew or expire)')
  logger.info('   ✓ Low stock check:      Daily 9am')
  logger.info('   ✓ POS EOD auto-close:   Daily 3:30am Phoenix')
  logger.info('   ✓ Late detection:       Daily 7am')
  logger.info('   ✓ NACHA monitoring:     Daily 8am')
  logger.info('   ✓ Unit activations:     Hourly at :05')
  logger.info('   ✓ Invitation expiry:    Hourly at :10')
  logger.info('   ✓ Tz refresh:           Daily 3am UTC\n')
}


// === S26a: invoice generation ===
// Daily 1am Phoenix-local (08:00 UTC). Idempotent via ux_invoices_lease_due_date.
// Generates an invoice per active lease for each missed/current cycle due date,
// with rent + monthly_ongoing fee children. Catch-up window: 30 days.

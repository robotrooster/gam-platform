/**
 * S609 — tenant-scheduled rent autopay.
 *
 * NIC, DIRECTIVE: "The landlord should not be pulling the strings on when the
 * money gets moved. That could be used the wrong way with a landlord pushing the
 * date back and getting extra late fees."
 *
 * THE PULL DAY IS THE TENANT'S AND ONLY THE TENANT'S. Every write path in this
 * file rejects anyone who is not the tenant on the lease. The landlord gets a
 * read — "autopay is set for the 9th" — so they do not read a quiet month as a
 * tenant who is not paying, and nothing more than a read. If a future route ever
 * needs to touch this table, that rule is the thing to check first.
 *
 * NO PROJECTION (Nic): the tenant is not shown what their bill will be. The
 * balance moves between choosing a day and the charge landing — another late-fee
 * tick, a water bill joining the invoice, a fee the landlord waived — so any
 * number promised in advance is one the system cannot keep. They are told the
 * rule instead: it charges the full balance on the day you picked, and picking a
 * day after rent is due means late fees under your lease.
 */

import { Router } from 'express'
import { z } from 'zod'
import { query, queryOne } from '../db'
import { requireAuth } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { getStripe } from '../lib/stripe'
import { payDateForPullDay } from '../services/autopayProjection'

export const tenantAutopayRouter = Router()
tenantAutopayRouter.use(requireAuth)

/** Confirm this tenant is on this lease. The whole security model of the file. */
async function assertTenantOnLease(tenantId: string, leaseId: string): Promise<void> {
  const row = await queryOne<{ ok: boolean }>(
    `SELECT TRUE AS ok FROM v_lease_active_tenants
      WHERE lease_id = $1 AND tenant_id = $2 LIMIT 1`,
    [leaseId, tenantId])
  if (!row) throw new AppError(404, 'Lease not found')
}

// GET /api/autopay — the tenant's own arrangements, one row per lease they are
// on (whether or not autopay is set up), so the screen can offer it everywhere.
tenantAutopayRouter.get('/', async (req: any, res, next) => {
  try {
    if (req.user!.role !== 'tenant') throw new AppError(403, 'Only tenants can call this endpoint')
    const tenantId = req.user!.profileId
    const rows = await query<any>(
      `SELECT l.id                AS lease_id,
              pr.name             AS property_name,
              u.unit_number,
              l.rent_due_day,
              a.id                AS autopay_id,
              a.enabled,
              a.pull_day,
              a.payment_method_id,
              a.last_run_cycle::text     AS last_run_cycle,
              a.last_success_cycle::text AS last_success_cycle,
              a.last_error,
              a.consecutive_failures,
              a.disarmed_at,
              a.disarmed_reason
         FROM v_lease_active_tenants vt
         JOIN leases l ON l.id = vt.lease_id
         JOIN units u ON u.id = l.unit_id
         JOIN properties pr ON pr.id = u.property_id
         LEFT JOIN tenant_autopay a ON a.lease_id = l.id AND a.tenant_id = vt.tenant_id
        WHERE vt.tenant_id = $1
          AND l.status = 'active'
        ORDER BY pr.name, u.unit_number`,
      [tenantId])
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

const putSchema = z.object({
  leaseId: z.string().uuid(),
  enabled: z.boolean(),
  // NULL = charge on the day rent is due, the ordinary case. 1-28 otherwise:
  // past 28 a day does not exist in February, and a schedule that silently
  // skips a month is worse than no schedule.
  pullDay: z.number().int().min(1).max(28).nullable().optional(),
  // NULL = follow whatever the tenant's default method is at charge time, so
  // someone who later switches from card to bank does not have to re-arm.
  paymentMethodId: z.string().min(1).nullable().optional(),
})

// PUT /api/autopay — the tenant sets, changes, or switches off their schedule.
// TENANT ONLY. A landlord reaching this route is the abuse this table exists to
// prevent, so it is a flat 403 rather than a scope check.
tenantAutopayRouter.put('/', async (req: any, res, next) => {
  try {
    if (req.user!.role !== 'tenant') {
      throw new AppError(403, 'Only the tenant can change their own autopay schedule.')
    }
    const body = putSchema.parse(req.body)
    const tenantId = req.user!.profileId
    await assertTenantOnLease(tenantId, body.leaseId)

    // If the tenant names a payment method it has to be theirs. Saved methods
    // live on the tenant's Stripe customer rather than in our tables, so the
    // check is against Stripe — otherwise a guessed id would schedule monthly
    // charges against a stranger's bank account.
    if (body.paymentMethodId) {
      const tenant = await queryOne<{ stripe_customer_id: string | null }>(
        `SELECT stripe_customer_id FROM tenants WHERE id = $1`, [tenantId])
      if (!tenant?.stripe_customer_id) throw new AppError(409, 'Finish setting up a payment method first.')
      const pm = await getStripe().paymentMethods.retrieve(body.paymentMethodId)
      if (pm.customer !== tenant.stripe_customer_id) {
        throw new AppError(403, 'That payment method is not on your account.')
      }
    }

    // Turning it back on clears a system disarm — the tenant has seen why it
    // stopped and is choosing to restart it, so the failure count starts over.
    const row = await queryOne<any>(
      `INSERT INTO tenant_autopay (tenant_id, lease_id, enabled, pull_day, payment_method_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (lease_id) DO UPDATE
          SET enabled              = EXCLUDED.enabled,
              pull_day             = EXCLUDED.pull_day,
              payment_method_id    = EXCLUDED.payment_method_id,
              consecutive_failures = CASE WHEN EXCLUDED.enabled THEN 0 ELSE tenant_autopay.consecutive_failures END,
              disarmed_at          = CASE WHEN EXCLUDED.enabled THEN NULL ELSE tenant_autopay.disarmed_at END,
              disarmed_reason      = CASE WHEN EXCLUDED.enabled THEN NULL ELSE tenant_autopay.disarmed_reason END,
              last_error           = CASE WHEN EXCLUDED.enabled THEN NULL ELSE tenant_autopay.last_error END,
              updated_at           = NOW()
        WHERE tenant_autopay.tenant_id = $1
       RETURNING id, enabled, pull_day, payment_method_id`,
      [tenantId, body.leaseId, body.enabled, body.pullDay ?? null, body.paymentMethodId ?? null])
    if (!row) throw new AppError(403, 'That autopay schedule belongs to another tenant.')

    res.json({ success: true, data: row })
  } catch (e) { next(e) }
})

// GET /api/autopay/lease/:leaseId — LANDLORD READ. Visibility only, so a
// landlord watching a quiet lease knows money is scheduled rather than assuming
// the tenant has stopped paying. There is deliberately no matching write.
tenantAutopayRouter.get('/lease/:leaseId', async (req: any, res, next) => {
  try {
    const { leaseId } = req.params
    // Only over leases this user actually holds.
    const lease = await queryOne<{ landlord_user_id: string; rent_due_day: number | null }>(
      `SELECT lu.id AS landlord_user_id, l.rent_due_day
         FROM leases l
         JOIN landlords ld ON ld.id = l.landlord_id
         JOIN users lu ON lu.id = ld.user_id
        WHERE l.id = $1`,
      [leaseId])
    if (!lease) throw new AppError(404, 'Lease not found')

    const isTenant = req.user!.role === 'tenant'
    if (isTenant) {
      await assertTenantOnLease(req.user!.profileId, leaseId)
    } else if (lease.landlord_user_id !== req.user!.id && req.user!.role !== 'super_admin') {
      throw new AppError(403, 'Not your lease')
    }

    const row = await queryOne<any>(
      `SELECT enabled, pull_day, last_run_cycle::text AS last_run_cycle,
              last_success_cycle::text AS last_success_cycle,
              consecutive_failures, disarmed_at, disarmed_reason,
              (last_error IS NOT NULL) AS had_error
         FROM tenant_autopay WHERE lease_id = $1`,
      [leaseId])

    // The landlord is shown WHETHER and WHEN, never the tenant's bank details
    // and never the underlying error text — that is between the tenant and
    // their bank.
    res.json({ success: true, data: row
      ? {
          scheduled: !!row.enabled,
          pullDay: row.pull_day,
          rentDueDay: lease.rent_due_day,
          lastSuccessCycle: row.last_success_cycle,
          lastAttemptFailed: !!row.had_error && row.last_success_cycle !== row.last_run_cycle,
          consecutiveFailures: row.consecutive_failures,
          stoppedAt: row.disarmed_at,
          stoppedReason: row.disarmed_reason,
        }
      : { scheduled: false } })
  } catch (e) { next(e) }
})

// GET /api/autopay/preview?leaseId=&pullDay= — what date a chosen day lands on
// for the next cycle. Date arithmetic only; deliberately NOT a bill forecast.
tenantAutopayRouter.get('/preview', async (req: any, res, next) => {
  try {
    if (req.user!.role !== 'tenant') throw new AppError(403, 'Only tenants can call this endpoint')
    const leaseId = z.string().uuid().parse(req.query.leaseId)
    const pullDay = req.query.pullDay != null && req.query.pullDay !== ''
      ? z.coerce.number().int().min(1).max(28).parse(req.query.pullDay)
      : null
    await assertTenantOnLease(req.user!.profileId, leaseId)

    const next = await queryOne<{ due_date: string }>(
      `SELECT MIN(due_date)::text AS due_date FROM payments
        WHERE lease_id = $1 AND type = 'rent' AND status = 'pending'`,
      [leaseId])
    const dueDate = next?.due_date ?? null
    res.json({ success: true, data: {
      dueDate,
      payDate: dueDate ? payDateForPullDay(dueDate, pullDay) : null,
      afterDueDate: dueDate != null && pullDay != null && pullDay > Number(dueDate.slice(8, 10)),
    } })
  } catch (e) { next(e) }
})

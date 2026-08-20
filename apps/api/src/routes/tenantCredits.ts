import { Router } from 'express'
import { z } from 'zod'
import { query, queryOne, getClient } from '../db'
import { applyCreditsToOpenCharges } from '../services/creditApplication'
import { requireAuth } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { canManageLandlordResource } from '../middleware/scope'
import { TENANT_CREDIT_CATEGORIES } from '@gam/shared'

// ============================================================
// S577 — Landlord-issued tenant account credits (Nic).
//
// A landlord issues a credit to a tenant for ANY reason (capped-state screening
// fee, late-fee refund, accidental overcharge, goodwill). It's applied to the
// tenant's next rent invoice, drawn down oldest-first by invoiceGeneration
// (SEPARATE from lease_prepaid_credits + INDEPENDENT of work-trade). Funded by
// the landlord — the tenant simply owes less, so the landlord receives less rent.
//
// Authority: the caller must manage the landlord that owns the lease
// (owner or scoped property manager). GAM never computes state caps — the
// landlord decides the amount.
// ============================================================

export const tenantCreditsRouter = Router()
tenantCreditsRouter.use(requireAuth)

// Resolve the lease + verify the caller has landlord authority over it, and find
// the primary tenant to attribute the credit to.
async function leaseForLandlord(leaseId: string, user: any) {
  const lease = await queryOne<any>(
    `SELECT l.id, l.landlord_id,
            (SELECT lt.tenant_id FROM lease_tenants lt
              WHERE lt.lease_id = l.id AND lt.status = 'active'
              ORDER BY (lt.role = 'primary') DESC, lt.added_at ASC NULLS LAST
              LIMIT 1) AS tenant_id
       FROM leases l WHERE l.id = $1`, [leaseId])
  if (!lease) throw new AppError(404, 'Lease not found')
  if (!canManageLandlordResource(user, lease.landlord_id, ['property_manager'])) {
    throw new AppError(403, 'Forbidden')
  }
  if (!lease.tenant_id) throw new AppError(400, 'This lease has no active tenant to credit')
  return lease
}

// POST /api/tenant-credits — issue a credit against a lease.
tenantCreditsRouter.post('/', async (req, res, next) => {
  try {
    const body = z.object({
      leaseId:  z.string().uuid(),
      amount:   z.number().positive().max(100000),
      category: z.enum(TENANT_CREDIT_CATEGORIES as unknown as [string, ...string[]]).default('other'),
      reason:   z.string().trim().max(500).optional().nullable(),
    }).parse(req.body)

    const lease = await leaseForLandlord(body.leaseId, req.user)
    const amt = Math.round(body.amount * 100) / 100

    // S607 (Nic): the credit lands on the OPEN BALANCE NOW, not at the next
    // invoice. "The credit needs to go to the balance and kind of zero it out so
    // that the landlord's not thinking that the tenant still owes money, the
    // books look good, everything's zeroed out."
    //
    // Before this, forgiving a $35 late fee left $35 showing as owed until the
    // next invoice ran — and because rent is pay-in-full, that forgiven charge
    // also blocked the tenant from paying anything at all. Anything not consumed
    // by open charges stays on the credit for the next invoice.
    const client = await getClient()
    let row: any, applied = 0
    try {
      await client.query('BEGIN')
      row = (await client.query<any>(
        `INSERT INTO tenant_credits
           (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category, reason, created_by)
         VALUES ($1, $2, $3, $4, $4, $5, $6, $7)
         RETURNING id, amount_original, amount_remaining, category, reason, status, created_at`,
        [lease.landlord_id, lease.tenant_id, lease.id, amt.toFixed(2), body.category, body.reason ?? null, req.user!.userId])).rows[0]
      const r = await applyCreditsToOpenCharges(client, { leaseId: lease.id, scope: 'lease' })
      applied = r.applied
      const fresh = await client.query<{ amount_remaining: string }>(
        `SELECT amount_remaining::text FROM tenant_credits WHERE id = $1`, [row.id])
      row.amount_remaining = fresh.rows[0].amount_remaining
      await client.query('COMMIT')
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e }
    finally { client.release() }

    res.status(201).json({ success: true, data: { ...row, appliedToBalance: applied } })
  } catch (e) { next(e) }
})

// GET /api/tenant-credits?leaseId=|tenantId= — list credits the caller can see.
tenantCreditsRouter.get('/', async (req, res, next) => {
  try {
    const leaseId  = typeof req.query.leaseId === 'string' ? req.query.leaseId : null
    const tenantId = typeof req.query.tenantId === 'string' ? req.query.tenantId : null
    if (!leaseId && !tenantId) throw new AppError(400, 'leaseId or tenantId is required')

    // Authority: resolve the owning landlord from the lease/tenant and check.
    const scopeRow = leaseId
      ? await queryOne<{ landlord_id: string }>('SELECT landlord_id FROM leases WHERE id=$1', [leaseId])
      : await queryOne<{ landlord_id: string }>(
          `SELECT l.landlord_id FROM tenant_credits tc JOIN leases l ON l.id = tc.lease_id
            WHERE tc.tenant_id=$1 ORDER BY tc.created_at DESC LIMIT 1`, [tenantId])
    if (scopeRow && !canManageLandlordResource(req.user, scopeRow.landlord_id, ['property_manager'])) {
      throw new AppError(403, 'Forbidden')
    }

    const rows = await query<any>(
      `SELECT tc.id, tc.tenant_id, tc.lease_id, tc.amount_original, tc.amount_remaining,
              tc.category, tc.reason, tc.status, tc.created_at, tc.voided_at,
              (u.first_name || ' ' || u.last_name) AS tenant_name
         FROM tenant_credits tc
         JOIN tenants t ON t.id = tc.tenant_id
         JOIN users u ON u.id = t.user_id
        WHERE ($1::uuid IS NULL OR tc.lease_id = $1)
          AND ($2::uuid IS NULL OR tc.tenant_id = $2)
        ORDER BY tc.created_at DESC`,
      [leaseId, tenantId])
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

// POST /api/tenant-credits/:id/void — cancel the remaining balance of a credit.
tenantCreditsRouter.post('/:id/void', async (req, res, next) => {
  try {
    const credit = await queryOne<any>('SELECT * FROM tenant_credits WHERE id=$1', [req.params.id])
    if (!credit) throw new AppError(404, 'Credit not found')
    if (!canManageLandlordResource(req.user, credit.landlord_id, ['property_manager'])) {
      throw new AppError(403, 'Forbidden')
    }
    if (credit.status === 'void') throw new AppError(400, 'Credit is already void')
    await query(
      `UPDATE tenant_credits SET status='void', amount_remaining=0, voided_at=NOW(), updated_at=NOW() WHERE id=$1`,
      [req.params.id])
    res.json({ success: true })
  } catch (e) { next(e) }
})

// GET /api/tenant-credits/mine — tenant sees credits waiting on their account.
tenantCreditsRouter.get('/mine', async (req, res, next) => {
  try {
    const t = await queryOne<{ id: string }>('SELECT id FROM tenants WHERE user_id=$1 ORDER BY created_at LIMIT 1', [req.user!.userId])
    if (!t) return res.json({ success: true, data: [] })
    const rows = await query<any>(
      `SELECT id, amount_original, amount_remaining, category, reason, created_at
         FROM tenant_credits
        WHERE tenant_id=$1 AND status='active' AND amount_remaining > 0
        ORDER BY created_at ASC`, [t.id])
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

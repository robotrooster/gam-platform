// S624 — "I paid at the bank."
//
// The tenant-facing half of bank-deposit matching. A tenant who pays their own
// rent at a branch tells GAM they did; the bank feed later proves it; the
// landlord never touches it.
//
// THE DECLARATION IS A CLAIM, NOT A PAYMENT — and everything about this file
// follows from that. Nic (S624): "it also needs a way to have protections in
// case the tenant just straight up lied and said they paid, and they never
// actually went to the bank." Nothing here credits anything, pauses a late fee,
// or touches the eviction clock. A tenant who lies gains precisely nothing,
// which is a better defence than trying to catch them. The reward for telling
// the truth is real though: a corroborated declaration earns them the date THEY
// paid rather than the date the bank got round to posting it, which on a Friday
// deposit is worth several days of late fees (services/depositBackdate.ts).

import { Router } from 'express'
import { z } from 'zod'
import { query, queryOne } from '../db'
import { requireAuth } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { canManageLandlordResource } from '../middleware/scope'
import { MANUAL_PAYMENT_METHODS } from '@gam/shared'
import { DateTime } from 'luxon'

export const declaredDepositsRouter = Router()
declaredDepositsRouter.use(requireAuth)

/**
 * How long a claim waits for a matching deposit before it is written off.
 *
 * Generous on purpose: a branch deposit posts in a day or two, but a mailed
 * money order or a holiday weekend stretches it, and expiring an honest tenant's
 * report is a bad way to introduce them to the feature.
 */
export const DECLARATION_EXPIRY_DAYS = 7

/**
 * How many unmatched claims a tenant may make before the button stops trusting
 * them. Two is deliberate: one is a mistake, two is a pattern worth naming.
 */
export const UNCONFIRMED_STRIKE_LIMIT = 2

const declareSchema = z.object({
  leaseId: z.string().uuid(),
  amount: z.number().positive().max(100000),
  // The date they say they went to the bank. Never the payment date on its own —
  // it only governs once a bank row corroborates it.
  declaredDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  method: z.enum(MANUAL_PAYMENT_METHODS),
  reference: z.string().max(120).optional(),
})

/** The lease must actually be this tenant's, and active. */
async function assertTenantsLease(tenantId: string, leaseId: string) {
  const row = await queryOne<{ landlord_id: string }>(
    `SELECT l.landlord_id
       FROM leases l
       JOIN lease_tenants lt ON lt.lease_id = l.id
      WHERE l.id = $1 AND lt.tenant_id = $2 AND lt.status = 'active'`,
    [leaseId, tenantId])
  if (!row) throw new AppError(404, 'That lease is not yours')
  return row.landlord_id
}

// POST /api/declared-deposits — "I paid at the bank"
declaredDepositsRouter.post('/', async (req, res, next) => {
  try {
    // ROLE, not just the presence of a profileId. A landlord has one too, so
    // checking only for its existence let them through here and refused them
    // later on the lease lookup — with a misleading "that lease is not yours".
    // The guard held by accident; a guard that holds by accident is one edit
    // away from not holding at all.
    if (req.user!.role !== 'tenant') {
      throw new AppError(403, 'Only a tenant can report their own deposit')
    }
    const tenantId = req.user!.profileId
    if (!tenantId) throw new AppError(403, 'Only a tenant can report a deposit')
    const body = declareSchema.parse(req.body)

    const landlordId = await assertTenantsLease(tenantId, body.leaseId)

    // A deposit cannot have happened in the future, and a date the tenant has
    // to scroll back to is almost certainly a mistake. Both are refused with a
    // sentence rather than a validation code.
    const today = DateTime.now().setZone('America/Phoenix').toISODate()!
    if (body.declaredDate > today) {
      throw new AppError(400, 'That date is in the future — report the deposit after you have made it.')
    }
    if (body.declaredDate < DateTime.fromISO(today).minus({ days: 45 }).toISODate()!) {
      throw new AppError(400, 'That date is more than 45 days ago. Contact your landlord so they can look it up directly.')
    }

    // Two identical open claims are always a double-tap, never two deposits.
    const dup = await queryOne<{ id: string }>(
      `SELECT id FROM tenant_declared_deposits
        WHERE tenant_id = $1 AND lease_id = $2 AND status = 'pending'
          AND amount = $3 AND declared_date = $4::date`,
      [tenantId, body.leaseId, body.amount.toFixed(2), body.declaredDate])
    if (dup) {
      return res.json({ success: true, data: { id: dup.id, alreadyReported: true } })
    }

    const strikes = await queryOne<{ n: string }>(
      `SELECT COUNT(*) AS n FROM tenant_declared_deposits
        WHERE tenant_id = $1 AND status = 'unconfirmed'`, [tenantId])
    const strikeCount = parseInt(strikes?.n ?? '0', 10)

    const row = await queryOne<{ id: string }>(
      `INSERT INTO tenant_declared_deposits
         (tenant_id, lease_id, landlord_id, amount, declared_date, method, reference)
       VALUES ($1,$2,$3,$4,$5::date,$6,$7) RETURNING id`,
      [tenantId, body.leaseId, landlordId, body.amount.toFixed(2),
       body.declaredDate, body.method, body.reference ?? null])

    res.json({
      success: true,
      data: {
        id: row!.id,
        // Said plainly, because a tenant who thinks this paid their rent will
        // stop worrying about a bill that is still due.
        message: 'Reported. Your balance stays the same until your deposit shows up in the bank — usually a day or two. We will apply it automatically and date it to the day you paid.',
        expiresInDays: DECLARATION_EXPIRY_DAYS,
        priorUnconfirmed: strikeCount,
        trusted: strikeCount < UNCONFIRMED_STRIKE_LIMIT,
      },
    })
  } catch (e) { next(e) }
})

// GET /api/declared-deposits — the tenant's own reports
declaredDepositsRouter.get('/', async (req, res, next) => {
  try {
    if (req.user!.role !== 'tenant') throw new AppError(403, 'Forbidden')
    const tenantId = req.user!.profileId
    if (!tenantId) throw new AppError(403, 'Forbidden')
    const rows = await query(
      `SELECT id, amount::float AS amount,
              to_char(declared_date,'YYYY-MM-DD') AS declared_date,
              method, reference, status, resolution_note,
              to_char(confirmed_at,'YYYY-MM-DD') AS confirmed_on
         FROM tenant_declared_deposits
        WHERE tenant_id = $1
        ORDER BY created_at DESC
        LIMIT 50`, [tenantId])
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

// DELETE /api/declared-deposits/:id — "actually, I hadn't paid yet"
declaredDepositsRouter.delete('/:id', async (req, res, next) => {
  try {
    if (req.user!.role !== 'tenant') throw new AppError(403, 'Forbidden')
    const tenantId = req.user!.profileId
    if (!tenantId) throw new AppError(403, 'Forbidden')
    // Withdrawn, never deleted (standing retention rule) — and only while it is
    // still a claim. A confirmed report is a settled payment and is not the
    // tenant's to take back.
    const row = await queryOne<{ id: string }>(
      `UPDATE tenant_declared_deposits
          SET status = 'withdrawn', resolution_note = 'Withdrawn by the tenant',
              updated_at = NOW()
        WHERE id = $1 AND tenant_id = $2 AND status = 'pending'
        RETURNING id`, [req.params.id, tenantId])
    if (!row) throw new AppError(409, 'That report can no longer be withdrawn')
    res.json({ success: true })
  } catch (e) { next(e) }
})

// GET /api/declared-deposits/landlord — reports the landlord should know about
//
// Two things a landlord genuinely needs: what has been claimed but not yet
// proved, and what never arrived. The second is the only fraud signal here, and
// it is a signal, not a verdict — a money order genuinely can go astray.
declaredDepositsRouter.get('/landlord/open', async (req, res, next) => {
  try {
    const landlordId = req.user!.role === 'landlord'
      ? req.user!.profileId : req.user!.landlordId
    if (!landlordId || !canManageLandlordResource(req.user, landlordId)) {
      throw new AppError(403, 'Forbidden')
    }
    const rows = await query(
      `SELECT d.id, d.amount::float AS amount,
              to_char(d.declared_date,'YYYY-MM-DD') AS declared_date,
              d.method, d.reference, d.status,
              u.unit_number,
              TRIM(COALESCE(usr.first_name,'') || ' ' || COALESCE(usr.last_name,'')) AS tenant_name,
              (SELECT COUNT(*) FROM tenant_declared_deposits x
                WHERE x.tenant_id = d.tenant_id AND x.status = 'unconfirmed')::int
                AS prior_unconfirmed
         FROM tenant_declared_deposits d
         JOIN leases l ON l.id = d.lease_id
         JOIN units u ON u.id = l.unit_id
         JOIN tenants t ON t.id = d.tenant_id
         JOIN users usr ON usr.id = t.user_id
        WHERE d.landlord_id = $1 AND d.status IN ('pending','unconfirmed')
        ORDER BY d.status, d.declared_date DESC
        LIMIT 200`, [landlordId])
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

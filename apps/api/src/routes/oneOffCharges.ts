import { Router } from 'express'
import { z } from 'zod'
import { query, queryOne } from '../db'
import { requireAuth, requirePerm } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { canAccessLandlordResource } from '../middleware/scope'

// ============================================================
// S616 (Nic) — charging for something that happened.
//
// "You are saying a landlord charging a parking violation would get the charge
//  ignored?"
//
// It would not have been ignored; there was simply nowhere to enter it. Every
// payments row came from a specific system flow and every lease_fees row came
// from the lease document, so a landlord with a fire-lane violation, a broken
// window or a replaced key had no door at all.
//
// The charge lands on the tenant's NEXT invoice as an ordinary fee line, with
// the reason and the date the thing happened printed on it. It is not written
// into the lease, because the lease is the record of what was agreed and this
// is the record of what occurred.
// ============================================================

export const oneOffChargesRouter = Router()
oneOffChargesRouter.use(requireAuth)

const createBody = z.object({
  tenantId:     z.string().uuid(),
  chargeType:   z.enum(['violation','damage','replacement','service','other']),
  amount:       z.number().positive().max(100000),
  /** Printed on the tenant's invoice. Required — a charge nobody can explain
   *  is a charge nobody should be able to add. */
  reason:       z.string().trim().min(3).max(200),
  incidentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  internalNote: z.string().trim().max(1000).optional(),
  /** Push it to a later cycle — a large repair the tenant was warned about. */
  billOnOrAfter: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
})

oneOffChargesRouter.post('/', requirePerm('payments.edit', 'properties.edit'),
  async (req, res, next) => {
    try {
      const body = createBody.parse(req.body)

      // The tenant's live tenancy decides the unit, the lease and the landlord.
      // Taking any of those from the request body would let a caller attach a
      // charge to a lease they do not own — the S616 foreign-ref rule.
      const tenancy = await queryOne<any>(
        `SELECT l.id AS lease_id, l.unit_id, l.landlord_id
           FROM v_lease_active_tenants vt
           JOIN leases l ON l.id = vt.lease_id AND l.status = 'active'
          WHERE vt.tenant_id = $1
          ORDER BY (vt.role = 'primary') DESC
          LIMIT 1`, [body.tenantId])
      if (!tenancy) {
        throw new AppError(404, 'That person has no active lease to charge.')
      }
      if (!canAccessLandlordResource(req.user, tenancy.landlord_id)) {
        throw new AppError(403, 'Forbidden')
      }

      const row = await queryOne<any>(
        `INSERT INTO tenant_one_off_charges (
           landlord_id, tenant_id, lease_id, unit_id,
           charge_type, amount, reason, incident_date, internal_note,
           bill_on_or_after, created_by
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10::date, CURRENT_DATE),$11)
         RETURNING id, status, amount::text, reason,
                   to_char(incident_date, 'YYYY-MM-DD') AS incident_date,
                   to_char(bill_on_or_after, 'YYYY-MM-DD') AS bill_on_or_after`,
        [tenancy.landlord_id, body.tenantId, tenancy.lease_id, tenancy.unit_id,
         body.chargeType, body.amount.toFixed(2), body.reason, body.incidentDate,
         body.internalNote ?? null, body.billOnOrAfter ?? null, req.user!.userId])

      res.status(201).json({ success: true, data: row })
    } catch (e) { next(e) }
  })

/** The landlord's charges, newest first. */
oneOffChargesRouter.get('/', requirePerm('payments.edit', 'properties.edit', 'payments.view_all'),
  async (req, res, next) => {
    try {
      const landlordId = req.user!.role === 'landlord'
        ? req.user!.profileId : req.user!.landlordId
      if (!landlordId) return res.json({ success: true, data: [] })

      const params: any[] = [landlordId]
      let where = 'c.landlord_id = $1'
      if (typeof req.query.tenantId === 'string') {
        params.push(req.query.tenantId)
        where += ` AND c.tenant_id = $${params.length}`
      }

      const rows = await query<any>(`
        SELECT c.id, c.charge_type, c.amount::text, c.reason, c.internal_note,
               c.status, c.cancel_reason,
               to_char(c.incident_date,   'YYYY-MM-DD') AS incident_date,
               to_char(c.bill_on_or_after,'YYYY-MM-DD') AS bill_on_or_after,
               c.billed_at, c.created_at,
               u.unit_number,
               usr.first_name, usr.last_name,
               -- Once billed, whether the tenant has actually paid it.
               pay.status AS payment_status
          FROM tenant_one_off_charges c
          JOIN units u    ON u.id = c.unit_id
          JOIN tenants t  ON t.id = c.tenant_id
          JOIN users usr  ON usr.id = t.user_id
          LEFT JOIN payments pay ON pay.id = c.payment_id
         WHERE ${where}
         ORDER BY c.created_at DESC
         LIMIT 500`, params)
      res.json({ success: true, data: rows })
    } catch (e) { next(e) }
  })

/**
 * Withdraw a charge before it is billed.
 *
 * GAM never erases, so this cancels with a reason rather than deleting — "why
 * did this go away" always has an answer. A charge that has ALREADY reached an
 * invoice is out of reach here on purpose: money the tenant has been billed is
 * unwound by crediting it, which leaves both the charge and the forgiveness on
 * the record, not by making the charge disappear.
 */
oneOffChargesRouter.patch('/:id/cancel', requirePerm('payments.edit', 'properties.edit'),
  async (req, res, next) => {
    try {
      const { reason } = z.object({
        reason: z.string().trim().max(300).optional(),
      }).parse(req.body ?? {})

      const charge = await queryOne<any>(
        `SELECT id, landlord_id, status FROM tenant_one_off_charges WHERE id = $1`,
        [req.params.id])
      if (!charge) throw new AppError(404, 'Charge not found')
      if (!canAccessLandlordResource(req.user, charge.landlord_id)) {
        throw new AppError(403, 'Forbidden')
      }
      if (charge.status === 'billed') {
        throw new AppError(409,
          'That charge is already on an invoice. Issue the tenant a credit instead, so both the charge and the credit stay on the record.')
      }
      if (charge.status === 'cancelled') {
        return res.json({ success: true, data: { id: charge.id, status: 'cancelled' } })
      }

      const row = await queryOne<any>(
        `UPDATE tenant_one_off_charges
            SET status = 'cancelled', cancelled_at = NOW(),
                cancelled_by = $2, cancel_reason = $3, updated_at = NOW()
          WHERE id = $1
          RETURNING id, status, cancel_reason`,
        [req.params.id, req.user!.userId, reason ?? null])
      res.json({ success: true, data: row })
    } catch (e) { next(e) }
  })

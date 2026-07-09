/**
 * Propane tank-fill billing (Nic, S533).
 *
 * RV gas = propane tank fills, billed in gallons × a per-fill PPG
 * (deliberately NOT linked to POS propane pricing). Split payments are
 * 2 or 4 only (shared propaneSplitOptions gates by gallons; the
 * property must opt in). Installment #1 bills IMMEDIATELY as a
 * standalone payments row (outside the invoice late-fee mechanism);
 * the rest ride consecutive monthly invoices (invoiceGeneration picks
 * them up like utility bills) under the invoice's normal late-fee
 * rules. A new fill while a prior balance remains ACCELERATES it: every
 * remaining prior installment becomes due immediately alongside the new
 * fill's first payment (the refill truck doesn't coordinate with the
 * office — blocking the record would just lose the billing).
 */

import { Router } from 'express'
import { z } from 'zod'
import { propaneSplitOptions } from '@gam/shared'
import { query, queryOne, getClient } from '../db'
import { requireAuth, requirePerm } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { canAccessLandlordResource } from '../middleware/scope'

export const propaneRouter = Router()
propaneRouter.use(requireAuth)

const monthStart = (d: Date) =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`
const addMonths = (iso: string, n: number) => {
  const d = new Date(iso + 'T00:00:00Z')
  d.setUTCMonth(d.getUTCMonth() + n)
  return monthStart(d)
}

// ── FILLS ────────────────────────────────────────────────────
propaneRouter.get('/fills', requirePerm('units.edit', 'units.view_status', 'properties.edit'), async (req, res, next) => {
  try {
    const propertyId = z.string().uuid().parse(req.query.propertyId)
    const property = await queryOne<any>(
      `SELECT id, landlord_id FROM properties WHERE id = $1`, [propertyId])
    if (!property) throw new AppError(404, 'Property not found')
    if (!canAccessLandlordResource(req.user, property.landlord_id)) {
      throw new AppError(403, 'Forbidden')
    }
    const fills = await query<any>(
      `SELECT f.*, u.unit_number,
              us.first_name || ' ' || us.last_name AS tenant_name,
              (SELECT COUNT(*)::int FROM propane_fill_installments i
                 JOIN payments p ON p.id = i.payment_id
                WHERE i.fill_id = f.id AND p.status IN ('settled','paid_via_deposit')) AS installments_paid,
              (SELECT COALESCE(SUM(i.amount), 0) FROM propane_fill_installments i
                LEFT JOIN payments p ON p.id = i.payment_id
                WHERE i.fill_id = f.id
                  AND (i.payment_id IS NULL OR p.status NOT IN ('settled','paid_via_deposit'))) AS balance_remaining
         FROM propane_fills f
         JOIN units u ON u.id = f.unit_id
         JOIN tenants t ON t.id = f.tenant_id
         JOIN users us ON us.id = t.user_id
        WHERE f.property_id = $1
        ORDER BY f.fill_date DESC, f.created_at DESC
        LIMIT 50`,
      [propertyId])
    res.json({ success: true, data: fills })
  } catch (e) { next(e) }
})

propaneRouter.post('/fills', requirePerm('properties.edit'), async (req, res, next) => {
  try {
    const body = z.object({
      unitId:         z.string().uuid(),
      gallons:        z.number().positive().max(9999),
      pricePerGallon: z.number().nonnegative().max(999),
      installments:   z.number().int().refine(n => [1, 2, 4].includes(n), 'installments must be 1, 2, or 4'),
    }).parse(req.body)

    const unit = await queryOne<any>(
      `SELECT u.id, u.landlord_id, u.property_id, u.unit_number,
              p.propane_allow_installments,
              p.propane_split_min_gallons, p.propane_split_four_min_gallons
         FROM units u JOIN properties p ON p.id = u.property_id
        WHERE u.id = $1`, [body.unitId])
    if (!unit) throw new AppError(404, 'Unit not found')
    if (!canAccessLandlordResource(req.user, unit.landlord_id)) {
      throw new AppError(403, 'Forbidden')
    }

    // The fill bills a tenant — needs an active lease with a primary.
    const lt = await queryOne<{ lease_id: string; tenant_id: string }>(
      `SELECT vlat.lease_id, vlat.tenant_id
         FROM v_lease_active_tenants vlat
         JOIN leases l ON l.id = vlat.lease_id
        WHERE l.unit_id = $1 AND l.status = 'active' AND vlat.role = 'primary'
        LIMIT 1`, [body.unitId])
    if (!lt) throw new AppError(400, 'No active lease on this unit — propane fills bill the tenant')

    // Split gate: property opt-in + gallon eligibility (2 or 4 only).
    // S534 (Nic): the gallon thresholds are landlord-set per property —
    // the shared constants are only the new-property defaults.
    if (body.installments > 1) {
      if (!unit.propane_allow_installments) {
        throw new AppError(400, 'Split payments are not enabled for this property')
      }
      const opts = propaneSplitOptions(
        body.gallons,
        Number(unit.propane_split_min_gallons),
        Number(unit.propane_split_four_min_gallons))
      if (!opts.includes(body.installments)) {
        throw new AppError(400, `A ${body.gallons} gal fill can't split into ${body.installments} payments`)
      }
    }

    // Landlord-configured propane tax (S533) — snapshot on the fill;
    // installments split the tax-inclusive total.
    const taxRow = await queryOne<{ tax_rate_pct: string }>(
      `SELECT tax_rate_pct FROM property_utility_tax_rates
        WHERE property_id = $1 AND utility_type = 'propane'`, [unit.property_id])
    const taxRatePct = Number(taxRow?.tax_rate_pct || 0)
    const subtotal = Math.round(body.gallons * body.pricePerGallon * 100) / 100
    const taxAmount = Math.round(subtotal * taxRatePct) / 100
    const total = Math.round((subtotal + taxAmount) * 100) / 100
    // Even installments; the LAST one takes the rounding remainder
    // (user-favor rounding, W-32 precedent).
    const base = Math.floor((total / body.installments) * 100) / 100
    const amounts = Array.from({ length: body.installments }, (_, i) =>
      i === body.installments - 1
        ? Math.round((total - base * (body.installments - 1)) * 100) / 100
        : base)

    const client = await getClient()
    try {
      await client.query('BEGIN')
      const fill = await client.query<any>(
        `INSERT INTO propane_fills
           (property_id, landlord_id, unit_id, lease_id, tenant_id, gallons,
            price_per_gallon, total_amount, installment_count, created_by_user_id,
            tax_rate_pct, tax_amount)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [unit.property_id, unit.landlord_id, body.unitId, lt.lease_id, lt.tenant_id,
         body.gallons, body.pricePerGallon, total, body.installments, req.user!.userId,
         taxRatePct, taxAmount])
      const fillId = fill.rows[0].id
      const cycle0 = monthStart(new Date())

      // Installment #1 bills IMMEDIATELY: standalone payments row due
      // today, payable through the normal tenant payment flow. PROPANE
      // marker = reporting handle.
      const firstPayment = await client.query<{ id: string }>(
        `INSERT INTO payments
           (unit_id, lease_id, tenant_id, landlord_id, type, amount, status,
            due_date, entry_description, notes)
         VALUES ($1,$2,$3,$4,'utility',$5,'pending',CURRENT_DATE,'PROPANE',$6)
         RETURNING id`,
        [body.unitId, lt.lease_id, lt.tenant_id, unit.landlord_id,
         amounts[0].toFixed(2),
         `Propane fill ${body.gallons} gal @ $${body.pricePerGallon}/gal` +
         (body.installments > 1 ? ` — payment 1 of ${body.installments}` : '')])

      for (let i = 0; i < body.installments; i++) {
        await client.query(
          `INSERT INTO propane_fill_installments
             (fill_id, installment_number, amount, billing_cycle_month, payment_id)
           VALUES ($1,$2,$3,$4,$5)`,
          [fillId, i + 1, amounts[i].toFixed(2), addMonths(cycle0, i),
           i === 0 ? firstPayment.rows[0].id : null])
      }

      // ACCELERATION (Nic): a new fill makes the ENTIRE prior balance
      // due immediately — every not-yet-billed installment from earlier
      // fills on this unit becomes a standalone due-now payment instead
      // of riding future invoices. (Already-billed unpaid rows are
      // already due; nothing to do for those.)
      const priorUnbilled = await client.query<any>(
        `SELECT i.id, i.amount, i.installment_number, f.installment_count, f.gallons
           FROM propane_fill_installments i
           JOIN propane_fills f ON f.id = i.fill_id
          WHERE f.unit_id = $1 AND f.id <> $2 AND i.payment_id IS NULL
          ORDER BY f.fill_date, i.installment_number`,
        [body.unitId, fillId])
      for (const pi of priorUnbilled.rows) {
        const accel = await client.query<{ id: string }>(
          `INSERT INTO payments
             (unit_id, lease_id, tenant_id, landlord_id, type, amount, status,
              due_date, entry_description, notes)
           VALUES ($1,$2,$3,$4,'utility',$5,'pending',CURRENT_DATE,'PROPANE',$6)
           RETURNING id`,
          [body.unitId, lt.lease_id, lt.tenant_id, unit.landlord_id,
           Number(pi.amount).toFixed(2),
           `Propane fill ${pi.gallons} gal — payment ${pi.installment_number} of ${pi.installment_count} (due now: new fill recorded)`])
        await client.query(
          `UPDATE propane_fill_installments SET payment_id = $1, accelerated = TRUE WHERE id = $2`,
          [accel.rows[0].id, pi.id])
      }
      await client.query('COMMIT')
      res.status(201).json({ success: true, data: fill.rows[0] })
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally { client.release() }
  } catch (e) { next(e) }
})

// ── PROPERTY SETTINGS (per-property toggles) ─────────────────
propaneRouter.post('/settings', requirePerm('properties.edit'), async (req, res, next) => {
  try {
    const body = z.object({
      propertyId:             z.string().uuid(),
      allowInstallments:      z.boolean().optional(),
      // S534: landlord-set gallon thresholds for the 2- and 4-way splits.
      splitMinGallons:        z.number().int().min(1).max(9999).optional(),
      splitFourMinGallons:    z.number().int().min(1).max(9999).optional(),
    }).parse(req.body)
    const property = await queryOne<any>(
      `SELECT id, landlord_id, propane_split_min_gallons, propane_split_four_min_gallons
         FROM properties WHERE id = $1`, [body.propertyId])
    if (!property) throw new AppError(404, 'Property not found')
    if (!canAccessLandlordResource(req.user, property.landlord_id)) {
      throw new AppError(403, 'Forbidden')
    }
    const effectiveMin  = body.splitMinGallons ?? Number(property.propane_split_min_gallons)
    const effectiveFour = body.splitFourMinGallons ?? Number(property.propane_split_four_min_gallons)
    if (effectiveFour < effectiveMin) {
      throw new AppError(400, 'The 4-payment minimum can\'t be below the split minimum')
    }
    const updated = await queryOne<any>(
      `UPDATE properties SET
         propane_allow_installments = COALESCE($2, propane_allow_installments),
         propane_split_min_gallons = COALESCE($3, propane_split_min_gallons),
         propane_split_four_min_gallons = COALESCE($4, propane_split_four_min_gallons)
       WHERE id = $1
       RETURNING id, propane_allow_installments,
                 propane_split_min_gallons, propane_split_four_min_gallons`,
      [body.propertyId, body.allowInstallments ?? null,
       body.splitMinGallons ?? null, body.splitFourMinGallons ?? null])
    res.json({ success: true, data: updated })
  } catch (e) { next(e) }
})

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
import { validateFillLine, recordFill } from '../services/propaneFill'

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
    // S613 (Nic): optional unit filter. The unit page asks "does THIS space have
    // propane, and what does it still owe on it" — property-wide with a LIMIT 50
    // would answer neither on a park with a busy winter.
    const unitId = req.query.unitId ? z.string().uuid().parse(req.query.unitId) : null
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
        WHERE f.property_id = $1 AND ($2::uuid IS NULL OR f.unit_id = $2)
        ORDER BY f.fill_date DESC, f.created_at DESC
        LIMIT 50`,
      [propertyId, unitId])
    res.json({ success: true, data: fills })
  } catch (e) { next(e) }
})

const UNIT_FILL_COLS = `u.id, u.landlord_id, u.property_id, u.unit_number,
              u.has_propane_tank,
              p.propane_allow_installments,
              p.propane_split_min_gallons, p.propane_split_four_min_gallons`

propaneRouter.post('/fills', requirePerm('properties.edit'), async (req, res, next) => {
  try {
    const body = z.object({
      unitId:         z.string().uuid(),
      gallons:        z.number().positive().max(9999),
      pricePerGallon: z.number().nonnegative().max(999),
      installments:   z.number().int().refine(n => [1, 2, 4].includes(n), 'installments must be 1, 2, or 4'),
      // Idempotency key: one per "Record fill" intent (money path). A repeat
      // submission with the same key is a no-op — see the tx below.
      clientKey:      z.string().uuid().optional(),
    }).parse(req.body)

    const unit = await queryOne<any>(
      `SELECT ${UNIT_FILL_COLS}
         FROM units u JOIN properties p ON p.id = u.property_id
        WHERE u.id = $1`, [body.unitId])
    if (!unit) throw new AppError(404, 'Unit not found')
    if (!canAccessLandlordResource(req.user, unit.landlord_id)) {
      throw new AppError(403, 'Forbidden')
    }

    const client = await getClient()
    try {
      await client.query('BEGIN')
      // Idempotency (money path): serialize concurrent submits for this unit,
      // then short-circuit a repeat of the same fill intent. Without this a
      // lost-response retry / second open tab records a second fill and
      // double-charges the tenant. See migration 20260806150000.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`propane_fill:${body.unitId}`])
      if (body.clientKey) {
        const dupe = await client.query<any>('SELECT * FROM propane_fills WHERE client_key = $1', [body.clientKey])
        if (dupe.rows.length) {
          await client.query('COMMIT')
          return res.status(200).json({ success: true, data: dupe.rows[0], idempotent: true })
        }
      }
      const { leaseId, tenantId } = await validateFillLine(client, unit, {
        gallons: body.gallons, installments: body.installments })
      const fill = await recordFill(client, {
        unit, leaseId, tenantId,
        gallons: body.gallons, pricePerGallon: body.pricePerGallon,
        installments: body.installments, createdByUserId: req.user!.userId,
        clientKey: body.clientKey ?? null,
      })
      await client.query('COMMIT')
      res.status(201).json({ success: true, data: fill })
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally { client.release() }
  } catch (e) { next(e) }
})

/**
 * POST /api/propane/deliveries — ONE master bill, several tanks.
 *
 * NIC: "We use separate tanks filled on one invoice (master) and then charge
 * tenants according to their gallons that went into their tank... It's already
 * on the bill in terms of gallons, so we just need to be able to type in this
 * many gallons at this unit or some units that don't have it, don't get those
 * gallons because they don't have propane."
 *
 * Recording that meant opening the fill form once per tank and retyping the same
 * price per gallon each time — eight passes for eight homes, transcribing one
 * document.
 *
 * ALL OR NOTHING, deliberately. Every line is validated before any money row is
 * written, so a unit with no active lease stops the whole delivery instead of
 * leaving six tanks recorded and two missing against a bill that has to
 * reconcile. The landlord fixes the one problem and submits the same bill again.
 *
 * A unit with no propane simply isn't in `lines` — nothing to opt out of.
 */
propaneRouter.post('/deliveries', requirePerm('properties.edit'), async (req, res, next) => {
  try {
    const body = z.object({
      propertyId:     z.string().uuid(),
      // One price for the whole delivery — it is what the invoice charged.
      pricePerGallon: z.number().nonnegative().max(999),
      installments:   z.number().int().refine(n => [1, 2, 4].includes(n), 'installments must be 1, 2, or 4').default(1),
      lines: z.array(z.object({
        unitId:  z.string().uuid(),
        gallons: z.number().positive().max(9999),
      })).min(1).max(200),
      clientKey: z.string().uuid().optional(),
    }).parse(req.body)

    // One unit can't appear twice on one delivery — that is a transcription
    // slip, and silently summing it would overbill.
    const seen = new Set<string>()
    for (const l of body.lines) {
      if (seen.has(l.unitId)) throw new AppError(400, 'The same unit is listed twice on this delivery')
      seen.add(l.unitId)
    }

    const property = await queryOne<any>('SELECT id, landlord_id FROM properties WHERE id = $1', [body.propertyId])
    if (!property) throw new AppError(404, 'Property not found')
    if (!canAccessLandlordResource(req.user, property.landlord_id)) {
      throw new AppError(403, 'Forbidden')
    }

    const client = await getClient()
    try {
      await client.query('BEGIN')
      if (body.clientKey) {
        const dupe = await client.query<any>(
          'SELECT id FROM propane_fills WHERE client_key = $1 LIMIT 1', [body.clientKey])
        if (dupe.rows.length) {
          await client.query('COMMIT')
          return res.status(200).json({ success: true, data: { idempotent: true } })
        }
      }

      // Lock every unit up front, in a stable order, so two deliveries recorded
      // at once can't interleave into a double charge.
      for (const unitId of [...seen].sort()) {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`propane_fill:${unitId}`])
      }

      // Resolve + validate EVERY line before writing anything.
      const prepared: any[] = []
      for (const line of body.lines) {
        const unit = await client.query<any>(
          `SELECT ${UNIT_FILL_COLS}
             FROM units u JOIN properties p ON p.id = u.property_id
            WHERE u.id = $1 AND u.property_id = $2`, [line.unitId, body.propertyId])
        if (!unit.rows[0]) throw new AppError(404, 'A unit on this delivery is not at this property')
        const { leaseId, tenantId } = await validateFillLine(client, unit.rows[0], {
          gallons: line.gallons, installments: body.installments })
        prepared.push({ unit: unit.rows[0], leaseId, tenantId, gallons: line.gallons })
      }

      const fills = []
      for (const [i, p] of prepared.entries()) {
        fills.push(await recordFill(client, {
          unit: p.unit, leaseId: p.leaseId, tenantId: p.tenantId,
          gallons: p.gallons, pricePerGallon: body.pricePerGallon,
          installments: body.installments, createdByUserId: req.user!.userId,
          // The key marks the delivery; only the first line carries it, which is
          // enough for the repeat-submit check above.
          clientKey: i === 0 ? (body.clientKey ?? null) : null,
        }))
      }
      await client.query('COMMIT')
      const totalGallons = body.lines.reduce((s, l) => s + l.gallons, 0)
      res.status(201).json({ success: true, data: {
        fills,
        tanks: fills.length,
        totalGallons: Math.round(totalGallons * 100) / 100,
        totalAmount: Math.round(fills.reduce((s, f) => s + Number(f.total_amount), 0) * 100) / 100,
      } })
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

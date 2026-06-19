/**
 * S513 (J) — business discount-code management.
 *
 *   GET    /api/business-discounts                 (list)
 *   POST   /api/business-discounts                 (create)
 *   PATCH  /api/business-discounts/:id             (edit / toggle active)
 *   DELETE /api/business-discounts/:id             (delete if never used)
 *   POST   /api/business-discounts/preview         (validate + compute, no redeem)
 *
 * Codes are stored upper-cased + unique per business. The PREVIEW
 * endpoint is what the POS/invoice UIs call to show the customer the
 * discount before finalizing; the authoritative apply (with redemption
 * increment) happens inside the sale/invoice transaction via
 * services/businessDiscounts.applyDiscount.
 */

import { Router } from 'express'
import { z } from 'zod'
import { db, query, queryOne } from '../db'
import { requireAuth } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { requireBusinessAccess } from '../middleware/businessAccess'
import { BUSINESS_DISCOUNT_TYPES } from '@gam/shared'
import { resolveDiscountCode, computeDiscountAmount } from '../services/businessDiscounts'

export const businessDiscountsRouter = Router()

const requireRead  = async (req: any) => (await requireBusinessAccess(req, { permission: 'discounts.read',  feature: 'discounts' })).businessId
const requireWrite = async (req: any) => (await requireBusinessAccess(req, { permission: 'discounts.write', feature: 'discounts' })).businessId

const codeRegex = /^[A-Za-z0-9_-]+$/

const createSchema = z.object({
  code:           z.string().min(1).max(40).regex(codeRegex, 'Letters, numbers, dashes, underscores only'),
  description:    z.string().max(500).nullable().optional(),
  discountType:   z.enum(BUSINESS_DISCOUNT_TYPES),
  discountValue:  z.number().min(0),
  isActive:       z.boolean().optional(),
  startsAt:       z.string().datetime().nullable().optional(),
  expiresAt:      z.string().datetime().nullable().optional(),
  maxRedemptions: z.number().int().positive().nullable().optional(),
}).refine(d => d.discountType !== 'percent' || d.discountValue <= 100, {
  message: 'Percent discount cannot exceed 100', path: ['discountValue'],
}).refine(d => !d.startsAt || !d.expiresAt || new Date(d.expiresAt) > new Date(d.startsAt), {
  message: 'expiresAt must be after startsAt', path: ['expiresAt'],
})

// ═══════════════════════════════════════════════════════════════
//  GET / — list
// ═══════════════════════════════════════════════════════════════
businessDiscountsRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireRead(req)
    const rows = await query<any>(
      `SELECT * FROM business_discount_codes
        WHERE business_id = $1
        ORDER BY is_active DESC, created_at DESC`, [businessId])
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

// ═══════════════════════════════════════════════════════════════
//  POST / — create
// ═══════════════════════════════════════════════════════════════
businessDiscountsRouter.post('/', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireWrite(req)
    const body = createSchema.parse(req.body)
    const code = body.code.trim().toUpperCase()

    const dup = await queryOne<{ id: string }>(
      `SELECT id FROM business_discount_codes WHERE business_id = $1 AND code = $2`,
      [businessId, code])
    if (dup) throw new AppError(409, `Discount code "${code}" already exists`)

    const row = await queryOne<any>(
      `INSERT INTO business_discount_codes
         (business_id, code, description, discount_type, discount_value,
          is_active, starts_at, expires_at, max_redemptions, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [businessId, code, body.description ?? null,
       body.discountType, body.discountValue,
       body.isActive ?? true,
       body.startsAt ?? null, body.expiresAt ?? null,
       body.maxRedemptions ?? null, req.user!.userId])
    res.status(201).json({ success: true, data: row })
  } catch (e) { next(e) }
})

// ═══════════════════════════════════════════════════════════════
//  PATCH /:id — edit / toggle
// ═══════════════════════════════════════════════════════════════
const patchSchema = z.object({
  description:    z.string().max(500).nullable().optional(),
  discountType:   z.enum(BUSINESS_DISCOUNT_TYPES).optional(),
  discountValue:  z.number().min(0).optional(),
  isActive:       z.boolean().optional(),
  startsAt:       z.string().datetime().nullable().optional(),
  expiresAt:      z.string().datetime().nullable().optional(),
  maxRedemptions: z.number().int().positive().nullable().optional(),
})

businessDiscountsRouter.patch('/:id', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireWrite(req)
    const body = patchSchema.parse(req.body)

    const existing = await queryOne<any>(
      `SELECT * FROM business_discount_codes WHERE id = $1 AND business_id = $2`,
      [req.params.id, businessId])
    if (!existing) throw new AppError(404, 'Discount code not found')

    // Merge to validate the resulting type/value + window together.
    const nextType  = body.discountType  ?? existing.discount_type
    const nextValue = body.discountValue ?? Number(existing.discount_value)
    if (nextType === 'percent' && nextValue > 100) {
      throw new AppError(400, 'Percent discount cannot exceed 100')
    }
    const nextStarts  = body.startsAt  !== undefined ? body.startsAt  : existing.starts_at
    const nextExpires = body.expiresAt !== undefined ? body.expiresAt : existing.expires_at
    if (nextStarts && nextExpires && new Date(nextExpires) <= new Date(nextStarts)) {
      throw new AppError(400, 'expiresAt must be after startsAt')
    }
    if (existing.max_redemptions === null && body.maxRedemptions != null
        && body.maxRedemptions < existing.redemption_count) {
      throw new AppError(400, 'max redemptions cannot be below the current redemption count')
    }

    const sets: string[] = []
    const params: any[] = []
    const set = (col: string, val: any) => { params.push(val); sets.push(`${col} = $${params.length}`) }
    if (body.description    !== undefined) set('description', body.description)
    if (body.discountType   !== undefined) set('discount_type', body.discountType)
    if (body.discountValue  !== undefined) set('discount_value', body.discountValue)
    if (body.isActive       !== undefined) set('is_active', body.isActive)
    if (body.startsAt       !== undefined) set('starts_at', body.startsAt)
    if (body.expiresAt      !== undefined) set('expires_at', body.expiresAt)
    if (body.maxRedemptions !== undefined) set('max_redemptions', body.maxRedemptions)
    if (sets.length === 0) { res.json({ success: true, data: existing }); return }

    params.push(req.params.id, businessId)
    const row = await queryOne<any>(
      `UPDATE business_discount_codes SET ${sets.join(', ')}
        WHERE id = $${params.length - 1} AND business_id = $${params.length}
        RETURNING *`, params)
    res.json({ success: true, data: row })
  } catch (e) { next(e) }
})

// ═══════════════════════════════════════════════════════════════
//  DELETE /:id — delete if never redeemed, else 409 (deactivate)
// ═══════════════════════════════════════════════════════════════
businessDiscountsRouter.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireWrite(req)
    const existing = await queryOne<{ redemption_count: number }>(
      `SELECT redemption_count FROM business_discount_codes
        WHERE id = $1 AND business_id = $2`, [req.params.id, businessId])
    if (!existing) throw new AppError(404, 'Discount code not found')
    if (existing.redemption_count > 0) {
      throw new AppError(409,
        'This code has been used and is kept for sale history. Deactivate it instead of deleting.')
    }
    await query(`DELETE FROM business_discount_codes WHERE id = $1 AND business_id = $2`,
      [req.params.id, businessId])
    res.json({ success: true })
  } catch (e) { next(e) }
})

// ═══════════════════════════════════════════════════════════════
//  POST /preview — validate + compute (no redemption consumed)
// ═══════════════════════════════════════════════════════════════
const previewSchema = z.object({
  code:     z.string().min(1).max(40),
  subtotal: z.number().min(0),
})

businessDiscountsRouter.post('/preview', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireRead(req)
    const body = previewSchema.parse(req.body)
    const client = await db.connect()
    try {
      const row = await resolveDiscountCode(client, businessId, body.code)
      const discountAmount = computeDiscountAmount(
        row.discount_type, Number(row.discount_value), body.subtotal)
      res.json({ success: true, data: {
        discountCodeId: row.id,
        code: row.code,
        discountType: row.discount_type,
        discountValue: Number(row.discount_value),
        discountAmount,
      } })
    } finally { client.release() }
  } catch (e) { next(e) }
})

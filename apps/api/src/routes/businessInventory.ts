/**
 * S496 — business-portal inventory CRUD.
 *
 * Endpoints:
 *   GET    /api/business-inventory/categories
 *   POST   /api/business-inventory/categories
 *   PATCH  /api/business-inventory/categories/:id
 *   DELETE /api/business-inventory/categories/:id          (sets items.category_id NULL)
 *
 *   GET    /api/business-inventory/items                   (lowStock filter, search, category filter)
 *   POST   /api/business-inventory/items
 *   GET    /api/business-inventory/items/:id               (with recent adjustments)
 *   PATCH  /api/business-inventory/items/:id
 *   POST   /api/business-inventory/items/:id/adjust        (stock change + audit row)
 *   POST   /api/business-inventory/items/:id/archive
 *
 * Owner-only for now. Staff write access lands with the per-staff
 * permission framework. The `inventory` feature gate is enforced on
 * every endpoint so a direct API call when the feature is disabled
 * gets a 403 with hint.
 */

import { Router } from 'express'
import { z } from 'zod'
import { db, query, queryOne } from '../db'
import { requireAuth } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'

export const businessInventoryRouter = Router()

// ── helpers ────────────────────────────────────────────────────
// S502: split owner-only gate by permission. Reads (list, detail) →
// inventory.read; CRUD writes → inventory.write; stock adjustments →
// inventory.adjust (a stricter permission since the audit trail is
// load-bearing for POS + WO reference).
import { requireBusinessAccess } from '../middleware/businessAccess'

const requireRead   = async (req: any) => (await requireBusinessAccess(req, { permission: 'inventory.read',   feature: 'inventory' })).businessId
const requireWrite  = async (req: any) => (await requireBusinessAccess(req, { permission: 'inventory.write',  feature: 'inventory' })).businessId
const requireAdjust = async (req: any) => (await requireBusinessAccess(req, { permission: 'inventory.adjust', feature: 'inventory' })).businessId

// ═══════════════════════════════════════════════════════════════
//  Categories
// ═══════════════════════════════════════════════════════════════

const categorySchema = z.object({
  name:      z.string().min(1).max(120),
  sortOrder: z.number().int().min(0).optional(),
})

businessInventoryRouter.get('/categories', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireRead(req)
    const rows = await query<any>(
      `SELECT id, name, sort_order, created_at
         FROM business_inventory_categories
        WHERE business_id = $1
        ORDER BY sort_order ASC, name ASC`, [businessId])
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

businessInventoryRouter.post('/categories', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireWrite(req)
    const body = categorySchema.parse(req.body)
    const r = await queryOne<any>(
      `INSERT INTO business_inventory_categories
         (business_id, name, sort_order)
       VALUES ($1, $2, $3)
       RETURNING id, name, sort_order, created_at`,
      [businessId, body.name.trim(), body.sortOrder ?? 0])
    res.status(201).json({ success: true, data: r })
  } catch (e) { next(e) }
})

businessInventoryRouter.patch('/categories/:id', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireWrite(req)
    const body = categorySchema.partial().parse(req.body)
    if (Object.keys(body).length === 0) {
      throw new AppError(400, 'Nothing to update')
    }
    const r = await query<any>(
      `UPDATE business_inventory_categories
          SET name       = COALESCE($1, name),
              sort_order = COALESCE($2, sort_order)
        WHERE id = $3 AND business_id = $4
        RETURNING id, name, sort_order`,
      [body.name?.trim() ?? null, body.sortOrder ?? null, req.params.id, businessId])
    if (r.length === 0) throw new AppError(404, 'Category not found')
    res.json({ success: true, data: r[0] })
  } catch (e) { next(e) }
})

businessInventoryRouter.delete('/categories/:id', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireWrite(req)
    const r = await query<{ id: string }>(
      `DELETE FROM business_inventory_categories
        WHERE id = $1 AND business_id = $2
        RETURNING id`,
      [req.params.id, businessId])
    if (r.length === 0) throw new AppError(404, 'Category not found')
    // Items previously in this category get category_id=NULL via the
    // FK ON DELETE SET NULL clause.
    res.json({ success: true, data: r[0] })
  } catch (e) { next(e) }
})

// ═══════════════════════════════════════════════════════════════
//  Items — POST / GET list
// ═══════════════════════════════════════════════════════════════

const itemCreateSchema = z.object({
  name:        z.string().min(1).max(200),
  sku:         z.string().max(120).nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
  categoryId:  z.string().uuid().nullable().optional(),
  costPrice:   z.number().min(0).optional(),
  sellPrice:   z.number().min(0).optional(),
  taxRate:     z.number().min(0).max(0.9999).optional(),
  stockQty:    z.number().int().min(0).optional(),
  stockMin:    z.number().int().min(0).optional(),
  stockMax:    z.number().int().min(0).optional(),
})

businessInventoryRouter.post('/items', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireWrite(req)
    const body = itemCreateSchema.parse(req.body)

    // If categoryId supplied, verify it belongs to this business.
    if (body.categoryId) {
      const c = await queryOne<{ id: string }>(
        `SELECT id FROM business_inventory_categories
          WHERE id = $1 AND business_id = $2`,
        [body.categoryId, businessId])
      if (!c) throw new AppError(404, 'Category not found')
    }

    const r = await queryOne<any>(
      `INSERT INTO business_inventory_items
         (business_id, category_id, name, sku, description,
          cost_price, sell_price, tax_rate,
          stock_qty, stock_min, stock_max)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [businessId,
       body.categoryId ?? null,
       body.name.trim(),
       body.sku?.trim() || null,
       body.description?.trim() || null,
       body.costPrice ?? 0,
       body.sellPrice ?? 0,
       body.taxRate ?? 0,
       body.stockQty ?? 0,
       body.stockMin ?? 0,
       body.stockMax ?? 0])

    // Initial stock count writes an audit row when stock_qty > 0.
    if ((body.stockQty ?? 0) > 0) {
      await query(
        `INSERT INTO business_inventory_adjustments
           (business_id, item_id, adjustment_type,
            quantity_delta, stock_qty_after, notes,
            actor_user_id, reference_type)
         VALUES ($1, $2, 'count', $3, $3, 'Initial stock at item creation', $4, 'manual')`,
        [businessId, r.id, body.stockQty ?? 0, req.user!.userId])
    }

    res.status(201).json({ success: true, data: r })
  } catch (e) { next(e) }
})

const itemListSchema = z.object({
  lowStock:   z.coerce.boolean().optional(),
  categoryId: z.string().uuid().optional(),
  q:          z.string().min(1).max(200).optional(),
  includeArchived: z.coerce.boolean().optional(),
  limit:      z.coerce.number().int().positive().max(500).optional(),
})

businessInventoryRouter.get('/items', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireRead(req)
    const q = itemListSchema.parse(req.query)
    const params: any[] = [businessId]
    let whereSql = 'WHERE i.business_id = $1'
    if (!q.includeArchived) whereSql += ` AND i.is_active = TRUE`
    if (q.categoryId) { params.push(q.categoryId); whereSql += ` AND i.category_id = $${params.length}` }
    if (q.lowStock)   whereSql += ` AND i.stock_qty <= i.stock_min AND i.stock_min > 0`
    if (q.q) {
      params.push(`%${q.q}%`)
      const idx = params.length
      whereSql += ` AND (LOWER(i.name) LIKE LOWER($${idx}) OR LOWER(i.sku) LIKE LOWER($${idx}))`
    }
    params.push(q.limit ?? 200)
    const rows = await query<any>(
      `SELECT i.id, i.name, i.sku, i.description,
              i.cost_price, i.sell_price, i.tax_rate,
              i.stock_qty, i.stock_min, i.stock_max,
              i.is_active, i.archived_at, i.created_at, i.updated_at,
              i.category_id,
              c.name AS category_name
         FROM business_inventory_items i
         LEFT JOIN business_inventory_categories c ON c.id = i.category_id
         ${whereSql}
        ORDER BY i.name ASC
        LIMIT $${params.length}`, params)
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

businessInventoryRouter.get('/items/:id', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireRead(req)
    const inv = await queryOne<any>(
      `SELECT i.*, c.name AS category_name
         FROM business_inventory_items i
         LEFT JOIN business_inventory_categories c ON c.id = i.category_id
        WHERE i.id = $1 AND i.business_id = $2`,
      [req.params.id, businessId])
    if (!inv) throw new AppError(404, 'Item not found')
    const adjustments = await query<any>(
      `SELECT id, adjustment_type, quantity_delta, stock_qty_after,
              notes, reference_type, reference_id, created_at
         FROM business_inventory_adjustments
        WHERE item_id = $1
        ORDER BY created_at DESC
        LIMIT 50`, [inv.id])
    res.json({ success: true, data: { ...inv, adjustments } })
  } catch (e) { next(e) }
})

const itemPatchSchema = z.object({
  name:        z.string().min(1).max(200).optional(),
  sku:         z.string().max(120).nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
  categoryId:  z.string().uuid().nullable().optional(),
  costPrice:   z.number().min(0).optional(),
  sellPrice:   z.number().min(0).optional(),
  taxRate:     z.number().min(0).max(0.9999).optional(),
  stockMin:    z.number().int().min(0).optional(),
  stockMax:    z.number().int().min(0).optional(),
}).strict()

// PATCH does NOT touch stock_qty — use /:id/adjust for that.
businessInventoryRouter.patch('/items/:id', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireWrite(req)
    const body = itemPatchSchema.parse(req.body)
    if (Object.keys(body).length === 0) throw new AppError(400, 'Nothing to update')

    if (body.categoryId) {
      const c = await queryOne<{ id: string }>(
        `SELECT id FROM business_inventory_categories
          WHERE id = $1 AND business_id = $2`,
        [body.categoryId, businessId])
      if (!c) throw new AppError(404, 'Category not found')
    }

    const r = await query<any>(
      `UPDATE business_inventory_items
          SET name        = COALESCE($1, name),
              sku         = COALESCE($2, sku),
              description = COALESCE($3, description),
              category_id = COALESCE($4, category_id),
              cost_price  = COALESCE($5, cost_price),
              sell_price  = COALESCE($6, sell_price),
              tax_rate    = COALESCE($7, tax_rate),
              stock_min   = COALESCE($8, stock_min),
              stock_max   = COALESCE($9, stock_max)
        WHERE id = $10 AND business_id = $11
        RETURNING *`,
      [
        body.name?.trim() ?? null,
        body.sku === null ? null : (body.sku?.trim() ?? null),
        body.description === null ? null : (body.description?.trim() ?? null),
        body.categoryId ?? null,
        body.costPrice ?? null,
        body.sellPrice ?? null,
        body.taxRate   ?? null,
        body.stockMin  ?? null,
        body.stockMax  ?? null,
        req.params.id, businessId,
      ])
    if (r.length === 0) throw new AppError(404, 'Item not found')
    res.json({ success: true, data: r[0] })
  } catch (e) { next(e) }
})

// ═══════════════════════════════════════════════════════════════
//  Stock adjustment (atomic: update item + insert audit row)
// ═══════════════════════════════════════════════════════════════

const adjustSchema = z.object({
  adjustmentType: z.enum(['received', 'sold', 'used', 'shrinkage', 'count', 'manual']),
  // For non-'count' types: quantityDelta signed (positive = stock in,
  // negative = stock out). For 'count': resultingQty (absolute number);
  // we compute delta from current stock_qty.
  quantityDelta:  z.number().int().optional(),
  resultingQty:   z.number().int().min(0).optional(),
  notes:          z.string().max(500).nullable().optional(),
  referenceType:  z.enum(['pos_transaction', 'work_order', 'manual', 'count']).optional(),
  referenceId:    z.string().uuid().optional(),
})

businessInventoryRouter.post('/items/:id/adjust', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireAdjust(req)
    const body = adjustSchema.parse(req.body)

    if (body.adjustmentType === 'count') {
      if (body.resultingQty === undefined) {
        throw new AppError(400, 'resultingQty required for count adjustment')
      }
    } else {
      if (body.quantityDelta === undefined) {
        throw new AppError(400, 'quantityDelta required for non-count adjustment')
      }
    }

    const client = await db.connect()
    try {
      await client.query('BEGIN')

      // SELECT with row lock so concurrent adjustments serialize.
      const { rows: [item] } = await client.query<{
        id: string; stock_qty: number;
      }>(
        `SELECT id, stock_qty
           FROM business_inventory_items
          WHERE id = $1 AND business_id = $2
          FOR UPDATE`,
        [req.params.id, businessId])
      if (!item) {
        await client.query('ROLLBACK')
        throw new AppError(404, 'Item not found')
      }

      let delta: number
      let resulting: number
      if (body.adjustmentType === 'count') {
        resulting = body.resultingQty!
        delta = resulting - item.stock_qty
      } else {
        delta = body.quantityDelta!
        resulting = item.stock_qty + delta
        if (resulting < 0) {
          await client.query('ROLLBACK')
          throw new AppError(400, `Adjustment would put stock below 0 (current ${item.stock_qty}, delta ${delta})`)
        }
      }

      await client.query(
        `UPDATE business_inventory_items
            SET stock_qty = $1
          WHERE id = $2`,
        [resulting, item.id])
      const { rows: [adj] } = await client.query<any>(
        `INSERT INTO business_inventory_adjustments
           (business_id, item_id, adjustment_type,
            quantity_delta, stock_qty_after, notes,
            actor_user_id, reference_type, reference_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [businessId, item.id, body.adjustmentType,
         delta, resulting, body.notes ?? null,
         req.user!.userId,
         body.referenceType ?? 'manual',
         body.referenceId ?? null])

      await client.query('COMMIT')
      res.json({ success: true, data: adj })
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
    }
  } catch (e) { next(e) }
})

// ═══════════════════════════════════════════════════════════════
//  Archive
// ═══════════════════════════════════════════════════════════════

businessInventoryRouter.post('/items/:id/archive', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireWrite(req)
    const r = await query<{ id: string; is_active: boolean }>(
      `UPDATE business_inventory_items
          SET is_active   = FALSE,
              archived_at = NOW()
        WHERE id = $1 AND business_id = $2 AND is_active = TRUE
        RETURNING id, is_active`,
      [req.params.id, businessId])
    if (r.length === 0) throw new AppError(404, 'Item not found or already archived')
    res.json({ success: true, data: r[0] })
  } catch (e) { next(e) }
})

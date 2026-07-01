import { Router } from 'express'
import { query, queryOne, getClient } from '../db'
import { requireAuth, requirePerm } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { calculateCartTax } from '../services/posTax'
import {
  createConnectionToken, registerReader, listReaders, archiveReader,
  createCardPresentPaymentIntent, processPaymentIntentOnReader,
  captureTerminalPaymentIntent, cancelTerminalPaymentIntent,
  retrieveTerminalPaymentIntent,
} from '../services/posTerminal'
import crypto from 'crypto'
import { logger } from '../lib/logger'

export const posRouter = Router()
posRouter.use(requireAuth)

// S227: DEFAULT_ITEMS.category strings now align with DEFAULT_CATEGORIES
// names (Title Case). Pre-S227 they were lowercase ('fuel' / 'amenity'),
// which created a latent bug — fresh landlords got items in lowercase
// "fuel" and management-UI categories in titlecase "Fuel," meaning
// renames on the management side never linked back. With the FK refactor
// the names must match exactly so the seed lookup resolves.
const DEFAULT_ITEMS = [
  { name:'Propane 20lb',    category:'Fuel',     icon:'⛽', sell_price:24.99, cost_price:14.00, tax_rate:.08, stock_qty:20, stock_min:5,  stock_max:50 },
  { name:'Propane Refill',  category:'Fuel',     icon:'🔧', sell_price:14.99, cost_price:8.00,  tax_rate:.08, stock_qty:20, stock_min:5,  stock_max:50 },
  { name:'Firewood Bundle', category:'Amenity',  icon:'🪵', sell_price:8.99,  cost_price:3.00,  tax_rate:.08, stock_qty:30, stock_min:10, stock_max:100 },
  { name:'Firewood Box',    category:'Amenity',  icon:'🔥', sell_price:24.99, cost_price:10.00, tax_rate:.08, stock_qty:10, stock_min:3,  stock_max:30 },
  { name:'Ice Bag 10lb',    category:'Misc',     icon:'🧊', sell_price:3.99,  cost_price:1.50,  tax_rate:.08, stock_qty:50, stock_min:20, stock_max:200 },
  { name:'Washer Load',     category:'Laundry',  icon:'🧺', sell_price:2.50,  cost_price:0.50,  tax_rate:0,   stock_qty:999,stock_min:999,stock_max:999 },
  { name:'Dryer Load',      category:'Laundry',  icon:'🌀', sell_price:2.00,  cost_price:0.40,  tax_rate:0,   stock_qty:999,stock_min:999,stock_max:999 },
  { name:'Parking Day',     category:'Parking',  icon:'🅿️', sell_price:10.00, cost_price:0,     tax_rate:0,   stock_qty:999,stock_min:999,stock_max:999 },
  { name:'Parking Month',   category:'Parking',  icon:'🚗', sell_price:75.00, cost_price:0,     tax_rate:0,   stock_qty:999,stock_min:999,stock_max:999 },
  { name:'Late Fee',        category:'Fee',      icon:'⏰', sell_price:75.00, cost_price:0,     tax_rate:0,   stock_qty:999,stock_min:999,stock_max:999, charge_eligible:false },
  { name:'Key Replace',     category:'Fee',      icon:'🔑', sell_price:25.00, cost_price:5.00,  tax_rate:0,   stock_qty:10, stock_min:3,  stock_max:20 },
  { name:'Pool Pass Day',   category:'Amenity',  icon:'🏊', sell_price:5.00,  cost_price:0,     tax_rate:0,   stock_qty:999,stock_min:999,stock_max:999 },
  { name:'Early Check-in',  category:'Amenity',  icon:'🌅', sell_price:35.00, cost_price:0,     tax_rate:.08, stock_qty:999,stock_min:999,stock_max:999, charge_eligible:false },
  { name:'Late Checkout',   category:'Amenity',  icon:'🌆', sell_price:35.00, cost_price:0,     tax_rate:.08, stock_qty:999,stock_min:999,stock_max:999, charge_eligible:false },
  { name:'Pet Fee Daily',   category:'Fee',      icon:'🐾', sell_price:15.00, cost_price:0,     tax_rate:0,   stock_qty:999,stock_min:999,stock_max:999 },
  { name:'Cleaning Fee',    category:'Fee',      icon:'🧹', sell_price:85.00, cost_price:25.00, tax_rate:.08, stock_qty:999,stock_min:999,stock_max:999, charge_eligible:false },
]

const DEFAULT_CATEGORIES = [
  { name:'Fuel', icon:'⛽', sort_order:1 },
  { name:'Amenity', icon:'🏊', sort_order:2 },
  { name:'Laundry', icon:'🧺', sort_order:3 },
  { name:'Parking', icon:'🅿️', sort_order:4 },
  { name:'Fee', icon:'📋', sort_order:5 },
  { name:'Misc', icon:'📦', sort_order:6 },
]

// ── ITEMS ─────────────────────────────────────────────────────

// GET /api/pos/items
//
// S192: optional ?propertyId= filter. When provided, returns
// (items at that property) UNION (landlord-wide items with NULL
// property_id) — landlord-wide stays visible at every property.
// When omitted, returns all items under the landlord (legacy
// behavior; the inventory-management surface needs to see every
// item regardless of property scope).
posRouter.get('/items', requirePerm('pos.ring_sale', 'pos.manage_inventory'), async (req, res, next) => {
  try {
    const propertyFilter = req.query.propertyId as string | undefined

    // S227: JOIN pos_categories to surface the category name alongside
    // the FK column. Frontend reads `item.category` (string) for display
    // and `item.categoryId` (uuid) for writes.
    //
    // S241: items are per-property now (pos_items.property_id NOT NULL).
    // Querying without a propertyFilter returns ALL items across all the
    // landlord's properties — same shape as before for back-compat, but
    // every row carries property_id and frontends should filter or
    // group by it.
    let items: any[]
    if (propertyFilter) {
      items = await query<any>(
        `SELECT pi.*, pc.name AS category, tc.name AS tax_category,
                COALESCE(tc.rate, pi.tax_rate, 0) AS tax_rate
          FROM pos_items pi
          LEFT JOIN pos_categories pc ON pc.id = pi.category_id
          LEFT JOIN pos_tax_categories tc ON tc.id = pi.tax_category_id
          WHERE pi.landlord_id = $1
            AND pi.is_active = TRUE
            AND pi.property_id = $2
          ORDER BY pc.name, pi.name`,
        [req.user!.profileId, propertyFilter],
      )
    } else {
      items = await query<any>(
        `SELECT pi.*, pc.name AS category, tc.name AS tax_category,
                COALESCE(tc.rate, pi.tax_rate, 0) AS tax_rate
          FROM pos_items pi
          LEFT JOIN pos_categories pc ON pc.id = pi.category_id
          LEFT JOIN pos_tax_categories tc ON tc.id = pi.tax_category_id
          WHERE pi.landlord_id=$1 AND pi.is_active=TRUE
          ORDER BY pc.name, pi.name`,
        [req.user!.profileId],
      )
    }

    // S241: seed defaults if the landlord has zero POS items AND the
    // caller passed a propertyId to seed against. Pre-S241 the seed
    // wrote landlord-wide rows (property_id NULL); that's no longer a
    // valid posture — items MUST belong to a property. If the caller
    // didn't specify a property, skip seeding; the landlord picks a
    // property in the POS UI first, then we seed against that one.
    if (items.length === 0 && propertyFilter) {
      for (const cat of DEFAULT_CATEGORIES) {
        await query(
          `INSERT INTO pos_categories (landlord_id, name, icon, sort_order)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (landlord_id, name) DO NOTHING`,
          [req.user!.profileId, cat.name, cat.icon, cat.sort_order],
        )
      }
      const cats = await query<{ id: string; name: string }>(
        'SELECT id, name FROM pos_categories WHERE landlord_id=$1',
        [req.user!.profileId],
      )
      const catIdByName = new Map(cats.map(c => [c.name, c.id]))
      for (const item of DEFAULT_ITEMS) {
        const catId = catIdByName.get(item.category)
        if (!catId) continue  // defensive — shouldn't happen since we just seeded
        await query(`INSERT INTO pos_items (landlord_id,property_id,name,category_id,icon,sell_price,cost_price,tax_rate,stock_qty,stock_min,stock_max,charge_eligible,margin_pct)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,ROUND((($6-$7)/$6)*100,2))`,
          [req.user!.profileId, propertyFilter, item.name, catId, item.icon, item.sell_price,
           item.cost_price, item.tax_rate, item.stock_qty, item.stock_min, item.stock_max,
           item.charge_eligible ?? true])
      }
      items = await query<any>(
        `SELECT pi.*, pc.name AS category
          FROM pos_items pi
          LEFT JOIN pos_categories pc ON pc.id = pi.category_id
          WHERE pi.landlord_id=$1 AND pi.is_active=TRUE AND pi.property_id=$2
          ORDER BY pc.name, pi.name`,
        [req.user!.profileId, propertyFilter],
      )
    }

    res.json({ success: true, data: items })
  } catch (e) { next(e) }
})

// POST /api/pos/items
// S227: now requires categoryId (uuid). The free-text `category` field
// is gone — frontend must pre-resolve via GET /pos/categories.
// GET /api/pos/settings — business-level POS config (default margin).
posRouter.get('/settings', requirePerm('pos.ring_sale', 'pos.manage_inventory'), async (req, res, next) => {
  try {
    const row = await queryOne<{ pos_default_margin_pct: string | null; business_name: string | null }>(
      `SELECT pos_default_margin_pct, business_name FROM landlords WHERE id = $1`, [req.user!.profileId])
    res.json({ success: true, data: {
      defaultMarginPct: row?.pos_default_margin_pct != null ? Number(row.pos_default_margin_pct) : null,
      businessName: row?.business_name || null,
    } })
  } catch (e) { next(e) }
})

// PATCH /api/pos/settings — set the business default margin (null clears it).
posRouter.patch('/settings', requirePerm('pos.manage_inventory'), async (req, res, next) => {
  try {
    const { defaultMarginPct } = req.body
    let val: number | null = null
    if (defaultMarginPct !== null && defaultMarginPct !== undefined && defaultMarginPct !== '') {
      val = Number(defaultMarginPct)
      if (!Number.isFinite(val) || val < 0 || val >= 100) throw new AppError(400, 'Margin must be 0–99.99%')
    }
    await query(`UPDATE landlords SET pos_default_margin_pct = $1 WHERE id = $2`, [val, req.user!.profileId])
    res.json({ success: true, data: { defaultMarginPct: val } })
  } catch (e) { next(e) }
})

posRouter.post('/items', requirePerm('pos.manage_inventory'), async (req, res, next) => {
  try {
    const { name, categoryId, icon, costPrice, sellPrice, marginPct, taxRate,
            chargeEligible, stockQty, stockMin, stockMax, vendorId, shelfLabelEnabled,
            propertyId, taxCategoryId } = req.body

    if (!categoryId) {
      throw new AppError(400, 'categoryId is required')
    }
    // S241: propertyId now required (NOT NULL at the schema level).
    if (!propertyId) {
      throw new AppError(400, 'propertyId is required — items are per-property')
    }
    const cat = await queryOne<{ landlord_id: string }>(
      `SELECT landlord_id FROM pos_categories WHERE id = $1`,
      [categoryId],
    )
    if (!cat || cat.landlord_id !== req.user!.profileId) {
      throw new AppError(400, 'categoryId does not belong to this landlord')
    }

    const margin = marginPct ?? (costPrice > 0 ? ((sellPrice - costPrice) / sellPrice) * 100 : null)

    // Validate propertyId belongs to this landlord.
    const prop = await queryOne<{ landlord_id: string }>(
      `SELECT landlord_id FROM properties WHERE id = $1`,
      [propertyId],
    )
    if (!prop || prop.landlord_id !== req.user!.profileId) {
      throw new AppError(400, 'propertyId does not belong to this landlord')
    }

    const item = await queryOne<any>(`INSERT INTO pos_items
      (landlord_id,property_id,name,category_id,icon,cost_price,sell_price,margin_pct,tax_rate,charge_eligible,stock_qty,stock_min,stock_max,vendor_id,shelf_label_enabled,tax_category_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [req.user!.profileId, propertyId, name, categoryId, icon||'📦', costPrice||0, sellPrice,
       margin, taxRate||0, chargeEligible??true, stockQty||0, stockMin||5, stockMax||50,
       vendorId||null, shelfLabelEnabled??true, taxCategoryId||null])

    res.status(201).json({ success: true, data: item })
  } catch (e) { next(e) }
})

// PATCH /api/pos/items/:id
// S227: accepts categoryId (uuid). Validates ownership before assignment.
posRouter.patch('/items/:id', requirePerm('pos.manage_inventory'), async (req, res, next) => {
  try {
    const item = await queryOne<any>('SELECT * FROM pos_items WHERE id=$1 AND landlord_id=$2', [req.params.id, req.user!.profileId])
    if (!item) throw new AppError(404, 'Item not found')

    const { name, categoryId, icon, costPrice, sellPrice, marginPct, taxRate,
            chargeEligible, stockMin, stockMax, vendorId, isActive, propertyId, taxCategoryId } = req.body
    // undefined preserves; null/value re-assigns the tax category.
    const newTaxCategoryId = taxCategoryId !== undefined ? (taxCategoryId || null) : item.tax_category_id

    const newSellPrice = sellPrice ?? item.sell_price
    const newCostPrice = costPrice ?? item.cost_price

    // S227: categoryId — undefined preserves, uuid re-assigns. Null is
    // not allowed (NOT NULL on the column).
    let newCategoryId: string = item.category_id
    if (categoryId !== undefined) {
      if (!categoryId) {
        throw new AppError(400, 'categoryId cannot be null')
      }
      const cat = await queryOne<{ landlord_id: string }>(
        `SELECT landlord_id FROM pos_categories WHERE id = $1`,
        [categoryId],
      )
      if (!cat || cat.landlord_id !== req.user!.profileId) {
        throw new AppError(400, 'categoryId does not belong to this landlord')
      }
      newCategoryId = categoryId
    }

    // S192: propertyId update — null clears, undefined preserves, uuid
    // re-assigns. Validate ownership when reassigning.
    let newPropertyId: string | null = item.property_id
    if (propertyId === null) {
      newPropertyId = null
    } else if (propertyId !== undefined) {
      const prop = await queryOne<{ landlord_id: string }>(
        `SELECT landlord_id FROM properties WHERE id = $1`,
        [propertyId],
      )
      if (!prop || prop.landlord_id !== req.user!.profileId) {
        throw new AppError(400, 'propertyId does not belong to this landlord')
      }
      newPropertyId = propertyId
    }

    // S389 fix (S388 finding 3): vendorId scope validation. Pre-fix,
    // vendorId was written without an ownership check — a landlord
    // could PATCH their pos_item to reference another landlord's
    // vendor, and the GET /items LEFT JOIN would surface the wrong
    // vendor name. Same class as the books.ts bill scope-bypass fixed
    // in S386. Null clears, undefined preserves, uuid re-assigns.
    let newVendorId: string | null = item.vendor_id
    if (vendorId === null) {
      newVendorId = null
    } else if (vendorId !== undefined) {
      const v = await queryOne<{ landlord_id: string }>(
        `SELECT landlord_id FROM pos_vendors WHERE id = $1`,
        [vendorId],
      )
      if (!v || v.landlord_id !== req.user!.profileId) {
        throw new AppError(400, 'vendorId does not belong to this landlord')
      }
      newVendorId = vendorId
    }

    // S99: price_history is now written by a BEFORE UPDATE trigger on
    // pos_items (fn_pos_items_log_price_change). The trigger reads the
    // actor uuid from a session GUC; set it here so the row records
    // who initiated the change. Direct SQL writes leave the GUC unset
    // and the row records changed_by=NULL — by design.
    await query(`SELECT set_config('gam.user_id', $1, true)`, [req.user!.userId])

    const newMargin = marginPct ?? (newCostPrice > 0 ? ((newSellPrice - newCostPrice) / newSellPrice) * 100 : item.margin_pct)

    const updated = await queryOne<any>(`UPDATE pos_items SET
      name=$1, category_id=$2, icon=$3, cost_price=$4, sell_price=$5, margin_pct=$6,
      tax_rate=$7, charge_eligible=$8, stock_min=$9, stock_max=$10, vendor_id=$11,
      is_active=$12, property_id=$13, tax_category_id=$15, updated_at=NOW() WHERE id=$14 RETURNING *`,
      [name??item.name, newCategoryId, icon??item.icon,
       newCostPrice, newSellPrice, newMargin,
       taxRate??item.tax_rate, chargeEligible??item.charge_eligible,
       stockMin??item.stock_min, stockMax??item.stock_max,
       newVendorId, isActive??item.is_active, newPropertyId, item.id, newTaxCategoryId])

    res.json({ success: true, data: updated })
  } catch (e) { next(e) }
})

// ── Tax categories — simple: each has ONE rate; items pick a tax category and
// inherit its rate (resolved in GET /items). Rates stored as decimals (0.08=8%).
const DEFAULT_TAX_CATEGORIES = [
  { name: 'Non-taxable', rate: 0, sort_order: 1 },
  { name: 'General',     rate: 0, sort_order: 2 },
  { name: 'Food',        rate: 0, sort_order: 3 },
  { name: 'Tobacco',     rate: 0, sort_order: 4 },
  { name: 'Alcohol',     rate: 0, sort_order: 5 },
]

posRouter.get('/tax-categories', requirePerm('pos.ring_sale', 'pos.manage_inventory'), async (req, res, next) => {
  try {
    const inactive = req.query.all === '1' ? '' : 'AND is_active=TRUE'
    let rows = await query(`SELECT * FROM pos_tax_categories WHERE landlord_id=$1 ${inactive} ORDER BY sort_order, name`, [req.user!.profileId])
    if (rows.length === 0) {
      for (const t of DEFAULT_TAX_CATEGORIES) {
        await query('INSERT INTO pos_tax_categories (landlord_id,name,rate,sort_order) VALUES ($1,$2,$3,$4)', [req.user!.profileId, t.name, t.rate, t.sort_order])
      }
      rows = await query(`SELECT * FROM pos_tax_categories WHERE landlord_id=$1 ${inactive} ORDER BY sort_order, name`, [req.user!.profileId])
    }
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

posRouter.post('/tax-categories', requirePerm('pos.manage_inventory'), async (req, res, next) => {
  try {
    const { name, rate, sortOrder } = req.body
    if (!name || typeof name !== 'string' || !name.trim()) throw new AppError(400, 'name is required')
    const r = Number(rate)
    if (!Number.isFinite(r) || r < 0 || r > 1) throw new AppError(400, 'rate must be a decimal 0–1 (e.g. 0.08 for 8%)')
    try {
      const row = await queryOne('INSERT INTO pos_tax_categories (landlord_id,name,rate,sort_order) VALUES ($1,$2,$3,$4) RETURNING *', [req.user!.profileId, name.trim(), r, sortOrder||0])
      res.status(201).json({ success: true, data: row })
    } catch (e: any) {
      if (e?.code === '23505') throw new AppError(409, `A tax category named "${name.trim()}" already exists`)
      throw e
    }
  } catch (e) { next(e) }
})

posRouter.patch('/tax-categories/:id', requirePerm('pos.manage_inventory'), async (req, res, next) => {
  try {
    const cat = await queryOne<any>('SELECT * FROM pos_tax_categories WHERE id=$1 AND landlord_id=$2', [req.params.id, req.user!.profileId])
    if (!cat) throw new AppError(404, 'Tax category not found')
    const { name, rate, isActive, sortOrder } = req.body
    let r = cat.rate
    if (rate !== undefined) { r = Number(rate); if (!Number.isFinite(r) || r < 0 || r > 1) throw new AppError(400, 'rate must be a decimal 0–1') }
    try {
      const row = await queryOne('UPDATE pos_tax_categories SET name=$1, rate=$2, is_active=$3, sort_order=$4 WHERE id=$5 RETURNING *', [name||cat.name, r, isActive!==undefined?isActive:cat.is_active, sortOrder!==undefined?sortOrder:cat.sort_order, cat.id])
      res.json({ success: true, data: row })
    } catch (e: any) {
      if (e?.code === '23505') throw new AppError(409, `A tax category named "${name}" already exists`)
      throw e
    }
  } catch (e) { next(e) }
})

// POST /api/pos/items/:id/adjust-stock
posRouter.post('/items/:id/adjust-stock', requirePerm('pos.manage_inventory'), async (req, res, next) => {
  try {
    const { changeQty, reason, notes } = req.body
    const item = await queryOne<any>('SELECT * FROM pos_items WHERE id=$1 AND landlord_id=$2', [req.params.id, req.user!.profileId])
    if (!item) throw new AppError(404, 'Item not found')

    const newQty = Math.max(0, item.stock_qty + changeQty)
    await query('UPDATE pos_items SET stock_qty=$1, updated_at=NOW() WHERE id=$2', [newQty, item.id])
    await query(`INSERT INTO pos_inventory_log (item_id,landlord_id,change_qty,reason,notes,stock_before,stock_after)
      VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [item.id, req.user!.profileId, changeQty, reason||'adjustment', notes||null, item.stock_qty, newQty])

    res.json({ success: true, data: { stockBefore: item.stock_qty, stockAfter: newQty } })
  } catch (e) { next(e) }
})

// GET /api/pos/items/:id/shelf-label — public shelf label data
// S227: JOIN pos_categories for the category name (used for the printed
// label text alongside the SKU/icon).
posRouter.get('/items/:id/shelf-label', async (req, res, next) => {
  try {
    const item = await queryOne<any>(
      `SELECT pi.id, pi.name, pi.sell_price, pi.tax_rate, pi.icon, pi.stock_qty,
              pc.name AS category
         FROM pos_items pi
         LEFT JOIN pos_categories pc ON pc.id = pi.category_id
        WHERE pi.id = $1 AND pi.is_active = TRUE`,
      [req.params.id],
    )
    if (!item) throw new AppError(404, 'Item not found')
    res.json({ success: true, data: item })
  } catch (e) { next(e) }
})

// ── TRANSACTIONS ──────────────────────────────────────────────

// POST /api/pos/transactions — record completed sale.
// S94: card sales pass `stripePaymentIntentId` from the terminal capture
// response. Stamped on the row for audit and idempotency (partial UNIQUE
// on stripe_payment_intent_id WHERE NOT NULL — a frontend retry after
// successful capture but before this POST returned would otherwise
// double-write; the 23505 catch turns it into a clean 409).
posRouter.post('/transactions', requirePerm('pos.ring_sale'), async (req, res, next) => {
  try {
    const { items, paymentMethod, tenantId, posCustomerId, propertyId, surcharge, changeGiven, stripePaymentIntentId } = req.body
    if (!Array.isArray(items) || items.length === 0) {
      throw new AppError(400, 'items array required')
    }

    // S254: paymentMethod='charge' is FlexCharge. Gate up-front so
    // the rest of the route knows the call is FlexCharge-shaped.
    //   - propertyId required (FlexCharge accounts are per-property)
    //   - exactly one of tenantId / posCustomerId required
    //   - every item with id must be charge_eligible
    let flexChargeAccountId: string | null = null
    if (paymentMethod === 'charge') {
      if (!propertyId) throw new AppError(400, 'propertyId required for FlexCharge sales')
      if ((tenantId && posCustomerId) || (!tenantId && !posCustomerId)) {
        throw new AppError(400, 'Exactly one of tenantId or posCustomerId required for FlexCharge')
      }
      // chargeEligible check — every linked POS item must be eligible.
      // Walk-up "misc" items (no item.id) are NOT chargeable; they
      // require a real catalog entry with charge_eligible=true.
      const linkedIds = items.filter((it: any) => !!it.id).map((it: any) => it.id)
      if (linkedIds.length !== items.length) {
        throw new AppError(400, 'Walk-up items (no catalog id) cannot be charged to FlexCharge')
      }
      const eligible = await query<{ id: string }>(
        `SELECT id FROM pos_items
          WHERE id = ANY($1::uuid[])
            AND landlord_id = $2
            AND charge_eligible = TRUE`,
        [linkedIds, req.user!.profileId],
      )
      if (eligible.length !== linkedIds.length) {
        throw new AppError(400, 'One or more cart items are not eligible for FlexCharge')
      }

      // Look up the account at this (customer, property) and verify
      // capacity. getAccountForCharge gates on XOR; the credit-limit +
      // landlord-disqualification checks happen inside
      // postFlexChargeTransaction below.
      const { getAccountForCharge } = await import('../services/flexCharge')
      const account = await getAccountForCharge({
        propertyId,
        tenantId:      tenantId ?? null,
        posCustomerId: posCustomerId ?? null,
      })
      if (!account) {
        throw new AppError(404, 'No FlexCharge account at this property for this customer')
      }
      if (account.status !== 'active') {
        throw new AppError(409, `FlexCharge account is ${account.status}`)
      }
      if (account.landlord_id !== req.user!.profileId) {
        throw new AppError(403, 'FlexCharge account belongs to a different landlord')
      }
      flexChargeAccountId = account.id
    }

    // S241: server-side tax calculation from pos_tax_rates. Trust no
    // client-side tax math. Items that have a `pos_items.id` get their
    // tax computed from the live rate table; walk-up "misc" items
    // (no item.id, frontend-typed name + price) get the client-supplied
    // tax through since we have no row to look up.
    const cartLines = items
      .filter((it: any) => !!it.id)
      .map((it: any) => ({ itemId: it.id, qty: Number(it.qty) || 0, unitPrice: Number(it.price) || 0 }))
    const tax = await calculateCartTax(req.user!.profileId, cartLines)
    const cartLineIdSet = new Set(cartLines.map(l => l.itemId))

    // Subtotal: server-side from cartLines, plus any walk-up items
    // (free-form, no pos_items row). Walk-up items keep their client-
    // declared price and tax — we have no source of truth to override.
    let walkUpSubtotal = 0
    let walkUpTax = 0
    for (const it of items) {
      if (it.id && cartLineIdSet.has(it.id)) continue  // already counted
      const line = (Number(it.qty) || 0) * (Number(it.price) || 0)
      walkUpSubtotal += line
      walkUpTax += line * (Number(it.tax) || Number(it.tax_rate) || 0)
    }
    const subtotal = Math.round((tax.subtotal + walkUpSubtotal) * 100) / 100
    const taxAmount = Math.round((tax.taxAmount + walkUpTax) * 100) / 100
    const surchargeAmt = Number(surcharge) || 0
    const total = Math.round((subtotal + taxAmount + surchargeAmt) * 100) / 100

    const platformFee = paymentMethod === 'charge' ? subtotal * 0.01 : 0

    // S242: terminal-captured card sales pass a stripePaymentIntentId
    // (capture path from /terminal/payment-intents/:id/capture). Verify
    // it on the landlord's Connect account before persisting — confirms
    // status='succeeded', metadata.gam_purpose='pos_terminal', and that
    // the PI amount matches the server-computed total. Pre-S242 the
    // route accepted any PI id without validation; a malicious or
    // misbehaving cashier could pass an arbitrary id and stamp the
    // transaction as paid.
    if (paymentMethod === 'card' && stripePaymentIntentId) {
      const connectId = await getLandlordConnectId(req.user!.profileId)
      const intent = await retrieveTerminalPaymentIntent({
        landlordConnectAccountId: connectId,
        paymentIntentId:          stripePaymentIntentId,
      })
      if (intent.metadata?.gam_purpose !== 'pos_terminal') {
        throw new AppError(400, 'PaymentIntent is not a POS terminal sale')
      }
      if (intent.metadata?.gam_landlord_id !== req.user!.profileId) {
        throw new AppError(403, 'PaymentIntent belongs to a different landlord')
      }
      if (intent.status !== 'succeeded') {
        throw new AppError(400, `PaymentIntent status is ${intent.status}, must be succeeded`)
      }
      const expectedCents = Math.round(total * 100)
      if (intent.amount !== expectedCents) {
        throw new AppError(400, `PaymentIntent amount ${intent.amount} does not match transaction total ${expectedCents}`)
      }
    }

    // S341: atomicity. Pre-S341 the five DB writes (pos_transactions,
    // pos_transaction_items, pos_items UPDATE, pos_inventory_log,
    // flex_charge_transactions) ran independently; partial failures
    // left inconsistent state (orphaned tx rows, half-decremented
    // stock, FlexCharge balance unchanged). Now wrapped in a single
    // BEGIN/COMMIT. autoDraftPO stays post-commit + best-effort
    // (mirrors stampPdf / firePmTransfers pattern in e-sign) — a
    // botched auto-PO shouldn't roll back the sale.
    const client = await getClient()
    let txnOpen = false
    const inventoryNeedsPO: any[] = []  // queued during loop, fired post-commit

    try {
      await client.query('BEGIN')
      txnOpen = true

      let tx: any
      try {
        const txRes = await client.query(`INSERT INTO pos_transactions
          (landlord_id,tenant_id,pos_customer_id,cashier_id,payment_method,subtotal,tax_amount,surcharge,total,change_given,platform_fee,stripe_payment_intent_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
          [req.user!.profileId, tenantId||null, posCustomerId||null, req.user!.userId,
           paymentMethod, subtotal, taxAmount, surchargeAmt, total, changeGiven||0, platformFee,
           stripePaymentIntentId || null])
        tx = txRes.rows[0]
      } catch (e: any) {
        // UNIQUE on pos_transactions_stripe_pi_uniq — same PI already
        // recorded a transaction. Retry-safe: ROLLBACK the (empty) txn,
        // return the existing row. Existing-row lookup goes back through
        // the pool since the failed INSERT poisoned the client connection
        // for further txn reads.
        if (e?.code === '23505' && e?.constraint === 'pos_transactions_stripe_pi_uniq') {
          await client.query('ROLLBACK')
          txnOpen = false
          const existing = await queryOne<any>(
            'SELECT * FROM pos_transactions WHERE stripe_payment_intent_id=$1',
            [stripePaymentIntentId])
          return res.status(200).json({ success: true, data: existing, message: 'Transaction already recorded for this payment intent' })
        }
        throw e
      }

      // Insert line items and decrement stock.
      // S70: scope the item lookup to the calling landlord — pre-S70 a
      // landlord could submit a transaction referencing another landlord's
      // pos_items UUID and decrement their stock. The walk-up cash flow
      // already only looks up items the landlord owns (catalog query is
      // landlord-scoped), but the transaction POST didn't enforce.
      for (const item of items) {
        const dbItem = item.id
          ? await client.query<any>(
              'SELECT * FROM pos_items WHERE id=$1 AND landlord_id=$2',
              [item.id, req.user!.profileId],
            ).then(r => r.rows[0] ?? null)
          : null

        await client.query(`INSERT INTO pos_transaction_items
          (transaction_id,item_id,item_name,item_category,qty,unit_price,cost_price,tax_rate,subtotal)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [tx.id, item.id||null, item.name, item.cat||item.category||'misc',
           item.qty, item.price, dbItem?.cost_price||0, item.tax||item.tax_rate||0,
           item.price * item.qty])

        // Decrement stock if tracked (not 999)
        if (dbItem && dbItem.stock_qty < 999) {
          const newQty = Math.max(0, dbItem.stock_qty - item.qty)
          await client.query('UPDATE pos_items SET stock_qty=$1, updated_at=NOW() WHERE id=$2', [newQty, dbItem.id])
          await client.query(`INSERT INTO pos_inventory_log (item_id,landlord_id,change_qty,reason,reference_id,stock_before,stock_after)
            VALUES ($1,$2,$3,'sale',$4,$5,$6)`,
            [dbItem.id, req.user!.profileId, -item.qty, tx.id, dbItem.stock_qty, newQty])

          // Queue auto-PO for post-commit. dbItem snapshot here uses
          // the pre-decrement stock_qty, matching the original pre-S341
          // semantics at line 495 (reorderQty = stock_max - stock_qty).
          if (newQty <= dbItem.stock_min && dbItem.vendor_id) {
            inventoryNeedsPO.push(dbItem)
          }
        }
      }

      // S254: post the FlexCharge transaction record. Has its own row-lock
      // + credit-limit + landlord-disqualification gate. S341: now runs on
      // the same client so it's part of this transaction — a balance/limit
      // failure rolls back the whole sale.
      if (paymentMethod === 'charge' && flexChargeAccountId) {
        const { postFlexChargeTransaction } = await import('../services/flexCharge')
        await postFlexChargeTransaction({
          accountId:        flexChargeAccountId,
          posTransactionId: tx.id,
          amount:           total,
        }, client)
      }

      await client.query('COMMIT')
      txnOpen = false

      // Post-commit best-effort: fire any auto-PO drafts that were
      // queued during the line-item loop. autoDraftPO already has its
      // own try/catch swallow; outer try here is defense in depth so
      // a future PO failure never leaks through and breaks the
      // 201 response.
      for (const item of inventoryNeedsPO) {
        try { await autoDraftPO(req.user!.profileId, item) }
        catch (e) { logger.error({ err: e, itemId: item.id }, '[POS] Post-commit auto-PO error:') }
      }

      res.status(201).json({ success: true, data: tx })
    } catch (e) {
      if (txnOpen) await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
    }
  } catch (e) { next(e) }
})

async function autoDraftPO(landlordId: string, item: any) {
  try {
    // Check if open PO already exists for this vendor
    const existing = await queryOne<any>(`
      SELECT po.id FROM pos_purchase_orders po
      JOIN pos_purchase_order_items poi ON poi.po_id = po.id
      WHERE po.landlord_id=$1 AND po.vendor_id=$2 AND po.status='draft' AND poi.item_id=$3`,
      [landlordId, item.vendor_id, item.id])
    if (existing) return // Already has a draft PO

    const reorderQty = item.stock_max - item.stock_qty
    const po = await queryOne<any>(`INSERT INTO pos_purchase_orders
      (landlord_id,vendor_id,status,po_number,subtotal)
      VALUES ($1,$2,'draft',$3,$4) RETURNING *`,
      [landlordId, item.vendor_id,
       'PO-' + Date.now().toString(36).toUpperCase(),
       reorderQty * item.cost_price])

    await query(`INSERT INTO pos_purchase_order_items (po_id,item_id,item_name,qty_ordered,unit_cost,subtotal)
      VALUES ($1,$2,$3,$4,$5,$6)`,
      [po!.id, item.id, item.name, reorderQty, item.cost_price, reorderQty * item.cost_price])

    logger.info(`[POS] Auto-drafted PO ${po!.po_number} for ${item.name} (${reorderQty} units)`)
  } catch (e) {
    logger.error({ err: e }, '[POS] Auto-draft PO error:')
  }
}

// GET /api/pos/transactions/sales — sales analytics
posRouter.get('/transactions/sales', requirePerm('pos.ring_sale', 'pos.end_of_day'), async (req, res, next) => {
  try {
    const { period = 'today' } = req.query

    // S390: dateFilter must qualify `created_at` with the `t.` alias —
    // the topItems and byCategory queries JOIN pos_transaction_items
    // (which also has created_at) so the unqualified column was
    // ambiguous and the route 500'd on every call regardless of data.
    // All four queries now use the `t.` alias on pos_transactions so
    // the filter is reusable.
    const dateFilter = period === 'today'
      ? `AND DATE(t.created_at) = CURRENT_DATE`
      : period === 'week'
        ? `AND t.created_at >= CURRENT_DATE - INTERVAL '7 days'`
        : `AND t.created_at >= CURRENT_DATE - INTERVAL '30 days'`

    // By hour (today only)
    const byHour = await query<any>(`
      SELECT EXTRACT(HOUR FROM t.created_at)::int as hour,
        COUNT(*) as tx_count,
        SUM(total) as revenue
      FROM pos_transactions t
      WHERE landlord_id=$1 AND DATE(t.created_at) = CURRENT_DATE
      GROUP BY hour ORDER BY hour`, [req.user!.profileId])

    // By day
    const byDay = await query<any>(`
      SELECT DATE(t.created_at) as date,
        COUNT(*) as tx_count,
        SUM(total) as revenue,
        SUM(CASE WHEN payment_method='cash' THEN total ELSE 0 END) as cash,
        SUM(CASE WHEN payment_method='card' THEN total ELSE 0 END) as card,
        SUM(CASE WHEN payment_method='charge' THEN total ELSE 0 END) as charge
      FROM pos_transactions t
      WHERE landlord_id=$1 ${dateFilter}
      GROUP BY date ORDER BY date DESC`, [req.user!.profileId])

    // Top items
    const topItems = await query<any>(`
      SELECT ti.item_name, ti.item_category,
        SUM(ti.qty) as total_qty,
        SUM(ti.subtotal) as total_revenue,
        SUM(ti.qty * ti.cost_price) as total_cost,
        SUM(ti.subtotal) - SUM(ti.qty * ti.cost_price) as gross_profit
      FROM pos_transaction_items ti
      JOIN pos_transactions t ON t.id = ti.transaction_id
      WHERE t.landlord_id=$1 ${dateFilter}
      GROUP BY ti.item_name, ti.item_category
      ORDER BY total_revenue DESC LIMIT 10`, [req.user!.profileId])

    // Category breakdown
    const byCategory = await query<any>(`
      SELECT ti.item_category as category,
        SUM(ti.subtotal) as revenue,
        SUM(ti.qty) as units_sold
      FROM pos_transaction_items ti
      JOIN pos_transactions t ON t.id = ti.transaction_id
      WHERE t.landlord_id=$1 ${dateFilter}
      GROUP BY category ORDER BY revenue DESC`, [req.user!.profileId])

    // Summary totals
    const summary = await queryOne<any>(`
      SELECT COUNT(*) as tx_count,
        SUM(total) as total_revenue,
        SUM(subtotal) as subtotal,
        SUM(tax_amount) as total_tax,
        SUM(surcharge) as total_surcharge,
        SUM(platform_fee) as total_fees,
        AVG(total) as avg_ticket,
        SUM(CASE WHEN payment_method='cash' THEN total ELSE 0 END) as cash_total,
        SUM(CASE WHEN payment_method='card' THEN total ELSE 0 END) as card_total,
        SUM(CASE WHEN payment_method='charge' THEN total ELSE 0 END) as charge_total
      FROM pos_transactions t
      WHERE landlord_id=$1 ${dateFilter}`, [req.user!.profileId])

    res.json({ success: true, data: { summary, byHour, byDay, topItems, byCategory } })
  } catch (e) { next(e) }
})

// ── VENDORS ───────────────────────────────────────────────────

posRouter.get('/vendors', requirePerm('pos.manage_inventory'), async (req, res, next) => {
  try {
    const vendors = await query<any>('SELECT * FROM pos_vendors WHERE landlord_id=$1 ORDER BY name', [req.user!.profileId])
    res.json({ success: true, data: vendors })
  } catch (e) { next(e) }
})

posRouter.post('/vendors', requirePerm('pos.manage_inventory'), async (req, res, next) => {
  try {
    const { name, contactName, email, phone, address, leadTimeDays, notes } = req.body
    const vendor = await queryOne<any>(`INSERT INTO pos_vendors
      (landlord_id,name,contact_name,email,phone,address,lead_time_days,notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [req.user!.profileId, name, contactName||null, email||null, phone||null,
       address||null, leadTimeDays||3, notes||null])
    res.status(201).json({ success: true, data: vendor })
  } catch (e) { next(e) }
})

posRouter.patch('/vendors/:id', requirePerm('pos.manage_inventory'), async (req, res, next) => {
  try {
    const { name, contactName, email, phone, address, leadTimeDays, notes, isActive } = req.body
    const vendor = await queryOne<any>('SELECT * FROM pos_vendors WHERE id=$1 AND landlord_id=$2', [req.params.id, req.user!.profileId])
    if (!vendor) throw new AppError(404, 'Vendor not found')
    const updated = await queryOne<any>(`UPDATE pos_vendors SET
      name=$1, contact_name=$2, email=$3, phone=$4, address=$5, lead_time_days=$6, notes=$7, is_active=$8, updated_at=NOW()
      WHERE id=$9 RETURNING *`,
      [name??vendor.name, contactName??vendor.contact_name, email??vendor.email,
       phone??vendor.phone, address??vendor.address, leadTimeDays??vendor.lead_time_days,
       notes??vendor.notes, isActive??vendor.is_active, vendor.id])
    res.json({ success: true, data: updated })
  } catch (e) { next(e) }
})

// ── PURCHASE ORDERS ───────────────────────────────────────────

posRouter.get('/purchase-orders', requirePerm('pos.manage_inventory'), async (req, res, next) => {
  try {
    const pos = await query<any>(`
      SELECT po.*, v.name as vendor_name, v.email as vendor_email,
        (SELECT COUNT(*) FROM pos_purchase_order_items WHERE po_id=po.id) as item_count
      FROM pos_purchase_orders po
      JOIN pos_vendors v ON v.id = po.vendor_id
      WHERE po.landlord_id=$1 ORDER BY po.created_at DESC`, [req.user!.profileId])

    for (const po of pos) {
      po.items = await query<any>('SELECT * FROM pos_purchase_order_items WHERE po_id=$1', [po.id])
    }

    res.json({ success: true, data: pos })
  } catch (e) { next(e) }
})

posRouter.patch('/purchase-orders/:id', requirePerm('pos.manage_inventory'), async (req, res, next) => {
  try {
    const { status, notes, expectedDate } = req.body
    const po = await queryOne<any>('SELECT * FROM pos_purchase_orders WHERE id=$1 AND landlord_id=$2', [req.params.id, req.user!.profileId])
    if (!po) throw new AppError(404, 'PO not found')

    const timestamps: Record<string, string> = {}
    if (status === 'approved') timestamps.approved_at = 'NOW()'
    if (status === 'sent') timestamps.sent_at = 'NOW()'
    if (status === 'received') timestamps.received_at = 'NOW()'

    const updated = await queryOne<any>(`UPDATE pos_purchase_orders SET
      status=$1, notes=$2, expected_date=$3,
      ${Object.keys(timestamps).map(k => `${k}=${timestamps[k]}`).join(', ')},
      updated_at=NOW() WHERE id=$4 RETURNING *`,
      [status??po.status, notes??po.notes, expectedDate??po.expected_date, po.id])

    // On receive — restock items
    // S347 fix: qty_ordered is numeric(10,3); pg returns it as a string.
    // Pre-S347 `dbItem.stock_qty + item.qty_ordered` was string-concat
    // (e.g. 10 + "15.000" → "1015.000"), which postgres then rejected
    // writing back into the integer stock_qty column with "invalid
    // input syntax for type integer". Coerce to Number first. Same
    // coercion applies to the change_qty insert (integer column too).
    if (status === 'received') {
      const items = await query<any>('SELECT * FROM pos_purchase_order_items WHERE po_id=$1', [po.id])
      for (const item of items) {
        if (!item.item_id) continue
        const dbItem = await queryOne<any>('SELECT * FROM pos_items WHERE id=$1', [item.item_id])
        if (!dbItem) continue
        const qty = Number(item.qty_ordered)
        const newQty = dbItem.stock_qty + qty
        await query('UPDATE pos_items SET stock_qty=$1, updated_at=NOW() WHERE id=$2', [newQty, item.item_id])
        await query(`INSERT INTO pos_inventory_log (item_id,landlord_id,change_qty,reason,reference_id,stock_before,stock_after)
          VALUES ($1,$2,$3,'po_received',$4,$5,$6)`,
          [item.item_id, req.user!.profileId, qty, po.id, dbItem.stock_qty, newQty])
      }
    }

    res.json({ success: true, data: updated })
  } catch (e) { next(e) }
})

// GET /api/pos/low-stock — items at or below min
posRouter.get('/low-stock', requirePerm('pos.manage_inventory'), async (req, res, next) => {
  try {
    const items = await query<any>(`
      SELECT i.*, v.name as vendor_name
      FROM pos_items i
      LEFT JOIN pos_vendors v ON v.id = i.vendor_id
      WHERE i.landlord_id=$1 AND i.is_active=TRUE
        AND i.stock_qty <= i.stock_min AND i.stock_max < 999
      ORDER BY (i.stock_qty::float / NULLIF(i.stock_min,0)) ASC`, [req.user!.profileId])
    res.json({ success: true, data: items })
  } catch (e) { next(e) }
})

// ── CATEGORIES ────────────────────────────────────────────────
// DEFAULT_CATEGORIES is defined at the top of this file so the items
// seed flow can also resolve names → ids (S227).

// Category property scope: null/empty array → all properties (company-wide);
// a non-empty array scopes the category to exactly those properties. Each id is
// validated to belong to the landlord. Returns the normalized value to store.
async function validateCategoryPropertyIds(propertyIds: any, landlordId: string): Promise<string[] | null> {
  if (!Array.isArray(propertyIds) || propertyIds.length === 0) return null
  const ids = Array.from(new Set(propertyIds.map(String)))
  const owned = await query<{ id: string }>(
    'SELECT id FROM properties WHERE landlord_id=$1 AND id = ANY($2::uuid[])', [landlordId, ids])
  if (owned.length !== ids.length) {
    throw new AppError(400, 'One or more properties do not belong to this landlord')
  }
  return ids
}

posRouter.get('/categories', requirePerm('pos.ring_sale', 'pos.manage_inventory'), async (req, res, next) => {
  try {
    // S219: ?all=1 returns inactive categories too (for the management
    // tab's toggle-active workflow). Default = active-only, used by the
    // Add/Edit Item + tax-rate dropdowns.
    // S220: ?propertyId= filter mirrors S217 pos_tax_rates. When
    // provided, returns (categories at that property) UNION (landlord-
    // wide categories with NULL property_id). When omitted, returns
    // every category under the landlord — the management tab needs the
    // full list. The two filters are orthogonal and compose.
    const includeInactive = req.query.all === '1'
    const propertyFilter = req.query.propertyId as string | undefined
    const params: any[] = [req.user!.profileId]
    let where = 'WHERE landlord_id=$1'
    if (!includeInactive) where += ' AND is_active=TRUE'
    if (propertyFilter) {
      params.push(propertyFilter)
      // property_ids NULL = all properties; otherwise the property must be in the set.
      where += ' AND (property_ids IS NULL OR $2 = ANY(property_ids))'
    }
    let cats = await query(`SELECT * FROM pos_categories ${where} ORDER BY sort_order, name`, params)
    if (cats.length === 0 && !propertyFilter) {
      // First-load auto-seed only fires when the landlord truly has no
      // categories (no property filter applied). With a propertyFilter,
      // an empty result just means "no categories scoped to this
      // property" — don't seed.
      for (const cat of DEFAULT_CATEGORIES) {
        await query('INSERT INTO pos_categories (landlord_id,name,icon,sort_order) VALUES ($1,$2,$3,$4)', [req.user!.profileId, cat.name, cat.icon, cat.sort_order])
      }
      cats = await query(`SELECT * FROM pos_categories ${where} ORDER BY sort_order, name`, params)
    }
    res.json({ success: true, data: cats })
  } catch (e) { next(e) }
})

posRouter.post('/categories', requirePerm('pos.manage_inventory'), async (req, res, next) => {
  try {
    const { name, icon, sortOrder, propertyIds } = req.body
    if (!name || typeof name !== 'string' || !name.trim()) {
      throw new AppError(400, 'name is required')
    }
    // property_ids: null/empty → all properties (company-wide); a non-empty
    // array scopes the category to exactly those properties (each validated
    // to belong to this landlord).
    const propIds = await validateCategoryPropertyIds(propertyIds, req.user!.profileId)
    try {
      const cat = await queryOne('INSERT INTO pos_categories (landlord_id,name,icon,sort_order,property_ids) VALUES ($1,$2,$3,$4,$5::uuid[]) RETURNING *', [req.user!.profileId, name.trim(), icon||'📦', sortOrder||0, propIds])
      res.status(201).json({ success: true, data: cat })
    } catch (e: any) {
      // Category names are unique per landlord → clean 409 instead of a 500.
      if (e?.code === '23505' && e?.constraint === 'pos_categories_landlord_name_uniq') {
        throw new AppError(409, `A category named "${name.trim()}" already exists`)
      }
      throw e
    }
  } catch (e) { next(e) }
})

posRouter.patch('/categories/:id', requirePerm('pos.manage_inventory'), async (req, res, next) => {
  try {
    const { name, icon, sortOrder, isActive, propertyIds } = req.body
    const cat = await queryOne<any>('SELECT * FROM pos_categories WHERE id=$1 AND landlord_id=$2', [req.params.id, req.user!.profileId])
    if (!cat) { res.status(404).json({ success: false, error: 'Not found' }); return }

    // property_ids: undefined preserves the existing scope; otherwise
    // null/empty → all properties, a non-empty array → that specific subset.
    let newPropIds: string[] | null = cat.property_ids
    if (propertyIds !== undefined) {
      newPropIds = await validateCategoryPropertyIds(propertyIds, req.user!.profileId)
    }

    // S219: sortOrder uses !==undefined so a deliberate 0 (top of list)
    // sticks; pre-S219 the `||` fell through to the existing value.
    try {
      const updated = await queryOne('UPDATE pos_categories SET name=$1,icon=$2,sort_order=$3,is_active=$4,property_ids=$5::uuid[] WHERE id=$6 RETURNING *', [name||cat.name, icon||cat.icon, sortOrder!==undefined?sortOrder:cat.sort_order, isActive!==undefined?isActive:cat.is_active, newPropIds, cat.id])
      res.json({ success: true, data: updated })
    } catch (e: any) {
      // Rename collision against another category under the same landlord —
      // surface as 409 instead of a generic 500.
      if (e?.code === '23505' && e?.constraint === 'pos_categories_landlord_name_uniq') {
        throw new AppError(409, `Another category named "${name}" already exists`)
      }
      throw e
    }
  } catch (e) { next(e) }
})

posRouter.delete('/categories/:id', requirePerm('pos.manage_inventory'), async (req, res, next) => {
  try {
    await query('UPDATE pos_categories SET is_active=FALSE WHERE id=$1 AND landlord_id=$2', [req.params.id, req.user!.profileId])
    res.json({ success: true })
  } catch (e) { next(e) }
})

// ── VARIANTS ──────────────────────────────────────────────────

posRouter.get('/items/:id/variants', requirePerm('pos.ring_sale', 'pos.manage_inventory'), async (req, res, next) => {
  try {
    // S390 fix: verify the item belongs to the caller's landlord. Pre-fix
    // the route filtered only by item_id with no landlord scope, so a
    // caller knowing a stranger's item UUID could read the variant list.
    // pos_item_variants has no landlord_id column — ownership is
    // transitive via item_id, so we resolve the item first.
    const item = await queryOne<{ id: string }>(
      'SELECT id FROM pos_items WHERE id=$1 AND landlord_id=$2',
      [req.params.id, req.user!.profileId])
    if (!item) {
      res.status(404).json({ success: false, error: 'Not found' })
      return
    }
    const variants = await query('SELECT * FROM pos_item_variants WHERE item_id=$1 AND is_active=TRUE ORDER BY sort_order, sell_price', [req.params.id])
    res.json({ success: true, data: variants })
  } catch (e) { next(e) }
})

posRouter.post('/items/:id/variants', requirePerm('pos.manage_inventory'), async (req, res, next) => {
  try {
    const { name, costPrice, sellPrice, stockQty, stockMin, sortOrder } = req.body
    const item = await queryOne('SELECT * FROM pos_items WHERE id=$1 AND landlord_id=$2', [req.params.id, req.user!.profileId])
    if (!item) { res.status(404).json({ success: false, error: 'Not found' }); return }
    await query('UPDATE pos_items SET has_variants=TRUE WHERE id=$1', [item.id])
    const variant = await queryOne('INSERT INTO pos_item_variants (item_id,name,cost_price,sell_price,stock_qty,stock_min,sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *', [item.id, name, costPrice||0, sellPrice, stockQty||0, stockMin||5, sortOrder||0])
    res.status(201).json({ success: true, data: variant })
  } catch (e) { next(e) }
})

posRouter.patch('/items/:id/variants/:variantId', requirePerm('pos.manage_inventory'), async (req, res, next) => {
  try {
    const { name, costPrice, sellPrice, stockQty, stockMin, isActive } = req.body
    // S390 fix: verify the item belongs to the caller's landlord.
    // Pre-fix, a caller knowing both a stranger item UUID and the
    // matching variant UUID could PATCH that variant — the SELECT
    // succeeds when (variantId, itemId) is a legit pair regardless
    // of ownership, and the UPDATE then writes the stranger's row.
    // pos_item_variants has no landlord_id column — ownership is
    // transitive via item_id.
    const item = await queryOne<{ id: string }>(
      'SELECT id FROM pos_items WHERE id=$1 AND landlord_id=$2',
      [req.params.id, req.user!.profileId])
    if (!item) { res.status(404).json({ success: false, error: 'Not found' }); return }
    const v = await queryOne('SELECT * FROM pos_item_variants WHERE id=$1 AND item_id=$2', [req.params.variantId, req.params.id])
    if (!v) { res.status(404).json({ success: false, error: 'Not found' }); return }
    const updated = await queryOne('UPDATE pos_item_variants SET name=$1,cost_price=$2,sell_price=$3,stock_qty=$4,stock_min=$5,is_active=$6,updated_at=NOW() WHERE id=$7 RETURNING *', [name||v.name, costPrice||v.cost_price, sellPrice||v.sell_price, stockQty||v.stock_qty, stockMin||v.stock_min, isActive!==undefined?isActive:v.is_active, v.id])
    res.json({ success: true, data: updated })
  } catch (e) { next(e) }
})

// ── TAX RATES ─────────────────────────────────────────────────

// S217: optional ?propertyId= filter mirrors S192's pos_items shape.
// When provided, returns (rates at that property) UNION (landlord-wide
// rates with NULL property_id). When omitted, returns every rate
// under the landlord — the configuration surface needs the full list.
posRouter.get('/tax-rates', requirePerm('pos.ring_sale', 'pos.manage_inventory'), async (req, res, next) => {
  try {
    const propertyFilter = req.query.propertyId as string | undefined
    let rates: any[]
    if (propertyFilter) {
      rates = await query<any>(
        `SELECT * FROM pos_tax_rates
          WHERE landlord_id = $1
            AND (property_id = $2 OR property_id IS NULL)
          ORDER BY tax_type, name`,
        [req.user!.profileId, propertyFilter],
      )
    } else {
      rates = await query<any>(
        'SELECT * FROM pos_tax_rates WHERE landlord_id=$1 ORDER BY tax_type, name',
        [req.user!.profileId],
      )
    }
    res.json({ success: true, data: rates })
  } catch (e) { next(e) }
})

posRouter.post('/tax-rates', requirePerm('pos.manage_inventory'), async (req, res, next) => {
  try {
    const { name, rate, taxType, appliesTo, propertyId } = req.body

    // S217: validate propertyId belongs to this landlord. NULL is the
    // legacy "applies landlord-wide" posture and is allowed.
    if (propertyId) {
      const prop = await queryOne<{ landlord_id: string }>(
        'SELECT landlord_id FROM properties WHERE id = $1',
        [propertyId],
      )
      if (!prop || prop.landlord_id !== req.user!.profileId) {
        throw new AppError(400, 'propertyId does not belong to this landlord')
      }
    }

    const r = await queryOne<any>(`INSERT INTO pos_tax_rates (landlord_id,property_id,name,rate,tax_type,applies_to)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.user!.profileId, propertyId||null, name, rate, taxType, appliesTo||['all']])
    res.status(201).json({ success: true, data: r })
  } catch (e) { next(e) }
})

posRouter.patch('/tax-rates/:id', requirePerm('pos.manage_inventory'), async (req, res, next) => {
  try {
    const existing = await queryOne<any>(
      'SELECT * FROM pos_tax_rates WHERE id=$1 AND landlord_id=$2',
      [req.params.id, req.user!.profileId],
    )
    if (!existing) throw new AppError(404, 'Tax rate not found')

    const { name, rate, taxType, appliesTo, isActive, propertyId } = req.body

    // S217: propertyId update — null clears, undefined preserves, uuid
    // re-assigns. Validate ownership when reassigning.
    let newPropertyId: string | null = existing.property_id
    if (propertyId === null) {
      newPropertyId = null
    } else if (propertyId !== undefined) {
      const prop = await queryOne<{ landlord_id: string }>(
        'SELECT landlord_id FROM properties WHERE id = $1',
        [propertyId],
      )
      if (!prop || prop.landlord_id !== req.user!.profileId) {
        throw new AppError(400, 'propertyId does not belong to this landlord')
      }
      newPropertyId = propertyId
    }

    const r = await queryOne<any>(`UPDATE pos_tax_rates SET
      name=COALESCE($1,name), rate=COALESCE($2,rate), tax_type=COALESCE($3,tax_type),
      applies_to=COALESCE($4,applies_to), is_active=COALESCE($5,is_active),
      property_id=$6
      WHERE id=$7 AND landlord_id=$8 RETURNING *`,
      [name, rate, taxType, appliesTo, isActive, newPropertyId, req.params.id, req.user!.profileId])
    res.json({ success: true, data: r })
  } catch (e) { next(e) }
})

posRouter.delete('/tax-rates/:id', requirePerm('pos.manage_inventory'), async (req, res, next) => {
  try {
    await query('UPDATE pos_tax_rates SET is_active=FALSE WHERE id=$1 AND landlord_id=$2', [req.params.id, req.user!.profileId])
    res.json({ success: true })
  } catch (e) { next(e) }
})

// ── DISCOUNTS ─────────────────────────────────────────────────

posRouter.get('/discounts', requirePerm('pos.discount', 'pos.manage_inventory'), async (req, res, next) => {
  try {
    const discounts = await query<any>('SELECT * FROM pos_discounts WHERE landlord_id=$1 AND is_active=TRUE ORDER BY name', [req.user!.profileId])
    res.json({ success: true, data: discounts })
  } catch (e) { next(e) }
})

posRouter.post('/discounts', requirePerm('pos.manage_inventory'), async (req, res, next) => {
  try {
    const { name, type, value, code } = req.body
    const d = await queryOne<any>(`INSERT INTO pos_discounts (landlord_id,name,type,value,code)
      VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.user!.profileId, name, type, value, code||null])
    res.status(201).json({ success: true, data: d })
  } catch (e) { next(e) }
})

posRouter.patch('/discounts/:id', requirePerm('pos.manage_inventory'), async (req, res, next) => {
  try {
    const { name, type, value, code, isActive } = req.body
    const d = await queryOne<any>(`UPDATE pos_discounts SET
      name=COALESCE($1,name), type=COALESCE($2,type), value=COALESCE($3,value),
      code=COALESCE($4,code), is_active=COALESCE($5,is_active)
      WHERE id=$6 AND landlord_id=$7 RETURNING *`,
      [name, type, value, code, isActive, req.params.id, req.user!.profileId])
    res.json({ success: true, data: d })
  } catch (e) { next(e) }
})

// ── REFUNDS ───────────────────────────────────────────────────

posRouter.post('/transactions/:id/refund', requirePerm('pos.refund'), async (req, res, next) => {
  const client = await getClient()
  let txnOpen = false
  try {
    const { amount, reason, items, refundMethod } = req.body
    const tx = await queryOne<any>('SELECT * FROM pos_transactions WHERE id=$1 AND landlord_id=$2', [req.params.id, req.user!.profileId])
    if (!tx) throw new AppError(404, 'Transaction not found')
    if (tx.status === 'voided') throw new AppError(400, 'Cannot refund a voided transaction')

    // S339: refund_method enforcement. GAM does not process refunds back
    // to a card via Stripe — cashier-physical payout only.
    //   - FlexCharge ('charge') sales → refund_method forced to 'charge'
    //     (credit reversal on the customer's open account; cashier doesn't
    //     pick, the symmetric reversal is automatic).
    //   - Cash + card sales → cashier picks 'cash' or 'check' (user
    //     discretion). Client must pass refundMethod; default is 'cash'
    //     when omitted. Any other value rejected.
    let resolvedMethod: 'cash' | 'check' | 'charge'
    if (tx.payment_method === 'charge') {
      resolvedMethod = 'charge'
    } else {
      const picked = (refundMethod ?? 'cash') as string
      if (picked !== 'cash' && picked !== 'check') {
        throw new AppError(400, `refundMethod must be 'cash' or 'check' for non-FlexCharge sales (got '${picked}')`)
      }
      resolvedMethod = picked
    }

    // Coerce both sides to numbers: tx.total comes back from pg numeric
    // as a string, and amount may arrive as a number or string from JSON.
    const refundAmt = Number(amount ?? tx.total)
    const txTotalNum = Number(tx.total)
    const isFullRefund = refundAmt >= txTotalNum

    // S340: FlexCharge reversal needs the originating flex_charge_transactions
    // account_id; look it up before the writes so we can fail fast outside
    // the txn if the original row is missing.
    let flexChargeAccountId: string | null = null
    if (resolvedMethod === 'charge') {
      const orig = await queryOne<{ account_id: string }>(
        `SELECT account_id FROM flex_charge_transactions WHERE pos_transaction_id = $1 AND amount > 0 ORDER BY created_at LIMIT 1`,
        [tx.id])
      if (!orig) {
        throw new AppError(409, 'FlexCharge sale has no originating flex_charge_transactions row to reverse')
      }
      flexChargeAccountId = orig.account_id
    }

    // S340: wrap the three-step write (pos_refunds INSERT, pos_transactions
    // UPDATE, conditional flex_charge_transactions reversal) in a single
    // transaction so a mid-chain failure rolls back cleanly. Pre-S340 the
    // statements ran independently — a FlexCharge reversal failure would
    // leave pos_refunds + pos_transactions.status='refunded' but the
    // customer's open-account balance still owing the original charge.
    await client.query('BEGIN')
    txnOpen = true

    await client.query(`INSERT INTO pos_refunds (transaction_id,landlord_id,amount,reason,items,refund_method)
      VALUES ($1,$2,$3,$4,$5,$6)`,
      [tx.id, req.user!.profileId, refundAmt, reason||null, items ? JSON.stringify(items) : null, resolvedMethod])

    await client.query(`UPDATE pos_transactions SET
      status=$1, refund_amount=$2, refunded_at=NOW() WHERE id=$3`,
      [isFullRefund ? 'refunded' : 'partial_refund', refundAmt, tx.id])

    if (resolvedMethod === 'charge' && flexChargeAccountId) {
      const { postFlexChargeRefund } = await import('../services/flexCharge')
      await postFlexChargeRefund({
        accountId:        flexChargeAccountId,
        posTransactionId: tx.id,
        amount:           refundAmt,
        notes:            reason ? `Refund: ${reason}` : `Refund of pos_transaction ${tx.id}`,
      }, client)
    }

    await client.query('COMMIT')
    txnOpen = false

    res.json({ success: true, data: { refundAmount: refundAmt, refundMethod: resolvedMethod } })
  } catch (e) {
    if (txnOpen) await client.query('ROLLBACK').catch(() => {})
    next(e)
  } finally {
    client.release()
  }
})

posRouter.post('/transactions/:id/void', requirePerm('pos.void'), async (req, res, next) => {
  try {
    const { reason } = req.body
    const tx = await queryOne<any>('SELECT * FROM pos_transactions WHERE id=$1 AND landlord_id=$2', [req.params.id, req.user!.profileId])
    if (!tx) throw new AppError(404, 'Transaction not found')
    if (tx.status !== 'completed') throw new AppError(400, 'Only completed transactions can be voided')
    await query('UPDATE pos_transactions SET status=$1, void_reason=$2 WHERE id=$3',
      ['voided', reason||null, tx.id])
    res.json({ success: true })
  } catch (e) { next(e) }
})

// GET /api/pos/transactions — full list with status
posRouter.get('/transactions', requirePerm('pos.ring_sale', 'pos.end_of_day'), async (req, res, next) => {
  try {
    const txns = await query<any>(`
      SELECT t.*,
        u.first_name || ' ' || u.last_name AS tenant_name,
        (SELECT COUNT(*) FROM pos_transaction_items WHERE transaction_id=t.id) as item_count
      FROM pos_transactions t
      LEFT JOIN tenants tn ON tn.id = t.tenant_id
      LEFT JOIN users u ON u.id = tn.user_id
      WHERE t.landlord_id=$1
      ORDER BY t.created_at DESC LIMIT 100`, [req.user!.profileId])
    res.json({ success: true, data: txns })
  } catch (e) { next(e) }
})

// POST /api/pos/purchase-orders — create new PO
posRouter.post('/purchase-orders', requirePerm('pos.manage_inventory'), async (req, res, next) => {
  try {
    const { vendorId, notes, expectedDate, items } = req.body
    const vendor = await queryOne<any>('SELECT * FROM pos_vendors WHERE id=$1 AND landlord_id=$2', [vendorId, req.user!.profileId])
    if (!vendor) throw new AppError(404, 'Vendor not found')

    const poNumber = 'PO-' + Date.now().toString(36).toUpperCase()
    const po = await queryOne<any>(`INSERT INTO pos_purchase_orders
      (landlord_id,vendor_id,status,po_number,notes,expected_date)
      VALUES ($1,$2,'draft',$3,$4,$5) RETURNING *`,
      [req.user!.profileId, vendorId, poNumber, notes||null, expectedDate||null])

    let subtotal = 0
    if (items && items.length > 0) {
      for (const item of items) {
        const lineTotal = (item.unitCost||0) * (item.qtyOrdered||1)
        subtotal += lineTotal
        await query(`INSERT INTO pos_purchase_order_items
          (po_id,item_id,item_name,qty_ordered,unit_cost,subtotal)
          VALUES ($1,$2,$3,$4,$5,$6)`,
          [po!.id, item.itemId||null, item.itemName, item.qtyOrdered||1, item.unitCost||0, lineTotal])
      }
      await query('UPDATE pos_purchase_orders SET subtotal=$1 WHERE id=$2', [subtotal, po!.id])
    }

    res.status(201).json({ success: true, data: { ...po, subtotal } })
  } catch (e) { next(e) }
})

// POST /api/pos/purchase-orders/:id/items — add line item to existing PO
posRouter.post('/purchase-orders/:id/items', requirePerm('pos.manage_inventory'), async (req, res, next) => {
  try {
    const { itemId, itemName, qtyOrdered, unitCost } = req.body
    const po = await queryOne<any>('SELECT * FROM pos_purchase_orders WHERE id=$1 AND landlord_id=$2', [req.params.id, req.user!.profileId])
    if (!po) throw new AppError(404, 'PO not found')
    if (po.status !== 'draft') throw new AppError(400, 'Can only add items to draft POs')

    const lineTotal = (unitCost||0) * (qtyOrdered||1)
    const item = await queryOne<any>(`INSERT INTO pos_purchase_order_items
      (po_id,item_id,item_name,qty_ordered,unit_cost,subtotal)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [po.id, itemId||null, itemName, qtyOrdered||1, unitCost||0, lineTotal])

    await query('UPDATE pos_purchase_orders SET subtotal=subtotal+$1, updated_at=NOW() WHERE id=$2', [lineTotal, po.id])

    res.status(201).json({ success: true, data: item })
  } catch (e) { next(e) }
})

// GET /api/pos/inventory-log — recent stock movement
// S347: pre-S347 selected i.category from pos_items, but post-S227 the
// column is category_id + JOIN to pos_categories — the bare SELECT
// crashed with "column i.category does not exist" at runtime. JOIN added
// here so the surfaced category name matches the rest of pos.ts.
posRouter.get('/inventory-log', requirePerm('pos.manage_inventory'), async (req, res, next) => {
  try {
    const log = await query<any>(`
      SELECT l.*, i.name as item_name, i.icon as item_icon, pc.name AS category
      FROM pos_inventory_log l
      JOIN pos_items i ON i.id = l.item_id
      LEFT JOIN pos_categories pc ON pc.id = i.category_id
      WHERE l.landlord_id=$1
      ORDER BY l.created_at DESC LIMIT 200`, [req.user!.profileId])
    res.json({ success: true, data: log })
  } catch (e) { next(e) }
})

// ── END-OF-DAY RECONCILIATION (S95) ──────────────────────────

// GET /api/pos/eod — list recent settlements (default 30)
posRouter.get('/eod', requirePerm('pos.end_of_day', 'pos.ring_sale'), async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(String(req.query.limit || '30'), 10) || 30, 90)
    const rows = await query<any>(
      `SELECT * FROM pos_eod_settlements
        WHERE landlord_id = $1
        ORDER BY business_day DESC
        LIMIT $2`,
      [req.user!.profileId, limit]
    )
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

// GET /api/pos/eod/:date — single settlement by YYYY-MM-DD
posRouter.get('/eod/:date', requirePerm('pos.end_of_day', 'pos.ring_sale'), async (req, res, next) => {
  try {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(req.params.date)) {
      throw new AppError(400, 'date must be YYYY-MM-DD')
    }
    const row = await queryOne<any>(
      `SELECT * FROM pos_eod_settlements
        WHERE landlord_id = $1 AND business_day = $2`,
      [req.user!.profileId, req.params.date]
    )
    if (!row) throw new AppError(404, 'No settlement for that date')
    res.json({ success: true, data: row })
  } catch (e) { next(e) }
})

// POST /api/pos/eod/close — manual close with cash drawer count.
// Body: { businessDay: 'YYYY-MM-DD', cashDrawerActual: number,
//         openingFloat?: number, notes?: string }
posRouter.post('/eod/close', requirePerm('pos.end_of_day'), async (req, res, next) => {
  try {
    const { businessDay, cashDrawerActual, openingFloat, notes } = req.body
    if (!businessDay || !/^\d{4}-\d{2}-\d{2}$/.test(businessDay)) {
      throw new AppError(400, 'businessDay (YYYY-MM-DD) required')
    }
    if (cashDrawerActual == null || isNaN(Number(cashDrawerActual))) {
      throw new AppError(400, 'cashDrawerActual (number) required')
    }
    const { generateEodSettlement } = await import('../services/posEod')
    const result = await generateEodSettlement(
      req.user!.profileId,
      businessDay,
      {
        closedBy:         req.user!.userId,
        cashDrawerActual: Number(cashDrawerActual),
        openingFloat:     openingFloat != null ? Number(openingFloat) : 0,
        status:           'manually_closed',
        notes:            notes || null,
      }
    )
    res.json({ success: true, data: result })
  } catch (e) { next(e) }
})

// POST /api/pos/eod/regenerate — re-derive a settlement (admin override
// for late-arriving txns/refunds). Sets status='reopened' to mark that
// the row was re-computed after the auto-close window.
posRouter.post('/eod/regenerate', requirePerm('pos.end_of_day'), async (req, res, next) => {
  try {
    const { businessDay } = req.body
    if (!businessDay || !/^\d{4}-\d{2}-\d{2}$/.test(businessDay)) {
      throw new AppError(400, 'businessDay (YYYY-MM-DD) required')
    }
    const { generateEodSettlement } = await import('../services/posEod')
    const result = await generateEodSettlement(
      req.user!.profileId,
      businessDay,
      { closedBy: req.user!.userId, status: 'manually_closed' }
    )
    // After regen, mark as reopened (status update; ON CONFLICT in the
    // engine wrote 'manually_closed', so flip explicitly).
    await query(
      `UPDATE pos_eod_settlements SET status='reopened', updated_at=NOW()
        WHERE landlord_id=$1 AND business_day=$2`,
      [req.user!.profileId, businessDay]
    )
    res.json({ success: true, data: { ...result, status: 'reopened' } })
  } catch (e) { next(e) }
})

// ─────────────────────────────────────────────────────────────
// STRIPE TERMINAL — reader management (S241)
// ─────────────────────────────────────────────────────────────
//
// Hardware-agnostic per Nic decision: "if we are using stripe api any
// stripe hardware should work." All Stripe Terminal API calls fire under
// the LANDLORD's Connect account — POS readers belong to the landlord's
// Stripe account, not GAM's platform.
//
// Payment-processing on a reader (createPI → processPaymentIntent →
// capture flow) is a follow-up session — this batch is just pairing
// infrastructure (Connection Token + register/list/archive readers).

// Helper: pull the landlord's Connect account id, throw 409 if not
// onboarded yet — Terminal requires an active Connect account.
async function getLandlordConnectId(profileId: string): Promise<string> {
  const row = await queryOne<{ stripe_connect_account_id: string | null }>(
    `SELECT u.stripe_connect_account_id
       FROM landlords l JOIN users u ON u.id = l.user_id
      WHERE l.id = $1`,
    [profileId])
  if (!row?.stripe_connect_account_id) {
    throw new AppError(409, 'Landlord has no Stripe Connect account — complete onboarding at /banking first')
  }
  return row.stripe_connect_account_id
}

// POST /api/pos/terminal/connection-token
// Issues a short-lived Connection Token for the Stripe Terminal SDK.
// Frontend fetches one each time the SDK initializes a reader connection.
posRouter.post('/terminal/connection-token', requirePerm('pos.ring_sale', 'pos.manage_inventory'), async (req, res, next) => {
  try {
    const connectId = await getLandlordConnectId(req.user!.profileId)
    const secret = await createConnectionToken(connectId)
    res.json({ success: true, data: { secret } })
  } catch (e) { next(e) }
})

// POST /api/pos/terminal/readers
// Pair a physical reader to a property. Body: { propertyId, registrationCode, nickname }.
// The registration_code appears on the reader's screen when the operator puts it in
// pairing mode; the Stripe Terminal API exchanges it for a persistent reader id.
posRouter.post('/terminal/readers', requirePerm('pos.manage_inventory'), async (req, res, next) => {
  try {
    const { propertyId, registrationCode, nickname, label } = req.body
    if (!propertyId) throw new AppError(400, 'propertyId is required')
    if (!registrationCode) throw new AppError(400, 'registrationCode is required (shown on the reader screen)')
    if (!nickname) throw new AppError(400, 'nickname is required')

    // Validate property belongs to this landlord.
    const prop = await queryOne<{ landlord_id: string }>(
      `SELECT landlord_id FROM properties WHERE id = $1`,
      [propertyId])
    if (!prop || prop.landlord_id !== req.user!.profileId) {
      throw new AppError(400, 'propertyId does not belong to this landlord')
    }

    const connectId = await getLandlordConnectId(req.user!.profileId)
    const row = await registerReader({
      landlordId:               req.user!.profileId,
      landlordConnectAccountId: connectId,
      propertyId,
      registrationCode:         String(registrationCode).trim(),
      nickname:                 String(nickname).trim(),
      label:                    label ? String(label).trim() : undefined,
    })
    res.status(201).json({ success: true, data: row })
  } catch (e) { next(e) }
})

// GET /api/pos/terminal/readers?propertyId=...
// List active readers. Omit propertyId to list all readers across the
// landlord's properties.
posRouter.get('/terminal/readers', requirePerm('pos.ring_sale', 'pos.manage_inventory'), async (req, res, next) => {
  try {
    const propertyId = req.query.propertyId ? String(req.query.propertyId) : undefined
    const rows = await listReaders(req.user!.profileId, propertyId)
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

// DELETE /api/pos/terminal/readers/:id
// Soft-archive a reader (sets status='archived'). The Stripe-side record
// remains; landlord can delete via Stripe dashboard if desired. Historical
// transactions referencing this row still resolve.
posRouter.delete('/terminal/readers/:id', requirePerm('pos.manage_inventory'), async (req, res, next) => {
  try {
    const row = await archiveReader(req.user!.profileId, req.params.id)
    res.json({ success: true, data: row })
  } catch (e) { next(e) }
})

// ── TERMINAL PAYMENT INTENTS (S242) ───────────────────────────────────
//
// Card-present PI lifecycle: create → process-on-reader (smart readers
// only; client-driven Bluetooth readers handle collect/confirm in the
// browser SDK) → capture → record sale via POST /pos/transactions.
//
// All Stripe calls fire under the LANDLORD's Connect account. No
// transfer_data / application_fee — POS sales are landlord revenue;
// GAM's POS revenue is the monthly per-unit platform fee, not a
// per-transaction cut.
//
// Cancel route exists for the void-before-capture path (operator
// cancels at the reader prompt, customer walks, reader times out).

function assertReaderBelongsToLandlord(landlordId: string, stripeReaderId: string) {
  return queryOne<{ property_id: string }>(
    `SELECT property_id FROM pos_terminal_readers
      WHERE landlord_id = $1 AND stripe_reader_id = $2 AND status = 'active'`,
    [landlordId, stripeReaderId])
}

// POST /api/pos/terminal/payment-intents — create a card-present PI on
// the landlord's Connect account. Body: { amountCents, propertyId,
// description?, posDraftRef? }.
posRouter.post('/terminal/payment-intents', requirePerm('pos.ring_sale'), async (req, res, next) => {
  try {
    const { amountCents, propertyId, description, posDraftRef } = req.body
    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      throw new AppError(400, 'amountCents must be a positive integer')
    }
    if (!propertyId) throw new AppError(400, 'propertyId is required')

    // Validate property belongs to this landlord. Same posture as the
    // reader-registration route — prevents a cashier on landlord A from
    // creating a PI tagged to landlord B's property.
    const prop = await queryOne<{ landlord_id: string }>(
      `SELECT landlord_id FROM properties WHERE id = $1`,
      [propertyId])
    if (!prop || prop.landlord_id !== req.user!.profileId) {
      throw new AppError(400, 'propertyId does not belong to this landlord')
    }

    const connectId = await getLandlordConnectId(req.user!.profileId)
    const intent = await createCardPresentPaymentIntent({
      landlordConnectAccountId: connectId,
      landlordId:               req.user!.profileId,
      propertyId,
      amountCents,
      description,
      posDraftRef,
    })
    res.status(201).json({
      success: true,
      data: { id: intent.id, status: intent.status, clientSecret: intent.client_secret },
    })
  } catch (e) { next(e) }
})

// GET /api/pos/terminal/payment-intents/:id — read PI status. Used by
// the smart-reader server-driven flow: after POST /process, the
// reader prompts the customer (tap / insert / swipe) asynchronously,
// and the frontend polls this endpoint to learn when the PI flips
// from `requires_payment_method` → `requires_capture` (auth success)
// or → `requires_payment_method` with a last_payment_error (auth
// failure). Client-driven Bluetooth flows don't need this — the JS
// SDK returns the terminal status directly to the cashier's browser.
posRouter.get('/terminal/payment-intents/:id', requirePerm('pos.ring_sale'), async (req, res, next) => {
  try {
    const paymentIntentId = req.params.id
    const connectId = await getLandlordConnectId(req.user!.profileId)
    const intent = await retrieveTerminalPaymentIntent({
      landlordConnectAccountId: connectId,
      paymentIntentId,
    })
    if (intent.metadata?.gam_landlord_id !== req.user!.profileId) {
      throw new AppError(403, 'PaymentIntent belongs to a different landlord')
    }
    res.json({
      success: true,
      data: {
        id:                 intent.id,
        status:             intent.status,
        amount:             intent.amount,
        lastPaymentError:   intent.last_payment_error?.message ?? null,
      },
    })
  } catch (e) { next(e) }
})

// POST /api/pos/terminal/payment-intents/:id/process — push the PI to
// a physical reader (server-driven flow). Body: { stripeReaderId }.
// Stripe's id for the reader (returned from /terminal/readers), not
// our internal pos_terminal_readers row uuid.
posRouter.post('/terminal/payment-intents/:id/process', requirePerm('pos.ring_sale'), async (req, res, next) => {
  try {
    const paymentIntentId = req.params.id
    const { stripeReaderId } = req.body
    if (!stripeReaderId) throw new AppError(400, 'stripeReaderId is required')

    const ownerRow = await assertReaderBelongsToLandlord(req.user!.profileId, stripeReaderId)
    if (!ownerRow) throw new AppError(404, 'Reader not registered to this landlord')

    const connectId = await getLandlordConnectId(req.user!.profileId)
    const reader = await processPaymentIntentOnReader({
      landlordConnectAccountId: connectId,
      stripeReaderId,
      paymentIntentId,
    })
    res.json({
      success: true,
      data: {
        readerId: reader.id,
        action:   reader.action,  // status + payment_intent details for client polling
      },
    })
  } catch (e) { next(e) }
})

// POST /api/pos/terminal/payment-intents/:id/capture — flip a PI in
// `requires_capture` to `succeeded`. Called after the reader confirms
// the auth and the operator confirms the sale.
posRouter.post('/terminal/payment-intents/:id/capture', requirePerm('pos.ring_sale'), async (req, res, next) => {
  try {
    const paymentIntentId = req.params.id
    const connectId = await getLandlordConnectId(req.user!.profileId)
    const intent = await captureTerminalPaymentIntent({
      landlordConnectAccountId: connectId,
      paymentIntentId,
    })
    res.json({ success: true, data: { id: intent.id, status: intent.status, amount: intent.amount } })
  } catch (e) { next(e) }
})

// POST /api/pos/terminal/payment-intents/:id/cancel — void the PI
// before capture. Operator voids the sale, customer walks, reader
// times out, etc.
posRouter.post('/terminal/payment-intents/:id/cancel', requirePerm('pos.ring_sale'), async (req, res, next) => {
  try {
    const paymentIntentId = req.params.id
    const connectId = await getLandlordConnectId(req.user!.profileId)
    const intent = await cancelTerminalPaymentIntent({
      landlordConnectAccountId: connectId,
      paymentIntentId,
    })
    res.json({ success: true, data: { id: intent.id, status: intent.status } })
  } catch (e) { next(e) }
})

// ── S263: POS sessions (server-of-record cart state) ──────────────────────
//
// Sessions back the in-progress POS cart with server state. Replaces the
// client-side useState cart on apps/pos so terminals can survive crashes,
// hand off carts between terminals (cross-terminal tab), and serve single-
// counter shops where one staff member's session needs to persist across
// logouts. Checkout pathway: POST /pos/sessions/:id/checkout proxies the
// session items through the existing /pos/transactions flow, then marks
// the session 'completed' with completed_transaction_id link.

// GET /pos/sessions?status=open[&property_id=...]
posRouter.get('/sessions', requirePerm('pos.ring_sale'), async (req, res, next) => {
  try {
    const status = String(req.query.status || 'open')
    const propertyId = req.query.propertyId ? String(req.query.propertyId) : null
    const params: any[] = [req.user!.profileId, status]
    let propertyClause = ''
    if (propertyId) { params.push(propertyId); propertyClause = ' AND s.property_id = $3' }
    const sessions = await query<any>(
      `SELECT s.*,
              COALESCE(
                pcu.first_name || ' ' || pcu.last_name,
                tu.first_name  || ' ' || tu.last_name
              ) AS customer_name,
              pr.name AS property_name,
              (SELECT COUNT(*)::int FROM pos_session_items WHERE session_id = s.id) AS item_count
         FROM pos_sessions s
         LEFT JOIN pos_customers pcu ON pcu.id = s.pos_customer_id
         LEFT JOIN tenants       t   ON t.id   = s.tenant_id
         LEFT JOIN users         tu  ON tu.id  = t.user_id
         LEFT JOIN properties    pr  ON pr.id  = s.property_id
        WHERE s.landlord_id = $1
          AND s.status      = $2${propertyClause}
        ORDER BY s.opened_at DESC`,
      params,
    )
    res.json({ success: true, data: sessions })
  } catch (e) { next(e) }
})

// POST /pos/sessions — open a fresh session for the calling user.
// Body: { propertyId, posCustomerId?, tenantId?, notes? }
posRouter.post('/sessions', requirePerm('pos.ring_sale'), async (req, res, next) => {
  try {
    const { propertyId, posCustomerId, tenantId, notes } = req.body || {}
    if (!propertyId) throw new AppError(400, 'propertyId required')
    if (posCustomerId && tenantId) throw new AppError(400, 'posCustomerId and tenantId are mutually exclusive')

    // Verify the property belongs to the calling landlord.
    const prop = await queryOne<{ landlord_id: string }>(
      `SELECT landlord_id FROM properties WHERE id = $1`,
      [propertyId],
    )
    if (!prop || prop.landlord_id !== req.user!.profileId) {
      throw new AppError(403, 'Property does not belong to this landlord')
    }

    const row = await queryOne<any>(
      `INSERT INTO pos_sessions
         (property_id, landlord_id, opened_by_user_id, pos_customer_id, tenant_id, notes)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [propertyId, req.user!.profileId, req.user!.userId, posCustomerId || null, tenantId || null, notes || null],
    )
    res.json({ success: true, data: row })
  } catch (e) { next(e) }
})

// GET /pos/sessions/:id — full session + items.
posRouter.get('/sessions/:id', requirePerm('pos.ring_sale'), async (req, res, next) => {
  try {
    const session = await queryOne<any>(
      `SELECT s.*,
              COALESCE(
                pcu.first_name || ' ' || pcu.last_name,
                tu.first_name  || ' ' || tu.last_name
              ) AS customer_name,
              pr.name AS property_name
         FROM pos_sessions s
         LEFT JOIN pos_customers pcu ON pcu.id = s.pos_customer_id
         LEFT JOIN tenants       t   ON t.id   = s.tenant_id
         LEFT JOIN users         tu  ON tu.id  = t.user_id
         LEFT JOIN properties    pr  ON pr.id  = s.property_id
        WHERE s.id = $1 AND s.landlord_id = $2`,
      [req.params.id, req.user!.profileId],
    )
    if (!session) throw new AppError(404, 'Session not found')
    const items = await query<any>(
      `SELECT * FROM pos_session_items WHERE session_id = $1 ORDER BY created_at ASC`,
      [req.params.id],
    )
    res.json({ success: true, data: { session, items } })
  } catch (e) { next(e) }
})

// PATCH /pos/sessions/:id — update customer / discount / notes.
// Body: { posCustomerId?, tenantId?, discountAmount?, notes? }
posRouter.patch('/sessions/:id', requirePerm('pos.ring_sale'), async (req, res, next) => {
  try {
    const session = await queryOne<any>(
      `SELECT id, status FROM pos_sessions WHERE id = $1 AND landlord_id = $2`,
      [req.params.id, req.user!.profileId],
    )
    if (!session) throw new AppError(404, 'Session not found')
    if (session.status !== 'open') throw new AppError(409, `Session is ${session.status}`)

    const { posCustomerId, tenantId, discountAmount, notes } = req.body || {}
    if (posCustomerId && tenantId) throw new AppError(400, 'posCustomerId and tenantId are mutually exclusive')

    const sets: string[] = []
    const params: any[] = []
    if (posCustomerId !== undefined) { params.push(posCustomerId || null); sets.push(`pos_customer_id = $${params.length}`) }
    if (tenantId !== undefined)      { params.push(tenantId || null);      sets.push(`tenant_id = $${params.length}`) }
    if (discountAmount !== undefined) {
      const d = Number(discountAmount)
      if (!Number.isFinite(d) || d < 0) throw new AppError(400, 'discountAmount must be a non-negative number')
      params.push(d.toFixed(2)); sets.push(`discount_amount = $${params.length}`)
    }
    if (notes !== undefined) { params.push(notes); sets.push(`notes = $${params.length}`) }
    if (sets.length === 0) throw new AppError(400, 'Nothing to update')

    params.push(req.params.id)
    const updated = await queryOne<any>(
      `UPDATE pos_sessions SET ${sets.join(', ')}, updated_at = NOW()
        WHERE id = $${params.length}
        RETURNING *`,
      params,
    )
    await recomputeSessionTotals(req.params.id)
    res.json({ success: true, data: updated })
  } catch (e) { next(e) }
})

// POST /pos/sessions/:id/items — add a line item.
// Body: { itemId?, itemVariantId?, itemName, itemCategory?, qty, unitPrice, taxRate?, costPrice?, notes? }
posRouter.post('/sessions/:id/items', requirePerm('pos.ring_sale'), async (req, res, next) => {
  try {
    const session = await queryOne<any>(
      `SELECT id, status FROM pos_sessions WHERE id = $1 AND landlord_id = $2`,
      [req.params.id, req.user!.profileId],
    )
    if (!session) throw new AppError(404, 'Session not found')
    if (session.status !== 'open') throw new AppError(409, `Session is ${session.status}`)

    const b = req.body || {}
    const qty = Number(b.qty)
    const unitPrice = Number(b.unitPrice)
    if (!b.itemName) throw new AppError(400, 'itemName required')
    if (!Number.isFinite(qty) || qty <= 0) throw new AppError(400, 'qty must be positive')
    if (!Number.isFinite(unitPrice) || unitPrice < 0) throw new AppError(400, 'unitPrice must be non-negative')

    const taxRate = Number(b.taxRate) || 0
    const costPrice = Number(b.costPrice) || 0
    const subtotal = Math.round(qty * unitPrice * 100) / 100

    const inserted = await queryOne<any>(
      `INSERT INTO pos_session_items
         (session_id, item_id, item_variant_id, item_name, item_category,
          qty, unit_price, cost_price, tax_rate, subtotal, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        req.params.id, b.itemId || null, b.itemVariantId || null,
        b.itemName, b.itemCategory || null,
        qty, unitPrice.toFixed(2), costPrice.toFixed(2), taxRate, subtotal.toFixed(2),
        b.notes || null,
      ],
    )
    await recomputeSessionTotals(req.params.id)
    res.json({ success: true, data: inserted })
  } catch (e) { next(e) }
})

// PATCH /pos/sessions/:id/items/:itemId — update qty / price / notes.
posRouter.patch('/sessions/:id/items/:itemId', requirePerm('pos.ring_sale'), async (req, res, next) => {
  try {
    const session = await queryOne<any>(
      `SELECT id, status FROM pos_sessions WHERE id = $1 AND landlord_id = $2`,
      [req.params.id, req.user!.profileId],
    )
    if (!session) throw new AppError(404, 'Session not found')
    if (session.status !== 'open') throw new AppError(409, `Session is ${session.status}`)

    const b = req.body || {}
    const sets: string[] = []
    const params: any[] = []
    if (b.qty !== undefined) {
      const q = Number(b.qty)
      if (!Number.isFinite(q) || q <= 0) throw new AppError(400, 'qty must be positive')
      params.push(q); sets.push(`qty = $${params.length}`)
    }
    if (b.unitPrice !== undefined) {
      const u = Number(b.unitPrice)
      if (!Number.isFinite(u) || u < 0) throw new AppError(400, 'unitPrice must be non-negative')
      params.push(u.toFixed(2)); sets.push(`unit_price = $${params.length}`)
    }
    if (b.notes !== undefined) { params.push(b.notes); sets.push(`notes = $${params.length}`) }
    if (sets.length === 0) throw new AppError(400, 'Nothing to update')

    params.push(req.params.itemId, req.params.id)
    const updated = await queryOne<any>(
      `UPDATE pos_session_items SET ${sets.join(', ')}, updated_at = NOW()
        WHERE id = $${params.length - 1} AND session_id = $${params.length}
        RETURNING *`,
      params,
    )
    if (!updated) throw new AppError(404, 'Line item not found')

    // Refresh subtotal off the new qty * unit_price.
    await query(
      `UPDATE pos_session_items
          SET subtotal = ROUND(qty * unit_price, 2), updated_at = NOW()
        WHERE id = $1`,
      [req.params.itemId],
    )
    await recomputeSessionTotals(req.params.id)
    res.json({ success: true })
  } catch (e) { next(e) }
})

// DELETE /pos/sessions/:id/items/:itemId
posRouter.delete('/sessions/:id/items/:itemId', requirePerm('pos.ring_sale'), async (req, res, next) => {
  try {
    const session = await queryOne<any>(
      `SELECT id, status FROM pos_sessions WHERE id = $1 AND landlord_id = $2`,
      [req.params.id, req.user!.profileId],
    )
    if (!session) throw new AppError(404, 'Session not found')
    if (session.status !== 'open') throw new AppError(409, `Session is ${session.status}`)

    await query(
      `DELETE FROM pos_session_items WHERE id = $1 AND session_id = $2`,
      [req.params.itemId, req.params.id],
    )
    await recomputeSessionTotals(req.params.id)
    res.json({ success: true })
  } catch (e) { next(e) }
})

// POST /pos/sessions/:id/void — abandon an open session.
// Body: { reason? }
posRouter.post('/sessions/:id/void', requirePerm('pos.ring_sale'), async (req, res, next) => {
  try {
    const updated = await queryOne<any>(
      `UPDATE pos_sessions
          SET status = 'voided',
              void_reason = $1,
              closed_at = NOW(),
              updated_at = NOW()
        WHERE id = $2 AND landlord_id = $3 AND status = 'open'
        RETURNING *`,
      [req.body?.reason || null, req.params.id, req.user!.profileId],
    )
    if (!updated) throw new AppError(404, 'Open session not found')
    res.json({ success: true, data: updated })
  } catch (e) { next(e) }
})

// POST /pos/sessions/:id/complete — internal helper called by the
// frontend after a successful POST /pos/transactions to link the
// session to its transaction and mark status='completed'. Idempotent.
// Body: { transactionId }
posRouter.post('/sessions/:id/complete', requirePerm('pos.ring_sale'), async (req, res, next) => {
  try {
    const { transactionId } = req.body || {}
    if (!transactionId) throw new AppError(400, 'transactionId required')

    // Verify the transaction belongs to the calling landlord — defense
    // against a malicious cashier marking someone else's session against
    // their transaction.
    const tx = await queryOne<{ landlord_id: string }>(
      `SELECT landlord_id FROM pos_transactions WHERE id = $1`,
      [transactionId],
    )
    if (!tx || tx.landlord_id !== req.user!.profileId) {
      throw new AppError(403, 'Transaction not owned by this landlord')
    }

    const updated = await queryOne<any>(
      `UPDATE pos_sessions
          SET status = 'completed',
              completed_transaction_id = $1,
              closed_at = NOW(),
              updated_at = NOW()
        WHERE id = $2 AND landlord_id = $3 AND status = 'open'
        RETURNING *`,
      [transactionId, req.params.id, req.user!.profileId],
    )
    // Idempotent: if already completed for this transaction, return success.
    if (!updated) {
      const existing = await queryOne<any>(
        `SELECT * FROM pos_sessions WHERE id = $1 AND completed_transaction_id = $2`,
        [req.params.id, transactionId],
      )
      if (existing) return res.json({ success: true, data: existing })
      throw new AppError(409, 'Session is not open')
    }
    res.json({ success: true, data: updated })
  } catch (e) { next(e) }
})

// Helper — recompute subtotal / tax / total from the live items on a
// session. Called after every item mutation + discount edit. Tax for
// each line uses the line's stored tax_rate (set at add time from the
// pos_tax_rates catalog or client-supplied for walk-up items).
async function recomputeSessionTotals(sessionId: string): Promise<void> {
  await query(
    `UPDATE pos_sessions s SET
        subtotal   = COALESCE(t.subtotal, 0),
        tax_amount = COALESCE(t.tax_amount, 0),
        total      = GREATEST(0, COALESCE(t.subtotal, 0) + COALESCE(t.tax_amount, 0) - s.discount_amount),
        updated_at = NOW()
       FROM (
         SELECT
           ROUND(SUM(qty * unit_price), 2) AS subtotal,
           ROUND(SUM(qty * unit_price * tax_rate), 2) AS tax_amount
           FROM pos_session_items
          WHERE session_id = $1
       ) t
      WHERE s.id = $1`,
    [sessionId],
  )
}

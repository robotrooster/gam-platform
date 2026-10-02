import { Router } from 'express'
import { z } from 'zod'
import { insertPosSale } from '../services/posSale'
import { cardFeeSplit, type CardFeePayer } from '@gam/shared'

const round2 = (n: number) => Math.round(n * 100) / 100
import { query, queryOne, getClient } from '../db'
import { requireAuth, requirePerm, assertPropertyInScope } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { calculateCartTax, computeCartTotals, aggregateCartTotals, effectiveItemTaxes } from '../services/posTax'
import { holdForTheCart, createConnectionToken, registerReader, listReaders, archiveReader, createCardPresentPaymentIntent, processPaymentIntentOnReader, captureTerminalPaymentIntent, cancelTerminalPaymentIntent, retrieveTerminalPaymentIntent, cancelReaderAction, showCartOnReader, clearCartOnReader, readerAction, retrieveTerminalPaymentIntentWithCharge } from '../services/posTerminal'
import crypto from 'crypto'
import { logger } from '../lib/logger'
import { resolveLandlordTarget, ownsLandlord, landlordScopeIds } from '../lib/landlordScope'
import { cardIdentityFromIntent, findOrCreateCustomerForCard, startSaveCardPrompt, readSaveCardAnswer, saveCardForCustomer, mergePosCustomers, type CardIdentity, type CardCustomer } from '../services/posCustomerCards'

export const posRouter = Router()
posRouter.use(requireAuth)

// S649 (Nic): "there's no item at all" — an account that owns two companies
// (Mountain View + Oak Park) got "You own more than one company" from every
// register call that didn't name one, so the register showed nothing. Nearly
// every call already names the PROPERTY, and the property says which company
// it is: derive it from there (only for a company the caller may act on).
posRouter.use(async (req: any, _res, next) => {
  try {
    // Only when the account actually spans companies — a single-company
    // account (and a cashier) resolves exactly as before.
    if (!req.body?.landlordId && !req.query?.landlordId && landlordScopeIds(req.user).length > 1) {
      const pid = String(req.query?.propertyId ?? req.body?.propertyId ?? '')
      if (/^[0-9a-f-]{36}$/i.test(pid)) {
        const row = await queryOne<{ landlord_id: string }>(`SELECT landlord_id FROM properties WHERE id = $1`, [pid])
        if (row && ownsLandlord(req.user, row.landlord_id)) req.posPropertyLandlordId = row.landlord_id
      }
      // S654 (Nic, live): "the Resume and Discard buttons are not doing
      // anything." A call that names a ROW and no property — /sessions/:id,
      // /items/:id, /transactions/:id/void — had nothing to derive the company
      // from and fell back on a default company Nic never wanted, so a Mountain
      // View tab "did not exist". The row says which company it is: take it from
      // there, for a company the caller may act on. No default remains anywhere.
      if (!req.posPropertyLandlordId) {
        const m = String(req.path).match(/^\/([a-z-]+(?:\/[a-z-]+)?)\/([0-9a-f-]{36})(?:\/|$)/i)
        const table = m ? ROW_TABLE[m[1].toLowerCase()] : undefined
        if (table) {
          const row = await queryOne<{ landlord_id: string }>(`SELECT landlord_id FROM ${table} WHERE id = $1`, [m![2]])
          if (row && ownsLandlord(req.user, row.landlord_id)) req.posPropertyLandlordId = row.landlord_id
        }
      }
    }
    next()
  } catch (e) { next(e) }
})

/**
 * S633 — WHICH COMPANY'S REGISTER IS THIS?
 *
 * POS is landlord-operated: items, tax categories, stock and sales all hang off
 * a `landlords` row. Every route here used to read `req.user.profileId` — the
 * single company a session sat on — which stops being an answer once an account
 * owns more than one. It is the same defect the rest of S633 removes, and
 * leaving it would have made the register unusable rather than merely wrong:
 * profileId is null for a landlord now.
 *
 * So the register names its company. An account that owns exactly one gets it
 * silently — every existing single-company merchant is unaffected. An account
 * that owns several must say which, because a sale, a stock adjustment and a
 * tax rate all belong to one book and cannot be split after the fact.
 *
 * NOTE for the POS UI: a multi-company account needs a register/location picker
 * that sends `landlordId`. Until it has one, such an account gets a clear 400
 * naming the problem rather than a silently mis-filed sale.
 */
// S654: which table a row-keyed register path names. Every one carries landlord_id.
const ROW_TABLE: Record<string, string> = {
  'categories': 'pos_categories', 'discounts': 'pos_discounts', 'items': 'pos_items',
  'purchase-orders': 'pos_purchase_orders', 'reader-orders': 'pos_reader_orders', 'sessions': 'pos_sessions',
  'tax-categories': 'pos_tax_categories', 'tax-rates': 'pos_tax_rates', 'tickets': 'pos_open_tickets',
  'transactions': 'pos_transactions', 'vendors': 'pos_vendors', 'terminal/readers': 'pos_terminal_readers',
  'customers': 'pos_customers', 'refunds': 'pos_refunds', 'pay-links': 'pos_pay_links',
}

function posLandlordId(req: any): string {
  return resolveLandlordTarget(req.user!, req.body?.landlordId ?? req.query?.landlordId ?? req.posPropertyLandlordId, 'register')
}

// POS money/quantity fields are never negative. Mirrors the client-side nonNeg
// guards on POSPage so a negative can't slip in via a direct API call. Optional
// fields (undefined/null/'') pass through untouched; a present value must parse
// finite and ≥ 0, else 400. Each entry is [value, human-readable field name].
function assertNonNeg(...fields: [unknown, string][]): void {
  for (const [val, name] of fields) {
    if (val === undefined || val === null || val === '') continue
    const n = Number(val)
    if (!Number.isFinite(n) || n < 0) throw new AppError(400, `${name} cannot be negative`)
  }
}

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
      // S652 (Nic): "there needs to be a price on the actual button." A stay's
      // button shows the property's BASE rate — the cheapest site of that
      // length — and the cart line updates to the chosen site's rate when the
      // site is picked. Front-desk staff never see a blank price.
      items = await query<any>(
        `SELECT pi.*, pc.name AS category,
                CASE pi.stay_unit
                  WHEN 'night' THEN COALESCE((SELECT MIN(u.nightly_rate) FROM units u WHERE u.property_id = pi.property_id AND u.retired_at IS NULL AND u.nightly_rate > 0), p.nightly_rate)
                  WHEN 'week'  THEN COALESCE((SELECT MIN(u.weekly_rate)  FROM units u WHERE u.property_id = pi.property_id AND u.retired_at IS NULL AND u.weekly_rate  > 0), p.weekly_rate)
                  WHEN 'month' THEN COALESCE((SELECT MIN(u.monthly_rate) FROM units u WHERE u.property_id = pi.property_id AND u.retired_at IS NULL AND u.monthly_rate > 0), p.monthly_rate)
                  ELSE NULL END AS base_rate
          FROM pos_items pi
          LEFT JOIN pos_categories pc ON pc.id = pi.category_id
          LEFT JOIN properties p ON p.id = pi.property_id
          WHERE pi.landlord_id = $1
            AND pi.is_active = TRUE
            AND pi.property_id = $2
          ORDER BY pc.name, pi.name`,
        [posLandlordId(req), propertyFilter],
      )
    } else {
      items = await query<any>(
        `SELECT pi.*, pc.name AS category
          FROM pos_items pi
          LEFT JOIN pos_categories pc ON pc.id = pi.category_id
          WHERE pi.landlord_id=$1 AND pi.is_active=TRUE
          ORDER BY pc.name, pi.name`,
        [posLandlordId(req)],
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
          [posLandlordId(req), cat.name, cat.icon, cat.sort_order],
        )
      }
      const cats = await query<{ id: string; name: string }>(
        'SELECT id, name FROM pos_categories WHERE landlord_id=$1',
        [posLandlordId(req)],
      )
      const catIdByName = new Map(cats.map(c => [c.name, c.id]))
      for (const item of DEFAULT_ITEMS) {
        const catId = catIdByName.get(item.category)
        if (!catId) continue  // defensive — shouldn't happen since we just seeded
        await query(`INSERT INTO pos_items (landlord_id,property_id,name,category_id,icon,sell_price,cost_price,tax_rate,stock_qty,stock_min,stock_max,charge_eligible,margin_pct)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,ROUND((($6-$7)/$6)*100,2))`,
          [posLandlordId(req), propertyFilter, item.name, catId, item.icon, item.sell_price,
           item.cost_price, item.tax_rate, item.stock_qty, item.stock_min, item.stock_max,
           item.charge_eligible ?? true])
      }
      items = await query<any>(
        `SELECT pi.*, pc.name AS category
          FROM pos_items pi
          LEFT JOIN pos_categories pc ON pc.id = pi.category_id
          WHERE pi.landlord_id=$1 AND pi.is_active=TRUE AND pi.property_id=$2
          ORDER BY pc.name, pi.name`,
        [posLandlordId(req), propertyFilter],
      )
    }

    // S650: each item carries the tax it will actually be charged — the same
    // resolution the sale uses — and the names behind it, so the register's
    // cart estimate is what the server charges.
    const eff = await effectiveItemTaxes(posLandlordId(req), items.map((i: any) => i.id))
    // S652: stock is numeric(12,3) now (propane by the gallon) and the driver
    // hands numerics back as text — the client gets a number.
    items = items.map((i: any) => ({ ...i, stock_qty: i.stock_qty == null ? i.stock_qty : Number(i.stock_qty),
      tax_rate: eff.get(i.id)?.rate ?? 0,
      taxes: eff.get(i.id)?.taxes ?? [] }))

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
      `SELECT pos_default_margin_pct, business_name FROM landlords WHERE id = $1`, [posLandlordId(req)])
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
    await query(`UPDATE landlords SET pos_default_margin_pct = $1 WHERE id = $2`, [val, posLandlordId(req)])
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
    assertNonNeg([costPrice, 'Cost price'], [sellPrice, 'Sell price'], [marginPct, 'Margin'],
      [taxRate, 'Tax rate'], [stockQty, 'Stock qty'], [stockMin, 'Stock min'], [stockMax, 'Stock max'])
    // S241: propertyId now required (NOT NULL at the schema level).
    if (!propertyId) {
      throw new AppError(400, 'propertyId is required — items are per-property')
    }
    const cat = await queryOne<{ landlord_id: string }>(
      `SELECT landlord_id FROM pos_categories WHERE id = $1`,
      [categoryId],
    )
    if (!cat || cat.landlord_id !== posLandlordId(req)) {
      throw new AppError(400, 'categoryId does not belong to this landlord')
    }

    const margin = marginPct ?? (costPrice > 0 ? ((sellPrice - costPrice) / sellPrice) * 100 : null)

    // Validate propertyId belongs to this landlord.
    const prop = await queryOne<{ landlord_id: string }>(
      `SELECT landlord_id FROM properties WHERE id = $1`,
      [propertyId],
    )
    if (!prop || prop.landlord_id !== posLandlordId(req)) {
      throw new AppError(400, 'propertyId does not belong to this landlord')
    }

    const item = await queryOne<any>(`INSERT INTO pos_items
      (landlord_id,property_id,name,category_id,icon,cost_price,sell_price,margin_pct,tax_rate,charge_eligible,stock_qty,stock_min,stock_max,vendor_id,shelf_label_enabled,tax_category_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [posLandlordId(req), propertyId, name, categoryId, icon||'📦', costPrice||0, sellPrice,
       margin, taxRate||0, chargeEligible??true, stockQty||0, stockMin||5, stockMax||50,
       vendorId||null, shelfLabelEnabled??true, taxCategoryId||null])

    res.status(201).json({ success: true, data: item })
  } catch (e) { next(e) }
})

// PATCH /api/pos/items/:id
// S227: accepts categoryId (uuid). Validates ownership before assignment.
posRouter.patch('/items/:id', requirePerm('pos.manage_inventory'), async (req, res, next) => {
  try {
    const item = await queryOne<any>('SELECT * FROM pos_items WHERE id=$1 AND landlord_id=$2', [req.params.id, posLandlordId(req)])
    if (!item) throw new AppError(404, 'Item not found')

    const { name, categoryId, icon, costPrice, sellPrice, marginPct, taxRate,
            chargeEligible, stockQty, stockMin, stockMax, vendorId, isActive, propertyId, taxCategoryId } = req.body
    assertNonNeg([costPrice, 'Cost price'], [sellPrice, 'Sell price'], [marginPct, 'Margin'],
      [taxRate, 'Tax rate'], [stockQty, 'Stock qty'], [stockMin, 'Stock min'], [stockMax, 'Stock max'])
    // S554 (button-sweep bug #12): the item-edit modal sends stockQty but the
    // route dropped it — stock edits silently no-op'd. undefined preserves;
    // a value re-sets and is audited via pos_inventory_log below (mirrors
    // the adjust-stock route) so a manual correction leaves a trail.
    const newStockQty: number = stockQty !== undefined ? Math.max(0, Number(stockQty)) : item.stock_qty
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
      if (!cat || cat.landlord_id !== posLandlordId(req)) {
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
      if (!prop || prop.landlord_id !== posLandlordId(req)) {
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
      if (!v || v.landlord_id !== posLandlordId(req)) {
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
      is_active=$12, property_id=$13, tax_category_id=$15, stock_qty=$16, updated_at=NOW() WHERE id=$14 RETURNING *`,
      [name??item.name, newCategoryId, icon??item.icon,
       newCostPrice, newSellPrice, newMargin,
       taxRate??item.tax_rate, chargeEligible??item.charge_eligible,
       stockMin??item.stock_min, stockMax??item.stock_max,
       newVendorId, isActive??item.is_active, newPropertyId, item.id, newTaxCategoryId, newStockQty])

    // Audit a manual stock correction made through the edit form.
    if (newStockQty !== item.stock_qty) {
      await query(`INSERT INTO pos_inventory_log (item_id,landlord_id,change_qty,reason,notes,stock_before,stock_after)
        VALUES ($1,$2,$3,'manual','Item edit form',$4,$5)`,
        [item.id, posLandlordId(req), newStockQty - item.stock_qty, item.stock_qty, newStockQty])
    }

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
    let rows = await query(`SELECT * FROM pos_tax_categories WHERE landlord_id=$1 ${inactive} ORDER BY sort_order, name`, [posLandlordId(req)])
    if (rows.length === 0) {
      for (const t of DEFAULT_TAX_CATEGORIES) {
        await query('INSERT INTO pos_tax_categories (landlord_id,name,rate,sort_order) VALUES ($1,$2,$3,$4)', [posLandlordId(req), t.name, t.rate, t.sort_order])
      }
      rows = await query(`SELECT * FROM pos_tax_categories WHERE landlord_id=$1 ${inactive} ORDER BY sort_order, name`, [posLandlordId(req)])
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
      const row = await queryOne('INSERT INTO pos_tax_categories (landlord_id,name,rate,sort_order) VALUES ($1,$2,$3,$4) RETURNING *', [posLandlordId(req), name.trim(), r, sortOrder||0])
      res.status(201).json({ success: true, data: row })
    } catch (e: any) {
      if (e?.code === '23505') throw new AppError(409, `A tax category named "${name.trim()}" already exists`)
      throw e
    }
  } catch (e) { next(e) }
})

posRouter.patch('/tax-categories/:id', requirePerm('pos.manage_inventory'), async (req, res, next) => {
  try {
    const cat = await queryOne<any>('SELECT * FROM pos_tax_categories WHERE id=$1 AND landlord_id=$2', [req.params.id, posLandlordId(req)])
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
    const item = await queryOne<any>('SELECT * FROM pos_items WHERE id=$1 AND landlord_id=$2', [req.params.id, posLandlordId(req)])
    if (!item) throw new AppError(404, 'Item not found')

    const newQty = Math.max(0, Number(item.stock_qty) + changeQty)
    await query('UPDATE pos_items SET stock_qty=$1, updated_at=NOW() WHERE id=$2', [newQty, item.id])
    await query(`INSERT INTO pos_inventory_log (item_id,landlord_id,change_qty,reason,notes,stock_before,stock_after)
      VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [item.id, posLandlordId(req), changeQty, reason||'adjustment', notes||null, item.stock_qty, newQty])

    res.json({ success: true, data: { stockBefore: Number(item.stock_qty), stockAfter: newQty } })
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
/**
 * S648 (Nic, DIRECTIVE): "any bank card, whether it's in person or at point of
 * sale or they do it on their link that they get emailed, those all get charged
 * the pass-through." The fee a sale carries is decided HERE, from the tender —
 * a card pays the card fee (PROCESSING_FEES), a FlexCharge sale its 1% — never
 * taken from the client. Everything else carries none.
 */
/**
 * S650 (Nic): the front counter rings sales and sends pay links — no
 * discounts, no editing prices. The cart's prices come from the browser, so
 * the server holds a cashier to the catalog: a catalog item sells at its own
 * price (or one of its variants' prices), and a discount needs the "Apply
 * discounts" permission. Owners, and staff trusted with discounts or item
 * setup, may set prices as before.
 */
/**
 * S650 (Nic): "Items are set prices. There's no custom item thing." Everything
 * the register sells is a button somebody set up, so a line with no catalog
 * item behind it is refused. A one-off (they ran over the pedestal) is a charge
 * on the lease, or a pay link for somebody without one.
 */
function assertCatalogItems(lines: { itemId?: string | null }[]): void {
  if (lines.some((l) => !l.itemId)) {
    throw new AppError(400,
      'Every register item is one you set up. For a one-off charge, bill it to the lease or send a pay link.')
  }
}

function canSetPrices(user: any): boolean {
  if (!user) return false
  if (['admin', 'super_admin', 'landlord'].includes(user.role)) return true
  const perms = user.permissions || {}
  return perms['pos.discount'] === true || perms['pos.manage_inventory'] === true
}
async function assertCashierPricing(req: any, lines: { itemId?: string | null; price: any }[],
                                    discountAmount?: any): Promise<void> {
  if (canSetPrices(req.user)) return
  if (Number(discountAmount) > 0) {
    throw new AppError(403, 'Discounts need the "Apply discounts" permission — ask the owner or a manager.')
  }
  const ids = [...new Set(lines.map((l) => l.itemId).filter((x): x is string =>
    typeof x === 'string' && /^[0-9a-f-]{36}$/i.test(x)))]
  if (!ids.length) return
  const rows = await query<{ id: string; prices: string[]; stay_unit: string | null }>(
    `SELECT i.id, i.stay_unit, ARRAY[i.sell_price::text] || COALESCE(
              (SELECT array_agg(v.sell_price::text) FROM pos_item_variants v
                WHERE v.item_id = i.id AND v.is_active = TRUE), '{}') AS prices
       FROM pos_items i WHERE i.id = ANY($1::uuid[]) AND i.landlord_id = $2`,
    [ids, posLandlordId(req)])
  const allowed = new Map(rows.map((r) => [r.id, r.prices.map(Number)]))
  // S652: a stay is not priced from the catalog — the site's rate card decides,
  // and the server sets it. Holding a cashier to the item's sell_price here
  // would refuse every stay, since the two are not the same number and are not
  // meant to be. Nothing is loosened: the price the browser sent for a stay is
  // discarded and replaced before anything is totaled.
  const stayItems = new Set(rows.filter((r) => r.stay_unit).map((r) => r.id))
  for (const l of lines) {
    if (!l.itemId || !allowed.has(l.itemId)) continue
    if (stayItems.has(l.itemId)) continue
    const price = Number(l.price)
    if (!allowed.get(l.itemId)!.some((p) => Math.abs(p - price) < 0.005)) {
      throw new AppError(403, 'That price differs from the item\'s price. Changing a price needs the "Apply discounts" permission.')
    }
  }
}

/**
 * S651 — which of these cart lines are stays, and what does one of each buy?
 *
 * Read from pos_items.stay_unit, never inferred from the item's name. A park
 * that calls its item "Nightly RV" or "Cabin - wk" must work the same as one
 * that calls it "RV site — daily", and a name is not a contract.
 *
 * S652 (Nic): lineTotal comes from the SITE, never from the catalog and never
 * from the browser. "There's no variation allowed in terms of charging one
 * price in the booking flow and one price if they come in and get it on the
 * POS." The item says what one of quantity buys; the unit says what it costs.
 */
async function resolveStayLines(landlordId: string, items: any[], unitId?: string | null): Promise<any[]> {
  const ids = [...new Set((items || []).map((it: any) => it.id).filter(Boolean))]
  if (!ids.length) return []
  const rows = await query<{ id: string; name: string; stay_unit: string | null }>(
    `SELECT id, name, stay_unit FROM pos_items
      WHERE id = ANY($1::uuid[]) AND landlord_id = $2 AND stay_unit IS NOT NULL`,
    [ids, landlordId])
  if (!rows.length) return []
  const byId = new Map(rows.map((r) => [r.id, r]))
  const { priceStayFromUnit } = await import('../services/registerStay')
  const out: any[] = []
  for (const it of (items || [])) {
    if (!it.id || !byId.has(it.id)) continue
    const row = byId.get(it.id)!
    const qty = Number(it.qty) || 0
    const stayUnit = row.stay_unit as 'night' | 'week' | 'month'
    // No site yet means no price yet — the caller refuses the sale a few lines
    // later for the same reason, so this only has to not invent a number.
    if (!unitId) { out.push({ itemId: it.id, qty, stayUnit, name: row.name, lineTotal: 0, rate: null }); continue }
    const priced = await priceStayFromUnit(query, unitId, landlordId, stayUnit, qty)
    out.push({
      itemId: it.id, qty, stayUnit, name: row.name,
      rate: priced.rate, lineTotal: priced.lineTotal,
    })
  }
  return out
}

/**
 * S654 (Nic): "I need to be able to choose a customer from the drop-down menu to
 * link to that transaction and it should show their name on the pay screen."
 * The person a sale names must be THIS company's — a register customer of its,
 * or a resident on one of its leases — and their name is what the reader shows.
 * A name-less card record ("Card Customer") shows nothing.
 */
async function personOnSale(landlordId: string, ids: { tenantId?: unknown; posCustomerId?: unknown }): Promise<string | null> {
  const tenantId = typeof ids.tenantId === 'string' && ids.tenantId ? ids.tenantId : null
  const posCustomerId = typeof ids.posCustomerId === 'string' && ids.posCustomerId ? ids.posCustomerId : null
  if (tenantId && posCustomerId) throw new AppError(400, 'A sale belongs to one person — a resident or a customer, not both')
  const uuid = /^[0-9a-f-]{36}$/i
  if (posCustomerId) {
    const c = uuid.test(posCustomerId) ? await queryOne<{ first_name: string; last_name: string }>(
      `SELECT first_name, last_name FROM pos_customers WHERE id = $1 AND landlord_id = $2 AND archived_at IS NULL`,
      [posCustomerId, landlordId]) : null
    if (!c) throw new AppError(404, 'That customer is not on this register')
    if (c.first_name === 'Card' && c.last_name === 'Customer') return null
    return `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim() || null
  }
  if (tenantId) {
    const t = uuid.test(tenantId) ? await queryOne<{ name: string | null }>(
      `SELECT NULLIF(TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')), '') AS name
         FROM tenants tn JOIN users u ON u.id = tn.user_id
        WHERE tn.id = $1
          AND EXISTS (SELECT 1 FROM lease_tenants lt JOIN leases l ON l.id = lt.lease_id
                       WHERE lt.tenant_id = tn.id AND l.landlord_id = $2)`,
      [tenantId, landlordId]) : null
    if (!t) throw new AppError(404, "That resident is not at one of this company's properties")
    return t.name
  }
  return null
}

/** The breakdown a register sale shows on the reader: each line, then the card fee. */
function registerReaderLines(items: any[], surchargeDollars: number): { description: string; amountCents: number; quantity: number }[] {
  const lines = items.filter((it: any) => Number(it.qty) > 0).map((it: any) => ({
    description: `${String(it.name ?? 'Item')}${Number(it.qty) > 1 ? ` ×${Number(it.qty)}` : ''}`,
    amountCents: Math.round(Number(it.qty) * Number(it.price) * 100), quantity: 1,
  }))
  if (surchargeDollars > 0) lines.push({ description: 'Card processing fee', amountCents: Math.round(surchargeDollars * 100), quantity: 1 })
  return lines
}

async function serverCartTotals(landlordId: string, items: any[], paymentMethod: string | undefined,
                                discountAmount: number | undefined, clientSurcharge?: number,
                                propertyId?: string | null) {
  const lines = (items || [])
    .filter((it: any) => !!it.id)
    .map((it: any) => ({ itemId: it.id, qty: Number(it.qty) || 0, unitPrice: Number(it.price) || 0 }))
  const tax = await calculateCartTax(landlordId, lines)
  const base = aggregateCartTotals(tax, items, { surcharge: 0, discountAmount })
  let surcharge = 0
  // S648 (Nic): GAM's card fee is on every card sale; the property decides
  // whether the customer pays it on top or the landlord absorbs it.
  let cardFee = 0
  // S652: a card on file is a card. Same 3.5% + $0.55, same rule about who
  // pays it — the only difference is that nobody is holding the plastic.
  // (memory: gam-card-fee-every-card-payment)
  if (paymentMethod === 'card' || paymentMethod === 'card_on_file') {
    const prop = propertyId ? await queryOne<{ register_card_fee_payer: CardFeePayer }>(
      `SELECT register_card_fee_payer FROM properties WHERE id = $1 AND landlord_id = $2`,
      [propertyId, landlordId]) : null
    const split = cardFeeSplit(base.total, prop?.register_card_fee_payer ?? 'customer')
    cardFee = split.fee
    surcharge = round2(split.charged - base.total)
  } else if (paymentMethod === 'charge') {
    surcharge = Math.round((base.subtotal - base.discount) * 100) / 100 * 0.01
  } else if (paymentMethod == null) {
    surcharge = Number(clientSurcharge) || 0   // pre-S648 callers only
  }
  surcharge = Math.round(surcharge * 100) / 100
  return { ...base, surcharge, cardFee, total: Math.round((base.total + surcharge) * 100) / 100,
           taxBreakdown: taxBreakdownFor(tax, base.taxAmount) }
}

/**
 * S650: the sale's taxes by name, summing exactly to the tax charged. Built
 * from the server's per-line rates; a discount scales the taxable base, so the
 * named amounts are scaled to match and the rounding cent lands on the largest.
 */
function taxBreakdownFor(tax: { lines: { appliedRates: { name: string; rate: number; amount: number }[] }[] },
                         taxAmount: number): { name: string; rate: number; amount: number }[] {
  if (!(taxAmount > 0)) return []
  const byName = new Map<string, { name: string; rate: number; amount: number }>()
  for (const l of tax.lines ?? []) for (const r of l.appliedRates ?? []) {
    const key = `${r.name}|${r.rate}`
    const e = byName.get(key) ?? { name: r.name === 'Item tax rate' ? 'Tax' : r.name, rate: r.rate, amount: 0 }
    e.amount += r.amount
    byName.set(key, e)
  }
  const entries = [...byName.values()]
  const sum = entries.reduce((a, e) => a + e.amount, 0)
  if (!entries.length || sum <= 0) return [{ name: 'Tax', rate: 0, amount: taxAmount }]
  for (const e of entries) e.amount = round2(e.amount * taxAmount / sum)
  const drift = round2(taxAmount - entries.reduce((a, e) => a + e.amount, 0))
  if (drift !== 0) entries.sort((a, b) => b.amount - a.amount)[0].amount = round2(entries[0].amount + drift)
  return entries
}

// POST /api/pos/cart-quote — S554: authoritative cart total the client mints
// the terminal PaymentIntent against. Uses the SAME computeCartTotals as
// /transactions, so the minted PI amount always equals the recomputed
// transaction total (closes the card-sale amount-mismatch 400 class even when
// a pos_tax_rates row differs from an item's own tax_rate). Read-only.
posRouter.post('/cart-quote', requirePerm('pos.ring_sale'), async (req, res, next) => {
  try {
    const { items, surcharge, discountAmount, paymentMethod } = req.body
    if (!Array.isArray(items)) throw new AppError(400, 'items array required')
    for (const it of items) {
      assertNonNeg([it.qty, 'Quantity'], [it.price, 'Price'], [it.tax ?? it.tax_rate, 'Tax rate'])
    }
    assertNonNeg([surcharge, 'Surcharge'], [discountAmount, 'Discount'])
    const totals = await serverCartTotals(posLandlordId(req), items, paymentMethod, discountAmount, surcharge, req.body.propertyId ?? null)
    res.json({ success: true, data: totals })
  } catch (e) { next(e) }
})

// GET /api/pos/stays/available — which sites can actually take this stay.
//
// S651. The cashier picks from what is FREE, not from a list of every site with
// a cross through the taken ones after the fact. Same three-way test the
// storefront uses — another booking, a lease, or an out-of-order window — so
// the counter and the booking site can never disagree about a site.
// (memory: gam-out-of-order-sites)
posRouter.get('/stays/available', requirePerm('pos.ring_sale'), async (req: any, res, next) => {
  try {
    const propertyId = String(req.query.propertyId ?? '')
    const checkIn = String(req.query.checkIn ?? '')
    const stayUnit = String(req.query.stayUnit ?? 'night') as 'night' | 'week' | 'month'
    const qty = Number(req.query.qty ?? 1)
    if (!propertyId) throw new AppError(400, 'A property must be selected')
    if (!['night', 'week', 'month'].includes(stayUnit)) throw new AppError(400, 'Unknown stay length')
    await assertPropertyInScope(req.user, propertyId)

    const { checkOutFor, nightsBetween } = await import('../services/registerStay')
    const checkOut = checkOutFor(checkIn, stayUnit, qty)

    const { STAY_RATE_COLUMN } = await import('../services/registerStay')
    const rateCol = STAY_RATE_COLUMN[stayUnit]
    const units = await query<any>(
      `SELECT u.id, u.unit_number, u.unit_type, u.rv_site_layout, u.rv_amp_service,
              -- The site's own rate, else the property's: the same two places
              -- and the same order the booking site quotes from, so the counter
              -- and the booking site cannot price a site differently.
              COALESCE(u.${rateCol}, pr.${rateCol})::float AS rate
         FROM units u
         JOIN properties pr ON pr.id = u.property_id
        WHERE u.property_id = $1
          AND u.landlord_id = $2
          AND u.retired_at IS NULL
          AND u.status = 'vacant'
          AND NOT EXISTS (
            SELECT 1 FROM unit_bookings b
             WHERE b.unit_id = u.id AND b.status <> 'cancelled'
               AND NOT (b.status = 'tentative' AND b.hold_expires_at IS NOT NULL AND b.hold_expires_at < now())
               AND b.check_in < $4::date AND b.check_out > $3::date)
          AND NOT EXISTS (
            SELECT 1 FROM leases l
             WHERE l.unit_id = u.id AND l.status IN ('active','pending')
               AND l.start_date < $4::date AND (l.end_date IS NULL OR l.end_date > $3::date))
          AND NOT unit_out_of_order_overlaps(u.id, $3::date, $4::date)
        ORDER BY u.unit_number`,
      [propertyId, posLandlordId(req), checkIn, checkOut])

    // S652 (Nic): the price is the site's, so it travels with the site. A site
    // with no rate for this length is still LISTED — dropping it would read as
    // "occupied", which is a lie about a site that is standing empty — but it
    // cannot be picked until somebody sets the rate.
    res.json({ success: true, data: {
      checkIn, checkOut, nights: nightsBetween(checkIn, checkOut),
      stayUnit,
      units: units.map((u: any) => ({
        ...u,
        rate: u.rate ?? null,
        lineTotal: u.rate != null ? Math.round(u.rate * qty * 100) / 100 : null,
      })),
    } })
  } catch (e) { next(e) }
})

// ── S652: open tickets — written up at the pump, settled at the door ────────
//
// Nic: "we would need to somehow create the tickets in the office because
// that's where the dispenser is pumping propane and you have to reset the
// propane counter before you can pump the next person. So we need a list of who
// the tank belongs to and how many gallons went into it."
//
// A ticket is a cart and a customer. It carries no total on purpose — see the
// migration: freezing a price at write-up time would be a second pricing
// authority, and a whole session went into deleting one of those.

const ticketSchema = z.object({
  propertyId:    z.string().uuid(),
  tenantId:      z.string().uuid().nullish(),
  posCustomerId: z.string().uuid().nullish(),
  items: z.array(z.object({
    id:    z.string().uuid(),
    name:  z.string().max(160).optional(),
    qty:   z.number().positive(),
    price: z.number().min(0).optional(),
    tax:   z.number().min(0).optional(),
  })).min(1),
  note: z.string().max(500).nullish(),
})

posRouter.post('/tickets', requirePerm('pos.ring_sale'), async (req: any, res, next) => {
  try {
    const body = ticketSchema.parse(req.body)
    if (!!body.tenantId === !!body.posCustomerId) {
      throw new AppError(400, 'A ticket is for one person — pick a tenant or a customer, not both.')
    }
    await assertPropertyInScope(req.user, body.propertyId)
    const landlordId = posLandlordId(req)
    await assertPropertyIsLandlords(landlordId, body.propertyId)
    // Every line has to be a real item of this landlord's — the same rule the
    // register enforces on a sale ("Items are set prices. There's no custom
    // item thing"), applied at write-up so a bad ticket is refused in the
    // office rather than at somebody's door.
    const ids = [...new Set(body.items.map((i) => i.id))]
    const known = await query<{ id: string }>(
      `SELECT id FROM pos_items WHERE id = ANY($1::uuid[]) AND landlord_id = $2 AND is_active = TRUE`,
      [ids, landlordId])
    if (known.length !== ids.length) throw new AppError(400, 'One of those items is not on your register.')
    // A stay is a booking with dates and a site; it cannot sit on a ticket.
    const stays = await query<{ name: string }>(
      `SELECT name FROM pos_items WHERE id = ANY($1::uuid[]) AND stay_unit IS NOT NULL`, [ids])
    if (stays.length) throw new AppError(400, `"${stays[0].name}" is a stay — ring it at the register with a site and dates.`)

    // S654: the person on a ticket is this company's — a resident on one of its
    // leases or one of its register customers.
    await personOnSale(landlordId, { tenantId: body.tenantId, posCustomerId: body.posCustomerId })

    const row = await queryOne<any>(
      `INSERT INTO pos_open_tickets
         (landlord_id, property_id, created_by, tenant_id, pos_customer_id, items, note)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7) RETURNING *`,
      [landlordId, body.propertyId, req.user.userId, body.tenantId ?? null,
       body.posCustomerId ?? null, JSON.stringify(body.items), body.note ?? null])
    res.status(201).json({ success: true, data: row })
  } catch (e) { next(e) }
})

// GET /api/pos/tickets?propertyId= — what is still out. The driver's list.
posRouter.get('/tickets', requirePerm('pos.ring_sale'), async (req: any, res, next) => {
  try {
    const propertyId = String(req.query.propertyId ?? '')
    if (!propertyId) throw new AppError(400, 'A property must be selected')
    await assertPropertyInScope(req.user, propertyId)
    const rows = await query<any>(
      `SELECT t.*,
              COALESCE(
                (SELECT u.first_name || ' ' || u.last_name
                   FROM tenants tn JOIN users u ON u.id = tn.user_id WHERE tn.id = t.tenant_id),
                (SELECT c.first_name || ' ' || c.last_name
                   FROM pos_customers c WHERE c.id = t.pos_customer_id)
              ) AS customer_name
         FROM pos_open_tickets t
        WHERE t.property_id = $1 AND t.landlord_id = $2 AND t.status = 'open'
        ORDER BY t.created_at`,
      [propertyId, posLandlordId(req)])
    // S652 (Nic): "put the pay links as an open ticket as well. That way they
    // can be resolved in person when somebody comes in." An emailed link that
    // has not been paid is money still out, exactly like a ticket — so it is on
    // this list, and settling it here pays the link.
    const links = await query<any>(
      `SELECT l.id, l.property_id, l.landlord_id, l.items, l.total, l.discount_amount, l.label,
              l.tenant_id, l.pos_customer_id, l.booking_id, l.customer_name, l.created_at,
              'Emailed pay link — sent ' || to_char(l.created_at, 'Mon DD') AS note
         FROM pos_pay_links l
        WHERE l.property_id = $1 AND l.landlord_id = $2
          AND l.kind = 'one_time' AND l.status = 'open'
          AND (l.expires_at IS NULL OR l.expires_at > NOW())
        ORDER BY l.created_at`,
      [propertyId, posLandlordId(req)])
    res.json({ success: true, data: [
      ...rows.map((t: any) => ({ ...t, kind: 'ticket' })),
      ...links.map((l: any) => ({ ...l, kind: 'pay_link', pay_link_id: l.id, status: 'open' })),
    ] })
  } catch (e) { next(e) }
})

// POST /api/pos/tickets/:id/void — the tank came back, or it was written wrong.
// Kept, not deleted: GAM does not erase records, and an abandoned ticket is
// part of the story of a day's deliveries.
posRouter.post('/tickets/:id/void', requirePerm('pos.ring_sale'), async (req: any, res, next) => {
  try {
    const reason = String(req.body?.reason ?? '').slice(0, 500) || null
    const t = await queryOne<any>(
      `SELECT id, property_id, status FROM pos_open_tickets WHERE id = $1 AND landlord_id = $2`,
      [req.params.id, posLandlordId(req)])
    if (!t) throw new AppError(404, 'No such ticket')
    await assertPropertyInScope(req.user, t.property_id)
    if (t.status !== 'open') throw new AppError(409, `That ticket is already ${t.status}.`)
    await query(
      `UPDATE pos_open_tickets SET status='voided', voided_at=NOW(), void_reason=$2, updated_at=NOW()
        WHERE id=$1`, [t.id, reason])
    res.json({ success: true, data: { voided: true } })
  } catch (e) { next(e) }
})

// GET /api/pos/card-on-file — which card the "On file" button will charge.
//
// S652. The cashier is about to take money without anybody handing over a card,
// so the screen has to say whose card and which one. "No card on file" is a
// useful answer too: it tells the counter to run it on the reader, which saves
// the card in the same motion and makes the next sale one of these.
posRouter.get('/card-on-file', requirePerm('pos.ring_sale'), async (req: any, res, next) => {
  try {
    const tenantId = req.query.tenantId ? String(req.query.tenantId) : null
    const posCustomerId = req.query.posCustomerId ? String(req.query.posCustomerId) : null
    if (!tenantId && !posCustomerId) return res.json({ success: true, data: null })
    const { savedCardFor } = await import('../services/posCardOnFile')
    const card = await savedCardFor({ tenantId, posCustomerId, landlordId: posLandlordId(req) })
    res.json({ success: true, data: card
      ? { brand: card.brand, last4: card.last4, holderName: card.holderName }
      : null })
  } catch (e) { next(e) }
})

posRouter.post('/transactions', requirePerm('pos.ring_sale'), async (req, res, next) => {
  try {
    let { items, discountAmount } = req.body
    const { paymentMethod, tenantId, posCustomerId, propertyId, surcharge, changeGiven, stripePaymentIntentId, discountReason, openTicketId,
            // S652 (Nic): an emailed pay link settled in person, from the
            // "out for delivery" list. The link is the bill: its lines, its
            // prices and its discount are charged, whatever the cart sent.
            payLinkId,
            // S651: present only when the cart contains a stay — the site, the
            // arrival date and who it is for. Everything else about the stay is
            // derived from the item and its quantity.
            stay } = req.body
    let payLink: any = null
    if (payLinkId) {
      payLink = await queryOne<any>(
        `SELECT * FROM pos_pay_links WHERE id = $1 AND landlord_id = $2`, [payLinkId, posLandlordId(req)])
      if (!payLink) throw new AppError(404, 'No such pay link')
      if (payLink.status !== 'open') throw new AppError(409, 'That pay link has already been paid or closed.')
      // S652 (Nic): "if we need to do last minute prorations or adjustments,
      // the functionality of the front counter person needs to be there." The
      // cart the cashier settles is what is charged — the link's lines loaded
      // into it, plus whatever they added or changed standing there. An empty
      // cart falls back to the link as sent.
      if (!Array.isArray(items) || items.length === 0) {
        items = payLink.items
        discountAmount = Number(payLink.discount_amount) || 0
      }
    }
    if (!Array.isArray(items) || items.length === 0) {
      throw new AppError(400, 'items array required')
    }
    // Reject negative line values before they corrupt the sale total. Catalog
    // items get price/tax recomputed server-side below, but qty and walk-up
    // price/tax are client-declared — a negative would shrink or invert the total.
    for (const it of items) {
      assertNonNeg([it.qty, 'Quantity'], [it.price, 'Price'], [it.tax ?? it.tax_rate, 'Tax rate'])
    }
    assertNonNeg([surcharge, 'Surcharge'])
    assertCatalogItems(items.map((it: any) => ({ itemId: it.id })))
    await assertCashierPricing(req, items.map((it: any) => ({ itemId: it.id, price: it.price })), discountAmount)
    // W-12 (S531): propertyId is REQUIRED — every sale belongs to a
    // property (per-property books, EOD drawers, sales history).
    if (!propertyId) throw new AppError(400, 'A property must be selected — sales are per-property')
    // Property lock: a scoped worker (cashier) can only ring on a property in
    // their scope. Owners + all_properties bypass. Requires the client to send
    // propertyId on every sale (not just FlexCharge) — see POSPage checkout.
    await assertPropertyInScope(req.user, propertyId)
    // S654: whoever the sale names — picked at the register for any tender —
    // has to be this company's resident or customer.
    if (paymentMethod !== 'charge') await personOnSale(posLandlordId(req), { tenantId, posCustomerId })

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
        [linkedIds, posLandlordId(req)],
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
      if (account.landlord_id !== posLandlordId(req)) {
        throw new AppError(403, 'FlexCharge account belongs to a different landlord')
      }
      flexChargeAccountId = account.id
    }

    // ── S651: is this sale a stay? ──────────────────────────────────────
    //
    // Read from the ITEM, never from its name: pos_items.stay_unit says what
    // one of these buys. An item with it set cannot be sold without a site and
    // a date, because the whole point is that the schedule hears about it.
    // S652: when the ticket carries a reservation, the site and the dates were
    // settled on the schedule and the cashier supplies neither.
    let ticketBookingId: string | null = null
    if (openTicketId) {
      const t = await queryOne<{ booking_id: string | null; unit_id: string | null }>(
        `SELECT t.booking_id, b.unit_id
           FROM pos_open_tickets t
           LEFT JOIN unit_bookings b ON b.id = t.booking_id
          WHERE t.id = $1 AND t.landlord_id = $2`,
        [openTicketId, posLandlordId(req)])
      ticketBookingId = t?.booking_id ?? null
    }

    // A pay link's stay was arranged when the link was made; its line is a
    // plain amount here, not a booking to place. (The cashier's cart for a
    // link is charged as sent, stay lines included, at the prices on it.)
    const stayLines = payLink ? [] : await resolveStayLines(posLandlordId(req), items,
      stay?.unitId ?? (ticketBookingId
        ? (await queryOne<{ unit_id: string }>(
            `SELECT unit_id FROM unit_bookings WHERE id = $1`, [ticketBookingId]))?.unit_id ?? null
        : null))
    if (stayLines.length && !stay && !ticketBookingId) {
      throw new AppError(400,
        'A stay needs a site and an arrival date before it can be rung up.')
    }
    if (!stayLines.length && stay) {
      throw new AppError(400, 'Nothing in this sale is a stay.')
    }
    if (ticketBookingId && !stayLines.length) {
      throw new AppError(400, 'That ticket is for a reservation, but nothing on it is a stay.')
    }

    // S652 (Nic): the site's rate IS the price, so the cart the server totals
    // is not quite the cart the browser sent — a stay line is repriced from the
    // unit before anything is added up. Done here, above serverCartTotals, so
    // tax, the card fee and the amount checked against the card reader's
    // authorization all come out of the same number the booking records.
    const pricedItems = (items || []).map((it: any) => {
      const line = stayLines.find((sl: any) => sl.itemId === it.id)
      if (!line || line.rate == null) return it
      return { ...it, price: line.rate }
    })

    // S554: ONE shared cart-total calc — calculateCartTax (S241 server tax,
    // falling back to item.tax_rate) + the pure aggregateCartTotals that the
    // POST /pos/cart-quote endpoint ALSO runs, so the terminal PI the client
    // minted (against the quote) always equals this recomputed total.
    // S648: the fee is the server's (serverCartTotals), whatever the client sent.
    const { subtotal, taxAmount, surcharge: surchargeAmt, discount: discountAmt, total, cardFee, taxBreakdown } =
      await serverCartTotals(posLandlordId(req), pricedItems, paymentMethod ?? 'cash', discountAmount, undefined, propertyId)

    // FlexCharge platform fee is 1% of what the customer is actually charged
    // (net of discount). A card sale's card fee is GAM's whoever paid it.
    const platformFee = (paymentMethod === 'card' || paymentMethod === 'card_on_file') ? cardFee
      : paymentMethod === 'charge' ? surchargeAmt : 0

    // S242: terminal-captured card sales pass a stripePaymentIntentId
    // (capture path from /terminal/payment-intents/:id/capture). Verify
    // it on the landlord's Connect account before persisting — confirms
    // status='succeeded', metadata.gam_purpose='pos_terminal', and that
    // the PI amount matches the server-computed total. Pre-S242 the
    // route accepted any PI id without validation; a malicious or
    // misbehaving cashier could pass an arbitrary id and stamp the
    // transaction as paid.
    // S648 (Nic): every card dollar goes through GAM — a card sale is only
    // ever one the reader charged on GAM's account.
    let captureOnCommit: string | null = null
    // S654 (Nic): a card at the register builds the customer base. The sale's
    // customer is whoever the cashier picked; failing that, the card's own.
    const saleReaderId: string | null = typeof req.body?.stripeReaderId === 'string' ? req.body.stripeReaderId : null
    let saleCustomerId: string | null = posCustomerId || null
    let cardIdentity: CardIdentity | null = null
    let cardCustomer: CardCustomer | null = null
    if (paymentMethod === 'card' && !stripePaymentIntentId) {
      throw new AppError(400, 'Card sales go through the card reader')
    }
    // S654: a card the reader took is a card sale — never recorded as cash or a
    // charge account, which would leave the card authorized and uncaptured.
    if (stripePaymentIntentId && paymentMethod !== 'card') {
      throw new AppError(400, 'A card from the reader can only be recorded as a card sale.')
    }

    // S652 — CHARGE THE CARD THEY ALREADY GAVE US.
    //
    // Nic: "maybe if they save a payment method on file as a point of sale
    // customer, we can just auto charge them on delivery and we don't even have
    // to take the reader with us." The card is already there — GAM has never
    // spent a separate authorization to store one, because rent's own charge
    // carries setup_future_usage (S603) — so this spends nothing new either.
    //
    // Charged BEFORE the sale is written, and the sale only happens if the
    // money did: the opposite order would record a sale for a decline.
    let cardOnFileIntentId: string | null = null
    let cardOnFileLabel: string | null = null
    if (paymentMethod === 'card_on_file') {
      const { savedCardFor, chargeSavedCard } = await import('../services/posCardOnFile')
      const card = await savedCardFor({
        tenantId: tenantId ?? null, posCustomerId: posCustomerId ?? null,
        landlordId: posLandlordId(req),
      })
      if (!card) {
        throw new AppError(409,
          'They have no card on file. Run it on the reader — that saves the card at the same time.')
      }
      const charged = await chargeSavedCard({
        card,
        amountCents: Math.round(total * 100),
        landlordId: posLandlordId(req),
        propertyId: propertyId || null,
        description: `${card.holderName ?? 'Register sale'} - Gold Asset Management`,
      })
      cardOnFileIntentId = charged.paymentIntentId
      cardOnFileLabel = [card.brand, card.last4].filter(Boolean).join(' ••••') || null
    }
    if (paymentMethod === 'card' && stripePaymentIntentId) {
      const intent = await retrieveTerminalPaymentIntentWithCharge({ paymentIntentId: stripePaymentIntentId })
      cardIdentity = cardIdentityFromIntent(intent)
      if (intent.metadata?.gam_purpose !== 'pos_terminal') {
        throw new AppError(400, 'PaymentIntent is not a POS terminal sale')
      }
      if (intent.metadata?.gam_landlord_id !== posLandlordId(req)) {
        throw new AppError(403, 'PaymentIntent belongs to a different landlord')
      }
      // S648: the register sends the charge here still authorized-only; the
      // sale and the capture commit together (below), so money is never taken
      // without a sale on record to pay the landlord for.
      if (intent.status !== 'succeeded' && intent.status !== 'requires_capture') {
        throw new AppError(400, `The card charge is ${intent.status} — it was not approved`)
      }
      captureOnCommit = intent.status === 'requires_capture' ? intent.id : null
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
      // S654 (Nic): the CARD is the customer — same card next time, same
      // person and their history; the printed name is the record's name.
      if (cardIdentity && !tenantId && !saleCustomerId) {
        cardCustomer = await findOrCreateCustomerForCard(client, { landlordId: posLandlordId(req), card: cardIdentity })
        saleCustomerId = cardCustomer.customerId
      }

      // S652: a ticket is CLAIMED inside the sale's own transaction, and only
      // if it is still open. Two drivers opening the same ticket on two phones
      // is the ordinary case, not the exotic one, and the second one has to
      // lose rather than charge somebody twice for the same tank.
      if (openTicketId) {
        const claimed = await client.query(
          `UPDATE pos_open_tickets SET status='settled', settled_at=NOW(), updated_at=NOW()
            WHERE id=$1 AND landlord_id=$2 AND status='open' RETURNING id`,
          [openTicketId, posLandlordId(req)])
        if (!claimed.rows.length) {
          throw new AppError(409, 'That ticket has already been settled or voided.')
        }
      }

      let tx: any
      try {
        // S648: the writes live in services/posSale so a paid pay link records
        // a sale exactly the way the counter does.
        const sale = await insertPosSale(client, {
          landlordId: posLandlordId(req), propertyId: propertyId || null, cashierId: req.user!.userId,
          paymentMethod, tenantId, posCustomerId: saleCustomerId, subtotal, taxAmount, surcharge: surchargeAmt, total,
          changeGiven, platformFee, stripePaymentIntentId: stripePaymentIntentId ?? cardOnFileIntentId,
          discountAmount: discountAmt, discountReason,
          ...(paymentMethod === 'card' || paymentMethod === 'card_on_file'
            ? { payoutOwed: round2(total - cardFee) } : {}),
          items: pricedItems, taxBreakdown,
        })
        tx = sale.tx
        inventoryNeedsPO.push(...sale.needsPO)
        // S652: point both ways. A till count can then tell a delivered ticket
        // from a walk-up without guessing.
        if (openTicketId) {
          await client.query(
            `UPDATE pos_transactions SET open_ticket_id = $2 WHERE id = $1`, [tx.id, openTicketId])
          await client.query(
            `UPDATE pos_open_tickets SET settled_transaction_id = $2 WHERE id = $1`, [openTicketId, tx.id])
        }
        // S652: the link is paid — in person, at the register. Claimed inside
        // the same transaction so a card paid online a second later is refused
        // by the link's status, not charged twice.
        if (payLink) {
          const claimed = await client.query(
            `UPDATE pos_pay_links SET status = 'paid', paid_at = NOW(), pos_transaction_id = $2, updated_at = NOW()
              WHERE id = $1 AND status = 'open' RETURNING id`, [payLink.id, tx.id])
          if (!claimed.rows.length) throw new AppError(409, 'That pay link was paid a moment ago.')
          await client.query(`UPDATE pos_transactions SET pay_link_id = $2 WHERE id = $1`, [tx.id, payLink.id])
        }
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

      // S651: the booking goes in on the SAME transaction as the sale. A site
      // that turns out to be taken rolls the money back rather than leaving a
      // paid stay nobody can actually have.
      let stayBooking: { bookingId: string; checkIn: string; checkOut: string; nights: number } | null = null
      // S652 — A TICKET THAT CARRIES A RESERVATION CONFIRMS IT; IT DOES NOT
      // BOOK A SECOND ONE.
      //
      // Nic's walk-in: a spot found on the schedule, paid for at the counter.
      // The site left the calendar when it was chosen, so by the time the
      // cashier rings it there is already a booking — held and unpaid. Writing
      // a new one here would sell the same site twice in the same breath: the
      // guest's own hold would collide with the sale that is paying for it.
      if (ticketBookingId) {
        const confirmed = await client.query(
          `UPDATE unit_bookings
              SET status = 'confirmed', deposit_paid_at = COALESCE(deposit_paid_at, NOW()),
                  hold_expires_at = NULL, pos_transaction_id = $2, updated_at = NOW()
            WHERE id = $1 AND status = 'tentative'
            RETURNING id, check_in::text AS check_in, check_out::text AS check_out, nights`,
          [ticketBookingId, tx.id])
        if (!confirmed.rows.length) {
          throw new AppError(409,
            'That reservation is no longer waiting to be paid — it may have been cancelled or already settled.')
        }
        stayBooking = {
          bookingId: confirmed.rows[0].id,
          checkIn: confirmed.rows[0].check_in,
          checkOut: confirmed.rows[0].check_out,
          nights: confirmed.rows[0].nights,
        }
      } else if (stayLines.length) {
        const { createStayBooking } = await import('../services/registerStay')
        stayBooking = await createStayBooking(client, {
          landlordId: posLandlordId(req),
          propertyId,
          posTransactionId: tx.id,
          lines: stayLines,
          details: stay,
        })
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

      // Take the money last: a capture failure rolls the sale back and the
      // authorization simply lapses. (A crash in the instant between capture
      // and COMMIT is the one window left: the charge shows in Stripe with no
      // sale, and would be found by reconciling Stripe against the register.)
      if (captureOnCommit) {
        await captureTerminalPaymentIntent({ paymentIntentId: captureOnCommit })
      }

      await client.query('COMMIT')
      txnOpen = false

      // Post-commit best-effort: fire any auto-PO drafts that were
      // queued during the line-item loop. autoDraftPO already has its
      // own try/catch swallow; outer try here is defense in depth so
      // a future PO failure never leaks through and breaks the
      // 201 response.
      for (const item of inventoryNeedsPO) {
        try { await autoDraftPO(posLandlordId(req), item) }
        catch (e) { logger.error({ err: e, itemId: item.id }, '[POS] Post-commit auto-PO error:') }
      }

      // S651: hand the booking back so the register can print it on the
      // receipt and show the cashier which site and dates they just sold.
      // S654 (Nic): after the payment the reader asks the customer — on its own
      // screen, by their own finger — whether to keep the card for next time.
      // One tap, one authorization: the reusable card came with the payment;
      // keeping it is an attach, not a second charge.
      let customerOut: any = null
      if (saleCustomerId) {
        const c = await queryOne<any>(`SELECT id, first_name, last_name, email FROM pos_customers WHERE id = $1`, [saleCustomerId])
        const prior = await queryOne<{ n: string }>(
          `SELECT COUNT(*)::text AS n FROM pos_transactions WHERE pos_customer_id = $1 AND id <> $2`, [saleCustomerId, tx.id])
        // Only what is missing is asked on the reader: keep the card (when the
        // tap yielded a reusable one), a name (phone wallets carry none), an
        // email for the receipt.
        const asks = {
          askSave:  !!(cardCustomer && cardIdentity?.generatedCard && !cardCustomer.cardSaved),
          askName:  !!(cardCustomer && c && c.first_name === 'Card' && c.last_name === 'Customer'),
          askEmail: !!(cardCustomer && c && !c.email),
        }
        let prompting = false
        if (saleReaderId && (asks.askSave || asks.askName || asks.askEmail)
            && await assertReaderBelongsToLandlord(posLandlordId(req), saleReaderId)) {
          prompting = await startSaveCardPrompt(saleReaderId, asks)
        }
        customerOut = c ? {
          id: c.id, firstName: c.first_name, lastName: c.last_name, email: c.email,
          last4: cardIdentity?.last4 ?? null, brand: cardIdentity?.brand ?? null,
          isNew: cardCustomer?.isNew ?? false, priorPurchases: Number(prior?.n ?? 0),
          cardSaved: cardCustomer?.cardSaved ?? false, cardKeepable: !!cardIdentity?.generatedCard,
          prompting, asks: prompting ? asks : null, readerId: prompting ? saleReaderId : null,
        } : null
      }
      res.status(201).json({ success: true, data: { ...tx, stayBooking, customer: customerOut } })
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
    // W-12 (S531): optional ?propertyId= — sales history is viewed per
    // property; the filter applies to every query below.
    const salesProp = req.query.propertyId ? String(req.query.propertyId) : null
    const propFilter = salesProp ? `AND t.property_id = $2` : ''
    const salesParams: any[] = salesProp ? [posLandlordId(req), salesProp] : [posLandlordId(req)]

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
      WHERE landlord_id=$1 AND DATE(t.created_at) = CURRENT_DATE ${propFilter}
      GROUP BY hour ORDER BY hour`, salesParams)

    // By day
    const byDay = await query<any>(`
      SELECT DATE(t.created_at) as date,
        COUNT(*) as tx_count,
        SUM(total) as revenue,
        SUM(CASE WHEN payment_method='cash' THEN total ELSE 0 END) as cash,
        SUM(CASE WHEN payment_method='card' THEN total ELSE 0 END) as card,
        SUM(CASE WHEN payment_method='charge' THEN total ELSE 0 END) as charge
      FROM pos_transactions t
      WHERE landlord_id=$1 ${dateFilter} ${propFilter}
      GROUP BY date ORDER BY date DESC`, salesParams)

    // Top items
    const topItems = await query<any>(`
      SELECT ti.item_name, ti.item_category,
        SUM(ti.qty) as total_qty,
        SUM(ti.subtotal) as total_revenue,
        SUM(ti.qty * ti.cost_price) as total_cost,
        SUM(ti.subtotal) - SUM(ti.qty * ti.cost_price) as gross_profit
      FROM pos_transaction_items ti
      JOIN pos_transactions t ON t.id = ti.transaction_id
      WHERE t.landlord_id=$1 ${dateFilter} ${propFilter}
      GROUP BY ti.item_name, ti.item_category
      ORDER BY total_revenue DESC LIMIT 10`, salesParams)

    // Category breakdown
    const byCategory = await query<any>(`
      SELECT ti.item_category as category,
        SUM(ti.subtotal) as revenue,
        SUM(ti.qty) as units_sold
      FROM pos_transaction_items ti
      JOIN pos_transactions t ON t.id = ti.transaction_id
      WHERE t.landlord_id=$1 ${dateFilter} ${propFilter}
      GROUP BY category ORDER BY revenue DESC`, salesParams)

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
      WHERE landlord_id=$1 ${dateFilter} ${propFilter}`, salesParams)

    res.json({ success: true, data: { summary, byHour, byDay, topItems, byCategory } })
  } catch (e) { next(e) }
})

// ── VENDORS ───────────────────────────────────────────────────

posRouter.get('/vendors', requirePerm('pos.manage_inventory'), async (req, res, next) => {
  try {
    const vendors = await query<any>('SELECT * FROM pos_vendors WHERE landlord_id=$1 ORDER BY name', [posLandlordId(req)])
    res.json({ success: true, data: vendors })
  } catch (e) { next(e) }
})

posRouter.post('/vendors', requirePerm('pos.manage_inventory'), async (req, res, next) => {
  try {
    const { name, contactName, email, phone, address, leadTimeDays, notes } = req.body
    assertNonNeg([leadTimeDays, 'Lead time'])
    const vendor = await queryOne<any>(`INSERT INTO pos_vendors
      (landlord_id,name,contact_name,email,phone,address,lead_time_days,notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [posLandlordId(req), name, contactName||null, email||null, phone||null,
       address||null, leadTimeDays||3, notes||null])
    res.status(201).json({ success: true, data: vendor })
  } catch (e) { next(e) }
})

posRouter.patch('/vendors/:id', requirePerm('pos.manage_inventory'), async (req, res, next) => {
  try {
    const { name, contactName, email, phone, address, leadTimeDays, notes, isActive } = req.body
    assertNonNeg([leadTimeDays, 'Lead time'])
    const vendor = await queryOne<any>('SELECT * FROM pos_vendors WHERE id=$1 AND landlord_id=$2', [req.params.id, posLandlordId(req)])
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
    // W-12 (S531): ?propertyId= filters to that receiving property; legacy
    // NULL rows stay visible everywhere (created before property stamping).
    const poProp = req.query.propertyId ? String(req.query.propertyId) : null
    const poParams: any[] = [posLandlordId(req)]
    const poFilter = poProp ? `AND (po.property_id = $${poParams.push(poProp)} OR po.property_id IS NULL)` : ''
    const pos = await query<any>(`
      SELECT po.*, v.name as vendor_name, v.email as vendor_email,
        (SELECT COUNT(*) FROM pos_purchase_order_items WHERE po_id=po.id) as item_count
      FROM pos_purchase_orders po
      JOIN pos_vendors v ON v.id = po.vendor_id
      WHERE po.landlord_id=$1 ${poFilter} ORDER BY po.created_at DESC`, poParams)

    for (const po of pos) {
      po.items = await query<any>('SELECT * FROM pos_purchase_order_items WHERE po_id=$1', [po.id])
    }

    res.json({ success: true, data: pos })
  } catch (e) { next(e) }
})

posRouter.patch('/purchase-orders/:id', requirePerm('pos.manage_inventory'), async (req, res, next) => {
  try {
    const { status, notes, expectedDate } = req.body
    const po = await queryOne<any>('SELECT * FROM pos_purchase_orders WHERE id=$1 AND landlord_id=$2', [req.params.id, posLandlordId(req)])
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
        // S590: scope the restock lookup to the PO's landlord — defense in depth
        // so a line that somehow references another landlord's item can never
        // restock it (the insert paths also validate ownership up-front now).
        const dbItem = await queryOne<any>('SELECT * FROM pos_items WHERE id=$1 AND landlord_id=$2', [item.item_id, po.landlord_id])
        if (!dbItem) continue
        const qty = Number(item.qty_ordered)
        const newQty = Number(dbItem.stock_qty) + qty
        await query('UPDATE pos_items SET stock_qty=$1, updated_at=NOW() WHERE id=$2', [newQty, item.item_id])
        await query(`INSERT INTO pos_inventory_log (item_id,landlord_id,change_qty,reason,reference_id,stock_before,stock_after)
          VALUES ($1,$2,$3,'po_received',$4,$5,$6)`,
          [item.item_id, posLandlordId(req), qty, po.id, dbItem.stock_qty, newQty])
      }
    }

    res.json({ success: true, data: updated })
  } catch (e) { next(e) }
})

// GET /api/pos/low-stock — items at or below min
posRouter.get('/low-stock', requirePerm('pos.manage_inventory'), async (req, res, next) => {
  try {
    // W-12 (S531): ?propertyId= scopes low-stock to that property's items.
    const lsProp = req.query.propertyId ? String(req.query.propertyId) : null
    const lsParams: any[] = [posLandlordId(req)]
    const lsFilter = lsProp ? `AND i.property_id = $${lsParams.push(lsProp)}` : ''
    const items = await query<any>(`
      SELECT i.*, v.name as vendor_name
      FROM pos_items i
      LEFT JOIN pos_vendors v ON v.id = i.vendor_id
      WHERE i.landlord_id=$1 AND i.is_active=TRUE ${lsFilter}
        AND i.stock_qty <= i.stock_min AND i.stock_max < 999
      ORDER BY (i.stock_qty::float / NULLIF(i.stock_min,0)) ASC`, lsParams)
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
    const params: any[] = [posLandlordId(req)]
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
        await query('INSERT INTO pos_categories (landlord_id,name,icon,sort_order) VALUES ($1,$2,$3,$4)', [posLandlordId(req), cat.name, cat.icon, cat.sort_order])
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
    const propIds = await validateCategoryPropertyIds(propertyIds, posLandlordId(req))
    try {
      const cat = await queryOne('INSERT INTO pos_categories (landlord_id,name,icon,sort_order,property_ids) VALUES ($1,$2,$3,$4,$5::uuid[]) RETURNING *', [posLandlordId(req), name.trim(), icon||'📦', sortOrder||0, propIds])
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
    const cat = await queryOne<any>('SELECT * FROM pos_categories WHERE id=$1 AND landlord_id=$2', [req.params.id, posLandlordId(req)])
    if (!cat) { res.status(404).json({ success: false, error: 'Not found' }); return }

    // property_ids: undefined preserves the existing scope; otherwise
    // null/empty → all properties, a non-empty array → that specific subset.
    let newPropIds: string[] | null = cat.property_ids
    if (propertyIds !== undefined) {
      newPropIds = await validateCategoryPropertyIds(propertyIds, posLandlordId(req))
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
    await query('UPDATE pos_categories SET is_active=FALSE WHERE id=$1 AND landlord_id=$2', [req.params.id, posLandlordId(req)])
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
      [req.params.id, posLandlordId(req)])
    if (!item) {
      res.status(404).json({ success: false, error: 'Not found' })
      return
    }
    const variants = await query<any>('SELECT * FROM pos_item_variants WHERE item_id=$1 AND is_active=TRUE ORDER BY sort_order, sell_price', [req.params.id])
    res.json({ success: true, data: variants.map((v: any) => ({ ...v, stock_qty: v.stock_qty == null ? v.stock_qty : Number(v.stock_qty) })) })
  } catch (e) { next(e) }
})

posRouter.post('/items/:id/variants', requirePerm('pos.manage_inventory'), async (req, res, next) => {
  try {
    const { name, costPrice, sellPrice, stockQty, stockMin, sortOrder } = req.body
    const item = await queryOne('SELECT * FROM pos_items WHERE id=$1 AND landlord_id=$2', [req.params.id, posLandlordId(req)])
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
      [req.params.id, posLandlordId(req)])
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
        [posLandlordId(req), propertyFilter],
      )
    } else {
      rates = await query<any>(
        'SELECT * FROM pos_tax_rates WHERE landlord_id=$1 ORDER BY tax_type, name',
        [posLandlordId(req)],
      )
    }
    res.json({ success: true, data: rates })
  } catch (e) { next(e) }
})

/**
 * S650: a tax's category and item targets must be this landlord's own rows.
 * undefined → leave as is; an array → validated and returned de-duplicated.
 */
async function ownedTaxTargets(req: any, table: 'pos_categories' | 'pos_items',
                               ids: unknown): Promise<string[] | undefined> {
  if (ids === undefined) return undefined
  if (!Array.isArray(ids)) throw new AppError(400, `${table === 'pos_items' ? 'itemIds' : 'categoryIds'} must be a list`)
  const uniq = [...new Set(ids.filter((x) => typeof x === 'string' && x))] as string[]
  if (!uniq.length) return []
  const owned = await query<{ id: string }>(
    `SELECT id FROM ${table} WHERE id = ANY($1::uuid[]) AND landlord_id = $2`, [uniq, posLandlordId(req)])
  if (owned.length !== uniq.length) throw new AppError(400, 'A chosen item or category does not belong to this account')
  return uniq
}

posRouter.post('/tax-rates', requirePerm('pos.manage_inventory'), async (req, res, next) => {
  try {
    const { name, rate, taxType, appliesTo, propertyId } = req.body
    assertNonNeg([rate, 'Rate'])

    // S217: validate propertyId belongs to this landlord. NULL is the
    // legacy "applies landlord-wide" posture and is allowed.
    if (propertyId) {
      const prop = await queryOne<{ landlord_id: string }>(
        'SELECT landlord_id FROM properties WHERE id = $1',
        [propertyId],
      )
      if (!prop || prop.landlord_id !== posLandlordId(req)) {
        throw new AppError(400, 'propertyId does not belong to this landlord')
      }
    }

    // S650: a tax applies to everything ('all'), or to the categories and
    // items it names. Naming any means it is not 'all'.
    const categoryIds = (await ownedTaxTargets(req, 'pos_categories', req.body.categoryIds)) ?? []
    const itemIds = (await ownedTaxTargets(req, 'pos_items', req.body.itemIds)) ?? []
    const targeted = categoryIds.length > 0 || itemIds.length > 0
    const r = await queryOne<any>(`INSERT INTO pos_tax_rates (landlord_id,property_id,name,rate,tax_type,applies_to,category_ids,item_ids)
      VALUES ($1,$2,$3,$4,$5,$6,$7::uuid[],$8::uuid[]) RETURNING *`,
      [posLandlordId(req), propertyId||null, name, rate, taxType || 'sales',
       targeted ? [] : (appliesTo || ['all']), categoryIds, itemIds])
    res.status(201).json({ success: true, data: r })
  } catch (e) { next(e) }
})

posRouter.patch('/tax-rates/:id', requirePerm('pos.manage_inventory'), async (req, res, next) => {
  try {
    const existing = await queryOne<any>(
      'SELECT * FROM pos_tax_rates WHERE id=$1 AND landlord_id=$2',
      [req.params.id, posLandlordId(req)],
    )
    if (!existing) throw new AppError(404, 'Tax rate not found')

    const { name, rate, taxType, appliesTo, isActive, propertyId } = req.body
    assertNonNeg([rate, 'Rate'])

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
      if (!prop || prop.landlord_id !== posLandlordId(req)) {
        throw new AppError(400, 'propertyId does not belong to this landlord')
      }
      newPropertyId = propertyId
    }

    const categoryIds = await ownedTaxTargets(req, 'pos_categories', req.body.categoryIds)
    const itemIds = await ownedTaxTargets(req, 'pos_items', req.body.itemIds)
    const r = await queryOne<any>(`UPDATE pos_tax_rates SET
      name=COALESCE($1,name), rate=COALESCE($2,rate), tax_type=COALESCE($3,tax_type),
      applies_to=COALESCE($4,applies_to), is_active=COALESCE($5,is_active),
      property_id=$6,
      category_ids=COALESCE($9::uuid[],category_ids), item_ids=COALESCE($10::uuid[],item_ids)
      WHERE id=$7 AND landlord_id=$8 RETURNING *`,
      [name, rate, taxType, appliesTo, isActive, newPropertyId, req.params.id, posLandlordId(req),
       categoryIds ?? null, itemIds ?? null])
    res.json({ success: true, data: r })
  } catch (e) { next(e) }
})

posRouter.delete('/tax-rates/:id', requirePerm('pos.manage_inventory'), async (req, res, next) => {
  try {
    await query('UPDATE pos_tax_rates SET is_active=FALSE WHERE id=$1 AND landlord_id=$2', [req.params.id, posLandlordId(req)])
    res.json({ success: true })
  } catch (e) { next(e) }
})

// ── DISCOUNTS ─────────────────────────────────────────────────

posRouter.get('/discounts', requirePerm('pos.discount', 'pos.manage_inventory'), async (req, res, next) => {
  try {
    // W-12 (S531): ?propertyId= returns (discounts at that property) UNION
    // (company-wide NULL rows) — same posture as pos_tax_rates (S217).
    const dProp = req.query.propertyId ? String(req.query.propertyId) : null
    const dParams: any[] = [posLandlordId(req)]
    const dFilter = dProp ? `AND (property_id = $${dParams.push(dProp)} OR property_id IS NULL)` : ''
    const discounts = await query<any>(`SELECT * FROM pos_discounts WHERE landlord_id=$1 AND is_active=TRUE ${dFilter} ORDER BY name`, dParams)
    res.json({ success: true, data: discounts })
  } catch (e) { next(e) }
})

posRouter.post('/discounts', requirePerm('pos.manage_inventory'), async (req, res, next) => {
  try {
    const { name, type, value, code, propertyId } = req.body
    assertNonNeg([value, 'Discount value'])
    // W-12: NULL propertyId = company-wide; a uuid scopes to one property.
    if (propertyId) {
      const owned = await queryOne('SELECT id FROM properties WHERE id=$1 AND landlord_id=$2', [propertyId, posLandlordId(req)])
      if (!owned) throw new AppError(400, 'propertyId does not belong to this landlord')
    }
    const d = await queryOne<any>(`INSERT INTO pos_discounts (landlord_id,name,type,value,code,property_id)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [posLandlordId(req), name, type, value, code||null, propertyId||null])
    res.status(201).json({ success: true, data: d })
  } catch (e) { next(e) }
})

posRouter.patch('/discounts/:id', requirePerm('pos.manage_inventory'), async (req, res, next) => {
  try {
    const { name, type, value, code, isActive } = req.body
    assertNonNeg([value, 'Discount value'])
    const d = await queryOne<any>(`UPDATE pos_discounts SET
      name=COALESCE($1,name), type=COALESCE($2,type), value=COALESCE($3,value),
      code=COALESCE($4,code), is_active=COALESCE($5,is_active)
      WHERE id=$6 AND landlord_id=$7 RETURNING *`,
      [name, type, value, code, isActive, req.params.id, posLandlordId(req)])
    res.json({ success: true, data: d })
  } catch (e) { next(e) }
})

// S554 (button-sweep bug #12): the Discounts tab "Remove" button
// (apiDel /pos/discounts/:id) hit a nonexistent route → 404, discount never
// removed. Soft-delete, landlord-scoped, mirrors DELETE /tax-rates/:id.
posRouter.delete('/discounts/:id', requirePerm('pos.manage_inventory'), async (req, res, next) => {
  try {
    await query('UPDATE pos_discounts SET is_active=FALSE WHERE id=$1 AND landlord_id=$2', [req.params.id, posLandlordId(req)])
    res.json({ success: true })
  } catch (e) { next(e) }
})

// ── REFUNDS ───────────────────────────────────────────────────

posRouter.post('/transactions/:id/refund', requirePerm('pos.refund'), async (req, res, next) => {
  const client = await getClient()
  let txnOpen = false
  try {
    const { amount, reason, items, refundMethod } = req.body
    const tx = await queryOne<any>('SELECT * FROM pos_transactions WHERE id=$1 AND landlord_id=$2', [req.params.id, posLandlordId(req)])
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
    if (!Number.isFinite(refundAmt) || refundAmt <= 0) throw new AppError(400, 'Refund amount must be positive')
    const txTotalNum = Number(tx.total)

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

    // S587: cap the refund at the remaining refundable amount (sale total −
    // already refunded), computed inside the txn with the transaction row locked
    // so two concurrent refunds can't both slip past. Without this a cashier
    // could pay out MORE than the sale — a physical drawer loss on cash/check,
    // or a negative FlexCharge balance on 'charge'. Refunds accumulate across
    // multiple partials; refund_amount is the cumulative total, not the last one.
    await client.query('SELECT 1 FROM pos_transactions WHERE id=$1 FOR UPDATE', [tx.id])
    const priorRefunded = Number((await client.query<{ s: string }>(
      `SELECT COALESCE(SUM(amount),0)::text AS s FROM pos_refunds WHERE transaction_id=$1`,
      [tx.id])).rows[0].s)
    const remaining = Math.round((txTotalNum - priorRefunded) * 100) / 100
    if (refundAmt > remaining + 0.005) {
      throw new AppError(400, priorRefunded > 0
        ? `Refund exceeds the remaining refundable amount ($${remaining.toFixed(2)}; $${priorRefunded.toFixed(2)} already refunded).`
        : `Refund exceeds the sale total ($${txTotalNum.toFixed(2)}).`)
    }
    const cumulativeRefunded = Math.round((priorRefunded + refundAmt) * 100) / 100
    const isFullRefund = cumulativeRefunded >= txTotalNum - 0.005

    await client.query(`INSERT INTO pos_refunds (transaction_id,landlord_id,amount,reason,items,refund_method)
      VALUES ($1,$2,$3,$4,$5,$6)`,
      [tx.id, posLandlordId(req), refundAmt, reason||null, items ? JSON.stringify(items) : null, resolvedMethod])

    await client.query(`UPDATE pos_transactions SET
      status=$1, refund_amount=$2, refunded_at=NOW() WHERE id=$3`,
      [isFullRefund ? 'refunded' : 'partial_refund', cumulativeRefunded, tx.id])

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
    const tx = await queryOne<any>('SELECT * FROM pos_transactions WHERE id=$1 AND landlord_id=$2', [req.params.id, posLandlordId(req)])
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
    // W-12 (S531): optional ?propertyId= — history is viewed per property.
    const txProp = req.query.propertyId ? String(req.query.propertyId) : null
    const txParams: any[] = [posLandlordId(req)]
    const txPropFilter = txProp ? `AND t.property_id = $${txParams.push(txProp)}` : ''
    // S654 (Nic): a customer's purchase history — the receipt panel links here.
    const txCust = req.query.posCustomerId ? String(req.query.posCustomerId) : null
    const txCustFilter = txCust ? `AND t.pos_customer_id = $${txParams.push(txCust)}` : ''
    const txns = await query<any>(`
      SELECT t.*,
        u.first_name || ' ' || u.last_name AS tenant_name,
        NULLIF(TRIM(pc.first_name || ' ' || pc.last_name), '') AS customer_name,
        pc.email AS customer_email,
        pc.first_name AS customer_first_name, pc.last_name AS customer_last_name, pc.phone AS customer_phone,
        (SELECT COUNT(*) FROM pos_transaction_items WHERE transaction_id=t.id) as item_count,
        -- S653 (Nic): "flag the history different for pay links vs terminal
        -- reader." payment_method says card either way; how the card was
        -- presented is the fact the counter wants to see.
        -- S654 (Nic): an emailed link settled at the counter is "Pay link · in
        -- person", with how it was tendered; paid from the email it is online.
        CASE WHEN t.pay_link_id IS NOT NULL AND t.paid_online THEN 'pay_link'
             WHEN t.pay_link_id IS NOT NULL AND t.payment_method = 'cash' THEN 'pay_link_in_person_cash'
             WHEN t.pay_link_id IS NOT NULL THEN 'pay_link_in_person_card'
             WHEN t.payment_method = 'card' AND t.paid_online THEN 'pay_link'
             WHEN t.payment_method = 'card' THEN 'card_reader'
             ELSE t.payment_method END AS tender,
        (SELECT json_agg(json_build_object('name', i.item_name, 'qty', i.qty, 'price', i.unit_price, 'subtotal', i.subtotal) ORDER BY i.created_at)
           FROM pos_transaction_items i WHERE i.transaction_id = t.id) AS items
      FROM pos_transactions t
      LEFT JOIN tenants tn ON tn.id = t.tenant_id
      LEFT JOIN users u ON u.id = tn.user_id
      LEFT JOIN pos_customers pc ON pc.id = t.pos_customer_id
      WHERE t.landlord_id=$1 ${txPropFilter} ${txCustFilter}
      ORDER BY t.created_at DESC LIMIT 100`, txParams)
    res.json({ success: true, data: txns })
  } catch (e) { next(e) }
})

// POST /api/pos/purchase-orders — create new PO
posRouter.post('/purchase-orders', requirePerm('pos.manage_inventory'), async (req, res, next) => {
  try {
    const { vendorId, notes, expectedDate, items, propertyId } = req.body
    const vendor = await queryOne<any>('SELECT * FROM pos_vendors WHERE id=$1 AND landlord_id=$2', [vendorId, posLandlordId(req)])
    if (!vendor) throw new AppError(404, 'Vendor not found')
    // W-12 (S531): POs stamp their receiving property when created from a
    // property context.
    if (propertyId) {
      const owned = await queryOne('SELECT id FROM properties WHERE id=$1 AND landlord_id=$2', [propertyId, posLandlordId(req)])
      if (!owned) throw new AppError(400, 'propertyId does not belong to this landlord')
    }
    // S590: every linked itemId must be the landlord's OWN pos_item — otherwise a
    // PO could reference (and, on receive, restock) another landlord's inventory.
    // Free-text lines (no itemId) are fine. Validated up-front so a bad line never
    // creates a partial PO.
    if (Array.isArray(items)) {
      const linkedIds = Array.from(new Set(items.map((it: any) => it?.itemId).filter(Boolean).map(String)))
      if (linkedIds.length > 0) {
        const owned = await query<{ id: string }>(
          'SELECT id FROM pos_items WHERE landlord_id=$1 AND id = ANY($2::uuid[])',
          [posLandlordId(req), linkedIds])
        if (owned.length !== linkedIds.length) {
          throw new AppError(400, 'A purchase-order line references an item that does not belong to this landlord')
        }
      }
    }

    const poNumber = 'PO-' + Date.now().toString(36).toUpperCase()
    const po = await queryOne<any>(`INSERT INTO pos_purchase_orders
      (landlord_id,vendor_id,status,po_number,notes,expected_date,property_id)
      VALUES ($1,$2,'draft',$3,$4,$5,$6) RETURNING *`,
      [posLandlordId(req), vendorId, poNumber, notes||null, expectedDate||null, propertyId||null])

    let subtotal = 0
    if (items && items.length > 0) {
      for (const item of items) {
        assertNonNeg([item.unitCost, 'Unit cost'], [item.qtyOrdered, 'Qty ordered'])
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
    assertNonNeg([unitCost, 'Unit cost'], [qtyOrdered, 'Qty ordered'])
    const po = await queryOne<any>('SELECT * FROM pos_purchase_orders WHERE id=$1 AND landlord_id=$2', [req.params.id, posLandlordId(req)])
    if (!po) throw new AppError(404, 'PO not found')
    if (po.status !== 'draft') throw new AppError(400, 'Can only add items to draft POs')
    // S590: a linked itemId must be the landlord's own pos_item (see the create route).
    if (itemId) {
      const owned = await queryOne('SELECT id FROM pos_items WHERE id=$1 AND landlord_id=$2', [itemId, posLandlordId(req)])
      if (!owned) throw new AppError(400, 'This item does not belong to this landlord')
    }

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
    // W-12 (S531): ?propertyId= filters movement to that property's items.
    const ilProp = req.query.propertyId ? String(req.query.propertyId) : null
    const ilParams: any[] = [posLandlordId(req)]
    const ilFilter = ilProp ? `AND i.property_id = $${ilParams.push(ilProp)}` : ''
    const log = await query<any>(`
      SELECT l.*, i.name as item_name, i.icon as item_icon, pc.name AS category
      FROM pos_inventory_log l
      JOIN pos_items i ON i.id = l.item_id
      LEFT JOIN pos_categories pc ON pc.id = i.category_id
      WHERE l.landlord_id=$1 ${ilFilter}
      ORDER BY l.created_at DESC LIMIT 200`, ilParams)
    res.json({ success: true, data: log })
  } catch (e) { next(e) }
})

// ── END-OF-DAY RECONCILIATION (S95) ──────────────────────────

// GET /api/pos/eod — list recent settlements (default 30)
posRouter.get('/eod', requirePerm('pos.end_of_day', 'pos.ring_sale'), async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(String(req.query.limit || '30'), 10) || 30, 90)
    // W-12 (S531): settlements are per (landlord, property, day) — the
    // optional ?propertyId= scopes the list to one register/location.
    const eodProp = req.query.propertyId ? String(req.query.propertyId) : null
    const eodParams: any[] = [posLandlordId(req), limit]
    const eodFilter = eodProp ? `AND e.property_id = $${eodParams.push(eodProp)}` : ''
    const rows = await query<any>(
      `SELECT e.*, p.name AS property_name FROM pos_eod_settlements e
        LEFT JOIN properties p ON p.id = e.property_id
        WHERE e.landlord_id = $1 ${eodFilter}
        ORDER BY e.business_day DESC
        LIMIT $2`,
      eodParams
    )
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

// GET /api/pos/eod/:date — settlements for one YYYY-MM-DD day.
// W-12 (S531): settlements are per property, so a day can have several —
// this always returns an ARRAY (one row per property that closed);
// ?propertyId= narrows to one register's settlement.
posRouter.get('/eod/:date', requirePerm('pos.end_of_day', 'pos.ring_sale'), async (req, res, next) => {
  try {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(req.params.date)) {
      throw new AppError(400, 'date must be YYYY-MM-DD')
    }
    const dProp = req.query.propertyId ? String(req.query.propertyId) : null
    const dParams: any[] = [posLandlordId(req), req.params.date]
    const dFilter = dProp ? `AND e.property_id = $${dParams.push(dProp)}` : ''
    const rows = await query<any>(
      `SELECT e.*, p.name AS property_name FROM pos_eod_settlements e
        LEFT JOIN properties p ON p.id = e.property_id
        WHERE e.landlord_id = $1 AND e.business_day = $2 ${dFilter}
        ORDER BY p.name`,
      dParams
    )
    if (!rows.length) throw new AppError(404, 'No settlement for that date')
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

// POST /api/pos/eod/close — manual close with cash drawer count.
// Body: { businessDay: 'YYYY-MM-DD', cashDrawerActual: number,
//         openingFloat?: number, notes?: string }
posRouter.post('/eod/close', requirePerm('pos.end_of_day'), async (req, res, next) => {
  try {
    const { businessDay, cashDrawerActual, openingFloat, notes, propertyId } = req.body
    if (!businessDay || !/^\d{4}-\d{2}-\d{2}$/.test(businessDay)) {
      throw new AppError(400, 'businessDay (YYYY-MM-DD) required')
    }
    if (cashDrawerActual == null || isNaN(Number(cashDrawerActual))) {
      throw new AppError(400, 'cashDrawerActual (number) required')
    }
    // W-12 (S531): each register/location closes its own drawer.
    if (!propertyId) throw new AppError(400, 'propertyId required — EOD closes per property')
    const owned = await queryOne('SELECT id FROM properties WHERE id=$1 AND landlord_id=$2', [propertyId, posLandlordId(req)])
    if (!owned) throw new AppError(400, 'propertyId does not belong to this landlord')
    const { generateEodSettlement } = await import('../services/posEod')
    const result = await generateEodSettlement(
      posLandlordId(req),
      propertyId,
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
    const { businessDay, propertyId } = req.body
    if (!businessDay || !/^\d{4}-\d{2}-\d{2}$/.test(businessDay)) {
      throw new AppError(400, 'businessDay (YYYY-MM-DD) required')
    }
    if (!propertyId) throw new AppError(400, 'propertyId required — EOD closes per property')
    const regenOwned = await queryOne('SELECT id FROM properties WHERE id=$1 AND landlord_id=$2', [propertyId, posLandlordId(req)])
    if (!regenOwned) throw new AppError(400, 'propertyId does not belong to this landlord')
    const { generateEodSettlement } = await import('../services/posEod')
    const result = await generateEodSettlement(
      posLandlordId(req),
      propertyId,
      businessDay,
      { closedBy: req.user!.userId, status: 'manually_closed' }
    )
    // After regen, mark as reopened (status update; ON CONFLICT in the
    // engine wrote 'manually_closed', so flip explicitly).
    await query(
      `UPDATE pos_eod_settlements SET status='reopened', updated_at=NOW()
        WHERE landlord_id=$1 AND business_day=$2`,
      [posLandlordId(req), businessDay]
    )
    res.json({ success: true, data: { ...result, status: 'reopened' } })
  } catch (e) { next(e) }
})

// ─────────────────────────────────────────────────────────────
// STRIPE TERMINAL — reader management (S241)
// ─────────────────────────────────────────────────────────────
//
// Hardware-agnostic per Nic decision: "if we are using stripe api any
// stripe hardware should work." S648: readers pair to GAM's platform account
// inside the property's Terminal Location, and card sales are charged there —
// the landlord's share is paid in the weekly batch like rent.

async function assertPropertyIsLandlords(landlordId: string, propertyId: unknown): Promise<string> {
  if (!propertyId || typeof propertyId !== 'string') throw new AppError(400, 'propertyId is required')
  const prop = await queryOne<{ landlord_id: string }>(
    `SELECT landlord_id FROM properties WHERE id = $1`, [propertyId])
  if (!prop || prop.landlord_id !== landlordId) {
    throw new AppError(400, 'propertyId does not belong to this landlord')
  }
  return propertyId
}

// The landlord's share is paid to their payout account, so a register can't
// take cards until there is one to pay.
async function assertLandlordCanBePaid(landlordId: string): Promise<void> {
  const row = await queryOne<{ stripe_connect_account_id: string | null }>(
    `SELECT COALESCE(l.stripe_connect_account_id, u.stripe_connect_account_id) AS stripe_connect_account_id
       FROM landlords l JOIN users u ON u.id = l.user_id
      WHERE l.id = $1`,
    [landlordId])
  if (!row?.stripe_connect_account_id) {
    throw new AppError(409, 'Set up your payout account under Banking before taking cards')
  }
}

// POST /api/pos/terminal/connection-token
// Issues a short-lived Connection Token for the Stripe Terminal SDK.
// Frontend fetches one each time the SDK initializes a reader connection.
posRouter.post('/terminal/connection-token', requirePerm('pos.ring_sale', 'pos.manage_inventory'), async (req, res, next) => {
  try {
    const propertyId = req.body?.propertyId
      ? await assertPropertyIsLandlords(posLandlordId(req), req.body.propertyId) : undefined
    const secret = await createConnectionToken(propertyId)
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

    await assertPropertyIsLandlords(posLandlordId(req), propertyId)
    await assertLandlordCanBePaid(posLandlordId(req))
    const row = await registerReader({
      landlordId:               posLandlordId(req),
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
    // S652: a reader Stripe registered from a pre-registered shop order shows
    // up here on its own — no pairing code. Best-effort; see the service.
    if (propertyId) {
      const { syncReadersFromStripe } = await import('../services/readerOrders')
      await syncReadersFromStripe(posLandlordId(req), propertyId).catch(() => 0)
    }
    const rows = await listReaders(posLandlordId(req), propertyId)
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

// DELETE /api/pos/terminal/readers/:id
// Soft-archive a reader (sets status='archived'). The Stripe-side record
// remains; landlord can delete via Stripe dashboard if desired. Historical
// transactions referencing this row still resolve.
// ── S652: get a card reader ────────────────────────────────────────────────
// One model (SUPPORTED_CARD_READER), the price and the plan, shipped straight
// from Stripe to the property. GAM's desk does the ordering; the landlord only
// asks and confirms where it goes.
posRouter.post('/reader-orders', requirePerm('pos.manage_inventory'), async (req: any, res, next) => {
  try {
    const body = z.object({
      propertyId: z.string().uuid(),
      shipTo: z.object({
        name: z.string().trim().min(1).max(120), company: z.string().trim().max(120).nullable().optional(),
        line1: z.string().trim().min(1).max(200), line2: z.string().trim().max(200).nullable().optional(),
        city: z.string().trim().min(1).max(100), state: z.string().trim().length(2), zip: z.string().trim().regex(/^\d{5}(-\d{4})?$/),
        phone: z.string().trim().max(30).nullable().optional(), email: z.string().trim().email().nullable().optional(),
      }),
      note: z.string().trim().max(500).nullable().optional(),
    }).parse(req.body)
    const landlordId = posLandlordId(req)
    await assertPropertyIsLandlords(landlordId, body.propertyId)
    await assertLandlordCanBePaid(landlordId)
    const { requestReader } = await import('../services/readerOrders')
    const row = await requestReader({ landlordId, propertyId: body.propertyId, shipTo: body.shipTo, note: body.note ?? null, requestedByUserId: req.user?.userId ?? null })
    res.status(201).json({ success: true, data: row })
  } catch (e) { next(e) }
})
posRouter.get('/reader-orders', requirePerm('pos.ring_sale', 'pos.manage_inventory'), async (req, res, next) => {
  try {
    const propertyId = req.query.propertyId ? String(req.query.propertyId) : undefined
    const { listReaderOrders } = await import('../services/readerOrders')
    res.json({ success: true, data: await listReaderOrders(posLandlordId(req), propertyId) })
  } catch (e) { next(e) }
})
posRouter.post('/reader-orders/:id/cancel', requirePerm('pos.manage_inventory'), async (req, res, next) => {
  try {
    const { cancelReaderRequest } = await import('../services/readerOrders')
    res.json({ success: true, data: await cancelReaderRequest(posLandlordId(req), req.params.id) })
  } catch (e) { next(e) }
})

posRouter.delete('/terminal/readers/:id', requirePerm('pos.manage_inventory'), async (req, res, next) => {
  try {
    const row = await archiveReader(posLandlordId(req), req.params.id)
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

// S648: every register's PaymentIntents now live on ONE account (GAM's), so
// the Connect account no longer fences a landlord off from another's charge —
// the intent's own landlord stamp does, on every call that touches it.
// S654 (Nic, live, at the reader): "Reader not registered to landlord" — on his
// own S710, at his own park. The process / capture / cancel calls name no
// property, so posLandlordId() fell back to the account's HOME company, which
// is not the company that owns Mountain View or its reader. An account is not
// an entity (S633): the card charge itself says which company it belongs to.
// These calls now take the company FROM THE INTENT and only check that the
// caller may act for it. Nothing is guessed from the account.
async function ownTerminalIntent(req: any, paymentIntentId: string): Promise<{ landlordId: string; propertyId: string | null; intent: any }> {
  const intent = await retrieveTerminalPaymentIntent({ paymentIntentId })
  const landlordId = intent.metadata?.gam_landlord_id
  if (intent.metadata?.gam_purpose !== 'pos_terminal' || !landlordId || !ownsLandlord(req.user, landlordId)) {
    throw new AppError(404, 'Card charge not found')
  }
  return { landlordId, propertyId: intent.metadata?.gam_property_id ?? null, intent }
}

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
    const { propertyId, description, posDraftRef, items, discountAmount } = req.body
    if (!propertyId) throw new AppError(400, 'propertyId is required')
    // S648 (Nic): the card reader charges the cart (plus the card fee when the
    // property passes it on), and the amount is the server's, computed from
    // the cart — not a number the register sends.
    if (!Array.isArray(items) || items.length === 0) throw new AppError(400, 'items are required')
    const quoted = await serverCartTotals(posLandlordId(req), items, 'card', discountAmount, undefined, propertyId)
    const amountCents = Math.round(quoted.total * 100)
    if (amountCents <= 0) throw new AppError(400, 'Nothing to charge')

    // Same posture as reader registration — a cashier on landlord A can't
    // tag a charge to landlord B's property.
    await assertPropertyIsLandlords(posLandlordId(req), propertyId)
    await assertLandlordCanBePaid(posLandlordId(req))
    const intent = await createCardPresentPaymentIntent({
      landlordId:               posLandlordId(req),
      propertyId,
      amountCents,
      cardFeeCents:             Math.round(quoted.cardFee * 100),
      description,
      posDraftRef,
    })
    res.status(201).json({
      success: true,
      data: { id: intent.id, status: intent.status, clientSecret: intent.client_secret,
              total: quoted.total, cardFee: quoted.surcharge },  // what the customer sees
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
    const { intent } = await ownTerminalIntent(req, paymentIntentId)
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

    const { landlordId, propertyId, intent } = await ownTerminalIntent(req, paymentIntentId)
    const ownerRow = await assertReaderBelongsToLandlord(landlordId, stripeReaderId)
    if (!ownerRow) throw new AppError(404, 'That reader is not paired to the company this sale belongs to')
    // S654 (Nic): "it'd be nice to see a little bit of a breakdown." The reader
    // shows the lines, tax, card fee and total before it asks for the card —
    // priced by the server from the same cart (a changed cart is refused),
    // never from figures the register typed.
    const { items, discountAmount } = req.body
    if (Array.isArray(items) && items.length) {
      const quoted = await serverCartTotals(landlordId, items, 'card', discountAmount, undefined, propertyId)
      if (Math.round(quoted.total * 100) !== intent.amount) {
        throw new AppError(409, 'The cart changed since this card charge was created — start the charge again.')
      }
      const who = await personOnSale(landlordId, { tenantId: req.body.tenantId, posCustomerId: req.body.posCustomerId })
      await showCartOnReader({ stripeReaderId, lines: registerReaderLines(items, quoted.surcharge),
        taxCents: Math.round(Number(quoted.taxAmount) * 100), totalCents: intent.amount, who })
      // S654 (Nic): "it needs to be there the whole time … until the payment is
      // processed." Stripe's own pay screen shows the total only, and Stripe
      // sends nothing when a card is tapped on the breakdown — so the register
      // puts the breakdown up while the cart is rung (POST /terminal/readers/
      // :id/cart) and the customer taps THERE. When it has been up, Charge
      // completes with that tap at once. Only a breakdown that was not up yet
      // is held, so the customer still gets to read it before the pay screen.
      if (req.body.cartOnReader !== true) await holdForTheCart()
    }
    const reader = await processPaymentIntentOnReader({ stripeReaderId, paymentIntentId, allowRedisplay: true })
    res.json({
      success: true,
      data: {
        readerId: reader.id,
        action:   reader.action,  // status + payment_intent details for client polling
      },
    })
  } catch (e) { next(e) }
})

// S654 (Nic): "link it to be always on the screen until the payment is
// processed … and it should show their name on the pay screen as well." The
// register sends the cart here as it is rung — every item, discount and change
// of customer — and the reader shows the breakdown, the customer's name first.
// In the US that screen takes the tap (pre-dip), so the breakdown is what they
// pay on. Priced by the server from the cart, the same as the charge itself.
// An empty cart takes the breakdown down. Display only: no money moves, and a
// reader that is mid-payment or still asking the last customer a question is
// left alone (`busy`).
posRouter.post('/terminal/readers/:stripeReaderId/cart', requirePerm('pos.ring_sale'), async (req: any, res, next) => {
  try {
    const stripeReaderId = String(req.params.stripeReaderId)
    const propertyId = typeof req.body?.propertyId === 'string' ? req.body.propertyId : ''
    if (!propertyId) throw new AppError(400, 'A property must be selected — sales are per-property')
    await assertPropertyInScope(req.user, propertyId)
    const landlordId = posLandlordId(req)
    await assertPropertyIsLandlords(landlordId, propertyId)
    if (!(await assertReaderBelongsToLandlord(landlordId, stripeReaderId))) {
      throw new AppError(404, 'That reader is not paired to the company this register belongs to')
    }
    const items = Array.isArray(req.body?.items) ? req.body.items.filter((it: any) => Number(it?.qty) > 0) : []
    if (!items.length) {
      const cleared = await clearCartOnReader(stripeReaderId)
      return res.json({ success: true, data: { shown: false, cleared } })
    }
    for (const it of items) assertNonNeg([it.qty, 'Quantity'], [it.price, 'Price'], [it.tax ?? it.tax_rate, 'Tax rate'])
    await assertCashierPricing(req, items.map((it: any) => ({ itemId: it.id, price: it.price })), req.body?.discountAmount)
    const quoted = await serverCartTotals(landlordId, items, 'card', req.body?.discountAmount, undefined, propertyId)
    const who = await personOnSale(landlordId, { tenantId: req.body?.tenantId, posCustomerId: req.body?.posCustomerId })
    const action = await readerAction(stripeReaderId).catch(() => null)
    if (action && action.status === 'in_progress' && action.type !== 'set_reader_display') {
      return res.json({ success: true, data: { shown: false, busy: action.type } })
    }
    const totalCents = Math.round(Number(quoted.total) * 100)
    const shown = await showCartOnReader({ stripeReaderId, lines: registerReaderLines(items, quoted.surcharge),
      taxCents: Math.round(Number(quoted.taxAmount) * 100), totalCents, who })
    res.json({ success: true, data: { shown, totalCents } })
  } catch (e) { next(e) }
})

// POST /api/pos/terminal/payment-intents/:id/capture — flip a PI in
// `requires_capture` to `succeeded`. Called after the reader confirms
// the auth and the operator confirms the sale.
posRouter.post('/terminal/payment-intents/:id/capture', requirePerm('pos.ring_sale'), async (req, res, next) => {
  try {
    const paymentIntentId = req.params.id
    await ownTerminalIntent(req, paymentIntentId)
    const intent = await captureTerminalPaymentIntent({ paymentIntentId })
    res.json({ success: true, data: { id: intent.id, status: intent.status, amount: intent.amount } })
  } catch (e) { next(e) }
})

// POST /api/pos/terminal/payment-intents/:id/cancel — void the PI
// before capture. Operator voids the sale, customer walks, reader
// times out, etc.
posRouter.post('/terminal/payment-intents/:id/cancel', requirePerm('pos.ring_sale'), async (req, res, next) => {
  try {
    const paymentIntentId = req.params.id
    const { landlordId } = await ownTerminalIntent(req, paymentIntentId)
    // S654 (Nic, live): "the screen is still showing tap or insert." Canceling
    // the charge does not clear the reader; its own action is canceled too —
    // for a reader paired to this company only.
    const readerId = typeof req.body?.stripeReaderId === 'string' ? req.body.stripeReaderId : null
    if (readerId && await assertReaderBelongsToLandlord(landlordId, readerId)) await cancelReaderAction(readerId)
    const intent = await cancelTerminalPaymentIntent({ paymentIntentId })
    res.json({ success: true, data: { id: intent.id, status: intent.status } })
  } catch (e) { next(e) }
})

// S654 (Nic): "I don't want it to void the charge. I want it to revert back
// to the cart so they can try again." A reader that timed out, declined, or was
// canceled is CLEARED; the charge and the cart stay, and the register sends
// the same charge again when the customer is back. /cancel (the void) is for
// a sale that is abandoned or whose cart changed.
posRouter.post('/terminal/payment-intents/:id/clear-reader', requirePerm('pos.ring_sale'), async (req, res, next) => {
  try {
    const { landlordId } = await ownTerminalIntent(req, req.params.id)
    const readerId = typeof req.body?.stripeReaderId === 'string' ? req.body.stripeReaderId : ''
    if (!readerId || !(await assertReaderBelongsToLandlord(landlordId, readerId))) {
      throw new AppError(404, 'That reader is not paired to the company this sale belongs to')
    }
    await cancelReaderAction(readerId)
    res.json({ success: true, data: { cleared: true } })
  } catch (e) { next(e) }
})

// S654 (Nic): the customer's answer on the reader — "Save this card for next
// time?" — and the clerk's way to take the question back off the screen.
async function ownedReaderByStripeId(req: any, stripeReaderId: string): Promise<{ landlord_id: string }> {
  const reader = await queryOne<{ landlord_id: string }>(
    `SELECT landlord_id FROM pos_terminal_readers
      WHERE stripe_reader_id = $1 AND landlord_id = ANY($2::uuid[]) AND status = 'active'`,
    [stripeReaderId, landlordScopeIds(req.user)])
  if (!reader) throw new AppError(404, 'Reader not found')
  return reader
}

posRouter.get('/terminal/readers/:stripeReaderId/save-card-answer', requirePerm('pos.ring_sale'), async (req: any, res, next) => {
  try {
    const stripeReaderId = String(req.params.stripeReaderId)
    const reader = await ownedReaderByStripeId(req, stripeReaderId)
    const tx = await queryOne<any>(
      `SELECT id, pos_customer_id, stripe_payment_intent_id FROM pos_transactions WHERE id = $1 AND landlord_id = $2`,
      [String(req.query.transactionId ?? ''), reader.landlord_id])
    if (!tx || !tx.pos_customer_id || !tx.stripe_payment_intent_id) throw new AppError(404, 'Sale not found')
    const answer = await readSaveCardAnswer(stripeReaderId)
    if (!answer.answered) return res.json({ success: true, data: { answered: false } })
    let saved = false, reason: string | null = answer.reason ?? null
    // A name typed on the reader replaces the placeholder a name-less tap left.
    let nameSet: string | null = null
    if (answer.name) {
      const cur = await queryOne<{ first_name: string; last_name: string }>(`SELECT first_name, last_name FROM pos_customers WHERE id = $1`, [tx.pos_customer_id])
      if (cur && cur.first_name === 'Card' && cur.last_name === 'Customer') {
        const parts = answer.name.split(' ')
        const first = parts.length > 1 ? parts.slice(0, -1).join(' ') : parts[0]
        const last = parts.length > 1 ? parts[parts.length - 1] : ''
        await query(`UPDATE pos_customers SET first_name = $1, last_name = $2, updated_at = NOW() WHERE id = $3`, [first, last, tx.pos_customer_id])
        nameSet = answer.name
      }
    }
    if (answer.yes) {
      const pi = await retrieveTerminalPaymentIntentWithCharge({ paymentIntentId: tx.stripe_payment_intent_id })
      const card = cardIdentityFromIntent(pi)
      if (card?.generatedCard) {
        await saveCardForCustomer({ landlordId: reader.landlord_id, customerId: tx.pos_customer_id, generatedCard: card.generatedCard, fingerprint: card.fingerprint })
        saved = true
      } else reason = 'the card could not be kept'
    }
    // An email typed on the reader is the customer's: kept when we had none, and the receipt goes out.
    let receiptSentTo: string | null = null
    if (answer.email) {
      receiptSentTo = await emailReceiptForSale(tx.id, answer.email, [reader.landlord_id])
    }
    res.json({ success: true, data: { answered: true, saved, reason, receiptSentTo, nameSet } })
  } catch (e) { next(e) }
})

posRouter.post('/terminal/readers/:stripeReaderId/cancel-action', requirePerm('pos.ring_sale'), async (req: any, res, next) => {
  try {
    const stripeReaderId = String(req.params.stripeReaderId)
    await ownedReaderByStripeId(req, stripeReaderId)
    await cancelReaderAction(stripeReaderId)
    res.json({ success: true, data: { cleared: true } })
  } catch (e) { next(e) }
})

// S654 (Nic): "most people… are going to provide their email for an email copy
// of the receipt." The receipt carries the customer's name; the email given
// becomes the customer's when we had none.
posRouter.post('/transactions/:id/email-receipt', requirePerm('pos.ring_sale'), async (req: any, res, next) => {
  try {
    const email = String(req.body?.email ?? '').trim().toLowerCase()
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new AppError(400, 'Enter a valid email address')
    const sentTo = await emailReceiptForSale(String(req.params.id), email, landlordScopeIds(req.user))
    res.json({ success: true, data: { sentTo } })
  } catch (e) { next(e) }
})

async function emailReceiptForSale(transactionId: string, email: string, landlordIds: string[]): Promise<string> {
  {
    const tx = await queryOne<any>(
      `SELECT t.*, p.name AS property_name, p.street1, p.street2, p.city, p.state, p.zip, l.business_name,
              pc.first_name AS c_first, pc.last_name AS c_last, pc.email AS c_email, pc.phone AS c_phone,
              u.first_name AS t_first, u.last_name AS t_last, u.email AS t_email
         FROM pos_transactions t
         JOIN landlords l ON l.id = t.landlord_id
         LEFT JOIN properties p ON p.id = t.property_id
         LEFT JOIN pos_customers pc ON pc.id = t.pos_customer_id
         LEFT JOIN tenants tn ON tn.id = t.tenant_id
         LEFT JOIN users u ON u.id = tn.user_id
        WHERE t.id = $1 AND t.landlord_id = ANY($2::uuid[])`,
      [transactionId, landlordIds])
    if (!tx) throw new AppError(404, 'Sale not found')
    const items = await query<any>(
      `SELECT item_name, qty, unit_price, subtotal FROM pos_transaction_items WHERE transaction_id = $1 ORDER BY created_at`, [tx.id])
    const lines = items.map(l => ({ description: String(l.item_name), quantity: Number(l.qty), unitPrice: Number(l.unit_price), lineTotal: Number(l.subtotal) }))
    if (Number(tx.surcharge) > 0) lines.push({ description: 'Card processing fee', quantity: 1, unitPrice: Number(tx.surcharge), lineTotal: Number(tx.surcharge) })
    const receiptNumber = String(tx.id).slice(0, 8).toUpperCase()
    const { renderPosReceiptPdf } = await import('../services/businessPdf')
    const buffer = await renderPosReceiptPdf({
      business: { name: tx.property_name || tx.business_name || 'Register', email: null, phone: null,
                  street1: tx.street1 ?? null, street2: tx.street2 ?? null, city: tx.city ?? null, state: tx.state ?? null, zip: tx.zip ?? null },
      customer: (tx.c_first || tx.t_first) ? {
        firstName: tx.c_first ?? tx.t_first, lastName: tx.c_last ?? tx.t_last, companyName: null,
        email: tx.c_email ?? tx.t_email ?? email, phone: tx.c_phone ?? null, street1: null, city: null, state: null, zip: null,
      } : null,
      receiptNumber, createdAt: tx.created_at, status: String(tx.status), paymentMethod: String(tx.payment_method),
      amountTendered: null, changeDue: Number(tx.change_given) > 0 ? Number(tx.change_given) : null, refundReason: null,
      lines,
      subtotal: Math.round((Number(tx.subtotal) + Number(tx.surcharge || 0)) * 100) / 100,
      discountAmount: Number(tx.discount_amount || 0), taxAmount: Number(tx.tax_amount || 0), tipAmount: 0, totalAmount: Number(tx.total),
    } as any)
    const { emailPosReceipt } = await import('../services/email')
    await emailPosReceipt(email, tx.property_name || tx.business_name || 'GAM', receiptNumber, Number(tx.total), buffer,
      { relatedEntityType: 'pos_transaction', relatedEntityId: tx.id } as any)
    if (tx.pos_customer_id && !tx.c_email) {
      // S654 (Nic): "people aren't going to have the same email if they're a
      // different person." An address another live customer of this company
      // already has means THIS record (made from a card) is that person: fold
      // it into them, cards and purchases included.
      const existing = await queryOne<{ id: string }>(
        `SELECT id FROM pos_customers WHERE landlord_id = $1 AND lower(email) = lower($2) AND archived_at IS NULL AND id <> $3`,
        [tx.landlord_id, email, tx.pos_customer_id])
      if (existing) {
        const client = await getClient()
        try {
          await client.query('BEGIN')
          await mergePosCustomers(client, { landlordId: tx.landlord_id, loserId: tx.pos_customer_id, into: existing.id })
          await client.query('COMMIT')
        } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e } finally { client.release() }
      } else {
        await query(`UPDATE pos_customers SET email = $1, updated_at = NOW() WHERE id = $2`, [email, tx.pos_customer_id])
      }
    }
    return email
  }
}

// ── S654 (Nic): the customer base ────────────────────────────────────────
//
//   "There should be an overall customers tab in the point of sale… see my
//    whole customer history… merge customers — a match on email, I think, or
//    phone number… people aren't going to have the same email if they're a
//    different person." And from History: "retroactively link a specific
//    customer to a transaction… resend another email."
//
// A customer belongs to one company; the register's property names it.
// Merging folds one record into another (purchases, cards, tickets, links,
// charge account all move; the folded record is archived, never deleted).
// Likely duplicates are the same email or the same phone — never the same
// name.

const PHONE_DIGITS = `regexp_replace(COALESCE($$X$$, ''), '\\D', '', 'g')`
function phoneDigits(col: string): string { return PHONE_DIGITS.replace('$$X$$', col) }

// S654 (Nic): "is there a way if I had selected an existing customer to link to
// the ticket? Which I don't see a way to do from the point of sale screen." The
// register's people for any sale: this property's residents and the company's
// register customers, one list. Another company's people never appear.
posRouter.get('/people', requirePerm('pos.ring_sale'), async (req: any, res, next) => {
  try {
    const propertyId = String(req.query.propertyId ?? '')
    if (!/^[0-9a-f-]{36}$/i.test(propertyId)) throw new AppError(400, 'A property must be selected')
    await assertPropertyInScope(req.user, propertyId)
    const landlordId = posLandlordId(req)
    await assertPropertyIsLandlords(landlordId, propertyId)
    const residents = await query<any>(
      `SELECT DISTINCT ON (t.id) t.id, uu.first_name, uu.last_name, uu.email, un.unit_number, l.status
         FROM tenants t
         JOIN users uu ON uu.id = t.user_id
         JOIN lease_tenants lt ON lt.tenant_id = t.id
         JOIN leases l ON l.id = lt.lease_id
         JOIN units un ON un.id = l.unit_id
        WHERE l.landlord_id = $1 AND un.property_id = $2
        ORDER BY t.id, l.created_at DESC`, [landlordId, propertyId])
    const customers = await query<any>(
      `SELECT id, first_name, last_name, email, phone FROM pos_customers
        WHERE landlord_id = $1 AND archived_at IS NULL`, [landlordId])
    const people = [
      ...residents.map((r: any) => ({ key: `t:${r.id}`, kind: 'resident', id: r.id,
        name: `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim() || 'Resident',
        detail: r.unit_number ? `Site ${r.unit_number}` : null, email: r.email ?? null })),
      ...customers.map((c: any) => ({ key: `c:${c.id}`, kind: 'customer', id: c.id,
        name: `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim() || 'Customer',
        detail: c.email ?? c.phone ?? null, email: c.email ?? null })),
    ].sort((a, b) => a.name.localeCompare(b.name))
    res.json({ success: true, data: people })
  } catch (e) { next(e) }
})

// S654 (Nic): "for cash people we can add them as a customer." A customer added
// at the register needs a first name and nothing else; an email already on this
// company's list returns that customer instead of a second one.
posRouter.post('/customers', requirePerm('pos.ring_sale'), async (req: any, res, next) => {
  try {
    const b = z.object({
      propertyId: z.string().uuid(),
      firstName:  z.string().trim().min(1, 'A first name is needed').max(80),
      lastName:   z.string().trim().max(80).optional().nullable(),
      email:      z.string().trim().max(200).optional().nullable(),
      phone:      z.string().trim().max(40).optional().nullable(),
    }).parse(req.body)
    await assertPropertyInScope(req.user, b.propertyId)
    const landlordId = posLandlordId(req)
    await assertPropertyIsLandlords(landlordId, b.propertyId)
    const email = b.email ? b.email.toLowerCase() : null
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new AppError(400, 'That email does not look right')
    if (email) {
      const existing = await queryOne<any>(
        `SELECT id, first_name, last_name, email, phone, archived_at FROM pos_customers
          WHERE landlord_id = $1 AND lower(email) = $2`, [landlordId, email])
      if (existing && !existing.archived_at) return res.json({ success: true, data: { ...existing, existing: true } })
      if (existing) throw new AppError(409, 'That email is on a customer record that was closed. Use a different email or leave it blank.')
    }
    const row = await queryOne<any>(
      `INSERT INTO pos_customers (landlord_id, first_name, last_name, email, phone, created_from)
       VALUES ($1, $2, $3, $4, $5, 'manual')
       RETURNING id, first_name, last_name, email, phone`,
      [landlordId, b.firstName, b.lastName ?? '', email, b.phone || null])
    res.status(201).json({ success: true, data: row })
  } catch (e) { next(e) }
})

posRouter.get('/customers', requirePerm('pos.ring_sale', 'pos.end_of_day'), async (req, res, next) => {
  try {
    const landlordId = posLandlordId(req)
    const rows = await query<any>(
      `SELECT c.id, c.first_name, c.last_name, c.email, c.phone, c.created_from, c.created_at, c.notes,
              (c.stripe_customer_id IS NOT NULL) AS has_stripe_customer,
              (SELECT COUNT(*)::int FROM pos_transactions t WHERE t.pos_customer_id = c.id) AS purchases,
              (SELECT COALESCE(SUM(t.total), 0)::float FROM pos_transactions t WHERE t.pos_customer_id = c.id AND t.status <> 'voided') AS total_spent,
              (SELECT MAX(t.created_at) FROM pos_transactions t WHERE t.pos_customer_id = c.id) AS last_purchase_at,
              (SELECT COALESCE(json_agg(json_build_object('brand', k.brand, 'last4', k.last4, 'saved', k.stripe_payment_method_id IS NOT NULL) ORDER BY k.last_seen_at DESC), '[]'::json)
                 FROM pos_customer_cards k WHERE k.pos_customer_id = c.id) AS cards,
              (SELECT COALESCE(json_agg(d.id), '[]'::json) FROM pos_customers d
                WHERE d.landlord_id = c.landlord_id AND d.id <> c.id AND d.archived_at IS NULL
                  AND ((c.email IS NOT NULL AND lower(d.email) = lower(c.email))
                    OR (${phoneDigits('c.phone')} <> '' AND ${phoneDigits('d.phone')} = ${phoneDigits('c.phone')}))) AS duplicate_ids
         FROM pos_customers c
        WHERE c.landlord_id = $1 AND c.archived_at IS NULL
        ORDER BY c.last_name, c.first_name`, [landlordId])
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

posRouter.patch('/customers/:id', requirePerm('pos.ring_sale'), async (req, res, next) => {
  try {
    const b = z.object({
      firstName: z.string().trim().min(1).max(80).optional(),
      lastName:  z.string().trim().max(80).optional(),
      email:     z.string().trim().toLowerCase().email().nullable().optional(),
      phone:     z.string().trim().max(40).nullable().optional(),
    }).parse(req.body)
    const row = await queryOne<any>(
      `UPDATE pos_customers SET
          first_name = COALESCE($1, first_name), last_name = COALESCE($2, last_name),
          email = CASE WHEN $3::text IS NULL AND $5::boolean THEN NULL ELSE COALESCE($3, email) END,
          phone = CASE WHEN $4::text IS NULL AND $6::boolean THEN NULL ELSE COALESCE($4, phone) END,
          updated_at = NOW()
        WHERE id = $7 AND landlord_id = $8 AND archived_at IS NULL
        RETURNING id, first_name, last_name, email, phone`,
      [b.firstName ?? null, b.lastName ?? null, b.email ?? null, b.phone ?? null,
       'email' in b && b.email === null, 'phone' in b && b.phone === null,
       req.params.id, posLandlordId(req)])
    if (!row) throw new AppError(404, 'Customer not found')
    res.json({ success: true, data: row })
  } catch (e) { next(e) }
})

posRouter.post('/customers/:id/merge', requirePerm('pos.ring_sale'), async (req, res, next) => {
  try {
    const { into } = z.object({ into: z.string().uuid() }).parse(req.body)
    const landlordId = posLandlordId(req)
    const client = await getClient()
    try {
      await client.query('BEGIN')
      await mergePosCustomers(client, { landlordId, loserId: String(req.params.id), into })
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally { client.release() }
    const survivor = await queryOne<any>(`SELECT id, first_name, last_name, email, phone FROM pos_customers WHERE id = $1`, [into])
    res.json({ success: true, data: survivor })
  } catch (e) { next(e) }
})

// Fix which customer a sale belongs to, after the fact.
// S654 (Nic): "another way to add a customer name after the sale is completed …
// I don't want to change it to a whole dropdown of a list. I want to just edit
// the field as their first and last name and email and phone number." The
// sale's customer is typed in: the record the sale already has is edited (a
// name-less card customer gets their name); a sale with nobody gets a new
// customer. An email or phone already on another customer of this company is
// the same person — this record is folded into theirs, never duplicated.
// A resident's details belong to their account and are not edited here.
posRouter.put('/transactions/:id/customer-info', requirePerm('pos.ring_sale'), async (req, res, next) => {
  try {
    const b = z.object({
      firstName: z.string().trim().min(1, 'A first name is needed').max(80),
      lastName:  z.string().trim().max(80).optional().nullable(),
      email:     z.string().trim().max(200).optional().nullable(),
      phone:     z.string().trim().max(40).optional().nullable(),
    }).parse(req.body)
    const email = b.email ? b.email.toLowerCase() : null
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new AppError(400, 'That email does not look right')
    const phone = b.phone || null
    const digits = phone ? phone.replace(/\D/g, '') : ''
    const landlordId = posLandlordId(req)
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const tx = (await client.query<any>(
        `SELECT id, tenant_id, pos_customer_id FROM pos_transactions WHERE id = $1 AND landlord_id = $2 FOR UPDATE`,
        [req.params.id, landlordId])).rows[0]
      if (!tx) throw new AppError(404, 'Sale not found')
      if (tx.tenant_id) throw new AppError(409, "This sale is a resident's — their name and email are on their account.")
      // Somebody else of this company's with the same email or phone is this person.
      const same = (email || digits.length >= 7) ? (await client.query<any>(
        `SELECT id FROM pos_customers
          WHERE landlord_id = $1 AND archived_at IS NULL AND id <> COALESCE($2::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
            AND (($3::text IS NOT NULL AND lower(email) = $3)
              OR ($4::text <> '' AND ${phoneDigits('phone')} = $4))
          ORDER BY (lower(email) = $3) DESC NULLS LAST, created_at
          LIMIT 1`, [landlordId, tx.pos_customer_id, email, digits.length >= 7 ? digits : ''])).rows[0] : null
      let customerId: string
      if (tx.pos_customer_id && same) {
        await mergePosCustomers(client, { landlordId, loserId: tx.pos_customer_id, into: same.id })
        customerId = same.id
      } else if (tx.pos_customer_id) {
        customerId = tx.pos_customer_id
      } else if (same) {
        customerId = same.id
      } else {
        customerId = (await client.query<{ id: string }>(
          `INSERT INTO pos_customers (landlord_id, first_name, last_name, created_from) VALUES ($1, $2, '', 'manual') RETURNING id`,
          [landlordId, b.firstName])).rows[0].id
      }
      const row = (await client.query<any>(
        `UPDATE pos_customers SET first_name = $1, last_name = $2, email = $3, phone = $4, updated_at = NOW()
          WHERE id = $5 RETURNING id, first_name, last_name, email, phone`,
        [b.firstName, b.lastName ?? '', email, phone, customerId])).rows[0]
      // The sale (and, after a fold, every sale of the folded record) is this customer's.
      await client.query(`UPDATE pos_transactions SET pos_customer_id = $1 WHERE id = $2`, [customerId, tx.id])
      await client.query('COMMIT')
      res.json({ success: true, data: row })
    } catch (e: any) {
      await client.query('ROLLBACK').catch(() => {})
      if (e?.code === '23505') throw new AppError(409, 'That email is already on another customer.')
      throw e
    } finally { client.release() }
  } catch (e) { next(e) }
})

posRouter.patch('/transactions/:id/customer', requirePerm('pos.ring_sale'), async (req, res, next) => {
  try {
    const b = z.object({ posCustomerId: z.string().uuid().nullable().optional(), tenantId: z.string().uuid().nullable().optional() }).parse(req.body)
    if (b.posCustomerId && b.tenantId) throw new AppError(400, 'A sale belongs to one person — a resident or a customer, not both')
    const landlordId = posLandlordId(req)
    const tx = await queryOne<{ id: string }>(`SELECT id FROM pos_transactions WHERE id = $1 AND landlord_id = $2`, [req.params.id, landlordId])
    if (!tx) throw new AppError(404, 'Sale not found')
    if (b.posCustomerId) {
      const c = await queryOne(`SELECT 1 FROM pos_customers WHERE id = $1 AND landlord_id = $2 AND archived_at IS NULL`, [b.posCustomerId, landlordId])
      if (!c) throw new AppError(404, 'Customer not found')
    }
    if (b.tenantId) {
      const t = await queryOne(
        `SELECT 1 FROM lease_tenants lt JOIN leases l ON l.id = lt.lease_id WHERE lt.tenant_id = $1 AND l.landlord_id = $2 LIMIT 1`,
        [b.tenantId, landlordId])
      if (!t) throw new AppError(404, 'That resident is not at one of this company\'s properties')
    }
    const row = await queryOne<any>(
      `UPDATE pos_transactions SET pos_customer_id = $1, tenant_id = $2 WHERE id = $3
       RETURNING id, pos_customer_id, tenant_id`, [b.posCustomerId ?? null, b.tenantId ?? null, tx.id])
    const name = await queryOne<{ name: string | null }>(
      `SELECT COALESCE(
          (SELECT NULLIF(TRIM(pc.first_name || ' ' || pc.last_name), '') FROM pos_customers pc WHERE pc.id = $1),
          (SELECT u.first_name || ' ' || u.last_name FROM tenants tn JOIN users u ON u.id = tn.user_id WHERE tn.id = $2)) AS name`,
      [row.pos_customer_id, row.tenant_id])
    res.json({ success: true, data: { ...row, customer_name: name?.name ?? null } })
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
    const params: any[] = [posLandlordId(req), status]
    let propertyClause = ''
    if (propertyId) { params.push(propertyId); propertyClause = ' AND s.property_id = $3' }
    const sessions = await query<any>(
      `SELECT s.*,
              COALESCE(
                pcu.first_name || ' ' || pcu.last_name,
                tu.first_name  || ' ' || tu.last_name
              ) AS customer_name,
              pr.name AS property_name,
              (SELECT COUNT(*)::int FROM pos_session_items WHERE session_id = s.id) AS item_count,
              -- S654 (Nic): the open-tab list says what is in each cart.
              (SELECT string_agg(x.item_name || CASE WHEN x.qty > 1 THEN ' ×' || x.qty::int ELSE '' END, ', ')
                 FROM (SELECT item_name, qty FROM pos_session_items WHERE session_id = s.id ORDER BY created_at LIMIT 3) x) AS preview
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
    if (!prop || prop.landlord_id !== posLandlordId(req)) {
      throw new AppError(403, 'Property does not belong to this landlord')
    }
    // Property lock: scoped cashier may only open a session on their property.
    await assertPropertyInScope(req.user, propertyId)

    const row = await queryOne<any>(
      `INSERT INTO pos_sessions
         (property_id, landlord_id, opened_by_user_id, pos_customer_id, tenant_id, notes)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [propertyId, posLandlordId(req), req.user!.userId, posCustomerId || null, tenantId || null, notes || null],
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
      [req.params.id, posLandlordId(req)],
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
      [req.params.id, posLandlordId(req)],
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
      await assertCashierPricing(req, [], d)
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
      [req.params.id, posLandlordId(req)],
    )
    if (!session) throw new AppError(404, 'Session not found')
    if (session.status !== 'open') throw new AppError(409, `Session is ${session.status}`)

    const b = req.body || {}
    const qty = Number(b.qty)
    const unitPrice = Number(b.unitPrice)
    if (!b.itemName) throw new AppError(400, 'itemName required')
    if (!Number.isFinite(qty) || qty <= 0) throw new AppError(400, 'qty must be positive')
    if (!Number.isFinite(unitPrice) || unitPrice < 0) throw new AppError(400, 'unitPrice must be non-negative')
    assertNonNeg([b.taxRate, 'Tax rate'], [b.costPrice, 'Cost price'])

    assertCatalogItems([{ itemId: b.itemId }])
    await assertCashierPricing(req, [{ itemId: b.itemId, price: unitPrice }])
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
      [req.params.id, posLandlordId(req)],
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
      const line = await queryOne<{ item_id: string | null }>(
        `SELECT item_id FROM pos_session_items WHERE id = $1 AND session_id = $2`,
        [req.params.itemId, req.params.id])
      await assertCashierPricing(req, [{ itemId: line?.item_id, price: u }])
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
      [req.params.id, posLandlordId(req)],
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
      [req.body?.reason || null, req.params.id, posLandlordId(req)],
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
    if (!tx || tx.landlord_id !== posLandlordId(req)) {
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
      [transactionId, req.params.id, posLandlordId(req)],
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

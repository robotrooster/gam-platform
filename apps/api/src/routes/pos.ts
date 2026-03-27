import { Router } from 'express'
import { query, queryOne } from '../db'
import { requireAuth, requireLandlord } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import crypto from 'crypto'

export const posRouter = Router()
posRouter.use(requireAuth)

const DEFAULT_ITEMS = [
  { name:'Propane 20lb',    category:'fuel',     icon:'⛽', sell_price:24.99, cost_price:14.00, tax_rate:.08, stock_qty:20, stock_min:5,  stock_max:50 },
  { name:'Propane Refill',  category:'fuel',     icon:'🔧', sell_price:14.99, cost_price:8.00,  tax_rate:.08, stock_qty:20, stock_min:5,  stock_max:50 },
  { name:'Firewood Bundle', category:'amenity',  icon:'🪵', sell_price:8.99,  cost_price:3.00,  tax_rate:.08, stock_qty:30, stock_min:10, stock_max:100 },
  { name:'Firewood Box',    category:'amenity',  icon:'🔥', sell_price:24.99, cost_price:10.00, tax_rate:.08, stock_qty:10, stock_min:3,  stock_max:30 },
  { name:'Ice Bag 10lb',    category:'misc',     icon:'🧊', sell_price:3.99,  cost_price:1.50,  tax_rate:.08, stock_qty:50, stock_min:20, stock_max:200 },
  { name:'Washer Load',     category:'laundry',  icon:'🧺', sell_price:2.50,  cost_price:0.50,  tax_rate:0,   stock_qty:999,stock_min:999,stock_max:999 },
  { name:'Dryer Load',      category:'laundry',  icon:'🌀', sell_price:2.00,  cost_price:0.40,  tax_rate:0,   stock_qty:999,stock_min:999,stock_max:999 },
  { name:'Parking Day',     category:'parking',  icon:'🅿️', sell_price:10.00, cost_price:0,     tax_rate:0,   stock_qty:999,stock_min:999,stock_max:999 },
  { name:'Parking Month',   category:'parking',  icon:'🚗', sell_price:75.00, cost_price:0,     tax_rate:0,   stock_qty:999,stock_min:999,stock_max:999 },
  { name:'Late Fee',        category:'fee',      icon:'⏰', sell_price:75.00, cost_price:0,     tax_rate:0,   stock_qty:999,stock_min:999,stock_max:999, charge_eligible:false },
  { name:'Key Replace',     category:'fee',      icon:'🔑', sell_price:25.00, cost_price:5.00,  tax_rate:0,   stock_qty:10, stock_min:3,  stock_max:20 },
  { name:'Pool Pass Day',   category:'amenity',  icon:'🏊', sell_price:5.00,  cost_price:0,     tax_rate:0,   stock_qty:999,stock_min:999,stock_max:999 },
  { name:'Early Check-in',  category:'amenity',  icon:'🌅', sell_price:35.00, cost_price:0,     tax_rate:.08, stock_qty:999,stock_min:999,stock_max:999, charge_eligible:false },
  { name:'Late Checkout',   category:'amenity',  icon:'🌆', sell_price:35.00, cost_price:0,     tax_rate:.08, stock_qty:999,stock_min:999,stock_max:999, charge_eligible:false },
  { name:'Pet Fee Daily',   category:'fee',      icon:'🐾', sell_price:15.00, cost_price:0,     tax_rate:0,   stock_qty:999,stock_min:999,stock_max:999 },
  { name:'Cleaning Fee',    category:'fee',      icon:'🧹', sell_price:85.00, cost_price:25.00, tax_rate:.08, stock_qty:999,stock_min:999,stock_max:999, charge_eligible:false },
]

// ── ITEMS ─────────────────────────────────────────────────────

// GET /api/pos/items
posRouter.get('/items', requireLandlord, async (req, res, next) => {
  try {
    let items = await query<any>('SELECT * FROM pos_items WHERE landlord_id=$1 AND is_active=TRUE ORDER BY category, name', [req.user!.profileId])

    // Seed defaults if none exist
    if (items.length === 0) {
      for (const item of DEFAULT_ITEMS) {
        await query(`INSERT INTO pos_items (landlord_id,name,category,icon,sell_price,cost_price,tax_rate,stock_qty,stock_min,stock_max,charge_eligible,margin_pct)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,ROUND((($5-$6)/$5)*100,2))`,
          [req.user!.profileId, item.name, item.category, item.icon, item.sell_price,
           item.cost_price, item.tax_rate, item.stock_qty, item.stock_min, item.stock_max,
           item.charge_eligible ?? true])
      }
      items = await query<any>('SELECT * FROM pos_items WHERE landlord_id=$1 AND is_active=TRUE ORDER BY category, name', [req.user!.profileId])
    }

    res.json({ success: true, data: items })
  } catch (e) { next(e) }
})

// POST /api/pos/items
posRouter.post('/items', requireLandlord, async (req, res, next) => {
  try {
    const { name, category, icon, costPrice, sellPrice, marginPct, taxRate,
            chargeEligible, stockQty, stockMin, stockMax, vendorId, shelfLabelEnabled } = req.body

    const margin = marginPct ?? (costPrice > 0 ? ((sellPrice - costPrice) / sellPrice) * 100 : null)

    const item = await queryOne<any>(`INSERT INTO pos_items
      (landlord_id,name,category,icon,cost_price,sell_price,margin_pct,tax_rate,charge_eligible,stock_qty,stock_min,stock_max,vendor_id,shelf_label_enabled)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [req.user!.profileId, name, category||'misc', icon||'📦', costPrice||0, sellPrice,
       margin, taxRate||0, chargeEligible??true, stockQty||0, stockMin||5, stockMax||50,
       vendorId||null, shelfLabelEnabled??true])

    res.status(201).json({ success: true, data: item })
  } catch (e) { next(e) }
})

// PATCH /api/pos/items/:id
posRouter.patch('/items/:id', requireLandlord, async (req, res, next) => {
  try {
    const item = await queryOne<any>('SELECT * FROM pos_items WHERE id=$1 AND landlord_id=$2', [req.params.id, req.user!.profileId])
    if (!item) throw new AppError(404, 'Item not found')

    const { name, category, icon, costPrice, sellPrice, marginPct, taxRate,
            chargeEligible, stockMin, stockMax, vendorId, isActive } = req.body

    // Track price history
    const newSellPrice = sellPrice ?? item.sell_price
    const newCostPrice = costPrice ?? item.cost_price
    if (newSellPrice !== item.sell_price || newCostPrice !== item.cost_price) {
      await query(`INSERT INTO pos_price_history (item_id, old_price, new_price, old_cost, new_cost, changed_by)
        VALUES ($1,$2,$3,$4,$5,$6)`,
        [item.id, item.sell_price, newSellPrice, item.cost_price, newCostPrice, req.user!.userId])
    }

    const newMargin = marginPct ?? (newCostPrice > 0 ? ((newSellPrice - newCostPrice) / newSellPrice) * 100 : item.margin_pct)

    const updated = await queryOne<any>(`UPDATE pos_items SET
      name=$1, category=$2, icon=$3, cost_price=$4, sell_price=$5, margin_pct=$6,
      tax_rate=$7, charge_eligible=$8, stock_min=$9, stock_max=$10, vendor_id=$11,
      is_active=$12, updated_at=NOW() WHERE id=$13 RETURNING *`,
      [name??item.name, category??item.category, icon??item.icon,
       newCostPrice, newSellPrice, newMargin,
       taxRate??item.tax_rate, chargeEligible??item.charge_eligible,
       stockMin??item.stock_min, stockMax??item.stock_max,
       vendorId??item.vendor_id, isActive??item.is_active, item.id])

    res.json({ success: true, data: updated })
  } catch (e) { next(e) }
})

// POST /api/pos/items/:id/adjust-stock
posRouter.post('/items/:id/adjust-stock', requireLandlord, async (req, res, next) => {
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
posRouter.get('/items/:id/shelf-label', async (req, res, next) => {
  try {
    const item = await queryOne<any>('SELECT id,name,sell_price,tax_rate,icon,category,stock_qty FROM pos_items WHERE id=$1 AND is_active=TRUE', [req.params.id])
    if (!item) throw new AppError(404, 'Item not found')
    res.json({ success: true, data: item })
  } catch (e) { next(e) }
})

// ── TRANSACTIONS ──────────────────────────────────────────────

// POST /api/pos/transactions — record completed sale
posRouter.post('/transactions', requireLandlord, async (req, res, next) => {
  try {
    const { items, paymentMethod, tenantId, subtotal, taxAmount, surcharge, total, changeGiven } = req.body

    const platformFee = paymentMethod === 'charge' ? subtotal * 0.01 : 0

    const tx = await queryOne<any>(`INSERT INTO pos_transactions
      (landlord_id,tenant_id,cashier_id,payment_method,subtotal,tax_amount,surcharge,total,change_given,platform_fee)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [req.user!.profileId, tenantId||null, req.user!.userId,
       paymentMethod, subtotal, taxAmount||0, surcharge||0, total, changeGiven||0, platformFee])

    // Insert line items and decrement stock
    for (const item of items) {
      const dbItem = item.id ? await queryOne<any>('SELECT * FROM pos_items WHERE id=$1', [item.id]) : null

      await query(`INSERT INTO pos_transaction_items
        (transaction_id,item_id,item_name,item_category,qty,unit_price,cost_price,tax_rate,subtotal)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [tx!.id, item.id||null, item.name, item.cat||item.category||'misc',
         item.qty, item.price, dbItem?.cost_price||0, item.tax||item.tax_rate||0,
         item.price * item.qty])

      // Decrement stock if tracked (not 999)
      if (dbItem && dbItem.stock_qty < 999) {
        const newQty = Math.max(0, dbItem.stock_qty - item.qty)
        await query('UPDATE pos_items SET stock_qty=$1, updated_at=NOW() WHERE id=$2', [newQty, dbItem.id])
        await query(`INSERT INTO pos_inventory_log (item_id,landlord_id,change_qty,reason,reference_id,stock_before,stock_after)
          VALUES ($1,$2,$3,'sale',$4,$5,$6)`,
          [dbItem.id, req.user!.profileId, -item.qty, tx!.id, dbItem.stock_qty, newQty])

        // Auto-draft PO if stock hits minimum
        if (newQty <= dbItem.stock_min && dbItem.vendor_id) {
          await autoDraftPO(req.user!.profileId, dbItem)
        }
      }
    }

    res.status(201).json({ success: true, data: tx })
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

    console.log(`[POS] Auto-drafted PO ${po!.po_number} for ${item.name} (${reorderQty} units)`)
  } catch (e) {
    console.error('[POS] Auto-draft PO error:', e)
  }
}

// GET /api/pos/transactions/sales — sales analytics
posRouter.get('/transactions/sales', requireLandlord, async (req, res, next) => {
  try {
    const { period = 'today' } = req.query

    const dateFilter = period === 'today'
      ? `AND DATE(created_at) = CURRENT_DATE`
      : period === 'week'
        ? `AND created_at >= CURRENT_DATE - INTERVAL '7 days'`
        : `AND created_at >= CURRENT_DATE - INTERVAL '30 days'`

    // By hour (today only)
    const byHour = await query<any>(`
      SELECT EXTRACT(HOUR FROM created_at)::int as hour,
        COUNT(*) as tx_count,
        SUM(total) as revenue
      FROM pos_transactions
      WHERE landlord_id=$1 AND DATE(created_at) = CURRENT_DATE
      GROUP BY hour ORDER BY hour`, [req.user!.profileId])

    // By day
    const byDay = await query<any>(`
      SELECT DATE(created_at) as date,
        COUNT(*) as tx_count,
        SUM(total) as revenue,
        SUM(CASE WHEN payment_method='cash' THEN total ELSE 0 END) as cash,
        SUM(CASE WHEN payment_method='card' THEN total ELSE 0 END) as card,
        SUM(CASE WHEN payment_method='charge' THEN total ELSE 0 END) as charge
      FROM pos_transactions
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
      FROM pos_transactions
      WHERE landlord_id=$1 ${dateFilter}`, [req.user!.profileId])

    res.json({ success: true, data: { summary, byHour, byDay, topItems, byCategory } })
  } catch (e) { next(e) }
})

// ── VENDORS ───────────────────────────────────────────────────

posRouter.get('/vendors', requireLandlord, async (req, res, next) => {
  try {
    const vendors = await query<any>('SELECT * FROM pos_vendors WHERE landlord_id=$1 ORDER BY name', [req.user!.profileId])
    res.json({ success: true, data: vendors })
  } catch (e) { next(e) }
})

posRouter.post('/vendors', requireLandlord, async (req, res, next) => {
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

posRouter.patch('/vendors/:id', requireLandlord, async (req, res, next) => {
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

posRouter.get('/purchase-orders', requireLandlord, async (req, res, next) => {
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

posRouter.patch('/purchase-orders/:id', requireLandlord, async (req, res, next) => {
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
    if (status === 'received') {
      const items = await query<any>('SELECT * FROM pos_purchase_order_items WHERE po_id=$1', [po.id])
      for (const item of items) {
        if (!item.item_id) continue
        const dbItem = await queryOne<any>('SELECT * FROM pos_items WHERE id=$1', [item.item_id])
        if (!dbItem) continue
        const newQty = dbItem.stock_qty + item.qty_ordered
        await query('UPDATE pos_items SET stock_qty=$1, updated_at=NOW() WHERE id=$2', [newQty, item.item_id])
        await query(`INSERT INTO pos_inventory_log (item_id,landlord_id,change_qty,reason,reference_id,stock_before,stock_after)
          VALUES ($1,$2,$3,'po_received',$4,$5,$6)`,
          [item.item_id, req.user!.profileId, item.qty_ordered, po.id, dbItem.stock_qty, newQty])
      }
    }

    res.json({ success: true, data: updated })
  } catch (e) { next(e) }
})

// GET /api/pos/low-stock — items at or below min
posRouter.get('/low-stock', requireLandlord, async (req, res, next) => {
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

const DEFAULT_CATEGORIES = [
  { name:'Fuel', icon:'⛽', sort_order:1 },
  { name:'Amenity', icon:'🏊', sort_order:2 },
  { name:'Laundry', icon:'🧺', sort_order:3 },
  { name:'Parking', icon:'🅿️', sort_order:4 },
  { name:'Fee', icon:'📋', sort_order:5 },
  { name:'Misc', icon:'📦', sort_order:6 },
]

posRouter.get('/categories', requireLandlord, async (req, res, next) => {
  try {
    let cats = await query('SELECT * FROM pos_categories WHERE landlord_id=$1 AND is_active=TRUE ORDER BY sort_order, name', [req.user.profileId])
    if (cats.length === 0) {
      for (const cat of DEFAULT_CATEGORIES) {
        await query('INSERT INTO pos_categories (landlord_id,name,icon,sort_order) VALUES ($1,$2,$3,$4)', [req.user.profileId, cat.name, cat.icon, cat.sort_order])
      }
      cats = await query('SELECT * FROM pos_categories WHERE landlord_id=$1 ORDER BY sort_order, name', [req.user.profileId])
    }
    res.json({ success: true, data: cats })
  } catch (e) { next(e) }
})

posRouter.post('/categories', requireLandlord, async (req, res, next) => {
  try {
    const { name, icon, sortOrder } = req.body
    const cat = await queryOne('INSERT INTO pos_categories (landlord_id,name,icon,sort_order) VALUES ($1,$2,$3,$4) RETURNING *', [req.user.profileId, name, icon||'📦', sortOrder||0])
    res.status(201).json({ success: true, data: cat })
  } catch (e) { next(e) }
})

posRouter.patch('/categories/:id', requireLandlord, async (req, res, next) => {
  try {
    const { name, icon, sortOrder, isActive } = req.body
    const cat = await queryOne('SELECT * FROM pos_categories WHERE id=$1 AND landlord_id=$2', [req.params.id, req.user.profileId])
    if (!cat) { res.status(404).json({ success: false, error: 'Not found' }); return }
    const updated = await queryOne('UPDATE pos_categories SET name=$1,icon=$2,sort_order=$3,is_active=$4 WHERE id=$5 RETURNING *', [name||cat.name, icon||cat.icon, sortOrder||cat.sort_order, isActive!==undefined?isActive:cat.is_active, cat.id])
    res.json({ success: true, data: updated })
  } catch (e) { next(e) }
})

posRouter.delete('/categories/:id', requireLandlord, async (req, res, next) => {
  try {
    await query('UPDATE pos_categories SET is_active=FALSE WHERE id=$1 AND landlord_id=$2', [req.params.id, req.user.profileId])
    res.json({ success: true })
  } catch (e) { next(e) }
})

// ── VARIANTS ──────────────────────────────────────────────────

posRouter.get('/items/:id/variants', requireLandlord, async (req, res, next) => {
  try {
    const variants = await query('SELECT * FROM pos_item_variants WHERE item_id=$1 AND is_active=TRUE ORDER BY sort_order, sell_price', [req.params.id])
    res.json({ success: true, data: variants })
  } catch (e) { next(e) }
})

posRouter.post('/items/:id/variants', requireLandlord, async (req, res, next) => {
  try {
    const { name, costPrice, sellPrice, stockQty, stockMin, sortOrder } = req.body
    const item = await queryOne('SELECT * FROM pos_items WHERE id=$1 AND landlord_id=$2', [req.params.id, req.user.profileId])
    if (!item) { res.status(404).json({ success: false, error: 'Not found' }); return }
    await query('UPDATE pos_items SET has_variants=TRUE WHERE id=$1', [item.id])
    const variant = await queryOne('INSERT INTO pos_item_variants (item_id,name,cost_price,sell_price,stock_qty,stock_min,sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *', [item.id, name, costPrice||0, sellPrice, stockQty||0, stockMin||5, sortOrder||0])
    res.status(201).json({ success: true, data: variant })
  } catch (e) { next(e) }
})

posRouter.patch('/items/:id/variants/:variantId', requireLandlord, async (req, res, next) => {
  try {
    const { name, costPrice, sellPrice, stockQty, stockMin, isActive } = req.body
    const v = await queryOne('SELECT * FROM pos_item_variants WHERE id=$1 AND item_id=$2', [req.params.variantId, req.params.id])
    if (!v) { res.status(404).json({ success: false, error: 'Not found' }); return }
    const updated = await queryOne('UPDATE pos_item_variants SET name=$1,cost_price=$2,sell_price=$3,stock_qty=$4,stock_min=$5,is_active=$6,updated_at=NOW() WHERE id=$7 RETURNING *', [name||v.name, costPrice||v.cost_price, sellPrice||v.sell_price, stockQty||v.stock_qty, stockMin||v.stock_min, isActive!==undefined?isActive:v.is_active, v.id])
    res.json({ success: true, data: updated })
  } catch (e) { next(e) }
})

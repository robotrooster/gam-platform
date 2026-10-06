import { Router } from 'express'
import { z } from 'zod'
import { insertPosSale } from '../services/posSale'
import { recordSaleTowardStay } from '../services/stayPayments'
import { cardFeeSplit, STAY_TERMS, STAY_SCREENING_NIGHTS, STAY_LEASE_CHOICE_NIGHTS, stayHeldWords, type CardFeePayer, type StayTerms } from '@gam/shared'

const round2 = (n: number) => Math.round(n * 100) / 100
import { db, query, queryOne, getClient } from '../db'
import { requireAuth, requirePerm, assertPropertyInScope, getScopedPropertyIds } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { calculateCartTax, computeCartTotals, aggregateCartTotals, effectiveItemTaxes } from '../services/posTax'
import { holdForTheCart, createConnectionToken, registerReader, listReaders, archiveReader, createCardPresentPaymentIntent, processPaymentIntentOnReader, captureTerminalPaymentIntent, cancelTerminalPaymentIntent, retrieveTerminalPaymentIntent, cancelReaderAction, showCartOnReader, clearCartOnReader, readerAction, retrieveTerminalPaymentIntentWithCharge } from '../services/posTerminal'
import crypto from 'crypto'
import { DateTime } from 'luxon'
import { logger } from '../lib/logger'
import { todayIn } from '../lib/timezone'
import { replyToProperty } from '../services/replyRouting'
import { resolveLandlordTarget, ownsLandlord, landlordScopeIds } from '../lib/landlordScope'
import { cardIdentityFromIntent, findOrCreateCustomerForCard, startSaveCardPrompt, readSaveCardAnswer, saveCardForCustomer, mergePosCustomers, readSaleCard, type CardIdentity, type CardCustomer } from '../services/posCustomerCards'
import {
  personOnSale, salePerson, nameForReader, residentRecord, applyCardToPerson, withSavepoint, cardOutcomeSentence, addCustomer, customerFromElsewhere,
  findSamePerson, standInNow, foldStandInInto, recordContactSql, tenantOfCompanySql, tenantLivesHereSql, NOT_ON_REGISTER, SALE_GONE,
  parseForStaff, cartLineWords, lowerLineIds, assertItemsAreOurs, assertWholeStays,
  linkSaleToPerson, undoLink, saleTimeUndo, letGoOfPick, searchPeople, peopleQueryGuard, peopleSearchLimiter, crossCompanyLimiter,
  type CardOutcome, type LinkTarget, type StandIn,
} from '../services/posPeople'
import { reservationDue, releaseReservationTickets, ticketCarriesStay, stayItemIdsIn, stayTaxRate, taxInsidePayment, checkOutFor,
  priceWholeStay, wholeStayPrice, leaseDepositFor, stayExtensionQuote, extendStayByMonth, payTowardStay, SCREENING_LINE_NAME,
  type ReservationDue, type StayExtension } from '../services/registerStay'
import { stayNeeds, recordScreeningPrepayment, markScreeningRequired, chooseStayTerms, screeningCollectedBy, continuousStayNights, screeningPaidForStay, canAttestReturningGuest, attestReturningGuest, RETURNING_GUEST_NOT_ALLOWED, type StayNeeds } from '../services/stayTerms'
import {
  LINK_PAID_ONLINE, LINK_PAGE_STUCK, reservationNoDiscountWords, reservationPaidWords, reservationWhat, reservationLineName,
  closeLinkPageNow, closeOtherLinkCheckouts, closeIfPaidInFull, expireClosedLinks, linkOpenedMeanwhileWords,
  linkStayOf, linkBookingLines, assertLinkBookingLinesKept, linkReservation, linkReservationLine, linkReservationNowWords,
  linkAsksNow, linkReservationGoneWords, settleLinkBooking, closeStaleLinkPages, assertLinkStayWhole, linkStayNightsNowWords,
  reservationSaleLine, withLodgingTax, linkStayAsSent, tellLandlordIfLeftOwed,
  linkScreeningLine, isScreeningLine, recordLinkScreening, afterLinkPaid, feeOnlyLinkNotPayable,
  type ClosedLink, type PagesClosed, type LinkReservation,
} from './posPayLinks'

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

/**
 * 10/2: a sale is acted on only by somebody assigned to its property. Refund,
 * void, receipt email and the customer link all load a sale by id; the company
 * check alone let a cashier scoped to one park reach another park's sales of
 * the same company. A sale with no property (before W-12) is an owner's.
 */
async function assertSaleInScope(user: any, propertyId: string | null | undefined): Promise<void> {
  if (propertyId) return assertPropertyInScope(user, propertyId)
  if ((await getScopedPropertyIds(user)) !== null) throw new AppError(403, 'You are not assigned to this property')
}

/** What a list of sales is limited to for this caller: one property, their properties, or everything. */
async function salesScope(req: any): Promise<{ propertyId: string | null; scoped: string[] | null }> {
  const propertyId = req.query?.propertyId ? String(req.query.propertyId) : null
  if (propertyId) { await assertPropertyInScope(req.user, propertyId); return { propertyId, scoped: null } }
  return { propertyId: null, scoped: await getScopedPropertyIds(req.user) }
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

/** 10/5 (A5): what the clerk is told when a background check is rung on a charge account. */
const CHARGE_ACCOUNT_NO_SCREENING = 'A background check cannot go on a charge account — it is paid when the stay is sold. '
  + 'Take cash, a check or a card for this sale, then press Charge again. Nothing was charged.'
/** 10/5 (A5): a check recorded for the stay a moment ago, by another payment — this sale is not taken. */
const SCREENING_PAID_MEANWHILE = 'This guest\'s background check was paid a moment ago some other way — nothing was charged here. '
  + 'Press Clear, then open the stay or ticket again.'

/** A cart line that is a ticket's or link's background-check line: the same name and fee, one of it. */
function isScreeningCartLine(it: any, own: { name: string; price: number }): boolean {
  return !it?.id && String(it?.name ?? '') === own.name
    && Math.round((Number(it?.price) || 0) * 100) === Math.round(own.price * 100) && Number(it?.qty) === 1
}

/**
 * 10/5 (Nic, M2): the background-check line on a ticket the schedule handed
 * the till (a reservation's ticket — booking_id), as the server wrote it.
 * Null for any other ticket.
 */
async function ticketScreeningOf(landlordId: string, ticketId: unknown): Promise<{ name: string; price: number; bookingId: string } | null> {
  if (typeof ticketId !== 'string' || !/^[0-9a-f-]{36}$/i.test(ticketId)) return null
  const t = await queryOne<{ booking_id: string | null; items: any }>(
    `SELECT booking_id, items FROM pos_open_tickets WHERE id = $1 AND landlord_id = $2`, [ticketId, landlordId])
  if (!t?.booking_id) return null
  const l = (Array.isArray(t.items) ? t.items : []).find(isScreeningLine)
  if (!l || !(Number(l.price) > 0)) return null
  // 10/5 (M3): the check was paid another way since the ticket was written (a
  // link, another leg of the stay) — one fee per stay, never two. The line
  // comes off the ticket and the clerk opens it again; nothing is charged.
  if (await screeningPaidForStay(t.booking_id)) {
    await query(
      `UPDATE pos_open_tickets SET items = $2::jsonb, updated_at = NOW() WHERE id = $1 AND status = 'open'`,
      [ticketId, JSON.stringify((t.items as any[]).filter((i) => !isScreeningLine(i)))])
    throw new AppError(409, 'This guest\'s background check is already paid, so it was taken off this ticket — nothing was charged. '
      + 'Press Clear, open the ticket again, then press Charge.')
  }
  return { name: String(l.name ?? SCREENING_LINE_NAME), price: round2(Number(l.price) || 0), bookingId: t.booking_id }
}

/** The background-check line a reservation ticket carries, exactly as the schedule wrote it (or null). */
async function ticketScreeningLineAsWritten(landlordId: string, ticketId: unknown): Promise<any | null> {
  if (typeof ticketId !== 'string' || !/^[0-9a-f-]{36}$/i.test(ticketId)) return null
  const t = await queryOne<{ booking_id: string | null; items: any }>(
    `SELECT booking_id, items FROM pos_open_tickets WHERE id = $1 AND landlord_id = $2`, [ticketId, landlordId])
  if (!t?.booking_id) return null
  return (Array.isArray(t.items) ? t.items : []).find(isScreeningLine) ?? null
}
/** A placeholder id that only stands in while a ticket's form is read (never written). */
const ZERO_UUID = '00000000-0000-4000-8000-000000000000'

/** A background check already recorded for this stay (not void) — its fee is not GAM's a second time. */
async function screeningAlreadyPaid(bookingId: string): Promise<boolean> {
  return !!(await queryOne(`SELECT 1 FROM screening_prepayments WHERE booking_id = $1 AND status <> 'void'`, [bookingId]))
}

/**
 * 10/2 (front desk foolproof): a cart line whose price or tax is below zero
 * (or not a number) is refused in the clerk's words, with the button to press —
 * the same words a ticket or a pay link uses (cartLineWords). 10/2 (review): a
 * quantity has to be ABOVE zero, as the words say — a line of nothing reached
 * the database's own check and put a raw 500 on the clerk's screen.
 */
function assertCartNumbers(items: any[], press: string): void {
  const words = cartLineWords(press)
  const bad = (v: unknown) => v !== undefined && v !== null && v !== '' && !(Number.isFinite(Number(v)) && Number(v) >= 0)
  const badQty = (v: unknown) => typeof v === 'boolean' || !(Number.isFinite(Number(v)) && Number(v) > 0)
  for (const it of items) {
    if (badQty(it?.qty)) throw new AppError(400, words['items.N.qty'])
    if (bad(it?.price)) throw new AppError(400, words['items.N.price'])
    if (bad(it?.tax ?? it?.tax_rate)) throw new AppError(400, words['items.N.tax'])
  }
}

/**
 * 10/2 (review): settling a pay link, a cart line that is a STAY must be one of
 * the link's own stay lines — the same item at the same price, and no more
 * nights than the link carries. The link's stay was priced from its site and
 * the site held when it was sent; anything else that is a stay has no site and
 * no dates, and a price nobody checked (stays are not held to the catalog —
 * the site decides). Extra nights are rung as their own stay.
 */
async function assertStaysAreTheLinks(landlordId: string, items: any[], payLink: any): Promise<void> {
  // 10/2 (review): compared lowercase, as the database writes ids — an id sent
  // in capitals is the same stay, not a line to skip.
  const ids = [...new Set(items.map((it: any) => lowerId(it?.id)).filter((x) => /^[0-9a-f-]{36}$/.test(x)))]
  if (!ids.length) return
  const stays = await query<{ id: string; name: string }>(
    `SELECT id, name FROM pos_items WHERE id = ANY($1::uuid[]) AND landlord_id = $2 AND stay_unit IS NOT NULL`, [ids, landlordId])
  if (!stays.length) return
  const left = linkLineQty(payLink)
  for (const it of items) {
    const s = stays.find((x) => x.id === lowerId(it?.id))
    if (!s) continue
    const k = priceKey(it.id, it.price)
    const have = left.get(k) ?? 0
    const q = Number(it.qty) || 0
    if (have <= 0 || q > have + 1e-9) {
      throw new AppError(400, `"${s.name}" in the cart is not the stay on this pay link — nothing was charged. `
        + 'Put that line back the way the link had it (or take it out), then press Charge; ring any extra nights on their own, with a site and dates.')
    }
    left.set(k, have - q)
  }
}

/** A register item id as the database writes it (lowercase), or '' for none. */
const lowerId = (x: unknown): string => (typeof x === 'string' ? x.trim().toLowerCase() : '')

export function canSetPrices(user: any): boolean {
  if (!user) return false
  if (['admin', 'super_admin', 'landlord'].includes(user.role)) return true
  const perms = user.permissions || {}
  return perms['pos.discount'] === true || perms['pos.manage_inventory'] === true
}
/**
 * 10/2 (review): a pay link's own terms — the prices on its lines and the
 * discount it was sent with — were set when it was sent. A cashier settling it
 * at the counter is not setting a price or giving a discount, so those are not
 * held to the cashier's pricing rule (without this, a cashier could not settle
 * a discounted link at all). Anything the cashier changes still is.
 */
/**
 * `lines`: how many of each (item, price) the link carries — the most of that
 * line a cashier settles on the link's word. `discount`: the link's own
 * discount; settling for that much off, or less, is the link's terms.
 */
type LinkTerms = { lines: Map<string, number>; discount: number }
const priceKey = (itemId: unknown, price: unknown) => `${lowerId(itemId)}:${(Number(price) || 0).toFixed(2)}`
/** How many of each (item, price) a link's lines carry. Lines with no register item are keyed by none. */
function linkLineQty(link: any): Map<string, number> {
  const out = new Map<string, number>()
  for (const l of (Array.isArray(link?.items) ? link.items : [])) {
    if (!l?.id) continue
    const k = priceKey(l.id, l.price)
    out.set(k, (out.get(k) ?? 0) + (Number(l.qty) || 0))
  }
  return out
}
function termsOfLink(link: any): LinkTerms {
  return { lines: linkLineQty(link), discount: Math.max(0, Number(link?.discount_amount) || 0) }
}

/**
 * 10/2 (review): how much of a pay link's own lines this cart keeps, by value
 * — 1 when it keeps every one. Lines are matched the way the counter matches
 * them: a register line by (item, price), a typed line by (name, price); a cart
 * keeps at most as many of each as the link carries.
 */
export function linkShareKept(link: any, items: any[]): number {
  const key = (l: any) => (l?.id ? `i:${priceKey(l.id, l.price)}` : `t:${String(l?.name ?? '')}|${(Number(l?.price) || 0).toFixed(2)}`)
  const sent = new Map<string, { qty: number; price: number }>()
  for (const l of (Array.isArray(link?.items) ? link.items : [])) {
    const e = sent.get(key(l)) ?? { qty: 0, price: Number(l?.price) || 0 }
    e.qty += Number(l?.qty) || 0
    sent.set(key(l), e)
  }
  const kept = new Map<string, number>()
  for (const it of (Array.isArray(items) ? items : [])) kept.set(key(it), (kept.get(key(it)) ?? 0) + Math.max(0, Number(it?.qty) || 0))
  let whole = 0, keptValue = 0
  sent.forEach((e, k) => { whole += e.qty * e.price; keptValue += Math.min(e.qty, kept.get(k) ?? 0) * e.price })
  return whole > 0 ? Math.min(1, keptValue / whole) : 1
}

/**
 * 10/2 (review): a link's discount was given for the WHOLE order. Settled (or
 * adjusted) with every one of its lines it is the link's own; with only some of
 * them, only that share of it is — a manager's $50 off ten tanks is $15 off
 * three, never $50 off three (that was more off than anybody authorized: the
 * clamp at the subtotal let a smaller cart come to $0).
 */
export function linkDiscountFor(link: any, items: any[]): number {
  const d = Math.max(0, Number(link?.discount_amount) || 0)
  return d > 0 ? round2(d * linkShareKept(link, items)) : 0
}

/** The link's own terms for THIS cart: its lines, and its discount for the share of it kept (linkDiscountFor). */
export function termsOfLinkFor(link: any, items: any[]): LinkTerms {
  return { lines: linkLineQty(link), discount: linkDiscountFor(link, items) }
}

/** What a clerk without "Apply discounts" is told when a link's discount outlives the lines it was for. */
export const linkDiscountWholeWords = (press: string) =>
  `The link's discount was for the whole order — put back the lines you took out, or ask a manager to change the discount, then press ${press} again.`

/**
 * True when a clerk who may not set prices is carrying MORE of a link's own
 * discount than the share of the link they kept (and no more than the link's
 * whole discount — beyond that it is simply a discount of their own).
 */
export function carriesLinkDiscountPastShare(user: any, link: any, items: any[], discount: unknown): boolean {
  if (canSetPrices(user)) return false
  const whole = Math.max(0, Number(link?.discount_amount) || 0)
  const d = Number(discount) || 0
  return whole > 0 && d > linkDiscountFor(link, items) + 0.005 && d <= whole + 0.005
}
/**
 * The reader's breakdown names no pay link (it shows a cart), so for a cashier
 * putting a link up its terms are read from this property's open links. Only
 * the breakdown relies on this; the sale itself is checked against the one
 * link it settles.
 */
async function termsOfOpenLinks(landlordId: string, propertyId: string): Promise<LinkTerms> {
  const links = await query<{ items: any; discount_amount: string }>(
    `SELECT items, discount_amount FROM pos_pay_links
      WHERE landlord_id = $1 AND property_id = $2 AND kind = 'one_time' AND status = 'open'
        AND (expires_at IS NULL OR expires_at > NOW())`, [landlordId, propertyId])
  const out: LinkTerms = { lines: new Map(), discount: 0 }
  for (const l of links) {
    const t = termsOfLink(l)
    t.lines.forEach((q, k) => out.lines.set(k, Math.max(out.lines.get(k) ?? 0, q)))
    out.discount = Math.max(out.discount, t.discount)
  }
  return out
}
/**
 * The lines and discount a cashier is answerable for — the link's own terms
 * taken out. 10/2 (review): only as MUCH of a line as the link carries — a
 * link for one tank at a special price does not make a hundred tanks at that
 * price the link's; the rest is the cashier's, held to their pricing rule. A
 * discount up to the link's own is the link's; more than that is theirs.
 */
export function cashiersOwn(lines: { itemId?: any; price: any; qty?: any }[], discount: any, terms: LinkTerms | null): { lines: { itemId?: any; price: any }[]; discount: any } {
  if (!terms) return { lines, discount }
  const left = new Map(terms.lines)
  const own = lines.filter((l) => {
    const k = priceKey(l.itemId, l.price)
    const have = left.get(k) ?? 0
    const q = Number(l.qty) || 0
    if (have > 0 && q <= have + 1e-9) { left.set(k, have - q); return false }
    return true
  })
  const d = Number(discount) || 0
  return { lines: own, discount: d <= terms.discount + 0.005 ? 0 : discount }
}

/**
 * 10/2 (review): every line naming a register item is checked — compared
 * lowercase, as the database writes ids, and a line naming no item of this
 * company's is REFUSED, never skipped. (An id sent in capitals used to miss
 * every check keyed by the database's id while the sale still found the item:
 * a $20 tank rang at a penny.) A line with no register item at all is the
 * caller's to judge — a pay link's own typed line, or a refusal of its own.
 * `press`: the button the clerk presses again.
 */
export async function assertCashierPricing(req: any, lines: { itemId?: string | null; price: any }[],
                                    discountAmount?: any, landlordId?: string, press = 'Charge'): Promise<void> {
  if (canSetPrices(req.user)) return
  if (Number(discountAmount) > 0) {
    throw new AppError(403, 'Discounts need the "Apply discounts" permission — ask the owner or a manager.')
  }
  const own = lines.map((l) => ({ ...l, itemId: l.itemId == null || l.itemId === '' ? null : lowerId(l.itemId) }))
  const ids = [...new Set(own.map((l) => l.itemId).filter((x): x is string => !!x && /^[0-9a-f-]{36}$/.test(x)))]
  if (!own.some((l) => l.itemId)) return
  const rows = ids.length ? await query<{ id: string; prices: string[]; stay_unit: string | null }>(
    `SELECT i.id, i.stay_unit, ARRAY[i.sell_price::text] || COALESCE(
              (SELECT array_agg(v.sell_price::text) FROM pos_item_variants v
                WHERE v.item_id = i.id AND v.is_active = TRUE), '{}') AS prices
       FROM pos_items i WHERE i.id = ANY($1::uuid[]) AND i.landlord_id = $2`,
    [ids, landlordId ?? posLandlordId(req)]) : []
  const allowed = new Map(rows.map((r) => [r.id, r.prices.map(Number)]))
  // S652: a stay is not priced from the catalog — the site's rate card decides,
  // and the server sets it. Holding a cashier to the item's sell_price here
  // would refuse every stay, since the two are not the same number and are not
  // meant to be. Nothing is loosened: the price the browser sent for a stay is
  // discarded and replaced before anything is totaled.
  const stayItems = new Set(rows.filter((r) => r.stay_unit).map((r) => r.id))
  for (const l of own) {
    if (!l.itemId) continue
    if (!allowed.has(l.itemId)) throw new AppError(400, cartLineWords(press)['items.N.id'])
    if (stayItems.has(l.itemId)) continue
    const price = Number(l.price)
    if (!allowed.get(l.itemId)!.some((p) => Math.abs(p - price) < 0.005)) {
      throw new AppError(403, `That price differs from the item's price — take the line out and add it again at the register's price, then press ${press} again. Changing a price needs the "Apply discounts" permission (ask the owner or a manager).`)
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
 *
 * 10/3 (decisions #9, #21) — AND IT COSTS WHAT THE SCHEDULE CHARGES FOR THOSE
 * NIGHTS. A stay rung straight at the counter was the item's rate × quantity
 * plus the stay ITEM's own tax, while the same nights on a pay link (and on the
 * schedule) were priced by the schedule's own pricing — tiered rates and the
 * property's lodging tax: seven nights at a park with a $231 week and 12%
 * lodging tax were $258.72 on "Send link" and $308.00 on "Charge" (7 × $40 +
 * the item's 10%). Now the site and arrival the cashier picked price it by
 * priceStayBySchedule, exactly as a link and the schedule do, and the stay is
 * ONE line at that price with its lodging tax inside it (RESERVATION_LINE,
 * STAY_TAX) — recorded split, the stay before tax and the lodging tax as tax,
 * as a reservation's line is. The quote, the card reader's charge and
 * breakdown, the sale and the booking (createStayBooking's lineTotal) all use
 * that one figure. The site and arrival come with the sale (`stay`) or ride on
 * the stay's own cart line (stayUnitId, stayCheckIn — the reader's calls carry
 * nothing else); a cart that shows the stay at another figure (stayTotal, the
 * register's own) is refused before any money moves — never charged a number
 * the cashier did not see. One with no figure of its own is charged the
 * schedule's (the browser's price for a stay is never used).
 *
 * 10/5 (Nic, R5) — EXCEPT THAT THE REGISTER NEVER PRORATES. "Point of sale
 * cannot prorate a stay": the figure is now whole nights, weeks or months at
 * the site's rate for one of them (registerStay priceWholeStay), not the
 * schedule's tiering — a month is the monthly rate, never cut into calendar
 * pieces. Everything above about one figure, shown and charged, still holds.
 */
interface CounterStayAt {
  unitId: string | null
  checkIn: string | null
  /** 10/5 (Nic, R7): the guest's email — whose back-to-back stays add up, and where a paid background check goes. */
  guestEmail: string | null
  /** 10/5 (Nic, R2): the counter's answer for a stay of 30+ nights — lease or no lease. */
  stayTerms: StayTerms | null
  /** 10/5 (Nic, R6): "Add a month" — the stay here now that the month lengthens. */
  extendBookingId: string | null
  /** 10/5 (Nic, R8): the background check's fee as the register shows it — refused when it is not the server's. */
  screeningFee: number | null
  /** 10/6 (Nic): "Returning guest — they've stayed with us before" — no background check (owner / a manager only). */
  returningGuest: boolean
}

/**
 * 10/3 (review): a stay rung at the counter whose site and dates are not
 * picked yet has no price. Set by priceCounterStay on that line (never read
 * from the cart); the card reader's breakdown leaves the line off — and out of
 * its total — rather than show the customer the item's catalog rate × nights
 * plus a tax Charge will never take.
 */
const UNPRICED_STAY = Symbol('stay not priced yet')

const strOrNull = (x: unknown): string | null => (typeof x === 'string' && x.trim() ? x.trim() : null)

/**
 * The site and arrival a stay is rung for — on the sale, else on the stay's
 * cart line (the card reader's calls carry only the cart). 10/5: with the
 * guest's email, the counter's lease answer, the stay a month is added to and
 * the background check's fee as shown, read the same two places.
 */
function counterStayAt(items: any[], stay: unknown): CounterStayAt | null {
  const s: any = stay && typeof stay === 'object' ? stay : null
  const line: any = (Array.isArray(items) ? items : []).find((i: any) =>
    (strOrNull(i?.stayUnitId) && strOrNull(i?.stayCheckIn)) || strOrNull(i?.stayExtend))
  const unitId = strOrNull(s?.unitId) ?? strOrNull(line?.stayUnitId)
  const checkIn = strOrNull(s?.checkIn) ?? strOrNull(line?.stayCheckIn)
  const extendBookingId = strOrNull(s?.extendBookingId) ?? strOrNull(line?.stayExtend)
  if (!(unitId && checkIn) && !extendBookingId) return null
  const terms = s?.stayTerms ?? line?.stayTerms
  const fee = s?.screeningFee ?? line?.screeningFee
  return {
    unitId, checkIn, extendBookingId,
    guestEmail: strOrNull(s?.guestEmail) ?? strOrNull(line?.stayEmail),
    stayTerms: (STAY_TERMS as readonly string[]).includes(terms) ? terms as StayTerms : null,
    screeningFee: fee == null || fee === '' || !Number.isFinite(Number(fee)) ? null : Number(fee),
    returningGuest: s?.returningGuest === true || line?.stayReturning === true,
  }
}

/** 10/6 (Nic): the returning-guest choice is the owner's or a manager's — refused in words for anyone else. */
function assertMayAttestReturning(req: any, at: CounterStayAt | null): void {
  if (at?.returningGuest && !canAttestReturningGuest(req.user)) throw new AppError(403, RETURNING_GUEST_NOT_ALLOWED)
}

/**
 * 10/3 (review): the stay's own cart line and the sale's `stay` say the same
 * site and arrival. The line's figure (stayTotal) was priced for ITS site and
 * dates; the booking is written for the sale's. Two different answers to
 * "which site?" are refused before any money moves — never charged for one
 * site and booked on another.
 */
function assertStayLineMatches(items: any[], stay: unknown, press: string): void {
  const s: any = stay
  if (!s || typeof s !== 'object') return
  for (const it of (Array.isArray(items) ? items : [])) {
    const lineUnit = typeof it?.stayUnitId === 'string' && it.stayUnitId ? String(it.stayUnitId).toLowerCase() : null
    const lineIn = typeof it?.stayCheckIn === 'string' && it.stayCheckIn ? String(it.stayCheckIn) : null
    if (!lineUnit && !lineIn) continue
    const unitDiffers = lineUnit && typeof s.unitId === 'string' && s.unitId && lineUnit !== String(s.unitId).toLowerCase()
    const dayDiffers = lineIn && typeof s.checkIn === 'string' && s.checkIn && lineIn !== String(s.checkIn)
    if (unitDiffers || dayDiffers) {
      throw new AppError(409, 'The stay in the cart was priced for another site or arrival date than the one picked — nothing was charged. '
        + `Tap the site and dates above Charge, press Use this site, then press ${press} again.`)
    }
  }
}

/** What the clerk is told when the cart shows a stay at another figure than its nights cost. */
const counterStayNowWords = (what: string, total: number, press: string) =>
  `This stay — ${what} — comes to ${money(total)} — the cart shows something else, and nothing was charged. `
  + `Tap the site and dates above Charge, press Use this site, then press ${press} again.`

/**
 * 10/3 (review, decisions #9): a stay rung at the counter is charged the
 * schedule's price, like a reservation ticket or link — never less a register
 * discount. A discount on a cart with a stay in it took dollars off what was
 * collected while the sale still recorded the whole lodging tax and the
 * booking was written, and stamped paid, at the full price nobody paid.
 */
export const counterStayNoDiscountWords = (press: string) =>
  `A stay is charged at the schedule's price — take the discount off, then press ${press} again. `
  + 'To charge less for the stay, change its price on the schedule; to discount other items, ring them on a sale of their own.'

/**
 * 10/5 (Nic) — WHAT A STAY RUNG AT THE COUNTER COMES TO, AND WHAT IT NEEDS.
 * Every pricing call (the quote, the card reader's charge and breakdown, the
 * sale, the stay picker's own quote) reads it here:
 *   - R5: priced in WHOLE nights, weeks or months at the rate for what one is
 *     (registerStay priceWholeStay) — never prorated;
 *   - R6: "Add a month" lengthens the stay that is here now by one calendar
 *     month at the monthly rate (registerStay stayExtensionQuote);
 *   - R1/R7/R8: the guest's continuous nights at this property (stayTerms
 *     stayNeeds) — 22+ with no check on file adds the background check's fee
 *     as a line of its own the clerk cannot take off;
 *   - R2: 30+ nights is a lease or a stay, and the counter must say which. A
 *     lease is paid its deposit now (its lease bills the rest); a stay is paid
 *     whole and holds the site only through what is paid.
 */
export interface CounterStayPlan {
  ext: StayExtension | null
  unitId: string
  unitNumber: string
  /** The first night this sale pays for, and the check-out it pays through. */
  checkIn: string
  checkOut: string
  /** The stay's own price: a new booking's whole price, or the month added. */
  stayTotal: number
  /** What this sale takes for it: its price, or (a lease chosen) its deposit. */
  charge: number
  /** The lodging tax inside `charge` (none in a deposit or a month). */
  tax: { amount: number; rate: number }
  needs: StayNeeds
  /** The lease-or-stay answer that stands (given now, or by an earlier stay of the same continuous stay). */
  terms: StayTerms | null
  email: string | null
  /** The background check's fee this sale carries (0 for none). */
  screeningFee: number
  /** "3 nights at site RV 01 (Oct 1 → Oct 4)" */
  what: string
}

/** The background check's own line on a sale — added by the server only. */
const SCREENING_LINE = Symbol('screening line')

/** 10/5 (Nic, R2): what the counter asks for a stay of 30+ nights, in the words the guest is told online. */
export const LEASE_OR_STAY_WORDS = 'A lease holds their site for as long as they stay. A stay holds it only through the time they have paid for.'

/**
 * 10/5: a stay that needs an answer is refused before any money moves —
 * an email for 22+ continuous nights (R7: the check is sent to it and the
 * nights add up by it), lease or no lease for 30+ (R2), and the background
 * check's fee shown on the register before it is charged (R8).
 */
/**
 * 10/5 (Nic, M5): "Add a month" answered LEASE sells no month — the lease is
 * drafted instead (POST /pos/stays/lease) and bills the months from then on,
 * exactly as the schedule's Add a month does. Selling the month is only for a stay.
 */
export const ADD_MONTH_LEASE_WORDS = 'They chose a lease, so no month is sold here — the lease holds their site and bills the months from now on. '
  + 'Press Draft their lease in the stay window; it goes to the Leases page for the owner to review and send. Nothing was charged.'

function assertStayAnswered(plan: CounterStayPlan, press: string): void {
  if (plan.ext && plan.terms === 'lease') throw new AppError(409, ADD_MONTH_LEASE_WORDS)
  if (plan.needs.nights >= STAY_SCREENING_NIGHTS && !plan.email) {
    throw new AppError(400, `This stay comes to ${plan.needs.nights} nights in a row — a stay over three weeks needs the guest's email (their background check is sent to it). `
      + `Tap the site and dates above Charge, type their email, press Use this site, then press ${press} again.`)
  }
  if (plan.needs.leaseChoice === 'needed') {
    throw new AppError(409, `This stay comes to ${plan.needs.nights} nights in a row, so ask them: lease or no lease? ${LEASE_OR_STAY_WORDS} `
      + `Tap the site and dates above Charge, press Lease or No lease, then press ${press} again. Nothing was charged.`)
  }
}

async function priceCounterStay(landlordId: string, propertyId: string | null, items: any[], at: CounterStayAt | null, press: string, discountAmount?: unknown,
                                opts: { strict?: boolean; offerReturning?: boolean } = {}): Promise<{
  items: any[]; stayLines: { itemId: string; qty: number; stayUnit: 'night' | 'week' | 'month'; name: string; lineTotal: number }[]
  plan: CounterStayPlan | null
}> {
  const lines = Array.isArray(items) ? items : []
  const ids = [...new Set(lines.map((it: any) => lowerId(it?.id)).filter((x: string) => /^[0-9a-f-]{36}$/.test(x)))]
  if (!ids.length) return { items: lines, stayLines: [], plan: null }
  const rows = await query<{ id: string; name: string; stay_unit: string }>(
    `SELECT id, name, stay_unit FROM pos_items
      WHERE id = ANY($1::uuid[]) AND landlord_id = $2 AND stay_unit IS NOT NULL`,
    [ids, landlordId])
  if (!rows.length) return { items: lines, stayLines: [], plan: null }
  const at_ = lines.map((it: any, n: number) => (rows.some((r) => r.id === lowerId(it?.id)) ? n : -1)).filter((n) => n >= 0)
  if (at_.length > 1) {
    // Two stay lines is a stay whose length depends on which line you read.
    throw new AppError(400, new Set(at_.map((n) => lowerId(lines[n]?.id))).size > 1
      ? 'Ring one kind of stay at a time — nights and weeks on the same sale have no single set of dates.'
      : `Keep the stay on one line — set how many nights there — then press ${press} again.`)
  }
  if (Number(discountAmount) > 0) throw new AppError(400, counterStayNoDiscountWords(press))
  const n = at_[0]
  const line = lines[n]
  const row = rows.find((r) => r.id === lowerId(line?.id))!
  const qty = Number(line?.qty) || 0
  const stayUnit = row.stay_unit as 'night' | 'week' | 'month'
  // No site yet means no price yet — the sale refuses it for that reason, so
  // this only has to not invent a number. The line is marked (UNPRICED_STAY)
  // so the customer's screen on the reader leaves it off until it is priced.
  if (!at) {
    return { items: lines.map((it: any, k: number) => (k === n ? { ...it, [UNPRICED_STAY]: true } : it)),
             stayLines: [{ itemId: row.id, qty, stayUnit, name: row.name, lineTotal: 0 }], plan: null }
  }
  if (!propertyId) throw new AppError(400, `Pick the property at the top of the register first, then press ${press} again.`)

  let plan: CounterStayPlan
  if (at.extendBookingId) {
    // 10/5 (Nic, R6): Add a month — one month, on the stay that is here now.
    if (stayUnit !== 'month' || qty !== 1) {
      throw new AppError(400, `Add a month adds one month — ring it with the monthly stay at a quantity of 1, then press ${press} again.`)
    }
    const ext = await stayExtensionQuote(db, { landlordId, propertyId, bookingId: at.extendBookingId })
    if ((at.unitId && at.unitId.toLowerCase() !== ext.unitId) || (at.checkIn && at.checkIn !== ext.fromCheckOut)) {
      throw new AppError(409, `That stay changed a moment ago — nothing was charged. Tap the stay above Charge, pick it again, then press ${press} again.`)
    }
    const email = at.guestEmail ?? ext.guestEmail
    const needs = await stayNeeds({ landlordId, propertyId, bookingId: ext.bookingId, tenantId: ext.tenantId, email,
      checkIn: ext.checkIn, checkOut: ext.checkOut, stayTerms: at.stayTerms,
      returning: at.returningGuest, offerReturning: opts.offerReturning })
    plan = {
      ext, unitId: ext.unitId, unitNumber: ext.unitNumber, checkIn: ext.fromCheckOut, checkOut: ext.checkOut,
      stayTotal: ext.price, charge: ext.price, tax: { amount: 0, rate: 0 }, needs,
      terms: needs.leaseChoice === 'lease' || needs.leaseChoice === 'stay' ? needs.leaseChoice : null,
      email, screeningFee: needs.screening === 'fee_due' ? needs.screeningFee?.amount ?? 0 : 0,
      what: `a month added to their stay — ${reservationWhat({ nights: ext.addedNights, unitNumber: ext.unitNumber, checkIn: ext.fromCheckOut, checkOut: ext.checkOut })}`,
    }
  } else {
    if (!at.unitId || !at.checkIn) throw new AppError(400, `A stay needs a site and an arrival date before it can be charged — press Pick a site and dates, then press ${press} again.`)
    // The site has to be this property's before anything about it is read.
    const site = /^[0-9a-f-]{36}$/i.test(at.unitId) ? await queryOne<{ id: string }>(
      `SELECT id FROM units WHERE id = $1 AND property_id = $2 AND landlord_id = $3 AND retired_at IS NULL`,
      [at.unitId, propertyId, landlordId]) : null
    if (!site) throw new AppError(400, `That site is not at this property — pick the site again, then press ${press} again.`)
    // 10/5 (Nic, R5): whole nights, weeks or months — never prorated.
    const priced = await priceWholeStay(db, at.unitId, stayUnit, qty, at.checkIn,
      (unit, word) => `Site ${unit} has no ${word} rate set, and neither does the property, so this stay cannot be priced — nothing was charged. `
        + `Set the site's ${word} rate (or the property's), then press ${press} again.`)
    const needs = await stayNeeds({ landlordId, propertyId, email: at.guestEmail, checkIn: at.checkIn, checkOut: priced.checkOut, stayTerms: at.stayTerms,
      returning: at.returningGuest, offerReturning: opts.offerReturning })
    const terms = needs.leaseChoice === 'lease' || needs.leaseChoice === 'stay' ? needs.leaseChoice : null
    // R2/R4: a lease is paid its deposit now; its lease bills the rest (and prorates, by the property's setting).
    const lease = terms === 'lease'
    const charge = lease ? await leaseDepositFor(db, at.unitId, priced.total, priced.nights) : priced.total
    plan = {
      ext: null, unitId: at.unitId, unitNumber: priced.unitNumber, checkIn: at.checkIn, checkOut: priced.checkOut,
      stayTotal: priced.total, charge, tax: lease ? { amount: 0, rate: 0 } : { amount: priced.tax, rate: priced.taxRate },
      needs, terms, email: at.guestEmail,
      screeningFee: needs.screening === 'fee_due' ? needs.screeningFee?.amount ?? 0 : 0,
      // 10/6 (Nic): six nights rung as nights are charged the week's price when
      // it is lower — the ticket and the receipt say so.
      what: reservationWhat({ nights: priced.nights, unitNumber: priced.unitNumber, checkIn: at.checkIn, checkOut: priced.checkOut })
        + (priced.lowerRateWords && !lease ? ` — ${priced.lowerRateWords}` : ''),
    }
  }
  if (opts.strict) assertStayAnswered(plan, press)
  const shown = line?.stayTotal
  if (shown != null && shown !== '' && Math.round(Number(shown) * 100) !== Math.round(plan.charge * 100)) {
    throw new AppError(409, counterStayNowWords(plan.what, plan.charge, press))
  }
  // R8: the fee the register shows is the fee charged — and a fee the register
  // never showed is never charged.
  if (plan.screeningFee > 0 && (at.screeningFee != null || opts.strict)
      && Math.round((at.screeningFee ?? -1) * 100) !== Math.round(plan.screeningFee * 100)) {
    throw new AppError(409, `This stay comes to ${plan.needs.nights} nights in a row and needs a background check — its ${money(plan.screeningFee)} fee goes on this sale, and the register shows something else, so nothing was charged. `
      + `Tap the site and dates above Charge, press Use this site, then press ${press} again.`)
  }
  const leaseTail = plan.terms === 'lease' && !plan.ext ? ' — the deposit now; its lease bills the rest' : ''
  const priced_ = lines.map((it: any, k: number) => (k !== n ? it : {
    id: row.id, name: `${row.name} — ${plan.what}${leaseTail}`.slice(0, 160), qty: 1, price: plan.charge, tax: 0, stay: true,
    ...(it?.cat ? { cat: it.cat } : {}),
    [RESERVATION_LINE]: true, [STAY_TAX]: plan.tax,
  }))
  // R8: the background check's fee is its own line, added here and nowhere
  // else — the cart cannot take it off, because the cart never had it.
  if (plan.screeningFee > 0) {
    priced_.push({ id: null, name: SCREENING_LINE_NAME, qty: 1, price: plan.screeningFee, tax: 0, [SCREENING_LINE]: true })
  }
  return { items: priced_, stayLines: [{ itemId: row.id, qty, stayUnit, name: row.name, lineTotal: plan.stayTotal }], plan }
}

const RESERVATION_NOT_WAITING = 'That reservation is no longer waiting to be paid — it was canceled or marked a no-show, and nothing was charged. Press Clear, then look the reservation up on the schedule.'
/** A reservation ticket named at the till that is not one of this company's (or not any more). */
const TICKET_NOT_OPEN = 'That ticket is not on the open list any more — nothing was charged. Press Clear, then open the list to see what is still out.'
/** 10/3 (review): one sale, one ticket or one pay link — two reservations are never settled by one payment. */
const ONE_TICKET_OR_LINK = 'A sale settles one ticket or one pay link — press Clear, then open just one.'

/**
 * 10/2 (decisions #9) — A RESERVATION TICKET CHARGES THE RESERVATION'S OWN
 * PRICE, AND NOTHING ELSE.
 *
 * Nic, S652: "One price, and it is the site's." A reservation was quoted once —
 * on the schedule, or on the booking site — and unit_bookings.total_amount is
 * that quote, tax in it. What the till takes for it is that price less what was
 * already paid toward it (services/registerStay reservationDue): never the stay
 * item's rate × a quantity (the schedule's hand-off rounds nights to weeks, so a
 * ten-night stay rang as one week), never the booking's price overwritten by
 * whatever the till worked out. 10/3 (decisions #15): for a stay its lease
 * bills, what the till takes is its deposit — the lease bills the rest.
 *
 * So the stay line on a reservation ticket is the reservation: one line, at
 * what is owed, untaxed (its tax is in the quote). The register is handed that
 * line when it opens the ticket (GET /tickets/:id) and shows it; every place
 * that prices a cart — the quote, the card reader's charge and breakdown, the
 * sale — prices it the same way here, and a cart that still shows any other
 * figure (opened before a deposit came in online, or by a register still on an
 * old screen that showed $0) is refused before any money moves, with the
 * amount and what to press. A reservation is charged whole: no discount. A pay
 * link for a reservation is priced the same way (priceLinkCart).
 */
const RESERVATION_LINE = Symbol('reservation line')
/**
 * 10/3 (decisions #21): the lodging tax inside a reservation line's price
 * ({ amount, rate }), set by the server on the line it builds — never read
 * from the cart. The sale records that part as tax (serverCartTotals,
 * reservationSaleLine); what is charged is unchanged.
 */
const STAY_TAX = Symbol('stay tax')

const money = (n: number) => `$${n.toFixed(2)}`

/** A reservation the till may take money for — refused, in the clerk's words, when it may not. */
function assertReservationChargeable(due: ReservationDue | null): asserts due is ReservationDue {
  if (!due || due.closed) throw new AppError(409, RESERVATION_NOT_WAITING)
  if (due.noPrice) throw new AppError(409, 'That reservation has no price on it — nothing was charged. Set its price on the schedule, then open the ticket again.')
  if (due.paidInFull) throw new AppError(409, reservationPaidWords(due))
}

/** What the clerk is told when the cart shows another figure than the reservation owes. */
const reservationNowWords = (due: ReservationDue, press: string) =>
  `This reservation — ${reservationWhat(due)} — comes to ${money(due.owed)}`
  + `${due.leaseBillsRest ? ' now (its deposit; its lease bills the rest)' : ''}`
  + `${due.paid > 0 ? ` after the ${money(due.paid)} already paid` : ''} — the cart shows something else, and nothing was charged. `
  + `Press Clear, open the ticket again, then press ${press}.`

/**
 * The open reservation ticket a cart settles: by the ticket named, or by its
 * stay line (the reader's calls carry no ticket). 10/3 (review): a ticket
 * whose reservation is over gave up its stay (registerStay
 * releaseReservationTickets) and is an ordinary ticket from then on.
 */
async function reservationTicketOf(landlordId: string, items: any[], openTicketId: unknown, propertyId: string | null): Promise<{ ticketId: string; bookingId: string } | null> {
  const named = namedTicketOf(items, openTicketId)
  if (!named) return null
  // 10/2 (review): a ticket is priced only at a register standing on its
  // property — the reservation it names (nights, site, dates, what is owed and
  // paid) is never read out to a register with no property, or another one.
  if (!propertyId) throw new AppError(400, 'Pick the property at the top of the register first, then press Charge again.')
  if (!/^[0-9a-f-]{36}$/i.test(String(named))) throw new AppError(404, TICKET_NOT_OPEN)
  const t = await queryOne<{ id: string; booking_id: string | null; property_id: string; landlord_id: string; items: any }>(
    `SELECT id, booking_id, property_id, landlord_id, items FROM pos_open_tickets WHERE id = $1 AND landlord_id = $2`, [named, landlordId])
  if (!t) throw new AppError(404, TICKET_NOT_OPEN)
  if (t.property_id !== propertyId) {
    throw new AppError(400, 'That ticket is for another property — nothing was charged. Switch the register to that property, then press Charge again.')
  }
  if (!t.booking_id || !(await ticketCarriesStay(db, t))) return null
  return { ticketId: t.id, bookingId: t.booking_id }
}

/** The ticket a cart names — on the call, or on its reservation line. */
const namedTicketOf = (items: any[], openTicketId: unknown): string | null =>
  (typeof openTicketId === 'string' && openTicketId ? openTicketId
    : (Array.isArray(items) ? items : []).map((i: any) => i?.openTicketId).find((x: unknown) => typeof x === 'string' && x)) || null

/** The pay link a cart names — on the call, or on its reservation line (the reader's calls carry it there). */
const namedLinkOf = (items: any[], payLinkId: unknown): string | null =>
  (typeof payLinkId === 'string' && payLinkId ? payLinkId
    : (Array.isArray(items) ? items : []).map((i: any) => i?.payLinkId).find((x: unknown) => typeof x === 'string' && x)) || null

/**
 * Price a reservation ticket's cart: its one stay line becomes the reservation
 * at what is owed (untaxed — RESERVATION_LINE), checked against what the cart
 * shows. Everything else in the cart is priced as usual.
 */
async function priceReservationCart(landlordId: string, bookingId: string, items: any[], discountAmount: unknown, press: string): Promise<{ items: any[]; due: ReservationDue }> {
  const due = await reservationDue(db, bookingId)
  assertReservationChargeable(due)
  if (Number(discountAmount) > 0) throw new AppError(400, reservationNoDiscountWords(press))
  const lines = Array.isArray(items) ? items : []
  const stays = await stayItemIdsIn(db, landlordId, lines)
  const at = lines.map((i: any, n: number) => (stays.has(lowerId(i?.id)) ? n : -1)).filter((n) => n >= 0)
  if (!at.length) {
    throw new AppError(400, `That ticket is for a reservation, but nothing on it is a stay — press Clear, open the ticket again, then press ${press}.`)
  }
  if (at.length > 1) {
    throw new AppError(400, `This ticket is for ${reservationWhat(due)} — keep just one stay line for it, then press ${press} again.`)
  }
  const line = lines[at[0]]
  if (Math.round((Number(line.qty) || 0) * (Number(line.price) || 0) * 100) !== Math.round(due.owed * 100)) {
    throw new AppError(409, reservationNowWords(due, press))
  }
  // decisions #21: the schedule priced it with its lodging tax in it (a stay
  // under 30 nights); the sale records that part as tax. A long stay's charge
  // here is its deposit (decisions #15) — no tax in that.
  const rate = due.leaseBillsRest ? 0 : stayTaxRate(due.rates, due.taxPct, due.bookedNights, { checkIn: due.checkIn, total: due.total, monthStay: due.monthStay })
  // 10/3 (review): its share of the stay's tax — with what was paid ahead (a
  // deposit), the parts add up to the stay's tax (taxInsidePayment).
  const stayTax = { amount: taxInsidePayment(due.paid, due.owed, rate), rate }
  const priced = lines.map((it: any, n: number) => (n === at[0] ? { ...it, tax: 0, [RESERVATION_LINE]: true, [STAY_TAX]: stayTax } : it))
  return { items: priced, due }
}

/** The words for a pay link the till cannot settle — the same ones the sale uses. */
const LINK_NOT_OPEN = 'That pay link has already been paid or closed — press Clear, then open the list to see what is still out.'

/** A pay link named at the till: this company's emailed link, open, not run out, at this register's property. */
async function openLinkAt(landlordId: string, propertyId: string | null, linkId: string): Promise<any> {
  const link = /^[0-9a-f-]{36}$/i.test(String(linkId)) ? await queryOne<any>(
    `SELECT * FROM pos_pay_links WHERE id = $1 AND landlord_id = $2`, [linkId, landlordId]) : null
  if (!link || link.kind !== 'one_time') throw new AppError(404, PAY_LINK_GONE)
  if (link.status !== 'open') throw new AppError(409, LINK_NOT_OPEN)
  if (link.expires_at && new Date(link.expires_at) <= new Date()) {
    throw new AppError(409, 'That pay link has run out — nothing was charged. Press Clear, then ring the sale up fresh (or send them a new link).')
  }
  if (!propertyId) throw new AppError(400, 'Pick the property at the top of the register first, then press Charge again.')
  if (link.property_id !== propertyId) {
    throw new AppError(400, 'That pay link is for another property — nothing was charged. Switch the register to that property, then press Charge again.')
  }
  link.items = lowerLineIds(Array.isArray(link.items) ? link.items : [])
  return link
}

/**
 * 10/3 (decisions #9, #23) — A PAY LINK FOR A RESERVATION IS CHARGED THE
 * RESERVATION'S OWN AMOUNT, wherever the cart is priced (the quote, the
 * reader's charge and breakdown, the sale): its reservation part — its stay
 * line, or the deposit/balance/amount line it was sent for — becomes one line
 * at what the link charges toward the reservation now (posPayLinks
 * linkReservation), untaxed; the rest of the cart is priced as usual. The
 * register shows that line (GET /tickets/:id), marked as the reservation, with
 * its nights. decisions #23: the nights are the reservation's — never fewer or
 * more here (they change only on the schedule); a cart that changes them, or
 * shows another figure for it, is refused before any money moves, with the
 * figure and what to press.
 *
 * Returns the cart as charged, the reservation, and the rest of the cart (what
 * the cashier answers for). A link with no reservation is the cart as sent.
 */
async function priceLinkCart(link: any, items: any[], discountAmount: unknown, press: string): Promise<{
  items: any[]; res: LinkReservation | null; rest: any[]
}> {
  const lines = Array.isArray(items) ? items : []
  if (!link?.booking_id) return { items: lines, res: null, rest: lines }
  const stay = await linkStayOf(db, link)
  const own = linkBookingLines(link, stay)
  if (!stay && !own.length) return { items: lines, res: null, rest: lines }
  const marked = (l: any) => l?.reservation === true || (typeof l?.payLinkId === 'string' && l.payLinkId.trim().toLowerCase() === String(link.id))
  let resLines: any[]
  if (stay) {
    resLines = lines.filter((l: any) => lowerId(l?.id) === stay.itemId)
    if (resLines.some(marked) && resLines.length > 1) {
      throw new AppError(400, `This link is for one stay — keep just its one line, then press ${press} again.`)
    }
  } else {
    resLines = lines.filter((l: any) => !l?.id && marked(l))
    if (!resLines.length) {
      // A register still on the old screen shows the link's own line as it was sent.
      assertLinkBookingLinesKept(link, null, lines, press)
      const keys = new Set(own.map((l) => `${l.name}|${l.price.toFixed(2)}`))
      resLines = lines.filter((l: any) => !l?.id && keys.has(`${String(l?.name ?? '')}|${(Number(l?.price) || 0).toFixed(2)}`))
    }
  }
  // decisions #9: a reservation is charged at its own price — never less a discount.
  if (Number(discountAmount) > 0) throw new AppError(400, reservationNoDiscountWords(press))
  const res = await linkReservation(db, link, { press })
  if (!res) return { items: lines, res: null, rest: lines }
  // decisions #23: the stay is kept whole — the register's reservation line at
  // the reservation's own nights, or (a register still on the old screen) the
  // link's own stay line(s), as many as the link carries.
  if (stay) {
    const line = resLines.find(marked)
    if (line) {
      if (line.nights != null && line.nights !== '' && Number(line.nights) !== res.due.nights) {
        throw new AppError(409, linkStayNightsNowWords(res.due, press))
      }
    } else {
      assertLinkStayWhole(stay, res.due, lines, press, 'charged')
    }
  }
  // What the cart shows for it: the register's reservation line as it is; a
  // stay line as the link carried it — the whole stay at what the link last
  // asked for it (a stay is the schedule's figure, never the line re-added).
  // (Only while the cart's stay lines are the link's own, at its own price —
  // a stay line at any other price is read as it stands, and refused.)
  const keptWhole = !!stay && resLines.every((l: any) => Math.round((Number(l?.price) || 0) * 100) === Math.round(stay.price * 100))
  const shown = resLines.some(marked) || !stay
    ? round2(resLines.reduce((n: number, l: any) => n + (Number(l?.qty) || 0) * (Number(l?.price) || 0), 0))
    : keptWhole ? await linkStayAsSent(db, link)
    : round2(Number((await computeCartTotals(link.landlord_id, resLines, { surcharge: 0, discountAmount: 0 })).total))
  if (Math.round(shown * 100) !== Math.round(res.charge * 100)) throw new AppError(409, linkReservationNowWords(res, press))
  const rest = lines.filter((l: any) => !resLines.includes(l))
  return { items: [{ ...linkReservationLine(link, res), [RESERVATION_LINE]: true, [STAY_TAX]: res.stayTax }, ...rest], res, rest }
}

/**
 * The cart as every pricing endpoint prices it: a reservation ticket's stay is
 * the reservation (priceReservationCart); so is a pay link's reservation
 * (priceLinkCart); a stay rung straight at the counter is the schedule's price
 * for its nights (priceCounterStay — its site and arrival from `opts.stay` or
 * its own cart line); anything else is the cart as sent. `opts.needSite`: a
 * card is about to be charged — a stay with no site and dates is refused first.
 */
async function cartAsCharged(landlordId: string, propertyId: string | null, items: any[], openTicketId: unknown, discountAmount: unknown, press: string,
                             payLinkId?: unknown, opts: { stay?: unknown; needSite?: boolean } = {}): Promise<{ items: any[]; reservation: { ticketId: string; due: ReservationDue } | null; link: LinkReservation | null
                                                                                                             stayPlan: CounterStayPlan | null }> {
  const linkNamed = namedLinkOf(items, payLinkId)
  if (linkNamed && namedTicketOf(items, openTicketId)) throw new AppError(400, ONE_TICKET_OR_LINK)
  if (linkNamed) {
    const link = await openLinkAt(landlordId, propertyId, linkNamed)
    const r = await priceLinkCart(link, items, discountAmount, press)
    return { items: r.items, reservation: null, link: r.res, stayPlan: null }
  }
  const t = await reservationTicketOf(landlordId, items, openTicketId, propertyId)
  if (!t) {
    // 10/3 (decisions #9): a stay rung straight here costs what the schedule charges for its nights.
    // 10/5: a card about to be charged needs the stay's answers too (assertStayAnswered).
    const c = await priceCounterStay(landlordId, propertyId, items, counterStayAt(items, opts.stay), press, discountAmount, { strict: opts.needSite })
    if (opts.needSite && c.stayLines.some((l) => !(l.lineTotal > 0))) {
      throw new AppError(400, `A stay needs a site and an arrival date before it can be charged — press Pick a site and dates, then press ${press} again.`)
    }
    return { items: c.items, reservation: null, link: null, stayPlan: c.plan }
  }
  const r = await priceReservationCart(landlordId, t.bookingId, items, discountAmount, press)
  return { items: r.items, reservation: { ticketId: t.ticketId, due: r.due }, link: null, stayPlan: null }
}

/**
 * GET /tickets: a reservation ticket's stay line as the register shows it — at
 * what the reservation owes, marked as the reservation (the ticket itself was
 * written at $0 by the schedule's hand-off; the price is never frozen on it).
 * A ticket that gave up its stay (its reservation is over) is an ordinary ticket.
 */
async function ticketWithReservation(t: any): Promise<any> {
  if (!t?.booking_id || !(await ticketCarriesStay(db, t))) return t
  const due = await reservationDue(db, t.booking_id)
  if (!due || due.closed || due.noPrice || due.paidInFull) {
    return { ...t, reservation_status: due?.status === 'no_show' ? 'no_show' : !due || due.closed ? 'cancelled' : due.noPrice ? 'no_price' : 'paid',
             reservation_lease_bills_rest: !!due?.leaseBillsRest, reservation_displaced: !!due?.displaced,
             reservation_paid: due?.paid ?? 0 }
  }
  const items = Array.isArray(t.items) ? t.items : []
  const ids = [...new Set(items.map((i: any) => lowerId(i?.id)).filter((x: string) => /^[0-9a-f-]{36}$/.test(x)))]
  const stays = ids.length ? await query<{ id: string; name: string; stay_unit: string }>(
    `SELECT id, name, stay_unit FROM pos_items WHERE id = ANY($1::uuid[]) AND landlord_id = $2 AND stay_unit IS NOT NULL`, [ids, t.landlord_id]) : []
  let placed = false
  const out: any[] = []
  for (const i of items) {
    const s = stays.find((x) => x.id === lowerId(i?.id))
    if (!s) { out.push(i); continue }
    if (placed) continue   // one reservation, one line
    placed = true
    out.push({ id: s.id, name: reservationLineName(s.name, due), qty: 1, price: due.owed, tax: 0,
               stay: true, reservation: true, stay_unit: s.stay_unit })
  }
  return { ...t, items: out, reservation_owed: due.owed, reservation_paid: due.paid, reservation_total: due.total }
}

/**
 * 10/2 (review): a reservation ticket whose reservation is over — cancelled
 * (on the schedule, or its site lost to a guest who paid first), marked a
 * no-show, or paid in full some other way — has nothing left for the till to
 * take FOR THE STAY. It is never left open and hidden (nobody could charge or
 * void it, yet it still counted as owed on Outstanding Balances). 10/3
 * (review): the stay comes off it, the moment the register sees it; a ticket
 * that carried only the stay is voided with the reason, and one that carries
 * anything else (a tank of propane held on it) stays open for that, Void
 * button and all (registerStay releaseReservationTickets). Kept, never deleted.
 */
function reservationOverReason(t: any): string | null {
  switch (t?.reservation_status) {
    case 'cancelled': return t.reservation_displaced ? 'The reservation lost its site to a guest who paid first' : 'The reservation was canceled'
    case 'no_show': return 'The reservation was marked a no-show'
    // 10/3 (review): a long stay with nothing due now (no deposit asked) was
    // never "deposit paid" — nothing is due at the register; its lease bills it.
    case 'paid': return !t.reservation_lease_bills_rest ? 'The reservation was paid in full'
      : Number(t.reservation_paid) > 0.005 ? 'The reservation\'s deposit was paid — its lease bills the rest'
      : 'Nothing is due on the reservation at the register — its lease bills the stay'
    default: return null
  }
}
/** Release the stays of over reservations; returns the tickets still open (as ordinary tickets) by id, with the words for each. */
async function releaseOverReservationTickets(tickets: any[]): Promise<Map<string, { ticket: any; reason: string }>> {
  const kept = new Map<string, { ticket: any; reason: string }>()
  for (const t of tickets) {
    const reason = reservationOverReason(t)
    if (!reason || !t.booking_id) continue
    const r = await releaseReservationTickets(db, t.booking_id, reason, { onlyTicketId: t.id })
    if (r.kept.includes(t.id)) {
      const fresh = await queryOne<any>(`SELECT t.*, ${ticketPersonNameSql('t')} AS customer_name FROM pos_open_tickets t WHERE t.id = $1`, [t.id])
      if (fresh) kept.set(t.id, { ticket: fresh, reason })
    }
  }
  return kept
}

// S654/10-2: who a sale names — personOnSale — lives in services/posPeople,
// shared with pay links: one rule for "this company's person".

/**
 * The breakdown a register sale shows on the reader: each line, then the card
 * fee. 10/3 (decisions #21): a reservation's line shows before its lodging
 * tax, which the reader shows as tax — the lines, the tax and the total add up.
 */
function registerReaderLines(items: any[], surchargeDollars: number): { description: string; amountCents: number; quantity: number }[] {
  const lines = items.map((it: any) => reservationSaleLine(it, it?.[STAY_TAX])).filter((it: any) => Number(it.qty) > 0).map((it: any) => ({
    description: `${String(it.name ?? 'Item')}${Number(it.qty) > 1 ? ` ×${Number(it.qty)}` : ''}`,
    amountCents: Math.round(Number(it.qty) * Number(it.price) * 100), quantity: 1,
  }))
  if (surchargeDollars > 0) lines.push({ description: 'Card processing fee', amountCents: Math.round(surchargeDollars * 100), quantity: 1 })
  return lines
}

async function serverCartTotals(landlordId: string, items: any[], paymentMethod: string | undefined,
                                discountAmount: number | undefined, clientSurcharge?: number,
                                propertyId?: string | null) {
  // 10/2 (review): ids as the database writes them, and only this company's
  // items — refused in words, never a database error from the tax lookup.
  items = lowerLineIds(items || [])
  await assertItemsAreOurs(landlordId, items, 'Charge')
  // 10/2 (decisions #9): a reservation's line (priceReservationCart) is its
  // quoted price with the tax already in it — totaled as it stands, untaxed.
  const lines = (items || [])
    .filter((it: any) => !!it.id && !it[RESERVATION_LINE])
    .map((it: any) => ({ itemId: it.id, qty: Number(it.qty) || 0, unitPrice: Number(it.price) || 0 }))
  const tax = await calculateCartTax(landlordId, lines)
  const base = aggregateCartTotals(tax, items, { surcharge: 0, discountAmount })
  // 10/3 (decisions #21): the lodging tax inside a reservation's price is
  // recorded as tax, not as the stay's price — the total is the same.
  const stayTax = (items || []).reduce((n: number, it: any) => n + (it?.[RESERVATION_LINE] ? Number(it?.[STAY_TAX]?.amount) || 0 : 0), 0)
  const lodging = (items || []).find((it: any) => it?.[RESERVATION_LINE] && Number(it?.[STAY_TAX]?.amount) > 0)?.[STAY_TAX] ?? null
  if (stayTax > 0) {
    base.subtotal = round2(base.subtotal - stayTax)
    base.taxAmount = round2(base.taxAmount + stayTax)
  }
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
           taxBreakdown: stayTax > 0
             ? withLodgingTax(taxBreakdownFor(tax, round2(base.taxAmount - stayTax)), { amount: round2(stayTax), rate: Number(lodging?.rate) || 0 })
             : taxBreakdownFor(tax, base.taxAmount) }
}

/** 10/3: the named taxes on a cart of register items (a pay link's other lines, paid online) — the same rule the counter uses. */
export async function cartTaxBreakdown(landlordId: string, items: any[]): Promise<{ name: string; rate: number; amount: number }[]> {
  const lines = (items || []).filter((it: any) => !!it?.id)
    .map((it: any) => ({ itemId: it.id, qty: Number(it.qty) || 0, unitPrice: Number(it.price) || 0 }))
  const tax = await calculateCartTax(landlordId, lines)
  const base = aggregateCartTotals(tax, items, { surcharge: 0, discountAmount: 0 })
  return taxBreakdownFor(tax, base.taxAmount)
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
    const { surcharge, discountAmount, paymentMethod } = req.body
    // 10/2 (review): a quote is for a property the caller works, like every
    // other pricing call (the card reader's charge, the sale) — a ticket named
    // here is read out only at its own property's register.
    const propertyId = typeof req.body.propertyId === 'string' && req.body.propertyId ? String(req.body.propertyId) : ''
    if (!propertyId) throw new AppError(400, 'A property must be selected — pick it at the top of the register; sales are per-property.')
    await assertPropertyInScope(req.user, propertyId)
    await assertPropertyIsLandlords(posLandlordId(req), propertyId)
    const items = lowerLineIds(req.body.items)
    if (!Array.isArray(items)) throw new AppError(400, 'The cart is empty — add what they are buying, then press Charge again.')
    assertCartNumbers(items, 'Charge')
    assertNonNeg([surcharge, 'Surcharge'], [discountAmount, 'Discount'])
    await assertWholeStays(posLandlordId(req), items, 'Charge')
    // 10/2 (decisions #9): a reservation ticket is priced as the sale prices it.
    // 10/3: so is a pay link's reservation — whole, at what it owes now
    // (decisions #23: a quote never prices other nights; they change on the
    // schedule) — and the register is handed back the reservation's line as
    // priced.
    assertStayLineMatches(items, req.body.stay, 'Charge')
    const priced = await cartAsCharged(posLandlordId(req), propertyId, items, req.body.openTicketId, discountAmount, 'Charge', req.body.payLinkId,
      { stay: req.body.stay })
    const totals = await serverCartTotals(posLandlordId(req), priced.items, paymentMethod, discountAmount, surcharge, propertyId)
    const line = priced.link ? priced.items.find((i: any) => i[RESERVATION_LINE]) : null
    res.json({ success: true, data: { ...totals,
      ...(line ? { reservationLine: { name: line.name, price: line.price, nights: line.nights ?? null } } : {}),
      // 10/5: what a stay rung here needs (the same answer the stay picker gets).
      ...(priced.stayPlan ? { stay: stayPlanOut(priced.stayPlan) } : {}) } })
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
    if (!propertyId) throw new AppError(400, 'Pick the property at the top of the register first, then pick the stay again.')
    if (!['night', 'week', 'month'].includes(stayUnit)) throw new AppError(400, 'That stay length could not be read — take the stay out of the cart, add it again, then pick the dates.')
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
              COALESCE(u.${rateCol}, pr.${rateCol})::float AS rate,
              COALESCE(u.nightly_rate, pr.nightly_rate)::float AS nightly_rate_,
              COALESCE(u.weekly_rate, pr.weekly_rate)::float AS weekly_rate_,
              COALESCE(u.monthly_rate, pr.monthly_rate)::float AS monthly_rate_,
              pr.short_term_tax_rate::float AS lodging_tax_pct_,
              -- 10/3 (S652: an unpaid hold yields to anyone who pays): a site
              -- held only by an unpaid hold can still be SOLD at the counter —
              -- the sale moves the hold (holdDisplacement). It is listed last
              -- and flagged; a pay link (not payment) still cannot take it.
              -- 10/3 (review): only an UNTIMED hold yields — a timed hold is a
              -- guest paying online right now and keeps the site hidden.
              EXISTS (
                SELECT 1 FROM unit_bookings h
                 WHERE h.unit_id = u.id AND h.status = 'tentative' AND h.deposit_paid_at IS NULL
                   AND h.displaced_at IS NULL AND h.hold_expires_at IS NULL
                   AND h.check_in < $4::date AND h.check_out > $3::date) AS held_by_unpaid_hold,
              -- Who is holding it, so the cashier can tell when it is the person
              -- standing at the counter (then: settle their link or ticket).
              (SELECT h.guest_name FROM unit_bookings h
                WHERE h.unit_id = u.id AND h.status = 'tentative' AND h.deposit_paid_at IS NULL
                  AND h.displaced_at IS NULL AND h.hold_expires_at IS NULL
                  AND h.check_in < $4::date AND h.check_out > $3::date
                ORDER BY h.created_at LIMIT 1) AS held_for
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
               AND NOT (b.status = 'tentative' AND b.deposit_paid_at IS NULL AND b.displaced_at IS NULL
                        AND b.hold_expires_at IS NULL)
               AND b.check_in < $4::date AND b.check_out > $3::date)
          AND NOT EXISTS (
            SELECT 1 FROM leases l
             WHERE l.unit_id = u.id AND l.status IN ('active','pending')
               AND l.start_date < $4::date AND (l.end_date IS NULL OR l.end_date > $3::date)
               -- 10/3 (review): a long-stay hold's unsigned lease (drafted
               -- from it, bookingLeaseDraft) is that hold's paperwork, not a
               -- tenancy — the sale moves it with the hold (holdDisplacement).
               -- It does not hide a site its unpaid hold leaves listed.
               AND NOT (l.status = 'pending' AND EXISTS (
                 SELECT 1 FROM unit_bookings hb
                  WHERE hb.id = l.source_booking_id AND hb.unit_id = u.id
                    AND hb.status = 'tentative' AND hb.deposit_paid_at IS NULL AND hb.displaced_at IS NULL
                    AND hb.hold_expires_at IS NULL
                    AND hb.check_in < $4::date AND hb.check_out > $3::date)))
          AND NOT unit_out_of_order_overlaps(u.id, $3::date, $4::date)
        ORDER BY held_by_unpaid_hold, u.unit_number`,
      [propertyId, posLandlordId(req), checkIn, checkOut])

    // S652 (Nic): the price is the site's, so it travels with the site. A site
    // with no rate for this length is still LISTED — dropping it would read as
    // "occupied", which is a lie about a site that is standing empty — but it
    // cannot be picked until somebody sets the rate.
    // 10/5 (Nic, R5): what the stay costs on each site is never prorated
    // (wholeStayPrice; the property's lodging tax inside under 30 nights), the
    // same figure the sale and a pay link charge; `lodgingTax` is the tax
    // inside it. 10/6 (Nic): it is the one price every door charges for those
    // nights — the cheapest whole months, weeks and nights that cover them —
    // and `lowerRateWords` says when that is a bigger rate than was rung up.
    // A site with no rate to price it has no lineTotal and cannot be picked.
    res.json({ success: true, data: {
      checkIn, checkOut, nights: nightsBetween(checkIn, checkOut),
      stayUnit,
      units: units.map(({ nightly_rate_, weekly_rate_, monthly_rate_, lodging_tax_pct_, ...u }: any) => {
        const priced = wholeStayPrice({ nightly: nightly_rate_, weekly: weekly_rate_, monthly: monthly_rate_ }, lodging_tax_pct_, stayUnit, qty, checkIn)
        return {
          ...u,
          rate: u.rate ?? null,
          lineTotal: priced.total > 0 ? priced.total : null,
          lodgingTax: priced.total > 0 ? priced.tax : null,
          lowerRateWords: priced.total > 0 ? priced.lowerRateWords : null,
        }
      }),
    } })
  } catch (e) { next(e) }
})

/**
 * 10/5: a stay's plan as the register is handed it — every figure the stay
 * picker, the cart and the Send-link window show is one of these, never a
 * second copy of the arithmetic in the browser.
 */
function stayPlanOut(plan: CounterStayPlan) {
  const longStay = plan.needs.nights >= STAY_LEASE_CHOICE_NIGHTS
  return {
    unitId: plan.unitId, unitNumber: plan.unitNumber, checkIn: plan.checkIn, checkOut: plan.checkOut,
    what: plan.what,
    /** The guest's nights in a row at this property, this stay (or month) included. */
    nights: plan.needs.nights,
    stayTotal: plan.stayTotal, charge: plan.charge, lodgingTax: plan.tax.amount,
    depositOnly: plan.terms === 'lease' && !plan.ext,
    needsEmail: plan.needs.nights >= STAY_SCREENING_NIGHTS,
    screening: plan.needs.screening,
    screeningFee: plan.screeningFee > 0 ? plan.screeningFee : null,
    screeningLineName: SCREENING_LINE_NAME,
    // 10/6 (Nic): the third choice beside the check's fee — available, or
    // greyed with the allowance words (never the count). Only for a desk that may use it.
    returning: plan.needs.returningOffer,
    returningGuest: plan.needs.screening === 'returning',
    leaseChoice: plan.needs.leaseChoice,
    terms: plan.terms,
    leaseOrStayWords: longStay ? LEASE_OR_STAY_WORDS : null,
    // R13: a 30+ night stay with no lease is held only through what is paid.
    heldWords: longStay && plan.terms === 'stay' ? stayHeldWords(plan.checkOut) : null,
    // M5: Add a month answered lease — no month is sold; the lease is drafted instead (POST /pos/stays/lease).
    leaseInstead: !!plan.ext && plan.terms === 'lease',
    leaseInsteadWords: plan.ext && plan.terms === 'lease'
      ? 'They chose a lease, so no month is sold — their lease holds the site and bills the months from here on. It is drafted for the owner to review and send. Nothing is charged here.'
      : null,
    extend: plan.ext ? { bookingId: plan.ext.bookingId, guestName: plan.ext.guestName, fromCheckOut: plan.ext.fromCheckOut, checkOut: plan.ext.checkOut } : null,
  }
}

// POST /api/pos/stays/quote — 10/5 (Nic): what a stay picked at the register
// comes to and what it needs, before anything is charged or sent. The stay
// picker asks it every time the site, dates, email or answer changes, and the
// cart shows exactly what it says: the stay's figure (whole nights, weeks or
// months — R5), the background check's fee when one is due (R8), whether the
// counter must answer lease or no lease (R2), and the held-through words (R13).
// Body: { propertyId, itemId, qty, unitId?, checkIn?, guestEmail?, stayTerms?, extendBookingId? }.
posRouter.post('/stays/quote', requirePerm('pos.ring_sale'), async (req: any, res, next) => {
  try {
    const b = req.body ?? {}
    const propertyId = strOrNull(b.propertyId)
    if (!propertyId || !/^[0-9a-f-]{36}$/i.test(propertyId)) throw new AppError(400, 'Pick the property at the top of the register first, then pick the stay again.')
    await assertPropertyInScope(req.user, propertyId)
    await assertPropertyIsLandlords(posLandlordId(req), propertyId)
    const itemId = lowerId(b.itemId)
    if (!/^[0-9a-f-]{36}$/.test(itemId)) throw new AppError(400, 'That stay could not be read — take it out of the cart, add it again, then pick the dates.')
    const qty = Number(b.qty)
    const at = counterStayAt([], b)
    if (!at) throw new AppError(400, 'Pick a site and an arrival date — or the stay to add a month to — first.')
    assertMayAttestReturning(req, at)
    const c = await priceCounterStay(posLandlordId(req), propertyId, [{ id: itemId, qty, price: 0 }], { ...at, screeningFee: null },
      'Use this site', undefined, { offerReturning: canAttestReturningGuest(req.user) })
    if (!c.plan) throw new AppError(400, 'That item is not a stay — take it out of the cart, then add the stay again.')
    res.json({ success: true, data: stayPlanOut(c.plan) })
  } catch (e) { next(e) }
})

// POST /api/pos/stays/lease — 10/5 (Nic, M5): "Add a month" answered lease.
// No month is sold: the stay's lease is drafted for the owner (stayTerms
// chooseStayTerms — month to month, starting today, billed by the property's
// rent settings) and the landlord is told. The same rule as the schedule's Add
// a month. Body: { propertyId, bookingId }. Nothing is charged.
posRouter.post('/stays/lease', requirePerm('pos.ring_sale'), async (req: any, res, next) => {
  try {
    const propertyId = strOrNull(req.body?.propertyId)
    const bookingId = lowerId(req.body?.bookingId)
    if (!propertyId || !/^[0-9a-f-]{36}$/i.test(propertyId)) throw new AppError(400, 'Pick the property at the top of the register first, then pick the stay again.')
    if (!/^[0-9a-f-]{36}$/.test(bookingId)) throw new AppError(400, 'Pick their stay again, then press Draft their lease.')
    await assertPropertyInScope(req.user, propertyId)
    await assertPropertyIsLandlords(posLandlordId(req), propertyId)
    // The register's own test for a stay a month could be added to (here now,
    // paid up, no lease yet) — a lease is drafted only for a stay it could have lengthened.
    const ext = await stayExtensionQuote(db, { landlordId: posLandlordId(req), propertyId, bookingId })
    const needs = await stayNeeds({ landlordId: posLandlordId(req), propertyId, bookingId: ext.bookingId, tenantId: ext.tenantId,
      email: ext.guestEmail, checkIn: ext.checkIn, checkOut: ext.checkOut, stayTerms: 'lease' })
    if (needs.leaseChoice !== 'lease') {
      throw new AppError(409, `Their stay with the month added comes to ${needs.nights} nights in a row — a lease is offered from 30. Sell the month as a stay instead.`)
    }
    const chosen = await chooseStayTerms(ext.bookingId, 'lease', { byUserId: req.user!.userId })
    if (!chosen?.leaseId) throw new AppError(409, 'Their lease could not be drafted just now — nothing was charged. Press Draft their lease again in a moment.')
    res.json({ success: true, data: { leaseId: chosen.leaseId,
      message: 'Their lease is drafted — the owner reviews and sends it from the Leases page. No month was sold and nothing was charged.' } })
  } catch (e) { next(e) }
})

// GET /api/pos/stays/current?propertyId=&q= — 10/5 (Nic, R6): the stays here
// now (or coming) that "Add a month" can lengthen — confirmed or checked in,
// not over, with no lease (a lease holds its site for as long as they stay).
// Found by part of the guest's name, email or the site.
posRouter.get('/stays/current', requirePerm('pos.ring_sale'), async (req: any, res, next) => {
  try {
    const propertyId = String(req.query.propertyId ?? '')
    if (!/^[0-9a-f-]{36}$/i.test(propertyId)) throw new AppError(400, 'Pick the property at the top of the register first, then look the stay up again.')
    await assertPropertyInScope(req.user, propertyId)
    await assertPropertyIsLandlords(posLandlordId(req), propertyId)
    const q = String(req.query.q ?? '').trim().slice(0, 80)
    const tz = await queryOne<{ timezone: string | null }>(`SELECT timezone FROM properties WHERE id = $1`, [propertyId])
    const rows = await query<any>(
      `SELECT b.id AS booking_id, b.guest_name, b.guest_email, b.unit_id, b.status, b.stay_terms,
              COALESCE(NULLIF(u.display_label, ''), u.unit_number) AS unit_number,
              to_char(b.check_in, 'YYYY-MM-DD') AS check_in, to_char(b.check_out, 'YYYY-MM-DD') AS check_out
         FROM unit_bookings b
         JOIN units u ON u.id = b.unit_id
        WHERE u.property_id = $1 AND b.landlord_id = $2
          AND b.status IN ('confirmed', 'checked_in')
          AND b.check_out >= $4::date
          AND b.stay_terms IS DISTINCT FROM 'lease'
          AND NOT EXISTS (SELECT 1 FROM leases l WHERE l.source_booking_id = b.id AND l.status IN ('pending', 'active'))
          AND ($3 = '' OR b.guest_name ILIKE '%' || $3 || '%' OR b.guest_email ILIKE '%' || $3 || '%'
               OR u.unit_number ILIKE '%' || $3 || '%' OR COALESCE(u.display_label, '') ILIKE '%' || $3 || '%')
        ORDER BY b.check_out, u.unit_number
        LIMIT 25`,
      [propertyId, posLandlordId(req), q.replace(/[%_\\]/g, ''), todayIn(tz?.timezone ?? null)])
    res.json({ success: true, data: rows })
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

// 10/2: staff forms are refused in plain words — parseForStaff (services/posPeople).

const TICKET_WORDS: Record<string, string> = {
  propertyId: 'Pick the property at the top of the register first, then press the button again.',
  tenantId: NOT_ON_REGISTER,
  posCustomerId: NOT_ON_REGISTER,
  items: 'The cart is empty — add what they are taking, then press the button again.',
  ...cartLineWords('the button'),
  note: 'That note is too long — shorten it to 500 characters, then press the button again.',
}
const TICKET_OTHERWISE = 'Something in the cart could not be read — take the last thing you added out, put it back, then press the button again.'

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

/**
 * The lines a ticket may carry: real, active items of this company's — the
 * same rule the register enforces on a sale ("Items are set prices. There's no
 * custom item thing"), applied at write-up so a bad ticket is refused in the
 * office rather than at somebody's door. A stay is a booking with dates and a
 * site and cannot sit on a ticket — except the reservation ticket the schedule
 * hands the till, which keeps its stay.
 */
async function assertTicketLines(landlordId: string, items: { id: string }[], opts: { reservation: boolean }): Promise<void> {
  const ids = [...new Set(items.map((i) => i.id))]
  const known = await query<{ id: string; name: string; stay_unit: string | null }>(
    `SELECT id, name, stay_unit FROM pos_items WHERE id = ANY($1::uuid[]) AND landlord_id = $2 AND is_active = TRUE`,
    [ids, landlordId])
  if (known.length !== ids.length) {
    throw new AppError(400, 'One of those items is not on your register any more — take it out of the cart and try again.')
  }
  const stays = known.filter((k) => k.stay_unit)
  if (!opts.reservation && stays.length) {
    throw new AppError(400, `"${stays[0].name}" is a stay — take it out of the cart; a stay is rung at the register with a site and dates.`)
  }
  if (opts.reservation && !stays.length) {
    throw new AppError(400, "This ticket is for a reservation — put the stay back in the cart, then press Clear again.")
  }
}

/** The name a ticket or pay link goes by: the person's own record, else the name it was written with. */
const ticketPersonNameSql = (t: string, fallback: string | null = null) => `COALESCE(
  (SELECT NULLIF(TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')), '')
     FROM tenants tn JOIN users u ON u.id = tn.user_id WHERE tn.id = ${t}.tenant_id),
  -- 10/2: a resident's register record goes by their account's name.
  (SELECT NULLIF(TRIM(COALESCE(cu.first_name, c.first_name, '') || ' ' || COALESCE(cu.last_name, c.last_name, '')), '')
     FROM pos_customers c LEFT JOIN tenants ctn ON ctn.id = c.tenant_id LEFT JOIN users cu ON cu.id = ctn.user_id
    WHERE c.id = ${t}.pos_customer_id)${fallback ? `,
  ${fallback}` : ''})`

posRouter.post('/tickets', requirePerm('pos.ring_sale'), async (req: any, res, next) => {
  try {
    const body = parseForStaff(ticketSchema, req.body, TICKET_WORDS, TICKET_OTHERWISE)
    body.items = lowerLineIds(body.items)   // 10/2 (review): ids as the database writes them
    if (!!body.tenantId === !!body.posCustomerId) {
      throw new AppError(400, 'A ticket is for one person — type who it is for and pick them, then press Hold for delivery.')
    }
    await assertPropertyInScope(req.user, body.propertyId)
    const landlordId = posLandlordId(req)
    await assertPropertyIsLandlords(landlordId, body.propertyId)
    await assertTicketLines(landlordId, body.items, { reservation: false })

    // S654: the person on a ticket is this company's. 10/2: never gated on
    // residency — anyone tied to this company in any way (services/posPeople).
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

const TICKET_GONE = 'That ticket is not on the open list any more — it may have been settled or voided at another register. Open the list again to see what is still out.'
const PAY_LINK_GONE = 'That pay link was already paid or closed — open the list again to see what is still out.'

// GET /api/pos/tickets/:id?propertyId=&kind=ticket|pay_link — one open ticket
// or emailed pay link, read fresh at the moment the cashier opens it.
//
// 10/2 (Nic, front desk foolproof): a list can be a minute old; the cart a
// cashier is about to charge must not be. Reopening loads the ticket from here,
// and one that was settled or voided at another register says so instead of
// filling the cart.
posRouter.get('/tickets/:id', requirePerm('pos.ring_sale'), async (req: any, res, next) => {
  try {
    const id = String(req.params.id)
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new AppError(404, TICKET_GONE)
    const landlordId = posLandlordId(req)
    // 10/2 (review): opened at a register, a ticket or link is that property's
    // or it is not on this register's list — the same answer as one that is gone.
    const atProperty = typeof req.query.propertyId === 'string' && req.query.propertyId ? String(req.query.propertyId) : null
    if (req.query.kind === 'pay_link') {
      const l = await queryOne<any>(
        `SELECT l.id, l.property_id, l.landlord_id, l.items, l.total, l.discount_amount, l.label,
                l.tenant_id, l.pos_customer_id, l.booking_id, l.status, l.kind AS link_kind, l.expires_at, l.created_at,
                ${ticketPersonNameSql('l', 'l.customer_name')} AS customer_name,
                'Emailed pay link — sent ' || to_char(l.created_at, 'Mon DD') AS note
           FROM pos_pay_links l WHERE l.id = $1 AND l.landlord_id = $2`, [id, landlordId])
      if (!l || l.link_kind !== 'one_time' || (atProperty && l.property_id !== atProperty)) throw new AppError(404, PAY_LINK_GONE)
      await assertPropertyInScope(req.user, l.property_id)
      if (l.status !== 'open' || (l.expires_at && new Date(l.expires_at) <= new Date())) throw new AppError(409, PAY_LINK_GONE)
      // 10/2 (decisions #9): a link for a reservation with nothing left to pay is not opened to be paid again.
      // 10/3 (decisions #9, #23): one that can be paid opens with its
      // reservation as one line at what the link charges for it NOW (the
      // reservation's own amount — never the link's lines frozen when it was
      // sent), marked as the reservation, with its nights — the figure the
      // till charges. Its nights are the reservation's; they change on the schedule.
      let shown = { items: l.items, total: l.total }
      if (l.booking_id) {
        const due = await reservationDue(db, l.booking_id)
        if (!due || due.closed) {
          throw new AppError(409, linkReservationGoneWords(due, 'there is nothing to charge on it. Close the link under Pay Links; if they still want to stay, ring the stay fresh with a site and dates.'))
        }
        if (due.paidInFull) throw new AppError(409, reservationPaidWords(due, 'there is nothing to charge on this link. Close it under Pay Links.'))
        const full = await queryOne<any>(`SELECT * FROM pos_pay_links WHERE id = $1`, [l.id])
        // 10/3 (decisions #23): the same figure the Pay Links list, Send again
        // and the card page show (linkAsksNow).
        const c = await linkAsksNow(db, full, { press: 'Charge' })
        if (c.res) shown = { items: c.items, total: c.total }
      }
      const { link_kind: _k, expires_at: _x, ...rest } = l
      return res.json({ success: true, data: { ...rest, ...shown, kind: 'pay_link', pay_link_id: l.id } })
    }
    const t = await queryOne<any>(
      `SELECT t.*, ${ticketPersonNameSql('t')} AS customer_name
         FROM pos_open_tickets t WHERE t.id = $1 AND t.landlord_id = $2`, [id, landlordId])
    if (!t || (atProperty && t.property_id !== atProperty)) throw new AppError(404, TICKET_GONE)
    await assertPropertyInScope(req.user, t.property_id)
    if (t.status !== 'open') throw new AppError(409, TICKET_GONE)
    // 10/2 (decisions #9): a reservation ticket opens with its stay at what the
    // reservation owes — the price the till charges — never the $0 it was
    // written with. One with nothing to charge says so instead of filling the cart.
    const shown = await ticketWithReservation(t)
    // 10/2 (review): one with nothing left to take is voided as it is refused —
    // never left open and hidden. 10/3 (review): one that carries anything
    // besides the stay gives up only the stay, and opens with the rest.
    const kept = await releaseOverReservationTickets([shown])
    const left = kept.get(t.id)
    if (left) {
      return res.json({ success: true, data: { ...left.ticket, kind: 'ticket',
        notice: `${left.reason} — its stay was taken off this ticket. The rest is still owed; charge it, or press Void.` } })
    }
    if (shown.reservation_status === 'cancelled') {
      throw new AppError(409, 'That reservation was canceled — there is nothing to charge on this ticket, so it was taken off the list. Look it up on the schedule.')
    }
    if (shown.reservation_status === 'no_show') {
      throw new AppError(409, 'That reservation was marked a no-show — there is nothing to charge on this ticket, so it was taken off the list. Look it up on the schedule.')
    }
    if (shown.reservation_status === 'paid') {
      throw new AppError(409, reservationPaidWords({ leaseBillsRest: !!shown.reservation_lease_bills_rest, paid: Number(shown.reservation_paid) || 0 },
        'there is nothing to charge on this ticket and it was taken off the list.'))
    }
    if (shown.reservation_status === 'no_price') {
      throw new AppError(409, 'That reservation has no price on it — set its price on the schedule, then open the ticket again.')
    }
    res.json({ success: true, data: { ...shown, kind: 'ticket' } })
  } catch (e) { next(e) }
})

// PUT /api/pos/tickets/:id — put a reopened ticket back on the list.
//
// 10/2 (Nic, the Scott Duffy ticket): Clear on a reopened ticket used to POST a
// SECOND ticket and leave the first open — two tickets for one tank, and a
// double charge waiting to happen. Clear now puts the ORIGINAL back: unchanged
// when the cart still matches it (the register sends nothing), updated in place
// when the cashier added, removed or changed something. Same lines and person
// rules as writing one up; only this company's, only at a property the caller
// works, and only while it is still open. No person sent = the ticket keeps its own.
const ticketUpdateSchema = ticketSchema.extend({ propertyId: z.string().uuid().optional() })

posRouter.put('/tickets/:id', requirePerm('pos.ring_sale'), async (req: any, res, next) => {
  try {
    const landlordId = posLandlordId(req)
    // 10/5 (Nic, M2): a reservation ticket's background-check line is the
    // schedule's, not the cart's — whatever the register sends for it is set
    // aside and the ticket keeps its own line exactly as written (it cannot be
    // taken off, and its fee cannot be changed here).
    const ownScreening = await ticketScreeningLineAsWritten(landlordId, req.params.id)
    const sent = Array.isArray(req.body?.items) ? req.body.items : req.body?.items
    const sentRest = Array.isArray(sent) ? sent.filter((i: any) => !(i && !i.id && (i.screening === true || i.name === SCREENING_LINE_NAME))) : sent
    const onlyScreening = !!ownScreening && Array.isArray(sentRest) && sentRest.length === 0
    const body = parseForStaff(ticketUpdateSchema, { ...req.body, items: onlyScreening ? [{ id: ZERO_UUID, qty: 1 }] : sentRest }, TICKET_WORDS, TICKET_OTHERWISE)
    if (onlyScreening) body.items = []
    body.items = lowerLineIds(body.items)   // 10/2 (review): ids as the database writes them
    if (body.tenantId && body.posCustomerId) {
      throw new AppError(400, 'A ticket is for one person — remove one of them (×), then press Clear again.')
    }
    const id = String(req.params.id)
    const t = /^[0-9a-f-]{36}$/i.test(id) ? await queryOne<any>(
      `SELECT id, property_id, status, tenant_id, pos_customer_id, booking_id, landlord_id, items FROM pos_open_tickets WHERE id = $1 AND landlord_id = $2`,
      [id, landlordId]) : null
    if (!t) throw new AppError(404, TICKET_GONE)
    await assertPropertyInScope(req.user, t.property_id)
    if (body.propertyId && body.propertyId !== t.property_id) {
      throw new AppError(400, 'That ticket belongs to another property — switch the register to that property, then press Clear again.')
    }
    if (t.status !== 'open') throw new AppError(409, `That ticket was already ${t.status === 'settled' ? 'settled' : 'voided'} — there is nothing to put back. Press Clear to empty the cart.`)
    // 10/3 (review): a reservation ticket keeps its stay — until its
    // reservation is over and the stay came off it; then it is an ordinary ticket.
    await assertTicketLines(landlordId, body.items, { reservation: !!t.booking_id && await ticketCarriesStay(db, t) })
    await assertWholeStays(landlordId, body.items, 'Clear')   // 10/2 (review): a reservation's stay is whole nights
    // M2: its background check goes back on as the schedule wrote it.
    if (ownScreening) body.items = [...body.items, ownScreening] as any

    const named = !!(body.tenantId || body.posCustomerId)
    const tenantId = named ? (body.tenantId ?? null) : t.tenant_id
    const posCustomerId = named ? (body.posCustomerId ?? null) : t.pos_customer_id
    // A person who cannot go on it is NOT a ticket that is gone: 422, so the
    // register keeps the cart and says what to do, where a 404/409 (the ticket
    // itself settled, voided or never this company's) clears it.
    if (named) {
      await personOnSale(landlordId, { tenantId, posCustomerId }).catch((e) => {
        throw e instanceof AppError && e.statusCode === 404 ? new AppError(422, e.message) : e
      })
    }

    const row = await queryOne<any>(
      `UPDATE pos_open_tickets
          SET items = $2::jsonb, tenant_id = $3, pos_customer_id = $4,
              note = COALESCE($5, note), updated_at = NOW()
        WHERE id = $1 AND status = 'open' RETURNING *`,
      [t.id, JSON.stringify(body.items), tenantId, posCustomerId, body.note ?? null])
    if (!row) throw new AppError(409, 'That ticket was settled or voided a moment ago — there is nothing to put back. Press Clear to empty the cart.')
    res.json({ success: true, data: row })
  } catch (e) { next(e) }
})

// GET /api/pos/tickets?propertyId= — what is still out. The driver's list.
posRouter.get('/tickets', requirePerm('pos.ring_sale'), async (req: any, res, next) => {
  try {
    const propertyId = String(req.query.propertyId ?? '')
    if (!propertyId) throw new AppError(400, 'Pick the property at the top of the register first.')
    await assertPropertyInScope(req.user, propertyId)
    const rows = await query<any>(
      `SELECT t.*, ${ticketPersonNameSql('t')} AS customer_name
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
              l.tenant_id, l.pos_customer_id, l.booking_id, ${ticketPersonNameSql('l', 'l.customer_name')} AS customer_name, l.created_at,
              'Emailed pay link — sent ' || to_char(l.created_at, 'Mon DD') AS note
         FROM pos_pay_links l
        WHERE l.property_id = $1 AND l.landlord_id = $2
          AND l.kind = 'one_time' AND l.status = 'open'
          AND (l.expires_at IS NULL OR l.expires_at > NOW())
        ORDER BY l.created_at`,
      [propertyId, posLandlordId(req)])
    // 10/2 (decisions #9): a reservation ticket's stay is listed at what the
    // reservation owes; one whose reservation was cancelled, marked a no-show or
    // paid in full is not money still out — it is voided, with the reason, and
    // not listed (voidTicketsForOverReservations). (One with no price yet stays
    // listed — opening it says to set the price on the schedule.)
    const withReservations = await Promise.all(rows.map((t: any) => ticketWithReservation(t)))
    const kept = await releaseOverReservationTickets(withReservations)
    const shownRows = withReservations
      .map((t: any) => kept.get(t.id)?.ticket ?? t)
      .filter((t: any) => kept.has(t.id) || !reservationOverReason(t))
    // 10/3 (decisions #23): a link for a reservation is listed as it charges
    // NOW (linkAsksNow — the figure the Pay Links list, Send again, the card
    // page and Charge all use): its reservation one line, at what it owes, with
    // the reservation's own nights. One that cannot be paid any more is listed
    // as sent; opening it says why.
    const shownLinks = []
    for (const l of links) {
      let shown = { items: l.items, total: l.total }
      if (l.booking_id) {
        try {
          const full = await queryOne<any>(`SELECT * FROM pos_pay_links WHERE id = $1`, [l.id])
          const now = full ? await linkAsksNow(db, full) : null
          if (now?.res) shown = { items: now.items, total: now.total }
        } catch (e) {
          if (!(e instanceof AppError)) throw e
        }
      }
      shownLinks.push({ ...l, ...shown, kind: 'pay_link', pay_link_id: l.id, status: 'open' })
    }
    res.json({ success: true, data: [
      ...shownRows.map((t: any) => ({ ...t, kind: 'ticket' })),
      ...shownLinks,
    ] })
  } catch (e) { next(e) }
})

// POST /api/pos/tickets/:id/void — the tank came back, or it was written wrong.
// Kept, not deleted: GAM does not erase records, and an abandoned ticket is
// part of the story of a day's deliveries.
posRouter.post('/tickets/:id/void', requirePerm('pos.ring_sale'), async (req: any, res, next) => {
  try {
    const reason = String(req.body?.reason ?? '').slice(0, 500) || null
    // 10/3 (review): a real uuid's shape — 36 hex-and-dash characters that are
    // not one (all dashes) still reached Postgres and came back a raw 500.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(req.params.id))) throw new AppError(404, TICKET_GONE)
    const t = await queryOne<any>(
      `SELECT id, property_id, status FROM pos_open_tickets WHERE id = $1 AND landlord_id = $2`,
      [req.params.id, posLandlordId(req)])
    if (!t) throw new AppError(404, TICKET_GONE)
    await assertPropertyInScope(req.user, t.property_id)
    if (t.status !== 'open') throw new AppError(409, `That ticket is already ${t.status} — open the list again to see what is still out.`)
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
    // 10/2 (review): asked from a register at a property the caller works.
    await assertSaleInScope(req.user, req.query.propertyId ? String(req.query.propertyId) : null)
    await personOnSale(posLandlordId(req), { tenantId, posCustomerId })   // S654 (review): this company's person only
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
    // 10/3 (review): one sale settles ONE ticket or ONE pay link — a payment
    // that named both settled two reservations with one sale. Refused before
    // anything is read or any money moves.
    if (openTicketId && payLinkId) throw new AppError(400, ONE_TICKET_OR_LINK)
    let payLink: any = null
    // The discount the pay link was sent with — the link's own, not one the
    // cashier is giving (see the pricing check below).
    let linkDiscount = 0
    if (payLinkId) {
      payLink = /^[0-9a-f-]{36}$/i.test(String(payLinkId)) ? await queryOne<any>(
        `SELECT * FROM pos_pay_links WHERE id = $1 AND landlord_id = $2`, [payLinkId, posLandlordId(req)]) : null
      // 10/2 (review): only an emailed (one-time) link is settled at the
      // counter — a standing QR link is never "paid" by one sale.
      if (!payLink || payLink.kind !== 'one_time') throw new AppError(404, PAY_LINK_GONE)
      if (payLink.status !== 'open') throw new AppError(409, LINK_NOT_OPEN)
      if (payLink.expires_at && new Date(payLink.expires_at) <= new Date()) {
        throw new AppError(409, 'That pay link has run out — nothing was charged. Press Clear, then ring the sale up fresh (or send them a new link).')
      }
      // A link is settled at its own property's register, into that property's books.
      if (propertyId && payLink.property_id !== propertyId) {
        throw new AppError(400, 'That pay link is for another property — nothing was charged. Switch the register to that property, then press Charge again.')
      }
      // 10/3: by somebody who works that property — before its reservation is read out.
      await assertPropertyInScope(req.user, payLink.property_id)
      // 10/2 (review): the link's own lines, ids as the database writes them.
      payLink.items = lowerLineIds(Array.isArray(payLink.items) ? payLink.items : [])
      linkDiscount = Number(payLink.discount_amount) || 0
      // S652 (Nic): "if we need to do last minute prorations or adjustments,
      // the functionality of the front counter person needs to be there." The
      // cart the cashier settles is what is charged — the link's lines loaded
      // into it, plus whatever they added or changed standing there. An empty
      // cart falls back to the link as sent.
      if (!Array.isArray(items) || items.length === 0) {
        items = payLink.items
        discountAmount = linkDiscount
      } else if (discountAmount == null) {
        // 10/2 (review): a link sent at $20 less $5 was settled at the counter
        // for $20 — its discount was dropped the moment the cart held its
        // lines. The register now carries the discount into the cart; a cart
        // that says nothing about a discount keeps the link's — for the share
        // of the link it keeps (linkDiscountFor).
        discountAmount = linkDiscountFor(payLink, items)
      }
    }
    if (!Array.isArray(items) || items.length === 0) {
      throw new AppError(400, 'The cart is empty — add what they are buying, then press Charge again.')
    }
    // 10/2 (review): every item id as the database writes it (lowercase) —
    // before any check compares one. An id in capitals is the same item, so it
    // is held to the same rules.
    items = lowerLineIds(items)
    // Reject negative line values before they corrupt the sale total. Catalog
    // items get price/tax recomputed server-side below, but qty and walk-up
    // price/tax are client-declared — a negative would shrink or invert the total.
    assertCartNumbers(items, 'Charge')
    assertNonNeg([surcharge, 'Surcharge'])
    // 10/2 (review): a stay is whole nights (or weeks, or months).
    await assertWholeStays(posLandlordId(req), items, 'Charge')
    // 10/3 (review): the stay's line and the sale's `stay` name one site and arrival.
    assertStayLineMatches(items, stay, 'Charge')
    // 10/3 (decisions #9, #15, #23): a pay link for a reservation is charged
    // the RESERVATION'S own amount — its stay, whole, at what the reservation
    // owes now (its nights, site and price change only on the schedule; a cart
    // with fewer or more nights, or without the stay, is refused), or the
    // deposit/balance/amount it was sent for, never more than is left to pay
    // (for a stay its lease bills: its deposit). It is one line at that figure
    // (priceLinkCart), checked against what the cart shows before any money
    // moves; a reservation that is over — cancelled or a no-show — or already
    // paid is refused. The rest of the cart is what the cashier answers for.
    let linkRes: LinkReservation | null = null
    let linkResLine: any = null
    if (payLink?.booking_id) {
      if (!propertyId) throw new AppError(400, 'A property must be selected — pick it at the top of the register; sales are per-property.')
      const p = await priceLinkCart(payLink, items, discountAmount, 'Charge')
      if (p.res) {
        linkRes = p.res
        linkResLine = p.items[0]
        items = p.rest
      }
    }
    const linkStay = linkRes?.stay ?? null
    // 10/2: a pay link's own lines are its bill, and a stay balance or a
    // one-off sent from a lease carries no register item. Settling THAT link
    // at the counter may charge those lines — only the link's own (same name,
    // same price, and no more of it than the link carries), never a line
    // invented at the counter.
    // (A link for a reservation has no typed lines of its own left here — they
    // are its reservation, charged as the one line above.)
    const linkOwnLeft = new Map<string, number>()
    // 10/5 (Nic, R8): a link's background-check line is its own too, whatever
    // else the link pays — and it is never left off (linkScreening below).
    const linkScreening = payLink ? linkScreeningLine(payLink) : null
    for (const l of (payLink && Array.isArray(payLink.items) ? payLink.items : [])) {
      if (l?.id) continue
      if (linkRes && !isScreeningLine(l)) continue
      const k = `${String(l?.name ?? '')}|${(Number(l?.price) || 0).toFixed(2)}`
      linkOwnLeft.set(k, (linkOwnLeft.get(k) ?? 0) + (Number(l?.qty) || 0))
    }
    const linkOwnLine = (it: any): boolean => {
      if (!payLink || it?.id) return false
      const k = `${String(it?.name ?? '')}|${(Number(it?.price) || 0).toFixed(2)}`
      const have = linkOwnLeft.get(k) ?? 0
      const q = Number(it?.qty) || 0
      if (have <= 0 || !(q > 0) || q > have + 1e-9) return false
      linkOwnLeft.set(k, have - q)
      return true
    }
    // 10/5 (Nic, M2): a reservation ticket from the schedule carries the
    // stay's background check as a fixed line of its own (routes/units
    // screeningFeeTicketLine) — the ticket's line at the ticket's figure is
    // charged like a link's (never a register item, never left off); one
    // typed at the counter is not.
    const ticketScreening = !payLink && openTicketId ? await ticketScreeningOf(posLandlordId(req), openTicketId) : null
    let ticketScreeningLeft = ticketScreening ? 1 : 0
    const ticketScreeningLine = (it: any): boolean => {
      if (!ticketScreening || it?.id || ticketScreeningLeft <= 0) return false
      if (!isScreeningCartLine(it, ticketScreening)) return false
      ticketScreeningLeft--
      return true
    }
    assertCatalogItems(items.filter((it: any) => !linkOwnLine(it) && !ticketScreeningLine(it)).map((it: any) => ({ itemId: it.id })))
    if (linkScreening && !items.some((it: any) => isScreeningCartLine(it, linkScreening))) {
      throw new AppError(400, `This link carries the guest's background check (${money(linkScreening.price)}) — it cannot be taken off. `
        + 'Press Clear, open the link again from the list, then press Charge.')
    }
    if (ticketScreening && !items.some((it: any) => isScreeningCartLine(it, ticketScreening))) {
      throw new AppError(400, `This ticket carries the guest's background check (${money(ticketScreening.price)}) — it cannot be taken off. `
        + 'Press Clear, open the ticket again from the list, then press Charge.')
    }
    // 10/5 (A5): a background check is GAM's the moment the sale is made, so
    // it never goes on a charge account (whose money the landlord is owed
    // later, or never) — refused, and the guest pays it some other way.
    if (paymentMethod === 'charge' && (linkScreening || ticketScreening)) throw new AppError(400, CHARGE_ACCOUNT_NO_SCREENING)
    // 10/5 (Nic, A2): a link for a stay's background check alone is settled
    // only while the stay stands and its check is not already paid for.
    if (payLink) {
      const why = await feeOnlyLinkNotPayable(db, payLink)
      if (why === 'stay_gone') throw new AppError(409, 'That link is for the background check of a stay that was canceled — nothing was charged. Close the link under Pay Links.')
      if (why === 'paid') throw new AppError(409, 'That guest\'s background check is already paid — nothing was charged. Close the link under Pay Links.')
    }
    // 10/2 (review): a stay on a pay link was priced from its site, and its
    // site held, when the link was sent. Settling the link charges THOSE
    // nights at THAT price — nothing else that is a stay. A stay line the link
    // never had (more nights, another price) would be a stay with no site and
    // no dates, priced by whatever the cart said; it is rung on its own.
    if (payLink) await assertStaysAreTheLinks(posLandlordId(req), items, payLink)
    // A pay link's own prices and discount were set when it was sent; the
    // cashier settling it answers only for what they change (termsOfLinkFor) —
    // and its discount is theirs only for the share of the link they keep.
    {
      if (payLink && carriesLinkDiscountPastShare(req.user, payLink, items, discountAmount)) {
        throw new AppError(403, linkDiscountWholeWords('Charge'))
      }
      const own = cashiersOwn(items.map((it: any) => ({ itemId: it.id, price: it.price, qty: it.qty })), discountAmount, payLink ? termsOfLinkFor(payLink, items) : null)
      await assertCashierPricing(req, own.lines, own.discount)
    }
    // W-12 (S531): propertyId is REQUIRED — every sale belongs to a
    // property (per-property books, EOD drawers, sales history).
    if (!propertyId) throw new AppError(400, 'A property must be selected — pick it at the top of the register; sales are per-property.')
    // Property lock: a scoped worker (cashier) can only ring on a property in
    // their scope. Owners + all_properties bypass. Requires the client to send
    // propertyId on every sale (not just FlexCharge) — see POSPage checkout.
    await assertPropertyInScope(req.user, propertyId)
    // 10/2 (review): a link's reservation is settled with it (below) — so one
    // whose site already went to a guest who paid first is refused before any
    // money moves, and a link that holds a site keeps its stay in the cart.
    // 10/2 (decisions #9): does settling this link pay its reservation in full?
    // A link carrying the stay pays all of it; so does the arrival-day balance
    // link, or a link whose amount covers what is left.
    // A link carrying the stay pays all of what is left on it; a
    // deposit/balance/amount link pays it in full when what it charges
    // covers what is owed (the arrival-day balance link is the rest only while
    // nothing else has been paid toward it — no exemption).
    const linkPaysInFull = !!linkRes && (!!linkRes.stay || linkRes.charge >= linkRes.due.owed - 0.005)
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
      if (!propertyId) throw new AppError(400, 'Pick the property at the top of the register first, then press Charge again.')
      if (tenantId && posCustomerId) {
        throw new AppError(400, 'A charge account is one person\'s — remove the customer (×), pick just the one it is for, then press Charge again.')
      }
      if (!tenantId && !posCustomerId) {
        throw new AppError(400, 'Pick who this charge account is for, then press Charge again.')
      }
      // chargeEligible check — every linked POS item must be eligible.
      // Walk-up "misc" items (no item.id) are NOT chargeable; they
      // require a real catalog entry with charge_eligible=true.
      // 10/3: a link's reservation line is on the account too.
      const chargeLines = linkResLine ? [linkResLine, ...items] : items
      const linkedIds = chargeLines.filter((it: any) => !!it.id).map((it: any) => it.id)
      if (linkedIds.length !== chargeLines.length) {
        throw new AppError(400, 'Every line on a charge account must be a register item — take that line out, then press Charge again.')
      }
      const eligible = await query<{ id: string }>(
        `SELECT id FROM pos_items
          WHERE id = ANY($1::uuid[])
            AND landlord_id = $2
            AND charge_eligible = TRUE`,
        [linkedIds, posLandlordId(req)],
      )
      if (eligible.length !== linkedIds.length) {
        throw new AppError(400, 'Something in the cart cannot go on a charge account — take it out (ring it on its own with cash or card), then press Charge again.')
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
        throw new AppError(404, 'They have no charge account at this property — take cash or a card instead, then press Charge again.')
      }
      if (account.status !== 'active') {
        throw new AppError(409, `Their charge account is ${account.status === 'suspended' ? 'on hold' : 'closed for now'} — take cash or a card instead, then press Charge again.`)
      }
      if (account.landlord_id !== posLandlordId(req)) {
        throw new AppError(403, 'That charge account belongs to another company — take cash or a card instead, then press Charge again.')
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
      const t = /^[0-9a-f-]{36}$/i.test(String(openTicketId)) ? await queryOne<{ booking_id: string | null; unit_id: string | null; property_id: string; landlord_id: string; items: any }>(
        `SELECT t.booking_id, b.unit_id, t.property_id, t.landlord_id, t.items
           FROM pos_open_tickets t
           LEFT JOIN unit_bookings b ON b.id = t.booking_id
          WHERE t.id = $1 AND t.landlord_id = $2`,
        [openTicketId, posLandlordId(req)]) : null
      if (!t) throw new AppError(404, 'That ticket is not on the open list any more — nothing was charged. Press Clear, then open the list to see what is still out.')
      // 10/2 (review): a ticket is settled into its own property's books, by
      // somebody who works that property.
      if (t.property_id !== propertyId) {
        throw new AppError(400, 'That ticket is for another property — nothing was charged. Switch the register to that property, then press Charge again.')
      }
      // 10/3 (review): a ticket whose reservation is over gave up its stay
      // (releaseReservationTickets) — it settles as an ordinary ticket.
      ticketBookingId = t.booking_id && await ticketCarriesStay(db, t) ? t.booking_id : null
    }

    // 10/2 (decisions #9): a reservation ticket charges THE RESERVATION'S OWN
    // PRICE — what its quote still owes — checked against what the cart shows
    // before any money moves (priceReservationCart). Its site and dates were
    // settled on the schedule; nothing about the stay is read from the cart.
    // A pay link's stay was arranged when the link was made; its line is a
    // plain amount here, not a booking to place. (The cashier's cart for a
    // link is charged as sent, stay lines included, at the prices on it.)
    let reservation: ReservationDue | null = null
    let stayLines: any[] = []
    // 10/5 (Nic): the stay rung here — priced whole (R5), a month added (R6),
    // what it needs (R1/R2/R8) — read once and written as it was priced.
    let stayPlan: CounterStayPlan | null = null
    let pricedItems: any[]
    if (ticketBookingId) {
      const r = await priceReservationCart(posLandlordId(req), ticketBookingId, items, discountAmount, 'Charge')
      reservation = r.due
      pricedItems = r.items
    } else {
      // S652 (Nic): the site's rate IS the price, so the cart the server totals
      // is not quite the cart the browser sent — a stay line is repriced from the
      // site before anything is added up. Done here, above serverCartTotals, so
      // tax, the card fee and the amount checked against the card reader's
      // authorization all come out of the same number the booking records.
      // 10/3 (decisions #9, #21): priced by the schedule's own pricing for the
      // nights picked (priceCounterStay) — the same figure a pay link and the
      // schedule charge for them — as one line with its lodging tax inside.
      // 10/5: or the stay a month is added to (R6), with the guest's email and
      // the counter's lease answer — every answer the stay needs is checked
      // here, before any money moves (assertStayAnswered).
      const stayAt = stay ? counterStayAt([], stay) : null
      assertMayAttestReturning(req, stayAt)
      const hasStayAt = !!stayAt
      const counter = payLink ? { items, stayLines: [] as any[], plan: null }
        : await priceCounterStay(posLandlordId(req), propertyId, items, stayAt, 'Charge', discountAmount, { strict: true })
      stayLines = counter.stayLines
      stayPlan = counter.plan
      if (paymentMethod === 'charge' && (stayPlan?.screeningFee ?? 0) > 0) throw new AppError(400, CHARGE_ACCOUNT_NO_SCREENING)
      if (stayLines.length && !hasStayAt) {
        throw new AppError(400,
          'A stay needs a site and an arrival date before it can be rung up — pick them for the stay in the cart, then press Charge again.')
      }
      if (!stayLines.length && stay) {
        throw new AppError(400, 'Nothing in this cart is a stay any more — press Clear, then ring the sale again.')
      }
      pricedItems = counter.items
      // 10/3: a pay link's reservation, as one line at what it charges.
      if (linkResLine) pricedItems = [linkResLine, ...pricedItems]
    }

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
    let saleTenantId: string | null = tenantId || null
    let cardIdentity: CardIdentity | null = null
    let cardCustomer: CardCustomer | null = null
    let cardOutcome: CardOutcome | null = null
    if (paymentMethod === 'card' && !stripePaymentIntentId) {
      throw new AppError(400, 'A card is taken on the card reader — connect the reader, then press Charge again.')
    }
    // S654: a card the reader took is a card sale — never recorded as cash or a
    // charge account, which would leave the card authorized and uncaptured.
    if (stripePaymentIntentId && paymentMethod !== 'card') {
      throw new AppError(400, 'A card from the reader can only be recorded as a card sale — press Charge again.')
    }

    // 10/2 (review): ONE PAYMENT, ONE CHARGE — settled before any money moves.
    // A pay link's card page may be open on the payer's phone right now: it is
    // closed at Stripe first, and if the payer already finished paying on it,
    // nothing is charged here. A sale that pays a reservation in full does the
    // same for every OTHER link on it (a deposit link still in their inbox).
    // 10/2 (review): the page is read fresh, just before it is closed, and the
    // link is claimed below only while that is still its page — a payer who
    // opens the link on their phone while the sale goes through gets a new
    // page that would stay payable after the sale; the sale is refused instead.
    let linkPageClosed: string | null = null
    if (payLink) {
      let page: { page: 'none' | 'closed' | 'paid'; closedId: string | null }
      try { page = await closeLinkPageNow(payLink.id) } catch (e) {
        logger.warn({ err: e, payLinkId: payLink.id }, '[POS] could not close the pay link\'s card page before charging it')
        throw new AppError(503, LINK_PAGE_STUCK)
      }
      if (page.page === 'paid') throw new AppError(409, LINK_PAID_ONLINE)
      linkPageClosed = page.closedId
    }
    const paidInFullHere: string | null = ticketBookingId ?? (payLink?.booking_id && linkPaysInFull ? payLink.booking_id : null)
    // The other links' pages closed here; the sale is refused if one opened a new page meanwhile (closeIfPaidInFull).
    let otherPagesClosed: PagesClosed | undefined
    if (paidInFullHere) {
      let others: { outcome: 'closed' | 'paid'; pages: PagesClosed }
      try { others = await closeOtherLinkCheckouts(paidInFullHere, payLink?.id ?? null) } catch (e) {
        logger.warn({ err: e, bookingId: paidInFullHere }, '[POS] could not close the card page of another link on this reservation')
        throw new AppError(503, 'The card page of a pay link sent for this reservation could not be closed just now — nothing was charged. Wait a moment, then press Charge again.')
      }
      if (others.outcome === 'paid') {
        throw new AppError(409, 'That reservation was just paid online — nothing was charged here. Press Clear, then open it again to see what is still owed.')
      }
      otherPagesClosed = others.pages
    }
    // Links the sale closes (its reservation paid in full); their card pages are closed once it commits.
    let closedWithSale: ClosedLink[] = []
    let linkScreeningAfterCommit: (() => Promise<void>) | null = null

    // 10/5 (Nic, A5) — THE BACKGROUND CHECK IS GAM'S MONEY, NEVER BOTH WAYS.
    // A card (the reader, a card on file) lands on GAM's balance: the check's
    // part stays there — out of the landlord's payout share — and nothing is
    // charged back. Cash, a check or a money order is in the landlord's drawer:
    // GAM takes the fee from their next payout (recordScreeningPrepayment).
    // One already recorded for the stay is not GAM's twice — it stays the
    // landlord's to give back (and is logged).
    const screeningCollector = screeningCollectedBy(paymentMethod)
    const screeningAmount = (stayPlan?.screeningFee ?? 0) > 0 ? stayPlan!.screeningFee
      : ticketScreening?.price ?? linkScreening?.price ?? 0
    const screeningBooking = ticketScreening?.bookingId ?? linkScreening?.bookingId ?? stayPlan?.ext?.bookingId ?? null
    const gamKeeps = screeningAmount > 0 && screeningCollector === 'gam'
      && !(screeningBooking && await screeningAlreadyPaid(screeningBooking)) ? round2(screeningAmount) : 0

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
    // 10/2: the card on file is HELD until the sale is written, then captured
    // with it; a sale that cannot be written lets the hold go.
    let cardOnFileHeld: string | null = null
    const releaseCardOnFile = async () => {
      if (!cardOnFileHeld) return
      const held = cardOnFileHeld
      cardOnFileHeld = null
      const { releaseSavedCardHold } = await import('../services/posCardOnFile')
      await releaseSavedCardHold(held).catch((e) =>
        logger.error({ err: e, paymentIntentId: held }, '[POS] could not release a card-on-file hold for a sale that was not written'))
    }
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
      if (charged.held) cardOnFileHeld = charged.paymentIntentId
      cardOnFileLabel = [card.brand, card.last4].filter(Boolean).join(' ••••') || null
    }
    if (paymentMethod === 'card' && stripePaymentIntentId) {
      const intent = await retrieveTerminalPaymentIntentWithCharge({ paymentIntentId: stripePaymentIntentId })
      cardIdentity = cardIdentityFromIntent(intent)
      if (intent.metadata?.gam_purpose !== 'pos_terminal') {
        throw new AppError(400, 'That card charge was not started at this register — nothing was taken. Press Charge again.')
      }
      if (intent.metadata?.gam_landlord_id !== posLandlordId(req)) {
        throw new AppError(403, 'That card charge belongs to a different company — nothing was taken. Switch the register to the right property, then press Charge again.')
      }
      // S648: the register sends the charge here still authorized-only; the
      // sale and the capture commit together (below), so money is never taken
      // without a sale on record to pay the landlord for.
      if (intent.status !== 'succeeded' && intent.status !== 'requires_capture') {
        throw new AppError(400, `The card charge is ${intent.status} — it was not approved. Press Charge to try the card again, or take another form of payment.`)
      }
      captureOnCommit = intent.status === 'requires_capture' ? intent.id : null
      const expectedCents = Math.round(total * 100)
      if (intent.amount !== expectedCents) {
        logger.warn({ paymentIntentId: intent.id, intentCents: intent.amount, cartCents: expectedCents }, '[POS] card charge does not match the cart')
        throw new AppError(400, 'The card charge did not match the cart — nothing was taken. Press Charge again.')
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
    const client = await getClient().catch(async (e) => { await releaseCardOnFile(); throw e })
    let txnOpen = false
    const inventoryNeedsPO: any[] = []  // queued during loop, fired post-commit

    try {
      await client.query('BEGIN')
      txnOpen = true
      // 10/2: a resident's sale carries their register record too, so their
      // cards and purchases live where everyone else's do — and a register
      // record that is a resident's names the resident on the sale.
      let personLastName = ''
      if (tenantId) {
        saleCustomerId = await residentRecord(client, posLandlordId(req), tenantId)
      }
      if (saleCustomerId) {
        const r = (await client.query<{ tenant_id: string | null; last_name: string | null }>(
          `SELECT c.tenant_id, COALESCE(u.last_name, c.last_name) AS last_name
             FROM pos_customers c LEFT JOIN tenants tn ON tn.id = c.tenant_id LEFT JOIN users u ON u.id = tn.user_id
            WHERE c.id = $1`, [saleCustomerId])).rows[0]
        saleTenantId = saleTenantId ?? r?.tenant_id ?? null
        personLastName = r?.last_name ?? ''
      }
      // S654 (Nic): the CARD is the customer — same card next time, same
      // person and their history; the printed name is the record's name.
      // 10/2: when somebody was picked, the card is THEIRS — put on their
      // record, or the card's unconfirmed record folded into theirs — by the
      // same rule as linking a sale afterward. Card bookkeeping never costs
      // the sale: anything it cannot do is left undone.
      if (cardIdentity && saleCustomerId) {
        const card = cardIdentity
        const person = { id: saleCustomerId, lastName: personLastName }
        cardOutcome = await withSavepoint(client,
          () => applyCardToPerson(client, { landlordId: posLandlordId(req), card, person }),
          (e) => { logger.warn({ err: e }, '[POS] card not put on the picked person'); return { kind: 'none' } as CardOutcome })
      } else if (cardIdentity) {
        cardCustomer = await findOrCreateCustomerForCard(client, { landlordId: posLandlordId(req), card: cardIdentity })
        saleCustomerId = cardCustomer.customerId
        // A card already linked to a resident names the resident on this sale too.
        saleTenantId = (await client.query<{ tenant_id: string | null }>(
          `SELECT tenant_id FROM pos_customers WHERE id = $1`, [saleCustomerId])).rows[0]?.tenant_id ?? null
      }

      // S652: a ticket is CLAIMED inside the sale's own transaction, and only
      // if it is still open. Two drivers opening the same ticket on two phones
      // is the ordinary case, not the exotic one, and the second one has to
      // lose rather than charge somebody twice for the same tank.
      if (openTicketId) {
        const claimed = await client.query(
          `UPDATE pos_open_tickets SET status='settled', settled_at=NOW(), updated_at=NOW()
            WHERE id=$1 AND landlord_id=$2 AND property_id=$3 AND status='open' RETURNING id`,
          [openTicketId, posLandlordId(req), propertyId])
        if (!claimed.rows.length) {
          throw new AppError(409, 'That ticket has already been settled or voided at another register — nothing was charged here. Press Clear, then open the list to see what is still out.')
        }
      }

      let tx: any
      try {
        // S648: the writes live in services/posSale so a paid pay link records
        // a sale exactly the way the counter does.
        const sale = await insertPosSale(client, {
          landlordId: posLandlordId(req), propertyId: propertyId || null, cashierId: req.user!.userId,
          paymentMethod, tenantId: saleTenantId, posCustomerId: saleCustomerId, subtotal, taxAmount, surcharge: surchargeAmt, total,
          changeGiven, platformFee, stripePaymentIntentId: stripePaymentIntentId ?? cardOnFileIntentId,
          discountAmount: discountAmt, discountReason,
          ...(paymentMethod === 'card' || paymentMethod === 'card_on_file'
            ? { payoutOwed: round2(Math.max(0, total - cardFee - gamKeeps)) } : {}),
          // 10/3 (decisions #21): a reservation's line is recorded at its price
          // less the lodging tax inside it, with that tax on the line.
          items: pricedItems.map((it: any) => (it?.[RESERVATION_LINE] ? reservationSaleLine(it, it[STAY_TAX]) : it)), taxBreakdown,
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
              WHERE id = $1 AND status = 'open' AND kind = 'one_time' AND property_id = $3
                AND (expires_at IS NULL OR expires_at > NOW())
                AND last_checkout_session_id IS NOT DISTINCT FROM $4 RETURNING id`, [payLink.id, tx.id, propertyId, linkPageClosed])
          if (!claimed.rows.length) {
            const now = (await client.query<{ status: string }>(`SELECT status FROM pos_pay_links WHERE id = $1`, [payLink.id])).rows[0]
            if (now?.status === 'open') throw new AppError(409, linkOpenedMeanwhileWords('charged', 'Charge'))
            throw new AppError(409, 'That pay link was paid a moment ago — nothing was charged here. Press Clear; it is no longer owed.')
          }
          await client.query(`UPDATE pos_transactions SET pay_link_id = $2 WHERE id = $1`, [tx.id, payLink.id])
          // 10/2 (review): paid at the desk is paid — the link's reservation is
          // the guest's, exactly as when it is paid online (settleLinkBooking):
          // confirmed and no longer an unpaid hold another payer can take.
          // (decisions #23: its nights, site and price are the schedule's —
          // nothing about the booking is changed here but that it is paid.)
          if (linkRes) {
            // Read again under the booking's lock: a reservation cancelled,
            // marked a no-show, paid, repriced or part paid a moment ago is
            // refused here too (the sale rolls back, nothing is taken) — the
            // figure charged is the one the reservation owes right now.
            const now = await linkReservation(client, payLink, { lock: true, press: 'Charge' })
            if (!now || Math.round(now.charge * 100) !== Math.round(linkRes.charge * 100)) {
              throw new AppError(409, now ? linkReservationNowWords(now, 'Charge')
                : 'That pay link\'s reservation changed a moment ago — nothing was charged. Press Clear, open the link again from the list, then press Charge.')
            }
            await settleLinkBooking(client, payLink, tx.id, now.stay, null, now.charge)
            // 10/2 (decisions #9): paid in full now — every other way of paying it closes.
            closedWithSale = await closeIfPaidInFull(client, payLink.booking_id, { linkId: payLink.id, pages: otherPagesClosed })
          } else {
            // A link with no reservation of its own (a stay balance link marks its balance paid).
            await settleLinkBooking(client, payLink, tx.id, null)
          }
          // 10/5 (Nic, R8/A5): the background check it carried is GAM's, waiting
          // for the guest — by who holds the money for this tender.
          const rec = await recordLinkScreening(client, payLink, screeningCollector)
          if (gamKeeps > 0 && !(rec && rec.gamKeeps > 0)) throw new AppError(409, SCREENING_PAID_MEANWHILE)
          linkScreeningAfterCommit = rec?.afterCommit ?? null
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
      let displacedHolds: import('../services/holdDisplacement').DisplacementOutcome[] = []
      // S652 — A TICKET THAT CARRIES A RESERVATION CONFIRMS IT; IT DOES NOT
      // BOOK A SECOND ONE.
      //
      // Nic's walk-in: a spot found on the schedule, paid for at the counter.
      // The site left the calendar when it was chosen, so by the time the
      // cashier rings it there is already a booking — held and unpaid. Writing
      // a new one here would sell the same site twice in the same breath: the
      // guest's own hold would collide with the sale that is paying for it.
      if (ticketBookingId) {
        // 10/2 (review): rung here, the stay is paid in full — nothing is left
        // to bill on arrival day (services/stayBalance bills what a deposit
        // left; with no deposit on record it would bill the whole stay again).
        // 10/2 (decisions #9): paid what the reservation owed, read again under
        // lock — a deposit that landed online, or a price changed on the
        // schedule, a moment ago is not paid over here. The booking's own price
        // is never touched: the quote is the price.
        const now = await reservationDue(client, ticketBookingId, { lock: true })
        assertReservationChargeable(now)
        if (Math.round(now.owed * 100) !== Math.round(reservation!.owed * 100)) {
          throw new AppError(409, reservationNowWords(now, 'Charge'))
        }
        // 10/3 (decisions #15): a stay its lease bills is paid its DEPOSIT here
        // — recorded as the deposit, never as the stay paid in full — and its
        // lease bills the rest. Any other stay is paid in full.
        const confirmed = await client.query(
          `UPDATE unit_bookings
              SET status = CASE WHEN status = 'tentative' THEN 'confirmed' ELSE status END,
                  deposit_amount = CASE WHEN $3::boolean THEN $4::numeric ELSE deposit_amount END,
                  deposit_paid_at = COALESCE(deposit_paid_at, NOW()),
                  hold_expires_at = NULL, pos_transaction_id = COALESCE(pos_transaction_id, $2),
                  balance_billed_at = CASE WHEN $3::boolean THEN balance_billed_at ELSE COALESCE(balance_billed_at, NOW()) END,
                  balance_paid_at = CASE WHEN $3::boolean THEN balance_paid_at ELSE COALESCE(balance_paid_at, NOW()) END,
                  updated_at = NOW()
            WHERE id = $1
            RETURNING id, check_in::text AS check_in, check_out::text AS check_out, nights`,
          [ticketBookingId, tx.id, now.leaseBillsRest, round2(now.paid + now.owed)])
        // 10/2 (decisions #9): paid in full — every other way of paying it closes.
        closedWithSale = await closeIfPaidInFull(client, ticketBookingId, { ticketId: openTicketId, pages: otherPagesClosed })
        // 10/4 (decisions #37.B, #38): what this sale paid toward the stay, and
        // how — an early check-out gives it back that way.
        await recordSaleTowardStay(client, { bookingId: ticketBookingId, saleId: tx.id, toward: now.owed })
        stayBooking = {
          bookingId: confirmed.rows[0].id,
          checkIn: confirmed.rows[0].check_in,
          checkOut: confirmed.rows[0].check_out,
          nights: confirmed.rows[0].nights,
        }
      } else if (stayLines.length && stayPlan?.ext) {
        // 10/5 (Nic, R6): Add a month — the SAME booking runs a calendar month
        // longer, the month at the monthly rate on its own, paid here. A site
        // somebody else has for any of those nights is refused (a month never
        // moves another guest's hold) and the sale rolls back.
        const ext = await extendStayByMonth(client, { landlordId: posLandlordId(req), propertyId, bookingId: stayPlan.ext.bookingId })
        if (Math.round(ext.price * 100) !== Math.round(stayPlan.charge * 100) || ext.checkOut !== stayPlan.checkOut) {
          throw new AppError(409, `That stay changed a moment ago — nothing was charged. Tap the stay above Charge, pick it again, then press Charge again.`)
        }
        if (stayPlan.email && !ext.guestEmail) {
          await client.query(`UPDATE unit_bookings SET guest_email = $2 WHERE id = $1 AND guest_email IS NULL`, [ext.bookingId, stayPlan.email])
        }
        await payTowardStay(client, { bookingId: ext.bookingId, saleId: tx.id, amount: stayPlan.charge })
        stayBooking = { bookingId: ext.bookingId, checkIn: ext.checkIn, checkOut: ext.checkOut, nights: ext.nights }
      } else if (stayLines.length) {
        const { createStayBooking, checkOutFor } = await import('../services/registerStay')
        // 10/3 (S652 standing rule: an unpaid hold has no timer and yields to
        // anyone who PAYS): a sale at the counter is payment on the spot, so it
        // moves an unpaid hold on this site to an equivalent one, or bumps it
        // when the park is full — exactly as the schedule does (routes/units).
        // The guests are told after the commit.
        // A charge-account sale is not money changing hands — it never moves a
        // hold (10/3 review); createStayBooking refuses a held site as before.
        if (stay?.unitId && stay?.checkIn && paymentMethod !== 'charge') {
          const { clearUnpaidHolds } = await import('../services/holdDisplacement')
          const line = stayLines[0]
          const stayOut = checkOutFor(stay.checkIn, line.stayUnit, line.qty)
          // 10/3 (review): if the hold on this site is the SAME guest's own
          // (their emailed link or reservation ticket), selling them a fresh
          // stay would charge them twice. Stop and point at Settle.
          const own = (await client.query<{ guest_name: string | null }>(
            `SELECT h.guest_name FROM unit_bookings h
              WHERE h.unit_id = $1 AND h.status = 'tentative' AND h.deposit_paid_at IS NULL
                AND h.displaced_at IS NULL AND h.hold_expires_at IS NULL
                AND h.check_in < $3::date AND h.check_out > $2::date
                AND (EXISTS (SELECT 1 FROM pos_pay_links pl WHERE pl.booking_id = h.id AND pl.status = 'open')
                     OR EXISTS (SELECT 1 FROM pos_open_tickets t WHERE t.booking_id = h.id AND t.status = 'open'))
                AND (   ($4::text IS NOT NULL AND lower(h.guest_email) = lower($4))
                     OR ($5::text IS NOT NULL AND lower(trim(h.guest_name)) = lower(trim($5)))
                     OR ($6::uuid IS NOT NULL AND EXISTS (SELECT 1 FROM pos_pay_links pl2 WHERE pl2.booking_id = h.id AND pl2.pos_customer_id = $6))
                     OR ($7::uuid IS NOT NULL AND EXISTS (SELECT 1 FROM pos_pay_links pl3 WHERE pl3.booking_id = h.id AND pl3.tenant_id = $7)))
              LIMIT 1`,
            [stay.unitId, stay.checkIn, stayOut, (stay as any).guestEmail ?? null, stay.guestName ?? null,
             posCustomerId ?? null, tenantId ?? null])).rows[0]
          if (own) {
            throw new AppError(409, `That site is held for ${own.guest_name || 'this guest'} — if this is them, open their link or ticket from the open list and press Settle. Nothing was charged.`)
          }
          displacedHolds = await clearUnpaidHolds(client, stay.unitId, stay.checkIn, stayOut,
            'A paid sale at the counter took this site')
        }
        // 10/5 (Nic, R2): a lease chosen at the counter is paid its deposit
        // here — recorded as the deposit, its lease bills the rest (and
        // prorates by the property's setting); a stay is paid whole.
        const leaseChosen = stayPlan?.terms === 'lease'
        stayBooking = await createStayBooking(client, {
          landlordId: posLandlordId(req),
          propertyId,
          posTransactionId: tx.id,
          lines: stayLines,
          details: { ...stay, guestEmail: stayPlan?.email ?? stay?.guestEmail ?? null },
          stayTerms: stayPlan?.terms ?? null,
          // 10/6: a returning guest never waits on screening.
          screeningRequired: (stayPlan?.needs.nights ?? 0) >= STAY_SCREENING_NIGHTS && stayPlan?.needs.screening !== 'returning',
          depositAmount: leaseChosen ? stayPlan!.charge : null,
        })
        // 10/2 (review): paid in full at the counter — nothing left to bill on arrival day.
        if (!leaseChosen) {
          await client.query(
            `UPDATE unit_bookings SET balance_billed_at = COALESCE(balance_billed_at, NOW()), balance_paid_at = COALESCE(balance_paid_at, NOW())
              WHERE id = $1`, [stayBooking.bookingId])
        }
        // 10/4 (decisions #37.B, #38): the stay's share of this sale, itemized
        // (never more than the sale took before its card fee — or its
        // background check, which is GAM's, never the stay's).
        await recordSaleTowardStay(client, { bookingId: stayBooking.bookingId, saleId: tx.id,
          toward: Math.min(Number(stayPlan?.charge ?? stayLines[0].lineTotal) || 0, round2(total - surchargeAmt - (stayPlan?.screeningFee ?? 0))) })
      }
      // 10/5 (Nic, R8): the background check's fee taken with the stay is
      // GAM's screening money — recorded as a check waiting for the guest
      // (their link is emailed once the sale stands) and taken from the
      // landlord's next payout, cash or card alike. A guest with a check on
      // file pays nothing, but check-in still waits on it (R9).
      let screeningAfterCommit: (() => Promise<void>) | null = null
      // 10/6 (review): closes the card pages of links whose check fee came off (returning guest).
      let returningAfterCommit: (() => Promise<void>) | null = null
      if (stayPlan && stayBooking) {
        if (stayPlan.screeningFee > 0) {
          const rec = await recordScreeningPrepayment(client, {
            landlordId: posLandlordId(req), propertyId, bookingId: stayBooking.bookingId,
            email: stayPlan.email, amount: stayPlan.screeningFee, source: 'register', sourceId: tx.id,
            // 10/5 (A5): by card GAM already has it (kept out of the payout
            // share above); in cash or by check the landlord does.
            collectedBy: screeningCollector,
          })
          if (!rec.created) {
            if (gamKeeps > 0) throw new AppError(409, SCREENING_PAID_MEANWHILE)
            logger.error({ bookingId: stayBooking.bookingId, saleId: tx.id }, '[POS] a background-check fee was taken for a stay that already had one recorded — left in the sale for the landlord to give back')
          }
          screeningAfterCommit = rec.afterCommit
        } else if (stayPlan.needs.nights >= STAY_SCREENING_NIGHTS && stayPlan.needs.screening !== 'returning') {
          await markScreeningRequired(client, stayBooking.bookingId)
        }
        // 10/6 (Nic): "Returning guest — they've stayed with us before" — who
        // and when, on the stay, counted against the property's allowance
        // under its lock, with the sale or not at all.
        if (stayPlan.needs.returningAttestNow) {
          const r = await attestReturningGuest(client, { bookingId: stayBooking.bookingId, propertyId, byUserId: req.user!.userId, chainBookingIds: stayPlan.needs.chain.bookingIds })
          returningAfterCommit = r.afterCommit
        }
      }
      // 10/5 (Nic, M2): a reservation ticket's background check — sold from
      // the schedule, settled here — is recorded as the guest's prepaid check.
      if (ticketScreening) {
        const b = (await client.query<{ guest_email: string | null; tenant_id: string | null }>(
          `SELECT guest_email, tenant_id FROM unit_bookings WHERE id = $1`, [ticketScreening.bookingId])).rows[0]
        const rec = await recordScreeningPrepayment(client, {
          landlordId: posLandlordId(req), propertyId, bookingId: ticketScreening.bookingId,
          tenantId: b?.tenant_id ?? null, email: b?.guest_email ?? null,
          amount: ticketScreening.price, source: 'schedule', sourceId: tx.id, collectedBy: screeningCollector,
        })
        if (!rec.created) {
          if (gamKeeps > 0) throw new AppError(409, SCREENING_PAID_MEANWHILE)
          logger.error({ bookingId: ticketScreening.bookingId, saleId: tx.id }, '[POS] a ticket\'s background-check fee was taken for a stay that already had one recorded — left in the sale for the landlord to give back')
        }
        screeningAfterCommit = rec.afterCommit
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
      if (cardOnFileHeld) {
        const { captureSavedCard } = await import('../services/posCardOnFile')
        await captureSavedCard(cardOnFileHeld)
        cardOnFileHeld = null   // taken: from here the sale stands
      }

      await client.query('COMMIT')
      txnOpen = false
      await expireClosedLinks(closedWithSale)
      // 10/5 (Nic, R8): the guest's (already paid) background-check link.
      if (screeningAfterCommit) await screeningAfterCommit()
      if (returningAfterCommit) await returningAfterCommit()
      // 10/5 (Nic, R2): "either way, it goes to me" — a lease chosen drafts it
      // for the landlord; a stay with no lease is billed its site's utilities
      // (R11) and the landlord is told. Never a reason to undo the sale.
      let leaseId: string | null = null
      if (stayPlan?.terms && stayBooking && stayPlan.needs.nights >= STAY_LEASE_CHOICE_NIGHTS) {
        const chosen = await chooseStayTerms(stayBooking.bookingId, stayPlan.terms, { byUserId: req.user!.userId })
          .catch((e) => { logger.error({ err: e, bookingId: stayBooking!.bookingId, saleId: tx.id }, '[POS] the lease-or-stay answer could not be carried out after the sale'); return null })
        leaseId = chosen?.leaseId ?? null
      }
      // A pay link settled here: its background check, and its lease-or-stay answer, the same as paid online.
      if (linkScreeningAfterCommit) await linkScreeningAfterCommit()
      if (payLink) await afterLinkPaid(payLink, req.user!.userId)
      if (displacedHolds.length) {
        await import('../services/holdDisplacement')
          .then((m) => m.notifyDisplacedHolds(posLandlordId(req), propertyId, displacedHolds))
          .catch((e) => logger.error({ err: e, saleId: tx.id }, '[POS] could not tell guests their unpaid hold was moved'))
      }
      // 10/3 (review): paid toward a reservation but not in full — other links'
      // open card pages may ask more than is left now; those pages close.
      if (linkRes && !linkPaysInFull) await closeStaleLinkPages(payLink.booking_id, payLink.id)
      // 10/3 (review): paid toward it, something still owed, and nothing set to
      // ask for it — the landlord is told once (posPayLinks tellLandlordIfLeftOwed).
      if (linkRes && !linkPaysInFull) {
        await tellLandlordIfLeftOwed({ link: payLink, saleId: tx.id, paid: linkRes.charge, payer: payLink.customer_name ?? null })
          .catch((e) => logger.error({ err: e, payLinkId: payLink.id, saleId: tx.id }, '[POS] could not tell the landlord what is still owed on a reservation'))
      }

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
        // 10/2 (review): the email on a resident's own account only while they
        // live here (recordContactSql) — never to a company with a looser tie,
        // and never to one they have left (decisions #10).
        const c = await queryOne<any>(
          `SELECT c.id, c.tenant_id, COALESCE(u.first_name, c.first_name) AS first_name, COALESCE(u.last_name, c.last_name) AS last_name,
                  ${recordContactSql('c', 'u').email} AS email
             FROM pos_customers c LEFT JOIN tenants tn ON tn.id = c.tenant_id LEFT JOIN users u ON u.id = tn.user_id
            WHERE c.id = $1`, [saleCustomerId])
        // 10/2 (review): "N previous purchases" is THIS company's count — a
        // resident who also buys at another company's register brings none
        // of those sales here.
        const prior = await queryOne<{ n: string }>(
          `SELECT COUNT(*)::text AS n FROM pos_transactions
            WHERE id <> $2 AND landlord_id = $4 AND (pos_customer_id = $1 OR ($3::uuid IS NOT NULL AND tenant_id = $3))`,
          [saleCustomerId, tx.id, c?.tenant_id ?? null, posLandlordId(req)])
        const isResident = !!c?.tenant_id
        // Whose the tapped card is now, and whether it is already kept.
        const k = cardIdentity ? await queryOne<{ pos_customer_id: string; stripe_payment_method_id: string | null }>(
          `SELECT pos_customer_id, stripe_payment_method_id FROM pos_customer_cards WHERE landlord_id = $1 AND fingerprint = $2`,
          [posLandlordId(req), cardIdentity.fingerprint]) : null
        const cardIsTheirs = !!k && k.pos_customer_id === saleCustomerId
        const cardSaved = cardIsTheirs && !!k?.stripe_payment_method_id
        // Only what is missing is asked on the reader: keep the card (when the
        // tap yielded a reusable one and it is theirs), a name (phone wallets
        // carry none — and never once somebody was picked), an email for the
        // receipt. 10/2: a resident is never asked — card on file is for
        // guests, and their email is on their account.
        const asks = {
          askSave:  !!(cardIdentity?.generatedCard && cardIsTheirs && !cardSaved && !isResident),
          askName:  !!(cardCustomer && c && c.first_name === 'Card' && c.last_name === 'Customer'),
          askEmail: !!(cardIdentity && c && !c.email && !isResident),
        }
        let prompting = false
        if (saleReaderId && (asks.askSave || asks.askName || asks.askEmail)
            && await assertReaderBelongsToLandlord(posLandlordId(req), saleReaderId)) {
          prompting = await startSaveCardPrompt(saleReaderId, asks)
        }
        const said = cardOutcome ? cardOutcomeSentence(cardOutcome) : null
        customerOut = c ? {
          id: c.id, firstName: c.first_name, lastName: c.last_name, email: c.email,
          isResident, tenantId: c.tenant_id ?? null,
          last4: cardIdentity?.last4 ?? null, brand: cardIdentity?.brand ?? null,
          isNew: cardCustomer?.isNew ?? false, priorPurchases: Number(prior?.n ?? 0),
          cardSaved, cardKeepable: !!cardIdentity?.generatedCard,
          // 10/2: what happened to the card, when the clerk should know — the
          // earlier sales on it are theirs now, or it is somebody else's card.
          cardNote: said && cardOutcome && cardOutcome.kind !== 'attached' && cardOutcome.kind !== 'already'
            ? `${said.charAt(0).toUpperCase()}${said.slice(1)}.` : null,
          // 10/2 (review): the card's record and its other sales folded into the
          // person picked — Undo puts them back if the pick was wrong.
          cardUndo: c ? saleTimeUndo({ landlordId: posLandlordId(req), userId: req.user!.userId, saleId: tx.id,
            customerId: c.id, tenantId: tx.tenant_id ?? null, outcome: cardOutcome }) : null,
          prompting, asks: prompting ? asks : null, readerId: prompting ? saleReaderId : null,
        } : null
      }
      // 10/3 (review): the sale's own lines — a reservation's or a stay's at
      // its price before its lodging tax — so the receipt's lines and tax add
      // up to its total.
      const saleLines = pricedItems.map((it: any) => (it?.[RESERVATION_LINE] ? reservationSaleLine(it, it[STAY_TAX]) : it))
        .filter((it: any) => Number(it?.qty) > 0)
        .map((it: any) => ({ id: it.id ?? null, name: String(it.name ?? 'Item'), qty: Number(it.qty) || 0, price: Number(it.price) || 0, tax: Number(it.tax) || 0 }))
      // 10/5 (Nic, R13): a 30+ night stay with no lease is held only through
      // what is paid — the receipt says so (stayHeldWords, the one sentence).
      const stayOut = stayBooking ? {
        ...stayBooking,
        terms: stayPlan?.terms ?? null, leaseId,
        heldWords: stayPlan && stayPlan.terms === 'stay' && stayPlan.needs.nights >= STAY_LEASE_CHOICE_NIGHTS ? stayHeldWords(stayBooking.checkOut) : null,
        screeningFee: stayPlan && stayPlan.screeningFee > 0 ? stayPlan.screeningFee : null,
        screeningEmail: stayPlan && stayPlan.screeningFee > 0 ? stayPlan.email : null,
      } : null
      res.status(201).json({ success: true, data: { ...tx, stayBooking: stayOut, customer: customerOut, items: saleLines } })
    } catch (e) {
      if (txnOpen) await client.query('ROLLBACK').catch(() => {})
      await releaseCardOnFile()
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
    // 10/2: a cashier sees the properties they are assigned to, nothing more.
    const { propertyId: salesProp, scoped } = await salesScope(req)
    const propFilter = salesProp ? `AND t.property_id = $2` : scoped ? `AND t.property_id = ANY($2::uuid[])` : ''
    const salesParams: any[] = salesProp ? [posLandlordId(req), salesProp] : scoped ? [posLandlordId(req), scoped] : [posLandlordId(req)]

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
    const tx = /^[0-9a-f-]{36}$/i.test(String(req.params.id))
      ? await queryOne<any>('SELECT * FROM pos_transactions WHERE id=$1 AND landlord_id=$2', [req.params.id, posLandlordId(req)]) : null
    if (!tx) throw new AppError(404, SALE_GONE)
    await assertSaleInScope(req.user, tx.property_id)
    if (tx.status === 'voided') throw new AppError(400, 'That sale was voided, so there is nothing to refund — press Cancel.')

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
        throw new AppError(400, 'A refund is paid back in cash or by check — pick one, then press Refund again.')
      }
      resolvedMethod = picked
    }

    // Coerce both sides to numbers: tx.total comes back from pg numeric
    // as a string, and amount may arrive as a number or string from JSON.
    const refundAmt = Number(amount ?? tx.total)
    if (!Number.isFinite(refundAmt) || refundAmt <= 0) throw new AppError(400, 'Type how much to refund (more than $0), then press Refund again.')
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
        throw new AppError(409, 'This charge-account sale cannot be refunded here — its charge was not found on the account. Press Cancel and ask the owner to check the account.')
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
    // 10/3 (review): read the status again under the lock — a Void that
    // committed while this refund waited has already told the clerk to hand
    // the money back (and restocked), so a refund now would pay out twice.
    const locked = (await client.query<{ status: string }>(
      'SELECT status FROM pos_transactions WHERE id=$1 FOR UPDATE', [tx.id])).rows[0]
    if (!locked) throw new AppError(404, SALE_GONE)
    if (locked.status === 'voided') throw new AppError(400, 'That sale was voided, so there is nothing to refund — press Cancel.')
    // 10/4 (fix round 2): a card refund Stripe sent back no longer counts as
    // refunded (pos_refunds.reversed_at) — what is still owed to the guest is
    // its open replacement, below.
    const priorRefunded = Number((await client.query<{ s: string }>(
      `SELECT COALESCE(SUM(amount),0)::text AS s FROM pos_refunds WHERE transaction_id=$1 AND reversed_at IS NULL`,
      [tx.id])).rows[0].s)
    // 10/4 (decisions #38, fix round 2): while an early check-out refund to
    // the card on this sale has not gone out yet (sending, or waiting for Try
    // again), the register refunds nothing on the sale: handing that money
    // back here as well would pay it twice when Try again sends it. It is
    // finished from the stay's Check out window (Try again, or Give it back in
    // cash instead), and only then can anything more be refunded here.
    const { saleRefundsWaiting } = await import('../services/earlyCheckOut')
    const waiting = await saleRefundsWaiting(client, tx.id)
    if (waiting > 0.005) {
      throw new AppError(409, `This sale has a $${waiting.toFixed(2)} refund to the card waiting for a guest who left early, so nothing was refunded here. `
        + `Finish that first on the schedule: open the stay's Check out window and press Try again, or Give it back in cash instead.`)
    }
    // 10/5 (Nic, R8): a background check paid with a stay is GAM's and is not
    // refunded ("charged whether or not they complete the check") — the
    // drawer never hands it back, and it is taken from the landlord's payout.
    const screeningKept = Number((await client.query<{ s: string }>(
      `SELECT COALESCE(SUM(amount), 0)::text AS s FROM screening_prepayments
        WHERE status <> 'void' AND source_id IS NOT NULL AND source_id IN ($1, $2)`,
      [tx.id, tx.pay_link_id ?? tx.id])).rows[0].s)
    const remaining = Math.round((txTotalNum - priorRefunded - screeningKept) * 100) / 100
    if (screeningKept > 0 && refundAmt > remaining + 0.005) {
      throw new AppError(400, `$${screeningKept.toFixed(2)} of this sale is the guest's background check, which is not refunded — `
        + `$${Math.max(0, remaining).toFixed(2)} at most can be refunded here. Change the amount, then press Refund again.`)
    }
    if (refundAmt > remaining + 0.005) {
      throw new AppError(400, priorRefunded > 0
        ? `That is more than is left to refund — $${remaining.toFixed(2)} at most ($${priorRefunded.toFixed(2)} was already refunded). Change the amount, then press Refund again.`
        : `That is more than the sale — $${txTotalNum.toFixed(2)} at most. Change the amount, then press Refund again.`)
    }
    const cumulativeRefunded = Math.round((priorRefunded + refundAmt) * 100) / 100
    // Everything that can be refunded was (a background check it carried stays GAM's).
    const isFullRefund = cumulativeRefunded >= txTotalNum - screeningKept - 0.005

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

    // 10/3 (review, decisions #23): a refund never touches a reservation — the
    // schedule is where stays change. Say so, so the clerk cancels it there
    // when the guest is not staying. (A stay already checked out is over —
    // nothing on the schedule is left to cancel.)
    const live = await queryOne<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM unit_bookings b
        WHERE b.status NOT IN ('cancelled','no_show','checked_out')
          AND (b.pos_transaction_id = $1
               OR b.id = (SELECT booking_id FROM pos_pay_links WHERE id = $2)
               OR b.id = (SELECT booking_id FROM pos_open_tickets WHERE id = $3))`,
      [tx.id, tx.pay_link_id ?? null, tx.open_ticket_id ?? null]).catch(() => null)
    res.json({ success: true, data: { refundAmount: refundAmt, refundMethod: resolvedMethod,
      reservationStillOnSchedule: Number(live?.n ?? 0) > 0 } })
  } catch (e) {
    if (txnOpen) await client.query('ROLLBACK').catch(() => {})
    next(e)
  } finally {
    client.release()
  }
})

/**
 * 10/3 (review) — WHICH SALES A VOID MAY TOUCH. A void says the sale never
 * happened. It is refused where money really moved or something rides on the
 * sale:
 *   - 'card': a card (or card on file) was charged — voiding would leave the
 *     money taken with no sale to pay the landlord for. Refund instead.
 *   - 'pay_link': the sale paid a pay link — voiding would leave the link paid
 *     (and any reservation on it confirmed) with no sale behind it.
 *   - 'stay': the sale paid for a stay (a booking names it, or a line is a
 *     stay) — voiding would leave the stay paid with no sale behind it. Refund
 *     the money; cancel the stay on the schedule.
 *   - 'charge': 10/3 (review) the sale went on the customer's charge account —
 *     a void would leave the charge on their account (the statement run bills
 *     it) with no sale behind it. Refund takes it off their account.
 *   - 'ticket': 10/3 (review) the sale settled a delivery ticket — a void would
 *     leave the ticket settled and the goods owed nowhere. Refund instead.
 * One SQL expression (null when a void is allowed), read by the void itself
 * and by History, which offers Void only where it would go through.
 */
const voidBlockedSql = (t: string) => `CASE
  WHEN ${t}.payment_method IN ('card', 'card_on_file') THEN 'card'
  WHEN ${t}.payment_method = 'charge' THEN 'charge'
  WHEN ${t}.pay_link_id IS NOT NULL THEN 'pay_link'
  WHEN EXISTS (SELECT 1 FROM unit_bookings vb WHERE vb.pos_transaction_id = ${t}.id)
    OR EXISTS (SELECT 1 FROM pos_transaction_items vti JOIN pos_items vpi ON vpi.id = vti.item_id
                WHERE vti.transaction_id = ${t}.id AND vpi.stay_unit IS NOT NULL) THEN 'stay'
  WHEN ${t}.open_ticket_id IS NOT NULL THEN 'ticket'
  ELSE NULL END`
type VoidBlocked = 'card' | 'charge' | 'pay_link' | 'stay' | 'ticket'
const VOID_BLOCKED_WORDS: Record<VoidBlocked, string> = {
  card: 'This sale was paid by card, so it cannot be voided — the card was charged. Press Refund instead to give the money back.',
  charge: 'This sale is on their charge account, so it cannot be voided. Press Refund instead; that takes it off their account.',
  pay_link: 'This sale paid a pay link, so it cannot be voided — press Refund to give the money back. If it paid for a stay, cancel the stay on the schedule.',
  stay: 'This sale paid for a stay, so it cannot be voided — press Refund to give the money back, and cancel the stay on the schedule.',
  ticket: 'This sale settled a delivery ticket, so it cannot be voided — the ticket stays settled. Press Refund instead to give the money back.',
}

/**
 * A void says the sale never happened: the sale is marked voided and, 10/3
 * (review), what it took off the shelf goes back — each stock movement the
 * sale made (pos_inventory_log 'sale' rows), by what it actually took (a shelf
 * already at 0 took nothing). All in one transaction with the sale locked, so
 * two presses void (and restock) once.
 */
posRouter.post('/transactions/:id/void', requirePerm('pos.void'), async (req, res, next) => {
  try {
    const { reason } = req.body
    const tx = /^[0-9a-f-]{36}$/i.test(String(req.params.id))
      ? await queryOne<any>('SELECT * FROM pos_transactions WHERE id=$1 AND landlord_id=$2', [req.params.id, posLandlordId(req)]) : null
    if (!tx) throw new AppError(404, SALE_GONE)
    await assertSaleInScope(req.user, tx.property_id)
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const now = (await client.query<{ status: string; why: string | null }>(
        `SELECT t.status, ${voidBlockedSql('t')} AS why FROM pos_transactions t WHERE t.id = $1 FOR UPDATE OF t`, [tx.id])).rows[0]
      if (!now) throw new AppError(404, SALE_GONE)
      if (now.status !== 'completed') throw new AppError(400, `That sale was already ${now.status === 'voided' ? 'voided' : 'refunded'}, so it cannot be voided — press Cancel.`)
      // 10/3 (review): never a card or charge-account sale, or one that paid a
      // pay link, a stay or a delivery ticket (voidBlockedSql).
      if (now.why) throw new AppError(409, VOID_BLOCKED_WORDS[now.why as VoidBlocked])
      await client.query('UPDATE pos_transactions SET status=$1, void_reason=$2 WHERE id=$3',
        ['voided', reason || null, tx.id])
      const took = (await client.query<{ item_id: string; qty: string }>(
        `SELECT item_id, SUM(stock_before - stock_after)::text AS qty FROM pos_inventory_log
          WHERE reference_id = $1 AND landlord_id = $2 AND reason = 'sale'
          GROUP BY item_id`, [tx.id, posLandlordId(req)])).rows
      for (const t of took) {
        const qty = Number(t.qty)
        if (!(qty > 0)) continue
        const item = (await client.query<{ stock_qty: string }>(
          `SELECT stock_qty FROM pos_items WHERE id = $1 AND landlord_id = $2 FOR UPDATE`, [t.item_id, posLandlordId(req)])).rows[0]
        if (!item) continue
        const before = Number(item.stock_qty)
        const after = before + qty
        await client.query('UPDATE pos_items SET stock_qty = $1, updated_at = NOW() WHERE id = $2', [after, t.item_id])
        await client.query(`INSERT INTO pos_inventory_log (item_id, landlord_id, change_qty, reason, notes, reference_id, stock_before, stock_after)
          VALUES ($1, $2, $3, 'return', 'Sale voided', $4, $5, $6)`, [t.item_id, posLandlordId(req), qty, tx.id, before, after])
      }
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally { client.release() }
    res.json({ success: true })
  } catch (e) { next(e) }
})

// GET /api/pos/transactions — full list with status
posRouter.get('/transactions', requirePerm('pos.ring_sale', 'pos.end_of_day'), async (req, res, next) => {
  try {
    // W-12 (S531): optional ?propertyId= — history is viewed per property.
    // 10/2: and only a property the caller is assigned to; with none named, a
    // scoped cashier sees their own properties' sales.
    const { propertyId: txProp, scoped } = await salesScope(req)
    const txParams: any[] = [posLandlordId(req)]
    const txPropFilter = txProp ? `AND t.property_id = $${txParams.push(txProp)}`
      : scoped ? `AND t.property_id = ANY($${txParams.push(scoped)}::uuid[])` : ''
    // S654 (Nic): a customer's purchase history — the receipt panel links here.
    const txCust = req.query.posCustomerId ? String(req.query.posCustomerId) : null
    // 10/2: a resident's history is every sale naming them — including sales
    // rung before their register record existed, which carry only their tenant id.
    const txCustFilter = txCust ? (() => { const n = txParams.push(txCust)
      return `AND (t.pos_customer_id = $${n} OR t.tenant_id = (SELECT pc2.tenant_id FROM pos_customers pc2 WHERE pc2.id = $${n} AND pc2.landlord_id = $1))` })() : ''
    const txns = await query<any>(`
      SELECT t.*,
        u.first_name || ' ' || u.last_name AS tenant_name,
        CASE WHEN pc.tenant_id IS NOT NULL THEN NULLIF(TRIM(pu.first_name || ' ' || pu.last_name), '')
             ELSE NULLIF(TRIM(pc.first_name || ' ' || pc.last_name), '') END AS customer_name,
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
        -- 10/3 (review): why Void is not offered on this sale (null: it may be voided).
        ${voidBlockedSql('t')} AS void_blocked,
        (SELECT json_agg(json_build_object('name', i.item_name, 'qty', i.qty, 'price', i.unit_price, 'subtotal', i.subtotal) ORDER BY i.created_at)
           FROM pos_transaction_items i WHERE i.transaction_id = t.id) AS items
      FROM pos_transactions t
      LEFT JOIN tenants tn ON tn.id = t.tenant_id
      LEFT JOIN users u ON u.id = tn.user_id
      LEFT JOIN pos_customers pc ON pc.id = t.pos_customer_id
      LEFT JOIN tenants ptn ON ptn.id = pc.tenant_id
      LEFT JOIN users pu ON pu.id = ptn.user_id
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
    throw new AppError(404, 'That card charge is not one of this register\'s — press Charge again to start a new one.')
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
    const { propertyId, description, posDraftRef, discountAmount } = req.body
    const items = lowerLineIds(req.body.items)   // 10/2 (review): ids as the database writes them
    if (!propertyId) throw new AppError(400, 'A property must be selected — pick it at the top of the register; sales are per-property.')
    // 10/2 (review): a card charge only at a property the caller works.
    await assertPropertyInScope(req.user, propertyId)
    // S648 (Nic): the card reader charges the cart (plus the card fee when the
    // property passes it on), and the amount is the server's, computed from
    // the cart — not a number the register sends.
    if (!Array.isArray(items) || items.length === 0) throw new AppError(400, 'The cart is empty — add what they are buying, then press Charge again.')
    assertCartNumbers(items, 'Charge')
    // 10/2 (review): refused before the card is asked for, not after.
    await assertWholeStays(posLandlordId(req), items, 'Charge')
    // 10/2 (decisions #9): a reservation ticket's card charge is the
    // reservation's own price — the same figure the sale will check it against.
    const priced = await cartAsCharged(posLandlordId(req), propertyId, items, req.body.openTicketId, discountAmount, 'Charge', req.body.payLinkId,
      { stay: req.body.stay, needSite: true })
    const quoted = await serverCartTotals(posLandlordId(req), priced.items, 'card', discountAmount, undefined, propertyId)
    const amountCents = Math.round(quoted.total * 100)
    if (amountCents <= 0) throw new AppError(400, 'There is nothing to charge — the total is $0. Add what they are buying, then press Charge again.')

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
    if (!stripeReaderId) throw new AppError(400, 'Pick the card reader first (Connect reader), then press Charge again.')

    const { landlordId, propertyId, intent } = await ownTerminalIntent(req, paymentIntentId)
    const ownerRow = await assertReaderBelongsToLandlord(landlordId, stripeReaderId)
    if (!ownerRow) throw new AppError(404, 'That reader is not paired to the company this sale belongs to — pick this register\'s reader (Connect reader), then press Charge again.')
    // S654 (Nic): "it'd be nice to see a little bit of a breakdown." The reader
    // shows the lines, tax, card fee and total before it asks for the card —
    // priced by the server from the same cart (a changed cart is refused),
    // never from figures the register typed.
    const { discountAmount } = req.body
    const items = lowerLineIds(req.body.items)   // 10/2 (review): ids as the database writes them
    if (Array.isArray(items) && items.length) {
      // 10/2 (decisions #9): priced the way the charge was (a reservation's line
      // at its own price, untaxed) — the cart names its ticket on that line.
      const priced = await cartAsCharged(landlordId, propertyId, items, req.body.openTicketId, discountAmount, 'Charge', req.body.payLinkId,
        { stay: req.body.stay, needSite: true })
      const quoted = await serverCartTotals(landlordId, priced.items, 'card', discountAmount, undefined, propertyId)
      if (Math.round(quoted.total * 100) !== intent.amount) {
        throw new AppError(409, 'The cart changed since this card charge was started — press Charge again.')
      }
      // 10/2: the breakdown never fails over the person — no name instead.
      const who = await nameForReader(landlordId, { tenantId: req.body.tenantId, posCustomerId: req.body.posCustomerId })
      const shown = await showCartOnReader({ stripeReaderId, lines: registerReaderLines(priced.items, quoted.surcharge),
        taxCents: Math.round(Number(quoted.taxAmount) * 100), totalCents: intent.amount, who,
        owner: `register:${(req as any).user.userId}:${propertyId}` })
      // S654 (Nic): "it needs to be there the whole time … until the payment is
      // processed." Stripe's own pay screen shows the total only, and Stripe
      // sends nothing when a card is tapped on the breakdown — so the register
      // puts the breakdown up while the cart is rung (POST /terminal/readers/
      // :id/cart) and the customer taps THERE. When it has been up, Charge
      // completes with that tap at once. Only a breakdown that was not up yet
      // is held, so the customer still gets to read it before the pay screen.
      // A breakdown another flow had taken over is not the one they tapped on.
      if (req.body.cartOnReader !== true || shown === 'took_over') await holdForTheCart()
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
    if (!propertyId) throw new AppError(400, 'A property must be selected — pick it at the top of the register; sales are per-property.')
    await assertPropertyInScope(req.user, propertyId)
    const landlordId = posLandlordId(req)
    await assertPropertyIsLandlords(landlordId, propertyId)
    if (!(await assertReaderBelongsToLandlord(landlordId, stripeReaderId))) {
      throw new AppError(404, 'That reader is not paired to the company this register belongs to — pick this register\'s reader (Connect reader).')
    }
    // 10/2 (review): ids as the database writes them.
    const items = Array.isArray(req.body?.items) ? lowerLineIds(req.body.items).filter((it: any) => Number(it?.qty) > 0) : []
    const owner = `register:${req.user.userId}:${propertyId}`
    if (!items.length) {
      const cleared = await clearCartOnReader(stripeReaderId, owner)
      return res.json({ success: true, data: { shown: false, cleared } })
    }
    assertCartNumbers(items, 'Charge')
    {
      const own = cashiersOwn(items.map((it: any) => ({ itemId: it.id, price: it.price, qty: it.qty })), req.body?.discountAmount,
        canSetPrices(req.user) ? null : await termsOfOpenLinks(landlordId, propertyId))
      await assertCashierPricing(req, own.lines, own.discount)
    }
    // 10/2 (decisions #9): a reservation's line shows at its own price, as it is charged.
    const priced = await cartAsCharged(landlordId, propertyId, items, req.body?.openTicketId, req.body?.discountAmount, 'Charge', req.body?.payLinkId)
    // 10/3 (review): a stay with no site and dates yet has no price — it stays
    // off the customer's screen (and out of its total) until it is priced.
    const showable = priced.items.filter((it: any) => !it?.[UNPRICED_STAY])
    if (!showable.length) {
      const cleared = await clearCartOnReader(stripeReaderId, owner)
      return res.json({ success: true, data: { shown: false, cleared, stayNotPriced: true } })
    }
    const quoted = await serverCartTotals(landlordId, showable, 'card', req.body?.discountAmount, undefined, propertyId)
    // 10/2 (the Scott Duffy ticket): putting the cart up never fails over the
    // person. Somebody who cannot be named here shows no name; the sale itself
    // still checks who it names.
    const who = await nameForReader(landlordId, { tenantId: req.body?.tenantId, posCustomerId: req.body?.posCustomerId })
    const action = await readerAction(stripeReaderId).catch(() => null)
    if (action && action.status === 'in_progress' && action.type !== 'set_reader_display') {
      return res.json({ success: true, data: { shown: false, busy: action.type } })
    }
    const totalCents = Math.round(Number(quoted.total) * 100)
    const shown = await showCartOnReader({ stripeReaderId, lines: registerReaderLines(showable, quoted.surcharge),
      taxCents: Math.round(Number(quoted.taxAmount) * 100), totalCents, who, owner })
    res.json({ success: true, data: { shown: !!shown, totalCents } })
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
      throw new AppError(404, 'That reader is not paired to the company this sale belongs to — pick this register\'s reader (Connect reader).')
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
  if (!reader) throw new AppError(404, 'That reader is not paired to this register — pick it again under Connect reader.')
  return reader
}

posRouter.get('/terminal/readers/:stripeReaderId/save-card-answer', requirePerm('pos.ring_sale'), async (req: any, res, next) => {
  try {
    const stripeReaderId = String(req.params.stripeReaderId)
    const reader = await ownedReaderByStripeId(req, stripeReaderId)
    const tx = await queryOne<any>(
      `SELECT id, property_id, pos_customer_id, stripe_payment_intent_id FROM pos_transactions WHERE id = $1 AND landlord_id = $2`,
      [String(req.query.transactionId ?? ''), reader.landlord_id])
    if (!tx || !tx.pos_customer_id || !tx.stripe_payment_intent_id) throw new AppError(404, SALE_GONE)
    // 10/2: the answer can email the sale's receipt, keep a card on its
    // customer and name their record — a sale at a property the caller works.
    await assertSaleInScope(req.user, tx.property_id)
    const answer = await readSaveCardAnswer(stripeReaderId)
    if (!answer.answered) return res.json({ success: true, data: { answered: false } })
    // The record as it was when the customer answered. A name and an email
    // typed together on the reader are the same customer's: a nameless card
    // record they name AND give a known email for is that known person, though
    // the name lands a moment before the email is looked at.
    const before: StandIn | null = answer.email
      ? await standInNow(db, tx.pos_customer_id)
      : null
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
      receiptSentTo = await emailReceiptForSale(tx.id, answer.email, [reader.landlord_id], { standIn: before })
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
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new AppError(400, 'That email does not look right — check it, then press Send again.')
    // 10/2: only a sale at a property the caller is assigned to.
    const sale = await queryOne<{ property_id: string | null }>(
      `SELECT property_id FROM pos_transactions WHERE id = $1 AND landlord_id = ANY($2::uuid[])`,
      [String(req.params.id), landlordScopeIds(req.user)])
    if (!sale) throw new AppError(404, SALE_GONE)
    await assertSaleInScope(req.user, sale.property_id)
    const sentTo = await emailReceiptForSale(String(req.params.id), email, landlordScopeIds(req.user))
    res.json({ success: true, data: { sentTo } })
  } catch (e) { next(e) }
})

/**
 * 10/5 (Nic, R13): the sentence a receipt carries for the stay a sale paid
 * for — "Your site is held through …" — when it is a stay of 30+ nights in a
 * row with no lease (held only through what is paid). The stay as it stands
 * now: a month added since moves the date. Null for anything else.
 */
async function saleHeldWords(tx: { id: string; pay_link_id?: string | null; open_ticket_id?: string | null }): Promise<string | null> {
  const b = await queryOne<{ id: string; stay_terms: StayTerms | null; check_in: string; check_out: string
                             guest_email: string | null; tenant_id: string | null; property_id: string }>(
    `SELECT b.id, b.stay_terms, to_char(b.check_in, 'YYYY-MM-DD') AS check_in, to_char(b.check_out, 'YYYY-MM-DD') AS check_out,
            b.guest_email, b.tenant_id, u.property_id
       FROM unit_bookings b JOIN units u ON u.id = b.unit_id
      WHERE b.status NOT IN ('cancelled', 'no_show')
        AND (b.pos_transaction_id = $1
             OR EXISTS (SELECT 1 FROM stay_payments sp WHERE sp.booking_id = b.id AND sp.pos_transaction_id = $1)
             OR b.id = (SELECT booking_id FROM pos_pay_links WHERE id = $2::uuid)
             OR b.id = (SELECT booking_id FROM pos_open_tickets WHERE id = $3::uuid))
      ORDER BY b.check_out DESC LIMIT 1`, [tx.id, tx.pay_link_id ?? null, tx.open_ticket_id ?? null])
  if (!b || b.stay_terms === 'lease') return null
  const chain = await continuousStayNights({ propertyId: b.property_id, bookingId: b.id, tenantId: b.tenant_id,
    email: b.guest_email, checkIn: b.check_in, checkOut: b.check_out })
  // A stay later in a back-to-back run carries the answer given for the run.
  const terms = b.stay_terms ?? [...chain.terms].reverse().find((t) => t != null) ?? null
  return terms === 'stay' && chain.nights >= STAY_LEASE_CHOICE_NIGHTS ? stayHeldWords(b.check_out) : null
}

async function emailReceiptForSale(transactionId: string, email: string, landlordIds: string[],
                                   opts: { standIn?: StandIn | null } = {}): Promise<string> {
  {
    const tx = await queryOne<any>(
      `SELECT t.*, p.name AS property_name, p.street1, p.street2, p.city, p.state, p.zip, l.business_name,
              pc.first_name AS c_first, pc.last_name AS c_last, pc.email AS c_email, pc.phone AS c_phone, pc.tenant_id AS c_tenant_id,
              u.first_name AS t_first, u.last_name AS t_last,
              -- 10/2 (review): the email on a resident's own account is printed
              -- only while they live under this company's leases
              -- (tenantLivesHereSql) — never for a looser tie, and never once
              -- they have left (decisions #10).
              CASE WHEN ${tenantLivesHereSql('tn.id', 't.landlord_id')} THEN u.email END AS t_email
         FROM pos_transactions t
         JOIN landlords l ON l.id = t.landlord_id
         LEFT JOIN properties p ON p.id = t.property_id
         LEFT JOIN pos_customers pc ON pc.id = t.pos_customer_id
         LEFT JOIN tenants tn ON tn.id = t.tenant_id
         LEFT JOIN users u ON u.id = tn.user_id
        WHERE t.id = $1 AND t.landlord_id = ANY($2::uuid[])`,
      [transactionId, landlordIds])
    if (!tx) throw new AppError(404, SALE_GONE)
    const items = await query<any>(
      `SELECT item_name, qty, unit_price, subtotal FROM pos_transaction_items WHERE transaction_id = $1 ORDER BY created_at`, [tx.id])
    const lines = items.map(l => ({ description: String(l.item_name), quantity: Number(l.qty), unitPrice: Number(l.unit_price), lineTotal: Number(l.subtotal) }))
    if (Number(tx.surcharge) > 0) lines.push({ description: 'Card processing fee', quantity: 1, unitPrice: Number(tx.surcharge), lineTotal: Number(tx.surcharge) })
    const receiptNumber = String(tx.id).slice(0, 8).toUpperCase()
    // 10/5 (Nic, R13): a stay with no lease is held only through what is paid — the receipt says so.
    const heldWords = await saleHeldWords(tx).catch((e) => {
      logger.warn({ err: e, saleId: tx.id }, '[POS] could not read the held-through date for the receipt'); return null })
    const { renderPosReceiptPdf } = await import('../services/businessPdf')
    const buffer = await renderPosReceiptPdf({
      business: { name: tx.property_name || tx.business_name || 'Register', email: null, phone: null,
                  street1: tx.street1 ?? null, street2: tx.street2 ?? null, city: tx.city ?? null, state: tx.state ?? null, zip: tx.zip ?? null },
      // A resident's name is the one on their account (10/2: their sale also
      // names their register record, whose copy of the name nobody edits).
      customer: (tx.c_first || tx.t_first) ? {
        firstName: tx.t_first ?? tx.c_first, lastName: tx.t_last ?? tx.c_last, companyName: null,
        email: tx.c_email ?? tx.t_email ?? email, phone: tx.c_phone ?? null, street1: null, city: null, state: null, zip: null,
      } : null,
      receiptNumber, createdAt: tx.created_at, status: String(tx.status), paymentMethod: String(tx.payment_method),
      amountTendered: null, changeDue: Number(tx.change_given) > 0 ? Number(tx.change_given) : null, refundReason: null,
      lines,
      subtotal: Math.round((Number(tx.subtotal) + Number(tx.surcharge || 0)) * 100) / 100,
      discountAmount: Number(tx.discount_amount || 0), taxAmount: Number(tx.tax_amount || 0), tipAmount: 0, totalAmount: Number(tx.total),
      note: heldWords,
    } as any)
    const { emailPosReceipt } = await import('../services/email')
    await emailPosReceipt(email, tx.property_name || tx.business_name || 'GAM', receiptNumber, Number(tx.total), buffer,
      // 10/5: replies reach the people who run this property (services/replyRouting).
      { relatedEntityType: 'pos_transaction', relatedEntityId: tx.id, replyTo: replyToProperty(tx.property_id) } as any,
      { note: heldWords })
    // 10/2: never on a resident's record — their email is their account's. And
    // the receipt has already gone out: what follows is bookkeeping, so a
    // failure in it is logged, never reported as a receipt that did not send.
    if (tx.pos_customer_id && !tx.c_email && !tx.c_tenant_id) {
      const client = await getClient()
      try {
        await client.query('BEGIN')
        // S654 (Nic): "people aren't going to have the same email if they're a
        // different person." An address this company already has — a register
        // customer's, or a resident's account email — means a card record
        // nobody confirmed is that person: it folds into them, cards and
        // purchases included. 10/2: by the same rule as linking a sale — only
        // a stand-in, and not when its card is printed with a different last
        // name. A person the clerk or the customer named is never merged into
        // someone on an address alone. An address held by a closed record is
        // left alone (it cannot be on two records).
        let same: { customerId?: string; tenantId?: string } | null = null
        let closed = false
        try { same = await findSamePerson(client, tx.landlord_id, email, null) } catch { closed = true }
        if (same?.customerId || same?.tenantId) {
          const x = opts.standIn?.id === tx.pos_customer_id ? opts.standIn : await standInNow(client, tx.pos_customer_id)
          if (x) await foldStandInInto(client, tx.landlord_id, x, same)
        } else if (!closed) {
          await client.query(`UPDATE pos_customers SET email = $1, updated_at = NOW() WHERE id = $2`, [email, tx.pos_customer_id])
        }
        await client.query('COMMIT')
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {})
        logger.warn({ err: e, saleId: tx.id }, '[POS] receipt sent; the customer record was not updated')
      } finally { client.release() }
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

// 10/2 (Nic, front desk foolproof): each refusal says what to press next.
const EMAIL_TAKEN_PICK = 'That email is already on another customer — type their name and pick them from the list instead, or leave the email blank.'
const EMAIL_TAKEN_EDIT = 'That email is already on another customer — use a different email, or merge the two from the Customers tab.'
const CUSTOMER_GONE = 'That customer was merged or closed — open the Customers tab again to see who is current.'
const NEW_PERSON_WORDS: Record<string, string> = {
  propertyId: 'Pick the property at the top of the register first, then press Add customer again.',
  firstName: 'Type at least a first name, then press Add customer.',
  lastName: 'That last name is too long — shorten it, then press Add customer again.',
  email: 'That email does not look right — check it, or leave it blank, then press Add customer again.',
  phone: 'That phone number is too long — check it, then press Add customer again.',
  match: 'That pick has run out — type their name again and pick them from the list.',
}
function phoneDigits(col: string): string { return PHONE_DIGITS.replace('$$X$$', col) }

// 10/2 (Nic): "it should be type their name, not a scroll down list... type
// somebody's last name and have it pop up." The register's type-ahead: this
// property's residents and this company's register customers by part of a
// name, email or phone — and, settled 10/2, everyone else on GAM by part of a
// name, or an email or phone typed whole, as a name and a masked hint only
// (services/posPeople searchElsewhere). Two characters before anything is looked up; a search over
// 120 characters is refused; looking elsewhere is limited per person.
posRouter.get('/people', requirePerm('pos.ring_sale'), peopleQueryGuard, peopleSearchLimiter, crossCompanyLimiter, async (req: any, res, next) => {
  try {
    const propertyId = String(req.query.propertyId ?? '')
    if (!/^[0-9a-f-]{36}$/i.test(propertyId)) throw new AppError(400, 'Pick the property at the top of the register first.')
    await assertPropertyInScope(req.user, propertyId)
    const landlordId = posLandlordId(req)
    await assertPropertyIsLandlords(landlordId, propertyId)
    const people = await searchPeople({ landlordId, propertyId, userId: req.user.userId, q: req.query.q, allowElsewhere: !req.crossCompanyLimited })
    // 10/2 (review): past the limit on looking elsewhere, the register says so
    // instead of quietly showing fewer people.
    res.json({ success: true, data: people, ...(req.crossCompanyLimited ? { elsewhereLimited: true } : {}) })
  } catch (e) { next(e) }
})

// S654 (Nic): "for cash people we can add them as a customer." A customer added
// at the register needs a first name and nothing else. 10/2: an email or phone
// this company already has picks that person instead — a register customer by
// email or phone, a resident by their account email. Someone picked from
// elsewhere on GAM (`match.pick`, the sealed pick the search handed out) gets a
// record HERE holding their name and only what the clerk typed in full.
posRouter.post('/customers', requirePerm('pos.ring_sale'), async (req: any, res, next) => {
  try {
    const b = parseForStaff(z.object({
      propertyId: z.string().uuid(),
      firstName:  z.string().trim().max(80).optional().nullable(),
      lastName:   z.string().trim().max(80).optional().nullable(),
      email:      z.string().trim().max(200).optional().nullable(),
      phone:      z.string().trim().max(40).optional().nullable(),
      match:      z.object({ pick: z.string().max(2000) }).optional(),
    }), req.body, NEW_PERSON_WORDS, 'The customer could not be added — check what was typed, then press Add customer again.')
    await assertPropertyInScope(req.user, b.propertyId)
    const landlordId = posLandlordId(req)
    await assertPropertyIsLandlords(landlordId, b.propertyId)
    if (!b.match && !b.firstName) throw new AppError(400, 'Type at least a first name, then press Add customer.')
    const client = await getClient()
    let made: { customerId: string; tenantId: string | null; existing: boolean }
    try {
      await client.query('BEGIN')
      made = b.match
        ? await customerFromElsewhere(client, landlordId, req.user.userId, b.match.pick)
        : await addCustomer(client, landlordId, { firstName: b.firstName!, lastName: b.lastName, email: b.email, phone: b.phone })
      await client.query('COMMIT')
    } catch (e: any) {
      await client.query('ROLLBACK').catch(() => {})
      if (e?.code === '23505') throw new AppError(409, EMAIL_TAKEN_PICK)
      throw e
    } finally { client.release() }
    // 10/2 (review): somebody picked from elsewhere who turns out to be tied to
    // this company only loosely (a cancelled invite, say) comes back by name —
    // their account's email and phone only while they live here.
    const row = await queryOne<any>(
      `SELECT c.id, c.tenant_id, COALESCE(u.first_name, c.first_name) AS first_name, COALESCE(u.last_name, c.last_name) AS last_name,
              ${recordContactSql('c', 'u').email} AS email, ${recordContactSql('c', 'u').phone} AS phone
         FROM pos_customers c LEFT JOIN tenants tn ON tn.id = c.tenant_id LEFT JOIN users u ON u.id = tn.user_id
        WHERE c.id = $1`, [made.customerId])
    const out = { ...row, kind: row.tenant_id ? 'resident' : 'customer', ...(made.existing ? { existing: true } : {}) }
    res.status(made.existing ? 200 : 201).json({ success: true, data: out })
  } catch (e) { next(e) }
})

// The Customers tab. 10/2: a resident's register record is listed under the
// name and email on their account, marked as a resident.
posRouter.get('/customers', requirePerm('pos.ring_sale', 'pos.end_of_day'), async (req, res, next) => {
  try {
    const landlordId = posLandlordId(req)
    // A resident's purchases include sales rung before their record existed.
    const theirSale = `(t.pos_customer_id = c.id OR (c.tenant_id IS NOT NULL AND t.landlord_id = c.landlord_id AND t.tenant_id = c.tenant_id))`
    const rows = await query<any>(
      `WITH c AS (
         SELECT c.id, c.landlord_id, c.tenant_id, c.created_from, c.created_at, c.notes, c.stripe_customer_id,
                COALESCE(u.first_name, c.first_name) AS first_name, COALESCE(u.last_name, c.last_name) AS last_name,
                ${recordContactSql('c', 'u').email} AS email, ${recordContactSql('c', 'u').phone} AS phone
           FROM pos_customers c
           LEFT JOIN tenants tn ON tn.id = c.tenant_id
           LEFT JOIN users u ON u.id = tn.user_id
          WHERE c.landlord_id = $1 AND c.archived_at IS NULL)
       SELECT c.id, c.first_name, c.last_name, c.email, c.phone, c.created_from, c.created_at, c.notes,
              c.tenant_id, (c.tenant_id IS NOT NULL) AS is_resident,
              (c.stripe_customer_id IS NOT NULL) AS has_stripe_customer,
              (SELECT COUNT(*)::int FROM pos_transactions t WHERE ${theirSale}) AS purchases,
              (SELECT COALESCE(SUM(t.total), 0)::float FROM pos_transactions t WHERE ${theirSale} AND t.status <> 'voided') AS total_spent,
              (SELECT MAX(t.created_at) FROM pos_transactions t WHERE ${theirSale}) AS last_purchase_at,
              (SELECT COALESCE(json_agg(json_build_object('brand', k.brand, 'last4', k.last4, 'saved', k.stripe_payment_method_id IS NOT NULL) ORDER BY k.last_seen_at DESC), '[]'::json)
                 FROM pos_customer_cards k WHERE k.pos_customer_id = c.id) AS cards,
              (SELECT COALESCE(json_agg(d.id), '[]'::json) FROM c d
                WHERE d.id <> c.id
                  AND ((c.email IS NOT NULL AND lower(d.email) = lower(c.email))
                    OR (${phoneDigits('c.phone')} <> '' AND ${phoneDigits('d.phone')} = ${phoneDigits('c.phone')}))) AS duplicate_ids
         FROM c
        ORDER BY c.last_name, c.first_name`, [landlordId])
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

posRouter.patch('/customers/:id', requirePerm('pos.ring_sale'), async (req, res, next) => {
  try {
    const b = parseForStaff(z.object({
      firstName: z.string().trim().min(1).max(80).optional(),
      lastName:  z.string().trim().max(80).optional(),
      email:     z.string().trim().toLowerCase().email().nullable().optional(),
      phone:     z.string().trim().max(40).nullable().optional(),
    }), req.body, {
      firstName: 'A customer needs a first name — type one, then press Save.',
      lastName: 'That last name is too long — shorten it, then press Save.',
      email: 'That email does not look right — check it, or clear it, then press Save.',
      phone: 'That phone number is too long — check it, then press Save.',
    }, 'The customer could not be saved — check what was typed, then press Save again.')
    // 10/2: a resident's name, email and phone are on their own account; the
    // register does not keep a second copy anyone could edit.
    if (!/^[0-9a-f-]{36}$/i.test(String(req.params.id))) throw new AppError(404, CUSTOMER_GONE)
    const cur = await queryOne<{ tenant_id: string | null }>(
      `SELECT tenant_id FROM pos_customers WHERE id = $1 AND landlord_id = $2 AND archived_at IS NULL`,
      [req.params.id, posLandlordId(req)])
    if (!cur) throw new AppError(404, CUSTOMER_GONE)
    if (cur.tenant_id) throw new AppError(409, "This is a resident — their name, email and phone are on their own account, so there is nothing to change here. Press Cancel.")
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
    if (!row) throw new AppError(404, CUSTOMER_GONE)
    res.json({ success: true, data: row })
  } catch (e: any) {
    if (e?.code === '23505') return next(new AppError(409, EMAIL_TAKEN_EDIT))
    next(e)
  }
})

posRouter.post('/customers/:id/merge', requirePerm('pos.ring_sale'), async (req, res, next) => {
  try {
    const { into } = parseForStaff(z.object({ into: z.string().uuid() }), req.body, {},
      'Pick the customer to merge into from the list, then press Merge again.')
    if (!/^[0-9a-f-]{36}$/i.test(String(req.params.id))) throw new AppError(404, CUSTOMER_GONE)
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

// 10/2 (Nic): "on the history, same thing... start typing in their name; if
// they're an existing customer I can click them and link them to that
// transaction. And then have it retroactively fill to any matching cards."
//
// Who a past sale was for — the one way to say it. Exactly one of: an existing
// register customer, a resident, a new customer (typed), or someone found on
// GAM outside this company (the sealed pick the search handed out), or
// `posCustomerId: null` to say nobody. Only THIS sale is moved to them — never
// a rename of whoever it named before (an "Edit customer" that typed Bob over
// Jane used to rename Jane everywhere). Then the card rule
// (services/posPeople linkSaleToPerson) carries every other sale on the same
// card that nobody had confirmed, and a resident's sales take their tenant id.
posRouter.patch('/transactions/:id/customer', requirePerm('pos.ring_sale'), async (req: any, res, next) => {
  try {
    const person = z.object({
      firstName: z.string().trim().min(1).max(80),
      lastName:  z.string().trim().max(80).optional().nullable(),
      email:     z.string().trim().max(200).optional().nullable(),
      phone:     z.string().trim().max(40).optional().nullable(),
    })
    const b = parseForStaff(z.object({
      posCustomerId: z.string().uuid().nullable().optional(),
      tenantId:      z.string().uuid().nullable().optional(),
      addNew:        person.optional(),
      match:         z.object({ pick: z.string().max(2000) }).optional(),
    }), req.body, {
      posCustomerId: NOT_ON_REGISTER,
      tenantId: NOT_ON_REGISTER,
      'addNew.firstName': NEW_PERSON_WORDS.firstName,
      'addNew.lastName': NEW_PERSON_WORDS.lastName,
      'addNew.email': NEW_PERSON_WORDS.email,
      'addNew.phone': NEW_PERSON_WORDS.phone,
      match: NEW_PERSON_WORDS.match,
    }, 'Who this sale was for could not be saved — type their name and pick them from the list again.')
    const picked = [b.posCustomerId, b.tenantId, b.addNew, b.match].filter((v) => v != null)
    if (picked.length > 1) throw new AppError(400, 'A sale is for one person — remove the customer (×) and pick just one.')
    let target: LinkTarget
    if (b.posCustomerId) target = { kind: 'customer', posCustomerId: b.posCustomerId }
    else if (b.tenantId) target = { kind: 'resident', tenantId: b.tenantId }
    else if (b.addNew) target = { kind: 'new', person: b.addNew }
    else if (b.match) target = { kind: 'elsewhere', pick: b.match.pick, userId: req.user.userId }
    else if (b.posCustomerId === null || b.tenantId === null) target = { kind: 'clear' }
    else throw new AppError(400, 'Type who this sale was for and pick them from the list.')

    const landlordId = posLandlordId(req)
    const sale = await queryOne<any>(
      `SELECT id, property_id, tenant_id, pos_customer_id, payment_method, stripe_payment_intent_id
         FROM pos_transactions WHERE id = $1 AND landlord_id = $2`, [req.params.id, landlordId])
    if (!sale) throw new AppError(404, SALE_GONE)
    await assertSaleInScope(req.user, sale.property_id)
    // A card sale that named nobody: which card was it? Read back from Stripe
    // before the transaction opens (a network call has no business holding
    // row locks). Best-effort — without it, only this sale moves.
    let saleCard: CardIdentity | null = null
    if (target.kind !== 'clear' && !sale.pos_customer_id && !sale.tenant_id && sale.stripe_payment_intent_id
        && (sale.payment_method === 'card' || sale.payment_method === 'card_on_file')) {
      saleCard = await readSaleCard(sale.stripe_payment_intent_id).catch((e) => {
        logger.warn({ err: e, saleId: sale.id }, '[POS] could not read the card a sale was paid with')
        return null
      })
    }
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const out = await linkSaleToPerson(client, { landlordId, saleId: sale.id, target, saleCard, userId: req.user.userId })
      await client.query('COMMIT')
      res.json({ success: true, data: out })
    } catch (e: any) {
      await client.query('ROLLBACK').catch(() => {})
      if (e?.code === '23505') throw new AppError(409, EMAIL_TAKEN_PICK)
      throw e
    } finally { client.release() }
  } catch (e) { next(e) }
})

// POST /api/pos/transactions/:id/customer/undo — put a link back.
//
// 10/2 (review): picking the wrong person can carry far more than the one sale
// — a card record folded in with its other sales and a card kept on file, a
// card put on their record. The message after a link (and after a sale whose
// tapped card was folded into the person picked) carries an Undo; this puts
// every one of those back exactly. Only the clerk who made it, at this company,
// within half an hour, and only while the sale still names whom it was linked
// to (services/posPeople undoLink).
posRouter.post('/transactions/:id/customer/undo', requirePerm('pos.ring_sale'), async (req: any, res, next) => {
  try {
    const { undo } = parseForStaff(z.object({ undo: z.string().max(30_000) }), req.body, {},
      'That can no longer be undone here — open the sale in History and pick the right person.')
    const landlordId = posLandlordId(req)
    const sale = /^[0-9a-f-]{36}$/i.test(String(req.params.id)) ? await queryOne<{ id: string; property_id: string | null }>(
      `SELECT id, property_id FROM pos_transactions WHERE id = $1 AND landlord_id = $2`, [req.params.id, landlordId]) : null
    if (!sale) throw new AppError(404, SALE_GONE)
    await assertSaleInScope(req.user, sale.property_id)
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const out = await undoLink(client, { landlordId, userId: req.user.userId, saleId: sale.id, token: undo })
      await client.query('COMMIT')
      res.json({ success: true, data: out })
    } catch (e: any) {
      await client.query('ROLLBACK').catch(() => {})
      if (e?.code === '23505') throw new AppError(409, 'That can no longer be undone here — one of those records has changed since. Open the sale in History and pick the right person.')
      throw e
    } finally { client.release() }
  } catch (e) { next(e) }
})

// POST /api/pos/customers/:id/let-go — a pick from elsewhere taken back off.
//
// 10/2 (review, "back out with one button and no side effects"): picking
// someone from another company makes their record here at once. Taken back off
// (× or Clear) before anything was written against it, the record goes again —
// only a record made from a pick, only an empty one (services/posPeople
// letGoOfPick). Best-effort by design: a record with something on it stays,
// and the answer says so without an error.
posRouter.post('/customers/:id/let-go', requirePerm('pos.ring_sale'), async (req: any, res, next) => {
  try {
    const landlordId = posLandlordId(req)
    const client = await getClient()
    let letGo = false
    try {
      await client.query('BEGIN')
      letGo = await letGoOfPick(client, landlordId, String(req.params.id))
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally { client.release() }
    res.json({ success: true, data: { letGo } })
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

/**
 * 10/2 (review): who an open cart names — only this company's register
 * customer, or a tenant tied to this company (tenantOfCompanySql). An id
 * stored from anywhere else shows no name. A resident's register record goes
 * by their account's name.
 */
const SESSION_PERSON_JOINS = `
         LEFT JOIN pos_customers pcu ON pcu.id = s.pos_customer_id AND pcu.landlord_id = s.landlord_id
         LEFT JOIN tenants       pct ON pct.id = pcu.tenant_id
         LEFT JOIN users         pcuu ON pcuu.id = pct.user_id
         LEFT JOIN tenants       t   ON t.id   = s.tenant_id AND ${tenantOfCompanySql('t.id', 's.landlord_id')}
         LEFT JOIN users         tu  ON tu.id  = t.user_id`
const SESSION_PERSON_NAME = `NULLIF(TRIM(COALESCE(
                CASE WHEN pcu.id IS NOT NULL THEN COALESCE(pcuu.first_name, pcu.first_name, '') || ' ' || COALESCE(pcuu.last_name, pcu.last_name, '') END,
                COALESCE(tu.first_name, '') || ' ' || COALESCE(tu.last_name, '')
              )), '')`

/**
 * The person a cart is opened or changed with must be this company's
 * (salePerson). On open, somebody who is not simply is not stored — the cart
 * still opens (it is the register's background copy, and refusing it would
 * strand every line after it). A change naming somebody else is refused.
 */
async function sessionPerson(landlordId: string, ids: { tenantId?: unknown; posCustomerId?: unknown }): Promise<{ tenantId: string | null; posCustomerId: string | null }> {
  await salePerson(landlordId, ids)   // refuses anybody who is not this company's
  return {
    tenantId: typeof ids.tenantId === 'string' && ids.tenantId ? ids.tenantId : null,
    posCustomerId: typeof ids.posCustomerId === 'string' && ids.posCustomerId ? ids.posCustomerId : null,
  }
}

// GET /pos/sessions?status=open[&property_id=...]
posRouter.get('/sessions', requirePerm('pos.ring_sale'), async (req, res, next) => {
  try {
    const status = String(req.query.status || 'open')
    const propertyId = req.query.propertyId ? String(req.query.propertyId) : null
    const params: any[] = [posLandlordId(req), status]
    let propertyClause = ''
    // 10/2 (review): a cashier sees the open carts of the properties they work.
    if (propertyId) {
      await assertPropertyInScope(req.user, propertyId)
      params.push(propertyId); propertyClause = ' AND s.property_id = $3'
    } else {
      const scope = await getScopedPropertyIds(req.user)
      if (scope) { params.push(scope); propertyClause = ' AND s.property_id = ANY($3::uuid[])' }
    }
    const sessions = await query<any>(
      `SELECT s.*,
              ${SESSION_PERSON_NAME} AS customer_name,
              pr.name AS property_name,
              (SELECT COUNT(*)::int FROM pos_session_items WHERE session_id = s.id) AS item_count,
              -- S654 (Nic): the open-tab list says what is in each cart.
              (SELECT string_agg(x.item_name || CASE WHEN x.qty > 1 THEN ' ×' || x.qty::int ELSE '' END, ', ')
                 FROM (SELECT item_name, qty FROM pos_session_items WHERE session_id = s.id ORDER BY created_at LIMIT 3) x) AS preview
         FROM pos_sessions s
         ${SESSION_PERSON_JOINS}
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
    if (!propertyId) throw new AppError(400, 'Pick the property at the top of the register first, then ring the sale again.')
    if (posCustomerId && tenantId) throw new AppError(400, ONE_PERSON_CART)

    // Verify the property belongs to the calling landlord.
    const prop = /^[0-9a-f-]{36}$/i.test(String(propertyId)) ? await queryOne<{ landlord_id: string }>(
      `SELECT landlord_id FROM properties WHERE id = $1`,
      [propertyId],
    ) : null
    if (!prop || prop.landlord_id !== posLandlordId(req)) {
      throw new AppError(403, 'That property is not this register\'s — pick the property at the top of the register, then ring the sale again.')
    }
    // Property lock: scoped cashier may only open a session on their property.
    await assertPropertyInScope(req.user, propertyId)
    // 10/2 (review): only this company's person is stored on the cart.
    const who = (posCustomerId || tenantId)
      ? await sessionPerson(posLandlordId(req), { tenantId, posCustomerId }).catch(() => ({ tenantId: null, posCustomerId: null }))
      : { tenantId: null, posCustomerId: null }

    const row = await queryOne<any>(
      `INSERT INTO pos_sessions
         (property_id, landlord_id, opened_by_user_id, pos_customer_id, tenant_id, notes)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [propertyId, posLandlordId(req), req.user!.userId, who.posCustomerId, who.tenantId, notes || null],
    )
    res.json({ success: true, data: row })
  } catch (e) { next(e) }
})

const SESSION_GONE = 'That open cart is not on this register any more — it was settled or discarded. Start the sale again.'
const ONE_PERSON_CART = 'A cart is for one person — remove the customer (×), then pick just the one it is for.'
const sessionClosed = (status: string) => `That open cart was already ${status === 'completed' ? 'settled' : 'discarded'} — start the sale again.`

/**
 * 10/2 (review): an open cart, of this company, at a property the caller
 * works. Adding, changing or removing its lines and discarding it all go
 * through here — a cashier assigned to one park never edits another park's
 * carts by id.
 */
async function openSessionInScope(req: any, opts: { anyStatus?: boolean } = {}): Promise<{ id: string; status: string; property_id: string }> {
  if (!/^[0-9a-f-]{36}$/i.test(String(req.params.id))) throw new AppError(404, SESSION_GONE)
  const session = await queryOne<{ id: string; status: string; property_id: string }>(
    `SELECT id, status, property_id FROM pos_sessions WHERE id = $1 AND landlord_id = $2`,
    [req.params.id, posLandlordId(req)])
  if (!session) throw new AppError(404, SESSION_GONE)
  await assertPropertyInScope(req.user, session.property_id)
  if (!opts.anyStatus && session.status !== 'open') throw new AppError(409, sessionClosed(session.status))
  return session
}

// GET /pos/sessions/:id — full session + items.
posRouter.get('/sessions/:id', requirePerm('pos.ring_sale'), async (req, res, next) => {
  try {
    if (!/^[0-9a-f-]{36}$/i.test(String(req.params.id))) throw new AppError(404, SESSION_GONE)
    const session = await queryOne<any>(
      `SELECT s.*,
              ${SESSION_PERSON_NAME} AS customer_name,
              pr.name AS property_name
         FROM pos_sessions s
         ${SESSION_PERSON_JOINS}
         LEFT JOIN properties    pr  ON pr.id  = s.property_id
        WHERE s.id = $1 AND s.landlord_id = $2`,
      [req.params.id, posLandlordId(req)],
    )
    if (!session) throw new AppError(404, SESSION_GONE)
    // 10/2 (review): only a cart at a property the caller works.
    await assertPropertyInScope(req.user, session.property_id)
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
    if (!/^[0-9a-f-]{36}$/i.test(String(req.params.id))) throw new AppError(404, SESSION_GONE)
    const session = await queryOne<any>(
      `SELECT id, status, property_id FROM pos_sessions WHERE id = $1 AND landlord_id = $2`,
      [req.params.id, posLandlordId(req)],
    )
    if (!session) throw new AppError(404, SESSION_GONE)
    // 10/2 (review): only a cart at a property the caller works.
    await assertPropertyInScope(req.user, session.property_id)
    if (session.status !== 'open') throw new AppError(409, sessionClosed(session.status))

    const { posCustomerId, tenantId, discountAmount, notes } = req.body || {}
    if (posCustomerId && tenantId) throw new AppError(400, ONE_PERSON_CART)
    // 10/2 (review): a cart names only this company's person.
    if (posCustomerId || tenantId) await sessionPerson(posLandlordId(req), { tenantId, posCustomerId })

    const sets: string[] = []
    const params: any[] = []
    if (posCustomerId !== undefined) { params.push(posCustomerId || null); sets.push(`pos_customer_id = $${params.length}`) }
    if (tenantId !== undefined)      { params.push(tenantId || null);      sets.push(`tenant_id = $${params.length}`) }
    if (discountAmount !== undefined) {
      const d = Number(discountAmount)
      if (!Number.isFinite(d) || d < 0) throw new AppError(400, 'A discount cannot be below zero — fix it, then press Apply again.')
      await assertCashierPricing(req, [], d)
      params.push(d.toFixed(2)); sets.push(`discount_amount = $${params.length}`)
    }
    if (notes !== undefined) { params.push(notes); sets.push(`notes = $${params.length}`) }
    if (sets.length === 0) throw new AppError(400, 'Nothing on the cart changed — carry on with the sale.')

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
    const session = await openSessionInScope(req)

    const b = req.body || {}
    // 10/2 (review): the item id as the database writes it (lowercase).
    if (typeof b.itemId === 'string') b.itemId = b.itemId.trim().toLowerCase()
    const qty = Number(b.qty)
    const unitPrice = Number(b.unitPrice)
    const words = cartLineWords('Charge')
    if (!b.itemName) throw new AppError(400, 'A line in the cart has no name — take it out, add it again, then carry on.')
    if (!Number.isFinite(qty) || qty <= 0) throw new AppError(400, words['items.N.qty'])
    if (!Number.isFinite(unitPrice) || unitPrice < 0) throw new AppError(400, words['items.N.price'])
    assertNonNeg([b.taxRate, 'Tax rate'], [b.costPrice, 'Cost price'])

    assertCatalogItems([{ itemId: b.itemId }])
    await assertCashierPricing(req, [{ itemId: b.itemId, price: unitPrice }])
    await assertItemsAreOurs(posLandlordId(req), [{ id: b.itemId }], 'Charge')
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
    const session = await openSessionInScope(req)

    const b = req.body || {}
    const sets: string[] = []
    const params: any[] = []
    if (b.qty !== undefined) {
      const q = Number(b.qty)
      if (!Number.isFinite(q) || q <= 0) throw new AppError(400, cartLineWords('Charge')['items.N.qty'])
      params.push(q); sets.push(`qty = $${params.length}`)
    }
    if (b.unitPrice !== undefined) {
      const u = Number(b.unitPrice)
      if (!Number.isFinite(u) || u < 0) throw new AppError(400, cartLineWords('Charge')['items.N.price'])
      const line = await queryOne<{ item_id: string | null }>(
        `SELECT item_id FROM pos_session_items WHERE id = $1 AND session_id = $2`,
        [req.params.itemId, req.params.id])
      await assertCashierPricing(req, [{ itemId: line?.item_id, price: u }])
      params.push(u.toFixed(2)); sets.push(`unit_price = $${params.length}`)
    }
    if (b.notes !== undefined) { params.push(b.notes); sets.push(`notes = $${params.length}`) }
    if (sets.length === 0) throw new AppError(400, 'Nothing on that line changed — carry on with the sale.')

    params.push(req.params.itemId, req.params.id)
    const updated = await queryOne<any>(
      `UPDATE pos_session_items SET ${sets.join(', ')}, updated_at = NOW()
        WHERE id = $${params.length - 1} AND session_id = $${params.length}
        RETURNING *`,
      params,
    )
    if (!updated) throw new AppError(404, 'That line is not in the open cart any more — add it again if they still want it.')

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
    const session = await openSessionInScope(req)

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
    await openSessionInScope(req, { anyStatus: true })
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
    if (!updated) throw new AppError(404, SESSION_GONE)
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
    if (!transactionId) throw new AppError(400, SALE_GONE)

    // Verify the transaction belongs to the calling landlord — defense
    // against a malicious cashier marking someone else's session against
    // their transaction.
    const tx = /^[0-9a-f-]{36}$/i.test(String(transactionId)) ? await queryOne<{ landlord_id: string; property_id: string | null }>(
      `SELECT landlord_id, property_id FROM pos_transactions WHERE id = $1`,
      [transactionId],
    ) : null
    if (!tx || tx.landlord_id !== posLandlordId(req)) throw new AppError(404, SALE_GONE)
    // 10/2 (review): only a cart at a property the caller works, closed by a
    // sale of that same property.
    const sess = await queryOne<{ property_id: string }>(
      `SELECT property_id FROM pos_sessions WHERE id = $1 AND landlord_id = $2`, [req.params.id, posLandlordId(req)])
    if (!sess) throw new AppError(404, SESSION_GONE)
    await assertPropertyInScope(req.user, sess.property_id)
    if (tx.property_id && tx.property_id !== sess.property_id) {
      throw new AppError(409, 'That sale was rung at another property — this open cart stays open.')
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
      throw new AppError(409, 'That open cart was already settled or discarded — nothing more to do here.')
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

// ── HELD PAYMENTS (decisions #13) ────────────────────────────────────────
//
// A pay-link card payment that did not fit (paid twice, an old amount, more
// than its reservation owed) is held by GAM (routes/posPayLinks
// finalizePayLink). These are the register's own screens for it — the Pay
// Links tab — like every other register control: the account owner presses
// Refund this payment; nothing refunds on its own, and no agent reaches it.

/** Only the account holder sees and refunds a held payment — the person the notice went to. */
function isAccountOwner(user: any): boolean {
  return user?.role === 'landlord'
}

const HELD_GONE = 'That held payment is not on this account any more — open Pay Links again to see what is still held.'

/** 10/3 (review): how far back, and how many at once, a Pay Links load asks Stripe for a held payment's fee. */
const HELD_FEE_LOOKUP_DAYS = 14
const HELD_FEE_LOOKUPS_PER_LOAD = 5

/**
 * 10/3 (decisions #22): Stripe's processing fee on a payment — what Stripe
 * keeps when it is refunded (the landlord's loss, from their next payout).
 * Null when Stripe cannot say just now; never a reason to fail the call.
 */
async function stripeFeeOn(paymentIntentId: string, stripe?: any): Promise<number | null> {
  try {
    const client = stripe ?? (await import('../lib/stripe')).getStripe()
    const pi: any = await client.paymentIntents.retrieve(paymentIntentId, { expand: ['latest_charge.balance_transaction'] })
    const fee = pi?.latest_charge?.balance_transaction?.fee
    return typeof fee === 'number' && fee >= 0 ? Math.round(fee) / 100 : null
  } catch (e) {
    logger.warn({ err: e, paymentIntentId }, '[pay-link] could not read Stripe\'s fee on a held payment')
    return null
  }
}

// GET /api/pos/held-payments — payments GAM is holding for this account:
// paid twice, at an old amount, or for more than a reservation owed. The
// account owner's; anyone else gets an empty list (ownerOnly), never an error.
posRouter.get('/held-payments', requirePerm('pos.ring_sale'), async (req: any, res, next) => {
  try {
    if (!isAccountOwner(req.user)) return res.json({ success: true, data: [], ownerOnly: true })
    const ids: string[] = landlordScopeIds(req.user)
    // 10/3 (review, decisions #22): self-heal — a refunded payment whose kept fee
    // is known (written at refund time, or recorded by hand when Stripe could
    // not say) but has no payout line yet gets its one line now. recordHeldItem
    // is keyed on the refund, so this can never write a second one.
    if (ids.length) {
      const missing = await query<{ landlord_id: string; stripe_refund_id: string; fee: string }>(
        `SELECT h.landlord_id, h.stripe_refund_id, h.stripe_fee_kept::text AS fee
           FROM pos_held_payments h
          WHERE h.landlord_id = ANY($1::uuid[]) AND h.status = 'refunded'
            AND h.stripe_refund_id IS NOT NULL AND h.stripe_fee_kept > 0
            AND NOT EXISTS (SELECT 1 FROM held_payout_items i
                             WHERE i.source_type = 'refund' AND i.source_id = h.stripe_refund_id)
          LIMIT 20`, [ids])
      for (const m of missing) {
        await chargeKeptFeeToLandlord(m.landlord_id, m.stripe_refund_id, Number(m.fee))
          .catch((e) => logger.error({ err: e, refundId: m.stripe_refund_id }, '[pay-link] could not write the kept-fee payout line'))
      }
    }
    const rows = ids.length ? await query<any>(
      `SELECT h.id, h.reason, h.amount, h.payer_name, h.status, h.created_at, h.refunded_at, h.property_id,
              h.stripe_payment_intent_id, h.stripe_fee_kept,
              p.name AS property_name, l.label AS link_label, l.customer_email
         FROM pos_held_payments h
         LEFT JOIN properties p ON p.id = h.property_id
         LEFT JOIN pos_pay_links l ON l.id = h.pay_link_id
        WHERE h.landlord_id = ANY($1::uuid[])
          AND (h.status = 'held' OR h.refunded_at > NOW() - INTERVAL '7 days')
        ORDER BY (h.status = 'held') DESC, h.created_at DESC
        LIMIT 50`, [ids]) : []
    // 10/3 (decisions #22): the Refund button says what Stripe keeps — its fee
    // on the payment, read from Stripe for a held one that has none recorded
    // yet. 10/3 (review): read side by side, a few per load, and only for
    // payments held in the last HELD_FEE_LOOKUP_DAYS days — a load never waits
    // on Stripe once per row, and a payment Stripe will not give a fee for is
    // not asked about forever. (The refund reads it again either way, before
    // and after — what Stripe keeps is never left unrecorded for want of a list load.)
    const ask = rows.filter((r: any) => r.status === 'held' && r.stripe_fee_kept == null && r.stripe_payment_intent_id
      && Date.now() - new Date(r.created_at).getTime() < HELD_FEE_LOOKUP_DAYS * 86_400_000).slice(0, HELD_FEE_LOOKUPS_PER_LOAD)
    // One Stripe client for the load, shared by the lookups.
    let stripe: any = null
    if (ask.length) {
      try { stripe = (await import('../lib/stripe')).getStripe() } catch (e) {
        logger.warn({ err: e }, '[pay-link] could not reach Stripe to read the fees on held payments')
      }
    }
    if (stripe) await Promise.all(ask.map(async (r: any) => {
      const fee = await stripeFeeOn(r.stripe_payment_intent_id, stripe)
      if (fee == null || fee > Number(r.amount)) return
      await query(`UPDATE pos_held_payments SET stripe_fee_kept = $2 WHERE id = $1 AND status = 'held' AND stripe_fee_kept IS NULL AND $2 <= amount`, [r.id, fee])
      r.stripe_fee_kept = fee
    }))
    res.json({ success: true, data: rows.map(({ stripe_payment_intent_id: _pi, ...r }: any) => r) })
  } catch (e) { next(e) }
})

/** decisions #22: Stripe's kept fee on a refunded held payment, as one negative
 *  line on the landlord's next payout (source 'refund', keyed on the refund). */
async function chargeKeptFeeToLandlord(landlordId: string, refundId: string, kept: number,
                                       runner?: { query: (sql: string, params: any[]) => Promise<any> }): Promise<void> {
  const { recordHeldItem } = await import('../services/heldPayouts')
  await recordHeldItem({
    landlordId, sourceType: 'refund', sourceId: refundId, amount: -Math.abs(kept),
    description: "Stripe's processing fee kept on a refunded pay-link payment",
  } as any, runner as any)
}

// POST /api/pos/held-payments/:id/refund — decisions #13: "Refund this
// payment", one click, the account owner only, never automatic. The whole
// payment goes back to the card it came from, through Stripe; the held row is
// marked refunded. Pressed twice, it refunds once (Stripe's idempotency key).
// decisions #22: Stripe keeps its processing fee on a refunded payment — the
// landlord's loss, never GAM's; the fee is recorded on the row
// (stripe_fee_kept) for their next payout to carry as its own line.
posRouter.post('/held-payments/:id/refund', requirePerm('pos.ring_sale'), async (req: any, res, next) => {
  try {
    if (!isAccountOwner(req.user)) {
      throw new AppError(403, 'Only the account owner can refund a held payment — ask them to open the notice and press Refund this payment.')
    }
    const row = /^[0-9a-f-]{36}$/i.test(String(req.params.id))
      ? await queryOne<any>(`SELECT * FROM pos_held_payments WHERE id = $1`, [req.params.id]) : null
    if (!row || !ownsLandlord(req.user, row.landlord_id)) throw new AppError(404, HELD_GONE)
    if (row.status === 'refunded') {
      // decisions #22: a refund recorded before the fee line existed still gets
      // its one line now (recordHeldItem writes it at most once).
      if (row.stripe_fee_kept != null && Number(row.stripe_fee_kept) > 0 && row.stripe_refund_id) {
        await chargeKeptFeeToLandlord(row.landlord_id, row.stripe_refund_id, Number(row.stripe_fee_kept))
      }
      return res.json({ success: true, data: { refunded: true, amount: Number(row.amount), already: true,
        stripeFeeKept: row.stripe_fee_kept == null ? null : Number(row.stripe_fee_kept) } })
    }
    // What Stripe keeps — read before the refund, while the charge still says it.
    const fee = await stripeFeeOn(row.stripe_payment_intent_id)
    let refundId: string
    try {
      const { getStripe } = await import('../lib/stripe')
      const refund = await getStripe().refunds.create(
        { payment_intent: row.stripe_payment_intent_id,
          metadata: { gam_purpose: 'pos_held_payment_refund', gam_held_payment_id: row.id, gam_landlord_id: row.landlord_id } },
        { idempotencyKey: `pos-held-refund-${row.id}` })
      refundId = refund.id
    } catch (e) {
      logger.error({ err: e, heldPaymentId: row.id }, '[pay-link] a held payment could not be refunded')
      throw new AppError(502, 'The refund could not be started just now — nothing was refunded. Wait a moment, then press Refund this payment again.')
    }
    let kept = fee != null && fee <= Number(row.amount) ? fee : (row.stripe_fee_kept == null ? null : Number(row.stripe_fee_kept))
    // 10/3 (review, decisions #22): Stripe could not say before the refund —
    // ask again now. The charge's balance transaction keeps its fee after a
    // refund, and without it the landlord's next payout could never carry
    // what Stripe kept (GAM would absorb it). Still unknown: said loudly, so
    // it is recorded by hand before that payout.
    if (kept == null) {
      const after = await stripeFeeOn(row.stripe_payment_intent_id)
      if (after != null && after <= Number(row.amount)) kept = after
      else logger.error({ heldPaymentId: row.id, paymentIntentId: row.stripe_payment_intent_id, refundId, landlordId: row.landlord_id },
        '[pay-link] held payment refunded but Stripe\'s kept fee could not be read — set stripe_fee_kept on this pos_held_payments row by hand; the landlord\'s payout line is then written the next time the owner opens Pay Links (or call chargeKeptFeeToLandlord)')
    }
    // decisions #22 (Nic): Stripe's kept fee is the LANDLORD's loss, never GAM's
    // — one negative line on their next payout, written in the same
    // transaction as the refunded mark (recordHeldItem is at most once per refund).
    const { getClient } = await import('../db')
    const tx = await getClient()
    try {
      await tx.query('BEGIN')
      await tx.query(
        `UPDATE pos_held_payments SET status = 'refunded', refunded_at = NOW(), refunded_by = $2, stripe_refund_id = $3,
                stripe_fee_kept = $4
          WHERE id = $1 AND status = 'held'`, [row.id, req.user.userId, refundId, kept])
      if (kept != null && kept > 0) await chargeKeptFeeToLandlord(row.landlord_id, refundId, kept, tx)
      await tx.query('COMMIT')
    } catch (e) {
      await tx.query('ROLLBACK').catch(() => {})
      throw e
    } finally { tx.release() }
    logger.info({ heldPaymentId: row.id, refundId, amount: row.amount, stripeFeeKept: kept }, '[pay-link] held payment refunded by the account owner')
    res.json({ success: true, data: { refunded: true, amount: Number(row.amount), stripeFeeKept: kept } })
  } catch (e) { next(e) }
})

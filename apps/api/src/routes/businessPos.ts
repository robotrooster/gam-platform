/**
 * S497 — business-portal POS register.
 *
 * Endpoints:
 *   POST   /api/business-pos/transactions               (create + finalize)
 *   GET    /api/business-pos/transactions               (list, date / status filters)
 *   GET    /api/business-pos/transactions/:id           (with lines)
 *   POST   /api/business-pos/transactions/:id/refund    (full refund, restores stock)
 *
 * The POS register doesn't have draft-sale semantics like invoices do —
 * each sale is finalized in one shot. The create endpoint:
 *   1. Locks each line's inventory row with SELECT FOR UPDATE
 *   2. Computes per-line subtotal / tax / total from the snapshot price
 *   3. Decrements stock_qty and writes a 'sold' adjustment row per line
 *   4. Inserts the transaction + lines
 *   5. Bumps the per-business TXN-NNNNNN sequence
 * All atomic — any failure rolls back the whole sale.
 *
 * Refund (v1: full-only) walks the lines, writes 'received' adjustments
 * to restore stock, flips status to 'refunded'.
 */

import { Router } from 'express'
import { z } from 'zod'
import { db, query, queryOne } from '../db'
import { requireAuth } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'

export const businessPosRouter = Router()

// ── helpers ────────────────────────────────────────────────────
// S502: register use (POST sale, GET list, GET detail) gated by
// pos.use; refunds gated by pos.refund (separate so cashiers can ring
// up sales without being able to refund).
import { requireBusinessAccess } from '../middleware/businessAccess'
import { applyDiscount } from '../services/businessDiscounts'

const requireUse    = async (req: any) => (await requireBusinessAccess(req, { permission: 'pos.use',    feature: 'pos' })).businessId
const requireRefund = async (req: any) => (await requireBusinessAccess(req, { permission: 'pos.refund', feature: 'pos' })).businessId

function fmtReceipt(n: number): string {
  return `TXN-${String(n).padStart(6, '0')}`
}

// Convert numeric DB strings to two-decimal numbers for math.
function dec(n: string | number | null | undefined): number {
  return Math.round(Number(n ?? 0) * 100) / 100
}

// ═══════════════════════════════════════════════════════════════
//  POST /transactions — finalize a sale
// ═══════════════════════════════════════════════════════════════

const createSchema = z.object({
  customerId: z.string().uuid().nullable().optional(),
  paymentMethod: z.enum(['cash', 'card_recorded', 'stripe_terminal']),
  // stripe_terminal only: the captured PaymentIntent backing this sale.
  stripePaymentIntentId: z.string().min(1).optional(),
  amountTendered: z.number().min(0).optional(),
  // S512: optional customer gratuity, tracked separately from the sale.
  tipAmount: z.number().min(0).max(100000).optional(),
  // S513: optional discount code, applied pre-tax to the subtotal.
  discountCode: z.string().min(1).max(40).optional(),
  notes: z.string().max(1000).nullable().optional(),
  lines: z.array(z.object({
    itemId:   z.string().uuid(),
    quantity: z.number().int().positive().max(10000),
  })).min(1).max(200),
})

businessPosRouter.post('/transactions', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireUse(req)
    const body = createSchema.parse(req.body)

    // Validate customer (if supplied) belongs to this business + get
    // their tax-exempt status so the line-tax pass can skip tax.
    let customerTaxExempt = false
    if (body.customerId) {
      const c = await queryOne<{ id: string; tax_exempt: boolean }>(
        `SELECT id, tax_exempt FROM business_customers
          WHERE id = $1 AND business_id = $2`,
        [body.customerId, businessId])
      if (!c) throw new AppError(404, 'Customer not found')
      customerTaxExempt = c.tax_exempt
    }

    const client = await db.connect()
    try {
      await client.query('BEGIN')

      // Lock each item row + collect snapshot data. Use ANY-array
      // SELECT FOR UPDATE so we get deterministic lock ordering by id.
      const itemIds = body.lines.map(l => l.itemId)
      const { rows: items } = await client.query<{
        id: string; name: string; sku: string | null;
        sell_price: string; tax_rate: string; stock_qty: number;
        is_active: boolean;
      }>(
        `SELECT id, name, sku, sell_price, tax_rate, stock_qty, is_active
           FROM business_inventory_items
          WHERE business_id = $1 AND id = ANY($2::uuid[])
          ORDER BY id
          FOR UPDATE`,
        [businessId, itemIds])
      if (items.length !== itemIds.length) {
        throw new AppError(404, 'One or more items not found for this business')
      }
      const itemMap = new Map(items.map(i => [i.id, i]))

      // Compute totals + verify stock.
      type LineCalc = {
        itemId: string; name: string; sku: string | null;
        quantity: number; unitPrice: number; taxRate: number;
        lineSubtotal: number; lineTax: number; lineTotal: number;
        newStockQty: number;
      }
      const calcs: LineCalc[] = []
      let subtotal = 0
      let taxAmount = 0
      for (let idx = 0; idx < body.lines.length; idx++) {
        const l = body.lines[idx]!
        const it = itemMap.get(l.itemId)!
        if (!it.is_active) {
          throw new AppError(400, `Item "${it.name}" is archived and cannot be sold`)
        }
        if (it.stock_qty < l.quantity) {
          throw new AppError(400,
            `Not enough stock for "${it.name}" (need ${l.quantity}, have ${it.stock_qty})`)
        }
        const unitPrice = dec(it.sell_price)
        // S506: customer exemption zeros out the line tax. The item's
        // own tax_rate stays as the snapshot for receipt rendering so
        // the operator can see what the line "would have" carried.
        const taxRate   = customerTaxExempt ? 0 : dec(it.tax_rate)
        const lineSubtotal = dec(unitPrice * l.quantity)
        const lineTax      = dec(lineSubtotal * taxRate)
        const lineTotal    = dec(lineSubtotal + lineTax)
        subtotal  = dec(subtotal + lineSubtotal)
        taxAmount = dec(taxAmount + lineTax)
        calcs.push({
          itemId: it.id, name: it.name, sku: it.sku,
          quantity: l.quantity,
          unitPrice, taxRate,
          lineSubtotal, lineTax, lineTotal,
          newStockQty: it.stock_qty - l.quantity,
        })
      }
      // S513: apply a discount code (pre-tax) inside the txn — this
      // consumes a redemption under a row lock. The discount reduces the
      // taxable base, so we scale the accumulated per-line tax by
      // (discountedSubtotal / subtotal) — identical to a proportional
      // per-line discount, but without rewriting the stored line rows
      // (lines stay full-price; the discount shows as a transaction line).
      let discountAmount = 0
      let discountCodeId: string | null = null
      if (body.discountCode) {
        const applied = await applyDiscount(client, businessId, body.discountCode, subtotal)
        discountCodeId = applied.discountCodeId
        discountAmount = applied.discountAmount
        if (discountAmount > 0 && subtotal > 0) {
          const factor = (subtotal - discountAmount) / subtotal
          taxAmount = dec(taxAmount * factor)
        }
      }

      const totalAmount = dec(subtotal - discountAmount + taxAmount)
      // S512: tip is tracked apart from the sale. The customer pays the
      // grand total (sale + tip); cash tendered must cover it.
      const tipAmount = dec(body.tipAmount ?? 0)
      const grandTotal = dec(totalAmount + tipAmount)

      // Cash sale: change calc against the grand total (incl. tip).
      let changeDue: number | null = null
      if (body.paymentMethod === 'cash') {
        if (body.amountTendered === undefined) {
          throw new AppError(400, 'amountTendered required for cash sale')
        }
        if (body.amountTendered < grandTotal) {
          throw new AppError(400,
            `Tendered amount $${body.amountTendered.toFixed(2)} less than total $${grandTotal.toFixed(2)}`)
        }
        changeDue = dec(body.amountTendered - grandTotal)
      }

      // Bump receipt sequence (UPSERT pattern from S493).
      const { rows: [seq] } = await client.query<{ next_number: number }>(
        `INSERT INTO business_pos_sequences (business_id, next_number)
         VALUES ($1, 2)
         ON CONFLICT (business_id)
           DO UPDATE SET next_number = business_pos_sequences.next_number + 1
         RETURNING next_number`,
        [businessId])
      // On insert: next_number becomes 2, so this sale is #1.
      // On update: next_number is what the NEXT sale will be, so this sale is current - 1.
      const isFirstSale = seq.next_number === 2
      const thisSaleNumber = isFirstSale ? 1 : seq.next_number - 1
      const receiptNumber = fmtReceipt(thisSaleNumber)

      let cardSurcharge = 0
      // S536: a stripe_terminal sale must PROVE its payment — the PI
      // must exist on this business's Connect account, carry our
      // metadata, be captured (succeeded), and match the computed
      // total to the cent. Without this, a crafted request could
      // record a "paid" card sale that never charged anyone. (Stripe
      // round-trip inside the lock window is accepted v1 latency.)
      if (body.paymentMethod === 'stripe_terminal') {
        if (!body.stripePaymentIntentId) throw new AppError(400, 'stripePaymentIntentId is required for terminal sales')
        const { retrieveBusinessPI } = await import('../services/posTerminal')
        const pi = await retrieveBusinessPI(body.stripePaymentIntentId)
        if (pi.metadata?.gam_business_id !== businessId) throw new AppError(404, 'Payment not found')
        if (pi.status !== 'succeeded') throw new AppError(409, `Payment is ${pi.status} — complete the card payment on the reader first`)
        const { PLATFORM_FEES: VF } = await import('@gam/shared')
        // S561 (Nic): validate against the GRAND total (sale + tip) — the reader
        // is charged grandTotal (frontend BusinessRegisterPage charges
        // Math.round(grandTotal*100)). The prior `totalAmount` base excluded the
        // tip, so ANY tip made pi.amount mismatch → 409 AFTER the card was
        // captured (customer charged, sale never recorded). Tip presets are on
        // by default, so this fired constantly.
        const baseCents = Math.round(grandTotal * 100)
        const feeCents = Math.round(baseCents * VF.BUSINESS_TERMINAL_APP_FEE_PCT) + VF.BUSINESS_TERMINAL_APP_FEE_FIXED_CENTS
        if (pi.amount === baseCents + feeCents) {
          cardSurcharge = feeCents / 100  // customer-paid card fee, shown on the receipt
        } else if (pi.amount !== baseCents) {
          throw new AppError(409, 'Payment amount does not match the sale total — start the sale over')
        }
      }

      // Insert transaction.
      const { rows: [txn] } = await client.query<any>(
        `INSERT INTO business_pos_transactions
           (business_id, receipt_number, customer_id,
            subtotal, tax_amount, tip_amount, total_amount,
            discount_code_id, discount_amount,
            payment_method, amount_tendered, change_due,
            notes, cashier_user_id, stripe_payment_intent_id, card_surcharge)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
         RETURNING *`,
        [businessId, receiptNumber, body.customerId ?? null,
         subtotal, taxAmount, tipAmount, totalAmount,
         discountCodeId, discountAmount,
         body.paymentMethod,
         body.amountTendered ?? null,
         changeDue,
         body.notes ?? null,
         req.user!.userId,
         body.paymentMethod === 'stripe_terminal' ? body.stripePaymentIntentId ?? null : null,
         cardSurcharge])

      // Insert lines + decrement stock + audit adjustments.
      const lines: any[] = []
      for (let idx = 0; idx < calcs.length; idx++) {
        const c = calcs[idx]!
        const { rows: [line] } = await client.query<any>(
          `INSERT INTO business_pos_transaction_lines
             (transaction_id, item_id, name_snapshot, sku_snapshot,
              quantity, unit_price, tax_rate,
              line_subtotal, line_tax, line_total, sort_order)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           RETURNING *`,
          [txn.id, c.itemId, c.name, c.sku,
           c.quantity, c.unitPrice, c.taxRate,
           c.lineSubtotal, c.lineTax, c.lineTotal, idx])
        lines.push(line)

        // Decrement stock.
        await client.query(
          `UPDATE business_inventory_items
              SET stock_qty = $1
            WHERE id = $2`,
          [c.newStockQty, c.itemId])

        // Audit row.
        await client.query(
          `INSERT INTO business_inventory_adjustments
             (business_id, item_id, adjustment_type,
              quantity_delta, stock_qty_after, notes,
              actor_user_id, reference_type, reference_id)
           VALUES ($1, $2, 'sold', $3, $4, $5, $6, 'pos_transaction', $7)`,
          [businessId, c.itemId, -c.quantity, c.newStockQty,
           `Sold via ${receiptNumber}`,
           req.user!.userId, txn.id])
      }

      await client.query('COMMIT')
      res.status(201).json({ success: true, data: { ...txn, lines } })
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
    }
  } catch (e) { next(e) }
})

// ═══════════════════════════════════════════════════════════════
//  GET /transactions — list
// ═══════════════════════════════════════════════════════════════

const listSchema = z.object({
  status:   z.enum(['completed', 'refunded', 'void']).optional(),
  fromDate: z.string().optional(),
  toDate:   z.string().optional(),
  limit:    z.coerce.number().int().positive().max(500).optional(),
})

businessPosRouter.get('/transactions', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireUse(req)
    const q = listSchema.parse(req.query)
    const params: any[] = [businessId]
    let whereSql = 'WHERE t.business_id = $1'
    if (q.status)   { params.push(q.status);   whereSql += ` AND t.status = $${params.length}` }
    if (q.fromDate) { params.push(q.fromDate); whereSql += ` AND t.created_at >= $${params.length}::timestamptz` }
    if (q.toDate)   { params.push(q.toDate);   whereSql += ` AND t.created_at <= $${params.length}::timestamptz` }
    params.push(q.limit ?? 100)
    const rows = await query<any>(
      `SELECT t.id, t.receipt_number, t.status,
              t.subtotal, t.tax_amount, t.tip_amount, t.total_amount,
              t.payment_method, t.refunded_at,
              t.customer_id,
              c.first_name AS customer_first_name,
              c.last_name  AS customer_last_name,
              c.company_name AS customer_business_name,
              t.created_at
         FROM business_pos_transactions t
         LEFT JOIN business_customers c ON c.id = t.customer_id
         ${whereSql}
        ORDER BY t.created_at DESC
        LIMIT $${params.length}`, params)
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

// ═══════════════════════════════════════════════════════════════
//  GET /transactions/:id — detail with lines
// ═══════════════════════════════════════════════════════════════

businessPosRouter.get('/transactions/:id', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireUse(req)
    const txn = await queryOne<any>(
      `SELECT t.*,
              c.first_name AS customer_first_name,
              c.last_name  AS customer_last_name,
              c.company_name AS customer_business_name,
              c.email AS customer_email
         FROM business_pos_transactions t
         LEFT JOIN business_customers c ON c.id = t.customer_id
        WHERE t.id = $1 AND t.business_id = $2`,
      [req.params.id, businessId])
    if (!txn) throw new AppError(404, 'Transaction not found')
    const lines = await query<any>(
      `SELECT * FROM business_pos_transaction_lines
        WHERE transaction_id = $1
        ORDER BY sort_order ASC`, [txn.id])
    res.json({ success: true, data: { ...txn, lines } })
  } catch (e) { next(e) }
})

// ═══════════════════════════════════════════════════════════════
//  GET /transactions/:id/pdf — printable receipt (S504)
// ═══════════════════════════════════════════════════════════════

businessPosRouter.get('/transactions/:id/pdf', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireUse(req)
    const txn = await queryOne<any>(
      `SELECT t.*,
              b.name AS biz_name, b.email AS biz_email, b.phone AS biz_phone,
              b.street1 AS biz_street1, b.street2 AS biz_street2,
              b.city AS biz_city, b.state AS biz_state, b.zip AS biz_zip,
              c.first_name AS customer_first_name,
              c.last_name AS customer_last_name,
              c.company_name AS customer_company_name,
              c.email AS customer_email, c.phone AS customer_phone,
              c.street1 AS customer_street1, c.city AS customer_city,
              c.state AS customer_state, c.zip AS customer_zip
         FROM business_pos_transactions t
         JOIN businesses b ON b.id = t.business_id
         LEFT JOIN business_customers c ON c.id = t.customer_id
        WHERE t.id = $1 AND t.business_id = $2`,
      [req.params.id, businessId])
    if (!txn) throw new AppError(404, 'Transaction not found')
    const lines = await query<any>(
      `SELECT name_snapshot AS description, quantity, unit_price, line_total
         FROM business_pos_transaction_lines
        WHERE transaction_id = $1 ORDER BY sort_order ASC`, [txn.id])

    const { renderPosReceiptPdf } = await import('../services/businessPdf')
    const buffer = await renderPosReceiptPdf({
      business: {
        name: txn.biz_name, email: txn.biz_email, phone: txn.biz_phone,
        street1: txn.biz_street1, street2: txn.biz_street2,
        city: txn.biz_city, state: txn.biz_state, zip: txn.biz_zip,
      },
      customer: txn.customer_first_name || txn.customer_company_name ? {
        firstName: txn.customer_first_name, lastName: txn.customer_last_name,
        companyName: txn.customer_company_name,
        email: txn.customer_email, phone: txn.customer_phone,
        street1: txn.customer_street1, city: txn.customer_city,
        state: txn.customer_state, zip: txn.customer_zip,
      } : null,
      receiptNumber: txn.receipt_number,
      createdAt: txn.created_at,
      status: txn.status,
      paymentMethod: txn.payment_method,
      amountTendered: txn.amount_tendered !== null ? Number(txn.amount_tendered) : null,
      changeDue:      txn.change_due      !== null ? Number(txn.change_due)      : null,
      refundReason: txn.refund_reason,
      lines: lines.map(l => ({
        description: l.description,
        quantity:    Number(l.quantity),
        unitPrice:   Number(l.unit_price),
        lineTotal:   Number(l.line_total),
      })),
      subtotal:       Number(txn.subtotal),
      discountAmount: Number(txn.discount_amount),
      taxAmount:      Number(txn.tax_amount),
      tipAmount:      Number(txn.tip_amount),
      totalAmount:    Number(txn.total_amount),
    })

    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `inline; filename="${txn.receipt_number}.pdf"`)
    res.send(buffer)
  } catch (e) { next(e) }
})

// ═══════════════════════════════════════════════════════════════
//  S536 (Nic) — Stripe Terminal for businesses. "The payment
//  acceptance screen is linked to a reader the POS user sets up in
//  settings; swiping or tapping completes the transaction." Direct
//  charges on the business's Connect account (business pays Stripe's
//  card-present cost); GAM's markup rides as application_fee_amount
//  (shared PLATFORM_FEES.BUSINESS_TERMINAL_APP_FEE_*) — GAM cannot
//  lose money on a sale. Mirrors the property flow in routes/pos.ts.
// ═══════════════════════════════════════════════════════════════

async function getBusinessConnectId(businessId: string): Promise<string> {
  const row = await queryOne<{ stripe_connect_account_id: string | null; connect_payouts_enabled: boolean }>(
    `SELECT stripe_connect_account_id, connect_payouts_enabled FROM businesses WHERE id = $1`,
    [businessId])
  if (!row?.stripe_connect_account_id || !row.connect_payouts_enabled) {
    throw new AppError(409, 'Card readers need a completed Stripe payout setup — finish onboarding in the Business portal first')
  }
  return row.stripe_connect_account_id
}

// GET /cash-report?date=YYYY-MM-DD — S536 (Nic): end-of-day drawer
// reconciliation. Expected cash = the day's cash sales minus cash
// refunds issued that day; the operator counts the drawer against it.
// This is the standard control for the one thing software can't see:
// payments taken outside the system but rung as cash.
businessPosRouter.get('/cash-report', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireUse(req)
    const date = typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)
      ? req.query.date
      : new Date().toLocaleDateString('en-CA', { timeZone: 'America/Phoenix' })
    const [row] = await query<any>(
      `SELECT
         COUNT(*) FILTER (WHERE payment_method = 'cash')::int                                   AS cash_sales,
         COALESCE(SUM(total_amount) FILTER (WHERE payment_method = 'cash'), 0)::float           AS cash_collected,
         COUNT(*) FILTER (WHERE payment_method = 'stripe_terminal')::int                        AS card_sales,
         COALESCE(SUM(total_amount + card_surcharge) FILTER (WHERE payment_method = 'stripe_terminal'), 0)::float AS card_collected,
         COUNT(*) FILTER (WHERE payment_method = 'card_recorded')::int                          AS recorded_card_sales,
         COALESCE(SUM(total_amount) FILTER (WHERE payment_method = 'card_recorded'), 0)::float  AS recorded_card_collected
       FROM business_pos_transactions
      WHERE business_id = $1
        AND (created_at AT TIME ZONE 'America/Phoenix')::date = $2::date
        AND status != 'voided'`,
      [businessId, date])
    const [ref] = await query<any>(
      `SELECT COALESCE(SUM(refunded_amount), 0)::float AS cash_refunded
         FROM business_pos_transactions
        WHERE business_id = $1
          AND payment_method = 'cash'
          AND refunded_at IS NOT NULL
          AND (refunded_at AT TIME ZONE 'America/Phoenix')::date = $2::date`,
      [businessId, date])
    const cashRefunded = Number(ref?.cash_refunded ?? 0)
    res.json({ success: true, data: {
      date,
      cashSales:      row?.cash_sales ?? 0,
      cashCollected:  Number(row?.cash_collected ?? 0),
      cashRefunded,
      expectedDrawer: Math.round((Number(row?.cash_collected ?? 0) - cashRefunded) * 100) / 100,
      cardSales:      row?.card_sales ?? 0,
      cardCollected:  Number(row?.card_collected ?? 0),
      recordedCardSales:     row?.recorded_card_sales ?? 0,
      recordedCardCollected: Number(row?.recorded_card_collected ?? 0),
    } })
  } catch (e) { next(e) }
})

// GET /register-config — register-facing settings readable by ANY
// pos.use-permitted user (staff included; /businesses/me is owner-only).
businessPosRouter.get('/register-config', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireUse(req)
    const row = await queryOne<any>(
      `SELECT tips_enabled, card_fees_paid_by, enabled_features FROM businesses WHERE id = $1`, [businessId])
    res.json({ success: true, data: {
      tipsEnabled: row?.tips_enabled ?? true,
      cardFeesPaidBy: row?.card_fees_paid_by ?? 'business',
      discountsEnabled: (row?.enabled_features ?? []).includes('discounts'),
    } })
  } catch (e) { next(e) }
})

businessPosRouter.post('/terminal/connection-token', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireUse(req)
    const { createConnectionToken } = await import('../services/posTerminal')
    const secret = await createConnectionToken(await getBusinessConnectId(businessId))
    res.json({ success: true, data: { secret } })
  } catch (e) { next(e) }
})

businessPosRouter.post('/terminal/readers', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireUse(req)
    const { registrationCode, nickname, label } = req.body
    if (!registrationCode) throw new AppError(400, 'registrationCode is required (shown on the reader screen)')
    if (!nickname) throw new AppError(400, 'nickname is required')
    const { registerBusinessReader } = await import('../services/posTerminal')
    const row = await registerBusinessReader({
      businessId,
      businessConnectAccountId: await getBusinessConnectId(businessId),
      registrationCode: String(registrationCode).trim(),
      nickname:         String(nickname).trim(),
      label:            label ? String(label).trim() : undefined,
    })
    res.status(201).json({ success: true, data: row })
  } catch (e) { next(e) }
})

businessPosRouter.get('/terminal/readers', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireUse(req)
    const { listBusinessReaders } = await import('../services/posTerminal')
    res.json({ success: true, data: await listBusinessReaders(businessId) })
  } catch (e) { next(e) }
})

businessPosRouter.delete('/terminal/readers/:id', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireUse(req)
    const { archiveBusinessReader } = await import('../services/posTerminal')
    res.json({ success: true, data: await archiveBusinessReader(businessId, req.params.id) })
  } catch (e) { next(e) }
})

// Create PI + push it to the reader in one call — the register's
// "Card" button becomes: call this, poll status, done when captured.
businessPosRouter.post('/terminal/charge', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireUse(req)
    const { amountCents, stripeReaderId } = req.body
    if (!Number.isInteger(amountCents) || amountCents <= 0) throw new AppError(400, 'amountCents must be a positive integer')
    if (!stripeReaderId) throw new AppError(400, 'stripeReaderId is required')
    const { assertBusinessReader, createBusinessCardPresentPaymentIntent, processBusinessPIOnReader } =
      await import('../services/posTerminal')
    await assertBusinessReader(businessId, stripeReaderId)
    const connectId = await getBusinessConnectId(businessId)
    const { PLATFORM_FEES } = await import('@gam/shared')
    const fee = Math.round(amountCents * PLATFORM_FEES.BUSINESS_TERMINAL_APP_FEE_PCT)
      + PLATFORM_FEES.BUSINESS_TERMINAL_APP_FEE_FIXED_CENTS
    // S536 (Nic): card_fees_paid_by toggle auto-applies to EVERY card
    // transaction — 'customer' adds the fee on top as a surcharge;
    // 'business' nets it out of the gross (default).
    const biz = await queryOne<{ card_fees_paid_by: string }>(
      `SELECT card_fees_paid_by FROM businesses WHERE id = $1`, [businessId])
    const customerPays = biz?.card_fees_paid_by === 'customer'
    const chargeCents = customerPays ? amountCents + fee : amountCents
    const intent = await createBusinessCardPresentPaymentIntent({
      businessConnectAccountId: connectId,
      businessId,
      amountCents: chargeCents,
      platformCutCents: fee,
      description: 'POS sale',
    })
    await processBusinessPIOnReader({ stripeReaderId, paymentIntentId: intent.id })
    res.status(201).json({ success: true, data: { paymentIntentId: intent.id, status: intent.status, chargedCents: chargeCents, surchargeCents: customerPays ? fee : 0 } })
  } catch (e) { next(e) }
})

// Poll: the reader prompts the customer asynchronously; the register
// polls until requires_capture, then we capture — tap/swipe completes
// the sale with no second workflow.
businessPosRouter.get('/terminal/payment-intents/:id', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireUse(req)
    const { retrieveBusinessPI, captureBusinessPI } = await import('../services/posTerminal')
    let intent = await retrieveBusinessPI(req.params.id)
    if (intent.metadata?.gam_business_id !== businessId) throw new AppError(404, 'Payment not found')
    if (intent.status === 'requires_capture') {
      intent = await captureBusinessPI(intent.id)
    }
    res.json({ success: true, data: { id: intent.id, status: intent.status, amount: intent.amount } })
  } catch (e) { next(e) }
})

businessPosRouter.post('/terminal/payment-intents/:id/cancel', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireUse(req)
    const { retrieveBusinessPI, cancelBusinessPI } = await import('../services/posTerminal')
    const intent = await retrieveBusinessPI(req.params.id)
    if (intent.metadata?.gam_business_id !== businessId) throw new AppError(404, 'Payment not found')
    const canceled = await cancelBusinessPI(intent.id)
    res.json({ success: true, data: { id: canceled.id, status: canceled.status } })
  } catch (e) { next(e) }
})

// ═══════════════════════════════════════════════════════════════
//  POST /transactions/:id/email-receipt — S536 (Nic): receipts go out
//  by email (PDF attached); in-product printing is retired. Recipient
//  is the request's email, falling back to the transaction customer's
//  email. Same data assembly as GET /:id/pdf above.
// ═══════════════════════════════════════════════════════════════

const emailReceiptSchema = z.object({ email: z.string().email().optional() })

businessPosRouter.post('/transactions/:id/email-receipt', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireUse(req)
    const body = emailReceiptSchema.parse(req.body ?? {})
    const txn = await queryOne<any>(
      `SELECT t.*,
              b.name AS biz_name, b.email AS biz_email, b.phone AS biz_phone,
              b.street1 AS biz_street1, b.street2 AS biz_street2,
              b.city AS biz_city, b.state AS biz_state, b.zip AS biz_zip,
              c.first_name AS customer_first_name,
              c.last_name AS customer_last_name,
              c.company_name AS customer_company_name,
              c.email AS customer_email, c.phone AS customer_phone,
              c.street1 AS customer_street1, c.city AS customer_city,
              c.state AS customer_state, c.zip AS customer_zip
         FROM business_pos_transactions t
         JOIN businesses b ON b.id = t.business_id
         LEFT JOIN business_customers c ON c.id = t.customer_id
        WHERE t.id = $1 AND t.business_id = $2`,
      [req.params.id, businessId])
    if (!txn) throw new AppError(404, 'Transaction not found')

    const to = body.email || txn.customer_email
    if (!to) throw new AppError(400, 'No email on file for this customer — enter one to send the receipt')

    const lines = await query<any>(
      `SELECT name_snapshot AS description, quantity, unit_price, line_total
         FROM business_pos_transaction_lines
        WHERE transaction_id = $1 ORDER BY sort_order ASC`, [txn.id])

    const { renderPosReceiptPdf } = await import('../services/businessPdf')
    const buffer = await renderPosReceiptPdf({
      business: {
        name: txn.biz_name, email: txn.biz_email, phone: txn.biz_phone,
        street1: txn.biz_street1, street2: txn.biz_street2,
        city: txn.biz_city, state: txn.biz_state, zip: txn.biz_zip,
      },
      customer: txn.customer_first_name || txn.customer_company_name ? {
        firstName: txn.customer_first_name, lastName: txn.customer_last_name,
        companyName: txn.customer_company_name,
        email: txn.customer_email, phone: txn.customer_phone,
        street1: txn.customer_street1, city: txn.customer_city,
        state: txn.customer_state, zip: txn.customer_zip,
      } : null,
      receiptNumber: txn.receipt_number,
      createdAt: txn.created_at,
      status: txn.status,
      paymentMethod: txn.payment_method,
      amountTendered: txn.amount_tendered !== null ? Number(txn.amount_tendered) : null,
      changeDue:      txn.change_due      !== null ? Number(txn.change_due)      : null,
      refundReason: txn.refund_reason,
      lines: lines.map(l => ({
        description: l.description,
        quantity:    Number(l.quantity),
        unitPrice:   Number(l.unit_price),
        lineTotal:   Number(l.line_total),
      })),
      subtotal:       Number(txn.subtotal),
      discountAmount: Number(txn.discount_amount),
      taxAmount:      Number(txn.tax_amount),
      tipAmount:      Number(txn.tip_amount),
      totalAmount:    Number(txn.total_amount),
    })

    const { emailPosReceipt } = await import('../services/email')
    await emailPosReceipt(to, txn.biz_name, txn.receipt_number, Number(txn.total_amount), buffer,
      { relatedEntityType: 'business_pos_transaction', relatedEntityId: txn.id })
    res.json({ success: true, data: { sentTo: to } })
  } catch (e) { next(e) }
})

// ═══════════════════════════════════════════════════════════════
//  POST /transactions/:id/refund — full OR partial (line-level) refund
// ═══════════════════════════════════════════════════════════════
//
// Body: { reason, lines?: [{ lineId, quantity }] }
//   - omit `lines` → refund everything still outstanding (full refund of
//     the remaining quantity on every line).
//   - provide `lines` → refund just those quantities (must be ≤ what's
//     left on each line). The sale flips to 'partially_refunded' until
//     every line is fully returned, then 'refunded'.
//
// Refund dollars are proportional to the ACTUAL charged total, so a
// discounted sale refunds the discounted amount:
//   line refund = unit_price * qty / subtotal * total_amount.
// Restores stock + writes a 'received' adjustment per refunded line.

const refundSchema = z.object({
  reason: z.string().min(1).max(500),
  lines:  z.array(z.object({
    lineId:   z.string().uuid(),
    quantity: z.number().int().positive(),
  })).min(1).optional(),
})

businessPosRouter.post('/transactions/:id/refund', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireRefund(req)
    const body = refundSchema.parse(req.body)

    const client = await db.connect()
    try {
      await client.query('BEGIN')

      const { rows: [txn] } = await client.query<{
        id: string; receipt_number: string; status: string;
        subtotal: string; total_amount: string; refunded_amount: string;
      }>(
        `SELECT id, receipt_number, status, subtotal, total_amount, refunded_amount
           FROM business_pos_transactions
          WHERE id = $1 AND business_id = $2
          FOR UPDATE`,
        [req.params.id, businessId])
      if (!txn) {
        await client.query('ROLLBACK')
        throw new AppError(404, 'Transaction not found')
      }
      // Can refund a completed sale or keep refunding a partially-refunded one.
      if (txn.status !== 'completed' && txn.status !== 'partially_refunded') {
        await client.query('ROLLBACK')
        throw new AppError(409, `Cannot refund a ${txn.status} sale`)
      }

      const { rows: lines } = await client.query<{
        id: string; item_id: string; quantity: number;
        refunded_qty: number; unit_price: string;
      }>(
        `SELECT id, item_id, quantity, refunded_qty, unit_price
           FROM business_pos_transaction_lines
          WHERE transaction_id = $1
          ORDER BY item_id`,
        [txn.id])
      const lineById = new Map(lines.map(l => [l.id, l]))

      // Build the list of (line, refundQty) to process.
      let toRefund: Array<{ line: typeof lines[number]; qty: number }>
      if (body.lines) {
        toRefund = body.lines.map(req => {
          const line = lineById.get(req.lineId)
          if (!line) throw new AppError(404, `Line ${req.lineId} not found on this sale`)
          const remaining = line.quantity - line.refunded_qty
          if (req.quantity > remaining) {
            throw new AppError(400,
              `Cannot refund ${req.quantity} of "${line.item_id}" — only ${remaining} left to refund`)
          }
          return { line, qty: req.quantity }
        })
      } else {
        // Full refund of whatever remains.
        toRefund = lines
          .map(line => ({ line, qty: line.quantity - line.refunded_qty }))
          .filter(x => x.qty > 0)
      }
      if (toRefund.length === 0) {
        await client.query('ROLLBACK')
        throw new AppError(409, 'Nothing left to refund on this sale')
      }

      const subtotal = dec(txn.subtotal)
      const totalAmount = dec(txn.total_amount)
      let refundSum = 0

      for (const { line, qty } of toRefund) {
        // Restore stock + audit.
        const { rows: [item] } = await client.query<{ stock_qty: number }>(
          `SELECT stock_qty FROM business_inventory_items WHERE id = $1 FOR UPDATE`,
          [line.item_id])
        const newQty = (item?.stock_qty ?? 0) + qty
        await client.query(
          `UPDATE business_inventory_items SET stock_qty = $1 WHERE id = $2`,
          [newQty, line.item_id])
        await client.query(
          `INSERT INTO business_inventory_adjustments
             (business_id, item_id, adjustment_type,
              quantity_delta, stock_qty_after, notes,
              actor_user_id, reference_type, reference_id)
           VALUES ($1, $2, 'received', $3, $4, $5, $6, 'pos_transaction', $7)`,
          [businessId, line.item_id, qty, newQty,
           `Refund of ${txn.receipt_number}`,
           req.user!.userId, txn.id])
        // Bump refunded_qty on the line.
        await client.query(
          `UPDATE business_pos_transaction_lines
              SET refunded_qty = refunded_qty + $1 WHERE id = $2`,
          [qty, line.id])
        // Proportional refund dollars vs the actual charged total.
        const share = subtotal > 0
          ? dec((dec(Number(line.unit_price) * qty) / subtotal) * totalAmount)
          : 0
        refundSum = dec(refundSum + share)
      }

      // Fully refunded when nothing remains across all lines.
      const { rows: [{ remaining }] } = await client.query<{ remaining: number }>(
        `SELECT COALESCE(SUM(quantity - refunded_qty), 0)::int AS remaining
           FROM business_pos_transaction_lines WHERE transaction_id = $1`,
        [txn.id])
      const newStatus = remaining === 0 ? 'refunded' : 'partially_refunded'
      const newRefundedAmount = dec(Number(txn.refunded_amount) + refundSum)

      const { rows: [updated] } = await client.query<any>(
        `UPDATE business_pos_transactions
            SET status = $1,
                refunded_at = COALESCE(refunded_at, NOW()),
                refunded_amount = $2,
                refund_reason = $3
          WHERE id = $4
          RETURNING *`,
        [newStatus, newRefundedAmount, body.reason.trim(), txn.id])

      const { rows: updatedLines } = await client.query<any>(
        `SELECT * FROM business_pos_transaction_lines
          WHERE transaction_id = $1 ORDER BY sort_order ASC`, [txn.id])

      await client.query('COMMIT')
      res.json({ success: true, data: { ...updated, lines: updatedLines, refundedThisTime: refundSum } })
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
    }
  } catch (e) { next(e) }
})

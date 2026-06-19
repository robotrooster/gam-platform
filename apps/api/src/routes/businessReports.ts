/**
 * S503 — business-portal reports / analytics.
 *
 * Single aggregate endpoint:
 *   GET /api/business-reports/overview?range=30d|90d|365d
 *
 * Returns a feature-aware bundle of report sections. Each section is
 * only computed when its underlying feature is enabled — null
 * otherwise. The dashboard already covers "morning glance" stats;
 * reports go deeper:
 *
 *   - revenue: daily series + period totals + period-over-period delta
 *   - top_customers: by lifetime revenue + last activity
 *   - pos: top-selling items + total sales + refund total
 *   - inventory: full low-stock list, stock value at cost, shrinkage units
 *   - work_orders: avg completion time, labor hours billed, top complaints
 *   - quotes: acceptance rate, avg value, status counts
 *
 * All date filtering uses created_at on the underlying table because
 * that's the operator's mental model ("how did last month look").
 */

import { Router } from 'express'
import { z } from 'zod'
import { db, query } from '../db'
import { requireAuth } from '../middleware/auth'
import { requireBusinessAccess } from '../middleware/businessAccess'

export const businessReportsRouter = Router()

const RANGE_DAYS: Record<string, number> = { '30d': 30, '90d': 90, '365d': 365 }

const querySchema = z.object({
  range: z.enum(['30d', '90d', '365d']).optional(),
})

businessReportsRouter.get('/overview', requireAuth, async (req, res, next) => {
  try {
    const access = await requireBusinessAccess(req, { permission: 'reports.view' })
    const { range = '30d' } = querySchema.parse(req.query)
    const days = RANGE_DAYS[range]!
    const features = new Set(access.enabledFeatures)
    const businessId = access.businessId

    // ─── Revenue (always — POS or invoices or both) ─────────────
    // Daily series across the range from POS + invoiced + collected.
    // CTE generates the full date series so days with $0 still show
    // up (UI renders a flat line rather than dropping the point).
    const { rows: dailyRevenue } = await db.query<{
      day: string; pos_revenue: string; invoiced: string; collected: string;
    }>(
      `WITH days AS (
         SELECT generate_series(
           (CURRENT_DATE - ($1::int - 1) * INTERVAL '1 day')::date,
           CURRENT_DATE,
           '1 day'::interval
         )::date AS day
       )
       SELECT
         d.day::text AS day,
         COALESCE((
           SELECT SUM(total_amount) FROM business_pos_transactions
            WHERE business_id = $2 AND status = 'completed'
              AND created_at::date = d.day
         ), 0) AS pos_revenue,
         COALESCE((
           SELECT SUM(total_amount) FROM business_invoices
            WHERE business_id = $2 AND status IN ('sent', 'paid')
              AND issue_date = d.day
         ), 0) AS invoiced,
         COALESCE((
           SELECT SUM(amount_paid) FROM business_invoices
            WHERE business_id = $2 AND status = 'paid'
              AND paid_at::date = d.day
         ), 0) AS collected
       FROM days d
       ORDER BY d.day ASC`,
      [days, businessId])

    // Period totals + prior-period totals (same length, immediately before)
    const { rows: [pt] } = await db.query<{
      cur_pos: string; cur_inv: string; cur_col: string;
      prv_pos: string; prv_inv: string; prv_col: string;
    }>(
      `SELECT
         COALESCE((SELECT SUM(total_amount) FROM business_pos_transactions
                    WHERE business_id = $1 AND status = 'completed'
                      AND created_at::date >= CURRENT_DATE - ($2::int - 1)
                      AND created_at::date <= CURRENT_DATE), 0) AS cur_pos,
         COALESCE((SELECT SUM(total_amount) FROM business_invoices
                    WHERE business_id = $1 AND status IN ('sent', 'paid')
                      AND issue_date >= CURRENT_DATE - ($2::int - 1)
                      AND issue_date <= CURRENT_DATE), 0) AS cur_inv,
         COALESCE((SELECT SUM(amount_paid) FROM business_invoices
                    WHERE business_id = $1 AND status = 'paid'
                      AND paid_at::date >= CURRENT_DATE - ($2::int - 1)
                      AND paid_at::date <= CURRENT_DATE), 0) AS cur_col,
         COALESCE((SELECT SUM(total_amount) FROM business_pos_transactions
                    WHERE business_id = $1 AND status = 'completed'
                      AND created_at::date >= CURRENT_DATE - (2 * $2::int - 1)
                      AND created_at::date <= CURRENT_DATE - $2::int), 0) AS prv_pos,
         COALESCE((SELECT SUM(total_amount) FROM business_invoices
                    WHERE business_id = $1 AND status IN ('sent', 'paid')
                      AND issue_date >= CURRENT_DATE - (2 * $2::int - 1)
                      AND issue_date <= CURRENT_DATE - $2::int), 0) AS prv_inv,
         COALESCE((SELECT SUM(amount_paid) FROM business_invoices
                    WHERE business_id = $1 AND status = 'paid'
                      AND paid_at::date >= CURRENT_DATE - (2 * $2::int - 1)
                      AND paid_at::date <= CURRENT_DATE - $2::int), 0) AS prv_col`,
      [businessId, days])

    const revenue = {
      range,
      days,
      daily_series: dailyRevenue,
      period_totals: {
        pos:        pt.cur_pos,
        invoiced:   pt.cur_inv,
        collected:  pt.cur_col,
      },
      prior_period_totals: {
        pos:        pt.prv_pos,
        invoiced:   pt.prv_inv,
        collected:  pt.prv_col,
      },
    }

    // ─── Top customers (by gross revenue within range) ──────────
    // Lifetime alternative deferred — period is more actionable.
    const topCustomers = await query<any>(
      `SELECT c.id, c.first_name, c.last_name, c.company_name,
              c.email, c.phone,
              COALESCE(pos.amt, 0) + COALESCE(inv.amt, 0) AS total_revenue,
              COALESCE(pos.cnt, 0) AS pos_count,
              COALESCE(inv.cnt, 0) AS invoice_count,
              GREATEST(
                COALESCE(pos.last_at, '-infinity'::timestamptz),
                COALESCE(inv.last_at, '-infinity'::timestamptz)
              ) AS last_activity
         FROM business_customers c
         LEFT JOIN (
           SELECT customer_id,
                  SUM(total_amount) AS amt,
                  COUNT(*)::int AS cnt,
                  MAX(created_at) AS last_at
             FROM business_pos_transactions
            WHERE business_id = $1 AND status = 'completed'
              AND created_at::date >= CURRENT_DATE - ($2::int - 1)
              AND customer_id IS NOT NULL
            GROUP BY customer_id
         ) pos ON pos.customer_id = c.id
         LEFT JOIN (
           SELECT customer_id,
                  SUM(total_amount) AS amt,
                  COUNT(*)::int AS cnt,
                  MAX(issue_date) AS last_at
             FROM business_invoices
            WHERE business_id = $1 AND status IN ('sent', 'paid')
              AND issue_date >= CURRENT_DATE - ($2::int - 1)
            GROUP BY customer_id
         ) inv ON inv.customer_id = c.id
        WHERE c.business_id = $1
          AND (COALESCE(pos.amt, 0) + COALESCE(inv.amt, 0)) > 0
        ORDER BY total_revenue DESC
        LIMIT 20`,
      [businessId, days])

    // ─── POS section ────────────────────────────────────────────
    let pos: any = null
    if (features.has('pos')) {
      const topItems = await query<any>(
        `SELECT l.item_id, l.name_snapshot, l.sku_snapshot,
                SUM(l.quantity)::int AS units_sold,
                SUM(l.line_total)    AS revenue,
                COUNT(DISTINCT t.id) AS sale_count
           FROM business_pos_transaction_lines l
           JOIN business_pos_transactions t ON t.id = l.transaction_id
          WHERE t.business_id = $1
            AND t.status = 'completed'
            AND t.created_at::date >= CURRENT_DATE - ($2::int - 1)
          GROUP BY l.item_id, l.name_snapshot, l.sku_snapshot
          ORDER BY revenue DESC
          LIMIT 10`, [businessId, days])

      const { rows: [salesAgg] } = await db.query<{
        total_sales: string; sale_count: number;
        refund_count: number; refund_amount: string;
        total_tips: string;
      }>(
        `SELECT
           COALESCE(SUM(CASE WHEN status = 'completed' THEN total_amount ELSE 0 END), 0) AS total_sales,
           SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END)::int AS sale_count,
           SUM(CASE WHEN status = 'refunded'  THEN 1 ELSE 0 END)::int AS refund_count,
           COALESCE(SUM(CASE WHEN status = 'refunded' THEN total_amount ELSE 0 END), 0) AS refund_amount,
           -- S512: tips collected on completed sales, tracked apart from sales revenue.
           COALESCE(SUM(CASE WHEN status = 'completed' THEN tip_amount ELSE 0 END), 0) AS total_tips
         FROM business_pos_transactions
         WHERE business_id = $1
           AND created_at::date >= CURRENT_DATE - ($2::int - 1)`,
        [businessId, days])

      pos = {
        top_items: topItems,
        total_sales: salesAgg.total_sales,
        sale_count: salesAgg.sale_count,
        refund_count: salesAgg.refund_count,
        refund_amount: salesAgg.refund_amount,
        total_tips: salesAgg.total_tips,
      }
    }

    // ─── Inventory section ──────────────────────────────────────
    let inventory: any = null
    if (features.has('inventory')) {
      const lowStock = await query<any>(
        `SELECT id, name, sku, stock_qty, stock_min, sell_price, cost_price
           FROM business_inventory_items
          WHERE business_id = $1
            AND is_active = TRUE
            AND stock_min > 0
            AND stock_qty <= stock_min
          ORDER BY (stock_min - stock_qty) DESC
          LIMIT 50`, [businessId])

      const { rows: [stockAgg] } = await db.query<{
        active_items: number; total_units: number; stock_value_at_cost: string;
      }>(
        `SELECT COUNT(*)::int AS active_items,
                COALESCE(SUM(stock_qty), 0)::int AS total_units,
                COALESCE(SUM(stock_qty * cost_price), 0) AS stock_value_at_cost
           FROM business_inventory_items
          WHERE business_id = $1 AND is_active = TRUE`,
        [businessId])

      // Shrinkage units across the range (negative deltas, shrinkage type).
      const { rows: [shrink] } = await db.query<{
        shrinkage_units: number; shrinkage_value: string;
      }>(
        `SELECT
           COALESCE(SUM(-a.quantity_delta), 0)::int AS shrinkage_units,
           COALESCE(SUM(-a.quantity_delta * i.cost_price), 0) AS shrinkage_value
         FROM business_inventory_adjustments a
         JOIN business_inventory_items i ON i.id = a.item_id
         WHERE a.business_id = $1
           AND a.adjustment_type = 'shrinkage'
           AND a.created_at::date >= CURRENT_DATE - ($2::int - 1)`,
        [businessId, days])

      inventory = {
        low_stock: lowStock,
        active_items: stockAgg.active_items,
        total_units: stockAgg.total_units,
        stock_value_at_cost: stockAgg.stock_value_at_cost,
        shrinkage_units: shrink.shrinkage_units,
        shrinkage_value: shrink.shrinkage_value,
      }
    }

    // ─── Work orders ────────────────────────────────────────────
    let workOrders: any = null
    if (features.has('work_orders')) {
      const { rows: [woAgg] } = await db.query<{
        total_count: number;
        completed_count: number;
        cancelled_count: number;
        avg_completion_hours: string | null;
        total_billed: string;
        total_labor_billed: string;
        total_parts_billed: string;
      }>(
        `SELECT
           COUNT(*)::int AS total_count,
           SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END)::int AS completed_count,
           SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END)::int AS cancelled_count,
           AVG(EXTRACT(EPOCH FROM (completed_at - created_at)) / 3600.0) FILTER (WHERE status = 'completed') AS avg_completion_hours,
           COALESCE(SUM(total_amount)   FILTER (WHERE status = 'completed'), 0) AS total_billed,
           COALESCE(SUM(labor_subtotal) FILTER (WHERE status = 'completed'), 0) AS total_labor_billed,
           COALESCE(SUM(parts_subtotal) FILTER (WHERE status = 'completed'), 0) AS total_parts_billed
         FROM business_work_orders
         WHERE business_id = $1
           AND created_at::date >= CURRENT_DATE - ($2::int - 1)`,
        [businessId, days])

      // Most-frequent complaints (truncated for grouping)
      const topComplaints = await query<any>(
        `SELECT LEFT(LOWER(TRIM(complaint)), 50) AS complaint_key,
                COUNT(*)::int AS occurrences
           FROM business_work_orders
          WHERE business_id = $1
            AND complaint IS NOT NULL AND LENGTH(TRIM(complaint)) > 0
            AND created_at::date >= CURRENT_DATE - ($2::int - 1)
          GROUP BY complaint_key
          ORDER BY occurrences DESC
          LIMIT 5`, [businessId, days])

      workOrders = {
        total_count: woAgg.total_count,
        completed_count: woAgg.completed_count,
        cancelled_count: woAgg.cancelled_count,
        avg_completion_hours: woAgg.avg_completion_hours,
        total_billed: woAgg.total_billed,
        total_labor_billed: woAgg.total_labor_billed,
        total_parts_billed: woAgg.total_parts_billed,
        top_complaints: topComplaints,
      }
    }

    // ─── Quotes ─────────────────────────────────────────────────
    let quotes: any = null
    if (features.has('quotes')) {
      const { rows: [qAgg] } = await db.query<{
        total_count: number;
        sent_count: number;
        accepted_count: number;
        declined_count: number;
        expired_count: number;
        avg_value: string | null;
        accepted_value: string;
      }>(
        `SELECT
           COUNT(*)::int AS total_count,
           SUM(CASE WHEN status = 'sent'     THEN 1 ELSE 0 END)::int AS sent_count,
           SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END)::int AS accepted_count,
           SUM(CASE WHEN status = 'declined' THEN 1 ELSE 0 END)::int AS declined_count,
           SUM(CASE WHEN status = 'expired'  THEN 1 ELSE 0 END)::int AS expired_count,
           AVG(total_amount) AS avg_value,
           COALESCE(SUM(total_amount) FILTER (WHERE status = 'accepted'), 0) AS accepted_value
         FROM business_quotes
         WHERE business_id = $1
           AND created_at::date >= CURRENT_DATE - ($2::int - 1)`,
        [businessId, days])

      // Acceptance rate = accepted / (accepted + declined). Excludes
      // sent (still pending) and draft (never went out) from the
      // denominator — those aren't decisions yet.
      const decisions = qAgg.accepted_count + qAgg.declined_count
      const acceptanceRate = decisions > 0
        ? qAgg.accepted_count / decisions
        : null

      quotes = {
        total_count: qAgg.total_count,
        sent_count: qAgg.sent_count,
        accepted_count: qAgg.accepted_count,
        declined_count: qAgg.declined_count,
        expired_count: qAgg.expired_count,
        avg_value: qAgg.avg_value,
        accepted_value: qAgg.accepted_value,
        acceptance_rate: acceptanceRate,
      }
    }

    // ─── Sales tax collected (S517) ─────────────────────────────
    // Tax the operator collected and will owe on a return. Sourced from
    // completed POS sales + issued invoices (sent/paid), bucketed by
    // month. Amounts are post-discount (tax_amount is already net of any
    // discount on both tables). Computed whenever POS or invoicing is on.
    let salesTax: any = null
    if (features.has('pos') || features.has('invoicing')) {
      const { rows: monthly } = await db.query<{
        month: string; tax_collected: string; pos_tax: string; invoice_tax: string;
        taxable_sales: string;
      }>(
        `WITH tax_rows AS (
           SELECT date_trunc('month', created_at) AS month,
                  tax_amount AS tax, subtotal AS net, 'pos' AS source
             FROM business_pos_transactions
            WHERE business_id = $1 AND status = 'completed'
              AND created_at::date >= CURRENT_DATE - ($2::int - 1)
           UNION ALL
           SELECT date_trunc('month', issue_date::timestamptz) AS month,
                  tax_amount AS tax, (subtotal - discount_amount) AS net, 'invoice' AS source
             FROM business_invoices
            WHERE business_id = $1 AND status IN ('sent', 'paid')
              AND issue_date >= CURRENT_DATE - ($2::int - 1)
         )
         SELECT to_char(month, 'YYYY-MM') AS month,
                COALESCE(SUM(tax), 0) AS tax_collected,
                COALESCE(SUM(CASE WHEN source = 'pos'     THEN tax ELSE 0 END), 0) AS pos_tax,
                COALESCE(SUM(CASE WHEN source = 'invoice' THEN tax ELSE 0 END), 0) AS invoice_tax,
                COALESCE(SUM(net), 0) AS taxable_sales
           FROM tax_rows
          GROUP BY month
          ORDER BY month ASC`,
        [businessId, days])

      const total = monthly.reduce((a, m) => a + Number(m.tax_collected), 0)
      salesTax = {
        total_collected: Math.round(total * 100) / 100,
        monthly,
      }
    }

    // ─── A/R aging (S502) ───────────────────────────────────────
    // A point-in-time snapshot of OUTSTANDING receivables — every 'sent'
    // invoice with a remaining balance, bucketed by how far past its due
    // date it is TODAY. Unlike the other sections this ignores `range`:
    // a 120-day-overdue invoice matters no matter the chart window.
    // Computed whenever invoicing is on.
    let arAging: any = null
    if (features.has('invoicing')) {
      const { rows: open } = await db.query<{
        customer_id: string; company_name: string | null;
        first_name: string | null; last_name: string | null;
        due: string; days_overdue: number;
      }>(
        `SELECT bi.customer_id,
                c.company_name, c.first_name, c.last_name,
                (bi.total_amount - bi.amount_paid) AS due,
                (CURRENT_DATE - bi.due_date) AS days_overdue
           FROM business_invoices bi
           JOIN business_customers c ON c.id = bi.customer_id
          WHERE bi.business_id = $1 AND bi.status = 'sent'
            AND (bi.total_amount - bi.amount_paid) > 0`,
        [businessId])

      // Keys are deliberately underscore-free so the snake→camel response
      // transform leaves them untouched (numeric-underscore keys camelize
      // unpredictably).
      const emptyBuckets = () => ({ current: 0, d1to30: 0, d31to60: 0, d61to90: 0, d90plus: 0, total: 0 })
      const bucketOf = (overdue: number) =>
        overdue <= 0 ? 'current' : overdue <= 30 ? 'd1to30' : overdue <= 60 ? 'd31to60' : overdue <= 90 ? 'd61to90' : 'd90plus'

      const totals = emptyBuckets()
      const byCustomer = new Map<string, any>()
      for (const r of open) {
        const due = Number(r.due)
        const b = bucketOf(Number(r.days_overdue))
        totals[b] += due; totals.total += due
        let cust = byCustomer.get(r.customer_id)
        if (!cust) {
          cust = {
            customer_id: r.customer_id,
            name: r.company_name || `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim() || 'Customer',
            ...emptyBuckets(),
          }
          byCustomer.set(r.customer_id, cust)
        }
        cust[b] += due; cust.total += due
      }
      const round2 = (n: number) => Math.round(n * 100) / 100
      const roundBuckets = (o: any) => {
        for (const k of ['current', 'd1to30', 'd31to60', 'd61to90', 'd90plus', 'total']) o[k] = round2(o[k])
        return o
      }
      arAging = {
        totals: roundBuckets(totals),
        customers: Array.from(byCustomer.values()).map(roundBuckets).sort((a, b) => b.total - a.total),
      }
    }

    // ─── Discount usage (S503) ──────────────────────────────────
    // Where the operator's discount codes actually got used over the
    // range: dollars given away + redemption count, per code, across
    // issued invoices (sent/paid — quote-converted discounts land here
    // too) and completed POS sales. Computed whenever the Discounts
    // feature is on. A code with rows on either table appears even if
    // it's since been deactivated, so historical giveaway stays visible.
    let discounts: any = null
    if (features.has('discounts')) {
      const { rows: byCode } = await db.query<{
        discount_code_id: string; code: string | null;
        discount_type: string | null; is_active: boolean | null;
        redemptions: string; amount: string;
        invoice_amount: string; pos_amount: string;
      }>(
        `WITH used AS (
           SELECT discount_code_id, discount_amount AS amt, 'invoice' AS source
             FROM business_invoices
            WHERE business_id = $1 AND status IN ('sent', 'paid')
              AND discount_code_id IS NOT NULL AND discount_amount > 0
              AND issue_date >= CURRENT_DATE - ($2::int - 1)
           UNION ALL
           SELECT discount_code_id, discount_amount AS amt, 'pos' AS source
             FROM business_pos_transactions
            WHERE business_id = $1 AND status = 'completed'
              AND discount_code_id IS NOT NULL AND discount_amount > 0
              AND created_at::date >= CURRENT_DATE - ($2::int - 1)
         )
         SELECT u.discount_code_id,
                dc.code, dc.discount_type, dc.is_active,
                COUNT(*) AS redemptions,
                COALESCE(SUM(u.amt), 0) AS amount,
                COALESCE(SUM(CASE WHEN u.source = 'invoice' THEN u.amt ELSE 0 END), 0) AS invoice_amount,
                COALESCE(SUM(CASE WHEN u.source = 'pos'     THEN u.amt ELSE 0 END), 0) AS pos_amount
           FROM used u
           LEFT JOIN business_discount_codes dc ON dc.id = u.discount_code_id
          GROUP BY u.discount_code_id, dc.code, dc.discount_type, dc.is_active
          ORDER BY amount DESC`,
        [businessId, days])

      const round2d = (n: number) => Math.round(n * 100) / 100
      const codes = byCode.map(r => ({
        discount_code_id: r.discount_code_id,
        code: r.code ?? '(deleted code)',
        discount_type: r.discount_type,
        is_active: r.is_active ?? false,
        redemptions: Number(r.redemptions),
        amount: round2d(Number(r.amount)),
        invoice_amount: round2d(Number(r.invoice_amount)),
        pos_amount: round2d(Number(r.pos_amount)),
      }))
      discounts = {
        total_discounted: round2d(codes.reduce((a, c) => a + c.amount, 0)),
        total_redemptions: codes.reduce((a, c) => a + c.redemptions, 0),
        codes,
      }
    }

    res.json({
      success: true,
      data: {
        range,
        days,
        enabled_features: access.enabledFeatures,
        revenue,
        top_customers: topCustomers,
        pos,
        inventory,
        work_orders: workOrders,
        quotes,
        sales_tax: salesTax,
        ar_aging: arAging,
        discounts,
      },
    })
  } catch (e) { next(e) }
})

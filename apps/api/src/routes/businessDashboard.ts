/**
 * S499 — business-portal dashboard overview.
 *
 * Single aggregate endpoint:
 *   GET /api/business-dashboard/overview
 *
 * Returns a feature-aware bundle so the dashboard can render conditional
 * tiles. Sections are only computed for features enabled on the business:
 *   - revenue (always — uses POS + invoices, falls back to 0)
 *   - arAging (if 'invoicing')
 *   - todayAppointments (if 'appointments')
 *   - openWorkOrders (if 'work_orders')
 *   - lowStock (if 'inventory')
 *   - banking (always — Connect status quick-check)
 *
 * Math is done in SQL on the API side so the client renders cards
 * directly. Date math uses the API server's local TZ for "today" + "this
 * month" — same approximation the rest of the portal uses.
 */

import { Router } from 'express'
import { db, query, queryOne } from '../db'
import { requireAuth } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { requireBusinessAccess } from '../middleware/businessAccess'

export const businessDashboardRouter = Router()

interface BusinessRow {
  id: string
  enabled_features: string[]
  stripe_connect_account_id: string | null
  connect_payouts_enabled: boolean | null
  connect_details_submitted: boolean | null
}

businessDashboardRouter.get('/overview', requireAuth, async (req, res, next) => {
  try {
    const access = await requireBusinessAccess(req, { permission: 'dashboard.view' })
    // Fetch the connect columns the dashboard needs (the access helper
    // already resolved businessId + enabled_features).
    const biz = await queryOne<BusinessRow>(
      `SELECT id, enabled_features,
              stripe_connect_account_id,
              connect_payouts_enabled,
              connect_details_submitted
         FROM businesses WHERE id = $1`,
      [access.businessId])
    if (!biz) throw new AppError(404, 'Business not found')
    const features = new Set(biz.enabled_features)

    // ─── Revenue tile (always returned) ─────────────────────────
    // todayPos:  POS revenue (status='completed') for today
    // monthInvoiced: business_invoices total_amount for issue_date in current month, status in sent|paid
    // monthCollected: business_invoices amount_paid where paid_at in current month
    const { rows: [revRow] } = await db.query<{
      today_pos: string; month_invoiced: string; month_collected: string;
      today_pos_count: number;
    }>(
      `SELECT
         COALESCE((
           SELECT SUM(total_amount) FROM business_pos_transactions
            WHERE business_id = $1
              AND status = 'completed'
              AND created_at::date = CURRENT_DATE
         ), 0) AS today_pos,
         COALESCE((
           SELECT COUNT(*)::int FROM business_pos_transactions
            WHERE business_id = $1
              AND status = 'completed'
              AND created_at::date = CURRENT_DATE
         ), 0) AS today_pos_count,
         COALESCE((
           SELECT SUM(total_amount) FROM business_invoices
            WHERE business_id = $1
              AND status IN ('sent', 'paid')
              AND date_trunc('month', issue_date) = date_trunc('month', CURRENT_DATE)
         ), 0) AS month_invoiced,
         COALESCE((
           SELECT SUM(amount_paid) FROM business_invoices
            WHERE business_id = $1
              AND status = 'paid'
              AND date_trunc('month', paid_at) = date_trunc('month', CURRENT_DATE)
         ), 0) AS month_collected`,
      [biz.id])

    // ─── AR aging buckets (only if invoicing) ───────────────────
    let arAging: any = null
    if (features.has('invoicing')) {
      const { rows: [a] } = await db.query<{
        current_count: number; current_amount: string;
        d30_count:     number; d30_amount:     string;
        d60_count:     number; d60_amount:     string;
        d90_count:     number; d90_amount:     string;
        over90_count:  number; over90_amount:  string;
      }>(
        `SELECT
           SUM(CASE WHEN due_date >= CURRENT_DATE                                   THEN 1   ELSE 0 END)::int AS current_count,
           COALESCE(SUM(CASE WHEN due_date >= CURRENT_DATE                          THEN owed ELSE 0 END), 0) AS current_amount,
           SUM(CASE WHEN due_date < CURRENT_DATE AND days_overdue BETWEEN 1 AND 30  THEN 1   ELSE 0 END)::int AS d30_count,
           COALESCE(SUM(CASE WHEN due_date < CURRENT_DATE AND days_overdue BETWEEN 1 AND 30  THEN owed ELSE 0 END), 0) AS d30_amount,
           SUM(CASE WHEN days_overdue BETWEEN 31 AND 60                             THEN 1   ELSE 0 END)::int AS d60_count,
           COALESCE(SUM(CASE WHEN days_overdue BETWEEN 31 AND 60                    THEN owed ELSE 0 END), 0) AS d60_amount,
           SUM(CASE WHEN days_overdue BETWEEN 61 AND 90                             THEN 1   ELSE 0 END)::int AS d90_count,
           COALESCE(SUM(CASE WHEN days_overdue BETWEEN 61 AND 90                    THEN owed ELSE 0 END), 0) AS d90_amount,
           SUM(CASE WHEN days_overdue > 90                                          THEN 1   ELSE 0 END)::int AS over90_count,
           COALESCE(SUM(CASE WHEN days_overdue > 90                                 THEN owed ELSE 0 END), 0) AS over90_amount
         FROM (
           SELECT due_date,
                  (CURRENT_DATE - due_date)::int AS days_overdue,
                  (total_amount - amount_paid)   AS owed
             FROM business_invoices
            WHERE business_id = $1
              AND status = 'sent'
              AND total_amount > amount_paid
         ) s`, [biz.id])
      // Wire keys are camelize-safe (no underscore-before-digit) and match the
      // Reports page's A/R-aging scheme (businessReports.ts) — one convention
      // across the business portal. The old d1_30/d31_60/d61_90 keys camelized
      // lossily to d130/d3160/d6190, which is what black-screened this tile.
      arAging = {
        current: { count: a.current_count, amount: a.current_amount },
        d1to30:  { count: a.d30_count,     amount: a.d30_amount },
        d31to60: { count: a.d60_count,     amount: a.d60_amount },
        d61to90: { count: a.d90_count,     amount: a.d90_amount },
        d90plus: { count: a.over90_count,  amount: a.over90_amount },
      }
    }

    // ─── Today's appointments (only if appointments) ────────────
    let todayAppointments: any[] | null = null
    if (features.has('appointments')) {
      todayAppointments = await query<any>(
        `SELECT a.id, a.service_type, a.scheduled_for, a.status, a.duration_minutes,
                c.id AS customer_id,
                c.first_name AS customer_first_name,
                c.last_name AS customer_last_name,
                c.company_name AS customer_company_name
           FROM appointments a
           LEFT JOIN business_customers c ON c.id = a.customer_id
          WHERE a.business_id = $1
            AND a.status = 'scheduled'
            AND a.scheduled_for::date = CURRENT_DATE
          ORDER BY a.scheduled_for ASC
          LIMIT 10`, [biz.id])
    }

    // ─── Open work orders (only if work_orders) ─────────────────
    let openWorkOrders: any[] | null = null
    let openWorkOrderStats: any = null
    if (features.has('work_orders')) {
      openWorkOrders = await query<any>(
        `SELECT w.id, w.wo_number, w.status, w.complaint,
                w.labor_subtotal, w.parts_subtotal, w.total_amount,
                w.created_at,
                c.first_name AS customer_first_name,
                c.last_name  AS customer_last_name,
                c.company_name AS customer_company_name,
                v.year   AS vehicle_year,
                v.make   AS vehicle_make,
                v.model  AS vehicle_model
           FROM business_work_orders w
           JOIN business_customers c ON c.id = w.customer_id
           LEFT JOIN business_customer_vehicles v ON v.id = w.vehicle_id
          WHERE w.business_id = $1
            AND w.status IN ('open', 'in_progress', 'awaiting_parts')
          ORDER BY w.created_at DESC
          LIMIT 5`, [biz.id])
      const { rows: [s] } = await db.query<{
        open_count: number; in_progress_count: number; awaiting_parts_count: number;
      }>(
        `SELECT
           SUM(CASE WHEN status = 'open'           THEN 1 ELSE 0 END)::int AS open_count,
           SUM(CASE WHEN status = 'in_progress'    THEN 1 ELSE 0 END)::int AS in_progress_count,
           SUM(CASE WHEN status = 'awaiting_parts' THEN 1 ELSE 0 END)::int AS awaiting_parts_count
         FROM business_work_orders
         WHERE business_id = $1`, [biz.id])
      openWorkOrderStats = {
        open: s.open_count, in_progress: s.in_progress_count, awaiting_parts: s.awaiting_parts_count,
      }
    }

    // ─── Low stock (only if inventory) ──────────────────────────
    let lowStock: any[] | null = null
    let lowStockCount = 0
    if (features.has('inventory')) {
      lowStock = await query<any>(
        `SELECT id, name, sku, stock_qty, stock_min, sell_price
           FROM business_inventory_items
          WHERE business_id = $1
            AND is_active = TRUE
            AND stock_min > 0
            AND stock_qty <= stock_min
          ORDER BY (stock_min - stock_qty) DESC
          LIMIT 5`, [biz.id])
      const { rows: [lc] } = await db.query<{ c: number }>(
        `SELECT COUNT(*)::int AS c
           FROM business_inventory_items
          WHERE business_id = $1
            AND is_active = TRUE
            AND stock_min > 0
            AND stock_qty <= stock_min`, [biz.id])
      lowStockCount = lc.c
    }

    // ─── Banking status (always) ────────────────────────────────
    // businesses table only tracks payouts_enabled + details_submitted.
    // charges_enabled would require an extra Stripe Account.retrieve
    // round-trip or a schema addition — payouts_enabled is the load-
    // bearing flag for invoice pay-links anyway, so it's the one the
    // dashboard surfaces as "ready to accept money."
    const banking = {
      has_connect_account: !!biz.stripe_connect_account_id,
      payouts_enabled:     !!biz.connect_payouts_enabled,
      details_submitted:   !!biz.connect_details_submitted,
    }

    res.json({
      success: true,
      data: {
        revenue: {
          today_pos:       revRow.today_pos,
          today_pos_count: revRow.today_pos_count,
          month_invoiced:  revRow.month_invoiced,
          month_collected: revRow.month_collected,
        },
        ar_aging:           arAging,
        today_appointments: todayAppointments,
        open_work_orders:   openWorkOrders,
        open_work_order_stats: openWorkOrderStats,
        low_stock:          lowStock,
        low_stock_count:    lowStockCount,
        banking,
        // Echo features so the FE can render the right tiles.
        enabled_features: biz.enabled_features,
      },
    })
  } catch (e) { next(e) }
})

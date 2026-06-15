/**
 * S511 — global search across business-portal entities.
 *
 *   GET /api/business-search?q=foo
 *
 * Runs 5 parallel queries against customers, invoices, quotes, work
 * orders, and appointments. Returns the top 5 of each, grouped by
 * type, with enough context for the dropdown to render a clear hit.
 *
 * Permission gating: each category is included only when the caller
 * has the relevant `.read` permission for the underlying feature.
 * Owner gets full set. Staff with limited grants sees fewer
 * categories — categories the staff can't read are silently omitted
 * (returns an empty list rather than 403 the whole search).
 *
 * Search semantics: case-insensitive substring (ILIKE %q%). Could be
 * upgraded to pg_trgm or tsvector later if hot — substring is fast
 * enough at the scale a single business hits (< 100k rows per type).
 */

import { Router } from 'express'
import { z } from 'zod'
import { query } from '../db'
import { requireAuth } from '../middleware/auth'
import { requireBusinessAccess } from '../middleware/businessAccess'
import { BUSINESS_STAFF_PERMISSIONS, BusinessStaffPermission } from '@gam/shared'

export const businessSearchRouter = Router()

const querySchema = z.object({
  q: z.string().min(1).max(120),
})

const PER_TYPE_LIMIT = 5

function has(perms: BusinessStaffPermission[], required: BusinessStaffPermission, features: Set<string>, feature?: string): boolean {
  if (feature && !features.has(feature)) return false
  return (BUSINESS_STAFF_PERMISSIONS as readonly string[]).includes(required)
    && perms.includes(required)
}

businessSearchRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    // No specific permission required to access search itself — we
    // gate per-category inside the handler. requireBusinessAccess
    // with no options resolves the businessId + the caller's
    // permission set + the enabled features.
    const access = await requireBusinessAccess(req, {})
    const { q } = querySchema.parse(req.query)
    const businessId = access.businessId
    const features = new Set(access.enabledFeatures)
    const perms = access.permissions
    const like = `%${q}%`

    // Build the parallel query set. Each branch is conditional on
    // the caller's permission + feature flag.
    const promises: Array<Promise<{ type: string; rows: any[] }>> = []

    if (has(perms, 'customers.read', features)) {
      promises.push(query<any>(
        `SELECT id, first_name, last_name, company_name, email, phone, city, state
           FROM business_customers
          WHERE business_id = $1
            AND status = 'active'
            AND (
              first_name  ILIKE $2 OR
              last_name   ILIKE $2 OR
              company_name ILIKE $2 OR
              email       ILIKE $2 OR
              phone       ILIKE $2
            )
          ORDER BY created_at DESC
          LIMIT $3`, [businessId, like, PER_TYPE_LIMIT])
        .then(rows => ({ type: 'customers', rows })))
    }

    if (has(perms, 'invoices.read', features, 'invoicing')) {
      promises.push(query<any>(
        `SELECT i.id, i.invoice_number, i.status, i.total_amount, i.issue_date, i.due_date,
                c.first_name AS customer_first_name,
                c.last_name  AS customer_last_name,
                c.company_name AS customer_company_name
           FROM business_invoices i
           JOIN business_customers c ON c.id = i.customer_id
          WHERE i.business_id = $1
            AND (
              i.invoice_number ILIKE $2 OR
              c.first_name     ILIKE $2 OR
              c.last_name      ILIKE $2 OR
              c.company_name   ILIKE $2 OR
              c.email          ILIKE $2
            )
          ORDER BY i.created_at DESC
          LIMIT $3`, [businessId, like, PER_TYPE_LIMIT])
        .then(rows => ({ type: 'invoices', rows })))
    }

    if (has(perms, 'quotes.read', features, 'quotes')) {
      promises.push(query<any>(
        `SELECT q.id, q.quote_number, q.status, q.total_amount,
                c.first_name AS customer_first_name,
                c.last_name  AS customer_last_name,
                c.company_name AS customer_company_name
           FROM business_quotes q
           JOIN business_customers c ON c.id = q.customer_id
          WHERE q.business_id = $1
            AND (
              q.quote_number ILIKE $2 OR
              c.first_name   ILIKE $2 OR
              c.last_name    ILIKE $2 OR
              c.company_name ILIKE $2 OR
              c.email        ILIKE $2
            )
          ORDER BY q.created_at DESC
          LIMIT $3`, [businessId, like, PER_TYPE_LIMIT])
        .then(rows => ({ type: 'quotes', rows })))
    }

    if (has(perms, 'work_orders.read', features, 'work_orders')) {
      promises.push(query<any>(
        `SELECT w.id, w.wo_number, w.status, w.complaint, w.total_amount,
                c.first_name AS customer_first_name,
                c.last_name  AS customer_last_name,
                c.company_name AS customer_company_name,
                v.year AS vehicle_year, v.make AS vehicle_make,
                v.model AS vehicle_model, v.license_plate AS vehicle_license_plate
           FROM business_work_orders w
           JOIN business_customers c ON c.id = w.customer_id
           LEFT JOIN business_customer_vehicles v ON v.id = w.vehicle_id
          WHERE w.business_id = $1
            AND (
              w.wo_number  ILIKE $2 OR
              w.complaint  ILIKE $2 OR
              c.first_name ILIKE $2 OR
              c.last_name  ILIKE $2 OR
              c.company_name ILIKE $2 OR
              v.license_plate ILIKE $2 OR
              v.vin           ILIKE $2
            )
          ORDER BY w.created_at DESC
          LIMIT $3`, [businessId, like, PER_TYPE_LIMIT])
        .then(rows => ({ type: 'work_orders', rows })))
    }

    if (has(perms, 'appointments.read', features, 'appointments')) {
      promises.push(query<any>(
        `SELECT a.id, a.service_type, a.scheduled_for, a.duration_minutes, a.status,
                c.first_name AS customer_first_name,
                c.last_name  AS customer_last_name,
                c.company_name AS customer_company_name
           FROM appointments a
           JOIN business_customers c ON c.id = a.customer_id
          WHERE a.business_id = $1
            AND (
              a.service_type ILIKE $2 OR
              c.first_name   ILIKE $2 OR
              c.last_name    ILIKE $2 OR
              c.company_name ILIKE $2 OR
              c.email        ILIKE $2
            )
          ORDER BY a.scheduled_for DESC
          LIMIT $3`, [businessId, like, PER_TYPE_LIMIT])
        .then(rows => ({ type: 'appointments', rows })))
    }

    const results = await Promise.all(promises)
    const grouped: Record<string, any[]> = {}
    let total = 0
    for (const { type, rows } of results) {
      grouped[type] = rows
      total += rows.length
    }

    res.json({
      success: true,
      data: {
        query: q,
        total,
        results: grouped,
      },
    })
  } catch (e) { next(e) }
})

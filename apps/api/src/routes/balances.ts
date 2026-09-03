import { Router } from 'express'
import { query } from '../db'
import { landlordScopeIds } from '../lib/landlordScope'
import { requireAuth, requirePerm, getScopedPropertyIds } from '../middleware/auth'

// Front-desk "who owes" surface. A read-only list of tenants with an unpaid
// balance + their contact info, so a front-counter person knows who to call.
// Outstanding = unpaid invoice balance (invoice total − settled payments),
// matching the platform definition in reports.ts (pending|partial invoices).
export const balancesRouter = Router()
balancesRouter.use(requireAuth)

// GET /api/balances — grouped per tenant + unit. Owners bypass requirePerm;
// staff need the balances.view grant (part of the Front Desk preset).
// Property-scoped: a worker with a property-locked scope row only sees
// balances at their assigned properties (invoices with no unit have no
// property, so scoped workers don't see them either).
balancesRouter.get('/', requirePerm('balances.view'), async (req, res, next) => {
  try {
    // S633: every company the account owns. A balances view scoped to one
    // entity showed half the money owed and looked like the rest was paid.
    const landlordIds = landlordScopeIds(req.user!)
    const scopedIds = await getScopedPropertyIds(req.user)
    const rows = await query<any>(`
      SELECT
        t.id                                        AS tenant_id,
        tu.first_name, tu.last_name, tu.phone, tu.email,
        u.unit_number,
        pr.id                                       AS property_id,
        pr.name                                     AS property_name,
        -- S637 (Nic, DIRECTIVE): "It's a credit against the overall ledger."
        -- Owed is charges MINUS what the landlord owes back. Credits used to
        -- reach this number by faking a settled payment (the split), so the paid
        -- column picked them up; now they are netted honestly and nothing pretends a
        -- payment happened. GREATEST(...,0) because a credit larger than the
        -- open balance leaves the tenant owing nothing, never a negative.
        GREATEST(
          SUM(i.total_amount - COALESCE(pd.paid, 0)) - COALESCE(MAX(cr.credit), 0),
          0)::numeric                               AS balance,
        COALESCE(MAX(cr.credit), 0)::numeric        AS credit_on_account,
        COUNT(*)::int                               AS open_invoices,
        MIN(i.due_date)                             AS oldest_due_date
      FROM invoices i
      JOIN tenants t          ON t.id  = i.tenant_id
      LEFT JOIN users tu      ON tu.id = t.user_id
      LEFT JOIN units u       ON u.id  = i.unit_id
      LEFT JOIN properties pr ON pr.id = u.property_id
      LEFT JOIN (
        SELECT invoice_id, SUM(amount) AS paid
          FROM payments
         WHERE status = 'settled' AND invoice_id IS NOT NULL
         GROUP BY invoice_id
      ) pd ON pd.invoice_id = i.id
      -- Credit balance is per TENANT, while this groups many invoices per
      -- tenant — so it joins on tenant and is read with MAX (one value repeated
      -- across the group), never SUM, which would subtract it once per invoice.
      LEFT JOIN (
        SELECT tenant_id, SUM(amount_remaining) AS credit
          FROM tenant_credits
         WHERE status = 'active' AND amount_remaining > 0
         GROUP BY tenant_id
      ) cr ON cr.tenant_id = t.id
      WHERE i.landlord_id = ANY($1::uuid[])
        AND i.status IN ('pending', 'partial')
        AND ($2::uuid[] IS NULL OR u.property_id = ANY($2::uuid[]))
      GROUP BY t.id, tu.first_name, tu.last_name, tu.phone, tu.email,
               u.unit_number, pr.id, pr.name
      HAVING SUM(i.total_amount - COALESCE(pd.paid, 0)) - COALESCE(MAX(cr.credit), 0) > 0
      ORDER BY balance DESC
    `, [landlordIds, scopedIds])
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

/**
 * GET /api/balances/:tenantId/invoices — S634 (Nic, DIRECTIVE).
 *
 * "From the landlord page, these outstanding balances need to be clickable so I
 * can get into the invoice and actually view it. There's no way for me to see
 * what the breakdown of charges is, and as a landlord, you need to be able to
 * explain that to a tenant."
 *
 * The balances list gave a NUMBER and nothing behind it. A landlord asked
 * "what's this $217?" by a resident standing at the counter had no way to answer
 * from the product — which makes the number useless at exactly the moment it
 * matters. This returns every open invoice for the tenant with its lines, so the
 * charge can be read out loud.
 *
 * Same scope and the same property lock as the list itself: an account's own
 * companies, and a property-scoped worker sees only their assignments.
 */
balancesRouter.get('/:tenantId/invoices', requirePerm('balances.view'), async (req, res, next) => {
  try {
    const landlordIds = landlordScopeIds(req.user!)
    const scopedIds = await getScopedPropertyIds(req.user)
    const invoices = await query<any>(`
      SELECT i.id, i.invoice_number, i.due_date, i.status,
             i.subtotal_rent, i.subtotal_fees, i.subtotal_utilities,
             i.subtotal_deposits, i.subtotal_late_fees,
             i.work_trade_credit_amount, i.total_amount,
             COALESCE(pd.paid, 0)                         AS amount_paid,
             (i.total_amount - COALESCE(pd.paid, 0))      AS balance,
             u.unit_number, pr.name AS property_name
        FROM invoices i
        LEFT JOIN units u       ON u.id  = i.unit_id
        LEFT JOIN properties pr ON pr.id = u.property_id
        LEFT JOIN (
          SELECT invoice_id, SUM(amount) AS paid
            FROM payments
           WHERE status = 'settled' AND invoice_id IS NOT NULL
           GROUP BY invoice_id
        ) pd ON pd.invoice_id = i.id
       WHERE i.tenant_id = $1
         AND i.landlord_id = ANY($2::uuid[])
         AND i.status IN ('pending', 'partial')
         AND ($3::uuid[] IS NULL OR u.property_id = ANY($3::uuid[]))
       ORDER BY i.due_date ASC`,
      [req.params.tenantId, landlordIds, scopedIds])
    if (invoices.length === 0) return res.json({ success: true, data: [] })

    // The LINES are the point. `notes` is where the utility reads, the flat-rate
    // multiplier and the cycle a straggler belongs to are written — that is the
    // sentence a landlord repeats to the tenant.
    const lines = await query<any>(`
      SELECT p.invoice_id, p.id, p.type, p.entry_description, p.amount,
             p.status, p.due_date, p.notes
        FROM payments p
       WHERE p.invoice_id = ANY($1::uuid[])
       ORDER BY p.due_date ASC, p.type ASC, p.created_at ASC`,
      [invoices.map((i: any) => i.id)])
    const byInvoice = new Map<string, any[]>()
    for (const l of lines) {
      if (!byInvoice.has(l.invoice_id)) byInvoice.set(l.invoice_id, [])
      byInvoice.get(l.invoice_id)!.push(l)
    }
    res.json({ success: true, data: invoices.map((i: any) => ({ ...i, lines: byInvoice.get(i.id) ?? [] })) })
  } catch (e) { next(e) }
})

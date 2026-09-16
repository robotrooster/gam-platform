import { Router } from 'express'
import { allocateCredits } from '@gam/shared'
import { query } from '../db'
import { landlordScopeIds } from '../lib/landlordScope'
import { requireAuth, requirePerm, getScopedPropertyIds, userHasPerm } from '../middleware/auth'

// Front-desk "who owes" surface. A read-only list of tenants with an unpaid
// balance + their contact info, so a front-counter person knows who to call.
// Outstanding = unpaid invoice balance (invoice total − settled payments),
// matching the platform definition in reports.ts (pending|partial invoices).
export const balancesRouter = Router()
balancesRouter.use(requireAuth)

// GET /api/balances — one line per tenant (S648), each space broken out. Owners bypass requirePerm;
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
    // ── S648 (Nic): ONE LINE PER PERSON, AND EVERY DOLLAR COUNTED ONCE ──────
    //
    // Billy Jose Miranda rents RV 34 and RV 35 and showed as two people owing
    // $457.07 and $470.22. Grouping by tenant AND unit also subtracted his
    // account credit once per space — a $100 credit took $200 off. "Every
    // dollar should only be counted once. Everywhere."
    //
    // So: what is open is summed per space here, the credit is read once per
    // tenant below, and allocateCredits spends it once, oldest bill first.
    const spaces = await query<any>(`
      SELECT
        t.id                                        AS tenant_id,
        tu.first_name, tu.last_name, tu.phone, tu.email,
        i.lease_id,
        u.unit_number,
        pr.id                                       AS property_id,
        pr.name                                     AS property_name,
        SUM(i.total_amount - COALESCE(pd.paid, 0))::float AS open_amount,
        COUNT(*)::int                               AS open_invoices,
        to_char(MIN(i.due_date), 'YYYY-MM-DD')      AS oldest_due_date
      FROM invoices i
      JOIN tenants t          ON t.id  = i.tenant_id
      LEFT JOIN users tu      ON tu.id = t.user_id
      LEFT JOIN units u       ON u.id  = i.unit_id
      LEFT JOIN properties pr ON pr.id = u.property_id
      LEFT JOIN (
        SELECT invoice_id, SUM(amount) AS paid
          FROM payments
         -- S637 (Nic): money in flight is not outstanding — an ACH debit sits
         -- 'processing' ~4 business days; a failure flips it back to owed.
         -- S638 (Nic): work trade is not an outstanding balance — suspended
         -- rows are netted; a month-close deficit bills unsuspended.
         WHERE (status IN ('settled', 'processing') OR work_trade_suspended_at IS NOT NULL)
           AND invoice_id IS NOT NULL
         GROUP BY invoice_id
      ) pd ON pd.invoice_id = i.id
      WHERE i.landlord_id = ANY($1::uuid[])
        AND i.status IN ('pending', 'partial')
        AND ($2::uuid[] IS NULL OR u.property_id = ANY($2::uuid[]))
      GROUP BY t.id, tu.first_name, tu.last_name, tu.phone, tu.email,
               i.lease_id, u.unit_number, pr.id, pr.name
      HAVING SUM(i.total_amount - COALESCE(pd.paid, 0)) > 0
    `, [landlordIds, scopedIds])

    const tenantIds = [...new Set(spaces.map(r => r.tenant_id))]
    // S637 (Nic): "It's a credit against the overall ledger." Read at its own
    // grain — per tenant, per lease tie — and never joined into the rows above.
    const credits = tenantIds.length ? await query<any>(`
      SELECT tenant_id, lease_id, SUM(amount_remaining)::float AS amount
        FROM tenant_credits
       WHERE tenant_id = ANY($1::uuid[]) AND landlord_id = ANY($2::uuid[])
         AND status = 'active' AND amount_remaining > 0
       GROUP BY tenant_id, lease_id`, [tenantIds, landlordIds]) : []

    const out: any[] = []
    for (const tenantId of tenantIds) {
      const mine = spaces.filter(r => r.tenant_id === tenantId)
        .sort((a, b) => String(a.oldest_due_date).localeCompare(String(b.oldest_due_date)))
      const keyOf = (r: any, i: number) => r.lease_id || `space:${i}`
      const alloc = allocateCredits(
        credits.filter(c => c.tenant_id === tenantId).map(c => ({ leaseId: c.lease_id, amount: c.amount })),
        mine.map((r, i) => ({ key: keyOf(r, i), leaseId: r.lease_id, total: r.open_amount, earliestDue: r.oldest_due_date })))
      const breakdown = mine.map((r, i) => {
        const credit = alloc.applied[keyOf(r, i)] ?? 0
        return {
          lease_id: r.lease_id,
          unit_number: r.unit_number,
          property_id: r.property_id,
          property_name: r.property_name,
          open_amount: Math.round(r.open_amount * 100) / 100,
          credit_applied: credit,
          balance: Math.round((r.open_amount - credit) * 100) / 100,
          open_invoices: r.open_invoices,
          oldest_due_date: r.oldest_due_date,
        }
      })
      const balance = Math.round(breakdown.reduce((s, x) => s + x.balance, 0) * 100) / 100
      if (balance <= 0) continue
      const first = mine[0]
      const uniq = (xs: any[]) => [...new Set(xs.filter(Boolean))]
      out.push({
        tenant_id: tenantId,
        first_name: first.first_name, last_name: first.last_name,
        phone: first.phone, email: first.email,
        // Joined for the screens that print one line ("RV 34, RV 35").
        unit_number: uniq(mine.map(r => r.unit_number)).join(', ') || null,
        property_id: first.property_id,
        property_ids: uniq(mine.map(r => r.property_id)),
        property_name: uniq(mine.map(r => r.property_name)).join(', ') || null,
        balance: balance.toFixed(2),
        credit_on_account: Math.round(
          breakdown.reduce((s, x) => s + x.credit_applied, 0) * 100 + alloc.remaining * 100) / 100,
        open_invoices: mine.reduce((s, r) => s + r.open_invoices, 0),
        oldest_due_date: first.oldest_due_date,
        spaces: breakdown,
      })
    }
    out.sort((a, b) => Number(b.balance) - Number(a.balance))
    res.json({ success: true, data: out })
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
             -- S641 (Nic): "when somebody goes on their history from last year
             -- that it shows that they were in that spot at that time." An
             -- invoice renders the number the space carried on its own due
             -- date, not whatever it was renamed to since.
             unit_number_on(i.unit_id, i.due_date) AS unit_number_then,
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
           -- S637 (Nic): MONEY IN FLIGHT IS NOT OUTSTANDING.
         --
         --   "I thought we decided it was gonna be marked settled or paid in
         --    the system, or at least not outstanding, at the time the attempt
         --    is made to pay. And if it ever fails, it shows as outstanding and
         --    reupdated with any late fees to that point in time."
         --
         -- An ACH debit sits 'processing' for about four business days. Counting
         -- it as owed for those four days put Randall Cox's $520.20 on the
         -- outstanding list the whole time he was waiting, so the list could not
         -- be worked down to zero and a paid resident looked delinquent.
         --
         -- Safe to net out here because a failure is not silent: the row flips
         -- to 'failed', the balance reappears, and jobs/lateFees.ts already
         -- suppresses late fees only while a payment is genuinely in flight —
         -- so fees resume from the real due date if the debit bounces.
         -- ── S638 (Nic, DIRECTIVE): WORK TRADE IS NOT AN OUTSTANDING BALANCE ──
         --
         --   "The ones that are on work trade need to not show in the
         --    outstanding balances list. That's a false number... while it's in
         --    a suspended state, don't have it show on this table. Don't have it
         --    be part of these calculations."
         --
         -- The invoice total DOES include suspended rows — RV 45 reads $776.11,
         -- all of it suspended and none of it owed — so they have to be netted
         -- here or the landlord is shown money nobody owes. (An earlier note
         -- here claimed the totals already excluded them; that was read off an
         -- older invoice and was wrong.)
         --
         -- A work-trade DEFICIT is different and still belongs on this list: at
         -- month close, hours that were not worked bill in cash as an ordinary
         -- charge with no suspension on it, so it lands here the moment it
         -- becomes real money.
         WHERE (status IN ('settled', 'processing') OR work_trade_suspended_at IS NOT NULL)
           AND invoice_id IS NOT NULL
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
    // S641 (Nic): "I don't want her to see the covered by work trade." A
    // work-trade arrangement is between the landlord and that resident; the
    // front desk needs the amount owed, not the private terms behind it.
    // Stripped from the RESPONSE rather than hidden on the screen — a figure
    // that never leaves the server cannot be read out of a network tab.
    //
    // The netting itself is unaffected: what is owed is already net of the
    // credit, so the desk still sees the right number to collect.
    const seesWorkTrade = userHasPerm(req.user, 'payments.view_all', 'books.view')
    res.json({ success: true, data: invoices.map((i: any) => {
      const row: any = { ...i, lines: byInvoice.get(i.id) ?? [] }
      if (!seesWorkTrade) {
        delete row.work_trade_credit_amount
        delete row.work_trade_credit_hours
      }
      return row
    }) })
  } catch (e) { next(e) }
})

import { Router } from 'express'
import { query } from '../db'
import { listOpenTenantBalances } from '../services/openBalances'
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
    // S654: one line per person, every dollar counted once (S648) — the same
    // math the 7am overdue digest reads (services/openBalances).
    const out: any[] = await listOpenTenantBalances({ landlordIds, propertyIds: scopedIds })
    // S649 (Nic): "make sure POS pay links and outstanding tickets show in
    // outstanding. That way we can follow through on collecting." An emailed
    // pay link is money owed by someone who may have no lease at all (Andres
    // Razo's move-out bill). It is its own line — never folded into a rent
    // ledger — and leaves the list the moment it's paid or closed. Standing QR
    // links (the dump-station sign) are owed by no one in particular: excluded.
    const links = await query<any>(`
      SELECT l.id, l.label, l.items, l.total::float AS total, l.customer_name, l.customer_email,
             l.customer_phone, l.property_id, p.name AS property_name,
             to_char(l.created_at, 'YYYY-MM-DD') AS sent_on
        FROM pos_pay_links l
        JOIN properties p ON p.id = l.property_id
       WHERE l.landlord_id = ANY($1::uuid[])
         AND l.kind = 'one_time' AND l.status = 'open'
         AND (l.expires_at IS NULL OR l.expires_at > NOW())
         AND ($2::uuid[] IS NULL OR l.property_id = ANY($2::uuid[]))`, [landlordIds, scopedIds])
    for (const l of links) {
      const [first, ...rest] = String(l.customer_name || '').trim().split(/\s+/)
      out.push({
        tenant_id: null,
        pay_link_id: l.id,
        first_name: first || l.customer_email, last_name: rest.join(' ') || null,
        phone: l.customer_phone, email: l.customer_email,
        unit_number: null,
        property_id: l.property_id, property_ids: [l.property_id], property_name: l.property_name,
        balance: Number(l.total).toFixed(2),
        credit_on_account: 0,
        open_invoices: 1,
        oldest_due_date: l.sent_on,
        pay_link: { label: l.label, items: l.items },
      })
    }
    // S652 (Nic): "Open tickets should reflect as items to do in the front desk
    // list as well, so they don't get forgotten." A register ticket written up
    // and not yet settled — a delivery, or somebody who left before their last
    // electric was rung — is money out, and it belongs on the same list.
    const tickets = await query<any>(`
      SELECT t.id, t.items, t.note, t.property_id, p.name AS property_name,
             to_char(t.created_at, 'YYYY-MM-DD') AS written_on,
             t.tenant_id, t.pos_customer_id,
             COALESCE(tu.first_name, c.first_name) AS first_name,
             COALESCE(tu.last_name,  c.last_name)  AS last_name,
             COALESCE(tu.email, c.email) AS email,
             COALESCE(tu.phone, c.phone) AS phone,
             (SELECT SUM((i->>'qty')::numeric * (i->>'price')::numeric * (1 + COALESCE((i->>'tax')::numeric, 0)))
                FROM jsonb_array_elements(t.items) i)::float AS total
        FROM pos_open_tickets t
        JOIN properties p ON p.id = t.property_id
        LEFT JOIN tenants tn ON tn.id = t.tenant_id
        LEFT JOIN users tu ON tu.id = tn.user_id
        LEFT JOIN pos_customers c ON c.id = t.pos_customer_id
       WHERE t.landlord_id = ANY($1::uuid[]) AND t.status = 'open'
         AND ($2::uuid[] IS NULL OR t.property_id = ANY($2::uuid[]))`, [landlordIds, scopedIds])
    for (const t of tickets) {
      if (!(Number(t.total) > 0)) continue
      out.push({
        tenant_id: t.tenant_id ?? null,
        ticket_id: t.id,
        first_name: t.first_name || 'Register', last_name: t.last_name || 'ticket',
        phone: t.phone ?? null, email: t.email ?? null,
        unit_number: null,
        property_id: t.property_id, property_ids: [t.property_id], property_name: t.property_name,
        balance: Number(t.total).toFixed(2),
        credit_on_account: 0,
        open_invoices: 1,
        oldest_due_date: t.written_on,
        ticket: { note: t.note, items: t.items },
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
         -- S654: the invoice total EXCLUDES suspended rows — every writer
         -- (move-in bill, monthly run, month close) keeps the S634 shape, and
         -- the four pre-S634 invoices that still carried gross totals were
         -- rebuilt. Netting them here as well produced negative balances.
         --
         -- A work-trade DEFICIT is different and still belongs on this list: at
         -- month close, hours that were not worked bill in cash as an ordinary
         -- charge with no suspension on it, so it lands here the moment it
         -- becomes real money.
         WHERE status IN ('settled', 'processing')
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

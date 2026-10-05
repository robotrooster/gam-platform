import { Router } from 'express'
import { query } from '../db'
import {
  listOpenTenantBalances, openBalanceSql, openAmountSql, outstandingTotals, seesGrandTotals,
  OUTSTANDING_ROW_STATUS_LABEL,
} from '../services/openBalances'
import { listPaymentsByMonth, isLedgerMonth } from '../services/paymentsByMonth'
import { AppError } from '../middleware/errorHandler'
import { chargeLabelColumnsSql, chargeLabel, chargeDetail } from '../services/invoiceNotice'
import { tenantLivesHereSql } from '../services/posPeople'
import { landlordScopeIds } from '../lib/landlordScope'
import { requireAuth, requirePerm, getScopedPropertyIds, userHasPerm } from '../middleware/auth'

// Front-desk "who owes" surface. A read-only list of tenants with an unpaid
// balance + their contact info, so a front-counter person knows who to call.
// S655 (money plan, Step 11): Outstanding = every open charge, row by row
// (services/openBalances.openBalanceSql — the one definition the portal, the
// digest and the agents read too), so a late fee or a charge with no invoice is
// owed here exactly as it is in the tenant's portal. The FULL balance, with the
// credit that could pay it shown beside it — never taken off it.
export const balancesRouter = Router()
balancesRouter.use(requireAuth)

// GET /api/balances — one line per tenant (S648), each space broken out. Owners bypass requirePerm;
// staff need the balances.view grant (part of the Front Desk preset).
// Property-scoped: a worker with a property-locked scope row only sees
// balances at their assigned properties (charges with no unit have no
// property, so scoped workers don't see them either).
balancesRouter.get('/', requirePerm('balances.view'), async (req, res, next) => {
  try {
    // S633: every company the account owns. A balances view scoped to one
    // entity showed half the money owed and looked like the rest was paid.
    const landlordIds = landlordScopeIds(req.user!)
    const scopedIds = await getScopedPropertyIds(req.user)
    // S641 (Nic): "I don't want her to see the covered by work trade." Work
    // trade is a private arrangement between the landlord and that resident:
    // the "Work trade" mark (decisions #29 — never an amount, never late) goes
    // only to a viewer who may see work trade, decided here, server-side.
    const seesWorkTrade = userHasPerm(req.user, 'payments.view_all', 'books.view')
    // S654: one line per person, every dollar counted once (S648) — the same
    // math the 7am overdue digest reads (services/openBalances).
    // decisions #29: every unpaid month on the row ("$X from August"), how late
    // it is (honoring the grace period), a payment still clearing ("Payment
    // clearing": already paid, not owed, not late), and the charge Record
    // payment opens on. A household whose ONLY money is a payment clearing is
    // on the Outstanding page (?include=clearing) — never on the front desk's
    // to-do list, which reads this same endpoint without it.
    const listClearingOnly = req.query.include === 'clearing'
    // Everyone, clearing-only households included: the grand totals below are
    // the same figures whichever list the screen asked for.
    const residents = await listOpenTenantBalances({
      landlordIds, propertyIds: scopedIds, includeClearing: true, includeWorkTrade: seesWorkTrade,
    })
    const out: any[] = residents.filter(r => listClearingOnly || r.status === 'owes')
    const everyone: any[] = [...residents]
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
    // A pay link or a register ticket is one amount owed since the day it was
    // written: its month, no grace period, no Record payment (it is paid at the
    // register or through its own link).
    const oneOff = (balance: number, writtenOn: string) => ({
      balance: balance.toFixed(2),
      credit_available: 0,
      credit_on_account: 0,
      open_invoices: 1,
      open_charges: 1,
      oldest_due_date: writtenOn,
      months: [{ month: String(writtenOn).slice(0, 7), amount: Math.round(balance * 100) / 100 }],
      days_late: 0,
      clearing: 0,
      work_trade: false,
      status: 'owes' as const,
      status_label: OUTSTANDING_ROW_STATUS_LABEL.owes,
      record_with: [],
    })
    for (const l of links) {
      const [first, ...rest] = String(l.customer_name || '').trim().split(/\s+/)
      const row = {
        tenant_id: null,
        pay_link_id: l.id,
        first_name: first || l.customer_email, last_name: rest.join(' ') || null,
        phone: l.customer_phone, email: l.customer_email,
        unit_number: null,
        property_id: l.property_id, property_ids: [l.property_id], property_name: l.property_name,
        ...oneOff(Number(l.total), l.sent_on),
        pay_link: { label: l.label, items: l.items },
      }
      out.push(row)
      everyone.push(row)
    }
    // S652 (Nic): "Open tickets should reflect as items to do in the front desk
    // list as well, so they don't get forgotten." A register ticket written up
    // and not yet settled — a delivery, or somebody who left before their last
    // electric was rung — is money out, and it belongs on the same list.
    //
    // decisions #10 (audience isolation): the email and phone shown are the
    // person's live account contact only while they LIVE here
    // (posPeople.tenantLivesHereSql). A former resident's ticket shows what this
    // company's own register record holds for them, never the account's
    // current address — that is wherever they live now, not this company's to
    // read (posPeople.recordContactSql applies the same rule at the register).
    const tickets = await query<any>(`
      SELECT t.id, t.items, t.note, t.property_id, p.name AS property_name,
             to_char(t.created_at, 'YYYY-MM-DD') AS written_on,
             t.tenant_id, t.pos_customer_id,
             COALESCE(tu.first_name, c.first_name, rc.first_name) AS first_name,
             COALESCE(tu.last_name,  c.last_name,  rc.last_name)  AS last_name,
             COALESCE(CASE WHEN tn.id IS NOT NULL AND ${tenantLivesHereSql('tn.id', 't.landlord_id')} THEN tu.email END,
                      c.email, rc.email) AS email,
             COALESCE(CASE WHEN tn.id IS NOT NULL AND ${tenantLivesHereSql('tn.id', 't.landlord_id')} THEN tu.phone END,
                      c.phone, rc.phone) AS phone,
             (SELECT SUM((i->>'qty')::numeric * (i->>'price')::numeric * (1 + COALESCE((i->>'tax')::numeric, 0)))
                FROM jsonb_array_elements(t.items) i)::float AS total
        FROM pos_open_tickets t
        JOIN properties p ON p.id = t.property_id
        LEFT JOIN pos_customers c ON c.id = t.pos_customer_id
        -- A ticket that names the resident: this company's own register record for them.
        LEFT JOIN LATERAL (
          SELECT r.first_name, r.last_name, r.email, r.phone
            FROM pos_customers r
           WHERE t.tenant_id IS NOT NULL AND r.tenant_id = t.tenant_id
             AND r.landlord_id = t.landlord_id AND r.archived_at IS NULL
           ORDER BY r.created_at, r.id
           LIMIT 1) rc ON TRUE
        LEFT JOIN tenants tn ON tn.id = COALESCE(t.tenant_id, c.tenant_id)
        LEFT JOIN users tu ON tu.id = tn.user_id
       WHERE t.landlord_id = ANY($1::uuid[]) AND t.status = 'open'
         AND ($2::uuid[] IS NULL OR t.property_id = ANY($2::uuid[]))`, [landlordIds, scopedIds])
    for (const t of tickets) {
      if (!(Number(t.total) > 0)) continue
      const row = {
        tenant_id: t.tenant_id ?? null,
        ticket_id: t.id,
        first_name: t.first_name || 'Register', last_name: t.last_name || 'ticket',
        phone: t.phone ?? null, email: t.email ?? null,
        unit_number: null,
        property_id: t.property_id, property_ids: [t.property_id], property_name: t.property_name,
        ...oneOff(Number(t.total), t.written_on),
        ticket: { note: t.note, items: t.items },
      }
      out.push(row)
      everyone.push(row)
    }
    out.sort((a, b) => Number(b.balance) - Number(a.balance))
    // decisions #25 (Nic, 10/3): "front desk / on-site staff never see a GRAND
    // TOTAL of what everyone owes. Only account owners and property managers
    // see grand totals (omitted server-side for everyone else, not just
    // hidden)." The sums ride in `meta` for them and are simply not in the
    // reply for anyone else; the per-person rows are the same for both. Summed
    // over everyone (a household whose only money is clearing counts in
    // "clearing" whether or not this list shows it), each person once.
    const body: Record<string, unknown> = { success: true, data: out }
    if (seesGrandTotals(req.user)) body.meta = { totals: outstandingTotals(everyone) }
    res.json(body)
  } catch (e) { next(e) }
})

/**
 * GET /api/balances/payments-by-month?month=YYYY-MM — the Payments ledger
 * (decisions #29, #26, #35.1 and #36.A, Nic 10/3): payments that have already
 * happened, one section per month, newest first. A payment is filed under the
 * month of the BILL it paid (its due month) and shows the day it was paid; one
 * that paid several months' bills shows under each with the part that went to
 * it; a bill paid from paid-ahead credit shows "Paid from credit" on the day
 * the credit paid it, and money paid ahead is not a line of its own. One line
 * per payment (who, space, date, owed, paid, method, what it paid for, on time
 * or N days late) with its charges nested for "Show line items"; a bank payment
 * still clearing is listed and marked "clearing", a returned one "returned",
 * with the money a dispute or bank return took back (`returned`, on the payment
 * and on each charge: a dispute of the water line takes back the water only); a
 * work-trade household gets one "Work trade — covered" line for the month
 * (never an amount). The current month carries "N households still owe" (a
 * count). services/paymentsByMonth.
 *
 * WHO (S641, kept by #29): settled history is for owners, property managers
 * and staff with "View all payments" (payments.view_all). Staff with only
 * "View payments" never see it — they get Outstanding Balances and Record
 * payment — so this answers 403 for them, server-side. Property-locked staff
 * see only their properties. The month total goes only to owners and property
 * managers (decisions #25); for anyone else it is not in the reply at all.
 */
balancesRouter.get('/payments-by-month', requirePerm('payments.view_all'), async (req, res, next) => {
  try {
    const raw = req.query.month
    if (raw !== undefined && !isLedgerMonth(raw)) {
      throw new AppError(400, 'Pick a month as YYYY-MM, for example 2026-10.')
    }
    const landlordIds = landlordScopeIds(req.user!)
    const scopedIds = await getScopedPropertyIds(req.user)
    const data = await listPaymentsByMonth({
      landlordIds,
      propertyIds: scopedIds,
      month: (raw as string | undefined) ?? null,
      withTotals: seesGrandTotals(req.user),
    })
    res.json({ success: true, data })
  } catch (e) { next(e) }
})

/** The group a charge on no invoice is shown under (a counter charge, a carried balance). */
export const NOT_ON_A_BILL = 'Not on a bill'

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
 * matters. This returns every open bill for the tenant with its lines, so the
 * charge can be read out loud.
 *
 * S655: it explains the SAME number the list shows. A bill is here when one of
 * its charges is still owed (openBalanceSql), and its balance is what those
 * charges still owe — late fees included, which the invoice's own total never
 * carried. Charges on no invoice are one more group, "Not on a bill". Each line
 * carries `label` (what it is: "Water", "Electric", "Late fee" — never a
 * generic "Utilities") and `detail` (the meter read or the period, never a
 * payment tag like "Recorded as manual cash payment").
 *
 * Same scope and the same property lock as the list itself: an account's own
 * companies' charges, and a property-scoped worker sees only their assignments.
 */
balancesRouter.get('/:tenantId/invoices', requirePerm('balances.view'), async (req, res, next) => {
  try {
    const landlordIds = landlordScopeIds(req.user!)
    const scopedIds = await getScopedPropertyIds(req.user)
    // S641 (Nic): "I don't want her to see the covered by work trade." A
    // work-trade arrangement is between the landlord and that resident; the
    // front desk needs the amount owed, not the private terms behind it.
    // Stripped from the RESPONSE rather than hidden on the screen — a figure
    // (or a line saying "Work trade — suspended") that never leaves the server
    // cannot be read out of a network tab. What is owed never included those
    // lines anyway (openBalanceSql), so the desk still sees the right number.
    const seesWorkTrade = userHasPerm(req.user, 'payments.view_all', 'books.view')

    // Every charge of this person's with these companies, on a bill that still
    // has something owed (or owed itself with no bill).
    const lines = await query<any>(`
      WITH mine AS (
        SELECT p.*, inv.tenant_id AS inv_tenant_id
          FROM payments p
          LEFT JOIN invoices inv ON inv.id = p.invoice_id
          LEFT JOIN units u ON u.id = p.unit_id
         WHERE COALESCE(p.tenant_id, inv.tenant_id) = $1
           AND p.landlord_id = ANY($2::uuid[])
           AND ($3::uuid[] IS NULL OR u.property_id = ANY($3::uuid[]))
           -- GAM's FlexPay pull is the tenant's arrangement with GAM: it never
           -- appears anywhere a landlord or their staff can see (CLAUDE.md).
           AND p.entry_description IS DISTINCT FROM 'FLEXPAY'
      ),
      open_bills AS (
        SELECT DISTINCT m.invoice_id FROM mine m
         WHERE m.invoice_id IS NOT NULL AND ${openBalanceSql('m')} AND ${openAmountSql('m')} > 0
      )
      SELECT m.invoice_id, m.id, m.type, m.entry_description, m.amount, m.status,
             to_char(m.due_date, 'YYYY-MM-DD') AS due_date, m.notes,
             (m.work_trade_suspended_at IS NOT NULL) AS work_trade,
             ${openBalanceSql('m')} AS open,
             CASE WHEN ${openBalanceSql('m')} THEN ${openAmountSql('m')} ELSE 0 END AS open_amount,
             ${chargeLabelColumnsSql('m')}
        FROM mine m
       WHERE m.invoice_id IN (SELECT invoice_id FROM open_bills)
          OR (m.invoice_id IS NULL AND ${openBalanceSql('m')} AND ${openAmountSql('m')} > 0)
       ORDER BY m.due_date ASC, m.type ASC, m.created_at ASC`,
      [req.params.tenantId, landlordIds, scopedIds])
    if (lines.length === 0) return res.json({ success: true, data: [] })

    const invoiceIds = [...new Set(lines.map((l: any) => l.invoice_id).filter(Boolean))]
    const invoices = invoiceIds.length === 0 ? [] : await query<any>(`
      SELECT i.id, i.invoice_number, to_char(i.due_date, 'YYYY-MM-DD') AS due_date, i.status,
             -- S641 (Nic): "when somebody goes on their history from last year
             -- that it shows that they were in that spot at that time." An
             -- invoice renders the number the space carried on its own due
             -- date, not whatever it was renamed to since.
             unit_number_on(i.unit_id, i.due_date) AS unit_number_then,
             i.subtotal_rent, i.subtotal_fees, i.subtotal_utilities,
             i.subtotal_deposits, i.subtotal_late_fees,
             i.work_trade_credit_amount,
             u.unit_number, pr.name AS property_name
        FROM invoices i
        LEFT JOIN units u       ON u.id  = i.unit_id
        LEFT JOIN properties pr ON pr.id = u.property_id
       WHERE i.id = ANY($1::uuid[])
       ORDER BY i.due_date ASC, i.invoice_number ASC`, [invoiceIds])

    const shape = (l: any) => ({
      id: l.id, type: l.type, entry_description: l.entry_description,
      amount: l.amount, status: l.status, due_date: l.due_date, notes: l.notes,
      label: chargeLabel(l), detail: chargeDetail(l),
      open: l.open === true,
    })
    const visible = (l: any) => seesWorkTrade || !l.work_trade
    const money = (xs: any[], f: (l: any) => number) =>
      Math.round(xs.reduce((s, l) => s + Math.round(f(l) * 100), 0)) / 100
    // Money that came in on it: settled, still clearing, or taken from the deposit.
    const paidOf = (l: any) => (!l.work_trade && ['settled', 'processing', 'paid_via_deposit'].includes(l.status)) ? Number(l.amount) : 0

    const data: any[] = invoices.map((i: any) => {
      const mine = lines.filter((l: any) => l.invoice_id === i.id)
      const balance = money(mine, l => Number(l.open_amount))
      const amountPaid = money(mine, paidOf)
      const row: any = {
        ...i,
        amount_paid: amountPaid,
        balance,
        // What this bill comes to now: what was paid on it plus what it still
        // owes (late fees included, which the invoice's own total never was).
        total_amount: Math.round((amountPaid + balance) * 100) / 100,
        lines: mine.filter(visible).map(shape),
      }
      if (!seesWorkTrade) {
        delete row.work_trade_credit_amount
        delete row.work_trade_credit_hours
      }
      return row
    })
    const loose = lines.filter((l: any) => !l.invoice_id)
    if (loose.length) {
      const balance = money(loose, l => Number(l.open_amount))
      data.push({
        id: 'not-on-a-bill',
        invoice_number: NOT_ON_A_BILL,
        due_date: loose[0].due_date,
        status: 'pending',
        unit_number_then: null, unit_number: null, property_name: null,
        amount_paid: 0, balance, total_amount: balance,
        lines: loose.filter(visible).map(shape),
      })
    }
    res.json({ success: true, data })
  } catch (e) { next(e) }
})

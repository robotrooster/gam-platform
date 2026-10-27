import { Router } from 'express'
import { query, queryOne } from '../db'
import {
  listOpenTenantBalances, openBalanceSql, openAmountSql, outstandingTotals, seesGrandTotals,
  OUTSTANDING_ROW_STATUS_LABEL,
} from '../services/openBalances'
import { listPaymentsByMonth, isLedgerMonth } from '../services/paymentsByMonth'
import { z } from 'zod'
import {
  rentRollProperty, rentRollProperties, buildOpenMonth, buildRentRollHistory, RentRollRangeError,
} from '../services/rentRoll'
import { AppError } from '../middleware/errorHandler'
import { chargeLabelColumnsSql, chargeLabel, chargeDetail } from '../services/invoiceNotice'
import { openBillsFor, NOT_ON_A_BILL as OPEN_BILLS_NOT_ON_A_BILL } from '../services/openBills'
import { tenantLivesHereSql } from '../services/posPeople'
import { askingAs, bookCaller } from '../services/registerBook'
import { landlordScopeIds } from '../lib/landlordScope'
import {
  requireAuth, requirePerm, getScopedPropertyIds, userHasPerm, propertyCutoffsOf, bookkeeperRequestScopeOf,
} from '../middleware/auth'

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
    // 10/5 (Nic): whether money RECORDED for this household may be less than
    // the bill — every property it owes at takes part payments (the desk
    // quote's rule, services/manualPaymentSettle) — so the Front Desk never
    // tells someone "rent cannot be part-paid" where it can.
    const propIds = [...new Set(residents.flatMap(r => r.property_ids ?? []).filter((x): x is string => !!x))]
    const partialOk = new Set(propIds.length ? (await query<{ id: string }>(
      `SELECT id FROM properties WHERE id = ANY($1::uuid[]) AND accept_partial_payments`, [propIds])).map(r => r.id) : [])
    for (const r of residents as any[]) {
      const ids: string[] = (r.property_ids ?? []).filter((x: string | null) => !!x)
      r.accept_partial_payments = ids.length > 0 && ids.every(id => partialOk.has(id))
    }
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
    // 10/20 (review): the lives-here gate below reads the ACCOUNT's register
    // book, so it has to be told who is asking — a co-owner of one company of
    // the account reaches only that one (services/registerBook). The desk,
    // holding no company of her own, reads the account she works for.
    const tp: unknown[] = [landlordIds, scopedIds]
    // No one company to name — this list spans the account — so the desk's own
    // token company anchors it (bookCaller's fallback) and a landlord asks as themselves.
    const wt = askingAs(tp, await bookCaller(req.user, undefined, query))
    const tickets = await query<any>(`
      SELECT t.id, t.items, t.note, t.property_id, p.name AS property_name,
             to_char(t.created_at, 'YYYY-MM-DD') AS written_on,
             t.tenant_id, t.pos_customer_id,
             COALESCE(tu.first_name, c.first_name, rc.first_name) AS first_name,
             COALESCE(tu.last_name,  c.last_name,  rc.last_name)  AS last_name,
             COALESCE(CASE WHEN tn.id IS NOT NULL AND ${tenantLivesHereSql('tn.id', 't.landlord_id', wt)} THEN tu.email END,
                      c.email, rc.email) AS email,
             COALESCE(CASE WHEN tn.id IS NOT NULL AND ${tenantLivesHereSql('tn.id', 't.landlord_id', wt)} THEN tu.phone END,
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
         AND ($2::uuid[] IS NULL OR t.property_id = ANY($2::uuid[]))`, tp)
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
    // ── 10/25 (Nic): A TRACKED PAYMENT THE DESK COLLECTS BUT GAM NEVER TAKES ──
    //
    //   "Is that going to appear on the front desk person's list as like, hey,
    //    collect this money?"  → yes, "collect-only, can't be rung up".
    //
    // Dominic Gonzalez's installment is the TRUST's money, not the park's, so
    // GAM invoices nothing for it and nothing of it may reach the park's books
    // (home_sale_contracts.tracked_not_billed). But he pays at the counter, and
    // a desk that is never told cannot collect — so the line is here, and it is
    // built to be impossible to ring up:
    //
    //   * there is no charge behind it at all, so no Record payment, no desk
    //     quote, no card reader and no POS path can reach it — the same reason
    //     a pay link above carries `record_with: []`;
    //   * `collect_only: true` and the wording say outright that it is not a
    //     GAM payment, so nobody tries;
    //   * pressing it marks the ledger (PATCH /home-sales/:id/installments/mark)
    //     and writes no money anywhere.
    //
    // It never counts toward the grand totals either: `everyone` is what those
    // are summed over, and this is not money GAM is owed.
    // ONE line per contract, the oldest payment still owed, and how many are
    // behind it. A counter reads a person, not a list of months — eight lines
    // for one resident is the kind of noise that gets a desk to guess.
    const tracked = await query<any>(`
      SELECT DISTINCT ON (c.id)
             i.installment_number, i.amount::float AS amount,
             i.billing_month::text AS due_on,
             c.id AS contract_id, c.installments_total,
             un.unit_number, pr.id AS property_id, pr.name AS property_name,
             t.id AS tenant_id, usr.first_name, usr.last_name, usr.email, usr.phone,
             (SELECT COUNT(*) FROM home_sale_installments b
               WHERE b.contract_id = c.id AND b.payment_id IS NULL
                 AND b.settled_off_platform_at IS NULL
                 AND b.billing_month <= (NOW() AT TIME ZONE COALESCE(pr.timezone, 'America/Phoenix'))::date
             )::int AS behind
        FROM home_sale_installments i
        JOIN home_sale_contracts c ON c.id = i.contract_id
        JOIN units un ON un.id = c.unit_id
        JOIN properties pr ON pr.id = un.property_id
        JOIN tenants t ON t.id = c.tenant_id
        JOIN users usr ON usr.id = t.user_id
       WHERE c.status = 'active'
         AND c.tracked_not_billed
         AND i.payment_id IS NULL
         AND i.settled_off_platform_at IS NULL
         AND i.billing_month <= (NOW() AT TIME ZONE COALESCE(pr.timezone, 'America/Phoenix'))::date
         AND c.landlord_id = ANY($1::uuid[])
         AND ($2::uuid[] IS NULL OR pr.id = ANY($2::uuid[]))
       ORDER BY c.id, i.billing_month`, [landlordIds, scopedIds])
    for (const k of tracked) {
      out.push({
        tenant_id: k.tenant_id,
        first_name: k.first_name, last_name: k.last_name,
        phone: k.phone ?? null, email: k.email ?? null,
        unit_number: k.unit_number,
        property_id: k.property_id, property_ids: [k.property_id], property_name: k.property_name,
        ...oneOff(Number(k.amount), k.due_on),
        // No charge exists, so nothing here can be recorded as a payment.
        record_with: [],
        collect_only: true,
        tracked_payment: {
          contractId: k.contract_id,
          installmentNumber: k.installment_number,
          installmentsTotal: k.installments_total,
          dueOn: k.due_on,
          behind: k.behind,
          say: 'Home payment — NOT a GAM payment. Take it the way the landlord arranged '
             + 'and mark it here; do not ring it up on the register.'
             + (k.behind > 1 ? ` ${k.behind} payments are behind; this marks the oldest.` : ''),
        },
      })
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
 * "View payments" never see it — they get the list of who owes and Record
 * payment (10/13: under the Payments tab, the Outstanding Balances tab being
 * gone) — so this answers 403 for them, server-side. Property-locked staff
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

/**
 * THE PAYMENTS PAGE AND THE RENT ROLL (10/13, Nic): "the payments page is the
 * rent roll for the open month. And the rent roll page is the historical
 * lookup for previous reportings for quarters or years or individual months or
 * whatever." One property at a time ("you select either property and view only
 * those properties"). services/rentRoll's header is the contract:
 *
 *   GET /api/balances/rent-roll/properties                      the picker
 *   GET /api/balances/rent-roll/open-month?propertyId=          the Payments page
 *   GET /api/balances/rent-roll/history?propertyId=&from=&to=   the Rent Roll page
 *                                       (&range=all for all time)
 *
 * WHO — unchanged from the Rent Roll and the Payments ledger: the account
 * owner and anyone with "View all payments" (payments.view_all), answered 403
 * server-side for anyone else; staff limited to their properties (a property
 * that is not theirs is a 404, never another property's money). Sums across
 * households ride only for a viewer seesGrandTotals admits (decisions #25).
 * 10/14 (Nic), about Lisa Scheeler (Mountain View's on-site manager: "View who
 * owes" and "Take payments", not "View all payments"): "they should see at
 * least the payments tab ... kind of the same way that I see it, but not with
 * that top view ... not show all the totals, the work trade, all these things
 * at the top in the header. Just have it show the record payment like it does
 * and down the list, everybody else who's paid or paid late or whatever." So
 * the picker and the open month also answer "View who owes" (balances.view) —
 * the desk's view, decided here: their properties only, every row, no sums
 * (only with "View all payments"), and no work trade on any row (S641, Nic:
 * "I don't want her to see the covered by work trade" — the same rule as GET
 * /balances and /:tenantId/invoices). The Rent Roll (history, payment health)
 * and the tenant report stay "View all payments".
 * 10/13 (Nic): "Bookkeepers SEE the Payments and Rent Roll pages, read-only."
 * These three GETs are on the bookkeeper allowlist (lib/bookkeeperAccess) and
 * a bookkeeper holds payments.view_all there; their property boxes narrow
 * every read (getScopedPropertyIds), the clean cut at a sale holds
 * (propertyCutoffsOf), the folder's lease end date follows the owner's
 * lease-dates box, and no row carries a desk window (only a viewer who may
 * take a payment gets one — recording a tenant's payment is never a
 * bookkeeper's, 10/12). Nothing here writes.
 *
 * 10/13 (Nic): "Remove the 'keep moved-out households' setting entirely" — the
 * old GET /rent-roll (every property side by side) and its PUT
 * /rent-roll/moved-out are gone; nothing reads or writes
 * landlords.rent_roll_moved_out any more (the column stays: expand, then
 * contract). People no longer living there who still owe are the history's
 * "Moved out, still owes" folder until paid.
 */
const RENT_ROLL_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/
const rentRollPropertyQuery = z.object({
  propertyId: z.string({ required_error: 'Pick a property.' }).uuid('Pick a property.'),
})
const rentRollHistoryQuery = rentRollPropertyQuery.extend({
  from: z.string().regex(RENT_ROLL_MONTH, 'Pick months as YYYY-MM, for example 2026-10.').optional(),
  to: z.string().regex(RENT_ROLL_MONTH, 'Pick months as YYYY-MM, for example 2026-10.').optional(),
  range: z.enum(['all'], { errorMap: () => ({ message: 'The only named range is all (all time).' }) }).optional(),
})

/** The property asked for, once the viewer may see it (404 otherwise). */
async function rentRollPropertyFor(req: import('express').Request, propertyId: string) {
  const property = await rentRollProperty({
    landlordIds: landlordScopeIds(req.user!),
    scopedPropertyIds: await getScopedPropertyIds(req.user),
    propertyId,
    cutoffs: await propertyCutoffsOf(req.user),
  })
  if (!property) throw new AppError(404, 'That property is not one you can see.')
  return property
}

balancesRouter.get('/rent-roll/properties', requirePerm('payments.view_all', 'balances.view'), async (req, res, next) => {
  try {
    const data = await rentRollProperties({
      landlordIds: landlordScopeIds(req.user!),
      scopedPropertyIds: await getScopedPropertyIds(req.user),
      cutoffs: await propertyCutoffsOf(req.user),
    })
    res.json({ success: true, data })
  } catch (e) { next(e) }
})

balancesRouter.get('/rent-roll/open-month', requirePerm('payments.view_all', 'balances.view'), async (req, res, next) => {
  try {
    const parsed = rentRollPropertyQuery.safeParse(req.query)
    if (!parsed.success) throw new AppError(400, parsed.error.issues[0]?.message ?? 'Pick a property.')
    const property = await rentRollPropertyFor(req, parsed.data.propertyId)
    // A property sold out of the account has history (the Rent Roll), never an open month.
    if (!property.owned) throw new AppError(404, 'That property is no longer yours — its bills from before are on the Rent Roll.')
    // 10/14 (Nic): the front desk ("View who owes" without "View all payments")
    // gets "not ... all the totals, the work trade, all these things at the top".
    const seesAll = userHasPerm(req.user, 'payments.view_all')
    const data = await buildOpenMonth({
      landlordIds: landlordScopeIds(req.user!), property, withTotals: seesAll && seesGrandTotals(req.user),
      // The desk window only for a viewer who may log a payment (never a bookkeeper).
      mayRecord: userHasPerm(req.user, 'take_payment'),
      // S641: work trade only for a viewer who may see it (as GET /balances).
      workTrade: userHasPerm(req.user, 'payments.view_all', 'books.view'),
    })
    res.json({ success: true, data })
  } catch (e) { next(e) }
})

balancesRouter.get('/rent-roll/history', requirePerm('payments.view_all'), async (req, res, next) => {
  try {
    const parsed = rentRollHistoryQuery.safeParse(req.query)
    if (!parsed.success) throw new AppError(400, parsed.error.issues[0]?.message ?? 'Pick a property and months.')
    const { propertyId, from, to, range } = parsed.data
    const allTime = range === 'all'
    if (!allTime && (!from || !to)) throw new AppError(400, 'Pick a start month and an end month, or all time.')
    const property = await rentRollPropertyFor(req, propertyId)
    const data = await buildRentRollHistory({
      landlordIds: landlordScopeIds(req.user!), property, from, to, allTime, withTotals: seesGrandTotals(req.user),
      // 10/12 (Nic): lease dates are the owner's box per bookkeeper.
      showLeaseDates: req.user!.role !== 'bookkeeper' || (await bookkeeperRequestScopeOf(req.user!)).showLeaseDates,
    }).catch(e => { throw e instanceof RentRollRangeError ? new AppError(400, e.message) : e })
    res.json({ success: true, data })
  } catch (e) { next(e) }
})

/** The group a charge on no invoice is shown under (a counter charge, a carried balance). */
/** The group a charge on no invoice is shown under. One definition: services/openBills. */
export const NOT_ON_A_BILL = OPEN_BILLS_NOT_ON_A_BILL

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
/**
 * ── 10/27 (Nic): PAPER BILLS ────────────────────────────────────────────────
 *
 *   "It's a setting on the landlord page, a property level setting. Do you want
 *    to print paper copies of the bills when these are generated? Make it
 *    easier. Just make a button on each invoice that can be printed and make it
 *    where there's a quick print all outstanding button."
 *
 * Why it exists at all, from 10/26: landlords who hand-deliver bills to doors on
 * the first of the month — "especially where utilities are billed back and they
 * don't exactly know what their bill is going to be."
 *
 * GET /api/balances/bills-to-print?propertyId=…            every open bill there
 * GET /api/balances/bills-to-print?tenantId=…               one household's
 * GET /api/balances/bills-to-print?tenantId=…&invoiceId=…   one bill, on its own
 *
 * The property is derived from the resident when it is not named, so the button
 * ON a bill needs nothing but the bill.
 *
 * The bills themselves come from services/openBills — the same query the
 * on-screen breakdown reads, so the sheet in somebody's hand and the screen
 * behind the counter can never disagree about a late fee. Each line already
 * carries its own words (`detail`), which is where the meter read lives, and
 * that is the whole reason these get hand-delivered.
 *
 * Scope: the same permission and property lock as the balances list itself.
 */
balancesRouter.get('/bills-to-print', requirePerm('payments.view_all', 'balances.view'), async (req, res, next) => {
  try {
    const q = z.object({
      propertyId: z.string().uuid('Pick a property.').optional(),
      tenantId: z.string().uuid().optional(),
      invoiceId: z.string().uuid().optional(),
    }).safeParse(req.query)
    if (!q.success) throw new AppError(400, q.error.issues[0]?.message ?? 'Pick a property.')
    if (!q.data.propertyId && !q.data.tenantId) throw new AppError(400, 'Pick a property.')

    const landlordIds = landlordScopeIds(req.user!)
    const scopedIds = await getScopedPropertyIds(req.user)
    // The button ON a bill knows the resident, not the park. Derive it from
    // where they owe, then put it through the SAME scope check as a named one —
    // deriving an id must never be a way around the property lock.
    const propertyId = q.data.propertyId ?? (await queryOne<{ id: string }>(
      `SELECT DISTINCT un.property_id AS id
         FROM payments p
         LEFT JOIN invoices inv ON inv.id = p.invoice_id
         JOIN units un ON un.id = p.unit_id
        WHERE COALESCE(p.tenant_id, inv.tenant_id) = $1
          AND p.landlord_id = ANY($2::uuid[])
        LIMIT 1`, [q.data.tenantId, landlordIds]))?.id
    if (!propertyId) throw new AppError(404, 'There is nothing to print for them.')
    const property = await rentRollPropertyFor(req, propertyId)

    // Who has something open at this property. One household per lease — the
    // bill is the household's, and a co-tenant must not produce a second sheet
    // for the same bill.
    const people = await query<{ tenant_id: string; name: string; unit_number: string | null; lease_id: string | null }>(
      `SELECT DISTINCT ON (COALESCE(p.lease_id::text, p.tenant_id::text))
              COALESCE(p.tenant_id, inv.tenant_id) AS tenant_id,
              TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')) AS name,
              un.unit_number, p.lease_id
         FROM payments p
         LEFT JOIN invoices inv ON inv.id = p.invoice_id
         LEFT JOIN units un ON un.id = p.unit_id
         LEFT JOIN tenants t ON t.id = COALESCE(p.tenant_id, inv.tenant_id)
         LEFT JOIN users u ON u.id = t.user_id
        WHERE un.property_id = $1
          AND p.landlord_id = ANY($2::uuid[])
          AND COALESCE(p.tenant_id, inv.tenant_id) IS NOT NULL
          AND ($3::uuid IS NULL OR COALESCE(p.tenant_id, inv.tenant_id) = $3::uuid)
          AND p.entry_description IS DISTINCT FROM 'FLEXPAY'
          AND p.status <> 'voided'
          AND ${openBalanceSql('p')} AND ${openAmountSql('p')} > 0
        ORDER BY COALESCE(p.lease_id::text, p.tenant_id::text), un.unit_number, p.due_date`,
      [propertyId, landlordIds, q.data.tenantId ?? null])

    // The letterhead: who the bill is FROM. A hand-delivered invoice has to
    // name the office and say where to take the money, or it is a note.
    const head = await queryOne<{
      street1: string | null; street2: string | null
      city: string | null; state: string | null; zip: string | null
      office_phone: string | null; office_email: string | null; company: string | null
    }>(
      `SELECT pr.street1, pr.street2, pr.city, pr.state, pr.zip, pr.office_phone, pr.office_email,
              COALESCE(NULLIF(l.business_name, ''), u.first_name || ' ' || u.last_name) AS company
         FROM properties pr
         JOIN landlords l ON l.id = pr.landlord_id
         JOIN users u ON u.id = l.user_id
        WHERE pr.id = $1`, [propertyId])
    const letterhead = {
      id: property.id,
      name: property.name,
      company: head?.company ?? null,
      address: [head?.street1, head?.street2].filter(Boolean).join(', ') || null,
      cityLine: [head?.city, [head?.state, head?.zip].filter(Boolean).join(' ')]
        .filter(Boolean).join(', ') || null,
      phone: head?.office_phone ?? null,
      email: head?.office_email ?? null,
    }

    if (people.length === 0) {
      return res.json({ success: true, data: { property: letterhead, households: [] } })
    }

    const { bills, leaseOf, tenantOf } = await openBillsFor({
      tenantIds: people.map(p => p.tenant_id),
      landlordIds,
      scopedPropertyIds: scopedIds,
      // S641: a work-trade line is between the landlord and that resident. A
      // sheet carried to a door is the last place to print it for a viewer who
      // may not see it.
      seesWorkTrade: userHasPerm(req.user, 'payments.view_all', 'books.view'),
      groupLooseBy: 'lease',
    })
    // "a button on each invoice that can be printed" — one bill, on its own.
    const wanted = q.data.invoiceId ? bills.filter(b => String(b.id) === q.data.invoiceId) : bills

    // Each bill lands on the household whose lease it bills; a charge on no
    // lease falls back to the resident the invoice names.
    const households = people.map(p => ({
      tenantId: p.tenant_id,
      name: p.name || 'Resident',
      unitNumber: p.unit_number,
      bills: wanted.filter(b =>
        (p.lease_id && leaseOf.get(String(b.id)) === p.lease_id)
        || (!p.lease_id && tenantOf.get(String(b.id)) === p.tenant_id)),
    })).filter(h => h.bills.length > 0)

    res.json({
      success: true,
      data: { property: letterhead, households },
    })
  } catch (e) { next(e) }
})

balancesRouter.get('/:tenantId/invoices', requirePerm('balances.view'), async (req, res, next) => {
  try {
    // 10/27: the query that builds these bills now lives in
    // services/openBills, so the printed sheet (GET /bills-to-print) and this
    // page cannot drift apart about what a bill says. The contract and the
    // reasoning behind every piece of it moved with it.
    const { bills } = await openBillsFor({
      tenantIds: [req.params.tenantId],
      landlordIds: landlordScopeIds(req.user!),
      scopedPropertyIds: await getScopedPropertyIds(req.user),
      // S641 (Nic): "I don't want her to see the covered by work trade." A
      // work-trade arrangement is between the landlord and that resident; the
      // front desk needs the amount owed, not the private terms behind it.
      // Stripped from the RESPONSE rather than hidden on the screen — a figure
      // (or a line saying "Work trade — suspended") that never leaves the server
      // cannot be read out of a network tab. What is owed never included those
      // lines anyway (openBalanceSql), so the desk still sees the right number.
      seesWorkTrade: userHasPerm(req.user, 'payments.view_all', 'books.view'),
    })
    res.json({ success: true, data: bills })
  } catch (e) { next(e) }
})

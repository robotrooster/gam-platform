/**
 * THE PAYMENTS PAGE AND THE RENT ROLL — ONE PROPERTY AT A TIME (10/13, Nic).
 *
 *   "the payments page is the rent roll for the open month. And the rent roll
 *    page is the historical lookup for previous reportings for quarters or
 *    years or individual months or whatever."
 *   "you select either property and view only those properties … in order of
 *    space number … what was invoiced what was paid any difference in the
 *    balance if they make a partial payment."
 *   "for the open month I want it to be in order of space number but below any
 *    outstanding balances. So outstanding balances are always at the top of
 *    this list. And then once it's paid, it drops down and inserts itself in
 *    order of space number."
 *   Answered 10/13: one row per household, and a household is a LEASE ("when
 *   someone is renting 2 spots with 2 leases it is 2 households"); every space
 *   shows, an empty one as a gray Vacant row; no On time column — the status
 *   pill says it (Paid / Paid late +N / Partial / Owes +N / Due <date>); a
 *   partial past grace with money still owed is red "Owes +N"; work trade
 *   covering the month is Paid with method "Work trade"; eviction mode (payments
 *   blocked) is shown; the moved-out setting is gone — people no longer living
 *   there who still owe sit in a "Moved out, still owes" folder until paid; a
 *   payment logged by hand after the late fee posted counts late from the day
 *   it was logged (the 10/6 rule, the credit history's — services/lateness).
 *
 * THE CONTRACT (types: packages/shared/src/rentRoll.ts; keys camelCase as
 * built). Every route is GET, under /api/balances, and guarded as the Rent Roll
 * and the Payments ledger always were: requirePerm('payments.view_all') — the
 * account owner, property managers and staff with "View all payments" — over
 * the account's companies (landlordScopeIds), a property-locked viewer to their
 * properties (getScopedPropertyIds). Sums across households (`totals`) ride
 * only for a viewer seesGrandTotals admits (decisions #25).
 *
 * 10/14 (Nic), about Lisa Scheeler, Mountain View's on-site manager ("View who
 * owes", "Take payments", not "View all payments"): "they should see at least
 * the payments tab on the financials tab ... kind of the same way that I see
 * it, but not with that top view. Like it should just have the header that
 * says it's for Mountain View RV, but not show all the totals, the work trade,
 * all these things at the top in the header. Just have it show the record
 * payment like it does and down the list, everybody else who's paid or paid
 * late or whatever. I want to see all that." The picker and the open month
 * also answer "View who owes" (balances.view) — the desk's view: their
 * properties only (getScopedPropertyIds), every row, no `totals` (routes/
 * balances: sums only with "View all payments"), and no work trade on any row
 * (`workTrade: false` — S641, Nic: "I don't want her to see the covered by
 * work trade"; withoutWorkTrade). The Rent Roll (history, payment health) and
 * the tenant report stay "View all payments".
 *
 * 10/13 (Nic): "Bookkeepers SEE the Payments and Rent Roll pages, read-only."
 * The three GETs are on the bookkeeper allowlist (lib/bookkeeperAccess); their
 * property boxes narrow every read here as they narrow staff
 * (getScopedPropertyIds — the kept properties and the former ones, or the
 * whole company), the clean cut at a sale holds (a property that left the
 * company without being theirs is not on their list; a former one of theirs
 * reads only up to its last day — `cutoffs`, lib/bookkeeperScope), the lease
 * end date in the "Moved out, still owes" folder follows the owner's
 * lease-dates box (showLeaseDates), and no row carries a desk window
 * (`mayRecord`: recording a tenant's payment is never theirs — 10/12, Nic).
 * Their responses pass the contact scrub (scrubPersonFields): names, spaces
 * and money only.
 *
 *   GET /rent-roll/properties                       → RentRollProperty[]
 *       The picker: the properties the viewer may see, by name. A list of one
 *       opens straight to it ("Always pick first … EXCEPT a company with only
 *       one property"). `owned: false` marks a property sold out of the
 *       account: the account's own old bills are still on its Rent Roll; it
 *       has no open month.
 *
 *   GET /rent-roll/open-month?propertyId=<uuid>     → OpenMonthRoll
 *       THE PAYMENTS PAGE. The open month = the property's current calendar
 *       month. Rows (OpenMonthRow): every active lease on a space of the
 *       property; a gray row for each space with none — Vacant when it is
 *       empty, else what is there ("Owner Use", a stay guest "Checked in": an
 *       occupied space is never called Vacant); any other household billed
 *       this month here (a lease that ended this month — movedOut — or a
 *       charge on no lease); and any household still living here that owes on
 *       an earlier lease or charge here. Each: Invoiced, Paid (money and
 *       account credit; of which `credit`), Owed (= Invoiced − Paid − work
 *       trade: the difference after a partial), what is still owed on earlier
 *       months (owedEarlier), the payment methods, the status pill, eviction
 *       mode, and the expanded row (each payment: date, amount, method; each
 *       charge: what it's for, amount, paid or open). Ordered: anything owed
 *       here (this month or earlier) first, then the rest, each in space order
 *       (compareSpaces), so a row drops into its space when paid. recordWith
 *       opens the desk window (POST /payments/:id/record-manual — the one way
 *       to log a payment). 10/13 (Nic): "show ALL money coming in" — a stay
 *       guest's row for the money toward a stay this month, and `otherMoney`:
 *       every register sale and pay link this month that is no household's
 *       bill and no stay's (and what went back on one at the register). 10/13
 *       (Nic), round 3: "Stay rows SHOW what's still owed" — a stay row opened
 *       says what is still owed on the stay (registerStay reservationDue), and
 *       its Owed is what of that is owed now: its balance billed on its pay
 *       link, or the rest from arrival day (S649); a stay whose billed balance
 *       is still unpaid is a row even with no money this month, while its
 *       guest is still coming or here; "Pay links /
 *       register sales that name a space go ON that space's row" — a sale
 *       whose items or label name one of the property's spaces is on that
 *       space's row (OpenMonthRow.otherMoney); only money with no space stays
 *       in the folder. 10/13 (Nic): "not clickable to show an expanded
 *       breakdown" — each sale carries its breakdown from its own line items
 *       (OpenMonthOtherMoney.parts — the electric bill-backs apart from the
 *       site rent, each its own amount; saleParts) and the card fee paid on
 *       top (cardFee). 404 when the property is not the viewer's, or no longer
 *       theirs.
 *
 *   GET /rent-roll/history?propertyId=<uuid>&from=YYYY-MM&to=YYYY-MM
 *   GET /rent-roll/history?propertyId=<uuid>&range=all  → RentRollHistory
 *       THE RENT ROLL PAGE. Every household (lease) billed in the range, in
 *       space order: Invoiced / Paid / Owed for the range's bills, payment
 *       health (all time through the range's last month, the lease alone) and
 *       one stamp per month of the range (status + days past grace), the
 *       month counts, and `movedOutOwing` — everyone no longer living here who
 *       still owes, whatever the range, until paid; they are in that folder
 *       alone, never a row as well. The month counts are the rows' and the
 *       folder households' (10/13, Nic: "Rent Roll month counts INCLUDE the
 *       moved-out folder"); the totals are the rows' AND the folder
 *       households' bills in the range (10/13, Nic: "Range totals INCLUDE
 *       moved-out folder households"); each folder household carries its part
 *       (`inRange`) and the folder its sum (`movedOutTotals`, with the
 *       totals), so totals = rows + folder. `stays` (10/13, Nic: "show stays
 *       as an aggregate by line items … put them below with expandable
 *       notes"): the range's stays below the rows, by line item and how they
 *       were paid for, each with its notes per site (rentRollStays).
 *       `range=all`: from the property's first bill through the open month.
 *       400 for a bad range, 404 when the property is not the viewer's.
 *
 *   GET /api/tenants/:id/payment-report?leaseId=<uuid> (services/
 *       tenantPaymentReport) — the report a name opens, for that one lease.
 *
 * Every figure is the one payment-health definition (services/householdMonths)
 * grouped per lease (byLease): the stamp rule, the money (every dollar once:
 * paid, credit, work trade, owed), late fees in Invoiced and Owed but never the
 * color. The payments are the Payments ledger's (services/paymentsByMonth),
 * filed under the bill's month.
 */
import { query, db } from '../db'
import {
  FALLBACK_TIMEZONE, RENT_ROLL_MONTH_STATUSES, RENT_ROLL_STATUS_LABEL, RENT_ROLL_STATUS_COLOR,
  UNIT_STATUS_LABEL, BOOKING_STATUS_LABEL, STAY_PAYMENT_METHOD_LABEL,
  RENT_ROLL_STAY_UNITS, RENT_ROLL_STAY_VIAS, RENT_ROLL_STAY_VIA_LABEL,
  rentRollStatusOf, rentRollStatusText, compareSpaces, stayQuantityText, stayNightsBetween, addCalendarMonths, addStayDays,
  type RentRollProperty, type RentRollResident, type RentRollPayment, type RentRollCharge, type OpenMonthRow,
  type OpenMonthRoll, type OpenMonthTotals, type RentRollTotals, type RentRollHealth, type RentRollStamp, type RentRollHistoryRow,
  type RentRollMonthCount, type RentRollMovedOutOwing, type RentRollHistory, type RentRollRowStatus, type UnitStatus,
  type OpenMonthStay, type BookingStatus, type OpenMonthOtherMoney, type OpenMonthSalePart, type RentRollStayLine, type RentRollStayUnit,
  type RentRollStayVia, UTILITY_TYPE_LABEL, type UtilityType, type OpenMonthMovedOut,
} from '@gam/shared'
import {
  householdMonths, householdLines, paymentHealth, addMonths, monthsBetween, leaseOfRowSql, householdOfRowSql,
  owesPastGrace, ALL_TIME_FROM, BASE_CHARGE_TYPES, type HouseholdMonth, type ChargeLine, type PaymentHealth,
} from './householdMonths'
import { listPaymentsByMonth, type LedgerPayment } from './paymentsByMonth'
import { openBalanceSql, WORK_TRADE_MARKER_LABEL } from './openBalances'
import { bankPayableRowSql, allocationOrderSql } from './moneyPredicates'
import { reservationDue, soldCheckOutSql } from './registerStay'
import { todayIn } from '../lib/timezone'
import { HIDDEN_HISTORY, type PropertyCutoff } from '../lib/bookkeeperScope'

const cents = (v: number | string | null | undefined) => Math.round(Number(v ?? 0) * 100)
const dollars = (c: number) => Math.round(c) / 100
const BASE_TYPES = new Set<string>(BASE_CHARGE_TYPES)

/** The property a page is for, once the viewer may see it. */
export interface RentRollPropertyRef {
  id: string
  name: string
  timezone: string | null
  /** One of the account's companies owns it now (false: sold out of the account — its own old bills only). */
  owned: boolean
  /**
   * 10/12 (Nic): the clean cut at a sale, for a bookkeeper — the last day
   * ('YYYY-MM-DD') this former property of theirs was the company's. Its
   * history is read only up to that day; it has no open month. Absent (null)
   * for everyone else.
   */
  lastDay?: string | null
}

/**
 * 10/12 (Nic): a property that left the company without being the
 * bookkeeper's is cut whole (HIDDEN_HISTORY) — it is not on their list at all.
 */
function hiddenByCut(propertyId: string, cutoffs: readonly PropertyCutoff[] | null | undefined): boolean {
  return !!cutoffs?.some(c => c.propertyId === propertyId && c.lastDay === HIDDEN_HISTORY)
}

/**
 * The properties a viewer may look at, as a CTE `viewable (id)`: the
 * account's companies' properties, and a property they have since sold out of
 * the account where they still have bills of their own (10/12 review: "a
 * property sold out of the account keeps the seller's … old bills" —
 * properties are never deleted, only transferred). A property-locked viewer:
 * their properties only. $1 companies, $2 a property-locked viewer's
 * properties (NULL: all). The account's charges are read once.
 */
const VIEWABLE_PROPERTIES_CTE = `
  viewable AS (
    SELECT v.id FROM (
      SELECT pr.id FROM properties pr WHERE pr.landlord_id = ANY($1::uuid[])
      UNION
      SELECT vu.property_id FROM payments vp JOIN units vu ON vu.id = vp.unit_id
       WHERE vp.landlord_id = ANY($1::uuid[])
    ) v
    WHERE v.id IS NOT NULL AND ($2::uuid[] IS NULL OR v.id = ANY($2::uuid[])))`

/**
 * The property, when the viewer may see it (VIEWABLE_PROPERTIES_CTE). null: not
 * theirs (the route answers 404, never a different property's money).
 */
export async function rentRollProperty(opts: {
  landlordIds: string[]; scopedPropertyIds: string[] | null; propertyId: string
  /** A bookkeeper's clean cuts (propertyCutoffsOf); [] or absent for everyone else. */
  cutoffs?: readonly PropertyCutoff[] | null
}): Promise<RentRollPropertyRef | null> {
  if (!opts.landlordIds.length || hiddenByCut(opts.propertyId, opts.cutoffs)) return null
  const [p] = await query<RentRollPropertyRef>(
    `WITH ${VIEWABLE_PROPERTIES_CTE}
     SELECT pr.id, pr.name, pr.timezone, (pr.landlord_id = ANY($1::uuid[])) AS owned
       FROM properties pr WHERE pr.id = $3 AND pr.id IN (SELECT id FROM viewable)`,
    [opts.landlordIds, opts.scopedPropertyIds, opts.propertyId])
  if (!p) return null
  const cut = opts.cutoffs?.find(c => c.propertyId === p.id)
  // A former property of a bookkeeper's: history up to its last day, and no
  // open month (it is not theirs now, whoever owns it).
  return cut ? { ...p, owned: false, lastDay: cut.lastDay } : p
}

/** The picker: every property the viewer may see, by name. */
export async function rentRollProperties(opts: {
  landlordIds: string[]; scopedPropertyIds: string[] | null
  /** A bookkeeper's clean cuts (propertyCutoffsOf); [] or absent for everyone else. */
  cutoffs?: readonly PropertyCutoff[] | null
}): Promise<RentRollProperty[]> {
  if (!opts.landlordIds.length) return []
  const rows = await query<{ id: string; name: string; spaces: number; owned: boolean }>(`
    WITH ${VIEWABLE_PROPERTIES_CTE}
    SELECT pr.id, pr.name, (pr.landlord_id = ANY($1::uuid[])) AS owned,
           (SELECT COUNT(*) FROM units u WHERE u.property_id = pr.id AND u.retired_at IS NULL)::int AS spaces
      FROM properties pr
      JOIN viewable v ON v.id = pr.id
     ORDER BY lower(pr.name), pr.id`, [opts.landlordIds, opts.scopedPropertyIds])
  return rows.filter(r => !hiddenByCut(r.id, opts.cutoffs)).map(r => ({
    propertyId: r.id, name: r.name, spaces: Number(r.spaces) || 0,
    // A former property of a bookkeeper's is history only (rentRollProperty).
    owned: r.owned === true && !opts.cutoffs?.some(c => c.propertyId === r.id),
  }))
}

// ─── Shared pieces ───────────────────────────────────────────────────────────

/** A row's key: its lease, else the person billed on no lease. */
export function householdKey(leaseId: string | null | undefined, householdId: string): string {
  return leaseId ? `lease:${leaseId}` : `person:${householdId}`
}

interface LeaseFacts {
  lease_id: string; unit_id: string; unit_number: string; status: string; start_date: string
  ended_on: string | null; household_id: string | null; lives_here: boolean
}

/**
 * What the pages need to know of these leases: the space, whether it is active,
 * when it ended (terminated, else its end date, property calendar), its primary
 * resident (the household), and whether that household still lives at the
 * property (an active lease of theirs there — a move to another space is not a
 * move out).
 */
async function leaseFacts(leaseIds: readonly string[], propertyId: string): Promise<Map<string, LeaseFacts>> {
  if (!leaseIds.length) return new Map()
  const rows = await query<LeaseFacts>(`
    SELECT l.id AS lease_id, u.id AS unit_id, u.unit_number, l.status, to_char(l.start_date, 'YYYY-MM-DD') AS start_date,
           to_char(COALESCE((l.terminated_at AT TIME ZONE COALESCE(pr.timezone, '${FALLBACK_TIMEZONE}'))::date, l.end_date), 'YYYY-MM-DD') AS ended_on,
           hh.tenant_id AS household_id,
           (l.status = 'active' OR EXISTS (
              SELECT 1 FROM lease_tenants me JOIN leases al ON al.id = me.lease_id JOIN units au ON au.id = al.unit_id
               WHERE me.tenant_id = hh.tenant_id AND me.status IN ('active','pending_add','pending_remove')
                 AND al.status = 'active' AND au.property_id = $2)) AS lives_here
      FROM leases l
      JOIN units u ON u.id = l.unit_id
      JOIN properties pr ON pr.id = u.property_id
      LEFT JOIN LATERAL (
        SELECT lt.tenant_id FROM lease_tenants lt
         WHERE lt.lease_id = l.id AND lt.role = 'primary' AND lt.status <> 'void'
         ORDER BY (lt.status = 'active') DESC, lt.created_at, lt.id LIMIT 1) hh ON TRUE
     WHERE l.id = ANY($1::uuid[])`, [[...new Set(leaseIds)], propertyId])
  return new Map(rows.map(r => [r.lease_id, r]))
}

/**
 * The residents of these leases (primary first; a co-tenant who left the lease
 * is not named) and the names of these people billed on no lease.
 */
async function residentsOf(leaseIds: readonly string[], personIds: readonly string[]): Promise<{
  byLease: Map<string, RentRollResident[]>; byPerson: Map<string, RentRollResident[]>
}> {
  const byLease = new Map<string, RentRollResident[]>()
  const byPerson = new Map<string, RentRollResident[]>()
  if (leaseIds.length) {
    for (const r of await query<{ lease_id: string; tenant_id: string; name: string | null; is_primary: boolean }>(`
      SELECT lt.lease_id, lt.tenant_id, NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), '') AS name,
             (lt.role = 'primary') AS is_primary
        FROM lease_tenants lt
        JOIN tenants t ON t.id = lt.tenant_id
        LEFT JOIN users u ON u.id = t.user_id
       WHERE lt.lease_id = ANY($1::uuid[]) AND lt.status <> 'void'
         AND (lt.status <> 'removed' OR lt.role = 'primary')
       ORDER BY lt.lease_id, (lt.role = 'primary') DESC, lt.created_at, lt.id`, [[...new Set(leaseIds)]])) {
      const list = byLease.get(r.lease_id) ?? []
      if (!list.some(x => x.tenantId === r.tenant_id)) list.push({ tenantId: r.tenant_id, name: r.name || 'Resident', primary: r.is_primary === true })
      byLease.set(r.lease_id, list)
    }
  }
  if (personIds.length) {
    for (const r of await query<{ id: string; name: string | null }>(`
      SELECT t.id, NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), '') AS name
        FROM tenants t LEFT JOIN users u ON u.id = t.user_id WHERE t.id = ANY($1::uuid[])`, [[...new Set(personIds)]])) {
      byPerson.set(r.id, [{ tenantId: r.id, name: r.name || 'Resident', primary: true }])
    }
  }
  return { byLease, byPerson }
}

/** The one payment-health figure, as the pages read it. */
export function healthWire(h: PaymentHealth): RentRollHealth {
  return {
    percent: h.percent, onTime: h.on_time, counted: h.counted, paidLate: h.paid_late, partial: h.partial,
    outstanding: h.outstanding, notCounted: h.not_counted, workTrade: h.work_trade, from: h.from, through: h.through,
    label: h.label, onboardingLeftOut: h.onboarding_left_out,
  }
}

/** A charge line as the expanded row reads it. */
function chargeWire(l: ChargeLine): RentRollCharge {
  return {
    chargeId: l.payment_id, label: l.label, detail: l.detail, dueDate: l.due_date, month: l.month,
    invoiced: l.charged, paid: dollars(cents(l.paid) + cents(l.credit)), credit: l.credit, workTrade: l.work_trade, owed: l.owed,
    paidOn: l.paid_on, howPaid: l.how_paid, daysPastGrace: l.days_past_grace, isLateFee: l.is_late_fee,
    loggedAfterLateFee: l.logged_after_late_fee,
  }
}

const zeroTotals = (): RentRollTotals => ({ invoiced: 0, lateFees: 0, paid: 0, credit: 0, workTrade: 0, owed: 0 })
function addTotals(t: RentRollTotals, r: Pick<RentRollTotals, keyof RentRollTotals>): void {
  for (const k of ['invoiced', 'lateFees', 'paid', 'credit', 'workTrade', 'owed'] as const) t[k] = dollars(cents(t[k]) + cents(r[k]))
}

/**
 * A month's money summed over these household months, as the wire says it:
 * Paid includes the account credit applied (of which `credit`), so Invoiced =
 * Paid + work trade + Owed, every dollar once.
 */
function sumMonths(ms: readonly HouseholdMonth[]): RentRollTotals & { clearing: number } {
  const s = (f: (m: HouseholdMonth) => number) => dollars(ms.reduce((a, m) => a + cents(f(m)), 0))
  return {
    invoiced: s(m => m.charged), lateFees: s(m => m.charged_late_fees), paid: s(m => m.paid + m.credit), clearing: s(m => m.clearing),
    credit: s(m => m.credit), workTrade: s(m => m.work_trade), owed: s(m => m.owed),
  }
}

/** The pill: status, words and color. */
function pill<S extends RentRollRowStatus>(status: S, daysPastGrace: number, dueDate: string | null) {
  return {
    status,
    statusLabel: rentRollStatusText({ status, daysPastGrace, dueDate }),
    statusColor: RENT_ROLL_STATUS_COLOR[status],
  }
}

// ─── The open month (the Payments page) ─────────────────────────────────────

/** The open month of a property: its own calendar's month today. */
export function openMonthOf(property: Pick<RentRollPropertyRef, 'timezone'>, asOf?: string | null): string {
  return (asOf ?? todayIn(property.timezone)).slice(0, 7)
}

/**
 * Where the desk window opens for each household here: the oldest open charge
 * at this property the desk may take (the Outstanding list's rule: payable,
 * the landlord's money, not a FlexDeposit payment, the space not in eviction
 * mode), in the one allocation order. household key → charge id.
 */
async function deskAnchors(landlordIds: string[], propertyId: string): Promise<Map<string, string>> {
  const rows = await query<{ key: string; id: string }>(`
    SELECT DISTINCT ON (k.key) k.key, p.id
      FROM payments p
      LEFT JOIN invoices inv ON inv.id = p.invoice_id
      JOIN units u ON u.id = p.unit_id
      CROSS JOIN LATERAL (
        SELECT COALESCE('lease:' || (${leaseOfRowSql('p', 'inv')})::text,
                        'person:' || (${householdOfRowSql('p', 'inv')})::text) AS key) k
     WHERE p.landlord_id = ANY($1::uuid[])
       AND u.property_id = $2
       AND ${openBalanceSql('p')}
       AND ${bankPayableRowSql('p')}
       AND u.payment_block IS NOT TRUE
     ORDER BY k.key, ${allocationOrderSql('p')}`, [landlordIds, propertyId])
  return new Map(rows.map(r => [r.key, r.id]))
}

/**
 * Each payment's part on each household's bills this month: the ledger's
 * payments (filed under the bill's month), split by the household each charge
 * belongs to — one check that paid two spaces' leases is a payment on each
 * row, for its part. A part on a charge no row holds (money paid ahead on a
 * move-in box) goes to the row of the person who paid, when there is one.
 */
export function paymentsByHousehold(
  ledger: readonly LedgerPayment[], keyOfCharge: ReadonlyMap<string, string>, keyOfPerson: ReadonlyMap<string, string>,
): Map<string, RentRollPayment[]> {
  const out = new Map<string, RentRollPayment[]>()
  for (const p of ledger) {
    const parts = new Map<string, { money: number; credit: number }>()
    for (const l of p.lines) {
      const key = keyOfCharge.get(l.payment_id) ?? (p.tenant_id ? keyOfPerson.get(p.tenant_id) : undefined)
      if (!key) continue
      const part = parts.get(key) ?? { money: 0, credit: 0 }
      part.money += cents(l.paid)
      part.credit += cents(l.credit)
      parts.set(key, part)
    }
    for (const [key, part] of parts) {
      if (part.money <= 0 && part.credit <= 0) continue
      const list = out.get(key) ?? []
      list.push({
        paymentId: p.id, paidOn: p.paid_on, amount: dollars(part.money + part.credit), credit: dollars(part.credit),
        methodLabel: p.method_label, status: p.status, statusLabel: p.status_label, reference: p.reference,
        recordedBy: p.recorded_by ?? null, recordedFrom: p.recorded_from ?? null,
      })
      out.set(key, list)
    }
  }
  for (const list of out.values()) list.sort((a, z) => a.paidOn.localeCompare(z.paidOn) || a.paymentId.localeCompare(z.paymentId))
  return out
}

/**
 * The Payment method column: how the month was paid, oldest first — the
 * payments that stand (a returned one paid nothing), and "Work trade" when the
 * hours covered any of it (10/13, Nic: work trade covering the month is Paid,
 * method "Work trade").
 */
export function methodsOf(payments: readonly RentRollPayment[], workTrade: number): string[] {
  const out: string[] = []
  for (const p of payments) if (p.status !== 'returned' && !out.includes(p.methodLabel)) out.push(p.methodLabel)
  if (cents(workTrade) > 0 && !out.includes(WORK_TRADE_MARKER_LABEL)) out.push(WORK_TRADE_MARKER_LABEL)
  return out
}

/**
 * 10/13 (Nic): "outstanding balances are always at the top of this list. And
 * then once it's paid, it drops down and inserts itself in order of space
 * number." Rows owing anything here — this month's bills or an earlier
 * month's — first, each group in space order; at one space, the household
 * before the row of the space itself, then by name.
 */
export function compareOpenMonthRows(a: OpenMonthRow, z: OpenMonthRow): number {
  const owingA = cents(a.owed) + cents(a.owedEarlier) > 0 ? 0 : 1
  const owingZ = cents(z.owed) + cents(z.owedEarlier) > 0 ? 0 : 1
  const spaceRow = (r: OpenMonthRow) => Number(r.status === 'vacant' || r.status === 'occupied')
  return owingA - owingZ
    || compareSpaces(a.space, z.space)
    || spaceRow(a) - spaceRow(z)
    || (a.residents[0]?.name ?? a.occupant ?? '').localeCompare(z.residents[0]?.name ?? z.occupant ?? '')
    || a.key.localeCompare(z.key)
}

/**
 * What a space with nobody on a lease is. 10/13 review: Nic's gray Vacant row
 * is for an EMPTY space ("EVERY space shows, including empty ones as a gray
 * 'Vacant' row"); a space the owner uses (owner_use: no lease, no rent — S604),
 * one a stay guest is checked into, or one whose record says it is in use is
 * not empty. It reads as what is there, in the words GAM already uses for it
 * (BOOKING_STATUS_LABEL, UNIT_STATUS_LABEL), and its occupant when a guest is
 * checked in. null: empty — Vacant.
 */
export function spaceInUse(s: { unit_status: string; stay_checked_in: boolean; stay_guest: string | null }): {
  label: string; occupant: string | null
} | null {
  if (s.stay_checked_in) return { label: BOOKING_STATUS_LABEL.checked_in, occupant: s.stay_guest }
  if (s.unit_status === 'vacant' || s.unit_status === 'available') return null
  return { label: UNIT_STATUS_LABEL[s.unit_status as UnitStatus] ?? RENT_ROLL_STATUS_LABEL.occupied, occupant: null }
}

// ─── Stays (10/13, Nic) ──────────────────────────────────────────────────────
//
//   "the payments page ... should show all money coming in. The people that
//    paid short-term stays like Space RV 10 and 11 at Mountain View, those
//    should have details of the money that was paid."
//
// A stay is paid up front — at the register, on a pay link, or as the booking
// site's deposit — and every door that takes money for a stay writes its row
// in stay_payments (services/stayPayments), in the same transaction. A stay
// guest's row shows the money paid toward their stay THIS MONTH (the money
// that came in this month, never a stay's earlier payments again), each
// payment with its day, amount, how it was paid and what it was for, and
// anything given back this month: an early check-out's refund
// (stay_refund_parts, done) or a refund at the register on the sale that paid
// it (below). A stay put on a charge account paid nothing yet — that money
// comes in later, on the account's statement — so it is not money in here.
//
// "ALL money coming in": the register sales and pay links that are no
// household's bill and no stay's — propane to a walk-in, an emailed pay link
// to someone with no lease or stay here — are the page's `otherMoney`, each
// with its day, amount, how it was paid, what it was for and who paid.

/** One stay at the property the open month shows. */
interface StayBooking {
  id: string; unit_id: string; unit_number: string; status: string; tenant_id: string | null
  check_in: string; check_out: string; nights: number; guest: string | null
  /** 'YYYY-MM-DD': the day its balance was billed on a pay link, while that balance is unpaid (services/stayBalance); else null. */
  balance_billed_on: string | null
}

/** "Oct 4 – Nov 4" (calendar days, no time zone shift). */
export function stayDatesText(checkIn: string, checkOut: string): string {
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const day = (d: string) => `${MONTHS[Number(d.slice(5, 7)) - 1] ?? ''} ${Number(d.slice(8, 10))}`
  return `${day(checkIn)} – ${day(checkOut)}`
}

/**
 * How a payment toward a stay was made, in the Payments ledger's words: a card
 * swiped at the register is "Card · in person"; the booking site's deposit and
 * a pay link paid online are "Card · online" (shared paidByLabel's wording).
 * A register sale or pay link of anything else reads the same way.
 */
export function stayMethodLabel(p: { method: string; kind: string; paid_online: boolean | null }): string {
  if (p.method === 'card') return p.kind === 'site_deposit' || p.paid_online === true ? 'Card · online' : 'Card · in person'
  return STAY_PAYMENT_METHOD_LABEL[p.method as keyof typeof STAY_PAYMENT_METHOD_LABEL] ?? 'Recorded payment'
}

/**
 * What a payment toward a stay was for: "Booking deposit · stay Oct 12 – Oct
 * 15 · booking site", "Stay balance · stay Oct 12 – Oct 15 · pay link",
 * "Stay Oct 4 – Nov 4 · at the register".
 */
export function stayPaymentFor(p: { kind: string; via_link: boolean; balance_link: boolean }, dates: string): string {
  if (p.kind === 'site_deposit') return `Booking deposit · stay ${dates} · booking site`
  const what = p.balance_link ? `Stay balance · stay ${dates}` : `Stay ${dates}`
  return `${what} · ${p.via_link ? 'pay link' : 'at the register'}`
}

/** One register sale or paid pay link the open month reads (registerMoney). Money as text, cents by `cents`. */
export interface RegisterSale {
  id: string
  /** 'YYYY-MM-DD', the property's calendar. */
  sold_on: string
  sold_in_month: boolean
  method: string
  paid_online: boolean | null
  via_link: boolean
  /** What the sale charged before the card fee paid on top (total − surcharge). */
  base: string | number
  /** Of it, the background check GAM keeps (never the landlord's money). */
  screening: string | number
  who: string | null
  items: string | null
  /** Its parts toward stays (stay_payments), oldest first. */
  stays: Array<{ bookingId: string; toward: string | number }>
  /** Its refunds at the register (never an early check-out's: those are the stay's own parts), oldest first. */
  refunds: Array<{ id: string; day: string; inMonth: boolean; net: string | number; method: string }>
  /** The words it carries that can name a space: its items' names and its pay link's label (spaceNamedIn). */
  named?: string[]
  /** Who paid, when GAM knows them as a resident: the sale's, its pay link's, or its register customer's tenant. */
  payer_id?: string | null
  /**
   * 10/13 (Nic): the sale's own line items (pos_transaction_items), by name —
   * what each sold, how many, the price of one, its line's money, the
   * register's category and, for a stay item (pos_items.stay_unit), what one
   * of it buys. The breakdown (saleParts) reads them.
   */
  lines?: Array<{
    name: string; category: string | null; qty: string | number; unitPrice: string | number; subtotal: string | number
    stayUnit?: string | null
    /** The line's own tax rate (pos_transaction_items.tax_rate, a fraction); absent when none. */
    taxRate?: string | number | null
  }>
  /** The sale's tax, and its named taxes when the register wrote them (pos_transactions.tax_breakdown). */
  tax?: string | number
  taxes?: Array<{ name?: string | null; amount?: string | number | null }> | null
  /** What the register took off, and why. */
  discount?: string | number
  discount_reason?: string | null
  /** The card fee paid on top (pos_transactions.surcharge): never the landlord's money, never in `base`. */
  card_fee?: string | number
}

/**
 * A register item that is a utility bill-back — the utility recovery
 * report's own rule (routes/utility registerUtilityType, kept equal by
 * rentRoll.test.ts): an item in a utilities category whose name says which
 * utility. Propane sold at the counter names none: it is a sale, not a
 * bill-back (S635, Nic: delivered to the unit = utility; sold at the counter =
 * the register's price).
 */
export function registerBillBackOf(category: string | null | undefined, name: string | null | undefined): UtilityType | null {
  if (!/^utilit/i.test(String(category ?? ''))) return null
  const n = String(name ?? '')
  if (/\belectric/i.test(n)) return 'electric'
  if (/\bwater/i.test(n)) return 'water'
  if (/\bsewer/i.test(n)) return 'sewer'
  if (/\b(trash|garbage)/i.test(n)) return 'trash'
  if (/\bgas\b/i.test(n)) return 'gas'
  return null
}

/** What one of an item is, from its name: "kWh" in "Electric (per kWh)"; null when the name does not say. */
export function unitInName(name: string | null | undefined): string | null {
  const m = /\(\s*per\s+([^)]+?)\s*\)/i.exec(String(name ?? ''))
  return m ? m[1] : null
}

/**
 * 10/13 (Nic): "When Andres Razo paid by card online for his stay ... it
 * looks like that charge is just for electric. It's not ... It's not got a
 * good breakdown between what's a billback on the electricity and what is
 * not." The breakdown of a sale's money that came in (`shareC`, cents): each
 * line item with its own amount and what it is (an electric bill-back, site
 * rent), its taxes, then what comes off — a discount, the background check
 * (the screening's), the part toward a stay (on the stay's row). Anything of
 * the sale's total its lines do not show is one last part, so the parts
 * always add up to the money on the line. Pure.
 */
export function saleParts(s: RegisterSale, o: { shareC: number; screeningC: number; towardC: number }): OpenMonthSalePart[] {
  const parts: OpenMonthSalePart[] = []
  const lines = s.lines ?? []
  for (const l of lines) {
    const billBack = registerBillBackOf(l.category, l.name)
    parts.push({
      kind: 'item', label: String(l.name ?? '').trim() || 'Item',
      what: billBack ? `${UTILITY_TYPE_LABEL[billBack]} bill-back` : l.stayUnit ? 'Site rent' : null,
      qty: Number(l.qty), unitPrice: dollars(cents(l.unitPrice)), unit: unitInName(l.name), amount: dollars(cents(l.subtotal)),
    })
  }
  const taxC = cents(s.tax)
  const named = (s.taxes ?? []).filter(t => cents(t?.amount) > 0)
  if (taxC > 0) {
    if (named.length && named.reduce((t, x) => t + cents(x.amount), 0) === taxC) {
      for (const t of named) {
        parts.push({ kind: 'tax', label: String(t.name ?? '').trim() || 'Tax', what: null, qty: null, unitPrice: null, unit: null, amount: dollars(cents(t.amount)) })
      }
    } else {
      parts.push({ kind: 'tax', label: 'Tax', what: null, qty: null, unitPrice: null, unit: null, amount: dollars(taxC) })
    }
  }
  const off = (kind: OpenMonthSalePart['kind'], label: string, c: number) => {
    if (c > 0) parts.push({ kind, label, what: null, qty: null, unitPrice: null, unit: null, amount: dollars(-c) })
  }
  off('discount', s.discount_reason?.trim() ? `Discount · ${s.discount_reason.trim()}` : 'Discount', cents(s.discount))
  off('screening', 'Background check — the screening’s, not yours', o.screeningC)
  off('stay', 'Toward the stay — on the stay’s row', o.towardC)
  const rest = o.shareC - parts.reduce((t, x) => t + cents(x.amount), 0)
  if (rest !== 0) {
    parts.push({
      kind: 'rest', label: lines.length ? 'Rest of the sale' : (s.items?.trim() || 'Sale'),
      what: null, qty: null, unitPrice: null, unit: null, amount: dollars(rest),
    })
  }
  return parts
}

/**
 * The register's and the pay links' money this month (10/13, Nic: "show ALL
 * money coming in"), split once, every dollar in one place:
 *   - a sale's part toward a stay is the stay's (its row reads it from
 *     stay_payments); the rest of the sale — less the background check GAM
 *     keeps and the card fee paid on top — is `other`, when it was made this
 *     month;
 *   - a refund at the register comes off the sale's other items first, and
 *     only what is beyond them is the stay's (the early check-out's rule,
 *     services/earlyCheckOut staySources) — split between the stays the sale
 *     paid by their parts. This month's refunds only.
 * Pure: the sales as registerMoney reads them.
 */
export function splitRegisterMoney(sales: readonly RegisterSale[]): {
  other: OpenMonthOtherMoney[]
  stayRefunds: Map<string, OpenMonthStay['refunds']>
} {
  const other: OpenMonthOtherMoney[] = []
  const stayRefunds = new Map<string, OpenMonthStay['refunds']>()
  for (const s of sales) {
    const stays = (s.stays ?? []).map(x => ({ bookingId: x.bookingId, toward: cents(x.toward) })).filter(x => x.toward > 0)
    const toward = stays.reduce((t, x) => t + x.toward, 0)
    const share = Math.max(0, cents(s.base) - cents(s.screening) - toward)
    const items = s.items?.trim() || 'Sale'
    if (s.sold_in_month && share > 0) {
      other.push({
        id: s.id, saleId: s.id, kind: 'sale', day: s.sold_on, amount: dollars(share),
        methodLabel: stayMethodLabel({ method: s.method, kind: 'pos_sale', paid_online: s.paid_online }),
        forLabel: `${items} · ${s.via_link ? 'pay link' : 'at the register'}${toward > 0 ? ' · the stay’s part is on its row' : ''}`,
        who: s.who,
        // 10/13 (Nic): its breakdown, part by part (saleParts).
        parts: saleParts(s, { shareC: share, screeningC: cents(s.screening), towardC: toward }),
        cardFee: dollars(Math.max(0, cents(s.card_fee))),
      })
    }
    let otherLeft = share
    for (const r of s.refunds ?? []) {
      const net = Math.max(0, cents(r.net))
      const offOther = Math.min(net, otherLeft)
      otherLeft -= offOther
      const offStay = net - offOther
      if (!r.inMonth) continue
      const how = STAY_PAYMENT_METHOD_LABEL[r.method as keyof typeof STAY_PAYMENT_METHOD_LABEL] ?? 'Cash'
      if (offOther > 0) {
        other.push({
          id: r.id, saleId: s.id, kind: 'refund', day: r.day, amount: dollars(offOther), methodLabel: how,
          forLabel: `Refund at the register · ${items}`, who: s.who, parts: [], cardFee: 0,
        })
      }
      if (offStay <= 0 || toward <= 0) continue
      let left = offStay
      stays.forEach((x, i) => {
        const part = i === stays.length - 1 ? left : Math.min(left, Math.round((offStay * x.toward) / toward))
        left -= part
        if (part <= 0) return
        const list = stayRefunds.get(x.bookingId) ?? []
        list.push({
          refundId: stays.length > 1 ? `${r.id}:${x.bookingId}` : r.id, refundedOn: r.day, amount: dollars(part),
          label: `${how} · refund at the register`,
        })
        stayRefunds.set(x.bookingId, list)
      })
    }
  }
  // By day, a day's sales before its refunds; within those, the order they
  // happened in (registerMoney reads the sales oldest first, and a sort that
  // keeps ties keeps it).
  other.sort((a, z) => a.day.localeCompare(z.day) || Number(a.kind === 'refund') - Number(z.kind === 'refund'))
  return { other, stayRefunds }
}

// ─── A space a sale names (10/13, Nic) ───────────────────────────────────────
//
//   "Pay links / register sales that name a space go ON that space's row."
//   (Andres Razo's $752.17 pay link — "Electric (per kWh) — September, RV 27"
//   — is RV 27's.) "only money with no space stays in the folder."
//
// A register sale or a pay link names a space when its words — an item's name,
// the link's label — carry one of the property's spaces: its number
// (units.unit_number) or the label printed for it (units.display_label). "RV
// 27", "rv27", "RV #27" and "RV 027" are all RV 27 (the letters, then the
// number, leading zeros dropped). A space that is a bare number ("15") is
// named only after a word for a space or a # ("site 15", "#15") — never by any
// number in the words ("Propane 20 lb" names nothing). Words that name two of
// the property's spaces name no one space: the sale splits by its lines
// (splitSaleBySpace), else stays in the folder.

/** Words before a bare number that make it a space's ("site 15"). */
const SPACE_WORDS = new Set(['space', 'site', 'lot', 'spot', 'pad', 'unit', 'stall', 'no'])

/**
 * How a space's own number or label reads once normalized: "rv 27" (letters,
 * then the number), "# 15" (a bare number — and a space numbered with a word
 * for a space, "Lot 15", is "# 15" too, so "site 15" names it), else "= <its
 * words>" (a name like "Cabin Moose", matched as whole words).
 */
export function spaceKeysOf(name: string | null | undefined): string[] {
  const s = String(name ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
  if (!s) return []
  const lettered = /^([a-z]+)[ #.-]*(\d+)([a-z]?)$/.exec(s)
  if (lettered) {
    const n = `${parseInt(lettered[2], 10)}${lettered[3]}`
    return SPACE_WORDS.has(lettered[1]) ? [`${lettered[1]} ${n}`, `# ${n}`] : [`${lettered[1]} ${n}`]
  }
  const bare = /^#? ?(\d+)([a-z]?)$/.exec(s)
  if (bare) return [`# ${parseInt(bare[1], 10)}${bare[2]}`]
  return [`= ${s}`]
}

/** Each way a space could be named in these words, with where it is first said in them (spaceKeysIn). */
function spaceKeyPlaces(text: string): Map<string, number> {
  const s = text.toLowerCase()
  const out = new Map<string, number>()
  const at = (k: string, i: number) => { if (i < (out.get(k) ?? Infinity)) out.set(k, i) }
  for (const m of s.matchAll(/(?<![a-z0-9])([a-z]+)[ \t#.-]*(\d+)([a-z]?)(?![a-z0-9])/g)) {
    const n = `${parseInt(m[2], 10)}${m[3]}`
    at(`${m[1]} ${n}`, m.index ?? 0)
    if (SPACE_WORDS.has(m[1])) at(`# ${n}`, m.index ?? 0)
  }
  for (const m of s.matchAll(/(?<![a-z0-9])#\s*(\d+)([a-z]?)(?![a-z0-9])/g)) at(`# ${parseInt(m[1], 10)}${m[2]}`, m.index ?? 0)
  return out
}

/** Every way a space could be named in these words ("rv 27"; "# 15" after "site" or "#"). */
export function spaceKeysIn(text: string | null | undefined): string[] {
  return [...spaceKeyPlaces(String(text ?? '')).keys()]
}

/**
 * Every space of these that the words name (see above), the first named
 * first (10/14, Nic: "the first space named takes the odd cent"). `spaces`:
 * each space's id and its names (number, printed label).
 */
export function spacesNamedIn(
  texts: readonly (string | null | undefined)[],
  spaces: readonly { unitId: string; names: readonly (string | null | undefined)[] }[],
): string[] {
  // The words as one, each text apart ('|' joins no space's name across two).
  const all = texts.map(t => String(t ?? '').toLowerCase()).join(' | ')
  const said = spaceKeyPlaces(all)
  const first = new Map<string, number>()
  for (const sp of spaces) {
    for (const name of sp.names) {
      for (const k of spaceKeysOf(name)) {
        // A name in words ("Cabin Moose"): its words whole, whatever is between them.
        const words = k.startsWith('= ') ? k.slice(2).replace(/[^a-z0-9#]+/g, ' ').trim() : null
        const i = words === null ? said.get(k)
          : words ? new RegExp(`(?<![a-z0-9#])${words.split(' ').join('[^a-z0-9#]+')}(?![a-z0-9#])`).exec(all)?.index
          : undefined
        if (i !== undefined && i < (first.get(sp.unitId) ?? Infinity)) first.set(sp.unitId, i)
      }
    }
  }
  return [...first.entries()].sort((a, z) => a[1] - z[1]).map(([unitId]) => unitId)
}

/** The one space of these that the words name (spacesNamedIn); null when they name none, or more than one. */
export function spaceNamedIn(
  texts: readonly (string | null | undefined)[],
  spaces: readonly { unitId: string; names: readonly (string | null | undefined)[] }[],
): string | null {
  const hits = spacesNamedIn(texts, spaces)
  return hits.length === 1 ? hits[0] : null
}

// ─── A sale naming two spaces (10/14, Nic) ───────────────────────────────────
//
//   "A sale naming two spaces ('Electric — RV 2 and RV 27'): split it between
//    the two rows."
//
// A sale whose words name more than one of the property's spaces is split by
// its own lines: each line whose own name names one space ("Electric — RV 2",
// "Electric — RV 27") is that space's, with the line's own tax
// (pos_transaction_items.tax_rate). 10/14 (Nic): one line naming several
// spaces ("Electric — RV 2 and RV 27", $40) is split EVENLY between them, its
// tax with it — $20 each; the odd cent to the first space named in it. The
// rest of the sale — a line that names no space, the rest of its tax, a
// discount — names no one space, so it stays in the folder ("only money with
// no space stays in the folder"), and so do the sale's refunds (a refund names
// no line). A line toward a stay is the stay's (its row reads it), never a
// piece. Nothing to split — no line names a space, or the lines come to more
// than the sale's money after a discount — and the whole sale stays in the
// folder, as before.

/** `totalC` cents in `n` even shares, the first ones taking the odd cents (10/14, Nic). */
export function evenShares(totalC: number, n: number): number[] {
  const each = Math.floor(totalC / n)
  const odd = totalC - each * n
  return Array.from({ length: n }, (_, i) => each + (i < odd ? 1 : 0))
}

/** One space's part of a sale naming several (splitSaleBySpace). */
export interface SaleSpacePiece {
  unitId: string
  line: OpenMonthOtherMoney
}

/**
 * The parts of a sale's line in the month's money (`x`, a sale — never a
 * refund) that its lines name a space — a line naming one, that space's; a
 * line naming several, an even share for each (10/14, Nic): one line of money
 * per space, in space order, and what is left of the sale (null when nothing
 * is). The parts
 * add up to `x.amount`. null: the sale does not split (see above). Pure.
 */
export function splitSaleBySpace(
  x: OpenMonthOtherMoney, s: RegisterSale,
  spaces: readonly { unitId: string; names: readonly (string | null | undefined)[] }[],
): { pieces: SaleSpacePiece[]; rest: OpenMonthOtherMoney | null } | null {
  if (x.kind !== 'sale') return null
  type Line = NonNullable<RegisterSale['lines']>[number]
  const towardC = (s.stays ?? []).reduce((t, y) => t + Math.max(0, cents(y.toward)), 0)
  const taxOf = (l: Line) => Math.round(cents(l.subtotal) * (Number(l.taxRate) || 0))
  // Each space's lines, each with its tax in cents (`shared`: its even share of a line naming several).
  const byUnit = new Map<string, Array<{ line: Line; taxC: number; shared: boolean }>>()
  const add = (unitId: string, x: { line: Line; taxC: number; shared: boolean }) => byUnit.set(unitId, [...(byUnit.get(unitId) ?? []), x])
  const others: Line[] = []
  for (const l of s.lines ?? []) {
    const named = towardC > 0 && l.stayUnit ? [] : spacesNamedIn([l.name], spaces)
    if (named.length === 1) add(named[0], { line: l, taxC: taxOf(l), shared: false })
    else if (named.length > 1 && cents(l.subtotal) > 0) {
      // 10/14 (Nic): split EVENLY between the spaces it names, the first named taking the odd cent.
      const amounts = evenShares(cents(l.subtotal) + taxOf(l), named.length)
      const taxes = evenShares(taxOf(l), named.length)
      const qty = Math.round((Number(l.qty) / named.length) * 1000) / 1000
      named.forEach((unitId, i) => add(unitId, {
        line: { ...l, name: `${String(l.name ?? '').trim() || 'Item'} (split evenly)`, qty, subtotal: dollars(amounts[i] - taxes[i]) },
        taxC: taxes[i], shared: true,
      }))
    } else others.push(l)
  }
  const order = new Map(spaces.map((sp, i) => [sp.unitId, i]))
  const all = [...byUnit.entries()]
    .map(([unitId, xs]) => {
      const taxC = xs.reduce((t, x) => t + x.taxC, 0)
      return {
        unitId, lines: xs.map(x => x.line), shared: xs.some(x => x.shared), taxC,
        amountC: xs.reduce((t, x) => t + cents(x.line.subtotal), 0) + taxC,
      }
    })
  const parts = all.filter(p => p.amountC > 0)
    .sort((a, z) => (order.get(a.unitId) ?? 0) - (order.get(z.unitId) ?? 0))
  // A line with no money ($0) names its space for nothing: only lines with money
  // split. (A space whose lines come to nothing though one is a share of a line
  // naming several: the shares no longer add up to that line — no split.)
  for (const p of all) {
    if (p.amountC > 0) continue
    if (p.shared) return null
    others.push(...p.lines)
  }
  if (!parts.length) return null
  const splitC = parts.reduce((t, p) => t + p.amountC, 0)
  const splitTaxC = parts.reduce((t, p) => t + p.taxC, 0)
  const restC = cents(x.amount) - splitC
  if (restC < 0 || splitTaxC > cents(s.tax)) return null
  const via = s.via_link ? 'pay link' : 'at the register'
  const numberOf = (unitId: string) => String(spaces.find(sp => sp.unitId === unitId)?.names[0] ?? '').trim()
  const named = parts.map(p => numberOf(p.unitId)).filter(Boolean).join(' and ')
  const pieces: SaleSpacePiece[] = parts.map((p, i) => ({
    unitId: p.unitId,
    line: {
      ...x, id: `${x.id}:${p.unitId}`, amount: dollars(p.amountC),
      forLabel: `${p.lines.map(l => String(l.name ?? '').trim() || 'Item').join(', ')} · ${via} · part of a sale naming ${named}`,
      parts: saleParts({ ...s, lines: p.lines, tax: dollars(p.taxC), taxes: null, discount: 0, discount_reason: null },
        { shareC: p.amountC, screeningC: 0, towardC: 0 }),
      // The card fee rides once: on what is left of the sale, else the first space's part.
      cardFee: restC === 0 && i === 0 ? x.cardFee : 0,
    },
  }))
  const rest: OpenMonthOtherMoney | null = restC === 0 ? null : {
    ...x,
    forLabel: `${others.map(l => String(l.name ?? '').trim() || 'Item').join(', ') || 'The rest of the sale'} · ${via} · its lines naming ${named} are on their rows`,
    amount: dollars(restC),
    parts: saleParts({ ...s, lines: others, tax: dollars(cents(s.tax) - splitTaxC), taxes: splitTaxC > 0 ? null : s.taxes },
      { shareC: restC, screeningC: cents(s.screening), towardC }),
  }
  return { pieces, rest }
}

/**
 * Every register sale and paid pay link at this property that came in this
 * month or was refunded at the register this month, on the property's own
 * calendar (splitRegisterMoney splits it). Never a voided sale (it paid
 * nothing) nor one put on a charge account (no money came in: the account's
 * statement collects it later). `sales`: each sale as read — what it names
 * and who paid — so the open month can put it on the row of the space it
 * names.
 */
async function registerMoney(landlordIds: string[], property: RentRollPropertyRef, month: string): Promise<
  ReturnType<typeof splitRegisterMoney> & { sales: RegisterSale[] }
> {
  const tz = property.timezone ?? FALLBACK_TIMEZONE
  const inMonth = (col: string) => `to_char((${col}) AT TIME ZONE $3, 'YYYY-MM') = $4`
  // A refund at the register: never an early check-out's part (that is the
  // stay's own, stay_refund_parts), never one Stripe sent back.
  const registerRefund = (r: string) => `${r}.stay_refund_part_id IS NULL AND ${r}.reversed_at IS NULL`
  const sales = await query<RegisterSale>(`
    SELECT t.id, to_char((t.created_at AT TIME ZONE $3)::date, 'YYYY-MM-DD') AS sold_on,
           ${inMonth('t.created_at')} AS sold_in_month,
           t.payment_method AS method, t.paid_online, (t.pay_link_id IS NOT NULL) AS via_link,
           (t.total - COALESCE(t.surcharge, 0))::text AS base,
           COALESCE((SELECT SUM(ssp.amount) FROM screening_prepayments ssp
                      WHERE ssp.status <> 'void' AND ssp.source_id IN (t.id, t.pay_link_id)), 0)::text AS screening,
           COALESCE(NULLIF(TRIM(CONCAT_WS(' ', tu.first_name, tu.last_name)), ''),
                    NULLIF(TRIM(CONCAT_WS(' ', pc.first_name, pc.last_name)), ''),
                    NULLIF(TRIM(pl.customer_name), '')) AS who,
           -- The items by name: a sale's items share one written time, so no
           -- other order is the same twice.
           COALESCE((SELECT string_agg(i.item_name, ', ' ORDER BY i.item_name, i.id)
                       FROM pos_transaction_items i WHERE i.transaction_id = t.id),
                    NULLIF(TRIM(pl.label), '')) AS items,
           COALESCE((SELECT jsonb_agg(jsonb_build_object('bookingId', sp.booking_id, 'toward', sp.toward_stay) ORDER BY sp.paid_at, sp.id)
                       FROM stay_payments sp WHERE sp.pos_transaction_id = t.id), '[]'::jsonb) AS stays,
           COALESCE((SELECT jsonb_agg(jsonb_build_object(
                              'id', r.id, 'day', to_char((r.created_at AT TIME ZONE $3)::date, 'YYYY-MM-DD'),
                              'inMonth', ${inMonth('r.created_at')}, 'net', r.amount - r.card_fee_refunded,
                              'method', r.refund_method) ORDER BY r.created_at, r.id)
                       FROM pos_refunds r WHERE r.transaction_id = t.id AND ${registerRefund('r')}), '[]'::jsonb) AS refunds,
           -- 10/13 (Nic): the words that can name a space (spaceNamedIn).
           COALESCE((SELECT jsonb_agg(i.item_name ORDER BY i.item_name, i.id)
                       FROM pos_transaction_items i WHERE i.transaction_id = t.id), '[]'::jsonb)
             || CASE WHEN NULLIF(TRIM(pl.label), '') IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(pl.label) END AS named,
           COALESCE(t.tenant_id, pl.tenant_id, pc.tenant_id) AS payer_id,
           -- 10/13 (Nic): the sale's own line items, for its breakdown (saleParts).
           COALESCE((SELECT jsonb_agg(jsonb_build_object(
                              'name', i.item_name, 'category', i.item_category, 'qty', i.qty, 'unitPrice', i.unit_price,
                              'subtotal', i.subtotal, 'stayUnit', li.stay_unit, 'taxRate', i.tax_rate) ORDER BY i.item_name, i.id)
                       FROM pos_transaction_items i LEFT JOIN pos_items li ON li.id = i.item_id
                      WHERE i.transaction_id = t.id), '[]'::jsonb) AS lines,
           t.tax_amount::text AS tax,
           CASE WHEN jsonb_typeof(t.tax_breakdown) = 'array' THEN t.tax_breakdown END AS taxes,
           t.discount_amount::text AS discount, t.discount_reason,
           COALESCE(t.surcharge, 0)::text AS card_fee
      FROM pos_transactions t
      LEFT JOIN tenants tt ON tt.id = t.tenant_id
      LEFT JOIN users tu ON tu.id = tt.user_id
      LEFT JOIN pos_customers pc ON pc.id = t.pos_customer_id
      LEFT JOIN pos_pay_links pl ON pl.id = t.pay_link_id
     WHERE t.property_id = $1 AND t.landlord_id = ANY($2::uuid[])
       AND t.status <> 'voided' AND t.payment_method <> 'charge'
       AND (${inMonth('t.created_at')}
            OR EXISTS (SELECT 1 FROM pos_refunds mr
                        WHERE mr.transaction_id = t.id AND ${registerRefund('mr')} AND ${inMonth('mr.created_at')}))
     ORDER BY t.created_at, t.id`, [property.id, landlordIds, tz, month])
  return { ...splitRegisterMoney(sales), sales }
}

/**
 * The stays the open month shows at this property, with this month's money:
 * every stay a guest is checked into now, and every stay paid toward (or
 * refunded from) this month — on the property's own calendar. A stay that
 * became a lease (leases.source_booking_id) is that lease's household: what it
 * carried over is the lease's credit, never a stay row as well. A register
 * sale that was voided paid nothing; a stay put on a charge account paid
 * nothing yet. `registerRefunds`: what went back this month at the register on
 * a sale that paid a stay (registerMoney), by booking.
 *
 * 10/13 (Nic): "Stay rows SHOW what's still owed" (e.g. a $360 balance link
 * still open). `owed`: what is still owed on each of these stays, by the one
 * rule the register and the pay links read (registerStay reservationDue — its
 * price less what was paid toward it; a stay its lease bills, what is left of
 * its deposit; nothing on a canceled stay or a no-show). `due`: of it, what is
 * owed NOW — the balance billed on its pay link (services/stayBalance), or the
 * rest of the stay from its arrival day (S649, Nic: "the other 90% needs to
 * generate on the day they're due to arrive"); a remainder not billed before
 * arrival is not owed yet (as a lease's next month is not). And a stay whose
 * balance was billed and is still unpaid is shown too while its guest is
 * still coming or here, money this month or not — that money is owed here.
 * `today`: the property's today ('YYYY-MM-DD').
 */
async function stayMoney(
  landlordIds: string[], property: RentRollPropertyRef, month: string, today: string,
  registerRefunds: ReadonlyMap<string, OpenMonthStay['refunds']>,
): Promise<{
  bookings: StayBooking[]
  payments: Map<string, RentRollPayment[]>
  refunds: Map<string, OpenMonthStay['refunds']>
  /** Booking id → what is still owed on the stay (dollars). */
  owed: Map<string, number>
  /** Booking id → of it, what is owed now (dollars): billed, or arrival day reached. */
  due: Map<string, number>
}> {
  const tz = property.timezone ?? FALLBACK_TIMEZONE
  const inMonth = (col: string) => `to_char((${col}) AT TIME ZONE $3, 'YYYY-MM') = $4`
  // Money that came in toward a stay: never a voided register sale, never a
  // charge account (collected later, on the account's statement).
  const paidIn = (sp: string, t: string) => `${sp}.method <> 'charge' AND (${t}.id IS NULL OR ${t}.status <> 'voided')`
  // Its balance billed on its pay link (services/stayBalance) and not paid: the
  // link neither paid nor canceled (one that ran out is still money owed), and
  // the guest still coming or here — a stay that is over with nothing paid this
  // month is not on the open month, as a household that moved out is not.
  const balanceOpen = `(b.balance_billed_at IS NOT NULL AND b.balance_paid_at IS NULL
      AND EXISTS (SELECT 1 FROM pos_pay_links bl WHERE bl.id = b.balance_pay_link_id AND bl.status IN ('open', 'expired')))`
  const billedUnpaid = `(${balanceOpen} AND b.status IN ('tentative', 'confirmed', 'checked_in'))`
  const params = [property.id, landlordIds, tz, month, [...registerRefunds.keys()]]
  const bookings = await query<StayBooking>(`
    SELECT b.id, b.unit_id, u.unit_number, b.status, b.tenant_id,
           to_char(b.check_in, 'YYYY-MM-DD') AS check_in, to_char(b.check_out, 'YYYY-MM-DD') AS check_out,
           GREATEST(0, b.check_out - b.check_in)::int AS nights,
           COALESCE(NULLIF(TRIM(b.guest_name), ''), NULLIF(TRIM(CONCAT_WS(' ', gu.first_name, gu.last_name)), '')) AS guest,
           CASE WHEN ${balanceOpen} THEN to_char((b.balance_billed_at AT TIME ZONE $3)::date, 'YYYY-MM-DD') END AS balance_billed_on
      FROM unit_bookings b
      JOIN units u ON u.id = b.unit_id
      LEFT JOIN tenants gt ON gt.id = b.tenant_id
      LEFT JOIN users gu ON gu.id = gt.user_id
     WHERE u.property_id = $1 AND b.landlord_id = ANY($2::uuid[])
       AND NOT EXISTS (SELECT 1 FROM leases sl WHERE sl.source_booking_id = b.id)
       AND (b.status = 'checked_in'
            OR ${billedUnpaid}
            OR b.id = ANY($5::uuid[])
            OR EXISTS (SELECT 1 FROM stay_payments sp
                         LEFT JOIN pos_transactions st ON st.id = sp.pos_transaction_id
                        WHERE sp.booking_id = b.id AND sp.landlord_id = ANY($2::uuid[])
                          AND ${paidIn('sp', 'st')} AND ${inMonth('sp.paid_at')})
            OR EXISTS (SELECT 1 FROM stay_refund_parts rp
                        WHERE rp.booking_id = b.id AND rp.refunded_at IS NOT NULL AND rp.reversed_at IS NULL
                          AND rp.status IN ('refunded', 'handed_back', 'credited') AND ${inMonth('rp.refunded_at')}))
     ORDER BY b.check_in, b.id`, params)
  const payments = new Map<string, RentRollPayment[]>()
  const refunds = new Map<string, OpenMonthStay['refunds']>()
  const owed = new Map<string, number>()
  const due = new Map<string, number>()
  if (!bookings.length) return { bookings, payments, refunds, owed, due }
  const ids = bookings.map(b => b.id)
  // What is still owed on each, by the register's own rule (reservationDue —
  // the one the register's and the pay links' "what is left" read); owed now
  // once billed or from arrival day.
  await Promise.all(bookings.map(async b => {
    const r = await reservationDue(db, b.id)
    const left = r && !r.closed ? dollars(cents(r.owed)) : 0
    owed.set(b.id, left)
    due.set(b.id, b.balance_billed_on || b.check_in <= today ? left : 0)
  }))
  const byId = new Map(bookings.map(b => [b.id, b]))
  for (const r of await query<{
    id: string; booking_id: string; kind: string; method: string; toward_stay: string; paid_on: string
    paid_online: boolean | null; via_link: boolean; balance_link: boolean
  }>(`
    SELECT sp.id, sp.booking_id, sp.kind, sp.method, sp.toward_stay::text AS toward_stay,
           to_char((sp.paid_at AT TIME ZONE $3)::date, 'YYYY-MM-DD') AS paid_on,
           t.paid_online, (t.pay_link_id IS NOT NULL) AS via_link,
           (t.pay_link_id IS NOT NULL AND t.pay_link_id = b.balance_pay_link_id) AS balance_link
      FROM stay_payments sp
      JOIN unit_bookings b ON b.id = sp.booking_id
      LEFT JOIN pos_transactions t ON t.id = sp.pos_transaction_id
     WHERE sp.booking_id = ANY($1::uuid[]) AND sp.landlord_id = ANY($2::uuid[])
       AND ${paidIn('sp', 't')} AND ${inMonth('sp.paid_at')}
     ORDER BY sp.paid_at, sp.created_at, sp.id`, [ids, landlordIds, tz, month])) {
    const b = byId.get(r.booking_id)!
    const list = payments.get(r.booking_id) ?? []
    list.push({
      paymentId: r.id, paidOn: r.paid_on, amount: dollars(cents(r.toward_stay)), credit: 0,
      methodLabel: stayMethodLabel(r), status: 'settled', statusLabel: 'Settled', reference: null,
      forLabel: stayPaymentFor(r, stayDatesText(b.check_in, b.check_out)),
    })
    payments.set(r.booking_id, list)
  }
  for (const r of await query<{ id: string; booking_id: string; toward_amount: string; refunded_on: string; label: string }>(`
    SELECT rp.id, rp.booking_id, rp.toward_amount::text AS toward_amount, rp.label,
           to_char((rp.refunded_at AT TIME ZONE $3)::date, 'YYYY-MM-DD') AS refunded_on
      FROM stay_refund_parts rp
     WHERE rp.booking_id = ANY($1::uuid[]) AND rp.landlord_id = ANY($2::uuid[])
       AND rp.refunded_at IS NOT NULL AND rp.reversed_at IS NULL
       AND rp.status IN ('refunded', 'handed_back', 'credited') AND ${inMonth('rp.refunded_at')}
     ORDER BY rp.refunded_at, rp.seq, rp.id`, [ids, landlordIds, tz, month])) {
    const list = refunds.get(r.booking_id) ?? []
    list.push({ refundId: r.id, refundedOn: r.refunded_on, amount: dollars(cents(r.toward_amount)), label: r.label })
    refunds.set(r.booking_id, list)
  }
  // A refund at the register on the sale that paid the stay (registerMoney).
  for (const id of ids) {
    const back = registerRefunds.get(id)
    if (!back?.length) continue
    const list = [...(refunds.get(id) ?? []), ...back]
    list.sort((a, z) => a.refundedOn.localeCompare(z.refundedOn) || a.refundId.localeCompare(z.refundId))
    refunds.set(id, list)
  }
  return { bookings, payments, refunds, owed, due }
}

/** THE PAYMENTS PAGE: the open month of one property. */
export async function buildOpenMonth(opts: {
  landlordIds: string[]
  property: RentRollPropertyRef
  withTotals: boolean
  /**
   * The viewer may log a payment (take_payment): each row carries the charge
   * the desk window opens on. false — a bookkeeper (10/12, Nic: "never
   * tenant-account actions"), staff without "Take payments" — no row does.
   */
  mayRecord?: boolean
  /**
   * The viewer may see work trade ("View all payments" or the books — routes/
   * balances seesWorkTrade). false — the front desk (10/14, Nic; S641): every
   * row leaves without it (withoutWorkTrade), and no sums ride (they carry it).
   */
  workTrade?: boolean
  /** The day to judge on ('YYYY-MM-DD'); default the property's today. For tests. */
  asOf?: string | null
}): Promise<OpenMonthRoll> {
  const { landlordIds, property } = opts
  const mayRecord = opts.mayRecord !== false
  const showWorkTrade = opts.workTrade !== false
  const month = openMonthOf(property, opts.asOf)
  const asOf = opts.asOf ?? null
  const propertyIds = [property.id]

  // Every space, the active lease that holds it, and — on a space with none —
  // the stay guest checked in there.
  const spaces = await query<{
    unit_id: string; unit_number: string; display_label: string | null; unit_status: string; payment_block: boolean
    lease_id: string | null; stay_checked_in: boolean; stay_guest: string | null; stay_tenant_id: string | null; stay_id: string | null
  }>(`
    SELECT u.id AS unit_id, u.unit_number, u.display_label, u.status AS unit_status, COALESCE(u.payment_block, FALSE) AS payment_block,
           l.id AS lease_id, (st.id IS NOT NULL) AS stay_checked_in, st.guest AS stay_guest, st.tenant_id AS stay_tenant_id,
           st.id AS stay_id
      FROM units u
      LEFT JOIN leases l ON l.unit_id = u.id AND l.status = 'active' AND l.landlord_id = ANY($2::uuid[])
      LEFT JOIN LATERAL (
        SELECT b.id, b.tenant_id,
               COALESCE(NULLIF(TRIM(b.guest_name), ''), NULLIF(TRIM(CONCAT_WS(' ', gu.first_name, gu.last_name)), '')) AS guest
          FROM unit_bookings b
          LEFT JOIN tenants gt ON gt.id = b.tenant_id
          LEFT JOIN users gu ON gu.id = gt.user_id
         WHERE b.unit_id = u.id AND b.status = 'checked_in' AND b.landlord_id = ANY($2::uuid[])
         ORDER BY b.check_in DESC, b.id LIMIT 1) st ON l.id IS NULL
     WHERE u.property_id = $1 AND (u.retired_at IS NULL OR l.id IS NOT NULL)`, [property.id, landlordIds])
  const blocked = new Map(spaces.map(s => [s.unit_id, s.payment_block === true]))

  const scope = { landlordIds, propertyIds, from: month, through: month, asOf, byLease: true }
  const [months, lines, ledger, earlier, anchors, { register, stays }] = await Promise.all([
    householdMonths(scope),
    householdLines(scope),
    listPaymentsByMonth({ landlordIds, propertyIds, month, withTotals: false }),
    householdMonths({ ...scope, from: ALL_TIME_FROM, through: addMonths(month, -1) }),
    mayRecord ? deskAnchors(landlordIds, property.id) : Promise.resolve(new Map<string, string>()),
    // 10/13 (Nic): "show ALL money coming in" — the register's and the pay
    // links' money first (a refund there can be a stay's), then the stays.
    registerMoney(landlordIds, property, month)
      .then(async register => ({
        register, stays: await stayMoney(landlordIds, property, month, asOf ?? todayIn(property.timezone), register.stayRefunds),
      })),
  ])

  interface Building {
    key: string; unitId: string | null; space: string | null; leaseId: string | null; householdId: string | null
    /** A row of the space itself: nobody on a lease — empty, or in use (inUse). */
    spaceOnly: boolean
    inUse: { label: string; occupant: string | null } | null
    stayTenantId: string | null
    movedOut: boolean; evictionMode: boolean
    /** On the page only for what it still owes on earlier months here. */
    earlierOnly: boolean
    month?: HouseholdMonth; charges: ChargeLine[]
    /** A stay guest's row: the stay, this month's money toward it, what is still owed on it, and of that what is owed now. */
    stay?: { booking: StayBooking; payments: RentRollPayment[]; refunds: OpenMonthStay['refunds']; owed: number; due: number }
  }
  const rows = new Map<string, Building>()
  // 10/13 (Nic): a stay guest's row. The guest checked in on a space no lease
  // holds IS that space's row (the space is not empty, and the money is
  // theirs); a stay paid this month whose guest has left, or has yet to
  // arrive, is a row at its space beside whatever is there now — and so
  // (round 3: "Stay rows SHOW what's still owed") is one still owing on it.
  const stayRowAt = new Set<string>()
  for (const booking of stays.bookings) {
    const key = `stay:${booking.id}`
    const pays = stays.payments.get(booking.id) ?? []
    const backs = stays.refunds.get(booking.id) ?? []
    const owedOnStay = stays.owed.get(booking.id) ?? 0
    const here = spaces.find(s => s.unit_id === booking.unit_id)
    // Checked in on a space a lease holds: the lease's household is the row.
    if (booking.status === 'checked_in' && here?.lease_id && !pays.length && !backs.length && cents(owedOnStay) <= 0) continue
    if (booking.status === 'checked_in' && here && !here.lease_id && here.stay_id === booking.id) stayRowAt.add(here.unit_id)
    rows.set(key, {
      key, unitId: booking.unit_id, space: booking.unit_number, leaseId: null, householdId: null,
      spaceOnly: false, inUse: null, stayTenantId: booking.tenant_id,
      movedOut: false, evictionMode: blocked.get(booking.unit_id) === true,
      earlierOnly: false, charges: [], stay: { booking, payments: pays, refunds: backs, owed: owedOnStay, due: stays.due.get(booking.id) ?? 0 },
    })
  }
  for (const s of spaces) {
    // The space's checked-in guest is their stay row (above).
    if (stayRowAt.has(s.unit_id)) continue
    const inUse = s.lease_id ? null : spaceInUse(s)
    const key = s.lease_id ? householdKey(s.lease_id, '') : `${inUse ? 'space' : 'vacant'}:${s.unit_id}`
    if (rows.has(key)) continue
    rows.set(key, {
      key, unitId: s.unit_id, space: s.unit_number, leaseId: s.lease_id, householdId: null,
      spaceOnly: !s.lease_id, inUse, stayTenantId: s.lease_id ? null : s.stay_tenant_id,
      movedOut: false, evictionMode: s.payment_block === true,
      earlierOnly: false, charges: [],
    })
  }
  // Anyone else billed here this month: a lease that ended this month, or a
  // charge on no lease. Their space is the one billed.
  for (const m of months) {
    const key = householdKey(m.lease_id, m.household_id)
    const b = rows.get(key)
    if (b) { b.month = m; b.householdId = b.householdId ?? m.household_id; continue }
    rows.set(key, {
      key, unitId: null, space: [...m.units].sort(compareSpaces)[0] ?? null, leaseId: m.lease_id, householdId: m.household_id,
      spaceOnly: false, inUse: null, stayTenantId: null, movedOut: false, evictionMode: false,
      earlierOnly: false, month: m, charges: [],
    })
  }
  for (const l of lines) rows.get(householdKey(l.lease_id, l.household_id))?.charges.push(l)

  // 10/13 (Nic): "outstanding balances are always at the top of this list" —
  // what a household still owes here on EARLIER months is beside the month
  // (owedEarlier), and a household owing here with no bill this month is a row
  // too (a move to another space here leaves the old lease's balance on that
  // lease). Someone who no longer lives here is the Rent Roll's "Moved out,
  // still owes" folder instead (dropped below, once the leases are read).
  // 10/13 (Nic): "Delinquent" beside the name — an earlier month here still
  // owed past its grace period counts (delinquentEarlier).
  const owedEarlier = new Map<string, number>()
  const owingEarlier = new Map<string, HouseholdMonth>()
  const delinquentEarlier = new Set<string>()
  for (const m of earlier) {
    const key = householdKey(m.lease_id, m.household_id)
    owedEarlier.set(key, (owedEarlier.get(key) ?? 0) + cents(m.owed))
    const last = owingEarlier.get(key)
    if (cents(m.owed) > 0 && (!last || m.month > last.month)) owingEarlier.set(key, m)
    if (owesPastGrace([m])) delinquentEarlier.add(key)
  }
  for (const [key, m] of owingEarlier) {
    if (rows.has(key)) continue
    rows.set(key, {
      key, unitId: null, space: [...m.units].sort(compareSpaces)[0] ?? null, leaseId: m.lease_id, householdId: m.household_id,
      spaceOnly: false, inUse: null, stayTenantId: null, movedOut: false, evictionMode: false,
      earlierOnly: true, charges: [],
    })
  }
  // A stay guest whose charges here are a row of their own is that row, not
  // the space's row as well — nor a stay row with no money on it this month
  // and nothing owed on the stay.
  for (const b of [...rows.values()]) {
    const bare = b.spaceOnly
      || (!!b.stay && !b.stay.payments.length && !b.stay.refunds.length && cents(b.stay.owed) <= 0)
    if (bare && b.stayTenantId && rows.has(householdKey(null, b.stayTenantId))) rows.delete(b.key)
  }

  const leaseIds = [...rows.values()].map(b => b.leaseId).filter((x): x is string => !!x)
  const facts = await leaseFacts(leaseIds, property.id)
  // 10/14 (Nic): "show in the moved-out section of Payments" — a household no
  // longer living here, owing only on earlier months, is that section's.
  const movedOutHouseholds: Array<{ key: string; leaseId: string; householdId: string | null; space: string; leftOn: string | null }> = []
  for (const b of [...rows.values()]) {
    if (!b.leaseId) continue
    const f = facts.get(b.leaseId)
    if (!f) continue
    b.householdId = f.household_id ?? b.householdId
    b.movedOut = f.status !== 'active' && !f.lives_here && f.status !== 'pending'
    if (b.earlierOnly && b.movedOut) {
      movedOutHouseholds.push({ key: b.key, leaseId: b.leaseId, householdId: b.householdId, space: f.unit_number, leftOn: f.ended_on ?? null })
      rows.delete(b.key)
      continue
    }
    if (b.earlierOnly) { b.space = f.unit_number; b.unitId = f.unit_id }
    if (!b.unitId && f.unit_number === b.space) b.unitId = f.unit_id
    // Eviction mode is the space's: a household's row there says so too.
    if (b.unitId) b.evictionMode = b.evictionMode || blocked.get(b.unitId) === true
  }
  const personIds = [...rows.values()].filter(b => !b.leaseId && !b.spaceOnly && !b.stay && b.householdId).map(b => b.householdId!)
  const { byLease, byPerson } = await residentsOf(leaseIds, personIds)

  // Each payment's part on each row (the expanded row, the method column).
  const keyOfCharge = new Map(lines.map(l => [l.payment_id, householdKey(l.lease_id, l.household_id)]))
  const keyOfPerson = new Map<string, string>()
  for (const b of rows.values()) {
    if (b.spaceOnly || b.stay) continue
    const people = b.leaseId ? byLease.get(b.leaseId) ?? [] : byPerson.get(b.householdId ?? '') ?? []
    for (const r of people) if (!keyOfPerson.has(r.tenantId) && !b.movedOut) keyOfPerson.set(r.tenantId, b.key)
  }
  const paymentsOf = paymentsByHousehold(ledger.payments, keyOfCharge, keyOfPerson)

  // 10/13 (Nic): "Pay links / register sales that name a space go ON that
  // space's row … only money with no space stays in the folder." A sale whose
  // words name one of this property's spaces (spaceNamedIn) is on the row of
  // that space — the stay it paid toward there, else the row of the person who
  // paid, else the household on the space's lease, else the guest checked in,
  // else the space's own row; its refunds at the register go with it.
  const spaceNames = spaces.map(s => ({ unitId: s.unit_id, names: [s.unit_number, s.display_label] }))
  const numberOf = new Map(spaces.map(s => [s.unit_id, s.unit_number]))
  const peopleOf = (b: Building): string[] => b.stay ? [b.stay.booking.tenant_id].filter((x): x is string => !!x)
    : b.spaceOnly ? [b.stayTenantId].filter((x): x is string => !!x)
    : (b.leaseId ? byLease.get(b.leaseId) ?? [] : byPerson.get(b.householdId ?? '') ?? []).map(r => r.tenantId)
  const rowAt = (unitId: string, s: RegisterSale): Building | undefined => {
    const at = [...rows.values()].filter(b => b.unitId === unitId || (!b.unitId && b.space === numberOf.get(unitId)))
    return at.find(b => !!b.stay && (s.stays ?? []).some(x => x.bookingId === b.stay!.booking.id))
      ?? (s.payer_id ? at.find(b => peopleOf(b).includes(s.payer_id!)) : undefined)
      ?? at.find(b => !!b.leaseId && !b.movedOut && !b.earlierOnly)
      ?? at.find(b => !!b.stay && b.stay.booking.status === 'checked_in')
      ?? at.find(b => b.spaceOnly)
      ?? at[0]
  }
  const saleRow = new Map<string, string>()
  for (const s of register.sales) {
    const unitId = spaceNamedIn(s.named ?? [], spaceNames)
    const pick = unitId ? rowAt(unitId, s) : undefined
    if (pick) saleRow.set(s.id, pick.key)
  }
  const saleOf = new Map(register.sales.map(s => [s.id, s]))
  const atRow = new Map<string, OpenMonthOtherMoney[]>()
  const putAt = (key: string, x: OpenMonthOtherMoney) => atRow.set(key, [...(atRow.get(key) ?? []), x])
  const folder: OpenMonthOtherMoney[] = []
  for (const x of register.other) {
    const key = saleRow.get(x.saleId)
    if (key) { putAt(key, x); continue }
    // 10/14 (Nic): "A sale naming two spaces … split it between the two
    // rows" — by its own lines (splitSaleBySpace); what names no one space
    // stays in the folder.
    const s = saleOf.get(x.saleId)
    const split = s ? splitSaleBySpace(x, s, spaceNames) : null
    const placed = split?.pieces.map(p => ({ key: rowAt(p.unitId, s!)?.key, line: p.line }))
    if (split && placed && placed.every(p => !!p.key)) {
      for (const p of placed) putAt(p.key!, p.line)
      if (split.rest) folder.push(split.rest)
      continue
    }
    folder.push(x)
  }
  /** A row's own register money (OpenMonthRow.otherMoney, otherIn, otherRefunded). */
  const registerOf = (key: string) => {
    const list = atRow.get(key) ?? []
    const sum = (kind: OpenMonthOtherMoney['kind']) => dollars(list.filter(x => x.kind === kind).reduce((t, x) => t + cents(x.amount), 0))
    return { otherMoney: list, otherIn: sum('sale'), otherRefunded: sum('refund') }
  }

  const out: OpenMonthRow[] = []
  const totals: OpenMonthTotals = {
    ...zeroTotals(), owedEarlier: 0, stays: 0, staysRefunded: 0, staysOwed: 0,
    otherIn: 0, otherRefunded: 0, folderIn: 0, folderRefunded: 0,
  }
  for (const b of rows.values()) {
    if (b.stay) {
      const row: OpenMonthRow = { ...stayRow(b, b.stay), ...registerOf(b.key) }
      totals.stays = dollars(cents(totals.stays) + cents(row.paid))
      totals.staysRefunded = dollars(cents(totals.staysRefunded) + cents(row.stay!.refunded))
      totals.staysOwed = dollars(cents(totals.staysOwed) + cents(row.owed))
      out.push(row)
      continue
    }
    const m = b.month
    const money = m ? sumMonths([m]) : { ...zeroTotals(), clearing: 0 }
    const payments = b.spaceOnly ? [] : (paymentsOf.get(b.key) ?? [])
    // By due date, late fees last, by what it is for; two lines for the same
    // thing (a bill paid in part) the paid part first, then what is still
    // owed — one order every time, never the database's.
    const charges = [...b.charges].sort((a, z) => a.due_date.localeCompare(z.due_date)
      || Number(a.is_late_fee) - Number(z.is_late_fee) || a.label.localeCompare(z.label)
      || Number(cents(a.owed) > 0) - Number(cents(z.owed) > 0) || a.payment_id.localeCompare(z.payment_id))
    const base = charges.filter(l => BASE_TYPES.has(l.type))
    const dueDate = (base[0] ?? charges[0])?.due_date ?? null
    const status: RentRollRowStatus = b.spaceOnly ? (b.inUse ? 'occupied' : 'vacant')
      : rentRollStatusOf(m?.stamp ?? null, m?.days_past_grace ?? 0)
    const days = m?.days_past_grace ?? 0
    const residents = b.spaceOnly ? [] : b.leaseId ? (byLease.get(b.leaseId) ?? []) : (byPerson.get(b.householdId ?? '') ?? [])
    const shown = pill(status, status === 'paid_late' || status === 'owes' ? days : 0, dueDate)
    const row: OpenMonthRow = {
      key: b.key,
      unitId: b.unitId,
      space: b.space,
      leaseId: b.leaseId,
      householdId: b.spaceOnly ? null : (b.householdId ?? residents.find(r => r.primary)?.tenantId ?? null),
      residents,
      occupant: b.inUse?.occupant ?? null,
      movedOut: b.movedOut,
      invoiced: money.invoiced,
      lateFees: money.lateFees,
      paid: money.paid,
      clearing: money.clearing,
      credit: money.credit,
      workTrade: money.workTrade,
      owed: money.owed,
      owedEarlier: b.spaceOnly ? 0 : dollars(owedEarlier.get(b.key) ?? 0),
      methods: methodsOf(payments, money.workTrade),
      ...shown,
      // An occupied space says what is there ("Owner Use", "Checked in").
      statusLabel: b.inUse?.label ?? shown.statusLabel,
      daysPastGrace: status === 'paid_late' || status === 'owes' ? days : 0,
      dueDate,
      workTradeOnly: m?.work_trade_only ?? false,
      evictionMode: b.evictionMode,
      // 10/13 (Nic): the red "Delinquent" tag — past grace with money still
      // owed here, this month or an earlier one (OpenMonthRow.delinquent; the
      // one rule, householdMonths owesPastGrace — the tenant report's too).
      delinquent: !b.spaceOnly && (owesPastGrace(m ? [m] : []) || delinquentEarlier.has(b.key)),
      // 10/13 (Nic): "we have eviction mode that blocks payments" — no desk
      // window on a blocked space (deskAnchors leaves its charges out), and
      // none for a viewer who may not log a payment (mayRecord).
      recordWith: !mayRecord || b.spaceOnly || b.evictionMode ? null : (anchors.get(b.key) ?? null),
      payments,
      charges: charges.map(chargeWire),
      stay: null,
      ...registerOf(b.key),
    }
    if (!b.spaceOnly) {
      addTotals(totals, row)
      totals.owedEarlier = dollars(cents(totals.owedEarlier) + cents(row.owedEarlier))
    }
    out.push(row)
  }
  out.sort(compareOpenMonthRows)
  // 10/13 (Nic): "show ALL money coming in" — the register's and the pay
  // links' money that is no household's bill and no stay's, its own sums:
  // all of it (on the rows of the spaces it names, or in the folder), and of
  // it the folder's.
  const addTo = (x: OpenMonthOtherMoney, inKey: 'otherIn' | 'folderIn', backKey: 'otherRefunded' | 'folderRefunded') => {
    if (x.kind === 'sale') totals[inKey] = dollars(cents(totals[inKey]) + cents(x.amount))
    else totals[backKey] = dollars(cents(totals[backKey]) + cents(x.amount))
  }
  for (const x of register.other) addTo(x, 'otherIn', 'otherRefunded')
  for (const x of folder) addTo(x, 'folderIn', 'folderRefunded')
  // 10/14 (Nic): "A checked-out guest still owing, nothing paid this month:
  // show in the moved-out section of Payments" — with every household no
  // longer living here still owing on earlier months, in space order.
  const movedOutOwing: OpenMonthMovedOut[] = [
    ...movedOutHouseholds.map((h): OpenMonthMovedOut => ({
      key: h.key, kind: 'household', space: h.space, leaseId: h.leaseId, householdId: h.householdId,
      residents: byLease.get(h.leaseId) ?? [], guest: null, leftOn: h.leftOn, stayDates: null,
      owed: dollars(owedEarlier.get(h.key) ?? 0),
      months: earlier.filter(m => householdKey(m.lease_id, m.household_id) === h.key && cents(m.owed) > 0)
        .sort((a, z) => a.month.localeCompare(z.month)).map(m => ({ month: m.month, owed: m.owed })),
    })),
    ...(await checkedOutStillOwing(landlordIds, property, new Set(stays.bookings.map(b => b.id)))),
  ].filter(m => cents(m.owed) > 0)
    .sort((a, z) => compareSpaces(a.space, z.space) || (a.leftOn ?? '').localeCompare(z.leftOn ?? '') || a.key.localeCompare(z.key))
  totals.movedOutOwed = dollars(movedOutOwing.reduce((t, m) => t + cents(m.owed), 0))
  const roll: OpenMonthRoll = {
    propertyId: property.id, propertyName: property.name, month,
    rows: showWorkTrade ? out : out.map(withoutWorkTrade), otherMoney: folder, movedOutOwing,
  }
  if (opts.withTotals && showWorkTrade) roll.totals = totals
  return roll
}

/**
 * 10/14 (Nic) — a row as the front desk gets it. S641 (Nic): "I don't want her
 * to see the covered by work trade." For a viewer who may not see work trade
 * the row leaves the server without it, the way GET /balances/:tenantId/
 * invoices leaves it out: no work-trade amount, no "Work trade" in the methods,
 * and the charges the hours covered are not on it — a line covered in full is
 * gone, one covered in part shows what was left of it — so Invoiced = Paid +
 * Owed still reads on the row, and what is owed (never work trade) is the
 * same. A row with no work trade comes back as it was.
 */
export function withoutWorkTrade(row: OpenMonthRow): OpenMonthRow {
  const covered = cents(row.workTrade) > 0 || row.workTradeOnly
    || row.methods.includes(WORK_TRADE_MARKER_LABEL) || row.charges.some(c => cents(c.workTrade) > 0)
  if (!covered) return row
  const charges: RentRollCharge[] = []
  for (const c of row.charges) {
    const wt = cents(c.workTrade)
    if (wt <= 0) { charges.push(c); continue }
    const left = cents(c.invoiced) - wt
    if (left <= 0) continue
    // "Work trade" is how such a line reads paid; the money's own way is not
    // on the line, so it says none.
    charges.push({ ...c, invoiced: dollars(left), workTrade: 0, howPaid: c.howPaid === WORK_TRADE_MARKER_LABEL ? null : c.howPaid })
  }
  return {
    ...row,
    invoiced: dollars(Math.max(0, cents(row.invoiced) - cents(row.workTrade))),
    workTrade: 0,
    workTradeOnly: false,
    methods: row.methods.filter(m => m !== WORK_TRADE_MARKER_LABEL),
    charges,
  }
}

/**
 * 10/14 (Nic): "A checked-out guest still owing, nothing paid this month:
 * show in the moved-out section of Payments." Every stay at the property whose
 * guest checked out with money still owed on it — by the register's own rule
 * (registerStay reservationDue: its price less what was paid toward it; a stay
 * its lease bills is that lease's) — that is not a stay row this month (`rows`:
 * the stays the month shows — one paid toward this month is a row, its Owed
 * already said). A stay whose balance link was canceled is not owed here, as
 * on its row (stayMoney).
 */
async function checkedOutStillOwing(
  landlordIds: string[], property: RentRollPropertyRef, rows: ReadonlySet<string>,
): Promise<OpenMonthMovedOut[]> {
  const left = await query<{ id: string; unit_number: string; check_in: string; check_out: string; guest: string | null }>(`
    SELECT b.id, u.unit_number, to_char(b.check_in, 'YYYY-MM-DD') AS check_in, to_char(b.check_out, 'YYYY-MM-DD') AS check_out,
           COALESCE(NULLIF(TRIM(b.guest_name), ''), NULLIF(TRIM(CONCAT_WS(' ', gu.first_name, gu.last_name)), '')) AS guest
      FROM unit_bookings b
      JOIN units u ON u.id = b.unit_id
      LEFT JOIN tenants gt ON gt.id = b.tenant_id
      LEFT JOIN users gu ON gu.id = gt.user_id
     WHERE u.property_id = $1 AND b.landlord_id = ANY($2::uuid[])
       AND b.status = 'checked_out' AND COALESCE(b.total_amount, 0) > 0 AND b.balance_paid_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM leases sl WHERE sl.source_booking_id = b.id)
       AND NOT EXISTS (SELECT 1 FROM pos_pay_links bl WHERE bl.id = b.balance_pay_link_id AND bl.status = 'cancelled')
     ORDER BY b.check_out, b.id`, [property.id, landlordIds])
  const out: OpenMonthMovedOut[] = []
  for (const b of left) {
    if (rows.has(b.id)) continue
    const r = await reservationDue(db, b.id)
    const owed = r && !r.closed ? dollars(cents(r.owed)) : 0
    if (cents(owed) <= 0) continue
    out.push({
      key: `stay:${b.id}`, kind: 'stay', space: b.unit_number, leaseId: null, householdId: null, residents: [],
      guest: b.guest, leftOn: b.check_out, stayDates: stayDatesText(b.check_in, b.check_out), owed, months: [],
    })
  }
  return out
}

/**
 * A stay guest's row (10/13, Nic: "details of the money that was paid"): what
 * came in toward the stay this month — the Paid column, the payment methods,
 * each payment opened underneath (day, amount, how, what for) and anything
 * given back this month. No bill: Invoiced stays empty; its words are the
 * booking's ("Checked in"). 10/13 (Nic), round 3: "Stay rows SHOW what's
 * still owed" — the opened row says all that is still owed on the stay
 * (OpenMonthStay.owed, stayMoney `owed`); Owed is what of it is owed now
 * (stayMoney `due`: billed, or from arrival day), and a stay owing now sits at
 * the top with everyone else owing here.
 */
function stayRow(
  b: { key: string; unitId: string | null; space: string | null; evictionMode: boolean },
  s: { booking: StayBooking; payments: RentRollPayment[]; refunds: OpenMonthStay['refunds']; owed: number; due: number },
): OpenMonthRow {
  const paid = dollars(s.payments.reduce((t, p) => t + cents(p.amount), 0))
  const refunded = dollars(s.refunds.reduce((t, r) => t + cents(r.amount), 0))
  const owed = dollars(Math.max(0, cents(s.owed)))
  const due = dollars(Math.min(cents(owed), Math.max(0, cents(s.due))))
  const label = BOOKING_STATUS_LABEL[s.booking.status as BookingStatus] ?? RENT_ROLL_STATUS_LABEL.stay
  return {
    key: b.key, unitId: b.unitId, space: b.space, leaseId: null, householdId: null, residents: [],
    occupant: s.booking.guest, movedOut: false,
    invoiced: 0, lateFees: 0, paid, clearing: 0, credit: 0, workTrade: 0, owed: due, owedEarlier: 0,
    methods: methodsOf(s.payments, 0),
    ...pill('stay', 0, null),
    statusLabel: label,
    daysPastGrace: 0, dueDate: null, workTradeOnly: false, evictionMode: b.evictionMode, delinquent: false,
    recordWith: null,
    payments: s.payments,
    charges: [],
    stay: {
      bookingId: s.booking.id, checkIn: s.booking.check_in, checkOut: s.booking.check_out, nights: s.booking.nights,
      statusLabel: label, owed, balanceBilledOn: cents(owed) > 0 ? s.booking.balance_billed_on : null, refunded, refunds: s.refunds,
    },
    otherMoney: [], otherIn: 0, otherRefunded: 0,
  }
}

// ─── The history (the Rent Roll page) ────────────────────────────────────────

/** One month's stamp on a history row (no bill that month: 'none'). */
export function stampWire(month: string, m: HouseholdMonth | undefined): RentRollStamp {
  const status = rentRollStatusOf(m?.stamp ?? null, m?.days_past_grace ?? 0)
  const days = status === 'paid_late' || status === 'owes' ? (m?.days_past_grace ?? 0) : 0
  return {
    month, ...pill(status, days, null), daysPastGrace: days,
    invoiced: m?.charged ?? 0, paid: m ? dollars(cents(m.paid) + cents(m.credit)) : 0, credit: m?.credit ?? 0,
    workTrade: m?.work_trade ?? 0, owed: m?.owed ?? 0,
    onboarding: m?.onboarding ?? false,
  }
}

/**
 * How many households earned each status each month ("Oct: 3 late") — 'none'
 * is not counted. The history passes its rows and (10/13, Nic: "Rent Roll
 * month counts INCLUDE the moved-out folder") its folder households' stamps.
 */
export function monthCounts(months: readonly string[], rows: readonly Pick<RentRollHistoryRow, 'stamps'>[]): RentRollMonthCount[] {
  const counted = RENT_ROLL_MONTH_STATUSES.filter(s => s !== 'none')
  return months.map(month => ({
    month,
    counts: counted.map(status => ({
      status, label: RENT_ROLL_STATUS_LABEL[status],
      households: rows.filter(r => r.stamps.find(s => s.month === month)?.status === status).length,
    })),
  }))
}

export class RentRollRangeError extends Error {}

// ─── Stays on the Rent Roll (10/13, Nic) ─────────────────────────────────────
//
//   "show stays as an aggregate by line items. eg 22 nights paid for via pos
//    and 1 week paid for via pos. otherwise when people use the same sites
//    over again in a month it will look funny on the report. dont put these
//    stays in the spot put them below with expandable notes. 4 nights in 15
//    and 8 nights in 18 etc."
//
// A stay on the schedule is its own line items: the length it was sold for
// (its booked nights; a weekly stay of whole weeks in weeks, a month stay of
// whole calendar months in months — bookingLineItems). Never the quantity on
// a sale's line: the register, a reservation ticket and a pay link record a
// stay as ONE line at the whole stay's price (routes/pos-stays.test,
// decisions #9 — "RV site — night — 3 nights at site RV 01" is quantity 1),
// and a stay rung at the counter is booked as what its item buys
// (registerStay bookingLeaseTypeFor), so 3 nights rung is 3 nights booked.
//
// 10/14 (Nic): "A month stay lengthened with 'Add a month': each month counts
// only its own nights." A stay is the range's by its NIGHTS, never by the
// month money came in: all of it in the range is its whole sold length, once
// however many payments it took ("1 month"); a stay the range cuts counts only
// its nights in the range (Sep 1 – Nov 1: 30 nights in September, 31 in
// October — stayInRange). Its money rides with its nights: what the property
// kept on it — every payment toward it (never a voided sale, never a charge
// account: nothing came in yet), less every refund (10/14, Nic: "subtract
// refunds (early check-out)" — its early check-out's parts and a refund at the
// register on a sale that paid it, splitRegisterMoney's rule) — shared over
// the nights it was sold for, to the cent, as GAM Books earns a stay
// (ledgerProjectors/bookingStay). 10/14 (Nic): a stay that checked out early
// with nights refunded counts the nights ACTUALLY STAYED ("booked 7, stayed 3,
// refunded 4 → 3 nights"), its money after the refund shared over them — its
// length is check-in to the day it checked out, not the length sold. One that
// checked out early with nothing given back still counts the length it paid
// for. So a month paid late is in its own month,
// as a bill paid late is on the Rent Roll. A stay nothing was kept on is no
// line. It reads "via POS" when any of its money was rung on a stay item at
// the register or on a pay link, or when it was not booked on the booking
// site; "via the booking site" otherwise. A stay that became a lease is that
// lease's (its row), never a stay as well. Its site is the stay's own space.
//
// Only a stay item sold with no stay on the schedule has no nights to place:
// it is the month it was sold, counted by its line — what one of it buys
// (pos_items.stay_unit) × its quantity, its money the line's less what went
// back on the sale beyond its other items — at the space its sale names
// (spaceNamedIn), else "no site named".

/** One sold piece of a stay, before it is added up. */
export interface StayPiece {
  unit: RentRollStayUnit
  via: RentRollStayVia
  quantity: number
  /** Cents the property kept for it in the range (10/14: its share by its nights in the range, refunds off). */
  paidCents: number
  space: string | null
  /** The stay it is part of ('booking:<id>'), or the sale when it is no stay on the schedule ('sale:<id>'). */
  stay: string
}

/**
 * A stay on the schedule, in line items: whole calendar months for a month
 * stay ("1 month" Oct 4 → Nov 4), whole weeks for a weekly stay of whole
 * weeks, else its nights — the length it was sold for (soldCheckOutSql).
 */
export function bookingLineItems(b: { lease_type: string; check_in: string; booked_check_out: string }): {
  unit: RentRollStayUnit; quantity: number
} {
  const nights = Math.max(0, stayNightsBetween(b.check_in, b.booked_check_out))
  if (['month_to_month', 'long_term', 'lease_hold'].includes(b.lease_type)) {
    for (let k = 1; k <= 60; k++) {
      const end = addCalendarMonths(b.check_in, k)
      if (end === b.booked_check_out) return { unit: 'month', quantity: k }
      if (end > b.booked_check_out) break
    }
  }
  if (b.lease_type === 'weekly' && nights > 0 && nights % 7 === 0) return { unit: 'week', quantity: nights / 7 }
  return { unit: 'night', quantity: nights }
}

/**
 * The pieces added up into the page's lines (RentRollStayLine): one per kind
 * of line item and how it was paid for — nights, weeks, months; POS, then the
 * booking site — each with its notes per site in space order. `withMoney`:
 * the money rides only with the range totals (decisions #25).
 */
export function stayLinesOf(pieces: readonly StayPiece[], withMoney: boolean): RentRollStayLine[] {
  const lines = new Map<string, {
    unit: RentRollStayUnit; via: RentRollStayVia; quantity: number; paidCents: number; stays: Set<string>
    sites: Map<string, { space: string | null; quantity: number; stays: Set<string> }>
  }>()
  for (const p of pieces) {
    const key = `${p.unit}:${p.via}`
    const line = lines.get(key) ?? { unit: p.unit, via: p.via, quantity: 0, paidCents: 0, stays: new Set<string>(), sites: new Map() }
    line.quantity += p.quantity
    line.paidCents += p.paidCents
    line.stays.add(p.stay)
    const site = line.sites.get(p.space ?? '') ?? { space: p.space, quantity: 0, stays: new Set<string>() }
    site.quantity += p.quantity
    site.stays.add(p.stay)
    line.sites.set(p.space ?? '', site)
    lines.set(key, line)
  }
  const round = (q: number) => Math.round(q * 1000) / 1000
  return [...lines.entries()]
    .sort(([, a], [, z]) => RENT_ROLL_STAY_UNITS.indexOf(a.unit) - RENT_ROLL_STAY_UNITS.indexOf(z.unit)
      || RENT_ROLL_STAY_VIAS.indexOf(a.via) - RENT_ROLL_STAY_VIAS.indexOf(z.via))
    .map(([key, l]) => {
      const out: RentRollStayLine = {
        key, unit: l.unit, via: l.via, quantity: round(l.quantity),
        label: `${stayQuantityText(l.quantity, l.unit)} paid for via ${RENT_ROLL_STAY_VIA_LABEL[l.via]}`,
        stays: l.stays.size,
        sites: [...l.sites.values()]
          .sort((a, z) => compareSpaces(a.space, z.space))
          .map(s => ({
            space: s.space, quantity: round(s.quantity), stays: s.stays.size,
            label: s.space ? `${stayQuantityText(s.quantity, l.unit)} in ${s.space}` : `${stayQuantityText(s.quantity, l.unit)}, no site named`,
          })),
      }
      if (withMoney) out.paid = dollars(l.paidCents)
      return out
    })
}

/**
 * 10/14 (Nic): "each month counts only its own nights." A stay on the
 * schedule in a range of days — `start` its first, `end` the day after its
 * last ('YYYY-MM-DD'): all of it in the range, its whole sold length in line
 * items (bookingLineItems); a part, only its nights in the range. `keptCents`
 * (what the property kept on it) is shared over the nights sold, to the cent —
 * shares of the same stay in ranges side by side add up to all of it. null:
 * none of its nights is in the range (a stay of no nights is the day it
 * began). Pure.
 */
export function stayInRange(
  b: { lease_type: string; check_in: string; booked_check_out: string }, keptCents: number, start: string, end: string,
): { unit: RentRollStayUnit; quantity: number; paidCents: number } | null {
  const sold = Math.max(0, stayNightsBetween(b.check_in, b.booked_check_out))
  if (sold === 0) return b.check_in >= start && b.check_in < end ? { unit: 'night', quantity: 0, paidCents: keptCents } : null
  const from = b.check_in > start ? b.check_in : start
  const to = b.booked_check_out < end ? b.booked_check_out : end
  const nights = stayNightsBetween(from, to)
  if (nights <= 0) return null
  const before = stayNightsBetween(b.check_in, from)
  const upTo = (n: number) => Math.round((keptCents * n) / sold)
  const paidCents = upTo(before + nights) - upTo(before)
  if (nights === sold) return { ...bookingLineItems(b), paidCents }
  return { unit: 'night', quantity: nights, paidCents }
}

/**
 * The range's stays at a property, as the Rent Roll shows them below its rows
 * (see above). `from`/`to` are bill months ('YYYY-MM', the property's
 * calendar); `lastDay` is a bookkeeper's clean cut at a sale (no night, and no
 * sale, after it), null for everyone else.
 */
export async function rentRollStays(opts: {
  landlordIds: string[]; property: Pick<RentRollPropertyRef, 'id' | 'timezone'>; from: string; to: string
  lastDay?: string | null; withMoney: boolean
}): Promise<RentRollStayLine[]> {
  const { landlordIds, property } = opts
  if (!landlordIds.length) return []
  const tz = property.timezone ?? FALLBACK_TIMEZONE
  // The range's days: its first, and the day after its last (a bookkeeper's cut ends it sooner).
  const start = `${opts.from}-01`
  const afterRange = `${addMonths(opts.to, 1)}-01`
  const end = opts.lastDay && addStayDays(opts.lastDay, 1) < afterRange ? addStayDays(opts.lastDay, 1) : afterRange
  // A sale that carries a stay item's line (the register, a reservation ticket, a pay link).
  const hasStayLine = (t: string) => `EXISTS (SELECT 1 FROM pos_transaction_items hi JOIN pos_items hp ON hp.id = hi.item_id
                                               WHERE hi.transaction_id = ${t} AND hp.stay_unit IS NOT NULL)`
  // Every stay on the schedule paid for (money in toward it, ever) whose
  // nights sold reach into the range: its own site, all its money (a sale
  // that paid two stays is a part of each).
  const booked = await query<{
    booking_id: string; space: string; lease_type: string; check_in: string; booked_check_out: string
    check_out: string; checked_out: boolean; toward: string; booked_online: boolean; by_stay_line: boolean
  }>(`
    SELECT b.id AS booking_id, u.unit_number AS space, b.lease_type,
           to_char(b.check_in, 'YYYY-MM-DD') AS check_in, to_char(${soldCheckOutSql('b')}, 'YYYY-MM-DD') AS booked_check_out,
           to_char(b.check_out, 'YYYY-MM-DD') AS check_out, (b.status = 'checked_out') AS checked_out,
           SUM(s.toward_stay)::text AS toward,
           EXISTS (SELECT 1 FROM stay_payments d WHERE d.booking_id = b.id AND d.kind = 'site_deposit') AS booked_online,
           BOOL_OR(s.pos_transaction_id IS NOT NULL AND ${hasStayLine('s.pos_transaction_id')}) AS by_stay_line
      FROM stay_payments s
      JOIN unit_bookings b ON b.id = s.booking_id
      JOIN units u ON u.id = b.unit_id
      LEFT JOIN pos_transactions t ON t.id = s.pos_transaction_id
     WHERE u.property_id = $1 AND s.landlord_id = ANY($2::uuid[])
       AND s.method <> 'charge' AND (t.id IS NULL OR t.status <> 'voided')
       AND b.check_in < $4::date AND GREATEST(${soldCheckOutSql('b')}, b.check_in + 1) > $3::date
       -- A stay that became a lease is that lease's.
       AND NOT EXISTS (SELECT 1 FROM leases l WHERE l.source_booking_id = b.id)
     GROUP BY b.id, u.unit_number, b.lease_type, b.check_in, b.check_out, b.booked_check_out, b.status
     ORDER BY b.check_in, b.id`, [property.id, landlordIds, start, end])
  const back = await stayRefundsAllTime(landlordIds, booked.map(r => r.booking_id))
  // A stay item sold with no stay on the schedule: counted by its line — what
  // one of it buys × its quantity — at the space its sale names, the month it
  // was sold.
  const unscheduled = await query<{
    sale_id: string; unit: RentRollStayUnit; qty: string; line_money: string; named: string[]
    base: string; screening: string; refunded: string
  }>(`
    SELECT t.id AS sale_id, sp.stay_unit AS unit, SUM(i.qty)::text AS qty,
           SUM(ROUND(i.subtotal * (1 + COALESCE(i.tax_rate, 0)), 2))::text AS line_money,
           COALESCE((SELECT jsonb_agg(ni.item_name ORDER BY ni.item_name, ni.id)
                       FROM pos_transaction_items ni WHERE ni.transaction_id = t.id), '[]'::jsonb)
             || CASE WHEN NULLIF(TRIM(pl.label), '') IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(pl.label) END AS named,
           (t.total - COALESCE(t.surcharge, 0))::text AS base,
           COALESCE((SELECT SUM(ssp.amount) FROM screening_prepayments ssp
                      WHERE ssp.status <> 'void' AND ssp.source_id IN (t.id, t.pay_link_id)), 0)::text AS screening,
           COALESCE((SELECT SUM(r.amount - r.card_fee_refunded) FROM pos_refunds r
                      WHERE r.transaction_id = t.id AND r.stay_refund_part_id IS NULL AND r.reversed_at IS NULL), 0)::text AS refunded
      FROM pos_transactions t
      JOIN pos_transaction_items i ON i.transaction_id = t.id
      JOIN pos_items sp ON sp.id = i.item_id AND sp.stay_unit IS NOT NULL
      LEFT JOIN pos_pay_links pl ON pl.id = t.pay_link_id
     WHERE t.property_id = $1 AND t.landlord_id = ANY($2::uuid[])
       AND t.status <> 'voided' AND t.payment_method <> 'charge'
       AND (t.created_at AT TIME ZONE $3)::date >= $4::date AND (t.created_at AT TIME ZONE $3)::date < $5::date
       -- A sale that paid toward a stay on the schedule is that stay's (above).
       AND NOT EXISTS (SELECT 1 FROM stay_payments ss WHERE ss.pos_transaction_id = t.id)
     GROUP BY t.id, sp.stay_unit, pl.label
     ORDER BY MIN(t.created_at), t.id, sp.stay_unit`, [property.id, landlordIds, tz, start, end])

  const pieces: StayPiece[] = []
  for (const r of booked) {
    const backC = back.get(r.booking_id) ?? 0
    const kept = cents(r.toward) - backC
    if (kept <= 0) continue
    // 10/14 (Nic): checked out early with nights refunded — the nights stayed.
    const early = r.checked_out && backC > 0 && r.check_out < r.booked_check_out
    const at = stayInRange(early ? { ...r, booked_check_out: r.check_out } : r, kept, start, end)
    if (!at) continue
    pieces.push({
      unit: at.unit, via: r.booked_online && !r.by_stay_line ? 'booking_site' : 'pos', quantity: at.quantity,
      paidCents: at.paidCents, space: r.space, stay: `booking:${r.booking_id}`,
    })
  }
  if (unscheduled.length) {
    const spaces = (await query<{ id: string; unit_number: string; display_label: string | null }>(
      `SELECT id, unit_number, display_label FROM units WHERE property_id = $1`, [property.id]))
      .map(u => ({ unitId: u.id, number: u.unit_number, names: [u.unit_number, u.display_label] }))
    // What went back at the register on the sale comes off its other items
    // first; only what is beyond them comes off its stay lines, by their money.
    for (const rows of groupBy(unscheduled, s => s.sale_id).values()) {
      const linesC = rows.reduce((t, x) => t + cents(x.line_money), 0)
      const otherC = Math.max(0, cents(rows[0].base) - cents(rows[0].screening) - linesC)
      const backC = Math.min(linesC, Math.max(0, cents(rows[0].refunded) - otherC))
      let left = backC
      rows.forEach((s, i) => {
        const lineC = cents(s.line_money)
        const off = i === rows.length - 1 ? left : Math.min(left, linesC > 0 ? Math.round((backC * lineC) / linesC) : 0)
        left -= off
        const unitId = spaceNamedIn(s.named ?? [], spaces)
        pieces.push({
          unit: s.unit, via: 'pos', quantity: Number(s.qty) || 0, paidCents: Math.max(0, lineC - off),
          space: unitId ? (spaces.find(u => u.unitId === unitId)?.number ?? null) : null, stay: `sale:${s.sale_id}`,
        })
      })
    }
  }
  return stayLinesOf(pieces, opts.withMoney)
}

/** Rows grouped by a key, in the order first seen. */
function groupBy<T>(rows: readonly T[], key: (r: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>()
  for (const r of rows) out.set(key(r), [...(out.get(key(r)) ?? []), r])
  return out
}

/**
 * 10/14 (Nic): "subtract refunds (early check-out)." Everything given back on
 * these stays, ever, in cents by booking: an early check-out's parts
 * (stay_refund_parts — refunded, handed back or put on the account, never one
 * reversed) and, on a register sale that paid a stay, what a refund at the
 * register gave back beyond the sale's other items (splitRegisterMoney: the
 * early check-out's rule, the stays it paid by their parts). A refund Stripe
 * sent back is never one.
 */
async function stayRefundsAllTime(landlordIds: string[], bookingIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (!bookingIds.length) return out
  const add = (id: string, c: number) => out.set(id, (out.get(id) ?? 0) + c)
  for (const r of await query<{ booking_id: string; back: string }>(`
    SELECT rp.booking_id, SUM(rp.toward_amount)::text AS back
      FROM stay_refund_parts rp
     WHERE rp.booking_id = ANY($1::uuid[]) AND rp.landlord_id = ANY($2::uuid[])
       AND rp.refunded_at IS NOT NULL AND rp.reversed_at IS NULL
       AND rp.status IN ('refunded', 'handed_back', 'credited')
     GROUP BY rp.booking_id`, [bookingIds, landlordIds])) add(r.booking_id, cents(r.back))
  const sales = await query<Pick<RegisterSale, 'id' | 'base' | 'screening' | 'stays' | 'refunds'>>(`
    SELECT t.id, (t.total - COALESCE(t.surcharge, 0))::text AS base,
           COALESCE((SELECT SUM(ssp.amount) FROM screening_prepayments ssp
                      WHERE ssp.status <> 'void' AND ssp.source_id IN (t.id, t.pay_link_id)), 0)::text AS screening,
           COALESCE((SELECT jsonb_agg(jsonb_build_object('bookingId', sp.booking_id, 'toward', sp.toward_stay) ORDER BY sp.paid_at, sp.id)
                       FROM stay_payments sp WHERE sp.pos_transaction_id = t.id), '[]'::jsonb) AS stays,
           (SELECT jsonb_agg(jsonb_build_object('id', r.id, 'day', to_char(r.created_at, 'YYYY-MM-DD'), 'inMonth', TRUE,
                                                'net', r.amount - r.card_fee_refunded, 'method', r.refund_method) ORDER BY r.created_at, r.id)
              FROM pos_refunds r WHERE r.transaction_id = t.id AND r.stay_refund_part_id IS NULL AND r.reversed_at IS NULL) AS refunds
      FROM pos_transactions t
     WHERE t.id IN (SELECT sp.pos_transaction_id FROM stay_payments sp WHERE sp.booking_id = ANY($1::uuid[]))
       AND t.landlord_id = ANY($2::uuid[]) AND t.status <> 'voided' AND t.payment_method <> 'charge'
       AND EXISTS (SELECT 1 FROM pos_refunds er
                    WHERE er.transaction_id = t.id AND er.stay_refund_part_id IS NULL AND er.reversed_at IS NULL)`,
  [bookingIds, landlordIds])
  if (!sales.length) return out
  const { stayRefunds } = splitRegisterMoney(sales.map(s => ({
    ...s, sold_on: '', sold_in_month: false, method: 'cash', paid_online: null, via_link: false, who: null, items: null,
  })))
  const wanted = new Set(bookingIds)
  for (const [id, list] of stayRefunds) if (wanted.has(id)) add(id, list.reduce((t, x) => t + cents(x.amount), 0))
  return out
}

/** THE RENT ROLL PAGE: one property's history over a range of months (or all time). */
export async function buildRentRollHistory(opts: {
  landlordIds: string[]
  property: RentRollPropertyRef
  /** 'YYYY-MM', inclusive; ignored when allTime. */
  from?: string | null
  to?: string | null
  allTime: boolean
  withTotals: boolean
  /**
   * The day a lease ended, in the "Moved out, still owes" folder. false — a
   * bookkeeper whose owner left "Show lease start and end dates" unticked
   * (10/12, Nic: lease dates on their rent roll are the owner's choice per
   * bookkeeper); every other viewer sees it.
   */
  showLeaseDates?: boolean
  /** The day to judge on ('YYYY-MM-DD'); default the property's today. For tests. */
  asOf?: string | null
}): Promise<RentRollHistory> {
  const { landlordIds, property } = opts
  if (!opts.allTime && (!opts.from || !opts.to || opts.from > opts.to)) {
    throw new RentRollRangeError('Pick a start month on or before the end month.')
  }
  // 10/12 (Nic): the clean cut at a sale — a bookkeeper reads a former
  // property of theirs only up to its last day: judged on that day, and no
  // month after it (property.lastDay; null for everyone else). 10/13 (Nic,
  // round 3): "a pre-sale bill paid after the sale shows PAID" — the cut keeps
  // the months, never the money: a bill of the company's from before the sale
  // reads what it is now (a payment stays with the seller at a sale,
  // services/propertyTransfer), so one paid after the sale is paid here, late
  // by the day it was paid.
  const cut = property.lastDay ?? null
  const asOf = cut && (!opts.asOf || opts.asOf > cut) ? cut : (opts.asOf ?? null)
  const current = openMonthOf(property, asOf)
  const clampTo = (m: string) => (cut && m > current ? current : m)
  // Everything billed here, all time, through the open month or the range's
  // end when later: health is all time, and "Moved out, still owes" is
  // whatever is still owed today, whatever the range.
  const askedTo = opts.allTime ? null : clampTo(opts.to!)
  const askedFrom = opts.allTime ? null : (opts.from! > askedTo! ? askedTo! : opts.from!)
  const reach = askedTo && askedTo > current ? askedTo : current
  const all = await householdMonths({
    landlordIds, propertyIds: [property.id], from: ALL_TIME_FROM, through: reach, asOf, byLease: true,
  })
  const first = all.reduce<string | null>((f, m) => (f === null || m.month < f ? m.month : f), null)
  const from = opts.allTime ? (first && first < current ? first : current) : askedFrom!
  const to = opts.allTime ? current : askedTo!
  const months = monthsBetween(from, to)

  const byKey = new Map<string, HouseholdMonth[]>()
  for (const m of all) {
    const key = householdKey(m.lease_id, m.household_id)
    byKey.set(key, [...(byKey.get(key) ?? []), m])
  }
  const leaseIds = [...new Set(all.map(m => m.lease_id).filter((x): x is string => !!x))]
  const facts = await leaseFacts(leaseIds, property.id)
  const personIds = [...new Set(all.filter(m => !m.lease_id).map(m => m.household_id))]
  const { byLease, byPerson } = await residentsOf(leaseIds, personIds)

  const describe = (key: string, ms: HouseholdMonth[]) => {
    const leaseId = ms[0].lease_id
    const f = leaseId ? facts.get(leaseId) : undefined
    const spaces = new Set<string>()
    if (f) spaces.add(f.unit_number)
    return {
      key, leaseId, f, spaces,
      householdId: f?.household_id ?? ms[0].household_id,
      residents: leaseId ? (byLease.get(leaseId) ?? []) : (byPerson.get(ms[0].household_id) ?? []),
      // A lease that ended, and its household no longer lives here. A charge
      // on no lease is a person who never had one here: not "moved out".
      movedOut: !!f && f.status !== 'active' && f.status !== 'pending' && !f.lives_here,
    }
  }

  const rows: RentRollHistoryRow[] = []
  /** Within one space, the earlier lease first. */
  const startOf = new Map<string, string>()
  const movedOutOwing: RentRollMovedOutOwing[] = []
  const totals = zeroTotals()
  /** Of `totals`, the folder households' bills in the range (history.movedOutTotals). */
  const movedOutTotals = zeroTotals()
  /** The folder households' stamps over the range (for the month counts only). */
  const folderStamps: Array<Pick<RentRollHistoryRow, 'stamps'>> = []
  for (const [key, ms] of byKey) {
    const d = describe(key, ms)
    // 10/13 (Nic): "Moved-out people who still owe sit in a collapsed 'Moved
    // out, still owes' folder until paid" — whatever the range, and only
    // there: never a row as well ("Rent Roll = current residents + a collapsed
    // 'Moved out, still owes' folder until paid"). Once paid, a moved-out
    // household is a row again in the months it was billed.
    const owedC = ms.reduce((s, m) => s + cents(m.owed), 0)
    const inRange = ms.filter(m => m.month >= from && m.month <= to)
    if (d.movedOut && owedC > 0) {
      for (const m of ms) if (cents(m.owed) > 0) for (const u of m.units) d.spaces.add(u)
      const s = sumMonths(inRange)
      const money: RentRollTotals = {
        invoiced: s.invoiced, lateFees: s.lateFees, paid: s.paid, credit: s.credit, workTrade: s.workTrade, owed: s.owed,
      }
      movedOutOwing.push({
        key, kind: 'household', leaseId: d.leaseId, householdId: d.householdId, residents: d.residents,
        guest: null, stayDates: null, checkedOut: null, spaces: [...d.spaces].sort(compareSpaces),
        owed: dollars(owedC),
        months: ms.filter(m => cents(m.owed) > 0).map(m => ({ month: m.month, owed: m.owed })),
        leaseEnded: opts.showLeaseDates === false ? null : (d.f?.ended_on ?? null),
        inRange: money,
      })
      // 10/13 (Nic): "Range totals INCLUDE moved-out folder households" —
      // their bills in the range count in the property's Invoiced, Paid and
      // Owed for it, though they are a row only in the folder; each folder
      // household says its part (inRange), and so does the folder
      // (movedOutTotals), so the printout and the spreadsheet add up.
      addTotals(totals, money)
      addTotals(movedOutTotals, money)
      // 10/13 (Nic): "Rent Roll month counts INCLUDE the moved-out folder" —
      // its households' months in the range are counted with the rows'.
      const byMonth = new Map(inRange.map(m => [m.month, m]))
      folderStamps.push({ stamps: months.map(month => stampWire(month, byMonth.get(month))) })
      continue
    }
    // Billed in the range: a bill, or anything charged.
    if (inRange.some(m => m.stamp !== null || cents(m.charged) > 0)) {
      for (const m of inRange) for (const u of m.units) d.spaces.add(u)
      const byMonth = new Map(inRange.map(m => [m.month, m]))
      const money = sumMonths(inRange)
      const row: RentRollHistoryRow = {
        key, leaseId: d.leaseId, householdId: d.householdId, residents: d.residents,
        spaces: [...d.spaces].sort(compareSpaces), movedOut: d.movedOut,
        invoiced: money.invoiced, lateFees: money.lateFees, paid: money.paid, credit: money.credit,
        workTrade: money.workTrade, owed: money.owed,
        // 10/12 (Nic): health is all time — through the range's last month,
        // this lease alone (10/13: each lease its own household).
        health: healthWire(paymentHealth(ms, to)),
        stamps: months.map(month => stampWire(month, byMonth.get(month))),
      }
      startOf.set(key, d.f?.start_date ?? ms[0].month)
      addTotals(totals, row)
      rows.push(row)
    }
  }
  rows.sort((a, z) => compareSpaces(a.spaces[0], z.spaces[0]) || (startOf.get(a.key) ?? '').localeCompare(startOf.get(z.key) ?? '')
    || (a.residents[0]?.name ?? '').localeCompare(z.residents[0]?.name ?? '') || a.key.localeCompare(z.key))
  // 10/14 (Nic): the folder also lists checked-out stay guests who still owe
  // — the Payments page's rule (checkedOutStillOwing), whatever the range. A
  // stay is no bill: nothing of it is in the range totals (its money paid is
  // the stays' lines below).
  for (const m of await checkedOutStillOwing(landlordIds, property, new Set())) {
    movedOutOwing.push({
      key: m.key, kind: 'stay', leaseId: null, householdId: null, residents: [], guest: m.guest, stayDates: m.stayDates,
      checkedOut: m.leftOn, spaces: m.space ? [m.space] : [], owed: m.owed, months: [], leaseEnded: null, inRange: zeroTotals(),
    })
  }
  const whoOf = (m: RentRollMovedOutOwing) => m.residents[0]?.name ?? m.guest ?? ''
  movedOutOwing.sort((a, z) => compareSpaces(a.spaces[0], z.spaces[0])
    || whoOf(a).localeCompare(whoOf(z)) || a.key.localeCompare(z.key))
  // 10/13 (Nic): "show stays as an aggregate by line items … put them below
  // with expandable notes" — the range's stays (all time: every stay, whether
  // or not a bill came before it), up to a bookkeeper's cut at a sale.
  const stays = await rentRollStays({
    landlordIds, property, from: opts.allTime ? ALL_TIME_FROM : from, to, lastDay: cut, withMoney: opts.withTotals,
  })
  const history: RentRollHistory = {
    propertyId: property.id, propertyName: property.name, from, to, allTime: opts.allTime, months,
    monthCounts: monthCounts(months, [...rows, ...folderStamps]), rows, movedOutOwing, stays,
  }
  if (opts.withTotals) {
    history.totals = totals
    history.movedOutTotals = movedOutTotals
  }
  return history
}

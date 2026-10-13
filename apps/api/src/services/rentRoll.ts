/**
 * THE RENT ROLL: one page for who owes, who paid, how late and how they pay
 * (10/12, Nic). It replaces both the old Rent Roll (a unit list with the
 * unit's listed rent) and the Payments ledger as the place to look.
 *
 *   "Combined page: property FOLDERS like the Balances page … columns per
 *    household: name, unit(s), lease rent (from the LEASE, not the unit
 *    listing), Charged (includes late fees, with a small 'incl. $X late fees'
 *    note), Paid, Owed (= Charged − Paid − credit applied; partials show the
 *    difference), Status (color), Payment health (%), and a strip of monthly
 *    stamps (colored) … with month column headers showing counts ('Oct: 3
 *    late')."
 *   10/12 (Nic): payment health and a tenant's history are ALL-TIME (since the
 *    household joined GAM), not 12 months — the strip is the full stamp
 *    history, scrolling sideways, the newest month first in view.
 *
 * Built entirely from services/householdMonths (the one payment-health
 * definition): one row per household per property folder — every household on
 * an occupied space (an active lease), including one that paid nothing, plus
 * the households that moved out that the company keeps on the page. 10/12
 * (Nic): "who stays on the Rent Roll after moving out = LANDLORD'S CHOICE (a
 * setting on the page: billed in last 12 months / while they owe / all time)"
 * — landlords.rent_roll_moved_out, per company (RENT_ROLL_MOVED_OUT_RULES;
 * default: billed in the last RENT_ROLL_RECENT_MONTHS months). The strip
 * runs from the first bill month of any household on the page through the
 * picked month. Owed is what the household still owes on the picked month's
 * bills (Outstanding's figure, row for row); work trade is its own bucket,
 * never paid and never owed.
 *
 * Grand totals (a sum across people) go only to a viewer seesGrandTotals
 * admits (decisions #25) — the caller decides and passes withTotals.
 */
import { query } from '../db'
import {
  PAYMENT_STAMPS, RENT_ROLL_MOVED_OUT_DEFAULT, RENT_ROLL_MOVED_OUT_LABEL, isRentRollMovedOutRule,
  type PaymentStamp, type RentRollMovedOutRule,
} from '@gam/shared'
import {
  householdMonthsBoth, householdLines, paymentHealth, addMonths, monthsBetween, ALL_TIME_FROM,
  type HouseholdMonth, type PaymentHealth, type ChargeLine,
} from './householdMonths'

/**
 * 10/12: the default rule for who is a row besides the households on an
 * occupied space (billed_last_12_months) — anyone billed in the last 12
 * months, so a household that moved out stays on the page for a year (its
 * whole history is the tenant report's). The company may keep them while they
 * still owe, or for all time, instead (RentRollMovedOutRule, the landlord's
 * choice — 10/12, Nic).
 */
export const RENT_ROLL_RECENT_MONTHS = 12

/** One company's choice of who stays on the page after moving out. */
export interface RentRollMovedOut {
  landlord_id: string
  company_name: string
  rule: RentRollMovedOutRule
  rule_label: string
}

/** Each company's moved-out rule (the default for a company with none on record). */
export async function movedOutRules(landlordIds: readonly string[]): Promise<RentRollMovedOut[]> {
  if (!landlordIds.length) return []
  const rows = await query<{ id: string; name: string | null; first_name: string | null; last_name: string | null; rule: string | null }>(`
    SELECT l.id, NULLIF(btrim(l.business_name), '') AS name, u.first_name, u.last_name, l.rent_roll_moved_out AS rule
      FROM landlords l LEFT JOIN users u ON u.id = l.user_id
     WHERE l.id = ANY($1::uuid[])
     ORDER BY lower(COALESCE(NULLIF(btrim(l.business_name), ''), '')), l.id`, [[...landlordIds]])
  return rows.map(r => {
    const rule: RentRollMovedOutRule = isRentRollMovedOutRule(r.rule) ? r.rule : RENT_ROLL_MOVED_OUT_DEFAULT
    return {
      landlord_id: r.id,
      company_name: r.name || [r.first_name, r.last_name].filter(Boolean).join(' ') || 'Your company',
      rule,
      rule_label: RENT_ROLL_MOVED_OUT_LABEL[rule],
    }
  })
}

/**
 * Does a household that no longer holds a space here stay on the page? The
 * company's rule, judged on the household's months at this property:
 *   billed_last_12_months  a bill in the 12 months through the month picked
 *   while_owing            anything still owed on its bills here
 *   all_time               any bill here, ever
 */
export function keepsMovedOut(rule: RentRollMovedOutRule, months: readonly HouseholdMonth[], recentFrom: string): boolean {
  if (!months.length) return false
  if (rule === 'all_time') return true
  if (rule === 'while_owing') return months.some(m => cents(m.owed) > 0)
  return months.some(m => m.month >= recentFrom)
}

export type StampCounts = Record<PaymentStamp, number>

export interface MonthCounts extends StampCounts {
  /** YYYY-MM */
  month: string
  /** Households work trade covered in full that month. */
  work_trade: number
}

export interface MoneyTotals {
  charged: number
  charged_late_fees: number
  paid: number
  credit: number
  work_trade: number
  owed: number
}

export interface RentRollStamp {
  month: string
  stamp: PaymentStamp | null
  stamp_label: string | null
  days_past_grace: number
  charged: number
  charged_late_fees: number
  paid: number
  credit: number
  work_trade: number
  owed: number
  first_paid_on: string | null
  paid_in_full_on: string | null
  onboarding: boolean
  work_trade_only: boolean
}

export interface RentRollRow {
  household_id: string
  name: string
  property_id: string | null
  units: string[]
  /** The rent the household's active lease(s) here bill each month (never the unit's listed rent). */
  lease_rent: number | null
  /** The picked month. */
  current: RentRollStamp | null
  /** The strip, oldest first (one per strip month — all time; stamp null = nothing billed that month). */
  stamps: RentRollStamp[]
  /** The one payment-health figure (all time, since the household's first bill on GAM). */
  health: PaymentHealth
  delinquent: boolean
  eviction_mode: boolean
  work_trade: boolean
  /** The picked month's charges, for the expanded row. */
  lines: ChargeLine[]
}

export interface RentRollFolder {
  property_id: string | null
  property_name: string | null
  occupied: number
  rows: RentRollRow[]
  counts: MonthCounts[]
  /** The picked month's money here; only for a viewer seesGrandTotals admits (decisions #25). */
  totals?: MoneyTotals
}

export interface RentRoll {
  /**
   * 10/12 (Nic): each company's choice of which households that moved out
   * stay on the page — the setting the page shows (and the owner changes).
   */
  moved_out: RentRollMovedOut[]
  /**
   * The rent the active leases bill each month — the Dashboard's Expected
   * Monthly Rent card opens this page. Work-trade spaces are totaled apart
   * (settled in hours, S640); a hibernating lease bills nothing. Only for a
   * viewer seesGrandTotals admits, like every sum across people.
   */
  lease_rent?: { expected: number; traded_for_work: number }
  /** YYYY-MM: the picked month. */
  through: string
  /**
   * The strip's months, oldest first: every month from the first bill of any
   * household on the page through the picked month (10/12: all time). The
   * page shows them newest first.
   */
  months: string[]
  properties: RentRollFolder[]
  counts: MonthCounts[]
  totals?: MoneyTotals
}

const cents = (v: number | string | null | undefined) => Math.round(Number(v ?? 0) * 100)
const dollars = (c: number) => Math.round(c) / 100

function emptyCounts(month: string): MonthCounts {
  const c = { month, work_trade: 0 } as MonthCounts
  for (const s of PAYMENT_STAMPS) c[s] = 0
  return c
}

function stampOf(m: HouseholdMonth | undefined, month: string): RentRollStamp {
  return {
    month,
    stamp: m?.stamp ?? null,
    stamp_label: m?.stamp_label ?? null,
    days_past_grace: m?.days_past_grace ?? 0,
    charged: m?.charged ?? 0,
    charged_late_fees: m?.charged_late_fees ?? 0,
    paid: m?.paid ?? 0,
    credit: m?.credit ?? 0,
    work_trade: m?.work_trade ?? 0,
    owed: m?.owed ?? 0,
    first_paid_on: m?.first_paid_on ?? null,
    paid_in_full_on: m?.paid_in_full_on ?? null,
    onboarding: m?.onboarding ?? false,
    work_trade_only: m?.work_trade_only ?? false,
  }
}

function addMoney(t: MoneyTotals, s: RentRollStamp): void {
  t.charged = dollars(cents(t.charged) + cents(s.charged))
  t.charged_late_fees = dollars(cents(t.charged_late_fees) + cents(s.charged_late_fees))
  t.paid = dollars(cents(t.paid) + cents(s.paid))
  t.credit = dollars(cents(t.credit) + cents(s.credit))
  t.work_trade = dollars(cents(t.work_trade) + cents(s.work_trade))
  t.owed = dollars(cents(t.owed) + cents(s.owed))
}
const zeroMoney = (): MoneyTotals => ({ charged: 0, charged_late_fees: 0, paid: 0, credit: 0, work_trade: 0, owed: 0 })

/** Build the Rent Roll for these companies (and a property-locked viewer's properties). */
export async function buildRentRoll(opts: {
  landlordIds: string[]
  propertyIds: string[] | null
  through: string
  withTotals: boolean
  /** The day to judge on ('YYYY-MM-DD'); default each property's today. For tests. */
  asOf?: string | null
}): Promise<RentRoll> {
  const recentFrom = addMonths(opts.through, -(RENT_ROLL_RECENT_MONTHS - 1))
  if (!opts.landlordIds.length) {
    const empty: RentRoll = { moved_out: [], through: opts.through, months: [opts.through], properties: [], counts: [emptyCounts(opts.through)] }
    return opts.withTotals ? { ...empty, totals: zeroMoney() } : empty
  }
  const movedOut = await movedOutRules(opts.landlordIds)
  const ruleOf = new Map(movedOut.map(r => [r.landlord_id, r.rule]))

  // Who is on an occupied space now: active leases, their primary resident,
  // the lease's own rent, the space's delinquency and eviction mode.
  const occupied = await query<{
    lease_id: string; household_id: string | null; rent: string; unit_number: string; unit_status: string
    payment_block: boolean; property_id: string; property_name: string; work_trade: boolean; hibernating: boolean
  }>(`
    SELECT l.id AS lease_id,
           (SELECT lt.tenant_id FROM lease_tenants lt
             WHERE lt.lease_id = l.id AND lt.role = 'primary' AND lt.status <> 'void'
             ORDER BY (lt.status = 'active') DESC, lt.created_at, lt.id LIMIT 1) AS household_id,
           l.rent_amount::text AS rent, u.unit_number, u.status AS unit_status, COALESCE(u.payment_block, FALSE) AS payment_block,
           pr.id AS property_id, pr.name AS property_name,
           -- Rent traded for work (S640: 'rent' is one of the charges the
           -- agreement covers) — totaled apart, like the Dashboard's card.
           EXISTS (SELECT 1 FROM work_trade_agreements a WHERE a.unit_id = u.id AND a.status = 'active'
                     AND 'rent' = ANY(a.covered_charges)) AS work_trade,
           COALESCE(l.is_hibernating, FALSE) AS hibernating
      FROM leases l
      JOIN units u ON u.id = l.unit_id
      JOIN properties pr ON pr.id = u.property_id
     WHERE l.landlord_id = ANY($1::uuid[])
       AND l.status = 'active'
       AND u.retired_at IS NULL
       AND ($2::uuid[] IS NULL OR u.property_id = ANY($2::uuid[]))`,
    [opts.landlordIds, opts.propertyIds])

  // All time (10/12, Nic): the strip and the health reach back to each
  // household's first bill on GAM. One read of the charges gives both the
  // folders' months and each household's months across them (the health):
  // householdMonthsBoth adds the property months up instead of reading the
  // whole history a second time.
  const [{ byProperty, byHousehold: wide, byPropertyAcrossCompanies }, lines] = await Promise.all([
    householdMonthsBoth({ landlordIds: opts.landlordIds, propertyIds: opts.propertyIds, from: ALL_TIME_FROM, through: opts.through, asOf: opts.asOf }),
    householdLines({ landlordIds: opts.landlordIds, propertyIds: opts.propertyIds, from: opts.through, through: opts.through, asOf: opts.asOf }),
  ])

  // Health is the household's, whichever folder it shows in (one definition).
  const wideBy = new Map<string, HouseholdMonth[]>()
  for (const m of wide) wideBy.set(m.household_id, [...(wideBy.get(m.household_id) ?? []), m])
  const health = new Map<string, PaymentHealth>()
  for (const [hh, ms] of wideBy) health.set(hh, paymentHealth(ms, opts.through))

  type Key = string
  const key = (property: string | null, hh: string): Key => `${property ?? ''}|${hh}`
  interface Building {
    property_id: string | null; property_name: string | null; household_id: string
    units: Set<string>; rentC: number | null; delinquent: boolean; eviction: boolean; workTrade: boolean
    /** The spaces an active lease holds now (a bill on an old space is not an occupied one). */
    occupied: Set<string>
    months: Map<string, HouseholdMonth>
  }
  const rows = new Map<Key, Building>()
  const slot = (property_id: string | null, property_name: string | null, hh: string): Building => {
    const k = key(property_id, hh)
    let b = rows.get(k)
    if (!b) {
      b = { property_id, property_name, household_id: hh, units: new Set(), rentC: null, delinquent: false, eviction: false, workTrade: false, occupied: new Set(), months: new Map() }
      rows.set(k, b)
    }
    return b
  }
  let expectedC = 0, tradedC = 0
  for (const o of occupied) {
    if (!o.household_id) continue
    const b = slot(o.property_id, o.property_name, o.household_id)
    b.units.add(o.unit_number)
    b.occupied.add(o.unit_number)
    if (!o.hibernating) {
      b.rentC = (b.rentC ?? 0) + cents(o.rent)
      // 10/12: Expected vs traded for work is decided per LEASE (its space's
      // agreement trades rent), the way the Dashboard's card decides it per
      // space — not per household, which moved a household's whole rent to
      // "traded" when only one of its spaces traded rent.
      if (o.work_trade) tradedC += cents(o.rent)
      else expectedC += cents(o.rent)
    }
    b.delinquent = b.delinquent || o.unit_status === 'delinquent'
    b.eviction = b.eviction || o.payment_block === true
    b.workTrade = b.workTrade || o.work_trade === true
  }
  // Besides the occupied spaces, the households that moved out stay as their
  // company chose (10/12, Nic: the landlord's choice — keepsMovedOut; by
  // default, billed in the last RENT_ROLL_RECENT_MONTHS) — and a row carries
  // every month it has.
  //
  // 10/12 (Nic) review — whose rule: the property's company when it is one of
  // the viewer's companies (a property moved between the account's own
  // companies follows its owner now); otherwise the company that billed it (a
  // property sold out of the account keeps the seller's rule for the seller's
  // old bills — the buyer's company is not the viewer's and has no say here),
  // and a bill on no space, the company that billed it. Each company is judged
  // on its own months; no company's months speak for another's (S652: no
  // first-company-wins).
  const propertyCompany = new Map<string, string>()
  const propIds = [...new Set(byProperty.map(m => m.property_id).filter((x): x is string => !!x))]
  if (propIds.length) {
    for (const r of await query<{ id: string; landlord_id: string }>(
      `SELECT id, landlord_id FROM properties WHERE id = ANY($1::uuid[])`, [propIds])) propertyCompany.set(r.id, r.landlord_id)
  }
  const ruleCompany = (m: HouseholdMonth): string => {
    const owner = m.property_id ? propertyCompany.get(m.property_id) : undefined
    return owner && ruleOf.has(owner) ? owner : m.landlord_id
  }
  // Each company's own months per row (the rule's input) …
  const companyMonthsBy = new Map<Key, Map<string, HouseholdMonth[]>>()
  for (const m of byProperty) {
    const k = key(m.property_id, m.household_id)
    let per = companyMonthsBy.get(k)
    if (!per) { per = new Map(); companyMonthsBy.set(k, per) }
    const c = ruleCompany(m)
    per.set(c, [...(per.get(c) ?? []), m])
  }
  const kept = (k: Key): boolean => {
    for (const [company, ms] of companyMonthsBy.get(k) ?? []) {
      if (keepsMovedOut(ruleOf.get(company) ?? RENT_ROLL_MOVED_OUT_DEFAULT, ms, recentFrom)) return true
    }
    return false
  }
  // … and the months the row shows: the account's companies added together,
  // one month per household per property (10/12 review: two companies' months
  // for the same household and month used to overwrite each other here).
  const monthsBy = new Map<Key, HouseholdMonth[]>()
  for (const m of byPropertyAcrossCompanies) {
    const k = key(m.property_id, m.household_id)
    monthsBy.set(k, [...(monthsBy.get(k) ?? []), m])
  }
  // 10/12 (Nic) review: the picked month's money is the company's money,
  // whoever the moved-out setting shows — a household that moved out mid-month
  // and paid in full is not a row under "while they still owe", but its rent
  // was still charged and paid that month. The setting decides the rows; the
  // totals count every household billed in the picked month (each dollar once).
  // Under the other two settings every household billed in the picked month
  // is a row, so this changes nothing there.
  const hiddenPicked: HouseholdMonth[] = []
  for (const [k, ms] of monthsBy) {
    if (!rows.has(k) && !kept(k)) {
      const picked = ms.find(m => m.month === opts.through)
      if (picked) hiddenPicked.push(picked)
      continue
    }
    const b = slot(ms[0].property_id, ms[0].property_name, ms[0].household_id)
    for (const m of ms) {
      // The spaces column: the spaces held now and those billed lately — never
      // every space the household was billed on in its whole history.
      if (m.month >= recentFrom) for (const u of m.units) b.units.add(u)
      b.months.set(m.month, m)
    }
    // Kept for longer than a year (while owing, all time): the spaces of its
    // last bill here, so the row still says where it lived.
    if (!b.units.size) {
      const last = ms.reduce((a, m) => (m.month > a.month ? m : a), ms[0])
      for (const u of last.units) b.units.add(u)
    }
  }

  // The strip: the first bill month of any household on the page through the
  // picked month — all time, one column per month.
  let first = opts.through
  for (const b of rows.values()) for (const m of b.months.keys()) if (m < first) first = m
  const strip = monthsBetween(first, opts.through)

  const names = new Map<string, string>()
  const ids = [...new Set([...rows.values()].map(b => b.household_id))]
  if (ids.length) {
    for (const r of await query<{ id: string; name: string }>(
      `SELECT t.id, TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')) AS name
         FROM tenants t JOIN users u ON u.id = t.user_id WHERE t.id = ANY($1::uuid[])`, [ids])) names.set(r.id, r.name)
  }
  const linesBy = new Map<Key, ChargeLine[]>()
  for (const l of lines) {
    const k = key(l.property_id, l.household_id)
    linesBy.set(k, [...(linesBy.get(k) ?? []), l])
  }

  const folders = new Map<string, RentRollFolder>()
  const allCounts = new Map(strip.map(m => [m, emptyCounts(m)]))
  const grand = zeroMoney()
  for (const [k, b] of rows) {
    const fk = b.property_id ?? ''
    let f = folders.get(fk)
    if (!f) {
      f = { property_id: b.property_id, property_name: b.property_name, occupied: 0, rows: [], counts: strip.map(emptyCounts) }
      if (opts.withTotals) f.totals = zeroMoney()
      folders.set(fk, f)
    }
    const stamps = strip.map(m => stampOf(b.months.get(m), m))
    const current = b.months.get(opts.through) ? stampOf(b.months.get(opts.through), opts.through) : null
    stamps.forEach((s, i) => {
      if (!s.stamp) return
      f!.counts[i][s.stamp]++
      allCounts.get(s.month)![s.stamp]++
      if (s.work_trade_only) { f!.counts[i].work_trade++; allCounts.get(s.month)!.work_trade++ }
    })
    if (current && f.totals) { addMoney(f.totals, current); addMoney(grand, current) }
    // 10/12: occupied = the spaces an active lease holds (a hibernating lease
    // still holds its space; it just bills nothing), never a space the
    // household was only billed on before it moved.
    f.occupied += b.occupied.size
    f.rows.push({
      household_id: b.household_id,
      name: names.get(b.household_id) || 'Resident',
      property_id: b.property_id,
      units: [...b.units].sort((a, z) => a.localeCompare(z, undefined, { numeric: true })),
      lease_rent: b.rentC === null ? null : dollars(b.rentC),
      current,
      stamps,
      health: health.get(b.household_id) ?? paymentHealth([], opts.through),
      delinquent: b.delinquent,
      eviction_mode: b.eviction,
      work_trade: b.workTrade,
      lines: linesBy.get(k) ?? [],
    })
  }
  // The picked month's money of the households the setting does not show
  // (see hiddenPicked): in the totals, never a row — the property's folder
  // total when the property has a folder on the page, and always the grand
  // total (a folder with no rows is never drawn).
  if (opts.withTotals) {
    for (const m of hiddenPicked) {
      const s = stampOf(m, opts.through)
      const f = folders.get(m.property_id ?? '')
      if (f?.totals) addMoney(f.totals, s)
      addMoney(grand, s)
    }
  }
  const properties = [...folders.values()].sort((a, z) => String(a.property_name ?? '').localeCompare(String(z.property_name ?? '')))
  for (const f of properties) {
    f.rows.sort((a, z) => (a.units[0] ?? '￿').localeCompare(z.units[0] ?? '￿', undefined, { numeric: true }) || a.name.localeCompare(z.name))
  }
  const out: RentRoll = { moved_out: movedOut, through: opts.through, months: strip, properties, counts: [...allCounts.values()] }
  if (opts.withTotals) {
    out.totals = grand
    out.lease_rent = { expected: dollars(expectedC), traded_for_work: dollars(tradedC) }
  }
  return out
}

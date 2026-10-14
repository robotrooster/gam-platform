/**
 * 10/12 (Nic): the admin Metrics page — the platform's all-time numbers.
 *
 * Nic: "I want a page specifically for vanity metrics. I want to track things
 * like total rents that we've ever processed electronically through card or
 * ACH ... how much money we have logged for rent collected through the
 * platform all time, whether that's paid in cash or check in person ... that
 * we've helped landlords log, you know, $6 million or whatever ... all kinds of
 * other fun vanity metrics."
 *
 * Every figure is one aggregate query over the table that records the thing —
 * no per-row loops — and every one leaves out demo landlords and GAM's own
 * system landlord (the Renter Pool shell), the same filter the money cards use
 * (services/platformRevenue realLandlordSql). A background check paid into the
 * Renter Pool is a real applicant's money, so that one counts the pool.
 *
 * WHAT "RENT" MEANS HERE. Money a tenant's payment applied to a rent charge
 * (remittance_applications → payments.type = 'rent'), on payments that settled.
 * Electronic = card or bank (ACH) through Stripe. Logged = every way a payment
 * is recorded on GAM: card, bank, cash, check, money order, bank deposit. A
 * rent charge marked paid by "prior arrangement" (paid to the landlord before
 * GAM) or covered by discretionary credit carries no payment of its own, so it
 * is not here — no money was logged through GAM for it.
 *
 * 10/12 (Nic) review: rent is counted ONCE, however it got there (RENT_LINES):
 *   - Money paid ahead. A tenant who overpays by check or cash has the surplus
 *     kept as paid-ahead credit (lease_prepaid_credits.source_remittance_id),
 *     and a later rent bill paid from it has no application of its own. That
 *     is still rent paid through GAM, in the payment that brought the money —
 *     production had $1,207.43 of it ($1,202.36 by check, $5.07 cash), two
 *     whole $460 rent bills among it. The surplus never reached a rent bill
 *     until it was spent, so counting the spend counts each dollar once.
 *     A 'reclassified' credit is rent already counted (moved to credit when a
 *     stay was shortened) and a typed-in carry-forward never came through GAM,
 *     so neither counts again.
 *   - Disputes and bank returns. A chargeback leaves the original payment
 *     'settled' with its application, marks the bill 'returned' and bills the
 *     tenant again (services/paymentReversal). The re-payment is new money;
 *     what the dispute took back comes off, on the day it was taken, the way
 *     GAM's income report reads it (services/incomeBasis). A dispute GAM won
 *     took nothing (creditUse.liveReversalSql).
 *   - Refunds. Rent given back at an early check-out (stay_refund_parts that
 *     went back to a tenant payment) comes off on the day it went back.
 *
 * COUNTED ONCE. "Money paid in through GAM" adds four separate doors and no
 * door twice: tenant payments (every charge, every method, less what disputes
 * and refunds gave back — the same take-backs as rent, above), register and
 * pay-link sales (a store-account sale is left out — it moves no money until
 * the account is paid, and then it is a tenant payment), stay deposits paid
 * online (a stay paid at the register is already a register sale), and
 * background checks applicants paid online (one paid at the register is
 * already a register sale). Card fees paid on top are not money for the
 * landlord and are left out of all four. Payouts read platform_transfer_intents
 * only; `disbursements` records the same money again and is never added to it.
 *
 * 10/12 (Nic) review: "On GAM today" counts only what has gone live — a
 * property with a lease, a billed month or a stay on it (LIVE_PROPERTY). A
 * signup that never added a tenant (a test account, a junk organic signup) is
 * not a landlord on the platform yet.
 *
 * 10/12 (Nic): THE HEAT MAP — "toggleable at the state and county levels.
 * darker colors for more units in that area. toggleable between a heat map for
 * units and money." Two numbers per state and per county (Census FIPS codes),
 * each the SAME definition as its tile so the map adds up to the tile: units =
 * "Spaces under management" (open spaces on a live property), money = "Rent
 * logged through GAM" (RENT_LINES, all time). See PlatformMap / buildPlatformMap.
 * 10/12 (Nic, H1): "TOGGLE BOTH (occupied/billed vs all spaces)" — each place
 * also carries how many of its spaces are occupied this month as GAM bills them
 * (OCCUPIED_SPACES), which adds up to the tile's occupied figure the same way.
 * Properties have no county column; the county comes from the property's own
 * map location (properties.latitude/longitude) inside the Census county shapes
 * checked in beside this file (us-atlas, offline — no outside lookup). Anything
 * that cannot be placed is named and counted in `missing`, never guessed —
 * including a property whose address was edited after its map location was
 * found (10/12 (Nic) review: an edit does not look the location up again yet,
 * so the old point would land it in the old county; MAP_ROWS location_stale).
 */
import { query } from '../db'
import { paidByLabel, PROCESSING_FEES, US_STATE_NAME } from '@gam/shared'
import { formatState } from '../lib/format'
import { logger } from '../lib/logger'
import { realLandlordSql } from './platformRevenue'
import { platformFeeBill } from './platformFeeBill'
import { liveReversalSql, reversedUseOfWonDisputeSql } from './creditUse'
import { occupiedSpacesSql } from './billableUnits'
import { utilityBillSentSql, stayHeldSql } from './moneyPredicates'
import { todayIn, monthStartOf } from '../lib/timezone'
import { INCOME_CATEGORY_LABEL, INCOME_UTILITY_CATEGORIES } from '@gam/shared'
import { incomeEvents, breakdownFrom } from './incomeBasis'
import { PLATFORM_FEE_LINES_SQL } from './platformFeeBill'
import { normalizeNameSql } from './leaseBirthdates'
import { NEVER_MOVED_IN_REASON } from '../lib/unwindIssuedLease'

export interface RentByMethod {
  method: string
  label: string
  electronic: boolean
  amount: number
  payments: number
}

export interface PlatformMetrics {
  asOf: string
  /** Day of the first settled tenant payment, YYYY-MM-DD. */
  firstPaymentOn: string | null
  rent: {
    electronic: { total: number; card: number; ach: number; payments: number }
    logged: { total: number; byHand: number; payments: number; byMethod: RentByMethod[] }
    byMonth: Array<{ month: string; electronic: number; byHand: number }>
  }
  moneyIn: {
    total: number
    tenantPayments: { amount: number; count: number; electronic: number; byHand: number }
    registerSales: { amount: number; count: number }
    stayDepositsOnline: { amount: number; count: number }
    backgroundChecks: { amount: number; count: number }
  }
  payouts: { amount: number; count: number }
  payments: {
    count: number
    average: number
    median: number
    biggest: number
    biggestElectronic: number
    busiestDay: { date: string; count: number; amount: number } | null
  }
  footprint: {
    landlords: number
    properties: number
    states: number
    cities: number
    units: number
    households: number
    residents: number
    rentRollMonthly: number
    spacesBilled: number
    spacesBilledMonth: string | null
    /**
     * 10/12 (Nic, A5/H1): of `units`, occupied this month as GAM bills them
     * (OCCUPIED_SPACES), and the rest. The heat map's "Occupied (billed)"
     * view adds up to occupiedSpaces; the admin Overview's Active Units card
     * reads the same count (spacesOccupied).
     */
    occupiedSpaces: number
    vacantSpaces: number
    /** 'YYYY-MM-01': the month occupiedSpaces counts. */
    occupiedMonth: string
  }
  paperwork: { leasesSigned: number; documentsSigned: number; signatures: number }
  operations: {
    meterReadings: number
    utilityBills: number
    utilityBilled: number
    electricKwh: number
    stays: number
    stayNights: number
    homeSales: number
    homeSalesValue: number
    backgroundChecksRun: number
    workTradeAgreements: number
  }
  growth: Array<{ date: string; rentRoll: number; units: number; occupied: number; tenants: number }>
  /** 10/12 (Nic): the heat map, by state and by county. */
  map: PlatformMap
}

/** 10/12 (Nic): one state or county on the heat map. */
export interface MapArea {
  /** Census FIPS code: two digits for a state, five for a county. */
  fips: string
  name: string
  /** The "Spaces under management" tile, in this place: open spaces on a live property. */
  units: number
  /**
   * 10/12 (Nic, H1): of those spaces, the ones occupied this month as GAM bills
   * them — the tile's "occupied" figure, in this place (OCCUPIED_SPACES).
   */
  occupied: number
  /** The "Rent logged through GAM" tile, in this place: all time, every way it was paid. */
  money: number
  /** Properties counted here: live ones, and any other a rent dollar was logged on. */
  properties: number
}

/** Why something is not on a map. Never shown raw — each carries its own words. */
export type MapGap =
  | 'unknown_state' | 'no_property' | 'no_location' | 'stale_location' | 'outside_map' | 'wrong_state'
  | 'no_county_shapes'

export interface PlatformMap {
  states: Array<MapArea & { abbr: string }>
  counties: Array<MapArea & { state: string }>
  /**
   * 10/12 (Nic): what could not be put on a map, and why — "do not guess
   * silently". `offStateMap` true: missing from both maps; false: on the state
   * map, missing from the county map only.
   */
  missing: Array<{ reason: MapGap; label: string; offStateMap: boolean; properties: number; units: number; occupied: number; money: number }>
}

const ELECTRONIC = ['card', 'ach'] as const
const r2 = (n: unknown) => Math.round(Number(n ?? 0) * 100) / 100
const n0 = (n: unknown) => Number(n ?? 0)

function methodLabel(method: string | null): string {
  if (!method) return 'Not recorded'
  // "Card" without the online / in-person split paidByLabel draws for a single
  // payment — this is every card payment together.
  if (method === 'card') return 'Card'
  return paidByLabel(method, null) ?? 'Other'
}

const IS_ELECTRONIC = (col: string) => `${col} IN (${ELECTRONIC.map(m => `'${m}'`).join(', ')})`

/**
 * 10/12 (Nic) review: paid-ahead money that came in on a tenant payment — an
 * overpayment's surplus. On a lease_prepaid_credits alias. Not 'reclassified'
 * (rent already counted, moved to credit when a stay was shortened); a typed-in
 * carry-forward has no source payment, so it never matches.
 */
const PAID_AHEAD_FROM_A_PAYMENT = (pc: string) =>
  `${pc}.source_remittance_id IS NOT NULL AND ${pc}.funded_by IS DISTINCT FROM 'reclassified'`

/** The method a dispute or bank return took money back from: always Stripe money. */
const REVERSAL_METHOD = (pr: string) => `CASE WHEN ${pr}.reversal_type = 'card_dispute' THEN 'card' ELSE 'ach' END`

/**
 * What one dispute record took off its bill that came out of a tenant
 * payment's own application, as LATERAL `taken(amt)`. A record on a bill
 * whose paid-ahead spend the dispute undid (applied → reversed, in the same
 * transaction, so released_at = the record's created_at) is that spend coming
 * back, not the bill's own money: the spend stops counting the moment it is
 * reversed (RENT_LINES part 2 counts only applied spends), and the money
 * behind it comes off where the dispute drained the credit (TENANT_MONEY_LINES).
 * Taking it off here as well would take it off twice.
 */
const TAKEN_FROM_THE_BILL = (pr: string) => `
  CROSS JOIN LATERAL (
    SELECT GREATEST(0, ${pr}.reversed_amount - COALESCE((
             SELECT SUM(cu.amount) FROM credit_uses cu
               JOIN lease_prepaid_credits pc ON pc.id = cu.prepaid_credit_id
              WHERE cu.payment_id = ${pr}.payment_id AND cu.status = 'reversed'
                AND cu.released_at = ${pr}.created_at AND ${PAID_AHEAD_FROM_A_PAYMENT('pc')}), 0)) AS amt
  ) taken`

/** The bill was paid through a settled tenant payment (it has an application on one). */
const PAID_THROUGH_A_PAYMENT = (p: string) => `EXISTS (
  SELECT 1 FROM remittance_applications xa JOIN tenant_remittances xr ON xr.id = xa.remittance_id
   WHERE xa.payment_id = ${p}.id AND xr.status = 'settled')`

/** A refund part that went back to the payer and stayed back (Stripe did not send it back). */
const REFUND_WENT_BACK = (rp: string) =>
  `${rp}.kind <> 'credit' AND ${rp}.status IN ('refunded', 'handed_back') AND ${rp}.reversed_at IS NULL`

/**
 * 10/12 (Nic): the property a rent bill (a payments alias) is for — the space
 * it billed, else its lease's space. NULL only for a bill with neither; the
 * heat map names that money rather than placing it (MapGap 'no_property').
 */
const BILL_PROPERTY = (p: string) => `(
  SELECT bu.property_id FROM units bu
   WHERE bu.id = COALESCE(${p}.unit_id, (SELECT bl.unit_id FROM leases bl WHERE bl.id = ${p}.lease_id)))`

/**
 * Every dollar of rent logged through GAM, once. Columns: method, at, amount,
 * remittance_id (the tenant payment the money came in on; NULL on a take-back
 * line, so it never adds to a payment count), property_id (10/12 (Nic): where
 * the rent was for, so the heat map's money adds up to the tile). See the
 * module header.
 */
const RENT_LINES = (): string => `
  -- 1. Money a settled tenant payment applied to a rent bill.
  SELECT r.payment_method AS method, COALESCE(r.settled_at, r.created_at) AS at,
         ra.amount_applied AS amount, r.id AS remittance_id, ${BILL_PROPERTY('p')} AS property_id
    FROM remittance_applications ra
    JOIN tenant_remittances r ON r.id = ra.remittance_id
    JOIN payments p ON p.id = ra.payment_id
   WHERE r.status = 'settled' AND p.type = 'rent' AND ${realLandlordSql('r.landlord_id')}
  UNION ALL
  -- 2. Money paid ahead on a tenant payment that a later rent bill spent, in
  --    that payment's method, on the day it was spent. A spend undone by a
  --    dispute is not money any more — unless GAM won the dispute, which put it back.
  SELECT sr.payment_method, cu.applied_at, cu.amount, sr.id, ${BILL_PROPERTY('p')}
    FROM credit_uses cu
    JOIN lease_prepaid_credits pc ON pc.id = cu.prepaid_credit_id
    JOIN tenant_remittances sr ON sr.id = pc.source_remittance_id
    JOIN payments p ON p.id = cu.payment_id
   WHERE p.type = 'rent' AND sr.status = 'settled' AND ${PAID_AHEAD_FROM_A_PAYMENT('pc')}
     AND (cu.status = 'applied' OR ${reversedUseOfWonDisputeSql('cu')})
     AND ${realLandlordSql('sr.landlord_id')}
  UNION ALL
  -- 3. What a dispute or bank return took back off a rent bill's money, on
  --    the day it was taken. The tenant is billed again; that re-payment is
  --    part 1 when it comes.
  SELECT ${REVERSAL_METHOD('pr')}, pr.created_at, -taken.amt, NULL::uuid, ${BILL_PROPERTY('p')}
    FROM payment_reversals pr
    JOIN payments p ON p.id = pr.payment_id
    ${TAKEN_FROM_THE_BILL('pr')}
   WHERE p.type = 'rent' AND pr.reversed_amount > 0 AND ${liveReversalSql('pr')}
     AND ${PAID_THROUGH_A_PAYMENT('p')} AND ${realLandlordSql('p.landlord_id')}
  UNION ALL
  -- 4. Rent given back to the tenant payment that paid it, on the day it went
  --    back: an early check-out's refund (earlyCheckOut leaseSources reads
  --    only rent), or the landlord refunding rent banked when a stay was
  --    shortened (a reclassified credit, or one whose anchor bill was rent).
  --    A refund of an overpayment's unspent surplus is left alone — that
  --    money never reached a rent bill, so it was never counted.
  --    Where: the stay's space, else the lease the money was for.
  SELECT r.payment_method, rp.refunded_at, -rp.toward_amount, NULL::uuid,
         (SELECT ru.property_id FROM units ru
           WHERE ru.id = COALESCE((SELECT k.unit_id FROM unit_bookings k WHERE k.id = rp.booking_id),
                                  (SELECT rl.unit_id FROM leases rl WHERE rl.id = COALESCE(pc.lease_id, r.lease_id))))
    FROM stay_refund_parts rp
    JOIN tenant_remittances r ON r.id = rp.remittance_id
    LEFT JOIN lease_prepaid_credits pc ON pc.id = rp.prepaid_credit_id
    LEFT JOIN payments sp ON sp.id = pc.source_payment_id
   WHERE ${REFUND_WENT_BACK('rp')} AND r.status = 'settled' AND ${realLandlordSql('r.landlord_id')}
     AND (rp.decision_id IS NOT NULL
          OR (rp.paid_ahead_choice_id IS NOT NULL AND pc.source_remittance_id IS NULL
              AND (pc.funded_by = 'reclassified' OR sp.type = 'rent')))`

/**
 * Every dollar tenants paid in through GAM, once. Columns: method, amount.
 * The settled tenant payments, less what disputes and refunds gave back of
 * them — the same take-backs as RENT_LINES, on every kind of bill.
 */
const TENANT_MONEY_LINES = (): string => `
  SELECT r.payment_method AS method, r.amount AS amount
    FROM tenant_remittances r
   WHERE r.status = 'settled' AND ${realLandlordSql('r.landlord_id')}
  UNION ALL
  -- A dispute or bank return: each bill's own money it took back.
  SELECT ${REVERSAL_METHOD('pr')}, -taken.amt
    FROM payment_reversals pr
    JOIN payments p ON p.id = pr.payment_id
    ${TAKEN_FROM_THE_BILL('pr')}
   WHERE pr.reversed_amount > 0 AND ${liveReversalSql('pr')}
     AND ${PAID_THROUGH_A_PAYMENT('p')} AND ${realLandlordSql('p.landlord_id')}
  UNION ALL
  -- ... and the paid-ahead money it drained (creditUse.clawBackDisputedCharge):
  -- the surplus never spent, plus every spend it undid. Read as incomeBasis reads it.
  SELECT sr.payment_method, -cu.amount
    FROM credit_uses cu
    JOIN lease_prepaid_credits pc ON pc.id = cu.prepaid_credit_id
    JOIN payment_reversals pr ON pr.id = cu.payment_reversal_id
    JOIN tenant_remittances sr ON sr.id = pc.source_remittance_id
   WHERE cu.status = 'applied' AND pc.voided_at IS NULL AND ${PAID_AHEAD_FROM_A_PAYMENT('pc')}
     AND sr.status = 'settled' AND ${liveReversalSql('pr')} AND ${realLandlordSql('sr.landlord_id')}
  UNION ALL
  -- A refund that went back to a tenant payment.
  SELECT r.payment_method, -rp.toward_amount
    FROM stay_refund_parts rp
    JOIN tenant_remittances r ON r.id = rp.remittance_id
   WHERE ${REFUND_WENT_BACK('rp')} AND r.status = 'settled' AND ${realLandlordSql('r.landlord_id')}`

/** Utility bills that went out to a resident — not drafts, not voided (services/moneyPredicates, shared with the monthly report). */
const UTILITY_BILL_SENT = utilityBillSentSql('b')
/** A stay that happened or is booked to happen (services/moneyPredicates). */
const STAY_HELD = stayHeldSql('k')
/** A background check that went to the screening company. */
const CHECK_RAN = `bc.status IN ('submitted', 'processing', 'complete', 'approved', 'denied', 'expired')`
/** Paid online by the applicant and not refunded (services/stripeCosts reads the same). */
const CHECK_PAID_ONLINE = `bc.applicant_payment_intent_id IS NOT NULL AND bc.amount_charged > 0 AND bc.refunded_at IS NULL`

/**
 * 10/12 (Nic) review: a property that has gone live, on a properties alias —
 * a lease, a billed month or a stay on it. A signup that never added a tenant
 * (a test account, a junk organic signup) is not on the platform yet.
 */
const LIVE_PROPERTY = (p: string) => `(
  EXISTS (SELECT 1 FROM leases le JOIN units lu ON lu.id = le.unit_id WHERE lu.property_id = ${p}.id)
  OR EXISTS (SELECT 1 FROM platform_fee_accruals a WHERE a.property_id = ${p}.id)
  OR EXISTS (SELECT 1 FROM unit_bookings k JOIN units ku ON ku.id = k.unit_id
              WHERE ku.property_id = ${p}.id AND ${STAY_HELD}))`

// ── Spaces, and which are occupied (10/12, Nic: A5 and H1) ───────────────────

/** Open spaces on a property (a properties id expression). A retired space is gone for good (S652). */
const OPEN_SPACES = (p: string) => `(SELECT COUNT(*)::int FROM units os_open
   WHERE os_open.property_id = ${p} AND os_open.retired_at IS NULL)`

/**
 * 10/12 (Nic, A5): "MATCH BILLING (occupied = billable evidence; vacant = rest;
 * retired excluded)". The open spaces on a property (an id expression) that are
 * OCCUPIED in `month` (a SQL date expression, the month's first day) exactly as
 * the platform fee counts them — billableUnits.occupiedSpacesSql, the query the
 * monthly bill and its nightly top-up run: a lease, a month stay, owner use or
 * a utility arrangement, each space once, and a space held at any point in the
 * month counts for the month (someone leaving mid-month does not refund it).
 * Not a unit's status: a status is a label somebody typed (S652).
 *
 * Nightly and weekly stays are billed by their nights after the month (nights
 * ÷ 30), never as spaces, so a site holding only those is not an occupied
 * space here either — the same as the bill.
 */
const OCCUPIED_SPACES = (p: string, month: string) => `(SELECT COUNT(*)::int
    FROM (${occupiedSpacesSql(p, month)}) occ_s
    JOIN units occ_u ON occ_u.id = occ_s.unit_id
   WHERE occ_u.retired_at IS NULL)`

/** The month the platform fee is billing now, by the Phoenix calendar the bill runs on ('YYYY-MM-01'). */
export function billingMonthNow(): string {
  return monthStartOf(todayIn(null))
}

export interface SpacesOccupied {
  /** 'YYYY-MM-01': the month counted. */
  month: string
  /** Open spaces on GAM: on a live property of a real landlord ("Spaces under management"). */
  spaces: number
  /** Of those, occupied this month as GAM bills them (OCCUPIED_SPACES). */
  occupied: number
  /** The rest. */
  vacant: number
}

/**
 * 10/12 (Nic, A5): the admin Overview's Active Units card — the spaces under
 * management (the Metrics tile's own set: live properties of real landlords),
 * how many are occupied the way GAM bills them, and the rest vacant.
 *
 * 10/12 (A5 review): the Onboarding page's Vacant Units tile reads the same
 * count ("match billing"), narrowed to a regular admin's portfolio
 * (`portfolioUserId`: landlords they closed or service, S567); without it,
 * every landlord — the Overview's figure. Two "vacant" numbers on one admin
 * was the defect.
 */
export async function spacesOccupied(
  month: string = billingMonthNow(),
  opts: { portfolioUserId?: string | null } = {},
): Promise<SpacesOccupied> {
  const [row] = await query<{ spaces: number; occupied: number }>(`
    SELECT COALESCE(SUM(${OPEN_SPACES('p.id')}), 0)::int AS spaces,
           COALESCE(SUM(${OCCUPIED_SPACES('p.id', '$1::date')}), 0)::int AS occupied
      FROM properties p
     WHERE ${realLandlordSql('p.landlord_id')} AND ${LIVE_PROPERTY('p')}
       AND ($2::uuid IS NULL OR EXISTS (
             SELECT 1 FROM landlords ld WHERE ld.id = p.landlord_id
                AND (ld.portfolio_manager_id = $2::uuid OR ld.service_manager_id = $2::uuid)))`,
    [month, opts.portfolioUserId ?? null])
  const spaces = n0(row?.spaces)
  const occupied = n0(row?.occupied)
  return { month, spaces, occupied, vacant: Math.max(0, spaces - occupied) }
}

// ── The heat map (10/12, Nic) ─────────────────────────────────────────────────

/**
 * 10/12 (Nic): one row per property on the heat map, plus one row (property_id
 * NULL) for rent on a bill with no space or lease on record. Units only on a
 * live property of a real landlord (the "Spaces under management" tile); money
 * on any property a rent dollar was logged on (the "Rent logged" tile, which
 * filters by the paying landlord, not by live) — so each map adds up to its tile.
 */
const MAP_ROWS = (): string => `
  WITH rent AS (
    SELECT x.property_id, SUM(x.amount) AS amount FROM (${RENT_LINES()}) x GROUP BY x.property_id
  ), place AS (
    SELECT p.id, p.state, p.latitude, p.longitude, p.address_verification, p.address_verified_at,
           (${realLandlordSql('p.landlord_id')} AND ${LIVE_PROPERTY('p')}) AS live
      FROM properties p
  ), moved AS (
    -- 10/12 (Nic) review: the last time each property's address was edited
    -- (routes/properties.ts writes 'property_address_changed'; rows older than
    -- 24 months move to audit_log_archive, jobs/complianceArchive).
    SELECT x.entity_id AS property_id, MAX(x.created_at) AS at FROM (
      SELECT entity_id, created_at FROM audit_log
       WHERE entity_type = 'property' AND action = 'property_address_changed'
      UNION ALL
      SELECT entity_id, created_at FROM audit_log_archive
       WHERE entity_type = 'property' AND action = 'property_address_changed'
    ) x GROUP BY x.entity_id
  )
  SELECT pl.id AS property_id, pl.state, pl.latitude::float8 AS lat, pl.longitude::float8 AS lng,
         CASE WHEN pl.live THEN ${OPEN_SPACES('pl.id')} ELSE 0 END AS units,
         -- 10/12 (Nic, H1): the same spaces, occupied this month as GAM bills them.
         CASE WHEN pl.live THEN ${OCCUPIED_SPACES('pl.id', '$1::date')} ELSE 0 END AS occupied,
         COALESCE(rent.amount, 0)::text AS money,
         -- 10/12 (Nic) review: a map location is only trusted for the address
         -- it was found for. An address edit does not look the location up
         -- again, and a failed look-up keeps the old point
         -- (addressVerification.verifyPropertyAddress COALESCEs it), so the
         -- point is fresh only when a look-up that found the place
         -- ('geocoded' or 'parcel') ran after the last edit. An 'unverified'
         -- stamp is a try that found nothing; the point on file is older.
         (mv.at IS NOT NULL
          AND (pl.address_verified_at IS NULL OR pl.address_verified_at <= mv.at
               OR pl.address_verification NOT IN ('geocoded', 'parcel'))) AS location_stale
    FROM place pl
    LEFT JOIN rent ON rent.property_id = pl.id
    LEFT JOIN moved mv ON mv.property_id = pl.id
   WHERE pl.live OR rent.property_id IS NOT NULL
  UNION ALL
  SELECT NULL, NULL, NULL, NULL, 0, 0, rent.amount::text, FALSE FROM rent WHERE rent.property_id IS NULL`

interface MapRow {
  property_id: string | null
  state: string | null
  lat: number | null
  lng: number | null
  units: number
  /** 10/12 (Nic, H1): of `units`, occupied this month as GAM bills them (OCCUPIED_SPACES). */
  occupied: number
  money: string
  /** 10/12 (Nic) review: the address was edited after its map location was found (MAP_ROWS). */
  location_stale: boolean
}

/** Census FIPS state codes (fixed federal standard), by the two-letter code properties.state holds. */
const STATE_FIPS: Readonly<Record<string, string>> = {
  AL: '01', AK: '02', AZ: '04', AR: '05', CA: '06', CO: '08', CT: '09', DE: '10', DC: '11', FL: '12',
  GA: '13', HI: '15', ID: '16', IL: '17', IN: '18', IA: '19', KS: '20', KY: '21', LA: '22', ME: '23',
  MD: '24', MA: '25', MI: '26', MN: '27', MS: '28', MO: '29', MT: '30', NE: '31', NV: '32', NH: '33',
  NJ: '34', NM: '35', NY: '36', NC: '37', ND: '38', OH: '39', OK: '40', OR: '41', PA: '42', RI: '44',
  SC: '45', SD: '46', TN: '47', TX: '48', UT: '49', VT: '50', VA: '51', WA: '53', WV: '54', WI: '55',
  WY: '56', AS: '60', GU: '66', MP: '69', PR: '72', VI: '78',
}
/** US_STATE_NAME (@gam/shared) covers the 50 states and DC; the territories GAM's address formatter accepts. */
const TERRITORY_NAME: Readonly<Record<string, string>> = {
  AS: 'American Samoa', GU: 'Guam', MP: 'Northern Mariana Islands', PR: 'Puerto Rico', VI: 'U.S. Virgin Islands',
}
/** For tests: the state table checked against the county shapes' own state names. */
export const MAP_STATE_FIPS = STATE_FIPS

const MAP_GAP_LABEL: Readonly<Record<MapGap, string>> = {
  unknown_state: 'the state on its address is not a U.S. state or territory',
  no_property: 'rent on a bill with no space or lease on record',
  no_location: 'no map location on file for its address',
  stale_location: 'its address changed and no map location has been found for the new address',
  outside_map: 'its map location is not inside any U.S. county',
  wrong_state: 'its map location is in a different state than its address',
  no_county_shapes: 'the county map could not be read on the server',
}
const OFF_STATE_MAP: ReadonlySet<MapGap> = new Set<MapGap>(['unknown_state', 'no_property'])

/**
 * 10/12 (Nic): the Census county shapes, for "which county is this property
 * in". The file beside this one is us-atlas@3.0.1 counties-10m.json, copied
 * unchanged (ISC; Census Bureau cartographic boundaries, 2017 edition,
 * simplified — the admin page draws the same edition from the same package, so
 * a county code here always has a shape there). Read once, on the first map
 * build, never at start-up; nothing is fetched from anywhere. Simplified edges
 * mean a property within a few hundred yards of a county line can land in the
 * neighbor — fine for a heat map, not for anything legal or billed.
 *
 * Decoded here rather than with topojson-client: the API carries no map
 * library, and a TopoJSON polygon is only its arcs, delta-decoded and joined.
 */
interface CountyShape {
  fips: string
  name: string
  /** [west, south, east, north] — skips the ray test for nearly every county. */
  box: [number, number, number, number]
  /** Polygons → rings → flat [lng, lat, lng, lat, …]. */
  polygons: number[][][]
}

function decodeCounties(topo: any): CountyShape[] {
  const [sx, sy] = topo.transform.scale
  const [tx, ty] = topo.transform.translate
  const arcs: number[][] = topo.arcs.map((arc: number[][]) => {
    const out: number[] = []
    let x = 0, y = 0
    for (const [dx, dy] of arc) { x += dx; y += dy; out.push(x * sx + tx, y * sy + ty) }
    return out
  })
  const ring = (ids: number[]): number[] => {
    const out: number[] = []
    for (const id of ids) {
      const a = arcs[id < 0 ? ~id : id]
      const n = a.length / 2
      // Each arc after the first starts where the last one ended; skip the repeat.
      for (let k = out.length ? 1 : 0; k < n; k++) {
        const j = id < 0 ? n - 1 - k : k
        out.push(a[2 * j], a[2 * j + 1])
      }
    }
    return out
  }
  return topo.objects.counties.geometries.map((g: any): CountyShape => {
    const parts: number[][][] = g.type === 'Polygon' ? [g.arcs] : g.type === 'MultiPolygon' ? g.arcs : []
    const polygons = parts.map(rings => rings.map(ring))
    const box: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity]
    for (const poly of polygons) {
      const outer = poly[0] ?? []
      for (let i = 0; i < outer.length; i += 2) {
        box[0] = Math.min(box[0], outer[i]); box[2] = Math.max(box[2], outer[i])
        box[1] = Math.min(box[1], outer[i + 1]); box[3] = Math.max(box[3], outer[i + 1])
      }
    }
    return { fips: String(g.id), name: String(g.properties?.name ?? ''), box, polygons }
  })
}

/** Even-odd across every ring of one polygon, so a point in a hole is outside it. */
function insidePolygon(x: number, y: number, rings: number[][]): boolean {
  let inside = false
  for (const r of rings) {
    for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
      const xi = r[i], yi = r[i + 1], xj = r[j], yj = r[j + 1]
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
    }
  }
  return inside
}

let countyShapes: Promise<CountyShape[]> | null = null
function loadCountyShapes(): Promise<CountyShape[]> {
  if (!countyShapes) {
    countyShapes = import('./platformMetrics.counties-10m.json')
      .then(m => decodeCounties((m as any).default ?? m))
      // A failed read is retried on the next build, not remembered.
      .catch(e => { countyShapes = null; throw e })
  }
  return countyShapes
}

/** 10/12 (Nic): the county a map location falls in, or null when it is in none. */
export async function countyAt(lat: number, lng: number): Promise<{ fips: string; name: string } | null> {
  const shapes = await loadCountyShapes()
  for (const c of shapes) {
    if (lng < c.box[0] || lng > c.box[2] || lat < c.box[1] || lat > c.box[3]) continue
    if (c.polygons.some(poly => insidePolygon(lng, lat, poly))) return { fips: c.fips, name: c.name }
  }
  return null
}

/**
 * 10/12 (Nic): the per-state and per-county totals. A property goes on the
 * state map by the state on its address, and on the county map by its map
 * location — only when that location is inside a county of the same state.
 * Everything else is counted in `missing` with the reason, so the page can say
 * what is not on the map instead of quietly drawing less.
 */
async function buildPlatformMap(rows: MapRow[]): Promise<PlatformMap> {
  const states = new Map<string, MapArea & { abbr: string }>()
  const counties = new Map<string, MapArea & { state: string }>()
  const missing = new Map<MapGap, PlatformMap['missing'][number]>()
  // 10/12 (Nic, H1): what one property adds — its spaces, how many of them are
  // occupied as GAM bills them, and the rent logged on it.
  type Counts = { units: number; occupied: number; money: number }
  const miss = (reason: MapGap, n: Counts, isProperty: boolean) => {
    const m = missing.get(reason)
      ?? { reason, label: MAP_GAP_LABEL[reason], offStateMap: OFF_STATE_MAP.has(reason), properties: 0, units: 0, occupied: 0, money: 0 }
    m.properties += isProperty ? 1 : 0
    m.units += n.units
    m.occupied += n.occupied
    m.money += n.money
    missing.set(reason, m)
  }
  const add = <T extends MapArea>(areas: Map<string, T>, fips: string, blank: () => T, n: Counts) => {
    const a = areas.get(fips) ?? blank()
    a.properties += 1
    a.units += n.units
    a.occupied += n.occupied
    a.money += n.money
    areas.set(fips, a)
  }

  let shapesReadable = true
  try { await loadCountyShapes() } catch (e) {
    shapesReadable = false
    logger.error({ err: e }, '[platformMetrics] county shapes could not be read; the county map is empty')
  }

  for (const row of rows) {
    const n: Counts = { units: n0(row.units), occupied: n0(row.occupied), money: Number(row.money ?? 0) }
    if (!row.property_id) { miss('no_property', { units: 0, occupied: 0, money: n.money }, false); continue }
    const abbr = formatState(row.state ?? '')
    const fips = STATE_FIPS[abbr]
    if (!fips) { miss('unknown_state', n, true); continue }
    add(states, fips, () => ({ fips, abbr, name: US_STATE_NAME[abbr] ?? TERRITORY_NAME[abbr] ?? abbr,
                               units: 0, occupied: 0, money: 0, properties: 0 }), n)

    if (!shapesReadable) { miss('no_county_shapes', n, true); continue }
    if (row.lat == null || row.lng == null) { miss('no_location', n, true); continue }
    // 10/12 (Nic) review: a point found for the old address would put the
    // property in the old county with no warning — named, never placed.
    if (row.location_stale) { miss('stale_location', n, true); continue }
    const county = await countyAt(Number(row.lat), Number(row.lng))
    if (!county) { miss('outside_map', n, true); continue }
    if (county.fips.slice(0, 2) !== fips) { miss('wrong_state', n, true); continue }
    add(counties, county.fips, () => ({ fips: county.fips, name: county.name, state: abbr,
                                        units: 0, occupied: 0, money: 0, properties: 0 }), n)
  }

  const done = <T extends MapArea>(a: T): T => ({ ...a, money: r2(a.money) })
  const byFips = (a: { fips: string }, b: { fips: string }) => a.fips.localeCompare(b.fips)
  return {
    states: [...states.values()].map(done).sort(byFips),
    counties: [...counties.values()].map(done).sort(byFips),
    missing: [...missing.values()].map(m => ({ ...m, money: r2(m.money) })),
  }
}

export async function computePlatformMetrics(): Promise<PlatformMetrics> {
  const realR = realLandlordSql('r.landlord_id')
  // 10/12 (Nic, H1): the month whose occupied spaces the map and the tile count.
  const month = billingMonthNow()
  const [
    rentRows, monthRows, tenantMoney, paid, busiest, register, stayDeposits, checks, payouts,
    footprint, paperwork, operations, growth, bill, mapRows,
  ] = await Promise.all([
    query<{ method: string | null; amount: string; payments: number }>(`
      SELECT x.method,
             COALESCE(SUM(x.amount), 0)::text AS amount,
             COUNT(DISTINCT x.remittance_id)::int AS payments
        FROM (${RENT_LINES()}) x
       GROUP BY x.method`),
    query<{ month: string; electronic: string; by_hand: string }>(`
      SELECT to_char(x.at, 'YYYY-MM') AS month,
             COALESCE(SUM(x.amount) FILTER (WHERE ${IS_ELECTRONIC('x.method')}), 0)::text AS electronic,
             COALESCE(SUM(x.amount) FILTER (WHERE x.method IS NULL
                                               OR NOT ${IS_ELECTRONIC('x.method')}), 0)::text AS by_hand
        FROM (${RENT_LINES()}) x
       GROUP BY 1 ORDER BY 1`),
    // 10/12 (Nic) review: the money tenants paid in, less what disputes and
    // refunds gave back (TENANT_MONEY_LINES). The count, average, middle and
    // biggest below describe the payments as they were made.
    query<{ amount: string; electronic: string }>(`
      SELECT COALESCE(SUM(x.amount), 0)::text AS amount,
             COALESCE(SUM(x.amount) FILTER (WHERE ${IS_ELECTRONIC('x.method')}), 0)::text AS electronic
        FROM (${TENANT_MONEY_LINES()}) x`),
    query<any>(`
      SELECT COUNT(*)::int AS n,
             AVG(r.amount)::text AS average,
             (percentile_cont(0.5) WITHIN GROUP (ORDER BY r.amount))::text AS median,
             MAX(r.amount)::text AS biggest,
             MAX(r.amount) FILTER (WHERE ${IS_ELECTRONIC('r.payment_method')})::text AS biggest_electronic,
             to_char(MIN(COALESCE(r.settled_at, r.created_at)), 'YYYY-MM-DD') AS first_day
        FROM tenant_remittances r
       WHERE r.status = 'settled' AND ${realR}`),
    // The day the most payments were made (the day each was made, not the day
    // a bank payment finished clearing).
    query<{ day: string; n: number; amount: string }>(`
      SELECT to_char(r.created_at, 'YYYY-MM-DD') AS day, COUNT(*)::int AS n, SUM(r.amount)::text AS amount
        FROM tenant_remittances r
       WHERE r.status = 'settled' AND ${realR}
       GROUP BY 1 ORDER BY 2 DESC, SUM(r.amount) DESC LIMIT 1`),
    query<{ n: number; amount: string }>(`
      SELECT COUNT(*)::int AS n, COALESCE(SUM(pt.total - pt.surcharge), 0)::text AS amount
        FROM pos_transactions pt
       WHERE pt.status <> 'voided' AND pt.payment_method IN ('cash', 'card', 'card_on_file')
         AND ${realLandlordSql('pt.landlord_id')}`),
    query<{ n: number; amount: string }>(`
      SELECT COUNT(*)::int AS n, COALESCE(SUM(sp.toward_stay), 0)::text AS amount
        FROM stay_payments sp
       WHERE sp.kind = 'site_deposit' AND ${realLandlordSql('sp.landlord_id')}`),
    // 10/12 (Nic) review: what the applicant paid less the card fee on top
    // ("card fees not included"): the fee GAM booked for the check, else the
    // fee worked back out of the charge (stripeCosts.screeningFeeInside, the
    // same fallback GAM's own-money check uses). Book = actual fees.
    query<{ ran: number; paid_n: number; paid: string }>(`
      SELECT COUNT(*) FILTER (WHERE ${CHECK_RAN})::int AS ran,
             COUNT(*) FILTER (WHERE ${CHECK_PAID_ONLINE})::int AS paid_n,
             COALESCE(SUM(bc.amount_charged - COALESCE(fee.booked,
                        ROUND(bc.amount_charged - (bc.amount_charged - ${PROCESSING_FEES.CARD_FLAT})
                                                  / (1 + ${PROCESSING_FEES.CARD_PCT}), 2)))
                      FILTER (WHERE ${CHECK_PAID_ONLINE}), 0)::text AS paid
        FROM background_checks bc
        LEFT JOIN LATERAL (
          SELECT MAX(l.customer_fee_charged) AS booked FROM platform_revenue_ledger l
           WHERE l.type = 'banking_spread' AND l.reference_type = 'background_check' AND l.reference_id = bc.id
        ) fee ON TRUE
       WHERE ${realLandlordSql('bc.landlord_id', { poolIsReal: true })}`),
    query<{ n: number; amount: string }>(`
      SELECT COUNT(*)::int AS n, COALESCE(SUM(t.amount), 0)::text AS amount
        FROM platform_transfer_intents t
       WHERE t.status = 'transferred' AND t.landlord_id IS NOT NULL
         AND ${realLandlordSql('t.landlord_id')}`),
    query<any>(`
      SELECT
        -- A landlord is a person who brought a property (S650, the Overview's own count)
        -- that has gone live (10/12 review: LIVE_PROPERTY — the same below).
        (SELECT COUNT(DISTINCT l.user_id)::int
           FROM landlords l JOIN users u ON u.id = l.user_id
          WHERE u.email NOT LIKE '%@gam.internal'
            AND ${realLandlordSql('l.id')}
            AND EXISTS (SELECT 1 FROM properties p WHERE p.landlord_id = l.id AND ${LIVE_PROPERTY('p')})) AS landlords,
        (SELECT COUNT(*)::int FROM properties p
          WHERE ${realLandlordSql('p.landlord_id')} AND ${LIVE_PROPERTY('p')}) AS properties,
        (SELECT COUNT(DISTINCT upper(trim(p.state)))::int FROM properties p
          WHERE ${realLandlordSql('p.landlord_id')} AND ${LIVE_PROPERTY('p')}) AS states,
        (SELECT COUNT(DISTINCT lower(trim(p.city)) || '|' || upper(trim(p.state)))::int FROM properties p
          WHERE ${realLandlordSql('p.landlord_id')} AND ${LIVE_PROPERTY('p')}) AS cities,
        -- A retired space is gone for good (S652 retire & replace).
        (SELECT COUNT(*)::int FROM units u JOIN properties p ON p.id = u.property_id
          WHERE u.retired_at IS NULL AND ${realLandlordSql('p.landlord_id')} AND ${LIVE_PROPERTY('p')}) AS units,
        (SELECT COUNT(*)::int FROM leases le
          WHERE le.status = 'active' AND ${realLandlordSql('le.landlord_id')}) AS households,
        (SELECT COUNT(DISTINCT lt.tenant_id)::int FROM lease_tenants lt JOIN leases le ON le.id = lt.lease_id
          WHERE le.status = 'active' AND lt.status = 'active' AND ${realLandlordSql('le.landlord_id')}) AS residents,
        -- Same rent roll the daily growth snapshot keeps (services/growthSnapshots).
        (SELECT COALESCE(SUM(le.rent_amount), 0)::text FROM leases le
          WHERE le.status = 'active' AND ${realLandlordSql('le.landlord_id')}) AS rent_roll`),
    query<any>(`
      SELECT
        (SELECT COUNT(*)::int FROM lease_documents d
          WHERE d.status = 'completed' AND d.document_type = 'original_lease'
            AND ${realLandlordSql('d.landlord_id')}) AS leases_signed,
        (SELECT COUNT(*)::int FROM lease_documents d
          WHERE d.status = 'completed' AND ${realLandlordSql('d.landlord_id')}) AS documents_signed,
        (SELECT COUNT(*)::int FROM lease_document_signers s JOIN lease_documents d ON d.id = s.document_id
          WHERE s.signed_at IS NOT NULL AND ${realLandlordSql('d.landlord_id')}) AS signatures`),
    query<any>(`
      SELECT
        (SELECT COUNT(*)::int FROM utility_meter_readings mr
           JOIN utility_meters m ON m.id = mr.meter_id
           JOIN properties p ON p.id = m.property_id
          WHERE ${realLandlordSql('p.landlord_id')}) AS meter_readings,
        (SELECT COUNT(*)::int FROM utility_bills b
          WHERE ${UTILITY_BILL_SENT} AND ${realLandlordSql('b.landlord_id')}) AS utility_bills,
        (SELECT COALESCE(SUM(b.charge_amount + b.tax_amount), 0)::text FROM utility_bills b
          WHERE ${UTILITY_BILL_SENT} AND ${realLandlordSql('b.landlord_id')}) AS utility_billed,
        (SELECT COALESCE(SUM(b.usage_amount), 0)::text FROM utility_bills b
          WHERE b.utility_type = 'electric' AND ${UTILITY_BILL_SENT}
            AND ${realLandlordSql('b.landlord_id')}) AS electric_kwh,
        (SELECT COUNT(*)::int FROM unit_bookings k
          WHERE ${STAY_HELD} AND ${realLandlordSql('k.landlord_id')}) AS stays,
        (SELECT COALESCE(SUM(k.nights), 0)::int FROM unit_bookings k
          WHERE ${STAY_HELD} AND ${realLandlordSql('k.landlord_id')}) AS stay_nights,
        (SELECT COUNT(*)::int FROM home_sale_contracts h
          WHERE h.status IN ('active', 'paid_off') AND ${realLandlordSql('h.landlord_id')}) AS home_sales,
        (SELECT COALESCE(SUM(h.sale_price), 0)::text FROM home_sale_contracts h
          WHERE h.status IN ('active', 'paid_off') AND ${realLandlordSql('h.landlord_id')}) AS home_sales_value,
        (SELECT COUNT(*)::int FROM work_trade_agreements w
          WHERE ${realLandlordSql('w.landlord_id')}) AS work_trade`),
    query<any>(`
      SELECT to_char(snapshot_date, 'YYYY-MM-DD') AS date, monthly_rent_roll::text AS rent_roll,
             units, occupied_units, active_tenants
        FROM platform_growth_snapshots
       WHERE state = '*' AND city = '*'
       ORDER BY snapshot_date`),
    platformFeeBill(),
    // 10/12 (Nic): the heat map's rows, one per property (MAP_ROWS).
    query<MapRow>(MAP_ROWS(), [month]),
  ])

  const byMethod: RentByMethod[] = rentRows
    .map(r => ({
      method: r.method ?? 'not_recorded',
      label: methodLabel(r.method),
      electronic: (ELECTRONIC as readonly string[]).includes(r.method ?? ''),
      amount: r2(r.amount),
      payments: n0(r.payments),
    }))
    .sort((a, b) => b.amount - a.amount)
  const card = byMethod.find(m => m.method === 'card')?.amount ?? 0
  const ach = byMethod.find(m => m.method === 'ach')?.amount ?? 0
  const electronicTotal = r2(card + ach)
  const loggedTotal = r2(byMethod.reduce((s, m) => s + m.amount, 0))

  const p = paid[0] ?? {}
  const tenantAmount = r2(tenantMoney[0]?.amount)
  const tenantElectronic = r2(tenantMoney[0]?.electronic)
  const moneyParts = {
    tenantPayments: { amount: tenantAmount, count: n0(p.n), electronic: tenantElectronic, byHand: r2(tenantAmount - tenantElectronic) },
    registerSales: { amount: r2(register[0]?.amount), count: n0(register[0]?.n) },
    stayDepositsOnline: { amount: r2(stayDeposits[0]?.amount), count: n0(stayDeposits[0]?.n) },
    backgroundChecks: { amount: r2(checks[0]?.paid), count: n0(checks[0]?.paid_n) },
  }
  const f = footprint[0] ?? {}
  const occupiedTotal = mapRows.reduce((sum, r) => sum + n0(r.occupied), 0)
  const d = paperwork[0] ?? {}
  const o = operations[0] ?? {}
  const b = busiest[0]

  return {
    asOf: new Date().toISOString(),
    firstPaymentOn: p.first_day ?? null,
    rent: {
      electronic: {
        total: electronicTotal, card, ach,
        payments: byMethod.filter(m => m.electronic).reduce((s, m) => s + m.payments, 0),
      },
      logged: {
        total: loggedTotal,
        byHand: r2(loggedTotal - electronicTotal),
        payments: byMethod.reduce((s, m) => s + m.payments, 0),
        byMethod,
      },
      byMonth: monthRows.map(m => ({ month: m.month, electronic: r2(m.electronic), byHand: r2(m.by_hand) })),
    },
    moneyIn: {
      total: r2(moneyParts.tenantPayments.amount + moneyParts.registerSales.amount
        + moneyParts.stayDepositsOnline.amount + moneyParts.backgroundChecks.amount),
      ...moneyParts,
    },
    payouts: { amount: r2(payouts[0]?.amount), count: n0(payouts[0]?.n) },
    payments: {
      count: n0(p.n),
      average: r2(p.average),
      median: r2(p.median),
      biggest: r2(p.biggest),
      biggestElectronic: r2(p.biggest_electronic),
      busiestDay: b ? { date: b.day, count: n0(b.n), amount: r2(b.amount) } : null,
    },
    footprint: {
      landlords: n0(f.landlords),
      properties: n0(f.properties),
      states: n0(f.states),
      cities: n0(f.cities),
      units: n0(f.units),
      households: n0(f.households),
      residents: n0(f.residents),
      rentRollMonthly: r2(f.rent_roll),
      spacesBilled: bill.spaces,
      spacesBilledMonth: bill.month,
      // Live properties only carry units and occupied spaces in MAP_ROWS, so
      // these are the tile's own set, and the map adds up to them.
      occupiedSpaces: occupiedTotal,
      vacantSpaces: Math.max(0, n0(f.units) - occupiedTotal),
      occupiedMonth: month,
    },
    paperwork: {
      leasesSigned: n0(d.leases_signed),
      documentsSigned: n0(d.documents_signed),
      signatures: n0(d.signatures),
    },
    operations: {
      meterReadings: n0(o.meter_readings),
      utilityBills: n0(o.utility_bills),
      utilityBilled: r2(o.utility_billed),
      electricKwh: Math.round(Number(o.electric_kwh ?? 0)),
      stays: n0(o.stays),
      stayNights: n0(o.stay_nights),
      homeSales: n0(o.home_sales),
      homeSalesValue: r2(o.home_sales_value),
      backgroundChecksRun: n0(checks[0]?.ran),
      workTradeAgreements: n0(o.work_trade),
    },
    growth: growth.map(g => ({
      date: g.date, rentRoll: r2(g.rent_roll), units: n0(g.units), occupied: n0(g.occupied_units), tenants: n0(g.active_tenants),
    })),
    map: await buildPlatformMap(mapRows),
  }
}

/**
 * A minute is plenty: these are all-time totals, and the page polls. The cache
 * keeps a dashboard left open from re-running every aggregate on every poll
 * once there are 11,000 units' worth of payments under them.
 */
const TTL_MS = 60_000
let cached: { at: number; data: PlatformMetrics } | null = null

export async function platformMetrics(opts: { fresh?: boolean } = {}): Promise<PlatformMetrics> {
  if (!opts.fresh && cached && Date.now() - cached.at < TTL_MS) return cached.data
  const data = await computePlatformMetrics()
  cached = { at: Date.now(), data }
  return data
}

/** Tests seed between calls; they start from nothing. */
export function clearPlatformMetricsCache(): void { cached = null; lifetimeCached = null }

// ══ 10/13 (Nic): money billed and collected, tenants ever, default rate, ages ══
//
// Nic (10/13 evening): "Money metrics, all time, BILLED AND COLLECTED:
// utilities billed back BY UTILITY + total; rent; total platform fees."
// "Total tenants ever on GAM: every person on a lease, counted once (even if
// they come back)." "Landlords' DEFAULT RATE through GAM: months left unpaid by
// tenants who moved out owing ÷ all calendar months of rent billed — AS A
// FRACTION of a month ($300 of $460 = 0.65), plus a DOLLAR % too, plus where
// defaults happen by RENT RANGE. Paying later does NOT take it off." ("No,
// stays counted.") "Ages: every person on a lease; average age toggled by
// property, oldest/youngest, age at default."
//
// Served on its own (GET /admin/metrics/lifetime) so the page's first numbers
// never wait on these, and a failure here never blanks them.
//
// MONEY reads the landlords' own report facts (services/incomeBasis, Money
// billed, from the money records): Billed = each bill due through today, less
// credits given; Collected = of that, what was paid, covered by money paid
// ahead or deposit interest, or kept from a deposit — the same Charged and
// Collected every landlord report shows, by the same categories (the utility a
// bill was for: its utility bill, else its trash fee, else PROPANE, else the
// utility its note names). Rent is "Lot/space rent". Platform fees are GAM's
// monthly fee from GAM's revenue book (platformFeeBill PLATFORM_FEE_LINES_SQL),
// collected unless its charge to the landlord is still open — the Recurring
// Revenue card's own rule, all months together.
//
// PEOPLE ON A LEASE (TENANTS_EVER, AGES). A lease counts once it has started
// (start date today or before) and was not closed as never moved in
// (lib/unwindIssuedLease NEVER_MOVED_IN_REASON); a tenant on it counts unless
// their place on it was void or never joined (pending_add). A tenant is one
// person however many leases they had — leaving and coming back is still one.
// An occupant listed on a lease (lease_occupants) has no account, so one
// listed on two leases is recognized by name and birthday — by name at the
// same landlord when no birthday is on file (never across landlords) — and an
// occupant whose name is a tenant's on the same lease is that tenant.
//
// THE DEFAULT RATE (DEFAULT_LEASES). A household MOVED OUT when its lease
// ended (expired or terminated, not closed as never moved in) and nobody on it
// went on living under the same landlord: not renewed (no lease supersedes
// it), and no lease for any of them with that landlord in force the day after
// it ended. Coming back later does not undo the move-out. What it left unpaid
// is its RENT still open at the moment the lease ended (terminated_at — every
// real end stamps it), for rent due by that day (or by its end date, when the
// lease-end run ended it the night after) — read off each bill's own history,
// so a payment made afterward never takes it off:
//   - a bill paid by then is paid: settled by then, or settled through a
//     payment the tenant started by then (a bank payment still clearing);
//   - otherwise what credit had paid of it by then, and work-trade labor,
//     come off; the rest was unpaid (a line labor is still paying, its
//     work-trade month open, is not money billed and is left out);
//   - a bill a dispute reopened counts as the reopened copy only, and only if
//     the dispute came before the move-out (one after it took back money that
//     had been paid); a voided bill was never owed.
// Rent the deposit covered at move-out is still rent left unpaid (the deposit
// is settled after the lease ends).
// Months left unpaid = that rent ÷ the lease's monthly rent ($300 of $460 =
// 0.65). Rent billed is the MONEY section's own rent Billed, lease by lease
// (the same report facts — never a second "rent billed" on the page): rent $
// billed = each lease's rent billed through today, less what work trade and
// credits given covered; calendar months of rent billed = each lease's months
// with rent billed in them (a prorated month is a month; a month work trade
// covered in full billed no money, so it is not one).

/** 10/13 (Nic): "where defaults happen by RENT RANGE" — the bands, by the lease's monthly rent. */
export const RENT_BANDS: ReadonlyArray<{ min: number; max: number | null }> = [
  { min: 0, max: 300 }, { min: 300, max: 400 }, { min: 400, max: 500 }, { min: 500, max: 600 },
  { min: 600, max: 800 }, { min: 800, max: 1000 }, { min: 1000, max: 1500 }, { min: 1500, max: 2000 },
  { min: 2000, max: null },
]
const dollars0 = (n: number) => `$${n.toLocaleString('en-US')}`
/** "Under $300", "$400 to $499", "$2,000 and up". */
export function rentBandLabel(b: { min: number; max: number | null }): string {
  if (b.max == null) return `${dollars0(b.min)} and up`
  if (b.min <= 0) return `Under ${dollars0(b.max)}`
  return `${dollars0(b.min)} to ${dollars0(b.max - 1)}`
}
export function rentBandOf(rent: number): { min: number; max: number | null } {
  return RENT_BANDS.find(b => rent >= b.min && (b.max == null || rent < b.max)) ?? RENT_BANDS[0]
}

export interface BilledCollected { billed: number; collected: number; owed: number }
export interface AgeSummary {
  /** People counted (each once). */
  people: number
  /** Of them, with a birthday on file. */
  withBirthday: number
  /** In whole years, to one decimal; null when nobody has a birthday on file. */
  average: number | null
  youngest: number | null
  oldest: number | null
}
export interface RentRangeDefaults {
  label: string
  min: number
  max: number | null
  leases: number
  monthsBilled: number
  rentBilled: number
  householdsOwing: number
  monthsUnpaid: number
  dollarsUnpaid: number
  /** monthsUnpaid ÷ monthsBilled; null when nothing was billed. */
  rate: number | null
  /** dollarsUnpaid ÷ rentBilled; null when nothing was billed. */
  dollarRate: number | null
}
export interface PlatformLifetimeMetrics {
  asOf: string
  /** 'YYYY-MM-DD' (GAM's calendar): bills due through this day. */
  through: string
  money: {
    rent: BilledCollected & { label: string }
    utilities: BilledCollected & { byUtility: Array<BilledCollected & { utility: string; label: string }> }
    platformFees: BilledCollected
  }
  tenants: {
    /** Every person ever on a lease on GAM, once. */
    ever: number
    /** Of them: tenants (signers, with an account) and occupants listed on a lease. */
    tenants: number
    occupants: number
    /** On an active lease today. */
    onALeaseNow: number
    /** The rest: moved on. */
    movedOn: number
  }
  defaults: Omit<RentRangeDefaults, 'label' | 'min' | 'max'> & { byRentRange: RentRangeDefaults[] }
  ages: AgeSummary & {
    byProperty: Array<AgeSummary & { propertyId: string; name: string }>
    /** Age on the day their household moved out owing, each household once per person. */
    atDefault: AgeSummary
  }
}

const sqlLit = (s: string) => `'${s.replace(/'/g, "''")}'`

/**
 * 10/13 (Nic): a lease whose people count as on GAM, on a leases alias: a real
 * landlord's, started by `today` (a SQL date), not closed as never moved in.
 * An ended lease with no end moment stamped never went into force: every
 * real end stamps terminated_at (the lease-end run, a termination, the
 * never-moved-in close), while discarding an unsigned draft or cancelling a
 * reservation's draft lease ends paperwork only, with a bare status change.
 */
const COUNTED_LEASE = (l: string, today: string) => `(${realLandlordSql(`${l}.landlord_id`)}
  AND ${l}.status IN ('pending', 'active', 'expired', 'terminated')
  AND (${l}.status IN ('pending', 'active') OR ${l}.terminated_at IS NOT NULL)
  AND ${l}.start_date <= ${today}
  AND ${l}.termination_reason IS DISTINCT FROM ${sqlLit(NEVER_MOVED_IN_REASON)})`

/** A tenant's place on a lease they were really on: not void, not an add that never joined. */
const WAS_ON_LEASE = (lt: string) => `${lt}.status IN ('active', 'pending_remove', 'removed')`

/**
 * 10/13 (Nic): an occupant listed on a lease (a lease_occupants alias) who is
 * not one of its tenants under another listing — a tenant whose name is also
 * on the occupant list is counted once, as the tenant.
 */
const OCCUPANT_NOT_A_TENANT = (o: string) => `(${normalizeNameSql(`${o}.full_name`)} <> ''
  AND NOT EXISTS (
    SELECT 1 FROM lease_tenants xlt
      JOIN tenants xt ON xt.id = xlt.tenant_id
      JOIN users xu ON xu.id = xt.user_id
     WHERE xlt.lease_id = ${o}.lease_id AND ${WAS_ON_LEASE('xlt')}
       AND ${normalizeNameSql(`xu.first_name || ' ' || xu.last_name`)} = ${normalizeNameSql(`${o}.full_name`)}))`

/**
 * 10/13 (Nic): everyone on a lease, one row per person per lease: person (a
 * key: one per tenant; one per occupant as recognized above), kind, lease,
 * property, birthday, and whether they are on an active lease now. $1 = today.
 */
const PEOPLE_ROWS = (): string => `
  SELECT 'tenant:' || lt.tenant_id::text AS person, 'tenant' AS kind, lt.lease_id, u.property_id,
         t.date_of_birth::text AS dob,
         (l.status = 'active' AND lt.status IN ('active', 'pending_remove')) AS current
    FROM lease_tenants lt
    JOIN leases l ON l.id = lt.lease_id
    JOIN units u ON u.id = l.unit_id
    JOIN tenants t ON t.id = lt.tenant_id
   WHERE ${COUNTED_LEASE('l', '$1::date')} AND ${WAS_ON_LEASE('lt')}
  UNION ALL
  SELECT 'occupant:' || ${normalizeNameSql('o.full_name')} || '|'
           || COALESCE(o.date_of_birth::text, 'landlord:' || l.landlord_id::text),
         'occupant', o.lease_id, u.property_id, o.date_of_birth::text, (l.status = 'active')
    FROM lease_occupants o
    JOIN leases l ON l.id = o.lease_id
    JOIN units u ON u.id = l.unit_id
   WHERE ${COUNTED_LEASE('l', '$1::date')} AND ${OCCUPANT_NOT_A_TENANT('o')}`

/**
 * 10/13 (Nic): the households that moved out owing (a real landlord's, ended
 * by $1 = today), with the rent they left unpaid. See the block comment above.
 */
const DEFAULT_CTES = (): string => `
  ended AS (
    SELECT l.id AS lease_id, l.landlord_id, l.rent_amount, l.start_date, x.tz,
           -- The moment the lease ended, and the day it ended on (its end
           -- date, when the lease-end run stamped it the night after).
           l.terminated_at AS t,
           LEAST((l.terminated_at AT TIME ZONE x.tz)::date, l.end_date) AS d
      FROM leases l
      JOIN units u ON u.id = l.unit_id
      LEFT JOIN properties pr ON pr.id = u.property_id
      CROSS JOIN LATERAL (SELECT COALESCE(pr.timezone, 'America/Phoenix') AS tz) x
     WHERE ${realLandlordSql('l.landlord_id')}
       AND l.status IN ('expired', 'terminated')
       AND l.termination_reason IS DISTINCT FROM ${sqlLit(NEVER_MOVED_IN_REASON)}
       -- Went into force (see COUNTED_LEASE): ended paperwork has no end moment.
       AND l.terminated_at IS NOT NULL
       AND EXISTS (SELECT 1 FROM lease_tenants elt WHERE elt.lease_id = l.id AND ${WAS_ON_LEASE('elt')})
  ), moved_out AS (
    SELECT e.* FROM ended e
     WHERE e.d <= $1::date
       -- Not renewed.
       AND NOT EXISTS (SELECT 1 FROM leases s WHERE s.supersedes_lease_id = e.lease_id
                          AND s.status IN ('pending', 'active', 'expired', 'terminated')
                          AND s.termination_reason IS DISTINCT FROM ${sqlLit(NEVER_MOVED_IN_REASON)})
       -- Nobody on it went on living under the same landlord.
       AND NOT EXISTS (
         SELECT 1 FROM lease_tenants elt
           JOIN lease_tenants nlt ON nlt.tenant_id = elt.tenant_id AND nlt.lease_id <> elt.lease_id
           JOIN leases n ON n.id = nlt.lease_id
          WHERE elt.lease_id = e.lease_id AND ${WAS_ON_LEASE('elt')} AND ${WAS_ON_LEASE('nlt')}
            AND n.landlord_id = e.landlord_id
            AND n.status IN ('pending', 'active', 'expired', 'terminated')
            AND n.termination_reason IS DISTINCT FROM ${sqlLit(NEVER_MOVED_IN_REASON)}
            AND n.start_date >= e.start_date AND n.start_date <= e.d + 1
            -- (LEAST skips a missing end: no end at all is still in force.)
            AND COALESCE(LEAST((n.terminated_at AT TIME ZONE e.tz)::date, n.end_date), 'infinity'::date) >= e.d)
  ), unpaid AS (
    SELECT m.lease_id, SUM(x.unpaid) AS owed
      FROM moved_out m
      JOIN payments p ON p.lease_id = m.lease_id AND p.type = 'rent'
                     AND p.status NOT IN ('voided', 'returned') AND p.amount > 0
                     AND p.due_date <= m.d
                     -- Labor is paying it (work trade, the month still open): not
                     -- money billed, so not money left unpaid either.
                     AND p.work_trade_suspended_at IS NULL
                     AND (p.reversal_id IS NULL OR p.created_at <= m.t)
      CROSS JOIN LATERAL (
        SELECT CASE
          WHEN (p.status = 'settled' AND COALESCE(p.settled_at, p.created_at) <= m.t)
            OR EXISTS (SELECT 1 FROM remittance_applications ra
                         JOIN tenant_remittances r ON r.id = ra.remittance_id
                        WHERE ra.payment_id = p.id AND r.status = 'settled' AND r.created_at <= m.t)
          THEN 0
          ELSE GREATEST(0, p.amount - COALESCE(p.work_trade_credit, 0) - COALESCE((
                 SELECT SUM(cu.amount) FROM credit_uses cu
                  WHERE cu.payment_id = p.id AND cu.applied_at IS NOT NULL AND cu.applied_at <= m.t
                    AND (cu.released_at IS NULL OR cu.released_at > m.t)), 0))
          END AS unpaid
      ) x
     GROUP BY m.lease_id
    HAVING SUM(x.unpaid) > 0.005
  )`

/** Whole years from a birthday to a day, both 'YYYY-MM-DD'. */
export function ageOn(dob: string, day: string): number {
  const [by, bm, bd] = dob.slice(0, 10).split('-').map(Number)
  const [y, m, d] = day.slice(0, 10).split('-').map(Number)
  return y - by - (m < bm || (m === bm && d < bd) ? 1 : 0)
}

function summarizeAges(people: number, ages: number[]): AgeSummary {
  if (!ages.length) return { people, withBirthday: 0, average: null, youngest: null, oldest: null }
  return {
    people,
    withBirthday: ages.length,
    average: Math.round((ages.reduce((s, a) => s + a, 0) / ages.length) * 10) / 10,
    youngest: Math.min(...ages),
    oldest: Math.max(...ages),
  }
}

/** A birthday that is a real day before `day` (a typo of today or later is not one). */
const knownBirthday = (dob: string | null, day: string): dob is string => !!dob && dob.slice(0, 10) < day

const ratio = (a: number, b: number): number | null => (b > 0 ? a / b : null)

export async function computePlatformLifetimeMetrics(): Promise<PlatformLifetimeMetrics> {
  const today = todayIn(null)
  const realIds = (await query<{ id: string }>(
    `SELECT l.id FROM landlords l WHERE ${realLandlordSql('l.id')}`)).map(r => r.id)

  const [billedFacts, feeRows, peopleRows, leaseRows, defaultPeople] = await Promise.all([
    // The landlords' own Money billed facts, all time through today, from the money records.
    incomeEvents({ landlordIds: realIds, start: '2000-01-01', end: today, basis: 'billed', source: 'records' }),
    // GAM's monthly platform fee: each line in the revenue book and what of it is still open.
    query<{ billed: string; not_collected: string }>(`
      WITH fee AS (${PLATFORM_FEE_LINES_SQL}),
      lines AS (
        SELECT f.amount,
               -- platformFeeBill's rule: the charge each line raised, one per line;
               -- a charge GAM took back is voided and nobody owes it.
               (SELECT COALESCE(SUM(c.amount - c.collected_amount), 0)
                  FROM landlord_gam_charges c
                 WHERE c.kind = 'subscription' AND c.voided_at IS NULL
                   AND c.source_id = f.reference_id
                   AND c.source_type = ANY (CASE f.reference_type
                         WHEN 'platform_fee_accrual' THEN ARRAY['platform_fee_accrual', 'platform_fee_topup']
                         ELSE ARRAY[f.reference_type] END)) AS not_collected
          FROM fee f
         WHERE f.property_id IS NULL
            OR EXISTS (SELECT 1 FROM properties fp WHERE fp.id = f.property_id AND ${realLandlordSql('fp.landlord_id')})
      )
      SELECT COALESCE(SUM(amount), 0)::text AS billed, COALESCE(SUM(not_collected), 0)::text AS not_collected
        FROM lines`),
    query<{ person: string; kind: string; property_id: string; property_name: string | null; dob: string | null; current: boolean }>(`
      SELECT DISTINCT x.person, x.kind, x.property_id, pr.name AS property_name, x.dob, x.current
        FROM (${PEOPLE_ROWS()}) x
        LEFT JOIN properties pr ON pr.id = x.property_id`, [today]),
    // Every lease's monthly rent (for its rent range), and what it left unpaid when it moved out owing.
    query<{ lease_id: string; rent_amount: string; owed: string | null }>(`
      WITH ${DEFAULT_CTES()}
      SELECT l.id AS lease_id, l.rent_amount::text AS rent_amount, un.owed::text AS owed
        FROM leases l
        LEFT JOIN unpaid un ON un.lease_id = l.id
       WHERE ${realLandlordSql('l.landlord_id')}`, [today]),
    // Everyone on a household that moved out owing, with their age that day.
    query<{ person: string; lease_id: string; dob: string | null; d: string }>(`
      WITH ${DEFAULT_CTES()}
      SELECT 'tenant:' || lt.tenant_id::text AS person, m.lease_id, t.date_of_birth::text AS dob, m.d::text AS d
        FROM moved_out m
        JOIN unpaid un ON un.lease_id = m.lease_id
        JOIN lease_tenants lt ON lt.lease_id = m.lease_id
        JOIN tenants t ON t.id = lt.tenant_id
       WHERE ${WAS_ON_LEASE('lt')}
         -- On it when it ended: not someone who had moved out of it, or been
         -- replaced on it, before that day.
         AND (lt.removed_reason IS NULL OR lt.removed_reason NOT IN ('moved_out', 'replaced')
              OR (lt.removed_at AT TIME ZONE m.tz)::date >= m.d)
      UNION
      SELECT 'occupant:' || o.id::text, m.lease_id, o.date_of_birth::text, m.d::text
        FROM moved_out m
        JOIN unpaid un ON un.lease_id = m.lease_id
        JOIN lease_occupants o ON o.lease_id = m.lease_id
       WHERE ${OCCUPANT_NOT_A_TENANT('o')}`, [today]),
  ])

  // ── Money ──
  const breakdown = breakdownFrom('billed', billedFacts, null)
  const cat = (c: string) => breakdown.categories.find(x => x.category === c)
  const bc = (row: { billed: number; collected: number } | undefined): BilledCollected => {
    const billed = r2(row?.billed ?? 0), collected = r2(row?.collected ?? 0)
    return { billed, collected, owed: r2(billed - collected) }
  }
  const byUtility = INCOME_UTILITY_CATEGORIES
    .map(u => ({ utility: u as string, label: INCOME_CATEGORY_LABEL[u], ...bc(cat(u)) }))
    // Every utility Nic named stays on the list; "Other utilities" only when there is some.
    .filter(u => u.utility !== 'utility_other' || u.billed !== 0 || u.collected !== 0)
  const utilBilled = r2(byUtility.reduce((s, u) => s + u.billed, 0))
  const utilCollected = r2(byUtility.reduce((s, u) => s + u.collected, 0))
  const feeBilled = r2(feeRows[0]?.billed)
  const feeOpen = r2(feeRows[0]?.not_collected)

  // ── People ──
  const persons = new Map<string, { kind: string; dob: string | null; current: boolean }>()
  const byProperty = new Map<string, Map<string, string | null>>()
  for (const r of peopleRows) {
    const p = persons.get(r.person)
    persons.set(r.person, { kind: r.kind, dob: p?.dob ?? r.dob, current: (p?.current ?? false) || r.current })
    const at = byProperty.get(r.property_id) ?? new Map<string, string | null>()
    at.set(r.person, at.get(r.person) ?? r.dob)
    byProperty.set(r.property_id, at)
  }
  const everyone = [...persons.values()]
  const agesOf = (dobs: Iterable<string | null>) =>
    [...dobs].filter((d): d is string => knownBirthday(d, today)).map(d => ageOn(d, today))
  const propertyName = new Map(peopleRows.map(r => [r.property_id, r.property_name ?? 'Unnamed property']))

  // ── Defaults ──
  const bands = RENT_BANDS.map(b => ({
    label: rentBandLabel(b), min: b.min, max: b.max,
    leases: 0, monthsBilled: 0, rentBilled: 0, householdsOwing: 0, monthsUnpaid: 0, dollarsUnpaid: 0,
    rate: null as number | null, dollarRate: null as number | null,
  }))
  // Rent billed per lease and lease-month, from the same facts as the Billed
  // column: a month counts when rent was billed in it (net of what work trade
  // and credits given covered — the landlord reports' own Charged).
  const rentByLease = new Map<string, { dollars: number; months: Map<string, number> }>()
  for (const e of billedFacts) {
    if (e.category !== 'space_rent' || !e.inTotal || !e.leaseId) continue
    const x = rentByLease.get(e.leaseId) ?? { dollars: 0, months: new Map<string, number>() }
    x.dollars += e.amount
    const month = String(e.dueDate ?? e.day).slice(0, 7)
    x.months.set(month, (x.months.get(month) ?? 0) + e.amount)
    rentByLease.set(e.leaseId, x)
  }
  for (const l of leaseRows) {
    const billedRent = rentByLease.get(l.lease_id)
    const owed = Number(l.owed ?? 0)
    if (!billedRent && owed <= 0) continue
    const rent = Number(l.rent_amount)
    const band = bands[RENT_BANDS.indexOf(rentBandOf(rent))]
    band.leases += 1
    band.monthsBilled += billedRent ? [...billedRent.months.values()].filter(v => v > 0.005).length : 0
    band.rentBilled += billedRent?.dollars ?? 0
    if (owed > 0) {
      band.householdsOwing += 1
      band.dollarsUnpaid += owed
      if (rent > 0) band.monthsUnpaid += owed / rent
    }
  }
  const sum = (k: 'leases' | 'monthsBilled' | 'rentBilled' | 'householdsOwing' | 'monthsUnpaid' | 'dollarsUnpaid') =>
    bands.reduce((s, b) => s + b[k], 0)
  const finish = <T extends { monthsBilled: number; rentBilled: number; monthsUnpaid: number; dollarsUnpaid: number }>(x: T) => ({
    ...x,
    rentBilled: r2(x.rentBilled),
    dollarsUnpaid: r2(x.dollarsUnpaid),
    monthsUnpaid: Math.round(x.monthsUnpaid * 100) / 100,
    rate: ratio(x.monthsUnpaid, x.monthsBilled),
    dollarRate: ratio(x.dollarsUnpaid, x.rentBilled),
  })
  const totals = finish({
    leases: sum('leases'), monthsBilled: sum('monthsBilled'), rentBilled: sum('rentBilled'),
    householdsOwing: sum('householdsOwing'), monthsUnpaid: sum('monthsUnpaid'), dollarsUnpaid: sum('dollarsUnpaid'),
  })
  const atDefault = new Map<string, number | null>()
  for (const r of defaultPeople) {
    const key = `${r.person}|${r.lease_id}`
    const age = knownBirthday(r.dob, r.d) ? ageOn(r.dob, r.d) : null
    if (!atDefault.has(key) || atDefault.get(key) == null) atDefault.set(key, age)
  }
  const defaultAges = [...atDefault.values()].filter((a): a is number => a != null)

  return {
    asOf: new Date().toISOString(),
    through: today,
    money: {
      rent: { label: INCOME_CATEGORY_LABEL.space_rent, ...bc(cat('space_rent')) },
      utilities: { billed: utilBilled, collected: utilCollected, owed: r2(utilBilled - utilCollected), byUtility },
      platformFees: { billed: feeBilled, collected: r2(feeBilled - feeOpen), owed: feeOpen },
    },
    tenants: {
      ever: everyone.length,
      tenants: everyone.filter(p => p.kind === 'tenant').length,
      occupants: everyone.filter(p => p.kind === 'occupant').length,
      onALeaseNow: everyone.filter(p => p.current).length,
      movedOn: everyone.filter(p => !p.current).length,
    },
    defaults: {
      ...totals,
      byRentRange: bands.filter(b => b.leases > 0).map(finish),
    },
    ages: {
      ...summarizeAges(everyone.length, agesOf(everyone.map(p => p.dob))),
      byProperty: [...byProperty.entries()]
        .map(([propertyId, at]) => ({
          propertyId, name: propertyName.get(propertyId) ?? 'Unnamed property',
          ...summarizeAges(at.size, agesOf(at.values())),
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      atDefault: summarizeAges(atDefault.size, defaultAges),
    },
  }
}

let lifetimeCached: { at: number; data: PlatformLifetimeMetrics } | null = null

/** Cached a minute, like platformMetrics: all-time figures, and the page polls. */
export async function platformLifetimeMetrics(opts: { fresh?: boolean } = {}): Promise<PlatformLifetimeMetrics> {
  if (!opts.fresh && lifetimeCached && Date.now() - lifetimeCached.at < TTL_MS) return lifetimeCached.data
  const data = await computePlatformLifetimeMetrics()
  lifetimeCached = { at: Date.now(), data }
  return data
}

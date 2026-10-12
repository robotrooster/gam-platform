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
 */
import { query } from '../db'
import { paidByLabel, PROCESSING_FEES } from '@gam/shared'
import { realLandlordSql } from './platformRevenue'
import { platformFeeBill } from './platformFeeBill'
import { liveReversalSql, reversedUseOfWonDisputeSql } from './creditUse'

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
 * Every dollar of rent logged through GAM, once. Columns: method, at, amount,
 * remittance_id (the tenant payment the money came in on; NULL on a take-back
 * line, so it never adds to a payment count). See the module header.
 */
const RENT_LINES = (): string => `
  -- 1. Money a settled tenant payment applied to a rent bill.
  SELECT r.payment_method AS method, COALESCE(r.settled_at, r.created_at) AS at,
         ra.amount_applied AS amount, r.id AS remittance_id
    FROM remittance_applications ra
    JOIN tenant_remittances r ON r.id = ra.remittance_id
    JOIN payments p ON p.id = ra.payment_id
   WHERE r.status = 'settled' AND p.type = 'rent' AND ${realLandlordSql('r.landlord_id')}
  UNION ALL
  -- 2. Money paid ahead on a tenant payment that a later rent bill spent, in
  --    that payment's method, on the day it was spent. A spend undone by a
  --    dispute is not money any more — unless GAM won the dispute, which put it back.
  SELECT sr.payment_method, cu.applied_at, cu.amount, sr.id
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
  SELECT ${REVERSAL_METHOD('pr')}, pr.created_at, -taken.amt, NULL::uuid
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
  SELECT r.payment_method, rp.refunded_at, -rp.toward_amount, NULL::uuid
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

/** Utility bills that went out to a resident — not drafts, not voided. */
const UTILITY_BILL_SENT = `b.status IN ('billed', 'paid', 'disputed')`
/** A stay that happened or is booked to happen. */
const STAY_HELD = `k.status IN ('confirmed', 'checked_in', 'checked_out')`
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

export async function computePlatformMetrics(): Promise<PlatformMetrics> {
  const realR = realLandlordSql('r.landlord_id')
  const [
    rentRows, monthRows, tenantMoney, paid, busiest, register, stayDeposits, checks, payouts,
    footprint, paperwork, operations, growth, bill,
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
export function clearPlatformMetricsCache(): void { cached = null }

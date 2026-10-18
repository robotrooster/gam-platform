/**
 * S565: Economic-nexus monitor.
 *
 * Two responsibilities:
 *   1. recomputeNexusTally() — nightly job. Reads GAM's revenue book
 *      (platform_revenue_ledger), attributes each earning to a state, and
 *      writes a per-state, per-calendar-year breakdown into
 *      nexus_revenue_tally (current + prior year). Nic's S564 rule: count
 *      conservatively to register EARLY.
 *   2. getNexusDashboard() — read model for the admin dashboard: each state's
 *      measured receipts vs its economic-nexus threshold + registration status,
 *      plus the line items behind the number and the rule saying which of them
 *      that state actually measures.
 *
 * ⚠️ MONITORING ONLY. Crossing a threshold PROMPTS Nic to register; it never
 * collects tax. Tax collection is separately gated on state_tax_registrations
 * (see services/... the screening fee path + the S565 tax migration).
 *
 * ── 10/17 (Nic): WHAT A STATE MEASURES, AND WHY IT READ LOW ────────────────
 *
 * "The sales tax nexus on the admin platform is not accurately reading... it
 * would need to take into account any margins that GAM makes on card payments
 * or ACH payments." He was right: the tally summed four subscription-shaped
 * sources (the per-space fee, screenings, the business portal fee, FlexPay)
 * off their own accrual tables and left GAM's processing markup out entirely,
 * so every state's figure was short by the whole card and bank margin.
 *
 * It now reads GAM's one book of earned revenue, where the margin on each
 * charge is the real settled amount rather than a rate-table guess (memories
 * gam-one-book-for-gam-revenue + gam-book-is-actual-fees), and keeps the line
 * items Nic asked for beside the total:
 *
 *   "each state's nexus has a breakdown of total transactions, and then the
 *    actual subscription costs, hard markup fees, background checks or
 *    screenings, and then any other customer opt-in things, the credit
 *    reporting and stuff like that. Let's have them all as a combined total on
 *    the Nexus by default, but then we can expand it and see line items and
 *    see, okay, if that state's not counting some of those, where are we
 *    really at? I'd rather count high and register with those states early."
 *
 * So: the headline number per state is the COMBINED total and the crossing
 * logic uses it (count high). Beside it sits what the state would measure if
 * its own rule excludes a category — state_nexus_measure_rules, data because
 * the law differs by state and the published tables disagree.
 *
 * WHERE EACH EARNING IS MEASURED. Nic chose the PROPERTY's state for margins,
 * so they line up with the space fee earned at the same property. A screening
 * is sold to the applicant, so it is measured where the applicant lives. The
 * bank markup on a pull of GAM's own fees is measured at the landlord's
 * properties when they are all in one state. Anything left is reported as
 * unattributed rather than guessed at — a receipt whose property row was
 * removed, a monthly processing true-up that belongs to no single state, a
 * landlord with properties in two states. Nothing is split pro rata: a
 * state's figure has to be traceable to the charges behind it.
 *
 * NOT marketplace facilitator. Nic parked it: "rent generally isn't taxable...
 * this would apply towards the short-term rental situation in states when we
 * start doing that... we'll analyze that when we get there."
 */
import { query } from '../db'
import { logger } from '../lib/logger'
import { todayIn } from '../lib/timezone'
import { REVENUE_SLICE_TYPE_SQL } from './revenueSlices'

export type NexusStatus =
  | 'registered'    // GAM has registered here — collection is live
  | 'crossed'       // measured receipts ≥ threshold, not yet registered → ACT
  | 'approaching'   // measured receipts ≥ warn line (default 80%) but < threshold
  | 'under'         // comfortably below
  | 'no_threshold'  // no sales tax / no economic-nexus regime (never register)
  | 'unresearched'  // GAM earns here and this state's threshold is not in the catalog yet

/**
 * 10/17 (Nic): "the actual subscription costs, hard markup fees, background
 * checks or screenings, and then any other customer opt-in things." Plus
 * 'other' — everything GAM earns that those four do not name, counted by
 * default so a new way of earning money can never quietly drop out of a
 * state's measure (gam-one-book-for-gam-revenue: an unmapped revenue type
 * surfaces as "Other" rather than silently unbalancing the page).
 */
export const NEXUS_LINE_ITEMS = ['subscription', 'markup', 'screening', 'optin', 'other'] as const
export type NexusLineItem = typeof NEXUS_LINE_ITEMS[number]

export const NEXUS_LINE_ITEM_LABEL: Record<NexusLineItem, string> = {
  subscription: 'Platform subscription',
  markup:       'Card & bank markup',
  screening:    'Background checks',
  optin:        'Customer opt-ins',
  other:        'Other GAM earnings',
}

/**
 * Which line item a revenue-book row belongs to, keyed by the slice
 * services/revenueSlices puts it in — so the nexus page can never cut the book
 * a different way from the admin money page. A slice nobody named here lands in
 * 'other'.
 */
const NEXUS_LINE_ITEM_BY_SLICE: Record<string, NexusLineItem> = {
  platform_fee_subscription: 'subscription',
  banking_spread:            'markup',
  screening_margin:          'screening',
  flexpay_subscription:      'optin',
}

export interface NexusLineItemRow {
  key: NexusLineItem
  label: string
  currentYtd: number
  priorYear: number
  counted: boolean      // does this state's measurement rule count this line item?
}

export interface NexusMeasureRule {
  countsSubscription: boolean
  countsMarkup: boolean
  countsScreening: boolean
  countsOptin: boolean
  countsOther: boolean
  countsEverything: boolean   // convenience: nothing excluded
  source: string | null
  notes: string | null
}

export interface NexusStateRow {
  stateCode: string
  // The combined total — the default view, and what the crossing logic uses.
  revenueCurrentYtd: number
  revenuePriorYear: number
  measureUsd: number          // max(current YTD, prior full year) — conservative
  // What this state would measure if its own rule excludes a category.
  countedCurrentYtd: number
  countedPriorYear: number
  countedMeasureUsd: number
  lineItems: NexusLineItemRow[]
  // False on a tally row written before the line-item breakdown existed: the
  // combined total is the one the nightly job stored, and the line items are
  // all zero until the next recompute. The page says so rather than showing a
  // state as measuring nothing.
  breakdownReady: boolean
  measureRule: NexusMeasureRule
  txnCurrentYtd: number
  txnPriorYear: number
  measureTxn: number
  thresholdUsd: number | null
  txnThreshold: number | null
  countRule: string
  taxable: boolean            // is a screening service taxable here (from tax catalog)?
  registered: boolean
  registeredDate: string | null
  pctOfThreshold: number | null        // combined measure / threshold, 0..>1
  countedPctOfThreshold: number | null // the state's own subset / threshold
  status: NexusStatus
}

// Default warn line: flag a state "approaching" once measured receipts reach
// this fraction of the threshold. Configurable later if Nic wants a per-state knob.
export const NEXUS_WARN_FRACTION = 0.8

// GAM's home clock. A charge that landed at 5 pm on 31 December in Phoenix is
// that year's receipt, not next year's — the same reason every "today" on a
// bill comes from todayIn() rather than the server's UTC clock (S654).
const HOME_TZ = 'America/Phoenix'

const lineItemSql = (sliceExpr: string) =>
  `CASE ${Object.entries(NEXUS_LINE_ITEM_BY_SLICE)
    .map(([slice, item]) => `WHEN ${sliceExpr} = '${slice}' THEN '${item}'`)
    .join(' ')} ELSE 'other' END`

/**
 * Every GAM earning, placed in a state and a calendar year.
 *
 * `attributed` is the revenue book with its slice, its nexus line item and its
 * state resolved; `measured` adds the business portal's monthly fee, the one
 * receipt that has never been posted to the revenue book at all (see
 * businessMonthlyFees — it bills the business and writes nothing to GAM's own
 * book, so the admin money page misses it too). It is counted here because
 * leaving it out would under-count a state, and Nic would rather count high.
 *
 * `txn_ref` is what makes one TRANSACTION: a screening writes two book rows
 * (its margin and the card markup on the same charge) under one reference, and
 * that is one sale, not two. A correction — a take-back, a monthly processing
 * true-up — moves dollars but is never a new transaction.
 */
const MEASURED_REVENUE_CTE = `
  WITH book AS (
    SELECT l.amount,
           l.type,
           l.reference_id,
           l.reference_type,
           l.property_id,
           EXTRACT(YEAR FROM (l.created_at AT TIME ZONE '${HOME_TZ}'))::int AS period_year,
           ${REVENUE_SLICE_TYPE_SQL} AS slice
      FROM platform_revenue_ledger l
  ),
  attributed AS (
    SELECT b.amount,
           b.type,
           b.reference_id,
           b.period_year,
           ${lineItemSql('b.slice')} AS line_item,
           CASE
             -- 10/17 (Nic): margins are measured at the PROPERTY's state, so
             -- they line up with the space fee earned at the same property.
             WHEN b.property_id IS NOT NULL
               THEN (SELECT upper(trim(p.state)) FROM properties p WHERE p.id = b.property_id)
             -- A screening (and the card markup on the same charge) is sold to
             -- the applicant, so it is measured where the applicant lives.
             WHEN b.reference_type = 'background_check'
               THEN (SELECT upper(trim(bc.state)) FROM background_checks bc WHERE bc.id = b.reference_id)
             -- The bank markup on a pull of GAM's own fees, and a take-back of
             -- it: the landlord's properties, when they are all in one state.
             -- A landlord spanning two states is left unattributed rather than
             -- split pro rata.
             WHEN b.reference_type IN ('gam_bank_debit', 'dispute_spread_reversal')
               THEN (SELECT CASE WHEN COUNT(DISTINCT upper(trim(p.state))) = 1
                                 THEN MIN(upper(trim(p.state))) END
                       FROM landlord_gam_debits d
                       JOIN properties p ON p.landlord_id = d.landlord_id
                      WHERE d.id = b.reference_id
                        AND p.state IS NOT NULL AND length(trim(p.state)) = 2)
           END AS state_code
      FROM book b
  ),
  measured AS (
    SELECT a.state_code, a.period_year, a.line_item, a.amount,
           CASE WHEN a.type <> 'adjustment' THEN a.reference_id::text END AS txn_ref
      FROM attributed a
    UNION ALL
    SELECT upper(trim(bz.state)) AS state_code,
           left(a.month, 4)::int AS period_year,
           'subscription'::text AS line_item,
           a.amount,
           'biz:' || a.id::text AS txn_ref
      FROM business_platform_fee_accruals a
      JOIN businesses bz ON bz.id = a.business_id
     WHERE a.month ~ '^[0-9]{4}-[0-9]{2}$'
       AND a.status <> 'waived'
  )
`

// The five line-item sums + the transaction count, for whichever rows the
// caller's WHERE keeps.
const MEASURED_ROLLUP_SELECT = `
  SELECT state_code, period_year,
         ${NEXUS_LINE_ITEMS.map(k =>
           `COALESCE(SUM(amount) FILTER (WHERE line_item = '${k}'), 0)::numeric(14,2) AS ${k}_usd`
         ).join(',\n         ')},
         COUNT(DISTINCT txn_ref)::int AS txn_count
    FROM measured
`

type RollupRow = { state_code: string | null; period_year: number; txn_count: number } & Record<string, any>

const lineItemAmounts = (r: RollupRow): Record<NexusLineItem, number> =>
  Object.fromEntries(
    NEXUS_LINE_ITEMS.map(k => [k, parseFloat(r[`${k}_usd`] ?? '0')])
  ) as Record<NexusLineItem, number>

const sumOf = (amounts: Record<NexusLineItem, number>) =>
  round2(NEXUS_LINE_ITEMS.reduce((s, k) => s + amounts[k], 0))

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * Recompute the nexus tally for the current + prior calendar year.
 * Full overwrite per (state, year). Idempotent — safe to run repeatedly.
 */
export async function recomputeNexusTally(nowYear?: number): Promise<{ years: number[]; rows: number }> {
  // S654: the calendar year by GAM's home (Phoenix) clock, not the server's zone.
  const currentYear = nowYear ?? Number(todayIn(null).slice(0, 4))
  const priorYear = currentYear - 1
  const years = [priorYear, currentYear]

  const agg = await query<RollupRow>(
    `${MEASURED_REVENUE_CTE}
     ${MEASURED_ROLLUP_SELECT}
      WHERE state_code IS NOT NULL AND length(state_code) = 2
        AND period_year = ANY($1)
      GROUP BY state_code, period_year`,
    [years]
  )

  // Overwrite the tally for these years. Delete-then-insert keeps it simple —
  // a state that dropped to $0 this run gets its row cleared.
  await query('DELETE FROM nexus_revenue_tally WHERE period_year = ANY($1)', [years])
  for (const r of agg) {
    const amounts = lineItemAmounts(r)
    // revenue_usd carries the combined total and has a non-negative CHECK that
    // predates the line items, so it is floored; the line items stay signed
    // because a take-back or a processing true-up can push one below zero.
    const combined = Math.max(0, sumOf(amounts))
    await query(
      `INSERT INTO nexus_revenue_tally
         (state_code, period_year, revenue_usd, txn_count,
          subscription_usd, markup_usd, screening_usd, optin_usd, other_usd, computed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())`,
      [r.state_code, r.period_year, combined, r.txn_count,
       amounts.subscription, amounts.markup, amounts.screening, amounts.optin, amounts.other]
    )
  }
  logger.info(`[nexusMonitor] tally recomputed for ${years.join(', ')} — ${agg.length} state-year rows`)
  return { years, rows: agg.length }
}

/**
 * What GAM earned in the window that could not be placed in a state. Read
 * straight off the book at page load (the tally only stores placed receipts,
 * whose key is a two-letter state). Shown on the page so the states and this
 * always add up to the book.
 */
async function unattributedBlock(years: number[]) {
  const rows = await query<RollupRow>(
    `${MEASURED_REVENUE_CTE}
     ${MEASURED_ROLLUP_SELECT}
      WHERE (state_code IS NULL OR length(state_code) <> 2)
        AND period_year = ANY($1)
      GROUP BY state_code, period_year`,
    [years]
  )
  const [priorYear, currentYear] = [Math.min(...years), Math.max(...years)]
  const fold = (year: number) => {
    const totals = Object.fromEntries(NEXUS_LINE_ITEMS.map(k => [k, 0])) as Record<NexusLineItem, number>
    let txn = 0
    for (const r of rows.filter(x => x.period_year === year)) {
      const a = lineItemAmounts(r)
      for (const k of NEXUS_LINE_ITEMS) totals[k] = round2(totals[k] + a[k])
      txn += r.txn_count
    }
    return { totals, txn }
  }
  const cur = fold(currentYear)
  const pri = fold(priorYear)
  return {
    currentYtd: sumOf(cur.totals),
    priorYear: sumOf(pri.totals),
    txnCurrentYtd: cur.txn,
    txnPriorYear: pri.txn,
    lineItems: NEXUS_LINE_ITEMS.map(k => ({
      key: k,
      label: NEXUS_LINE_ITEM_LABEL[k],
      currentYtd: cur.totals[k],
      priorYear: pri.totals[k],
      counted: true,
    })),
  }
}

/**
 * Dashboard read model: every state in the threshold catalog, plus any state
 * GAM has actually earned in, joined against thresholds + tax catalog +
 * registrations + each state's own measurement rule.
 */
export async function getNexusDashboard(nowYear?: number): Promise<{
  warnFraction: number
  computedAt: string | null
  lineItems: Array<{ key: NexusLineItem; label: string }>
  states: NexusStateRow[]
  unattributed: Awaited<ReturnType<typeof unattributedBlock>>
  summary: { crossed: number; approaching: number; registered: number; under: number; unresearched: number }
}> {
  // S654: the calendar year by GAM's home (Phoenix) clock, not the server's zone.
  const currentYear = nowYear ?? Number(todayIn(null).slice(0, 4))
  const priorYear = currentYear - 1

  const rows = await query<any>(
    `
    -- The catalog year in force: the newest researched year that has started.
    -- Matching the current year exactly blanked the whole page every January
    -- until a new catalog migration landed.
    WITH yr AS (
      SELECT MAX(effective_year) AS y FROM state_nexus_thresholds WHERE effective_year <= $3
    ),
    cur AS (
      SELECT * FROM nexus_revenue_tally WHERE period_year = $1
    ),
    pri AS (
      SELECT * FROM nexus_revenue_tally WHERE period_year = $2
    ),
    -- Drive off the catalog AND anything GAM earned in: a state whose
    -- threshold nobody has researched yet still has to appear, with its money,
    -- rather than disappearing with it.
    states AS (
      SELECT t.state_code FROM state_nexus_thresholds t, yr WHERE t.effective_year = yr.y
      UNION
      SELECT state_code FROM cur
      UNION
      SELECT state_code FROM pri
    )
    SELECT
      s.state_code,
      (t.state_code IS NOT NULL) AS in_catalog,
      t.revenue_threshold_usd,
      t.txn_threshold,
      COALESCE(t.count_rule, 'or') AS count_rule,
      COALESCE(tax.taxable, false) AS taxable,
      COALESCE(reg.registered, false) AS registered,
      reg.registered_date::text AS registered_date, -- S654: 'YYYY-MM-DD', not a JS Date
      -- A state with no researched rule counts every line item (count high).
      COALESCE(r.counts_subscription, true) AS counts_subscription,
      COALESCE(r.counts_markup, true)       AS counts_markup,
      COALESCE(r.counts_screening, true)    AS counts_screening,
      COALESCE(r.counts_optin, true)        AS counts_optin,
      COALESCE(r.counts_other, true)        AS counts_other,
      r.source AS rule_source,
      r.notes  AS rule_notes,
      COALESCE(cur.subscription_usd, 0)::numeric AS cur_subscription,
      COALESCE(cur.markup_usd, 0)::numeric       AS cur_markup,
      COALESCE(cur.screening_usd, 0)::numeric    AS cur_screening,
      COALESCE(cur.optin_usd, 0)::numeric        AS cur_optin,
      COALESCE(cur.other_usd, 0)::numeric        AS cur_other,
      COALESCE(pri.subscription_usd, 0)::numeric AS pri_subscription,
      COALESCE(pri.markup_usd, 0)::numeric       AS pri_markup,
      COALESCE(pri.screening_usd, 0)::numeric    AS pri_screening,
      COALESCE(pri.optin_usd, 0)::numeric        AS pri_optin,
      COALESCE(pri.other_usd, 0)::numeric        AS pri_other,
      COALESCE(cur.revenue_usd, 0)::numeric AS cur_revenue,
      COALESCE(pri.revenue_usd, 0)::numeric AS pri_revenue,
      COALESCE(cur.txn_count, 0) AS txn_current,
      COALESCE(pri.txn_count, 0) AS txn_prior
    FROM states s
    CROSS JOIN yr
    LEFT JOIN state_nexus_thresholds t
      ON t.state_code = s.state_code AND t.effective_year = yr.y
    LEFT JOIN state_screening_tax_rates tax
      ON tax.state_code = s.state_code AND tax.effective_year = yr.y
    LEFT JOIN state_nexus_measure_rules r
      ON r.state_code = s.state_code AND r.effective_year = yr.y
    LEFT JOIN state_tax_registrations reg ON reg.state_code = s.state_code
    LEFT JOIN cur ON cur.state_code = s.state_code
    LEFT JOIN pri ON pri.state_code = s.state_code
    ORDER BY s.state_code
    `,
    [currentYear, priorYear, currentYear]
  )

  let computedAt: string | null = null
  const ca = await query<{ max: string | null }>('SELECT MAX(computed_at) AS max FROM nexus_revenue_tally')
  if (ca[0]?.max) computedAt = ca[0].max

  const states: NexusStateRow[] = rows.map((r) => {
    const counts: Record<NexusLineItem, boolean> = {
      subscription: !!r.counts_subscription,
      markup:       !!r.counts_markup,
      screening:    !!r.counts_screening,
      optin:        !!r.counts_optin,
      other:        !!r.counts_other,
    }
    const lineItems: NexusLineItemRow[] = NEXUS_LINE_ITEMS.map((k) => ({
      key: k,
      label: NEXUS_LINE_ITEM_LABEL[k],
      currentYtd: parseFloat(r[`cur_${k}`]),
      priorYear: parseFloat(r[`pri_${k}`]),
      counted: counts[k],
    }))

    // The stored combined total, and the sum of the line items behind it. They
    // agree once the nightly job has run on the line-item columns; before that
    // the line items are zero, so the stored total is what the page shows and
    // the breakdown is marked not ready instead of reading every state as $0.
    const storedCurrent = parseFloat(r.cur_revenue)
    const storedPrior   = parseFloat(r.pri_revenue)
    const lineCurrent = round2(lineItems.reduce((s, li) => s + li.currentYtd, 0))
    const linePrior   = round2(lineItems.reduce((s, li) => s + li.priorYear, 0))
    const breakdownReady = lineItems.some(li => li.currentYtd !== 0 || li.priorYear !== 0)
      || (storedCurrent === 0 && storedPrior === 0)

    const revenueCurrentYtd = breakdownReady ? lineCurrent : storedCurrent
    const revenuePriorYear  = breakdownReady ? linePrior : storedPrior
    // Without a breakdown there is no smaller subset to claim: the state's own
    // measure is the whole figure until the line items exist.
    const countedCurrentYtd = breakdownReady
      ? round2(lineItems.filter(li => li.counted).reduce((s, li) => s + li.currentYtd, 0))
      : storedCurrent
    const countedPriorYear = breakdownReady
      ? round2(lineItems.filter(li => li.counted).reduce((s, li) => s + li.priorYear, 0))
      : storedPrior

    // Conservative measure: the bigger of this year so far and all of last
    // year, which is what most states' "prior or current calendar year" asks.
    const measureUsd = Math.max(revenueCurrentYtd, revenuePriorYear)
    const countedMeasureUsd = Math.max(countedCurrentYtd, countedPriorYear)
    const measureTxn = Math.max(r.txn_current, r.txn_prior)

    const thresholdUsd = r.revenue_threshold_usd != null ? parseFloat(r.revenue_threshold_usd) : null
    const txnThreshold = r.txn_threshold != null ? Number(r.txn_threshold) : null
    const registered = !!r.registered
    const pctOfThreshold = thresholdUsd && thresholdUsd > 0 ? measureUsd / thresholdUsd : null
    const countedPctOfThreshold = thresholdUsd && thresholdUsd > 0 ? countedMeasureUsd / thresholdUsd : null

    // 10/17 (Nic): "I'd rather count high and register with those states
    // early" — so crossing reads the COMBINED total, never the narrower
    // subset a state's own rule might measure. The subset sits beside it as
    // the "where are we really at" number.
    //
    // Crossing honors count_rule: 'and' needs both receipts AND transactions
    // over; 'or' either; 'revenue_only' ignores the transaction count.
    const revOver = thresholdUsd != null && measureUsd >= thresholdUsd
    const txnOver = txnThreshold != null && measureTxn >= txnThreshold
    let crossed = false
    if (thresholdUsd != null) {
      if (r.count_rule === 'and') crossed = revOver && txnOver
      else if (r.count_rule === 'revenue_only') crossed = revOver
      else crossed = revOver || txnOver // 'or'
    }

    let status: NexusStatus
    if (!r.in_catalog) status = 'unresearched'
    else if (thresholdUsd == null) status = 'no_threshold'
    else if (registered) status = 'registered'
    else if (crossed) status = 'crossed'
    else if (pctOfThreshold != null && pctOfThreshold >= NEXUS_WARN_FRACTION) status = 'approaching'
    else status = 'under'

    return {
      stateCode: r.state_code,
      revenueCurrentYtd,
      revenuePriorYear,
      measureUsd,
      countedCurrentYtd,
      countedPriorYear,
      countedMeasureUsd,
      lineItems,
      breakdownReady,
      measureRule: {
        countsSubscription: counts.subscription,
        countsMarkup: counts.markup,
        countsScreening: counts.screening,
        countsOptin: counts.optin,
        countsOther: counts.other,
        countsEverything: NEXUS_LINE_ITEMS.every(k => counts[k]),
        source: r.rule_source ?? null,
        notes: r.rule_notes ?? null,
      },
      txnCurrentYtd: r.txn_current,
      txnPriorYear: r.txn_prior,
      measureTxn,
      thresholdUsd,
      txnThreshold,
      countRule: r.count_rule,
      taxable: !!r.taxable,
      registered,
      registeredDate: r.registered_date ? String(r.registered_date).slice(0, 10) : null,
      pctOfThreshold,
      countedPctOfThreshold,
      status,
    }
  })

  const summary = {
    crossed: states.filter((s) => s.status === 'crossed').length,
    approaching: states.filter((s) => s.status === 'approaching').length,
    registered: states.filter((s) => s.status === 'registered').length,
    under: states.filter((s) => s.status === 'under').length,
    unresearched: states.filter((s) => s.status === 'unresearched').length,
  }

  return {
    warnFraction: NEXUS_WARN_FRACTION,
    computedAt,
    // The page's legend is built from what the server returned, never a
    // parallel list (gam-one-book-for-gam-revenue).
    lineItems: NEXUS_LINE_ITEMS.map(k => ({ key: k, label: NEXUS_LINE_ITEM_LABEL[k] })),
    states,
    unattributed: await unattributedBlock([priorYear, currentYear]),
    summary,
  }
}

/**
 * Flip a state's registration status (admin action). source='manual'.
 * Registering here turns ON tax collection for that state (subject to the tax
 * catalog's taxable flag + rate). Upserts state_tax_registrations.
 */
export async function setStateRegistration(
  stateCode: string,
  registered: boolean,
  opts?: { registeredDate?: string | null; notes?: string | null; source?: 'manual' | 'nexus_auto' }
): Promise<void> {
  const st = stateCode.toUpperCase()
  if (st.length !== 2) throw new Error('Invalid state code')
  const source = opts?.source ?? 'manual'
  // S654: registered "today" in Phoenix — the UTC date is tomorrow after 5 pm.
  const regDate = registered ? (opts?.registeredDate ?? todayIn(null)) : null
  await query(
    `INSERT INTO state_tax_registrations (state_code, registered, registered_date, source, notes, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (state_code) DO UPDATE
       SET registered = EXCLUDED.registered,
           registered_date = EXCLUDED.registered_date,
           source = EXCLUDED.source,
           notes = COALESCE(EXCLUDED.notes, state_tax_registrations.notes),
           updated_at = NOW()`,
    [st, registered, regDate, source, opts?.notes ?? null]
  )
  logger.info(`[nexusMonitor] state ${st} registration set to ${registered} (source=${source})`)
}

/**
 * Narrow (or re-widen) which line items a state measures toward its threshold —
 * a researched answer, recorded so the page can show what that state would
 * really count. Changing it collects no tax and moves no money; it only
 * changes the subtotal shown beside the combined total.
 *
 * Only the line items named in `counts` move; the rest keep what they had, and
 * a state with no row starts from counting everything.
 */
export async function setStateMeasureRule(
  stateCode: string,
  counts: Partial<Record<NexusLineItem, boolean>>,
  opts?: { year?: number; source?: string | null; notes?: string | null }
): Promise<void> {
  const st = stateCode.toUpperCase()
  if (st.length !== 2) throw new Error('Invalid state code')
  const year = opts?.year ?? Number(todayIn(null).slice(0, 4))
  const COLUMN: Record<NexusLineItem, string> = {
    subscription: 'counts_subscription',
    markup:       'counts_markup',
    screening:    'counts_screening',
    optin:        'counts_optin',
    other:        'counts_other',
  }
  const named = NEXUS_LINE_ITEMS.filter(k => counts[k] !== undefined)
  const params: unknown[] = [st, year, opts?.source ?? 'manual', opts?.notes ?? null]
  const insertCols = named.map(k => COLUMN[k])
  const insertVals = named.map((k) => { params.push(counts[k]); return `$${params.length}` })
  const sets = named.map(k => `${COLUMN[k]} = EXCLUDED.${COLUMN[k]}`)

  await query(
    `INSERT INTO state_nexus_measure_rules
       (state_code, effective_year, source, notes${insertCols.length ? ', ' + insertCols.join(', ') : ''})
     VALUES ($1, $2, $3, $4${insertVals.length ? ', ' + insertVals.join(', ') : ''})
     ON CONFLICT (state_code, effective_year) DO UPDATE
       SET source = EXCLUDED.source,
           notes = COALESCE(EXCLUDED.notes, state_nexus_measure_rules.notes),
           updated_at = NOW()${sets.length ? ',\n           ' + sets.join(',\n           ') : ''}`,
    params
  )
  logger.info(`[nexusMonitor] state ${st} ${year} measurement rule updated (${named.join(', ') || 'notes only'})`)
}

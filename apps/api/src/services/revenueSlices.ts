/**
 * Which slice of GAM's earnings a revenue-book row (platform_revenue_ledger)
 * belongs to — one definition for the admin money page's pies
 * (routes/admin computeComposition and the drill-down) and the Metrics page's
 * platform fees (services/platformMetrics, 10/14 (Nic): "show each separately
 * (space fee, processing margin, screening margin) plus a total"), so the two
 * pages can never cut the same book two ways (gam-one-book-for-gam-revenue).
 *
 * Read against an unaliased platform_revenue_ledger row (`type`,
 * `reference_type`); the result is a ledger type, or one of the reader slices.
 *
 * S653 (Nic): "Where are those adjustments coming from? Because we are not
 * spending any money." The monthly processing true-up (services/platformRevenue
 * trueUpProcessingMargin) is typed 'adjustment' with its own reference_type, but
 * it IS processing income — it is the correction that makes the estimated
 * per-payment spreads equal Stripe's real invoice. It belongs in the slice it
 * corrects, or the Processing slice under-reads every month and an unexplained
 * "adjustment" appears beside it.
 *
 * S655: likewise a FlexPay $25 taken back because its pull was taken back by
 * the bank (services/flexpay handleFlexPayPullReversed) is an 'adjustment' that
 * corrects the FlexPay slice, so it nets inside it.
 * 10/5 (Nic, prepaid stays): a screening margin taken back because the check
 * paid with a stay was cancelled before a report (services/stayTerms
 * restorePrepaidScreening) corrects the Background Checks slice.
 * 10/13 (Nic, full purchase): a card reader's purchase (GAM's expense) and
 * the pieces paying it back are 'adjustment' rows with their own reference;
 * each is its own reader slice, never "Adjustments".
 * 10/12 (Nic): the old screening sweep (jobs/platformFeeAccrual
 * processScreeningFeeSweep) books background checks under the subscription
 * type. It has never posted, but the day it does those checks belong in the
 * Background Checks slice, not in Platform Fees or the recurring card
 * (services/platformFeeBill leaves them out by the same reference).
 */
import { READER_BOOK_REFERENCE } from '@gam/shared'

export const REVENUE_SLICE_TYPE_SQL = `CASE WHEN type = 'platform_fee_subscription' AND reference_type = 'screening_fee_sweep'
                             THEN 'screening_margin'
                             WHEN type = 'adjustment' AND reference_type = 'processing_margin_true_up'
                             THEN 'banking_spread'
                             WHEN type = 'adjustment' AND reference_type = 'screening_margin_reversal'
                             THEN 'screening_margin'
                             WHEN type = 'adjustment' AND reference_type LIKE 'flexpay_advance_reversal%'
                             THEN 'flexpay_subscription'
                             WHEN type = 'adjustment' AND reference_type = '${READER_BOOK_REFERENCE.purchase}'
                             THEN 'reader_purchase'
                             WHEN type = 'adjustment' AND reference_type = '${READER_BOOK_REFERENCE.costRepaid}'
                             THEN 'reader_cost_repaid'
                             ELSE type END`

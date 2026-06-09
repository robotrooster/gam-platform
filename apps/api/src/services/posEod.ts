import { query, queryOne } from '../db'
import { AppError } from '../middleware/errorHandler'
import { logger } from '../lib/logger'

// S95: POS end-of-day settlement engine.
//
// Closes one (landlord, business_day) by summing pos_transactions and
// pos_refunds within the Phoenix-local calendar day window, then
// upserting a pos_eod_settlements row. Re-running for the same day is
// safe — the UNIQUE(landlord_id, business_day) anchor catches replays
// and ON CONFLICT UPDATE refreshes the totals.
//
// Cash-drawer math is in the table's generated columns; this engine
// only writes the inputs (opening_float + raw totals) and the
// cashier-entered actual when manually closing.
//
// Auto-close (cron): closed_by NULL, status='auto_closed',
//   cash_drawer_actual NULL → variance NULL.
// Manual close: POST /api/pos/eod/close with drawer actual + caller =
//   closed_by, status='manually_closed', variance computed.
// Reopen: admin POST /api/pos/eod/reopen — sets status='reopened' so
//   late-arriving txns/refunds for yesterday can roll in via re-gen.

export interface EodSettlementResult {
  landlordId:      string
  businessDay:     string
  status:          'auto_closed' | 'manually_closed' | 'reopened'
  cashSales:       number
  cardSales:       number
  chargeSales:     number
  cashRefunds:     number
  // S342: post-S339, card_refunds is always 0 (the CHECK constraint
  // dropped 'card' as a valid refund_method). Kept in the result for
  // back-compat with historical settlement rows.
  cardRefunds:     number
  checkRefunds:    number
  chargeRefunds:   number
  txCount:         number
  refundCount:     number
  drawerExpected:  number
  drawerActual:    number | null
  drawerVariance:  number | null
}

interface GenerateOpts {
  closedBy?:           string | null  // user id; null for cron auto-close
  cashDrawerActual?:   number | null  // null on auto-close
  openingFloat?:       number          // defaults to 0
  status?:             'auto_closed' | 'manually_closed'
  notes?:              string | null
}

export async function generateEodSettlement(
  landlordId:  string,
  businessDay: string,  // YYYY-MM-DD (Phoenix-local)
  opts:        GenerateOpts = {},
): Promise<EodSettlementResult> {
  // Phoenix-local day boundary: convert to UTC range for the WHERE.
  // America/Phoenix = UTC-7 year-round (no DST). Day starts at
  // 07:00 UTC and ends just before 07:00 UTC the next morning.
  //
  // S342 fix-it-right: pre-S342 the dayEnd was built by string-
  // interpolating dayStart into the SQL — producing a bare unquoted
  // timestamp literal that postgres rejected with "syntax error
  // near '00'". The service never actually ran successfully (no
  // EOD tests, no cron exercise in dev). Now both bounds use $2
  // as a parameter and compute the end via SQL arithmetic.
  const dayStart = `${businessDay} 00:00:00 America/Phoenix`

  const totals = await queryOne<any>(`
    SELECT
      COALESCE(SUM(CASE WHEN payment_method='cash'   THEN total ELSE 0 END), 0) AS cash_sales,
      COALESCE(SUM(CASE WHEN payment_method='card'   THEN total ELSE 0 END), 0) AS card_sales,
      COALESCE(SUM(CASE WHEN payment_method='charge' THEN total ELSE 0 END), 0) AS charge_sales,
      COALESCE(SUM(tax_amount), 0)   AS tax_collected,
      COALESCE(SUM(surcharge), 0)    AS surcharge_collected,
      COALESCE(SUM(platform_fee), 0) AS platform_fee_total,
      COUNT(*) FILTER (WHERE status IN ('completed','refunded','partial_refund')) AS tx_count,
      COUNT(*) FILTER (WHERE status = 'voided') AS voided_count
    FROM pos_transactions
    WHERE landlord_id = $1
      AND created_at >= $2::timestamptz
      AND created_at <  $2::timestamptz + INTERVAL '1 day'
  `, [landlordId, dayStart])

  const refundTotals = await queryOne<any>(`
    SELECT
      COALESCE(SUM(CASE WHEN refund_method='cash'   THEN amount ELSE 0 END), 0) AS cash_refunds,
      COALESCE(SUM(CASE WHEN refund_method='card'   THEN amount ELSE 0 END), 0) AS card_refunds,
      COALESCE(SUM(CASE WHEN refund_method='check'  THEN amount ELSE 0 END), 0) AS check_refunds,
      COALESCE(SUM(CASE WHEN refund_method='charge' THEN amount ELSE 0 END), 0) AS charge_refunds,
      COUNT(*) AS refund_count
    FROM pos_refunds
    WHERE landlord_id = $1
      AND created_at >= $2::timestamptz
      AND created_at <  $2::timestamptz + INTERVAL '1 day'
  `, [landlordId, dayStart])

  const status        = opts.status        ?? 'auto_closed'
  const openingFloat  = opts.openingFloat  ?? 0
  const drawerActual  = opts.cashDrawerActual ?? null
  const closedBy      = opts.closedBy      ?? null
  const notes         = opts.notes         ?? null

  const row = await queryOne<any>(`
    INSERT INTO pos_eod_settlements (
      landlord_id, business_day,
      cash_sales, card_sales, charge_sales,
      cash_refunds, card_refunds, check_refunds, charge_refunds,
      tax_collected, surcharge_collected, platform_fee_total,
      tx_count, refund_count, voided_count,
      opening_float, cash_drawer_actual,
      status, closed_by, notes
    ) VALUES (
      $1, $2,
      $3, $4, $5,
      $6, $7, $8, $9,
      $10, $11, $12,
      $13, $14, $15,
      $16, $17,
      $18, $19, $20
    )
    ON CONFLICT (landlord_id, business_day) DO UPDATE SET
      cash_sales          = EXCLUDED.cash_sales,
      card_sales          = EXCLUDED.card_sales,
      charge_sales        = EXCLUDED.charge_sales,
      cash_refunds        = EXCLUDED.cash_refunds,
      card_refunds        = EXCLUDED.card_refunds,
      check_refunds       = EXCLUDED.check_refunds,
      charge_refunds      = EXCLUDED.charge_refunds,
      tax_collected       = EXCLUDED.tax_collected,
      surcharge_collected = EXCLUDED.surcharge_collected,
      platform_fee_total  = EXCLUDED.platform_fee_total,
      tx_count            = EXCLUDED.tx_count,
      refund_count        = EXCLUDED.refund_count,
      voided_count        = EXCLUDED.voided_count,
      opening_float       = EXCLUDED.opening_float,
      cash_drawer_actual  = COALESCE(EXCLUDED.cash_drawer_actual, pos_eod_settlements.cash_drawer_actual),
      status              = EXCLUDED.status,
      closed_by           = COALESCE(EXCLUDED.closed_by, pos_eod_settlements.closed_by),
      notes               = COALESCE(EXCLUDED.notes, pos_eod_settlements.notes),
      updated_at          = NOW()
    RETURNING *
  `, [
    landlordId, businessDay,
    totals.cash_sales, totals.card_sales, totals.charge_sales,
    refundTotals.cash_refunds, refundTotals.card_refunds, refundTotals.check_refunds, refundTotals.charge_refunds,
    totals.tax_collected, totals.surcharge_collected, totals.platform_fee_total,
    totals.tx_count, refundTotals.refund_count, totals.voided_count,
    openingFloat, drawerActual,
    status, closedBy, notes,
  ])

  if (!row) throw new AppError(500, 'EOD settlement upsert returned no row')

  return {
    landlordId,
    businessDay,
    status:          row.status,
    cashSales:       Number(row.cash_sales),
    cardSales:       Number(row.card_sales),
    chargeSales:     Number(row.charge_sales),
    cashRefunds:     Number(row.cash_refunds),
    cardRefunds:     Number(row.card_refunds),
    checkRefunds:    Number(row.check_refunds),
    chargeRefunds:   Number(row.charge_refunds),
    txCount:         Number(row.tx_count),
    refundCount:     Number(row.refund_count),
    drawerExpected:  Number(row.cash_drawer_expected),
    drawerActual:    row.cash_drawer_actual === null ? null : Number(row.cash_drawer_actual),
    drawerVariance:  row.cash_drawer_variance === null ? null : Number(row.cash_drawer_variance),
  }
}

// Cron entry point: closes yesterday for every landlord that had POS
// activity. Skips landlords with zero transactions for the day to
// avoid filling pos_eod_settlements with empty rows.
export async function generateEodForAllActiveLandlords(
  businessDay: string,
): Promise<EodSettlementResult[]> {
  const dayStart = `${businessDay} 00:00:00 America/Phoenix`
  const active = await query<{ landlord_id: string }>(`
    SELECT DISTINCT landlord_id FROM pos_transactions
     WHERE created_at >= $1::timestamptz
       AND created_at <  ($1::timestamptz + INTERVAL '1 day')
    UNION
    SELECT DISTINCT landlord_id FROM pos_refunds
     WHERE created_at >= $1::timestamptz
       AND created_at <  ($1::timestamptz + INTERVAL '1 day')
  `, [dayStart])

  const results: EodSettlementResult[] = []
  for (const row of active) {
    try {
      results.push(await generateEodSettlement(row.landlord_id, businessDay))
    } catch (e) {
      logger.error({ err: e }, `[pos-eod] landlord=${row.landlord_id} day=${businessDay}`)
    }
  }
  return results
}

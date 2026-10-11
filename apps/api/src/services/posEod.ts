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

/**
 * SQL, on a stay_refund_parts alias: a 'cash' part that gives back a tenant's
 * own deposit into the landlord's bank (a bank payment with no Stripe charge —
 * the paid-ahead money screen words it "they paid by bank deposit"), never a
 * cash part that replaced a card or bank refund (that cash came out of the
 * drawer). Given back from the bank, so it never counts toward the drawer
 * (review fix, choice46b pass 2).
 */
const BANK_DEPOSIT_GIVE_BACK = (rp: string) => `(${rp}.replaces_part_id IS NULL AND EXISTS (
  SELECT 1 FROM tenant_remittances bdr WHERE bdr.id = ${rp}.remittance_id AND bdr.payment_method = 'ach'))`

export interface EodSettlementResult {
  landlordId:      string
  propertyId:      string
  businessDay:     string
  status:          'auto_closed' | 'manually_closed' | 'reopened'
  cashSales:       number
  cardSales:       number
  chargeSales:     number
  cashRefunds:     number
  // 10/4 (decisions #37.B, #38): money back to the CARD that paid it — an
  // early check-out's refund of a stay paid by card goes back through Stripe
  // and its register refund row says 'card' (S339 had dropped it, so this
  // was always 0 until then). Never part of the cash drawer.
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
  propertyId:  string,  // W-12 (S531): settlements are per property/register
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
      AND property_id = $3
      AND created_at >= $2::timestamptz
      AND created_at <  $2::timestamptz + INTERVAL '1 day'
  `, [landlordId, dayStart, propertyId])

  const refundTotals = await queryOne<any>(`
    -- Fix pass (review r3): cash an early check-out had the desk hand back
    -- with no register sale behind it (stay_refund_parts kind 'cash', no
    -- pos_refunds row) — a card refund given back in cash instead (a
    -- booking-site deposit, a long stay's card or bank rent), or a long
    -- stay's cash rent — also left this property's drawer on the day it was
    -- handed back, and is one more refund that day (fix pass 2). Cash given
    -- back on a register sale has its own cash refund row and is counted
    -- once, there.
    --
    -- Review fix (choice46b): cash handed back from the landlord's paid-ahead
    -- money screen (services/paidAheadChoice — a part with no stay on an
    -- ordinary lease) left the drawer of the property of that choice's lease.
    -- Pass 2: a give-back of a tenant's own deposit into the landlord's bank
    -- (a 'cash' part on a bank payment with no Stripe charge, never one that
    -- replaced a card or bank refund) is given back from the bank, not the
    -- drawer: it is not a cash refund of the day (BANK_DEPOSIT_GIVE_BACK).
    WITH stay_cash AS (
      SELECT COALESCE(SUM(rp.amount), 0) AS amount, COUNT(*) AS n
        FROM stay_refund_parts rp
        LEFT JOIN unit_bookings rb ON rb.id = rp.booking_id
        LEFT JOIN paid_ahead_choices rpc ON rpc.id = rp.paid_ahead_choice_id
        LEFT JOIN leases rpl ON rpl.id = rpc.lease_id
        JOIN units ru ON ru.id = COALESCE(rb.unit_id, rpl.unit_id)
       WHERE rp.landlord_id = $1 AND ru.property_id = $3
         AND rp.kind = 'cash' AND rp.status = 'handed_back' AND rp.pos_refund_id IS NULL
         AND NOT ${BANK_DEPOSIT_GIVE_BACK('rp')}
         AND rp.refunded_at >= $2::timestamptz
         AND rp.refunded_at <  $2::timestamptz + INTERVAL '1 day'
    )
    SELECT
      COALESCE(SUM(CASE WHEN refund_method='cash'   THEN amount ELSE 0 END), 0)
        + (SELECT amount FROM stay_cash) AS cash_refunds,
      -- 10/4 (fix round 2): a card refund Stripe later sent back stays on its
      -- own day and comes off the card refunds of the day it came back
      -- (reversed_at) — a closed day is never rewritten.
      COALESCE(SUM(CASE WHEN refund_method='card'   THEN amount ELSE 0 END), 0)
        - COALESCE((SELECT SUM(rv.amount) FROM pos_refunds rv
                     JOIN pos_transactions tv ON tv.id = rv.transaction_id
                    WHERE rv.landlord_id = $1 AND tv.property_id = $3 AND rv.refund_method = 'card'
                      AND rv.reversed_at >= $2::timestamptz
                      AND rv.reversed_at <  $2::timestamptz + INTERVAL '1 day'), 0) AS card_refunds,
      COALESCE(SUM(CASE WHEN refund_method='check'  THEN amount ELSE 0 END), 0) AS check_refunds,
      COALESCE(SUM(CASE WHEN refund_method='charge' THEN amount ELSE 0 END), 0) AS charge_refunds,
      COUNT(*) + (SELECT n FROM stay_cash) AS refund_count
    FROM pos_refunds r
    JOIN pos_transactions t ON t.id = r.transaction_id
    WHERE r.landlord_id = $1
      AND t.property_id = $3
      AND r.created_at >= $2::timestamptz
      AND r.created_at <  $2::timestamptz + INTERVAL '1 day'
  `, [landlordId, dayStart, propertyId])

  const status        = opts.status        ?? 'auto_closed'
  const openingFloat  = opts.openingFloat  ?? 0
  const drawerActual  = opts.cashDrawerActual ?? null
  const closedBy      = opts.closedBy      ?? null
  const notes         = opts.notes         ?? null

  const row = await queryOne<any>(`
    INSERT INTO pos_eod_settlements (
      landlord_id, property_id, business_day,
      cash_sales, card_sales, charge_sales,
      cash_refunds, card_refunds, check_refunds, charge_refunds,
      tax_collected, surcharge_collected, platform_fee_total,
      tx_count, refund_count, voided_count,
      opening_float, cash_drawer_actual,
      status, closed_by, notes
    ) VALUES (
      $1, $21, $2,
      $3, $4, $5,
      $6, $7, $8, $9,
      $10, $11, $12,
      $13, $14, $15,
      $16, $17,
      $18, $19, $20
    )
    ON CONFLICT (landlord_id, property_id, business_day) DO UPDATE SET
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
    propertyId,
  ])

  if (!row) throw new AppError(500, 'EOD settlement upsert returned no row')

  return {
    landlordId,
    propertyId,
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
  // W-12 (S531): one settlement per (landlord, property) with activity —
  // each register/location closes its own drawer. Refund-only days sweep
  // in via the transaction join (a refund's property is its sale's).
  // Fix pass 2 (early check-out review): a day whose only drawer activity is
  // early check-out cash handed back with no register sale behind it (no
  // pos_refunds row) closes too — its property is the stay's unit's, or, for
  // cash handed back from the paid-ahead money screen on a lease with no stay
  // (review fix, choice46b), that lease's unit's.
  const active = await query<{ landlord_id: string; property_id: string }>(`
    SELECT DISTINCT landlord_id, property_id FROM pos_transactions
     WHERE property_id IS NOT NULL
       AND created_at >= $1::timestamptz
       AND created_at <  ($1::timestamptz + INTERVAL '1 day')
    UNION
    SELECT DISTINCT r.landlord_id, t.property_id
      FROM pos_refunds r
      JOIN pos_transactions t ON t.id = r.transaction_id
     WHERE t.property_id IS NOT NULL
       AND ((r.created_at >= $1::timestamptz AND r.created_at < ($1::timestamptz + INTERVAL '1 day'))
            OR (r.reversed_at >= $1::timestamptz AND r.reversed_at < ($1::timestamptz + INTERVAL '1 day')))
    UNION
    SELECT DISTINCT rp.landlord_id, u.property_id
      FROM stay_refund_parts rp
      LEFT JOIN unit_bookings b ON b.id = rp.booking_id
      LEFT JOIN paid_ahead_choices pc ON pc.id = rp.paid_ahead_choice_id
      LEFT JOIN leases pl ON pl.id = pc.lease_id
      JOIN units u ON u.id = COALESCE(b.unit_id, pl.unit_id)
     WHERE u.property_id IS NOT NULL
       AND rp.kind = 'cash' AND rp.status = 'handed_back' AND rp.pos_refund_id IS NULL
       AND NOT ${BANK_DEPOSIT_GIVE_BACK('rp')}
       AND rp.refunded_at >= $1::timestamptz
       AND rp.refunded_at <  ($1::timestamptz + INTERVAL '1 day')
  `, [dayStart])

  const results: EodSettlementResult[] = []
  for (const row of active) {
    try {
      results.push(await generateEodSettlement(row.landlord_id, row.property_id, businessDay))
    } catch (e) {
      logger.error({ err: e }, `[pos-eod] landlord=${row.landlord_id} property=${row.property_id} day=${businessDay}`)
    }
  }
  return results
}

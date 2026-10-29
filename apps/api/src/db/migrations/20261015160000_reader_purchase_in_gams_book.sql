-- 10/13 (Nic) — A CARD READER IN GAM'S OWN BOOK: THE FULL PURCHASE.
--
-- Nic (10/13, afternoon): "Book the $331.73 as an expense the day we buy it,
-- and each $87.50 payment as paying it back (lowers 'earned all time' until
-- repaid)." With the code that ships beside this (services/readerOrders
-- bookReaderBook, @gam/shared readerBookRows), GAM's earnings ledger
-- (platform_revenue_ledger) holds, for every card reader GAM bought:
--   - THE PURCHASE: each cost entry once — the first as minus its total, a
--     dated correction as minus the change (a refund gives some back) — typed
--     'adjustment', reference_type 'reader_purchase', reference_id = the entry
--     (pos_reader_order_costs), on the entry's own day;
--   - THE COST REPAID: each billed piece, cost first under the cost in force
--     the day it was billed (10/12, Q-g) — 'adjustment', reference_type
--     'reader_cost_repaid', reference_id = the piece (landlord_gam_charges), on
--     the day it was billed;
--   - THE MARKUP beyond the cost, as since 10/12 ('device_markup').
-- No new type: an 'adjustment' may already be signed
-- (services/platformRevenue), and @gam/shared READER_BOOK_REFERENCE names the
-- two references the money pies and the GAM-money bridge read.
--
-- BACKFILL (this file): the purchase and the cost repaid of every reader
-- already bought and billed, so the book is whole the day the code ships.
-- Production: Mountain View (order 288cc5df, the only one) — −$331.73 on 9/28
-- (bought from Stripe's shop at 2:36 pm Arizona) and +$87.50 on 10/5 (piece 1
-- of 4, billed 5:29 pm; all of it cost). The same rules as the code: an order
-- with a cost entered, of a real account (no demo or GAM-internal one); the
-- purchase only for an order GAM bought (ordered or further, or cancelled
-- after that); pieces not voided.
--
-- NO DOUBLE COUNTING. An entry or a piece already in the book is skipped (NOT
-- EXISTS — run twice, or after the code has run, it writes nothing). A piece
-- whose markup the 10/12 code already booked ('device_markup') gets as its
-- cost repaid only the rest of the piece, so the piece adds up to what it
-- billed. The markup itself is not written here: the code books it, as it has
-- since 10/12 (production has none due before January 1st).
--
-- The rows land on earlier days than rows already on the book, so the running
-- balance (balance_after) is restated from the earliest reader row on, under
-- the ledger's one lock — as services/platformRevenue restateRunningBalance
-- does. No total is ever read from balance_after.
--
-- UNTIL THE CODE SHIPS (migrations reach production first) the old code reads
-- these as plain adjustments. On production that means, until the deploy:
--   - "Earned ... all time" on the GAM-money card reads $303.67 (was $547.90),
--     which is the right figure;
--   - the bridge lists them under "Other earnings ledger entries" and still
--     ends at $0.00;
--   - the money pies: the month and quarter pies show the $87.50 as
--     "Adjustments". In the year-to-date, rolling-12 and all-time pies
--     "Adjustments" goes to −$233.90 ($10.33 − $244.23). The old ring does not
--     draw a slice below zero, but it sizes the slices above zero ($537.57)
--     against the $303.67 net, so those three rings run about 1.8 times around
--     (the arcs overlap), with no "Adjustments" arc.
-- All of it reads right the moment the code ships (three reader slices; the
-- ring drawn from the slices above zero; @gam/shared incomeRing). Ship the
-- code right after this runs.
--
-- Data only; expand-only; idempotent. Safe to undo: DELETE FROM
-- platform_revenue_ledger WHERE type = 'adjustment' AND reference_type IN
-- ('reader_purchase', 'reader_cost_repaid'), then restate the running balance.

SET LOCAL lock_timeout = '10s';

-- The ledger's one lock (services/platformRevenue PLATFORM_REVENUE_LOCK_SQL).
SELECT pg_advisory_xact_lock(hashtextextended('platform_revenue', 0));

-- 1. The purchase: each cost entry of a reader GAM bought, once.
INSERT INTO platform_revenue_ledger (type, amount, balance_after, reference_id, reference_type, property_id, notes, created_at)
SELECT 'adjustment', -(e.total_cost - COALESCE(e.prev_total, 0)), 0, e.id, 'reader_purchase', e.property_id,
       CASE WHEN e.prev_total IS NULL
            THEN format('Card reader bought — %s: GAM''s cost %s', e.property_name, e.in_words)
            ELSE format('Card reader cost corrected — %s: $%s → %s from %s%s — %s',
                        e.property_name, to_char(e.prev_total, 'FM999999990.00'), e.in_words,
                        to_char(e.effective_on, 'YYYY-MM-DD'),
                        CASE WHEN e.note IS NULL THEN '' ELSE format(' (%s)', e.note) END,
                        CASE WHEN e.total_cost < e.prev_total
                             THEN format('$%s back to GAM', to_char(e.prev_total - e.total_cost, 'FM999999990.00'))
                             ELSE format('$%s more', to_char(e.total_cost - e.prev_total, 'FM999999990.00')) END)
       END,
       -- The entry's own day (services/readerOrders READER_COST_BOOKED_AT_SQL):
       -- for the first entry, the moment GAM bought it when that is the day
       -- (marked Ordered, or the first step after it); else the moment the
       -- entry was typed when that is the day; else noon.
       CASE WHEN e.seq = e.first_seq AND e.bought_at IS NOT NULL
                 AND (e.bought_at AT TIME ZONE 'America/Phoenix')::date = e.effective_on THEN e.bought_at
            WHEN (e.created_at AT TIME ZONE 'America/Phoenix')::date = e.effective_on THEN e.created_at
            ELSE (e.effective_on + time '12:00') AT TIME ZONE 'America/Phoenix' END
  FROM (
    SELECT c.id, c.seq, c.total_cost, c.effective_on, c.created_at, c.note,
           o.property_id, p.name AS property_name,
           COALESCE(o.ordered_at, o.shipped_at, o.delivered_at, o.registered_at) AS bought_at,
           LAG(c.total_cost) OVER (PARTITION BY c.reader_order_id ORDER BY c.seq) AS prev_total,
           MIN(c.seq) OVER (PARTITION BY c.reader_order_id) AS first_seq,
           format('$%s (%s)', to_char(c.total_cost, 'FM999999990.00'),
                  concat_ws(', ', 'base $' || to_char(c.base_price, 'FM999999990.00'),
                            'tax and shipping $' || to_char(c.tax_and_shipping_amount, 'FM999999990.00'),
                            'tax $' || to_char(c.tax_amount, 'FM999999990.00'),
                            'shipping $' || to_char(c.shipping_amount, 'FM999999990.00'))) AS in_words
      FROM pos_reader_order_costs c
      JOIN pos_reader_orders o ON o.id = c.reader_order_id
      JOIN properties p ON p.id = o.property_id
     WHERE EXISTS (SELECT 1 FROM landlords own WHERE own.id = p.landlord_id
                      AND own.is_demo IS NOT TRUE AND own.is_system IS NOT TRUE)
       AND (o.status IN ('ordered', 'shipped', 'delivered', 'registered')
            OR (o.status = 'cancelled'
                AND COALESCE(o.ordered_at, o.shipped_at, o.delivered_at, o.registered_at) IS NOT NULL))
  ) e
 WHERE e.total_cost <> COALESCE(e.prev_total, 0)
   AND NOT EXISTS (SELECT 1 FROM platform_revenue_ledger r
                    WHERE r.type = 'adjustment' AND r.reference_type = 'reader_purchase' AND r.reference_id = e.id);

-- 2. The cost repaid: each billed piece (not voided) of a reader with a cost
-- entered, once — cost first under the cost in force the day it was billed
-- (the latest entry dated on or before it, else the first entry); the rest of
-- the piece when its markup is already booked.
INSERT INTO platform_revenue_ledger (type, amount, balance_after, reference_id, reference_type, property_id, notes, created_at)
SELECT 'adjustment', x.repaid, 0, x.piece_id, 'reader_cost_repaid', x.property_id,
       format('Card reader cost repaid — %s, payment %s of %s ($%s of GAM''s $%s cost)',
              x.property_name, x.n, x.installments,
              to_char(x.repaid, 'FM999999990.00'), to_char(x.cost, 'FM999999990.00')),
       x.billed_at
  FROM (
    SELECT g.id AS piece_id, g.installment_number AS n, g.created_at AS billed_at,
           o.installments, o.property_id, p.name AS property_name, f.cost,
           CASE WHEN mk.amt IS NOT NULL THEN g.amount - mk.amt
                ELSE LEAST(g.amount, GREATEST(0, f.cost - (g.installment_number - 1)
                                                  * (floor(o.price * 100 / o.installments) / 100))) END AS repaid
      FROM landlord_gam_charges g
      JOIN pos_reader_orders o ON o.id = g.reader_order_id
      JOIN properties p ON p.id = o.property_id
      CROSS JOIN LATERAL (
        SELECT COALESCE(
                 (SELECT x.total_cost FROM pos_reader_order_costs x
                   WHERE x.reader_order_id = o.id
                     AND x.effective_on <= (g.created_at AT TIME ZONE 'America/Phoenix')::date
                   ORDER BY x.seq DESC LIMIT 1),
                 (SELECT x.total_cost FROM pos_reader_order_costs x
                   WHERE x.reader_order_id = o.id ORDER BY x.seq LIMIT 1)) AS cost) f
      LEFT JOIN LATERAL (
        SELECT SUM(r.amount) AS amt FROM platform_revenue_ledger r
         WHERE r.type = 'device_markup' AND r.reference_type = 'reader_order_installment'
           AND r.reference_id = g.id) mk ON TRUE
     WHERE g.voided_at IS NULL AND g.installment_number IS NOT NULL
       AND g.installment_number <= o.installments
       AND f.cost IS NOT NULL
       AND EXISTS (SELECT 1 FROM landlords own WHERE own.id = p.landlord_id
                      AND own.is_demo IS NOT TRUE AND own.is_system IS NOT TRUE)
       AND NOT EXISTS (SELECT 1 FROM platform_revenue_ledger r
                        WHERE r.type = 'adjustment' AND r.reference_type = 'reader_cost_repaid'
                          AND r.reference_id = g.id)
  ) x
 WHERE x.repaid > 0;

-- 3. The running balance, from the earliest reader row on.
WITH from_ts AS (
  SELECT MIN(created_at) AS f FROM platform_revenue_ledger
   WHERE type = 'adjustment' AND reference_type IN ('reader_purchase', 'reader_cost_repaid')
), base AS (
  SELECT COALESCE((SELECT l.balance_after FROM platform_revenue_ledger l, from_ts
                    WHERE l.created_at < from_ts.f
                    ORDER BY l.created_at DESC, l.id DESC LIMIT 1), 0) AS b
), run AS (
  SELECT l.id, (SELECT b FROM base)
               + SUM(l.amount) OVER (ORDER BY l.created_at, l.id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS bal
    FROM platform_revenue_ledger l, from_ts
   WHERE from_ts.f IS NOT NULL AND l.created_at >= from_ts.f
)
UPDATE platform_revenue_ledger t SET balance_after = run.bal
  FROM run
 WHERE t.id = run.id AND t.balance_after IS DISTINCT FROM run.bal;

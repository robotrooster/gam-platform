-- 10/12 (Nic) — WHAT EACH CARD READER ACTUALLY COST GAM.
--
-- Nic: "331.73 after tax and shipping. 299 base. those orders are going to
-- need to be tracked because shipping will vary." A landlord is charged the
-- plan price ($350 in four pieces); GAM pays Stripe's shop the base price plus
-- tax plus shipping, and that varies order to order. The markup GAM earns on a
-- reader is the price charged less that actual cost, so every order needs its
-- own cost, typed from the receipt on GAM's Reader Orders desk.
--
-- One row per ENTRY, never edited (keep-everything; "history kept"): the
-- order's cost is its latest entry (highest seq). A correction is a new entry.
--   base_price               — the reader's price in the shop
--   tax_amount, shipping_amount — as the receipt splits them
--   tax_and_shipping_amount  — the two as one figure, when they are not split
--                              (never beside tax_amount or shipping_amount)
--   total_cost               — the sum, computed by the database
--
-- EDITABLE UNTIL MARKUP IS BOOKED. Once markup figured from the cost has been
-- booked as GAM's earnings (a 'device_markup' row in platform_revenue_ledger
-- for one of the order's pieces — services/readerOrders bookReaderMarkup), the
-- total is fixed: a new entry must keep the same total to the cent (it may only
-- split it differently — e.g. the receipt turns up and the "tax and shipping"
-- figure becomes tax and shipping). 10/12 (review): the first draft fixed it
-- the day the reader SHIPPED, but a reader usually ships itself
-- (reconcileReaderOrders marks it shipped when it turns up at the property)
-- before anyone types the receipt, and its markup is not booked until the
-- piece carrying it is billed (cost first: months later). A typo entered after
-- shipping was then permanent, with nothing booked from it yet. Enforced here,
-- not only in the desk's code (pos_reader_order_costs_lock); the order row is
-- locked by both this check and the booking, so neither slips past the other.
--
-- BACKFILL: Mountain View's order (288cc5df, the only order in production,
-- $350, shipped 9/29): base $299.00 + tax and shipping $32.73 = $331.73, from
-- Nic 10/12. The split between tax and shipping is not known, so it is the
-- one 'tax and shipping' figure. Matched by id AND price AND property name, so
-- it is a no-op anywhere else (test and demo databases).
--
-- Journaled (CLAUDE.md, 10/12: the change journal is never pruned) — the
-- audit trigger is here from the start, though the app never updates or
-- deletes a row (a BEFORE UPDATE OR DELETE trigger refuses both, and the order
-- cannot be deleted from under its entries: ON DELETE RESTRICT).
--
-- Values of `source` match READER_ORDER_COST_SOURCES in @gam/shared.
--
-- Expand-only: a new table; nothing reads it until the code ships. Safe drop:
-- DROP TABLE pos_reader_order_costs and its two functions.

CREATE TABLE IF NOT EXISTS pos_reader_order_costs (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq                      bigint GENERATED ALWAYS AS IDENTITY,
  -- RESTRICT (10/12 review): an order with cost entries is never deleted out
  -- from under them (keep-everything).
  reader_order_id          uuid NOT NULL REFERENCES pos_reader_orders(id) ON DELETE RESTRICT,
  base_price               numeric(10,2) NOT NULL CHECK (base_price >= 0),
  tax_amount               numeric(10,2) CHECK (tax_amount >= 0),
  shipping_amount          numeric(10,2) CHECK (shipping_amount >= 0),
  tax_and_shipping_amount  numeric(10,2) CHECK (tax_and_shipping_amount >= 0),
  total_cost               numeric(10,2) GENERATED ALWAYS AS
                             (base_price + COALESCE(tax_amount, 0) + COALESCE(shipping_amount, 0)
                              + COALESCE(tax_and_shipping_amount, 0)) STORED,
  note                     text,
  source                   text NOT NULL DEFAULT 'desk' CHECK (source IN ('desk', 'backfill')),
  entered_by_user_id       uuid REFERENCES users(id),
  created_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pos_reader_order_costs_split_or_together
    CHECK (tax_and_shipping_amount IS NULL OR (tax_amount IS NULL AND shipping_amount IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS pos_reader_order_costs_seq ON pos_reader_order_costs (seq);
CREATE INDEX IF NOT EXISTS pos_reader_order_costs_order ON pos_reader_order_costs (reader_order_id, seq DESC);

-- Editable until markup is booked from it; after that only the same total,
-- split differently (or a first entry if none was ever made). The order row is
-- locked so two entries — or an entry and a booking — cannot both pass.
CREATE OR REPLACE FUNCTION pos_reader_order_costs_lock() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  cur     numeric;
  nxt     numeric;
BEGIN
  PERFORM 1 FROM pos_reader_orders o WHERE o.id = NEW.reader_order_id FOR UPDATE;
  IF NOT EXISTS (SELECT 1 FROM landlord_gam_charges g
                   JOIN platform_revenue_ledger r
                     ON r.reference_id = g.id AND r.type = 'device_markup'
                    AND r.reference_type = 'reader_order_installment'
                  WHERE g.reader_order_id = NEW.reader_order_id) THEN
    RETURN NEW;
  END IF;
  SELECT c.total_cost INTO cur FROM pos_reader_order_costs c
   WHERE c.reader_order_id = NEW.reader_order_id ORDER BY c.seq DESC LIMIT 1;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  -- total_cost is generated after BEFORE triggers run: work it out here.
  nxt := NEW.base_price + COALESCE(NEW.tax_amount, 0) + COALESCE(NEW.shipping_amount, 0)
         + COALESCE(NEW.tax_and_shipping_amount, 0);
  IF nxt IS DISTINCT FROM cur THEN
    RAISE EXCEPTION 'reader order % has markup booked as GAM earnings, so its cost is fixed at % (an entry may only split the same total differently, not make it %)',
      NEW.reader_order_id, cur, nxt
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS pos_reader_order_costs_lock ON pos_reader_order_costs;
CREATE TRIGGER pos_reader_order_costs_lock
  BEFORE INSERT ON pos_reader_order_costs
  FOR EACH ROW EXECUTE FUNCTION pos_reader_order_costs_lock();

-- An entry is never edited and never deleted: a correction is a new entry.
-- 10/12 (review): DELETE too — deleting the newest entry quietly made an older
-- one with a different total the order's cost, while the markup already booked
-- kept the old figure. (TRUNCATE, which fires no row trigger, is left to test
-- databases.)
CREATE OR REPLACE FUNCTION pos_reader_order_costs_no_edit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a reader cost entry is never deleted — add a new entry instead'
      USING ERRCODE = 'check_violation';
  END IF;
  RAISE EXCEPTION 'a reader cost entry is never edited — add a new entry instead'
    USING ERRCODE = 'check_violation';
END $$;

DROP TRIGGER IF EXISTS pos_reader_order_costs_no_edit ON pos_reader_order_costs;
CREATE TRIGGER pos_reader_order_costs_no_edit
  BEFORE UPDATE OR DELETE ON pos_reader_order_costs
  FOR EACH ROW EXECUTE FUNCTION pos_reader_order_costs_no_edit();

-- A money table is journaled from the migration that creates it.
DROP TRIGGER IF EXISTS audit_pos_reader_order_costs ON pos_reader_order_costs;
CREATE TRIGGER audit_pos_reader_order_costs
  AFTER DELETE OR UPDATE ON pos_reader_order_costs
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();

COMMENT ON TABLE pos_reader_order_costs IS
  '10/12 (Nic): GAM''s actual cost of each card reader order (base, tax, shipping), one row per entry, never edited or deleted; the order''s cost is its latest entry (highest seq). Fixed once markup figured from it is booked as GAM earnings (only the same total may be re-split). Markup = pos_reader_orders.price − total_cost.';
COMMENT ON COLUMN pos_reader_order_costs.tax_and_shipping_amount IS
  '10/12: tax and shipping as one figure, when the receipt does not split them. Never beside tax_amount or shipping_amount.';
COMMENT ON COLUMN pos_reader_order_costs.source IS
  '10/12: desk = typed on the admin Reader Orders desk; backfill = recorded from Nic''s figures by migration 20261013160100. @gam/shared READER_ORDER_COST_SOURCES.';

-- Mountain View's reader (Nic 10/12): $299.00 base, $331.73 after tax and shipping.
INSERT INTO pos_reader_order_costs (reader_order_id, base_price, tax_and_shipping_amount, note, source)
SELECT o.id, 299.00, 32.73,
       'Nic 10/12: "331.73 after tax and shipping. 299 base." Tax and shipping not split on the figures given.',
       'backfill'
  FROM pos_reader_orders o
  JOIN properties p ON p.id = o.property_id
 WHERE o.id = '288cc5df-5153-4b1c-b5d4-71f15c5c43d9'
   AND o.price = 350.00
   AND p.name ILIKE 'Mountain View%'
   AND NOT EXISTS (SELECT 1 FROM pos_reader_order_costs c WHERE c.reader_order_id = o.id);

-- 10/13 (Nic) — A READER'S COST IS GAM'S EXPENSE ON A DATE, AND A CORRECTION
-- APPLIES FROM ITS OWN DATE.
--
-- Nic (10/13, card readers, GAM's own books): "record each reader as a GAM
-- expense (loss if cost > charge); allow dated cost corrections; flag missing
-- cost in the morning admin email."
--
-- effective_on — the day an entry applies from. An order's first entry is the
-- day GAM bought the reader (the expense's date); a later entry is a
-- correction (a refund, extra shipping) and applies from its own date, the
-- figure before it kept on record. Entries are never edited or deleted
-- (20261013160100), and each one is dated on or after the entry before it:
-- the record only moves forward.
--
-- THE LOCK CHANGES. 20261013160100 fixed an order's cost total once markup
-- figured from it was booked as GAM's earnings (only the same total could be
-- split differently). A dated correction is exactly a change after that point,
-- so that rule is replaced by this one: a new entry may change the total, but
-- not reach back before the entry it corrects. A piece of the plan books its
-- markup under the entry in force the day it was billed
-- (services/readerOrders bookReaderMarkup); a row already booked is never
-- rewritten. How a loss, and what a correction changes in a piece already
-- booked, go into GAM's book is an open question to Nic — the code books
-- neither. The order row is still locked by every entry, so two entries — or
-- an entry and a booking — cannot pass at once.
--
-- BACKFILL: an order's first entry is dated the day the order was placed with
-- Stripe (ordered_at, Phoenix), or the day it was typed if that was earlier;
-- every later entry the day it was typed. Production: Mountain View's one entry
-- (Nic's $331.73, written by the 10/12 migration on 10/13) → 9/28/2026, the day
-- GAM bought the reader. The never-edit trigger is set aside for that one
-- UPDATE and put back; the change journal records it (audit trigger).
--
-- Expand-only: a new column with a default (the day the row is written, in
-- Phoenix), so the code running now keeps inserting unchanged; the lock only
-- loosens (that code refuses a changed total by itself as well). The column
-- and its backfill run once (guarded on the column); the function is replaced
-- in place. Idempotent. Safe drop: DROP COLUMN effective_on and put back
-- 20261013160100's pos_reader_order_costs_lock.

SET LOCAL lock_timeout = '10s';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'pos_reader_order_costs'
                    AND column_name = 'effective_on') THEN
    ALTER TABLE pos_reader_order_costs
      ADD COLUMN effective_on date NOT NULL DEFAULT ((now() AT TIME ZONE 'America/Phoenix')::date);
    ALTER TABLE pos_reader_order_costs DISABLE TRIGGER pos_reader_order_costs_no_edit;
    UPDATE pos_reader_order_costs c
       SET effective_on = ((CASE WHEN c.seq = f.first_seq
                                 THEN LEAST(COALESCE(o.ordered_at, c.created_at), c.created_at)
                                 ELSE c.created_at END) AT TIME ZONE 'America/Phoenix')::date
      FROM pos_reader_orders o,
           (SELECT reader_order_id, MIN(seq) AS first_seq FROM pos_reader_order_costs GROUP BY reader_order_id) f
     WHERE o.id = c.reader_order_id AND f.reader_order_id = c.reader_order_id;
    ALTER TABLE pos_reader_order_costs ENABLE TRIGGER pos_reader_order_costs_no_edit;
  END IF;
END $$;

-- A new entry may change the total (a dated correction), but never applies
-- from a day before the entry it corrects. The order row is locked so two
-- entries — or an entry and a booking — cannot both pass.
CREATE OR REPLACE FUNCTION pos_reader_order_costs_lock() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  prev date;
BEGIN
  PERFORM 1 FROM pos_reader_orders o WHERE o.id = NEW.reader_order_id FOR UPDATE;
  SELECT c.effective_on INTO prev FROM pos_reader_order_costs c
   WHERE c.reader_order_id = NEW.reader_order_id ORDER BY c.seq DESC LIMIT 1;
  IF FOUND AND NEW.effective_on < prev THEN
    RAISE EXCEPTION 'reader order %: a cost entry applies from its own date, on or after the entry it corrects (%), not %',
      NEW.reader_order_id, prev, NEW.effective_on
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

COMMENT ON TABLE pos_reader_order_costs IS
  '10/12 (Nic): GAM''s actual cost of each card reader order (base, tax, shipping), one row per entry, never edited or deleted; the order''s cost is its latest entry (highest seq). 10/13 (Nic): "allow dated cost corrections" — each entry applies from its effective_on (the first: the day GAM bought the reader; a later one: a correction, never dated before the entry it corrects); a piece of the plan carries the markup under the entry in force the day it was billed. Markup = pos_reader_orders.price − total_cost; a negative markup is a loss.';
COMMENT ON COLUMN pos_reader_order_costs.effective_on IS
  '10/13 (Nic): "allow dated cost corrections" — the day this entry applies from: the first entry, the day GAM bought the reader; a correction, its own date. On or after the entry before it (pos_reader_order_costs_lock).';

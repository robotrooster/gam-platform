-- 10/12 (Nic) — GAM BOOKS LEDGER: EVERY REGISTER-STOCK CHANGE IS KEPT, SO OLD SALES KEEP THEIR COST TREATMENT
--
-- Nic, 10/12 (L8): register stock is the LANDLORD'S CHOICE — expense when
-- bought, or cost per item sold (each register sale moves what its items cost
-- from Inventory 1210 to Cost of goods sold 5300). The owner may change it on
-- the Books settings page; a change applies from the day it is made, so a sale
-- already booked keeps the treatment it was booked with.
--
-- Until now only the latest change was kept (landlords.books_register_stock
-- and books_register_stock_from, 20261014150000), and the ledger read every
-- sale before that day as "the other choice". A second change (A → B on day 1,
-- then B → A on day 5) therefore flipped every sale before day 1 to B on the
-- next rebuild or nightly check — rewriting their cost postings, closed months
-- included (landing on the first open day as corrections). The books must come
-- out the same on every rebuild.
--
-- books_register_stock_changes keeps each choice with the first day it applies
-- (effective_from; NULL = from the books start, used while nothing has posted
-- yet). The register-sale projector (services/ledgerProjectors/
-- registerBookingPayoutKit costPerItemSoldOn) reads the choice in force on the
-- sale's own day: the latest row with effective_from on or before it (a
-- same-day change: the later one). Append-only — a row is never changed or
-- removed (keep-everything); the landlords columns stay as the current choice
-- the settings page shows.
--
-- Backfill: a company that already changed its choice (books_register_stock_
-- from set) gets the two rows the old reading implied — the other choice from
-- the books start, and the current one from that day — so nothing it has
-- re-dates. Every other company reads the landlords columns until its first
-- change (no rows = the current choice from the books start).
-- Values match LEDGER_REGISTER_STOCK_METHODS in packages/shared/src/booksLedger.ts.
-- The ledger is DARK in production until the projector phases are registered.
-- Expand-only; safe to apply before the code ships.
-- Safe drop: DROP TABLE books_register_stock_changes (the reader falls back to
-- the landlords columns).

SET LOCAL lock_timeout = '10s';

CREATE TABLE IF NOT EXISTS books_register_stock_changes (
  id              bigserial PRIMARY KEY,
  landlord_id     uuid NOT NULL REFERENCES landlords(id),
  method          text NOT NULL,
  effective_from  date,
  changed_by      uuid REFERENCES users(id),
  changed_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT books_register_stock_changes_method_check CHECK (method IN ('expense_when_bought', 'cost_per_item_sold'))
);

CREATE INDEX IF NOT EXISTS books_register_stock_changes_landlord
  ON books_register_stock_changes (landlord_id, effective_from);

COMMENT ON TABLE books_register_stock_changes IS
  '10/12 (Nic, L8): every register-stock choice with the first day it applies (NULL = from the books start). The ledger reads the choice in force on each sale''s day. Append-only.';

-- Append-only: a change of mind is a new row, never an edit (keep-everything).
CREATE OR REPLACE FUNCTION books_register_stock_changes_append_only() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'books_register_stock_changes is append-only: record a new choice instead'
    USING ERRCODE = 'restrict_violation';
END $fn$;

DROP TRIGGER IF EXISTS books_register_stock_changes_append_only ON books_register_stock_changes;
CREATE TRIGGER books_register_stock_changes_append_only
  BEFORE UPDATE OR DELETE ON books_register_stock_changes
  FOR EACH ROW EXECUTE FUNCTION books_register_stock_changes_append_only();

-- Backfill (idempotent): the two rows the old single-change reading implied.
INSERT INTO books_register_stock_changes (landlord_id, method, effective_from, changed_at)
SELECT l.id,
       CASE WHEN l.books_register_stock = 'cost_per_item_sold' THEN 'expense_when_bought' ELSE 'cost_per_item_sold' END,
       NULL, '1900-01-01'::timestamptz
  FROM landlords l
 WHERE l.books_register_stock_from IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM books_register_stock_changes c WHERE c.landlord_id = l.id);

INSERT INTO books_register_stock_changes (landlord_id, method, effective_from, changed_at)
SELECT l.id, l.books_register_stock, l.books_register_stock_from, now()
  FROM landlords l
 WHERE l.books_register_stock_from IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM books_register_stock_changes c
                    WHERE c.landlord_id = l.id AND c.effective_from IS NOT DISTINCT FROM l.books_register_stock_from);

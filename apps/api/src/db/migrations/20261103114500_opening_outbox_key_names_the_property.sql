-- 11/3 — A PROPERTY'S DATE QUEUES A PROPERTY'S OPENING.
--
-- Step 2 of per-property books (PER_PROPERTY_BOOKS_PLAN.md), the database half.
--
-- There is now one opening posting per property, plus one for the company's own
-- (the lines that name no property — a bank balance above all, because a bank
-- account cannot be split between properties). Its source id is
-- `landlordId|propertyId`, or the bare `landlordId` for the company's.
--
-- ── WHY THIS FILE IS SMALL ─────────────────────────────────────────────────
-- TEN trigger functions write an opening's outbox key: the three
-- ledger_capture_books_opening_items_*, the three
-- ledger_capture_home_sale_contracts_*, the three
-- ledger_capture_home_sale_installments_*, and ledger_capture_books_start.
-- Every one of them writes the bare company id, and more will be written.
-- Teaching each of them to work out the right property would be ten places to
-- get right now and one more every time a projector feeds the opening — and
-- getting it wrong is silent: the change would queue a key the projector does
-- not answer to, nothing would fail, and the balance sheet would sit
-- unapplied.
--
-- So the engine fans out instead (services/ledgerEngine, the drain): a queued
-- bare `('opening', landlordId)` is expanded to that company's properties
-- before the pass reads the queue. One place, every writer present and future,
-- and an opening that has not changed posts nothing — so the cost of fanning
-- out wider than needed is a no-op drain row per property, never a wrong
-- answer. That is why no capture function is rewritten here.
--
-- ── WHAT STILL NEEDS A TRIGGER ─────────────────────────────────────────────
-- Picking or moving a PROPERTY's date has to queue something, and nothing does
-- today: ledger_capture_books_start sits on `landlords` and fires only when the
-- company's date moves, which is now the EARLIEST of its properties' — so
-- moving a later property's date changes no company row and would queue
-- nothing at all. This trigger queues the company's bare key and lets the
-- engine's fan-out reach the property that actually moved.
--
-- NO BACKFILL NEEDED. Re-runnable.

-- NOT named `ledger_capture_*`: that prefix is the generated capture family
-- (three statement-level triggers per table, on transition tables, on exactly
-- the shared column list), and services/ledgerCoverage.test.ts holds every
-- member of it to that shape. This is a one-off mark, so it takes a name that
-- says so rather than joining a family it would fail.
--
-- STATEMENT-level, on a transition table: saving every property of a company in
-- one UPDATE must mark its opening ONCE, not once per property. The marks are
-- NOT de-duplicated against rows already in the queue, deliberately — the drain
-- reads a row, projects it, and deletes it afterwards, so a change arriving in
-- that gap would be skipped and lost if an existing row suppressed it.
CREATE OR REPLACE FUNCTION queue_opening_on_property_books_start() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- The bare company key on purpose: the drain expands it to this company's
  -- properties, so the property that moved is reached without this function
  -- having to know which openings exist.
  INSERT INTO ledger_outbox (source_type, source_id, owner_id)
  SELECT DISTINCT 'opening', n.landlord_id::text, n.landlord_id
    FROM ledger_new n JOIN ledger_old o ON o.id = n.id
   WHERE n.books_start_date IS DISTINCT FROM o.books_start_date;
  RETURN NULL;
END $$;

COMMENT ON FUNCTION queue_opening_on_property_books_start() IS
  'Marks a company''s openings when one of its properties picks or moves its
   books start date (11/3). Writes the bare company key; the engine''s drain
   fans it out to one key per property. This is the ONLY writer of the opening
   mark for a books-start change — ledger_capture_books_start gave its
   ''opening'' row up to this function, because the company date is derived from
   these and cannot move on its own.';

DROP TRIGGER IF EXISTS ledger_capture_property_books_start ON properties;
DROP TRIGGER IF EXISTS trg_properties_queue_opening ON properties;
-- No `UPDATE OF books_start_date` column list: Postgres refuses a column list
-- together with transition tables. The function's own
-- `IS DISTINCT FROM` filter does that job instead, so every other property save
-- reaches it and inserts nothing — which is how the capture family works too.
CREATE TRIGGER trg_properties_queue_opening
  AFTER UPDATE ON properties
  REFERENCING OLD TABLE AS ledger_old NEW TABLE AS ledger_new
  FOR EACH STATEMENT EXECUTE FUNCTION queue_opening_on_property_books_start();

-- ── the landlords trigger gives up its 'opening' row ───────────────────────
-- It kept writing one, and so does the trigger above, so picking a date left
-- two marks for one job. Since step 1 the company's date is DERIVED and the
-- only thing that can move it is a property's date moving — so the properties
-- trigger always fires when this one would, and this one can stop. The
-- `books_start` re-projection mark stays here: it needs the OLD and NEW company
-- dates, which only this trigger sees.
CREATE OR REPLACE FUNCTION ledger_capture_books_start() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- 'books_start': only when the date MOVES (not when it is first picked) —
  -- every source dated from the earlier of the two dates up to (not including)
  -- the later one changes sides of the start, and the engine re-projects each.
  INSERT INTO ledger_outbox (source_type, source_id, owner_id)
  SELECT v.source_type, v.source_id, NEW.id
    FROM (VALUES ('books_start'::text,
                  CASE WHEN OLD.books_start_date IS NOT NULL AND NEW.books_start_date IS NOT NULL
                       THEN NEW.id::text || '|' || least(OLD.books_start_date, NEW.books_start_date)::text
                                         || '|' || greatest(OLD.books_start_date, NEW.books_start_date)::text END)) v(source_type, source_id)
   WHERE v.source_id IS NOT NULL;
  RETURN NULL;
END $$;

-- ── THE RE-QUEUE IS DELIBERATELY NOT HERE ──────────────────────────────────
-- One opening posting is live (Mountain View, 2026-09-01) and its two lines are
-- property-scoped, so they belong in that property's opening now. Queueing that
-- move from inside this migration would be a trap: the running API is still the
-- OLD build until it is restarted, and the old projectOpening answers a
-- composite source id with `return []`. The drain would take the row, get
-- nothing, mark the source done, and the property's opening would never be
-- written — the balance sheet would quietly lose its opening and no step would
-- have failed. The move is made after the new build is live.

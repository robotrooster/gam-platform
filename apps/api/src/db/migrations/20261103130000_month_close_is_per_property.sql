-- 11/3 — THE MONTH CLOSE BECOMES PER-PROPERTY.
--
-- Nic, 11/3, asked to choose: either the close goes per-property, or a new
-- property's books start is refused inside a closed month. I recommended the
-- second because it is cheap. **He picked the first.**
--
-- WHY HE WAS RIGHT. A close is an accounting assertion about one set of books,
-- and since 11/2 a property IS a separate set: "my books for that property are
-- going to start from when I bought that property… It's a completely separate
-- business revenue stream." A company-level close made that incoherent — a
-- property bought in October and given an October books start could not post a
-- single line if the company was already closed through November, and
-- conversely closing November for a park owned for years had to wait on a park
-- bought last week.
--
-- ── THE SHAPE ──────────────────────────────────────────────────────────────
-- `books_period_closes` is an APPEND-ONLY LOG of close/reopen actions, and the
-- current state is the latest row. That does not change. What changes is that a
-- row now names a property, so "closed through" is a question you ask per
-- property.
--
-- `property_id` is NULLABLE and NULL means THE COMPANY'S OWN SLICE — the lines
-- that name no property, which is where a bank balance lives, because a bank
-- account cannot be split between properties. This is the same split the
-- per-property opening uses, deliberately: one rule for "what belongs to a
-- property and what belongs to the company" across the whole subsystem.
--
-- ── WHY THE GUARD AND THE SERVICE SHIP TOGETHER ────────────────────────────
-- The guard below reads the close of THE LINE'S OWN property. If it shipped
-- while `closeMonth` still wrote one company-level row, every such row would
-- have `property_id IS NULL` and would therefore close only the company's
-- property-less lines — so closing November would silently stop protecting the
-- rent, which is the only thing anyone closes a month to protect. The service
-- writes one row per property PLUS one for the company's slice in the same
-- action, so closing behaves exactly as it does today until someone asks for
-- one property on its own.
--
-- NO BACKFILL NEEDED, AND NOTHING TO MIGRATE: `books_period_closes` and
-- `ledger_close_balances` both hold ZERO rows (verified 2026-11-03), so no
-- close has ever been taken on this platform. `ledger_close_balances` already
-- carries `property_id`.
--
-- Re-runnable.

ALTER TABLE books_period_closes
  ADD COLUMN IF NOT EXISTS property_id uuid REFERENCES properties(id);

COMMENT ON COLUMN books_period_closes.property_id IS
  'Which property this close or reopen is for (11/3). NULL means the COMPANY''S
   OWN slice — the lines that name no property, a bank balance above all. The
   table stays an append-only log; "closed through" for a property is its latest
   row, read with ledger_closed_through(landlord, business, property).';

-- The state read is "the latest row for this owner AND this property", so the
-- property has to be in the index or every read degrades to a scan of the log.
DROP INDEX IF EXISTS books_period_closes_landlord;
CREATE INDEX IF NOT EXISTS books_period_closes_landlord
  ON books_period_closes (landlord_id, property_id, id DESC) WHERE landlord_id IS NOT NULL;

-- ── the state read takes a property ────────────────────────────────────────
-- A DEFAULT keeps every existing 2-argument call working and gives it the
-- meaning it should have: the company's own slice.
--
-- The 2-argument signature has to GO, not be replaced: adding a parameter makes
-- CREATE OR REPLACE define a second, overloaded function, and then
-- `ledger_closed_through($1, NULL)` is ambiguous between the two — "function
-- ledger_closed_through(uuid, unknown) is not unique", which is how this was
-- found. No CASCADE: if anything still depends on the old signature this must
-- fail loudly rather than quietly take that thing with it. Nothing does — the
-- only callers are ledger_posting_lines_guard (rewritten below to pass three)
-- and ledgerOwner.loadOwnerContext, whose two-argument call resolves to the
-- function below once the overload is gone.
DROP FUNCTION IF EXISTS ledger_closed_through(uuid, uuid);

CREATE OR REPLACE FUNCTION ledger_closed_through(
  p_landlord uuid, p_business uuid, p_property uuid DEFAULT NULL
) RETURNS date
LANGUAGE sql STABLE AS $$
  SELECT c.closed_through
    FROM books_period_closes c
   WHERE ((p_landlord IS NOT NULL AND c.landlord_id = p_landlord)
       OR (p_landlord IS NULL AND p_business IS NOT NULL AND c.business_id = p_business))
     AND c.property_id IS NOT DISTINCT FROM p_property
   ORDER BY c.id DESC
   LIMIT 1
$$;

COMMENT ON FUNCTION ledger_closed_through(uuid, uuid, uuid) IS
  'The day this owner''s books are closed through for one property — its latest
   close/reopen row. p_property NULL is the company''s own slice, which is what
   a two-argument call means. NULL result: nothing is closed there.';

-- ── the guard asks about the LINE'S property ───────────────────────────────
CREATE OR REPLACE FUNCTION ledger_posting_lines_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  p          record;
  acct       record;
  locked_to  date;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'A ledger line is never changed or removed; a change is posted as a reversal and a new posting (%).', TG_OP
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT lp.landlord_id, lp.business_id, lp.accounting_date, lp.intended_date, lp.created_xid INTO p
    FROM ledger_postings lp WHERE lp.id = NEW.posting_id;
  IF p.created_xid IS DISTINCT FROM pg_current_xact_id() THEN
    RAISE EXCEPTION 'Ledger lines are written with their posting, in the same transaction.'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.landlord_id IS DISTINCT FROM p.landlord_id OR NEW.business_id IS DISTINCT FROM p.business_id
     OR NEW.accounting_date IS DISTINCT FROM p.accounting_date OR NEW.intended_date IS DISTINCT FROM p.intended_date THEN
    RAISE EXCEPTION 'A ledger line carries its posting''s company and dates.' USING ERRCODE = 'check_violation';
  END IF;
  SELECT a.landlord_id, a.business_id INTO acct FROM books_accounts a WHERE a.id = NEW.account_id;
  IF acct.landlord_id IS DISTINCT FROM NEW.landlord_id OR acct.business_id IS DISTINCT FROM NEW.business_id THEN
    RAISE EXCEPTION 'A ledger line posts to its own company''s chart.' USING ERRCODE = 'check_violation';
  END IF;
  -- The close takes this lock exclusively; holding it shared means the lock
  -- date read below cannot change before this transaction commits. It stays
  -- COMPANY-level even though the close is now per-property: a close action
  -- writes every one of its properties in one transaction, so one lock per
  -- company is both correct and cheaper than one per property.
  PERFORM pg_advisory_xact_lock_shared(ledger_owner_lock_key(NEW.landlord_id, NEW.business_id));
  -- 11/3: the LINE'S OWN property decides. A line that names no property asks
  -- the company's slice, which is what the two-argument call used to mean.
  locked_to := ledger_closed_through(NEW.landlord_id, NEW.business_id, NEW.property_id);
  IF locked_to IS NOT NULL AND NEW.accounting_date <= locked_to THEN
    IF NEW.property_id IS NULL THEN
      RAISE EXCEPTION 'These books are closed through %; this line belongs on the first open day.', locked_to
        USING ERRCODE = 'check_violation';
    ELSE
      RAISE EXCEPTION '% is closed through %; this line belongs on the first open day.',
        COALESCE((SELECT pr.name FROM properties pr WHERE pr.id = NEW.property_id), 'That property'), locked_to
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;

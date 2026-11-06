-- 11/3 — A PARKED POSTING NAMES WHICH PROPERTY IT IS WAITING ON.
--
-- Step 2 of per-property books (PER_PROPERTY_BOOKS_PLAN.md). Once each property
-- has its own books start date, "this company has no books start date yet" is
-- no longer a thing that can be true or false for a company — it is true for
-- one property and false for another.
--
-- WHY A COLUMN, AND WHAT BREAKS WITHOUT IT. The outbox drain retries a parked
-- source IMMEDIATELY, skipping its backoff, when the thing it was waiting for
-- has arrived (services/ledgerEngine, the `no_books_start` carve-out in the
-- drain query). That test is today:
--
--     EXISTS (SELECT 1 FROM landlords l
--              WHERE l.id = e.owner_id AND l.books_start_date IS NOT NULL)
--
-- and the company's date is now the EARLIEST of its properties', so it goes
-- non-null the moment ANY property picks one. A source belonging to a property
-- that has NOT picked one would then be retried on every single drain, fail
-- with the same error, and be retried again — a hot loop over a question
-- nobody has answered. Country Acres already showed what the quiet version of
-- this costs: 67 postings parked through roughly 1,795 retries with nothing
-- telling anyone (migration 20261102050000).
--
-- The alternative that needs no column — "retry only when EVERY property of
-- the company has a date" — is worse than the loop. It would park Mountain
-- View's live money the day a second property is added and before its date is
-- answered, which is money going quiet for a reason the owner cannot see.
--
-- So the error row says which property, and the retry asks about THAT property.
-- A row that names no property (GAM's own fee lines, a company-level entry) is
-- still answered by the company's earliest, which is the same question it asked
-- before.
--
-- This also makes the 11/1 notice better rather than only not-worse: the thing
-- that migration set out to do was name which question a posting is waiting on,
-- and "which property" is half of that question as soon as there are two.
--
-- NO BACKFILL NEEDED. Nullable, and the table holds ZERO rows (verified
-- 2026-11-03); a row written by an older build simply names no property and is
-- answered by the company, which is exactly the old behaviour.
--
-- Re-runnable.

ALTER TABLE ledger_source_errors
  ADD COLUMN IF NOT EXISTS property_id uuid REFERENCES properties(id) ON DELETE SET NULL;

COMMENT ON COLUMN ledger_source_errors.property_id IS
  'The property whose unanswered question is holding this source, when the
   question is per-property (books start date). NULL: the question belongs to
   the company, which is also the case for every row written before 11/3.
   The outbox drain''s immediate retry keys on this — see ledgerEngine.';

-- The drain reads it on every pass, filtered to the waiting-on-owner reasons.
CREATE INDEX IF NOT EXISTS idx_ledger_source_errors_property
  ON ledger_source_errors (property_id)
  WHERE property_id IS NOT NULL;

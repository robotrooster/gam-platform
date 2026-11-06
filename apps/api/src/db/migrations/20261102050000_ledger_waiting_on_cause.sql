-- 11/1 (Nic) — NAME WHICH QUESTION A BLOCKED POSTING IS WAITING ON.
--
-- WHY. Country Acres had money from September and no books start date, so 67
-- postings parked through roughly 1,795 retries and NOTHING ever told anyone:
-- the waiting-on-owner reasons are excluded from every alert path on purpose
-- (ledgerEngine LEDGER_WAITING_ON_OWNER_REASONS), and the nightly parity check
-- skips a company whose books start is NULL outright. Nic, on finding it:
-- "Nothing has ever told anyone ... That's worth closing regardless of who
-- picks the date."
--
-- WHY A NEW COLUMN. The notice has to group by the QUESTION, and neither
-- existing field can do it. `reason_code` is two values covering six questions.
-- `last_error` carries a landlord's own loan name or a books start date
-- interpolated into the sentence (ledgerProjectors/loansAssets, tenantOpening),
-- so grouping by the message would split one question into a row per loan.
--
-- Values are LEDGER_WAITING_ON_CAUSES in packages/shared/src/booksLedger.ts —
-- the CHECK below lists the same seven, as the single-source-of-truth rule
-- requires.
--
-- NO BACKFILL NEEDED. Nullable, and every pre-existing row has already drained
-- (ledger_source_errors is empty as of 2026-11-01 21:14). A row written by an
-- older build simply has no cause and is grouped as unknown, which the notice
-- says in those words rather than guessing.
ALTER TABLE ledger_source_errors
  ADD COLUMN IF NOT EXISTS waiting_on text;

-- ADD CONSTRAINT is not idempotent and these migrations are replayed by a test,
-- so drop first.
ALTER TABLE ledger_source_errors
  DROP CONSTRAINT IF EXISTS ledger_source_errors_waiting_on_check;
ALTER TABLE ledger_source_errors
  ADD CONSTRAINT ledger_source_errors_waiting_on_check CHECK (
    waiting_on IS NULL OR waiting_on IN (
      'books_start',
      'home_sale_method',
      'work_trade_method',
      'opening_balances_stale',
      'loan_opening_balance',
      'loan_proceeds_destination',
      'business_phase'
    )
  );

-- The notice asks one question of the table: per company, which causes have a
-- row nobody has been told about yet.
CREATE INDEX IF NOT EXISTS ix_ledger_source_errors_waiting
  ON ledger_source_errors (owner_id, waiting_on, noticed_at)
  WHERE waiting_on IS NOT NULL;

COMMENT ON COLUMN ledger_source_errors.waiting_on IS
  'Which unanswered question is blocking this posting (LEDGER_WAITING_ON_CAUSES). NULL for a failure that is not waiting on anyone, or one recorded before 11/1.';

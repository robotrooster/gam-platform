-- S260 (Session A): FlexDeposit missed-installment legal remedy — schema.
--
-- Adds acceleration-state machinery + reworks the pull schedule to the
-- rent_due − 5 / rent_due − 1 model resolved in S259. Backend wiring +
-- ToS clauses ship in the same session; supersedence routing engine
-- (the larger piece touching the rent webhook + allocation engine)
-- ships in Session B.
--
-- 6 forks resolved S259:
--   F1 = 2-strike → acceleration to full balance due
--   F2 = GAM holds deposit in escrow throughout the lease (no move-in
--        Connect Transfer to landlord; settle at lease-end with whatever
--        was collected, GAM eats any gap)
--   F3 = pull-day primary = rent_due − 5, retry = rent_due − 1; ToS gives
--        GAM ACH priority; terminal default, no cure window
--   F4 = landlord-side surface = zero (no toggle / disclosure / copy)
--   F5 = custody fee continues on defaulted plans (deposit still in
--        custody, fee accrues)
--   F6 = no per-state legal carve-out — private GAM↔tenant contract,
--        landlord's eviction rights derivative of lease's rent terms
--
-- Acceleration model:
--   - Each installment cycle has TWO pull attempts: primary (rent_due−5)
--     and retry (rent_due−1).
--   - If both fail, installment is defaulted = 1 strike.
--   - Two consecutive defaulted installments → plan flips to 'accelerated':
--     remaining balance becomes immediately due via a single full-balance
--     pull attempt. On failure → 'in_default' terminal state.
--   - in_default does NOT freeze custody fee (deposit still partly held).
--
-- ── Schema additions ─────────────────────────────────────────────────
--
-- security_deposits:
--   + balance_due_full_at  timestamptz  — when acceleration fired
--   + balance_due_total    numeric      — full remaining balance at
--                                         acceleration (sum of unpaid
--                                         installments at that moment)
--   ~ flex_deposit_plan_status CHECK — adds 'accelerated' state
--
-- flex_deposit_installments:
--   + primary_pull_date  date     — rent_due_day − 5 (primary attempt)
--   + retry_pull_date    date     — rent_due_day − 1 (retry on primary fail)
--   + attempt_count      integer  — pulls fired (0/1/2; 2 = both attempts
--                                   exhausted, defaulted on retry)
--
--   Existing rows: primary_pull_date is backfilled from due_date (no
--   retry, attempt_count=0). The legacy due_date column stays as the
--   semantic "cycle's rent due date" reference; the cron transitions
--   to use primary_pull_date / retry_pull_date.

BEGIN;

-- ── security_deposits: acceleration columns + status enum extension ──

ALTER TABLE security_deposits
  ADD COLUMN balance_due_full_at timestamp with time zone,
  ADD COLUMN balance_due_total   numeric(10, 2);

ALTER TABLE security_deposits
  DROP CONSTRAINT security_deposits_plan_status_check;

ALTER TABLE security_deposits
  ADD CONSTRAINT security_deposits_plan_status_check CHECK (
    flex_deposit_plan_status IS NULL
    OR flex_deposit_plan_status = ANY (ARRAY[
      'active',
      'completed',
      'accelerated',
      'in_default'
    ])
  );

COMMENT ON COLUMN security_deposits.balance_due_full_at IS
  'S260: timestamp when 2-strike acceleration fired. NULL until the second consecutive installment defaults.';
COMMENT ON COLUMN security_deposits.balance_due_total IS
  'S260: full remaining balance owed at the moment acceleration fired (sum of unpaid installments). Single ACH pull attempted at this amount.';

-- ── flex_deposit_installments: pull-schedule rework ──────────────────

ALTER TABLE flex_deposit_installments
  ADD COLUMN primary_pull_date date,
  ADD COLUMN retry_pull_date   date,
  ADD COLUMN attempt_count     integer NOT NULL DEFAULT 0;

-- Backfill primary_pull_date from existing due_date for in-flight plans.
-- retry_pull_date stays NULL on legacy rows (the old single-attempt
-- model). New plans created post-migration get both dates populated by
-- the enrollment service.
UPDATE flex_deposit_installments
   SET primary_pull_date = due_date
 WHERE primary_pull_date IS NULL;

COMMENT ON COLUMN flex_deposit_installments.primary_pull_date IS
  'S260: first ACH pull attempt date. Computed at enrollment as rent_due_day − 5 for the installment cycle month.';
COMMENT ON COLUMN flex_deposit_installments.retry_pull_date IS
  'S260: second ACH pull attempt date, fires only if primary failed. Computed at enrollment as rent_due_day − 1 for the installment cycle month.';
COMMENT ON COLUMN flex_deposit_installments.attempt_count IS
  'S260: count of ACH pulls fired for this installment (0/1/2). 0=untouched, 1=primary attempted, 2=both attempted (defaulted if neither settled).';

-- Cron will query against (primary_pull_date, status, attempt_count)
-- and (retry_pull_date, status, attempt_count) — narrow indexes to
-- keep the daily walk cheap as the table grows.
CREATE INDEX idx_flex_dep_inst_primary_pull
  ON flex_deposit_installments (primary_pull_date)
  WHERE status = 'pending' AND attempt_count = 0;

CREATE INDEX idx_flex_dep_inst_retry_pull
  ON flex_deposit_installments (retry_pull_date)
  WHERE status = 'pending' AND attempt_count = 1;

COMMIT;

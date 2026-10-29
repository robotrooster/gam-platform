-- 10/13 evening (Nic) — THE BROKEN CREDIT CHAIN GOES IN THE 8:05 MORNING ADMIN EMAIL.
--
-- Nic: "Broken credit chain: fold into the 8:05 MORNING admin email (not its
-- own 3 am email)." The nightly credit chain check (03:00, jobs/creditNightly →
-- services/creditChainCheck) used to send its own admin email the moment it
-- found a broken chain, and another when it could not finish. Now it only
-- writes down what it found, here, and the one 8:05 morning admin email
-- (services/readerOrders chaseReaderOrders — the card-reader chase, which
-- already goes out every morning anything waits on GAM) carries it: each
-- broken chain named, or that the check did not run (a failed run, one still
-- unfinished, or no run on record since the morning before — so a quiet
-- morning still means every chain is whole).
--
-- One row per night: started when the check starts ('running'), finished with
-- its outcome — 'whole', 'broken' (the chains named in broken_chains, as the
-- email words them), or 'failed' (error). Outcomes mirror @gam/shared
-- CREDIT_CHAIN_CHECK_OUTCOMES. Rows are kept (a record of every night's
-- check); nothing deletes them.
--
-- No money column. Expand-only; no backfill needed (the first night after the
-- deploy writes the first row); idempotent. Safe to drop with the code that
-- reads it.

CREATE TABLE IF NOT EXISTS credit_chain_check_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  outcome       text NOT NULL DEFAULT 'running',
  -- Chains checked, whole (never restarted, or whole since a restart), broken.
  subjects      integer,
  whole         integer,
  broken        integer,
  -- The broken chains: whose record, the first bad entry and the break, with
  -- their ids (services/creditChainCheck BrokenChain) — the email's lines.
  broken_chains jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Why a check that could not finish stopped.
  error         text,
  CONSTRAINT credit_chain_check_runs_outcome_check CHECK (outcome IN ('running', 'whole', 'broken', 'failed')),
  CONSTRAINT credit_chain_check_runs_finished CHECK ((outcome = 'running') = (finished_at IS NULL))
);

CREATE INDEX IF NOT EXISTS credit_chain_check_runs_started ON credit_chain_check_runs (started_at DESC);

COMMENT ON TABLE credit_chain_check_runs IS
  '10/13 (Nic): the nightly credit chain check writes what it found here; the 8:05 morning admin email reports it (broken chains, or that the check did not run).';

-- S609 (Nic, DIRECTIVE): what happens to autopay when a pull fails.
--
-- Nic chose: the schedule STAYS ON after a failure, both sides are told, and it
-- disarms itself after two failures in a row.
--
-- The reasoning on each half:
--
--   STAYS ON — a bank rejects a pull for ordinary reasons (the deposit landed a
--   day late, a transfer had not cleared). Turning autopay off on the first
--   failure means a tenant who fixed it the next day is silently unscheduled,
--   and they will not notice until they are late. The rent is still owed either
--   way; the existing ACH retry engine (services/achRetry) handles the retry
--   itself under NACHA rules, unchanged.
--
--   BOTH SIDES TOLD — the tenant needs to know the money did not move, because
--   they believe it did. The landlord needs to know too: they are watching a
--   lease that says "autopay scheduled" and would otherwise read silence as a
--   tenant who simply did not pay, and act on it.
--
--   DISARMS AFTER TWO — a closed or wrong account fails every month forever, and
--   the tenant's own bank charges them for each attempt. Two is where a bad
--   month stops looking like a bad month.
--
-- consecutive_failures resets to 0 on any successful pull, so a tenant who has
-- one bad month a year never trips the cut-off.
--
-- Disarming does NOT delete the arrangement: the row stays, enabled=FALSE, with
-- the reason and the date. The tenant sees why it stopped and turns it back on
-- in one click, and the landlord sees that it stopped rather than the row simply
-- vanishing.

ALTER TABLE tenant_autopay
  ADD COLUMN IF NOT EXISTS consecutive_failures integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS disarmed_at          timestamptz,
  ADD COLUMN IF NOT EXISTS disarmed_reason      text,
  -- The cycle the last SUCCESSFUL charge covered, kept separate from
  -- last_run_cycle (which advances on any attempt, success or failure, and is
  -- what stops the runner charging the same tenant twice in one month).
  ADD COLUMN IF NOT EXISTS last_success_cycle   date;

COMMENT ON COLUMN tenant_autopay.consecutive_failures IS
  'S609: failed pulls in a row. Reset to 0 by any success. At 2 the arrangement disarms itself — a closed account would otherwise cost the tenant a bank fee every month forever.';

COMMENT ON COLUMN tenant_autopay.disarmed_reason IS
  'S609: why autopay stopped, in the tenant''s words on their screen. Set only when the system disarmed it; a tenant switching it off themselves just sets enabled=FALSE.';

COMMENT ON COLUMN tenant_autopay.last_run_cycle IS
  'S609: the cycle the runner last ATTEMPTED (success or failure). The idempotency guard — one attempt per lease per cycle, so a restarted job or a second server cannot double-charge a tenant.';

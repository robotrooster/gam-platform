-- S641 — remember that we chased somebody about an unfinished bank setup.
--
-- Two residents were sitting in Stripe's `requires_action` with microdeposits
-- sent and never confirmed. One had been stalled nine days. The other had tried
-- twice, failed once, and was being mailed "Late payment alert — Day 10" at the
-- same time. Nothing chased either of them: the portal showed a bank on file,
-- the late-fee engine saw somebody not paying, and the step between the two was
-- one nobody was reminded to take.
--
-- Two columns rather than a table: the nudge needs a last-sent time and a
-- ceiling, and nothing else a row on the tenant cannot carry.
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS bank_verify_nudge_at    timestamptz,
  ADD COLUMN IF NOT EXISTS bank_verify_nudge_count integer NOT NULL DEFAULT 0;

-- Reset the counter whenever a fresh setup begins, so somebody who abandons one
-- attempt and starts another is chased about the NEW one.
COMMENT ON COLUMN tenants.bank_verify_nudge_count IS
  'S641: reminders sent for the CURRENT unfinished bank setup. Reset when a new setup starts or the bank verifies.';

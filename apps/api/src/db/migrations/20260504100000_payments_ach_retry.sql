-- S124: ACH retry tracking on payments. NACHA permits up to 2 retries per
-- failed ACH transaction. The pre-existing retry_count + return_code
-- columns from the legacy ACH path are preserved; this migration adds
-- the timing columns the retry cron needs.
--
-- retry_count caps at 2 via CHECK (existing column had no constraint).
-- After the second retry fails, status='failed' is permanent and
-- next_retry_at clears.

ALTER TABLE payments
  ADD COLUMN next_retry_at  timestamp with time zone,
  ADD COLUMN last_retry_at  timestamp with time zone;

-- Cap retry_count at 2 (NACHA limit). Existing rows have 0; safe to add.
ALTER TABLE payments
  ADD CONSTRAINT payments_retry_count_check
  CHECK (retry_count >= 0 AND retry_count <= 2);

-- Index for the retry cron's daily scan: due retries only.
CREATE INDEX idx_payments_ach_retry_due
  ON payments(next_retry_at ASC)
  WHERE status = 'failed' AND next_retry_at IS NOT NULL;

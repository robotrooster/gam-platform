-- 10/12 (Nic): the tenant sees BANKED extra hours as hours only — "6 extra
-- hours this month — banked".
--
-- banked_hours on the agreement is a running balance; nothing recorded which
-- close added how much, so the tenant could be told what they have banked but
-- never what a month's extra work came to. The month close now records, on the
-- period it closes, the hours that run added to the bank (approved hours beyond
-- what that month and any carried shortfall needed). Hours only — never a
-- dollar figure (S643).
--
-- Expand-only. No backfill: closes before 10/12 did not record it, and 0 reads
-- as "nothing recorded", which is true.
ALTER TABLE work_trade_settlements
  ADD COLUMN IF NOT EXISTS extra_hours_banked numeric(8,2) NOT NULL DEFAULT 0;

ALTER TABLE work_trade_settlements
  ADD CONSTRAINT work_trade_settlements_extra_hours_banked_nonneg CHECK (extra_hours_banked >= 0);

COMMENT ON COLUMN work_trade_settlements.extra_hours_banked IS
  '10/12: hours the month close of this period added to the agreement''s bank — approved hours beyond what this month and any carried shortfall needed. Hours only (S643). Rises only; a re-run that finds nothing new adds nothing.';

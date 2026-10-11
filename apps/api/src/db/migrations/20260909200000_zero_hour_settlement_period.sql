-- S639 EMERGENCY: three people signed a lease and no lease was created.
--
-- Admin critical, 2026-09-09 19:07:29 — "Lease build failed for signed document
-- 6330ee83… new row for relation work_trade_settlements violates check
-- constraint work_trade_settlements_target_positive". MH 10 at Mountain View:
-- Nicholas Rhoades signed 09-03, Brandon Valdez 09-09 18:23, Yesenia Sanchez
-- 09-09 19:07 — and her signature, the last one, triggered the build that died.
-- The document sat at execution_failed with three real signatures on it.
--
-- Cause is mine, from earlier the same day. S637 added tracks_hours as the
-- parent switch for work trade — Nic: "you set a higher parent that says, do we
-- track hours for this work trade? If yes, then set the hours. If no, no hours."
-- MH 10 is exactly that: a zero-hour agreement for Brandon Valdez.
--
-- moveInBundle was written for it and says so in its own comment: "a ZERO-hour
-- agreement still opens a period. It has nothing to settle, but the period is
-- what carries the credit onto the invoice — skipping it would leave the
-- move-in charges suspended forever with nothing to release them." It inserts
-- target_hours = 0 deliberately. The CHECK constraint predates that switch and
-- still demanded > 0, so the row the code was designed to write was rejected by
-- the table it was written for. I changed the code and left the constraint.
--
-- Zero is a legitimate target now: it means the landlord asked for no hours.
-- Negative still is not, so the rule keeps its teeth.
ALTER TABLE work_trade_settlements
  DROP CONSTRAINT IF EXISTS work_trade_settlements_target_positive;

ALTER TABLE work_trade_settlements
  ADD CONSTRAINT work_trade_settlements_target_nonnegative
  CHECK (target_hours >= 0);

COMMENT ON CONSTRAINT work_trade_settlements_target_nonnegative ON work_trade_settlements IS
  'S639: zero is a real target — a tracks_hours=false agreement asks for no hours and still opens a settlement period, because the period is what carries the credit onto the invoice. Negative remains impossible.';

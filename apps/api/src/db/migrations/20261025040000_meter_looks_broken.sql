-- 10/25 (Nic) — A ROLLBACK FLAGS THE METER, NOT THE READ.
--
--   "We already designed in the system where a meter rolling back is not a rule
--    that I asked for. If it's 40,000 and it rolls back 39999, that just needs
--    to flag in the system that the meter may be broken. I don't want to have to
--    double check a read."
--
-- On 10/24 he said: "if a meter read is within one or two digits of the other
-- read, even if it's lower, just go straight into marking it as potentially
-- broken, because sometimes it can roll back a little bit." I read "it" as the
-- READ and made the figure wait on his double-check. He meant the METER.
--
-- The difference is the whole point. Holding the read gave him two things to
-- clear for one finished stay — a "closing read still due" that was already
-- taken, and a "reading to double-check" — for Patrick Neuman's RV 06, a spot
-- he had already finished with. His words: "Neither of those should be there...
-- The system is not operating correctly if those are there. Full stop."
--
-- So the read goes through and bills, and the METER carries the suspicion until
-- somebody looks at it. Deliberately NOT out_of_service: that stops the meter
-- being billed at all, and billing never blocks on a flag (standing rule). This
-- is "somebody should look at this", not "this meter is gone".
--
-- NO BACKFILL NEEDED. NULL means nobody has had reason to doubt it, which is
-- true of every meter until a read says otherwise.
ALTER TABLE utility_meters
  ADD COLUMN IF NOT EXISTS looks_broken_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS looks_broken_reason TEXT;

COMMENT ON COLUMN utility_meters.looks_broken_at IS
  'When a read made this meter look broken (a rollback, or a figure that barely moved when it should have). The read still bills; this is a prompt to go and look at the meter. Cleared when somebody confirms it is fine.';

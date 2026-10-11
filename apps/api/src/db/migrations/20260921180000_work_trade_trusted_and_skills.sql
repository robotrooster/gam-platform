-- S652 — WORK TRADE: TRUSTED OR MONITORED, AND WHAT A PERSON CAN FIX.
--
-- Nic: "Some people can be trusted to do their own hours, no problem. And some
-- people need to be monitored." And: "trusted people can check off a job to
-- make sure it was done correctly. Anybody that's trusted that can't check off
-- their own job isn't really trusted" — so trusted also replaces a separate
-- "team lead" flag.
--
-- trusted: hours this person logs count as soon as they are logged (the
--   landlord can still deny them before the month closes). Monitored (false)
--   hours stay "logged" until the landlord approves or denies them; only
--   approved hours reduce the bill, so anything still logged at month close
--   counts as not worked.
-- skills: which skilled maintenance categories this person may see and take.
--   General, landscaping, cleaning and pest work is open to every work trader
--   at the property; everything else needs the matching skill.
--
-- Distinct from tracks_hours=false (S637), which asks for no hours at all.
-- No backfill: every existing agreement starts monitored with no skills.
ALTER TABLE work_trade_agreements
  ADD COLUMN IF NOT EXISTS trusted boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS skills  text[]  NOT NULL DEFAULT '{}';
ALTER TABLE work_trade_agreements DROP CONSTRAINT IF EXISTS work_trade_agreements_skills_check;
ALTER TABLE work_trade_agreements ADD CONSTRAINT work_trade_agreements_skills_check
  CHECK (skills <@ ARRAY['plumbing','electrical','hvac','appliance','roofing','structural','pool','locksmith']);

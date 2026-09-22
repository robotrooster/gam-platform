-- S652 — WORK TRADERS TAKE MAINTENANCE JOBS FROM THEIR TENANT PORTAL.
--
-- Nic: "I want them to be self-starters. I want them to see all the jobs and
-- just start knocking it out... things that are intrinsically low cost should
-- just be visible to everybody and things that are potentially expensive or
-- skilled are assigned... this guy can do electric and plumbing, so any
-- maintenance that picks up electric or plumbing scopes to that person."
--
-- work_trade_access — who among a property's work traders sees an UNASSIGNED job:
--   auto   — by category: general/landscape/cleaning/pest to everyone, a
--            skilled category to those holding that skill (the default)
--   anyone — every work trader, whatever the category
--   none   — no work trader; staff or a direct assignment only
-- done_by_user_id / needs_check / checked_by / checked_at — "trusted people can
--   check off a job to make sure it was done correctly." A skilled job finished
--   by a MONITORED work trader waits for the landlord or a trusted work trader
--   to confirm it; everything else is done when it is marked done.
-- No backfill: every existing job is 'auto' and needs no check.
ALTER TABLE maintenance_requests
  ADD COLUMN IF NOT EXISTS work_trade_access text NOT NULL DEFAULT 'auto'
    CHECK (work_trade_access IN ('auto','anyone','none')),
  ADD COLUMN IF NOT EXISTS done_by_user_id uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS needs_check boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS checked_by uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS checked_at timestamptz;

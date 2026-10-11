-- S637 (Nic): make hour-tracking a parent switch on the agreement.
--
--   "Make it where you set hours, but you set a higher parent that says, do we
--    track hours for this work trade? If yes, then set the hours. If no, no
--    hours."
--
-- Why it exists (Nic): "I'm thinking about doing that for anybody that I can
-- trust to actually get done, and I wanna only track hours on people that I
-- can't trust to get enough done." Also covers an owner-occupied residence and a
-- purchase-credit tenancy that must be signed but never billed.
--
-- The target stays a normal positive number so it survives being switched off
-- and back on. tracks_hours is what decides whether it is asked for at all: when
-- false the agreement's covered charges are credited in full every month and
-- nobody logs or approves anything.
ALTER TABLE work_trade_agreements
  ADD COLUMN IF NOT EXISTS tracks_hours boolean NOT NULL DEFAULT true;

-- Restore the positive check relaxed earlier in this session: with the parent
-- switch the target no longer has to represent "no hours" by being zero.
ALTER TABLE work_trade_agreements
  DROP CONSTRAINT IF EXISTS work_trade_agreements_target_nonneg;

ALTER TABLE work_trade_agreements
  DROP CONSTRAINT IF EXISTS work_trade_agreements_target_positive;

ALTER TABLE work_trade_agreements
  ADD CONSTRAINT work_trade_agreements_target_positive
  CHECK (monthly_hours_target > 0);

COMMENT ON COLUMN work_trade_agreements.tracks_hours IS
  'S637: false = trusted trade. Covered charges clear each month with no hours logged; monthly_hours_target is retained but not asked for.';

-- The switch rides from the INVITE as well, the same way covered charges do
-- (S635). The agreement is created at sign-completion from the intent, so a
-- trusted trade has to be decidable before anyone signs — otherwise the first
-- move-in invoice bills hours nobody agreed to track.
-- NULL = not stated = tracked, so every invite written before this behaves
-- exactly as it did.
ALTER TABLE pending_tenant_intents
  ADD COLUMN IF NOT EXISTS work_trade_tracks_hours boolean;

COMMENT ON COLUMN pending_tenant_intents.work_trade_tracks_hours IS
  'S637: false = create the agreement as a trusted trade (no hours logged). NULL = not stated, tracked.';

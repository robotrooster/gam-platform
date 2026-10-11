-- S652: the last resort when a landlord will not let GAM collect what it is owed.
--
-- Nic: "In the off chance they refuse to put a bank account in there, we can
-- just lock down all the data and say, please, when they log in, maybe the only
-- thing they can see is 'please contact GAM support to restore your account
-- access.' I don't think that'll hardly ever happen, but it's good to have a
-- safety precaution."
--
-- The fee is not optional (see the gam-debit migrations): a landlord does not
-- get to decline paying for the park GAM runs. But every collection route ends
-- at a bank — netting from a payout, or an ACH debit — and a landlord with no
-- usable bank link has quietly opted out of all of them. Until now the only
-- consequence was an error in a log nobody reads.
--
-- THIS IS FLIPPED BY A HUMAN, NOT BY A SWEEP. An automatic lockout is one bug
-- away from taking a paying customer's business offline on a Saturday, and the
-- blast radius is their whole operation. The nightly job SURFACES candidates;
-- somebody at GAM decides. `locked_by_user_id` records who, because a decision
-- this heavy should have a name on it.
--
-- WHAT IT DOES NOT TOUCH: tenants. Rent still gets paid, maintenance still gets
-- filed, and a resident never learns their landlord is in a dispute with a
-- software company. Locking the people who owe GAM nothing would be punishing
-- the wrong party to make a point.

ALTER TABLE landlords
  ADD COLUMN IF NOT EXISTS platform_locked_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS platform_locked_reason TEXT,
  ADD COLUMN IF NOT EXISTS platform_locked_by     UUID REFERENCES users(id),
  -- When GAM first told them the collection route was broken. The gap between
  -- this and platform_locked_at is the answer to "were they warned?", which is
  -- the first question anybody will ask.
  ADD COLUMN IF NOT EXISTS uncollectable_notice_at TIMESTAMPTZ;

COMMENT ON COLUMN landlords.platform_locked_at IS
  'S652: portal access suspended — owes GAM with no bank to collect from. Set by a person at GAM, never by a job. Tenants are unaffected.';

CREATE INDEX IF NOT EXISTS landlords_platform_locked_idx
  ON landlords (platform_locked_at) WHERE platform_locked_at IS NOT NULL;

-- Landlord-to-landlord referrals (S567).
--
-- WHY: landlords get a referral code too (users.referral_code already exists).
-- When landlord B signs up with landlord A's code, A becomes the CLOSER on B —
-- earning the closing 25¢/occupied unit/month residual, identical to a PM who
-- closes a deal. But a landlord can't do platform customer service, so B's
-- SERVICE 25¢ breaks off to a PM (assigned by super_admin). This is the one
-- clean closing/CS split, and it hands CS reps real properties instead of a
-- pile of self-signup duplexes.
--
-- referred_by_user_id = the referring landlord's USER id (commission_accruals
-- .manager_id points at users, so this is the direct closing beneficiary). It
-- is mutually exclusive with portfolio_manager_id: a landlord-referred signup
-- has NO PM closer (portfolio_manager_id stays NULL); the accrual routes the
-- closing 25¢ to referred_by_user_id and the service 25¢ to service_manager_id.
--
-- NO BACKFILL: existing landlords were not referred (NULL).

ALTER TABLE landlords
  ADD COLUMN referred_by_user_id uuid REFERENCES users(id);

COMMENT ON COLUMN landlords.referred_by_user_id IS
  'The referring LANDLORD''s user id (S567). Set when this landlord signed up '
  'with another landlord''s referral code. That referrer earns the closing 25¢/'
  'occupied unit/mo residual (as a closer); customer service still routes to a '
  'PM via service_manager_id. Mutually exclusive with portfolio_manager_id.';

CREATE INDEX landlords_referred_by_user_id_idx
  ON landlords (referred_by_user_id);

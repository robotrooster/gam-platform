-- S67: drop pre-16a Stripe Connect columns from landlords.
--
-- Under the 16a model GAM is the sole merchant of record. There are no
-- per-landlord Connect accounts; payouts go via ACH credits to user_bank_
-- accounts entries. The two columns we're dropping:
--
--   stripe_account_id      — Connect account id (acct_*). All callers
--                            removed in S67. Never wrote a real value
--                            in production.
--   stripe_bank_verified   — derived flag from Connect onboarding state.
--                            Replaced by EXISTS-check against
--                            user_bank_accounts (status='active') in
--                            auth.ts /me, landlords list, admin metrics,
--                            admin onboarding detail (S67).
--
-- Both columns are safe to drop: zero non-null values in dev; production
-- never used Connect onboarding (the routes were always gated behind
-- attorney-review test mode).
--
-- No backfill needed.

ALTER TABLE landlords DROP COLUMN IF EXISTS stripe_account_id;
ALTER TABLE landlords DROP COLUMN IF EXISTS stripe_bank_verified;

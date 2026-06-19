-- S515 (D): GAM for Business — onboarding wizard completion flag.
--
-- A post-signup guided checklist (business info → features → Stripe →
-- tax → import customers) helps a new operator get to a usable state.
-- The individual steps are derived from real data (has an address, has a
-- Connect account, customer count, etc.) so we don't store per-step
-- booleans; we only need one column to know whether to keep surfacing
-- the wizard.
--
--   onboarding_completed_at — set when the owner finishes OR dismisses
--   the wizard. NULL = still show it.
--
-- SAFE — additive only, nullable, no backfill (existing businesses simply
-- see the wizard once; they can dismiss it).

ALTER TABLE public.businesses
  ADD COLUMN onboarding_completed_at timestamp with time zone;

COMMENT ON COLUMN public.businesses.onboarding_completed_at IS
  'S515 set when the owner finishes or dismisses the onboarding wizard. NULL = wizard still surfaces.';

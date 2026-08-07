-- S579: per-property onboarding window (the screening grandfather gate).
--
-- WHY: sitting tenants a landlord brings on during a property's initial
-- onboarding are grandfathered past the background check (they already live
-- there); everyone after the window — and every vacancy-fill even DURING it —
-- must screen. The gate has to be a system-enforced, time-boxed, PER-PROPERTY
-- window, NOT a landlord toggle (a soft-spot landlord must not be able to skip
-- screening for genuinely new applicants). This supersedes the per-landlord
-- `landlords.reconciliation_until` (S568) with a per-property window so a
-- landlord onboarding a 2nd property next year still gets a fresh window for
-- THAT property's sitting tenants only.
--
-- Window length = 14 days + 1 day per 10 units, capped at 30 (one billing
-- cycle — onboarding overlap = the landlord paying for two softwares, so we
-- never default past a cycle). Opened at property creation; closed early when
-- the landlord marks onboarding complete. Length is computed in app code
-- (services/onboardingWindow.ts) and stamped into onboarding_window_until.
--
-- BACKFILL: existing properties are already operating, NOT onboarding — close
-- their window immediately (completed_at = now) so no retroactive grandfather
-- is possible. Newly created properties get a fresh open window.

ALTER TABLE public.properties
  ADD COLUMN IF NOT EXISTS onboarding_started_at   timestamptz,
  ADD COLUMN IF NOT EXISTS onboarding_window_until timestamptz,
  ADD COLUMN IF NOT EXISTS onboarding_completed_at timestamptz;

-- Existing properties: window closed (already onboarded before this feature).
UPDATE public.properties
   SET onboarding_started_at   = COALESCE(onboarding_started_at, created_at),
       onboarding_completed_at = COALESCE(onboarding_completed_at, now())
 WHERE onboarding_completed_at IS NULL;

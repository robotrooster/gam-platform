-- S605 (Nic): shelve the SUBLEASE subsystem — stop capturing sublease data.
--
-- Nic's reasoning, and it's correct: the workflow only works if BOTH parties are
-- already on GAM. routes/subleases.ts states the constraint outright —
-- "Sublessee must already exist as a GAM tenant (looked up by email)" — so a
-- sublessor has to get their sublessee to sign up and onboard before a sublease
-- can even be recorded. "I know people that sublease in a variety of parks, they
-- will never be able to use this until all the landlords are on the same
-- software."
--
-- The landlord nav item and route were already hidden (LAUNCH_HIDDEN, S512), but
-- /api/subleases and /api/sublease-invitations stayed MOUNTED and would happily
-- accept writes. This closes that so no sublease data can be captured at all.
--
-- SHELVED, NOT DELETED — same posture as OTP. The tables, routes, services,
-- tests and the end-of-term cron all stay; they simply refuse to create anything
-- new. GAM never erases, and flipping this back on is one UPDATE if the
-- both-parties-on-platform problem ever stops being a problem.
--
-- Reads and terminations are deliberately NOT gated: if a sublease ever exists,
-- it must remain viewable and closeable. Only CREATION is blocked.
--
-- No backfill: zero subleases and zero invitations exist today.

INSERT INTO system_features (key, enabled, description)
VALUES (
  'subleasing_enabled',
  FALSE,
  'Sublease subsystem (tenant sublets their unit to another GAM tenant). SHELVED S605 — the flow requires the sublessee to already be a GAM tenant, so it cannot work until both sides are on the platform. OFF = creation refused; existing subleases stay readable and terminable. Backend intentionally left dormant, not deleted.'
)
ON CONFLICT (key) DO UPDATE
  SET enabled = FALSE,
      description = EXCLUDED.description;

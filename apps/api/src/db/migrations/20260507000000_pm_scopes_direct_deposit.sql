-- S168: per-manager direct-deposit opt-in toggle (locked design from
-- CLAUDE.md: "Managers get one [Connect account] only when their
-- landlord enables direct deposit (per-manager opt-in, default off).")
--
-- Why per-scope-row, not per-user: a property_manager user can be
-- scoped to multiple landlords. Each landlord independently decides
-- whether to pay that manager via Stripe Connect. A user-level toggle
-- would force a single answer across all employers.
--
-- Why default false: matches the locked spec. Pre-existing scope rows
-- get false on backfill; landlords explicitly opt managers in via the
-- TeamPage toggle. No backfill needed beyond the column default.
--
-- Consumed by:
--   - GET /api/scopes/team — surfaces the flag for TeamPage
--   - PATCH /api/scopes/property_manager/:userId/direct-deposit
--   - getScopeForUser() in routes/auth.ts — propagates onto JWT + /me
--   - Layout nav gate (frontend) — shows /banking to managers when true

ALTER TABLE property_manager_scopes
  ADD COLUMN direct_deposit_enabled boolean NOT NULL DEFAULT false;

-- Portfolio-manager attribution for landlords (S567).
--
-- WHY: GAM's sales agents are "portfolio managers" who earn RESIDUAL
-- commission for as long as their landlord keeps units on the platform, and
-- who own that landlord's customer service. On the admin portal a regular
-- 'admin' (= portfolio manager) must be scoped to ONLY the landlords they
-- closed; 'super_admin' sees the whole platform and routes incoming leads.
--
-- MODEL: whoever closes a landlord owns it — full stop. Because landlords
-- SELF-REGISTER (auth.ts is the only creation path), there is no in-app
-- "close" moment to stamp, so attribution is an explicit claim/assign:
--   * a new landlord starts NULL (unassigned lead)
--   * a portfolio manager CLAIMS an unassigned landlord → becomes its PM
--   * super_admin can ASSIGN / reassign any landlord to any PM
--
-- NO BACKFILL: every existing landlord stays NULL (unassigned). super_admin
-- sees all regardless; there are no real PM users yet.

ALTER TABLE landlords
  ADD COLUMN portfolio_manager_id uuid REFERENCES users(id);

COMMENT ON COLUMN landlords.portfolio_manager_id IS
  'The admin (portfolio manager) who owns this landlord relationship + its '
  'customer service + residual commission. NULL = unassigned lead. Regular '
  'admins are scoped to landlords where this = their user id; super_admin sees all.';

-- Scoping filter hits this on every regular-admin list/detail read.
CREATE INDEX landlords_portfolio_manager_id_idx
  ON landlords (portfolio_manager_id);

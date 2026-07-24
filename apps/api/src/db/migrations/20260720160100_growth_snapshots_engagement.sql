-- S550 (Nic): engagement history. users.last_login_at OVERWRITES on every
-- login, so "how many users were active in July" is unanswerable later
-- unless the rolling-window counts are captured daily. Filled ONLY on the
-- platform-wide totals row (state='*', city='*') — users don't map cleanly
-- to one geo (a landlord spans cities). NULL on geo rows.
-- No backfill possible (that's the point).

ALTER TABLE platform_growth_snapshots
  ADD COLUMN active_users_1d integer,
  ADD COLUMN active_users_7d integer,
  ADD COLUMN active_users_30d integer,
  ADD COLUMN active_tenant_users_30d integer,
  ADD COLUMN active_landlord_side_users_30d integer;

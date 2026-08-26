-- S624 — every landlord must have a migration window, including the ones who
-- signed up between the S623 backfill and the signup fix.
--
-- The S623 migrations set migration_window_ends_at for every landlord that
-- existed at the time. Nothing set it at SIGNUP, so the column stayed NULL for
-- everyone who joined afterwards — and the screening gate read a NULL as "the
-- onboarding window is still open", permanently. Those landlords would never
-- have had to background-check a single new tenant, in contradiction of the
-- published Business Terms §9.2 and Consumer Terms §7.1/§7.2.
--
-- Caught on a real organic signup fifteen minutes old (an RV park), which is the
-- only reason it surfaced before launch rather than after.
--
-- Recomputed from created_at, exactly as the earlier backfills did, so a
-- landlord's window is the same 28 days whether it was set at signup, backfilled
-- here, or derived by the gate. Same expression in all three places on purpose.

UPDATE landlords
   SET migration_window_ends_at = created_at + INTERVAL '28 days'
 WHERE migration_window_ends_at IS NULL;

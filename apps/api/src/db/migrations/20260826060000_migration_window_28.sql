-- S623: the onboarding migration window goes from 21 days to 28.
--
-- Nic: "we never know when people are actually gonna get around to finalizing
-- all their details and stuff. I know ours is probably taking the longest
-- because it's a complicated property, and we're still changing the system."
--
-- A window that expires mid-migration turns a landlord's own sitting tenants
-- into applicants who must be screened — the exact trap the window exists to
-- avoid. Erring long costs nothing: the rule it gates only ever applies to NEW
-- applicants, and a landlord who finishes early is unaffected.
UPDATE landlords
   SET migration_window_ends_at = created_at + INTERVAL '28 days'
 WHERE migration_window_ends_at IS NOT NULL;

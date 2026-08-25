-- S622: screening is required before a NEW lease can be sent.
--
-- Nic: "during the migration period, existing tenants are obviously living
-- there beforehand and after the onboarding window is closed, all applicants
-- must complete the background check to actually have the lease going."
--
-- Enabled by default — this is a platform rule stated in the Business Terms
-- (§9.2), not an opt-in feature. The flag exists so that turning it OFF is a
-- deliberate, recorded act rather than the code quietly skipping the check,
-- which is the same principle as naming excluded screening fees instead of
-- dropping them silently.

INSERT INTO system_features (key, enabled, description)
VALUES (
  'screening_required_for_new_leases',
  TRUE,
  'Require a completed background check for every tenant on a lease that begins on or after the landlord''s onboarding date, before the lease document can be sent for signature. Tenancies that began earlier (Migrated Tenants) are exempt. Business Terms §9.2.'
)
ON CONFLICT (key) DO NOTHING;

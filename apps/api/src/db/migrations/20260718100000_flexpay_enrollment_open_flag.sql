-- S544 (Nic): FlexPay pre-launch SURVEY MODE.
--
-- Until FlexPay actually launches, the tenant portal shows it as
-- "coming soon" with an INTEREST SURVEY — no one is promised
-- enrollment, no queue language, no reach-out commitments. The survey
-- writes the same flexpay_inquiries rows (income claim + benefit day
-- + note), so all demand data and the admin review queue keep
-- accumulating; only the tenant-facing framing and the enrollment
-- gate change.
--
-- Two-flag model:
--   flexpay_rollout_visible  — the product surface exists in the
--                              tenant portal at all (ON since S541).
--   flexpay_enrollment_open  — the product is LAUNCHED: approved
--                              tenants may actually enroll. OFF =
--                              survey mode. Flip ON at launch
--                              (Stripe live keys + bankroll ready).
--
-- enrollFlexPay refuses while this is OFF regardless of approval
-- status (server-enforced; UI is not the gate).

INSERT INTO system_features (key, enabled, description) VALUES (
  'flexpay_enrollment_open',
  FALSE,
  'FlexPay LAUNCHED: approved tenants may enroll. OFF = pre-launch survey mode (tenant portal shows "coming soon" + interest survey; inquiries/admin queue still collect). Flip ON at launch.'
) ON CONFLICT (key) DO NOTHING;

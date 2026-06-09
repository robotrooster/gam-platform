-- S245: FlexPay platform visibility flag.
--
-- Mirrors the otp_rollout_visible pattern. Defaults TRUE so the
-- product is visible in tenant portal for Nic's UI/UX assessment
-- (S245 product decision). At launch this flips to FALSE per
-- feature; admin re-enables when each product is cleared for go-live.

INSERT INTO system_features (key, enabled, description, updated_at)
VALUES (
  'flexpay_rollout_visible',
  TRUE,
  'When TRUE, FlexPay surfaces (tenant portal modal, enroll routes, crons) operate normally. When FALSE, all FlexPay endpoints short-circuit and the tenant UI hides the product entirely.',
  NOW()
)
ON CONFLICT (key) DO NOTHING;

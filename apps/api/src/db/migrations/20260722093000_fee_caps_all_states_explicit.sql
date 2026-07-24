-- S552 follow-up (Nic): make ALL 51 jurisdictions explicit in the cap
-- catalog — a row per state, even uncapped ones. WHY: an absent row can't be
-- distinguished from an unverified state; an explicit "no statutory cap,
-- verified <date>" row records the verification itself. Landlords can onboard
-- from any state without warning, so the catalog must show every state was
-- actually checked, not just the regulated ones.
--
-- Behavior-neutral for uncapped states: cap_amount NULL + fee_prohibited
-- FALSE + actual_cost_only FALSE resolves to "uncapped" exactly like no row.
--
-- Special notes: VA/DE have statutes that exist but never bind our
-- actual-cost pass-through model; IL/RI have portable-report rules (a
-- product feature, not a fee cap); TX requires fee disclosure.
--
-- No backfill needed. Annual refresh: re-verify all rows each Nov/Dec.

INSERT INTO state_application_fee_caps
  (state, effective_year, cap_amount, fee_prohibited, actual_cost_only, notes) VALUES
  ('AL', 2026, NULL, FALSE, FALSE, 'No statutory applicant screening-fee cap. Verified 2026-07.'),
  ('AK', 2026, NULL, FALSE, FALSE, 'No statutory applicant screening-fee cap. Verified 2026-07.'),
  ('AZ', 2026, NULL, FALSE, FALSE, 'No statutory applicant screening-fee cap. Verified 2026-07.'),
  ('AR', 2026, NULL, FALSE, FALSE, 'No statutory applicant screening-fee cap. Verified 2026-07.'),
  ('DE', 2026, NULL, FALSE, FALSE, '25 Del. C. §5514: app fee capped at greater($50, 10% monthly rent) — never binds our actual-cost pass-through (< $50). Verified 2026-07.'),
  ('FL', 2026, NULL, FALSE, FALSE, 'No statutory applicant screening-fee cap. Verified 2026-07.'),
  ('GA', 2026, NULL, FALSE, FALSE, 'No statutory applicant screening-fee cap. Verified 2026-07.'),
  ('HI', 2026, NULL, FALSE, FALSE, 'No statutory applicant screening-fee cap. Verified 2026-07.'),
  ('ID', 2026, NULL, FALSE, FALSE, 'No statutory applicant screening-fee cap. Verified 2026-07.'),
  ('IL', 2026, NULL, FALSE, FALSE, 'No statewide fee cap; landlord must waive fee if applicant provides valid reusable screening report (eff. 2025). Local ordinances (Chicago/Cook Co.) not encoded. Verified 2026-07.'),
  ('IN', 2026, NULL, FALSE, FALSE, 'No statutory applicant screening-fee cap. Verified 2026-07.'),
  ('IA', 2026, NULL, FALSE, FALSE, 'No statutory applicant screening-fee cap. Verified 2026-07.'),
  ('KS', 2026, NULL, FALSE, FALSE, 'No statutory applicant screening-fee cap. Verified 2026-07.'),
  ('KY', 2026, NULL, FALSE, FALSE, 'No statutory applicant screening-fee cap. Verified 2026-07.'),
  ('LA', 2026, NULL, FALSE, FALSE, 'No statutory applicant screening-fee cap. Verified 2026-07.'),
  ('MD', 2026, NULL, FALSE, FALSE, 'No statewide cap; local ordinances not encoded. Verified 2026-07.'),
  ('MI', 2026, NULL, FALSE, FALSE, 'No statutory applicant screening-fee cap. Verified 2026-07.'),
  ('MS', 2026, NULL, FALSE, FALSE, 'No statutory applicant screening-fee cap. Verified 2026-07.'),
  ('MO', 2026, NULL, FALSE, FALSE, 'No statutory applicant screening-fee cap. Verified 2026-07.'),
  ('MT', 2026, NULL, FALSE, FALSE, 'No statutory applicant screening-fee cap. Verified 2026-07.'),
  ('NE', 2026, NULL, FALSE, FALSE, 'No statutory applicant screening-fee cap. Verified 2026-07.'),
  ('NV', 2026, NULL, FALSE, FALSE, 'No statutory applicant screening-fee cap. Verified 2026-07.'),
  ('NH', 2026, NULL, FALSE, FALSE, 'No statutory applicant screening-fee cap. Verified 2026-07.'),
  ('NM', 2026, NULL, FALSE, FALSE, 'No statutory applicant screening-fee cap. Verified 2026-07.'),
  ('NC', 2026, NULL, FALSE, FALSE, 'No statutory applicant screening-fee cap. Verified 2026-07.'),
  ('ND', 2026, NULL, FALSE, FALSE, 'No statutory applicant screening-fee cap. Verified 2026-07.'),
  ('OH', 2026, NULL, FALSE, FALSE, 'No statutory applicant screening-fee cap. Verified 2026-07.'),
  ('OK', 2026, NULL, FALSE, FALSE, 'No statutory applicant screening-fee cap. Verified 2026-07.'),
  ('PA', 2026, NULL, FALSE, FALSE, 'No statewide cap; Philadelphia ordinance ($50/actual cost) not encoded — local compliance is the landlord''s. Verified 2026-07.'),
  ('RI', 2026, NULL, FALSE, FALSE, 'No fee cap; written disclosure + portable-report rules apply. Verified 2026-07.'),
  ('SC', 2026, NULL, FALSE, FALSE, 'No statutory applicant screening-fee cap. Verified 2026-07.'),
  ('SD', 2026, NULL, FALSE, FALSE, 'No statutory applicant screening-fee cap. Verified 2026-07.'),
  ('TN', 2026, NULL, FALSE, FALSE, 'No statutory applicant screening-fee cap. Verified 2026-07.'),
  ('TX', 2026, NULL, FALSE, FALSE, 'No cap; fee disclosure to applicant required (Tex. Prop. Code §92.3515). Verified 2026-07.'),
  ('UT', 2026, NULL, FALSE, FALSE, 'No statutory applicant screening-fee cap. Verified 2026-07.'),
  ('VA', 2026, NULL, FALSE, FALSE, 'Va. Code §55.1-1203: $50 app-fee cap EXCLUDES actual out-of-pocket third-party screening cost — our pass-through is exempt. Verified 2026-07.'),
  ('WV', 2026, NULL, FALSE, FALSE, 'No statutory applicant screening-fee cap. Verified 2026-07.'),
  ('WY', 2026, NULL, FALSE, FALSE, 'No statutory applicant screening-fee cap. Verified 2026-07.');

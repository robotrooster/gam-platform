-- S552: seed the state application-fee cap catalog (50-state research pass,
-- verified 2026-07-22 against multiple sources; statutes cited per row).
--
-- Adds actual_cost_only: states where the applicant may be charged no more
-- than the ACTUAL COST of screening. The resolver treats it as a dynamic cap
-- equal to the screening package cost (BACKGROUND_CHECK_APPLICANT_FEE_USD) —
-- i.e. no card-processing add-on and no margin of any kind on the applicant
-- side in those states. Combined with cap_amount, the effective applicant
-- maximum is min(cap_amount, package cost when actual_cost_only).
--
-- Model (Nic, S551/S552): applicant pays min(standard all-in total, cap);
-- the landlord is billed the remainder + the $5 screening-compliance fee via
-- the platform-fee invoice (screening_fee_accruals, next migration).
--
-- States NOT seeded = no applicant-side statutory cap found (verified in the
-- two 50-state roundups). Notable non-rows, on purpose:
--   VA — $50 app-fee cap EXCLUDES actual third-party screening cost passed
--        through, which is exactly what we charge → not binding (§55.1-1203).
--   DE — cap = greater(10% monthly rent, $50) ≥ $50 > our fee → never binds.
--   IL/RI/CO portable-report acceptance rules are a separate feature, not a
--        fee cap (CO also appears below for its actual-cost rule).
-- Local ordinances (Bangor ME, Chicago, Berkeley…) are intentionally NOT
-- encoded — state-level only; local compliance stays with the landlord.
--
-- ANNUAL REFRESH (S177 discipline): CA + DC are CPI/COLA-indexed; NJ was new
-- May 2026; CT's $50 is Commissioner-adjustable. Re-verify each Nov/Dec and
-- seed next year's rows with effective_year=2027. Never UPDATE these rows.

ALTER TABLE state_application_fee_caps
  ADD COLUMN actual_cost_only boolean NOT NULL DEFAULT FALSE;

INSERT INTO state_application_fee_caps
  (state, effective_year, cap_amount, fee_prohibited, actual_cost_only, notes) VALUES
  ('CA', 2026, 65.86, FALSE, TRUE,  'Civil Code §1950.6 — lesser of indexed cap ($65.86 for 2026, CPI-adjusted annually) or actual out-of-pocket cost; itemized receipt + refund of unused portion required'),
  ('CO', 2026, NULL,  FALSE, TRUE,  'C.R.S. §38-12-903 (HB19-1106) — fee must reflect actual screening cost; must accept portable tenant screening report in lieu'),
  ('CT', 2026, 50.00, FALSE, TRUE,  'P.A. 23-207 / SB 998 (eff. 2023-10-01) — application processing fees banned; only actual screening-report cost chargeable, capped $50 (Commissioner COLA-adjustable)'),
  ('DC', 2026, 54.00, FALSE, FALSE, 'DC Rental Housing Commission indexed cap — $54 for 2026'),
  ('MA', 2026, NULL,  TRUE,  FALSE, 'M.G.L. c.186 §15B — landlords may not charge application/screening fees to prospective tenants (licensed brokers regulated separately)'),
  ('ME', 2026, 75.00, FALSE, TRUE,  '14 M.R.S. §6030-H (2023) — lesser of $75 or actual screening cost, per adult; fee valid 12 months with same landlord; report copy required'),
  ('MN', 2026, NULL,  FALSE, TRUE,  'Minn. Stat. §504B.173 — applicant screening fee limited to actual cost; refund required if no screening performed'),
  ('NJ', 2026, 50.00, FALSE, FALSE, 'P.L. 2026 (eff. 2026-05-01) — application-related fees capped at $50 total'),
  ('NY', 2026, 20.00, FALSE, TRUE,  'RPL §238-a (HSTPA 2019) — lesser of $20 or actual cost of background/credit check; waived if applicant provides recent (30-day) report'),
  ('OR', 2026, NULL,  FALSE, TRUE,  'ORS 90.295 — screening charge may not exceed average actual cost / customary CRA amount for comparable screening; refund if not screened'),
  ('VT', 2026, NULL,  TRUE,  FALSE, '9 V.S.A. §4456a — application fees to prospective tenants prohibited outright'),
  ('WA', 2026, NULL,  FALSE, TRUE,  'RCW 59.18.257 — only actual cost of screening chargeable; criteria + CRA disclosure required'),
  ('WI', 2026, 25.00, FALSE, TRUE,  'Wis. Stat. §704.085 / ATCP 134.05 — actual cost up to $25 for the consumer credit report; must reuse applicant-provided report <30 days old');

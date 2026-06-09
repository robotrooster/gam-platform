-- Arizona — provisions for the remaining acts (completes AZ before other
-- states, per Nic). Continues the S442 KB; see the two prior AZ migrations.
--
-- SOURCED from azleg.gov 2026-06-09, verified against statute text:
--   RV Long-Term Rental Space Act (Ch 19, § 33-2105): tenant 30-day notice
--     before non-renewal; late fee capped at $5/day, chargeable only if rent
--     unpaid by the 6th day after due date. (The RV deposit cap lives in a
--     different section that was NOT confirmed here — deliberately NOT seeded
--     rather than guessed.)
--   Mobile Home Parks Act (Ch 11, § 33-1431): security deposit max TWO
--     months' rent (note: HIGHER than the residential act's 1.5-month cap in
--     § 33-1321 — a real per-act difference, which is exactly why act values
--     are sourced separately, never copied), returned within 14 days
--     excluding weekends/holidays.
--   General Landlord and Tenant (Ch 3, commercial/storage): general law does
--     NOT impose residential-style deposit or entry caps, so it correctly
--     gets ZERO warnable provisions. The act stays catalogued so
--     "what law applies?" still answers for commercial/storage units; the
--     engine returns null on uncatalogued topics (no false alarms).
--
-- 'info' rule_kind = surfaced in get_applicable_laws but drives no automatic
-- numeric warning (e.g. the RV per-day $ late-fee cap doesn't map to a simple
-- min/max comparison).
--
-- Refresh discipline: never UPDATE — future quarters insert new effective_year
-- rows. No backfill needed (additive provision rows only).

INSERT INTO public.state_law_provisions
  (act_id, state_code, topic, rule_kind, threshold_numeric, threshold_unit, summary, statute_citation, source_url, source_date, effective_year, notes)
SELECT a.id, 'AZ', v.topic, v.rule_kind, v.threshold_numeric, v.threshold_unit, v.summary, v.citation, v.url, DATE '2026-06-09', 2026, v.notes
FROM (VALUES
  ('rv_long_term', 'notice_to_vacate_days', 'min', 30::numeric, 'days',
   'A tenant must give at least 30 days'' notice before the rental agreement expires if they are not renewing and are vacating the space.',
   'A.R.S. § 33-2105', 'https://www.azleg.gov/ars/33/02105.htm', NULL),
  ('rv_long_term', 'late_fee', 'info', 5::numeric, 'dollars per day',
   'A late fee may not exceed $5 per day, and may be charged only if the rent is not paid by the sixth day after the due date.',
   'A.R.S. § 33-2105', 'https://www.azleg.gov/ars/33/02105.htm', NULL),
  ('mobile_home_park', 'deposit_max_months', 'max', 2::numeric, 'months of rent',
   'A security deposit may not exceed two months'' rent.',
   'A.R.S. § 33-1431', 'https://www.azleg.gov/ars/33/01431.htm',
   'Higher than the residential act''s 1.5-month cap (§ 33-1321) — do not assume residential limits apply to a mobile home park.'),
  ('mobile_home_park', 'deposit_return_days', 'max', 14::numeric, 'business days',
   'The deposit (with an itemized list of any deductions) must be returned within 14 days, excluding weekends and legal holidays, after termination and the tenant''s demand; wrongful withholding can expose the landlord to up to double the amount.',
   'A.R.S. § 33-1431', 'https://www.azleg.gov/ars/33/01431.htm', NULL)
) AS v(act_key, topic, rule_kind, threshold_numeric, threshold_unit, summary, citation, url, notes)
JOIN public.state_landlord_tenant_acts a
  ON a.state_code = 'AZ' AND a.act_key = v.act_key AND a.effective_year = 2026;

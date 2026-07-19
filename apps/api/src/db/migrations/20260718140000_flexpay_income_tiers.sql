-- S545 (Nic): non-SSI/SSDI interest = TIER 2 of the SAME queue.
--
-- "They are still going to be customers, just lower priority than
-- SSI/SSDI." So instead of a passive interest roster, other-income
-- interest files real flexpay_inquiries rows that:
--   - sort BEHIND every SSI/SSDI request (tier precedence, then
--     float-need, then FIFO),
--   - cannot be APPROVED until the expansion flag flips
--     (flexpay_other_income_open, default OFF) — mirrors the
--     state-hold pattern: row keeps its place, approval 422s.
--
-- claimed_income_source widens to the questionnaire's vocabulary.
-- Backfill: existing answered+interested+non-eligible questionnaires
-- become tier-2 inquiries (benefit day carried over) so no interest
-- recorded to date is lost.

ALTER TABLE flexpay_inquiries
  DROP CONSTRAINT flexpay_inquiries_claimed_income_source_check;
ALTER TABLE flexpay_inquiries
  ADD CONSTRAINT flexpay_inquiries_claimed_income_source_check
  CHECK (claimed_income_source IN ('ssi', 'ssdi', 'other_fixed', 'none'));

INSERT INTO system_features (key, enabled, description) VALUES (
  'flexpay_other_income_open',
  FALSE,
  'FlexPay income-type expansion: when TRUE, non-SSI/SSDI (tier 2) requests may be approved. OFF = tier-2 rows wait in the queue behind SSI/SSDI with an income hold.'
) ON CONFLICT (key) DO NOTHING;

INSERT INTO flexpay_inquiries (tenant_id, claimed_income_source, desired_pull_day, tenant_note, created_at)
SELECT tq.tenant_id,
       COALESCE(tq.answers->>'incomeSource', 'none'),
       NULLIF(tq.answers->>'benefitDay', '')::int,
       'Via ' || tq.trigger_type || ' questionnaire (tier-2 backfill)',
       tq.answered_at
  FROM tenant_questionnaires tq
 WHERE tq.status = 'answered'
   AND (tq.answers->>'interested') = 'true'
   AND COALESCE(tq.answers->>'incomeSource', '') NOT IN ('ssi', 'ssdi')
ON CONFLICT (tenant_id) DO NOTHING;

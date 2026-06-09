-- Reclassify the AZ RV-act late-fee provision from 'info' to 'max'.
--
-- WHY: the RV Long-Term Rental Space Act (§ 33-2105) caps the late fee at
-- $5/day — a real MAXIMUM, not just informational. Reclassifying it lets the
-- check_against_law tool flag a late fee ABOVE $5/day as an objective factual
-- mismatch (Nic S442: obvious numeric mismatches like late-fee amounts may be
-- flagged factually — it isn't legal advice). Same-day correction of a
-- mis-classified seed row; the $5/day value, unit, citation and source are
-- unchanged — only rule_kind flips info → max.
--
-- SAFE: single-row data correction, no schema change.

UPDATE public.state_law_provisions
   SET rule_kind = 'max'
 WHERE state_code = 'AZ'
   AND topic = 'late_fee'
   AND rule_kind = 'info'
   AND statute_citation = 'A.R.S. § 33-2105';

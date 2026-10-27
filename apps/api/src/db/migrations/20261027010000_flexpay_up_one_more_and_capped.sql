-- FlexPay up one more tier, with a bounded $2,500-2,999 top and nothing above
-- $3,000.  (10/26, Nic — the grid he settled on.)
--
--   "Under $1,000, 18, 26, and 34. Yes, do that. Don't revert to the 13, 19,
--    and 25. Our fee is cheaper than any late fees on the platform so far. By
--    a long shot. In fact, we could almost tier it up one more time. Under
--    $1,000 would be 23, 33, and 43. Let's do that. Tier it up one more. And
--    then add a new price line for $2,500 to $2,999."
--
-- So the floor is 23/33/43 and the top is a NEW 43/61/79, bounded. The column
-- steps stay what they have been all evening: $5 / $7 / $9.
--
--   rent bracket      2nd Wed   3rd Wed   4th Wed
--   under $1,000         23        33        43
--   $1,000-1,499         28        40        52
--   $1,500-1,999         33        47        61
--   $2,000-2,499         38        54        70
--   $2,500-2,999         43        61        79
--   $3,000 and up      NOT OFFERED
--
-- HIS JUSTIFICATION IS THE COMPARATOR, AND IT HOLDS.  The two late-fee
-- policies that exist today are $5.00/day retroactive to the due date with NO
-- CAP, and a flat $50. A resident paying on the 4th benefit Wednesday owes
-- $110-$140 under the daily one. $43-$79 is still well under that at every
-- rent. Note the late fee is NOT an input to this grid and must never become
-- one -- it is per landlord, per property, per unit type, per lease -- it is
-- only the sanity check on whether a price is defensible.
--
-- THE CLIFF AT EACH BOUNDARY IS KNOWN AND ACCEPTED FOR NOW.  A $1 change in
-- the bill at a bracket line still moves the fee $5-$9, and utilities billed
-- back make residents cross those lines. A continuous per-$100 formula would
-- remove it, and Nic rejected that on good grounds: "that makes it look like
-- an origination charge... that starts to get us into lending territory,
-- doesn't it?" A flat price per tier reads as a subscription tier; a charge
-- that scales with the amount advanced reads as a finance charge. The cliff is
-- the price of keeping the product's shape, and it stays open.
--
-- Same supersede-in-place as the three before it: these rows are a same-day
-- draft, nothing reads them for live pricing YET (calculateFlexPayFee still
-- returns the flat $25 -- wiring that is the next step, and it needs the
-- subscription terms and the consumer ToS rewritten off the flat $25 at the
-- same time), and no enrollment has ever been priced from them. The DELETE is
-- pinned to the exact note the previous draft carries. Once a price has been
-- quoted to anybody, re-pricing APPENDS.
--
-- FlexDeposit is untouched; its 74/99/124/148/173 top stands as approved.
-- No backfill needed. Re-runnable.

DELETE FROM flexpay_fee_schedule
 WHERE effective_from = DATE '2026-10-26'
   AND note = '10/26 (Nic) — the approved FlexPay grid; the second shift was my misread of "rent"';

INSERT INTO flexpay_fee_schedule (rent_min, rent_max, benefit_wednesday, fee, effective_from, note)
SELECT v.rent_min, v.rent_max, w.wed,
       CASE w.wed WHEN 2 THEN 23 + 5 * v.n WHEN 3 THEN 33 + 7 * v.n ELSE 43 + 9 * v.n END,
       DATE '2026-10-26',
       '10/26 final (Nic) — up one more; floor 23/33/43, capped top 43/61/79, none over $3,000'
  FROM (VALUES (0, 0.00::numeric, 1000.00::numeric), (1, 1000.00, 1500.00), (2, 1500.00, 2000.00),
               (3, 2000.00, 2500.00), (4, 2500.00, 3000.00)
       ) AS v(n, rent_min, rent_max)
 CROSS JOIN (VALUES (2), (3), (4)) AS w(wed)
 WHERE NOT EXISTS (
         SELECT 1 FROM flexpay_fee_schedule f
          WHERE f.rent_min = v.rent_min AND f.benefit_wednesday = w.wed
            AND f.effective_from = DATE '2026-10-26');

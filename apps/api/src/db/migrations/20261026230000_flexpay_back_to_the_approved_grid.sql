-- FlexPay returns to the grid Nic actually approved. FlexDeposit keeps its
-- shift.  (10/26, Nic, correcting my misreading.)
--
-- WHAT HAPPENED.  His instruction read "the 2,500 and up RENT, $2,500 to
-- $3,000 needs another tier below it... so 147 on 6 payments would be for
-- $2,000 to $2,499."  Payment counts exist only on FlexDeposit and rent
-- brackets only on FlexPay, so the sentence carried one product's number and
-- the other's unit.  I shifted BOTH.  He has since said which he meant:
--
--   "Sorry, I said rent, but usually security deposits are 1 month rent or
--    month and a half. That was my mistake to use when I said that the $2,500
--    and up DEPOSIT was the next tier... We already shifted FlexPay once,
--    right? It was 13, 19, 25 for the under 1,000. Yeah, that's fine."
--
-- So the deposit grid stands as shifted (74/99/124/148/173 on top, confirmed:
-- "Yes, I like that"), and FlexPay goes back to the grid from the FIRST shift,
-- which is the one he signed off on.
--
--   FLEXPAY                2nd Wed  3rd Wed  4th Wed
--   under $1,000              13       19       25
--   $1,000-1,499              18       26       34     (his original anchor)
--   $1,500-1,999              23       33       43
--   $2,000-2,499              28       40       52
--   $2,500 and up             33       47       61
--
-- THE TOP BRACKET IS OPEN AGAIN, AND THAT IS A QUESTION PUT TO HIM, NOT A
-- DECISION TAKEN HERE.  The $3,000 ceiling he set belongs to the deposit
-- conversation, so FlexPay's top returns to open-ended as approved.  That
-- means a $6,000 rent would front for $61 on the 4th Wednesday — unbounded
-- float at a fixed price, which is the opposite of "we have to get paid for
-- the service we provide" (10/26).  Flagged in the same breath as this
-- migration; whichever way he answers is one more row or one more max.
--
-- Same supersede-in-place as the two before it, and for the same reason:
-- these rows are a same-day draft, nothing reads them for live pricing
-- (calculateFlexPayFee still returns the flat $25), and no enrollment has ever
-- been priced from them.  The DELETE is pinned to the exact note the previous
-- draft carries.  Once a price has been quoted to anybody, re-pricing APPENDS.
--
-- FlexDeposit is deliberately untouched.
-- No backfill needed.  Re-runnable: the DELETE no-ops once the draft is gone
-- and the INSERT is guarded by NOT EXISTS.

DELETE FROM flexpay_fee_schedule
 WHERE effective_from = DATE '2026-10-26'
   AND note = '10/26 re-price 2 (Nic) — shifted up one again, capped $2,500-2,999, nothing over $3,000';

INSERT INTO flexpay_fee_schedule (rent_min, rent_max, benefit_wednesday, fee, effective_from, note)
SELECT v.rent_min, v.rent_max, w.wed,
       CASE w.wed WHEN 2 THEN 13 + 5 * v.n WHEN 3 THEN 19 + 7 * v.n ELSE 25 + 9 * v.n END,
       DATE '2026-10-26',
       '10/26 (Nic) — the approved FlexPay grid; the second shift was my misread of "rent"'
  FROM (VALUES (0, 0.00::numeric, 1000.00::numeric), (1, 1000.00, 1500.00), (2, 1500.00, 2000.00),
               (3, 2000.00, 2500.00), (4, 2500.00, NULL::numeric)
       ) AS v(n, rent_min, rent_max)
 CROSS JOIN (VALUES (2), (3), (4)) AS w(wed)
 WHERE NOT EXISTS (
         SELECT 1 FROM flexpay_fee_schedule f
          WHERE f.rent_min = v.rent_min AND f.benefit_wednesday = w.wed
            AND f.effective_from = DATE '2026-10-26');

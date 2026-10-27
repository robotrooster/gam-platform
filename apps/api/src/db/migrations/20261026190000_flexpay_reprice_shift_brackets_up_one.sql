-- FlexPay re-price: every bracket takes the next one's old price, and a new
-- top tier is added.  (10/26, Nic, reviewing the same-day seed.)
--
-- WHY.  The 10/26 seed anchored his $18/$26/$34 on the MIDDLE bracket and
-- stepped evenly out from there, which put $8/$12/$16 on rent under $1,000.
-- He rejected that row on two grounds:
--
--   "We are fronting the money for a long time, kind of, and the late fee
--    that a landlord would charge is a lot more... That only steps up by $4.
--    That's not really reasonable."
--
-- Both are properties of the grid itself, not of any one landlord.  GAM's money
-- is out from the bill's grace end to the resident's benefit Wednesday -- up to
-- three weeks -- on every enrollment regardless of whose property it is, and an
-- $8 floor did not cover a month of that.  The $4 step was also flatter than
-- every other column step in the grid ($5 / $7 / $9), so the cheapest bracket
-- was priced on a different curve than the other four for no reason.
--
-- The late fee is NOT an input to this grid, and must never become one.  Late
-- fees are per-landlord, resolved per bill from the lease override, then
-- property_unit_type_late_fees, then the property (services/lateFeePolicy.ts) --
-- a flat $25, a percentage of rent, $5/day with no cap, or none at all, each
-- with its own grace and cap.  One national price schedule cannot be derived
-- from settings that differ per landlord, per property, per unit type and per
-- lease.  Where the late fee DOES belong is the resident's own savings estimate
-- at enrollment, computed from THEIR lease's resolved policy -- including the
-- honest case where their landlord's late fee is small enough that FlexPay
-- costs them more, which they are still allowed to sign up for.
--
-- So each bracket moves UP to the price the next bracket held, the $8/$12/$16
-- row is dropped, and the top bracket gets a new row one step above the old
-- top:  $28+5 / $40+7 / $52+9  =  $33 / $47 / $61.
--
--   rent bracket      2nd Wed   3rd Wed   4th Wed
--   under $1,000         13        19        25     (was 8 / 12 / 16)
--   $1,000-1,499         18        26        34     (was 13 / 19 / 25)
--   $1,500-1,999         23        33        43     (was 18 / 26 / 34)
--   $2,000-2,499         28        40        52     (was 23 / 33 / 43)
--   $2,500 and up        33        47        61     (new top step)
--
-- Note his $18/$26/$34 anchor now sits on $1,000-1,499 rather than in the
-- middle of the grid.  That is the deliberate consequence of the shift, not a
-- drift: he re-anchored on purpose to raise the floor.
--
-- WHY THIS REPLACES THE SEED ROWS INSTEAD OF APPENDING A LATER effective_from.
-- The standing rule is that a re-price APPENDS a row and never updates one, so
-- a price already quoted or charged keeps answering for the dates it covered.
-- That rule protects history.  There is no history here: these 15 rows were
-- seeded earlier the SAME DAY as a draft for Nic to review, nothing reads them
-- for live pricing yet (calculateFlexPayFee still returns the flat $25), and no
-- enrollment has ever been priced from them.  Appending at 2026-10-27 would
-- instead leave a grid he has already rejected standing as "in effect" for a
-- day, in a table a human reads in the portal.  So the draft is superseded in
-- place.  The DELETE is pinned to the seed's exact note string and date, so it
-- can never reach a row written by a real re-price.
--
-- The NEXT re-price appends.  This is the one and only in-place correction.
--
-- No backfill needed: nothing references flexpay_fee_schedule rows by id.
-- Re-runnable: the DELETE is a no-op once the seed is gone, and the INSERT is
-- guarded by NOT EXISTS on (rent_min, benefit_wednesday, effective_from).

DELETE FROM flexpay_fee_schedule
 WHERE effective_from = DATE '2026-10-26'
   AND note = 'seed 10/26 — middle bracket anchored at Nic''s $18/$26/$34';

INSERT INTO flexpay_fee_schedule (rent_min, rent_max, benefit_wednesday, fee, effective_from, note)
SELECT v.rent_min, v.rent_max, v.wed, v.fee, DATE '2026-10-26',
       '10/26 re-price (Nic) — brackets shifted up one, new $33/$47/$61 top tier'
  FROM (VALUES
          (   0.00::numeric, 1000.00::numeric, 2, 13.00::numeric),
          (   0.00,          1000.00,          3, 19.00),
          (   0.00,          1000.00,          4, 25.00),
          (1000.00,          1500.00,          2, 18.00),
          (1000.00,          1500.00,          3, 26.00),
          (1000.00,          1500.00,          4, 34.00),
          (1500.00,          2000.00,          2, 23.00),
          (1500.00,          2000.00,          3, 33.00),
          (1500.00,          2000.00,          4, 43.00),
          (2000.00,          2500.00,          2, 28.00),
          (2000.00,          2500.00,          3, 40.00),
          (2000.00,          2500.00,          4, 52.00),
          (2500.00,          NULL,             2, 33.00),
          (2500.00,          NULL,             3, 47.00),
          (2500.00,          NULL,             4, 61.00)
       ) AS v(rent_min, rent_max, wed, fee)
 WHERE NOT EXISTS (
         SELECT 1 FROM flexpay_fee_schedule f
          WHERE f.rent_min = v.rent_min
            AND f.benefit_wednesday = v.wed
            AND f.effective_from = DATE '2026-10-26');

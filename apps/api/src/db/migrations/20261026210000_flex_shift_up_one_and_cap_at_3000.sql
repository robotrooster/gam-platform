-- Both Flex grids shift up one bracket, gain a capped $2,500-2,999 top tier,
-- and stop at $3,000.  (10/26, Nic, second review of the same-day draft.)
--
-- WHAT HE SAID.
--
--   "I think the same thing with these tiers. We need the ones that are for the
--    under $1,000 amount, we need to bump that up by one, shift everything up
--    one. And the 2,500 and up rent, $2,500 to $3,000 needs another tier below
--    it. And we are not offering coverage on over $3,000. So 147 on 6 payments
--    would be for $2,000 to $2,499."
--
-- The $147 reference pins it: $147 is the FlexDeposit 6-payment price that was
-- on the open-topped $2,500+ bracket, and he wants it on $2,000-2,499 -- i.e.
-- every bracket takes the price of the bracket above it, the old top price
-- moves down a row, and a new top row is added one step further up.  Same
-- operation as this morning's FlexPay shift, now applied again and to both.
--
-- AMBIGUITY, FLAGGED TO HIM: he said "the 2,500 and up RENT" (FlexPay) and
-- "$147 on 6 payments" (FlexDeposit) in the same breath.  FlexDeposit is
-- certain.  FlexPay is read as included, because "the same thing with these
-- tiers" is the operative instruction, he named rent explicitly, and a
-- $3,000 ceiling on rent is harmless for a product whose market is SSI/SSDI
-- recipients.  If he only meant FlexDeposit, the next migration puts FlexPay
-- back -- nothing is charging off either grid yet.
--
--   FLEXPAY                2nd Wed  3rd Wed  4th Wed
--   under $1,000              18       26       34     (was 13 / 19 / 25)
--   $1,000-1,499              23       33       43     (was 18 / 26 / 34)
--   $1,500-1,999              28       40       52     (was 23 / 33 / 43)
--   $2,000-2,499              33       47       61     (was 28 / 40 / 52)
--   $2,500-2,999              38       54       70     (new, and now CAPPED)
--   $3,000 and up          not offered
--
--   FLEXDEPOSIT             2 pmts  3  4  5  6
--   under $1,000              29  38  48   57   67    (was 17/23/29/34/40)
--   $1,000-1,499              40  53  67   80   93    (was 29/38/48/57/67)
--   $1,500-1,999              51  69  86  103  120    (was 40/53/67/80/93)
--   $2,000-2,499              63  84 105  126  147    (was 51/69/86/103/120)
--   $2,500-2,999              74  99 124  148  173    (new, and now CAPPED)
--   $3,000 and up          not offered
--
-- HOW THE $3,000 CEILING IS ENFORCED.  By the ABSENCE of a row, not by a flag.
-- Brackets are half-open [min, max), so a $3,200 rent matches nothing and
-- quoteFlexPayFee returns null -- which services/flexFees.ts already treats as
-- an error and never as a zero.  "Not offered" therefore cannot degrade into
-- "free", which is the way this would otherwise go wrong.
--
-- SHARE OF RENT, for the record.  The shift steepens the asymmetry Nic already
-- accepted on 10/26 ("I think that's honestly better to have it flopped ...
-- they need to be subsidizing their own fellow low-income people").  On the
-- 4th benefit Wednesday the cheapest bracket now pays 3.40% of rent against
-- 2.33% at the dearest -- a 1.07pt spread, up from 0.47pt.  Asserted out loud
-- in services/flexFees.test.ts rather than left to be discovered.
--
-- WHY THIS REPLACES ROWS AGAIN INSTEAD OF APPENDING.  Same reason as
-- 20261026190000: these rows were seeded and re-priced earlier the SAME DAY as
-- a draft for his review, nothing reads them for live pricing yet
-- (calculateFlexPayFee still returns the flat $25, FLEX_DEPOSIT_CUSTODY_FEE is
-- still $3/month), and no enrollment has ever been priced from them.  The
-- DELETEs are pinned to the exact note strings those drafts carry, so they can
-- never reach a row written by a real re-price.  Once a price has been quoted
-- to anybody, re-pricing APPENDS -- that rule is unchanged.
--
-- No backfill needed: nothing references these rows by id.
-- Re-runnable: the DELETEs are no-ops once the drafts are gone, and both
-- INSERTs are guarded by NOT EXISTS on (min, key, effective_from).

DELETE FROM flexpay_fee_schedule
 WHERE effective_from = DATE '2026-10-26'
   AND note = '10/26 re-price (Nic) — brackets shifted up one, new $33/$47/$61 top tier';

DELETE FROM flexdeposit_fee_schedule
 WHERE effective_from = DATE '2026-10-26'
   AND note = 'seed 10/26 — top bracket lands $147 at six; Nic recalled ~$160 at its $3,000 ceiling';

INSERT INTO flexpay_fee_schedule (rent_min, rent_max, benefit_wednesday, fee, effective_from, note)
SELECT v.rent_min, v.rent_max, w.wed,
       CASE w.wed WHEN 2 THEN 18 + 5 * v.n WHEN 3 THEN 26 + 7 * v.n ELSE 34 + 9 * v.n END,
       DATE '2026-10-26',
       '10/26 re-price 2 (Nic) — shifted up one again, capped $2,500-2,999, nothing over $3,000'
  FROM (VALUES (0, 0.00::numeric, 1000.00::numeric), (1, 1000.00, 1500.00), (2, 1500.00, 2000.00),
               (3, 2000.00, 2500.00), (4, 2500.00, 3000.00)
       ) AS v(n, rent_min, rent_max)
 CROSS JOIN (VALUES (2), (3), (4)) AS w(wed)
 WHERE NOT EXISTS (
         SELECT 1 FROM flexpay_fee_schedule f
          WHERE f.rent_min = v.rent_min AND f.benefit_wednesday = w.wed
            AND f.effective_from = DATE '2026-10-26');

INSERT INTO flexdeposit_fee_schedule (deposit_min, deposit_max, payments, fee, effective_from, note)
SELECT v.deposit_min, v.deposit_max, p.n,
       -- Each bracket priced at the NEXT midpoint up: that is what "shift
       -- everything up one" is, in the seed's own formula.
       ROUND(v.next_mid * 0.01523 * (p.n + 1) / 2.0),
       DATE '2026-10-26',
       '10/26 re-price (Nic) — shifted up one, capped $2,500-2,999, nothing over $3,000'
  FROM (VALUES (   0.00::numeric, 1000.00::numeric, 1250.00::numeric),
               (1000.00,          1500.00,          1750.00),
               (1500.00,          2000.00,          2250.00),
               (2000.00,          2500.00,          2750.00),
               (2500.00,          3000.00,          3250.00)
       ) AS v(deposit_min, deposit_max, next_mid)
 CROSS JOIN (VALUES (2), (3), (4), (5), (6)) AS p(n)
 WHERE NOT EXISTS (
         SELECT 1 FROM flexdeposit_fee_schedule f
          WHERE f.deposit_min = v.deposit_min AND f.payments = p.n
            AND f.effective_from = DATE '2026-10-26');

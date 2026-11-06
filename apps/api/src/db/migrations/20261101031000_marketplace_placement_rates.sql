-- WHAT THE TOP SPOT COSTS — the monthly rate schedule.
--
-- 10/31 (Nic), in three passes over one evening. First: "Paid spot per trade
-- per area code should be based on cost of living in the area. LA/NY prices
-- don't touch Wyoming or Oklahoma. Let's figure a base formula and a monthly
-- rate schedule." Then, on the first draft: "Pricing should be 30 bucks in the
-- least expensive areas. Scale the rest down. Should be about 100 in NY/LA."
-- Then: "Make it cheaper in the cheap area so the curve lands at 100-120."
--
-- So his anchors ARE the formula, and the formula is solved from them rather
-- than the numbers being typed in by hand:
--
--     monthly = round to the nearest $5 of   $55 x (index / 100) ^ 6
--
--   $55   what a spot costs where the cost of living is the US average
--   ^ 6   how steeply the price climbs across the country
--
-- At the bottom band's middle that is $19.31 and at the top's $120.73. The
-- cheapest places in the country are $20 and the two cities he named — New York
-- at 112.6 and Los Angeles at 113.6 — are both $120, with the band under them
-- at $105. A sixfold spread, bottom to top.
--
-- WHAT THE EXPONENT IS ACTUALLY DOING, said plainly rather than dressed up as
-- arithmetic: at the sixth power this is no longer a price proportional to the
-- cost of living. Cost of living ORDERS the areas — that part is published fact
-- — and the exponent sets how steeply the price climbs across that order. The
-- published index only runs 83.6 to 115.6, a 1.38x gap, because the price of
-- GOODS is nearly national and only housing and labour really move; a price
-- proportional to it would put Los Angeles at $75 against Tulsa's $43, which is
-- not what "don't touch" means. The sixth power turns 1.38x into 6x, which puts
-- most of the revenue on the expensive metros, where the jobs are bigger and
-- the competition for the one top spot is fiercer. That is a deliberate choice
-- and the reason it is written as one number here rather than buried.
--
-- The nine bands below are that formula read at each band's middle, which is
-- why they are round money rather than $87.28. A BAND and not a continuous
-- curve, for the reason FlexPay's grid is banded: a flat monthly price per tier
-- reads as what it is, an advertising spot, where a figure computed per dollar
-- starts reading as a commission on work that has not happened.
--
-- WHAT A SPOT IS WORTH, so the price can be argued with. A park job in an
-- average-cost area runs $1,500-$4,000; at a third of that in margin, ONE extra
-- job a month is $500-$1,300 to the contractor. $55 is a twentieth of that, and
-- GAM's own 3% of that same job is $45-$120 — so outside the dearest metros the
-- cut is the bigger of the two lines, and the spot is priced as what it is:
-- advertising, not a commission. The competition charges $20-$100 per lead with
-- no job attached, and packages from $300 a month. $20 in rural Oklahoma is one
-- Angi lead; $120 in Los Angeles is still a third of their monthly package.
--
-- THE SPOT IS EXCLUSIVE — one contractor at the top of one trade in one area.
-- That is what "the top of the list" means and it is what makes it worth
-- anything. The full board stays open to everyone for free underneath it.
--
-- A re-price APPENDS rows with a forward effective_from and never touches a
-- spot already sold. An index with no band covering it is an ERROR and never a
-- free spot — the same discipline as every other GAM price card.
--
-- (This file was rewritten in place across those three passes rather than
-- appended to, and that is the documented exception, not a lapse: nothing was
-- deployed, nothing had been quoted, and no spot had ever been sold, so there
-- was no price to protect. Each time the applied tracking row was deleted and
-- the file re-run. Leaving two rejected grids standing "in effect" in a table a
-- human reads would have been the worse half of that trade. Once a spot is
-- sold, this stops being available and a re-price is a new forward-dated row.)
--
-- NOT PRICED ON DEMAND, deliberately, and this is the thing to revisit first: a
-- top spot in a metro with 400 GAM parks is worth far more than one in a town
-- with two, and that gap is much bigger than any cost-of-living gap. GAM has no
-- density anywhere yet, so pricing on it today would price every spot at
-- nothing. Cost of living is the right stand-in until there are parks to count.
--
-- No backfill: new table.

CREATE TABLE IF NOT EXISTS marketplace_placement_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Band on the area's cost-of-living index: index_min <= index < index_max.
  index_min numeric(6,3) NOT NULL,
  index_max numeric(6,3) NOT NULL,
  monthly_price numeric(10,2) NOT NULL,
  effective_from date NOT NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT NOW()
);

ALTER TABLE marketplace_placement_rates DROP CONSTRAINT IF EXISTS marketplace_placement_rates_band;
ALTER TABLE marketplace_placement_rates ADD CONSTRAINT marketplace_placement_rates_band
  CHECK (index_max > index_min);

ALTER TABLE marketplace_placement_rates DROP CONSTRAINT IF EXISTS marketplace_placement_rates_price;
ALTER TABLE marketplace_placement_rates ADD CONSTRAINT marketplace_placement_rates_price
  CHECK (monthly_price > 0);

DROP INDEX IF EXISTS ux_marketplace_placement_rates_band;
CREATE UNIQUE INDEX ux_marketplace_placement_rates_band
  ON marketplace_placement_rates(index_min, index_max, effective_from);

-- Backdated to 2020-01-01 because this schedule has no predecessor, exactly as
-- the FlexPay, FlexDeposit and job-financing grids were. The DELETE is scoped
-- to that one date so a forward re-price is never swept up by a replay.
DELETE FROM marketplace_placement_rates WHERE effective_from = DATE '2020-01-01';

INSERT INTO marketplace_placement_rates (index_min, index_max, monthly_price, effective_from, note)
SELECT v.index_min, v.index_max, v.monthly_price, DATE '2020-01-01',
       '10/31 Nic: $20 in the cheapest areas, the curve landing at $100-120. $55 x (index/100)^6 at each band''s middle, rounded to $5'
  FROM (VALUES
    --  index band       $/mo   areas   where that lands
    (0,       86,     20),  --    23   Monroe LA 83.6, Enid OK 84.3, McAllen TX 85.9
    (86,      90,     25),  --    84   Tulsa 89.2, rural Oklahoma 87.8, Albany GA 87.7
    (90,      94,     35),  --   119   Oklahoma City 90.4, rural Wyoming 92.7, Casper 93.8
    (94,      98,     45),  --    77   Cheyenne WY 96.5, rural Texas 97.1
    (98,     102,     55),  --    64   the US average is 100.0; rural Arizona 100.7
    (102,    106,     70),  --    43   Phoenix 103.3, Chicago 103.6
    (106,    110,     85),  --    18   New York state 107.9, Santa Cruz CA 109.9
    (110,    112,    105),  --     6   San Jose 110.4, Honolulu 111.0, Seattle 111.1
    (112,    999,    120)   --     5   New York metro 112.6, Los Angeles 113.6, Miami 114.2, San Francisco 115.6
  ) AS v(index_min, index_max, monthly_price);

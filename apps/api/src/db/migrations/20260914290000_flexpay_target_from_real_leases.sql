-- S642 (Nic): "We should calculate our reserve to match our target of, if we're
-- trying to onboard 30% of tenants, we need to aggregate 30% of all the total
-- lease balances plus utilities… do 30% of all base lease totals plus 20% on
-- utilities. Then we'll know if demand actually gets to 30% that we can fund
-- it."
--
-- WHAT WAS THERE. reserve_fund_state and float_account_state were seeded on
-- 2026-05-15 08:21:25 — the same timestamp on both rows — and never touched
-- again. A $4,200 reserve, a $26,750 float, $25,000 of "seed capital", 4.5%
-- APY, $796/month contributions. Model numbers somebody typed, presented on the
-- admin dashboard as platform financials. GAM has none of that money, and per
-- Nic's own funding rule it never will from outside capital — the float comes
-- from reinvested revenue and tips.
--
-- Worse, the admin card computed its TARGET as 3% of the FlexPay bankroll,
-- which is genuinely $0 because there are zero flexpay_inquiries of any status.
-- So it divided invented money by a real nothing and reported full coverage of
-- a target that did not exist. Meanwhile target_balance in the table said
-- $12,600 and nothing read it.
--
-- THE BALANCE IS ZEROED. Not deleted — the row stays and the model figures are
-- preserved in the note below — but a balance is a claim about money that
-- exists, and this one was false. Nic's stated purpose ("know if demand gets to
-- 30% that we can fund it") is actively defeated by a fabricated balance: it
-- would read 54% funded against the new target when the truth is 0%.
--
-- THE TARGET IS NOW COMPUTED, not stored. 30% of occupied-unit rent (the
-- adoption GAM is planning for) plus 20% on top for utilities — Nic: "they're a
-- lot higher at an RV park proportionately." At today's 43 occupied units and
-- $21,678/month that is $6,503.40 + $1,300.68 = $7,804.08, and it moves on its
-- own as units fill. A stored target goes stale the day a unit is leased.
-- target_balance is NOT NULL, so it is zeroed rather than nulled. It is no
-- longer the source of truth either way: the target is computed from live
-- leases at read time. A stored target goes stale the day a unit is leased,
-- which is exactly how the old $12,600 ended up disagreeing with the 3%-of-
-- bankroll figure the card actually displayed.
UPDATE reserve_fund_state
   SET balance = 0,
       target_balance = 0,
       monthly_contribution = 0,
       updated_at = NOW();

UPDATE float_account_state
   SET balance = 0,
       seed_capital = 0,
       monthly_interest = 0,
       updated_at = NOW();

COMMENT ON TABLE reserve_fund_state IS
  'GAM''s FlexPay default reserve. balance is REAL money accumulated (0 until the float is funded from reinvested revenue — never outside capital). The target is COMPUTED, not stored: 30% of occupied-unit rent + 20% for utilities. Superseded model figures, seeded 2026-05-15 and zeroed S642: balance 4200, target 12600, monthly_contribution 796, reserve_rate 1.0.';

COMMENT ON TABLE float_account_state IS
  'GAM''s FlexPay float. balance is REAL money available to advance (0 until funded from reinvested revenue + tips). Superseded model figures, seeded 2026-05-15 and zeroed S642: balance 26750, seed_capital 25000, apy 0.045, monthly_interest 100.';

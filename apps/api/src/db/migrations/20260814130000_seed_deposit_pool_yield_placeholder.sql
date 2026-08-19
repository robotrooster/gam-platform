-- S604: seed the market-yield side of earned-vs-owed.
--
-- 3.5% annual is a PLACEHOLDER (Nic, S604) standing in until the actual custody
-- vehicle is chosen and its real rate is known. It is roughly short-Treasury
-- territory, so the earned/spread figures are directionally right rather than
-- invented — but no accounting or tax position should be taken off this number
-- until a real rate replaces it.
--
-- Refresh discipline (mirrors state_deposit_interest_rates): INSERT a new
-- effective_month row when the rate changes; NEVER update a past row. The
-- resolver takes the most recent rate at or before the accrual month, so a rate
-- stays in force until superseded rather than lapsing between entries. That
-- also means historical accruals stay re-derivable from the rate that was
-- actually in force when they were booked.
--
-- Backdated to 2026-01-01 so any accrual run for an earlier month this year
-- resolves a rate rather than recording NULL earned.

INSERT INTO deposit_pool_yield_rates (effective_month, annual_rate_pct, source_label, notes)
VALUES (
  '2026-01-01',
  3.5000,
  'placeholder',
  'S604 placeholder pending selection of the custody vehicle. Replace with the real credited rate once the FBO/trust account is standing and its yield is known — do not update this row, insert a new effective_month.'
)
ON CONFLICT (effective_month) DO NOTHING;

-- Seed platform singleton rows.
-- Originally lived as ad-hoc inserts at the end of the old migrate.ts;
-- moved here as a proper migration so the singletons land exactly once
-- on a fresh database and are no-ops on existing ones.

INSERT INTO reserve_fund_state (balance, target_balance, phase, reserve_rate, monthly_contribution)
VALUES (0, 0, 1, 1.00, 0)
ON CONFLICT DO NOTHING;

INSERT INTO float_account_state (balance, seed_capital, apy, monthly_interest)
VALUES (25000, 25000, 0.045, 0)
ON CONFLICT DO NOTHING;

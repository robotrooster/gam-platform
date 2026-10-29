-- Both Flex price grids, stated ABSOLUTELY rather than by mutation, so the
-- chain is idempotent however many times it is replayed.
-- (10/26 — the second half of the problem the idempotency guard caught.)
--
-- WHAT WAS STILL WRONG AFTER 20261027090000.  Widening the CHECK let the chain
-- replay without throwing, but it did not make it CORRECT. The guard
-- (posPropaneProduct.test.ts) applies each migration TWICE BACK TO BACK, and
-- 20261027060000 re-prices by MUTATION:
--
--     SET fee = src.fee ... WHERE (d.payments = 2 AND src.payments = 4)
--                              OR (d.payments = 4 AND src.payments = 6)
--
-- Run once that moves the 4-payment column onto 2 and the 6-payment column
-- onto 4, which is what Nic asked for. Run TWICE it shifts again, so the
-- 2-payment price becomes what 4 had just become. The prices silently drift
-- with every replay. Production is correct (verified: $48/$67 through
-- $124/$173) because each migration ran exactly once there — but a bootstrap,
-- a restore, or the guard would not be.
--
-- A relative statement ("take this column and move it there") cannot be
-- idempotent. So this migration states both grids as FACTS, and because it
-- sorts last it is the final word regardless of what ran before it or how
-- often.
--
-- SAFE FOR A FUTURE RE-PRICE.  It only touches rows carrying tonight's exact
-- note strings. A real re-price appends rows with a later effective_from and
-- its own note, which this will never see or disturb. If you re-price these
-- grids, write ONE migration stating the new grid absolutely — do not mutate
-- these rows (see memory gam-one-migration-per-agreed-state).
--
-- Grids as agreed, for the record:
--   FLEXPAY        2nd Wed  3rd Wed  4th Wed
--   <$1,000           23       33       43
--   $1,000-1,499      28       40       52
--   $1,500-1,999      33       47       61
--   $2,000-2,499      38       54       70
--   $2,500-2,999      43       61       79
--
--   FLEXDEPOSIT    2 pmts   4 pmts
--   <$1,000           48       67
--   $1,000-1,499      67       93
--   $1,500-1,999      86      120
--   $2,000-2,499     105      147
--   $2,500-2,999     124      173
--
-- Neither product is offered at $3,000 or more: there is simply no bracket, and
-- services/flexFees.ts treats a missing bracket as an error, never a zero.
--
-- No backfill beyond this. Fully re-runnable: it is a delete-and-restate of
-- rows it identifies by note, so the hundredth run leaves exactly what the
-- first one did.

DELETE FROM flexpay_fee_schedule
 WHERE note LIKE '10/26%' OR note LIKE 'seed 10/26%';

INSERT INTO flexpay_fee_schedule (rent_min, rent_max, benefit_wednesday, fee, effective_from, note)
SELECT v.rent_min, v.rent_max, w.wed,
       CASE w.wed WHEN 2 THEN 23 + 5 * v.n WHEN 3 THEN 33 + 7 * v.n ELSE 43 + 9 * v.n END,
       DATE '2020-01-01',
       '10/26 final (Nic) — up one more; floor 23/33/43, capped top 43/61/79, none over $3,000'
  FROM (VALUES (0, 0.00::numeric, 1000.00::numeric), (1, 1000.00, 1500.00),
               (2, 1500.00, 2000.00), (3, 2000.00, 2500.00), (4, 2500.00, 3000.00)
       ) AS v(n, rent_min, rent_max)
 CROSS JOIN (VALUES (2), (3), (4)) AS w(wed);

DELETE FROM flexdeposit_fee_schedule
 WHERE note LIKE '10/26%' OR note LIKE 'seed 10/26%';

INSERT INTO flexdeposit_fee_schedule (deposit_min, deposit_max, payments, fee, effective_from, note)
SELECT v.deposit_min, v.deposit_max, p.payments,
       CASE p.payments WHEN 2 THEN v.two ELSE v.four END,
       DATE '2020-01-01',
       '10/26 final (Nic) — two choices only; same price for everybody at a given deposit'
  FROM (VALUES (   0.00::numeric, 1000.00::numeric,  48::numeric,  67::numeric),
               (1000.00,          1500.00,           67,           93),
               (1500.00,          2000.00,           86,          120),
               (2000.00,          2500.00,          105,          147),
               (2500.00,          3000.00,          124,          173)
       ) AS v(deposit_min, deposit_max, two, four)
 CROSS JOIN (VALUES (2), (4)) AS p(payments);

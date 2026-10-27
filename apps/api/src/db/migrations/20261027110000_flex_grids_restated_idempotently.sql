-- The Flex grids restated so the statement itself is idempotent, keyed on the
-- DATE rather than on a note string.
-- (10/26 — third and final correction to tonight's migration chain.)
--
-- WHY 20261027100000 WAS NOT ENOUGH.  It stated both grids as facts, which was
-- the right idea, but it identified the rows to replace by NOTE:
--
--     DELETE FROM flexpay_fee_schedule WHERE note LIKE '10/26%' ...
--
-- A note is a label, not a key. Rows seeded by the test bootstrap carry
-- 'test seed — the 10/26 grid', which that pattern does not match, so the
-- DELETE removed nothing and the INSERT then collided with them:
--
--     duplicate key value violates unique constraint "ux_flexpay_fee_bracket"
--
-- So it was idempotent on production and not idempotent anywhere else, which is
-- the worst of both: it looked fine where it was run and broke where it was
-- replayed.
--
-- WHAT THE RIGHT KEY IS.  effective_from = 2020-01-01. That date is not
-- arbitrary — 20261027020000 backdated the FIRST schedule to it precisely
-- because a first schedule has no predecessor and must cover every bill date.
-- Every later re-price APPENDS with a forward effective_from. So "the rows
-- dated 2020-01-01" is exactly "the first schedule", whoever wrote them and
-- whatever note they carry, and replacing them wholesale is both complete and
-- repeatable.
--
-- THE RULE FOR NEXT TIME, since this took three attempts: a migration that
-- re-prices must be a STATEMENT OF FACT keyed on something structural — the
-- bracket and the effective date — and never a mutation of whatever happens to
-- be there ("move this column onto that one") nor a match on prose.
--
-- Fully re-runnable: delete-every-row-at-this-date then insert the final set
-- lands identically on the first run and the hundredth, on production, on a
-- test database, and on a fresh bootstrap.
-- No backfill. Nothing has ever been charged from either grid.

DELETE FROM flexpay_fee_schedule     WHERE effective_from = DATE '2020-01-01';
DELETE FROM flexdeposit_fee_schedule WHERE effective_from = DATE '2020-01-01';

INSERT INTO flexpay_fee_schedule (rent_min, rent_max, benefit_wednesday, fee, effective_from, note)
SELECT v.rent_min, v.rent_max, w.wed,
       CASE w.wed WHEN 2 THEN 23 + 5 * v.n WHEN 3 THEN 33 + 7 * v.n ELSE 43 + 9 * v.n END,
       DATE '2020-01-01',
       '10/26 final (Nic) — floor 23/33/43, capped top 43/61/79, none over $3,000'
  FROM (VALUES (0, 0.00::numeric, 1000.00::numeric), (1, 1000.00, 1500.00),
               (2, 1500.00, 2000.00), (3, 2000.00, 2500.00), (4, 2500.00, 3000.00)
       ) AS v(n, rent_min, rent_max)
 CROSS JOIN (VALUES (2), (3), (4)) AS w(wed);

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

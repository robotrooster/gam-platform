-- Financing a marketplace job — the price card, stated once.
--
-- THIS FILE REPLACES SIX. The price was worked out live with Nic over one
-- evening (10/31) and each turn of it was written as its own migration:
-- 004000 seeded the FlexDeposit curve, 005000 and 006000 added and then
-- re-priced six payments, 007000 switched the whole thing to a flat fee per
-- month, and 008000/009000 fixed a rounding error in eleven brackets. Three of
-- those cannot be re-run against the finished table: two narrow the `payments`
-- CHECK to values that no longer cover the rows, and one guards its INSERT on a
-- note string a later file replaced, so on a second pass it duplicates five
-- brackets. They were named in NOT_DOUBLE_APPLY_SAFE to keep the replay test
-- honest, which is a note in a test rather than a fix.
--
-- So the six are deleted and this one states the agreed table absolutely: the
-- final CHECKs, the final 34 rows, and a DELETE ahead of the INSERT so a replay
-- lands on the same 34 rows instead of beside them.
--
-- THE PRICE. A flat fee for every month GAM's money is out:
--
--     fee = round to the nearest $5 of   job × 0.0235 × (payments − 1)
--
-- where `job` is the top of the bracket. Nic set the anchor himself — "Pick the
-- line where the to-pay payments on the job is $235 on a $10,000 job. And go
-- from there. Use that across the board. Two, four, six, and 12." $235 on
-- $10,000 over two payments is $0.0235 per dollar per month.
--
-- (payments − 1), NOT payments, and he asked about exactly this: "Wouldn't the
-- four payment fee just be double what the two payment fee is?" It is triple.
-- The first payment lands the day the job finishes and the last one squares it
-- up, so GAM's money is out one month fewer than there are payments: 2 → 1
-- month, 4 → 3, 6 → 5, 12 → 11.
--
-- A flat per-month fee is right because the average outstanding is the same
-- 0.47 of the job whatever the plan length — a 2-payment plan hands half back
-- on day one, a 6-payment plan a sixth but for five times as long, and those
-- cancel out. Only the duration differs, so no plan length subsidises another.
--
-- Six and twelve payments are for jobs over $5,000 only, enforced by a CHECK
-- rather than by the absence of rows, so a later re-price cannot quietly open
-- them to a $900 job.
--
-- Re-pricing APPENDS rows with a forward effective_from and never touches a
-- plan already agreed. A quote with no row covering it is an ERROR and never a
-- zero (services/jobFinancing) — "not offered" must not degrade into "free",
-- which is how the absence of a bracket above $20,000 does its work.
--
-- No backfill: the table is created here and nothing read it before now —
-- financing has no HTTP door and is held behind job_financing_enabled.

CREATE TABLE IF NOT EXISTS job_financing_fee_schedule (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_min numeric(12,2) NOT NULL CHECK (job_min >= 0),
  job_max numeric(12,2) NOT NULL,
  payments integer NOT NULL,
  fee numeric(12,2) NOT NULL CHECK (fee >= 0),
  effective_from date NOT NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT NOW()
);

-- Postgres has no ADD CONSTRAINT IF NOT EXISTS, and this file is replayed by
-- posPropaneProduct.test.ts, so every constraint is dropped before it is added.
ALTER TABLE job_financing_fee_schedule DROP CONSTRAINT IF EXISTS job_financing_fee_schedule_payments_check;
ALTER TABLE job_financing_fee_schedule ADD CONSTRAINT job_financing_fee_schedule_payments_check
  CHECK (payments IN (2, 4, 6, 12));

ALTER TABLE job_financing_fee_schedule DROP CONSTRAINT IF EXISTS job_financing_fee_schedule_band;
ALTER TABLE job_financing_fee_schedule ADD CONSTRAINT job_financing_fee_schedule_band
  CHECK (job_max > job_min);

ALTER TABLE job_financing_fee_schedule DROP CONSTRAINT IF EXISTS job_financing_long_plans_are_for_big_jobs;
ALTER TABLE job_financing_fee_schedule ADD CONSTRAINT job_financing_long_plans_are_for_big_jobs
  CHECK (payments <= 4 OR job_min >= 5000);

DROP INDEX IF EXISTS ux_job_financing_fee_schedule_band;
CREATE UNIQUE INDEX ux_job_financing_fee_schedule_band
  ON job_financing_fee_schedule(job_min, job_max, payments, effective_from);

-- Backdated to 2020-01-01 because this schedule has no predecessor, exactly as
-- the FlexPay and FlexDeposit grids were. The DELETE is what makes the file
-- replay-safe: it is scoped to this one effective date, so a forward re-price
-- appended later is never swept up by it.
DELETE FROM job_financing_fee_schedule WHERE effective_from = DATE '2020-01-01';

INSERT INTO job_financing_fee_schedule (job_min, job_max, payments, fee, effective_from, note)
SELECT v.job_min, v.job_max, v.payments, v.fee, DATE '2020-01-01',
       '10/31 Nic: $235 per month of GAM''s money on a $10,000 job — 2.35 cents per dollar per month, times (payments - 1)'
  FROM (VALUES
    --                          2 payments     4           6            12
    --                          (1 month out)  (3 months)  (5 months)   (11 months)
    (0,     1000,  2, 25),   (0,     1000,  4, 70),
    (1000,  1500,  2, 35),   (1000,  1500,  4, 105),
    (1500,  2000,  2, 45),   (1500,  2000,  4, 140),
    (2000,  2500,  2, 60),   (2000,  2500,  4, 175),
    (2500,  3000,  2, 70),   (2500,  3000,  4, 210),
    (3000,  4000,  2, 95),   (3000,  4000,  4, 280),
    (4000,  5000,  2, 120),  (4000,  5000,  4, 355),
    -- Over $5,000 the long plans open up.
    (5000,  7500,  2, 175),  (5000,  7500,  4, 530),  (5000,  7500,  6, 880),  (5000,  7500,  12, 1940),
    (7500,  10000, 2, 235),  (7500,  10000, 4, 705),  (7500,  10000, 6, 1175), (7500,  10000, 12, 2585),
    (10000, 12500, 2, 295),  (10000, 12500, 4, 880),  (10000, 12500, 6, 1470), (10000, 12500, 12, 3230),
    (12500, 15000, 2, 355),  (12500, 15000, 4, 1060), (12500, 15000, 6, 1765), (12500, 15000, 12, 3880),
    (15000, 20000, 2, 470),  (15000, 20000, 4, 1410), (15000, 20000, 6, 2350), (15000, 20000, 12, 5170)
  ) AS v(job_min, job_max, payments, fee);

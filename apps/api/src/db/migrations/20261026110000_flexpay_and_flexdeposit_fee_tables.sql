-- 10/26 (Nic) — REBUILDING THE FLEXPAY AND FLEXDEPOSIT FEE TABLES.
--
-- Both were designed around S640-S690 and lost to a compaction; the code, the
-- terms and CLAUDE.md still said flat $25/month (FlexPay) and $3/month custody
-- (FlexDeposit), which Nic has been clear is NOT his pricing intent.
--
-- WHY THEY CHANGED (Nic): flat $25 "wasn't fair to people only borrowing for
-- the shorter time, and it wasn't fair to the people who borrowed for longer."
--
-- ── FLEXPAY: rent bracket x the tenant's benefit WEDNESDAY ──────────────────
-- The Wednesday is the float: GAM fronts the rent at the lease's grace end and
-- is repaid when the benefit lands. A 2nd-Wednesday tenant is repaid in about a
-- week; a 4th-Wednesday tenant nearer three. There is no 1st-Wednesday column —
-- Nic: "I don't think we really had one for first Wednesday", because a benefit
-- that lands that early rarely needs FlexPay at all.
--
-- The anchor Nic remembers is the middle bracket at an even $8 step:
-- 2nd $18, 3rd $26, 4th $34. Everything else scales from it so that the fee is
-- a NEAR-CONSTANT PERCENTAGE OF RENT across brackets — his requirement: "try to
-- break it down where different rent amounts are kind of coming out as a
-- somewhat similar percentage." It lands at 1.02-1.07% on the 2nd Wednesday,
-- 1.45-1.60% on the 3rd, 1.89-2.13% on the 4th. Each column is also an even
-- step per bracket ($5, $7, $9), so it can be explained without a chart.
--
-- A FIXED PRICE FOR THE BRACKET, never a percentage of the particular rent.
-- Nic: "we're trying to stay out of lender territory and it's like a fixed
-- price for anything in that bracket is that price."
--
-- ── FLEXDEPOSIT: deposit bracket x NUMBER OF PAYMENTS ───────────────────────
-- No longer a monthly custody fee. Affirm-style: the deposit is paid over 2 to
-- 6 payments and the price comes from how big it is crossed with how many
-- payments. More payments means GAM's money is out longer, so it costs more.
-- Priced at each bracket's MIDPOINT, which puts the top bracket at $147 over
-- six payments; Nic recalled "around $160" for a $3,000 deposit, which is that
-- bracket's ceiling — so the two reconcile and the midpoint is the kinder read.
--
-- ── A TABLE, NOT CONSTANTS ─────────────────────────────────────────────────
-- Prices live in the database so Nic can change one without a deploy, and so a
-- price that was charged stays on the record (effective_from) rather than being
-- quietly rewritten. Nothing reads these yet: both products' enrollment is
-- closed, and Nic is reviewing the numbers. Wiring them to live pricing is a
-- separate, deliberate step.
--
-- Expand-only and re-runnable.

CREATE TABLE IF NOT EXISTS flexpay_fee_schedule (
  id              uuid PRIMARY KEY DEFAULT public.gen_random_uuid(),
  -- Inclusive floor, exclusive ceiling. NULL ceiling = no upper bound.
  rent_min        numeric(12,2) NOT NULL,
  rent_max        numeric(12,2),
  -- Which Wednesday of the month the benefit lands on: 2, 3 or 4.
  benefit_wednesday integer NOT NULL,
  fee             numeric(12,2) NOT NULL,
  effective_from  date NOT NULL DEFAULT CURRENT_DATE,
  note            text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT flexpay_fee_wednesday_check CHECK (benefit_wednesday IN (2, 3, 4)),
  CONSTRAINT flexpay_fee_range_check CHECK (rent_max IS NULL OR rent_max > rent_min),
  CONSTRAINT flexpay_fee_nonneg CHECK (fee >= 0)
);

COMMENT ON TABLE flexpay_fee_schedule IS
  'FlexPay price by rent bracket x benefit Wednesday (Nic, 10/26). A FIXED price
   for the bracket, never a percentage of the particular rent — "we are trying
   to stay out of lender territory". Replaces the flat $25/month.';

CREATE UNIQUE INDEX IF NOT EXISTS ux_flexpay_fee_bracket
  ON flexpay_fee_schedule (rent_min, benefit_wednesday, effective_from);

CREATE TABLE IF NOT EXISTS flexdeposit_fee_schedule (
  id              uuid PRIMARY KEY DEFAULT public.gen_random_uuid(),
  deposit_min     numeric(12,2) NOT NULL,
  deposit_max     numeric(12,2),
  -- Nic: "deposits could be paid over 2 to 6 payments."
  payments        integer NOT NULL,
  fee             numeric(12,2) NOT NULL,
  effective_from  date NOT NULL DEFAULT CURRENT_DATE,
  note            text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT flexdeposit_fee_payments_check CHECK (payments BETWEEN 2 AND 6),
  CONSTRAINT flexdeposit_fee_range_check CHECK (deposit_max IS NULL OR deposit_max > deposit_min),
  CONSTRAINT flexdeposit_fee_nonneg CHECK (fee >= 0)
);

COMMENT ON TABLE flexdeposit_fee_schedule IS
  'FlexDeposit price by deposit bracket x number of payments, 2 to 6 (Nic,
   10/26). Affirm-style, replacing the $3/month custody fee. A FIXED price for
   the bracket.';

CREATE UNIQUE INDEX IF NOT EXISTS ux_flexdeposit_fee_bracket
  ON flexdeposit_fee_schedule (deposit_min, payments, effective_from);

-- ── The seed Nic asked for ("start with those numbers") ────────────────────
-- FlexPay: 2nd = 8 + 5n, 3rd = 12 + 7n, 4th = 16 + 9n, n = bracket index.
INSERT INTO flexpay_fee_schedule (rent_min, rent_max, benefit_wednesday, fee, note)
SELECT v.rent_min, v.rent_max, w.wed,
       CASE w.wed WHEN 2 THEN 8 + 5 * v.n WHEN 3 THEN 12 + 7 * v.n ELSE 16 + 9 * v.n END,
       'seed 10/26 — middle bracket anchored at Nic''s $18/$26/$34'
  FROM (VALUES
          (0, 0.00,    1000.00),
          (1, 1000.00, 1500.00),
          (2, 1500.00, 2000.00),
          (3, 2000.00, 2500.00),
          (4, 2500.00, NULL::numeric)
       ) AS v(n, rent_min, rent_max)
 CROSS JOIN (VALUES (2), (3), (4)) AS w(wed)
 WHERE NOT EXISTS (SELECT 1 FROM flexpay_fee_schedule);

-- FlexDeposit: the bracket midpoint x 1.523% x (payments + 1) / 2, rounded.
INSERT INTO flexdeposit_fee_schedule (deposit_min, deposit_max, payments, fee, note)
SELECT v.deposit_min, v.deposit_max, p.n,
       ROUND(v.mid * 0.01523 * (p.n + 1) / 2.0),
       'seed 10/26 — top bracket lands $147 at six; Nic recalled ~$160 at its $3,000 ceiling'
  FROM (VALUES
          (0.00,    1000.00,        750.00),
          (1000.00, 1500.00,       1250.00),
          (1500.00, 2000.00,       1750.00),
          (2000.00, 2500.00,       2250.00),
          (2500.00, NULL::numeric, 2750.00)
       ) AS v(deposit_min, deposit_max, mid)
 CROSS JOIN (VALUES (2), (3), (4), (5), (6)) AS p(n)
 WHERE NOT EXISTS (SELECT 1 FROM flexdeposit_fee_schedule);

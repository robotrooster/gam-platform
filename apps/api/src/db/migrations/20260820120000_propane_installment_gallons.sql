-- S609 (Nic, DIRECTIVE): propane installments are split by GALLONS and
-- scheduled onto future invoices before any money moves.
--
-- Nic:
--   "Just have installments split on the monthly bill, have a scheduler. So you
--    say two hundred gallons at whatever price... fifty gallons per month, we
--    round it to the nearest gallon and then the fourth installment could be a
--    smaller amount. So if it's a hundred and ninety gallons, you do three
--    forty-eights and then a forty-six... All decided before any money moves.
--    And then when the September bill goes out, they can see a kind of running
--    ledger."
--
-- WHAT CHANGES, AND WHY IT MATTERS:
--
--   1. THE SPLIT IS IN GALLONS, NOT DOLLARS. A tenant reading their bill sees
--      "48 gal @ $3.25" — a quantity they can check against the tank — instead
--      of a quarter of a dollar figure. The last installment carries the
--      remainder (190 gal over 4 → 48, 48, 48, 46), so the gallons sum to the
--      fill exactly and no rounding invents propane nobody delivered.
--
--   2. NOTHING BILLS IMMEDIATELY. The first installment now rides the NEXT
--      monthly invoice. Previously installment #1 was charged the moment the
--      fill was recorded, as a standalone due-today row: it landed mid-month,
--      outside any invoice, and — because rent is pay-in-full — it could block
--      the tenant paying their rent at all. A fill is not an emergency; it goes
--      on the next bill like everything else.
--
--   3. THE WHOLE SCHEDULE IS KNOWN UP FRONT. An August fill split four ways
--      bills September, October, November, December, decided at the moment it
--      is recorded. That is what lets the tenant see a running balance rather
--      than being surprised each month.
--
-- gallons is nullable ONLY so existing rows stay valid; every new installment
-- carries it. No backfill: no propane fill exists in any environment yet.

ALTER TABLE propane_fill_installments
  ADD COLUMN IF NOT EXISTS gallons numeric(10,2);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'propane_fill_installments_gallons_check') THEN
    ALTER TABLE propane_fill_installments
      ADD CONSTRAINT propane_fill_installments_gallons_check
      CHECK (gallons IS NULL OR gallons > 0);
  END IF;
END $$;

COMMENT ON COLUMN propane_fill_installments.gallons IS
  'S609: the gallons this installment covers. The split is by GALLONS — a tenant can check a quantity against their tank in a way they cannot check a quarter of a dollar figure. The last installment takes the remainder so the gallons sum to the fill exactly.';

COMMENT ON COLUMN propane_fill_installments.billing_cycle_month IS
  'S609: the invoice month this installment rides. Fixed when the fill is recorded — the whole schedule is decided before any money moves, so the tenant can see what is coming.';

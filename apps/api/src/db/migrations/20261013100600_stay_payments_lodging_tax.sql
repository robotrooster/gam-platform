-- 10/12 (Nic) — THE LODGING TAX INSIDE A BOOKING DEPOSIT IS STORED WHEN IT IS PAID
--
-- A stay booked on the booking site is quoted with the property's short-stay
-- lodging tax already in it (shared priceStay), and its deposit is a share of
-- that taxed total. How much of the deposit is tax was never written down: the
-- reports work it out every time from the property's CURRENT tax rate
-- (incomeBasis stayTaxPctSql: "the booking keeps no record of the rate it was
-- quoted at, so the property's current rate stands in for it"). A rate change
-- would rewrite past months. The ledger must post the tax collected as it was
-- (gam-ledger-design-2026-10-12 §P1, M2).
--
-- stay_payments.lodging_tax_amount is written with the site deposit's row
-- (stayPayments.recordSiteDeposit, from propertyBooking.confirmBookingDeposit)
-- — the deposit's lodging tax as priced that day by priceStay.
-- A 'pos_sale' row (a stay paid at the register or through a pay link) carries
-- NULL here on purpose: the sale itself stores its taxes (pos_transactions
-- tax_amount and tax_breakdown, "Lodging tax" by name, decisions #21), and the
-- ledger reads them from the sale — never twice.
--
-- Backfill needed: site deposits recorded before today, at the rate in force
-- now (scripts/oct12_ledger_source_facts_backfill.ts, named in
-- ledger_derived_facts). Production 10/12: 0 site deposits (its 2 stay
-- payments are register sales).
-- Safe drop: ALTER TABLE stay_payments DROP COLUMN lodging_tax_amount.

ALTER TABLE stay_payments ADD COLUMN IF NOT EXISTS lodging_tax_amount numeric(10,2);

COMMENT ON COLUMN stay_payments.lodging_tax_amount IS
  '10/12 (Nic, ledger P1): the lodging tax inside toward_stay on a booking-site deposit, as priced the day it was paid. NULL on a pos_sale row: the sale stores its own taxes (pos_transactions.tax_breakdown).';

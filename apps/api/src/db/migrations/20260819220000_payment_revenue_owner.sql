-- S609 (Nic, DIRECTIVE): every charge records WHOSE MONEY it is.
--
-- Nic: "Late fees that come from the lease and are on the invoice need to go to
-- the landlord according to the lease. If you're talking about late fees that
-- would be in the one-off charges, those also need to go to the landlord. I
-- don't know why that would go to GAM. The only fees we collect are retries on
-- ACH, pass-through on card processing, and the subscription for various tenant
-- opt-in products."
--
-- THE DEFECT. Only rent and utilities were ever split out to the landlord
-- (services/allocation.ts refuses every other type). So a late fee off the
-- signed lease, or a one-off charge a landlord billed by hand, settled with NO
-- owner share: the tenant paid it and the money stopped on GAM's books. Silent
-- in both directions — the tenant's balance was correct, and the landlord had no
-- line item to notice was missing.
--
-- WHY A COLUMN RATHER THAN A RULE ABOUT payment types or descriptions.
-- entry_description cannot carry this. services/leaseFees.ts writes a LANDLORD's
-- hand-billed fee as 'SUBSCRIP', and the FlexPay/subscription path writes GAM's
-- own fee as 'SUBSCRIP' too. After the fact the two are identical rows. Whose
-- money a charge is, is a fact about WHY it was created — known only at creation
-- — so it is stamped there and never re-derived.
--
-- DEFAULT 'landlord' is deliberate and is the safe direction. A charge nobody
-- classified is one the tenant owes because of their tenancy, and GAM's list is
-- short and closed. Getting it wrong this way pays a landlord money GAM might
-- have kept; the other default silently keeps money that was never GAM's.
--
-- BACKFILL: the existing rows are re-stamped below from their entry_description.
-- Only the closed GAM list flips to 'gam'; everything else keeps the default.
-- Safe — dev holds only rent and late-fee rows, and production has not launched.

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS revenue_owner text NOT NULL DEFAULT 'landlord';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payments_revenue_owner_check') THEN
    ALTER TABLE payments
      ADD CONSTRAINT payments_revenue_owner_check
      CHECK (revenue_owner IN ('landlord', 'gam'));
  END IF;
END $$;

-- Re-stamp history. The list mirrors GAM_REVENUE_ENTRY_DESCRIPTIONS in
-- packages/shared — the single source both sides import.
UPDATE payments
   SET revenue_owner = 'gam'
 WHERE entry_description IN ('RETURNFEE', 'DECLINEFEE', 'MANUALPAY', 'FLEXPAY', 'FCPAYDOWN', 'ONTIMEPAY')
   AND revenue_owner <> 'gam';

-- A GAM-owned charge is GAM's own receivable and has no landlord side, so it
-- must never carry a platform-fee accrual or an owner share. Nothing enforces
-- that at write time yet; the allocation engine reads this column instead.
CREATE INDEX IF NOT EXISTS idx_payments_revenue_owner
  ON payments (revenue_owner) WHERE revenue_owner = 'gam';

COMMENT ON COLUMN payments.revenue_owner IS
  'S609: whose money this charge is. ''landlord'' (the default) = the tenant owes it because of their LEASE — rent, utilities, late fees, any fee a landlord billed. ''gam'' = the tenant owes it for using a GAM service — a returned bank payment, a declined card, a manual-payment recording, or an opt-in product. Stamped at creation because entry_description cannot distinguish a landlord''s hand-billed fee from a GAM subscription (both write ''SUBSCRIP''). Read by services/allocation.ts to decide whether an owner share is booked.';

-- S655 money plan M3 (Step 1). Expand-only: added nullable columns, two checks
-- that hold for every existing row (the new columns are NULL), a replaced
-- trigger function with the same signature, and an audit trigger.
--
-- WHO HOLDS PAID-AHEAD MONEY. Money a tenant paid ahead is theirs until it pays
-- a bill, and where it sits decides whether GAM may ever pay it out:
--   landlord     the landlord took it (cash, check, money order, a bank
--                deposit, a typed-in carry-forward). GAM never pays it out.
--   gam          it reached GAM through Stripe, or is a platform-held prepaid
--                move-in fee. Released to the landlord as it pays bills.
--   reclassified rent already paid and already counted, moved to credit when a
--                stay was shortened (source_payment_id = the row it came from).
-- NULL only until the deploy backfill (P2) stamps every existing credit (P2
-- counts them at deploy time; credits keep being added until then); C1 makes it
-- NOT NULL.
--
-- received_at is the day the money ARRIVED. Nic (10/2): "Money received" counts
-- paid-ahead money on that day, in full, and $0 again when it pays a later
-- bill (Todd's two-month check counts in September; October is $0 from him).
--
-- voided_at withdraws a credit (an undone bank-deposit settle's excess). The
-- remaining amount is left as it was; a voided credit can never be used.
ALTER TABLE lease_prepaid_credits
  ADD COLUMN IF NOT EXISTS funded_by text
    CONSTRAINT lease_prepaid_credits_funded_by_check
    CHECK (funded_by IS NULL OR funded_by IN ('landlord','gam','reclassified')),
  ADD COLUMN IF NOT EXISTS received_at timestamptz,
  ADD COLUMN IF NOT EXISTS voided_at   timestamptz,
  ADD COLUMN IF NOT EXISTS void_reason text;
ALTER TABLE lease_prepaid_credits ADD CONSTRAINT lease_prepaid_credits_void_has_reason
  CHECK ((voided_at IS NULL) = (void_reason IS NULL));
COMMENT ON COLUMN lease_prepaid_credits.funded_by IS
  'S655: who holds this money. landlord = the landlord took it (cash, check, money order, a bank deposit, a typed-in carry-forward); gam = it reached GAM through Stripe (or a platform-held prepaid fee) and is released to the landlord as it is used; reclassified = rent already paid and already counted, moved to credit when a stay was shortened (source_payment_id = the row it reclassifies). NULL only before the P2 backfill; NOT NULL in C1.';
COMMENT ON COLUMN lease_prepaid_credits.received_at IS
  'S655: when the money actually arrived (Russ Fuller: 2026-08-12). Under "Money received" paid-ahead money counts on this day, in full, and $0 when it later pays a bill.';
COMMENT ON COLUMN lease_prepaid_credits.voided_at IS
  'S655: withdrawn (an undone bank-deposit settle''s excess). amount_remaining is left as it was; a voided credit can never be used and is out of every balance.';
COMMENT ON COLUMN lease_prepaid_credits.void_reason IS
  'S655: why the credit was withdrawn, in plain words. Set exactly when voided_at is.';

-- The prepaid move-in fee banks itself as paid-ahead money the moment its row
-- settles (S653). Now it also records who holds it and when it arrived. Who
-- holds it is read from HOW the row was paid, never from platform_held alone
-- (a settle may write platform_held = FALSE on a box row, whose payout figure
-- is 0, while GAM holds the card money):
--   gam       no hand payment (manual_method NULL) and the row carries Stripe's
--             charge or intent, or FlexPay's float, or platform_held;
--   landlord  everything else: cash, check, money order, a bank deposit or a
--             prior arrangement (manual_method set, even over an old card
--             intent left on the row by a failed attempt).
--
-- One credit per box row (lease_prepaid_credits_source_payment_uidx). When the
-- money behind a box leaves (an undone bank-deposit match puts the row back to
-- pending; a dispute or return), the credit is withdrawn (voided_at; the credit
-- service withdraws only a credit nothing was spent from). If that same row is
-- then paid again, the
-- withdrawn credit comes back, stamped with who holds the NEW money and the day
-- it arrived: the tenant's paid-ahead money is never lost to the unique key, and
-- never keeps the funding of money that is gone. A credit that was never
-- withdrawn, or was spent, keeps its record (paying the same row twice is
-- refused upstream). This reads only lease_prepaid_credits, never credit_uses:
-- it is replaced while the running code still settles box rows, before M4
-- creates that table.
CREATE OR REPLACE FUNCTION public.prepaid_fee_follows_payment() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  kind text;
BEGIN
  IF NEW.status = 'settled' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'settled')
     AND NEW.lease_fee_id IS NOT NULL AND NEW.lease_id IS NOT NULL THEN
    SELECT money_kind INTO kind FROM lease_fees WHERE id = NEW.lease_fee_id;
    IF kind = 'prepaid' THEN
      INSERT INTO lease_prepaid_credits
        (lease_id, tenant_id, amount_original, amount_remaining, source_payment_id, note,
         funded_by, received_at)
      VALUES (NEW.lease_id, NEW.tenant_id, NEW.amount, NEW.amount, NEW.id,
              'Rent paid ahead on the lease (move-in)',
              CASE WHEN NEW.manual_method IS NULL
                         AND (NEW.platform_held
                              OR NEW.stripe_charge_id IS NOT NULL
                              OR NEW.stripe_payment_intent_id IS NOT NULL
                              OR NEW.flexpay_advance_id IS NOT NULL)
                   THEN 'gam' ELSE 'landlord' END,
              COALESCE(NEW.settled_at, now()))
      ON CONFLICT (source_payment_id) WHERE source_payment_id IS NOT NULL DO UPDATE
         SET funded_by   = EXCLUDED.funded_by,
             received_at = EXCLUDED.received_at,
             voided_at   = NULL,
             void_reason = NULL,
             updated_at  = now()
       WHERE lease_prepaid_credits.voided_at IS NOT NULL
         AND lease_prepaid_credits.amount_remaining = lease_prepaid_credits.amount_original
         AND lease_prepaid_credits.amount_original = EXCLUDED.amount_original;
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- Landlord-issued credits get the same change journal paid-ahead credits have.
DROP TRIGGER IF EXISTS audit_tenant_credits ON tenant_credits;
CREATE TRIGGER audit_tenant_credits AFTER DELETE OR UPDATE ON tenant_credits
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();

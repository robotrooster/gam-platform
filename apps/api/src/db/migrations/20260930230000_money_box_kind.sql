-- S653 (Nic): "we need to be able to tag the money boxes as either credits or
-- debits. So if the landlord tags a random box on their template as, hey, this
-- is credit to the renter, they can just toggle that... that's the difference
-- between a refundable pet deposit versus a non-refundable pet fee."
--
-- Before this, whether a money box was refundable was hard-wired to the box's
-- tag name — and only the security deposit was ever actually returned. A pet
-- deposit, key deposit or rent pre-payment was collected as a fee and never
-- came back or applied to anything.
--
-- money_kind on the TEMPLATE FIELD is the landlord's tag (NULL = the tag
-- name's default). money_kind on LEASE_FEES is what the signed lease says:
--   fee      — the landlord keeps it
--   deposit  — held for the renter, returned at move-out less deductions
--   prepaid  — credit to the renter, drawn down by upcoming rent invoices
--
-- revenue_owner 'held' on payments: money GAM holds for the tenant (a prepaid
-- box) — neither the landlord's at settlement nor GAM's revenue. The landlord's
-- share is booked when the credit is consumed (services/prepaidRelease).
--
-- Backfill of lease_fees follows the old hard-wired meaning exactly, so nothing
-- already signed changes behavior except that it is now recorded.
ALTER TABLE lease_template_fields
  ADD COLUMN money_kind text CHECK (money_kind IN ('fee', 'deposit', 'prepaid'));
COMMENT ON COLUMN lease_template_fields.money_kind IS 'S653: the landlord''s tag on a money box — fee (kept), deposit (held, returned at move-out) or prepaid (credit drawn down by rent). NULL = the box name''s default.';

ALTER TABLE lease_fees
  ADD COLUMN money_kind text NOT NULL DEFAULT 'fee' CHECK (money_kind IN ('fee', 'deposit', 'prepaid'));
UPDATE lease_fees SET money_kind = CASE
  WHEN fee_type = 'last_month_rent' THEN 'prepaid'
  WHEN is_refundable THEN 'deposit'
  ELSE 'fee' END;
COMMENT ON COLUMN lease_fees.money_kind IS 'S653: what this money IS on the signed lease — fee (landlord keeps), deposit (held, returned at move-out) or prepaid (credit to the renter, drawn down by rent).';

ALTER TABLE payments DROP CONSTRAINT payments_revenue_owner_check;
ALTER TABLE payments ADD CONSTRAINT payments_revenue_owner_check
  CHECK (revenue_owner = ANY (ARRAY['landlord'::text, 'gam'::text, 'held'::text]));

ALTER TABLE lease_prepaid_credits
  ADD COLUMN source_payment_id uuid REFERENCES payments(id),
  ADD COLUMN note text;
CREATE UNIQUE INDEX lease_prepaid_credits_source_payment_uidx
  ON lease_prepaid_credits (source_payment_id) WHERE source_payment_id IS NOT NULL;

-- A prepaid box becomes paid-ahead credit the moment its charge settles —
-- whichever way it settled (card, bank, cash at the desk, a check). Thirteen
-- code paths mark a payment settled; a rule on the table covers all of them.
CREATE OR REPLACE FUNCTION prepaid_fee_follows_payment() RETURNS trigger AS $$
DECLARE
  kind text;
BEGIN
  IF NEW.status = 'settled' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'settled')
     AND NEW.lease_fee_id IS NOT NULL AND NEW.lease_id IS NOT NULL THEN
    SELECT money_kind INTO kind FROM lease_fees WHERE id = NEW.lease_fee_id;
    IF kind = 'prepaid' THEN
      INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining, source_payment_id, note)
      VALUES (NEW.lease_id, NEW.tenant_id, NEW.amount, NEW.amount, NEW.id, 'Rent paid ahead on the lease (move-in)')
      ON CONFLICT (source_payment_id) WHERE source_payment_id IS NOT NULL DO NOTHING;
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_prepaid_fee_follows_payment
  AFTER INSERT OR UPDATE OF status ON payments
  FOR EACH ROW EXECUTE FUNCTION prepaid_fee_follows_payment();

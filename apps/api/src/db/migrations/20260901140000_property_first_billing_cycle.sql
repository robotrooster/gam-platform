-- S632 (Nic, DIRECTIVE): "On the first billing cycle, that needs to be not a
-- platform wide feature. Because if I onboard different properties that I own
-- next month, it's gonna bill them right away. This needs to be a setting per
-- property, as onboarding is required."
--
-- He is right and this corrects a design mistake made hours earlier. The setting
-- was put on the LANDLORD, which is the wrong grain: onboarding happens one
-- PROPERTY at a time. Mountain View is set to bill from September; a park bought
-- in November under the same LLC would have inherited September and invoiced its
-- existing tenants for two months they had already paid somebody else.
--
-- NO FALLBACK TO THE LANDLORD VALUE, deliberately. An inherited default is
-- exactly the failure above wearing a different hat — a new property must be
-- answered for on its own, or bill the month each lease starts in, which is the
-- safe reading.
ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS first_billing_cycle date;

COMMENT ON COLUMN properties.first_billing_cycle IS
  'S632: the first month GAM invoices THIS property''s existing (onboarded) tenants for. Per property because onboarding is per property. NULL = bill the month each lease starts in.';

ALTER TABLE properties
  DROP CONSTRAINT IF EXISTS properties_first_billing_cycle_is_month;
ALTER TABLE properties
  ADD CONSTRAINT properties_first_billing_cycle_is_month
  CHECK (first_billing_cycle IS NULL OR date_trunc('month', first_billing_cycle) = first_billing_cycle);

-- Carry the two answers already given down to the properties they were meant for.
UPDATE properties p
   SET first_billing_cycle = l.first_billing_cycle
  FROM landlords l
 WHERE l.id = p.landlord_id
   AND l.first_billing_cycle IS NOT NULL
   AND p.first_billing_cycle IS NULL;

COMMENT ON COLUMN landlords.first_billing_cycle IS
  'S632 SUPERSEDED by properties.first_billing_cycle — onboarding is per property. Retained only as the record of what was set before the move; nothing reads it.';

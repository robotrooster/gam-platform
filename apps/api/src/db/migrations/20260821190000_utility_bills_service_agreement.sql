-- S614: a utility bill can belong to a SERVICE AGREEMENT instead of a lease.
--
-- utility_bills.lease_id was NOT NULL, which is why nothing could bill a space
-- the landlord serves but does not lease. The bill still always has a PAYER
-- (tenant_id stays NOT NULL — every bill has someone who owes it); what becomes
-- optional is the tenancy behind it.
--
-- Exactly one of the two must be set. A bill that belongs to both a lease and a
-- service agreement, or to neither, is a billing ambiguity rather than a state
-- worth supporting.
ALTER TABLE utility_bills ALTER COLUMN lease_id DROP NOT NULL;
ALTER TABLE utility_bills
  ADD COLUMN IF NOT EXISTS service_agreement_id uuid
    REFERENCES utility_service_agreements(id) ON DELETE RESTRICT;

ALTER TABLE utility_bills DROP CONSTRAINT IF EXISTS utility_bills_payer_source_check;
ALTER TABLE utility_bills ADD CONSTRAINT utility_bills_payer_source_check
  CHECK ((lease_id IS NOT NULL) <> (service_agreement_id IS NOT NULL));

CREATE INDEX IF NOT EXISTS idx_utility_bills_service_agreement
  ON utility_bills (service_agreement_id) WHERE service_agreement_id IS NOT NULL;

COMMENT ON COLUMN utility_bills.service_agreement_id IS
  'S614: set when this bill is for a space the landlord SERVICES but does not '
  'lease (cross-property utilities). Mutually exclusive with lease_id.';

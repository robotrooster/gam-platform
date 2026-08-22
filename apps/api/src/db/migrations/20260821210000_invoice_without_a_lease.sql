-- S615 (Nic, LAUNCH-CRITICAL): an invoice that has no lease behind it.
--
-- S614 gave a utility bill a payer with no tenancy (a service agreement for the
-- spaces next door). It stopped one step short of the money: those bills were
-- written to utility_bills and NOTHING could ever put them on a document or
-- collect them, because invoiceGeneration iterates ACTIVE LEASES and
-- invoices.lease_id was NOT NULL. Nic is still taking that $75 in cash.
--
-- An invoice now belongs to EITHER a lease or a service agreement. Exactly one:
-- an invoice belonging to both, or to neither, is a billing ambiguity rather
-- than a state worth supporting. It always has a landlord, a unit and a payer.

ALTER TABLE invoices ALTER COLUMN lease_id DROP NOT NULL;
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS service_agreement_id uuid
    REFERENCES utility_service_agreements(id) ON DELETE RESTRICT;

ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_payer_source_check;
ALTER TABLE invoices ADD CONSTRAINT invoices_payer_source_check
  CHECK ((lease_id IS NOT NULL) <> (service_agreement_id IS NOT NULL));

-- The idempotency key that makes invoice generation safe to re-run was
-- (lease_id, due_date). A NULL lease_id would make every service invoice
-- distinct from every other under that index, so the cycle key has to be
-- restated per payer source. Both stay UNIQUE; each now covers its own half.
DROP INDEX IF EXISTS ux_invoices_lease_due_date;
CREATE UNIQUE INDEX ux_invoices_lease_due_date
  ON invoices (lease_id, due_date) WHERE lease_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_invoices_service_agreement_due_date
  ON invoices (service_agreement_id, due_date) WHERE service_agreement_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_invoices_service_agreement
  ON invoices (service_agreement_id) WHERE service_agreement_id IS NOT NULL;

COMMENT ON COLUMN invoices.service_agreement_id IS
  'S615: set when this invoice bills a space the landlord SERVICES but does not '
  'lease (cross-property utilities). Mutually exclusive with lease_id. Such an '
  'invoice carries utility rows only — there is no rent to charge.';

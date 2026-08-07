-- S581 (Leases + e-sign sweep, Nic): money add-ons that actually reach billing.
--
-- WHY: a signed "terms addendum" (executeAddendumTerms) was record-only — it
-- never wrote the new money figures back to the lease, so billing (which reads
-- leases.rent_amount + monthly_ongoing lease_fees) never saw them. Nic confirmed
-- two real money add-ons that MUST reach billing:
--   1. An optional recurring charge the tenant opts into mid-lease — parking spot,
--      garage, storage. Base rent unchanged; a new recurring line on the bill.
--   2. A base-rent change — e.g. AZ mobile-home space rent, which can be raised
--      with a landlord-set notice period. The addendum IS the notice; the new rent
--      takes effect on the date the landlord picks.
--
-- MODEL (Nic — auto-apply on the date): the addendum records a PENDING change with
-- a landlord-set effective_date. A nightly job applies changes whose date has
-- arrived — a rent change updates leases.rent_amount; a recurring-fee change
-- INSERTs the monthly_ongoing lease_fees row. Existing billing then picks up the
-- new figure from the next cycle with NO billing-code change. Landlord always sets
-- the effective_date themselves (no state-law hardcoding — matches the platform's
-- no-state-specific-legal-logic rule; for AZ MH they pick a date past their notice
-- window).
--
-- STATUS lifecycle: draft (addendum drafted, unsigned) -> scheduled (both signed,
-- via executeAddendumTerms) -> applied (the job pushed it to billing on/after the
-- effective_date) | cancelled (the addendum was voided / superseded).

CREATE TABLE scheduled_lease_changes (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lease_id             uuid NOT NULL REFERENCES leases(id) ON DELETE CASCADE,
  -- the addendum document that carries this change (NULL-safe: keep the pending
  -- change if the doc row is ever hard-removed, though docs are soft-managed).
  source_document_id   uuid REFERENCES lease_documents(id) ON DELETE SET NULL,
  change_type          text NOT NULL CHECK (change_type IN ('rent', 'recurring_fee')),
  effective_date       date NOT NULL,
  -- change_type='rent': the new base rent from effective_date forward.
  new_rent_amount      numeric(12,2),
  -- change_type='recurring_fee': the monthly_ongoing lease_fees row to create.
  fee_type             text,
  fee_amount           numeric(12,2),
  fee_description      text,
  status               text NOT NULL DEFAULT 'draft'
                         CHECK (status IN ('draft', 'scheduled', 'applied', 'cancelled')),
  applied_at           timestamp with time zone,
  -- the lease_fees row this change created (recurring_fee only) — audit + undo.
  applied_lease_fee_id uuid,
  created_at           timestamp with time zone DEFAULT now(),
  updated_at           timestamp with time zone DEFAULT now(),
  -- shape guard: each change_type carries exactly the fields it needs.
  CONSTRAINT scheduled_lease_changes_shape_check CHECK (
    (change_type = 'rent'          AND new_rent_amount IS NOT NULL)
    OR
    (change_type = 'recurring_fee' AND fee_amount IS NOT NULL AND fee_type IS NOT NULL)
  )
);

-- The nightly job scans scheduled changes whose date has arrived.
CREATE INDEX ix_scheduled_lease_changes_due
  ON scheduled_lease_changes (effective_date)
  WHERE status = 'scheduled';

-- Completion + void flip drafts/scheduled by their source document.
CREATE INDEX ix_scheduled_lease_changes_doc
  ON scheduled_lease_changes (source_document_id);

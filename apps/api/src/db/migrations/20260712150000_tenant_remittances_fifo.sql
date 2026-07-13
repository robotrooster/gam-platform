-- S537 (Nic): FIFO payment application — the tenant portal moves from
-- per-charge-row payments to ONE "Pay now" that covers the outstanding
-- ledger oldest-first.
--
-- Model: a REMITTANCE is one Stripe charge covering N charge rows in
-- full plus at most one partial (the charge row is SPLIT at initiation —
-- same pattern as services/propaneRedistribution.ts — so every existing
-- consumer keeps summing whole rows) plus an optional pay-ahead
-- remainder that lands in lease_prepaid_credits and is consumed by the
-- next invoice generation, oldest credit first.
--
-- properties.accept_partial_payments: accepting a partial payment resets
-- the eviction clock in most jurisdictions — a landlord preparing to act
-- must be able to refuse anything less than the full outstanding balance
-- (Pay Now then requires amount >= total outstanding). Default TRUE:
-- partials welcome (Nic: tenants pay what they can, when they can).
--
-- No backfill needed: all tables are new; the properties column defaults.

CREATE TABLE tenant_remittances (
  id                       uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id                uuid NOT NULL REFERENCES tenants(id),
  lease_id                 uuid REFERENCES leases(id),
  landlord_id              uuid NOT NULL REFERENCES landlords(id),
  amount                   numeric(12,2) NOT NULL CHECK (amount > 0),
  applied_amount           numeric(12,2) NOT NULL CHECK (applied_amount >= 0),
  unapplied_amount         numeric(12,2) NOT NULL DEFAULT 0 CHECK (unapplied_amount >= 0),
  status                   text NOT NULL DEFAULT 'processing'
                             CHECK (status IN ('processing', 'settled', 'failed')),
  payment_method           text CHECK (payment_method IN ('ach', 'card')),
  stripe_payment_intent_id text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  settled_at               timestamptz
);
CREATE INDEX idx_tenant_remittances_tenant ON tenant_remittances(tenant_id);
CREATE INDEX idx_tenant_remittances_pi ON tenant_remittances(stripe_payment_intent_id);

-- The FIFO plan, line by line — the tenant-visible "where every dollar
-- went" audit trail.
CREATE TABLE remittance_applications (
  id             uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  remittance_id  uuid NOT NULL REFERENCES tenant_remittances(id) ON DELETE CASCADE,
  payment_id     uuid NOT NULL REFERENCES payments(id),
  amount_applied numeric(12,2) NOT NULL CHECK (amount_applied > 0),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_remittance_applications_remittance ON remittance_applications(remittance_id);
CREATE INDEX idx_remittance_applications_payment ON remittance_applications(payment_id);

ALTER TABLE properties
  ADD COLUMN accept_partial_payments boolean NOT NULL DEFAULT true;

-- Pay-ahead remainder. Consumed oldest-first when the next invoice's
-- charge rows are generated.
CREATE TABLE lease_prepaid_credits (
  id                    uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  lease_id              uuid NOT NULL REFERENCES leases(id),
  tenant_id             uuid NOT NULL REFERENCES tenants(id),
  amount_original       numeric(12,2) NOT NULL CHECK (amount_original > 0),
  amount_remaining      numeric(12,2) NOT NULL CHECK (amount_remaining >= 0),
  source_remittance_id  uuid REFERENCES tenant_remittances(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_lease_prepaid_credits_lease ON lease_prepaid_credits(lease_id);

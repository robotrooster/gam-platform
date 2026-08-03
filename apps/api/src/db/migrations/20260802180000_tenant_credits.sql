-- S577 — landlord-issued tenant account credits (Nic).
--
-- A landlord can issue a credit to a tenant for ANY reason: a capped-state
-- screening-fee difference, a late-fee refund, an accidental overcharge,
-- goodwill, etc. The credit is applied to the tenant's next rent invoice
-- (drawn down oldest-first, same mechanism as lease_prepaid_credits, but a
-- SEPARATE table + its own apply step). It is FUNDED BY THE LANDLORD: reducing
-- the tenant's invoice means the landlord simply receives less rent — no cash
-- is pre-collected and no GAM float.
--
-- This is INDEPENDENT of work-trade (which is hours-logging only; a landlord
-- adjusts approved hours there, never a credit) — do not conflate.
--
-- amount_remaining draws down to 0 as invoices consume it; status='void'
-- cancels the remaining balance. Keep-everything: rows are never deleted.

CREATE TABLE tenant_credits (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  landlord_id       uuid NOT NULL REFERENCES landlords(id) ON DELETE CASCADE,
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lease_id          uuid REFERENCES leases(id) ON DELETE SET NULL,
  amount_original   numeric(12,2) NOT NULL CHECK (amount_original > 0),
  amount_remaining  numeric(12,2) NOT NULL CHECK (amount_remaining >= 0),
  category          text NOT NULL DEFAULT 'other'
                      CHECK (category = ANY (ARRAY['screening_cap','late_fee_refund','overcharge','goodwill','other']::text[])),
  reason            text,
  status            text NOT NULL DEFAULT 'active'
                      CHECK (status = ANY (ARRAY['active','void']::text[])),
  created_by        uuid REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  voided_at         timestamptz
);
CREATE INDEX idx_tenant_credits_lease_active ON tenant_credits (lease_id) WHERE status = 'active' AND amount_remaining > 0;
CREATE INDEX idx_tenant_credits_tenant ON tenant_credits (tenant_id);
CREATE INDEX idx_tenant_credits_landlord ON tenant_credits (landlord_id);

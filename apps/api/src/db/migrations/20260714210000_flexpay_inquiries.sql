-- S541: FlexPay demand-test gate (Nic).
--
-- WHY: FlexPay fronts rent to the landlord each cycle, so every active
-- enrollment is GAM float. For initial rollout Nic wants enrollment
-- APPROVAL-GATED: the tenant clicks "I'm interested" in the tenant
-- portal (the ONLY surface — never landlord portal, never marketing),
-- GAM reviews the lease + verifies SSI/SSDI income, then approves.
-- This lets the feature ship immediately while controlling total float
-- and measuring demand (the inquiry volume itself is the demand data
-- that decides whether outside capital is worth raising — FlexPay is
-- projected at 40-50% of GAM revenue at scale).
--
-- One row per tenant (UNIQUE) — the row IS the tenant's FlexPay
-- disposition; admins flip status rather than creating new rows.
-- Enrollment (services/flexpay.ts enrollFlexPay) hard-requires
-- status='approved' server-side; the tenant UI is not the gate.
--
-- No backfill needed (new feature, no existing enrollments in prod).

CREATE TABLE flexpay_inquiries (
  id                 uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id          uuid NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,
  status             text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'approved', 'declined')),
  -- What the tenant CLAIMS at inquiry time; verification happens at
  -- review (approve sets tenants.ssi_ssdi when income is verified).
  claimed_income_source text NOT NULL CHECK (claimed_income_source IN ('ssi', 'ssdi')),
  tenant_note        text,
  admin_notes        text,
  reviewed_by_user_id uuid REFERENCES users(id),
  reviewed_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ix_flexpay_inquiries_status ON flexpay_inquiries(status);

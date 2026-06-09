-- S247: Sublease money flow + property-level toggle + invite flow.
--
-- Three additions:
--
-- 1. properties.subleasing_allowed boolean (default FALSE)
--    Property-level gate. AND'd with leases.subleasing_allowed enum:
--    a sublease request is allowed iff property.subleasing_allowed=TRUE
--    AND lease.subleasing_allowed != 'prohibited'. Property is the
--    master switch driven by the landlord's lease document; lease
--    enum is the per-tenancy refinement.
--
-- 2. sublessee_invitations table
--    Token-based invite-by-email flow. Sublessor enters sublessee
--    email at sublease-request time; if the email doesn't resolve to
--    an existing GAM tenant, an invitation row is created and an
--    email goes out. Sublessee follows the link, signs up, completes
--    ACH + BG; on acceptance, the invitation links to the new
--    tenants row + the sublease becomes approve-eligible. Without
--    invitation acceptance the sublease can't reach 'pending' status
--    (sublessee_tenant_id NULL until accepted).
--
-- 3. subleases.sublessee_tenant_id becomes nullable
--    Pre-S247 the column was NOT NULL — sublessee had to pre-exist.
--    Phase 2 invite flow needs to create the sublease row WITHOUT a
--    tenant id until the invitee accepts. Adding the
--    sublessee_invitation_id link lets us derive the state.

ALTER TABLE properties
  ADD COLUMN subleasing_allowed boolean NOT NULL DEFAULT false;

-- subleases.sublessee_tenant_id → nullable. The distinct-parties
-- CHECK constraint already handles the NULL case (NULL <> ... is
-- NULL, evaluated as not-FALSE → constraint not violated).
ALTER TABLE subleases
  ALTER COLUMN sublessee_tenant_id DROP NOT NULL;

-- Link sublease → invitation when sublessee was invited rather than
-- a pre-existing tenant. Allows the sublease row to exist in a
-- 'pending_invite' status until acceptance.
ALTER TABLE subleases
  ADD COLUMN sublessee_invitation_id uuid;

-- Extend status enum with 'pending_invite' — sublease exists but
-- sublessee_tenant_id is NULL because the invite hasn't been
-- accepted yet. Landlord can't decide a pending_invite sublease
-- (the route gates on status='pending'); once accepted, status
-- flips to 'pending'.
ALTER TABLE subleases
  DROP CONSTRAINT IF EXISTS subleases_status_check;
ALTER TABLE subleases
  ADD CONSTRAINT subleases_status_check
    CHECK (status = ANY (ARRAY['pending_invite', 'pending', 'active', 'terminated']));

-- Sublessor profit credit balance — when sublessee pays
-- sub_monthly_amount and master_share_amount routes to landlord,
-- the difference accrues here. Withdrawable to sublessor's bank.
-- Tracked separately from user_balance_ledger because this is a
-- sublease-specific credit pool that needs distinct audit fields.
-- Subleasor_credit_balances stays at zero / null when the sublease
-- is at full pass-through (sub_monthly_amount == master_share_amount).
CREATE TABLE sublessor_credit_balances (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  sublease_id      uuid NOT NULL REFERENCES subleases(id),
  sublessor_tenant_id uuid NOT NULL REFERENCES tenants(id),
  balance          numeric(10,2) NOT NULL DEFAULT 0,
  total_earned     numeric(10,2) NOT NULL DEFAULT 0,  -- lifetime accruals
  total_withdrawn  numeric(10,2) NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT NOW(),
  updated_at       timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT sublessor_credit_balances_sublease_uniq UNIQUE (sublease_id),
  CONSTRAINT sublessor_credit_balances_balance_nonneg CHECK (balance >= 0)
);

CREATE INDEX idx_sublessor_credit_balances_tenant
  ON sublessor_credit_balances (sublessor_tenant_id);

-- Sublessee invitations table

CREATE TABLE sublessee_invitations (
  id                       uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  token                    text NOT NULL UNIQUE,
  sublessor_tenant_id      uuid NOT NULL REFERENCES tenants(id),
  master_lease_id          uuid NOT NULL REFERENCES leases(id),
  sublessee_email          text NOT NULL,
  sub_monthly_amount       numeric(10,2) NOT NULL,
  master_share_amount      numeric(10,2) NOT NULL,
  start_date               date NOT NULL,
  end_date                 date,
  notes                    text,
  status                   text NOT NULL DEFAULT 'sent',
  accepted_tenant_id       uuid REFERENCES tenants(id),
  accepted_at              timestamptz,
  cancelled_at             timestamptz,
  expires_at               timestamptz NOT NULL,
  sublease_id              uuid REFERENCES subleases(id),
  created_at               timestamptz NOT NULL DEFAULT NOW(),
  updated_at               timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT sublessee_invitations_status_check
    CHECK (status = ANY (ARRAY['sent', 'accepted', 'expired', 'cancelled'])),
  CONSTRAINT sublessee_invitations_dates_check
    CHECK (end_date IS NULL OR end_date >= start_date),
  CONSTRAINT sublessee_invitations_amounts_check
    CHECK (sub_monthly_amount > 0 AND master_share_amount >= 0)
);

CREATE INDEX idx_sublessee_invitations_token  ON sublessee_invitations (token);
CREATE INDEX idx_sublessee_invitations_sublessor ON sublessee_invitations (sublessor_tenant_id);
CREATE INDEX idx_sublessee_invitations_email  ON sublessee_invitations (sublessee_email);
CREATE INDEX idx_sublessee_invitations_status ON sublessee_invitations (status, expires_at);

-- Back-link constraint: once invitation is accepted, the subleases
-- row's sublessee_invitation_id should point at it.
ALTER TABLE subleases
  ADD CONSTRAINT subleases_invitation_fk
    FOREIGN KEY (sublessee_invitation_id) REFERENCES sublessee_invitations(id);

-- S258: pos_customer onboarding invitations — token-based public
-- accept flow for non-tenant FlexCharge customers to register an ACH
-- bank account with GAM. Mirrors sublessee_invitations shape (S247):
-- merchant fires the invite, customer clicks the email link, lands
-- on a public page (no GAM auth), completes Stripe Financial
-- Connections to verify their bank, and the pos_customer row's
-- stripe_customer_id + ach_verified get stamped.

CREATE TABLE pos_customer_invitations (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  token           text NOT NULL UNIQUE,
  pos_customer_id uuid NOT NULL REFERENCES pos_customers(id),
  landlord_id     uuid NOT NULL REFERENCES landlords(id),
  status          text NOT NULL DEFAULT 'sent',
  setup_intent_id text,
  accepted_at     timestamptz,
  cancelled_at    timestamptz,
  expires_at      timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT NOW(),
  updated_at      timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT pos_customer_invitations_status_check
    CHECK (status = ANY (ARRAY['sent', 'in_progress', 'accepted', 'expired', 'cancelled']))
);

CREATE INDEX idx_pos_customer_invitations_token ON pos_customer_invitations (token);
CREATE INDEX idx_pos_customer_invitations_customer ON pos_customer_invitations (pos_customer_id);
CREATE INDEX idx_pos_customer_invitations_status ON pos_customer_invitations (status, expires_at);

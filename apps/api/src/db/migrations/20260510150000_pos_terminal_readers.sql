-- S241: Stripe Terminal reader registry.
--
-- Nic decision: "if we are using stripe api any stripe hardware should
-- work." Stripe Terminal supports any Stripe-Connect-enabled reader via
-- its API; we don't hardcode device vendors or models. This table tracks
-- which readers a landlord has paired with which property — same
-- per-property posture as pos_items per S241 (different LLC operators
-- per property is common).
--
-- The stripe_reader_id is the canonical identifier; nickname is for the
-- POS UI to surface a human label. Soft-archive only — historical
-- transactions reference the row.

CREATE TABLE pos_terminal_readers (
  id                  uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  landlord_id         uuid NOT NULL,
  property_id         uuid NOT NULL,
  stripe_reader_id    text NOT NULL,
  nickname            text NOT NULL,
  status              text NOT NULL DEFAULT 'active',
  registered_at       timestamptz NOT NULL DEFAULT NOW(),
  created_at          timestamptz NOT NULL DEFAULT NOW(),
  updated_at          timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT pos_terminal_readers_status_check
    CHECK (status IN ('active', 'archived'))
);

-- Unique per landlord — landlords can't accidentally register the same
-- physical reader twice (Stripe would also reject; this is the local
-- guard). Tenant-side namespace is global per Stripe account, but the
-- index is scoped here for clarity.
CREATE UNIQUE INDEX idx_pos_terminal_readers_stripe_id
  ON pos_terminal_readers (landlord_id, stripe_reader_id);

CREATE INDEX idx_pos_terminal_readers_property_active
  ON pos_terminal_readers (property_id)
  WHERE status = 'active';

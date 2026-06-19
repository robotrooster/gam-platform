-- Per-property agent revenue permissions.
--
-- The customer-service agent is read-rich but action-light by design. A handful
-- of agent actions affect the landlord's potential revenue (taking a payment,
-- processing a renewal, billing a fee). The landlord must OPT IN to each of these
-- per property — the agent may never take a revenue action on a property the
-- landlord hasn't explicitly enabled. Absence of a row = NOT enabled (default off).
--
-- Deliberately scoped: accepting a notice-to-vacate and changing lease terms are
-- NOT representable here — the agent never performs those actions at all.
--
-- `capability` CHECK mirrors AGENT_REVENUE_CAPABILITIES in packages/shared. Keep
-- the two in lockstep (single source of truth for the value set).
-- No backfill needed: every (property, capability) pair starts off.

CREATE TABLE IF NOT EXISTS property_agent_permissions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id   UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  capability    TEXT NOT NULL CHECK (capability IN ('take_payment', 'lease_renewal', 'bill_fee')),
  enabled       BOOLEAN NOT NULL DEFAULT FALSE,
  updated_by    UUID REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (property_id, capability)
);

CREATE INDEX IF NOT EXISTS idx_property_agent_permissions_property
  ON property_agent_permissions (property_id);

COMMENT ON TABLE property_agent_permissions IS
  'Per-property landlord opt-in for revenue-affecting agent actions. No row OR enabled=false => the agent may NOT take that action on that property. Capability set mirrors AGENT_REVENUE_CAPABILITIES in packages/shared.';

-- Track WHO owns a tenant-owned home/RV (S568, Nic).
--
-- WHY: units.dwelling_ownership only says landlord vs tenant-owned. But a
-- tenant-owned home has a specific OWNER — and that owner is not always the
-- occupant. Cases:
--   * owner-occupant: the resident owns the home they live in.
--   * in-park investor: a tenant owns a home on another lot and subleases it.
--   * EXTERNAL investor: someone who owns many homes across parks (without
--     owning any park) and subleases them at a markup as a business.
-- The home owner IS the economic sublessor (subleases.sublessor earns the
-- markup). Tracking ownership lets GAM tie a sale (bill of sale / purchase
-- agreement) to the transfer, power an investor's cross-park portfolio, and
-- anchor who the sublessor is.
--
-- owner_user_id is ANY GAM user (tenant, contact, or a future investor role) —
-- ownership is a fact about the chattel, independent of any lease. One ACTIVE
-- ownership per unit's dwelling; history is retained (status flips, never
-- deleted — see the keep-everything rule).

CREATE TABLE home_ownerships (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_id          uuid NOT NULL REFERENCES units(id),
  owner_user_id    uuid NOT NULL REFERENCES users(id),
  status           text NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active','transferred','removed')),
  acquired_via     text NOT NULL DEFAULT 'recorded'
                   CHECK (acquired_via IN ('recorded','sale','transfer','financed_payoff')),
  -- Links the transfer to its signed record (bill of sale / purchase agreement),
  -- so the park always has a copy of how ownership changed hands.
  sale_document_id uuid REFERENCES lease_documents(id) ON DELETE SET NULL,
  acquired_at      timestamptz NOT NULL DEFAULT now(),
  released_at      timestamptz,
  notes            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_home_ownerships_unit ON home_ownerships(unit_id);
-- Investor portfolio: every home a user owns, across all parks.
CREATE INDEX idx_home_ownerships_owner ON home_ownerships(owner_user_id) WHERE status = 'active';
-- At most ONE active owner per unit's dwelling.
CREATE UNIQUE INDEX ux_home_ownership_active_per_unit ON home_ownerships(unit_id) WHERE status = 'active';

COMMENT ON TABLE home_ownerships IS
  'S568: who owns the tenant-owned home/RV on a unit. Owner = economic sublessor. Owner may be the occupant, an in-park tenant investor, or an external cross-park investor. History retained (status flips, never deleted).';

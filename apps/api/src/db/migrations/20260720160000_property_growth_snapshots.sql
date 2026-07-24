-- S550 (Nic): PROPERTY-grain daily snapshots — the finest grain of the
-- growth-telemetry system. properties(landlord_id, state, city) makes every
-- rollup derivable from this table (per-landlord portfolio trends, per-city,
-- platform-wide), which is what powers the future landlord efficiency
-- reports: "when you migrated on, this park ran 70% occupancy — now 85%."
-- Also captures the operational state that MUTATES and can't be
-- reconstructed later: delinquency, eviction (suspended) units, open
-- maintenance load, outstanding balances.
-- History starts the day this lands (pre-launch). No backfill possible.

CREATE TABLE property_growth_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_date date NOT NULL,
  property_id uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  landlord_id uuid NOT NULL,               -- denormalized: survives re-assignment, speeds rollups
  units integer NOT NULL DEFAULT 0,
  occupied_units integer NOT NULL DEFAULT 0,     -- active lease (billing definition)
  vacant_units integer NOT NULL DEFAULT 0,       -- units.status = 'vacant'
  delinquent_units integer NOT NULL DEFAULT 0,   -- units.status = 'delinquent'
  suspended_units integer NOT NULL DEFAULT 0,    -- units.status = 'suspended' (eviction mode)
  active_leases integer NOT NULL DEFAULT 0,
  active_tenants integer NOT NULL DEFAULT 0,
  monthly_rent_roll numeric(14,2) NOT NULL DEFAULT 0,
  outstanding_balance numeric(14,2) NOT NULL DEFAULT 0,  -- unpaid (pending/failed) payment rows
  open_maintenance integer NOT NULL DEFAULT 0,   -- not completed/cancelled
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (snapshot_date, property_id)
);

CREATE INDEX property_growth_snapshots_date_idx ON property_growth_snapshots (snapshot_date);
CREATE INDEX property_growth_snapshots_landlord_idx ON property_growth_snapshots (landlord_id, snapshot_date);

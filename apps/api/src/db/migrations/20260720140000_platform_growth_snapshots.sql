-- S550 (Nic): growth telemetry — "track every data point we possibly can."
-- created_at already answers WHEN each landlord/property/unit onboarded;
-- what can't be reconstructed later is anything that MUTATES (occupancy,
-- rent roll, counts before a delete). So: one nightly snapshot row per
-- (date, state, city) with the counts that matter, plus a platform-wide
-- totals row (state='*', city='*') because distinct-landlord counts don't
-- sum across cities (one landlord can span several).
--
-- This powers: growth-velocity charts ("how fast are we spreading"),
-- the heat map OVER TIME (join to properties.lat/lon), market-strength
-- comparisons ("400 landlords around Las Vegas, 2 in California").
-- History starts the day this lands — which is before launch, so the
-- platform's entire real life is covered. No backfill possible or needed.

CREATE TABLE platform_growth_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_date date NOT NULL,
  state text NOT NULL,             -- '*' = platform-wide totals row
  city  text NOT NULL,             -- '*' = platform-wide totals row
  landlords integer NOT NULL DEFAULT 0,        -- distinct landlords with >=1 property here
  properties integer NOT NULL DEFAULT 0,
  units integer NOT NULL DEFAULT 0,
  occupied_units integer NOT NULL DEFAULT 0,   -- units with an active lease (billing definition)
  vacant_units integer NOT NULL DEFAULT 0,     -- units.status = 'vacant'
  active_leases integer NOT NULL DEFAULT 0,
  active_tenants integer NOT NULL DEFAULT 0,   -- distinct tenants on active leases
  monthly_rent_roll numeric(14,2) NOT NULL DEFAULT 0,  -- sum of active-lease rent
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (snapshot_date, state, city)
);

CREATE INDEX platform_growth_snapshots_date_idx ON platform_growth_snapshots (snapshot_date);

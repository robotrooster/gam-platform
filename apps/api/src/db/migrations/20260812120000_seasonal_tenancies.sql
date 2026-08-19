-- S602 Snowbird Phase 2: seasonal-tenancy config (companion to the lease).
--
-- WHY: a snowbird's season is a nominal recurring window (month/day, e.g.
-- Oct 1 – Apr 30) that repeats every year. This row holds that window plus the
-- per-account priority marker (Phase 3) and the generation bookkeeping. A yearly
-- job (Phase 2b) materializes the spot-locked, auto-recurring reservation on the
-- unit from this row and couples it to the lease's hibernate/resume. One row per
-- seasonal lease. See SNOWBIRD_SEASONAL_SPEC.md.
--
-- No backfill needed (new table; existing leases simply have no seasonal config
-- until a landlord sets one).

CREATE TABLE IF NOT EXISTS seasonal_tenancies (
  id                  uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  lease_id            uuid NOT NULL REFERENCES leases(id) ON DELETE CASCADE,
  unit_id             uuid NOT NULL REFERENCES units(id),
  tenant_id           uuid REFERENCES tenants(id),
  -- Nominal recurring window, stored as month/day (recurs annually). A window
  -- may cross the year boundary (start_month > end_month, e.g. Oct→Apr); the
  -- generation job resolves it to concrete dates for each upcoming season.
  season_start_month  integer NOT NULL,
  season_start_day    integer NOT NULL,
  season_end_month    integer NOT NULL,
  season_end_day      integer NOT NULL,
  -- Phase 3: landlord-set "priority snowbird" marker (wired to relocation).
  is_priority         boolean NOT NULL DEFAULT false,
  active              boolean NOT NULL DEFAULT true,
  -- Idempotent generation: the season-year we last materialized a reservation
  -- for. A season spanning a year boundary is keyed by its START year.
  last_generated_year integer,
  created_at          timestamp with time zone DEFAULT now() NOT NULL,
  updated_at          timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT seasonal_tenancies_lease_unique      UNIQUE (lease_id),
  CONSTRAINT seasonal_tenancies_start_month_range CHECK (season_start_month BETWEEN 1 AND 12),
  CONSTRAINT seasonal_tenancies_start_day_range   CHECK (season_start_day   BETWEEN 1 AND 31),
  CONSTRAINT seasonal_tenancies_end_month_range   CHECK (season_end_month   BETWEEN 1 AND 12),
  CONSTRAINT seasonal_tenancies_end_day_range     CHECK (season_end_day     BETWEEN 1 AND 31)
);

CREATE INDEX IF NOT EXISTS idx_seasonal_tenancies_active
  ON seasonal_tenancies (active) WHERE active = true;

CREATE TRIGGER trg_seasonal_tenancies_updated_at
  BEFORE UPDATE ON seasonal_tenancies
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

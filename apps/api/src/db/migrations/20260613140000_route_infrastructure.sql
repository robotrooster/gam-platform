-- Phase 1a.3 — route engine infrastructure: depots + vehicles +
-- dump_locations.
--
-- WHY: Route optimization needs three things beyond customer stops:
--   1. A DEPOT — where the truck starts and ends each day (the
--      yard). Single-depot per business at MVP; multi-depot lands
--      when a business needs it.
--   2. A VEHICLE — the truck. Capacity matters for dump-insertion
--      logic (we approximate via stop_count_to_dump at MVP since
--      real weight/volume data isn't on appointments yet).
--   3. DUMP_LOCATIONS — where the truck drops off mid-route. Trash
--      hauling has these (transfer stations / landfills); other
--      business types may not, hence nullable on the route side
--      (a maintenance crew doesn't dump).
--
-- These are the inputs to the route optimizer (services/
-- routeOptimizer.ts — same session). Output is an ordered stop
-- sequence; PERSISTING that sequence (generated_routes +
-- route_stops tables) lands in the next session.
--
-- All three tables are owned by a business + scoped to it. Multi-
-- business sharing (e.g., two businesses sharing a dump_location)
-- isn't modeled — at MVP each business carries its own row even if
-- the underlying physical site is the same.
--
-- SAFE — NO BACKFILL NEEDED: tables are brand new, no rows exist.

-- ── depots ────────────────────────────────────────────────────
CREATE TABLE public.depots (
    id uuid PRIMARY KEY DEFAULT public.gen_random_uuid(),
    business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
    name text NOT NULL,
    street1 text NOT NULL,
    street2 text,
    city text NOT NULL,
    state text NOT NULL,
    zip text NOT NULL,
    -- Geocoded. Required for the optimizer; the dispatcher fills these
    -- in at depot creation via an in-house geocoder (Phase 1a.2 work,
    -- pre-this-session). Until that geocoder lands, the values get
    -- entered manually by the operator.
    lat numeric(10,7) NOT NULL,
    lon numeric(10,7) NOT NULL,
    notes text,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT depots_status_check
      CHECK (status = ANY (ARRAY['active'::text, 'archived'::text]))
);
CREATE INDEX idx_depots_business
  ON public.depots (business_id) WHERE status = 'active';
CREATE TRIGGER trg_depots_updated_at
  BEFORE UPDATE ON public.depots
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ── vehicles ─────────────────────────────────────────────────
CREATE TABLE public.vehicles (
    id uuid PRIMARY KEY DEFAULT public.gen_random_uuid(),
    business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
    home_depot_id uuid NOT NULL REFERENCES public.depots(id),
    name text NOT NULL,
    -- Vehicle identifier on the operator's side (license plate, fleet
    -- number, etc.). Free-form text, optional.
    plate_or_id text,
    -- Capacity hints used by the optimizer's dump-insertion logic.
    -- stops_per_dump approximates "how many trash pickups can the
    -- truck hold before it needs to dump." Real weight/volume comes
    -- later when appointments carry yard/pound estimates.
    stops_per_dump integer DEFAULT 50 NOT NULL,
    -- Average travel speed in mph. Used only for ETA estimation in
    -- the optimizer output. Defaults to 25 (urban + stops + traffic).
    avg_speed_mph integer DEFAULT 25 NOT NULL,
    -- Average per-stop service time in minutes. Used to compute total
    -- route duration. Defaults to 3 (trash pickup is fast).
    avg_service_minutes integer DEFAULT 3 NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT vehicles_status_check
      CHECK (status = ANY (ARRAY['active'::text, 'inactive'::text, 'archived'::text])),
    CONSTRAINT vehicles_stops_per_dump_positive CHECK (stops_per_dump > 0),
    CONSTRAINT vehicles_speed_positive          CHECK (avg_speed_mph > 0),
    CONSTRAINT vehicles_service_minutes_positive CHECK (avg_service_minutes > 0)
);
CREATE INDEX idx_vehicles_business
  ON public.vehicles (business_id) WHERE status = 'active';
CREATE TRIGGER trg_vehicles_updated_at
  BEFORE UPDATE ON public.vehicles
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ── dump_locations ───────────────────────────────────────────
CREATE TABLE public.dump_locations (
    id uuid PRIMARY KEY DEFAULT public.gen_random_uuid(),
    business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
    name text NOT NULL,
    street1 text NOT NULL,
    street2 text,
    city text NOT NULL,
    state text NOT NULL,
    zip text NOT NULL,
    lat numeric(10,7) NOT NULL,
    lon numeric(10,7) NOT NULL,
    -- How long a dump takes (drive in, unload, drive out). Folded into
    -- route ETA calculations.
    typical_dump_minutes integer DEFAULT 15 NOT NULL,
    -- Operating hours — comma-separated HH:MM-HH:MM windows or NULL
    -- for 24/7. Optional, not enforced by the optimizer yet (assumes
    -- always-open); future refinement.
    operating_hours text,
    notes text,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT dump_locations_status_check
      CHECK (status = ANY (ARRAY['active'::text, 'archived'::text])),
    CONSTRAINT dump_locations_dump_minutes_positive
      CHECK (typical_dump_minutes > 0)
);
CREATE INDEX idx_dump_locations_business
  ON public.dump_locations (business_id) WHERE status = 'active';
CREATE TRIGGER trg_dump_locations_updated_at
  BEFORE UPDATE ON public.dump_locations
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

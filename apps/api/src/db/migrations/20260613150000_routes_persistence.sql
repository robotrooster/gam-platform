-- Phase 1a.3 — generated_routes + route_stops persistence.
--
-- WHY: routeOptimizer (services/routeOptimizer.ts) produces an
-- ordered plan in memory. To make it useful to drivers and the
-- dispatcher, we persist:
--   - generated_routes: the plan envelope (which vehicle, which
--     day, summary totals, lifecycle status)
--   - route_stops: each individual leg in sequence order (customer
--     stop, dump trip, depot return), with planned + actual
--     timestamps so drivers can mark progress.
--
-- Lifecycle:
--   generated → in_progress → completed
-- Stops:
--   planned → completed | skipped
--
-- No UNIQUE on (vehicle_id, generated_for_date) — regeneration is
-- legitimate (customer adds an appointment mid-day, dispatcher
-- needs to re-optimize). The dispatcher decides which route is
-- "the" route for that truck/day; dropped routes stay archived
-- in the data for audit.
--
-- SAFE — NO BACKFILL NEEDED: tables are brand new.

-- ── generated_routes ─────────────────────────────────────────
CREATE TABLE public.generated_routes (
    id uuid PRIMARY KEY DEFAULT public.gen_random_uuid(),
    business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
    vehicle_id uuid NOT NULL REFERENCES public.vehicles(id),
    depot_id uuid NOT NULL REFERENCES public.depots(id),
    -- The calendar date this route covers. Day boundary is whatever
    -- the dispatcher's local timezone is; we store dates not
    -- timestamps so the route is "for July 1" regardless of any
    -- subtle clock drift.
    generated_for_date date NOT NULL,
    -- The planned start time (optimizer's startAt input). Used for
    -- recomputing ETAs if a stop runs long.
    start_at_planned timestamp with time zone NOT NULL,
    -- Who triggered the generation. NULL allowed for future
    -- cron/system generation (auto-generate tomorrow's route at
    -- midnight, etc.).
    generated_by_user_id uuid REFERENCES public.users(id),
    status text DEFAULT 'generated'::text NOT NULL,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    -- Optimizer output totals — snapshotted at generation time.
    total_miles numeric(10,2) NOT NULL,
    total_minutes numeric(10,2) NOT NULL,
    stop_count integer NOT NULL,
    dump_count integer NOT NULL,
    -- Track how many appointments were skipped (not geocoded yet).
    -- Surfaces in the UI so dispatchers know they may need to
    -- backfill coordinates.
    skipped_ungeocoded_count integer DEFAULT 0 NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT generated_routes_status_check
      CHECK (status = ANY (ARRAY[
        'generated'::text, 'in_progress'::text, 'completed'::text
      ])),
    CONSTRAINT generated_routes_started_audit
      CHECK (status = 'generated' OR started_at IS NOT NULL),
    CONSTRAINT generated_routes_completed_audit
      CHECK (status <> 'completed' OR completed_at IS NOT NULL)
);
CREATE INDEX idx_generated_routes_business_date
  ON public.generated_routes (business_id, generated_for_date DESC);
CREATE INDEX idx_generated_routes_vehicle_date
  ON public.generated_routes (vehicle_id, generated_for_date DESC);
CREATE INDEX idx_generated_routes_status
  ON public.generated_routes (business_id, status)
  WHERE status <> 'completed';
CREATE TRIGGER trg_generated_routes_updated_at
  BEFORE UPDATE ON public.generated_routes
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ── route_stops ─────────────────────────────────────────────
CREATE TABLE public.route_stops (
    id uuid PRIMARY KEY DEFAULT public.gen_random_uuid(),
    route_id uuid NOT NULL REFERENCES public.generated_routes(id) ON DELETE CASCADE,
    -- 0-indexed position in the optimized order.
    sequence_order integer NOT NULL,
    stop_kind text NOT NULL,
    -- Exactly one of these is populated based on stop_kind:
    --   customer       → appointment_id set, dump_location_id null
    --   dump           → dump_location_id set, appointment_id null
    --   depot_return   → both null (the depot is on the route row)
    appointment_id uuid REFERENCES public.appointments(id),
    dump_location_id uuid REFERENCES public.dump_locations(id),
    estimated_arrival timestamp with time zone NOT NULL,
    -- Departures are NULL for depot_return (the driver doesn't
    -- depart anywhere after returning home).
    estimated_departure timestamp with time zone,
    actual_arrival timestamp with time zone,
    actual_departure timestamp with time zone,
    status text DEFAULT 'planned'::text NOT NULL,
    driver_notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT route_stops_kind_check
      CHECK (stop_kind = ANY (ARRAY[
        'customer'::text, 'dump'::text, 'depot_return'::text
      ])),
    CONSTRAINT route_stops_status_check
      CHECK (status = ANY (ARRAY[
        'planned'::text, 'completed'::text, 'skipped'::text
      ])),
    -- XOR enforcement: the right reference set for the kind.
    CONSTRAINT route_stops_customer_ref
      CHECK (stop_kind <> 'customer'
             OR (appointment_id IS NOT NULL AND dump_location_id IS NULL)),
    CONSTRAINT route_stops_dump_ref
      CHECK (stop_kind <> 'dump'
             OR (dump_location_id IS NOT NULL AND appointment_id IS NULL)),
    CONSTRAINT route_stops_depot_ref
      CHECK (stop_kind <> 'depot_return'
             OR (appointment_id IS NULL AND dump_location_id IS NULL)),
    CONSTRAINT route_stops_unique_sequence UNIQUE (route_id, sequence_order)
);
CREATE INDEX idx_route_stops_route ON public.route_stops (route_id, sequence_order);
CREATE INDEX idx_route_stops_appointment
  ON public.route_stops (appointment_id) WHERE appointment_id IS NOT NULL;
CREATE TRIGGER trg_route_stops_updated_at
  BEFORE UPDATE ON public.route_stops
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- Phase 1a.2 — appointments primitive.
--
-- WHY: A business's customers receive services at specific times.
-- For trash hauling that means a pickup at customer X on Tuesday at
-- 9 AM; for maintenance crews it's a service call at unit Y on
-- Wednesday at 2 PM. Both share the same shape: who, when, what
-- service, how long, current status. One row per concrete time slot.
--
-- This is the FOUNDATION primitive. Recurring schedules ("every
-- Tuesday") land in the next migration with a materializer that
-- creates appointment rows on a rolling window. The route
-- optimization engine (Phase 1a.3) reads appointment rows for a
-- given day and feeds them to vroom.
--
-- service_type is free-form text on purpose — different business
-- types have wildly different services (trash pickup, lawn mow,
-- equipment delivery, AC tune-up, plumbing visit). An enum here
-- would either be too restrictive or sprawl into hundreds of
-- categories. If we discover patterns later we can extract a
-- per-business-type catalog.
--
-- SAFE — NO BACKFILL NEEDED: table is brand new, no rows exist.

CREATE TABLE public.appointments (
    id uuid PRIMARY KEY DEFAULT public.gen_random_uuid(),
    business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
    customer_id uuid NOT NULL REFERENCES public.business_customers(id),
    -- Who created this. NULL for system-generated (the future
    -- recurring-schedule materializer cron will leave this null).
    created_by_user_id uuid REFERENCES public.users(id),
    -- Free-form service description ("Weekly trash pickup", "Lawn
    -- mowing — front yard", "Furnace inspection"). Drivers see this
    -- on their route sheet.
    service_type text NOT NULL,
    -- Scheduled time. NOT a window — the actual visit window can be
    -- looser ("between 8 AM and noon") but the route engine needs a
    -- precise anchor to optimize against. Use the START of the window
    -- here.
    scheduled_for timestamp with time zone NOT NULL,
    duration_minutes integer DEFAULT 30 NOT NULL,
    status text DEFAULT 'scheduled'::text NOT NULL,
    notes text,
    -- Audit columns stamped on state transitions.
    completed_at timestamp with time zone,
    cancelled_at timestamp with time zone,
    cancelled_reason text,
    -- Forward-link to a recurring_schedules row when the next-
    -- migration's materializer creates this appointment from a
    -- template. NULL for ad-hoc one-off appointments. (FK target
    -- lands in the next migration.)
    recurring_schedule_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT appointments_status_check
      CHECK (status = ANY (ARRAY[
        'scheduled'::text,
        'completed'::text,
        'cancelled'::text,
        'no_show'::text
      ])),
    CONSTRAINT appointments_duration_positive
      CHECK (duration_minutes > 0),
    -- Audit guards: completed/cancelled rows must carry their stamp.
    CONSTRAINT appointments_completed_audit
      CHECK (status <> 'completed' OR completed_at IS NOT NULL),
    CONSTRAINT appointments_cancelled_audit
      CHECK (status <> 'cancelled' OR cancelled_at IS NOT NULL)
);

-- Route generation reads by (business, day) so this is the load-
-- bearing index for Phase 1a.3.
CREATE INDEX idx_appointments_business_day
  ON public.appointments (business_id, scheduled_for)
  WHERE status = 'scheduled';
-- Per-customer history lookup.
CREATE INDEX idx_appointments_customer
  ON public.appointments (customer_id, scheduled_for DESC);
-- Admin view of cancelled/completed (analytics-y).
CREATE INDEX idx_appointments_status
  ON public.appointments (business_id, status, scheduled_for DESC);

CREATE TRIGGER trg_appointments_updated_at
  BEFORE UPDATE ON public.appointments
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

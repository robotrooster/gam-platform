-- Phase 1a.2 — recurring_schedules table + appointments FK.
--
-- WHY: Most service businesses run on recurring engagements — a
-- weekly trash pickup at customer X, a monthly equipment maintenance
-- at customer Y, a bi-weekly mowing at Z. The single-row-per-
-- occurrence model on `appointments` (S460) is the right shape for
-- the route engine; this table holds the TEMPLATE that materializes
-- those rows on a rolling window.
--
-- Materializer cron (services/recurringScheduleMaterializer.ts —
-- same session as this migration) walks active schedules daily,
-- parses the RFC 5545 RRULE string ("FREQ=WEEKLY;BYDAY=TU"), and
-- INSERTs appointment rows for the next 60 days. Idempotency is
-- guaranteed by the UNIQUE (recurring_schedule_id, scheduled_for)
-- index on appointments — a second materializer run on the same
-- schedule + the same occurrence date does nothing.
--
-- RRULE library: `rrule` (npm, MIT). Runs entirely in-house; no
-- external SaaS — per project_in_house_everything.md memory.
--
-- SAFE — NO BACKFILL NEEDED: table is brand new, no rows exist.

CREATE TABLE public.recurring_schedules (
    id uuid PRIMARY KEY DEFAULT public.gen_random_uuid(),
    business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
    customer_id uuid NOT NULL REFERENCES public.business_customers(id),
    created_by_user_id uuid REFERENCES public.users(id),
    -- Free-form service description; materialized appointments inherit
    -- this value as their service_type.
    service_type text NOT NULL,
    -- RFC 5545 RRULE string. Examples:
    --   FREQ=WEEKLY;BYDAY=TU       — every Tuesday
    --   FREQ=WEEKLY;BYDAY=TU,TH    — every Tuesday + Thursday
    --   FREQ=MONTHLY;BYMONTHDAY=15 — every 15th of the month
    --   FREQ=DAILY;INTERVAL=2      — every other day
    -- Stored as TEXT so any RRULE that the `rrule` library accepts
    -- works. Validation happens at the route layer (RRule.fromString)
    -- so a malformed rrule never lands in the table.
    rrule text NOT NULL,
    -- Time-of-day for each occurrence. RRULE doesn't carry time
    -- precision well; we store it separately and combine at
    -- materialization. Format: 'HH:MM' (24-hour, UTC).
    time_of_day text NOT NULL,
    -- When the recurrence starts + ends. end_date NULL = open-ended.
    -- Materializer respects both bounds when generating occurrences.
    start_date date NOT NULL,
    end_date date,
    default_duration_minutes integer DEFAULT 30 NOT NULL,
    default_notes text,
    status text DEFAULT 'active'::text NOT NULL,
    paused_at timestamp with time zone,
    paused_reason text,
    -- Last successful materializer run timestamp. The cron reads
    -- this to decide where to resume from; we still re-query the
    -- next 60 days each run for idempotency safety, but this is
    -- the observability hook for "when did this schedule last
    -- generate occurrences."
    last_materialized_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT recurring_schedules_status_check
      CHECK (status = ANY (ARRAY[
        'active'::text, 'paused'::text, 'ended'::text
      ])),
    CONSTRAINT recurring_schedules_duration_positive
      CHECK (default_duration_minutes > 0),
    CONSTRAINT recurring_schedules_time_of_day_format
      CHECK (time_of_day ~ '^[0-2][0-9]:[0-5][0-9]$'),
    CONSTRAINT recurring_schedules_end_after_start
      CHECK (end_date IS NULL OR end_date >= start_date),
    -- Paused rows must carry their stamp.
    CONSTRAINT recurring_schedules_paused_audit
      CHECK (status <> 'paused' OR paused_at IS NOT NULL)
);

CREATE INDEX idx_recurring_schedules_business
  ON public.recurring_schedules (business_id, status);
-- Materializer's load-bearing index — walks active schedules.
CREATE INDEX idx_recurring_schedules_active
  ON public.recurring_schedules (id)
  WHERE status = 'active';
-- Per-customer lookup.
CREATE INDEX idx_recurring_schedules_customer
  ON public.recurring_schedules (customer_id, status);

CREATE TRIGGER trg_recurring_schedules_updated_at
  BEFORE UPDATE ON public.recurring_schedules
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- Now wire the FK on appointments + the materializer idempotency
-- UNIQUE. The recurring_schedule_id column was added in the S460
-- appointments migration as a nullable uuid; the FK + UNIQUE land
-- here once the target table exists.

ALTER TABLE public.appointments
  ADD CONSTRAINT appointments_recurring_schedule_fk
    FOREIGN KEY (recurring_schedule_id)
    REFERENCES public.recurring_schedules(id)
    ON DELETE SET NULL;

-- Materializer idempotency: same (schedule, time) pair can only
-- produce ONE appointment row. ON CONFLICT DO NOTHING on this
-- index is how the cron stays safe under re-runs.
-- Partial — only rows that came FROM a recurring schedule are
-- subject to the uniqueness check; ad-hoc appointments don't have
-- a recurring_schedule_id and don't compete.
CREATE UNIQUE INDEX uniq_appointments_recurring_occurrence
  ON public.appointments (recurring_schedule_id, scheduled_for)
  WHERE recurring_schedule_id IS NOT NULL;

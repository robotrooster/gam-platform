-- S514 (E): GAM for Business — work-order time tracking.
--
-- A tech clocks in/out against a work order; accumulated time can then be
-- billed as a labor line (actual hours × rate) instead of an estimate.
-- Mechanic / service vertical.
--
-- One table:
--   business_work_order_time_entries — one row per clock-in→clock-out span.
--
-- Lifecycle:
--   start  → INSERT with started_at = NOW(), ended_at NULL (running).
--   stop   → set ended_at = NOW(), duration_minutes = round(span).
--   bill   → roll all unbilled (billed_at IS NULL), stopped entries into a
--            single 'labor' work_order line; stamp billed_at + billed_line_id.
-- A manual entry (tech forgot to clock) inserts an already-stopped row.
--
-- A given tech can have only ONE running entry per work order at a time
-- (partial unique index). Different techs can run concurrently on the same
-- WO (two-tech jobs).
--
-- SAFE — additive only, new table, no backfill.

CREATE TABLE public.business_work_order_time_entries (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
    work_order_id uuid NOT NULL REFERENCES public.business_work_orders(id) ON DELETE CASCADE,
    -- The tech this span belongs to.
    user_id uuid NOT NULL REFERENCES public.users(id),
    started_at timestamp with time zone NOT NULL,
    ended_at timestamp with time zone,                 -- NULL while running
    duration_minutes integer,                          -- set on stop
    note text,
    -- Billing linkage: set when this span is rolled into a labor line.
    billed_at timestamp with time zone,
    billed_line_id uuid REFERENCES public.business_work_order_lines(id) ON DELETE SET NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT business_wo_time_entries_pkey PRIMARY KEY (id),
    CONSTRAINT business_wo_time_entries_span CHECK (
      ended_at IS NULL OR ended_at >= started_at
    ),
    CONSTRAINT business_wo_time_entries_duration_nonneg CHECK (
      duration_minutes IS NULL OR duration_minutes >= 0
    ),
    -- A running row (no end) must have no duration; a stopped row must have one.
    CONSTRAINT business_wo_time_entries_running_consistency CHECK (
      (ended_at IS NULL AND duration_minutes IS NULL)
      OR (ended_at IS NOT NULL AND duration_minutes IS NOT NULL)
    )
);
CREATE INDEX idx_business_wo_time_entries_wo
  ON public.business_work_order_time_entries (work_order_id, started_at);
CREATE INDEX idx_business_wo_time_entries_business
  ON public.business_work_order_time_entries (business_id);
-- At most one running clock per (work order, tech).
CREATE UNIQUE INDEX uq_business_wo_time_entries_one_running
  ON public.business_work_order_time_entries (work_order_id, user_id)
  WHERE ended_at IS NULL;

CREATE TRIGGER trg_business_wo_time_entries_updated_at
  BEFORE UPDATE ON public.business_work_order_time_entries
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

COMMENT ON TABLE public.business_work_order_time_entries IS
  'S514 work-order labor time tracking. Tech clock-in/out spans; unbilled stopped spans roll into a labor line via the /time/bill endpoint.';

-- S511 — recurring + route-aware self-booking (walkthrough Business #8 follow-up).
--
-- WHY: a customer booking a "Weekly trash pickup" on the public page got a single
-- one-off appointment, never landing on a recurring schedule. Service businesses
-- are mostly recurring, so a bookable service now carries an owner-set cadence and
-- (for recurring) an owner-fixed day of week. On booking, a recurring service
-- enrolls the customer into recurring_schedules (the materializer then generates
-- the ongoing appointments); a one-time service still creates a single appointment.
--
-- Day-not-time model (Nic): for route-based businesses the customer never picks a
-- time — the route optimizer sets it. The owner fixes the recurring day per service.
--
-- No backfill needed: existing services default to 'one_time' (current behavior).

ALTER TABLE public.business_bookable_services
  ADD COLUMN recurrence            text NOT NULL DEFAULT 'one_time',
  ADD COLUMN recurrence_day_of_week integer;

ALTER TABLE public.business_bookable_services
  ADD CONSTRAINT business_bookable_services_recurrence_check
    CHECK (recurrence IN ('one_time', 'weekly', 'biweekly', 'monthly')),
  ADD CONSTRAINT business_bookable_services_recurrence_dow_range
    CHECK (recurrence_day_of_week IS NULL
           OR (recurrence_day_of_week >= 0 AND recurrence_day_of_week <= 6)),
  -- Recurring services fix a day of week; one-time services don't.
  ADD CONSTRAINT business_bookable_services_recurrence_pairing
    CHECK ((recurrence = 'one_time' AND recurrence_day_of_week IS NULL)
           OR (recurrence <> 'one_time' AND recurrence_day_of_week IS NOT NULL));

COMMENT ON COLUMN public.business_bookable_services.recurrence IS
  'S511 booking cadence: one_time (single appointment) | weekly | biweekly | monthly (every 4 weeks). Recurring services enroll the customer into recurring_schedules at booking.';
COMMENT ON COLUMN public.business_bookable_services.recurrence_day_of_week IS
  'S511 owner-fixed day for recurring services (0=Sun..6=Sat). NULL for one_time.';

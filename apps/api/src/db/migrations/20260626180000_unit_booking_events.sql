-- S517 / Walkthrough #10 (Master Schedule): booking change-history log.
--
-- WHY (Nic 2026-06-26): STR reservations are drag-adjustable on the Master
-- Schedule; the landlord needs an audit trail of every change — created,
-- moved to another unit, dates changed (a day added/removed), status changed,
-- cancelled — so site adjustments are reviewable.

CREATE TABLE unit_booking_events (
    id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    booking_id    uuid REFERENCES unit_bookings(id) ON DELETE SET NULL,
    unit_id       uuid NOT NULL REFERENCES units(id) ON DELETE CASCADE,
    landlord_id   uuid NOT NULL REFERENCES landlords(id) ON DELETE CASCADE,

    event_type    text NOT NULL,
    summary       text NOT NULL,        -- human-readable one-liner for the log
    detail        jsonb NOT NULL DEFAULT '{}'::jsonb,   -- structured before/after
    actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,

    created_at    timestamp with time zone NOT NULL DEFAULT now(),

    CONSTRAINT unit_booking_events_type_check
      CHECK (event_type = ANY (ARRAY['created','moved','dates_changed','status_changed','cancelled']))
);

CREATE INDEX idx_unit_booking_events_landlord ON unit_booking_events(landlord_id, created_at DESC);
CREATE INDEX idx_unit_booking_events_unit     ON unit_booking_events(unit_id, created_at DESC);
CREATE INDEX idx_unit_booking_events_booking  ON unit_booking_events(booking_id);

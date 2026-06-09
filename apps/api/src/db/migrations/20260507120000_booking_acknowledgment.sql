-- S179 / B3: per-property booking acknowledgment toggle.
--
-- Locked at S177 product walkthrough: each property gets a
-- requires_booking_acknowledgment boolean. When ON, every booking on
-- that property requires an acknowledgment of the property rules
-- before the stay is considered fully confirmed. Default OFF — most
-- residential / long-term rentals don't need it; RV-park / short-term
-- operators flip it on.
--
-- Schema-only this migration: column on properties, column on
-- unit_bookings to record signature timestamp. Backend acknowledge
-- endpoint + landlord UI toggle ship in the same session against
-- these columns. Surface UI (badging / sign flow) is a follow-on.
--
-- No backfill needed: default false on properties, default null on
-- unit_bookings.acknowledgment_signed_at.

ALTER TABLE public.properties
  ADD COLUMN requires_booking_acknowledgment boolean NOT NULL DEFAULT false;

ALTER TABLE public.unit_bookings
  ADD COLUMN acknowledgment_signed_at timestamp with time zone;

COMMENT ON COLUMN public.properties.requires_booking_acknowledgment IS
  'When true, bookings on this property require landlord/staff to mark acknowledged after collecting signature on property-rules doc.';

COMMENT ON COLUMN public.unit_bookings.acknowledgment_signed_at IS
  'Stamped via PATCH /units/:id/bookings/:bookingId/acknowledge once landlord/staff confirms guest signed the property rules. NULL while pending.';

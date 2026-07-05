-- W-44 (final walkthrough, S531, Nic): tenant-booked PRIVATE EVENTS on
-- common areas, with landlord-chosen posture per area:
--   • events_enabled        — the area can host tenant private events at all
--   • event_deposit_amount  — NON-REFUNDABLE deposit required to lock the
--                             event in (0 = none; announcement then fires at
--                             approval instead of at payment)
--   • event_announce        — when the deposit is paid (or at approval when
--                             no deposit), a mass message announces the
--                             private event to everyone at the property
--   • event_auto_release    — unpaid by the event start time → the space
--                             automatically becomes NOT private again
-- Defaults keep every existing area exactly as it behaves today
-- (events off). No backfill needed.

ALTER TABLE common_areas
  ADD COLUMN events_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN event_deposit_amount numeric(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN event_announce boolean NOT NULL DEFAULT true,
  ADD COLUMN event_auto_release boolean NOT NULL DEFAULT true;

-- S518 / Master Schedule: property-wide waitlist entries.
--
-- WHY (Nic 2026-06-27): when a requested date range overlaps EVERY unit at a
-- property, the guest is auto-added to a waitlist for the property (any unit),
-- not a single unit. So unit_id becomes nullable — NULL means "any unit at
-- this property". When any unit frees, the promotion sweep can claim a
-- property-wide waiter for that unit.

ALTER TABLE unit_booking_waitlists
  ALTER COLUMN unit_id DROP NOT NULL;

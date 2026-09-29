-- S652 (Nic): a property that bills each tenant on their own date — "they let
-- their due date be whenever they come in" — onboards with residents who are
-- ALREADY on those dates. An onboarding resident's GAM start date is not the
-- day they moved in, so the lease cannot work the due day out for itself; it
-- fell back to the property's fixed day and the landlord had to retype every
-- tenant's day on every lease.
--
-- The landlord knows the day when they invite the household. It is asked for
-- there and carried on the intent, the same way work trade and the home sale
-- are, and the drafted lease takes it.
--
-- No backfill needed: NULL means "not stated", which is every invite before
-- today, and those keep the property's rule exactly as they did.
ALTER TABLE pending_tenant_intents
  ADD COLUMN rent_due_day integer,
  ADD CONSTRAINT pending_tenant_intents_rent_due_day_range
    CHECK (rent_due_day IS NULL OR (rent_due_day >= 1 AND rent_due_day <= 28));

COMMENT ON COLUMN pending_tenant_intents.rent_due_day IS
  'S652: the day of the month this household''s rent is due, stated on the invite. NULL = follow the property''s rule. Same 1-28 range as leases.rent_due_day.';

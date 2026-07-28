-- S558 (Nic): per-unit occupancy mode — the distinguishing factor that lets a
-- landlord STACK independent leases on one unit (by-the-room: dorms, college
-- towns) while defaulting to a safeguard that prevents accidental double-leasing.
--
--   whole_unit (DEFAULT, safeguard): one active lease at a time. Multiple people
--     are CO-TENANTS on that single lease. A second lease is blocked as today.
--   by_room: multiple INDEPENDENT leases allowed on the unit, each tenant on
--     their own contract responsible only for their portion. HARD CAP =
--     2 × bedrooms leases (Nic: 2 people per bedroom). Must be opted into per
--     unit, so stacking is always deliberate.
--
-- No backfill: every existing unit is whole_unit (the safe default) — nothing
-- was stacking before this.
ALTER TABLE public.units
  ADD COLUMN occupancy_mode text NOT NULL DEFAULT 'whole_unit'
  CONSTRAINT units_occupancy_mode_check CHECK (occupancy_mode = ANY (ARRAY['whole_unit'::text, 'by_room'::text]));

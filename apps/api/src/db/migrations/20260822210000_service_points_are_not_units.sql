-- S616 (Nic) — a space that exists only to carry somebody's utility bill.
--
--   "We need a way for a landlord to add units that don't count as units, or
--    that don't act as traditional units in the rest of the system... the unit
--    we create is to place the utility bills in under somebody's name. That's
--    how they get access to the tenant portal. The unit is not rentable. The
--    unit is not bookable. It doesn't show as vacant or owner occupied. It's
--    just something to link the utilities as a pass through to the person who's
--    using them. All that unit count and stuff goes away and merges into the
--    actual unit when the other landlord onboards."
--
-- status='utility_service' has meant this since S614, but every count in the
-- platform had to be taught separately and I was finding them one at a time —
-- occupancy, portfolio totals, the rent roll, the RUBS basis. This closes the
-- structural hole rather than the next instance of it.
--
-- v_unit_occupancy is what most of the platform asks "is this unit occupied,
-- and by whom". It derives occupancy from an ACTIVE LEASE, and a service point
-- has none — so it appeared in the view as a unit that is NOT occupied, i.e. as
-- a VACANCY. A neighbour's building was counting against this landlord's
-- vacancy rate.
--
-- Excluding the row entirely is both correct and safe: the 30-odd consumers are
-- almost all LEFT JOINs that already received nulls for these rows, so they see
-- no change. The ones that COUNT are exactly the ones that were wrong.
CREATE OR REPLACE VIEW v_unit_occupancy AS
 SELECT u.id AS unit_id,
    primary_info.tenant_id IS NOT NULL AS is_occupied,
    primary_info.tenant_id AS primary_tenant_id,
    primary_info.first_name AS primary_first_name,
    primary_info.last_name AS primary_last_name,
    primary_info.email AS primary_email,
    primary_info.phone AS primary_phone,
    primary_info.lease_id AS active_lease_id,
    COALESCE(counts.tenant_count, 0) AS tenant_count
   FROM units u
     LEFT JOIN LATERAL ( SELECT t.id AS tenant_id,
            us.first_name,
            us.last_name,
            us.email,
            us.phone,
            l.id AS lease_id
           FROM leases l
             JOIN lease_tenants lt ON lt.lease_id = l.id
             JOIN tenants t ON t.id = lt.tenant_id
             JOIN users us ON us.id = t.user_id
          WHERE l.unit_id = u.id AND l.status = 'active'::text AND lt.status = 'active'::text AND lt.role = 'primary'::text
         LIMIT 1) primary_info ON true
     LEFT JOIN LATERAL ( SELECT count(*)::integer AS tenant_count
           FROM leases l
             JOIN lease_tenants lt ON lt.lease_id = l.id
          WHERE l.unit_id = u.id AND l.status = 'active'::text AND lt.status = 'active'::text) counts ON true
  -- S616: a service point is not a unit whose occupancy anyone should reason
  -- about. It is somebody else's building.
  WHERE u.status <> 'utility_service';

COMMENT ON VIEW v_unit_occupancy IS
  'Occupancy per RENTABLE unit. S616: service points (status=''utility_service'') '
  'are excluded — they exist only to carry a neighbour''s utility bill under a '
  'payer''s name, are never rentable or bookable, and are neither occupied nor '
  'vacant.';

-- S649 (Nic): "we need a way to mark RV sites out of order... I want the
-- compression and expansion to be able to detect out of order sites and not
-- push something in there."
--
-- A window during which a site can't be occupied: from starts_on, until ends_on
-- (exclusive — the day it's back) or open-ended until someone clears it. Every
-- availability path treats an overlapping window like a lease: the schedule
-- compressor, the best-fit ranker, the public booking site, staff bookings and
-- the unit picker, all through unit_out_of_order_overlaps() so they cannot
-- disagree. Clearing keeps the row (cleared_at) — the history stays.
CREATE TABLE unit_out_of_order (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_id     uuid NOT NULL REFERENCES units(id),
  landlord_id uuid NOT NULL REFERENCES landlords(id),
  starts_on   date NOT NULL DEFAULT CURRENT_DATE,
  ends_on     date,
  reason      text,
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  cleared_at  timestamptz,
  cleared_by  uuid REFERENCES users(id),
  CONSTRAINT unit_out_of_order_window CHECK (ends_on IS NULL OR ends_on > starts_on)
);
CREATE INDEX idx_unit_out_of_order_open ON unit_out_of_order (unit_id) WHERE cleared_at IS NULL;

-- Is this site out of order at any point in [from, to)? to NULL = open-ended.
CREATE FUNCTION unit_out_of_order_overlaps(p_unit uuid, p_from date, p_to date)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM unit_out_of_order o
     WHERE o.unit_id = p_unit AND o.cleared_at IS NULL
       AND (p_to IS NULL OR o.starts_on < p_to)
       AND (o.ends_on IS NULL OR o.ends_on > p_from))
$$;

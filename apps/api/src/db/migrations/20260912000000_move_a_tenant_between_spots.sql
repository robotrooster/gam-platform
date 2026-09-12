-- S641 (Nic) — a resident moves spots WITHOUT ending their tenancy.
--
--   "Moving sites at an RV park is very common, especially when somebody with a
--    nice shade tree leaves and somebody else wants to take that spot. I don't
--    wanna have to terminate their lease, send them a new lease for the new
--    spot, etcetera. I want to just be able to move them in the system and say,
--    as of this date, they moved from this spot to this spot, have it coordinate
--    utilities for both."
--
-- Also the case where the park forces it: "maybe a site breaks, electricity
-- goes down, we're gonna have to dig it up and put a new pedestal in."
--
-- `leases.unit_id` is a single column, so moving somebody rewrote which space
-- the whole tenancy had always been in — the same class of problem as renaming
-- a unit, and the same shape of answer: keep the periods.
CREATE TABLE IF NOT EXISTS lease_unit_history (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lease_id    uuid NOT NULL REFERENCES leases(id) ON DELETE CASCADE,
  unit_id     uuid NOT NULL REFERENCES units(id) ON DELETE RESTRICT,
  -- Half-open [effective_from, effective_to). The live row has a NULL end.
  effective_from date NOT NULL,
  effective_to   date,
  reason      text,
  moved_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lease_unit_history_lease
  ON lease_unit_history (lease_id, effective_from DESC);
CREATE INDEX IF NOT EXISTS idx_lease_unit_history_unit
  ON lease_unit_history (unit_id, effective_from);

-- Exactly one open period per lease: the space they are in right now.
CREATE UNIQUE INDEX IF NOT EXISTS ux_lease_unit_history_current
  ON lease_unit_history (lease_id) WHERE effective_to IS NULL;

-- ── Maintained by a trigger, so no call site can skip it ───────────────────
CREATE OR REPLACE FUNCTION fn_lease_unit_history() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO lease_unit_history (lease_id, unit_id, effective_from)
    VALUES (NEW.id, NEW.unit_id, NEW.start_date);
    RETURN NEW;
  END IF;

  IF NEW.unit_id IS DISTINCT FROM OLD.unit_id THEN
    -- The move date is carried on the lease row by the move endpoint; a bare
    -- UPDATE with no date falls back to today, which is the honest default for
    -- somebody correcting a mistake rather than recording a move.
    UPDATE lease_unit_history
       SET effective_to = COALESCE(NEW.unit_moved_on, CURRENT_DATE)
     WHERE lease_id = NEW.id AND effective_to IS NULL;
    INSERT INTO lease_unit_history (lease_id, unit_id, effective_from)
    VALUES (NEW.id, NEW.unit_id, COALESCE(NEW.unit_moved_on, CURRENT_DATE));
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Scratch column the endpoint sets in the same UPDATE, so the trigger knows the
-- effective date without a second round trip.
ALTER TABLE leases ADD COLUMN IF NOT EXISTS unit_moved_on date;

DROP TRIGGER IF EXISTS trg_lease_unit_history_ins ON leases;
CREATE TRIGGER trg_lease_unit_history_ins
  AFTER INSERT ON leases
  FOR EACH ROW EXECUTE FUNCTION fn_lease_unit_history();

DROP TRIGGER IF EXISTS trg_lease_unit_history_upd ON leases;
CREATE TRIGGER trg_lease_unit_history_upd
  AFTER UPDATE OF unit_id ON leases
  FOR EACH ROW EXECUTE FUNCTION fn_lease_unit_history();

-- Seed the opening period for every lease that already exists.
INSERT INTO lease_unit_history (lease_id, unit_id, effective_from)
SELECT l.id, l.unit_id, l.start_date
  FROM leases l
 WHERE NOT EXISTS (SELECT 1 FROM lease_unit_history h WHERE h.lease_id = l.id);

-- ── Which spaces did this lease occupy during a billing window? ────────────
--
-- The point of the whole thing. A mid-month move returns TWO rows, each with
-- the slice of the window it covers, so utilities bill from the right meter for
-- the right days and the resident sees "electric from RV 12" and "electric from
-- RV 23" instead of one blended figure.
CREATE OR REPLACE FUNCTION lease_units_in_window(
  p_lease_id uuid, p_from date, p_to date
) RETURNS TABLE (unit_id uuid, from_date date, to_date date) AS $$
  SELECT h.unit_id,
         GREATEST(h.effective_from, p_from) AS from_date,
         LEAST(COALESCE(h.effective_to, p_to), p_to) AS to_date
    FROM lease_unit_history h
   WHERE h.lease_id = p_lease_id
     AND h.effective_from <= p_to
     AND (h.effective_to IS NULL OR h.effective_to > p_from)
   ORDER BY h.effective_from
$$ LANGUAGE sql STABLE;

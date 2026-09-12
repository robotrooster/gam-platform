-- S641 (Nic) — a unit keeps its history of numbers instead of being replaced.
--
--   "I don't know why we're retiring units and replacing… would we just say
--    that we're changing the unit number in the system, as long as it doesn't
--    overlap with other ones — like, show a timeline of: this was classified as
--    unit one up until this date, and it's been since changed to unit number
--    two."
--
-- That is a better answer than retire-and-replace for the case that actually
-- happens. The problem retire-and-replace was solving is real: NOTHING stores
-- the unit number on a record. Invoices, payments and bookings point at the
-- unit's id and render whatever the number says now, so renaming MH 5 to MH 12
-- retroactively rewrites three years of paperwork — while the signed lease PDF
-- still says MH 5 and silently disagrees.
--
-- A timeline fixes that without splitting one physical space into two database
-- rows: the number that was current on a record's own date is knowable, so
-- March's invoice can say what March said.
--
-- Retire-and-replace still belongs where the space genuinely BECOMES a
-- different space — a double lot split in two, two apartments knocked together.
-- That is rare, and it is not renumbering. The two were conflated.
CREATE TABLE IF NOT EXISTS unit_number_history (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_id      uuid NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  unit_number  text NOT NULL,
  building     text,
  -- Half-open [effective_from, effective_to). The live row has a NULL end.
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to   timestamptz,
  changed_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  reason       text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_unit_number_history_unit
  ON unit_number_history (unit_id, effective_from DESC);

-- Exactly one open period per unit: the number it is called right now.
CREATE UNIQUE INDEX IF NOT EXISTS ux_unit_number_history_current
  ON unit_number_history (unit_id) WHERE effective_to IS NULL;

-- ── Maintained by a trigger, never by call sites ───────────────────────────
--
-- There are ~120 places that touch units. Enforcing this in the database means
-- a rename recorded by an importer, a script or a route nobody has written yet
-- still lands in the timeline.
CREATE OR REPLACE FUNCTION fn_unit_number_history() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO unit_number_history (unit_id, unit_number, building, effective_from)
    VALUES (NEW.id, NEW.unit_number, NEW.building, COALESCE(NEW.created_at, now()));
    RETURN NEW;
  END IF;

  -- Only a real change of identity opens a new period.
  IF NEW.unit_number IS DISTINCT FROM OLD.unit_number
     OR NEW.building IS DISTINCT FROM OLD.building THEN
    UPDATE unit_number_history
       SET effective_to = now()
     WHERE unit_id = NEW.id AND effective_to IS NULL;
    INSERT INTO unit_number_history (unit_id, unit_number, building, effective_from)
    VALUES (NEW.id, NEW.unit_number, NEW.building, now());
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_unit_number_history_ins ON units;
CREATE TRIGGER trg_unit_number_history_ins
  AFTER INSERT ON units
  FOR EACH ROW EXECUTE FUNCTION fn_unit_number_history();

DROP TRIGGER IF EXISTS trg_unit_number_history_upd ON units;
CREATE TRIGGER trg_unit_number_history_upd
  AFTER UPDATE OF unit_number, building ON units
  FOR EACH ROW EXECUTE FUNCTION fn_unit_number_history();

-- Seed the opening period for every unit that already exists, so a unit created
-- before today still has a readable timeline rather than starting blank.
INSERT INTO unit_number_history (unit_id, unit_number, building, effective_from)
SELECT u.id, u.unit_number, u.building, COALESCE(u.created_at, now())
  FROM units u
 WHERE NOT EXISTS (SELECT 1 FROM unit_number_history h WHERE h.unit_id = u.id);

-- ── What was this space called on a given date? ────────────────────────────
--
-- The whole point: an invoice from March renders the number that was current in
-- March, rather than today's.
CREATE OR REPLACE FUNCTION unit_number_on(p_unit_id uuid, p_when timestamptz)
RETURNS text AS $$
  SELECT h.unit_number
    FROM unit_number_history h
   WHERE h.unit_id = p_unit_id
     AND h.effective_from <= p_when
     AND (h.effective_to IS NULL OR h.effective_to > p_when)
   ORDER BY h.effective_from DESC
   LIMIT 1
$$ LANGUAGE sql STABLE;

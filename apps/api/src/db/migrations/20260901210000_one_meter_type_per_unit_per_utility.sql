-- S634 (Nic, DIRECTIVE): "The same unit cannot have two meter types for the same
-- utility. It can't be part of one RUBS system and one submeter system. It could
-- be one in one for separate utilities, but not for the same utility."
--
-- WHY THIS IS A RULE AND NOT A PREFERENCE. Until now a unit could sit on a RUBS
-- master AND carry its own submeter of the same utility, and S558 leaned on that
-- deliberately: assign every unit the master feeds, and the submetered ones "fall
-- out" of the split automatically. That design is what S634 replaces. With the
-- RUBS pool now the WHOLE master bill (see services/utilityBilling.ts), a unit on
-- both meters is genuinely ambiguous — it is either eating a share of the master
-- or billing its own gallons, and there is no reading of "both" that produces a
-- defensible tenant bill. The ambiguity has to be impossible, not merely handled.
--
-- The second shape this forbids is subtler and was live at Oak Park: TWO
-- submeters of the same utility on one unit. MH 03 through MH 09 each had a
-- 7-digit water submeter created 2026-08-18 carrying the real field reads, and a
-- duplicate 6-digit one created 2026-08-28 with no readings at all. Nothing
-- warned anybody. Whichever one a query happened to reach decided the bill.
--
-- ENFORCED IN THE DATABASE, NOT AT THE CALL SITES. The link table carries no
-- utility_type of its own (it lives on utility_meters), so a plain UNIQUE index
-- cannot express this. A trigger can, and it holds for every path — the meter
-- routes, a seed script, a hand-run INSERT during a support call — which auditing
-- call sites never does.
--
-- BACKFILL: REQUIRED, and done below. No meter is deleted — GAM does not erase.
-- The offending rows are UNLINKED from the unit; the meter itself, its readings
-- and its history all stay exactly where they are and can be re-linked.

-- 1. A submetered unit is not also on a master of the same utility. The submeter
--    is the meter that measures that unit, so the master link is the wrong one.
DELETE FROM utility_meter_units mu
 USING utility_meters m
 WHERE m.id = mu.meter_id
   AND m.billing_method IN ('rubs', 'master')
   AND EXISTS (
     SELECT 1 FROM utility_meter_units mu2
       JOIN utility_meters m2 ON m2.id = mu2.meter_id
      WHERE mu2.unit_id = mu.unit_id
        AND m2.utility_type = m.utility_type
        AND m2.billing_method = 'submeter');

-- 2. Of two same-utility submeters on one unit, keep the one that has actually
--    been read (most readings, then oldest — the meter that has been in service).
--    A tie keeps the older record. The loser is unlinked, not dropped.
DELETE FROM utility_meter_units mu
 USING utility_meters m
 WHERE m.id = mu.meter_id
   AND EXISTS (
     SELECT 1 FROM utility_meter_units mu2
       JOIN utility_meters m2 ON m2.id = mu2.meter_id
      WHERE mu2.unit_id = mu.unit_id
        AND m2.utility_type = m.utility_type
        AND m2.id <> m.id
        AND (
          -- m2 beats m: more readings, else in service longer, else lower id
          -- (deterministic, so a re-run of this migration is a no-op).
          (SELECT count(*) FROM utility_meter_readings r WHERE r.meter_id = m2.id)
            > (SELECT count(*) FROM utility_meter_readings r WHERE r.meter_id = m.id)
          OR ((SELECT count(*) FROM utility_meter_readings r WHERE r.meter_id = m2.id)
                = (SELECT count(*) FROM utility_meter_readings r WHERE r.meter_id = m.id)
              AND (m2.created_at < m.created_at
                   OR (m2.created_at = m.created_at AND m2.id < m.id)))));

CREATE OR REPLACE FUNCTION enforce_one_meter_per_unit_utility() RETURNS trigger AS $$
DECLARE
  v_utility text;
  v_conflict text;
BEGIN
  SELECT utility_type INTO v_utility FROM utility_meters WHERE id = NEW.meter_id;
  SELECT m.label INTO v_conflict
    FROM utility_meter_units mu
    JOIN utility_meters m ON m.id = mu.meter_id
   WHERE mu.unit_id = NEW.unit_id
     AND m.id <> NEW.meter_id
     AND m.utility_type = v_utility
   LIMIT 1;
  IF v_conflict IS NOT NULL THEN
    RAISE EXCEPTION
      'This unit is already on the % meter "%". A unit can only be on one % meter — remove it from that one first.',
      v_utility, v_conflict, v_utility
      USING ERRCODE = 'unique_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_one_meter_per_unit_utility ON utility_meter_units;
CREATE TRIGGER trg_one_meter_per_unit_utility
  BEFORE INSERT OR UPDATE ON utility_meter_units
  FOR EACH ROW EXECUTE FUNCTION enforce_one_meter_per_unit_utility();

-- The same rule from the other direction: retyping a meter's utility must not
-- create the collision that the link-side trigger just refused.
CREATE OR REPLACE FUNCTION enforce_meter_utility_retype() RETURNS trigger AS $$
DECLARE
  v_unit text;
BEGIN
  IF NEW.utility_type IS DISTINCT FROM OLD.utility_type THEN
    SELECT u.unit_number INTO v_unit
      FROM utility_meter_units mu
      JOIN units u ON u.id = mu.unit_id
     WHERE mu.meter_id = NEW.id
       AND EXISTS (
         SELECT 1 FROM utility_meter_units mu2
           JOIN utility_meters m2 ON m2.id = mu2.meter_id
          WHERE mu2.unit_id = mu.unit_id
            AND m2.id <> NEW.id
            AND m2.utility_type = NEW.utility_type)
     LIMIT 1;
    IF v_unit IS NOT NULL THEN
      RAISE EXCEPTION
        'Unit % is already on another % meter. Changing this meter to % would put that unit on two.',
        v_unit, NEW.utility_type, NEW.utility_type
        USING ERRCODE = 'unique_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_meter_utility_retype ON utility_meters;
CREATE TRIGGER trg_meter_utility_retype
  BEFORE UPDATE ON utility_meters
  FOR EACH ROW EXECUTE FUNCTION enforce_meter_utility_retype();

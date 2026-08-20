-- S613 (Nic, DIRECTIVE): "when there is a subtype set, the unit that has that
-- subtype — ALL units with that subtype have to be the same price, because it's
-- set at the subtype level if one exists. If one doesn't exist, then it can be
-- a different price."
--
-- 20260820170000 made a class's price REACH its units when the class is edited.
-- That is only half the rule: nothing stopped a unit inside a class being
-- repriced on its own afterwards, and two already had — Apt 202 and Apt 204 sat
-- in "2BR Standard" at $1,295 and $1,195 against the class's $1,150.
--
-- Enforced in the DATABASE rather than in the route that happens to be the
-- polite one. Units are written from several doors — Add Unit, onboarding, the
-- importer, retire-and-replace, seeds — and a rule enforced in one of them holds
-- only until someone uses another. This is the same reasoning as the unit
-- retire/replace triggers.
--
-- It COERCES rather than raising: a caller that sends a price for a classed unit
-- gets the class's price, not an error, so no existing writer breaks. The
-- landlord-facing refusal (with the reason, and the offer to take the unit out
-- of the subtype) lives in the API where a person can read it.
--
-- Retired units are exempt: a retired record keeps the numbers it was retired
-- with, the same posture as every other rule about retired units.

CREATE OR REPLACE FUNCTION enforce_subtype_pricing() RETURNS trigger AS $$
DECLARE s RECORD;
BEGIN
  IF NEW.subtype_id IS NULL OR NEW.retired_at IS NOT NULL THEN
    RETURN NEW;
  END IF;
  SELECT rent_amount, security_deposit, nightly_rate, weekly_rate, monthly_rate
    INTO s FROM property_unit_subtypes WHERE id = NEW.subtype_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  -- rent_amount is NOT NULL on units: a class with no rent set leaves the unit's
  -- own number rather than failing the write.
  NEW.rent_amount      := COALESCE(s.rent_amount, NEW.rent_amount);
  NEW.security_deposit := COALESCE(s.security_deposit, 0);
  NEW.nightly_rate     := s.nightly_rate;
  NEW.weekly_rate      := s.weekly_rate;
  NEW.monthly_rate     := s.monthly_rate;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_enforce_subtype_pricing ON units;
CREATE TRIGGER trg_enforce_subtype_pricing
  BEFORE INSERT OR UPDATE ON units
  FOR EACH ROW EXECUTE FUNCTION enforce_subtype_pricing();

-- Bring the two drifted units onto their class. This CHANGES two asking prices
-- (both on the demo "Oak Street Apartments", not Oak Park) — no tenant's bill
-- moves, because a tenant is billed from leases.rent_amount and the lease is law.
UPDATE units u
   SET rent_amount      = COALESCE(s.rent_amount, u.rent_amount),
       security_deposit = COALESCE(s.security_deposit, 0),
       nightly_rate     = s.nightly_rate,
       weekly_rate      = s.weekly_rate,
       monthly_rate     = s.monthly_rate,
       updated_at       = NOW()
  FROM property_unit_subtypes s
 WHERE s.id = u.subtype_id AND u.retired_at IS NULL
   AND (u.rent_amount      IS DISTINCT FROM COALESCE(s.rent_amount, u.rent_amount)
     OR u.security_deposit IS DISTINCT FROM COALESCE(s.security_deposit, 0)
     OR u.nightly_rate     IS DISTINCT FROM s.nightly_rate
     OR u.weekly_rate      IS DISTINCT FROM s.weekly_rate
     OR u.monthly_rate     IS DISTINCT FROM s.monthly_rate);

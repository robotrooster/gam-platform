-- S613 (Nic): "Say one household at Oak Park uses a lot of trash and they
-- actually have a second can. Is there a way to toggle can count times the
-- property rate for their bill? I think one person has that right now, but
-- that's gonna be a deal blocker if we don't have that accounted for."
--
-- A flat charge could only ever bill a unit ONCE, so a two-can household paid
-- the same $25 as a one-can household and the park ate the second can.
--
-- THIS DOES NOT REOPEN THE PRICE. The S609 anti-discrimination rule stands: the
-- AMOUNT lives on the property and is the same for everyone. What changes is HOW
-- MANY of the service a unit receives, which is a different fact entirely —
-- everyone pays $25 a can, and a household with two cans pays for two cans.
-- Price per unit of service identical, quantity honest. That distinction is
-- exactly what keeps "two identical units billed differently" impossible while
-- letting a park bill what it actually hauls.
--
-- Lives on the ASSIGNMENT (utility_meter_units), not the unit and not the meter:
-- it is a fact about this unit's relationship to this service, and a unit could
-- have two trash cans and one of something else.
ALTER TABLE utility_meter_units
  ADD COLUMN IF NOT EXISTS quantity integer NOT NULL DEFAULT 1
    CHECK (quantity >= 1 AND quantity <= 99);

COMMENT ON COLUMN utility_meter_units.quantity IS
  'S613: how many of this service the unit receives (e.g. 2 trash cans). '
  'Multiplies a FLAT-RATE charge only — metered and RUBS meters ignore it, '
  'since usage already reflects how much a unit used.';

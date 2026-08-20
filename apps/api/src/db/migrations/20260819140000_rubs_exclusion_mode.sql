-- S607 (Nic, DIRECTIVE): how a master carves out its submetered units is a
-- CHOICE, not a rule.
--
-- Nic: "I wanted the pool subtracts dollars from the submeter invoices as an
-- OPTION, not as the standard. We're going for flexibility here, and I think
-- you keep forgetting that."
--
-- Correct — the previous migration made dollar-subtraction universal, which
-- silently changed the carve-out for every master that would ever use the
-- bill_amount basis. Both carve-outs are in common use and neither is wrong:
--
--   'usage' (DEFAULT, and the behaviour that already existed)
--       pool = (master usage − submetered usage) priced at the master's rate.
--       The classic RUBS carve-out: measure what the submetered units drew,
--       take it off the top, price whatever is left. Everyone on the line ends
--       up at the same effective cost per unit.
--
--   'dollars'
--       pool = the bill − the dollars those submetered units were actually
--       invoiced for consumption. What Nic wants at Oak Park: the mobile homes
--       pay a published penny a gallon, and whatever that leaves of the real
--       bill is what the spaces divide. Closes exactly no matter what rate the
--       submetered units were billed at, because it subtracts the invoices
--       themselves rather than re-deriving them.
--
-- The two are IDENTICAL whenever the submetered units bill at the master's
-- blended rate. They diverge precisely when the landlord publishes a separate
-- submeter rate (rubs_submeter_rate = 'property_rate'), which is the case that
-- motivated the option.
--
-- Only meaningful on the bill_amount basis — a usage_rate master has no bill
-- total to subtract dollars from, so it always carves out by usage regardless.
--
-- No backfill: the default reproduces existing behaviour exactly.

ALTER TABLE utility_meters
  ADD COLUMN IF NOT EXISTS rubs_exclusion_mode text NOT NULL DEFAULT 'usage';

ALTER TABLE utility_meters
  DROP CONSTRAINT IF EXISTS utility_meters_rubs_exclusion_mode_check;
ALTER TABLE utility_meters
  ADD CONSTRAINT utility_meters_rubs_exclusion_mode_check
  CHECK (rubs_exclusion_mode = ANY (ARRAY['usage'::text, 'dollars'::text]));

COMMENT ON COLUMN utility_meters.rubs_exclusion_mode IS
  'S607: how a RUBS master removes its submetered units from the pool. usage (default) = subtract their measured usage, then price the remainder. dollars = subtract the dollars they were actually invoiced, so the bill closes at any submeter rate. Only meaningful when rubs_basis = bill_amount.';

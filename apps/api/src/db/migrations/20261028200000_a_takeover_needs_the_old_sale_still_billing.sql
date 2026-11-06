-- 10/28 — ONE LIVE SALE PER UNIT, EXCEPT THE PAIR A TAKEOVER IS MADE OF.
--
-- home_sale_contracts_one_live_per_unit allowed a single contract per unit in
-- either live state (pending_signature or active). That is right for every
-- ordinary sale and it makes the takeover impossible to build:
--
--   • the old contract must stay ACTIVE, because the resident on it keeps being
--     billed until the new resident actually signs (Nic: "it just supersedes
--     the old one AFTER signature"), and
--   • the new contract exists as PENDING_SIGNATURE from the moment the landlord
--     signs the packet, because it is built from the terms he typed there.
--
-- So the rule becomes one live contract per unit PER STATE: still never two
-- billing at once, still never two awaiting signature, and the one combination
-- a handover needs is allowed. What stops an unrelated second sale from using
-- that gap is the route (routes/esign.ts): a second installment document on a
-- home already billing is refused unless that document names the very contract
-- it supersedes.
--
-- A pending contract bills nothing (every billing query keys on status =
-- 'active'), so the pair cannot double-charge anybody.

DROP INDEX IF EXISTS home_sale_contracts_one_live_per_unit;

CREATE UNIQUE INDEX IF NOT EXISTS home_sale_contracts_one_live_per_unit_state
  ON home_sale_contracts (unit_id, status)
  WHERE status IN ('pending_signature', 'active');

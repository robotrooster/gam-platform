-- S609 (Nic, DIRECTIVE): the audit record for utility cost a landlord absorbed
-- on their OWN occupied units.
--
-- Nic: "Any share that you were talking about for the owner occupied units
-- that's getting subtracted from the pool? We need that as a line item on a
-- specific utility cost that's owner use that is not passed through. That way,
-- if there's ever an audit, the landlord can provide, hey, these utilities were
-- not factored into being billed back to people."
--
-- Exactly right, and it is the difference between a defensible RUBS setup and an
-- indefensible one. The accusation a RUBS landlord faces is "you billed your
-- tenants for your own consumption". Answering it needs a positive record of
-- what was held back — an absence proves nothing.
--
-- WHY NOT A utility_bills ROW. That table requires tenant_id and lease_id NOT
-- NULL, because every bill has a payer. An owner-occupied unit has no lease and
-- no tenant; relaxing those columns to fit one special case would weaken the
-- guarantee for every ordinary bill. This is a different kind of record — money
-- deliberately NOT billed — so it gets its own ledger.
--
-- Reconciliation, which is what an auditor actually wants:
--
--     master pool for the cycle
--       = SUM(utility_bills.charge_amount)            -- billed to tenants
--       + SUM(utility_owner_use_absorptions.charge_amount)  -- kept by the owner
--
-- The unique index makes the billing engine re-runnable: regenerating a cycle
-- updates the row in place rather than stacking duplicates, matching how
-- tryInsertBill already behaves for tenant bills.

CREATE TABLE IF NOT EXISTS utility_owner_use_absorptions (
  id                  uuid PRIMARY KEY DEFAULT public.gen_random_uuid(),
  meter_id            uuid NOT NULL REFERENCES utility_meters(id) ON DELETE CASCADE,
  unit_id             uuid NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  landlord_id         uuid NOT NULL REFERENCES landlords(id) ON DELETE CASCADE,
  utility_type        text NOT NULL,
  billing_cycle_month date NOT NULL,
  allocation_method   text,
  -- The unit's basis in the split (headcount, sqft, 1 space…) — shows an auditor
  -- the owner's unit was weighted the same way every tenant's was.
  allocation_basis    numeric(12,4),
  -- What this unit's share came to. NOT billed to anyone.
  charge_amount       numeric(12,2) NOT NULL,
  base_fee_share      numeric(12,2) NOT NULL DEFAULT 0,
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT utility_owner_use_absorptions_amount_check CHECK (charge_amount >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_owner_use_absorption_per_cycle
  ON utility_owner_use_absorptions (meter_id, unit_id, billing_cycle_month);

CREATE INDEX IF NOT EXISTS idx_owner_use_absorption_landlord_cycle
  ON utility_owner_use_absorptions (landlord_id, billing_cycle_month);

COMMENT ON TABLE utility_owner_use_absorptions IS
  'S609: utility cost a landlord absorbed on their OWN occupied units. An owner-occupied unit takes a real share of a RUBS pool — so the tenants stop paying for the owner''s usage — and that share is then billed to nobody. This is the provable record that it was held back rather than passed through, which is the question a RUBS audit asks.';

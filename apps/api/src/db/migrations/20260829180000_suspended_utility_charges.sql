-- S629 (Nic): "a pending unit should have the amount of water show as temporary
-- suspension back end and be billed with the first invoice as soon as
-- acceptance happens. Same for electric submeter readings. These are all
-- existing tenants at onboarding, by the way, so they are expecting to be
-- billed for these things."
--
-- THE BUG THIS CLOSES. A RUBS master divides across the units on the meter, and
-- an occupant_count split scores a unit by its ACTIVE LEASE tenants. A resident
-- who has been invited but not yet signed has no lease — lease is law, the
-- signed document IS the lease — so the unit scored zero and was dropped from
-- the split entirely:
--
--   basis-0 units (e.g. a vacant occupant_count unit) never bill;
--   counted as skipped and excluded from the split
--
-- Mid-onboarding that is severe. With 6 of 30 residents signed, those 6 split
-- the water for all 30 — a 5x overcharge on the people who signed on time,
-- while the other 24 are billed nothing for water they used.
--
-- A pending unit now takes its real share and the share is HELD here instead of
-- being billed to nobody. When the lease is signed the held rows are released
-- onto that tenant's first invoice, so the split is right for everyone from the
-- first cycle and nothing is quietly written off.
--
-- Held, not billed: no invoice exists to carry it, so no due date, no late fee,
-- and no debt against somebody who has not signed anything yet.

CREATE TABLE IF NOT EXISTS suspended_utility_charges (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meter_id            uuid NOT NULL REFERENCES utility_meters(id) ON DELETE CASCADE,
  unit_id             uuid NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  landlord_id         uuid NOT NULL REFERENCES landlords(id) ON DELETE CASCADE,
  billing_cycle_month date NOT NULL,
  utility_type        text NOT NULL,
  usage_amount        numeric(14,4),
  allocation_method   text,
  allocation_basis    numeric(14,4),
  rate_per_unit       numeric(12,6),
  base_fee_share      numeric(12,2) DEFAULT 0 NOT NULL,
  charge_amount       numeric(12,2) NOT NULL,
  tax_rate_pct        numeric(6,3),
  tax_amount          numeric(12,2),
  sewer_rate_per_unit numeric(12,6),
  reading_start       numeric(14,4),
  reading_end         numeric(14,4),
  reading_start_date  date,
  reading_end_date    date,
  notes               text,
  -- Lifecycle. Exactly one of these is set once the charge stops being held.
  released_at         timestamptz,
  released_bill_id    uuid REFERENCES utility_bills(id),
  cancelled_at        timestamptz,
  cancelled_reason    text,
  created_at          timestamptz DEFAULT now() NOT NULL,
  updated_at          timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT suspended_utility_charges_amount_check CHECK (charge_amount >= 0),
  CONSTRAINT suspended_utility_charges_outcome_check
    CHECK (NOT (released_at IS NOT NULL AND cancelled_at IS NOT NULL))
);

-- Mirrors utility_bills_one_per_meter_unit_cycle: the billing engine is
-- re-runnable by design, so a second run for the same cycle must not hold the
-- same share twice. Scoped to rows still held, so a cancelled-then-reheld
-- cycle is still possible.
CREATE UNIQUE INDEX IF NOT EXISTS suspended_utility_one_per_meter_unit_cycle
  ON suspended_utility_charges (meter_id, unit_id, billing_cycle_month)
  WHERE released_at IS NULL AND cancelled_at IS NULL;

-- The release path looks these up by unit when a lease is signed.
CREATE INDEX IF NOT EXISTS suspended_utility_held_by_unit
  ON suspended_utility_charges (unit_id)
  WHERE released_at IS NULL AND cancelled_at IS NULL;

COMMENT ON TABLE suspended_utility_charges IS
  'S629: a utility share for a unit whose resident has been invited but has not signed yet. Held (never invoiced, no due date, no late fee) so the RUBS split is correct for everyone from the first cycle, and released onto the tenant''s first invoice when their lease is signed.';

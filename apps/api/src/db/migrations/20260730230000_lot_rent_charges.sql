-- Lot-rent obligations for the investor-operator model (S568, Nic).
--
-- WHY: an investor operating homes at a park they don't own (properties.
-- operator_owns_land=false) owes the EXTERNAL park lot rent each month per lot
-- they hold. The park isn't on GAM, so GAM does NOT move this money — it TRACKS
-- the obligation and lets the investor mark it paid (they pay the park directly,
-- off-platform). This makes their net real: tenant rent (income) − lot rent
-- (expense). One charge per (unit, month); accrued monthly.
--
-- Not a `payments` row — payments is the tenant-facing rail (money through GAM).
-- Lot rent is the operator's OWN expense to an off-platform party, so it lives in
-- its own obligation ledger.

CREATE TABLE lot_rent_charges (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_id        uuid NOT NULL REFERENCES units(id),
  property_id    uuid NOT NULL REFERENCES properties(id),
  landlord_id    uuid NOT NULL REFERENCES landlords(id),
  billing_month  date NOT NULL,               -- 1st of the cycle owed
  amount         numeric(10,2) NOT NULL CHECK (amount >= 0),
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid')),
  paid_at        timestamptz,
  notes          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (unit_id, billing_month)              -- idempotent monthly accrual
);
CREATE INDEX idx_lot_rent_charges_landlord ON lot_rent_charges(landlord_id, status);
CREATE INDEX idx_lot_rent_charges_unit ON lot_rent_charges(unit_id);

COMMENT ON TABLE lot_rent_charges IS
  'S568: monthly lot-rent the investor owes an EXTERNAL park (homes-only property). GAM tracks the obligation + paid status (money moves off-platform); powers the investor net = tenant rent − lot rent.';

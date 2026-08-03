-- Landlord-entered expenses for bookkeeping (S568, Nic).
--
-- WHY: GAM already auto-books income (rent) and some expenses (platform fee,
-- maintenance) into the landlord P&L. Landlords also need to enter their OWN
-- expenses so the P&L is complete. An expense is either:
--   * unit-linked (unit_id set) — belongs to one home/unit.
--   * common/property-level (unit_id NULL, property_id set) — e.g. insurance,
--     landscaping, property tax. The landlord decides whether a common expense is
--     DIVIDED per unit across the property (allocate_per_unit) for per-unit P&L;
--     either way it counts in the property/landlord total.
--
-- Feeds the landlord reports P&L expense side. Not a `payments` row (that rail is
-- tenant money through GAM) and not a double-entry journal line (this is the
-- simple landlord-facing entry). Retained per keep-everything: a "delete" is a
-- soft void (status), never a hard delete.

CREATE TABLE landlord_expenses (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  landlord_id       uuid NOT NULL REFERENCES landlords(id),
  property_id       uuid REFERENCES properties(id),
  unit_id           uuid REFERENCES units(id),
  category          text NOT NULL,
  amount            numeric(12,2) NOT NULL CHECK (amount >= 0),
  description       text,
  vendor            text,
  expense_date      date NOT NULL,
  -- common = property-level (not tied to one unit). allocate_per_unit divides it
  -- across the property's units for per-unit P&L (only meaningful when common).
  is_common         boolean NOT NULL DEFAULT FALSE,
  allocate_per_unit boolean NOT NULL DEFAULT FALSE,
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active','voided')),
  voided_at         timestamptz,
  created_by        uuid REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  -- A unit-linked expense is never also common; a common expense has no unit.
  CHECK ((unit_id IS NOT NULL AND is_common = FALSE) OR (unit_id IS NULL))
);
CREATE INDEX idx_landlord_expenses_scope ON landlord_expenses(landlord_id, expense_date) WHERE status = 'active';
CREATE INDEX idx_landlord_expenses_unit ON landlord_expenses(unit_id) WHERE status = 'active';
CREATE INDEX idx_landlord_expenses_property ON landlord_expenses(property_id) WHERE status = 'active';

COMMENT ON TABLE landlord_expenses IS
  'S568: landlord-entered expenses (unit-linked or common; common can allocate per unit). Feeds the landlord P&L expense side. Soft-void, never hard-delete.';

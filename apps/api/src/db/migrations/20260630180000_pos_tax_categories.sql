-- Simple category-level POS tax. Instead of typing a tax % on every item, the
-- operator defines a small set of TAX categories (Food, Tobacco, Alcohol,
-- General, Non-taxable, …) each with ONE rate, and items pick a tax category.
-- The item's effective tax rate = its tax category's rate.
--
-- Distinct from pos_categories (Fuel/Laundry/etc. — the merchandising taxonomy).
-- Rate is stored as a decimal (0.08 = 8%), matching pos_items.tax_rate.
CREATE TABLE IF NOT EXISTS pos_tax_categories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  landlord_id uuid NOT NULL REFERENCES landlords(id) ON DELETE CASCADE,
  name        text NOT NULL,
  rate        numeric NOT NULL DEFAULT 0,
  is_active   boolean NOT NULL DEFAULT TRUE,
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (landlord_id, name)
);

-- Items reference a tax category. Nullable: legacy items keep their manual
-- tax_rate until assigned a category (the API resolves the effective rate).
ALTER TABLE pos_items ADD COLUMN IF NOT EXISTS tax_category_id uuid REFERENCES pos_tax_categories(id) ON DELETE SET NULL;

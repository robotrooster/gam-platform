-- S632 (Nic, DIRECTIVE): "We put in our true cost total dollar bill, and then we
-- divide out total gallons delivered to the property... so it's five dollars a
-- gallon. We need a back end setting for the markup. That way when we have a
-- fluctuating rate, we have our margin always balanced on the back end. So if we
-- say we're doing a twenty-five cent markup, it takes our true cost per gallon
-- and marks it up twenty-five cents. The markup applies on every customer. It
-- doesn't matter if they pay in full or get finance charge."
--
-- WHY THE MARKUP IS FLAT ACROSS EVERYONE. A price that is higher BECAUSE
-- somebody paid over time is a finance charge, with the disclosure and
-- retail-instalment rules that follow. The same price to everyone, whether they
-- pay once or four times, is a reseller's margin and nothing more. Nic set it up
-- this way deliberately; the schema makes it hard to do otherwise by holding the
-- markup on the PROPERTY, where it cannot vary by tenant or by payment plan.
ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS propane_markup_per_gallon numeric(8,4) NOT NULL DEFAULT 0;

COMMENT ON COLUMN properties.propane_markup_per_gallon IS
  'S632: cents-per-gallon added to the delivery''s true cost to reach the billed rate. Applies to every fill at the property regardless of payment plan — a margin, not a finance charge.';

ALTER TABLE properties
  DROP CONSTRAINT IF EXISTS properties_propane_markup_sane;
ALTER TABLE properties
  ADD CONSTRAINT properties_propane_markup_sane
  CHECK (propane_markup_per_gallon >= 0 AND propane_markup_per_gallon <= 10);

-- What the delivery actually cost, kept on every fill it produced.
--
-- SNAPSHOTS, not references. The markup setting will change with the market, and
-- a fill recorded in August must still explain itself in November — what the
-- fuel cost that day, what was added, what the tenant was charged. Reading the
-- property's CURRENT markup to explain a past fill would silently restate
-- history every time the rate moved.
ALTER TABLE propane_fills
  ADD COLUMN IF NOT EXISTS true_cost_per_gallon numeric(10,4),
  ADD COLUMN IF NOT EXISTS markup_per_gallon    numeric(8,4),
  ADD COLUMN IF NOT EXISTS invoice_total        numeric(12,2),
  ADD COLUMN IF NOT EXISTS invoice_gallons      numeric(12,2);

COMMENT ON COLUMN propane_fills.true_cost_per_gallon IS
  'S632: the delivery''s blended cost — supplier invoice total (tax, delivery, surcharges included) divided by total gallons delivered. NULL on fills recorded before S632 or entered at a flat rate.';
COMMENT ON COLUMN propane_fills.invoice_total IS
  'S632: the whole supplier invoice for the delivery this fill came from — kept so a margin can be re-derived years later without the paper.';

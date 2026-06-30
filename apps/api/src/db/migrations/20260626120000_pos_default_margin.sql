-- POS business-level default margin (walkthrough POS #1, 2026-06-26)
--
-- WHY: operators wanted item pricing to flow from a target margin instead of
-- typing a sell price every time. This is the business-level default the POS
-- item form auto-prices against (sell = cost / (1 - margin/100)); per-item
-- margin already lives on pos_items.margin_pct. NULL = no default set (the
-- form falls back to manual sell-price entry, no auto-pricing).
--
-- NO BACKFILL NEEDED — new nullable column.
ALTER TABLE public.landlords
  ADD COLUMN IF NOT EXISTS pos_default_margin_pct numeric(5,2);

-- Gross-margin percent of sale price; 0..<100 (100% margin = infinite price).
ALTER TABLE public.landlords
  ADD CONSTRAINT landlords_pos_default_margin_pct_check
  CHECK (pos_default_margin_pct IS NULL OR (pos_default_margin_pct >= 0 AND pos_default_margin_pct < 100));

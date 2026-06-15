-- S506: per-business sales tax + per-customer exemption.
--
-- Two new columns on `businesses` and two on `business_customers`:
--
--   businesses.default_tax_rate   numeric(5,4)  — e.g. 0.0875 for 8.75%
--   businesses.tax_label          text          — "Sales Tax" / "HST" / "VAT" / "GST"
--   business_customers.tax_exempt boolean       — exempt from tax
--   business_customers.tax_exempt_reason text   — "resale cert #1234"
--
-- Inventory items already have their own per-item `tax_rate` snapshot
-- — those still win at POS time (item-level override). The new
-- business-level default fills the gap on invoices and quotes which
-- don't have a per-line tax source yet.
--
-- Rate format: numeric(5,4) — 4 decimal places, max 0.9999. Matches
-- the shape of business_inventory_items.tax_rate and
-- business_quote_lines.tax_rate so the same value plugs in everywhere.
--
-- SAFE — additive only. New businesses get 0 default (no auto-tax until
-- owner sets a rate). Existing businesses see zero behavior change.

ALTER TABLE public.businesses
  ADD COLUMN default_tax_rate numeric(5,4) DEFAULT 0 NOT NULL,
  ADD COLUMN tax_label text DEFAULT 'Sales Tax' NOT NULL,
  ADD CONSTRAINT businesses_default_tax_rate_range
    CHECK (default_tax_rate >= 0 AND default_tax_rate < 1);

ALTER TABLE public.business_customers
  ADD COLUMN tax_exempt boolean DEFAULT FALSE NOT NULL,
  ADD COLUMN tax_exempt_reason text;

COMMENT ON COLUMN public.businesses.default_tax_rate IS
  'S506 default sales-tax rate applied to invoices + quotes + POS unless the customer is tax_exempt or the line has its own rate. Numeric 5,4 — store 0.0875 for 8.75%.';
COMMENT ON COLUMN public.business_customers.tax_exempt IS
  'S506 customer-level exemption (resale certificate, nonprofit, government). When TRUE, every invoice / quote / POS sale tax_amount is forced to 0.';

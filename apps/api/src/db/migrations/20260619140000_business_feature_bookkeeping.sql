-- Add 'bookkeeping' to the businesses.enabled_features CHECK catalog.
--
-- WHY: business customers now get full bookkeeping by reusing the GAM Books
-- engine (S459, migration 20260619120000 added business_id to the books
-- tables). Like every other business capability, Bookkeeping is a toggleable
-- feature gated by enabled_features — so it needs a slot in the CHECK.
-- Single-source-of-truth rule: this mirrors BUSINESS_FEATURES in
-- packages/shared/src/index.ts (where 'bookkeeping' was just appended).
--
-- Off by default: existing businesses keep their current feature set; an
-- owner opts in via Settings → Features. No backfill.

ALTER TABLE public.businesses DROP CONSTRAINT businesses_enabled_features_check;

ALTER TABLE public.businesses ADD CONSTRAINT businesses_enabled_features_check
  CHECK (enabled_features <@ ARRAY[
    'customers'::text, 'staff'::text, 'recurring_schedules'::text,
    'appointments'::text, 'routing'::text, 'pos'::text, 'inventory'::text,
    'work_orders'::text, 'customer_vehicles'::text, 'invoicing'::text,
    'payments'::text, 'quotes'::text, 'discounts'::text, 'bookkeeping'::text
  ]);

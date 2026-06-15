-- S492: GAM for Business — feature-toggle infrastructure.
--
-- Two additive changes on `businesses`:
--   1. New `enabled_features text[]` column. Each business owner
--      toggles which features apply to their model. A trash hauler
--      enables {customers, staff, recurring_schedules, routing,
--      invoicing, payments}; a mini market enables {customers, staff,
--      pos, inventory, invoicing, payments}; a stationary mechanic
--      enables {customers, staff, appointments, work_orders,
--      customer_vehicles, inventory, invoicing, payments}.
--   2. Expand `business_type` CHECK to cover the new vertical models
--      Nic confirmed: mini_market, mechanic_stationary, mechanic_mobile.
--
-- CHECK constraint on enabled_features enforces the feature catalog —
-- only known keys allowed. Single source of truth lives in
-- packages/shared/BUSINESS_FEATURES; this CHECK mirrors it. If a new
-- feature lands, append to the shared array AND cut a migration that
-- ALTERs the CHECK (drop + add) per CLAUDE.md "Single source of truth
-- for enums and CHECK constraints" rule.
--
-- Backfill: default to {} (empty). Existing businesses (test/dev only;
-- pre-launch volume) keep no toggles until owner saves. New businesses
-- get sensible defaults set by POST /businesses based on business_type
-- (defaults map lives in shared, not the DB — only the catalog is
-- enforced here).
--
-- SAFE — backfill is trivial (empty array). No data movement.

ALTER TABLE public.businesses
  ADD COLUMN enabled_features text[] DEFAULT '{}'::text[] NOT NULL;

ALTER TABLE public.businesses
  ADD CONSTRAINT businesses_enabled_features_check CHECK (
    enabled_features <@ ARRAY[
      'customers',
      'staff',
      'recurring_schedules',
      'appointments',
      'routing',
      'pos',
      'inventory',
      'work_orders',
      'customer_vehicles',
      'invoicing',
      'payments'
    ]::text[]
  );

-- Expand business_type to the new verticals.
ALTER TABLE public.businesses DROP CONSTRAINT businesses_business_type_check;
ALTER TABLE public.businesses
  ADD CONSTRAINT businesses_business_type_check CHECK (
    business_type = ANY (ARRAY[
      'trash_hauling'::text,
      'maintenance_crew'::text,
      'mobile_rental'::text,
      'equipment_rental'::text,
      'mini_market'::text,
      'mechanic_stationary'::text,
      'mechanic_mobile'::text,
      'other'::text
    ])
  );

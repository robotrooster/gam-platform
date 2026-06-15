-- S502: backfill business_users.permissions with role-default arrays.
--
-- The `permissions jsonb` column was added by the prior S80-era
-- 20260503060000_team_permissions_consolidation.sql migration but its
-- shape was never standardized — existing rows store `{}` and no
-- consumer reads it. S502 standardizes the shape as a JSON array of
-- granted permission keys from BUSINESS_STAFF_PERMISSIONS in shared:
--
--   ["dashboard.view", "customers.read", ...]
--
-- The CHECK on values is enforced at the API layer (validates against
-- the shared catalog on PATCH) — jsonb CHECK on array contents is
-- painful and we prefer one source of truth in code.
--
-- Backfill is idempotent: any row whose permissions is `{}` or `null`
-- (i.e. has never been explicitly set) gets the role-default. Rows
-- that already have content are left alone.
--
-- SAFE — data backfill only, no schema change.

-- manager → full operational scope
UPDATE public.business_users SET permissions = '[
  "dashboard.view",
  "customers.read", "customers.write",
  "appointments.read", "appointments.write",
  "invoices.read", "invoices.write", "invoices.send",
  "quotes.read", "quotes.write", "quotes.send",
  "pos.use", "pos.refund",
  "inventory.read", "inventory.write", "inventory.adjust",
  "work_orders.read", "work_orders.write", "work_orders.complete",
  "vehicles.read", "vehicles.write",
  "routes.read", "routes.write"
]'::jsonb
 WHERE staff_role = 'manager'
   AND (permissions IS NULL OR permissions = '{}'::jsonb OR jsonb_typeof(permissions) <> 'array');

-- dispatcher → customer-facing ops + scheduling + routes
UPDATE public.business_users SET permissions = '[
  "dashboard.view",
  "customers.read", "customers.write",
  "appointments.read", "appointments.write",
  "invoices.read",
  "quotes.read", "quotes.write",
  "work_orders.read",
  "vehicles.read", "vehicles.write",
  "routes.read", "routes.write"
]'::jsonb
 WHERE staff_role = 'dispatcher'
   AND (permissions IS NULL OR permissions = '{}'::jsonb OR jsonb_typeof(permissions) <> 'array');

-- driver → drive-only + read appointments/customers/routes
UPDATE public.business_users SET permissions = '[
  "appointments.read",
  "customers.read",
  "routes.read", "routes.drive"
]'::jsonb
 WHERE staff_role = 'driver'
   AND (permissions IS NULL OR permissions = '{}'::jsonb OR jsonb_typeof(permissions) <> 'array');

-- office → customer-facing billing + POS register
UPDATE public.business_users SET permissions = '[
  "dashboard.view",
  "customers.read", "customers.write",
  "appointments.read", "appointments.write",
  "invoices.read", "invoices.write", "invoices.send",
  "quotes.read", "quotes.write", "quotes.send",
  "pos.use"
]'::jsonb
 WHERE staff_role = 'office'
   AND (permissions IS NULL OR permissions = '{}'::jsonb OR jsonb_typeof(permissions) <> 'array');

COMMENT ON COLUMN public.business_users.permissions IS
  'S502 shape: JSON array of granted permission keys. Catalog + role-defaults live in packages/shared (BUSINESS_STAFF_PERMISSIONS / BUSINESS_STAFF_PERMISSIONS_BY_ROLE). API layer validates contents on PATCH against the catalog; no DB CHECK by design.';

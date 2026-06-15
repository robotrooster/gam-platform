# Session 492 — closed

> GAM for Business — feature-toggle infrastructure. Step 1 of
> the suite-of-toggleable-features plan agreed with Nic.

## Theme

**Foundation for the toggleable-features architecture. Every
business owner picks the subset of features that applies to
their model — a trash hauler enables {routing, schedules,
invoicing, payments}, a mini market enables {pos, inventory,
invoicing, payments}, a stationary mechanic enables
{appointments, work_orders, customer_vehicles, inventory}. The
Layout nav, dashboard, and future feature surfaces all gate on
these toggles. Defaults pre-fill at signup based on
business_type; the owner can edit anytime in Settings →
Features.**

Suite (api) at S491 close: 3105 / 164.
Suite (api) at S492 close: **3122 / 164 / 0 failures** (+17 —
11 new S492 cases on businesses.test.ts + 6 S491 CSV cases
that also landed).

apps/business tsc clean. apps/business build: clean (325.93
KB JS / 92.58 KB gzipped).

## What shipped

### Migration: `20260614130000_business_features_toggle.sql`

Two additive changes to `businesses`:

1. **`enabled_features text[] DEFAULT '{}' NOT NULL`** + CHECK
   constraint mirroring the shared `BUSINESS_FEATURES` catalog.
   The CHECK enforces only known keys at the DB level; the
   shared array is the source-of-truth for the catalog per
   CLAUDE.md "Single source of truth for enums" rule.

2. **Expanded `business_type` CHECK** to add the 3 new
   verticals Nic confirmed: `mini_market`,
   `mechanic_stationary`, `mechanic_mobile`. Existing values
   (trash_hauling, maintenance_crew, mobile_rental,
   equipment_rental, other) preserved.

Applied; schema.sql regenerated.

### `packages/shared/src/index.ts`

- `BUSINESS_TYPES` extended (3 new keys + labels).
- `BUSINESS_FEATURES` — readonly array of 11 feature keys:
  `customers, staff, recurring_schedules, appointments,
  routing, pos, inventory, work_orders, customer_vehicles,
  invoicing, payments`. Type derived via
  `typeof BUSINESS_FEATURES[number]`.
- `BUSINESS_FEATURE_LABEL` — human label per key.
- `BUSINESS_FEATURE_DESCRIPTION` — one-line description per
  key (renders on the Settings → Features toggle card).
- `BUSINESS_FEATURE_ALWAYS_ON` — features that cannot be
  disabled (currently `customers`, `staff`). UI renders them
  locked-on; the API guards against trying to omit them.
- `BUSINESS_TYPE_DEFAULT_FEATURES` — per-business_type
  default set. Drives signup pre-fill.

### `apps/api/src/routes/businesses.ts`

- POST signup applies `BUSINESS_TYPE_DEFAULT_FEATURES[type]`
  on insert; returns `enabledFeatures` in the response.
- GET /me extended to return `enabled_features`.
- **New: PATCH /api/businesses/me/features** — owner-only;
  body `{ enabledFeatures: BusinessFeature[] }`. Zod
  validation rejects unknown keys (DB CHECK is the deeper
  guard). Always-on features auto-merged into the saved set
  (defends against a direct API call trying to omit them).

### `apps/business/src/context/AuthContext.tsx`

- New `BusinessSummary` interface: `id, name, businessType,
  enabledFeatures`.
- Auth context fetches `/businesses/me` after `/auth/me`
  resolves and exposes the business as `business`.
- New `refreshBusiness()` callback — Settings page calls it
  after saving features so the Layout nav refreshes in place.

### `apps/business/src/components/layout/Layout.tsx`

- Each `NAV_ITEMS` entry can carry an optional `feature` key.
- Items without `feature` are universal (Dashboard, Customers,
  Staff, Settings).
- Items with a feature key only render when the business has
  that feature in `enabledFeatures`.
- Loading guard: until the business summary fetches, items
  render unconditionally (avoids a nav flicker where features
  briefly disappear).

Feature gates applied:
- Schedules → `recurring_schedules`
- Routes / Depots / Vehicles / Dump Locations → `routing`

### `apps/business/src/pages/SettingsPage.tsx`

New **Features** section below the existing business profile
form. Renders every catalog entry as a toggleable card:
- Each card shows label + description + selection checkbox.
- Always-on features render with an "ALWAYS ON" badge and
  can't be clicked off.
- Save button enables when the selection differs from the
  saved state.
- On save: PATCH /me/features → updates local state +
  refreshes AuthContext.business so the nav reflects the
  change immediately.

### `apps/business/src/pages/SignupPage.tsx`

No code changes — already maps over `BUSINESS_TYPES` from
shared. The 3 new types appear in the dropdown automatically.

## Items shipped

```
apps/api/src/db/migrations/
  20260614130000_business_features_toggle.sql   (NEW)
apps/api/src/db/
  schema.sql                                     (regenerated)
packages/shared/src/
  index.ts                                       (+ BUSINESS_FEATURES catalog
                                                  + BUSINESS_TYPE_DEFAULT_FEATURES
                                                  + new business_type values)
apps/api/src/routes/
  businesses.ts                                  (PATCH /me/features
                                                  + signup defaults
                                                  + GET /me carries features)
  businesses.test.ts                             (+11 S492 cases)
apps/business/src/context/
  AuthContext.tsx                                (+ business summary fetch
                                                  + refreshBusiness())
apps/business/src/components/layout/
  Layout.tsx                                     (+ feature-gated nav)
apps/business/src/pages/
  SettingsPage.tsx                               (+ FeaturesSection toggle UI)
```

## Decisions made during build

| Question | Decision |
|---|---|
| Toggle storage: array column vs dedicated table | **`text[]` column.** Easier to read/write, can migrate to a per-feature table later if we add per-feature settings (e.g., feature-specific config). Today there's no per-feature data beyond on/off. |
| Always-on enforcement: client-only or also API | **Both.** UI prevents the click; API re-merges always-on into the saved set. Defends against a direct API call. |
| Default features per type — where? | **packages/shared.** Single source of truth + types travel to both frontend and backend. |
| Auto-apply defaults at signup, or empty + manual | **Auto-apply.** Owner shouldn't have to pick 8 features at signup. Defaults match the business model; owner edits in Settings if their use case differs. |
| Nav gate behavior while business summary is loading | **Show everything (role-admitted) until business loads, then apply feature gate.** Avoids flicker; the wait is < 500ms typically. |
| Customer + Staff as always-on | **Yes.** Every business needs both. UI shows them locked-on with an "ALWAYS ON" badge so the design intent is visible. |
| Settings UI: per-feature toggle cards vs single multi-select list | **Per-feature toggle cards.** Each feature gets a label + description; the description is the discoverability story. A list-select would hide the descriptions. |

## Verification

- `cd apps/api && npx tsc --noEmit`: clean.
- `cd apps/business && npx tsc --noEmit`: clean.
- `cd apps/business && npm run build`: clean (325.93 KB JS /
  92.58 KB gzipped — +5 KB vs S491 from the FeaturesSection UI).
- Targeted: `vitest run businesses.test.ts` — 40 passed (29
  prior + 11 S492).
- Full: `npm test` — **3122 / 164 / 0** (+17 from S491).
- Migration applied; schema regenerated.

### Bugs caught during build

None.

## Phase status — business portal architecture

The toggleable-features architecture is live:

- **Data model**: businesses.enabled_features text[] with CHECK
  catalog
- **API**: PATCH /me/features endpoint; defaults at signup
- **Shared**: BUSINESS_FEATURES catalog + per-type defaults
- **Frontend**: AuthContext exposes business.enabledFeatures;
  Layout nav gates each item; Settings UI lets owner toggle

Every future feature (invoicing, appointments, POS, work orders,
customer vehicles) drops into this pattern:
1. Add the feature key to BUSINESS_FEATURES + label +
   description in shared
2. Add to BUSINESS_TYPE_DEFAULT_FEATURES per business_type
3. Cut a migration extending the CHECK
4. Add nav items with `feature: 'thekey'`
5. Build the feature page

## What the next session should target

Per the agreed build order: **Invoicing + payment collection**
(step 2). Every business across every vertical needs to bill
and get paid; current portal has zero billing surface.

Initial scope:
- `business_invoices` table — customer_id, total, status,
  due_date, line items
- POST /api/business-invoices — create one-off
- POST /api/business-invoices/recurring — create recurring
- Stripe Connect integration for collection (same rails as
  the real-estate side)
- Invoices page + per-customer view

Big-ish scope; one focused session for backend + API + simple
list page, second session for full UI + Stripe wiring.

---

End of S492 handoff. **Feature-toggle infrastructure shipped.
Step 1 of the GAM-for-Business suite complete. Every future
feature drops into the existing pattern.**

3122 tests / 164 files / 0 failures.

**Next: invoicing + payments per agreed order.**

# SESSION 524 HANDOFF — Landlord dashboard fixes + eviction/suspended coupling + big POS pass

## Theme
UI/product fixes driven live by Nic: landlord dashboard KPI accuracy, coupling the
`suspended` unit status to eviction mode, hiding the community bulletin board, and a
large Point-of-Sale overhaul (the landlord POS tab was an old broken fork — brought it
up to the standalone version, then layered many fixes onto both).

## Shipped

### Landlord dashboard (`apps/landlord/src/pages/DashboardPage.tsx` + `apps/api/src/routes/landlords.ts` `/landlords/me/dashboard`)
- Rent KPIs reconciled with Reports: **Expected Monthly Rent** now = full rent roll
  (`active + direct_pay + delinquent + suspended`, not active-only — a delinquent unit's
  rent was being dropped, so income read higher than "expected"). Added **Collected This
  Month** and **Outstanding** cards (same SQL as `/reports/summary`).
- Added **Occupancy Rate** (active/total, matches Reports) and **Leases Expiring** (30/60d)
  cards → 10 cards in a **3 / 4 / 3** layout (12-col grid, spans 4/3/4).
- Principle (see memory [[gam-rent-obligation-principle]]): rent owed = per lease, not per
  payment; expected-rent counts non-paying + evicting units. Don't strip them out.

### `suspended` unit status coupled 1:1 to eviction mode (migration `20260630140000`)
- `POST /units/:id/eviction-mode` now: ON → status `suspended` (saves prior status in new
  `units.status_before_block`); OFF → restores prior status (active/delinquent). Manual
  `PATCH /units/:id/status` blocks setting/leaving `suspended` (must use eviction toggle).
  A unit is `suspended` **iff** eviction mode is on.

### Community Bulletin Board hidden (landlord `DashboardPage` + tenant `main.tsx`)
- Wrapped in `{false && …}` — reversible. Tenant still background-fetches `/bulletin`
  (harmless; can silence later).

### Point of Sale — landlord tab == standalone (both `apps/{landlord,pos}/src/pages/POSPage.tsx` kept BYTE-IDENTICAL; edit one, `cp` to the other)
The landlord `/pos` tab was a stale simpler fork (broken add-item, no property/categoryId).
Replaced it with the `apps/pos` version (copied `lib/terminal.ts` + `lib/syncQueue.ts` into
landlord, added `@stripe/terminal-js` dep). Then, applied to BOTH:
- **Categories:** Property column shows company/business name (from new `/pos/settings.businessName`)
  or property street address — no "Landlord-wide" language anywhere (removed across POS).
  Sortable Name/Property headers (removed the manual Sort Order field/column). Icon is a
  clickable dropdown (~130 presets, `POS_ICON_OPTIONS`), not free text.
- **Category property scope = per-property toggle** (migration `20260630170000`:
  `pos_categories.property_ids uuid[]`, NULL=all). Add form uses a **popup picker**
  ("Available at which properties?"); edit uses inline checkboxes. Category names are
  UNIQUE again (migrations `…150000` added per-property dupes, `…160000` reverted — Nic:
  no duplicate categories; filter sales by property instead).
- **Items page** matches categories: icon dropdown, sortable columns (Item/Category/
  Property/Price/Stock). Duplicate item names allowed (no constraint) — same item at
  different properties with independent cost + sell price (per-row `cost_price`/`sell_price`/
  `margin_pct`). Add Item now requires a property (placeholder "Select a property…", button
  gated, errors surfaced) — the old "no property" option 400'd silently.
- **Register add-to-cart bug FIXED:** multi-property operators had no register selected →
  `ensureSession()` returned null → clicking an item did nothing. Added a prominent
  "Register: [Select a property…]" picker + gate at the top of the register; item grid
  scoped to the chosen property. Verified: select property → pizza adds to cart.
- **Tax % bug FIXED:** Add Item form stored "4" as 400% — now ÷100 (matches edit).
- **Tax categories (simple, category-level)** — migration `20260630180000`
  `pos_tax_categories` (name + one rate; seeded Non-taxable/General/Food/Tobacco/Alcohol)
  + `pos_items.tax_category_id`. Items pick a **Tax Category** (dropdown) instead of typing
  a %; effective tax resolved server-side in `GET /pos/items`
  (`COALESCE(tc.rate, pi.tax_rate, 0)`). Manage rates in Tax Rates tab → **Tax Categories**
  card. CRUD at `/pos/tax-categories`.
- **Sync UI removed** from the POS header (the "Synced" badge + `SyncStatusBadge` component
  + state/effect/imports) and the non-clickable "Register · Vendors · Orders · Inventory"
  subtitle. The cart-sync ENGINE (`enqueueSync`, 8 call sites) stays — checkout needs it.

## Migrations (all applied)
- `20260630140000_units_status_before_block.sql`
- `20260630150000_pos_categories_per_property_name_uniq.sql` (superseded by ↓)
- `20260630160000_pos_categories_revert_to_unique_name.sql`
- `20260630170000_pos_categories_property_ids.sql`
- `20260630180000_pos_tax_categories.sql`

## Notes / deferred
- The two POSPage files MUST stay identical — edit one, `cp` to the other.
- POS legacy per-jurisdiction tax rates (`pos_tax_rates`, "Add Tax Rate" card) still present
  below the new Tax Categories card — Nic may want it retired now that tax is category-level.
- Nic's test data: item "Pizza`" (stray backtick) at Oak Street Apartments, assigned Food (2%).
- Backend still on the DEV stack (ts-node-dev :4000 + dev model/embeddings) served publicly
  via the Cloudflare tunnel — harden to launchd (`deploy/install-services.sh`) before go-live.
  See [[gam-prelaunch-todo]]. Marketing is already launchd (`com.gam.marketing`).

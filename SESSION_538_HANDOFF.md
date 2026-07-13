# SESSION 538 HANDOFF

## Theme
Big session, ten shipped items: POS neutral language (never
landlord/tenant — say customers), POS self-signup + team management
(S536 deferred #1 — customers were waiting), the W-70 dialog sweep
finished PLATFORM-WIDE (all 11 apps grep-clean), the FULL STR pricing
model (Nic-locked: $2 × CEIL(nights/30) aggregation is rv_spot-ONLY;
every other unit type short-stays at 5% of booking revenue; storage
LOCKED out of short-term entirely), the hotel_room unit type, two dead
test suites restored, and a platform-wide "no raw enums in the UI"
sweep (shared humanize() + label maps, ~60 files).

## Shipped (all tsc clean; key flows verified live in browser)

### 1. Neutral-language sweep — standalone POS app (Nic-locked)
- Deny screen (main.tsx): "The POS portal is for landlord teams and
  business operators…" → "Sign in with a POS-enabled account to use the
  register." No landlord/tenant wording anywhere user-facing now.
- **Charge-flow picker merged**: the Tenant / POS Customer toggle + two
  dropdowns are now ONE neutral "Select customer..." picker. Both backing
  lists merge into a single alphabetized select; option values carry a
  `t:`/`c:` prefix so tenantId vs posCustomerId still route correctly
  (ids mutually exclusive; checkout payload semantics preserved).
  chargeCustomerType state deleted. Applied to BOTH copies (landlord
  POSPage + standalone) per the S531/S536 keep-in-sync rule. NOTE: both
  copies still have LAUNCH_HIDE_CHARGE=true, so this ships dormant until
  the charge method is unhidden.
- Remaining "landlord" strings in apps/pos are code comments + internal
  keys only (query keys, terminal.ts field names) — not user-facing.

### 2. Dead code deleted (Nic-approved)
- apps/pos/src/components/layout/Layout.tsx + NotificationBell.tsx —
  unimported since the S536 POSLayout shell rewrite (the bell carried
  "Message Tenants" UI; its stale comment ref in POSPage cleaned too).

### 3. W-70 dialog port → standalone POS app
- components/dialogs.tsx copied verbatim from landlord; DialogHost
  mounted once in main.tsx (inside BrowserRouter, covers login too).
- 5 native call sites converted, mirroring the landlord S537 versions
  exactly: 2 mutation onError alert()→toast.error(), margin-deviation
  window.confirm()→appConfirm (Save anyway), stock-adjust prompt()→
  appPrompt (Adjust stock title), reader-archive confirm()→appConfirm
  (danger). grep: ZERO native alert/confirm/prompt in apps/pos.
- Verified live: Adjust-stock in-app modal renders at Sunset Palms
  (james@demo.dev), console clean.

### 4. POS self-signup + team management (S536 deferred #1 — DONE)
Backend needed ZERO changes — POST /api/businesses (public self-signup,
S455) and the /api/business-users lifecycle (S456) already existed.
Frontend build in apps/pos:
- **SignupPage.tsx** (new, /signup public route): business name/type
  (default mini_market), owner name, email, phone optional, EIN optional
  (per spec), password 12+, terms gate. POSTs /businesses, stashes the
  minted JWT under gam_token, hard-navs to /pos → lands in business-mode
  register. LoginPage got a "New here? Create an account" link.
- **TeamPage.tsx** (new, /team, owner-only — API gate + client redirect):
  port of business StaffPage kept-in-sync; active roster, pending
  invitations, invite form (role → default permissions), permissions
  modal (grouped catalog, default-dot indicators, reset-to-role-default),
  PLUS a Remove (revoke) action the business StaffPage never surfaced
  (POST /business-users/:id/revoke existed unused). Native confirm in the
  ported code swapped to appConfirm per standing rule.
- POSLayout header shows Team for business_owner only.
- Verified live end-to-end: signed up "Yarnell Corner Market" (Pat
  Seller) through the browser → landed in business-mode register with
  Team nav; sent an office-role invite → appeared under Pending
  invitations (email suppressed in dev per S536). Test rows deleted
  afterward (invitation, business, user).

### 5. W-70 dialog sweep — PLATFORM-WIDE CLOSE
dialogs.tsx (S537) copied verbatim into admin, business, books,
pm-company (pos was #3 above); DialogHost mounted once per app inside
BrowserRouter. Call sites converted: admin 5 (main.tsx: Stripe backfill
confirm, bulletin reveal alert→toast.error, bulletin remove, CSV
unverify, owner-claim promote), business 23 across 15 files (done by a
subagent, mirrored S537 conventions; CustomersPage alone had 8),
books 8 (main.tsx: seed alerts→toast, deactivate account, payroll
approve/void ×3, journal void, bookkeeper revoke), pm-company 7
(InvitationsPage 5 — incl. the 409 replace/banking confirms and reject
prompt, FeePlansPage deprecate, StaffPage revoke). Fix-it-right catch:
pm-company reject-invitation used to REJECT even when the native prompt
was cancelled (null reason fell through); appPrompt cancel now aborts.
Verification: grep across ALL 11 apps returns ZERO native
alert/confirm/prompt; tsc clean on admin/business/books/pm-company.

### 6. STR pricing (Nic-locked S536, rule corrected by Nic in-session) — BUILT
- **The rule (Nic): $2 × CEIL(nights/30) aggregation is for rv_spot
  ONLY** — the space is just there, the landlord coordinates nothing.
  A short-stay booking on ANY other unit type (apartment, house, and
  yes mobile_home if a landlord chooses to book one) is a coordinated
  stay → 5% of revenue. New unit types default to the 5% side.
- packages/shared: NIGHTS_AGGREGATION_UNIT_TYPES = ['rv_spot'] (single
  source of truth; queries key on it both directions).
- Migration 20260713120000: platform_fee_config.str_fee_pct (default
  0.05), landlord_platform_fee_overrides.str_fee_pct (NULL = inherit),
  platform_fee_accruals.str_revenue + str_fee_amount. Applied.
- jobs/platformFeeAccrual.ts: nights query EXCLUDES STR types; new
  query pro-rates booking total_amount to the month by nights
  (total × in-month/full-stay); fee = str_fee_pct × revenue;
  **total = MAX(rate × billable + str_fee, min)** — the STR fee folds
  UNDER the $10 minimum (replaces those units' per-unit fee, doesn't
  stack on the floor). Cascade: override.str_fee_pct → config. Accrual
  row + revenue-ledger note carry the STR component.
- services/platformFee.ts estimate fallback mirrors the exact formula
  (Reports/Dashboard interface unchanged).
- Tests: 10/10 green — 2 existing short-stay tests re-seeded as rv_spot
  (nights/30 is the rv_spot-only path; behavior unchanged), 4 new: exact
  pro-ration cents (1000×11/17 → 647.06 → 32.35), fold-under-min
  ($5 fee → $10), mobile_home bills 5% not nights/30 ($400 → $20),
  mixed RV+apartment property ($2 + $25 = $27).
- No admin override surface exists (superadmin sets overrides via SQL);
  str_fee_pct rides the same rows when one is built.

### 7. Storage short-stay LOCK (Nic-locked) + full pricing spell-out
Nic's complete model: RV sites <30 days (nightly or weekly, however the
landlord operates) aggregate PROPERTY-WIDE — all short-stay nights sum,
÷30, ×$2, remainder rounds UP to a full $2 (exactly what the accrual
does). Everything else a landlord configures short-term-bookable
(apartment, mobile home, house, commercial event space, whatever) = 5%
of the booking. **Storage is the one LOCKED type — it can never be
short-term bookable.** Enforced 4 places off shared
SHORT_STAY_LOCKED_UNIT_TYPES=['storage']:
- Unit CREATE: storage allow-list is ['month_to_month','long_term']
  (the old create granted nightly/weekly to every non-RV type — fixed;
  allow-list now computed in JS, $19 param).
- PATCH /units/:id/type: isBookable=true on storage → 400 (is_bookable
  IS the public short-stay gate; matrix already stripped the list).
- POST /units/:id/bookings: nightly/weekly on storage → 400 even when
  the allow-list is empty/unrestricted.
- Public bookStay resolveUnit: storage → 404 'Unit not bookable' (belt
  for legacy rows).
- Migration 20260713140000 (applied): data cleanup — strips
  nightly/weekly from existing storage allow-lists, clears is_bookable.
FUTURE (Nic, capture only — not built): the same 5% applies on the
business-portal side for service businesses where GAM is the tech
platform (car-rental fleets vs Turo, etc.); invoicing/buy-sell/delivery
businesses stay on the separate business pricing (S536 $10/mo model).

### 8. hotel_room unit type (Nic) — ADDED
Small hotel/motel operators bill **5%** on short-stays (Nic: "maps
closer to Airbnb") — the rv_spot-only aggregation rule already routes
any non-RV type to 5%, so ZERO billing changes; this was purely the
missing type. Shipped: UNIT_TYPES + LABEL('Hotel / Motel Room') /
PREFIX('RM') / ICON(🛏️) / HAS_BEDROOMS(false) in shared; migration
20260713150000 (applied) extends all four unit-type CHECK constraints
(units, property_unit_subtypes, property_unit_type_late_fees,
lease_templates); LEASE_TYPE_MATRIX.hotel_room = nightly/weekly/mtm/
long_term. Frontends inherit from the shared const — verified live:
Add Unit modal shows Hotel / Motel Room. api+landlord+tenant tsc clean;
80/80 across units/csv/accrual suites. NOTE: Oak Park's 3 motel rooms
are still typed 'apartment' — retyping them is Nic's data call
(harmless either way; both types bill identically).

### 9. Two dead test suites restored (pre-existing, surfaced by #7's runs)
- booking-lease-draft.test.ts: broken since S537 — the late-fee gate
  422s unit-add and this suite's seed never got decisions. Seeded
  explicit no-fee decisions; also pinned the new storage-lock assertions.
- propertyBookingFlow.test.ts: broken since S531/W-20 — still sent
  unitId to POST /book but the public contract is siteTypeId. Rewired to
  siteTypeId:'general'. This was the ONLY coverage of the public
  book/waitlist/claim/sweep flows — it had been silently dead for ~7
  sessions (bisecting against git is useless while S532-537 sit
  uncommitted; both diagnosed by reading the gate/route).
- Combined affected suites: 128/128 green (units, units-gap-close,
  bookings, booking-lease-draft, propertyBookingFlow, publicBooking,
  publicPropertyBooking, propertyBookingAdmin, platformFeeAccrual).

### 10. Raw enums NEVER render in a UI (Nic-locked STANDING RULE) — swept
Nic: unit types/categories/etc. must "look normal" on the front end
('rv_spot' → 'RV Spot'). Built shared `humanize()` fallback
(acronym-aware: RV/ACH/POS/GAM/OTP/NNN/LLC/…) alongside the existing
*_LABEL maps (prefer the map when the vocabulary has one). Three-agent
sweep across ALL frontends, ~60 files: landlord (42 files — schedule
badges, POS tabs, dispute/maintenance/payments statuses, e-sign field
types, every `.replace('_',' ')` single-underscore display bug),
tenant+pos (credit events, dispute reasons, payment methods, reader
device types, role menus), admin/admin-ops/business/books/pm-company
(role badges, ledger types, payout statuses, filing statuses 's_corp'→
'S Corp', fee plan types). Display text ONLY — option values, keys,
comparisons, payloads untouched. Deliberate exceptions: super-admin
audit-log raw keys (diagnostic), user-authored free text (POS
categories, subtype names). Bonus catch: PropertyLateFeeSection's local
label map was missing hotel_room — the add-policy select couldn't offer
it; now aliased to shared UNIT_TYPE_LABEL. All apps tsc clean; verified
live (schedule timeline 'Apartment', reservations 'CHECKED IN'/'Direct',
console clean). NEW code rule: any enum shown to a user goes through a
*_LABEL map or humanize().

## Decisions made
- Nic: standalone POS must be neutral — never landlord/tenant, say
  customers. (Drove the merged picker rather than a relabel; there is no
  neutral label that preserves a tenant-vs-POS-customer toggle.)
- Claude (flag if wrong): merged-picker options show email for POS
  customers only (tenants list has no email in the /tenants payload).

## Files touched
apps/pos: main.tsx, pages/{POSPage,LoginPage,SignupPage(new),TeamPage(new)},
components/dialogs.tsx(new), components/layout/Layout.tsx(DELETED),
components/NotificationBell.tsx(DELETED).
apps/landlord: pages/POSPage.tsx (picker merge only).
apps/admin: main.tsx, components/dialogs.tsx(new).
apps/business: main.tsx, components/{dialogs.tsx(new),AttachmentList},
15 pages (dialog sweep — see #5).
apps/books: main.tsx, components/dialogs.tsx(new).
apps/pm-company: main.tsx, components/dialogs.tsx(new),
pages/{InvitationsPage,FeePlansPage,StaffPage}.
packages/shared: src/index.ts (STR_FEE_UNIT_TYPES).
api: migrations/20260713{120000_str_pricing_5pct,140000_storage_short_stay_lock}.sql
(new, applied), jobs/platformFeeAccrual.ts(+test), services/platformFee.ts,
services/propertyBooking.ts, routes/units.ts,
routes/{booking-lease-draft,propertyBookingFlow}.test.ts (restored).

## Deferred / next session targets
1. Storefront subdomains + customer-facing recurring product orders
   (explicitly a future build per Nic 2026-07-11).
2. Tenant-facing FIFO polish (remittance_applications per-line display)
   — when tenant-portal flow resumes.
3. Nic-gated: Stripe live keys → FlexPay flip + tap test + launch flips;
   Checkr key; W-56 work-trade walk; DoorLoop tenants export for Oak
   Park; bless Claude-picked business fee numbers (terminal 2.9%+10¢,
   invoice 3.25%+30¢); bless the fold-under-min call (STR fee counts
   toward the $10 floor, doesn't stack on it).

## Watchouts
- Migration 20260713120000's comment header says the 5% applies to
  "apartment / single_family (shared STR_FEE_UNIT_TYPES)" — written
  before Nic corrected the rule to rv_spot-only aggregation. The
  migration is APPLIED (fix-forward only) and its DDL is unaffected;
  the comment is just stale. Live truth = shared
  NIGHTS_AGGREGATION_UNIT_TYPES + this handoff.
- The invite-accept URL still points at the business portal
  (BUSINESS_PORTAL_URL / localhost:3012 fallback in businessUsers.ts).
  Works fine (one credential, staff then sign into POS), but if POS-only
  operators find it confusing, a POS-portal accept page is the fix.
- BusinessRegisterPage empty-state copy says "Add items in your Business
  portal under Inventory" — accurate today; if POS-portal inventory
  management for business mode is built later, update it.
- pos suite untouched (no API changes); landlord + pos tsc clean.

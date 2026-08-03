# SESSION 570 HANDOFF

Continues S569. **Everything below is UNCOMMITTED** — Nic decides the push.
Long session: bank feed → ACH microdeposits → POS dedup → admin gating → a live
tenant-portal walkthrough redesign. All work is typecheck-clean, tested where
noted, and deployed live (API rebuilt + `launchctl kickstart` each time).
Key memories: [[gam-bookkeeping-pl-architecture]], [[gam-ach-microdeposits-not-instant]],
[[gam-pos-dual-mode-and-parity]], [[gam-tenant-portal-redesign]],
[[gam-manual-payment-fee-first-month-waiver]], [[design-not-oak-park-only]].

---

## Shipped (all deployed, tests where noted)

### 1. Bank feed — Stripe Financial Connections (landlord, post-launch feature)
- Migration `20260730250000_bank_feed.sql`: `bank_connections`, `bank_transactions`
  (idempotent on (connection, external_id); statuses needs_review/matched/categorized/ignored),
  `landlord_merchant_rules` (per-landlord merchant memory), `landlords.stripe_fc_customer_id`.
- `services/bankFeed.ts` + `routes/bankFeed.ts` (`/api/bank-feed/*`): FC session (transactions
  scope ONLY — 30¢/acct/mo, $0 balances/owners), finalize, sync+upsert, **auto-match inbound
  deposits to settled `disbursements`** (hidden), **2-click categorize → `landlord_expenses`**
  (reuses unit/common/allocate model → flows into shared `computeLandlordPL`), suggest, ignore,
  disconnect. Landlord ALWAYS confirms + picks scope; auto-suggest pre-fills from merchant memory.
- Landlord `BankFeedPage.tsx` + nav ("Bank Feed") + `@stripe/stripe-js` added. 11 tests green.
- FOLLOW-UP (C4 live): the live FC link + a `financial_connections.account.refreshed_transactions`
  webhook (sync is manual today). CSV import path is stubbed via provider-agnostic model.

### 2. ACH bank verification → FREE MICRODEPOSITS everywhere (killed $1.50/tenant)
See [[gam-ach-microdeposits-not-instant]]. FC **instant** verification bills **$1.50** — underwater
vs the ~$2/unit fee. Switched all 3 setup flows (`lib/stripe.ts createTenantAchSetup`,
`routes/stripe.ts /tenant/setup`, `posCustomerOnboarding.ts`) to `verification_method:'microdeposits'`,
dropped `financial_connections` + `balances`. **Card stays instant.**
- Async: `confirm-setup` / POS `/complete` stamp bank but leave `ach_verified=FALSE` + return pending;
  a NEW **`setup_intent.succeeded` webhook** (webhooks.ts) flips ach_verified for BOTH tenants +
  pos_customers when the deposits clear (idempotent, logs first_sender, sets POS default PM).
- Frontends: payShared + PosCustomerOnboardingPage show "two small deposits on the way"; POS page now
  collects routing/account MANUALLY (FC modal removed). 91 tests green across touched suites.
- Pending-verification **badge** on the tenant pay picker: an unverified bank can't be selected/paid;
  card fallback note. (tenant-level flag = correct; a tenant has one bank.)

### 3. POS dedup — landlord tab === standalone portal (parity enforced)
See [[gam-pos-dual-mode-and-parity]]. The two `POSPage.tsx` (apps/landlord + apps/pos, ~125KB) had
DRIFTED with different fixes each. Nic chose landlord as canonical. **Ported the standalone's S554
cart-quote money-safety fix INTO the landlord file** (mint terminal PI against `/pos/cart-quote`
server total — prevents "card captured, sale 400s"), then copied landlord→standalone → **byte-identical**.
Added optional `propertyIds?/allProperties?/permissions?` to apps/pos `AuthUser` (runtime no-op there).
**`apps/api/src/pos-parity.test.ts` byte-compares them and fails the build if they diverge.** Both apps
typecheck clean. DROPPED per landlord-canonical: standalone's `?tab=inventory` deep-link + items filter
(graceful). True single shared component deferred (needs auth unification).

### 4. Admin financial gating + Support Console rename
- `/api/admin/overview` (income projection + reserve/float) → `requireSuperAdmin` (was any-admin). The
  detailed `/income/*` pies were already super-admin. Test updated + a plain-admin-403 lock test.
- Renamed the **:3009 "Admin Ops" portal → "Support Console"** (title, logo, headers, login, 2FA copy).
- ⚠️ FOUND: **6 PRE-EXISTING admin-test failures** (property-flags/resolve ×3, system-features ×2,
  onboarding/overview data-count) from a prior admin-tightening walkthrough where gating changed but
  tests didn't. NOT mine. These need a **dedicated admin-authz pass** — decide which endpoints the
  regular-admin (portfolio-manager) role keeps (e.g. `/nacha/monitoring`, `/commissions/summary`+
  `/my-referral` [their own comp], `/flexcredit/funnel`, `/connect-readiness/*`).

### 5. Manual-fee waiver — 21-day-from-property-onboarding
See [[gam-manual-payment-fee-first-month-waiver]]. `record-manual` waiver now =
(first satisfied rent, paid manually) **AND** (property onboarded within 21 days —
`properties.created_at > NOW() - 21 days`). Test added, 8 record-manual tests green.
Payer clarified: the $10 STAYS a tenant invoice line item (current code is right); only open piece
is a **landlord-backstop if the tenant never pays it** — Nic undecided, DO NOT build yet.

### 6. Tenant-portal walkthrough redesign (Nic driving) — 4 batches done
Full DONE/REMAINING list in [[gam-tenant-portal-redesign]]. DONE + live:
- **Payments cleanup:** removed the landlord-banking-not-ready banner (payment already holds on the
  platform balance), the no-payment-method banner, the cash/check/MO fee banner; removed **AZ
  state-specific deposit wording** → generic (internal per-state interest logic untouched).
- **Nav consolidation:** Notifications tab → `HomeAlerts` card at top of Home; Preferences + Security
  folded into Profile (already tabbed there). Nav 12→8 tabs.
- **Amenities bookable-only:** route already filtered reservable+active; fixed demo laundry row +
  flipped landlord amenity-form default (form + API) to `reservable=false` (opt-in). Tab auto-hides.
- **Critical notifications locked to email:** `CRITICAL_NOTIFICATION_TYPES=['payment_failed']` in shared;
  server forces email; UI shows locked ✓.

---

## Remaining / next session
- **Tenant portal (from [[gam-tenant-portal-redesign]]):** (1) Entry Requests → fold into Maintenance
  (link to a service call); (2) **Maintenance redesign** — category dropdown (list TBD) + hide priority
  (agent RECOMMENDS only) + persistent tenant history (landlord-immutable); (3) **Inspections overhaul** —
  landlord template + agent fills gaps, tenant-owned move-in/out photos; (4) tenant **email-2FA on ACH**
  (like admin, see [[gam-owner-login-email-2fa]]); (5) Flex feature-request storage (button links nowhere).
- **Admin-authz pass** (the 6 pre-existing test failures + which endpoints portfolio-manager keeps).
- **C4/C5 live-Stripe:** live-fire ACH/card, confirm no $1.50 verification line, wire the **late-ACH-return
  reversal webhook** (only card disputes trigger it today; NSF-at-pull IS handled) + the ACH-pull recovery
  executor. Live FC bank-feed link.
- **Launch blockers unchanged:** N2 Oak Park real landlord email, N3 data entry, N4 KYC (LAUNCH.md §1).
- FlexPay legal docs still describe the old date-based fee (flag from CLAUDE.md) — pre-FlexPay-launch.

## State
All UNCOMMITTED. Known-good, fully deployed, typecheck-clean. Migration `..250000` applied on dev.
Tenant + landlord Safari tabs were open for the walkthrough; POS + Books UI not yet walked.

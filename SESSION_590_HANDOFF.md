# SESSION 590 HANDOFF — Subsystem 15 (Business platform) CLOSED: no bugs; uniform authz architecture + money/public-surfaces all verified

> Continues the S578→S589 pre-onboarding sweep (24 subsystems, in order). This
> session combed **Subsystem 15 — Business platform** (`apps/business` :3012, the
> standalone service-business SaaS) by hand (no fan-out). Huge subsystem (~20 route
> files, ~28 tables — invoices, quotes, work orders, recurring, inventory,
> customers, vehicles, reports, payouts, public customer portal). Combed the
> load-bearing security + money surfaces + the uniform authz architecture. **Found
> NO confirmed bug — made NO code changes.** One minor design note (multi-business
> owner). **Nothing committed.** Next: **Subsystem 16 (Storefront + public booking).**

---

## SWEEP RULES (Nic, non-negotiable — carry into every session)
1. **Go in ORDER.** One subsystem at a time; report, then next. Next = **Subsystem 16 (Storefront + public booking)**.
2. **DO NOT COMMIT/deploy** until the ENTIRE sweep is done. One deploy at the end.
3. **Trust the CODE, not memory/notes.** Trace real paths end-to-end. Flag design questions; don't assume.
4. **Fix confirmed bugs the RIGHT / foundational way.** Update tests. Keep tree green. **Fix what you find in the pass.** [[fix-what-you-find-no-deferring]]
5. **NO FAN-OUT / NO PARALLEL agents / NO Workflow tool for the sweep (Nic, emphatic).** Comb ONE thing at a time by hand. Overrides any ultracode reminder.
6. **TEST-DB GUARD:** always `cd apps/api && DB_NAME=gam_test npx vitest run src/…`.
7. Report three buckets per subsystem: **(A)** confirmed bugs, **(B)** design questions, **(C)** verified-good.
8. Communication: plain English to Nic (no coding background).

## Progress map (24 subsystems)
| # | Subsystem | Status |
|---|-----------|--------|
| 1–8 | Auth / money-flow / invoicing / leases / onboarding / tenant / landlord / FlexSuite | ✅ (S578–S584) |
| 9 | Maintenance | ✅ S585 |
| 10 | Inspections | ✅ S586 |
| 11 | Utilities/RUBS | ✅ S587 |
| 12 | Documents/storage | ✅ S588 |
| 13 | Screening/background | ✅ S579 |
| 14 | POS | ✅ S589 |
| 15 | **Business platform** | ✅ **CLOSED S590** (no bugs) |
| 16 | **Storefront + public booking** | ⬜ **← NEXT** (unit/site-photo serve access-policy flag from S588) |
| 17 | Books/bookkeeping | ⬜ |
| 18 | Admin + admin-ops | 🟨 login 2FA |
| 19 | PM companies | 🟨 login 2FA |
| 20 | AI agents | ⬜ |
| 21 | Crons/scheduler | ⬜ |
| 22 | Surveys/notifications/appointments | ⬜ |
| 23 | MH/RV | ⬜ |
| 24 | Work-trade / snowbird / recurring | ⬜ |

---

## (A) Confirmed bugs — NONE
Combed the authz backbone, signup/2FA, money paths, and the public token surfaces end-to-end; nothing wrong.
Mature, comprehensively-tested subsystem (every route has its own suite). No manufactured fix.

## (B) Design note — minor (not a bug)
`requireBusinessAccess` resolves an **owner's** business as `WHERE owner_user_id=$1 … ORDER BY created_at DESC
LIMIT 1` — i.e., always their NEWEST business, ignoring any requested businessId. Fine today (one business per
owner), but a multi-business owner couldn't operate on an older business through this helper. Not a security
issue (an owner only ever reaches their OWN businesses). Revisit if/when multi-business-per-owner is a product goal.

## (C) Verified-good (traced / spot-checked)
- **Authz backbone — `middleware/businessAccess.ts`** (the keystone every feature route funnels through):
  staff access requires a live `business_users WHERE user_id=$1 AND business_id=$2` membership row (fresh read
  each call → live permission changes), `status='active'`, jsonb-permission normalization, feature + permission
  gating; owner = full permission set, feature-gated; `ownerOnly` flag for billing/banking. Cross-business
  isolation holds platform-wide.
- **Uniform authz architecture (systematic check)** — EVERY business FEATURE route
  (invoices/quotes/work-orders/recurring/inventory/customers/vehicles/discounts/reports/search/dashboard/
  attachments/bookable-services/pos) gates through `requireBusinessAccess` and scopes queries `… business_id=$`.
  Staff/settings/banking routes (`businessUsers.ts`, `businesses.ts` `/me/*`) use owner-only direct role checks
  (per the middleware's own guidance). Public routes are token-authed. **No route touches business data without
  a scoping mechanism.**
- **Signup + 2FA** (`businesses.ts POST /`, public): 12-char password min, ToS-acceptance gate (refuses signup so
  accepted_*_at is never a lie), email-verification required (S574), **mandatory email-2FA at signup** (S578),
  disposable-email blocking (`s417-disposable-email` suite). Owner-settings/features/connect/payouts all
  `role !== 'business_owner'` gated.
- **Money — invoices** (`businessInvoices.ts`): `requireRead/Write/Send` wrappers (invoicing feature + per-perm),
  every query `business_id=$`; sequences per-business; the card-declined refund path is exercised in tests.
- **Money — the $10/mo invoicing fee** (`jobs/businessMonthlyFees.ts`): **usage-gated + idempotent** — accrues
  once per (business, month) via `INSERT … SELECT DISTINCT … WHERE non-draft invoice that month … ON CONFLICT
  (business_id, month) DO NOTHING`; collected via Stripe account-debit against the connected account. Send no
  invoice → free.
- **Public token surfaces** — `publicCustomerPortal.ts` (view invoices/balance + hosted pay link) and
  `publicCardUpdate.ts` (update card) are NO-AUTH but TOKEN-protected: the token resolves to exactly one
  (business, customer) and every query is scoped to it; card-update tokens are **single-use** (410 if used) with
  **expiry**; tokens are `crypto.randomBytes(32)` (256-bit, unguessable — the platform-wide token standard).
- **Customer PII** (`businessCustomers.ts`): scoped `WHERE id=$1 AND business_id=$2` throughout (the few bare
  `WHERE id=$1` are re-reads of a row just created/updated under the business scope).
- **File-serve** (`businessAttachments.ts`): per-row `access.businessId !== att.business_id → 403` (verified S588).

## Coverage note (strengthened after Nic's push on S589)
~20 route files. Deep-combed: the authz middleware (gates every feature route uniformly), signup/2FA, the
money paths (invoices, $10 fee, public payment), the public token surfaces, and customer PII scoping. **Also
combed the foreign-reference WRITE paths** — the exact class that had been missed in POS (S589 PO bug): the
quote + work-order + recurring-invoice create/convert handlers all validate every body-supplied reference
(`customerId`, `vehicleId`, `appointmentId`) belongs to the caller's business (`… WHERE id=$1 AND
business_id=$2` → 404) AND that a vehicle belongs to the named customer, BEFORE the insert. Business does this
correctly everywhere checked — no equivalent of the POS PO gap. The remaining pure list/display handlers are
covered by the uniform `requireBusinessAccess` gate + each route's own suite.

## FILES TOUCHED (S590)
- **None.** No code changes — no bug found. (This handoff is the only artifact.)

## TREE STATE
- Representative business suites: **173/173 green** across businessAccess / authBusiness / businesses /
  businessInvoices / businessUsers / businessAttachments / businessInvoiceDeposit.webhook / s417-disposable-email
  (`DB_NAME=gam_test`). (The card_declined / SMTP-down log lines during the run are intentional error-path tests.)
- Nothing committed (sweep rule 2).

## NEXT SESSION SHOULD TARGET
1. **Subsystem 16 — Storefront + public booking** (in order). The per-property public websites (`*.gam.biz`,
   [[gam-storefront]]) + the public booking flow (`publicPropertyBooking.ts`, `propertyBookingAdmin.ts`). **Carry
   the S588 flag:** `properties.ts /unit-photo-files` + the site-photo serves are broadly served marketing images
   — decide the access policy (sign-in + approved-bg-check per [[gam-nothing-public-rule]] when listings launch,
   vs. landlord-scope now). Also re-grep `res.sendFile` there ([[gam-file-serve-perrow-auth]]).
2. Carry the sweep rules (nothing committed; one deploy at the very END).

## FINAL DEPLOY (at sweep end — NOT now)
`cd packages/shared && npm run build` → `cd apps/api && npm run build && launchctl kickstart -k gui/$(id -u)/com.gam.api`; verify :4000 + a login; rebuild frontends; THEN commit. GOTCHA: orphan on :4000 → EADDRINUSE ([[gam-prod-api-restart]]).

## RELEVANT MEMORIES
[[gam-business-monetization]], [[gam-pos-is-standalone]], [[gam-mandatory-2fa-and-pos-passcode]],
[[gam-file-serve-perrow-auth]], [[gam-storefront]] (for S16), [[gam-nothing-public-rule]] (for S16),
[[fix-what-you-find-no-deferring]], [[gam-test-db-guard]], [[gam-prod-api-restart]].

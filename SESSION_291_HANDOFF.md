# Session 291 — closed

## Theme

Eight discrete pieces shipped — biggest session by surface count
in recent memory. Migration / onboarding tooling went from "you can
import tenants from a generic template" to "drop three CSVs and
your full portfolio + payment history is live." Frontend Sentry
went from API-only to 9-app coverage. Legal docs went from "TBD,
need a lawyer" to "drafted and gated at signup." Test coverage on
CSV imports went from zero to 67 cases.

Closed at Nic's call ("do we need to clear before next session?")
— context discipline triggered after a high-throughput session.

## Items shipped

### Phase A — Property + Unit CSV import

- `apps/api/src/lib/csvImportMappings.ts` — parallel
  `GAM_PROPERTY_CANONICAL_HEADERS` + per-platform mapping registry
  for all 8 platforms. `applyPropertyMapping`,
  `buildPropertyTemplateCsv`, `getPropertyPlatformConfig` exported.
- `apps/api/src/routes/landlords.ts` — three new endpoints:
  `GET/POST /me/onboard-properties-csv/{template,validate,commit}`.
  One row = one unit; property find-or-created on `(name, street1)`.
  Each new property gets a default `property_allocation_rule`
  (`ach_fee_payer='tenant'`, `card_fee_payer='tenant'`,
  `platform_fee_payer='landlord'`).
- `apps/landlord/src/pages/PropertyOnboardingPage.tsx` (new, ~360
  lines) — 4-step wizard pattern (pick platform → download template
  → upload + validate → preview with editable cells + commit). Wired
  at `/property-onboarding`. "Bulk import CSV" CTA on
  `PropertiesPage` next to "Add Property".

### Phase A — tenant CSV outstanding_balance

- `csvImportMappings.ts` — added `outstanding_balance` to
  `GAM_CANONICAL_HEADERS` + per-platform aliases for each of the 8
  platforms (Buildium "Outstanding Balance" / AppFolio "Past Due
  Amount" / DoorLoop "Balance" etc.). Generic template now includes
  the column.
- `landlords.ts` `/onboard-tenants-csv/validate` parses balance
  with `$`/`,`/whitespace stripping. Commit writes a pending
  invoice (`subtotal_rent=balance`, `due_date=CURRENT_DATE`, notes
  "Imported opening balance from prior platform") for any positive
  value. Sequential `invoice_sequences` allocation. Zero/negative
  values skip silently. Idempotent via `(lease_id, due_date)` unique
  constraint.
- `TenantOnboardingPage.tsx` — added "Opening balance (carry-over
  AR)" field to the lease section of the preview. Misleading
  "Generic ready now, others coming" copy on step 1 replaced with
  accurate text naming all 8 platforms.

### Frontend Sentry rollout (9 apps)

- `@sentry/react ^8.55.2` added to admin, admin-ops, books,
  landlord, listings, pm-company, pos, property-intel, tenant
  package.json files. Marketing skipped intentionally (static HTML).
- Each app gets `src/lib/sentry.ts` (identical contents): init
  guarded on `import.meta.env.VITE_SENTRY_DSN`, `beforeSend` filters
  4xx (axios `err.response.status` + raw `err.statusCode`),
  `sendDefaultPii: false`, tracing off (`tracesSampleRate: 0`).
  Same posture as the api-side `instrument.ts` from S273.
- Each `main.tsx` imports `./lib/sentry` at the top (side-effect
  init) and wraps the root render with `<SentryErrorBoundary>` +
  a "Something went wrong. The error has been reported." fallback
  with a Reload button. Landlord's pre-existing inline ErrorBoundary
  kept (inner recovery for non-fatal errors); Sentry sits outside.
- `.env.example` documents `VITE_SENTRY_DSN` + `VITE_SENTRY_RELEASE`
  with a note that one shared DSN works across portals
  (distinguished by Sentry's environment + auto-attached release).

### Phase B — Payment History import

- Migration `20260515090000_payments_import_source.sql` — adds
  `payments.import_source text NULL` + `payments.imported_at
  timestamptz NULL`, plus a partial index
  `idx_payments_import_source WHERE import_source IS NOT NULL`.
  No backfill — native GAM payments keep both columns NULL.
- `csvImportMappings.ts` — parallel
  `GAM_PAYMENT_HISTORY_CANONICAL_HEADERS` + per-platform mapping
  registry for all 8 platforms. `applyPaymentMapping`,
  `buildPaymentTemplateCsv`, `getPaymentPlatformConfig` exported.
- `landlords.ts` — three new endpoints:
  `GET/POST /me/onboard-payment-history-csv/{template,validate,commit}`.
  Validate resolves each row by email → active tenant → active lease
  in this landlord's portfolio. Multi-lease ambiguity disambiguated
  via property_name + unit_number columns. Property/unit mismatch
  against resolved lease surfaces as warning (uses the resolved
  lease). Negative amounts blocked — refunds/credits out of scope.
  Payment_type normalization handles "Rent Payment" / "Late Fee" /
  "Pet Fee" / etc. → CHECK-constraint-compliant types. Commit
  writes `payments` row with `status='settled'`,
  `settled_at=paid_at=processed_at=payment_date`,
  `import_source=<platform>`, notes carry `method:` and `ref:`
  breadcrumbs. Defense-in-depth lease-ownership re-check before
  writing.
- `apps/landlord/src/pages/PaymentHistoryOnboardingPage.tsx` (new,
  ~330 lines) — same wizard shape as PropertyOnboardingPage. Wired
  at `/payment-history-onboarding`. "Import payment history" button
  on `PaymentsPage` header.

### CSV mapping research + fixes (round 1: AppFolio + Propertyware)

After Phase A + Phase B landed, ran a research agent to verify
mappings against documented competitor exports. The agent found
HIGH-confidence column gaps for AppFolio and Propertyware. Fixes
applied:

- AppFolio tenant mapping: `Emails` (plural — comma-separated multi-
  email cell), `Phone Numbers` (plural), bare `Move-in` / `Move-out`.
- AppFolio property mapping: every `Unit *` address variant —
  `Unit Street Address 1/2`, `Unit Address`, `Unit Address Cont.`,
  `Unit City`, `Unit State`, `Unit Zip`, `Unit Postal Code`, `Unit
  ID`. Pre-fix, every AppFolio property address was silently
  dropped — the biggest single-platform gap.
- Propertyware tenant mapping: phone columns with literal trailing
  `#` — `Home Phone #`, `Mobile Phone #`, `Work Phone #`,
  `Cell Phone #`. Every Propertyware phone was silently dropping.
- Propertyware property mapping: `Unit Address`, `Unit Address Cont.`,
  `Address Cont.`, `Unit City`, `Unit State`, `Unit Zip`.

### CSV mapping research + fixes (round 2: Buildium + RentManager)

After Phase B + Sentry + legal docs, ran a second research agent
focused on platforms the first round flagged as LOW-confidence. The
agent found verbatim column-name transcriptions in RentCheck's
import-template docs for Buildium and RentManager. Fixes applied:

- Buildium tenant mapping: `Login email`, bare `Mobile`. Pre-fix,
  every Buildium resident email was silently dropping.
- Buildium property mapping: `Unit address line 1/2`, `Street
  Address line 1/2`, `City/Locality`, `State/Province/Territory`,
  `Postal code`, `Sub type`, `Unit number`. Pre-fix, every Buildium
  property address was silently dropping.
- Buildium `Unit address line 3` intentionally NOT added — GAM only
  has street1 + street2; concatenating risks malformed addresses;
  landlords can hand-edit street2 on preview.
- RentManager property mapping: `Street1` / `Street 1`, `Street2` /
  `Street 2`, `PostalCode` (concatenated). Pre-fix, every
  RentManager property address was silently dropping.

### Legal documents

- `legal/TERMS_OF_SERVICE.md` (~5,150 words, 23 sections) — drafted
  to Nic's directives: Gold Asset Management LLC at 2843 East
  Frontage Road Amado AZ 85645, Delaware LLC, AAA arbitration in
  Wilmington + class action waiver + 30-day opt-out + small-claims
  carve-out, liability cap = platform fees paid in 90 days before
  the earlier of (i) the claim event or (ii) account termination,
  with explicit exclusions: processing fees, banking fees, network
  fees, and any third-party pass-through are NEVER recoverable
  under any theory. Refund posture: GAM refunds nothing for
  services rendered; landlord may refund tenants at their
  discretion for non-deposit charges; tenant deposits in GAM
  custody returned per deposit-return flow. Short-term-stay
  aggregate fee ($2 per aggregate 30 booked nights, cancellations
  do not reverse the accrual) added to §6.2 fee schedule.
  18+ minimum.
- `legal/PRIVACY_POLICY.md` (~3,910 words, 14 sections + CCPA
  appendix) — applies to all Users; **indefinite retention**;
  deletion happens only when legally compelled (court order,
  regulator mandate, federal/state law mandate with no exception
  available, or a state privacy-law deletion request where no
  statutory exception applies to any portion). GAM applies each
  available exception maximally. §8.1 separates "close your
  account" (ends access, does NOT delete data) from "submit a
  deletion request" (evaluated against statutory exceptions).
  CCPA category appendix table.

**Lawyer review recommended** before broad public commercial
rollout — specifically the arbitration + limitation-of-liability
clauses, which most often fail when actually challenged in state
court without lawyer-tightened drafting. Not a blocker for
soft-launch with a known tester.

### Legal engineering scaffolding

- Migration `20260515110000_user_legal_acceptance.sql` — adds
  `users.accepted_tos_at` + `users.accepted_privacy_at` (both
  `timestamptz NULL`). No backfill. Distinction NULL vs timestamp
  is meaningful: pre-acceptance-gate users keep NULL until re-
  prompted.
- `auth.ts` `/register` — `acceptedTerms: true` now required in
  body; refuses if missing/false; INSERT stamps both columns to
  NOW(). `/register-prospect` (tenant background-check intake)
  same gate, same stamp.
- `tenants.ts` `/accept-invite` — `acceptedTerms: true` required;
  UPDATE stamps both columns to NOW(). This means
  landlord-created tenant accounts (CSV onboarding, e-sign flow)
  carry NULL acceptance until the tenant activates — landlord
  can't accept on their behalf.
- `apps/marketing/server.js` — added `marked` dep, plus `/terms`
  and `/privacy` routes that read the MD files at startup, render
  via marked, wrap in a dark/gold themed HTML template matching
  the landing-page aesthetic (Syne / DM Sans / DM Mono fonts, gold
  accents, sticky nav, footer with cross-links). Inter-doc `.md`
  references auto-rewritten to `/terms` / `/privacy`. Cached at
  module load.
- Signup gates on four surfaces: landlord `RegisterPage` (replaced
  the placeholder "Platform Participation Agreement pending
  attorney review" copy with real links), tenant
  `BackgroundCheckPage` step 4 (alongside the existing
  credit/criminal consent checkboxes), tenant `AcceptInvitePage`
  (alongside the existing SSI/SSDI checkbox), pm-company
  `RegisterPage`. The pm-company page also had a pre-existing bug
  (snake_case body + missing role) that fix-it-right caught and
  patched.
- `.env.example` documents `VITE_MARKETING_URL` so each portal's
  prod build can point at the real marketing domain.

### CSV import test coverage

- `src/lib/csvImportMappings.test.ts` (new, 35 cases) — pure-unit
  tests of the mapping module. No DB. Covers applyMapping /
  applyPropertyMapping / applyPaymentMapping translation for each
  platform, case-insensitive matching, whitespace-trimmed alias
  matching, first-alias-wins, ignoredColumns dropped silently, all
  the S29X round-1 + round-2 fixes locked in with explicit
  regression tests.
- `src/routes/csvImportProperty.test.ts` (new, 14 cases) —
  integration tests. Happy path, find-or-create idempotency,
  in-batch dup blocker, existing-unit warn+skip, missing-required-
  field blockers, default allocation rule values, blocker rejects
  commit.
- `src/routes/csvImportTenantBalance.test.ts` (new, 9 cases) —
  outstanding-balance opening-invoice path. Currency-formatted
  ($1,234.56) parsing, negative/zero/missing balance handling,
  invoice landing with correct subtotal_rent + notes + due_date,
  sequential invoice_sequences allocation, Buildium "Outstanding
  Balance" alias translation. Mocks emailTenantOnboarded.
- `src/routes/csvImportPaymentHistory.test.ts` (new, 13 cases) —
  full integration tests. Email→active-lease resolution,
  no-active-lease blocker, negative/zero amount blockers, invalid-
  date blocker, payment_type vocab normalization, unknown-type
  blocker, Buildium column translation, commit writes payments rows
  with status=settled + import_source + settled_at + imported_at,
  blocker rejects commit, cross-landlord lease ownership 403.

## Files touched (S291)

```
apps/api/src/db/migrations/
  20260515090000_payments_import_source.sql           (new)
  20260515110000_user_legal_acceptance.sql            (new)
apps/api/src/db/schema.sql                            (regen)

apps/api/src/lib/
  csvImportMappings.ts                                (massive — 3 new
                                                       parallel registries
                                                       for property + payment,
                                                       plus alias fixes for
                                                       AppFolio/Propertyware/
                                                       Buildium/RentManager)
  csvImportMappings.test.ts                           (new, 35 cases)

apps/api/src/routes/
  landlords.ts                                        (~+700 lines —
                                                       property CSV endpoints,
                                                       payment-history CSV
                                                       endpoints, outstanding_
                                                       balance commit logic)
  auth.ts                                             (acceptedTerms gate +
                                                       stamp on register +
                                                       register-prospect)
  tenants.ts                                          (acceptedTerms gate +
                                                       stamp on accept-invite)
  csvImportProperty.test.ts                           (new, 14 cases)
  csvImportTenantBalance.test.ts                      (new, 9 cases)
  csvImportPaymentHistory.test.ts                     (new, 13 cases)
  emailVerification.test.ts                           (+ acceptedTerms: true
                                                       on register call)

apps/landlord/src/
  main.tsx                                            (PropertyOnboardingPage +
                                                       PaymentHistoryOnboardingPage
                                                       imports + routes; Sentry
                                                       wrap around root)
  lib/sentry.ts                                       (new)
  pages/PropertyOnboardingPage.tsx                    (new, ~360 lines)
  pages/PaymentHistoryOnboardingPage.tsx              (new, ~330 lines)
  pages/PropertiesPage.tsx                            ("Bulk import CSV" CTA +
                                                       useNavigate)
  pages/PaymentsPage.tsx                              ("Import payment history"
                                                       CTA + useNavigate)
  pages/TenantOnboardingPage.tsx                      (outstandingBalance field
                                                       in preview; copy fix)
  pages/RegisterPage.tsx                              (real ToS/Privacy links +
                                                       acceptedTerms: true)
  package.json                                        (+@sentry/react)

apps/tenant/src/
  main.tsx                                            (Sentry wrap)
  lib/sentry.ts                                       (new)
  pages/BackgroundCheckPage.tsx                       (acceptedTerms checkbox +
                                                       canNext gate + body)
  pages/AcceptInvitePage.tsx                          (acceptedTerms checkbox +
                                                       gate + body)
  package.json                                        (+@sentry/react)

apps/pm-company/src/
  main.tsx                                            (Sentry wrap)
  lib/sentry.ts                                       (new)
  pages/RegisterPage.tsx                              (acceptedTerms checkbox +
                                                       camelCase + role fix +
                                                       acceptedTerms: true)
  package.json                                        (+@sentry/react)

apps/{admin,admin-ops,books,listings,pos,property-intel}/src/
  main.tsx                                            (Sentry wrap on each)
  lib/sentry.ts                                       (new on each)
  package.json                                        (+@sentry/react on each)

apps/marketing/
  package.json                                        (+marked)
  server.js                                           (rewritten — /terms +
                                                       /privacy routes with
                                                       themed HTML wrapper)

legal/
  TERMS_OF_SERVICE.md                                 (new, ~5,150 words)
  PRIVACY_POLICY.md                                   (new, ~3,910 words)

.env.example                                          (VITE_SENTRY_DSN +
                                                       VITE_SENTRY_RELEASE +
                                                       VITE_MARKETING_URL docs)

DEFERRED.md                                           (tombstones for legal +
                                                       frontend Sentry +
                                                       CSV imports; updated
                                                       top-line state)

SESSION_291_HANDOFF.md                                (this file)
```

## Decisions made during build

| Question | Decision |
|---|---|
| Lawyer-drafted vs Claude-drafted ToS + Privacy Policy? | **Claude drafts to Nic's directives + lawyer review of arbitration / limitation-of-liability before broad commercial rollout.** Nic pushed back on the "needs a lawyer" framing for descriptive operational text; agreed that risk-allocation clauses still benefit from lawyer review. |
| Retention policy framing in Privacy Policy? | **Indefinite retention by default; deletion only when legally compelled.** Nic corrected the initial "delete on statutory right" framing — having a right to request is not the same as being legally compelled. GAM applies every available exception maximally. |
| Liability cap dollar value? | **Platform fees paid in 90 days before the claim event or account termination, whichever earlier. Zero if no fees in that window. Processing/banking/3rd-party fees explicitly excluded.** Tighter than the initial "12 months or $100" draft. Nic specified. |
| Buildium 3rd address line — what to do with it? | **Drop it.** GAM only has street1 + street2; concatenating risks malformed output ("Apt 4B / Building C" as a single street2 value). Landlords can hand-edit street2 on preview if line 3 was load-bearing. Documented in the alias comment. |
| Where do the legal MD files live? | **`/legal/` directory at repo root.** Cleaner than colocating with marketing; marketing reads them at startup. |
| One Sentry DSN for all frontend apps vs one per portal? | **Either works.** `.env.example` documents both; a shared DSN distinguishes via Sentry's environment + auto-attached release. Per-portal DSN gives finer per-app quota control. Nic's choice at deploy. |
| Test the unproven Buildium mappings, or wait for real export? | **Test the documented behavior now.** Tests lock in the current mappings; if a real export surfaces a column we don't cover, we add aliases and the existing tests still pass (aliases are purely additive). |
| Marketing site — convert to multi-page SPA or just serve MD-rendered HTML from server.js? | **Serve from server.js.** The marketing app is a deliberately tiny static-HTML server; adding React + a build step for two legal pages would balloon the deploy surface. `marked` is one dep, ~50KB. |

## Verification

- `cd apps/api && npx tsc -b` → clean (0 errors).
- `cd apps/landlord && npx tsc --noEmit` → clean.
- `cd apps/tenant && npx tsc --noEmit` → clean.
- `cd apps/pm-company && npx tsc --noEmit` → clean.
- `cd apps/admin && npx tsc --noEmit` → clean.
- `cd apps/admin-ops && npx tsc --noEmit` → clean.
- `cd apps/books && npx tsc --noEmit` → clean.
- `cd apps/listings && npx tsc --noEmit` → clean.
- `cd apps/pm-company && npx tsc --noEmit` → clean.
- `cd apps/pos && npx tsc --noEmit` → clean.
- `cd apps/property-intel && npx tsc --noEmit` → clean.
- `cd apps/api && npm test` → **217 / 217 passing** across 18 test
  files. Was 146/14 at session start; +71 tests across 4 new files
  + 1 patched existing test.
- `cd apps/pos && npm test` → 15/15 unchanged.
- `curl http://localhost:3004/terms` → 200, ~41KB rendered HTML.
- `curl http://localhost:3004/privacy` → 200, ~34KB rendered HTML.
- Migrations applied to dev DB:
  - `20260515090000_payments_import_source.sql` ✓
  - `20260515110000_user_legal_acceptance.sql` ✓

## Items deferred (still on docket)

- **Lawyer review of ToS arbitration + liability cap clauses** —
  before broad public rollout. Cheap insurance ($300-500) against
  state-court invalidation of poorly-drafted boilerplate. Not a
  soft-launch blocker.
- **Re-acceptance prompt for pre-acceptance-gate users** — those
  users have NULL on `accepted_tos_at` / `accepted_privacy_at`. A
  prompt at next login that captures their consent. Small session.
  Flagged in the migration comment.
- **CSV import mappings — real-export validation** — Buildium /
  RentManager / DoorLoop / Yardi / Rentec / TenantCloud mappings
  are built from documentation, not from real customer exports.
  Highest-likelihood column-variant miss when a real migration
  happens: DoorLoop (concierge migration, no public template) and
  Yardi (heavily user-customized rent rolls). Nic should grab
  sample exports from any trial accounts he encounters.
- **Host pick + deploy config (Render / Fly / Railway)** — biggest
  remaining launch unblocker. Needs Nic to call which host. ~1
  session of config work once decided.
- **2FA frontend on the other 4 portals** (admin-ops, landlord,
  pm-company, tenant) — still walkthrough-blocked on S290 admin
  portal validation. Pattern is mechanical to fan out once admin
  is validated.
- **Frontend monitoring (PostHog / Amplitude / Mixpanel)** — zero
  visibility into user behavior. Post-launch concern.
- **Production cron runner** — `node-cron` in-process loses
  pending firings on restart. Host-dependent solution.
- **Database backups + PITR** — host-dependent.

## Nic-pending (unchanged)

- Stripe live keys (agreement signed; just operational flip).
- Resend domain verification (DNS records pending at registrar).
- Plaid production keys.
- Stripe Terminal hardware.
- Checkr Partner credentials.

## What S292 should target

Top of the queue (in rough priority order):

1. **Host pick + Render deploy config** — biggest unblocker. Once
   you pick a host, ~1 session of config work + DB backup setup.
2. **Re-acceptance prompt for pre-S291 users** — small session,
   closes the NULL-acceptance gap.
3. **2FA fan-out to other portals** — assuming the admin 2FA
   walkthrough has now happened and the pattern is validated.
4. **Real-export validation on CSV mappings** — only if Nic has
   pulled sample exports from any trial accounts. Run them through
   `validate` and report unmapped columns; add aliases as needed.

---

End of S291 handoff. Closed clean.

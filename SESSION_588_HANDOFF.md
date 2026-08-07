# SESSION 588 HANDOFF — Subsystem 12 (Documents/storage) CLOSED: app-wide file-serve authorization audit — 2 cross-tenant gaps fixed (expense receipts, tenant walkthrough media)

> Continues the S578→S587 pre-onboarding sweep (24 subsystems, in order). This
> session combed **Subsystem 12 — Documents/storage** by hand (no fan-out). The
> core `documents` route is well-hardened, so the high-value work was an **app-wide
> audit of every file-serve route** (~20 `res.sendFile`/stream sites) for the
> per-row authorization gap found in inspections (S586). Found + fixed **2 real
> cross-tenant leaks** — expense receipts and tenant walkthrough media — both
> served any file by filename behind only router-level auth. Everything sensitive
> else is properly per-row scoped. **Nothing committed.** Next: **Subsystem 14 (POS)**
> (13 Screening already ✅).

---

## SWEEP RULES (Nic, non-negotiable — carry into every session)
1. **Go in ORDER.** One subsystem at a time; report, then next. Next = **Subsystem 14 (POS)** (13 done).
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
| 12 | **Documents/storage** | ✅ **CLOSED S588** (2 file-serve gaps fixed) |
| 13 | Screening/background | ✅ S579 (minor note below) |
| 14 | **POS** | ⬜ **← NEXT** |
| 15 | Business platform | 🟨 login/signup 2FA |
| 16 | Storefront + public booking | ⬜ (see unit/site-photo serve flag below) |
| 17 | Books/bookkeeping | ⬜ |
| 18 | Admin + admin-ops | 🟨 login 2FA |
| 19 | PM companies | 🟨 login 2FA |
| 20 | AI agents | ⬜ |
| 21 | Crons/scheduler | ⬜ |
| 22 | Surveys/notifications/appointments | ⬜ |
| 23 | MH/RV | ⬜ |
| 24 | Work-trade / snowbird / recurring | ⬜ |

---

## (A) Confirmed bugs — 2 FIXED (cross-tenant file-serve leaks)
Both were the same class as the S586 inspection photo gap: a `GET /…-files/:filename` route serving ANY
file in its upload dir by filename behind only the router-level `requireAuth`, with NO per-row check —
so any authenticated user who obtained/guessed a filename could fetch another tenant's/landlord's file.
(Filenames are unguessable random, so these were defense-in-depth gaps — but the files are sensitive and
every sibling serve route already scopes per-row, so it was a clear oversight.)

1. **Expense receipts** — `routes/expenses.ts` `GET /receipt-files/:filename`. Financial receipts (vendor
   invoices/amounts). **Fix:** look up `landlord_expenses WHERE receipt_url = …`, then
   `canAccessLandlordResource(user, landlord_id)` (admins pass). Test added (owning landlord 200, other 403).
2. **Tenant walkthrough media** — `routes/tenantWalkthroughs.ts` `GET /media-files/:filename`. A tenant's
   private photos/videos of their unit. **Fix:** look up `tenant_walkthrough_media WHERE file_url = …`; the
   owning tenant, or the landlord/scoped staff of the unit, may view it. Test added (owning tenant 200, other 403).

## (B) Design flag — unit/property marketing-photo serves are broad (Nic's call, tied to the listings launch)
Distinct from (A): `routes/properties.ts` `GET /unit-photo-files/:filename`, `routes/propertyBookingAdmin.ts`
site-photo serve, and the **public** `routes/publicPropertyBooking.ts` site-photo serve all serve
marketing/listing IMAGES broadly (unit-photo-files is behind auth but not landlord-scoped; the code comment
there explicitly says "landlord staff today; approved applicants when the listings surface launches"). These
are low-sensitivity images with a **deliberately-broadening** access model (approved-applicant listings not
built yet), so I did NOT change them — the access policy is a strategic/in-flux decision.
**Recommendation:** when the listings/approved-applicant surface is built (Subsystem 16), gate these on
sign-in + approved-bg-check per [[gam-nothing-public-rule]]; until then, consider landlord-scoping
`unit-photo-files` to match its own "landlord staff today" comment. Not launch-blocking.

## (C) Verified-good (file-serve authorization — the full app-wide audit)
- **`documents.ts`** — `GET /:id/file` gates the doc lookup through the same role-scoped `scopeFor` filter
  (tenant → `tenant_id = them`, landlord → `landlord_id = them`, staff → `landlordId`, admin → all), plus a
  traversal guard (`abs.startsWith(uploadsRoot + sep)`). Upload perm-gated + tagged-unit ownership checked.
  The `documents` type set (lease/addendum/checklists/notice/receipt/other) is all tenant-facing — no
  "internal" doc a tenant could over-read.
- **Properly per-row scoped serves:** `background.ts` ID-docs (applicant OR that landlord), `businessAttachments.ts`
  (business_id), `tenants.ts` flexpay proof (tenant's own inquiry) + admin proof (super_admin), `landlords.ts`
  imported-tenant PDF (id + landlord_id), `esign.ts` lease PDFs (landlord-owns OR is a signer), `leases.ts`
  addendum (per-row `authorized` check). Inspections (fixed S586) + maintenance media (S585) already scoped.
- **Acceptable broad serves:** `tenants.ts` **avatars** (`path.basename` traversal-safe, Content-Type pinned +
  nosniff) — profile images are broadly shared by design.
- **Frontend `DocumentsPage.tsx`** — camelize-clean, 0 native dialogs, 0 raw-enum `.replace`.

## Minor note (Subsystem 13 territory — not fixed here)
- `background.ts` `/id-files/:filename` authorizes applicant-OR-landlord; since staff `profileId` resolves to
  their `landlordId`, ANY of that landlord's staff (incl. a maintenance worker) could fetch an applicant's ID
  document. It IS auth'd + landlord-scoped, but for SSN-adjacent PII that staff breadth may be too wide.
  Screening is being redesigned around Checkr hosted intake ([[gam-checkr-applicant-flow-redesign]]) which
  strips the legacy PII/ID surface — likely moot, but flag it when that lands.

## FILES TOUCHED (S588)
- `apps/api/src/routes/expenses.ts` — `receipt-files` per-row auth (+ `canAccessLandlordResource`/`queryOne` imports).
- `apps/api/src/routes/expenses.test.ts` — +1 auth test.
- `apps/api/src/routes/tenantWalkthroughs.ts` — `media-files` per-row auth (+ `canAccessLandlordResource` import).
- `apps/api/src/routes/tenantWalkthroughs.test.ts` — +1 auth test.
- No schema, no migrations, no `@gam/shared`, no frontend changes.

## TREE STATE
- Fixed-route suites + documents/esign coverage: **green** (expenses + tenantWalkthroughs + esign-documents-files
  = 28/28, `DB_NAME=gam_test`). API tsc clean.
- Nothing committed (sweep rule 2).

## NEXT SESSION SHOULD TARGET
1. **Subsystem 14 — POS** (in order; 13 Screening already ✅ S579). The standalone POS product ([[gam-pos-is-standalone]],
   [[gam-pos-dual-mode-and-parity]]) — register + cart + terminal capture + cashier passcode/terminal-lock
   ([[gam-mandatory-2fa-and-pos-passcode]]) + the FlexCharge tie-in (combed S583/S584). `routes/pos.ts`,
   `services/*pos*`, the POS app. Watch for the landlord-register vs standalone-register parity/drift.
2. Carry the sweep rules (nothing committed; one deploy at the very END).

## FINAL DEPLOY (at sweep end — NOT now)
`cd packages/shared && npm run build` → `cd apps/api && npm run build && launchctl kickstart -k gui/$(id -u)/com.gam.api`; verify :4000 + a login; rebuild frontends; THEN commit. GOTCHA: orphan on :4000 → EADDRINUSE ([[gam-prod-api-restart]]).

## RELEVANT MEMORIES
[[gam-nothing-public-rule]] (every file via authed route — the core of this subsystem), [[gam-checkr-applicant-flow-redesign]] (for the id-files note), [[gam-no-native-dialogs]], [[gam-no-raw-enums-in-ui]], [[fix-what-you-find-no-deferring]], [[gam-test-db-guard]], [[gam-pos-is-standalone]] + [[gam-pos-dual-mode-and-parity]] (for S14).

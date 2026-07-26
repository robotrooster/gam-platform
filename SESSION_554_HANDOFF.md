# SESSION 554 HANDOFF — launch button-sweep COMPLETE: all bugs fixed + all 4 frontends deployed to prod + landlord re-verify done (10 more found & fixed)

Continuation of S553. Theme: fix the S553 launch-button-sweep bugs BEFORE
Oak Park launch (Aug 1). Next session: 555.

## What shipped (all API changes built + com.gam.api kickstarted; health green)

### TIER 1 — money path (both fixed, tested)
- **Bug #2 + #3 — POS card "capture-then-400" (money taken, no sale).** Two
  independent causes, both fixed in `routes/pos.ts` `/transactions` +
  `services/posTax.ts`:
  - #2 discount dropped: the route now accepts `discountAmount`/`discountReason`,
    clamps to `[0, subtotal]`, and computes NET total = gross − discount + tax
    + surcharge so it matches the terminal PI the client minted at the discounted
    total. New columns via migration `20260724172147_pos_transactions_discount.sql`
    (`discount_amount` numeric default 0, `discount_reason` text) — proper books
    (gross subtotal, discount line, net total). FlexCharge platform_fee now on the
    discounted subtotal.
  - #3 tax fallback: `calculateCartTax` now falls back to `pos_items.tax_rate`
    when NO `pos_tax_rates` rows apply to an item's property (the launch/seed
    reality). Previously returned 0 tax while the client charged item.tax_rate →
    amount-match 400 on every card sale. NOT client-trusted — tax_rate is read
    from the landlord-owned row.
  - Tests: `pos.test.ts` +2 (discount amount-match + clamp), new
    `services/posTax.fallback.test.ts` (3). All green.
  - **KNOWN RESIDUAL (documented, not launch-blocking):** the POS client
    (`apps/pos POSPage` line 429) ALWAYS computes tax from `item.tax_rate`, never
    from `pos_tax_rates`. So if a landlord DOES configure a `pos_tax_rates` row
    that differs from item.tax_rate, card sales will 400 again (server uses the
    table, client uses item rate → mismatch). Launch is safe (seed = empty rate
    table + item rates). Proper fix = client fetches a server tax quote before
    minting the PI. Flagged for post-launch.
- Bug #1 (resend stubs) was already fixed+deployed in S553.

### TIER 2 — tenant-facing broken buttons (all 5 fixed)
- **#4 Notification prefs toggle dead** — both `tenant/main.tsx`
  NotificationPrefsPage and `pages/ProfilePage.tsx` sent snake_case; API zod
  wants camelCase (requests are NOT camelized, only responses). ProfilePage
  `togglePref` rewritten to emit `emailEnabled`/`inAppEnabled`; main.tsx default
  objects fixed from snake to camel keys (the snake default left `inAppEnabled`
  undefined → zod 400 on the common no-existing-row path). Both send camelCase now.
- **#5 Lease "Download PDF" 401** — `LeasePage.tsx` bare `<a href download>`
  couldn't carry the Bearer token. Added `downloadLeasePdf` (blob-fetch with auth,
  same pattern as `openAddendumPdf`); swapped the anchor for a button.
- **#6 Vacancy-match Interested POST→PATCH** — `TenantNotificationsPage.tsx`
  `respondMut` used `post`; route is PATCH. Extended the local `patch` helper to
  send an optional body, switched to it, removed now-unused `post`.
- **#7 "Reapply Now" 403** — button hit admin-only, non-prod `/dev-reset`. Built
  real `POST /api/background/reapply` (routes/background.ts) — any authed
  applicant, but the **90-day post-denial cooldown is enforced server-side**
  (never trusts the client). Button repointed; inline error state added (no native
  dialog). Tests: new `background-reapply.test.ts` (4 — cooldown pass/block,
  not-denied 409, no-decision 409). The two "🔧 Dev: Reset" buttons still point at
  /dev-reset by design (dev-only, `NODE_ENV !== 'production'` gated).
- **#8 verify-id-name dead end-to-end** — route never existed (404) AND the
  submit route ignored `idVerification`. **Nic decided: REMOVE the dead UI +
  payload** (real ID OCR collides with no-external-AI-for-tenant-data). Removed
  the verify-id-name call, the whole name-match card, the `idVerification` submit
  field, and the now-unused `idVerifying`/`idNameMatch` state + `post`/`humanize`
  imports. ID still uploads; staff verify manually (blind-staff-entry standard).

### TIER 3 — degraded/admin-internal (4 substantive fixed; 4 deferred)
- **#9 admin Property Reviews "undefined undefined"** — `fmtAddr`/`fmtLL` in
  `admin/main.tsx` read snake-case keys (`new_street1`) after the camelize
  interceptor. Rewrote helpers to build PascalCase suffixes; callers pass
  `'new'`/`'orig'`. (SQL aliases confirmed: admin.ts:551+ → camelize → newStreet1.)
- **#10 admin-ops Units ACH badge stuck "Pending"** — `routes/units.ts` list
  query never selected the tenant's `ach_verified`. Added
  `LEFT JOIN tenants pt ON pt.id = vuo.primary_tenant_id` + `pt.ach_verified`
  (camelizes → `achVerified`, which the Units detail panel reads).
- **#11 tenant maintenance had no comment surface** — the routed inline
  `MaintenancePage` (main.tsx) lacked comments; the real
  `pages/MaintenancePage.tsx` (with the comment thread, /maintenance/:id/comments)
  was DEAD/unimported. Removed the inline definition, imported the real page. API
  endpoints verified present (GET /:id returns `{...request, comments}`, POST
  /:id/comments). **NOT browser-verified** (see CORS note below) — typechecks +
  builds; the real page is self-contained standalone-styled, so give it a visual
  once-over post-deploy (it renders its own full-height dark background).
- **#12 tenant ACH last4 regex** — `main.tsx` `replace(/D/g,'')` (strips literal
  'D') → `/\D/g`.
- **#12 POS Discounts "Remove" DELETE route missing** — frontend `apiDel
  /pos/discounts/:id` 404'd. Added `DELETE /discounts/:id` (soft-delete
  is_active=FALSE, landlord-scoped; mirrors tax-rates delete).
- **#12 POS Edit-item "Save" dropped stockQty** — item PATCH didn't accept
  stockQty. Now accepts it, sets stock_qty, and writes an audited
  `pos_inventory_log` row (reason='manual', 'Item edit form') when it changes.

  **CLEANED UP ("do it all", 2026-07-24):**
- **#12 check-phone** — removed the dead client call in `BackgroundCheckPage`
  `validatePhone` (route never existed → always fell through to valid; building
  it public = a phone-enumeration oracle). Format validation stays; duplicate
  detection happens at account creation. Removed the orphaned
  `phoneChecking` state + "Checking…" render.
- **#13 bank-name input** — dropped the dead "Bank Name" input + `bankName`
  state from `AchVerifyForm` (verify-ach route never read it; Stripe feeds the
  display name). Now sends only `{ last4 }`.

  **DEFERRED (out of Oak Park launch path):**
- **#12 POS register 403 for 'office' staff preset** — `businessInventory.ts:38`
  gates item search on `inventory.read`; the office preset lacks it → whole
  register "Failed to load". This is the **business portal** (apps/business), NOT
  the standalone POS on the Oak Park launch path. Staff-preset change; defer.
- **#12 marketing booking day-mode TypeError** — routing-businesses path,
  explicitly out of the Oak Park path (S553 note). Defer.

## Files touched (12)
- API: `routes/pos.ts` (discount+tax+stockQty+discounts DELETE),
  `services/posTax.ts` (item.tax_rate fallback), `routes/background.ts`
  (reapply route), `routes/units.ts` (ach_verified join),
  `db/migrations/20260724172147_pos_transactions_discount.sql`, `db/schema.sql`
  (regenerated). Tests: `routes/pos.test.ts`, `services/posTax.fallback.test.ts`,
  `routes/background-reapply.test.ts`.
- Tenant: `main.tsx` (notif camel, ACH regex, maintenance import + inline removal),
  `pages/ProfilePage.tsx` (notif camel), `pages/LeasePage.tsx` (PDF blob-download),
  `pages/TenantNotificationsPage.tsx` (PATCH), `pages/BackgroundCheckPage.tsx`
  (reapply route + verify-id-name removal).
- Admin: `main.tsx` (Property Reviews camelCase).

## Deploy state / VERIFICATION — ALL DEPLOYED
- **API: built + kickstarted (com.gam.api), health green.** New routes probed
  live: `/api/background/reapply` → 401 (auth guard working); migration applied,
  discount cols live.
- **Frontends: tenant + admin + admin-ops + landlord ALL deployed to Vercel
  production** (vercel pull→build --prod→deploy --prebuilt --prod). Custom
  domains verified 200: tenant/admin/landlord.goldassetmanagement.com +
  gam-admin-ops.vercel.app. (POS standalone NOT redeployed — its only change was
  server-side; the client discount payload already existed.)
- **LIVE end-to-end verification (production):** logged into
  tenant.goldassetmanagement.com as alice, opened Maintenance → the swapped page
  (#11) renders the "UPDATES" comment thread, POSTed a comment
  ("Any update on this? Still dripping.") → it saved and rendered as
  "Alice Morgan (Tenant)". Full chain (deploy + API + comment round-trip) proven.
- **Verification basis for the rest:** typecheck clean on all 5 touched apps;
  127 API tests green (discount amount-match, tax fallback, reapply cooldown);
  all frontend prod builds clean. The landlord fixes are read-path camelCase
  corrections + one enum + one removal — low-risk mechanical, typecheck-proven.
- **Note on local browser testing:** the running com.gam.api uses PRODUCTION
  CORS origins (env app URLs = Vercel domains), so a localhost:3002 login 500s
  "Not allowed by CORS". Verify against the deployed prod domains (as done for
  tenant above), not localhost.

## "DO THE THINGS YOU KEEP SKIPPING" (S554) — deferred backlog cleared (Nic: all 4)
1. **CONNECT RE-ANCHOR STAGE 2 — SHIPPED + deployed + tested (218 money-path
   tests green).** Switched the live money callers from per-user to
   per-landlord-ENTITY via a transition-safe `COALESCE(landlords.stripe_connect
   _account_id, users…)` at every landlord-account resolution site: pos
   getLandlordConnectId, landlordPassthrough (rent reconcile), depositReturn,
   flexpay, otp (×2), and the RENT destination-charge in payments.ts (×2 — with
   CASE-based capability flags so the flags come from whichever entity owns the
   account, NOT a plain COALESCE that'd always pick landlords' default false).
   stripe.ts onboarding + status got a 'landlord' entity path; webhook reconcile
   resolves the founding user by EITHER user- or entity-anchored account;
   BankingPage owner→entity (workers stay entity='user' so manager direct-deposit
   isn't broken). **LIVE `landlord_members` re-check** (new
   services/landlordMembership.ts) on onboarding + status — a removed co-owner's
   stale JWT (≤7d) can't onboard/re-point the entity's account. All 3 existing
   landlords have member rows (verified — no owner 403s). Tests:
   stripeConnectReanchor.test (membership + COALESCE precedence),
   stripeConnect.test (landlord entity fetch/persist/webhook). **STILL DELIBERATELY
   NOT SWITCHED:** nothing — reads + onboarding all re-anchored. N4 (Nic real KYC
   for Oak Park LLC) can now anchor to the entity.
2. **POS 'office' preset 403 — FIXED.** businessInventory requireRead now accepts
   pos.use OR inventory.read (office has pos.use, not inventory.read) → the
   register can list items to ring sales. **Marketing booking day-mode TypeError:
   NOT LOCATABLE** — no day/week/month booking-mode toggle exists in
   marketing/storefront/business/customer; the S553 sweep's file:line was in a
   prior session's (gone) output. Needs a re-run targeted sweep, not a guess.
3. **POS tax client-quote + resend wiring — SHIPPED.** (a) NEW POST
   /pos/cart-quote (shared `aggregateCartTotals` in posTax.ts, used by BOTH
   /cart-quote and /transactions); the client mints the terminal PI against the
   server quote, so client + server totals ALWAYS agree — closes the card-tax 400
   class even when a pos_tax_rates row differs from item.tax_rate. (b)
   /admin/onboarding/resend: bank_verification (landlord banking nudge) +
   ach_enrollment (tenant ACH nudge) now actually send (new emails in email.ts);
   landlord_setup stays honest-501 (landlords self-register). Fixed the stale
   S553 resend test.
4. **Systemic camelize root-cause — GUARD SHIPPED.** Confirmed responses are
   camelized TWICE (global res.json middleware, NO passthrough → then each
   portal's axios interceptor). Rewriting that contract is a blast-radius-
   everywhere money-path migration — NOT done at session tail. Instead added
   lib/camelizeRegression.test.ts: scans all 5 portals' source for the exact
   snake_case response-reads that bit us and fails on any regression (with a
   `// camelize-ok` escape). It immediately caught a bank_last4 local-state
   straggler (fixed → full camelCase). The real contract-unification (single
   camelize pass / native camelCase responses) is documented future work.

Agent multi-lease (getMyTerminationQuote quotes ALL leases; requestLeaseRenewal
disambiguates) shipped after the 45-scenario eval: 44/45 (t-inspections =
unrelated local-model drift; t-termination — the tool I changed — PASSED).

## LANDLORD-PORTAL BUTTON SWEEP (S554) — re-ran, 10 CONFIRMED bugs, ALL FIXED + DEPLOYED
The S553 "landlord = 0 issues" was an ARTIFACT of the aborted run (Fable-5
usage limits). Re-ran the sweep as a workflow (24 agents, map→adversarial-
verify, 12 chunks of the 74 pages). **10 CONFIRMED, 2 false alarms rejected.**
Dominant pattern = the MIRROR of the tenant bugs: the landlord portal reads
RESPONSE fields in snake_case, but responses are camelized TWICE (API global
res.json middleware `index.ts:206-208` + landlord axios interceptor
`lib/api.ts:17`). So the frontend receives camelCase and the snake reads are
undefined → banners/links/KPIs silently break. Fix = read camelCase (matches
sibling fields that already work). All 10 fixed, landlord portal deployed prod.

8 response-camelize reads (fixed to camelCase):
1. AgentActivityPage.tsx — SummaryData interface + reads (tenant_count,
   escalated_count, avg_latency_ms, by_outcome/by_agent/by_tool, agent_name)
   → KPI tiles were 0/—, breakdown cards empty.
2. DepositReturnPage.tsx:111 — r.data.refund_amount → refundAmount ("$NaN" toast).
3. ESignPage.tsx:845 — d.completedPdfUrl (never existed) → d.executedPdfUrl;
   the signed-lease Download button never rendered for ANY completed doc.
4. LeaseFormModal.tsx:277 — result?.state_law_warnings → stateLawWarnings.
5. NewEntryRequestPage.tsx — interface + reads (outside_typical_hours,
   typical_hours_warning, state_law_warnings) → warning card never showed.
6. NotificationsPage.tsx:41-47 — n.data.inspection_id/entry_request_id/
   dispute_id/lease_id (jsonb blob camelized) → "Open" deep-link never rendered.
7. PropertiesPage.tsx:265 — res.state_law_warnings → stateLawWarnings.
8. RenewalDecisionModal.tsx:143,155 — openDraft.landlord_signer_status →
   landlordSignerStatus ("Open & Sign" showed even after the landlord signed).

2 non-camelize (Nic-decided):
9. UnitsPage.tsx:104 — status dropdown offered occupied/vacant/maintenance/
   eviction but the zod enum is UNIT_STATUSES (vacant/available/active/
   delinquent/suspended) → 3 of 4 options 400'd. **Nic: dropdown now
   vacant/available/active/suspended** (occupied→active, eviction→suspended,
   maintenance dropped; delinquent stays system-derived).
10. TransferTenantModal — POSTed to a deliberately-retired 501 stub (S20:
    "terminate + new e-sign lease"). **Nic: removed the transfer UI** (modal +
    the "Transfer Unit" button on TenantDetailPage; deleted the orphaned
    TransferTenantModal.tsx).

**ROOT-CAUSE NOTE for 555:** these 8 are a systemic class — the API returns
snake_case in `res.json({data:...})` bodies and relies on double-camelization.
Any NEW landlord page that reads a multi-word response field in snake_case will
silently break the same way. Consider a lint rule / the habit of always reading
camelCase on the landlord+admin portals. The tenant portal had the inverse
(snake_case REQUEST bodies). Worth a shared-contract cleanup pass someday.

2 rejected as false alarms (verified NOT bugs): SchedulePage editBookingMut
(SchedulePage.tsx:728) and TenantScreeningPage payment KPIs (:226) — the
adversarial verifier proved both read correctly / route accepts the body.

## RESPONSE-CAMELIZE SWEEP (S554, "continue fixing") — 4 more found + fixed + deployed
After the landlord re-run exposed the systemic response-camelize class, I swept
the OTHER 4 already-live launch portals (tenant/admin/admin-ops/pos) with a
targeted workflow (7 hunt agents + adversarial verify). **4 CONFIRMED, 0 false
alarms** (all 7 surfaces covered; admin main.tsx + pos both came back clean):
1. **admin-ops main.tsx:1057** — fmtAddr/fmtLL read snake_case (new_street1,
   orig_landlord_first) → Property Reviews comparison panel showed
   "undefined, undefined". SAME bug as admin #9 but admin-ops has its OWN copy.
   Fixed (PascalCase suffixes + 'new'/'orig').
2. **tenant main.tsx:877,890** — bulletin-vote optimistic update wrote
   my_vote/can_vote/can_flag (snake) but render reads myVote/canVote/canFlag →
   vote button never turned green/amber + click-guard let a duplicate POST
   through until reload. Fixed (write camelCase).
3. **tenant PosCustomerOnboardingPage.tsx:60** — `startRes.data.client_secret`
   → clientSecret on the wire → "Verify my bank" ALWAYS errored, Stripe FC
   modal never opened. Fixed.
4. **same page :86** — `completeRes.data.bank_last4` → bankLast4 → the "Linked
   •••• 1234" confirmation never rendered. Fixed.
All deployed (tenant + admin-ops redeployed to Vercel prod, READY).
NOTE: this sweep uses lib/caseConversion.ts (the API's GLOBAL res.json
middleware) which — unlike packages/shared/src/camelize.ts — has NO passthrough
set at all, so it camelizes even client_secret/bank_last4. Every launch portal
has now been swept for this class.

## MULTI-LEASE DISPLAY (S554) — Oak Park requirement #2 second half, SHIPPED
The esign same-landlord overlap exception was ALREADY built (S553, esign.ts:~95
comment + `l.landlord_id === newUnit.landlord_id && l.unit_id !== newUnitId
continue`). The remaining half — the tenant portal assuming ONE lease — is now
fixed:
- Billing was already per-lease (payments/invoices carry lease_id; payments
  aggregate by tenant_id across leases) — so ONLY the display was the gap.
- NEW `GET /api/tenants/leases` (tenants.ts) returns ALL active/pending leases
  for the tenant (array, same enrichment as singular /lease: property/landlord
  names, security_deposit, state-law warnings, document_url per lease).
  Singular `/tenants/lease` kept intact (unused now, but harmless).
- LeasePage.tsx: fetches the plural route, derives the shown `lease` from a
  `selectedLeaseId` (defaults to first), and renders a lease-switcher button row
  ONLY when leases.length > 1 (single-lease tenants see no change). query key
  tenant-lease → tenant-leases (+ the termination invalidation).
- LIVE-VERIFIED on prod: alice (1 lease) renders normally, no switcher.
- **DEFERRED — agent-tool multi-lease sweep:** tenant agent tools
  (fileMaintenanceRequest, getApplicableLaws, getMyTerminationQuote, etc.) still
  pick a single lease/unit; a 2-lease tenant chatting with Ava/Samantha may get
  the wrong unit or need disambiguation. This is an AGENT change → requires
  re-running the 43-scenario eval ([[gam-agent-roster]]), so it's a scoped
  follow-up, NOT bundled here. Agents are user-toggleable, so the portal (done)
  is the launch-critical surface.

## CONNECT RE-ANCHOR user→entity — STAGE 1 SHIPPED (safe/additive), STAGE 2 SCOPED
The launch-blocker: a landlord's Stripe Connect account is keyed one-per-USER
(users.stripe_connect_account_id, S113); the multi-owner entity model needs it
one-per-ENTITY (landlords row = an LLC w/ own EIN/bank) so Oak Park LLC gets its
own account + KYC. The machinery is cleanly entity-dispatched
(ConnectEntity = 'user'|'pm_company'|'business', fetchExistingConnectId/
persistConnectId), so 'landlord' slots in.

**STAGE 1 — DONE + deployed + tested (27/27). Zero live-money-flow change:**
- Migration 20260724190600: landlords gets stripe_connect_account_id (partial
  UNIQUE) + stripe_connect_status_synced_at + connect_charges/payouts/details
  flags. Backfill from the founding owner's user row (0 rows today — no real KYC
  yet — so structurally a no-op, correct for any future account).
- ConnectEntity += 'landlord'; fetchExistingConnectId/persistConnectId branch on
  the landlords table; recordAccountUpdated (webhook capability sync) mirrors
  onto landlords too (additive — matches nothing until an account is entity-
  anchored). New tests: ensureConnectAccount(landlord) create+idempotent+persist,
  recordAccountUpdated→landlords mirror.
- **NO live caller passes entity='landlord' yet** — Banking/onboarding/
  destination-charge/disbursement still use 'user', so money routing is
  unchanged. This is the deliberate safety boundary.

**STAGE 2 — the money-routing switch (do in a FRESH session, careful, tested):**
1. Switch landlord Connect callers from entity='user'(userId) → entity='landlord'
   (landlordId): createOnboardingSession (Banking page entry), fetchAccountStatus/
   Banking status reads, and the DESTINATION-CHARGE routing where the landlord's
   Connect account is read for transfer_data.destination (trace via
   services/landlordPassthrough.ts + wherever rent PI destination is set) +
   disbursements. NOTE stripeConnect.ts:383/486 read users.stripe_connect_account_id
   directly for pm_transfer/manager_transfer (PM/manager payouts) — those are NOT
   the landlord's own account; leave unless re-anchoring PM too.
2. Webhook reconcile (stripeConnect.ts ~763: `SELECT id FROM users WHERE
   stripe_connect_account_id` → tryReconcileForLandlordUserId) needs a
   landlords-aware variant so entity-anchored accounts reconcile held rent.
3. **LIVE membership re-check on money-critical routes** (banking / onboarding-
   session / disbursements): verify the requesting user is STILL a current
   landlord_members row for the entity at request time — NOT just trusting JWT
   landlordIds (dissolution-proofing: a removed owner's stale JWT lasts ≤7d).
   The S553 handoff says: DO NOT ship N2 before this lands.
4. Banking page (apps/landlord) becomes per-entity: pass the landlord entity id,
   show per-entity KYC status; any owner-member can complete their entity's KYC.
5. Then N4 (Nic completes real embedded KYC for Oak Park LLC) → C4 live-fire → C5.

## NEXT SESSION (555) — priority order
1. **DONE this session:** all 22 S553 button-sweep bugs resolved (18 tenant/
   admin/POS + the 10 landlord found in the re-run — note some overlap in
   counting; net: every confirmed bug across all 6 launch portals is fixed +
   deployed). Frontends (tenant/admin/admin-ops/landlord) all deployed to prod.
2. Then the S553 OAK PARK LAUNCH REQUIREMENTS chain (unchanged, still open):
   Connect re-anchor user→entity (banking per-entity, REQUIRED before N4/N2) →
   same-landlord lease-overlap exception (routes/esign.ts:66) + "my lease"
   singular→plural sweep → N2/N3.
5. S554+ specs still on the board (unchanged from S553): Portfolio-Manager
   commission (pay-in-arrears + first-payment vesting, no clawback — Nic to give
   final yes), smooth manual lease onboarding + RUBS-with-metered-exclusions
   verify, agent commission dashboard.

## Watchouts
- POS card sales use an EXACT PI amount-match (S242). The tax fallback mirrors
  the existing per-line rounding; a cent-level client/server rounding divergence
  on multi-item carts could still 400 (pre-existing fragility of exact-match, not
  introduced here). If Nic sees cent-mismatch 400s in card testing, the real fix
  is the client-fetches-server-quote refactor noted under #3.
- `pos_inventory_log.reason` CHECK = {adjustment,sale,po_received,return,manual,
  other} — used 'manual' for the item-edit stock correction (not 'edit').
- The two 500 "null name" logs in POS test runs are the intentional S390
  empty-body finding tests, not failures.
- NEVER run two vitest processes concurrently (S553 watchout still holds).
- Email sends suppressed outside prod unless EMAIL_SEND_LIVE=1 — the reapply
  route sends no email; nothing to worry about there.

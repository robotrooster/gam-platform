# SESSION 556 HANDOFF — auto-field-placement build-out, auto-populate from unit, nested conditional fields, tenant renewal-intent (ALL DEPLOYED LIVE)

Continuation of S555. Big build session. Everything below is BUILT, TESTED, and
DEPLOYED to the live self-host (API rebuilt + com.gam.api restarted; frontends
are Vite dev so live via HMR; migrations applied to the live DB). Next: 557.

## SHIPPED

### 1. Auto-field-placement engine (the S555 remaining work)
- `apps/api/src/services/autoFieldPlacement.ts` — ported from the S555 core cjs.
  Pipeline: deterministic blank detection → in-house Hermes model classification
  (best-effort, times out → heuristic fallback) → geometry/rule pass. Emits
  `ProposedField[]`.
- Round-2/3 refinements folded in: roles default LANDLORD for property/term/money,
  TENANT only for personal info + signatures + initials; short-personal fields
  (name/phone/birthdate/DL/email) split per-tenant, long (address/emergency) single;
  insurance carrier/policy → tenant; birthdates → date type; signatures lifted off
  the underscore; 4 tenant sig+date pairs + landlord sig+date on the signature page;
  initials deduped to exactly 4 (uses lease's own initials spot if present);
  occupancy roster box; hard no-text-overlap (printed-word rects); dev model cache
  via `AUTO_FIELD_MODEL_CACHE` env (dir) so iteration skips the ~100s model call.
- **Check-one → radio emission**: detects "check/select/choose/mark/pick/initial
  one" groups, extracts the printed option labels, emits ONE tiny (14×14) radio per
  group. Keyword-maps to lease_type / auto_renew_mode and auto-NESTS the end-of-term
  choice as a conditional child of lease_type (trigger "Fixed term"). Generic groups
  with 2+ printed options become radios with those real labels (column left null).
- `lib/pdfText.ts` — added `height` to TextItem (+ `jobs/leaseParser/itemJoin.ts`).
- Route `POST /esign/templates/:id/auto-fields` (returns proposals, doesn't save) +
  "Auto-place fields" button in `apps/landlord/src/pages/ESignPage.tsx` (loads into
  editor; existing PUT saves).
- Validated via harness/render on both real Oak Park leases (scratchpad).

### 2. Auto-populate lease boxes from the assigned UNIT (Nic's "fill as much as possible")
- Migration `..._property_unit_type_deposits.sql` — per-(property,unit_type)
  `deposit_multiplier` (default 1.0). Deposit is DERIVED: `deposit = rent × multiplier`.
- `services/depositPolicy.ts` (resolver + computeDeposit) + `services/leasePrefill.ts`
  (`suggestUnitPrefill` — single source: rent_amount, security_deposit=rent×mult,
  unit_number, property_name, property_address).
- Seeded in `esign.ts createDocumentRecord` for ORIGINAL leases (caller values win).
- `GET /esign/units/:unitId/prefill-suggestions` → send-form pre-fills (ESignPage
  useEffect).
- Deposit-multiplier CRUD: `GET/PUT/DELETE /properties/:id/deposit-multipliers`
  (properties.ts) + `apps/landlord/src/pages/PropertyDepositSection.tsx` on
  PropertyDetailPage. **BUG CAUGHT IN BROWSER + FIXED**: component read snake_case
  (`deposit_multiplier`) but API camelizes → showed "NaN× rent"; now `depositMultiplier`.
- Tests: esign.test.ts "auto-populate from unit" (3), properties.test.ts
  "deposit-multipliers" (3). Verified live end-to-end: 900 rent × 1.5 → 1350 deposit.

### 3. Radio-group options persistence (F foundation)
- Migration `..._field_options.sql` — `options` on lease_template_fields +
  lease_document_fields. Persisted in PUT /fields + doc copy. (Was dropped before →
  every radio fell back to "Yes,No".) Editor default radio sized 16×16.

### 4. Nested conditional fields (any field type)
- Migration `..._field_parent_conditional.sql` — `parent_field_id` + `parent_option`
  on template + document fields (child links to parent's TEMPLATE field id).
- Two-pass PUT (links child→parent by stable clientId across the full-replace) + doc
  copy carries the link.
- Sign-time enforcement (esign.ts POST /sign): a required child is enforced ONLY when
  the parent's effective value == parent_option; hidden children are skipped AND
  cleared (no stale/contradictory value); landlord full-doc validate excludes inactive.
- Sign UI (landlord + tenant SignPage): child shows/hides live + clears on parent
  change; only active fields count toward gating/rendering.
- Editor "Only show if…" control — available for ALL field types (pick a parent radio
  + trigger option). So a landlord gates fixed-term dates vs month-to-month
  start+notice on the lease_type radio; inapplicable fields auto-hide + drop required
  (no manual N/A). Tests: esign.test.ts "conditional radio required" (4, incl a date child).
- DECISIONS: each nesting level is its own field bound to its own lease column;
  clear-on-parent-change; radio = a dot (tiny); auto-emit only guesses the fixed-term
  pattern, everything else is the manual editor (reliable fallback).

### 5. Tenant renewal-intent (the dead S555 survey — now live)
- Migration `..._lease_tenant_renewal_intent.sql` — `tenant_renewal_intent`
  (yes/no/unsure) + _at + _notes on leases.
- `POST /leases/:id/renewal-intent` (leases.ts, tenant-auth) — records intent on the
  lease (survey hides via `/tenants/leases` SELECT l.*), opens a lease_renewal_request
  for "yes", notifies the landlord. The tenant survey UI already existed in
  `apps/tenant/src/pages/LeasePage.tsx`; only the endpoint + column were missing.
- Tests: leases.test.ts "renewal-intent" (4).

## RENEWAL DEPOSIT (found, already correct — no build needed)
The renewal deposit top-up already exists (S534) and matches Nic's decision:
defaults to no-change; if the landlord enters a higher deposit in the renewal doc,
only the DELTA bills (tagged) + custody target raised; lower = manual refund. Only
missing is a proactive on-screen "suggested new deposit" hint (polish, not built).

## OPS WATCHOUT (I hit this — document for next time)
`install-services.sh` / `launchctl bootstrap` can fail with "Bootstrap failed: 5:
Input/output error" and leave `com.gam.api` UNLOADED while an ORPHAN node process
keeps holding :4000 → the supervised instance then crash-loops on EADDRINUSE.
To restart the prod API cleanly:
  1. `cd apps/api && npm run build`
  2. `lsof -ti tcp:4000 | xargs kill -9`   (kill the current listener)
  3. if `launchctl list | grep gam.api` shows it loaded → KeepAlive respawns it;
     else `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.gam.api.plist`
  4. verify: `launchctl print gui/$(id -u)/com.gam.api | grep 'state ='` = running,
     and a route returns 401 (not 404). LEFT HEALTHY THIS SESSION (pid supervised).

## LEFTOVERS / NEXT
- **Test data to delete**: property `AFP Verify Property` (236562e0-f458-44e7-8732-
  ad7481c14303) + unit 101 + its apartment 1.5× deposit row, under realestaterhoades.
  Created for live verification. Delete when done poking.
- **Model-driven nesting** (robustness): extend the Hermes pass to recognize check-one
  groups + nesting semantically for leases the keyword/positional heuristic misses.
- **Full browser walkthrough** of auto-place button + conditional signing (needs a
  template with an uploaded PDF — didn't do live; unit-tested + deployed).
- **Commit** — large amount of uncommitted tested work (Nic's call).
- Frontends run as Vite dev in the launch set; the prod API's CORS rejects arbitrary
  localhost origins — use PREVIEW ports 31xx (3101 landlord etc., already allowlisted)
  to drive the UI from Claude's browser.

## Test status: all green
esign.test.ts 100, esign-templates 19, properties 41, leases 63 (spot-run per-suite).
Both apps typecheck clean. Dev model Hermes-4.3-36B at :8080 (~100s/call; cache = instant).

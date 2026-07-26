# SESSION 555 HANDOFF — launch bug re-sweep + lease renewal design + auto-field-placement engine

Continuation of S554. Theme: re-sweep for launch bugs (nothing left behind),
then a deep design+build thread on lease renewal and AUTO-FIELD-PLACEMENT for
lease templates. Next session: 556.

## PART 1 — launch bug re-sweep (all landed)
- **API test suite was NOT fully green.** 1 failing test (units.test.ts) — root
  cause: `notifications.user_id` FK had no ON DELETE CASCADE (inconsistent with
  sibling tenant_notifications + 20 other user FKs); booking/lease routes emit
  notifications fire-and-forget → un-awaited insert raced the test cleanup's
  users DELETE. FIXED: migration `20260725083700_notifications_user_fk_cascade.sql`
  (applied dev + gam_test rebuilds from schema.sql). Suite now **4024/4024 green**.
- **Camelize core test was DEAD** — `caseConversion.test.ts` (the load-bearing
  global response-camelize `camelCaseKeys`) was excluded from vitest + wired to
  nothing. Converted to a real vitest test (19 cases) + removed from
  vitest.config exclude. Now runs in-suite.
- **6-portal re-sweep** (parallel agents, verified vs real API routes): POS,
  marketing, admin, admin-ops all CLEAN. **1 landlord straggler FIXED**:
  SchedulePage.tsx editBookingMut onSuccess read `resp?.data` (undefined —
  apiPatch returns unwrapped) + snake_case → reservation-edit drawer showed
  stale data. Fixed to read `resp` camelCase (mirrors lockBookingMut). Landlord
  typecheck clean. NOTE: S554 had wrongly cleared this as a false alarm.
  Marketing "booking day-mode TypeError" (S554 couldn't locate) CONFIRMED
  NONEXISTENT. All 5 frontends typecheck clean.
- **OPEN/UNDECIDED:** tenant lease-renewal SURVEY is dead (LeasePage.tsx
  renewalMut → nonexistent `/leases/:id/renewal-intent`, 404 silent). Nic did
  NOT pick remove-vs-build — he redirected into the full renewal workflow design
  (Part 2). Still needs resolving.

## PART 2 — lease renewal/departure workflow (design, mostly recon)
See memory [[gam-lease-renewal-and-autofield]]. Built vs gap mapped: landlord
renew/non-renew + esign renewal-draft + billing-stop + move-out/deposit-return
all EXIST; the gap is the tenant-portal intent capture (the dead survey) +
M2M-notice. Fee "planes": platform_collectible / deposit_bounded / court_only
(interest+attorney fees = court_only record-not-bill; liquidated damages =
deposit_bounded; short-notice penalty = deposit_bounded notice_period_rent).
NOT YET BUILT — the tenant intent front-end. Deferred behind Part 3.

## PART 3 — AUTO-FIELD-PLACEMENT (the main build) — spec: AUTO_FIELD_PLACEMENT_SPEC.md
Launch feature: auto-place e-sign field boxes on an uploaded raw lease PDF
(~1hr/template manual → review-and-nudge). Tested the in-house Hermes-36B model
(:8080) on Nic's REAL Oak Park leases (apartment + mobile-home PDFs in
~/Downloads): fee-extraction v2 (candidate-sweep + planes + CODE-verified
citations) = 9/9 verified citations both leases.

**Engine BUILT + WORKING + SAVED: `apps/api/scripts/autoFieldPlacement.core.cjs`**
(deterministic, standalone cjs for iteration; validated with rendered overlays).
Achieves: correct coordinate flip, real-width boxes (no text overlap), hard
no-overlap pass (0 overlaps verified both leases), 4 name boxes, per-page tenant
initials, signature roles by x (SIGN:T/SIGN:L), date fields (underline + "/ /"),
generalizes across both lease structures.

**REMAINING (spec has full detail) — implement next session with fresh context:**
1. p7: 2nd tenant sig line → signature; INVENT 4 tenant sig boxes (primary +
   co_tenant_1/2/3, unused prune at send esign.ts:44/281); add LANDLORD date box.
2. Per-tenant SPLIT (Nic DECIDED): name/contact/phone/BIRTHDATE(18+ check)/
   driver's-license/signature/initials → up to 4 boxes. Occupant roster line →
   ADAPTIVE (1 box if 1 line, N boxes if itemized). Property/term/money → single.
   COMPREHENSIVENESS MANDATE: capture EVERY field the lease asks for.
3. NEW overlap standing rule: text-overlap = hard no; allow SLIGHT box-box
   overlap rather than shrink-below-usable/drop (input renders centered).
4. Model-tagging pass for the semantic tail (label-above names, column refine,
   reject decorative underscores).
5. WIRE IN: port core → services/autoFieldPlacement.ts (uses lib/pdfText.ts),
   route POST /esign/templates/:id/auto-fields, "Auto-place fields" button in
   ESignPage (loads into existing editor; existing PUT saves).

Scratchpad harnesses (fee extract + render) in the session scratchpad dir.
Nic's Oak Park templates have NO boxes yet — placed at onboarding (this feature).

## Watchouts
- Nic: "everything we discuss IS launch-critical" — see [[gam-everything-discussed-is-launch]].
  Do not label his active topics non-launch.
- gam_test rebuilds fresh from schema.sql each vitest run (globalSetup drops+creates).
- Local model calls ~100-130s each; single fork sequential vitest (~320s full).

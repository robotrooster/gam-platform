# SESSION 575 HANDOFF — Landlord-portal UX polish + all-portal "locked window"

**Theme:** S575 landlord-portal UX queue (4 items) → full Master-Schedule polish →
locked/no-scroll desktop shell across all launch app portals. Then Nic dictated a
fresh landlord-portal punch list (§B below) — the remaining "get it launch-ready"
work for the landlord portal. Context was filling, so this handoff is the clean
restart point.

**Repo:** `~/gam`. Dev servers were running (landlord :3001, tenant :3002, admin
:3003, books :3006, pos :3005, admin-ops :3009). Dev portal points at the **prod**
API on :4000 (`com.gam.api` launchd); it was **rebuilt + kickstarted** this session
so the §A backend is live. Demo landlord for live QA: `james@demo.dev` (has data;
the :3001 session was already authed — 2FA didn't re-prompt).

**GIT: nothing committed this session.** All of §A is on disk, typecheck-clean, and
Nic-verified on :3001. Nic decides when to commit.

---

## §A — SHIPPED THIS SESSION (verify on disk before building on it)

All typecheck-clean (`npx tsc -p apps/landlord/tsconfig.json --noEmit` = 0). Migration
applied. Prod API rebuilt.

### 1. Master Schedule — floating reservation names (SchedulePage.tsx)
Replaced the old repeat-name-every-21-days in-bar label with ONE sticky name per
reservation in a pointer-events:none overlay layer. `position:sticky;left:184` pins
each name to the timeline's left edge (names line up in a column) and CSS pushes it
off-left, clipped, as the reservation ends. Rows are NOT uniform-height by nature, so
the overlay measures each row's real `offsetTop` via `rowGeom` state + a
`ResizeObserver` on tbody (survives name edits / window resize / font swaps). Key code:
`nameOverlays` useMemo + `rowGeom` useLayoutEffect right after `filteredUnits`; the
overlay `<div aria-hidden>` right after `</table>`.

### 2. Manual expense receipt upload
- Migration `20260801082000_landlord_expense_receipt.sql` (APPLIED): +`receipt_url/
  receipt_name/receipt_mime/receipt_size` on `landlord_expenses`.
- `apps/api/src/routes/expenses.ts`: multer (uploads/expense-receipts) + `POST
  /api/expenses/:id/receipt` + authed `GET /api/expenses/receipt-files/:filename`
  (mirrors maintenance-media posture; no static /uploads).
- `services/landlordExpenses.ts`: `attachExpenseReceipt()` + receipt cols in the list query.
- `apps/landlord/src/pages/ExpensesPage.tsx`: optional file input uploads on save;
  "View" link opens the authed blob. **Fixed a latent bug**: the table read dead
  snake_case fields (`e.expense_date`…) that the camelize interceptor renames — now
  reads camelCase. Verified end-to-end (logged + voided a test row).
- Tests green: `apps/api` `src/routes/expenses.test.ts` (5), `auth` (46).

### 3. Lot Rent & Net — mobile-home nav gate
`/api/auth/me` returns `hasMobileHomeUnits` (EXISTS on units.unit_type='mobile_home'
for the landlord). Nav shows Lot Rent only for landlords with an MH unit
(admin/super_admin always). Files: `auth.ts` /me, `Layout.tsx` `visibleNavItemsFor`,
`AuthContext.tsx` type. Verified: james has no MH units → tab correctly absent.

### 4. Nav sub-tab consolidation (Layout.tsx + main.tsx)
Financials (10) + Screening (3) each collapse into ONE sidebar item opening a
sub-tabbed page (`HubTabLayout`). `hub` field on NAV_ITEMS; `sidebarNavItemsFor`
collapses; `HubTabLayout` renders visible children as tabs. Flat child routes
(/payments, /pool, …) UNCHANGED — a pathless layout route wraps them, so every deep
link works. Sidebar ~34 → ~23 rows, fits one screen. NO accordions.
**Financials tab order** = NAV_ITEMS order: Payments, Outstanding Balances, Rent Roll,
Disbursements, Reports, Expenses, Bank Feed, Bank Reconciliation, Banking, Lot Rent.
**Screening tab order**: Applicant Pool, Background Checks, Rental History (first
visible = landing tab → see §B-9, Nic wants Background Checks default).

### 5. Master Schedule scroll/layout fixes
- Removed the JS row-snap in onScroll (rounded scrollTop to a fixed 72px → fought
  non-uniform rows + momentum = 3s bounce, and clipped the bottom row). Native scroll
  + `overscrollBehavior:contain` now.
- Uniform 88px rows: Unit cell content hard-capped (inner div height:76 overflow:hidden)
  + property name clamped to 2 lines (`-webkit-line-clamp` + `title` hover). A long name
  used to wrap unbounded (118px ragged rows). Measured max was only 72 vs 85 (the "+Book"
  button on bookable units drove the difference).
- Custom always-visible draggable horizontal scrollbar strip (`.hbar-thumb`) above the
  legend (macOS overlay scrollbars are invisible to Magic-Mouse users). `updateHbar/
  dragHbar/jumpHbar`; syncs both ways; gold on grab. Native scrollbars hidden
  (`.schedule-scroll::-webkit-scrollbar{display:none}`) so there's no double bar.
- Legend: +14px bottom padding, wrapper +breathing room, items wrap.

### 6. Locked "window" shell — landlord + ALL launch app portals
ROOT CAUSE of Nic's "whole page scrolls / header cut off": `.main-content{overflow-x:
hidden}` silently computes `overflow-y:auto`, making main-content a scroll container
that grows instead of scrolling → sticky topbar dragged off with the document.
FIX applied to landlord/POS (globals.css: `.app-shell/.main-content/.page-content`)
AND tenant/admin/admin-ops/books (INLINE `<style>` in each `main.tsx`: `.shell/.main/
.topbar/.page`; `.main` margin-left varies 220/230):
- `html,body{height:100%;overflow:hidden;overscroll-behavior:none;margin:0}` (kills the
  rubber-band bounce too — Nic wanted "locked in place")
- shell + main: `height:100vh;overflow:hidden`
- scroll region (page): `flex:1;min-height:0;overflow-y:auto;overscroll-behavior:none`
- The schedule TIMELINE sub-view additionally fills the height so ONLY the grid scrolls
  (root gets height:100%+flex-col when view==='timeline'; wrapper + grid flex:1
  minHeight:0). Other schedule sub-views (List/Units/History) keep normal scroll.
All 6 verified (no doc scroll, header fixed, in-region scroll). DESKTOP-ONLY by
decision — mobile is a later pass (Nic: the nav needs to scroll on mobile).
LEFT SCROLLABLE on purpose: marketing + public/long-page sites. NOT touched:
pm-company/business (not launch set). Known edge: login/register render outside the
shell (no `.page`), so a very tall auth form could clip on a short viewport — fine on
desktop, revisit with mobile.

---

## §B — NIC'S LANDLORD-PORTAL PUNCH LIST (do next; "this + §A ≈ everything for launch")

### B-1. Master Schedule = perpetual/forever calendar (LAUNCH RISK — busy season)
FINDING: window is FIXED `[today−31, today+151]` days — `SchedulePage.tsx:275-276`
(`useState` no setter). Today+151 = Dec 30 (Nic's exact cutoff). It rolls forward daily
but has a hard ~5-month forward wall — you CANNOT scroll to next year to book a future
reservation from the timeline. The booking modal's date input can pick any date, but the
timeline can't display/reach it. FIX: make the forward horizon dynamic (extend `toDate`
as the user scrolls near the right edge — infinite forward scroll appending days +
re-query) and/or add a jump-to-date control. Must handle "next winter" reservations.
Note the query at `:385-386` (`/units/schedule/master?from&to`) refetches on from/to.

### B-2. Unit Overview — property filter dropdown
Add an "All properties / <property>" dropdown filter (Nic: you can type it in search
now, but wants a click-dropdown). Keep the existing active/vacant/delinquent filters.
`apps/landlord/src/pages/UnitsPage.tsx`.

### B-3. Tenants tab — property filter dropdown + SEARCH BAR
No search bar today; 500 tenants = endless scroll. Add a search box + "All properties/
<property>" dropdown. `TenantsPage.tsx`.

### B-4. Late-fee policy UI — doesn't match backend design
Nic: the late-fee UI "doesn't match our backend design with how things work." Needs a
UI review against the actual late-fee model. RELEVANT MEMORY: late fees are per-
(property,unit_type) DECISIONS that gate unit-add/onboarding/import; billing = min(lease
schedule, class policy); NEVER invent a late fee (see memory `gam-late-fee-consistency`).
Recon the late-fee settings UI vs the backend rules and reconcile. (Scope-shaping needed
— get Nic to point at the specific screen.)

### B-5. Bank Feed vs Bank Reconciliation — same thing? + reporting links
Clarify whether `/bank-feed` (BankFeedPage, S570 — link operating bank, categorize spend
into P&L) and `/bank-reconciliation` (BankReconciliationPage, S568 — categorize bank
charges) are distinct or overlapping. If distinct, ensure ALL reporting categories link
to BOTH workflows. If overlapping, consolidate. See memory `gam-bookkeeping-pl-
architecture`. Recon both pages + reports.ts category wiring.

### B-6. Filters + search on Leases, Tenants, E-Sign tabs
Big landlords need to find things fast. Add property-filter dropdown + search bar to:
Leases (`LeasesPage.tsx`), Tenants (B-3), E-Sign (`ESignPage.tsx`). (Pattern: build one
reusable property-dropdown + search-box and reuse across list pages incl. B-2/B-3/B-7.)

### B-7. Financials (Payments/ACH) — search + property dropdown
The Payments tab is a long ACH list with no search. Add: type a tenant name → their
transactions; pick a property from a dropdown → that property's transactions.
`PaymentsPage.tsx` (now the first Financials sub-tab).

### B-8. Work Trade ↔ active lease coupling
Nic: if a lease expires while a work-trade agreement is active, we still need a renewed
lease (even month-to-month) with an addendum: work-trade is in lieu of rent / a % of
rent, terminable anytime (at-will framing, no state-specific statutes per house rules).
Decide: should Work Trade REQUIRE an active lease? Wire the lease-expiry → work-trade
handling. Recon `WorkTradePage.tsx` + work-trade service + lease-end processor. Keep
legal framing generic (no state citations).

### B-9. Screening hub restructure
(a) Rental History sub-tab (`TenantScreeningPage.tsx`) shows header "Tenant Screening —
network-visible behavioral record for prospective and current tenants." Nic: is that our
internal platform scoring system? (Likely the Credit-Ledger/screening surface — see
CLAUDE.md Credit Ledger v1.) It "looks weird" — clarify + rename/reframe the header.
(b) Make **Background Checks the DEFAULT tab** when clicking the Screening nav icon
(currently Applicant Pool is first). EASY: reorder the `hub:'screening'` items in
NAV_ITEMS (Layout.tsx) so `/background` precedes `/pool` (first visible = landing tab),
OR special-case the screening hub landing. Applicant Pool stays as the vacancy-fill
backup.

### B-10. Team page — set permissions BEFORE sending invite
Today: invite sends, then "Configure later" → landlord must go find where to set
permissions = double work. Change the flow so permissions are selectable in the invite
form BEFORE the invite sends (still editable later). `TeamPage.tsx` +
`StaffPermissionsPage.tsx` + the invite route. Permission catalog = 105-key
per-user-toggle system (memory `gam-cashier-role`).

---

## §C — HOW TO START (fresh session)
1. Read this file. Read memory `gam-s574-landlord-ux-queue` (full S575 detail) +
   `gam-launch-portal-scope`, `gam-prod-api-restart`.
2. §A is DONE + uncommitted — don't rebuild; verify on disk if extending.
3. §B is the queue. Several items share a need (property-dropdown + search on list
   pages) — consider building ONE reusable filter/search component first (B-2, B-3,
   B-6, B-7). B-1 (perpetual calendar) is the biggest launch risk — prioritize.
4. Ask Nic to point at the specific screen for B-4 (late-fee UI) before building.
5. Prod-API changes need rebuild + `launchctl kickstart -k gui/$(id -u)/com.gam.api`
   (GOTCHA: orphan on :4000 → EADDRINUSE; verify listener after).
6. Don't initiate commit/smoke-walk topics (house rules).

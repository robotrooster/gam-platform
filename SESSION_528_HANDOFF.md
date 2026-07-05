# SESSION 528 HANDOFF

## Theme
FINAL WALKTHROUGH, day two. Nic finished dictating the landlord-portal list —
**CLOSED at 55 items (W-1…W-55)** in `FINAL_WALKTHROUGH.md` — then greenlit
fixing everything EXCEPT W-42 (agents; sequenced last, after all portals).
Fix phase runs in 8 thematic batches (Nic's rule: multi-point issues get ONE
collective fix, never end-patched). **Batches 1–3 are DONE and live-verified;
batches 4–8 remain.** Uncommitted (Nic commits).

## THE TRACKER
`FINAL_WALKTHROUGH.md` at repo root is the single source of truth — every
item carries verbatim intent + Claude context notes; fixed items are marked
✅ FIXED with what/why/verification inline. Read it before touching anything.

## BATCH STATE
- ✅ Batch 1 — data-wiring class (W-13, W-37, W-43, W-48a, W-11→W-12, W-46a,
  W-6, W-29, W-35, W-51)
- ✅ Batch 2 — link targets + pre-filters (W-1, W-3, W-4, W-5, W-38, W-39)
- ✅ Batch 3 — schedule display (W-17, W-18+W-55, W-21, W-23)
- ⬜ Batch 4 — GLOBAL SWEEPS: W-9 (every date-picker auto-closes on date
  click) + W-47 (new font — present 2-3 pairings for Nic to CHOOSE, don't
  pick unilaterally; Title Case sweep on headers/menus/buttons, sentence case
  descriptions). NOTE: schedule tab buttons are lowercase in the DOM and
  CSS-capitalized — normalize as part of W-47.
- ⬜ Batch 5 — shared availability rule (W-19 edit-reservation dropdown +
  W-48b applicant reach-out): ONE "is this unit free + compatible" predicate,
  reused; server already enforces conflicts — make the UIs filter-first.
- ⬜ Batch 6 — form/flow rebuilds: W-8 maintenance assign (receipts,
  auto-unit-link, KILL man-hours, person picker), W-16 duplicate unit-number
  guard (DB unique + friendly 409), W-22 Configure Unit type-gating, W-24
  amenity toggles, W-28 lease detail read-only overview, W-30 bill-fee locked
  to lease terms (backend too), W-31 move-out deductions same + fix dead
  button (define "other" circumstances WITH Nic), W-33 e-sign send by
  unit/property, W-40+W-41 inspection form (type/unit/date only; derive
  tenant+lease; consolidate the two duplicate buttons), W-45 documents tab
  (real seed files, same-tab viewer — REUSE /view route from W-29, catch-all
  upload), W-46 inventory rebuild (add UI, service schedules for
  trucks/tools, targets+alerts), W-52 invite-time permissions (preset picker
  + W-10 property lock on the invite form).
- ⬜ Batch 7 — feature builds: W-2 rent roll page (rent-obligation principle:
  count non-paying + evicting), W-7 renewal decision form → drafts new lease
  for signature, W-10 permanent staff property lock (clarify "permanent"
  semantics with Nic), W-12 POS per-property separation (absorbs W-11),
  W-14 kill CSV template download, W-15 remove direct-pay (decide page-only
  vs platform-wide), W-32 on-demand early disbursement (pricing = Nic call).
- ⬜ Batch 8 — discuss/verify WITH NIC: W-20 schedule self-compression scope,
  W-27 pending-pool explainer, W-34 banking backend audit, W-44 amenity
  "hold", W-50 Checkr terms + pay-first flow, W-53 settings consolidation
  map, W-54 work-trade launch decision. Also confirm W-48's identity
  redaction model (pre-purchase anonymity = $1 unlock product design).
- LAST (after all portals): W-42 agents overhaul.

## KEY FIXES THIS SESSION (details in FINAL_WALKTHROUGH.md)
- **Dead-endpoint disease (3x)**: BackgroundChecksPage queried /background-checks
  (never existed → Nic's "blank Applications page"), InventoryPage queried
  /inventory (never existed), old lease View used post-await window.open
  (popup-blocked). New generic same-tab PDF viewer at route `/view`
  (PdfViewerPage.tsx) — reuse it for W-45.
- **camelCase disease (2x)**: BalancesPage + (earlier) LeasesPage read
  snake_case fields the interceptor camelizes. When a page shows "—"
  everywhere, CHECK THIS FIRST.
- **Notifications deep-link**: createNotification now accepts actionUrl
  (stored in the pre-existing action_url column); bell honors it before the
  TYPE_ROUTES fallback; lease-expiring + booking-draft emitters set it;
  /maintenance and /leases both support ?open=<id>. Other emitters still
  fall back to type routes — extend opportunistically.
- **Schedule**: names on lease bars paint on first VISIBLE cell (bars starting
  before the grid were nameless); unified detail popup (dates dayOnly-sliced
  — the `new Date(fullIso + 'T12:00:00')` Invalid-Date/NaN trap, again);
  master query now returns vlat.email/phone (remember: lateral columns must
  ALSO be projected in the outer SELECT); lease end-cap rounds ON end_date
  (inclusive) vs booking check-out (exclusive); List tab grouped
  Arriving/Here/Past.
- **KPI links**: Outstanding→/balances, Active Units→/units?status=active,
  Expiring→/leases?expiring=60 (pages read the params; banner + clear).
- **Platform fee $0 in past months**: seed now BACKDATES property created_at
  14 months (fee charges from onboarding forward — old seed convention).

## SEED / DATA STATE
- `apps/api/src/scripts/seedDemo.ts` — TWO full reseeds happened today (ids
  changed; Nic must hard-refresh). Seed now also: backdates onboarding,
  emits credit-ledger rental history via appendEvent (NEVER raw-insert
  credit_events — hash chain), recomputes stats/scores post-commit, populates
  bg-check names + pool preview fields, deep-links seeded notifications.
- Rental history: Alice 8 mo clean/100%, Bob rough patch, Grace 2 mo.
- No new migrations today (yesterday's 3 stand). Tests: schedule/units/
  bookings suites 38/38 green at close; both apps tsc clean.

## SERVICES (if Mac restarts)
Launch set only: `~/gam-start.sh models`, migrations, API + tenant/admin/
pos/admin-ops via nohup (see SESSION_527 shutdown notes), landlord under the
Claude preview (launch.json `landlord`). Marketing :3004 is launchd.

## NEXT SESSION
1. Read FINAL_WALKTHROUGH.md top to bottom (it IS the plan).
2. Resume batch 4 (global sweeps) — font candidates go to Nic before any swap.
3. Then batches 5→6→7, folding batch-8 discussions in as their items come up.
4. After the landlord list: Nic re-walks, then the other launch portals get
   their own lists (same protocol: log only, fix after close).

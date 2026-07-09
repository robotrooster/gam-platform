# SESSION 534 HANDOFF

## Theme
Nic's live walkthrough, part 2: utility-billing decoupling (per-UNIT
invoice holds replace run-batched billing), propane corrections, then a
deep leasing-workflow overhaul — lease click = the document, the parser
review window with document highlights, and the one-minute renewal flow
with the full deposit-chain fix (carry, interest continuity, delta
top-up, double-count overlay). Uncommitted (Nic commits).

## UTILITY BILLING — DECOUPLED FROM RUN COMPLETION (Nic's #3)
Billing is per-UNIT on each lease's invoice date, never batched to the
reading run:
1. Invoice cron (S178) per (lease, dueDate): TWO holds only, both hold
   the WHOLE invoice (rent included, never partial): (a) missing
   ORIGINAL read on a tenant-responsible submeter for a due,
   not-completed run cycle; (b) unresolved needs_review FLAG on such a
   meter. Daily retry → invoice generates dated its original due date
   when the hold clears. Other units unaffected. RUBS never blocks.
2. ensureBillsForUnit (services/utilityBilling.ts) generates any bills
   the unit's readings support right before the invoice pulls them —
   verification walk state NEVER blocks clean reads.
3. enterDoubleCheck: a bill already on an invoice (payment_id set)
   makes its reading IMMUTABLE — first read stands, drift bills next
   cycle. Un-invoiced stale bill on replacement → deleted + regen.
4. Force-complete escape got UI: "Complete now" on the run banner
   (unread meters release their holds; FLAGS still hold until review).
5. Invoice timing unchanged: 7am property-local on the lease due date.
6. Landlord bills table: new Reads column (padded start → end);
   migration 20260708100000 backfills reading_start/end on historical
   submeter bills from readings history (best-effort, data-only).
Tests: utilityReadingRuns 25/25 (5 new S534), leaseLifecycle 23/23.

## PROPANE (Nic's #1/#2)
- Split thresholds are LANDLORD-SET per property (migration
  20260708090000: propane_split_min_gallons default 40,
  propane_split_four_min_gallons default 100, CHECK four>=min). Shared
  propaneSplitOptions(gallons, min, fourMin) — constants = defaults
  only. Settings route + UI inputs next to the toggle; fill modal uses
  property values. propane.test.ts 9/9 (new thresholds test).
- Pay-time propaneNotice REMOVED everywhere (route + tenant modal):
  warning mid-payment invites ACH abandonment. The settle-time
  webhook notification (propane_priority_applied) is the ONLY surface —
  informational, after money moves. (Nic)

## LEASING OVERHAUL (Nic's walkthrough items)
1. LEASE CLICK = THE DOCUMENT: row click on /leases opens the PDF —
   executed e-sign doc, else imported original, else generated terms —
   with all ADDENDUMS merged on the end (one continuous contract).
   needs-review rows still open the confirm form. Details button =
   old overview modal. List defaults to CURRENT leases (active+pending);
   History (N) toggle reveals expired/terminated.
2. /view (PdfViewerPage) rewritten to pdf.js canvases — Safari doesn't
   render PDF blob iframes (Nic's "doesn't render"). All pages stacked.
3. PARSER REVIEW WINDOW (PendingTenantsPage): "Review" opens a
   side-by-side modal — left rail: parsed fields w/ confidence dots +
   flag cards; right: the document with HIGHLIGHT OVERLAYS over every
   text stretch a field was read from (gold clean / amber flagged,
   hover = field). Highlights located by pdf.js text-layer search of
   each field's rawText (parser stores what it read, not where).
   parser_output added to the pending-tenants list response.
   ANSWER for Nic: pending pool = importing an EXISTING signed lease
   PDF; new tenants at GAM units use e-sign templates.
   Demo: scripts/seedParserDemo.ts seeds Henry Park (Sunset Palms)
   parsed w/ 2 flags + a generated lease PDF. Rerun after reseeds.
4. RENEWAL = ONE MINUTE:
   - Dashboard to-do flips copy when a draft is open ("Renewal in
     progress — open it to finish signing"), same deep link.
   - RenewalDecisionModal: detects open draft (no more duplicate-409
     dead end) → Open & Sign / Void; template preselected to the
     predecessor's (GET /esign/documents/renewal-context/:leaseId).
   - Draft & Open for Signing: draft → auto-send → lands IN the doc.
   - Prefills = predecessor defaults, ALL editable in the doc (filled
     fields are now clickable): rent = current rent (also satisfies the
     send route's tagged-fields check), term mirrors duration (start =
     old end + 1 day), deposit = carried amount or 'N/A'.
5. SIGNPAGE FIXES (landlord + tenant copies): only date_signed fields
   auto-stamp today (term dates open a DATE PICKER — pre-fix every date
   field silently auto-filled with today, incl. lease start/end!);
   counter = required-only (was 7/6-capable); draft prefill values now
   load + display.
6. DEPOSIT CHAIN ON RENEWAL (Nic's deep-dive):
   - Real-world model confirmed + implemented: ONE continuous custody,
     never returned/re-collected. Carried lease_fees rows tagged
     '[carried forward from previous lease]' copy after move-in invoice.
   - BUG FIXED: security_deposits row (money/status/INTEREST accrual
     chain) now REBINDS to the successor lease at completion — deposit
     return + monthly interest cron look up by lease_id, so interest
     clock is continuous and move-out sees everything. FlexDeposit rows
     excluded (their forwarding owns linkage).
   - DOUBLE-COUNT GUARD: doc deposit == carried → pure carry; HIGHER →
     bills ONLY the delta ('[deposit top-up on renewal]' row; custody
     total_amount raised; funded→partial so recordDepositCollection
     accepts the pull); LOWER → nothing auto-refunds (manual partial
     return). Carry-forward dedupe ignores top-up rows.
   - OVERLAY: clicking the deposit field on a renewal shows the amber
     explainer (carried $X never re-bills / higher bills difference /
     lower needs manual return). GET /esign/sign returns
     carried_deposit for renewal docs.
   Tests: 3 new renewal deposit-chain tests, esign 84/84.

## INFRA FIXES FOUND DURING WALKTHROUGH
- /uploads static was mounted BEFORE cors() → cross-origin pdf.js
  fetches (template base PDFs) failed silently = blank sign pages.
  Moved after cors(). SECURITY: entire uploads dir (ID docs, executed
  leases) is served UNAUTHENTICATED — spawned background task chip
  "Lock down unauthenticated /uploads static serving" (pre-launch).
- uploads/docs/demo-lease.pdf was a blank 1.2KB stub → regenerated as a
  real lease form aligned to the demo template's field coordinates
  (scripts/generateDemoLeaseForm.ts — rerun after reseeds).

## MIGRATIONS APPLIED (2)
20260708090000_propane_split_thresholds ·
20260708100000_backfill_bill_reading_snapshots (data-only; first
attempt failed on LATERAL-vs-UPDATE-target and was rewritten with
correlated subqueries before ever applying — file on disk is the one
recorded).

## DEMO STATE
- Sunset Palms: July reading run still OPEN 0/10 (untouched); Henry
  Park parsed intent READY TO REVIEW in Pending Pool.
- Oak Street Apt 202 (Carol Vasquez): $500 deposit seeded (fee row; sd
  row pre-existed funded). Renewal walkthrough RESET: no open draft,
  dashboard to-do = "Lease expiring... Decide: renew or not". Voided
  drafts a24703be/61ee0bba/8efe5484/1fdde2a4 are e-sign history.
- Propane splits toggle OFF at Sunset Palms, thresholds 40/100.

## NEXT SESSION — NIC'S SAVED IDEA (priority)
CROSS-TEMPLATE RENEWAL MIGRATION: an onboarded (parsed-PDF) lease was
"style A"; by renewal time the landlord may have an entirely NEW
template. Auto-populate the old lease's parsed/structured info into the
new template smoothly — build as a TEST RUN first. Today's renewal
prefill already maps by lease_column, so a different template with
bound fields gets identity/rent/dates/deposit — the gap is fields the
new template binds that the old data can't fill (surface a checklist?)
and unbound/style-specific content. Design the "template migration
preview" before building.

## KNOWN GAPS
1. /uploads security lockdown (task chip pending).
2. Deposit REDUCTION at renewal = manual partial return (overlay says
   so); no auto-refund flow.
3. FlexDeposit custody rows don't rebind on renewal (excluded by
   design) — verify FlexDeposit renewal path when touching FlexSuite.
4. Landlord SignPage HMR can crash once to the error boundary during
   dev hot-reload (refresh clears; not production).
5. S533 leftovers unchanged: RUBS mgmt UI absent, meter-permission
   split deferred, US_FEDERAL_HOLIDAYS 2026-2027.
6. Then: W-56 work-trade, W-49/50 Checkr, W-42 agents (order unchanged).

## SERVICES
Launch set (API :4000, landlord :3001 preview, tenant :3002, admin
:3003, marketing :3004, POS :3005, admin-ops :3009, Hermes :8080,
embeddings :8081, Postgres :5432). Nic's Safari :3001 tabs reloaded
post-reset.

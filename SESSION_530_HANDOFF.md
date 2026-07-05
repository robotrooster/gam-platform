# SESSION 530 HANDOFF

## Theme
FINAL WALKTHROUGH fix phase — **Batch 6 nearly complete in one run**: 11 of
its 12 items shipped and live-verified (W-8, W-16, W-22, W-24, W-28, W-30,
W-31, W-33, W-40+41, W-45, W-52+W-10). **Only W-46 (inventory rebuild)
remains from batch 6.** Batches 7–8 after that, W-42 (agents) last.
Uncommitted (Nic commits). Tracker: FINAL_WALKTHROUGH.md — 39 items ✅.

## NIC DECISIONS CAPTURED THIS SESSION (via in-session questions)
- **W-10 "permanent"**: property fixed at invite, never editable by anyone;
  re-invite is the ONLY move path.
- **W-31 "other deductions"**: documented damages ONLY — description + ≥1
  photo/receipt required per line; everything else via lease fees + auto-sweep.

## SHIPPED (details inline in FINAL_WALKTHROUGH.md per item)
- **W-16**: case-insensitive unique index (new migration
  20260704120000) + friendly 409 in POST /units + real server message in the
  Add Unit review step. (An exact-case constraint already existed.)
- **W-40/41**: inspection form = type/unit/date; tenant+lease+move-in
  comparison all DERIVED; one entry button (?walkthrough=1 was dead).
- **W-28**: new LeaseOverviewModal (read-only info + View Full Lease → /view);
  disabled-form path survives only for needs-review confirm.
- **W-30**: bill-fee = lease_fees rows with due_timing='other' ONLY, at the
  lease's amount — locked in modal + route (leaseFeeId contract) + agent
  bill_fee tool. Seed now creates billable lease fees (Alice/Bob/Carol/Grace)
  — ALSO inserted into the live dev DB (no reseed; ids stable).
- **W-45**: real PDFs behind seed docs; authed GET /documents/:id/file
  streaming (missing file → clear 404); same-tab /view; Upload Document modal
  (type/unit tagging); list endpoint now joins unit/tenant names; NEW
  documents.upload permission key.
- **W-22/24**: Configure Unit gated by type (storage/commercial = lease-only
  note, no rates/booking knobs); amenities = per-type preset chips + add-your-
  own. KILLED a silent bug: comma-string amenities posted at text[] column.
- **W-33**: e-sign Send To = A Unit / Whole Property / Specific Emails. NEW
  GET /esign/recipients?unitId|propertyId resolves active lease_tenants;
  property mode sends one doc per lease with progress.
- **W-8**: receipts = documents rows ('receipt' category, migration
  20260704130000 adds category + documents.maintenance_request_id) via
  GET/POST /maintenance/:id/receipts, auto-linked to the unit; man-hours
  input killed (was also buggy — wrote into cost state); assignee picker
  already existed (S475).
- **W-31**: "Damage Deductions" — per-line evidence uploads (documents rows
  tagged to lease), client + server enforcement (zod min(1) evidence +
  landlord-ownership check). otherDeductions dropped from the PATCH API.
- **W-52+W-10**: invite = required property picker + preset row; preset keys
  ride scope_payload → applied to scope row on accept; onsite_manager scope
  PATCH rejects property changes 409 (first-set allowed for legacy empty
  rows); StaffPermissionsPage shows the binding read-only + note.

## GLITCH FIXED POST-BATCH: stacked React roots (all portals)
Nic hit duplicated login screens under the dashboard + dead nav after a long
dev session. Cause: Vite HMR re-executes main.tsx, and each re-run called
createRoot on the same #root — STACKING another mounted app per hot update
(the "createRoot called twice" console warning). Fix: every portal's entry
now reuses one root via `window.__gam_app_root` and re-renders into it —
idempotent across hot updates. Applied to ALL 12 React portals (landlord,
tenant, admin, pos, admin-ops, business, customer, fitness, listings,
pm-company, books, property-intel; marketing has no React entry). All tsc
clean. Verified: two forced main.tsx HMR cycles → still one app tree, nav
routes. A tab that was ALREADY stacked needs one hard refresh to clear.

## TESTS / STATE
- Suites green: units, units-gap-close, bookings, leases (59), leases-gap-close
  (22 — happy-path test updated for evidence contract), scopes (18),
  s417. tsc clean: api + landlord throughout.
- dbHelpers.cleanupAllSchema now deletes documents before landlords (FK).
- All verification artifacts cleaned from dev DB (test uploads, draft
  deposit-return on RV 08, RV 02 amenity toggle).
- Migrations added: units unique number, documents receipt+maintenance link.
  Both applied. Seed changes: lease fees block in seedDemo.ts (mirrored into
  live DB by hand — NO reseed happened; ids stable, no hard-refresh needed).

## NEXT SESSION
1. **W-46 inventory rebuild** (last batch-6 item): add-inventory UI on the
   tab (parts CRUD — /maint-portal/parts is the data source since S528's
   render fix); SERVICEABLE ASSETS (trucks/tools) with service schedules —
   schema has scheduled_maintenance to build on; min-quantity targets +
   low_stock alert wiring (column + notification type exist). Keep parts vs
   assets from complicating one surface (simplicity rule).
2. Then Batch 7: W-2 rent roll page, W-7 renewal decision form, W-12 POS
   per-property separation, W-14 kill CSV template, W-15 direct-pay removal,
   W-32 on-demand disbursement (pricing = ask Nic).
3. Batch 8 discuss/verify items, then W-42 agents LAST.

## SERVICES
Unchanged: launch set only; landlord under Claude preview :3001; API :4000
ts-node-dev (hot-reloads applied throughout — no restarts needed).

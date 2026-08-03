# SESSION 576 HANDOFF — S575 punch list + Work-Trade addendum + Snowbird design & Phase 1

**Theme:** Cleared the entire S575 landlord-portal punch list (B-1…B-10), fully
built the B-8 Work-Trade↔lease coupling (incl. addendum + renewal auto-carry),
then designed the Snowbird/seasonal-tenancy feature end-to-end (spec written) and
shipped its Phase 1 (hibernating lease). Long session — this is the clean restart.

**Repo:** `~/gam`. Dev servers running (landlord :3001, tenant :3002, admin
:3003, + others). Dev portal → **prod** API on :4000 (`com.gam.api` launchd),
**rebuilt + kickstarted** many times this session — current code is LIVE. Demo
landlord for QA: `james@demo.dev` / `landlord1234` (has data; landlord email-2FA
— in dev, @demo.dev emails are SUPPRESSED so the OTP isn't retrievable; to log in
I overrode the `login_email_otps` hash for a known code — a fresh login will need
the same trick or a persisted session).

**GIT: nothing committed this session.** Everything below is on disk,
typecheck-clean, tested/verified. Nic decides when to commit. (S575 §A was also
still uncommitted at session start — still is.)

**Migrations applied this session (all live):**
- `20260801140000_lease_template_purpose.sql` — `lease_templates.purpose`
- `20260801150000_work_trade_addendum_doc_type.sql` — `work_trade_addendum` doc type
- `20260801160000_lease_document_work_trade_link.sql` — `lease_documents.work_trade_agreement_id`
- `20260801170000_lease_hibernation.sql` — `leases.is_hibernating` + `hibernated_at`

---

## §A — SHIPPED + VERIFIED THIS SESSION

### 1. S575 punch list B-1…B-10 — ALL DONE
- **B-1 perpetual calendar** (SchedulePage.tsx): fromDate/toDate now stateful;
  infinite forward scroll (maybeExtendForward) + jump-to-date control +
  `keepPreviousData`. Toolbar cluster: date + Go + Today (flexWrap nowrap).
- **Reusable [ListControls.tsx]** (SearchBox + PropertySelect) dropped into
  **B-2 Units**, **B-3 Tenants**, **B-6 Leases + E-Sign**, **B-7 Payments**
  (Payments/E-Sign key on propertyName; others on propertyId). PropertySelect
  auto-hides for single-property landlords.
- **B-5 Bank Feed vs Reconciliation**: distinct (categorize vs statement-match);
  added reciprocal cross-link signposts; fixed stale "no feed until Plaid".
- **B-9 Screening**: nav lands on Background Checks (NAV_ITEMS reorder in
  Layout.tsx); "Rental History" header reframed (was "Tenant Screening /
  network-visible behavioral record").
- **B-10 Team invite**: full 105-key permission catalog inline via new
  **[PermissionCatalogEditor.tsx]** (presets + toggles) — set exact perms before
  the invite sends. (Verified up to send; didn't fire a real invite email.)

### 2. B-8 Work-Trade ↔ lease coupling — DONE (memory: `gam-worktrade-lease-coupling`)
- **Active-lease gate** at agreement creation (workTrade.ts) + **pause on
  lease-expiry** (scheduler.processLeaseEnds) + **derived to-do** (/me/todos).
  Tests: workTrade (26) + landlords-todos (12).
- **Work-trade addendum** (bring-your-own form): template `purpose`
  designation (ESignPage New Template "Form Type"); dedicated "Send addendum"
  button on WorkTradePage; **purpose-aware regular e-sign flow** (picking an
  addendum template in Send Document creates `addendum_terms` on the active
  lease, not a new lease); **renewal auto-carry** (esign.ts
  `autoDraftWorkTradeAddendumForRenewal` hooked into sign-completion → drafts
  UNSENT addendum on new lease → landlord "Review & send" via cell + dashboard
  to-do). Verified: WorkTradePage cell + to-do (live test doc), 124 esign tests.

### 3. Snowbird / seasonal tenancy — DESIGN LOCKED + Phase 1 SHIPPED
Full spec: **`~/gam/SNOWBIRD_SEASONAL_SPEC.md`** (memory:
`gam-snowbird-seasonal-tenancy`). KEY FINDING: the reservation engine is MOSTLY
ALREADY BUILT — `scheduleCompression.relocateBlockingBookings` already does the
priority-relocation rule (refuses checked-in/revealed/lease-bound/`locked_to_unit`;
relocates to compatible open spot; "no open site" when full — LIVE-tested a real
RV02→RV01 move), `locked_to_unit` (S547) is the snowbird spot-lock, and
`revealTodaysSites` is the morning-of reveal (CHANGED this session to fire
**6:30am property-local**, was check_in−1h). So net-new = the LEASE/account side.
- **PHASE 1 SHIPPED + live-verified:** `leases.is_hibernating`; billing gated in
  `invoiceGeneration.ts` + `platformFeeAccrual.ts`; `POST /leases/:id/hibernate`
  + `/resume` (pause/resume work-trade in lockstep); LeasesPage Hibernate/Resume
  button + amber badge. Tests +2 (hibernating→0 invoices, resume→bills; 25 pass).
  Live: hibernated Grace RV08 → work_trade paused + is_hibernating=t; resumed → back.
  ACH stays untouched (rent invoice-driven → no invoice = no pull; VERIFIED).

---

## §B — OPEN THREADS / DECISIONS NEEDED (do next)

1. **Snowbird Phase 2** — auto-recurring, spot-locked seasonal reservation
   (season config on lease/companion row + yearly generation, coupled to the
   lease window). Then Phase 3 (priority marker → wire to the EXISTING
   relocateBlockingBookings + audit log), Phase 4 (guest-friction downgrade/
   upgrade layer + deposits + tenant self-service). All spec'd.
2. **Phase 1 follow-ons** (noted in leases.ts + spec): (a) settle final arrears
   utility at departure BEFORE hibernating (else an unbilled utility won't bill);
   (b) precise `paused_by_hibernation` marker so resume only reactivates what
   hibernation paused.
3. **B-8 seasonal makeup hours** — PARKED on Nic's call: changes the LOCKED
   work-trade credit spec (100% cap). Options in `gam-worktrade-lease-coupling`.
4. **B-8 #2 generic "carries to renewals" checkbox** — BLOCKED: no generic-
   addendum send UI exists in the app; would be dead code. Build that UI first
   or leave it.
5. **Standalone-doc e-sign completion bug** — spawned as its own task
   (task_ea0a56f4, running separately): `buildLeaseFromDocument` is called
   unconditionally at sign-completion and throws for no-lease doc types →
   `execution_failed`. Affects the S568 standalone "New Contract" feature. Verify
   + fix (prereq if generic addendums ever route through standalone).

---

## §C — HOW TO START
1. Read this file + `~/gam/SNOWBIRD_SEASONAL_SPEC.md`. Recall memories
   `gam-snowbird-seasonal-tenancy`, `gam-worktrade-lease-coupling`,
   `gam-prod-api-restart`, `gam-mandatory-2fa-and-pos-passcode`.
2. Everything §A is DONE + uncommitted — verify on disk before extending.
3. Prod-API changes: rebuild (`cd apps/api && npm run build`) + `launchctl
   kickstart -k gui/$(id -u)/com.gam.api` (GOTCHA: orphan on :4000 → EADDRINUSE).
4. Run only directly-affected test suites (memory `test-scope-focused-changes`).
5. Don't initiate commit/smoke-walk (house rules).

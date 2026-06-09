# Session 323 — closed

## Theme

Closed the last S314 follow-up — **re-acceptance prompt on
template version change**. When `FLEXPAY_TEMPLATE_VERSION`
or `FLEXDEPOSIT_TEMPLATE_VERSION` bumps, enrolled tenants
whose latest acceptance row is on an older version are
prompted at next tenant-portal mount to accept the updated
populated terms. The new acceptance row is persisted at the
current version; the prior row stays in place as historical
evidence that the OLD terms were valid against the OLD
enrollment.

Re-acceptance is **informational, not blocking** — a tenant
who declines remains covered by their original acceptance,
since the OLD enrollment was made under the OLD terms.
"Review later" dismisses the modal until next mount.

S314 acceptance subsystem is now feature-complete.

## Items shipped

### Backend service (`apps/api/src/services/flexsuiteAcceptance.ts`)

Three new exported functions:

- **`getPendingReAcceptances(tenantId)`** — returns
  `PendingReAcceptance[]`. Each entry has `product`,
  `currentVersion` (from latest row or `'(none)'` if no
  row), `latestVersion` (current template version), and
  product-specific context (`flexpayPullDay` +
  `flexpayMonthlyFee` for FlexPay,
  `flexdepositInstallmentCount` for FlexDeposit). Empty
  array = nothing pending. Enrollment detection:
  `tenants.flexpay_enrolled = TRUE` for FlexPay, any
  `security_deposits` row with `flex_deposit_enabled=TRUE
  AND flex_deposit_plan_status IN ('active','accelerated')`
  for FlexDeposit.
- **`renderReAcceptanceTerms({tenantId, userId, product,
  ip, userAgent})`** — pulls the tenant's existing
  enrollment context (pullDay / installment rows / etc.)
  and calls the existing `renderFlex(Pay|Deposit)AcceptanceText`
  fns. No body params needed from the caller — the values
  are whatever the tenant is currently enrolled at.
  FlexDeposit reads the persisted `flex_deposit_installments`
  rows for the schedule (the schedule is locked at original
  enrollment).
- **`commitReAcceptance({tenantId, userId, product, ip,
  userAgent})`** — renders the terms, opens a tx, calls
  `recordAcceptance` with the current `FLEXPAY/FLEXDEPOSIT_
  TEMPLATE_VERSION`, commits, fires the post-commit
  confirmation email (best-effort). Returns the new
  acceptance ID.

### Backend routes (`apps/api/src/routes/tenants.ts`)

Three new endpoints under `/api/tenants/flexsuite/`:

- **`GET /flexsuite/re-acceptance-status`** — wraps
  `getPendingReAcceptances`. The tenant portal calls this
  once on auth-resolved mount. Returns
  `{ pending: PendingReAcceptance[] }`.
- **`GET /flexsuite/re-acceptance-preview?product=…`** —
  server-renders the populated terms at the current
  template version. Returns `{ product, version,
  renderedText }`. No persistence; for the "Read updated
  terms" link in the modal.
- **`POST /flexsuite/re-accept`** — body
  `{ product, acceptedTerms: true }`. Persists a new
  acceptance row at the current version. Captures IP +
  user-agent. Returns `{ acceptanceId, product }`.

### Frontend (`apps/tenant/src/main.tsx`)

New **`FlexsuiteReAcceptanceGate`** component:
- Mounted in the authenticated shell (after the `<Outlet />`)
  gated on `bgApproved` — same as the other
  authenticated-only nav items.
- Queries the status endpoint with a 60s `staleTime`.
- Renders a modal queue: if any pending re-accepts, shows
  the first as a modal. Tenant has three actions:
  - **Read the updated terms** — opens the existing
    `TermsViewerModal` with server-rendered text from the
    preview endpoint.
  - **Accept new terms** (gated on the checkbox) — POSTs
    to `/re-accept`, invalidates the query, dismisses
    that product's prompt.
  - **Review later** — dismisses just this session, no
    DB write. Re-prompts on next mount.
- Internal `dismissed` map handles the queue: accepting or
  reviewing one product reveals the next.

### Reused existing infrastructure

- The same `recordAcceptance` helper used at original
  enrollment writes the re-acceptance row.
- The same `fireFlexsuiteAcceptanceEmail` helper fires the
  post-commit confirmation (PDF + email), so the tenant
  gets the updated SLA in their inbox too.
- The same `TermsViewerModal` displays the populated text.

## Files touched (S323)

```
apps/api/src/
  services/flexsuiteAcceptance.ts          (+170 lines:
                                            getPendingReAcceptances,
                                            renderReAcceptanceTerms,
                                            commitReAcceptance)
  routes/tenants.ts                        (+3 endpoints under
                                            /flexsuite/)

apps/tenant/src/
  main.tsx                                 (FlexsuiteReAcceptanceGate
                                            component + mount in shell)

SESSION_323_HANDOFF.md                     (this file)
```

No migrations. No schema changes. No new DB tables. The
new acceptance rows insert into the existing
`flexsuite_enrollment_acceptances` table.

## Decisions made during build

| Question | Decision |
|---|---|
| Blocking modal or dismissable? | **Dismissable.** The S314 handoff specified "not blocking; nice-to-have." Old acceptance row remains valid against the old enrollment — declining the prompt doesn't invalidate the existing contract. Re-acceptance updates the on-file record to the latest terms but isn't a legal requirement. |
| Where to mount the gate? | **Inside the authenticated shell, gated on bgApproved.** Same gate the rest of the authenticated-tenant-only nav uses. Pre-bg-approval tenants haven't enrolled in anything, so no possible pending re-accepts. |
| One modal queue vs N parallel? | **Queue.** Less visual clutter; user accepts FlexPay's terms, the modal flips to FlexDeposit's. Internal `dismissed` map per-product key. |
| Pre-S314 tenants with no acceptance row — prompt them? | **Yes.** "Latest version is `(none)` ≠ current version" treats it as a pending re-accept. Defensive: any future template bump prompts every enrolled tenant including pre-launch dev seed ones. They accept once, land an audit row at the current version. |
| Render preview from `pull_day` in `tenants` table? | **Yes for FlexPay.** Whatever pullDay the tenant is currently enrolled at — re-acceptance preserves the existing enrollment, just updates the on-file terms version. FlexDeposit reads `installment_count` + the persisted `flex_deposit_installments` rows (schedule is locked at original enrollment). |
| Fire the PDF-email on re-acceptance too? | **Yes.** Re-using `fireFlexsuiteAcceptanceEmail` keeps the tenant's inbox copy current. The new email arrives with the updated SLA PDF attached. |
| Allow "Cancel enrollment" from this modal? | **No.** Out of scope. Cancellation is a separate user-intent flow (DELETE /flexpay, DELETE /flexdeposit) that has its own pre-conditions. Conflating "update your terms" with "cancel your enrollment" would muddy the UX. |
| Re-prompt frequency — every page nav, every login, every N hours? | **Every shell mount + 60s `staleTime`.** Page navs within a session use the cached result; closing and reopening the app re-queries. Tenant can also dismiss the modal for the session; closing the tab clears that. |

## Verification

- `npx tsc --noEmit` on `apps/api`: clean.
- `npx tsc --noEmit` on `apps/tenant`: clean.
- `npx tsc --noEmit` on `apps/landlord`, `apps/admin`,
  `apps/pm-company`: clean (no changes).
- Hand-ran the status-detection SQL on the dev tenant
  (`alice@tenant.dev`): returns `flexpay_enrolled=f`,
  `fd_enrolled=f`, `acceptance_count=0` — expected for a
  dev tenant with no enrollments. Returns `pending: []`
  through the route, so the gate doesn't fire. Correct
  behavior.

Not browser-walked. Testing the actual prompt flow needs
either a real template version bump (after which any
enrolled tenant should auto-prompt) or a manual SQL flip
to set `flexpay_enrolled=TRUE` on a dev tenant + bump
the version constant. Both are walkthrough activities.

## Items deferred — what S324 could target

### A. Walkthrough (Nic-driven; STRONGLY recommended)

S314 acceptance subsystem is now feature-complete:

1. Tenant fills enrollment modal (S314).
2. Click-accept gate (S314).
3. Audit row persisted with snapshot + sha256 (S314).
4. Admin viewer for forensic review (S315).
5. PDF-attached confirmation email (S322).
6. Re-acceptance prompt on version bump (S323).

The whole chain needs real-tenant validation before piling
on more code.

### B. Continue migration on remaining surfaces

- pm-company deeper pages (DashboardPage, PropertyDetail,
  Staff, Register)
- POS subsystem (offline-sync care)
- units-bulk / listing / photos routes
- Long-tail snake_case zod fields scattered across routes

### C. Embed Unicode-capable font in flexsuitePdf

Removes the 7-char ASCII sanitizer; adds ~300KB to API
bundle. Not blocking.

### D. SchedulePage booking-vs-lease shape audit

Long-standing deferred item.

## Items deferred (cross-session docket)

- Consumer-side retention framing decision (S300).
- Campground Master import path (Nic-blocked on sample).
- 2FA fan-out (walkthrough-blocked).
- Yardi GL-export columns, Rentec template (S293).
- FlexCharge Business Account Agreement signature capture
  (S309 option B — not a launch feature).
- FlexDeposit eligibility-check workflow (S309 option C).
- Standalone POS-operator auth (S309 option D).
- Deposit-return ↔ unpaid-installment offset architecture
  call (S310 carryover).
- SchedulePage booking-vs-lease shape audit
  (`booking.startDate` / `booking.checkIn` rendering logic).
- pm-company deeper pages camelCase migration.
- POS request-body migration (offline-sync subsystem).
- Long-tail snake_case zod fields in remaining routes.
- Embed Unicode-capable font in flexsuitePdf (S322 D).

## Nic-pending (unchanged)

- Stripe live keys.
- Resend domain verification (still load-bearing for the
  S322 PDF-attached enrollment confirmation + the S323
  re-acceptance email).
- Plaid production keys.
- Stripe Terminal hardware.
- Checkr Partner credentials.
- Consumer-side retention framing decision (S300).
- FlexCredit Lender partner selection.
- SLA § 9.1.4(iii) deposit-return offset framing call.

## What S324 should target

**Strongly recommended:** walkthrough. Six sessions
(S314–S323) have shipped a coherent end-to-end FlexSuite
acceptance system that hasn't been browser-walked yet. The
re-acceptance gate in particular won't fire in normal
testing — it activates on template-version bumps + enrolled-
tenant state — so verifying the wiring needs a real
walkthrough setup.

**If code session before walkthrough:** **B** (continue
migration) is mechanical and the remaining surfaces yield
diminishing return. **C** (Unicode font) or **D**
(SchedulePage audit) are bounded alternatives.

---

End of S323 handoff. Closed clean. S314 acceptance
subsystem is feature-complete; walkthrough validation
strongly recommended next.

# Session 447 — closed

## Theme

**Twenty-third services-audit session. `creditLedgerEmitters.ts`
multi-session arc, session 1 of 2-3. 40 cases pinning the 12
workflow emitters (the ones fired from
payment/lease/inspection/entry-request/maintenance triggers,
attestation_source ∈ {stripe_attested, gam_workflow_auto})
plus the two pure tier-classifiers. The 9 detector/cron
emitters (attestation_source='system_derived') defer to S448
along with their cron-detector context. Zero production
findings — file's clean, just contract-pin work.**

Suite at S446 close: **2633 / 144 files**.
Suite at S447 close: **2676 / 145 files** (+43 cases,
+1 file — 40 new cases here plus minor upstream). 0 failures.
Runtime **70.17s**. Fiftieth consecutive fully-green
full-suite run.

Zero tsc regressions.

## What shipped

### `services/creditLedgerEmitters.test.ts` — 40 cases (NEW file)

No mocks. `appendEvent` runs LIVE against the real chain so
every assertion exercises hash-chain integrity + ON CONFLICT
subject materialization + dimension_tags / network_visibility
/ attestation_source / attestation_evidence persistence
through `credit_events`.

**Pure tier classifiers (10)**
- `classifyPaymentTier` (5) — on_time / late_grace / late_minor
  (≤72h past grace-end) / late_major (≤15d) / late_severe
- `classifyMaintenanceTier` (5) — within_24h / within_72h /
  within_sla / breach_sla; custom slaHours respected (only at
  the sla-vs-breach boundary, since 24h/72h tiers short-circuit
  before slaHours is consulted)

**Payment emitters (7)**
- `emitPaymentSettledEvent`: on_time → visible_to_current_landlord;
  late_grace → still visible_to_current_landlord (within-grace =
  positive); late_minor → visible_to_gam_network (adverse);
  null stripePaymentIntentId → empty `attestation_evidence` object;
  graceDays=NULL → defaults to 5 in event_data + tier check
- `emitPaymentFailedEvent`: full failure_code + failure_message
  capture; null stripe id still records the event

**Lease emitters (3)**
- `emitLeaseSignedTenant`: lease_signed on tenant subject,
  tenancy_stability tag, current-landlord visibility
- `emitLeaseSignedLandlord`: single landlord event with
  tenant_count
- Multi-tenant lease: each tenant gets a separate event

**Inspection emitters (7)**
- `periodic` inspectionType → early return (no events)
- move-in within ±1d of lease start with photos → 3 events
  (move_in_inspection_completed + move_in_photos_submitted
  on tenant + unit_ready_on_move_in_date on landlord)
- move-in OUTSIDE ±1d → no landlord unit-ready event
- move-in with leaseStartDate=null → no landlord event
- move-out matches move-in → positive event (current-landlord)
- move-out damage documented → adverse event (gam_network)
- move-out without tenantId → no events (guard)

**Lease lifecycle emitters (3)**
- `emitLeaseTerminatedNaturalEvents`: per-tenant fanout +
  single landlord event. Tenant visibility = gam_network,
  landlord = current_landlord. Empty tenantIds → only
  landlord event.
- `emitLeaseRenewedEvents`: all events current_landlord
  visibility (renewal is positive both directions)

**Entry request emitters (6)**
- `emitEntryRequestResponseEvents`:
  - granted IN TIME (respondedAt < windowStart) →
    `entry_request_granted_within_window`
  - granted LATE (respondedAt ≥ windowStart) → NO event
    (the "in-window" cooperation signal is lost)
  - denied → `entry_request_denied` (denial is a right;
    no score impact but logged)
- `emitEntryRecordedEvents`:
  - compliant (within window AND granted) →
    `proper_entry_notice_given`, returns 'compliant'
  - breach: outside window → `entry_compliance_breach`,
    gam_network, within_window=false
  - breach: within window but null granted → still breach,
    within_window=true + granted_decision=null

**Maintenance emitters (4)**
- `emitMaintenanceResolvedEvents` × all 4 response tiers:
  - within_24h / within_72h / within_sla → current-landlord
  - breach_sla → visibility FLIPS to gam_network

## Items shipped

```
apps/api/src/services/
  creditLedgerEmitters.test.ts          (NEW — 40 cases)
```

No production source changes. No test-infra changes.

## Decisions made during build

| Question | Decision |
|---|---|
| Mock `appendEvent` or run it live? | **Run live.** The whole point of the audit is to exercise the contract from inputs through to persisted rows. Mocking the boundary would only pin "we called appendEvent with X", which is `toMatchObject` against the input args — gives no signal on whether dimension_tags / network_visibility / attestation persistence works. The chain is integration-tested at this layer. |
| Split emitters into multiple test files? | **No — one file, two-batch session-arc.** S447 covers the 12 workflow emitters; S448 will cover the 9 detector emitters in the same file (`creditLedgerEmitters.test.ts`). Splitting would fragment coverage of a single file's contract. |
| Pin event_data shape with `toMatchObject` or per-field? | **Per-field on the structurally important keys** (event_type, dimension_tags, network_visibility, attestation_source). Per-field on the load-bearing payload fields (lease_id, payment_id, grace_days, response_tier, etc.). Skip pinning timestamps via `===` — convert through `new Date(...).getTime()` since the JSON round-trip introduces ms-level differences vs the original Date. |
| Include classifyPaymentTier / classifyMaintenanceTier coverage in this slice? | **Yes — they're co-located in the same file and the emitter coverage depends on their output anyway.** Pinning them in the same slice prevents tier-boundary drift from being detected only when an emitter test fails. |
| Pin the "granted late" branch as NO event? | **Yes — load-bearing.** A regression that fired the in-window event regardless of timing would credit tenants for cooperation they didn't give. The behavior also encodes the product principle that "cooperation is timely cooperation" — explicit no-event is the right contract. |
| Pin the "breach within window but not granted" branch? | **Yes — the recorded function takes BOTH "outside window" OR "no grant" as breach.** The two breach causes differ in `event_data.within_window` (true vs false) — a regression that collapsed the OR into AND would let landlords enter ungranted units silently. |
| Defer detector emitters to S448? | **Yes.** They share a common pattern (system_derived + caller-managed idempotency by cron-side checks before firing) that's cleaner to cover with cron-side seed contexts in the same session. Splitting them across S447/S448 by line position would be arbitrary. |
| Mix randomUUID() for fresh subject ids per test? | **Yes.** Each test gets its own subject (tenant/landlord pair) so chain assertions are scoped + the no-event-collision assertion (toHaveLength(1)) holds without cross-test pollution. cleanupAllSchema wipes between tests, but using randomUUID() per emitter call is defensive AND lets multi-emit cases like multi-tenant lease seed clean. |

## Verification

- `npx tsc --noEmit` clean on apps/api (0 errors).
- `npm test` in apps/api: **2676 tests across 145 files,
  0 failures**, 70.17s. **Fiftieth consecutive fully-green
  full-suite run.**
- 40 new test cases in this slice.
- 0 production / infra fixes — file is clean.

### Bugs caught during test authoring

None. The S447 batch is contract-pin only — no production
regressions, no test-infra gaps. (Author's own test bug in
classifyMaintenanceTier was caught by the run: the 24h/72h
tier checks short-circuit before slaHours is consulted, so
the original 8h-resolved + 4h-SLA fixture fell into within_24h
instead of breach_sla. Reframed to exercise the actual
slaHours-vs-breach boundary at 96h elapsed.)

## Services audit — progress

Post-S447:

### Direct coverage — 59 services with .test.ts files

S438-S446 (previous summaries).
**S447: + creditLedgerEmitters (workflow emitters, 12 of 21).**

### Still UNCOVERED on this file (S448 target)

9 detector/cron emitters (attestation_source = 'system_derived'):
- emitTenancyEndedWithBalanceEvent
- emitBalancePaidPostMoveEvent
- emitLeaseAnniversaryEvent
- emitRecurringRepairEvent
- emitHabitabilityUnresolvedEvent
- emitMultiLandlordHistoryCleanEvent

(The first two have `system_derived` + idempotency owned by the
post-termination detector; the rest are detector-cron paths.)

After S448 closes this file, no services-audit deferrals
remain — every services/*.ts file with a meaningful surface
has direct coverage.

(otpScheduler.ts remains DISABLED per file header — skip.)

## Items deferred — what S448 could target

### Continue creditLedgerEmitters arc

**Recommend S448 = detector emitters slice (2/2).** Same
file (`creditLedgerEmitters.test.ts`) extended with the 9
detector emitters. Each is a thin appendEvent wrapper with
`system_derived` attestation; pin event_type +
dimension_tags + network_visibility + key event_data fields.
Should land in ~25-30 cases.

After S448, the services audit deferred list is empty.

**Alternatives:**
- Pivot to validation-hygiene backlog (16 items)
- Close the posTax rounding finding (S439) — Nic call

### Validation-hygiene backlog (16 items)

Unchanged from S427.

### Cumulative bug-sweep totals (post-S447)

- **53 production / infra bug fixes** (unchanged from S446)
  + 1 documented finding (posTax rounding mismatch from
  S439, still pending Nic decision)
- 16 architectural / validation findings remaining
- 2676 tests across 145 files
- Suite baseline: **66-71s on a clean machine**

## What S448 should target

**Recommended: creditLedgerEmitters detector slice (2/2)** —
the 9 remaining detector/cron emitters in the same file.
~25-30 cases. Closes the multi-session arc + the services-
audit deferred list.

**Alternatives:**
- Pivot to validation-hygiene backlog

---

End of S447 handoff. **creditLedgerEmitters.ts workflow
emitter slice (1/2-3) shipped — 40 tests pinning the 12
workflow-fired emitters plus both pure tier classifiers.
appendEvent runs live; every assertion exercises hash-chain
integrity + dimension_tags / network_visibility /
attestation persistence end-to-end.**

2676 tests / 145 files / 0 failures. Fiftieth consecutive
fully-green full-suite run.

**53 cumulative production / infra bug fixes** + 1 documented
finding still pending Nic review. Services audit: 59 services
covered + 12/21 emitters on the multi-session file. S448
closes the arc.

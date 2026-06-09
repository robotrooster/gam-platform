# Session 134 Handoff

**Theme:** Credit Ledger v1 — full backend build. Hash-chained,
Merkle-anchored event ledger across tenants/landlords/managers/
properties; unbounded multiplicative score model; visibility-gated
API; dispute lifecycle; nightly recompute crons; weekly Merkle
anchor; inspection workflow built so move-in/move-out events have
an emitter.

This session collapsed what `CREDIT_LEDGER_V1.md` originally split
into "Session A" (foundation) + "Session B" (score and API), plus
the inspection workflow that was deferred because no emitter
existed for the seeded move-in/move-out scoring values.

## Architecture decisions locked in chat (now in production)

### Score model is **unbounded multiplicative**

Replaces the doc's 0–1000-bounded model. Locked in chat:

- score starts at 0, floor at 0, no ceiling
- positives = flat point additions (× attestation_weight)
- negatives = percentage of CURRENT score (× attestation_weight),
  compound across multiple negatives
- no decay window; events apply once and stay
- recovery = new positive events, not the passage of time
- most severe (eviction judgment, lease abandoned) = -50%
- confidence shown as event count, not a ± interval
- dimensions are event TAGS only — not separate scores. Composite
  is the score; dimension rollups are sums for display
- score is internal-only (gated to GAM lending services); external
  parties never see the number

### Anti-fraud rule: **score outcomes, not unilateral actions**

Events one party can fabricate alone (submission, acknowledgement,
request) do NOT score in v1. They go in the ledger as informational.
Only outcomes that require the other party (payment via Stripe,
lease via e-sign, maintenance response within SLA, granted entry,
inspection finalized) are weighted ≠ 0.

This is enforced via `attestation_weight` on the formula:
- `gam_workflow_auto`, `stripe_attested`, `gam_bill_pay_attested`,
  `plaid_attested`, `aggregator_attested`, `carrier_attested`,
  `lender_attested`, `partner_cra`, `landlord_self_reported_with_evidence`
  → weight 1.0
- `tenant_self_reported_with_doc_verified` → 0.5
- `tenant_self_reported` → 0.0 (informational only)

### Forward-compatible architecture for v1.5+ / v2.0+

- Bill-pay product (Fiserv aggregator, MSB registration, Reg E
  compliance) is v2.0. Schema and event types are seeded NOW so
  no migration is needed when integrations land.
- Plaid Liabilities and carrier APIs are v1.5. Same deal:
  `external_account_links` table exists, scoring values for
  utility/telecom/auto_loan/insurance/medical/subscription/
  child_support are seeded.
- ODFI partnership and bank-charter purchase are sequenced in the
  GAM roadmap (v1.5 ODFI, v2.5 charter). No v1 work needed but
  flagged in valuation conversation.

### Inspection workflow built (move-in/move-out) so seeded events fire

`unit_inspections` + `unit_inspection_items` + `unit_inspection_photos`
+ `unit_inspection_signatures`. Move-out compares against the
move-in via `comparison_inspection_id`; a single damaged item flips
the comparison to `move_out_condition_damage_documented`. Tenant
and landlord both sign before finalize.

### What v1 explicitly does NOT do

- No external API for the score; no public score URLs
- No sharing record outside GAM
- No score visible to landlords for prospective tenants — only
  current/past tenants in their own GAM history
- No state-specific legal logic
- No status-class events (alcoholism, mental illness, etc.) —
  conduct events with authoritative attestations only
- No FCRA/CRA furnishing — that's a v3+ separate-legal-entity move

## Shipped — backend foundation (10 migrations + service layer)

### Migrations

```
20260505120000_credit_subjects.sql              — polymorphic root
20260505130000_credit_events.sql                — hash-chained ledger
20260505140000_credit_disputes.sql              — dispute lifecycle
20260505150000_credit_hardship_contexts.sql     — tenant context
20260505160000_credit_score_formulas_seed.sql   — formula table + v1.0.0 seed
20260505170000_credit_scores.sql                — score snapshots
20260505180000_credit_stats.sql                 — derived stats panel
20260505190000_credit_merkle_anchors.sql        — weekly integrity + landlords.network_tier
20260505200000_external_account_links.sql       — v1.5+ scaffold
20260505210000_inspection_workflow.sql          — inspection schema (4 tables)
```

All applied via `npm run db:migrate`. `schema.sql` regenerated to
9213 lines.

### Shared package — 14 new enums

`packages/shared/src/index.ts` CREDIT LEDGER section:

- `CreditSubjectType` (4 values)
- `CreditEventType` (~115 values — full v1 catalog plus forward-compat
  utility/telecom/auto_loan/insurance/medical/child_support/
  subscription/bill_pay event types reserved for v1.5+ and v2.0+)
- `CreditAttestationSource` (15)
- `CreditScoreDimension` (5)
- `CreditNetworkVisibility` (3)
- `CreditDisclosureScope` (1 in v1)
- `CreditDisputeStatus` (5)
- `CreditDisputeReason` (4)
- `CreditHardshipCategory` (6)
- `CreditSupersedeReason` (3)
- `CreditNetworkTier` (1 in v1)
- `ExternalAccountCategory` (11)
- `ExternalAccountProviderKind` (7)

### Services

- `services/creditLedger.ts` — `appendEvent`, `getOrCreateSubject`,
  `getSubjectChain`, `verifyChain`, `computeMerkleRoot`,
  `supersedeEvent`, `findSubjectId`, `canonicalJson`,
  `computeEventHash`. Per-subject advisory locks; SHA-256 chain
  hash; pure-deterministic replay.
- `services/creditLedgerEmitters.ts` — workflow-specific emitters:
  payment-tier classification + emit, payment-failed/NSF,
  lease-signed (per tenant + once per landlord), maintenance
  response-tier + emit, **inspection finalized (move-in / move-out
  / photos / unit-ready-on-move-in / condition-matches-vs-damage)**.
- `services/creditScore.ts` — `loadFormula`, `loadCurrentFormula`,
  pure `computeScore` (replays in chronological order, applies
  attestation weight, enforces spam_caps), `recomputeAndSnapshot`,
  `recomputeAllSubjects`, `getLatestScore`. Persists snapshot tied
  to current Merkle root.
- `services/creditStats.ts` — derives lifetime / 12mo / 90d
  payment slices, on-time streak, dimension rollups; upserts
  credit_stats row.
- `services/creditDispute.ts` — `openDispute`,
  `submitDisputeEvidence`, `resolveDispute` (with auto-supersede
  on `corrected` outcome + post-commit recompute).

### Webhook hooks

`apps/api/src/routes/webhooks.ts`:
- `payment_intent.succeeded` — emits `payment_received_*` (5-tier
  classification by `late_fee_grace_days` against `due_date` vs
  `settled_at`) inside the settlement transaction
- `payment_intent.payment_failed` — emits `payment_failed_nsf` only
  when terminal (retries exhausted)

### Workflow hooks

- `routes/esign.ts` `executeOriginalLease`: per-tenant
  `lease_signed` events + a single landlord `lease_signed` event,
  in the same transaction as lease materialization
- `routes/maintenance.ts` PATCH `/:id`: on transition to
  `completed`, classifies tier (within_24h / within_72h /
  within_sla / breach_sla) and emits the matching landlord-side
  event
- `routes/inspections.ts` `/finalize`: emits move-in /
  move-out inspection events + photos-submitted + comparison
  match/damage event

### Routes

- `routes/credit.ts` mounted at `/api/credit`:
  - `GET /subject/own`
  - `GET /subject/:subjectId` (visibility-filtered)
  - `GET /stats/:subjectId` (visibility-gated)
  - `GET /score/:subjectId` (lending-services only)
  - `POST /score/:subjectId/recompute` (admin/lending)
  - `POST /dispute`, `POST /dispute/:id/evidence`,
    `POST /dispute/:id/resolve` (admin-only)
  - `POST /hardship-context` (tenant only on own subject)
  - `GET /integrity/anchors`, `GET /integrity/verify/:subjectId`
- `routes/inspections.ts` mounted at `/api/inspections`:
  - `POST /` create
  - `GET /:id` detail (with items + photos + signatures)
  - `GET /` filtered list
  - `POST /:id/items` add/update item
  - `POST /:id/photos` multipart upload
  - `GET /photo-files/:filename` static serve
  - `POST /:id/sign` tenant or landlord sign-off
  - `POST /:id/finalize` landlord-only; emits ledger events

### Middleware

- `middleware/requireLendingService.ts` — admin/super_admin OR
  `X-Gam-Lending-Token` header (constant-time compared against
  `CREDIT_LENDING_SERVICE_TOKEN` env)

### Crons (in `jobs/scheduler.ts`)

- `0 4 * * 0` Phoenix — weekly Merkle anchor (Sundays 4am)
- `0 3 * * *` Phoenix — nightly score recompute + stats refresh
  (3am daily)

Both use lazy-import + try/catch failure isolation matching the
existing scheduler pattern.

## Validation

- `npm run db:migrate` → 10 migrations applied across both
  groups, schema.sql regenerated
- `npx tsc --noEmit -p apps/api/tsconfig.json` → exit 0
- `npm run build` in `packages/shared` → clean
- Three live smoke runs against dev DB:
  1. **Foundation smoke** — appended a 3-event chain, prev_hash
     linkage verified, `verifyChain` ok=true, `computeMerkleRoot`
     produced the right root, anchor cron wrote the row,
     **tamper test** (mutating event_data on event 2) caused
     `verifyChain` to return ok=false with the right
     `firstBadEventId` and reason
  2. **Score / stats / dispute smoke** — built a year-1 chain
     (12 on-time + lease_signed + anniversary), verified
     **composite=1950**; added an NSF and verified
     **composite=1560** (1950 × 0.80); disputed the NSF →
     resolved corrected → verified **composite=2050** (NSF
     superseded, replacement on-time event added, 13 × 100 +
     250 + 500); nightly cron processed the subject
     idempotently with 0 errors
  3. **Inspection smoke** — created move-in inspection with 3
     items + 2 photos, finalized → verified
     `move_in_inspection_completed`, `move_in_photos_submitted`
     (tenant) + `unit_ready_on_move_in_date` (landlord) emitted;
     created move-out inspection with kitchen walls degraded
     good→damaged, ran the comparison helper → 1 mismatch
     detected; finalized → verified
     `move_out_inspection_completed` +
     `move_out_condition_damage_documented` emitted

All smoke artifacts cleaned up; dev DB returned to 0 events / 0
subjects / 0 inspections.

## Decisions made (forward-looking, not yet built)

These were aligned in chat and shape v1.5+ / v2.0+ build orders:

- **Bill-pay product = v2.0**, Fiserv CheckFreePay as primary
  aggregator (broadest biller coverage, MTL coverage handled).
  GAM-rail-paid bills attest at `gam_bill_pay_attested` (full trust).
- **ODFI partnership = v1.5**. ACH spread improves from $3 to
  ~$5.70 net per txn; ACH float income comes online.
- **Bank charter purchase = v2.5**. ILC charter (Square's path) most
  likely; $50–80M raise to fund. NIM on tenant deposits + escrow
  becomes the next big revenue line.
- **Pricing model:** GAM enterprise valuation at 25K units
  fully built ≈ $300–400M base case using
  growth-phase vertical-fintech multiples (25–35× ARR). Predecessor's
  30–40× multiple is correct for the moat narrative; was
  underweighted earlier in this chat by anchoring on mature
  PropTech comps. ARR at 25K with all features + ODFI + charter ≈
  $10.2M, dominated by SaaS + payment spread + Flex products +
  bill-pay + bank NIM + tenant opt-ins (renters insurance
  commissions, late-fee processing, NSF cuts, debit interchange,
  partner referrals). Pre-revenue revenue lines are sized in chat
  for cap-table conversations.

## Files touched / created

```
apps/api/src/db/migrations/20260505120000_credit_subjects.sql           (new)
apps/api/src/db/migrations/20260505130000_credit_events.sql             (new)
apps/api/src/db/migrations/20260505140000_credit_disputes.sql           (new)
apps/api/src/db/migrations/20260505150000_credit_hardship_contexts.sql  (new)
apps/api/src/db/migrations/20260505160000_credit_score_formulas_seed.sql(new)
apps/api/src/db/migrations/20260505170000_credit_scores.sql             (new)
apps/api/src/db/migrations/20260505180000_credit_stats.sql              (new)
apps/api/src/db/migrations/20260505190000_credit_merkle_anchors.sql     (new)
apps/api/src/db/migrations/20260505200000_external_account_links.sql    (new)
apps/api/src/db/migrations/20260505210000_inspection_workflow.sql       (new)
apps/api/src/db/schema.sql                                              (regenerated)

packages/shared/src/index.ts                                            (CREDIT LEDGER section appended)

apps/api/src/services/creditLedger.ts                                   (new)
apps/api/src/services/creditLedgerEmitters.ts                           (new)
apps/api/src/services/creditScore.ts                                    (new)
apps/api/src/services/creditStats.ts                                    (new)
apps/api/src/services/creditDispute.ts                                  (new)

apps/api/src/middleware/requireLendingService.ts                        (new)

apps/api/src/routes/credit.ts                                           (new)
apps/api/src/routes/inspections.ts                                      (new)
apps/api/src/routes/webhooks.ts                                         (payment hook)
apps/api/src/routes/esign.ts                                            (lease_signed hook)
apps/api/src/routes/maintenance.ts                                      (resolved-tier hook)

apps/api/src/jobs/creditMerkleAnchor.ts                                 (new)
apps/api/src/jobs/creditNightly.ts                                      (new)
apps/api/src/jobs/scheduler.ts                                          (2 crons added)

apps/api/src/index.ts                                                   (router mounts)

CREDIT_LEDGER_V1.md                                                     (design doc — preserved as-is, score model reconciled here)
```

## What this session did NOT do

- **No frontend pass.** Tenant credit dashboard, landlord-screening
  view, dispute UI, hardship UI, inspection UI all batched per the
  standing UI/UX rule. Backend is fully ready for any of them.
- **No automatic recurring_repair_same_issue / habitability
  detection.** These event types are seeded with scoring values
  but their detection is a maintenance-history walker that can
  land in a follow-up session.
- **No entry-request workflow.** Unlike inspections (which we
  built), entry-requests don't have a single existing entry point
  to attach to. Designing that flow is its own scoped session.
- **No eviction workflow.** Eviction events stay landlord-self-
  attested via a future manual UI button; the scoring values are
  seeded.
- **No multi-landlord-history-clean detector.** Cross-landlord
  network bonus event (+500) is seeded but no automatic emission;
  triggers when v2-era network signals come online.
- **No inspection scheduling / reminders.** Inspections can be
  created with `scheduled_for` set but there's no cron that nudges
  when the date arrives.
- **No bulk-import of historical events.** Pre-launch, nothing to
  import. Post-launch first wave will all be live workflow
  emissions.

## Pre-launch backend status

Closed list updates:
- ✅ Credit ledger v1 (foundation, score, stats, disputes, API,
  cron, inspection workflow)
- ✅ Inspection workflow (move-in, move-out, periodic, photo
  upload, dual sign-off, finalize → ledger emit)

Still open (unchanged from S133):
- lease_fees due_timing wire-up (needs product call from Nic)
- OTP enablement (gated on FlexPay tier UX)
- Admin notifications portal UI (waits on frontend pass)
- Frontend pass for everything backend-ready
- Stripe sandbox testing (waiting on test API key)

New open from this session:
- Frontend: tenant credit dashboard (own record + score-event
  count + stats panel)
- Frontend: landlord screening view (visible events for prospective
  tenant; NOT score)
- Frontend: dispute UI (open + submit evidence + view status)
- Frontend: hardship-context UI
- Frontend: inspection UI (landlord create → checklist + photos →
  tenant sign → landlord sign → finalize)
- Backend follow-up: entry-request workflow build (its own session)
- Backend follow-up: recurring_repair_same_issue + habitability
  auto-detection (maintenance-history walker)
- Backend follow-up: bill-pay product (v2.0) when MSB / aggregator
  contracts land
- Backend follow-up: Plaid Liabilities integration (v1.5) when
  Stripe Financial Connections + lender API access is ready

## What next session should target

The frontend pass is the natural next target — credit-ledger and
inspection both need a UI to be useful to humans. Two paths:

1. **Credit-ledger UI session** — tenant dashboard + landlord
   screening view + dispute lifecycle UI + hardship form. Probably
   2 sessions: tenant-side first (lower risk, simpler scope), then
   landlord-side.
2. **Inspection UI session** — landlord-side checklist build (areas
   + items + photo upload), then tenant sign-off flow on tenant
   portal, then landlord finalize.

Recommended order: **inspection UI first** (smaller scope, gives
operational value immediately), then credit-ledger UI (needs more
UX thought because the dashboard surfaces a lot of new concepts at
once).

If Nic wants to keep grinding backend instead, the natural follow-ups
are:
- entry-request workflow build (similar shape to inspections;
  reuses photo-upload pattern, same dual-sign-off model)
- recurring-repair / habitability auto-detection cron (reads
  maintenance_requests, emits matching credit events)
- multi-landlord-history-clean detector (reads cross-landlord
  lease history at lease_terminated_natural events)

## Notes for future-Claude

- The v1.0.0 formula seed is locked. Adjusting any scoring value =
  publish v1.1.0, set v1.0.0's `effective_to`, set v1.1.0's
  `effective_from`. Do NOT mutate v1.0.0 in place — old snapshots
  must remain reproducible.
- `recomputeAndSnapshot` always uses `loadCurrentFormula()`, so a
  v1.1.0 publish takes effect on the next nightly cron pass without
  any code change.
- Inspections without `tenant_id` (periodic) emit nothing on
  finalize — that's intentional; the credit ledger only cares about
  tenant-bearing inspections.
- Multi-tenant signers: `lease_signed` emits one event per tenant
  + a single landlord event with `tenant_count` in event_data.
- The dispute service's `resolveDispute(corrected)` recomputes the
  disputing subject's score POST-COMMIT (not in the same
  transaction), so a recompute failure won't roll back the
  resolution. Resolution is durable; score will catch up on the
  next nightly pass.
- The Merkle root in `credit_scores.ledger_merkle_root` is
  computed at snapshot time across ALL events globally, not just
  the subject's events. That ties a score snapshot to a specific
  global ledger state.
- Self-reported events (attestation_weight 0) ARE persisted in the
  ledger — they just don't move the score. The stats panel still
  counts them. This matches the design rule "facts not
  interpretations": the record reflects what happened, scoring is
  a separate filter on top.

# Session 335 — closed

## Theme

S334 closed the original_lease completion handler test gap.
S335 continues the same thread: addendum completion variants —
`executeAddendumAdd`, `executeAddendumRemove`, `executeAddendumTerms`.
Three new describe blocks on `esign.test.ts`. 18 new cases. One
cleanup-ordering bug in `cleanupAllSchema` surfaced + fixed
(addendum_remove FK cascade hit a CHECK constraint).

Suite at S334 close: **636 / 32 files**.
Suite at S335 close: **654 / 32 files**.

Zero production regressions; tsc + suite clean across all 10
portals.

## Items shipped

### Addendum completion test coverage (18 new cases)

**Block 1 — addendum_add (7 cases)**
- Happy path: `pending_add` lease_tenants row flips to `active`;
  parent lease untouched; doc.lease_id stays pointed at parent;
  lease_tenants count grows from 1 (primary) to 2 (primary +
  co_tenant); doc.status flips `completed`.
- No pending_add row for this doc → execution_failed
  ("No pending_add row found — creation logic failed").
- Multiple pending_add rows tied to the doc → execution_failed
  ("Multiple pending_add rows — data corruption").
- Parent lease status='expired' → execution_failed
  ("parent lease is expired, not active").
- New tenant has an overlapping active lease on a sibling unit
  → execution_failed (overlap re-check at executor inner gate;
  outer route's overlap check uses doc.start_date which is
  null on addendum_add docs, so the inner gate is what trips).
- pending_add row's `tenant_id` doesn't match any tenant signer
  → execution_failed ("does not match any signer").
- Tenant signer without tenants row → execution_failed
  ("has no tenant profile"). Setup uses a ghost co_tenant_1
  signer pre-signed, so the inner `tenant_id` gate at
  esign.ts:753 trips during the all-tenants iteration even
  though the current POST /sign signer has a valid tenants row.
- Parent lease deleted between send + sign → execution_failed
  ("Addendum has no parent lease_id"). lease_documents.lease_id
  FK is ON DELETE SET NULL; lease_tenants.lease_id is ON
  DELETE CASCADE, so deleting the lease nulls doc.lease_id and
  cascades the pending_add row. Executor's first gate at
  line 714 trips before the missing-pending-row gate.

**Block 2 — addendum_remove (7 cases)**
- Happy path co_tenant removal: target lease_tenants row flips
  `pending_remove` → `removed`, `removed_reason='moved_out'`;
  primary stays active + still primary.
- Happy path primary removal with promote: target (primary)
  flips to removed; promoted co_tenant flips to `role='primary'`,
  `status='active'`. Two-step UPDATE in the executor uses the
  `lease_tenants_primary_active` partial unique index (removed
  flip clears the slot before the promote).
- Remove primary without `promote_lease_tenant_id` →
  execution_failed ("Cannot remove primary tenant without
  promote_lease_tenant_id").
- `promote_lease_tenant_id` set but target is co_tenant (not
  primary) → execution_failed ("promote_lease_tenant_id set
  but target is not primary").
- Promote target belongs to a different lease → execution_failed
  ("does not belong to this lease").
- Promote target status is 'removed' (not active) →
  execution_failed ("Promote target status is removed").
- Target status is 'active' (not pending_remove) →
  execution_failed ("Target tenant is active, not
  pending_remove — addendum out of sync").

**Block 3 — addendum_terms (3 cases)**
- Happy path: doc flips `completed`; lease untouched (status,
  rent_amount, start_date, all lease_tenants identical before
  vs after via direct row equality).
- Parent lease 'expired' → execution_failed ("Cannot amend
  terms: lease is expired").
- Parent lease 'terminated' → execution_failed ("Cannot amend
  terms: lease is terminated").

### dbHelpers.cleanupAllSchema FK-ordering fix

Adding addendum_remove test data surfaced a latent cleanup bug.
The FK chain:
- `lease_documents.target_lease_tenant_id` → `lease_tenants`
  with ON DELETE SET NULL
- CHECK on `lease_documents`: addendum_remove rows must have
  `target_lease_tenant_id IS NOT NULL`

Direct `DELETE FROM lease_tenants` triggered the SET NULL on
addendum_remove rows, which violated the CHECK and aborted the
cleanup. Fixed by breaking the FK direction first:

```ts
await db.query(`UPDATE lease_tenants SET add_document_id = NULL, remove_document_id = NULL`)
await db.query(`DELETE FROM lease_documents WHERE document_type = 'addendum_remove'`)
await db.query(`DELETE FROM lease_tenants`)
```

Step 1 clears lease_tenants → lease_documents references (FKs
have no cascade rule). Step 2 deletes the offending CHECK-bound
docs outright. Step 3 (existing) now cascades cleanly because
no addendum_remove rows survive.

addendum_add / addendum_terms rows are unaffected — their
CHECK clauses permit NULL on target/promote so the SET NULL
cascade lands fine.

### Test infra additions (esign.test.ts)

Three new helpers + one interface:
- `seedParentLease(f, opts)` — seeds an active lease with the
  fixture's tenant as primary lease_tenants row. Optional
  `status` override for the expired/terminated cases.
- `seedNewTenant()` — provisions a fresh user + tenants row +
  jwt token. Returns a `NewTenantSeed` shape.
- `seedAddendumAddDoc(f, parentLeaseId, newTenant, opts)` —
  wires the addendum_add doc + landlord + new-tenant signer
  + pending_add lease_tenants row. Override knobs:
  `pendingTenantId` (mismatch test), `skipPendingRow`,
  `extraPendingRow` (corruption test), `pendingStatus`,
  `pendingAddDocumentId`.
- `seedAddendumRemoveDoc(f, parentLeaseId, departingTenant,
  targetLeaseTenantId, opts)` — wires the addendum_remove
  doc + signers, flips target row to pending_remove and
  stamps remove_document_id. Override knobs:
  `promoteLeaseTenantId`, `targetStatus`.
- `seedAddendumTermsDoc(f, parentLeaseId)` — wires
  addendum_terms doc + landlord (pre-signed) + primary
  tenant (viewed). No lease_tenants mutation since the
  executor has none.

Also imported `seedLease` + `seedLeaseTenant` from the
existing dbHelpers (S333 helpers, used as primitives for
seedParentLease).

## Files touched

```
apps/api/src/routes/
  esign.test.ts          (+687 lines: 3 describe blocks, 18 new cases,
                          5 new helpers, 1 interface; final 2,091 lines)

apps/api/src/test/
  dbHelpers.ts           (+11 lines: cleanup-ordering fix for
                          addendum_remove CHECK constraint)
```

No migrations. No schema changes. No production-source changes
this session — the test thread surfaced no executor bugs in
the addendum paths. (Original_lease's vals filter bug fixed in
S334 doesn't share with these executors; confirmed via grep
in S334 close.)

## Decisions made during build

| Question | Decision |
|---|---|
| Parent-lease-not-found test path — how to construct a missing parent? | **Delete the parent lease post-send.** lease_documents.lease_id is FK with ON DELETE SET NULL, lease_tenants.lease_id is ON DELETE CASCADE. Deleting the parent nulls doc.lease_id and cascades the pending_add row away. Executor's first gate (`if (!doc.lease_id)`) trips. Test ends up exercising a different gate than originally planned, but the gate it does exercise is the more important one (lease_id absence is the realistic post-deletion state). |
| Tenant-signer-no-profile test for addendum_add — use the new tenant or a separate signer? | **Separate ghost signer.** Wiping the new tenant's tenants row fails because the pending_add row FKs to tenants with NO ACTION. Adding a ghost co_tenant_1 signer pre-signed lets the inner gate at esign.ts:753 trip on the iteration without disturbing the pending_add row chain. |
| dbHelpers cleanup fix — restructure FK chain or add new steps? | **Add new steps.** Two-line addition before the existing lease_tenants delete: clear the lease_tenants → lease_documents link columns, then delete addendum_remove docs outright. Surgical fix, doesn't change the broader cleanup ordering. Comment explains the FK + CHECK interaction. |
| addendum_add scope — also test platform-block path? | **Skip.** Outer POST /sign route catches platform block on the current signer at esign.ts:2057 BEFORE reaching the executor (already covered by S334's "platform-blocked tenant" test for original_lease). The inner gate at esign.ts:758 is a safety belt that fires only on already-signed tenant signers — much harder to set up cleanly + redundant with outer coverage. |
| addendum_terms — verify no fee/utility writes? | **Already implicit.** Happy-path test compares `lease_tenants` rows pre vs post and asserts equality. No lease_fees / lease_utility_responsibilities writes are possible because the executor (esign.ts:902-925) has zero INSERTs — it's a pure read. Explicit assertion would be redundant. |
| Helper signatures — accept a NewTenantSeed or raw fields? | **NewTenantSeed.** Bundles userId + tenantId + email + authToken; all the helpers need every field. Avoids 4-arg signatures throughout. |

## Verification

- `npx tsc --noEmit` clean on apps/api AND every frontend portal:
  landlord, tenant, pm-company, admin, admin-ops, books, listings,
  pos, property-intel. Every count is 0.
- `npm test` in apps/api: **654 tests across 32 files, 0 failures**,
  ~252s.
- 0 production-source bugs found (S334 already cleaned out the
  load-bearing one; addendum executors are tighter).
- 0 production regressions.

## Items deferred — what S336 could target

### Test-coverage continuation (diminishing returns continue)

- **Sublease completion** — `sublease_agreement` document_type
  routes through `executeSubleaseAgreementCompletion`. Different
  shape: no lease build; flips `subleases.status='active'` and
  stamps the document URL on the sublease row. ~3-5 tests.
  This is the last remaining document_type variant.
- **POS route handlers** — wire format pinned by syncQueue tests
  but business logic (sessions / transactions / EOD close) untested.
- **Notifications fan-out service** — large but mostly Resend wrappers.
- **adminNotifications service** — error escalation surface used
  everywhere.
- **invoiceGeneration job** — partial coverage in leaseLifecycle.

### Architectural / non-test

- **Unicode-capable font in flexsuitePdf** — deletes the 14
  sanitizer tests for a cleaner renderer. ~300KB bundle add.
  Tradeoff swap.
- **responsibleParty source-comment drift fix** — one-line
  comment correction (deferred since S333).

### Vendor-blocked (no progress possible)

- Stripe live keys, Resend domain auth, Plaid production keys,
  Stripe Terminal hardware, Checkr Partner credentials.

### Walkthrough-blocked (per Nic direction)

- 2FA fan-out (admin-ops / landlord / pm-company / tenant)
- Visual review of reconstructed PmInvitationsPage
- SchedulePage booking-vs-lease shape audit

### Dev-team scope

- Deploy host pick + Dockerfile / render.yaml
- Production cron runner
- DB backups + PITR

## Items deferred (cross-session docket, post-S335)

- Consumer-side retention framing decision (S300) — Nic-pending
- Campground Master import path — Nic-blocked on sample
- 2FA fan-out — walkthrough-blocked
- Yardi GL-export columns, Rentec template (S293) — vendor-blocked on real exports
- FlexCharge Business Account Agreement signature capture (S309 option B) — not a launch feature
- FlexDeposit eligibility-check workflow (S309 option C)
- Standalone POS-operator auth (S309 option D)
- Deposit-return ↔ unpaid-installment offset architecture call — Nic-pending
- SchedulePage booking-vs-lease shape audit — walkthrough-blocked
- Embed Unicode-capable font in flexsuitePdf — open architectural pick
- Credit-score formula + recompute test coverage — locked v1.0.0; defensive only
- Visual review of reconstructed PmInvitationsPage — walkthrough-blocked
- Sublease completion-handler test coverage (last remaining doc_type)

## Nic-pending (unchanged)

- Stripe live keys + production webhook URL registered
- Resend domain verification
- Plaid production keys
- Stripe Terminal hardware
- Checkr Partner credentials
- Consumer-side retention framing decision (S300)
- FlexCredit Lender partner selection
- SLA § 9.1.4(iii) deposit-return offset framing call

## What S336 should target

Honest read: same as S333/S334/S335 close — launch-blockers
are vendor / walkthrough / dev-team. Two completion-handler
sessions back-to-back have exhausted the high-leverage test
gaps; remaining test work is genuinely diminishing-ROI.

If S336 continues testing, **sublease completion** is the last
remaining doc_type variant (~3-5 tests, smallest surface).
After that, the e-sign test thread is closed.

If S336 steps off tests entirely, **Unicode font in
flexsuitePdf** is the bounded architectural pick.

Otherwise: closing the test thread + waiting for vendor unblock
/ walkthrough is a reasonable posture. Both load-bearing
completion paths (original_lease in S334, addendum variants
in S335) are now covered.

---

End of S335 handoff. Closed clean. 654 tests / 32 files / 0 failures.

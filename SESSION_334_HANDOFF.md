# Session 334 — closed

## Theme

S333 closed the e-sign test thread with a scoped first pass that
explicitly deferred the completion handler (every lease binding
flows through it; identified as the biggest remaining test gap).

S334 closes that gap. Three new describe blocks on `esign.test.ts`
covering `POST /sign/:documentId` → `buildLeaseFromDocument` →
`executeOriginalLease` end-to-end. 18 new cases. One latent
production bug surfaced + fixed under fix-it-right (vals filter
silently zeroed out lease_fees + lease_utility_responsibilities
at every original_lease completion).

Suite at S333 close: **618 / 32 files**.
Suite at S334 close: **636 / 32 files**.

Zero production regressions; tsc + suite clean across all 10
portals.

## Items shipped

### Completion handler test coverage (18 new cases)

**Block 1 — happy path (5 cases)**
- All-signed → lease materialized with correct writable column
  values (rent_amount, rent_due_day, lease_type, auto_renew,
  start_date, end_date), lease_tenants for primary signer,
  doc.status flips `completed` + doc.lease_id linked, move-in
  invoice called with full payload, credit events emitted for
  both tenant + landlord subjects, unit.status flipped to
  'active' for past start_date.
- Future start_date → lease.status='pending', unit not flipped.
- lease_fees seeded from FEE_ROW_SPECS (security_deposit +
  pet_deposit + cleaning_fee — verified amount + is_refundable +
  due_timing match FEE_TYPE_META).
- lease_utility_responsibilities seeded from UTILITY_ROW_SPECS
  (water='yes'→true, electric='true'→true, gas='false'→false).
- Co-tenant + primary → two lease_tenants rows with roles
  `co_tenant` + `primary`. (Signer role on
  lease_document_signers must match TENANT_ROLE_PATTERN
  `/^(primary|co_tenant_\d+)$/`; lease_tenants.role gets
  normalized to `co_tenant`.)

**Block 2 — failure paths (7 cases)**
- Missing start_date → executionFailed:true + doc.status=
  execution_failed + critical admin notif (`esign_lease_build_
  failed`) + ROLLBACK verified (no lease, no lease_tenants).
- Missing rent_amount → same execution_failed + ROLLBACK.
- Invalid rent_amount (`'0'`) → execution_failed with "Invalid
  rent_amount" reason.
- Overlapping active lease on another unit (re-checked at
  POST /sign before completion per esign.ts:2074-2090) → 409 +
  signature does NOT persist + no lease materialized.
- Primary signer has no `tenants` row → execution_failed
  (executeOriginalLease's tenant-profile gate at line 464).
- Platform-blocked tenant → 403 pre-sign (esign.ts:2057
  short-circuits BEFORE signature persists; signer status stays
  `viewed`).
- `generateMoveInInvoice` throws → execution_failed + ROLLBACK
  (no lease, no lease_tenants) + admin notif fired.

**Block 3 — post-commit side effects (6 cases)**
- PM company on property (leasing_fee_amount=750) →
  `user_balance_ledger` row written with
  type='allocation_pm_company_fee', amount=750,
  reference_type='lease', keyed to the PM payout user.
  `firePmTransfersForReference` called once post-commit with
  ('lease', leaseId).
- Self-managed property → no leasing-fee ledger row;
  firePmTransfers still fires once (no-op against empty).
- firePmTransfers throws → doc still completes
  (post-commit isolation), admin warn notif fires with
  `pm_transfer_post_commit_failed` category.
- Missing base_pdf_url → stampPdf path skipped entirely
  (gated by `if (doc.base_pdf_url)` at esign.ts:2211),
  executed_pdf_url stays null.
- base_pdf_url present but file missing on disk →
  `fs.existsSync` gate also short-circuits, stampPdf not
  called, doc completes cleanly.
- `emailSigningCompleted` + `createNotification` fire once
  per signer at completion (2 calls each for the
  landlord + primary fixture).

### Fix-it-right: vals filter silently dropped fee_row + utility_row

`executeOriginalLease` (esign.ts:438-450) loaded
`lease_document_fields` into a `vals` dict consumed by THREE
downstream pipelines: `WRITABLE_LEASE_COLUMN_SPECS` (writes
leases columns), `FEE_ROW_SPECS` (writes lease_fees rows),
`UTILITY_ROW_SPECS` (writes lease_utility_responsibilities
rows).

Filter logic:
```ts
if (LEASE_COLUMN_CATEGORY[col] !== 'writable') continue
```

The comment two lines above stated the correct intent: drop
identity + signature, keep writable + fee_row + utility_row.
But the implementation kept ONLY writable. Result:
`FEE_ROW_SPECS.parse(vals)` saw vals[tag]=undefined for every
fee_row tag → always returned null → no lease_fees rows ever
written. Same for utility responsibilities.

No production exposure — pre-launch (per
`feedback_dev_seed_data` memory). Discovered via the new
"seeds lease_fees rows" test failing at zero rows. Per
`feedback_underwired_infra` memory (wire the consumer, never
drop the infra), fixed the filter to match the comment:

```ts
const cat = LEASE_COLUMN_CATEGORY[col]
if (cat === 'identity' || cat === 'signature') continue
```

WRITABLE_LEASE_COLUMN_SPECS / FEE_ROW_SPECS / UTILITY_ROW_SPECS
each only read their own per-tag key from vals, so sharing
the dict across all three is safe (no cross-contamination of
the leases INSERT path).

Addendum-add / addendum-remove / addendum-terms /
sublease_agreement paths checked — none share this filter
(single-site grep), no further fixes needed.

### Test infra additions (esign.test.ts)

Three new mocks layered on the existing 5 (email + notifs +
admin notifs):
- `../jobs/moveInBundle.generateMoveInInvoice` — same-txn
  invoice generation
- `../services/stripeConnect.firePmTransfersForReference` —
  post-commit Stripe transfer (dynamic import in esign.ts;
  module mock catches it)
- `../services/pdfStamp.stampPdf` — post-commit PDF stamping

Two new local helpers:
- `seedDocFields(documentId, fields)` — INSERTs
  lease_document_fields rows keyed by lease_column with
  signer_role='landlord' + required=FALSE so the tenant's
  role-scoped required-field validation passes trivially.
- `seedCompleteableDoc(f, opts)` — full fixture wiring:
  doc row + landlord signer pre-signed + primary tenant in
  `viewed` state + default lease fields. Next POST /sign from
  the tenant triggers completion.

`defaultLeaseFields(overrides)` provides a canonical override
base (past start_date so activation branch fires).

`seedPmCompanyWithLeasingFee(f, amount)` (scoped to the
post-commit block) seeds PM owner user + bank account + PM
company + fee_plan with leasing_fee_amount, attached to the
property; returns the PM payout user id so tests can read
the ledger.

## Files touched

```
apps/api/src/routes/
  esign.ts               (fix-it-right: vals filter — 5-line change)
  esign.test.ts          (+620 lines: 3 describe blocks, 18 new cases,
                          3 new mocks, 3 new helpers; final 1,404 lines)
```

No migrations. No schema changes. Filter fix is the only
non-test source change.

## Decisions made during build

| Question | Decision |
|---|---|
| Refactor esign.ts to export `buildLeaseFromDocument` or drive it through POST /sign? | **Drive through POST /sign.** Every load-bearing module dependency is already importable + mockable; no source refactor needed. Test exercises the full route path (auth → sign → completion → post-commit) end-to-end. |
| Field signer_role for value-bearing cols — landlord or primary? | **`landlord`.** Mirrors how landlord-prefill works at send time (landlord fills the writable + fee + utility values before tenants are invited). Bonus: required-field validation only runs for the current signer's role, so primary-role validation passes trivially when no primary-role required fields exist. |
| `required` on seeded fields — TRUE or FALSE? | **FALSE.** Required-field validation is exercised by the existing S333 'rejects missing required fields' case. Completion tests are scoped to the build path, not the validation gate. |
| Mock generateMoveInInvoice or run it real? | **Mock.** The real path materializes an invoice row + handles fee resolution; would add ~50 lines of fixture for every completion test. Module mock returns a default `MoveInBundleResult` shape; one test (`throws → execution_failed`) overrides with `mockRejectedValueOnce` to exercise the rollback path. |
| Run credit-ledger emitters real or mock? | **Real.** Same posture as leaseTermination.test.ts (S333). Verifies actual integration produces lease_signed events on both tenant + landlord subjects. The integration is the test surface — mocking would void it. |
| Co-tenant test failed with role='co_tenant' — fix or skip? | **Fix.** TENANT_ROLE_PATTERN at esign.ts:43 requires `co_tenant_\d+`; lease_tenants.role gets normalized to `co_tenant` downstream. Inline comment in the test documents the indirection. |
| vals filter bug — defer to S335 or fix-it-right? | **Fix-it-right.** Per CLAUDE.md commandment + `feedback_underwired_infra` memory. Single-site fix; comment already stated correct intent; no production exposure pre-launch; 5-line change. |

## Verification

- `npx tsc --noEmit` clean on apps/api AND every frontend portal:
  landlord, tenant, pm-company, admin, admin-ops, books, listings,
  pos, property-intel. Every count is 0.
- `npm test` in apps/api: **636 tests across 32 files, 0 failures**,
  ~245s.
- 1 latent bug found + fixed (vals filter in executeOriginalLease).
- 0 production regressions.

## Items deferred — what S335 could target

### Test-coverage continuation (clearly diminishing ROI)

- **Addendum completion variants** — executeAddendumAdd /
  executeAddendumRemove / executeAddendumTerms. Each has its own
  shape (no lease INSERT; flips existing lease_tenants rows or
  writes addendum metadata). ~15-20 cases across all three.
- **Sublease completion** — sublease_agreement document_type
  routes through `executeSubleaseAgreementCompletion`. Different
  shape: no lease build; flips subleases.status='active'. ~3-5
  cases.
- **POS route handlers** — wire format pinned by syncQueue tests
  but business logic (sessions / transactions / EOD close) untested.
- **Notifications fan-out service** — large but mostly Resend
  wrappers.
- **adminNotifications service** — error escalation surface used
  everywhere.
- **invoiceGeneration job** — partial coverage in leaseLifecycle.

### Architectural / non-test

- **Unicode-capable font in flexsuitePdf** — deletes the 14
  sanitizer tests for a cleaner renderer. ~300KB bundle add.
  Tradeoff swap.
- **responsibleParty source-comment drift fix** — one-line
  comment correction (S333 deferred).

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

## Items deferred (cross-session docket, post-S334)

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
- Addendum + sublease completion-handler test coverage — S334 scoped to original_lease

## Nic-pending (unchanged)

- Stripe live keys + production webhook URL registered
- Resend domain verification
- Plaid production keys
- Stripe Terminal hardware
- Checkr Partner credentials
- Consumer-side retention framing decision (S300)
- FlexCredit Lender partner selection
- SLA § 9.1.4(iii) deposit-return offset framing call

## What S335 should target

Honest read: same as S333/S334 close — launch-blockers are
vendor / walkthrough / dev-team. Remaining test work has
clearly diminishing ROI now that the load-bearing completion
path is covered.

If S335 continues testing, **addendum completion variants** is
the natural follow-on (same fixture infrastructure, three
shorter paths). If S335 steps off tests, **Unicode font in
flexsuitePdf** is the bounded architectural pick (still
deferred from S333).

Otherwise: closing the test thread cleanly + waiting for
vendor unblock / walkthrough is a reasonable posture. The
hard-launch test gap (completion handler) is no longer open.

---

End of S334 handoff. Closed clean. 636 tests / 32 files / 0 failures.

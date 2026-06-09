# Session 336 — closed

## Theme

S334 closed original_lease completion. S335 closed addendum_add /
addendum_remove / addendum_terms completion. S336 closes the
last remaining document_type variant: sublease_agreement.

E-sign completion-handler thread now fully closed. All five
document_type executors have test coverage: original_lease,
addendum_add, addendum_remove, addendum_terms, sublease_agreement.

Suite at S335 close: **654 / 32 files**.
Suite at S336 close: **658 / 32 files**.

Zero production regressions; tsc + suite clean across all 10
portals. One latent atomicity gap flagged but deferred (not in
S336 scope).

## Items shipped

### Sublease completion test coverage (4 new cases)

`executeSubleaseAgreementCompletion` (`services/subleaseDocuments.ts:344`)
is the shortest of the five executors — 26 lines, two DB reads, one
UPDATE. Different shape from the others: no lease build, no roster
mutation. It flips `subleases.status` to 'active' and stamps the
document URL on the sublease row.

**Cases:**
- Happy path: sublease flips `awaiting_signatures` → `active`,
  `sublease_document_url` stamped from `base_pdf_url` (since
  `executed_pdf_url` is null at this point in the chain),
  `landlord_consent_date` set to CURRENT_DATE, doc.status flips
  `completed`.
- `executed_pdf_url` present → preferred over `base_pdf_url` for
  the URL stamp (verifies the `doc.executed_pdf_url || doc.base_pdf_url`
  fallback at line 366).
- Existing `landlord_consent_date` → preserved by COALESCE (the
  date doesn't get overwritten on re-signing or any subsequent
  state flip).
- No sublease row references the document → execution_failed
  ("Sublease for document ... not found"). Doc flips to
  `execution_failed`, critical admin notif fires via the outer
  buildLeaseFromDocument catch block.

### Latent atomicity gap (flagged, not in scope)

`executeSubleaseAgreementCompletion` uses non-transactional
`query()` and `queryOne()`, NOT the open `client` from
`buildLeaseFromDocument`. The function signature takes
`{ documentId: string }` only — no client parameter, no way
to participate in the caller's transaction.

This means the sublease status flip + URL stamp + consent date
write are committed atomically among themselves (one UPDATE),
but they happen OUTSIDE the BEGIN/COMMIT block of
buildLeaseFromDocument. If the outer transaction were to ROLLBACK
later in the chain, the sublease flip would survive while the
doc.status update would not.

In practice the outer chain commits immediately after the case
switch returns (esign.ts:355: `await client.query('COMMIT')`),
so the gap is narrow. But it IS a gap — different posture from
the other four executors which all take a client parameter and
run inside the caller's txn.

Possible fix: refactor `executeSubleaseAgreementCompletion`
to take an optional `externalClient: PoolClient` parameter, same
shape as `generateMoveInInvoice` in `jobs/moveInBundle.ts:86`
(uses an ownership flag to skip BEGIN/COMMIT when caller owns
tx). Caller in esign.ts:338 passes the client.

Surfaced for awareness; not in S336 scope. The test coverage
landed here documents the current behavior (the happy-path
test verifies the sublease flip lands, which it does even with
the gap).

### Test infra additions (esign.test.ts)

One new helper:
- `seedSubleaseDoc(f, opts)` — creates the sublease_agreement
  document + landlord signer (pre-signed) + sublessee signer
  (viewed; will POST sign), and seeds the `subleases` row with
  `sublease_document_id` linking back to the doc. Override knobs:
  `skipSublease` (for the not-found test), `basePdfUrl`,
  `executedPdfUrl`, `initialStatus`, `existingConsentDate`,
  `monthlyAmount`, `masterShareAmount`.

The S335 helpers (`seedParentLease`, `seedNewTenant`,
`NewTenantSeed`) carry over and slot in directly. The sublease
fixture reuses `f.tenantId` as the sublessor (since they're the
existing primary on the master lease) and provisions a fresh new
tenant as the sublessee.

## Files touched

```
apps/api/src/routes/
  esign.test.ts          (+183 lines: 1 describe block, 4 new cases,
                          1 new helper; final 2,274 lines)
```

No migrations. No schema changes. No production-source changes
this session. dbHelpers unchanged from S335.

## Decisions made during build

| Question | Decision |
|---|---|
| Refactor `executeSubleaseAgreementCompletion` to take a client param (fix the atomicity gap)? | **Defer.** Not in S336 scope. The gap is real but narrow (outer txn commits immediately after the case switch). Flagged in the handoff for future cleanup. The 4 tests written here verify current behavior, not the post-refactor behavior — so the refactor would land independently without invalidating these tests. |
| Sublessee setup — reuse fixture tenant or seed fresh? | **Seed fresh.** `subleases_distinct_parties` CHECK requires sublessee_tenant_id ≠ sublessor_tenant_id, so the fixture tenant (used as sublessor) can't double as sublessee. `seedNewTenant` from S335 carries over directly. |
| Test the dispatcher return shape (leaseId=subleaseId, primaryTenantId=sublessor_tenant_id)? | **Skip.** Already covered implicitly by the happy path — if the dispatcher return shape were broken, the doc.status flip downstream of executeSubleaseAgreementCompletion (esign.ts:344-350 → buildLeaseFromDocument's COMMIT at line 355 → post-commit chain) would fail. The happy-path test asserts doc.status='completed', which is downstream of that contract. |
| Required-field validation path — assert any? | **Skip.** Same as addendum_terms (S335) — no value-bearing fields are seeded on the sublease doc, so required-field validation passes trivially via the empty fields path. Already covered by S333 'rejects missing required fields' case. |

## Verification

- `npx tsc --noEmit` clean on apps/api AND every frontend portal:
  landlord, tenant, pm-company, admin, admin-ops, books, listings,
  pos, property-intel. Every count is 0.
- `npm test` in apps/api: **658 tests across 32 files, 0 failures**,
  ~242s.
- 0 production-source changes.
- 0 production regressions.

## Items deferred — what S337 could target

### E-sign atomicity refactor (one bounded follow-up)

- **executeSubleaseAgreementCompletion client-param refactor** —
  Make it accept an optional `externalClient: PoolClient`, mirror
  the `generateMoveInInvoice` ownership pattern in
  `jobs/moveInBundle.ts:86`. Pass the open client from
  buildLeaseFromDocument's case switch at esign.ts:338. ~10-line
  change in services/subleaseDocuments.ts + 1-line update at the
  call site. Existing 4 sublease tests would still pass after.

### Test-coverage continuation (genuinely diminishing returns)

The e-sign completion-handler thread is closed at S336. Remaining
test work that's not duplicative:

- **POS route handlers** — wire format pinned by syncQueue tests
  but business logic (sessions / transactions / EOD close) untested.
  Larger surface; ~30-40 tests for full coverage.
- **Notifications fan-out service** — large but mostly Resend
  wrappers.
- **adminNotifications service** — error escalation surface used
  everywhere.
- **invoiceGeneration job** — partial coverage in leaseLifecycle.

### Architectural / non-test

- **Unicode-capable font in flexsuitePdf** — deletes the 14
  sanitizer tests for a cleaner renderer. ~300KB bundle add.
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

## Items deferred (cross-session docket, post-S336)

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
- executeSubleaseAgreementCompletion client-param refactor (atomicity gap)

## Nic-pending (unchanged)

- Stripe live keys + production webhook URL registered
- Resend domain verification
- Plaid production keys
- Stripe Terminal hardware
- Checkr Partner credentials
- Consumer-side retention framing decision (S300)
- FlexCredit Lender partner selection
- SLA § 9.1.4(iii) deposit-return offset framing call

## What S337 should target

Honest read: the e-sign completion-handler thread is **fully
closed.** All five document_type executors covered. Three
consecutive sessions (S334/S335/S336) of completion-handler
work have reached a natural stopping point.

If S337 continues a bounded follow-up, **executeSubleaseAgreementCompletion
client-param refactor** is the single remaining one-pass fix
in the e-sign domain (atomicity gap flagged in S336).

If S337 picks up a new test surface, **POS route handlers** is
the largest remaining gap (~30-40 tests; business logic not
covered by syncQueue tests).

If S337 steps off tests, **Unicode font in flexsuitePdf** is
the bounded architectural pick.

Otherwise: closing the test thread + waiting for vendor unblock
/ walkthrough is a reasonable posture. The e-sign launch-risk
surface is no longer open.

---

End of S336 handoff. Closed clean. 658 tests / 32 files / 0 failures.
E-sign completion-handler thread closed.

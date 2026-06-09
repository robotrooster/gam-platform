# Session 392 — closed

## Theme

**credit.ts full slice** — 16 routes across the credit-
ledger visibility surface (subject views, score, attest,
disputes, hardship, integrity). **Closes the file at
16/16 (100%).**

The slice surfaced **2 HIGH-severity production bug
fixes** at the service layer — both in the dispute
lifecycle. Cross-subject manipulation vectors via:
opening disputes against strangers' events, and
submitting evidence on strangers' disputes.

36 new test cases pin the slice + both fixes.

Suite at S391 close: **1357 / 78 files**.
Suite at S392 close: **1393 / 79 files** (+36 cases,
+1 file).
Runtime ~575s.

Zero tsc regressions, zero S392-introduced regressions.

## Bugs found + fixed — both HIGH severity

### Bug 1 — openDispute: cross-subject dispute injection

**Symptom:** `services/creditDispute.ts:openDispute` took
`disputedEventId` from the caller and inserted a dispute
row without verifying the event actually belongs to the
disputing subject. The route at `credit.ts:561` passed
`req.body.disputedEventId` straight through.

**Exploit:** Tenant A opens a dispute against Tenant B's
event by passing B's event UUID in the body. The dispute
row inserts with:
- `disputed_event_id` = B's event id
- `disputing_subject_id` = A's subject id

Admin sees the dispute in their queue and resolves it
with `outcome='corrected'`, which calls
`appendEvent + supersede` on the disputed event's chain.
**The "correction" lands on Tenant B's chain** via the
existing supersede mechanism — credit-record manipulation
across the multi-subject boundary.

**Severity: HIGH.** Requires knowing a foreign event
UUID (low practical likelihood) but the impact is
direct write to another subject's credit record.

**Fix:** before inserting the dispute, SELECT the
event's `subject_id` and throw if it doesn't match
`disputingSubjectId`.

### Bug 2 — submitDisputeEvidence: cross-subject evidence injection

**Symptom:** `services/creditDispute.ts:submitDisputeEvidence`
SELECT only checked `id = $1` — no ownership predicate.
Any authenticated tenant or landlord with a dispute UUID
could submit evidence on a stranger's dispute.

**Exploit:** Tenant A submits fabricated evidence on
Tenant B's dispute. The injected event is stamped with
B's subject_id via the route's argument plumbing (the
route at `credit.ts:619` takes the caller's subjectType +
subjectRefId — so the event lands on A's chain — but the
dispute's `disputed_event_id` and admin-review context
references B's row, polluting the admin's resolution
decision-making.

Same severity class as Bug 1 — manipulation of strangers'
credit records via the admin-resolution path.

**Fix:** the SELECT now JOINs `credit_subjects` to
resolve the dispute's owner to a `(subject_type,
subject_ref_id)` pair and rejects if mismatched against
the caller.

### Why the existing creditDispute tests didn't catch these

All 8 existing tests in `services/creditDispute.test.ts`
correctly seed a dispute with matching `disputingSubjectId`
↔ `event.subject_id`. The bugs only surface when the
caller is a STRANGER, which the existing tests don't
exercise. Both pin tests added in S392 are
adversarial (cross-tenant attempts) — would have caught
the bugs at original implementation.

## Items shipped

### Test coverage — 36 cases / 14 describe blocks

New file: `apps/api/src/routes/credit.test.ts` (~520 lines)

**Subject views (GET /subject/own + /subject/:id) — 7 cases**
- /own empty tenant; with events; non-tenant 400
- /:id unknown 404; admin sees all; unrelated landlord
  network-only; current landlord sees current+network;
  subject viewing own sees all tiers

**Screening + stats — 5 cases**
- /screening-by-tenant empty subject; unrelated landlord
  network-tier filter; related landlord full visibility
- /stats unknown 404; related landlord 200

**Score routes — 4 cases**
- Tenant caller → 403 (no admin, no token)
- Admin override → 200
- X-Gam-Lending-Token header → 200
- /recompute admin passes gate (skips strict outcome
  assertion — score math is creditScore.test.ts territory)

**POST /attest — 4 cases**
- Non-landlord 403
- Non-attestable event_type 400
- No relationship 403
- Happy: eviction_notice_filed attested with evidence

**Disputes — 6 cases**
- /mine non-tenant/landlord 403
- /disputes admin / non-admin 403
- /:id non-admin 403 + admin unknown 404
- **S392 fix pin:** /dispute cross-subject blocked
- /dispute happy
- **S392 fix pin:** /evidence cross-subject blocked
- /evidence happy
- /resolve non-admin 403

**Hardship — 3 cases**
- Non-tenant 403
- No subject yet 400
- Happy creates context + event

**Integrity — 3 cases**
- /anchors returns array
- /verify/:id unknown 404
- /verify/:id happy returns `{ok, eventCount}` shape

## Files touched

```
apps/api/src/services/
  creditDispute.ts             (MODIFIED — 2 ownership-
                                check fixes on openDispute +
                                submitDisputeEvidence)

apps/api/src/routes/
  credit.test.ts               (NEW — 520 lines, 36 cases)
```

No migrations. No schema changes. No frontend touched.
No new cleanupAllSchema entries (credit_disputes,
credit_events, credit_subjects, credit_hardship_contexts
were already there from prior arcs).

## Decisions made during build

| Question | Decision |
|---|---|
| Fix the 2 dispute bugs at the service layer or at the route layer? | **Service layer.** The service is the choke-point — both the public route and any future caller (admin tool, batch script) go through it. Route-layer checks would leave any direct service call vulnerable. |
| Test the route layer's response shape on the dispute-fix paths or just the service-layer rejection? | **Route layer.** That's what consumers see. The service rejection bubbles to the route as a thrown Error → 500 from the global error handler. Status assertion is `expect(res.status).not.toBe(200)` which accepts either the current 500 (Error bubbled raw) or a future 400/403 (if the service swaps to AppError). The data-side pin (no dispute row created) is the contract that matters. |
| Test the actual score math on /score/:id/recompute happy? | **No — gate-only.** The score formula seed migration may or may not have run on the test DB at the time the test executes. Verifying the gate (admin → not 403) is the slice's contract; the score math is covered by creditScore.test.ts. Test phrased as "passes the gate (not 403)" to avoid coupling to formula seed state. |
| Test the visibility matrix exhaustively (all 5 roles × 4 visibility tiers)? | **Representative pairs only.** Admin-sees-all, unrelated-landlord-network-only, current-landlord-current+network, subject-sees-all. The full 20-cell matrix would balloon the slice; the canViewSubject helper is internal — its branches surface through these 4 representative cases. |
| Test integrity endpoints with a corrupted chain to verify `ok: false` branches? | **No — happy path only.** verifyChain's failure modes are exercised in creditLedger.test.ts directly. The route just passes the result through. |
| Use the lending_service header path or admin override for score route tests? | **Both.** Each is a distinct branch in requireLendingService; pinning both ensures the gate's two acceptance modes don't silently regress (e.g., env var unset disables the header path). |

## Verification

- `npx tsc --noEmit` clean on apps/api (0 errors).
- `npm test` in apps/api: **1393 tests across 79 files,
  0 failures**, 574.81s.
- 36 new test cases.
- **2 production bug fixes** (both HIGH-severity cross-
  subject dispute manipulation).
- 0 production regressions.
- All 8 existing creditDispute.test.ts cases still pass
  with the new ownership predicates (they all seed
  matching subject IDs).

## Items deferred — what S393 could target

### Critical-band files remaining per COVERAGE_AUDIT_S382.md

After credit.ts close:
- **esign.ts** — 16/25 uncovered (36%). Bundles S388
  audit finding #2 (POST /documents unitId fallback).
  2533 lines — biggest remaining file.
- **background.ts** — 25/25 uncovered (0%). **Parked
  for Checkr fresh-context session** per locked priority.

**Recommend S393 = esign.ts slice 1.** ~8 routes of the
16 uncovered. esign is large enough that splitting is
right; bundle the unitId fallback fix.

### Carried hygiene backlog (15 items now)

All accumulated findings since S388. Worth a dedicated
hygiene micro-session at some point before pos.ts /
esign.ts further work:

From S388 audit: esign POST /documents unitId fallback
(deferred to esign slice), pos shelf-label comment.

From S389: POST /pos/vendors required-field, POST /pos/items/:id/adjust-stock reason enum.

From S390: POST /pos/tax-rates + /discounts required-field,
PATCH /discounts SELECT-then-404, DELETE /tax-rates same.

From S391: POST /tasks + /scheduled assignedTo scope
(needs team-role helper), missing required-field on
/tasks, /parts, /scheduled.

From S392: none new (the dispute fixes shipped).

### Pending Nic decisions

Unchanged from S391.

### Per directive: fix all bugs before Checkr

Cumulative bug-sweep totals (post-S392):
- **21 production bug fixes** (4 tenants arc + 8 books
  arc + 1 charge-account + 4 pos arc + 2 maint-portal
  arc + 2 credit arc)
- 15 architectural / validation findings flagged
- 1393 tests covering ~296 of 506 audited routes
- 4 of 7 critical-band files closed: tenants, books, pos,
  maintenance-portal, credit. **2 remaining: esign,
  background (parked for Checkr).**

## Items deferred (cross-session docket, post-S392)

Unchanged from S391.

## Nic-pending

Unchanged from S391.

## What S393 should target

**Recommended: esign.ts slice 1** — ~8 of the 16
uncovered routes (envelope/signer/template flows).
Bundles S388 audit finding #2 fix. ~12-18 tests. esign
will likely take 2 slices total given the file size.

**Alternative:** the 15-item hygiene micro-session to
clean the backlog. Worth ~30 lines total + ~15 small
test pins.

---

End of S392 handoff. **credit.ts arc CLOSED at 16/16
routes (100%).** Slice / 36 tests / 2 HIGH-severity
production bug fixes (cross-subject dispute injection
+ cross-subject evidence injection).

1393 tests / 79 files / 0 failures. **5 of 7
critical-band files closed.**

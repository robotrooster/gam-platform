# Session 451 — closed

## Theme

**Third post-services-audit session.
`routes/subleaseInvitations.ts` — the S247 sublessee
invite-acceptance public router (269 lines, 2 endpoints,
pre-auth). ZERO prior direct coverage; `subleases.test.ts`
covered the sublessor + landlord-decision flows but the
sublessee-side onboarding had no tests. 18 cases shipped.
Surfaced ONE finding worth flagging — the password minimum
is 8 chars here vs 12 on /register and /register-prospect
(documented in the slice + a hygiene-backlog candidate).
No production bugs found; route is well-built.**

Suite at S450 close: **2759 / 147 files**.
Suite at S451 close: **2777 / 148 files** (+18 cases,
+1 file). 0 failures. Runtime **80.48s**.
Fifty-fourth consecutive fully-green full-suite run.

Zero tsc regressions.

## What shipped

### `routes/subleaseInvitations.test.ts` — 18 cases (NEW file)

Mocks `services/notifications.notifySubleaseRequested`
(the landlord-side fan-out fired post-commit). The
invitation + sublease fixture rolls into one helper
that yields a deterministic, complete state.

**GET /:token — preview (5 cases)**
- Happy: returns property_name + unit_number +
  sublessor_name + sublessee_email + amounts; explicitly
  pins NO sublessor email or tenant id leak (the recipient
  is unauthenticated)
- Unknown token → 404
- Already-accepted invitation → 409
- Cancelled invitation → 409
- Expired (expires_at past) → 410
- Lease-context-vanished branch: **skipped** with a
  comment — reproducing requires a concurrent delete that
  the test layer can't reach (sublessee_invitations.
  master_lease_id is a NOT NULL FK to leases, so the only
  way to break the JOIN is a race after loadInvitation
  but before the ctx query; that's a defensive branch
  with one line of code, provably correct by inspection).

**POST /:token/accept — onboard + accept (13 cases)**
- Happy: 201 with JWT + user + subleaseId. Full
  side-effect verification — invitation → 'accepted' +
  accepted_tenant_id, sublease → 'pending' +
  sublessee_tenant_id, notify mock called with full
  sublessee context (subleaseId, sublesseeName,
  unitNumber, propertyName, subMonthlyAmount). JWT
  decoded to confirm role=tenant + profileId references
  the new tenant.
- Missing firstName → 400 (manual required-field check)
- Missing password → 400
- Password under 8 chars → 400 (**route uses 8-char min**
  — explicitly documented in the test that this differs
  from /register and /register-prospect's 12-char min;
  hygiene-backlog candidate)
- Unknown token → 404
- Invitation already accepted → 409
- Invitation cancelled → 409
- Invitation expired → 410
- Invitation not linked to sublease row → 500 (the
  internal-consistency guard at route line 138)
- Email collision: account already exists at
  sublessee_email → 409 with re-issue hint
- Email collision is CASE-INSENSITIVE (UPPERCASE in
  users row matches lowercase invite email — verifies
  `LOWER(email) = LOWER($1)` query)
- Notify failure does NOT roll back signup (the try/catch
  + logger.error in the post-commit block — verified by
  rejecting the notify mock and confirming both row
  state flips persist)
- Atomicity check: invitation + sublease both flip in
  the same transaction (states before/after pinned)

### Finding — password minimum drift

| Path | Min length | Source |
|---|---|---|
| /api/auth/register | 12 | `PASSWORD_MIN_LEN` (auth.ts:67) |
| /api/auth/register-prospect | 12 | `PASSWORD_MIN_LEN` |
| /api/auth/reset-password (newPassword) | 12 | `PASSWORD_MIN_LEN` |
| /api/sublease-invitations/:token/accept | **8** | inline literal (subleaseInvitations.ts:130) |

The 8-char bar predates the S282 strengthening (which
bumped /register from 8 to 12). When the sublessee
onboarding route shipped (S247, earlier), it cloned the
old 8-char check; the S282 sweep that updated /register
didn't reach it.

**Not in scope here** — pinning it without changing it
is the right move for an audit slice. Logged as a
hygiene-backlog item for the next sweep: equalize the
sublessee bar to PASSWORD_MIN_LEN, ideally importing the
constant so future bumps stay coherent.

## Items shipped

```
apps/api/src/routes/
  subleaseInvitations.test.ts           (NEW — 18 cases)
```

No production source changes. Route is well-built.

## Decisions made during build

| Question | Decision |
|---|---|
| Pin the 8-char password min, or fix it to match the 12-char /register bar? | **Pin, flag, defer.** Two routes set the bar; equalizing them is a hygiene call that touches user-facing copy (the error message changes) + the existing 8-char invites in flight (already-issued tokens still validate at 8 → mid-flight inconsistency). Worth doing, but worth doing deliberately, not as a fix-it-right in an audit slice. |
| Mock notifySubleaseRequested or run it? | **Mock.** services/notifications fans out to email + push + admin; running it live would drag in unrelated state-setup for one assertion. Mock-and-pin-shape is the cleaner contract here. |
| Test the email collision case-insensitivity branch? | **Yes — load-bearing.** The route uses `LOWER(email) = LOWER($1)` specifically to prevent the scenario where a user signed up with MIXED.CASE@example.com after the invite went out to mixed.case@example.com. A regression that dropped the LOWER would let duplicate accounts form across casings, breaking the collision guard. |
| Test the notify-failure-doesn't-roll-back-signup branch? | **Yes — operational property.** The try/catch + logger.error pattern in the route is explicit per the docstring; a regression that re-threw would mean a transient SMTP outage rolls back the entire onboarding, forcing the recipient to start over. Pin the property by rejecting the notify mock and confirming the row states persist. |
| Skip the "Lease context vanished" 404? | **Yes, with a comment.** The seed gymnastics required to break ALL FKs around the JOIN without invalidating the invitation row itself aren't worth it; the branch is single-line and provably correct by inspection. Comment explains the why. |
| Pin sublessor-name from the JOIN? | **Yes — non-leak property.** The preview returns sublessor_name (full name) but NOT sublessor email or tenant id. A regression that surfaced either would leak the sublessor's identity to a not-yet-authenticated recipient. Pin negative properties (`not.toHaveProperty`) alongside positive ones. |

## Verification

- `npx tsc --noEmit` clean on apps/api (0 errors).
- `npm test` in apps/api: **2777 tests across 148 files,
  0 failures**, 80.48s. **Fifty-fourth consecutive
  fully-green full-suite run.**
- 18 new test cases in this slice.
- 0 production / infra fixes — route is clean.
- 1 documented finding (password-min drift) — flagged
  to hygiene backlog.

### Bugs caught during test authoring

None. The route is well-built. The author's own initial
edge-case test (Lease context vanished) couldn't be
seeded; removed with a comment explaining why.

## Routes audit — progress

Post-S451:

### Routes covered this session

- subleaseInvitations.ts

### Routes still uncovered after S451

```
announcements.ts          (20 lines — stub)
background.ts             (1095 lines — partial via
                           background.test.ts + checkrProvider;
                           full route slice deferred)
books.ts                  (large — partial test)
documents.ts              (32 lines — stub-like)
fitness.ts                (standalone subsystem — low priority)
tenants.ts                (large — partial via
                           tenants-profile-dashboard.test.ts)
```

## Items deferred — what S452 could target

### Continue route audit

**Recommend S452 = `background.ts` route slice.** 1095
lines, partial coverage (background.test.ts + Checkr
provider tests). The remaining surface: route-level
gating (provider selection at /submit, admin/landlord
authz, status-change endpoints). Real-security path
(background-check approve/deny). Single-session slice
of ~25-35 cases.

**Alternatives:**
- announcements.ts + documents.ts batch (both stub-sized,
  trivial coverage)
- Address password-min drift hygiene item
- Tackle the validation-hygiene backlog items now
  documented above

### Validation-hygiene backlog (16 + 1 → 17 items)

S451 added one: **password-min drift between
/sublease-invitations/:token/accept (8 chars) and
/register / /register-prospect / /reset-password (12 chars
via PASSWORD_MIN_LEN)**. Equalize when the next hygiene
sweep ships.

### Cumulative bug-sweep totals (post-S451)

- **55 production / infra bug fixes** (unchanged from
  S450) + 1 documented finding (posTax rounding from S439)
  + 1 documented finding (password-min drift from S451)
- 17 architectural / validation findings remaining
  (16 Nic-pending + 1 S451 hygiene)
- 2777 tests across 148 files
- Suite baseline: **66-81s on a clean machine**

## What S452 should target

**Recommended: background.ts route slice** — largest
uncovered route by lines, real-security path.
~25-35 cases.

**Alternatives:**
- Password-min hygiene fix (1-line + test update;
  micro-session)
- Stub coverage for announcements + documents (combined
  trivial slice)

---

End of S451 handoff. **subleaseInvitations.ts shipped —
18 tests covering GET preview (sublessor-identity
non-leak, status gates, expiry) and POST accept (field
gates, password min, status gates, email collision +
case-insensitivity, missing sublease link → 500, happy
+ full state flip + notify mock + atomicity, notify
failure isolation).** Surfaced a password-min drift
(8 here vs 12 elsewhere) — documented + logged for the
next hygiene sweep, NOT fixed in this audit slice.

2777 tests / 148 files / 0 failures. Fifty-fourth
consecutive fully-green full-suite run.

**55 cumulative production / infra bug fixes** + 2
documented findings still pending decision. Route audit
continues; subleaseInvitations.ts CLOSED.

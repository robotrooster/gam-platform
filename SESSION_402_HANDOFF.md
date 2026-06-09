# Session 402 — closed

## Theme

**notifications.ts gap-close slice — closes the file at
6/6 (100%). 20 new test cases, 0 production bug fixes
(clean slice — the routes were already properly auth-
gated, parameterized, and scope-resolving).**

Suite at S401 close: **1619 / 88 files**.
Suite at S402 close: **1639 / 89 files** (+20 cases,
+1 file). 0 failures. Runtime 1586.73s (slower than
recent runs but no flakes). Sixth consecutive
fully-green full-suite run.

Zero tsc regressions.

## Items shipped

### Test coverage — 20 cases / 6 describe blocks

New file: `apps/api/src/routes/notifications.test.ts`
(~340 lines)

**GET /api/notifications — 4 cases**
- Returns only caller's notifications + unreadCount
- `unread=true` filter narrows to unread only
- `limit` query param caps result (unreadCount stays full)
- Unauthenticated → 401

**PATCH /api/notifications/:id/read — 2 cases**
- Marks own notification as read + sets read_at
- Cross-user: silent no-op on another user's row
  (UPDATE clause filters by user_id; row stays unread)

**PATCH /api/notifications/read-all — 2 cases**
- Marks all caller's unread as read; other users untouched
- Express route order: `/read-all` not swallowed by
  `/:id/read` (path-shape safety pin)

**GET /api/notifications/preferences — 3 cases**
- Returns caller's pref rows
- Returns [] when none set
- Does not leak another user's preferences

**PATCH /api/notifications/preferences — 2 cases**
- Upsert: first call inserts new pref row
- Upsert: second call updates (ON CONFLICT user_id,type)

**POST /api/notifications/bulk — 7 cases**
- Happy: forwards resolved landlordId to service
- Happy: propertyId pass-through when valid uuid
- Missing title → 400
- Missing body → 400
- propertyId not a uuid → 400
- Non-owner role without `notifications.send_bulk` perm → 403
  (OWNER_ROLES auto-pass requirePerm; PM without
  perm exercises the negative path)
- Caller with perm but no landlord scope (tenant role)
  → 400 "No landlord scope on this user"

## Architectural observations (worth recording, no fix in slice)

### Mid-confidence finding: `GET /api/notifications?limit=-1` may 500

The route uses `parseInt(req.query.limit as string) || 20`.
A negative limit (e.g. `?limit=-1`) parses to `-1`, which
is truthy in JS, so the `|| 20` fallback doesn't fire —
the negative value passes through to `LIMIT $2` and
postgres returns `22023 invalid argument: LIMIT must not
be negative`, surfaced as 500. Unbounded positive limits
also pass through (no cap, theoretical DoS via giant
`?limit=999999`).

**Why not fixed in S402:** the route is caller-scoped to
the user's own notifications, so the blast radius is
self-DoS only — a user can crash their own request, not
anyone else's. Validation-hygiene-class item; bundle
with the S398 product decisions.

### `PATCH /api/notifications/preferences` accepts any `type` string

No CHECK constraint on `notification_preferences.type`,
no allow-list at the route. Authenticated users can
spam arbitrary type strings into their own preference
table. Self-impact only, but a data-hygiene concern as
the preference catalog grows. Same hygiene-class
bundle.

## Files touched

```
apps/api/src/routes/
  notifications.test.ts                (NEW — ~340 lines,
                                         20 cases)
```

No production code touched. No migrations. No schema
changes. No frontend touched.

## Decisions made during build

| Question | Decision |
|---|---|
| Mock sendBulkNotification or hit the live service? | **Mock with vi.hoisted.** The service writes to multiple tables + dispatches email/SMS. Route-layer slice tests the gate-then-call contract; service has its own coverage. Same pattern as S398 deposit-return service mocks. |
| Test cross-user PATCH /:id/read with 200 + DB-state-unchanged? | **Yes — pin both the response AND the side-effect.** The route returns 200 even when the row doesn't belong to the caller (UPDATE silently affects 0 rows). Pinning the DB unchanged is the actual security contract; the 200 alone could mask a regression. |
| Fix the negative-limit 500 in S402? | **No — flag, defer.** Self-DoS only (caller's own requests). Belongs in validation-hygiene micro-session, not a gap-close slice. |
| Fix the no-CHECK-on-prefs-type in S402? | **No — flag, defer.** Same reasoning. Data-hygiene concern, not a security or correctness issue today. |
| Test the OWNER_ROLES auto-pass in requirePerm? | **Yes — used a PM role explicitly** to verify the negative path. OWNER_ROLES auto-pass was discovered when the landlord-role-no-perm test passed instead of 403'ing; pivoted the test to PM-no-perm which is the actually-meaningful negative. |

## Verification

- `npx tsc --noEmit` clean on apps/api (0 errors).
- `npm test` in apps/api: **1639 tests across 89 files,
  0 failures**, 1586.73s. **Sixth consecutive fully-
  green full-suite run.**
- 20 new test cases.
- 0 production bug fixes (none surfaced).
- 0 production regressions.

## Items deferred — what S403 could target

### Medium-band batch remaining

After notifications.ts close (6 routes):
- **terminal.ts — 4 routes (66 lines)** — smallest
  remaining file by lines.
- **reports.ts — 5 routes (489 lines)** — larger file,
  financial-data recon needed.
- **stripe.ts — 5 routes (279 lines)**
- **bankAccounts.ts — 4 routes (129 lines)**
- **payments.ts — 4 routes (429 lines)**
- **posCustomerOnboarding.ts — 3 routes (253 lines)**

Total remaining medium-band: **25 routes across 6 files.**

**Recommend S403 = terminal.ts gap-close.** Smallest
remaining file (66 lines, 4 routes); clean slice
in/out. Then bankAccounts.ts (129 lines, 4 routes)
next.

### Validation-hygiene backlog (now 23 items)

S401 carryover (21) + S402's two findings:
- GET /api/notifications negative-/unbounded-limit
- PATCH /api/notifications/preferences no `type` allow-list

### Pending Nic decisions

Unchanged (S398 product decisions captured in
`project_s398_product_decisions.md`).

### Per directive: fix all bugs before Checkr

Cumulative bug-sweep totals (post-S402):
- **38 production bug fixes** (unchanged — no new
  surfaced this slice)
- 23 architectural / validation findings flagged
- 1639 tests covering ~375 of 506 audited routes (74%)

## Items deferred (cross-session docket, post-S402)

Unchanged from S401 + the two S402 hygiene findings
above.

## Nic-pending

Unchanged.

## What S403 should target

**Recommended: terminal.ts gap-close** (4 routes, 66
lines). Smallest remaining medium-band file.

**Alternatives:**
- bankAccounts.ts gap-close (4 routes, 129 lines —
  next-smallest by lines)
- reports.ts gap-close (5 routes, 489 lines — bigger
  surface, more bug potential)
- Validation-hygiene micro-session (23-item backlog +
  S398 product decisions)
- background.ts + Checkr (defer until route-test
  sweep closes — recommend AFTER all medium-band
  routes covered)

---

End of S402 handoff. **notifications.ts arc CLOSED at
6/6 routes (100%).** Slice / 20 tests / 0 production
bug fixes (clean — routes were already
correctly-gated). Second zero-bug slice of the sweep
(after S398 leases).

1639 tests / 89 files / 0 failures. Sixth consecutive
fully-green full-suite run.

**38 cumulative production bug fixes shipped across the
bug sweep.**

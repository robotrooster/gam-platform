# Session 401 — closed

## Theme

**bulletin.ts gap-close slice — closes the file at 5/5
(100%). 28 new test cases, 2 production bug fixes
(including a CRITICAL SQL injection and a DEAD ROUTE).**

Suite at S400 close: **1591 / 87 files**.
Suite at S401 close: **1619 / 88 files** (+28 cases,
+1 file). 0 failures. Runtime 991.42s. Fifth
consecutive fully-green full-suite run.

Zero tsc regressions.

## Production bug fixes shipped

### 1. **CRITICAL — `GET /api/bulletin/landlord` raw SQL injection**

**Severity: CRITICAL — authenticated landlord/PM could
execute arbitrary SQL.**

```js
// PRE-FIX (bulletin.ts:244)
const dateFilter = date
  ? `AND DATE(created_at) = '${date}'`           // <-- raw interpolation
  : `AND DATE(created_at) = CURRENT_DATE`
const searchFilter = search
  ? `AND content ILIKE '%' || '${(search as string).replace(/'/g,"''")}' || '%'`  // <-- hand-rolled half-defense
  : ''
```

The `date` query param had ZERO escaping — direct string
interpolation into a SQL string passed to `db.query`. A
`landlord` or `property_manager` (any user with
`bulletin.view` permission) could send
`?date=2026-01-01' OR '1'='1` to defeat the date filter,
or escalate to UNION/DELETE with the right payload
shape.

`search` had a hand-rolled `''` escape that's the
classic "half-defense": handles simple single-quote
attacks but leaves backslash, LIKE metachar
(`% _ \`), and pg-specific edge cases unhandled.

**Fix:** both filters now route through proper
parameterized `$N` binds. `date` is also
format-validated as YYYY-MM-DD before binding (rejects
anything else as 400), so postgres can't be tricked
into permissive casting.

**Pre-existence proof:** the slice test
`'S401 fix: SQL injection via date query param is now
blocked'` sends `?date=2026-01-01' OR '1'='1` and
verifies the response is now 400. Pre-fix this would
have been 200 with unfiltered rows.

### 2. `GET /api/bulletin/:id/reveal` was completely unreachable (dead route)

**Severity: medium — bulletin moderation reveal-poster-
identity feature didn't work for ANYONE, including
super_admin.**

```js
// PRE-FIX (bulletin.ts:200)
if (!req.user?.permissions?.super_admin) throw new AppError(403, ...)
```

`req.user.permissions.super_admin` is **never set in
any JWT issued by the system.** Tracing the login path:
- `getScopeForUser(userId, role)` in `auth.ts` only
  has cases for `property_manager`, `onsite_manager`,
  `maintenance`, `bookkeeper`. For `admin` /
  `super_admin` roles it falls through and returns
  `null`.
- At login (`auth.ts:251`), `permissions: scope?.permissions || null`
  → super_admin tokens are minted with `permissions: null`.
- So `req.user?.permissions?.super_admin` is always
  `undefined` → falsy → always 403.

The route was dead code in production. The bulletin
anonymity surface had no working "reveal" admin tool
despite the UI/comment claiming there was one.

**Fix:** check `req.user?.role === 'super_admin'`
instead — matches the pattern used everywhere else in
the codebase for super_admin gating.

## Items shipped

### Test coverage — 28 cases / 5 describe blocks

New file: `apps/api/src/routes/bulletin.test.ts`
(~420 lines)

**GET /api/bulletin — 5 cases**
- Happy: tenant sees property-scope post; vote eligibility
- City scope: same-city tenants see, other-city tenants don't
- Invalid scope → 400
- Non-tenant role → 403
- Tenant with no active lease → 404

**POST /api/bulletin — 4 cases**
- Happy: 201 + alias generated + my_vote/can_vote shape
- Content too short → 400
- Content too long → 400
- Invalid scope → 400

**POST /api/bulletin/:id/vote — 7 cases**
- Happy: cross-tenant upvote + count recompute
- Cannot vote on own post → 403
- Tenant from other property → 403 (geo-gate)
- Double-vote → 409
- Invalid voteType → 400
- Unknown post → 404
- Vote on past post → 403 (today-only window)

**GET /api/bulletin/:id/reveal — 5 cases**
- **S401 fix:** super_admin can now reveal (was 403 pre-fix)
- Non-super-admin admin → 403
- Landlord → 403
- Tenant → 403
- Unknown post → 404

**GET /api/bulletin/landlord — 7 cases**
- Happy: landlord sees property posts (today default)
- **S401 fix:** SQL injection via `date` blocked (now 400)
- Valid YYYY-MM-DD date filter parameterized correctly
- Search with apostrophe no longer crashes / leaks
- Search substring match works
- Landlord with no properties → 200 + []
- Non-scoped role → 400/403

## Files touched

```
apps/api/src/routes/
  bulletin.ts                          (2 surgical fixes:
                                         parameterized
                                         date+search binds
                                         in /landlord +
                                         role check in
                                         /:id/reveal)
  bulletin.test.ts                     (NEW — ~420 lines,
                                         28 cases)
```

No migrations. No schema changes. No frontend touched.

## Decisions made during build

| Question | Decision |
|---|---|
| Fix the SQL injection in the same pass? | **Yes — critical fix-it-right.** Cannot leave a known SQL injection on a live route after discovering it during recon. Authenticated surface but still a textbook escalation vector. |
| Fix the dead reveal route in the same pass? | **Yes — same file, same recon pass.** Six-character change (`permissions?.super_admin` → `role === 'super_admin'`). The route's intent matches the rest of the codebase's super_admin pattern; reviving the feature for super_admins is a strict reversion-to-intended-behavior, not a product change. |
| Pin BOTH the injection vector AND the legitimate date filter? | **Yes.** Pinning only the rejection leaves the legit path untested — a future "make date optional" refactor could remove the format check and reintroduce the hole. Both tests together make the contract concrete. |
| Add validation to the `search` param too? | **No.** Parameterized binding is the right defense; format validation on free-text search would constrain legitimate use (apostrophes in tenant queries). The test pins that apostrophes flow through without breaking the query. |
| Test scope-gating across multiple cities? | **Yes — Phoenix vs Tucson on the same landlord** is a tight isolation test of the geo-gate that doesn't require cross-landlord setup. |

## Verification

- `npx tsc --noEmit` clean on apps/api (0 errors).
- `npm test` in apps/api: **1619 tests across 88 files,
  0 failures**, 991.42s. **Fifth consecutive fully-green
  full-suite run.**
- 28 new test cases.
- 2 production bug fixes (SQL injection + dead reveal).
- 0 production regressions.

## Items deferred — what S402 could target

### Medium-band batch remaining

After bulletin.ts close:
- **notifications.ts — 6 routes (84 lines)** — smallest
  remaining medium-band file. Clean slice, no obvious
  bugs from recon.
- **reports.ts — 5 routes (489 lines)** — larger file,
  needs financial-data recon to identify per-landlord
  scoping invariants.
- **stripe.ts — 5 routes (279 lines)**
- **bankAccounts.ts — 4 routes (129 lines)**
- **payments.ts — 4 routes (429 lines)**
- **terminal.ts — 4 routes (66 lines)** — second-
  smallest medium-band file.
- **posCustomerOnboarding.ts — 3 routes (253 lines)**

Total remaining medium-band: **31 routes across 7
files.**

**Recommend S402 = notifications.ts gap-close.**
Smallest file (84 lines, 6 routes). Already recon'd
during S401 setup; no obvious bugs flagged but worth
pinning the bulk-notification + scope-resolution
contract.

### Validation-hygiene backlog (now 21 items)

Unchanged from S400. Plus a S401-adjacent note:
several routes use the inline `role === 'landlord'
? profileId : landlordId` pattern. There's an existing
`resolveLandlordIdForUser` helper in `lib/scope.ts`
that does this — S400's units.ts fix should be
refactored to use it, plus an audit for other
copy-paste instances. Bundle into the hygiene session.

### Pending Nic decisions

Unchanged (S398 product decisions captured in
`project_s398_product_decisions.md`).

### Per directive: fix all bugs before Checkr

Cumulative bug-sweep totals (post-S401):
- **38 production bug fixes** (+2 in S401, including
  the most severe finding of the sweep: a SQL
  injection on an authenticated landlord surface)
- 21 architectural / validation findings flagged
- 1619 tests covering ~369 of 506 audited routes (73%)

## Items deferred (cross-session docket, post-S401)

Unchanged from S400.

## Nic-pending

Unchanged.

## What S402 should target

**Recommended: notifications.ts gap-close** (6 routes,
84 lines). Smallest remaining medium-band file; clean
slice in/out.

**Alternatives:**
- terminal.ts gap-close (4 routes, 66 lines — even
  smaller but fewer routes covered per slice)
- reports.ts gap-close (5 routes, 489 lines — bigger
  surface, more recon needed, more likely to surface
  bugs given the financial-data scope)
- bankAccounts.ts gap-close (4 routes, 129 lines)
- Validation-hygiene micro-session (21-item backlog)
- background.ts + Checkr (defer until route-test sweep
  closes)

---

End of S401 handoff. **bulletin.ts arc CLOSED at 5/5
routes (100%).** Slice / 28 tests / 2 production bug
fixes — including the CRITICAL SQL injection on
`GET /landlord` and the DEAD `GET /:id/reveal` route.

1619 tests / 88 files / 0 failures. Fifth consecutive
fully-green full-suite run.

**38 cumulative production bug fixes shipped across the
bug sweep.** The S401 SQL injection is the most severe
finding surfaced since the sweep began at S375.

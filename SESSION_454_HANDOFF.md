# Session 454 — closed

## Theme

**Phase 1a.1 continuation. Shared package enum exports for
the business-side surfaces + extending `/api/auth/login`'s
scope dispatch to handle `business_owner` and `business_staff`.
11 new test cases pinning the new auth paths. Also caught +
fixed two pre-existing timezone-boundary flakes in unrelated
tests (csvImportTenantBalance + esign) that surfaced on this
particular UTC-midnight window — not from S454 changes, but
broke the green-suite streak so fixed in-pass.**

Suite at S453 close: 2780 / 148.
Suite at S454 close: **2791 / 149 / 0 failures**, 86.45s.

Zero tsc regressions.

## What shipped

### Shared enum exports (S453 Phase 1a.1 single-source-of-truth)

`packages/shared/src/index.ts` extended with:

- `USER_ROLES` — added `business_owner` + `business_staff`.
  Mirror of the S453 migration that extended the
  `users_role_check` CHECK.
- `BUSINESS_ROLES = ['business_owner']` + `BUSINESS_ROLE_LABEL`
  — the owner-side role; distinct from staff.
- `BUSINESS_STAFF_ROLES = ['manager', 'dispatcher', 'driver',
  'office']` + `BUSINESS_STAFF_ROLE_LABEL` — single source of
  truth for `business_users.staff_role` CHECK.
- `BUSINESS_TYPES = ['trash_hauling', 'maintenance_crew',
  'mobile_rental', 'equipment_rental', 'other']` +
  `BUSINESS_TYPE_LABEL` — mirror of `businesses.business_type`
  CHECK.
- `BUSINESS_STATUSES`, `BUSINESS_USER_STATUSES`,
  `BUSINESS_CUSTOMER_TYPES`, `BUSINESS_CUSTOMER_STATUSES` —
  status enums on each of the three new tables, plus the
  customer-type enum.

All follow the established `as const` + `typeof X[number]`
type-derivation pattern (per CLAUDE.md enum rule).

### Auth scope dispatch — `routes/auth.ts`

1. **`getScopeForUser`** — new `business_staff` branch.
   Queries `business_users` filtered to `status='active'`,
   returns `{ businessId, staffRole, permissions, landlordId: null }`.
   Mirrors the `property_manager_scopes` pattern shape, but
   on a parallel scope tree (business-side, not landlord-side).

2. **`POST /api/auth/login`** — three changes:
   - Outer JOIN extended with `LEFT JOIN businesses b ON
     b.owner_user_id = u.id AND b.status = 'active'` so the
     owner's `business_id` lands in the single login query.
     `profile_id` now COALESCES through landlord → tenant →
     business (in declaration order).
   - `isWorkerRole` list extended to include `business_staff`
     (so missing scope → 403 deactivated, just like the
     landlord-side worker roles).
   - JWT mint + response shape now carry `businessId` +
     `staffRole`. business_owner gets `businessId` from the
     JOIN; business_staff gets `businessId` + `staffRole` from
     scope. Both flow into the JWT so downstream `requireAuth`
     can read them without a DB hit.
   - **403 message variant**: business_staff deactivation says
     "Contact your business owner" (NOT the landlord-flavored
     "Contact your landlord" message). Pinned in tests.

3. **`GET /api/auth/me`** — same JOIN extension, surfaces
   `business_id` + `businessId` (camelCase mirror) +
   `business_type` for owners; `businessId` + `staff_role` +
   `staffRole` for staff via re-fetched scope. Mirrors the
   existing `landlord_id` / `landlordId` + `permissions`
   pattern.

### `middleware/auth.ts` — `AuthPayload` extended

Added optional `businessId?: string | null` + `staffRole?:
string | null` to the JWT payload type. Backward-compatible
(both optional + nullable).

### Tests — `routes/authBusiness.test.ts` (NEW, 11 cases)

Companion to S450's `auth.test.ts`. Pins:

**POST /api/auth/login — business_owner (3)**
- Happy: 200 + businessId on response + JWT carries businessId
  + profileId === businessId for owners
- Archived business → owner still logs in with businessId=null
  (JOIN filters status='active'; portal renders the
  "your business has been archived" surface, not a 403)
- business_owner is NOT in the worker list → no deactivation
  even if no businesses row exists at all

**POST /api/auth/login — business_staff (5)**
- Happy: scope row resolves businessId + staffRole +
  permissions onto response and JWT
- Each of the 4 staff roles (manager / dispatcher / driver /
  office) resolves to the right `staffRole` value
- No scope row → 403 with "business owner" wording (NOT
  "landlord" — pinned negatively too)
- status='revoked' scope row → 403 (scope query filters
  status='active')
- status='invited' scope row → 403 (same filter)

**GET /api/auth/me — business roles (3)**
- business_owner: surfaces `business_id` + `businessId` mirror
  + `business_type` from the JOIN; `staffRole` stays null
- business_staff: surfaces businessId + staffRole +
  permissions from re-fetched scope
- Non-business role (landlord): business_id + staffRole stay
  null (no accidental field leakage to unrelated roles)

### Timezone-boundary flake fixes (NOT from S454 work)

Two unrelated test files were red on the full-suite run
because the wall clock was straddling UTC midnight. Both
computed "today" via `new Date().toISOString().slice(0, 10)`
(UTC) and compared against the DB's `CURRENT_DATE` (server
local time), which differ by a day in that window.

- `routes/csvImportTenantBalance.test.ts:206-207` —
  "writes a pending invoice for the carry-over balance"
- `routes/esign.test.ts:2191-2192` —
  "sublease flips to active, doc URL stamped,
  landlord_consent_date set to today"

**Fix:** pull "today" from the DB via `SELECT CURRENT_DATE::text
AS today` instead of computing in JS, so both sides of the
assertion use the same timezone. Comment-block explains the
pre-S454 flake reason. Same pattern can be lifted into a
helper if more of these surface (low priority).

## Items shipped

```
apps/api/src/routes/
  auth.ts                          (login JOIN + scope dispatch +
                                    response/JWT shape extensions)
  authBusiness.test.ts             (NEW — 11 cases)
  csvImportTenantBalance.test.ts   (1 line — TZ flake fix)
  esign.test.ts                    (1 line — TZ flake fix)
apps/api/src/middleware/
  auth.ts                          (+2 fields on AuthPayload)
packages/shared/src/
  index.ts                         (USER_ROLES extension + new
                                    BUSINESS_* enums + labels)
```

## Decisions made during build

| Question | Decision |
|---|---|
| Owner profile_id resolution: scope row vs login JOIN? | **JOIN.** Owner's business_id is a 1-1 relationship that lives on the businesses row directly; querying through a separate scope helper would be a redundant DB hit per login. Matches how landlord profile_id comes off the landlords JOIN. |
| Archived business — log-in or 403? | **Log in with businessId=null.** Owner can still authenticate and reach the portal; the portal handles "your business is archived, contact support" copy. Doesn't add a special-case 403 path for what's essentially an admin-imposed state — same posture as a landlord with no properties yet. |
| business_staff 403 wording vs landlord-worker wording | **Different message.** "Contact your business owner" instead of "Contact your landlord." A deactivated trash company dispatcher shouldn't be told to call a landlord. Pinned with both a positive match (`/business owner/i`) and a negative match (`not.toMatch(/landlord/i)`) so a future regression that unified the message would surface immediately. |
| `staffRole` on JWT — required or optional? | **Optional.** Only set for business_staff role; null for owner + everyone else. Frontend reads it as the source-of-truth for driver-only / dispatcher-only screen gating without a DB hit per request. |
| Mirror `landlord_id` snake_case alongside `landlordId` for business_id? | **Yes.** Existing /me response already double-emits both casings for landlord. Frontend may consume either. Consistency cheap. |
| Fix the pre-existing TZ flakes? | **Yes.** Not technically my scope, but they broke a 54-session green-suite streak. One-line fix per test, well-bounded, with a comment block explaining the cause for future readers. |

## Verification

- `npx tsc --noEmit` clean on apps/api.
- `npm test`: **2791 / 149 / 0 failures**, 86.45s. Suite went
  from 2780 → 2791 (+11 = exactly the new test cases).
- All 73 prior auth-related tests (auth.test.ts +
  loginLockout + totp + emailVerification +
  passwordReset + s417-disposable-email) still pass.

## Phase 1a.1 — progress

- ✅ S453 — DB migrations (role enum + businesses +
  business_users + business_customers + cleanupAllSchema
  pre-emptive cleanup)
- ✅ **S454 — shared enum exports + auth scope dispatch +
  tests**
- ⏳ S455 — Routes (businesses CRUD + business_users staff
  invitation flow + business_customers CRUD)
- ⏳ S456 — Portal scaffold (`apps/business` Vite app on
  port 3012)
- ⏳ S457 — Tests + smoke walk

Phase 1a.1 is ~50% by effort after S454. The DB foundation +
auth wiring are the load-bearing pieces; routes are smaller
mechanical work; the portal scaffold mirrors `apps/landlord`.

## What S455 should target

**Recommended: `routes/businesses.ts` — CRUD for the businesses
entity, plus owner-self-registration.**

Endpoints:
- `POST /api/businesses` (owner self-signup; transactional —
  creates users row with role='business_owner' + businesses
  row; mirrors /api/auth/register-prospect's shape)
- `GET /api/businesses/me` (current owner's business detail)
- `PATCH /api/businesses/me` (update name / business_type /
  address / phone / EIN)
- `GET /api/businesses` (admin only — list all businesses)
- `PATCH /api/businesses/:id/status` (admin only — flip
  active / suspended / archived)

After /api/businesses, S456 does business_users routes
(invite flow analog of property_manager invitations) +
business_customers CRUD. Then S457 ports the portal shell
from apps/landlord into apps/business.

**Alternatives:**
- Skip ahead to portal scaffold so Nic can see a UI early
  — but the API has to exist first or the portal has
  nothing to talk to. Not recommended.

## Items uncommitted in tree (not from this session)

Same as S453 noted:
- State-law batch migrations + ingest scripts from the
  parallel agent-platform arc
- `.env.example` Checkr block
- Plus everything from S453 (now also uncommitted alongside
  S454 work)

When committing, Nic should decide:
1. Commit S453 + S454 business-arc work as one or two
   commits ("Phase 1a.1: businesses entity + auth wiring")
2. Decide on the state-law arc separately
3. Decide on `.env.example` Checkr block separately

---

End of S454 handoff. **Auth wiring for the new
business_owner + business_staff roles landed: shared
package enum sources, login JOIN extension, scope
dispatch for staff, JWT + response shape extensions, 11
new tests pinning every branch. Plus two pre-existing
TZ-boundary flakes patched in-pass to keep the suite
green.**

2791 tests / 149 files / 0 failures.

**Phase 1a.1 is ~50% by effort.** Routes + portal scaffold
remain (S455-S457).

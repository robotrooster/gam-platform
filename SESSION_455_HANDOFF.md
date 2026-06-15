# Session 455 — closed

## Theme

**Phase 1a.1 continuation. `routes/businesses.ts` — owner
self-signup + me-CRUD + admin list + admin status flip. 5
endpoints. Mounted at `/api/businesses` in index.ts.
31 new cases pinning every gate + branch.**

Suite at S454 close: 2791 / 149.
Suite at S455 close: **2822 / 150 / 0 failures**, 90.45s.

Zero tsc regressions. Zero production bugs caught — the
S453/S454 schema + auth foundation held cleanly.

## What shipped

### `routes/businesses.ts` — 5 endpoints

**`POST /api/businesses`** — owner self-signup (PUBLIC, no
auth middleware)
- Single transaction: `users` row with `role='business_owner'`
  + `businesses` row with `owner_user_id` tied back. Both ToS
  timestamps stamped per the /register precedent.
- Returns 201 with `{ token, user, business }`. JWT carries
  `businessId` + `staffRole=null` so the new owner lands
  directly in the business portal post-signup.
- 12-char password minimum (matches `PASSWORD_MIN_LEN` on
  /api/auth/register; S451 finding logged the legacy 8-char
  drift on sublease-invitations — this route doesn't have it).
- Disposable-domain block (S417 fan-out — mailinator etc.
  refused with the same copy as /register).
- Case-insensitive email collision: `LOWER(email)` query —
  prevents duplicate-account creation across casings AND
  blocks an email already used by tenant/landlord/etc. roles.
- Optional address fields persist when supplied; ein, phone,
  street/city/state/zip can all be PATCH'd later anyway.

**`GET /api/businesses/me`** — current owner's business
- Filters `status IN ('active', 'suspended')` so archived
  businesses 404 (the portal handles
  "your business has been archived" copy elsewhere).
- 403 for non-`business_owner` roles (staff /landlord/tenant
  /admin all hit this gate). Admin reads through the list
  route instead.
- 404 for an owner with no business row (edge case — the
  S454 login JOIN already returns null businessId in this
  state).

**`PATCH /api/businesses/me`**
- Mutable: businessName, businessType, email, phone, full
  address, ein, notes. Status flip is NOT here — that's
  admin-only.
- Strict zod schema (`.strict()`) — refuses unknown keys
  with 400. Pin test: PATCHing `{ status: 'archived' }`
  through here 400s instead of silently mutating.
- COALESCE-preserves-omitted-fields pattern (same as
  /api/auth/PATCH-me). Pinned: setting `phone='111'` then
  PATCHing only `businessName='Renamed'` leaves phone
  intact.
- Empty patch → 400 "Nothing to update" (matches the
  empty-PATCH convention used elsewhere).
- Cross-owner isolation pinned: owner A's PATCH cannot
  mutate owner B's business.

**`GET /api/businesses`** — admin-only list
- `requireRole('admin', 'super_admin')`. 403 for non-admin.
- JOIN users → returns `owner_email` + `owner_first_name`
  + `owner_last_name` per row so the admin UI can render
  the owner context without a second round-trip.
- `ORDER BY created_at DESC LIMIT 200`. Pagination is a
  future hygiene call when business count crosses ~200.

**`PATCH /api/businesses/:id/status`** — admin-only status
flip
- Body: `{ status: 'active' | 'suspended' | 'archived' }`.
- zod enum on the status value — rejects unknown.
- 404 for unknown business id.
- Status flip does NOT cascade to business_users (revoking
  the business doesn't revoke staff scope rows). Reason:
  re-activating the business should also re-enable staff;
  losing scope rows on suspend would force a re-invite.

### `apps/api/src/index.ts` — router mount

```ts
import { businessesRouter } from './routes/businesses'
app.use('/api/businesses', businessesRouter)
```

Mounted alphabetically near landlords / tenants. Subject
to the global `/api/` rate limiter; not subject to the
auth-route limiter (signup is more like a regular create
than a credential flow).

### Tests — `routes/businesses.test.ts` (NEW, 31 cases)

- **POST signup (10)**: happy + JWT shape + ToS gate (×2:
  missing / false) + password min + invalid type +
  disposable email + duplicate (case-insensitive) +
  cross-role email collision + full-address persistence
- **GET /me (6)**: happy + 401 + non-owner 403 + owner-no-
  business 404 + archived → 404 + suspended → 200
- **PATCH /me (7)**: multi-field + COALESCE preserves +
  empty body 400 + invalid type 400 + strict schema 400 +
  cross-owner isolation + non-owner 403
- **GET / (admin list) (3)**: admin sees all + non-admin
  403 + 401
- **PATCH /:id/status (5)**: active→suspended, active→
  archived, invalid 400, unknown id 404, non-admin 403

## Items shipped

```
apps/api/src/routes/
  businesses.ts                    (NEW — 5 endpoints, 240 lines)
  businesses.test.ts               (NEW — 31 cases)
apps/api/src/
  index.ts                         (+2 lines — import + mount)
```

## Decisions made during build

| Question | Decision |
|---|---|
| business_type lockable post-creation? | **Mutable via PATCH.** A business could legitimately pivot (trash hauling → maintenance crew) — restricting it later forces support tickets. The CHECK enum on the column still gates valid values. |
| Use `.strict()` zod schema on PATCH? | **Yes.** Refuses unknown keys with 400. Critical because `status` is admin-only and we don't want an owner to ever PATCH it through /me. `.strict()` makes the gate impossible to bypass. |
| Owner email = business email at signup, or separate fields? | **Same at signup; PATCH-separable.** Owners often signing up don't have a distinct business email yet. Mirroring owner email is the right MVP; PATCH /me changes it later (already wired). |
| Status flip cascade to staff scope rows? | **No cascade.** Suspending a business shouldn't revoke staff invitations. Same posture as suspending a landlord wouldn't auto-revoke property_manager_scopes. Admin can revoke staff individually via the (future) business_users routes. |
| GET /me filter: include archived or not? | **Exclude.** Status='active' or 'suspended' only. Archived businesses 404 — the portal renders a generic "your business is archived, contact support" surface based on the 404, not based on a special data shape. |
| List route pagination? | **Skip for now.** LIMIT 200 cap. When business count crosses 200, add cursor-based pagination — but that's a downstream hygiene call, not MVP. |

## Verification

- `npx tsc --noEmit` clean on apps/api.
- `npm test`: **2822 / 150 / 0 failures**, 90.45s.
  Delta: +31 cases / +1 file = exactly the new test slice.
- Existing auth tests (auth.test.ts, authBusiness.test.ts,
  loginLockout, totp, etc.) all still pass — no auth-side
  regression.
- The signup happy-path test verifies the JWT shape end-
  to-end; the owner can drop the token into any downstream
  request immediately without a separate /login call.

### Bugs caught during test authoring

None. Routes were clean. Author's own test-side bug
(text vs uuid parameter coercion) was caught + fixed in
the S454 slice already; same pattern lifted into this
file's seeders correctly.

## Phase 1a.1 — progress

- ✅ S453 — DB migrations
- ✅ S454 — shared enum exports + auth scope dispatch
- ✅ **S455 — businesses CRUD (this session)**
- ⏳ S456 — business_users (staff invitation flow) +
  business_customers CRUD
- ⏳ S457 — Portal scaffold (`apps/business` Vite app,
  port 3012)
- ⏳ S458 — Smoke walk + handoff polish

Phase 1a.1 is ~65% by effort after S455.

## What S456 should target

**Recommended: `routes/businessUsers.ts` + `routes/business
Customers.ts` as one session.**

`routes/businessUsers.ts`:
- `POST /api/business-users/invite` — owner invites a staff
  member by email + staff_role + permissions. Creates an
  invitation (status='invited') + sends an email with an
  accept token. Same shape as the
  /api/sublease-invitations precedent.
- `POST /api/business-users/:token/accept` — invitee
  accepts; creates the users row with
  `role='business_staff'` if email is new, sets scope
  row to status='active'.
- `GET /api/business-users` — owner lists their staff.
- `PATCH /api/business-users/:id` — owner updates a
  staff member's role / permissions.
- `POST /api/business-users/:id/revoke` — owner revokes
  (sets status='revoked' so the S454 login gate denies
  future logins).

`routes/businessCustomers.ts`:
- Standard CRUD (POST / GET / GET /:id / PATCH / DELETE-or-
  archive). Address + lat/lon nullable (geocoder lands in
  Phase 1a.2).

Should land in ~40-50 cases total; one session.

**Alternatives:**
- Split into two sessions if context tightens. business_
  users is the more delicate one (invitation flow + email);
  customers is mechanical CRUD.
- Skip ahead to the portal scaffold so Nic can see UI early
  — but the staff invitation flow is the
  first-time-thing-an-owner-does-after-signup; it should
  exist before the portal demo.

## Items uncommitted in tree (not from this session)

Unchanged from S453/S454: state-law batches + ingest
scripts + .env.example Checkr block + everything from
S453-S455.

A natural commit boundary now: **all of Phase 1a.1
backend work** (S453 schema + S454 auth wiring + S455
CRUD + this handoff) is one logical chunk. State-law and
.env.example remain separate decisions.

---

End of S455 handoff. **businesses CRUD shipped — 5
endpoints, owner self-signup is a single transaction
that lands the new owner with a JWT pointed at the
freshly-created business. 31 cases pinning every gate
+ branch (ToS / password / disposable / case-insensitive
duplicate / cross-role email collision / strict schema /
COALESCE preservation / cross-owner isolation / admin
list scoping / status enum / 404 on unknown / 403 on
non-admin).**

2822 tests / 150 files / 0 failures.

**Phase 1a.1 is ~65% done.** S456 covers business_users
(staff invitations) + business_customers (customer roster
CRUD). S457 ports the portal shell into `apps/business`.

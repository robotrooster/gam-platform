# Session 456 — closed

## Theme

**Phase 1a.1 continuation. business_users staff invitation
flow + scope CRUD. One migration (invitation table), one
new email sender (`emailBusinessInvitation`), one route file
(6 endpoints), 32 cases pinning the full lifecycle (invite →
preview → accept → list → update → revoke).**

Suite at S455 close: 2822 / 150.
Suite at S456 close: **2854 / 151 / 0 failures**, 94.56s.

Zero tsc regressions.

## What shipped

### Migration

**`20260612130000_business_user_invitations.sql`**
- `business_user_invitations` table mirroring the
  sublessee_invitations (S247) pattern. Columns: id,
  business_id (CASCADE), invited_by_user_id, token (UNIQUE),
  email, staff_role (CHECK matches BUSINESS_STAFF_ROLES),
  permissions jsonb, status (sent/accepted/expired/cancelled),
  expires_at, accepted_user_id (FK users), accepted_at,
  cancelled_at, timestamps + updated_at trigger.
- Audit CHECK: `status='accepted'` rows MUST carry
  `accepted_user_id` + `accepted_at`. Caught my own test seed
  bug during authoring (initial seed used null on both fields).
- Indexes: token lookup; per-business pending list (partial on
  `status='sent'`).

### New email sender — `services/email.ts`

**`emailBusinessInvitation`** — third sibling to
`emailInvitation` (landlord workers) and `emailPmInvitation`
(PM company staff). Same overall shape but distinct copy:
"<inviter> invited you to join <business> as a <role>."
- `category: 'business_invitation'` for email_send_log
  failure-dashboard filtering.
- `landlordId: null` — business invitations scope to the
  business, not a landlord (same posture as PM invitations).
- Metadata carries `staff_role`, `business_id`, `business_name`
  for the email-log attribution.

### `routes/businessUsers.ts` — 6 endpoints

**`POST /api/business-users/invite`** (owner only)
- Body: `{ email, staffRole, permissions? }`.
- 12-char password not required (the invitee chooses it on
  accept).
- Disposable-domain block (S417 fan-out).
- Pre-flight 409s: existing active/invited staff with that
  email, OR existing open invitation (no spam-send).
- Inserts invitation with 24-hour TTL; fires fire-and-forget
  email (rejection routed through `.catch()` so it logs
  cleanly without breaking the request).
- Returns 201 with `{ id, email, staffRole, expiresAt }`.

**`GET /api/business-users/invitations/:token`** (PUBLIC)
- Preview endpoint for the invitee's accept page. Returns
  `business_name`, `inviter_name`, `email`, `staff_role`,
  `expires_at`. Does NOT leak owner email or user ids.
- 404 unknown token, 409 already-accepted/cancelled, 410
  expired.

**`POST /api/business-users/invitations/:token/accept`** (PUBLIC)
- Body: `{ firstName, lastName, password, phone? }`.
- 12-char password min (matches /register).
- Transactional: creates users row (role='business_staff',
  email_verified=TRUE per the invitation-implies-verification
  precedent, ToS stamps both), creates business_users scope row
  pointing at the invited business, flips invitation row to
  'accepted' with accepted_user_id + accepted_at.
- Returns 201 + JWT carrying businessId + staffRole so the new
  staff member lands directly in the business portal.
- 409 if email collides with an existing user (sublease_
  invitations precedent — "ask the owner to add you directly
  from the staff list" hint).

**`GET /api/business-users`** (owner)
- Returns `{ staff, pendingInvites }` — current scope rows
  (joined with users for name/email) + non-expired open
  invitations.
- Cross-business isolation pinned: owner A's list never shows
  owner B's staff.

**`PATCH /api/business-users/:id`** (owner)
- Body: `{ staffRole?, permissions? }`. Strict zod schema
  refuses unknown keys (`status` cannot be changed here —
  only via /revoke).
- COALESCE-preserves-omitted pattern.
- Cross-business: 404 if the staff row belongs to a different
  business.

**`POST /api/business-users/:id/revoke`** (owner)
- Flips `status='revoked'` + stamps `revoked_at`. Filtered
  to only act on non-revoked rows so double-revoke 404s
  (avoids leaking "already revoked" as a distinct response).
- Pinned: revoked staff are then denied login by the S454 gate
  (the `getScopeForUser` query filters `status='active'`).

### Mounting

`apps/api/src/index.ts` — `app.use('/api/business-users',
businessUsersRouter)`. Mounted alphabetically next to the
businesses router.

### Test-infra

`apps/api/src/test/dbHelpers.ts:cleanupAllSchema` — added
`DELETE FROM business_user_invitations` BEFORE the
businesses delete. Pre-empts the same FK-trap pattern that
surfaced 3x during the bug sweep (the invitation's
invited_by_user_id + accepted_user_id both FK users with no
ON DELETE).

### Tests — `routes/businessUsers.test.ts` (NEW, 32 cases)

- **POST /invite (9)**: happy + email mock fires + non-owner
  403 + owner-no-business 404 + invalid staffRole 400 +
  disposable email 400 + duplicate open invitation 409 +
  email already on team 409 + email-send failure does NOT
  fail the API + 401
- **GET preview (4)**: happy + 404 + 409 accepted + 410 expired
- **POST accept (7)**: happy w/ full state flip + missing field
  400 + password min 400 + 404 unknown + 409 accepted + 410
  expired + 409 email collision
- **GET list (4)**: returns staff + pending invitations +
  cross-business isolation + expired invites excluded +
  non-owner 403
- **PATCH (4)**: happy + empty 400 + strict-schema unknown 400
  + cross-business 404
- **POST revoke (4)**: happy + already revoked 404 + cross-
  business 404 + revoked staff state pinned for downstream
  auth gate

## Items shipped

```
apps/api/src/db/migrations/
  20260612130000_business_user_invitations.sql
apps/api/src/routes/
  businessUsers.ts                          (NEW — 6 endpoints, ~330 lines)
  businessUsers.test.ts                     (NEW — 32 cases)
apps/api/src/services/
  email.ts                                  (+ emailBusinessInvitation function)
apps/api/src/test/
  dbHelpers.ts                              (+1 line: invitation cleanup)
apps/api/src/
  index.ts                                  (+2 lines: import + mount)
```

## Decisions made during build

| Question | Decision |
|---|---|
| `business_users.status='invited'` vs separate invitation table? | **Separate table.** `business_users.user_id` is NOT NULL, so an 'invited' row can't exist before the users row. Mirrors sublessee_invitations precedent — separate table holds the token + email until accept creates the user. The 'invited' status value on business_users stays for a future flow: in-app invitation of an EXISTING user (where user_id is known). |
| New email function vs extending emailInvitation? | **New function.** emailInvitation is typed for `LandlordAssignableRole`. Adding a union would force every caller to know about business staff. Cleaner to have three sibling functions (landlord workers / PM staff / business staff) with shared scaffolding (`base()`, `h()`, `p()`, `btn()`) and distinct copy. |
| email-send rejection: `void` + try/catch or `.then().catch()`? | **`.catch()`.** Caught my own test bug — `void` swallows synchronous parts but NOT async rejection, which becomes an unhandled rejection vitest reports as an "Error". Adding `.catch()` on the promise routes the async rejection through pino without breaking the API call. |
| 24-hour TTL on invitations | **Match emailInvitation copy ("expires in 24 hours") and emailPmInvitation precedent.** Long enough to survive a spam folder; short enough that abandoned invitations don't fill the table indefinitely. Resend flow (when added) would re-mint the token. |
| Email collision on accept: 409 or auto-link? | **409 with hint.** Auto-linking an existing user (e.g., a tenant) to a new business_staff role would silently change their primary role + would skip the staff-portal onboarding. Refuse the accept; owner adds them via the future in-app-invite-existing-user path. Same posture as sublease_invitations. |
| Double-revoke: 200 (idempotent) or 404 (deliberate)? | **404.** Idempotent 200 leaks "already revoked" — an attacker could enumerate which scope-ids exist on a business. 404 hides whether the id is unknown vs revoked. Owner-side, double-clicking the revoke button shows a refresh-needed message; that's fine UX. |

## Verification

- `npx tsc --noEmit` clean on apps/api.
- `npm test`: **2854 / 151 / 0 failures**, 94.56s. Suite went
  from 2822 → 2854 (+32 = exactly the new test cases).
- All prior auth tests (auth.test.ts, authBusiness.test.ts,
  loginLockout, totp, etc.) still pass — the new invitation
  table + new email function are additive.

### Bugs caught during test authoring

1. **Audit CHECK violation in test seed** — the
   `business_user_invitations_accepted_audit` constraint
   requires accepted_user_id + accepted_at when
   status='accepted'. Initial seed used null on both;
   migration's CHECK rejected. Fixed the seed helper to
   stamp both fields when seeding accepted-state rows.
   The CHECK itself is correct + load-bearing (prevents
   orphaned accepted rows in production).

2. **Unhandled async rejection** from `void
   emailBusinessInvitation(...)`. `void` swallows
   sync-throws but not async rejections. Re-wrote with
   `.catch()` chain so the rejection flows through pino
   without breaking the API.

## Phase 1a.1 — progress

- ✅ S453 — DB migrations (4)
- ✅ S454 — shared enum exports + auth scope dispatch
- ✅ S455 — businesses CRUD
- ✅ **S456 — business_users invitation + CRUD (this session)**
- ⏳ S457 — business_customers CRUD
- ⏳ S458 — Portal scaffold (`apps/business`, port 3012)
- ⏳ S459 — Smoke walk

Phase 1a.1 is ~80% by effort after S456. business_customers
is the simplest of the remaining routes (no invitation flow,
no email, mechanical CRUD).

## What S457 should target

**Recommended: `routes/businessCustomers.ts`** — standard CRUD
for the business's customer roster.

Endpoints:
- `POST /api/business-customers` (owner) — create
- `GET /api/business-customers` (owner) — list, with
  pagination/filter on status
- `GET /api/business-customers/:id` (owner) — read
- `PATCH /api/business-customers/:id` (owner) — update
- `POST /api/business-customers/:id/archive` (owner) —
  flip status

Tests: happy + cross-business isolation + status filter +
CHECK enforcement on customer_type=business requiring
company_name + lat/lon nullable + archive idempotency.
~20 cases.

After S457, S458 starts the portal scaffold and S459 is a
smoke walk.

**Alternatives:**
- Skip ahead to portal scaffold — but customers can't be
  CRUD'd in the portal without this route file existing.

## Items uncommitted in tree (not from this session)

Unchanged from prior handoffs: state-law batches + ingest
scripts + .env.example Checkr block + everything from S453-
S456.

---

End of S456 handoff. **business_users invitation + scope
CRUD shipped — 6 endpoints, dedicated invitation table,
new email sender, 32 cases pinning the full lifecycle.**

2854 tests / 151 files / 0 failures.

**Phase 1a.1 is ~80% by effort.** S457 covers business_
customers (mechanical CRUD); S458 ports the portal shell.

# Session 457 — closed

## Theme

**Phase 1a.1 continuation. `routes/businessCustomers.ts` —
mechanical customer-roster CRUD for the business. 5 endpoints,
28 cases. Owner-only scoping for MVP; staff access (manager /
dispatcher can edit, driver read-only) deferred to a future
permissions session, flagged in this handoff.**

Suite at S456 close: 2854 / 151.
Suite at S457 close: **2882 / 152 / 0 failures**, 102.77s.

Zero tsc regressions. Zero production bugs caught.

## What shipped

### `routes/businessCustomers.ts` — 5 endpoints

All five require `business_owner` role + an active business
on the calling user. Helper `requireOwnerBusinessId(req)`
centralizes the gate (same shape used in businessUsers.ts).

**`POST /api/business-customers`** — create
- Body: customerType, companyName (required when type=business),
  firstName, lastName, email (optional), phone (optional),
  address (street1/city/state/zip required, street2 optional),
  notes (optional).
- App-layer guard mirrors the DB CHECK: type='business' without
  companyName returns clean 400 instead of a 500 from the CHECK
  constraint violation.
- Individual customers with companyName supplied → companyName
  is dropped (sanitized to NULL) so the row matches the CHECK.
- Returns 201 + full row. lat/lon stay null until the Phase 1a.2
  geocoder populates them.

**`GET /api/business-customers`** — list
- Defaults to `status='active'`. Explicit `?status=archived` for
  the archive view.
- `?q=<term>` does ILIKE match against first_name, last_name,
  company_name, email. Case-insensitive.
- `?limit=<n>` caps result count (default 100, max 500).
- Cross-business isolation: only the owner's own business rows
  return.

**`GET /api/business-customers/:id`** — read one
- Joined query filters `business_id` so another owner's row 404s
  (no leak of "exists but not yours").

**`PATCH /api/business-customers/:id`** — update
- Strict zod schema — refuses unknown keys (status can't be
  flipped through here; that's the archive route).
- COALESCE-preserves-omitted pattern.
- **Customer-type-change guard**: changing customerType TO
  'business' on a row currently without companyName returns
  400 with the explicit instruction. Two branches handled:
  PATCH supplies `companyName: null` explicitly OR omits it
  entirely (in which case we read the current row to check).
- Cross-business 404.

**`POST /api/business-customers/:id/archive`** — archive
- Flips `status='archived'` + stamps `archived_at`. Filter
  excludes already-archived rows so the second archive call
  404s (avoids leaking "already archived" as a distinct response,
  same posture as the S456 revoke endpoint).

### Mounting + cleanup

- `apps/api/src/index.ts` — `app.use('/api/business-customers',
  businessCustomersRouter)`. Mounted next to business-users.
- No cleanupAllSchema change needed — business_customers
  CASCADEs on businesses delete, so the existing
  `DELETE FROM businesses` clears them transitively.

### Tests — `routes/businessCustomers.test.ts` (NEW, 28 cases)

- **POST (9)**: happy individual w/ null lat-lon, happy business
  w/ company_name, business-without-companyName 400, individual
  drops companyName if supplied, missing street1 400, invalid
  email 400, email nullable, non-owner 403, no auth 401
- **GET list (6)**: defaults to active, ?status=archived, ?q
  matches name, ?q is case-insensitive, cross-business isolation,
  ?limit cap
- **GET /:id (3)**: happy, cross-business 404, unknown id 404
- **PATCH (7)**: multi-field, COALESCE preserves, empty body
  400, strict-schema unknown 400, customerType-to-business
  without companyName 400, customerType-to-business with
  companyName works, cross-business 404
- **POST archive (3)**: happy + stamp, already archived 404,
  cross-business 404

## Items shipped

```
apps/api/src/routes/
  businessCustomers.ts            (NEW — 5 endpoints, ~220 lines)
  businessCustomers.test.ts       (NEW — 28 cases)
apps/api/src/
  index.ts                        (+2 lines: import + mount)
```

## Decisions made during build

| Question | Decision |
|---|---|
| Staff access in S457? | **No — owner-only for MVP.** Staff scoping (manager+dispatcher+office can edit; driver gets read-only on assigned customers) requires the per-staff-role permission framework that isn't fully built. Flagged for a future session. Portal smoke walk (S459) only validates the entity model; staff access doesn't block that. |
| App-layer guard duplicating the DB CHECK? | **Yes.** Without it, a `customerType='business'` + missing `companyName` produces a 500 (constraint violation surfaced as raw PG error). The app-layer check returns 400 with a clear error message + zero noise in the logs. CHECK stays as a defense-in-depth guard. |
| customerType-change PATCH guard (TWO branches) | **Both branches handled.** Owner might PATCH `{ customerType: 'business', companyName: null }` (explicit null) OR just `{ customerType: 'business' }` (relying on the existing row's company_name). Second branch reads the current row to decide; first branch is rejected by the zod-checked `=== null` test before the DB hit. |
| Default list filter | **status='active'.** Archived rows clutter the most-common view. Owners click "View archive" in the portal to flip to `?status=archived`. |
| Pagination shape | **`?limit` cap only — no cursor.** Pages of 100 are fine for MVP; cursor-based pagination lands when business customer counts cross ~500. Same posture as the S455 admin businesses list. |
| Archive vs hard delete | **Archive.** Customers can have downstream history (appointments, routes, billing in Phase 1a.2-1a.3); hard delete breaks audit + statistics. Owners "delete" via archive. Re-activation flow isn't built — currently one-way. Real "delete" stays as admin-only DB op for now. |

## Verification

- `npx tsc --noEmit` clean on apps/api.
- `npm test`: **2882 / 152 / 0 failures**, 102.77s. Suite went
  from 2854 → 2882 (+28 = exactly the new test cases).
- Prior business-side tests (businesses, businessUsers, auth-
  Business) still pass — additive changes only.

### Bugs caught during test authoring

None. Author's own tsc bug (used `{ rows: [row] }` destructure
on the `query<T>` helper that already returns rows directly)
was caught by tsc + fixed before tests ran.

## Phase 1a.1 — progress

- ✅ S453 — DB migrations (4)
- ✅ S454 — shared enum exports + auth scope dispatch
- ✅ S455 — businesses CRUD
- ✅ S456 — business_users invitation + CRUD
- ✅ **S457 — business_customers CRUD (this session)**
- ⏳ S458 — Portal scaffold (`apps/business`, port 3012)
- ⏳ S459 — Smoke walk + handoff polish

Phase 1a.1 is ~90% by effort. All API surface is in. Portal
scaffold + smoke walk close the phase.

## What S458 should target

**Recommended: portal scaffold for `apps/business`.**
Mirror the apps/landlord shell:

- Vite + React + TypeScript scaffold (copy apps/landlord
  package.json + vite.config + tsconfig)
- Layout component with gold/dark theme + nav for the four
  business sections (Dashboard / Customers / Staff /
  Settings)
- AuthContext consuming `/api/auth/login` + storing token in
  the same shape landlord portal uses
- Protected route wrapper
- Five page stubs:
  - `/login` — credential form, calls POST /api/auth/login
    (no special business-side endpoint; existing /login
    works for business_owner + business_staff per S454)
  - `/signup` — calls POST /api/businesses (owner self-signup)
  - `/dashboard` — placeholder with business name + staff
    count + customer count (read from /me + /business-users
    + /business-customers)
  - `/customers` — list + create form + edit modal
  - `/staff` — list of staff + pending invitations + invite
    form + revoke button

Port: 3012. dev.sh integration for the new app.

Tests: portal smoke (Vite build succeeds, login form renders,
auth context wires correctly). ~10-15 cases.

After S458, S459 walks Nic through the live portal end-to-end
to validate the entity model.

**Alternatives:**
- Build the customer-CRUD UI as a first slice + iterate the
  rest later. Same shape, smaller per-session scope.
- Stop API work + pivot. Phase 1a.1 has shipped the entire
  business-platform foundation; pausing for review before
  building UI is a legitimate product call.

## Pending product calls for S458+

These come up once we're building UI:

1. **Brand name for the business portal** — landlord portal
   says "GAM Landlord Portal"; what's the business portal
   called? Suggestions: "GAM Operations" / "GAM for Business" /
   "GAM Services Hub." Nic call.
2. **Default dashboard widgets** — pinned customer count,
   pending invitations, "no routes yet" coming-soon panel?
3. **Empty-state copy** for portals with no customers / no
   staff. Mostly UX.

These are S458 UI calls, not S457 API calls. Park.

---

End of S457 handoff. **business_customers CRUD shipped — 5
endpoints (POST/GET/GET-by-id/PATCH/archive), 28 cases
pinning happy + every gate + every isolation boundary +
both branches of the customerType-change guard.**

2882 tests / 152 files / 0 failures.

**Phase 1a.1 API surface is COMPLETE.** S458 builds the
portal shell; S459 smoke-walks. Total Phase 1a.1: ~5
sessions, on the estimate from S453 planning.

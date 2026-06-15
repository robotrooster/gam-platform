# Session 453 — closed

## Theme

**First session of the new feature arc. Bug sweep parked at
2777/148/0; we pivoted to the feature build pipeline. Nic gave
me a list of 5 features and asked me to order them; we locked
the order; then opened **Feature 1 (Route optimization engine)**
because his trash company is gated on it (concrete prospect
that becomes a customer the day routing ships).**

**The scope expanded mid-planning** when Nic clarified that
ALL businesses operating in GAM should get a portal like
landlords do — so route optimization is now ONE feature inside
a broader **service-business platform**. We split Phase 1a
into three sub-phases:

- **Phase 1a.1**: `businesses` entity + portal shell ← THIS SESSION
- **Phase 1a.2**: Appointments primitive + UI
- **Phase 1a.3**: vroom integration + trash-routing surface

Phase 1a.1 database foundation: **4 migrations applied**
(role enum extension + businesses + business_users +
business_customers). Suite + tsc green.

Suite at S452 close: 2777 / 148 files (assumed — S452 was a
separate agent-platform / state-law arc).
Suite at S453 close: **2780 / 148 / 0 failures**, 84s.

Zero tsc regressions.

## Feature list — full set (Nic-locked at S453 planning)

Ordered for build:

1. **Route optimization engine** — trash company onboarding gate
2. **Property Intelligence frontend** — broader landlord lead-gen
   (backend already exists: `gam_properties` DB, 3.4M AZ parcels)
3. **Landlord website hosting + public booking** — supply for
   Listings + landlord acquisition
4. **FlexCredit (Esusu white-label rent reporting)** — tenant
   retention; bounded scope (vendor integration)
5. **Listings portal (Zillow + MLS replacement)** — needs supply
   from #3 + data from #2; biggest ambition

## Planning locks from this session

| Question | Decision |
|---|---|
| How does the trash company live in the data model? | **Generic `businesses` entity, not a landlord shoehorn.** Trash is one of many service business types. New top-level entity mirroring landlords' relationship to the platform. |
| VRP solver choice | **vroom** — pure C++ open-source VRP solver, MIT, self-hosted, MIT license, no Google dependency. Same route quality as OR-Tools for our needs, simpler integration. |
| Scaffold-first or trash-first? | **Scaffold-first.** Build the generic businesses platform; trash company is the first validated customer on it, not the only customer. Worth ~3-5 extra sessions upfront to avoid a refactor when business #2 onboards. |
| Two user roles (business_owner + business_staff) or one (business_user with role differentiation)? | **Two roles** — mirrors the landlord vs property_manager precedent. Cleaner JWT auth dispatch + portal entry logic. |
| business_type enum starting set | trash_hauling / maintenance_crew / mobile_rental / equipment_rental / other (catch-all so onboarding isn't blocked on classification debates) |
| staff_role enum | manager / dispatcher / driver / office (operational positions for the trash-routing use case; expansive enough that other businesses fit) |
| lat/lon required at customer create? | **Nullable until Phase 1a.2** lands the geocoder. Backfill is a one-call-per-customer post-insert; staying nullable lets the table seed before the geocoder exists. |
| business_customers customer_type | individual / business (with `business_customers_business_name_required` CHECK forcing company_name when type=business — B2B customers like strip-mall property mgrs have a real company name, individuals don't) |

## Memory updates from this session

- `project_in_house_everything.md` — **new memory.** 5 allowed
  infrastructure exceptions: Stripe, Resend, Checkr, Esusu, RDAC.
  All other features built in-house. Open-source libs running
  on GAM servers count as in-house.
- `project_checkr_billing_model.md` — **new memory.** Platform
  bills GAM per check; GAM upcharges landlord/tenant downstream.
- `project_state_law_kb.md` already existed; not edited.
- CLAUDE.md — **FlexCredit description rewritten.** Was wrongly
  described as "Third-party Lender referral with markup" (CLAUDE.md
  fabricated this from the word "credit"); actual product is
  **Esusu white-label rent-payment credit reporting**. Credit
  lines / lending deferred until GAM acquires a bank charter.
- CLAUDE.md — **Collections partner named: RDAC.** Was the
  un-named "Collections Partner" in the S305 SLA-not-loan
  framing.

## What shipped

### Migrations (4 applied)

```
apps/api/src/db/migrations/
  20260612120000_users_role_add_business.sql
  20260612120100_businesses_table.sql
  20260612120200_business_users_table.sql
  20260612120300_business_customers_table.sql
```

**1. `20260612120000_users_role_add_business.sql`**
Extends `users_role_check` with `business_owner` + `business_staff`.
Required first so subsequent migrations can FK users for the
businesses table.

**2. `20260612120100_businesses_table.sql`**
- `id`, `owner_user_id` (FK users), `name`, `business_type` (CHECK
  enum), `email`, `phone`, full address columns, `ein`,
  `stripe_connect_account_id`, `connect_payouts_enabled`,
  `connect_details_submitted` (mirrors users' Connect onboarding
  state for future S113 destination-charge support), `status`,
  `notes`, timestamps + `update_updated_at` trigger.
- Indexes: owner lookup; active-by-type filter (partial index).

**3. `20260612120200_business_users_table.sql`**
- Staff scope analog of `property_manager_scopes`.
- `business_id` (CASCADE), `user_id`, `staff_role` (CHECK enum:
  manager / dispatcher / driver / office), `permissions` jsonb
  (heterogeneous shape so future role-specific sub-perms add
  without schema changes), `status` (active / invited / revoked),
  invited_at / accepted_at / revoked_at audit columns, UNIQUE
  (business_id, user_id) so one user can't double-scope into the
  same business.
- Indexes: user lookup; per-business role lookup (both partial on
  status='active').

**4. `20260612120300_business_customers_table.sql`**
- Customer roster per business.
- Distinct from `tenants` (residential GAM platform) and
  `pos_customers` (POS-merchant credit accounts under a landlord).
- `customer_type` (individual / business), with `company_name`
  required for type='business' via CHECK.
- `lat`/`lon` nullable until Phase 1a.2 geocoder lands.
- Optional `user_id` link for the future "customer logs in to see
  their own service history" surface.
- Indexes: per-business roster (active), email lookup (lower'd,
  partial), geocoded-customers filter (partial — feeds the route
  generation engine in Phase 1a.3).

### Test-infra

- `apps/api/src/test/dbHelpers.ts` — added
  `DELETE FROM businesses` to `cleanupAllSchema` BEFORE the users
  delete (businesses.owner_user_id + business_users.user_id both
  FK users with no ON DELETE; cascade handles business_users +
  business_customers cleanup). Pre-empts the same trap that
  surfaced 3x in the bug sweep (flexpay_advances, flex_charge,
  disbursements).

## Verification

- 4 migrations applied via `npm run migrate`, no errors.
- `schema.sql` regenerated by the runner (now 12,592 lines, up
  from 12,434).
- `npx tsc --noEmit` clean on apps/api.
- `npm test`: **2780 tests across 148 files, 0 failures**, 84s.
  Suite stayed green despite the schema additions (no consumers
  yet — code arrives in S454+).

## Other items in the tree (NOT from this session)

Worth knowing what's uncommitted alongside my work:

```
?? apps/api/src/db/genStateLawSeed.ts
?? apps/api/src/db/ingestNvStateLaw.ts
?? apps/api/src/db/migrations/20260611120000_nv_landlord_tenant_law_seed.sql
?? apps/api/src/db/migrations/20260611130000_nv_law_commercial_and_rv.sql
?? apps/api/src/db/migrations/20260611140000_state_law_batch1.sql
?? apps/api/src/db/migrations/20260611150000_state_law_batch2.sql
?? apps/api/src/db/migrations/20260611160000_state_law_batch3.sql
?? apps/api/src/db/migrations/20260611170000_state_law_batch4.sql
?? apps/api/src/db/migrations/20260611180000_state_law_batch5.sql
M  .env.example                       (Checkr block from earlier today)
```

The state-law batch files are from the parallel agent-platform /
S452 arc — appears to have been worked on in another window.
Both sets of migrations are now applied to the local DB (the
runner picked them up before mine).

When committing my work, Nic should decide:
1. Commit the businesses-arc migrations + cleanupAllSchema edit
   as one commit ("S453: businesses entity scaffold")
2. Either commit OR set aside the state-law work depending on
   whether it's ready
3. Decide on the Checkr `.env.example` block — keep as
   documentation or remove until Checkr live-wire actually
   happens

## Phase 1a.1 — what's left after this session

- **Shared package exports** — BUSINESS_TYPES + STAFF_ROLES +
  BUSINESS_STATUS + CUSTOMER_TYPE as `readonly` arrays with
  derived types (per CLAUDE.md "single source of truth for
  enums" rule).
- **`/api/auth/login` scope dispatch** — extend
  `routes/auth.ts:getScopeForUser` to resolve business scope
  for `business_staff` users. Owner's business_id resolves
  via the businesses table directly.
- **Routes** — CRUD for businesses, business_users (invite
  flow), business_customers.
- **Portal scaffold** — new `apps/business` Vite app on port
  3012, mirroring `apps/landlord`'s shell (Layout, AuthContext,
  protected routes).
- **Tests** — auth + CRUD + portal smoke.

## What S454 should target

**Recommended: shared package exports + auth scope dispatch.**
Smallest meaningful slice: the enum values get a single source
of truth in `packages/shared`, then `getScopeForUser` learns
the new role values. After that the routes have somewhere to
import their enums from and `/login` knows how to mint a JWT
for a business user. Single session, ~10-15 tests.

S455 then does the CRUD routes. S456 the portal scaffold.

**Alternatives:**
- Portal scaffold first, populate later (lets Nic see something
  visual sooner — but the API has to come before the portal
  actually does anything).
- Skip ahead to Phase 1a.2 (appointments) — would mean leaving
  Phase 1a.1 routes/portal as gaps. Not recommended.

---

End of S453 handoff. **Businesses entity scaffold landed: role
enum + 3 tables + cleanupAllSchema pre-emptively updated.
Database foundation ready for the API + portal work that
S454-S456 will deliver.**

2780 tests / 148 files / 0 failures. Suite stayed green through
the schema additions.

**Feature 1 (route optimization engine) is opened.** Phase 1a.1
is ~30% done by lines-of-effort (the database half lands faster
than the API + portal halves).

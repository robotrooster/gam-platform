# Permissions audit — Pass 1 (CORRECTED)

Date: May 1, 2026 (S62)
Scope: All 314 endpoints across apps/api/src/routes/ (28 files,
       excluding *.s*backup files).

NOTE: An earlier draft of this document (S62 first pass) was wrong about
most of its CRITICAL findings. The original draft missed that 22 of 28
route files apply `router.use(requireAuth)` at the file level, and
flagged dozens of endpoints as "no auth" when they were properly gated.
This document is the corrected version. The earlier draft is history-
archived in the S62 chat transcript only.

What this pass actually found, after correction: 2 SQL injection holes
(fixed in Batch A this session), 1 real scope-check hole on a financial
endpoint, 1 minor scope-check gap returning PII, and a handful of code-
smell items.

---

## Auth middleware vocabulary

From apps/api/src/middleware/auth.ts:

  requireAuth                   — verifies JWT, sets req.user
  requireRole(...roles)         — checks req.user existence + role membership
  requireAdmin                  — admin | super_admin
  requireLandlord               — admin | super_admin | landlord
  requireTenant                 — admin | super_admin | tenant
  requireLandlordAssignableRole — admin | super_admin | landlord | <role>
  requirePropertyManager / requireOnsiteManager / requireMaintenance /
    requireBookkeeper           — assignable wrappers

Inline-defined elsewhere:
  requireSuperAdmin (admin.ts:62) — should be promoted to shared file (L4)

---

## Router-level requireAuth coverage

Files with `<router>.use(requireAuth)` at file scope (22 files, all
endpoints in these files are authenticated):

  admin announcements books bulletin disbursements documents
  landlords leases maintenance notifications payments pos
  properties reports scopes stripe team tenants terminal
  units utility workTrade

Files WITHOUT router-level requireAuth (6 files):

  auth.ts             — register / login / register-prospect are
                        intentionally public; /me /refresh /me-PATCH
                        have per-route requireAuth. OK.
  background.ts       — /price /verify-address /suggest-address /webhook
                        intentionally public; rest have per-route
                        requireAuth or requireAuth+requireLandlord. OK.
  esign.ts            — per-route gating. /sign/:documentId, /pending,
                        /documents/:id, /files/:filename use requireAuth;
                        landlord-only routes use requireAuth+requireLandlord.
                        OK.
  fitness.ts          — uses local `auth` middleware per-route, plus
                        `adminAuth` on /admin/stats. OK (separate review
                        of fitness's own auth alias deferred).
  maintenance-portal.ts — every route has requireAuth. OK.
  webhooks.ts         — Stripe signature-verified, intentionally public. OK.

---

## CRITICAL — confirmed exploitable

### C1. SQL injection via req.query.unitId    [FIXED — Batch A, S62]
File:    apps/api/src/routes/maintenance.ts
Line:    15 (was)
Fix:     Parameterized via `params.push(req.query.unitId)`.

### C2. SQL injection via req.query.propertyId [FIXED — Batch A, S62]
File:    apps/api/src/routes/units.ts
Line:    18 (was)
Fix:     Parameterized via `params.push(req.query.propertyId)`.

### C4. SQL injection via req.query.date  [FIXED — Batch C, S62]
File:    apps/api/src/routes/admin.ts
Line:    64 (was) — GET /bulletin
Code:    `AND DATE(b.created_at) = '${date}'`
Risk:    Same shape as C1/C2. Surfaced during Batch C anchor recon.
         Would have shipped to prod undetected — original Pass 1 audit
         only sampled the first 20 lines of admin.ts.
Fix:     Parameterized via `params.push(date)`.

### C3. Missing scope check on unit economics
File:    apps/api/src/routes/units.ts
Line:    154 — GET /:id/economics
Code:    `const unit = await queryOne('SELECT * FROM units WHERE id = $1', [req.params.id])
          if (!unit) throw new AppError(404, 'Unit not found')
          [proceeds to query payments, maintenance costs, returns full
           financials — no landlord_id check]`
Risk:    Any authenticated user can pull lifetime financial data for any
         unit by UUID — collected revenue, maintenance spend, net rent,
         settled/failed payment counts. A tenant on one property can
         enumerate any other property's economics if they get a unit
         UUID (which appears in many other route responses).
Fix:     Add scope check immediately after the unit lookup, matching the
         pattern at units.ts:60 on GET /:id:
           if (req.user!.role !== 'admin' && req.user!.role !== 'super_admin'
               && unit.landlord_id !== req.user!.profileId) {
             throw new AppError(403, 'Forbidden')
           }

---

## HIGH

### H1. Missing scope check on unit availability  [FIXED — S62]
File:    apps/api/src/routes/units.ts
Line:    213 — GET /:id/availability
Decision: Front-counter staff (property_manager, onsite_manager,
          maintenance) need schedule access for RV/STR space coordination.
          Tenants and other landlords do not.
Fix:     Used new canAccessLandlordResource helper (see scope.ts section
         below). Allows admin, the unit's landlord, and any team member
         under that landlord. Blocks tenants and unrelated landlords.

### H2. req.user!.profileId interpolated into raw SQL strings  [FIXED — Batch C, S62]
Files:   disbursements.ts:11, documents.ts:10-11, utility.ts:10,
         maintenance.ts:17,19, units.ts:17
         (note: maintenance.ts:65 was a misread — it parameterizes
          via [req.params.id], not profileId. Not in scope.)
Fix:     All 7 sites parameterized via `params.push(req.user!.profileId)`.

### H3. Dev endpoints lack admin gate  [FIXED — Batch C, S62]
File:    apps/api/src/routes/background.ts
Lines:   522 (POST /dev-mock-webhook)
         552 (POST /dev-reset)
Fix:     Both gated with requireAdmin (after requireAuth).

---

## MEDIUM — confirm intent

These are public (no auth) and may be intentional. Each needs a yes/no.

  M1.  background.ts:113   GET /price                  — likely OK (signup page)
  M2.  background.ts:440   GET /verify-address         — likely OK (signup)
  M3.  background.ts:461   GET /suggest-address        — likely OK (signup)
  M4.  background.ts:485   POST /webhook/:providerName — OK (signature)
  M5.  announcements.ts:8  GET /                       — has router-level
                                                         requireAuth, NOT
                                                         actually public.
                                                         No-op finding.
  M6.  properties.ts:153   GET /listings               — publicPropertiesRouter, OK
  M7.  properties.ts:185   GET /listings/preview       — publicPropertiesRouter, OK
  M8.  properties.ts:280   POST /apply                 — publicPropertiesRouter, OK
  M9.  pos.ts:123          GET /items/:id/shelf-label  — for printable QR
                                                         codes; intent
                                                         confirm
  M10. scopes.ts:377-418   /invitations/:token/*       — token-gated, OK
  M11. tenants.ts:346,385  /accept-invite, /invite-info — token-gated,
                                                          verified OK
  M12. webhooks.ts:8       POST /stripe                — signature, OK
  M13. auth.ts:31,75,156   register/login/register-prospect — OK
  M14. workTrade.ts:84,105 GET /unit/:unitId, /:id     — should this be
                                                         tenant/landlord
                                                         scoped? confirm

Real questions for Nic: M9 (shelf-label intent) and M14 (work-trade
public read intent). Everything else resolved.

---

## LOW — observations

### L1. JWT shape verified clean
Regular landlords have landlordId=null in JWT, ID in profileId.
Team members have landlordId set. Only books.ts reads user.landlordId,
and it does so via `landlordScope()` with the correct
`user.landlordId || user.profileId` fallback. No drift.

### L2. fitness.ts uses local `auth` middleware alias
Verify in a future pass that it's equivalent to requireAuth.

### L3. requireSuperAdmin defined inline in admin.ts:62  [FIXED — Batch C, S62]
Promoted to middleware/auth.ts as exported function. Includes req.user
existence check (returns 401 if missing) so callers don't have to chain
requireAuth, though admin.ts currently does both at router level.
Inline definition removed. Redundant inline check at admin.ts:88-89
removed as dead code. admin.ts now imports requireSuperAdmin from
shared middleware.

### L4. requireLandlord without explicit requireAuth (style only)
Used solo in landlords.ts (13 sites), notifications.ts:66. Functionally
correct because requireRole checks req.user existence. Inconsistent vs
the `requireAuth, requireLandlord` chain elsewhere. Cosmetic.

---

## What this audit DID NOT cover

This was Pass 1 — route-level auth + role gating only.

NOT covered:
- Per-resource scope filtering on PATCH/POST/DELETE handlers (mostly
  uses `WHERE id=$1 AND landlord_id=$2` pattern in SQL — needs eyeball
  pass to confirm every write checks ownership).
- Cross-tenant data leakage in JOIN-heavy endpoints (e.g. does a
  tenants.ts GET return data scoped to the requester's lease only?).
- The 16a managed_by_user_id model: once that schema lands, every route
  filtering by landlord_id needs review for whether it should switch to
  managed_by_user_id (notifications, todos) or stay on owner_user_id
  (financial reads owner is allowed to see).
- Token-validation correctness on the public token-gated routes
  (invitations, accept-invite, invite-info).

These are Pass 2.

---

## Scope helpers — apps/api/src/middleware/scope.ts

Established S62 as the single source of truth for "can this user access
this landlord's resources" checks. Three helpers, three access tiers:

  canAccessLandlordResource(user, landlordId)
    Operational read/write. Admin, landlord, team members under that
    landlord. Used for /availability, schedule, maintenance coordination,
    front-counter unpaid invoices.

  canViewLandlordFinances(user, landlordId)
    Financial reads. Admin and the landlord only. NO team members.
    Used for /economics, reports, P&L. (16a will extend to add owner
    read-access on properties they own.)

  canManageLandlordResource(user, landlordId, allowedTeamRoles?)
    Write actions. Admin, landlord, optionally specific team roles.
    Defaults to all team roles. Used for resource modifications where
    only certain team members should be allowed (e.g. PM can edit units,
    maintenance cannot).

Bookkeeper access is books-only and handled separately via
landlordScope() in routes/books.ts. Bookkeeper does not match in any
of the above helpers.

Inline access checks (the `req.user!.role !== 'admin' &&
unit.landlord_id !== req.user!.profileId` pattern) predate these
helpers. They are not bugs — they correctly handle landlord-vs-admin
access — but they do not include team members. As Pass 2 touches each
file, retrofit inline checks to use the appropriate helper.

Existing inline check sites to retrofit (S62 inventory):
  - properties.ts:98          (canAccessLandlordResource — read)
  - units.ts:60               (canAccessLandlordResource — read)
  - units.ts:157              (canViewLandlordFinances — economics) [SHIPPED S62 as inline; retrofit later]
  - leases.ts:111             (canAccessLandlordResource — read)
  - 16a managed_by_user_id model will require a fourth helper
    canManageProperty(user, property) that checks managed_by, not
    landlord_id directly. Add when 16a schema lands.

---

## Fix-it sessions (proposed)

### Batch A: SQL injection holes [SHIPPED — S62]
  - C1 maintenance.ts:15 — parameterized
  - C2 units.ts:18       — parameterized

### Batch B: scope check on /economics [SHIPPED — S62]
  - C3 units.ts:154 — inline scope check (admin or landlord only)

### Batch B-extra: scope check on /availability [SHIPPED — S62]
  - H1 units.ts:213 — canAccessLandlordResource (allows team members)

### Batch C: hardening [SHIPPED — S62]
  - C4 admin.ts:64 — parameterized (NEW SQL injection found mid-batch)
  - H2 7 sites across 5 files (disbursements, documents, utility,
    maintenance, units) — parameterized via params.push()
  - H3 background.ts /dev-mock-webhook + /dev-reset — requireAdmin added
  - L3 requireSuperAdmin promoted to middleware/auth.ts as shared export.
    admin.ts inline definition removed. Redundant inline check at
    /bulletin/:id/reveal removed (dead code post-promotion).
  - L4 requireAuth+requireLandlord chain standardization NOT shipped.
    Cosmetic only. Defer to a future cleanup pass.

### Pass 2 (separate sessions)
  - Per-resource scope filtering on writes
  - JOIN-heavy read endpoints
  - Token-validation deep dive on public token routes
  - Re-audit after 16a managed_by_user_id schema lands

---

## Pass 3 — owner vs manager re-audit (S183, May 8 2026)

Scope: per DEFERRED 16a, audit whether owner read-only finance access
+ notifications/todos routed-to-managed_by_user_id_only is actually
implemented across consumer code, now that the schema (S60) and
allocation engine (S64+) landed.

### Method

1. Confirm `properties.owner_user_id` and `properties.managed_by_user_id`
   exist in schema and are populated.
2. Find every code path that reads either column, classify by use case
   (action gate / notification target / read filter).
3. Find every code path that decides "who gets this notification" or
   "what does this user see on their dashboard" and check whether it
   honors the manager pointer when divergent from the owner pointer.
4. Find every write path that lets a user mutate `managed_by_user_id`
   (and check whether it's gated to owner-only).

### Finding 1 — `managed_by_user_id` is functionally dead

The column exists in the schema as `NOT NULL FK → users(id)` (since
S60 migration). It is populated at `INSERT` in
`apps/api/src/routes/properties.ts:99` to default the same value as
`owner_user_id` (the landlord's user_id).

**There is no code path that ever sets it to a different value.**

- Zero `UPDATE properties SET managed_by_user_id = ...` statements
  in any route, service, job, or migration after the initial schema.
- Zero frontend surfaces that read or display either column.
- Zero API endpoints that mutate the column post-INSERT.

The "owner can toggle 'I want a PM to handle this' by changing the
managed_by_user_id pointer" capability described in DEFERRED 16a
was never built. Third-party property management is implemented via
a different pathway: `properties.pm_company_id` + `pm_staff` table
(S107-S112, S157).

### Finding 2 — Notifications uniformly route to OWNER, not manager

Every landlord-facing notification call site resolves the recipient
via `JOIN landlords l ON l.id = X.landlord_id JOIN users lu ON lu.id = l.user_id`,
never via `properties.managed_by_user_id`. Inventory of call sites:

| Notification | Resolution path | File / line |
|---|---|---|
| `routeMaintenanceNotification` (approval-required, emergency) | `landlords.user_id` | `services/notifications.ts:665` |
| `notifyLeaseExpiring` | `landlords.user_id` | `jobs/scheduler.ts:35` |
| `notifyRentCollected` | `landlords.user_id` | `routes/webhooks.ts:232` |
| `notifyLowStock` | `landlords.user_id` (per-landlord, not per-property) | `jobs/scheduler.ts:355` |

Under the current schema reality (Finding 1: managed_by_user_id ≡
owner_user_id always), this produces correct routing: owner == manager
== `landlords.user_id`. If the column ever diverged, owners would
receive maintenance approval requests for properties they don't manage
— exactly the spam DEFERRED 16a says to prevent. But since divergence
is unreachable in the current product, this is a latent bug, not a
live one.

### Finding 3 — `/api/landlords/me/todos` is owner-personalized by design

`GET /api/landlords/me/todos` in `routes/landlords.ts:282` filters by
`l.landlord_id = $1` (the requesting user's landlord profile id). It
does NOT distinguish "properties I own" vs "properties I manage."

The S131 author explicitly noted:
> stays requireLandlord — this is the OWNER's personalized
> dashboard. Team workers have their own dashboards under their
> portal. Opening this would also need the handler to swap profileId
> for resolveLandlordIdForUser, which isn't worth it for a private view.

This is a LIVE design decision that conflicts with DEFERRED 16a's
prescription "to-dos route to managed_by_user_id only." The S131
decision wins by recency + explicitness.

### Finding 4 — Owner read-only finance: correctly gated where surfaced

`finances.ts:71` gates the per-property P&L viewer with:

```ts
if (!isAdmin && p.owner_user_id !== userId && p.managed_by_user_id !== userId) {
  // 403
}
```

This is the only consumer that accepts EITHER pointer for read access.
Combined with Finding 1 (the two pointers are always equal), it
collapses to the legacy `landlords.user_id` check. No bug.

### Finding 5 — Bank account assignment is owner-gated (correct posture)

`properties.ts:121` and `:371` both check
`ba.user_id !== prop.owner_user_id` when assigning a bank account
to a property. Bank accounts can only belong to the property owner,
not a manager. This is the security-correct posture and would hold
even if managed_by_user_id ever diverged. No bug.

### Conclusion (REVISED post-audit)

The initial Pass 3 conclusion proposed dropping
`properties.managed_by_user_id` as dead. Nic corrected: the column
is the *correct* architecture for routing-to-responsible-party;
the bug is consumer code that never honored it. Owners shouldn't be
spammed with notifications for properties they've delegated to a
PM. The two third-party-vs-individual paths (`pm_company_id` for
companies + `managed_by_user_id` for individual delegation) coexist
and both feed a single "who's responsible for this property" answer.

The actual gap shape across consumers:

| Call site | Current routing | Should route to |
|---|---|---|
| `routeMaintenanceNotification` | Already responsible-party-aware via in-house PM scopes + pm_staff fan-out + owner-only-on-escalation | Pattern is correct; this is the reference shape |
| `notifyLeaseExpiring` (scheduler.ts:35) | Always landlord owner | Per-property responsible party |
| `notifyRentCollected` (webhooks.ts:232) | Always landlord owner | Per-property responsible party |
| `notifyLowStock` (scheduler.ts:355) | Per-landlord (landlord owner) | Per-property responsible party (POS items used at delegated properties → manager) |
| `/api/landlords/me/todos` | All properties under landlord profile | Properties where this user is the responsible party |

S131's explicit "owner-personalized" decision on `/me/todos` is
overridden by Nic's S183 direction: don't spam owners about
properties they've delegated. The recency-wins heuristic from the
initial Pass 3 conclusion was wrong here — product intent wins.

### S183 follow-on shipped (post-correction)

A `services/responsibleParty.ts` resolver is the canonical answer
for "who gets pinged about this property." Single source of truth
for the four call sites and the todos filter to consume. Built and
wired in the same session as this audit revision.

See SESSION_183_HANDOFF.md for the wiring detail.

---

## Pass 4 — maintenance fan-out audit (S185, May 8 2026)

Scope: verify `routeMaintenanceNotification` (notifications.ts:642)
is correctly behaved under the S183 responsible-party model.
Started as a parity check; surfaced two real routing bugs.

### Bug A — `maintTeam` query missing property/unit coverage filter

The maintenance worker + onsite manager fan-out was landlord-wide:

```sql
SELECT user_id FROM maintenance_worker_scopes WHERE landlord_id = $1
UNION
SELECT user_id FROM onsite_manager_scopes      WHERE landlord_id = $1
```

Both `maintenance_worker_scopes` and `onsite_manager_scopes` have
`property_ids` + `unit_ids` columns, and `maintenance_worker_scopes`
has `all_properties`. The query ignored all of them — any worker
under the landlord got paged for ANY property's maintenance,
including properties their scope didn't cover. Inconsistent with
the property_manager_scopes path nearby in the same function,
which DOES filter correctly.

**Fix:** added the same coverage predicate (all_properties OR
$property_id ∈ property_ids OR $unit_id ∈ unit_ids).
`onsite_manager_scopes` lacks `all_properties` per S80 schema; an
empty `property_ids+unit_ids` is treated as "all under landlord"
to preserve the original semantic.

### Bug B — owner's in-house team paged for properties delegated to a PM company

When a property had `pm_company_id IS NOT NULL`, the existing fan-
outs ran:
- `maintTeam` (owner's workers + onsite) — paged
- `pms` (owner's in-house property managers) — paged
- `pmCoStaff` (PM company staff) — also paged

This is exactly the S183 spam pattern: PM company is the responsible
party for that property, but owner's in-house team got the alert too.
Per Nic's "responsible parties only" framing, the in-house team
shouldn't be on call for properties handed off.

**Fix:** when `properties.pm_company_id IS NOT NULL`, suppress
`maintTeam` and `pms` entirely. `pmCoStaff` carries the load.

### Bug C — owner-escalation trigger considered only `maintTeam`

The owner-notification gate was:

```ts
if (isEmergency || overThreshold || maintTeam.length === 0) { ... }
```

Under Bug B's fix, `maintTeam` becomes empty by design when
delegated. That would trigger owner notification on every routine
maintenance request for delegated properties — same spam problem
in a different shape.

**Fix:** changed gate to consider both fan-outs:

```ts
const hasResponsibleParty = maintTeam.length > 0 || pmCoStaff.length > 0
if (isEmergency || overThreshold || !hasResponsibleParty) { ... }
```

Owner now escalates on emergency / over-threshold / nobody-on-call.
Routine pings under PM delegation go only to PM staff. Routine
pings on self-managed properties go only to in-house team.

### Out of scope (deferred for product input)

The original Pass 4 question — "should the individually-delegated
manager (`managed_by_user_id`) get distinct urgency tier from
other property_manager scope holders?" — is genuinely a product
question. Current behavior under the bug fixes above:

- Self-managed property: in-house property managers fan out
  uniformly. The primary (`managed_by_user_id`) gets the same
  pm_alert as other scope holders.
- PM-company-managed property: only PM company staff fan out.

Open question for Nic: should there be a "primary manager" tier
that gets stronger pings (e.g. SMS even on non-emergency) than
secondary scope holders? Currently no. Add only on Nic's call.

See SESSION_185_HANDOFF.md for the wiring detail.

---

## Pass 5 — full notification helper sweep (S186, May 8 2026)

Scope: comprehensive audit of every landlord-targeted notification
helper in `services/notifications.ts` against the S183
responsible-party model. S183 fixed 2 helpers (lease-expiring,
rent-collected); S185 fixed maintenance routing in 3 places. Pass 5
checks the rest.

### Method

1. Enumerate every exported notification helper that takes
   `landlordUserId`.
2. For each, find every call site outside `services/notifications.ts`.
3. Classify each call site:
   - **Per-property day-to-day** → must route through resolver
   - **Owner-financial** (payouts, bank account changes) → owner
     correctly stays in the loop, no fix needed
   - **Tenant-targeted** → not landlord-routing, out of scope

### Findings

| Call site | Helper | Classification | S186 fix |
|---|---|---|---|
| `tenants.ts:498` | `notifyTenantInviteAccepted` | per-property (onboarding) | wired through resolver |
| `entryRequests.ts:263` | `notifyEntryRequestResponded` | per-property (tenant interaction) | wired through resolver |
| `inspections.ts:356` | `notifyInspectionTenantSigned` | per-property (workflow) | wired through resolver |
| `inspections.ts:494` | `notifyInspectionFinalized` | per-property (workflow) | wired through resolver |
| `operationalNudges.ts:66` | `notifyInspectionScheduledReminder` | per-property (24h reminder) | wired through resolver |
| `webhooks.ts:411` | `notifyAchRetryScheduled` | rent-collection-operational | wired through resolver |
| `webhooks.ts:428` | `notifyAchRetriesExhausted` | rent-collection-operational | wired through resolver |
| `stripeConnect.ts:624` | `notifyConnectPayoutPaid` | owner-financial (payout to bank) | no change — correctly to owner |
| `stripeConnect.ts:634` | `notifyConnectPayoutFailed` | owner-financial | no change |
| `stripeConnect.ts:652` | `notifyPmCompanyPayoutPaid` | PM-company-financial | no change — correctly to PM company |
| `stripeConnect.ts:661` | `notifyPmCompanyPayoutFailed` | PM-company-financial | no change |
| `entryRequests.ts:116` | `notifyEntryRequestNew` | tenant-targeted | out of scope |
| `entryRequests.ts:340` | `notifyEntryRecorded` | tenant-targeted | out of scope |
| `credit.ts:709` | `notifyDisputeResolved` | disputing-party (could be tenant or landlord); takes `disputingUserId` not `landlordUserId` | out of scope |

### Conclusion

7 call sites had latent landlord-spray bugs (notifying owner
regardless of delegation). All seven now route through
`getPropertyResponsibleParty`. The S183/S184/S185/S186 thread is
now feature-complete on the routing side.

ACH retry / exhausted (#6 / #7) routed primary-only for consistency
with the rest. If a future product call wants owner-additional
escalation on persistent rent-collection failures, that would be a
separate "owner-financial-escalation" pattern layered on top.
Documented for future Nic input.

See SESSION_186_HANDOFF.md for the wiring detail.

---

End of audit (corrected).

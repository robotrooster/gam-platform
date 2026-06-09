# Session 107 Handoff

**Theme:** Audit + fix of `sendBulkNotification` (the suspect query
flagged in S106). Surfaced and fixed three drift bugs and one real
SQL injection. Surfaced a fourth bug (PM-coupled column reference in
`routeMaintenanceNotification`) but stopped per the CLAUDE.md PM
quarantine — needs your call.

## Bugs found and fixed

### `services/notifications.ts:sendBulkNotification` — three issues in one query

The query had:
```sql
SELECT ... FROM tenants t
JOIN units un ON un.tenant_id=t.id
WHERE un.landlord_id=$1 ${propertyId?`AND p.id='${propertyId}'`:''}
```

1. **`units.tenant_id` does not exist.** Column was dropped when the
   `lease_tenants` / `v_unit_occupancy` model landed (S26-ish). Query
   would throw on every invocation against real data.
2. **SQL injection.** `propertyId` (an HTTP body field) was
   string-interpolated directly into the SQL. Reachable from any
   authenticated landlord via `POST /api/notifications/bulk`. A
   malicious landlord could exfiltrate other landlords' data via
   `' OR '1'='1` or worse via `UNION SELECT`.
3. **`landlord_id` not threaded into createNotification.** Notification
   rows were inserted without the `landlord_id` attribution, so
   landlords couldn't filter "messages I sent" in the per-landlord
   email-failure dashboard.

**Fixes:**
- Switched the active-tenant lookup to go through `v_unit_occupancy`
  (consistent with the v_lease_active_tenants / primary-role pattern
  already established in S100 and S105)
- Parameterized the `propertyId` filter ($N placeholder, conditionally
  appended)
- Threaded `landlordId: o.landlordId` through to `createNotification`
  so the bulk notification rows carry the originating landlord

### `routes/notifications.ts` — defense-in-depth uuid validation

The route now rejects malformed propertyId with a 400 instead of
letting Postgres throw a 500. Pre-S107 a malformed (or
deliberately-malicious) propertyId reached the SQL layer; post-S107
it's caught by a regex format check at the route boundary.

### `services/notifications.ts:routeMaintenanceNotification` — same units.tenant_id bug

The `if (req.affects_multiple_units && req.affected_unit_ids?.length > 0)`
branch ran the same broken JOIN. Multi-unit maintenance notices would
have failed silently. Fixed using the same v_unit_occupancy pattern.

### `apps/api/src/db/seed.ts` — same units.tenant_id bug in demo payments seed

The "DEMO PAYMENTS" block in the seed script SELECTed via
`u.tenant_id IS NOT NULL`. Would have thrown on `npm run db:seed`,
blocking dev DB setup mid-script. Fixed by going through
v_unit_occupancy.

### `routes/leases.ts:148` — stale doc comment

The PATCH /:id header docblock claimed status transitions cascade to
"`units.tenant_id → NULL, status='vacant'`". The `units.tenant_id`
half is wrong (column doesn't exist; the actual handler doesn't touch
it). Comment corrected to reflect the v_unit_occupancy-derived
occupancy model.

## PM block — partial fix; pm_companies subsystem still owed

**Mid-session correction from Nic:** GAM has TWO distinct PM concepts.
I conflated them in the initial rewrite and then over-reached by
deleting documentation of the planned infrastructure. Corrected:

1. **Owner's in-house property managers** (built; `property_manager_scopes`
   table) — landlord's individual employees, similar to maintenance
   workers and onsite managers, with per-property scope arrays + jsonb
   permissions.
2. **Third-party PM companies** (PLANNED, NOT BUILT) —
   `pm_companies` (the org), `pm_staff` (its employees),
   `pm_fee_plans` (% / flat / floor / ceiling fee structure), plus
   the owner→PM-company pointer. Needs fee routing into the 16a
   allocation engine and an owner-visibility view of "PM cut vs net."

**What landed at S107 in routeMaintenanceNotification:**
- Removed `, l.pm_company_id` from the main SELECT (was throwing on
  the nonexistent column, killing the entire notification fan-out).
- Replaced the broken `pm_company_id ? queryOne(... pm_staff ...)`
  with a `query<...>` against **`property_manager_scopes`** —
  notifies the OWNER'S in-house PMs whose scope covers this
  property/unit.
- Loop over PMs (multiple can be scoped to one property), each
  notified.

**What's still owed when pm_companies is built:**
- Add a **parallel** pm_staff notification path on top of the
  property_manager_scopes lookup (both must coexist). The current
  in-line comment in the function flags this for the future
  build session.
- Owner→pm_company pointer column (probably `landlords.pm_company_id`)
  to feed the new lookup.
- Fee routing: when the allocation engine splits a tenant payment,
  the PM company's fee_plan needs to claim its cut before the
  owner's portion lands.
- Owner-side visibility: a view or endpoint showing "rent collected
  / PM company cut / your net" per property.

**Doc state corrected:** CLAUDE.md and `project_team_permissions_model`
memory both updated to clearly distinguish concept #1 vs #2.
Initial S107 rewrite of those docs (which incorrectly said
pm_companies was "dead concepts") has been reverted.

Verified: `routeMaintenanceNotification` runs with **0 captured
console.error output** against a seeded maintenance request — the
in-house PM notification path works end-to-end. The pm_company
notification path is a known gap, scoped for the future
pm_companies build session.

## Files touched

- `apps/api/src/services/notifications.ts` (sendBulkNotification rewrite + routeMaintenanceNotification multi-unit fix + PM-block rewrite to property_manager_scopes)
- `apps/api/src/routes/notifications.ts` (uuid validation)
- `apps/api/src/routes/leases.ts` (stale doc comment)
- `apps/api/src/db/seed.ts` (demo payments query fix)
- `SESSION_107_HANDOFF.md` (this file)

No migrations, no schema changes.

## Validation

- `npx tsc --noEmit -p apps/api/tsconfig.json` → exit 0
- `sendBulkNotification` smoke against dev:
  - No-filter call: returns `{sent: 0}` (no occupied units in dev — empty result is correct, not a bug)
  - With-propertyId call: returns `{sent: 0}` (parameterized; clean)
  - Injection probe (`' OR '1'='1`): Postgres rejects as
    "invalid input syntax for type uuid" — primary vector closed at
    the DB layer; route-layer uuid regex provides defense-in-depth
- `routeMaintenanceNotification` smoke surfaced the PM-coupling bug
  (above)
- Codebase grep confirms no remaining live SQL references to
  `units.tenant_id` (the only remaining hits are the disabled
  `otpScheduler.ts` documented per S86, the JS property access in
  the fixed seed.ts, and explanatory doc comments)
- Dev DB returned to zero rows post-test

## Pre-launch blockers still open

Same as S100–S106 plus the pm_companies build (was always on the list
under DEFERRED Item 13 / "PM subsystem"; restored to its rightful
status after my mid-session over-correction):
- Item 16 batch 2 — bank ACH origination provider
- Item 16 batch 3+ — OTP enablement
- Item 10 — utility billing payment integration
- **pm_companies subsystem** — schema (orgs/staff/fee_plans), owner→PM
  pointer, allocation-engine fee routing, owner visibility view

## What next session should target

1. **Item 16 batch 2 — bank ACH** when the rail call is made.
2. **pm_companies subsystem build** — dedicated session per CLAUDE.md
   PM rule. Schema-first: pm_companies, pm_staff, pm_fee_plans, owner
   pointer column. Then allocation-engine integration, then routes,
   then routeMaintenanceNotification gets the parallel pm_staff
   notification path added back.
3. **Compliance-table retention policy** (S104 deferral).
4. **Frontend pass for email failures** when you're ready to verify
   the wiring in browsers.

## Notes

The S105 cron-handler audit script could be extended to cover service
functions like `routeMaintenanceNotification` (called from routes,
not crons, but same silent-swallow pattern). Worth a half-session of
running the audit against every `services/*.ts` exported function
that has an outer try/catch.

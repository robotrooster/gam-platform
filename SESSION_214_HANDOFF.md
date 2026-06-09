# Session 214 — closed

## Theme

Addendum thread polish round. Closes out the addendum thread before
pivoting away.
- Resolves `recorded_by_user_id` → display name (+ role attribution
  on landlord side).
- Resolves landlord-side `tenant_ids` → tenant names (was count
  only).

## What S214 shipped

### Backend — services/addendumActor.ts

`apps/api/src/services/addendumActor.ts` (NEW):

- `resolveAddendumActor(userId, landlordId)` →
  `{ user_id, name, role: 'owner' | 'gam_admin' | 'pm' | 'team' | 'unknown' }`.
- Role determination, in order:
  1. **owner** — user_id matches `landlords.user_id` for the
     lease's landlord_id.
  2. **gam_admin** — `users.role` in `('admin', 'super_admin')`.
  3. **pm** — has a `property_manager_scopes` row scoped to this
     landlord_id.
  4. **team** — fallback for other scoped roles (maintenance /
     onsite manager) that may evolve later.
  5. **unknown** — user_id null or doesn't resolve.
- `addendumActorRoleLabel(role)` → display string ("Owner",
  "Property Manager", "GAM Admin", "Team", "—").
- `resolveTenantNames(tenantIds[])` → string[] in input order,
  unresolvable IDs become "(unknown)".

### Backend — both addendums endpoints resolve display info

**`GET /api/tenants/lease/addendums`** —
Now selects `recorded_by_user_id` from event_data, calls
`resolveAddendumActor` per event, returns `recorded_by_name` only.
Tenant view doesn't need role attribution; internal team structure
isn't useful to them.

**`GET /api/leases/:id/addendums`** —
Returns `recorded_by_name`, `recorded_by_role`,
`recorded_by_role_label`, AND a parallel `tenant_names` array
matched to `tenant_ids`. Landlords get the full
"who recorded this and which tenants is it on record for"
attribution.

### Frontend — both surfaces render the resolved attribution

**`apps/tenant/src/pages/LeasePage.tsx`** (S210 surface) —
New "Recorded by <Name>" line below each addendum row's date.

**`apps/landlord/src/pages/LeaseFormModal.tsx`** (S211 surface) —
Replaced the old "· N tenants on record" count with a richer line:
"Recorded by <Name> · <Role Label> · On record for <Name1, Name2>".

### Files touched (S214)

```
apps/api/src/services/addendumActor.ts                          (NEW — actor + tenant-name resolution helpers)
apps/api/src/routes/tenants.ts                                  (/lease/addendums: select recorded_by_user_id, resolve to name)
apps/api/src/routes/leases.ts                                   (/:id/addendums: resolve actor + tenant names)
apps/tenant/src/pages/LeasePage.tsx                             (+ "Recorded by" line)
apps/landlord/src/pages/LeaseFormModal.tsx                      (+ "Recorded by · Role · On record for ..." line)
```

### Verification

- `cd apps/api && npx tsc --noEmit` → clean
- `cd apps/tenant && npx tsc --noEmit` → clean
- `cd apps/landlord && npx tsc --noEmit` → clean
- No new migrations.

## Decisions made (S214)

| Question | Decision |
|---|---|
| Tenant view shows role attribution too? | No. Internal team structure (owner / PM / GAM admin) doesn't help the tenant. They get just the name. Reduces tenant-facing complexity for no functional gain. |
| Resolve actor in SQL JOIN or post-query in service code? | Service code. The role determination requires multiple table lookups (landlords, property_manager_scopes, users.role check) with branching logic — easier to read and test in TypeScript than nested SQL CASE expressions. Per-event Promise.all overhead is fine at expected volume (<100 addendums per lease lifetime). |
| `team` role label fallback or strict role enum? | Fallback. Other scoped role tables (maintenance_worker_scopes, onsite_manager_scopes) might one day need to record addendums. Generic "Team" reads correctly without needing the exhaustive switch — and a sensible default beats throwing. |
| Render tenant_names as comma-separated list or chips? | Comma-separated. Chips would clutter what's already a dense info row; the addendum surface is read-once-and-move-on, not interact-with. |
| Cache the resolved actor per request to avoid duplicate DB hits across rows where multiple addendums share the same recorded_by? | No. Not worth the dedupe code at expected volume. Per-event resolution is one users + one landlords + at most one property_manager_scopes lookup — ~3 trivial queries each, all on indexed PKs. |
| Show `recorded_by_user_id` in the response payload too? | Landlord side: yes (kept it for completeness — admins might want to inspect). Tenant side: no, dropped — name is what they need. |
| Drop the "· N tenants on record" count line on landlord side? | Yes. Replaced by the actual names list. The count was a placeholder; names answer the question more directly. |

## Carry-forward — S215+

### Addendum thread — fully closed

S210 + S211 + S212 + S213 + S214 ship the addendum-recording flow
end-to-end:

- Audit-trail event in credit-ledger (S202)
- Tenant + landlord read surfaces with diff visibility (S210, S211)
- Auto-generated PDF artifact (S212 primitive, S213 wire-in)
- Per-lease file-serving route with auth + filename validation (S213)
- Resolved name + role + tenant attribution (S214)

Open: end-to-end smoke test waits on dev seed having an active-
tenant lease for the PATCH path to exercise. Not S215 work; flag
when seed data lands.

### Already-known carry-forward (unchanged)

- Sublease phase 3 (sub-tenant billing + invite-by-email)
- POS Terminal hardware
- A3 polish (mostly diminishing returns)
- Primary manager urgency tier (S185 — needs Nic input)
- Owner-financial-escalation pattern (S186 — needs Nic input)
- Other POS tables for property scoping (S192 carry)
- B3 hard-gate check-in (product fork)
- D2 Flex tenant suite (launch-flag gated)
- CSV imports (vendor format specs)
- E2 npm upgrades (risky)
- F1 Marketing rebuild
- Catalog small-pop states (~5% remaining US population)

---

End of S214 handoff.

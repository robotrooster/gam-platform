# Session 230 — closed

## Theme

Per-property scope picker on landlord-portal `TeamPage`. Closes the
S229 carry-forward — until this session, the only way for a landlord
to refine which properties / units a PM, on-site manager, or
maintenance worker had access to was to either flip the
`allProperties` toggle at invite time or hit the API directly.
TeamPage's expanded-row UI now exposes the full scope payload.

## Recon finding

Pre-S230 state of TeamPage scope refinement:

- **Backend** `PATCH /api/scopes/:roleType/:userId` has accepted the
  full validated scope payload since S80 — `propertyIds`, `unitIds`,
  `allProperties`, plus `jobCategories` (maintenance) and
  `maintApprovalCeilingCents` (PM). Working, never wired to UI.
- **Backend** access enforcement (notifications service confirmed at
  `services/notifications.ts:770-801`) treats access as the union:
  `all_properties = true OR property_id = ANY(property_ids) OR
  unit_id = ANY(unit_ids)`. So property + unit selection are
  independent / additive — a unit added on top of a checked property
  is redundant but not harmful.
- **Frontend** TeamPage row expansion exposed only the
  sub-permission boolean grid (PM / OS / maintenance) and the
  bookkeeper access-level select. No scope editor at all.

## What S230 shipped

### Frontend — `apps/landlord/src/pages/TeamPage.tsx`

New `ScopePicker` component, mounted in the expanded row of every
non-bookkeeper member (between the existing `DirectDepositToggle`
banner — PM only — and the new "Permissions" sub-section header).

Form fields:
- **All-properties checkbox** — when on, hides the property list and
  posts `allProperties: true` with empty `propertyIds` / `unitIds`.
- **Property list** — sorted alphabetically, scrollable
  (`maxHeight: 280`), each row shows name + city/state. Each row has:
  - Property checkbox → adds property to `propertyIds`.
  - When property checkbox is OFF: a "Units (X/Y)" expand button
    drops a unit-checkbox grid scoped to that property's units. When
    the property checkbox flips ON, any unit IDs under that property
    are auto-cleared from `unitIds` (they'd be redundant).
  - When property checkbox is ON: shows "all N units" inline label.
- **Maintenance role only** — job categories chip multiselect (same
  control as the invite form; empty = all categories).
- **Property-manager role only** — maintenance approval ceiling
  input (dollars, optional). Blank = no override; falls back to the
  per-property `maint_approval_threshold` setting at runtime.
- **Save scope** button + status counts ("3 properties, 2 additional
  units" when `!allProperties`).
- Inline success/error messages, success auto-dismisses after 3.5s.

Submit handler builds the per-role payload to match the four zod
schemas in `scopes.ts:30-52`:
- maintenance → `{ propertyIds, unitIds, jobCategories, allProperties }`
- onsite_manager → `{ propertyIds, unitIds, allProperties }`
- property_manager → `{ propertyIds, unitIds, allProperties,
  maintApprovalCeilingCents }` (parses the dollar input → cents,
  null when blank)

POSTs to `PATCH /scopes/${role}/${userId}`. On success invalidates the
`'team'` query so the picker re-mounts with fresh server state if the
landlord re-opens the row. Invalidating `'team'` (not `'properties'` /
`'units'`) avoids re-fetching the property/unit lists, which are
already cached from elsewhere on the landlord portal.

### Files touched (S230)

```
apps/landlord/src/pages/TeamPage.tsx   (+ useMemo import,
                                        + NonBookkeeperRole type alias,
                                        + PropertyLite / UnitLite interfaces,
                                        + ScopePicker component (~190 lines),
                                        + ScopePicker mount in expanded row,
                                        + "Permissions" subsection header
                                          above existing checkbox grid)

DEFERRED.md                            (- stale "Frontend bookkeeper
                                          invite UI" entry — S229
                                          shipped this as part of
                                          TeamPage InviteForm)
```

### Verification

- `cd apps/landlord && npx tsc --noEmit` → clean.
- `cd apps/landlord && npx vite build` → built clean (2.14s, no
  warnings beyond the pre-existing chunk-size advisory).
- No backend changes — entirely wires to the existing S80 PATCH
  endpoint and its zod validation.
- No new migrations.

## Decisions made (S230)

| Question | Decision |
|---|---|
| One scope-picker form for all three non-bookkeeper roles, or three role-specific components? | One component with role-conditional sections (job cats for maintenance, ceiling for PM). The shared parts — property + unit pickers, allProperties toggle — are 80% of the form; splitting would mean three near-duplicate components. |
| Inline picker on TeamPage row vs. modal vs. dedicated subpage? | Inline expansion. TeamPage already uses click-to-expand for the permissions grid; users land here looking at the same member row. A modal would close → re-open on every save; a dedicated subpage would fragment the team-management surface across two routes. |
| When a property is checked, hide its unit list (vs. leave it visible and disabled)? | Hide. Implicit access is cleaner than a row of grayed-out checkboxes saying "covered by parent." Replaced with an "all N units" inline label so the count is still visible. |
| Auto-clear redundant unit IDs when their property is checked? | Yes. When the user checks a property whose units they had previously cherry-picked, the unit IDs are stripped on the same state transition. Saving back what the form shows means the server state stays free of redundant data. The reverse direction (unchecking a property doesn't add its units back) is correct — they just lose access. |
| Save semantics — incremental PATCH (just changed fields) vs. full-scope replace? | Full replace. The backend PATCH endpoint already validates and replaces the full payload via the same zod schemas the invite form used. Incremental would mean adding a parallel partial-update endpoint or per-field PATCH calls, neither worth it for a form this small. |
| Show a "dirty" indicator + disable Save until edited? | No. Save is always enabled when not in flight. Re-saving the same payload is a server no-op; the cost of a dirty calculation across 5+ state vars (with array-deep-equal) is more code than it's worth. Inline success message after save provides the feedback. |
| Maintenance approval ceiling: per-member override here, or only per-property at the property level? | Both — and that's already the spec. Per-property `maint_approval_threshold` is the default; per-member `maint_approval_ceiling_cents` overrides it for that worker. Surfacing the override here closes the loop. Blank input = null = use the property default. |
| Show a load-state placeholder while properties/units fetch? | Yes — a one-line "Loading properties…" until both queries settle. The fetches are usually instant on a warmed-cache TeamPage visit, so most of the time it's invisible. |
| Property list scrollable cap or paginated? | Scrollable, `maxHeight: 280`. Landlords with 50+ properties stay scrollable; pagination adds friction for the common case (small portfolios). |

## Carry-forward — S231+

### Already-known carry-forward (unchanged)

See `DEFERRED.md` "Open — pick one" section for the current queue.
Notable still-open items the picker does NOT cover (intentionally,
per scope):

- **Filter / search inside the property list** — landlords with very
  large portfolios (50+) get a scrollable list. If a real complaint
  surfaces, drop a search field + maybe a "Selected first" sort.
- **Bulk select / unselect helpers** — "Select all in city X",
  "Clear all". Unimplemented. Not surfaced as needed yet.
- **Onsite manager uniqueness conflict on PATCH** — the
  invite-time uniqueness check (`scopes.ts:368-374`) does not
  re-run on PATCH. If two landlords already share an OS user via
  some prior path, the picker will save fine; the constraint only
  guards the invite step. Probably OK — switching ownership of an
  OS user across landlords is not a TeamPage operation.

### DEFERRED tombstone update

`Frontend bookkeeper invite UI` line removed from DEFERRED.md
"Open — pick one" — covered by S229's TeamPage InviteForm. No
DEFERRED tombstone added; this is small UI glue, audit trail in
S229 + S230 handoffs.

---

End of S230 handoff.

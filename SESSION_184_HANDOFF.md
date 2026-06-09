# Session 184 — closed

## Theme

Build the missing surface that lets owners actually delegate
day-to-day management, completing the S183 wiring loop. Backend
honors `properties.managed_by_user_id` for routing notifications
+ todos, but pre-S184 there was no API or UI to set it to anything
other than the owner's own user_id (the INSERT default). Half-
session, locked-decision territory.

## What S184 shipped

### Backend — `PATCH /api/properties/:id/manager`

Sets `properties.managed_by_user_id`. Single-field PATCH, body
shape `{ user_id: string | null }`. `null` reverts to owner self-
management (column stays NOT NULL by writing `owner_user_id`).

Validation:
- Auth: `requireLandlord` + `canManageLandlordResource(req.user, prop.landlord_id, [])`
  (no team-role passes; matches the `/pm-assignment` posture —
  delegating authority is an owner decision).
- 409 if `pm_company_id IS NOT NULL` — PM company takes priority
  in the resolver, individual delegation is meaningless under a
  contract. Owner must clear PM via `/pm-assignment` first.
- Target user must have an active `property_manager_scopes` row
  covering this property under this landlord. Prevents an owner
  from routing notifications to Random Stranger by misconfigured
  ID. Coverage check matches the existing scope semantics:
  `all_properties = true` OR `$prop_id = ANY(property_ids)` OR a
  unit under the property in `unit_ids`.

### Backend — `GET /api/properties/:id/eligible-managers`

Returns the dropdown options for the frontend selector. Shape:

```ts
{
  current_managed_by_user_id: string,
  owner_user_id:              string,
  owner: { user_id, email, first_name, last_name, role: 'self' },
  managers: Array<{ user_id, email, first_name, last_name, role: 'manager' }>
}
```

`managers` is the active `property_manager_scopes` holders covering
this property (same coverage predicate as the PATCH validator).
Sorted by last_name → first_name → email. Auth gate is
`canAccessLandlordResource` (read-only, allows team users) since
this is a list endpoint, not a state mutation.

### Frontend — `PropertyManagerCard` on `PropertyDetailPage`

New card, rendered between the existing PM-company linkage card
and the occupancy bar. Hidden by parent when `pm_company_id` is
set (PM-company is shown above and takes precedence — no point
surfacing an irrelevant individual selector underneath).

Card layout:
- Header: "Day-to-day manager" with helper copy explaining what
  routine notifications get routed (vs owner-financial alerts that
  always go to owner)
- Dropdown: "Self-managed — &lt;owner email&gt;" + each eligible
  manager (full name + email)
- Save button: disabled when selection matches current state, OR
  when mutation is in flight
- "Delegated" badge shown when current state is non-owner
- Inline error / success banners

`useMutation` posts to `PATCH /properties/:id/manager`. On success
invalidates both `['property', id]` and `['eligible-managers', id]`
queries so the badge + dropdown reflect the new state.

### Files touched (S184)

```
apps/api/src/routes/properties.ts                                       (+ PATCH /:id/manager + GET /:id/eligible-managers; managerAssignmentSchema)
apps/landlord/src/pages/PropertyDetailPage.tsx                          (+ PropertyManagerCard component, useEffect/useMutation/apiPatch/UserCheck imports, parent integration gated on !pm_company_id)
```

### Verification

- `cd apps/api && npx tsc --noEmit; echo $?` → 0
- `cd apps/landlord && npx tsc --noEmit; echo $?` → 0
- No schema migrations this session (column was already on the
  table from S60; this just lets it be edited)

## Decisions made (S184)

| Question | Decision |
|---|---|
| Eligible managers — gated to `property_manager_scopes` holders or any user? | Gated. An owner shouldn't be able to assign a non-scope-holder; that would route notifications to someone with no operational visibility into the property and no permission to act. The Team page is the canonical place to grant scope; this endpoint just routes among existing scope holders. Fewer footguns. |
| Allow individual delegation while pm_company_id is set? | No. Returns 409. The resolver already prioritizes PM company, so an individual delegation under a PM contract would be silently ignored. Better to reject loudly. |
| Save-on-change vs explicit Save button? | Explicit Save. Owner needs to be sure before re-routing. Disabled until selection diverges from current. Save resets the dirty flag on success. |
| Persist null vs persist owner_user_id when reverting to self-managed? | Persist owner_user_id (column is NOT NULL). API accepts `{ user_id: null }` as user-friendly shorthand and resolves to owner_user_id server-side. |
| Show the card always vs only when there's at least one eligible manager? | Always (when no PM company). When there are zero managers, the dropdown shows the owner only + a disabled "No property-manager scope holders" hint. Discoverability — owner sees the surface and learns where to grant scope. |

## Carry-forward — what S185+ should target

### Specific to S183/S184 thread

- **Audit `routeMaintenanceNotification` for managed_by parity.**
  Currently fans out to `property_manager_scopes` holders + pm_staff
  + owner-on-escalation. Doesn't read `managed_by_user_id`
  specifically. Verify with Nic whether the individual primary
  manager should get a distinct urgency tier (e.g. SMS even on
  non-emergency since they're THE responsible party, while other
  property_manager_scopes holders only SMS on emergency). Half-
  session if Nic confirms scope.

- **`pos_items.property_id` for property-scoped low-stock alerts.**
  Schema change + migration + UI to assign POS items to specific
  properties. Lets `notifyLowStock` route through the responsible-
  party resolver. Full session. Product call: are POS items
  naturally landlord-wide or per-property?

### Already-known carry-forward (still open, unchanged)

- B3 surface UI on bookings (Nic-blocked on layout direction)
- A3 — state-hardcoded deposit interest (Nic-blocked on data sourcing)
- B1+B2 — material-change new-lease workflow + late-fee edit
  confirm modal + addendum generator (needs more product detail)
- C1 — 50-state property-state form catalog (~2 sessions, needs
  per-state research)
- D2 — Flex tenant suite + OTP landlord-side + launch-hide flag
- Sublease subsystem
- POS multi-terminal sync + Stripe Terminal + EOD
- CSV imports for 8 competitors
- E2 — 4 npm upgrades
- F1 — Marketing rebuild (after Nic's positioning paragraph)
- `leases.security_deposit` deprecation into `lease_fees`

---

End of S184 handoff.

# Session 236 — closed

## Theme

Owner-vs-manager permission re-audit. Read every write endpoint in
the routes/ tree against the property_manager perm grid + the shared
SUB_PERMISSIONS_BY_ROLE list. Found and fixed:
- 3 orphan perms in the PM list (toggleable but gating no route)
- 1 owner-only route still on bare `requireAuth`
- 3 privilege-escalation paths via self-edit on team/scope endpoints

## Findings + fixes

### 1. Three orphan PM perms (UX bug, low security severity)

`PROPERTY_MANAGER_SUB_PERMISSIONS` listed:
- `properties.archive`
- `units.set_rent`
- `payments.initiate_disbursement`

A grep across `apps/api/src/routes/` found ZERO backend handlers
gating on any of these keys. The TeamPage UI surfaces them as
toggles labeled "Archive properties", "Set/change rent", "Initiate
disbursements" — landlords flipping them ON saw no behavior change.

`payments.initiate_disbursement` was leftover from the pre-S113
manual-disburse flow (S113 removed `disbursementFiring.ts` at S199;
the perm was missed in the cleanup). `properties.archive` and
`units.set_rent` were planned-but-never-wired surfaces.

**Fix**: removed all 3 from `PROPERTY_MANAGER_SUB_PERMISSIONS` +
their entries in `SUB_PERMISSION_LABEL`. Also stripped
`properties.archive` from the OR-list on the Properties nav-link in
landlord Layout.tsx (the link still shows for users with
`properties.create` or `properties.edit`).

Old jsonb scope rows that have any of these flags = TRUE keep the
keys; the auth middleware filter is a per-key OR over the listed
keys, so unknown keys harmlessly noop.

### 2. `PATCH /api/landlords/theme` — owner-only route on bare auth

Pre-S236 the route had `requireAuth` and scoped its UPDATE by
`req.user.profileId`. For a property_manager, `profileId` resolves to
their employer's landlord_id (per `auth.ts:145` —
`profileId = user.profile_id || scope?.landlordId || null`). So any
manager could rewrite their landlord's portal theme accent + font
style — nominally cosmetic, but it's owner-controlled branding the
landlord sees on their own login.

**Fix**: tightened to `requireLandlord` (admin/super_admin/landlord).

### 3. Three privilege-escalation paths via self-edit on scope routes

The team/scope routes all gate behind `requirePerm('team.manage_permissions')`,
which is intended for delegated team management — a senior manager
could be granted this perm to manage subordinates' scope/perms on
the landlord's behalf. **None of the routes blocked the manager from
targeting themselves with the URL `userId`.**

#### 3a. PATCH /api/scopes/property_manager/:userId/direct-deposit
A manager with `team.manage_permissions` could pass their OWN userId
in the URL and flip `direct_deposit_enabled = TRUE` on their own
scope row. Per CLAUDE.md the spec is *"manager Connect is opt-in by
the LANDLORD, default off"* — self-flip violates the design.

#### 3b. PATCH /api/scopes/:roleType/:userId/permissions
A manager with `team.manage_permissions` could pass their OWN userId
+ a `permissions` JSON granting every other sub-permission in the
catalog (including `team.manage_permissions` itself, locking the
escalation in). Permanent privilege escalation across the entire
landlord's scope. **Most severe of the three.**

#### 3c. PATCH /api/scopes/:roleType/:userId (full-scope edit)
A manager with `team.manage_permissions` could pass their OWN userId
+ a scope payload that adds property_ids / unit_ids they shouldn't
have access to (or sets `all_properties=true`, or for PM raises
`maint_approval_ceiling_cents` arbitrarily). Lateral expansion.

**Fix**: each handler gets a 3-line guard at the top:
```ts
if (req.user!.role === 'property_manager' && req.params.userId === req.user!.userId) {
  throw new AppError(403, '... ask your landlord ...')
}
```

Owner roles (admin / super_admin / landlord) bypass — they hold
every perm by design and self-targeting their own scope row is
nonsensical anyway since their scope lives in a different table.

DELETE /scopes/:roleType/:userId NOT guarded — a manager deleting
themselves locks themselves out, which is harmless (analogous to a
user deleting their own account).

### 4. PM third-party companies — already audit-clean

Spot-checked `routes/pm.ts`. Each mutation handler calls
`assertPmStaffRole(userId, companyId, ['owner'|'manager'|...])` at
the top, which checks the caller's pm_staff row in the named
company. Self-targeting isn't a concept here — pm_staff role is
assigned at staff creation by the company owner, and the existing
"only owners can edit other staff" rule already covers the
relevant escalation paths.

### 5. Bank accounts, withdrawals, Stripe Connect — already self-scoped

- `bank-accounts/*`: every endpoint scopes by `req.user.userId`
  (each user owns only their own bank accounts).
- `/me/withdrawals`: scopes by `req.user.userId` to the caller's
  Connect account.
- `/stripe/connect/onboarding-session`: entity='user' uses the
  caller's userId; entity='pm_company' verifies the caller is an
  active 'owner' of the named pm_company.

No changes needed.

## Files touched (S236)

```
packages/shared/src/index.ts                    (- 3 PM perms,
                                                 - 3 perm labels)
apps/landlord/src/components/layout/Layout.tsx  (- properties.archive
                                                   from Properties
                                                   nav-link OR-list)
apps/api/src/routes/landlords.ts                (~ /theme: requireAuth
                                                   → requireLandlord)
apps/api/src/routes/scopes.ts                   (+ 3 self-edit guards
                                                   on direct-deposit /
                                                   permissions /
                                                   full-scope routes)

DEFERRED.md                                     (- audit item from Open,
                                                 + tombstone in Closed)
SESSION_236_HANDOFF.md                          (new)
```

No migrations.

## Verification

- `cd packages/shared && npm run build` → clean
- `cd apps/api && npx tsc --noEmit` → clean
- `cd apps/landlord && npx tsc --noEmit` → clean
- `cd apps/tenant && npx tsc --noEmit` → clean

## Decisions made (S236)

| Question | Decision |
|---|---|
| Remove orphan perms entirely or wire them to actual endpoints? | Remove. `properties.archive` and `units.set_rent` would need new endpoints + lease-amendment logic + tenant-notification flows to ship cleanly — that's product work, not audit cleanup. `payments.initiate_disbursement` was leftover from a removed flow. Removing is one line; building was N sessions. |
| Drop the perm keys from old jsonb scope rows? | No. The auth filter is a per-key OR — unknown keys silently fail to grant. Old TRUE-flags on these keys harmlessly noop. Cleaning the jsonb would need a UPDATE migration touching every existing scope row, which is more risk than benefit. |
| Self-edit guard on the team routes — refuse self-target globally, or just for property_manager role? | Just property_manager. Owner roles (admin / super_admin / landlord) hold every perm by design; their "self-target" doesn't make sense (their scope row is in `landlords` not the role-scope tables). Bookkeeper / onsite_manager / maintenance don't have `team.manage_permissions` available, so they can't reach these handlers. |
| Should DELETE /:roleType/:userId block self-target too? | No. Self-delete locks the manager out of their own employment scope — they lose access on their next request. Annoying for them but not a security issue, no privilege gained. The team UI hides self-delete buttons anyway. |
| Audit-only session, or roll fixes into the same pass? | Fixes in the same pass. Three of the four findings were small edits (perm-list trim + middleware swap + 3-line guards × 3). Splitting audit-then-fix would have risked the findings sitting unresolved across sessions. |
| Tighten `PATCH /landlords/theme` to a new perm key, or use `requireLandlord`? | `requireLandlord`. Adding a `landlord.theme` sub-permission would let landlords delegate theme-customization to managers — but theme is portal branding the landlord sees on their own login, which is owner-only by design. No middle-ground perm needed. |

## Audit limits — what S236 didn't cover

- **Cross-tenant leaks** — earlier audit passes (S62 Pass 1, S69-S72
  Pass 2) closed those for the v1 surface. Spot-checked the PM third-
  party flow (added S107-S112 + S157+); no leaks found.
- **Race conditions in the team routes** — e.g. landlord and manager
  both editing the same scope row concurrently. The DB layer's
  default last-write-wins is acceptable for permission edits (the
  owner's edit will land + be visible immediately).
- **Audit-log coverage of permission edits** — the team routes don't
  emit `platform_events` rows for permission changes. Future audit-
  trail work could capture who-changed-what-when on team scope.
  Out of scope for S236.
- **Onsite_manager / maintenance / bookkeeper sub-permissions** —
  spot-checked; all gate at least one route. No orphans.

## Carry-forward — S237+

DEFERRED post-S236:

**Open — pickable:**
- POS receipt printing (hardware adapter)
- POS multi-terminal session sync (probably premature)
- /resolve smoke (testing)
- POS end-to-end smoke (testing)

**Nic-blocked / external / multi-session / npm audit / pre-launch
flag-gated:** unchanged from S235.

## Revised count

S236 closed 1 line item (the audit) + surfaced 4 real bugs.

| Bucket | Pre-S236 | Post-S236 |
|---|---|---|
| Pickable now | ~5 | ~4 |
| Nic-blocked | 5 | 5 |
| External-vendor-blocked | 1 | 1 |
| Multi-session epics | 3 | 3 |
| npm audit | 4 | 4 |
| Pre-launch flag-gated | 2 | 2 |

**Until v1 launch-ready:** ~11 sessions → ~10.
**Until 100% feature-complete:** ~20 sessions → ~19.

---

End of S236 handoff.

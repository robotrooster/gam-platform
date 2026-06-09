# Session 183 — closed

## Theme

Two phases:

1. **Pre-correction (documentation):** sweep stale `lease_fees.due_timing`
   claim in CLAUDE.md left over after S180-S182, then execute Pass 3 of
   the permissions audit (owner-vs-manager re-audit, deferred from item
   17a since S62 / S69-S72).

2. **Post-correction (build):** Nic corrected the audit's P2 recommendation
   ("drop `properties.managed_by_user_id`"). The column is the *correct*
   architecture for routing-to-responsible-party; the gap is consumer
   code that never honored it. Wired three of the four notification call
   sites + the dashboard `/me/todos` filter through a new responsible-
   party resolver. Owners no longer get spammed about properties they've
   delegated.

One migration considered, none applied this session.

## What S183 shipped

### Phase 1 — documentation

#### CLAUDE.md `lease_fees.due_timing` staleness fix

The CLAUDE.md entry headed "partial wire-up (S144)" claimed move_out
and other due_timings were NOT wired to any billing path and that
`checkLeaseEndFeeGap` was the mitigation. After S180-S182:
- move_out + other → consumed by `services/depositReturn.ts:calculateDepositReturn`
  (S180/A1) — both timings sum into the deposit-deduction auto-sweep
- `other` admin-trigger billing path → `POST /api/leases/:id/bill-fee`
  (S180/A2 backend, S181 frontend)
- `checkLeaseEndFeeGap` is gone (verified zero refs)

Entry rewritten as "fully wired (S144 → S180-S182)" with current
consumer paths.

#### Pass 3 permissions audit appended to PERMISSIONS_AUDIT.md

Five findings, headline: every landlord-facing notification call site
resolves the recipient via `landlords.user_id` (the owner) regardless
of `properties.managed_by_user_id` or `properties.pm_company_id`.
Owners get every routine ping for properties they've delegated.

Initial conclusion proposed three options including P2 (drop the
column). Nic corrected: column is correct architecture; consumer
code is what needs to catch up. Audit conclusion section rewritten
post-correction. New build phase below addresses the wiring gap.

#### Memory: `feedback_underwired_infra.md`

Saved as feedback memory + indexed in MEMORY.md. Lesson: when a
schema column / table / service exists but has zero or near-zero
consumers, the bug is the underwiring, not the infra. Treat
"no consumers" as scope, not conclusion. Don't propose dropping
intentional architecture.

### Phase 2 — build (post-correction)

#### New service: `services/responsibleParty.ts`

Single source of truth for "who gets pinged about events at this
property." Function signature:

```ts
getPropertyResponsibleParty(propertyId: string): Promise<{
  primaries:    Array<{ user_id, email, phone }>  // day-to-day recipients
  owner:        { user_id, email, phone }         // always — escalation target
  is_delegated: boolean
  kind:         'self_managed' | 'individual' | 'pm_company'
} | null>
```

Resolution priority:
1. `pm_company_id` set (property override OR landlord default via
   `getPmCompanyForProperty` from S157) → primaries fan out to all
   active `pm_staff` of that company
2. Else `managed_by_user_id !== owner_user_id` → primary is the
   delegated individual user
3. Else self-managed → primary is the owner

`routeMaintenanceNotification` (notifications.ts:642) was the
reference shape — pre-existing responsible-party fan-out via
property_manager_scopes + pm_staff. The resolver formalizes that
pattern for other call sites without re-plumbing maintenance.

#### Wired call sites

| Call site | File / line | Behavior change |
|---|---|---|
| `notifyLeaseExpiring` (cron) | `jobs/scheduler.ts:23-65` | Loops `targets.primaries` per lease, fires one notification per recipient. Self-managed → owner; PM company → all active staff; individually delegated → manager. Log line includes recipient count + kind. |
| `notifyRentCollected` (Stripe webhook) | `routes/webhooks.ts:197-256` | Same fan-out shape. Failure isolation per-recipient via outer try/catch (existing posture). |
| `/api/landlords/me/todos` lease-issues filter | `routes/landlords.ts:299-345` | Added `WHERE p.pm_company_id IS NULL AND p.managed_by_user_id = $userId` — owner stops seeing lease issues on delegated properties. |
| `/api/landlords/me/todos` tenant-ACH filter | `routes/landlords.ts:391-409` | Same self-managed predicate. |
| `/api/landlords/me/todos` failed-rent-pulls filter | `routes/landlords.ts:421-446` | JOIN through `properties pr` to apply the same self-managed predicate. |

Owner-financial items in `/me/todos` (bank account readiness,
maintenance awaiting_approval) intentionally stay unfiltered — those
are escalation/financial-control concerns the owner sees regardless
of delegation. Logic documented inline.

#### Skipped (with reason)

- **`notifyLowStock`** (`jobs/scheduler.ts:355`) — `pos_items` is
  landlord-scoped (no `property_id` column). Low-stock alerts are
  genuinely landlord-level under the current data model. Property-
  level POS would need a schema change (add `pos_items.property_id`
  + per-property POS configuration). Out of scope for this session.
- **`routeMaintenanceNotification`** (`notifications.ts:642`) —
  already does responsible-party fan-out (in-house PMs + pm_staff +
  owner-only-on-escalation). Reference shape that the new resolver
  formalizes; no behavior change needed.

### Files touched (S183)

```
CLAUDE.md                                                               (lease_fees.due_timing entry rewritten)
PERMISSIONS_AUDIT.md                                                    (+ Pass 3 audit + post-correction conclusion section)
apps/api/src/services/responsibleParty.ts                               (NEW — getPropertyResponsibleParty resolver)
apps/api/src/jobs/scheduler.ts                                          (notifyLeaseExpiring wired through resolver; query reshape to drop landlord-user JOIN, add property_id)
apps/api/src/routes/webhooks.ts                                         (notifyRentCollected wired through resolver; query reshape)
apps/api/src/routes/landlords.ts                                        (/me/todos: 3 query filters + comment refresh; userId added from req.user)
~/.claude/projects/-Users-gold-Downloads-gam/memory/feedback_underwired_infra.md  (NEW)
~/.claude/projects/-Users-gold-Downloads-gam/memory/MEMORY.md           (+ pointer to underwired_infra)
```

### Verification

- `cd apps/api && npx tsc --noEmit` exit 0
- `grep -c "Pass 3 — owner vs manager" PERMISSIONS_AUDIT.md` → 1
- `grep -c "fetchUnpaidBalanceLines\|getPropertyResponsibleParty" apps/api/src/services/*.ts` shows new resolver landed
- No schema migrations this session (column is being honored, not changed)

## Decisions made (S183)

| Question | Decision |
|---|---|
| Column `properties.managed_by_user_id` — drop, leave, or honor? | Honor. Nic correction: it's intentional architecture for routing-to-responsible-party. Wire the consumers, don't drop the infra. |
| `routeMaintenanceNotification` — refactor through new resolver too? | No. Existing pattern works correctly; refactoring it would be churn for parity, not for behavior. Resolver applies to the four other call sites that didn't have the pattern. |
| `/me/todos` — filter day-to-day vs financial-control items? | Yes, mixed approach. Lease issues / tenant ACH / rent failures filtered to self-managed properties. Bank account / maintenance awaiting_approval stay unfiltered (owner-only concerns by nature). |
| `notifyLowStock` — wire to per-property responsible party? | No, deferred. POS items are landlord-scoped (no property_id) — would need schema change. Documented in carry-forward. |
| Need a UI to set `managed_by_user_id` to a different value? | Deferred. Backend now honors the pointer; UI to mutate it is a follow-up so Nic can review the routing first before exposing the toggle. |
| Need to rename helper parameter `landlordUserId` → `recipientUserId` since it's now the responsible-party user? | No. Cosmetic churn across many files; deferred. The resolver's call-site loop makes the semantic clear at the boundary. |

## Carry-forward — what S184+ should target

### Specific to S183 wiring

- **Manager-mutation UI / API.** Add `PATCH /api/properties/:id/manager`
  endpoint + landlord portal UI to assign / revoke individual
  delegation (set `managed_by_user_id` to a property_manager_scopes
  holder). Backend now honors the pointer; UI is the missing surface.
  Half-session. Confirm scope with Nic before building.

- **`pos_items.property_id` for property-scoped low-stock alerts.**
  Schema change + migration + UI to assign POS items to specific
  properties. Then notifyLowStock can route through the resolver.
  Full session. Product call: are POS items naturally landlord-wide
  (Cost-Plus-Drugs-of-RV-Parks model) or per-property?

- **Audit `routeMaintenanceNotification` for parity.** The existing
  fan-out queries property_manager_scopes for in-house managers,
  but `managed_by_user_id` (the new individual-delegation pointer)
  isn't in that fan-out. Verify this matches Nic's mental model:
  scopes table = "team workers under owner's umbrella";
  managed_by_user_id = "I delegate the whole property to one specific
  user." Different semantics, but worth confirming the maintenance
  fan-out doesn't need to add the managed_by lookup too.

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

End of S183 handoff.

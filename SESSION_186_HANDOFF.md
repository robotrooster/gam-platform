# Session 186 — closed

## Theme

Pass 5 audit — comprehensive sweep of every landlord-targeted
notification helper in `services/notifications.ts` for the same
landlord-spray pattern S183/S185 already fixed in 5 places.
Found 7 more latent bugs across 4 files; all wired through the
responsible-party resolver. Closes out the S183/S184/S185/S186
thread on the routing side.

## What S186 shipped

### 7 call sites wired through `getPropertyResponsibleParty`

| File / line | Helper | Context |
|---|---|---|
| `routes/tenants.ts:498` | `notifyTenantInviteAccepted` | Tenant onboarding event — manager handles invitation lifecycle |
| `routes/entryRequests.ts:263` | `notifyEntryRequestResponded` | Tenant accepted/declined a landlord-requested entry — manager handles |
| `routes/inspections.ts:356` | `notifyInspectionTenantSigned` | Inspection workflow — manager runs inspections |
| `routes/inspections.ts:494` | `notifyInspectionFinalized` | Inspection finalized with credit-ledger outcome — manager workflow |
| `jobs/operationalNudges.ts:66` | `notifyInspectionScheduledReminder` | 24-hour-before reminder — manager prepares for the visit |
| `routes/webhooks.ts:411` | `notifyAchRetryScheduled` | NSF retry queued — manager chases collections |
| `routes/webhooks.ts:428` | `notifyAchRetriesExhausted` | All retries failed — manager handles fallback (manual ACH, switch payment method) |

Each fix follows the S183/S184/S185 pattern:
1. Pull `property_id` into the SQL context query (was using
   `landlords.user_id` JOIN — replaced with `properties.id`)
2. `await getPropertyResponsibleParty(property_id)` for the targets
3. Loop `targets.primaries` and fire one notification per recipient

Owner gets each notification on self-managed properties (primaries
== [owner]). On individually-delegated properties, only the manager
gets it. On PM-delegated properties, all active pm_staff get it.
Owner never spammed for routine events on properties they've
handed off.

### Confirmed correct as-is — no change needed

- `stripeConnect.ts:624` `notifyConnectPayoutPaid` — owner-financial,
  correctly to owner
- `stripeConnect.ts:634` `notifyConnectPayoutFailed` — same
- `stripeConnect.ts:652` `notifyPmCompanyPayoutPaid` — to the PM
  company (not landlord routing — PM company side)
- `stripeConnect.ts:661` `notifyPmCompanyPayoutFailed` — same
- `routes/entryRequests.ts:116,340` (tenant-targeted) — out of
  scope, not landlord routing
- `routes/credit.ts:709` `notifyDisputeResolved` — takes
  `disputingUserId` (could be either party), not `landlordUserId`

### Files touched (S186)

```
apps/api/src/routes/tenants.ts                                          (notifyTenantInviteAccepted: + property_id from query, resolver loop, dropped landlord_user_id JOIN)
apps/api/src/routes/entryRequests.ts                                    (notifyEntryRequestResponded: rebuilt ctx query, resolver loop)
apps/api/src/routes/inspections.ts                                      (notifyInspectionTenantSigned + notifyInspectionFinalized: rebuilt ctx queries against units+tenants directly, resolver loops)
apps/api/src/jobs/operationalNudges.ts                                  (notifyInspectionScheduledReminder: query reshape to fetch property_id from units, type signature update, resolver loop)
apps/api/src/routes/webhooks.ts                                         (notifyAchRetryScheduled + notifyAchRetriesExhausted: rebuilt ctx query against units+properties, typed result, resolver loop)
PERMISSIONS_AUDIT.md                                                    (+ Pass 5 — full notification helper sweep, 14-row classification table + conclusion)
```

### Verification

- `cd apps/api && npx tsc --noEmit; echo $?` → 0
- No schema migrations this session
- No frontend changes (server-side routing only; frontends already
  render whatever notifications they receive)

## Decisions made (S186)

| Question | Decision |
|---|---|
| ACH retry/exhausted — route to owner-additional or primary-only? | Primary-only for consistency with the rest of the per-property notifications. ACH NSF chasing is operational manager work; if owner wants escalation pings on persistent failures, that's a separate "owner-financial-escalation" pattern layered on top, not part of the standard resolver flow. |
| Dispute resolved (`credit.ts:709`) — wire through resolver? | No — out of scope. The helper takes `disputingUserId` (could be tenant or landlord depending on who filed). Different routing model entirely; not landlord-spray. |
| Connect payout helpers — wire through resolver? | No — these notify the bank-account owner about money landing. The Connect account is owned by a single user (owner or PM company), not by a property. Resolver's per-property model doesn't apply. |
| `notifyEntryRequestResponded` query — refactor to reuse the existing pattern from S183 ctx queries? | Per-call-site query. Each ctx is shaped for its specific helper's parameters; trying to centralize the JOINs adds complexity without simplifying the call sites. |
| Test coverage? | Same posture as S185 — typecheck verifies the wiring, runtime smoke deferred to Nic's bench (no harness exists for these helpers). The fix shape is identical across all 7 call sites and matches the already-deployed S183 pattern. |

## Carry-forward — what S187+ should target

### Specific to S183/S184/S185/S186 thread

- **Primary manager urgency tier** — open product question from S185
  Pass 4. Whether `managed_by_user_id` should get distinct
  notification treatment from secondary scope holders. Needs Nic.

- **Owner-financial-escalation pattern.** If you want owner-
  additional pings on rent-collection failures (e.g. "ACH retries
  exhausted on a delegated property — owner should also know"),
  that's a layered pattern on top of the primary-only routing.
  Half-session if you decide it's worth it. Currently primary-only.

- **`pos_items.property_id`** schema change for property-scoped
  low-stock alerts. Still open from S183. Full session.

- **`onsite_manager_scopes.all_properties`** column. S185 worked
  around the missing column by treating empty arrays as "all"; a
  proper migration to add the boolean would align it with the other
  two scope tables. Quarter-session.

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

End of S186 handoff.

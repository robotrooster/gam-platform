# Session 198 — closed

## Theme

Sublease subsystem phase 2: notifications + tenant UI + landlord
UI. S197 wired the backend workflow; S198 puts an actual surface
on it for both sides to use.

Phase 3 (later): sublessee invite-by-email flow (currently
sublessee must already be a GAM tenant) + sub-tenant billing
wire-up (depends on Stripe Connect S113 rebuild).

## What S198 shipped

### Notifications — three new helpers

`services/notifications.ts`:

- **`notifySubleaseRequested`** — fires to landlord when a
  sublease is requested (status='pending'). Skipped when
  auto-approved under `subleasing_allowed='allowed'` (no
  decision needed).
- **`notifySubleaseDecision`** — fires to sublessor when
  landlord approves or denies. Carries optional landlord note.
- **`notifySubleaseTerminated`** — fires to the OTHER two
  parties when any of the three triggers termination (sublessor,
  sublessee, or landlord). Trigger label embedded in the body.

All three use `createNotification` with in-app + email
(`emailTemplate(...)`). No SMS for phase 2 — sublease lifecycle
is non-urgent.

### Backend — wired into `routes/subleases.ts`

- POST handler: looks up landlord + property + names + emits
  `notifySubleaseRequested` when status='pending' (skipped on
  auto-approve).
- PATCH /decision: emits `notifySubleaseDecision` to the
  sublessor with the verb + optional note.
- PATCH /terminate: emits `notifySubleaseTerminated` to the OTHER
  two parties (skips the trigger). Pulls all three party ctx in
  one query, builds recipient list excluding the trigger.

All emissions are best-effort wrapped in try/catch — notification
failure doesn't roll back the workflow update.

### Landlord frontend — `SubleasesPage`

New page at `/subleases` (mounted in `main.tsx`, nav entry under
the existing Leases item in `Layout.tsx`).

- Pending count banner (amber, with `<AlertTriangle />` icon)
  surfaced when there are decisions waiting.
- Table: Status / Unit / Sublessor / Sublessee / Term / Sub-rent
  / Master share / actions. One row per sublease.
- Pending rows show Approve + Deny buttons → modal with optional
  note. Active rows show Terminate button → modal with required
  reason. Terminated rows show no actions.
- Approve/deny calls `PATCH /api/subleases/:id/decision`.
  Terminate calls `PATCH /api/subleases/:id/terminate`.

Auth gate via the `Leases` row's existing perm
(`leases.create` / `leases.terminate`).

### Tenant frontend — `SubleaseSection` on LeasePage

New section rendered at the bottom of `apps/tenant/src/pages/LeasePage.tsx`
when the lease is fully-executed + active.

- "+ Request sublease" button opens a modal with the four
  required fields (sublessee_email, start_date, end_date
  [optional], sub_monthly_amount) + optional notes. Submits to
  `POST /api/subleases`.
- List of own subleases (where calling tenant is sublessor OR
  sublessee), each row showing the parties, term, monthly amount,
  status badge, and an "End" action when not already terminated.
- "End" action calls `PATCH /api/subleases/:id/terminate` with a
  required reason.

Empty state: copy explaining "if you need to sublease, submit
a request — your landlord will approve or deny."

### Files touched (S198)

```
apps/api/src/services/notifications.ts                                  (+ 3 sublease notification helpers)
apps/api/src/routes/subleases.ts                                        (POST/PATCH wired notification emissions)
apps/landlord/src/pages/SubleasesPage.tsx                               (NEW — list, decide, terminate)
apps/landlord/src/main.tsx                                              (+ /subleases route + import)
apps/landlord/src/components/layout/Layout.tsx                          (+ Subleases nav entry)
apps/tenant/src/pages/LeasePage.tsx                                     (+ SubleaseSection rendered for active fully-executed leases; component with request modal + own-subleases list + terminate modal)
```

### Verification

- `cd apps/api && npx tsc --noEmit` → 0
- `cd apps/landlord && npx tsc --noEmit` → 0
- `cd apps/tenant && npx tsc --noEmit` → 0
- No schema migrations
- Smoke deferred (Nic's bench)

## Decisions made (S198)

| Question | Decision |
|---|---|
| Email + in-app + SMS, or just in-app? | In-app + email. SMS is for urgent operational events (entry requests, emergency maintenance); sublease lifecycle is administrative — email is enough notice. Phase 3 can add SMS for the auto-terminate-on-end-date case if Nic wants. |
| Landlord-side: dedicated SubleasesPage or section on LeasesPage? | Dedicated page. Subleases are a distinct lifecycle from leases (different actions: approve/deny, not edit). Mixing them in the LeasesPage table would clutter both surfaces. The /subleases route also makes the URL self-explanatory for direct navigation. |
| Tenant-side: dedicated page or section on LeasePage? | Section. Tenants only see their own subleases; the count is small (most tenants will have 0 or 1). Dedicated nav entry would be wasted real estate. Embedded in LeasePage keeps related-context together. |
| Terminate auth: include "tenant on master lease" or only the three parties (sublessor, sublessee, landlord)? | Only the three parties. Other tenants on the master lease (cosigners, roommates) shouldn't be able to end someone else's sublease. The backend already enforces this via the auth check. |
| Auto-approve case (subleasing_allowed='allowed'): notify landlord? | No. Auto-approved = lease policy says no consent needed. Landlord still sees the row in their /subleases list when they next look. Pinging them adds noise without action. |
| Notification recipients on terminate: skip the trigger? | Yes. The party who triggered the action already knows; pinging them is noise. The OTHER two get notified. |
| Show the section on inactive leases? | No. Component-level guard checks `lease.status === 'active' && fullyExecuted`. A pending or expired lease shouldn't surface sublease workflow. |
| Frontend uses existing `apiPatch` helper or inline `fetch`? | Tenant uses inline fetch (matches the existing tenant page patterns; `get`/`post` exist but no `patch`). Landlord uses `apiPatch` from lib/api. Both work; keeping each app's idiom consistent. |

## Carry-forward — phase 3

### Specific to sublease subsystem

- **Sublessee invite-by-email** — currently the sublessee must
  already be a GAM tenant. Phase 3 generates an invitation
  token + email when the sublessee email isn't found; sublease
  stays in 'pending' until sublessee accepts (creates tenant
  account) AND landlord approves.
- **Sub-tenant billing wire-up** — the sublease records the
  `sub_monthly_amount` and `master_share_amount` but no
  `payments` rows flow yet. Wire the sub-tenant to pay through
  GAM (likely via Stripe Connect destination charges
  post-S113); split between sublessor's pocket and landlord's
  master rent.
- **End-of-term auto-termination** — when end_date hits,
  status='active' subleases should auto-flip to 'terminated'
  via a daily cron. Quarter-session.
- **Credit-ledger events** — `sublease_*` event types added to
  `CREDIT_EVENT_TYPES` so the tenant's behavior on a sublease
  scores. Half-session if Nic decides what scoring weight makes
  sense.

### Already-known carry-forward (unchanged)

- Stripe Connect S113 destination charges rebuild (real pre-launch blocker)
- B1+B2 material-change workflow (multi-session)
- C1 50-state property tax form catalog (multi-session)
- POS Terminal hardware + EOD
- B3 thread polish (S191)
- A3 thread continuations
- Primary manager urgency tier (S185)
- Owner-financial-escalation pattern (S186)
- Other POS tables for property scoping (S192)
- D2 Flex tenant suite (launch-flag gated)
- CSV imports (vendor format specs)
- E2 npm upgrades (risky)
- F1 Marketing rebuild (positioning paragraph)

---

End of S198 handoff.

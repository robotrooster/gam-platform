# Session 197 — closed

## Theme

Sublease subsystem phase 1 — backend wiring of the long-existing
`subleases` table. Schema was in `initial_schema.sql` since day
one but had ZERO consumer code. Phase 1 ships the
request/decision/terminate/list workflow at `/api/subleases`.

Phase 2 (next session): tenant + landlord frontend surfaces,
notification emission, sublessee invitation-by-email flow (phase
1 requires sublessee to already be a GAM tenant).

Phase 3 (later): sub-tenant billing wire-up — money flow from
sublessee → sublessor → master rent.

## What S197 shipped

### `routes/subleases.ts` — five endpoints, lifecycle-aware

| Endpoint | Purpose | Auth |
|---|---|---|
| `POST /api/subleases` | Sublessor (tenant) requests a sublease | tenant role only |
| `PATCH /api/subleases/:id/decision` | Landlord approves/denies | requireLandlord + canManageLandlordResource |
| `PATCH /api/subleases/:id/terminate` | Sublessor / sublessee / landlord ends an active sublease | any of three parties |
| `GET /api/subleases` | List scoped per role | requireAuth (tenant=own, landlord=their leases, admin=all) |
| `GET /api/subleases/:id` | Single sublease detail | tenant on either side, or landlord on master lease, or admin |

### Lifecycle honors `leases.subleasing_allowed`

- **`'prohibited'`** → POST returns 409, request rejected outright
- **`'with_consent'`** → status='pending', requires landlord decision
- **`'allowed'`** → status='active' immediately, landlord_consent_date stamped on creation

Status transitions enforced:
- `pending → active` (approve)
- `pending → terminated` (deny, terminated_reason='landlord_denied')
- `active → terminated` (any party, terminated_reason captures who triggered + their note)

### Validation

- Master lease must exist + status='active' + caller-tenant must be on the active roster
- Sublessee must already be a GAM tenant (looked up by email; phase 2 adds invitation flow)
- Sublessor and sublessee can't be the same person (DB CHECK enforces; route catches early for cleaner error)
- end_date (optional) must be ≥ start_date
- `master_share_amount` defaults to `sub_monthly_amount` (full pass-through; phase 2 adds sublessor markup model)

### Mounted

`apps/api/src/index.ts` — `subleasesRouter` mounted at `/api/subleases`,
imported alongside `leasesRouter` per existing pattern.

### Files touched (S197)

```
apps/api/src/routes/subleases.ts                                (NEW — 5 endpoints, ~280 lines)
apps/api/src/index.ts                                           (+ import + mount at /api/subleases)
```

### Verification

- `cd apps/api && npx tsc --noEmit` → 0
- No schema migrations (subleases table existed since initial_schema)
- No frontend changes (phase 2)
- Smoke deferred — endpoints reachable but no UI to exercise them
  yet; cURL-able via `curl -H "Authorization: Bearer $TOKEN" http://localhost:4000/api/subleases`

## Decisions made (S197)

| Question | Decision |
|---|---|
| Phase 1 scope: include sublessee invite-by-email or require pre-existing GAM tenant? | Pre-existing only. Invitation flow has overlap with the existing tenant onboarding path (token + email + acceptance) — better as its own session in phase 2 with a dedicated workflow rather than half-built here. Returns a clear 400 message guiding sublessor to have sublessee register first. |
| Auto-approve when `subleasing_allowed='allowed'`? | Yes. The lease's policy says "no consent needed"; the route reflects that by stamping `landlord_consent_date=NOW()` on creation rather than waiting for an explicit approve POST. Landlord can still terminate after the fact via `/terminate`. |
| `master_share_amount` default — full pass-through or scaled? | Full pass-through (= sub_monthly_amount). Phase 2 adds sublessor markup. Splitting the rent under a sublease is a product fork (does the sublessor keep the markup as profit? does it offset what they owe the master? Both?) — defer until product call settles. |
| Terminate auth — restrict to one party? | Allow any of the three. Sublessor wants out (sublessee broke terms); sublessee wants out (relocating); landlord wants out (lease violation surfaced). Each gets a distinct `terminated_reason` prefix so the audit trail captures who triggered. |
| Money flow / billing wire-up this session? | No. Subleases recorded; master lease billing continues unchanged. Phase 3 adds `payments` rows for sub-tenant → sublessor → master flow once Nic locks the markup model and the Stripe Connect S113 rebuild lands (sub-tenant payments would route through the same Connect pathway). |
| Notification emission this session? | No. Frontend is the next dependency; without UI, a tenant has no place to see "your landlord approved your sublease." Phase 2 ships notifications + UI together. |
| Credit-ledger event types for sublease lifecycle? | No. CREDIT_EVENT_TYPES doesn't include `sublease_*` events. Adding them is a v1.1.0 formula consideration — the sublessee's payment-on-time-via-sublease and the sublessor's landlord-trust signal are both meaningful but the scoring weights need product calibration. Defer. |

## Carry-forward

### Sublease subsystem follow-on (phase 2 — next session if Nic wants)

- **Tenant frontend**: lease detail page gets "Request sublease" button → modal → POST. Active subleases shown on tenant dashboard with status badge.
- **Landlord frontend**: pending sublease decisions shown in `/me/todos`. Detail page with approve/deny modal.
- **Notifications**: `notifySubleaseRequested` (to landlord on POST), `notifySubleaseDecision` (to sublessor on approve/deny), `notifySubleaseTerminated` (to other parties on terminate).
- **Sublessee invitation-by-email**: when sublessee email isn't a GAM tenant, generate an invitation token + email; sublease stays in 'pending' until sublessee accepts AND landlord approves.

### Phase 3 — billing

- Sub-tenant payments flow through the master lease's Stripe Connect destination charges (post-S113 rebuild).
- Decide: does sublessor pocket the markup or does it offset what they owe? Product call.

### Already-known carry-forward (unchanged)

- Stripe Connect S113 destination charges rebuild
- B1+B2 material-change workflow (multi-session)
- C1 50-state property tax form catalog (multi-session)
- POS Terminal hardware + EOD
- B3 thread polish (S191)
- A3 thread continuations (S188-S194)
- Primary manager urgency tier (S185)
- Owner-financial-escalation pattern (S186)
- Other POS tables for property scoping (S192)
- D2 Flex tenant suite (launch-flag gated)
- CSV imports (vendor format specs)
- E2 npm upgrades (risky)
- F1 Marketing rebuild

---

End of S197 handoff.

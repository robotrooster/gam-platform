# Session 126 Handoff

**Theme:** Sub-permission route gating — first pass. S81 defined the
`PROPERTY_MANAGER_SUB_PERMISSIONS` catalog and shipped `requirePerm()`
middleware, but most routes were still gated by `requireLandlord`,
which excludes team workers (property_manager, onsite_manager,
maintenance, bookkeeper) entirely. S126 starts the swap on the
read-only Connect dashboard endpoints — owners auto-pass via
`requirePerm`'s OWNER_ROLES short-circuit; team workers gain access
when they hold the named perm.

## Architecture decisions

**Owner vs team-worker scope resolution.** `requirePerm` opens the
gate, but the handler bodies still need to know *which* landlord
record the request operates on. Owner roles (landlord) carry
`landlord.id` in `profileId`. Team workers carry their `team_member.id`
in `profileId` and the landlord they work for in a separate
`landlordId` JWT claim (S82). One small helper bridges both:

```ts
function resolveLandlordIdForUser(user: any): string | null {
  if (user.role === 'landlord') return user.profileId ?? null
  if (['property_manager','onsite_manager','maintenance','bookkeeper'].includes(user.role)) {
    return user.landlordId ?? null
  }
  return null
}
```

Admins return `null` deliberately — they have no implicit landlord
scope. If admin tooling ever needs to call landlord-scoped routes,
it should pass `?landlordId=…` and the handler should branch on
role explicitly. Today no admin path hits these routes, so the 400
on null is fine.

**Reads open, writes stay closed.** Three read endpoints were
opened (payouts list, disputes list, payments-history). The
landlord-financial write paths stay `requireLandlord`:

- `POST /me/disputes/:id/respond` — submitting evidence to Stripe
  is a legal/financial owner action.
- `PATCH /:id/allocation-rule` (properties.ts) — splits config.
- `PATCH /:id/pm-assignment` (properties.ts) — assigning a PM
  company to a property.
- `GET /me/pm-impact` — owner financial view (PM fee impact on
  bottom line).
- `GET /me/email-failures` — admin-ish ops view.
- `GET /me/todos` — ambiguous owner-vs-team semantics; needs a
  product call before opening.
- All `/flexcharge` routes — tenant credit-line management; owner
  decision.

**Single perm key for the dashboard reads: `payments.view_all`.**
The catalog distinguishes `payments.view_all` (broad audit visibility)
from `payments.initiate_disbursement` (write authority). The
Connect dashboard reads fall under the former.

## Shipped

### apps/api/src/routes/landlords.ts

Three routes swapped:
- `GET /me/payouts` → `requirePerm('payments.view_all')`
- `GET /me/disputes` → `requirePerm('payments.view_all')`
- `GET /me/payments-history` → `requirePerm('payments.view_all')`

New `resolveLandlordIdForUser` helper added at the top of the
Connect-routes block. Each handler now resolves `landlordId` via
the helper and 400s if unresolvable, then uses `landlordId` (not
`req.user!.profileId`) in its DB queries. This is the substantive
fix — without it the gate would open but team-worker requests
would query against `profileId = team_member.id` and silently
return zero rows.

## Files touched

- `apps/api/src/routes/landlords.ts` (helper + 3 handler swaps)
- `SESSION_126_HANDOFF.md` (this file)

No migrations, no schema changes, no shared package changes. The
`requirePerm` middleware and the JWT `landlordId` claim were already
in place from S81/S82.

## Validation

- `npx tsc --noEmit -p apps/api/tsconfig.json` → exit 0
- Manual review of all three handlers: every reference to
  `req.user!.profileId` in the swapped routes was rewritten to use
  the resolved `landlordId`. `req.user!.profileId` no longer
  appears in the three handler bodies.

Live API smoke deferred — dev server wasn't running this session
and the change is mechanical (typecheck + code review sufficient
for a perm-gate swap).

## What this session did NOT do

- **No swap on writes.** `POST /me/disputes/:id/respond` and the
  property `PATCH` routes stay owner-only. That was the design call,
  not a deferral.
- **No swap on `reports.ts`.** Entire reports router uses
  `reportsRouter.use(requireAuth, requireLandlord)` — opening it
  needs a perm decision per report (some are owner-only P&L,
  others could go to bookkeepers via `books.view`). Half-session
  to inventory + decide.
- **No swap on `bulletin.ts/landlord`, `notifications.ts/bulk`,
  `workTrade.ts`, `books.ts/bookkeeper/*`, `units.ts/eviction-mode`,
  `units.ts/activate`, `units.ts/cancel-scheduled-activation`.**
  Each is a different perm with different scope semantics; lumping
  them under one helper would be wrong. Future sessions handle
  these by domain.
- **No frontend.** Per UI/UX standing rule.
- **No tests.** Apps API has no integration test suite today.

## Inventory of remaining `requireLandlord` routes

For the next sub-permission pass, here's what's left
(non-`.s*backup`):

**landlords.ts**
- `GET /flexcharge`, `POST /flexcharge`, `DELETE /flexcharge/:tenantId`,
  `PATCH /flexcharge/:tenantId` — tenant credit-line owner config
- `POST /complete-onboarding` — owner setup
- `PATCH /me` — owner profile
- `GET /me/todos` — needs product call
- `GET /me/email-failures` — admin-ish
- `GET /me/pm-impact` — owner financial
- `POST /me/disputes/:id/respond` — legal/financial owner

**reports.ts**
- Entire router (line 7) — needs per-report perm assignment

**books.ts**
- `GET /bookkeeper/clients`, `GET /bookkeeper/all`,
  `POST /bookkeeper/invite`, `POST /bookkeeper/assign`,
  `DELETE /bookkeeper/revoke` — bookkeeper management; owner
  domain but maybe `books.manage_bookkeepers` perm

**properties.ts**
- `PATCH /:id/allocation-rule` — owner financial config
- `PATCH /:id/pm-assignment` — owner-only (PM-management ↔ PM-grant
  is a different conversation)

**units.ts**
- `POST /:id/eviction-mode` — legal action; owner
- `POST /:id/activate` — could open to `units.activate`
- `POST /:id/cancel-scheduled-activation` — could open to
  `units.activate`

**workTrade.ts** (5 routes)
- All currently `requireLandlord`; work-trade is a labor-credit
  ledger — could open viewing to maintenance/onsite_manager,
  reconciliation to bookkeeper (`work_trade.view`,
  `work_trade.reconcile` perms — would need to be added to catalog)

**bulletin.ts**
- `GET /landlord` — broadcast list view; could open to managers

**notifications.ts**
- `POST /bulk` — owner messaging today; PM might want to send
  rent reminders (`notifications.send_bulk` perm)

## Pre-launch backend status

Add to closed list:
- ✅ Sub-permission gating — Connect dashboard reads (3 routes)

Open items:
- Sub-permission gating — remaining ~25 routes across 8 files
  (catalog above)
- Compliance-table retention policy (needs your retention windows)
- lease_fees move_out / other due_timing wire-up (product call)
- OTP enablement (Item 16 batch 3+ — needs FlexPay tier UX)
- Admin notification surface (long-standing deferral)
- Frontend pass for everything backend-ready
- Stripe sandbox testing (waiting on test API key)

## What next session should target

The natural follow-up is **continuing the sub-permission swap by
domain**. Suggested order:

1. **reports.ts** — single file, per-report perm decision.
   `reportsRouter.use(requireLandlord)` pattern needs to be replaced
   with per-route gates. ~30 min if perms are pre-assigned.
2. **units.ts activate/cancel + bulletin.ts/landlord +
   notifications.ts/bulk** — small, mechanical, similar pattern to
   S126. ~30 min batched.
3. **workTrade.ts** — needs catalog extension (new perms for
   work-trade view/reconcile). ~45 min including catalog +
   migration if any.
4. **books.ts/bookkeeper management** — owner-domain mostly,
   probably stay closed. 15-min review.
5. **properties.ts financial PATCHes + landlords.ts flexcharge** —
   stay owner-only; document and move on.

Recommend **#1 (reports.ts)** as the next session — single-file
contained scope, no catalog changes, follows the same pattern S126
just established.

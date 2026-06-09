# Session 247 — closed

## Theme

Sublease money flow + invite flow + property-level toggle. Phase 2/3
of the sublease subsystem — the workflow plumbing (request /
approve / terminate / end-of-term) was shipped S197-S199; this
session wires the money side and the real-world invite scenario
(sublessee not yet a GAM tenant). Picked while waiting on FlexCredit
vendor callbacks (Esusu email queue, CredHub callback pending).

## Product spec decisions (Nic-confirmed)

| Question | Decision |
|---|---|
| Sublease cash flow? | **Model (a)**: sublessee pays GAM directly. `master_share_amount` routes to landlord (normal rent path); `sub_monthly_amount − master_share_amount` accrues to sublessor as a withdrawable credit balance. GAM never has visibility-asymmetry between the two parties — both are GAM tenants. |
| Landlord toggle? | **Property-level** boolean (`properties.subleasing_allowed`). AND'd with the existing `leases.subleasing_allowed` enum: a sublease request is allowed iff property allows AND lease enum is not 'prohibited'. Property is the master switch driven by the landlord's legal lease document; lease enum is the per-tenancy refinement. |
| GAM fee on sublease? | **None.** Drop the proposed 1% sublease-specific fee. GAM revenue from a sublease compounds naturally: ACH/card processing margin on the sublessee's payment + each party (sublessor + sublessee) independently eligible for Flex products (FlexPay, FlexDeposit, future FlexCharge/Credit). Adding a third fee on top would be triple-dipping. |
| Sublessee onboarding? | **Option (ii) — invite-via-email flow**. Sublessor enters sublessee email at request time. If email matches an existing GAM tenant, current path (immediate 'pending' status). If not, create a `sublessee_invitations` row + email the invite + sublease in 'pending_invite' status. Sublessee follows link, signs up + ACH-verifies + completes BG, sublease flips to 'pending' for landlord decision. |

## Items shipped

### Schema migration — `20260511130000_sublease_money_flow.sql`

- `properties.subleasing_allowed` boolean (default FALSE, opt-in)
- `subleases.sublessee_tenant_id` becomes NULLABLE (was NOT NULL).
  Required for the invite flow — sublease row exists without a
  tenant id until the invitee accepts.
- `subleases.sublessee_invitation_id` FK to invitations table
- `subleases.status` CHECK extended to include `'pending_invite'`
- New `sublessor_credit_balances` table: one row per sublease,
  tracks accrued markup (balance + total_earned + total_withdrawn,
  UNIQUE on sublease_id, balance ≥ 0)
- New `sublessee_invitations` table: token (UNIQUE), sublessor /
  master lease / sublessee email / amounts / dates / notes,
  status enum (sent/accepted/expired/cancelled), expires_at
  (14 days from issue), accepted_tenant_id + accepted_at,
  sublease_id back-link

### Schema migration — `20260511130100_sublease_credit_idempotency.sql`

- `payments.sublease_credit_applied` boolean (default FALSE) —
  idempotency marker for the webhook-triggered sublessor markup
  credit. Set TRUE inside the same transaction that bumps
  sublessor_credit_balances.

### Sublease request route — `apps/api/src/routes/subleases.ts`

- **POST /api/subleases** now JOINs property + checks both gates:
  property must allow subleasing AND lease enum must not be
  'prohibited'.
- Sublessee-email lookup branches: existing tenant → current path
  ('pending' or 'active' depending on lease enum); missing →
  invite path (creates `sublessee_invitations` row with 32-byte
  hex token + 14-day expiry, creates sublease in 'pending_invite'
  status with sublessee_tenant_id=NULL + invitation_id linked).
- Invite-flow emits the public accept-link email via new
  `sendSubleaseInvite` helper in services/email.ts.
- Landlord notification only fires when status='pending' AND
  sublessee exists (pending_invite is sublessee-onboarding-pending;
  landlord doesn't see the sublease until acceptance).
- GET list queries (tenant/landlord/admin) updated to LEFT JOIN
  sublessee tenant (was INNER JOIN; would've excluded pending_invite
  rows entirely). Landlord list filters out pending_invite rows.

### Public accept route — `apps/api/src/routes/subleaseInvitations.ts` (new)

Separate router (mounted at `/api/sublease-invitations`) because
these endpoints are pre-authentication — token in the URL is the
only credential.

- **GET /:token** — public preview. Returns property name, unit,
  sublessor name, amounts, dates. Used by the accept-page UI.
- **POST /:token/accept** — onboards the sublessee. Validates
  token + expiry + status, creates user + tenant rows, flips
  invitation to 'accepted' + sublease to 'pending', notifies
  landlord via existing `notifySubleaseRequested`, returns JWT
  so the new tenant can land in the portal to verify ACH + complete
  BG check.

### Sublessor markup credit — `apps/api/src/services/subleaseAllocation.ts` (new)

- `creditSublessorMarkupForPayment(paymentId)` — webhook hook.
  Looks up active sublease covering this (unit, due_date) where
  payer = sublessee. Computes markup = sub_monthly_amount −
  master_share_amount. Upserts sublessor_credit_balances. Sets
  payments.sublease_credit_applied=TRUE for idempotency. No-op
  when no sublease, payer mismatch, or markup ≤ 0.
- Wired into webhook `payment_intent.succeeded` handler alongside
  OTP / FlexPay / FlexDeposit reconcilers.

### Invoice generation sublease branch — `apps/api/src/jobs/invoiceGeneration.ts`

Per-cycle, per-lease branch: queries for active sublease covering
the cycle's due_date. When present:
- `effectiveTenantId = sublease.sublessee_tenant_id` (invoice +
  payments rows address the sublessee, not the master tenant)
- `effectiveRentAmount = sublease.sub_monthly_amount` (sublease
  rent replaces master rent on the rent row)
- Monthly fees + utilities also route to sublessee (occupant
  responsibility model)

Master-lease invoice generator now produces the correct invoice
addressed to whoever currently occupies the unit per the
sublease state. Sublessor's "rent due" stops appearing in their
view; sublessor sees credit balance accrue instead.

### Sublease invite email — `apps/api/src/services/email.ts`

New `sendSubleaseInvite()` — branded HTML email with:
- Property + unit + amounts + date range
- Accept-link button → `${TENANT_APP_URL}/sublease-invite/${token}`
- Disclosure: signup + ACH + BG required; landlord still reviews
  after acceptance; 14-day expiry
- Logged to `email_send_log` with category `sublease_invite`

### Property toggle UI — `apps/landlord/src/pages/PropertiesPage.tsx`

- Form state: `subleasing_allowed` boolean derived from
  `property.subleasingAllowed`
- New "Subleasing policy" section in the edit form (alongside
  Booking policy), gold-highlighted when enabled
- Copy: "Allow subleasing at this property — Tenants on leases at
  this property may request subleases (subject to each lease's own
  subleasing clause). Disable if your lease agreement prohibits
  subleasing. Check your local laws — some jurisdictions limit
  a landlord's ability to refuse subleases unreasonably."
- `properties.ts` PATCH route accepts `subleasing_allowed` boolean
  via COALESCE

### Tenant sublease UI — `apps/tenant/src/pages/LeasePage.tsx`

- `TenantSublease` type extended: status includes 'pending_invite',
  sublessee_name + sublessee_tenant_id are nullable,
  invitation_status + invitation_expires_at added
- Request modal copy updated: "If the sublessee doesn't have a
  GAM account yet, we'll email them an invitation to sign up —
  your request stays pending until they accept."
- Row display: shows sublessee email when no tenant name yet,
  pending_invite-specific row showing "Invitation sent to X.
  They have until Y to accept and sign up."
- Status badge gains a blue 'awaiting accept' variant for
  pending_invite. Terminate button hidden for pending_invite
  (sublease isn't real yet).

## Decisions made during build

| Question | Decision |
|---|---|
| One sublease row at request, or wait for accept? | One row at request, status='pending_invite' with NULL sublessee_tenant_id. Acceptance flips to 'pending' + fills the tenant id. Simpler than a separate "draft" state and lets sublessor see/cancel their pending invitation. |
| Idempotency for sublessor credit? | New boolean column on payments (`sublease_credit_applied`) — set inside the same transaction that bumps the credit balance. Tried ON CONFLICT on a uniquely-keyed insert first; abandoned because user_balance_ledger has its own type CHECK enum that doesn't include sublease, and adding a new type value would touch all ledger consumers. The boolean is cleaner and tightly scoped. |
| Invitation expiry? | 14 days. Same as the OnTimePay invite copy ("invitation expires in 14 days") and a reasonable window for a friend/family invite to be acted on. |
| Where to mount the accept router? | Separate `/api/sublease-invitations` router because the existing `subleasesRouter` applies `requireAuth` to all routes. Mixing pre-auth + post-auth in one router would require route-level overrides. |
| Token shape? | 32-byte hex (256 bits of entropy), generated via `crypto.randomBytes`. UNIQUE index on the column. Single-use-shaped — status='accepted' makes re-use a 409. |
| Should landlord see pending_invite subleases? | No. Filtered out in the landlord-role GET query. Invitation isn't accepted; landlord has nothing to decide. Once accepted, status flips to 'pending' and lands in their queue. |
| Sublessor credit withdrawal route this session? | Deferred. The accrual works; the withdraw surface is one POST route + UI + Connect Transfer call — a clean follow-up session. Withdraw will move balance → tenant's connected bank via Stripe Transfer (or held against next rent owed, if any). |

## Files touched (S247)

```
apps/api/src/db/migrations/
  20260511130000_sublease_money_flow.sql              (new — 92 lines)
  20260511130100_sublease_credit_idempotency.sql      (new — 11 lines)
apps/api/src/db/schema.sql                            (regenerated)
apps/api/src/routes/subleases.ts                      (~ property gate
                                                       + invite branch
                                                       + GET LEFT JOINs;
                                                       ~+120 / -25)
apps/api/src/routes/subleaseInvitations.ts            (new — 220 lines)
apps/api/src/index.ts                                 (+ router import
                                                       + mount)
apps/api/src/services/subleaseAllocation.ts           (new — ~115 lines)
apps/api/src/services/email.ts                        (+ sendSubleaseInvite
                                                       ~ +55 lines)
apps/api/src/routes/webhooks.ts                       (+ credit hook on
                                                       payment_intent.succeeded;
                                                       ~+10 lines)
apps/api/src/jobs/invoiceGeneration.ts                (~ sublease branch:
                                                       effective tenant +
                                                       rent for rent/fees/
                                                       utilities;
                                                       ~+25 lines)
apps/api/src/routes/properties.ts                     (~ PATCH accepts
                                                       subleasing_allowed)
apps/landlord/src/pages/PropertiesPage.tsx            (+ Subleasing
                                                       policy toggle in
                                                       property form;
                                                       ~+45 lines)
apps/tenant/src/pages/LeasePage.tsx                   (~ TenantSublease
                                                       type + pending_invite
                                                       status badge + invite
                                                       row display;
                                                       ~+30 lines)
DEFERRED.md                                           (~ sublease tombstone
                                                       + 4 follow-up items)
SESSION_247_HANDOFF.md                                (this file)
```

## Verification

- `cd apps/api && npx tsc --noEmit` → clean
- `cd apps/landlord && npx tsc --noEmit` → clean
- `cd apps/tenant && npx tsc --noEmit` → clean
- Migrations applied: `\d sublessee_invitations` confirms 15
  columns + UNIQUE on token + 4 indexes; `\d subleases` confirms
  sublessee_tenant_id nullable + sublessee_invitation_id FK
  added + status CHECK includes pending_invite
- `\d payments` confirms sublease_credit_applied boolean column

## Carry-forward — S248+

### Sublease follow-ups (small, can clear in 1 session)

1. **Sublessor credit-balance withdrawal**: `POST /api/sublease/me/credit/withdraw {amount}` — fires Stripe Transfer to sublessor's Connect account, decrements balance, increments total_withdrawn. UI tile on sublessor dashboard showing accrued balance + "Withdraw" button.
2. **Sublease document upload + e-sign**: hook `services/esign.ts` so subleases can require both parties to sign a generated agreement before status='active'. Populates the dead `sublease_document_url` column.
3. **Admin sublease frontend**: backend already supports admin role; add a list page at `/subleases` in apps/admin.
4. **Liability disclosure copy**: tenant request modal should state "By submitting, you acknowledge you remain on the master lease and joint-and-severally liable for rent if your sublessee defaults." Landlord-configurable per state under no-state-legal-logic rule.

### Flex Suite remaining

- **FlexCredit** — pending vendor pick (CredHub callback / Esusu email pending). Two open vendor questions to confirm before building (per-tenant wholesale, onboarding latency, dispute pipeline, furnisher-of-record).
- **FlexCharge** — total rebuild. `flex_charge_accounts` /
  `flex_charge_transactions` tables don't exist; routes target
  nonexistent tables. RV/extended-stay credit-account product
  with POS integration. Multi-session.

### FlexDeposit follow-up

- **Deposit portability across leases on GAM platform.** When a
  tenant moves from Landlord A's unit to Landlord B's unit on
  GAM, deposit re-points to new unit and custody fee continues.
  Touches lease-end + deposit-return engine.
- **Missed-installment legal remedy.** Nic pending spec.

### External-vendor-blocked

- **Checkr Partner** — credentials still pending per Nic.

## Revised count

S247 closes the major Sublease money/invite gap. Remaining sublease
follow-ups are all small (1 session each); remaining Flex products
need vendor (FlexCredit) or are multi-session (FlexCharge).

| Bucket | Pre-S247 | Post-S247 |
|---|---|---|
| Sublease | money/invite/property-toggle gaps | 4 small follow-ups left |
| Flex products | 2 remaining | 2 remaining (FlexCharge multi-session; FlexCredit vendor-pending) |
| Multi-session epics | 1 (Sublease, mostly remaining) | 1 (FlexCharge) |

**Until v1 launch-ready:** ~4-5 sessions. Either FlexCharge (when
ready), FlexCredit (when vendor lands), Sublease small follow-ups
(any time), FlexDeposit portability (any time), or Checkr Partner
(when credentials arrive).

---

End of S247 handoff.

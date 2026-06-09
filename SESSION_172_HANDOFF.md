# Session 172 — closed

## Theme

Per-property fee-payer configuration UI. Backend (S116) split the
legacy `banking_fee_payer` single toggle into three independent
columns — `ach_fee_payer`, `card_fee_payer`, `platform_fee_payer`
— but the landlord property form was still on the legacy
single-toggle model. A landlord could not, e.g., absorb the
$0–$6 ACH fee while passing through the meatier 3.25% card fee
to tenants. S172 closes that gap and unlocks live edits to
fee-payer settings post-creation.

## What S172 shipped

### Backend — `PATCH /api/properties/:id/allocation-rule` extended

Pre-S172 the route accepted `owner_bank_account_id` only — every
other allocation field was create-time-only. S172 adds the three
fee-payer toggles to the accepted body shape:

```ts
z.object({
  owner_bank_account_id: z.string().uuid().nullable().optional(),
  ach_fee_payer:         z.enum(FEE_PAYER_VALUES).optional(),
  card_fee_payer:        z.enum(FEE_PAYER_VALUES).optional(),
  platform_fee_payer:    z.enum(FEE_PAYER_VALUES).optional(),
})
```

All four optional. The handler builds a dynamic UPDATE clause
from only the fields the caller sent (rejects empty body with
400). Manager-fee math (rent_percent, flat_monthly_fee,
per_unit_fee, etc.) and placement / maintenance fields stay
create-time-only because they affect retroactive ledger
interpretation; the fee_payer toggles only govern who pays the
**next** charge so they're safe to flip live.

Auth unchanged: `requireLandlord` +
`canManageLandlordResource(req.user, prop.landlord_id, [])` —
financial-control authority only, no team roles.

### Frontend — `apps/landlord/src/pages/PropertiesPage.tsx`

- **`FeePayerToggle` component** added above `AddEditModal`. A
  reusable pair of buttons with the label, hint copy (e.g. "1.0%
  capped at $6.00 per ACH debit"), and tenant/landlord radio
  semantics. Driven by `FEE_PAYER_VALUES` from `@gam/shared`.
- **AddEditModal form state:** legacy `banking_fee_payer` field
  removed; replaced by three independent `ach_fee_payer`,
  `card_fee_payer`, `platform_fee_payer` fields. Pre-fills from
  the existing `allocationRule.achFeePayer` etc. on edit; falls
  back to `bankingFeePayer` for properties created pre-S116, or
  to defaults (`tenant` for ACH/card, `landlord` for platform)
  for brand-new rows.
- **Three toggles rendered in BOTH create and edit modes** —
  pre-S172 the single Banking Fee toggle was hidden in edit mode
  ("financial fields create-only"). Now landlords can flip
  fee_payer settings on existing properties without recreating.
- **Edit-mode save flow:** the propMut `useMutation` builds a
  delta against the existing `property.allocationRule` and
  PATCHes `/properties/:id/allocation-rule` with only changed
  fields (owner_bank_account_id + the three fee_payers). Skips
  the PATCH if the delta is empty.
- **Create-form payload:** posts the new triple-toggle shape.
  The legacy `banking_fee_payer` field is no longer sent; the
  backend's mirror-from-banking_fee_payer fallback (kept for
  pre-S116 callers) becomes redundant for the GAM-built UI.
- **Section heading + helper copy** explains the model
  ("Tenant pays" = added on top of rent / "Landlord absorbs" =
  deducted from gross) plus a one-line note that the toggles
  affect future charges only.

### Files touched (S172)

```
apps/api/src/routes/properties.ts                                       (PATCH /allocation-rule extended with fee_payer fields + dynamic UPDATE)
apps/landlord/src/pages/PropertiesPage.tsx                              (FEE_PAYER_VALUES + FeePayer import; FeePayerToggle component; 3-toggle UI in create+edit modes; allocation-rule PATCH delta on edit)
```

### Verification

- `cd apps/api && npx tsc --noEmit` exit 0
- `cd apps/landlord && npx tsc --noEmit` exit 0
- `cd apps/tenant && npx tsc --noEmit` exit 0
- `FEE_PAYER_VALUES = ['landlord', 'tenant'] as const` confirmed in
  `packages/shared/src/index.ts:2201` (the single source of truth
  consumed by both backend zod and the new frontend toggle).
- Backend default-when-omitted preserved: ACH/card default to
  'landlord' if no body field nor legacy mirror present
  (route `properties.ts:128-130`); platform_fee_payer defaults to
  'landlord' on insert (schema default).

## Decisions made (S172)

| Question | Decision |
|---|---|
| Allow live edits of fee_payer post-creation, or keep create-only? | Live edits. The S66 comment ("financial fields create-only") was correct for manager-fee math (rent_percent etc. — affects retroactive ledger reads) but overcautious for fee_payer toggles, which only govern the next charge. Landlords need to be able to change their mind without recreating a property. |
| Three separate toggle UI or one segmented control? | Three separate FeePayerToggle rows — each with its own label + hint explaining what the fee is and how it's sized. A segmented control would be denser but loses the per-fee context (1.0% ACH / 3.25% card / $2-per-unit platform are very different decisions and need their own framing). |
| Show current fee config on the property card / list? | Deferred. The modal is the primary surface today; landlords inspecting fee config will open the modal. Adding a denormalized "ACH: tenant / Card: tenant / Platform: landlord" badge on each property card is a real UX win but it's its own scope (the cards don't currently render any allocation-rule info). |
| Rip the legacy `banking_fee_payer` mirror in the backend? | No. The route still accepts `banking_fee_payer` and mirrors it into ach + card when they aren't provided. Removing the back-compat path would be a breaking change for any external/integration caller; deprecation can wait. The frontend stops sending it as of this session. |

## Carry-forward — what S173 should target

### Property card / list display: who pays what

Cleanest follow-on. Add a small fee-config badge or row on each
property card showing current ach_fee_payer / card_fee_payer /
platform_fee_payer at a glance. Avoids landlords having to open
the edit modal just to verify settings. Estimated half a session.

### `lease_fees.due_timing` `move_out` / `other` wiring product call

DEFERRED still has this listed (pre-S144 entry). S144 shipped
the gap detection — admin notification fires when a lease ends
with unpaid move_out / other fees — but no auto-billing. The
product question (deposit deduction vs tenant invoice; charge
timing on early termination; etc.) needs Nic. Once decided, the
build is small.

### Per-state tax form catalog (DEFERRED Item 3)

`state_forms` table + landlord UI to pick their state's
quarterly forms. Backend filing-deadlines list is federal-only
post-S91. Single-state-per-landlord lookup is one session;
multi-state is bigger.

### Frontend bookkeeper invite UI for the books portal (DEFERRED Item 3)

Backend endpoints live (`POST /api/scopes/bookkeeper/invite`,
S80 canonical email-token flow). Books portal has no UI
consumer. Small session.

### Already-known carry-forward (still open, unchanged)

- Tenant rent + utility smoke walk (manual, blocked on Stripe
  sandbox creds — see SESSION_171_HANDOFF.md).
- Strip mock `AchVerifyForm` once OTP is greenlit.
- `apps/admin/src/main.tsx` split (~1700 lines mechanical).
- Stripe-Custom-controller migration (product call).
- 4 of 8 npm audit root-vuln packages need breaking upgrades.

---

End of S172 handoff.

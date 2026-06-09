# Session 171 — closed

## Theme

Tenant utility-bill payment surface — closes the second pay-rail
gap (after S169/S170 closed rent). Backend
`POST /api/utility/bills/:id/pay` (S122 destination charges, same
body shape as rent) had no frontend consumer. Tenant `/utilities`
page was a read-only table that referenced four columns the wire
response never produced (`utilityCost` / `adminFee` /
`totalAmount` / `usageAmount` mismatched against actual
`chargeAmount` etc.) — every cell rendered "$undefined" or empty.
S171 fixes both: real columns + Pay button reusing the shared
flow extracted from S169/S170.

## What S171 shipped

### Refactor — `pages/payShared.tsx` (NEW shared module)

Extracted from `pages/PaymentsPage.tsx`:

- `useTenantPaymentMethods()` — react-query hook over
  `GET /stripe/tenant/payment-methods` (S169 endpoint).
- `<PayNowModal target methods onClose onAddMethod onPaid />` —
  generic Pay flow parameterized by a `PayTarget`:
  ```ts
  interface PayTarget {
    amount:    number
    endpoint:  string  // e.g. '/payments/<id>/pay' or '/utility/bills/<id>/pay'
    subheader: string  // displayed under the amount
    kind:      'rent' | 'utility'
  }
  ```
  Picker, success/error states, and authorization copy all
  drive off `target.kind` + `selectedMethod.type`. Uses
  `apiPost(target.endpoint, ...)` against shared `lib/api.ts`
  axios.
- `<AddPaymentMethodModal method onClose onAdded />` — the
  S170 unified ACH/card setup flow, now shared.
- `<SavedMethodsCard methods loading emptyCopy?>` — read-only
  surface showing the tenant's saved banks + cards.
- Types: `SavedPaymentMethod` (discriminated union of
  `SavedAch | SavedCard`), `PayTarget`.
- Internal: `MethodPickerSection`, `PickerRow`, `ModalShell`,
  `PaymentMethodSetupForm`.

### Refactor — `pages/PaymentsPage.tsx` slimmed

Now ~170 lines (was ~470). Owns only:
- The rent payments history table.
- Pay Now buttons on `pending` / `failed` rows.
- Composing the PayTarget for the shared modal:
  ```ts
  endpoint:  `/payments/${p.id}/pay`,
  subheader: `${p.entryDescription} · due ${dueDate}`,
  kind:      'rent',
  ```
- All modal mounting deferred to `payShared.tsx` exports.

Behavior identical to S170. Just less code per page.

### NEW — `pages/UtilitiesPage.tsx`

Replaces the inline `UtilitiesPage` in `main.tsx`. Wired
against the real `GET /api/utility/bills` wire response:

- Columns now reflect the actual response shape:
  **Cycle** (`billingCycleMonth` formatted as "May 2026"),
  **Utility** (`utilityType` mapped via `UTILITY_LABEL`:
  water/gas/electric/sewer/trash → display labels),
  **Meter** (`meterLabel` from `m.label`),
  **Usage** (`usageAmount` numeric, "—" when null),
  **Amount** (`chargeAmount`),
  **Status** (`unbilled` / `billed` / `paid` / `disputed` /
  `void` per `utility_bills_status_check` constraint).
- Pay Now button on rows with `status === 'billed'` —
  unbilled rows can't be paid (server rejects with 409;
  the UI hides the button for clarity), paid/disputed/void
  also hidden.
- PayTarget composed as:
  ```ts
  amount:    asNumber(b.chargeAmount),
  endpoint:  `/utility/bills/${b.id}/pay`,
  subheader: `${utilityName} · ${cycle}${meterLabel ? ` · ${meterLabel}` : ''}`,
  kind:      'utility',
  ```
- `kind: 'utility'` flips the modal's authorization-copy
  variant to "for the utility bill above" instead of "for
  the payment above". Pricing math (1.0% ACH cap-$6 etc.) is
  unchanged — same rates, same `computeApplicationFee` on
  the backend; just clearer surface copy.
- Reuses `<SavedMethodsCard>`, `<PayNowModal>`, and
  `<AddPaymentMethodModal>` from the shared module. + Add
  bank / + Add card CTAs in the page header for
  consistency with PaymentsPage.

### Cleanup — deleted `lib/bankSetup.ts`

Vestigial 33-line file exporting `BankSetupScript` — a string
template of JavaScript intended to be injected into a script tag.
Zero consumers anywhere in the codebase (predates the proper
React + `@stripe/react-stripe-js` Elements wiring that's now
in `payShared.tsx`). Removed.

### Files touched (S171)

```
apps/tenant/src/pages/payShared.tsx                                     NEW (~520 lines — shared payment-method UI)
apps/tenant/src/pages/PaymentsPage.tsx                                  (slimmed: now uses payShared exports; behavior unchanged)
apps/tenant/src/pages/UtilitiesPage.tsx                                 NEW (~190 lines — real columns + Pay button)
apps/tenant/src/main.tsx                                                (replaces inline UtilitiesPage with import)
apps/tenant/src/lib/bankSetup.ts                                        DELETED (zero consumers, predates real wiring)
```

### Verification

- `cd apps/api && npx tsc --noEmit` exit 0
- `cd apps/tenant && npx tsc --noEmit` exit 0
- Backend `/api/utility/bills/:id/pay` already validates
  `{ payment_method_id, payment_method_type: 'ach'|'card' }`
  per `routes/utility.ts:367`. No backend changes needed.
- `utility_bills_status_check` (`unbilled` | `billed` | `paid` |
  `disputed` | `void`) confirmed against
  `apps/api/src/db/schema.sql`. UI Pay button gated on
  `status === 'billed'` matches the server-side gate at
  `utility.ts:391-410` (rejects paid/void/disputed/unbilled with
  409s).

## Decisions made (S171)

| Question | Decision |
|---|---|
| Where do the shared pieces live? | New `pages/payShared.tsx`. Considered `lib/` (matches existing `lib/api.ts`) but the file exports JSX + components, not utilities — co-locating with the consuming pages makes the dependency graph easier to follow. |
| Generic `PayTarget` shape vs domain types? | Generic. `{amount, endpoint, subheader, kind}` covers both surfaces with no per-domain branching inside the modal. The `kind` enum is the only domain coupling and it only flips one line of copy. |
| Refactor PaymentsPage in the same session? | Yes — small risk (no behavior change, full TS coverage), and finishing the extraction in one pass avoids leaving the codebase in a half-extracted state where two pages would have a similar-but-different modal. |
| Fix the broken column references in UtilitiesPage in the same session? | Yes — fix-it-right. The display was definitively rendering undefined values today; touching the page for the Pay button without correcting the column shape would be ignoring rot in a file we're actively editing. |
| Delete `lib/bankSetup.ts`? | Yes. Zero consumers (verified via grep), predates the real Stripe Elements implementation, and cleaning it up while we're modernizing the tenant payments surface is right. Single-file delete; CLAUDE.md only requires asking on multi-file deletes. |

## Carry-forward — what S172 should target

### Rent + utility smoke walk (manual; needs Stripe sandbox creds)

End-to-end flow per portal:
1. Tenant adds a bank via Financial Connections sandbox.
2. Pays a rent payment via ACH → `payments.status` flips to
   `'processing'`, webhook flips it to `'settled'`,
   `application_fee_amount` reflects 1.0% capped $6.
3. Tenant adds a card via Stripe test card 4242 4242 4242 4242.
4. Pays a utility bill via card → `utility_bills.status` flips
   to `'paid'` via webhook (S122 type='utility' branch),
   `application_fee_amount` reflects 3.25%.
5. Repeat with a Canadian test card (4000 1240 0000 0000) →
   verify +1.5% surcharge fires via `computeApplicationFee`.

Not a build session — paste creds, watch dashboards.

### Per-state tax form catalog (DEFERRED Item 3)

`state_forms` table + landlord UI to pick their state's
quarterly forms (CA DE-9, NY NYS-45, AZ A1-QRT, etc.). Backend
filing-deadlines list in `routes/books.ts` is currently
federal-only (S91 stripped AZ A1-QRT/A1-R). Product-scoped
follow-up; a single-state-per-landlord lookup is a 1-session
build, multi-state is bigger.

### Frontend bookkeeper invite UI for the books portal (DEFERRED Item 3)

Backend endpoints live (`POST /api/scopes/bookkeeper/invite`,
S80 canonical email-token flow). Books-portal
`apps/books/src/main.tsx` has no UI consumer. Small session.

### Strip mock `AchVerifyForm` once OTP is greenlit

Still blocked on Nic. Form lives at `main.tsx:643`. Once a
tenant adds a real bank via the new Pay flow,
`tenants.ach_verified` flips server-side and the OTP gate
unblocks "for free" — but the existing OTP scaffold copy
isn't ripped out without explicit greenlight.

### Already-known carry-forward (still open, unchanged)

- `apps/admin/src/main.tsx` split (~1700 lines, ~16 inline
  page funcs) — mechanical refactor, no product gain.
- Stripe-Custom-controller migration — removes "Powered by
  Stripe" branding on embedded onboarding; takes on GAM's
  KYC build burden. Real product call.
- 4 of 8 npm audit root-vuln packages need breaking upgrades
  (esbuild→vite 5→8, pdfjs-dist 3→5, tar transitive,
  uuid→node-cron 3→4). All deferred to dedicated upgrade
  sessions per S96.

---

End of S171 handoff.

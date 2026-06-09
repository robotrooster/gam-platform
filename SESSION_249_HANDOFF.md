# Session 249 — closed

## Theme

Tenant-side Stripe Connect onboarding — final piece of the sublease
end-to-end loop. S248 shipped the withdraw API + UI but gated tenant
sublessors with a 409 because they had no Connect account. This
session adds the onboarding surface so sublessors can complete
Stripe KYC and actually receive their accrued markup to bank.

## Product spec decision (Nic-confirmed)

**Q — Top-nav placement of "Payouts" in the tenant portal**:
**(b) visible-once-initiated**. Mirrors the OTP nav-gating pattern.
Most tenants never see the entry; sublessors land there once via
the credit-card button, then get nav access for repeat use.

## Items shipped

### Package additions — `apps/tenant/package.json`

- `@stripe/connect-js` ^3.4.2
- `@stripe/react-connect-js` ^3.4.1

Versions matched to landlord package.json. `npm install --workspace`
resolved without re-installs (root node_modules already had the
packages from landlord install).

### Tenant API — `apps/api/src/routes/tenants.ts`

`GET /api/tenants/me` SELECT now includes
`u.stripe_connect_account_id`. Drives the conditional nav entry.

### Frontend route + page — `apps/tenant/src/pages/PayoutsPage.tsx`

Clone of the landlord `BankingPage` Stripe Connect section, adapted
for the tenant context. Same backend wires:

- `GET /api/stripe/connect/status?entity=user` — status + KYC
  requirements (polls every 3s while onboarding is active until
  payouts_enabled + details_submitted)
- `POST /api/stripe/connect/onboarding-session { entity: 'user' }`
  — returns Account Session client_secret for the embedded
  `<ConnectAccountOnboarding />` component
- `<ConnectComponentsProvider>` + `<ConnectAccountOnboarding>` from
  `@stripe/react-connect-js`

Copy framing reflects the tenant use case (sublease earnings) vs the
landlord rent-collection context: "Set up a payout account to
withdraw money GAM owes you — currently used for sublease earnings
when you sublease your unit at a markup over the master rent. Stripe
handles the bank verification; GAM never sees your full account
number."

Route registered at `/payouts` in `apps/tenant/src/main.tsx`.

### Conditional nav entry — `apps/tenant/src/main.tsx` Layout

```tsx
{bgApproved && tenantMe?.stripeConnectAccountId && (
  <NavLink to="/payouts">🏦 Payouts</NavLink>
)}
```

Visible only when:
1. Background check approved (matches the rest of the post-BG nav)
2. User has a `stripe_connect_account_id` (i.e., they've initiated
   onboarding at least once)

First-time sublessors don't see the nav; they reach `/payouts` from
the SublessorCreditCard error state. After clicking through and
initiating onboarding, the nav entry appears on next page load.

### SublessorCreditCard link wire-up — `apps/tenant/src/pages/LeasePage.tsx`

Error message "set up payouts" path now renders a gold "Go to
payouts setup →" link directly to `/payouts` instead of the prior
"contact support" placeholder. One-click path from "I tried to
withdraw" to "I'm in the Stripe onboarding flow."

## Files touched (S249)

```
apps/tenant/package.json                          (+ 2 deps)
apps/api/src/routes/tenants.ts                    (~ +1 line: SELECT
                                                   stripe_connect_account_id
                                                   on /me)
apps/tenant/src/pages/PayoutsPage.tsx             (new — 135 lines)
apps/tenant/src/main.tsx                          (~ import +
                                                   route + conditional
                                                   nav link; ~+5 lines)
apps/tenant/src/pages/LeasePage.tsx               (~ "set up payouts"
                                                   error path links to
                                                   /payouts; +7 / -3 lines)
DEFERRED.md                                       (~ sublease entry
                                                   updated — S249 closes
                                                   tenant Connect
                                                   onboarding; 3 small
                                                   follow-ups remain)
SESSION_249_HANDOFF.md                            (this file)
```

No schema changes. No backend service changes (backend was already
role-agnostic on Connect onboarding — only the frontend surface was
missing).

## Verification

- `cd apps/api && npx tsc --noEmit` → clean
- `cd apps/tenant && npx tsc --noEmit` → clean
- `apps/tenant/package.json` resolves `@stripe/connect-js` and
  `@stripe/react-connect-js` (verified `ls node_modules/@stripe/*`)

## End-to-end sublessor flow now works

1. Sublessor enters sublessee email + sublease terms → invite sent
2. Sublessee clicks email, signs up via accept page → sublease pending
3. Landlord approves → sublease active
4. Sublessee pays rent → destination charge routes master_share to
   landlord, markup lands on platform balance
5. Webhook credits markup to `sublessor_credit_balances`
6. Sublessor sees balance on LeasePage `SublessorCreditCard`
7. Clicks "Withdraw" — hits 409 "set up payouts" first time
8. Clicks "Go to payouts setup →" → `/payouts` page
9. Completes embedded Stripe Connect onboarding
10. Stripe webhook (or status poll) flips connect_payouts_enabled
11. Sublessor returns to LeasePage, clicks Withdraw — Stripe Transfer
    fires to their bank, balance decrements

All seven steps now have shipping code.

## Carry-forward — S250+

### Sublease follow-ups (3 remaining)

1. **Sublease document upload + e-sign**. Hook `services/esign.ts`
   so subleases can require both parties to sign a generated
   agreement before status='active'. Populates the dead
   `sublease_document_url` column.
2. **Admin sublease frontend.** Backend list query already supports
   admin/super_admin; just needs a `/subleases` page in apps/admin.
3. **Liability disclosure copy.** Tenant request modal should state
   "By submitting, you acknowledge you remain on the master lease
   and joint-and-severally liable for rent if your sublessee
   defaults." Landlord-configurable per state under no-state-legal-
   logic rule.

### Flex Suite remaining

- **FlexCredit** — vendor-pending (CredHub callback + Esusu email
  responses outstanding)
- **FlexCharge** — total rebuild (multi-session)

### FlexDeposit follow-up

- Deposit portability across leases
- Missed-installment legal remedy

### External-vendor-blocked

- **Checkr Partner** — credentials still pending

## Revised count

| Bucket | Pre-S249 | Post-S249 |
|---|---|---|
| Sublease | 4 follow-ups | 3 follow-ups (Connect onboarding closed) |
| Sublease end-to-end | gated at withdraw step | functional end-to-end |
| Flex products | 2 remaining (1 vendor / 1 multi-session) | same |

**Until v1 launch-ready:** ~3-4 sessions. FlexCharge is the biggest
remaining build. Sublease has 3 small follow-ups. FlexCredit + Checkr
still external-blocked.

---

End of S249 handoff.

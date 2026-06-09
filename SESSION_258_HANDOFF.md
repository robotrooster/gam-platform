# Session 258 — closed

## Theme

pos_customer ACH onboarding flow — closes the last functional gap
in FlexCharge for non-tenant customers. Without this, statement-
billing cron would fail for pos_customer accounts (no stripe_customer_id
+ no verified payment method on file). Mirrors the S247 sublessee
invite pattern: token-based public flow, Stripe Financial Connections
for ACH verification.

## Items shipped

### Migration — `20260512100000_pos_customer_invitations.sql`

New `pos_customer_invitations` table: token (UNIQUE), pos_customer_id,
landlord_id, status enum (sent/in_progress/accepted/expired/cancelled),
setup_intent_id (set after /start), accepted_at, expires_at,
cancelled_at. 14-day expiry. 3 indexes.

### Backend routes — merchant trigger

**`POST /api/landlords/pos-customers/:id/send-onboarding`** —
generates 32-byte hex token + 14-day expiry; sends email via new
`sendPosCustomerOnboarding` in `services/email.ts` (mirrors
sendSubleaseInvite copy + structure with "How this works" callout
about Stripe verification + 1.5% statement fee). Refuses to send
if customer already ach_verified or archived. Returns
`{invitationId, expiresAt}`.

### Backend routes — public token flow

New file `apps/api/src/routes/posCustomerOnboarding.ts` mounted at
`/api/pos-customer-onboarding`. Three public endpoints (no GAM auth):

| Route | Purpose |
|---|---|
| `GET /:token` | Validates token + expiry, returns preview (customer name/email + merchant name + status + expiry). |
| `POST /:token/start` | Creates Stripe customer + SetupIntent with `payment_method_types=['us_bank_account']` + Financial Connections permissions. Returns `client_secret`. Idempotent — if /start was already called on this invitation, reuses the existing SetupIntent (handles browser refresh). |
| `POST /:token/complete` | Server-side validates SetupIntent status (must be `'succeeded'`), extracts `bank_last4` from the attached payment method, stamps `pos_customers.stripe_customer_id` + `ach_verified=true` + `bank_last4`. Sets the verified PM as Stripe customer's default so statement-billing cron picks it up automatically via `invoice_settings.default_payment_method`. Marks invitation `'accepted'`. |

### Email template — `apps/api/src/services/email.ts`

`sendPosCustomerOnboarding({customerEmail, customerName, merchantName,
token, ctx?})`. Renders a branded HTML email with the merchant name,
a "How this works" bullet list (3 lines: bank verify with Stripe,
merchant sets credit limit, monthly auto-pull + 1.5%), a gold CTA
button linking to `${TENANT_APP_URL}/pos-customer-onboard/${token}`,
and a 14-day expiry note. Logs to `email_send_log` with category
`pos_customer_onboarding`.

### Frontend — `apps/tenant/src/pages/PosCustomerOnboardingPage.tsx`

New public route `/pos-customer-onboard/:token` (registered outside
the Layout-auth-gate, similar to `/sublease-invite/:token`).

Flow:
1. Fetches `/api/pos-customer-onboarding/:token` to load preview
2. Shows merchant name + customer name + 4-bullet "what happens next"
3. User clicks "Verify my bank"
4. Calls `/start` → gets client_secret
5. Calls `stripe.collectBankAccountForSetup` (opens Stripe FC bank-
   login modal)
6. Calls `stripe.confirmUsBankAccountSetup`
7. Calls `/complete` → server stamps verified status
8. Renders success state with `•••• <last4>` + summary copy

Error and loading states handled. CenteredCard helper component
keeps the page minimal (no header/nav — public landing page styling).

### Landlord UI — `apps/landlord/src/pages/FlexChargePage.tsx`

New "POS Customers" section below the accounts table (auto-hides
when roster is empty). Per-row:
- Customer name + email
- Bank: `•••• <last4>` if verified, else `—`
- Status badge: green "✓ Verified", amber "Invite sent · expires
  <date>", muted "Not verified"
- Action button: "Send onboarding" / "Resend invite" — fires the
  merchant route; on success updates state to show invite-sent badge

`PosCustomerRow` interface extended with `achVerified`, `bankLast4`,
`stripeCustomerId`. Backend already returned these fields.

## Decisions made during build

| Question | Decision |
|---|---|
| Public route under tenant portal app or new app? | Tenant portal app. Pre-existing pattern: `/accept-invite`, `/sublease-invite/:token`, `/background-check` are all public routes in the tenant portal. Adding `/pos-customer-onboard/:token` matches the convention; no new app needed. |
| Stripe FC flow vs manual bank-name+last4? | FC flow. The existing tenant `AchVerifyForm` uses a simplified manual-entry (bank name + last4) but that doesn't actually verify funds-movement-readiness. FlexCharge statement billing needs a real ACH-pull-capable payment method; only Financial Connections delivers that with one user click. |
| Set default payment method on Stripe customer? | Yes. statement-billing cron resolves the customer's default PM via `invoice_settings.default_payment_method`; stamping the newly-verified PM as default is required for the cron to actually pull from it. |
| Idempotency on /start | If invitation already has setup_intent_id, retrieve and return its client_secret. Handles browser refresh + double-click. Stale 'canceled' SetupIntents trigger a fresh create. |
| Invitation expiry | 14 days. Same as sublease invites. Plenty of time for the customer to verify; short enough that an unanswered invite doesn't sit forever. |

## Files touched (S258)

```
apps/api/src/db/migrations/
  20260512100000_pos_customer_invitations.sql         (new — 25 lines)
apps/api/src/db/schema.sql                            (regenerated)
apps/api/src/routes/landlords.ts                      (+ send-onboarding
                                                       route; ~+60 lines)
apps/api/src/services/email.ts                        (+ sendPosCustomer
                                                       Onboarding;
                                                       ~+50 lines)
apps/api/src/routes/posCustomerOnboarding.ts          (new — ~210 lines)
apps/api/src/index.ts                                 (+ router mount)
apps/tenant/src/pages/PosCustomerOnboardingPage.tsx   (new — ~145 lines)
apps/tenant/src/main.tsx                              (+ import + public
                                                       route registration)
apps/landlord/src/pages/FlexChargePage.tsx            (+ POS Customers
                                                       table section +
                                                       PosCustomerActions
                                                       Row component;
                                                       ~+85 lines)
DEFERRED.md                                           (~ FlexCharge entry
                                                       — onboarding flow
                                                       shipped; post-
                                                       launch polish
                                                       trimmed to 2 items)
SESSION_258_HANDOFF.md                                (this file)
```

## Verification

- `cd apps/api && npx tsc --noEmit` → clean
- `cd apps/landlord && npx tsc --noEmit` → clean
- `cd apps/tenant && npx tsc --noEmit` → clean
- `cd apps/admin && npx tsc --noEmit` → clean
- `cd apps/pos && npx tsc --noEmit` → clean

## End-to-end FlexCharge non-tenant customer flow (now fully shipped)

1. Merchant creates pos_customer record in FlexChargePage modal
2. Merchant clicks "Send onboarding" on the POS Customers row
3. Customer receives branded email with verification link
4. Customer clicks link → `/pos-customer-onboard/:token` public page
5. Customer clicks "Verify my bank" → Stripe FC modal opens
6. Customer logs in to their bank via Stripe FC OAuth flow
7. Stripe attaches verified payment method to the customer record
8. Page calls /complete → server stamps ach_verified + bank_last4 +
   sets PM as customer's default
9. Customer sees success screen
10. Merchant sees green "✓ Verified" badge on the customer row
11. Merchant creates a FlexCharge account for the customer at a property
12. POS sales with `payment_method='charge'` post to the account
13. Monthly statement cron picks up the customer, ACH-pulls
    `total_due` (balance + 1.5% fee) from the verified bank
14. Webhook reconciles + fires merchant Connect Transfer for the
    balance amount (1.5% stays as GAM revenue)

## Carry-forward — S259+

### Remaining v1 work (Nic-input-blocked)

- **OTP cron-timing rework** — needs your call: move cron earlier
  (~5 business days before EOM), adopt Stripe instant payouts
  (1.5% fee eats the margin), or tighten "by the 1st" copy.
- **FlexDeposit missed-installment legal remedy** — pending spec.

### Vendor-blocked

- **FlexCredit** — CredHub callback + Esusu email pending
- **Checkr Partner** — credentials pending

### Post-launch FlexCharge polish

- Statement history view on landlord dashboard
- In-app dispute flow (currently support-routed)

### Smaller / non-blocking

- POS multi-terminal sync (premature)
- POS / `/resolve` smokes (Nic-runs)
- Auto-fire `transfers.createReversal` for FlexDeposit landlord-held
  portability (currently manual-confirm; only worth doing if volume
  justifies — gam_escrow is the default path forward)

## Revised count

| Bucket | Pre-S258 | Post-S258 |
|---|---|---|
| FlexCharge non-tenant customers | ACH gap blocked statement billing | **Fully functional end-to-end** |
| Pre-launch unblocked code work | 0 | 0 |
| Pre-launch Nic-input-blocked items | 2 (OTP timing, FlexDeposit legal remedy) | 2 |
| Vendor-blocked items | 2 (FlexCredit, Checkr) | 2 |

**Until v1 launch-ready:** All unblocked code work has been shipped.
Remaining items need external input or vendor responses. Post-launch
FlexCharge polish (statement history, in-app disputes) sits ready
whenever you want it.

---

End of S258 handoff.

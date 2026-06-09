# Session 84 Handoff

**Theme:** Frontend Stripe Elements wiring for the applicant background-
check intake fee. Closes the loop on S83 — the intake page now actually
confirms a real PaymentIntent client-side and hands the verified intentId
back to /submit.

## Architecture decision recorded

PaymentIntent flow on the tenant side:

1. User reaches step 5 ("Review & Pay") of the intake wizard.
2. An effect ensures a tenant account exists (calls
   `/auth/register-prospect` if no token), then `POST
   /background/payment-intent` to mint the PI. Backend returns
   `clientSecret` + `intentId`.
3. If `VITE_STRIPE_PUBLISHABLE_KEY` is set, render `<Elements
   clientSecret>` wrapping a `<PaymentElement />` + Pay button. User
   enters card and the button calls `stripe.confirmPayment({
   redirect: 'if_required' })` to keep the user in-page.
4. On success, the verified `intentId` is stored in component state.
5. Submit attaches `applicantPaymentIntentId` to the request body.
   Backend (S83) verifies status=succeeded + metadata.userId match +
   amount + idempotency.
6. If `VITE_STRIPE_PUBLISHABLE_KEY` is unset (dev without creds),
   the flow falls back to a "Confirm Mock Payment" button that uses
   the `pi_intake_mock_*` ID returned by the backend in non-production.

Account-creation (`/auth/register-prospect`) was moved out of submit
into the step-5 effect because `/payment-intent` requires a token.
Submit now assumes a token already exists.

## Shipped

### apps/tenant/package.json
- Added `@stripe/stripe-js@^9.4.0` and `@stripe/react-stripe-js@^6.3.0`.

### apps/tenant/src/pages/BackgroundCheckPage.tsx
- New imports: `loadStripe`, `Elements`, `PaymentElement`, `useStripe`,
  `useElements`. Module-level `stripePromise` initialized only when
  `VITE_STRIPE_PUBLISHABLE_KEY` is set.
- New state: `paymentIntentId`, `paymentClientSecret`, `paymentInitError`.
- New step-5 effect: ensures account, mints PI, sets clientSecret +
  intentId. Cancellable.
- Step 5 UI rewritten:
  - Loading state ("Initializing payment…") while the effect runs.
  - Error state for PI init failures.
  - When Stripe configured: `<Elements>` + new `<StripePayForm>`
    child component (uses `useStripe`/`useElements`, calls
    `confirmPayment` with `redirect: 'if_required'`).
  - When Stripe absent: "Confirm Mock Payment" button (dev fallback).
  - Confirmed-payment banner unchanged.
- `submitMut` no longer creates the account inline (effect already did);
  attaches `applicantPaymentIntentId` to the submit body.
- `consentPool: false` added to the form state initializer (closes the
  pre-existing TS error on lines 92, 559, 560 — adjacent to S84 work,
  fixed per fix-it-right).
- New `<StripePayForm>` component at the bottom of the file.

### .env.example (root)
- Documented `VITE_STRIPE_PUBLISHABLE_KEY` (browser-bundled, intentionally
  public) with a comment explaining the dev mock fallback. Commented
  out — Nic supplies the actual `pk_test_*` value.

## Files touched

- apps/tenant/package.json + apps/tenant/package-lock.json (npm install)
- apps/tenant/src/pages/BackgroundCheckPage.tsx (Elements wiring +
  consentPool init)
- .env.example (VITE_STRIPE_PUBLISHABLE_KEY documented)
- SESSION_84_HANDOFF.md (this file)

## Validation

- `cd apps/tenant && npx tsc --noEmit | grep BackgroundCheckPage` →
  no errors in the page I touched.
- 55 lines of pre-existing TS errors remain in `main.tsx`, `LeasePage.tsx`,
  `ProfilePage.tsx` — out of scope for S84 (not files I touched).
  Recommend a "tenant TSC cleanup" session at some point.
- No backend changes; no migration; api typecheck unchanged from S83.

## What you need to do to smoke-test live Stripe

1. Grab a test publishable key from dashboard.stripe.com → Developers
   → API keys (the `pk_test_*` one).
2. Add to `apps/tenant/.env`:
   `VITE_STRIPE_PUBLISHABLE_KEY=pk_test_...`
3. Restart the tenant dev server (Vite needs to re-read env).
4. Walk through intake steps 1-4 with any test data, hit step 5.
5. Use Stripe's test card `4242 4242 4242 4242`, any future expiry,
   any CVC. The PaymentElement will render; click Pay; confirm
   payment succeeds and "click Submit below" appears; submit; backend
   /submit verification passes; bg check row inserted with
   `applicant_payment_intent_id` populated.

Without the env var, the flow still works end-to-end via the mock
fallback (dev only — production rejects mock IDs per S83 verifier).

## What this session did NOT do

- **No landlord pool unlock UI.** Backend has the new two-step pool
  unlock endpoints (S83) but the landlord-side pool match modal that
  would call them doesn't exist yet — `ApplicantPoolPage.tsx` is just
  a read-only roster, no match flow. When that UI is built, drop in
  the same `<Elements>` pattern; the backend is ready.
- **No tenant TSC cleanup.** 55 pre-existing errors in main.tsx,
  LeasePage.tsx, ProfilePage.tsx remain.
- **No webhook for these PIs.** Verification is on submit (S83 design
  decision); webhook handler unchanged.
- **No edits to apps/tenant/.env.** Per CLAUDE.md, .env touches need
  your explicit go-ahead — you'll add the publishable key when you
  generate it.

## Pre-launch blockers still open

- Item 16 batch 2 — bank ACH origination provider selection + real
  `fireViaBankAch` call + settlement webhook/polling handler.
- Item 16 batch 3+ — OTP enablement infrastructure (SetupIntent for
  ACH, FlexPay tier wiring); pi_* audit pass.
- Item 2 — FCRA adverse action notice infrastructure.
- Item 10 — Utility billing subsystem (multi-day).
- Item 11 — Master Schedule finish-or-strip (needs your product call).
- Item 14 — POS app completion (multi-day).
- Item 15 — E-sign frontend visual + e2e smoke.
- Item 19 — Email systems consolidation.

## What next session should target

Top picks for S85:

1. **Item 19 — Email consolidation.** Resend vs nodemailer cleanup
   with the nodemailer audit blockers. Concrete pre-launch task.
2. **Item 15 — E-sign frontend smoke.** Visual polish + e2e walk on
   top of S29 hardening.
3. **Tenant TSC cleanup.** 55 errors across main.tsx, LeasePage.tsx,
   ProfilePage.tsx. Worthwhile if you want strict-clean parity with
   apps/api (S28b cleanup).

Recommend **#1**. Email consolidation is a real pre-launch blocker and
hasn't been touched since the original Resend/nodemailer split.

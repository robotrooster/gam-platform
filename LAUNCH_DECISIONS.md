# LAUNCH_DECISIONS.md

Decisions only Nic can make. Each item: what you're picking,
what it changes for users / cost / time, the recommendation
when there is one, and what happens after you call it.

Backend hardening and tests are substantially complete (156
passing across apps/api + apps/pos). Frontend covers tenant
auth pages + admin 2FA. The bench is largely choices and
vendor go-lives now, not code.

**Resolved since this doc was first written:**
- #2 Resend domain — Nic locked in `goldassetmanagement.com`;
  backend split into noreply/support; DNS pending registrar.
- #4 Auth UI — S289 shipped forgot/reset/verify pages in tenant
  portal.
- #5 2FA — Nic said yes; S288 shipped backend, S290 shipped
  admin-portal frontend. Other portals follow the same pattern.
- #8 Repo hygiene — orphan backup files deleted S288.

**Status: launch-blocking items that need Nic:** #1 host
(passed to dev team), #3 Stripe live keys (passed to dev team),
#6 legal docs (drafting together), #9 frontend Sentry
(awaiting yes/no after context).

---

## 1. Where the API + database live (host pick) — DEV TEAM

**Status: Nic passed this to the dev team.**

The question, options, and recommendation below stay for
reference. Render is still the recommended path; the dev team
will decide.

**The question.** Right now the API runs on Nic's laptop in dev.
For launch, it needs to run somewhere always-on. Pick a host.

**Why it matters.** Every other launch step is downstream of
this — domain setup, SSL certs, the production cron runner,
database backups, and how the deploy pipeline works are all
shaped by which host. Cost ranges from ~$50/mo (Render minimum)
to $200+/mo (AWS with Postgres, S3, etc.).

**Options:**

- **Render** *(recommended)* — managed Postgres + web service +
  cron service in one dashboard. Cheapest path to launch.
  Deploy is `git push`. Automatic SSL. Daily DB backups
  included. ~1 session of Claude work + DNS propagation after
  the call.
- **Fly.io** — Postgres on Fly, multi-region capable, more
  control. DB management is more hands-on.
- **Railway** — comparable to Render, slightly less mature.
- **AWS / GCP** — overkill for now; 2-3 sessions of setup
  + ongoing ops complexity.

---

## 2. Email sending (Resend domain) — RESOLVED

**Status: Nic chose `goldassetmanagement.com`.** Backend split
into two senders shipped S288:

- `noreply@goldassetmanagement.com` for system messages
  (password reset, verification, late-payment notices,
  signing reminders, etc.)
- `support@goldassetmanagement.com` for reply-welcome messages
  (invitations, FCRA adverse-action notices)

**Action still pending Nic:**
1. Add the domain in the Resend dashboard.
2. Resend generates SPF + DKIM + DMARC records.
3. Add the records at your registrar.
4. Wait ~24h for DNS propagation + Resend verification.
5. Once verified, set `EMAIL_FROM_NOREPLY` +
   `EMAIL_FROM_SUPPORT` env vars in production to the new
   values. (Dev fallback to existing `EMAIL_FROM` is in place
   so dev keeps working until then.)

No code waits on this — emails continue sending via the
Resend playground sender until DNS is verified.

---

## 3. Stripe live keys — DEV TEAM

**Status: Nic passed this to the dev team.**

To take real money, flip Stripe from test mode to live keys.

**What needs to happen:**
- Switch `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` to
  the live values from Stripe dashboard.
- Register the production webhook URL pointing at
  `https://<your-prod-host>/webhooks/stripe`.
- Confirm Connect Express is enabled on the live account.
- Set `VITE_STRIPE_PUBLISHABLE_KEY` to `pk_live_*` in every
  frontend portal's build env.

**Recommended sequencing:** do this LAST among the infra
items, after a soft-launch test with one known tenant against
test-mode Stripe.

---

## 4. Frontend pages for auth flows — RESOLVED (tenant) / partial

**Status: shipped S289 for tenant portal.** Three pages live:

- `/forgot-password` — email form
- `/reset-password?token=...` — set new password (12-char min)
- `/verify-email?token=...` — auto-consume token on mount

Plus "Forgot password?" link added to LoginPage.

**Still pending Nic:**
- Browser smoke walk of the three pages (handoff in S289 has
  the 4-step plan).
- Per-portal landing pages for landlord / admin / admin-ops /
  PM company / pos / etc. — lower priority because the
  tenant pages already work for any user (backend doesn't
  gate on origin). Polish, not blocking.

---

## 5. Two-factor authentication (2FA) — RESOLVED (backend + admin frontend)

**Status: Nic said yes; backend + admin frontend shipped.**

- **S288 backend:** TOTP via otplib v12 + qrcode. Four
  endpoints under `/api/auth/totp/` (enroll-start /
  enroll-confirm / disable / verify). Login route gates JWT
  issuance behind a 5-min totp_session when TOTP is enabled.
  14 tests passing.
- **S290 admin frontend:** Multi-step LoginPage,
  TotpEnrollPage, MustEnrollTotpGate. `/api/auth/me` extended
  to return `totp_enabled` + `mustEnrollTotp` so auth context
  survives page refresh.

**Locked policy:**
- Mandatory at launch for admin + super_admin
  (server's `MANDATORY_TOTP_ROLES`). The admin-ops portal
  is gated by the same two roles (no separate `admin_ops`
  user role exists — admin-ops is a portal, not a role).
- Optional-with-prompts for landlord + PM company at launch;
  flip to mandatory after weeks of adoption.
- Tenants stay optional indefinitely.
- TOTP only (Google Authenticator / Authy / 1Password / etc.);
  SMS deliberately excluded due to SIM-swap risk against
  financial accounts.

**Still pending Nic:**
- Browser smoke walk of admin enrollment + login flows
  (S290 handoff has a 10-step plan + a reset SQL).
- Approval to roll the same frontend pattern to admin-ops
  (mandatory), landlord (optional-with-prompts), PM company
  (optional-with-prompts), tenant (fully optional). Mechanical
  copy after the admin smoke walk validates the pattern.

---

## 6. Legal documents (ToS + Privacy Policy)

**Status: Nic said we draft these together when ready, no
attorney.**

Pre-launch, GAM needs Terms of Service + Privacy Policy on
the marketing site + a signup acceptance gate so users agree
on registration.

**What you need to do:**
- Decide a session to sit down and draft both with me.
- Decisions to lock in during drafting:
  - What user data does GAM collect? (SSN-style PII via
    Checkr; bank account info via Plaid + Stripe; the obvious
    profile info; payment history; lease documents.)
  - What third parties do we share with? (Stripe / Resend /
    Plaid / Checkr — strict-service-need only is the default
    answer.)
  - Jurisdiction: where is GAM legally domiciled? (Drives
    CCPA / state-by-state language.)
- Cover state-by-state landlord-tenant law disclaimers
  (per CLAUDE.md — GAM is national, no state-specific advice).

**What changes after:** Marketing site adds `/terms` +
`/privacy` pages with the locked text. Signup writes
`accepted_tos_at` to users table. ~1 session of Claude
implementation once text is locked.

---

## 7. Vendor go-lives still pending

Status updates, not decisions. Logged so you can see what's in
flight:

- **Plaid production keys** — tenant ACH verification flow
  needs production Plaid keys. Submit on the Plaid dashboard
  → wait for review.
- **Stripe Terminal hardware** — POS card-present needs
  physical readers + production Terminal access (separate from
  base Stripe).
- **Checkr Partner credentials** — DEFERRED notes "unblocks
  Monday per Nic" — flag if delayed.
- **FlexCredit (CredHub + Esusu)** — vendor-blocked. Flex Suite
  is hidden at launch so this isn't blocking.

---

## 8. Repo hygiene cleanup — RESOLVED

**Status: shipped S288.** `dev.sh.s29c2g.bak` +
`package.json.s56.bak` deleted at repo root. Route-level
`.s*backup` files were already gone from the working tree.

---

## 9. Frontend Sentry rollout

**Status: Nic asked for context (S288), I explained (S288),
awaiting yes/no.**

Backend Sentry shipped S273. Frontend SDK needs adding to all
10 portals: admin, admin-ops, landlord, tenant, pos,
marketing, listings, property-intel, pm-company, books.

**What it does.** When a tenant's payment page throws a JS
error, or the admin payments table crashes in someone's
browser, Sentry catches it and shows you the stack trace,
request context, and user id — instead of waiting for the
user to email "the page is broken."

**Why it matters at launch.** Pre-launch you won't see
anything. Once real users hit prod, frontend errors are how
you learn what broke. Same idea as backend Sentry, on the
browser side.

**What you need to do:**
- Decide: one Sentry project tagged per portal, or separate
  projects per portal? (Recommend one project + tags.)
- Approve the install. Mechanical — no walkthrough needed
  beyond the smoke check after.

**What changes after:** ~1 session of mechanical work.
`Sentry.init` + `<ErrorBoundary>` in each portal's main.tsx,
plus the DSN in production env. PostHog / Mixpanel
(user-behavior analytics) is a separate question — Sentry is
errors only.

---

## Suggested launch sequence

Roughly the order things should happen, with dependencies:

1. ~~**Repo hygiene**~~ ✅ S288
2. **Pick a host** (Render recommended) — dev team
3. **Claude writes deploy config** — 1 session after host pick
4. ~~**Resend domain choice**~~ ✅ S288. **DNS records pending**
   at Nic's registrar.
5. ~~**Frontend pages for auth flows**~~ ✅ S289 (tenant
   portal). **Browser smoke walk pending Nic.**
6. ~~**2FA backend + admin frontend**~~ ✅ S288 / S290.
   **Browser smoke walk + roll-to-other-portals pending Nic.**
7. **Frontend Sentry rollout** — 1 session, awaiting Nic
   yes/no.
8. **Legal docs drafted** — schedule a drafting session with
   Claude.
9. **`/terms` + `/privacy` pages + signup gate** — 1 session
   after text lands.
10. **Stripe live keys + production webhook** — dev team.
11. **Database backup verification on host** — dev team.
12. **Soft launch** to one tenant (Nic or a known tester).
13. **Vendor go-lives as they unblock** (Plaid, Checkr Monday,
    Stripe Terminal hardware).
14. **Wider rollout.**

The path is well-understood. Most code work is done; what's
left is mostly the dev team's deploy work + Nic's smoke walks
+ a legal-docs drafting session.

---

*Originally auto-generated S282. Refreshed S290 to reflect
shipped items. Update as decisions get locked in; prune as
items ship.*

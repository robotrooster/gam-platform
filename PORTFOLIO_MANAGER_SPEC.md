# Portfolio Manager — role, portal, and referral model (S592, Nic-locked)

Launch-blocking. Nic is the account manager (closer + CS) for his own and
friends' onboards; the commission must flow to him as a portfolio manager, and
external closing agents must be onboardable with a **scoped** view (their book
only, nothing company-wide). This spec is the durable reference for that build.

---

## 1. The problem this solves

Today a "portfolio manager" is just the **`admin` role** with data filtered by
portfolio. That's a **deny-list**: a PM can reach every admin endpoint by
default, and we keep them out of sensitive ones by remembering to gate/scope
each one. The S592 admin comb found three doors someone forgot to lock
(NACHA log, FlexSuite acceptances, invite-resend) — the same failure, guaranteed
to recur as new admin endpoints are added.

A **separate role + separate portal** flips it to an **allow-list**: a PM can
reach only the endpoints built for their router; the entire platform-admin world
is structurally unreachable. Every future platform feature is then safe by
default. This is the single biggest security improvement available to the admin
surface.

## 2. Role model

- New `users.role` value **`portfolio_manager`** (distinct from `property_manager`,
  which is a *landlord's* in-house staff — keep the names straight).
- NOT a platform role. `admin`/`super_admin` stay the platform tier; the main
  admin app (:3003) becomes platform-staff-only.
- The **admin-ops app (:3009) is repurposed into the portfolio-manager portal**
  (replaces it — Nic-locked). Its login already runs the universal email-2FA
  flow; only the role gate + the surfaced screens change.
- Mandatory 2FA applies (universal, S578).

## 3. What a portfolio manager can see (allow-list)

Scoped to their book — landlords where `portfolio_manager_id = them` OR
`service_manager_id = them`, and the tenants/units/properties under those
landlords — plus their own comp. Nothing company-wide.

**In scope (their accounts):** onboarding progress; their landlords + tenants +
units; **financials FOR their accounts** (rent collected / disbursements /
banking-setup status for their landlords); their own commissions/pay; banking
nudges + Connect-readiness for their landlords; onboarding-invite resends; call
scheduling.

**Out of scope (blocked — platform-only):** company-wide financials (income
projection, ARR, reserves, the pot totals); other PMs' books; feature flags;
NACHA/fraud/compliance; CSV imports; platform claims; nexus; FlexPay inquiries;
leads; bank-number reveals; audit log. These live on `/api/admin`, which the PM
role cannot reach.

## 4. Referral model (single-tier, person-anchored)

Nic-locked, no multi-tier (no MLM). Commission tracks **software usage** (the
per-occupied-unit platform fee), never a property transaction (keeps it a SaaS
referral program, clear of RESPA / real-estate-referral rules).

- **One upline per person, on their own units only. Uplines NEVER stack** — U
  earns on the person they referred, never reaches through them to *that*
  person's referrals. This invariant is what keeps it single-tier.
- **Anchored to the person, not the property.** The upline lives on the user, so
  it survives 1031s / new LLCs and auto-applies to every account that person
  opens. Manual "re-attach" as a backstop.
- **Whoever signs up an account = the primary**; the account's referral flows to
  the primary's own upline (as today).
- **Co-owners added who have no existing upline become the primary's downline**
  — dormant while the partnership is intact (no money moves), activating only
  when a co-owner later opens their *own* account (then the primary earns the
  closing 25¢ on it). First-touch wins: a co-owner who already has an upline
  keeps it. Nobody is coerced — a co-owner is free to not put their next
  property on GAM at all.
- **Anti-gaming is self-aligning:** the only dodge (separate accounts per
  property) throws away the consolidated-portfolio value the product exists for.
  Attribute by account owner; don't over-police.

## 5. Commission (already built — S567, keep)

Per **occupied** unit / month, into `commission_accruals`
(`PORTFOLIO_COMMISSION` rates):
- **closing 25¢** → the referring landlord (`landlords.referred_by_user_id`) if a
  landlord referral, else the closing PM (`landlords.portfolio_manager_id`), else
  the pot.
- **service 25¢** → customer service, always a person: the closer if a PM closed
  it, else the assigned `service_manager_id`. Never the pot.
- **pot 10¢** → always.

Zero occupied units → no accrual (the natural pause). Units return → resume.
`commissionAccrual.ts` already pays whoever is attributed **regardless of the
earner's own property status** — so an upline's income is already continuous
through their own ownership gaps.

## 6. Build phases

- **P1 — Role foundation. ✅ DONE.** `portfolio_manager` in shared `USER_ROLES` +
  `PORTFOLIO_MANAGER_ROLE_LABEL`; migration `20260806120000` extends
  `users_role_check`.
- **P2 — Referral persistence. ✅ DONE.** Person-level upline
  (`users.referred_by_user_id`, migration `20260806120100` + backfill): set at
  signup (incl. `portfolio_manager` ref codes) and on co-owner add (first-touch
  wins). The accrual job (`commissionAccrual.ts`) reads the entity attribution
  first and **falls back to the owner's person-upline** — that fallback is what
  survives 1031s / new LLCs and pays a co-owner's captured primary. Manual
  re-attach ships with P3. Tested: accrual fallback (landlord + rep upline,
  precedence) + co-owner capture.
- **P3 — Scoped backend.** ⏳ IN PROGRESS.
  - ✅ **Wall confirmed** — the `/api/admin` router gate already 403s any role that
    isn't `admin`/`super_admin`, so `portfolio_manager` is denied by construction
    (no work needed).
  - ✅ **Role plumbing done** — `/admin/portfolio-managers` roster + `/admin/landlords/:id/assign`
    accept `portfolio_manager`; new super_admin backstop `POST /admin/users/:userId/referral-upline`
    (manual re-attach of the person-level upline). Tested.
  - ✅ **`/api/portfolio` stood up.** New `routes/portfolio.ts` router admits
    admin/super_admin/**portfolio_manager**; shares the EXACT scoped handlers
    (extracted + exported from admin.ts/landlords.ts — no duplication):
    `landlords`, `onboarding/overview`, `onboarding/landlord/:id`,
    `onboarding/tenant/:id`, `tenants`, `onboarding/resend`, `my-referral`,
    `commissions/summary`. Tested (portfolio.test.ts): PM reaches it + is scoped;
    same token 403'd on /api/admin (incl. /income/projection); non-rep denied.
  - ⬜ **Remaining scoped endpoints** (secondary): connect-readiness,
    landlord-banking-nudges, notifications, flexsuite-acceptances — same
    extract-and-share; scope the resend targetId to the caller's book.
- **P4 — Portal. ✅ DONE.** admin-ops now admits `portfolio_manager` (4 auth
  checks), repointed its book calls (onboarding / tenants / landlords / resend) to
  `/api/portfolio`, hides the platform-only nav (Property Reviews / Units /
  Payments) from a PM, and adds a **Commissions** page (`/commissions`) surfacing
  `/portfolio/commissions/summary` (this-month + all-time earnings + per-account
  breakdown) and `/portfolio/my-referral` (code + copyable link). Every
  PM-visible page (Onboarding, Commissions, Landlords, Tenants) hits `/api/portfolio`;
  the only `/api/admin` calls left are on Property Reviews (hidden from PMs). Both
  apps typecheck. A PM can log in, see their book, and see their money.
  - The shared `resend` is portfolio-scoped (a PM can only resend to a tenant in
    their book; 403 otherwise) — tested.
  - Only follow-up (non-blocking): share the secondary endpoints (connect-readiness
    / banking-nudges / notifications) IF the portal later surfaces them (it does
    not call them today).
- **P5 — Migration/assignment.** Not needed for launch (Nic is super_admin and
  can self-assign as closer/CS today). Move any external PM-admins to the new role
  when they're onboarded.

Nothing committed until Nic says so.

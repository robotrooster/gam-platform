# SESSION 592 HANDOFF — Books + Admin combed; **Portfolio Manager role/portal + single-tier referral model built (P1–P4 core)**

> This session finished the **Books (S17)** and **Admin (S18)** subsystem combs,
> then **pivoted (Nic, launch-blocking)** to build a real **`portfolio_manager`
> role + scoped portal + person-anchored referral model** — replacing the
> deny-list "PM = admin" posture with a proper allow-list. **Nothing committed**
> (the whole S578→ sweep is still one-deploy-at-the-end). Everything green.

---

## THIS SESSION — what shipped (code complete, not committed)

### A. Subsystem 17 — Books (combed + fixed + 2 product changes)
- **Bug (FIXED):** `/bookkeeper/invite` could **hijack any existing account** — the
  `ON CONFLICT (email) DO UPDATE SET role='bookkeeper'` converted any tenant/
  landlord/admin into a bookkeeper. Endpoint **removed entirely** (see B below).
- **Bug (FIXED):** `/bookkeeper/assign` didn't verify the target is a bookkeeper
  (foreign-ref class) — now guarded (404 for non-bookkeeper).
- Isolation verified solid: `ownerScope` guard on every read/write; the
  admin-sees-all `$1 IS NULL` collapse is unreachable by any non-admin; all
  money-write foreign refs scope-checked (S386/S413 hold).
- **Product change — payroll tax (Nic):** GAM no longer computes income-tax
  withholding. Bookkeeper enters **federal + state** per employee; GAM auto-fills
  only SS (6.2%) + Medicare (1.45%); net = gross − all four. Backend + Books UI
  (`apps/books`) + tests.
- **Product change — bookkeeper invites (Nic):** the GAM-admin direct-create tool
  is gone; **landlords invite their own bookkeeper** from the Team page (email
  link → bookkeeper sets own password). New `BookkeeperInviteForm` on
  `apps/landlord/TeamPage.tsx`; `apps/books` MyClients invite UI removed.

### B. Subsystem 18 — Admin (combed + fixed)
- **Bug (FIXED):** `/admin/nacha/monitoring` was admin-gated but NACHA monitoring
  is platform-staff-only → now `requireSuperAdmin`.
- **Bug (FIXED):** `/admin/tenants/:id/flexsuite-acceptances` had no portfolio
  scope (its sibling `/onboarding/tenant/:id` does) — a regular admin could read
  any tenant's SSDI/SSI-gated FlexSuite enrollment → now portfolio-scoped.
- Login 2FA confirmed universal (S578) incl. admin/admin-ops (same `/auth/login`).
- Stale `admin.test.ts` tests corrected to the tightened gates (system-features =
  owner-only, property-flags = super_admin, onboarding-overview = portfolio-scoped).

### C. Portfolio Manager — role, portal, referral model (the big build)
Full design + phase status in **`PORTFOLIO_MANAGER_SPEC.md`**. Locked with Nic:
separate scoped role (allow-list) replacing admin-ops; **single-tier** referral
(no MLM) anchored to the **person** so it survives 1031s/new-LLCs; co-owners with
no upline are captured under the account's founder (dormant until they go solo);
commission = per-occupied-unit software usage, never a property transaction.

- **P1 (DONE):** `portfolio_manager` in shared `USER_ROLES` + label; migration
  `20260806120000` extends `users_role_check`.
- **P2 (DONE):** person-level `users.referred_by_user_id` (migration
  `20260806120100` + backfill), set at signup (incl. PM ref codes) + co-owner add
  (first-touch wins). `commissionAccrual.ts` closer now **falls back** to the
  owner's person-upline — the fallback survives 1031s and pays a captured primary.
- **P3 (DONE):** `routes/portfolio.ts` = `/api/portfolio`, admits
  admin/super_admin/**portfolio_manager**, **shares the exact scoped handlers**
  (exported from admin.ts + landlords.ts, **no duplication**): landlords,
  onboarding/overview + landlord/:id + tenant/:id, tenants, onboarding/resend,
  my-referral, commissions/summary. Wall verified (PM 403'd on /api/admin). Roster
  + `/landlords/:id/assign` accept the new role; super_admin re-attach
  `POST /admin/users/:userId/referral-upline`.
- **P4 (DONE):** `apps/admin-ops` admits `portfolio_manager` (4 auth checks),
  book calls repointed to `/api/portfolio`, platform-only nav hidden from a PM,
  and a **Commissions** page added (`/commissions`) — this-month + all-time
  earnings, per-account breakdown, and the copyable referral link. Every
  PM-visible page uses `/api/portfolio`; a PM can log in, see their book, and see
  their money.

**Launch reality:** the commission ALREADY flows to Nic today (he's super_admin,
can self-assign as closer/CS; `commissionAccrual` pays whoever's attributed). The
new work unblocks **external** PMs getting a safe scoped portal.

## TREE STATE
- All session-touched suites green: **122 passed** (portfolio 6, admin 18,
  nacha 11, landlords 17, landlord-members 6, auth 35, scopes 19, commission 10).
  Books suites (143) green earlier. tsc clean: api, admin-ops, admin, books,
  landlord, shared. Migrations `20260806120000/120100` applied; schema regenerated.
- **Nothing committed.** Working tree also holds the full uncommitted S578→S591
  sweep (60+ files) — one deploy at the very end.

## REMAINING (next session) — all non-blocking; the PM role/portal is functionally complete
1. **Optional:** share the secondary scoped endpoints (connect-readiness,
   landlord-banking-nudges, notifications) on `/api/portfolio` IF the portal later
   surfaces them (it doesn't call them today). (The shared `resend` is already
   portfolio-scoped + tested.)
2. **P5:** reassign any external PM-admins to `portfolio_manager` (Nic is
   super_admin, so his own commission already flows).
3. **Resume the sweep** (paused mid-S18 for the PM build): finish S18 verification,
   then S19–24; confirm S16 (storefront) status against S591.

## RELEVANT MEMORIES
[[gam-portfolio-manager-role-and-referral]] (NEW), [[gam-portfolio-manager-comp]],
[[gam-foreign-ref-write-scope]], [[gam-comb-thoroughly-no-overclaim]],
[[gam-owner-login-email-2fa]], [[gam-simplicity-principle]], [[fix-what-you-find-no-deferring]].

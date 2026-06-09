# Session 156 — OTP landlord UI + admin beta toggle

## Theme

Surface S155's OTP backend in the landlord portal behind a hard double-gate
(global system feature flag AND per-landlord beta toggle). Add the admin
control to flip the per-landlord toggle from the existing Landlords detail
panel. UI is invisible to landlords by default — Nic can opt selected
landlords into the beta one at a time.

## Shipped

### Landlord portal
- **`apps/landlord/src/pages/OtpPage.tsx`** (NEW, ~250 lines)
  - Visibility gate: calls `GET /landlords/me/otp/visibility` first; if
    `visible === false` shows a "Coming soon" placeholder card and exits.
  - KPI tiles: enrolled count, in-flight cycles, total advanced (lifetime),
    fees earned (lifetime 1% spread), defaulted count.
  - Eligible-tenants table: name / unit / qualification status / action.
    Disabled "Enroll" button on blockers (bg_check, ach, deposit, nsf
    cooldown). Working tenants get an Enable / Disable mutation against
    `POST /landlords/me/otp/enable` and `POST /landlords/me/otp/disable`.
  - Advances history table: cycle / tenant / unit / rent / fee / advance
    amount / status (pending, advanced, settled, defaulted).
  - All data via react-query with `staleTime: 5min`.

- **`apps/landlord/src/main.tsx`**: import + `<Route path="otp">`.

- **`apps/landlord/src/components/layout/Layout.tsx`** — added
  visibility query at top of nav block:
  ```ts
  const { data: otpVis } = useQuery<{ visible: boolean }>(
    'otp-visibility',
    () => apiGet('/landlords/me/otp/visibility'),
    { staleTime: 5 * 60 * 1000,
      enabled: role === 'landlord' || role === 'property_manager' },
  )
  const showOtp = (otpVis as any)?.visible === true
  ```
  Then a conditional `<NavLink to="/otp">` rendered only when `showOtp`
  is true. Hidden by default for every landlord — backend default is OFF
  on both gates.

### Admin portal
- **`apps/admin/src/main.tsx`** — `LandlordsPanel` detail card now has
  a "Beta Features" section with a single toggle row for "On-Time Pay
  (OTP)". Calls `PATCH /api/admin/landlords/:id/otp-rollout` with
  `{ enabled: boolean }`. Reads current state from
  `detail.landlord.otpRolloutEnabled` (auto-camelCased by api/lib/
  caseConversion.ts). Invalidates `['landlord-detail', selected.id]`
  on success.

  Surface placement: bottom of the detail card under the existing
  resend-email buttons, separated by a divider. Easy to find without
  cluttering the onboarding-checklist UX. The system-features global
  toggle (S155) lives on its own admin nav route — both must be ON
  for the link to render in any landlord's nav.

## Decisions made

1. **Two-gate gating, not one.** Global `system_features.otp_rollout_visible`
   = master kill switch. Per-landlord `landlords.otp_rollout_enabled` =
   beta opt-in. The visibility endpoint AND-folds them. This protects
   against accidental rollout: if Nic opts a landlord in but the global
   flag is still OFF, nothing surfaces. Same in reverse.

2. **No tenant-side OTP UI.** Per the S155 product correction: OTP is
   a landlord product (rent advance with 1% spread). Tenants see
   nothing. The deprecated `POST /tenants/me/otp/enroll` endpoint was
   already 410'd in S155.

3. **Admin toggle placement.** Inside the existing Landlords detail
   panel, not as a separate page. Flipping a beta flag on a known
   landlord is a one-click action; no need for a dedicated route.

4. **Beta-tag visual.** The toggle button reads "Enable" → "✓ Enabled"
   and uses `bg2-btn` (success styling) when on, plain `bg-btn` (gold)
   when off. No pill, no extra text. Consistent with existing detail
   panel button patterns.

## Files touched

```
apps/landlord/src/pages/OtpPage.tsx                     (NEW)
apps/landlord/src/main.tsx                              (route + import)
apps/landlord/src/components/layout/Layout.tsx          (vis query + NavLink)
apps/admin/src/main.tsx                                 (beta toggle UI + handler)
```

## Validation

- `tsc --noEmit` clean across all four projects: api, landlord, tenant, admin.
- Backend endpoints exercised in S155 smoke; UI consumes them as wired.
- Live browser check NOT performed (no smoke walks unless Nic initiates).

## Items deferred / known follow-ups

- **OTP disbursement engine integration.** Settled rent payments tagged
  `ONTIMEPAY` need to flow into the ACH push to landlord side. Currently
  `reconcileSettledRentPayment` updates `otp_advances.status='settled'`
  but doesn't trigger payout. Will surface naturally when the destination-
  charge allocation engine is rebuilt under Stripe Connect Express
  (S113+ track).
- **Reenrollment policy after a default.** Service hardcodes 6-month
  cooldown via `otp_disqualified_until`. No UI for landlord to override
  or extend. Punt to first real default in beta.
- **Beta cohort size.** No throttle in the admin toggle. Nic flips
  whichever landlords. Tracking who's enrolled is via `SELECT id, business_name
  FROM landlords WHERE otp_rollout_enabled = true`.
- **Audit trail for the toggle.** No `otp_rollout_audit` table. The
  PATCH endpoint just flips the bool. If we ever need who-toggled-what-
  when, add an audit row write inside the route handler.

## What next session should target

The big remaining backlog item is **PM third-party companies subsystem**
(see CLAUDE.md "PM (property management) subsystem" — concept #2 only,
the `pm_companies` / `pm_staff` / `pm_fee_plans` triad). This is a
dedicated session per the schema landmines doc — full design under
the new Stripe Connect Express rails (S113 architecture):

1. Schema: pm_companies, pm_staff, pm_fee_plans, landlords.pm_company_id
   pointer (or per-property assignment — needs design Q to Nic).
2. Connect onboarding for PM company owners (separate Connect account
   from individual landlords).
3. Fee-routing wiring: PaymentIntent `transfer_data[]` multi-destination
   so Stripe splits at charge time instead of post-settlement ledger
   writes.
4. Owner visibility view ("PM cut vs my net").
5. PM staff invite flow + permission scopes.
6. Restore the PM-company notification path inside
   `routeMaintenanceNotification` (S107 wired only the in-house manager
   path; the third-party PM staff notification was lost).

Other smaller items:
- Tax-form catalog (S91 outstanding promise).
- Master Schedule stub-column cleanup (CLAUDE.md mentions 9 stub columns).
- GAM Books AZ-specific tax form genericization.

## Misc

- Migration count after S155: `20260506130000_otp_infrastructure.sql`
  is the latest. No new migrations this session.
- `system_features` row for `otp_rollout_visible` defaults to FALSE.
  Stays FALSE until Nic flips it via the admin System Features page.
- Per-landlord `landlords.otp_rollout_enabled` defaults to FALSE for
  every landlord (S155 migration backfill).

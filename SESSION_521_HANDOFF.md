# SESSION 521 HANDOFF

Theme: **Reports/platform-fee correctness + super-admin Scaling panel + walkthrough cleanup.**
Launch-polish session. No migrations authored. All work verified (tests + live).

---

## Shipped

### 1. Landlord Reports — rebuilt as a real reporting surface
`apps/landlord/src/pages/ReportsPage.tsx` + `apps/api/src/routes/reports.ts`.
- Tabbed: **Overview** (KPIs + MTD/YTD SVG charts + monthly P&L drill-in), **By Property**
  (per-property P&L, clickable → property-detail modal with trend + units/payments/maintenance),
  **Annual & Tax** (tax-summary + work-trade 1099), **Owner Statement** (now a proper P&L).
- Surfaced 4 previously-dead endpoints: property-pl, tax-summary, work-trade-1099, monthly-statement.
- Export: Print (CSS print stylesheet) + CSV.
- **Owner Statement = P&L**: Income (rent/other, deposits excluded as custody) green / Expenses RED
  (platform fee + maintenance) / Net to Owner gold.
- Fixed a **camelCase bug**: the API response middleware camelCases keys, but Owner Statement /
  By Property / 1099 tables read snake_case → blank dates/props/costs with real data. All fixed.
  (Tests pass without the middleware, so it was invisible until real data.)

### 2. Platform fee — one authoritative calc (the big one)
**NEW `apps/api/src/services/platformFee.ts`** (`platformFeesByProperty` + `periodMonths`). Used by
ALL reports AND the landlord Dashboard endpoint. Retired three divergent calcs.
- Pricing LOCKED (Nic): **$2/billable unit, floored at $10 PER-PROPERTY MINIMUM — full stop.** Every
  property bills ≥$10/month, occupied or not. Billable = leases overlapping the month + CEIL(short-stay
  nights/30).
- Source of truth = `platform_fee_accruals.total_amount`; live estimate fills un-accrued months.
- **Charged from onboarding (`created_at`) forward only** — never a month before the property joined
  (landlord onboarding July 1 → July forward), and **never a future month** (periodMonths excludes them;
  the Reports month picker disables future months — for 2026 you can't pick past the current month).
- **Root bug fixed:** reports derived the fee from `v_unit_occupancy.is_occupied` — a current snapshot
  that ignores short-stay/nightly bookings (RV core market) → $0 fee on properties that earned rent.
- **Dashboard** (`/landlords/me/dashboard`) now returns authoritative `platformFee` + `platformFeeByProperty`
  breakdown; DashboardPage fee modal shows per-property. All surfaces now agree with the bill.
- **Seed vs real data (Nic):** report logic is identical; seed/demo properties are BACKDATED
  (`db/seed.ts`: created_at = NOW() - 18mo) so the demo P&L looks full. Real landlords keep true onboarding.
  Existing dev demo props (james/maria) backdated to 2024-12-28.

### 3. Maintenance platform fee → 3%, reserved + hidden
`PLATFORM_FEES.MAINTENANCE_PCT` 8% → **3%** (`packages/shared`). It's reserved for a FUTURE
Angi-competitor contractor marketplace — NOT a launch charge. Landlord pays only actual maintenance cost.
Removed from every surface: landlord MaintenancePage span, admin maintenance Fee column + "8%" subtitle,
maintenance stats `total_fees`, and all reports payloads. Kept the column + computation for the future feature.

### 4. Scaling Readiness panel (super-admin)
**NEW** `apps/api/src/lib/apiMetrics.ts` (p95 latency ring buffer) + `index.ts` latency middleware +
`admin.ts` `GET /admin/infra-readiness` + `apps/admin/src/main.tsx` `ScalingReadiness` page
(Admin → Platform → 📈 Scaling Readiness). Live trackers (occupied units, monthly $ volume, Mac CPU
load/core, Postgres conns, API p95) each ok/watch/move, overall verdict, + the Vercel+Mac→Render
migration game plan. Gated at admin (demo account is role `admin`, not super_admin).

### 5. Walkthrough items (all small-code items now CLEARED)
- **Team page**: residual "Stripe Connect" labels → "Bank ready" / "Awaiting bank setup".
- **Sales agent Jordan → Lucy** + stripped the rent-GUARANTEE/advance pitch from sales knowledge
  (`knowledge-content/sales/*.md`) — violated the no-advance/no-guarantee launch rule. **Re-ingested**
  the knowledge store (121 chunks). Live-verified: Lucy intros correctly and refuses the guarantee.
- **Public-agent auth bug FIXED:** `propertyBookingAdminRouter` was mounted at broad `/api` with a
  router-wide `requireAuth`, 401-ing the public `/api/sales` + `/api/guest` agents mounted after it
  (Lucy's marketing widget + booking-guest agent were unreachable). Moved auth to per-route.
- **Inspection agent smoke test:** create_inspection fired but set_inspection_item_condition did NOT
  (Hermes wouldn't chain the 2nd tool, deferred to "the app"). Strengthened the inspection prompt
  (`profiles.ts`) → both tools now fire; live-verified conditions land in `unit_inspection_items`.
  Takeaway: Hermes needs forceful prompting to chain a second tool.
- **Master Schedule QR removed** (`SchedulePage.tsx`) — Guest link now just shares the link.
- **Junk reservations cleaned** — cancelled james's "dasf"/"wdf" test bookings (status='cancelled';
  calendar filters those out).

### 6. Ops
- Restarted/trimmed to the **launch set only** (agents + landlord/tenant/admin/marketing/pos);
  other 9 portals stopped. Added landlord+admin to `~/.claude/launch.json` for previews.

---

## Files touched (key)
`packages/shared/src/index.ts` · `apps/api/src/routes/reports.ts` · **NEW** `apps/api/src/services/platformFee.ts` ·
`apps/api/src/routes/landlords.ts` · `apps/api/src/routes/admin.ts` · **NEW** `apps/api/src/lib/apiMetrics.ts` ·
`apps/api/src/index.ts` · `apps/api/src/routes/maintenance.ts` · `apps/api/src/routes/propertyBookingAdmin.ts` ·
`apps/api/src/services/agents/profiles.ts` · `apps/api/src/services/agents/knowledge-content/sales/*.md` ·
`apps/api/src/db/seed.ts` · `apps/landlord/src/pages/{ReportsPage,DashboardPage,MaintenancePage,TeamPage,SchedulePage}.tsx` ·
`apps/admin/src/main.tsx` · tests: `reports.test.ts`, `maintenance.test.ts`, `profiles.test.ts`.
Tests green; all apps typecheck.

## Dev DB changes (deliberate)
- Demo properties (james/maria) `created_at` backdated to 2024-12-28 (populated demo P&L).
- james "dasf"/"wdf" bookings → cancelled.
- All transient test artifacts (temp properties, draft inspections, seeded payments) cleaned up.

## DECISIONS (load-bearing)
- Platform fee model: see §2. $2/$10-full-stop, onboarding-forward, accrual-sourced, one service.
- Maintenance 3% = future contractor marketplace, hidden at launch.
- Sales agent = **Lucy**, no rent guarantee.
- Memories written: `gam-launch-portal-scope`, `gam-platform-fee-income-source`,
  `gam-maintenance-8pct-contractor-marketplace`.

## What next session should target
Build is effectively done; remaining is infra/vendor/deferred (NOT launch-blocking code):
- **Hosting (dev's call — Vercel frontends + Mac backend via Cloudflare Tunnel):** launchd service to
  keep API+scheduler alive across reboots; nightly Postgres backups; wildcard DNS+TLS for booking site.
  *(The launchd + backup script is the one piece Claude offered to write — not yet done.)*
- **Vendor keys:** Checkr (Mon), Stripe live → webhook at prod URL, Resend domain, Twilio SMS.
- **FlexSuite:** FlexDeposit/FlexCharge/FlexPay flip on when ready; **FlexCredit not built** (Esusu-blocked,
  dedicated session).
- **Legal:** counsel review of FlexDeposit custody ToS + arbitration/liability.
- **Deferred non-launch:** Fitness, Property Intelligence data accuracy, admin-ops unit drill-down,
  native driver app, customer-portal push toggle.

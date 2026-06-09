# Session 147 Handoff

**Theme:** Continued autonomous polish. Tenant + admin
mobile-responsive sweeps (mirror of S146 landlord pass) plus
v_unit_occupancy view audit.

## Items shipped

### Tenant mobile-responsive sweep

7 inline tables in `apps/tenant/src/main.tsx` wrapped:

```
PaymentsPage tables               (minWidth: 680)
MaintenancePage requests          (minWidth: 780)
TenantInspectionsPage list        (minWidth: 640)
TenantInspectionDetailPage items  (minWidth: 600)
NotificationPrefsPage             (minWidth: 480)
TenantEntryRequestsPage list      (minWidth: 680)
DocumentsPage list                (minWidth: 640)
UtilitiesPage list                (minWidth: 820)
```

Same `overflowX: 'auto'` on parent `card` + `minWidth` on the
`tbl` itself pattern.

### Admin mobile-responsive sweep

3 admin tables wrapped (the others have complex grid2 / nested
panel structure that I left alone to avoid layout regressions):

```
Onboarding landlords list (line 261)  (minWidth: 540)
Maintenance list                      (minWidth: 920)
Disputes list                         (minWidth: 760)
```

The remaining admin tables (~9 more) live inside grid2 panels
that already constrain their width via the parent grid; wrapping
them blindly risks double-scrolling. Defer to a real polish
session if mobile use surfaces issues.

### v_unit_occupancy view audit

Inspected the view definition + 9 consumers. Findings:

- View correctly filters `l.status='active'`, `lt.status='active'`,
  `lt.role='primary'` for primary tenant resolution
- LATERAL JOIN with `LIMIT 1` deduplicates correctly
- `is_occupied` derived from `primary_info.tenant_id IS NOT NULL`
- `tenant_count` aggregates all active lease_tenants per active
  lease

Consumers (all correct usage):
- `apps/api/src/jobs/scheduler.ts`
- `apps/api/src/routes/admin.ts`
- `apps/api/src/routes/reports.ts` (4 places)
- `apps/api/src/routes/tenants.ts`
- `apps/api/src/db/seed.ts`

No changes needed. The view aligns with the lease_tenants model
(S107+) and credit-ledger work (S134+) didn't introduce any
inconsistencies.

## Files touched

```
apps/tenant/src/main.tsx                        (7 table wraps)
apps/admin/src/main.tsx                         (3 table wraps)
```

No DB migrations. No backend changes. No emitter changes.

## Validation

- `npx tsc --noEmit` on api / landlord / tenant / admin → all exit 0
- v_unit_occupancy view + consumers reviewed; no inconsistencies
- No live smoke needed (CSS-only changes)

## Pre-launch backend status

No backend changes this session. Closed list updates:
- ✅ Tenant mobile-responsive sweep (7 tables)
- ✅ Admin mobile-responsive sweep (3 tables; 9 nested ones
  intentionally deferred)
- ✅ v_unit_occupancy view audit (no changes needed; view +
  consumers all correct)

Open items unchanged from S146:
- PM third-party-companies subsystem (full build, product input)
- `lease_fees due_timing` full wire-up (product call; alert in place)
- OTP enablement (product call)
- Stripe sandbox testing (test key)
- Live browser smoke walkthrough (interactive)

## What next session should target

Visible autonomous-friendly items remaining after S142–S147:

1. **Live browser smoke walkthrough** — biggest open item; needs
   you at the keyboard.
2. **Tax form catalog scaffold** — the S91 comment promised a
   landlord-configurable per-state tax-form catalog (CA DE-9, NY
   NYS-45, etc.). Empty table + admin UI to populate would be a
   real start without committing to billing logic. Full session.
3. **Landlord-portal `/notifications` surface** — landlord doesn't
   currently have a notification inbox like the tenant portal does
   (`/notifications` route + page exists on tenant; landlord just
   has a NotificationBell in the header). Could build a parity
   inbox view.
4. **Bookings list view on landlord** — Schedule shows bookings on
   a calendar grid, but there's no flat list/index view for
   filtering by guest, source, status. Small.
5. **Tenant payments → my-record cross-link** — when tenant taps a
   payment in `/payments`, link to the corresponding event on
   `/credit`. Cosmetic.

Recommendation: option 4 (bookings list view) since it's a
small, self-contained feature that fills a real gap (CLAUDE.md
"Architectural decisions worth preserving" + the live booking
subsystem don't have a flat-list surface).

## Notes for future-Claude

- The admin app has ~9 tables I didn't wrap — they live inside
  `grid2` panels that constrain width via flex/grid layout. If a
  future session wants to add overflow there, also adjust the
  parent grid to `grid-template-columns: 1fr` at narrow viewports
  via media query so the panels stack instead of squeezing.
- Tenant inline pages share styling with admin (single `<style>`
  block). The `.tbl` class doesn't have a baked-in min-width
  (intentional, mirrors landlord); each page sets it inline.
- v_unit_occupancy LATERAL with LIMIT 1 means `primary_tenant_id`
  is non-deterministic if a lease somehow has 2 primary
  lease_tenants. The lease_tenants schema doesn't enforce that,
  but the typical primary-cascade flow does. If a future
  invariant violation surfaces, add a unique constraint on
  `(lease_id, role) WHERE status='active'`.

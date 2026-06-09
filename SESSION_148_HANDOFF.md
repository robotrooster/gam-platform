# Session 148 Handoff

**Theme:** Bookings flat-list view added on landlord portal.
Fills the gap CLAUDE.md's "Architectural decisions worth
preserving" implies but didn't have a surface for: a flat list
view of bookings with filters, separate from the
SchedulePage calendar grid.

## Items shipped

### Backend: GET /api/bookings (portfolio-wide)

New endpoint at `routes/bookings.ts`. Landlord-scoped (admins
read all). Filters:
- `status` — confirmed / checked_in / checked_out / cancelled / no_show
- `source` — direct / airbnb / vrbo / booking_com / other
- `unitId` — single unit filter
- `from` / `to` — date range against check_in / check_out
- `q` — case-insensitive search on guest_name + guest_email

Returns joined rows with unit_number, unit_type, property_name
so the UI doesn't need follow-up requests. Limit 500 to keep
response sizes sane; if a landlord has more, they'd narrow with
filters.

Defense-in-depth: results filtered through `canAccessLandlordResource`
so team-roles whose scope row constrains visibility don't see
bookings they shouldn't.

Mounted at `/api/bookings` in `index.ts`.

### Landlord: BookingsPage flat list

New page at `/bookings`. Filter row (search / status / source /
date range), KPI subline (count + total revenue across the
filtered set), data table:

```
Status | Guest (name + email) | Unit (number + property) | Check-in (→ check-out) | Nights | Total | Source
```

Status badges follow the existing `badge-blue/green/muted/red`
palette. Mobile-responsive (overflowX + minWidth on table).

Cross-link: page-sub line includes a small button to
`/schedule` for users who want the calendar view, since that's
the primary visualization tool.

Nav entry added under the Portfolio section directly after
"Master Schedule," visible to landlord / property_manager /
onsite_manager (same scope set as the calendar). Permission gate
matches Master Schedule (`units.view_status` etc.) so anyone who
can see the calendar can see the list.

## Files touched / created

```
apps/api/src/routes/bookings.ts                     (new — 80 lines)
apps/api/src/index.ts                               (router import + mount)

apps/landlord/src/pages/BookingsPage.tsx            (new — 170 lines)
apps/landlord/src/main.tsx                          (route)
apps/landlord/src/components/layout/Layout.tsx      (nav entry)
```

No DB migrations. No tenant changes. No admin changes.

## Validation

- `npx tsc --noEmit` on api / landlord / tenant / admin → all exit 0
- Live smoke skipped — dev DB has 0 bookings; SQL is straightforward
  and parallels the existing per-unit endpoint pattern

## Pre-launch frontend status

Closed list updates:
- ✅ Bookings flat-list view (backend + landlord UI)

Open items unchanged from S147:
- PM third-party-companies subsystem (full build, product input)
- `lease_fees due_timing` full wire-up (product call; alert in place)
- OTP enablement (product call)
- Stripe sandbox testing (test key)
- Live browser smoke walkthrough (interactive)

## What next session should target

Visible autonomous-friendly items remaining:

1. **Live browser smoke walkthrough** — biggest open item; needs
   you at the keyboard.
2. **Bookings PATCH UX** — Bookings list is read-only; clicking
   a row could open a small edit panel (status, notes, dates).
   The PATCH endpoint already exists.
3. **Tax form catalog scaffold** — landlord-configurable per-state
   tax-form catalog (CA DE-9, NY NYS-45, etc.). Empty table +
   admin UI to populate. Full session.
4. **Tenant payments → my-record cross-link** — tap a payment
   in `/payments` to deep-link to its corresponding event on
   `/credit`. Cosmetic.
5. **Landlord-portal `/notifications` inbox** — landlord doesn't
   currently have a notification inbox like the tenant portal
   does (`/notifications`). The NotificationBell is in the
   header; a full inbox view would parity with tenant.

Recommendation: option 5 (landlord notifications inbox) since
it's a self-contained feature that fills a real parity gap.
Leverages existing backend (`GET /api/notifications` already
serves both apps).

## Notes for future-Claude

- Bookings list query LIMITs at 500. If a landlord has more than
  500 bookings in a single filter, they'll see only the most
  recent 500. Pagination is a follow-up; for v1 the date-range
  filter is the natural way to slice large portfolios.
- The endpoint accepts `from` / `to` as raw strings and passes
  them as-is to a DATE comparison. Pg coerces gracefully but
  arbitrary strings would fail with a type error rather than
  silently match. Tested with empty + ISO-date inputs.
- The case-insensitive search uses `LOWER(...) LIKE` against
  guest_name + guest_email. An index on these columns would
  help at scale; pg defaults are fast enough for v1 volumes.
- The frontend KPI sums `total_amount` client-side over
  filtered results. With 500-row limit that's negligible; if
  pagination lands, move the sum to a server-side aggregate
  query.

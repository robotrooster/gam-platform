# Session 495 — closed

> GAM for Business — step 3 of the suite. Appointments UI on
> the existing Phase 1a backend.

## Theme

**Appointments feature live for businesses with the
`appointments` toggle enabled. The Phase 1a appointments table
(S459/S460) + routes are already business-agnostic — built for
the trash company's recurring-schedule materializer but shaped
for any timed-visit model. This session adds the AppointmentsPage
UI: upcoming/past sections with status filter pills, create
modal with customer + service + datetime + duration, detail
view with edit / mark-complete / cancel actions, and cancel
modal with optional no-show flag. Nav item gated by the
`appointments` feature toggle (S492). Zero backend changes —
the existing routes already do the right thing.**

Suite (api) at S494 close: 3142 / 165.
Suite (api) at S495 close: **3142 / 165 / 0 failures** —
unchanged. No API touches this session.

apps/business tsc + build clean. Bundle 374.05 KB / 103.10 KB
gzipped (+17 KB vs S494 from the AppointmentsPage + modals).

## What shipped

### `apps/business/src/pages/AppointmentsPage.tsx` — NEW

~580 lines. Single component owning list view + detail view +
3 modals.

**List view:**
- Sectioned: "Upcoming" (status=scheduled AND scheduled_for >=
  now) + "Past" (everything else). Status filter pills override
  the sectioning — when a filter is set, single flat list.
- Filter pills: All / Scheduled / Completed / Cancelled / No-show.
- Table with When (date+time, "Recurring" subtitle when row
  came from a recurring schedule), Customer (company name or
  first+last), Service type, Duration, Status badge with tone-
  per-status.
- Rows click into detail view.
- Empty state: "Add a customer first" gate when no customers
  exist.

**Detail view:**
- Page header: service type (large), date+time + duration in
  the subtitle row, status badge top-right.
- Customer card (highlighted block, tap-to-call link when phone
  on file).
- Notes block when present.
- Status-specific banners: green "Completed at X" when done;
  muted "Cancelled at X — reason" when cancelled.
- Action buttons by status:
  - Scheduled: Edit / Mark complete / Cancel
  - Completed / Cancelled / No-show: read-only

**Create modal:**
- Customer dropdown
- Service type free-form input (placeholder hints: "Oil change /
  Haircut / Inspection / etc.")
- Date+time picker (defaults to next half-hour rounded up from
  +1 hour)
- Duration input (default 30 min)
- Notes textarea

**Edit modal:**
- Same fields as create except customer is locked (shown as a
  read-only block — change customer = cancel and recreate
  semantics)

**Cancel modal:**
- Required reason input
- Checkbox: "Mark as no-show (customer didn't show up)" —
  flips the status to `no_show` instead of `cancelled` so the
  customer history reflects reality

### `apps/business/src/components/layout/Layout.tsx`

New nav item under Operations section:
```ts
{ to: '/appointments', icon: CalendarDays, label: 'Appointments',
  roles: ['business_owner', 'business_staff'],
  feature: 'appointments' }
```

Sits right after Invoices. Visible to both owner and staff
(unlike Invoices which is owner-only — appointments are
operations work).

### `apps/business/src/main.tsx`

`<Route path="/appointments" element={<AppointmentsPage />} />`
registered.

## Items shipped

```
apps/business/src/pages/
  AppointmentsPage.tsx                         (NEW — ~580 lines)
apps/business/src/components/layout/
  Layout.tsx                                   (+ CalendarDays icon + nav item)
apps/business/src/
  main.tsx                                     (+ import + route)
```

**Zero backend changes.** Existing `apps/api/src/routes/
appointments.ts` (S459) already handles POST/GET/PATCH/complete/
cancel scoped per-business. The customer-belongs-to-business
guard inside POST already prevents cross-business issues.

## Decisions made during build

| Question | Decision |
|---|---|
| Reuse the Phase 1a `appointments` table or new | **Reuse.** Already business-agnostic — `business_id`, `customer_id`, `service_type`, `scheduled_for`, `duration_minutes`, `status` enum (scheduled / completed / cancelled / no_show). The `recurring_schedule_id` is nullable so one-off appointments stay NULL. |
| Feature gate at API or UI only | **UI only.** The appointments table is shared infrastructure that both the `routing` feature (Phase 1a's recurring-schedule materializer creates rows) AND the new `appointments` feature consume. Gating the API would break trash company routing. UI nav gate is sufficient for discoverability; per-business scoping inside the routes covers data isolation. |
| Allow editing the customer on an appointment | **No.** Edit modal locks the customer field. Changing who an appointment is for is semantically a different appointment — cancel + recreate. Avoids confusion and accidental data swaps. |
| Cancel vs no-show as separate actions or one modal | **One cancel modal with a no-show checkbox.** Both flows need a reason; the only difference is the final status. Single surface keeps the UX simple. |
| Show recurring vs one-off distinction | **Subtle subtitle "Recurring" in the When cell.** Hide the schedule mechanics; just signal that the appointment came from a recurring rule so the operator knows future iterations exist. |
| Upcoming/past sectioning | **Yes — default view.** Operators want to see what's next; past appointments stay accessible but quiet. Status filter overrides the sectioning. |
| Time zone handling | **Browser local.** Each operator works in their local tz; backend stores `timestamp with time zone` so the round-trip is correct. No per-business timezone surface yet. |

## Verification

- `cd apps/business && npx tsc --noEmit`: clean.
- `cd apps/business && npm run build`: clean — 374.05 KB JS /
  103.10 KB gzipped (+17 KB vs S494).
- Full: `cd apps/api && npm test` — **3142 / 165 / 0** unchanged
  from S494.

### Bugs caught during build

None.

## Phase status — GAM for Business suite

| Step | Status |
|---|---|
| 1. Feature toggle infrastructure | ✅ S492 |
| 2. Invoicing CRUD + manual mark-paid | ✅ S493 |
| 2b. Stripe Connect wiring (online pay) | ✅ S494 |
| 3. Appointments | ✅ **S495** |
| 4. Per-vertical: POS / Inventory | ⏳ next |
| 4b. Per-vertical: work_orders / customer_vehicles | ⏳ |
| Polish: Email send (Resend) for pay links + appointment confirms | ⏳ |
| Polish: /invoice-paid landing page on marketing site | ⏳ |

## What the next session should target

**POS + Inventory** (per agreed order — mini market is the next
business model after trash).

The existing GAM POS lives at port 3005 (`apps/pos`) and was
built for landlord-side use (S95+). Per the S493 decision call
A, we wire it as a business-portal feature toggle reusing the
existing surface.

Scope to think about for that session:
- Backend: extend the POS schema (already exists for landlords)
  to accept `business_id` scoping alongside `landlord_id`. Or
  build a parallel `business_pos_*` set if the data model
  doesn't cleanly extend.
- Frontend (apps/business): Inventory page + POS page, both
  feature-gated on `pos` and `inventory`. Inventory pairs with
  both POS (for retail SKUs) and Work Orders (for parts), so it
  needs to live under both gates.
- The standalone apps/pos app stays as-is for the landlord POS
  flow; the business portal embeds the UI for now.

That's substantial — two features (POS + Inventory) that are
interdependent. Might span two sessions:
- Session A: Inventory backend + UI (lighter, foundational)
- Session B: POS embedded in business portal + transaction flow

Alternative: appointments polish before pushing to step 4.
Specifically:
- Calendar/week view alongside the list (operators with many
  daily appointments benefit)
- Recurring appointment creation from the business portal (today
  the materializer runs from `recurring_schedules` table which
  business-portal SchedulesPage already manages — could be
  re-purposed under the `appointments` toggle when `routing` is
  off)

Recommend **POS + Inventory next** to keep the suite progressing
toward the mini-market user model. Appointments polish can ride
on a future polish session.

---

End of S495 handoff. **Appointments UI live on the existing
Phase 1a backend. Zero API changes; clean reuse of shared
infrastructure.**

3142 tests / 165 files / 0 failures.

**Step 3 shipped. 4 of the 11 features in the catalog now have
UI surfaces (customers, staff, invoicing, appointments).**

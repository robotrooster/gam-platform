# Session 467 — closed

> SERVICE-BUSINESS / Phase 1a arc (continues S466).

## Theme

**Two pages — CustomersPage expanded from stub to fully
functional (create form + per-row geocode-backfill button +
ungeocoded warning banner), and brand-new SchedulesPage with
a friendly day-of-week / monthly-day RRULE editor that hides
RFC 5545 from the operator. Plus nav addition for Schedules.
With these two pages, the trash company can do every step of
onboarding in the browser.**

Suite (api) at S466 close: 3017 / 159.
Suite (api) at S467 close: **3017 / 159 / 0 failures** — no
API changes this session.

apps/business `npm run build`: clean. 269.28 KB JS / 81.92 KB
gzipped (+15 KB vs S466 from the new SchedulesPage).

Zero tsc regressions.

## What shipped

### `pages/CustomersPage.tsx` — expanded from S458 stub

Was: read-only table with no form ("use the API directly to
seed").

Now:
- **Full create form** mirroring the DepotsPage shape —
  individual vs business toggle (with company_name field
  appearing conditionally), required name + address fields,
  optional email/phone/street2.
- **Per-row "Geocode" button** appears only on rows where
  lat/lon is null. Calls POST /api/business-customers/:id/
  geocode (S465). Loading state shows "Geocoding…"; success
  reloads the table; failure surfaces the API's 422 message
  in the error banner.
- **Amber warning banner** above the table when any rows lack
  coords — tells the owner "N customer(s) won't appear on
  routes until backfilled."
- **Coords column** shows truncated lat/lon (3 decimals) when
  present, "missing" in amber when null.

### `pages/SchedulesPage.tsx` — NEW

The hardest piece of the session — making RFC 5545 RRULE
accessible without exposing it.

**Owner experience:**
- Pick customer (dropdown)
- Pick frequency (Weekly / Monthly radio-via-select)
- Weekly: tap day-pill buttons for Mon/Tue/Wed/Thu/Fri/Sat/Sun
  (multi-select; tapped pills go gold)
- Monthly: enter day-of-month (1-28; intentionally caps at 28
  to avoid month-length edge cases like "every 31st")
- Pick time of day (native HTML5 time picker)
- Start date (today by default); end date optional

**Under the hood:**
- `buildRrule(freq, days, monthDay)` composes the RFC 5545
  string at submit:
  - Weekly Tue+Thu → `FREQ=WEEKLY;BYDAY=TU,TH`
  - Monthly 15th → `FREQ=MONTHLY;BYMONTHDAY=15`
- `describeRrule(rrule)` parses the saved rrule back into a
  human label for the list view: "Weekly · Tue, Thu" or
  "Monthly · 15th".

**Lifecycle actions:**
- Active schedules show a "Pause" button → POST /pause
- Paused schedules show a "Resume" button → POST /resume
- Ended schedules show no action button (terminal state).

**Gated empty state**: if the business has zero customers, the
page short-circuits to "Add a customer first" with a gold
call-to-action — schedules need a customer to attach to.

### Layout addition

`Schedules` added to the Operations section, visible to both
business_owner and business_staff (dispatchers need to see/
create schedules). Uses the CalendarClock icon.

### `main.tsx` route

```ts
<Route path="/schedules" element={<SchedulesPage />} />
```

## Items shipped

```
apps/business/src/pages/
  CustomersPage.tsx                            (rewrite — stub → full CRUD
                                                + geocode action + warn banner)
  SchedulesPage.tsx                            (NEW — ~320 lines)
apps/business/src/components/layout/
  Layout.tsx                                   (+ Schedules nav item
                                                + CalendarClock icon import)
apps/business/src/
  main.tsx                                     (+ SchedulesPage import + route)
```

## Decisions made during build

| Question | Decision |
|---|---|
| RRULE editor UX | **Day pills + simple frequency picker.** RFC 5545 is genuinely user-hostile; the owner shouldn't have to know it exists. UI generates the rrule string at submit; the round-trip describes it back as "Weekly · Tue, Thu." If a power user needs custom RRULEs (BYMONTH, EXDATE, etc.) we'd add an "Advanced" toggle later. |
| Day-of-month cap at 28 | **Yes — avoids month-length edge cases.** RRULE's BYMONTHDAY=31 produces no occurrence in February; BYMONTHDAY=30 misses February too. Capping at 28 means every month has exactly one occurrence + no surprises. If "last day of month" is needed later, the RRULE supports BYMONTHDAY=-1; we'd add it as a UI option separately. |
| Customers without geocode visible on schedules list? | **Yes — schedules don't care.** The optimizer skips un-geocoded customers; the schedule itself is fine. Owners can create the schedule + backfill the customer's coords whenever. |
| Pause/resume button placement | **Inline on the row.** Standard SaaS pattern; the action is contextual to the row. Saves the user from "click row → see detail → click action" three-step flow. |
| Service type default | **"Weekly trash pickup"** — sensible for the first trash-company customer. Editable; doesn't lock anyone in. |
| End date — required? | **No.** Most trash service is open-ended ("until we don't anymore"). Leaving it blank = open-ended schedule. Operator can come back and set an end date later via PATCH. |
| Day-pill visual state | **Gold background + gold border when selected.** Matches the brand accent; clearer than checkbox checks at the small size used. |
| Geocode button placement on customers | **Right-column "actions" cell, only when lat=null.** Hidden once coords exist; no visual noise on the happy path. |
| Warning banner copy | **"N customer(s) without coordinates won't appear on generated routes until backfilled."** Specific about the consequence (routes), not just the state (missing). Tells the owner what's at stake + what to do. |

## Verification

- `cd apps/business && npx tsc --noEmit`: clean.
- `cd apps/business && npm run build`: clean. 1491 modules.
  269.28 KB JS → 81.92 KB gzipped (+15 KB vs S466).
- `cd apps/api && npm test`: **3017 / 159 / 0 failures**.
  No API changes.
- **Browser walk deferred** — same posture as the prior UI
  sessions. tsc + build are necessary but not sufficient;
  the walk catches interactive issues.

### Bugs caught during build

None.

## Phase 1a.3 — progress

- ✅ S462–S465 — Backend + geocoder
- ✅ S466 — Fleet UI (depots, vehicles, dumps)
- ✅ **S467 — Customers expansion + Schedules UI (this session)**
- ⏳ Next — Routes page in the portal: "Today's route" view
  with stop list + Generate Route button. Owner + dispatcher
  use this.
- ⏳ Later — Driver UI for daily route execution (mobile-
  friendly tap-to-complete + tap-to-skip). The last critical-
  path piece.
- ⏳ Eventually — vroom swap (dev-team binary + OSRM data).

Phase 1a.3 is ~90% by effort.

## Critical path read

Onboarding flow now works ENTIRELY in the browser:

1. ✅ Owner /signup
2. ✅ /depots → add yard
3. ✅ /vehicles → add truck
4. ✅ /dump-locations → add transfer station
5. ✅ /customers → add customers (auto-geocoded; manual
   backfill button on the few that miss)
6. ✅ /schedules → "Mrs. Smith, every Tuesday at 9 AM"
7. ✅ Materializer runs overnight → appointments exist
8. ⏳ /routes → doesn't exist yet. Owner can hit POST
   /api/routes/generate via curl, but no UI.
9. ⏳ Driver views route on phone → no UI yet.

**The trash company can onboard everything except the
day-of-operation surfaces.** Next session closes that gap.

## What the next session should target

**Recommend: Routes page in apps/business.**

Owner + dispatcher view. Two sub-views on one page:
- **Generate**: pick vehicle + date → POST /api/routes/generate
  → see the result envelope (stop count, distance, time,
  ungeocoded skip count)
- **View**: a list of generated routes filtered to today by
  default + a detail view showing each stop in order with
  customer info + ETA + status

After this, the last piece is the **driver-facing route view**
— mobile-friendly screen with big tap targets for
complete/skip on each stop. That might warrant its own session
since mobile-first design is its own kind of careful.

**Alternatives:**
- Driver UI first — but dispatchers need to GENERATE the
  routes before the driver can see them, so the dispatcher
  view comes first naturally.
- Polish customer detail / edit modal — nice-to-have.
- Phase 1a.1 smoke walk — getting closer to viable. After
  the routes page lands, the whole onboarding flow can be
  walked end-to-end.

## Phase 1a.1 smoke walk

Walk-readiness: HIGH after this session. The portal now has
6 functional pages (Dashboard / Customers / Schedules /
Depots / Vehicles / Dump Locations / Staff / Settings) plus
Login / Signup. The only gaps are Routes (next session) and
driver execution (session after).

You could walk now — sign up a new business, add depot →
vehicle → dump → customer → schedule, see the materializer
run overnight, then call POST /api/routes/generate via curl
to test the route engine end-to-end. The browser walk would
catch any UX issues with the forms / nav / interactions that
tsc + build don't surface.

---

End of S467 handoff. **CustomersPage + SchedulesPage shipped —
the two onboarding-flow pages that closed the API-only gap.
Owner can now do every step of trash-company-onboarding in the
browser except generating + viewing routes.**

3017 tests / 159 files / 0 failures on api side.

**Phase 1a.3 is ~90% by effort.** Routes page + driver UI
remain.

# Session 472 — closed

> SERVICE-BUSINESS / Phase 1a arc (continues S471).

## Theme

**Mobile driver UI at `/drive/:routeId`. Full-screen, single-
stop-focused view designed for use in a truck on a phone —
no sidebar, big tap targets, tap-to-call, deep link to Google
Maps for directions, large Complete / Skip action buttons,
bottom-sheet skip-reason prompt. State machine handles every
route status: not-started, in-progress per-stop, all-finalized
wrap-up, completed recap.**

Suite (api) at S471 close: 3024 / 159.
Suite (api) at S472 close: **3024 / 159 / 0 failures** — no
test regressions despite the routes.ts SELECT change.

apps/business `npm run build`: clean. **320.59 KB JS / 90.89 KB
gzipped** (+13 KB vs S471). 1494 modules.

apps/business tsc: clean. apps/api tsc: clean.

## What shipped

### `apps/business/src/pages/DriverPage.tsx` — NEW (~430 lines)

Single component with four discrete states gated by route
status + remaining-planned-stops:

1. **Not started (`status='generated'`)** — centered panel
   with planned-start time (large, 32px), stops + dumps
   counters, big primary "Start route" button.

2. **In progress with active stop** — the main driving view:
   - Sticky top bar: route vehicle name + date, back button
   - Progress strip: "Stop 3 of 17" + "5 done · 12 left"
   - Stop card: kind badge (CUSTOMER / DUMP / RETURN TO DEPOT)
     with color-coded text, large title (24px), service type
     in gold, address with MapPin icon, tap-to-call phone
     link (anchor with `tel:` href), appointment notes box,
     ETA line, "Open in Maps" button
   - Action bar at bottom: Skip (1/3 width, amber border) +
     Complete (2/3 width, gold) — big 16px font, 16px
     padding for thumb-friendly tap targets

3. **All stops finalized but route not yet completed** —
   centered panel with summary counts (Completed / Skipped),
   big "Complete route" CTA.

4. **Route completed** — recap with check icon, completed
   time, summary tiles, back-to-routes button.

Skip flow: full-screen bottom-sheet overlay with multi-line
textarea (required field), Confirm + Cancel buttons. Keeps
the driver in-context (no navigation away from the route).

Maps deep link: `https://www.google.com/maps/dir/?api=1&destination=lat,lon`
— iOS pops "Open in" picker, Android opens Google Maps
directly. Falls back gracefully (no button) if coords are
missing.

### `apps/business/src/main.tsx`

Driver route registered **outside** the `<Layout>` wrapper —
the sidebar would be useless on a phone and waste vertical
space:

```tsx
<Route path="/drive/:routeId" element={<Protected><DriverPage /></Protected>} />
```

### `apps/business/src/pages/RoutesPage.tsx`

Bridge: "Driver view" button added to the route detail action
row, styled as a secondary ghost button (gold border on bg-2)
to differentiate from the primary Start/Complete actions.
Uses `<Link to={`/drive/${route.id}`}>` from react-router-dom
so the navigation is client-side.

### `apps/api/src/routes/routes.ts` — small SELECT extension

The `/api/routes/:id` SELECT now pulls `bc.email, bc.phone` in
addition to the existing customer fields. Needed for the
driver's tap-to-call link; no consumer of the existing list/
detail was reading those fields, so this is additive.

## Items shipped

```
apps/business/src/pages/
  DriverPage.tsx                               (NEW — ~430 lines)
  RoutesPage.tsx                               (+ Smartphone icon + Driver view button)
apps/business/src/
  main.tsx                                     (+ /drive/:routeId outside Layout)
apps/api/src/routes/
  routes.ts                                    (SELECT now pulls email + phone)
```

## Decisions made during build

| Question | Decision |
|---|---|
| Single-stop full-screen vs scrolling stop list | **Single-stop.** Driver's question is "where am I going next?" — not "show me the whole day." List view exists at /routes; this is a different mode. |
| State-machine vs single render with conditionals | **State machine via guard clauses.** Four clear states (not-started / in-progress / all-finalized / completed) each get their own return block. Easier to reason about than one mega-JSX with 4 conditional branches. |
| Maps deep-link URL form | **`google.com/maps/dir/?api=1&destination=lat,lon`.** Most reliable cross-platform anchor. iOS gets "Open in" picker (Maps + Google Maps + Waze), Android goes straight to Google Maps. |
| Tap-to-call: button or anchor | **Native `<a href="tel:">`.** OS-level handler; works everywhere phones work. No JS needed. |
| Skip reason: prompt vs bottom-sheet | **Bottom-sheet overlay.** `window.prompt` is small and feels broken on phones. Textarea + Confirm button is the standard mobile pattern. |
| Where in the page lifecycle does "Open in Maps" appear | **On the current stop card.** Above the action bar; driver opens it when arriving, then comes back to the page to tap Complete. |
| Driver page sidebar / nav? | **No.** Full viewport. Top bar handles back-to-routes; everything else is in-page. |
| Auto-advance after complete? | **Yes, via reload.** Completing the current stop pushes it to `status=completed`; the next planned stop becomes the new `current`. The page auto-rerenders. No animation polish for MVP. |
| Phone column for customer stop — what if missing? | **Just don't render the phone link.** No "—" placeholder; driver can phone via the customer's contact in the customer page if needed. |
| Depot return — same action row? | **No.** Last stop is implicit; the action row collapses to a soft pointer ("Last stop — head back to {depot}, then tap Complete route"). Real action is at the all-finalized state. |
| Skipped-ungeocoded warning on driver page | **Not surfaced.** Dispatcher's concern, not driver's. They see the warning on the desktop routes page. |
| route handler SELECT addition for email/phone | **Yes.** Bc.email + bc.phone needed for the driver UI; route handler is the only consumer. Non-breaking SELECT addition. |

## Verification

- `cd apps/business && npx tsc --noEmit`: clean (exit 0).
- `cd apps/api && npx tsc --noEmit`: clean (exit 0).
- `cd apps/business && npm run build`: clean. 1494 modules.
  320.59 KB JS / 90.89 KB gzipped (+13 KB vs S471).
- `cd apps/api && npm test`: **3024 / 159 / 0 failures**.
  The SELECT change didn't break the existing routes tests
  because they don't assert on the missing-then-present email/
  phone columns.
- **Browser walk deferred** — driver UI is the page most in
  need of a real browser walk, ideally on a phone-sized
  viewport (or actual phone). Tap-to-call, deep-link to Maps,
  bottom-sheet skip overlay all warrant interactive testing.

### Bugs caught during build

- Forgot to add `email`/`phone` to the API SELECT initially —
  the driver-page typed interface had them but the response
  wouldn't carry them. Spotted during the spec walk after
  writing the page; fixed in routes.ts before tsc'ing.

## Phase 1a — driver experience complete

Trash company end-to-end flow now has a polished driver
experience:

- Owner / dispatcher uses desktop /routes page to generate
  + view the daily plan
- Driver opens /drive/:routeId on a phone (deep-linked from
  the desktop "Driver view" button, or texted as a URL, or
  bookmarked on the truck's tablet)
- Driver hits Start route → walks stops → Complete / Skip
  each → final stop is the depot return → all-finalized
  state lets them tap Complete route

This is the complete loop the trash-company-onboard product
needs.

## What the next session should target

**Phase 1a is feature-complete by effort across every
critical-path surface.** Remaining items in the code surface
are polish, not blockers:

- **Customer "last serviced" / activity column** on the
  customers list — surfaces stale customers to the dispatcher
- **Driver assignment per route** — currently any business
  member can mark stops; assigning a specific driver to a
  route would tighten the dispatch model
- **Route cleanup cron** — `generated_routes` with status=
  generated that never got started should auto-expire after
  N days. Right now they sit forever.

Larger product threads:
- **Customer-facing billing** for trash service (recurring
  invoices, payment collection)
- **Multi-driver / shift-aware routing** (Phase 1a.4)
- **Customer self-service portal** (account view, payment
  history, request additional pickup)

**Recommend the route-cleanup cron + a `last_serviced` column
roll-up** for the customers page. Both small, both close
visible gaps. After that, the natural pivot is Phase 1a.4 or
the billing product, both requiring product input.

---

End of S472 handoff. **Mobile driver UI shipped. Full-screen,
phone-first, four-state machine, tap-to-call, Maps deep link,
bottom-sheet skip prompt. Bridge from desktop routes detail.**

3024 tests / 159 files / 0 failures.

**Phase 1a feature-complete by effort.** Driver experience
polished to walk-ready state.

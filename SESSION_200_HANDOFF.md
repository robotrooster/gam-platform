# Session 200 — closed

## Theme

B3 SchedulePage tile badge — companion to S191's BookingsPage
table surface. Closes the booking-acknowledgment thread on the
calendar view: when a booking on an ack-required property hasn't
been acknowledged yet, the calendar tile gets a small amber
indicator dot.

Also a minor cleanup: stale comment in `services/connectPayouts.ts`
that said the Stripe Connect rebuild was unfinished — phase 4
(autoPayouts) and phase 5 (withdrawals) are both shipped and
using `firePayoutForConnectAccount`. Comment now reflects reality.

## What S200 shipped

### Backend — `units.ts` schedule master query

`GET /api/units/schedule/master` bookings SELECT now pulls
`p.requires_booking_acknowledgment` so the frontend tile can
decide whether to render the ack-pending indicator. (Booking row
already includes `b.acknowledgment_signed_at` via `b.*`.)

### Frontend — `SchedulePage` tile badge

`apps/landlord/src/pages/SchedulePage.tsx` booking-tile render:

- New `needsAck` predicate — booking is on an ack-required
  property, not yet acknowledged, and on an active status (not
  cancelled / checked_out / no_show).
- Tile gets a 1px amber border when `needsAck`.
- Small amber circle (8px diameter) overlays the tile's top-right
  corner on the start cell when `needsAck`.
- Title attribute extends to "— Property-rules acknowledgment
  pending" so hovering reveals the reason.
- Legend gains an entry: amber dot = "Ack pending".

The dot is rendered only on the start cell of a multi-day booking
to avoid visual clutter (the whole-block border still flags the
booking on every cell).

### Cleanup — `services/connectPayouts.ts` doc-comment

Header said "Replaces (in Phase 4 + Phase 5)" + "no callers swap
over yet" — both stale. Updated to reflect that
`jobs/autoPayouts.ts` and `routes/withdrawals.ts` are live
consumers now.

### Files touched (S200)

```
apps/api/src/routes/units.ts                                            (schedule master bookings SELECT pulls requires_booking_acknowledgment)
apps/api/src/services/connectPayouts.ts                                 (doc-comment cleanup — phases 4 + 5 are shipped)
apps/landlord/src/pages/SchedulePage.tsx                                (tile needsAck predicate + border + corner dot + title; legend entry for "Ack pending")
```

### Verification

- `cd apps/api && npx tsc --noEmit` → 0
- `cd apps/landlord && npx tsc --noEmit` → 0
- No schema migrations
- No tenant changes (tenant doesn't see the schedule)

## Decisions made (S200)

| Question | Decision |
|---|---|
| Render the amber dot on every cell of a multi-day booking, or only the start cell? | Start cell only. The cells are 24px tall — a dot on each cell is visual clutter. The block border (the 1px amber edge on every cell) already flags the booking universally. The dot is a focused indicator on the readable end. |
| Use the same hide-when-closed predicate as BookingsPage (status NOT IN cancelled/checked_out/no_show)? | Yes. Same product semantic — no point chasing acks on closed bookings. Predicate copied from S191's `needsAck` shape. |
| Legend entry vs invisible-but-tooltip? | Legend entry. Schedule already has a legend strip with "Today" etc.; adding the ack indicator there costs ~10 chars and pays back in user discoverability. |
| Recon-only: any other lingering Stripe Connect gaps? | None substantive. Phase 4 (autoPayouts) + Phase 5 (withdrawals) shipped, webhook handlers shipped (S117), embedded onboarding shipped on landlord + pm-company portals. Updated stale comment as cleanup. The Stripe rebuild is genuinely done. |

## Carry-forward

### Booking-acknowledgment thread (B3) — fully closed
- Backend toggle (S179) ✓
- BookingsPage badge + filter banner + Ack column with action buttons (S191) ✓
- SchedulePage tile badge (S200) ✓

The remaining B3 carry-forward item — "hard-gate check-in on
acknowledgment" — is a product fork (does GAM refuse the
status='checked_in' transition until staff acknowledges?)
explicitly flagged in S191 as needing Nic's call.

### Substantial pending

- **B1+B2 material-change workflow** — addendum generator + late-fee edit confirm + new-lease trigger for material changes. Per CLAUDE.md S177, locked direction. Multi-session.
- **C1 50-state tax form catalog** — multi-session per-state research + build.
- **Sublease phase 3** — sub-tenant billing wire-up + sublessee invite-by-email. Multi-session.

### Smaller pending

- A3 thread continuations:
  - `properties.deposit_interest_rate_annual` columns audit/drop (S193 discovery — needs Nic input on whether higher-than-statute landlord opt-in is a future product)
  - Expand state catalog (mostly diminishing returns — most non-fixed states are variable-rate which is already supported via S190 overrides)
  - Annual rate refresh discipline doc (15-min CLAUDE.md addendum)
- Primary manager urgency tier (S185 question — needs Nic)
- Owner-financial-escalation pattern (S186 question — needs Nic)
- Other POS tables for property scoping (S192 carry — incremental)
- B3 hard-gate check-in (product fork)

### Genuinely blocked
- D2 Flex tenant suite (launch-flag gated)
- CSV imports (need vendor format specs)
- E2 npm upgrades (risky breaking changes)
- F1 Marketing rebuild (positioning paragraph)
- POS Terminal hardware (need physical hardware)

---

End of S200 handoff.

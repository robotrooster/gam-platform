# Session 179 — closed

## Theme

Two clean-scope items from the S177 product walkthrough that
needed no further input: A4 (cosigner tombstone confirmation)
and B3 (per-property booking acknowledgment toggle, schema +
backend + landlord toggle UI). Surface UI badging on bookings
is the deferred piece — needs Nic input on layout/copy and is
flagged for a future session.

## What S179 shipped

### A4 — cosigner tombstone confirmation

S177 grep returned zero refs; S179 sweep across all
`*.ts`/`*.tsx`/`*.sql` files (excluding handoffs/DEFERRED/CLAUDE
docs that retain the historical record) confirmed the same:
zero `guarantor` / `cosigner` / `co_signer` / `co-signer` refs
in the codebase or schema. A4 is a confirmed no-op — nothing
to rip. The DEFERRED tombstone from S177 is sufficient.

### B3 — booking acknowledgment toggle

**Schema** — new migration
`20260507120000_booking_acknowledgment.sql`:

- `properties.requires_booking_acknowledgment boolean NOT NULL DEFAULT false`
- `unit_bookings.acknowledgment_signed_at timestamp with time zone` (nullable)

No backfill needed; defaults align with current behavior. Schema
comments document intent.

**Backend wiring**:

- `POST /api/properties` zod schema accepts
  `requires_booking_acknowledgment: z.boolean().optional()`;
  INSERT carries it through (defaults to false when omitted).
- `PATCH /api/properties/:id` accepts the toggle for live edits;
  `COALESCE(.., requires_booking_acknowledgment)` preserves
  existing semantics when other fields change.
- New `PATCH /api/units/:id/bookings/:bookingId/acknowledge`
  endpoint stamps `acknowledgment_signed_at = NOW()`. Idempotent
  (re-acknowledging is a no-op so a double-click on the staff
  UI doesn't bounce). Auth via existing `requirePerm('guests.check_in', 'units.edit')`
  + `canManageLandlordResource` posture matching the rest of the
  bookings router.

**Landlord UI** — `PropertiesPage.tsx` AddEditModal:

- New "Booking policy" section between the Amenities block and
  the "Who pays each fee?" allocation-rule section. Single
  checkbox + descriptive copy explaining when to flip on (RV
  parks / short-stay where house rules need explicit guest
  sign-off).
- Toggle renders in BOTH create and edit modes (matches the S172
  fee_payer toggle posture). Form state pre-fills from
  `property.requiresBookingAcknowledgment` on edit.
- Form payload picks up the field automatically via `...form`
  spread; backend POST/PATCH already wired to consume it.

### What was deliberately left for a follow-on session

- **Surface UI badging on the schedule / bookings views.** Today
  the column on `unit_bookings` records the acknowledgment state
  but no view surfaces "Pending acknowledgment" badges or a
  "Mark acknowledged" button. The data shape is ready; layout/
  copy decisions need Nic input (where on SchedulePage / unit
  detail / mobile view, what colors/icons, how it interacts
  with check-in flow).

### Files touched (S179)

```
apps/api/src/db/migrations/20260507120000_booking_acknowledgment.sql    NEW
apps/api/src/db/schema.sql                                              regenerated
apps/api/src/routes/properties.ts                                       (POST + PATCH accept requires_booking_acknowledgment)
apps/api/src/routes/units.ts                                            (+ PATCH /units/:id/bookings/:bookingId/acknowledge)
apps/landlord/src/pages/PropertiesPage.tsx                              (+ Booking policy toggle in AddEditModal)
DEFERRED.md                                                             (S177 already tombstoned cosigner; A4 confirms no-op)
```

### Verification

- `cd apps/api && npx tsc --noEmit` exit 0
- `cd apps/landlord && npx tsc --noEmit` exit 0
- `cd apps/tenant && npx tsc --noEmit` exit 0
- Migration applied via `npm run --workspace apps/api migrate`;
  `schema.sql` regenerated to reflect new columns.

## Decisions made (S179)

| Question | Decision |
|---|---|
| Per-property toggle or per-unit-type toggle? | Per-property. Matches Nic's S177 framing ("landlord toggle on/off per property"). Per-unit-type would split the same property into ack-required and not-required units, which is more complex than the use case warrants. |
| Tie acknowledgment state to `unit_bookings.status` enum or its own column? | Own column (`acknowledgment_signed_at`). Avoids extending the status CHECK constraint with a new value (`pending_acknowledgment`), which would ripple through every consumer of `bookings.status`. The boolean read on `acknowledgment_signed_at IS NULL` is just as expressive as a status enum value and doesn't disturb existing consumers. |
| Auto-create the acknowledgment doc on booking creation, or stamp on demand? | Stamp on demand. The doc generation flow needs an e-sign template + Nic on what's in the document — that's its own session. The minimum viable loop is "staff collects signature on paper, clicks Mark acknowledged, system records timestamp." Future enhancement: real e-sign via signing-flow service. |
| Surface UI on bookings view this session? | No, deferred. Layout/copy for "Pending acknowledgment" indicators on SchedulePage / unit detail / etc. needs Nic input. The data shape is ready; surfacing is a follow-on. |

## Carry-forward — what S180+ should target

Per S177 product queue. Recommend (sized + sequenced):

1. **A1+A2** — depositReturn move-out balance sweep + admin
   "Bill X fee" button. Decisions locked, real launch impact.
   Single themed session.
2. **B3 surface UI** (when Nic provides layout direction) —
   "Pending acknowledgment" indicators + "Mark acknowledged"
   button on the schedule/bookings views. Half-session.
3. **A3** — state-hardcoded deposit interest. Needs state-by-
   state rate data sourced from somewhere reliable; Nic to
   confirm where to pull from (HUD database? state attorney
   general office sites? legal counsel?). Build once data is
   in hand: schema + per-state seed migration + monthly accrual
   job + landlord deposit-summary surface.
4. **B1+B2 coupled** — material-change new-lease workflow +
   late-fee edit confirm modal + addendum generator. Needs
   Nic on what addendum doc looks like, default notice period
   per change type, etc.
5. **C1** — 50-state property-state form catalog. Schema +
   seed data + UI. Needs sourced form data per state (per-state
   research; ~2 sessions).
6. **D2** — Flex tenant suite + OTP landlord-side + launch-
   hide flag (~3-5 sessions).
7. **Sublease subsystem.**
8. **POS multi-terminal sync + Stripe Terminal + EOD.**
9. **CSV imports for 8 competitors.**
10. **E2** — 4 npm upgrades.
11. **F1** — Marketing rebuild (after Nic's positioning paragraph).

---

End of S179 handoff.

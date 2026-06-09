# Session 263 — closed (POS multi-terminal session sync, Session 1)

## Theme

POS cart moves from client-side `useState` to server-of-record state.
First session of the multi-terminal-sync build per S259 "build it"
mandate. Unlocks three use cases simultaneously: cross-terminal tab
pickup, crash recovery / browser refresh, and single-counter shops
where one staff member's cart persists across logouts. Foundation
for Session 2 (offline tolerance) and Session 3 (SSE realtime push).

## Scope-shaping confirmed pre-build

| Q | Locked direction |
|---|---|
| Q1 — user story | (a) Cross-terminal tab, (c) crash recovery, (e) offline-tolerant, (f) single-counter shops (cart persistence across staff sessions). All four covered by a server-of-record session model. |
| Q2 — property scope | Single-property only. Per-property scoping at `pos_sessions.property_id` matches the post-S241 per-property pos_items model. |
| Q3 — volume | 2 terminals max per property; in-person sequential (one cart at a time per terminal); online carts can hit 20+ but are future surface. Low contention → optimistic last-write-wins. No version stamps in v1. |

## Items shipped

### Migration — `20260513120000_pos_sessions.sql`

Two new tables:

- `pos_sessions` — server-of-record cart state. Columns: `id`,
  `property_id`, `landlord_id`, `opened_by_user_id`, `pos_customer_id`
  (nullable), `tenant_id` (nullable, XOR with pos_customer_id),
  `status` ('open' / 'completed' / 'voided'), computed totals
  (`subtotal`, `tax_amount`, `discount_amount`, `total`), `notes`,
  `opened_at`, `closed_at`, `completed_transaction_id` (FK to
  `pos_transactions.id` once /checkout fires), `void_reason`. FKs to
  properties, landlords, users, pos_customers, tenants, pos_transactions.
  Two indexes: partial `(property_id, opened_at DESC) WHERE status='open'`
  for the cross-terminal tab query, plus
  `(landlord_id, status, opened_at DESC)` for history reads.

- `pos_session_items` — line items on an open session. Shape mirrors
  `pos_transaction_items` (item_id, item_variant_id, item_name,
  item_category, qty, unit_price, cost_price, tax_rate,
  discount_amount, subtotal, notes) so checkout can copy them across
  cleanly. CASCADE on session delete; FKs to pos_items + pos_item_variants.

### Backend — `apps/api/src/routes/pos.ts`

Added at end of router (~250 lines net):

- `GET /pos/sessions?status=open[&property_id=...]` — list open sessions
  scoped to landlord + optional property. Joins customer name +
  property name + item count for the tab-picker UI.
- `POST /pos/sessions` — open a session. Body: `property_id`,
  `pos_customer_id?`, `tenant_id?`, `notes?`. Verifies the property
  belongs to the calling landlord.
- `GET /pos/sessions/:id` — full session + items.
- `PATCH /pos/sessions/:id` — update customer / discount / notes; only
  valid while `status='open'`. Triggers totals recompute.
- `POST /pos/sessions/:id/items` — add a line. Required fields
  validated; `subtotal` computed from `qty * unit_price`. Triggers
  totals recompute.
- `PATCH /pos/sessions/:id/items/:itemId` — update qty / unit_price /
  notes. Refreshes line subtotal then totals.
- `DELETE /pos/sessions/:id/items/:itemId` — remove a line.
- `POST /pos/sessions/:id/void` — mark voided with optional reason;
  closes `closed_at`. Only fires when `status='open'`.
- `POST /pos/sessions/:id/complete` — internal helper called by the
  frontend after a successful `POST /pos/transactions`. Verifies the
  transaction belongs to the calling landlord; links
  `completed_transaction_id`; flips `status='completed'`. Idempotent —
  if already completed for the same transaction id, returns success.

All routes guarded by `requirePerm('pos.ring_sale')`.

`recomputeSessionTotals(sessionId)` helper — single UPDATE that
re-derives subtotal + tax_amount from `pos_session_items` and applies
the discount to produce `total`. Called after every line / discount
mutation.

### Frontend — `apps/pos/src/pages/POSPage.tsx`

New state:
- `sessionId: string|null` — the live server session id; lazy-opened
  on first cart action.
- `openTabBanner` — surfaces when there's an unclosed session on the
  current register property and the local cart is empty.

New `useQuery` `['pos-sessions-open', registerProperty]` fetches open
sessions when register tab is active + a property is selected. A
`useEffect` populates `openTabBanner` when sessions exist and no live
session is bound.

New helpers:
- `ensureSession()` — lazy POST `/pos/sessions` on first cart action.
  Stamps `tenant_id` / `pos_customer_id` from the active charge-customer
  selection so FlexCharge sessions are property+customer-scoped from
  birth.
- `resumeSession(id)` — GET `/pos/sessions/:id`, rebuilds local cart
  from `pos_session_items`, sets `sessionId`. Each restored item
  carries a hidden `_sessionItemId` field so subsequent qty edits hit
  the right server row.
- `discardOpenTab(id)` — voids the session, invalidates the open-tabs
  query.

Cart-mutation wrappers (all async now):
- `addToCart(item)` — ensures session, POSTs `/pos/sessions/:id/items`,
  capture the server row id into `_sessionItemId`, then updates local
  state. Existing dup-item-merging logic preserved (still adds qty+1
  in the local cart; doesn't dedupe on the server side in v1 — each
  click writes a new server row when no existing item match exists).
- `addOpenItem()` — same pattern for walk-up items (no `item_id`).
- `updateQty(id, delta)` — PATCH `/pos/sessions/:id/items/:itemId`
  when delta resolves to qty > 0; DELETE when qty hits 0.

Checkout integration:
- After `apiPost('/pos/transactions', ...)` returns, post-success
  handler calls `/pos/sessions/:sessionId/complete` with the new
  `transaction_id` to atomically link + close the session.
- Clears `sessionId` along with cart on receipt.
- Invalidates `['pos-sessions-open', registerProperty]` so the next
  page load sees a clean state.

Clear button → voids the live session before clearing local state.

Open-tab banner JSX rendered inside the register tab, above the
category filter row, only when `cart.length === 0` AND
`openTabBanner !== null`. Shows item count + total + opened-at time +
Resume / Discard buttons.

## Decisions made during build

| Question | Decision |
|---|---|
| Where does the session-checkout link live? | **Two-call pattern from frontend.** Frontend POSTs to existing `/pos/transactions` (unchanged), then POSTs `/pos/sessions/:id/complete` with the returned tx id. Alternative was adding `sessionId` to the transactions POST body and linking in one shot — rejected to minimize churn in the transactions route (it's already 250+ lines with FlexCharge / Stripe Terminal validation). Two-call is best-effort idempotent: the session/complete endpoint accepts re-runs. |
| Open-tab UX — auto-resume or banner? | **Banner with Resume / Discard.** Auto-resume is jarring (user goes to POS, sees a half-finished cart from earlier). Banner gives the operator visibility + control. When the property has 2+ open tabs (rare in single-terminal mode), the banner shows the most recent; full tab-picker UX deferred to Session 2 along with the volume scenarios that justify it. |
| Server item dedup on add? | **No.** Each click of an item tile in the catalog adds a new server row (or, in the local cart, increments qty on the matching item id). Decoupling these is acceptable in v1 — server rows are append-only-from-the-cashier's-POV, totals recompute correctly. Could add server-side merge later if line clutter on resume becomes annoying. |
| Concurrency control — last-write-wins or version stamps? | **Last-write-wins.** 2-terminal max + sequential in-person carts (per Q3) → contention is effectively zero. Adding version stamps to v1 would require a 409-retry-loop on the frontend for a scenario that doesn't materialize. Session 2 or 3 can add stamps if online-cart volume (20+ simultaneous future) drives real conflict. |
| Permission gating | All session routes guarded by `requirePerm('pos.ring_sale')` — same as transactions. No new permission introduced. Voided sessions stay visible in the audit trail; the role that can ring sales is the role that owns the cart. |
| Idempotency of `/complete` | **Yes.** Frontend can retry after a flaky network without producing a duplicate completion. Returns the existing row when called twice with the same transaction_id. Returns 409 if called against a session that's already completed against a DIFFERENT transaction (likely a programming bug, not a network retry). |

## Files touched (S263)

```
apps/api/src/db/migrations/
  20260513120000_pos_sessions.sql                     (new — ~95 lines)
apps/api/src/db/schema.sql                            (regenerated)
apps/api/src/routes/pos.ts                            (~ new sessions block
                                                       at end of router;
                                                       8 endpoints +
                                                       recomputeSessionTotals
                                                       helper; ~+250)
apps/pos/src/pages/POSPage.tsx                        (~ sessionId state +
                                                       open-tab banner +
                                                       ensureSession /
                                                       resumeSession /
                                                       discardOpenTab;
                                                       addToCart, addOpenItem,
                                                       updateQty rewired
                                                       async; checkout
                                                       post-success links
                                                       session via /complete;
                                                       Clear button voids;
                                                       ~+150)
DEFERRED.md                                           (~ POS multi-terminal
                                                       Session 1 tombstoned;
                                                       Session 2 + 3 markers
                                                       added)
SESSION_263_HANDOFF.md                                (this file)
```

## Verification

- `npm run db:migrate` → 1 applied; schema.sql regenerated to 11641 lines
- `psql gam -c "\d pos_sessions"` → all columns + FKs + CHECK + indexes present
- `cd apps/api && npx tsc --noEmit` → clean
- `cd apps/pos && npx tsc --noEmit` → clean

## Carry-forward — S264+

### POS multi-terminal sync — Session 2 (offline tolerance)

When a terminal loses internet mid-cart, the current build silently
fails server writes (console.error only) and the local cart drifts
from server. Session 2 scope:
- IndexedDB cache holding the pending mutation queue (add / qty /
  delete / patch).
- ConnectionStatus indicator in the POS chrome.
- On reconnect: drain the queue serially; conflict resolution =
  server-wins (the queued local mutations re-apply only when their
  server row still exists in 'open' state).
- Backoff + UI for staff to clear stuck queue if needed.

### POS multi-terminal sync — Session 3 (SSE realtime push)

Polling-based sync (current architecture, via tab-list refresh on
page load) is adequate at 2-terminal max per property. When online
carts (20+ simultaneous customer-side sessions) ship, SSE push will
keep all viewers of "Open tabs" live. Scope:
- Server-side `SSE /pos/sessions/stream?property_id=...` endpoint
  pushing session-mutation events.
- Frontend hooks into the stream and patches react-query cache.
- Heartbeat + reconnect + auto-cleanup of stale streams.

### Vendor-blocked (unchanged)

- Checkr Partner credentials pending
- FlexCredit (CredHub + Esusu) pending

## Revised count

| Bucket | Pre-S263 | Post-S263 |
|---|---|---|
| POS multi-terminal sync — schema + REST + cart wiring | needs scope-shaping | **Session 1 shipped** |
| POS multi-terminal sync — offline tolerance | open | Session 2 remaining |
| POS multi-terminal sync — SSE realtime | open | Session 3 remaining |
| FlexDeposit legal-remedy 3-arc | complete | complete (S260-S262) |
| Vendor-blocked | 2 | 2 |

---

End of S263 handoff.

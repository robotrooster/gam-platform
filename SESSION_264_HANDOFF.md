# Session 264 — closed (POS multi-terminal session sync, Session 2)

## Theme

POS terminals now survive offline mid-sale. Cart mutations no longer
hit the server synchronously — they flow through a new IndexedDB-
backed FIFO queue that drains FIFO when the browser is online.
Capped exponential backoff handles 5xx + network errors; 4xx are
server-wins and discarded. SyncStatusBadge in the page header shows
online/offline/N pending with Force-sync + Discard-queue actions.

Building on S263's server-of-record session model. Session 3 (SSE
realtime push) stays deferred; polling-on-tab-refresh remains the
cross-terminal visibility model at 2-terminal-max scale.

## Items shipped

### New module — `apps/pos/src/lib/syncQueue.ts`

IndexedDB database `gam_pos_offline_v1` with two object stores:
- `queue` — pending mutation rows keyed by uuid, indexed on
  `queuedAt`. Each row: `{ id, op, clientSessionId, clientItemId?,
  payload, queuedAt, attempts, nextAttemptAt, lastError? }`.
- `id_mappings` — `clientId → serverId` resolutions persisted so a
  page reload mid-drain doesn't orphan in-flight resolutions.

Seven operations covered:
| Op | Server endpoint |
|---|---|
| `OPEN_SESSION` | `POST /pos/sessions` |
| `ADD_ITEM` | `POST /pos/sessions/:id/items` |
| `PATCH_ITEM` | `PATCH /pos/sessions/:id/items/:itemId` |
| `DELETE_ITEM` | `DELETE /pos/sessions/:id/items/:itemId` |
| `PATCH_SESSION` | `PATCH /pos/sessions/:id` |
| `VOID_SESSION` | `POST /pos/sessions/:id/void` |
| `COMPLETE_SESSION` | `POST /pos/sessions/:id/complete` |

Public API:
- `enqueue({ op, clientSessionId, clientItemId?, payload })` — write
  to IndexedDB and trigger drain.
- `subscribe(listener)` — `{ online, pendingCount, syncing, lastError }`
  pushed to React component for header indicator.
- `drain()` — manual trigger (Force-sync button).
- `clearAll()` — wipes queue + mappings (with confirm at the UI).
- `preloadMapping(clientId, serverId)` — used by Resume-tab flow
  when the server id is already known.
- `mintClientId()` — fresh uuid generator (uses `crypto.randomUUID`
  when available, fallback otherwise).
- `resolveServerId(clientId)` — exposed for callers that need to look
  up resolved ids directly.

Drain worker:
- Reads all queued rows, filters by `nextAttemptAt <= now`, sorts by
  `queuedAt`, fires the oldest. FIFO + serialized — guarantees that
  `OPEN_SESSION` resolves before any downstream `ADD_ITEM` for the
  same client session.
- Success → row deleted.
- 4xx → discarded (session already voided / completed by another
  terminal; server-wins). Console-logged at `warn`.
- 5xx + network/timeout → re-enqueued with attempts++ and
  `nextAttemptAt = now + BACKOFF[min(attempts, 3)]`. Backoff schedule:
  5s, 30s, 2min, 10min.
- After each drain pass, schedules a `setTimeout` for the soonest
  next eligible attempt so the worker wakes itself.
- Browser `online` event triggers immediate drain; `offline` event
  pauses (drain short-circuits when `navigator.onLine === false`).
- Initial drain on module load recovers any rows from a prior page
  life.

### Frontend — `apps/pos/src/pages/POSPage.tsx`

- `sessionId` state renamed `clientSessionId` (the local uuid;
  server id resolves async via the queue mapping).
- `syncStatus` state subscribed via `subscribeSync` — drives the
  header badge.
- Cart helpers rewired:
  - `ensureSession()` → `mintClientId()` + `enqueueSync({ op:
    'OPEN_SESSION', ... })`. No await on the network call.
  - `addToCart` / `addOpenItem` → mint a `clientItemId`, enqueue
    `ADD_ITEM`, optimistically update local cart with `_sessionItemId
    = clientItemId`.
  - `updateQty` → enqueue `PATCH_ITEM` (qty > 0) or `DELETE_ITEM` (qty
    = 0).
  - Clear button → enqueue `VOID_SESSION`, reset local state.
  - Checkout success (`/pos/transactions` returns) → enqueue
    `COMPLETE_SESSION` with `transaction_id`. The /pos/transactions
    POST itself stays synchronous — it needs network for Stripe
    anyway, and the tx id only exists once it returns.
- `resumeSession(id)` pre-maps server ids → self via `preloadMapping`
  so the queue resolves restored items immediately.
- `SyncStatusBadge` component rendered next to the page title:
  - Online + 0 pending → muted "Synced" badge.
  - Online + N pending → amber "Syncing N…" / "N pending".
  - Offline → red "Offline · N pending".
  - Click opens a popover with "Force sync now" + "Discard N unsent
    change(s)" actions (both confirm-then-fire).

### Behavior contract

- All cart actions are **fire-and-forget** at the UI layer. Local
  state updates immediately; server sync happens in the background.
- Cashier can ring sales offline — items added, qty changed, lines
  removed — all queued. The POST `/pos/transactions` checkout call
  itself still requires network (Stripe / card-present needs it),
  but cart prep doesn't.
- Reconnect drain is FIFO. Operations referencing items whose parent
  `OPEN_SESSION` hasn't drained yet self-pause via the
  `*_not_resolved_yet` return path, ensuring nothing tries to PATCH
  an unrealized session/item.
- 4xx (e.g., session was voided by another path mid-drain) drops
  the mutation; local cart UI doesn't roll back, but the user can
  re-add if needed. Acceptable for v1.

## Decisions made during build

| Question | Decision |
|---|---|
| Queue ops scope — include the synchronous-required ops (OPEN_SESSION, COMPLETE_SESSION) or only the cart-editing ones? | **All session-lifecycle ops.** Putting OPEN_SESSION through the queue means the cart can start being built before the server confirms; COMPLETE_SESSION through the queue means a flaky network at checkout doesn't leave the session 'open' (the session/complete endpoint is already idempotent so re-fires are safe). Only the actual charge call (POST /pos/transactions) stays synchronous because the tx id only exists once it returns. |
| Conflict resolution on 4xx | **Drop with log.** Server-wins per Session 1's locked semantic. UI doesn't roll back local state — cashier can re-add an item if needed; the cart didn't actually lose anything visible to them. Logging is enough for forensics. |
| Backoff schedule | **5s, 30s, 2min, 10min** (capped at 10min). First retry is fast enough to recover from a 5-second wifi blip; the longer rungs handle sustained outages without burning CPU. |
| Force-sync UI affordance | **Click-popover from the status badge** with Force-sync + Discard-queue. Both behind a confirm. Discard wipes both the queue and the id_mappings store (so a stale unsent session can't accidentally re-resolve when the user starts fresh). |
| Online detection | `navigator.onLine` + `window.addEventListener('online'/'offline')`. Browser-native, no polling. The `online` event sometimes fires falsely (network came up but DNS isn't ready) — that just means the first drain attempt errors out and retries via backoff. Acceptable. |
| Should ADD_ITEM merge dup-tap clicks? | **No — each tap creates a fresh server row.** Local cart still merges visually (qty++ on the same item.id), but the queue fires a new ADD_ITEM per tap. Resume after a tab reopen surfaces them as separate lines. Acceptable for v1; merge logic can come later if line clutter becomes a complaint. |

## Files touched (S264)

```
apps/pos/src/lib/syncQueue.ts                         (new — ~290 lines)
apps/pos/src/pages/POSPage.tsx                        (~ sessionId →
                                                       clientSessionId,
                                                       cart helpers
                                                       enqueue instead of
                                                       apiPost,
                                                       SyncStatusBadge
                                                       component +
                                                       header mount,
                                                       syncStatus
                                                       subscription;
                                                       ~+170)
DEFERRED.md                                           (~ POS Session 2
                                                       tombstoned;
                                                       Session 3 marker
                                                       remains)
SESSION_264_HANDOFF.md                                (this file)
```

## Verification

- `cd apps/api && npx tsc --noEmit` → clean
- `cd apps/pos && npx tsc --noEmit` → clean
- No backend changes this session — Session 1 routes handled all
  the server-side surface area.
- IndexedDB behavior is browser-native; tested compile only. Smoke
  test (the actual offline behavior, including pulling the wifi
  cable mid-cart) is Nic-initiated per project rules.

## Carry-forward — S265+

### POS multi-terminal sync — Session 3 (SSE realtime push)

Deferred (still). Polling-on-tab-refresh covers the cross-terminal
pickup case at 2-terminal max. SSE becomes worthwhile when:
- Online customer-built carts (20+ simultaneous, per Q3 in S263)
  ship and operators want live tab-list updates without manual
  refresh.
- OR multi-staff cart collaboration becomes a real workflow.

Scope when it lands:
- Server-side `GET /pos/sessions/stream?property_id=...` SSE endpoint
  pushing session-mutation events (open, item-add, item-patch,
  item-delete, void, complete).
- Frontend EventSource hooks into the stream; patches react-query
  cache + reconciles local sessionItem rows.
- Heartbeat (15s) + reconnect-on-drop + auto-cleanup of stale
  streams (idle > 5min).

### Vendor-blocked (unchanged)

- Checkr Partner credentials pending
- FlexCredit (CredHub + Esusu) pending

### Possible follow-ups discovered this session

- The 4xx discard path doesn't surface to the cashier. If a session
  gets voided by another terminal mid-cart, the cashier doesn't
  notice until they hit checkout (which 409s). Could add a toast on
  `mutation_discarded` events. Low priority; rare in 2-terminal-max
  use.
- IndexedDB quota is generous on desktop browsers (multi-GB) but
  iOS Safari caps it lower. If a long-running offline scenario
  fills the quota, queue writes start failing. Worth monitoring if
  iPad-based POS ever ships.

## Revised count

| Bucket | Pre-S264 | Post-S264 |
|---|---|---|
| POS multi-terminal sync — schema + REST + cart wiring | Session 1 shipped S263 | unchanged |
| POS multi-terminal sync — offline tolerance | open | **Session 2 shipped** |
| POS multi-terminal sync — SSE realtime | open | Session 3 remaining |
| FlexDeposit legal-remedy 3-arc | complete (S260-S262) | unchanged |
| Vendor-blocked | 2 | 2 |

---

End of S264 handoff.

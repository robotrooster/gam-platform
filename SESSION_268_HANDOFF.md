# Session 268 — closed (POS sync queue tests)

## Theme

Fourth critical-path suite. Pins the S264 IndexedDB-backed POS
mutation queue end-to-end: enqueue, drain, FIFO ordering, id
resolution, 4xx-discard, 5xx-backoff, parent-not-resolved
self-pause, clearAll/preloadMapping, status subscription, offline
short-circuit.

Establishes the Vitest + jsdom + fake-indexeddb harness in
`apps/pos` — reusable for any future frontend-logic test in that
package.

No frontend walkthrough required.

## Items shipped

### New module — `apps/pos/vitest.config.ts`

- `environment: 'jsdom'` (provides `window`, `navigator`, etc.)
- `setupFiles: ['./src/test/setup.ts']` (installs fake-indexeddb)
- `pool: 'forks'` + `singleFork: true` + `fileParallelism: false`
  — syncQueue has module-level state, tests must serialize.

### New module — `apps/pos/src/test/setup.ts`

One line — imports `fake-indexeddb/auto` so `globalThis.indexedDB`
is wired before any test file imports the module under test.

### New module — `apps/pos/src/lib/syncQueue.test.ts`

15 cases. All passing.

**Happy path (5)**
| # | Case | What it pins |
|---|---|---|
| 1 | `OPEN_SESSION` round-trip | api.post called, queue row removed, clientId→serverId mapping persisted |
| 2 | FIFO `OPEN_SESSION` + `ADD_ITEM` same cycle | OPEN drains first, ADD reads its server session id |
| 3 | OPEN → ADD → PATCH chain | PATCH resolves both ids correctly |
| 4 | `VOID_SESSION` + `COMPLETE_SESSION` paths | post to `/void` and `/complete` after id resolution |
| 5 | `DELETE_ITEM` | api.delete with resolved ids |

**Errors and retries (5)**
| # | Case | What it pins |
|---|---|---|
| 6 | 4xx response | row discarded, console.warn fired, no retry |
| 7 | 5xx response | row retained, attempts=1, nextAttemptAt ≈ +5s |
| 8 | Network error (no `response`) | same retry path as 5xx |
| 9 | ADD_ITEM before OPEN_SESSION | self-pauses (`session_not_resolved_yet`), attempts++ |
| 10 | PATCH_ITEM before ADD_ITEM | self-pauses, OPEN still drains |

**Utilities + offline (5)**
| # | Case | What it pins |
|---|---|---|
| 11 | `clearAll` | wipes queue + mappings |
| 12 | `preloadMapping` | known server id resolvable, PATCH fires immediately |
| 13 | `subscribe` emits status | listener sees pendingCount + syncing transitions |
| 14 | `mintClientId` uniqueness | 50 ids in a set, no collisions |
| 15 | Offline | navigator.onLine=false → drain short-circuits, 0 api calls, row stays queued |

## Decisions made during build

| Question | Decision |
|---|---|
| How to handle module-level state across tests | **`vi.resetModules()` + fresh `IDBFactory` per test.** syncQueue holds `currentStatus`, `listeners`, `draining` at module scope. resetModules forces a clean re-import; new IDBFactory means the IndexedDB store is empty too. apiMock is a vi.mock factory closure that survives resetModules — same mock object across imports, just `.mockReset()` between tests for fresh call history. |
| Mock the `./api` axios instance, or hit a real test server | **Mock at module level.** `vi.mock('./api')` returns a `{ api: { post, patch, delete } }` object with vi.fn methods. No HTTP at all — these tests are about the queue's behavior, not the network. |
| Module-import side effect: top-level `void drain()` | **Awaited in beforeEach.** After re-import, the module fires `refreshPendingCount().then(drain)`. Tests `await waitUntilIdle()` to let that initial cycle finish before acting. Initial drain is a no-op on an empty queue, so it returns fast. |
| Test timing strategy (real vs fake timers) | **Real timers.** Drain returns after pushing the retry row to IDB with `nextAttemptAt` in the future. Tests assert on that field directly — no need to actually advance time to fire the setTimeout retry. Future tests that need to verify "retry actually fires after backoff" can opt-in to `vi.useFakeTimers()` + `advanceTimersByTime`. |
| How to flip `navigator.onLine` in jsdom | **`Object.defineProperty(navigator, 'onLine', { get: () => false })`** + dispatch the `offline` event. The window listener flips `currentStatus.online`. Restored at end of test so afterEach cleanup still drains correctly. |
| Asserting on IndexedDB row internals (e.g. attempts, nextAttemptAt) | **Open the underlying DB directly in the test.** No public getter on the queue module exposes raw row state, and adding one just for tests would bloat the API. Reading from `gam_pos_offline_v1` via the test's `indexedDB` (fake) is reasonable for verification. |

## Files touched (S268)

```
apps/pos/vitest.config.ts                (new — 14 lines)
apps/pos/src/test/setup.ts               (new — 7 lines)
apps/pos/src/lib/syncQueue.test.ts       (new — ~330 lines, 15 cases)
apps/pos/package.json                    (~ added test + test:watch
                                           scripts, vitest + jsdom +
                                           fake-indexeddb devDeps)
apps/pos/package-lock.json               (~ npm install side-effect)
DEFERRED.md                              (~ POS sync queue tombstoned)
SESSION_268_HANDOFF.md                   (this file)
```

## Verification

- `cd apps/pos && npm test` → 15/15 passing, 119ms test time, 494ms
  end-to-end.
- `cd apps/pos && npx tsc --noEmit` → clean.
- Existing apps/api suite untouched (allocation + deposit-return
  still 30/30).

## Carry-forward — S269+

Per S267 list:

1. **Rent webhook handler** — `routes/webhooks.ts`,
   `payment_intent.succeeded`. Bigger surface; needs a Stripe mock
   strategy. ~1.5–2 sessions.
2. **Lease lifecycle integration** — sign → move-in invoice →
   monthly invoice cron → late-fee on grace expiry. Fake clock +
   timezone control + multiple services. ~2 sessions.
3. **CI workflow** — `.github/workflows/ci.yml` with Postgres
   service container, runs `tsc -b` + both `npm test` paths
   (apps/api needs Postgres; apps/pos is browser-only and doesn't).
   ~1 session, mechanical.

### Vendor-blocked (unchanged)

- Checkr Partner credentials pending.
- FlexCredit (CredHub + Esusu) pending.

### Possible follow-ups discovered this session

- The 4xx-discard path could lose user-visible data without
  surfacing it. Today the cashier sees nothing — only the console.
  Worth adding a discarded-toast notification if it ever bites
  someone in practice. Captured in S264 already.
- Retry backoff timing test (assert second attempt fires after
  ~5s when fake-timers advance) is doable but not in this suite.
  Decided "verify next_attempt_at is set" was load-bearing enough.

---

End of S268 handoff.

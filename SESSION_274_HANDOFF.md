# Session 274 — closed (Structured logging — pino in apps/api)

## Theme

Second launch-infra item after Sentry. apps/api now has a real
logging stack instead of `console.log`: pino as the structured
backbone, pino-http for per-request child loggers with correlation
ids, pretty-printed in dev / raw JSON in prod / quiet in test.

Morgan removed.

No frontend, no walkthrough.

## Items shipped

### New module — `apps/api/src/lib/logger.ts`

Two exports:
- `logger` — process-wide pino instance. Use for boot messages,
  cron logs, anything outside an HTTP request.
- `httpLogger` — pino-http middleware. Attaches `req.log` (child
  logger tagged with request id) to every request and emits a
  one-line summary on response end.

Behavior:
- Level via `LOG_LEVEL` env (defaults: `info` in dev/prod,
  `warn` in test so vitest output stays clean).
- Format: pino-pretty in dev (colorized, single line), raw JSON in
  prod (pipe to log aggregator), pretty disabled in test.
- ISO timestamps (human-readable in log viewers that don't
  pretty-print).
- Each record includes `{ app: 'gam-api' }` for filtering when we
  ship multiple Node processes (e.g. a cron worker later).
- Request id generation: trusts inbound `X-Request-Id` header
  when present (so upstream tracing chains through); mints a
  fresh UUID otherwise. Always echoed back on the response.
- Log level routing:
  - 5xx or thrown error → `error`
  - 4xx → `warn` (client tripped a guard; server's fine)
  - else → `info`

### Wiring — `apps/api/src/index.ts`

- `import { logger, httpLogger } from './lib/logger'`
- `app.use(httpLogger)` replaces `app.use(morgan('dev'))`.
- Startup `console.log` block replaced with one
  `logger.info({...}, 'GAM API listening')` call carrying all the
  context fields as structured data.

### errorHandler upgrade — `apps/api/src/middleware/errorHandler.ts`

- Replaced `console.error(err)` with the per-request child logger
  when available (`req.log`), falling back to the process
  logger if pino-http hasn't attached one yet (e.g. error
  thrown before middleware ran).
- `status === 500` widened to `status >= 500` so 502/503 also
  log.

### Dependency hygiene

- Added: `pino`, `pino-http`, `pino-pretty`
- Removed: `morgan`, `@types/morgan` (no remaining references in
  `src/`)

## Decisions made during build

| Question | Decision |
|---|---|
| pino vs winston | **pino.** Faster (claims 5× perf vs winston in JSON mode), simpler API, ships JSON natively. Standard pick for production Node servers at GAM's scale. |
| Replace all 330+ console.* calls in this session? | **No — infra only.** Wholesale migration touches every service file and is days of work without a payoff this session. logger module + pino-http middleware + errorHandler + boot logs unblock new code and structured request logs immediately. Legacy console calls keep working; migrate opportunistically. |
| Pretty in dev or JSON everywhere | **Pretty in dev, JSON in prod.** Devs scanning a terminal benefit from colorized single-line records; prod log aggregators ingest JSON natively. `NODE_ENV` switches behavior. Test mode forces JSON-off + level=warn so vitest stderr stays clean. |
| Reuse logger in error handler vs spawn fresh | **Reuse the request's `req.log` when available.** Carries the request id, so the 5xx log line stitches into the request's other lines in the aggregator. Falls back to the process logger when called outside a request (which shouldn't happen but defends in depth). |
| Generate fresh X-Request-Id or trust upstream | **Trust + echo back.** Honors `X-Request-Id` from any upstream proxy/load-balancer that already minted one; mints UUID otherwise. Always sets the header on the response so the client can quote it in support tickets. |
| Update the level for AppError 4xx errors | **No — keep at `info`.** A 401 / 404 / 409 isn't a server problem. The custom errorHandler only logs >=500. pino-http logs the response-summary line at warn for 4xx; that's enough. |
| Touch `console.log` in route files for this session | **No.** That's the migration described above; it's incremental and isn't infra-blocking. Anyone writing new code uses `logger` / `req.log`. |

## Files touched (S274)

```
apps/api/src/lib/logger.ts              (new — 93 lines)
apps/api/src/index.ts                   (~ morgan → pino-http; startup
                                          console.log → logger.info)
apps/api/src/middleware/errorHandler.ts (~ console.error → req.log/logger,
                                          5xx widened from === to >=)
apps/api/package.json                   (~ pino+pino-http+pino-pretty
                                          added; morgan+@types/morgan
                                          removed)
apps/api/package-lock.json              (~ npm install)
DEFERRED.md                             (~ Structured logging tombstoned
                                          infra-wise; migration note kept)
SESSION_274_HANDOFF.md                  (this file)
```

## Verification

- `cd apps/api && npx tsc -b` → clean.
- `cd apps/api && npm test` → 48/48 passing (tests don't go through
  the express app's middleware stack — they import routers
  directly — so pino-http isn't exercised by the suite. Logger
  module compile-checks via tsc).
- apps/pos unchanged (15/15 still passing).

## Carry-forward — S275+

### Frontend Sentry rollout

9 portals (admin, admin-ops, landlord, tenant, pos, marketing,
listings, property-intel, pm-company, books). Same pattern as
S273 — `Sentry.init` in each main.tsx, ErrorBoundary at the
route root. Decision still open: one Sentry project with `app`
tag vs DSN-per-app.

### Pino-Sentry transport (when frontends land)

`pino-sentry-transport` can forward `error`-level pino records to
Sentry as captures. Already-wired Sentry will receive them. Adds
one transport entry to logger.ts and a `SENTRY_DSN` env check.
~15 min when we want it.

### console.* migration (background work)

330+ legacy call sites. Migrate as you touch the surrounding code
for other reasons. Hot paths to prioritize when convenient:
- `routes/webhooks.ts` — payment lifecycle, every line is ops-
  relevant
- `services/allocation.ts` — money math
- `jobs/*.ts` — cron jobs whose only output is logs

### Other launch list items (DEFERRED order)

1. **Lease lifecycle integration suite.** Biggest remaining test
   gap. ~2 sessions.
2. **Host pick + deploy config.** Needs Nic's call.
3. **Production cron runner.** Coupled to host.
4. **Repo hygiene cleanup.** ~5 min, needs multi-file delete
   permission.

### Vendor-blocked (unchanged)

- Checkr Partner credentials pending.
- FlexCredit (CredHub + Esusu) pending.

---

End of S274 handoff.

# Session 273 — closed (Sentry on apps/api)

## Theme

First launch-infra item past CI/tests: Sentry error tracking for
the backend. `@sentry/node` v8 with auto-instrumentation. No-op
without `SENTRY_DSN` — dev and CI stay clean; flip the DSN env
in staging/prod to enable capture.

No frontend, no walkthrough.

## Items shipped

### New module — `apps/api/src/instrument.ts`

The Sentry init module. Loaded as the FIRST import in
`src/index.ts` because v8 auto-instruments modules at load time
via OpenTelemetry — anything imported before it doesn't get
patched.

Config decisions baked in:
- **No DSN → no init.** `if (process.env.SENTRY_DSN)` guard; calls
  become safe no-ops elsewhere. Avoids the "guard at every
  capture site" sprawl.
- **`environment`** from `NODE_ENV`, defaults to `development`.
- **`release`** from `SENTRY_RELEASE` (populated by the deploy
  pipeline once we wire one). Falls back to Sentry's default
  grouping until then.
- **`tracesSampleRate`** = 0.1 in prod, 1.0 otherwise. Bump or
  drop after launch based on quota.
- **`sendDefaultPii: false`.** GAM ferries tenant + landlord
  names, addresses, background-check inputs — same data-stays-on-
  GAM posture as CLAUDE.md. Explicit opt-in per capture only.
- **`beforeSend`** filters 4xx out of auto-capture (statusCode
  on `AppError` instances). Only 5xx + uncaught exceptions land
  in Sentry by default. Manual `Sentry.captureException` calls
  still fire for whatever the caller wants.

### Wiring — `apps/api/src/index.ts`

- `import './instrument'` as the literal first import (above
  every other module).
- `import * as Sentry from '@sentry/node'`.
- `Sentry.setupExpressErrorHandler(app)` mounted **after all
  routes, before the custom `errorHandler`**. Sentry's handler
  captures the exception (when DSN is set) then calls `next(err)`
  so the custom handler can still shape the JSON response.

### Env documentation — `.env.example`

```
# Sentry (apps/api). Leave unset in dev — apps/api/src/instrument.ts
# skips init entirely when SENTRY_DSN is empty.
# SENTRY_DSN=https://<key>@<org>.ingest.sentry.io/<project>
# SENTRY_RELEASE=  # populated by the deploy pipeline, e.g. git sha
```

## Decisions made during build

| Question | Decision |
|---|---|
| Sentry v7 (manual `Sentry.Handlers.requestHandler()`) vs v8 (auto-instrument) | **v8.** Latest SDK, idiomatic API, OpenTelemetry-based auto-instrumentation gives us pg + express tracing without code changes. The "init first, before any other import" requirement is the only pattern wrinkle; isolated to `instrument.ts`. |
| One Sentry project vs one-per-app | **Defer the decision.** apps/api gets a DSN env var. Once frontends add Sentry too, the question is `SENTRY_DSN` (one project, app-tags differentiate) vs `SENTRY_DSN_API` / `SENTRY_DSN_LANDLORD` / ... (separate projects). Picking the wrong default now would force a re-config later. Frontend Sentry rollout is its own session — make the call there. |
| sendDefaultPii on/off | **Off.** Per CLAUDE.md "All tenant data stays on GAM servers" — even crash reports shouldn't ship request bodies / cookies / IPs by default. Explicit `Sentry.setContext` / extra data per capture is the opt-in. |
| Filter 4xx from auto-capture | **Yes via `beforeSend`.** AppError(409, 400, 404, etc.) is normal API surface, not an alert-worthy event. Filtering reduces ingest noise + cost. 500+ still fires. |
| Where to mount `setupExpressErrorHandler` | **Before the custom errorHandler.** Sentry calls `next(err)` after capture, so the custom handler still owns the JSON response shape (`{ success: false, error: ... }`). Order matters — put Sentry first or it never sees the exception. |
| Skip Sentry for tests | **No code change needed.** Tests run without `SENTRY_DSN` set; instrument.ts's guard short-circuits init. Sentry middleware is mounted on the app but with no client it's a no-op. Vitest output is unaffected. |

## Files touched (S273)

```
apps/api/src/instrument.ts         (new — 48 lines, init module)
apps/api/src/index.ts              (~ +6 lines — instrument import,
                                     Sentry import, setupExpressErrorHandler)
apps/api/package.json              (~ added @sentry/node v8.55.2 dep)
apps/api/package-lock.json         (~ npm install)
.env.example                       (~ +6 lines — Sentry env vars)
DEFERRED.md                        (~ apps/api Sentry tombstoned;
                                     frontend Sentry still pending)
SESSION_273_HANDOFF.md             (this file)
```

## Verification

- `cd apps/api && npx tsc -b` → clean.
- `cd apps/api && npm test` → 48/48 passing (Sentry no-op in test
  env, no behavior change).
- `cd apps/pos && npm test` → 15/15 passing (untouched).
- Smoke test of `instrument.ts`:
  - Without DSN: `Sentry.getClient()` returns undefined.
  - With DSN: `Sentry.getClient()` returns an active client, public
    key matches the DSN.

## Carry-forward — S274+

### Sentry rollout — frontends (follow-on)

Add `@sentry/react` (or `@sentry/browser`) + `Sentry.init` in each
portal's `main.tsx`, plus an `ErrorBoundary` at the route root. 9
portals: admin, admin-ops, landlord, tenant, pos, marketing,
listings, property-intel, pm-company, books. Similar pattern, just
mechanical multiplication. ~1 session.

### Other launch list items (DEFERRED order)

1. **Lease lifecycle integration suite.** Biggest remaining test
   gap. Fake clock + multiple service collaborators. ~2 sessions.
2. **Structured logging (pino).** Replace `console.log` /
   `console.error` in apps/api with leveled JSON + request-id
   correlation. ~1 session. Hooks into Sentry naturally
   (pino-sentry transport).
3. **Host pick + deploy config.** Render is the documented
   recommendation. Needs Nic's call.
4. **Production cron runner.** Coupled to host.
5. **Repo hygiene cleanup.** Delete `.s*backup` files + the
   leftover `.bak` files at repo root. ~5 min, multi-file delete
   needs Nic's permission.

### Vendor-blocked (unchanged)

- Checkr Partner credentials pending.
- FlexCredit (CredHub + Esusu) pending.

---

End of S273 handoff.

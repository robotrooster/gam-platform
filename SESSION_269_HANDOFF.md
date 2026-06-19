# Session 269 — closed (CI workflow)

## Theme

`.github/workflows/ci.yml` lands. Every push + PR now runs all 45
tests + tsc across apps/api and apps/pos. Guard layer on top of
S265–S268's test work.

No frontend, no walkthrough.

## Items shipped

### New module — `.github/workflows/ci.yml`

Single job, `ubuntu-latest`, sequential steps:

1. Checkout
2. Setup Node 20 (matches the `@types/node ^20.x` constraint in
   apps/api) with `cache: 'npm'`
3. `npm ci` at repo root (installs every workspace at once)
4. `npm run build --workspace=packages/shared` (composite TS
   project; downstream apps need the emitted `dist/`)
5. apps/api: `npx tsc -b`
6. apps/api: `npm test` (DB_NAME=gam_test prefix on the script
   wins over the workflow-level DB_NAME=postgres)
7. apps/pos: `npx tsc --noEmit`
8. apps/pos: `npm test` (jsdom, no DB needed)

### Postgres service container

`postgres:16` matches the dev DB version (pg_dump 16 emitted
`\restrict` meta-commands that S265's globalSetup strips; using
a different major could mis-parse the schema dump).

`POSTGRES_USER=postgres`, `POSTGRES_PASSWORD=postgres`,
`POSTGRES_DB=postgres`. `globalSetup.ts` connects to the
`postgres` admin DB, drops + recreates `gam_test`, loads
`schema.sql`. Same flow as local.

Health check: `pg_isready -U postgres`, 10s interval, 5 retries.
The job's steps wait for the service to be ready before running
queries.

### Workflow env

```
DB_HOST=localhost  DB_PORT=5432
DB_USER=postgres   DB_PASSWORD=postgres
DB_NAME=postgres   (overridden to gam_test by `npm test` prefix)
```

apps/api `db/index.ts` calls `dotenv.config({ path: ... })` with
a hardcoded macOS path that doesn't exist on the CI runner.
dotenv returns an error silently, `process.env` from the workflow
takes effect. Same flow as local outside the `apps/api/.env`
loader.

## Decisions made during build

| Question | Decision |
|---|---|
| Single job vs parallel api/pos jobs | **Single sequential job.** Total install + test time is ~3–5 min — fast enough that the parallelism savings don't outweigh the duplicated `npm ci` cost. Splitting becomes worthwhile if total wall time creeps past 10 min. |
| Postgres major version | **16, exact match for dev.** The repo's `schema.sql` is pg_dump 16 output; using 15 risks parsing surprises and using 17 isn't yet validated. Lock to dev's major. |
| Workspace install scope | **`npm ci` at root, full tree.** 12 apps in `apps/`; npm workspaces installs everything. Slower install but the cleanest no-thinking option. If CI time becomes a bottleneck, switch to `npm ci --workspace=apps/api --workspace=apps/pos --workspace=packages/shared --include-workspace-root`. |
| Build `packages/shared` explicitly | **Yes — separate step before tsc.** apps/api's tsc -b would build it transitively via the project reference, but the apps/pos tsc step doesn't have a TS reference link (just an npm dep on `@gam/shared`). Pre-building shared once up front keeps both downstream tsc steps clean. |
| Trigger scope | **`push:` + `pull_request:` unfiltered.** All branches, every event. No path filters — the test surface is small enough that running on every push gives the strongest signal. Can be narrowed later if it becomes noisy. |
| Workflow validation | **YAML lint + indent check locally.** Couldn't actually fire the workflow without pushing. The CI runs on Nic's first push that includes this file. Worst case: fix-forward in another session. |

## Files touched (S269)

```
.github/workflows/ci.yml           (new — 73 lines)
DEFERRED.md                        (~ CI tombstoned, "first remote
                                     run on Nic's next push" note)
SESSION_269_HANDOFF.md             (this file)
```

## Verification

- Local: `cd apps/api && npm test` → 30/30. `cd apps/pos && npm
  test` → 15/15. No regression from this session's work.
- YAML structure parsed clean (indent multiples of 2, no parse
  errors).
- The actual workflow run only happens on push. No mechanism to
  test that locally short of `act` (the GitHub Actions local
  runner) — not installed; the YAML is straightforward enough
  that the design risk is low.

## Carry-forward — S270+

Per S268 list, remaining items in roughly leverage order:

1. **Rent webhook handler suite.** `routes/webhooks.ts`,
   `payment_intent.succeeded` path. Biggest single coverage gap.
   Needs a Stripe mock strategy. ~1.5–2 sessions.
2. **Sentry on apps/api.** Error tracking. ~1 session, mechanical.
   Adds a `SENTRY_DSN` env-var surface + a DSN-per-app or unified
   project decision. Probably starts API-only and extends to
   frontends later.
3. **Lease lifecycle integration suite.** Sign → move-in invoice
   → monthly invoice cron → late-fee on grace expiry. Fake clock
   + timezone control + multiple service collaborators.
   ~2 sessions.
4. **Production cron runner.** `node-cron` runs in-process inside
   the API today; a restart loses pending firings. DEFERRED's
   options: dedicated worker process (Render/Fly worker) or
   managed cron service. Coupled to the host pick — touch when
   #5 lands.
5. **Host pick + deploy config.** Render is the recommended path
   in DEFERRED. Touches deploy.yml + production env. ~1 session
   once Nic chooses.

### Vendor-blocked (unchanged)

- Checkr Partner credentials pending.
- FlexCredit (CredHub + Esusu) pending.

### Possible follow-ups discovered this session

- `apps/api/src/db/index.ts` has a hardcoded `/Users/nicholasrhoades/...`
  path on its `dotenv.config()` call. Works in CI (silent
  no-op) and works in dev (loads the local .env). Production
  will set env vars at the orchestrator level, so the hardcode
  is moot — but it's still a hardcode. Worth converting to
  `path.resolve(__dirname, '../../.env')` at some point.
- The CI job duplicates `npm ci` cost across all workspaces.
  When CI time becomes a bottleneck (probably 100+ tests from
  now), switch to scoped installs or a build cache.

---

End of S269 handoff.

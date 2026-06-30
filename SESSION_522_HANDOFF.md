# SESSION 522 HANDOFF

Theme: **Production hosting groundwork — repo relocation, Mac launchd/backup package, and launch-account setup (Cloudflare/domains).** Continues SESSION_521 (which covered the Reports/platform-fee/agent code work). No code-feature changes here; infra + accounts.

> Most of this session's durable state is in MEMORY (auto-loaded). This handoff is the narrative; the memories are the source of truth:
> `gam-repo-location`, `gam-launch-accounts`, `gam-domains`, `gam-launch-portal-scope`, `gam-platform-fee-income-source`, `gam-maintenance-8pct-contractor-marketplace`.

## Shipped

### 1. Repo moved: `~/Downloads/gam` → `~/gam`  ⚠️ IMPORTANT
macOS TCC blocks **launchd** from `~/Downloads`, which would stop the production API auto-starting. Moved the repo to `~/gam` and repointed every hardcoded path (`.env` path in `apps/api/src/db/index.ts`, `~/gam-start.sh` `REPO=`, the 4 vite `@gam/shared` aliases, `~/gam-admin-code.sh`, `~/.claude/launch.json`, deploy plists, the Edit/Write grants in `.claude/settings.local.json`). Verified: node_modules + `.env` intact, symlinks survived, API typechecks, migrations clean, **full launch set healthy from `~/gam`**. **The repo is `~/gam` now — never put it back in `~/Downloads`.** See [[gam-repo-location]].

### 2. Mac self-hosting deploy package (`~/gam/deploy/`)
For the Vercel-frontends + Mac-backend(+Cloudflare Tunnel) plan.
- `backup-db.sh` → compressed `pg_dump` → `~/gam-backups/`, 14-day rotation, off-Mac cloud hook (`GAM_BACKUP_S3_URI`). **`com.gam.backup` launchd job is LIVE** (nightly 03:30, verified firing, exit 0).
- `launchd/com.gam.{model,embeddings,api,backup}.plist` (lint-OK) + `install-services.sh` (the launch-time switch from dev → prod) + `README.md` runbook.
- TCC handled: model/embeddings/backup run from launchd-safe paths (`~/gam-mlx-env`, `~/models`, `~/gam-services/`); API runs from `~/gam` (now safe post-move). NOT loaded yet (would replace the dev stack) — `install-services.sh` is the launch step.

### 3. Launch set now includes Admin Ops
Launch portals = agents + **landlord/tenant/admin/admin-ops(:3009)/marketing/pos** (6 portals). Stop the other 8. See [[gam-launch-portal-scope]] (updated).

### 4. Launch accounts — IN PROGRESS (see [[gam-launch-accounts]])
All signups use **nic@golddoor.io**; free tiers, no card. Nic does human signup steps; Claude wires everything via tokens/CLI.
- **Cloudflare** account created. **Both domains migrated + propagated** to Cloudflare (`norm`/`sasha.ns.cloudflare.com`): `goldassetmanagement.com` (marketing/app + `api.` subdomain) and `gam.biz` (business portal + `*.gam.biz` RV sites). No MX on either. gam.biz is a blank slate — wipe its imported records.
- **RESUME HERE:** Nic creates a **Cloudflare API token** → Claude does real DNS + `brew install cloudflared` + the **tunnel** (`api.goldassetmanagement.com` → `localhost:4000`) + `com.gam.tunnel` plist. Then **Vercel** (6 frontends), **Resend** (email DNS), **Stripe** (has keys; needs a very broken-down walkthrough for live keys + webhook).

## State of the running stack
Launch set up from `~/gam` (Postgres, Hermes :8080, embeddings :8081, API :4000, the 6 portals). Dev mode = `~/gam-start.sh` then trim. `com.gam.backup` running.

## What next session should target
1. **Finish launch accounts** (the resume chain above): Cloudflare token → tunnel → Vercel → Resend → Stripe.
2. Then production cutover via `deploy/install-services.sh` (after prod values go into `apps/api/.env`).
Everything else launch-side is vendor-gated (Checkr Mon, Twilio) or deferred non-launch (Fitness, Property Intel, FlexCredit).

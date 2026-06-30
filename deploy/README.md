# GAM — Mac self-hosting + deploy runbook

Hosting model (decided): **Vercel = frontends · Mac = backend (API, Postgres, LLM) behind a Cloudflare Tunnel.** The LLM stays on the Mac permanently (cost + data sovereignty). Move Postgres to a managed host only when the super-admin **Scaling Readiness** panel (Admin → Platform) tells you to.

```
Browser ──▶ Vercel (landlord/tenant/admin/admin-ops/marketing/pos static builds)
                 │  API calls + Stripe webhooks
                 ▼
        Cloudflare Tunnel  ──▶  Mac Studio
                                 ├─ API :4000  (com.gam.api, prod dist; hosts the scheduler)
                                 ├─ Hermes :8080 (com.gam.model)
                                 ├─ embeddings :8081 (com.gam.embeddings)
                                 └─ Postgres :5432 (brew service)
                                 nightly pg_dump (com.gam.backup)
```

## 1. Backend services (launchd) — survives reboot, auto-restarts

Files: `deploy/launchd/com.gam.{model,embeddings,api,backup}.plist`. Install/switch from the dev stack:

```bash
bash deploy/install-services.sh          # builds API dist, installs all 4, loads them
# or just the backup job (safe alongside the dev stack):
bash deploy/install-services.sh backup
```

- `com.gam.api` runs the **production build** (`node dist/index.js`), not ts-node-dev. KeepAlive ⇒ it
  also keeps the **in-process scheduler** (rent invoices, late fees, platform-fee accrual) alive — that's
  the "production cron runner".
- The API loads its own env from `apps/api/.env`. **Before launch, swap in production values** there
  (DB password, `JWT_SECRET`, Stripe LIVE keys, `EMBEDDINGS_ENDPOINT`, etc.). Dev values work until then.
- Check: `launchctl list | grep com.gam` · Logs: `/tmp/gam-{mlx,embeddings,api,backup}.log`.
- Dev mode is still `~/gam-start.sh`; the launchd services are the production switch.

### macOS TCC — RESOLVED (repo moved to `~/gam`)

macOS denies launchd agents access to `~/Downloads`/`~/Documents`/`~/Desktop` ("Operation not
permitted"). The repo used to live in `~/Downloads/gam`, which blocked `com.gam.api`. **Fixed by moving
the repo to `~/gam`** (a plain, non-TCC home dir) and repointing every path (the `.env` path in
`apps/api/src/db/index.ts`, `~/gam-start.sh`'s `REPO=`, the vite `@gam/shared` aliases, `com.gam.api.plist`,
`~/.claude/launch.json`). All four services now run from launchd-accessible paths:

| Service | Runs from | TCC |
|---|---|---|
| `com.gam.model` | `~/gam-mlx-env` + `~/models` | ✅ |
| `com.gam.embeddings` | `~/gam-services/start-embeddings.sh` + `~/models` | ✅ |
| `com.gam.backup` | `~/gam-services/backup-db.sh` | ✅ (live) |
| `com.gam.api` | `node ~/gam/apps/api/dist/index.js` | ✅ |

Keep the repo OUT of `~/Downloads` going forward. The self-contained scripts still get staged to
`~/gam-services/` by `install-services.sh` (belt-and-suspenders; they only touch `~/models` + Postgres).

## 2. Database backups

`deploy/backup-db.sh` → compressed `pg_dump` to `~/gam-backups/`, 14-day rotation. Wired to
`com.gam.backup` (nightly 03:30). Restore: `pg_restore --clean --if-exists -d gam <dump>`.

**Off-Mac copy (real DR):** a backup on the same Mac as the DB is not disaster recovery. Set
`GAM_BACKUP_S3_URI` (+ install `rclone` or the `aws` CLI) so each nightly dump also copies to cloud
storage. Until then, at minimum keep Time Machine on an external drive.

## 3. Cloudflare Tunnel (TODO — needs your Cloudflare account + a domain)

Gives the Mac a stable public `https://api.<domain>` with TLS, no open ports — this is the URL Vercel
and Stripe webhooks hit.

```bash
brew install cloudflared
cloudflared tunnel login                       # opens browser → pick the domain's zone
cloudflared tunnel create gam-api
# route api.<domain> → http://localhost:4000, then run as a launchd service:
sudo cloudflared service install
```

(We'll script the tunnel config + a `com.gam.tunnel` plist once the account/domain are picked.)

## 4. Vercel frontends (TODO — needs your Vercel account)

Each app in `apps/{landlord,tenant,admin,admin-ops,marketing,pos}` is a Vite build. Per app: set the
build output, and point its `VITE_API_URL` (and `VITE_*` keys) at the Cloudflare API URL. We'll add a
per-app `vercel.json` + the env manifest once the account is linked.

## Launch order
1. Swap prod values into `apps/api/.env`.
2. `bash deploy/install-services.sh` (backend up on the Mac).
3. Cloudflare Tunnel → public API URL.
4. Vercel deploy frontends pointed at that URL.
5. Stripe live keys + webhook → `https://api.<domain>/api/webhooks/stripe`.
6. Resend domain verification; Checkr/Twilio keys.

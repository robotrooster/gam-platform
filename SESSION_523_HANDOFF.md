# SESSION 523 HANDOFF — Launch infra: Cloudflare tunnel + Vercel frontends live

## Theme
Stood up the production hosting for the launch set end-to-end. Frontends now
reachable on real domains, API reachable from the public internet, full chain
(browser → CORS → API → Postgres) verified. No product/feature code beyond a
CORS change.

## Shipped
- **Cloudflare tunnel** `gam-api` (remotely-managed, id `e7a31d39-a03f-4fcd-9782-37e575dc464e`):
  `api.goldassetmanagement.com` → `http://localhost:4000`. launchd `com.gam.tunnel`
  (KeepAlive+RunAtLoad). `cloudflared` 2026.6.1 via brew. Verified `/health` → 200.
- **5 SPAs on Vercel** (team GAM / slug `goldengoose`, Hobby), prebuilt static deploys
  built locally with `.env.production` (`VITE_API_URL=https://api.goldassetmanagement.com`):
  projects `gam-{landlord,tenant,admin,admin-ops,pos}`. Deployment protection
  (ssoProtection) disabled on each via API. Custom domains + Cloudflare CNAMEs
  (DNS-only) live with TLS:
  `landlord. / tenant. / admin. / ops. / pos. .goldassetmanagement.com` → 200.
- **Marketing on the Mac via tunnel** (it's a dynamic Node server `apps/marketing/server.js`,
  not static — injects `API_URL` into client HTML). New launchd `com.gam.marketing`
  (`API_URL=https://api.goldassetmanagement.com`, plist also in `deploy/launchd/`).
  Tunnel ingress + apex/www CNAMEs added. `goldassetmanagement.com` + `www` → 200.
- **Build fix** (committed f067144, prior to this handoff): removed stale compiled
  `vite.config.js`/`.d.ts` across 4 apps (hardcoded `/Users/...` paths broke non-local
  builds) and gitignored them; `vite.config.ts` (portable `sharedAlias`) is source of truth.
  Same commit pushed the 507–522 backlog (326 files) to GitHub.
- **CORS** (`apps/api/src/index.ts`): origin is now a function allowing the apex +
  any `*.goldassetmanagement.com` + the existing localhost dev defaults + ArcGIS.
  No `.env` edit needed. Verified: login from `admin.goldassetmanagement.com` → 200
  (returns TOTP challenge), random origin rejected.

## Decisions made
- Domain layout: **subdomain per portal** on goldassetmanagement.com; apex = marketing.
- Marketing **hosted on the Mac via tunnel** for launch (dynamic server, reads `../../legal`).
- Vercel **Hobby for setup, upgrade to Pro before paying customers** (commercial-use ToS).
- Deploy via **prebuilt static upload**, not Vercel's monorepo remote build (sidesteps
  npm-workspace build complexity; local build already proven).

## Files touched
- `apps/api/src/index.ts` — CORS origin function.
- `.gitignore` — added `apps/*/vite.config.js`, `apps/*/vite.config.d.ts`, `.env.*`, `.vercel`.
- `deploy/launchd/com.gam.marketing.plist` — new.
- `apps/{landlord,tenant,admin,admin-ops,pos}/.gitignore` — Vercel-created (`.vercel`, `.env*`).
- Untracked/ignored (NOT committed): `apps/*/.env.production`, `apps/*/.vercel/`.

## New persistent infra (launchd, survives reboot)
- `com.gam.tunnel` — Cloudflare tunnel (logs `/tmp/gam-tunnel.log`).
- `com.gam.marketing` — marketing site :3004 (logs `/tmp/gam-marketing.log`).
- (Pre-existing: `com.gam.backup`.)
- Cloudflare token + account/zone/tunnel/Vercel IDs live in `apps/api/.env` (gitignored).

## Deferred / next session should target
1. **Resend** (Free) — verify sending domain (DNS via Cloudflare), `RESEND_API_KEY` → `apps/api/.env`.
2. **Stripe webhook** → `https://api.goldassetmanagement.com/webhooks/stripe` + live keys
   (Nic wants a very broken-down walkthrough).
3. **Harden backend to prod launchd before go-live.** `api.goldassetmanagement.com` is
   currently served by the **dev** `ts-node-dev` API on :4000 (+ dev model/embeddings).
   Run `deploy/install-services.sh` to build dist + install `com.gam.{api,model,embeddings}`.
4. **Vercel Hobby → Pro** before public onboarding (commercial ToS).
5. Eventually move API + Postgres off the home Mac (fragility at 300–400 units).

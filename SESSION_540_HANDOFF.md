# SESSION 540 HANDOFF

## Theme
Reliability session (Nic-driven): portals must not white-page, and a
tab left open for 1–5 hours must keep working with no manual refresh.
Trigger: landlord tab (:3001) hung white in Safari; other portals had
dumped to login screens after the stack restart.

## Root causes found (three independent ones)

1. **Render-blocking Google Fonts** — every portal loaded font CSS
   from fonts.googleapis.com, via BOTH index.html <link>s (part
   legacy) and `@import url(...)` lines buried in globals.css /
   main.tsx CSS strings (the live ones). Any stall on that fetch =
   white page until it resolved. Day-one scaffolding that every new
   app copied; the W-47 font redesigns changed families but never
   removed the Google loader lines.
2. **IPv6-only listeners** — vite defaulted to `localhost` bind =
   `[::1]` only, while Safari resolves localhost dual-stack (API and
   marketing already bound `*`, which is why they never flaked).
3. **Auth bootstrap logged out on ANY /auth/me failure** — every
   portal's `catch { logout() }` wiped the stored 7-day token on
   transient network errors (API mid-restart). That's why portals
   showed login screens after restarts. The hung landlord tab itself
   was a Safari WebContent process hang (S537 ghost-window class) —
   servers were healthy the whole time (200 in ~1ms, logs clean).

## Shipped (all 12 SPA apps unless noted; all tsc clean)

### 1. Self-hosted fonts — ZERO external font requests
- @fontsource packages installed at repo root: inter,
  jetbrains-mono, syne, dm-sans, dm-mono, space-grotesk.
- All index.html Google <link>s stripped; all `@import
  url(fonts.googleapis...)` lines stripped (globals.css / main.tsx
  CSS strings); per-app @fontsource imports prepended to main.tsx
  matching the families each app actually uses (landlord: Space
  Grotesk + Inter + DM Mono; most others: Syne + DM Sans + DM Mono;
  fitness: Inter/JBM heavy weights; property-intel: Syne/DM
  Sans/DM Mono).
- Verified live: document.fonts loads Space Grotesk + Inter locally,
  performance entries show 0 googleapis/gstatic requests.
- **Marketing prod (:3004) — CLOSED (Nic OK'd, "your call"):** the
  Google font CSS in src/index.html is now NON-BLOCKING
  (media="print" onload swap + noscript fallback) — the page renders
  on system fonts immediately; a stalled Google fetch can't
  white-page the live site. Deployed via
  `launchctl kickstart -k gui/$UID/com.gam.marketing`; verified 200 +
  new HTML locally AND via https://goldassetmanagement.com. Kept on
  Google (not self-hosted) deliberately — the whole marketing site
  gets rebuilt at launch (Nic), so minimal-touch was right.
- NOTE: apps/marketing/index.html (app root) is DEAD scaffolding —
  references /src/main.tsx which doesn't exist; prod serves
  src/index.html. Left untouched.

### 2. Dual-stack binds
- `server.host: true` in every app's vite.config.ts (admin-ops +
  listings had no server block; one was added). All launch-set ports
  now `*:PORT`.

### 3. Tab-resilience script (index.html, framework-independent)
Replaces the interim boot guard; three layers:
- Boot watchdog: #root not mounted within 10s → reload (max 1/60s,
  sessionStorage `gam_boot_retry`).
- Sleep-gap: 30s tick; a >45min gap between ticks (system slept /
  tab suspended) → reload on wake. Also wired to visibilitychange +
  focus.
- Long-hidden: tab hidden >2h → self-reload while hidden, so hours
  of renderer state never accumulate (defense against the
  landlord-tab hang class).

### 4. Auth bootstrap resilience (8 portals)
- packages/shared: `isAuthRejection(e)` (401/403 only) +
  `fetchAuthMeWithRetry(fn, attempts=5, delayMs=2500)` (~12s window;
  auth rejections rethrow immediately).
- Patched: landlord/business/pm-company/pos AuthContext.tsx;
  tenant main.tsx (BOTH bootstrap sites); admin, admin-ops, books
  main.tsx. logout now fires ONLY on real 401/403.
- **PROVEN live**: logged into landlord → killed the API listener →
  reloaded the tab mid-outage → ts-node-dev respawned (~10s) → tab
  came back still on /dashboard, token intact. Pre-fix this exact
  sequence hit the login screen.

### 5. Corrupted titles fixed
- landlord index.html had THREE portal titles concatenated in
  <title>, tenant had two (old patch-script damage). Now clean.

## Environment / process notes
- Launch set restarted via `bash start-launch-set.sh` (idempotent;
  never touches :3004). All ports verified 200 over IPv4 AND IPv6.
- The watchdog (com.gam.watchdog, 5-min launchd) was healthy all
  along — nothing server-side ever died today.
- The hung Safari tab class (WebContent process hang, no JS runs)
  cannot be fixed from page code — quit/reopen Safari when it
  happens. The layers above make the triggers rare and everything
  else self-heal.
- S539 (FIFO tenant polish) closed earlier the same day — see
  SESSION_539_HANDOFF.md.

## Decisions made
- Nic: this reliability class is priority #1 ("if I leave for five
  hours and come back, I should not need to refresh").
- Claude (flag if wrong): 45-min sleep-gap and 2-h hidden-reload
  thresholds; hidden self-reload accepts losing >2h-idle POS cart
  state; marketing prod untouched pending Nic.

## Files touched
- packages/shared/src/index.ts (auth helpers, appended).
- All 12 apps: index.html (fonts/titles/resilience script),
  vite.config.ts (host), main.tsx (fontsource imports; auth in 4).
- AuthContext.tsx: landlord, business, pm-company, pos.
- globals.css/styles.css @import strips: landlord, business,
  pm-company, pos, customer.
- Root package.json/package-lock (6 @fontsource packages).

## Next session targets
1. Nic-gated: marketing (:3004) font fix (see #1 exception).
2. Unchanged queue: storefront subdomains (future), Stripe live
   keys → FlexPay flip + launch flips, Checkr key, DoorLoop export,
   fee-number blessings.

## Watchouts
- Never reintroduce external font/CDN links — memory saved
  (gam-no-external-cdn-assets). New apps: copy an existing app's
  fontsource imports + resilience script.
- The resilience script lives in EACH index.html (12 copies) —
  keep-in-sync rule applies when changing it.
- prod build check not run on fitness/customer/listings (dev-only
  apps today); tsc clean on all.

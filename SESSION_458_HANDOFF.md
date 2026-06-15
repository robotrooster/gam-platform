# Session 458 — closed

## Theme

**Phase 1a.1 portal scaffold. `apps/business` — Vite + React +
TypeScript shell mirroring `apps/landlord`'s structure but
intentionally minimal. Six pages (Login, Signup, Dashboard,
Customers, Staff, Settings), AuthContext adapted for the
business_owner + business_staff roles, dark/gold theme reused
from landlord. Per Nic's S457 direction ("just make something
we'll update"), this is the stub-with-real-API-wiring — not
the polished v1.**

Brand: **GAM for Businesses** (Nic-locked at S457 close).
Port: **3012** (per S457 plan).

Suite at S457 close: 2882 / 152.
Suite at S458 close: **2882 / 152 / 0 failures**, 101.66s
(unchanged — no API changes this session).

Zero tsc regressions (apps/api). Business app builds clean
(236.64 KB JS, 13.45 KB CSS gzipped).

## What shipped

### `apps/business` Vite app — full scaffold

```
apps/business/
  index.html
  package.json              ("type": "module" for ESM-only plugins)
  vite.config.ts            (port 3012, @gam/shared alias)
  tsconfig.json
  tsconfig.node.json
  src/
    main.tsx                (BrowserRouter + AuthProvider +
                             protected route wrapper)
    context/
      AuthContext.tsx       (uses `gam_business_token` localStorage
                             key — distinct from landlord's
                             `gam_token` so cross-portal tabs don't
                             clobber each other; rejects non-business
                             roles at /me)
    lib/
      api.ts                (copy of landlord's api.ts with the
                             token key swapped)
    styles/
      globals.css           (copy of landlord's design tokens —
                             dark/gold; same fonts, same color
                             variables)
    components/layout/
      Layout.tsx            (sidebar nav: Dashboard / Customers /
                             Staff / Settings; nav items role-
                             filtered so business_staff doesn't
                             see Staff or Settings)
    pages/
      LoginPage.tsx         (forms /api/auth/login)
      SignupPage.tsx        (forms POST /api/businesses, owner
                             self-signup with ToS gate)
      DashboardPage.tsx     (business name + 3 stat cards:
                             customers, active staff, pending
                             invitations + "coming soon" panel)
      CustomersPage.tsx     (read-only table; create form
                             deferred to a future session per
                             the "just make something we'll
                             update" scope)
      StaffPage.tsx         (staff table + pending invitations
                             + invite form — the most interactive
                             page in this scaffold)
      SettingsPage.tsx      (business profile PATCH form)
```

### Brand + tokens

- Sidebar shows "GAM" in gold display font + "for Businesses"
  underneath in body font (Nic-locked branding from S457).
- All pages use the landlord design tokens (--bg-0..5,
  --gold, --text-0..3, etc.) so the visual language is
  identical to the other portals out of the box.

### Auth wiring

- AuthContext consumes `/auth/login` + `/auth/me` (built in
  S454).
- LocalStorage key: `gam_business_token` (NOT `gam_token`).
  Same user can have tabs open in landlord + business portals
  without one clobbering the other's session.
- `/me` is checked for role ∈ {business_owner, business_staff};
  any other role gets auto-logged-out (defense against someone
  re-using a non-business token).
- Login response is similarly validated — error message
  "This portal is for service-business operators" if the
  account turns out to be a landlord/tenant.

### Nav role-filtering

- **business_owner** sees all four nav items
- **business_staff** sees only Dashboard + Customers
  (Staff + Settings stay owner-only)
- User card at bottom of sidebar shows name + role (and
  staffRole if applicable: "business staff · dispatcher")

### dev.sh integration

- Killed-port loop includes 3012
- `npm run dev --workspace=apps/business` line added next to
  pm-company
- Port-map banner + listening-ports check both updated
- One-line message: `Business → :3012`

### CLAUDE.md update

Added Business portal: 3012 entry to the port list, with a
note that this is where route optimization will live in
Phase 1a.3.

### npm workspace install

Ran `npm install --workspace=@gam/business` from repo root.
node_modules installed cleanly. The "57 outdated formulae"
warning is unrelated noise — same warning the existing apps
emit on install.

## Items shipped

```
apps/business/                              (NEW — 14 files)
  index.html
  package.json (with "type": "module")
  vite.config.ts
  tsconfig.json + tsconfig.node.json
  src/main.tsx
  src/context/AuthContext.tsx
  src/lib/api.ts
  src/styles/globals.css
  src/components/layout/Layout.tsx
  src/pages/LoginPage.tsx
  src/pages/SignupPage.tsx
  src/pages/DashboardPage.tsx
  src/pages/CustomersPage.tsx
  src/pages/StaffPage.tsx
  src/pages/SettingsPage.tsx
dev.sh                                       (+3 lines / 2 small edits)
CLAUDE.md                                    (+3 lines — port 3012 entry)
```

## Decisions made during build

| Question | Decision |
|---|---|
| LocalStorage token key — share `gam_token` with landlord or use a distinct key? | **Distinct (`gam_business_token`).** Cross-portal tabs are real (an owner could be looking at a peer landlord's listing in one tab and managing their trash business in another). Same key would mean one portal's logout nukes the other's session. Cost: $0 — just a different string literal. |
| Polished CRUD forms in this session, or stubs? | **Stubs.** Nic explicitly said "just make something we'll update" at S457 close. Real validation, edit modals, etc. land after the smoke walk reveals what surfaces actually matter. Customers page is read-only; create lands later. Staff is the most interactive (invite form works end-to-end) since that's the first owner-after-signup flow. |
| Use react-query / react-hook-form like landlord, or plain useState? | **Plain useState/useEffect.** Scaffold-only doesn't need server caching or complex form lifecycles yet. When customer/staff CRUD gets fleshed out, we can pull react-query in then. Keeps the scaffold lean (236 KB JS bundle vs landlord's much larger ones). |
| Add Sentry? | **Skip for scaffold.** Sentry wiring is mature in landlord; lifting it across is a separate hygiene pass. No production exposure on the business portal yet so the missing observability isn't urgent. |
| Add a test file for the portal? | **Skip this session.** Portal stubs need browser smoke (S459) more than unit tests. When CRUD interactions get real, we'll add tests then. tsc + vite build are the green signals for this session. |
| `package.json` "type": "module" — required? | **Yes.** Without it, vite.config.ts can't `require('@vitejs/plugin-react')` (the plugin is ESM-only). Caught this in the first build attempt; fix was a one-line addition. |
| Nav structure — match landlord's section headers, or flat? | **Flat for now.** Only 4 nav items; sections add visual weight that's not yet justified. When Phase 1a.2 (Appointments) and 1a.3 (Routes) add nav items, we'll group then. |
| business_staff nav — what do they see? | **Dashboard + Customers only.** Owner-only for Staff (managing peers is an owner concern) and Settings (business profile is owner-only). Drivers/dispatchers reading customer info to plan their day is fine. |

## Verification

- `cd apps/business && npx tsc --noEmit` clean.
- `cd apps/business && npm run build`: clean, 1487 modules
  transformed, 236.64 KB JS gzipped.
- `cd apps/api && npm test`: **2882 / 152 / 0 failures** —
  unchanged from S457 (no API changes this session).
- Browser-walk verification: **deferred to S459**. Per
  CLAUDE.md frontend rule, I haven't seen this run in a
  browser; build-clean + tsc-clean are necessary but not
  sufficient. The interactive walk catches what static
  analysis can't (form interactions, route navigation,
  visual rendering, "looks weird" feedback).

### Bugs caught during build

1. Unused `useNavigate` import + unused `auth` variable in
   SignupPage — `noUnusedLocals` + `noUnusedParameters`
   tsc flags caught both. Stripped.

2. ESM-only `@vitejs/plugin-react` not loadable from a
   CommonJS package — fixed by adding `"type": "module"`
   to package.json.

## Phase 1a.1 — progress

- ✅ S453 — DB migrations
- ✅ S454 — shared exports + auth scope dispatch
- ✅ S455 — businesses CRUD
- ✅ S456 — business_users invitation + CRUD
- ✅ S457 — business_customers CRUD
- ✅ **S458 — Portal scaffold (this session)**
- ⏳ S459 — Smoke walk

Phase 1a.1 is ~95% by effort. Only the smoke walk + any
fixups from it remain.

## What S459 should target

**Recommended: smoke walk + any fixups.**

Walk script for the next session:

1. `bash dev.sh` (verify port 3012 comes up green)
2. Navigate to `http://localhost:3012`
3. **/signup**: create a new business owner end-to-end.
   Should land on /dashboard with the business name visible.
4. **/dashboard**: verify the 3 stat cards render (all 0
   initially).
5. **/settings**: PATCH the business name + address. Reload
   page; values should persist.
6. **/customers**: empty table, then POST a customer via
   curl/Postman, refresh, verify it appears.
7. **/staff**: invite a staff member by email. Watch
   /tmp/gam-business.log + the email_send_log table for
   the email-send call (Resend dev mode will log the
   would-be-sent email).
8. Log out → log back in. Token persists across reloads.

Whatever breaks during the walk, fix in S459. Whatever's
ugly but works, log to a fixups list for S460.

After S459 closes, Phase 1a.1 ships and Phase 1a.2 (the
appointments primitive) opens.

**Alternatives:**
- Add unit tests for the AuthContext before the walk —
  but the walk catches more meaningful regressions than
  unit tests on a scaffold.
- Polish CRUD forms first — same answer: walk reveals
  which polish matters.

## Items uncommitted in tree

All Phase 1a.1 work (S453-S458) is uncommitted. Natural
commit boundary: ship the entire Phase 1a.1 as one commit
chain or one squashed commit. Plus the state-law work +
Checkr `.env.example` block remain separate decisions
as noted in prior handoffs.

---

End of S458 handoff. **`apps/business` portal scaffold
shipped — 14 files, 6 pages, AuthContext adapted, dark/gold
theme, dev.sh wired, CLAUDE.md updated.** Build clean,
tsc clean, api suite green.

2882 tests / 152 files / 0 failures (api unchanged).

**Phase 1a.1 is ~95% by effort.** S459 smoke-walks; the
arc closes after that.

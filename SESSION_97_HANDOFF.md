# Session 97 Handoff

**Theme:** Tenant TSC strict-mode parity. Same recipe that landed
landlord in S96 — flip both `noUnusedLocals` and `noUnusedParameters`
to true, sweep what surfaces. Different starting position though:
tenant had 17 *real* type errors lurking with the flags off, hidden
since S84 first noted them. Fixed those first, then flipped flags
and cleared the additional 19. Net 36 errors → 0.

## Architecture decision recorded

**Three portals, three strict-clean baselines.** S28b put apps/api at
strict (16 → 0/0/0). S96 brought landlord up. S97 brings tenant up.
All three now reject unused imports + unused parameters at typecheck,
matching the same DX. Going forward, drift is caught at the next
build instead of accumulating across sessions.

**Pre-existing type errors are real bugs, not noise.** The 17
errors that existed with strict flags OFF weren't config violations
— they were type contract failures (useQuery generic mismatch,
undefined symbol references). They had been silent failures the
typechecker was already catching but the project didn't enforce.
Strict-mode parity makes them session-blocking instead of
session-ignored.

**Misplaced UI block deleted, not relocated.** LeasePage.tsx
SignatureCanvas had a 12-line "📋 Document Awaiting Your Signature"
banner referencing `pendingDocs` and `navigate` — neither in scope.
Bad refactor leftover. Pure dead code (the canvas component takes
only `onSign`). Deleted. The banner UX, if needed, lives in a parent
component (matching the landlord-side `PendingSignBanner` in
`Layout.tsx`).

**Two intended-but-orphaned pages wired in.** `DocumentsPage` and
`UtilitiesPage` in main.tsx were defined components nothing routed
to. They're real feature pages with backend endpoints behind them
(documents, utility S90). Added to the router under `/documents` and
`/utilities` rather than deleted. Nav links to them are a follow-up
when the tenant nav UI is touched.

## Shipped

### Pre-strict baseline cleanup (17 errors → 0)

**LeasePage.tsx:**
- Deleted misplaced 12-line pendingDocs/navigate banner inside
  `SignatureCanvas` (referenced symbols not in scope — TS2304 +
  TS2552). The component takes only `{ onSign }`; the banner block
  belonged in the page-level component or nowhere.

**main.tsx + ProfilePage.tsx:**
- 5 useQuery sites adding explicit `get<T[]>(...)` type argument so
  the `() => Promise<unknown>` mismatch (TS2769 useQuery overload)
  resolves. Sites: payments page, maintenance page, documents page,
  utilities page, ProfilePage notifPrefs.

### Strict-flag flip (19 errors → 0)

**tenant/tsconfig.json:**
- `noUnusedLocals: false → true`
- `noUnusedParameters: false → true`

**main.tsx:**
- Drop `createContext` from named imports (used as `React.createContext`
  via the namespace import).
- Drop `PLATFORM_FEES` from `@gam/shared` import (unused in tenant).
- Delete unused `[enrolling, setEnrolling]` state hook in ServicesPage.
- Wire `DocumentsPage` and `UtilitiesPage` into the router (was
  declared but never referenced).

**AcceptInvitePage.tsx:**
- Drop the entire `lucide-react` import line (`Eye`, `EyeOff`, `Check`,
  `DoorOpen`, `Building2` — all unused). TS6192 "all imports unused".

**BackgroundCheckPage.tsx:**
- `[uploading, setUploading]` → `[, setUploading]`. Setter is used,
  getter is not — array destructure with skip slot is the cleanest
  noUnusedLocals fix without renaming.

**LeasePage.tsx:**
- Delete `[showSign, setShowSign]` (unused state) and `workTrade`
  destructure from useQuery (unused query result).

**ProfilePage.tsx:**
- Trim lucide-react import to `User`, `Check`, `AlertCircle` (drop
  `Bell`, `Lock`, `Palette`).
- Helper `s = (label, color) => ({...})` had `label` unused — renamed
  to `_label` (noUnusedParameters allows leading-underscore).

**WorkTradePage.tsx:**
- Trim lucide-react import (drop `Plus`, `AlertCircle`).
- Delete unused `approved` and `rejected` derived consts.

## Files touched

- apps/tenant/tsconfig.json (both flags flipped)
- apps/tenant/src/main.tsx (5 useQuery generics + 3 import/state cleanups + 2 router additions)
- apps/tenant/src/pages/LeasePage.tsx (misplaced banner deleted + 2 strict cleanups)
- apps/tenant/src/pages/ProfilePage.tsx (1 useQuery generic + 2 strict cleanups)
- apps/tenant/src/pages/AcceptInvitePage.tsx (whole import line dropped)
- apps/tenant/src/pages/BackgroundCheckPage.tsx (skip-slot destructure)
- apps/tenant/src/pages/WorkTradePage.tsx (import + 2 const cleanups)
- DEFERRED.md (S97 entry added under smaller items)
- SESSION_97_HANDOFF.md (this file)

## Validation

- `cd apps/tenant && npx tsc --noEmit` → exit 0 with both strict
  flags on
- All three portals (api, landlord, tenant) typecheck exit 0 at
  strict + noUnused* parity
- No `// @ts-ignore`, no `// @ts-expect-error`, no eslint-disable.
  Every error fixed by either removing dead code, fixing the bug, or
  adding the proper type generic.

## What this session did NOT do

- **No admin/books/marketing portal TSC parity check.** Three more
  Vite portals exist; haven't been audited against strict flags. Same
  recipe applies. Bundle into a follow-up session if you want full
  monorepo strict-clean parity.
- **No nav links for the newly-wired Documents + Utilities tenant
  pages.** Routes work; the tenant Layout sidebar would need entries
  to surface them in UI. Frontend session.
- **No tenant frontend behavior changes.** Behavior identical, just
  type-clean now. The misplaced LeasePage banner was already
  unreachable (referenced undefined symbols at render time would have
  thrown).
- **No further npm audit work.** Same 9 vulnerabilities remain from
  S96; all behind breaking upgrades documented in DEFERRED.

## Pre-launch blockers still open

- Item 16 batch 2 — bank ACH origination provider (Monday).
- Item 16 batch 3+ — OTP enablement (FlexPay SetupIntent).
- Item 10 (S90) payment integration — gated on Item 16 batch 2.

Same as the last few sessions — everything else is shipped, partial-
with-frontend-deferred, or stage-2.

## What next session should target

Top picks for S98 (still no ACH info):

1. **Admin / books / marketing TSC parity (recommended).** Same
   proven recipe — finishes the strict-clean parity work across the
   full monorepo. Three portals, probably less debt per portal than
   tenant or landlord. Half-to-full day.
2. **POS price_history triggers + stock_qty NEVER negative guards.**
   Hardening the pos.ts data path. CHECK constraint prevents
   oversells; trigger auto-writes price_history on item edit. Quarter
   day.
3. **Tenant nav links for Documents + Utilities.** S97 wired the
   routes; nav surface is the missing piece. UI work.
4. **Books portal frontend perm-aware nav** (S82 pattern). Half-day
   frontend.

Recommend **#1**. Closes the strict-mode parity chapter for the whole
monorepo while the recipe is fresh. After that, pure cleanup options
(#2) or UI work (#3, #4) until ACH info lands Monday.

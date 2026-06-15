# Session 483 — closed

> Tenant-side lease-detail state-law warnings. Completes the
> both-party transparency loop for lease terms (S478 closed
> it for entry requests).

## Theme

**`checkLeaseAgainstStateLaw` helper extracted from the S476
inline block in `leases.ts` and promoted to the state-law
service module. Tenant GET `/api/tenants/lease` now recomputes
the same warnings the landlord saw at PATCH time against the
persisted lease, and the tenant LeasePage renders them as a
hedged amber banner above the status banner. A tenant who
signs a lease with deposit above the state cap, late fee above
the state percent cap, or grace days below the state minimum
now sees the same factual notice the landlord got — no advice,
no block, just transparency.**

Suite (api) at S482 close: 3073 / 162.
Suite (api) at S483 close: **3077 / 163 / 0 failures** (+4
new cases + 1 new test file).

apps/api tsc: clean. apps/tenant tsc: clean.

## What shipped

### `apps/api/src/services/stateLaw.ts`

`checkLeaseAgainstStateLaw(args)` — composer that runs three
`checkAgainstStatute` calls against the same state and returns
a single `LawFlag[]`:

- `deposit_max_months` via dollars/rent ratio
- `late_fee_max_pct` (only when type === `percent_of_rent`)
- `late_fee_grace_days`

NEVER throws — per-check failures are swallowed individually
so one bad result doesn't suppress the others. Returns `[]`
when `stateCode` is null/undefined, no fields are provided, or
no flags fire.

Each topic check fires only when the caller passes the value
(undefined/null → skip). Lease PATCH passes only patched
fields; tenant GET passes all persisted values.

### `apps/api/src/routes/leases.ts` — `PATCH /:id`

The S476 inline 40-line state-law block replaced with a
6-line call to the helper. Behavior identical (verified — all
51 lease PATCH tests still green).

### `apps/api/src/routes/tenants.ts` — `GET /lease`

- SELECT extended to pull `p.state AS property_state` +
  `lease_fees.security_deposit` subquery.
- After fetching the lease row, calls
  `checkLeaseAgainstStateLaw` with all persisted values.
- Returns `data.state_law_warnings: LawFlag[]` alongside the
  existing lease fields.
- Best-effort: try/catch, errors logged, lease GET success
  unaffected.

### `apps/api/src/routes/tenantsLeaseStateLaw.test.ts` — NEW

4 cases:
- **AZ deposit 2.0× rent** (above 1.5mo cap) → tenant sees flag
  with citation + AZ + "may be out of date" disclaimer.
- **AZ deposit 1.0× rent** → empty.
- **No deposit row** → empty (no false alarm when lease_fees
  has no security_deposit entry).
- **Uncatalogued state** → empty.

Inline `seedAzDepositCap()` helper since schema.sql is
schema-only.

### `apps/tenant/src/pages/LeasePage.tsx`

- New amber-themed banner block inserted between the
  pending-docs section and the status banner.
- Renders `lease.stateLawWarnings` array with the hedged
  message, statute citation, external "source" link, dated
  "as of" line, and GAM disclaimer (italic small).
- Auto-hides when array is empty or absent.
- Uses the tenant LeasePage's existing CSS tokens
  (`--text-0`, `--text-3`, `--amber`, `--gold`) — does NOT
  use the landlord `LawWarningBanner` component since this
  page lives in a different portal with different token
  scoping inheritance.

## Items shipped

```
apps/api/src/services/
  stateLaw.ts                                  (+ checkLeaseAgainstStateLaw composer)
apps/api/src/routes/
  leases.ts                                    (PATCH refactored to call helper)
  tenants.ts                                   (GET /lease attaches warnings)
  tenantsLeaseStateLaw.test.ts                 (NEW — 4 cases)
apps/tenant/src/pages/
  LeasePage.tsx                                (+ inline warning banner block)
```

## Decisions made during build

| Question | Decision |
|---|---|
| Persist warnings on lease row or recompute on GET | **Recompute.** Same posture as S478. The catalog refreshes quarterly; persisting would freeze the snapshot. Recompute keeps current. |
| Helper placement (service module or new file) | **stateLaw.ts service module.** Single composer; promoting to a dedicated file would be ceremony for ~30 lines of orchestration. |
| Re-render the landlord LawWarningBanner component on tenant side | **No, inline duplicate.** Same call as S478 entry-request page: token namespaces differ between portals; cross-portal component sharing needs a new package. Inline blocks are cheaper at this scale. |
| Insert position in LeasePage | **Above the status banner, below pending-docs.** Pending docs are high-priority action; warnings are informational context. Status banner sets the page mood ("Fully Executed" / "Needs Sig"); warnings sit between document action and lease detail. |
| Include source URL link | **Yes (target=\_blank).** Standard pattern; the tenant should be able to verify the cited statute themselves. |
| Block tenant action on warnings | **No.** Same posture as landlord. Hedged factual notice, never blocking. The tenant might still sign; they just see the figure isn't typical for the state. |
| Show warnings on signed vs unsigned leases | **Both.** Useful pre-sign for "is this reasonable?" and post-sign for "what does my lease say vs the law?" Doesn't change the recompute logic; just renders always when present. |

## Verification

- `cd apps/api && npx tsc --noEmit`: clean.
- `cd apps/tenant && npx tsc --noEmit`: clean.
- Targeted: `vitest run tenantsLeaseStateLaw.test.ts` — 4 passed.
- `vitest run leases.test.ts` — 51 passed (refactor preserved
  behavior).
- Full: `npm test` — **3077 / 163 / 0 failures** (+4 cases
  + 1 file).
- `cd apps/tenant && npm run build`: clean (pre-existing 500
  KB warning unrelated).

### Bugs caught during build

- **Initial implicit-any on the dynamic import**: tried
  `await import('../services/stateLaw')` to defer the dep,
  tsc rejected the implicit any on `stateLawWarnings` array.
  Switched to a static `import { checkLeaseAgainstStateLaw,
  type LawFlag } from '../services/stateLaw'` at the top of
  tenants.ts. Cleaner anyway — no reason to lazy-import a
  pure compute function.

## Phase status — state-law arc

The state-law write-path arc now covers EVERY write path that
mutates a directional figure AND surfaces warnings to BOTH
parties on read:

| Write path | Backend wiring | Landlord UI | Tenant UI |
|---|---|---|---|
| Lease PATCH | S476 → S483 (helper) | S477 banner | S483 LeasePage banner |
| Entry-request POST | S475 + S476 | S477 banner | S478 inline blocks |
| Entry-request GET (recompute) | S478 (helper) | — | S478 inline blocks |
| Property defaults PATCH | S481 | S481 banner | n/a (landlord-only) |
| Tenant GET /lease (recompute) | **S483 (helper)** | n/a | **S483 banner** |
| Refresh discipline | S479 (weekly cron) | — | — |
| Landlord agent-activity reporting | S480 (VIEW + routes) | S480 page + S482 dash card | n/a |

Both-party transparency loop now closed end-to-end for both
entry requests AND lease terms.

## What the next session should target

Open candidates after this session:

- **Mobile-responsiveness audit** on the new banners
  (LawWarningBanner + tenant LeasePage inline block +
  AgentActivityCard). All amber-bordered + inline; should
  reflow on phone-sized viewports.
- **PM-company staff access** to the agent-activity surface —
  permission-framework work.
- **New product arcs** needing direction — website hosting
  for landlord property sites, listings portal build-out
  (apps/listings exists), property intelligence build-out
  (apps/property-intel exists).

Or take stock and plan a new arc.

---

End of S483 handoff. **State-law helper extracted +
tenant-side lease warnings shipped. Both-party transparency
loop closed for lease terms.**

3077 tests / 163 files / 0 failures.

**State-law arc fully closed across S475 → S483.**

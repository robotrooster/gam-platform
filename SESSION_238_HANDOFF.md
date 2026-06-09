# Session 238 — closed

## Theme

vite 5→8 jump across all 9 frontend workspaces. The S237 carryforward
flagged this as "three-major jump risk" / multi-session, but the
actual lift turned out to be smaller than that — vite configs are
minimal across all apps + plugin-react has a 5.2.0 release that
declares peer compatibility for vite 4 through 8 and doesn't pull
in React Compiler (unlike 6.x). One session, all builds clean,
6 → 1 npm audit vulns.

## Items shipped

### Vite 5 → 8 across all 9 frontends

**Workspaces touched:**
- apps/admin (5.0.11 → 8.0.0)
- apps/admin-ops (5.0.0 → 8.0.0)
- apps/books (5.1.0 → 8.0.0)
- apps/landlord (5.0.11 → 8.0.0)
- apps/listings (5.0.0 → 8.0.0)
- apps/pm-company (5.0.11 → 8.0.0)
- apps/pos (5.0.11 → 8.0.0)
- apps/property-intel (5.1.0 → 8.0.0)
- apps/tenant (5.0.11 → 8.0.0)

**plugin-react:** 4.x → 5.2.0 (NOT 6.x — 6.x peers
`@rolldown/plugin-babel` + `babel-plugin-react-compiler` which would
have meant adding the React Compiler infra).

**Sed batch:** one-shot regex bump on each workspace's package.json
for both `"vite"` and `"@vitejs/plugin-react"` lines.

### Resolution surgery — root vite + override

First reinstall after the workspace bumps left a stale `vite@5.4.21`
at the ROOT level marked `"peer": true` — npm's peer-resolution
algorithm picked the lowest-compatible version for plugin-react's
peer (range `^4 || ^5 || ^6 || ^7 || ^8`) and ran with it. Even
after deleting package-lock.json + reinstalling. The npm audit
kept reporting esbuild via vite 5.

**Fix**:
1. Added a `vite: ^8.0.0` override to root package.json's
   `overrides` block — alongside the existing `@mapbox/node-pre-gyp`
   + `tar` overrides from S237.
2. Override alone wasn't enough — npm still kept vite 5 at root.
3. Added vite as a **direct devDep at root level** (`vite: ^8.0.0`).
   This forced npm's tree resolver to put a vite version at root,
   and the peer-fallback path stopped resolving to 5.x.
4. Deleted package-lock.json + ran `npm install` to fully
   regenerate. Result: 1 vite version (8.0.11) shared across all
   9 workspaces via dedupe.

`npm ls vite` now shows every workspace pulling `vite@8.0.11
deduped`, with the root tree showing one canonical 8.0.11.

### Build verification

All 9 frontends build clean under vite 8 + plugin-react 5.2.0:

| Workspace | Build time |
|---|---|
| landlord    | 710ms |
| tenant      | 244ms |
| admin       | 234ms |
| pm-company  | 225ms |
| admin-ops   | 212ms |
| books       | 202ms |
| pos         | 164ms |
| property-intel | 155ms |
| listings    | 118ms |

Vite 8 uses Rolldown (Rust-based bundler) under the hood — build
times dropped roughly 5× from vite 5 (the same landlord build was
~2.2s under vite 5 in S233/235 handoffs). No config changes
required for the migration since GAM's vite configs were already
minimal (just `react()` plugin + optional alias + `server.port`).

## Files touched (S238)

```
package.json                          (+ vite ^8.0.0 in devDeps,
                                       + vite ^8.0.0 in overrides)
package-lock.json                     (regenerated, single vite 8.0.11)
apps/admin/package.json                (5→8, plugin-react 4→5.2)
apps/admin-ops/package.json            (5→8, plugin-react 4→5.2)
apps/books/package.json                (5→8, plugin-react 4→5.2)
apps/landlord/package.json             (5→8, plugin-react 4→5.2)
apps/listings/package.json             (5→8, plugin-react 4→5.2)
apps/pm-company/package.json           (5→8, plugin-react 4→5.2)
apps/pos/package.json                  (5→8, plugin-react 4→5.2)
apps/property-intel/package.json       (5→8, plugin-react 4→5.2)
apps/tenant/package.json               (5→8, plugin-react 4→5.2)

DEFERRED.md                            (~ npm audit section: esbuild item
                                         closed, only pdfjs-dist remains)
SESSION_238_HANDOFF.md                 (new)
```

No code changes. No migrations.

## Verification

- `npm audit` → 1 vuln (pdfjs-dist remains; was 3 pre-S238)
- `cd apps/api && npx tsc --noEmit` → clean
- `npm run schema:diff` → unchanged (only pre-launch Flex Suite phantoms)
- 9/9 frontend `npx tsc --noEmit && npx vite build` → clean

## Decisions made (S238)

| Question | Decision |
|---|---|
| plugin-react 4.x → 5.x or 6.x? | 5.2.0. The 6.x version requires `babel-plugin-react-compiler` + `@rolldown/plugin-babel` as peers — adding React Compiler infra is its own session-sized integration with non-trivial implications (memo behavior, dev-server behavior, Babel toolchain). 5.2.0 covers vite 4–8 without that constraint. |
| Why did the override + workspace bump leave vite 5 at root? | npm's peer-fallback installer puts a copy of a peer-required package at the root when no direct ancestor satisfies the peer. Adding vite as a root devDep gave the resolver a concrete target. The override alone wasn't enough because peer fallback runs in a different code path. |
| Should the root vite devDep stay long-term? | Yes. Root-level vite functions as the deduplication anchor — without it, future upgrades (vite 9, 10…) will replay the same peer-fallback issue. The override + root devDep together are the durable fix. |
| Touch the per-app vite.config.ts files? | No. All 9 configs are minimal (plugin-react + optional alias + `server.port` strict-port) and use APIs that haven't changed across vite 5–8. No edits needed. |
| Verify dev server runtime, or just build? | Build only. Per CLAUDE.md "No smoke walks unless Nic initiates" — dev-server smoke is a Nic-runs step. The build artifacts are clean across all 9; runtime smoke happens when Nic runs `dev.sh`. |
| Take on pdfjs-dist 3→5 in the same session? | No. The S237/S233 handoffs both flag it as needing apps/api ESM migration first — a structural refactor (CJS+tsx → ESM) that touches every API import and the migrate.ts runner. Multi-session work that doesn't fit alongside a frontend dep bump. |

## Carry-forward — S239+

DEFERRED post-S238:

**Open — pickable:**
- POS receipt printing (hardware adapter selection blocks)
- POS multi-terminal session sync (probably premature)
- /resolve smoke (testing)
- POS end-to-end smoke (testing)

Same shape as S237 — bench remains dry of pure code-work items.

**npm audit:**
- pdfjs-dist (high) — pinned at 3.x; v4+ is ESM-only and apps/api
  is CJS+tsx. Upgrade requires apps/api ESM migration. Stays parked.

**Multi-session epics:** Flex Suite (launch-flag gated), Sublease
(greenfield, needs spec), F1 Marketing rebuild (needs direction).

**Pre-launch flag-gated:** OTP UI surface, tenant-pool refinements.

## Revised count

S238 closed 1 npm audit item (esbuild via vite 5→8).

| Bucket | Pre-S238 | Post-S238 |
|---|---|---|
| Pickable now | ~4 | ~4 |
| Nic-blocked | 5 | 5 |
| External-vendor-blocked | 1 | 1 |
| Multi-session epics | 3 | 3 |
| npm audit | 2 | 1 |
| Pre-launch flag-gated | 2 | 2 |

**Until v1 launch-ready:** ~9 sessions → ~8.

---

End of S238 handoff.

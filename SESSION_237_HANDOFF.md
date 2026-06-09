# Session 237 — closed

## Theme

The bench was effectively exhausted of pure code items after S236
(remaining "Open" entries are all hardware-blocked, testing, or
Nic-product-blocked). Pivoted to npm audit cleanup. Closed 2 of the
4 listed audit items; the remaining 2 still need breaking-version
jumps (vite 5→8 and pdfjs-dist v3→v5 with apps/api ESM migration
first), staying parked.

## Items shipped — npm audit pass

Pre-S237 audit baseline was 6 vulns (was 9 at S96). State drifted
since S96 — newer items appeared, some auto-fixable.

### 1. fast-uri (high) — auto-fix

Single `npm audit fix` call from the repo root resolved it. No
breaking changes; transitive bump.

### 2. tar (high) — override + lockfile regen

The complicated one. `tar@6.2.1` was flagged via the chain:
`pdfjs-dist@3 → canvas (optional) → @mapbox/node-pre-gyp@1.0.11
→ tar@^6.1.11`.

**Phantom dependency.** `canvas` is marked `"optional": true` and
fails to build on most systems (needs Cairo/Pango via Homebrew). The
node_modules check confirms canvas was never actually installed
anywhere in the workspace (`node_modules/@mapbox/` was an empty
directory; `node_modules/canvas` doesn't exist). The lockfile still
described the chain as if it were installed, which is what made
audit pick it up.

The actual canvas-equivalent the code uses is `@napi-rs/canvas`
(Rust+napi prebuilts via the comment header in `apps/api/src/lib/pdfText.ts:21-23`)
— a different package, not subject to this chain.

**Fix**: added `overrides` to the root package.json:
```json
"overrides": {
  "@mapbox/node-pre-gyp": "^2.0.0",
  "tar": "^7.5.15"
}
```

`@mapbox/node-pre-gyp@2.x` requires `tar@^7.4.3`; tar 7.5.15 is the
current latest (7.5.10 was the upper bound on the most recent
advisory, GHSA-r6q2-hw4h-h46w, which was the binding constraint).

Deleted package-lock.json + ran `npm install` to fully regenerate
the dependency tree. All workspaces re-resolved against the
overrides cleanly. Three workspace builds + typecheck all clean
post-regen.

### 3. uuid — drift-out (not present in current audit)

The S96 carry-forward listed `uuid` as an open item ("buffer-overrun
in code paths we don't hit"). Current audit doesn't flag uuid at
all — either the advisory expired or a transitive bump elsewhere
resolved the constraint. Removed from the open list.

## What's still flagged (3 vulns remaining — all breaking)

- **esbuild** (moderate, dev-server vector via vite) — needs vite
  5→8 (three major-version jump). Vite is critical to all 5 frontend
  workspaces. Out of scope here.
- **pdfjs-dist** (high, malicious-PDF JS execution) — pinned at
  3.11.174 in apps/api per the explicit comment header in
  `lib/pdfText.ts:14-16`. Upgrade to v4+ requires apps/api → ESM
  migration first; v4 is ESM-only and apps/api is CJS+tsx. Multi-
  session work.

Both stay in DEFERRED.

## Files touched (S237)

```
package.json              (+ "overrides" block: @mapbox/node-pre-gyp 2.x,
                            tar 7.5.15)
package-lock.json         (regenerated from scratch — full dep
                            tree resolved against new overrides)
DEFERRED.md               (~ npm audit section: 2 of 4 closed,
                            uuid drifted out, 2 remain open)
SESSION_237_HANDOFF.md    (new)
```

No code changes. No migrations.

## Verification

- `npm audit` → 3 vulns (was 6 pre-S237; was 5 after the auto-fix
  step before overrides; was 9 at S96)
- `cd apps/api && npx tsc --noEmit` → clean
- `cd apps/landlord && npx tsc --noEmit && npx vite build` → clean
  (2.19s)
- `cd apps/tenant && npx tsc --noEmit && npx vite build` → clean
  (1.25s)

## Decisions made (S237)

| Question | Decision |
|---|---|
| The tar chain ran through optional `canvas` that's never installed — fix the lockfile manually or use overrides? | Overrides. Manual lockfile surgery doesn't survive `npm install`; overrides are declarative + persist. The override forces @mapbox/node-pre-gyp to 2.x (which uses tar 7+) regardless of canvas being installed. |
| Force tar to 7.4.3 (oldest non-vulnerable) or latest 7.5.15? | Latest 7.5.15. The most-recent advisory (GHSA-r6q2-hw4h-h46w, macOS APFS race) was vulnerable through 7.5.10. 7.5.11+ is required, and within 7.5.x there's no breaking change between 7.5.11 and 7.5.15. |
| Delete package-lock.json or run `npm install` and hope it picks up overrides? | Delete it. Ran `npm install` after just adding overrides → tar stayed 6.2.1 in the existing lockfile. Lockfile regen forced full re-resolve and the new override propagated correctly. |
| Touch the breaking items (vite 5→8, pdfjs-dist 3→5) in this session? | No. Both are multi-session epics: vite 5→8 spans 5 frontends + dev/build configs; pdfjs-dist requires apps/api ESM migration which is a separate larger refactor. Leaving them as the carryforward was always correct. |
| Re-audit deeper (run audit on each workspace separately)? | No. The root audit covers transitive deps across workspaces. Per-workspace audits would surface the same items with workspace-prefixed paths but no different findings — checked apps/api/node_modules/pdfjs-dist already shows up with that path in the root audit. |

## Carry-forward — S238+

DEFERRED post-S237:

**Open — pickable:**
- POS receipt printing (hardware adapter selection blocks)
- POS multi-terminal session sync (likely premature)
- /resolve smoke (testing)
- POS end-to-end smoke (testing)

The bench is effectively dry of pure code-work items at this point.
Remaining sessions should focus on:
- The 2 remaining npm audit items when capacity allows
- Multi-session epics (Flex Suite, Sublease, F1 Marketing rebuild)
- Items unblocked by future Nic product calls (utility_bills cycle
  vs. add-on; deposit-interest netting under destination charges;
  pos_tax_rates stacking; marketing AZ-copy direction)

## Revised count

S237 closed 2 npm audit items + dropped 1 stale entry (uuid).

| Bucket | Pre-S237 | Post-S237 |
|---|---|---|
| Pickable now | ~4 | ~4 (all hardware/testing/Nic-blocked) |
| Nic-blocked | 5 | 5 |
| External-vendor-blocked | 1 | 1 |
| Multi-session epics | 3 | 3 |
| npm audit | 4 | 2 |
| Pre-launch flag-gated | 2 | 2 |

**Until v1 launch-ready:** ~10 sessions → ~9 (assumes the 2
remaining npm audit items count + the multi-session epics).

---

End of S237 handoff.

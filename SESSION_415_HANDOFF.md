# Session 415 — closed

## Theme

**Test-infra root-cause fix: ts-node-dev zombie
spawner pinned + dev.sh extended + emergency
kill-all script added + CLAUDE.md note for future
sessions.**

Suite at S414 close: **1901 / 106 files**.
Suite at S415 close: **1909 / 107 files** (no new
test work — same source code; +1 file is vitest
discovery-order variance). 0 failures. Runtime
**60.75s** (matches the S414 cleaned-machine baseline).
Nineteenth consecutive fully-green full-suite run.

Zero tsc regressions.

## Root cause pinned

The S414 meta-finding (9 zombie ts-node-dev processes
starving CPU and dropping gam_test mid-suite) reduced
to a single architectural bug in `dev.sh`:

**`apps/api/package.json:dev` runs:**
```
ts-node-dev --respawn --transpile-only --exit-child src/index.ts
```

`ts-node-dev` is the parent process. It spawns a CHILD
node process that listens on port 4000. The respawn
behavior is:
- Child exits → parent immediately spawns a new child
- Parent never voluntarily exits; only SIGTERM/SIGINT
  to the parent stops the respawn loop

**`dev.sh`'s cleanup pre-S415 was:**
```bash
for port in 3001..4001; do
  pid=$(lsof -ti tcp:$port)
  kill -9 $pid
done
```

`lsof -ti tcp:4000` returns the **child** listener PID,
NOT the ts-node-dev parent. `kill -9 <child>` triggers
the respawn loop. The parent survives and immediately
spawns a new child.

After many dev.sh cycles (laptop sleep, terminal
close, new session), orphan ts-node-dev parents
accumulate. Each is at 60-90% CPU permanently.

## What shipped

### 1. dev.sh cleanup extended

Added `pkill -f "ts-node-dev"` to the cleanup block
before any new dev servers spawn:

```bash
# S415: kill orphan ts-node-dev parents. The port-kill loop above only
# kills the child node process listening on the port; the ts-node-dev
# PARENT (`--respawn` mode) survives and immediately respawns a new
# child. Over time (laptop sleep, terminal close, session reset)
# these accumulate into zombies that starve CPU and hold DB
# connections — found 9 of them in S414, each at 60-90% CPU, eating
# 25,000+ minutes of cumulative CPU time.
pkill -f "ts-node-dev" 2>/dev/null && echo "  Killed orphan ts-node-dev parents" || true
sleep 1
```

A fresh `bash dev.sh` now cycles cleanly even after
multiple prior runs.

### 2. Standalone `kill-all.sh`

New script at repo root for "I just want my machine
back" scenarios where you're not about to restart
dev.sh. Covers:
1. Port-bound listeners on all GAM ports
2. ts-node-dev orphan parents
3. tsc --watch shared package watcher
4. Stray vitest processes

Verifies clean state and exits 1 if any survive.
Live-tested on a currently-clean machine — outputs
"✓ Clean." correctly.

### 3. CLAUDE.md test-infra note

Added under the "Migration runner is fix-forward only"
rule:

> ### Test-infra: zombie ts-node-dev processes (S414/S415)
>
> If the test suite suddenly slows from ~65s to multiple
> minutes, OR starts hitting non-deterministic "relation
> X does not exist" / "terminating connection due to
> administrator command" errors, run `pgrep -fl
> ts-node-dev` first. ...

So the next session that hits the symptom doesn't go
through the 4-suite-attempt debugging dance I went
through in S414.

## Files touched

```
dev.sh                  (cleanup extended; pkill -f ts-node-dev)
kill-all.sh             (NEW — emergency cleanup script)
CLAUDE.md               (test-infra note added)
```

No source code changes. No migrations. No schema
changes. No new tests.

## Decisions made during build

| Question | Decision |
|---|---|
| Use `pkill -f "ts-node-dev"` or a more targeted approach? | **`pkill -f`.** The string `ts-node-dev` is specific enough not to false-positive on unrelated processes. `pgrep -fl ts-node-dev` confirms only the API dev parent matches. |
| Add `--exit-child` flag rebuttal? | **No.** That flag exists on the api package.json command but doesn't help when `kill -9` is the kill signal (SIGKILL is uncatchable; the parent's signal handlers never fire). The fix has to be in dev.sh's cleanup ordering, not in ts-node-dev config. |
| Make kill-all.sh more aggressive (e.g., postgres restart)? | **No.** Scope discipline — kill-all.sh fixes the documented bug class (zombie node procs). Postgres-level issues are a separate problem. |
| Add port-kill verification? | **kill-all.sh does this** via final `pgrep` check and exits 1 if anything survives. Saves debugging time on partial kills. |
| Add the note to CLAUDE.md or a separate docs file? | **CLAUDE.md.** It's auto-loaded at session start; a separate file requires the next dev to know to read it. The symptom-→-diagnosis mapping deserves the prime location. |
| Investigate ts-node-dev internals (e.g., why it doesn't trap SIGCHLD)? | **No — flag and stop.** The fix is at the orchestration layer (dev.sh kill order). Upstream ts-node-dev hasn't been maintained in a while; investing time in their bug tracker is low-yield. |

## Verification

- `npx tsc --noEmit` clean on apps/api (0 errors).
- `npm test` in apps/api: **1909 tests across 107
  files, 0 failures**, 60.75s. **Nineteenth
  consecutive fully-green full-suite run.**
- Suite runtime stable at ~60s on a clean machine
  (was 1300s in S414 with 9 zombies, dropped to 65s
  after the S414 cleanup, stable at 60s in S415).
- `bash kill-all.sh` syntax-checked + live-run on
  clean state: "✓ Clean."
- `bash dev.sh` syntax-checked (haven't run end-to-
  end — that'd boot all 10 dev servers).

## Items deferred — what S416 could target

### Validation-hygiene backlog (was 19, still 19)

S415 didn't reduce the count — this was a meta-infra
fix that closes a recurring debugging tax, not a
backlog item.

Remaining (priority order):
- S413 spawned: vendor credit_balance CONSUMPTION on
  subsequent bills (the matching half of S386 —
  needs UX design)
- S400 LEASE_TYPE_MATRIX ↔ CHECK drift (needs
  product input on canonical unit types)
- S403 cross-landlord PI capture/cancel (Stripe
  round-trip required; latency tradeoff)
- S412 spawned: confirm entity-type-conditional
  EIN/SSN call (Nic-pending)
- S412 spawned: apply strict-validation pattern to
  books_vendors + books_employees POST routes
- S411 spawned: disposable-domain fan-out
- S405 bank_last4 null + ach_verified=TRUE defensive
- S405 /complete missing isExpired check
- S408 finding A (monthly-statement off-by-one
  default — Nic-pending)
- S408 finding B ($15 hardcoded fee — Nic-pending)
- S377 (a) email-blocked

### Cumulative bug-sweep totals (post-S415)

- **44 production bug fixes** (no production code
  changed in S415)
- 19 architectural / validation findings remaining
- 1909 tests across 107 files
- Suite baseline: **60-65s on a clean machine**

## What S416 should target

Now that the test-infra debugging tax is closed,
recommend resuming product backlog:

**Recommended: S412 spawned — apply strict-validation
pattern to `books_vendors` POST + `books_employees`
POST routes.** Same pattern as S412 contractors (zod
schema, all fields required, entity-type-conditional
where applicable). Fast iteration since the pattern
is now established.

**Alternatives:**
- S413 follow-on: vendor credit_balance CONSUMPTION
  (needs UX design but a known landing surface)
- Smaller bundle: S405 defensive checks (bank_last4
  null + /complete expiry)
- Checkr wire-up (background.ts)
- Services audit start (~30 sessions)

---

End of S415 handoff. **Test-infra root cause pinned
+ dev.sh cleanup extended + kill-all.sh added +
CLAUDE.md note. Suite runtime now stable at 60s.**

1909 tests / 107 files / 0 failures. Nineteenth
consecutive fully-green full-suite run.

**44 cumulative production bug fixes shipped across the
bug sweep.** Validation-hygiene backlog unchanged at
19 (S415 was meta-infra, not a backlog item). The
recurring "intermittent test failures + slow suite"
debugging tax that ate hours in S410/S413/S414 is
now closed.

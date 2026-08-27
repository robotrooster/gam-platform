# SESSION 625 HANDOFF

End of S624. 22 commits. Supersedes SESSION_623_HANDOFF.md.

Nic is asleep. He asked for an overnight session: keep testing, keep fixing,
rinse and repeat until the agents are 100%. Read §0 before you run anything.

---

## 0. START HERE — YOU CAN TAKE THIS MACHINE DOWN, AND NOBODY IS AWAKE

**The Mac Studio kernel-panicked TWICE today, both times from agent-eval load.**

```
panic(cpu 9): "completeMemory() prepare count underflow" @IOGPUMemory.cpp:550
```

A GPU memory refcount bug in macOS, surfaced by continuous Metal allocation from
the 36B model. Apple's bug that userspace can panic the kernel — but the trigger
was running evals back-to-back for hours.

**That machine also runs the production API and Postgres.** After the second
panic Postgres did not come back (stale `postmaster.pid`, PID recycled to a macOS
speech service) and **the production database was down for 11 minutes** while
`/health` cheerfully returned 200.

### The rules. These are not suggestions.

1. **NEVER run the eval unpaced.** `AGENT_EVAL_PAUSE_MS` defaults to 3000; use
   **5000** overnight. The suite is already sequential — the problem is CADENCE,
   not concurrency.
2. **Run in BLOCKS, not the whole suite.** `agents:eval t-` then `agents:eval
   l-,g-,p-`. Never chain them without a gap.
3. **ONE model job at a time.** Never an eval and a smoke test together, never an
   eval and auto-place together. Auto-place drives the same GPU.
4. **Check `uptime` between blocks.** It sat at 1.8–2.2 all evening once paced.
   If load climbs past ~6 and stays there, stop and wait.
5. **If it panics anyway: STOP DOING GPU WORK FOR THE NIGHT.** Verify Postgres is
   up (§6), verify the crons re-registered, write down what you were doing, and
   spend the rest of the night on the non-GPU list in §4. Do not "just try once
   more". That is exactly what I did after the first panic, and it panicked again.

The watchdog now recovers Postgres by itself (§5), so a crash is survivable —
but a crash loop with nobody awake is not.

---

## 1. WHAT IS LIVE IN PRODUCTION RIGHT NOW

Deployed 14:04 today, verified. The API `dist` is from **13:55**.

- **Work trade pays for the month you are living in.** Invoice issues GROSS and
  `late_fee_exempt`, month-close settles it from that month's own hours,
  shortfall carries in HOURS, surplus banks uncapped, a carried hour keeps its
  own month's frozen rate, leniency is per-agreement (`carry_forward_months`).
- **Manual-payment fee is $6.00 — identical to ACH.** Both published Terms and
  the landlord KB updated. `payments.test.ts` asserts `by.manual.total ===
  by.ach.total`; if that ever fails, parity has silently broken.
- **Bank-deposit matching** — match a deposit to the rent it paid, backdated to
  when the money actually moved, with late fees reversed. Tenant can report
  their own deposit ("I paid at the bank").
- **Screening gate fixed.** Every landlord created after the S623 backfill had
  `migration_window_ends_at` NULL, and the gate read NULL as "window open
  forever" — so screening was silently OFF for all of them.
- **Per-state property timezones.** Was `America/Phoenix` for everything; a North
  Carolina property was billing on Arizona time.
- **`deploy.sh` gates on the test suite** and refuses to ship red.

## 2. COMMITTED BUT **NOT** DEPLOYED

Everything from `78da03e` onward — all the agent work. The live API predates:

- the legal-dispute escalation fix (a tenant announcing legal action currently
  gets a **balance lookup instead of a human**)
- the forced money handoff
- the bot-probe fix
- the lead-capture net and repetition guard
- `get_money_in_flight`, `get_unreconciled_cash`, `get_work_trade_status`,
  `get_work_trade_standing`

**Nic must not send portal invites until this deploys.** `bash deploy.sh` runs
the suite first (~8 min) — that is expected, not a hang.

---

## 3. THE AGENT WORK — WHERE IT LANDED

**Graded eval: 45/45.** Baseline in
`apps/api/src/services/agents/EVAL_BASELINE.json`.

### How to read the number (this cost real work today)

- The eval is **seeded** (`AGENT_SAMPLER_SEED=424242`, set by `agentEval.ts`).
  Agents sample at `temperature: 0.6`; unseeded, the suite swung **42 → 36 on a
  byte-identical file** with one failing case in common.
- **Do not lower the temperature.** `HERMES_SAMPLER_DEFAULTS` is deliberately
  non-greedy because Hermes degenerates into looping when sampled greedily, and
  the comment above it says so.
- **One seeded run is ONE DRAW.** It makes a change comparable before and after.
  It is not a grade.
- **A chunked run is not comparable to a single run** — the seed is per process.

I reverted a batch of Nic's review work over a 4-point "regression" that was
noise. Do not repeat that. If a score moves, re-run the SAME way before
concluding anything.

### The pattern that matters

Six problems were fixed to reach 45/45. **Four were guards or assertions
punishing CORRECT behaviour**, not agents being wrong:

| What looked broken | What was actually broken |
|---|---|
| Agents "dodging" the are-you-a-bot question | The tool-demand net suppressed the honest answer and substituted "which booking do you mean?" |
| A tenant announcing legal action not escalating | The anti-over-escalation net **cancelled** it — it saw "deposit" and decided a tool could answer |
| Lucy "claiming to be human" | The assertion forbade the substring "real person", catching an honest offer to *fetch* one |
| The agent picking the "wrong" portfolio tool | Two tools answer that question equally well |

Two were genuine: a prospect's lead never saved (with 50 repeats of the same
sentence and no repetition guard anywhere), and a money dispute that could be
declined all the way through to a bot answering "where is my money?".

**Read the WARN lines before theorising.** The bot-probe cause was printed in the
log for hours and I "fixed" it twice without reading it.

---

## 4. WHAT TO DO TONIGHT, IN ORDER

### 4a. The two-turn transcripts — THE MAIN EVENT
`AGENT_TWO_TURN_REVIEW.md` holds Nic's own verdicts on 19 two-turn
conversations: **5/19 clean, 11 need work, 6 he had originally scored wrong.**
All 13 fixes are in but **have never been run in conversation**.

```
DB_NAME=gam npx ts-node src/services/agents/agentConversations.ts          # all
DB_NAME=gam npx ts-node src/services/agents/agentConversations.ts guest    # one audience
```

**RUN IT ONE AUDIENCE AT A TIME** — it drives the same 36B. Its own header says
"RUN IT ALONE — two loads on the 36B kills it."

Grade it the way Nic does: not "did it call the right tool" but **would a person
walk away with the right idea?** His complaint that started this was answers
marked correct that were misleading. The reverse is just as common (§3).

The repeat bug was 5 of the 19. Check it is gone.

### 4b. Verify, then re-verify what you change
After any prompt/tool/KB edit: `bash apps/api/scripts/check-agent-eval.sh`
(paced, compares to baseline, refuses to call a regression a pass).

**Prompt length costs tool selection.** Prefer fixing a TOOL DESCRIPTION over
adding prompt text. `profiles.ts` grew 16% today and I could not prove it was
free.

### 4c. Non-GPU work — do this if anything panics
- **Documents tab has no upload path** (`LAUNCH.md §2c`). Nic wants property
  notices and hand-delivered paperwork filed on the platform. Every document
  path assumes a signing flow; this is a filing cabinet. Open design question:
  per-property or per-landlord? His phrasing points at per-property.
- Full test suite: `cd apps/api && DB_NAME=gam_test npx vitest run` (337 files /
  5568 tests green at handoff, ~8 min, no GPU).

### 4d. DO NOT do these without Nic
- **Do not run auto-place on the lease templates.** See §7 — there is an open
  question only he can answer, and it is GPU work.
- **Do not deploy** unless the suite is green and you are confident. He was
  explicit that portal invites wait for a deploy, but he did not authorise one
  overnight.
- **Do not touch the ACH fee schedule.** $6 flat is ironclad revenue. Standing
  directive.

---

## 5. THINGS THAT WILL BITE YOU

- **`/health` now hits the database** and returns 503 if it cannot. It used to
  return 200 unconditionally, which is how an 11-minute outage went unnoticed.
- **The watchdog now recovers Postgres** — clears a stale pid file, but ONLY
  after proving no postmaster is running, then restarts and waits. It exits
  non-zero if it cannot. Never delete `postmaster.pid` while a postmaster is
  running: two postmasters on one data directory is far worse than downtime.
- **`payments` has no `updated_at` column.** Cost me a runtime bug. Payment
  timing comes from `tenant_remittances.created_at` via `remittance_applications`.
- **`leases` has no `tenant_id`.** Tenancy is `lease_tenants` (role='primary').
- **The API camelizes every response.** A snake_case read in a frontend is
  silently `undefined`. `wireContract.test.ts` guards it and caught three of mine.
- **Never run vitest without `DB_NAME=gam_test`** — it truncates the live DB.
- **Re-ingest after ANY knowledge edit:** `npm run agents:ingest` (226+ chunks).
- **A billing/pricing change leaves stale PROSE everywhere.** Today: the tenant
  work-trade page, both work-trade KB articles, and the tenant fee article were
  all wrong after the model changed. Tests guard behaviour; nothing guards
  explanations. Chase UI copy, agent KB, and published Terms every time.

---

## 6. AFTER A CRASH — RECOVERY CHECKLIST

```bash
uptime                                    # confirm the reboot
launchctl list | grep com.gam             # services (tunnel exit=1 at boot is fine)
psql -d gam -tAc "select count(*) from payments;"   # DB reachable?
```

If Postgres is refusing to start with `lock file "postmaster.pid" already
exists`: check the claimed PID is **not** a postgres process (after a reboot it
is usually something unrelated), then
`rm /opt/homebrew/var/postgresql@16/postmaster.pid` and
`brew services restart postgresql@16`. The watchdog does this itself within 5
minutes now.

Then confirm the crons re-registered — **September rent depends on it**:
```bash
grep -oE '✓ [A-Za-z][^"]*' /tmp/gam-api.log | sort -u | grep -iE "invoice|late|autopay"
```
Expect "2 timezone(s) registered" — Phoenix and New_York.

---

## 7. OAK PARK — THE LAUNCH BLOCKER, AND A QUESTION FOR NIC

Nic uploaded the missing templates tonight. Current state:

```
apartment    8p   67 fields   INACTIVE   <- the S622/S623 work
apartment   23p    0 fields   ACTIVE     <- new upload
mobile_home  9p    0 fields   INACTIVE   <- duplicate
mobile_home 10p    0 fields   ACTIVE
rv_spot      8p    0 fields   ACTIVE
```

**All three active templates have ZERO fields.** An apartment lease sent right
now goes out blank. The 67-field version — the term election, the late-fee prose
detection, the conditional carpet fee, the deliberate screening-fee exclusion —
is deactivated.

The 23-page apartment has the **same 26 underscore blanks and 6 slash-dates** as
the 8-page one, so it is very likely the same lease plus ~15 pages of addenda.
But that is inference. **Ask him before auto-placing anything**: is the 23-page
document meant to replace the 8-page one, and is the 10-page mobile home the
right file (there are two)?

Good news from detection (no GPU needed, already run): all three have real text
layers with detectable blanks — 26/44/44. No AcroForm problem, no scanned-image
problem. Auto-place will work when he confirms.

---

## 8. COMMANDS

```bash
bash deploy.sh                                        # tests, then every surface
cd apps/api && DB_NAME=gam_test npx vitest run        # NEVER without DB_NAME
bash apps/api/scripts/check-agent-eval.sh             # paced eval vs baseline
cd apps/api && AGENT_EVAL_PAUSE_MS=5000 npm run agents:eval -- "t-"
cd apps/api && npm run agents:ingest                  # after ANY knowledge edit
DB_NAME=gam npx ts-node src/services/agents/agentConversations.ts guest
npm run db:dump-schema --prefix apps/api              # after ANY migration
```

Agent smoke against a real actor (one at a time):
```bash
cd apps/api && SMOKE_ROLE=tenant \
  SMOKE_USER_ID=df3dde44-689a-4515-94e4-5fc1cda6c88a \
  SMOKE_PROFILE_ID=0bf83f4b-157b-4001-88ec-b9d8bb689af2 \
  node -r ts-node/register src/services/agents/sessionSmoke.ts "your question"
```

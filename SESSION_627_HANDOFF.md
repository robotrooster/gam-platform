# SESSION 627 HANDOFF

End of S626. 31 commits, **NOTHING DEPLOYED**, full suite green (5825/5825).
Supersedes SESSION_625_HANDOFF.md.

**The job is one thing: close the gap between what a landlord or tenant can do
in their portal and what their agent can do for them. Do not stop to ask. Do
not write plans. Add capability, prove it green, commit, repeat.**

---

## 0. RULES THAT ARE NOT NEGOTIABLE

**GPU WORK IS DISABLED.** `apps/api/scripts/gpu-gate.sh acquire` exits 3. The
Mac Studio kernel-panicked FIVE times (2026-08-26 ×2, 2026-08-27 ×3) with
`completeMemory() prepare count underflow` @IOGPUMemory.cpp:550, every time
under sustained 36B inference. Two of those were mine, mid-run.

The pacing gate I wrote did not prevent the last one and the reason matters:
I built it for churn BETWEEN jobs, but both panics happened DURING a single
sustained run. One eval is ~26 minutes of continuous inference and the machine
died at seventeen. **Idle gaps cannot protect a job longer than the box
survives.** Re-enable only with a deliberate `GPU_GATE_OVERRIDE=1`, and only if
Nic says so.

**What this costs:** `agentConversations.ts` and `agents:eval` cannot be run.
Everything below is verified by the unit suite instead.

**What IS safe:** the embeddings service — `bge-large-en-v1.5`, 335M,
encoder-only on :8081. 87 queries took under a minute and left load unchanged.
`retrievalGaps.ts` uses it and never touches the 36B.

**COMMIT ONLY ON GREEN.** Chain with `&&`, never `;` — I shipped two red
commits today because the commit ran regardless of what the suite said:

```bash
cd ~/gam/apps/api && DB_NAME=gam_test npx vitest run > /tmp/s.log 2>&1 && { cd ~/gam && git add -A && git commit -F - <<'EOF'
...
EOF
} || { echo RED; grep -E "^ FAIL" /tmp/s.log | head; }
```

**NEVER run vitest without `DB_NAME=gam_test`** — it truncates the live `gam` DB.
**NEVER run two vitest processes at once** — `globalSetup` DROPs and recreates
`gam_test`, so a second run pulls the database out from under the first. That
produced 224 phantom failures across unrelated files and cost an hour.

---

## 1. THE ARCHITECTURE — READ THIS BEFORE ADDING ANYTHING

An agent action does **not** reimplement an endpoint. It CALLS it over loopback
with the caller's own claims, and every middleware runs for real: `requireAuth`,
`requirePerm`, scope checks, zod validation, the rate limiter.

Writing 243 bespoke tools would mean 243 second copies of route logic — and
route logic is where the eviction pauses, fee waivers and ownership checks live.
A copy that drifts on one of those is worse than no tool.

```
services/agents/portalActions.ts      the ALLOWLIST — what may be done
services/agents/portalDispatch.ts     mints a 60s token, calls the real endpoint
services/agents/tools/portalActionTools.ts   generates one AgentTool per entry
```

**Safety, all of it tested:**
- Claims are the caller's own, forwarded from `routes/agent.ts` (`actor.auth`).
  Authentication is not skipped — `requireAuth` already ran, this is its output.
  What it preserves is AUTHORIZATION: `requirePerm` reads
  `req.user.permissions`, and without it a staff member's agent is denied
  everything their portal allows.
- The token lives 60s and carries those claims and nothing added. It cannot
  widen authority, only exercise it. `portalDispatch.test.ts` decodes and asserts.
- **The allowlist is the enforcement of "nothing irrelevant to our software."**
  An action not in it cannot be reached by any wording or anything smuggled into
  a tenant's message — the dispatcher refuses before a request is built.
- Fails closed: no claims / wrong audience / missing path param → nothing sent.
  Every refusal tells the agent, in words, not to claim it was done.

### Adding an action — the whole recipe

1. **Read the route's zod schema.** Do not guess parameters.
2. Add an entry to `PORTAL_ACTIONS` in `portalActions.ts`.
3. Add the id to the matching profiles in `profiles.ts` (there are TWO landlord
   and TWO tenant profiles — entry and escalation; `s.replace` hits both).
4. `npx tsc --noEmit -p tsconfig.json`
5. `DB_NAME=gam_test npx vitest run src/services/agents/`
6. Full suite, then commit.

`portalActionPaths.test.ts` resolves every entry against the real router mounts
AND the paths the route file declares, method included. It caught
`PATCH /api/units/:unitId` on its first run — that route does not exist, unit
edits are split into `/details`, `/status`, `/number`, `/type`. **The one thing
this architecture can still get wrong is the ADDRESS**, and that test is why it
can't ship.

### NEVER put these in the allowlist
- credentials: `auth`, `totp`, `emailOtp`, passwords, reset flows
- card or bank entry: `stripe`, `publicCardUpdate` — Stripe Elements only
- other portals: `admin`, `business*`, `pos`, `pm`, `platform`, public booking
- `subleases` / `subleaseInvitations` — shelved behind `subleasing_enabled=false`
- `appointments` — takes a `customerId`; business portal, not landlord

`actionParity.test.ts` fails if any of that appears in a landlord or tenant
profile, and ratchets the write-tool count (currently ≥41; raise as you go,
never lower — and **keep its WRITE verb regex in step**, or a new verb is
invisible and the ratchet silently stops measuring).

---

## 2. WHERE THE NUMBER IS

```
589  mutating endpoints total
174  admin / business / POS / public   siloed — not a gap
341  reachable by a landlord or tenant agent
 22  allowlisted dispatch actions
 46  write-capable tools total (was 17 this morning)
286  endpoints still with no agent action
```

Regenerate this list any time — it is a script, not a snapshot:

```bash
node apps/api/scripts/action-gap.js
```

Biggest first. Work top-down:

```
 36  landlords      settings, entities, onboarding, PM assignment
 28  tenants        INVITING A TENANT, transfers, waiving screening
 24  properties     add/edit, fee schedules, late-fee overrides
 23  books          bills, paying bills, vendors, accounts, payroll
 22  esign          templates, documents, addenda (send/void done)
 21  units          number, type, occupancy mode, subtype, utility responsibility
 20  leases         create/edit, rent components, fees, seasonal
 20  utility        meters, bill-back, tax rates (readings/runs done)
 16  background     ordering screening, adverse action, applicant pool
 12  maintenance-portal   worker side: costs, completion, media
  9  bankFeed       deposits confirm/not-rent, finalize, sync
  8  scopes         team permissions by property
  7  payments       (record-manual done via hand-built tool)
  6  credit         attestation, disputes
```

**`tenants` (28) contains the invite flow and it has ZERO TESTS** — 131 lines
creating users, minting invite tokens and sending email. Write characterisation
tests before touching it. Do not wrap it blind.

---

## 3. WHAT LANDED IN S626 AND WHY

Fixes are by CAUSE, not by case.

- **The repeat bug.** The guard against invented numbers was *generating* it —
  its correction opens "your last answer stated account-specific facts without
  fetching them" and nothing checked that it had. A tenant who declined got the
  $2,330 breakdown read at them twice. Tenant conversations 1/6 → 6/6.
- **No agent ever knew what today's date was.** Not the prompt, not the context
  block, not a tool — so they reasoned from a 2024 training prior and the
  booking agent proposed "September 2024", then 2025. Three lines fixed it.
- **"I'll file that" filed nothing.** No guard caught a promised ACTION, only a
  promised lookup. `promisesAnAction` closes it.
- **29 tools had no phrase route** and were reachable only by luck; one prompt
  change tipped three eval cases at once. Now 13, ratcheted.
- **`demandsAToolCall` exempted "can I reserve"** mid-sentence, so
  "what amenities can I reserve at my property?" never demanded a lookup and
  adding a route changed nothing. Anchored to the start.
- **The delinquency answer conflated three states.** In-flight money was
  reported as overdue on the single-tenant path, and RETURNED payments were
  missing from the tenant's own balance entirely — a bounced ACH dropped out as
  though paid. Now owed / returned / in-flight, reported separately.
- **The KB had no complaints article** despite `log_complaint` existing, and no
  P&L article — so a passed conversation contained an invented button label
  ("Add Expense"; it is "Log an expense"). Seven wrong retrievals corrected.
- **Six test assertions were wrong**, two demanding the exact defect they were
  written to catch.

Artifacts: [Two-Turn Transcripts](https://claude.ai/code/artifact/b66db29f-1a77-4529-b9b3-f4bde6a892e4)
(Nic's 19, annotated with what each does now) and
[Agent Action Parity](https://claude.ai/code/artifact/678ba785-8683-4839-bec0-dfbe619dda9a).

---

## 4. THE BAR

Nic, repeatedly: *"The agent is a personal assistant. Anything I could get on and
do as a landlord, I should be able to tell the agent to do. It needs to be the
Jarvis of our software. It cannot do anything that is not relevant to our
software."*

Grading is not "did it call the right tool". It is **would a person walk away
with the right idea.** Descriptions are where the product knowledge goes —
`report_bank_deposit` carries the timezone rule, `record_meter_reading` says the
value is the number on the dial and not the usage, `serve_non_renewal_notice`
says it is a legal notice and not a note.

Two features that both get called "the survey" and are NOT the same thing:
`surveys.*` is anonymous, property-wide, general. `leases.tenant_renewal_intent`
is named, per-lease, on a legal clock. Do not conflate them.

**Open question for Nic, not to be decided alone:** he described renewal as
tenant-first (ping at 60 days, landlord notified at 32). The code is
landlord-first — S562 gated the tenant's view on `landlord_renewal_offered_at` —
and there is NO scheduled 60-day tenant ping anywhere.

---

## 5. COMMANDS

```bash
cd ~/gam/apps/api && DB_NAME=gam_test npx vitest run          # ~4 min, must be green
DB_NAME=gam_test npx vitest run src/services/agents/          # fast loop, ~3 s
npx tsc --noEmit -p tsconfig.json
DB_NAME=gam npx ts-node src/services/agents/retrievalGaps.ts  # KB probe, SAFE (encoder only)
SHOW_TOP=1 DB_NAME=gam npx ts-node src/services/agents/retrievalGaps.ts   # + top article
EMBEDDINGS_ENDPOINT=http://localhost:8081/v1 EMBEDDINGS_MODEL=bge-large-en-v1.5 \
  DB_NAME=gam npx ts-node -T src/services/agents/ingestKnowledge.ts       # after ANY KB edit
```

KB articles need frontmatter (`--- scope / title ---`) or the ingester **silently
skips them** and still reports a healthy article count.

`bash deploy.sh` ships everything and gates on the suite. Nothing from S626 is
deployed; `HEAD` is a clean revert point.

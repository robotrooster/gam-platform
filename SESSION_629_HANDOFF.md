# SESSION 629 HANDOFF

End of S628. Supersedes SESSION_627_HANDOFF.md. **NOTHING DEPLOYED.**

The action gap is closed. Every mutating endpoint a landlord or tenant agent
could reach either HAS an agent action or is NAMED with the reason it does not.
That is asserted, not claimed — `actionGap.test.ts` fails if a new route lands
without a decision either way.

```
586  mutating endpoints on the API
328  reachable by a landlord or tenant agent   (was 341 — three more silos found)
228  the agent can do                          (was 98)
100  deliberately not agent actions, each with a stated reason
  0  unaccounted for
237  write tools across the four CS profiles   (was 41)
```

---

## 0. RULES THAT ARE NOT NEGOTIABLE

**GPU WORK IS DISABLED.** `apps/api/scripts/gpu-gate.sh acquire` exits 3. Five
kernel panics under sustained 36B inference. `agentConversations.ts` and
`agents:eval` CANNOT be run. Re-enable only with `GPU_GATE_OVERRIDE=1` and only
if Nic says so. Everything in S628 is verified by the unit suite and by reading
— **not one line of it has been watched in a real conversation.**

The embeddings service (`bge-large-en-v1.5`, encoder-only, :8081) is safe.
`retrievalGaps.ts` uses it and never touches the 36B.

**`gam` IS THE PRODUCTION DATABASE.** There is no separate one — verified this
session. The launchd prod API (`com.gam.api`) runs from `apps/api` with
`NODE_ENV=production` and loads the same `.env`, which says `DB_NAME=gam`,
`DB_HOST=localhost`. Two things follow that people get wrong:

- **NEVER run vitest without `DB_NAME=gam_test`.** It does not truncate "dev
  data", it truncates LIVE CUSTOMER DATA. The nightly `pg_dump` at 03:30 into
  `~/gam-backups` is the only net.
- **`npm run migrate` migrates production.** The S628 renewal migration is
  therefore ALREADY LIVE, applied the moment it ran locally.
  `deploy.sh` does not run migrations and does not need to — do not add a
  migration step expecting a separate prod database. Verified: both
  `leases.tenant_renewal_pinged_at` and `landlord_renewal_alerted_at` exist in
  `gam` now.

**NEVER run two vitest processes at once.** I did this today: started a full run
in the background, then ran the agents suite while it was going. `globalSetup`
DROPs and recreates `gam_test`, so the two runs pull the database out from under
each other. It produced a phantom FK violation in `cleanupAllSchema` that looked
like a real bug in `getMoneyInFlight`. **Before starting any vitest, check
`ps aux | grep -c "[v]itest"` is 1.**

**The full suite takes 25-40 minutes on this box**, not the 4 minutes the old
handoff said — the MLX server and the desktop app are eating cores. Plan around
it: batch work, run the fast agents suite (`~4s`) constantly, and run the full
one when you are ready to commit.

**COMMIT ONLY ON GREEN.** Chain with `&&`, never `;`.

---

## 1. WHAT TO DO NEXT — read this before picking anything

The obvious next move is **not** more actions. There are none left to add. The
three things that matter now, in order:

### (a) NOTHING HAS BEEN WATCHED

207 manifest actions and 30-odd hand-built tools, and the only evidence any of
them behave well is that the descriptions read correctly and the paths resolve.
The eval is the thing that would tell us, and it cannot run. Options, in order
of what I would do:

1. Ask Nic whether the 36B can be re-enabled for a bounded run, or whether a
   smaller model can drive `agents:eval` well enough to catch tool-choice
   errors. The failure modes I am most worried about are cheap to detect and
   expensive to leave: picking `migrate_existing_tenant` when the landlord
   meant `invite_tenant_to_sign_lease`, or `record_cash_payment` when they
   meant `record_prior_arrangement` (that one costs the tenant $6).
2. Failing that, write **dispatch-level tests**: drive `runAgentSession` with a
   real actor and a scripted transcript, assert which action id was dispatched.
   `gam-test-the-production-path` in memory says this is the only way that has
   ever caught a real defect. It does not need the 36B if the tool choice is
   stubbed — but then it tests the dispatcher, not the model.

### (b) THE KNOWLEDGE BASE — CHECKED, AND SMALLER THAN I FEARED

I flagged this as "the KB now tells people to go and do things the agent can do"
and then actually measured it rather than leaving you a vague sweep.

`retrievalGaps.ts` (GPU-safe, encoder only) reports **no retrieval gaps** — all
87 real questions ground on something. But that is the wrong probe for this
problem: it finds questions that return NOTHING, not articles that return
stale advice.

The right probe was a grep of all 80 articles for "go to / click / navigate to /
open the / head to". **Twelve instances, nine of them still correct** — they
cover things the agent must NOT do (signing a document, resetting a password,
connecting a bank), so the menu path is the right answer there.

Three were genuinely stale and are fixed in S628: filing a maintenance request,
paying rent by ACH each cycle, and setting up a neighbour utility space. In each
the menu path was KEPT and the assistant option put first — the path is true, the
reader may prefer it, and the agents are told never to describe portal layout
that is not in the knowledge base, so deleting it would remove the only place
they are allowed to learn it.

**If you add actions, re-run that grep.** It is the cheap check:
```bash
cd ~/gam/apps/api/src/services/agents/knowledge-content
grep -rniE "go to |click |navigate to|open the |head to " .
```

After ANY KB edit: re-ingest, or the change does nothing.
```bash
EMBEDDINGS_ENDPOINT=http://localhost:8081/v1 EMBEDDINGS_MODEL=bge-large-en-v1.5 \
  DB_NAME=gam npx ts-node -T src/services/agents/ingestKnowledge.ts
```
KB articles need frontmatter (`--- scope / title ---`) or the ingester **silently
skips them** and still reports a healthy count.

### (c) THE ROUTES I TOUCHED HAVE THIN TEST COVER

`tenantInvite.test.ts` exists because the invite had none. Several other routes
the agent now drives are in the same state — I wrapped them without pinning
them. The ones I would pin next, by blast radius:
`POST /api/leases/:id/deposit-return/finalize` (statutory clock, most disputed
thing in renting), `POST /api/bank-feed/deposits/:id/confirm` (books one
tenant's money onto a ledger), `POST /api/utility/generate-bills`.

---

## 2. THE ARCHITECTURE — unchanged from S626, read it before adding anything

An agent action does **not** reimplement an endpoint. It CALLS it over loopback
with the caller's own claims, and every middleware runs for real: `requireAuth`,
`requirePerm`, scope checks, zod validation, the rate limiter.

```
services/agents/portalActions.ts      the ALLOWLIST — what may be done (207 entries)
services/agents/portalDispatch.ts     mints a 60s token, calls the real endpoint
services/agents/tools/portalActionTools.ts   generates one AgentTool per entry
services/agents/actionGap.ts          the measurement, and the DELIBERATE list
```

### Adding an action — the whole recipe

1. **Read the route's zod schema.** Do not guess. I guessed twice today and
   `portalActionPaths.test.ts` caught both (`/me/theme` does not exist; the
   entry-request create takes an anchor, not a unit and a reason).
2. Add an entry to `PORTAL_ACTIONS`.
3. Add the id to the matching profiles in `profiles.ts` — there are TWO landlord
   and TWO tenant profiles, entry and escalation. `s.replace` hits both; assert
   the count is 2.
4. **Keep the verb regexes in step.** `actionParity.test.ts` (WRITE) and
   `routeCoverage.test.ts` (isAction) both match on the leading verb. A verb
   neither knows is a tool the ratchet stops counting — that is how these tests
   quietly stop protecting anything.
5. `npx tsc --noEmit -p tsconfig.json`
6. `DB_NAME=gam_test npx vitest run src/services/agents/` (~4s)
7. Full suite, then commit.

### If you are REMOVING an endpoint from the agent's reach

Name it in `DELIBERATE` in `actionGap.ts` with a real reason. The test rejects
reasons under 13 characters — it caught three of my own lazy `'same'` entries.

### NEVER put these in the allowlist
credentials (`auth`, `totp`, `emailOtp`, passwords, resets) · card or bank entry
· other portals (`admin`, `business*`, `pos`, `pm`, `platform`, public booking) ·
`subleases` / `subleaseInvitations` / `lotRent` (shelved) · anything that takes a
SIGNATURE or records an acceptance of terms with somebody's IP.

---

## 3. WHAT LANDED IN S628

Five commits. Fixes are by CAUSE, not by case.

**The tenant invite said "Invite Sent" and sent nothing.** The landlord's screen
says the person "will receive an email to set up their account"; the route logged
the accept URL and handed it back to copy. The reminder job did not cover it
either — it walks unit-bound intents and this flow creates a lease draft. Every
resident invited from that modal was waiting on an email nobody sent, and the
invite lapsed in silence after seven days. **This is launch-critical for Oak
Park**: tenants cannot log in if the invite never arrives.

**Re-inviting the same address created a duplicate tenant row.** `ON CONFLICT DO
NOTHING` against `idx_tenants_user_id`, which is a plain index. No constraint to
violate, so nothing to do nothing about. Downstream code resolves a tenant by
user id and would take whichever row came first — lease on one, payments on the
other. Nobody had re-invited the same address in dev, which is why it was quiet.
Both found by writing the characterisation tests S627 asked for, not by looking.

**Renewal is tenant-first** (Nic decided this session). Ask the tenant at 60
days, tell the landlord at 32 — whatever the tenant answered, including nothing,
which is the case that needs a human. Migration + daily job + 12 tests + the
tenant Lease page ungated.

**The agent can take a rent payment** (Nic decided this session): quote the real
total first, read it back, then charge. Two actions on purpose.

**Four prompt rules.** You can do it, so do it. Read it back and mean it — ids
come from lookups, never asked for or read out. Say what actually happened.
Say what a change does NOT do.

**The measurement was rebuilt** from area-level to endpoint-level, and moved
from a script into `actionGap.ts` so a test could assert on it.

---

## 4. TWO THINGS I GOT WRONG, SO YOU DO NOT REPEAT THEM

**I wrote a commit message describing work that was not in the commit.** `2ea72fc`
claims four prompt rules; they were staged in a scratch file and never applied.
They are in `1ba7e52` instead, and its message says so. The cause was staging
edits to apply "after the suite finishes" and losing track of which had run.
**If you stage work in a scratch file, apply it and verify before writing the
message.**

**I ran two vitest processes at once** and spent time diagnosing a phantom
failure. See §0.

---

## 5. OPEN QUESTIONS FOR NIC

- **The eval.** Nothing built today has been watched. Can the 36B be re-enabled
  for a bounded run, or should we build dispatch-level tests instead? (§1a)
- **Terms acceptance.** I have treated "the agent never accepts terms, signs, or
  enrols somebody on their behalf" as a hard rule — it excludes FlexPay and
  FlexDeposit enrolment, credit-reporting consent, deposit portability, lease
  signing, and the platform terms at onboarding. Every one records the person's
  IP as evidence THEY agreed. Worth confirming that is what you want, because it
  is 17 of the 100 exclusions.
- **`properties POST /:id/transfer`** — transferring a property to another
  account by email address. I excluded it: owner-only, moves ownership of a
  property with its units, leases and tenants, and it is aimed by typing an email
  address. Say if you want the agent able to initiate one.

---

## 6. COMMANDS

```bash
cd ~/gam/apps/api
ps aux | grep -c "[v]itest"                                   # MUST be 1 first
DB_NAME=gam_test npx vitest run                               # 25-40 min, must be green
DB_NAME=gam_test npx vitest run src/services/agents/          # ~4 s, the working loop
npx tsc --noEmit -p tsconfig.json
node scripts/action-gap.js                                    # the summary
node scripts/action-gap.js units                              # one area, endpoint by endpoint
DB_NAME=gam npx ts-node src/services/agents/retrievalGaps.ts  # KB probe, GPU-SAFE
```

`bash ~/gam/deploy.sh` ships everything and gates on the suite. **Nothing from
S626, S627 or S628 is deployed.** `ace2764` is the last deployed-equivalent
point.

Artifacts: [Agent Action Parity](https://claude.ai/code/artifact/678ba785-8683-4839-bec0-dfbe619dda9a)
(rewritten for S628) and
[Two-Turn Transcripts](https://claude.ai/code/artifact/b66db29f-1a77-4529-b9b3-f4bde6a892e4).

# SESSION 618 HANDOFF

End of S617. **Everything below is LIVE and deployed** unless marked otherwise.
15 commits. Supersedes SESSION_617_HANDOFF.md.

---

## 0. START HERE — MOVE THE DATABASE AND API OFF THE MAC

Nic's call, and the reason is concrete: *"With where this Mac is sitting and
some brownouts happening due to frequent rainstorms and power grid issues, I
would rather have the system in place before people try to pay rent. It's easier
to move a database now when there's no fucking tenants on it."*

**What is still on the Mac Studio and should not be:**
- **Postgres** — 185 MB, every lease, payment and tenant account
- **The API** — everything the portals call, plus 68 scheduled jobs
- 184 KB of uploaded files, 41 environment values

**What already moved (S617):** the marketing site. `goldassetmanagement.com` and
`www` now serve from Vercel.

**What stays on the Mac by design:** the AI agents. Nic: *"the agents are staying
on the Mac so that we don't have the token cost."* Correct — the model is
self-hosted, so a tenant chatting all day costs nothing. If the Mac dies, agents
stop and everything else keeps working. **That was always the intent, and the
build did not match it** — only the four portal front-ends were on Vercel.

**Target: DigitalOcean**, because Nic already pays for it and it is an always-on
machine in a datacentre with backup power. A droplet for the API, their managed
Postgres for the database. Roughly $15-35/month.

**BLOCKED ON NIC — this is the first thing to ask him.** There is no
DigitalOcean API token on this machine (`doctl` is not installed; nothing in
`.env`). SSH into the existing Jitsi droplet works
(`ssh -i ~/.ssh/gam_jitsi root@146.190.145.126`) but that box is 3 GB RAM and
already runs video — do NOT put the database there. He must create the droplet
and database, or hand over a token.

**Do not skip the rehearsal.** Nightly dumps exist and LAUNCH.md claims a restore
was verified, but nobody has proven it this session. Two things that document
called done this session turned out not to be. Restore into a scratch database
and check row counts before trusting it.

---

## 1. THE AGENTS — FINISHED THIS SESSION

Nic's framing, which is the rule and is worth reading before touching anything:

> *"If we think about the AI agents as being real people and the platform is at
> scale — what would a GAM customer service representative know off the top of
> their head versus what would they have to search for? Anything property
> specific, landlord specific, state specific, that's what the agent should be
> searching for."*

**Knows cold:** how to do something, GAM's own pricing, platform-wide rules,
what a product is, how a mechanic works when it is the same for everyone.
**Looks up:** anything attached to a person or a place, and anything set per
property, landlord or **state** — including general-sounding questions. Late
fees are a lookup; Nic was explicit they vary *"per property and per state and
landlord."*

Pinned as **"the customer-rep test"** in `agentGuards.test.ts`. If someone
loosens the rule, that test fails and says why.

### What was actually wrong

**The agents were inventing account data**, and it was invisible because the
tests drove the bare engine instead of the real path. Verified against SQL:

| asked | said | truth |
|---|---|---|
| how much do I owe? | $1,200 | $2,330 |
| is bob behind on rent? | "current" | $2,330 delinquent |
| how many units vacant? | 2, then 3 | 15 |
| open maintenance requests? | listed two, with titles | none |
| leases expiring? | a table incl. "Jane Doe, 2023-12-15" | one real lease |

**One root cause:** the agent could answer without looking anything up. Every
safeguard was a *request*, and a request gets declined about one time in five —
producing a confident invented number. The fix was making the lookup
non-optional, which Nic's rule made possible.

**Second root cause:** the guards matched WORDS, not meaning. "Connect you with
a human" matched a polite offer identically to a real handoff — so *correct
answers were being deleted* and replaced with "someone will email you in 24
hours." A tenant asked their balance and was told to wait a day.

### The measurement

`apps/api/src/services/agents/agentBattery.ts` — 108 phrasings across 27
intents, both audiences, through `runAgentSession` with a real signed-in actor.
Every figure checked against SQL. Grouped by INTENT with several wordings each,
because Nic's point was that *"tenants will basically ask the same thing in a
variety of ways"* — a group scoring 5/6 means one wording falls through.

```
DB_NAME=gam npx ts-node src/services/agents/agentBattery.ts          # all
DB_NAME=gam npx ts-node src/services/agents/agentBattery.ts tenant   # one side
DB_NAME=gam npx ts-node src/services/agents/agentBattery.ts balance  # one intent
```

**RUN IT ALONE.** Nothing else may touch the model — not vitest, not a second
script. The 36B server is one process on a machine that also holds Postgres and
the API; two loads and it dies and gets respawned. That happened three times.
The failure does not look like a crash: the run continues and every remaining
question fails with "LLM endpoint unreachable", scoring a meaningless 18/108.
**A cliff of ERROR flags means the model died, not that the agents broke.**

Score went **14/18 → 104/108** over the session. A full pass takes ~40 minutes.

**Of the four remaining, two were MY TEST being wrong, not the agent** — both
now corrected in `agentBatteryCases.ts` but not yet re-run:
- *"when do I get my deposit back"* wanted "$750". It is a WHEN, not a how much;
  explaining the move-out process was correct. Split into its own intent.
- *"what am I paying for this"* wanted "$2". The agent computed this landlord's
  ACTUAL bill — $10 per property, because Oak Street has 4 occupied units and
  Sunset Palms 2, both under the 5 where $2/unit overtakes the minimum. That is
  the better answer. Now accepts either.

The other two are the flakiness described below. **Expect ~106/108 on the next
clean run** once the corrected expectations are used.

### Known-flaky, not broken

Roughly one phrasing in five, the model declines to call a tool even when
required. Every guard now fails SAFE — it says "I can't pull that up" rather
than inventing. Watch for: `"what's my late payment rate"` calls the tool about
one run in three; the other two are suppressed, correctly.

**Do not "fix" this by loosening a guard.** A blank is annoying; a wrong balance
is what a landlord serves a notice on.

---

## 2. WHAT NIC STILL HAS TO DO

- **Create the DigitalOcean droplet + managed database**, or hand over a token.
- **Confirm Sentry alerts actually reach him.** Error reporting and four uptime
  monitors went live this session; Sentry emails the org owner by default. An
  alarm nobody hears is not an alarm.
- **Oak Park data entry** — still no tenants, no leases, no neighbour service
  agreements, and the owner-occupied units are still marked `vacant`, which
  costs money on every RUBS split. Order that saves a pass: neighbour service
  points → lease templates → mark owner-occupied → invite tenants.
- **The e-sign auto-draft has never run.** `auto_field_jobs` is empty. The model
  is up and the config is right, but his three Oak Park templates will be the
  first real use. Do the first one WITH Claude watching so a failure can be read
  live instead of guessed at.

---

## 3. SHIPPED THIS SESSION

- **Marketing on Vercel.** Prerendered rather than rewritten — `build.js` starts
  the real server and saves what it returns, because four of those pages sit on
  live money paths. Verified byte-identical. Rollback in one step:
  `~/gam-backups/dns-rollback-marketing.md`; the Mac still serves its copy on
  :3004.
- **Error reporting switched on.** LAUNCH.md listed Sentry as shipped
  infrastructure; the package was installed, the code was wired, and **no key
  was ever set**, so it reported nothing. Project `gam-api`, verified with a
  test error that arrived.
- **Four uptime monitors.** `api.goldassetmanagement.com/health` every 60s is
  the Mac heartbeat.
- **Payouts: four BUSINESS days, not calendar.** Measured against a real ACH —
  Stripe said `available_on` Tue 2026-08-25 for a charge created Wed 08-19; the
  calendar count said the 23rd, so payouts fired before the money existed, read
  an empty balance, and the trigger was retired anyway. Also fires at 01:00 UTC
  now instead of 9am Phoenix — `available_on` is a hard 00:00 UTC boundary, so
  the old timing was sixteen hours late.
- **Agent knowledge re-ingested** — 199 chunks, 67 articles. A landlord asking
  what a nightly booking cost was told **5%**; it has been 3% since S616 and 3%
  is what the Business Terms of Service says. Three articles written that did
  not exist (neighbour utilities, one-off charges, tenant-side utility bills).
- **`get_late_payment_history`** — Nic asked for it: money QUESTIONS the agent
  answers, money MOVEMENT goes to a person. Late is measured against each
  lease's own grace period and on `settled_at`.

---

## 4. HOW TO WORK WITH NIC — WHAT S617 TAUGHT

Everything from S616 §9 still holds. New, all of it earned:

- **HE DOES NOT CODE. Say it in plain terms.** He stopped me mid-session:
  *"You're saying a bunch of stuff that doesn't mean anything to me... you
  haven't given me the right context."* He was right. No jargon — say what a
  person experiences and what it costs.
- **Test the flow production uses.** *"Why are you not testing on the same flow
  that production goes through? That's the only thing we need to be testing."*
  I had been driving the bare engine, saw a placeholder leak, called it a
  harness artifact and moved on. It was real, and it was hiding two fabricated
  balances.
- **He thinks in roots, I drift to branches.** *"I'm looking from a roots
  perspective and you look from the branches. Let's find the root cause."* When
  he says that, stop patching and go find the one thing underneath.
- **He is right when he says something is off.** The marketing site being on
  Vercel (it was not), agents writing tool calls being invalid, two 36B models
  not fitting — every time.
- **MY TESTS WERE WRONG THREE TIMES.** Twice the agent was right and my
  assertion was crude; once I grouped two different questions into one intent.
  Check the expectation before reporting a failure.
- **Bound every wait.** I left four `until grep` loops spinning — one for
  sixteen hours — and he had to point at his screen twice to get them cleaned
  up. Never write a wait with no way out.

---

## 5. FILES / OPS

**Tests:** `cd apps/api && DB_NAME=gam_test npx vitest run` — **never without
DB_NAME, it wipes the dev database.** 308 files, 5,167 passing, ~7 min.
**Lint:** `npm run lint:hooks` from repo root before any frontend deploy.
**Deploy:** `bash ~/gam/deploy.sh` — note marketing is NOT in it any more; that
publishes from `apps/marketing` with `node build.js && node package-output.js &&
npx vercel deploy --prebuilt --prod --yes`.

**New:** `services/agents/agentBattery.ts`, `agentBatteryCases.ts`,
`agentGuards.test.ts`, `tools/getLatePaymentHistory.ts`,
`apps/marketing/build.js`, `apps/marketing/package-output.js`,
`packages/shared/src/chatCadence.ts`.

**Migrations:** 552 applied. One added this session
(`payout_triggers_defer_count`).

# SESSION 619 HANDOFF

End of S618. **Nothing below is deployed.** The API still runs the previous
build; every change here is on disk and tested, not live.
**364 agent tests · 3,435 across agents+routes · 555 migrations.**
**Battery: 144/145 across 38 intents, zero endpoint errors.** 63 of 145 turns
took the direct-execution path — the model still declines to call a lookup on
~40% of turns and the phrase table covers it every time. The one failure was a
DEGENERATE MODEL OUTPUT, not a logic bug: asked "what am I paying for this" it
emitted `[1], [2], [3], [4]…` citation markers instead of an answer. The same
intent passed 4/4 earlier the same day. See §8 — the placeholder guard catches
bracketed WORDS and not bracketed NUMBERS, so that garbage would have reached a
landlord.
Supersedes SESSION_618_HANDOFF.md.

---

## 0. START HERE — THE DATABASE AND API ARE STILL ON THE MAC

Unchanged from the last handoff, and still the most important item. Postgres,
the API and 68 scheduled jobs sit on a desktop machine on a grid with brownouts,
and tenants are about to pay rent through it. §0 of SESSION_618_HANDOFF.md has
the full sequence and it is still accurate. **Blocked on Nic:** create the
DigitalOcean droplet + managed database, or hand over a token.

---

## 1. WHAT WAS ACTUALLY WRONG WITH THE AGENTS

Nic's diagnosis, which turned out to be the whole fix:

> *"A tool should always be called for things that have to be searched for
> because they're gonna be different per my next door neighbor versus me — two
> different leases, two different late fees, two different whatevers. The only
> time a tool doesn't get called is for the platform side of things that never
> change."*

**The rule had a hole, and the hole was the bug.** `demandsAToolCall` required
the message to contain one of a fixed list of question verbs before a lookup was
demanded at all. Measured against real phrasings, **seven of eight per-user
statements failed that precondition** — "my balance looks off", "i need my lease
end date", "i think my late fee was wrong", "my rent seems too high". And every
anti-fabrication guard keys off the SAME flag, so those messages were not merely
allowed to skip the lookup, they were **unprotected**: the agent could answer
them out of the model's head and nothing would stop it.

**Inverted (agentRunner.ts).** Everything now demands a lookup EXCEPT a platform
constant (identical for every user — rent mechanics, what a product is, GAM's own
pricing, how e-signing works) or a message that asks nothing ("hi", "thanks").
Late fees, grace periods, rent due dates are all lookups: they vary per property,
per state, per landlord.

### Forcing the model does not work. Running the lookup does.

Three findings, in order, each measured on the real path:

1. **`tool_choice: 'required'` is unreliable** under the real profile (~30 tools,
   long prompt). Roughly one phrasing in five it answers with no tool anyway.
2. **Naming the specific tool is WORSE than 'required'.** Both forms are obeyed
   perfectly by a three-tool prompt — which is exactly what made an isolated
   curl test misleading. Under the real profile, pinning `tool_choice` to one
   function took tenant-balance from answering correctly to calling nothing at
   all. Dropped; see the comment at the `toolChoice:` line.
3. **So the runner calls the lookup itself.** When the phrase table recognises
   the wording and every required argument is available, `agentRunner` executes
   the tool directly and feeds the real result back. **63 of 145 turns** in the
   final battery took this path — over 40%. Without it those turns are a
   narrowing question at best.

### `toolRouting.ts` — the phrase table

Wording → the lookup(s) that answer it, ~10 phrasings per intent, both audiences.
Nic: *"when any sort of combination of this comes up, this is what it's
inferring."*

- **It contains no answers and no numbers.** It only picks which lookup runs; the
  model still writes the reply from the tool's real result. A wrong entry runs
  the wrong query — it cannot invent a figure.
- **Routes carry MULTIPLE tools.** "Is my landlord gonna renew?" pulls the lease
  AND the renewal tendency — the lease has the date, the tendency has the
  behaviour, neither answers alone.
- **It extracts the ARGUMENT too.** The model calls the tenant lookup for "is bob
  behind on rent?" and consistently refuses for "how much does apt 101 owe" and
  "what's bob chen's balance" — verified in both orderings, the same three fail
  every time. The tool accepts "Apt 101" fine; nothing was calling it. The
  wording says who, so the table reads it. A misread degrades to "That's Bob Chen
  in Apt 101 — different Chen?", never to a wrong figure.

### The questing-verb rule (Nic's, and better than what it replaced)

> *"When the agent responds with the word look, or look for, or search, or find
> out, or any other kind of questing type phrases, that should require a tool to
> be called no matter what."*

`saysItWillCheck` in agentRunner.ts. The previous version enumerated ways the
model might promise something and kept missing them — it had "look up" and "look
into" and missed "look **at**", which is the reply that then shipped. The
questing WORD is the signal, whatever grammar wraps it.

### Escalation is for real money only

> *"Any sort of bringing an outside person into the conversation should only be
> done if it's real money."*

`escalationPolicy.ts`. Refunds, wrong charges, bank-account problems and account
takeover reach a person. **Legal threats no longer do** — that is a consequence
of the rule rather than something Nic named, and it is the one piece worth a
second look. Any promise of a callback not backed by a recorded handoff is
stripped from the reply in `agentSession.finalize` (every reply passes through
there; the runner returns from a dozen places).

---

## 2. MEASURED

Battery grew 109 → 145 phrasings (38 intents) over the session: three intents
for tools S617 built but never measured, vacancy split into count/list, two
lease intents, and five more for the analytics, ranking, P&L and complaint work.

| intent | before | after |
|---|---|---|
| late-payment history | 1/4 | 4/4 |
| tenant balance | 1/5 | 5/5 |
| platform fee | 3/4 | 4/4 |
| unit lease + "spot one" | 2/3 | 7/7 |
| read my lease | did not exist | 4/4 |
| pet deposit | nothing to call | 4/4 |

**Run it alone.** Two loads on the 36B kills it — I did that once this session
and produced two meaningless scores (12 endpoint errors in each log). A cliff of
ERROR flags means the model died, not that the agents broke.

```
DB_NAME=gam npx ts-node src/services/agents/agentBattery.ts            # all
DB_NAME=gam npx ts-node src/services/agents/agentBattery.ts balance    # one intent
```

`expectTool` is new: the harness now asserts WHICH tool ran. That is what
revealed `get_late_payment_history` — built in S617 — was calling nothing on
three of four phrasings and had never been measured.

---

## 2b. THE LANDLORD CAN NOW ASK ANYTHING ABOUT THEIR OWN BOOK

Nic: *"I want the agent to be able to basically read any data points from the
landlord's portfolio and kind of put together a customized report... I might
wanna know what's the average age of my renters, or how many people are on fixed
income, or just at a glance where I would have to go through and manually figure
that out."*

Three tools, all hard-scoped to the landlord's own id:

- **`get_portfolio_stats`** — rates and averages across eleven families:
  occupancy, tenants, rent, payments, leases, maintenance, money, deposits,
  applications, bookings, inspections. Real figures from the demo book:
  38.1% occupied, **55.6% of rent charges arrive late** (averaging 43.5 days),
  average lease 11.9 months, repairs close in 10.7 days, 48 short-stay nights
  worth $2,716.
- **`query_portfolio`** — the WHO half. 17 measures ranking tenants, units and
  properties: longest tenancy, most repairs filed and what they cost, late
  payments, balance owed, complaints filed, complaints ABOUT a unit, turnover,
  occupancy by property. **A closed vocabulary, not free SQL** — the agent picks
  from enums and the SQL is written in the file, so it cannot invent a column or
  escape the landlord filter.
- **`get_profit_and_loss`** — a THIN WRAPPER on `computeLandlordPL`. That
  function is already the single source of truth for the reports page and Books
  (S568, "detangle Books"), so the agent's P&L is the portal's P&L by
  construction. Writing a second query would have been quicker and would have
  recreated, in the number a landlord trusts most, the exact bug found in
  billing this session. Deposits stay a held liability; GAM fees stay GAM's.

**`null` means NOT RECORDED and the tools say so in words.** Average tenant age
comes back null because no birthdates are on file; net income carries "this is
NOT a profit figure" when no expenses have been entered. The S617 failure this
prevents: handed aggregates, this model invents the breakdown it thinks should
accompany them.

### "We don't track that" is now a backlog, not a shrug

Nic: *"if that response ever comes up, it should be set up where we start
tracking that data platform wide, within reason."*

`analytics_data_gaps` (migration 20260824113000) records every measure the
analytics tools were ASKED for that does not exist — verified capturing
`tenants.credit_score`, `tenants.employment_length`, `evictions`, while a
catalog browse logs nothing. Read it to decide what to start tracking: requested
forty times is a feature, once is curiosity.

**Genuinely not tracked today:** credit scores, employment length, eviction
history, why a tenant left, lease-violation reasons (notices are free text with
no type column). **Tracked but not yet exposed to the agent:** utilities
(meters/readings/bills/RUBS), the full bookkeeping set (a real P&L by property),
screening and adverse-action, entry requests, surveys, service interruptions,
work-trade, parts inventory, disbursements.

---

## 2c. COMPLAINTS — THE CHAT IS THE INTAKE

Nic: *"the table is gonna be created in the agent chat. That's the point of
contact where tenants are gonna complain about the neighbor, or they're gonna do
it as a maintenance request — hey, tell my neighbor to turn their shit down."*

`tenant_complaints` (migration 20260824090000) + `log_complaint` (tenant) +
`get_open_complaints` (landlord) + an in-platform notification.

**The failure this replaced is the worst thing measured all session.** Asked to
file a complaint the model called nothing — 0 of 4 — and told the tenant *"I've
logged your complaint. Your landlord has been notified and will follow up."*
with the table empty. A tenant who believes it is filed stops pursuing it, and
the landlord never hears. Now 4/4 with real rows.

Two consequences worth keeping:
- **`log_complaint` IS directly runnable**, reversing an earlier call of mine.
  The body is the tenant's OWN sentence stored verbatim, so a wrongly-triggered
  row still says exactly what they said — a far smaller harm than the lie.
  Duplicates within the hour collapse.
- **`claimsAnActionItNeverTook`** in agentRunner.ts — a completed-action claim
  with no tool behind it never ships. This is a category worse than the promise
  `saysItWillCheck` catches: "I'll look into it" leaves someone waiting, "I've
  filed it" makes them stop.

**In-platform only, no email** (Nic): it lands in the bell and on their list.

---

## 3. NEW TOOLS

- **`get_my_lease_fees`** — the fee rows on the tenant's lease (pet deposit, pet
  rent, cleaning, parking, storage, trash). `lease_fees` holds 21 fee types and
  the ONLY code reading it was a landlord billing path; no tenant tool exposed
  any of it, so "how much is my pet deposit?" had no lookup behind it at all.
- **`get_my_full_lease`** — the whole lease assembled: terms, every fee, rent
  components, pets, occupants, and `import_extra_data`/`extraction_extras` (terms
  the PDF import captured that have no column — the closest thing to the
  document's own wording, and never read by any agent until now).

**Both kept on purpose.** The full-lease payload is large, and prompt size is the
one factor repeatedly measured degrading this model's tool-calling. Single-fact
questions take the narrow route; "according to my lease" and multi-part questions
get the document.

**PDF:** `lib/pdfText.ts` `extractPositionedText()` returns pages of text items
WITH coordinates — that is the layer for "the wording on line 13, section B" if
the assembled lease proves insufficient. Screen-reading the browser PDF renderer
is the wrong path: it needs a vision model, and external AI on tenant data is
against the platform rule.

---

## 4. THE BILLING BUG FOUND ON THE WAY

Not agent work, but it was on the Oak Park path and it was going to cost money.

**Importing a lease never marked the unit occupied.** ONBOARDING_PUNCHLIST.md
states the shipped rule — units are created *"always vacant; leases flip it"* —
and three paths that create an already-active lease never flipped it
(`routes/landlords.ts` onboard-tenant and bulk CSV import, plus the lease
parser). `routes/landlords.ts` contains no `UPDATE units` at all. Two live
examples: RV 01 and House 01, each with a started lease and a tenant, both
reading `vacant`.

Consequences: the agent told a landlord a unit was empty while someone lived in
it, the occupancy KPI and rent roll were wrong the same way, and
`monthlyFeeAccrual` counts `units.status='active'` — so **GAM never billed the $2
for that unit.**

**Fixed with a trigger** (`20260823120000`, applied), not three call-site
UPDATEs — a call-site fix is correct only until the next call site is written.
Plus a nightly reconcile in `activatePendingLeases` for future-dated leases.

**And the billing rule itself was wrong.** A unit flips to `delinquent` the
moment rent is overdue and NOTHING ever flips it back, and the fee job counted
only `active` — so the first late payment removed that unit from billing
permanently. Nic: *"no matter their late status or eviction status, we are still
billing the landlord for the occupancy of the unit."* Occupancy for billing is
now an ACTIVE LEASE covering the month, which also makes the bill agree with the
quote in `services/platformFee.ts` (those used different rules).

**Still open:** RV 02 is marked `active` with zero leases, ever — the opposite
drift. Under the old rule it was the only unit billed at Sunset Palms while the
two actually-occupied ones were missed. Not auto-corrected; vacating a unit is a
data-truth decision for Nic.

---

## 5. MISTAKES THIS SESSION — READ THIS BEFORE TRUSTING A SMALL TEST

- **I caused a fabrication regression.** The direct-execution path pushed the
  model's own tool-less guess into the conversation ahead of the real result. Handed
  its own claim and then the truth, the model restated the claim: "You have 6
  vacant units" (13), "26 units across 4 properties" (21 across 3). The assistant
  turn is now the tool call and nothing else.
- **A guard gap outlived it.** Every no-lookup guard keys off
  `toolInvocations.length === 0`, so once ANY tool runs the reply is treated as
  grounded. "A tool ran" and "the answer came from the tool" are different
  claims. `countsNotInToolResults` now checks integers attached to portfolio
  nouns against what the tools returned.
- **Small reproductions lie about this model.** Every conclusion drawn from a
  three-tool curl test was wrong at full prompt size — twice. Only the battery on
  the production path has been reliable.
- **"Flaky" was wrong twice.** Both times the failure was deterministic and
  findable. Running the phrasings in REVERSE order is what proved it: the same
  questions passed and failed regardless of position.
- **My test expectations were wrong five times**, versus a similar number of real
  agent bugs. "Show me my vacancies" returned all thirteen units grouped by
  property — correct — and scored as a failure for not containing "13". Check the
  expectation before reporting a failure.

---

## 8. THE GAME PLAN FOR NEXT SESSION

Nic, at the close: *"let's just make sure that all of our improvements we're
doing today are only facing landlord and tenant. It may be worth it to
potentially have agents with different knowledge bases — that way the marketing
side is accurate to what it needs to know versus the booking side."*

### First, the honest answer to that question

It is the REVERSE of what we would want, and it is the root of the two bugs
below.

- **CAPABILITIES are properly scoped.** All seven new tools are
  `audiences: ['tenant']` or `['landlord']`. Every phrase-table route is
  audience-tagged. A guest or prospect agent cannot reach any of them.
- **BEHAVIOURAL RULES are platform-wide.** The tool-requirement rule, the three
  anti-fabrication guards, promise-stripping, the legal contact line, the
  graceful model-down reply and the cross-session-memory removal all apply to
  EVERY agent — sales, guest and property-site visitor included.

That asymmetry is exactly how a rule written for tenants broke the sales agent.

### 8a. THE BATTERY TESTS 2 OF 5 AUDIENCES — start here

Seven profiles exist: `tenant_entry`, `tenant_escalation`, `landlord_entry`,
`landlord_escalation`, `sales_entry` (prospect — Lucy), `guest_entry` (Skye),
`visitor_entry` (property booking sites). **The battery covers tenant and
landlord only.** Three customer-facing agents have never had a single case.

Two live bugs were found in that blind spot in the last ten minutes of the
session, both by hand, both caused by the global rules above:

1. **The sales agent was broken BY THIS SESSION'S WORK.** A prospect has no
   account, no lease, no property, and `sales_entry` holds no data lookups at
   all (capture_lead, get_available_call_times, book_sales_call). The inversion
   made "what's the price per unit" demand a lookup that does not exist, so a
   correct "$2 per occupied unit per month" was suppressed as an unbacked figure
   and replaced with *"which part were you after — your balance, your rent, your
   lease dates, or your deposit?"* — to someone who has none of those. The
   commercial front door. Fixed: `demandsAToolCall(message, audience)` exempts
   'prospect'.
2. **The opposite for guest and visitor.** "How much does it cost per night" was
   matching the PLATFORM-pricing exemption and being answered from memory — but
   on a booking site that is THIS property's nightly rate, set by that landlord.
   Per-property data quoted from the model's head. Fixed: those two audiences
   look everything up. `cannotSee` is audience-aware too — a guest has a
   booking, not a lease.

**Do this first:** battery intents for sales, guest and visitor. Everything
below is easier to judge once those exist.

### 8b. SEPARATE KNOWLEDGE BASES — Nic's idea, and it is the right one

Today every agent retrieves from ONE pool of 199 chunks across 67 articles.
Marketing, booking and account questions all draw from the same well, so each
agent is mostly retrieving things irrelevant to it — and the precedent is
already on record: **a landlord was told a nightly booking cost 5% when it had
been 3% since S616.** One stale article, every audience.

Shape to build:
- a `scope` on `agent_knowledge_chunks` (marketing / booking / account /
  shared), and retrieval filtered by the profile's scope
- marketing owns GAM pricing, product, terms; booking owns availability,
  deposits, check-in; account owns lease/payment mechanics; shared owns the
  handful of genuinely universal facts
- the win is not just accuracy — it is a smaller prompt per agent, and prompt
  size is the ONE factor measured all session degrading this model's
  tool-calling

### 8c. THE CITATION-SPAM GUARD (small, do it early)

The single battery failure: the model answered with `[1], [2], [3], [4]…` and
nothing else. `assertsStoredFacts` catches bracketed WORDS
(`[get_my_lease.endsAt]`) and not bracketed NUMBERS, so it shipped. A reply that
is mostly numeric citation markers is machinery and should never reach a
customer. Cheap, safe, and it protects every audience.

### 8d. STILL WORTH DOING

- **Landlord complaint SURFACE.** The data, the notification and the agent read
  path all exist; there is no page. `actionUrl` already points at
  `/complaints?open=<id>`, which 404s.
- **Read `analytics_data_gaps`** after a week of real use — it is the list of
  what landlords asked for that we cannot answer.
- **Utilities and bookkeeping to the agent** (§2b) — the biggest untouched data,
  and where a REAL per-property P&L lives.
- **Expenses are landlord-entered**, so "net" is only as good as what they type.
  get_profit_and_loss refuses to call it profit when nothing is entered.

---

## 6. OPEN

- **Cross-session memory: REMOVED** (Nic: *"we should just get rid of cross
  session memory"*). It measured worse — the same five questions scored 1/5 with
  it and 2/5 without, because telling the model "this person recently asked
  about their balance" made it LESS likely to look the balance up. The CURRENT
  conversation still carries, so nobody repeats themselves inside a chat; only
  last week's questions are gone. `loadUserContext` still exists in
  conversationHistory.ts and is now called by nothing.
- **Legal threats: RESOLVED Nic's way.** Not an escalation and not silence —
  the agent gives out support@goldassetmanagement.com and the customer reaches
  out. *"That way they have to reach out, not us promising we're gonna reach
  out. Anybody that's just blowing smoke isn't gonna bother reaching out.
  Anybody that is a little more serious will make the reach out, and it kind of
  prefilters some people for us."*
- **RV 02 — DROPPED, and I was wrong to raise it.** Nic: *"we don't make choices
  based on seed data. That's not real."* Verified: the seed script sets unit
  status with a raw UPDATE and no lease, and the product's ONLY path to 'active'
  (units.ts:1896) throws `Cannot activate without an active lease` first. It
  cannot happen in production.
- **Any agent error still returns its internal message to the customer.** The
  model-down case is fixed — a tenant asking their balance used to get HTTP 500
  carrying `LLM endpoint unreachable at http://localhost:8080/v1`, and 88 of
  those were logged in one hour on 2026-08-23. The GENERAL leak (any 500 returns
  `err.message`) is a wider API change, not done.
- **Nothing is deployed.**

---

## 7. FILES

**New — routing and policy:**
`services/agents/toolRouting.ts` (+ `toolRouting.test.ts`) — the phrase table
`services/agents/escalationPolicy.ts` — money-only escalation, legal contact line

**New — tenant tools:**
`tools/getMyLeaseFees.ts` · `tools/getMyFullLease.ts` · `tools/logComplaint.ts`

**New — landlord tools:**
`tools/getPortfolioStats.ts` (11 stat families) ·
`tools/queryPortfolio.ts` (17 ranking measures) ·
`tools/getOpenComplaints.ts` · `tools/getProfitAndLoss.ts` (wraps computeLandlordPL)

**New — migrations (ALL THREE APPLIED to gam):**
`20260823120000_lease_activation_occupies_unit.sql` — the occupancy trigger
`20260824090000_tenant_complaints.sql` — complaints from the agent chat
`20260824113000_analytics_data_gaps.sql` — what was asked for and cannot be answered

**Changed:**
`agentRunner.ts` — inverted + audience-aware `demandsAToolCall`, direct
  execution of routed lookups, `saysItWillCheck`, `claimsAnActionItNeverTook`,
  `countsNotInToolResults`, audience-aware `cannotSee`
`agentSession.ts` — graceful model-down reply, promise stripping, legal contact
  line, **cross-session memory removed**
`engine.ts` (toolChoice type) · `profiles.ts` (7 tools added across 4 profiles) ·
`tools/index.ts` · `services/notifications.ts` (`notifyTenantComplaint`,
  in-platform only) · `packages/shared/src/index.ts` (complaint enums + labels) ·
`agentBattery.ts` (`expectTool`, `expectToolAny`) · `agentBatteryCases.ts` ·
`jobs/monthlyFeeAccrual.ts` · `jobs/scheduler.ts` · `routes/units.test.ts`

**NOT COMMITTED.** 31 files changed in the working tree; nothing pushed, nothing
deployed. The API still runs the previous build.

**Tests:** `cd apps/api && DB_NAME=gam_test npx vitest run` — **never without
DB_NAME, it wipes the dev database.** 309 files, 5,216 passing, ~7 min.

**Run the FULL suite after a migration that adds a trigger.** The focused suites
all passed and missed one: `units.test.ts` seeded a vacant unit WITH an
already-started active lease to isolate a validation check, and
trg_occupy_unit_on_active_lease correctly makes that state impossible — so the
route answered "Unit is already active" first. Fixed by future-dating the seeded
lease, which is also the real scenario for scheduling an activation. A trigger
fires on every write of its table; focused suites cannot cover that.

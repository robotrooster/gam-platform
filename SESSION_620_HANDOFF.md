# SESSION 620 HANDOFF

**The S619 work is DEPLOYED** — the first thing this session did, and the
reason the previous handoff's "nothing is deployed" line is gone. API rebuilt
and restarted under launchd, marketing kickstarted, all four Vercel frontends
verified already in sync. Full suite green before the push: 309 files, 5,234
tests.

Then: the agent knowledge bases are **hard-siloed, one per audience**, and the
three customer-facing agents that had never had a single test now have 61
battery phrasings between them. All three were broken. All three are fixed.

Supersedes SESSION_619_HANDOFF.md.

---

## 0. STILL THE MOST IMPORTANT ITEM — THE DATABASE IS ON THE MAC

Unchanged, and now more urgent because the API it serves is live and current.
Postgres, the API and 68 scheduled jobs sit on a desktop machine on a grid with
brownouts, and tenants are about to pay rent through it. §0 of
SESSION_618_HANDOFF.md has the full sequence and is still accurate.
**Blocked on Nic:** create the DigitalOcean droplet + managed database, or hand
over a token.

---

## 1. WHAT NIC ASKED FOR

> *"The tenant agent keeps telling people stuff about the landlord or the
> booking side that has nothing to do with being a tenant. So maybe we make
> them separate things and knowledge bases completely."*

He chose the hard version when asked: **one scope per audience, no shared
pool**, universal facts duplicated per audience with a drift check.

### The diagnosis was right, and the cause was worse than "bleed-through"

Scope filtering already existed and already worked. The hole was that every
profile *also* read `shared` — and `shared` was six articles written entirely
in **tenant voice**: resetting your password, two-factor, notification
preferences, *"your rent amount, due date and late fees are set by your
landlord."*

- **The guest agent and the site-visitor agent read NOTHING BUT those six.**
  100% of their retrievable knowledge was account mechanics for an account they
  do not have, in the voice of a renter they are not. A guest has no login, no
  landlord and no lease.
- **The sales agent** — talking to a prospective **landlord** — retrieved
  *"GAM is the platform, not your landlord; repairs are your landlord's
  decision"* and read it to the person who **is** the landlord.
- And the cost in the other direction was already on record: a landlord was
  told a nightly booking cost 5% when it had been 3% since S616. One stale
  article, every audience.

---

## 2. THE WALL

`scope IN (tenant, landlord, sales, guest, visitor)`, each profile carrying
exactly **one**. `retrieve()` already filtered `WHERE scope = ANY($2)`, so a
single-element list is a hard wall — not a ranking preference a well-worded
question can defeat.

Probed across six deliberately cross-aimed questions (a tenant asking about
payouts, a guest asking for GAM's rate card, a prospect asking when their rent
is due): **no leaks**.

216 chunks across 5 scopes, up from 199 across 4.

### Duplication, with a check — because duplication is how the 5% happened

Universal facts are copied per audience in that audience's voice, tied by a
`canonical:` key in the article frontmatter. **`knowledgeSilo.test.ts`** asserts:

- every copy of a canonical key states **the same figures** (voice may differ,
  numbers may not) — verified by injecting `8` for `10 one-time codes` into one
  copy and watching it fail
- no canonical key is stranded in one scope, and no scope holds two copies
- every article sits in a directory matching its declared scope
- **no profile reads more than one scope** — that assertion is the shared pool's
  gravestone
- **product siloing**, enforced at build time

That last one found a live violation on the day it was written:
`landlord/ending-a-lease.md` named **FlexDeposit**, a tenant product, inside
the landlord agent's knowledge. Reworded to the mechanism ("balances the tenant
owes GAM rather than you"), which is the fact that article actually needed.

### Guest and visitor have real knowledge for the first time

Six new articles: how a stay is changed and which changes auto-apply, amenities
and their fees, how rates and totals are built, how booking a type works, and
what GAM is from each side. **No figure appears in any of them** — every rate is
per-property and read live, which the articles say outright.

---

## 3. THE BATTERY NOW COVERS FIVE AUDIENCES, AND FOUND FOUR REAL BUGS

S619 §8a said three customer-facing agents had never had a case. They do now —
61 phrasings across 16 intents. Every group carries a **cross-audience case**:
the neighbouring audience's question, asked of the wrong agent.

| audience | before | after |
|---|---|---|
| prospect (Lucy) | 16/20 | **20/20** |
| guest (Skye) | 8/23 | **23/23** |
| visitor (Skye, booking site) | 2/18 | **18/18** |

### 3a. The sales agent would not book a call — 0/4

Asked *"can I talk to someone?"* and *"I want to schedule a demo"*, Lucy called
**nothing** on every phrasing and replied *"Want me to grab you a time?"* — an
offer to book against a calendar she never opened. Two of those four then had
the promise stripped by `finalize`, leaving a prospect who asked for a call
holding nothing at all. On the commercial front door.

Cause: S619 fixed the prospect pricing regression with a blanket
`if (audience === 'prospect') return false` in `demandsAToolCall`. But "no data
lookups" is not "no tools". **A prospect is now exempt from LOOKUPS and not
from ACTIONS**, with the phrase table as the arbiter — if it routes this
wording to a tool, that tool is required; if it routes nothing, the question is
a platform constant and the knowledge base answers it (which is what keeps the
"$2 per occupied unit" answer allowed).

### 3b. `[property name]` shipped to a customer

A visitor on a public booking site was sent:

> *"I'm Skye, the booking assistant for **[property name]**. …To reset your
> password, you'll need to go to the login page and click…"*

Two bugs in one reply.

**The placeholder.** `assertsStoredFacts` caught bracketed *words* only in the
single-token form (`[get_my_lease]`); `[property name]` has a space, so a
template hole reached a customer. Now two-to-four lowercase words in brackets
count as a placeholder.

**The password advice** is the leak Nic reported, and separating the knowledge
bases **cannot fix it** — that fixes what an agent *retrieves*, not what the
model already knows. It asserts no figure, no date and no list, so every fact
guard passed it through. `scrubOffAudienceTopics` (scopeGuard.ts) removes
another audience's product from a reply, for the two no-account audiences only:
password/2FA mechanics, lease and rent mechanics, "your landlord", and GAM's
per-unit rate card. A tenant discussing their lease and a landlord discussing
the platform fee are untouched — those topics are theirs.

### 3c. The booking front door answered availability with silence — 0/4

*"Do you have anything open next weekend?"* called no tool and was suppressed
to *"I don't want to quote you a figure I haven't actually checked."* The guard
was right; the **routing was missing**. `toolRouting.ts` shipped covering
tenant and landlord — the same two audiences the battery covered.

Routes added for visitor, guest and prospect. Two things worth keeping:

- **Dates beat the rate card.** "How much for the 15th to the 20th" is an
  availability question; the rate card cannot answer it and would quote a
  nightly figure for five specific nights with no proration and no tax. Caught
  by its own unit test, which failed first.
- **The availability route carries TWO tools on purpose.** `check_availability`
  requires `checkIn`/`checkOut`, which only the model can resolve — this table
  must never guess a date. When the model declines, the direct-execution path
  skips it (missing required args) and runs the rate card instead, so the
  visitor gets real published rates and a request for their dates. Rates
  without dates is an honest partial answer; silence is not.

### 3d. And the citation-spam guard (S619 §8c)

The single battery failure across 145 phrasings was `[1], [2], [3], [4]` and
nothing else. `assertsStoredFacts` caught bracketed WORDS, not bracketed
NUMBERS, and only ran when no tool had run — but a reply can be citation spam
either way. Every reply now passes `stripCitationMarkers` in `finalize`; a
reply that *contained* machinery and has no words left once it is gone is
replaced rather than sent.

---

## 4. MISTAKES THIS SESSION

- **I let the harness pick its own fixtures, and 11 cases scored MISSING
  against facts belonging to a different guest at a different property.** The
  first draft took the latest booking (`ORDER BY check_in DESC`) and the
  alphabetically-first site, and both moved under the expectations. Now pinned
  to `sunset-palms` and the checked-in booking, with the reason written down:
  Oak Park has one site type, no monthly rate and 0% tax, so the monthly and
  tax cases cannot be written against it at all.
- **My `guest-request-change` expectation was wrong.** I asserted the tool
  fires on turn one; the profile says *"confirm the specifics with the guest
  first (what time, which night), then send it"*, so asking is the agent
  obeying. The harness is single-turn and cannot reach the turn where the tool
  fires. The case now asserts what matters on turn one — that it must not
  **claim** the change is done. Same failure shape as the complaint that was
  never filed.
- **My first substance floor was too aggressive** and swallowed "Checking." —
  a one-word reply is a poor answer but it is a reply, and `saysItWillCheck`
  owns it. The floor is one word, and the guard only fires on a reply that
  contained machinery.

The S619 lesson held again: **check the expectation before reporting a
failure.** Three of the ~14 failures this session were mine, not the agent's.

---

## 5. STILL OPEN

- **Landlord complaint SURFACE.** Unchanged from S619 — data, notification and
  agent read path all exist; there is no page, and `actionUrl` points at
  `/complaints?open=<id>`, which 404s.
- **The guest/visitor knowledge bases are THIN** — three articles each, 6
  chunks. They are correct and they are relevant, which is a large change from
  what was there, but a real booking operation has more to say (check-in
  instructions, pets, quiet hours, cancellation). Worth a pass with Nic on what
  a host actually gets asked.
- **`analytics_data_gaps`** — read it after a week of real use.
- **Utilities and bookkeeping to the agent** — the biggest untouched data.
- **Any agent error still returns its internal message to the customer.** The
  general 500 leak is a wider API change, still not done.
- **Multi-turn battery.** Several real behaviours — confirm-then-act, the
  narrowing question then the answer — only exist across two turns, and the
  harness cannot reach them.

---

## 6. FILES

**New:**
`services/agents/knowledgeSilo.test.ts` — the wall, enforced against the markdown
`db/migrations/20260824153000_knowledge_scope_hard_silo.sql` — scope CHECK + drops shared
`knowledge-content/guest/` ×3 · `knowledge-content/visitor/` ×3 — new audiences
`knowledge-content/{tenant,landlord,sales}/` ×8 — per-audience copies of the universal facts

**Changed:**
`types.ts` (KNOWLEDGE_SCOPES) · `profiles.ts` (one scope each) ·
`scopeGuard.ts` (`stripCitationMarkers`, `scrubOffAudienceTopics`) ·
`agentSession.ts` (both wired into finalize) ·
`agentRunner.ts` (prospect exemption narrowed to actions; placeholder gap) ·
`toolRouting.ts` (visitor/guest/prospect routes) ·
`agentBattery.ts` (pinned fixtures + three new actors, built exactly as their
  doors in routes/agent.ts build them) · `agentBatteryCases.ts` (16 new intents) ·
`ingestKnowledge.ts` (carries `canonical`) · `knowledgeProbe.ts` · `knowledgeSmoke.ts`

**Deleted:** `knowledge-content/shared/`

**Re-ingest is NOT optional after touching content:**
```
DB_NAME=gam node -r ts-node/register src/services/agents/ingestKnowledge.ts
```
The migration deletes the `shared` rows and the replacements are new files at
new paths, so nothing is remapped — without the ingest those articles are
simply gone.

**Battery — run it ALONE.** Two loads on the 36B kills it and produces
meaningless scores.
```
DB_NAME=gam npx ts-node src/services/agents/agentBattery.ts            # all
DB_NAME=gam npx ts-node src/services/agents/agentBattery.ts visitor    # one audience
```

**Tests:** `cd apps/api && DB_NAME=gam_test npx vitest run` — **never without
DB_NAME, it wipes the dev database.**

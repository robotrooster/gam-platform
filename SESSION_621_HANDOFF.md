# SESSION 621 HANDOFF

End of S620. **Everything below is deployed and live.** 21 commits, all four
frontends and the API shipped. Full suite: **317 files, 5,327 passing.**
Supersedes SESSION_620_HANDOFF.md.

---

## 0. START HERE — THE DATABASE IS STILL ON THE MAC

Unchanged and still the top risk. Postgres, the API and 68 scheduled jobs run
on a desktop on a brownout-prone grid, and tenants are about to pay rent
through it. **Blocked on Nic:** create the DigitalOcean droplet + managed
database, or hand over a token.

---

## 1. WHAT NIC IS TRYING TO DO

Send portal invites and get leases out. He has said so for four days and keeps
getting pulled off it by things breaking underneath. **Everything in §3 was
found while he was trying to onboard one co-owner.** Treat that as the signal
it is: the co-owner path had never been walked end to end by a real person.

Launch-critical, in his words: **the marketing page, the landlord agent, the
tenant agent.** Booking/guest agents are NOT — Oak Park gets five or six
short-stay nights a year.

---

## 2. THE AGENTS

**Knowledge is hard-siloed**: one scope per audience (tenant / landlord / sales
/ guest / visitor), no shared pool. Universal facts are duplicated per audience
and tied by a `canonical:` key; `knowledgeSilo.test.ts` asserts the copies agree
on every figure and that no scope is missing one. It also enforces product
siloing at build time and caught a live violation (a tenant product named inside
landlord knowledge).

**Single-turn battery: 207/207 across 54 intents, all five audiences.** That run
found and fixed: the sales agent refusing to book a call (0/4), a `[property
name]` placeholder shipped to a customer, availability answered with silence
(0/4), and password-reset advice on a public booking site.

**Two-turn conversations: `agentConversations.ts`, 19 cases.** Read the
transcripts before trusting the score:
https://claude.ai/code/artifact/b66db29f-1a77-4529-b9b3-f4bde6a892e4

Nic reviewed every one. **5 of 19 are genuinely clean.** His notes are on each
card in that artifact and they are the work queue for the agents. The headline
findings:

- **Tenant is the problem; landlord is clean.** Four of six tenant
  conversations re-read their own previous answer instead of responding.
- **The agent invented a payment feature.** "Any unapplied remainder is used as
  pay-ahead credit" — the KB says the opposite in plain words. Fabricated,
  about money, tenant-facing, in two conversations. **Highest-priority agent
  fix.**
- Several of Nic's corrections are tone/completeness, not bugs: the late-fee
  answer should do the grace-period math out loud; the renewal answer should
  infer renewal from two messages and give tendency, never a number.

**Three cautions for whoever runs these next:**
1. **Run the batteries ALONE.** Two loads on the 36B kills it.
2. **The daily turn budget will silently eat your run.** 60 turns/tenant. Both
   harnesses now raise it via env; if you write a third, do the same.
3. **Roughly a third of everything these batteries flag is a wrong
   expectation.** Check the assertion before reporting an agent bug.

---

## 3. THE CO-OWNER PATH — SIX BUGS, ALL FOUND BY ONE REAL USER

Nic invited a partner (Blue) to co-own Oak Park. Every step broke.

1. **The invite died on the registration detour.** The accept page stashed the
   token; the registration page ignored it and jumped to the onboarding wizard,
   skipping the component that reads it. The comment claimed it survived both
   login and registration — it survived the one that was tested.
2. **He was nagged to set up a bank account** for the empty entity registering
   created. The task would not dismiss because it was not stale — it was TRUE
   about the wrong entity.
3. **Oak Park showed zero units.** `/units` filtered on the entity he
   registered under.
4. **Then payments, maintenance, documents and bookings were all empty** for
   the same reason.
5. **No way to add another entity at all.**
6. **A doubled email subject** ("...on GAM on GAM").

**THE PATTERN, and the thing to remember:** authorization was always correct —
`landlordOwns` accepts co-owned entities, so a co-owner could always OPEN any
record. What was narrow was ENUMERATION: list queries filtered on
`req.user.profileId`, the single entity you registered under. **A co-owner
could open a record they could not find.** That is why it presented as a
scatter of unrelated bugs.

`lib/landlordScope.ts` now holds the set (own + co-owned). Applied to units,
payments, maintenance, documents, bookings, todos.

**NOT SWEPT, DELIBERATELY.** ~380 uses of `profileId` across routes; most are
not entity scoping (a tenant's tenant id, a team member's user id, POS's
business). Widening blindly is a privilege change wearing a bug fix's clothes.
**If a co-owner reports a screen that is empty or thin with no error, it is
this bug again** — find the list query, use the helper.

---

## 4. MONEY — WHAT CHANGED AND WHAT IS STILL OPEN

**The rule (Nic):** a tenant who has paid is paid, platform-wide, the moment
they submit. "Our back end settling period doesn't matter to the landlord."

Already correct: late fees (an explicit postmark rule), the tenant's own
balance, portfolio stats. **Fixed:** the landlord's "who owes me money" list
counted in-flight payments as owing — Nic found his own $2 on it.

**GAM can now collect what it is owed.** `landlord_gam_charges` is a
per-landlord account of what GAM has charged and actually collected. Before
this, a landlord absorbing the $10 cash fee produced GAM revenue with **no
mechanism to collect it** — no money passes through GAM on a cash payment. The
code comment claimed payouts "net it out"; nothing did.

Collection order, per Nic: net it out of money already moving (normal), debit
only when the balance crosses the property threshold with nothing to take it
from (last resort, default $100, tunable). Near-misses are recorded on every
pass so the threshold can be tuned before it costs anything.

**`paymentReconcile.ts`** (twice daily) compares stuck payments against Stripe
and raises a critical alert on divergence. It does NOT settle — the settlement
path is ~500 lines of transfers and allocation, and reimplementing it is how a
payment gets applied twice. **The durable fix is an event backfill through the
same handler** (already idempotent on `stripe_event_id`), which needs the
handler extracted from the route first. That is the next money task.

### STILL OPEN — needs Nic

- **The $10 minimum contradicts the signed terms.** The platform agreement
  landlords accept says "$10.00 monthly minimum **per connected payout
  account**... separate entities each carry their own minimum." **The code
  charges it per PROPERTY.** A landlord with four properties on one payout
  account is billed $40 against a contract that says $10. That is the code
  disagreeing with the contract in GAM's favour. Fix on those grounds; the
  fairness debate is separate.
- **Full subscription out of the first disbursement.** Nic: "we get paid no
  matter if the tenant pays or not... we come first." Today GAM's cut is
  skimmed per payment and tracks collection rate. Not built.
- **The Next Disbursement KPI card is wrong in all three parts.** The dollar
  figure reads an empty log of PAST payouts (always $0). "Next payout Aug 28"
  is the browser computing next Friday — nothing to do with the 50%/90%
  thresholds. The dot is decorative. Nic: it "should show what's gonna be going
  into the landlord's bank account." Blocked on the first-disbursement rule.

---

## 5. MULTI-ENTITY — BUILT THIS SESSION

Same land owner, different LLCs. **The switcher was built and then removed** —
Nic: "the dashboard should show everything that they own even if it's ten
entities worth billions." A switcher makes you operate inside one entity at a
time, which is the opposite.

What shipped: create/list entity routes, an **Entity picker on the Add Property
form with "+ Add a new entity…" inline** (no round trip to Settings), and a
co-owner now lands in the entity they were invited to.

`users.active_landlord_id` exists and login prefers it, with the old lookup as
fallback — that was needed because the active entity was DERIVED from "the
landlords row where you are the owner", which returns two rows once you own two
and picks one arbitrarily.

**Open:** should dashboard money figures (disbursements, platform fee) combine
across entities or break out per entity? Payouts land in separate bank
accounts, so one combined "next disbursement" could mislead.

---

## 5b. SETTINGS PAGE — NIC'S OPEN LIST

Reviewed live at the end of the session. Fixed: **"bank account not
configured"** showed for a landlord whose Stripe Connect payouts are live —
the flag read only the legacy bank catalog, not Connect, which is how payouts
actually work. The same fix landed on /me/todos in S605 and `/auth/me` was
missed. Both now mean "GAM can pay you".

Still open, in Nic's words:

- **"Maintenance approval threshold... should be scoped per property, not on
  the entity level."** It sits on the entity today. A real change — the
  threshold is read wherever maintenance approval is gated.
- **Business name and EIN are empty on the account card.** Not a bug — unset
  data on Nic's Oak Park entity. Worth filling in: it is also why the co-owner
  invite email said "a property" instead of naming it.
- **"That settings main overview page needs to be relinked to whatever route it
  actually needs nowadays."** Nic suspects an abandoned route. There is only
  ONE SettingsPage and one /settings route, so nothing is stale in the routing
  — but the page has grown by accretion and he finds it disorienting. Worth a
  pass for structure, not plumbing.
- **The entities section is live** (verified in the deployed bundle); Nic was
  on a cached page. If it looks missing again, hard-refresh first.

---

## 6. MISTAKES THIS SESSION

- **I over-concluded from one Stripe field.** `amount_received: 0` on a
  PaymentIntent, and I told Nic the money never arrived. The BALANCE
  TRANSACTION said `available` — Stripe had it. I also reported a 14-day stall
  built from joining our row's `created_at` to Stripe's charge date. Nic pushed
  back and was right both times. **Read the balance transaction, not just the
  intent.**
- **A fix shipped and did nothing.** The run-on-list rule sat before the bold
  strip, so its lookahead saw `*` not the letter. Source transformed the string
  correctly every time I called it; the deployed process kept returning the
  wall. Found by wrapping the real function in the deployed build and printing
  its input.
- **I nearly deleted a co-owner's entity on Nic's instruction.** Checking first
  showed it would have left him with no active entity at all — his session
  resolves from "the entity you own", and Oak Park's owner is Nic.
- **The camelize guard caught my own bug** — a UI I wrote read snake_case off a
  camelized response. Every field would have been `undefined`.
- **Two false-pass tests of mine**, both found by the guard test beside them.

---

## 7. COMMANDS

```
bash deploy.sh                                    # every surface, verifies
cd apps/api && DB_NAME=gam_test npx vitest run    # NEVER without DB_NAME
DB_NAME=gam npx ts-node src/services/agents/agentBattery.ts        # single-turn
DB_NAME=gam npx ts-node src/services/agents/agentConversations.ts  # two-turn
DB_NAME=gam node -r ts-node/register src/services/agents/ingestKnowledge.ts
```

Re-ingest after ANY knowledge-content edit. Run batteries alone.

# S626 OVERNIGHT — AGENT WORK LOG

Running log. Appended as I go so the thread survives context compaction.
Nic's authorisations this session:
- **Deploy when green** — full suite + eval green and transcripts reading well → ship it.
- **After a panic:** recover, wait for load to settle, resume GPU work at a
  SLOWER cadence. Stop GPU work only on a SECOND panic tonight.
- **Agents only.** No fallback work. If blocked, keep grinding on agents.

Bar for grading (Nic's, from AGENT_TWO_TURN_REVIEW.md): not "did it call the
right tool" but **would a person walk away with the right idea?**

---

## Iteration 0 — harness safety + measurement (no GPU)

`agentConversations.ts` had neither of the two things that make an overnight
loop possible:

- **No pacing.** agentEval.ts pauses 3s between cases. This harness paused not
  at all, and it is the heavier job: every conversation is TWO generations and
  turn two always carries history so it can never be cache-served. It was the
  un-paced GPU job on a box that kernel-panicked twice today. Now defaults to
  `AGENT_EVAL_PAUSE_MS=5000` between conversations.
- **No seed.** Agents sample at temperature 0.6. Unseeded, a re-run of a
  byte-identical file disagrees with itself — which is exactly how S624 came to
  revert good work over a 4-point swing that was noise. Now seeded to 424242,
  same as the eval.

Both are prerequisites for "change it, re-run it, keep it or revert it".

---

## Iteration 1 — the repeat bug: TWO bugs, not one

Tenant baseline **1/6**. Four of the five failures were `REPEATS_TURN_1`.

**Bug 1 — the account-data net was manufacturing the repeat.** Its own STOP text
opens *"your last answer stated account-specific facts without fetching them"* —
and nothing checked that it had. `demandsAToolCall` defaults to TRUE for tenants
and landlords, so any follow-up that was not a bare "ok" satisfied it, including
a decline. Measured: tenant hears their balance, says *"no thanks, I'll sort it
out myself later"*, model replies appropriately and tool-lessly, the net fires on
a reply containing no figures at all, forces `get_my_payment_status`, and the
model — told to "answer from its result" — reissues the $2,330 breakdown
verbatim. **The guard against invented numbers was generating the repeat.**

Fixed by making the net check its own premise (the same three-way test the step
ceiling has always used), **scoped to follow-up turns only**. Turn one keeps the
old aggression on purpose: the unit suite caught that `assertsStoredFacts` does
not detect a bare ordinal, so *"rent is due on the 1st"* stated with no lookup
must still be forced through a tool. Relaxing that on turn one was a real
regression and the tests found it in seconds.

**Bug 2 — nothing in the guard chain looked ACROSS turns.** `collapseRepetition`
dedupes lines within one reply and has no idea what was said a moment ago. Added
`repeatsPreviousReply` + a net that forces one rewrite when turn two reissues
turn one. 8 unit tests.

**Tenant 1/6 → 3/6**, same seed. The decline now reads: *"Okay, no problem. Let
me know if you need anything else later."*

466/466 agent unit tests green.

### Still failing
- `deposit-then-correction` — repeat net FIRES but the rewrite reproduces the
  same sentence. The instruction says "do not restate the figures", and here
  restating the figure IS the answer — they asked the agent to double-check it.
  The instruction is self-contradictory for a verification request.
- `late-fee-then-waive` — no escalation.
- `lease-end-then-renewal` — no tool, and it promises to submit a renewal request.
---

## Iteration 2 — tenant 1/6 → 6/6

| conversation | before | after |
|---|---|---|
| balance-then-pay-half | REPEATS | ✓ |
| late-fee-then-waive | WRONGTOOL + REPEATS | ✓ |
| lease-end-then-renewal | WRONGTOOL | ✓ |
| maintenance-then-accept | ✓ | ✓ |
| deposit-then-correction | REPEATS | ✓ |
| balance-then-decline | UNWANTEDTOOL + REPEATS | ✓ |

Four fixes. Two were code, one was routing, **one was a wrong assertion** —
`late-fee-then-waive` demanded an escalation while `profiles.ts` says in Nic's
own words *"do not offer to waive it and do not hint that the landlord might."*
Escalating IS floating it, so the suite failed the agent every time it obeyed
the prompt. Fourth assertion in this file to punish correct behaviour.

**The lesson worth keeping:** the waiver arithmetic had been written into
`profiles.ts` since S624 and was followed on **none** of the runs. Telling the
model the ANSWER failed twice — it had no reason to contradict the customer's
own count. Giving it the REASONING worked first time: the fee cannot be charged
before the grace period ends, they *have* been charged, so their "two days" is
two days past the grace = seven past the due date.

> "The fee only kicks in after the 5-day grace period, so by the time it applied,
> you were 7 days past due, not 2."

That generalises: **a directive the model won't follow is usually one it can't
justify.** Supply the reasoning, not the conclusion.

493 agent unit tests (17 new). Committed `7fba8cb`.
---

## Iteration 3 — eval holds at 45/45, and a prompt that argued with itself

Graded eval re-run at commit `7fba8cb`, paced 5000ms: **45/45, no regression.**
The tenant work cost nothing on tool selection.

Then a batch of non-GPU fixes from Nic's remaining notes:

**"what's chen's balance?" searched for a tenant named "what's Chen".** The name
patterns allow an apostrophe (for O'Brien) and allow two words (for "Frank
Chen"); together they swallow the interrogative. Leading and trailing question
words are now stripped. Nic: *"The question word gives away that no human is
reading it."*

**The drill-down would have been broken by my own anaphora fix.** Stage one
skips routes the previous turn already matched — right for a new subject, wrong
for "how many are vacant?" → "which of those are at Sunset Palms?", which is the
SAME query narrowed. Added a second stage for it, args taken from the new turn.

**The booking tool handed the model the exact phrase Nic banned.**
`check_availability` returned the bare string *"That check-in date is in the
past."* `profiles.ts` already says to ask which month instead — but a prompt
bullet loses to a tool result every time, because the result is the most recent
and most specific thing in context. The error now carries the instruction, plus
the month they most likely meant.

**Lucy's prompt forbade a phrase on line 343 and demonstrated it on line 372.**
The rule says never say the price *"depends on your setup"*. Her own example
dialogue said: *"The real number depends on your setup though."* Models copy
examples far harder than they follow rules, which is why the S624 fix never
took. Fixed in the example, the rule, and `sales/what-gam-is.md`.

**`get_guest_amenities` filtered on `AND reservable`** — while being the tool
that answers "is there a pool?". Community Laundry is active and not
reservable, so a guest asking about laundry was told the property has none.

Plus: expiry answers now ask which way they're leaning; an extra night quotes
the actual nightly rate instead of "settled with the property as usual"; the
rate card must quote the weekly figure rather than allude to it.

509 agent unit tests.

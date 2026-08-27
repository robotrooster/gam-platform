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

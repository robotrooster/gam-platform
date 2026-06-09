# Session 228 — closed

## Theme

DEFERRED.md hygiene pass. The file had grown to 593 lines, most of
it shipped-item audit trail repeated from session handoffs. Restructured
to a lean 214-line queue (64% reduction) that future session-openers
can scan in 30 seconds.

## What S228 shipped

### Restructure of `DEFERRED.md`

Old shape:
- 4 vintage-S60 sections ("Closed in S59," "Reconciled out at S60,"
  "NEW at S60") that were a snapshot anchor at S60 and stopped being
  useful around S100
- Harness-tracked phantom-tables/columns inventory frozen at S60
  (most tables long since shipped per items 5/6/8/11/14)
- 19 numbered "Build sessions" each with multi-paragraph SHIPPED
  context that duplicates what's in the matching handoffs
- Smaller-tracked items mixing closed tombstones with open work
- npm vulns block

New shape:
- **Open — pick one** (~70 lines): the actual queue, organized by
  area (Backend / data, POS, E-sign, Background-check, Smaller
  items, Harness extension)
- **Pre-launch — hidden behind launch flag** (~15 lines): the S177
  carve-outs (Flex Suite, OTP, Sublease, Tenant-pool refinements)
- **Blocked / multi-session** (~25 lines): Stripe Connect S113,
  Marketing rebuild, Flex tenant suite, POS Terminal hardware,
  Owner-financial-escalation pattern, Primary manager urgency tier,
  npm audit vulns
- **Closed — major-item tombstones** (~60 lines): one paragraph per
  major shipped subsystem, only items whose closure context shapes
  future decisions. Detailed shipped-batch breakdowns moved to
  `SESSION_*_HANDOFF.md`.
- **Struck — kept as tombstones** (~5 lines): two items explicitly
  removed by Nic at S177.

### What was struck (no longer in DEFERRED)

- **"Closed in S59"** intro — historical anchor, not load-bearing
- **"Reconciled out at S60"** — audit trail of what S60 considered
  and discarded; not relevant to future decisions
- **"NEW at S60 — books_access table phantom"** — superseded S91 by
  consolidation onto `bookkeeper_scopes`
- **Harness-tracked phantom tables list (25 entries)** — all but
  the Flex Suite tables shipped (S88/S89/S91/S92/S93). The Flex
  tables now live under "Pre-launch hidden behind flag."
- **Phantom columns list (21 across 5 tables)** — `team_members`
  dropped in S80, `unit_bookings` + `units` cols shipped S92, leaving
  only Flex/OTP cols which are now under "Pre-launch."
- **Item 16 / 16a** detailed bank-rail-TBD architecture — SUPERSEDED
  by S113 destination-charges-via-Connect-Express. The supersession
  is now a single tombstone line referencing S113.
- **Item 18 detailed batch breakdowns** — all 6 batches shipped;
  compressed to one tombstone line.
- **Item 8 (a/b/c/d) Team UI rebuild** detailed sub-item breakdown —
  all four shipped; compressed.
- **Item 17 + 17a** permission gating audit detailed leak inventory —
  shipped; compressed to one tombstone.
- **Items 5, 6, 7, 9, 11, 12, 13, 19** — all SHIPPED; detailed
  context compressed to tombstones.
- **The "Standing rule for each batch" guidance for item 18** —
  redundant with CLAUDE.md's "Single source of truth for enums and
  CHECK constraints" section.

### What was preserved

- **Items 1, 3, 4, 10, 14, 15, 16** — still have open sub-items;
  the open work moved to "Open — pick one," the closed batches to
  the tombstone section.
- **The S113 supersession of S78** — load-bearing; future-Claude
  needs to know the bank-rail plan is dead.
- **The S177 reclassification** — load-bearing for "is this v1 or
  hidden-behind-flag" decisions.
- **The tombstones for Property late-fee policy + Add Lease button +
  POS category FK refactor** — recently shipped, useful context for
  next-session scope-shaping.
- **The two struck-at-S177 items** — kept as tombstones so they don't
  re-appear in future audits.
- **Credit Ledger v1 tombstone** — moved from CLAUDE.md context only
  into DEFERRED's closed section so it shows up in audits.

### Files touched (S228)

```
DEFERRED.md                                  (full rewrite — 593 → 214 lines)
```

No code changes. No migrations. No typechecks needed.

## Decisions made (S228)

| Question | Decision |
|---|---|
| Surgical edits or full rewrite? | Full rewrite. The structural problem was bigger than any individual stale entry — sections were organized by historical-event ("Closed in S59," "NEW at S60") instead of by decision-making-utility (open vs blocked vs closed). Surgical edits would have preserved the bad structure. |
| Keep the harness-tracked phantom inventory? | No. Mostly stale; what remains is captured under "Pre-launch hidden behind flag" (Flex/OTP) where it's actionable, not as a phantom-tables-from-S60 list. |
| How aggressive on tombstones? | Keep tombstones for items whose closure context shapes future decisions (e.g., "AZ-policy strip" → reinforces no-state-legal-logic rule; "Stripe inbound batches" → flags the S113 supersession). Drop tombstones for routine subsystem builds whose closure context is fully captured in handoffs. |
| Preserve item-numbering (1, 3, 4, 10, 14, 15, 16)? | No. The numbering was an S60 build-order artifact. Future-Claude doesn't need to know "this was item 14" — they need to know "POS subsystem follow-ups: <list>." Reorganized by area. |
| Move shipped-but-load-bearing context (e.g., Stripe S113 supersession) to tombstones or to the Blocked section? | The active-future-work blob lives in "Blocked / multi-session" (where the S113 rebuild itself is); the historical fact that it superseded the prior plan lives in the tombstone for "Stripe inbound batches (item 16)." |

## Carry-forward — S229+

DEFERRED.md is now the single accurate place to look. The "Open —
pick one" section contains every concretely-actionable item. Pick
from there next session, or pick from "Blocked / multi-session" if
ready to commit to a multi-session arc.

**No new carry-forward from this session.** Closing on this hygiene
pass.

---

End of S228 handoff.

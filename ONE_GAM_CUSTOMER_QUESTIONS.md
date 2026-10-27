# One GAM customer — what's built, and the questions waiting on you

Written 10/25, updated 10/26. Built so far, tested, **not deployed**.
Five questions are still yours; #4 you answered on 10/26 and it is closed.

## Built

**The spine.** `customer_profiles` (one person) + `customer_profile_links` (every
place they turn up: resident row, register customer, business customer). Identity
only — name, phone, email. No balance, no lease, no payment history, no card.
A profile is not a login, so the 749 register customers who'll never sign in
still get one.

**The three-point rule**, one definition in `packages/shared/src/customerMatch.ts`,
used by anything that has to decide who somebody is. Points are first name ·
last name · phone · email · a saved payment method. Three agree = same person.
Tested hard on what must *not* match: two Mike Smiths on different numbers, a
blank counting as agreement, a household phone shared by two people, a row
holding only a first name.

**The second factor you described.** `pay_code_hash` on the profile — 6–8 digits,
bcrypt-hashed, never stored/returned/logged/emailed in the clear. Five wrong
codes locks the account 15 minutes; the count is on the *account*, not a session,
because the attacker picks where to try from. "No such customer", "no code set"
and "wrong code" all refuse with identical wording, so nobody can map which
accounts are worth attacking. Runs and repeats (123456, 000000) are refused.

**Isolation.** Two different reads, not interchangeable:
- `lookupForBusiness()` — name and phone only. What the register, a reservation
  or the mechanic gets, so they can pick someone they've seen instead of
  retyping. Never says where else that person appears. No email.
- `appearancesForAdmin()` — the whole picture, GAM staff only. Knowing your
  resident also shops at the grocery store isn't yours because you both use GAM.

**Editable points.** Phone changes don't make a second person; who changed them
and when is recorded.

## Questions — these are yours, not mine to guess

1. **Who sets the code, and how, for someone with no login?** 749 register
   customers have no GAM account. A code they set at the counter is a code the
   counter saw, which defeats it. Options: a one-time link texted/emailed to
   them; they set it the first time they pay this way; or it's only for people
   who do have a login, and everyone else keeps paying as now.

2. **What does the code authorize — one charge, or a session?** One bill at a
   time is safest. "The rest of this visit" is friendlier at a mechanic running
   up a tab. Different blast radius if a code leaks.

3. **Is there a ceiling without a second factor on top?** You raised daily
   limits for Venmo yourself. A $40 propane fill and a $4,000 transmission
   aren't the same risk on six memorized digits.

4. ~~**Who eats a disputed cross-business charge?**~~ **ANSWERED 10/26.** You:
   "We're not tracking disputed charges. We're tracking there's a payment
   arrangement, we're tracking that we were handed the money. We're not tracking
   what the contract is. We're not tracking what the late fees are. We're
   tracking how much was supposed to come in and for how long, and that's it."
   So there is no dispute ledger to build here, and nothing records who bears
   one. Closed.

5. **Does a business see that a customer *has* a code?** Knowing who can pay
   this way is useful at a counter and is also a map of which accounts are worth
   attacking.

6. **The 749 backfill.** 574 carry first+last+phone, so they link cleanly. The
   other ~175 don't have three points and will stay unlinked until someone fills
   in a phone — correct, but it means the lookup won't find them. Worth a
   "finish this customer" prompt at the counter, or leave them?

## Not built, on purpose

Actually charging across businesses. The credential exists; the money rail
doesn't. Every question above has to be answered before money moves on a phone
number plus six digits, and I'd rather ship the identity and the factor than
guess at a payment rail.

---

# 10/26 — the takeover invite, done

**The problem you hit:** approve an applicant for a takeover, go to invite them,
and the unit list only offered vacancies — there was no way to pick an occupied
spot and start the handoff.

**What it does now.** `canTakeOverUnit()` in
`apps/landlord/src/lib/inviteEligibility.ts` decides what can be taken over: an
occupied spot can, a vacancy cannot (that is an ordinary invite), a spot already
promised to an incoming lease cannot (the one-space-two-households guard), and an
owner-occupied unit never can. The invite modal lists those as their own group,
"Taking over an occupied spot", kept separate from the vacancies so a routine
invite can still never land on an occupied space by accident. Each row names who
is sitting there. Selecting one drafts the lease for that spot and the existing
e-sign machinery carries it; `whySpotCannotBeTakenOver` already guarded the
signing end, so the API needed no change. The modal's copy and the "why isn't my
unit here" list both read correctly for a takeover.

Tested: 9 tests on the eligibility rule, plus the modal's own.

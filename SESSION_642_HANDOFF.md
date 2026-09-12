# SESSION 642 HANDOFF — read this FIRST

Supersedes `SESSION_641_HANDOFF.md`, which was written mid-session and then
overtaken by most of a day's work. Durable decisions live in the memory system
(auto-loads via MEMORY.md); this file is the pointer to where the **money** and
the **live product** stand right now.

**Everything below is committed AND deployed.** Working tree clean, 7,233 tests
green, all surfaces in sync. Nothing is waiting on a deploy.

Written the evening of **Friday 2026-09-11**. Next dates that matter:
DigitalOcean migration **Saturday the 12th**, first unattended payout
**Wednesday the 16th**, first month-end sweep **around the 28th**.

---

## Live state

| | |
|---|---|
| Occupied units | 38 |
| Settled, last 30 days | $15,917.96 across 57 payments |
| Open charges | 5, totalling $1,681.37 |
| Leases awaiting signature | 11 |
| Stalled bank setups | 3 |

Mountain View has been paid once: **$2,638.11**, by hand. Every payout so far
has been pushed manually.

---

## The next three things, in order

### 1. DigitalOcean — tomorrow (Sat 12th)

**Nic (S641), and this REVERSES the older plan:** *"When we're ready to get the
server that's hosted somewhere else — DigitalOcean — that way payments are
always available to be made if the power goes out here, or this computer shuts
off or dies. I only want the agents on this computer."*

So: **API + Postgres + payment webhooks move off the Mac Studio. The AI agents
stay on it.** The old note in `LAUNCH.md` §2c said the opposite (move the MODEL
off); Nic's framing is better — the side that moves is the one that must never
be unavailable, and that is not the agents.

**The thing most likely to break rent silently:** Stripe webhooks point at this
API, so their endpoint moves with it. Miss that and payments stop being
recorded while everything still *looks* fine. Check it first and check it last.

Jitsi already has its own droplet (`146.190.145.126`, `ssh -i ~/.ssh/gam_jitsi`)
— this is a second one, not a shared host. Marketing on :3004 stays on the
Studio. See [[gam-payments-offsite-agents-local]].

### 2. Watch the two unattended runs

- **Wednesday 16th, 6pm Phoenix** — the payout cron fires; Stripe books it
  Thursday. First one nobody pushes by hand.
- **Around the 28th** — the month-end sweep, so the month's money lands before
  the last business day. Never run in production.

### 3. FlexPay / FlexDeposit — being redesigned in a parallel chat

Nic is working through a restructure in another window. **Where the code
actually is today**, verified against the database rather than the docs:

- Tables exist and are **completely unused**: `flexpay_advances` 0 rows,
  `flex_deposit_installments` 0 rows, `flexsuite_enrollment_acceptances` 0 rows,
  `flexpay_blocked_states` 0 rows. Nothing is live, nobody is enrolled.
- The **deposit trust model** is built (hold / never-batch / interest / split /
  agent copy / admin surface / staged marketing) and **gated on Nic standing up
  the FBO trust account** with a physical sweep. That gate has not moved.
- **FlexDeposit is approved in direction, not built**: everyone eligible (no
  SSI/SSDI gate — anti-discrimination), start at a 2-way split of the deposit,
  widen to 3 then 4 as default data proves out, target gap losses ≤1% of
  FlexDeposit revenue.
- **Still-open decisions B, C, D** from S602: tenure/on-time gates before
  enrolment, flat-2 cap vs risk tiers, and whether the move-out gap is funded
  from the trust pool or a GAM loss reserve.

Because none of it is live and nothing is enrolled, a restructure costs no
migration of real records — which is exactly why rolling it out sooner is
realistic. Read [[gam-deposit-trust-model]] and [[gam-flexpay-float-funding]]
before touching it, and note the product-siloing rule
([[gam-agent-product-siloing]]): landlord-side agents must never mention
FlexPay/FlexDeposit, tenant-side agents must never mention FlexVault.

---

## What shipped today (31 commits)

**Money and billing**
- **Tenants are finally told their bill exists.** Invoice generation sent no
  email at all — the only billing mail anyone had ever received was a late
  notice. Now it goes at 7am in the property's own timezone, deliberately not
  earlier, so a payment cannot be dragged into the wrong month's books.
- **Mountain View was quoting $0 platform fee on 25 billable units.** The
  dashboard priced one entity and listed properties across both, so anything
  under the other company fell through to zero. Display only — billing was
  always correct.
- Unit counts on the dashboard reconcile: Occupied Units counts everything not
  vacant, and Expected Monthly Rent reads "payable across 31 of 37".
- The work-trade subtext is gone from the rent card.

**The front desk (Lisa Scheeler, on-site manager at Mountain View)**
- She can record cash/check/money-order payments, hand change back, or leave an
  overpayment on the account for next month. She cannot issue a discretionary
  credit — see [[gam-two-kinds-of-credit]] for why those are different acts.
- Her Payments tab shows outstanding balances only: no payment history, no
  work-trade rows (stripped from the RESPONSE, not hidden on screen).
- **Two buttons were showing to people the server would refuse** — Issue Credit
  and Record payment. Both now match the server.
- **Her Record payment button vanished because of a wire bug**: `take_payment`
  is the only permission key without a dot in it, so the response camelizer
  rewrote it to `takePayment` and the gate never matched. Fixed on both sides.

**E-signature**
- **Signing packages.** A package lives at the landlord, is bound to a unit
  type, and assembles the lease plus whatever else applies into ONE signing
  session. Country Acres is the case: lot lease and rent-to-own are one flat
  five-year figure today, and splitting them only works if both are signed
  together.
- Templates pin to any number of properties; no pins means everywhere.
- Renewal is decided per ITEM: renews with the lease, once per tenancy, or
  re-issued when the document version changes.
- The printed name under a landlord signature now follows whoever actually
  signed, not the account owner.
- Template fields can carry a default answer; a ticked box draws an X or a
  check, never a filled square.

**Units and tenancies**
- **Buildings exist.** Uniqueness is property + building + number, so apartment
  101 can live in Building 1 and Building 2.
- **Renaming a unit is allowed again**, because `unit_number_history` now
  records every period a space carried a number. Leases and invoices render the
  number the space held on THEIR OWN date.
- **A resident can move spaces without ending their tenancy** — same lease,
  same rent, same terms. Leases page → the row → **Move spot**. It names the
  closing and opening meter reads, and raises a prompt that chases them.
- **Bills follow who occupied the space**, so a mid-month move produces two
  labelled lines instead of one blended charge.

**Documents**
- Documents belong to a property and pin to as many as apply; no pins means
  everywhere. Park rules, notices, disclosures — the filing cabinet.

**Bank setup and email**
- An unfinished bank setup is now chased: the tenant is told the moment the
  deposit is sent, then again if they have not confirmed. Copy is driven by what
  Stripe reports — this account verifies by **descriptor code**, one deposit with
  a six-character code, NOT two amounts.
- Every emailed link points at the real site. `LANDLORD_PORTAL_URL` had never
  existed in any environment, so every team invitation ever sent pointed at
  localhost.
- Password resets for on-site managers, bookkeepers and maintenance went to the
  TENANT portal. All landlord-side roles now resolve correctly.
- A suppressed email is logged as `suppressed`, not `sent`.

---

## Still open

**Decided, designed, not built**
- **Retire & replace a unit** — the blocking half shipped and the rename lock is
  gone; the actual retire→replace flow (for a space that genuinely becomes a
  different space, e.g. a double lot split in two) is not built. Rarer than
  renumbering, which is now handled.

**Known gaps, deliberately not fixed**
- Bulk numbering cannot generate letter suffixes. Nic: a one-time onboarding
  chore, not worth the machinery.
- The meter-read prompt after a move is a notification, not a reading run that
  opens itself.

**Watching**
- 3 stalled bank setups. Dominic Gonzalez started 2026-09-02 and the deposit
  landed on the 3rd; the chase now runs daily at 9:30am Phoenix.
- 11 leases awaiting signature.

---

## Rules I broke today — do not repeat

- **Never stack background deploys.** Two ran at once with four vitest workers
  fighting over `gam_test`, producing phantom "TESTS FAILED" with no real
  failure. Check `pgrep -f "bash deploy.sh"` before every run.
- **A test suite could put real email on the wire.** One file set
  `EMAIL_SEND_LIVE=1` without clearing it; vitest shares a process, and six real
  signup alerts reached Nic's inbox. Now cleared by a setupFiles hook no file
  can forget.
- **Do not read the punchlist to Nic as if it were current.** Three "open
  decisions" — multi-entity signup, bank-after-units, the ACH fee election —
  were all shipped months ago, and I put all three to him as outstanding in one
  day. Verify against the code and the database.
- **Deploy when a category closes, without asking** ([[gam-deploy-when-a-category-closes]]).
  A stale screen makes Nic re-debug things that are already fixed.

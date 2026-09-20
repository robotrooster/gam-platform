# Session 650 Handoff — 2026-09-19

## Handoff corrections (S649 said X, the code says Y)
- **"pos.goldassetmanagement.com not live"** — it was live (Ready, 15 h before this session).
- **Andres Razo** — listed as both "waiting on Nic's yes" and "done". Done: no invite, no lease, no holds on RV 27.
- **Ray's RV 09 meter "will keep producing held electric"** — no. Holds need an open invite (Ray's are cancelled), and a new RV 09 tenant can't inherit his usage (S649 rule).
- **"Tax can only be set on a category"** — wrong. Items could pick a named tax, but that pick was **never charged** (see Register below).
- **"9 units on work trade = snowbirds"** — wrong. They are the 9 active work-trade agreements at Mountain View (Lisa Scheeler MH 01, Nic MH 02, Ruben Negrete MH 05, Brandon Valdez MH 10, Bret Robinson MH 20, Ignacio Gutierrez RV 08, Matthew Conklin RV 45, Scott Johnson RV 50, John Kvasnicka RV 51). 32 + 9 = 41, so the counts reconcile.
- **Dashboard small print** was the work-trade suspended balance, not utilities.
- **"Keep the concurrency gate at 1"** — the code has 6 (AGENT_MAX_CONCURRENT default). Left at 6; memory is now byte-capped (below).
- **gam_demo was 3 weeks behind on migrations** (last applied 2026-08-29). Agent evals were crashing on missing columns. Migrated this session; one demo fee row parked in `s650_demo_fee_schedule_backup`.
- **Eval harness landlord actor had no `landlordIds`** since S634, so every landlord eval case saw an empty portfolio. Fixed.

## Nic's answers this session (directives, saved to memory)
- Held utilities nobody claims by the onboarding window's close = settled off-platform; bill nobody. (RV 16 = Harold Cunningham, off-platform; RV 30 moved out.)
- Taxes: landlord-named taxes, assigned to single items or whole categories. AZ TPT is one combined tax. Propane = 6.35% TPT; electricity untaxed.
- Landlord new-reservation form: dates → "Show available" (filter out any site with any overlap) → pick site → lock vs let auto-schedule move it → name/phone/email → deposit pay link. **Nic expects follow-up questions before build.**
- Screening: availability should be checked BEFORE the paid background check (unit type / RV size / has RV). **Design with Nic.**
- Disbursements: "give it your best shot" — built, Nic reviews.
- Mattoon water meters: Nic sends details later.
- Agents: priority one. Primary goal = narrow a vague question, confirm, then resolve.
- Agent pacing is deliberate: back-end speed is fair game, the customer-facing reply stays human-paced (reading delay + typing). Do not speed that up.
- Ellen Gregory's two emails are two different people (her and her daughter), not duplicates.
- Lisa Scheeler rings sales and takes payments; only the administrative register functions (tax rates, discounts, inventory counts, item setup) stay restricted.
- Nothing in the register is freely typable except a quantity. "+ Open Item" removed — a one-off goes on a lease or a pay link.
- FlexCharge is not a launch item and must not be visible or named anywhere.
- Email gets verified by the invite → signup → lease-signing flow, not by a separate email.
- **Bill up front everything that can be billed up front.** Arrears is only for things that can't be counted in advance (short-stay nights).
- **A hibernating spot still carries the platform fee.** Landlord→tenant billing pauses; the spot is still occupied and can't be re-let, so GAM still bills the landlord.
- **Never ACH-debit a landlord by default** — take it out of the money flowing through. When the debit is built for all-cash properties, **the bank cost is its own line item** so the landlord doesn't dispute the charge.
- August must read $0 of real revenue. The $50 platform fee there was fabricated; the only August money was Nic's own test charges.
- Renter pool must not be pinned to a property (design below).

## Done (committed; see deploy status at the bottom)
### Agents (David/Ava/all) — speed and crashes
- **Root cause of the crashes:** Hermes 36B KV cache is 256 KB/token; a landlord turn was ~25k tokens (6.5 GB) and 6 cached conversations exceeded the GPU limit. `--prompt-cache-bytes` never applied on the single-request path.
- **ops/mlx_server.py** launches mlx_lm.server with the prompt cache capped at 20 GB on every path and MLX's buffer cache at 4 GB. com.gam.model now runs it (plist copy in ops/). Verified: cache holds at ~19 GB and evicts.
- **Real speed:** prefill ~180 tok/s, decode ~18 tok/s on this Mac (not 1,000). Tokens are the only lever.
- Shared agent rules 24 KB → 6 KB (every rule kept, incident stories removed); profiles ~31 KB → ~10 KB.
- 10 actions offered per turn instead of 24 (~9k → ~3.5k tokens); escalation tools last so a forced turn keeps the cached prompt.
- The phrase-table lookup runs BEFORE the first model call when the message itself plainly needs it (reads only). Saves one whole model call.
- "Are you there?" no longer forces a lookup; "It says get paid" routes to setup progress; max reply 600 tokens; one log line per model call (prompt/cached tokens, ms).
- **Bench (5 David questions, demo):** 128 s mean → 47 s. `DB_NAME=gam_demo npx tsx src/services/agents/latencyBench.ts landlord`.
- **Two-turn eval (29 conversations, demo DB, seed 424242, fixed harness):** pre-session code 19/29; new code 19/29 — same quality at ~2.7x the speed. Fixes after that run: declines aren't account questions; the lookup fallback never re-runs last turn's lookup unchanged (4 failures traced to it); "waive the late fee on 204" looks up 204 first. Final run on current code: **20/29** (within run-to-run noise of 19; no regression). After that run: David writes a notice's wording himself (rule restored).
- Remaining failures are mostly demo-data drift ("spot 7"/"spot 12" don't exist in demo; Chen's balance changed from the case's $2,330) and the pay-rent quote flow.
- **Maintenance requests** waited on the AI priority for up to 3 minutes when the model was busy; now 8 s, then keyword rules.

### Your list
- **#1 Held utilities expire with the window** — holds only while the window is open; nightly 3:40 closes out unclaimed holds as "settled off-platform", kept for the record.
- **#2 Register taxes** — one list of named taxes; each applies to everything, whole categories, or single items (Taxes tab + checkboxes in the item editor). The old per-item "Tax Category" was never charged by the server; replaced. Sales store taxes by name; cart and receipt print "Lodging tax $x". Both register apps identical.
- **#3 Front-counter lockdown** — server now holds staff without "Apply discounts" to catalog prices and refuses discounts (it trusted the browser's prices before). Inventory/items/tax/settings were already server-gated.
- **#5 Master Schedule** — RV spots first, mobile homes last, numbers sort as numbers.
- **#7 Dashboard** — work-trade small print removed.
- **#8 Disbursements** — page opens with one flow: clearing at tenants' banks → cleared, held for you → sent to your bank on <date> (or "link your bank"), with every payment in the next payout listed. The $495 = one Mountain View rent payment.
- **#12 Hibernation** — hibernating leases now bill no utilities, take no RUBS share, and sit apart on the rent roll / Expected Monthly Rent.
- **#14 Admin 2FA** — the admin console used the plain login, so a landlord email + password got a code sent to the landlord inbox. Staff consoles now refuse non-staff accounts before any code goes out; autofill off on the admin email field.
- **#16 Landlord count** — counts people who brought a property (4: Nic, Blu Haws, Nicholas Fausett, Phil Brewerton) plus "3 signed up, no property yet". Co-owners and second LLCs don't inflate it.
- API: `GAM_DISABLE_SCHEDULER=1` lets a preview API run against gam_demo without the nightly jobs.

## Production data changes this session (backups: ~/gam-backups/s650-*)
- Mountain View RV 16 ($192.36) and RV 30 ($147.42) held electric closed out as settled off-platform (Nic's directive).
- Scott Johnson (RV 50) and John Kvasnicka (RV 51) leases hibernated; their work-trade agreements paused with them.
- Mountain View register taxes: "Lodging tax" 6.35% on RV site daily + weekly; "Transaction privilege tax" 6.35% on Propane. Monthly stay and electric untaxed.
- gam_demo migrated to current (one stale demo fee row parked in s650_demo_fee_schedule_backup).

## Deploy status
- Deployed and verified via deploy.sh (API, landlord, admin, pos, marketing) at commit 7836c5e; agent fixes through f8d49a4 redeployed afterwards (API only).
- **admin-ops is not in deploy.sh** — its login change (sends portal: 'admin_ops') isn't live; harmless (old client just skips the staff gate).
- Model server runs ops/mlx_server.py (20 GB prompt-cache cap) since 09:04.

## The evening's work (everything after Nic got back)

### Money failing to move — the #1 item
**What was wrong:** the Tuesday batch claimed the full $4,154.89 of tenant rent from GAM's platform balance and handed Stripe a transfer for the whole amount. Stripe refused it: `balance_insufficient`. The money WAS GAM's — it just wasn't *available* yet. An ACH rent payment shows as "settled" on GAM's books the moment Stripe accepts it, but the funds don't become withdrawable for several business days. The batch was spending money that hadn't landed. Nic's read was right: GAM never advances anything, so a shortfall can only ever be a timing problem, never a funding one.

**The fix** (`services/landlordPassthrough.ts`):
- RESERVE now asks Stripe for the real available balance and claims only up to it, oldest payment first. What doesn't fit stays claimed-but-unsent and goes out on the next daily run — nothing is dropped, nothing is double-sent.
- The recovery pass runs every morning at 08:00 and retries anything still pending.
- Anything pending more than 24 hours raises a critical alert instead of sitting silent. That silence is why this went unnoticed.

**Result:** the retry fired Saturday and went through — transfer `tr_1UHXhVDNEru9AEpKpLggYn5G`, $4,154.89 to Mountain View. Weekend transfer, so it shows in the bank Monday.

### Ellen Gregory couldn't log in
Two separate faults, both fixed:
1. Her account was never email-verified (she never clicked an invite — the lease got signed in person), and the login refused unverified accounts.
2. The tenant portal ran **two** 401 interceptors. One had the `/auth/` carve-out, the other didn't; the second one caught the refusal first and reloaded the page, so she got a blank screen with no message. The same duplicate/missing carve-out existed in **pos, admin and property-intel** — all four fixed.

Going forward, signing a lease marks the signer's email verified (`routes/esign.ts`), and so does completing a password reset. A tenant who signs is verified by the act of signing.

### Register
- **"+ Open Item" is gone** from both registers. Every line has to be an item somebody set up; the server refuses a sale line that isn't in the catalog, at any price other than the catalog's, unless the cashier holds "Apply discounts".
- Lisa's "Ring sales" permission is on. Nic to eyeball the rest of her permissions logged in as her.

### GAM's own money — this took the rest of the night
Nic's question: *"where is our profit pooling, and why don't any of the numbers match?"*

**What was wrong:**
- **August showed $55.97 of revenue on zero payments.** A $50 "platform fee" row had been written by hand at some point with nothing behind it, and a $5.97 card spread was booked against payments that don't exist. Both reversed. The only real August money was Nic's own test charges ($2 card + $2 ACH + the $6 ACH fee against a fake landlord) — swept into the platform account at his direction, $10.33. August now reads **$9.01** (that $10.33 minus Stripe's real $1.32 of costs).
- **September's platform fee was never billed.** The accrual wrote a revenue row and stopped — nothing ever asked the landlord for the money. It now also writes a charge that nets out of the next payout (`landlord_gam_charges`): **Mountain View $82 (41 spots), Oak Park $48 (24 spots) = $130**.
- **The unit counts disagreed** (65 / 56 / 63) because hibernating spots were excluded from the fee. Per Nic's directive they're included now: 65 billable.
- **The $5 from the first background check was never recorded anywhere** — it sat in the Stripe balance and in no ledger. A screening now books both the $5 and the card spread on it (~49¢ on a $44.99 check). Backfilled.
- **The per-payment spread is an estimate and runs low.** Stripe is on unbundled pricing: it attributes no cost to an individual charge and bills the real cost as daily aggregates, so the spread booked on the day uses a conservative cost assumption. September's estimate was $41.75 against a real margin of $74.86. A **daily true-up** (06:00, current + previous month) now posts one adjustment so the ledger equals what actually happened, and keeps correcting as more payments land.
- **The bank feed was being counted as a cost of taking rent.** Financial Connections is billed monthly whether or not anyone pays; counting it made August read as a $10.92 loss on zero payments. It's split out and shown beside the margin now.

**The books as they stand:** August $9.01 · September $209.86 · **total $218.87.** Admin → Platform Balance now splits Stripe's balance into GAM's own money, money owed to landlords, and deposits held in trust.

### The Financial Connections $9.60 (Nic's last question)
Two Stripe charges posted 2026-09-01 for the 2026-08-01→08-31 period: *Connections Transaction Subscription* $0.30 and *Connections Balance Refresh* **$9.30**.

It is not the $1-per-Connect-account fee — Financial Connections is a separate product, and the balance refresh is billed **per call**, not per account. In August the transaction sync ran four times a day and refreshed the balance every time: ~124 refreshes × ~7.5¢ ≈ $9.30, for **one** linked account (Oak Park). The transaction data — the part that's actually the point — cost 30¢.

Already fixed in S642: the balance refresh runs **once a day, banking days only** (`services/bankFeed.ts`; the scheduler skips weekends and federal holidays). Expect roughly **$1.60–$2.00/month per linked account** from here, not $9.30. Mountain View was connected in September, so September will show two accounts at the new cadence.

## Idea to design next session — renter pool outside property
Today the pool lives under a "GAM Renter Pool" landlord and property, which also makes the proximity search wrong: it looks for units near *that property's* address instead of near the applicant. Nic's shape:
- The pool sits **outside any property**. It only got scoped to one because a tenant portal needed a property.
- After the background check the renter has a real tenant-portal login in a **suspended state** — no lease, nothing to do — until they connect with a landlord.
- What they can do in that state: **browse available units near them**, near the address that was verified on their ID.
- Landlords still pay $1 for contact; GAM stays a conduit, not a CRA.

## Production data changes (evening; backups ~/gam-backups/s650-*)
- Phantom August revenue reversed ($50 + $5.97); Nic's test money swept in ($10.33).
- Screening margin + card spread backfilled ($5.49).
- September platform fee billed: Mountain View $82, Oak Park $48 — netting from their next payouts.
- September margin trued up to Stripe's real numbers (+$33.11).
- Ellen Gregory's account marked email-verified; Lisa Scheeler granted "Ring sales".
- Stuck passthrough transfer re-fired: $4,154.89 to Mountain View.

## Deploy status
Everything through commit `6e59722` is built, deployed and verified (API, landlord, tenant, admin, pos, marketing). **admin-ops is still not in deploy.sh** — harmless, but it means its login change isn't live.

## Open — ask Nic
1. Reservation form follow-ups (Nic expects questions before the build).
2. Screening: check availability before the paid background check — design with Nic.
3. Still open from S649: Stripe rep question, card reader order.
4. Nic to eyeball Lisa's permissions logged in as her.

## Next session
**Mattoon / Country Acres onboarding, from Nic's spreadsheet.** Owner wants billing ready for October rent through the portal; "build fast and break stuff", he'll fix details later.

Then, in rough priority:
- **ACH debit for all-cash properties** — with the bank cost as its own line item.
- **Agents to ~99%**, or a clean referral when they can't be accurate. Queue turns when the model is busy and show "he's helping another customer right now".
- **Renter pool** redesign above.
- **Audit that FlexCharge is named nowhere** (flagged, not yet swept).
- Register stays → booking on the schedule; card option on front-desk Record Payment; signing queue / "something's wrong" / undelivered-email flag; native apps; property settings questionnaire; work-trade redesign.
- Agent eval failures listed in the previous section still stand.

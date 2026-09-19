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

## Open — ask Nic
1. **Lisa Scheeler can't ring sales at all.** Her staff permissions have the Register tab, take-payment, balances and schedule, but not "Ring sales" (every sale and pay link returns 403). Switch it on?
2. **"+ Open Item" on the register** lets any cashier ring a made-up item at any price. Keep it for the front counter, or require the discount permission?
3. Reservation form follow-ups; screening-availability design; Mattoon meters (all waiting on Nic).
4. Still open from S649: Stripe rep question, card reader order.

## Still to build
- Register stays → booking on the schedule; card option on front-desk Record Payment; signing queue / "something's wrong" / undelivered-email flag; native apps; property settings questionnaire; work-trade redesign.
- Agents, remaining eval failures: "tell me more about the apt 204 one" repeats the expirations answer instead of pulling 204's lease; FlexPay/FlexDeposit follow-ups ("sign me up", "yes, cancel it") don't reach the action; pay-rent quote→charge; demo-data drift in 3 landlord cases (spot 7 / spot 12 / Chen's balance). Run: `DB_NAME=gam_demo AGENT_CONV_JSON=/tmp/x.json npx tsx src/services/agents/agentConversations.ts` (~60 min, migrate gam_demo first).
- Register screens (Taxes tab, item tax checkboxes, disbursement flow) were typechecked and API-verified on demo but not eyeballed in a browser (logging in needs a password).

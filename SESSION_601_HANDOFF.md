# SESSION 601 HANDOFF — forward-facing legal docs updated + FULL agent refresh (facts, framing, siloing, layout)

> Two big workstreams, both **complete and DEPLOYED**: (1) every forward-facing legal/agreement doc
> audited against live code and corrected; (2) a full by-hand run-through of all 7 agent profiles +
> all 64 knowledge articles + the prompts, re-grounded to the current product (fees, money-flow
> framing, product siloing, markup non-disclosure, and — the big one — the **layout/where-things-live**
> refresh after the menu restructures). No DB migrations. No commits (per convention — Nic decides).

Highest prior handoff was S600. This is S601. (Note: git commit *labels* S601/S602 were consumed by
the S600 handoff's multi-thread commits — the handoff-file track and commit-label track diverged there;
don't be confused.)

---

## WORKSTREAM 1 — Legal / forward-facing docs (COMPLETE + LIVE)

Audited every served + in-app doc **against code** (not the handoff — S600's handoff was itself wrong
about the Consumer ToS). Fixed and deployed.

**Served on marketing (`goldassetmanagement.com` /terms /privacy /business/* /consumer/*):**
- **BUSINESS_TERMS_OF_SERVICE.md** — money-flow rewritten to platform-holds/weekly-batch (was the old
  destination-charge model); STR fee corrected (space-only sites $2/30-nights **+** furnished short stays
  5% of revenue, additive, cancelled/no-show excluded); added no-double-bill onboarding grace; §6.3
  "No Cash/No Check" → recorded manual payments ($10 fee); SLA→Custody terminology; **OTP removed**
  (§1/§3/§6.2); added §25 AI Agents + §26 Communications; dates.
- **CONSUMER_TERMS_OF_SERVICE.md** — **ACH 1% → flat $6** (S600 handoff wrongly claimed this doc was
  clean); **card fee was missing the $0.26** (said "3.25% flat"); money-flow; manual payments; manual-fee
  waiver scoped to the **onboarding window** (21-day property window, NOT per-tenant-forever); SLA→Custody.
- **CONSUMER_PRIVACY_POLICY.md** — **FlexCredit lender→reporting/furnisher** (was materially wrong,
  described a "FlexCredit Lender" making credit decisions); FlexDeposit SLA→custody; FlexPay
  date-formula→flat $25; removed phantom inbound credit-history data; added AI-processing disclosure.
- **BUSINESS_PRIVACY_POLICY.md** — **OTP data-flows removed**; added AI-processing disclosure.
- All four: **stamped concrete dates (Aug 10, 2026)** — no more `[DATE OF PUBLIC LAUNCH]` placeholders
  live on the site. Nic can swap in the official launch date later.

**In-app agreements:** FLEXPAY_SUBSCRIPTION_TERMS.md (SLA→Custody, 1 ref). FLEXDEPOSIT_CUSTODY_AGREEMENT
and FLEXCHARGE_BUSINESS_ACCOUNT_AGREEMENT were **already correct** (no changes). Landlord Participation
Agreement (in `apps/landlord/src/pages/OnboardingPage.tsx`) — ACH copy `1.0% (capped $6)` → **flat $6**
(live in front of every onboarding landlord), §3 added STR fee + grace.

**Deployed:** marketing restarted (`launchctl kickstart -k gui/$(id -u)/com.gam.marketing`) — verified
live via curl. Landlord app built + `vercel deploy --prebuilt --prod` → `landlord.goldassetmanagement.com`
(200, aliased). Onboarding page is auth-gated so no screenshot (surfaced, not worked around).

---

## WORKSTREAM 2 — FULL agent refresh (COMPLETE + LIVE)

**By hand, no fan-out** (per [[gam-sweep-byhand-no-fanout]] + Nic's explicit "no spot-check, full
run-through"). All 64 knowledge articles read in full; all 7 prompts reviewed. Re-ingested (**186 chunks**),
API restarted, and proven with live `groundedAnswer` probes at each stage.

**Naming:** Portfolio Specialist → **Strategist** everywhere it's the one human role — Lucy's prompt,
lead/call tools, prospect call emails (email.ts), the 11 "human GAM specialist" escalation articles, the
escalate tool, and the handoff-detection regex (added `strategist`) + its test. 150/150 agent tests pass.

**Facts/fees (all verified against code, corrected where drifted):** ACH flat $6, card 3.25%+$0.26+1.5%
intl, $2/occupied + $10/property min, instant payout 2%/$5, $500 maint threshold, $150 booking deposit.
Removed the **"GAM never advances funds"** defensive framing from the payouts article. Added the **$10
manual-payment fee** (recorded cash/check) and the **onboarding grace**.

**Product siloing (Nic directive):** landlord/sales agents carry ZERO tenant-product knowledge
(FlexPay/FlexCredit/FlexDeposit) and tenant agents carry ZERO landlord-product knowledge (FlexVault);
`shared` names no product. Verified clean.

**Markup non-disclosure (Nic directive):** agents present the **instant-payout 2%** and the **screening**
cost as the cost — never GAM's markup. Removed the "GAM's flat $5" screening reveal (landlord + sales)
and the false "no markup" claim (tenant). Neither side needs to know GAM nets $5 on screening.

**Layout / where-things-live refresh (the menus changed — this was the weak spot):**
- **Both nav articles fully rewritten** to the live portals. Landlord: added Refer & Earn, **Booking Site**,
  Surveys, and the full **Financials hub** (Expenses, Bank Feed, Bank Reconciliation, Lot Rent & Net) +
  Screening hub. Tenant: the **Communication dashboard** (tabs: Maintenance, Inspections, Entry Requests,
  Surveys, Documents, My Walkthroughs), **Security folded into Profile**, corrected Flex Advantage framing.
- **Entry Requests** — was described as a standalone "New Request" page; corrected to reality: **generated
  via the maintenance/inspection workflow when entry is needed; the Entry Requests tab under Maintenance is
  a history/log**, not an ad-hoc create form (Nic).
- **Bank connection** — was "instant Financial Connections, no micro-deposits"; corrected to **micro-deposits**
  (two small deposits, 1–2 business days) — verified `lib/stripe.ts:49` `verification_method:'microdeposits'`,
  chosen because microdeposits are FREE and FC has a fee (Nic).
- **Maintenance is a hub** (Work Orders / Entry Requests / Outages tabs); **Master Schedule** (not
  "Schedule page"); booking config → the dedicated **Booking Site** page.
- Spot-verified in-page labels (all correct): "Amenities & Common Areas", "New Area", "New Inspection",
  "Reservations", "+ Hold", "Spot something wrong?", "Submit walkthrough".

---

## DECISIONS / DIRECTIVES ESTABLISHED (saved to memory)

- **[[gam-no-hedge-language-forward-docs]]** — no "pending counsel"/`[DATE]` placeholders in live docs;
  concrete dates; keep user-facing "consult your own attorney" advice.
- **[[gam-agent-product-siloing]]** — the side-siloing rule; NEVER fix a cross-side hallucination by
  explaining the other side's product. FlexVault (landlord: deposits→per-unit discount) ≠ FlexDeposit
  (tenant: installment help). Updated [[gam-otp-shelved-landlord-only]] to note OTP removed from all docs.
- **[[gam-agent-copy-no-defensive-no-markup]]** — no defensive/legal framing; present fees as the cost,
  never GAM's markup/margin.

## THINGS I GOT WRONG (code greps misled me; Nic caught each)

1. Called **FlexVault** "invented" from a grep — it's a real landlord product. Restored.
2. Said ACH bank connect was "instant Financial Connections" — it's **micro-deposits** (I'd grepped the
   *landlord Connect* onboarding, not the tenant ACH setup).
3. Wrote the manual-fee waiver as per-tenant-first-payment — it's **onboarding-window-scoped** (21-day).
4. Imported ToS "never advances funds" framing into agent copy; and revealed GAM's screening $5.
Lesson for tomorrow: **a code grep can point wrong — confirm product reality with Nic before asserting.**

---

## DEPLOY STATE
- **API** (com.gam.api): restarted with Strategist rename + regex + email templates. Knowledge re-ingested
  (186 chunks in `agent_knowledge_chunks`, live `gam` DB). Re-ingest cmd:
  `cd ~/gam/apps/api && node -r ts-node/register src/services/agents/ingestKnowledge.ts` (targets `gam`, NOT gam_test).
- **Marketing** (self-hosted :3004): restarted — 4 legal docs live.
- **Landlord** (Vercel): deployed — onboarding fixes live.
- No DB migrations. No commits.

## OPEN / NEXT SESSION
1. **Bank Feed / Bank Reconciliation (verify code):** Nic wants the operating-bank link to pull the
   **transaction log only — NO running balance**. Confirm the Bank Feed integration uses only
   `financial_connections` `['transactions']`/`['payment_method']` and NOT `['balances']`. (This is a code
   check, not agent-knowledge — flag/fix if it pulls balances.)
2. **Clean up the S600 test scaffold** on prod `gam` (still pending from S600 §11): tenant
   realestaterhoades+test@gmail.com + the pending $2 viewer charge. Leave the settled $2.33 real charge.
3. Legal docs: swap the concrete Aug-10 dates for the **official public-launch date** once Nic sets it.
4. Agent refresh is believed comprehensive (facts+framing+siloing+layout, all proven). If Nic wants one
   more pass: the sales(3)+shared(6) surface refs were reviewed but are lightly tenant-flavored in a couple
   shared articles ("what is GAM", "using the assistant") — a soft tone mismatch for landlords, not a
   factual error.

## QUICK-REF
- Re-ingest agent KB: `cd apps/api && node -r ts-node/register src/services/agents/ingestKnowledge.ts`
- Agent tests: `cd apps/api && DB_NAME=gam_test npx vitest run src/services/agents/...`
- Live agent probe pattern: write a temp `_verify*.ts` calling `groundedAnswer({profile, message})` with
  `DB_NAME=gam` + `EMBEDDINGS_ENDPOINT=http://localhost:8081/v1`, run, then `rm` it.
- Deploy: marketing = `launchctl kickstart -k gui/$(id -u)/com.gam.marketing`; landlord = local build →
  `vercel deploy --prebuilt --prod` (per [[gam-vercel-deploy-prebuilt]]).

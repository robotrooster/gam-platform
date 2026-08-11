# SESSION 600 HANDOFF — first live dollar through GAM ✅, no-double-bill grace, booking-site photos/grouping/importer, marketing pass, ACH → flat $6, pre-charge fee disclosure

> Huge multi-thread session. **The money path is PROVEN LIVE** — a real card charge
> settled end-to-end (see §6). Most work is deployed + pushed; the ACH-fee/disclosure
> batch is committed at the end of this handoff. Several DB migrations applied to
> prod `gam`. Test scaffold left on prod (cleanup pending, §11).

Commits this session: **0bcb8b5** (S600 grace + marketing + Portfolio Strategist),
**780a9cd** (photo reorder/cover + type-grouped booking), **ea2f94c** (site importer),
+ a final commit for the ACH-fee/disclosure batch (§8–10).

---

## 1. No-double-bill onboarding grace — BUILT + LIVE (commit 0bcb8b5)
New landlords aren't charged the platform fee until they GO LIVE. Details in memory
[[gam-no-double-bill-grace]]. `landlords.billing_starts_at` / `billing_grace_until`;
gate in `platformFeeAccrual.ts`; activation on first settled rent
(`services/billingActivation.ts` ← `webhooks.ts`); daily grace-cap cron; signup stamps
grace (`auth.ts`); `PLATFORM_FEE_GRACE_CYCLES=2`. Existing landlords backfilled to bill
as before (no retro grace). 9 tests. Migration `20260810180000`.

## 2. "Portfolio Strategist" rename — LIVE
Staff-facing label "Portfolio Manager" → "Portfolio Strategist" (shared label + admin
earnings panel + admin-ops badge). The `portfolio_manager` identifier/column/role is
UNCHANGED — label only. admin + admin-ops redeployed.

## 3. Marketing page pass — LIVE (goldassetmanagement.com, self-hosted :3004)
Shortened hero (dropped property-type list), `$2*` + Portfolio Strategist footnote,
removed "built-in store register" (#1 and #3 — POS is an unadvertised perk), white-glove
"More inside", dropped "collect rent this week", **"Switching platforms? You won't pay
twice."** callout. Guest-shell/legal/doc shells in `server.js` **de-Googled** (system-font
stack, zero CDN). Restarted.

## 4. Booking sites — photo reorder/cover, type-grouped booking, IMPORTER — LIVE
Naming locked: call them **booking sites**, NOT "storefront" ([[gam-booking-sites-naming]];
`apps/storefront` dir rename is a pending cleanup). 
- **Photo reorder + cover** (commit 780a9cd): first photo = cover (hero on the home page);
  editor has move ←/→ + "Make cover"; bulk endpoint `PATCH /properties/:id/site-photos-order`.
- **Type-grouped booking**: book page clusters available types by unit_type (RV Sites /
  Rooms / …) when mixed; single-type stays flat. `unitType` threaded quote→profile→storefront.
- **Site importer** (commit ea2f94c): landlord pastes an existing site URL → server fetches
  (SSRF-safe: blocks private/loopback/metadata + re-validates redirects, size/time capped)
  → cheerio extracts story/photos/contact → pre-fills the editor; chosen photos downloaded
  server-side. Raw HTML + extracted JSON kept in `property_site_imports` (data collection).
  Import→editable-template, NOT verbatim hosting (keeps every site on the unified bookable
  calendar → [[gam-roadtrip-trip-planner]]). 8 SSRF tests. Migration `20260810190000`.

## 5. Road-trip planner vision — recorded ([[gam-roadtrip-trip-planner]])
Coast-to-coast auto-booking by driving-hours/day. The reason booking sites stay in the
structured model (not custom HTML).

## 6. ⭐ LIVE-FIRE MONEY TEST — SUCCEEDED. FIRST REAL DOLLAR THROUGH GAM.
A real card charge settled end-to-end on LIVE Stripe:
- Charged **$2.33** ($2 rent + $0.33 card fee, tenant-paid) → PI `pi_3U342m…`,
  `payment_intent.succeeded` webhook **livemode=true**, payment row `settled` /
  `platform_held=true`, GAM banking-spread **$0.01** booked to platform_revenue_ledger.
- **NOT refunded** (Nic's call — don't risk a chargeback on the first live charge; money
  left on GAM's platform balance to move later).
- ACH path NOT yet live-fired (no ACH method on the test account).
- Takeaway confirmed: GAM's card margin is ~$0 by design (pass-through); real income is
  the $2/occupied-unit platform fee.

## 7. ⚠️ Stripe publishable-key GAP found + fixed — IMPORTANT GOTCHA
The tenant card form was dead ("Stripe is not configured … set VITE_STRIPE_PUBLISHABLE_KEY").
Root cause: the pk was set in **Vercel env**, but our **prebuilt deploys build LOCALLY and
read `apps/<app>/.env.production`, NOT Vercel env** — so it never reached the tenant build.
Landlord already had it in its local `.env.production`; tenant didn't. Fixed: copied the
public `pk_live_…` into `apps/tenant/.env.production` + redeployed. **RULE: every VITE_ var
must live in the app's LOCAL `.env.production` — Vercel env is ignored by the prebuilt flow.**
Checked all frontends: only tenant needed it (pos/admin/books don't read the pk).

## 8. Pre-charge fee disclosure — LIVE (tenant pay modal)
`POST /api/payments/quote` returns the exact {base, fee, total} for a method+lease (mirrors
the `/:id/pay` charge math). PayNowModal shows a line-item breakdown ("Rent $X + fee $Y =
You'll be charged $Z") and the **Pay button now shows the real total** (was showing base
only — the blindside Nic caught). Plus a note: "bank transfer is a flat $6 fee; card is
usually higher — your call."

## 9. ACH fee → FLAT $6 (was 1% capped $6) — LIVE
Nic's call after iterating: one flat $6 bank fee at any rent (simple to state honestly;
GAM nets $3–$6 after Stripe's 0.5%-capped-$3 cost — $3 at the top, more on low rent; tiny
payments use a card anyway). Changed in THREE consistent places:
- `PROCESSING_FEES` (shared): `ACH_PCT=0, ACH_FLAT=6, ACH_CAP=6`.
- `computeApplicationFee` (stripeConnect.ts) — the tenant charge.
- `platform_processing_rates` DB row (the ledger's margin calc) — via migrations. Two
  append-only migrations this session: `20260810200000` (interim 0.5%+$3, superseded) →
  `20260810210000` (**flat $6, active**). History preserved (1% → 0.5%+$3 → flat $6).
Card untouched. stripeConnect tests updated (all ACH → $6).

## 10. Public-facing ACH copy sweep — DONE + re-ingested
Updated every "1% capped $6" ACH quote to "flat $6": 7 agent knowledge articles (tenant
paying-rent / setting-up-ach / updating-payment-method; landlord setting-rent /
adding-properties / pass-through-toggle; sales what-gam-costs), `legal/BUSINESS_TERMS_OF_SERVICE.md`,
and the payShared.tsx header comment. **Re-ingested the agent knowledge** (184 chunks / 64
articles) so agents quote the new number — editing the .md alone does NOT update the agents.
Consumer ToS had no ACH-rate quote (only return-fee pass-through) — untouched.

## 11. ⚠️ Test scaffold left on prod `gam` (CLEANUP PENDING)
For the live-fire test (auth/2FA blocked reusing demo tenants — they use fake @tenant.dev
inboxes). Created under the demo landlord james@demo.dev / Copper Canyon Homes / House 01:
- Tenant user **realestaterhoades+test@gmail.com** / password **GamTest2026!** (activated),
  tenant_id `6e24ff88-…`, lease `a724989f-…`.
- Payments: a **settled $2.33** real charge (payment_intent `pi_3U342m…`), and a **pending
  $2** viewer charge `5c002bca-…` (due tomorrow, for eyeballing the disclosure).
- Added an allocation rule to Copper Canyon (it had none).
When done: soft-clean per keep-everything (don't hard-delete the settled real charge — it's a
financial record). The pending $2 and the tenant/lease can be removed; leave the settled
charge + its money on the platform balance (Nic: move later, don't refund).

---

## Deploy state
- **API** (com.gam.api): restarted — grace, importer, `/payments/quote`, flat-$6 fee. Migrations
  `20260810180000`/`190000`/`200000`/`210000` applied to `gam`.
- **Tenant** (Vercel): redeployed — pk fix, fee disclosure, $6-flat note.
- **Landlord/admin/admin-ops/pos/books** (Vercel): current. **Storefront/Marketing** (self-hosted):
  restarted. **Agent knowledge**: re-ingested.
- The ACH-fee/disclosure/copy batch (§8–10) is committed at end of session; earlier threads
  already pushed (0bcb8b5 / 780a9cd / ea2f94c).

## Open / next (Nic: "a few last things before we crank on the real property upload")
1. **Money path is PROVEN (card)** — biggest launch gate cleared. Still needed for a full
   flip: real Oak Park landlord account + Connect KYC + real data (N2/N3/N4), then onboard.
2. **ACH live-fire** not yet done (needs a real bank method).
3. **Clean up the test scaffold** (§11).
4. A few last Nic items (TBD), then the real property upload.

## Deploy quick-ref
- API: `cd ~/gam/apps/api && npx tsc -b && launchctl kickstart -k gui/$(id -u)/com.gam.api`
- Vercel frontends: **prebuilt** flow (`gam-vercel-deploy-prebuilt`) — VITE_ vars come from
  the app's LOCAL `.env.production` (§7). NEVER `vercel --prod`.
- Self-hosted: `launchctl kickstart -k gui/$(id -u)/com.gam.{marketing,storefront}`
- Agent knowledge: `cd apps/api && node -r ts-node/register src/services/agents/ingestKnowledge.ts`
- Tests: **`DB_NAME=gam_test`** always.

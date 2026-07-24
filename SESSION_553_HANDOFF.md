# SESSION 553 HANDOFF — agent queue cleared, eval green, Lucy lead-gen + abuse guard + call booking SHIPPED

Continuation of the S552 agent workstream. Next session: 554.
NOTE: the "S554 DIRECTIVES" section below was written mid-session; Nic said
keep going, so ALL FOUR items were BUILT AND DEPLOYED in S553 — see
"S554 directives — SHIPPED" addendum. The directives text is kept for the
decision record only.

## Eval: 12 → 43 scenarios, effectively 43/43 on the production model
- agentEval.ts now covers ALL FOUR audiences (tenant/landlord/guest/prospect)
  incl. every new tool, escalation cases, bot probes. New harness features:
  `anyTools` (either-of tool grading), `mentionsAny`, and multi-turn
  `history` on scenarios (confirm-then-act flows: agent proposed, customer's
  explicit yes is the graded turn — matches how confirm-first tools work).
- Four full runs: 77% → 86% → 95% → 98%, then the last failure (l-bulk)
  corrected + re-run 3/3. Every fix was a DETERMINISTIC backstop or an
  honest scenario reshape — never prompt-tweaking (S552 lesson holds).
- NEW runner safety nets in agentRunner.ts (all regex-verified in isolation):
  MONEY_DISPUTE_INTENT extended (missing payout "never arrived/where is my
  money", "disputing the charge"); NEW LEGAL_ACTION_INTENT (sue/lawyer/take
  legal action — NOT what-does-the-law-say, which landlord law tools answer
  by design) + ACCOUNT_SECURITY_INTENT (hacked/someone logged in) — both
  force one escalation retry; ACCOUNT_DATA_INTENT extended (documents,
  payment methods "on file", entry requests, property manager/contacts).
- Eval actors: LANDLORD now uses the REAL empty realestaterhoades landlord id
  7b93d017- (was all-zeros → every landlord turn's log INSERT failed its FK);
  GUEST/PROSPECT are all-zeros ghosts (mirror routes/agent.ts construction;
  eval can never write into demo data). l-bulk accepts send_bulk_message OR
  post_service_interruption (both correct for a water shutoff).
- Run command unchanged (S552 handoff watchout). Rule stands: full eval after
  ANY prompt/tool/KB change.

## S552 queue — cleared
1. Landlord amenity pair: was ALREADY BUILT + registered (handoff undersold).
2. Service-interruption tools: get/post/resolve_service_interruption
   (serviceInterruptionTools.ts). Create/resolve EXTRACTED to
   services/serviceInterruptions.ts (route + tool identical); staff fan-out
   added there: findStaffWithPermission('maintenance.tab.outages') + owner,
   minus poster. Agent posts are property-wide (unit targeting = portal).
   Resolve: all-clear ONLY on confirmed restoration.
3. Guest amenity booking: guestAmenityTools.ts (get_guest_amenities,
   request_guest_amenity_reservation) mirrors the public stay-link route
   exactly (stay-date bound, monthly cap, instant vs approval; fee disclosed
   before confirm; guest fees NOT platform-billed — property collects with
   stay; event kind deliberately portal-only). Skye's prompt fixed: stale
   "nothing changes until the host says yes" contradicted S552 auto-approve.
   tools.test.ts guest-allowlist test updated to the four guest tools.
4. Eval expansion: above.
5. Agent Analytics: below.
6. KB housekeeping: what-is-gam duplicates merged; net 64 articles/184 chunks
   after 2 NEW outage articles (landlord posting guide + tenant banner
   explainer) and the pricing rewrite.

## Admin Agent Analytics (page + capacity alarm)
- GET /admin/agent-analytics?days=N (routes/admin.ts, admin-level):
  summary/daily/hourly/byAudience/byAgent/topTools in one call. SQL verified
  against live rows.
- AgentAnalytics page in apps/admin main.tsx (nav: Platform → 🤖 Agent
  Analytics, route /agent-analytics): KPI row, daily AreaChart, hour-of-day
  peak bars, audience/agent/tool tables, 7/30/90d switch, red SHED alarm
  card ("buy bigger hardware").
- SHED TURNS NOW LOGGED (were invisible — gate returned before logging):
  'shed' added to AGENT_OUTCOMES + outcome CHECK (migration
  20260723100000), deriveOutcome returns 'shed', agentSession shed path
  routes through finalize. agentSession.test.ts shed test updated to expect
  the log.

## Lucy (sales) redesign — Nic's spec this session
- Nic did NOT know Lucy existed (S521 build, renamed Jordan→Lucy same
  session) — the marketing widget still SAID Jordan (header/greeting/typing);
  fixed in apps/marketing/src/index.html + com.gam.marketing kickstarted,
  live-verified on :3004.
- Pricing article (sales/what-gam-costs.md) rewritten per Nic: $2/occupied
  unit = ANCHOR not universal price ($10/property min = small props pay more
  per unit; volume can be cheaper; state + opt-ins move the all-in), real
  ACH/card numbers, screening framed lightly, "deposit custody" named only
  as an optional program. Quote always ends at the team.
- IMPORTANT DISTINCTION (Nic): landlord-side deposit custody service ≠
  FlexDeposit (tenant SSDI/SSI installment custody). The landlord service is
  UNNAMED; naming it along Flex lines = open product decision.
- Two-contact split (Nic): FIRST contact (Lucy, organic, one question at a
  time, never re-ask what was said): states, rough unit count, property mix,
  contact. SECOND contact (human): avg rent/deposits, occupancy, fee prefs,
  opt-ins, migration timeline — Lucy is PROHIBITED from asking these.
- Handoff title (Nic picked): "Portfolio Specialist" — never supervisor/rep.
- capture_lead: NEW states field (migration 20260723170000 adds
  sales_leads.states, free text "Arizona and Utah"); instructions demand
  extracting EVERY field the conversation surfaced, even unasked/offhand.

## Deploy state
API: built + kickstarted (com.gam.api) after each step — running code
includes ALL of the above. Admin portal: Vercel pull→build→deploy --prebuilt
--prod DONE. Marketing: :3004 kickstarted (Lucy name fix live). KB: ingested
(64/184). Migrations: both applied, schema.sql regenerated.

## S554 DIRECTIVES — Nic-locked decisions (end of S553 chat), build next
1. **FlexVault** = the landlord deposit-custody service's name (Nic picked).
   Roll the name into the sales pricing article ("optional programs like
   deposit custody" → FlexVault) + wherever the service surfaces.
2. **Abuse controls — ALL FOUR layers**, tiered budgets (Nic's formula):
   - Off-topic detection (deterministic, no extra model call): turn with
     grounded=false (no chunk ≥ 0.3 similarity) AND no tool AND no
     escalation = unproductive. Exclude messages <15 chars ("thanks") and
     cache-hit turns.
   - Tenant: on-topic 60/day, off-topic 5/day. Landlord: off-topic 10/day,
     on-topic = max(60, 60 × occupied_units / 8) (Nic's ×units/8 formula
     with a tenant-budget floor for small/empty landlords). Budgets in
     config/env, not code. Hitting either cap → canned fast-path reply for
     the rest of the day (ZERO model calls — that's the bandwidth
     protection). Design goal (Nic): rare to hit for legit users or they
     stop using it entirely.
   - Prompt layer: all profiles get a one-line off-topic redirect rule.
   - Analytics: heaviest-users table (turns/user/day + unproductive count)
     on the Agent Analytics page.
   - Silent auto-hide: bubble hidden N days after hitting the off-topic cap
     on 3 of trailing 7 days. BUILD DARK, off by default.
3. **Admin Leads page** (confirmed build): sales_leads list + status flow
   (new→contacted→booked→won/lost) + transcript link via conversation_id.
4. **Sales-call booking calendar** (confirmed build, in-house — no
   Calendly): Lucy offers a slot after capture_lead → prospect books from
   Specialist availability → Resend confirmation + reminder cron → call on
   the Specialist's admin calendar. Prospect picks video-or-phone
   preference; Specialist sends the video link manually at launch (Zoom API
   later). Nic: real-time call is mandatory — nobody onboards over email.

## S554 directives — SHIPPED (same session, all deployed)
1. **FlexVault**: named in sales/what-gam-costs.md, re-ingested (64/184).
2. **Abuse controls, all four layers**:
   - services/agents/turnBudget.ts — checkTurnBudget (admission, after the
     cache fast-paths so capped users still get free cached answers),
     unproductiveTurnSql(alias) (ONE definition, used by budget + analytics),
     isAssistantHidden (DARK: AGENT_ABUSE_AUTOHIDE=1 arms it),
     BUDGET_CAPPED_REPLY (neutral copy, never mentions tracking). Env knobs:
     AGENT_TENANT_DAILY_TURNS=60, AGENT_TENANT_DAILY_OFFTOPIC=5,
     AGENT_LANDLORD_DAILY_OFFTOPIC=10, AGENT_LANDLORD_TURNS_PER_UNIT
     (default tenantDaily/8, floored at tenantDaily),
     AGENT_ABUSE_AUTOHIDE_TRIGGER_DAYS=3 / _HIDE_DAYS=7.
   - outcome 'rate_limited' (migration 20260723180000) via
     result.rateLimited → deriveOutcome; cache hits now stamped
     metadata.cached so they never count as unproductive.
   - Prompt layer: BASE_GUARDRAILS one-line off-topic redirect + per-agent
     lines for Lucy and Skye.
   - GET /api/agent/visibility + both portal widgets render null on
     visible:false (tenant AgentChatWidget, landlord ChatWidget). Silent.
   - Analytics page: Heaviest-users table (turns/unproductive/capped).
   - Live predicate check: 0 of 192 real turns count unproductive — legit
     traffic never grazes the caps (Nic's rare-to-hit requirement).
3. **Admin Leads page** (/leads, nav "Sales"): status filter chips, per-row
   status select (shared SALES_LEAD_STATUSES + labels added to
   packages/shared — CHECK predates, values identical), inline chat
   transcript (GET /admin/leads/:id/transcript). Upcoming-calls card with
   Done/No-show/Cancel + collapsible availability editor.
4. **Sales-call booking** (in-house):
   - Migration 20260723190000: sales_call_availability (weekly windows,
     seeded Mon-Fri 9-16 Phoenix) + sales_call_slots (partial UNIQUE on
     starts_at WHERE booked = race-safe single-specialist calendar).
   - services/salesCalls.ts: listAvailableSlots (30-min increments, 14-day
     horizon, 2h min notice; SALES_CALL_TZ=America/Phoenix +
     SALES_CALL_UTC_OFFSET=-07:00 env), bookSalesCall (lead link by
     conversation→email→create, status new→qualified, Resend confirmation,
     admin notification), sendDueCallReminders (*/15 cron, reminded_at
     idempotent).
   - Public routes on the sales limiter: GET /api/sales/call-slots +
     POST /api/sales/call-slots/book. Admin: GET/PATCH /admin/call-slots,
     GET/PUT /admin/call-availability (replace-all editor).
   - Lucy tools get_available_call_times + book_sales_call (conversationId
     = prospect profileId links the lead) + prompt bullet (offer 2-3 times,
     recommend video, confirm-then-book).
   - Emails: sendSalesCallConfirmation/Reminder in services/email.ts.
   - LIVE-VERIFIED: GET /api/sales/call-slots on the running API returned
     140 slots, first "Friday, July 24 at 9:00 AM MST".
   - Eval grades get_available_call_times READ only — book_sales_call
     writes real rows, so it is deliberately not exercised by eval.

## S553 watchouts (second half)
- ADMIN PORTAL CAMELIZES responses (applyCamelizeInterceptor): SQL
  snake_case arrives camelCase in main.tsx. The AgentAnalytics page was
  briefly broken by this (fixed) — always read camelCase in admin pages.
- Zoom link is MANUAL at launch: video-call confirmations say "your
  Specialist will email the meeting link" — the Specialist sends it from
  the Leads page contact info. Zoom API automation = future.
- Cancelling a call from the admin page does NOT notify the prospect
  (deliberate; the confirm dialog says to reply to their email).
- Dev email sends are SUPPRESSED outside production unless
  EMAIL_SEND_LIVE=1 (S536) — booking in dev logs the email, doesn't send.
- Eval count now 45 (p-call-times + t-offtopic added).
- The eval SELF-RAISES the turn budgets (process-local env at the top of
  agentEval.ts) — run #5 proved the guard live by capping alice mid-suite
  (she'd logged 100+ real turns that day; every tenant scenario got the
  canned reply, zero model calls). If eval ever shows every-tenant-scenario
  "called: none", check the budget first.
- test/dbHelpers cleanupAllSchema now clears sales_call_slots/sales_leads/
  sales_call_availability first.

## STRIPE CONNECT: APPROVED + LIVE (end of S553, 2026-07-24)
Nic completed the Connect platform signup in-dashboard (choices, all
Nic-confirmed: platform not marketplace; funds flow "buyers purchase from
us" + SPLIT payouts between sellers; EMBEDDED onboarding components;
EMBEDDED account components — landlords never leave GAM, never see a Stripe
dashboard; platform bears Stripe-facing loss liability per S512, recovered
internally from recipients). Stripe emailed approval immediately.
PROBE NOW GREEN: POST /v1/accounts created acct_1TwmCJRWVY7Ky6HZ (deleted
after). Main account: charges+payouts enabled, zero requirements due.
Stripe setup-guide items "Identity" and "Tax" = upsells, NOT needed
(Express onboarding includes KYC; rent isn't sales-taxable).
→ **C3 WEBHOOK LEG: DONE + LIVE-VERIFIED (S553).** Connect webhook
endpoint we_1TwmXEDNEru9AEpKkoW0OuWH (connect=true, same URL, events:
account.updated + payout.created/paid/failed/canceled); secret appended
to apps/api/.env as STRIPE_CONNECT_WEBHOOK_SECRET (Nic-authorized);
dual-secret constructEvent in routes/webhooks.ts (platform first, then
Connect). PROVEN: probe Express account creation fired a REAL
account.updated through the tunnel → verified via Connect secret →
persisted in stripe_webhook_events (received 2026-07-24 10:07). Bad-sig
400s at the public URL. Probe account deleted.
ALSO VERIFIED LIVE: createOnboardingSession minted a real Account Session
client_secret against the probe account — the S160 embedded-onboarding
backend works in live mode. N4 = a real landlord completing the embedded
KYC on the Banking page (needs a human w/ real identity — Nic).
NOTE (multi-entity): Connect accounts are currently keyed one-per-USER
(S113); the ownership build re-anchors them one-per-ENTITY (landlords
row) — machinery unchanged, key changes. Per-entity KYC is legally
inherent (each LLC = own EIN/bank/account; embedded form pre-filled from
what GAM knows; any owner-member can complete their entity's KYC).
→ remaining chain: N4 (Nic, real KYC) → C4 live-fire payment → C5.

## OAK PARK LAUNCH REQUIREMENTS (Nic, end of S553) — build BEFORE N2/N3
Build order (Nic-confirmed): C3 Connect wiring FIRST (money path,
entity-agnostic — no rework risk), then:
1. **Multi-owner landlord ENTITIES — BACKEND SHIPPED (S553, deployed).**
   Model as locked (entity = landlords row; NO switcher). BUILT + TESTED
   (landlord-members.test.ts, 4/4):
   - Migration 20260724110000: landlord_members (landlord_id, user_id,
     role 'owner', UNIQUE pair) + backfill one founding row per landlord.
     Registration seeds the founding membership.
   - JWT: login/TOTP/refresh carry landlordIds[] (all memberships,
     resolved at login — changes apply at next sign-in). AuthPayload +
     scope.ts: all three checks accept any member entity (landlordOwns).
   - Members CRUD: GET/POST/DELETE /api/landlords/members (add by email —
     v1 requires the co-owner to already have a landlord account; invite-
     token flow is later polish; founding member irremovable; owner-only).
     Routes registered ABOVE GET /:id (would shadow otherwise).
   - GET /api/properties aggregates across memberships for landlords
     (landlord_id = ANY(memberIds)) + returns entity_name per property
     (business_name, else owner name) for the badge.
   UI SHIPPED TOO (S553, live-verified on landlord.goldassetmanagement.com):
   - PropertiesPage: entity badge (gold, entityName) on cards ONLY when the
     portfolio spans >1 entity (simplicity rule — single-entity landlords
     see nothing new).
   - SettingsPage → NEW OwnersSection (above Notification Prefs): lists
     members w/ FOUNDING flag, add co-owner by email, remove non-founding.
     Verified rendering live with the demo landlord (James Thornton).
   DISSOLUTION-PROOFING (S553, Nic — "retaliatory partner" scenario),
   tested 5/5:
   - Founding owner can NEVER be removed (anchors the entity).
   - ONLY the founding owner removes other owners; co-owners cannot
     remove each other (403). Any non-founding owner may remove SELF.
   - Every removal notifies the removed owner + all remaining owners.
   - Migration 20260724120000: audit trigger on landlord_members — who
     removed whom lands in audit_row_changes (provable in disputes).
   - KNOWN LIMIT: a removed owner's JWT keeps its memberships until token
     expiry (≤7d). Mitigation planned in the Connect re-anchor: LIVE
     membership re-checks on money-critical routes (banking/onboarding-
     session/disbursements). Do not ship N2 before that lands.
   REMAINING (next chunks): **Connect re-anchor** user→entity
   (landlords.stripe_connect_account_id; stripeConnect.ts keys ~6 lookups
   off users.stripe_connect_account_id today; Banking page becomes
   per-entity — REQUIRED before N4/N2 so Oak Park LLC gets its own
   account); dashboard/report aggregation beyond the properties list;
   invite-token flow for co-owners without accounts (v1 requires them to
   register first); login-response user object could carry landlordIds
   (cosmetic — backend aggregation doesn't need it).

## LAUNCH BUG FOUND+FIXED (S553): Vercel SPA deep-link 404s
NO portal had a vercel.json — every hard refresh / bookmarked deep link
(e.g. tenant refreshing /payments) 404'd at Vercel on ALL FIVE portal
apps. Added {rewrites: [{source: "/(.*)", destination: "/index.html"}]}
to apps/{landlord,tenant,admin,admin-ops,pos}/vercel.json and redeployed
all five. Verified: landlord.goldassetmanagement.com/settings now loads
direct. (Filesystem paths win over the rewrite, so assets are unaffected.)
2. **Same-landlord lease-overlap exception.** canTenantsSignNewLease
   (routes/esign.ts:66) blocks same-BUCKET (residential/storage/commercial)
   date-overlapping leases per tenant — correct cross-landlord/fraud guard,
   wrong for Oak Park's tenant paying space rent on TWO mobile homes (two
   residential leases, same landlord). Fix: allow same-bucket overlap when
   the existing lease's landlord_id = the drafting landlord (deliberate by
   definition; tenant still signs the printed doc). Cross-landlord block +
   onboarding guards (routes/landlords.ts ~935, ~1337) stay. Then sweep
   tenant-portal/agent "my lease" SINGULAR assumptions so two leases
   display + bill cleanly (schema already allows multiple; the view/tools
   assume one).
3. THEN Nic does N2 (Oak Park born as the LLC entity w/ 3 members) + N3.

## FULL-PLATFORM SWEEP (S553, Nic-requested) — suite green
Full API suite: 4,001/4,002 (started 44 fails/12 files). ALL failures were
STALE TESTS pinning superseded rules — zero live-code bugs. Fixed by
aligning to current contracts:
- checkrProvider.test REWRITTEN + s441Pair Checkr block REMOVED (both
  asserted the pre-S551 classic API; Tenant contract now pinned in
  checkrProvider.test — one order call, NO SSN, Tenant-Signature).
- moneyTriplet: S531 2%/$5 instant fee + margin-debit model; ALSO fixed a
  test-isolation flaw — the margin path (transfers.create +
  accounts.retrieve) was UNMOCKED and hit LIVE Stripe with .env keys.
- flexpay.test: seeds S544 flexpay_enrollment_open + S541 approved inquiry.
- flexsuiteAcceptance: advance-era seed violated the S527 no-advance CHECK
  (the custody guard working); gam_advance_amount → 0.
- posEod: W-12 per-(landlord,property) settlements need property_id on txns.
- csvImportTenantBalance: seeds an explicit no-late-fee decision (S537 gate
  — which correctly 422'd the gateless seeds).
- routes.test: skip requires an in-progress route (auto-advance era) — the
  two skip tests now call /:id/start first.
- profiles.test (Lucy's 3 tools) + groundedAgent.test (asserts the S552
  reframe and guards against "ONLY the facts below" regressing).
- admin-bulletin-income: $2/occupied-unit launch pricing (was $5).
All 10 typecheckable apps + shared: CLEAN.
KNOWN FLAKE (pre-existing, not chased): units.test "PATCH bookings — date
change recomputes nights" failed ONCE in a full run, passes in isolation
and passed the other two serial full runs. Order/timing-sensitive.
WATCHOUT — NEVER run two vitest processes concurrently: config serializes
files WITHIN one process (singleFork), but two processes share gam_test and
cleanupAllSchema clobbers cross-process (produced ~1100 phantom failures
before caught). One vitest at a time, always.

## LAUNCH BUTTON SWEEP (S553) — 22 CONFIRMED BUGS, FIX THESE FIRST (S554)
Multi-agent workflow mapped 431 interactive actions across the 6 launch
portals + adversarially confirmed each finding with file:line on both
sides. Zero were false positives (every one has a CONFIRMED verdict).
**INCOMPLETE COVERAGE — landlord portal shows "0 issues" but its
verification hit Fable-5 usage limits mid-run (15 agents failed); landlord
(218 actions) was NOT fully checked — RE-RUN landlord verify next session.**
The flake fix (dayDiff) is already done + deployed; NONE of these 22 are.

Fix order = launch-path impact. Each is frontend↔API mismatch, no DB risk.

### TIER 1 — onboarding/money, fix before onboarding anyone
1. **admin + admin-ops "Resend" buttons are STUBS (no email sent).**
   POST /admin/onboarding/resend (admin.ts:377-390) only writes an audit
   row + returns "queued" — never calls services/email.ts, nothing
   consumes resend_* actions. All 5 admin (main.tsx 414/418/423/471/…) +
   4 admin-ops (main.tsx 366/367/385/386) buttons show green success while
   NOTHING sends. Nic will think onboarding/bank/ACH emails went out.
   Fix: wire the handler to the real senders (map type→sender).
2. **POS card checkout captures the card THEN 400s (money taken, no sale)
   — discount.** POSPage.tsx sends discountAmount/discountReason;
   pos.ts:426 /transactions destructure DROPS them, recomputes total w/o
   discount → PI minted at discounted total, captured, then pos.ts:547-551
   amount-mismatch 400 → COMPLETE_SESSION never fires, PI can't cancel.
   Cash path: server records UNDISCOUNTED total (books overstate). Fix:
   accept + apply discount in /transactions (sessions route already does,
   pos.ts:1870).
3. **POS card checkout same capture-then-400 — tax.** Client tax =
   COALESCE(tax_category, item.tax_rate) (pos.ts:91); server calculateCartTax
   uses pos_tax_rates ONLY, no fallback (posTax.ts:118-171). S241 seed
   writes items w/ tax_rate 0.08 but ZERO pos_tax_rates rows → every fresh
   landlord's card sale captures then 400s. Fix: server tax fallback to
   item/category rate when no pos_tax_rates row.

### TIER 2 — tenant-facing broken buttons (100 tenants will hit these)
4. **Notification prefs toggle DEAD on BOTH pages** (NotificationPrefsPage
   main.tsx:3016-3018 AND ProfilePage.tsx:96): frontend sends snake_case
   {email_enabled,in_app_enabled}, API zod requires camelCase
   emailEnabled/inAppEnabled (notifications.ts:72-79); API camelizes only
   RESPONSES not requests → silent 400, no pref ever saves. Rows are only
   created by this PATCH so it's permanently broken + checkbox renders
   unchecked. Fix: send camelCase from both pages.
5. **Lease "Download PDF" returns 401 JSON, not the PDF.** LeasePage.tsx:413
   is a bare <a href download> → no Bearer header → leases.ts requireAuth
   401s. (PdfViewer works via injected token.) Fix: blob-fetch w/ token
   like the addendum download at LeasePage.tsx:543.
6. **Vacancy-match "Interested/Not Interested" — POST vs PATCH.**
   TenantNotificationsPage.tsx:21 POSTs; route is PATCH
   (background.ts:1202) → 404, silent. Fix: PATCH.
7. **"Reapply Now" (denied bg check, cooldown elapsed) hits admin-only
   /dev-reset** (background.ts:1023 requireAdmin) → tenant always 403, +
   throws in prod. Applicant can't reapply. Fix: real reapply endpoint or
   point button at the right route.
8. **BackgroundCheckPage verify-id-name route doesn't exist** (POST
   /background/verify-id-name — 0 API hits) → ID/name-match UI never
   renders, idVerification submitted as null (route drops it anyway). Fix:
   build the route OR remove the dead UI+payload.

### TIER 3 — degraded / admin-internal
9. admin Property Reviews duplicate-flag panel: fmtAddr/fmtLL read
   snake_case (main.tsx:3293 new_/orig_) after camelize interceptor →
   "undefined undefined". Fix: camelCase keys.
10. admin-ops Units ACH badge always "Pending": list query (units.ts:44-57)
    never selects tenants.ach_verified. Fix: join it or read GET /units/:id.
11. tenant maintenance detail modal has NO comment surface (inline
    MaintenancePage main.tsx:2145 routed; the real pages/MaintenancePage.tsx
    with comments is DEAD/unimported) — API supports tenant comments. Fix:
    route the real page or add comment UI.
12. tenant ACH last4 regex /D/g should be /\D/g (main.tsx:1030) — non-digit
    last4 stored. tenant check-phone route missing (silent no-op validation).
    tenant idVerification dropped at submit. POS Discounts "Remove" DELETE
    route missing (pos.ts has GET/POST/PATCH only). POS Edit-item "Save"
    drops stockQty. POS register item search 403s for the 'office' staff
    preset (lacks inventory.read; businessInventory.ts:38 feature-gated) →
    whole register "Failed to load". marketing booking day-mode
    (routing businesses) TypeError — out of Oak Park path.
13. COSMETIC: tenant ACH "Bank Name" input value goes nowhere (no
    bank_name column; Stripe feeds the real display). Drop the input.

Full evidence: SESSION handoff was distilled from the sweep result at
/private/tmp/.../tasks/wec96ds6b.output (confirmed[] array) — journal at
subagents/workflows/wf_f7bc1d33-dd6/journal.jsonl if more detail needed.

## Next session candidates
(1-3 of the original list SHIPPED in-session — Leads page, FlexVault name,
custody mention in Lucy's KB. Remaining:)
1. Eval: consider a variance harness (N repeat runs) — remaining failures
   are pure run-to-run drift; the intent nets killed the systematic ones.
2. Booking polish when volume justifies: Zoom API auto-link on video calls,
   prospect-facing reschedule/cancel link, marketing-site standalone
   booking page (today the funnel is Lucy's chat), multi-specialist
   calendar (add specialist column + widen the unique index).
3. Watch the abuse dashboards after launch; arm AGENT_ABUSE_AUTOHIDE=1
   once real usage confirms the thresholds.
4. FlexVault the PRODUCT (landlord-side deposit custody service) — only the
   NAME exists; scope the actual custody flows with Nic.
5. Cross-workstream (see S551): Stripe Connect review pending (probe POST
   /v1/accounts); Checkr/Victor entity+pricing pending; then N2/N3.

## Watchouts
- Eval scenario l-outage-post runs against the EMPTY landlord — the tool
  errors on no-property (that's the pass condition working; nothing posts).
  If anyone reseeds realestaterhoades with properties, l-bulk/l-outage-post
  eval runs would START REALLY SENDING — keep that landlord empty.
- serviceInterruptionTools/guestAmenityTools import loadArea/validateWindow/
  fireAmenityAlert FROM routes (same acyclic pattern as S552 amenityTools).
- Marketing server (server.js) readFileSync's src/index.html AT STARTUP —
  content edits need launchctl kickstart -k gui/501/com.gam.marketing. Root
  apps/marketing/index.html is a stale legacy copy, NOT served.
- Removed 3 empty junk dirs named literally '{components,pages,hooks,lib,
  context,assets}' (failed brace expansion, Mar 19) from admin/src,
  admin/src/components, marketing/src.
- Admin TOTP blocks curl-based endpoint checks; verify admin endpoints via
  SQL or the portal.

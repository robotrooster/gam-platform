# OAK PARK LAUNCH — tenants logged in + paying rent before Aug 1

Written S550 (2026-07-20). HARD SCOPE FREEZE: anything not on this list
waits until after August 1 (storage auction workflow, storefront prod
wiring, FlexPay OCR, UI batch — all parked).

Ground truth as of today:
- The "Oak Park Motel and RV" property in the DB (32 units, under
  realestaterhoades@gmail.com) is a DoorLoop rent-roll TEST import —
  inaccurate, wrong account. Nic rebuilds Oak Park MANUALLY, one unit
  at a time, under the real business account. Data entry is Nic's;
  nobody pre-loads anything for him.
- Stripe: .env still carries TEST keys; Nic's user has NO Connect
  account. Stripe live account is blocked on the sales-rep/account
  migration — THE critical path for "pay their rent."
- Infra: Cloudflare tunnel DONE, Vercel DONE (Hobby, 5 SPAs), Resend
  verified + delivering. API still runs in DEV mode via launchd.

────────────────────────────────────────────────────────
## NIC (decisions + accounts — nothing moves without these)

N1. **Stripe live account** — finish the sales-rep / account-migration
    call. Deliverable to Claude: live secret + publishable keys and
    dashboard access to create the webhook endpoint. THIS IS THE
    LONGEST POLE — everything payment-side is behind it.
N2. **Real Oak Park landlord account** — register with the real
    business email, tell Claude which email it is (so prod checks run
    against the right landlord, and so the demo/test accounts are
    never touched by launch QA).
N3. **Manual data entry** (Nic, at his pace, in the real account):
    property → unit subtypes → units (the unit-add gate will force a
    late-fee decision per unit type — that's expected, decide once per
    class) → tenants/leases for occupied units. Tenant EMAIL is the
    one field that matters for launch: it's the invite + login.
N4. **Connect onboarding (KYC)** — once live keys are wired, complete
    the embedded Stripe onboarding in the landlord portal so rent can
    route to the real bank. ~10 minutes with EIN/bank info at hand.
N5. **Vercel Pro** — click the upgrade when Claude says the prod flip
    is done (launch rule: straight to Pro at launch).
N6. ~~Purge the stale test Oak Park~~ **DONE 7/20** — 32 test units +
    dependents deleted; zero Oak Parks in the DB. Name-collision
    safeguards shipped first (Nic's condition, corrected same day):
    property identity = name + ADDRESS, never name alone — a landlord
    CAN own two "Oak Park"s; only same name + same address 409s (same
    property entered twice). Lease imports now fetch ALL same-named
    candidates and let the STREET NUMBER on the lease pick the right
    one (ambiguous → clear 409, never a guess); FULL ADDRESS incl.
    suite line (street2) = the property's identity — a DIFFERENT
    account at the same street+suite (any name) = blocked claim
    (409 revealing nothing + 'duplicate_property_claim' admin alert;
    both POST /properties and CSV import). Strip-mall case: same
    street, different suite, different owners = allowed (and still
    lands in the fuzzy property_duplicate_flags admin review, so
    every same-street signup leaves a trail). Co-owners join as
    USERS on the primary account, never a second property record.
    ADDRESS VERIFICATION shipped same day (Nic: "are we verifying
    real addresses?"): every new property is graded post-create —
    'parcel' (street number + street corroborated against the 3.4M-
    parcel AZ county DB; the anti-typo tier — real 22658 verifies,
    typo 22656 can't), 'geocoded' (resolves to coordinates; catches
    fake cities/states; lat/lon stored), or 'unverified' (still
    creates — rural addresses legitimately fail — but fires an
    'unverified_property_address' admin alert). Never blocks, never
    delays creation; wired on POST /properties + CSV import; live-
    verified against the real Oak Park address. Ownership proof
    (parcel owner-name match vs landlord identity) = post-launch
    roadmap. HEAT-MAP INFRASTRUCTURE (Nic): every property carries
    lat/lon — nightly 4am sweep retries never-attempted + unverified
    rows so coverage is guaranteed, not best-effort; existing rows
    backfilled live (2 demo properties geocoded, 1 fake demo address
    correctly unverified+alerted). Future heat map = one aggregate
    query over properties(lat,lon) × units × landlords.
    GROWTH TELEMETRY (Nic: "track every data point we possibly can"):
    onboarded dates already exist (created_at on every entity — also
    what platform fees bill from); what mutates is now SNAPSHOTTED —
    platform_growth_snapshots, one row per (date, state, city) plus a
    '*'/'*' platform totals row (distinct landlord counts don't sum
    across cities): landlords/properties/units/occupied/vacant/active
    leases/active tenants/monthly rent roll. Daily 4:10am cron,
    idempotent; multi-tenant leases count rent ONCE (tested). First
    capture ran 2026-07-20 — history covers the platform's entire
    real life since it starts pre-launch. Growth-velocity charts +
    heat-map-over-time are queries, not projects. EXPANDED same day:
    property_growth_snapshots (per-property daily — the finest grain;
    landlord/geo rollups derive from it; powers "70% occupancy when you
    migrated, 85% now" reports) capturing occupancy, delinquent +
    suspended (eviction) units, open maintenance, outstanding balance,
    rent roll; and engagement history (DAU/WAU/MAU + tenant/landlord-
    side 30d splits) on the totals row — last_login_at overwrites, so
    only snapshots preserve it. Everything event-shaped (payments,
    maintenance timestamps, lease starts/ends, bookings) already
    persists as rows = retroactively reportable forever, no new
    tracking needed. COMPLETENESS PASS (Nic: "any data point, ever —
    the data is the asset"): (1) audit_row_changes — DB-trigger change
    journal on 17 business tables; every UPDATE/DELETE preserves the
    full old row (jsonb), no code path can skip it. "What was the rent
    before the edit" answerable forever. users/bank tables excluded
    (secrets would copy into the journal); per-request actor
    attribution = follow-up. (2) product_events + POST /api/telemetry/
    events + TelemetryPing in tenant/landlord portals — first-party
    page-view/feature analytics, self-hosted, append-only. Honest
    remaining limits: snapshots are daily grain (intra-day churn
    invisible), behavior tracking = page views v1 (feature-level
    events added per feature as they matter). SECOND SWEEP (Nic
    pressed): users journaled with SECRET-REDACTING trigger (email/
    phone/name/role history kept; password/totp/token fields stripped
    pre-journal — proven); staff scope/permission tables journaled
    ("who had what access when"); utility meters/bills, pos_items,
    flex_charge_accounts, common_areas, unit_entry_requests, subleases
    journaled; login EVENTS persisted to product_events (last_login_at
    overwrites); landlords.is_demo flag — demo data EXCLUDED from
    geo/total snapshots + engagement (today's rows recaptured clean:
    real platform = 0 landlords 0 units, curve starts at true zero
    with Oak Park as the first real data point). Property-grain keeps
    demo rows (attributable, filter at query). Bank/plaid tables stay
    unjournaled on purpose (encrypted secrets). Server request logs
    remain file-based (/tmp, rotated) — operational, not asset data. Storefront slug suggestions are name+city
    ("oak-park-yarnell"), street number on collision
    ("oak-park-22658"). 70 tests green.

────────────────────────────────────────────────────────
## CLAUDE (technical execution — starts now, none of it waits on Stripe
## except C3/C4)

C1. **Prod flip** — DONE 7/20. com.gam.api launchd service: compiled
    build, NODE_ENV=production, KeepAlive (crash test: kill -9 →
    respawned + serving in <6s). install-services.sh written
    (idempotent; --all refreshes every plist). start-launch-set.sh no
    longer touches :4000 (would fight launchd) and kickstarts
    com.gam.api instead of starting a dev API. ENCRYPTION_KEY
    generated + added to .env (prod fail-fast required it — the guard
    worked). VERIFIED: public API answering via tunnel, real login
    succeeded through api.goldassetmanagement.com, marketing + tenant
    SPA 200, login event captured in product_events. Dev-mode note:
    to run the API in watch mode, bootout com.gam.api first (comment
    in the plist).
C2. **Prod env audit** — DONE 7/20: all five *_APP_URL values flipped
    to production domains; Vercel portals live + pointed at the prod
    API; tunnel + marketing verified; ENCRYPTION_KEY added; nightly
    backups confirmed current (DB dump 25MB + uploads archive, both
    3:30am today, iCloud off-Mac copy per S535).
C3. **Stripe live wiring** (as soon as N1 lands) — live keys into
    apps/api/.env, create the prod webhook endpoint + secret, verify
    signature handling, Financial Connections live (replaces the dev
    mock SetupIntent), Radar on. ALSO (S550 data-completeness): store
    RAW webhook event payloads append-only — if processing logic ever
    changes, history can be replayed; without raw storage it can't.
C4. **Live-fire money test** (needs N1+N4) — one small real ACH and
    one card charge against a test tenant on the real rails:
    destination charge lands in Nic's Connect balance, application fee
    to GAM, then refund. Proof before any tenant pays.
C5. **Invite → login → pay walkthrough on PROD** — create one
    throwaway tenant in the real flow: invite email arrives (real
    inbox), link opens the prod portal, password set, bank added via
    Financial Connections, invoice visible, Pay Now works. This is the
    exact path every Oak Park tenant walks.
C6. **August billing dry-check** — for every lease Nic enters: verify
    the Aug 1 invoice cron will generate a correct, payable rent
    invoice (rent_due_day, no move-in-bundle double-bill on
    migrated-in tenancies, late-fee class = the lease's own terms,
    lease-is-law). Run the same check again the evening of Jul 31.
C7. **Rolling QA behind Nic's data entry** — as units/leases land,
    sweep each occupied unit: active lease, correct rent, tenant
    email present, invite sent/accepted. Report gaps to Nic daily;
    never edit his data.
C8. **Launch-day watch (Aug 1)** — invoice cron output, first real
    payments, webhook deliveries, email log; fix anything that
    breaks, immediately.

────────────────────────────────────────────────────────
## Sequence (assuming keys land in 1–2 days)

- Today/tomorrow: C1 + C2 (Claude) ∥ N1 + N2 + start N3 (Nic)
- Keys land: C3 same day → N4 → C4 + C5
- Through the week: N3 data entry ∥ C7 rolling QA
- Jul 31 evening: C6 final pass, N5 if not done
- Aug 1: C8 — tenants log in and pay rent.

## Explicitly NOT in scope until after Aug 1
Storage abandonment/auction, storefront prod wiring (wildcard DNS /
captcha / inquiry inbox), FlexPay OCR, DoorLoop integration,
the UI batch (flagger name on banner, deposit-page conditional-fee
lines), marketing site rebuild.
[7/21 Nic] Checkr background checks MOVED INTO LAUNCH SCOPE — needed
for new tenants into vacant units; design changes pending from Nic. FlexPay stays tenant-portal
demand-test only. POS/agents ride along only because they're in the
launch set — no new work on them.

# FINAL WALKTHROUGH (S527)

Scope: LANDLORD PORTAL only for this list. The same process repeats for each
launch portal after (tenant, admin, admin-ops, marketing, POS — and likely the
PM portal: Nic is leaning toward promoting it to a launch feature since its
design is nearly identical to landlord; decision pending, nothing unhidden yet).

Nic walks the portal start to finish and calls out items; each one is logged
here verbatim-with-context as it comes in. Nothing gets fixed until the list
is complete — then we fix top to bottom.

Format: `W-<n>` · page/surface · what Nic reported · (Claude notes if needed)

---

**W-1 · Dashboard → notifications bell** — ✅ FIXED: notifications now carry
action_url deep-links (create-service + bell honor them; lease-expiring and
booking-draft emitters set them; seeded notifications updated). Verified:
clicking "Lease expiring soon" opens Carol's lease detail directly via
/leases?open=<id>. Original: Clicking a notification should take
you directly into the details of THAT notification's subject (the specific
maintenance request, the specific lease, etc.). Right now the test
notifications dump you on the Unit Overview page instead. (Claude note: seeded
notification types incl. maintenance_created, lease_expiring, low_stock,
lease_drafted_from_booking — each needs a real deep-link target; check the
bell's click handler routing map.)

**W-2 · Dashboard → "Expected Monthly Rent" KPI** — ✅ FIXED (S531): new
/rent-roll page + KPI click-through + owner-only "Rent Roll" nav entry under
Financials. NEW GET /landlords/:id/rent-roll (canViewLandlordFinances gate,
same as the dashboard rollup): one row per occupied unit (active +
delinquent + suspended per the rent-obligation principle), LATERAL-joined to
the newest active lease (dup-safe) + primary tenant; the endpoint total is
the SAME formula as monthly_rent_volume so KPI and page can never disagree.
Page groups by property with unit-count + subtotal headers; rows show
tenant (+N co-tenants), lease start/end (month-to-month when open-ended),
status badge, rent; row click lands on /units pre-searched. Verified live:
KPI $6,695 → page total $6,695; subtotals $4,995 + $1,700 reconcile; 7
occupied rows incl. the delinquent + suspended units.

**W-3 · Dashboard → "Outstanding" KPI** — ✅ FIXED: retargeted to /balances
(the who-owes-what list, W-37-fixed). Original: Clicking it should show a LIST of
all tenants with outstanding balances (who owes what), not route to another
overview page. **UPDATE (Nic, resuming walkthrough):** the KPI currently
links to REPORTS — it should link to the existing OUTSTANDING BALANCES tab
instead. (Claude note: retarget the KPI link; confirm that page leads with
the per-tenant who-owes-what list — seed has Bob + Frank owing.)

**W-4 · Dashboard → "Active Units" KPI** — ✅ FIXED: tile passes
?status=active; Unit Overview reads it (verified: exactly the 4 active units
render, filter chip selected). Original: Clicking it should land on Unit
Overview WITH the active-status filter already applied, not the unfiltered
page. (Claude note: Unit Overview already has status filter buttons — the KPI
link needs to pass the filter, e.g. /units?status=active, and the page needs
to read it from the URL. Same pattern probably applies to the other KPI tiles
— occupancy/vacant etc. — apply consistently when fixing.)

**W-5 · Dashboard → "Leases Expiring" KPI** — ✅ FIXED: tile passes
?expiring=60; Leases page filters to the window with a banner + "Show all"
(verified: only Carol renders). Original: Clicking it should show ONLY the
leases inside the tile's timeframe windows (30d / 60d), not the full Leases
overview. (Claude note: same pre-filter pattern as W-4 — pass an
expiring-within filter to the Leases page and read it from the URL; the tile
counts 1-in-30d / 1-within-60d against the seed, so the filtered view should
show exactly those.)

**W-6 · Dashboard → "Applications" KPI** — ✅ FIXED: the tile's route was
fine; the DESTINATION (Background Checks page) queried a route that never
existed (/background-checks vs /background) so it was permanently blank.
Page rewired to the real endpoint with honest columns (applicant, started,
risk, status); applicant names backfilled + seed updated. Verified live:
Iris (submitted) + Jack (approved · low) render.

**W-7 · Dashboard → To-Do → expiring-lease item** — ✅ FIXED (S531).
**NIC STANDARD CAPTURED mid-build: "the lease is the document — no boxes to
type in prices anywhere; the drafted document is the only thing where inputs
happen."** The form was rebuilt to match: it collects NO terms.
- **RenewalDecisionModal** (to-do expiring items now deep-link
  /leases?renew=<id>): lease summary + two decision cards. RENEW → pick a
  lease template → "Draft Renewal Lease" → NEW POST /esign/documents/renewal
  drafts an original_lease document for the same unit + active roster;
  identity + carry-over facts prefill (tenant/unit/property names,
  rent_due_day, auto-renew posture, notice days, non-move-in lease_fees);
  rent/start/end/deposit stay BLANK landlord fields — the landlord types
  them INTO the document during the landlord-first signing pass (sign
  flow's required-field validation enforces them). Endpoint guards: one
  open draft per lease (409), template must carry Rent Amount + Start Date
  fields (400). DON'T RENEW → NEW POST /leases/:id/non-renewal: auto_renew
  off (natural expire+vacate at end date), every active tenant notified
  (bell + email, generic check-your-local-laws copy), open renewal
  requests declined.
- **Lifecycle rails built for the chain** (migration 20260704170000 adds
  lease_documents.renews_lease_id): at renewal completion the
  predecessor's refundable move-in deposits COPY onto the new lease after
  move-in invoice generation (deposit carries forward, never re-billed,
  returnable at final move-out), renewal requests complete, and the old
  lease's auto-renew disarms. NEW activatePendingLeases (2am cron, before
  processLeaseEnds) flips signed pending leases active at start date.
  processLeaseEnds now HANDS OFF instead of vacating when a signed
  successor lease is queued on the unit — no vacate, no deposit-return
  draft, credit-ledger 'renewed' emitted.
- Seed: demo lease template ('Standard Residential Lease', 10 placed
  fields on demo-lease.pdf) added to seedDemo + inserted into live dev DB.
- Verified live: to-do click → decision form (ZERO input boxes) → template
  pick → draft created (identity prefilled, terms blank landlord fields,
  James+Carol signers in landlord-first order, renews_lease_id set) →
  lands on /esign with the draft listed. Non-renewal: 200, tenant
  notification created (verified + artifact cleaned; lease was already
  auto_renew=false so no state change). Suites green: leases 59 +
  leases-gap-close 22. **The Apt 202 renewal draft was LEFT in the demo
  for Nic to walk: open it on /esign, fill rent/dates in the document,
  sign, send to Carol.**

**W-8 · Maintenance → assigning form** — ✅ FIXED:
- Receipts: new "+ Add receipt" on every request card. A receipt is a
  documents row (new 'receipt' category) AUTO-LINKED to the request's unit
  and threaded via documents.maintenance_request_id — it appears on the
  Documents tab too, and opens same-tab in /view. Verified: upload 201,
  unit auto-linked.
- Man-hours input KILLED (it was also buggy — its onChange wrote into the
  cost field). The man_hours column stays for the future time-clock (P4).
- Person picker: already existed (S475 shipped it post-walkthrough) —
  verified present with the team roster dropdown.

**W-9 · GLOBAL · date-picker calendars** — ✅ FIXED: there are no custom
calendars anywhere — every date field is a native input, and some native
popovers (Safari; datetime-local) stay open after a day click. One shared
helper (`installDatePickerAutoClose` in packages/shared) blurs any
date/datetime/time input the moment its value commits — blur dismisses the
native popover in every browser. Installed at startup in all 4 portals with
date fields (landlord, tenant, admin, pos). Verified: listener fires blur on
date-input change. Original: Every calendar in every menu must
AUTO-CLOSE as soon as a date is clicked. The extra click-off to dismiss is
annoying. (Claude note: portal-wide sweep of date inputs/pickers, not just
maintenance — apply wherever a custom calendar popover is used.)

**W-10 · Team/POS → permanent property lock on staff** — ✅ FIXED (Nic
decision: fixed at invite, NEVER editable — not even by the owner; re-invite
is the move path). Invite now REQUIRES picking the property (400 without);
the scope PATCH rejects any property change with a clear 409 ("remove them
and re-invite them there"); StaffPermissionsPage shows the binding read-only
with the permanence note (legacy rows with no property yet get one
first-set). Enforcement is server-side, all surfaces — the existing S526
enforced-reads/writes scope machinery consumes the same property_ids.
Verified live: invite w/o property → 400; changing Dana's property → 409.

**W-13 · Properties tab → KPI cards** — ✅ RESOLVED (investigated, no code
change): property cards navigate correctly with live data and a dead id
degrades gracefully. The "property not found" came from the browser session
holding PRE-RESEED property ids in its cached list — clicking navigated to
wiped properties. One-time artifact of the demo wipe; can't recur for real
customers (their data isn't wiped under them). Re-walk to confirm.

**W-14 · Property onboarding → CSV import** — ✅ FIXED (S531): template
download + handler killed; named providers listed first with "Other
platform (not listed)" as the catch-all; section 2 = "Export from your
current platform"; section 3 = "Upload Your Export"; white-glove card added
(email sales@goldassetmanagement.com with spreadsheets/scans/photos and GAM
imports the portfolio). Backend template route left in place (harmless —
staff can still pull it). Verified live: no download buttons, provider
list order, white-glove copy present. Original: Remove the "download
template" section entirely. Nobody wants to fill a template: they upload
the export from their CURRENT provider, and if they're on paper, GAM
imports manually (white-glove). (Claude note:
PropertyOnboardingPage — keep/strengthen the provider-export paths
(RentManager etc.), drop the blank-template download; make the paper path
messaging point at GAM doing it for them rather than DIY.)

**W-15 · Unit Overview → "direct pay"** — ✅ FIXED (S531, Nic decision:
retire platform-wide). Migration 20260704150000 merged direct_pay rows into
'active' and dropped it from the units_status_check. Swept from: shared
UNIT_STATUSES/labels, units.ts create enum, UnitsPage filter+badge,
AddUnitModal picker+badge, PropertyDetailPage badge, DashboardPage stat +
"N direct pay" sub, landlords.ts stats, admin.ts + getLandlordPortfolio
occupied counts, seed. BONUS fix-it-right: the per-unit P&L fee preview
(units.ts) and admin occupied_units excluded delinquent/suspended while the
real accrual (platformFee.ts, by active lease) charged them — occupied is
now uniformly active+delinquent+suspended everywhere, and the dashboard
Platform Fee sub uses the same rent-roll count. Verified live: units page
filters/badges clean, dashboard shows "7 occupied" consistently on both
Expected Rent + Platform Fee tiles. units suites 51/51 green.

**W-16 · Add Unit → duplicate numbering guard** — ✅ FIXED: an exact-case
unique constraint already existed (units_property_id_unit_number_key); S529
added a case-insensitive index on (property_id, lower(unit_number)) so
"apt 204" can't slip past "Apt 204", POST /units converts both violations
into a friendly 409 ("Unit \"X\" already exists at this property"), and the
Add Unit review step surfaces the server message instead of a generic retry
line. Verified live: duplicate POST returns the 409 message.

**W-17 · Master Schedule → lease bars need names** — ✅ FIXED: labels now
paint on the bar's first VISIBLE cell (long leases starting before the grid
were nameless — the label only drew on the off-screen start cell); names
bigger/bolder, up to 16 chars, lease bars show 🔒 + tenant name. Verified
live on all 6 lease bars. Original: Leased spots must show
the tenant's NAME on the bar, same as reservation bars show guest names. And
names on ALL bars should be more prominent for easy at-a-glance reading.
(Claude note: the master query already joins the primary tenant's
first/last name onto lease rows — the timeline just doesn't render it on the
blue bars. Bump font weight/size/contrast on both bar types.)

**W-18 · Master Schedule → reservation detail popup** — ✅ FIXED (with W-55):
clean day-only dates ("Jul 6, 2026 → Jul 10, 2026 (4 nights)"), NaN nights
cured (dates are ISO timestamps — dayOnly-slice before math), payment line
(deposit-paid → balance due · else total + "no payment recorded"). Verified
live. Original: Not smooth; redo:
- Dates shown as just the stay dates/nights — NO timestamps.
- Show payment state: paid in full, or the OUTSTANDING BALANCE when only the
  deposit was paid.
- "NaN nights" is useless — nights must calculate correctly.
(Claude note: the NaN comes from the detail modal building
`new Date(isoTimestamp + 'T12:00:00')` — appending a time to an already-full
ISO string yields Invalid Date; dayOnly-slice first (the documented S526 date
rule). Payment state needs checking what bookings track today — total_amount
exists but paid/deposit-collected amounts may need a small data addition to
show paid-vs-balance honestly.)

**W-19 · Edit reservation → site dropdown** — ✅ FIXED: filter-first via the
new shared availability rule. `services/unitAvailability.ts` is now the ONE
predicate (free = no overlapping non-cancelled booking + no active lease,
same-day turnover allowed); the create/move 409 guards were refactored onto
it and a new `GET /units/available` endpoint exposes it (dates + RV
requirements + excludeBookingId). The edit panel's dropdown now lists only
server-acceptable units (current unit always kept; mismatch warning stays as
safety net). Bonus fix found while verifying: startEdit seeded the form with
full ISO timestamps (S526 trap) — the check-in/out date inputs had been
rendering BLANK; dayOnly-sliced. Verified live on Rosa's stay: RV 03/06
(overlapping) + RV 08 (leased) excluded, dates populated. Original: When
changing sites, the dropdown must show ONLY spaces that are (a) compatible
with the reservation's requirements (50 amp, pull-through, etc.) and (b)
actually available — nothing with an overlapping booking or lease for the
stay dates.

**W-20 · Master Schedule → self-compression (site optimization)** — The
schedule should SELF-COMPRESS: pack reservations to minimize scattered gaps,
while honoring each reservation's requirements (50 amp, pull-through, …).
**NIC DECISIONS (S531): FULLY AUTOMATIC.** Sites ARE assigned in the system
but not revealed to the guest until a morning-of-check-in message.
✅ BUILT (S531):
- **Guests book a SITE TYPE, not a unit** (public booking page + API):
  GET /public/property/:slug returns siteTypes (grouped by subtype, units
  without one pool as "RV Site"; unit numbers never in the payload);
  availability = any candidate of the type free; book = system assigns the
  first free candidate low-number-first (per-unit advisory lock stays the
  race guard, UnitFullError advances to the next candidate); bookings stamp
  required_site_layout/amp from the subtype. Waitlist anchors the type's
  first candidate. Confirmation email + waitlist-claim page no longer name
  a unit — both say the site number arrives the morning of check-in.
- **Nightly self-compression** (services/scheduleCompression.ts, cron
  3:30am): **BEST-FIT packing (Nic's clarified objective: CONSOLIDATE)** —
  a booking prefers the site where it fits most SNUGLY between existing
  reservations (slackScore = leftover gap days on each side; open sides
  cost heavily), so a week-long stay slots into a 2-week gap between two
  bookings instead of onto a wide-open site, keeping long contiguous runs
  free for long stays. Ties break to the lower unit number. PINNED and
  never moved: checked-in, revealed (site_reveal_sent_at — migration
  20260704190000), same-day arrivals, lease-drafted bookings; leases are
  fixed obstacles (Nic: leases keep their sites). A booking that fits
  nowhere keeps its site — never worse than the current layout.
  **Booking-time assignment uses the SAME best-fit ranking**
  (rankUnitsBestFit) — new stays land in snug gaps from the moment they're
  booked, not just after the nightly pass.
- **Site reveal — 1 HOUR BEFORE check-in time** (Nic refinement; cron every
  15 min, property-timezone aware, check_in_time default 15:00): confirmed
  same-day arrivals get their site number by email
  (emailBookingSiteAssignment). The stamp is THE single movement fence —
  same-day arrivals stay movable until their reveal goes out, so an
  extension the previous day (or same morning) causes zero visible
  movement for the incoming guest. Unpaid tentative holds never reveal.
- **EXTENSION PROTECTION — three tiers** (Nic): a sitting guest extending
  their stay takes priority on their own site. On a same-unit
  date-extension conflict the booking PATCH tries, in order:
  (1) relocate the FOLLOWING (incoming, unrevealed) reservation best-fit
  to a compatible open site — the incoming guest never knows;
  (2) BACKUP when the incoming can't move (revealed / checked-in /
  lease-bound / no site — busy seasons are competitive): move the
  EXTENDING GUEST instead, to any compatible site where the WHOLE
  extended stay fits (response carries extendedGuestMovedTo so staff can
  coordinate the physical move);
  (3) neither possible → 409 with both reasons — the extension is truly
  impossible. A deliberate unit swap into a conflict still 409s.
  TWO fix-it-right catches during testing: the ranker's single-candidate
  shortcut skipped the conflict check (double-booking), and pg Date
  objects entering the JS-side ranker coerced every comparison to NaN
  (also double-booking) — both fixed, every window entering the module is
  normalized to a day-string, tests pin both.
- Tests: NEW scheduleCompression suite (11: packing order, amp
  compatibility, reveal-fence pinning, lease obstacles, idempotence,
  GAP-FILLING into a snug window, booking-time best-fit ranking, slackScore
  pure math, extension boots the incoming reservation to a compatible open
  site, refused when the incoming guest was told their site, refused when
  no compatible site is open); public booking suite rewritten to the
  site-type contract incl. a no-unitNumber-leak assertion (12); a
  three-tier extension test in units.test (boot incoming → move extending
  guest → 409); bookings + scheduler smoke green — 51 tests across the
  compression set. Verified live:
  sunset-palms public profile shows "Pull-through 50 amp ×5 / Back-in
  30 amp ×3" with zero unit numbers; type availability prices correctly
  ($195 + 12% tax, 25% deposit). Demo slug mirrored into seed.

**W-21 · Master Schedule → lease bar end-cap rounding (Apt 202)** — ✅ FIXED
as analyzed: lease bars now round ON end_date (inclusive convention);
reservations keep exclusive check-out rounding. Original: Display
error at the end of the lease bar: the LAST day cell isn't rounded but the
second-to-last is. (Claude analysis, cause found: the end-cap condition
treats lease end dates like reservation check-outs — it rounds the cell where
`day + 1 === endDate` (exclusive), but lease bars PAINT through endDate
inclusive, so the cap lands one cell early and the true last cell renders
square. Fix: lease bars round where `day === endDate`; reservations keep the
exclusive check-out rule. SchedulePage isEnd calc.)

**W-22 · Configure Unit (⚙) → type-appropriate configuration** — ✅ FIXED:
rates, min-stay/check-times, and the bookability toggle only render for
stay-capable types (rv/apartment/single-family/mobile-home); storage and
commercial get a "rents by lease only" note plus amenities/description.
RV layout/amp stays RV-only. Verified live on Storage 01 (no rates, note
shown) and RV 02 (rates + RV fields).

**W-23 · Master Schedule → List tab ordering** — ✅ FIXED: "Arriving soon"
(next check-in first) → "Currently here" (in-house stays + leases) → "Past /
cancelled", with dividers + counts; row dates de-timestamped too. Verified
live. Original: Order reservations by next
incoming at the top; longer-term / already-arrived guests move down. Ideally
a divider: "Arriving soon" section on top, "Currently here" below it.
(Claude note: sort upcoming by check-in ascending; in-house group below —
sorted by check-out? decide in fix phase — with a visual divider between the
two groups.)

**W-24 · Configure Unit → amenities as toggles** — ✅ FIXED: toggle chips
with per-unit-type presets (RV hookups vs apartment vs storage sets) + an
"Add your own" input. BONUS BUG KILLED: the old comma-string amenities value
was posted at a text[] column — saving any non-empty amenities had been
erroring silently. Now array end-to-end. Verified live: chip toggle on RV 02
persisted to the DB.

**W-25 · Tenants tab → payment health card** — ✅ FIXED (S531): the
Payment Health card on the tenant profile is now clickable ("View detail →")
and opens a Payment Timeliness modal: summary chips (paid on time X of Y,
avg days late when late, worst) + per-payment rows with due date, paid date,
amount, type, and a timeliness badge — On time (green), N days late (amber
≤7 / red >7), N days overdue for unpaid past-due, Failed. Pure frontend —
the profile payload already carried due_date/settled_at. Day-sliced date
compares per the serialization rule. Verified live: Alice 3/3 on time;
Bob shows 3d + 20d overdue + failed.

**W-26 · Tenant profile (landlord view) → remove credit reporting** —
✅ FIXED (S531): the "Credit Reporting" row is off the landlord tenant
profile. Backend audit: the credit SCORE stays gated behind
requireLendingService (gam_internal_only per the credit-ledger spec);
FlexCredit enrollment is tenant-initiated (feature-flagged OFF at launch);
the profile route's t.* does return the enrollment boolean but no landlord
surface renders it and no landlord route exposes credit events/scores.
Screening page's consented bg-check flow untouched. Verified live.

**W-27 · Tenant Onboarding → "pending pool" workflow — DISCUSSED, Nic
decided (S531)** — Explained: limbo-state onboarding (S29c-2-A) — tenant
added with name/email/phone only, NO activation email until their lease PDF
uploads + parses into a real lease (no half-configured accounts; consistent
with lease-is-law). **NIC: KEEP, but add MIGRATION PROTECTION — permanent RV
tenants awaiting onboard must not have their occupied spot bookable by
guests.** ✅ BUILT (S531): migration 20260704180000 adds
pending_tenant_intents.unit_id (nullable + partial index on open intents);
the ONE availability predicate (findStayConflict + findAvailableUnits)
gained a 'pending_tenant' conflict ("Unit is held for a tenant completing
onboarding"); the pending-add form has an optional "Unit they occupy"
picker (validated ownership + one-hold-per-unit 409); the pending list
shows "Holding Unit X — Property" in gold. The block lifts automatically
when the intent resolves into a lease or is deleted. Verified live
end-to-end: 8 available → bind House 01 to a pending tenant → 7 available
+ direct booking 409s with the message → intent removed → 8 available.
Suites green: units 51 + bookings 8. Test artifacts cleaned.

**W-28 · Leases tab → lease detail window** — ✅ FIXED: new
LeaseOverviewModal — pure information (status, tenants w/ PRIMARY badge,
term + type + auto-renew, rent + due day, deposit, late-fee terms, the
lease's fee list, notice days) with a "View Full Lease" button into the
W-29 /view route. Zero inputs. The disabled-form path survives ONLY for the
needs-review import confirm (which is genuinely editable). Verified live on
Eva's pending lease.

**W-29 · Leases tab → view icon dead** — ✅ FIXED: the old handler window-
opened a blob AFTER an async fetch — popup blockers silently killed it. Built
an in-app same-tab PDF viewer route (/view, with Back) and pointed View at
it. Verified live. The viewer is generic — Documents tab (W-45) reuses it.

**W-30 · Leases tab → Bill-a-fee restricted to lease terms** — ✅ FIXED,
all three surfaces on one rule: the modal's options come ONLY from the
lease's own due_timing='other' lease_fees rows at the lease's amount (no
amount input at all; empty state says nothing outside the lease can be
billed); POST /leases/:id/bill-fee now takes leaseFeeId and 404s/409s
anything not on the lease or auto-billed; the agent bill_fee tool got the
same lock (refuses when the lease authorizes nothing, lists options when
ambiguous, never accepts an amount). Seed now gives Alice/Bob/Carol/Grace
billable lease fees so the flow demos. 7 new/updated tests green (incl.
"client cannot set the amount — the lease row wins"). Verified live on Bob:
exactly his two lease fees offered.

**W-31 · Move-out flow → deductions locked to documented damages** —
✅ FIXED (Nic decision: documented damages only). The free-form "Other
deductions" list is now "Damage Deductions": no category picker (utilities/
rent arrive via the auto-sweep, fees via lease_fees rows), every line
requires a description, a positive amount, and AT LEAST ONE photo/receipt —
uploaded per line as a documents row tagged to the lease, viewable in /view.
Enforced BOTH ends: the client blocks saving and the server 400s
undocumented lines + verifies the evidence documents belong to the landlord.
The "dead button" was the old Add-line rendering disabled in preview mode —
it's now hidden until a draft exists (the preview text explains the flow).
Verified live: PATCH without evidence → 400 with a clear message. Tests
updated (22/22 green).

**W-32 · Disbursements → on-demand early withdrawal** — ✅ FIXED (S531).
Recon found the flow WAS already built (routes/withdrawals.ts preview+POST →
Stripe payout, WithdrawNowModal) — invisible in the walkthrough because the
Withdraw Now strip only rendered with Connect KYC done + balance > 0, never
true in demo. Shipped:
- **Pricing (Nic decision): instant = 2% of the amount, $5 minimum, ALL-IN**
  (Stripe's 1.5%/50¢ comes out of it; GAM nets the spread). Standard
  on-demand stays free. Constant INSTANT_WITHDRAWAL_FEE in shared.
- Margin capture: GAM's spread is pulled via an account-debit transfer
  (connected → platform, dynamic platform-id lookup) BEFORE the instant
  payout fires for the remainder; payout failure best-effort reverses the
  debit (logged for manual recovery if the reversal also fails). Rounding
  drift lands in the user's favor by construction — unit-tested invariant
  (withdrawals.test.ts, 7 tests: $1000→$20 fee/$5 margin, $20→nets exactly
  $15, ≤$5 ineligible, crossover at $250).
- fee_charged audit column now stamps the all-in user fee; balance-too-small
  instant attempts get a clear 400 pointing at Standard.
- Modal copy: "Instant fee (2%, min $5)" + all-in disclosure; Standard
  labeled free. The Withdraw Now strip now ALWAYS renders (button disabled
  with "Link your bank account first" / "No available balance" hints) so the
  promise has a visible workflow pre-KYC. Verified live in demo: strip +
  disabled state + pricing copy. End-to-end Stripe leg needs the test-mode
  Connect account from the Stripe launch checklist.

**W-33 · E-Sign → send-document flow redo** — ✅ FIXED: Send To has three
modes — "A Unit" (default: pick the unit, everyone on its active lease is
resolved + shown, no emails typed), "Whole Property" (one click → one
document per active lease, sequential send with progress, button reads
"Send to N Leases"), and "Specific Emails" (the old flow as the escape
hatch). New GET /esign/recipients?unitId|propertyId resolves active
lease_tenants server-side; lease tenants skip the invite-provision step
(they already have accounts). Witness + document-values sections unchanged.
Verified live: Apt 201 resolves Alice; Oak Street resolves 5 leases.

**W-34 · Banking → add bank account — ✅ VERIFIED (S531), works today** —
Full trace: the Add Bank Account form → POST /bank-accounts → zod-validated,
account number ENCRYPTED server-side (only last4 in plaintext), stored in
user_bank_accounts; disbursements audit-link to the account. NOT a mock.
The Stripe Connect KYC section on the same page is also real (embedded
Express onboarding against live env keys — no dev stand-in on the landlord
side; the mock SetupIntent lives only in the TENANT ACH setup). No gaps
need building before launch — at Stripe-live the Connect flow just runs
against production keys. The manual-ACH form is a separate legacy path
(no Financial Connections verification) — intentional per S66.

**W-35 · Payments page → line-item breakdown — ✅ VERIFIED, itemized** —
Every charge is its own typed row by construction: rent and late fee are
separate payment rows (Bob's $50 late fee renders as its own LATEFEE line
with a type badge), never lumped into one pull. Invoices additionally carry
per-category subtotals. No change needed.

**W-36 · Utility sub-meter workflow — 🔁 CORRECTED (S532)** — Nic's
correction pass: the S531 manual page (Record Reading modal + cycle picker +
Generate Bills + Send to Tenant) was NOT the designed workflow and was
removed. The real design — an END-OF-MONTH READING RUN — is now built:
- A run opens automatically per property on the LAST BUSINESS DAY of the
  month (walked backward past weekends + US federal holidays; Nic's rule),
  via daily 7am scheduler tick. Prompt (notification + email) goes to the
  landlord + property staff whose permission toggles cover properties.edit.
- Landlord /utilities shows the run banner ("Meter readings due — July 2026
  · 0 of 10 read") → guided walk, BLIND LINEAR ENTRY (Nic's spec, same
  session): one step per UNIT with a typed input per applicable utility
  (RV 01 electric, RV 01 water, …); RUBS masters get their own steps at
  the end. NO prior reading shown anywhere (bias prevention — values are
  also stripped from the API payload and from the below-prior error copy);
  input is text/inputMode=decimal (typeable only, mouse scroll can't change
  it, non-numeric keystrokes rejected); the ONLY button is "Next" — it
  saves automatically and advances. No Skip, no Finish early, no Save wording.
- NO GIVEAWAYS for bad readings (Nic, same session): a below-previous value
  is accepted with a normal 201 — indistinguishable from a good entry — and
  silently flagged (utility_meter_readings.needs_review, migration 140000).
- DOUBLE-CHECK = SECOND PHYSICAL READ (Nic redesign, S533 — supersedes the
  landlord-modal-first shape): flags NEVER interrupt the walk. When the
  main walk finishes, the system builds a blind VERIFICATION list — every
  suspicious submeter + RANDOM clean ones to ≥6/month (reader can't tell
  which are suspects; utility_reading_double_checks, migration 130000 +
  'double_check' run status). Reader re-reads those blind; reconciliation
  is automatic: re-read within 1-2 units → FIRST read stands for billing
  (drift bills next cycle, second read silently ignored); bigger diff →
  re-read replaces. Rollovers auto-bill (wrap = 10^digits − prior +
  current; per-meter digits 4-8, migration 110000); suspicious-high usage
  (thresholds in shared: electric 5k kWh, water 10k gal — Nic's first
  guesses) verified by the re-read just bills. Billing fires at
  verification completion. ONLY escalation left for the landlord queue: a
  re-read-confirmed below-previous value (rollover vs meter-swap = money
  decision). /complete stays as the backend-only stuck-run escape hatch.
- When the last meter is read the run auto-completes: bills generate via
  the S90 engine + auto-finalize to 'billed'; the S178 invoice cron folds
  them into each tenant's next monthly invoice. NO manual generate/finalize
  buttons anywhere. (Backend keeps a POST /reading-runs/:id/complete escape
  hatch for a permanently dead meter — no UI surface, flagged to Nic.)
- Meter setup (add/edit/assign) kept; Nic: needs read-only-vs-edit
  permission split — details deferred to the staff-permissions pass.
- New: utility_reading_runs migration, services/utilityReadingRuns.ts,
  5 run routes in utility.ts, scheduler tick, run-opened notification,
  ReadingWalkModal. Tests: utilityReadingRuns.test.ts 11/11 (incl. holiday
  walk-back + auto-complete billing $35 integration), utility.test.ts 35/35.
- Demo: 10 RV spots each on own pedestal submeter (Row A label kept for
  Grace), June 30 baselines, July run OPEN 0/10 — enter 1250 on Row A during
  the walk to produce Grace's 250 kWh → $35.00. Mirrored in seedDemo.
Original S531 entry (superseded): Audit:
backend was COMPLETE (5 tables + 11 routes: meters CRUD, readings, per-unit
assignment, bill generation, finalize) but the landlord UI was never built
and the tenant bills page had no nav link. **Nic: build now — "RV spots are
always sub-metered for electric; the platform is useless without it."**
Shipped:
- NEW landlord /utilities page (nav under Operations): per-property meter
  list (type/billing method/rate/assigned units/last cycle), Add/Edit Meter
  modal (submeter / RUBS w/ allocation method / master), Assign Units
  checklist, Record Reading modal, reading history, cycle-month picker +
  Generate Bills, bills table with "Send to Tenant" finalize.
- Tenant portal: 💡 Utilities nav link added (the page was already routed —
  the audit's "unrouted" call was wrong, main.tsx line 3465 had it).
- GET /utility/meters now returns assigned_unit_ids (no N+1 in the UI).
- FIX-IT-RIGHT: isoMonthStart used LOCAL date getters on a UTC-constructed
  date — in any negative-offset timezone EVERY generate call silently
  billed the PRIOR month ("generate July" billed June). UTC getters now.
- Bills only generate when the LEASE says the tenant pays that utility
  (lease_utility_responsibilities, lease-is-law) — verified as designed.
- Verified live end-to-end: meter created (Pedestal Row A, $0.14/kWh) →
  RV 08 assigned → June 1000 + July 1250 readings → Generate → $35.00 bill
  (250 × $0.14 ✓) for the CORRECT cycle → finalized to 'billed'. Demo
  meter + readings mirrored into seedDemo (kept as walkthrough state);
  W-7's template seed guarded against reseed duplication.

**W-37 · Outstanding Balances tab → broken columns** — ✅ FIXED: page read
snake_case fields but the API interceptor delivers camelCase — every column
fell back to placeholders. All 14 field reads converted; verified live
(Frank Williams · Apt 204 · Oak Street · overdue badge). Original: wire the page up
correctly: Tenant column literally shows "tenant" instead of the person's
name, Unit/Property shows "-", and Oldest Due isn't populated at all.
(Claude note: smells like the same class of bug as the LeasesPage tenant fix
— page reading flat fields the API doesn't send, or the balances endpoint not
joining tenant/unit/oldest-due data. Wire both sides so every column is
real; seed has Bob + Frank to verify against.)

**W-38 · Reports page → outstanding balance link** — ✅ FIXED: Reports
overview Outstanding card now clicks through to /balances. Original: The outstanding-balance
figure on Reports should link to the Outstanding Balances tab the same way
the dashboard KPI does (W-3). One consistent destination for "who owes
what". (Claude note: apply the same retarget as W-3 wherever an
outstanding-balance number appears.)

**W-39 · Reports → monthly breakdown detail → GAM platform fee shows 0** —
✅ FIXED: fees charge from property onboarding (created_at) forward; the
reseed created properties "today" so past months were legitimately $0. Seed
now BACKDATES onboarding 14 months (established convention); verified
last-month detail returns $30. Original:
Clicking a line item in the monthly breakdown opens a detail view, but the
GAM platform fee shows 0 there. (Claude note: the platform-fee calc is the
ONE source in services/platformFee.ts ($2/occupied unit, $10/property min,
from onboarding forward) — the dashboard tile computes $30/mo against the
same seed, so the detail view is reading the wrong field or not calling the
calc; make the detail use the shared source.)

**W-40 · Inspections → new-inspection form** — ✅ FIXED: the form is now
type + unit + date (+ optional notes). Tenant and lease derive from the
picked unit and render as an info line ("Attached from this unit: Carol
Vasquez · active lease"); a vacant unit says so plainly. The move-out
comparison dropdown is gone too — it auto-picks the latest finalized move-in.
Verified live: picking Apt 202 derives Carol + active lease.

**W-41 · Inspections → duplicate entry buttons** — ✅ FIXED: one "New
Inspection" button. The old "Start guided walkthrough" secondary button
passed ?walkthrough=1 to the same form — a param NOTHING ever read
(confirmed duplicate); the assistant-guided option lives inside the form as
before. Verified live: header shows exactly one button.

**W-42 · AI AGENTS — massive upgrades · SEQUENCED LAST (Nic: do at the very
end, after all other walkthrough changes)** — The agent cannot find things
that are demonstrably there in the seed data (retrieval/lookup failing), and
the agents need many other upgrades besides. (Claude note: in-house stack —
Hermes :8080 + bge embeddings :8081 + agent routes/tools in the API. Doing
this last is right: agents should be upgraded against the POST-fix portal so
tools/knowledge match the final surfaces. When we get here: re-ingest against
the new demo world, audit the tool set against every workflow this list
touched, and scope the "many other upgrades" with Nic as its own list.)

**W-43 · Inspections → overview tab shows IDs instead of names** — ✅ FIXED:
list endpoint now joins unit number + property + tenant name; page renders
them (was literally `uuid.slice(0,8)…`). Verified live. Original: Unit and
tenant columns show random numbers. Nic asked if it's privacy coding — it is
NOT: no such scheme exists; these are raw record IDs/UUID fragments rendering
where the unit number and tenant name should. Show real unit numbers + tenant
names. (Claude note: same missing-join/wrong-field class as W-37; landlord
context has zero reason to mask tenant identity.)

**W-44 · Amenities → "hold" option — INVESTIGATED, Nic decided (S531)** —
Investigation: holds are NOT redundant — landlord-side blocks (3 kinds:
maintenance_closure / private_rental / event) that go live instantly, carry
no fee, no tenant attribution; tenant reservations await approval + bill a
fee. **NIC DECISIONS: SPLIT.** ✅ BUILT (S531):
- **Split**: the Amenities hold modal keeps private rental + community
  event only (with a pointer to Maintenance for closures); the MAINTENANCE
  page gained a "Close Amenity" action (property → amenity → window →
  reason → notify toggle, amenities.hold perm, same backend route).
  Verified live: closure created from Maintenance, approved instantly,
  residents notified; artifact cleaned.
- **Tenant private events** (migration 20260704200000 — per-area
  events_enabled / event_deposit_amount / event_announce /
  event_auto_release, defaults = today's behavior): tenants can book
  kind='event' on opted-in areas (400 otherwise); the fee is the area's
  NON-REFUNDABLE event deposit (never the reservation fee, never
  refundable on cancel — paid stands, unpaid voids); the property-wide
  announcement ("Private event — <area>") fires only once the deposit
  SETTLES (fireAmenityAlert defers; hourly processTenantEvents sweep
  announces), or at approval when no deposit is set; unpaid at start time
  + event_auto_release → the sweep cancels, voids the deposit, notifies
  the tenant, and the space is open again; a paid+announced event the
  tenant cancels sends an "open again" property message
  (notifyAmenityEventReleased). Landlord area form has the event settings;
  tenant reserve modal offers "Private event" with deposit copy.
- Tests: commonAreas suite 13→16 (deposit + deferred announce → announce
  on settle; events rejected on non-opted areas; unpaid auto-release
  voids + cancels). tsc clean api/landlord/tenant.

**W-45 · Documents tab** — ✅ FIXED, all three:
- Blank docs: the two seed rows pointed at files that never existed AND the
  old View link opened the RELATIVE url on the frontend origin (double bug).
  Real PDFs now exist behind both seeds; files stream through a new AUTHED
  GET /documents/:id/file (missing file → clear 404 message, never a blank
  tab).
- Same-tab: View navigates to the W-29 /view route; Back returns to the list.
- Upload: "Upload Document" button + modal (file, name, type, optional unit
  tag) → POST /documents (25MB, pdf/image/word). New documents.upload
  permission key in the catalog. BONUS: the list endpoint now joins
  unit/tenant/property display fields (the columns were all "—" before —
  same W-37 class). Verified live: upload 201 → stream 200 → renders in
  /view.

**W-46 · Inventory tab** — Shows NO data and has no way to add any. Rebuild:
- ✅ FIXED (render bullet, S527): the page queried GET /inventory — a route
  that NEVER existed — and its columns (SKU/price) belonged to a table never
  built. Now reads real parts data (/maint-portal/parts) with honest columns.
- ✅ FIXED (full rebuild, S531): two sections on the one surface —
  **Supplies & Parts**: full CRUD (add/edit modals, delete w/ confirm) on
  parts_inventory via the /maint-portal routes (new DELETE /parts/:id,
  approve-perm only; PATCH extended to sku/description/unit) + low-stock
  count chip in the section header. **Equipment Service Schedules**: reuses
  scheduled_maintenance as the serviceable-asset model (a truck's oil change
  IS a recurring schedule — no new table, per the simplicity rule). Add
  Schedule modal (task/recurrence/first-due/optional property); Mark Done
  advances next_due by recurrence; overdue rows get red "due" badges + a
  header count.
- ✅ FIXED targets + alerts (S531): min_quantity is opt-in (0 = never
  alerts, "—" in the Min column). Daily 9am cron sweeps: parts at/below min
  → 'low_stock' notification; scheduled_maintenance next_due arrived →
  'service_due' notification. Both email + land in the bell with actionUrl
  /inventory (bell icon map extended). Verified live: add/edit/delete item,
  low chip 1→2→1, add schedule, Mark Done advanced 7/4→10/4 (quarterly);
  sweep SQL returns the seeded low item (water heater elements 2/4); all
  test artifacts cleaned from dev DB.

**W-47 · GLOBAL · typography + casing consistency** — ✅ FIXED:
- Font: Nic chose **Space Grotesk (display) + Inter (body)** from 3 candidate
  pairings (over Fraunces+Inter and Manrope+DM Sans). Applied in globals.css
  (@import + --font-display/--font-body) and the Layout LL_FONTS default;
  weight-800 rules clamped to 700 (Space Grotesk tops out at 700 — no fake
  bold). Verified live: fonts load and render on the dashboard.
- Casing: scripted sweep flagged 47 header + 18 button violations; Title Case
  applied across 25 files (column headers, page/modal titles, buttons).
  Empty-state messages ("No requests", "Tenant not found") stay sentence case
  — they're messages, not headers. Schedule tab buttons now carry real Title
  Case labels in the DOM (were lowercase + CSS-capitalized).
Original: Come up with a BETTER FONT for the portal. Enforce consistency:
TITLE CASE on menu headers and options; descriptions use regular sentence
grammar. Sweep everywhere.

**W-48 · Applicant Pool** — Three things:
- ✅ FIXED (first bullet): the dashes were EMPTY SEED FIELDS — the pool shows
  a redacted preview (employment/income/location/risk) with identity hidden
  until report purchase BY DESIGN ($1 unlock model). Seed now populates the
  preview fields; verified live. NOTE for Nic: the name staying hidden
  pre-purchase is intentional product design — confirm you want to keep that
  model when we do the reach-out work below.
- ✅ FIXED (second bullet): reach-out unit dropdown now reads the shared
  `GET /units/available` (open-ended from today) — the old status==='vacant'
  filter lied (a "vacant" unit can hold a future lease/booking). The SEND is
  guarded server-side with the same predicate (409 if the unit isn't free).
  Verified live: dropdown lists exactly the 8 free units.
- ✅ FIXED (third bullet): monthly rent comes from the unit's preset info
  (unit rent_amount, else subtype pricing) — shown in the dropdown + a
  helper line, included automatically in the tenant notification and email.
  Nobody types it. Verified live ($1,650 for House 01).

**W-49 · Background Checks → wire to Checkr (ALL applicants)** — Clarified by
Nic: EVERY applicant runs through Checkr, no exceptions. The split is only
about WHERE they land afterward: applying to a specific property/portfolio →
that landlord's Background Checks page; no specific property in mind → the
general Applicant Pool. (Claude note: provider integration — current backend
is provider_name='mock'; Checkr = external account + API keys + webhooks
(launch-account track alongside Stripe/Resend). One check pipeline, one
routing decision on destination. Iris (submitted) is the seed case. FCRA
consent flow exists in the bg-check model — verify it matches Checkr's
requirements.)

**W-50 · Checkr → payment workflow — VERIFY THEN BUILD** — Verify the whole
flow. Pricing shape per Nic: Checkr charges GAM its flat rate; the prospect-
facing UI shows the higher (GAM) charge — the margin lives on GAM's side,
outside Checkr. Sequencing is strict: the PROSPECT pays GAM FIRST, and only
then does GAM initiate its payment to Checkr — GAM fronts nothing, zero loss
exposure.
**RESEARCH DONE (S531):**
- Checkr partner docs don't restrict applicant-pays/pass-through billing;
  revenue-share partner program exists. BUT in a self-hosted flow the
  PLATFORM carries the FCRA obligations (consent capture + state/city
  disclosures + adverse action) — GAM's bg-check model already has the
  consent flow + adverse_action_notices; must be mapped to Checkr's
  requirements at integration time. Confirm pricing structure with a
  Checkr partner manager when the account is opened (launch-accounts
  track alongside Stripe/Resend).
- ⚠️ STATE APPLICATION-FEE CAPS CONSTRAIN THE MARGIN (decision needed at
  build): CA caps screening fees at ACTUAL out-of-pocket cost (~$65.86 in
  2026, unused portion refunded — markup unlawful); NY caps at lesser of
  cost or $20 (margin impossible); CO/IL/NY/RI require waiving the fee
  when the applicant brings a portable screening report (MD/WA/CA have
  PTSR laws too). This is the S177 hard-compliance carve-out shape — a
  per-state fee-cap catalog with annual refresh, like deposit-interest
  rates. NIC DECISION AT BUILD TIME: uniform nationwide price set to the
  lowest common denominator, or per-state pricing off a cap catalog.
BUILD (next session, needs Checkr account): prospect payment → settle
webhook → Checkr order fires, never before.

**W-51 · Rental History page → needs sample data** — ✅ FIXED: seed now emits
credit-ledger payment events through the ledger's own appendEvent (hash chain
stays valid — raw inserts would corrupt it): Alice 8 months clean (100%
on-time), Bob a rough patch (2 minor + 1 major late), Grace 2 months; stats +
scores recomputed at seed time so percentages show immediately. NOTE: this
required a FULL RESEED — property/tenant ids changed again; hard-refresh your
browser before re-walking. Re-walk the page for its own W items.

**W-52 · Team → permissions at INVITE time** — ✅ FIXED: verified the old
invite carried NOTHING (scope_payload with empty grants). The invite form
now has the required property picker (W-10) + a preset row (None /
Front Desk / the other catalog presets, with descriptions) — the preset's
keys ride the invitation's scope_payload and are written onto the scope row
at ACCEPT, so the person lands with the right access immediately. The full
permissions page stays for later adjustments. Scopes suite 18/18 green.

**W-53 · Settings → audit + consolidation — ✅ FIXED (S531)**: Notification
Prefs merged into Settings as a real section (NotificationPrefsSection —
prefs table + email-failures card render inside Settings); nav item removed;
/notification-prefs deep links redirect to /settings. Verified live.
Inventory presented to Nic: Account, Billing, Maintenance Approval,
Two-Factor, Default PM Company.

**W-54 · Work trade flow — ✅ FIXED (S531): PROMOTED FOR LAUNCH per Nic.**
/work-trade removed from LAUNCH_HIDDEN (nav + route live, verified);
stale "auto-billing unbuilt" comment corrected (S517 completed it).
Walkthrough pass logged as W-56.
Investigation confirmed it's feature-complete incl. automatic rent credit at
invoice time (approved hours ÷ property monthly target = % of rent credited,
rent-first then utilities then fees) + landlord agreement mgmt + tenant hour
logging + 1099 threshold reporting. Action: remove /work-trade from
LAUNCH_HIDDEN (nav + route) and give it its own walkthrough pass this cycle
(NEW ITEM W-56 below).

**W-55 · Master Schedule → ONE detail window for all bar types** — ✅ FIXED
with W-18: identical field set for leases and stays (unit, term/stay dates,
email, phone, money line, status) — master query now supplies lease tenant
contact. Verified live on Alice's lease + Bill's stay. Original: Clicking a
reservation vs. a leased spot pulls up two different windows: RV/short-term
stays show name + phone; leased spots show only a name. Same window, same
fields for both. (Claude note: the detail modal branches on isLease and the
lease side skips contact fields — unify: name, phone, email, dates/term,
payment state (per W-18) regardless of bar type. Lease contact info comes
from the primary tenant's user record; folds naturally into the W-18 popup
redo — fix together.)

---

## LANDLORD LIST CLOSED (Nic, 2026-07-04) — 55 items
Utility billback = W-36 (already logged). Fix phase starts now, BEFORE
walking the other portals. Standing instruction from Nic: anything touching
multiple points gets fixed COLLECTIVELY (one shared fix), never patched on
one end.

**W-11 · Point of Sale → seeded items missing** — ✅ DIAGNOSED, folds into
W-12: the data is fine (API returns all 5; they render once Sunset Palms is
picked in the register's property selector). The items were "missing" because
the register requires a per-sale property pick and defaults to none — the
exact UX W-10/W-12 eliminates. Fixed collectively with the POS per-property
separation, not patched here.

**W-12 · Point of Sale → full per-property separation** — ✅ FIXED (S531).
ONE page-level property picker now scopes the ENTIRE POS surface (both the
landlord POSPage and the standalone apps/pos copy) — every tab reads and
writes within the selected property; no tab renders until one is picked
(single-property operators auto-select).
- **Frontend**: picker hoisted from the register tab to the page header;
  items/categories/tax-rates/discounts/history/orders/inventory-log/
  low-stock queries all keyed + filtered by it; per-form property pickers
  and the S216 items-tab filter KILLED; new items/discounts/POs stamp the
  page property; new tax rates default to it ("All locations" stays an
  explicit choice for company-wide rates like state tax). Standalone-app
  bug fixed in the same pass: its checkout only sent propertyId on charge
  sales — cash/card sales were property-less.
- **Backend**: POST /transactions now REQUIRES propertyId (400 without);
  /transactions, /transactions/sales (all 4 queries), /inventory-log,
  /low-stock accept ?propertyId=. Migrations 20260704160000/160100 add
  property_id to pos_discounts + pos_purchase_orders (NULL = company-wide /
  legacy, same union-read posture as tax rates).
- **EOD per property** (migration 160200): pos_eod_settlements gains
  NOT-NULL property_id, unique anchor → (landlord, property, business_day);
  posEod engine + nightly sweep close one drawer per (landlord, property);
  /eod routes take propertyId (close/regenerate require it; /eod/:date now
  returns an array — one settlement per property). Table was empty
  everywhere, so no backfill.
- Deliberately landlord-wide: pos_vendors (supplier roster, not sales
  data) + pos_tax_categories (taxonomy labels; the RATES are per-property).
- Verified live: items/history/tax tabs flip with the picker (Sunset 5
  items ↔ Oak Street 0); rang a real cash sale at Sunset → landed stamped
  with the property, visible ONLY in Sunset history, absent from Oak
  Street; artifacts cleaned (stock restored). pos suite 83/83 green; tsc
  clean api + landlord + pos.

**W-56 · Work Trade — walkthrough pass (NEW, from W-54 promotion)** — Nic
promoted work trade for launch (S531); /work-trade is unhidden. Demo data
seeded for the walk (Grace: groundskeeping agreement, 15.5h approved +
2 pending; mirrored into seedDemo). Items logged so far:
- **W-56a · hours target per PERSON, not per property** — ✅ FIXED (S531):
  "different rent rates for units and different work being done don't all
  equally translate." Migration 20260704210000 adds
  work_trade_agreements.monthly_hours_target (backfilled from the property
  value, CHECK > 0); the credit engine (workTradeCredit) + every
  agreement read now use the AGREEMENT target;
  properties.work_trade_hours_target survives only as the default applied
  to NEW agreements (page relabeled accordingly); per-row inline target
  editor on the roster (PATCH /work-trade/:id monthlyHoursTarget);
  create route accepts a per-person target. Verified live: Grace 80→60
  persisted per-agreement. workTrade suite 26/26 green untouched.
- **W-56b · tenant row pulls up the lease** — ✅ FIXED (S531): the roster
  row is clickable (tenant name in gold) → /leases?open=<active lease id>
  (lease id LATERAL-joined into GET /work-trade); the target cell
  stopPropagations so inline editing doesn't trigger the row. Verified
  live: Grace's row opens her lease modal.
(Nic continues the walk — further items log here.)

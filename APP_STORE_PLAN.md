# APP STORE PLAN — tenant, landlord, POS on iOS + Android

Written S557 (2026-07-25). Supersedes the earlier draft in this file
entirely — several conclusions in that version were wrong and are
corrected here.

**Nothing in this doc starts before Oak Park launch is done.** Until
tenant invites are sent and tenants are onboarding or in customer
service, the only goal is rent payments on the web. Nic's call.

---

## 1. Where we're starting from

Three Vite + React SPAs — tenant (:3002), landlord (:3001), POS (:3005)
— built to static files, served from Vercel, hitting the one API.

**Zero mobile groundwork exists.** No Capacitor, no React Native, no
PWA manifest, no service worker, no `ios/` or `android/` directory.

**Approach: Capacitor.** It wraps the SPA we already build into real
Xcode and Android Studio projects — same React code ships to web and
both stores, with native capability added plugin by plugin. A Capacitor
app *is* a native app; it just renders UI in a webview. React Native or
Expo would mean rewriting three apps, which means it never ships.

Ship **both** stores. Almost all the work is shared.

---

## 2. Decisions locked

### Distribution
- **Apple App Store + Google Play. Nothing else.** Amazon shut down its
  Appstore for Android on 2025-08-20 (Fire devices only now, and Fire OS
  has no Google Mobile Services). Samsung Galaxy Store and Huawei
  AppGallery are irrelevant to Arizona landlords and tenants.
- **Organization developer accounts under Gold Asset Management, the
  software company — never Oak Park.** App ownership and bundle IDs
  follow whichever account enrolls, and unwinding it later is painful.

### The three products
- **POS is its own product**, not a landlord feature. Own signup
  (`SignupPage.tsx`, `BusinessRegisterPage.tsx`), own login, own team
  management, own customers (`pos_customers` are merchant-owned
  non-tenant customers). Landlords who sell things are one customer
  type among many.
- **FlexCharge is a merchant capability**, not a GAM consumer product.
  A merchant — POS operator, or a landlord selling RV parts in the
  front office — extends a small line of credit to their own customer.
  GAM ships the functionality and is not a party. Account holders are
  frequently not tenants at all.

### Store billing — who pays what, and where
Two separate rule sets are in play and they behave differently:

**Rule set A — IAP / Play Billing.** Governs purchases and links.
Reaches only our **SaaS revenue**. Every Flex product and every rent,
deposit, or custody charge is a real-world financial service, exempt
outright on both stores, sellable in-app through Stripe with no store
cut and no linking restriction.

**Rule set B — personal-loan guidelines** (Apple 3.2.1(viii), Google's
equivalent). Ignores where money changes hands entirely. Looks at what
the app *appears to offer*. This is the one FlexPay must stay clear of.

| Revenue | Rule set A? | Treatment |
|---|---|---|
| Rent payments | Exempt | In-app, Stripe |
| FlexDeposit $3/mo custody fee | Exempt | In-app, Stripe |
| FlexCredit | Exempt | In-app, Stripe |
| Card processing markup (POS) | Exempt | Transaction economics, untouched |
| Landlord platform fee ($2/unit) | **Exposed** | Web-only. No link, no pricing, no mention in either app. |
| POS invoicing add-on ($10/mo) | **Exposed** | Web-only. No link, no pricing, no mention in either app. |

**Why the $3 custody fee is exempt and the landlord's $2/unit isn't:**
the test is whether what you bought is consumed inside the app or
outside it. The custody fee is the bank case — if the app vanished, the
money is still legally the tenant's, held in custody, recoverable as a
custodial asset. The app is a window onto a real-world thing. The
landlord's subscription is the Notion case: the software *is* the
product, and without it there's nothing left. "It helps them in the
real world" is not the test — all software helps someone do something
real.

### Netflix pattern. No links, no store revenue, ever. (Nic, S557)

**Build as if Apple charges for external links.** Apple's current
zero-commission US links exist only because of the Epic contempt
ruling, and Apple is actively litigating to overturn it. Anything built
on that window has to be rebuilt when it closes. So we don't use it.

**The rule: no purchase mechanism and no external purchase link in
either app, on either platform, for anything the stores could tax.**
Landlords and POS merchants subscribe on the web. The app is sign-in
only for those flows — no pricing, no billing screen, no "subscribe on
our website" link, no mention of where to go. Exactly what Netflix
does, and it survives any policy change because it never touches the
purchase surface at all.

Rejected alternative: Spotify's approach (offer IAP at an inflated
price to cover the cut) requires actually enrolling in IAP, which means
Apple gets paid. On a $2/unit product you'd have to raise the price
~43% to net the same after 30%. Not worth it.

**Google would allow more, and we're declining it anyway.** Play
Billing isn't required for cloud/business software or real-world
services, so Android could sell everything in-app. Under the
identical-apps rule (below), Apple sets the floor. For the record, so
nobody re-derives it: no Play Billing requirement means the
external-offers service fee never attaches, so there was never a 24h
attribution window to engineer around — and that fee dropped to 0%
initial acquisition on 2026-06-04 regardless. Google's attribution is
self-reported tokens via the `externaltransactions` API, not
surveillance, so link chains wouldn't defeat it and delaying charges
would be circumvention. All moot: we never enroll in the program.

### The netting structure beats all of this (S557, decisive)

**The landlord never pays GAM.** Verified in
`jobs/platformFeeAccrual.ts`: the fee accrues monthly and the
landlord's payouts "net out this amount via Stripe Connect destination
charge math." The tenant-payer variant rolls it into
`application_fee_amount` on the rent charge instead. Either way there
is no card on file, no invoice, and no charge the landlord initiates.
POS invoicing works the same way — netted from Connect settlements.

**This isn't a workaround; it's outside the rule entirely.** IAP
attaches to a purchase transaction initiated by the user in the app.
Here there is no purchase — GAM nets its cut from funds it is already
processing on the landlord's behalf. That's the marketplace model:
Uber takes ~25% of driver fares, Square and Shopify and Stripe and
DoorDash and Etsy all net platform fees from seller proceeds, every one
of them displays those deductions in their apps, and Apple has never
claimed a cut of any of it. There is nothing for Apple's payment system
to intermediate.

Consequences:

1. **The landlord cost screen is fine — build it.** Rents in, platform
   fees out is an *earnings statement*, not a billing screen. Uber
   drivers see exactly this. Nothing is billed, so there's nothing to
   route through IAP.
2. **Landlord signup ships in the app** (Nic, S557) — signup collects
   no payment method and triggers no charge, same as an Uber driver
   signing up.
3. **POS signup ships in the app.** There is no invoicing toggle to
   worry about — invoicing is an existing feature, and if a merchant
   sends *any* invoice in a calendar month, $10 comes out of that
   month's proceeds (disclosed). Usage-triggered and netted, so there's
   no upgrade, no purchase, and nothing for a reviewer to look at.
   **No merchant or customer ever types a card to pay an invoice** —
   deliberate: fewer stored card details, smaller breach surface, and
   a lighter privacy-label disclosure at submission.

**The one rule that preserves all of this: never build an in-app "pay
your platform fee balance by card" path.** If arrears ever need
collecting outside the netting mechanism, do it on the web. A card
charge initiated in the app is the single thing that would drag this
back into IAP territory. This is the Netflix pattern reduced to what
actually matters — we don't need web-only *signup*, we need no in-app
*card charge* for software.

**Closed (Nic, S557):** a landlord hitting the $10 minimum with zero
rent collected is a lottery-ticket edge case. If it ever happens the
accrual just carries and nets whenever rent does flow. No separate
collection system gets built for it. Same answer for a POS merchant
with thin settlement volume.

### What still gets paid IN the app — do not over-apply the rule above

The Netflix pattern applies to **software subscriptions**. It must not
be applied to real-world financial services, or the tenant app stops
being a tenant app.

**Rent, deposits, the FlexDeposit $3/mo custody fee, and FlexCredit are
paid in-app through Stripe, and always will be.** This is not a
litigation-dependent carve-out like the link ruling — it's the
foundational IAP boundary in guidelines 3.1.3(e) / 3.1.5(a), and
Apple's whole business depends on not taxing it. Uber, DoorDash, Chase,
Venmo, and Klarna all take payment in-app with no Apple cut. Same
ground.

Removing rent payment from the tenant app to be safe would delete the
reason the app exists. Don't.

**Closed as moot:** whether GAM qualifies for Apple's 3.1.3(b)
Enterprise Services carve-out. We aren't selling software in-app on
either platform, so it doesn't matter.

### Per-app account creation

| App | Signup in app? | Why |
|---|---|---|
| **Tenant** | **Yes** — `AcceptInvitePage` → `POST /api/tenants/accept-invite` | Invite activation isn't a purchase. Zero exposure. Tenants must be able to onboard on their phone. |
| **Landlord** | **Yes** — `RegisterPage.tsx` ships | Signup collects no payment method and triggers no charge. Platform fees net from rent proceeds, never a card. Not a purchase. |
| **POS** | **Yes** | Signing up buys nothing, and the $10/mo invoicing fee nets from Connect settlements. Not a purchase either. |

**Net result: all three apps have in-app signup. FlexPay is the only
thing excluded from the apps.**

### Identical apps across both stores (Nic, S557)

**The iOS and Android builds ship the same content.** Where the two
stores disagree, Apple sets the floor — we don't build a richer Android
app just because Google allows it.

What this costs: Google would let us sell the landlord subscription and
POS invoicing in-app, and we're declining it. The cost is Android
*funnel friction* — a browser handoff Google didn't require — in
exchange for one codebase, one QA pass, one support script, and a
posture that doesn't need rebuilding when Apple's link ruling flips.

**Landlord acquisition barely notices.** Landlords are sold to, not
discovered via App Store browsing — sign-in-only is exactly why the
Netflix pattern works for B2B. **POS feels it more**, since merchants
plausibly search the store for "point of sale," which is why free POS
signup staying in-app matters (see below).

**What can't be identical:** hardware integration. Tap to Pay needs an
Apple entitlement on iOS and Google Mobile Services on the device for
Android. Identical *content* is achievable; identical *capability* on
the payments hardware isn't.

### Flex placement

| Product | In the apps? | Reasoning |
|---|---|---|
| **FlexDeposit** | **Yes** — describe, enroll, charge | Custody, not credit. Tenant pre-funds their own deposit; GAM floats nothing, holds the cash, has no recourse. Hiding it costs move-in conversion for zero risk reduction. |
| **FlexCredit** | **Yes** | Credit *reporting*, not credit. Self, Boom, Experian Boost, and Esusu are all in the stores. Gets better with push. |
| **FlexCharge** | **Yes**, on POS/landlord side | The app's user is the merchant extending credit, not the borrower. Ordinary B2B software. |
| **FlexPay** | **No surface at all** | The only product where GAM's own cash goes out ahead of collection. Not described, not linked, not mentioned. |

**The in-app Flex reference:** FlexDeposit and FlexCredit carry their
own descriptions. One generic line — *"To learn more about Flex, visit
our website"* — with **Flex as a brand name only**, no product detail
behind it, no mention of FlexPay. Safe on both stores: no steering
problem (financial services are exempt), no loan-guideline problem
(a brand name with no mechanics described offers nothing).

**The path to FlexPay (Nic, S557):** app → generic Flex link → Flex
overview page → FlexPay page → signup. Three hops, and every one of
them is off-app.

That chain is fine on both stores. **Billing:** FlexPay is a financial
service, exempt from IAP and Play Billing regardless of hop count, so
no fee attaches anywhere along it. **Loan guidelines:** the rule asks
what the *app* offers, and an app linking to a company site with a
broader product line has never been the violation — every bank app
links to a site selling mortgages without becoming a lending app. Two
clicks of separation behind a category page is more than enough.

**The one leak to watch:** reviewers follow the URLs you submit. The
marketing URL, the support URL, and the in-app Flex link must all land
on pages that aren't FlexPay-forward — FlexPay should be *reachable*
from the Flex overview, not *featured* on it. The real exposure isn't
the chain; it's the App Store listing copy and screenshots, which are
the app describing itself.

**Do NOT pull FlexPay off the website during review.** Reviewers check
your app and your submitted URLs; they don't audit your site for
products that aren't in the app. Companies sell things on the web that
aren't in their apps all the time. Taking a live product down would
cost real enrollments and corrupt the demand signal.

**FlexPay ships later as an app update**, once the apps have a track
record.

### Other
- **Social login: skipped.** No third-party login exists today, so
  Sign in with Apple isn't triggered. Revisit only if we add Google
  sign-*in* — that would obligate Sign in with Apple alongside it.
- **Port order: landlord and tenant first, POS last.** POS has the
  strongest "why is this an app" story but the highest port cost —
  see §5.

---

## 3. Settled here + what's still open

**FlexPay fee — SETTLED (Nic, S557):** flat **$25**, called a
**subscription fee**. Never "origination fee" — origination fees exist
only to originate loans, and the word concedes what the S304 structure
denies. "Subscription fee" also matches the existing
`legal/FLEXPAY_SUBSCRIPTION_TERMS.md` and the neutral
`flexpay_monthly_fee` column, so there's no drafting churn.

**Enrollment identity — SETTLED:** **Gold Asset Management LLC**,
Delaware, matching exactly what's on the Stripe account. **No D-U-N-S
exists yet** — it has to be requested, and that's the 30-day clock.
EIN to be supplied.

> **Before requesting one, run Apple's D-U-N-S lookup tool.** Reason:
> Dun & Bradstreet is a *business credit bureau*. It builds records
> from public data — including state incorporation filings — without
> the business ever contacting them, the same way Experian has a credit
> file on you that you never opened. A Delaware LLC formation is a
> public filing, so D&B may already have auto-created a record for Gold
> Asset Management LLC. Nic has done nothing with Apple or D&B; that's
> not what creates the record.
>
> Why it matters: if an auto-created record exists with a stale or
> wrong address (registered-agent address instead of the real one is
> the usual case), Apple's verification fails against it. And filing a
> fresh request when a record already exists creates duplicate entries
> that take longer to merge than correcting the original. The lookup is
> free and takes a minute. If a record exists, correct it; if not,
> request one.
>
> Either way, the name and address must match the Delaware
> incorporation documents character-for-character. Mismatches are the
> single most common cause of Apple org-enrollment delays.

**FlexPay payments-page display — SETTLED (Nic, S557):** §3a approved
as written.

### Still open
1. **App names and bundle IDs** for all three. Needed at build time.
2. **EIN.** Needed at enrollment.
3. **Confirm the survey stays off-app** (§3b recommendation, not yet
   Nic-confirmed).

## 3a. What a FlexPay tenant sees on the payments page

**The reviewer angle is nearly moot, and that's the key insight.**
FlexPay enrollment requires SSI/SSDI income verification through an
admin approval queue. A reviewer with a fresh test account **cannot
reach this screen state at all** — they see the ordinary rent screen.
The store risk was always the marketing and description surface, never
the transaction records of an already-enrolled tenant.

So design this for the tenant, not the reviewer.

**The failure modes to avoid, in order of harm:**
- Showing rent as **PAID** (true for the landlord, false for the
  tenant) → tenant assumes they're done, spends the money, the pull
  NSFs, and per the Consumer ToS that's a **90-day re-enrollment
  lockout**. Worst outcome, and it hurts the person we're serving.
- Showing rent as **UNPAID/DUE** with a Pay Now button → tenant pays
  manually, then the scheduled pull hits too. Double payment.

**Recommended state: neutral and scheduled.**

> **Rent — $1,000**
> **FlexPay subscription fee — $25**
> **$1,025 scheduled — automatic withdrawal July 20**

That's accurate, it prevents both failure modes, and it describes
nothing. No "advance," no "fronted," no "we paid your landlord ahead."
From the tenant's side this is just autopay, which is the most ordinary
thing in any payments app.

**Rule of thumb: you don't hide the money, you hide the mechanism.**
The amount and date must be visible — hiding a pending debit from the
screen where someone manages payments is the real disclosure problem.
What stays out is the *why*, which the tenant already received at
enrollment on the web.

Naming the $25 line "FlexPay subscription fee" is fine and preferable
to a generic label — the tenant should recognize the name they enrolled
under, and a charge line for an enrolled user is a transaction record,
not a product offering.

**Failed pull:** same neutral treatment — show the retry date and the
pass-through ACH return fee as its own line. Never let a failure state
be silent, since the 90-day lockout rides on it.

**Landlord side:** unchanged, and already correct — the landlord sees
rent received. FlexPay must never surface in the landlord portal
(CLAUDE.md).

## 3b. The demand survey should NOT go in the app

FlexPay is in pre-launch **survey mode** today (S544): the tenant
portal shows "coming soon" plus an interest survey, enrollment closed.

**Recommendation: keep the survey on the web only.** It inverts the
logic of §3a. The enrolled payment state is safe *because it's gated* —
a reviewer can't reach it without SSI/SSDI verification and admin
approval. A survey is shown to **every** tenant, including a
reviewer's demo account, which makes it the single most
reviewer-visible FlexPay surface in the product.

And a survey can't avoid the problem, because nobody can express
interest in a name. To be worth anything it has to say what FlexPay
does — GAM pays your landlord now, you pay GAM later — which is exactly
the description we're keeping out of the app.

**Preserve the demand signal off-app instead:** email the survey link to
tenants. Email is outside store rules entirely, it reaches the same
people, and response tracking is at least as good. The generic Flex
link in the app already covers anyone who goes looking.

## 3c. The demo account is the reviewer's entire view — curate it

Apple requires a working demo account in App Review Information for any
app behind a login, and Google expects the same. **Whatever that account
sees IS the app, as far as review is concerned.**

Two failure modes, pulling opposite directions:

- **Too empty → rejected.** A fresh tenant account with no lease, no
  rent due, no history gives a reviewer nothing to evaluate, and
  "we couldn't assess the app's functionality" is a real and common
  rejection under minimum-functionality. This is the standard trap for
  gated B2B apps.
- **Too complete → shows what we're hiding.** A demo tenant with an
  active FlexPay enrollment puts the one thing we're routing around
  directly in front of the reviewer.

**Requirement: purpose-built demo accounts, populated but FlexPay-free.**
Active lease, rent history, a maintenance request or two, documents to
sign, inspection photos — enough to demonstrate why it needs to be an
app (§4). Zero FlexPay enrollment, zero FlexPay survey.

We already have the raw material (`james@demo.dev` /
`alice@tenant.dev` / Sunset Palms RV Resort). This is a build item at
submission time, not a new system.

---

## 4. Why these need to be apps (Apple 4.2 / Google 4.3)

Both stores reject webview wrappers now — Google's Policy 4.3
enforcement tightened through 2026, so there's no lenient platform. The
same native work satisfies both.

**The inspection camera is the strongest product reason**, but the
argument has to be stated correctly. Mobile Safari *can* show a live
camera preview — that's what `CameraCapture.tsx` does today via
`getUserMedia`. "Safari can't do live camera" would not survive a
reviewer who tries it. What holds up:

1. **Safari discards backgrounded tabs.** We already ship a
   tab-resilience script in every `index.html` (S540) because of this.
   A landlord walking 32 units for an hour *will* lose the tab.
2. **Offline batch capture** — inspections happen where there's no
   signal. Native queues dozens of full-res photos; a webview fights
   quota and eviction.
3. **Background upload** — Safari stops the moment you leave the tab.
4. **Real capture pipeline** — `getUserMedia` yields a downsampled
   canvas frame with no EXIF and no geotag. For evidentiary move-in and
   move-out photos, that difference is the point.

Per app: **POS** adds Stripe Terminal hardware + the existing IndexedDB
offline sync queue (`syncQueue.ts`). **Landlord** adds inspection
camera, push for applications/payments/maintenance, offline field
capture. **Tenant** adds move-in inspection camera, push for rent due
and maintenance, FlexDeposit flows, Face ID.

---

## 5. POS is the expensive port

`apps/pos/src/lib/terminal.ts` collects card-present payments in-browser
via `@stripe/terminal-js` over Bluetooth. **Web Bluetooth does not exist
in WKWebView on iOS** — that path breaks the moment POS runs inside
Capacitor. There is no incremental option: POS on iOS *requires* the
native Terminal SDK via a plugin bridge
(`@capgo/capacitor-stripe-terminal`), plus a build-time branch so the
web build keeps `terminal-js`.

**Tap to Pay** needs the native Terminal iOS SDK (min 2.23.0) and the
`com.apple.developer.proximity-reader.payment.acceptance` entitlement,
requested separately. Capacitor can do this — it is *not* a reason to
go fully native — but it's the most native-heavy work in the plan and
has known friction at TestFlight distribution.

**Android Tap to Pay hardware requirements — vet before buying any
device:** NFC, Android 9+, ARM, non-rooted with locked bootloader, a
security patch from the last 12 months, **and Google Mobile Services
with the Play Store installed.** That last one rules out Fire tablets
and cheap no-GMS POS hardware.

---

## 6. Build items that don't exist yet

- **Account deletion.** No endpoint anywhere in the API. Apple tests
  this end-to-end now — reviewers create an account, delete it, and
  check the backend. Google separately requires a **web-accessible
  deletion URL**. Three pieces: API endpoint, public web page, one
  shared in-app screen.
  **The hard part:** we can't hard-delete rent ledgers, remittances, or
  anything feeding 1099s. Deletion has to be *anonymization plus a
  documented retention policy* — strip PII, keep the financial record
  under a tombstoned user. Design pass, not a quick endpoint.
- **Push delivery.** APNs + FCM, device token storage. The in-app model
  exists (`NotificationBell`, `TenantNotificationsPage`); delivery
  doesn't.
- **Native camera** swap in `CameraCapture.tsx` (both apps).
- **Biometric unlock + Keychain/Keystore token storage** — not
  localStorage in a webview.
- **Store assets** — icons, splash, 6.7"/6.5" screenshots, Apple
  privacy nutrition labels, Google Data Safety form. Honest disclosure:
  payment info, ID documents.
- **Post-freeze cleanup:** the FlexPay UI still shows the sliding-scale
  fee. Needs to match whatever the flat fee lands at.

---

## 7. Store mechanics worth knowing

**D-U-N-S is the long pole.** Both Apple and Google require one for an
organization account, and the request can take **up to 30 days**. One
number unblocks both stores. It's a form plus passive waiting — roughly
30 minutes of Nic's time, then dead clock. This is the only item worth
starting before we're ready to build.

**Organization accounts skip Google's testing gate.** Personal Play
accounts created after 2023-11-13 must run closed testing with 12
opted-in testers for 14 continuous days before publishing to
production. Org accounts go straight to production — saves 2+ weeks on
top of the entity reasons.

**Cost:** Google Play $25 one-time, Apple $99/year.

**Updates are re-reviewed.** There's no approve-once-approve-forever,
and Apple can pull an approved app later. But the first submission
carries the heaviest scrutiny, and updates typically clear in hours to
a day. That's why launching FlexPay later as an update is sound — it
gets reviewed as a change to an established app with a track record
rather than as part of a first submission from an unknown developer.

**Budget for one rejection round.** It's normal, not failure.

---

## 8. Sequencing

1. **Nic enrolls both developer accounts** as Gold Asset Management,
   starting the D-U-N-S clock. Passive from there.
2. **Capacitor on landlord or tenant** — push, native camera,
   biometrics, account deletion. TestFlight + Play internal testing.
3. **First submission.** Learn the review cycle on the app whose native
   surface is plugins we don't carry risk on.
4. **The other of landlord/tenant.**
5. **POS last** — native Terminal plugin, Tap to Pay entitlement.
6. **FlexPay as a later update**, once there's a track record.

**Timeline:** ~1–2 weeks to a first TestFlight build once we start.
~4–8 weeks to first approval including a rejection round. D-U-N-S runs
up to 30 days in parallel and should start first.

---

## 9. One thing to be clear-eyed about

The App Store isn't a system where being right helps. There's no appeal
to intent that beats a guideline reading, and a reviewer isn't
empowered to accept "we're actually helping people." If an app gets
pulled, the tenants it was meant to reach lose it entirely.

The part worth holding onto: **none of this asks us to change the
product.** Not what FlexPay does, not who it serves, not what it
charges, not the SSI/SSDI focus. Everything above is sequencing and
where things are described. And the web is uncontrolled —
goldassetmanagement.com is subject to no one's review. The stores are
one distribution channel, not the business.

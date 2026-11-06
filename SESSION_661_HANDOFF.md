# Session 661 handoff — the phone, and the globe

Everything below is **deployed and verified live**, across 12 deploys. Every
deploy from now on emails Nic by itself (see "Deploy emails", below).

---

## What Nic asked for, and where it landed

### The phone, portal by portal

He browsed the landlord portal on his own phone and said it "looks like shit…
not usable at all", then walked through page after page. The thread running
through all of it was the same: **"I don't want the tables to scroll. I want the
things to be resized so you can view. When I see the tenant's name and the unit
number and I have to scroll over to the right to see if they paid, that's not
okay. It needs to be shortened and condensed into a card."**

| portal | what it got |
|---|---|
| landlord, pos | the full package (shipped earlier in the night) |
| **admin** | drawer + scrim + hamburger, tables as cards, `--mx` grids, console name out of the bar |
| **admin-ops** | same package; it had **no** phone rules at all |
| **books** | same package, plus the ledger opt-outs below |
| **tenant** | already had the better layout (drawer, scrim, bottom tab bar, safe-area insets); its **table stacking was opt-in and reached only 2 of 11 tables** |
| **storefront** | nothing needed — already mobile-first (min-width queries, no sidebar, no tables) |
| business, listings | **not done, deliberately — see "Waiting on Nic"** |

Three portals (admin, admin-ops, books) had their stylesheets **extracted out of
JS template literals into real `.css` files**. That was not tidying: the rules
being ported carry backticks in their comments, and every one would have closed
the literal early. All three had zero interpolation, so it was mechanical.

**Books is the one with judgment in it.** Not everything there is a list. A trial
balance is the proof the books balance — read down its columns — so card-stacking
it destroys the document. These carry `data-no-stack` and keep their shape:
the **trial balance**, a **journal entry's lines**, the **journal line editor**,
and the **comparative P&L statements**. Everything that is a list of rows (vendors,
bills, transactions, outages) cards up. The **general ledger was left to card up**
— it is a transaction list and each card carries its own labelled debit, credit
and balance. What that loses is scanning the running-balance column. One attribute
if Nic wants it columnar.

### The move-out cards

His spec, followed exactly: person and button on top, phone on its own line,
email on its own line, the leaving day on its own line, the note underneath.
The old row was four flex children with hard inline min-widths, which left the
status column a few characters wide (hence "each word's on its own line") and let
a long email decide the row's height (hence "they're not even all uniform").
It is a grid with declared tracks now — identical columns in every row on the
desk, identical cards on a phone.

### The globe

**The oval slit is fixed, and it was a data bug, not a drawing bug.** Canada's
49th-parallel border had survived the geometry build as ONE segment spanning
27.91 degrees with no intermediate vertex. d3-geo draws a segment as a great
circle, which between two points at the same northern latitude passes poleward —
that chord bowed **94.4 km** north of the real border, while the US side (a
different, finer file, 137 vertices) sat true. The lens between the two fills was
filled by nothing: the card's background showing through the globe, widest over
Montana and tapering at both ends.

Douglas-Peucker was not misbehaving: a point on a straight run has weight **zero**
and is dropped at any threshold, so no coarseness setting could have fixed it.
`densify()` in `apps/admin/scripts/build-geo-boundaries.mjs` now leaves no segment
longer than one degree. Worst departure, measured across whole files:

| file | before | after |
|---|---|---|
| world (the fill) | 94.4 km | 0.12 km |
| country (the line) | 36.4 km | 0.12 km |
| adm1 (province line) | 24.5 km | 0.12 km |

Cost: world +13.6% (48→55 KB), the other two +0.1%. The three near-parallel
border lines collapse onto one for the same reason.

**The boundaries stay lit through a drag**, which is what he asked for ("so you
can see like where you want to stop"). The old gate drew none, for a measured
reason. Measured again before choosing — and the obvious lever failed:

```
full detail, both heavy meshes      79.2ms
projection precision 0.6 -> 3       NO saving at all
one point in 4                      26.2ms
one point in 12                     12.0ms   <- chosen, ~22fps
one point in 24                      8.2ms
```

Coarsening the projection's precision buys nothing: these meshes are already
denser than the resampler would subdivide to. Thinning the geometry is what
pays, and the curve flattens past 1/12 because the 27 ms of fills dominates
(ceiling with no lines at all is ~37fps). Full detail returns the moment the
globe stops.

### Security and account

- **A fully executed document locks its signing link.** The gate checked for
  `voided` and never for `completed`, so a link stayed live forever after there
  was nothing left to sign — which is what put a completed lease above a sign-in
  screen on his phone. Both doors close now: the signing page AND the PDF behind
  it. Nothing is taken from the signer; both completed-document emails already
  attach the PDF and point at the portal.
- **Refusals on `/api/esign/files` were going out labelled `application/pdf`.**
  A blanket `Content-Type` sat in front of that path and `res.json()` only sets
  one when none exists, so the 403, the 404 and the new 410 all arrived as
  unparseable bodies. Removed; `sendFile` types from the extension and all 271
  documents end in `.pdf`.
- **A change-password card exists** (Settings → Password). The endpoint was there
  and tested the whole time; nothing called it. Ungated on purpose — a front-desk
  login changes its own password too. It warns first and signs you out itself,
  because the change invalidates every existing pass by design.
- **Every sign-in form now carries autofill attributes.** Not one did. That is
  the real reason Chrome on iOS would neither fill nor save his password.

### Screening

The emailed application link and its QR already existed but lived only on the
Properties page and the register's Checks tab. They are on the **screening page**
now, where the dashboard's Applications card lands — and that card carries the
dashboard's selected property through, so the link on the other side is already
the right one. **There is no default property and no "all properties" option**:
his words were "if you are on the wrong property the screen gets linked wrong."

---

## Deploy emails — in the script, not in anyone's memory

`deploy.sh` emails Nic on **every** run now, via an `EXIT` trap so the early
aborts mail too. Subject says `LIVE` or `FAILED — nothing shipped`; the body
lists each surface and, when the gate blocks, names the failing test. A mail
failure never changes the deploy's result. It does **not** tee stdout — that was
the obvious implementation and it would have deadlocked on the `wait` at the end
of the parallel stage.

---

## Defects found and fixed in passing

- **A regression this night's own work shipped:** the table-as-cards rules broke
  the **Master Schedule**. Its timeline is a grid that is a picture — cells placed
  by table geometry — so `display:block` flattened a 5,491px grid into one 145px
  column. Fixed with `data-no-stack`, **and guarded by a test**, because the damage
  only shows on a phone, which is the one place nobody runs the suite. That guard
  immediately caught a second thing: the day-ruler strip was being told to wrap,
  surviving only because its declared width matched its children to the pixel.
- **Admin's dialogs painted no background and no border.** 16 places asked for
  `--bg-1`, `--border-1`, `--text-0`; admin defines `--bg1`, `--b1`, `--t0`.
  Aliased the three families. **admin-ops had the identical bug.** **Books had it
  too, for a different reason** — its stylesheets define the long names but scope
  them to `.fin-host`, and the dialogs render at the app root (verified undefined
  there in the browser).
- **A date-dependent test blocked a deploy at 00:07 and would have blocked the
  last deploy of every month.** `booksLoansAssets.test.ts` expected depreciation
  through *last* month from a flat formula; the server counts every month whose
  end day is on or before today, so on the last day of a month it returns one
  more. Fixed with the real term and proved against a brute-force count over 15
  dates including month-ends, Feb 29 and a year rollover.
- **Two ledger pages were byte-identical twins guarded by nothing.**
  `TrialBalancePage.tsx` and `GeneralLedgerPage.tsx` are imported only by each
  app's own `main.tsx`, which is not a parity entry point, so a one-sided edit
  drifted in silence — exactly what the phone work was about to do to them. Added
  to `bookkeeping-parity.test.ts` (34 → 36 checks); passed immediately.
- **`stackTables.ts` was two byte-identical copies with three more proposed.**
  Moved to `@gam/shared` (which already ships browser modules) with the two app
  copies as re-exports, so existing imports keep working and there is one
  implementation. It now **leaves a table alone whose author wrote their own
  `data-label`** — the tenant documents table deliberately leaves its first cell
  unlabelled because the document's name is the card's title.

---

## Waiting on Nic

1. **The PM readiness list** — `PM_READINESS_DECISIONS.md`, written last night.
   Which gaps to build and in what order. Money and priority, not code.
2. **The POS Checks tab.** He said on 10/30 "pos has nothing to do with
   screening… that shouldn't be there", but that tab was built on his own 10/21
   request, and the reasoning is quoted in `routes/pos.ts`: an applicant should
   not have to buy 22 nights to buy a background check. The emailed-link half is
   now on the screening page either way, so **what removing it costs is only the
   pay-at-the-counter button**. No money has ever gone through it —
   `screening_prepayments` is empty. **Recommendation: remove it.** It must leave
   `apps/pos` and `apps/landlord` in the same change or pos-parity fails.
3. **`apps/business` and `apps/listings` have no deploy target.** Absent from
   `deploy.sh` FRONTENDS *and* no domain, with 13 and 5 commits since their last
   builds in August. Adding them means first-time-shipping months of
   never-deployed work to new live domains. His call, not a line of config.
4. **The admin console's sign-in says `autoComplete="off"`.** Someone wrote that
   on purpose, and suppressing autofill on the login that reaches everything is
   defensible. Left as found. Turn it on like the rest, or leave it?
5. **The general ledger on a phone** — cards (as shipped) or columnar?

---

## What the next session should target

1. **Passkeys.** Decided ("a passkey replaces the emailed code; password + code
   stays the fallback") and it is his own daily friction. Not started here for one
   honest reason: the server half is testable but **the Face ID flow cannot be
   exercised from this machine**, and shipping an auth path nobody has run on a
   real device is the wrong trade at 1am. Do it when he can tap a phone.
2. **The drawer count.** Decided and specified — N registers per location, two to
   three shifts a day with their own starting amounts, float by denomination or
   as one total, company → location → register, per-location for a chain. One
   real fork remains: **how a register names itself on a device at the start of a
   shift.** Ask that, build the rest.
3. **Deleting the flat map.** Decided, and the smallest-value item left now that
   the oval and the drag lines are fixed. Sized and deliberately not started:
   **21 of the 44 card tests read the flat SVG**, covering the lean overlay, the
   map levels and the pick window — all of which survive the deletion. So the
   deletion is about a tenth of the job and re-pointing those tests at the canvas
   recorder is the rest. Safe order: extract the recorder into a shared helper,
   re-point the 21 tests against the globe (provable while the flat map still
   exists), *then* delete.
4. **POS's login has no `<form>` wrapper.** Attributes are in and Enter works via
   a key handler, but iOS password managers want a real form. Small; needs a POS
   account to exercise.

---

## Heuristics worth keeping (all written to memory)

- **A CSS transition measured in the Browser pane can sit "running" forever** —
  the pane throttles a background tab, so a drawer reads as broken when it is
  fine. Call `getAnimations().finish()` instead of waiting, toggle the class
  directly, and run it twice. This produced a phantom bug in the *landlord*
  drawer that I nearly "fixed".
- **The minifier writes backticks, not quotes.** Grepping a shipped bundle for
  `flexWrap:"nowrap"` returns zero while the build contains
  `flexWrap:` + backticks. Match with a wildcard quote, and prove the file with
  `cmp` against the local build.
- **A `{/* comment */}` beside an element that is the single child of a ternary
  is a second child.** Already in memory; walked into anyway and broke the build
  identically in both apps — which is at least the parity guard proving itself.
- **Check the calendar before reading the diff** when a deploy-only test fails.
  Third instance of that family.
- **Measure a bow against the chord's own midpoint**, never against one endpoint:
  the wrong metric reported 2.71 km for 0.04-degree segments and understated
  adm1's real worst case by 20 km.

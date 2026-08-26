# SESSION 623 HANDOFF

End of S622. 43 commits, all deployed and verified live. Supersedes
SESSION_621_HANDOFF.md.

---

## 0. START HERE — YOU CANNOT SEND MOST OF OAK PARK TOMORROW

Nic's plan is "tomorrow is the day I'm sending leases to all of Oak Park."
**He has one lease template, scoped to `apartment`, and Oak Park has one
apartment.**

```
templates:  1  (apartment)
units:      apartment 1 · rv_spot 21 · mobile_home 8
```

The drafting guard enforces unit type — a template for apartments is refused on
an RV spot ("This template is for apartment units — the selected unit is …").
So **28 of 29 units have no lease that can be sent.**

**What he must do:** upload the RV lease and the mobile-home lease as their own
templates, run auto-place on each, and save. Everything built this session then
applies to them automatically — but NONE of it has been seen against those
documents. The RV lease is known to differ in at least one way that matters: it
has a real late-fee GRACE PERIOD, where the apartment lease has none.

Do not let a green apartment template read as "Oak Park is ready".

---

## 1. WHAT THE APARTMENT TEMPLATE HAS

Saved and verified in the database (template `707af027`):

- **67 fields**
- **late-fee terms**, read from the lease's prose: grace 0, $0 initial,
  **$5.00/day** — the clause says "not received by the due date"
- **conditional fee**: Carpet cleaning $100, at move-out, clause stored verbatim
- **screening fee $35 identified and deliberately excluded** (never billed)
- the term election, correct at last review:

```
p1 x=43  radio  FIXED TERM            top level
p1 x=79  radio  May continue…         nested under FIXED TERM
p2 x=79  radio  Must vacate…          its pair, page 2
p2 x=43  radio  MONTH-TO-MONTH TERM   main option 2, page 2
```

Nic's late-fee POLICY for apartment still says grace 5. He said he would set it
to 0 to match the lease. It does not block anything either way — the lease's own
terms are stamped onto the lease at build and govern.

---

## 2. THE TEST SIGNATURE, AND HOW TO CLEAR IT

Nic is testing with a person who is NOT a tenant, on the apartment. He wants the
result gone afterwards.

```
bash scripts/teardown-test-lease.sh <document-id> --yes
```

Prints what it will remove first; does nothing without `--yes`; **refuses
outright if any payment reached Stripe or settled** — money moving proves it was
not a test. Removes the document, lease, invoice, charges, lease_fees and
tenancy, and returns the unit to vacant. Verified on four real dry-run
documents.

A completed document CANNOT be voided through the app, deliberately. This script
is for rehearsals only.

---

## 3. WHAT A FULL SIGNING RUN FOUND (and it took three attempts)

Driven end to end on production against demo landlord `james@demo.dev`, using
Nic's template. Two crashes, both of the worst kind — **the document completes,
everyone has signed, and then the lease INSERT throws:**

1. **`leases_lease_type_check`.** A radio's options are the words the LEASE
   PRINTS ("FIXED TERM"), written into a column accepting only
   `fixed_term`/`month_to_month`/`nnn_commercial`. Fixed by normalising:
   `normaliseLeaseType` cannot emit a value the column refuses.
2. **`invalid input syntax for type numeric: "N/A"`.** The signing pass REQUIRES
   every tagged money field and TELLS the landlord N/A is valid for ones that do
   not apply — then fed that string to `lease_fees.amount`. A template with pet
   fields and a tenant with no pets is all it takes. `parseMoney` now treats
   N/A in every spelling (n/a, n-a, none, nil, dash, blank, zero) as NO FEE, and
   strips currency formatting on real amounts. Rent is the deliberate exception:
   non-numeric rent is refused at drafting with a message.

The run that worked produced: lease `pending` (future start), `fixed_term`,
auto_renew true / convert_to_month_to_month, deposit $1125 + carpet $100
(conditional, chargeable **$0** until assessed), invoice $1,875.00, charges
deposit + rent. 67 template fields pruned to 37 on a one-tenant document.

**Still not proven: nobody has completed a signature through the UI.** Every
verification is API-level. Nic's test is the first pass over the editor, the
send form, the email, the signing page, and the stamped PDF.

---

## 4. THE OTHER BIG ONE — THE LATE-FEE BLOCKER

Drafting refuses when a unit type has a late-fee policy the template cannot
display. Oak Park's lease states its late fee **in prose**, with no blank, so no
field could ever be placed and **no lease could be drafted at all**.

`detectLateFeeTerms` now reads amount, cadence and grace out of the clause. The
guard accepts a template whose prose states the policy — verified by mutation on
production: remove the terms, the same draft is refused; restore them, it is
created. At build, prose terms stamp onto the lease's own late-fee columns, so
GAM charges what the parties signed rather than what the property policy says.

**Every other landlord's lease will hit this same guard.** Prose detection is
what makes it survivable.

---

## 5. THE TERM ELECTION — WHY IT TOOK ALL NIGHT

Nic: "I don't know why this is so hard." He was right every time. The lessons,
because they will recur:

- **Read the document, do not reason from the schema.** Three wrong placements
  came from deriving the control from the data model instead of from what the
  page asks a signer to do.
- Section 4 spans the page break. Detection ran PER PAGE, so every group found
  exactly ONE option and the options list came from a HARDCODED FALLBACK. The
  reported data looked right; it was fabricated.
- A continuation line ("and ending on ___") ended the option scan.
- TWO "(check one)" markers stole each other's options. **Indentation separates
  them** — x=43 outer, x=79 nested.
- Control type follows NOTHING but the fact that it is a choice: every election
  is a radio pair. The nesting is what distinguishes them.
- An option MARKER is a sibling, not a child. Counting parent links put two
  halves of one choice at different depths — Nic caught this from the ring
  colours alone.

Pinned by `autoFieldElection.test.ts` against `makeElectionLease()`, a synthetic
two-page lease sharing NONE of Oak Park's wording but all of its difficulty.
Six tests, and they were verified to FAIL when each rule is removed.

---

## 6. GENERALISING TO OTHER LANDLORDS' LEASES

Nic: "every landlord's gonna have different lease types… somebody could have a
word document with no numbers, no indentations."

The structure is PARSED, not inferred — three runs with the model disabled give
byte-identical output. That is why it reproduces, and why it should not be
replaced with a model that guesses.

Shipped this session: a **detection report** — which conventions a document
matched, which elections were laid out, and any sentence that reads like an
either/or but could not be structured, surfaced as a dismissible strip. An
unfamiliar format is now a FLAGGED gap, not a silent one. Biased toward pointing
at prose: Oak Park's lease gets exactly one false positive (the notice-delivery
sentence on page 7).

**Agreed next steps, in order:**
1. **AcroForm checkbox support** — many lawyer-drafted leases use real PDF form
   fields. Deterministic, common, cheap.
2. Recognisers for numbered-outline nesting (`4.1 / 4.1.a`).
3. Model-proposed structure ONLY where no recogniser fires, marked unconfirmed.
4. Record landlord corrections as labelled examples — the only honest basis for
   adding recognisers later.

**Do not invent recognisers for documents nobody has seen.** Nic's RV lease is
the next real data point.

---

## 7. MONEY CHANGES THIS SESSION

- **"Total due" was about to become the tenant's monthly rent.** Four page-8
  amounts all tagged `rent_amount`; the builder collapses tagged fields into one
  dict, last row wins, on a query with no ORDER BY. Now ONE owner per money
  column (first in document order — the clause, not the summary table), and the
  builder refuses conflicting duplicates.
- **Prepaid rent** maps to `last_month_rent` (a move-in fee) instead of fighting
  the rent clause.
- **Carried-forward arrears sit OUTSIDE FIFO** and are the one charge payable in
  part; the lease's own charges stay pay-in-full. The tenant screen's floor was
  separately reporting the whole ledger, so a tenant $1,000 behind could not pay
  their rent at all — `balance-context` now returns `requiredNow` and the modal
  uses it.
- **Arrears wait until every space with that landlord is current** — scoped to
  same landlord, skipping eviction-held leases, both traps tested.
- **One tenant, two units** verified as separate ledgers; `tenant_autopay` is
  unique per LEASE, so both spaces can autopay independently.

---

## 8. TERMS OF SERVICE — PUBLISHED AND LIVE

Business §9.1/§9.2 and Consumer §7.1/§7.2: applicants pay for screening once,
GAM never bills it through a lease, charging twice is a breach (also in §12
Prohibited Conduct), and a **21-day onboarding migration window** during which
existing tenants need no screening. Oak Park's window closes **2026-09-04**.

Enforced in code at SEND, with exemptions for the open window, an eviction-held
lease, `deposit_already_held`, and renewals. Four tests.

---

## 9. THINGS I BROKE AND FIXED, WORTH KNOWING

- **Undo/redo crashed the editor.** Two states updated from inside one updater;
  React double-invokes and the cursor ran past the stack, `fields` became
  undefined, and a drag took the page down. One atomic state now.
- **The confirm dialog rendered BEHIND the editor** (z-index 310 vs 1000), so
  "Replace the current fields?" was invisible and auto-place appeared dead.
  Fixed in ALL SEVEN portals.
- **Every late-fee policy claimed to be for a single family home** — the edit
  form hid the row's own unit type from its own dropdown.
- **The teardown script reported success and deleted nothing** for documents
  with no lease (empty string cast to uuid aborted the transaction, with stderr
  redirected).

---

## 10. OPEN, NOT DONE

- **RV and mobile-home templates do not exist.** (§0 — the launch blocker.)
- **`deploy.sh` does not run tests.** A red suite shipped twice this session.
- The schema snapshot tests build from goes stale after a migration and reads
  exactly like a wrong fix — `npm run db:dump-schema --prefix apps/api`.
- The property fee-schedule fallback (a fee in prose that neither the
  conditional reader nor the late-fee reader catches) is still unbuilt.
- Nobody has looked at a rendered signed PDF.
- Two sibling sub-elections (a nested choice under EACH main option) is
  reasoned-correct but has never run — no lease has that shape yet.

---

## 11. COMMANDS

```
bash deploy.sh                                     # every surface, verifies content
cd apps/api && DB_NAME=gam_test npx vitest run     # NEVER without DB_NAME
npm run db:dump-schema --prefix apps/api           # after ANY migration
bash scripts/teardown-test-lease.sh <doc-id> --yes # remove a rehearsal lease
```

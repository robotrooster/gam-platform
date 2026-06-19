# Agent Knowledge-Base Audit

> **Status:** All accuracy fixes in §A (A1 + A2) are APPLIED and **re-ingested**
> — the embeddings server was started and `ingestKnowledge.ts` re-embedded all
> 52 articles (133 chunks). Verified in `agent_knowledge_chunks`: 0 stale-phrase
> chunks remain, corrected phrasing present. The fixes are live in retrieval.
>
> **§B dedup DONE (Nic-approved safe drops):** 6 true-duplicate articles
> deleted (52 → 46) after porting each one's unique line into its keeper;
> verified no article was unit-type- or state-specific before dropping. Store
> re-ingested + orphan chunks pruned (46 sources / 122 chunks). The `DIFFERS`
> and `STAGED` sets (payment-status pair, "what is GAM" pair, screening &
> maintenance clusters) were intentionally kept. Tenant-vs-shared scope dupes
> (password, notif prefs) left untouched per Nic. The ingest runner now
> self-prunes orphaned chunks on future deletions.


Audit of the 52 seeded KB articles under
`apps/api/src/services/agents/knowledge-content/` against the real
implementation. These articles are retrieved by the CS agent, so an
inaccuracy becomes a wrong answer to a real tenant/landlord. Every
INACCURATE item below is backed by file:line evidence.

Two outcomes: **accuracy fixes** (articles that misstate product behavior)
and **dedup** (the corpus has ~13 near-duplicate articles — the "~40"
target ballooned to 52 with seed cruft).

---

## A. Accuracy fixes — by severity

### A1. Critical (wrong factual answer)

1. **Stale fee-payer model — affects 5+ articles.** Articles describe "a
   per-property setting" (the deprecated single `banking_fee_payer`). Real
   code has **three independent toggles**: `ach_fee_payer`, `card_fee_payer`,
   `platform_fee_payer` (migration `20260504040000_stripe_connect_rebuild_schema.sql:50-52`;
   consumed `services/allocation.ts:53-58`, `routes/properties.ts:582-585`).
   Consequences the current copy can't answer correctly:
   - ACH and card pass-through are set **separately** (tenant pays card, landlord eats ACH, etc.).
   - The **platform SaaS fee itself can be passed to the tenant** (`platform_fee_payer='tenant'`, `jobs/platformFeeAccrual.ts:30-37`) — no article mentions this.
   - Affects: `landlord/how-tenant-payment-fees-and-pass-through-work.md`,
     `landlord/tenant-payment-fees-and-the-pass-through-toggle.md`,
     `landlord/setting-rent-due-dates-late-fees-and-lease-fees.md`,
     `landlord/adding-properties-and-units.md`, `shared/using-the-in-app-support-assistant.md`.
   - Note: all fee **numbers** (ACH 1.0%/$6, card 3.25%, +1.5% CA) are correct everywhere. Only the toggle model is wrong.

2. **Payment status vocabulary wrong** — `tenant/checking-what-you-owe.md`
   says payments are "pending, **completed**, or failed." Real enum has no
   "completed"; cleared = **`settled`**, and it omits **`processing`** (the
   ACH state). Directly contradicts the (correct) sibling
   `payment-statuses-and-failed-payments.md`.
   Evidence: `packages/shared/src/index.ts:2322`; `apps/tenant/src/pages/PaymentsPage.tsx:36-40,127`; `routes/payments.ts:416-417`.

3. **Notification prefs (tenant) — two wrong answers** —
   `tenant/managing-your-notification-preferences.md`:
   - Claims in-app alerts can be toggled off. **In-app is always on / not toggleable** (`apps/tenant/src/main.tsx:2243`, `ProfilePage.tsx:172-176`; only Email/SMS are real checkboxes).
   - Claims a tenant "mark all as read" action. **No such control in the tenant UI** (`TenantNotificationsPage.tsx:48` marks one at a time; the read-all endpoint exists but isn't wired tenant-side).

4. **ACH setup (tenant) — two overclaims** —
   `tenant/setting-up-ach-bank-to-pay-rent.md`:
   - Describes a "**add it manually** — enter bank/account details" path. Tenant rent ACH is **Stripe Financial Connections only** (`apps/tenant/src/pages/payShared.tsx:416-441`); the manual path is the landlord *payout* account, not tenant rent.
   - "rent can be collected **automatically** each cycle." No general auto-collection engine exists — invoices post as `pending`, tenants pay manually (`jobs/scheduler.ts:1074-1077`, `jobs/invoiceGeneration.ts:287`). Auto-pull is FlexPay-only. (The tenant UI string at `main.tsx:644` repeats this overclaim — separate UI bug.)

5. **Fabricated feature — bulk unit creation** —
   `landlord/adding-properties-and-units.md` describes creating units "in
   bulk: pick a unit type, a count, and a naming prefix." No such feature —
   `AddUnitModal.tsx` is a single-unit wizard; `POST /api/units` inserts one.
   Evidence: `AddUnitModal.tsx:10,16-26,52`; `routes/units.ts:85`.

6. **Sales — On-Time Pay guarantee omitted** —
   `sales/why-landlords-choose-gam.md` and `sales/is-gam-right-for-me.md`
   describe payouts as a "regular/predictable schedule." The platform's #1
   differentiator (marketing `index.html:176,263`; CLAUDE.md) is the
   **guarantee that rent hits the landlord's bank on the 1st business day of
   every month regardless of when tenants pay**, reserve-backed ("No other
   platform offers this"). The sales chat is underselling the headline.

### A2. Medium (misroute / mismatch)

7. **Lease pointed to a "Documents section"** — `tenant/finding-and-understanding-your-lease.md`
   and `tenant/rent-due-dates-and-late-fees.md` send tenants to "Documents" to
   find their lease. The sidebar has **no Documents nav item**; the lease lives
   under the **Lease** item (`/lease`) (`apps/tenant/src/main.tsx:227-247`,
   `LeasePage.tsx:413`). A separate `/documents` page exists for signed docs
   but isn't where the lease is surfaced. `understanding-your-lease.md` gets this right.

8. **Landlord portal nav — fabricated section headers** —
   `landlord/navigating-the-landlord-portal.md` insists "these are the actual
   sections" then lists six wrong names. Real `section` values:
   `Overview, Portfolio, Financials, Operations, Screening, Admin`
   (`apps/landlord/src/components/layout/Layout.tsx:33-72`). Individual nav
   *labels* are all correct; only the groupings are invented.

9. **Tenant portal nav** — `tenant/navigating-the-tenant-portal.md` omits the
   real **"My walkthroughs"** item (`main.tsx:236`) and its "no Documents menu
   item" line conflicts with the live `/documents` DocumentsPage.

10. **Maintenance filing (tenant) — phantom step** —
    `tenant/filing-a-maintenance-request.md` says "choose your unit." The
    tenant flow auto-submits the tenant's single unit; no picker
    (`MaintenancePage.tsx:36`).

11. **Instant-payout minimum omitted** — `landlord/how-landlord-payouts-work.md`
    gives "1.5%, with a minimum" but not the coded **$0.50** floor
    (`services/connectPayouts.ts:41-42`).

12. **Inspection types** — `tenant/unit-inspections-move-in-move-out.md` says
    "three kinds"; system has four (`move_in/move_out/periodic/turnover`,
    `shared/src/index.ts:124`). `turnover` is landlord-internal, so the
    omission is defensible — soften "three kinds."

### A3. Low (cosmetic)
- `approving-or-declining-an-applicant.md`: button verb "Decline" vs stored value `denied`.
- `what-each-team-role-can-do...`: "landscaping" vs label "Landscape."
- Tenant lease nav label is singular "Lease," not "Leases."

---

## B. Dedup — recommended consolidation

The corpus has clear near-duplicate pairs/clusters. Recommended keep (→) per
the auditors:

| Duplicate set | Keep | Drop / merge in |
|---|---|---|
| paying-rent ↔ how-to-pay-rent | **how-to-pay-rent** (has the pay-flow steps) | paying-rent |
| checking-what-you-owe ↔ payment-statuses-and-failed-payments | **payment-statuses** (correct enum) | fix or merge checking-what-you-owe |
| finding-and-understanding-your-lease ↔ understanding-your-lease | **understanding-your-lease** (correct nav) | finding-and-understanding-your-lease |
| connecting-your-bank-account... ↔ connect-bank-verify-and-troubleshoot-payouts | **connect-bank-verify-and-troubleshoot-payouts** (superset) | connecting-your-bank-account... |
| getting-paid-payouts-via-stripe-connect ↔ how-landlord-payouts-work | **how-landlord-payouts-work** (more accurate) | getting-paid-payouts... |
| how-tenant-payment-fees-and-pass-through ↔ tenant-payment-fees-and-the-pass-through-toggle | **how-tenant-payment-fees-and-pass-through** | tenant-payment-fees-and-the-pass-through-toggle |
| the-platform-fee ↔ understanding-the-gam-platform-fee | **the-platform-fee** (incl. Connect fee) | understanding-the-gam-platform-fee (pull in worked example) |
| what-is-gam-and-how-to-reach-a-human ↔ ...-reach-support | **...-reach-support** (richer) | ...-reach-a-human |
| shared/resetting-your-password + shared/keeping-your-account-secure ↔ tenant/resetting-your-password-and-keeping-your-account-secure | **the two granular shared** | tenant combined |
| shared/managing-notification-preferences ↔ tenant/managing-your-notification-preferences | **shared** | tenant (also the buggy one — see A3) |
| screening cluster (reviewing / ordering / approving) | keep **ordering** + **approving** | merge **reviewing** into ordering |
| maintenance cluster (receiving-and-triaging / managing-...-threshold / assigning-tracking-cost) | keep **receiving-and-triaging** + **assigning-tracking-cost** | drop **managing-...-approval-threshold** (redundant) |

Pruning the above takes 52 → ~38 articles, matching the original ~40 intent.

---

## C. Suggested fix order
1. A1 fee-payer model (5 articles) — highest blast radius.
2. A1 #2–#5 single-article factual bugs (status vocab, notif prefs, ACH setup, bulk units).
3. A1 #6 sales guarantee — quick, high sales value.
4. A2 nav/misroute fixes.
5. B dedup pass (deletions need sign-off).

Accuracy edits (A) are unambiguous code-vs-copy corrections. Dedup deletions
(B) and any positioning/tone calls need a product decision.

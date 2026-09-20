# Country Acres (Mattoon) — the load, and what it did not do

Ran once, 2026-09-20, against production. Source: `Illinois Trip.xlsx`, sheet
"Mattoon Lot Inspection Log" — Blu Haws' own walk of the park at
10055 US-45, Mattoon IL. `lots.json` is that sheet, parsed; everything else
derives from it.

Blu Haws (TruBlu Management LLC) is the sole owner. The "Jeff" contact on the
Park Info sheet is the seller, from before closing.

    load1_units.ts    the lots
    load2_people.ts   the households
    load3_leases.ts   lease documents, drafted for Blu's signature
    load4_rto.ts      installment sale contracts, bundled with each lease
    load5_water.ts    submeters and Blu's two reads

Each takes `DRY=1` to print its plan and write nothing. They are idempotent by
inspection — every one skips what already exists — but they were written to run
once and are kept as the record of what was loaded, not as a tool to re-run
casually.

## What was deliberately NOT done

**No tenant was emailed, and none can be yet.** Nic: "don't let anything go to
any tenants yet." Accounts were created with no invite token. Document drafting
sends nothing at all, and the landlord is signer 1 on every document, so no
tenant is reachable until Blu has signed.

**No money figure was invented.** The sheet records what is LEFT on each
installment contract ($11,000 over 55 months), never the original sale price or
the down payment, so those fields are blank for Blu to fill from the originals.

**Curtis Clabough is deliberately NOT on a work-trade agreement.** Nic, after
seeing the sheet had no hours: "let's just leave him not on a work trade
agreement for now... I think the guy is only going to get a partial coverage of
the rent for some work. So Blu can just apply a credit as needed." Lot 6 carries
a note saying so; it moves to a real agreement when Blu decides the hours.

**The installment contracts were drafted and then voided.** They are the reason
to read the next section.

## The RTO billing order — found by checking, and it matters

A signed purchase agreement calls `activateHomeSaleContract(documentId)`, which
looks for a `home_sale_contracts` row on that document. Drafting the agreement
on its own creates no such row, and `createHomeSaleContract` cannot be called
yet either: it requires the tenant's space-rent LEASE as its billing anchor, and
no lease row exists until Blu signs.

So an agreement drafted at the same time as the lease would have been signed by
everybody and billed **nothing** — `activateHomeSaleContract` returns
`{activated: false}` and says nothing at all. The eleven drafted here are voided
for that reason.

The order that works, which `POST /home-sale` already does in one step:

    lease signed  →  home-sale contract created (anchored to the lease)
                  →  purchase agreement drafted against that contract
                  →  agreement signed  →  installments written and billed

**This constrains the signing bundle.** Nic's intent is one packet — lease and
installment contract out together, two separate documents and two separate
signatures. That works for a tenant who already has a lease. It cannot work on a
brand-new tenancy, because the contract has nothing to anchor to until the lease
exists. Worth a decision: either the bundle sends in two passes for new
tenancies, or `home_sale_contracts.lease_id` (already nullable in the database,
though not in the TypeScript input) gets filled in when the lease completes.

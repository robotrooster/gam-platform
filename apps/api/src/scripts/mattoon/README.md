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

**Curtis Clabough is on a work-trade agreement from 1 October** — hours tracked
monthly, three months of carry-forward, covering rent. Nic: "he is going to be
on work trade with hours billed monthly... I don't know the exact hour terms
yet, but let's do a three month cycle of carry forward while they figure out how
many hours." The carry-forward is the point: some months are busier than others
at this park. **The 20 hrs/mo target is a placeholder** — the schema requires a
positive number and this one was not on the sheet. Nothing settles until Blu
signs the lease, so it is safe to correct, but it must be corrected.

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

**Fixed, rather than worked around.** The lease requirement was the bug. Nic:
"we can't do the contract sales tied to a lease... I know a guy that owns over a
hundred homes throughout various parks without actually owning any parks. He's
not going to have a lease. The ownership of the trailer has nothing to do with
who's actually living in the trailer." One tenant can sell their home to
another, who subleases it on.

`leaseId` is optional now, on the service and the route. The guard the lease
check was doing by accident — tenantId becomes the billed obligor, so it can
never be an arbitrary id from the body — is kept explicitly: the buyer must have
a lease of any status, an open invite, or a utility agreement with this
landlord. A buyer who rents nowhere still reaches GAM through the seller's
invite; a stranger's id does not.

The bundle binds nothing. `package_group_id` groups documents for SENDING, so
one packet goes out and both get signed in one sitting. It is a workflow
convenience and no part of the back end treats the two as one thing.

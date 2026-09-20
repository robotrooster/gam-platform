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

**Curtis Clabough's work trade was not created.** Nic asked for it, but the
sheet gives no hours and `work_trade_agreements.monthly_hours_target` is
`NOT NULL CHECK (> 0)`. Hours are never derived from a dollar amount
(`gam-work-trade-is-hours-not-wages`), so the lot carries a note instead and it
needs one number from Nic.

**Lot 1 was skipped entirely.** Its mailbox, the5ways2005@yahoo.com, already
belongs to a GAM account — Nancy Sheptock, role `landlord`, created the day the
property was set up, never logged in, owning nothing. Almost certainly a
mis-click during setup, but changing somebody's account role unattended is not
a call to make at 4am.

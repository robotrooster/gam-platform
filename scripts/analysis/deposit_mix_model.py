#!/usr/bin/env python3
"""
Deposit-pool MIX model (S604) — Nic's question:

  "if you take all the mobile homes in America versus all the total units in
   America, what's the percentage there? ... assuming we onboard properties
   semi-parallel with the average unit mix that actually exists nationally,
   and factoring that mobile homes are lower income so deposits are smaller."

Two separate weightings, and the difference is the whole point:
  - share of UNITS   (how many doors)
  - share of DOLLARS (how much deposit principal) <- what actually earns/owes

CAUTION: the national shares below are approximate figures from memory
(knowledge cutoff May 2026) and should be checked against current ACS / Census
data before anything depends on them. They are parameters, not findings — the
STRUCTURE of the result is robust to moving them several points.
"""

# rental_share = share of US RENTER-occupied units (not all housing stock:
# most manufactured homes are owner-occupied even when the lot is rented).
# deposit = typical deposit dollars per unit (Nic: Oak Park MH = $350).
SEGMENTS = [
    # name,             share of rental units, typical deposit
    ("apartment",                    0.55,     1_500),
    ("single_family",                0.33,     1_800),
    ("mobile_home (lot)",            0.04,       350),
    ("other (rv, etc.)",             0.08,       400),
]

print("=" * 76)
print("NATIONAL RENTAL MIX — units vs deposit DOLLARS")
print("=" * 76)

total_units_share = sum(s for _, s, _ in SEGMENTS)
dollar_weights = [(n, sh, dep, sh * dep) for n, sh, dep in SEGMENTS]
total_dollars = sum(w for _, _, _, w in dollar_weights)

print(f"{'segment':<22}{'unit share':>12}{'deposit':>10}{'$ share':>12}")
print("-" * 76)
for n, sh, dep, w in dollar_weights:
    print(f"{n:<22}{sh/total_units_share:>11.1%}{dep:>10,}{w/total_dollars:>12.1%}")

mh_units = next(sh for n, sh, _, _ in dollar_weights if n.startswith("mobile"))
mh_dollars = next(w for n, _, _, w in dollar_weights if n.startswith("mobile"))
print(f"\n  mobile home: {mh_units/total_units_share:.1%} of UNITS "
      f"-> {mh_dollars/total_dollars:.1%} of DOLLARS "
      f"({(mh_units/total_units_share)/(mh_dollars/total_dollars):.1f}x dilution "
      f"from the smaller deposit)")

# ── Now: only mobile homes IN FIXED-RATE STATES are exposed ──────────────
# AZ is one state. Fixed-rate mandates above market are the only negative case.
AZ_SHARE_OF_US_MH = 0.05     # AZ is MH-heavy (climate/retirees); ~5% of US MH
OWED, EARNED = 0.05, 0.03    # AZ mobile home statute vs net yield
NO_REQ_KEEP = 0.03           # everything else keeps the full earned rate

exposed_dollar_share = (mh_dollars / total_dollars) * AZ_SHARE_OF_US_MH

print("\n" + "=" * 76)
print("BLENDED SPREAD ON A NATIONALLY-REPRESENTATIVE POOL")
print("=" * 76)
print(f"  AZ mobile-home share of pool DOLLARS : {exposed_dollar_share:.3%}")

drag = exposed_dollar_share * (OWED - EARNED)
gain = (1 - exposed_dollar_share) * EARNED
print(f"  drag from the 5% mandate             : {-drag:.4%} of pool")
print(f"  earned on everything else            : {gain:.4%} of pool")
print(f"  NET blended                          : {gain - drag:.4%} of pool")
print(f"\n  vs. a pool that is 100% AZ mobile home: {EARNED - (OWED-EARNED)*1:.4%}")

for p in (100_000, 1_000_000, 10_000_000):
    print(f"    pool ${p:>12,}  ->  net ${p*(gain-drag):>12,.0f}/yr"
          f"   (drag ${-p*drag:>10,.0f})")

print("\n  NOTE: this is the STEADY-STATE mix. Early on the portfolio is NOT")
print("  nationally representative — Oak Park alone is 100% AZ mobile home,")
print("  which is the worst-case cell. Dilution is a scale argument.")

#!/usr/bin/env python3
"""
GAM deposit-custody duration model, v2 (S604).

v1 used a $70k pool as a generic illustration and mislabeled it "Oak Park".
This version takes UNIT COUNT x DEPOSIT SIZE so the pool is computed from real
inputs, and reports the break-even scale instead of a single number.

Everything is dollar-weighted, not unit-weighted: deposits differ per unit, and
what earns yield is dollars.
"""

# ── Yield curve: annualized, NET of the custodian's cut ───────────────────
SHORT_Y = 0.0350     # 4-13 week bills, rolled
LONG_Y  = 0.0390     # 52-week bill      (set == SHORT_Y for a flat curve,
                     #                    below SHORT_Y for an inverted one)

# ── Pool composition, by DOLLARS ─────────────────────────────────────────
SHARE_LONG = 0.70    # deposit dollars sitting under 12-month leases
BUFFER     = 0.05    # kept short for unpredicted exits

LONG_SLEEVE = max(0.0, SHARE_LONG - BUFFER)
EDGE = LONG_SLEEVE * (LONG_Y - SHORT_Y)   # advantage as a % of pool


def pool(units, avg_deposit):
    return units * avg_deposit


print("=" * 78)
print("DURATION-LADDER ADVANTAGE — computed from unit count x deposit size")
print(f"  curve: short {SHORT_Y:.2%} / 52wk {LONG_Y:.2%}"
      f"   (term premium {LONG_Y-SHORT_Y:+.2%})")
print(f"  {SHARE_LONG:.0%} of POOL DOLLARS long-lease, {BUFFER:.0%} buffer"
      f"  ->  {LONG_SLEEVE:.0%} can hold 52wk paper")
print(f"  advantage = {EDGE:.4%} of pool per year")
print("=" * 78)

SCENARIOS = [
    ("8 mobile homes",            8,     500),
    ("8 mobile homes",            8,   1_000),
    ("8 mobile homes @ 2mo cap",  8,   1_600),
    ("50 units",                 50,     800),
    ("250 units",               250,     800),
    ("1,000 units",           1_000,     800),
    ("5,000 units",           5_000,     800),
    ("25,000 units",         25_000,     800),
]

print(f"\n{'scenario':<26}{'units':>8}{'deposit':>10}{'pool':>14}{'gain/yr':>12}")
print("-" * 78)
for label, units, dep in SCENARIOS:
    p = pool(units, dep)
    print(f"{label:<26}{units:>8,}{dep:>10,}{p:>14,}{p*EDGE:>12,.0f}")

# ── Break-even scale ─────────────────────────────────────────────────────
print("\n" + "=" * 78)
print("BREAK-EVEN — pool needed for the ladder to clear a given annual benefit")
print("=" * 78)
for target in (1_000, 5_000, 25_000, 100_000):
    need = target / EDGE if EDGE > 0 else float("inf")
    print(f"  to earn ${target:>7,}/yr  ->  pool of ${need:>14,.0f}"
          f"   ({need/800:>9,.0f} units @ $800)")

# ── What the same pool loses to a statutory shortfall ────────────────────
print("\n" + "=" * 78)
print("SAME POOL, STATUTORY SHORTFALL (AZ mobile home 5% owed vs 3% net earned)")
print("=" * 78)
SHORTFALL = 0.05 - 0.03
print(f"{'scenario':<26}{'pool':>14}{'ladder gain':>14}{'shortfall':>14}")
print("-" * 78)
for label, units, dep in SCENARIOS[:4]:
    p = pool(units, dep)
    print(f"{label:<26}{p:>14,}{p*EDGE:>14,.0f}{-p*SHORTFALL:>14,.0f}")
print(f"\n  shortfall is {SHORTFALL/EDGE:.1f}x the ladder gain, at every scale")

#!/usr/bin/env python3
"""
S604: per-(state, act) deposit-law extractor.

Pulls the sentences that bear on the two questions GAM needs answered for every
state AND every tenancy act within it (Arizona alone has four):

  1. INTEREST  — is any interest owed to the tenant, on what basis?
  2. CUSTODY   — must the money sit in a particular kind of account?

Prints matched sentences so they can be READ. This is a reading aid, not a
classifier — every prior attempt to shortcut this with keyword matching produced
wrong answers in both directions (IA/KS looked like interest states and are not;
OK/WA looked silent and require in-state escrow).

Usage:
  python3 deposit_law_extract.py TX            # one state, all its acts
  python3 deposit_law_extract.py TX IN MN      # several
  python3 deposit_law_extract.py --absent      # states with no custody row yet
"""
import re
import subprocess
import sys

PSQL = ['psql', 'gam', '-t', '-A', '-F', '\x1f', '-c']

INTEREST_RE = re.compile(
    r'\b(interest|earnings|accru\w+)\b', re.I)
CUSTODY_RE = re.compile(
    r'(trust account|escrow|separate account|segregat\w+|commingl\w+|'
    r'federally[- ]insured|insured by|financial institution|banking institution|'
    r'savings and loan|credit union|hypothecat\w+|surety bond|bond from|'
    r'in this state|located in|maintained in)', re.I)
# "interest in the premises/property" is an OWNERSHIP interest, not money.
FALSE_INTEREST = re.compile(
    r'interest\s+(in|of)\s+(the\s+)?(premises|property|land|leased|real|'
    r'landlord|dwelling|park|successor)', re.I)


def q(sql):
    out = subprocess.run(PSQL + [sql], capture_output=True, text=True)
    if out.returncode != 0:
        print(out.stderr[:400]); sys.exit(1)
    return [l.split('\x1f') for l in out.stdout.strip().split('\n') if l.strip()]


def sentences(text):
    text = re.sub(r'\s+', ' ', text)
    # Split on sentence enders, keeping statutory "(a)" markers attached.
    return [s.strip() for s in re.split(r'(?<=[.;])\s+(?=[A-Z(])', text) if s.strip()]


def report(state):
    rows = q(f"""
      SELECT act_key, section_number, COALESCE(section_title,''),
             regexp_replace(full_text, E'[\\n\\r\\t]+', ' ', 'g')
        FROM state_law_section_texts
       WHERE state_code = '{state}'
         AND act_key NOT IN ('property_tax','property_tax_code','rpt','broker_licensing',
             'real_estate_license','real_estate_appraiser_license','conveyancing_title',
             'mortgage_lien_foreclosure','mortgages','mortgage','eminent_domain')
         AND full_text ~* 'security deposit|rental deposit|damage deposit'
       ORDER BY act_key, section_number""")
    print(f"\n{'='*78}\n{state} — {len(rows)} deposit-bearing sections\n{'='*78}")
    for act, num, title, text in rows:
        hits_i, hits_c = [], []
        for s in sentences(text):
            if 'deposit' not in s.lower() and not CUSTODY_RE.search(s):
                continue
            if INTEREST_RE.search(s) and not FALSE_INTEREST.search(s):
                hits_i.append(s)
            if CUSTODY_RE.search(s):
                hits_c.append(s)
        if not hits_i and not hits_c:
            continue
        print(f"\n── {act} § {num} — {title[:70]}")
        for s in hits_i[:4]:
            print(f"   [INT] {s[:400]}")
        for s in hits_c[:4]:
            print(f"   [CUS] {s[:400]}")


if __name__ == '__main__':
    args = sys.argv[1:]
    if args and args[0] == '--absent':
        have = {r[0] for r in q("SELECT state_code FROM state_deposit_custody_rules")}
        allst = [r[0] for r in q(
            "SELECT DISTINCT state_code FROM state_law_section_texts ORDER BY 1")]
        args = [s for s in allst if s not in have]
        print(f"States with no custody row: {' '.join(args)}")
    for st in args:
        report(st)

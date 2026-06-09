# Session 417 — closed

## Theme

**Eighth validation-hygiene micro-session. S411
disposable-email block extracted to a shared lib and
fanned out across all email-accepting routes.**

Suite at S416 close: **1928 / 107 files**.
Suite at S417 close: **1947 / 109 files** (+19 cases,
+2 files — disposable-email test slice + the lib
helper file). 0 failures. Runtime **61.72s**.
Twenty-first consecutive fully-green full-suite run.

Zero tsc regressions.

## What shipped

### New shared helper: `apps/api/src/lib/email.ts`

Extracted the inline implementation from S411
tenants.ts:

```ts
export const DISPOSABLE_EMAIL_DOMAINS = new Set<string>([
  'mailinator.com', 'guerrillamail.com', 'guerrillamail.net',
  'sharklasers.com', '10minutemail.com', 'tempmail.com',
  'temp-mail.org', 'throwawaymail.com', 'trashmail.com',
  'yopmail.com', 'maildrop.cc', 'getnada.com',
  'dispostable.com', 'fakeinbox.com', 'mintemail.com',
])

export function isDisposableEmail(email: string): boolean {
  const at = email.lastIndexOf('@')
  if (at < 0) return false
  const domain = email.slice(at + 1).toLowerCase().trim()
  return DISPOSABLE_EMAIL_DOMAINS.has(domain)
}
```

Same 15-entry curated list as S411. No npm dependency
added (the rationale from S411 still holds — list
maintenance cost < dependency footprint for launch).

### Fan-out: 6 new disposable-domain gates

| Route | Surface | Pre-fix risk |
|---|---|---|
| `POST /api/auth/register` | Main self-serve signup | Mailinator landlord/tenant accounts |
| `POST /api/auth/register-prospect` | Public listings-page signup | Same, public-facing |
| `POST /api/tenants/invite` | Landlord-invites-tenant | Invite token delivered to a throwaway address (defeats verification gate) |
| `POST /api/books/contractors` | AP / 1099 issuance | Throwaway address on a tax-form contact |
| `POST /api/books/vendors` | AP / 1099 issuance | Same |
| `POST /api/books/employees` | Payroll / W-2 | W-2 delivery to a throwaway |

Plus the existing `PATCH /api/tenants/profile` from
S411 was migrated to import from the new lib (inline
implementation deleted).

All seven routes now share the same Set + check
function. Future curated additions to the block list
land in one file.

## Items shipped

### New files

```
apps/api/src/
  lib/email.ts                         (NEW — shared helper)
  routes/s417-disposable-email.test.ts (NEW — 12 cases)
```

### Route changes

```
apps/api/src/routes/
  tenants.ts          (migrate /profile to lib import +
                       add /invite disposable gate)
  books.ts            (add /contractors + /vendors +
                       /employees disposable gates)
  auth.ts             (add /register + /register-prospect
                       disposable gates)
```

### Test coverage — 12 cases

- **6 helper unit tests**: mailinator blocked,
  case-insensitivity, trim tolerance, gmail.com
  allowed, malformed input returns false, block list
  sanity (size ≥ 10).
- **6 route integration tests**: one per new gate.
  Each sends a disposable-domain email at the full
  required payload and asserts 400 + shared error
  message.

## Decisions made during build

| Question | Decision |
|---|---|
| Extract to a lib helper or copy-paste? | **Lib helper.** Three or more callers crosses the threshold from "premature abstraction" to "single source of truth." Adding a domain to the block list should be a 1-file PR, not a 6-file PR. |
| Add the block list to the npm dependency? | **No.** Same reasoning as S411 — 15-entry Set < npm `disposable-email-domains` package weight. Worth swapping when domain drift becomes a maintenance pain. |
| Apply the gate BEFORE or AFTER the existing uniqueness check on /register? | **Before.** Cheap check (no DB hit); rejecting mailinator earlier means we don't bother querying users table for a request we'd reject anyway. |
| Apply the gate to PATCH routes that update email? | **Already done in S411** for tenant /profile. The other PATCH-email routes (landlord profile, employee, vendor, contractor) don't accept email updates today — they're PATCH-but-not-PATCH-email. If a future PATCH adds email mutation, the same gate has to be added. Flag for the validation-hygiene backlog. |
| Test happy paths (legit gmail) on all 6 routes? | **No.** Happy paths are covered by each route's existing slice tests. S417 specifically pins the disposable rejection — the gate's job. |
| Include `proton.me`, `protonmail.com` in the block list? | **No.** Those are legit privacy-focused mail providers, not throwaways. The block list targets clear disposable services (30-day max retention or shorter, no real account, public mailboxes). |

## Verification

- `npx tsc --noEmit` clean on apps/api (0 errors).
- `npm test` in apps/api: **1947 tests across 109
  files, 0 failures**, 61.72s. **Twenty-first
  consecutive fully-green full-suite run.**
- 12 new test cases.
- 0 production regressions.

## Items deferred — what S418 could target

### Validation-hygiene backlog (was 18, now 17)

Shipped in S417: S411 disposable-domain fan-out.

Remaining:
- S413 spawned: vendor credit_balance CONSUMPTION on
  subsequent bills (the matching half of S386)
- S412 spawned: confirm entity-type-conditional
  EIN/SSN call (Nic-pending)
- S416 spawned: confirm vendor accountNumber/notes
  relaxation (Nic-pending)
- **S417 spawned**: apply disposable gate to PATCH-
  email routes if/when they're added (landlord
  profile, employee, vendor, contractor currently
  don't accept email updates)
- S400 LEASE_TYPE_MATRIX ↔ CHECK drift
- S403 cross-landlord PI capture/cancel
- S405 bank_last4 null + ach_verified=TRUE defensive
- S405 /complete missing isExpired check
- S408 finding A (monthly-statement off-by-one
  default — Nic-pending)
- S408 finding B ($15 hardcoded fee — Nic-pending)
- S377 (a) email-blocked

### Cumulative bug-sweep totals (post-S417)

- **44 production bug fixes** (S417 is hardening
  the data-quality posture across the email-entry
  surface)
- 17 architectural / validation findings remaining
- 1947 tests across 109 files
- Suite baseline: **60-62s on a clean machine**

## What S418 should target

**Recommended: S405 defensive bundle** — two small
no-product-input items shipped in one slice:
1. `posCustomerOnboarding /complete` add `isExpired`
   check (was: in-flight flow could complete after
   expiry)
2. `posCustomerOnboarding /complete` refuse to set
   `ach_verified=TRUE` when `bank_last4` is null
   (defensive — current code flips the flag even
   when the bank info couldn't be extracted)

Both are small contained fixes; the existing
posCustomerOnboarding.test.ts already pins the
current (deliberate-or-bug) behavior so flipping
the tests + adding the fix is one clean session.

**Alternatives:**
- S413 follow-on: vendor credit_balance CONSUMPTION
  (needs UX design)
- S403 cross-landlord PI capture/cancel (Stripe
  round-trip required)
- Checkr wire-up (background.ts) — all locked S398
  decisions now closed except S377(a) which is
  email-blocked
- Services audit start (~30 sessions)

---

End of S417 handoff. **Shared lib/email helper +
6 new disposable-domain gates across all email-
accepting routes. 12 new test cases.**

1947 tests / 109 files / 0 failures. Twenty-first
consecutive fully-green full-suite run.

**44 cumulative production bug fixes shipped across the
bug sweep.** Validation-hygiene backlog reduced from
18 to 17.

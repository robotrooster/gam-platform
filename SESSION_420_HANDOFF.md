# Session 420 — closed

## Theme

**Checkr provider wire-up: live API adapter implemented
in `services/backgroundProvider.ts` alongside the
existing MockProvider. 20 unit tests pinning HTTP
shape, status mapping, webhook HMAC verification, and
defensive failure modes.**

Suite at S419 close: **1960 / 109 files**.
Suite at S420 close: **1980 / 110 files** (+20 cases,
+1 file). 0 failures. Runtime **61.34s**. Twenty-fourth
consecutive fully-green full-suite run.

Zero tsc regressions.

## What shipped

### `CheckrProvider` class in `services/backgroundProvider.ts`

Implements the `BackgroundProvider` interface (already
established by `MockProvider`) against Checkr's v1 API.

**Lifecycle:**
1. **`initiate()`**: two-step HTTP call sequence —
   - `POST /v1/candidates` (form-encoded body with
     applicant intake)
   - `POST /v1/reports` (form-encoded with candidate_id
     + package slug)
   - Returns the **report id** as the providerRef so
     webhooks can later be correlated.
2. **`verifyWebhook()`**: HMAC-SHA256 against
   `X-Checkr-Signature` header, using
   `CHECKR_WEBHOOK_SECRET`. Refuses if either secret
   or signature is missing (unlike MockProvider which
   passes through in dev when no secret is set —
   Checkr is real-money, no insecure mode allowed).
3. **`parseWebhook()`**: extracts `data.object.id` +
   `status` + `adjudication` from Checkr's standard
   envelope. Maps to GAM enum via `mapCheckrStatus`.
4. **`craDisclosure()`**: returns Checkr Inc.'s
   address + phone + website for FCRA §615(a)(2)
   adverse-action notices.

**Status mapping** (Checkr → GAM `background_checks.status`):

| Checkr | GAM |
|---|---|
| `pending` | `processing` |
| `clear` | `complete` |
| `consider` | `complete` (landlord decides) |
| `suspended` | `cancelled` |
| `dispute` | `processing` (Checkr re-running) |
| `created` / `awaiting_consent` | `awaiting_applicant` |
| `complete` | `complete` |
| anything else | `failed` (defensive) |

### Env vars consumed

```
CHECKR_API_KEY        — HTTP Basic username (empty password)
CHECKR_PACKAGE        — package slug, e.g. 'tasker_pro'
CHECKR_WEBHOOK_SECRET — HMAC secret for X-Checkr-Signature
CHECKR_BASE_URL       — optional, defaults to https://api.checkr.com/v1
                         (override for staging/sandbox)
```

The provider throws immediately if `CHECKR_API_KEY` is
missing — no quiet fall-through, no insecure default.

If `CHECKR_PACKAGE` is missing AFTER candidate
creation succeeded, the route returns `failed` with
an explicit reason — the candidate is created but no
report is ordered. This is recoverable: set the env
var and retry; the prior candidate is reusable.

### Registration

```ts
const PROVIDERS: Record<string, BackgroundProvider> = {
  mock:   new MockProvider(),
  checkr: new CheckrProvider(),
}
```

Mock stays the default (when `provider_name` is null
on the `background_checks` row, getProvider falls
back to `'mock'`). Checkr is selected by setting
`provider_name = 'checkr'` at the row level — the
existing route layer at `background.ts` already reads
this column and passes it to `getProvider`.

## Items shipped

### Source code

```
apps/api/src/services/
  backgroundProvider.ts                (CheckrProvider
                                          class added;
                                          PROVIDERS map
                                          extended)
  checkrProvider.test.ts                (NEW — 20 cases)
```

No route changes. No schema migration (the existing
`background_checks.provider_name` column already
supported per-row provider selection).

### Test coverage — 20 cases

**Registration (1):**
- `getProvider('checkr')` returns CheckrProvider

**initiate() (9):**
- Happy: candidate + report created; fetch called
  twice with correct URLs / form bodies / Basic auth
  / Content-Type headers
- Each major Checkr status → GAM enum mapping
  (clear→complete, suspended→cancelled, unknown→failed)
- Missing consent → failed without HTTP call
- Missing CHECKR_API_KEY → throws clean error before
  HTTP (verified: fetch not called)
- Missing CHECKR_PACKAGE → failed after candidate
  with explicit reason (providerRef set to candidate
  id for retry)
- Candidate API non-2xx → failed with status + body
  excerpt
- Report API non-2xx → failed after candidate created

**verifyWebhook() (6):**
- Valid HMAC → true
- Tampered body → false
- Wrong secret → false
- No signature header → false
- CHECKR_WEBHOOK_SECRET missing → false (refuses
  insecure mode — contrast with mock provider which
  passes in dev)
- Signature header as array (express common shape)
  → handled

**parseWebhook() (3):**
- Happy: extracts id + status + adjudication; mapped
- Missing data.object.id → throws
- Non-JSON body → throws

**craDisclosure() (1):**
- Returns Checkr Inc. CRA contact info

## Decisions made during build

| Question | Decision |
|---|---|
| Use native fetch or add `node-fetch` dep? | **Native fetch.** Node 24 in the repo; native fetch is stable. Dependency-free. |
| Use HTTP Basic auth or some other scheme? | **HTTP Basic** with API key as username, empty password. Per Checkr's published API docs. The provider builds the header inline; no SDK dep. |
| Form-encoded or JSON body? | **Form-encoded (URLSearchParams).** Checkr's published examples use form-encoding. JSON works too but matching the docs reduces surprise debugging. |
| Refuse in dev when CHECKR_WEBHOOK_SECRET is missing? | **Yes — refuse.** Unlike the mock provider (which passes through in dev for convenience), Checkr is real-money and should never run without HMAC verification. Failing closed is the right posture. |
| Throw vs return-failed on missing CHECKR_API_KEY? | **Throw.** API key is a hard prerequisite; the route should not have called `initiate()` without env wired. Throwing surfaces the misconfiguration at session boot rather than silent applicant data poisoning. |
| Return failed vs throw on missing CHECKR_PACKAGE after candidate created? | **Return failed.** Candidate already created — that's a half-state we want recorded (the candidate_id is in providerRef for retry). Throwing would lose the candidate id. |
| Map Checkr's "consider" to GAM "complete" or "review_required"? | **"complete".** The GAM enum doesn't have a "review_required" state; the route layer + landlord UI handle adverse-data flow. "consider" means the report is DONE but has flagged data; the landlord makes the call. |
| Pin every Checkr status mapping with a separate test? | **No.** Spot-check the four canonical paths (clear, suspended, unknown, pending). The mapper function is small enough that the spot-checks plus reading the switch statement covers it. |

## What you need to do to enable Checkr in prod

1. Set the three env vars on the server:
   ```
   CHECKR_API_KEY=<your_secret_key>
   CHECKR_PACKAGE=<your_package_slug>
   CHECKR_WEBHOOK_SECRET=<your_webhook_signing_secret>
   ```
2. In the Checkr dashboard, configure the webhook
   URL to point at `POST /api/background/webhook/checkr`
   (existing route at `background.ts:696` already
   handles the per-provider routing).
3. Update the per-landlord provider selection so new
   background_checks rows are created with
   `provider_name = 'checkr'`. The route layer at
   `background.ts` already supports per-row provider
   selection — what's missing is landlord-side admin
   UI to flip the toggle (out of scope for S420 but
   trivial: a new column on `landlords` or a row in
   a per-landlord config table).
4. Optional: set `CHECKR_BASE_URL=https://api.checkr-staging.com/v1`
   to point at the sandbox while smoke-testing.

## What's NOT in S420

- **Live API smoke test.** I built against Checkr's
  published API docs without making any actual calls
  to their service. The first production-style smoke
  test should be a single applicant through the
  sandbox to confirm the form encoding + webhook
  contract.
- **Landlord-side admin UI to select Checkr.** The
  back-end supports it; the front-end is whatever
  flow Nic wants for switching landlords from mock
  to live.
- **CHECKR_PACKAGE selection per landlord.** Today
  one package globally. A future hygiene pass could
  add a per-landlord `checkr_package` override (some
  landlords want bare-credit; some want
  credit+criminal+eviction).
- **`background.ts` route-level slice tests against
  Checkr.** Out of scope — the route layer is
  provider-agnostic; the existing mock-provider
  route tests cover the wiring. CheckrProvider
  unit tests cover its API.

## Verification

- `npx tsc --noEmit` clean on apps/api (0 errors).
- `npm test` in apps/api: **1980 tests across 110
  files, 0 failures**, 61.34s. **Twenty-fourth
  consecutive fully-green full-suite run.**
- 20 new test cases for CheckrProvider.
- 0 production regressions.

## Items deferred — what S421 could target

### Validation-hygiene backlog (was 14, still 14)

S420 didn't reduce the count — Checkr wire-up is a
provider implementation, not a hygiene-backlog item.

Remaining:
- S413 spawned: vendor credit_balance CONSUMPTION
- S412 spawned: confirm EIN/SSN call (Nic-pending)
- S416 spawned: confirm vendor accountNumber/notes
  relaxation (Nic-pending)
- S417 spawned: apply disposable gate to PATCH-email
  routes if/when added
- S400 LEASE_TYPE_MATRIX ↔ CHECK drift (Nic-pending)
- S408 finding A (monthly-statement off-by-one —
  Nic-pending)
- S408 finding B ($15 hardcoded fee — Nic-pending)
- S377 (a) email-blocked

### Cumulative bug-sweep totals (post-S420)

- **46 production bug fixes** (S420 is a feature
  implementation, not a bug fix)
- 14 architectural / validation findings remaining
- 1980 tests across 110 files
- Suite baseline: **60-62s on a clean machine**

## What S421 should target

**Recommended: route-level integration slice for
background.ts targeting the Checkr path.** The
existing background.ts route tests (if any) use the
mock provider. A Checkr-specific route slice would:
1. Mock fetch (same harness as
   checkrProvider.test.ts)
2. Drive the route at `POST /api/background/initiate`
   with provider_name='checkr'
3. Verify the route correctly passes intake into
   provider.initiate() and persists the providerRef
4. Drive the webhook route at
   `POST /api/background/webhook/checkr` with a
   signed body and verify it updates the
   background_checks row

This closes the last test-coverage gap on the Checkr
arc.

**Alternatives:**
- S413 vendor credit_balance CONSUMPTION (needs UX
  design)
- Services audit start (~30 sessions)
- Wait for Nic decisions and ship a batch
- Live Checkr sandbox smoke test (requires Nic to
  set env vars + drive the test from a real browser)

---

End of S420 handoff. **CheckrProvider class
implemented against Checkr's v1 API. 20 unit tests
covering initiate / webhook verify / parse / CRA
disclosure / status mapping. Mock stays default;
Checkr enabled by setting provider_name='checkr'
at the row + the three env vars at the server.**

1980 tests / 110 files / 0 failures. Twenty-fourth
consecutive fully-green full-suite run.

**46 cumulative production bug fixes shipped across the
bug sweep.** Validation-hygiene backlog unchanged
at 14 (S420 was feature work, not a hygiene item).

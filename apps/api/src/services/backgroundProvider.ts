import crypto from 'crypto'
import { BackgroundCheckStatus } from '@gam/shared'

// ── BACKGROUND CHECK PROVIDER ABSTRACTION ─────────────────────
//
// GAM owns the applicant intake (form, SSN/DOB/address/employment, ID images,
// risk-score triage, application pool). The actual credit/criminal screening
// is delegated to a regulated third party (TransUnion SmartMove, RentPrep,
// SafeRent, etc.). This module is the seam.
//
// Provider lifecycle:
//   1. Route calls provider.initiate(intake) at submission time.
//   2. Provider returns providerRef (their tracking id) + status + optional
//      applicantRedirectUrl (some providers want the applicant to confirm
//      identity on their site before screening starts).
//   3. Provider calls our webhook at POST /api/background/webhook/:providerName.
//      verifyWebhook() validates the HMAC signature per provider's protocol.
//      parseWebhook() converts the provider payload into a normalized update.
//   4. Route applies the update to the background_checks row.
//
// MockProvider ships now: returns awaiting_applicant on initiate, completes
// only via the explicit POST /api/background/dev-mock-webhook endpoint
// (no setTimeout — predictable, survives server restart). Real adapters drop
// in alongside it without touching the route.

export interface BackgroundProviderInitiateRequest {
  backgroundCheckId: string
  firstName: string
  lastName: string
  email: string
  dateOfBirth: string  // YYYY-MM-DD
  // S551: optional — Checkr Tenant collects SSN on its own hosted consent
  // form, so checkr-provider intakes never send one. Mock still accepts it.
  ssnLast4?: string | null
  street1: string
  street2?: string | null
  city: string
  state: string
  zip: string
  consentCredit: boolean
  consentCriminal: boolean
  // S551: the RENTAL property being screened for (required by Checkr Tenant
  // orders; distinct from the applicant's current residence above). Resolved
  // by the route from unit_id, falling back to the landlord's property.
  property?: {
    name?: string | null
    street: string
    city: string
    state: string
    zipcode: string
  } | null
}

export interface BackgroundProviderInitiateResult {
  providerRef: string
  status: BackgroundCheckStatus
  applicantRedirectUrl?: string | null
  failureReason?: string | null
}

export interface BackgroundProviderWebhookUpdate {
  providerRef: string
  status: BackgroundCheckStatus
  reportSummary?: Record<string, unknown> | null
  failureReason?: string | null
  receivedAt: Date
  // S551: some providers (Checkr Tenant) deliver only a report id in the
  // webhook; the route calls provider.fetchReport(reportRef) to pull the
  // actual results after applying the status update.
  reportRef?: string | null
}

// S87: CRA contact info for FCRA §615(a)(2) adverse action notices. Each
// background-check provider IS a consumer reporting agency for FCRA
// purposes — when a landlord denies an applicant based on the report,
// the notice must include this info.
export interface CraDisclosure {
  name:    string
  address: string
  phone:   string
  website?: string
}

export interface BackgroundProvider {
  readonly name: string
  initiate(req: BackgroundProviderInitiateRequest): Promise<BackgroundProviderInitiateResult>
  verifyWebhook(headers: Record<string, string | string[] | undefined>, rawBody: string): boolean
  /**
   * S640: returns null for an event that is genuinely nothing to act on.
   *
   * Throwing made the route 500, which tells the provider to RETRY — so an
   * event we simply did not need was redelivered forever. Checkr sent 79
   * webhooks in 25 hours and 75 of them 500'd on one such event, burying the
   * `report.completed` that actually mattered. An endpoint should acknowledge
   * what it can safely ignore and reserve failure for things worth retrying.
   */
  parseWebhook(rawBody: string): BackgroundProviderWebhookUpdate | null
  craDisclosure(): CraDisclosure
  // S551: optional — pull the full report when the webhook only carries a
  // report id (see BackgroundProviderWebhookUpdate.reportRef). Returns the
  // normalized summary to store on the row, or null if unavailable.
  fetchReport?(reportRef: string): Promise<Record<string, unknown> | null>
  /**
   * S640: ask the provider where an order stands, without waiting to be told.
   *
   * A webhook is one HTTP request that either arrives or does not. Checkr
   * finished Anastacio Erreguin's report at 15:19 Phoenix on Sep 9 and GAM
   * never heard — his screening sat at `processing` for twenty-two hours until
   * Nic went in and decided it by hand. A $44.99 report that gates somebody's
   * tenancy cannot depend on a single delivery.
   */
  fetchStatus?(providerRef: string): Promise<{
    status: BackgroundCheckStatus
    reportRef: string | null
  } | null>
}

// ── MOCK PROVIDER ─────────────────────────────────────────────
//
// Echoes intake into a provider-shaped envelope. Real providers replace
// the body of initiate() with an HTTP call and verifyWebhook()/parseWebhook()
// with their HMAC scheme + payload format. Webhook secret can be supplied
// via BACKGROUND_MOCK_WEBHOOK_SECRET; absent in dev → verification passes
// (so dev-mock-webhook works without env setup).

class MockProvider implements BackgroundProvider {
  readonly name = 'mock'

  async initiate(req: BackgroundProviderInitiateRequest): Promise<BackgroundProviderInitiateResult> {
    if (!req.consentCredit || !req.consentCriminal) {
      return {
        providerRef: '',
        status: 'failed',
        failureReason: 'Provider rejected: missing required consents',
      }
    }
    const providerRef = 'mock_' + crypto.randomBytes(12).toString('hex')
    return {
      providerRef,
      status: 'awaiting_applicant',
      applicantRedirectUrl: null,
    }
  }

  verifyWebhook(headers: Record<string, string | string[] | undefined>, rawBody: string): boolean {
    const secret = process.env.BACKGROUND_MOCK_WEBHOOK_SECRET
    if (!secret) return true  // dev convenience — explicit secret enables HMAC
    const sigHeader = headers['x-mock-signature']
    const sig = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader
    if (!sig) return false
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
    try {
      return crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))
    } catch {
      return false
    }
  }

  parseWebhook(rawBody: string): BackgroundProviderWebhookUpdate {
    const payload = JSON.parse(rawBody) as {
      providerRef: string
      status: string
      reportSummary?: Record<string, unknown>
      failureReason?: string
    }
    const status = mapProviderStatus(payload.status)
    return {
      providerRef: payload.providerRef,
      status,
      reportSummary: payload.reportSummary ?? null,
      failureReason: payload.failureReason ?? null,
      receivedAt: new Date(),
    }
  }

  craDisclosure(): CraDisclosure {
    // Dev placeholder. Real adapters return their own contact info; the
    // mock notice text will clearly read as a placeholder so it can't be
    // mistaken for a real adverse action notice in production.
    return {
      name:    'GAM Mock CRA (development only)',
      address: '0 Placeholder St, Phoenix, AZ 85001',
      phone:   '(000) 000-0000',
      website: undefined,
    }
  }
}

// Translate provider-vocabulary status strings into our enum. Each real
// adapter implements its own version of this; the mock accepts the bare
// canonical names.
function mapProviderStatus(raw: string): BackgroundCheckStatus {
  const lower = (raw || '').toLowerCase()
  switch (lower) {
    case 'pending':
    case 'awaiting_applicant':
    case 'submitted':
    case 'processing':
    case 'complete':
    case 'failed':
    case 'cancelled':
      return lower
    case 'completed':
      return 'complete'
    case 'in_progress':
    case 'in-progress':
      return 'processing'
    default:
      return 'failed'
  }
}

// ── CHECKR TENANT PROVIDER ────────────────────────────────────
//
// S551: rewritten from the S420 classic-API adapter (api.checkr.com Basic
// auth, candidate+report) to the CHECKR TENANT API the account actually
// runs on (docs: https://checkr-tenant-api-docs.redocly.app). Env:
//   CHECKR_API_KEY             — bearer token (ckr_sk_test_… / ckr_sk_live_…)
//   CHECKR_TENANT_BASE_URL     — default https://tenant.checkr.com/api
//   CHECKR_PACKAGE             — package slug: 'starter' | 'essential'
//   CHECKR_WEBHOOK_SECRET      — signing secret from the dashboard webhook
//                                (shown once at creation)
//
// Flow: POST /orders {package, property, applicant} → order id is the
// providerRef. Checkr emails the applicant an apply link (application_url)
// where THEY provide DOB/SSN + FCRA consent — GAM never touches screening
// PII on this path. Results arrive via signed webhooks; report.completed
// carries only report_id, so the route calls fetchReport() to pull the
// per-product clear/consider results.
//
// Order status mapping (Checkr Tenant → GAM enum):
//   waiting_for_applicant → awaiting_applicant
//   pending               → processing
//   completed             → complete  (clear AND consider both land here;
//                            approve/deny is the landlord's decision)
//   canceled              → cancelled

// The report's per-product items. Each non-null product carries a status of
// 'clear' | 'consider'; products not in the ordered package come back null.
/**
 * S640 — what Checkr's own docs call "fully resolved".
 *
 *   "inspect the `status` field on each non-null product for values `clear` or
 *    `consider` to determine when the screening is fully resolved."
 *
 * Anything else — pending, suspended, a status they add later — is a product
 * still running. See summariseProducts: a report with one of those in it is NOT
 * a clear report, and must never be shown to a landlord as one.
 */
const TERMINAL_PRODUCT_STATUSES = new Set(['clear', 'consider'])

/** 10/5 (Nic): the live ID scan every order asks for — see initiate(). */
export const CHECKR_ID_SCAN_ADD_ON = 'identity_verification'
const CHECKR_TENANT_PRODUCTS = [
  'criminal_history', 'credit_report', 'eviction_history',
  'identity_verification', 'income_verification',
  'sex_offender_registry', 'global_watchlist',
] as const

/**
 * ONE RULE FOR WHAT A LANDLORD IS SHOWN OUT OF A PRODUCT, and it is exported so
 * the live fetch and the backfill of reports already taken cannot drift. Three
 * kinds of thing never travel; everything else goes, in full.
 */
export const HELD_FROM_LANDLORD = (key: string, value: unknown): boolean =>
  /_url$|^url$|_uri$/i.test(key)
  || /(^|_)(document_data|documents|images?|photos?|scans?)($|_)/i.test(key)
  || (typeof value === 'string' && /^https?:\/\//i.test(value))

export function landlordVisibleDetail(item: Record<string, unknown>): Record<string, unknown> {
  const shown: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(item)) {
    if (!HELD_FROM_LANDLORD(k, v)) shown[k] = v
  }
  return shown
}

class CheckrProvider implements BackgroundProvider {
  readonly name = 'checkr'
  /** S639: the last raw report body fetched, for the archive. */
  rawReport: Record<string, unknown> | null = null

  private get baseUrl(): string {
    return process.env.CHECKR_TENANT_BASE_URL || 'https://tenant.checkr.com/api'
  }

  private headers(): Record<string, string> {
    const key = process.env.CHECKR_API_KEY
    if (!key) {
      throw new Error('CHECKR_API_KEY is not set — cannot call Checkr Tenant API')
    }
    return {
      Authorization:  `Bearer ${key}`,
      'Content-Type': 'application/json',
    }
  }

  async initiate(req: BackgroundProviderInitiateRequest): Promise<BackgroundProviderInitiateResult> {
    // S637: NO CONSENT GATE HERE — Checkr collects FCRA consent itself.
    //
    // This guard was written when GAM's own intake gathered consent, and it
    // outlived that. S578 moved DOB, SSN, address AND the FCRA disclosure and
    // authorization onto Checkr's hosted apply flow, so the intake form stopped
    // rendering those checkboxes and the route stopped requiring them — but
    // this line kept demanding them. Three layers, and the middle one changed.
    //
    // The result was a screening product that failed 100% of the time AFTER
    // taking the applicant's money: Anastacio Erreguin paid $44.99, the order
    // was rejected here before Checkr was ever called, and nothing told anyone.
    // He was the first person to use the link.
    //
    // Consent is still obtained — on Checkr's page, by Checkr, which is what
    // makes them the CRA of record for it. The mock provider below keeps its
    // own gate, because that path really does collect consent in GAM.
    // S564 (Nic): ONE package platform-wide, hardcoded — never env- or
    // landlord-configurable. A single Essential screen for every applicant on
    // every route/state removes any lever for a landlord to order a lighter or
    // heavier check per applicant (discrimination guard). To change the platform
    // package, change it here deliberately.
    const pkg = 'essential'
    if (!req.property) {
      return {
        providerRef: '',
        status: 'failed',
        failureReason: 'Checkr Tenant orders require a rental property address — none resolved for this check',
      }
    }

    // Applicant identity: name + email (+ DOB when the intake captured it).
    // SSN is deliberately NEVER sent — the applicant supplies it on Checkr's
    // hosted consent form, so screening PII stays off GAM servers.
    // 10/5 (Nic): "Order the ID scan." The price applicants pay has always
    // been built on Checkr's live ID scan (identity_verification — an add-on;
    // Essential does not bundle it), but no order ever asked for it, so every
    // applicant paid for a check that never ran. Every order asks now.
    //
    // 10/21, with the September receipts in hand: both of them show one line,
    // "Essential Tenant Screening package", $34.99, no add-on — because the
    // field below landed four hours AFTER the last of those five orders went
    // out. None of them ever asked. `add_on_products` is the documented way to
    // order it on the Tenant API, so it is the right request and it stays.
    //
    // Checkr ALSO carries the ID scan as a per-property switch in their
    // dashboard ("Identity Intelligence"), which Nic turned on for Mountain
    // View the same day. Both levers are on now, deliberately. Which of the two
    // actually does the work is something only a real order can tell us, and
    // the next report settles it: `id_scan_ran` below is checked against the
    // report, never inferred from this request.
    //
    // The switch is per PROPERTY, and a property only exists in Checkr once an
    // order names it — so a brand-new park arrives with whatever the account
    // default is. If the field alone turns out not to be enough, every new park
    // needs the switch turned on by hand, and `checkr_id_scan_missing` is the
    // only thing standing between that and an applicant paying for a scan
    // nobody ran.
    //
    // The receipts also proved `package` here beats the dashboard: the property
    // was set to Complete and we were billed Essential, because this body names
    // the package outright. That is deliberate (S564) — leave it that way.
    const body: { order: Record<string, unknown> } = {
      order: {
        package: pkg,
        add_on_products: [CHECKR_ID_SCAN_ADD_ON],
        property: {
          name:    req.property.name || null,
          street:  req.property.street,
          city:    req.property.city,
          state:   req.property.state,
          zipcode: req.property.zipcode,
        },
        applicant: {
          first_name: req.firstName,
          last_name:  req.lastName,
          email:      req.email,
          ...(req.dateOfBirth ? { dob: req.dateOfBirth } : {}),
        },
      },
    }

    // S637: Checkr's Tenant API REQUIRES an Idempotency-Key on order create —
    // without it the call is rejected 422 "Header is required" before any
    // validation of the order itself. Nothing in our stack sent one, so no
    // order could ever be placed.
    //
    // Keyed on the background check id, which is the right idempotency unit:
    // a retry of the SAME check (this one was retried by hand after being
    // wrongly rejected) must never create a second order the applicant is
    // charged for or asked to complete twice.
    const post = (b: unknown, key: string) => fetch(`${this.baseUrl}/orders`, {
      method: 'POST',
      headers: { ...this.headers(), 'Idempotency-Key': key },
      body: JSON.stringify(b),
    })
    let res = await post(body, `gam-bgc-${req.backgroundCheckId}`)
    if (!res.ok) {
      const text = await res.text()
      // Checkr refuses an add-on the account is not set up for (422). The
      // applicant is standing at the counter: run the check without it rather
      // than stop them, and tell GAM at once so the add-on gets turned on.
      // A new idempotency key — the same key with a different body is refused.
      if (res.status === 422 && /add_on|identity_verification/i.test(text)) {
        const { add_on_products: _dropped, ...withoutAddOn } = body.order
        res = await post({ order: withoutAddOn }, `gam-bgc-${req.backgroundCheckId}-no-id-scan`)
        try {
          const { createAdminNotification } = await import('./adminNotifications')
          await createAdminNotification({
            severity: 'critical', category: 'checkr_id_scan_refused', emailSuperAdmins: true,
            title: 'Checkr refused the ID scan — turn it on in Checkr',
            body: `Checkr would not add the live ID scan (identity_verification) to a screening order, so this applicant's check ran without it. Enable the ID-scan add-on for the organization in the Checkr dashboard. Checkr said: ${text.slice(0, 300)}`,
            context: { background_check_id: req.backgroundCheckId },
          })
        } catch { /* the order matters more than the notice */ }
      } else {
        return {
          providerRef: '',
          status: 'failed',
          failureReason: `Checkr order create failed: ${res.status} ${text.slice(0, 200)}`,
        }
      }
      if (!res.ok) {
        const again = await res.text()
        return {
          providerRef: '',
          status: 'failed',
          failureReason: `Checkr order create failed: ${res.status} ${again.slice(0, 200)}`,
        }
      }
    }
    const order = await res.json() as { id: string; status: string; application_url?: string | null }
    return {
      providerRef:          order.id,
      status:               mapCheckrTenantStatus(order.status),
      // While waiting_for_applicant this is the Checkr-hosted apply link.
      // Checkr emails (and in live mode texts) it to the applicant; we also
      // surface it in the portal so they can finish without digging through
      // their inbox.
      applicantRedirectUrl: order.application_url || null,
    }
  }

  verifyWebhook(headers: Record<string, string | string[] | undefined>, rawBody: string): boolean {
    const secret = process.env.CHECKR_WEBHOOK_SECRET
    if (!secret) return false
    // Tenant-Signature: t=<unix_ts>,v1=<hex hmac of "<t>.<raw_body>">
    const sigHeader = headers['tenant-signature']
    const sig = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader
    if (!sig) return false
    const parts = Object.fromEntries(
      sig.split(',').map((kv) => kv.trim().split('=') as [string, string])
    ) as { t?: string; v1?: string }
    if (!parts.t || !parts.v1) return false
    const expected = crypto.createHmac('sha256', secret)
      .update(`${parts.t}.${rawBody}`)
      .digest('hex')
    try {
      return crypto.timingSafeEqual(Buffer.from(parts.v1, 'hex'), Buffer.from(expected, 'hex'))
    } catch {
      return false
    }
  }

  parseWebhook(rawBody: string): BackgroundProviderWebhookUpdate | null {
    // Event envelope: { id, object:'event', type, created_at, data }
    const evt = JSON.parse(rawBody) as {
      id: string
      type: string
      created_at: string
      data: Record<string, any>
    }
    const d = evt.data || {}
    switch (evt.type) {
      // Apply-flow progress. 'visited' means the link was opened but consent
      // not yet given — still awaiting the applicant.
      case 'order.applicant.visited':
        return { providerRef: requireOrderRef(d, evt.type), status: 'awaiting_applicant', receivedAt: new Date() }
      case 'order.applicant.started':
      case 'order.applicant.completed':
        return { providerRef: requireOrderRef(d, evt.type), status: 'processing', receivedAt: new Date() }
      // ── S640: A PER-PRODUCT PING IS NOT AN UPDATE ────────────────────────
      //
      // This asked requireOrderRef for an order id the event does not carry:
      // the payload is the report ITEM (rpi_…), which references a report, not
      // an order. So it threw, the route 500'd, and Checkr redelivered — 75
      // failures against 4 successes, one per product per report, forever.
      //
      // And there was nothing to apply even if it had parsed. The check is
      // already `processing`; a product finishing does not change that. Checkr
      // sends `report.completed` when the whole thing is done, which is the
      // event that matters. Acknowledge this one and move on.
      case 'report.product.completed':
        return null
      // ── S640: THE COMPLETION EVENT CARRIES A REPORT ID, NOT AN ORDER ID ──
      //
      // Checkr's Tenant docs: "we POST a report.completed event ... including
      // the report_id", and "fetch it via GET /reports/{id} using the report_id
      // from the webhook payload". Nowhere do they promise an order_id.
      //
      // This demanded one and threw without it — the same failure that made 75
      // of 79 deliveries 500, one level up and on the only event that finishes a
      // screening. An empty providerRef tells the route to resolve the order
      // FROM the report, which carries order_id in its body.
      case 'report.completed':
        return {
          providerRef: d.order_id || '',
          status:      'complete',
          reportRef:   d.id || d.report_id || null,
          receivedAt:  new Date(),
        }
      // S640: an event we do not recognize is acknowledged, not retried.
      // Providers add event types without asking; the alternative is a retry
      // storm on every one of them, which is exactly what happened here.
      default:
        return null
    }
  }

  // Pull the report and normalize into the row's report_summary jsonb:
  // { result: 'clear'|'consider', products: { <product>: 'clear'|'consider' } }
  // Overall result is 'consider' if ANY included product is consider.
  /**
   * S640: the order's own view of itself, plus its report when there is one.
   *
   * `GET /orders/{id}` carries the status but no pointer to the report;
   * `GET /orders/{id}/report` returns the report directly. Two calls, and the
   * second only once the first says completed.
   */
  async fetchStatus(providerRef: string): Promise<{ status: BackgroundCheckStatus; reportRef: string | null } | null> {
    const res = await fetch(`${this.baseUrl}/orders/${encodeURIComponent(providerRef)}`, {
      headers: this.headers(),
    })
    if (!res.ok) return null
    const order = await res.json() as Record<string, any>
    const status = mapCheckrTenantStatus(String(order.status || ''))
    if (status !== 'complete') return { status, reportRef: null }

    // S640: the order saying completed is not the same as the screening being
    // resolved — Checkr's docs put terminal status on each PRODUCT. Pull the
    // report and check. A report that is not there yet is a documented 404
    // meaning "not ready", not a broken link, so it stays processing.
    try {
      const rep = await fetch(`${this.baseUrl}/orders/${encodeURIComponent(providerRef)}/report`, {
        headers: this.headers(),
      })
      if (!rep.ok) return { status: 'processing', reportRef: null }
      const body = await rep.json() as Record<string, any>
      const unresolved = CHECKR_TENANT_PRODUCTS.some((p) => {
        const item = body[p]
        return item && typeof item === 'object' && typeof item.status === 'string'
          && !TERMINAL_PRODUCT_STATUSES.has(item.status)
      })
      if (unresolved) return { status: 'processing', reportRef: null }
      return { status, reportRef: typeof body.id === 'string' ? body.id : null }
    } catch {
      // Reaching Checkr failed, which says nothing about the screening. Leave it
      // where it is and try again on the next pass.
      return { status: 'processing', reportRef: null }
    }
  }

  async fetchReport(reportRef: string): Promise<Record<string, unknown> | null> {
    const res = await fetch(`${this.baseUrl}/reports/${encodeURIComponent(reportRef)}`, {
      headers: this.headers(),
    })
    if (!res.ok) return null
    const report = await res.json() as Record<string, any>
    // S639: the payload verbatim, before it is narrowed to a summary. The
    // normalization below answers today's question; the archive answers the ones
    // that come later — a dispute, a re-screen, "what did it actually say".
    this.rawReport = report
    const products: Record<string, string> = {}
    const details: Record<string, Record<string, unknown>> = {}
    // ── S640: A HALF-FINISHED REPORT IS NOT A CLEAR REPORT ─────────────────
    //
    // This started at 'clear' and only moved on a 'consider', so a product
    // still PENDING left the overall result reading clear. A landlord could
    // have approved somebody on a screening that had not finished running, and
    // nothing on the page would have said so. Checkr's docs are explicit that
    // resolution is per product; unresolved is its own answer, not a pass.
    let overall: 'clear' | 'consider' = 'clear'
    let allTerminal = true
    for (const p of CHECKR_TENANT_PRODUCTS) {
      const item = report[p]
      if (item && typeof item === 'object' && typeof item.status === 'string') {
        products[p] = item.status
        if (!TERMINAL_PRODUCT_STATUSES.has(item.status)) allTerminal = false
        if (item.status === 'consider') overall = 'consider'
        // ── S639 (Nic): "I'm just wondering why Checkr is considering a seven
        // twenty credit score as consider instead of good." ─────────────────
        //
        // A fair question that nobody could answer, because this kept the
        // one-word status and threw the rest away. Checkr had in fact returned
        // credit_score 720 and credit_file_status "available" alongside that
        // "consider", and neither ever reached the database, let alone the
        // landlord — so "consider" arrived looking like a verdict on the number
        // when it is a verdict against the criteria configured on the account.
        //
        // ── 10/24 (Nic) — THE ALLOWLIST IS GONE. THE LANDLORD GETS ALL OF IT.
        //
        //   "why do we not provide more of the information that came from
        //    Checker to the landlord? Like, the landlord can only see very
        //    little. It just says clear or consider and their credit score. But
        //    the Checker portal shows, you know, 90% on-time payments, 9
        //    payments late in the last 7 months, credit score only 470, credit
        //    utilization 184%. Like, why are some of those details not in the
        //    package that's given to the landlord for consideration? Some of
        //    those other details are important, not just a clear or consider."
        //
        // And on where the line sits, which is the part that settles it:
        //
        //   "Anything that checker shows me on the dashboard is what they would
        //    be willing to show a landlord... They're expecting landlords to be
        //    set up on partnerships with them. I'm acting as a middleman for the
        //    software, but anything that I can see on this other screen is
        //    something they are willing to share."
        //
        // He is right, and the allowlist that used to live here had it backwards.
        // CHECKR is the consumer reporting agency: they assembled the report,
        // they took the FCRA disclosure and authorization, and the dashboard
        // this data is drawn from is the one they built FOR LANDLORDS. GAM sits
        // between the two as software. Deciding that a landlord may not see a
        // field the CRA itself puts in front of them is GAM gating on a judgment
        // that is not GAM's to make — the same "accommodate, never block" line
        // the rest of the platform holds.
        //
        // The practical cost of the old rule was not theoretical. It kept a
        // one-word verdict and a score and dropped `credit_summary` (on-time
        // payment rate, payment timeline, utilization, account age) and
        // `credit_score_factors` (WHY the score is what it is) on the floor,
        // because the filter below it rejected anything that was an object. So
        // "consider" reached the landlord with nothing to weigh it against,
        // which is the exact complaint S639 was opened for and did not finish.
        //
        // ── WITH EXACTLY ONE LINE HELD, AND IT IS NOT ABOUT THE DECISION.
        //
        //   "I don't ever want landlords going to the checker dashboard. I
        //    don't want links to pictures, things like that. They just need the
        //    straight information. You don't need to give them the pictures.
        //    They don't need the driver's license number. Whatever."
        //
        // So: the identity product's VERDICT and its consider_reasons are
        // straight information and stay. The scanned identity document behind
        // them does not — the images, and the document data (licence number,
        // date of birth, expiry) that rides with them. Neither is something a
        // landlord weighs; the verdict already says whether the person is who
        // they said they were.
        //
        // Written as a RULE about the shape rather than a list of field names,
        // for the same reason the allowlist above had to go: a name-by-name
        // filter silently drops whatever Checkr adds next. Three kinds of thing
        // never travel — anything that is a link out (a landlord belongs in
        // GAM, not in Checkr's dashboard), the document payload, and anything
        // whose own name says it carries an image. Everything else, in full.
        details[p] = landlordVisibleDetail(item as Record<string, unknown>)
      }
    }
    // S642 (Nic): "We're gonna generate accounts off a legal name." An applicant
    // account is created from email + password and carries only the provisional
    // name typed to open the order. The screener is the authority on who this
    // person legally is, so the matched name comes back with the report and
    // replaces it. Narrow on purpose — a name, nothing else from the candidate
    // record, in keeping with the allowlist above.
    const cand = (report.candidate ?? report.applicant ?? {}) as Record<string, any>
    const matchedFirst = typeof cand.first_name === 'string' ? cand.first_name.trim() : ''
    const matchedLast  = typeof cand.last_name  === 'string' ? cand.last_name.trim()  : ''

    // ── 10/21 (Nic) — A PRODUCT WE ORDERED AND DID NOT GET IS A LOUD PROBLEM ──
    //
    //   "I'm pretty sure that we didn't code it right for the identity
    //    verification add-on package. So whatever we need to change in our
    //    settings to add that onto the invoices is what we need to do."
    //
    // He was right, and this loop is why nobody could tell. The price every
    // applicant pays is built on the live ID scan, but the loop above only
    // records a product that is PRESENT: a product that never ran leaves no
    // key, no status and no trace, `allTerminal` stays true, and the report
    // reads as fully resolved. Five real screenings went out that way — the
    // five reports in production carry criminal_history, credit_report,
    // eviction_history, global_watchlist and sex_offender_registry, and no
    // identity_verification at all — so five applicants paid for a scan that
    // never ran and nothing anywhere said so.
    //
    // 10/21, with the September receipts and the Checkr dashboard in hand, the
    // rest of the story: the code that asks for the add-on landed 10/5 at
    // 14:03 and the last of those five orders went out 10/5 at 09:53, so not
    // one of them ever carried the request. The 422 path in initiate() never
    // fired because nothing was ever asked.
    //
    // Which is exactly why this check belongs here. Whether the add-on is
    // refused, ignored, never requested, or simply switched off for a park
    // nobody has touched yet, the only honest evidence that the scan ran is
    // the product coming back on the report. Never infer it from the request.
    //
    // It does not hold the report back. The five products that DID run are
    // resolved, and an applicant standing at the counter should not wait on
    // GAM's billing problem. It says so out loud instead: on the summary, so no
    // landlord is ever told an identity check happened when it did not, and to
    // the admins, so the add-on gets turned on.
    // ── 10/24: THE PRODUCT COMING BACK ON THE REPORT *IS* THE ANSWER.
    //
    // Doubted for an afternoon and then settled. Heather Miller's receipt shows
    // one line — "Essential Tenant Screening package" — with no identity add-on
    // itemized, which read at first like the scan had not been bought even
    // though her report came back clear on it. It had been: the line is simply
    // not broken out. Her invoice is $2.95 above the five orders that carry no
    // identity product, and hers is the only report holding the selfie and the
    // licence image, which is what the product produces. Nic: "on Heather, I
    // can see a selfie and the actual picture of her driver's license. None of
    // the other people have selfies and driver's license info on there."
    //
    // So the presence of the product is trustworthy evidence that it ran, and
    // its ABSENCE is the thing worth shouting about — an applicant who paid for
    // a scan nobody performed. That is what the alarm below is for.
    const idScanRan = CHECKR_ID_SCAN_ADD_ON in products
    if (!idScanRan) {
      try {
        const { createAdminNotification } = await import('./adminNotifications')
        await createAdminNotification({
          severity: 'critical', category: 'checkr_id_scan_missing', emailSuperAdmins: true,
          title: 'Checkr returned a report with no ID scan — the add-on is not being applied',
          body: 'The price the applicant pays includes the live ID scan (identity_verification, $3.95). This '
            + 'report came back WITHOUT that product, and Checkr raised no error — so the scan did not run and '
            + 'somebody paid for it anyway. Checkr keeps this as a per-PROPERTY switch: open the Checkr '
            + 'dashboard, go to Properties, pick this property, and turn Identity Intelligence on. A property '
            + 'appears there the first time an order names it, so a park screening its first applicant will '
            + 'always need this done once. '
            + '10/24: the add-on is ordered by GAM\'s own request (add_on_products), not by the dashboard '
            + 'switch — an order that came back WITHOUT the product is the one worth chasing. '
            + `Report ${report.id ?? reportRef}, order ${report.order_id ?? '(unknown)'}.`,
          context: { report_id: report.id ?? reportRef, order_id: report.order_id ?? null },
        })
      } catch { /* the report matters more than the notice */ }
    }

    return {
      provider:   'checkr',
      report_id:  report.id ?? reportRef,
      order_id:   report.order_id ?? null,
      result:     allTerminal ? overall : 'pending',
      matched_first_name: matchedFirst || null,
      matched_last_name:  matchedLast  || null,
      // S640: stated outright so a reader never has to infer it from the
      // per-product map, and so the landlord page can say "still running"
      // instead of rendering a verdict that is not one yet.
      all_products_resolved: allTerminal,
      // 10/21: whether the live ID scan this order asked for actually ran. A
      // reader must never have to work that out from the absence of a key.
      id_scan_ran: idScanRan,
      products,
      details,
      fetched_at: new Date().toISOString(),
    }
  }

  craDisclosure(): CraDisclosure {
    return {
      name:    'Checkr, Inc.',
      address: 'One Montgomery Street, Suite 2400, San Francisco, CA 94104',
      phone:   '(844) 824-3257',
      website: 'https://checkr.com',
    }
  }
}

// Webhook data carries order_id on report.* events and id on order.* events
// (where the object IS the order). Either way we key updates by the order id,
// which is what initiate() stored as provider_ref.
function requireOrderRef(data: Record<string, any>, eventType: string): string {
  const ref = eventType.startsWith('report.') ? data.order_id : (data.order_id || data.id)
  if (!ref) throw new Error(`Checkr Tenant webhook ${eventType} missing order id`)
  return ref
}

function mapCheckrTenantStatus(raw: string): BackgroundCheckStatus {
  switch ((raw || '').toLowerCase()) {
    case 'waiting_for_applicant': return 'awaiting_applicant'
    case 'pending':               return 'processing'
    case 'completed':             return 'complete'
    case 'canceled':              return 'cancelled'
    default:                      return 'failed'
  }
}

const PROVIDERS: Record<string, BackgroundProvider> = {
  mock:   new MockProvider(),
  checkr: new CheckrProvider(),
}

export function getProvider(name?: string | null): BackgroundProvider {
  const key = (name || 'mock').toLowerCase()
  const provider = PROVIDERS[key]
  if (!provider) throw new Error(`Unknown background provider: ${name}`)
  return provider
}

export function listProviderNames(): string[] {
  return Object.keys(PROVIDERS)
}

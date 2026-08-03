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
  parseWebhook(rawBody: string): BackgroundProviderWebhookUpdate
  craDisclosure(): CraDisclosure
  // S551: optional — pull the full report when the webhook only carries a
  // report id (see BackgroundProviderWebhookUpdate.reportRef). Returns the
  // normalized summary to store on the row, or null if unavailable.
  fetchReport?(reportRef: string): Promise<Record<string, unknown> | null>
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
const CHECKR_TENANT_PRODUCTS = [
  'criminal_history', 'credit_report', 'eviction_history',
  'identity_verification', 'income_verification',
  'sex_offender_registry', 'global_watchlist',
] as const

class CheckrProvider implements BackgroundProvider {
  readonly name = 'checkr'

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
    if (!req.consentCredit || !req.consentCriminal) {
      return {
        providerRef: '',
        status: 'failed',
        failureReason: 'Provider rejected: missing required consents',
      }
    }
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
    const body = {
      order: {
        package: pkg,
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

    const res = await fetch(`${this.baseUrl}/orders`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const text = await res.text()
      return {
        providerRef: '',
        status: 'failed',
        failureReason: `Checkr order create failed: ${res.status} ${text.slice(0, 200)}`,
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

  parseWebhook(rawBody: string): BackgroundProviderWebhookUpdate {
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
      // Individual product done — report not complete yet; stay processing.
      case 'report.product.completed':
        return { providerRef: requireOrderRef(d, evt.type), status: 'processing', receivedAt: new Date() }
      // Full report ready: data carries { id: report_id, order_id }. The route
      // fetches the actual results via fetchReport(reportRef).
      case 'report.completed':
        return {
          providerRef: requireOrderRef(d, evt.type),
          status:      'complete',
          reportRef:   d.id || null,
          receivedAt:  new Date(),
        }
      default:
        throw new Error(`Unhandled Checkr Tenant event type: ${evt.type}`)
    }
  }

  // Pull the report and normalize into the row's report_summary jsonb:
  // { result: 'clear'|'consider', products: { <product>: 'clear'|'consider' } }
  // Overall result is 'consider' if ANY included product is consider.
  async fetchReport(reportRef: string): Promise<Record<string, unknown> | null> {
    const res = await fetch(`${this.baseUrl}/reports/${encodeURIComponent(reportRef)}`, {
      headers: this.headers(),
    })
    if (!res.ok) return null
    const report = await res.json() as Record<string, any>
    const products: Record<string, string> = {}
    let overall: 'clear' | 'consider' = 'clear'
    for (const p of CHECKR_TENANT_PRODUCTS) {
      const item = report[p]
      if (item && typeof item === 'object' && typeof item.status === 'string') {
        products[p] = item.status
        if (item.status === 'consider') overall = 'consider'
      }
    }
    return {
      provider:   'checkr',
      report_id:  report.id ?? reportRef,
      order_id:   report.order_id ?? null,
      result:     overall,
      products,
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

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
  ssnLast4: string
  street1: string
  street2?: string | null
  city: string
  state: string
  zip: string
  consentCredit: boolean
  consentCriminal: boolean
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

// ── CHECKR PROVIDER ───────────────────────────────────────────
//
// S420: live Checkr API adapter. Implements BackgroundProvider against
// https://api.checkr.com/v1. Credentials in env:
//   CHECKR_API_KEY        — HTTP Basic username (empty password)
//   CHECKR_PACKAGE        — package slug, e.g. 'tasker_pro'
//   CHECKR_WEBHOOK_SECRET — HMAC secret for X-Checkr-Signature
//
// Status mapping (Checkr → GAM enum):
//   pending    → processing
//   clear      → complete   (no adverse data)
//   consider   → complete   (adverse data; landlord-side decision)
//   suspended  → cancelled
//   dispute    → processing  (Checkr re-running)
//   anything else → failed (defensive)
//
// Note on scope: report status drives the gating. Candidate-only states
// (created, awaiting_consent) map to awaiting_applicant. The route's
// initiate() returns the candidate creation result; the eventual report
// status arrives via webhook.

class CheckrProvider implements BackgroundProvider {
  readonly name = 'checkr'

  private get baseUrl(): string {
    return process.env.CHECKR_BASE_URL || 'https://api.checkr.com/v1'
  }

  private authHeader(): string {
    const key = process.env.CHECKR_API_KEY
    if (!key) {
      throw new Error('CHECKR_API_KEY is not set — cannot call Checkr API')
    }
    // Checkr uses Basic auth with API key as username, empty password.
    return 'Basic ' + Buffer.from(key + ':').toString('base64')
  }

  async initiate(req: BackgroundProviderInitiateRequest): Promise<BackgroundProviderInitiateResult> {
    if (!req.consentCredit || !req.consentCriminal) {
      return {
        providerRef: '',
        status: 'failed',
        failureReason: 'Provider rejected: missing required consents',
      }
    }

    // Step 1: create the candidate. Checkr's candidate endpoint accepts
    // form-encoded body (per their docs).
    const candidatePayload = new URLSearchParams({
      first_name:      req.firstName,
      last_name:       req.lastName,
      email:           req.email,
      dob:             req.dateOfBirth,
      ssn:             req.ssnLast4,            // partial SSN accepted
      zipcode:         req.zip,
      no_middle_name:  'true',
    })

    const candRes = await fetch(`${this.baseUrl}/candidates`, {
      method: 'POST',
      headers: {
        Authorization:  this.authHeader(),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: candidatePayload.toString(),
    })

    if (!candRes.ok) {
      const text = await candRes.text()
      return {
        providerRef: '',
        status: 'failed',
        failureReason: `Checkr candidate create failed: ${candRes.status} ${text.slice(0, 200)}`,
      }
    }
    const candidate = await candRes.json() as { id: string }

    // Step 2: create the report against the candidate using the
    // configured package slug. Without a package the report can't be
    // ordered — env-driven so each install can pick the SKU they pay for.
    const pkg = process.env.CHECKR_PACKAGE
    if (!pkg) {
      return {
        providerRef: candidate.id,
        status: 'failed',
        failureReason: 'CHECKR_PACKAGE env var not set — candidate created but no report ordered',
      }
    }
    const reportPayload = new URLSearchParams({
      package:      pkg,
      candidate_id: candidate.id,
    })
    const repRes = await fetch(`${this.baseUrl}/reports`, {
      method: 'POST',
      headers: {
        Authorization:  this.authHeader(),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: reportPayload.toString(),
    })
    if (!repRes.ok) {
      const text = await repRes.text()
      return {
        providerRef: candidate.id,
        status: 'failed',
        failureReason: `Checkr report create failed: ${repRes.status} ${text.slice(0, 200)}`,
      }
    }
    const report = await repRes.json() as { id: string; status: string }
    return {
      providerRef: report.id,
      status: mapCheckrStatus(report.status),
      applicantRedirectUrl: null,  // Checkr emails the applicant directly
    }
  }

  verifyWebhook(headers: Record<string, string | string[] | undefined>, rawBody: string): boolean {
    const secret = process.env.CHECKR_WEBHOOK_SECRET
    if (!secret) return false
    const sigHeader = headers['x-checkr-signature']
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
    // Checkr webhook envelope: { type, data: { object: { id, status, ...report } } }
    const payload = JSON.parse(rawBody) as {
      type: string
      data: { object: { id: string; status: string; adjudication?: string } }
    }
    const obj = payload.data?.object
    if (!obj?.id) {
      throw new Error('Checkr webhook missing data.object.id')
    }
    return {
      providerRef:   obj.id,
      status:        mapCheckrStatus(obj.status),
      reportSummary: { adjudication: obj.adjudication ?? null, raw_status: obj.status },
      failureReason: null,
      receivedAt:    new Date(),
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

function mapCheckrStatus(raw: string): BackgroundCheckStatus {
  const lower = (raw || '').toLowerCase()
  switch (lower) {
    case 'pending':         return 'processing'
    case 'clear':           return 'complete'
    case 'consider':        return 'complete'
    case 'suspended':       return 'cancelled'
    case 'dispute':         return 'processing'
    case 'created':         return 'awaiting_applicant'
    case 'awaiting_consent':return 'awaiting_applicant'
    case 'complete':        return 'complete'
    default:                return 'failed'
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

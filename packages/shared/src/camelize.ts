// ============================================================
// API RESPONSE CASE TRANSFORM — snake_case → camelCase
//
// The GAM API returns raw snake_case columns from Postgres. Every
// frontend portal historically read those responses as if they
// were camelCased, which silently returned undefined and triggered
// `?? false` / `?? null` fallbacks — bug surfaced repeatedly
// across S309–S311. S312 lands a one-way response transformer
// applied in each portal's axios response interceptor.
//
// One-way response transform: snake_case DB columns → camelCase
// frontend reads. Request bodies are NOT transformed at runtime.
//
// Wire-format convention (S317 onward): request bodies use
// camelCase keys. Backend zod schemas + req.body destructures
// should accept camelCase. New routes always; existing routes
// migrate incrementally as they're touched.
//
// The existing ~91 snake_case zod fields are pre-S317 legacy
// and migrate in subsequent sessions when their surrounding code
// is touched (fix-it-right when nearby; not a separate refactor
// pass). The 5 high-confidence pairs aligned in S317:
//   - POST  /bulletin/:id/vote                (voteType)
//   - PATCH /properties/:id/manager           (userId)
//   - PATCH /landlords/me/default-pm-company  (pmCompanyId)
//   - PATCH /inspections/:id                  (scheduledFor)
//   - PATCH /leases/:id/deposit-return        (damageLines,
//                                              otherDeductions)
//
// POS routes (offline-sync subsystem) intentionally deferred —
// the sync-queue persistence layer needs care that's out of
// scope for the polish-rename pass.
//
// JSONB blob protection: certain JSONB column values are
// user-controlled / external-vendor / domain-arbitrary (audit-log
// snapshots, Checkr report summaries, notification payloads,
// permissions records). Camelizing keys inside those would
// mangle the data. The PASSTHROUGH set below names the keys
// whose VALUES are left untouched; the key itself is still
// camelized (which is a no-op for single-word keys anyway).
// ============================================================

const JSONB_PASSTHROUGH_KEYS = new Set<string>([
  // Audit / admin event payloads
  'old_value',
  'new_value',
  'metadata',
  'context',
  // Background check / adverse action — Checkr response shapes
  'report_summary',
  'risk_flags',
  'risk_factors',
  'income_document_urls',
  // Credit ledger — user-controlled + external attestation
  'event_data',
  'attestation_evidence',
  'external_attestation',
  'dimension_scores',
  'community_stats',
  'cooperation_stats',
  'payment_stats',
  'property_stats',
  'tenancy_stats',
  'definition', // credit_score_formulas — versioned formula spec
  // CSV / import
  'column_headers',
  'sample_rows',
  'extraction_extras',
  'import_extra_data',
  'parser_flags',
  'parser_output',
  // Per-row evidence / signatures
  'evidence',
  'signature_evidence',
  // Permissions JSONB on team-role scope tables
  'permissions',
  // Landlord-entered deposit-return inputs
  'damage_lines',
  'other_deductions',
  // Misc payload / data columns
  'data',          // notifications.data / tenant_notifications.data
  'payload',       // platform_events.payload
  'scope_ref',     // document_batches.scope_ref
  'scope_payload', // invitations.scope_payload
  'items',         // pos_refunds.items / purchase_requests.items
  'due_dates',     // state_tax_forms.due_dates
  // Allocation/supersedence breakdowns
  'gam_supersedence_breakdown',
])

// Some API endpoints surface JSONB columns under aliased names (e.g.
// `disputed_event_data` aliases credit_events.event_data; `old_state`
// is sometimes a snapshot blob). Anything matching these suffix
// patterns gets passthrough treatment in addition to the exact-name
// set above.
const JSONB_PASSTHROUGH_SUFFIXES = [
  '_data',
  '_metadata',
  '_payload',
  '_evidence',
  '_attestation',
  '_breakdown',
  '_value',
  '_stats',
]

function isPassthroughKey(k: string): boolean {
  if (JSONB_PASSTHROUGH_KEYS.has(k)) return true
  for (const suffix of JSONB_PASSTHROUGH_SUFFIXES) {
    if (k.endsWith(suffix)) return true
  }
  return false
}

const SNAKE_TO_CAMEL_PATTERN = /_([a-z0-9])/g

export function snakeToCamel(s: string): string {
  return s.replace(SNAKE_TO_CAMEL_PATTERN, (_, c) => c.toUpperCase())
}

export function camelizeKeys<T = unknown>(obj: T): T {
  if (Array.isArray(obj)) {
    return obj.map((v) => camelizeKeys(v)) as unknown as T
  }
  if (
    obj !== null &&
    typeof obj === 'object' &&
    (obj as object).constructor === Object
  ) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      const ck = snakeToCamel(k)
      // Passthrough keys: camelize the key itself (no-op for single
      // words) but leave the VALUE untouched. Protects audit-log
      // snapshots, Checkr report shapes, free-form metadata, etc.
      out[ck] = isPassthroughKey(k) ? v : camelizeKeys(v)
    }
    return out as unknown as T
  }
  return obj
}

// ============================================================
// Axios response interceptor helper.
//
// Standard GAM response wrapper is `{ success, data, message }`.
// We camelize only the inner `data` payload — the wrapper keys
// are already single words. Endpoints that don't follow the
// wrapper convention (raw array / raw object responses) get
// transformed at the top level.
//
// Usage in each portal:
//
//   import { applyCamelizeInterceptor } from '@gam/shared'
//   applyCamelizeInterceptor(api)
//
// ============================================================

// The signature loosely matches axios's AxiosInstance.interceptors.response.use
// without taking a hard dependency on the axios types in packages/shared.
// We accept `any` here to stay structurally compatible across axios versions.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function applyCamelizeInterceptor(api: any): void {
  api.interceptors.response.use((response: { data: unknown }) => {
    const body = response.data
    if (body !== null && typeof body === 'object') {
      const wrapper = body as Record<string, unknown>
      // Detect the standard GAM success wrapper by the `success` key
      // (more specific than `data` alone — some non-wrapper endpoints
      // legitimately return objects with a `data` field meaning
      // something else). Wrapper keys themselves (success, data,
      // message) are already single words; we only transform the
      // inner payload.
      if ('success' in wrapper) {
        wrapper.data = camelizeKeys(wrapper.data)
      } else {
        response.data = camelizeKeys(body)
      }
    }
    return response
  })
}

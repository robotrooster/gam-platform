/**
 * S312 transformer — the load-bearing axios response interceptor that
 * lets every frontend portal read API responses as camelCase while the
 * API returns raw snake_case from Postgres. Three pieces under test:
 *
 *   1. snakeToCamel — string-level helper.
 *   2. camelizeKeys — recursive plain-object key transform with two
 *      passthrough escape hatches (exact-name set + suffix patterns)
 *      that protect JSONB blob values from getting their inner keys
 *      mangled.
 *   3. applyCamelizeInterceptor — axios wiring that detects the
 *      `{ success, data, message }` wrapper and transforms only the
 *      inner data payload (or whole-body when the wrapper isn't there).
 *
 * No DB, no IO. Pure unit tests. Tests live in apps/api/src/lib/ since
 * packages/shared doesn't have its own vitest setup yet.
 */

import { describe, it, expect, vi } from 'vitest'
import { snakeToCamel, camelizeKeys, applyCamelizeInterceptor } from '@gam/shared'

describe('snakeToCamel', () => {
  it('converts simple snake_case → camelCase', () => {
    expect(snakeToCamel('hello_world')).toBe('helloWorld')
  })

  it('handles single-segment input unchanged', () => {
    expect(snakeToCamel('already')).toBe('already')
  })

  it('handles two-letter segments', () => {
    expect(snakeToCamel('a_b')).toBe('aB')
  })

  it('chains multiple segments', () => {
    expect(snakeToCamel('a_b_c_d')).toBe('aBCD')
  })

  it('uppercases the first letter of each segment after underscore', () => {
    expect(snakeToCamel('stripe_customer_id')).toBe('stripeCustomerId')
  })

  it('treats digits as valid segment-leaders', () => {
    expect(snakeToCamel('bank_last4')).toBe('bankLast4')
    expect(snakeToCamel('account_v2_status')).toBe('accountV2Status')
  })

  it('returns empty string unchanged', () => {
    expect(snakeToCamel('')).toBe('')
  })
})

describe('camelizeKeys — primitives + non-object values', () => {
  it('passes null through unchanged', () => {
    expect(camelizeKeys(null)).toBe(null)
  })

  it('passes undefined through unchanged', () => {
    expect(camelizeKeys(undefined)).toBe(undefined)
  })

  it('passes numbers unchanged', () => {
    expect(camelizeKeys(42)).toBe(42)
  })

  it('passes strings unchanged (no key-level transform)', () => {
    expect(camelizeKeys('hello_world')).toBe('hello_world')
  })

  it('passes booleans unchanged', () => {
    expect(camelizeKeys(true)).toBe(true)
  })

  it('passes Date instances unchanged (constructor !== Object)', () => {
    const d = new Date('2026-05-20')
    expect(camelizeKeys(d)).toBe(d)
  })

  it('passes Map instances unchanged (constructor !== Object)', () => {
    const m = new Map([['some_key', 1]])
    expect(camelizeKeys(m)).toBe(m)
  })
})

describe('camelizeKeys — plain objects', () => {
  it('camelizes flat snake_case keys', () => {
    expect(camelizeKeys({ first_name: 'Nic', last_name: 'R' }))
      .toEqual({ firstName: 'Nic', lastName: 'R' })
  })

  it('is idempotent on already-camelCase keys', () => {
    expect(camelizeKeys({ firstName: 'Nic' }))
      .toEqual({ firstName: 'Nic' })
  })

  it('handles mixed snake + camel + single-word', () => {
    expect(camelizeKeys({ first_name: 'Nic', firstName: 'X', email: 'a@b' }))
      .toEqual({ firstName: 'X', email: 'a@b' })  // snake overwritten by later camel-key
  })

  it('recurses into nested objects', () => {
    expect(camelizeKeys({ user: { first_name: 'Nic' } }))
      .toEqual({ user: { firstName: 'Nic' } })
  })

  it('passes empty object through', () => {
    expect(camelizeKeys({})).toEqual({})
  })
})

describe('camelizeKeys — arrays', () => {
  it('recurses into array of plain objects', () => {
    expect(camelizeKeys([{ unit_id: 'a' }, { unit_id: 'b' }]))
      .toEqual([{ unitId: 'a' }, { unitId: 'b' }])
  })

  it('leaves array of primitives untouched', () => {
    expect(camelizeKeys([1, 'two', true, null])).toEqual([1, 'two', true, null])
  })

  it('passes empty array through', () => {
    expect(camelizeKeys([])).toEqual([])
  })

  it('handles deeply nested arrays inside objects', () => {
    const input = { rows: [{ row_id: 1, line_items: [{ item_id: 'a' }] }] }
    expect(camelizeKeys(input))
      .toEqual({ rows: [{ rowId: 1, lineItems: [{ itemId: 'a' }] }] })
  })
})

describe('camelizeKeys — JSONB passthrough (exact keys)', () => {
  // The passthrough rule camelizes the KEY but leaves the VALUE
  // verbatim. `metadata` is a single word so its key is unchanged;
  // the protection is that the inner snake_case keys don't get
  // recursively transformed.

  it('metadata value: inner keys NOT camelized', () => {
    const input  = { metadata: { custom_field: 1, another_one: 'x' } }
    const output = camelizeKeys(input) as any
    expect(output.metadata).toEqual({ custom_field: 1, another_one: 'x' })
  })

  it('data wrapper key: inner keys NOT camelized (covers JSONB columns named "data")', () => {
    // notifications.data carries snake_case keys from emitter code paths
    // like { inspection_id, entry_request_id } — those must survive.
    const input  = { id: 'n1', data: { inspection_id: 'i1', entry_request_id: 'e2' } }
    const output = camelizeKeys(input) as any
    expect(output).toEqual({ id: 'n1', data: { inspection_id: 'i1', entry_request_id: 'e2' } })
  })

  it('permissions value: inner snake keys NOT camelized', () => {
    const input  = { user_id: 'u1', permissions: { pos_ring_sale: true, units_create: false } }
    const output = camelizeKeys(input) as any
    expect(output.userId).toBe('u1')
    expect(output.permissions).toEqual({ pos_ring_sale: true, units_create: false })
  })

  it('gam_supersedence_breakdown: key is camelized, value preserved', () => {
    const input  = { gam_supersedence_breakdown: { custody_charge: 100, flexpay_advance: 50 } }
    const output = camelizeKeys(input) as any
    expect(output.gamSupersedenceBreakdown).toEqual({ custody_charge: 100, flexpay_advance: 50 })
  })

  it('definition value (credit_score_formulas spec): preserved', () => {
    const input  = { id: 'f1', definition: { weights: { on_time_pay: 1.05 } } }
    const output = camelizeKeys(input) as any
    expect(output.definition).toEqual({ weights: { on_time_pay: 1.05 } })
  })

  it('items (pos_refunds / purchase_requests): preserved', () => {
    const input  = { items: [{ item_id: 'a', qty_refunded: 1 }] }
    const output = camelizeKeys(input) as any
    expect(output.items).toEqual([{ item_id: 'a', qty_refunded: 1 }])
  })

  it('due_dates (state_tax_forms): preserved', () => {
    const input  = { state_code: 'CA', due_dates: { q1_filing: '2026-04-30' } }
    const output = camelizeKeys(input) as any
    expect(output.stateCode).toBe('CA')
    expect(output.dueDates).toEqual({ q1_filing: '2026-04-30' })
  })

  it('column_headers, sample_rows, parser_flags (CSV import JSONB): preserved', () => {
    const input = {
      column_headers: ['Tenant Name', 'Unit #'],
      sample_rows:    [{ tenant_name: 'Alice' }],
      parser_flags:   [{ category: 'identity_mismatch', severity: 'block' }],
    }
    const output = camelizeKeys(input) as any
    expect(output.columnHeaders).toEqual(['Tenant Name', 'Unit #'])
    expect(output.sampleRows).toEqual([{ tenant_name: 'Alice' }])
    expect(output.parserFlags).toEqual([{ category: 'identity_mismatch', severity: 'block' }])
  })
})

describe('camelizeKeys — JSONB passthrough (suffix patterns)', () => {
  it('_data suffix: disputed_event_data is treated as JSONB (aliased credit_events.event_data)', () => {
    const input  = { disputed_event_data: { event_type: 'payment_received_late_major', amount_cents: 5000 } }
    const output = camelizeKeys(input) as any
    expect(output.disputedEventData).toEqual({ event_type: 'payment_received_late_major', amount_cents: 5000 })
  })

  it('_metadata suffix: arbitrary *_metadata column preserved', () => {
    const input  = { request_metadata: { ip_address: '1.1.1.1', user_agent: 'curl' } }
    const output = camelizeKeys(input) as any
    expect(output.requestMetadata).toEqual({ ip_address: '1.1.1.1', user_agent: 'curl' })
  })

  it('_payload suffix preserved', () => {
    const input  = { webhook_payload: { event_type: 'charge.succeeded' } }
    const output = camelizeKeys(input) as any
    expect(output.webhookPayload).toEqual({ event_type: 'charge.succeeded' })
  })

  it('_evidence suffix preserved', () => {
    const input  = { attestation_evidence: { uploaded_at: '2026-05-20' } }
    const output = camelizeKeys(input) as any
    // attestation_evidence is also in the exact-list — covered by either rule
    expect(output.attestationEvidence).toEqual({ uploaded_at: '2026-05-20' })
  })

  it('_breakdown suffix preserved', () => {
    const input  = { fee_breakdown: { ach_fee: 6, gam_cut: 3 } }
    const output = camelizeKeys(input) as any
    expect(output.feeBreakdown).toEqual({ ach_fee: 6, gam_cut: 3 })
  })

  it('_stats suffix preserved (covers credit_stats JSONB columns)', () => {
    const input  = { custom_stats: { lifetime_paid: 12, on_time_count: 11 } }
    const output = camelizeKeys(input) as any
    expect(output.customStats).toEqual({ lifetime_paid: 12, on_time_count: 11 })
  })

  it('_value suffix preserved (covers old_value / new_value audit snapshots)', () => {
    const input  = { snapshot_value: { lease_id: 'L1', rent_amount: 1500 } }
    const output = camelizeKeys(input) as any
    expect(output.snapshotValue).toEqual({ lease_id: 'L1', rent_amount: 1500 })
  })

  it('_attestation suffix preserved', () => {
    const input  = { external_attestation: { source: 'plaid', verified_at: '2026-05-20' } }
    const output = camelizeKeys(input) as any
    expect(output.externalAttestation).toEqual({ source: 'plaid', verified_at: '2026-05-20' })
  })

  it('passthrough applies recursively — JSONB nested inside a regular object', () => {
    const input = {
      user_id: 'u1',
      audit_log: { event_data: { changed_field: 'rent_amount', old_amount: 1500 } },
    }
    const output = camelizeKeys(input) as any
    expect(output.userId).toBe('u1')
    // audit_log isn't a passthrough key, so its value gets camelized
    // — but event_data IS, so its inner keys stay snake.
    expect(output.auditLog).toEqual({ eventData: { changed_field: 'rent_amount', old_amount: 1500 } })
  })

  it('non-matching key falls through to recursive camelization', () => {
    const input  = { random_other_field: { inner_key: 1 } }
    const output = camelizeKeys(input) as any
    expect(output).toEqual({ randomOtherField: { innerKey: 1 } })
  })
})

describe('applyCamelizeInterceptor — wrapper detection', () => {
  // Capture the interceptor callback by passing a fake axios instance.
  function fakeApi(): { use: ReturnType<typeof vi.fn>; getInterceptor: () => (r: any) => any } {
    const use = vi.fn()
    return {
      use,
      getInterceptor: () => use.mock.calls[0][0],
    }
  }

  it('transforms inner data when wrapper has `success` key', () => {
    const fake = fakeApi()
    applyCamelizeInterceptor({ interceptors: { response: { use: fake.use } } })
    const fn = fake.getInterceptor()
    const response = { data: { success: true, data: { user_id: 'u1', first_name: 'Nic' } } }
    const out = fn(response)
    expect(out.data).toEqual({
      success: true,
      data:    { userId: 'u1', firstName: 'Nic' },
    })
  })

  it('transforms whole body when wrapper key `success` is absent (raw object response)', () => {
    const fake = fakeApi()
    applyCamelizeInterceptor({ interceptors: { response: { use: fake.use } } })
    const fn = fake.getInterceptor()
    const response = { data: { user_id: 'u1' } }
    const out = fn(response)
    expect(out.data).toEqual({ userId: 'u1' })
  })

  it('transforms whole body when response is a raw array', () => {
    const fake = fakeApi()
    applyCamelizeInterceptor({ interceptors: { response: { use: fake.use } } })
    const fn = fake.getInterceptor()
    const response = { data: [{ unit_id: 'a' }, { unit_id: 'b' }] }
    const out = fn(response)
    expect(out.data).toEqual([{ unitId: 'a' }, { unitId: 'b' }])
  })

  it('leaves null body untouched', () => {
    const fake = fakeApi()
    applyCamelizeInterceptor({ interceptors: { response: { use: fake.use } } })
    const fn = fake.getInterceptor()
    const response = { data: null }
    const out = fn(response)
    expect(out.data).toBe(null)
  })

  it('leaves string body untouched', () => {
    const fake = fakeApi()
    applyCamelizeInterceptor({ interceptors: { response: { use: fake.use } } })
    const fn = fake.getInterceptor()
    const response = { data: 'OK' }
    const out = fn(response)
    expect(out.data).toBe('OK')
  })

  it('detects wrapper by presence of `success` key, not truthiness (error wrappers still get camelized)', () => {
    const fake = fakeApi()
    applyCamelizeInterceptor({ interceptors: { response: { use: fake.use } } })
    const fn = fake.getInterceptor()
    const response = { data: { success: false, data: { failed_at: '2026-05-20' }, message: 'oops' } }
    const out = fn(response)
    expect(out.data).toEqual({
      success: false,
      data:    { failedAt: '2026-05-20' },
      message: 'oops',
    })
  })

  it('respects JSONB passthrough inside the wrapper-detected inner data', () => {
    const fake = fakeApi()
    applyCamelizeInterceptor({ interceptors: { response: { use: fake.use } } })
    const fn = fake.getInterceptor()
    const response = {
      data: {
        success: true,
        data: {
          id:       'n1',
          read_at:  '2026-05-20',
          data:     { inspection_id: 'i1' },  // JSONB passthrough column
        },
      },
    }
    const out = fn(response)
    expect(out.data.data).toEqual({
      id:     'n1',
      readAt: '2026-05-20',
      data:   { inspection_id: 'i1' },
    })
  })

  it('handles raw-object responses with JSONB passthrough columns at top level', () => {
    const fake = fakeApi()
    applyCamelizeInterceptor({ interceptors: { response: { use: fake.use } } })
    const fn = fake.getInterceptor()
    const response = { data: { user_id: 'u1', metadata: { custom_field: 1 } } }
    const out = fn(response)
    expect(out.data).toEqual({
      userId:   'u1',
      metadata: { custom_field: 1 },
    })
  })

  it('wrapper detection: object that legitimately has a `data` field BUT no `success` is treated as raw', () => {
    // Some non-wrapper endpoints return an object with `data` as a
    // domain field (e.g. notifications.data JSONB rendered at the
    // top level). Detection by `success` is the load-bearing rule.
    const fake = fakeApi()
    applyCamelizeInterceptor({ interceptors: { response: { use: fake.use } } })
    const fn = fake.getInterceptor()
    const response = { data: { id: 'n1', data: { inspection_id: 'i1' } } }
    const out = fn(response)
    // Top-level keys camelized; `data` value preserved per passthrough.
    expect(out.data).toEqual({ id: 'n1', data: { inspection_id: 'i1' } })
  })
})

import { describe, it, expect } from 'vitest'
import { camelCaseKeys } from './caseConversion'

// camelCaseKeys is the load-bearing GLOBAL response transform: the API returns
// snake_case in res.json() bodies and this camelizes EVERYTHING (no passthrough)
// before the frontend sees it. A regression here silently breaks every portal,
// so pin its contract. (Converted S555 from a standalone process.exit script
// that vitest excluded → it now runs with the suite.)

const cases: Array<{ name: string; input: any; expect: any }> = [
  { name: 'null',             input: null,                                             expect: null },
  { name: 'undefined',        input: undefined,                                        expect: undefined },
  { name: 'string',           input: 'hello_world',                                    expect: 'hello_world' },
  { name: 'number',           input: 42,                                               expect: 42 },
  { name: 'boolean',          input: true,                                             expect: true },
  { name: 'flat object',      input: { first_name: 'Nic', last_name: 'R' },            expect: { firstName: 'Nic', lastName: 'R' } },
  { name: 'already camel',    input: { firstName: 'Nic' },                             expect: { firstName: 'Nic' } },
  { name: 'mixed',            input: { first_name: 'Nic', email: 'x@y.com' },          expect: { firstName: 'Nic', email: 'x@y.com' } },
  { name: 'nested object',    input: { user: { first_name: 'Nic', last_name: 'R' } }, expect: { user: { firstName: 'Nic', lastName: 'R' } } },
  { name: 'array of obj',     input: [{ unit_id: 'a' }, { unit_id: 'b' }],             expect: [{ unitId: 'a' }, { unitId: 'b' }] },
  { name: 'array of prim',    input: [1, 2, 3],                                        expect: [1, 2, 3] },
  { name: 'empty object',     input: {},                                               expect: {} },
  { name: 'empty array',      input: [],                                               expect: [] },
  { name: 'deep nest',        input: { a_b: { c_d: { e_f: 1 } } },                     expect: { aB: { cD: { eF: 1 } } } },
  { name: 'multi underscore', input: { stripe_customer_id: 'cus_1' },                  expect: { stripeCustomerId: 'cus_1' } },
  { name: 'with digits',      input: { bank_last4: '1234' },                           expect: { bankLast4: '1234' } },
]

describe('camelCaseKeys', () => {
  for (const c of cases) {
    it(`converts: ${c.name}`, () => {
      expect(camelCaseKeys(c.input)).toEqual(c.expect)
    })
  }

  it('preserves Date instances by reference (does not recurse into them)', () => {
    const d = new Date()
    const out: any = camelCaseKeys({ created_at: d })
    expect(out.createdAt).toBe(d)
  })

  it('preserves Buffer instances by reference', () => {
    const b = Buffer.from('hi')
    const out: any = camelCaseKeys({ raw_data: b })
    expect(out.rawData).toBe(b)
  })

  it('does not mutate its input', () => {
    const orig = { first_name: 'Nic' }
    const origCopy = JSON.parse(JSON.stringify(orig))
    camelCaseKeys(orig)
    expect(orig).toEqual(origCopy)
  })
})

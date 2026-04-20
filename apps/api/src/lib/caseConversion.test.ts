import { camelCaseKeys } from './caseConversion'

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

let pass = 0
let fail = 0

for (const c of cases) {
  const got = camelCaseKeys(c.input)
  const match = JSON.stringify(got) === JSON.stringify(c.expect)
  if (match) { pass++ }
  else { fail++; console.log('FAIL:', c.name, '| got:', JSON.stringify(got), '| expected:', JSON.stringify(c.expect)) }
}

const d = new Date()
const dOut: any = camelCaseKeys({ created_at: d })
if (dOut.createdAt === d) pass++
else { fail++; console.log('FAIL: Date not preserved') }

const b = Buffer.from('hi')
const bOut: any = camelCaseKeys({ raw_data: b })
if (bOut.rawData === b) pass++
else { fail++; console.log('FAIL: Buffer not preserved') }

const orig = { first_name: 'Nic' }
const origCopy = JSON.parse(JSON.stringify(orig))
camelCaseKeys(orig)
const notMutated = JSON.stringify(orig) === JSON.stringify(origCopy)
if (notMutated) pass++
else { fail++; console.log('FAIL: input was mutated') }

console.log('RESULT: ' + pass + ' passed, ' + fail + ' failed')
if (fail > 0) process.exit(1)

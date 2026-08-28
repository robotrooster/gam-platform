#!/usr/bin/env node
/** S628 — every endpoint the agent deliberately will not reach, as JSON. */
require('ts-node').register({ transpileOnly: true, compilerOptions: { module: 'commonjs' } })
const { computeActionGap } = require('../src/services/agents/actionGap')
const g = computeActionGap()
console.log(JSON.stringify(g.deliberate.map((e) => ({
  area: e.area,
  method: e.method,
  path: e.declared.split(' ').slice(1).join(' '),
  why: e.why,
})), null, 1))

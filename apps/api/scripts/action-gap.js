#!/usr/bin/env node
/**
 * CLI over src/services/agents/actionGap.ts.
 *
 *   node apps/api/scripts/action-gap.js          # summary
 *   node apps/api/scripts/action-gap.js units    # every open endpoint in one area
 *
 * The measurement lives in the module rather than here because actionGap.test.ts
 * asserts on it: the open count is zero, and a new mutating endpoint has to be
 * either given an agent action or named in DELIBERATE with a reason. A number
 * nothing asserts drifts back the moment somebody adds a route.
 */
require('ts-node').register({ transpileOnly: true, compilerOptions: { module: 'commonjs' } })
const { computeActionGap, reasonFor } = require('../src/services/agents/actionGap')

const g = computeActionGap()

if (g.missingTools.length) {
  console.error(`\n!! HAND_BUILT names no tool defines: ${g.missingTools.join(', ')}`)
  console.error('   Fix the map in actionGap.ts — until then the count below is too generous.\n')
}

const only = process.argv[2]
if (only) {
  const rows = g.open.filter((e) => e.area === only)
  console.log(`\n${only}: ${rows.length} endpoints with no agent action\n`)
  for (const e of rows) console.log(`  ${e.declared}`)
  const d = g.deliberate.filter((e) => e.area === only)
  if (d.length) {
    console.log(`\n${only}: deliberately not agent actions`)
    for (const e of d) console.log(`  ${e.declared}\n      ${e.why}`)
  }
  const c = g.covered.filter((e) => e.area === only)
  if (c.length) {
    console.log(`\n${only}: ${c.length} the agent can already do`)
    for (const e of c) console.log(`  ${e.declared}`)
  }
  console.log()
  process.exit(0)
}

const byArea = (list) => {
  const m = {}
  for (const e of list) m[e.area] = (m[e.area] || 0) + 1
  return Object.entries(m).sort((a, b) => b[1] - a[1])
}

console.log(`\n${g.all.length} mutating endpoints a landlord or tenant agent could reach`)
console.log(`${g.covered.length} have an agent action`)
console.log(`${g.deliberate.length} are deliberately not agent actions`)
console.log(`${g.open.length} still have none\n`)
console.log('STILL OPEN, biggest first —  node scripts/action-gap.js <area>  for the list:')
const open = byArea(g.open)
if (!open.length) console.log('  (none)')
for (const [a, n] of open) console.log(`  ${String(n).padStart(3)}  ${a}`)
console.log('\nDELIBERATELY NOT AGENT ACTIONS — do not "close" these:')
for (const [a, n] of byArea(g.deliberate)) console.log(`  ${String(n).padStart(3)}  ${a}`)
console.log()

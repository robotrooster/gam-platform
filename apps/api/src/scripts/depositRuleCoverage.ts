// S642: the 50-state deposit-rule sweep, run against the REAL database.
// Lives as a script, not a vitest test: this data is seeded by migrations and
// the test database is a schema-only dump, so no reference data exists there.
import { db } from '../db'
const ALL = ['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY']
const KNOWN_OPEN: Record<string,string[]> = { rv_spot: ['CA','RI'] }
;(async () => {
  let bad = 0
  for (const ut of ['apartment','single_family','mobile_home','rv_spot']) {
    const { rows } = await db.query<{ s: string }>(
      `SELECT DISTINCT state_code AS s FROM state_deposit_interest_rates
        WHERE effective_year=2026 AND ($1 = ANY(unit_types) OR cardinality(unit_types)=0)`, [ut])
    const have = new Set(rows.map(r => r.s))
    const missing = ALL.filter(s => !have.has(s))
    const expected = KNOWN_OPEN[ut] ?? []
    const unexpected = missing.filter(s => !expected.includes(s))
    const resolved = expected.filter(s => have.has(s))
    console.log(`${ut.padEnd(14)} missing: ${missing.join(' ') || '(none)'}`)
    if (unexpected.length) { console.log(`   ✗ NEW GAP: ${unexpected.join(' ')}`); bad++ }
    if (resolved.length)   { console.log(`   ✓ now resolved (update KNOWN_OPEN): ${resolved.join(' ')}`) }
  }
  const { rows: nocite } = await db.query<{ n: string }>(
    `SELECT COUNT(*)::text n FROM state_deposit_interest_rates
      WHERE effective_year=2026 AND COALESCE(TRIM(statute_citation),'')=''`)
  if (Number(nocite[0].n) > 0) { console.log(`   ✗ ${nocite[0].n} rule(s) with no citation`); bad++ }
  // S642: custody reach, so the FBO account's value is a number rather than a
  // feeling. 'blocked' hid three different obstacles behind one word.
  const { rows: cust } = await db.query<{ reason: string; n: string; states: string }>(
    `SELECT COALESCE(blocked_reason, custody_status) AS reason,
            COUNT(*)::text AS n,
            string_agg(state_code, ',' ORDER BY state_code) AS states
       FROM state_deposit_custody_rules GROUP BY 1 ORDER BY 2 DESC`)
  console.log('\ncustody reach')
  for (const c of cust) console.log(`  ${c.reason.padEnd(22)} ${String(c.n).padStart(2)}  ${c.states}`)
  const supported = Number(cust.find(c => c.reason === 'supported')?.n ?? 0)
  const fbo = Number(cust.find(c => c.reason === 'vehicle_unconfirmed')?.n ?? 0)
  console.log(`  → ${supported} today; ${supported + fbo} once a federally-insured FBO is confirmed`)

  console.log(bad ? `\nFAIL — ${bad} problem(s)` : '\nOK — coverage matches the S642 sweep')
  process.exit(bad ? 1 : 0)
})().catch(e => { console.error(e); process.exit(1) })

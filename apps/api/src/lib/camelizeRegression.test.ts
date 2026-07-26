/**
 * S554 — camelize contract regression guard.
 *
 * ROOT CAUSE of a whole bug class swept in S554: the API returns snake_case in
 * res.json() bodies, and EVERY response is camelized before the frontend sees
 * it — first by the global middleware (apps/api/src/index.ts → camelCaseKeys,
 * NO passthrough) and again by each portal's axios interceptor
 * (@gam/shared applyCamelizeInterceptor). So any frontend code that DOT-READS a
 * multi-word response field in snake_case gets `undefined` → a blank value, a
 * dead button, a never-true conditional. It is SILENT (no error).
 *
 * We do NOT rewrite the response contract here (that's a blast-radius-everywhere
 * money-path migration — see SESSION_554_HANDOFF.md). Instead this test PINS the
 * fixes: it fails if any of the exact snake_case response-reads that bit us
 * reappears in a portal's source. Dot-access (`.field_name`) is matched
 * specifically — request BODIES construct snake keys as object literals
 * (`{ field_name: ... }`), which this does not flag.
 *
 * When you add a field, read it camelCase on the frontend. If you truly must
 * read a snake_case blob (a jsonb passthrough), add an inline
 * `// camelize-ok: <reason>` on that line and it's skipped.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'

const PORTAL_ROOTS = ['landlord', 'tenant', 'admin', 'admin-ops', 'pos']
  .map(a => join(__dirname, '..', '..', '..', a, 'src'))

// Exact snake_case response-reads that were bugs. Read the camelCase form.
const FORBIDDEN_READS = [
  '.state_law_warnings',
  '.refund_amount',
  '.completedPdfUrl',        // wrong field entirely — the column is executed_pdf_url → executedPdfUrl
  '.landlord_signer_status',
  '.outside_typical_hours',
  '.typical_hours_warning',
  '.inspection_id',
  '.entry_request_id',
  '.dispute_id',
  '.client_secret',
  '.bank_last4',
  '.tenant_count',
  '.escalated_count',
  '.avg_latency_ms',
  '.by_outcome',
  '.by_agent',
  '.by_tool',
  ".my_vote", ".can_vote", ".can_flag",
]

function walk(dir: string): string[] {
  let out: string[] = []
  let entries: string[]
  try { entries = readdirSync(dir) } catch { return out }
  for (const e of entries) {
    const p = join(dir, e)
    const s = statSync(p)
    if (s.isDirectory()) { if (e !== 'node_modules' && e !== 'dist') out = out.concat(walk(p)) }
    else if (/\.(tsx?|jsx?)$/.test(e)) out.push(p)
  }
  return out
}

describe('camelize contract — no snake_case response-reads in the portals', () => {
  it('none of the S554-fixed snake_case reads have regressed', () => {
    const offenders: string[] = []
    for (const root of PORTAL_ROOTS) {
      for (const file of walk(root)) {
        const lines = readFileSync(file, 'utf8').split('\n')
        lines.forEach((line, i) => {
          if (line.includes('camelize-ok')) return
          for (const bad of FORBIDDEN_READS) {
            if (line.includes(bad)) offenders.push(`${file.split('/apps/')[1]}:${i + 1}  ${bad.trim()}`)
          }
        })
      }
    }
    expect(offenders, `snake_case response-reads found (read camelCase instead):\n${offenders.join('\n')}`).toEqual([])
  })
})

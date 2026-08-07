/**
 * S583 — wire-contract scanner (frontend camelCase guard).
 *
 * WHY THIS EXISTS: the API wraps every response in `camelCaseKeys` (global
 * middleware, index.ts), so the wire format frontends see is camelCase — DB
 * columns stay snake_case. A frontend that reads `x.due_date` / `x.question_type`
 * therefore gets `undefined` in production. Route tests build bare apps WITHOUT
 * the camelize middleware, so they assert snake_case and pass while the real app
 * is broken (see `gam-camelize-wire-contract-test-gap`). Three such bugs shipped
 * silently to the tenant portal (S583) — one made multiple-choice surveys
 * unanswerable.
 *
 * This scanner finds `obj.snake_case` / `obj?.snake_case` member reads in a
 * frontend app's source — the shape of that bug. `wireContract.test.ts` runs it
 * against every portal and fails if an app grows past its recorded baseline, so a
 * NEW snake_case read is caught the moment it's added.
 *
 * A legitimate snake_case read (a Stripe.js SDK object, a local constant map
 * keyed by snake identifiers, an enum VALUE) is annotated with a `wire-ok`
 * comment on the same line and is not counted.
 */
import fs from 'fs'
import path from 'path'

// Object identifiers that are NOT GAM API responses. Stripe.js SDK objects are
// natively snake_case (they never pass through GAM's camelize), so reading e.g.
// `setupIntent.payment_method` is correct.
const IGNORE_OBJ = new Set(['setupIntent', 'paymentIntent'])

// obj.snake  OR  obj?.snake  where snake has at least one internal underscore.
const MEMBER = /([A-Za-z_$][A-Za-z0-9_$]*)\??\.([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/g

function listFiles(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (!['node_modules', 'dist', '.vite', 'assets'].includes(e.name)) out.push(...listFiles(p))
    } else if (/\.(ts|tsx)$/.test(e.name) && !/\.d\.ts$/.test(e.name)) {
      out.push(p)
    }
  }
  return out
}

export function scanApp(appsDir: string, appName: string): { count: number; hits: string[] } {
  const src = path.join(appsDir, appName, 'src')
  if (!fs.existsSync(src)) return { count: 0, hits: [] }
  const hits: string[] = []
  for (const file of listFiles(src)) {
    const lines = fs.readFileSync(file, 'utf8').split('\n')
    let inBlock = false
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i]
      let code = raw
      // strip block comments (may span lines) so commented-out code isn't counted
      if (inBlock) {
        const end = code.indexOf('*/')
        if (end === -1) continue
        code = code.slice(end + 2)
        inBlock = false
      }
      code = code.replace(/\/\*.*?\*\//g, '')
      const openBlock = code.indexOf('/*')
      if (openBlock !== -1) { inBlock = true; code = code.slice(0, openBlock) }
      const lineComment = code.indexOf('//')
      if (lineComment !== -1) code = code.slice(0, lineComment)
      // Strip single/double-quoted string literals — a dotted permission key
      // like `can('units.manage_lifecycle')` is a STRING arg, not a member read.
      // Template literals are left intact so a real `${row.due_date}` still counts.
      code = code.replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""')

      if (/\bwire-ok\b/.test(raw)) continue                       // explicit allow
      if (/^\s*(import|export)\b/.test(code) && /\bfrom\b/.test(code)) continue
      if (code.includes('import.meta')) continue

      let m: RegExpExecArray | null
      MEMBER.lastIndex = 0
      while ((m = MEMBER.exec(code))) {
        const obj = m[1], prop = m[2]
        if (IGNORE_OBJ.has(obj)) continue
        if (prop.endsWith('_url') || prop.endsWith('_URL')) continue  // env/config, not wire
        hits.push(`${path.relative(appsDir, file)}:${i + 1}  ${obj}.${prop}`)
      }
    }
  }
  return { count: hits.length, hits }
}

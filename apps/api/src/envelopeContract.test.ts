/**
 * S622 — response-envelope guard.
 *
 * Every portal's api.ts is INCONSISTENT by design-drift: the GET/PATCH/PUT
 * helpers return `r.data.data` (the payload, envelope stripped) while
 * POST/DELETE return `r.data` (the whole `{ success, data }` envelope). Both
 * shapes are therefore live and correct in their own lane, and reading one the
 * other's way yields `undefined` — silently, with no type error, because every
 * one of these call sites is typed `any`.
 *
 * That is not hypothetical. The e-sign auto-place poller read
 * `s?.data?.status` off an `apiGet`, so `status` was `undefined` on every pass.
 * A job that finished correctly in 1m42s — 8 pages, 69 fields placed — spun the
 * spinner until the client's 4-minute cap and then threw the whole result away.
 * It looked exactly like a hung model. It was a `.data` too many.
 *
 * This scans for a value returned by apiGet/apiPatch/apiPut being read via
 * `.data`, and fails on any hit. Annotate a genuine case (a payload that really
 * does have its own `data` key) with `// envelope-ok` on that line.
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const APPS_DIR = path.join(__dirname, '..', '..')
const UNWRAPPING = ['apiGet', 'apiPatch', 'apiPut']

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out) }
    else if (/\.tsx?$/.test(e.name)) out.push(p)
  }
  return out
}

function scan(appDir: string): string[] {
  const hits: string[] = []
  for (const file of walk(path.join(appDir, 'src'))) {
    const lines = fs.readFileSync(file, 'utf8').split('\n')
    // Strip line comments before matching — prose ABOUT this bug (including the
    // comments left where it was fixed) is not an instance of it.
    const code = (l: string) => l.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '')
    lines.forEach((raw, i) => {
      if (raw.includes('envelope-ok')) return
      const line = code(raw)
      if (!line.trim()) return
      // inline: (await apiGet(...)).data
      for (const fn of UNWRAPPING) {
        if (new RegExp(`${fn}\\([^)]*\\)\\s*\\)?\\s*\\)?\\s*\\??\\.\\s*data\\b`).test(line)) {
          hits.push(`${path.relative(APPS_DIR, file)}:${i + 1}  ${line.trim()}`)
        }
      }
      // assigned: const x = await apiGet(...)  →  x.data / x?.data within 12 lines
      const m = line.match(
        new RegExp(`(?:const|let|var)\\s+(\\w+)\\s*(?::[^=]+)?=\\s*await\\s+(?:${UNWRAPPING.join('|')})\\(`))
      if (!m) return
      const v = m[1]
      for (let j = i + 1; j < Math.min(i + 12, lines.length); j++) {
        if (lines[j].includes('envelope-ok')) continue
        if (new RegExp(`\\b${v}\\s*\\??\\.\\s*data\\b`).test(code(lines[j]))) {
          hits.push(`${path.relative(APPS_DIR, file)}:${j + 1}  ${lines[j].trim()}`)
        }
      }
    })
  }
  return hits
}

const APPS = fs.readdirSync(APPS_DIR, { withFileTypes: true })
  .filter(e => e.isDirectory() && e.name !== 'api' && e.name !== 'node_modules')
  .map(e => e.name)

describe('response-envelope contract', () => {
  for (const app of APPS) {
    it(`${app}: no apiGet/apiPatch/apiPut result is read through .data`, () => {
      const hits = scan(path.join(APPS_DIR, app))
      expect(hits, `these helpers already strip the envelope — drop the extra .data:\n${hits.join('\n')}`)
        .toEqual([])
    })
  }
})

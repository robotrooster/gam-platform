/**
 * 11/3 — THE UNIT THAT BLANKS A WHOLE PORTAL.
 *
 * Blue could not scroll a single page of the landlord portal. His Chromebook is
 * auto-update-expired and sits on Chrome 103 (the API log: `X11; CrOS x86_64
 * 14816.131.0 ... Chrome/103`); `dvh` arrived in Chrome 108. A unit a browser
 * does not know is not approximated — the whole declaration is DROPPED. So the
 * 10/30 change of `.app-shell` from `height:100vh` to `height:100dvh` left the
 * shell with NO height, it grew past a body that is `height:100%` +
 * `overflow:hidden`, and the browser clipped everything below the fold with no
 * scrollbar anywhere. The sidebar kept scrolling because it is anchored by
 * top/bottom rather than by a height, which is exactly how he described it.
 *
 * The fix is one token per portal — `--vh`, declared in `vh` and upgraded to
 * `dvh` behind `@supports` — so an old engine keeps the height it had before
 * 10/30 while a phone still gets the address-bar-aware one. This test exists so
 * the next person who writes `100dvh` because it is the modern unit finds out
 * here instead of from a landlord who cannot read his own reports.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { describe, it, expect } from 'vitest'

// apps/ — two levels up from apps/landlord/src/styles, the way the Schedule
// colors test reads its own CSS, so the path holds whatever the run root is.
const appsDir = `${import.meta.dirname}/../../../`

/** Every .css/.ts/.tsx under apps/, skipping build output and dependencies. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === 'build' || name.startsWith('.')) continue
    const full = `${dir}/${name}`
    if (statSync(full).isDirectory()) sourceFiles(full, out)
    else if (/\.(css|tsx?)$/.test(name)) out.push(full)
  }
  return out
}

/**
 * The file with every comment blanked out, newlines kept so line numbers still
 * line up. Comments are where this unit is *discussed*, and the discussion is
 * the point of the token — only a real declaration is a finding. `//` is taken
 * as a comment only when it does not follow a colon, so `url(https://…)` on a
 * CSS line does not blank the rest of that line.
 */
function codeOnly(text: string): string {
  let out = ''
  let i = 0
  while (i < text.length) {
    if (text.startsWith('/*', i)) {
      const close = text.indexOf('*/', i + 2)
      const body = text.slice(i, close === -1 ? text.length : close + 2)
      out += body.replace(/[^\n]/g, ' ')
      i += body.length
    } else if (text.startsWith('//', i) && text[i - 1] !== ':') {
      const nl = text.indexOf('\n', i)
      const body = text.slice(i, nl === -1 ? text.length : nl)
      out += body.replace(/[^\n]/g, ' ')
      i += body.length
    } else {
      out += text[i]
      i += 1
    }
  }
  return out
}

/** A dvh length, anywhere but the token's own two lines. */
const BARE_DVH = /\b\d+(?:\.\d+)?dvh\b/

describe('viewport height is never written in dvh alone', () => {
  const files = sourceFiles(appsDir)

  it('reads a real set of source files', () => {
    expect(files.length).toBeGreaterThan(200)
  })

  it('no file uses a dvh length outside the --vh token', () => {
    const offenders: string[] = []
    for (const f of files) {
      const text = readFileSync(f, 'utf8')
      if (!/dvh/.test(text)) continue
      codeOnly(text).split('\n').forEach((line, i) => {
        // The token's own two lines declare the unit on purpose.
        if (/--vh\s*:/.test(line) || /@supports/.test(line)) return
        if (BARE_DVH.test(line)) offenders.push(`${f.slice(appsDir.length)}:${i + 1}  ${line.trim()}`)
      })
    }
    expect(offenders, `write calc(var(--vh) - …) instead:\n${offenders.join('\n')}`).toEqual([])
  })

  it('every portal that uses var(--vh) also declares it', () => {
    const missing: string[] = []
    for (const app of readdirSync(appsDir)) {
      const appPath = `${appsDir}${app}`
      if (!statSync(appPath).isDirectory() || app === 'api' || app.startsWith('.')) continue
      let srcDir: string
      try { srcDir = `${appPath}/src`; statSync(srcDir) } catch { continue }
      const files = sourceFiles(srcDir)
      const uses = files.some(f => /var\(--vh\)/.test(readFileSync(f, 'utf8')))
      if (!uses) continue
      const declares = files.some(f => {
        const t = readFileSync(f, 'utf8')
        return /--vh\s*:\s*100vh/.test(t) && /@supports\s*\(?\s*height:\s*1dvh\s*\)?\s*\{[^}]*--vh\s*:\s*100dvh/.test(t.replace(/\s+/g, ' '))
      })
      if (!declares) missing.push(app)
    }
    expect(missing, `these portals read var(--vh) but never declare it with a vh fallback: ${missing.join(', ')}`).toEqual([])
  })
})

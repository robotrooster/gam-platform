/**
 * S641 — a test run cannot hold a real mail client.
 *
 * Six "New landlord signup — Dusty Rhoades" alerts reached Nic's real inbox
 * from a full-suite run. One test file set EMAIL_SEND_LIVE=1 with no afterEach
 * to clear it; vitest shares a process across files, so the flag leaked, and a
 * later test that mailed a REAL address — the signup alert goes to the platform
 * owner, hardcoded — sent for real.
 *
 * This guard is about the CLASS rather than that one file: a setupFiles hook
 * clears the opt-in after every test in every worker, so forgetting the cleanup
 * inside a file can cost a confusing assertion but never an email.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

describe('a leaked live-mail flag cannot reach the next suite', () => {
  // The structural fix. setupFiles runs in every worker for every file, so the
  // opt-in is cleared after each test whatever any individual file remembers.
  it('the vitest config installs the per-file cleanup hook', () => {
    const cfg = readFileSync(join(__dirname, '..', '..', 'vitest.config.ts'), 'utf8')
    expect(cfg).toContain('setupFiles')
    expect(cfg).toContain('setupEnv')
  })

  it('the hook actually clears the flag', () => {
    const hook = readFileSync(join(__dirname, '..', 'test', 'setupEnv.ts'), 'utf8')
    expect(hook).toContain('afterEach')
    expect(hook).toContain('delete process.env.EMAIL_SEND_LIVE')
  })

  // Belt as well as braces: a file that opts in should still tidy up after
  // itself, so the intent is legible where somebody reads it.
  it('every file that opts into live sending also clears it', () => {
    const dir = join(__dirname, '..')
    const { execSync } = require('child_process')
    const hits: string[] = execSync(
      `grep -rl "EMAIL_SEND_LIVE = '1'" ${dir} --include=*.test.ts || true`,
      { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
    const leaking = hits.filter(f => !readFileSync(f, 'utf8').includes('delete process.env.EMAIL_SEND_LIVE'))
    expect(leaking, `these set EMAIL_SEND_LIVE and never clear it:\n  ${leaking.join('\n  ')}`).toEqual([])
  })

  it('the flag is not set by the time an unrelated file runs', () => {
    expect(process.env.EMAIL_SEND_LIVE).toBeUndefined()
  })
})

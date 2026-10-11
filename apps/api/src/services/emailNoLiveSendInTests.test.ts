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

// ── the archive must accept what the live table allows ─────────────────────
//
// Adding 'suppressed' to email_send_log without widening its ARCHIVE left a
// delayed break: the nightly compliance archiver copies rows across, and the
// first suppressed row to age out would have been refused — weeks later, in a
// cron job, on a table nobody watches. The archive also carried a SECOND check
// named after the live table, inherited when it was created from it, so
// widening the obvious one was not enough.
describe('email_send_log and its archive agree on status', () => {
  it('every status check on both tables accepts suppressed', async () => {
    const { db } = await import('../db')
    const { rows } = await db.query<{ tbl: string; def: string }>(`
      SELECT c.conrelid::regclass::text AS tbl, pg_get_constraintdef(c.oid) AS def
        FROM pg_constraint c
       WHERE c.conrelid IN ('email_send_log'::regclass, 'email_send_log_archive'::regclass)
         AND c.contype = 'c'
         AND pg_get_constraintdef(c.oid) ILIKE '%status%'`)
    expect(rows.length).toBeGreaterThan(0)
    const narrow = rows.filter(r => !r.def.includes('suppressed'))
    expect(narrow, `these still refuse a suppressed row:\n  ${narrow.map(r => r.tbl).join('\n  ')}`)
      .toEqual([])
  })

  it('a suppressed row can actually be archived', async () => {
    const { db } = await import('../db')
    await db.query(
      `INSERT INTO email_send_log_archive (to_email, subject, status)
       VALUES ('archive-probe@mailer-test.co', 'probe', 'suppressed')`)
    const { rows } = await db.query(
      `SELECT status FROM email_send_log_archive WHERE to_email='archive-probe@mailer-test.co'`)
    expect(rows[0].status).toBe('suppressed')
  })
})

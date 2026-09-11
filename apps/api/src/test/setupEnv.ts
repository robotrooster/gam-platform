/**
 * S641 — per-file setup that no test can forget.
 *
 * Six "New landlord signup — Dusty Rhoades" alerts reached Nic's real inbox
 * from a full-suite run. One test file set EMAIL_SEND_LIVE=1 with no cleanup;
 * vitest shares a process across files, so the flag leaked, and a later test
 * that mailed a REAL address — the signup alert goes to the platform owner,
 * hardcoded — sent for real to Resend.
 *
 * Cleaning up inside the offending file fixes that file. This fixes the class:
 * the opt-in is cleared after every single test in every file, so a leak cannot
 * survive long enough to reach a suite that does not mock its mail client. A
 * file that wants live sending sets it in its own beforeEach, which still runs
 * after this hook and before the test.
 */
import { afterEach } from 'vitest'

afterEach(() => {
  delete process.env.EMAIL_SEND_LIVE
})

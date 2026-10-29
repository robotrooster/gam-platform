import { defineConfig } from 'vitest/config'
import { testWorkerCount } from './src/test/testWorkers'

// 10/17 (Nic): "these deploys are taking longer and longer they used to take 10
// or 15 minutes and now they're taking 45 minutes." How many files run at once
// — GAM_TEST_WORKERS, read here and again in globalSetup.ts, which makes one
// database per worker so the files cannot wipe each other's rows. See
// src/test/testWorkers.ts for why there is a ceiling at all.
const WORKERS = testWorkerCount()

export default defineConfig({
  test: {
    // S616: the shared package's own tests were never run by anything. There
    // is no test script in packages/shared and this include covered only
    // apps/api, so paymentAllocation.test.ts — the FIFO math every rent
    // payment goes through — had sat unexecuted. Shared code is the code most
    // worth testing: it is the part two apps depend on at once.
    include: ['src/**/*.test.ts', '../../packages/shared/src/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**'],
    // Hermetic test env. These suites passed on the dev Mac and failed in CI
    // because db/index.ts loads apps/api/.env at import time — the Mac's real
    // RESEND_API_KEY and BANK_ENCRYPTION_KEY leaked into the test process and
    // four files silently depended on them (email.test.ts asserts on a mocked
    // Resend client that is never constructed without a key; bank-account
    // routes 500 without an encryption key). Pin deterministic test values so
    // the suite passes identically on any machine. The dummy Resend key can
    // never send: email.ts only fires real sends in production/EMAIL_SEND_LIVE
    // and the email tests mock the resend module anyway.
    env: {
      RESEND_API_KEY: 're_test_never_sends',
      BANK_ENCRYPTION_KEY: '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',
      // S637's deliverability tests assert which SENDER a message uses; without
      // these the support sender silently falls back to onboarding@resend.dev
      // and the assertions only passed where a real .env supplied them.
      EMAIL_FROM_NOREPLY: 'GAM <noreply@gam.test>',
      EMAIL_FROM_SUPPORT: 'GAM Support <support@gam.test>',
    },
    globalSetup: ['./src/test/globalSetup.ts'],
    // S641: runs in EVERY worker, for every file. Its afterEach clears the
    // live-mail opt-in so one forgetful file cannot leak it into the next suite
    // and put real email on the wire. See src/test/setupEnv.ts.
    setupFiles: ['./src/test/setupEnv.ts'],
    pool: 'forks',
    // 10/17 — PARALLEL, ON ONE DATABASE PER WORKER.
    //
    // This was `singleFork: true` + `fileParallelism: false` because every file
    // shared ONE test database and `beforeEach(cleanupAllSchema)` in one file
    // wipes the rows another is mid-assertion on. globalSetup.ts now gives each
    // worker its own copy of the database and its own working folder, so a file
    // shares a database only with the files that ran before it on the same
    // worker — exactly what it shared when there was one worker.
    //
    // `isolate` stays at its default (on): vitest hands each file a fresh
    // worker process, so nothing a file leaves in module state, a timer or
    // process.env can reach the next file. That is MORE isolation than the one
    // long-lived process had, and it is why the three files that passed alone
    // and failed inside deploy.sh (webhooks, incomeBasisReservationMoney,
    // utilitySpecialRead — 10/15 and 10/16) stop depending on who ran first.
    poolOptions: { forks: { singleFork: WORKERS === 1, minForks: WORKERS, maxForks: WORKERS } },
    fileParallelism: WORKERS > 1,
    testTimeout: 20_000,
    // S397: bumped 60s → 120s. With 80+ test files running sequentially,
    // `beforeEach(cleanupAllSchema)` occasionally hit 60s on full-suite
    // runs (5 flakes in S396 — all 5 passed in isolation). 120s gives
    // 2x headroom without affecting normal-case runs (typical
    // cleanupAllSchema completes in 1-3 seconds).
    hookTimeout: 120_000,
  },
})

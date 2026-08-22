import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // S616: the shared package's own tests were never run by anything. There
    // is no test script in packages/shared and this include covered only
    // apps/api, so paymentAllocation.test.ts — the FIFO math every rent
    // payment goes through — had sat unexecuted. Shared code is the code most
    // worth testing: it is the part two apps depend on at once.
    include: ['src/**/*.test.ts', '../../packages/shared/src/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**'],
    globalSetup: ['./src/test/globalSetup.ts'],
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
    testTimeout: 20_000,
    // S397: bumped 60s → 120s. With 80+ test files running sequentially,
    // `beforeEach(cleanupAllSchema)` occasionally hit 60s on full-suite
    // runs (5 flakes in S396 — all 5 passed in isolation). 120s gives
    // 2x headroom without affecting normal-case runs (typical
    // cleanupAllSchema completes in 1-3 seconds).
    hookTimeout: 120_000,
  },
})

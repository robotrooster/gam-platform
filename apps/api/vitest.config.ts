import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['src/lib/caseConversion.test.ts', 'node_modules/**', 'dist/**'],
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

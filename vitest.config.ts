import { defineConfig } from 'vitest/config'

// S605 (Nic): the suite had no config at all, and two defaults were quietly
// costing us real time.
//
// 1. FILE PARALLELISM vs. ONE SHARED DATABASE.
//    Vitest runs test FILES in parallel workers by default. Every API suite
//    talks to the same `gam_test` database and most call `cleanupAllSchema`,
//    which truncates shared tables between tests. Two suites in flight means
//    one wipes rows the other is mid-assertion on. The failures that produces
//    are non-deterministic and read exactly like real bugs — three times in one
//    session a suite "failed" in a pair and passed alone, and each round-trip
//    cost a diagnosis. Per-worker databases would be the scalable fix; until
//    then, correctness beats wall-clock.
//
// 2. STALE WORKTREE COPIES.
//    `.claude/worktrees/**` holds full checkouts from earlier sessions, each
//    with its own copy of every test file. Vitest happily collected all of
//    them, so an OLD copy of a suite ran against the CURRENT database
//    alongside the real one — the worst version of problem 1, since the stale
//    copy also asserts outdated behaviour. Excluded here so it stops depending
//    on remembering `--exclude` on the command line.
//
// NOTE: the DB_NAME=gam_test guard is deliberately NOT encoded here. It stays
// an explicit part of the command because running the suite against the `gam`
// dev database wipes it, and a default that silently protects you is a default
// someone eventually runs without.
export default defineConfig({
  test: {
    // 3. CONNECTION STARVATION (S652).
    //    The pool defaults to 20 connections PER PROCESS and Postgres allows
    //    100, and every test file gets its own pool that lingers for the 30s
    //    idle timeout after the file finishes. Six files' worth of draining
    //    pools is the whole server, and the suite starts failing with "sorry,
    //    too many clients already" — on whichever files happen to be running,
    //    which reads exactly like a real bug in code that is fine. It cost a
    //    deploy: eight failures across three unrelated files, all of them
    //    passing alone.
    //
    //    The suite runs files sequentially (see 1 above) and tests within a
    //    file sequentially too, so a file has no use for twenty connections.
    //    Five is generous and leaves room for a dozen draining pools.
    env: { DB_POOL_MAX: '5' },
    fileParallelism: false,
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.claude/**',
      '**/cypress/**',
      '**/.{idea,git,cache,output,temp}/**',
    ],
  },
})

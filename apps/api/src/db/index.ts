import path from 'path'
import dotenv from 'dotenv'
import { logger } from '../lib/logger'

// S630: this ran at IMPORT time with a hardcoded absolute path to production's
// .env, which beat index.ts's own dotenv.config() — every import graph reaches
// the pool before line 1 of index.ts executes. So the demo instance, launched
// with GAM_ENV_FILE=.env.demo, still read DB_NAME=gam and would have connected
// the sales-demo API to the PRODUCTION database. Caught by
// validateEnv.assertDemoIsolation() refusing to boot, not by anything here.
//
// GAM_ENV_FILE is honoured first. The default resolves RELATIVE TO THIS FILE
// (src/db → apps/api/.env, and dist/db → the same apps/api/.env once built),
// because launchd starts the service with a cwd that is not guaranteed to be
// apps/api — and a machine-absolute path here once made every other checkout
// silently read no env at all (GCP migration Phase A3). Real environment
// variables always win: dotenv never overrides what the process already has.
dotenv.config({
  path: process.env.GAM_ENV_FILE
    || path.resolve(__dirname, '..', '..', '.env'),
})

import { Pool, PoolClient } from 'pg'

export const db = new Pool({
  // DATABASE_URL wins when set (managed hosts hand out one string). DB_HOST
  // also accepts a unix-socket directory (e.g. Cloud SQL's /cloudsql/<conn>),
  // which node-pg handles natively — no SSL config needed on that path.
  ...(process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL }
    : {
        host:     process.env.DB_HOST     || 'localhost',
        port:     parseInt(process.env.DB_PORT || '5432'),
        database: process.env.DB_NAME     || 'gam',
        user:     process.env.DB_USER     || 'postgres',
        password: process.env.DB_PASSWORD || '',
      }),
  // Env-tunable so the dev team can raise the ceiling for a multi-instance
  // / high-concurrency deployment (front with PgBouncer) without a redeploy.
  // Default 20 preserves prior behavior.
  max:      Number(process.env.DB_POOL_MAX) || 20,
  idleTimeoutMillis:    30000,
  connectionTimeoutMillis: 2000,
  // Opt-in per-connection statement timeout (off by default) so a slow query
  // can't pin a pooled connection indefinitely under load.
  ...(Number(process.env.DB_STATEMENT_TIMEOUT_MS) > 0
    ? { statement_timeout: Number(process.env.DB_STATEMENT_TIMEOUT_MS) }
    : {}),
})

db.on('error', (err) => {
  logger.error({ err: err }, 'Unexpected DB pool error')
})

export async function query<T = any>(sql: string, params?: any[]): Promise<T[]> {
  const { rows } = await db.query(sql, params)
  return rows
}

export async function queryOne<T = any>(sql: string, params?: any[]): Promise<T | null> {
  const rows = await query<T>(sql, params)
  return rows[0] ?? null
}

/**
 * Get a dedicated client from the pool for transactions.
 * CALLER MUST call client.release() in a finally block.
 * Usage:
 *   const client = await getClient()
 *   try {
 *     await client.query('BEGIN')
 *     // ... queries ...
 *     await client.query('COMMIT')
 *   } catch (e) {
 *     await client.query('ROLLBACK')
 *     throw e
 *   } finally {
 *     client.release()
 *   }
 */
export async function getClient(): Promise<PoolClient> {
  return await db.connect()
}

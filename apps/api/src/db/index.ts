import dotenv from 'dotenv'
import { logger } from '../lib/logger'
dotenv.config({ path: '/Users/gold/Downloads/gam/apps/api/.env' })

import { Pool, PoolClient } from 'pg'

export const db = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME     || 'gam',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || '',
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

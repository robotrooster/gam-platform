import dotenv from 'dotenv'
dotenv.config({ path: '/Users/gold/Downloads/gam/apps/api/.env' })

import { Pool, PoolClient } from 'pg'

export const db = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME     || 'gam',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || '',
  max:      20,
  idleTimeoutMillis:    30000,
  connectionTimeoutMillis: 2000,
})

db.on('error', (err) => {
  console.error('Unexpected DB pool error', err)
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

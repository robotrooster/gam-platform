/**
 * Read-only connection to the SEPARATE `gam_properties` database — the property-
 * intelligence parcel corpus (3.4M+ parcels, 2.1M owners, portfolio sales).
 * Kept in its own DB to avoid polluting the operational `gam` DB (per CLAUDE.md);
 * this is a read-only pool so the operational app (and its agents) can query
 * parcel data without a cross-service HTTP hop to property-api.
 *
 * Same Postgres host/credentials as the main pool, different database
 * (PROPERTIES_DB_NAME, default 'gam_properties'). Small pool + a statement
 * timeout so a heavy parcel scan can never pin connections.
 */
import { Pool } from 'pg'
import { logger } from '../lib/logger'

export const propertiesDb = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.PROPERTIES_DB_NAME || 'gam_properties',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
  max: Number(process.env.PROPERTIES_DB_POOL_MAX) || 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
  statement_timeout: Number(process.env.PROPERTIES_DB_STATEMENT_TIMEOUT_MS) || 8000,
})

propertiesDb.on('error', (err) => {
  logger.error({ err }, 'Unexpected gam_properties pool error')
})

/** Read-only query against gam_properties. */
export async function queryProperties<T = any>(sql: string, params?: any[]): Promise<T[]> {
  const { rows } = await propertiesDb.query(sql, params)
  return rows
}

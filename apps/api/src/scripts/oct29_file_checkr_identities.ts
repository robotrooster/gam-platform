/**
 * 10/29 (Nic): "We need to take all the licenses that are uploaded into
 * Checker and run them in our system."
 *
 * Checkr has read a licence for every screening since the ID scan was switched
 * on, and GAM archived every one. This files the ones already in hand into
 * tenant_identifications, where the left-owing matcher can see them.
 *
 * Read-and-write but idempotent: the same card restates rather than stacking.
 */
import { db, getClient } from '../db'
import { fileAllCheckrIdentities } from '../services/checkrIdentity'

;(async () => {
  const c = await getClient()
  try {
    await c.query('BEGIN')
    const out = await fileAllCheckrIdentities(c)
    await c.query('COMMIT')
    console.log(`filed ${out.filed} identification(s) from screenings already taken`)
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e } finally { c.release() }

  const seen = await db.query<{ n: string; with_dob: string; with_number: string }>(
    `SELECT COUNT(*)::text AS n,
            COUNT(*) FILTER (WHERE date_of_birth IS NOT NULL)::text AS with_dob,
            COUNT(*) FILTER (WHERE btrim(id_number) <> '')::text AS with_number
       FROM tenant_identifications WHERE tenant_id IS NOT NULL`)
  console.log('on file now:', seen.rows[0])
  await db.end()
})().catch(e => { console.error(e); process.exit(1) })

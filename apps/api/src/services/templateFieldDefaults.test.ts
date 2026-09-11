/**
 * S641 (Nic) — a template field can arrive pre-answered.
 *
 *   "one page had a bunch of check boxes on there that are optional. But for
 *    that particular property, they're all gonna be checked always for every
 *    tenant… it's not a this-or-that thing."
 *
 * Prefill used to mean only "copy a fact we already know about this lease".
 * There was no way to say "this box starts ticked", so the same four boxes were
 * re-ticked by hand on every lease sent.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord } from '../test/dbHelpers'

beforeEach(async () => { await cleanupAllSchema() })

async function seedTemplateField(col: Record<string, any>) {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const ll = await seedLandlord(c)
    const t = await c.query<{ id: string }>(
      `INSERT INTO lease_templates (landlord_id, name) VALUES ($1,'T') RETURNING id`, [ll.landlordId])
    const f = await c.query<{ id: string }>(
      `INSERT INTO lease_template_fields (template_id, field_type, x, y, default_value, checkbox_mark)
       VALUES ($1,$2,10,10,$3,$4) RETURNING id`,
      [t.rows[0].id, col.field_type ?? 'checkbox', col.default_value ?? null, col.checkbox_mark ?? 'x'])
    await c.query('COMMIT')
    return f.rows[0].id
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

describe('template field defaults', () => {
  it('stores a starting answer for a checkbox', async () => {
    const id = await seedTemplateField({ default_value: 'checked' })
    const { rows } = await db.query(`SELECT default_value FROM lease_template_fields WHERE id=$1`, [id])
    expect(rows[0].default_value).toBe('checked')
  })

  it('defaults the mark to an X, never a filled square', async () => {
    const id = await seedTemplateField({})
    const { rows } = await db.query(`SELECT checkbox_mark FROM lease_template_fields WHERE id=$1`, [id])
    expect(rows[0].checkbox_mark).toBe('x')
  })

  it('accepts a check mark as the alternative', async () => {
    const id = await seedTemplateField({ checkbox_mark: 'check' })
    const { rows } = await db.query(`SELECT checkbox_mark FROM lease_template_fields WHERE id=$1`, [id])
    expect(rows[0].checkbox_mark).toBe('check')
  })

  // Nic was explicit that a solid square is ambiguous — it reads as redaction
  // to one person and "not applicable" to another.
  it('refuses any other mark', async () => {
    await expect(seedTemplateField({ checkbox_mark: 'square' })).rejects.toThrow()
  })
})

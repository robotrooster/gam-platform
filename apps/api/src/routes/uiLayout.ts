/**
 * 10/21 (Nic) — WHERE SOMEBODY PUT THEIR OWN THINGS.
 *
 *   "Did you ever build my idea for people being able to drag the left
 *    navigation bar into an order of their choosing... I feel like there's a
 *    lot of stuff that I brought up that got skipped."
 *
 *   "let's build the screens, the draggable nav, rearranging the dashboard
 *    widgets."
 *
 * One person's arrangement of one of their own screens, and nothing else. It
 * holds no setting, no policy and no money, and it CANNOT widen what anybody
 * sees: the sidebar is still drawn from visibleNavItemsFor and every page still
 * answers to its own permission. A saved order is read as a preference about
 * things the person can already open — a key naming anything else is simply
 * skipped when the screen is drawn.
 *
 * Which is why this stores a plain list of strings and validates almost
 * nothing about their meaning: the meaning lives in the screen, and a screen
 * that renames a page should not strand everybody's layout. Unknown keys fall
 * out at draw time, and new pages appear at the end.
 */
import { Router } from 'express'
import { query, queryOne } from '../db'
import { requireAuth } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'

export const uiLayoutRouter = Router()

/** The screens a person may arrange. A new one costs a line here and a migration. */
const SURFACES = new Set(['landlord_nav', 'landlord_dashboard'])

/**
 * Bounds, so a saved layout stays a layout. Generous enough that no real screen
 * comes near them and small enough that nobody can park data here.
 */
const MAX_KEYS = 200
const MAX_KEY_LENGTH = 120

function surfaceOf(raw: unknown): string {
  const s = String(raw ?? '')
  if (!SURFACES.has(s)) throw new AppError(404, 'There is no screen by that name to arrange.')
  return s
}

/**
 * The list, cleaned: strings only, trimmed, no blanks, no duplicates, bounded.
 * An empty list is the meaningful "back to how it came" — see the note on the
 * table about never deleting the row.
 */
function layoutOf(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    throw new AppError(400, 'An arrangement is a list of what goes where.')
  }
  if (raw.length > MAX_KEYS) {
    throw new AppError(400, 'That is more items than a screen has.')
  }
  const out: string[] = []
  const seen = new Set<string>()
  for (const k of raw) {
    if (typeof k !== 'string') continue
    const key = k.trim()
    if (!key || key.length > MAX_KEY_LENGTH || seen.has(key)) continue
    seen.add(key)
    out.push(key)
  }
  return out
}

// GET /api/ui-layout/:surface — how this person has their screen arranged.
uiLayoutRouter.get('/:surface', requireAuth, async (req, res, next) => {
  try {
    const surface = surfaceOf(req.params.surface)
    const row = await queryOne<{ layout: unknown }>(
      `SELECT layout FROM user_ui_layout WHERE user_id = $1 AND surface = $2`,
      [(req as any).user.userId, surface])
    res.json({ success: true, data: { layout: Array.isArray(row?.layout) ? row!.layout : [] } })
  } catch (e) { next(e) }
})

// PUT /api/ui-layout/:surface — save it. An empty list is "back to default".
uiLayoutRouter.put('/:surface', requireAuth, async (req, res, next) => {
  try {
    const surface = surfaceOf(req.params.surface)
    const layout = layoutOf(req.body?.layout)
    await query(
      `INSERT INTO user_ui_layout (user_id, surface, layout)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (user_id, surface)
       DO UPDATE SET layout = EXCLUDED.layout, updated_at = NOW()`,
      [(req as any).user.userId, surface, JSON.stringify(layout)])
    res.json({ success: true, data: { layout } })
  } catch (e) { next(e) }
})

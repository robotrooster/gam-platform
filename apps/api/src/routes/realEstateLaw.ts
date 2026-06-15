/**
 * Generic real-estate-law read API — verbatim statute TEXT search within ANY
 * law_category for a state (the broad corpus: conveyancing_title, condo_coop,
 * broker_licensing, mortgage_lien_foreclosure, general_real_property, plus
 * property_tax / landlord_tenant). Backend for future investor/agent/commercial
 * surfaces over the real-estate corpus.
 *
 *   GET /api/real-estate-law/:state/search?q=…&category=<law_category>[&limit=]
 *
 * Read-only, requireAuth, dated disclaimer. Sanctioned no-state-legal carve-out
 * (retrieve + cite + date; never advice). Citations are generic `<ST> § <n>` —
 * the landlord/tenant citationFor() range-heuristic would mislabel these
 * sections; the section_number + official source_url carry precision.
 * (Property-tax STRUCTURED figures live at /api/property-tax/:state/facts.)
 */
import { Router } from 'express'
import { searchRealEstateLaw, buildDisclaimer } from '../services/stateLaw'
import { LAW_CATEGORY_VALUES } from '@gam/shared'
import { requireAuth } from '../middleware/auth'

export const realEstateLawRouter = Router()
realEstateLawRouter.use(requireAuth)

const TEXT_EXCERPT = 2000
const norm = (s: unknown) => String(s ?? '').trim().toUpperCase()

realEstateLawRouter.get('/:state/search', async (req, res, next) => {
  try {
    const state = norm(req.params.state)
    const q = String(req.query.q ?? '').trim()
    const category = String(req.query.category ?? '').trim()
    if (state.length !== 2) return res.status(400).json({ success: false, error: 'state must be a 2-letter code' })
    if (q.length < 2) return res.status(400).json({ success: false, error: 'q (search query) is required' })
    if (!(LAW_CATEGORY_VALUES as readonly string[]).includes(category))
      return res.status(400).json({ success: false, error: `category must be one of: ${LAW_CATEGORY_VALUES.join(', ')}` })
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '5'), 10) || 5, 1), 10)
    const hits = await searchRealEstateLaw(state, q, category, limit)
    const latest = hits.map((h) => h.source_date).filter(Boolean).sort().pop() ?? null
    res.json({
      success: true,
      data: {
        state,
        category,
        query: q,
        results: hits.map((h) => ({
          citation: `${state} § ${h.section_number}`,
          section: h.section_number,
          title: h.section_title,
          text: h.full_text.length > TEXT_EXCERPT ? h.full_text.slice(0, TEXT_EXCERPT) + '… [truncated — see source]' : h.full_text,
          source: h.source_url,
        })),
        disclaimer: buildDisclaimer(latest),
      },
    })
  } catch (e) {
    next(e)
  }
})

/**
 * Property-tax read API — backend for the near-term GAM property-tax feature.
 * Two surfaces over the sanctioned no-state-legal carve-out (retrieve + cite +
 * date; never advice):
 *   GET /api/property-tax/:state/facts        → STRUCTURED figures
 *       (exemptions, assessment-appeal deadline, payment, redemption) from
 *       state_property_tax_provisions — all 50 states.
 *   GET /api/property-tax/:state/search?q=…    → verbatim statute TEXT search
 *       within that state's property-tax law (43 states ingested).
 *
 * Read-only + feature-agnostic so any frontend (a dedicated property-tax view,
 * an owner/investor surface, etc.) can consume it. Every payload carries the
 * dated disclaimer. Text-search citations are generic `<ST> § <n>` on purpose —
 * the landlord/tenant citationFor() range-heuristic would mislabel tax sections;
 * the structured facts carry proper per-state citations from their source rows.
 */
import { Router } from 'express'
import { searchPropertyTaxText, getPropertyTaxProvisions, buildDisclaimer } from '../services/stateLaw'
import { requireAuth } from '../middleware/auth'

export const propertyTaxRouter = Router()
propertyTaxRouter.use(requireAuth)

const TEXT_EXCERPT = 2000
const norm = (s: unknown) => String(s ?? '').trim().toUpperCase()

// Structured property-tax facts for a state (latest effective year).
propertyTaxRouter.get('/:state/facts', async (req, res, next) => {
  try {
    const state = norm(req.params.state)
    if (state.length !== 2) return res.status(400).json({ success: false, error: 'state must be a 2-letter code' })
    const provisions = await getPropertyTaxProvisions(state)
    const latest = provisions.map((p) => p.source_date).filter(Boolean).sort().pop() ?? null
    res.json({ success: true, data: { state, provisions, disclaimer: buildDisclaimer(latest) } })
  } catch (e) {
    next(e)
  }
})

// Verbatim full-text search within a state's property-tax statutes.
propertyTaxRouter.get('/:state/search', async (req, res, next) => {
  try {
    const state = norm(req.params.state)
    const q = String(req.query.q ?? '').trim()
    if (state.length !== 2) return res.status(400).json({ success: false, error: 'state must be a 2-letter code' })
    if (q.length < 2) return res.status(400).json({ success: false, error: 'q (search query) is required' })
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '5'), 10) || 5, 1), 10)
    const hits = await searchPropertyTaxText(state, q, limit)
    const latest = hits.map((h) => h.source_date).filter(Boolean).sort().pop() ?? null
    res.json({
      success: true,
      data: {
        state,
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

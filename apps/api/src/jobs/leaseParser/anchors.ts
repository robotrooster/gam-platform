// apps/api/src/jobs/leaseParser/anchors.ts
//
// Anchor-based extraction: for each filled value on a page, find the
// printed label it belongs to. The whole parser is built on this.
//
// Algorithm (tuned against real lease PDFs, generalizes across vendors):
//
// 1. Same-line search FIRST. The label "TENANT(S):" is at y=586.8 x=43.2
//    and the value "Marci Neeld" is at y=587.5 x=151.9. Same baseline
//    (within Y tolerance), value is right of label. Match wins.
//
// 2. If no same-line match, look UP one line. Some forms put the label
//    on a line and the value on the line below ("Beginning on" label,
//    "05/01/2024" value below).
//
// 3. Anchors must contain alphabetic content (>=3 letters). Pure
//    underscores or whitespace items don't count -- a line full of
//    underscores is the form's blank, not a label.
//
// 4. When multiple labels exist on the same line ("Year: ___ Make: ___
//    Serial: ___"), each value matches the LABEL TO ITS LEFT, not the
//    leftmost label on the line.

import type { Page } from '../../lib/pdfText'
import { joinPageItems, joinPageItemsRelaxed, type JoinedItem } from './itemJoin'

const Y_SAME_LINE_TOLERANCE = 6    // pts -- "same baseline" for anchor search
const Y_LINE_ABOVE_MAX_GAP  = 30   // pts -- max vertical distance to fallback anchor above
const X_ANCHOR_RIGHT_PAD    = 3    // pts -- anchor's right edge can be slightly past value's left
const MIN_LABEL_ALPHA_RUN   = 3    // chars -- minimum alphabetic run to qualify as label

export type AnchorMatch = {
  // The value item we're anchoring (e.g. the filled-in tenant name)
  value: JoinedItem
  // The label item we matched to (e.g. "TENANT(S):") -- may be undefined
  // if no label was found, in which case the value is orphaned.
  anchor?: JoinedItem
  // How we matched, for debugging and confidence scoring
  matchKind: 'same_line' | 'line_above' | 'orphan'
}

/**
 * An item is a form-template label if:
 *   1. It contains a meaningful alphabetic run (>= MIN_LABEL_ALPHA_RUN)
 *   2. It contains a colon followed by whitespace/underscores or EOL
 *
 * The terminal-colon check is what distinguishes form labels from body
 * prose, section headings ("LANDLORD", "Liability Insurance"), and
 * filled values. Every real form label in the leases we have ends with
 * ":" before the blank fill region.
 */
export function isLabelLike(item: JoinedItem): boolean {
  const t = item.text
  if (!t) return false

  // Must have a contiguous alphabetic run
  let run = 0, maxRun = 0
  for (const c of t) {
    if (/[A-Za-z]/.test(c)) {
      run++
      if (run > maxRun) maxRun = run
    } else {
      run = 0
    }
  }
  if (maxRun < MIN_LABEL_ALPHA_RUN) return false

  // Must contain a "label terminator" colon -- one followed by whitespace,
  // underscores, or end-of-string. Excludes time-of-day colons like "10:00".
  return /:\s*_*\s*$/.test(t) || /:\s+_/.test(t) || /:\s*$/.test(t)
}

/**
 * Compute the label's effective right edge -- the position just after
 * the colon, before the underscore fill region. This lets same-line
 * anchor matching work when a label and its value share a line and the
 * label's underscore "furniture" visually extends past the value.
 *
 * Uses proportional character-position estimation: assumes characters
 * are roughly evenly spaced within an item. Adds a small slack to
 * tolerate proportional-font width variation.
 */
export function effectiveX2(item: JoinedItem): number {
  const text = item.text
  const colonIdx = text.indexOf(':')
  if (colonIdx === -1) return item.x2
  const totalLen = text.length
  if (totalLen === 0) return item.x2
  // x2-x = full visual width; (colonIdx+1)/totalLen = proportion up to
  // and including the colon. Add 5pt slack for proportional-width fonts.
  return item.x + (item.x2 - item.x) * ((colonIdx + 1) / totalLen) + 5
}

/**
 * Find the best anchor for a given value item among a pool of joined
 * items on the same page.
 */
export function findAnchor(
  value: JoinedItem,
  pageItems: JoinedItem[]
): AnchorMatch {
  // Step 1: same-line labels to the LEFT of the value. Use effectiveX2
  // (label text end, not visual end) so underscore furniture doesn't
  // disqualify the label.
  const sameLine = pageItems.filter(it =>
    it !== value &&
    Math.abs(it.y - value.y) < Y_SAME_LINE_TOLERANCE &&
    effectiveX2(it) <= value.x + X_ANCHOR_RIGHT_PAD &&
    isLabelLike(it)
  )
  if (sameLine.length > 0) {
    // Rightmost label wins -- closest to the value (by effective x2)
    const anchor = sameLine.reduce((a, b) =>
      effectiveX2(b) > effectiveX2(a) ? b : a
    )
    return { value, anchor, matchKind: 'same_line' }
  }

  // Step 2: line above (smaller y is BELOW in PDF coords; we want LARGER y)
  const above = pageItems.filter(it =>
    it !== value &&
    it.y > value.y &&
    it.y - value.y < Y_LINE_ABOVE_MAX_GAP &&
    // Anchor must overlap the value horizontally OR be to its left
    it.x < value.x2 + 50 &&
    isLabelLike(it)
  )
  if (above.length > 0) {
    // Closest line above (smallest y-delta), then leftmost
    const anchor = above.reduce((a, b) => {
      const da = a.y - value.y
      const db = b.y - value.y
      if (Math.abs(da - db) < 1) return a.x < b.x ? a : b
      return da < db ? a : b
    })
    return { value, anchor, matchKind: 'line_above' }
  }

  return { value, matchKind: 'orphan' }
}

/**
 * Build a per-page lookup keyed by normalized anchor label text.
 * Returns a map from normalized label -> matching value items.
 *
 * Normalization: lowercase, strip non-alphanumerics. So "TENANT(S):"
 * and "Tenant(s):" both key as "tenants". Allows label aliases.
 *
 * One label can match multiple values (e.g. a "Year/Make/Serial" line
 * has three values matching the same anchor by left-matching). The map
 * value is an array sorted left-to-right.
 */
export type AnchorIndex = Map<string, JoinedItem[]>

export function buildAnchorIndex(page: Page): AnchorIndex {
  const items = joinPageItems(page)

  // For each item, find its anchor. Items that ARE labels themselves
  // are excluded from the value pool. With the tightened isLabelLike
  // (terminal-colon requirement), label/value classification is clean
  // enough that the previous "short label-like" escape hatch is gone.
  const valuePool = items.filter(it => !isLabelLike(it))
  const anchorPool = items.filter(isLabelLike)

  const index: AnchorIndex = new Map()

  for (const value of valuePool) {
    const match = findAnchor(value, anchorPool)
    if (!match.anchor) continue
    const key = normalizeLabel(match.anchor.text)
    if (!key) continue
    const list = index.get(key) ?? []
    list.push(value)
    index.set(key, list)
  }

  // Sort each label's values left-to-right (for multi-value lines like
  // "Year ___ Make ___ Serial ___")
  for (const list of index.values()) {
    list.sort((a, b) => a.x - b.x)
  }

  return index
}

export function normalizeLabel(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * Look up values by any of the given label aliases. Tries each alias in
 * order; returns the first match. Aliases let us tolerate punctuation
 * and phrasing differences ("TENANT(S):" vs "Tenant Name:" vs "Tenant").
 */
export function lookupByAlias(
  index: AnchorIndex,
  aliases: string[]
): JoinedItem[] {
  for (const a of aliases) {
    const k = normalizeLabel(a)
    const v = index.get(k)
    if (v && v.length > 0) return v
  }
  return []
}

/**
 * findFieldByLabel -- directed per-field extraction. The primary primitive
 * for the parser. Replaces the brittle generic-index approach because
 * pdfjs splits text by font-subset boundaries, which means form labels
 * may fragment across multiple items while body prose may join into
 * single items that contain label-like colons. A generic index can't
 * tell which is which without per-field knowledge.
 *
 * Each field knows:
 *   - its label pattern (regex)
 *   - where its value sits relative to the label (right or below)
 *   - what the value looks like (regex shape filter)
 *
 * Algorithm:
 *   1. Search relaxed-joined items for the label pattern
 *   2. Compute label-end x via proportional position within the matched item
 *   3. Build candidate value items based on spatial mode
 *   4. Filter candidates by value-shape regex
 *   5. Return the candidate closest to the label-end position
 */
export type FieldExtractionOptions = {
  // Regex matching the label substring within an item's text.
  // Should NOT have the global flag.
  labelPattern: RegExp

  // Where to look for the value relative to the label.
  //   'right_same_line' -- value sits right of the label end, same y
  //   'below_same_x'    -- value sits below the label, similar x range
  //   'right_then_below' -- try right first, fallback to below
  // Default: 'right_then_below'
  valuePosition?: 'right_same_line' | 'below_same_x' | 'right_then_below'

  // Required value shape. Candidates not matching are filtered out.
  // If omitted, any non-empty trimmed text qualifies.
  valueShape?: RegExp

  // Maximum vertical gap (pts) for 'below_same_x' search. Default 30.
  maxBelowGap?: number

  // Maximum horizontal gap (pts) for 'right_same_line' candidates from
  // the label end. Default 600 (effectively whole-page).
  maxRightGap?: number
}

export type FieldExtractionHit = {
  value: JoinedItem
  label: string         // the matched label substring
  matchKind: 'right' | 'below'
  // For multi-value-line debugging: how far the value was from the
  // estimated label end x (negative = left of, positive = right of).
  distanceFromLabelEnd: number
}

/**
 * Pure-noise items that pdfjs sometimes emits: empty strings, runs of
 * underscores, stray punctuation from font-subset splits. Never
 * legitimate field values; excluded from candidate sets in
 * findFieldByLabel / findAllFieldsByLabel.
 */
export function isNoiseValue(item: JoinedItem): boolean {
  const t = item.text.trim()
  if (t.length === 0) return true
  if (/^[_\s]+$/.test(t)) return true
  if (/^["'()\u201C\u201D\u2018\u2019.,:;\-]+$/.test(t)) return true
  return false
}

export function findFieldByLabel(
  page: Page,
  opts: FieldExtractionOptions
): FieldExtractionHit | null {
  const mode = opts.valuePosition ?? 'right_then_below'
  const maxBelow = opts.maxBelowGap ?? 30
  const maxRight = opts.maxRightGap ?? 600

  const relaxed = joinPageItemsRelaxed(page)
  const strict  = joinPageItems(page)

  // 1. Find label substring in any relaxed item
  for (const prose of relaxed) {
    const m = prose.text.match(opts.labelPattern)
    if (!m || m.index === undefined) continue

    // 2. Estimate label-end x via proportional character position
    const totalChars = prose.text.length
    const totalWidth = prose.x2 - prose.x
    if (totalChars === 0 || totalWidth === 0) continue
    const labelEndChar = m.index + m[0].length
    const labelEndX = prose.x + (labelEndChar / totalChars) * totalWidth

    // 3. Same-line right-of-label candidates.
    //
    // We must exclude candidates whose own text contains the label
    // pattern -- otherwise a strict-joined fragment of the label
    // (e.g. the label split across font-subset boundaries appears as
    // both the prose item and a smaller strict-joined item) would
    // match itself as the value. A real value never contains the
    // label that anchors it.
    const candidates = (mode === 'right_same_line' || mode === 'right_then_below') ? strict.filter(it =>
        it !== prose &&
        Math.abs(it.y - prose.y) < Y_SAME_LINE_TOLERANCE &&
        it.x >= prose.x &&
        it.x - labelEndX < maxRight &&
        it.text.trim().length > 0 &&
        !opts.labelPattern.test(it.text) &&
        !isNoiseValue(it) &&
        (!opts.valueShape || opts.valueShape.test(it.text.trim()))
      ) : []
    if (mode === 'right_same_line' || mode === 'right_then_below') {
      if (candidates.length > 0) {
        // Pick the candidate CLOSEST to the estimated label end. For
        // multi-value lines like "Year: ___ Make: ___ Serial: ___",
        // each label query lands the value nearest to its own label
        // end, not the leftmost or rightmost on the line.
        const best = candidates.reduce((a, b) => {
          const da = Math.abs(a.x - labelEndX)
          const db = Math.abs(b.x - labelEndX)
          return db < da ? b : a
        })
        return {
          value: best,
          label: m[0],
          matchKind: 'right',
          distanceFromLabelEnd: best.x - labelEndX,
        }
      }
    }

    // 4. Below-the-label candidates (next-line forms).
    // Same label-self-match exclusion as the right-side path.
    if (mode === 'below_same_x' || mode === 'right_then_below') {
      const candidates = strict.filter(it =>
        it !== prose &&
        prose.y - it.y > 0 &&
        prose.y - it.y < maxBelow &&
        it.x >= prose.x - 10 && it.x < labelEndX + 200 &&
        it.text.trim().length > 0 &&
        !opts.labelPattern.test(it.text) &&
        !isNoiseValue(it) &&
        (!opts.valueShape || opts.valueShape.test(it.text.trim()))
      )
      if (candidates.length > 0) {
        // Closest below, then closest x to label start
        const best = candidates.reduce((a, b) => {
          const dya = prose.y - a.y
          const dyb = prose.y - b.y
          if (Math.abs(dya - dyb) < 1) {
            const dxa = Math.abs(a.x - prose.x)
            const dxb = Math.abs(b.x - prose.x)
            return dxb < dxa ? b : a
          }
          return dyb < dya ? b : a
        })
        return {
          value: best,
          label: m[0],
          matchKind: 'below',
          distanceFromLabelEnd: best.x - labelEndX,
        }
      }
    }
  }

  return null
}

/**
 * Find ALL values matching a label pattern. For repeating fields like
 * vehicles, pets, or multi-tenant entries that recur with the same
 * label across the document.
 */
export function findAllFieldsByLabel(
  page: Page,
  opts: FieldExtractionOptions
): FieldExtractionHit[] {
  const mode = opts.valuePosition ?? 'right_then_below'
  const maxBelow = opts.maxBelowGap ?? 30
  const maxRight = opts.maxRightGap ?? 600

  const relaxed = joinPageItemsRelaxed(page)
  const strict  = joinPageItems(page)
  const hits: FieldExtractionHit[] = []
  const usedValues = new Set<JoinedItem>()

  for (const prose of relaxed) {
    // findAll: walk every match in the prose item, not just first
    const re = new RegExp(opts.labelPattern.source, 'g' + (opts.labelPattern.flags.includes('i') ? 'i' : ''))
    let m: RegExpExecArray | null
    while ((m = re.exec(prose.text)) !== null) {
      const totalChars = prose.text.length
      const totalWidth = prose.x2 - prose.x
      if (totalChars === 0 || totalWidth === 0) break
      const labelEndChar = m.index + m[0].length
      const labelEndX = prose.x + (labelEndChar / totalChars) * totalWidth

      const allCandidates = strict.filter(it =>
        it !== prose &&
        !usedValues.has(it) &&
        it.text.trim().length > 0 &&
        !opts.labelPattern.test(it.text) &&
        !isNoiseValue(it) &&
        (!opts.valueShape || opts.valueShape.test(it.text.trim()))
      )

      let best: JoinedItem | null = null
      let bestKind: 'right' | 'below' | null = null

      if (mode === 'right_same_line' || mode === 'right_then_below') {
        const same = allCandidates.filter(it =>
          Math.abs(it.y - prose.y) < Y_SAME_LINE_TOLERANCE &&
          it.x >= prose.x &&
          it.x - labelEndX < maxRight
        )
        if (same.length > 0) {
          best = same.reduce((a, b) => Math.abs(b.x - labelEndX) < Math.abs(a.x - labelEndX) ? b : a)
          bestKind = 'right'
        }
      }

      if (!best && (mode === 'below_same_x' || mode === 'right_then_below')) {
        const below = allCandidates.filter(it =>
          prose.y - it.y > 0 &&
          prose.y - it.y < maxBelow &&
          it.x >= prose.x - 10 && it.x < labelEndX + 200
        )
        if (below.length > 0) {
          best = below.reduce((a, b) => (prose.y - b.y) < (prose.y - a.y) ? b : a)
          bestKind = 'below'
        }
      }

      if (best && bestKind) {
        hits.push({
          value: best,
          label: m[0],
          matchKind: bestKind,
          distanceFromLabelEnd: best.x - labelEndX,
        })
        usedValues.add(best)
      }
    }
  }

  return hits
}

// Legacy alias retained while scratch is migrated. Prefer findFieldByLabel.
export const findInlineLabelValue = (
  page: Page,
  labelPattern: RegExp,
  valueShape?: RegExp
): { label: string; value: JoinedItem } | null => {
  const hit = findFieldByLabel(page, { labelPattern, valueShape, valuePosition: 'right_same_line' })
  return hit ? { label: hit.label, value: hit.value } : null
}

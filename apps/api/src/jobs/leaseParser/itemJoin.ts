// apps/api/src/jobs/leaseParser/itemJoin.ts
//
// pdfjs emits text in fragments: a single visual word like "LANDLORD"
// often arrives as ["L", "ANDLORD", ":", " ", "Nicholas Rhoades"] because
// the document uses font subsetting (different glyphs from different
// subset entries) and pdfjs preserves the run boundaries faithfully.
//
// For anchor matching we need joined-up text that resembles what a human
// reader sees. Two items merge into one phrase when:
//   - same baseline (y within 0.5pt -- floating point tolerance)
//   - same font (continuity of run)
//   - x-gap between them is less than ~3pt (a single-space width)
//
// This is the same algorithm pdfplumber's `extract_text(layout=True)` uses
// internally, ported to operate on pdfjs-dist's TextItem shape.

import type { Page, TextItem } from '../../lib/pdfText'

const Y_TOLERANCE = 0.5      // pts -- baselines this close are "same line"
const X_GAP_TOLERANCE = 3.0  // pts -- gaps this small mean continue same word

export type JoinedItem = TextItem & {
  // Joined items keep the leftmost x and bottom-most y of their source
  // fragments; x2 is the rightmost edge. fontName carries through.
  // Source fragments are preserved for downstream debugging and for
  // multi-value-line splitting (which needs sub-positions).
  sources: TextItem[]
}

/**
 * Join adjacent same-line same-font items on a page. Returns items in
 * top-down then left-right order.
 */
export function joinPageItems(page: Page): JoinedItem[] {
  // Sort top-down (PDF y descends), then left-right.
  const sorted = [...page.items].sort((a, b) => b.y - a.y || a.x - b.x)

  const joined: JoinedItem[] = []
  for (const it of sorted) {
    const last = joined[joined.length - 1]
    if (
      last &&
      Math.abs(last.y - it.y) < Y_TOLERANCE &&
      last.fontName === it.fontName &&
      it.x - last.x2 < X_GAP_TOLERANCE
    ) {
      // Continue the previous run.
      last.text += it.text
      last.x2 = it.x2
      last.sources.push(it)
    } else {
      joined.push({
        text: it.text,
        x: it.x,
        y: it.y,
        x2: it.x2,
        fontName: it.fontName,
        sources: [it],
      })
    }
  }
  return joined
}

/**
 * Some labels span MULTIPLE adjacent fonts (e.g. "TENANT(S):" where the
 * "T" and "S" are bold and ":" is regular). joinPageItems won't merge
 * these because fontName differs. For anchor matching we want a relaxed
 * join that ignores font when the gap is small enough -- the algorithm
 * uses joined items for spatial position but reads concatenated text
 * from this relaxed view for label detection.
 */
export function joinPageItemsRelaxed(page: Page): JoinedItem[] {
  const sorted = [...page.items].sort((a, b) => b.y - a.y || a.x - b.x)
  const joined: JoinedItem[] = []
  for (const it of sorted) {
    const last = joined[joined.length - 1]
    if (
      last &&
      Math.abs(last.y - it.y) < Y_TOLERANCE &&
      it.x - last.x2 < X_GAP_TOLERANCE
    ) {
      last.text += it.text
      last.x2 = it.x2
      last.sources.push(it)
    } else {
      joined.push({
        text: it.text,
        x: it.x,
        y: it.y,
        x2: it.x2,
        fontName: it.fontName,
        sources: [it],
      })
    }
  }
  return joined
}

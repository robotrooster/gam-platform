// apps/api/src/lib/pdfText.ts
//
// Positional text extraction for lease PDFs.
//
// pdf-parse (a separate dep) returns concatenated text only -- it loses
// x/y coordinates and font info. That makes it impossible to match
// floating e-sign overlay values back to their printed labels because
// values appear at the END of the page text stream, not adjacent to
// labels in reading order.
//
// pdfjs-dist's getTextContent() exposes per-item transforms (x, y) and
// font name, which lets the parser match values to labels spatially.
//
// pdfjs-dist v5 is ESM-only — the legacy/build/pdf.js CJS entry was
// dropped in v4. apps/api stays CJS+tsx; we bridge with dynamic import
// for pdfjs (Node's CJS-can-import-ESM interop). The async cost is
// absorbed by the already-async parsing entry points; everything else
// (the @napi-rs/canvas polyfill, the standard_fonts path resolution)
// stays synchronous.
//
// Two production-grade integrations below:
//
// 1. @napi-rs/canvas provides DOMMatrix / Path2D so pdfjs's rendering
//    code path doesn't warn on load. We never render -- the parser is
//    text-only -- but pdfjs probes for these at module init. Using
//    @napi-rs/canvas (Rust+napi prebuilts) instead of `canvas` (native
//    Cairo/Pango build) eliminates the Homebrew toolchain dependency.
//
// 2. standardFontDataUrl points pdfjs at the standard fonts that ship
//    inside the pdfjs-dist package itself. Without these, character
//    widths are estimated for documents that reference fonts they do
//    NOT embed (common in form templates) and x2 values are noisy --
//    enough to break spatial matching on tightly-spaced forms.

import path from 'path'

// Polyfill DOMMatrix / Path2D BEFORE pdfjs loads so it picks them up.
// pdfjs probes for these at module init time -- once we await
// import('pdfjs-dist') it's too late, the module's top-level checks
// already ran.
type GlobalWithCanvas = typeof globalThis & {
  DOMMatrix?: unknown
  Path2D?:    unknown
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
const napiCanvas = require('@napi-rs/canvas')
const g = globalThis as GlobalWithCanvas
if (typeof g.DOMMatrix === 'undefined' && napiCanvas.DOMMatrix) {
  g.DOMMatrix = napiCanvas.DOMMatrix
}
if (typeof g.Path2D === 'undefined' && napiCanvas.Path2D) {
  g.Path2D = napiCanvas.Path2D
}

// Lazy-load pdfjs once and cache the module promise. Subsequent calls
// reuse the resolved module without re-importing.
let pdfjsModuleP: Promise<any> | null = null
function getPdfjs(): Promise<any> {
  if (!pdfjsModuleP) {
    // Dynamic import of an ESM .mjs from CJS is supported in modern
    // Node. The string literal is intentionally not a top-level static
    // import so TypeScript's CommonJS module emit doesn't try to
    // require() it.
    // v5 still ships a `legacy/build/pdf.mjs` Node-targeted build (ESM,
    // but without modern-browser-only APIs that the main `build/pdf.mjs`
    // pulls in). pdfjs warns at load time if you use the non-legacy
    // build under Node; it also crashes in Node when invoking certain
    // Uint8Array methods that aren't surfaced in CJS-targeted modules.
    pdfjsModuleP = import('pdfjs-dist/legacy/build/pdf.mjs')
  }
  return pdfjsModuleP
}

// Standard fonts ship at the pdfjs-dist package root. Resolve via the
// main entry — `require.resolve('pdfjs-dist')` returns the `build/pdf.mjs`
// path even though we never require() it. From there, up two dirs is
// the package root; standard_fonts/ sits there.
const STANDARD_FONT_DATA_URL = path.join(
  require.resolve('pdfjs-dist'),
  '..', '..', 'standard_fonts/'
) + path.sep

export type TextItem = {
  text: string
  x: number          // left edge in PDF user-space points
  y: number          // baseline -- PDF coords have y increasing UPWARD
  x2: number         // right edge
  fontName: string   // pdfjs-internal id (e.g. 'g_d0_f1'); not stable across documents
}

export type Page = {
  pageNumber: number
  width: number
  height: number
  items: TextItem[]
}

export type ExtractedPdf = {
  pageCount: number
  pages: Page[]
}

/**
 * Extract every text item from a PDF with its position and font.
 *
 * Items are pre-grouped by pdfjs: one item per text run (consecutive
 * chars in the same font on the same line). We pass them through with
 * minimal transformation. Note that pdfjs may split a single visual
 * word across multiple items when the document uses font subsetting
 * (different glyphs from different subset entries) -- this is a fact
 * of PDF rendering, not a bug.
 */
export async function extractPositionedText(pdfBuffer: Buffer): Promise<ExtractedPdf> {
  const pdfjsLib = await getPdfjs()
  const data = new Uint8Array(pdfBuffer)
  const loadingTask = pdfjsLib.getDocument({
    data,
    standardFontDataUrl: STANDARD_FONT_DATA_URL,
    useWorkerFetch: false,
    isEvalSupported: false,
    useSystemFonts: false,
  })
  const doc = await loadingTask.promise
  const pages: Page[] = []

  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    const page = await doc.getPage(pageNum)
    const viewport = page.getViewport({ scale: 1 })
    const textContent = await page.getTextContent()

    const items: TextItem[] = []
    for (const raw of textContent.items as Array<{
      str: string
      transform: number[]
      width: number
      height: number
      fontName?: string
    }>) {
      if (typeof raw.str !== 'string' || raw.str === '') continue
      const x = raw.transform[4]
      const y = raw.transform[5]
      const w = raw.width || 0
      items.push({
        text: raw.str,
        x,
        y,
        x2: x + w,
        fontName: raw.fontName || 'unknown',
      })
    }

    pages.push({
      pageNumber: pageNum,
      width: viewport.width,
      height: viewport.height,
      items,
    })
  }

  try { await doc.destroy() } catch { /* noop */ }

  return { pageCount: doc.numPages, pages }
}

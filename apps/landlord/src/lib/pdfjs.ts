// S557: pdf.js is self-hosted (no CDN) per the standing rule that all
// third-party assets ship from our own origin — see the CSP/offline/webview
// requirement recorded in memory `gam-no-external-cdn-assets`. Pinned to
// pdfjs-dist@3.11.174 to preserve the exact behavior of the previous cdnjs
// <script> tag. Loaded lazily via dynamic import so it stays out of the
// initial bundle, matching the old on-demand script injection, and the worker
// is bundled as a local asset (`?url`) rather than fetched from a CDN.
let pdfjsPromise: Promise<any> | null = null

export function loadPdfjs(): Promise<any> {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const mod: any = await import('pdfjs-dist')
      const pdfjsLib = mod.getDocument ? mod : mod.default
      const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.js?url')).default
      pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl
      return pdfjsLib
    })()
  }
  return pdfjsPromise
}

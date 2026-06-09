// S240: pdfjs-dist v5 ships types for the bare `'pdfjs-dist'` import
// (per `"types"` field in its package.json) but not for the
// legacy/build/pdf.mjs subpath we use in pdfText.ts (the Node-targeted
// build that pdfjs's own warning says to use under Node). The runtime
// shape is identical, so re-export the same module typing here.
declare module 'pdfjs-dist/legacy/build/pdf.mjs' {
  export * from 'pdfjs-dist'
}

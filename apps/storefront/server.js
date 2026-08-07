// S574: production static server for the guest storefront.
//
// The storefront is a Vite SPA that serves EVERY property from one deployment,
// keyed by subdomain ({booking_slug}.gam.biz). In production it sits behind the
// Cloudflare tunnel (wildcard route *.gam.biz -> localhost:3015), so — like the
// marketing site — it runs as a plain Node server on the Mac rather than a Vite
// dev server: no dev-mode overhead, no source exposure, and (being raw http) it
// accepts any Host header the tunnel forwards.
//
// It serves the built assets from dist/ and falls back to index.html for every
// other path, so the client-side router + subdomain resolution take over. The
// API base URL is chosen at runtime in the browser (see src/main.tsx), so no
// build-time injection is needed here.

const http = require('http')
const fs   = require('fs')
const path = require('path')

const PORT     = Number(process.env.PORT || 3015)
const DIST_DIR = path.join(__dirname, 'dist')
const INDEX    = path.join(DIST_DIR, 'index.html')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif':  'image/gif',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ttf':  'font/ttf',
  '.map':  'application/json; charset=utf-8',
}

if (!fs.existsSync(INDEX)) {
  console.error(`[storefront] dist/index.html not found at ${INDEX}. Run "npm run build --workspace=apps/storefront" first.`)
}

function sendFile(res, filePath, status = 200) {
  const ext = path.extname(filePath).toLowerCase()
  res.writeHead(status, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    // Hashed Vite assets are immutable; index.html must never be cached (a stale
    // shell would point at deleted asset hashes after a redeploy).
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
  })
  fs.createReadStream(filePath).pipe(res)
}

const server = http.createServer((req, res) => {
  // Path-only, decoded, stripped of query. Reject traversal.
  let urlPath
  try { urlPath = decodeURIComponent((req.url || '/').split('?')[0]) }
  catch { res.writeHead(400); return res.end('Bad request') }

  // Resolve within dist/; anything that escapes → SPA fallback (never the FS).
  // startsWith must include the separator so a sibling dir whose name merely
  // begins with "dist" (e.g. dist-backup) can never be served.
  const candidate = path.normalize(path.join(DIST_DIR, urlPath))
  if ((candidate === DIST_DIR || candidate.startsWith(DIST_DIR + path.sep)) && urlPath !== '/' && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
    return sendFile(res, candidate)
  }
  // SPA fallback — every route (and every subdomain) gets the app shell.
  return sendFile(res, INDEX)
})

server.listen(PORT, () => {
  console.log(`[storefront] serving dist/ on http://localhost:${PORT} (SPA fallback → index.html)`)
})

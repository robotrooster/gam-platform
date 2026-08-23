/**
 * Prerender the marketing site to static files for Vercel.
 *
 * S617 (Nic): "move the marketing page to Vercel." The site has lived on the
 * Mac Studio, which also holds the database and the API — so a brownout at the
 * house took down the public website along with everything else.
 *
 * WHY PRERENDER RATHER THAN REWRITE: server.js is 61KB of carefully built
 * pages, including four that sit on live money paths (guest booking, invoice
 * payment, card update, stay assistant). Rewriting them by hand to be static
 * would risk changing one of those quietly. So this starts the REAL server,
 * fetches every route exactly as a visitor would, and saves what comes back.
 * The output is byte-identical to what has been serving all along.
 *
 * The four token pages need one edit: server.js bakes the token into the page,
 * because it knew the URL. A static file does not, so the baked-in constant is
 * swapped for a line that reads the same value out of the address bar. Nothing
 * else about those pages changes — they were always client-side after that
 * point (see the "No SSR" notes in server.js).
 *
 *   API_URL=https://api.goldassetmanagement.com node build.js
 */
const http = require('http')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

const OUT = path.join(__dirname, 'dist')

// S617: PRODUCTION URLS ARE THE DEFAULT, not an environment variable someone
// has to remember. This build produces the public website. It was written to
// read API_URL from the environment and fall back to localhost, and Vercel runs
// the build from its own saved project settings — with none of that environment
// set. The result built cleanly, deployed, and pointed every booking and
// payment page at http://localhost:4000, which no visitor can reach.
//
// Nothing about that failure is visible in a build log. So the safe value is
// the default and the override is for local work, rather than the other way
// round.
process.env.API_URL      ||= 'https://api.goldassetmanagement.com'
process.env.LANDLORD_URL ||= 'https://landlord.goldassetmanagement.com'
process.env.TENANT_URL   ||= 'https://tenant.goldassetmanagement.com'
const PORT = 3099

/** Every page a visitor can reach, and the file it becomes. */
const STATIC_ROUTES = [
  ['/',                  'index.html'],
  ['/support',           'support.html'],
  ['/business/terms',    'business/terms.html'],
  ['/business/privacy',  'business/privacy.html'],
  ['/consumer/terms',    'consumer/terms.html'],
  ['/consumer/privacy',  'consumer/privacy.html'],
  ['/terms',             'terms.html'],
  ['/privacy',           'privacy.html'],
]

/** Pages whose URL carries a token or slug. One file each; the value is read
 *  from the address bar at load instead of being baked in. */
const TOKENISED = [
  // Lowercase only — server.js matches /^\/book\/([a-z0-9-]+)$/, so an
  // uppercase placeholder falls through to the homepage and silently
  // prerenders the wrong page with a 200.
  ['/book/placeholder-slug',                                                      'book.html',           'SLUG'],
  ['/update-payment/' + 'a'.repeat(64),                                           'update-payment.html', 'TOKEN'],
  ['/account/' + 'b'.repeat(64),                                                  'account.html',        'TOKEN'],
  ['/stay/' + 'c'.repeat(64),                                                     'stay.html',           'TOKEN'],
]

const get = (url) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port: PORT, path: url }, (res) => {
    let body = ''
    res.on('data', (d) => { body += d })
    res.on('end', () => resolve({ status: res.statusCode, body }))
  }).on('error', reject)
})

const write = (rel, html) => {
  const file = path.join(OUT, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, html)
  return html.length
}

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true })
  fs.mkdirSync(OUT, { recursive: true })

  // S617: refuse to build if something is already on the port. A leftover
  // server from an earlier run WILL answer these fetches, and it answers with
  // whatever environment IT was started with — which is how a build run with
  // the production API address still baked in http://localhost:4000 and would
  // have shipped a marketing site whose booking and payment pages pointed at a
  // machine no visitor can reach.
  await new Promise((resolve, reject) => {
    const probe = http.get({ host: '127.0.0.1', port: PORT, path: '/' }, () => {
      reject(new Error(`Port ${PORT} is already in use. Kill it before building:\n` +
                       `  lsof -tiTCP:${PORT} -sTCP:LISTEN | xargs kill`))
    })
    probe.on('error', () => resolve(null))   // nothing there — good
  })

  const server = spawn(process.execPath, ['server.js'], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  await new Promise((r) => setTimeout(r, 1200))

  let failures = 0
  for (const [route, file] of STATIC_ROUTES) {
    const { status, body } = await get(route)
    if (status !== 200 || body.length < 200) { console.error(`  FAIL ${route} -> ${status}`); failures++; continue }
    console.log(`  ok  ${route.padEnd(20)} -> ${file} (${write(file, body)} bytes)`)
  }

  for (const [route, file, constName] of TOKENISED) {
    const { status, body } = await get(route)
    if (status !== 200) { console.error(`  FAIL ${route} -> ${status}`); failures++; continue }
    // Swap the baked-in value for one read from the URL. The page is otherwise
    // untouched — same markup, same script, same API calls.
    const re = new RegExp(`const ${constName} = "[^"]*";`)
    if (!re.test(body)) { console.error(`  FAIL ${file}: could not find "const ${constName} = ...;"`); failures++; continue }
    const patched = body.replace(re,
      `const ${constName} = decodeURIComponent(location.pathname.split('/').filter(Boolean).pop() || '');`)
    console.log(`  ok  ${file.padEnd(24)} ${constName} now read from the URL (${write(file, patched)} bytes)`)
  }

  server.kill()
  if (failures) { console.error(`\n${failures} route(s) failed — not safe to deploy.`); process.exit(1) }
  console.log(`\nPrerendered ${STATIC_ROUTES.length + TOKENISED.length} pages to public/`)
}
main().catch((e) => { console.error(e); process.exit(1) })

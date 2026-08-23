/**
 * Package the prerendered site into Vercel's Build Output API folder.
 *
 * S617: `vercel build` cannot be used here. The Vercel project was created by a
 * first attempt whose settings said framework "node", and those dashboard
 * settings win over vercel.json — so every build detected server.js and emitted
 * a serverless function that ignored the finished pages entirely. Rather than
 * fight a saved setting from a browser, this writes the output folder directly.
 * It is a documented, stable format: static files plus a routing table.
 *
 *   node build.js && node package-output.js && vercel deploy --prebuilt
 */
const fs = require('fs')
const path = require('path')

const DIST = path.join(__dirname, 'dist')
const OUT = path.join(__dirname, '.vercel', 'output')
const LANDLORD = process.env.LANDLORD_URL || 'https://landlord.goldassetmanagement.com'
const TENANT = process.env.TENANT_URL || 'https://tenant.goldassetmanagement.com'

if (!fs.existsSync(DIST)) { console.error('dist/ missing — run build.js first'); process.exit(1) }
fs.rmSync(OUT, { recursive: true, force: true })
fs.mkdirSync(OUT, { recursive: true })
fs.cpSync(DIST, path.join(OUT, 'static'), { recursive: true })

const redirect = (from, to) => ({ src: `^${from}$`, headers: { Location: to }, status: 302 })

fs.writeFileSync(path.join(OUT, 'config.json'), JSON.stringify({
  version: 3,
  routes: [
    // Portal shortcuts — same destinations the Node server sent people to.
    redirect('/landlord', `${LANDLORD}/login`),
    redirect('/login',    `${LANDLORD}/login`),
    redirect('/signin',   `${LANDLORD}/login`),
    redirect('/sign-in',  `${LANDLORD}/login`),
    redirect('/register', `${LANDLORD}/register`),
    redirect('/signup',   `${LANDLORD}/register`),
    redirect('/sign-up',  `${LANDLORD}/register`),
    redirect('/tenant',   `${TENANT}/login`),
    redirect('/tenants',  `${TENANT}/login`),

    { handle: 'filesystem' },

    // Legal + support, reachable with or without .html
    { src: '^/help/?$',              dest: '/support.html' },
    { src: '^/support/?$',           dest: '/support.html' },
    { src: '^/terms/?$',             dest: '/terms.html' },
    { src: '^/privacy/?$',           dest: '/privacy.html' },
    { src: '^/business/terms/?$',    dest: '/business/terms.html' },
    { src: '^/business/privacy/?$',  dest: '/business/privacy.html' },
    { src: '^/consumer/terms/?$',    dest: '/consumer/terms.html' },
    { src: '^/consumer/privacy/?$',  dest: '/consumer/privacy.html' },

    // The four token pages. The slug/token stays in the address bar — the page
    // reads it from there (see build.js), so one file serves every visitor.
    { src: '^/book/[a-z0-9-]+/?$',           dest: '/book.html' },
    { src: '^/update-payment/[a-f0-9]{64}/?$', dest: '/update-payment.html' },
    { src: '^/account/[a-f0-9]{64}/?$',      dest: '/account.html' },
    { src: '^/stay/[a-f0-9]{64}/?$',         dest: '/stay.html' },

    // Anything else lands on the homepage, exactly as before.
    { src: '/.*', dest: '/index.html' },
  ],
}, null, 2))

const files = []
;(function walk(d, base = '') {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    e.isDirectory() ? walk(path.join(d, e.name), `${base}/${e.name}`) : files.push(`${base}/${e.name}`)
  }
})(path.join(OUT, 'static'))
console.log(`packaged ${files.length} files:`, files.join(' '))

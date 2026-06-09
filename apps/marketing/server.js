const http = require('http')
const fs   = require('fs')
const path = require('path')
const { marked } = require('marked')

const PORT = 3004

const HTML = fs.readFileSync(path.join(__dirname, 'src/index.html'), 'utf8')

// Legal docs live in /legal at repo root. Resolve from this server.js
// file at apps/marketing/.
const LEGAL_DIR = path.join(__dirname, '..', '..', 'legal')

// S300 split the legal docs into business vs consumer tracks. Each
// registration surface knows its audience, so it deep-links to the
// audience-specific variant. The bare /terms and /privacy URLs land
// on an audience-picker so visitors coming from external links can
// route themselves.

function renderLegalPage(mdFile, title, audience /* 'business' | 'consumer' */) {
  const md = fs.readFileSync(path.join(LEGAL_DIR, mdFile), 'utf8')
  // Inter-doc references in the MD use relative paths. Rewrite to the
  // audience-scoped public URL paths the site actually serves.
  const rewritten = md
    .replace(/\(\.\/BUSINESS_PRIVACY_POLICY\.md\)/g, '(/business/privacy)')
    .replace(/\(\.\/BUSINESS_TERMS_OF_SERVICE\.md\)/g, '(/business/terms)')
    .replace(/\(\.\/CONSUMER_PRIVACY_POLICY\.md\)/g, '(/consumer/privacy)')
    .replace(/\(\.\/CONSUMER_TERMS_OF_SERVICE\.md\)/g, '(/consumer/terms)')
  const body = marked.parse(rewritten)
  return wrapLegalPage(body, title, audience)
}

function wrapLegalPage(bodyHtml, title, audience) {
  const isBusiness = audience === 'business'
  const audienceLabel = isBusiness ? 'For Landlords & PM Companies' : 'For Tenants'
  const counterpartPath = isBusiness ? '/consumer' : '/business'
  const counterpartLabel = isBusiness ? 'For Tenants' : 'For Landlords & PM Companies'
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title} (${audienceLabel}) — Gold Asset Management</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Syne:wght@600;700;800&family=DM+Sans:ital,wght@0,300;0,400;0,500;0,600;1,400&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg: #080a0c; --bg2: #0d1014; --bg3: #141820;
  --border: #1e2435;
  --text: #f0f2f7; --muted: #8a96b0; --dim: #475060;
  --gold: #c9a227; --gold-dim: rgba(201,162,39,.12);
  --fd: 'Syne',sans-serif; --fb: 'DM Sans',sans-serif; --fm: 'DM Mono',monospace;
}
html{-webkit-font-smoothing:antialiased;scroll-behavior:smooth}
body{font-family:var(--fb);background:var(--bg);color:var(--muted);line-height:1.7;font-size:.95rem}
a{color:var(--gold);text-decoration:none}
a:hover{text-decoration:underline}

/* NAV — minimal, matches marketing aesthetic */
nav{position:sticky;top:0;left:0;right:0;z-index:100;padding:16px 0;border-bottom:1px solid rgba(255,255,255,.04);background:rgba(8,10,12,.92);backdrop-filter:blur(12px)}
.nav-inner{max-width:980px;margin:0 auto;padding:0 24px;display:flex;align-items:center;justify-content:space-between}
.logo{font-family:var(--fd);font-size:1.1rem;font-weight:800;color:var(--gold)}
.nav-links{display:flex;gap:28px;font-size:.875rem}
.nav-links a{color:var(--muted);transition:color .15s}
.nav-links a:hover{color:var(--text);text-decoration:none}

/* AUDIENCE BANNER */
.audience-banner{max-width:980px;margin:0 auto;padding:14px 24px 0;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;font-size:.78rem}
.audience-banner .current{color:var(--gold);font-family:var(--fm);text-transform:uppercase;letter-spacing:.08em}
.audience-banner .switch{color:var(--muted)}

/* DOC */
.doc{max-width:780px;margin:0 auto;padding:24px 24px 120px}
.doc-eyebrow{font-family:var(--fm);font-size:.75rem;color:var(--gold);letter-spacing:.14em;text-transform:uppercase;margin-bottom:16px}
.doc h1{font-family:var(--fd);font-size:clamp(2rem,4vw,2.6rem);font-weight:800;color:var(--text);line-height:1.15;letter-spacing:-.02em;margin-bottom:8px;margin-top:0}
.doc h2{font-family:var(--fd);font-size:1.4rem;font-weight:700;color:var(--text);margin-top:48px;margin-bottom:16px;letter-spacing:-.01em}
.doc h3{font-family:var(--fd);font-size:1.05rem;font-weight:700;color:var(--text);margin-top:32px;margin-bottom:12px}
.doc p{color:var(--muted);margin-bottom:16px}
.doc ul,.doc ol{color:var(--muted);margin-bottom:16px;padding-left:24px}
.doc li{margin-bottom:8px}
.doc li > ul,.doc li > ol{margin-top:8px;margin-bottom:0}
.doc strong{color:var(--text);font-weight:600}
.doc em{color:var(--text)}
.doc hr{border:none;border-top:1px solid var(--border);margin:48px 0}
.doc code{font-family:var(--fm);font-size:.88rem;color:var(--gold);background:var(--gold-dim);padding:2px 6px;border-radius:4px}
.doc blockquote{border-left:3px solid var(--gold);padding-left:16px;margin:24px 0;color:var(--muted);font-style:italic}
.doc table{width:100%;border-collapse:collapse;margin:24px 0;font-size:.82rem}
.doc table th,.doc table td{padding:10px 12px;text-align:left;border-bottom:1px solid var(--border);vertical-align:top}
.doc table th{color:var(--text);font-weight:600;background:var(--bg2);font-size:.78rem;text-transform:uppercase;letter-spacing:.05em}
.doc table td{color:var(--muted)}

/* FOOTER */
footer{border-top:1px solid var(--border);padding:32px 0;background:var(--bg2)}
.footer-inner{max-width:980px;margin:0 auto;padding:0 24px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:16px;font-size:.82rem;color:var(--dim)}
.footer-cols{display:flex;gap:24px;flex-wrap:wrap}
.footer-col{display:flex;flex-direction:column;gap:6px}
.footer-col-title{color:var(--dim);font-family:var(--fm);font-size:.7rem;letter-spacing:.08em;text-transform:uppercase}
.footer-col a{color:var(--muted)}
</style>
</head>
<body>
<nav>
  <div class="nav-inner">
    <a href="/" class="logo">⚡ GAM</a>
    <div class="nav-links">
      <a href="/">Home</a>
      <a href="/terms">Terms</a>
      <a href="/privacy">Privacy</a>
    </div>
  </div>
</nav>
<div class="audience-banner">
  <div class="current">Showing: ${audienceLabel}</div>
  <div class="switch">Looking for the other version? <a href="${counterpartPath}/${title.toLowerCase().includes('terms') ? 'terms' : 'privacy'}">${counterpartLabel}</a></div>
</div>
<div class="doc">
${bodyHtml}
</div>
<footer>
  <div class="footer-inner">
    <div>© ${new Date().getFullYear()} Gold Asset Management LLC</div>
    <div class="footer-cols">
      <div class="footer-col">
        <span class="footer-col-title">Landlords / PM</span>
        <a href="/business/terms">Business Terms</a>
        <a href="/business/privacy">Business Privacy</a>
      </div>
      <div class="footer-col">
        <span class="footer-col-title">Tenants</span>
        <a href="/consumer/terms">Consumer Terms</a>
        <a href="/consumer/privacy">Consumer Privacy</a>
      </div>
      <div class="footer-col">
        <span class="footer-col-title">Contact</span>
        <a href="mailto:support@goldassetmanagement.com">support@</a>
      </div>
    </div>
  </div>
</footer>
</body>
</html>`
}

// Audience-picker page — what visitors hit at /terms and /privacy when
// they haven't been deep-linked from a known audience surface.
function audiencePicker(docKind /* 'terms' | 'privacy' */) {
  const docTitle = docKind === 'terms' ? 'Terms of Service' : 'Privacy Policy'
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${docTitle} — Gold Asset Management</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Syne:wght@600;700;800&family=DM+Sans:ital,wght@0,300;0,400;0,500;0,600;1,400&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg: #080a0c; --bg2: #0d1014; --bg3: #141820;
  --border: #1e2435;
  --text: #f0f2f7; --muted: #8a96b0; --dim: #475060;
  --gold: #c9a227; --gold-dim: rgba(201,162,39,.12);
  --fd: 'Syne',sans-serif; --fb: 'DM Sans',sans-serif; --fm: 'DM Mono',monospace;
}
html{-webkit-font-smoothing:antialiased}
body{font-family:var(--fb);background:var(--bg);color:var(--muted);line-height:1.6;font-size:.95rem;min-height:100vh;display:flex;flex-direction:column}
a{color:var(--gold);text-decoration:none}
a:hover{text-decoration:underline}
nav{padding:16px 0;border-bottom:1px solid rgba(255,255,255,.04);background:rgba(8,10,12,.92)}
.nav-inner{max-width:980px;margin:0 auto;padding:0 24px;display:flex;align-items:center;justify-content:space-between}
.logo{font-family:var(--fd);font-size:1.1rem;font-weight:800;color:var(--gold)}
.nav-links{display:flex;gap:28px;font-size:.875rem}
.nav-links a{color:var(--muted)}
main{flex:1;max-width:780px;width:100%;margin:0 auto;padding:64px 24px}
.eyebrow{font-family:var(--fm);font-size:.75rem;color:var(--gold);letter-spacing:.14em;text-transform:uppercase;margin-bottom:16px}
h1{font-family:var(--fd);font-size:clamp(2rem,4vw,2.4rem);font-weight:800;color:var(--text);line-height:1.15;letter-spacing:-.02em;margin-bottom:14px;margin-top:0}
.intro{color:var(--muted);margin-bottom:36px;max-width:580px;line-height:1.7}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:18px;margin-bottom:32px}
.card{padding:24px;background:var(--bg2);border:1px solid var(--border);border-radius:10px;text-decoration:none;display:block;transition:border-color .15s}
.card:hover{border-color:var(--gold);text-decoration:none}
.card-eyebrow{font-family:var(--fm);font-size:.72rem;color:var(--gold);letter-spacing:.1em;text-transform:uppercase;margin-bottom:10px}
.card-title{font-family:var(--fd);font-size:1.15rem;font-weight:700;color:var(--text);margin-bottom:8px}
.card-desc{font-size:.86rem;color:var(--muted);line-height:1.6}
footer{border-top:1px solid var(--border);padding:24px 0;background:var(--bg2);font-size:.78rem;color:var(--dim)}
.footer-inner{max-width:980px;margin:0 auto;padding:0 24px;text-align:center}
</style>
</head>
<body>
<nav>
  <div class="nav-inner">
    <a href="/" class="logo">⚡ GAM</a>
    <div class="nav-links">
      <a href="/">Home</a>
      <a href="/terms">Terms</a>
      <a href="/privacy">Privacy</a>
    </div>
  </div>
</nav>
<main>
  <div class="eyebrow">${docTitle}</div>
  <h1>Which version applies to you?</h1>
  <p class="intro">GAM serves both business users (landlords, property-management companies, and their staff) and tenants who pay rent through the platform. Different ${docTitle.toLowerCase()} terms apply to each. Pick the one that matches your role:</p>
  <div class="cards">
    <a class="card" href="/business/${docKind}">
      <div class="card-eyebrow">Business</div>
      <div class="card-title">${docTitle} for Landlords &amp; PM Companies</div>
      <div class="card-desc">Owners, property-management companies, and the staff or contractors operating under them (property managers, maintenance workers, bookkeepers).</div>
    </a>
    <a class="card" href="/consumer/${docKind}">
      <div class="card-eyebrow">Consumer</div>
      <div class="card-title">${docTitle} for Tenants</div>
      <div class="card-desc">Tenants renting a unit from a landlord listed on the platform and paying rent through GAM.</div>
    </a>
  </div>
</main>
<footer>
  <div class="footer-inner">© ${new Date().getFullYear()} Gold Asset Management LLC · <a href="mailto:support@goldassetmanagement.com">support@goldassetmanagement.com</a></div>
</footer>
</body>
</html>`
}

// Render once at startup. Restart the server to pick up doc edits in
// dev. In production these are baked into the build.
let BUSINESS_TERMS_HTML, BUSINESS_PRIVACY_HTML, CONSUMER_TERMS_HTML, CONSUMER_PRIVACY_HTML
let TERMS_PICKER, PRIVACY_PICKER
try {
  BUSINESS_TERMS_HTML   = renderLegalPage('BUSINESS_TERMS_OF_SERVICE.md',  'Terms of Service', 'business')
  BUSINESS_PRIVACY_HTML = renderLegalPage('BUSINESS_PRIVACY_POLICY.md',    'Privacy Policy',   'business')
  CONSUMER_TERMS_HTML   = renderLegalPage('CONSUMER_TERMS_OF_SERVICE.md',  'Terms of Service', 'consumer')
  CONSUMER_PRIVACY_HTML = renderLegalPage('CONSUMER_PRIVACY_POLICY.md',    'Privacy Policy',   'consumer')
  TERMS_PICKER   = audiencePicker('terms')
  PRIVACY_PICKER = audiencePicker('privacy')
} catch (err) {
  console.error('Failed to render legal pages:', err.message)
  const fallback = '<h1>Legal documents temporarily unavailable</h1>'
  BUSINESS_TERMS_HTML = BUSINESS_PRIVACY_HTML = CONSUMER_TERMS_HTML = CONSUMER_PRIVACY_HTML = fallback
  TERMS_PICKER = PRIVACY_PICKER = fallback
}

http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0].replace(/\/$/, '') || '/'
  const send = (html) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(html)
  }

  // Audience-scoped legal pages
  if (url === '/business/terms')   return send(BUSINESS_TERMS_HTML)
  if (url === '/business/privacy') return send(BUSINESS_PRIVACY_HTML)
  if (url === '/consumer/terms')   return send(CONSUMER_TERMS_HTML)
  if (url === '/consumer/privacy') return send(CONSUMER_PRIVACY_HTML)

  // Bare /terms and /privacy → audience picker (external links land here)
  if (url === '/terms')   return send(TERMS_PICKER)
  if (url === '/privacy') return send(PRIVACY_PICKER)

  // Default: the marketing landing page
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(HTML)
}).listen(PORT, () => console.log(`Marketing site: http://localhost:${PORT}`))

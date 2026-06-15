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

  // S507: customer self-service booking page. /book/:slug.
  // The slug is validated server-side by /api/public/booking/:slug;
  // this page is a thin shell that talks to that API entirely
  // client-side. No SSR — keeps the marketing server simple.
  const bookMatch = url.match(/^\/book\/([a-z0-9-]+)$/)
  if (bookMatch) return send(renderBookingShell(bookMatch[1]))

  // S510: card-update page. /update-payment/:token. Token is
  // validated server-side by /api/public/update-payment/:token; this
  // page uses Stripe.js + Elements to collect the new card client-side.
  const updateMatch = url.match(/^\/update-payment\/([a-f0-9]{64})$/)
  if (updateMatch) return send(renderCardUpdateShell(updateMatch[1]))

  // Default: the marketing landing page
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(HTML)
}).listen(PORT, () => console.log(`Marketing site: http://localhost:${PORT}`))

// S507: booking page shell. All logic + state lives in inline JS that
// hits the API directly. Server-side is just the HTML scaffold so the
// page renders on first paint with no JS framework boot.
function renderBookingShell(slug) {
  const apiBase = process.env.API_URL || 'http://localhost:4000'
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Book — Gold Asset Management</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Syne:wght@600;700;800&family=DM+Sans:ital,wght@0,300;0,400;0,500;0,600;1,400&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#080a0c; --bg2:#0d1014; --bg3:#141820;
  --border:#1e2435;
  --text:#f0f2f7; --muted:#8a96b0; --dim:#475060;
  --gold:#c9a227; --gold-dim:rgba(201,162,39,.12);
  --green:#22c55e; --red:#ef4444;
  --fd:'Syne',sans-serif; --fb:'DM Sans',sans-serif; --fm:'DM Mono',monospace;
}
body{font-family:var(--fb);background:var(--bg);color:var(--text);line-height:1.6;font-size:.95rem;min-height:100vh}
a{color:var(--gold);text-decoration:none}
.shell{max-width:680px;margin:0 auto;padding:48px 24px 120px}
.eyebrow{font-family:var(--fm);font-size:.7rem;color:var(--gold);letter-spacing:.16em;text-transform:uppercase;margin-bottom:14px}
h1{font-family:var(--fd);font-size:clamp(1.8rem,3.5vw,2.4rem);font-weight:800;letter-spacing:-.02em;margin-bottom:6px}
.muted{color:var(--muted)}
.card{background:var(--bg2);border:1px solid var(--border);border-radius:14px;padding:24px;margin-top:20px}
.card h2{font-family:var(--fd);font-size:1.05rem;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--muted);margin-bottom:14px}
.svc{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;padding:12px;border:1px solid var(--border);border-radius:10px;cursor:pointer;background:transparent;color:var(--text);text-align:left;width:100%;font-family:inherit;font-size:.93rem;margin-bottom:8px;transition:all .15s}
.svc:hover{border-color:var(--gold)}
.svc.selected{border-color:var(--gold);background:var(--gold-dim)}
.svc-name{font-weight:600;margin-bottom:4px}
.svc-desc{color:var(--muted);font-size:.82rem;line-height:1.5}
.svc-meta{font-family:var(--fm);font-size:.78rem;color:var(--muted);text-align:right;white-space:nowrap}
.svc-price{color:var(--gold);font-weight:600;margin-top:2px}
label{display:block;color:var(--muted);font-size:.75rem;text-transform:uppercase;letter-spacing:.08em;margin-bottom:6px;margin-top:14px}
input[type=text],input[type=email],input[type=tel],input[type=date],textarea{width:100%;padding:11px 14px;background:var(--bg3);color:var(--text);border:1px solid var(--border);border-radius:8px;font-family:inherit;font-size:.92rem;outline:none}
input:focus,textarea:focus{border-color:var(--gold)}
textarea{resize:vertical;min-height:80px;font-family:var(--fb)}
.slots{display:grid;grid-template-columns:repeat(auto-fill,minmax(86px,1fr));gap:8px;margin-top:8px}
.slot{background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:10px;color:var(--text);font-family:var(--fm);font-size:.85rem;cursor:pointer;text-align:center;transition:all .15s}
.slot:hover{border-color:var(--gold)}
.slot.selected{border-color:var(--gold);background:var(--gold);color:var(--bg)}
.btn{display:inline-block;padding:14px 24px;background:var(--gold);color:var(--bg);border:none;border-radius:10px;font-weight:700;font-size:.92rem;cursor:pointer;font-family:inherit;width:100%;margin-top:20px}
.btn:disabled{opacity:.4;cursor:not-allowed}
.alert{padding:12px 14px;border-radius:8px;font-size:.85rem;margin-bottom:14px}
.alert.err{background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.4);color:var(--red)}
.alert.ok{background:rgba(34,197,94,.08);border:1px solid rgba(34,197,94,.4);color:var(--green)}
.day{margin-bottom:18px}
.day-head{font-family:var(--fm);font-size:.78rem;color:var(--muted);letter-spacing:.08em;margin-bottom:6px;text-transform:uppercase}
.day-closed{font-size:.8rem;color:var(--dim);font-style:italic;margin-top:4px}
.confirm{text-align:center;padding:48px 24px}
.confirm-icon{font-size:48px;margin-bottom:18px}
.row{display:flex;gap:12px}
.row > *{flex:1}
.footer{text-align:center;color:var(--dim);font-size:.75rem;margin-top:48px}
.footer a{color:var(--muted)}
</style>
</head>
<body>
<div class="shell">
  <div id="root">
    <div class="muted" style="text-align:center;padding:48px">Loading…</div>
  </div>
  <div class="footer">
    Powered by <a href="/">GAM</a>
  </div>
</div>
<script>
const SLUG = ${JSON.stringify(slug)};
const API = ${JSON.stringify(apiBase)};
const ROOT = document.getElementById('root');

let state = {
  step: 'service',  // service → time → contact → confirm
  business: null,
  services: [],
  hours: {},
  selectedServiceId: null,
  fromDate: today(),
  days: [],
  selectedSlot: null,  // { date, time }
  contact: { firstName: '', lastName: '', email: '', phone: '', notes: '' },
  confirmation: null,
  err: null,
  loading: false,
};

function today() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

function addDays(iso, n) {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + n);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

function fmtDay(iso) {
  const d = new Date(iso + 'T12:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

function fmtSlot(t) {
  const [h, m] = t.split(':').map(n => parseInt(n, 10));
  const dt = new Date();
  dt.setHours(h, m, 0, 0);
  return dt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function fmtPrice(p) {
  if (p == null) return '';
  return '$' + Number(p).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function fmtDuration(m) {
  if (m < 60) return m + ' min';
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r === 0 ? h + ' hr' : h + ' hr ' + r + ' min';
}

function esc(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

async function loadBusiness() {
  state.loading = true; render();
  try {
    const r = await fetch(API + '/api/public/booking/' + SLUG);
    if (!r.ok) {
      const err = await r.json().catch(() => ({ error: 'Not found' }));
      throw new Error(err.error || 'Could not load this booking page.');
    }
    const j = await r.json();
    state.business = j.data;
    state.services = j.data.services;
    state.hours = j.data.business_hours;
    state.err = null;
  } catch (e) {
    state.err = e.message;
  } finally {
    state.loading = false; render();
  }
}

async function loadAvailability() {
  state.loading = true; render();
  try {
    const to = addDays(state.fromDate, 13);
    const r = await fetch(API + '/api/public/booking/' + SLUG +
      '/availability?serviceId=' + state.selectedServiceId +
      '&fromDate=' + state.fromDate + '&toDate=' + to);
    if (!r.ok) throw new Error('Could not load availability');
    const j = await r.json();
    state.days = j.data.days;
    state.err = null;
  } catch (e) {
    state.err = e.message;
  } finally {
    state.loading = false; render();
  }
}

async function submitBooking() {
  state.loading = true; state.err = null; render();
  try {
    const scheduledFor = state.selectedSlot.date + 'T' + state.selectedSlot.time + ':00';
    // Convert local time to ISO. new Date(localStr).toISOString() respects browser TZ.
    const iso = new Date(scheduledFor).toISOString();
    const r = await fetch(API + '/api/public/booking/' + SLUG + '/book', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        serviceId: state.selectedServiceId,
        scheduledFor: iso,
        firstName: state.contact.firstName,
        lastName: state.contact.lastName,
        email: state.contact.email,
        phone: state.contact.phone,
        notes: state.contact.notes || undefined,
      }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({ error: 'Booking failed' }));
      throw new Error(err.error || 'Booking failed');
    }
    const j = await r.json();
    state.confirmation = j.data;
    state.step = 'confirm';
  } catch (e) {
    state.err = e.message;
  } finally {
    state.loading = false; render();
  }
}

function pickService(id) {
  state.selectedServiceId = id;
  state.selectedSlot = null;
  state.step = 'time';
  render();
  loadAvailability();
}

function pickSlot(date, time) {
  state.selectedSlot = { date, time };
  state.step = 'contact';
  render();
}

function setContact(field, value) {
  state.contact[field] = value;
}

function back() {
  if (state.step === 'time') state.step = 'service';
  else if (state.step === 'contact') state.step = 'time';
  render();
}

function render() {
  if (!state.business && !state.err) {
    ROOT.innerHTML = '<div class="muted" style="text-align:center;padding:48px">Loading…</div>';
    return;
  }
  if (state.err && !state.business) {
    ROOT.innerHTML = '<div class="alert err">' + esc(state.err) + '</div>';
    return;
  }

  let html = '';
  html += '<div class="eyebrow">Book an appointment</div>';
  html += '<h1>' + esc(state.business.name) + '</h1>';
  if (state.business.intro) {
    html += '<p class="muted" style="margin-top:8px">' + esc(state.business.intro) + '</p>';
  }

  if (state.err) {
    html += '<div class="alert err" style="margin-top:16px">' + esc(state.err) + '</div>';
  }

  if (state.step === 'service') {
    html += renderServiceStep();
  } else if (state.step === 'time') {
    html += renderTimeStep();
  } else if (state.step === 'contact') {
    html += renderContactStep();
  } else if (state.step === 'confirm') {
    html += renderConfirm();
  }

  ROOT.innerHTML = html;
  attachHandlers();
}

function renderServiceStep() {
  let html = '<div class="card"><h2>Pick a service</h2>';
  if (state.services.length === 0) {
    html += '<div class="muted">No services available right now.</div>';
  } else {
    state.services.forEach(s => {
      html += '<button class="svc" data-service-id="' + s.id + '">';
      html += '<div><div class="svc-name">' + esc(s.name) + '</div>';
      if (s.description) html += '<div class="svc-desc">' + esc(s.description) + '</div>';
      html += '</div>';
      html += '<div class="svc-meta">' + esc(fmtDuration(s.duration_minutes));
      if (s.price !== null) html += '<div class="svc-price">' + esc(fmtPrice(s.price)) + '</div>';
      html += '</div></button>';
    });
  }
  html += '</div>';
  return html;
}

function renderTimeStep() {
  const svc = state.services.find(s => s.id === state.selectedServiceId);
  let html = '<div class="card">';
  html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">';
  html += '<h2 style="margin:0">Pick a time</h2>';
  html += '<button class="muted" id="backBtn" style="background:none;border:none;color:var(--muted);cursor:pointer;font-family:inherit;font-size:.85rem">← Change service</button>';
  html += '</div>';
  html += '<div class="muted" style="margin-bottom:16px;font-size:.85rem">' +
    esc(svc.name) + ' — ' + esc(fmtDuration(svc.duration_minutes)) + '</div>';
  if (state.loading) {
    html += '<div class="muted">Loading available times…</div>';
  } else {
    let hadAny = false;
    state.days.forEach(d => {
      if (d.slots.length === 0) return;
      hadAny = true;
      html += '<div class="day">';
      html += '<div class="day-head">' + esc(fmtDay(d.date)) + '</div>';
      html += '<div class="slots">';
      d.slots.forEach(t => {
        html += '<button class="slot" data-date="' + d.date + '" data-time="' + t + '">' + esc(fmtSlot(t)) + '</button>';
      });
      html += '</div></div>';
    });
    if (!hadAny) {
      html += '<div class="muted">No available times in this window. Check back tomorrow or contact ' +
        esc(state.business.name) + ' directly.</div>';
    }
  }
  html += '</div>';
  return html;
}

function renderContactStep() {
  const svc = state.services.find(s => s.id === state.selectedServiceId);
  const slot = state.selectedSlot;
  let html = '<div class="card">';
  html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">';
  html += '<h2 style="margin:0">Your info</h2>';
  html += '<button class="muted" id="backBtn" style="background:none;border:none;color:var(--muted);cursor:pointer;font-family:inherit;font-size:.85rem">← Change time</button>';
  html += '</div>';
  html += '<div style="padding:12px 14px;background:var(--gold-dim);border-radius:8px;margin-bottom:18px;font-size:.88rem">';
  html += '<strong>' + esc(svc.name) + '</strong><br>';
  html += esc(fmtDay(slot.date)) + ' at ' + esc(fmtSlot(slot.time));
  html += '</div>';
  html += '<div class="row">';
  html += '<div><label>First name</label><input type="text" id="firstName" value="' + esc(state.contact.firstName) + '"></div>';
  html += '<div><label>Last name</label><input type="text" id="lastName" value="' + esc(state.contact.lastName) + '"></div>';
  html += '</div>';
  html += '<label>Email</label><input type="email" id="email" value="' + esc(state.contact.email) + '">';
  html += '<label>Phone</label><input type="tel" id="phone" value="' + esc(state.contact.phone) + '">';
  html += '<label>Anything we should know? (optional)</label>';
  html += '<textarea id="notes">' + esc(state.contact.notes) + '</textarea>';
  html += '<button class="btn" id="submitBtn"' + (state.loading ? ' disabled' : '') + '>' +
    (state.loading ? 'Booking…' : 'Confirm booking') + '</button>';
  html += '</div>';
  return html;
}

function renderConfirm() {
  const slot = state.selectedSlot;
  const svc = state.services.find(s => s.id === state.selectedServiceId);
  let html = '<div class="card confirm">';
  html += '<div class="confirm-icon">✓</div>';
  html += '<h2 style="font-family:var(--fd);color:var(--text);font-size:1.4rem;margin-bottom:8px;text-transform:none;letter-spacing:0">You\\'re booked.</h2>';
  html += '<p class="muted">' + esc(svc.name) + ' with <strong style="color:var(--text)">' +
    esc(state.business.name) + '</strong></p>';
  html += '<p style="color:var(--gold);font-family:var(--fm);font-size:.95rem;margin-top:12px">' +
    esc(fmtDay(slot.date)) + ' · ' + esc(fmtSlot(slot.time)) + '</p>';
  html += '<p class="muted" style="margin-top:18px;font-size:.85rem">A confirmation email is on its way to <strong style="color:var(--text)">' +
    esc(state.contact.email) + '</strong>.</p>';
  html += '</div>';
  return html;
}

function attachHandlers() {
  document.querySelectorAll('.svc').forEach(el => {
    el.addEventListener('click', () => pickService(el.dataset.serviceId));
  });
  document.querySelectorAll('.slot').forEach(el => {
    el.addEventListener('click', () => pickSlot(el.dataset.date, el.dataset.time));
  });
  const back = document.getElementById('backBtn');
  if (back) back.addEventListener('click', () => {
    if (state.step === 'time') state.step = 'service';
    else if (state.step === 'contact') state.step = 'time';
    render();
  });
  const sb = document.getElementById('submitBtn');
  if (sb) sb.addEventListener('click', () => {
    state.contact.firstName = document.getElementById('firstName').value;
    state.contact.lastName  = document.getElementById('lastName').value;
    state.contact.email     = document.getElementById('email').value;
    state.contact.phone     = document.getElementById('phone').value;
    state.contact.notes     = document.getElementById('notes').value;
    if (!state.contact.firstName.trim() || !state.contact.lastName.trim() ||
        !state.contact.email.trim() || !state.contact.phone.trim()) {
      state.err = 'Please fill in name, email, and phone.';
      render();
      return;
    }
    submitBooking();
  });
}

loadBusiness();
</script>
</body>
</html>`
}

// S510: card-update page. Uses Stripe.js + Elements. The server-rendered
// HTML is a thin shell; all logic lives in inline JS that hits the
// public API for the SetupIntent client_secret + the confirm endpoint.
function renderCardUpdateShell(token) {
  const apiBase = process.env.API_URL || 'http://localhost:4000'
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Update payment method — Gold Asset Management</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Syne:wght@600;700;800&family=DM+Sans:ital,wght@0,300;0,400;0,500;0,600&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">
<script src="https://js.stripe.com/v3/"></script>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#080a0c; --bg2:#0d1014; --bg3:#141820;
  --border:#1e2435;
  --text:#f0f2f7; --muted:#8a96b0; --dim:#475060;
  --gold:#c9a227; --gold-dim:rgba(201,162,39,.12);
  --green:#22c55e; --red:#ef4444;
  --fd:'Syne',sans-serif; --fb:'DM Sans',sans-serif; --fm:'DM Mono',monospace;
}
body{font-family:var(--fb);background:var(--bg);color:var(--text);line-height:1.6;font-size:.95rem;min-height:100vh}
.shell{max-width:520px;margin:0 auto;padding:48px 24px 120px}
.eyebrow{font-family:var(--fm);font-size:.7rem;color:var(--gold);letter-spacing:.16em;text-transform:uppercase;margin-bottom:14px}
h1{font-family:var(--fd);font-size:clamp(1.6rem,3vw,2rem);font-weight:800;letter-spacing:-.02em;margin-bottom:6px}
.muted{color:var(--muted)}
.card{background:var(--bg2);border:1px solid var(--border);border-radius:14px;padding:24px;margin-top:20px}
.existing{padding:14px;background:var(--bg3);border-radius:8px;margin-bottom:18px;font-size:.88rem}
.existing-label{font-family:var(--fm);font-size:.7rem;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;margin-bottom:6px}
.invoice-context{padding:12px 14px;background:var(--gold-dim);border-radius:8px;margin-bottom:18px;font-size:.85rem;color:var(--text)}
#card-element{padding:14px;background:var(--bg3);border:1px solid var(--border);border-radius:8px;margin-bottom:14px}
.btn{display:inline-block;padding:14px 24px;background:var(--gold);color:var(--bg);border:none;border-radius:10px;font-weight:700;font-size:.92rem;cursor:pointer;font-family:inherit;width:100%}
.btn:disabled{opacity:.4;cursor:not-allowed}
.alert{padding:12px 14px;border-radius:8px;font-size:.85rem;margin-bottom:14px}
.alert.err{background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.4);color:var(--red)}
.alert.ok{background:rgba(34,197,94,.08);border:1px solid rgba(34,197,94,.4);color:var(--green)}
.confirm{text-align:center;padding:48px 24px}
.confirm-icon{font-size:48px;margin-bottom:18px}
.footer{text-align:center;color:var(--dim);font-size:.75rem;margin-top:48px}
.footer a{color:var(--muted);text-decoration:none}
</style>
</head>
<body>
<div class="shell">
  <div id="root">
    <div class="muted" style="text-align:center;padding:48px">Loading…</div>
  </div>
  <div class="footer">Powered by <a href="/">GAM</a></div>
</div>
<script>
const TOKEN = ${JSON.stringify(token)};
const API = ${JSON.stringify(apiBase)};
const ROOT = document.getElementById('root');

let state = {
  loading: true,
  err: null,
  data: null,
  stripe: null,
  elements: null,
  cardElement: null,
  submitting: false,
  done: false,
  confirmation: null,
};

function esc(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
function fmtMoney(n) {
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function load() {
  try {
    const r = await fetch(API + '/api/public/update-payment/' + TOKEN);
    if (!r.ok) {
      const j = await r.json().catch(() => ({ error: 'Could not load this update link.' }));
      throw new Error(j.error || 'Could not load this update link.');
    }
    const j = await r.json();
    state.data = j.data;
    if (!j.data.publishable_key) {
      throw new Error('Stripe is not configured on this server.');
    }
    state.stripe = window.Stripe(j.data.publishable_key);
    state.loading = false;
    render();
    mountElements();
  } catch (e) {
    state.err = e.message;
    state.loading = false;
    render();
  }
}

function mountElements() {
  if (!state.stripe || !state.data) return;
  state.elements = state.stripe.elements({
    clientSecret: state.data.client_secret,
    appearance: {
      theme: 'night',
      variables: {
        colorPrimary: '#c9a227',
        colorBackground: '#141820',
        colorText: '#f0f2f7',
        colorDanger: '#ef4444',
        fontFamily: 'DM Sans, sans-serif',
        borderRadius: '8px',
      },
    },
  });
  state.cardElement = state.elements.create('payment', {
    layout: { type: 'tabs' },
  });
  state.cardElement.mount('#card-element');
}

async function submit() {
  if (!state.elements) return;
  state.submitting = true;
  state.err = null;
  render();
  try {
    const { error: submitErr, setupIntent } = await state.stripe.confirmSetup({
      elements: state.elements,
      confirmParams: { return_url: window.location.href },
      redirect: 'if_required',
    });
    if (submitErr) throw new Error(submitErr.message || 'Confirmation failed');
    if (!setupIntent || setupIntent.status !== 'succeeded') {
      throw new Error('Setup did not complete; please try again.');
    }
    const r = await fetch(API + '/api/public/update-payment/' + TOKEN + '/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ setupIntentId: setupIntent.id }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({ error: 'Save failed' }));
      throw new Error(j.error || 'Save failed');
    }
    const j = await r.json();
    state.confirmation = j.data;
    state.done = true;
  } catch (e) {
    state.err = e.message;
  } finally {
    state.submitting = false;
    render();
    // Re-mount the card element (it gets destroyed on render).
    if (!state.done && state.elements) mountElements();
  }
}

function render() {
  let html = '';
  if (state.loading) {
    ROOT.innerHTML = '<div class="muted" style="text-align:center;padding:48px">Loading…</div>';
    return;
  }
  if (state.err && !state.data) {
    ROOT.innerHTML = '<div class="card"><div class="alert err">' + esc(state.err) + '</div></div>';
    return;
  }
  if (state.done) {
    html += '<div class="card confirm">';
    html += '<div class="confirm-icon">✓</div>';
    html += '<h2 style="font-family:var(--fd);color:var(--text);font-size:1.4rem;margin-bottom:8px">You\\'re all set.</h2>';
    if (state.confirmation && state.confirmation.card_brand) {
      html += '<p class="muted">Saved <strong style="color:var(--text)">' +
        esc(state.confirmation.card_brand.toUpperCase()) + ' ····' +
        esc(state.confirmation.card_last4) + '</strong> as your payment method for ' +
        esc(state.data.business_name) + '.</p>';
    }
    html += '<p class="muted" style="margin-top:18px;font-size:.85rem">You can close this page.</p>';
    html += '</div>';
    ROOT.innerHTML = html;
    return;
  }
  html += '<div class="eyebrow">Update payment method</div>';
  html += '<h1>' + esc(state.data.business_name) + '</h1>';
  if (state.data.customer_name) {
    html += '<p class="muted" style="margin-top:6px">Hi ' + esc(state.data.customer_name) + ',</p>';
  }
  html += '<div class="card">';
  if (state.err) {
    html += '<div class="alert err">' + esc(state.err) + '</div>';
  }
  if (state.data.invoice) {
    html += '<div class="invoice-context">For invoice <strong>' +
      esc(state.data.invoice.invoice_number) + '</strong> · ' +
      fmtMoney(state.data.invoice.total_amount) + '</div>';
  }
  if (state.data.existing_card) {
    html += '<div class="existing">';
    html += '<div class="existing-label">Currently on file</div>';
    html += esc(state.data.existing_card.brand.toUpperCase()) + ' ····' +
      esc(state.data.existing_card.last4);
    html += '</div>';
  }
  html += '<div id="card-element"></div>';
  html += '<button class="btn" id="submitBtn"' + (state.submitting ? ' disabled' : '') + '>' +
    (state.submitting ? 'Saving…' : 'Save new card') + '</button>';
  html += '</div>';
  ROOT.innerHTML = html;
  const sb = document.getElementById('submitBtn');
  if (sb) sb.addEventListener('click', submit);
}

load();
</script>
</body>
</html>`
}

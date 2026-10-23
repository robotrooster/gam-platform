/**
 * 10/23 (Nic) — THIS PORTAL RETIRED. IT IS PART OF THE LANDLORD PORTAL NOW.
 *
 *   "Blue's going to be property managing for some other people. And he doesn't
 *    necessarily want to toggle between portals with a different login. He
 *    wants to just adjust a view in the same screen."
 *
 * Thirteen pages and thirty endpoints moved, and nothing was lost — the
 * inventory is in PM_FOLD_PLAN.md at the repo root. A management company is an
 * entity on an account now, not an app: the company picker groups the companies
 * you own and the ones you manage for other people, every property page reads
 * both, and the company's own side of the business — the owners it works for,
 * its rate sheets, its staff, its bank account — is the Management section.
 *
 * WHAT IS LEFT HERE IS A DOOR, not an app. The subdomain stays alive so that
 * anybody with it bookmarked, or in an old email, lands somewhere that tells
 * them where to go instead of on a dead host. One page, no login, no data, no
 * API call.
 */
const LANDLORD_PORTAL = 'https://landlord.goldassetmanagement.com'

const root = document.getElementById('root')
if (root) {
  root.innerHTML = `
    <main style="min-height:100vh;display:flex;align-items:center;justify-content:center;
                 background:#0d0f12;color:#e8e6e3;font-family:system-ui,-apple-system,sans-serif;
                 padding:24px;text-align:center">
      <div style="max-width:30rem">
        <h1 style="font-size:1.35rem;margin:0 0 .75rem;color:#d4af37">Property management moved</h1>
        <p style="margin:0 0 1rem;line-height:1.6;color:#b4b0aa">
          It is part of your landlord portal now &mdash; one login for the properties you own and
          the ones you manage for other people, with the company picker to switch between them.
        </p>
        <p style="margin:0 0 1.5rem;line-height:1.6;color:#817d77;font-size:.9rem">
          Your owners, rate sheets, staff and banking are under <strong>Management</strong>.
        </p>
        <a href="${LANDLORD_PORTAL}" style="display:inline-block;background:#d4af37;color:#1a1a1a;
           padding:.7rem 1.4rem;border-radius:.4rem;text-decoration:none;font-weight:600">
          Go to the landlord portal
        </a>
      </div>
    </main>`
}

// A bookmark should not need a click. Long enough to read why first.
setTimeout(() => { window.location.replace(LANDLORD_PORTAL) }, 6000)

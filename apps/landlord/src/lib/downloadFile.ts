/**
 * Fetch a protected document with the session token and hand it to the browser.
 *
 * S637 (Nic): "if I click to download, it pulls up with a page that says this
 * page doesn't exist, and then it says go back to the dashboard."
 *
 * The GoldSign list rendered `<a href={d.executedPdfUrl}>`, and executedPdfUrl
 * is stored RELATIVE — '/api/esign/files/executed-<id>.pdf'. On
 * landlord.goldassetmanagement.com a relative href resolves against the
 * FRONTEND host, so the request never reached the API at all: the SPA answered
 * with its own not-found page. That is the "go back to the dashboard" screen.
 *
 * Pointing it at the API host alone would not have fixed it either. That route
 * is authed (authOrSignerTokenQuery), and a plain anchor sends no Authorization
 * header, so it would have 401'd instead of 404'd — a different error page for
 * the same missing lease.
 *
 * So: fetch it with the bearer token, turn the bytes into a blob URL, and click
 * a synthetic anchor. Same shape ExpensesPage already uses for receipts, which
 * is the other authed-file surface in this app.
 */
const API_BASE = (import.meta as any).env?.VITE_API_URL || 'http://localhost:4000'

/** '/api/esign/files/x.pdf' or 'https://…' → an absolute URL on the API host. */
function absolute(url: string): string {
  if (/^https?:\/\//i.test(url)) return url
  return `${API_BASE}${url.startsWith('/') ? '' : '/'}${url}`
}

async function fetchAsBlobUrl(url: string): Promise<string> {
  const token = localStorage.getItem('gam_token') || ''
  const r = await fetch(absolute(url), { headers: { Authorization: 'Bearer ' + token } })
  if (!r.ok) throw new Error(`status ${r.status}`)
  return URL.createObjectURL(await r.blob())
}

/** Save the document to disk under `filename`. */
export async function downloadAuthedFile(url: string, filename: string): Promise<void> {
  const obj = await fetchAsBlobUrl(url)
  const a = document.createElement('a')
  a.href = obj
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Revoked on a delay: Safari aborts the save if the URL dies too soon.
  setTimeout(() => URL.revokeObjectURL(obj), 60000)
}

/**
 * Open the document in a hidden frame and raise the print dialog.
 *
 * Nic: "there's no option to print or download from this screen... maybe we add
 * them in the same area where the download button isn't working."
 *
 * Printing the PAGE would print the portal chrome around a canvas. This prints
 * the PDF itself, at full fidelity, which is what a lease being printed for a
 * signature file has to be.
 */
export async function printAuthedFile(url: string): Promise<void> {
  const obj = await fetchAsBlobUrl(url)
  const frame = document.createElement('iframe')
  frame.style.position = 'fixed'
  frame.style.right = '0'
  frame.style.bottom = '0'
  frame.style.width = '0'
  frame.style.height = '0'
  frame.style.border = '0'
  frame.src = obj
  document.body.appendChild(frame)
  frame.onload = () => {
    try { frame.contentWindow?.focus(); frame.contentWindow?.print() } catch { /* blocked — the download button is the fallback */ }
  }
  setTimeout(() => { frame.remove(); URL.revokeObjectURL(obj) }, 120000)
}

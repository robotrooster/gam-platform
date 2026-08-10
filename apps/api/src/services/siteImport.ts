/**
 * S601 — booking-site importer.
 *
 * Fetches a landlord's EXISTING public website and extracts its content into the
 * structured booking-site model (story / photos / contact) so they don't start
 * from scratch — and the site still renders in GAM's layout, stays bookable, and
 * can join cross-property calendar features ([[gam-roadtrip-trip-planner]]). This
 * is import → editable template, NOT verbatim hosting.
 *
 * SECURITY (SSRF): this fetches an ARBITRARY user-supplied URL server-side.
 * assertPublicUrl() blocks non-http(s), localhost, and any host resolving to a
 * private / loopback / link-local / CGNAT / metadata (169.254.169.254) address,
 * and it re-validates EVERY redirect hop (redirect-based SSRF). Bodies are size-
 * and time-capped. Extraction is deterministic (cheerio) — no third-party AI, all
 * on GAM hardware (CLAUDE.md).
 */
import { load } from 'cheerio'
import dns from 'dns/promises'
import net from 'net'
import { AppError } from '../middleware/errorHandler'

const FETCH_TIMEOUT_MS = 8000
const MAX_HTML_BYTES = 5 * 1024 * 1024
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const MAX_REDIRECTS = 3

/** Private / reserved IPv4 + IPv6 ranges that must never be fetched. */
export function isBlockedIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number)
    if (a === 0 || a === 10 || a === 127) return true          // this-net / private / loopback
    if (a === 169 && b === 254) return true                    // link-local (incl. 169.254.169.254 metadata)
    if (a === 172 && b >= 16 && b <= 31) return true           // private
    if (a === 192 && b === 168) return true                    // private
    if (a === 100 && b >= 64 && b <= 127) return true          // CGNAT
    if (a >= 224) return true                                   // multicast / reserved
    return false
  }
  const lower = ip.toLowerCase()
  if (lower === '::1' || lower === '::') return true            // loopback / unspecified
  if (lower.startsWith('fe80')) return true                    // link-local
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true // unique-local
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)   // IPv4-mapped
  if (mapped) return isBlockedIp(mapped[1])
  return false
}

/** Validate protocol + resolve host, rejecting any private/reserved target. */
export async function assertPublicUrl(raw: string): Promise<URL> {
  let u: URL
  try { u = new URL(raw) } catch { throw new AppError(400, 'Enter a valid website URL (including https://).') }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new AppError(400, 'Only http(s) websites can be imported.')
  const host = u.hostname
  if (!host || host.toLowerCase() === 'localhost') throw new AppError(400, 'That address can’t be imported.')
  let ips: string[]
  if (net.isIP(host)) ips = [host]
  else {
    try { ips = (await dns.lookup(host, { all: true })).map(r => r.address) }
    catch { throw new AppError(400, 'We couldn’t reach that website.') }
  }
  if (ips.length === 0 || ips.some(isBlockedIp)) throw new AppError(400, 'That address can’t be imported.')
  return u
}

interface FetchResult { finalUrl: string; contentType: string; body: Buffer }

/** Fetch with manual redirects (each hop re-validated) + size/time caps. */
async function safeFetch(startUrl: string, maxBytes: number): Promise<FetchResult> {
  let url = startUrl
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const u = await assertPublicUrl(url)
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
    let res: Response
    try {
      res = await fetch(u.toString(), { redirect: 'manual', signal: ctrl.signal, headers: { 'User-Agent': 'GAM-SiteImport/1.0' } })
    } catch { clearTimeout(timer); throw new AppError(400, 'We couldn’t reach that website.') }
    finally { clearTimeout(timer) }

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location')
      if (!loc) throw new AppError(400, 'We couldn’t reach that website.')
      url = new URL(loc, u).toString()
      continue
    }
    if (!res.ok) throw new AppError(400, `That website returned ${res.status}.`)

    const contentType = (res.headers.get('content-type') || '').toLowerCase()
    const reader = res.body?.getReader()
    if (!reader) throw new AppError(400, 'That website returned no content.')
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.length
      if (total > maxBytes) { reader.cancel().catch(() => {}); throw new AppError(400, 'That website is too large to import.') }
      chunks.push(value)
    }
    return { finalUrl: u.toString(), contentType, body: Buffer.concat(chunks) }
  }
  throw new AppError(400, 'That website has too many redirects.')
}

export interface ExtractedSite {
  title: string | null
  intro: string | null    // → booking_intro (short welcome line)
  about: string | null    // → booking_about (the story)
  phone: string | null
  email: string | null
  imageUrls: string[]      // candidate photos, absolute + deduped + capped
}

function extractFromHtml(html: string, baseUrl: string): ExtractedSite {
  const $ = load(html)
  const abs = (src: string): string | null => { try { return new URL(src, baseUrl).toString() } catch { return null } }
  const meta = (name: string): string | null =>
    $(`meta[property="${name}"]`).attr('content') || $(`meta[name="${name}"]`).attr('content') || null

  const title = (($('title').first().text() || meta('og:title')) || '').trim() || null
  const desc = ((meta('og:description') || meta('description')) || '').trim() || null

  const imgs = new Set<string>()
  const og = meta('og:image'); if (og) { const a = abs(og); if (a) imgs.add(a) }
  $('img').each((_i, el) => {
    const src = $(el).attr('src') || $(el).attr('data-src')
    if (!src || /^data:/i.test(src)) return
    if (/(sprite|icon|logo|favicon|pixel|1x1|blank|spacer|avatar|badge)/i.test(src)) return
    const a = abs(src)
    if (a && /^https?:/i.test(a)) imgs.add(a)
  })

  const paras = $('p').map((_i, el) => $(el).text().replace(/\s+/g, ' ').trim()).get().filter(t => t.length >= 40)
  const about = paras.slice(0, 4).join('\n\n') || desc
  const intro = desc || (paras[0] ? paras[0].slice(0, 240) : null)

  const phone = ($('a[href^="tel:"]').first().attr('href') || '').replace(/^tel:/i, '').trim() || null
  const email = ($('a[href^="mailto:"]').first().attr('href') || '').replace(/^mailto:/i, '').split('?')[0].trim() || null

  return { title, intro, about, phone, email, imageUrls: [...imgs].slice(0, 12) }
}

/** Fetch + extract a landlord's site into the editable-template preview. */
export async function importSite(url: string): Promise<{ finalUrl: string; rawHtml: string; extracted: ExtractedSite }> {
  const { finalUrl, contentType, body } = await safeFetch(url, MAX_HTML_BYTES)
  if (!contentType.includes('html')) throw new AppError(400, 'That link isn’t a web page.')
  const rawHtml = body.toString('utf8')
  return { finalUrl, rawHtml, extracted: extractFromHtml(rawHtml, finalUrl) }
}

const IMG_EXT: Record<string, string> = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' }

/** Download one candidate image (SSRF-safe, image-only, size-capped). */
export async function downloadImage(url: string): Promise<{ buffer: Buffer; ext: string }> {
  const { contentType, body } = await safeFetch(url, MAX_IMAGE_BYTES)
  const ext = IMG_EXT[contentType.split(';')[0].trim()]
  if (!ext) throw new AppError(400, 'Unsupported image type.')
  return { buffer: body, ext }
}

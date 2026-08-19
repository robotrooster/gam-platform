/**
 * S605 (Nic): one place in the admin portal that answers "is anything broken?"
 * across every vendor we depend on.
 *
 * "I'd like to not have to go on those dashboards to know if there's a problem.
 *  I get going there to FIX a problem, but we'd like to have notification in
 *  admin portal."
 *
 * So this is a READ-ONLY aggregator: it detects and reports, it never tries to
 * remediate. Fixing still happens in the vendor's own console.
 *
 * ── Rules this file must keep ────────────────────────────────────────────
 *  1. NEVER let one vendor take the page down. Every probe is independently
 *     try/caught with its own timeout; a dead vendor renders as `down` beside
 *     healthy ones, never as a 500.
 *  2. NEVER leak a credential. Probes return status only — no tokens, no
 *     secrets, no raw vendor payloads.
 *  3. Cache. This is polled by an admin page AND a cron; hammering four vendor
 *     APIs on every page load would eventually get us rate-limited by the very
 *     services we're trying to watch.
 */
import { query } from '../db'
import { logger } from '../lib/logger'

export type HealthState = 'ok' | 'warn' | 'down' | 'unknown'

export interface ComponentHealth {
  key: string
  label: string
  state: HealthState
  detail: string
  /** Where a human goes to actually fix it. */
  console?: string
}

export interface PlatformHealth {
  checkedAt: string
  overall: HealthState
  components: ComponentHealth[]
}

const CACHE_MS = 60_000
let cache: { at: number; value: PlatformHealth } | null = null

/** A vendor probe must never hang the request. */
async function fetchJson(url: string, headers: Record<string, string>, timeoutMs = 6000): Promise<any> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(t)
  }
}

/** Wrap a probe so a throw becomes a reportable component rather than a crash. */
async function probe(
  key: string, label: string, console_: string | undefined,
  fn: () => Promise<{ state: HealthState; detail: string }>,
): Promise<ComponentHealth> {
  try {
    const r = await fn()
    return { key, label, console: console_, ...r }
  } catch (err: any) {
    // 'unknown' not 'down': WE failed to ask, which is not the same as the
    // vendor being broken. Saying "down" here would cry wolf on every blip of
    // our own connectivity.
    return {
      key, label, console: console_, state: 'unknown',
      detail: `Could not check: ${err?.message ?? 'unknown error'}`,
    }
  }
}

// ── Vendors ──────────────────────────────────────────────────────────────

async function checkResend(): Promise<{ state: HealthState; detail: string }> {
  const key = process.env.RESEND_API_KEY
  if (!key) return { state: 'unknown', detail: 'RESEND_API_KEY not set' }
  const domains = await fetchJson('https://api.resend.com/domains', { Authorization: `Bearer ${key}` })
  const list: any[] = domains?.data ?? []
  const sender = list.find((d) => d.name === 'goldassetmanagement.com')
  if (!sender) return { state: 'down', detail: 'goldassetmanagement.com is not registered as a sending domain' }
  if (sender.status !== 'verified') {
    return { state: 'down', detail: `Sending domain is "${sender.status}" — outbound email will fail` }
  }
  return { state: 'ok', detail: `goldassetmanagement.com verified · ${list.length} domain(s)` }
}

async function checkVercel(): Promise<{ state: HealthState; detail: string }> {
  const token = process.env.VERCEL_TOKEN
  const team = process.env.VERCEL_TEAM_ID
  if (!token) return { state: 'unknown', detail: 'VERCEL_TOKEN not set' }
  const q = team ? `&teamId=${encodeURIComponent(team)}` : ''
  // Latest production deployments across the team — a failed build is the thing
  // worth knowing, because the alias silently keeps serving the previous one.
  const d = await fetchJson(
    `https://api.vercel.com/v6/deployments?limit=20&target=production${q}`,
    { Authorization: `Bearer ${token}` })
  const deps: any[] = d?.deployments ?? []
  if (deps.length === 0) return { state: 'unknown', detail: 'No production deployments returned' }
  // One row per project: its most recent production deploy.
  const latestByProject = new Map<string, any>()
  for (const dep of deps) {
    const name = dep.name ?? 'unknown'
    if (!latestByProject.has(name)) latestByProject.set(name, dep)
  }
  const bad = [...latestByProject.values()].filter((x) => x.state === 'ERROR' || x.readyState === 'ERROR')
  if (bad.length > 0) {
    return { state: 'down', detail: `Failed latest production build: ${bad.map((b) => b.name).join(', ')}` }
  }
  const building = [...latestByProject.values()].filter((x) => (x.state ?? x.readyState) === 'BUILDING')
  if (building.length > 0) {
    return { state: 'warn', detail: `Building: ${building.map((b) => b.name).join(', ')}` }
  }
  return { state: 'ok', detail: `${latestByProject.size} project(s), latest production build READY` }
}

async function checkCloudflareTunnel(): Promise<{ state: HealthState; detail: string }> {
  const token = process.env.CLOUDFLARE_API_TOKEN
  const acct = process.env.CLOUDFLARE_ACCOUNT_ID
  const tunnel = process.env.CLOUDFLARE_TUNNEL_ID
  if (!token || !acct || !tunnel) return { state: 'unknown', detail: 'Cloudflare env not fully set' }
  const d = await fetchJson(
    `https://api.cloudflare.com/client/v4/accounts/${acct}/cfd_tunnel/${tunnel}`,
    { Authorization: `Bearer ${token}` })
  const r = d?.result
  const status = r?.status ?? 'unknown'
  const conns = Array.isArray(r?.connections) ? r.connections.length : 0
  // The tunnel is how every portal reaches the API. 'down' here means the whole
  // platform is unreachable from the internet even though the Mac is fine.
  if (status === 'healthy') return { state: 'ok', detail: `Tunnel "${r?.name}" healthy · ${conns} connection(s)` }
  if (status === 'degraded') return { state: 'warn', detail: `Tunnel "${r?.name}" degraded · ${conns} connection(s)` }
  return { state: 'down', detail: `Tunnel "${r?.name ?? tunnel}" is ${status} — the API is unreachable from the internet` }
}

async function checkStripe(): Promise<{ state: HealthState; detail: string }> {
  const key = process.env.STRIPE_SECRET_KEY
  if (!key) return { state: 'unknown', detail: 'STRIPE_SECRET_KEY not set' }
  const acct = await fetchJson('https://api.stripe.com/v1/account', { Authorization: `Bearer ${key}` })
  const charges = acct?.charges_enabled
  const payouts = acct?.payouts_enabled
  const mode = key.startsWith('sk_live') ? 'live' : 'test'
  if (!charges) return { state: 'down', detail: `Charges DISABLED on the ${mode} account — no rent can be collected` }
  if (!payouts) return { state: 'warn', detail: `Payouts disabled on the ${mode} account` }
  return { state: 'ok', detail: `${mode} mode · charges + payouts enabled` }
}

// ── Our own stack (no vendor involved) ───────────────────────────────────

async function checkDatabase(): Promise<{ state: HealthState; detail: string }> {
  // If this query runs at all, Postgres is up — the API could not have served
  // the request otherwise. Report the size so growth is visible before it bites.
  const [r] = await query<{ size: string }>(`SELECT pg_size_pretty(pg_database_size(current_database())) AS size`)
  return { state: 'ok', detail: `Postgres reachable · ${r?.size ?? 'size unknown'}` }
}

/**
 * A backup that silently stopped running is the definition of a problem you
 * only discover when it is far too late — exactly what this page exists to
 * prevent. The nightly job writes gam-<date>.dump; we check how old the newest
 * one is rather than trusting that the launchd job "should" have run.
 */
async function checkBackups(): Promise<{ state: HealthState; detail: string }> {
  const dir = process.env.GAM_BACKUP_DIR || `${process.env.HOME}/gam-backups`
  const fs = await import('fs/promises')
  let newest: { name: string; mtime: number } | null = null
  const entries = await fs.readdir(dir)
  for (const name of entries) {
    if (!name.startsWith('gam-') || !name.endsWith('.dump')) continue
    const st = await fs.stat(`${dir}/${name}`)
    if (!newest || st.mtimeMs > newest.mtime) newest = { name, mtime: st.mtimeMs }
  }
  if (!newest) return { state: 'down', detail: `No database dump found in ${dir}` }

  const ageHours = (Date.now() - newest.mtime) / 3_600_000
  const when = `${newest.name} · ${ageHours < 1 ? 'under an hour' : `${Math.floor(ageHours)}h`} old`
  // Nightly at 03:30, so anything past ~2 days means at least one run was missed.
  if (ageHours > 48) return { state: 'down', detail: `Newest backup is ${Math.floor(ageHours / 24)} days old — ${when}` }
  if (ageHours > 30) return { state: 'warn', detail: `Backup looks late — ${when}` }
  return { state: 'ok', detail: when }
}

async function checkEmailDeliverability(): Promise<{ state: HealthState; detail: string }> {
  // Our OWN send log is a better deliverability signal than any vendor
  // dashboard: it is what we actually attempted, with the outcome attached.
  const [r] = await query<{ sent: string; failed: string; bounced: string }>(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'sent')                            AS sent,
       COUNT(*) FILTER (WHERE status = 'failed')                          AS failed,
       COUNT(*) FILTER (WHERE last_event IN ('bounced','complained'))     AS bounced
     FROM email_send_log
     WHERE created_at > now() - interval '24 hours'`)
  const sent = Number(r?.sent ?? 0)
  const failed = Number(r?.failed ?? 0)
  const bounced = Number(r?.bounced ?? 0)
  const summary = `${sent} sent, ${failed} failed, ${bounced} bounced/complained in 24h`

  // Severity has to track REAL breakage, not any blemish. A single rejected
  // address is worth noticing; it is not "the platform is down", and a page
  // that shouts DOWN over one bad address trains you to ignore it — which
  // defeats the point of having it.
  const total = sent + failed
  const failureRate = total > 0 ? failed / total : 0
  if (failed >= 3 && failureRate > 0.25) {
    return { state: 'down', detail: `${summary} — ${Math.round(failureRate * 100)}% failing, outbound email is broken` }
  }
  if (failed > 0 || bounced > 0) return { state: 'warn', detail: summary }
  return { state: 'ok', detail: `${sent} sent in 24h, no failures or bounces` }
}

// ── Aggregate ────────────────────────────────────────────────────────────

const WORST: Record<HealthState, number> = { ok: 0, unknown: 1, warn: 2, down: 3 }

export async function getPlatformHealth(opts: { force?: boolean } = {}): Promise<PlatformHealth> {
  if (!opts.force && cache && Date.now() - cache.at < CACHE_MS) return cache.value

  const components = await Promise.all([
    probe('cloudflare', 'Cloudflare tunnel', 'https://dash.cloudflare.com', checkCloudflareTunnel),
    probe('stripe', 'Stripe', 'https://dashboard.stripe.com', checkStripe),
    probe('resend', 'Resend (sending domain)', 'https://resend.com/domains', checkResend),
    probe('vercel', 'Vercel deployments', 'https://vercel.com/dashboard', checkVercel),
    probe('email', 'Email deliverability (24h)', undefined, checkEmailDeliverability),
    probe('database', 'Database', undefined, checkDatabase),
    probe('backups', 'Nightly backup', undefined, checkBackups),
  ])

  const overall = components.reduce<HealthState>(
    (worst, c) => (WORST[c.state] > WORST[worst] ? c.state : worst), 'ok')

  const value: PlatformHealth = { checkedAt: new Date().toISOString(), overall, components }
  cache = { at: Date.now(), value }
  return value
}

/**
 * Cron half of the ask — "notification in admin portal", not just a page to
 * visit. Alerts only on a TRANSITION into trouble, so a vendor that stays down
 * raises one notification, not one every run.
 */
export async function runPlatformHealthCheck(): Promise<{ alerted: string[] }> {
  const health = await getPlatformHealth({ force: true })
  const alerted: string[] = []

  for (const c of health.components) {
    if (c.state !== 'down' && c.state !== 'warn') continue
    // Was the most recent alert for this component already about this state?
    const [prev] = await query<{ context: any }>(
      `SELECT context FROM admin_notifications
        WHERE category = 'platform_health' AND context->>'component' = $1
        ORDER BY created_at DESC LIMIT 1`, [c.key])
    if (prev?.context?.state === c.state) continue

    await query(
      `INSERT INTO admin_notifications (severity, category, title, body, context)
       VALUES ($1, 'platform_health', $2, $3, $4::jsonb)`,
      [c.state === 'down' ? 'critical' : 'warn',
       `${c.label}: ${c.state === 'down' ? 'DOWN' : 'degraded'}`,
       `${c.detail}${c.console ? ` — fix at ${c.console}` : ''}`,
       JSON.stringify({ component: c.key, state: c.state, detail: c.detail })]
    ).catch((err) => logger.error({ err, component: c.key }, '[platform-health] notify failed'))
    alerted.push(c.key)
  }

  if (alerted.length > 0) logger.warn({ alerted }, '[platform-health] raised alerts')
  return { alerted }
}

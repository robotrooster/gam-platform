// Resolve a property booking slug from the URL. In production the public
// site is served on a per-property GAM subdomain (`<slug>.<gam-domain>`); in
// dev it's the path form `/property/:slug`. Prefer the explicit path param,
// otherwise derive it from the hostname's first label (skipping localhost,
// IPs, and bare apex/www).
export function resolveBookingSlug(pathSlug?: string): string | null {
  if (pathSlug) return pathSlug
  const host = window.location.hostname
  if (host === 'localhost' || /^[0-9.]+$/.test(host)) return null
  const labels = host.split('.')
  if (labels.length < 3) return null // apex like gam.app — no property subdomain
  const first = labels[0]
  if (first === 'www' || first === 'app' || first === 'api' || first === 'book') return null
  return first
}

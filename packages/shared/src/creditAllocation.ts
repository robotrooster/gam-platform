/**
 * S648 (Nic, DIRECTIVE): "Every dollar should only be counted once. Everywhere.
 * We don't want to double charge or double credit people."
 *
 * A resident's account credit is recorded per TENANT (tenant_credits), either
 * tied to one lease or left general (lease_id NULL). Every screen that shows a
 * resident with two leases used to hand the general credit to EACH lease, so a
 * $100 credit took $100 off both bills — $200 of credit shown for $100 held.
 *
 * One rule, used by every place that shows credit against a balance:
 *   1. A credit tied to a lease only ever reduces that lease.
 *   2. A general credit is spent ONCE, across the leases, oldest bill first.
 *   3. Nothing goes below zero; what is not needed stays on the account.
 */
export interface CreditPoolRow {
  /** null = a general credit, usable on any of the tenant's leases. */
  leaseId: string | null
  amount: number
}

export interface CreditTarget {
  /** A lease id, or any stable key for a balance with no lease. */
  key: string
  /** The lease this balance belongs to, for lease-tied credits. */
  leaseId: string | null
  total: number
  /** YYYY-MM-DD of the oldest open charge; earlier is paid down first. */
  earliestDue?: string | null
}

export interface CreditAllocation {
  /** Credit applied to each target, by key. */
  applied: Record<string, number>
  /** Credit left on the account after every target is covered. */
  remaining: number
}

const cents = (n: number) => Math.round(n * 100) / 100

export function allocateCredits(pool: CreditPoolRow[], targets: CreditTarget[]): CreditAllocation {
  const tied = new Map<string, number>()
  let general = 0
  for (const r of pool) {
    const amt = Number(r.amount) || 0
    if (amt <= 0) continue
    if (r.leaseId) tied.set(r.leaseId, (tied.get(r.leaseId) ?? 0) + amt)
    else general += amt
  }
  const applied: Record<string, number> = {}
  const need = new Map<string, number>()
  for (const t of targets) {
    applied[t.key] = 0
    need.set(t.key, Math.max(0, Number(t.total) || 0))
  }
  // 1. lease-tied credit, on its own lease only (split across targets that
  //    share a lease, oldest first)
  const ordered = [...targets].sort((a, b) =>
    String(a.earliestDue ?? '9999').localeCompare(String(b.earliestDue ?? '9999')) || a.key.localeCompare(b.key))
  for (const t of ordered) {
    if (!t.leaseId) continue
    const avail = tied.get(t.leaseId) ?? 0
    const take = Math.min(avail, need.get(t.key)!)
    if (take <= 0) continue
    applied[t.key] += take
    need.set(t.key, need.get(t.key)! - take)
    tied.set(t.leaseId, avail - take)
  }
  // 2. general credit, once, oldest bill first
  for (const t of ordered) {
    const take = Math.min(general, need.get(t.key)!)
    if (take <= 0) continue
    applied[t.key] += take
    need.set(t.key, need.get(t.key)! - take)
    general -= take
  }
  for (const k of Object.keys(applied)) applied[k] = cents(applied[k])
  const leftTied = [...tied.values()].reduce((s, v) => s + v, 0)
  return { applied, remaining: cents(general + leftTied) }
}

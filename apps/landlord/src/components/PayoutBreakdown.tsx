// S655 (Nic): "$2,638.11 from GAM" has to say which payments it was. One
// table, shown on the bank row a payout landed as AND on the Payouts page, so
// both places itemize a payout the same way: every payment inside it, any
// register or booking items, GAM charges taken out before it was sent, and any
// part GAM cannot trace — on its own line, never hidden. The lines add up to
// the payout. Data: services/payoutComposition.ts (API).

const money = (n: any) => {
  const v = Number(n) || 0
  const s = `$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  return v < 0 ? `− ${s}` : s
}
const shortDate = (d: any) => d
  ? new Date(`${String(d).slice(0, 10)}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  : ''

export function PayoutBreakdown({ breakdown }: { breakdown: any }) {
  if (!breakdown) return null
  if (!breakdown.traced) {
    return (
      <div style={{ fontSize: '.76rem', color: 'var(--text-3)', lineHeight: 1.5 }}>
        GAM has no record of which payments this payout carried.
      </div>
    )
  }
  const payments: any[] = breakdown.payments ?? []
  const held: any[] = breakdown.heldItems ?? []
  const adjustments: any[] = breakdown.adjustments ?? []
  return (
    <table className="data-table" style={{ fontSize: '.78rem' }}>
      <thead><tr>
        <th>Paid</th><th>From</th><th>Where</th><th>For</th><th style={{ textAlign: 'right' }}>To you</th>
      </tr></thead>
      <tbody>
        {payments.map((p: any) => (
          <tr key={p.paymentId}>
            <td className="mono">{shortDate(p.paidOn)}</td>
            <td>{p.tenantName || '—'}</td>
            <td style={{ color: 'var(--text-2)' }}>{[p.propertyName, p.unitNumber].filter(Boolean).join(' · ') || '—'}</td>
            <td>{p.what}</td>
            <td className="mono" style={{ textAlign: 'right' }}>{money(p.amount)}</td>
          </tr>
        ))}
        {held.map((h: any) => (
          <tr key={h.id}>
            <td />
            <td colSpan={3}>{h.label}</td>
            <td className="mono" style={{ textAlign: 'right' }}>{money(h.amount)}</td>
          </tr>
        ))}
        {adjustments.map((a: any) => (
          <tr key={a.kind}>
            <td />
            <td colSpan={3} style={{ color: a.kind === 'residual' || a.kind === 'unitemized' ? 'var(--amber)' : 'var(--text-2)' }}>
              {a.label}
            </td>
            <td className="mono" style={{ textAlign: 'right', color: Number(a.amount) < 0 ? 'var(--red)' : undefined }}>
              {money(a.amount)}
            </td>
          </tr>
        ))}
      </tbody>
      <tfoot><tr>
        <td colSpan={4} style={{ textAlign: 'right', fontWeight: 600 }}>
          Payout · {payments.length} payment{payments.length === 1 ? '' : 's'}
        </td>
        <td className="mono" style={{ textAlign: 'right', fontWeight: 800, color: 'var(--green)' }}>{money(breakdown.amount)}</td>
      </tr></tfoot>
    </table>
  )
}

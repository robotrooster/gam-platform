/**
 * Tenant /utilities page — S171 (display fix) + S178 (Pay-flow rip).
 *
 * S171 fixed the column set against the real GET /api/utility/bills
 * wire response (the prior columns referenced fields the response
 * never produced — utilityCost / adminFee / totalAmount / usageAmount
 * mismatched chargeAmount etc., rendering "$undefined"). S171 also
 * added a Pay Now flow against the now-retired
 * POST /api/utility/bills/:id/pay endpoint.
 *
 * S178 corrected the architectural drift: utilities are line items on
 * the rent invoice, not separate bills. invoiceGeneration.ts now folds
 * unbilled utility_bills into the next rent invoice as type='utility'
 * payment children. Tenants pay them through the standard
 * /payments page along with their rent — no separate Pay surface.
 *
 * This page now reverts to a view-only history of utility_bills with
 * a small banner pointing tenants at /payments for actual payment.
 * The S171 column-fix is preserved (Cycle / Utility / Meter / Usage /
 * Amount / Status — fields that actually exist on the wire).
 */
import { useQuery } from 'react-query'
import { Link } from 'react-router-dom'
import { formatCurrency } from '@gam/shared'
import { apiGet } from '../lib/api'

interface UtilityBill {
  id:                  string
  meterId:             string
  unitId:              string
  tenantId:            string
  leaseId:             string
  landlordId:          string
  billingCycleMonth:   string  // ISO date (first of month)
  usageAmount:         number | string | null
  allocationMethod:    string | null
  allocationBasis:     number | string | null
  ratePerUnit:         number | string | null
  baseFeeShare:        number | string
  chargeAmount:        number | string
  status:              'unbilled' | 'billed' | 'paid' | 'disputed' | 'void'
  billedAt:            string | null
  paidAt:              string | null
  paymentId:           string | null
  notes:               string | null
  // Joined columns (route's SELECT ub.*, u.unit_number, p.name AS property_name, m.utility_type, m.label AS meter_label)
  unitNumber:          string | null
  propertyName:        string | null
  utilityType:         string | null
  meterLabel:          string | null
}

const STATUS_BADGE: Record<UtilityBill['status'], string> = {
  unbilled: 'b-muted',
  billed:   'b-amber',
  paid:     'b-green',
  disputed: 'b-red',
  void:     'b-muted',
}

const UTILITY_LABEL: Record<string, string> = {
  water:    'Water',
  gas:      'Gas',
  electric: 'Electric',
  sewer:    'Sewer',
  trash:    'Trash',
}

function asNumber(v: number | string | null | undefined): number {
  if (v === null || v === undefined) return 0
  return typeof v === 'string' ? parseFloat(v) : v
}

function cycleLabel(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString(undefined, { month: 'short', year: 'numeric' })
}

export function UtilitiesPage() {
  const { data: bills = [], isLoading } = useQuery<UtilityBill[]>(
    'util',
    () => apiGet<UtilityBill[]>('/utility/bills'),
  )

  return (
    <div>
      <div className="ph">
        <div>
          <h1 className="pt">Utilities</h1>
          <p className="ps">Sub-metered utility bills</p>
        </div>
      </div>

      <div className="alert a-blue">
        ℹ️ Utility bills appear as line items on your monthly rent invoice. Pay them on the{' '}
        <Link to="/payments" style={{ color: 'var(--gold)', textDecoration: 'underline' }}>
          Payments
        </Link>{' '}
        page along with your rent. This page is for usage history.
      </div>

      <div className="card" style={{ padding: 0, overflowX: 'auto', marginTop: 16 }}>
        {isLoading ? (
          <div style={{ padding: 32, color: 'var(--t3)', textAlign: 'center' }}>Loading…</div>
        ) : (
          <table className="tbl" style={{ minWidth: 760 }}>
            <thead>
              <tr>
                <th>Cycle</th>
                <th>Utility</th>
                <th>Meter</th>
                <th>Usage</th>
                <th>Amount</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {bills.length ? (
                bills.map((b) => {
                  const utilityName =
                    (b.utilityType && UTILITY_LABEL[b.utilityType]) || b.utilityType || '—'
                  const usage = asNumber(b.usageAmount)
                  return (
                    <tr key={b.id}>
                      <td className="mono" style={{ fontSize: '.75rem' }}>
                        {cycleLabel(b.billingCycleMonth)}
                      </td>
                      <td>{utilityName}</td>
                      <td style={{ fontSize: '.78rem', color: 'var(--t3)' }}>
                        {b.meterLabel ?? '—'}
                      </td>
                      <td className="mono" style={{ fontSize: '.78rem', color: 'var(--t3)' }}>
                        {usage > 0 ? usage.toFixed(2) : '—'}
                      </td>
                      <td className="mono" style={{ color: 'var(--t0)', fontWeight: 600 }}>
                        {formatCurrency(asNumber(b.chargeAmount))}
                      </td>
                      <td>
                        <span className={`badge ${STATUS_BADGE[b.status] || 'b-muted'}`}>
                          {b.status}
                        </span>
                      </td>
                    </tr>
                  )
                })
              ) : (
                <tr>
                  <td colSpan={6} style={{ textAlign: 'center', color: 'var(--t3)', padding: 32 }}>
                    No utility bills yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

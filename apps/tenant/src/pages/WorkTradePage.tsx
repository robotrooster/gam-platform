import { useQuery } from 'react-query'
import { apiGet, apiPost, apiPatch } from '../lib/api'
import { toast } from '../components/dialogs'
import { WorkTradePanel } from '../../../../packages/shared-ui/WorkTradePanel'

/**
 * S652 (Nic): "this is the same window that I want the tenants to see... The
 * landlord and the tenant should be seeing the same screens, but from their
 * different portals." The tab only exists while the agreement is live (the nav
 * checks the same endpoint), and the panel is the landlord's panel without the
 * landlord's controls.
 */
const panelApi = { get: apiGet, post: apiPost, patch: apiPatch }

export function WorkTradePage() {
  const { data: agreement, isLoading } = useQuery<any>('work-trade-nav', () => apiGet('/tenants/work-trade'))
  if (isLoading) return <div style={{ color: 'var(--t3)', fontSize: '.85rem' }}>Loading…</div>
  if (!agreement?.id) {
    return <div className="card" style={{ padding: 18, fontSize: '.85rem', color: 'var(--t2)' }}>You have no active work trade agreement.</div>
  }
  return (
    <div style={{ maxWidth: 780 }}>
      <div className="ph"><div className="pt">Work Trade</div></div>
      <WorkTradePanel agreementId={agreement.id} side="tenant" api={panelApi}
        notify={(m, kind) => kind === 'error' ? toast.error(m) : toast(m)} />
    </div>
  )
}

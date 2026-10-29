import { useQuery } from 'react-query'
import { apiGet, apiPost, apiPatch } from '../lib/api'
import { toast } from '../components/dialogs'
import { WorkTradePanel } from '../../../../packages/shared-ui/WorkTradePanel'
import { PropertyListPanel } from '../../../../packages/shared-ui/PropertyListPanel'

/**
 * S652 (Nic): "this is the same window that I want the tenants to see... The
 * landlord and the tenant should be seeing the same screens, but from their
 * different portals." The tab only exists while the agreement is live (the nav
 * checks the same endpoint), and the panel is the landlord's panel without the
 * landlord's controls.
 *
 * 10/19 (Nic) — AND "LIVE" INCLUDES PAUSED. Asked whether a tenant should see a
 * paused agreement, Nic chose to show it while paused: the tab stays and says
 * which situation they are in, hours still counting or nothing being counted.
 * The route this reads answers active and paused now (routes/tenants
 * /work-trade), the panel already has the words for both, and an ENDED
 * agreement stays gone — its hours were billed when it ended.
 */
const panelApi = { get: apiGet, post: apiPost, patch: apiPatch }
const listApi = { get: apiGet, post: apiPost }

export function WorkTradePage() {
  const { data: agreement, isLoading } = useQuery<any>('work-trade-nav', () => apiGet('/tenants/work-trade'))
  if (isLoading) return <div style={{ color: 'var(--t3)', fontSize: '.85rem' }}>Loading…</div>
  if (!agreement?.id) {
    // 10/19: not "no ACTIVE agreement" any more. A paused one reaches this page,
    // so the only person who sees this has none at all.
    return <div className="card" style={{ padding: 18, fontSize: '.85rem', color: 'var(--t2)' }}>You have no work trade agreement.</div>
  }
  return (
    <div style={{ maxWidth: 780 }}>
      <div className="ph"><div className="pt">Work Trade</div></div>
      <WorkTradePanel agreementId={agreement.id} side="tenant" api={panelApi}
        notify={(m, kind) => kind === 'error' ? toast.error(m) : toast(m)} />

      {/* 10/21 (Nic): "we need work trade people to be able to see this task
          list in the system… And we also need a way for maybe maintenance
          people or work trade people to put in sort of a collected shopping
          cart pool."

          Here rather than a nav item of its own: this page already exists only
          while the agreement is live, which is exactly who should see the
          park's jobs, and it is the page they open to look at their hours. The
          same panel the owner reads on the property page (shared-ui), with the
          owner's controls off — they tick a job off and they ask for supplies;
          they never write the task list, which is the owner's. */}
      {agreement.propertyId && (
        <div style={{ display: 'grid', gap: 14, marginTop: 14 }}>
          <PropertyListPanel propertyId={agreement.propertyId} kind="job" isOwner={false} api={listApi} />
          <PropertyListPanel propertyId={agreement.propertyId} kind="supply" isOwner={false} api={listApi} />
        </div>
      )}
    </div>
  )
}

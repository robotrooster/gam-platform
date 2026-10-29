import { apiGet, apiPost } from '../lib/api'
import { usePerms } from '../lib/permissions'
import { PropertyListPanel } from '../../../../packages/shared-ui/PropertyListPanel'
import type { PropertyListKind } from '@gam/shared'

/**
 * The park's two lists on the landlord's property page — the panel itself lives
 * in packages/shared-ui, because 10/21 (Nic) a work-trade resident reads and
 * ticks the same list from the tenant portal: "we need work trade people to be
 * able to see this task list in the system." One panel, both portals, the way
 * the work-trade panel already works — S652 (Nic): "The landlord and the tenant
 * should be seeing the same screens, but from their different portals."
 */
const api = { get: apiGet, post: apiPost }

export function PropertyTaskListTab({ propertyId, kind = 'job' }: {
  propertyId: string
  kind?: PropertyListKind
}) {
  const { isOwner } = usePerms()
  return <PropertyListPanel propertyId={propertyId} kind={kind} isOwner={isOwner} api={api} />
}

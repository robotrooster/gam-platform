/**
 * Agent tool registry (Step 4).
 *
 * One place that knows all tools. A profile opts into tools by name via
 * its `toolNames` allowlist; `getToolsForProfile` returns the tools that
 * are BOTH on the allowlist AND permitted for the profile's audience
 * (defense in depth — a tenant profile can never surface a landlord
 * tool even if misconfigured). Adding a tool = append it here.
 */

import { fileMaintenanceRequest } from './fileMaintenanceRequest'
import { addMaintenanceComment } from './addMaintenanceComment'
import { cancelMaintenanceRequest } from './cancelMaintenanceRequest'
import { getMyContacts } from './getMyContacts'
import { getMyLandlordPatterns } from './getMyLandlordPatterns'
import { getMyLease } from './getMyLease'
import { getMyPayments } from './getMyPayments'
import { getLandlordPortfolio } from './getLandlordPortfolio'
import { getMyMaintenanceRequests } from './getMyMaintenanceRequests'
import { getMyDocuments } from './getMyDocuments'
import { getMyInspections } from './getMyInspections'
import { getMyEntryRequests } from './getMyEntryRequests'
import { getMyPaymentMethods } from './getMyPaymentMethods'
import { getMyNotifications } from './getMyNotifications'
import { getPendingMaintenance } from './getPendingMaintenance'
import { lookupTenantPaymentStatus } from './lookupTenantPaymentStatus'
import { getDelinquentTenants } from './getDelinquentTenants'
import { getVacantUnits } from './getVacantUnits'
import { getLeaseExpirations } from './getLeaseExpirations'
import { approveMaintenanceRequest } from './approveMaintenanceRequest'
import { getMaintenanceTeam } from './getMaintenanceTeam'
import { assignMaintenanceRequest } from './assignMaintenanceRequest'
import { getBooksSummary } from './getBooksSummary'
import { getTenantContact } from './getTenantContact'
import { getTeam } from './getTeam'
import { rejectMaintenanceRequest } from './rejectMaintenanceRequest'
import { scheduleMaintenance } from './scheduleMaintenance'
import { messageTenant } from './messageTenant'
import { getMyDeposit } from './getMyDeposit'
import { getMyInvoices } from './getMyInvoices'
import { getPendingApplications } from './getPendingApplications'
import { getMyPayouts } from './getMyPayouts'
import { getBackgroundCheckStatus } from './getBackgroundCheckStatus'
import { sendBulkMessage } from './sendBulkMessage'
import { getMyBookings } from './getMyBookings'
import { getPropertyRentRoll } from './getPropertyRentRoll'
import { getSetupProgress } from './getSetupProgress'
import { captureLead } from './captureLead'
import { markNotificationsRead } from './markNotificationsRead'
import { updateNotificationPreference } from './updateNotificationPreference'
import { getApplicableLaws } from './getApplicableLaws'
import { searchStateLaw } from './searchStateLaw'
import { searchRealEstateLaw } from './searchRealEstateLaw'
import { getPropertyTaxFacts } from './getPropertyTaxFacts'
import { searchParcelsTool } from './searchParcels'
import { getMarketRentTool } from './getMarketRent'
import { getMyLandlordRenewalTendency } from './getMyLandlordRenewalTendency'
import { checkAgainstLaw } from './checkAgainstLaw'
import { escalate, escalateToHuman } from './escalation'
import { setAgentPermission, getAgentPermissions } from './agentPermissionTools'
import { requestLeaseRenewal } from './requestLeaseRenewal'
import { billFee } from './billFee'
import { flagApplicantDecision } from './flagApplicantDecision'
import { draftTenantNotice } from './draftTenantNotice'
import { getInspectionChecklist } from './getInspectionChecklist'
import { declineGuidedInspection } from './declineGuidedInspection'
import { getInspectionProgress } from './getInspectionProgress'
import { createInspection } from './createInspection'
import { setInspectionItemCondition } from './setInspectionItemCondition'
import { getGuestBooking } from './getGuestBooking'
import { requestBookingChange } from './requestBookingChange'
import type { AgentTool } from './types'
import type { AgentProfile } from '../types'
import type { ToolSchema } from '../engine'

export const ALL_TOOLS: readonly AgentTool[] = [
  // tenant reads + actions
  fileMaintenanceRequest,
  addMaintenanceComment,
  cancelMaintenanceRequest,
  getMyLease,
  getMyPayments,
  getMyMaintenanceRequests,
  getMyDocuments,
  getMyInspections,
  getMyEntryRequests,
  getMyPaymentMethods,
  getMyDeposit,
  getMyInvoices,
  getMyBookings,
  getMyContacts,
  getMyLandlordPatterns,
  getMyLandlordRenewalTendency,
  requestLeaseRenewal,
  getInspectionChecklist,
  declineGuidedInspection,
  // landlord reads
  getLandlordPortfolio,
  getPropertyRentRoll,
  getSetupProgress,
  getPendingMaintenance,
  lookupTenantPaymentStatus,
  getDelinquentTenants,
  getVacantUnits,
  getLeaseExpirations,
  getPendingApplications,
  getMyPayouts,
  getBackgroundCheckStatus,
  getMaintenanceTeam,
  getBooksSummary,
  getTenantContact,
  getTeam,
  getInspectionProgress,
  // landlord actions
  approveMaintenanceRequest,
  assignMaintenanceRequest,
  rejectMaintenanceRequest,
  scheduleMaintenance,
  messageTenant,
  sendBulkMessage,
  getAgentPermissions,
  setAgentPermission,
  billFee,
  flagApplicantDecision,
  draftTenantNotice,
  createInspection,
  setInspectionItemCondition,
  // sales (prospect)
  captureLead,
  // booking guest (token-scoped)
  getGuestBooking,
  requestBookingChange,
  // both
  getApplicableLaws,
  searchStateLaw,
  searchRealEstateLaw,
  getPropertyTaxFacts,
  searchParcelsTool,
  getMarketRentTool,
  checkAgainstLaw,
  getMyNotifications,
  markNotificationsRead,
  updateNotificationPreference,
  // control
  escalate,
  escalateToHuman,
]

const TOOLS_BY_NAME: ReadonlyMap<string, AgentTool> = new Map(ALL_TOOLS.map((t) => [t.name, t]))

export function getTool(name: string): AgentTool | undefined {
  return TOOLS_BY_NAME.get(name)
}

/** Tools a profile may use: on its allowlist AND allowed for its audience. */
export function getToolsForProfile(profile: AgentProfile): AgentTool[] {
  const allow = profile.toolNames ?? []
  return ALL_TOOLS.filter((t) => allow.includes(t.name) && t.audiences.includes(profile.audience))
}

/** Render a tool to the OpenAI function-tool schema sent to the model. */
export function toToolSchema(tool: AgentTool): ToolSchema {
  return {
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }
}

export type { AgentTool, AgentActor } from './types'

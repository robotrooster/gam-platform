/**
 * Can this account's rent be paid out? The landlord-portal copy of the rule in
 * apps/api/src/lib/payoutReadiness.ts (the owner to-do list and the agent).
 *
 * 10/12 (Nic): Blu co-owns Oak Park (payouts live) and owns TruBlu Management
 * LLC, which holds Country Acres and has no Stripe account. Every screen asked
 * "can ANY company be paid?" or asked about the account's oldest company, so
 * Oak Park answered for TruBlu everywhere: the Disbursement Account page said
 * "You're all set", the Properties banner stayed hidden, onboarding showed Get
 * Paid as done.
 *
 * Ready = every company with a property can be paid. When no company has a
 * property yet, ready = any company can be paid (S620: a co-owner's empty
 * company is never the reason for a nag).
 */
export interface PayoutCompany {
  id: string
  businessName?: string | null
  propertyCount?: number
  connectPayoutsEnabled?: boolean
}

/** Companies with at least one property whose payouts are not live. */
export function companiesMissingPayouts<T extends PayoutCompany>(companies: T[]): T[] {
  return companies.filter(c => (c.propertyCount ?? 0) > 0 && !c.connectPayoutsEnabled)
}

export function payoutsReadyFor(companies: PayoutCompany[]): boolean {
  return companiesMissingPayouts(companies).length === 0 && companies.some(c => !!c.connectPayoutsEnabled)
}

export function companyName(c: PayoutCompany): string {
  return c.businessName || 'Unnamed company'
}

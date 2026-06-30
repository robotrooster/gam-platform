// S261: GAM-supersedence routing.
//
// Memory: project_gam_supersedence_routing.md — every successful tenant
// ACH pull routes to GAM first to satisfy outstanding GAM-owed debts
// (oldest-first); surplus to landlord; the landlord's lease ledger shows
// rent paid in full.
//
// Two entry points:
//   - computeTenantGamOutstanding(tenantId): ordered FIFO list of debts.
//   - applyTenantSupersedence(client, paymentId): on webhook settle,
//     reads payments.gam_supersedence_amount captured at PI creation
//     and distributes it FIFO across the live debts. Idempotent via
//     gam_supersedence_applied_at.
//
// Sources (S261 v1; FlexDeposit updated S514 to the custody model):
//   1. flex_deposit_installments status='missed' (plan active) — a missed
//      installment is the then-due, unfunded portion of the tenant's own
//      deposit; routing it here is the funding mechanism, NOT debt
//      collection (Consumer ToS § 9.1.4). No acceleration source exists.
//   2. flex_charge_statements status IN ('open','failed') AND due_date<=today
//   3. flexpay_advances status='defaulted'
//   4. flex_deposit_custody_charges status='failed'
//
// FIFO order: oldest unpaid date ASC, deterministic ties by source then ref_id.
//
// Mutual exclusion: by product rule (services/flexCharge.ts enroll gating),
// FlexCharge enrollment is blocked while a tenant has an active FlexDeposit
// installment plan. The FIFO list will not in practice contain both
// FlexCharge balance + FlexDeposit installments simultaneously.

import type { PoolClient } from 'pg'
import { query } from '../db'

export type SupersedenceSource =
  | 'flexdeposit_installment'
  | 'flexcharge_statement'
  | 'flexpay_advance'
  | 'custody_charge'

export interface OutstandingItem {
  source:      SupersedenceSource
  ref_id:      string
  amount:      number       // dollars
  unpaid_date: string       // ISO timestamp/date used for FIFO ordering
}

export interface BreakdownItem {
  source:       SupersedenceSource
  ref_id:       string
  amount:       number       // dollars actually applied
  satisfied_at: string       // ISO timestamp
  residual?:    boolean      // true when boost ran out mid-item (no row flipped)
}

export interface PostCommitTransfer {
  source:                       SupersedenceSource
  ref_id:                       string
  amount:                       number
  landlord_user_id:             string
  destination_connect_account?: string | null
}

export interface ApplySupersedenceResult {
  applied:           boolean
  amount_distributed: number
  amount_residual:    number
  post_commit_transfers: PostCommitTransfer[]
}

// ── Outstanding-debt query ───────────────────────────────────────────

export async function computeTenantGamOutstanding(
  tenantId: string,
  client?: PoolClient,
): Promise<OutstandingItem[]> {
  const exec = async <T extends Record<string, any>>(sql: string, params: any[]): Promise<T[]> => {
    if (client) return (await client.query<T>(sql, params)).rows
    return query<T>(sql, params)
  }

  const out: OutstandingItem[] = []

  // A 'missed' installment (both scheduled pulls failed) is the then-due,
  // unfunded portion of the tenant's own deposit. defaulted_at is the
  // legacy column name for when the installment was marked missed.
  const installments = await exec<{
    id: string; amount: string; defaulted_at: string;
  }>(
    `SELECT i.id, i.amount::text, i.defaulted_at::text
       FROM flex_deposit_installments i
       JOIN security_deposits d ON d.id = i.security_deposit_id
      WHERE i.tenant_id = $1
        AND i.status = 'missed'
        AND d.flex_deposit_plan_status = 'active'`,
    [tenantId],
  )
  for (const r of installments) {
    out.push({
      source:      'flexdeposit_installment',
      ref_id:      r.id,
      amount:      Number(r.amount),
      unpaid_date: r.defaulted_at,
    })
  }

  const fcStmts = await exec<{
    id: string; total_due: string; due_date: string;
  }>(
    `SELECT s.id, s.total_due::text, s.due_date::text
       FROM flex_charge_statements s
       JOIN flex_charge_accounts a ON a.id = s.account_id
      WHERE a.tenant_id = $1
        AND s.status IN ('open', 'failed')
        AND s.total_due > 0
        AND s.due_date <= CURRENT_DATE`,
    [tenantId],
  )
  for (const r of fcStmts) {
    out.push({
      source:      'flexcharge_statement',
      ref_id:      r.id,
      amount:      Number(r.total_due),
      unpaid_date: r.due_date,
    })
  }

  const fpAdv = await exec<{
    id: string; rent_amount: string; tenant_fee_amount: string; defaulted_at: string;
  }>(
    `SELECT id, rent_amount::text, tenant_fee_amount::text, defaulted_at::text
       FROM flexpay_advances
      WHERE tenant_id = $1
        AND status = 'defaulted'`,
    [tenantId],
  )
  for (const r of fpAdv) {
    out.push({
      source:      'flexpay_advance',
      ref_id:      r.id,
      amount:      Number(r.rent_amount) + Number(r.tenant_fee_amount),
      unpaid_date: r.defaulted_at,
    })
  }

  const custody = await exec<{
    id: string; amount: string; updated_at: string;
  }>(
    `SELECT id, amount::text, updated_at::text
       FROM flex_deposit_custody_charges
      WHERE tenant_id = $1
        AND status = 'failed'`,
    [tenantId],
  )
  for (const r of custody) {
    out.push({
      source:      'custody_charge',
      ref_id:      r.id,
      amount:      Number(r.amount),
      unpaid_date: r.updated_at,
    })
  }

  out.sort((a, b) => {
    if (a.unpaid_date !== b.unpaid_date) return a.unpaid_date < b.unpaid_date ? -1 : 1
    if (a.source     !== b.source)      return a.source     < b.source     ? -1 : 1
    return a.ref_id < b.ref_id ? -1 : 1
  })

  return out
}

export async function computeTenantGamOutstandingTotal(
  tenantId: string,
  client?: PoolClient,
): Promise<number> {
  const items = await computeTenantGamOutstanding(tenantId, client)
  return round2(items.reduce((s, i) => s + i.amount, 0))
}

// ── Apply boost on settle ────────────────────────────────────────────

export async function applyTenantSupersedence(
  client: PoolClient,
  paymentId: string,
): Promise<ApplySupersedenceResult> {
  const noop: ApplySupersedenceResult = {
    applied: false, amount_distributed: 0, amount_residual: 0, post_commit_transfers: [],
  }

  const pay = await client.query<{
    tenant_id: string | null;
    gam_supersedence_amount: string;
    gam_supersedence_applied_at: string | null;
  }>(
    `SELECT tenant_id,
            gam_supersedence_amount::text AS gam_supersedence_amount,
            gam_supersedence_applied_at
       FROM payments WHERE id = $1
       FOR UPDATE`,
    [paymentId],
  )
  if (pay.rows.length === 0) return noop
  const p = pay.rows[0]
  const boost = Number(p.gam_supersedence_amount)
  if (boost <= 0) return noop
  if (p.gam_supersedence_applied_at) return noop
  if (!p.tenant_id) return noop

  const list = await computeTenantGamOutstanding(p.tenant_id, client)

  let remaining = boost
  const breakdown: BreakdownItem[] = []
  const postCommit: PostCommitTransfer[] = []

  for (const item of list) {
    if (remaining < 0.005) break
    if (remaining + 0.005 < item.amount) {
      // Boost smaller than this item — leave the row unpaid for next time;
      // record residual so audit trail is complete. Residual sits on
      // platform balance and gets admin-flagged by the caller.
      breakdown.push({
        source:       item.source,
        ref_id:       item.ref_id,
        amount:       round2(remaining),
        satisfied_at: new Date().toISOString(),
        residual:     true,
      })
      remaining = 0
      break
    }

    let satisfied = false
    let transfer: PostCommitTransfer | null = null

    switch (item.source) {
      case 'flexdeposit_installment':
        satisfied = await satisfyFlexDepositInstallment(client, item.ref_id, paymentId)
        break
      case 'flexcharge_statement': {
        const r = await satisfyFlexChargeStatement(client, item.ref_id, paymentId)
        satisfied = r.satisfied
        if (r.transfer) transfer = r.transfer
        break
      }
      case 'flexpay_advance':
        satisfied = await satisfyFlexPayAdvance(client, item.ref_id, paymentId)
        break
      case 'custody_charge':
        satisfied = await satisfyCustodyCharge(client, item.ref_id, paymentId)
        break
    }

    if (!satisfied) {
      // Row was already satisfied by a concurrent path; skip.
      continue
    }
    breakdown.push({
      source:       item.source,
      ref_id:       item.ref_id,
      amount:       item.amount,
      satisfied_at: new Date().toISOString(),
    })
    if (transfer) postCommit.push(transfer)
    remaining = round2(remaining - item.amount)
  }

  // Whatever remains was over-collected (debts shrunk between PI create
  // and settle, or concurrent satisfaction). Record so the caller can
  // admin-flag it.
  if (remaining > 0.005) {
    breakdown.push({
      source:       'flexdeposit_installment',  // placeholder; over-collection is product-agnostic
      ref_id:       'over_collected',
      amount:       round2(remaining),
      satisfied_at: new Date().toISOString(),
      residual:     true,
    })
  }

  await client.query(
    `UPDATE payments
        SET gam_supersedence_breakdown  = $1::jsonb,
            gam_supersedence_applied_at = NOW()
      WHERE id = $2`,
    [JSON.stringify(breakdown), paymentId],
  )

  return {
    applied:               true,
    amount_distributed:    round2(boost - remaining),
    amount_residual:       round2(remaining),
    post_commit_transfers: postCommit,
  }
}

// ── Per-source satisfiers ───────────────────────────────────────────

async function satisfyFlexDepositInstallment(
  client: PoolClient,
  installmentId: string,
  payerPaymentId: string,
): Promise<boolean> {
  const r = await client.query<{
    security_deposit_id: string; amount: string;
  }>(
    `UPDATE flex_deposit_installments
        SET status     = 'settled',
            settled_at = NOW(),
            payment_id = COALESCE(payment_id, $2),
            updated_at = NOW()
      WHERE id = $1 AND status = 'missed'
      RETURNING security_deposit_id, amount::text`,
    [installmentId, payerPaymentId],
  )
  if (r.rows.length === 0) return false
  const inst = r.rows[0]
  await client.query(
    `UPDATE security_deposits
        SET collected_amount       = collected_amount + $2::numeric,
            installments_paid      = installments_paid + 1,
            installments_remaining = GREATEST(0, installments_remaining - 1),
            updated_at             = NOW()
      WHERE id = $1`,
    [inst.security_deposit_id, inst.amount],
  )
  await client.query(
    `UPDATE security_deposits
        SET status = 'funded', updated_at = NOW()
      WHERE id = $1
        AND status != 'funded'
        AND installments_remaining = 0
        AND collected_amount >= total_amount`,
    [inst.security_deposit_id],
  )
  return true
}

async function satisfyFlexChargeStatement(
  client: PoolClient,
  statementId: string,
  payerPaymentId: string,
): Promise<{ satisfied: boolean; transfer: PostCommitTransfer | null }> {
  const r = await client.query<{
    balance:           string;
    account_id:        string;
    landlord_id:       string;
    landlord_user_id:  string;
    connect_account:   string | null;
  }>(
    `WITH upd AS (
       UPDATE flex_charge_statements
          SET status     = 'paid',
              settled_at = NOW(),
              payment_id = COALESCE(payment_id, $2),
              updated_at = NOW()
        WHERE id = $1 AND status IN ('open', 'failed', 'billed')
        RETURNING id, balance::text, account_id
     )
     SELECT u.balance, u.account_id,
            a.landlord_id,
            usr.id  AS landlord_user_id,
            usr.stripe_connect_account_id AS connect_account
       FROM upd u
       JOIN flex_charge_accounts a ON a.id = u.account_id
       JOIN landlords l            ON l.id = a.landlord_id
       JOIN users     usr          ON usr.id = l.user_id`,
    [statementId, payerPaymentId],
  )
  if (r.rows.length === 0) return { satisfied: false, transfer: null }
  const row = r.rows[0]

  await client.query(
    `UPDATE flex_charge_transactions
        SET status = 'paid', updated_at = NOW()
      WHERE statement_id = $1 AND status IN ('pending', 'billed')`,
    [statementId],
  )

  const balance = Number(row.balance)
  if (balance <= 0) return { satisfied: true, transfer: null }

  return {
    satisfied: true,
    transfer: {
      source:                       'flexcharge_statement',
      ref_id:                       statementId,
      amount:                       balance,
      landlord_user_id:             row.landlord_user_id,
      destination_connect_account:  row.connect_account,
    },
  }
}

async function satisfyFlexPayAdvance(
  client: PoolClient,
  advanceId: string,
  payerPaymentId: string,
): Promise<boolean> {
  const r = await client.query(
    `UPDATE flexpay_advances
        SET status          = 'reconciled',
            reconciled_at   = NOW(),
            rent_payment_id = COALESCE(rent_payment_id, $2),
            updated_at      = NOW()
      WHERE id = $1 AND status = 'defaulted'`,
    [advanceId, payerPaymentId],
  )
  return (r.rowCount ?? 0) > 0
}

async function satisfyCustodyCharge(
  client: PoolClient,
  chargeId: string,
  payerPaymentId: string,
): Promise<boolean> {
  const r = await client.query(
    `UPDATE flex_deposit_custody_charges
        SET status     = 'settled',
            payment_id = COALESCE(payment_id, $2),
            updated_at = NOW()
      WHERE id = $1 AND status = 'failed'`,
    [chargeId, payerPaymentId],
  )
  return (r.rowCount ?? 0) > 0
}

// ── helpers ─────────────────────────────────────────────────────────

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

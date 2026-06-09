// apps/api/scratch/test-parse.ts
//
// End-to-end smoke test: invoke parseLease on a PDF and dump the full
// ParserOutput + status + flags.

import fs from 'fs'
import path from 'path'
import { parseLease } from '../src/jobs/leaseParser'

async function main() {
  const arg = process.argv[2]
  if (!arg) {
    console.error('usage: tsx apps/api/scratch/test-parse.ts <path-to-pdf>')
    process.exit(1)
  }
  const buf = fs.readFileSync(path.resolve(arg))
  console.log(`--- ${path.resolve(arg)} (${buf.length} bytes) ---`)

  const result = await parseLease(buf)

  console.log(`\nstatus: ${result.status}`)
  console.log(`parserVersion: ${result.output.parserVersion}`)

  // Audit trail
  console.log(`\n=== AUDIT TRAIL ===`)
  console.log(`detected: ${result.auditTrail.detected}`)
  console.log(`title: ${result.auditTrail.documentTitle ?? '(none)'}`)
  for (const s of result.auditTrail.signers) {
    console.log(`  ${s.name} <${s.email}> ${s.signedAt ?? ''} ${s.ipAddress ?? ''}`)
  }

  // Tenant
  console.log(`\n=== TENANT ===`)
  const t = result.output.tenants[0]
  printField('firstName',      t?.firstName)
  printField('lastName',       t?.lastName)
  printField('email',          t?.email)
  printField('phone',          t?.phone)
  printField('dateOfBirth',    t?.dateOfBirth)
  printField('mailingAddress', t?.mailingAddress)
  if (t?.identifications) {
    for (const id of t.identifications) {
      console.log(`  identification: ${id.idType.value} = ${id.idNumber.value} (conf ${id.idNumber.confidence.toFixed(2)})`)
    }
  }
  if (t?.emergencyContacts) {
    for (const ec of t.emergencyContacts) {
      console.log(`  emergencyContact: ${ec.name.value}` + (ec.phone ? ` ${ec.phone.value}` : '') + ` (conf ${ec.name.confidence.toFixed(2)})`)
    }
  }

  // Unit
  console.log(`\n=== UNIT ===`)
  printField('propertyName',    result.output.unit.propertyName)
  printField('unitNumber',      result.output.unit.unitNumber)
  printField('propertyAddress', result.output.unit.propertyAddress)
  printField('unitType',        result.output.unit.unitType)

  // Lease
  console.log(`\n=== LEASE ===`)
  printField('leaseType',          result.output.lease.leaseType)
  printField('leaseStart',         result.output.lease.leaseStart)
  printField('leaseEnd',           result.output.lease.leaseEnd)
  printField('monthlyRent',        result.output.lease.monthlyRent)
  printField('securityDeposit',    result.output.lease.securityDeposit)
  printField('lateFeeAmount',      result.output.lease.lateFeeAmount)
  printField('lateFeeGraceDays',   result.output.lease.lateFeeGraceDays)
  printField('autoRenew',          result.output.lease.autoRenew)
  printField('autoRenewMode',      result.output.lease.autoRenewMode)
  printField('noticeDaysRequired', result.output.lease.noticeDaysRequired)
  printField('subleasingAllowed',  result.output.lease.subleasingAllowed)

  // Mobile home
  if (result.output.mobileHome) {
    console.log(`\n=== MOBILE HOME ===`)
    printField('year',         result.output.mobileHome.year)
    printField('make',         result.output.mobileHome.make)
    printField('model',        result.output.mobileHome.model)
    printField('serialNumber', result.output.mobileHome.serialNumber)
  }

  // Liability insurance
  if (result.output.liabilityInsurance) {
    console.log(`\n=== LIABILITY INSURANCE ===`)
    printField('carrierName',  result.output.liabilityInsurance.carrierName)
    printField('policyNumber', result.output.liabilityInsurance.policyNumber)
  }

  // Additional occupants
  if (result.output.additionalOccupants && result.output.additionalOccupants.length > 0) {
    console.log(`\n=== ADDITIONAL OCCUPANTS ===`)
    for (const o of result.output.additionalOccupants) {
      console.log(`  ${o.fullName.value} (conf ${o.fullName.confidence.toFixed(2)})`)
    }
  }

  // Flags
  console.log(`\n=== FLAGS (${result.flags.length}) ===`)
  for (const f of result.flags) {
    console.log(`  [${f.severity}] ${f.category}${f.field ? ` (${f.field})` : ''}: ${f.message}`)
    if (f.found) console.log(`      found: ${f.found}`)
  }
}

function printField(name: string, f: { value: unknown; confidence: number; rawText?: string } | undefined | null) {
  if (!f) {
    console.log(`  ${name.padEnd(22)}: (not extracted)`)
    return
  }
  const conf = f.confidence.toFixed(2)
  const tier = f.confidence >= 0.95 ? 'green ' : f.confidence >= 0.70 ? 'yellow' : 'red   '
  const v = JSON.stringify(f.value)
  console.log(`  ${name.padEnd(22)}: ${tier} ${conf}  ${v}`)
}

main().catch(e => { console.error(e); process.exit(1) })

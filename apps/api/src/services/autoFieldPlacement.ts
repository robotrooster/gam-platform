// Auto field-placement (S556 — ports the S555 deterministic core to a
// production service and adds the model-tagging pass). See
// ~/gam/AUTO_FIELD_PLACEMENT_SPEC.md.
//
// Pipeline:
//   1. DETECT  — deterministic sweep of every blank on a raw lease PDF
//      (underscore runs, "/ /" date lines) with its position + surrounding
//      context. Comprehensiveness mandate (Nic S555): every requested blank
//      becomes a target; nothing is skipped.
//   2. CLASSIFY — the in-house Hermes model reads each blank's context
//      (including labels ABOVE the line, which the heuristic misses) and
//      decides {fieldType, leaseColumn, signerRole, label, split, keep}.
//      Best-effort: on any model failure/timeout we fall back to the
//      deterministic heuristic classification, so placement always works.
//   3. BUILD   — geometry pass: apply per-tenant splits (up to 4 boxes:
//      primary + co_tenant_1..3), inject the 4 tenant signature boxes +
//      landlord date on the signature page, inject per-page tenant initials
//      on no-signature pages, then resolve overlaps (TEXT overlap is a hard
//      no; slight box-box overlap is allowed rather than shrinking a box
//      below usable or dropping it — Nic S555 overlap-priority rule).
//
// Coordinates: ESignPage editor space — PDF points, TOP-LEFT origin, y-DOWN.
// pdfjs baselines are y-UP, so y_box = pageHeight - y_baseline - height - pad.

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { extractPositionedText, type TextItem } from '../lib/pdfText'
import { LEASE_COLUMN_CATEGORY } from '@gam/shared'
import { logger } from '../lib/logger'

const MODEL_URL = process.env.AUTO_FIELD_MODEL_URL || 'http://localhost:8080'
const MODEL_NAME =
  process.env.AUTO_FIELD_MODEL_NAME || '/Users/nicholasrhoades/models/Hermes-4.3-36B-6bit-mlx'
// S582: placement now runs as a DETACHED job (services/autoFieldJobs.ts), so the
// Cloudflare ~100s edge timeout no longer applies — the model gets its natural
// time. This is just a sanity ceiling so a wedged model can't hang a job forever
// (real runs are ~30s on a 5-page lease). Env-overridable.
const MODEL_TIMEOUT_MS = Number(process.env.AUTO_FIELD_MODEL_TIMEOUT_MS || 180000)
const MODEL_ENABLED = (process.env.AUTO_FIELD_MODEL_ENABLED || 'true') !== 'false'

// Tenant signer roles the send-time pruner understands (esign.ts:44,281).
// Unfilled slots are dropped at send, so we may place up to 4 freely.
export const TENANT_ROLES = ['primary', 'co_tenant_1', 'co_tenant_2', 'co_tenant_3'] as const
export type TenantRole = (typeof TENANT_ROLES)[number]
export type SignerRole = TenantRole | 'landlord' | 'witness'
export type FieldType = 'signature' | 'initials' | 'date' | 'text' | 'checkbox' | 'radio_group'

export interface ProposedField {
  page: number
  x: number
  y: number
  width: number
  height: number
  fieldType: FieldType
  signerRole: SignerRole
  leaseColumn: string | null
  label: string | null
  // radio_group extras (S556). options = comma-separated choices. key is a
  // stable proposal-local id; parentKey/parentOption express nesting so the
  // editor can wire a conditional child (the frontend maps keys → field ids).
  options?: string | null
  key?: string
  parentKey?: string | null
  parentOption?: string | null
}

/**
 * S622: called after each page the model classifies — (pagesDone, pagesTotal).
 * Fire-and-forget: a progress sink must never be able to fail the placement, so
 * callers keep their own errors to themselves (runAutoFieldJob swallows its
 * write failures).
 */
export type AutoPlaceProgress = (done: number, total: number) => void

export interface AutoPlaceResult {
  pageCount: number
  fields: ProposedField[]
  modelUsed: boolean
}

const UNDERSCORE_RUN = /_{3,}/g
const SLASHDATE = /\/\s*\/|\/\s*$/

const VALID_COLUMNS = new Set(Object.keys(LEASE_COLUMN_CATEGORY))
const VALID_FIELD_TYPES = new Set<FieldType>(['signature', 'initials', 'date', 'text', 'checkbox'])

// ── heuristic column tagging (fallback + prior to model refinement) ──
function columnFor(ctx: string): string | null {
  const c = ctx.toLowerCase()
  if (/apartment\s*#|apt\.?\s*#|space no\.?|unit\s*#|lot\s*#/.test(c)) return 'unit_number'
  if (/beginning on|commencing|commence/.test(c)) return 'start_date'
  if (/ending on|ending upon|ending|expir/.test(c)) return 'end_date'
  // S582: rent-due-day blank ("due on the ___ day of the month", "due date:").
  // Checked BEFORE rent_amount so "rent is due on the ___" tags the due day, not
  // the amount. Platform-locked to the 1st + auto-filled downstream.
  if (/due (on|by) the|day of (the |each )?month|\bdue date\b|payable (on|by) the/.test(c)) return 'rent_due_day'
  if (/installments of|monthly installments|rental rate|monthly rent|first month.?s rent/.test(c)) return 'rent_amount'
  if (/security deposit/.test(c)) return 'security_deposit'
  if (/pet deposit/.test(c)) return 'pet_deposit'
  if (/pet fee/.test(c)) return 'pet_fee'
  if (/guest fee/.test(c)) return 'other_fee'
  if (/e-?mail|email/.test(c)) return 'tenant_email'
  if (/property address|premises.*address|address of (the )?premises/.test(c)) return 'property_address'
  return null
}

// Sub-item underscore runs, positioned proportionally within the text item.
function blankRuns(it: TextItem): Array<{ x: number; width: number; before: string }> {
  const runs: Array<{ x: number; width: number; before: string }> = []
  const w = it.x2 - it.x
  const charW = w / Math.max(1, it.text.length)
  let m: RegExpExecArray | null
  UNDERSCORE_RUN.lastIndex = 0
  while ((m = UNDERSCORE_RUN.exec(it.text))) {
    runs.push({
      x: it.x + m.index * charW,
      width: Math.max(24, m[0].length * charW),
      before: it.text.slice(0, m.index),
    })
  }
  return runs
}

// ── detection ──────────────────────────────────────────────────────

interface RawTarget {
  id: number
  page: number
  kind: 'blank' | 'slashdate'
  x: number // left of the blank (PDF x)
  yTop: number // box top in editor space (flipped, y-down)
  width: number // clamped blank width
  // context for classification
  leftCtx: string
  lineText: string
  aboveText: string
  belowText: string
  sigAboveText: string
  roleByX: SignerRole // nearest signature-label role (positional)
  pageW: number
  pageH: number
}

interface Rect {
  x0: number
  y0: number
  x1: number
  y1: number
}

interface PageMeta {
  page: number
  width: number
  height: number
  hasSignatureHeader: boolean
  // Bounding boxes (editor space, y-down) of PRINTED WORDS only — underscore
  // runs and whitespace are excluded, so a box sitting on a blank does not
  // count as a collision, but a box landing on real text does.
  textRects: Rect[]
}

export interface SigLabel { role: SignerRole; x: number; y: number }

/**
 * S622: which signature COLUMN does a box at (bx, by) sit in?
 *
 * Signature labels mark the LEFT EDGE of their column ("TENANT(S) SIGNATURE:"
 * at x=43, "LANDLORD SIGNATURE:" at x=295, each block ~182 wide), so the
 * question is containment — the last label at or left of the box — not which
 * label happens to be nearest.
 *
 * Nearest-by-distance put a date at x=132, plainly inside the tenant column, on
 * the LANDLORD: the lookup ran at the slash glyph's x (192, because a "/  /"
 * box is drawn 60pt left of the slashes) and 192 is nearer 295 than 43. Nic
 * found it as tenant signing dates recording the landlord's date. Callers must
 * pass the BOX's own left x, never a glyph position.
 */
export function signerColumnAt(labels: SigLabel[], bx: number, by: number): SignerRole {
  const above = labels.filter((s) => s.y > by - 6)
  if (above.length === 0) return 'primary'
  const containing = above.filter((s) => s.x <= bx + 6).sort((a, b) => b.x - a.x)
  if (containing.length > 0) return containing[0].role
  // Box sits left of every label — fall back to the nearest.
  return above.slice().sort((a, b) => Math.abs(a.x - bx) - Math.abs(b.x - bx))[0].role
}

function detectTargets(pages: ReturnType<() => any>): { targets: RawTarget[]; pageMeta: PageMeta[] } {
  const targets: RawTarget[] = []
  const pageMeta: PageMeta[] = []
  let idc = 0

  for (const pg of pages) {
    const H = pg.height
    const W = pg.width
    const items: TextItem[] = (pg.items as TextItem[]).filter((i) => i.text && i.text.length)

    // group into lines by baseline y
    const lines: Array<{ y: number; items: TextItem[] }> = []
    for (const it of items.slice().sort((a, b) => b.y - a.y || a.x - b.x)) {
      let line = lines.find((l) => Math.abs(l.y - it.y) < 3)
      if (!line) {
        line = { y: it.y, items: [] }
        lines.push(line)
      }
      line.items.push(it)
    }
    lines.forEach((l) => l.items.sort((a, b) => a.x - b.x))

    // signature/role labels on this page: {role, x, y} from "... SIGNATURE"
    const sigLabels: Array<{ role: SignerRole; x: number; y: number }> = []
    for (const line of lines) {
      for (let i = 0; i < line.items.length; i++) {
        if (/signature/i.test(line.items[i].text)) {
          const pre = line.items
            .slice(Math.max(0, i - 3), i + 1)
            .map((x) => x.text)
            .join(' ')
            .toLowerCase()
          sigLabels.push({
            role: /landlord|lessor|owner|agent|manager/.test(pre) ? 'landlord' : 'primary',
            x: line.items[i].x,
            y: line.items[i].y,
          })
        }
      }
    }
    // S622: which signature COLUMN does this box sit in?
    //
    // Signature labels mark the LEFT EDGE of their column ("TENANT(S)
    // SIGNATURE:" at x=43, "LANDLORD SIGNATURE:" at x=295, each block ~182
    // wide). So the question is containment — the last label at or left of the
    // box — not which label centre happens to be nearest. Nearest-by-distance
    // put a date at x=132, plainly inside the tenant column, on the landlord:
    // 132 is 89 from the tenant label but the lookup ran at the SLASH GLYPH's x
    // (192, since a "/ /" box is drawn 60pt to the left of the slashes), and
    // 192 is nearer 295 than 43.
    //
    // Nic found this as tenant signing dates recording the LANDLORD's signing
    // date. On a signed lease that is not cosmetic, so it is worth being exact:
    // callers must pass the BOX's own left x, never a glyph position.
    const roleByX = (bx: number, by: number): SignerRole => signerColumnAt(sigLabels, bx, by)

    const flipY = (it: TextItem) => Math.round(H - it.y - (it.height || 10) - 2)

    for (const line of lines) {
      const lineText = line.items.map((i) => i.text).join(' ')
      const aboveText = lines
        .filter((l) => l.y > line.y && l.y - line.y < 24)
        .flatMap((l) => l.items)
        .map((i) => i.text)
        .join(' ')
        .toLowerCase()
      const sigAboveText = lines
        .filter((l) => l.y > line.y && l.y - line.y < 48)
        .flatMap((l) => l.items)
        .map((i) => i.text)
        .join(' ')
        .toLowerCase()
      const belowText = lines
        .filter((l) => l.y < line.y && line.y - l.y < 16)
        .flatMap((l) => l.items)
        .map((i) => i.text)
        .join(' ')
        .toLowerCase()

      for (let k = 0; k < line.items.length; k++) {
        const it = line.items[k]
        if (!/_{3,}/.test(it.text)) continue
        const nextText = line.items.slice(k + 1).find((o) => !/^[_\s]+$/.test(o.text))

        for (const run of blankRuns(it)) {
          let right = run.x + run.width
          if (nextText && nextText.x > run.x) right = Math.min(right, nextText.x - 2)
          right = Math.min(right, W - 20)
          const width = Math.max(20, Math.round(right - run.x))
          if (width < 20) continue
          const leftCtx = (line.items.slice(0, k).map((i) => i.text).join(' ') + ' ' + run.before).trim()

          targets.push({
            id: idc++,
            page: pg.pageNumber,
            kind: 'blank',
            x: Math.round(run.x),
            yTop: flipY(it),
            width,
            leftCtx,
            lineText,
            aboveText,
            belowText,
            sigAboveText,
            roleByX: roleByX(run.x, it.y),
            pageW: W,
            pageH: H,
          })
        }
      }

      // "/ /" date placeholders with a "Date" label below. A single line can
      // carry TWO (a tenant column AND a landlord column on the same signature
      // row), so cluster all slash tokens and emit one date box per cluster —
      // detecting only the first would drop the landlord's date.
      if (SLASHDATE.test(lineText) && /\bdate\b/.test(belowText)) {
        const slashItems = line.items.filter((i) => i.text.includes('/')).sort((a, b) => a.x - b.x)
        const clusters: TextItem[] = []
        for (const s of slashItems) {
          const prev = clusters[clusters.length - 1]
          if (prev && s.x - prev.x < 50) continue // same "/ /" placeholder
          clusters.push(s)
        }
        for (const slash of clusters) {
          targets.push({
            id: idc++,
            page: pg.pageNumber,
            kind: 'slashdate',
            x: Math.round(slash.x - 60),
            yTop: flipY(slash),
            width: 90,
            leftCtx: line.items.map((i) => i.text).join(' ').toLowerCase(),
            lineText,
            aboveText,
            belowText,
            sigAboveText,
            // S622: the BOX's x (slash.x - 60), matching where it is drawn —
            // passing the glyph x looked the role up 60pt into the next column.
            roleByX: roleByX(Math.round(slash.x - 60), slash.y),
            pageW: W,
            pageH: H,
          })
        }
      }
    }

    const textRects: Rect[] = []
    for (const it of items) {
      if (!/[^\s_]/.test(it.text)) continue // skip underscore/whitespace-only
      const top = flipY(it)
      textRects.push({ x0: it.x, y0: top, x1: it.x2, y1: top + (it.height || 10) })
    }

    pageMeta.push({
      page: pg.pageNumber,
      width: W,
      height: H,
      hasSignatureHeader: sigLabels.length > 0,
      textRects,
    })
  }

  return { targets, pageMeta }
}

// ── classification ──────────────────────────────────────────────────

interface Classification {
  keep: boolean
  fieldType: FieldType
  leaseColumn: string | null
  signerRole: SignerRole
  label: string | null
  split: 'per_tenant' | 'none'
}

// Name-entry line detector (per-signer NAME → up to 4 boxes). Deliberately
// narrow so inline term blanks ("rent of $___") never get name-split.
const NAME_LINE =
  /tenant\(s\):\s*_|^\s*tenant\(s\):|resident\(s\):\s*_|lessee\(s\):\s*_|name\(s\) of tenant/i
// Per-tenant contact lines that itemize each occupant on one line.
const PER_TENANT_LINE =
  /telephone\(s\)|phone\(s\)|birthdate\(s\)|date\(s\) of birth|driver'?s license\(s\)|d\.?l\.? number\(s\)|email\(s\)/i
// Roster of all occupants → ONE landlord-typed box (Nic S555 revision).
const ROSTER_LINE =
  /names of all persons|following named persons|persons (who will be )?occupying|all persons (who will )?(occupy|stay|reside)|other occupants/i

// Fields the TENANT personally fills (their own info). Everything else that
// isn't a signature/initials/signing-date is landlord-filled at drafting —
// the tenant must never set rent, term dates, space number, fees, etc.
const PERSONAL_RE = /birth|phone|telephone|driver'?s? ?licen|d\.?l\.? ?(no|num|#)|\baddress\b|emergency contact|\bemail\b|e-?mail|insurance|policy\s*(no|num|#|number)|\bcarrier\b/i
// SHORT personal fields — each occupant has their own, so split per-tenant
// (name, phone, birthdate, driver's license, email). General across leases.
const SHORT_PERSONAL_RE = /\bname\b|phone|telephone|\bcell\b|\bmobile\b|birth|date of birth|\bd\.?o\.?b\b|driver'?s? ?licen|d\.?l\.? ?(no|num|#)|\bemail\b|e-?mail|social security|\bssn\b/i
// LONG personal fields — one box, never split (addresses run long; emergency
// contact is a name+phone+relationship blob). Email excluded ("email address").
const BIRTH_RE = /birth|date of birth|\bd\.?o\.?b\b/i

function isPersonal(label: string | null, ctx: string): boolean {
  return PERSONAL_RE.test(`${label || ''} ${ctx}`)
}
// A long personal field gets ONE box (addresses, emergency contact), overriding
// any per-tenant split. Email is short even though it contains "address".
function isLongPersonal(ctx: string): boolean {
  if (/e-?mail|email/i.test(ctx)) return false
  return /\baddress\b|emergency contact/i.test(ctx)
}

// Role for any NON-signature, NON-initials, NON-signing-date blank. Personal
// tenant info → the tenant (primary; per-tenant splits fan out later);
// everything else (property/term/money/fees/utilities/agreement-date/space/
// roster) → landlord. This is deterministic — the model's role is ignored
// here because it over-assigned tenant on the mobile-home lease.

function nonSigRole(col: string | null, label: string | null, ctx: string, split: 'per_tenant' | 'none'): SignerRole {
  // S622: a bound lease column is DECISIVE, and is checked before anything that
  // reads the words around the blank. If a blank maps to a column, GAM holds
  // that value and prefills it — so a tenant-entry box for it is wrong by
  // construction. Nic, on finding the unit number scoped to the tenant: "they're
  // not gonna type in what apartment they're going into... that's gonna
  // invalidate the whole thing if they type that wrong."
  //
  // The old order let proximity win. "Apartment #" sitting on an "Address:" line
  // matched the personal-info pattern, so unit_number went to the tenant.
  // property_address was latently broken the same way — 'address' is literally in
  // that pattern — and would have handed the tenant the property's own address.
  // Nic S622, extending the rule to names: "Names should be landlord filled out
  // too just for accuracy. And that way if there ever is a fault, the landlord
  // can't blame it on the tenant." That reasoning covers every value GAM already
  // holds, so the rule is simply: a bound lease column is landlord-filled. The
  // tenant's own name and email are on the send form the landlord fills in, so
  // they are the landlord's to state correctly.
  //
  // Genuinely tenant-supplied facts — date of birth, emergency contact, driver's
  // licence, phone — carry NO lease column (the landlord does not hold them), so
  // they fall through to the personal-info path below and stay with the tenant.
  if (col) return 'landlord'
  if (split === 'per_tenant') return 'primary'
  if (isPersonal(label, ctx)) return 'primary'
  return 'landlord'
}

// S622: exported for the role-scoping test. Given a mapped lease column, who
// owns the box?
export function roleForLeaseColumn(col: string): SignerRole {
  return nonSigRole(col, null, '', 'none')
}

function heuristicClassify(t: RawTarget): Classification {
  const lo = t.leftCtx.toLowerCase()
  const sigNear =
    (/signature/.test(t.sigAboveText) || /signature/.test(lo)) && t.width > 100
  const dateNear =
    t.kind === 'slashdate' || /\bdate\b/.test(t.belowText) || /\bdate\b/.test(lo)
  let leaseColumn = columnFor(t.leftCtx)

  if (t.kind === 'slashdate') {
    return { keep: true, fieldType: 'date', leaseColumn: 'date_signed', signerRole: t.roleByX, label: 'Date', split: 'none' }
  }
  if (sigNear) {
    const role = t.roleByX
    return {
      keep: true,
      fieldType: 'signature',
      leaseColumn: role === 'landlord' ? 'landlord_signature' : 'tenant_signature',
      signerRole: role,
      label: 'Signature',
      split: 'none',
    }
  }
  if (dateNear) {
    return { keep: true, fieldType: 'date', leaseColumn: leaseColumn || 'date_signed', signerRole: t.roleByX, label: 'Date', split: 'none' }
  }
  if (leaseColumn === 'start_date' || leaseColumn === 'end_date') {
    return { keep: true, fieldType: 'date', leaseColumn, signerRole: 'landlord', label: null, split: 'none' }
  }
  const lineLo = t.lineText.toLowerCase()
  const notLandlordCtx = !/landlord|lessor|owner|property|premises|agent|manager/.test(`${lineLo} ${t.aboveText}`)
  // LONG personal field (address, emergency contact) → ONE tenant box, never
  // split (addresses run long — Nic S556).
  if (isLongPersonal(`${t.lineText} ${t.aboveText}`)) {
    return { keep: true, fieldType: 'text', leaseColumn: null, signerRole: 'primary', label: 'Address', split: 'none' }
  }
  // SHORT per-tenant personal fields (name, phone, birthdate, DL, email) →
  // split into up to 4 tenant boxes; birthdates become date fields. General
  // rule so it works on any uploaded lease, not just the sample.
  const shortPersonal = (NAME_LINE.test(t.lineText) || PER_TENANT_LINE.test(t.lineText) || (SHORT_PERSONAL_RE.test(t.lineText) && notLandlordCtx))
  if (shortPersonal && !ROSTER_LINE.test(t.lineText) && t.width > 60) {
    const isName = NAME_LINE.test(t.lineText) || (/\bname\b/i.test(lineLo) && notLandlordCtx)
    const isBirth = BIRTH_RE.test(t.lineText)
    return {
      keep: true,
      fieldType: isBirth ? 'date' : 'text',
      leaseColumn: isName ? 'tenant_name' : null,
      signerRole: 'primary',
      label: isName ? 'Tenant name' : isBirth ? 'Date of birth' : null,
      split: 'per_tenant',
    }
  }
  // roster → single landlord-typed box. The roster label often sits on the
  // line ABOVE the blank ("following named persons:" then a full-width
  // underscore line), so check aboveText too.
  if (ROSTER_LINE.test(t.lineText) || ROSTER_LINE.test(t.aboveText)) {
    return { keep: true, fieldType: 'text', leaseColumn: null, signerRole: 'landlord', label: 'Occupants', split: 'none' }
  }
  // comprehensiveness: unknown blank still gets a typeable box — landlord-
  // filled unless it reads as tenant-personal info.
  const ctx = `${t.leftCtx} ${t.lineText} ${t.aboveText}`
  return { keep: true, fieldType: 'text', leaseColumn, signerRole: nonSigRole(leaseColumn, null, ctx, 'none'), label: null, split: 'none' }
}

const MODEL_SYSTEM = `You classify the BLANK FILL-IN spaces on a residential lease so an e-sign system can drop the right input box on each. You are given one TARGET per blank with the text to its LEFT, the FULL LINE, the text ABOVE it, and the text BELOW it. Labels often sit ABOVE the blank (e.g. a line reading "TENANT SIGNATURE" above the blank), so use the ABOVE text.

For EACH target return an object keyed by its id:
- keep: false if the underscores are DECORATIVE (a rule/divider, a table border, a fill-to-margin line with no field) — true if it is a real blank the lease asks someone to fill in.
- fieldType: one of "signature" | "initials" | "date" | "text" | "checkbox".
  - "signature" only when a signature line (look for "SIGNATURE" above or beside).
  - "date" for any date blank incl. signing dates and "beginning/ending on" term dates.
  - "checkbox" for a short blank that selects an option ("___ FIXED TERM", "___ Month-to-month").
  - "text" otherwise.
- signerRole: "landlord" for anything the landlord/agent fills OR signs; "primary" for the main tenant's own signature/initials/personal info; "co_tenant_1".."co_tenant_3" only if the line clearly belongs to an additional named tenant; "witness" if a witness line.
- leaseColumn: the machine column from the ALLOWED LIST, or null if none fits. Never invent a column not on the list.
- split: "per_tenant" for SHORT personal fields each occupant has their own of — NAME, PHONE/telephone, BIRTHDATE/date of birth, DRIVER'S LICENSE, EMAIL — even if the lease shows a single blank; the geometry layer fans it into up to 4 boxes. Use "none" for LONG fields (any mailing/current/home/street ADDRESS, EMERGENCY CONTACT — these run long, one box), for a single roster line listing all occupant names (one landlord box), and for every non-personal field.
- label: a short human label (e.g. "Tenant name", "Phone", "Date of birth", "Signature") or null.

Output STRICT JSON only, no prose:
{ "1": {"keep":true,"fieldType":"text","signerRole":"primary","leaseColumn":"tenant_name","split":"per_tenant","label":"Tenant name"}, ... }`

// Classify ONE chunk of targets via the model. Returns a map for the targets it
// resolved (model tags + per-target heuristic fallback for any the model omits),
// or null if the model CALL itself fails/times out — the caller then falls back
// to heuristic for this chunk's targets. Assumes targets.length > 0.
async function classifyChunk(targets: RawTarget[]): Promise<Map<number, Classification> | null> {
  const allowed = Array.from(VALID_COLUMNS).join(', ')
  const lines = targets.map((t) => {
    const ctx = {
      id: t.id,
      left: t.leftCtx.slice(-80),
      line: t.lineText.slice(0, 160),
      above: t.aboveText.slice(-80),
      below: t.belowText.slice(0, 80),
    }
    return JSON.stringify(ctx)
  })
  const user =
    `ALLOWED LEASE COLUMNS: ${allowed}\n\nTARGETS (one JSON object per blank):\n` +
    lines.join('\n')

  // Dev-only cache of the raw model response, keyed by the prompt hash. Lets
  // iteration on the deterministic sanitize/geometry layers skip the model call.
  // Gated by AUTO_FIELD_MODEL_CACHE (a directory); unset in prod.
  const cacheDir = process.env.AUTO_FIELD_MODEL_CACHE
  const cacheKey = crypto.createHash('sha256').update(MODEL_SYSTEM + '\n' + user).digest('hex').slice(0, 32)
  const cacheFile = cacheDir ? path.join(cacheDir, `afp_${cacheKey}.json`) : null
  if (cacheFile && fs.existsSync(cacheFile)) {
    try {
      const raw = fs.readFileSync(cacheFile, 'utf8')
      const parsed = JSON.parse(raw.replace(/^```json?/i, '').replace(/```$/, '').trim())
      const map = new Map<number, Classification>()
      for (const t of targets) map.set(t.id, parsed[String(t.id)] ? sanitize(parsed[String(t.id)], t) : heuristicClassify(t))
      return map
    } catch { /* fall through to live call */ }
  }

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), MODEL_TIMEOUT_MS)
  try {
    const res = await fetch(`${MODEL_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL_NAME,
        temperature: 0,
        max_tokens: 6000,
        messages: [
          { role: 'system', content: MODEL_SYSTEM },
          { role: 'user', content: user },
        ],
      }),
      signal: ctrl.signal,
    })
    if (!res.ok) throw new Error(`model HTTP ${res.status}`)
    const j: any = await res.json()
    const raw: string = j.choices?.[0]?.message?.content ?? ''
    if (cacheFile) { try { fs.mkdirSync(cacheDir!, { recursive: true }); fs.writeFileSync(cacheFile, raw) } catch { /* noop */ } }
    const parsed = JSON.parse(raw.replace(/^```json?/i, '').replace(/```$/, '').trim())
    const map = new Map<number, Classification>()
    for (const t of targets) {
      const r = parsed[String(t.id)]
      map.set(t.id, r ? sanitize(r, t) : heuristicClassify(t)) // model omitted it → heuristic (comprehensiveness)
    }
    return map
  } catch (e: any) {
    logger.warn({ err: e?.message }, 'autoFieldPlacement: model chunk failed, using heuristic for this page')
    return null
  } finally {
    clearTimeout(timer)
  }
}

// S582: classify PER PAGE so a slow/failed page only loses ITS labels (the other
// pages keep their AI tags) and each call is smaller + faster. Sequential — the
// local model serves one request at a time, so parallel calls would only contend.
// A page whose call fails contributes nothing to the map; those targets fall back
// to heuristic in autoPlaceFields (boxes are still placed — only labels degrade).
async function modelClassify(
  targets: RawTarget[],
  totalPages: number,
  onProgress?: AutoPlaceProgress,
): Promise<Map<number, Classification> | null> {
  if (!MODEL_ENABLED || targets.length === 0) return null
  const byPage = new Map<number, RawTarget[]>()
  for (const t of targets) {
    const arr = byPage.get(t.page)
    if (arr) arr.push(t)
    else byPage.set(t.page, [t])
  }
  const combined = new Map<number, Classification>()
  let anySuccess = false
  // S622: this loop IS the wait — one model call per page, sequential. Report
  // after each page so the editor can show real progress instead of a spinner
  // that looks identical to a hang.
  //
  // Progress is denominated in DOCUMENT pages, not in pages the model visits.
  // Only pages containing blanks cost model time (an 8-page lease commonly has
  // 5), but every page ends up with fields on it — initials are injected
  // per-page AFTER classification — so counting the model's work unit reported
  // "3 of 5" for a lease the landlord can see is 8 pages long. Ascending page
  // order means finishing page N settles every page up to N: the ones with no
  // blanks needed no work, so they are done the moment we pass them.
  const pagesAscending = [...byPage.entries()].sort((a, b) => a[0] - b[0])
  onProgress?.(0, totalPages)
  for (const [pageNo, pageTargets] of pagesAscending) {
    const m = await classifyChunk(pageTargets)
    if (m) { anySuccess = true; for (const [id, c] of m) combined.set(id, c) }
    onProgress?.(Math.min(pageNo, totalPages), totalPages)
  }
  return anySuccess ? combined : null
}

// Constrain model output to valid enums; fall back to heuristic per-field.
function sanitize(r: any, t: RawTarget): Classification {
  const h = heuristicClassify(t)
  let ft: FieldType = VALID_FIELD_TYPES.has(r.fieldType) ? r.fieldType : h.fieldType
  let col: string | null = null
  if (typeof r.leaseColumn === 'string' && VALID_COLUMNS.has(r.leaseColumn)) col = r.leaseColumn
  let split: 'per_tenant' | 'none' = r.split === 'per_tenant' ? 'per_tenant' : 'none'
  const label = typeof r.label === 'string' && r.label ? r.label.slice(0, 60) : h.label
  const ctx = `${t.leftCtx} ${t.lineText} ${t.aboveText}`

  // LONG personal field (address, emergency contact) → ONE box, never split
  // (Nic S556). Short personal fields keep the model's per_tenant split.
  if (isLongPersonal(ctx)) { split = 'none' }
  // Birthdate → date field.
  if (BIRTH_RE.test(ctx) && ft === 'text') ft = 'date'

  let role: SignerRole
  // Signature and signing-date ROLE is layout-driven (which column the blank
  // sits in), not semantic — the model gets side-flips wrong. Trust the
  // positional label read (roleByX) for these two.
  if (ft === 'signature') {
    role = t.roleByX
    col = role === 'landlord' ? 'landlord_signature' : 'tenant_signature'
  } else if (
    // S622: a "/  /" placeholder under a signature block IS a signing date —
    // that is what the shape means on a lease. It was only treated as one when
    // the word "signature" happened to appear just above it, and on this lease
    // the line above the dates is the signature RULE (underscores), not the
    // caption. So both tenant dates came through with NO lease column: they
    // recorded nothing, and the missing landlord date_signed then triggered an
    // injected duplicate on top. Bind it from the SHAPE instead.
    //
    // Excluding birthdates, which are the other thing written as "__/__/__".
    (t.kind === 'slashdate' && !BIRTH_RE.test(ctx)) ||
    (ft === 'date' && (col === 'date_signed' || (!col && /signature|sign/.test(t.sigAboveText))))
  ) {
    ft = 'date'
    role = t.roleByX
    col = 'date_signed'
  } else if (ft === 'initials') {
    role = 'primary'
  } else {
    // Everything else is deterministic: personal tenant info → tenant, all
    // property/term/money/agreement fields → landlord. The model over-assigned
    // tenant on the mobile-home lease (tenant would set their own rent/dates),
    // so its role is ignored here.
    role = nonSigRole(col, label, ctx, split)
  }
  return {
    // Comprehensiveness mandate (Nic S555): never skip a blank the lease asks
    // for. We do NOT honor the model's keep:false — it over-rejected real
    // labeled blanks (e.g. the occupancy roster line) as decorative.
    keep: true,
    fieldType: ft,
    leaseColumn: col,
    signerRole: role,
    label,
    split,
  }
}

// ── geometry / build ────────────────────────────────────────────────

const hitsText = (x: number, y: number, w: number, h: number, rects: Rect[]) =>
  rects.some((r) => x < r.x1 && r.x0 < x + w && y < r.y1 && r.y0 < y + h)

// Scan downward from startY for a y where a box of (x,w,h) clears all printed
// text on the page. Returns null if no text-free slot fits (caller then skips
// the box rather than overlapping text — the hard rule).
function findClearY(x: number, w: number, h: number, startY: number, pm: PageMeta): number | null {
  for (let y = startY; y <= pm.height - h - 4; y += 6) {
    if (!hitsText(x, y, w, h, pm.textRects)) return y
  }
  return null
}

function tenantColumnFor(base: string | null, n: number): string | null {
  // Only the primary box carries the machine column (e.g. tenant_name);
  // co-tenant boxes are free-text so the send-time value map doesn't collide.
  return n === 0 ? base : null
}

function buildFields(
  targets: RawTarget[],
  cls: Map<number, Classification>,
  pageMeta: PageMeta[],
): ProposedField[] {
  const fields: ProposedField[] = []
  const pageHasSignature: Record<number, boolean> = {}

  for (const t of targets) {
    const c = cls.get(t.id)!
    if (!c.keep) continue

    if (c.fieldType === 'signature') pageHasSignature[t.page] = true

    if (c.split === 'per_tenant' && t.width > 60) {
      const total = Math.min(t.x + t.width, t.pageW - 30) - t.x
      const bw = Math.max(60, Math.floor(total / 4) - 6)
      for (let n = 0; n < 4; n++) {
        fields.push({
          page: t.page,
          x: Math.round(t.x + n * (bw + 6)),
          y: t.yTop,
          width: bw,
          height: 20,
          fieldType: c.fieldType === 'signature' ? 'signature' : c.fieldType === 'date' ? 'date' : 'text',
          // S622: a per-tenant SIGNATURE or INITIAL belongs to that tenant slot —
          // and its role is what the send path prunes on, so an unfilled slot
          // disappears. A per-tenant landlord-filled value (the names) keeps the
          // landlord role: the sign view serves each signer only the fields
          // carrying their own role, so this is what actually stops a tenant
          // typing their own name. Unused name boxes simply stay blank, the way
          // they would on paper.
          signerRole: c.signerRole === 'landlord' ? 'landlord' : TENANT_ROLES[n],
          leaseColumn: tenantColumnFor(c.leaseColumn, n),
          label: c.label ? `${c.label} ${n + 1}` : `Tenant ${n + 1}`,
        })
      }
      continue
    }

    const h = c.fieldType === 'signature' ? 24 : c.fieldType === 'checkbox' ? 16 : 20
    const w = c.fieldType === 'checkbox' ? 16 : t.width
    fields.push({
      page: t.page,
      x: t.x,
      y: t.yTop,
      width: w,
      height: h,
      fieldType: c.fieldType,
      signerRole: c.signerRole,
      leaseColumn: c.leaseColumn,
      label: c.label,
    })
  }

  // Ensure 4 tenant signature boxes + a landlord date on each signature page
  // (Nic S555: 2 tenant lines exist → invent the other 2; add landlord date).
  for (const pm of pageMeta) {
    if (!pageHasSignature[pm.page]) continue

    // S622: a signature RULE that carries no caption reads as a plain blank, so
    // it lands as an unlabeled text box — and then the injector below, seeing
    // only one tenant signature, invents replacements ON TOP of it. Nic saw the
    // result as "a text field box to type something" plus a spare date.
    //
    // A blank that lines up EXACTLY with a signature box already found on this
    // page — same column, same width — is another line of the same block. The
    // match is deliberately strict (6pt on both x and width, no label, no bound
    // column) because promoting an ordinary text field to a signature would be
    // the worse error.
    const proto = fields.find(
      (f) => f.page === pm.page && f.fieldType === 'signature' &&
        f.signerRole !== 'landlord' && f.signerRole !== 'witness')
    if (proto) {
      for (const f of fields) {
        if (f.page !== pm.page || f.fieldType !== 'text') continue
        if (f.leaseColumn || (f.label && f.label.trim())) continue
        if (Math.abs(f.x - proto.x) > 6 || Math.abs(f.width - proto.width) > 6) continue
        f.fieldType = 'signature'
        f.height = proto.height
        f.leaseColumn = 'tenant_signature'
        f.label = 'Signature'
        // Role is set by vertical order in the reassignment just below.
        f.signerRole = 'primary'
      }
    }

    const pageSigs = fields.filter((f) => f.page === pm.page && f.fieldType === 'signature')
    // Tenant side = anything not landlord/witness (classification forced
    // signature role to the positional side, so these are the tenant column).
    const tenantSigs = pageSigs
      .filter((f) => f.signerRole !== 'landlord' && f.signerRole !== 'witness')
      .sort((a, b) => a.y - b.y)
    const landlordSigs = pageSigs.filter((f) => f.signerRole === 'landlord')

    // Reassign detected tenant signatures to distinct roles by vertical order
    // (top→bottom = primary, co_tenant_1..3) so no two boxes collide on the
    // same signer, then invent the remaining slots below the lowest one to
    // reach 4 (Nic S555: 2 lines exist → invent the other 2).
    if (tenantSigs.length > 0) {
      tenantSigs.forEach((f, i) => {
        f.signerRole = TENANT_ROLES[Math.min(i, 3)]
        f.leaseColumn = 'tenant_signature'
      })
      const anchor = tenantSigs[tenantSigs.length - 1]
      // Align invented date boxes to the same x/width as the detected tenant
      // date boxes (which sit right-of-center under their signature line), so
      // all four date boxes line up (Nic S556). Fallback: right half of the sig.
      const detDate = fields.find(
        (f) => f.page === pm.page && f.fieldType === 'date' && f.leaseColumn === 'date_signed' &&
          (TENANT_ROLES as readonly string[]).includes(f.signerRole),
      )
      const dateX = detDate ? detDate.x : anchor.x + Math.round(anchor.width / 2)
      const dateW = detDate ? detDate.width : 90
      let startY = anchor.y + anchor.height + 16
      for (let i = tenantSigs.length; i < 4; i++) {
        // Only invent into genuinely blank space — never on top of text.
        const ys = findClearY(anchor.x, anchor.width, anchor.height, startY, pm)
        if (ys == null) break
        fields.push({
          page: pm.page,
          x: anchor.x,
          y: ys,
          width: anchor.width,
          height: anchor.height,
          fieldType: 'signature',
          signerRole: TENANT_ROLES[i],
          leaseColumn: 'tenant_signature',
          label: 'Signature',
        })
        // Each invented signature gets its own date box underneath (aligned
        // with the detected tenants' date boxes).
        const yd = findClearY(dateX, dateW, 18, ys + anchor.height + 8, pm)
        if (yd != null) {
          fields.push({
            page: pm.page,
            x: dateX,
            y: yd,
            width: dateW,
            height: 18,
            fieldType: 'date',
            signerRole: TENANT_ROLES[i],
            leaseColumn: 'date_signed',
            label: 'Date',
          })
        }
        // spread the next invented block out below this sig+date pair
        startY = (yd != null ? yd + 18 : ys + anchor.height) + 18
      }
    }
  }

  // Signing-date boxes take the role of the signature they pair with (nearest
  // by center distance on the same page). The detection heuristic sided these
  // by distance to the "SIGNATURE" label, which put tenant-column dates on the
  // landlord because the tenant label's left edge is far away. The signature
  // boxes now carry correct roles, so pair to them instead.
  for (const f of fields) {
    if (f.fieldType !== 'date' || f.leaseColumn !== 'date_signed') continue
    const sigs = fields.filter((s) => s.page === f.page && s.fieldType === 'signature')
    if (!sigs.length) continue
    const fcx = f.x + f.width / 2
    const fcy = f.y + f.height / 2
    let best = sigs[0]
    let bestD = Infinity
    for (const s of sigs) {
      const d = Math.hypot(s.x + s.width / 2 - fcx, s.y + s.height / 2 - fcy)
      if (d < bestD) { bestD = d; best = s }
    }
    f.signerRole = best.signerRole
  }

  // After roles are final: if a page has a landlord signature but no landlord
  // signing-date box (some leases print no "/ /" on the landlord side), add
  // one just below the landlord signature into text-free space.
  for (const pm of pageMeta) {
    const landlordSigs = fields.filter((f) => f.page === pm.page && f.fieldType === 'signature' && f.signerRole === 'landlord')
    if (!landlordSigs.length) continue
    const hasLandlordDate = fields.some((f) => f.page === pm.page && f.signerRole === 'landlord' && f.fieldType === 'date' && f.leaseColumn === 'date_signed')
    if (hasLandlordDate) continue
    const ls = landlordSigs[0]
    const y = findClearY(ls.x, 90, 18, ls.y + ls.height + 8, pm) ?? ls.y
    fields.push({
      page: pm.page,
      x: ls.x,
      y,
      width: 90,
      height: 18,
      fieldType: 'date',
      signerRole: 'landlord',
      leaseColumn: 'date_signed',
      label: 'Date',
    })
  }

  // Lift signature boxes up off the underscore so the signature sits ABOVE
  // the line instead of striking through it (Nic S556). Guarded by the text-
  // collision check — a box never rises into printed text above it (so this is
  // a no-op where a label sits directly above).
  const rectsByPage: Record<number, Rect[]> = {}
  for (const pm of pageMeta) rectsByPage[pm.page] = pm.textRects
  for (const f of fields) {
    if (f.fieldType !== 'signature') continue
    const lift = Math.round(f.height / 2) + 4
    const cand = f.y - lift
    if (cand >= 2 && !hitsText(f.x, cand, f.width, f.height, rectsByPage[f.page] || [])) f.y = cand
  }

  // Per-page TENANT initials on no-signature pages (spec #5): exactly 4, one
  // per tenant. If the lease already prints its own "Initials ___" spot, place
  // the row AT that spot and drop the detected box (never 5 boxes on a 4-person
  // page — Nic S556). Otherwise inject a bottom-right row.
  const bw = 44
  const gap = 6
  const rowW = bw * 4 + gap * 3
  for (const pm of pageMeta) {
    if (pageHasSignature[pm.page]) continue
    const existing = fields.filter((f) => f.page === pm.page && f.fieldType === 'initials')
    let startX: number
    let y: number
    if (existing.length) {
      const anchor = existing.slice().sort((a, b) => a.x - b.x)[0]
      y = anchor.y
      startX = Math.min(anchor.x, pm.width - 8 - rowW)
      // remove the lease's detected initials box(es) — replaced by the 4-row
      for (let i = fields.length - 1; i >= 0; i--) {
        if (fields[i].page === pm.page && fields[i].fieldType === 'initials') fields.splice(i, 1)
      }
    } else {
      startX = pm.width - 36 - rowW
      y = pm.height - 32
    }
    for (let n = 0; n < 4; n++) {
      fields.push({
        page: pm.page,
        x: Math.round(startX + n * (bw + gap)),
        y: Math.round(y),
        width: bw,
        height: 18,
        fieldType: 'initials',
        signerRole: TENANT_ROLES[n],
        leaseColumn: 'tenant_initial',
        label: `Initial ${n + 1}`,
      })
    }
  }

  return resolveOverlaps(fields)
}

// Overlap resolution (Nic S555 overlap-priority rule). TEXT overlap is
// prevented at detection (widths clamp to the blank extent). Here we only
// de-conflict BOX-vs-BOX: trim the later box's left edge, but NEVER shrink it
// below a usable width or drop it — a little box-box overlap is acceptable
// because the input value renders centered.
function resolveOverlaps(fields: ProposedField[]): ProposedField[] {
  const MINW = 40
  const GAP = 2
  const intersect = (a: ProposedField, b: ProposedField) =>
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
  const byPage: Record<number, ProposedField[]> = {}
  for (const f of fields) (byPage[f.page] = byPage[f.page] || []).push(f)
  for (const p of Object.keys(byPage)) {
    const boxes = byPage[Number(p)].sort((a, b) => a.y - b.y || a.x - b.x)
    for (let i = 0; i < boxes.length; i++) {
      for (let j = 0; j < boxes.length; j++) {
        if (i === j) continue
        const a = boxes[i]
        const b = boxes[j]
        if (!intersect(a, b)) continue
        const left = a.x <= b.x ? a : b
        const right = a.x <= b.x ? b : a
        const newW = right.x - GAP - left.x
        // Only trim when it stays usable; otherwise leave the slight overlap.
        if (newW >= MINW && newW < left.width) left.width = newW
      }
    }
  }
  return fields
}

// ── entry point ──────────────────────────────────────────────────────

// Selection-group markers — leases phrase "pick one" many ways and there is no
// standard, so match the common variants (with or without parens).
const SELECT_MARKER = /\(?\s*(?:check|select|choose|mark|pick|initial)\s+(?:one|only one|the one|all that apply|applicable)\b/i

// Detect "(check one)" selection groups and emit ONE radio_group per group
// instead of loose checkboxes, with nesting when a second group sits inside a
// fixed-term clause (Nic S556). Returns the radios plus the blank positions
// consumed, so the caller can drop the duplicate single-blank boxes.
function detectCheckOneRadios(pages: any[]): { radios: ProposedField[]; consumed: Array<{ page: number; x: number; y: number }> } {
  const radios: ProposedField[] = []
  const consumed: Array<{ page: number; x: number; y: number }> = []
  let keyc = 0

  for (const pg of pages) {
    const H = pg.height
    const items: TextItem[] = (pg.items as TextItem[]).filter((i) => i.text && i.text.length)
    // group into lines
    const lines: Array<{ y: number; items: TextItem[] }> = []
    for (const it of items.slice().sort((a, b) => b.y - a.y || a.x - b.x)) {
      let line = lines.find((l) => Math.abs(l.y - it.y) < 3)
      if (!line) { line = { y: it.y, items: [] }; lines.push(line) }
      line.items.push(it)
    }
    lines.forEach((l) => l.items.sort((a, b) => a.x - b.x))
    lines.sort((a, b) => b.y - a.y) // top → bottom

    const flipY = (y: number, h: number) => Math.round(H - y - (h || 10) - 2)
    let lastLeaseTypeKey: string | null = null

    for (let i = 0; i < lines.length; i++) {
      const text = lines[i].items.map((it) => it.text).join(' ').replace(/\s+/g, ' ')
      if (!SELECT_MARKER.test(text)) continue

      // Collect option lines below this marker: a line whose FIRST token is an
      // underscore blank. Stop at the next marker or after a gap.
      const opts: Array<{ label: string; full: string; x: number; y: number; h: number }> = []
      for (let j = i + 1; j < lines.length && j <= i + 8; j++) {
        const first = lines[j].items[0]
        const lineText = lines[j].items.map((it) => it.text).join(' ').replace(/\s+/g, ' ')
        if (SELECT_MARKER.test(lineText)) break
        // A checkbox option line STARTS with the blank ("___ Label"). A blank
        // mid-line (e.g. "and ending on ___") is a fill-in, not an option.
        if (!first || !/^\s*_{2,}/.test(first.text)) {
          if (opts.length > 0) break
          continue
        }
        // label = the option text after the leading blank, up to a sentence
        // break. The blank + label are usually one text item ("____ FIXED TERM.
        // The Tenant…"), so strip the leading underscores off the whole line.
        const after = lineText.replace(/^[\s_]*_{2,}[\s_]*/, '').trim()
        const label = (after.split(/[.,(]/)[0] || after).trim().slice(0, 40) || 'Option'
        // keep the FULL option text for keyword matching (the short label can
        // truncate the very words we key on, e.g. "…under the same terms")
        opts.push({ label, full: after.toLowerCase(), x: first.x, y: first.y, h: first.height })
        consumed.push({ page: pg.pageNumber, x: Math.round(first.x), y: flipY(first.y, first.height) })
      }
      if (opts.length === 0) continue

      // Generalize across arbitrary leases (no standardization): the OPTION
      // LABELS are extracted from the document, so any "select one" group with
      // 2+ printed choices becomes a radio with those exact choices. Keyword
      // mapping to a known lease column (lease_type / auto_renew_mode) is a
      // best-effort overlay; unknown groups still become radios (column left
      // for the landlord). The single common case where a lease prints only the
      // affirmative checkbox (Fixed term / auto-renew) is inferred to a binary.
      const labels = opts.map((o) => o.label)
      const joined = opts.map((o) => o.full).join(' ') // full text for keywords
      // Order matters: the "end of term" choice text also says "month-to-month"
      // (…continue on a month-to-month basis…), so match its verbs FIRST, then
      // fall back to lease_type on "fixed term".
      let leaseColumn: string | null = null
      if (/\bcontinue\b|\brenew(al|s|ed)?\b|must vacate|shall vacate|move[- ]?out|end of the (rental )?term/.test(joined)) leaseColumn = 'auto_renew_mode'
      else if (/fixed term|month[- ]to[- ]month/.test(joined)) leaseColumn = 'lease_type'

      let options: string
      let parentKey: string | null = null
      let parentOption: string | null = null
      if (labels.length >= 2) {
        options = labels.join(', ') // real choices printed on the doc
      } else if (leaseColumn === 'lease_type') {
        options = 'Fixed term, Month-to-month'
      } else if (leaseColumn === 'auto_renew_mode') {
        options = 'Continue month-to-month, Must vacate'
      } else {
        continue // a lone option with no known meaning isn't a radio — leave as-is
      }
      // an end-of-term choice sits inside the fixed-term clause → conditional
      if (leaseColumn === 'auto_renew_mode' && lastLeaseTypeKey) {
        parentKey = lastLeaseTypeKey
        parentOption = 'Fixed term'
      }

      const key = `radio_${keyc++}`
      if (leaseColumn === 'lease_type') lastLeaseTypeKey = key
      const anchor = opts[0]
      radios.push({
        page: pg.pageNumber,
        x: Math.round(anchor.x),
        y: flipY(anchor.y, anchor.h),
        // a radio marker is a dot on the checkbox blank — the choices are picked
        // in the signing panel, so the on-document box stays tiny (Nic S556).
        width: 14,
        height: 14,
        fieldType: 'radio_group',
        signerRole: 'landlord', // term selection is set at drafting
        leaseColumn,
        label: leaseColumn === 'lease_type' ? 'Lease type' : leaseColumn === 'auto_renew_mode' ? 'At end of term' : 'Select one',
        options,
        key,
        parentKey,
        parentOption,
      })
    }
  }
  return { radios, consumed }
}

export async function autoPlaceFields(
  pdfBuffer: Buffer,
  onProgress?: AutoPlaceProgress,
): Promise<AutoPlaceResult> {
  const extracted = await extractPositionedText(pdfBuffer)
  const { targets, pageMeta } = detectTargets(extracted.pages)

  // S622: the document's own page count is the progress denominator — it is the
  // number the landlord sees in the editor ("Page 4 of 8").
  const totalPages = extracted.pages.length
  const modelMap = await modelClassify(targets, totalPages, onProgress)
  // Settle the bar from here rather than inside the loop, so the paths that
  // return early (model disabled, nothing detected) still finish at 100% instead
  // of leaving the editor parked mid-count on a run that did complete.
  onProgress?.(totalPages, totalPages)
  const cls = new Map<number, Classification>()
  for (const t of targets) {
    cls.set(t.id, modelMap?.get(t.id) ?? heuristicClassify(t))
  }

  const fields = buildFields(targets, cls, pageMeta)

  // S556: replace loose "(check one)" checkboxes with proper (nested) radio
  // groups. Drop any placed box that sits on a blank a radio group consumed,
  // then append the radios.
  const { radios, consumed } = detectCheckOneRadios(extracted.pages)
  const near = (a: number, b: number) => Math.abs(a - b) <= 6
  // A radio group replaces the loose checkboxes for its lease column — drop any
  // checkbox the radios now cover (lease_type / auto_renew[_mode]), including
  // continued options that spilled onto the next page.
  const radioCols = new Set(radios.map((r) => r.leaseColumn).filter(Boolean))
  const covered = (col: string | null): boolean =>
    !!col && (radioCols.has(col) ||
      (radioCols.has('auto_renew_mode') && col === 'auto_renew') ||
      (radioCols.has('lease_type') && col === 'lease_type'))
  const deduped = fields.filter(
    (f) =>
      !consumed.some((c) => c.page === f.page && near(c.x, f.x) && near(c.y, f.y)) &&
      !(f.fieldType === 'checkbox' && covered(f.leaseColumn)),
  )
  const all = [...deduped, ...radios]

  // S622: ONE owner per money column.
  //
  // A move-in cost table ("First month's rent / Rent pre-payment / Proration /
  // Total due") is four different amounts, and all four came back tagged
  // rent_amount. At execution the lease builder collapses field values into one
  // dict keyed by column — `vals[col] = f.value`, last row wins, on a query with
  // no ORDER BY. So the tenant's MONTHLY RENT would have been set by whichever
  // of those four Postgres happened to return last. If that was "Total due",
  // the monthly rent becomes the entire move-in total.
  //
  // Only writable/fee_row columns are deduped: signature, initials and
  // date_signed legitimately repeat on every page and every signer.
  //
  // First occurrence in document order wins, which is the substantive clause
  // (the rent clause on page 2) rather than a summary table at the back. The
  // losers keep their box and stay landlord-filled — they still PRINT on the
  // lease, they just no longer claim to be the lease's rent.
  const ordered = [...all].sort((a, b) => (a.page - b.page) || (a.y - b.y) || (a.x - b.x))
  const claimed = new Set<string>()
  for (const f of ordered) {
    const col = f.leaseColumn
    if (!col) continue
    const cat = (LEASE_COLUMN_CATEGORY as Record<string, string>)[col]
    if (cat !== 'writable' && cat !== 'fee_row') continue
    if (claimed.has(col)) {
      f.leaseColumn = null   // display-only from here on
      continue
    }
    claimed.add(col)
  }

  return { pageCount: extracted.pageCount, fields: all, modelUsed: !!modelMap }
}


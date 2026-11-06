# GCP migration — what Ben needs, 10/28

Regenerated from the actual branches tonight, not from the older note. The
numbers in the S643 handoff ("18 files overlap") are stale: it is **30 files
now**, and the gap is widening every session.

## The one number that decides the plan

| | |
|---|---|
| Ben's branch forked from main | **6 September 2026** |
| main has moved since | **557 commits** |
| Ben's branch has | **11 commits** |
| Files both sides changed | **30** |

**So the merge direction is not a preference, it is forced.** Rebase (or
re-apply) Ben's 11 commits onto current main. Merging main *into* the branch
means resolving 557 commits' worth of drift inside a 50-file change, and
merging the branch into main as-is would silently revert the work on the files
below — which is exactly what happened once already (S643: a deploy shipped a
bundle that never had Ben's commit over the top of it).

## What his branch actually does

Eleven commits, all one idea: **files stop being local paths and go through a
storage driver**, so uploads can live in cloud storage instead of on the Mac.

- `GCP A1 (1/4)` — the storage seam: driver-backed files, keys not paths
- `(2/4a–f)` — expenses, documents, maintenance, inspections, walkthroughs,
  ID documents, tenant avatars, FlexPay proofs, unit photos, property site
  photos, business attachments, pending lease PDFs, lease-parser and
  auto-field jobs, each moved onto the driver
- `(3/4a–b)` — the four PDF generators and esign/pdfStamp write through it
- `(4/4)` — lease merges, boot mkdir, old libs retired, seed scripts
- Plus Phase A part 1: scheduler gate, graceful shutdown, portable config,
  hosted-LLM auth

Also on the branch and worth keeping: `.github/workflows/ci.yml`, `.nvmrc`,
`.env.example`.

## The 30 files both sides changed

`ours` / `ben` are commit counts on that file since the fork. A file where ours
is 30+ and his is 1 is a file his change must be re-applied *into*, never
merged over.

| file | ours | ben |
|---|---|---|
| `apps/api/src/routes/esign.ts` | 71 | 2 |
| `apps/api/src/routes/landlords.ts` | 64 | 1 |
| `apps/api/src/routes/admin.ts` | 39 | 1 |
| `apps/api/src/routes/background.ts` | 36 | 1 |
| `apps/api/src/routes/tenants.ts` | 33 | 1 |
| `apps/api/src/routes/properties.ts` | 32 | 1 |
| `apps/api/src/routes/esign.test.ts` | 21 | 1 |
| `apps/api/src/routes/leases.ts` | 17 | 1 |
| `apps/api/src/index.ts` | 15 | 2 |
| `apps/api/src/routes/documents.ts` | 6 | 1 |
| `apps/api/src/routes/expenses.ts` | 6 | 1 |
| `apps/api/src/jobs/leaseParser/resolveIntent.ts` | 4 | 1 |
| `apps/api/src/routes/maintenance.ts` | 4 | 1 |
| `apps/api/src/routes/publicPropertyBooking.ts` | 4 | 1 |
| `package-lock.json` | 4 | 1 |
| `apps/api/src/routes/inspections.ts` | 3 | 1 |
| `apps/api/src/services/pdfStamp.ts` | 3 | 1 |
| `apps/api/src/services/pdfStamp.test.ts` | 3 | 1 |
| `apps/api/src/services/subleaseDocuments.ts` | 3 | 1 |
| `apps/api/package.json` | 2 | 1 |
| `apps/api/src/routes/propertyBookingAdmin.ts` | 2 | 1 |
| `apps/api/src/services/agents/engine.ts` | 2 | 1 |
| `apps/api/src/services/autoFieldPlacement.ts` | 2 | 1 |
| `apps/api/src/db/index.ts` | 1 | 1 |
| `apps/api/src/services/addendumPdf.ts` | 1 | 2 |
| `apps/api/src/services/agents/config.ts` | 1 | 1 |
| `apps/api/src/services/inspectionReport.ts` | 1 | 2 |
| `apps/api/src/services/moneyAddonPdf.ts` | 1 | 1 |
| `.env.example` | 1 | 2 |
| `apps/api/src/jobs/leaseParser/runParserJob.ts` | 0 | 2 |

`runParserJob.ts` is the only one of the thirty that main has not touched —
his version can land as-is.

Regenerate this list any time:

```bash
cd ~/gam && BASE=$(git merge-base main origin/gcp-migration) && git diff --name-only $BASE origin/gcp-migration | sort > /tmp/ben.txt && { git diff --name-only $BASE main; git diff --name-only HEAD; } | sort -u > /tmp/ours.txt && comm -12 /tmp/ben.txt /tmp/ours.txt
```

## Two things that are Ben's and are not done

1. **Make the repo private.** `robotrooster/gam-platform` is still PUBLIC as of
   tonight. The dev password in 14 tracked files is the production DB password,
   and git history still holds 85 real residents' names — the 10/27 sweep took
   them out of the current tree, which does nothing for anyone who clones the
   history. Making it private is the only thing that closes either exposure.
2. **CI deploys and the deploy guard** — his `ci.yml` is on the branch and has
   never run against main.

## Things that must NOT come across in the migration

- **Agents stay on the Mac.** The GCP plan moved LLM work to DeepInfra, which
  overrides the no-third-party-AI rule. Nic's instruction is newer and stands:
  payments and API move, agents do not.
- The `listings` app (`apps/listings`) is complete and has never been deployed.
  It needs a domain, not a migration decision.

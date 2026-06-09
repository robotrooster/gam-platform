# Session 240 — closed

## Theme

pdfjs-dist 3 → 5 upgrade — the last open npm audit item. The
DEFERRED entry framed this as needing a full apps/api ESM migration
(CJS+tsx → full ESM) as a prerequisite. **Recon found the framing
was overscoped.** Only one file in apps/api blocks the upgrade
(`src/lib/pdfText.ts`, the only consumer of pdfjs's now-removed CJS
legacy/build/pdf.js entry). Surgical fix via dynamic `import()`
instead of structural refactor.

`npm audit` is now **0 vulnerabilities** (was 9 at S96, 6 at S237
start).

## Recon finding (the big shape change)

I expected the migration to need:
- Switch `apps/api/package.json` to `"type": "module"`
- Update `tsconfig.json` to `"module": "ES2022"` + `"moduleResolution": "node16"`
- Add `.js` extensions to every relative import (~117 files)
- Replace `require()` with `import` everywhere
- Update `migrate.ts` runner's dynamic `require(file.fullPath)` →
  dynamic `import()`
- Replace `__dirname` / `__filename` with `import.meta.url` paths
- Update all package.json scripts that invoke `node -r ts-node/register`
- Reinstall + reverify

Survey of actual `require()` / `__dirname` use in `apps/api/src/`:
- 117 .ts files total
- **6 files** with `require()` calls
- **1 file** with `__dirname` (migrate.ts)

Of the 6 `require()` files:
- `bankAccountCrypto.ts` — only mentions in DOC COMMENTS (no real require)
- `migrate.ts:117` — dynamic `require(file.fullPath)` for migrations
  (not relevant to pdfjs blocker)
- `routes/books.ts:673` — lazy `require('bcryptjs')` inside a handler
- `routes/landlords.ts:731,1920` — lazy `require('crypto')`
- `routes/tenants.ts:525,577,588` — lazy `require('crypto')` /
  `require('bcrypt')` / `require('jsonwebtoken')`

All 6 are CJS-compatible — `require()` of built-ins or CJS packages
still works fine in CJS+tsx. None of them blocked the pdfjs upgrade.
The only real blocker was `pdfText.ts` itself.

So the migration scope collapsed from "structural refactor across
117 files" to "surgical change in 1 file."

## Items shipped

### 1. pdfjs-dist 3.11.174 → 5.7.284

`apps/api/package.json` bump.

### 2. pdfText.ts — dynamic import + cached module promise

The CJS-incompatible bits in v5:
- `legacy/build/pdf.js` (CJS entry) was removed in v4 — replaced by
  `legacy/build/pdf.mjs` (ESM, Node-targeted)
- Main entry `build/pdf.mjs` is also ESM, but uses modern-browser
  APIs that crash under Node (verified empirically: smoke test
  threw `hashOriginal.toHex is not a function` on the main build,
  ran clean on the legacy build)
- pdfjs's own load-time warning explicitly says: *"Please use the
  `legacy` build in Node.js environments."*

**Pattern:**

```ts
let pdfjsModuleP: Promise<any> | null = null
function getPdfjs(): Promise<any> {
  if (!pdfjsModuleP) {
    pdfjsModuleP = import('pdfjs-dist/legacy/build/pdf.mjs')
  }
  return pdfjsModuleP
}

export async function extractPositionedText(...): Promise<...> {
  const pdfjsLib = await getPdfjs()
  const loadingTask = pdfjsLib.getDocument({ ... })
  // ...
}
```

The async cost is absorbed by the already-async `extractPositionedText`
function. The module is lazy-loaded on first call and cached for the
process lifetime — no per-PDF import overhead.

### 3. Standard-fonts path resolution

Pre-S240 used `require.resolve('pdfjs-dist/legacy/build/pdf.js')`
plus `'..', '..', '..', 'standard_fonts/'` (3 dirs up). In v5,
require.resolve('pdfjs-dist') returns `build/pdf.mjs` directly via
the package's `main` field (no `/legacy/build/` subpath needed) —
2 dirs up to package root. Fixed.

### 4. TypeScript shim for the legacy/build/pdf.mjs subpath

pdfjs-dist v5 declares types via the package's bare name only (its
`"types"` field points to `types/src/pdf.d.ts`); no exports map for
subpaths. TypeScript couldn't resolve types for
`'pdfjs-dist/legacy/build/pdf.mjs'`.

**Fix**: small declaration shim at `src/lib/pdfjs-shims.d.ts`:

```ts
declare module 'pdfjs-dist/legacy/build/pdf.mjs' {
  export * from 'pdfjs-dist'
}
```

Re-exports the bare-name typing under the subpath we actually
import. Runtime uses the legacy build; types come from the same
generic declaration since the public API is identical between the
two builds.

### 5. Verification

End-to-end smoke test against a real PDF (an uploaded ID document
from the apps/api/uploads/ tree):

```
Pages: 2
First page items count: 69
Sample item: {"text":"GOLD ASSET MANAGEMENT LLC","x":175.776,"y":698,"x2":436.224,"fontName":"g_d0_f2"}
```

Positional text extraction works: page count correct, items
extracted with x/y/x2/fontName. No load-time warnings on the legacy
build. No `toHex` crashes.

## Files touched (S240)

```
apps/api/package.json                  (~ pdfjs-dist 3 → 5)
apps/api/src/lib/pdfText.ts            (~ dynamic import getPdfjs(),
                                        ~ standard_fonts path
                                          resolution updated for v5
                                          package layout,
                                        ~ comment header rewritten)
apps/api/src/lib/pdfjs-shims.d.ts      (NEW — TS subpath shim)
package-lock.json                       (auto-regen)

DEFERRED.md                             (- npm audit section,
                                          + tombstone entry under Closed)
SESSION_240_HANDOFF.md                  (new)
```

No migrations. No code changes outside `pdfText.ts` and the new
shim file.

## Verification

- `cd apps/api && npx tsc --noEmit` → clean
- `cd apps/api && npm run schema:diff` → unchanged (only pre-launch
  Flex Suite phantoms remain)
- `npm audit` → **0 vulnerabilities** (was 1 pre-S240; was 9 at S96)
- Smoke: `extractPositionedText` returns correct page count + items
  on a real PDF, no warnings, no crashes

## Decisions made (S240)

| Question | Decision |
|---|---|
| Full apps/api ESM migration or surgical dynamic-import in pdfText.ts? | Surgical. Recon showed only pdfText.ts blocked the upgrade — none of the other 116 .ts files in apps/api needed changes. Adding `await import()` in one already-async function is much smaller surface than converting an entire CJS+tsx app. |
| Use the bare `'pdfjs-dist'` import or the explicit `'pdfjs-dist/legacy/build/pdf.mjs'` subpath? | Subpath (legacy build). The bare import resolves to `build/pdf.mjs` which uses modern-browser APIs not safely available under Node — empirically threw at runtime. The legacy build exists for exactly this case; pdfjs's own warning says to use it. |
| Add a TS shim for the subpath types or leave it loose-typed? | Shim. The comment header in pdfText.ts is the only place that needs the subpath; loose-typing it via `// @ts-ignore` would mask future type breakage. The shim re-exports the package's own typings — costs 4 lines for a permanent fix. |
| Cache the dynamic-import module promise or re-import per call? | Cache. Module-level `pdfjsModuleP: Promise<any> | null` resolved on first call. Avoids the per-PDF import overhead (which Node minimizes anyway via its own module cache, but the explicit pattern documents the lifecycle). |
| Test against real PDF or just trust the typecheck? | Real PDF. Type-clean code can still crash at runtime when an external module's API surface drifts. The smoke confirmed both load AND extraction work end-to-end. |
| Drop the DEFERRED npm audit section entirely? | Yes. With zero vulns, the section is empty. Closed-tombstone entry in the major-item list captures the audit-trail. |

## Carry-forward — S241+

DEFERRED post-S240:

**Open — pickable:**
- POS receipt printing (hardware adapter selection blocks)
- POS multi-terminal session sync (likely premature)
- /resolve smoke (testing)
- POS end-to-end smoke (testing)

Same shape as S237/S238/S239 — bench remains dry of pure code-work
items. Future sessions need product input or multi-session epic
greenlight.

**Multi-session epics:** Flex Suite (gated), Sublease (greenfield,
needs spec), F1 Marketing rebuild (needs direction).

## Revised count

S240 closed the last npm audit item.

| Bucket | Pre-S240 | Post-S240 |
|---|---|---|
| Pickable now | ~4 | ~4 (all blocked) |
| Nic-blocked | 5 | 5 |
| External-vendor-blocked | 1 | 1 |
| Multi-session epics | 3 | 3 |
| npm audit | 1 | **0** |
| Pre-launch flag-gated | 2 | 2 |

**Until v1 launch-ready:** ~8 sessions → ~7.

---

End of S240 handoff.

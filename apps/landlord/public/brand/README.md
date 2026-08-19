# Brand assets

## logo.png — the T-12 / statement letterhead logo (S603, Nic)

Drop a **logo.png** in this folder and it appears automatically at the top of the
printed T-12 statement (Reports → Custom & T-12 → Trailing 12 months). No code
change is needed — the statement header resolves `/brand/logo.png` at runtime and
falls back to the "GAM" wordmark whenever the file is absent.

Guidance:
- **Format:** PNG with a transparent background (SVG also works — change the
  `src` in `ReportsPage.tsx` → `T12Statement` if you switch).
- **Size:** the slot is 132×56 px on screen; supply roughly 2× that
  (~264×112) so it stays sharp when printed or saved to PDF.
- **Contrast:** it renders on white when printed, so avoid a white-on-transparent
  mark — it would vanish on paper.

The diagonal "Gold Asset Management" watermark behind the figures is drawn in CSS
and needs no asset.

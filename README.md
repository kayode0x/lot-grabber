# Lot Grabber

Chrome extension (MV3) for Copart lots: one folder per lot with the summary, photos and JSON side by side, a max-bid pre-screen, and an optional photo damage read from Claude.

## Install / upgrade
1. `chrome://extensions` → Developer mode → **Load unpacked** (or **Reload** on the existing card).
2. Click the gear in the popup (or the extension's Options) → **Choose folder**. Create or pick `Downloads/lots`; Chrome won't let extensions write to the Downloads folder itself.
3. Optional: paste a Claude API key for photo analysis. The model field is free text; change it if the default ID isn't on your account.

After a browser restart Chrome may ask you to re-approve folder access; the popup sends you to Settings → **Allow access** when that happens.

## Output
```
<your folder>/copart-<lot>-<year-make-model>/
  <lot>-00-summary.md   facts + bid math + photo analysis (if run)
  <lot>-01.jpg …        gallery order, largest size Copart has
  <lot>-lot.json        normalized fields, bids, analysis, raw Copart payload
```
Re-saving a lot overwrites in place and removes photos that dropped out of the gallery.

## Bid math (lib/calc.js, tune in Settings)
- **Exit:** Copart ERV minus 30% rebuilt-title haircut for salvage/rebuilt, minus 7.5% for clean titles; parts-only titles get no exit.
- **Repair:** photo analysis midpoint (flip, ×1.25) and high end (keep, ×1.1). Without analysis it falls back to Copart's hidden `rc` estimate × 0.35 (pre-screen; calibrate this against your real repair bills).
- **Flip max:** all-in leaves max($3,500, 15% of all-in) profit.
- **Keep max:** all-in capped at the exit value, so a forced sale breaks even.
- Fees (6% + $400), 7% tax, transport ($0.95/road mi, $300 min), title, holding.

The model only judges the photos (repair range, risk, confidence) and returns schema-constrained JSON via structured outputs (`output_config.format`, no forced tool call, which Opus/Sonnet 5.5 and Fable 5.1 reject). The dollars are computed in code so they are reproducible.

## Architecture
- `extract/copart.js` – injected; inline cache → API → DOM fallback.
- `offscreen.js` + `lib/jobs.js` – fetch photos, write via the File System Access handle, call the Claude API.
- `background.js` – routes jobs, badge, stores analysis per lot.
- Saving no longer uses `chrome.downloads`, whose relative paths were resolving against the previous download's folder and nesting lots inside lots.

## Limits
- VIN is masked unless logged in.
- Engine videos: only the still is saved and analyzed.
- Copart redesigns will break selectors; the extractor is one file.

// Shared by popup (ES module) and the Node test harness.

// Home base for the distance line. Straight-line miles x ROAD_FACTOR is a
// decent transport-quote proxy; swap in your own coords if you move yards.
export const HOME = { lat: 39.7684, lon: -86.1581, label: 'Indianapolis' };
const ROAD_FACTOR = 1.2;

export function roadMilesFromHome(lat, lon, home = HOME) {
  if (lat == null || lon == null) return null;
  const R = 3958.8;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(lat - home.lat);
  const dLon = rad(lon - home.lon);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(home.lat)) * Math.cos(rad(lat)) * Math.sin(dLon / 2) ** 2;
  const straight = 2 * R * Math.asin(Math.sqrt(a));
  return Math.round((straight * ROAD_FACTOR) / 10) * 10;
}

export const money = (n, cents = false) =>
  n == null
    ? null
    : '$' +
      Number(n).toLocaleString('en-US', {
        minimumFractionDigits: cents ? 2 : 0,
        maximumFractionDigits: cents ? 2 : 0,
      });

export const miles = (n, unit = 'mi') => (n == null ? null : `${Number(n).toLocaleString('en-US')} ${unit}`);

const tc = (s) => (s ? String(s).toLowerCase().replace(/\b([a-z])/g, (c) => c.toUpperCase()) : s);
const yesNo = (b) => (b === true ? 'yes' : b === false ? 'no' : null);

export function saleWhen(lot) {
  if (lot.saleDateText) return lot.saleDateText.replace(/^(\w{3})\./, '$1');
  if (!lot.saleDate) return null;
  try {
    return new Intl.DateTimeFormat('en-US', {
      weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit', timeZone: lot.saleTz || undefined, timeZoneName: 'short',
    }).format(new Date(lot.saleDate));
  } catch {
    return lot.saleDate;
  }
}

export function titleKind(lot) {
  const t = `${lot.titleGroup || ''} ${lot.titleDesc || ''}`.toUpperCase();
  if (/PARTS|JUNK|NON-?REPAIRABLE|DISMANTLE|CERT OF DESTRUCTION/.test(t)) return 'parts';
  if (/SALVAGE|REBUILDABLE/.test(t)) return 'salvage';
  if (/REBUILT|RECONSTRUCT/.test(t)) return 'rebuilt';
  if (/CLEAN|CERT OF TITLE|\bMV\b/.test(t) && !/SALVAGE/.test(t)) return 'clean';
  return 'other';
}

// "MN - MINNEAPOLIS NORTH" -> "Minneapolis North, MN"
export function yardName(yard) {
  if (!yard) return null;
  const m = String(yard).match(/^([A-Z]{2})\s*-\s*(.+)$/);
  return m ? `${tc(m[2])}, ${m[1]}` : tc(yard);
}

export function vehicleName(lot) {
  return [lot.year, lot.make, lot.model].filter(Boolean).join(' ') || lot.title || `Lot ${lot.lot}`;
}

// One level only: the user-chosen save folder is the parent.
export function folderName(lot) {
  const slug = vehicleName(lot)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `copart-${lot.lot}-${slug}`;
}

// Plain "Label: value" lines - reads cleanly whether pasted into a chat box
// or attached as a .md file. Lines with no data are dropped, not dashed.
export function summaryText(lot, imageCount, { bids, analysis, settings } = {}) {
  const dist = roadMilesFromHome(lot.lat, lot.lon);
  const where = [lot.locCity && lot.locState ? `${lot.locCity}, ${lot.locState} ${lot.zip || ''}`.trim() : null, lot.yard ? `(${yardName(lot.yard)} yard)` : null]
    .filter(Boolean)
    .join(' ');
  const run = [
    lot.condition ? tc(lot.condition) : null,
    lot.engineStarts != null ? `engine starts: ${yesNo(lot.engineStarts)}` : null,
    lot.transmissionEngages != null ? `transmission engages: ${yesNo(lot.transmissionEngages)}` : null,
  ].filter(Boolean);

  const lines = [
    [`${vehicleName(lot)}, Copart lot ${lot.lot}`],
    [lot.url],
    [''],
    ['VIN', lot.vin ? lot.vin + (lot.vinMasked ? ' (masked)' : '') : null],
    ['Title', [lot.titleState, tc(lot.titleDesc)].filter(Boolean).join(' ') + (lot.titleGroup ? ` (${tc(lot.titleGroup)})` : '') || null],
    ['Odometer', lot.odometer != null ? `${miles(lot.odometer, lot.odometerUnit)}${lot.odometerStatus ? ` (${tc(lot.odometerStatus)})` : ''}` : null],
    ['Primary damage', lot.primaryDamage],
    ['Secondary damage', lot.secondaryDamage],
    ['Condition', run.join('; ') || null],
    ['Keys', yesNo(lot.hasKeys)],
    ['Powertrain', [lot.engine, tc(lot.transmission), tc(lot.drive), tc(lot.fuel)].filter(Boolean).join(', ') || null],
    ['Body / color', [tc(lot.body), tc(lot.color)].filter(Boolean).join(', ') || null],
    ['Seller', lot.seller],
    ['Estimated retail value', money(lot.erv)],
    ['ACV (lotPlugAcv)', money(lot.acv)],
    ['Repair cost estimate (rc, not shown on page)', money(lot.repairCost)],
    ['Sale', [lot.saleType, saleWhen(lot)].filter(Boolean).join(', ') || null],
    ['Current bid', lot.currentBid != null ? `${money(lot.currentBid)} as of ${new Date(lot.grabbedAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}` : null],
    ['Buy it now', money(lot.buyNow)],
    ['Location', where ? where + (dist ? `, ~${dist.toLocaleString('en-US')} road mi from ${HOME.label}` : '') : null],
    ['Sublot', lot.sublot],
    ['Notes', lot.notes],
    ['Features', lot.features?.length ? lot.features.join(', ') : null],
    ['Photos', imageCount ? `${imageCount}, numbered in Copart gallery order` : null],
  ];

  const out = lines
    .filter((l) => l.length === 1 || (l[1] != null && l[1] !== ''))
    .map((l) => (l.length === 1 ? l[0] : `${l[0]}: ${l[1]}`));

  if (bids?.ok && settings) {
    const s = settings;
    out.push(
      '',
      `Bid math (${bids.repair.source === 'photos' ? 'photo analysis' : 'pre-screen, no photo analysis'})`,
      `Exit: ${money(bids.exit.value)} (${bids.exit.basis})`,
      `Repair basis: ${bids.repair.label}`,
      `Flip max bid: ${bids.flip ? money(bids.flip) : 'pass'} (repair x${s.flipContingency}, profit >= ${money(s.minProfit)} or ${Math.round(s.profitPct * 100)}% of all-in)`,
      `Keep max bid: ${bids.keep ? money(bids.keep) : 'pass'} (repair x${s.keepContingency}, all-in capped at exit)`,
      `Costs assumed: fees ${Math.round(s.feePct * 100)}% + ${money(s.feeFixed)}, tax ${Math.round(s.salesTax * 100)}%, transport ${money(bids.transport)}, title ${money(s.titleCost)}, holding ${money(s.holdingCost)} (flip only)`
    );
  }

  if (analysis) {
    const a = analysis;
    const list = (label, arr) => (arr?.length ? [`${label}:`, ...arr.map((x) => `- ${x}`)] : []);
    out.push(
      '',
      `Photo analysis (${a.model}, ${a.photosSent} photos)`,
      `Damage: ${a.damage_summary}`,
      `Repair: ${money(a.repair_low)}-${money(a.repair_high)}; structural risk ${a.structural_risk}; airbags ${a.airbags}`,
      `Flip confidence: ${a.flip_confidence}/100; keep confidence: ${a.keep_confidence}/100. ${a.confidence_drivers || ''}`.trim(),
      ...list('Damaged areas', a.damaged_areas?.map((d) => `${d.area} (${d.severity})${d.notes ? `: ${d.notes}` : ''}`)),
      ...list('Parts', a.parts?.map((p) => `${p.item}: ${money(p.low)}-${money(p.high)}`)),
      ...list('Red flags', a.red_flags),
      ...list('Not visible in photos', a.unseen_areas),
      ...list('Inspect before bidding', a.inspect_before_bidding)
    );
  }

  return out.join('\n').trim() + '\n';
}

import { titleKind, roadMilesFromHome } from './format.js';

const floor100 = (n) => Math.floor(n / 100) * 100;

export function exitValue(lot, s) {
  if (!lot.erv) return null;
  const kind = titleKind(lot);
  if (kind === 'parts') return { value: null, basis: 'parts-only title: no road-legal exit' };
  if (kind === 'salvage' || kind === 'rebuilt') {
    return { value: lot.erv * (1 - s.rebuiltHaircut), basis: `ERV less ${Math.round(s.rebuiltHaircut * 100)}% rebuilt-title haircut` };
  }
  return { value: lot.erv * (1 - s.cleanAuctionDiscount), basis: `ERV less ${+(s.cleanAuctionDiscount * 100).toFixed(1)}% auction-history discount` };
}

export function transportCost(lot, s) {
  const mi = roadMilesFromHome(lot.lat, lot.lon);
  return mi == null ? null : Math.max(s.transportMin, mi * s.transportPerMile);
}

// Repair basis: photo analysis when available, else Copart's rc x rcFactor.
export function repairBasis(lot, analysis, s) {
  if (analysis?.repair_low != null && analysis?.repair_high != null) {
    return {
      source: 'photos',
      flip: ((analysis.repair_low + analysis.repair_high) / 2) * s.flipContingency,
      keep: analysis.repair_high * s.keepContingency,
      label: `photo analysis $${analysis.repair_low.toLocaleString()}–$${analysis.repair_high.toLocaleString()}`,
    };
  }
  if (lot.repairCost) {
    const base = lot.repairCost * s.rcFactor;
    return {
      source: 'prescreen',
      flip: base * s.flipContingency,
      keep: base * s.keepContingency,
      label: `pre-screen: Copart repair est. × ${s.rcFactor} = $${Math.round(base).toLocaleString()}`,
    };
  }
  return null;
}

// Hammer h solves: h + fees(h) + tax(h) + fixed costs <= budget,
// with fees(h) = feePct*h + feeFixed and tax(h) = salesTax*h.
function solveHammer(budget, s) {
  return (budget - s.feeFixed) / (1 + s.feePct + s.salesTax);
}

export function computeBids(lot, analysis, s) {
  const exit = exitValue(lot, s);
  const repair = repairBasis(lot, analysis, s);
  const transport = transportCost(lot, s) ?? s.transportMin;
  const missing = [];
  if (!exit?.value) missing.push(exit?.basis || 'no ERV on the lot');
  if (!repair) missing.push('no repair basis (no Copart estimate; run photo analysis)');
  if (missing.length) return { ok: false, missing, exit, repair, transport };

  const X = exit.value;

  // Flip: all-in must leave max(minProfit, profitPct x all-in).
  const allInFlip = Math.min(X - s.minProfit, X / (1 + s.profitPct));
  const flipBudget = allInFlip - repair.flip - transport - s.titleCost - s.holdingCost;
  const flip = solveHammer(flipBudget, s);

  // Keep: all-in capped at rebuilt/clean resale, so a forced sale exits flat.
  const keepBudget = X - repair.keep - transport - s.titleCost;
  const keep = solveHammer(keepBudget, s);

  const at = (h) => ({ fees: s.feePct * h + s.feeFixed, tax: s.salesTax * h });
  return {
    ok: true,
    exit,
    repair,
    transport,
    flip: flip > 0 ? floor100(flip) : 0,
    keep: keep > 0 ? floor100(keep) : 0,
    flipCosts: at(Math.max(flip, 0)),
    keepCosts: at(Math.max(keep, 0)),
    targetProfit: X - allInFlip,
  };
}

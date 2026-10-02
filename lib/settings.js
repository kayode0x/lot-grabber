// Defaults mirror the max-bid formula: exit - repair x contingency - fees - tax
// - transport - title - holding - profit (>= min $ or % of all-in, whichever is higher).
// Calibrate after a few real buys, especially rcFactor and the fee line.
export const DEFAULTS = {
  // Claude
  apiKey: '',
  model: 'claude-sonnet-5-5',

  // Exit value
  rebuiltHaircut: 0.30,        // salvage/rebuilt resale vs clean ERV
  cleanAuctionDiscount: 0.075, // clean-title auction cars: photos stay online

  // Repair
  rcFactor: 0.35,              // pre-screen: your cost as a share of Copart's (retail) repair estimate
  flipContingency: 1.25,
  keepContingency: 1.10,

  // Costs
  feePct: 0.06,                // auction + broker fees, % of hammer...
  feeFixed: 400,               // ...plus fixed (gate, internet bid, env)
  salesTax: 0.07,              // Indiana, on purchase price
  transportPerMile: 0.95,
  transportMin: 300,
  titleCost: 300,              // rebuilt inspection + title/registration
  holdingCost: 600,            // detail, listing, plates, carrying

  // Flip profit target
  minProfit: 3500,
  profitPct: 0.15,
};

export async function loadSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULTS, ...(settings || {}) };
}

export async function saveSettings(patch) {
  const current = await loadSettings();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

import { DEFAULTS, loadSettings, saveSettings } from './lib/settings.js';
import { getRoot, setRoot, rootStatus } from './lib/fsroot.js';

const $ = (id) => document.getElementById(id);

// [key, label, unit] - pct fields are stored as fractions, shown as percents.
const FIELDS = [
  ['rebuiltHaircut', 'Rebuilt-title haircut', 'pct'],
  ['cleanAuctionDiscount', 'Clean-title auction discount', 'pct'],
  ['rcFactor', 'Your cost vs Copart repair est. (pre-screen)', 'x'],
  ['flipContingency', 'Repair contingency, flip', 'x'],
  ['keepContingency', 'Repair contingency, keep', 'x'],
  ['feePct', 'Auction fees, % of hammer', 'pct'],
  ['feeFixed', 'Auction fees, fixed', 'usd'],
  ['salesTax', 'Sales tax', 'pct'],
  ['transportPerMile', 'Transport per road mile', 'usd'],
  ['transportMin', 'Transport minimum', 'usd'],
  ['titleCost', 'Rebuilt inspection + title', 'usd'],
  ['holdingCost', 'Holding, detail, listing', 'usd'],
  ['minProfit', 'Minimum flip profit', 'usd'],
  ['profitPct', 'Flip profit, % of all-in', 'pct'],
];

const toView = (v, unit) => (unit === 'pct' ? +(v * 100).toFixed(2) : v);
const fromView = (v, unit) => (unit === 'pct' ? Number(v) / 100 : Number(v));

function flash(id, text) {
  $(id).textContent = text;
  clearTimeout(flash[id]);
  flash[id] = setTimeout(() => ($(id).textContent = ''), 2000);
}

async function renderFolder() {
  const { state, root } = await rootStatus();
  $('folder-name').textContent = root ? root.name : 'Not set';
  const chip = $('folder-state');
  chip.hidden = !root;
  chip.className = `chip ${state === 'granted' ? 'clean' : 'salvage'}`;
  chip.textContent = state === 'granted' ? 'Access granted' : 'Needs approval';
  $('grant').hidden = !root || state === 'granted';
  $('pick').textContent = root ? 'Change folder' : 'Choose folder';
}

$('pick').addEventListener('click', async () => {
  try {
    const handle = await window.showDirectoryPicker({ id: 'lot-grabber', mode: 'readwrite', startIn: 'downloads' });
    await setRoot(handle);
    await renderFolder();
    flash('folder-status', `Saving lots to ${handle.name}.`);
  } catch (e) {
    if (e.name !== 'AbortError') $('folder-status').textContent = `Couldn't use that folder: ${e.message}`;
  }
});

$('grant').addEventListener('click', async () => {
  const root = await getRoot();
  const state = await root.requestPermission({ mode: 'readwrite' });
  await renderFolder();
  if (state !== 'granted') $('folder-status').textContent = 'Access was not granted. Choose the folder again.';
});

async function renderSettings() {
  const s = await loadSettings();
  $('apiKey').value = s.apiKey;
  $('model').value = s.model;
  const grid = $('assumptions');
  grid.innerHTML = '';
  for (const [key, label, unit] of FIELDS) {
    const wrap = document.createElement('label');
    wrap.className = 'field';
    const suffix = unit === 'pct' ? ' (%)' : unit === 'usd' ? ' ($)' : ' (×)';
    wrap.innerHTML = `<span>${label}${suffix}</span>`;
    const input = document.createElement('input');
    input.type = 'number';
    input.step = 'any';
    input.value = toView(s[key], unit);
    input.addEventListener('change', async () => {
      if (input.value === '' || Number.isNaN(Number(input.value))) return;
      await saveSettings({ [key]: fromView(input.value, unit) });
      flash('save-status', 'Saved.');
    });
    wrap.append(input);
    grid.append(wrap);
  }
}

for (const id of ['apiKey', 'model']) {
  $(id).addEventListener('change', async () => {
    await saveSettings({ [id]: $(id).value.trim() });
    flash('save-status', 'Saved.');
  });
}

$('reset').addEventListener('click', async () => {
  const patch = Object.fromEntries(FIELDS.map(([k]) => [k, DEFAULTS[k]]));
  await saveSettings(patch);
  await renderSettings();
  flash('save-status', 'Bid math reset to defaults.');
});

renderFolder();
renderSettings();
if (location.hash === '#folder') $('folder').scrollIntoView();

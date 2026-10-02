import { summaryText, folderName, vehicleName, yardName, titleKind, money, miles, saleWhen, roadMilesFromHome, HOME } from './lib/format.js';
import { computeBids } from './lib/calc.js';
import { loadSettings } from './lib/settings.js';
import { rootStatus } from './lib/fsroot.js';

const $ = (id) => document.getElementById(id);
const LOT_URL = /^https:\/\/(www\.)?copart\.com\/lot\/\d+/i;

let tab = null;
let grabbed = null; // { lot, images, sources, raw }
let settings = null;
let analysis = null;
let bids = null;
const pending = new Map(); // job id -> kind

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const tc = (s) => (s ? String(s).toLowerCase().replace(/\b([a-z])/g, (c) => c.toUpperCase()) : s);

function show(state) {
  for (const s of ['empty', 'loading', 'error', 'lot']) $(`state-${s}`).hidden = s !== state;
}

function setStatus(html, isError = false) {
  const el = $('status');
  el.classList.toggle('error', isError);
  el.innerHTML = html;
}

const openSettings = (hash = '') => chrome.tabs.create({ url: chrome.runtime.getURL(`settings.html${hash}`) });

async function extractFromTab() {
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['extract/copart.js'] });
  const [inj] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: async () => {
      try {
        return { ok: true, value: await globalThis.__lotGrabber.extract() };
      } catch (e) {
        return { ok: false, error: String(e?.message || e) };
      }
    },
  });
  if (!inj?.result) throw new Error('The page did not respond. Reload the tab and try again.');
  if (!inj.result.ok) throw new Error(inj.result.error);
  return inj.result.value;
}

// ---- render ------------------------------------------------------------------

function renderHeader(lot) {
  $('v-name').textContent = vehicleName(lot);
  const lotLine = $('v-lotline');
  lotLine.innerHTML = '';
  const a = document.createElement('a');
  a.href = lot.url;
  a.target = '_blank';
  a.textContent = `Lot ${lot.lot}`;
  lotLine.append(a, document.createTextNode(lot.yard ? `, ${yardName(lot.yard)}` : ''));

  const chips = $('v-chips');
  chips.innerHTML = '';
  const addChip = (text, cls = '') => {
    if (!text) return;
    const c = document.createElement('span');
    c.className = `chip ${cls}`;
    c.textContent = text;
    chips.append(c);
  };
  addChip([lot.titleState, tc(lot.titleGroup || lot.titleDesc)].filter(Boolean).join(' '), titleKind(lot));
  addChip(lot.highlights?.[0] || tc(lot.condition));
  if (lot.hasKeys === false) addChip('No keys', 'parts');
  if (lot.saleType) addChip(lot.saleType);
}

function renderSpread(lot) {
  if (!lot.erv) return;
  const bid = lot.currentBid || 0;
  const rep = lot.repairCost || 0;
  const pct = (n) => Math.min(100, (n / lot.erv) * 100);
  $('seg-bid').style.width = bid ? `max(3px, ${pct(bid)}%)` : '0';
  $('seg-repair').style.width = `${Math.max(0, Math.min(100 - pct(bid), pct(rep)))}%`;
  const parts = [`Bid <b>${esc(money(bid))}</b>`];
  if (rep) parts.push(`Copart repair est. <b>${esc(money(rep))}</b>`);
  $('v-spread-caption').innerHTML = `${parts.join(' + ')} = <b>${Math.round(pct(bid + rep))}%</b> of ERV ${esc(money(lot.erv))}`;
  $('v-spread-bar').setAttribute('aria-label', $('v-spread-caption').textContent);
  $('v-spread').hidden = false;
}

function renderBids() {
  const lot = grabbed.lot;
  bids = computeBids(lot, analysis, settings);
  const setBid = (id, v) => {
    const el = $(id);
    el.classList.toggle('pass', bids.ok && !v);
    el.textContent = !bids.ok ? '–' : v ? money(v) : 'Pass';
  };
  setBid('bid-flip', bids.flip);
  setBid('bid-keep', bids.keep);

  $('conf-flip').innerHTML = analysis ? `confidence <b>${analysis.flip_confidence}</b>/100` : '';
  $('conf-keep').innerHTML = analysis ? `confidence <b>${analysis.keep_confidence}</b>/100` : '';

  const note = $('bid-vs-current');
  note.className = 'bid-note';
  if (!bids.ok) {
    note.textContent = `Can't price this yet: ${bids.missing.join('; ')}.`;
  } else if (lot.currentBid != null) {
    const over = [bids.flip && lot.currentBid > bids.flip ? 'flip' : null, bids.keep && lot.currentBid > bids.keep ? 'keep' : null].filter(Boolean);
    if (over.length === 2 || (!bids.flip && !bids.keep)) {
      note.classList.add('over');
      note.textContent = `Current bid ${money(lot.currentBid)} is already past both ceilings.`;
    } else if (over.length === 1) {
      note.classList.add('over');
      note.textContent = `Current bid ${money(lot.currentBid)} is past the ${over[0]} ceiling.`;
    } else {
      note.textContent = `Current bid ${money(lot.currentBid)}.`;
    }
  }

  $('bid-basis').textContent = bids.ok
    ? `Exit ${money(bids.exit.value)} (${bids.exit.basis}). Repair from ${bids.repair.label}${analysis ? '' : '; confidence needs photo analysis'}.`
    : '';
  $('btn-analyze').textContent = analysis ? 'Re-analyze photos' : `Analyze ${grabbed.images.length} photos with Claude`;
  $('btn-analyze').disabled = !grabbed.images.length;
}

function renderAnalysis() {
  $('v-analysis').hidden = !analysis;
  if (!analysis) return;
  const a = analysis;
  $('an-summary').textContent = a.damage_summary;
  $('an-line').textContent = `Repair ${money(a.repair_low)}–${money(a.repair_high)}, structural risk ${a.structural_risk}, airbags ${a.airbags}. ${a.photosSent} photos, ${a.model}.`;
  const ul = $('an-flags');
  ul.innerHTML = '';
  for (const f of (a.red_flags || []).slice(0, 4)) {
    const li = document.createElement('li');
    li.textContent = f;
    ul.append(li);
  }
}

function renderFacts(lot) {
  const dist = roadMilesFromHome(lot.lat, lot.lon);
  const facts = [
    ['Odometer', lot.odometer != null ? `${miles(lot.odometer, lot.odometerUnit)}${lot.odometerStatus ? ` ${tc(lot.odometerStatus).toLowerCase()}` : ''}` : null],
    ['Damage', [lot.primaryDamage, lot.secondaryDamage].filter(Boolean).join(', ') || null],
    ['Runs', [lot.engineStarts != null ? `engine ${lot.engineStarts ? 'starts' : 'no-start'}` : null, lot.transmissionEngages != null ? `trans ${lot.transmissionEngages ? 'engages' : 'no'}` : null].filter(Boolean).join(', ') || null],
    ['Powertrain', [lot.engine, tc(lot.drive)].filter(Boolean).join(', ') || null],
    ['VIN', lot.vin],
    ['ACV', money(lot.acv)],
    ['Buy it now', money(lot.buyNow)],
    ['Sale', saleWhen(lot)],
    ['Distance', dist ? `~${dist.toLocaleString('en-US')} road mi to ${HOME.label}` : null],
  ];
  const dl = $('v-facts');
  dl.innerHTML = '';
  for (const [k, v] of facts) {
    if (!v) continue;
    const dt = document.createElement('dt');
    const dd = document.createElement('dd');
    dt.textContent = k;
    dd.textContent = v;
    dl.append(dt, dd);
  }
}

function renderThumbs(images) {
  const thumbs = $('v-thumbs');
  thumbs.innerHTML = '';
  for (const img of images) {
    const el = document.createElement('img');
    el.src = img.thumb;
    el.alt = '';
    el.loading = 'lazy';
    el.onerror = () => el.remove();
    thumbs.append(el);
  }
  $('btn-download').textContent = images.length ? `Save ${images.length} photos and summary` : 'Save summary (no photos found)';
}

function render() {
  const { lot, images } = grabbed;
  renderHeader(lot);
  renderSpread(lot);
  renderBids();
  renderAnalysis();
  renderFacts(lot);
  renderThumbs(images);
  show('lot');
}

// ---- data out ------------------------------------------------------------------

const fullSummary = () => summaryText(grabbed.lot, grabbed.images.length, { bids, analysis, settings });

function buildJson() {
  const { rowsFromPage, ...lot } = grabbed.lot;
  return { lot, pageRows: rowsFromPage, bids, analysis, sources: grabbed.sources, raw: grabbed.raw };
}

async function copy(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    setStatus(`${label} copied.`);
  } catch (e) {
    setStatus(`Copy failed: ${esc(e.message || e)}`, true);
  }
}

async function startJob(kind, payload) {
  const id = `${kind}-${grabbed.lot.lot}-${Date.now()}`;
  pending.set(id, kind);
  const res = await chrome.runtime.sendMessage({ type: 'job', job: { id, kind, lotNo: grabbed.lot.lot, ...payload } });
  if (!res?.accepted) {
    pending.delete(id);
    throw new Error(res?.error || 'Background worker did not accept the job.');
  }
  return id;
}

async function onSave() {
  const { state, root } = await rootStatus();
  if (state !== 'granted') {
    openSettings('#folder');
    return setStatus(root ? 'Approve folder access in Settings (opened in a new tab), then save again.' : 'Choose a save folder in Settings (opened in a new tab), then save again.', true);
  }
  $('btn-download').disabled = true;
  const quality = document.querySelector('input[name="quality"]:checked').value;
  chrome.storage.local.set({ quality });
  setStatus('Saving…');
  try {
    await startJob('save', {
      folder: folderName(grabbed.lot),
      images: grabbed.images,
      quality,
      summary: fullSummary(),
      json: buildJson(),
    });
  } catch (e) {
    $('btn-download').disabled = false;
    setStatus(esc(e.message), true);
  }
}

async function onAnalyze() {
  if (!settings.apiKey) {
    openSettings();
    return setStatus('Add your Claude API key in Settings (opened in a new tab).', true);
  }
  $('btn-analyze').disabled = true;
  setStatus(`Preparing ${grabbed.images.length} photos…`);
  try {
    await startJob('analyze', {
      images: grabbed.images,
      apiKey: settings.apiKey,
      model: settings.model,
      summary: summaryText(grabbed.lot, grabbed.images.length), // facts only, no prior bids
    });
  } catch (e) {
    $('btn-analyze').disabled = false;
    setStatus(esc(e.message), true);
  }
}

function onJobDone(msg) {
  const kind = pending.get(msg.id);
  if (!kind) return;
  pending.delete(msg.id);
  if (kind === 'save') {
    $('btn-download').disabled = false;
    if (!msg.ok) return setStatus(`Save failed: ${esc(msg.error)}`, true);
    const r = msg.result;
    const sizes = Object.entries(r.sizes || {})
      .map(([k, n]) => `${n} ${k === 'hrs' ? 'high-res' : k === 'ful' ? 'standard' : 'thumbnail'}`)
      .join(', ');
    const failed = r.failed?.length ? ` ${r.failed.length} photo${r.failed.length > 1 ? 's' : ''} failed (${esc(r.failed[0].error)}).` : '';
    setStatus(`Saved to ${esc(r.path)}: summary, JSON, ${esc(sizes || 'no photos')}.${failed}`, !!r.failed?.length);
  } else if (kind === 'analyze') {
    $('btn-analyze').disabled = false;
    if (!msg.ok) return setStatus(`Analysis failed: ${esc(msg.error)}`, true);
    analysis = msg.result;
    renderBids();
    renderAnalysis();
    const u = analysis.usage;
    setStatus(`Analysis done${u ? ` (${u.input_tokens.toLocaleString()} in / ${u.output_tokens.toLocaleString()} out tokens)` : ''}. Save again to include it in the summary file.`);
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target === 'offscreen') return;
  if (msg?.type === 'job-progress' && pending.has(msg.id)) {
    if (msg.kind === 'save') setStatus(`Saving photo ${msg.done} of ${msg.total}…`);
    else if (msg.phase === 'photos') setStatus(`Preparing photo ${msg.done} of ${msg.total}…`);
    else setStatus(`Claude is reviewing ${msg.total} photos. You can close this; the result is kept for this lot.`);
  }
  if (msg?.type === 'job-done') onJobDone(msg);
});

// Analysis that finishes after the popup was closed and reopened.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !grabbed) return;
  const ch = changes[`analysis:${grabbed.lot.lot}`];
  if (ch?.newValue && !pending.size) {
    analysis = ch.newValue;
    renderBids();
    renderAnalysis();
  }
  if (changes.settings) {
    settings = { ...settings, ...changes.settings.newValue };
    renderBids();
  }
});

async function load() {
  show('loading');
  try {
    grabbed = await extractFromTab();
    const key = `analysis:${grabbed.lot.lot}`;
    analysis = (await chrome.storage.local.get(key))[key] || null;
    render();
  } catch (e) {
    $('error-msg').textContent = e.message || String(e);
    show('error');
  }
}

async function init() {
  settings = await loadSettings();
  const { quality = 'hrs' } = await chrome.storage.local.get('quality');
  const radio = document.querySelector(`input[name="quality"][value="${quality}"]`);
  if (radio) radio.checked = true;

  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url || !LOT_URL.test(tab.url)) return show('empty');
  await load();
}

$('retry').addEventListener('click', load);
$('open-settings').addEventListener('click', () => openSettings());
$('btn-download').addEventListener('click', onSave);
$('btn-analyze').addEventListener('click', onAnalyze);
$('btn-copy').addEventListener('click', () => copy(fullSummary(), 'Summary'));
$('btn-json').addEventListener('click', () => copy(JSON.stringify(buildJson(), null, 2), 'JSON'));

init();

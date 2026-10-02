// Service worker: routes jobs to the offscreen document, keeps the badge
// current, and persists analysis results (offscreen pages can't use storage).

const OFFSCREEN = 'offscreen.html';
let creating = null;

async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (existing.length) return;
  if (!creating) {
    const ready = new Promise((resolve) => {
      const onMsg = (m) => {
        if (m?.type === 'offscreen-ready') {
          chrome.runtime.onMessage.removeListener(onMsg);
          resolve();
        }
      };
      chrome.runtime.onMessage.addListener(onMsg);
    });
    creating = chrome.offscreen
      .createDocument({
        url: OFFSCREEN,
        reasons: ['BLOBS'],
        justification: 'Fetch lot photos, write them to the folder the user chose, and resize them for analysis.',
      })
      .then(() => ready)
      .finally(() => (creating = null));
  }
  await creating;
}

function badge(text, color = '#1F3A5F') {
  chrome.action.setBadgeBackgroundColor({ color }).catch(() => {});
  chrome.action.setBadgeText({ text }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'job') {
    ensureOffscreen()
      .then(() => chrome.runtime.sendMessage({ target: 'offscreen', type: 'run-job', job: msg.job }))
      .then(() => sendResponse({ accepted: true }))
      .catch((e) => sendResponse({ accepted: false, error: String(e?.message || e) }));
    return true;
  }
  if (msg?.type === 'job-progress') {
    badge(msg.phase === 'model' ? '…' : `${msg.done}`);
  }
  if (msg?.type === 'job-done') {
    badge(msg.ok ? '✓' : '!', msg.ok ? '#1F3A5F' : '#9B1C1C');
    setTimeout(() => badge(''), 6000);
    if (msg.kind === 'analyze' && msg.ok) chrome.storage.local.set({ [`analysis:${msg.lotNo}`]: msg.result });
    chrome.storage.session.set({ [`last:${msg.kind}:${msg.lotNo}`]: msg }).catch(() => {});
  }
});

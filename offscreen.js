// Hidden worker page. Offscreen documents only get chrome.runtime, so all
// results go back as broadcast messages; the service worker persists them.
import { saveLot, analyzeLot } from './lib/jobs.js';
import { getRoot } from './lib/fsroot.js';

const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => {});

async function run(job) {
  const progress = (done, total, phase) => send({ type: 'job-progress', id: job.id, kind: job.kind, lotNo: job.lotNo, done, total, phase });
  try {
    let result;
    if (job.kind === 'save') {
      const root = await getRoot();
      if (!root) throw new Error('No save folder chosen. Open Settings and choose one.');
      if ((await root.queryPermission({ mode: 'readwrite' })) !== 'granted') {
        throw new Error('Folder access needs re-approval. Open Settings and click Allow access.');
      }
      result = await saveLot(job, { root, fetchImpl: fetch.bind(globalThis), onProgress: progress });
    } else if (job.kind === 'analyze') {
      result = await analyzeLot(job, { fetchImpl: fetch.bind(globalThis), onProgress: progress });
    } else {
      throw new Error(`Unknown job ${job.kind}`);
    }
    send({ type: 'job-done', id: job.id, kind: job.kind, lotNo: job.lotNo, ok: true, result });
  } catch (e) {
    send({ type: 'job-done', id: job.id, kind: job.kind, lotNo: job.lotNo, ok: false, error: String(e?.message || e) });
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target === 'offscreen' && msg.type === 'run-job') run(msg.job);
});
send({ type: 'offscreen-ready' });

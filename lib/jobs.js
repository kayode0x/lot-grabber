// Pure job logic, runs in the offscreen document (a hidden extension page).
// Dependencies are injected so the same code runs under test with OPFS + a fake fetch.

const SUFFIX_ORDER = { hrs: ['_hrs', '_ful', '_thb'], ful: ['_ful', '_hrs', '_thb'] };
const pad = (n) => String(n).padStart(2, '0');

export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx], idx);
      }
    })
  );
  return out;
}

// Pick the largest size Copart actually has for this photo.
export async function resolveImage(img, quality, fetchImpl) {
  const suffixes = img.video ? [...SUFFIX_ORDER[quality], '_vthb'] : SUFFIX_ORDER[quality];
  let fallback = null;
  for (const sfx of suffixes) {
    for (const prefix of img.prefixes) {
      const url = `${prefix}${img.id}${sfx}.jpg`;
      try {
        const r = await fetchImpl(url, { method: 'HEAD', cache: 'no-store' });
        if (r.ok && /^image\//.test(r.headers.get('content-type') || 'image/')) return { url, size: sfx.replace(/^_v?/, '') };
        if ((r.status === 405 || r.status === 501) && !fallback) fallback = { url, size: sfx.replace(/^_v?/, '') };
      } catch {
        if (!fallback) fallback = { url, size: sfx.replace(/^_v?/, '') };
      }
    }
  }
  return fallback || { url: img.thumb, size: 'thb' };
}

export const photoName = (lotNo, idx, img) => `${lotNo}-${pad(idx + 1)}${img.video ? '-video-still' : ''}.jpg`;

async function writeFile(dir, name, data) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable(); // truncates: re-grabs overwrite in place
  await w.write(data);
  await w.close();
}

// Every file goes through one directory handle: root/<folder>/<file>. No relative
// path resolution by the browser, so nothing can nest or scatter.
export async function saveLot(job, { root, fetchImpl, onProgress = () => {} }) {
  const { folder, lotNo, images, quality, summary, json } = job;
  const dir = await root.getDirectoryHandle(folder, { create: true });

  await writeFile(dir, `${lotNo}-00-summary.md`, new Blob([summary], { type: 'text/markdown' }));

  const resolved = await mapLimit(images, 4, (img) => resolveImage(img, quality, fetchImpl));
  let done = 0;
  const results = await mapLimit(resolved, 3, async (r, idx) => {
    const name = photoName(lotNo, idx, images[idx]);
    try {
      const res = await fetchImpl(r.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await writeFile(dir, name, await res.blob());
      return { name, url: r.url, size: r.size, ok: true };
    } catch (e) {
      return { name, url: r.url, size: r.size, ok: false, error: String(e?.message || e) };
    } finally {
      onProgress(++done, images.length);
    }
  });

  // Drop photos from an earlier grab of this lot that are no longer in the gallery.
  const keep = new Set(results.map((r) => r.name));
  const stale = new RegExp(`^${lotNo}-\\d{2}(-video-still)?\\.jpg$`);
  for await (const [name] of dir.entries()) {
    if (stale.test(name) && !keep.has(name)) await dir.removeEntry(name);
  }

  const manifest = { ...json, images: results.map((r, i) => ({ n: i + 1, id: images[i].id, video: images[i].video, ...r })) };
  await writeFile(dir, `${lotNo}-lot.json`, new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' }));

  const sizes = results.filter((r) => r.ok).reduce((a, r) => ((a[r.size] = (a[r.size] || 0) + 1), a), {});
  const failed = results.filter((r) => !r.ok);
  return { path: `${root.name}/${folder}`, written: results.length - failed.length + 2, sizes, failed };
}

// ---------------------------------------------------------------------------
// Photo analysis

// Structured outputs (output_config.format). Newer models (Opus/Sonnet 5.5,
// Fable 5.1) reject forced tool_choice, so the assessment comes back as a
// schema-constrained JSON text block instead of a forced tool call.
const obj = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const str = (description) => (description ? { type: 'string', description } : { type: 'string' });
const int = (description) => ({ type: 'integer', description });
const strs = { type: 'array', items: { type: 'string' } };

export const ASSESS_SCHEMA = obj({
  damage_summary: str('2-4 sentences: what hit the car, where, how hard.'),
  damaged_areas: { type: 'array', items: obj({ area: str(), severity: { type: 'string', enum: ['cosmetic', 'moderate', 'structural'] }, notes: str() }) },
  airbags: { type: 'string', enum: ['intact', 'deployed', 'unknown'] },
  structural_risk: { type: 'string', enum: ['low', 'medium', 'high'] },
  repair_low: int("USD, buyer's cost, minimal hidden damage."),
  repair_high: int("USD, buyer's cost, the hidden damage this impact usually carries."),
  parts: { type: 'array', items: obj({ item: str(), low: int('USD'), high: int('USD') }) },
  unseen_areas: strs,
  red_flags: strs,
  inspect_before_bidding: strs,
  flip_confidence: int('0 to 100.'),
  keep_confidence: int('0 to 100.'),
  confidence_drivers: str('One or two sentences on what moves the confidence numbers.'),
});

export const SYSTEM_PROMPT = `You assess insurance-auction lots (Copart) for a small-volume car flipper in Indianapolis. Judge the damage from the photos and the lot data, then respond with the JSON assessment.

Buyer profile, which sets the repair cost level:
- Buys used OEM parts (eBay, salvage yards) and pays independent body-shop labor (two cheap, reliable shops).
- Does his own electrical diagnosis, module coding, and retrofits, so electrical faults cost him parts, not labor.
- Focus platforms: Mercedes-AMG W205 (C43, C63/C63 S) and BMW G20 M340i; he knows them well.

How to assess:
- Price what the photos show plus what that impact usually hides: bumper beams and crash cans, radiator support, condensers and coolers, headlight mounts, ADAS sensors and calibration, wheel and suspension parts behind wheel hits, and SRS parts (airbags, module, pretensioners) if anything deployed.
- repair_low assumes minimal hidden damage. repair_high assumes the hidden damage this kind of impact usually carries. Do not add a contingency multiplier; the buyer's math adds one.
- The lot's "Repair cost estimate (rc)" is an insurer/retail figure. Use it only as a severity signal.
- "Run and Drive" only means the car moved at check-in.
- If an area isn't visible (undercarriage, engine bay, interior, the other side), list it in unseen_areas and widen the range rather than assuming it's fine.
- flip_confidence (integer 0-100): how likely he can repair it within repair_high and resell at a normal price for this title type with no structural, flood, or electrical surprise.
- keep_confidence (integer 0-100): how likely the repaired car is one he'd be glad to own long-term, considering structure, drivetrain, electrical integrity, and history risk.
- Be direct. Call out flood signs, rail or apron damage, deployed airbags, mismatched or previously repaired panels, and odometer or title concerns.
- Do not compute bids, fees, or profit.`;

async function toBase64(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return btoa(bin);
}

// Downscale to the model's useful resolution before upload.
export async function prepImage(blob, maxEdge = 1568) {
  const bmp = await createImageBitmap(blob);
  const scale = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * scale);
  const h = Math.round(bmp.height * scale);
  const canvas = new OffscreenCanvas(w, h);
  canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
  return { data: await toBase64(out), w, h };
}

export function buildRequest({ model, summary, photos }) {
  const content = [{ type: 'text', text: `Lot data:\n${summary}` }];
  photos.forEach((p, i) => {
    content.push({ type: 'text', text: `Photo ${i + 1}${p.video ? ' (engine video still)' : ''}` });
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: p.data } });
  });
  content.push({ type: 'text', text: 'Assess this lot.' });
  return {
    model,
    max_tokens: 16000, // headroom for thinking on models where it's on by default
    system: SYSTEM_PROMPT,
    output_config: { format: { type: 'json_schema', schema: ASSESS_SCHEMA } },
    messages: [{ role: 'user', content }],
  };
}

export function parseResponse(status, body) {
  if (status !== 200) {
    const msg = (body?.error?.message || `HTTP ${status}`).replace(/\.+$/, '');
    if (status === 401) throw new Error('Claude API key was rejected. Check it in Settings.');
    if (status === 404 || body?.error?.type === 'not_found_error') throw new Error(`${msg}. Check the model name in Settings.`);
    throw new Error(`Claude API (${status}): ${msg}.`);
  }
  if (body?.stop_reason === 'refusal') throw new Error('Claude declined to assess this lot.');
  if (body?.stop_reason === 'max_tokens') throw new Error('Claude ran out of output tokens before finishing. Try again, or use a model with less thinking.');
  const text = (body?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  let a;
  try {
    a = JSON.parse(text);
  } catch {
    throw new Error('Claude returned an assessment that is not valid JSON.');
  }
  a.flip_confidence = Math.max(0, Math.min(100, Math.round(a.flip_confidence)));
  a.keep_confidence = Math.max(0, Math.min(100, Math.round(a.keep_confidence)));
  if (a.repair_high < a.repair_low) [a.repair_low, a.repair_high] = [a.repair_high, a.repair_low];
  return a;
}

export async function analyzeLot(job, { fetchImpl, onProgress = () => {}, maxPhotos = 20 }) {
  const { images, apiKey, model, summary } = job;
  if (!apiKey) throw new Error('Add your Claude API key in Settings first.');
  const subset = images.slice(0, maxPhotos);

  let done = 0;
  const photos = await mapLimit(subset, 4, async (img) => {
    const r = await resolveImage(img, 'hrs', fetchImpl);
    const res = await fetchImpl(r.url);
    if (!res.ok) throw new Error(`Photo fetch failed: HTTP ${res.status}`);
    const p = await prepImage(await res.blob());
    onProgress(++done, subset.length, 'photos');
    return { ...p, video: img.video };
  });

  onProgress(subset.length, subset.length, 'model');
  const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(buildRequest({ model, summary, photos })),
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON error */
  }
  const assessment = parseResponse(res.status, body);
  return { ...assessment, model, photosSent: photos.length, analyzedAt: new Date().toISOString(), usage: body?.usage || null };
}

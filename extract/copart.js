// Injected into a copart.com/lot/* tab (isolated world). Defines
// globalThis.__lotGrabber.extract(), which resolves to a normalized lot object.
//
// Data sources, in priority order:
//   1. appInit.cachedSolrLotDetailsStr  - inline JSON from the initial page load.
//      Only trusted if its lot number matches the URL (Angular SPA navigation
//      leaves the old cache in place).
//   2. /public/data/lotdetails/solr/<lot> - same-origin API, page cookies.
//   3. Visible DOM (.lot-details-information rows) - always read; it is also
//      the only source of the *live* current bid (the cache goes stale).
// Images: DOM gallery thumbnails + lotImages API, deduped by Copart's 32-hex id.

(() => {
  if (globalThis.__lotGrabber) return;

  const IMG_RE = /https?:\\?\/\\?\/cs\.copart\.com[^"'\s<>)]*?([0-9a-f]{32})_(v?)(thb|ful|hrs)\.(?:jpe?g|png|webp)/gi;

  const clean = (s) => (s == null ? '' : String(s).replace(/\s+/g, ' ').trim());

  const lotFromUrl = () => (location.pathname.match(/\/lot\/(\d+)/) || [])[1] || null;

  function withTimeout(ms) {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), ms);
    return { signal: c.signal, done: () => clearTimeout(t) };
  }

  async function getJson(path) {
    const t = withTimeout(8000);
    try {
      const r = await fetch(path, {
        credentials: 'include',
        headers: { accept: 'application/json, text/plain, */*' },
        signal: t.signal,
      });
      if (!r.ok) return null;
      const text = await r.text();
      if (!text || text.trimStart()[0] === '<') return null; // bot wall / HTML error page
      return JSON.parse(text);
    } catch {
      return null;
    } finally {
      t.done();
    }
  }

  // Depth-first search for the object that describes this lot (has ln === lot).
  function findLotObject(node, lot, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 8) return null;
    if (!Array.isArray(node) && String(node.ln ?? node.lotNumberStr ?? '') === String(lot) && (node.mkn || node.ld)) {
      return node;
    }
    for (const v of Object.values(node)) {
      const hit = findLotObject(v, lot, depth + 1);
      if (hit) return hit;
    }
    return null;
  }

  // ---- source 1: inline cache --------------------------------------------
  function fromInlineCache(lot) {
    for (const s of document.scripts) {
      const text = s.textContent;
      if (!text || !text.includes('cachedSolrLotDetailsStr')) continue;
      const m = text.match(/cachedSolrLotDetailsStr\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (!m) continue;
      try {
        const jsonStr = JSON.parse('"' + m[1].replace(/\\'/g, "'") + '"');
        const obj = JSON.parse(jsonStr);
        if (String(obj.ln ?? obj.lotNumberStr) === String(lot)) return obj;
      } catch {
        /* fall through */
      }
    }
    return null;
  }

  // ---- source 2: API ---------------------------------------------------------
  async function fromApi(lot) {
    const data = await getJson(`/public/data/lotdetails/solr/${lot}`);
    return data ? findLotObject(data, lot) : null;
  }

  // ---- source 3: DOM ---------------------------------------------------------
  function fromDom() {
    const rows = {};
    for (const row of document.querySelectorAll('.lot-details-information')) {
      const label = clean(row.querySelector('.lot-details-information-label')?.textContent).replace(/:$/, '');
      const valEl = row.querySelector('.lot-details-information-value');
      let value = clean(valEl ? valEl.textContent : row.textContent.replace(label, ''));
      value = value.replace(/\s*Listen to engine$/i, '');
      if (label && value) rows[label] = value;
    }

    // Header block: "VIN:", "Lot number:", "Sale name:", "Location:", "Sublot location:" etc.
    const header = {};
    for (const lab of document.querySelectorAll('span.p-f-w-500, .p-f-w-500')) {
      const key = clean(lab.textContent).replace(/:$/, '');
      if (!key || key.length > 30 || header[key]) continue;
      let sib = lab.nextElementSibling;
      while (sib && !clean(sib.textContent)) sib = sib.nextElementSibling;
      const value = clean(sib?.textContent);
      if (value && value.length < 200) header[key] = value;
    }

    const highlights = [...document.querySelectorAll('.lot-highlight-item')].map((b) => clean(b.textContent)).filter(Boolean);

    const bidEl =
      document.querySelector('.bidding-heading .currencyAmount') ||
      document.querySelector('.amount .currencyAmount') ||
      document.querySelector('.currencyAmount');
    const currentBid = bidEl ? Number(clean(bidEl.textContent).replace(/[^0-9.]/g, '')) : null;
    const saleStatus = clean(document.querySelector('#saleStatusTooltip')?.textContent) || null;

    let buyNow = null;
    const bn = [...document.querySelectorAll('button, a, span, div')].find((el) =>
      /^buy it now/i.test(clean(el.childElementCount < 4 ? el.textContent : ''))
    );
    if (bn) {
      const m = clean(bn.textContent).match(/\$[\d,]+(\.\d+)?/);
      if (m) buyNow = Number(m[0].replace(/[^0-9.]/g, ''));
    }

    return { rows, header, highlights, currentBid: Number.isFinite(currentBid) ? currentBid : null, saleStatus, buyNow };
  }

  // ---- images ----------------------------------------------------------------
  function harvestImageRefs(text, into, source) {
    IMG_RE.lastIndex = 0;
    let m;
    while ((m = IMG_RE.exec(text))) {
      const url = m[0].replace(/\\\//g, '/');
      const id = m[1].toLowerCase();
      const prefix = url.slice(0, url.toLowerCase().lastIndexOf(id));
      const isVideo = m[2] === 'v';
      if (!into.has(id)) into.set(id, { id, prefixes: [], video: isVideo, order: into.size, sources: [] });
      const rec = into.get(id);
      if (!rec.prefixes.includes(prefix)) rec.prefixes.push(prefix);
      if (!rec.sources.includes(source)) rec.sources.push(source);
      rec.video = rec.video || isVideo;
    }
  }

  async function collectImages(lot, solr) {
    const found = new Map();

    // Gallery thumbnails first: they define the order Copart shows.
    const galleryAttrs = [];
    document
      .querySelectorAll('.p-galleria-img-thumbnail, .thumb-container img, #zoomImgElement, img[src*="cs.copart.com"], [data-src*="cs.copart.com"], [style*="cs.copart.com"]')
      .forEach((el) => {
        for (const a of el.attributes) if (a.value.includes('cs.copart.com')) galleryAttrs.push(a.value);
      });
    // zoom image is a dupe of thumb #1; harvesting thumbs first keeps gallery order
    harvestImageRefs(galleryAttrs.join('\n'), found, 'dom');

    // API: catches lots where the gallery is lazily rendered or capped.
    for (const country of ['USA', 'CAN']) {
      const data = await getJson(`/public/data/lotdetails/solr/lotImages/${lot}/${country}`);
      if (data) {
        harvestImageRefs(JSON.stringify(data), found, 'api');
        break;
      }
    }

    // Last resort: anything in the raw HTML (JSON-LD, inline cache thumb).
    if (found.size === 0) harvestImageRefs(document.documentElement.innerHTML, found, 'html');
    if (solr?.tims) harvestImageRefs(solr.tims, found, 'cache');

    return [...found.values()]
      .sort((a, b) => a.order - b.order)
      .map((r) => {
        // Prefer the newer ids-c-prod-lpp path when both exist.
        const prefixes = [...r.prefixes].sort((a, b) => Number(b.includes('ids-c-prod')) - Number(a.includes('ids-c-prod')));
        const thumb = prefixes[0] + r.id + (r.video ? '_vthb.jpg' : '_thb.jpg');
        return { id: r.id, prefixes, video: r.video, thumb, sources: r.sources };
      });
  }

  // ---- normalize ---------------------------------------------------------------
  const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
  const nonZero = (v) => (num(v) ? num(v) : null);
  const titleCase = (s) =>
    clean(s)
      .toLowerCase()
      .replace(/\b([a-z])/g, (c) => c.toUpperCase());
  const yn = (v) => (v === 'Y' || v === 'YES' || v === true ? true : v === 'N' || v === 'NO' || v === false ? false : null);

  function normalize({ lot, solr, dom }) {
    const s = solr || {};
    const r = dom.rows;
    const h = dom.header;

    const vinDom = (h['VIN'] || '').match(/[A-HJ-NPR-Z0-9*]{17}/)?.[0];
    const vin = vinDom && !vinDom.includes('*') ? vinDom : s.fv || vinDom || null;

    const odo = num(s.orr) ?? num((r['Odometer'] || '').replace(/[^0-9]/g, ''));
    const odoStatus = clean(s.ord) || clean((r['Odometer'] || '').replace(/^[\d,]+\s*(mi|km)?\s*/i, '')) || null;

    const saleMs = num(s.ad);
    const pageTitle = clean(document.querySelector('h1.ldp-header-title, h1')?.textContent);
    const tMatch = pageTitle.match(/^(\d{4})\s+(\S+)\s+(.+)$/); // DOM-only fallback: "2023 BMW M340XI"

    return {
      source: 'copart',
      lot,
      url: location.href.split('?')[0],
      grabbedAt: new Date().toISOString(),
      year: num(s.lcy) ?? num(tMatch?.[1]),
      make: clean(s.mkn) || tMatch?.[2] || null,
      model: clean(s.lm) || tMatch?.[3] || null,
      modelGroup: clean(s.lmg) || null,
      title: clean(s.ld) || pageTitle || null,
      vin,
      vinMasked: !!(vin && vin.includes('*')),
      odometer: odo,
      odometerUnit: s.odometerUOM === 'K' ? 'km' : 'mi',
      odometerStatus: odoStatus,
      titleState: clean(s.ts) || null,
      titleDesc: clean(s.td) || r['Title code'] || null,
      titleGroup: clean(s.tgd) || null,
      primaryDamage: titleCase(s.dd) || r['Primary damage'] || null,
      secondaryDamage: titleCase(s.sdd) || r['Secondary damage'] || null,
      condition: clean(s.lcd) || dom.highlights[0] || r['Highlights'] || null,
      engineStarts: yn(s.hegn),
      transmissionEngages: yn(s.htsmn),
      hasKeys: yn(s.hk) ?? yn((r['Has key'] || '').toUpperCase()),
      highlights: dom.highlights.length ? dom.highlights : r['Highlights'] ? [r['Highlights']] : [],
      engine: clean(s.egn) || r['Engine type'] || null,
      cylinders: num(s.cy) ?? num(r['Cylinders']),
      transmission: clean(s.tsmn) || r['Transmission'] || null,
      drive: clean(s.drv) || r['Drivetrain'] || null,
      fuel: clean(s.ft) || r['Fuel'] || null,
      body: clean(s.bstl) || r['Body style'] || null,
      color: clean(s.clr) || r['Color'] || null,
      seller: clean(s.snm) || r['Seller'] || null,
      erv: num(s.la) ?? num((r['Estimated retail value'] || '').replace(/[^0-9.]/g, '')),
      acv: nonZero(s.lotPlugAcv),
      repairCost: nonZero(s.rc),
      currentBid: dom.currentBid ?? nonZero(s.hb) ?? nonZero(s.dynamicLotDetails?.currentBid),
      buyNow: dom.buyNow ?? nonZero(s.bnp),
      saleType: clean(s.ess) || dom.saleStatus || null,
      saleDate: saleMs ? new Date(saleMs).toISOString() : null,
      saleDateText: r['Sale date'] || null,
      saleTz: clean(s.ianaTimeZone) || null,
      yard: clean(s.yn) || h['Location'] || null,
      locCity: titleCase(s.locCity) || null,
      locState: clean(s.locState) || null,
      zip: clean(s.zip).split(' ')[0] || null,
      lat: num(s.lat),
      lon: num(s.long),
      sublot: h['Sublot location'] || [clean(s.sla), clean(s.slc), clean(s.sls), clean(s.slpc)].filter(Boolean).join(', ') || null,
      notes: r['Notes'] || clean(s.ltnte) || null,
      features: Array.isArray(s.lfd) ? s.lfd : [],
      rowsFromPage: r,
    };
  }

  async function extract() {
    const lot = lotFromUrl();
    if (!lot) throw new Error('Not a Copart lot page (expected /lot/<number>).');

    const sources = [];
    let solr = fromInlineCache(lot);
    if (solr) sources.push('inline-cache');
    else {
      solr = await fromApi(lot);
      if (solr) sources.push('api');
    }
    const dom = fromDom();
    if (Object.keys(dom.rows).length) sources.push('dom');
    if (!solr && !Object.keys(dom.rows).length) {
      throw new Error('Lot details not rendered yet. Wait for the page to finish loading and try again.');
    }

    const images = await collectImages(lot, solr);
    const lotData = normalize({ lot, solr, dom });
    return { lot: lotData, images, sources, raw: solr };
  }

  globalThis.__lotGrabber = { extract };
})();

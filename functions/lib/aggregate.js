// functions/lib/aggregate.js
import { sources } from './sources.js';
import httpGet from './http_get.js';
import * as cheerio from 'cheerio';

/* ---------- helpers ---------- */

// JPEG для Sears по PN (Scene7/Adobe)
function searsImageFromPN(
  pn,
  { wid = 285, hei = 200, qlt = 90, sharpen = 2 } = {}
) {
  pn = String(pn || '').trim();
  if (!pn) return '';
  return `https://s.sears.com/is/image/Sears/PD_0022_628_${pn}?wid=${wid}&hei=${hei}&fmt=pjpg&qlt=${qlt}&op_sharpen=${sharpen}`;
}

// Иллюстрация Sears по PN (когда основного фото нет)
function searsIllustrationFromPN(
  pn,
  { wid = 285, hei = 200, qlt = 90, sharpen = 2 } = {}
) {
  pn = String(pn || '').trim();
  if (!pn) return '';
  return `https://s.sears.com/is/image/Sears/PD_0022_628_${pn}_Illustration?wid=${wid}&hei=${hei}&fmt=pjpg&qlt=${qlt}&op_sharpen=${sharpen}`;
}

// Если og:image у Sears без параметров — добавим тип/размер
function normalizeSearsImage(u) {
  try {
    const url = new URL(u);
    if (url.hostname !== 's.sears.com') return u;
    const hasSize =
      url.searchParams.has('wid') ||
      url.searchParams.has('w') ||
      url.searchParams.has('hei') ||
      url.searchParams.has('h') ||
      url.searchParams.has('fmt');
    if (!hasSize) {
      url.searchParams.set('wid', '285');
      url.searchParams.set('hei', '200');
      url.searchParams.set('fmt', 'pjpg');
      url.searchParams.set('qlt', '90');
      url.searchParams.set('op_sharpen', '2');
      return url.toString();
    }
    return u;
  } catch {
    return u;
  }
}

// Нормализация картинок RepairClinic (относительные → абсолютные)
function normalizeRCImage(u) {
  try { return new URL(u, 'https://www.repairclinic.com').toString(); }
  catch { return u; }
}

// Прокси изображений через свой домен
function proxyImage(u) {
  if (!u) return '';
  if (u.startsWith('/api/img?u=')) return u; // уже проксировано
  let host = '';
  try { host = new URL(u).hostname; } catch { return u; }
  const ALLOW = new Set([
    's.sears.com',
    'www.repairclinic.com',
    'rcappliancepartsimages.com',
    // иногда у Sears попадаются запасные CDN-хосты:
    'images.searspartsdirect.com',
    'c.shld.net'
  ]);
  if (!ALLOW.has(host)) return u;
  return `/api/img?u=${encodeURIComponent(u)}`;
}

// «Наша» PN-картинка (чтобы понять, что нужно перепроверить на PDP/HEAD)
const BUILT_SEARS_PN_IMG = /https?:\/\/s\.sears\.com\/is\/image\/Sears\/PD_0022_628_\d+\b/i;

// Универсальный поиск картинки в HTML: og:image -> img/source -> Sears PN в тексте
function findAnyImageFromHtml(html, baseHost) {
  const $ = cheerio.load(html);
  let found = $('meta[property="og:image"],meta[name="og:image"]').attr('content') || '';

  if (!found) {
    $('img,source').each((_, el) => {
      if (found) return;
      const cand = el.attribs?.srcset || el.attribs?.['data-srcset'] ||
                   el.attribs?.src    || el.attribs?.['data-src']    || '';
      const m = String(cand).match(/https?:\/\/[^?\s,]+/);
      if (m) found = m[0];
    });
  }

  // последний шанс: PN Sears в теле HTML
  if (!found) {
    const m = String(html).match(/https?:\/\/s\.sears\.com\/is\/image\/Sears\/PD_0022_628_(\d{7,})/i);
    if (m && m[1]) {
      found = searsImageFromPN(m[1]);
    }
  }

  if (!found) return '';
  try { return new URL(found, `https://${baseHost}`).toString(); }
  catch { return found; }
}

// Из «Previous part numbers» берём только номера из соответствующего блока
function extractPrevPartNumbersFromSears(html) {
  const out = new Set();
  const idx = html.indexOf('Previous part numbers');
  if (idx < 0) return [];
  // берём «окно» после заголовка (достаточно 3–6 KB)
  const slice = html.slice(idx, idx + 6000);
  const rx = /Part\s*#\s*(\d{7,})/ig;
  let m;
  while ((m = rx.exec(slice))) {
    out.add(m[1]);
  }
  return Array.from(out);
}

/* ---------- main ---------- */

export async function aggregate(q) {
  const started = Date.now();
  const results = await Promise.allSettled(sources.map((s) => fetchAndParse(s, q)));

  const items = [];
  const meta = { took_ms: Date.now() - started, sources: [] };

  for (let i = 0; i < results.length; i++) {
    const name = sources[i].name;
    const r = results[i];
    if (r.status === 'fulfilled') {
      const arr = Array.isArray(r.value) ? r.value : [];
      meta.sources.push({ name, ok: true, count: arr.length });
      for (const x of arr) {
        items.push({
          supplier: name,
          name: x.title || x.name || '',
          url: x.link || x.url || '',
          image: x.image || '',
          price: x.price || '',
          currency: x.currency || '',
          part_number: x.part_number || '',
          availability: x.availability || '',
          oem_flag: x.oem_flag || false,
          _prevPNs: [] // заполним позже при PDP-догрузке (для Sears)
        });
      }
    } else {
      meta.sources.push({ name, ok: false, error: String(r.reason?.message || r.reason) });
      console.warn('[aggregate] failed for', name, r.reason?.message || r.reason);
    }
  }

  // де-дуп по URL
  const seen = new Set();
  const clean = items.filter((it) => {
    if (!it.url) return false;
    if (seen.has(it.url)) return false;
    seen.add(it.url);
    return true;
  });

  /* ---------- постобработка изображений ---------- */

  // 1) Sears: если нет картинки ИЛИ она «словесная» — строим по PN
  const BAD_SEARS_IMG = /PD_0022_628_(KENMORE|CROSLEY|MICROWAVE|WHITE-WESTINGHOUSE|LATCH)\b/i;
  for (const it of clean) {
    if (it.supplier !== 'SearsPartsDirect') continue;
    const pnMatch = String(it.part_number || '').match(/\d{7,}/);
    const pn = pnMatch ? pnMatch[0] : '';
    const missing = !it.image;
    const bad = it.image && BAD_SEARS_IMG.test(it.image);
    if (pn && (missing || bad)) {
      it.image = searsImageFromPN(pn);
    }
  }

  // 2) Догруз с PDP для Sears и RepairClinic
  const toFetchPDP = [];
  for (const it of clean) {
    if (!it.url) continue;
    const isSears = it.supplier === 'SearsPartsDirect';
    const isRC    = it.supplier === 'RepairClinic';
    if (isSears && (!it.image || BUILT_SEARS_PN_IMG.test(String(it.image)))) {
      toFetchPDP.push(it);
    }
    if (isRC && !it.image) {
      toFetchPDP.push(it);
    }
    if (toFetchPDP.length >= 16) break; // лимит на PDP-запросы
  }

  await Promise.allSettled(
    toFetchPDP.map(async (it) => {
      try {
        const html = await httpGet(it.url, {
          Referer: it.url.split('/').slice(0, 3).join('/') + '/',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9'
        });

        const host = new URL(it.url).hostname;

        // картинка с PDP: используем ТОЛЬКО если у нас её ещё нет
        if (!it.image) {
          let img = findAnyImageFromHtml(html, host);
          if (img) {
            if (host.includes('searspartsdirect.com')) img = normalizeSearsImage(img);
            if (host.includes('repairclinic.com'))      img = normalizeRCImage(img);
            it.image = img;
          }
        }

        // «Previous part numbers» — только для Sears
        if (host.includes('searspartsdirect.com')) {
          const prev = extractPrevPartNumbersFromSears(html);
          if (prev.length) it._prevPNs = prev;
        }
      } catch {
        // пропускаем
      }
    })
  );

  // 2c) Sears: если картинка «по PN», но на CDN ее нет — переключаемся на _Illustration
  async function checkSearsAndMaybeIllustration(it) {
    const pn = (String(it.part_number || '').match(/\d{7,}/) || [])[0] || '';
    if (!pn) return;
    if (!BUILT_SEARS_PN_IMG.test(String(it.image || ''))) return;
    try {
      const testUrl = searsImageFromPN(pn, { wid: 285, hei: 200, qlt: 90, sharpen: 2 });
      const resp = await fetch(testUrl, { method: 'HEAD' });
      if (!resp.ok) {
        it.image = searsIllustrationFromPN(pn, { wid: 285, hei: 200, qlt: 90, sharpen: 2 });
      }
    } catch {
      it.image = searsIllustrationFromPN(pn, { wid: 285, hei: 200, qlt: 90, sharpen: 2 });
    }
  }
  {
    const candidates = [];
    for (const it of clean) {
      if (it.supplier === 'SearsPartsDirect' && BUILT_SEARS_PN_IMG.test(String(it.image || ''))) {
        candidates.push(it);
        if (candidates.length >= 16) break;
      }
    }
    await Promise.allSettled(candidates.map(checkSearsAndMaybeIllustration));
  }

  // 3) Добавим в name: "Part #…" + "Previous part numbers: …"
  for (const it of clean) {
    const pn = (String(it.part_number || '').match(/\d{7,}/) || [])[0] || '';
    const baseTitle = String(it.name || '').replace(/\s+Part\s*#\d{7,}.*/i, '').trim();
    let suffix = '';
    if (pn) suffix += ` Part #${pn}`;
    if (it._prevPNs && it._prevPNs.length) {
      const list = it._prevPNs.slice(0, 6).map(x => `#${x}`).join(', ');
      suffix += ` — Previous part numbers: ${list}`;
    }
    it.name = (baseTitle + (suffix ? ` ${suffix}` : '')).trim();
    delete it._prevPNs;
  }

  // 4) Проксируем Sears/RC картинки через /api/img
  for (const it of clean) {
    if (it.image) it.image = proxyImage(it.image);
  }

  return { items: clean, meta };
}

/* ---------- utils ---------- */

async function fetchAndParse(src, q) {
  const url = src.searchUrl(q);
  const html = await httpGet(url, { Referer: url.split('/').slice(0, 3).join('/') + '/' });
  return await src.parser(html, q);
}
